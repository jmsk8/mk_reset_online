import os
import sys
import math
import logging
import functools
import psycopg2
import bcrypt
import subprocess
import trueskill
import uuid
import re
import json
import unicodedata
from datetime import datetime, timedelta
from flask import Flask, jsonify, request, abort
from psycopg2 import pool
from contextlib import contextmanager

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
    return re.sub(r'[-\s]+', '-', value)

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
                cur.execute("SELECT id, mu, sigma FROM Joueurs")
                all_players = cur.fetchall()
                
                valid_scores = []
                for pid, mu, sigma in all_players:
                    if float(sigma) < 4.0:
                        score = float(mu) - (3 * float(sigma))
                        valid_scores.append(score)
                        
                if len(valid_scores) < 2:
                    return

                mean_score = sum(valid_scores) / len(valid_scores)
                variance = sum((x - mean_score) ** 2 for x in valid_scores) / len(valid_scores)
                std_dev = math.sqrt(variance)

                for pid, mu, sigma in all_players:
                    mu_val = float(mu)
                    sigma_val = float(sigma)
                    score = mu_val - (3 * sigma_val)
                    
                    new_tier = 'U'
                    if sigma_val < 4.0:
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
        except Exception:
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

def calculate_season_stats_logic(date_debut, date_fin):
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            query = """
                SELECT 
                    j.id, j.nom, p.score, p.position, p.new_score_trueskill, 
                    p.old_mu, p.old_sigma, p.mu, p.sigma
                FROM Participations p
                JOIN Tournois t ON p.tournoi_id = t.id
                JOIN Joueurs j ON p.joueur_id = j.id
                WHERE t.date >= %s AND t.date <= %s
                ORDER BY t.date ASC
            """
            cur.execute(query, (date_debut, date_fin))
            rows = cur.fetchall()

    data = {}
    for pid, nom, score, position, new_ts, old_mu, old_sigma, mu, sigma in rows:
        if pid not in data:
            start_ts = (float(old_mu) - 3*float(old_sigma)) if old_mu else 0.0
            data[pid] = {
                "id": pid, "nom": nom, "matchs": 0, "total_points": 0,
                "victoires": 0, "second_places": 0, "total_position": 0,
                "start_ts": start_ts, "final_ts": 0.0, "final_sigma": 8.333
            }
        
        p = data[pid]
        p["matchs"] += 1
        p["total_points"] += score
        p["total_position"] += position
        if position == 1: p["victoires"] += 1
        if position == 2: p["second_places"] += 1
        
        current_ts = float(new_ts) if new_ts else 0.0
        current_sigma = float(sigma) if sigma else 8.333
        p["final_ts"] = current_ts
        p["final_sigma"] = current_sigma

    results = {
        "classement_points": [],
        "classement_moyenne": [],
        "awards": {}
    }

    candidates = {
        "pas_loin": [], "stakhanov": [], "stonks": [], "not_stonks": [], "champion": []
    }

    for pid, d in data.items():
        moyenne_pts = d["total_points"] / d["matchs"] if d["matchs"] > 0 else 0
        moyenne_pos = d["total_position"] / d["matchs"] if d["matchs"] > 0 else 0
        delta_ts = d["final_ts"] - d["start_ts"]

        stat_entry = {
            "nom": d["nom"],
            "matchs": d["matchs"],
            "total_points": d["total_points"],
            "victoires": d["victoires"],
            "final_trueskill": round(d["final_ts"], 3),
            "delta_trueskill": round(delta_ts, 3),
            "moyenne_points": round(moyenne_pts, 2),
            "moyenne_position": round(moyenne_pos, 2)
        }
        results["classement_points"].append(stat_entry)
        results["classement_moyenne"].append(stat_entry)

        candidates["pas_loin"].append({"id": pid, "nom": d["nom"], "val": d["second_places"]})
        candidates["stakhanov"].append({"id": pid, "nom": d["nom"], "val": d["total_points"]})
        candidates["champion"].append({"id": pid, "nom": d["nom"], "val": d["victoires"]})
        
        if d["final_sigma"] < 2.5:
            candidates["stonks"].append({"id": pid, "nom": d["nom"], "val": delta_ts})
            candidates["not_stonks"].append({"id": pid, "nom": d["nom"], "val": delta_ts})

    results["classement_points"].sort(key=lambda x: (x['total_points'], x['victoires']), reverse=True)
    results["classement_moyenne"].sort(key=lambda x: x['moyenne_points'], reverse=True)

    def get_winner(cat_list, reverse=True, min_val=None):
        if not cat_list: return None
        cat_list.sort(key=lambda x: x['val'], reverse=reverse)
        winner = cat_list[0]
        if min_val is not None:
            if reverse and winner['val'] <= min_val: return None
            if not reverse and winner['val'] >= min_val: return None
        if winner['val'] == 0 and reverse: return None
        return winner

    results["awards"]["pas_loin"] = get_winner(candidates["pas_loin"])
    results["awards"]["stakhanov"] = get_winner(candidates["stakhanov"])
    results["awards"]["stonks"] = get_winner(candidates["stonks"], min_val=0)
    results["awards"]["not_stonks"] = get_winner(candidates["not_stonks"], reverse=False, min_val=0)
    results["awards"]["champion"] = get_winner(candidates["champion"])

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
                cur.execute("SELECT code, nom, emoji, description FROM types_awards ORDER BY nom ASC")
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
                cur.execute("SELECT id, nom, date_debut, date_fin, slug, config_awards, is_active, victory_condition FROM saisons ORDER BY date_fin DESC")
                saisons = []
                for r in cur.fetchall():
                    config = r[5] if r[5] else {} 
                    saisons.append({
                        "id": r[0], "nom": r[1], "date_debut": str(r[2]), 
                        "date_fin": str(r[3]), "slug": r[4], "config": config,
                        "is_active": r[6],
                        "victory_condition": r[7]
                    })
        return jsonify(saisons)
    
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
                cur.execute("DELETE FROM saisons WHERE id = %s", (saison_id,))
            conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/admin/saisons/<int:saison_id>/save-awards', methods=['POST'])
@admin_required
def save_season_awards(saison_id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT date_debut, date_fin, config_awards, victory_condition FROM saisons WHERE id = %s", (saison_id,))
                res = cur.fetchone()
                if not res: return jsonify({"error": "Saison introuvable"}), 404
                d_debut, d_fin, config, vic_cond = res
                
                active_awards = config.get('active_awards') if config else None

                stats = calculate_season_stats_logic(d_debut, d_fin)
                awards_calcules = stats.get("awards", {})

                cur.execute("SELECT code, id FROM types_awards")
                types_map = {r[0]: r[1] for r in cur.fetchall()}

                cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s", (saison_id,))
                
                count = 0
                
                if vic_cond and vic_cond in awards_calcules and awards_calcules[vic_cond]:
                    winner_data = awards_calcules[vic_cond]
                    if 'moai' in types_map:
                        cur.execute("""
                            INSERT INTO awards_obtenus (joueur_id, saison_id, award_id, valeur)
                            VALUES (%s, %s, %s, %s)
                        """, (winner_data['id'], saison_id, types_map['moai'], "Saison " + vic_cond))
                        count += 1

                for code_award, winner_data in awards_calcules.items():
                    if code_award == vic_cond:
                        continue

                    if active_awards is not None and code_award not in active_awards:
                        continue

                    if winner_data and code_award in types_map:
                        award_type_id = types_map[code_award]
                        joueur_id = winner_data['id']
                        valeur = str(round(winner_data['val'], 2))
                        
                        cur.execute("""
                            INSERT INTO awards_obtenus (joueur_id, saison_id, award_id, valeur)
                            VALUES (%s, %s, %s, %s)
                        """, (joueur_id, saison_id, award_type_id, valeur))
                        count += 1
                
                cur.execute("UPDATE saisons SET is_active = true WHERE id = %s", (saison_id,))
            conn.commit()
        return jsonify({"status": "success", "message": f"Saison publiée ! {count} awards (dont Moai) sauvegardés"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

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

@app.route('/stats/recap/<season_slug>')
def get_recap_season(season_slug):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, nom, date_debut, date_fin, config_awards, is_active, victory_condition FROM saisons WHERE slug = %s", (season_slug,))
                res = cur.fetchone()
        
        if not res: return jsonify({"error": "Saison inconnue"}), 404
        
        s_id, s_nom, s_debut, s_fin, config, is_active, vic_cond = res
        
        recap_data = calculate_season_stats_logic(s_debut, s_fin)
        recap_data["nom_saison"] = s_nom
        recap_data["victory_condition"] = vic_cond

        active_awards = config.get('active_awards') if config else None
        if active_awards is not None:
            filtered_awards = {k: v for k, v in recap_data["awards"].items() if k in active_awards}
            recap_data["awards"] = filtered_awards

        return jsonify(recap_data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

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
                cur.execute("SELECT id, mu, sigma, score_trueskill, tier FROM Joueurs WHERE nom = %s", (nom,))
                current_stats = cur.fetchone()

                if not current_stats:
                    return jsonify({"error": "Joueur non trouvé"}), 404

                jid, mu, sigma, score_trueskill, tier = current_stats
                
                cur.execute("""
                    SELECT t.id, t.date, p.score, p.position, p.new_score_trueskill
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE j.nom = %s
                    ORDER BY t.date DESC
                """, (nom,))
                
                raw_history = cur.fetchall()
                historique_data = []
                scores_bruts = []
                positions = []
                victoires = 0
                
                for tid, date, score, position, hist_ts in raw_history:
                    s_val = float(score) if score is not None else 0.0
                    p_val = int(position) if position is not None else 0
                    ts_val = float(hist_ts) if hist_ts is not None else 0.0
                    scores_bruts.append(s_val)
                    positions.append(p_val)
                    if p_val == 1:
                        victoires += 1
                    historique_data.append({
                        "id": tid,
                        "date": date.strftime("%Y-%m-%d"),
                        "score": s_val,
                        "position": p_val,
                        "score_trueskill": round(ts_val, 3)
                    })

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
                    index_prev = min(4, nb_tournois - 1)
                    prev_ts_val = historique_data[index_prev]['score_trueskill']
                    if prev_ts_val > 0: 
                        progression_recente = current_ts_val - prev_ts_val

                safe_ts = float(score_trueskill) if score_trueskill is not None else 0.0
                cur.execute("SELECT COUNT(id) FROM Joueurs WHERE score_trueskill > %s", (safe_ts,))
                better_players_count = cur.fetchone()[0]
                cur.execute("SELECT COUNT(id) FROM Joueurs WHERE score_trueskill IS NOT NULL")
                total_joueurs = cur.fetchone()[0]
                
                rank = better_players_count + 1
                top_percent = (rank / total_joueurs * 100) if total_joueurs > 0 else 100

                cur.execute("""
                    SELECT t.emoji, t.nom, COUNT(o.id)
                    FROM awards_obtenus o
                    JOIN types_awards t ON o.award_id = t.id
                    WHERE o.joueur_id = %s
                    GROUP BY t.emoji, t.nom
                """, (jid,))
                awards_list = [{"emoji": r[0], "nom": r[1], "count": r[2]} for r in cur.fetchall()]

        return jsonify({
            "stats": {
                "mu": round(float(mu), 3) if mu else 50.0,
                "sigma": round(float(sigma), 3) if sigma else 8.333,
                "score_trueskill": round(safe_ts, 3),
                "tier": tier.strip() if tier else '?',
                "nombre_tournois": nb_tournois,
                "victoires": victoires,
                "ratio_victoires": round(ratio_victoires, 1),
                "score_moyen": round(score_moyen, 3),
                "meilleur_score": meilleur_score,
                "ecart_type_scores": round(ecart_type_scores, 3),
                "position_moyenne": round(position_moyenne, 1),
                "progression_recente": round(progression_recente, 3),
                "percentile_trueskill": round(top_percent, 1)
            },
            "historique": historique_data,
            "awards": awards_list
        })
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

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
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, tier, mu, sigma FROM joueurs WHERE nom = %s", (nom,))
                joueur = cur.fetchone()
                
                if not joueur:
                    return jsonify({"error": "Joueur introuvable"}), 404
                
                jid, tier, mu, sigma = joueur
                ts = mu - 3 * sigma
                
                cur.execute("""
                    SELECT 
                        COUNT(*), 
                        COALESCE(SUM(CASE WHEN position = 1 THEN 1 ELSE 0 END), 0),
                        AVG(position)
                    FROM participations WHERE joueur_id = %s
                """, (jid,))
                
                stats_row = cur.fetchone()
                nb_tournois = stats_row[0]
                victoires = stats_row[1]
                
                pos_moy = float(stats_row[2]) if stats_row[2] is not None else 0.0

                cur.execute("""
                    SELECT t.date, p.score, p.position, p.new_score_trueskill, p.new_tier
                    FROM participations p
                    JOIN tournois t ON p.tournoi_id = t.id
                    WHERE p.joueur_id = %s
                    ORDER BY t.date ASC
                """, (jid,))
                
                historique = []
                for row in cur.fetchall():
                    historique.append({
                        "date": row[0].isoformat(),
                        "score_tournoi": row[1],
                        "position": row[2],
                        "trueskill": round(float(row[3]), 3),
                        "tier": row[4].strip() if row[4] else "U"
                    })
                

                cur.execute("""
                    SELECT ta.emoji, ta.nom, ao.valeur, s.nom
                    FROM awards_obtenus ao
                    JOIN types_awards ta ON ao.award_id = ta.id
                    JOIN saisons s ON ao.saison_id = s.id
                    WHERE ao.joueur_id = %s
                """, (jid,))
                
                awards = []
                for row in cur.fetchall():
                    awards.append({
                        "emoji": row[0], 
                        "nom": row[1], 
                        "valeur": row[2], 
                        "saison": row[3]
                    })

        return jsonify({
            "stats": {
                "nom": nom,
                "tier": tier.strip() if tier else "U",
                "trueskill": round(float(ts), 3),
                "nb_tournois": nb_tournois,
                "victoires": victoires,
                "position_moyenne": round(pos_moy, 1)
            },
            "historique": historique,
            "awards": awards
        })

    except Exception as e:
        logger.error(f"Erreur CRITIQUE dans stats_joueur_detail: {e}")
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
                    cur.execute("SELECT id, mu, sigma FROM Joueurs WHERE nom = %s", (nom,))
                    res = cur.fetchone()
                    if res:
                        jid, mu, sigma = res
                    else:
                        cur.execute("INSERT INTO Joueurs (nom, mu, sigma, tier) VALUES (%s, 50.0, 8.333, 'U') RETURNING id", (nom,))
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

                for i, j in enumerate(sorted_joueurs):
                    nom = j['nom']
                    nr = new_ratings[i][0]
                    cur.execute("UPDATE Joueurs SET mu=%s, sigma=%s WHERE nom=%s", (nr.mu, nr.sigma, nom))
                    score_ts = nr.mu - 3 * nr.sigma
                    cur.execute("SELECT tier FROM Joueurs WHERE nom = %s", (nom,))
                    res_tier = cur.fetchone()
                    new_tier = res_tier[0] if res_tier else 'U'
                    cur.execute("""
                        UPDATE Participations SET mu=%s, sigma=%s, new_score_trueskill=%s, new_tier=%s, position=%s
                        WHERE tournoi_id=%s AND joueur_id=%s
                    """, (nr.mu, nr.sigma, score_ts, new_tier, ranks[i], tournoi_id, joueurs_ids_map[nom]))
            
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
                cur.execute("SELECT id, nom, mu, sigma, tier FROM Joueurs ORDER BY nom ASC")
                joueurs = [{"id": r[0], "nom": r[1], "mu": r[2], "sigma": r[3], "tier": r[4].strip() if r[4] else "?"} for r in cur.fetchall()]
        return jsonify(joueurs)
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/admin/joueurs', methods=['POST'])
@admin_required
def api_add_joueur():
    data = request.get_json()
    try:
        nom = data['nom']
        mu = float(data.get('mu', 50.0))
        sigma = float(data.get('sigma', 8.333))
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO Joueurs (nom, mu, sigma, tier) VALUES (%s, %s, %s, 'U') RETURNING id", 
                            (nom, mu, sigma))
                new_id = cur.fetchone()[0]
            conn.commit()
            recalculate_tiers()
        return jsonify({"status": "success", "id": new_id}), 201
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 400

@app.route('/admin/joueurs/<int:id>', methods=['PUT'])
@admin_required
def api_update_joueur(id):
    data = request.get_json()
    try:
        mu = float(data['mu'])
        sigma = float(data['sigma'])
        nom = data['nom']
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE Joueurs SET nom=%s, mu=%s, sigma=%s WHERE id=%s", (nom, mu, sigma, id))
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

@app.route('/admin/config', methods=['GET'])
@admin_required
def get_config():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'tau'")
                res = cur.fetchone()
                tau = float(res[0]) if res else 0.083
        return jsonify({"tau": tau})
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/admin/config', methods=['POST'])
@admin_required
def update_config():
    data = request.get_json()
    try:
        tau = float(data.get('tau'))
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO Configuration (key, value) VALUES ('tau', %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (str(tau),))
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
