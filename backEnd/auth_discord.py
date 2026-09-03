"""Echange OAuth2 Discord et gestion des comptes.

L'echange se fait cote BACKEND : DISCORD_CLIENT_SECRET reste dans le seul
service qui possede deja des secrets, le frontend ne relaie que le `code`.

Trois pieges Discord, chacun produisant une erreur sans message utile :

1. /oauth2/token attend du x-www-form-urlencoded -> `data=`, pas `json=`.
2. redirect_uri identique AU CARACTERE PRES entre /authorize, /token et le
   portail. D'ou l'environnement et jamais url_for(_external=True), qui
   produirait du http:// derriere les deux proxys.
3. L'echange est IDEMPOTENT : si le compte existe deja on renvoie une
   session, sinon un frontend qui abandonne en cours laisse l'utilisateur
   avec une invitation deja consommee.
"""

from __future__ import annotations

import os
import hashlib
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone

import requests

from constants import (
    DISCORD_API_BASE, DISCORD_CDN_BASE, DISCORD_HTTP_TIMEOUT,
    SESSION_JOUEUR_LIFETIME_DAYS, SESSION_ADMIN_LIFETIME_HOURS,
    ROLE_PLAYER, ROLE_SUPERADMIN, CGU_VERSION,
)
from db import get_db_connection

logger = logging.getLogger(__name__)

DISCORD_CLIENT_ID = os.environ.get('DISCORD_CLIENT_ID', '')
DISCORD_CLIENT_SECRET = os.environ.get('DISCORD_CLIENT_SECRET', '')
DISCORD_REDIRECT_URI = os.environ.get('DISCORD_REDIRECT_URI', '')
# Amorcage du premier superadmin : aucune IHM ne peut le creer, toute route
# d'attribution de role exigeant d'etre deja superadmin.
DISCORD_SUPERADMIN_ID = os.environ.get('DISCORD_SUPERADMIN_ID', '')


# Valide avant de finir dans un chemin d'URL : on ne construit pas une URL
# publique avec une valeur distante non verifiee.
RE_SNOWFLAKE = re.compile(r'^[0-9]{1,32}$')
RE_AVATAR_HASH = re.compile(r'^[A-Za-z0-9_]{1,64}$')


class DiscordAuthError(Exception):
    """Echec d'authentification imputable a Discord ou a la demande."""

    def __init__(self, message: str, status: int = 400, code: str = 'discord_error'):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def discord_configured() -> bool:
    return bool(DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET and DISCORD_REDIRECT_URI)


def hash_token(token: str) -> str:
    """sha256 hexadecimal. Ce qui va en base, jamais le token lui-meme."""
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def avatar_url(discord_id: str, avatar_hash: str | None, size: int = 128) -> str:
    """URL CDN de l'avatar, avec repli sur l'avatar par defaut Discord.

    Le repli decale le snowflake : a faire ici et pas en JS, ou l'entier
    depasserait 2^53.
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

    Ne loggue jamais le corps des reponses : il contient le code et les jetons.
    """
    if not discord_configured():
        raise DiscordAuthError("Authentification Discord non configuree", 503, 'non_configure')

    # Toujours la valeur de l'environnement : Discord compare caractere par
    # caractere avec le portail developpeur.
    uri = redirect_uri or DISCORD_REDIRECT_URI

    try:
        token_res = requests.post(
            f"{DISCORD_API_BASE}/oauth2/token",
            data={                       # form-urlencoded, PAS json=
                'client_id': DISCORD_CLIENT_ID,
                'client_secret': DISCORD_CLIENT_SECRET,
                'grant_type': 'authorization_code',
                'code': code,
                'redirect_uri': uri,     # exige aussi ici, pas seulement sur /authorize
            },
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            timeout=DISCORD_HTTP_TIMEOUT,
        )
    except requests.exceptions.RequestException:
        raise DiscordAuthError("Discord injoignable", 503, 'discord_injoignable')

    if token_res.status_code != 200:
        # Le statut seul : le corps contient le code OAuth.
        logger.warning("Echec /oauth2/token (HTTP %s)", token_res.status_code)
        raise DiscordAuthError("Code d'autorisation invalide ou expire", 400, 'code_invalide')

    try:
        access_token = token_res.json()['access_token']
    except (ValueError, KeyError):
        raise DiscordAuthError("Reponse Discord inexploitable", 502, 'reponse_invalide')

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
        raise DiscordAuthError("Reponse Discord inexploitable", 502, 'reponse_invalide')

    if not me.get('id'):
        raise DiscordAuthError("Profil Discord sans identifiant", 502, 'profil_illisible')

    discord_id = str(me['id'])
    if not RE_SNOWFLAKE.match(discord_id):
        logger.warning("Identifiant Discord au format inattendu, connexion refusee")
        raise DiscordAuthError("Profil Discord invalide", 502, 'profil_illisible')

    avatar_hash = (me.get('avatar') or '')[:64] or None
    if avatar_hash is not None and not RE_AVATAR_HASH.match(avatar_hash):
        # Degrade au lieu de refuser : avatar_url() retombe sur l'avatar par
        # defaut, perdre une image ne justifie pas de bloquer une connexion.
        logger.warning("Hash d'avatar Discord au format inattendu, ignore")
        avatar_hash = None

    return {
        'discord_id': discord_id,             # snowflake : toujours une chaine
        'username': (me.get('username') or '')[:64] or None,
        'global_name': (me.get('global_name') or '')[:64] or None,
        'avatar_hash': avatar_hash,
    }


def upsert_compte(cur, profil: dict, invitation_id: int | None = None,
                  cgu_acceptee: bool = False) -> dict:
    """Cree ou rafraichit le compte, et renvoie son etat.

    Le miroir Discord est rafraichi a chaque connexion. Rien n'est propage vers
    joueurs.nom : c'est un geste admin explicite.
    """
    cur.execute(
        """
        INSERT INTO comptes (discord_id, discord_username, discord_global_name,
                             discord_avatar_hash, invitation_id,
                             cgu_accepted_at, cgu_version,
                             discord_synced_at, last_login_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, now(), now())
        ON CONFLICT (discord_id) DO UPDATE SET
            discord_username    = EXCLUDED.discord_username,
            discord_global_name = EXCLUDED.discord_global_name,
            discord_avatar_hash = EXCLUDED.discord_avatar_hash,
            discord_synced_at   = now(),
            last_login_at       = now(),
            updated_at          = now()
        -- cgu_* volontairement absentes du DO UPDATE : la date du consentement
        -- d'origine ne doit pas etre ecrasee a chaque reconnexion.
        RETURNING id, discord_id, discord_username, discord_global_name,
                  discord_avatar_hash, joueur_id, statut, role,
                  cgu_accepted_at, cgu_version
        """,
        (profil['discord_id'], profil['username'], profil['global_name'],
         profil['avatar_hash'], invitation_id,
         datetime.now(timezone.utc) if cgu_acceptee else None,
         CGU_VERSION if cgu_acceptee else None),
    )
    row = cur.fetchone()
    return {
        'id': row[0], 'discord_id': row[1], 'discord_username': row[2],
        'discord_global_name': row[3], 'discord_avatar_hash': row[4],
        'joueur_id': row[5], 'statut': row[6], 'role': row[7],
        'cgu_accepted_at': row[8], 'cgu_version': row[9],
    }


def promote_bootstrap_superadmin(cur, compte: dict) -> bool:
    """Promeut le compte d'amorcage, et lui seul, s'il n'y a aucun superadmin.

    Sans la condition « aucun superadmin existant », la variable
    d'environnement serait une porte derobee permanente.
    """
    if not DISCORD_SUPERADMIN_ID or compte['discord_id'] != DISCORD_SUPERADMIN_ID:
        return False
    if compte['role'] == ROLE_SUPERADMIN:
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
    cur.execute(
        """INSERT INTO audit_admin (action, acteur_compte_id, cible_type, cible_id, details)
           VALUES (%s, %s, %s, %s, %s::jsonb)""",
        ('role_attribue', compte['id'], 'compte', compte['id'],
         '{"ancien": "player", "nouveau": "superadmin", "origine": "amorcage"}'),
    )
    compte['role'] = ROLE_SUPERADMIN
    logger.info("Compte %s promu superadmin par amorcage", compte['id'])
    return True


def create_session(cur, compte_id: int, role: str, user_agent: str | None) -> tuple[str, datetime]:
    """Cree une session et renvoie (token en clair, expiration).

    La base n'en garde que le sha256. L'expiration est absolue.
    """
    token = secrets.token_urlsafe(32)
    if role == ROLE_PLAYER:
        expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_JOUEUR_LIFETIME_DAYS)
    else:
        # Un compte privilegie ouvre bien plus de portes : session courte.
        expires_at = datetime.now(timezone.utc) + timedelta(hours=SESSION_ADMIN_LIFETIME_HOURS)

    cur.execute(
        """INSERT INTO sessions_joueurs (token_hash, compte_id, expires_at, last_seen_at, user_agent)
           VALUES (%s, %s, %s, now(), %s)""",
        (hash_token(token), compte_id, expires_at, (user_agent or '')[:255] or None),
    )
    # Menage opportuniste, sur le modele du DELETE FROM api_tokens existant.
    cur.execute("DELETE FROM sessions_joueurs WHERE expires_at < now()")
    return token, expires_at


def consume_invitation(cur, token: str | None) -> tuple[int, int | None]:
    """Valide et consomme une invitation. Renvoie (id, joueur_id vise).

    La consommation n'a lieu QU'ICI, au retour de Discord : coller le lien dans
    un salon declenche un GET du crawler, qui brulerait un lien max_uses=1 avant
    que quiconque ait clique.

    Appelee seulement pour un compte inexistant, ce qui rend l'echange rejouable.
    """
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
        raise DiscordAuthError("Invitation revoquee", 403, 'invitation_revoquee')
    if expires_at <= datetime.now(timezone.utc):
        raise DiscordAuthError("Invitation expiree", 403, 'invitation_expiree')
    if uses >= max_uses:
        raise DiscordAuthError("Invitation deja utilisee", 403, 'invitation_epuisee')

    cur.execute("UPDATE invitations SET uses = uses + 1 WHERE id = %s", (inv_id,))
    return inv_id, joueur_vise


def login(code: str, invite_token: str | None, user_agent: str | None,
          redirect_uri: str | None = None, cgu_acceptee: bool = False) -> dict:
    """Parcours complet : code -> profil Discord -> compte -> session.

    Une seule transaction : le compte, l'invitation consommee et la session
    existent ensemble, ou rien n'a eu lieu.
    """
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
                    # Un compte suspendu ne doit pas obtenir de session : sinon
                    # la suspension ne serait qu'un libelle d'affichage.
                    raise DiscordAuthError("Ce compte est suspendu", 403, 'compte_suspendu')

                invitation_id = None
                joueur_vise = None
                if existant is None:
                    # Nouveau venu : l'invitation est obligatoire et se consomme.
                    invitation_id, joueur_vise = consume_invitation(cur, invite_token)

                compte = upsert_compte(cur, profil, invitation_id, cgu_acceptee)
                promote_bootstrap_superadmin(cur, compte)
                token, expires_at = create_session(
                    cur, compte['id'], compte['role'], user_agent
                )
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
            # Permet au frontend de reclamer le consentement aux comptes
            # anterieurs a sa mise en place.
            'cgu_a_accepter': compte['cgu_version'] != CGU_VERSION,
        },
        # Invitation nominative : le joueur que l'admin visait en creant le
        # lien. Le frontend s'en sert pour pre-remplir la revendication.
        'joueur_vise': joueur_vise,
    }
