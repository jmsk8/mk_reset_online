"""Decorateurs d'authentification et d'autorisation.

Deux mecanismes cohabitent pendant la bascule : `admin_required` (mot de passe
partage, voue a disparaitre) et `role_required` (session Discord).

`admin_or_role_required` accepte les deux et loggue laquelle a servi. C'est le
SEUL point ou la double lecture est autorisee : deux decorateurs empiles se
comportent comme un ET alors qu'on veut un OU.

Deux facons d'autoriser, a ne pas confondre (docs/hierarchie-admin-plan.md 2) :

  - CAPACITE DE ROLE -- cablee en dur via `role_required`, jamais delegable.
    Les jetons de bot, le reset global, la designation d'un chef_admin, le legs
    du superadmin. Ce n'est pas une case decochee quelque part : c'est un
    pouvoir qui n'existe pas dans le systeme de permissions.
  - PERMISSION DELEGABLE -- une entree de PERMISSIONS_CATALOGUE, verifiee via
    `permission_required`, qu'un chef_admin ou le superadmin accorde a un admin.

Distinction 401/403/503 (R-28) : le frontend purge la session sur 401/403, une
indisponibilite de la base ne doit donc jamais produire ces codes. C'est la
raison d'etre de `_DbIndisponible` plus bas.
"""

from __future__ import annotations

import functools
import hashlib
import logging
from datetime import datetime, timezone

from flask import request, jsonify, g

from constants import (ROLE_HIERARCHY, ROLE_PLAYER, ROLE_ADMIN, ROLE_CHEF_ADMIN,
                       ROLE_SUPERADMIN, PERMISSIONS_CATALOGUE, SOUS_PERMISSIONS)
from db import get_db_connection

logger = logging.getLogger(__name__)

SESSION_HEADER = 'X-Session-Token'


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def _erreur(message: str, status: int, code: str):
    return jsonify({"error": message, "code": code}), status


def admin_required(f):
    """[OBSOLETE] Auth par mot de passe partage. Retire a la fin de la bascule."""
    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        token = request.headers.get('X-Admin-Token', None)
        if not token:
            return _erreur("Authentification requise", 401, 'auth_requise')
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT expires_at FROM api_tokens WHERE token = %s", (token,))
                    res = cur.fetchone()
                    if not res:
                        return _erreur("Session invalide", 403, 'session_invalide')
                    if datetime.now() > res[0]:
                        cur.execute("DELETE FROM api_tokens WHERE token = %s", (token,))
                        conn.commit()
                        return _erreur("Session expiree", 403, 'session_expiree')
        except Exception as e:
            # 503 et pas 500/403 : une base indisponible n'est pas une session
            # invalide, et le frontend ne doit pas deconnecter pour autant.
            logger.error("Verification du token admin impossible: %s", e)
            return _erreur("Service indisponible", 503, 'indisponible')
        return f(*args, **kwargs)
    return decorated_function


def _charger_compte_session():
    """Resout le token de session en compte. Renvoie (compte, reponse d'erreur).

    Le role est TOUJOURS relu en base : retirer un role doit prendre effet
    immediatement, pas au bout de 30 jours.

    NE JAMAIS mettre ce role (ni les permissions) en cache dans la session pour
    epargner une requete : un droit retire resterait actif jusqu'a l'expiration
    de la session, ce qui viderait de leur sens l'intouchabilite du superadmin
    et le plafond de delegation. La relecture a chaque requete EST la garantie.
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
                    return None, _erreur("Session expiree", 401, 'session_expiree')

                if row[6] == 'suspended':
                    return None, _erreur("Compte suspendu", 403, 'compte_suspendu')

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


def role_required(role_minimum: str):
    """Exige une session ET un role au moins egal a `role_minimum`.

    Les roles sont ordonnes : un superadmin satisfait une exigence d'admin. Seule
    frontiere de privilege de l'application.
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

    Existe pour que _a_permission puisse distinguer « pas la permission » de
    « je n'ai pas pu savoir ». Sans ca, un hoquet DB se traduirait en 403, le
    frontend purgerait la session (R-28) et ejecterait un admin qui avait
    pourtant le droit.
    """


def _a_permission(compte_id: int, permission: str) -> bool:
    """Vrai si ce compte porte cette permission nommee.

    Leve _DbIndisponible plutot que de renvoyer False sur une panne : « ferme
    par defaut » serait ici le mauvais reflexe, il produirait un 403 (R-55).
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

    chef_admin et superadmin passent TOUJOURS : leur socle EST le catalogue
    delegable en entier, par construction. Les jetons de bot n'y figurent
    jamais -- capacite de role, verifiee par role_required(superadmin) direct.

    Jamais construit sur admin_or_role_required : ce decorateur n'accepte que
    l'auth Discord, jamais l'ancien mot de passe partage. Une route convertie
    perd donc ce chemin d'auth immediatement, et c'est voulu (R-54).
    """
    if permission not in PERMISSIONS_CATALOGUE:
        # Faute de frappe sur un litteral ecrit par un dev, pas une entree
        # utilisateur. Un raise plutot qu'un assert : assert disparait sous -O.
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

            # Une sous-permission ne vaut rien sans son parent : l'interface la
            # presente en retrait et la decoche avec lui, mais c'est ICI que la
            # regle tient. Sans ca, un octroi direct par l'API donnerait un droit
            # que l'interface presente comme impossible.
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
    """Le compte deja authentifie porte-t-il cette permission ? Pour une
    verification SECONDAIRE a l'interieur d'une route.

    Renvoie (accordee: bool, reponse d'erreur | None) -- la reponse est un 503
    si la base n'a pas repondu, jamais un False silencieux (meme raison qu'en
    R-55 : « je n'ai pas pu savoir » n'est pas « pas le droit »).

    Existe parce que deux routes melangent deux domaines de permission dans un
    seul point d'entree, et qu'un decorateur ne peut pas trancher a leur place :

      - update_config ecrit les reglages TrueSkill ET les clefs de mode ligue ;
      - add_tournament enregistre un tournoi ET cree la fiche d'un joueur
        inconnu au passage.

    chef_admin et superadmin passent toujours, comme dans permission_required :
    leur socle EST le catalogue.
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
    """Ce qu'un compte peut accorder a un admin. Meme fonction pour les deux
    paliers qui delegent, pas de duplication.

    Aujourd'hui chef_admin et superadmin ont le meme plafond -- le catalogue
    entier, puisque le socle du chef_admin EST le catalogue. Reste un vrai
    calcul plutot qu'un court-circuit « si chef_admin ou superadmin : tout »,
    pour qu'une future permission reservee au superadmin seul n'oblige a
    changer qu'un seul endroit.
    """
    if ROLE_HIERARCHY.get(compte['role'], ROLE_HIERARCHY[ROLE_PLAYER]) >= ROLE_HIERARCHY[ROLE_CHEF_ADMIN]:
        return frozenset(PERMISSIONS_CATALOGUE)
    return frozenset()


def refuse_auto_modification(acteur_id: int, cible_id: int):
    """Refuse d'agir sur son propre compte. Renvoie une reponse d'erreur ou None.

    Posee a la main sur les trois routes concernees (changer_role, octroi de
    permission, legs du superadmin) plutot qu'en decorateur : elle ne s'applique
    pas partout, et un decorateur pose « au cas ou » finirait par bloquer une
    route legitime.
    """
    if acteur_id == cible_id:
        return _erreur("Action impossible sur son propre compte.", 403, 'auto_modification')
    return None


def compte_cible_protegee(f):
    """Interdit d'agir sur un compte plus protege que soi.

    Deux regles, memes consequences :
      - le superadmin est intouchable par quiconque d'autre que lui-meme ;
      - un chef_admin est intouchable par un autre chef_admin (seul le
        superadmin agit sur un chef_admin).

    Un decorateur plutot qu'une fonction appelee a la main dans chaque route :
    rien n'empeche un futur endpoint d'oublier un appel, alors qu'un decorateur
    manquant se voit d'un coup d'oeil et se cherche au grep (R-48).

    Porte UNIQUEMENT sur l'ecriture : voir la liste d'un compte reste permis,
    c'est agir dessus qui ne l'est pas.

    A poser SOUS role_required/permission_required dans l'empilement -- le
    decorateur le plus proche de @route s'execute en premier, et g.compte doit
    deja exister quand celui-ci tourne.
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
            # 503, pas 403 : meme raison que partout ailleurs dans ce fichier.
            logger.error("Verification de cible protegee impossible: %s", e)
            return _erreur("Service indisponible", 503, 'indisponible')

        if row is not None:
            role_cible = row[0]
            acteur_est_superadmin = acteur['role'] == ROLE_SUPERADMIN

            if role_cible == ROLE_SUPERADMIN:
                return _erreur(
                    "Ce compte est le super-administrateur : action impossible.",
                    403, 'cible_protegee',
                )
            if role_cible == ROLE_CHEF_ADMIN and not acteur_est_superadmin:
                return _erreur(
                    "Seul le super-administrateur peut agir sur un chef d'administration.",
                    403, 'cible_protegee',
                )

        return f(*args, **kwargs)
    return decorated_function


def admin_or_role_required(f):
    """[TRANSITOIRE] Accepte l'ancien token admin OU une session de role admin.

    Existe uniquement le temps de la periode de recouvrement, pour qu'aucune
    route ne se retrouve ni ouverte ni morte pendant la bascule. Disparait avec
    `admin_required`.
    """
    role_variante = role_required('admin')(f)
    admin_variante = admin_required(f)

    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        if request.headers.get(SESSION_HEADER):
            logger.info("auth: session Discord sur %s", request.path)
            return role_variante(*args, **kwargs)
        logger.info("auth: mot de passe (obsolete) sur %s", request.path)
        return admin_variante(*args, **kwargs)
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
                        # La recherche porte sur le sha256, jamais sur le secret :
                        # une egalite SQL suffit, il n'y a rien a deviner par
                        # mesure de temps a partir d'un hash. Meme motif que pour
                        # les sessions joueurs.
                        if row is None:
                            return _erreur("Jeton invalide", 401, 'jeton_invalide')

                        _id, nom, scopes, expires_at, revoked_at = row
                        if revoked_at is not None:
                            return _erreur("Jeton revoque", 401, 'jeton_revoque')
                        if expires_at is not None and expires_at <= datetime.now(timezone.utc):
                            return _erreur("Jeton expire", 401, 'jeton_expire')
                        if scope not in (scopes or []):
                            return _erreur("Portee insuffisante", 403, 'scope_insuffisant')

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
