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
    """Nettoie le nom pour en faire une URL valide"""
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

def _compute_grand_master(stats_dict, total_tournois):
    """
    Calcule l'Indice de Performance (IP) pondéré avec Base Fixe.
    NE PAS MODIFIER CETTE FONCTION.
    """
    seuil_participation = total_tournois * 0.50
    bonus_par_tournoi_extra = 0.3 
    BASE_POIDS = 5.0
    
    candidates = []

    for pid, d in stats_dict.items():
        if d["matchs"] >= seuil_participation:
            num_total = 0.0
            denom_total = 0.0
            matches = d.get("gm_history", [])
            for m in matches:
                S_i = m['score']
                M_barre_i = m['avg_score']
                N_i = m['count']
                poids = N_i + BASE_POIDS
                ratio = min(1.5, S_i / M_barre_i) if M_barre_i > 0 else 0
                weighted_val = ratio * poids
                num_total += weighted_val
                denom_total += poids

            ip_base = (num_total / denom_total) * 100 if denom_total > 0 else 0
            matchs_extra = max(0, d["matchs"] - seuil_participation)
            bonus = matchs_extra * bonus_par_tournoi_extra
            final_score = ip_base + bonus

            candidates.append({
                "id": pid,
                "nom": d["nom"],
                "nb_matchs": d["matchs"],
                "ip_base": ip_base,
                "bonus": bonus,
                "final_score": final_score
            })
    
    if not candidates:
        return None, []

    candidates.sort(key=lambda x: x["final_score"], reverse=True)
    winner_data = {
        "id": candidates[0]["id"],
        "nom": candidates[0]["nom"],
        "val": candidates[0]["final_score"], 
        "details": candidates[0]
    }
    return winner_data, candidates

def _compute_advanced_stonks(conn, d_debut, d_fin):
    """
    Calcule précisément les candidats Stonks/Not Stonks
    en regardant l'historique et en trouvant le point de départ "Ranked".
    Remplace l'ancienne "Injection 2.5".
    """
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

def _aggregate_season_stats(d_debut, d_fin):
    """
    Fonction principale d'agrégation des statistiques brutes d'une saison.
    Retourne une structure complète avec classements et listes de candidats.
    """
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            query = """
                SELECT 
                    j.id, j.nom, p.score, p.position, 
                    p.new_score_trueskill, p.mu, p.sigma,
                    t.date, p.tournoi_id, j.sigma
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
            score = row[2]
            if tid not in tournoi_meta:
                tournoi_meta[tid] = {"sum_score": 0, "count": 0}
            tournoi_meta[tid]["count"] += 1
            tournoi_meta[tid]["sum_score"] += score

        for tid, meta in tournoi_meta.items():
            meta["avg_score"] = meta["sum_score"] / meta["count"] if meta["count"] > 0 else 1

        stats = {}
        for pid, nom, score, position, new_ts, mu, sigma, t_date, tid, current_sigma in rows:
            if pid not in stats:
                stats[pid] = {
                    "id": pid, "nom": nom,
                    "matchs": 0, "total_points": 0, "total_position": 0,
                    "victoires": 0, "second_places": 0,
                    "final_ts": 0.0,
                    "sigma_actuel": float(current_sigma),
                    "gm_history": [] 
                }
            
            p = stats[pid]
            p["matchs"] += 1
            p["total_points"] += score
            p["total_position"] += position
            if position == 1: p["victoires"] += 1
            if position == 2: p["second_places"] += 1
            
            t = tournoi_meta[tid]
            p["gm_history"].append({
                "tid": tid, "date": t_date, "score": score,
                "avg_score": t["avg_score"], "count": t["count"]
            })
            p["final_ts"] = float(new_ts) if new_ts else 0.0

        total_tournois = len(tournoi_meta)
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
            moyenne_pts = d["total_points"] / d["matchs"] if d["matchs"] > 0 else 0
            moyenne_pos = d["total_position"] / d["matchs"] if d["matchs"] > 0 else 0
            score_gm_val = gm_score_map.get(pid)
            
            entry = {
                "nom": d["nom"],
                "matchs": d["matchs"],
                "total_points": d["total_points"],
                "victoires": d["victoires"],
                "final_trueskill": round(d["final_ts"], 3),
                "moyenne_points": round(moyenne_pts, 2),
                "moyenne_position": round(moyenne_pos, 2),
                "score_gm": round(score_gm_val, 2) if score_gm_val is not None else None
            }
            classement_points.append(entry)
            classement_moyenne.append(entry)

        classement_points.sort(key=lambda x: (x['total_points'], x['victoires']), reverse=True)
        classement_moyenne.sort(key=lambda x: (x['score_gm'] if x['score_gm'] is not None else -1), reverse=True)

        return {
            "classement_points": classement_points,
            "classement_moyenne": classement_moyenne,
            "candidates": candidates,
            "total_tournois": total_tournois
        }

# -----------------------------------------------------------------------------
# LOGIQUE MÉTIER : ATTRIBUTION FINALE DES AWARDS (SAUVEGARDE)
# -----------------------------------------------------------------------------

def _determine_winners(candidates, vic_cond, active_awards, total_tournois):
    """
    Fonction pure qui détermine les gagnants de chaque catégorie (Podium + Spéciaux).
    Applique les filtres et règles d'exclusion.
    """
    winners_map = {} 
    top_3_players = [] 

    if vic_cond == 'grand_master' or vic_cond == 'Indice de Performance':
        top_3_players = candidates.get('grand_master', [])
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
    """
    Fonction technique qui écrit les résultats en base.
    """
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

# -----------------------------------------------------------------------------
# ROUTES : PUBLIC
# -----------------------------------------------------------------------------

@app.route('/saisons', methods=['GET'])
def get_public_saisons():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT nom, slug, date_debut, date_fin FROM saisons WHERE is_active = true ORDER BY date_fin DESC")
                saisons = []
                for r in cur.fetchall():
                    nom, slug, d_debut, d_fin = r
                    duree = (d_fin - d_debut).days
                    is_yearly = duree > 300 
                    saisons.append({
                        "nom": nom, "slug": slug,
                        "date_debut": str(d_debut), "date_fin": str(d_fin),
                        "is_yearly": is_yearly
                    })
        return jsonify(saisons)
    except Exception:
        return jsonify([])

@app.route('/recap')
def recap_list():
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT nom, date_debut, date_fin, slug, victory_condition, is_yearly 
                FROM saisons 
                WHERE is_active = true 
                ORDER BY date_fin DESC
            """)
            rows = cur.fetchall()
            saisons = [{
                "nom": r[0], "date_debut": r[1], "date_fin": r[2],
                "slug": r[3], "victory_condition": r[4], "is_yearly": r[5]
            } for r in rows]
    return render_template('recap_list.html', saisons=saisons)

@app.route('/stats/recap/<slug>')
def get_recap(slug):
    """
    Génère le récapitulatif d'une saison.
    Utilise le moteur de calcul refactorisé pour assurer la cohérence.
    """
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, nom, date_debut, date_fin, slug, config_awards, victory_condition, is_yearly FROM saisons WHERE slug = %s", (slug,))
            saison_row = cur.fetchone()
            if not saison_row: return jsonify({"error": "Saison introuvable"}), 404

            saison_id, nom, d_debut, d_fin, slug_bdd, config, vic_cond, is_yearly = saison_row
            
            global_stats = _aggregate_season_stats(d_debut, d_fin)
            
            cur.execute("SELECT code, nom, emoji, description, id FROM types_awards")
            types_ref = {r[0]: {"nom": r[1], "emoji": r[2], "desc": r[3], "id": r[4]} for r in cur.fetchall()}

            awards_data = {}
            
            cur.execute("""
                SELECT t.code, t.nom, t.emoji, j.nom, a.valeur
                FROM awards_obtenus a
                JOIN types_awards t ON a.award_id = t.id
                JOIN joueurs j ON a.joueur_id = j.id
                WHERE a.saison_id = %s
            """, (saison_id,))
            saved_rows = cur.fetchall()

            if saved_rows:
                for code, award_name, emoji, player_name, valeur in saved_rows:
                    if code not in awards_data: awards_data[code] = []
                    awards_data[code].append({"nom": player_name, "val": valeur, "emoji": emoji, "award_name": award_name})
            else:
                active_list = config.get('active_awards', [])
                top_3, winners_map = _determine_winners(
                    global_stats['candidates'], vic_cond, active_list, global_stats['total_tournois']
                )

                moai_codes = ['super_gold_moai', 'super_silver_moai', 'super_bronze_moai'] if is_yearly else ['gold_moai', 'silver_moai', 'bronze_moai']
                for i in range(min(3, len(top_3))):
                    p = top_3[i]
                    code = moai_codes[i]
                    if code in types_ref:
                        ref = types_ref[code]
                        if code not in awards_data: awards_data[code] = []
                        val_fmt = f"{p.get('final_score', 0):.3f}"
                        awards_data[code].append({"nom": p.get('nom', '?'), "val": val_fmt, "emoji": ref['emoji'], "award_name": ref['nom']})

                for code, winners in winners_map.items():
                    if code in types_ref:
                        ref = types_ref[code]
                        if code not in awards_data: awards_data[code] = []
                        for w in winners:
                            val_fmt = str(int(w['val'])) if code in ['ez', 'pas_loin', 'stakhanov'] else str(round(w['val'], 3))
                            awards_data[code].append({"nom": w['nom'], "val": val_fmt, "emoji": ref['emoji'], "award_name": ref['nom']})

            return jsonify({
                "nom_saison": nom,
                "classement_points": global_stats["classement_points"],
                "classement_moyenne": global_stats["classement_moyenne"],
                "awards": awards_data,
                "victory_condition": vic_cond
            })

@app.route('/dernier-tournoi')
def dernier_tournoi():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM Tournois ORDER BY date DESC LIMIT 1")
                dernier = cur.fetchone()
                resultats = []
                if dernier:
                    tournoi_id = dernier[0]
                    cur.execute("""
                        SELECT Joueurs.nom, Participations.score
                        FROM Participations
                        JOIN Joueurs ON Participations.joueur_id = Joueurs.id
                        WHERE Participations.tournoi_id = %s
                        ORDER BY Participations.score DESC
                    """, (tournoi_id,))
                    for nom, score in cur.fetchall():
                        resultats.append({"nom": nom, "score": score})
        return jsonify(resultats)
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/classement')
def classement():
    try:
        tier_filtre = request.args.get('tier', None)
        query = """
            SELECT 
                j.nom, j.mu, j.sigma, j.score_trueskill, j.tier,
                COUNT(p.tournoi_id) as nb_tournois,
                SUM(CASE WHEN p.position = 1 THEN 1 ELSE 0 END) as victoires
            FROM Joueurs j
            LEFT JOIN Participations p ON j.id = p.joueur_id
        """
        params = []
        if tier_filtre and tier_filtre.upper() in ['S', 'A', 'B', 'C']:
            query += " WHERE j.tier = %s"
            params.append(tier_filtre.upper())
            
        query += " GROUP BY j.id, j.nom, j.mu, j.sigma, j.score_trueskill, j.tier"
        query += " ORDER BY j.score_trueskill DESC NULLS LAST"
        
        joueurs = []
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(query, params)
                rows = cur.fetchall()
                total_joueurs = len(rows)
                for index, row in enumerate(rows):
                    nom, mu, sigma, score_trueskill, tier, nb_tournois, victoires = row
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
                        "percentile_trueskill": percentile
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

                cur.execute("SELECT id, mu, sigma, score_trueskill, tier, is_ranked, consecutive_missed FROM Joueurs WHERE nom = %s", (nom,))
                current_stats = cur.fetchone()

                if not current_stats:
                    return jsonify({"error": "Joueur non trouvé"}), 404

                jid, mu, sigma, score_trueskill, tier, is_ranked, consecutive_missed = current_stats
                
                safe_ts = float(score_trueskill) if score_trueskill is not None else 0.0
                sigma_val = float(sigma)
                missed_val = int(consecutive_missed) if consecutive_missed is not None else 0
                
                is_legit = (is_ranked and sigma_val <= threshold)
                top_percent = "?" 

                if is_legit:
                    cur.execute("""
                        SELECT score_trueskill 
                        FROM Joueurs 
                        WHERE is_ranked = true 
                        AND sigma <= %s
                    """, (threshold,))
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
                        else:
                            top_percent = 50.0
                    elif len(valid_scores) == 1:
                        top_percent = 1.0 
                
                cur.execute("""
                    SELECT t.id, t.date, p.score, p.position, p.new_score_trueskill, p.mu, p.sigma
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE j.nom = %s
                    ORDER BY t.date DESC
                """, (nom,))
                raw_history = cur.fetchall()

                cur.execute("""
                    SELECT g.date, g.old_sigma, g.new_sigma, j.mu
                    FROM ghost_log g
                    JOIN Joueurs j ON g.joueur_id = j.id
                    WHERE j.nom = %s
                    ORDER BY g.date DESC
                """, (nom,))
                raw_ghosts = cur.fetchall()

                cur.execute("SELECT date, value_applied FROM global_resets ORDER BY date DESC")
                raw_resets = cur.fetchall()

                historique_data = []
                scores_bruts = []
                positions = []
                victoires = 0
                
                for tid, date, score, position, hist_ts, h_mu, h_sigma in raw_history:
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
                        "score_trueskill": round(ts_val, 3)
                    })

                for g_date, old_sig, new_sig, current_mu in raw_ghosts:
                    ts_ghost = float(current_mu) - 3 * float(new_sig)
                    penalty_val = round(float(new_sig) - float(old_sig), 3)
                    historique_data.append({
                        "type": "absence", 
                        "date": g_date.strftime("%Y-%m-%d"),
                        "score": 0, 
                        "position": "-", 
                        "score_trueskill": round(ts_ghost, 3),
                        "valeur": penalty_val
                    })
                
                for r_date, val in raw_resets:
                    cur.execute("""
                        SELECT p.mu, p.sigma, t.date FROM Participations p
                        JOIN Tournois t ON p.tournoi_id = t.id
                        WHERE p.joueur_id = %s AND t.date < %s
                        ORDER BY t.date DESC LIMIT 1
                    """, (jid, r_date))
                    last_tournoi = cur.fetchone()

                    cur.execute("""
                        SELECT j.mu, g.new_sigma, g.date FROM ghost_log g
                        JOIN Joueurs j ON g.joueur_id = j.id
                        WHERE g.joueur_id = %s AND g.date < %s
                        ORDER BY g.date DESC LIMIT 1
                    """, (jid, r_date))
                    last_ghost = cur.fetchone()

                    ref_mu = 50.0
                    ref_sigma = 8.333
                    
                    if last_tournoi and last_ghost:
                        if last_tournoi[2] >= last_ghost[2]:
                            ref_mu, ref_sigma = float(last_tournoi[0]), float(last_tournoi[1])
                        else:
                            ref_mu, ref_sigma = float(last_ghost[0]), float(last_ghost[1])
                    elif last_tournoi:
                        ref_mu, ref_sigma = float(last_tournoi[0]), float(last_tournoi[1])
                    elif last_ghost:
                        ref_mu, ref_sigma = float(last_ghost[0]), float(last_ghost[1])
                    
                    ts_reset_calc = ref_mu - 3 * (ref_sigma + float(val))

                    historique_data.append({
                        "type": "reset",
                        "date": r_date.strftime("%Y-%m-%d"),
                        "score": 0,
                        "position": "-",
                        "score_trueskill": round(ts_reset_calc, 3), 
                        "valeur": val
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

                cur.execute("""
                    SELECT t.emoji, t.nom, t.description, COUNT(o.id)
                    FROM awards_obtenus o
                    JOIN types_awards t ON o.award_id = t.id
                    WHERE o.joueur_id = %s
                    GROUP BY t.emoji, t.nom, t.description
                """, (jid,))
                
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
                "percentile_trueskill": top_percent 
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
                cur.execute("SELECT nom FROM Joueurs ORDER BY score_trueskill DESC NULLS LAST")
                noms = [row[0] for row in cur.fetchall()]
        return jsonify(noms)
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
                        AVG(p.score) as score_moyen
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
                "score_moyen": round(float(row[6]), 1) if row[6] else 0.0
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
                    (SELECT j.nom FROM Participations p2 JOIN Joueurs j ON p2.joueur_id = j.id WHERE p2.tournoi_id = t.id ORDER BY p2.score DESC LIMIT 1)
                    FROM Tournois t JOIN Participations p ON t.id = p.tournoi_id GROUP BY t.id, t.date ORDER BY t.date DESC
                """)
                tournois = [{
                    "id": r[0], "date": r[1].strftime("%Y-%m-%d"), "nb_joueurs": r[2], "participants": r[2],
                    "score_max": r[3], "vainqueur": r[4] if r[4] else "Inconnu"
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
                    SELECT j.nom, p.score, p.new_score_trueskill, p.new_tier, p.position
                    FROM Participations p JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE p.tournoi_id = %s ORDER BY p.position ASC
                """, (tournoi_id,))
                res = [{
                    "nom": r[0], "score_tournoi": r[1],
                    "score_trueskill": round(float(r[2]), 3) if r[2] else 0,
                    "tier": r[3].strip() if r[3] else "?", "position": r[4]
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
                cur.execute("SELECT key, value FROM Configuration WHERE key IN ('tau', 'ghost_enabled', 'ghost_penalty', 'unranked_threshold', 'sigma_threshold')")
                rows = dict(cur.fetchall())
        return jsonify({
            "tau": float(rows.get('tau', 0.083)), 
            "ghost_enabled": rows.get('ghost_enabled', 'false') == 'true', 
            "ghost_penalty": float(rows.get('ghost_penalty', 0.1)),
            "unranked_threshold": int(rows.get('unranked_threshold', 10)),
            "sigma_threshold": float(rows.get('sigma_threshold', 4.0))
        })
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/admin/config', methods=['POST'])
@admin_required
def update_config():
    data = request.get_json()
    try:
        tau = float(data.get('tau'))
        ghost = str(data.get('ghost_enabled', False)).lower()
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
                    ('sigma_threshold', str(sigma_threshold))
                ]
                
                for k, v in configs:
                    cur.execute("INSERT INTO Configuration (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (k, v))
                
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
                cur.execute("SELECT id, nom, mu, sigma, tier, is_ranked, consecutive_missed FROM Joueurs ORDER BY nom ASC")
                joueurs = [{"id": r[0], "nom": r[1], "mu": r[2], "sigma": r[3], "tier": r[4].strip() if r[4] else "?", "is_ranked": r[5], "consecutive_missed": r[6] if r[6] is not None else 0} for r in cur.fetchall()]
        return jsonify(joueurs)
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/admin/joueurs/<int:id>', methods=['PUT'])
@admin_required
def api_update_joueur(id):
    data = request.get_json()
    try:
        mu, sigma, nom = float(data['mu']), float(data['sigma']), data['nom']
        is_ranked = bool(data.get('is_ranked', True))
        consecutive_missed = int(data.get('consecutive_missed', 0))
        
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE Joueurs SET nom=%s, mu=%s, sigma=%s, is_ranked=%s, consecutive_missed=%s WHERE id=%s", (nom, mu, sigma, is_ranked, consecutive_missed, id))
            conn.commit()
            recalculate_tiers()
        return jsonify({"status": "success"})
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 400

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
                cur.execute("SELECT id, nom, date_debut, date_fin, slug, config_awards, is_active, victory_condition, is_yearly FROM saisons ORDER BY date_fin DESC")
                saisons = []
                for r in cur.fetchall():
                    saisons.append({
                        "id": r[0], "nom": r[1], "date_debut": str(r[2]), "date_fin": str(r[3]),
                        "slug": r[4], "config": r[5] if r[5] else {}, "is_active": r[6],
                        "victory_condition": r[7], "is_yearly": r[8]
                    })
        return jsonify(saisons)
    
    if request.method == 'POST':
        data = request.get_json()
        nom, d_debut, d_fin = data.get('nom'), data.get('date_debut'), data.get('date_fin')
        victory_cond = data.get('victory_condition')
        is_yearly = bool(data.get('is_yearly', False))
        slug = slugify(nom)
        config_json = json.dumps({"active_awards": data.get('active_awards', [])})

        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
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

@app.route('/admin/saisons/<int:id>/save-awards', methods=['POST'])
@admin_required
def save_season_awards(id):
    """
    Fonction mère d'attribution et de sauvegarde des awards.
    """
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT date_debut, date_fin, config_awards, victory_condition, is_yearly FROM saisons WHERE id = %s", (id,))
            row = cur.fetchone()
            if not row: return jsonify({'error': 'Saison introuvable'}), 404
            
            d_debut, d_fin, config, vic_cond, is_yearly = row
            
            global_stats = _aggregate_season_stats(d_debut, d_fin)

            active_awards = config.get('active_awards', [])
            top_3, winners_map = _determine_winners(
                global_stats['candidates'], vic_cond, active_awards, global_stats['total_tournois']
            )

            _save_awards_to_db(conn, id, top_3, winners_map, is_yearly)

    return jsonify({'status': 'success', 'message': 'Saison publiée et awards distribués !'})

@app.route('/admin/joueurs', methods=['POST'])
@admin_required
def api_add_joueur():
    data = request.get_json()
    try:
        nom = data.get('nom')
        mu = float(data.get('mu', 50.0))
        sigma = float(data.get('sigma', 8.333))

        if not nom:
            return jsonify({"error": "Le nom du joueur est requis"}), 400

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM Joueurs WHERE nom = %s", (nom,))
                if cur.fetchone():
                    return jsonify({"error": "Ce nom de joueur existe déjà"}), 409

                cur.execute(
                    """INSERT INTO Joueurs (nom, mu, sigma, tier, is_ranked, consecutive_missed) 
                       VALUES (%s, %s, %s, 'U', true, 0)""", 
                    (nom, mu, sigma)
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
    date_tournoi_str, joueurs_data = data.get('date'), data.get('joueurs')

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
                    return jsonify({
                        "error": f"Impossible d'ajouter ce tournoi : Un 'Reset Global' a été appliqué à cette date ou ultérieurement. L'ajouter maintenant fausserait l'historique des calculs."
                    }), 409

                cur.execute("SELECT MAX(date) FROM Tournois")
                last_record = cur.fetchone()
                if last_record and last_record[0] and date_tournoi < last_record[0]:
                    return jsonify({"error": f"Date invalide. Le dernier tournoi date du {last_record[0]}."}), 400

                cur.execute("INSERT INTO Tournois (date) VALUES (%s) RETURNING id", (date_tournoi_str,))
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
                    if ghost_enabled and new_missed >= 4 and new_sig < 4.0:
                        new_sig += penalty_val
                        cur.execute("INSERT INTO ghost_log (joueur_id, tournoi_id, date, old_sigma, new_sigma, penalty_applied) VALUES (%s, %s, %s, %s, %s, %s)", (pid, tournoi_id, date_tournoi_str, sig, new_sig, penalty_val))
                    
                    new_is_ranked = is_r
                    if new_missed >= unranked_limit: new_is_ranked = False
                    cur.execute("UPDATE Joueurs SET sigma=%s, consecutive_missed=%s, is_ranked=%s WHERE id=%s", (new_sig, new_missed, new_is_ranked, pid))
            
            conn.commit()
            recalculate_tiers()
            
            try:
                env = os.environ.copy()
                env['PGPASSWORD'] = os.environ.get('POSTGRES_PASSWORD', '')
                cmd = f"pg_dump -h {os.environ.get('POSTGRES_HOST')} -U {os.environ.get('POSTGRES_USER')} {os.environ.get('POSTGRES_DB')} | gzip > /app/backups/backup_TOURNOI_{date_tournoi_str}_{datetime.now().strftime('%H-%M-%S')}.sql.gz"
                subprocess.run(cmd, shell=True, env=env)
            except Exception: pass
            
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
