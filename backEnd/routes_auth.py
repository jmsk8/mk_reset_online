"""Routes d'authentification Discord et gestion des invitations."""

from __future__ import annotations

import json
import logging
import secrets
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request, g

from constants import (INVITATION_LIFETIME_HOURS, CGU_VERSION, ROLE_ADMIN,
                       ROLE_CHEF_ADMIN, ROLE_HIERARCHY, PERMISSIONS_CATALOGUE,
                       permissions_effectives)
from auth import (player_required, player_required_sans_cgu, permission_required,
                  SESSION_HEADER)
from auth_discord import (
    DiscordAuthError, login, hash_token, discord_configured, resumer_appareil,
)
from db import get_db_connection

import audit

logger = logging.getLogger(__name__)

auth_bp = Blueprint('auth', __name__)


# ---------------------------------------------------------------------------
# Connexion
# ---------------------------------------------------------------------------

@auth_bp.route('/auth/discord/exchange', methods=['POST'])
def discord_exchange():
    """Echange le code OAuth contre une session. Appele par le frontend seul.

    Le frontend doit utiliser un timeout DEDIE (>= 15 s) : deux appels reseau vers
    Discord se cachent derriere.
    """
    data = request.get_json(silent=True) or {}
    code = data.get('code')
    if not code:
        return jsonify({"error": "Code manquant", "code": "code_manquant"}), 400

    try:
        resultat = login(
            code=code,
            invite_token=data.get('invite_token'),
            user_agent=data.get('user_agent'),
            redirect_uri=data.get('redirect_uri'),
            cgu_acceptee=bool(data.get('cgu_acceptee')),
        )
    except DiscordAuthError as e:
        return jsonify({"error": e.message, "code": e.code}), e.status
    except Exception as e:
        # Jamais le detail : une exception requests peut contenir le code OAuth.
        logger.error("Echec de l'echange OAuth (%s)", type(e).__name__)
        return jsonify({"error": "Erreur serveur", "code": "erreur_serveur"}), 500

    return jsonify(resultat)


@auth_bp.route('/auth/logout', methods=['POST'])
def logout():
    """Detruit la session courante. Idempotent : toujours 200."""
    token = request.headers.get(SESSION_HEADER)
    if token:
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM sessions_joueurs WHERE token_hash = %s",
                        (hash_token(token),),
                    )
                conn.commit()
        except Exception as e:
            logger.warning("Suppression de session impossible: %s", e)
    return jsonify({"status": "success"})


@auth_bp.route('/auth/me', methods=['GET'])
@player_required
def me():
    compte = g.compte
    nom_joueur = None
    if compte['joueur_id']:
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT nom FROM joueurs WHERE id = %s", (compte['joueur_id'],))
                    row = cur.fetchone()
                    nom_joueur = row[0] if row else None
        except Exception as e:
            logger.warning("Lecture du joueur lie impossible: %s", e)

    return jsonify({
        "id": compte['id'],
        "discord_id": compte['discord_id'],
        "pseudo": compte['discord_global_name'] or compte['discord_username'],
        "avatar_url": "/avatar/moi",
        "joueur_id": compte['joueur_id'],
        "joueur_nom": nom_joueur,
        "statut": compte['statut'],
        "role": compte['role'],
        # Ce que l'interface a le droit d'AFFICHER, jamais ce qu'elle autorise :
        # le backend relit role et permissions en base a chaque requete protegee.
        # Cette liste peut donc etre perimee, c'est assume (plan B.0).
        "permissions": sorted(_permissions_effectives(compte)),
        "cgu_a_accepter": compte.get('cgu_version') != CGU_VERSION,
    })


@auth_bp.route('/auth/check-session', methods=['GET'])
@player_required_sans_cgu
def check_session():
    """Sonde « ma session est-elle encore valide ? ». Miroir de /admin/check-token.

    Appelee par le before_request du frontend a CHAQUE page : elle ne doit donc
    rien lire de plus que la verification de session deja faite par
    player_required. C'est pourquoi elle ne renvoie PAS le profil -- /auth/me
    ferait une requete de plus pour le nom du joueur, payee sur toutes les pages.

    Elle rend en revanche le role et les permissions depuis le 2026-09-17, et
    c'est gratuit : `player_required` les a deja lus en base pour authentifier.
    Sans ca, le frontend devait appeler /auth/me EN PLUS a chaque rendu pour
    savoir ce qu'il avait le droit d'afficher -- deux appels reseau synchrones
    par page, sur 2 workers gunicorn, d'ou les 503 observes le 2026-09-17.

    Referme au passage la limite que cette docstring annoncait : un admin
    retrograde, ou a qui on vient d'accorder un droit, le voyait a sa prochaine
    visite sur /mon-compte seulement. La frontiere de privilege reste le
    backend, qui relit role et permissions a chaque requete protegee : cette
    liste ne sert qu'a decider ce que l'interface AFFICHE.

    Sans exigence de consentement (A-07) : c'est elle qui dit au frontend
    d'afficher la page d'acceptation. Refuser la session ici la ferait purger,
    et la personne retomberait sur le meme ecran apres un detour par Discord.
    """
    return jsonify({
        "status": "valid",
        "role": g.compte['role'],
        "permissions": sorted(_permissions_effectives(g.compte)),
        "cgu_a_accepter": g.compte.get('cgu_version') != CGU_VERSION,
    }), 200


# ---------------------------------------------------------------------------
# Mes sessions actives
# ---------------------------------------------------------------------------
# Referme A-03 de l'audit : le titulaire peut enfin voir et fermer ses propres
# sessions, sans passer par un administrateur. Jusqu'ici, quelqu'un dont le
# token avait fuite n'avait AUCUN recours seul -- et le reflexe naturel, se
# reconnecter, n'invalide rien (une connexion ajoute une session sans toucher
# aux precedentes). Le token vole restait vivant jusqu'a 30 jours.
#
# `player_required` n'expose que g.compte : ni le token, ni son hash. Les deux
# routes relisent donc l'en-tete elles-memes, comme logout() juste au-dessus.
# `.get()` et non [] : derriere player_required l'en-tete est forcement la,
# mais un 500 sur une page « securite » est le pire endroit pour un theoreme.

def _hash_session_courante() -> str | None:
    """sha256 du token de la requete en cours, ou None s'il manque."""
    token = request.headers.get(SESSION_HEADER)
    return hash_token(token) if token else None


@auth_bp.route('/auth/mes-sessions', methods=['GET'])
@player_required
def mes_sessions():
    """Liste les sessions actives du titulaire.

    Le token_hash est lu pour la seule comparaison en memoire qui marque « cet
    appareil », et n'est JAMAIS place dans la reponse : il est la cle primaire
    de sessions_joueurs, c'est-a-dire le verificateur d'authentification
    lui-meme. Le descendre dans le DOM publierait la moitie du mecanisme qui
    protege la session, et offrirait a un XSS la liste exacte des cibles a
    revoquer. C'est aussi pourquoi il n'y a pas de revocation par appareil :
    il n'existe aucun identifiant exposable a mettre dans le bouton.
    """
    courante = _hash_session_courante()
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT created_at, expires_at, last_seen_at, user_agent, token_hash
                       FROM sessions_joueurs
                       WHERE compte_id = %s AND expires_at > now()
                       ORDER BY last_seen_at DESC NULLS LAST, created_at DESC""",
                    (g.compte['id'],),
                )
                lignes = cur.fetchall()
    except Exception as e:
        logger.error("Lecture des sessions impossible: %s", e)
        return jsonify({"error": "Service indisponible", "code": "indisponible"}), 503

    # `expires_at > now()` est indispensable : les lignes mortes ne sont purgees
    # qu'a leur prochaine presentation. Sans ce filtre l'ecran afficherait des
    # fantomes et le compteur mentirait.
    return jsonify({"sessions": [{
        "appareil": resumer_appareil(r[3]),
        "ouverte_le": r[0].isoformat(),
        "expire_le": r[1].isoformat(),
        # Nullable : une session creee mais jamais representee depuis. Le
        # frontend affiche « jamais utilisee » -- c'est informatif, et une
        # session jamais utilisee sur un compte qu'on croit compromis est
        # precisement le signal qu'on cherche.
        "derniere_activite": r[2].isoformat() if r[2] else None,
        "courante": bool(courante) and r[4] == courante,
    } for r in lignes]})


@auth_bp.route('/auth/mes-sessions', methods=['DELETE'])
@player_required
def fermer_mes_sessions():
    """Ferme les sessions du titulaire. Epargne la courante par defaut.

    Le geste utile est « expulse tous les autres, je reste » : se deconnecter
    soi-meme en prime est une punition gratuite qui pousse a ne pas cliquer.
    `inclure_courante` existe pour l'appareil qu'on est en train d'abandonner.

    Pas d'ecriture dans audit_admin : cette table trace ce qu'un ADMINISTRATEUR
    fait a autrui (elle porte acteur_compte_id + cible_id). Un titulaire qui
    agit sur son propre compte n'y a pas sa place, et l'y mettre brouillerait
    la lecture du registre RGPD. Un logger.info sans donnee personnelle suffit
    -- consequence assumee : le geste ne laisse aucune trace consultable par
    l'utilisateur ni par le support.
    """
    corps = request.get_json(silent=True) or {}
    inclure_courante = corps.get('inclure_courante') is True
    courante = _hash_session_courante()

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                # La clause compte_id est la frontiere de cloisonnement : la
                # meme requete sans elle viderait sessions_joueurs pour tout le
                # monde. Trois routes admin portent deja ce DELETE, celle-ci
                # est la seule ouverte a un joueur.
                if inclure_courante or courante is None:
                    cur.execute(
                        "DELETE FROM sessions_joueurs WHERE compte_id = %s",
                        (g.compte['id'],),
                    )
                else:
                    cur.execute(
                        "DELETE FROM sessions_joueurs WHERE compte_id = %s AND token_hash != %s",
                        (g.compte['id'], courante),
                    )
                fermees = cur.rowcount
            conn.commit()
    except Exception as e:
        logger.error("Fermeture des sessions impossible: %s", e)
        return jsonify({"error": "Service indisponible", "code": "indisponible"}), 503

    # Sans donnee personnelle : un identifiant de compte et un compteur.
    logger.info("Sessions fermees par le titulaire (compte %s): %s", g.compte['id'], fermees)
    return jsonify({
        "status": "success",
        "sessions_fermees": fermees,
        # Le frontend s'en sert pour purger son cookie : sans ca, le navigateur
        # garderait une session serveur pointant vers une session detruite et
        # decouvrirait le probleme par une erreur.
        "session_fermee": inclure_courante or courante is None,
    })


def _permissions_effectives(compte: dict) -> set:
    """Permissions dont ce compte dispose reellement, role compris.

    chef_admin et superadmin recoivent le catalogue entier : leur socle EST le
    catalogue, et l'interface doit le refleter sans reimplementer la regle.
    Un admin n'a que ses lignes permissions_admin ; un player, rien.
    """
    if ROLE_HIERARCHY.get(compte['role'], 0) >= ROLE_HIERARCHY[ROLE_CHEF_ADMIN]:
        return set(PERMISSIONS_CATALOGUE)
    if compte['role'] != ROLE_ADMIN:
        return set()
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT permission FROM permissions_admin WHERE compte_id = %s",
                    (compte['id'],),
                )
                # Filtre les sous-permissions orphelines : les exposer ferait
                # afficher un bouton que le backend refuse.
                return permissions_effectives(r[0] for r in cur.fetchall())
    except Exception as e:
        # Renvoyer une liste vide degrade l'affichage (des onglets manquent),
        # ca ne donne aucun droit : l'autorisation reste cote backend.
        logger.warning("Lecture des permissions du compte %s impossible: %s", compte['id'], e)
        return set()


@auth_bp.route('/auth/config', methods=['GET'])
def config():
    """Dit au frontend si la connexion Discord est utilisable. Aucun secret."""
    return jsonify({"discord_configure": discord_configured()})


# ---------------------------------------------------------------------------
# Invitations
# ---------------------------------------------------------------------------

@auth_bp.route('/auth/invitation/<token>', methods=['GET'])
def lire_invitation(token):
    """Etat d'une invitation. STRICTEMENT idempotent : ne consomme rien.

    Coller le lien dans un salon declenche un GET du crawler Discord (Slack et
    Signal font pareil) : un lien max_uses=1 serait brule avant le premier clic.
    La consommation a lieu dans /auth/discord/exchange.
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT i.id, i.label, i.max_uses, i.uses, i.expires_at,
                              i.revoked_at, j.nom
                       FROM invitations i
                       LEFT JOIN joueurs j ON j.id = i.joueur_id
                       WHERE i.token_hash = %s""",
                    (hash_token(token),),
                )
                row = cur.fetchone()
    except Exception as e:
        logger.error("Lecture d'invitation impossible: %s", e)
        return jsonify({"error": "Service indisponible", "code": "indisponible"}), 503

    if row is None:
        return jsonify({"valide": False, "code": "invitation_inconnue"}), 404

    _id, label, max_uses, uses, expires_at, revoked_at, joueur_nom = row
    if revoked_at is not None:
        return jsonify({"valide": False, "code": "invitation_revoquee"}), 410
    if expires_at <= datetime.now(timezone.utc):
        return jsonify({"valide": False, "code": "invitation_expiree"}), 410
    if uses >= max_uses:
        return jsonify({"valide": False, "code": "invitation_epuisee"}), 410

    return jsonify({
        "valide": True,
        "label": label,
        "joueur_nom": joueur_nom,          # invitation nominative
        "restantes": max_uses - uses,
        "expires_at": expires_at.isoformat(),
    })


@auth_bp.route('/admin/invitations', methods=['GET'])
@permission_required('gestion_invitations')
def lister_invitations():
    """Liste les invitations. Ne renvoie JAMAIS de token : seul le hash existe."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT i.id, i.label, i.max_uses, i.uses, i.expires_at,
                              i.revoked_at, i.created_at, j.nom
                       FROM invitations i
                       LEFT JOIN joueurs j ON j.id = i.joueur_id
                       ORDER BY i.created_at DESC LIMIT 200"""
                )
                rows = cur.fetchall()
    except Exception as e:
        logger.error("Liste des invitations impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    maintenant = datetime.now(timezone.utc)
    return jsonify([
        {
            "id": r[0], "label": r[1], "max_uses": r[2], "uses": r[3],
            "expires_at": r[4].isoformat(), "joueur_nom": r[7],
            "revoquee": r[5] is not None,
            "expiree": r[4] <= maintenant,
            "epuisee": r[3] >= r[2],
            "created_at": r[6].isoformat(),
        }
        for r in rows
    ])


@auth_bp.route('/admin/invitations', methods=['POST'])
@permission_required('gestion_invitations')
def creer_invitation():
    """Cree une invitation et renvoie le lien UNE SEULE FOIS.

    Seul le sha256 part en base : un token qui fuirait dans les logs d'acces nginx
    resterait inexploitable.
    """
    data = request.get_json(silent=True) or {}
    label = (data.get('label') or '')[:100] or None
    joueur_id = data.get('joueur_id')
    try:
        max_uses = max(1, int(data.get('max_uses', 1)))
        heures = max(1, int(data.get('heures', INVITATION_LIFETIME_HOURS)))
    except (TypeError, ValueError):
        return jsonify({"error": "Parametres invalides"}), 400

    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=heures)

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                if joueur_id is not None:
                    cur.execute("SELECT 1 FROM joueurs WHERE id = %s", (joueur_id,))
                    if cur.fetchone() is None:
                        conn.rollback()
                        return jsonify({"error": "Joueur introuvable"}), 404

                cur.execute(
                    """INSERT INTO invitations (token_hash, label, joueur_id, max_uses, expires_at)
                       VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                    (hash_token(token), label, joueur_id, max_uses, expires_at),
                )
                invitation_id = cur.fetchone()[0]
                audit.ecrire(
                    cur, 'invitation_creee', 'invitation', invitation_id,
                    {"max_uses": max_uses, "nominative": joueur_id is not None},
                )
            conn.commit()
    except Exception as e:
        logger.error("Creation d'invitation impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({
        "id": invitation_id,
        "token": token,              # visible une seule fois
        "expires_at": expires_at.isoformat(),
    }), 201


@auth_bp.route('/admin/invitations/<int:invitation_id>/revoquer', methods=['POST'])
@permission_required('gestion_invitations')
def revoquer_invitation(invitation_id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE invitations SET revoked_at = now() WHERE id = %s AND revoked_at IS NULL",
                    (invitation_id,),
                )
                if cur.rowcount == 0:
                    conn.rollback()
                    return jsonify({"error": "Invitation introuvable ou deja revoquee"}), 404
                audit.ecrire(cur, 'invitation_revoquee', 'invitation', invitation_id)
            conn.commit()
    except Exception as e:
        logger.error("Revocation d'invitation impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success"})


