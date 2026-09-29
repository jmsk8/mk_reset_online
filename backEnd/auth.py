"""Decorateurs d'authentification et d'autorisation.

L'authentification passe uniquement par la session Discord.

Deux facons d'autoriser :

  - capacite de role : cablee via `role_required`, jamais delegable (jetons de
    bot, reset global, designation d'un chef_admin, legs du superadmin) ;
  - permission delegable : une entree de PERMISSIONS_CATALOGUE, verifiee par
    `permission_required`, accordee a un admin par un chef_admin ou le
    superadmin.

Le frontend purge la session sur 401/403 : une base indisponible doit donc
repondre 503, jamais 401/403 (d'ou `_DbIndisponible`). Le consentement manquant
repond 428 pour la meme raison : la session reste valide.
"""

from __future__ import annotations

import functools
import hashlib
import logging
from datetime import datetime, timezone

from flask import request, jsonify, g

from constants import (ROLE_HIERARCHY, ROLE_PLAYER, ROLE_ADMIN, ROLE_CHEF_ADMIN,
                       ROLE_SUPERADMIN, PERMISSIONS_CATALOGUE, SOUS_PERMISSIONS,
                       CGU_VERSION)
from db import get_db_connection

logger = logging.getLogger(__name__)

SESSION_HEADER = 'X-Session-Token'


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def _erreur(message: str, status: int, code: str):
    return jsonify({"error": message, "code": code}), status


def _charger_compte_session(exiger_cgu: bool = True):
    """Resout le token de session en compte. Renvoie (compte, reponse d'erreur).

    Le role est relu en base a chaque requete, pour qu'un droit retire prenne
    effet immediatement. Ne pas le mettre en cache dans la session.

    `exiger_cgu` impose le consentement a la politique en version courante.
    Seul `player_required_sans_cgu` le leve.
    """
    token = request.headers.get(SESSION_HEADER, None)
    if not token:
        return None, _erreur("Authentification requise", 401, 'auth_requise')

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT c.id, c.discord_id, c.discord_username, c.discord_global_name,
                              c.discord_avatar_hash, c.joueur_id, c.statut, c.role, s.expires_at,
                              c.cgu_version
                       FROM sessions_joueurs s
                       JOIN comptes c ON c.id = s.compte_id
                       WHERE s.token_hash = %s""",
                    (_hash(token),),
                )
                row = cur.fetchone()
                if row is None:
                    return None, _erreur("Session invalide", 401, 'session_invalide')

                if row[8] <= datetime.now(timezone.utc):
                    cur.execute(
                        "DELETE FROM sessions_joueurs WHERE token_hash = %s", (_hash(token),)
                    )
                    conn.commit()
                    return None, _erreur("Session expirée", 401, 'session_expiree')

                if row[6] == 'suspended':
                    return None, _erreur("Compte suspendu", 403, 'compte_suspendu')

                # Apres la suspension (un compte suspendu doit l'apprendre),
                # avant last_seen_at (accepter seulement ne compte pas comme
                # une activite).
                if exiger_cgu and row[9] != CGU_VERSION:
                    return None, _erreur(
                        "Politique de confidentialité à accepter", 428, 'cgu_a_accepter')

                cur.execute(
                    "UPDATE sessions_joueurs SET last_seen_at = now() WHERE token_hash = %s",
                    (_hash(token),),
                )
                conn.commit()
    except Exception as e:
        logger.error("Verification de session impossible: %s", e)
        return None, _erreur("Service indisponible", 503, 'indisponible')

    return {
        'id': row[0], 'discord_id': row[1], 'discord_username': row[2],
        'discord_global_name': row[3], 'discord_avatar_hash': row[4],
        'joueur_id': row[5], 'statut': row[6], 'role': row[7],
        'cgu_version': row[9],
    }, None


def player_required(f):
    """Exige une session valide. Injecte le compte dans g.compte."""
    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        compte, erreur = _charger_compte_session()
        if erreur is not None:
            return erreur
        g.compte = compte
        return f(*args, **kwargs)
    return decorated_function


def player_required_sans_cgu(f):
    """Comme `player_required`, sans exiger le consentement.

    Reserve aux routes qui servent a accepter la politique ou a exercer un
    droit qui n'en depend pas : /auth/check-session, /me/cgu, /me/export,
    /avatar/moi. Liste figee par `test_cgu_imposee.py`.
    """
    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        compte, erreur = _charger_compte_session(exiger_cgu=False)
        if erreur is not None:
            return erreur
        g.compte = compte
        return f(*args, **kwargs)
    return decorated_function


def role_required(role_minimum: str):
    """Exige une session et un role au moins egal a `role_minimum`.

    Les roles sont ordonnes : un superadmin satisfait une exigence d'admin.
    """
    seuil = ROLE_HIERARCHY[role_minimum]

    def decorateur(f):
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            compte, erreur = _charger_compte_session()
            if erreur is not None:
                return erreur
            if ROLE_HIERARCHY.get(compte['role'], ROLE_HIERARCHY[ROLE_PLAYER]) < seuil:
                logger.warning(
                    "Acces refuse a %s (role %s) sur %s",
                    compte['id'], compte['role'], request.path,
                )
                return _erreur("Droits insuffisants", 403, 'droits_insuffisants')
            g.compte = compte
            return f(*args, **kwargs)
        return decorated_function
    return decorateur


class _DbIndisponible(Exception):
    """La base n'a pas repondu pendant une verification de droits.

    Distingue « pas la permission » (403) de « impossible de savoir » (503).
    """


def _a_permission(compte_id: int, permission: str) -> bool:
    """Vrai si ce compte porte cette permission nommee.

    Leve _DbIndisponible sur une panne plutot que de renvoyer False.
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM permissions_admin WHERE compte_id = %s AND permission = %s",
                    (compte_id, permission),
                )
                return cur.fetchone() is not None
    except Exception as e:
        logger.error("Verification de permission impossible: %s", e)
        raise _DbIndisponible from e


def permission_required(permission: str):
    """Exige une session, et soit un role >= chef_admin, soit la permission nommee.

    chef_admin et superadmin passent toujours : leur socle est le catalogue
    entier.
    """
    if permission not in PERMISSIONS_CATALOGUE:
        # raise plutot qu'assert, qui disparait sous -O.
        raise ValueError(f"Permission inconnue du catalogue : {permission!r}")

    seuil_chef = ROLE_HIERARCHY[ROLE_CHEF_ADMIN]

    def decorateur(f):
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            compte, erreur = _charger_compte_session()
            if erreur is not None:
                return erreur

            role = compte['role']
            if ROLE_HIERARCHY.get(role, ROLE_HIERARCHY[ROLE_PLAYER]) >= seuil_chef:
                g.compte = compte
                return f(*args, **kwargs)

            if role != ROLE_ADMIN:
                logger.warning(
                    "Permission '%s' refusee a %s (role %s) sur %s",
                    permission, compte['id'], role, request.path,
                )
                return _erreur("Droits insuffisants", 403, 'permission_manquante')

            # Une sous-permission ne vaut rien sans son parent.
            requises = [permission]
            parent = SOUS_PERMISSIONS.get(permission)
            if parent is not None:
                requises.append(parent)

            try:
                manquante = next(
                    (p for p in requises if not _a_permission(compte['id'], p)), None
                )
            except _DbIndisponible:
                return _erreur("Service indisponible", 503, 'indisponible')

            if manquante is not None:
                logger.warning(
                    "Permission '%s' refusee a %s (role %s) sur %s%s",
                    permission, compte['id'], role, request.path,
                    " (parent '%s' manquant)" % manquante if manquante != permission else "",
                )
                return _erreur("Droits insuffisants", 403, 'permission_manquante')

            g.compte = compte
            return f(*args, **kwargs)
        return decorated_function
    return decorateur


def compte_a_permission(compte: dict, permission: str):
    """Verification secondaire d'une permission, a l'interieur d'une route.

    Renvoie (accordee, reponse d'erreur | None) ; la reponse est un 503 si la
    base n'a pas repondu. Sert aux routes qui melangent deux permissions
    (update_config, add_tournament).
    """
    if permission not in PERMISSIONS_CATALOGUE:
        raise ValueError(f"Permission inconnue du catalogue : {permission!r}")

    if ROLE_HIERARCHY.get(compte['role'], ROLE_HIERARCHY[ROLE_PLAYER]) >= ROLE_HIERARCHY[ROLE_CHEF_ADMIN]:
        return True, None
    if compte['role'] != ROLE_ADMIN:
        return False, None

    # Meme regle que permission_required : une sous-permission exige son parent.
    requises = [permission]
    parent = SOUS_PERMISSIONS.get(permission)
    if parent is not None:
        requises.append(parent)

    try:
        return all(_a_permission(compte['id'], p) for p in requises), None
    except _DbIndisponible:
        return False, _erreur("Service indisponible", 503, 'indisponible')


def permissions_delegables_par(compte: dict) -> frozenset:
    """Ce qu'un compte peut accorder a un admin : le catalogue entier pour
    chef_admin et superadmin, rien pour les autres.
    """
    if ROLE_HIERARCHY.get(compte['role'], ROLE_HIERARCHY[ROLE_PLAYER]) >= ROLE_HIERARCHY[ROLE_CHEF_ADMIN]:
        return frozenset(PERMISSIONS_CATALOGUE)
    return frozenset()


def refuse_auto_modification(acteur_id: int, cible_id: int):
    """Refuse d'agir sur son propre compte. Renvoie une reponse d'erreur ou None.

    Appelee a la main par changer_role, l'octroi de permission et le legs.
    """
    if acteur_id == cible_id:
        return _erreur("Action impossible sur son propre compte.", 403, 'auto_modification')
    return None


def compte_cible_protegee(f):
    """Interdit d'agir sur un compte de rang egal ou superieur au sien.

        rang(acteur) >  rang(cible)  -> autorise
        rang(acteur) <= rang(cible)  -> 403 cible_protegee

    Agir sur son propre compte reste permis ; les routes ou cela n'a pas de
    sens appellent refuse_auto_modification.

    A poser sous role_required/permission_required : g.compte doit deja exister.
    """
    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        cible_id = kwargs.get('compte_id')
        acteur = g.compte

        if cible_id is None or cible_id == acteur['id']:
            return f(*args, **kwargs)

        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT role FROM comptes WHERE id = %s", (cible_id,))
                    row = cur.fetchone()
        except Exception as e:
            logger.error("Verification de cible protegee impossible: %s", e)
            return _erreur("Service indisponible", 503, 'indisponible')

        # Compte inexistant : la route repondra 404.
        if row is not None:
            refus = refus_de_rang(acteur, cible_id, row[0])
            if refus is not None:
                return refus

        return f(*args, **kwargs)
    return decorated_function


def _rangs(role_acteur: str, role_cible: str) -> tuple[int, int]:
    """(rang de l'acteur, rang de la cible).

    Un role inconnu vaut le rang le plus bas pour l'acteur et le plus haut pour
    la cible.
    """
    return (ROLE_HIERARCHY.get(role_acteur, ROLE_HIERARCHY[ROLE_PLAYER]),
            ROLE_HIERARCHY.get(role_cible, ROLE_HIERARCHY[ROLE_SUPERADMIN]))


def hors_de_portee(role_acteur: str, role_cible: str) -> bool:
    """Vrai si la regle de rang interdit a l'acteur d'agir sur cette cible.

    Sert a griser les boutons ; refus_de_rang reste la verification.
    """
    rang_acteur, rang_cible = _rangs(role_acteur, role_cible)
    return not rang_acteur > rang_cible


def refus_de_rang(acteur: dict, cible_id: int, role_cible: str, objet: str = 'compte'):
    """La regle de rang. Renvoie une reponse 403 ou None.

    Le cas « soi-meme » est ecarte par l'appelant. `objet` ne change que le
    message : « compte » ou « fiche ».
    """
    rang_acteur, rang_cible = _rangs(acteur['role'], role_cible)
    if rang_acteur > rang_cible:
        return None

    logger.warning(
        "Cible protegee : %s (role %s) refuse sur le compte %s (role %s, %s), %s",
        acteur['id'], acteur['role'], cible_id, role_cible, objet,
        request.path,
    )
    sujet = ("Cette fiche appartient à un compte qui" if objet == 'fiche'
             else "Ce compte")
    if role_cible == ROLE_SUPERADMIN:
        message = ("Cette fiche appartient au super-administrateur : action impossible."
                   if objet == 'fiche'
                   else "Ce compte est le super-administrateur : action impossible.")
    elif rang_acteur == rang_cible:
        message = ("%s a le même niveau de privilège que le vôtre : seul un compte "
                   "de rang supérieur peut agir dessus." % sujet)
    else:
        message = "%s est plus privilégié que le vôtre : action impossible." % sujet
    return _erreur(message, 403, 'cible_protegee')


def fiche_cible_protegee(f):
    """compte_cible_protegee, pour les routes qui visent une fiche joueur.

    La fiche prend le rang du compte qui lui est lie ; une fiche sans compte
    vaut une fiche de player, et sa propre fiche reste accessible.

    Lit l'identifiant dans le parametre d'URL `id`. A poser sous
    permission_required.
    """
    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        joueur_id = kwargs.get('id')
        acteur = g.compte
        if joueur_id is None:
            return f(*args, **kwargs)

        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT id, role FROM comptes WHERE joueur_id = %s",
                                (joueur_id,))
                    row = cur.fetchone()
        except Exception as e:
            logger.error("Verification de fiche protegee impossible: %s", e)
            return _erreur("Service indisponible", 503, 'indisponible')

        # Aucun compte lie, ou la sienne : rien a proteger.
        if row is not None and row[0] != acteur['id']:
            refus = refus_de_rang(acteur, row[0], row[1], objet='fiche')
            if refus is not None:
                return refus

        return f(*args, **kwargs)
    return decorated_function


def service_required(scope: str):
    """Authentification machine pour les bots. Lecture seule, portee restreinte."""
    def decorateur(f):
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            entete = request.headers.get('Authorization', '')
            if not entete.startswith('Bearer '):
                return _erreur("Authentification requise", 401, 'auth_requise')
            token_hash = _hash(entete[7:])

            try:
                with get_db_connection() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            """SELECT id, nom, scopes, expires_at, revoked_at
                               FROM service_tokens WHERE token_hash = %s""",
                            (token_hash,),
                        )
                        row = cur.fetchone()
                        if row is None:
                            return _erreur("Jeton invalide", 401, 'jeton_invalide')

                        _id, nom, scopes, expires_at, revoked_at = row
                        if revoked_at is not None:
                            return _erreur("Jeton révoqué", 401, 'jeton_revoque')
                        if expires_at is not None and expires_at <= datetime.now(timezone.utc):
                            return _erreur("Jeton expiré", 401, 'jeton_expire')
                        if scope not in (scopes or []):
                            return _erreur("Portée insuffisante", 403, 'scope_insuffisant')

                        cur.execute(
                            "UPDATE service_tokens SET last_used_at = now() WHERE id = %s",
                            (_id,),
                        )
                    conn.commit()
            except Exception as e:
                logger.error("Verification du jeton de service impossible: %s", e)
                return _erreur("Service indisponible", 503, 'indisponible')

            g.service_nom = nom
            return f(*args, **kwargs)
        return decorated_function
    return decorateur
