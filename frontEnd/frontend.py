from flask import Flask, render_template, request, redirect, url_for, session, flash
import requests
import os
from datetime import datetime, timedelta 

app = Flask(__name__)

# --- Configuration ---
app.secret_key = os.environ.get('SECRET_KEY', os.urandom(24))

app.permanent_session_lifetime = timedelta(minutes=2) 

BACKEND_URL = os.environ.get('BACKEND_URL', 'http://backend:8080')

@app.route('/')
def index():
    """Page d'accueil : Affiche le dernier tournoi."""
    try:
        response = requests.get(f"{BACKEND_URL}/dernier-tournoi")
        if response.status_code == 200:
            data = response.json()
            if isinstance(data, list):
                resultats = data
            else:
                resultats = data.get('resultats', [])
        else:
            resultats = []
    except requests.exceptions.RequestException:
        resultats = []
        print("Erreur de connexion au backend pour /dernier-tournoi")
    
    return render_template("index.html", resultats=resultats)

@app.context_processor
def inject_session_lifetime():
    return dict(session_lifetime=app.permanent_session_lifetime.total_seconds())

@app.route('/classement')
def classement():
    """Page du classement général avec filtres par Tier."""
    tier = request.args.get('tier')
    params = {'tier': tier} if tier else {}
    
    try:
        response = requests.get(f"{BACKEND_URL}/classement", params=params)
        if response.status_code == 200:
            joueurs = response.json()
        else:
            joueurs = []
            flash('Erreur lors du chargement du classement', 'warning')
    except requests.exceptions.RequestException:
        joueurs = []
        flash('Backend inaccessible', 'danger')
        
    return render_template("classement.html", joueurs=joueurs, tier_actif=tier)

@app.route('/admin', methods=['GET', 'POST'])
def admin_login():
    """Page de connexion administrateur."""
    if request.method == 'POST':
        password = request.form.get('password')
        try:
            # Authentification via le backend
            response = requests.post(f"{BACKEND_URL}/admin-auth", json={"password": password})
            
            if response.status_code == 200:
                data = response.json()
                if data.get("status") == "success":
                    # --- MODIFICATION ICI ---
                    session.permanent = True
                    session['admin_token'] = data.get("token")
                    # ------------------------
                    
                    flash('Connexion réussie', 'success')
                    return redirect(url_for('add_tournament'))
                else:
                    flash('Mot de passe incorrect', 'danger')
            else:
                flash('Erreur d\'authentification', 'danger')
                
        except requests.exceptions.RequestException:
            flash('Impossible de contacter le serveur d\'authentification', 'danger')
            
    return render_template("admin_login.html")

@app.route('/admin/logout')
def admin_logout():
    """Déconnexion."""
    session.pop('admin_token', None)
    flash('Vous avez été déconnecté', 'info')
    return redirect(url_for('index'))

@app.route('/add_tournament', methods=['GET', 'POST'])
def add_tournament():
    """Page d'ajout de tournoi (nécessite admin)."""
    if 'admin_token' not in session:
        flash('Accès réservé aux administrateurs', 'warning')
        return redirect(url_for('admin_login'))

    if request.method == 'POST':
        date = request.form.get('date')

        joueurs_data = []
        i = 1
        while True:
            nom = request.form.get(f'nom{i}')
            score = request.form.get(f'score{i}')
            
            if not nom or not score:
                break
                
            try:
                joueurs_data.append({
                    "nom": nom, 
                    "score": int(score)
                })
            except ValueError:
                flash(f"Le score pour {nom} doit être un nombre entier.", "danger")
                return redirect(url_for('add_tournament'))
            
            i += 1
            
        if len(joueurs_data) < 2:
            flash("Il faut au moins 2 joueurs pour un tournoi.", "warning")
            return redirect(url_for('add_tournament'))

        payload = {
            "date": date,
            "joueurs": joueurs_data
        }
        
        headers = {'X-Admin-Token': session['admin_token']}
        
        try:
            response = requests.post(f"{BACKEND_URL}/add-tournament", json=payload, headers=headers)
            
            if response.status_code == 201:
                flash('Tournoi ajouté avec succès !', 'success')
                return redirect(url_for('confirmation'))
            elif response.status_code == 403:
                flash('Session expirée. Veuillez vous reconnecter.', 'danger')
                return redirect(url_for('admin_logout'))
            else:
                flash(f'Erreur lors de l\'ajout: {response.text}', 'danger')
                
        except requests.exceptions.RequestException as e:
            flash(f'Erreur de connexion au backend: {str(e)}', 'danger')

    try:
        joueurs_response = requests.get(f"{BACKEND_URL}/joueurs/noms")
        
        if joueurs_response.status_code == 200:
            joueurs = joueurs_response.json()
        else:
            print(f"Erreur API Joueurs: {joueurs_response.status_code}")
            joueurs = [] # Liste vide en cas d'erreur API
            
    except requests.exceptions.RequestException as e:
        print(f"Exception API Joueurs: {e}")
        joueurs = [] # Liste vide en cas d'erreur Réseau

    return render_template("add_tournament.html", joueurs=joueurs)

@app.route('/confirmation')
def confirmation():
    return render_template("confirmation.html")

# --- Code à ajouter vers la fin du fichier frontend.py ---

@app.route('/stats/joueurs')
def stats_joueurs():
    """Page affichant les statistiques globales des joueurs."""
    try:
        response = requests.get(f"{BACKEND_URL}/classement")
        
        if response.status_code == 200:
            joueurs = response.json()
            for joueur in joueurs:
                joueur.setdefault('victoires', 0)
                joueur.setdefault('nombre_tournois', 0)
                joueur.setdefault('ratio_victoires', 0)
                joueur.setdefault('percentile_trueskill', 0)
                joueur.setdefault('progression_recente', 0)
            # ---------------------------
            
        else:
            joueurs = []
            flash("Impossible de récupérer la liste des joueurs.", "warning")
            
    except requests.exceptions.RequestException:
        joueurs = []
        flash("Erreur de connexion au backend.", "danger")
        
    return render_template("stats_joueurs.html", joueurs=joueurs, distribution_tiers={})

# ---------------------------------------------------------

@app.route('/stats/tournois')
def stats_tournois():
    """Liste de l'historique des tournois."""
    try:
        response = requests.get(f"{BACKEND_URL}/stats/tournois")
        if response.status_code == 200:
            tournois = response.json()
            for t in tournois:
                if 'vainqueur' not in t:
                    t['vainqueur'] = "Inconnu"
        else:
            tournois = []
            flash("Impossible de récupérer la liste des tournois.", "warning")
            
    except requests.exceptions.RequestException:
        tournois = []
        flash("Erreur de connexion au backend.", "danger")
        
    return render_template("stats_tournois.html", tournois=tournois)

@app.route('/stats/tournoi/<int:tournoi_id>')
def stats_tournoi_detail(tournoi_id):
    """Détail d'un tournoi spécifique."""
    try:
        response = requests.get(f"{BACKEND_URL}/stats/tournoi/{tournoi_id}")
        if response.status_code == 200:
            data = response.json()
            return render_template("stats_tournoi.html", 
                                date=data.get('date'), 
                                resultats=data.get('resultats', []))
        else:
            flash("Tournoi introuvable", "warning")
            return redirect(url_for('index'))
    except requests.exceptions.RequestException:
        flash("Erreur serveur", "danger")
        return redirect(url_for('index'))

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
