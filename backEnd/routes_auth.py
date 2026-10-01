"""Routes d'authentification Discord et gestion des invitations."""

from __future__ import annotations

import json
import logging
import secrets
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request, g

from constants import (INVITATION_LIFETIME_HOURS, INVITATION_MAX_HOURS,
                       INVITATION_MAX_USES, CGU_VERSION, ROLE_ADMIN,
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
    """Echange le code OAuth contre une session (appele par le frontend).

    Prevoir un timeout d'au moins 15 s cote frontend : deux appels a Discord.
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
        )
    except DiscordAuthError as e:
        return jsonify({"error": e.message, "code": e.code}), e.status
    except Exception as e:
        # Pas de detail : l'exception peut contenir le code OAuth.
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
        # Pour l'affichage uniquement : le backend reverifie a chaque requete.
        "permissions": sorted(_permissions_effectives(compte)),
        "cgu_a_accepter": compte.get('cgu_version') != CGU_VERSION,
    })


@auth_bp.route('/auth/check-session', methods=['GET'])
@player_required_sans_cgu
def check_session():
    """Verifie la session a chaque page du frontend.

    Renvoie role et permissions (deja lus par player_required) pour eviter un
    appel a /auth/me. N'exige pas le consentement : c'est elle qui signale au
    frontend la page d'acceptation a afficher.
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

def _hash_session_courante() -> str | None:
    """sha256 du token de la requete en cours, ou None s'il manque."""
    token = request.headers.get(SESSION_HEADER)
    return hash_token(token) if token else None


@auth_bp.route('/auth/mes-sessions', methods=['GET'])
@player_required
def mes_sessions():
    """Liste les sessions actives du titulaire.

    Le token_hash sert seulement a reperer la session courante et n'est jamais
    renvoye.
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

    # Les sessions expirees ne sont purgees qu'a leur prochaine utilisation.
    return jsonify({"sessions": [{
        "appareil": resumer_appareil(r[3]),
        "ouverte_le": r[0].isoformat(),
        "expire_le": r[1].isoformat(),
        "derniere_activite": r[2].isoformat() if r[2] else None,
        "courante": bool(courante) and r[4] == courante,
    } for r in lignes]})


@auth_bp.route('/auth/mes-sessions', methods=['DELETE'])
@player_required
def fermer_mes_sessions():
    """Ferme les sessions du titulaire, sauf la courante par defaut.

    Pas d'entree dans audit_admin : elle ne trace que les actions d'un admin
    sur autrui.
    """
    corps = request.get_json(silent=True) or {}
    inclure_courante = corps.get('inclure_courante') is True
    courante = _hash_session_courante()

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                # Le filtre compte_id est indispensable.
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

    logger.info("Sessions fermees par le titulaire (compte %s): %s", g.compte['id'], fermees)
    return jsonify({
        "status": "success",
        "sessions_fermees": fermees,
        # Indique au frontend de purger son cookie.
        "session_fermee": inclure_courante or courante is None,
    })


def _permissions_effectives(compte: dict) -> set:
    """Permissions dont ce compte dispose reellement, role compris."""
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
                # Ignore les sous-permissions orphelines.
                return permissions_effectives(r[0] for r in cur.fetchall())
    except Exception as e:
        # Une liste vide degrade l'affichage sans donner de droit.
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
    """Etat d'une invitation, sans la consommer.

    Les apercus de lien (Discord, Slack...) font un GET : la consommation a
    lieu dans /auth/discord/exchange.
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
    """Liste les invitations (sans token : seul le hash est stocke)."""
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
    """Cree une invitation et renvoie le lien une seule fois (seul le hash est stocke)."""
    data = request.get_json(silent=True) or {}
    label = (data.get('label') or '')[:100] or None
    joueur_id = data.get('joueur_id')
    # bool est un int en Python, d'ou son exclusion.
    if joueur_id is not None and (not isinstance(joueur_id, int) or isinstance(joueur_id, bool)):
        return jsonify({"error": "Paramètres invalides"}), 400
    try:
        max_uses = int(data.get('max_uses', 1))
        heures = int(data.get('heures', INVITATION_LIFETIME_HOURS))
    except (TypeError, ValueError):
        return jsonify({"error": "Paramètres invalides"}), 400

    # Refus explicite plutot que plafonnement silencieux.
    if not (1 <= max_uses <= INVITATION_MAX_USES and 1 <= heures <= INVITATION_MAX_HOURS):
        return jsonify({
            "error": "Une invitation vaut au plus %d utilisations et %d jours."
                     % (INVITATION_MAX_USES, INVITATION_MAX_HOURS // 24),
            "code": "invitation_hors_plafond",
            "max_uses": INVITATION_MAX_USES,
            "max_heures": INVITATION_MAX_HOURS,
        }), 400

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
                    return jsonify({"error": "Invitation introuvable ou déjà révoquée"}), 404
                audit.ecrire(cur, 'invitation_revoquee', 'invitation', invitation_id)
            conn.commit()
    except Exception as e:
        logger.error("Revocation d'invitation impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success"})


