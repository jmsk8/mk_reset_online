"""Decorateurs d'authentification et d'autorisation.

Un seul mecanisme d'authentification depuis le 2026-09-23 : la session Discord,
via `role_required`. Les deux decorateurs du mot de passe partage ont ete
supprimes avec l'etape 6 de la phase 4, et `test_bascule.py` refuse desormais
leurs noms n'importe ou dans le backend -- y compris dans un commentaire, pour
que le filet reste une regle simple et non une liste d'exceptions.

Si le mot de passe devait revenir par un `git revert` (runbook-admin.md 3.2b),
il revient avec eux -- et avec la regle qui allait avec : ne JAMAIS empiler deux
decorateurs d'authentification, deux empiles se comportent comme un ET alors
qu'on veut un OU.

Deux facons d'autoriser, a ne pas confondre (docs/hierarchie-admin-plan.md 2) :

  - CAPACITE DE ROLE -- cablee en dur via `role_required`, jamais delegable.
    Les jetons de bot, le reset global, la designation d'un chef_admin, le legs
    du superadmin. Ce n'est pas une case decochee quelque part : c'est un
    pouvoir qui n'existe pas dans le systeme de permissions.
  - PERMISSION DELEGABLE -- une entree de PERMISSIONS_CATALOGUE, verifiee via
    `permission_required`, qu'un chef_admin ou le superadmin accorde a un admin.

Distinction 401/403/503 (R-28) : le frontend purge la session sur 401/403, une
indisponibilite de la base ne doit donc jamais produire ces codes. C'est la
raison d'etre de `_DbIndisponible` plus bas. Meme raison pour le consentement
manquant (A-07), qui repond 428 : la session est valide, il lui manque un
accord, et la purger renverrait la personne a Discord pour retomber sur le
meme ecran.
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

    Le role est TOUJOURS relu en base : retirer un role doit prendre effet
    immediatement, pas au bout de 30 jours.

    `exiger_cgu` impose le consentement a la politique en version courante
    (A-07, 2026-09-24). Tous les decorateurs passent par ici : un seul point
    d'application, et une route admin n'y echappe pas plus qu'une route joueur.
    Seul `player_required_sans_cgu` le leve, pour la courte liste des routes
    qui servent a accepter ou a exercer ses droits sans accepter.

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

                # Apres la suspension : un compte suspendu doit l'apprendre,
                # pas etre invite a accepter une politique qui ne lui ouvrira
                # rien. Et avant le last_seen_at : une session qui ne peut rien
                # faire d'autre qu'accepter n'est pas une session « active ».
                if exiger_cgu and row[9] != CGU_VERSION:
                    return None, _erreur(
                        "Politique de confidentialite a accepter", 428, 'cgu_a_accepter')

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
    """Comme `player_required`, sans exiger le consentement (A-07).

    LISTE BLANCHE, a garder courte : chaque route ici est accessible a une
    personne qui n'a pas accepte la politique en vigueur. N'y ont leur place
    que les routes qui servent a accepter, ou a exercer un droit qui ne peut
    pas dependre de l'acceptation :

      - /auth/check-session : la sonde du frontend, qui doit pouvoir dire
        « consentement manquant » au lieu de refuser la session ;
      - /me/cgu : l'acceptation elle-meme ;
      - /me/export : le droit d'acces (art. 15) ne se negocie pas contre un
        accord ;
      - /avatar/moi : la navbar de la page d'acceptation.

    `test_cgu_imposee.py` fige cette liste : en ajouter une doit etre un choix.
    La deconnexion n'y figure pas parce qu'elle ne demande aucune session
    valide (routes_auth.logout).
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

    N'accepte que l'auth Discord (R-54). C'etait deja vrai du temps ou le mot de
    passe partage existait : aucune permission n'a jamais ete accessible par ce
    chemin-la.
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
    """Interdit d'agir sur un compte de rang egal ou superieur au sien.

    UNE regle de rang, et rien d'autre (docs/hierarchie-admin-plan.md 8.1) :

        rang(acteur) >  rang(cible)  -> autorise
        rang(acteur) <= rang(cible)  -> 403 cible_protegee

    Consequences : un admin n'agit que sur un player ; un chef_admin sur un
    player et un admin, jamais sur un pair ; le superadmin sur tout le monde
    sauf un autre superadmin -- et il est seul a tout instant, donc en pratique
    sur tout le monde.

    ELLE REMPLACE deux `if` en dur (cible superadmin, cible chef_admin) qui ne
    disaient RIEN du cas admin -> admin : un simple admin porteur de
    gestion_comptes pouvait suspendre un pair admin et fermer ses sessions, sur
    les quatre routes /sync /sessions /delier /statut. Prouve par execution le
    2026-09-13, corrige le 2026-09-14 (test_audit_permissions.py, section 3).

    Le cas chef_admin contre chef_admin (R-52) n'est plus un cas particulier :
    il tombe de l'egalite des rangs. Ne pas le re-ajouter en dur.

    L'egalite refuse, y compris entre pairs : c'est le coeur de la regle. Agir
    sur SOI-MEME reste permis (teste plus haut, avant meme la lecture en base) --
    fermer ses propres sessions est legitime ; ce sont les routes qui doivent
    refuser l'auto-modification quand elle n'a pas de sens, via
    refuse_auto_modification.

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

        # row is None : compte inexistant. On laisse passer -- c'est a la route
        # de repondre 404, le decorateur n'a pas a trancher a sa place (et un
        # 403 ici revelerait l'inexistence par un code different).
        if row is not None:
            role_cible = row[0]
            # Defaut ferme des deux cotes : un role inconnu en base vaut le rang
            # le PLUS BAS pour l'acteur (il ne peut presque rien) et le plus
            # HAUT pour la cible (elle est presque intouchable). Une colonne
            # corrompue ne doit jamais ouvrir une porte.
            rang_acteur = ROLE_HIERARCHY.get(acteur['role'], ROLE_HIERARCHY[ROLE_PLAYER])
            rang_cible = ROLE_HIERARCHY.get(role_cible, ROLE_HIERARCHY[ROLE_SUPERADMIN])

            if rang_acteur <= rang_cible:
                logger.warning(
                    "Cible protegee : %s (role %s) refuse sur le compte %s (role %s), %s",
                    acteur['id'], acteur['role'], cible_id, role_cible, request.path,
                )
                # Le message nomme le rang de la cible : « action impossible »
                # sans dire pourquoi renvoie l'admin vers un support qui ne peut
                # pas deviner non plus.
                if role_cible == ROLE_SUPERADMIN:
                    message = "Ce compte est le super-administrateur : action impossible."
                elif rang_acteur == rang_cible:
                    message = ("Ce compte a le meme niveau de privilege que le votre : "
                               "seul un compte de rang superieur peut agir dessus.")
                else:
                    message = ("Ce compte est plus privilegie que le votre : "
                               "action impossible.")
                return _erreur(message, 403, 'cible_protegee')

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
