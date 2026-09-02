"""Routes d'authentification Discord et gestion des invitations.

Regroupees ici plutot que dans routes_admin.py : tout le domaine « qui es-tu »
vit au meme endroit, et routes_admin.py depasse deja le millier de lignes.
"""

from __future__ import annotations

import json
import logging
import secrets
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request, g

from constants import INVITATION_LIFETIME_HOURS, CGU_VERSION
from auth import player_required, admin_or_role_required, SESSION_HEADER
from auth_discord import (
    DiscordAuthError, login, hash_token, avatar_url, discord_configured,
)
from db import get_db_connection

logger = logging.getLogger(__name__)

auth_bp = Blueprint('auth', __name__)


# ---------------------------------------------------------------------------
# Connexion
# ---------------------------------------------------------------------------

@auth_bp.route('/auth/discord/exchange', methods=['POST'])
def discord_exchange():
    """Echange le code OAuth contre une session. Appele par le frontend seul.

    Le frontend doit utiliser un timeout DEDIE (>= 15 s) pour cette route :
    deux appels reseau vers Discord se cachent derriere, et son timeout par
    defaut de 5 s couperait alors que le compte vient d'etre cree.
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
        "avatar_url": avatar_url(compte['discord_id'], compte['discord_avatar_hash']),
        "joueur_id": compte['joueur_id'],
        "joueur_nom": nom_joueur,
        "statut": compte['statut'],
        "role": compte['role'],
        "cgu_a_accepter": compte.get('cgu_version') != CGU_VERSION,
    })


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

    Coller le lien d'invitation dans un salon Discord declenche un GET du
    crawler qui deroule l'apercu. Si l'affichage consommait l'invitation, un
    lien max_uses=1 serait brule avant que quiconque ait pu cliquer. Les
    apercus de Slack, Signal ou d'un antivirus d'entreprise font pareil.
    La consommation a lieu dans /auth/discord/exchange, au retour de Discord.
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
@admin_or_role_required
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
@admin_or_role_required
def creer_invitation():
    """Cree une invitation et renvoie le lien UNE SEULE FOIS.

    Seul le sha256 part en base : le token est irrecuperable ensuite. C'est
    aussi ce qui rend inexploitable un token qui aurait fuite dans les logs
    d'acces nginx, ou le chemin complet est journalise.
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
                cur.execute(
                    """INSERT INTO audit_admin (action, acteur_compte_id, cible_type, cible_id, details)
                       VALUES (%s, %s, %s, %s, %s::jsonb)""",
                    ('invitation_creee', _acteur_id(), 'invitation', invitation_id,
                     json.dumps({"max_uses": max_uses, "nominative": joueur_id is not None})),
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
@admin_or_role_required
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
                cur.execute(
                    """INSERT INTO audit_admin (action, acteur_compte_id, cible_type, cible_id)
                       VALUES (%s, %s, %s, %s)""",
                    ('invitation_revoquee', _acteur_id(), 'invitation', invitation_id),
                )
            conn.commit()
    except Exception as e:
        logger.error("Revocation d'invitation impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success"})


def _acteur_id():
    """Compte a l'origine de l'action, ou None si l'auth passe encore par le
    mot de passe partage — qui, lui, n'identifie personne."""
    compte = getattr(g, 'compte', None)
    return compte['id'] if compte else None
