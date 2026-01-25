import os
import sys
import logging
import requests
import time
from flask import Flask, render_template, request, redirect, url_for, session, flash, jsonify
from datetime import timedelta
from flask_wtf.csrf import CSRFProtect

# CONFIGURATION
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

try:
    app.secret_key = os.environ['SECRET_KEY']
    BACKEND_URL = os.environ.get('BACKEND_URL')
    
    if not BACKEND_URL or ('backend' in BACKEND_URL and not os.path.exists('/.dockerenv')):
        logger.warning("⚠️ BACKEND_URL non défini ou invalide, utilisation de localhost:8080")
        BACKEND_URL = 'http://localhost:8080'
    
    logger.info(f"✅ BACKEND_URL configuré : {BACKEND_URL}")
    
except KeyError as e:
    logger.error(f"❌ Variable d'environnement manquante : {e}")
    sys.exit(1)

app.permanent_session_lifetime = timedelta(minutes=30)
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

csrf = CSRFProtect(app)

APP_VERSION = "1.2.0"

@app.context_processor
def inject_version():
    return dict(app_version=APP_VERSION)

# MIDDLEWARES & CONTEXT PROCESSORS

@app.before_request
def check_admin_token_validity():
    if request.path.startswith('/static'):
        return

    if 'admin_token' in session:
        token = session['admin_token']
        try:
            response = requests.get(
                f"{app.config.get('BACKEND_URL', 'http://backend:8080')}/admin/check-token",
                headers={'X-Admin-Token': token},
                timeout=1
            )
            
            if response.status_code != 200:
                print("⚠️ Token invalide détecté -> Déconnexion forcée.")
                session.pop('admin_token', None)
                session.pop('token_start_time', None)
                
        except Exception as e:
            print(f"⚠️ Erreur vérification token: {e}")
            pass

@app.context_processor
def inject_lifetime():
    total_lifetime = app.permanent_session_lifetime.total_seconds()
    
    if 'token_start_time' in session:
        elapsed = time.time() - session['token_start_time']
        remaining = total_lifetime - elapsed
        return dict(session_lifetime=max(0, remaining))
    
    return dict(session_lifetime=total_lifetime)

@app.context_processor
def inject_saisons():
    try:
        data, status = backend_request('GET', '/saisons')
        if status == 200:
            return dict(saisons_menu=data)
    except Exception:
        pass
    return dict(saisons_menu=[])

# HELPER FUNCTIONS

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
    except requests.exceptions.RequestException:
        return None, 503

# ROUTES : API PROXIES (PUBLIC)

@app.route('/admin/types-awards', methods=['GET'])
@csrf.exempt
def proxy_types_awards():
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé'}), 403
    headers = {'X-Admin-Token': session['admin_token']}
    data, status = backend_request('GET', '/admin/types-awards', headers=headers)
    return jsonify(data), status

@app.route('/joueurs/noms')
def proxy_joueurs_noms():
    try:
        response = requests.get(f'{BACKEND_URL}/joueurs/noms')
        return jsonify(response.json())
    except Exception:
        return jsonify([])

@app.route('/api/saisons')
def proxy_saisons_public():
    try:
        response = requests.get(f'{BACKEND_URL}/saisons')
        return jsonify(response.json())
    except Exception:
        return jsonify([])

@app.route('/admin/refresh', methods=['POST'])
def proxy_refresh():
    if not session.get('admin_token'):
        return jsonify({"error": "No token"}), 401
    headers = {'X-Admin-Token': session['admin_token']}
    data, status = backend_request('POST', '/admin/refresh-token', headers=headers)
    if status == 200 and data.get("status") == "success":
        session['admin_token'] = data.get("token")
        session['token_start_time'] = time.time()
        return jsonify({"status": "success"})
    return jsonify({"error": "Failed"}), 401

@app.route('/add-tournament', methods=['POST'])
def proxy_add_tournament():
    if not session.get('admin_token'):
        return jsonify({'status': 'error', 'message': 'Non autorisé'}), 403
    try:
        data = request.get_json()
        headers = {'X-Admin-Token': session.get('admin_token')}
        response = requests.post(f'{BACKEND_URL}/add-tournament', json=data, headers=headers)
        return jsonify(response.json()), response.status_code
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

# ROUTES : VIEWS (PUBLIC)

@app.route('/')
def index():
    data, status = backend_request('GET', '/dernier-tournoi')
    resultats = data if status == 200 and isinstance(data, list) else []
    return render_template("index.html", resultats=resultats)

@app.route('/recap/<season_slug>')
def recap_season(season_slug):
    ligue_id = request.args.get('ligue_id')
    view_mode = request.args.get('view')

    url = f'/stats/recap/{season_slug}'
    params = []
    if ligue_id:
        params.append(f'ligue_id={ligue_id}')
    if params:
        url += '?' + '&'.join(params)

    data, status = backend_request('GET', url)
    if status != 200:
        return render_template("recap.html", error="Saison introuvable ou erreur serveur", saison=None, view_mode=None, new_leagues_data=None)

    new_leagues_data = None
    if view_mode == 'new-leagues' and data.get('is_league_recap'):
        nl_data, nl_status = backend_request('GET', f'/stats/recap/{season_slug}/new-leagues')
        if nl_status == 200:
            new_leagues_data = nl_data

    return render_template("recap.html", saison=data, view_mode=view_mode, new_leagues_data=new_leagues_data)

@app.route('/recap')
def recap_default():
    data, status = backend_request('GET', '/saisons')
    saisons_list = data if status == 200 else []
    return render_template("recap_list.html", saisons=saisons_list)

@app.route('/classement')
def classement():
    tier = request.args.get('tier')
    ligue_id = request.args.get('ligue')

    params = {}
    if tier:
        params['tier'] = tier
    if ligue_id:
        params['ligue'] = ligue_id

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

    ligues = []
    ligues_data, ligues_status = backend_request('GET', '/ligues')
    if ligues_status == 200 and isinstance(ligues_data, list):
        ligues = ligues_data

    return render_template("classement.html", joueurs=joueurs, tier_actif=tier, ligue_active=ligue_id, ligues=ligues)

@app.route('/stats/joueur/<nom>')
def stats_joueur_detail(nom):
    data, status = backend_request('GET', f'/stats/joueur/{nom}')
    if status == 200:
        return render_template(
            "stats_joueur.html", 
            nom=nom,
            stats=data.get('stats', {}),
            historique=data.get('historique', []),
            awards=data.get('awards', [])
        )
    elif status == 404:
        flash(f"Joueur '{nom}' non trouvé.", "warning")
        return redirect(url_for('classement'))
    else:
        flash("Erreur lors de la récupération des statistiques.", "danger")
        return redirect(url_for('classement'))
    
@app.route('/confirmation')
def confirmation():
    return render_template("confirmation.html")

@app.route('/stats/joueurs')
def stats_joueurs():
    data, status = backend_request('GET', '/stats/joueurs')
    
    joueurs = []
    dist = {}

    if status == 200 and isinstance(data, dict):
        joueurs = data.get('joueurs', [])
        dist = data.get('distribution_tiers', {})
    else:
        joueurs = [] 
        dist = {}
        
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
        return render_template("stats_tournoi.html", date=data.get('date'), resultats=data.get('resultats', []))
    else:
        flash("Tournoi introuvable", "warning")
        return redirect(url_for('index'))

# ROUTES : ADMIN AUTH

@app.route('/admin', methods=['GET', 'POST'])
def admin_login():
    if request.method == 'POST':
        password = request.form.get('password')
        data, status = backend_request('POST', '/admin-auth', data={"password": password})
        if status == 200 and data.get("status") == "success":
            session.permanent = True
            session['admin_token'] = data.get("token")
            session['token_start_time'] = time.time()
            flash('Connexion réussie', 'success')
            return redirect(url_for('add_tournament'))
        else:
            flash('Mot de passe incorrect', 'danger')
    return render_template("admin_login.html")

@app.route('/admin/logout')
def admin_logout():
    token = session.get('admin_token')
    if token:
        try:
            headers = {'X-Admin-Token': token}
            requests.post(f"{BACKEND_URL}/admin-logout", headers=headers, timeout=2)
        except Exception:
            pass
    session.pop('admin_token', None)
    session.pop('token_start_time', None)
    session.clear()
    flash('Vous avez été déconnecté', 'info')
    return redirect(url_for('index'))

# ROUTES : ADMIN ACTIONS (FORMS)

@app.route('/add_tournament', methods=['GET', 'POST'])
def add_tournament():
    if 'admin_token' not in session:
        flash('Accès réservé aux administrateurs', 'warning')
        return redirect(url_for('admin_login'))

    headers = {'X-Admin-Token': session['admin_token']}
    _, status = backend_request('GET', '/admin/check-token', headers=headers)
    if status in [401, 403]:
        session.pop('admin_token', None)
        flash('Votre session a expiré. Veuillez vous reconnecter.', 'danger')
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
    return render_template("add_tournament.html", joueurs=joueurs)

@app.route('/admin/revert_last', methods=['POST'])
@csrf.exempt
def admin_revert_last():
    if not session.get('admin_token'):
        return jsonify({"error": "Non autorisé"}), 401
    try:
        headers = {'X-Admin-Token': session.get('admin_token')}
        
        resp = requests.post(
            f"{BACKEND_URL}/api/admin/revert-last-tournament",
            headers=headers 
        )
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ROUTES : ADMIN PAGES

@app.route('/admin/gestion')
def admin_gestion():
    if 'admin_token' not in session:
        flash('Accès interdit.', 'danger')
        return redirect(url_for('admin_login'))
    headers = {'X-Admin-Token': session['admin_token']}
    _, status = backend_request('GET', '/admin/check-token', headers=headers)
    if status in [401, 403]:
        session.pop('admin_token', None)
        flash('Session expirée.', 'warning')
        return redirect(url_for('admin_login'))
    return render_template('gestion_joueurs.html', admin_token=session['admin_token'])

@app.route('/admin/saisons-gestion')
def admin_saisons_page():
    if 'admin_token' not in session:
        flash('Accès interdit.', 'danger')
        return redirect(url_for('admin_login'))
    headers = {'X-Admin-Token': session['admin_token']}
    _, status = backend_request('GET', '/admin/check-token', headers=headers)
    if status in [401, 403]:
        session.pop('admin_token', None)
        flash('Session expirée.', 'warning')
        return redirect(url_for('admin_login'))
    return render_template('admin_saisons.html', admin_token=session['admin_token'])

# ROUTES : ADMIN API PROXIES

@app.route('/admin/saisons', methods=['GET', 'POST'])
@csrf.exempt
def proxy_saisons():
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé'}), 403
    headers = {'X-Admin-Token': session['admin_token']}
    if request.method == 'GET':
        data, status = backend_request('GET', '/admin/saisons', headers=headers)
    elif request.method == 'POST':
        data, status = backend_request('POST', '/admin/saisons', data=request.get_json(), headers=headers)
    return jsonify(data), status

@app.route('/admin/saisons/<int:id>', methods=['DELETE'])
@csrf.exempt
def proxy_saisons_delete(id):
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé'}), 403
    headers = {'X-Admin-Token': session['admin_token']}
    data, status = backend_request('DELETE', f'/admin/saisons/{id}', headers=headers)
    return jsonify(data), status

@app.route('/admin/saisons/<int:id>/count-tournois', methods=['GET'])
@csrf.exempt
def proxy_saisons_count_tournois(id):
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé'}), 403
    headers = {'X-Admin-Token': session['admin_token']}
    data, status = backend_request('GET', f'/admin/saisons/{id}/count-tournois', headers=headers)
    return jsonify(data), status

@app.route('/admin/saisons/<int:id>/save-awards', methods=['POST'])
@csrf.exempt
def proxy_saisons_save_awards(id):
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé'}), 403
    headers = {'X-Admin-Token': session['admin_token']}
    payload = request.get_json(silent=True) or {}
    data, status = backend_request('POST', f'/admin/saisons/{id}/save-awards', data=payload, headers=headers)
    return jsonify(data), status

@app.route('/admin/joueurs', methods=['GET', 'POST'])
@csrf.exempt
def proxy_joueurs():
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé : Session expirée'}), 403

    headers = {'X-Admin-Token': session['admin_token']}

    if request.method == 'GET':
        data, status = backend_request('GET', '/admin/joueurs', headers=headers)
        return jsonify(data), status

    elif request.method == 'POST':
        payload = request.get_json(silent=True)
        
        if payload is None:
            return jsonify({'error': 'Données invalides ou manquantes (JSON requis)'}), 400
            
        data, status = backend_request('POST', '/admin/joueurs', data=payload, headers=headers)
        return jsonify(data), status

    return jsonify({'error': 'Méthode non autorisée'}), 405

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

@app.route('/admin/config', methods=['GET', 'POST'])
@csrf.exempt
def proxy_config():
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé'}), 403
    headers = {'X-Admin-Token': session['admin_token']}
    if request.method == 'GET':
        data, status = backend_request('GET', '/admin/config', headers=headers)
    elif request.method == 'POST':
        data, status = backend_request('POST', '/admin/config', data=request.get_json(), headers=headers)
    return jsonify(data), status

@app.route('/admin/global-reset', methods=['POST'])
@csrf.exempt
def proxy_global_reset():
    if not session.get('admin_token'):
        return jsonify({"error": "Non autorisé"}), 401
    headers = {'X-Admin-Token': session.get('admin_token')}
    data, status = backend_request('POST', '/api/admin/global-reset', data=request.get_json(), headers=headers)
    return jsonify(data), status

@app.route('/admin/revert-global-reset', methods=['POST'])
@csrf.exempt
def proxy_revert_global_reset():
    if not session.get('admin_token'):
        return jsonify({"error": "Non autorisé"}), 401
    headers = {'X-Admin-Token': session.get('admin_token')}
    data, status = backend_request('POST', '/api/admin/revert-global-reset', headers=headers)
    return jsonify(data), status

@app.route('/api/ligues', methods=['GET'])
def proxy_get_ligues_public():
    data, status = backend_request('GET', '/ligues')
    return jsonify(data), status

@app.route('/admin/ligues/setup', methods=['POST'])
@csrf.exempt
def proxy_setup_ligues():
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé'}), 403
    
    headers = {'X-Admin-Token': session['admin_token']}
    data, status = backend_request('POST', '/admin/ligues/setup', data=request.get_json(), headers=headers)
    return jsonify(data), status

@app.route('/admin/ligues/draft-simulation', methods=['GET'])
@csrf.exempt
def proxy_draft_simulation():
    if 'admin_token' not in session:
        return jsonify({'error': 'Non autorisé'}), 403
    headers = {'X-Admin-Token': session['admin_token']}
    data, status = backend_request('GET', '/admin/ligues/draft-simulation', headers=headers)
    return jsonify(data), status

@app.route('/admin/ligues')
def admin_ligues_page():
    if 'admin_token' not in session:
        flash('Accès interdit.', 'danger')
        return redirect(url_for('admin_login'))
    
    headers = {'X-Admin-Token': session['admin_token']}
    _, status = backend_request('GET', '/admin/check-token', headers=headers)
    if status in [401, 403]:
        session.pop('admin_token', None)
        flash('Session expirée.', 'warning')
        return redirect(url_for('admin_login'))
        
    return render_template('admin_ligues.html', admin_token=session['admin_token'])

# MAIN

@app.after_request
def add_header(response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
