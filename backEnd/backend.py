from flask import Flask, jsonify, request, abort
import psycopg2
import os
import math
from trueskill import Rating, rate
import functools
import bcrypt

app = Flask(__name__)

db_config = {
    'dbname': os.environ.get('POSTGRES_DB', 'tournament_db'),
    'user': os.environ.get('POSTGRES_USER', 'username'),
    'password': os.environ.get('POSTGRES_PASSWORD', 'mypassword'),
    'host': os.environ.get('POSTGRES_HOST', 'localhost'),
    'port': os.environ.get('POSTGRES_PORT', '5432')
}

DEFAULT_ADMIN_PASSWORD_HASH = b'$2b$12$L7R2eI3Mh1N4Xp3Xk2M0h.xW0Vp4h.P6m8Z9m8N3I7H6L5tQ.E0m1n8zI1cW0f1cI7Hl6L5tQ.'
ADMIN_PASSWORD_HASH_STR = os.environ.get('ADMIN_PASSWORD_HASH', DEFAULT_ADMIN_PASSWORD_HASH.decode('utf-8'))
ADMIN_PASSWORD_HASH = ADMIN_PASSWORD_HASH_STR.encode('utf-8')

ADMIN_TOKEN = os.environ.get('ADMIN_TOKEN', "b31c9b1c48c2490189b0f49c7f542a2e")

def admin_required(f):
    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        token = request.headers.get('X-Admin-Token', None)
        if token != ADMIN_TOKEN:
            abort(403)
        return f(*args, **kwargs)
    return decorated_function

def get_db_connection():
    return psycopg2.connect(**db_config)

def sync_sequences(conn):
    cur = conn.cursor()
    tables = ['Joueurs', 'Tournois']
    for table in tables:
        try:
            seq_name = f"public.{table.lower()}_id_seq"
            query = f"SELECT setval('{seq_name}', (SELECT MAX(id) FROM public.{table}))"
            cur.execute(query)
        except Exception:
            conn.rollback()
    conn.commit()
    cur.close()

def recalculate_tiers(conn):
    cur = conn.cursor()
    cur.execute("SELECT id, mu, sigma FROM Joueurs")
    all_players = cur.fetchall()
    
    valid_scores = []
    for pid, mu, sigma in all_players:
        if float(sigma) <= 4.15:
            score = float(mu) - (3 * float(sigma))
            valid_scores.append(score)
            
    if len(valid_scores) < 2:
        cur.close()
        return

    mean_score = sum(valid_scores) / len(valid_scores)
    variance = sum((x - mean_score) ** 2 for x in valid_scores) / len(valid_scores)
    std_dev = math.sqrt(variance)

    for pid, mu, sigma in all_players:
        mu = float(mu)
        sigma = float(sigma)
        score = mu - (3 * sigma)
        
        new_tier = 'U'
        if float(sigma) <= 4.15:
            if score > (mean_score + std_dev): new_tier = 'S'
            elif score > mean_score: new_tier = 'A'
            elif score > (mean_score - std_dev): new_tier = 'B'
            else: new_tier = 'C'
        
        cur.execute("UPDATE Joueurs SET tier = %s WHERE id = %s", (new_tier, pid))
    
    conn.commit()
    cur.close()

@app.route('/admin-auth', methods=['POST'])
def admin_auth():
    data = request.get_json()
    password = data.get('password', '')
    password_bytes = password.encode('utf-8')
    try:
        if bcrypt.checkpw(password_bytes, ADMIN_PASSWORD_HASH):
            return jsonify({"status": "success", "token": ADMIN_TOKEN})
        else:
            return jsonify({"status": "error", "message": "Mot de passe incorrect"}), 401
    except ValueError:
        return jsonify({"status": "error", "message": "Erreur configuration"}), 500

@app.route('/dernier-tournoi')
def dernier_tournoi():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id FROM Tournois ORDER BY date DESC LIMIT 1")
    dernier = cur.fetchone()
    if dernier:
        tournoi_id = dernier[0]
        cur.execute("""
            SELECT Joueurs.nom, Participations.score
            FROM Participations
            JOIN Joueurs ON Participations.joueur_id = Joueurs.id
            WHERE Participations.tournoi_id = %s
            ORDER BY Participations.score DESC
        """, (tournoi_id,))
        resultats = []
        for nom, score in cur.fetchall():
            resultats.append({"nom": nom, "score": score})
    else:
        resultats = []
    cur.close()
    conn.close()
    return jsonify(resultats)

@app.route('/classement')
def classement():
    conn = get_db_connection()
    cur = conn.cursor()
    tier_filtre = request.args.get('tier', None)
    query = "SELECT nom, mu, sigma, score_trueskill, tier FROM Joueurs"
    params = []
    if tier_filtre and tier_filtre.upper() in ['S', 'A', 'B', 'C']:
        query += " WHERE tier = %s"
        params.append(tier_filtre.upper())
    query += " ORDER BY score_trueskill DESC"
    cur.execute(query, params)
    joueurs = []
    for nom, mu, sigma, score_trueskill, tier in cur.fetchall():
        score_ts = round(float(score_trueskill), 2) if score_trueskill is not None else 0.00
        joueurs.append({
            "nom": nom,
            "mu": float(mu),
            "sigma": float(sigma),
            "score_trueskill": score_ts,
            "tier": tier.strip() if tier else "?"
        })
    cur.close()
    conn.close()
    return jsonify(joueurs)

@app.route('/joueurs/noms')
def get_joueur_names():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT nom FROM Joueurs ORDER BY nom")
    noms = [row[0] for row in cur.fetchall()]
    cur.close()
    conn.close()
    return jsonify(noms)

@app.route('/stats/joueur/<nom>')
def get_joueur_stats(nom):
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("SELECT mu, sigma, score_trueskill, tier FROM Joueurs WHERE nom = %s", (nom,))
    current_stats = cur.fetchone()

    if not current_stats:
        cur.close()
        conn.close()
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

    cur.close()
    conn.close()

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

@app.route('/stats/joueurs')
def get_global_joueur_stats():
    conn = get_db_connection()
    cur = conn.cursor()
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
    cur.close()
    conn.close()
    return jsonify({"progressions": progressions, "distribution_tiers": dist})

@app.route('/stats/tournois')
def get_tournois_list():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT t.id, t.date, COUNT(p.joueur_id), MAX(p.score),
        (SELECT j.nom FROM Participations p2 JOIN Joueurs j ON p2.joueur_id = j.id WHERE p2.tournoi_id = t.id ORDER BY p2.score DESC LIMIT 1)
        FROM Tournois t JOIN Participations p ON t.id = p.tournoi_id GROUP BY t.id, t.date ORDER BY t.date DESC
    """)
    tournois = [{
        "id": r[0], "date": r[1].strftime("%Y-%m-%d"), "nb_joueurs": r[2], "participants": r[2],
        "score_max": r[3], "vainqueur": r[4] if r[4] else "Inconnu"
    } for r in cur.fetchall()]
    cur.close()
    conn.close()
    return jsonify(tournois)

@app.route('/stats/tournoi/<int:tournoi_id>')
def get_tournoi_details(tournoi_id):
    conn = get_db_connection()
    cur = conn.cursor()
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
    cur.close()
    conn.close()
    return jsonify({"date": td[0].strftime("%Y-%m-%d"), "resultats": res})

@app.route('/add-tournament', methods=['POST'])
@admin_required
def add_tournament():
    data = request.get_json()
    date = data.get('date')
    joueurs_data = data.get('joueurs')

    if not date or not joueurs_data:
        return jsonify({"error": "Données incomplètes"}), 400

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute("INSERT INTO Tournois (date) VALUES (%s) RETURNING id", (date,))
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
        
        conn.commit()

        recalculate_tiers(conn)

        for i, j in enumerate(sorted_joueurs):
            nom = j['nom']
            nr = new_ratings[i][0]
            score_ts = nr.mu - 3 * nr.sigma
            
            cur.execute("SELECT tier FROM Joueurs WHERE nom = %s", (nom,))
            new_tier = cur.fetchone()[0]

            cur.execute("""
                UPDATE Participations SET mu=%s, sigma=%s, new_score_trueskill=%s, new_tier=%s, position=%s
                WHERE tournoi_id=%s AND joueur_id=%s
            """, (nr.mu, nr.sigma, score_ts, new_tier, ranks[i], tournoi_id, joueurs_ids_map[nom]))
        
        conn.commit()
        return jsonify({"status": "success", "tournoi_id": tournoi_id}), 201

    except psycopg2.Error as e:
        conn.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        cur.close()
        conn.close()

@app.route('/admin/joueurs', methods=['GET'])
@admin_required
def api_get_joueurs():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, nom, mu, sigma, tier FROM Joueurs ORDER BY nom ASC")
    joueurs = [{"id": r[0], "nom": r[1], "mu": r[2], "sigma": r[3], "tier": r[4].strip() if r[4] else "?"} for r in cur.fetchall()]
    cur.close()
    conn.close()
    return jsonify(joueurs)

@app.route('/admin/joueurs', methods=['POST'])
@admin_required
def api_add_joueur():
    data = request.get_json()
    try:
        nom = data['nom']
        mu = float(data.get('mu', 25.0))
        sigma = float(data.get('sigma', 8.333))
        
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("INSERT INTO Joueurs (nom, mu, sigma, tier) VALUES (%s, %s, %s, 'U') RETURNING id", 
                    (nom, mu, sigma))
        new_id = cur.fetchone()[0]
        conn.commit()
        
        recalculate_tiers(conn)
        
        cur.close()
        conn.close()
        return jsonify({"status": "success", "id": new_id}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route('/admin/joueurs/<int:id>', methods=['PUT'])
@admin_required
def api_update_joueur(id):
    data = request.get_json()
    try:
        mu = float(data['mu'])
        sigma = float(data['sigma'])
        nom = data['nom']
        
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("UPDATE Joueurs SET nom=%s, mu=%s, sigma=%s WHERE id=%s", (nom, mu, sigma, id))
        conn.commit()
        
        recalculate_tiers(conn)
        
        cur.close()
        conn.close()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route('/admin/joueurs/<int:id>', methods=['DELETE'])
@admin_required
def api_delete_joueur(id):
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM Joueurs WHERE id=%s", (id,))
        conn.commit()
        recalculate_tiers(conn) 
        cur.close()
        conn.close()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

if __name__ == '__main__':
    try:
        conn = get_db_connection()
        sync_sequences(conn)
        recalculate_tiers(conn)
        conn.close()
    except Exception:
        pass

    app.run(host='0.0.0.0', port=8080)
