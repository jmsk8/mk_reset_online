import os
import sys
import math
import logging
import functools
import psycopg2
import bcrypt
import subprocess
import trueskill
import statistics
import uuid
import re
import json
import unicodedata
from datetime import datetime, timedelta, date
from flask import Flask, jsonify, request, abort, render_template
from psycopg2 import pool
from contextlib import contextmanager

# -----------------------------------------------------------------------------
# CONFIGURATION & INITIALISATION
# -----------------------------------------------------------------------------

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

try:
    POSTGRES_DB = os.environ['POSTGRES_DB']
    POSTGRES_USER = os.environ['POSTGRES_USER']
    POSTGRES_PASSWORD = os.environ.get('POSTGRES_PASSWORD', '')
    POSTGRES_HOST = os.environ.get('POSTGRES_HOST', '')
    POSTGRES_PORT = os.environ.get('POSTGRES_PORT', '5432')
    ADMIN_PASSWORD_HASH_STR = os.environ['ADMIN_PASSWORD_HASH']
    ADMIN_PASSWORD_HASH = ADMIN_PASSWORD_HASH_STR.encode('utf-8')
except KeyError as e:
    sys.exit(1)

try:
    db_pool = psycopg2.pool.SimpleConnectionPool(
        1, 20,
        user=POSTGRES_USER,
        password=POSTGRES_PASSWORD,
        host=POSTGRES_HOST,
        port=POSTGRES_PORT,
        database=POSTGRES_DB
    )
except (Exception, psycopg2.DatabaseError) as error:
    sys.exit(1)

# -----------------------------------------------------------------------------
# UTILITAIRES BASE DE DONNÉES & AUTH
# -----------------------------------------------------------------------------

@contextmanager
def get_db_connection():
    conn = db_pool.getconn()
    try:
        yield conn
    finally:
        db_pool.putconn(conn)

def slugify(value):
    value = str(value)
    value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode('ascii')
    value = re.sub(r'[^\w\s-]', '', value).strip().lower()
    value = re.sub(r'[-\s]+', '-', value)
    return value

def admin_required(f):
    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        token = request.headers.get('X-Admin-Token', None)
        if not token:
            abort(403)
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT expires_at FROM api_tokens WHERE token = %s", (token,))
                    res = cur.fetchone()
                    if not res:
                        abort(403)
                    expires_at = res[0]
                    if datetime.now() > expires_at:
                        cur.execute("DELETE FROM api_tokens WHERE token = %s", (token,))
                        conn.commit()
                        abort(403)
        except Exception:
            abort(500)
        return f(*args, **kwargs)
    return decorated_function

# -----------------------------------------------------------------------------
# LOGIQUE MÉTIER : SYNC & TIERS
# -----------------------------------------------------------------------------

def sync_sequences():
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            tables = ['Joueurs', 'Tournois', 'saisons', 'types_awards', 'awards_obtenus']
            for table in tables:
                try:
                    seq_name = f"public.{table.lower()}_id_seq"
                    query = f"SELECT setval('{seq_name}', (SELECT MAX(id) FROM public.{table}))"
                    cur.execute(query)
                except Exception:
                    conn.rollback()
        conn.commit()


def extract_league_number(nom):
    match = re.search(r'(\d+)', nom)
    if match:
        return int(match.group(1))
    return None


def recalculate_tiers():
    with get_db_connection() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'sigma_threshold'")
                res = cur.fetchone()
                threshold = float(res[0]) if res else 4.0

                cur.execute("SELECT id, mu, sigma, is_ranked FROM Joueurs")
                all_players = cur.fetchall()
                
                valid_scores = []
                for pid, mu, sigma, is_ranked in all_players:
                    if is_ranked and float(sigma) <= threshold:
                        score = float(mu) - (3 * float(sigma))
                        valid_scores.append(score)
                        
                if len(valid_scores) < 2:
                    mean_score = 0
                    std_dev = 1
                else:
                    mean_score = sum(valid_scores) / len(valid_scores)
                    variance = sum((x - mean_score) ** 2 for x in valid_scores) / len(valid_scores)
                    std_dev = math.sqrt(variance)

                for pid, mu, sigma, is_ranked in all_players:
                    mu_val = float(mu)
                    sigma_val = float(sigma)
                    score = mu_val - (3 * sigma_val)
                    
                    new_tier = 'U'
                    
                    if is_ranked and sigma_val <= threshold:
                        if score > (mean_score + std_dev):
                            new_tier = 'S'
                        elif score > mean_score:
                            new_tier = 'A'
                        elif score > (mean_score - std_dev):
                            new_tier = 'B'
                        else:
                            new_tier = 'C'
                    
                    cur.execute("UPDATE Joueurs SET tier = %s WHERE id = %s", (new_tier, pid))
            conn.commit()
        except Exception as e:
            print(f"Erreur recalcul tiers: {e}")
            conn.rollback()

# -----------------------------------------------------------------------------
# LOGIQUE MÉTIER : CALCULS DES AWARDS (FONCTIONS DÉDIÉES)
# -----------------------------------------------------------------------------


def _compute_advanced_stonks(conn, d_debut, d_fin):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT p.joueur_id, j.nom 
            FROM participations p
            JOIN tournois t ON p.tournoi_id = t.id
            JOIN joueurs j ON p.joueur_id = j.id
            WHERE t.date >= %s AND t.date <= %s
        """, (d_debut, d_fin))
        joueurs_saison = cur.fetchall()

        stonks_list = []

        for jid, nom in joueurs_saison:
            cur.execute("""
                SELECT p.new_score_trueskill, p.sigma
                FROM participations p
                JOIN tournois t ON p.tournoi_id = t.id
                WHERE p.joueur_id = %s AND t.date >= %s AND t.date <= %s
                ORDER BY t.date ASC
            """, (jid, d_debut, d_fin))
            
            historique = cur.fetchall()
            nb_matchs = len(historique)
            if nb_matchs == 0: continue

            baseline_ts = None
            for score, sig in historique:
                if float(sig) < 2.5:
                    baseline_ts = float(score)
                    break 
            
            if baseline_ts is not None:
                final_ts = float(historique[-1][0])
                final_sigma = float(historique[-1][1])
                delta = final_ts - baseline_ts
                
                stonks_list.append({
                    'id': jid, 
                    'nom': nom, 
                    'val': delta, 
                    'sigma': final_sigma, 
                    'matchs': nb_matchs
                })
        
        return stonks_list

def _compute_grand_master(stats_dict, total_tournois):
    if total_tournois <= 0:
        return None, []

    seuil_participation = total_tournois * 0.4
    BASE_POIDS = 5.0
    
    candidates = []

    for pid, d in stats_dict.items():
        num_total = 0.0
        denom_total = 0.0
        matches = d.get("gm_history", [])
        
        for m in matches:
            S_i = float(m['score'])
            M_barre_i = float(m['avg_score'])
            N_i = float(m['count'])
            
            poids = N_i + BASE_POIDS
            ratio = min(1.5, S_i / M_barre_i) if M_barre_i > 0 else 0
            weighted_val = ratio * poids
            
            num_total += weighted_val
            denom_total += poids

        ip_base = (num_total / denom_total) * 100 if denom_total > 0 else 0
        
        nb_matchs_joueur = d.get("matchs", 0)
        matchs_extra = max(0, nb_matchs_joueur - seuil_participation)
        bonus = matchs_extra * 0.3 
        
        final_score = ip_base + bonus
        is_eligible = (nb_matchs_joueur >= seuil_participation)

        candidates.append({
            "id": pid,
            "nom": d["nom"],
            "nb_matchs": nb_matchs_joueur,
            "ip_base": ip_base,
            "bonus": bonus,
            "final_score": final_score,
            "eligible": is_eligible
        })
    
    if not candidates:
        return None, []

    candidates.sort(key=lambda x: x["final_score"], reverse=True)
    
    eligible_candidates = [c for c in candidates if c['eligible']]
    
    winner_data = None
    if eligible_candidates:
        winner_data = {
            "id": eligible_candidates[0]["id"],
            "nom": eligible_candidates[0]["nom"],
            "val": eligible_candidates[0]["final_score"], 
            "details": eligible_candidates[0]
        }
        
    return winner_data, candidates

def _calculate_adjusted_total_points(match_history):
    total = 0.0
    for m in match_history:
        score = float(m['score'])
        nb_joueurs = float(m['count'])
        valeur_ponderee = score * (nb_joueurs / 12.0)
        total += valeur_ponderee
    return total

def _aggregate_season_stats(d_debut, d_fin, recap_mode=None, specific_ligue_id=None):
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            if recap_mode == 'league' and specific_ligue_id:
                query = """
                    SELECT
                        j.id, j.nom, p.score, p.position,
                        p.new_score_trueskill, p.mu, p.sigma,
                        t.date, p.tournoi_id, j.sigma, t.ligue_id
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE t.date >= %s AND t.date <= %s AND t.ligue_id = %s
                    ORDER BY t.date ASC, p.tournoi_id ASC
                """
                cur.execute(query, (d_debut, d_fin, specific_ligue_id))
            elif recap_mode == 'league':
                query = """
                    SELECT
                        j.id, j.nom, p.score, p.position,
                        p.new_score_trueskill, p.mu, p.sigma,
                        t.date, p.tournoi_id, j.sigma, t.ligue_id
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE t.date >= %s AND t.date <= %s AND t.ligue_id IS NOT NULL
                    ORDER BY t.date ASC, p.tournoi_id ASC
                """
                cur.execute(query, (d_debut, d_fin))
            elif recap_mode == 'classic':
                query = """
                    SELECT
                        j.id, j.nom, p.score, p.position,
                        p.new_score_trueskill, p.mu, p.sigma,
                        t.date, p.tournoi_id, j.sigma, t.ligue_id
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE t.date >= %s AND t.date <= %s AND t.ligue_id IS NULL
                    ORDER BY t.date ASC, p.tournoi_id ASC
                """
                cur.execute(query, (d_debut, d_fin))
            else:
                query = """
                    SELECT
                        j.id, j.nom, p.score, p.position,
                        p.new_score_trueskill, p.mu, p.sigma,
                        t.date, p.tournoi_id, j.sigma, t.ligue_id
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE t.date >= %s AND t.date <= %s
                    ORDER BY t.date ASC, p.tournoi_id ASC
                """
                cur.execute(query, (d_debut, d_fin))
            rows = cur.fetchall()

        tournoi_meta = {}
        for row in rows:
            tid = row[8]
            score = float(row[2])
            if tid not in tournoi_meta:
                tournoi_meta[tid] = {"sum_score": 0.0, "count": 0}
            tournoi_meta[tid]["count"] += 1
            tournoi_meta[tid]["sum_score"] += score

        for tid, meta in tournoi_meta.items():
            meta["avg_score"] = meta["sum_score"] / meta["count"] if meta["count"] > 0 else 1.0

        total_tournois = len(tournoi_meta)
        min_participation_req = total_tournois * 0.4

        stats = {}
        for row in rows:
            pid = row[0]
            nom = row[1]
            score = float(row[2])
            position = int(row[3])
            new_ts = row[4]
            t_date = row[7]
            tid = row[8]
            current_sigma = row[9]
            ligue_id = row[10]

            if pid not in stats:
                stats[pid] = {
                    "id": pid, "nom": nom,
                    "matchs": 0, 
                    "raw_total_points": 0.0,
                    "total_points": 0.0,
                    "total_position": 0,
                    "victoires": 0, "second_places": 0,
                    "final_ts": 0.0,
                    "sigma_actuel": float(current_sigma),
                    "gm_history": [] 
                }
            
            p = stats[pid]
            p["matchs"] += 1
            p["raw_total_points"] += float(score) 
            p["total_position"] += int(position)
            if position == 1: p["victoires"] += 1
            if position == 2: p["second_places"] += 1
            
            t = tournoi_meta[tid]
            p["gm_history"].append({
                "tid": tid, 
                "date": t_date, 
                "score": score,
                "avg_score": t["avg_score"], 
                "count": t["count"],
                "ligue_id": ligue_id
            })
            p["final_ts"] = float(new_ts) if new_ts else 0.0

        for pid, d in stats.items():
            d["total_points"] = _calculate_adjusted_total_points(d["gm_history"])

        winner_gm, list_gm = _compute_grand_master(stats, total_tournois)
        advanced_stonks_list = _compute_advanced_stonks(conn, d_debut, d_fin)

        candidates = {
            "grand_master": list_gm,
            "stonks": advanced_stonks_list,
            "not_stonks": advanced_stonks_list, 
            "ez": [], "pas_loin": [], "stakhanov": [], "chillguy": []
        }

        for pid, d in stats.items():
            candidates["ez"].append({"id": pid, "nom": d["nom"], "val": d["victoires"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
            candidates["pas_loin"].append({"id": pid, "nom": d["nom"], "val": d["second_places"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
            candidates["stakhanov"].append({"id": pid, "nom": d["nom"], "val": d["total_points"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
            
            player_stonks = next((x for x in advanced_stonks_list if x['id'] == pid), None)
            if player_stonks:
                 candidates["chillguy"].append({"id": pid, "nom": d["nom"], "val": abs(player_stonks['val']), "matchs": d["matchs"], "sigma": d["sigma_actuel"]})

        gm_score_map = { item['id']: item['final_score'] for item in list_gm }
        
        classement_points = []
        classement_moyenne = []

        for pid, d in stats.items():
            moyenne_pts = d["raw_total_points"] / d["matchs"] if d["matchs"] > 0 else 0.0
            moyenne_pos = d["total_position"] / d["matchs"] if d["matchs"] > 0 else 0.0
            
            score_gm_val = gm_score_map.get(pid)
            is_eligible_val = (d["matchs"] >= min_participation_req)
            
            entry = {
                "nom": d["nom"],
                "matchs": d["matchs"],
                "total_points": int(round(d["total_points"])),
                "victoires": d["victoires"],
                "final_trueskill": round(d["final_ts"], 3),
                "moyenne_points": round(moyenne_pts, 2),
                "moyenne_position": round(moyenne_pos, 2),
                "score_gm": round(score_gm_val, 2) if score_gm_val is not None else None,
                "is_eligible_gm": bool(is_eligible_val)
            }
            classement_points.append(entry)
            classement_moyenne.append(entry)

        classement_points.sort(key=lambda x: (x['total_points'], x['victoires']), reverse=True)
        
        classement_moyenne.sort(
            key=lambda x: (
                x['is_eligible_gm'], 
                (x['score_gm'] if x['score_gm'] is not None else -1)
            ), 
            reverse=True
        )

        return {
            "classement_points": classement_points,
            "classement_moyenne": classement_moyenne,
            "candidates": candidates,
            "total_tournois": total_tournois
        }

@app.route('/api/admin/fix-db-structure', methods=['GET'])
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
# LOGIQUE MÉTIER : ATTRIBUTION FINALE DES AWARDS (SAUVEGARDE)
# -----------------------------------------------------------------------------

def _determine_winners(candidates, vic_cond, active_awards, total_tournois):
    winners_map = {} 
    top_3_players = [] 

    if vic_cond == 'grand_master' or vic_cond == 'Indice de Performance':
        raw_list = candidates.get('grand_master', [])
        top_3_players = [c for c in raw_list if c.get('eligible', False)]
    elif vic_cond == 'ez':
        sorted_list = sorted(candidates.get('ez', []), key=lambda x: x['val'], reverse=True)
        top_3_players = [{"id": x['id'], "final_score": x['val'], "nom": x['nom']} for x in sorted_list]
    elif vic_cond == 'stakhanov':
        sorted_list = sorted(candidates.get('stakhanov', []), key=lambda x: x['val'], reverse=True)
        top_3_players = [{"id": x['id'], "final_score": x['val'], "nom": x['nom']} for x in sorted_list]
    elif vic_cond == 'stonks':
        filtered = [c for c in candidates.get('stonks', []) if float(c['sigma']) < 2.5]
        sorted_list = sorted(filtered, key=lambda x: x['val'], reverse=True)
        top_3_players = [{"id": x['id'], "final_score": x['val'], "nom": x['nom']} for x in sorted_list]
    
    algos = ['ez', 'pas_loin', 'stakhanov', 'stonks', 'not_stonks', 'chillguy']
    
    for code in algos:
        if (code not in active_awards) or (code == vic_cond):
            continue
        
        raw_list = candidates.get(code, [])
        award_winners = []

        if code == 'ez':
            if raw_list:
                m = max(c['val'] for c in raw_list)
                if m > 0: award_winners = [c for c in raw_list if c['val'] == m]
        
        elif code == 'pas_loin':
            ez_candidates = candidates.get('ez', [])
            if ez_candidates:
                max_ez = max([x['val'] for x in ez_candidates] or [0])
                ez_winners_ids = [c['id'] for c in ez_candidates if c['val'] == max_ez]
            else:
                ez_winners_ids = []
                
            filtered = [c for c in raw_list if c['id'] not in ez_winners_ids]
            if filtered:
                m = max(c['val'] for c in filtered)
                if m > 0: award_winners = [c for c in filtered if c['val'] == m]
        
        elif code == 'stakhanov':
            if raw_list:
                award_winners = [sorted(raw_list, key=lambda x: x['val'], reverse=True)[0]]
        
        elif code == 'stonks':
            valid = [c for c in raw_list if float(c['sigma']) < 2.5 and c['matchs'] >= (total_tournois * 0.5)]
            if valid:
                w = sorted(valid, key=lambda x: x['val'], reverse=True)[0]
                if w['val'] > 0.001: award_winners = [w]
        
        elif code == 'not_stonks':
            valid = [c for c in raw_list if float(c['sigma']) < 2.5 and c['matchs'] >= (total_tournois * 0.5)]
            if valid:
                w = sorted(valid, key=lambda x: x['val'], reverse=False)[0]
                if w['val'] < -0.001: award_winners = [w]
        
        elif code == 'chillguy':
            valid = [c for c in raw_list if float(c['sigma']) < 2.5 and c['matchs'] > (total_tournois * 0.5) and c['val'] < 0.3]
            if valid:
                award_winners = [sorted(valid, key=lambda x: x['val'], reverse=False)[0]]

        if award_winners:
            winners_map[code] = award_winners

    return top_3_players, winners_map

def _save_awards_to_db(conn, season_id, top_3, special_winners_map, is_yearly):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s", (season_id,))
        
        cur.execute("SELECT code, id FROM types_awards")
        types_map = {r[0]: r[1] for r in cur.fetchall()}

        moai_codes = ['super_gold_moai', 'super_silver_moai', 'super_bronze_moai'] if is_yearly else ['gold_moai', 'silver_moai', 'bronze_moai']
        
        for i in range(min(3, len(top_3))):
            player = top_3[i]
            code_award = moai_codes[i]
            if code_award in types_map:
                valeur_str = str(player['final_score'])
                if isinstance(player.get('final_score'), float):
                    valeur_str = f"{player['final_score']:.3f}"

                cur.execute("""
                    INSERT INTO awards_obtenus (joueur_id, saison_id, award_id, valeur)
                    VALUES (%s, %s, %s, %s)
                """, (player['id'], season_id, types_map[code_award], valeur_str))

        for code, winners in special_winners_map.items():
            if code in types_map:
                award_id = types_map[code]
                for w in winners:
                    val_str = str(int(w['val'])) if code in ['ez', 'pas_loin', 'stakhanov'] else str(round(w['val'], 3))
                    cur.execute("""
                        INSERT INTO awards_obtenus (joueur_id, saison_id, award_id, valeur)
                        VALUES (%s, %s, %s, %s)
                    """, (w['id'], season_id, award_id, val_str))
        
        cur.execute("UPDATE saisons SET is_active = true WHERE id = %s", (season_id,))
    conn.commit()

def _apply_inter_league_moves(conn, moves_count, ranking_data):
    if moves_count <= 0:
        return []

    movements = []

    with conn.cursor() as cur:
        cur.execute("SELECT id, nom, niveau FROM Ligues ORDER BY niveau ASC")
        ligues = cur.fetchall()

        if len(ligues) < 2:
            return []

        for i in range(len(ligues) - 1):
            ligue_haute_id, ligue_haute_nom, _ = ligues[i]
            ligue_basse_id, ligue_basse_nom, _ = ligues[i + 1]

            cur.execute("SELECT id, nom FROM Joueurs WHERE ligue_id = %s", (ligue_haute_id,))
            joueurs_haute = cur.fetchall()

            joueurs_haute_sorted = sorted(
                joueurs_haute,
                key=lambda j: ranking_data.get(j[0], float('inf')),
                reverse=True
            )
            relegues = joueurs_haute_sorted[:moves_count]

            cur.execute("SELECT id, nom FROM Joueurs WHERE ligue_id = %s", (ligue_basse_id,))
            joueurs_basse = cur.fetchall()

            joueurs_basse_sorted = sorted(
                joueurs_basse,
                key=lambda j: ranking_data.get(j[0], float('inf'))
            )
            promus = joueurs_basse_sorted[:moves_count]

            for jid, jnom in relegues:
                cur.execute("UPDATE Joueurs SET ligue_id = %s WHERE id = %s", (ligue_basse_id, jid))
                movements.append({
                    "joueur_id": jid,
                    "nom": jnom,
                    "from": ligue_haute_nom,
                    "to": ligue_basse_nom,
                    "direction": "relegation"
                })

            for jid, jnom in promus:
                cur.execute("UPDATE Joueurs SET ligue_id = %s WHERE id = %s", (ligue_haute_id, jid))
                movements.append({
                    "joueur_id": jid,
                    "nom": jnom,
                    "from": ligue_basse_nom,
                    "to": ligue_haute_nom,
                    "direction": "promotion"
                })

    return movements

# -----------------------------------------------------------------------------
# ROUTES : PUBLIC
# -----------------------------------------------------------------------------

@app.route('/saisons', methods=['GET'])
def get_public_saisons():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT nom, slug, date_debut, date_fin, is_yearly, ligue_id, ligue_nom, ligue_couleur, is_league_recap
                    FROM saisons WHERE is_active = true
                    ORDER BY date_fin DESC, ligue_id ASC NULLS FIRST
                """)
                saisons = []
                for r in cur.fetchall():
                    nom, slug, d_debut, d_fin, is_yearly, ligue_id, ligue_nom, ligue_couleur, is_league_recap = r
                    saisons.append({
                        "nom": nom, "slug": slug,
                        "date_debut": str(d_debut), "date_fin": str(d_fin),
                        "is_yearly": is_yearly,
                        "ligue_id": ligue_id, "ligue_nom": ligue_nom, "ligue_couleur": ligue_couleur,
                        "is_league_recap": is_league_recap if is_league_recap else False
                    })
        return jsonify(saisons)
    except Exception:
        return jsonify([])

@app.route('/recap')
def recap_list():
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT nom, date_debut, date_fin, slug, victory_condition, is_yearly,
                       ligue_nom, ligue_couleur, is_league_recap
                FROM saisons
                WHERE is_active = true
                ORDER BY date_fin DESC
            """)
            rows = cur.fetchall()
            saisons = [{
                "nom": r[0], "date_debut": r[1], "date_fin": r[2],
                "slug": r[3], "victory_condition": r[4], "is_yearly": r[5],
                "ligue_nom": r[6], "ligue_couleur": r[7],
                "is_league_recap": r[8] if r[8] else False
            } for r in rows]
    return render_template('recap_list.html', saisons=saisons)

@app.route('/stats/recap/<slug>')
def get_recap(slug):
    import math
    import statistics
    from math import erf, sqrt

    def normal_top_percent(score, mean, stdev):
        z = (score - mean) / stdev
        percentile = 0.5 * (1 + erf(z / sqrt(2))) * 100
        return round(100 - percentile, 1)

    ligue_id_param = request.args.get('ligue_id', type=int)

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, nom, date_debut, date_fin, slug,
                       config_awards, victory_condition, is_yearly, is_league_recap, ligue_id
                FROM saisons
                WHERE slug = %s
            """, (slug,))
            saison_row = cur.fetchone()
            if not saison_row:
                return jsonify({"error": "Saison introuvable"}), 404

            saison_id, nom, d_debut, d_fin, slug_bdd, config, vic_cond, is_yearly, is_league_recap, saison_ligue_id = saison_row

            ligues_disponibles = []
            ligue_courante = None

            if is_league_recap:
                cur.execute("""
                    SELECT DISTINCT l.id, l.nom, l.couleur, l.niveau
                    FROM Ligues l
                    JOIN Tournois t ON t.ligue_id = l.id
                    WHERE t.date >= %s AND t.date <= %s
                    ORDER BY l.niveau ASC
                """, (d_debut, d_fin))
                ligues_rows = cur.fetchall()
                ligues_disponibles = [
                    {"id": r[0], "nom": r[1], "couleur": r[2], "niveau": r[3]}
                    for r in ligues_rows
                ]

                if ligue_id_param:
                    ligue_courante = next((l for l in ligues_disponibles if l["id"] == ligue_id_param), None)
                if not ligue_courante and ligues_disponibles:
                    ligue_courante = ligues_disponibles[0]

                if ligue_courante:
                    global_stats = _aggregate_season_stats(d_debut, d_fin, 'league', ligue_courante["id"])
                else:
                    global_stats = _aggregate_season_stats(d_debut, d_fin, 'league')
            elif saison_ligue_id:
                global_stats = _aggregate_season_stats(d_debut, d_fin, 'league', saison_ligue_id)
            else:
                global_stats = _aggregate_season_stats(d_debut, d_fin, 'classic')

            cur.execute("SELECT code, nom, emoji, description, id FROM types_awards")
            types_ref = {
                r[0]: {"nom": r[1], "emoji": r[2], "desc": r[3], "id": r[4]}
                for r in cur.fetchall()
            }

            awards_data = {}

            cur.execute("""
                SELECT t.code, t.nom, t.emoji, t.description, j.nom, a.valeur
                FROM awards_obtenus a
                JOIN types_awards t ON a.award_id = t.id
                JOIN joueurs j ON a.joueur_id = j.id
                WHERE a.saison_id = %s
            """, (saison_id,))
            saved_rows = cur.fetchall()

            if saved_rows:
                for code, award_name, emoji, desc, player_name, valeur in saved_rows:
                    awards_data.setdefault(code, []).append({
                        "nom": player_name,
                        "val": valeur,
                        "emoji": emoji,
                        "award_name": award_name,
                        "description": desc
                    })
            else:
                active_list = config.get('active_awards', [])
                top_3, winners_map = _determine_winners(
                    global_stats['candidates'],
                    vic_cond,
                    active_list,
                    global_stats['total_tournois']
                )

                moai_codes = (
                    ['super_gold_moai', 'super_silver_moai', 'super_bronze_moai']
                    if is_yearly else
                    ['gold_moai', 'silver_moai', 'bronze_moai']
                )

                for i in range(min(3, len(top_3))):
                    p = top_3[i]
                    code = moai_codes[i]
                    if code in types_ref:
                        ref = types_ref[code]
                        awards_data.setdefault(code, []).append({
                            "nom": p.get("nom", "?"),
                            "val": f"{p.get('final_score', 0):.3f}",
                            "emoji": ref["emoji"],
                            "award_name": ref["nom"],
                            "description": ref["desc"]
                        })

                for code, winners in winners_map.items():
                    if code in types_ref:
                        ref = types_ref[code]
                        for w in winners:
                            val_fmt = (
                                str(int(w["val"]))
                                if code in ['ez', 'pas_loin', 'stakhanov']
                                else str(round(w["val"], 3))
                            )
                            awards_data.setdefault(code, []).append({
                                "nom": w["nom"],
                                "val": val_fmt,
                                "emoji": ref["emoji"],
                                "award_name": ref["nom"],
                                "description": ref["desc"]
                            })

            if is_league_recap and ligue_courante:
                cur.execute("""
                    SELECT id, date
                    FROM Tournois
                    WHERE date >= %s AND date <= %s AND ligue_id = %s
                    ORDER BY date ASC
                """, (d_debut, d_fin, ligue_courante["id"]))
            elif saison_ligue_id:
                cur.execute("""
                    SELECT id, date
                    FROM Tournois
                    WHERE date >= %s AND date <= %s AND ligue_id = %s
                    ORDER BY date ASC
                """, (d_debut, d_fin, saison_ligue_id))
            else:
                cur.execute("""
                    SELECT id, date
                    FROM Tournois
                    WHERE date >= %s AND date <= %s AND ligue_id IS NULL
                    ORDER BY date ASC
                """, (d_debut, d_fin))
            tournois = cur.fetchall()

            labels = [t[1].strftime("%d/%m") for t in tournois]
            tournoi_ids = [t[0] for t in tournois]

            cur.execute("SELECT id, nom, color FROM Joueurs")
            player_colors = {
                r[0]: {"nom": r[1], "color": r[2] or "#FFFFFF"}
                for r in cur.fetchall()
            }

            datasets = []

            if tournoi_ids:
                cur.execute("""
                    SELECT DISTINCT j.id
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE t.id = ANY(%s)
                """, (tournoi_ids,))
                joueurs_ids = [r[0] for r in cur.fetchall()]

                for jid in joueurs_ids:
                    p_info = player_colors.get(jid)
                    cur.execute("""
                        SELECT tournoi_id, new_score_trueskill, old_mu, old_sigma
                        FROM Participations
                        WHERE joueur_id = %s AND tournoi_id = ANY(%s)
                    """, (jid, tournoi_ids))
                    rows = cur.fetchall()

                    parts_map = {}
                    first_idx = 9999
                    initial_score = None

                    for tid, new_score, old_mu, old_sigma in rows:
                        parts_map[tid] = float(new_score)
                        try:
                            idx = tournoi_ids.index(tid)
                            if idx < first_idx and old_mu is not None and old_sigma is not None:
                                first_idx = idx
                                initial_score = float(old_mu) - 3 * float(old_sigma)
                        except ValueError:
                            pass

                    data = []
                    current = initial_score

                    for tid in tournoi_ids:
                        if tid in parts_map:
                            current = round(parts_map[tid], 2)
                            data.append(current)
                        else:
                            data.append(round(current, 2) if current is not None else None)

                    datasets.append({
                        "label": p_info["nom"],
                        "data": data,
                        "borderColor": p_info["color"],
                        "backgroundColor": p_info["color"],
                        "borderWidth": 2,
                        "fill": False,
                        "tension": 0.3,
                        "pointRadius": 0,
                        "spanGaps": True
                    })

                datasets.sort(
                    key=lambda d: next((v for v in reversed(d["data"]) if v is not None), 0),
                    reverse=True
                )

            final_scores = [
                p["final_trueskill"]
                for p in global_stats["classement_points"]
                if p["matchs"] > 0
            ]

            dist_data = {"curve": [], "players": []}

            if len(final_scores) > 1:
                mean = statistics.mean(final_scores)
                stdev = statistics.stdev(final_scores) or 1.0

                x_min = mean - 3.5 * stdev
                x_max = mean + 3.5 * stdev
                step = (x_max - x_min) / 120

                x = x_min
                while x <= x_max:
                    y = (1 / (stdev * math.sqrt(2 * math.pi))) * math.exp(
                        -0.5 * ((x - mean) / stdev) ** 2
                    )
                    dist_data["curve"].append({"x": round(x, 2), "y": y})
                    x += step

                for p in global_stats["classement_points"]:
                    if p["matchs"] == 0:
                        continue

                    score = p["final_trueskill"]
                    y_pos = (1 / (stdev * math.sqrt(2 * math.pi))) * math.exp(
                        -0.5 * ((score - mean) / stdev) ** 2
                    )

                    top_pct = normal_top_percent(score, mean, stdev)

                    color = "#FFFFFF"
                    for info in player_colors.values():
                        if info["nom"] == p["nom"]:
                            color = info["color"]
                            break

                    dist_data["players"].append({
                        "nom": p["nom"],
                        "x": score,
                        "y": y_pos,
                        "color": color,
                        "top_percent": top_pct
                    })

                dist_data["players"].sort(key=lambda k: k["x"], reverse=True)

            response_data = {
                "nom_saison": nom,
                "classement_points": global_stats["classement_points"],
                "classement_moyenne": global_stats["classement_moyenne"],
                "total_tournois": global_stats["total_tournois"],
                "awards": awards_data,
                "victory_condition": vic_cond,
                "chart_data": {
                    "labels": labels,
                    "datasets": datasets
                },
                "distribution_data": dist_data,
                "is_league_recap": is_league_recap if is_league_recap else False
            }

            if is_league_recap:
                response_data["ligues_disponibles"] = ligues_disponibles
                response_data["ligue_courante"] = ligue_courante

            return jsonify(response_data)


@app.route('/stats/recap/<slug>/new-leagues')
def get_new_leagues(slug):
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, is_league_recap, is_active
                FROM saisons WHERE slug = %s
            """, (slug,))
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "Saison introuvable"}), 404

            saison_id, is_league_recap, is_active = row

            if not is_league_recap:
                return jsonify({"error": "Cette saison n'est pas un récap de ligue"}), 400

            cur.execute("""
                SELECT joueur_id, from_ligue_nom, to_ligue_nom, direction
                FROM league_movements
                WHERE saison_id = %s
            """, (saison_id,))
            movements_rows = cur.fetchall()

            movements_by_player = {}
            for joueur_id, from_nom, to_nom, direction in movements_rows:
                movements_by_player[joueur_id] = {
                    "from": from_nom,
                    "to": to_nom,
                    "direction": direction
                }

            cur.execute("SELECT id, nom, couleur, niveau FROM Ligues ORDER BY niveau ASC")
            ligues_rows = cur.fetchall()

            ligues_data = []
            mouvements_summary = []

            for ligue_id, ligue_nom, ligue_couleur, niveau in ligues_rows:
                cur.execute("""
                    SELECT id, nom FROM Joueurs
                    WHERE ligue_id = %s
                    ORDER BY score_trueskill DESC
                """, (ligue_id,))
                joueurs = cur.fetchall()

                joueurs_list = []
                for jid, jnom in joueurs:
                    mouvement_info = movements_by_player.get(jid)
                    joueurs_list.append({
                        "id": jid,
                        "nom": jnom,
                        "mouvement": mouvement_info["direction"] if mouvement_info else None
                    })

                    if mouvement_info:
                        mouvements_summary.append({
                            "nom": jnom,
                            "from": mouvement_info["from"],
                            "to": mouvement_info["to"],
                            "direction": mouvement_info["direction"]
                        })

                ligues_data.append({
                    "id": ligue_id,
                    "nom": ligue_nom,
                    "couleur": ligue_couleur,
                    "niveau": niveau,
                    "joueurs": joueurs_list
                })

            return jsonify({
                "ligues": ligues_data,
                "mouvements_summary": mouvements_summary,
                "is_published": is_active
            })


@app.route('/dernier-tournoi')
def dernier_tournoi():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT ligue_id, ligue_nom FROM Tournois ORDER BY date DESC, id DESC LIMIT 1")
                last_record = cur.fetchone()

                if not last_record:
                    return jsonify([])

                is_league_latest = (last_record[0] is not None) or (last_record[1] is not None)
                
                final_data = []

                if is_league_latest:
                    cur.execute("""
                        SELECT DISTINCT ON (t.ligue_nom) 
                            t.id, t.date, 
                            t.ligue_nom, 
                            COALESCE(t.ligue_couleur, l.couleur)
                        FROM Tournois t
                        LEFT JOIN Ligues l ON t.ligue_id = l.id
                        WHERE t.ligue_nom IS NOT NULL
                        ORDER BY t.ligue_nom, t.date DESC
                    """)
                    rows = cur.fetchall()
                    
                    tournois_to_fetch = []
                    for tid, tdate, lnom, lcoul in rows:
                        tournois_to_fetch.append({
                            "id": tid, 
                            "date": tdate.strftime("%Y-%m-%d"), 
                            "ligue_nom": lnom, 
                            "ligue_couleur": lcoul if lcoul else "#FFFFFF",
                            "type": "ligue"
                        })
                    
                    tournois_to_fetch.sort(key=lambda x: x['date'], reverse=True)

                else:
                    cur.execute("SELECT id, date FROM Tournois ORDER BY date DESC, id DESC LIMIT 1")
                    last = cur.fetchone()
                    tournois_to_fetch = [{
                        "id": last[0], 
                        "date": last[1].strftime("%Y-%m-%d"), 
                        "type": "standard"
                    }]

                for t in tournois_to_fetch:
                    cur.execute("""
                        SELECT Joueurs.nom, Participations.score
                        FROM Participations
                        JOIN Joueurs ON Participations.joueur_id = Joueurs.id
                        WHERE Participations.tournoi_id = %s
                        ORDER BY Participations.score DESC
                    """, (t['id'],))
                    
                    resultats = [{"nom": nom, "score": score} for nom, score in cur.fetchall()]
                    
                    final_data.append({
                        "meta": t,
                        "resultats": resultats
                    })

        return jsonify(final_data)
    except Exception as e:
        print(f"Erreur dernier_tournoi: {e}")
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/classement')
def classement():
    try:
        tier_filtre = request.args.get('tier', None)
        ligue_filtre = request.args.get('ligue', None)
        query = """
            SELECT
                j.nom, j.mu, j.sigma, j.score_trueskill, j.tier,
                COUNT(p.tournoi_id) as nb_tournois,
                SUM(CASE WHEN p.position = 1 THEN 1 ELSE 0 END) as victoires,
                j.color
            FROM Joueurs j
            LEFT JOIN Participations p ON j.id = p.joueur_id
        """
        params = []
        conditions = []

        if tier_filtre and tier_filtre.upper() in ['S', 'A', 'B', 'C']:
            conditions.append("j.tier = %s")
            params.append(tier_filtre.upper())

        if ligue_filtre:
            try:
                ligue_id_int = int(ligue_filtre)
                conditions.append("j.ligue_id = %s")
                params.append(ligue_id_int)
            except ValueError:
                pass

        if conditions:
            query += " WHERE " + " AND ".join(conditions)
            
        query += " GROUP BY j.id, j.nom, j.mu, j.sigma, j.score_trueskill, j.tier"
        query += " ORDER BY j.score_trueskill DESC NULLS LAST"
        
        joueurs = []
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(query, params)
                rows = cur.fetchall()
                total_joueurs = len(rows)
                for index, row in enumerate(rows):
                    nom, mu, sigma, score_trueskill, tier, nb_tournois, victoires, color = row
                    score_ts = round(float(score_trueskill), 3) if score_trueskill is not None else 0.000
                    nb = int(nb_tournois)
                    vic = int(victoires) if victoires else 0
                    ratio = round((vic / nb * 100), 1) if nb > 0 else 0
                    
                    percentile = 0
                    if total_joueurs > 1:
                        rank = index + 1
                        percentile = round(((total_joueurs - rank) / (total_joueurs - 1)) * 100, 1)
                    elif total_joueurs == 1:
                        percentile = 100

                    joueurs.append({
                        "nom": nom,
                        "mu": float(mu),
                        "sigma": float(sigma),
                        "score_trueskill": score_ts,
                        "tier": tier.strip() if tier else "?",
                        "nombre_tournois": nb,
                        "victoires": vic,
                        "ratio_victoires": ratio,
                        "percentile_trueskill": percentile,
                        "color": color if color else "#FFFFFF"
                    })
        return jsonify(joueurs)
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@app.route('/api/admin/global-reset', methods=['POST'])
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
            
        return jsonify({"status": "success", "message": f"Sigma augmenté de {val} pour tous les joueurs (Date: {date_str})."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/admin/revert-global-reset', methods=['POST'])
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
            
        return jsonify({"status": "success", "message": "Dernier reset annulé."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/stats/joueur/<nom>')
def get_joueur_stats(nom):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'sigma_threshold'")
                res_conf = cur.fetchone()
                threshold = float(res_conf[0]) if res_conf else 4.0

                cur.execute("""
                    SELECT j.id, j.mu, j.sigma, j.score_trueskill, j.tier, j.is_ranked, j.consecutive_missed, j.color,
                           l.nom, l.couleur
                    FROM Joueurs j
                    LEFT JOIN Ligues l ON j.ligue_id = l.id
                    WHERE j.nom = %s
                """, (nom,))
                current_stats = cur.fetchone()

                if not current_stats:
                    return jsonify({"error": "Joueur non trouvé"}), 404

                jid, mu, sigma, score_trueskill, tier, is_ranked, consecutive_missed, color, ligue_nom, ligue_color = current_stats
                
                safe_ts = float(score_trueskill) if score_trueskill is not None else 0.0
                sigma_val = float(sigma)
                missed_val = int(consecutive_missed) if consecutive_missed is not None else 0
                
                is_legit = (is_ranked and sigma_val <= threshold)
                top_percent = "?" 
                if is_legit:
                    cur.execute("SELECT score_trueskill FROM Joueurs WHERE is_ranked = true AND sigma <= %s", (threshold,))
                    rows = cur.fetchall()
                    valid_scores = [float(r[0]) for r in rows if r[0] is not None]
                    if len(valid_scores) > 1:
                        mean = sum(valid_scores) / len(valid_scores)
                        variance = sum((x - mean) ** 2 for x in valid_scores) / len(valid_scores)
                        std_dev = math.sqrt(variance)
                        if std_dev > 0.0001:
                            z_score = (safe_ts - mean) / std_dev
                            cdf = 0.5 * (1 + math.erf(z_score / math.sqrt(2)))
                            top_val = (1 - cdf) * 100
                            top_percent = round(max(top_val, 0.01), 2)
                        else: top_percent = 50.0
                    elif len(valid_scores) == 1: top_percent = 1.0 
                
                cur.execute("""
                    SELECT t.id, t.date, p.score, p.position, p.new_score_trueskill, p.mu, p.sigma,
                           COALESCE(t.ligue_nom, l.nom),
                           COALESCE(t.ligue_couleur, l.couleur)
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    JOIN Joueurs j ON p.joueur_id = j.id
                    LEFT JOIN Ligues l ON t.ligue_id = l.id
                    WHERE j.nom = %s
                    ORDER BY t.date DESC
                """, (nom,))
                raw_history = cur.fetchall()

                cur.execute("SELECT g.date, g.old_sigma, g.new_sigma, j.mu FROM ghost_log g JOIN Joueurs j ON g.joueur_id = j.id WHERE j.nom = %s ORDER BY g.date DESC", (nom,))
                raw_ghosts = cur.fetchall()

                cur.execute("SELECT date, value_applied FROM global_resets ORDER BY date DESC")
                raw_resets = cur.fetchall()

                historique_data = []
                scores_bruts = []
                positions = []
                victoires = 0
                
                for tid, date, score, position, hist_ts, h_mu, h_sigma, hist_ligue_nom, hist_ligue_couleur in raw_history:
                    s_val = float(score) if score is not None else 0.0
                    p_val = int(position) if position is not None else 0
                    ts_val = float(hist_ts) if hist_ts is not None else 0.0
                    scores_bruts.append(s_val)
                    positions.append(p_val)
                    if p_val == 1: victoires += 1

                    historique_data.append({
                        "type": "tournoi",
                        "id": tid,
                        "date": date.strftime("%Y-%m-%d"),
                        "score": s_val,
                        "position": p_val,
                        "score_trueskill": round(ts_val, 3),
                        "ligue": hist_ligue_nom if hist_ligue_nom else "N/A",
                        "ligue_couleur": hist_ligue_couleur if hist_ligue_couleur else None
                    })

                for g_date, old_sig, new_sig, current_mu in raw_ghosts:
                    ts_ghost = float(current_mu) - 3 * float(new_sig)
                    penalty_val = round(float(new_sig) - float(old_sig), 3)
                    historique_data.append({
                        "type": "absence", "date": g_date.strftime("%Y-%m-%d"),
                        "score": 0, "position": "-", "score_trueskill": round(ts_ghost, 3),
                        "valeur": penalty_val, "ligue": "-"
                    })
                
                for r_date, val in raw_resets:
                    val_float = float(val)
                    r_date_only = r_date.date() if hasattr(r_date, 'date') else r_date
                    reset_ts = None
                    for tid, t_date, score, position, hist_ts, _, _, _, _ in raw_history:
                        if t_date <= r_date_only and hist_ts is not None:
                            reset_ts = float(hist_ts) - val_float * 3
                            break

                    if reset_ts is None:
                        continue

                    historique_data.append({
                        "type": "reset", "date": r_date_only.strftime("%Y-%m-%d"),
                        "score": 0, "position": "-", "score_trueskill": round(reset_ts, 3),
                        "valeur": val_float, "ligue": "-"
                    })

                historique_data.sort(key=lambda x: x['date'], reverse=True)

                nb_tournois = len(scores_bruts)
                if nb_tournois > 0:
                    score_moyen = sum(scores_bruts) / nb_tournois
                    meilleur_score = max(scores_bruts)
                    position_moyenne = sum(positions) / nb_tournois
                    ratio_victoires = (victoires / nb_tournois) * 100
                    variance = sum((x - score_moyen) ** 2 for x in scores_bruts) / nb_tournois
                    ecart_type_scores = math.sqrt(variance)
                else:
                    score_moyen = 0; meilleur_score = 0; position_moyenne = 0; ratio_victoires = 0; ecart_type_scores = 0

                progression_recente = 0
                if nb_tournois >= 2:
                    tournois_only = [x for x in historique_data if x['type'] == 'tournoi']
                    if len(tournois_only) >= 2:
                        current_ts_val = tournois_only[0]['score_trueskill']
                        prev_ts_val = tournois_only[1]['score_trueskill']
                        progression_recente = current_ts_val - prev_ts_val

                cur.execute("SELECT t.emoji, t.nom, t.description, COUNT(o.id) FROM awards_obtenus o JOIN types_awards t ON o.award_id = t.id WHERE o.joueur_id = %s GROUP BY t.emoji, t.nom, t.description", (jid,))
                awards_list = [{"emoji": r[0], "nom": r[1], "description": r[2], "count": r[3]} for r in cur.fetchall()]

        return jsonify({
            "stats": {
                "mu": round(float(mu), 3) if mu else 50.0,
                "sigma": round(float(sigma), 3) if sigma else 8.333,
                "score_trueskill": round(safe_ts, 3),
                "tier": tier.strip() if tier else '?',
                "is_ranked": is_ranked,
                "consecutive_missed": missed_val,
                "nombre_tournois": nb_tournois,
                "victoires": victoires,
                "ratio_victoires": round(ratio_victoires, 1),
                "score_moyen": round(score_moyen, 3),
                "meilleur_score": meilleur_score,
                "ecart_type_scores": round(ecart_type_scores, 3),
                "position_moyenne": round(position_moyenne, 1),
                "progression_recente": round(progression_recente, 3),
                "percentile_trueskill": top_percent,
                "color": color if color else "#FFFFFF",
                "ligue": {"nom": ligue_nom, "couleur": ligue_color} if ligue_nom else None
            },
            "historique": historique_data,
            "awards": awards_list
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/joueurs/noms')
def get_joueur_names():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT nom, ligue_id FROM Joueurs ORDER BY score_trueskill DESC NULLS LAST")
                joueurs = [{"nom": row[0], "ligue_id": row[1]} for row in cur.fetchall()]
        return jsonify(joueurs)
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/stats/joueurs', methods=['GET'])
def stats_joueurs():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT tier FROM joueurs")
                tier_rows = cur.fetchall()
                dist = {'S': 0, 'A': 0, 'B': 0, 'C': 0, 'U': 0}
                for tr in tier_rows:
                    t = tr[0] if tr[0] and tr[0] not in ['Unranked', '?', ''] else 'U'
                    if t in dist: dist[t] += 1
                    else: dist['U'] += 1

                cur.execute("""
                    SELECT 
                        j.nom, j.mu, j.sigma, j.tier,
                        COUNT(p.tournoi_id) as nb_tournois,
                        COALESCE(SUM(CASE WHEN p.position = 1 THEN 1 ELSE 0 END), 0) as victoires,
                        AVG(p.score) as score_moyen,
                        j.color
                    FROM joueurs j
                    LEFT JOIN participations p ON j.id = p.joueur_id
                    GROUP BY j.id, j.nom, j.mu, j.sigma, j.tier
                    ORDER BY (j.mu - 3 * j.sigma) DESC;
                """)
                rows = cur.fetchall()
        
        joueurs = []
        for row in rows:
            mu, sigma = row[1], row[2]
            ts = mu - 3 * sigma
            joueurs.append({
                "nom": row[0],
                "score_trueskill": round(ts, 3),
                "tier": row[3],
                "nombre_tournois": row[4],
                "victoires": row[5],
                "score_moyen": round(float(row[6]), 1) if row[6] else 0.0,
                "color": row[7] if row[7] else "#FFFFFF"
            })
        
        return jsonify({"joueurs": joueurs, "distribution_tiers": dist})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/stats/tournois')
def get_tournois_list():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT t.id, t.date, COUNT(p.joueur_id), MAX(p.score),
                           COALESCE(t.ligue_nom, l.nom),
                           COALESCE(t.ligue_couleur, l.couleur)
                    FROM Tournois t
                    JOIN Participations p ON t.id = p.tournoi_id
                    LEFT JOIN Ligues l ON t.ligue_id = l.id
                    GROUP BY t.id, t.date, t.ligue_nom, t.ligue_couleur, l.nom, l.couleur
                    ORDER BY t.date DESC
                """)
                tournois = [{
                    "id": r[0],
                    "date": r[1].strftime("%Y-%m-%d"),
                    "nb_joueurs": r[2],
                    "participants": r[2],
                    "score_max": r[3],
                    "ligue_nom": r[4] if r[4] else "N/A",
                    "ligue_couleur": r[5] if r[5] else None
                } for r in cur.fetchall()]
        return jsonify(tournois)
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/stats/tournoi/<int:tournoi_id>')
def get_tournoi_details(tournoi_id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT date FROM Tournois WHERE id = %s", (tournoi_id,))
                td = cur.fetchone()
                if not td: abort(404)
                cur.execute("""
                    SELECT j.nom, p.score, p.new_score_trueskill, p.new_tier, p.position, j.color
                    FROM Participations p JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE p.tournoi_id = %s ORDER BY p.position ASC
                """, (tournoi_id,))
                res = [{
                    "nom": r[0], "score_tournoi": r[1],
                    "score_trueskill": round(float(r[2]), 3) if r[2] else 0,
                    "tier": r[3].strip() if r[3] else "?", "position": r[4],
                    "color": r[5] if r[5] else "#FFFFFF"
                } for r in cur.fetchall()]
        return jsonify({"date": td[0].strftime("%Y-%m-%d"), "resultats": res})
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

# -----------------------------------------------------------------------------
# ROUTES : ADMIN
# -----------------------------------------------------------------------------

@app.route('/admin-auth', methods=['POST'])
def admin_auth():
    data = request.get_json()
    password = data.get('password', '')
    password_bytes = password.encode('utf-8')
    try:
        if bcrypt.checkpw(password_bytes, ADMIN_PASSWORD_HASH):
            new_token = str(uuid.uuid4())
            expiration = datetime.now() + timedelta(minutes=30)
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

@app.route('/admin/refresh-token', methods=['POST'])
@admin_required
def refresh_token():
    old_token = request.headers.get('X-Admin-Token')
    new_token = str(uuid.uuid4())
    expiration = datetime.now() + timedelta(minutes=30)
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM api_tokens WHERE token = %s", (old_token,))
                cur.execute("INSERT INTO api_tokens (token, expires_at) VALUES (%s, %s)", (new_token, expiration))
            conn.commit()
        return jsonify({"status": "success", "token": new_token})
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/admin-logout', methods=['POST'])
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

@app.route('/admin/check-token', methods=['GET'])
@admin_required
def check_token():
    return jsonify({"status": "valid"}), 200

@app.route('/admin/config', methods=['GET'])
@admin_required
def get_config():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT key, value FROM Configuration WHERE key IN ('tau', 'ghost_enabled', 'ghost_penalty', 'unranked_threshold', 'sigma_threshold', 'league_mode_enabled', 'inter_league_moves')")
                rows = dict(cur.fetchall())
        return jsonify({
            "tau": float(rows.get('tau', 0.083)),
            "ghost_enabled": rows.get('ghost_enabled', 'false') == 'true',
            "ghost_penalty": float(rows.get('ghost_penalty', 0.1)),
            "unranked_threshold": int(rows.get('unranked_threshold', 10)),
            "sigma_threshold": float(rows.get('sigma_threshold', 4.0)),
            "league_mode_enabled": rows.get('league_mode_enabled', 'false') == 'true',
            "inter_league_moves": int(rows.get('inter_league_moves', 0))
        })
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/admin/config', methods=['POST'])
@admin_required
def update_config():
    data = request.get_json()
    try:
        tau = float(data.get('tau', 0.083))
        ghost = str(data.get('ghost_enabled', 'false')).lower()
        ghost_penalty = float(data.get('ghost_penalty', 0.1))
        unranked_threshold = int(data.get('unranked_threshold', 10))
        sigma_threshold = float(data.get('sigma_threshold', 4.0))

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
            
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route('/admin/joueurs', methods=['GET'])
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

@app.route('/admin/joueurs/<int:id>', methods=['PUT'])
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
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route('/admin/joueurs/<int:id>', methods=['DELETE'])
@admin_required
def api_delete_joueur(id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM Joueurs WHERE id=%s", (id,))
            conn.commit()
            recalculate_tiers()
        return jsonify({"status": "success"})
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 400

@app.route('/admin/types-awards', methods=['GET'])
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

@app.route('/admin/saisons', methods=['GET', 'POST'])
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

                        slug = slugify(nom)

                        base_slug = slug
                        counter = 1
                        while True:
                            cur.execute("SELECT id FROM saisons WHERE slug = %s", (slug,))
                            if not cur.fetchone():
                                break
                            slug = f"{base_slug}-{counter}"
                            counter += 1

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
                        slug = slugify(nom)

                        base_slug = slug
                        counter = 1
                        while True:
                            cur.execute("SELECT id FROM saisons WHERE slug = %s", (slug,))
                            if not cur.fetchone():
                                break
                            slug = f"{base_slug}-{counter}"
                            counter += 1

                        cur.execute(
                            """INSERT INTO saisons (nom, slug, date_debut, date_fin, config_awards, is_active, victory_condition, is_yearly)
                               VALUES (%s, %s, %s, %s, %s, false, %s, %s) RETURNING id""",
                            (nom, slug, d_debut, d_fin, config_json, victory_cond, is_yearly)
                        )
                        conn.commit()
                        return jsonify({"status": "success"})
        except Exception as e:
            return jsonify({"error": str(e)}), 400

@app.route('/admin/saisons/<int:saison_id>', methods=['DELETE'])
@admin_required
def delete_saison(saison_id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s", (saison_id,))
                cur.execute("DELETE FROM saisons WHERE id = %s", (saison_id,))
            conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/admin/saisons/<int:id>/count-tournois', methods=['GET'])
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

@app.route('/admin/saisons/<int:id>/save-awards', methods=['POST'])
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
                    SELECT DISTINCT l.id, l.nom, l.niveau
                    FROM Ligues l
                    JOIN Tournois t ON t.ligue_id = l.id
                    WHERE t.date >= %s AND t.date <= %s
                    ORDER BY l.niveau ASC
                """, (d_debut, d_fin))
                ligues_rows = cur.fetchall()
                ligues = [(r[0], r[1]) for r in ligues_rows]

                if not ligues:
                    return jsonify({'error': 'Aucun tournoi de ligue pendant cette période'}), 400

                all_rankings = {}

                for ligue_id, ligue_nom in ligues:
                    ligue_stats = _aggregate_season_stats(d_debut, d_fin, 'league', ligue_id)

                    gm_list = ligue_stats['candidates'].get('grand_master', [])
                    gm_sorted = sorted(gm_list, key=lambda x: x.get('final_score', 0), reverse=True)
                    all_rankings[ligue_id] = {p['id']: rank for rank, p in enumerate(gm_sorted, 1)}

                if move_criterion:
                    cur.execute("SELECT value FROM Configuration WHERE key = 'league_mode_enabled'")
                    league_row = cur.fetchone()
                    league_enabled = (league_row[0] == 'true') if league_row else False

                    cur.execute("SELECT value FROM Configuration WHERE key = 'inter_league_moves'")
                    moves_row = cur.fetchone()
                    moves_count = int(moves_row[0]) if moves_row else 0

                    if league_enabled and moves_count > 0:
                        if move_criterion == "ip":
                            movements = _apply_inter_league_moves_by_ligue(conn, moves_count, all_rankings)
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

    response = {'status': 'success', 'message': 'Saison publiée et awards distribués !'}
    if movements:
        response['movements'] = movements
        response['message'] += f' {len(movements)} mouvements inter-ligue effectués.'

    return jsonify(response)


def _apply_inter_league_moves_by_ligue(conn, moves_count, rankings_by_ligue):
    if moves_count <= 0:
        return []

    movements = []

    with conn.cursor() as cur:
        cur.execute("SELECT id, nom, niveau FROM Ligues ORDER BY niveau ASC")
        ligues = cur.fetchall()

        if len(ligues) < 2:
            return []

        for i in range(len(ligues) - 1):
            ligue_haute_id, ligue_haute_nom, _ = ligues[i]
            ligue_basse_id, ligue_basse_nom, _ = ligues[i + 1]

            ranking_haute = rankings_by_ligue.get(ligue_haute_id, {})
            ranking_basse = rankings_by_ligue.get(ligue_basse_id, {})

            cur.execute("SELECT id, nom FROM Joueurs WHERE ligue_id = %s", (ligue_haute_id,))
            joueurs_haute = cur.fetchall()

            joueurs_haute_sorted = sorted(
                joueurs_haute,
                key=lambda j: ranking_haute.get(j[0], float('inf')),
                reverse=True
            )
            relegues = joueurs_haute_sorted[:moves_count]

            cur.execute("SELECT id, nom FROM Joueurs WHERE ligue_id = %s", (ligue_basse_id,))
            joueurs_basse = cur.fetchall()

            joueurs_basse_sorted = sorted(
                joueurs_basse,
                key=lambda j: ranking_basse.get(j[0], float('inf'))
            )
            promus = joueurs_basse_sorted[:moves_count]

            for jid, jnom in relegues:
                cur.execute("UPDATE Joueurs SET ligue_id = %s WHERE id = %s", (ligue_basse_id, jid))
                movements.append({
                    "joueur_id": jid,
                    "nom": jnom,
                    "from": ligue_haute_nom,
                    "to": ligue_basse_nom,
                    "direction": "relegation"
                })

            for jid, jnom in promus:
                cur.execute("UPDATE Joueurs SET ligue_id = %s WHERE id = %s", (ligue_haute_id, jid))
                movements.append({
                    "joueur_id": jid,
                    "nom": jnom,
                    "from": ligue_basse_nom,
                    "to": ligue_haute_nom,
                    "direction": "promotion"
                })

    return movements

@app.route('/admin/joueurs', methods=['POST'])
@admin_required
def api_add_joueur():
    data = request.get_json()
    try:
        nom = data.get('nom')
        mu = float(data.get('mu', 50.0))
        sigma = float(data.get('sigma', 8.333))
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
            
        return jsonify({"status": "success", "message": "Joueur ajouté"}), 201
    except ValueError:
        return jsonify({"error": "Valeurs numériques invalides pour Mu ou Sigma"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/add-tournament', methods=['POST'])
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
                
                if is_league_mode and not ligue_id:
                    return jsonify({"error": "Le mode Ligue est activé, veuillez sélectionner une ligue."}), 400

                ligue_nom_archive = None
                ligue_couleur_archive = None

                if ligue_id:
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
                
                for joueur in joueurs_data:
                    nom, score = joueur['nom'], joueur['score']
                    cur.execute("SELECT id, mu, sigma FROM Joueurs WHERE nom = %s", (nom,))
                    res = cur.fetchone()
                    if res:
                        jid, mu, sigma = res
                    else:
                        cur.execute("INSERT INTO Joueurs (nom, mu, sigma, tier, is_ranked) VALUES (%s, 50.0, 8.333, 'U', true) RETURNING id", (nom,))
                        jid, mu, sigma = cur.fetchone()[0], 50.0, 8.333
                    joueurs_ratings[nom] = trueskill.Rating(mu=float(mu), sigma=float(sigma))
                    joueurs_ids_map[nom] = jid
                    cur.execute("INSERT INTO Participations (tournoi_id, joueur_id, score, old_mu, old_sigma) VALUES (%s, %s, %s, %s, %s)", (tournoi_id, jid, score, float(mu), float(sigma)))

                sorted_joueurs = sorted(joueurs_data, key=lambda x: x['score'], reverse=True)
                ranks = []
                last_s, rank = -1, 1
                for i, j in enumerate(sorted_joueurs):
                    if j['score'] < last_s: rank = i + 1
                    ranks.append(rank)
                    last_s = j['score']
                
                cur.execute("SELECT value FROM Configuration WHERE key = 'tau'")
                tau_val = float(cur.fetchone()[0])
                ts_env = trueskill.TrueSkill(mu=50.0, sigma=8.333, beta=4.167, tau=tau_val, draw_probability=0.1)
                new_ratings = ts_env.rate([[joueurs_ratings[j['nom']]] for j in sorted_joueurs], ranks=ranks)

                present_pids = []
                for i, j in enumerate(sorted_joueurs):
                    nr = new_ratings[i][0]
                    jid = joueurs_ids_map[j['nom']]
                    present_pids.append(jid)
                    cur.execute("UPDATE Joueurs SET mu=%s, sigma=%s, consecutive_missed=0, is_ranked=true WHERE id=%s", (nr.mu, nr.sigma, jid))
                    cur.execute("UPDATE Participations SET mu=%s, sigma=%s, new_score_trueskill=%s, position=%s WHERE tournoi_id=%s AND joueur_id=%s", (nr.mu, nr.sigma, nr.mu - 3 * nr.sigma, ranks[i], tournoi_id, jid))

                cur.execute("SELECT key, value FROM Configuration WHERE key IN ('ghost_enabled', 'ghost_penalty', 'unranked_threshold')")
                conf = dict(cur.fetchall())
                ghost_enabled = (conf.get('ghost_enabled') == 'true')
                penalty_val = float(conf.get('ghost_penalty', 0.1))
                unranked_limit = int(conf.get('unranked_threshold', 10))

                query_absents = f"SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs WHERE id NOT IN ({','.join(['%s']*len(present_pids))})" if present_pids else "SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs"
                cur.execute(query_absents, tuple(present_pids))
                
                for pid, sig, missed, is_r in cur.fetchall():
                    new_missed = (missed or 0) + 1
                    new_sig = float(sig)
                    if ghost_enabled and new_missed >= 4 and new_sig < 3.5:
                        new_sig += penalty_val
                        cur.execute("INSERT INTO ghost_log (joueur_id, tournoi_id, date, old_sigma, new_sigma, penalty_applied) VALUES (%s, %s, %s, %s, %s, %s)", (pid, tournoi_id, date_tournoi_str, sig, new_sig, penalty_val))
                    
                    new_is_ranked = is_r
                    if new_missed >= unranked_limit: new_is_ranked = False
                    cur.execute("UPDATE Joueurs SET sigma=%s, consecutive_missed=%s, is_ranked=%s WHERE id=%s", (new_sig, new_missed, new_is_ranked, pid))
            
            conn.commit()
            recalculate_tiers()
            
            return jsonify({"status": "success", "tournoi_id": tournoi_id}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/admin/revert-last-tournament', methods=['POST'])
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
                for jid, mu, sig in cur.fetchall():
                    if mu is None: return jsonify({"status": "error", "message": "Trop ancien"}), 400
                    cur.execute("UPDATE Joueurs SET mu=%s, sigma=%s WHERE id=%s", (mu, sig, jid))

                cur.execute("SELECT joueur_id, old_sigma FROM ghost_log WHERE tournoi_id = %s", (tid,))
                for jid, sig in cur.fetchall():
                    cur.execute("UPDATE Joueurs SET sigma=%s WHERE id=%s", (sig, jid))
                
                cur.execute("UPDATE Joueurs SET consecutive_missed = GREATEST(0, consecutive_missed - 1)")
                cur.execute("DELETE FROM ghost_log WHERE tournoi_id = %s", (tid,))
                cur.execute("DELETE FROM Participations WHERE tournoi_id = %s", (tid,))
                cur.execute("DELETE FROM Tournois WHERE id = %s", (tid,))
            conn.commit()
            recalculate_tiers()
            return jsonify({"status": "success", "message": "Annulé."}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/delete-tournament/<int:id>', methods=['DELETE'])
@admin_required
def delete_tournament(id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
                res = cur.fetchone()
                threshold = int(res[0]) if res else 10

                cur.execute("SELECT joueur_id, old_sigma FROM ghost_log WHERE tournoi_id = %s", (id,))
                for pid, old_sig in cur.fetchall():
                    cur.execute("UPDATE Joueurs SET sigma = %s WHERE id = %s", (old_sig, pid))

                cur.execute("SELECT joueur_id FROM Participations WHERE tournoi_id = %s", (id,))
                parts = [r[0] for r in cur.fetchall()]
                q_abs = f"SELECT id, consecutive_missed, is_ranked FROM Joueurs WHERE id NOT IN ({','.join(['%s']*len(parts))})" if parts else "SELECT id, consecutive_missed, is_ranked FROM Joueurs"
                cur.execute(q_abs, tuple(parts))
                
                for pid, missed, is_r in cur.fetchall():
                    if missed and missed > 0:
                        new_m = missed - 1
                        new_r = True if (not is_r and new_m < threshold) else is_r
                        cur.execute("UPDATE Joueurs SET consecutive_missed=%s, is_ranked=%s WHERE id=%s", (new_m, new_r, pid))

                cur.execute("DELETE FROM Tournois WHERE id = %s", (id,))
            conn.commit()
            recalculate_tiers()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/ligues', methods=['GET'])
def get_ligues_public():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, nom, niveau, couleur FROM Ligues ORDER BY niveau ASC")
                ligues_rows = cur.fetchall()
                
                ligues = []
                for lid, nom, niv, coul in ligues_rows:
                    cur.execute("""
                        SELECT nom, score_trueskill, tier 
                        FROM Joueurs 
                        WHERE ligue_id = %s 
                        ORDER BY score_trueskill DESC
                    """, (lid,))
                    joueurs = [{"nom": r[0], "score": r[1], "tier": r[2]} for r in cur.fetchall()]
                    
                    ligues.append({
                        "id": lid, "nom": nom, "niveau": niv, "couleur": coul,
                        "joueurs": joueurs
                    })
        return jsonify(ligues)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/admin/ligues/setup', methods=['POST'])
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
        print(f"Erreur setup_ligues: {e}")
        return jsonify({"error": str(e)}), 500
    
@app.route('/admin/ligues/draft-simulation', methods=['GET'])
@admin_required
def draft_simulation():
    force_reset = request.args.get('force_reset') == 'true'

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                
                cur.execute("SELECT COUNT(*) FROM Ligues")
                count_ligues = cur.fetchone()[0]

                if count_ligues > 0 and not force_reset:
                    cur.execute("SELECT id, nom, niveau, couleur FROM Ligues ORDER BY niveau ASC")
                    ligues_db = cur.fetchall()
                    
                    draft_ligues = []
                    for lid, lnom, lniv, lcoul in ligues_db:
                        cur.execute("SELECT id, nom, score_trueskill FROM Joueurs WHERE ligue_id = %s ORDER BY score_trueskill DESC", (lid,))
                        j_list = [{"id": r[0], "nom": r[1], "score": float(r[2]) if r[2] else 0.0} for r in cur.fetchall()]
                        
                        draft_ligues.append({
                            "nom": lnom,
                            "couleur": lcoul,
                            "joueurs": j_list
                        })
                    
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

# -----------------------------------------------------------------------------
# MAIN
# -----------------------------------------------------------------------------

if __name__ == '__main__':
    try:
        sync_sequences()
        recalculate_tiers()
    except Exception:
        pass
    app.run(host='0.0.0.0', port=8080)
