"""Decorateurs d'authentification et d'autorisation.

Deux mecanismes cohabitent pendant la bascule : `admin_required` (mot de passe
partage, voue a disparaitre) et `role_required` (session Discord).

`admin_or_role_required` accepte les deux et loggue laquelle a servi. C'est le
SEUL point ou la double lecture est autorisee : deux decorateurs empiles se
comportent comme un ET alors qu'on veut un OU.

Distinction 401/403/503 (R-28) : le frontend purge la session sur 401/403, une
indisponibilite de la base ne doit donc jamais produire ces codes.
"""

from __future__ import annotations

import functools
import hashlib
import logging
from datetime import datetime, timezone

from flask import request, jsonify, g

from constants import ROLE_HIERARCHY, ROLE_PLAYER
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
