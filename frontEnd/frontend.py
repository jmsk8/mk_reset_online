import os
import sys
import logging
import requests
from flask import Flask, render_template, request, redirect, url_for, session, flash, jsonify
from datetime import timedelta
from flask_wtf.csrf import CSRFProtect

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

try:
    app.secret_key = os.environ['SECRET_KEY']
    BACKEND_URL = os.environ.get('BACKEND_URL', 'http://backend:8080')
except KeyError as e:
    logger.critical(f"Variable d'environnement manquante : {e}")
    sys.exit(1)

app.permanent_session_lifetime = timedelta(minutes=30)
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

csrf = CSRFProtect(app)

def backend_request(method, endpoint, data=None, params=None, headers=None):
    url = f"{BACKEND_URL}{endpoint}"
    try:
        if method == 'GET':
            response = requests.get(url, params=params, headers=headers, timeout=5)
        elif method == 'POST':
            response = requests.post(url, json=data, headers=headers, timeout=5)
        elif method == 'PUT':
            response = requests.put(url, json=data, headers=headers, timeout=5)
        elif method == 'DELETE':
            response = requests.delete(url, headers=headers, timeout=5)
        else:
            return None, 405
        
        try:
            return response.json(), response.status_code
        except ValueError:
            return response.text, response.status_code
            
    except requests.exceptions.RequestException as e:
        logger.error(f"Erreur connexion backend ({endpoint}): {e}")
        return None, 503

@app.route('/')
def index():
    data, status = backend_request('GET', '/dernier-tournoi')
    resultats = data if status == 200 and isinstance(data, list) else []
    return render_template("index.html", resultats=resultats)

@app.route('/classement')
def classement():
    tier = request.args.get('tier')
    params = {'tier': tier} if tier else {}
    data, status = backend_request('GET', '/classement', params=params)
    
    if status == 200 and isinstance(data, list):
        joueurs = data
        def sort_key(j):
            tier_val = j.get('tier', '').strip()
            is_ranked = tier_val not in ['U', '?', 'Unranked']
            try:
                score = float(j.get('score_trueskill', 0))
            except (ValueError, TypeError):
                score = 0.0
            return (is_ranked, score)
        joueurs.sort(key=sort_key, reverse=True)
    else:
        joueurs = []
        flash('Erreur lors du chargement du classement', 'warning')

    return render_template("classement.html", joueurs=joueurs, tier_actif=tier)

@app.route('/stats/joueur/<nom>')
def stats_joueur_detail(nom):
    data, status = backend_request('GET', f'/stats/joueur/{nom}')
    
    if status == 200:
        return render_template(
            "stats_joueur.html", 
            nom=nom,
            stats=data.get('stats', {}),
            historique=data.get('historique', [])
        )
    elif status == 404:
        flash(f"Joueur '{nom}' non trouvé.", "warning")
        return redirect(url_for('classement'))
    else:
        flash("Erreur lors de la récupération des statistiques.", "danger")
        return redirect(url_for('classement'))

@app.route('/admin', methods=['GET', 'POST'])
def admin_login():
    if request.method == 'POST':
        password = request.form.get('password')
        data, status = backend_request('POST', '/admin-auth', data={"password": password})
        
        if status == 200 and data.get("status") == "success":
            session.permanent = True
            session['admin_token'] = data.get("token")
            flash('Connexion réussie', 'success')
            return redirect(url_for('add_tournament'))
        else:
            flash('Mot de passe incorrect', 'danger')
            
    return render_template("admin_login.html")

@app.route('/admin/logout')
def admin_logout():
    session.pop('admin_token', None)
    flash('Vous avez été déconnecté', 'info')
    return redirect(url_for('index'))

@app.route('/add_tournament', methods=['GET', 'POST'])
def add_tournament():
    if 'admin_token' not in session:
        flash('Accès réservé aux administrateurs', 'warning')
        return redirect(url_for('admin_login'))

    if request.method == 'POST':
        date_tournoi = request.form.get('date')
        joueurs_data = []
        i = 1
        while True:
            nom = request.form.get(f'nom{i}')
            score = request.form.get(f'score{i}')
            if not nom or not score:
                break
            try:
                joueurs_data.append({"nom": nom, "score": int(score)})
            except ValueError:
                flash(f"Score invalide pour {nom}", "danger")
                return redirect(url_for('add_tournament'))
            i += 1
            
        if len(joueurs_data) < 2:
            flash("Il faut au moins 2 joueurs.", "warning")
            return redirect(url_for('add_tournament'))

        headers = {'X-Admin-Token': session['admin_token']}
        payload = {"date": date_tournoi, "joueurs": joueurs_data}
        
        _, status = backend_request('POST', '/add-tournament', data=payload, headers=headers)
        
        if status == 201:
            flash('Tournoi ajouté avec succès !', 'success')
            return redirect(url_for('confirmation'))
        elif status == 403:
            flash('Session expirée.', 'danger')
            return redirect(url_for('admin_logout'))
        else:
            flash('Erreur lors de l\'ajout du tournoi.', 'danger')

    data, status = backend_request('GET', '/joueurs/noms')
    joueurs = data if status == 200 else []

    return render_template("add_tournament.html", 
                           joueurs=joueurs,
                           session_lifetime=app.permanent_session_lifetime.total_seconds())

@app.route('/confirmation')
def confirmation():
    return render_template("confirmation.html")

@app.route('/stats/joueurs')
def stats_joueurs():
    data, status = backend_request('GET', '/classement')
    joueurs = []
    if status == 200:
        joueurs = data
        for joueur in joueurs:
            joueur.setdefault('victoires', 0)
            joueur.setdefault('nombre_tournois', 0)
            joueur.setdefault('ratio_victoires', 0)
            joueur.setdefault('percentile_trueskill', 0)
            joueur.setdefault('progression_recente', 0)
    else:
        flash("Impossible de récupérer la liste des joueurs.", "warning")
        
    data_dist, status_dist = backend_request('GET', '/stats/joueurs')
    dist = data_dist.get('distribution_tiers', {}) if status_dist == 200 else {}
        
    return render_template("stats_joueurs.html", joueurs=joueurs, distribution_tiers=dist)

@app.route('/stats/tournois')
def stats_tournois():
    data, status = backend_request('GET', '/stats/tournois')
    tournois = data if status == 200 else []
    return render_template("stats_tournois.html", tournois=tournois)

@app.route('/stats/tournoi/<int:tournoi_id>')
def stats_tournoi_detail(tournoi_id):
    data, status = backend_request('GET', f'/stats/tournoi/{tournoi_id}')
    if status == 200:
        return render_template("stats_tournoi.html", 
                            date=data.get('date'), 
                            resultats=data.get('resultats', []))
    else:
        flash("Tournoi introuvable", "warning")
        return redirect(url_for('index'))

@app.route('/admin/gestion')
def admin_gestion():
    if 'admin_token' not in session:
        flash('Accès interdit.', 'danger')
        return redirect(url_for('admin_login'))
    return render_template('gestion_joueurs.html', 
                           admin_token=session['admin_token'],
                           session_lifetime=app.permanent_session_lifetime.total_seconds())

@app.route('/admin/joueurs', methods=['GET', 'POST'])
@csrf.exempt
def proxy_joueurs():
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé'}), 403
    
    headers = {'X-Admin-Token': session['admin_token']}
    
    if request.method == 'GET':
        data, status = backend_request('GET', '/admin/joueurs', headers=headers)
    elif request.method == 'POST':
        data, status = backend_request('POST', '/admin/joueurs', data=request.get_json(), headers=headers)
    
    return jsonify(data), status

@app.route('/admin/joueurs/<int:id>', methods=['PUT', 'DELETE'])
@csrf.exempt
def proxy_joueurs_detail(id):
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé'}), 403

    headers = {'X-Admin-Token': session['admin_token']}

    if request.method == 'PUT':
        data, status = backend_request('PUT', f'/admin/joueurs/{id}', data=request.get_json(), headers=headers)
    elif request.method == 'DELETE':
        data, status = backend_request('DELETE', f'/admin/joueurs/{id}', headers=headers)
            
    return jsonify(data), status
    
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
