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
from datetime import datetime, timedelta
from flask import Flask, jsonify, request, abort
from psycopg2 import pool
from contextlib import contextmanager
from flask import Flask, jsonify, request, abort, render_template

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

def slugify(value):
    """Nettoie le nom pour en faire une URL valide"""
    value = str(value)
    # Normalise les caractères (ex: é -> e)
    value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode('ascii')
    # Garde uniquement alphanumérique et tirets
    value = re.sub(r'[^\w\s-]', '', value).strip().lower()
    # Remplace les espaces par des tirets
    value = re.sub(r'[-\s]+', '-', value)
    return value

@app.route('/recap')
def recap_list():
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            # On récupère toutes les saisons actives (publiées)
            cur.execute("""
                SELECT nom, date_debut, date_fin, slug, victory_condition, is_yearly 
                FROM saisons 
                WHERE is_active = true 
                ORDER BY date_fin DESC
            """)
            rows = cur.fetchall()
            
            saisons = []
            for r in rows:
                saisons.append({
                    "nom": r[0],
                    "date_debut": r[1],
                    "date_fin": r[2],
                    "slug": r[3],
                    "victory_condition": r[4],
                    "is_yearly": r[5]
                })
    return render_template('recap_list.html', saisons=saisons)

@contextmanager
def get_db_connection():
    conn = db_pool.getconn()
    try:
        yield conn
    finally:
        db_pool.putconn(conn)

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
                cur.execute("SELECT id, mu, sigma, is_ranked FROM Joueurs")
                all_players = cur.fetchall()
                
                valid_scores = []
                for pid, mu, sigma, is_ranked in all_players:
                    if is_ranked and float(sigma) < 4.0:
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
                    
                    if is_ranked and sigma_val < 4.0:
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

def run_auto_backup(tournoi_date_str):
    try:
        backup_dir = "/app/backups"
        if not os.path.exists(backup_dir):
            os.makedirs(backup_dir, exist_ok=True)

        current_time = datetime.now().strftime("%H-%M-%S")
        filename = f"{backup_dir}/backup_TOURNOI_{tournoi_date_str}_saved_at_{current_time}.sql.gz"

        db_user = os.getenv('POSTGRES_USER')
        db_host = os.getenv('POSTGRES_HOST')
        db_name = os.getenv('POSTGRES_DB')
        db_password = os.getenv('POSTGRES_PASSWORD')

        env = os.environ.copy()
        env['PGPASSWORD'] = db_password
        
        cmd = f"pg_dump -h {db_host} -U {db_user} {db_name} | gzip > {filename}"
        subprocess.run(cmd, shell=True, env=env, check=True)
    except Exception:
        pass

def _compute_grand_master(stats_dict, total_tournois):
    """
    Calcule l'Indice de Performance (IP) pondéré avec Base Fixe.
    Affiche le détail complet de chaque calcul match par match.
    """
    seuil_participation = total_tournois * 0.50
    bonus_par_tournoi_extra = 0.3 
    BASE_POIDS = 5.0
    
    print(f"\n=== [DEBUG GM V8 - DÉTAIL COMPLET] Total Tournois: {total_tournois} | Seuil: {seuil_participation:.1f} ===", flush=True)

    candidates = []

    for pid, d in stats_dict.items():
        if d["matchs"] >= seuil_participation:
            
            print(f"\n>> ANALYSE JOUEUR : {d['nom'].upper()}", flush=True)
            print(f"   {'Date':<12} | {'Sc.':<4} / {'Moy.':<5} | {'Ratio':<5} | {'N+Base':<6} | {'Pts Gagnés'}", flush=True)
            print(f"   {'-'*60}", flush=True)

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
                
                t_date_str = m['date'].strftime("%d/%m") if m['date'] else "?"
                print(f"   {t_date_str:<12} | {S_i:<4} / {M_barre_i:<5.1f} | {ratio:<5.2f} | {N_i}+{int(BASE_POIDS)}= {int(poids):<2} | +{weighted_val:.2f}", flush=True)

            print(f"   {'-'*60}", flush=True)

            ip_base = (num_total / denom_total) * 100 if denom_total > 0 else 0
            
            matchs_extra = max(0, d["matchs"] - seuil_participation)
            bonus = matchs_extra * bonus_par_tournoi_extra
            
            final_score = ip_base + bonus

            print(f"   TOTAL SOMME : {num_total:.2f} / {denom_total:.2f} (Poids Total)", flush=True)
            print(f"   RESULTAT    : IP {ip_base:.2f} + Bonus {bonus:.1f} = {final_score:.2f}\n", flush=True)

            candidates.append({
                "id": pid,
                "nom": d["nom"],
                "nb_matchs": d["matchs"],
                "ip_base": ip_base,
                "bonus": bonus,
                "final_score": final_score
            })
    
    if not candidates:
        print("[DEBUG] Aucun candidat éligible.", flush=True)
        return None, []

    candidates.sort(key=lambda x: x["final_score"], reverse=True)

    winner_data = {
        "id": candidates[0]["id"],
        "nom": candidates[0]["nom"],
        "val": candidates[0]["final_score"], 
        "details": candidates[0]
    }
    
    print(f"--- VAINQUEUR : {winner_data['nom']} (IP: {winner_data['val']:.2f}) ---\n", flush=True)

    return winner_data, candidates


def calculate_season_stats_logic(date_debut, date_fin):
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
            cur.execute(query, (date_debut, date_fin))
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
                "history_ts": [], "start_stonks_ts": None,
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
            "tid": tid,
            "date": t_date,
            "score": score,
            "avg_score": t["avg_score"],
            "count": t["count"]
        })

        current_ts = float(new_ts) if new_ts else 0.0
        p["final_ts"] = current_ts
        p["start_stonks_ts"] = current_ts if p["start_stonks_ts"] is None else p["start_stonks_ts"]

    results = {
        "classement_points": [],
        "classement_moyenne": [],
        "awards": {},
        "candidates": {} # Stockage temporaire des candidats pour chaque award
    }
    
    # Listes brutes pour le tri
    raw_lists = { 
        "ez": [], "pas_loin": [], "stakhanov": [], 
        "stonks": [], "not_stonks": [], "chillguy": [],
        "grand_master": []
    }

    total_tournois_saison = len(tournoi_meta)
    
    # Calcul Grand Master (toujours calculé pour potentielle condition de victoire)
    winner_gm, list_gm = _compute_grand_master(stats, total_tournois_saison)
    raw_lists["grand_master"] = list_gm # Contient {id, final_score, ...}

    gm_score_map = { item['id']: item['final_score'] for item in list_gm }

    for pid, d in stats.items():
        moyenne_pts = d["total_points"] / d["matchs"] if d["matchs"] > 0 else 0
        moyenne_pos = d["total_position"] / d["matchs"] if d["matchs"] > 0 else 0
        score_gm_val = gm_score_map.get(pid)
        
        delta_ts = d["final_ts"] - d["start_stonks_ts"] if d["start_stonks_ts"] is not None else 0
        abs_delta = abs(delta_ts)
        
        # Données pour l'affichage tableau
        stat_entry = {
            "nom": d["nom"],
            "matchs": d["matchs"],
            "total_points": d["total_points"],
            "victoires": d["victoires"],
            "final_trueskill": round(d["final_ts"], 3),
            "moyenne_points": round(moyenne_pts, 2),
            "moyenne_position": round(moyenne_pos, 2),
            "score_gm": round(score_gm_val, 2) if score_gm_val is not None else None
        }
        results["classement_points"].append(stat_entry)
        results["classement_moyenne"].append(stat_entry)

        # Remplissage des listes candidates (sans filtrage pour l'instant)
        # EZ (Victoires)
        raw_lists["ez"].append({"id": pid, "nom": d["nom"], "val": d["victoires"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
        
        # Pas Loin (2èmes places)
        raw_lists["pas_loin"].append({"id": pid, "nom": d["nom"], "val": d["second_places"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
        
        # Stakhanov (Total Points)
        raw_lists["stakhanov"].append({"id": pid, "nom": d["nom"], "val": d["total_points"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
        
        # Stonks (Progression)
        if d["start_stonks_ts"] is not None:
             raw_lists["stonks"].append({"id": pid, "nom": d["nom"], "val": delta_ts, "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
             raw_lists["not_stonks"].append({"id": pid, "nom": d["nom"], "val": delta_ts, "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
        
        # Chillguy (Mouvement faible)
        if d["start_stonks_ts"] is not None:
            raw_lists["chillguy"].append({"id": pid, "nom": d["nom"], "val": abs_delta, "matchs": d["matchs"], "sigma": d["sigma_actuel"]})

    results["classement_points"].sort(key=lambda x: (x['total_points'], x['victoires']), reverse=True)
    results["classement_moyenne"].sort(key=lambda x: (x['score_gm'] if x['score_gm'] is not None else -1), reverse=True)
    
    results["candidates"] = raw_lists
    results["total_tournois"] = total_tournois_saison
    
    return results

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

@app.route('/admin/types-awards', methods=['GET'])
@admin_required
def get_admin_award_types():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT code, nom, emoji, description 
                    FROM types_awards 
                    WHERE code NOT LIKE %s AND code != 'grand_master'
                    ORDER BY nom ASC
                """, ('%moai',)) 
                
                awards = [{"code": r[0], "nom": r[1], "emoji": r[2], "description": r[3]} for r in cur.fetchall()]
        return jsonify(awards)
    except Exception as e:
        print(f"Erreur awards: {e}") # Ajout d'un print pour voir l'erreur dans les logs si ça se reproduit
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
                    config = r[5] if r[5] else {} 
                    saisons.append({
                        "id": r[0], "nom": r[1], "date_debut": str(r[2]), 
                        "date_fin": str(r[3]), "slug": r[4], "config": config,
                        "is_active": r[6], "victory_condition": r[7], "is_yearly": r[8]
                    })
        return jsonify(saisons)
    
    if request.method == 'POST':
        data = request.get_json()
        nom = data.get('nom')
        d_debut = data.get('date_debut')
        d_fin = data.get('date_fin')
        victory_cond = data.get('victory_condition')
        active_awards = data.get('active_awards', [])
        is_yearly = bool(data.get('is_yearly', False))
        
        slug = slugify(nom)
        
        config_json = json.dumps({"active_awards": active_awards})

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
    
    if request.method == 'POST':
        data = request.get_json()
        nom = data.get('nom')
        d_debut = data.get('date_debut')
        d_fin = data.get('date_fin')
        victory_cond = data.get('victory_condition')
        active_awards = data.get('active_awards', [])
        is_yearly = bool(data.get('is_yearly', False))
        
        slug = slugify(nom)
        config_json = json.dumps({"active_awards": active_awards})

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
    
    if request.method == 'POST':
        data = request.get_json()
        nom = data.get('nom')
        d_debut = data.get('date_debut')
        d_fin = data.get('date_fin')
        victory_cond = data.get('victory_condition')
        active_awards = data.get('active_awards', []) 
        
        slug = slugify(nom)
        config_json = json.dumps({"active_awards": active_awards})

        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """INSERT INTO saisons (nom, slug, date_debut, date_fin, config_awards, is_active, victory_condition) 
                           VALUES (%s, %s, %s, %s, %s, false, %s) RETURNING id""",
                        (nom, slug, d_debut, d_fin, config_json, victory_cond)
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
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            # 1. Récupérer la saison
            cur.execute("SELECT date_debut, date_fin, config_awards, victory_condition, is_yearly FROM saisons WHERE id = %s", (id,))
            row = cur.fetchone()
            if not row:
                return jsonify({'error': 'Saison introuvable'}), 404
            
            d_debut, d_fin, config, vic_cond, is_yearly = row
            
            # 2. Calcul des stats
            stats = calculate_season_stats_logic(d_debut, d_fin)
            candidates = stats['candidates']
            total_tournois = stats['total_tournois']

            # 3. Nettoyer les anciens awards
            cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s", (id,))
            
            # 4. Récupérer les ID des types d'awards
            cur.execute("SELECT code, id FROM types_awards")
            types_map = {r[0]: r[1] for r in cur.fetchall()}

            # --- GESTION DES MOAIS (PODIUM) ---
            top_players = []
            
            # CORRECTION ICI : On accepte 'grand_master' OU 'Indice de Performance'
            if vic_cond == 'grand_master' or vic_cond == 'Indice de Performance':
                top_players = candidates['grand_master']
            elif vic_cond == 'ez':
                sorted_list = sorted(candidates['ez'], key=lambda x: x['val'], reverse=True)
                top_players = [{"id": x['id'], "final_score": x['val']} for x in sorted_list]
            elif vic_cond == 'stakhanov':
                sorted_list = sorted(candidates['stakhanov'], key=lambda x: x['val'], reverse=True)
                top_players = [{"id": x['id'], "final_score": x['val']} for x in sorted_list]
            elif vic_cond == 'stonks':
                filtered = [c for c in candidates['stonks'] if float(c['sigma']) < 2.5]
                sorted_list = sorted(filtered, key=lambda x: x['val'], reverse=True)
                top_players = [{"id": x['id'], "final_score": x['val']} for x in sorted_list]

            # Choix des trophées (Annuels ou Saisonniers)
            moai_codes = ['super_gold_moai', 'super_silver_moai', 'super_bronze_moai'] if is_yearly else ['gold_moai', 'silver_moai', 'bronze_moai']

            for i in range(min(3, len(top_players))):
                player = top_players[i]
                code_award = moai_codes[i]
                
                if code_award in types_map:
                    award_id = types_map[code_award]
                    valeur_str = str(player['final_score'])
                    if isinstance(player['final_score'], float):
                        valeur_str = f"{player['final_score']:.3f}"

                    cur.execute("""
                        INSERT INTO awards_obtenus (joueur_id, saison_id, award_id, valeur)
                        VALUES (%s, %s, %s, %s)
                    """, (player['id'], id, award_id, valeur_str))

            # 5. Sauvegarde des Awards Spéciaux (Inchangé)
            active_list = config.get('active_awards', [])
            algos = ['ez', 'pas_loin', 'stakhanov', 'stonks', 'not_stonks', 'chillguy']

            for code in algos:
                if (code not in active_list) or (code == vic_cond):
                    continue
                
                raw_list = candidates.get(code, [])
                winners = []

                if code == 'ez':
                    if raw_list:
                        m = max(c['val'] for c in raw_list)
                        if m > 0: winners = [c for c in raw_list if c['val'] == m]
                elif code == 'pas_loin':
                    ez_winners_ids = [c['id'] for c in candidates.get('ez', []) if c['val'] == max([x['val'] for x in candidates['ez']] or [0])]
                    filtered = [c for c in raw_list if c['id'] not in ez_winners_ids]
                    if filtered:
                        m = max(c['val'] for c in filtered)
                        if m > 0: winners = [c for c in filtered if c['val'] == m]
                elif code == 'stakhanov':
                    if raw_list:
                        winners = [sorted(raw_list, key=lambda x: x['val'], reverse=True)[0]]
                elif code == 'stonks':
                    valid = [c for c in raw_list if float(c['sigma']) < 2.5 and c['matchs'] >= (total_tournois * 0.5)]
                    if valid:
                        w = sorted(valid, key=lambda x: x['val'], reverse=True)[0]
                        if w['val'] > 0.001: winners = [w]
                elif code == 'not_stonks':
                    valid = [c for c in raw_list if float(c['sigma']) < 2.5 and c['matchs'] >= (total_tournois * 0.5)]
                    if valid:
                        w = sorted(valid, key=lambda x: x['val'], reverse=False)[0]
                        if w['val'] < -0.001: winners = [w]
                elif code == 'chillguy':
                    valid = [c for c in raw_list if float(c['sigma']) < 2.5 and c['matchs'] > (total_tournois * 0.5) and c['val'] < 0.3]
                    if valid:
                        winners = [sorted(valid, key=lambda x: x['val'], reverse=False)[0]]

                if code in types_map:
                    a_id = types_map[code]
                    for w in winners:
                        val_str = str(int(w['val'])) if code in ['ez', 'pas_loin', 'stakhanov'] else str(round(w['val'], 3))
                        cur.execute("""
                            INSERT INTO awards_obtenus (joueur_id, saison_id, award_id, valeur)
                            VALUES (%s, %s, %s, %s)
                        """, (w['id'], id, a_id, val_str))

            cur.execute("UPDATE saisons SET is_active = true WHERE id = %s", (id,))
            conn.commit()
            
    return jsonify({'status': 'success', 'message': 'Saison publiée et awards distribués !'})

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

# Remplacer la route existante @app.route('/recap/<slug>') par celle-ci :

# Remplacer TOUTE la fonction get_recap par celle-ci dans backend.py

@app.route('/stats/recap/<slug>')
def get_recap(slug):
    # Log pour debug
    print(f"--- RECAP REQUEST: {slug} ---")
    
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            # 1. Récupérer les infos de la saison
            cur.execute("""
                SELECT id, nom, date_debut, date_fin, slug, config_awards, victory_condition, is_yearly 
                FROM saisons 
                WHERE slug = %s
            """, (slug,))
            saison_row = cur.fetchone()
            
            if not saison_row:
                return jsonify({"error": "Saison introuvable"}), 404

            saison_id, nom, d_debut, d_fin, slug_bdd, config, vic_cond, is_yearly = saison_row
            
            # 2. Calculer les statistiques
            stats = calculate_season_stats_logic(d_debut, d_fin)
            
            # 3. Récupérer les définitions des awards
            cur.execute("SELECT code, nom, emoji, description, id FROM types_awards")
            types_ref = {r[0]: {"nom": r[1], "emoji": r[2], "desc": r[3], "id": r[4]} for r in cur.fetchall()}

            # 4. Tenter de récupérer les awards SAUVEGARDÉS
            cur.execute("""
                SELECT t.code, t.nom, t.emoji, j.nom, a.valeur
                FROM awards_obtenus a
                JOIN types_awards t ON a.award_id = t.id
                JOIN joueurs j ON a.joueur_id = j.id
                WHERE a.saison_id = %s
            """, (saison_id,))
            
            saved_rows = cur.fetchall()
            awards_data = {}

            if saved_rows:
                # CAS 1 : En BDD
                for code, award_name, emoji, player_name, valeur in saved_rows:
                    if code not in awards_data: awards_data[code] = []
                    awards_data[code].append({
                        "nom": player_name, "val": valeur, "emoji": emoji, "award_name": award_name
                    })
            else:
                # CAS 2 : BROUILLON (Calcul à la volée)
                candidates = stats["candidates"]
                total_tournois = stats["total_tournois"]
                
                # A. Déterminer le Top 3 (Moais)
                top_players = []
                
                # CORRECTION ICI EGALEMENT
                if vic_cond == 'grand_master' or vic_cond == 'Indice de Performance':
                    top_players = candidates['grand_master']
                elif vic_cond == 'ez':
                    sorted_list = sorted(candidates['ez'], key=lambda x: x['val'], reverse=True)
                    top_players = [{"id": x['id'], "nom": x['nom'], "final_score": x['val']} for x in sorted_list]
                elif vic_cond == 'stakhanov':
                    sorted_list = sorted(candidates['stakhanov'], key=lambda x: x['val'], reverse=True)
                    top_players = [{"id": x['id'], "nom": x['nom'], "final_score": x['val']} for x in sorted_list]
                elif vic_cond == 'stonks':
                    filtered = [c for c in candidates['stonks'] if float(c['sigma']) < 2.5]
                    sorted_list = sorted(filtered, key=lambda x: x['val'], reverse=True)
                    top_players = [{"id": x['id'], "nom": x['nom'], "final_score": x['val']} for x in sorted_list]

                # B. Assigner les Moais (Virtuels)
                moai_codes = ['super_gold_moai', 'super_silver_moai', 'super_bronze_moai'] if is_yearly else ['gold_moai', 'silver_moai', 'bronze_moai']
                for i in range(min(3, len(top_players))):
                    p = top_players[i]
                    code_award = moai_codes[i]
                    if code_award in types_ref:
                        ref = types_ref[code_award]
                        if code_award not in awards_data: awards_data[code_award] = []
                        val_fmt = str(p['final_score'])
                        if isinstance(p['final_score'], float):
                            val_fmt = f"{p['final_score']:.3f}"
                            
                        awards_data[code_award].append({
                            "nom": p['nom'], "val": val_fmt, "emoji": ref['emoji'], "award_name": ref['nom']
                        })

                # C. Assigner les Awards Normaux (Logic inchangée)
                active_awards_codes = config.get('active_awards', [])
                algos = ['ez', 'pas_loin', 'stakhanov', 'stonks', 'not_stonks', 'chillguy']
                
                for code_algo in algos:
                    if (code_algo not in active_awards_codes) or (code_algo == vic_cond):
                        continue
                    
                    raw_list = candidates.get(code_algo, [])
                    filtered_list = []

                    if code_algo == 'ez':
                        if raw_list:
                            max_val = max(c['val'] for c in raw_list)
                            if max_val > 0: filtered_list = [c for c in raw_list if c['val'] == max_val]
                    elif code_algo == 'pas_loin':
                        ez_winners_ids = [c['id'] for c in candidates.get('ez', []) if c['val'] == max([x['val'] for x in candidates['ez']] or [0])]
                        raw_list = [c for c in raw_list if c['id'] not in ez_winners_ids]
                        if raw_list:
                            max_val = max(c['val'] for c in raw_list)
                            if max_val > 0: filtered_list = [c for c in raw_list if c['val'] == max_val]
                    elif code_algo == 'stakhanov':
                        if raw_list:
                            filtered_list = [sorted(raw_list, key=lambda x: x['val'], reverse=True)[0]]
                    elif code_algo == 'stonks':
                        valid = [c for c in raw_list if float(c['sigma']) < 2.5 and c['matchs'] >= (total_tournois * 0.5)]
                        if valid:
                            sorted_l = sorted(valid, key=lambda x: x['val'], reverse=True)
                            if sorted_l[0]['val'] > 0.001: filtered_list = [sorted_l[0]]
                    elif code_algo == 'not_stonks':
                        valid = [c for c in raw_list if float(c['sigma']) < 2.5 and c['matchs'] >= (total_tournois * 0.5)]
                        if valid:
                            sorted_l = sorted(valid, key=lambda x: x['val'], reverse=False)
                            if sorted_l[0]['val'] < -0.001: filtered_list = [sorted_l[0]]
                    elif code_algo == 'chillguy':
                        valid = [c for c in raw_list if float(c['sigma']) < 2.5 and c['matchs'] > (total_tournois * 0.5) and c['val'] < 0.3]
                        if valid:
                            filtered_list = [sorted(valid, key=lambda x: x['val'], reverse=False)[0]]

                    if code_algo in types_ref:
                        ref = types_ref[code_algo]
                        for winner in filtered_list:
                            val_fmt = str(int(winner['val'])) if code_algo in ['ez', 'pas_loin', 'stakhanov'] else str(round(winner['val'], 3))
                            if code_algo not in awards_data: awards_data[code_algo] = []
                            awards_data[code_algo].append({
                                "nom": winner['nom'], "val": val_fmt, "emoji": ref['emoji'], "award_name": ref['nom']
                            })

            saison_data = {
                "nom_saison": nom,
                "classement_points": stats["classement_points"],
                "classement_moyenne": stats["classement_moyenne"],
                "awards": awards_data,
                "victory_condition": vic_cond
            }

            return jsonify(saison_data)

@app.route('/admin/check-token', methods=['GET'])
@admin_required
def check_token():
    return jsonify({"status": "valid"}), 200

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

@app.route('/stats/joueur/<nom>')
def get_joueur_stats(nom):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                # 1. Infos principales du joueur
                cur.execute("SELECT id, mu, sigma, score_trueskill, tier, is_ranked FROM Joueurs WHERE nom = %s", (nom,))
                current_stats = cur.fetchone()

                if not current_stats:
                    return jsonify({"error": "Joueur non trouvé"}), 404

                jid, mu, sigma, score_trueskill, tier, is_ranked = current_stats
                
                safe_ts = float(score_trueskill) if score_trueskill is not None else 0.0
                sigma_val = float(sigma)
                
                # --- Calcul du Top % (Percentile) ---
                is_legit = (is_ranked and sigma_val < 4.0)
                top_percent = "?" 

                if is_legit:
                    cur.execute("""
                        SELECT score_trueskill 
                        FROM Joueurs 
                        WHERE is_ranked = true 
                        AND sigma < 4.0
                    """)
                    
                    rows = cur.fetchall()
                    valid_scores = [float(r[0]) for r in rows if r[0] is not None]
                    
                    if len(valid_scores) > 1:
                        mean = sum(valid_scores) / len(valid_scores)
                        variance = sum((x - mean) ** 2 for x in valid_scores) / len(valid_scores)
                        std_dev = math.sqrt(variance)
                        
                        if std_dev > 0.0001:
                            z_score = (safe_ts - mean) / std_dev
                            # Fonction d'erreur pour la distribution normale cumulée
                            cdf = 0.5 * (1 + math.erf(z_score / math.sqrt(2)))
                            top_val = (1 - cdf) * 100
                            top_percent = round(max(top_val, 0.01), 2)
                        else:
                            top_percent = 50.0

                    elif len(valid_scores) == 1:
                        top_percent = 1.0 
                
                # 2. Historique des Tournois
                cur.execute("""
                    SELECT t.id, t.date, p.score, p.position, p.new_score_trueskill, p.mu, p.sigma
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE j.nom = %s
                    ORDER BY t.date DESC
                """, (nom,))
                raw_history = cur.fetchall()

                # 3. Historique des Ghosts (Absences pénalisées)
                cur.execute("""
                    SELECT g.date, g.old_sigma, g.new_sigma, j.mu
                    FROM ghost_log g
                    JOIN Joueurs j ON g.joueur_id = j.id
                    WHERE j.nom = %s
                    ORDER BY g.date DESC
                """, (nom,))
                raw_ghosts = cur.fetchall()

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
                    if p_val == 1:
                        victoires += 1
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
                    historique_data.append({
                        "type": "absence",
                        "date": g_date.strftime("%Y-%m-%d"),
                        "score": 0, 
                        "position": "-",
                        "score_trueskill": round(ts_ghost, 3)
                    })
                
                # Fusion et tri par date
                historique_data.sort(key=lambda x: x['date'], reverse=True)

                # Calculs statistiques de base
                nb_tournois = len(scores_bruts)
                if nb_tournois > 0:
                    score_moyen = sum(scores_bruts) / nb_tournois
                    meilleur_score = max(scores_bruts)
                    position_moyenne = sum(positions) / nb_tournois
                    ratio_victoires = (victoires / nb_tournois) * 100
                    variance = sum((x - score_moyen) ** 2 for x in scores_bruts) / nb_tournois
                    ecart_type_scores = math.sqrt(variance)
                else:
                    score_moyen = 0
                    meilleur_score = 0
                    position_moyenne = 0
                    ratio_victoires = 0
                    ecart_type_scores = 0

                progression_recente = 0
                if nb_tournois >= 2:
                    current_ts_val = historique_data[0]['score_trueskill']
                    if len(historique_data) > 1:
                        prev_ts_val = historique_data[1]['score_trueskill']
                        progression_recente = current_ts_val - prev_ts_val

                # 4. Récupération des Awards (CORRIGÉ AVEC DESCRIPTION)
                cur.execute("""
                    SELECT t.emoji, t.nom, t.description, COUNT(o.id)
                    FROM awards_obtenus o
                    JOIN types_awards t ON o.award_id = t.id
                    WHERE o.joueur_id = %s
                    GROUP BY t.emoji, t.nom, t.description
                """, (jid,))
                
                # Construction de la liste avec la nouvelle clé 'description'
                awards_list = [
                    {
                        "emoji": r[0], 
                        "nom": r[1], 
                        "description": r[2],  # <-- C'est ça qui manquait
                        "count": r[3]
                    } 
                    for r in cur.fetchall()
                ]

        return jsonify({
            "stats": {
                "mu": round(float(mu), 3) if mu else 50.0,
                "sigma": round(float(sigma), 3) if sigma else 8.333,
                "score_trueskill": round(safe_ts, 3),
                "tier": tier.strip() if tier else '?',
                "is_ranked": is_ranked,
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
        print(f"ERREUR get_joueur_stats: {e}")
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

def get_tier_distribution_internal():
    """Fonction utilitaire pour récupérer la distribution des tiers sans route HTTP"""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT tier FROM joueurs")
                rows = cur.fetchall()
        
        dist = {'S': 0, 'A': 0, 'B': 0, 'C': 0, 'U': 0}
        
        for row in rows:
            tier = row[0]
            if tier in ['Unranked', '?', None, '']:
                tier = 'U'
            
            if tier in dist:
                dist[tier] += 1
            else:
                dist['U'] += 1
                
        return dist
    except Exception as e:
        print(f"Erreur distribution tiers: {e}")
        return {'S': 0, 'A': 0, 'B': 0, 'C': 0, 'U': 0}
    

@app.route('/stats/joueurs', methods=['GET'])
def stats_joueurs():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT 
                        j.nom, 
                        j.mu, 
                        j.sigma, 
                        j.tier,
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
            mu = row[1]
            sigma = row[2]
            ts = mu - 3 * sigma
            nb_tournois = row[4]
            victoires = row[5]
            score_moyen = float(row[6]) if row[6] is not None else 0.0
            
            joueurs.append({
                "nom": row[0],
                "score_trueskill": round(ts, 3),
                "tier": row[3],
                "nombre_tournois": nb_tournois,
                "victoires": victoires,
                "score_moyen": round(score_moyen, 1)
            })
        
        dist_data = get_tier_distribution_internal() 
        return jsonify({"joueurs": joueurs, "distribution_tiers": dist_data})

    except Exception as e:
        logger.error(f"Erreur stats_joueurs: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/stats/joueur/<nom>', methods=['GET'])
def stats_joueur_detail(nom):
    return get_joueur_stats(nom)

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

@app.route('/add-tournament', methods=['POST'])
@admin_required
def add_tournament():
    data = request.get_json()
    date_tournoi_str = data.get('date')
    joueurs_data = data.get('joueurs')

    if not date_tournoi_str or not joueurs_data:
        return jsonify({"error": "Données incomplètes"}), 400

    try:
        date_tournoi = datetime.strptime(date_tournoi_str, '%Y-%m-%d').date()
        date_jour = datetime.now().date()
        if date_tournoi > date_jour:
            return jsonify({"error": "Impossible d'ajouter un tournoi dans le futur."}), 400

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT MAX(date) FROM Tournois")
                last_record = cur.fetchone()
                last_date = last_record[0] if last_record else None
                if last_date and date_tournoi < last_date:
                    return jsonify({"error": f"Date invalide. Le dernier tournoi date du {last_date}."}), 400

                cur.execute("INSERT INTO Tournois (date) VALUES (%s) RETURNING id", (date_tournoi_str,))
                tournoi_id = cur.fetchone()[0]

                joueurs_ratings = {}
                joueurs_ids_map = {}
                
                for joueur in joueurs_data:
                    nom = joueur['nom']
                    score = joueur['score']
                    cur.execute("SELECT id, mu, sigma, is_ranked FROM Joueurs WHERE nom = %s", (nom,))
                    res = cur.fetchone()
                    if res:
                        jid, mu, sigma, is_r = res
                    else:
                        cur.execute("INSERT INTO Joueurs (nom, mu, sigma, tier, is_ranked) VALUES (%s, 50.0, 8.333, 'U', true) RETURNING id", (nom,))
                        jid = cur.fetchone()[0]
                        mu, sigma = 50.0, 8.333
                    joueurs_ratings[nom] = trueskill.Rating(mu=float(mu), sigma=float(sigma))
                    joueurs_ids_map[nom] = jid
                    cur.execute("""
                        INSERT INTO Participations (tournoi_id, joueur_id, score, old_mu, old_sigma) 
                        VALUES (%s, %s, %s, %s, %s)
                    """, (tournoi_id, jid, score, float(mu), float(sigma)))

                sorted_joueurs = sorted(joueurs_data, key=lambda x: x['score'], reverse=True)
                ranks = []
                last_s = -1
                rank = 1
                for i, j in enumerate(sorted_joueurs):
                    if j['score'] < last_s: rank = i + 1
                    ranks.append(rank)
                    last_s = j['score']
                
                teams = [[joueurs_ratings[j['nom']]] for j in sorted_joueurs]
                cur.execute("SELECT value FROM Configuration WHERE key = 'tau'")
                tau_res = cur.fetchone()
                tau_val = float(tau_res[0]) if tau_res else 0.083
                ts_env = trueskill.TrueSkill(mu=50.0, sigma=8.333, beta=4.167, tau=tau_val, draw_probability=0.1)
                new_ratings = ts_env.rate(teams, ranks=ranks)

                present_player_ids = []
                for i, j in enumerate(sorted_joueurs):
                    nom = j['nom']
                    nr = new_ratings[i][0]
                    jid = joueurs_ids_map[nom]
                    present_player_ids.append(jid)
                    
                    cur.execute("UPDATE Joueurs SET mu=%s, sigma=%s, consecutive_missed=0, is_ranked=true WHERE id=%s", (nr.mu, nr.sigma, jid))
                    
                    score_ts = nr.mu - 3 * nr.sigma
                    cur.execute("""
                        UPDATE Participations SET mu=%s, sigma=%s, new_score_trueskill=%s, position=%s
                        WHERE tournoi_id=%s AND joueur_id=%s
                    """, (nr.mu, nr.sigma, score_ts, ranks[i], tournoi_id, jid))

                cur.execute("SELECT key, value FROM Configuration WHERE key IN ('ghost_enabled', 'ghost_penalty', 'unranked_threshold')")
                conf_rows = dict(cur.fetchall())
                ghost_enabled = (conf_rows.get('ghost_enabled') == 'true')
                penalty_val = float(conf_rows.get('ghost_penalty', 0.1))
                unranked_limit = int(conf_rows.get('unranked_threshold', 10))

                if present_player_ids:
                    format_strings = ','.join(['%s'] * len(present_player_ids))
                    cur.execute(f"SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs WHERE id NOT IN ({format_strings})", tuple(present_player_ids))
                else:
                    cur.execute("SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs")
                
                absents = cur.fetchall()
                
                for pid, sig, missed, is_r in absents:
                    sig = float(sig)
                    missed = int(missed) if missed else 0
                    new_missed = missed + 1
                    
                    new_sig = sig
                    penalty = 0.0
                    
                    if ghost_enabled and new_missed >= 4:
                        if sig < 4.0:
                            penalty = penalty_val
                            new_sig = sig + penalty
                            cur.execute("""
                                INSERT INTO ghost_log (joueur_id, tournoi_id, date, old_sigma, new_sigma, penalty_applied)
                                VALUES (%s, %s, %s, %s, %s, %s)
                            """, (pid, tournoi_id, date_tournoi_str, sig, new_sig, penalty))

                    new_is_ranked = is_r
                    if new_missed >= unranked_limit:
                        new_is_ranked = False

                    cur.execute("UPDATE Joueurs SET sigma=%s, consecutive_missed=%s, is_ranked=%s WHERE id=%s", (new_sig, new_missed, new_is_ranked, pid))
            
            conn.commit()
            recalculate_tiers()
            run_auto_backup(date_tournoi_str)
            return jsonify({"status": "success", "tournoi_id": tournoi_id}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/admin/revert-last-tournament', methods=['POST'])
def revert_last_tournament():
    token = request.headers.get('Authorization')
    if not token:
         return jsonify({"error": "Unauthorized"}), 401
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT expires_at FROM api_tokens WHERE token = %s", (token,))
                res = cur.fetchone()
                if not res or datetime.now() > res[0]:
                    return jsonify({"error": "Unauthorized"}), 401
                cur.execute("SELECT id, date FROM Tournois ORDER BY date DESC, id DESC LIMIT 1")
                last_tournoi = cur.fetchone()
                if not last_tournoi:
                    return jsonify({"message": "Aucun tournoi à annuler."}), 404
                tournoi_id = last_tournoi[0]
                tournoi_date = last_tournoi[1]
                cur.execute("SELECT joueur_id, old_mu, old_sigma FROM Participations WHERE tournoi_id = %s", (tournoi_id,))
                participants = cur.fetchall()
                for p in participants:
                    if p[1] is None or p[2] is None:
                        return jsonify({"status": "error", "message": "Impossible d'annuler : Ce tournoi est trop ancien."}), 400
                run_auto_backup(f"PRE_REVERT_{tournoi_date}")
                
                for joueur_id, old_mu, old_sigma in participants:
                    cur.execute("UPDATE Joueurs SET mu=%s, sigma=%s WHERE id=%s", (old_mu, old_sigma, joueur_id))

                cur.execute("SELECT joueur_id, old_sigma, penalty_applied FROM ghost_log WHERE tournoi_id = %s", (tournoi_id,))
                ghosts = cur.fetchall()
                for pid, old_sig, penalty in ghosts:
                    cur.execute("UPDATE Joueurs SET sigma=%s WHERE id=%s", (old_sig, pid))
                
                cur.execute("UPDATE Joueurs SET consecutive_missed = GREATEST(0, consecutive_missed - 1)")

                cur.execute("DELETE FROM ghost_log WHERE tournoi_id = %s", (tournoi_id,))
                cur.execute("DELETE FROM Participations WHERE tournoi_id = %s", (tournoi_id,))
                cur.execute("DELETE FROM Tournois WHERE id = %s", (tournoi_id,))
            conn.commit()
            recalculate_tiers()
            run_auto_backup(f"POST_REVERT_{tournoi_date}")
            return jsonify({"status": "success", "message": "Dernier tournoi annulé et scores restaurés."}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/admin/joueurs', methods=['GET'])
@admin_required
def api_get_joueurs():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, nom, mu, sigma, tier, is_ranked FROM Joueurs ORDER BY nom ASC")
                joueurs = [{"id": r[0], "nom": r[1], "mu": r[2], "sigma": r[3], "tier": r[4].strip() if r[4] else "?", "is_ranked": r[5]} for r in cur.fetchall()]
        return jsonify(joueurs)
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/admin/joueurs/<int:id>', methods=['PUT'])
@admin_required
def api_update_joueur(id):
    data = request.get_json()
    try:
        mu = float(data['mu'])
        sigma = float(data['sigma'])
        nom = data['nom']
        
        is_ranked = bool(data.get('is_ranked', True)) 
        
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE Joueurs SET nom=%s, mu=%s, sigma=%s, is_ranked=%s WHERE id=%s", (nom, mu, sigma, is_ranked, id))
            conn.commit()
            recalculate_tiers()
            
        print(f"[UPDATE] Joueur {id} ({nom}) -> is_ranked={is_ranked}", flush=True)
        
        return jsonify({"status": "success"})
    except Exception as e:
        print(f"[ERROR] Update joueur: {e}", flush=True)
        return jsonify({"error": "Erreur serveur"}), 400

@app.route('/delete-tournament/<int:id>', methods=['DELETE'])
@admin_required
def delete_tournament(id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                # 1. Récupération Config Seuil
                cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
                res_conf = cur.fetchone()
                threshold = int(res_conf[0]) if res_conf else 10
                print(f"--- Suppression Tournoi {id} (Seuil Reactivation: {threshold}) ---")

                # 2. Revert Sigma (Pénalités Ghost)
                cur.execute("SELECT joueur_id, old_sigma FROM ghost_log WHERE tournoi_id = %s", (id,))
                ghost_penalties = cur.fetchall()
                for pid, old_sigma in ghost_penalties:
                    cur.execute("UPDATE Joueurs SET sigma = %s WHERE id = %s", (old_sigma, pid))
                    print(f"-> Sigma restauré pour joueur {pid}")

                # 3. Gestion Absences & Réactivation
                # Qui a joué ?
                cur.execute("SELECT joueur_id FROM Participations WHERE tournoi_id = %s", (id,))
                participants = [r[0] for r in cur.fetchall()]
                
                # Qui était absent ? (Tout le monde sauf les participants)
                if participants:
                    format_strings = ','.join(['%s'] * len(participants))
                    query = f"SELECT id, consecutive_missed, is_ranked, nom FROM Joueurs WHERE id NOT IN ({format_strings})"
                    cur.execute(query, tuple(participants))
                else:
                    cur.execute("SELECT id, consecutive_missed, is_ranked, nom FROM Joueurs")
                
                absents = cur.fetchall()

                for pid, missed_count, is_ranked, nom in absents:
                    # Sécurisation des valeurs (None -> 0 ou False)
                    current_missed = int(missed_count) if missed_count is not None else 0
                    current_is_ranked = bool(is_ranked)
                    
                    if current_missed > 0:
                        new_count = current_missed - 1
                        
                        # Logique de réactivation
                        new_is_ranked = current_is_ranked # Par défaut, on ne change rien
                        
                        # SI (Joueur désactivé) ET (Nouveau compteur < Seuil) => ON REACTIVE
                        if not current_is_ranked and new_count < threshold:
                            new_is_ranked = True
                            print(f"-> [REACTIVATION] {nom} (Absences: {current_missed} -> {new_count} < {threshold})")
                        elif not current_is_ranked:
                             print(f"-> [RESTE OFF] {nom} (Absences: {current_missed} -> {new_count} toujours >= {threshold})")
                        
                        # Mise à jour BDD
                        cur.execute("""
                            UPDATE Joueurs 
                            SET consecutive_missed = %s, is_ranked = %s 
                            WHERE id = %s
                        """, (new_count, new_is_ranked, pid))

                # 4. Suppression
                cur.execute("DELETE FROM Tournois WHERE id = %s", (id,))
            
            conn.commit()
            print("--- Fin Suppression ---")
            
            recalculate_tiers()
            
        return jsonify({"status": "success", "message": "Tournoi supprimé"})
    except Exception as e:
        print(f"ERREUR CRITIQUE DELETE: {e}")
        return jsonify({"error": str(e)}), 500

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

@app.route('/admin/config', methods=['GET'])
@admin_required
def get_config():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT key, value FROM Configuration WHERE key IN ('tau', 'ghost_enabled', 'ghost_penalty', 'unranked_threshold')")
                rows = dict(cur.fetchall())
                tau = float(rows.get('tau', 0.083))
                ghost = rows.get('ghost_enabled', 'false') == 'true'
                ghost_penalty = float(rows.get('ghost_penalty', 0.1))
                unranked_threshold = int(rows.get('unranked_threshold', 10))
        return jsonify({
            "tau": tau, 
            "ghost_enabled": ghost, 
            "ghost_penalty": ghost_penalty,
            "unranked_threshold": unranked_threshold
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
        
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO Configuration (key, value) VALUES ('tau', %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (str(tau),))
                cur.execute("INSERT INTO Configuration (key, value) VALUES ('ghost_enabled', %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (ghost,))
                cur.execute("INSERT INTO Configuration (key, value) VALUES ('ghost_penalty', %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (str(ghost_penalty),))
                cur.execute("INSERT INTO Configuration (key, value) VALUES ('unranked_threshold', %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (str(unranked_threshold),))
            conn.commit()
        return jsonify({"status": "success"})
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 400
    
if __name__ == '__main__':
    try:
        sync_sequences()
        recalculate_tiers()
    except Exception:
        pass
    app.run(host='0.0.0.0', port=8080)
