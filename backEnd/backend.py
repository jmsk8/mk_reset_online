import os
import sys
import math
import logging
import functools
import psycopg2
import bcrypt
import subprocess
from datetime import datetime
from flask import Flask, jsonify, request, abort
from psycopg2 import pool
from trueskill import Rating, rate
from contextlib import contextmanager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

try:
    POSTGRES_DB = os.environ['POSTGRES_DB']
    POSTGRES_USER = os.environ['POSTGRES_USER']
    POSTGRES_PASSWORD = os.environ['POSTGRES_PASSWORD']
    POSTGRES_HOST = os.environ.get('POSTGRES_HOST', 'db')
    POSTGRES_PORT = os.environ.get('POSTGRES_PORT', '5432')
    ADMIN_TOKEN = os.environ['ADMIN_TOKEN']
    ADMIN_PASSWORD_HASH_STR = os.environ['ADMIN_PASSWORD_HASH']
    ADMIN_PASSWORD_HASH = ADMIN_PASSWORD_HASH_STR.encode('utf-8')
except KeyError as e:
    logger.critical(f"Variable d'environnement manquante : {e}")
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
    logger.critical(f"Erreur lors de la création du pool de connexion : {error}")
    sys.exit(1)

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
        if not token or token != ADMIN_TOKEN:
            abort(403)
        return f(*args, **kwargs)
    return decorated_function

def sync_sequences():
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            tables = ['Joueurs', 'Tournois']
            for table in tables:
                try:
                    seq_name = f"public.{table.lower()}_id_seq"
                    query = f"SELECT setval('{seq_name}', (SELECT MAX(id) FROM public.{table}))"
                    cur.execute(query)
                except Exception as e:
                    logger.error(f"Erreur sync_sequences : {e}")
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
                    if float(sigma) <= 4.15:
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
                    if sigma_val <= 4.15:
                        if score > (mean_score + std_dev): new_tier = 'S'
                        elif score > mean_score: new_tier = 'A'
                        elif score > (mean_score - std_dev): new_tier = 'B'
                        else: new_tier = 'C'
                    
                    cur.execute("UPDATE Joueurs SET tier = %s WHERE id = %s", (new_tier, pid))
            conn.commit()
        except Exception as e:
            logger.error(f"Erreur recalculate_tiers : {e}")
            conn.rollback()

def run_auto_backup(tournoi_date_str):
    """
    Lance une sauvegarde.
    Nom du fichier : backup_TOURNOI_YYYY-MM-DD_saved_at_HH-MM-SS.sql.gz
    """
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
        print(f"✅ Sauvegarde réussie pour le tournoi du {tournoi_date_str} : {filename}")
        
    except Exception as e:
        print(f"❌ Erreur sauvegarde auto : {e}")

@app.route('/admin-auth', methods=['POST'])
def admin_auth():
    data = request.get_json()
    password = data.get('password', '')
    password_bytes = password.encode('utf-8')
    try:
        if bcrypt.checkpw(password_bytes, ADMIN_PASSWORD_HASH):
            return jsonify({"status": "success", "token": ADMIN_TOKEN})
        else:
            return jsonify({"status": "error", "message": "Identifiants invalides"}), 401
    except ValueError:
        logger.error("Erreur configuration bcrypt")
        return jsonify({"status": "error", "message": "Erreur serveur"}), 500

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
    except Exception as e:
        logger.error(f"Erreur dernier_tournoi : {e}")
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/classement')
def classement():
    try:
        tier_filtre = request.args.get('tier', None)
        query = "SELECT nom, mu, sigma, score_trueskill, tier FROM Joueurs"
        params = []
        if tier_filtre and tier_filtre.upper() in ['S', 'A', 'B', 'C']:
            query += " WHERE tier = %s"
            params.append(tier_filtre.upper())
        query += " ORDER BY score_trueskill DESC"
        
        joueurs = []
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(query, params)
                for nom, mu, sigma, score_trueskill, tier in cur.fetchall():
                    score_ts = round(float(score_trueskill), 2) if score_trueskill is not None else 0.00
                    joueurs.append({
                        "nom": nom,
                        "mu": float(mu),
                        "sigma": float(sigma),
                        "score_trueskill": score_ts,
                        "tier": tier.strip() if tier else "?"
                    })
        return jsonify(joueurs)
    except Exception as e:
        logger.error(f"Erreur classement : {e}")
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/joueurs/noms')
def get_joueur_names():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT nom FROM Joueurs ORDER BY nom")
                noms = [row[0] for row in cur.fetchall()]
        return jsonify(noms)
    except Exception as e:
        logger.error(f"Erreur joueurs/noms : {e}")
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/stats/joueur/<nom>')
def get_joueur_stats(nom):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT mu, sigma, score_trueskill, tier FROM Joueurs WHERE nom = %s", (nom,))
                current_stats = cur.fetchone()

                if not current_stats:
                    return jsonify({"error": "Joueur non trouvé"}), 404

                mu, sigma, score_trueskill, tier = current_stats
                
                cur.execute("""
                    SELECT t.date, p.score, p.position, p.new_score_trueskill
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
                
                for date, score, position, hist_ts in raw_history:
                    s_val = float(score) if score is not None else 0.0
                    p_val = int(position) if position is not None else 0
                    ts_val = float(hist_ts) if hist_ts is not None else 0.0
                    
                    scores_bruts.append(s_val)
                    positions.append(p_val)
                    
                    if p_val == 1:
                        victoires += 1
                        
                    historique_data.append({
                        "date": date.strftime("%Y-%m-%d"),
                        "score": s_val,
                        "position": p_val,
                        "score_trueskill": round(ts_val, 2)
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
                cur.execute("SELECT COUNT(id) FROM Joueurs WHERE score_trueskill <= %s", (safe_ts,))
                rank_count = cur.fetchone()[0]
                cur.execute("SELECT COUNT(id) FROM Joueurs WHERE score_trueskill IS NOT NULL")
                total_joueurs = cur.fetchone()[0]
                percentile = (rank_count / total_joueurs * 100) if total_joueurs > 0 else 0

        return jsonify({
            "stats": {
                "mu": round(float(mu), 2) if mu else 25.0,
                "sigma": round(float(sigma), 2) if sigma else 8.333,
                "score_trueskill": round(safe_ts, 2),
                "tier": tier.strip() if tier else '?',
                "nombre_tournois": nb_tournois,
                "victoires": victoires,
                "ratio_victoires": round(ratio_victoires, 1),
                "score_moyen": round(score_moyen, 1),
                "meilleur_score": meilleur_score,
                "ecart_type_scores": round(ecart_type_scores, 1),
                "position_moyenne": round(position_moyenne, 1),
                "progression_recente": round(progression_recente, 2),
                "percentile_trueskill": round(percentile, 1)
            },
            "historique": historique_data
        })
    except Exception as e:
        logger.error(f"Erreur stats joueur : {e}")
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/stats/joueurs')
def get_global_joueur_stats():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    WITH JoueurEvolution AS (
                        SELECT nom, score_trueskill - 25.0 as progression, tier
                        FROM Joueurs WHERE score_trueskill IS NOT NULL
                    )
                    SELECT nom, progression, tier FROM JoueurEvolution ORDER BY progression DESC LIMIT 10
                """)
                progressions = [{"nom": r[0], "progression": round(float(r[1]), 2), "tier": r[2].strip() if r[2] else "?"} for r in cur.fetchall()]
                
                cur.execute("SELECT tier, COUNT(*) FROM Joueurs WHERE tier IS NOT NULL GROUP BY tier")
                dist = {r[0].strip(): r[1] for r in cur.fetchall()}
        return jsonify({"progressions": progressions, "distribution_tiers": dist})
    except Exception as e:
        logger.error(f"Erreur stats joueurs global : {e}")
        return jsonify({"error": "Erreur serveur"}), 500

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
    except Exception as e:
        logger.error(f"Erreur stats tournois : {e}")
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
                    "score_trueskill": round(float(r[2]), 2) if r[2] else 0,
                    "tier": r[3].strip() if r[3] else "?", "position": r[4]
                } for r in cur.fetchall()]
        return jsonify({"date": td[0].strftime("%Y-%m-%d"), "resultats": res})
    except Exception as e:
        logger.error(f"Erreur details tournoi : {e}")
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/add-tournament', methods=['POST'])
@admin_required
def add_tournament():
    data = request.get_json()
    date_tournoi = data.get('date')
    joueurs_data = data.get('joueurs')

    if not date_tournoi or not joueurs_data:
        return jsonify({"error": "Données incomplètes"}), 400

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute("INSERT INTO Tournois (date) VALUES (%s) RETURNING id", (date_tournoi,))
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
                            cur.execute("INSERT INTO Joueurs (nom, mu, sigma, tier) VALUES (%s, 25.0, 8.333, 'U') RETURNING id", (nom,))
                            jid = cur.fetchone()[0]
                            mu, sigma = 25.0, 8.333

                        joueurs_ratings[nom] = Rating(mu=float(mu), sigma=float(sigma))
                        joueurs_ids_map[nom] = jid
                        
                        cur.execute("INSERT INTO Participations (tournoi_id, joueur_id, score) VALUES (%s, %s, %s)", (tournoi_id, jid, score))

                    sorted_joueurs = sorted(joueurs_data, key=lambda x: x['score'], reverse=True)
                    ranks = []
                    last_s = -1
                    rank = 1
                    for i, j in enumerate(sorted_joueurs):
                        if j['score'] < last_s: rank = i + 1
                        ranks.append(rank)
                        last_s = j['score']
                    
                    teams = [[joueurs_ratings[j['nom']]] for j in sorted_joueurs]
                    new_ratings = rate(teams, ranks=ranks)

                    for i, j in enumerate(sorted_joueurs):
                        nr = new_ratings[i][0]
                        cur.execute("UPDATE Joueurs SET mu=%s, sigma=%s WHERE nom=%s", (nr.mu, nr.sigma, j['nom']))

                    for i, j in enumerate(sorted_joueurs):
                        nom = j['nom']
                        nr = new_ratings[i][0]
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
                run_auto_backup(date_tournoi)
                return jsonify({"status": "success", "tournoi_id": tournoi_id}), 201

            except psycopg2.Error as e:
                conn.rollback()
                logger.error(f"Erreur SQL add_tournament : {e}")
                return jsonify({"error": "Erreur base de données"}), 500
    except Exception as e:
        logger.error(f"Erreur add_tournament : {e}")
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/admin/joueurs', methods=['GET'])
@admin_required
def api_get_joueurs():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, nom, mu, sigma, tier FROM Joueurs ORDER BY nom ASC")
                joueurs = [{"id": r[0], "nom": r[1], "mu": r[2], "sigma": r[3], "tier": r[4].strip() if r[4] else "?"} for r in cur.fetchall()]
        return jsonify(joueurs)
    except Exception as e:
        logger.error(f"Erreur admin get joueurs : {e}")
        return jsonify({"error": "Erreur serveur"}), 500

@app.route('/admin/joueurs', methods=['POST'])
@admin_required
def api_add_joueur():
    data = request.get_json()
    try:
        nom = data['nom']
        mu = float(data.get('mu', 25.0))
        sigma = float(data.get('sigma', 8.333))
        
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO Joueurs (nom, mu, sigma, tier) VALUES (%s, %s, %s, 'U') RETURNING id", 
                            (nom, mu, sigma))
                new_id = cur.fetchone()[0]
            conn.commit()
            recalculate_tiers()
        
        return jsonify({"status": "success", "id": new_id}), 201
    except Exception as e:
        logger.error(f"Erreur admin add joueur : {e}")
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
    except Exception as e:
        logger.error(f"Erreur admin update joueur : {e}")
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
    except Exception as e:
        logger.error(f"Erreur admin delete joueur : {e}")
        return jsonify({"error": "Erreur serveur"}), 400

if __name__ == '__main__':
    try:
        sync_sequences()
        recalculate_tiers()
    except Exception as e:
        logger.error(f"Erreur démarrage : {e}")
    app.run(host='0.0.0.0', port=8080)
