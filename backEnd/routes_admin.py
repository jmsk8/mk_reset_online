from __future__ import annotations

import math
import json
import uuid
import logging
from typing import Any
from datetime import datetime, timedelta

import bcrypt
import trueskill
import psycopg2.extras
from flask import Blueprint, jsonify, request, abort

from constants import (
    DEFAULT_MU, DEFAULT_SIGMA, TRUESKILL_BETA, TRUESKILL_DRAW_PROBABILITY,
    DEFAULT_TAU, DEFAULT_GHOST_PENALTY, DEFAULT_UNRANKED_THRESHOLD, DEFAULT_SIGMA_THRESHOLD,
    GHOST_SIGMA_CAP, GHOST_MISSED_THRESHOLD, TOKEN_LIFETIME_MINUTES,
)
from db import get_db_connection, ADMIN_PASSWORD_HASH
from auth import admin_required
from cache import invalidate_cache
from utils import generate_unique_slug, extract_league_number
from services import (
    recalculate_tiers,
    _aggregate_season_stats, _determine_winners, _save_awards_to_db,
    _apply_inter_league_moves,
)

logger = logging.getLogger(__name__)

admin_bp = Blueprint('admin', __name__)


# -----------------------------------------------------------------------------
# AUTH
# -----------------------------------------------------------------------------

@admin_bp.route('/admin-auth', methods=['POST'])
def admin_auth():
    data = request.get_json()
    password = data.get('password', '')
    password_bytes = password.encode('utf-8')
    try:
        if bcrypt.checkpw(password_bytes, ADMIN_PASSWORD_HASH):
            new_token = str(uuid.uuid4())
            expiration = datetime.now() + timedelta(minutes=TOKEN_LIFETIME_MINUTES)
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM api_tokens WHERE expires_at < NOW()")
                    cur.execute("INSERT INTO api_tokens (token, expires_at) VALUES (%s, %s)", (new_token, expiration))
                conn.commit()
            return jsonify({"status": "success", "token": new_token})
        else:
            return jsonify({"status": "error", "message": "Identifiants invalides"}), 401
    except Exception:
        return jsonify({"status": "error", "message": "Erreur serveur"}), 500


@admin_bp.route('/admin/refresh-token', methods=['POST'])
@admin_required
def refresh_token():
    old_token = request.headers.get('X-Admin-Token')
    new_token = str(uuid.uuid4())
    expiration = datetime.now() + timedelta(minutes=TOKEN_LIFETIME_MINUTES)
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM api_tokens WHERE token = %s", (old_token,))
                cur.execute("INSERT INTO api_tokens (token, expires_at) VALUES (%s, %s)", (new_token, expiration))
            conn.commit()
        return jsonify({"status": "success", "token": new_token})
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@admin_bp.route('/admin-logout', methods=['POST'])
def admin_logout():
    token = request.headers.get('X-Admin-Token', None)
    if token:
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM api_tokens WHERE token = %s", (token,))
                conn.commit()
        except Exception:
            pass
    return jsonify({"status": "success"})


@admin_bp.route('/admin/check-token', methods=['GET'])
@admin_required
def check_token():
    return jsonify({"status": "valid"}), 200


# -----------------------------------------------------------------------------
# FIX DB STRUCTURE
# -----------------------------------------------------------------------------

@admin_bp.route('/api/admin/fix-db-structure', methods=['GET'])
@admin_required
def fix_db_structure():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    ALTER TABLE Tournois
                    ADD COLUMN IF NOT EXISTS ligue_nom VARCHAR(100),
                    ADD COLUMN IF NOT EXISTS ligue_couleur VARCHAR(20);
                """)

                cur.execute("""
                    UPDATE Tournois t
                    SET ligue_nom = l.nom,
                        ligue_couleur = l.couleur
                    FROM Ligues l
                    WHERE t.ligue_id = l.id
                    AND (t.ligue_nom IS NULL OR t.ligue_nom = '');
                """)

            conn.commit()
        return jsonify({"status": "success", "message": "Structure Tournois mise à jour et historique synchronisé."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# -----------------------------------------------------------------------------
# GLOBAL RESET
# -----------------------------------------------------------------------------

@admin_bp.route('/api/admin/global-reset', methods=['POST'])
@admin_required
def apply_global_reset():
    data = request.get_json()
    try:
        val = float(data.get('value', 0))
        date_str = data.get('date')

        if val <= 0:
            return jsonify({"error": "La valeur doit être positive"}), 400

        if not date_str:
            return jsonify({"error": "Une date est requise"}), 400

        try:
            target_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
             return jsonify({"error": "Format de date invalide"}), 400

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM Tournois WHERE date >= %s", (target_date,))
                conflict_count = cur.fetchone()[0]

                if conflict_count > 0:
                    return jsonify({
                        "error": f"Impossible : {conflict_count} tournoi(s) existent à cette date ou après. Le reset invaliderait leurs calculs."
                    }), 409

                cur.execute("UPDATE Joueurs SET sigma = sigma + %s", (val,))

                cur.execute("INSERT INTO global_resets (date, value_applied) VALUES (%s, %s)", (target_date, val))

            conn.commit()
            recalculate_tiers()
            invalidate_cache()

        return jsonify({"status": "success", "message": f"Sigma augmenté de {val} pour tous les joueurs (Date: {date_str})."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@admin_bp.route('/api/admin/revert-global-reset', methods=['POST'])
@admin_required
def revert_global_reset():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, value_applied, date FROM global_resets ORDER BY id DESC LIMIT 1")
                last = cur.fetchone()
                if not last:
                    return jsonify({"error": "Aucun reset à annuler"}), 404

                reset_id, val, reset_date = last

                cur.execute("SELECT COUNT(*) FROM Tournois WHERE date >= %s", (reset_date,))
                conflict_count = cur.fetchone()[0]

                if conflict_count > 0:
                    return jsonify({
                        "error": f"Annulation impossible : {conflict_count} tournoi(s) ont été enregistrés depuis ce reset ({reset_date}). Annuler maintenant fausserait l'historique."
                    }), 409

                cur.execute("UPDATE Joueurs SET sigma = sigma - %s", (val,))
                cur.execute("DELETE FROM global_resets WHERE id = %s", (reset_id,))
            conn.commit()
            recalculate_tiers()
            invalidate_cache()

        return jsonify({"status": "success", "message": "Dernier reset annulé."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# -----------------------------------------------------------------------------
# CONFIG
# -----------------------------------------------------------------------------

@admin_bp.route('/admin/config', methods=['GET'])
@admin_required
def get_config():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT key, value FROM Configuration WHERE key IN ('tau', 'ghost_enabled', 'ghost_penalty', 'unranked_threshold', 'sigma_threshold', 'league_mode_enabled', 'inter_league_moves')")
                rows = dict(cur.fetchall())
        return jsonify({
            "tau": float(rows.get('tau', DEFAULT_TAU)),
            "ghost_enabled": rows.get('ghost_enabled', 'false') == 'true',
            "ghost_penalty": float(rows.get('ghost_penalty', DEFAULT_GHOST_PENALTY)),
            "unranked_threshold": int(rows.get('unranked_threshold', DEFAULT_UNRANKED_THRESHOLD)),
            "sigma_threshold": float(rows.get('sigma_threshold', DEFAULT_SIGMA_THRESHOLD)),
            "league_mode_enabled": rows.get('league_mode_enabled', 'false') == 'true',
            "inter_league_moves": int(rows.get('inter_league_moves', 0))
        })
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@admin_bp.route('/admin/config', methods=['POST'])
@admin_required
def update_config():
    data = request.get_json()
    try:
        tau = float(data.get('tau', DEFAULT_TAU))
        ghost = str(data.get('ghost_enabled', 'false')).lower()
        ghost_penalty = float(data.get('ghost_penalty', DEFAULT_GHOST_PENALTY))
        unranked_threshold = int(data.get('unranked_threshold', DEFAULT_UNRANKED_THRESHOLD))
        sigma_threshold = float(data.get('sigma_threshold', DEFAULT_SIGMA_THRESHOLD))

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                configs = [
                    ('tau', str(tau)),
                    ('ghost_enabled', ghost),
                    ('ghost_penalty', str(ghost_penalty)),
                    ('unranked_threshold', str(unranked_threshold)),
                    ('sigma_threshold', str(sigma_threshold)),
                ]

                if 'league_mode_enabled' in data:
                    league_mode = str(data.get('league_mode_enabled')).lower()
                    configs.append(('league_mode_enabled', league_mode))

                    if league_mode == 'false':
                        cur.execute("UPDATE Joueurs SET ligue_id = NULL")
                        cur.execute("DELETE FROM Ligues")

                if 'inter_league_moves' in data:
                    inter_league_moves = int(data.get('inter_league_moves', 0))
                    configs.append(('inter_league_moves', str(inter_league_moves)))

                for k, v in configs:
                    cur.execute("""
                        INSERT INTO Configuration (key, value)
                        VALUES (%s, %s)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                    """, (k, v))

                cur.execute("""
                    UPDATE Joueurs
                    SET is_ranked = (COALESCE(consecutive_missed, 0) < %s)
                """, (unranked_threshold,))

            conn.commit()
            recalculate_tiers()
            invalidate_cache()

        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# -----------------------------------------------------------------------------
# JOUEURS
# -----------------------------------------------------------------------------

@admin_bp.route('/admin/joueurs', methods=['GET'])
@admin_required
def api_get_joueurs():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT j.id, j.nom, j.mu, j.sigma, j.tier, j.is_ranked, j.consecutive_missed, j.color,
                           l.id, l.nom, l.couleur
                    FROM Joueurs j
                    LEFT JOIN Ligues l ON j.ligue_id = l.id
                    ORDER BY j.nom ASC
                """)
                joueurs = [{
                    "id": r[0],
                    "nom": r[1],
                    "mu": r[2],
                    "sigma": r[3],
                    "tier": r[4].strip() if r[4] else "?",
                    "is_ranked": r[5],
                    "consecutive_missed": r[6] if r[6] is not None else 0,
                    "color": r[7] if r[7] else "#FFFFFF",
                    "ligue": { "id": r[8], "nom": r[9], "couleur": r[10] } if r[8] else None
                } for r in cur.fetchall()]
        return jsonify(joueurs)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@admin_bp.route('/admin/joueurs/<int:id>', methods=['PUT'])
@admin_required
def api_update_joueur(id):
    data = request.get_json()
    try:
        mu, sigma, nom = float(data['mu']), float(data['sigma']), data['nom']
        is_ranked = bool(data.get('is_ranked', True))
        consecutive_missed = int(data.get('consecutive_missed', 0))
        color = data.get('color', '#FFFFFF')

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE Joueurs SET nom=%s, mu=%s, sigma=%s, is_ranked=%s, consecutive_missed=%s, color=%s WHERE id=%s", (nom, mu, sigma, is_ranked, consecutive_missed, color, id))
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@admin_bp.route('/admin/joueurs/<int:id>', methods=['DELETE'])
@admin_required
def api_delete_joueur(id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM Joueurs WHERE id=%s", (id,))
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        return jsonify({"status": "success"})
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 400


@admin_bp.route('/admin/joueurs', methods=['POST'])
@admin_required
def api_add_joueur():
    data = request.get_json()
    try:
        nom = data.get('nom')
        mu = float(data.get('mu', DEFAULT_MU))
        sigma = float(data.get('sigma', DEFAULT_SIGMA))
        color = data.get('color', '#FFFFFF')

        if not nom:
            return jsonify({"error": "Le nom du joueur est requis"}), 400

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM Joueurs WHERE nom = %s", (nom,))
                if cur.fetchone():
                    return jsonify({"error": "Ce nom de joueur existe déjà"}), 409

                cur.execute(
                    """INSERT INTO Joueurs (nom, mu, sigma, tier, is_ranked, consecutive_missed, color)
                       VALUES (%s, %s, %s, 'U', true, 0, %s)""",
                    (nom, mu, sigma, color)
                )
            conn.commit()

            recalculate_tiers()
            invalidate_cache()

        return jsonify({"status": "success", "message": "Joueur ajouté"}), 201
    except ValueError:
        return jsonify({"error": "Valeurs numériques invalides pour Mu ou Sigma"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# -----------------------------------------------------------------------------
# TYPES AWARDS
# -----------------------------------------------------------------------------

@admin_bp.route('/admin/types-awards', methods=['GET'])
@admin_required
def get_admin_award_types():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT code, nom, emoji, description FROM types_awards WHERE code NOT LIKE %s AND code != 'grand_master' ORDER BY nom ASC", ('%moai',))
                awards = [{"code": r[0], "nom": r[1], "emoji": r[2], "description": r[3]} for r in cur.fetchall()]
        return jsonify(awards)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# -----------------------------------------------------------------------------
# SAISONS
# -----------------------------------------------------------------------------

@admin_bp.route('/admin/saisons', methods=['GET', 'POST'])
@admin_required
def admin_saisons():
    if request.method == 'GET':
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, nom, date_debut, date_fin, slug, config_awards, is_active,
                           victory_condition, is_yearly, ligue_id, ligue_nom, ligue_couleur, is_league_recap
                    FROM saisons ORDER BY date_fin DESC, ligue_id ASC NULLS FIRST
                """)
                saisons = []
                for r in cur.fetchall():
                    saisons.append({
                        "id": r[0], "nom": r[1], "date_debut": str(r[2]), "date_fin": str(r[3]),
                        "slug": r[4], "config": r[5] if r[5] else {}, "is_active": r[6],
                        "victory_condition": r[7], "is_yearly": r[8],
                        "ligue_id": r[9], "ligue_nom": r[10], "ligue_couleur": r[11],
                        "is_league_recap": r[12] if r[12] else False
                    })
        return jsonify(saisons)

    if request.method == 'POST':
        data = request.get_json()
        nom, d_debut, d_fin = data.get('nom'), data.get('date_debut'), data.get('date_fin')
        victory_cond = data.get('victory_condition')
        is_yearly = bool(data.get('is_yearly', False))
        recap_mode = data.get('recap_mode', 'classic')
        config_json = json.dumps({"active_awards": data.get('active_awards', [])})

        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    if recap_mode == 'league':
                        cur.execute("SELECT id, nom, couleur FROM Ligues ORDER BY niveau ASC")
                        ligues = cur.fetchall()

                        if not ligues:
                            return jsonify({"error": "Aucune ligue configurée. Créez d'abord des ligues."}), 400

                        cur.execute("""
                            SELECT COUNT(*) FROM Tournois
                            WHERE date >= %s AND date <= %s AND ligue_id IS NOT NULL
                        """, (d_debut, d_fin))
                        league_count = cur.fetchone()[0]

                        if league_count == 0:
                            return jsonify({"error": "Aucun tournoi en mode ligue pendant cette période."}), 400

                        slug = generate_unique_slug(cur, nom)

                        cur.execute(
                            """INSERT INTO saisons (nom, slug, date_debut, date_fin, config_awards, is_active,
                               victory_condition, is_yearly, is_league_recap)
                               VALUES (%s, %s, %s, %s, %s, false, %s, %s, true)""",
                            (nom, slug, d_debut, d_fin, config_json, victory_cond, is_yearly)
                        )

                        conn.commit()
                        return jsonify({
                            "status": "success",
                            "message": "Récap de ligue unifié créé en brouillon."
                        })
                    else:
                        slug = generate_unique_slug(cur, nom)

                        cur.execute(
                            """INSERT INTO saisons (nom, slug, date_debut, date_fin, config_awards, is_active, victory_condition, is_yearly)
                               VALUES (%s, %s, %s, %s, %s, false, %s, %s) RETURNING id""",
                            (nom, slug, d_debut, d_fin, config_json, victory_cond, is_yearly)
                        )
                        conn.commit()
                        return jsonify({"status": "success"})
        except Exception as e:
            return jsonify({"error": str(e)}), 400


@admin_bp.route('/admin/saisons/<int:saison_id>', methods=['DELETE'])
@admin_required
def delete_saison(saison_id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT is_league_recap FROM saisons WHERE id = %s", (saison_id,))
                row = cur.fetchone()
                if not row:
                    return jsonify({"error": "Saison introuvable"}), 404

                is_league_recap = row[0]
                rollback_warnings = []

                if is_league_recap:
                    cur.execute("""
                        SELECT joueur_id, from_ligue_id, from_ligue_nom, created_at
                        FROM league_movements
                        WHERE saison_id = %s
                    """, (saison_id,))
                    movements = cur.fetchall()

                    for joueur_id, from_ligue_id, from_ligue_nom, created_at in movements:
                        cur.execute("""
                            SELECT 1 FROM league_movements
                            WHERE joueur_id = %s AND created_at > %s AND saison_id != %s
                            LIMIT 1
                        """, (joueur_id, created_at, saison_id))
                        has_later_move = cur.fetchone()

                        if has_later_move:
                            rollback_warnings.append(f"{joueur_id}: mouvement postérieur, non restauré")
                            continue

                        if from_ligue_id is None:
                            rollback_warnings.append(f"{from_ligue_nom}: ligue supprimée, impossible de restaurer")
                            continue

                        cur.execute("SELECT id FROM ligues WHERE id = %s", (from_ligue_id,))
                        if not cur.fetchone():
                            rollback_warnings.append(f"{from_ligue_nom}: ligue supprimée, impossible de restaurer")
                            continue

                        cur.execute("UPDATE joueurs SET ligue_id = %s WHERE id = %s", (from_ligue_id, joueur_id))

                cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s", (saison_id,))
                cur.execute("DELETE FROM saisons WHERE id = %s", (saison_id,))
            conn.commit()
            invalidate_cache()

        response = {"status": "success"}
        if rollback_warnings:
            response["warnings"] = rollback_warnings
        return jsonify(response)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@admin_bp.route('/admin/saisons/<int:id>/count-tournois', methods=['GET'])
@admin_required
def count_tournois_by_mode(id):
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT date_debut, date_fin FROM saisons WHERE id = %s", (id,))
            row = cur.fetchone()
            if not row:
                return jsonify({'error': 'Saison introuvable'}), 404

            d_debut, d_fin = row

            cur.execute("""
                SELECT COUNT(*) FROM Tournois
                WHERE date >= %s AND date <= %s AND ligue_id IS NOT NULL
            """, (d_debut, d_fin))
            league_count = cur.fetchone()[0]

            cur.execute("""
                SELECT COUNT(*) FROM Tournois
                WHERE date >= %s AND date <= %s AND ligue_id IS NULL
            """, (d_debut, d_fin))
            classic_count = cur.fetchone()[0]

    return jsonify({
        'league_count': league_count,
        'classic_count': classic_count
    })


@admin_bp.route('/admin/saisons/<int:id>/save-awards', methods=['POST'])
@admin_required
def save_season_awards(id):
    data = request.get_json() or {}
    move_criterion = data.get('move_criterion')

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT date_debut, date_fin, config_awards, victory_condition, is_yearly, ligue_id, is_league_recap
                FROM saisons WHERE id = %s
            """, (id,))
            row = cur.fetchone()
            if not row: return jsonify({'error': 'Saison introuvable'}), 404

            d_debut, d_fin, config, vic_cond, is_yearly, saison_ligue_id, is_league_recap = row
            active_awards = config.get('active_awards', [])
            movements = []

            if is_league_recap:
                cur.execute("""
                    SELECT DISTINCT l.id, l.nom, l.niveau, l.couleur
                    FROM Ligues l
                    JOIN Tournois t ON t.ligue_id = l.id
                    WHERE t.date >= %s AND t.date <= %s
                    ORDER BY l.niveau ASC
                """, (d_debut, d_fin))
                ligues_rows = cur.fetchall()
                ligues = [(r[0], r[1], r[3]) for r in ligues_rows]

                if not ligues:
                    return jsonify({'error': 'Aucun tournoi de ligue pendant cette période'}), 400

                all_rankings = {}

                cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s", (id,))
                conn.commit()

                for ligue_id, ligue_nom, ligue_couleur in ligues:
                    ligue_stats = _aggregate_season_stats(d_debut, d_fin, 'league', ligue_id)

                    gm_list = ligue_stats['candidates'].get('grand_master', [])
                    gm_sorted = sorted(gm_list, key=lambda x: x.get('final_score', 0), reverse=True)
                    all_rankings[ligue_id] = {p['id']: rank for rank, p in enumerate(gm_sorted, 1)}

                    top_3, winners_map = _determine_winners(
                        ligue_stats['candidates'], vic_cond, active_awards, ligue_stats['total_tournois']
                    )
                    ligue_info = {'id': ligue_id, 'nom': ligue_nom, 'couleur': ligue_couleur}
                    _save_awards_to_db(conn, id, top_3, winners_map, is_yearly, ligue_info=ligue_info)

                if move_criterion:
                    cur.execute("SELECT value FROM Configuration WHERE key = 'league_mode_enabled'")
                    league_row = cur.fetchone()
                    league_enabled = (league_row[0] == 'true') if league_row else False

                    cur.execute("SELECT value FROM Configuration WHERE key = 'inter_league_moves'")
                    moves_row = cur.fetchone()
                    moves_count = int(moves_row[0]) if moves_row else 0

                    if league_enabled and moves_count > 0:
                        if move_criterion == "ip":
                            movements = _apply_inter_league_moves(conn, moves_count, {}, rankings_by_ligue=all_rankings)
                        else:
                            cur.execute("SELECT id, score_trueskill FROM Joueurs WHERE ligue_id IS NOT NULL ORDER BY score_trueskill DESC")
                            ranking_data = {r[0]: rank for rank, r in enumerate(cur.fetchall(), 1)}
                            movements = _apply_inter_league_moves(conn, moves_count, ranking_data)

                        for m in movements:
                            cur.execute("SELECT id FROM Ligues WHERE nom = %s", (m['from'],))
                            from_row = cur.fetchone()
                            from_ligue_id = from_row[0] if from_row else None

                            cur.execute("SELECT id FROM Ligues WHERE nom = %s", (m['to'],))
                            to_row = cur.fetchone()
                            to_ligue_id = to_row[0] if to_row else None

                            cur.execute("""
                                INSERT INTO league_movements (saison_id, joueur_id, from_ligue_id, to_ligue_id,
                                    from_ligue_nom, to_ligue_nom, direction)
                                VALUES (%s, %s, %s, %s, %s, %s, %s)
                            """, (id, m['joueur_id'], from_ligue_id, to_ligue_id, m['from'], m['to'], m['direction']))

                cur.execute("UPDATE saisons SET is_active = true WHERE id = %s", (id,))

            elif saison_ligue_id:
                cur.execute("""
                    SELECT COUNT(*) FROM Tournois
                    WHERE date >= %s AND date <= %s AND ligue_id = %s
                """, (d_debut, d_fin, saison_ligue_id))
                count = cur.fetchone()[0]
                if count == 0:
                    return jsonify({'error': 'Aucun tournoi pour cette ligue pendant cette période'}), 400
                global_stats = _aggregate_season_stats(d_debut, d_fin, 'league', saison_ligue_id)

                top_3, winners_map = _determine_winners(
                    global_stats['candidates'], vic_cond, active_awards, global_stats['total_tournois']
                )
                _save_awards_to_db(conn, id, top_3, winners_map, is_yearly)

                if move_criterion:
                    cur.execute("SELECT value FROM Configuration WHERE key = 'league_mode_enabled'")
                    league_row = cur.fetchone()
                    league_enabled = (league_row[0] == 'true') if league_row else False

                    cur.execute("SELECT value FROM Configuration WHERE key = 'inter_league_moves'")
                    moves_row = cur.fetchone()
                    moves_count = int(moves_row[0]) if moves_row else 0

                    if league_enabled and moves_count > 0:
                        if move_criterion == "ip":
                            gm_list = global_stats['candidates'].get('grand_master', [])
                            gm_sorted = sorted(gm_list, key=lambda x: x.get('final_score', 0), reverse=True)
                            ranking_data = {p['id']: rank for rank, p in enumerate(gm_sorted, 1)}
                        else:
                            cur.execute("SELECT id, score_trueskill FROM Joueurs WHERE ligue_id IS NOT NULL ORDER BY score_trueskill DESC")
                            ranking_data = {r[0]: rank for rank, r in enumerate(cur.fetchall(), 1)}
                        movements = _apply_inter_league_moves(conn, moves_count, ranking_data)
            else:
                cur.execute("""
                    SELECT COUNT(*) FROM Tournois
                    WHERE date >= %s AND date <= %s AND ligue_id IS NULL
                """, (d_debut, d_fin))
                count = cur.fetchone()[0]
                if count == 0:
                    return jsonify({'error': 'Aucun tournoi en mode classique pendant cette période'}), 400
                global_stats = _aggregate_season_stats(d_debut, d_fin, 'classic')

                top_3, winners_map = _determine_winners(
                    global_stats['candidates'], vic_cond, active_awards, global_stats['total_tournois']
                )
                _save_awards_to_db(conn, id, top_3, winners_map, is_yearly)

        conn.commit()
        invalidate_cache()

    response = {'status': 'success', 'message': 'Saison publiée et awards distribués !'}
    if movements:
        response['movements'] = movements
        response['message'] += f' {len(movements)} mouvements inter-ligue effectués.'

    return jsonify(response)


# -----------------------------------------------------------------------------
# TOURNOIS
# -----------------------------------------------------------------------------

@admin_bp.route('/add-tournament', methods=['POST'])
@admin_required
def add_tournament():
    data = request.get_json()
    date_tournoi_str = data.get('date')
    joueurs_data = data.get('joueurs')
    ligue_id = data.get('ligue_id')

    if not date_tournoi_str or not joueurs_data:
        return jsonify({"error": "Données incomplètes"}), 400

    try:
        date_tournoi = datetime.strptime(date_tournoi_str, '%Y-%m-%d').date()
        if date_tournoi > datetime.now().date():
            return jsonify({"error": "Impossible d'ajouter un tournoi dans le futur."}), 400

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM global_resets WHERE date >= %s", (date_tournoi,))
                conflict = cur.fetchone()[0]
                if conflict > 0:
                    return jsonify({"error": "Conflit avec un Reset Global."}), 409

                cur.execute("SELECT value FROM Configuration WHERE key = 'league_mode_enabled'")
                res = cur.fetchone()
                is_league_mode = (res[0] == 'true') if res else False

                is_mixte = (str(ligue_id).lower() == 'mixte') if ligue_id else False

                if is_league_mode and not ligue_id:
                    return jsonify({"error": "Le mode Ligue est activé, veuillez sélectionner une ligue."}), 400

                ligue_nom_archive = None
                ligue_couleur_archive = None

                if is_mixte:
                    ligue_id = None
                    ligue_nom_archive = 'Mixte'
                    ligue_couleur_archive = '#888888'
                elif ligue_id:
                    cur.execute("SELECT nom, couleur FROM Ligues WHERE id = %s", (ligue_id,))
                    res_ligue = cur.fetchone()
                    if res_ligue:
                        ligue_nom_archive = res_ligue[0]
                        ligue_couleur_archive = res_ligue[1]

                cur.execute("""
                    INSERT INTO Tournois (date, ligue_id, ligue_nom, ligue_couleur)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id
                """, (date_tournoi_str, ligue_id, ligue_nom_archive, ligue_couleur_archive))
                tournoi_id = cur.fetchone()[0]

                joueurs_ratings = {}
                joueurs_ids_map = {}
                joueurs_exclude_ts = {}

                for joueur in joueurs_data:
                    nom, score = joueur['nom'], joueur['score']
                    exclude_ts = joueur.get('exclude_from_ts', False)
                    cur.execute("SELECT id, mu, sigma FROM Joueurs WHERE nom = %s", (nom,))
                    res = cur.fetchone()
                    if res:
                        jid, mu, sigma = res
                    else:
                        cur.execute("INSERT INTO Joueurs (nom, mu, sigma, tier, is_ranked) VALUES (%s, %s, %s, 'U', true) RETURNING id", (nom, DEFAULT_MU, DEFAULT_SIGMA))
                        jid, mu, sigma = cur.fetchone()[0], DEFAULT_MU, DEFAULT_SIGMA
                    joueurs_ratings[nom] = trueskill.Rating(mu=float(mu), sigma=float(sigma))
                    joueurs_ids_map[nom] = jid
                    joueurs_exclude_ts[nom] = exclude_ts
                    cur.execute("INSERT INTO Participations (tournoi_id, joueur_id, score, old_mu, old_sigma, exclude_from_ts) VALUES (%s, %s, %s, %s, %s, %s)", (tournoi_id, jid, score, float(mu), float(sigma), exclude_ts))

                sorted_joueurs = sorted(joueurs_data, key=lambda x: x['score'], reverse=True)

                ts_joueurs = [j for j in sorted_joueurs if not joueurs_exclude_ts.get(j['nom'], False)]
                ts_ranks = []
                last_s, rank = -1, 1
                for i, j in enumerate(ts_joueurs):
                    if j['score'] < last_s: rank = i + 1
                    ts_ranks.append(rank)
                    last_s = j['score']

                cur.execute("SELECT value FROM Configuration WHERE key = 'tau'")
                tau_val = float(cur.fetchone()[0])
                ts_env = trueskill.TrueSkill(mu=DEFAULT_MU, sigma=DEFAULT_SIGMA, beta=TRUESKILL_BETA, tau=tau_val, draw_probability=TRUESKILL_DRAW_PROBABILITY)

                new_ratings_map = {}
                if ts_joueurs:
                    new_ratings = ts_env.rate([[joueurs_ratings[j['nom']]] for j in ts_joueurs], ranks=ts_ranks)
                    for i, j in enumerate(ts_joueurs):
                        new_ratings_map[j['nom']] = new_ratings[i][0]

                present_pids = []
                all_ranks = []
                last_s, rank = -1, 1
                for i, j in enumerate(sorted_joueurs):
                    if j['score'] < last_s: rank = i + 1
                    all_ranks.append(rank)
                    last_s = j['score']

                joueur_updates = []
                participation_updates = []

                for i, j in enumerate(sorted_joueurs):
                    nom = j['nom']
                    jid = joueurs_ids_map[nom]
                    present_pids.append(jid)

                    if joueurs_exclude_ts.get(nom, False):
                        old_rating = joueurs_ratings[nom]
                        joueur_updates.append((jid, old_rating.mu, old_rating.sigma, 0, True))
                        participation_updates.append((tournoi_id, jid, old_rating.mu, old_rating.sigma, old_rating.mu - 3 * old_rating.sigma, all_ranks[i]))
                    else:
                        nr = new_ratings_map[nom]
                        joueur_updates.append((jid, nr.mu, nr.sigma, 0, True))
                        participation_updates.append((tournoi_id, jid, nr.mu, nr.sigma, nr.mu - 3 * nr.sigma, all_ranks[i]))

                if joueur_updates:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET mu = data.mu, sigma = data.sigma, consecutive_missed = data.missed, is_ranked = data.ranked
                        FROM (VALUES %s) AS data(id, mu, sigma, missed, ranked)
                        WHERE j.id = data.id
                    """, joueur_updates)

                if participation_updates:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Participations AS p SET mu = data.mu, sigma = data.sigma, new_score_trueskill = data.ts, position = data.pos
                        FROM (VALUES %s) AS data(tid, jid, mu, sigma, ts, pos)
                        WHERE p.tournoi_id = data.tid AND p.joueur_id = data.jid
                    """, participation_updates)

                cur.execute("SELECT key, value FROM Configuration WHERE key IN ('ghost_enabled', 'ghost_penalty', 'unranked_threshold')")
                conf = dict(cur.fetchall())
                ghost_enabled = (conf.get('ghost_enabled') == 'true')
                penalty_val = float(conf.get('ghost_penalty', DEFAULT_GHOST_PENALTY))
                unranked_limit = int(conf.get('unranked_threshold', DEFAULT_UNRANKED_THRESHOLD))

                not_in_clause = f"id NOT IN ({','.join(['%s']*len(present_pids))})" if present_pids else "TRUE"
                abs_params = list(present_pids)

                if is_league_mode and ligue_id:
                    cur.execute("SELECT id FROM Ligues ORDER BY niveau DESC LIMIT 1")
                    lowest_ligue_row = cur.fetchone()
                    lowest_ligue_id = lowest_ligue_row[0] if lowest_ligue_row else None

                    if lowest_ligue_id and int(ligue_id) == lowest_ligue_id:
                        query_absents = f"SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs WHERE {not_in_clause} AND (ligue_id = %s OR ligue_id IS NULL)"
                    else:
                        query_absents = f"SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs WHERE {not_in_clause} AND ligue_id = %s"
                    abs_params.append(int(ligue_id))
                else:
                    query_absents = f"SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs WHERE {not_in_clause}"

                cur.execute(query_absents, tuple(abs_params))
                absents = cur.fetchall()

                ghost_inserts = []
                absent_updates = []
                for pid, sig, missed, is_r in absents:
                    new_missed = (missed or 0) + 1
                    new_sig = float(sig)
                    if ghost_enabled and new_missed >= GHOST_MISSED_THRESHOLD and new_sig < GHOST_SIGMA_CAP:
                        new_sig += penalty_val
                        ghost_inserts.append((pid, tournoi_id, date_tournoi_str, sig, new_sig, penalty_val))
                    new_is_ranked = is_r
                    if new_missed >= unranked_limit: new_is_ranked = False
                    absent_updates.append((pid, new_sig, new_missed, new_is_ranked))

                if ghost_inserts:
                    psycopg2.extras.execute_values(cur, """
                        INSERT INTO ghost_log (joueur_id, tournoi_id, date, old_sigma, new_sigma, penalty_applied)
                        VALUES %s
                    """, ghost_inserts)
                if absent_updates:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET sigma = data.sigma, consecutive_missed = data.missed, is_ranked = data.ranked
                        FROM (VALUES %s) AS data(id, sigma, missed, ranked)
                        WHERE j.id = data.id
                    """, absent_updates)

            conn.commit()
            recalculate_tiers()
            invalidate_cache()

            return jsonify({"status": "success", "tournoi_id": tournoi_id}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@admin_bp.route('/api/admin/revert-last-tournament', methods=['POST'])
@admin_required
def revert_last_tournament():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, date FROM Tournois ORDER BY date DESC, id DESC LIMIT 1")
                last = cur.fetchone()
                if not last: return jsonify({"message": "Aucun tournoi à annuler."}), 404
                tid = last[0]

                cur.execute("SELECT joueur_id, old_mu, old_sigma FROM Participations WHERE tournoi_id = %s", (tid,))
                participants = cur.fetchall()
                for jid, mu, sig in participants:
                    if mu is None: return jsonify({"status": "error", "message": "Trop ancien"}), 400

                if participants:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET mu = data.mu, sigma = data.sigma
                        FROM (VALUES %s) AS data(id, mu, sigma)
                        WHERE j.id = data.id
                    """, [(jid, mu, sig) for jid, mu, sig in participants])

                cur.execute("SELECT joueur_id, old_sigma FROM ghost_log WHERE tournoi_id = %s", (tid,))
                ghost_rows = cur.fetchall()
                if ghost_rows:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET sigma = data.sigma
                        FROM (VALUES %s) AS data(id, sigma)
                        WHERE j.id = data.id
                    """, [(jid, sig) for jid, sig in ghost_rows])

                cur.execute("UPDATE Joueurs SET consecutive_missed = GREATEST(0, consecutive_missed - 1)")
                cur.execute("DELETE FROM ghost_log WHERE tournoi_id = %s", (tid,))
                cur.execute("DELETE FROM Participations WHERE tournoi_id = %s", (tid,))
                cur.execute("DELETE FROM Tournois WHERE id = %s", (tid,))
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
            return jsonify({"status": "success", "message": "Annulé."}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@admin_bp.route('/delete-tournament/<int:id>', methods=['DELETE'])
@admin_required
def delete_tournament(id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
                res = cur.fetchone()
                threshold = int(res[0]) if res else DEFAULT_UNRANKED_THRESHOLD

                cur.execute("SELECT joueur_id, old_sigma FROM ghost_log WHERE tournoi_id = %s", (id,))
                ghost_rows = cur.fetchall()
                if ghost_rows:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET sigma = data.sigma
                        FROM (VALUES %s) AS data(id, sigma)
                        WHERE j.id = data.id
                    """, [(pid, old_sig) for pid, old_sig in ghost_rows])

                cur.execute("SELECT joueur_id FROM Participations WHERE tournoi_id = %s", (id,))
                parts = [r[0] for r in cur.fetchall()]
                q_abs = f"SELECT id, consecutive_missed, is_ranked FROM Joueurs WHERE id NOT IN ({','.join(['%s']*len(parts))})" if parts else "SELECT id, consecutive_missed, is_ranked FROM Joueurs"
                cur.execute(q_abs, tuple(parts))

                batch_updates = []
                for pid, missed, is_r in cur.fetchall():
                    if missed and missed > 0:
                        new_m = missed - 1
                        new_r = True if (not is_r and new_m < threshold) else is_r
                        batch_updates.append((pid, new_m, new_r))
                if batch_updates:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET consecutive_missed = data.missed, is_ranked = data.ranked
                        FROM (VALUES %s) AS data(id, missed, ranked)
                        WHERE j.id = data.id
                    """, batch_updates)

                cur.execute("DELETE FROM Tournois WHERE id = %s", (id,))
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# -----------------------------------------------------------------------------
# LIGUES
# -----------------------------------------------------------------------------

@admin_bp.route('/admin/ligues/setup', methods=['POST'])
@admin_required
def setup_ligues():
    data = request.get_json()
    ligues_data = data.get('ligues', [])

    if not ligues_data:
        return jsonify({"error": "Aucune donnée de ligue reçue"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE Configuration SET value = 'true' WHERE key = 'league_mode_enabled'")

                cur.execute("SELECT id FROM Ligues")
                existing_ids = set(row[0] for row in cur.fetchall())

                ids_in_use = set()
                all_assigned_players = []

                for l_data in ligues_data:
                    nom = l_data.get('nom', '')
                    couleur = l_data.get('couleur', '#FFFFFF')
                    joueurs_ids = l_data.get('joueurs_ids', [])

                    ligue_num = extract_league_number(nom)
                    if ligue_num is None or ligue_num < 0 or ligue_num > 9:
                        continue

                    ligue_id = ligue_num + 1
                    ids_in_use.add(ligue_id)

                    if ligue_id in existing_ids:
                        cur.execute(
                            "UPDATE Ligues SET nom = %s, couleur = %s, niveau = %s WHERE id = %s",
                            (nom, couleur, ligue_num, ligue_id)
                        )
                    else:
                        cur.execute(
                            "INSERT INTO Ligues (id, nom, couleur, niveau) VALUES (%s, %s, %s, %s)",
                            (ligue_id, nom, couleur, ligue_num)
                        )

                    if joueurs_ids:
                        placeholders = ",".join(["%s"] * len(joueurs_ids))
                        cur.execute(f"UPDATE Joueurs SET ligue_id = %s WHERE id IN ({placeholders})", (ligue_id, *joueurs_ids))
                        all_assigned_players.extend(joueurs_ids)

                ids_to_remove = existing_ids - ids_in_use
                if ids_to_remove:
                    placeholders = ",".join(["%s"] * len(ids_to_remove))
                    cur.execute(f"UPDATE Joueurs SET ligue_id = NULL WHERE ligue_id IN ({placeholders})", tuple(ids_to_remove))
                    cur.execute(f"DELETE FROM Ligues WHERE id IN ({placeholders})", tuple(ids_to_remove))

                if all_assigned_players:
                    placeholders = ",".join(["%s"] * len(all_assigned_players))
                    cur.execute(f"UPDATE Joueurs SET ligue_id = NULL WHERE id NOT IN ({placeholders})", tuple(all_assigned_players))
                else:
                    cur.execute("UPDATE Joueurs SET ligue_id = NULL")

            conn.commit()
            return jsonify({"status": "success", "message": "Configuration des ligues sauvegardée"})

    except Exception as e:
        logger.error(f"Erreur setup_ligues: {e}")
        return jsonify({"error": str(e)}), 500


@admin_bp.route('/admin/ligues/draft-simulation', methods=['GET'])
@admin_required
def draft_simulation():
    force_reset = request.args.get('force_reset') == 'true'

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:

                cur.execute("SELECT COUNT(*) FROM Ligues")
                count_ligues = cur.fetchone()[0]

                if count_ligues > 0 and not force_reset:
                    cur.execute("""
                        SELECT l.id, l.nom, l.niveau, l.couleur,
                               j.id, j.nom, j.score_trueskill
                        FROM Ligues l
                        LEFT JOIN Joueurs j ON j.ligue_id = l.id
                        ORDER BY l.niveau ASC, j.score_trueskill DESC NULLS LAST
                    """)
                    rows = cur.fetchall()

                    draft_ligues = []
                    ligues_map = {}
                    ligues_order = []
                    for lid, lnom, lniv, lcoul, jid, jnom, jscore in rows:
                        if lid not in ligues_map:
                            ligues_map[lid] = {"nom": lnom, "couleur": lcoul, "joueurs": []}
                            ligues_order.append(lid)
                        if jid:
                            ligues_map[lid]["joueurs"].append({"id": jid, "nom": jnom, "score": float(jscore) if jscore else 0.0})
                    draft_ligues = [ligues_map[lid] for lid in ligues_order]

                    cur.execute("SELECT id, nom, score_trueskill FROM Joueurs WHERE ligue_id IS NULL ORDER BY score_trueskill DESC NULLS LAST")
                    unassigned = [{"id": r[0], "nom": r[1], "score": float(r[2]) if r[2] else 0.0} for r in cur.fetchall()]

                    return jsonify({
                        "mode": "edition",
                        "ligues": draft_ligues,
                        "unassigned": unassigned
                    })

                else:
                    cur.execute("""
                        SELECT id, nom, score_trueskill
                        FROM Joueurs
                        WHERE is_ranked = true
                        ORDER BY score_trueskill DESC NULLS LAST
                    """)
                    ranked_players = [{"id": r[0], "nom": r[1], "score": float(r[2]) if r[2] else 0.0} for r in cur.fetchall()]

                    cur.execute("""
                        SELECT id, nom, score_trueskill
                        FROM Joueurs
                        WHERE is_ranked = false
                        ORDER BY score_trueskill DESC NULLS LAST
                    """)
                    unranked_players = [{"id": r[0], "nom": r[1], "score": float(r[2]) if r[2] else 0.0} for r in cur.fetchall()]

                    draft = []
                    total = len(ranked_players)
                    colors = ["#FFD700", "#C0C0C0", "#CD7F32", "#48C9B0", "#9B59B6"]

                    if total > 0:
                        nb_ligues = max(1, min(math.ceil(total / 8), 5))
                        chunk = math.ceil(total / nb_ligues)

                        for i in range(nb_ligues):
                            start = i * chunk
                            end = min(start + chunk, total)
                            if start < total:
                                col = colors[i] if i < len(colors) else "#FFFFFF"
                                draft.append({"nom": f"Ligue {i}", "couleur": col, "joueurs": ranked_players[start:end]})

                    return jsonify({
                        "mode": "creation",
                        "ligues": draft,
                        "unassigned": unranked_players
                    })

    except Exception as e:
        return jsonify({"error": str(e)}), 500
