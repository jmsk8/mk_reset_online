"""API de service pour les bots Discord.

Un bot est un TIERS, pas un administrateur :

- **lecture seule** : `matchmaking` calcule, il n'enregistre rien ;
- **donnees minimales** : classement et identite Discord. Publier le role
  designerait les administrateurs a quiconque possede un jeton ;
- **comptes `linked` seulement** : un compte `pending` est une identite non
  verifiee.

Ces routes ne sont pas joignables directement : nginx n'est pas sur le reseau
`backend`, c'est le frontend qui proxifie /api/bot/.
"""

from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request, g

from auth import service_required
from db import get_db_connection
from services import construire_lobbies, resoudre_joueurs_matchmaking

logger = logging.getLogger(__name__)

bot_bp = Blueprint('bot', __name__)

# Plafond de la composition : au-dela, c'est une erreur d'appel, pas un tournoi.
MAX_JOUEURS_MATCHMAKING = 200


@bot_bp.route('/api/bot/joueurs', methods=['GET'])
@service_required('read:joueurs')
def bot_joueurs():
    """Joueurs du classement, avec leur identite Discord quand elle est liee."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT j.id, j.nom, j.score_trueskill, j.tier, j.is_ranked,
                              c.discord_id
                       FROM Joueurs j
                       LEFT JOIN comptes c ON c.joueur_id = j.id AND c.statut = 'linked'
                       WHERE j.anonymise_at IS NULL
                       ORDER BY j.score_trueskill DESC NULLS LAST"""
                )
                rows = cur.fetchall()
    except Exception as e:
        logger.error("API bot, liste des joueurs: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify([{
        "id": r[0],
        "nom": r[1],
        "score_trueskill": round(float(r[2]), 3) if r[2] is not None else 0.0,
        "tier": r[3].strip() if r[3] else "?",
        "is_ranked": r[4],
        # Chaine, jamais un entier : un snowflake depasse 2^53 et se corrompt
        # silencieusement des qu'un client JSON le lit comme un nombre.
        "discord_id": r[5],
    } for r in rows])


@bot_bp.route('/api/bot/joueur/by-discord/<discord_id>', methods=['GET'])
@service_required('read:joueurs')
def bot_joueur_par_discord(discord_id):
    """« Ce membre Discord, c'est quel joueur ? » -- la question centrale du bot."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT j.id, j.nom, j.score_trueskill, j.tier, j.is_ranked
                       FROM comptes c
                       JOIN Joueurs j ON j.id = c.joueur_id
                       WHERE c.discord_id = %s AND c.statut = 'linked'""",
                    (str(discord_id),),
                )
                row = cur.fetchone()
    except Exception as e:
        logger.error("API bot, resolution Discord: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    if row is None:
        # Volontairement indistinct : compte inconnu, non lie ou suspendu donnent la
        # meme reponse. Detailler renseignerait un tiers sur qui possede un compte.
        return jsonify({"error": "Aucun joueur lie a ce compte Discord",
                        "code": "non_lie"}), 404

    return jsonify({
        "id": row[0], "nom": row[1],
        "score_trueskill": round(float(row[2]), 3) if row[2] is not None else 0.0,
        "tier": row[3].strip() if row[3] else "?",
        "is_ranked": row[4],
        "discord_id": str(discord_id),
    })


@bot_bp.route('/api/bot/classement', methods=['GET'])
@service_required('read:classement')
def bot_classement():
    """Classement condense, pretr a etre affiche dans un salon."""
    try:
        limite = min(max(int(request.args.get('limite', 20)), 1), 100)
    except (TypeError, ValueError):
        limite = 20

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT j.nom, j.score_trueskill, j.tier
                       FROM Joueurs j
                       WHERE j.anonymise_at IS NULL AND j.is_ranked = true
                       ORDER BY j.score_trueskill DESC NULLS LAST
                       LIMIT %s""",
                    (limite,),
                )
                rows = cur.fetchall()
    except Exception as e:
        logger.error("API bot, classement: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify([{
        "rang": i + 1,
        "nom": r[0],
        "score_trueskill": round(float(r[1]), 3) if r[1] is not None else 0.0,
        "tier": r[2].strip() if r[2] else "?",
    } for i, r in enumerate(rows)])


@bot_bp.route('/api/bot/matchmaking', methods=['POST'])
@service_required('matchmaking')
def bot_matchmaking():
    """Compose les lobbies. Meme code que la page d'administration.

    Accepte des `discord_ids`, des `joueur_ids` ou des `noms`. Les scores sont
    toujours relus en base : un appelant qui fournirait les siens composerait les
    lobbies a sa guise.
    """
    data = request.get_json(silent=True) or {}
    discord_ids = data.get('discord_ids')
    joueur_ids = data.get('joueur_ids')
    noms = data.get('noms')

    fournis = [x for x in (discord_ids, joueur_ids, noms) if x]
    if len(fournis) != 1:
        return jsonify({
            "error": "Fournir exactement une liste : discord_ids, joueur_ids ou noms",
            "code": "entree_invalide",
        }), 400
    if not isinstance(fournis[0], list):
        return jsonify({"error": "Une liste est attendue", "code": "entree_invalide"}), 400
    if len(fournis[0]) > MAX_JOUEURS_MATCHMAKING:
        return jsonify({"error": "Trop de joueurs (max %d)" % MAX_JOUEURS_MATCHMAKING,
                        "code": "trop_de_joueurs"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                joueurs, introuvables = resoudre_joueurs_matchmaking(
                    cur, noms=noms, joueur_ids=joueur_ids, discord_ids=discord_ids,
                )
    except Exception as e:
        logger.error("API bot, matchmaking: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    if len(joueurs) < 2:
        return jsonify({
            "error": "Au moins deux joueurs connus sont necessaires",
            "code": "pas_assez_de_joueurs",
            "introuvables": introuvables,
        }), 400

    lobbies = construire_lobbies(joueurs)
    logger.info("Matchmaking bot « %s » : %d joueurs, %d lobbies",
                getattr(g, 'service_nom', '?'), len(joueurs), len(lobbies))

    return jsonify({
        "lobbies": [{
            "numero": i + 1,
            "joueurs": lobby,
            "moyenne": round(sum(p['ts'] for p in lobby) / len(lobby), 3),
        } for i, lobby in enumerate(lobbies)],
        # Renvoye et non tu : un bot qui passe un pseudo mal orthographie doit
        # pouvoir le dire, plutot que de composer un lobby amoindri en silence.
        "introuvables": introuvables,
    })
