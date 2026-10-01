"""Echange OAuth2 Discord et gestion des comptes.

L'echange se fait cote backend pour que DISCORD_CLIENT_SECRET n'en sorte pas.
"""

from __future__ import annotations

import os
import hashlib
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone

import requests

import audit

from constants import (
    DISCORD_API_BASE, DISCORD_CDN_BASE, DISCORD_HTTP_TIMEOUT,
    SESSION_JOUEUR_LIFETIME_DAYS, SESSION_ADMIN_LIFETIME_HOURS,
    ROLE_PLAYER, ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN, ROLE_HIERARCHY,
    PERMISSIONS_CATALOGUE, CGU_VERSION, permissions_effectives,
)
from db import get_db_connection

logger = logging.getLogger(__name__)

DISCORD_CLIENT_ID = os.environ.get('DISCORD_CLIENT_ID', '')
DISCORD_CLIENT_SECRET = os.environ.get('DISCORD_CLIENT_SECRET', '')
# Une ou plusieurs URI de retour, separees par des virgules.
DISCORD_REDIRECT_URI = os.environ.get('DISCORD_REDIRECT_URI', '')
# Compte promu superadmin a sa premiere connexion s'il n'en existe aucun.
DISCORD_SUPERADMIN_ID = os.environ.get('DISCORD_SUPERADMIN_ID', '')


# Valeurs Discord inserees dans des URL.
RE_SNOWFLAKE = re.compile(r'^[0-9]{1,32}$')
RE_AVATAR_HASH = re.compile(r'^[A-Za-z0-9_]{1,64}$')


class DiscordAuthError(Exception):
    """Echec d'authentification imputable a Discord ou a la demande."""

    def __init__(self, message: str, status: int = 400, code: str = 'discord_error'):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def redirect_uris() -> list[str]:
    """URI de retour declarees (chacune doit figurer dans le portail Discord)."""
    return [u.strip() for u in DISCORD_REDIRECT_URI.split(',') if u.strip()]


def discord_configured() -> bool:
    return bool(DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET and redirect_uris())


def hash_token(token: str) -> str:
    """sha256 hexadecimal (seul le hash est stocke en base)."""
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def avatar_url(discord_id: str, avatar_hash: str | None, size: int = 128) -> str:
    """URL CDN de l'avatar, ou avatar par defaut de Discord.

    Calcule ici : le snowflake depasse 2^53 en JS.
    """
    if avatar_hash:
        return f"{DISCORD_CDN_BASE}/avatars/{discord_id}/{avatar_hash}.png?size={size}"
    try:
        index = (int(discord_id) >> 22) % 6
    except (TypeError, ValueError):
        index = 0
    return f"{DISCORD_CDN_BASE}/embed/avatars/{index}.png"


def exchange_code(code: str, redirect_uri: str | None = None) -> dict:
    """Echange le code OAuth contre un access_token, puis lit /users/@me.

    Ne journalise jamais le corps des reponses (code et jetons).
    """
    if not discord_configured():
        raise DiscordAuthError("Authentification Discord non configurée", 503, 'non_configure')

    # Discord exige l'URI exacte du portail : seules celles de l'environnement sont acceptees.
    uris = redirect_uris()
    if redirect_uri is None:
        uri = uris[0]
    elif redirect_uri in uris:
        uri = redirect_uri
    else:
        logger.warning("redirect_uri hors de DISCORD_REDIRECT_URI")
        raise DiscordAuthError("Adresse de retour inconnue", 400, 'redirect_uri_inconnue')

    try:
        token_res = requests.post(
            f"{DISCORD_API_BASE}/oauth2/token",
            data={  # form-urlencoded, pas json=
                'client_id': DISCORD_CLIENT_ID,
                'client_secret': DISCORD_CLIENT_SECRET,
                'grant_type': 'authorization_code',
                'code': code,
                'redirect_uri': uri,  # exige aussi ici
            },
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            timeout=DISCORD_HTTP_TIMEOUT,
        )
    except requests.exceptions.RequestException:
        raise DiscordAuthError("Discord injoignable", 503, 'discord_injoignable')

    if token_res.status_code != 200:
        logger.warning("Echec /oauth2/token (HTTP %s)", token_res.status_code)
        raise DiscordAuthError("Code d'autorisation invalide ou expiré", 400, 'code_invalide')

    try:
        access_token = token_res.json()['access_token']
    except (ValueError, KeyError):
        raise DiscordAuthError("Réponse Discord inexploitable", 502, 'reponse_invalide')

    try:
        me_res = requests.get(
            f"{DISCORD_API_BASE}/users/@me",
            headers={'Authorization': f"Bearer {access_token}"},
            timeout=DISCORD_HTTP_TIMEOUT,
        )
    except requests.exceptions.RequestException:
        raise DiscordAuthError("Discord injoignable", 503, 'discord_injoignable')

    if me_res.status_code != 200:
        logger.warning("Echec /users/@me (HTTP %s)", me_res.status_code)
        raise DiscordAuthError("Profil Discord illisible", 502, 'profil_illisible')

    try:
        me = me_res.json()
    except ValueError:
        raise DiscordAuthError("Réponse Discord inexploitable", 502, 'reponse_invalide')

    if not me.get('id'):
        raise DiscordAuthError("Profil Discord sans identifiant", 502, 'profil_illisible')

    discord_id = str(me['id'])
    if not RE_SNOWFLAKE.match(discord_id):
        logger.warning("Identifiant Discord au format inattendu, connexion refusee")
        raise DiscordAuthError("Profil Discord invalide", 502, 'profil_illisible')

    avatar_hash = (me.get('avatar') or '')[:64] or None
    if avatar_hash is not None and not RE_AVATAR_HASH.match(avatar_hash):
        # Repli sur l'avatar par defaut plutot que de refuser la connexion.
        logger.warning("Hash d'avatar Discord au format inattendu, ignore")
        avatar_hash = None

    return {
        'discord_id': discord_id,  # snowflake : toujours une chaine
        'username': (me.get('username') or '')[:64] or None,
        'global_name': (me.get('global_name') or '')[:64] or None,
        'avatar_hash': avatar_hash,
    }


def upsert_compte(cur, profil: dict, invitation_id: int | None = None) -> dict:
    """Cree ou rafraichit le compte et renvoie son etat.

    Ne pose jamais le consentement : il est recueilli par la page /consentement.
    """
    cur.execute(
        """
        INSERT INTO comptes (discord_id, discord_username, discord_global_name,
                             discord_avatar_hash, invitation_id,
                             discord_synced_at, last_login_at)
        VALUES (%s, %s, %s, %s, %s, now(), now())
        ON CONFLICT (discord_id) DO UPDATE SET
            discord_username    = EXCLUDED.discord_username,
            discord_global_name = EXCLUDED.discord_global_name,
            discord_avatar_hash = EXCLUDED.discord_avatar_hash,
            discord_synced_at   = now(),
            last_login_at       = now(),
            updated_at          = now()
        -- cgu_* absentes de l'INSERT comme du DO UPDATE : seul POST /me/cgu
        -- les ecrit.
        RETURNING id, discord_id, discord_username, discord_global_name,
                  discord_avatar_hash, joueur_id, statut, role,
                  cgu_accepted_at, cgu_version
        """,
        (profil['discord_id'], profil['username'], profil['global_name'],
         profil['avatar_hash'], invitation_id),
    )
    row = cur.fetchone()
    return {
        'id': row[0], 'discord_id': row[1], 'discord_username': row[2],
        'discord_global_name': row[3], 'discord_avatar_hash': row[4],
        'joueur_id': row[5], 'statut': row[6], 'role': row[7],
        'cgu_accepted_at': row[8], 'cgu_version': row[9],
    }


def promote_bootstrap_superadmin(cur, compte: dict) -> bool:
    """Promeut le compte d'amorcage s'il n'existe aucun superadmin."""
    if not DISCORD_SUPERADMIN_ID or compte['discord_id'] != DISCORD_SUPERADMIN_ID:
        return False
    if compte['role'] == ROLE_SUPERADMIN:
        return False

    # Verrou avant le COUNT pour eviter que deux connexions simultanees
    # passent la garde.
    cur.execute("SELECT role FROM comptes WHERE id = %s FOR UPDATE", (compte['id'],))
    row = cur.fetchone()
    if row is None or row[0] == ROLE_SUPERADMIN:
        return False

    cur.execute(
        "SELECT COUNT(*) FROM comptes WHERE role = %s AND id <> %s",
        (ROLE_SUPERADMIN, compte['id']),
    )
    if cur.fetchone()[0] > 0:
        logger.warning(
            "DISCORD_SUPERADMIN_ID ignore : un superadmin existe deja (compte %s)",
            compte['id'],
        )
        return False

    cur.execute(
        "UPDATE comptes SET role = %s, updated_at = now() WHERE id = %s",
        (ROLE_SUPERADMIN, compte['id']),
    )
    # Ferme les sessions existantes (leur duree depend du role).
    cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s", (compte['id'],))
    # Pas encore de g.compte : le compte est acteur et cible.
    audit.ecrire(
        cur, 'role_attribue', 'compte', compte['id'],
        {"ancien": "player", "nouveau": "superadmin", "origine": "amorcage"},
        acteur_id=compte['id'],
    )
    compte['role'] = ROLE_SUPERADMIN
    logger.info("Compte %s promu superadmin par amorcage", compte['id'])
    return True


def peut_amorcer_sans_invitation(cur, discord_id: str) -> bool:
    """Vrai si ce compte Discord inexistant peut entrer sans invitation.

    Conditions identiques a promote_bootstrap_superadmin (verifie par un test).
    """
    if not DISCORD_SUPERADMIN_ID or discord_id != DISCORD_SUPERADMIN_ID:
        return False

    cur.execute("SELECT COUNT(*) FROM comptes WHERE role = %s", (ROLE_SUPERADMIN,))
    if cur.fetchone()[0] > 0:
        logger.warning(
            "DISCORD_SUPERADMIN_ID ignore pour l'entree : un superadmin existe deja"
        )
        return False

    logger.info("Amorcage : creation du compte superadmin sans invitation")
    return True


def _permissions_pour_session(cur, compte: dict) -> list:
    """Permissions a exposer a l'interface, role compris. Triees."""
    if ROLE_HIERARCHY.get(compte['role'], 0) >= ROLE_HIERARCHY[ROLE_CHEF_ADMIN]:
        return sorted(PERMISSIONS_CATALOGUE)
    if compte['role'] != ROLE_ADMIN:
        return []
    cur.execute("SELECT permission FROM permissions_admin WHERE compte_id = %s",
                (compte['id'],))
    # Ignore les sous-permissions orphelines.
    return sorted(permissions_effectives(r[0] for r in cur.fetchall()))


def create_session(cur, compte_id: int, role: str, user_agent: str | None) -> tuple[str, datetime]:
    """Cree une session et renvoie (token en clair, expiration absolue).

    La duree depend du role au moment de la creation : toute modification du
    role doit donc fermer les sessions du compte.
    """
    token = secrets.token_urlsafe(32)
    if role == ROLE_PLAYER:
        expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_JOUEUR_LIFETIME_DAYS)
    else:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=SESSION_ADMIN_LIFETIME_HOURS)

    cur.execute(
        """INSERT INTO sessions_joueurs (token_hash, compte_id, expires_at, last_seen_at, user_agent)
           VALUES (%s, %s, %s, now(), %s)""",
        (hash_token(token), compte_id, expires_at, (user_agent or '')[:255] or None),
    )
    # Purge des sessions expirees.
    cur.execute("DELETE FROM sessions_joueurs WHERE expires_at < now()")
    return token, expires_at


# Libelles d'appareil. L'ordre compte : les user-agents se contiennent
# (Edge contient Chrome, Chrome contient Safari, Android contient Linux).
_NAVIGATEURS = (
    ('Edg/', 'Edge'),
    ('OPR/', 'Opera'),
    ('Firefox/', 'Firefox'),
    ('Chrome/', 'Chrome'),
    ('Safari/', 'Safari'),
)
_SYSTEMES = (
    ('Android', 'Android'),
    ('iPhone', 'iOS'),
    ('iPad', 'iOS'),
    ('Windows', 'Windows'),
    ('Mac OS X', 'macOS'),
    ('Linux', 'Linux'),
)
APPAREIL_INCONNU = 'Appareil inconnu'


def resumer_appareil(user_agent: str | None) -> str:
    """Resume un user-agent en libelle court.

    Ne renvoie que des constantes ci-dessus, jamais un fragment de l'entree.
    """
    if not user_agent:
        return APPAREIL_INCONNU

    navigateur = next((nom for motif, nom in _NAVIGATEURS if motif in user_agent), None)
    systeme = next((nom for motif, nom in _SYSTEMES if motif in user_agent), None)

    if navigateur and systeme:
        return f"{navigateur} sur {systeme}"
    return navigateur or systeme or APPAREIL_INCONNU


def consume_invitation(cur, token: str | None) -> tuple[int, int | None]:
    """Valide et consomme une invitation. Renvoie (id, joueur_id vise)."""
    if not token:
        raise DiscordAuthError("Invitation requise", 403, 'invitation_requise')

    cur.execute(
        """SELECT id, joueur_id, max_uses, uses, expires_at, revoked_at
           FROM invitations WHERE token_hash = %s FOR UPDATE""",
        (hash_token(token),),
    )
    row = cur.fetchone()
    if row is None:
        raise DiscordAuthError("Invitation inconnue", 403, 'invitation_inconnue')

    inv_id, joueur_vise, max_uses, uses, expires_at, revoked_at = row
    if revoked_at is not None:
        raise DiscordAuthError("Invitation révoquée", 403, 'invitation_revoquee')
    if expires_at <= datetime.now(timezone.utc):
        raise DiscordAuthError("Invitation expirée", 403, 'invitation_expiree')
    if uses >= max_uses:
        raise DiscordAuthError("Invitation déjà utilisée", 403, 'invitation_epuisee')

    cur.execute("UPDATE invitations SET uses = uses + 1 WHERE id = %s", (inv_id,))
    return inv_id, joueur_vise


def login(code: str, invite_token: str | None, user_agent: str | None,
          redirect_uri: str | None = None) -> dict:
    """Code -> profil Discord -> compte -> session, en une seule transaction."""
    profil = exchange_code(code, redirect_uri)

    with get_db_connection() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, statut FROM comptes WHERE discord_id = %s",
                    (profil['discord_id'],),
                )
                existant = cur.fetchone()

                if existant is not None and existant[1] == 'suspended':
                    raise DiscordAuthError("Ce compte est suspendu", 403, 'compte_suspendu')

                invitation_id = None
                joueur_vise = None
                if existant is None:
                    # Invitation obligatoire, sauf pour le compte d'amorcage.
                    if not peut_amorcer_sans_invitation(cur, profil['discord_id']):
                        invitation_id, joueur_vise = consume_invitation(cur, invite_token)

                compte = upsert_compte(cur, profil, invitation_id)
                promote_bootstrap_superadmin(cur, compte)
                token, expires_at = create_session(
                    cur, compte['id'], compte['role'], user_agent
                )
                # Lues ici pour que l'interface ait ses menus des la connexion.
                permissions = _permissions_pour_session(cur, compte)
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    return {
        'session_token': token,
        'expires_at': expires_at.isoformat(),
        'compte': {
            'id': compte['id'],
            'discord_id': compte['discord_id'],
            'pseudo': compte['discord_global_name'] or compte['discord_username'],
            'avatar_url': '/avatar/moi',
            'joueur_id': compte['joueur_id'],
            'statut': compte['statut'],
            'role': compte['role'],
            # Pour l'affichage uniquement.
            'permissions': permissions,
            'cgu_a_accepter': compte['cgu_version'] != CGU_VERSION,
        },
        # Invitation nominative : sert a pre-remplir la demande de liaison.
        'joueur_vise': joueur_vise,
    }
