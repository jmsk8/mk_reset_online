# backend.py
from flask import Flask, jsonify, request, abort
import psycopg2
import os # <-- NOUVEAU: Import pour les variables d'environnement
from trueskill import Rating, rate
import numpy as np
import functools
import bcrypt # <-- NOUVEAU: Import pour le hachage sécurisé
from flask import request, abort

app = Flask(__name__)

# --- Configuration: Récupération des secrets par variables d'environnement ---
# Les variables d'environnement seront fournies par le docker-compose.yml

# Configuration de la DB lue directement de l'environnement
db_config = {
    'dbname': os.environ.get('POSTGRES_DB', 'tournament_db'),
    'user': os.environ.get('POSTGRES_USER', 'username'),
    'password': os.environ.get('POSTGRES_PASSWORD', 'mypassword'),
    'host': os.environ.get('POSTGRES_HOST', 'localhost'),
    'port': os.environ.get('POSTGRES_PORT', '5432')
}

# Le HASH du mot de passe admin (lu directement de l'environnement)
# DOIT ÊTRE UN HASH BCrypt généré hors ligne.
DEFAULT_ADMIN_PASSWORD_HASH = b'$2b$12$L7R2eI3Mh1N4Xp3Xk2M0h.xW0Vp4h.P6m8Z9m8N3I7H6L5tQ.E0m1n8zI1cW0f1cI7Hl6L5tQ.' # HASH de secours (à remplacer par votre propre HASH)
ADMIN_PASSWORD_HASH_STR = os.environ.get('ADMIN_PASSWORD_HASH', DEFAULT_ADMIN_PASSWORD_HASH.decode('utf-8'))
ADMIN_PASSWORD_HASH = ADMIN_PASSWORD_HASH_STR.encode('utf-8')

# Le jeton admin statique (lu directement de l'environnement)
ADMIN_TOKEN = os.environ.get(
    'ADMIN_TOKEN', 
    "b31c9b1c48c2490189b0f49c7f542a2e" # Token de secours si non fourni
)


def admin_required(f):
    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        token = request.headers.get('X-Admin-Token', None)
        if token != ADMIN_TOKEN:
            abort(403)  # Forbidden
        return f(*args, **kwargs)
    return decorated_function

def get_db_connection():
    # Utilise la configuration chargée depuis l'environnement
    return psycopg2.connect(**db_config)

# --- Route d'authentification mise à jour avec BCrypt ---
@app.route('/admin-auth', methods=['POST'])
def admin_auth():
    data = request.get_json()
    password = data.get('password', '')
    
    # Le mot de passe de l'utilisateur doit être encodé en bytes pour bcrypt
    password_bytes = password.encode('utf-8')
    
    try:
        # Vérification sécurisée du mot de passe
        if bcrypt.checkpw(password_bytes, ADMIN_PASSWORD_HASH):
            # En cas de succès, on retourne le token
            return jsonify({"status": "success", "token": ADMIN_TOKEN})
        else:
            return jsonify({"status": "error", "message": "Mot de passe incorrect"}), 401
    except ValueError:
        return jsonify({"status": "error", "message": "Erreur de configuration du mot de passe"}), 500


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

    query = """
        SELECT nom, mu, sigma, score_trueskill, tier
        FROM Joueurs
    """
    params = []
    
    if tier_filtre and tier_filtre.upper() in ['S', 'A', 'B', 'C']:
        query += " WHERE tier = %s"
        params.append(tier_filtre.upper())

    query += " ORDER BY score_trueskill DESC"

    cur.execute(query, params)
    
    joueurs = []
    for nom, mu, sigma, score_trueskill, tier in cur.fetchall():
        # Arrondir pour l'affichage
        score_trueskill_arrondi = round(float(score_trueskill), 2) if score_trueskill is not None else 0.00
        
        joueurs.append({
            "nom": nom,
            "mu": float(mu),
            "sigma": float(sigma),
            "score_trueskill": score_trueskill_arrondi,
            "tier": tier.strip()
        })
        
    cur.close()
    conn.close()
    
    return jsonify(joueurs)

@app.route('/add-tournament', methods=['POST'])
@admin_required
def add_tournament():
    data = request.get_json()
    date = data.get('date')
    joueurs_data = data.get('joueurs')

    if not date or not joueurs_data:
        return jsonify({"error": "Date et liste de joueurs requises"}), 400

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        # 1. Créer le tournoi
        cur.execute("INSERT INTO Tournois (date) VALUES (%s) RETURNING id", (date,))
        tournoi_id = cur.fetchone()[0]

        # 2. Récupérer et mettre à jour les TrueSkill
        joueurs_ratings = {}
        joueurs_ratings_by_id = {}
        joueurs_scores = {}
        
        # Récupérer les ratings existants ou créer de nouveaux joueurs
        for joueur in joueurs_data:
            nom = joueur['nom']
            score = joueur['score']
            
            # Récupérer l'ID, mu, sigma
            cur.execute("SELECT id, mu, sigma FROM Joueurs WHERE nom = %s", (nom,))
            result = cur.fetchone()
            
            if result:
                joueur_id, mu, sigma = result
            else:
                # Créer un nouveau joueur s'il n'existe pas
                cur.execute("INSERT INTO Joueurs (nom) VALUES (%s) RETURNING id", (nom,))
                joueur_id = cur.fetchone()[0]
                mu, sigma = 25.0, 8.333 # Ratings par défaut

            # Stocker les données
            joueurs_ratings[nom] = Rating(mu=mu, sigma=sigma)
            joueurs_ratings_by_id[joueur_id] = Rating(mu=mu, sigma=sigma)
            joueurs_scores[nom] = score
            
            # Enregistrer la participation
            cur.execute("""
                INSERT INTO Participations (tournoi_id, joueur_id, score) 
                VALUES (%s, %s, %s)
            """, (tournoi_id, joueur_id, score))

        # 3. Calcul TrueSkill
        
        # Trier les joueurs par score du tournoi (classement du tournoi)
        sorted_joueurs = sorted(joueurs_data, key=lambda x: x['score'], reverse=True)
        
        # Convertir les scores en rangs. Les joueurs avec le même score ont le même rang.
        ranks = []
        current_rank = 1
        last_score = -1
        
        for i, joueur in enumerate(sorted_joueurs):
            if joueur['score'] < last_score:
                current_rank = i + 1
            ranks.append(current_rank)
            last_score = joueur['score']
        
        # Préparer les équipes (une équipe par joueur)
        teams = [[joueurs_ratings[j['nom']]] for j in sorted_joueurs]

        # Calculer les nouveaux ratings
        new_ratings_list = rate(teams, ranks=ranks)

        # 4. Mettre à jour la DB
        
        for i, joueur_data in enumerate(sorted_joueurs):
            nom = joueur_data['nom']
            new_rating = new_ratings_list[i][0]
            new_mu = new_rating.mu
            new_sigma = new_rating.sigma
            
            # Mettre à jour le Tier du joueur basé sur le nouveau score TrueSkill
            score_trueskill = new_mu - 3 * new_sigma
            if score_trueskill >= 40:
                new_tier = 'S'
            elif score_trueskill >= 30:
                new_tier = 'A'
            elif score_trueskill >= 20:
                new_tier = 'B'
            else:
                new_tier = 'C'

            cur.execute("""
                UPDATE Joueurs
                SET mu = %s, sigma = %s, tier = %s
                WHERE nom = %s
            """, (new_mu, new_sigma, new_tier, nom))
            
            # Stocker l'historique de la participation
            cur.execute("""
                UPDATE Participations
                SET mu = %s, sigma = %s, new_score_trueskill = %s, new_tier = %s, position = %s
                WHERE tournoi_id = %s AND joueur_id = (SELECT id FROM Joueurs WHERE nom = %s)
            """, (new_mu, new_sigma, score_trueskill, new_tier, ranks[i], tournoi_id, nom))

        conn.commit()
        return jsonify({"status": "success", "tournoi_id": tournoi_id}), 201

    except psycopg2.Error as e:
        conn.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        cur.close()
        conn.close()

# --- NOUVELLE ROUTE : Autocomplétion des noms de joueurs ---
@app.route('/joueurs/noms')
def get_joueur_names():
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("SELECT nom FROM Joueurs ORDER BY nom")
    noms = [row[0] for row in cur.fetchall()]
    
    cur.close()
    conn.close()
    
    return jsonify(noms)


# --- Routes de Statistiques (inchangées) ---

@app.route('/stats/joueur/<nom>')
def get_joueur_stats(nom):
    conn = get_db_connection()
    cur = conn.cursor()
    
    # Récupérer les stats actuelles
    cur.execute("""
        SELECT 
            mu, 
            sigma, 
            score_trueskill, 
            tier
        FROM 
            Joueurs 
        WHERE 
            nom = %s
    """, (nom,))
    
    current_stats = cur.fetchone()

    if not current_stats:
        cur.close()
        conn.close()
        return jsonify({"error": "Joueur non trouvé"}), 404

    mu, sigma, score_trueskill, tier = current_stats
    
    # Récupérer l'historique des tournois (pour le graphique)
    cur.execute("""
        SELECT 
            t.date, 
            p.new_score_trueskill,
            p.position
        FROM 
            Participations p
        JOIN 
            Tournois t ON p.tournoi_id = t.id
        JOIN
            Joueurs j ON p.joueur_id = j.id
        WHERE 
            j.nom = %s
        ORDER BY 
            t.date DESC
    """, (nom,))
    
    historique_data = []
    total_position = 0
    
    for date, score, position in cur.fetchall():
        historique_data.append({
            "date": date.strftime("%Y-%m-%d"),
            "score": round(float(score), 2) if score is not None else 0.00,
            "position": position
        })
        total_position += position
        
    # Calculer la position moyenne
    nb_tournois = len(historique_data)
    position_moyenne = total_position / nb_tournois if nb_tournois > 0 else 0

    # Calculer le percentile TrueSkill (pourcentage de joueurs en dessous)
    cur.execute("""
        SELECT 
            COUNT(id) 
        FROM 
            Joueurs 
        WHERE 
            score_trueskill <= %s
    """, (score_trueskill,))
    
    rank_count = cur.fetchone()[0]

    cur.execute("SELECT COUNT(id) FROM Joueurs WHERE score_trueskill IS NOT NULL")
    total_joueurs = cur.fetchone()[0]

    percentile = (rank_count / total_joueurs * 100) if total_joueurs > 0 else 0
    percentile = round(percentile, 1)

    cur.close()
    conn.close()

    return jsonify({
        "stats": {
            "mu": round(float(mu), 2),
            "sigma": round(float(sigma), 2),
            "score_trueskill": round(float(score_trueskill), 2),
            "tier": tier.strip(),
            "position_moyenne": round(position_moyenne, 2),
            "nb_tournois": nb_tournois,
            "percentile_trueskill": percentile
        },
        "historique": historique_data
    })

@app.route('/stats/joueurs')
def get_global_joueur_stats():
    conn = get_db_connection()
    cur = conn.cursor()
    
    # Top 10 des meilleures progressions
    cur.execute("""
        WITH JoueurEvolution AS (
            SELECT 
                j.id,
                j.nom,
                j.score_trueskill - 25.0 as progression, 
                j.tier
            FROM 
                Joueurs j
            WHERE 
                j.score_trueskill IS NOT NULL
        )
        SELECT 
            nom, 
            progression,
            tier
        FROM 
            JoueurEvolution
        ORDER BY 
            progression DESC
        LIMIT 10
    """)
    
    progressions = []
    for nom, progression, tier in cur.fetchall():
        progressions.append({
            "nom": nom,
            "progression": round(float(progression), 2),
            "tier": tier.strip()
        })
    
    # Distribution des tiers
    cur.execute("""
        SELECT 
            tier, 
            COUNT(*) as nombre
        FROM 
            Joueurs
        WHERE 
            tier IS NOT NULL
        GROUP BY 
            tier
        ORDER BY 
            CASE 
                WHEN tier = 'S' THEN 1
                WHEN tier = 'A' THEN 2
                WHEN tier = 'B' THEN 3
                WHEN tier = 'C' THEN 4
                ELSE 5
            END
    """)
    
    distribution_tiers = {}
    for tier, nombre in cur.fetchall():
        distribution_tiers[tier.strip()] = nombre
    
    cur.close()
    conn.close()
    
    return jsonify({
        "progressions": progressions,
        "distribution_tiers": distribution_tiers
    })

@app.route('/stats/tournois')
def get_tournois_list():
    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT 
            t.id, 
            t.date, 
            COUNT(p.joueur_id) as nb_joueurs,
            (
                SELECT j.nom FROM Participations p_sub
                JOIN Joueurs j ON p_sub.joueur_id = j.id
                WHERE p_sub.tournoi_id = t.id
                ORDER BY p_sub.score DESC
                LIMIT 1
            ) AS vainqueur
        FROM 
            Tournois t
        JOIN 
            Participations p ON t.id = p.tournoi_id
        GROUP BY 
            t.id, t.date
        ORDER BY 
            t.date DESC
    """)
    
    tournois = []
    for tournoi_id, date, nb_joueurs, vainqueur in cur.fetchall():
        tournois.append({
            "id": tournoi_id,
            "date": date.strftime("%Y-%m-%d"),
            "nb_joueurs": nb_joueurs,
            "vainqueur": vainqueur if vainqueur else "Inconnu"
        })

    cur.close()
    conn.close()
    return jsonify(tournois)


@app.route('/stats/tournoi/<int:tournoi_id>')
def get_tournoi_details(tournoi_id):
    conn = get_db_connection()
    cur = conn.cursor()

    # 1. Infos du tournoi
    cur.execute("SELECT date FROM Tournois WHERE id = %s", (tournoi_id,))
    tournoi_date = cur.fetchone()

    if not tournoi_date:
        cur.close()
        conn.close()
        abort(404)

    # 2. Résultats du tournoi
    cur.execute("""
        SELECT 
            j.nom, 
            p.score, 
            p.new_score_trueskill, 
            p.new_tier,
            p.position
        FROM 
            Participations p
        JOIN 
            Joueurs j ON p.joueur_id = j.id
        WHERE 
            p.tournoi_id = %s
        ORDER BY 
            p.position ASC
    """, (tournoi_id,))

    resultats = []
    for nom, score, trueskill_score, tier, position in cur.fetchall():
        resultats.append({
            "nom": nom,
            "score_tournoi": score,
            "score_trueskill": round(float(trueskill_score), 2) if trueskill_score is not None else 0.00,
            "tier": tier.strip(),
            "position": position
        })

    cur.close()
    conn.close()

    return jsonify({
        "date": tournoi_date[0].strftime("%Y-%m-%d"),
        "resultats": resultats
    })


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)
