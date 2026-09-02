import os
import sys
import logging
import secrets
import requests
import time
from urllib.parse import urlencode
import json
from flask import (Flask, render_template, request, redirect, url_for, session,
                   flash, jsonify, Response)
from datetime import timedelta, date
from flask_wtf.csrf import CSRFProtect

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

# 30 jours : la session joueur doit survivre à la fermeture du navigateur.
# La session admin, elle, ne dépend PAS de cette durée — son minuteur est
# recalculé depuis token_start_time (cf. inject_lifetime).
app.permanent_session_lifetime = timedelta(days=30)
# Durée de vie du token admin côté backend (constants.TOKEN_LIFETIME_MINUTES).
# Dupliquée ici faute d'un module partagé : à garder synchronisée.
ADMIN_TOKEN_LIFETIME_MINUTES = 60

app.config['SESSION_COOKIE_HTTPONLY'] = True
# NE PAS passer à 'Strict' : le retour de Discord vers /auth/discord/callback est
# une navigation cross-site. En Lax le cookie part bien sur une navigation GET de
# premier niveau, donc la vérification du state fonctionne. En Strict, le cookie
# ne serait pas envoyé, le state serait introuvable, et la connexion échouerait
# sans message exploitable.
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
# Le cookie "Secure" n'est envoyé par le navigateur que sur une connexion HTTPS.
# En local (docker compose, TLS_MODE=http par défaut) ça bloquerait toute
# connexion admin : on aligne le flag sur le TLS_MODE réellement servi par nginx.
app.config['SESSION_COOKIE_SECURE'] = (os.environ.get('TLS_MODE', 'http') == 'https')
# flask-wtf a son propre TTL (3600 s par défaut), indépendant de la session.
# Sans ça, un joueur qui laisse sa page de profil ouverte plus d'une heure voit
# son enregistrement rejeté avec un message incompréhensible. À None, la
# validité du token CSRF suit celle de la session.
app.config['WTF_CSRF_TIME_LIMIT'] = None

csrf = CSRFProtect(app)

APP_VERSION = "1.4.3"

@app.context_processor
def inject_version():
    return dict(app_version=APP_VERSION)


@app.before_request
def check_admin_token_validity():
    if request.path.startswith('/static'):
        return

    if 'admin_token' in session:
        token = session['admin_token']
        try:
            response = requests.get(
                f"{BACKEND_URL}/admin/check-token",
                headers={'X-Admin-Token': token},
                timeout=1
            )

            # Ne purger QUE sur un refus explicite. Un 5xx ou un timeout dit que
            # le backend a un hoquet, pas que la session est invalide : purger
            # dans ce cas déconnecte tout le monde à chaque redémarrage.
            if response.status_code in (401, 403):
                logger.warning("Token admin refusé -> déconnexion.")
                session.pop('admin_token', None)
                session.pop('token_start_time', None)
            elif response.status_code != 200:
                logger.warning(
                    "Backend indisponible (HTTP %s) — session conservée.",
                    response.status_code,
                )

        except Exception as e:
            logger.warning(f"Vérification du token impossible ({e}) — session conservée")

@app.context_processor
def inject_lifetime():
    """Minuteur de session admin affiché dans la navbar.

    Calculé depuis la durée de vie du TOKEN admin, et non depuis celle du
    cookie : le cookie dure 30 jours pour la session joueur, ce qui afficherait
    « expire dans 30 jours » et empêcherait le setTimeout de la navbar de se
    déclencher un jour.
    """
    total_lifetime = ADMIN_TOKEN_LIFETIME_MINUTES * 60

    if 'token_start_time' in session:
        elapsed = time.time() - session['token_start_time']
        return dict(session_lifetime=max(0, total_lifetime - elapsed))

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


def backend_request(method, endpoint, data=None, params=None, headers=None, timeout=5):
    """Appel JSON au backend.

    `timeout` est paramétrable pour l'échange OAuth : deux appels réseau vers
    Discord se cachent derrière, et 5 s couperaient alors que le compte vient
    d'être créé et l'invitation consommée — l'utilisateur retenterait avec un
    lien déjà brûlé.
    """
    url = f"{BACKEND_URL}{endpoint}"
    try:
        if method == 'GET':
            response = requests.get(url, params=params, headers=headers, timeout=timeout)
        elif method == 'POST':
            response = requests.post(url, json=data, headers=headers, timeout=timeout)
        elif method == 'PUT':
            response = requests.put(url, json=data, headers=headers, timeout=timeout)
        elif method == 'DELETE':
            response = requests.delete(url, headers=headers, timeout=timeout)
        else:
            return None, 405
        
        try:
            return response.json(), response.status_code
        except ValueError:
            return response.text, response.status_code
    except requests.exceptions.RequestException:
        return None, 503


# ---------------------------------------------------------------------------
# Authentification admin : deux voies pendant la bascule
# ---------------------------------------------------------------------------

def _session_admin_expiree():
    """Sortie commune quand le backend refuse la session sur une page admin.

    Renvoyer un admin Discord vers le formulaire de mot de passe n'aurait aucun
    sens : ce n'est pas par là qu'il se reconnecte.
    """
    if session.get('player_token'):
        session.pop('player_token', None)
        session.pop('compte', None)
        flash('Votre session a expiré. Reconnectez-vous avec Discord.', 'warning')
        return redirect(url_for('index'))
    session.pop('admin_token', None)
    session.pop('token_start_time', None)
    flash('Session expirée.', 'warning')
    return redirect(url_for('admin_login'))


def _est_admin():
    """Vrai si la session ouvre les pages d'administration.

    ATTENTION — c'est une porte d'INTERFACE, pas une frontière de privilège.
    Le rôle lu ici vient de la copie mise en session à la connexion ; il peut
    donc être périmé si un super-admin vient de le retirer. L'autorité reste le
    backend, qui relit le rôle en base à chaque requête protégée.
    Le rafraîchir ici coûterait un appel réseau sur chaque page ET chaque proxy,
    exactement ce que R-28 demande d'éviter. Conséquence assumée : un admin
    rétrogradé voit encore la page, mais n'en obtient plus les données.
    """
    compte = session.get('compte') or {}
    return bool(session.get('admin_token')) or compte.get('role') in ('admin', 'superadmin')


def admin_headers():
    """En-tête d'auth admin, construit depuis la session serveur.

    Privilégie la session Discord quand elle porte le rôle, et retombe sur le
    mot de passe sinon. Les deux voies coexistent le temps de la bascule : le
    backend accepte explicitement l'une OU l'autre.
    """
    compte = session.get('compte') or {}
    if session.get('player_token') and compte.get('role') in ('admin', 'superadmin'):
        return {'X-Session-Token': session['player_token']}
    if session.get('admin_token'):
        return {'X-Admin-Token': session['admin_token']}
    return None


@app.route('/admin/types-awards', methods=['GET'])

def proxy_types_awards():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    headers = admin_headers()
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
    # Prolonge la session par mot de passe, et elle seule : une session Discord
    # n'a rien à renouveler (son expiration est absolue). L'en-tête est donc
    # explicite ici, surtout pas admin_headers(), qui préférerait la voie
    # Discord et se ferait refuser par une route restée sur @admin_required.
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
    if not _est_admin():
        return jsonify({'status': 'error', 'message': 'Non autorisé'}), 403
    try:
        data = request.get_json()
        headers = admin_headers()
        response = requests.post(f'{BACKEND_URL}/add-tournament', json=data, headers=headers)
        return jsonify(response.json()), response.status_code
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


def get_banner_season():
    today = date.today()
    md = (today.month, today.day)
    if (3, 20) <= md < (6, 21):
        return "spring"
    elif (6, 21) <= md < (9, 22):
        return "summer"
    elif (9, 22) <= md < (12, 21):
        return "autumn"
    else:
        return "winter"

@app.route('/')
def index():
    data, status = backend_request('GET', '/dernier-tournoi')
    resultats = data if status == 200 and isinstance(data, list) else []
    return render_template("index.html", resultats=resultats, banner_season=get_banner_season())

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
    if view_mode == 'new-leagues' and data.get('include_league_moves'):
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
    vue = request.args.get('vue')
    saison_ligue_id = request.args.get('ligue_id')

    params = {}
    if tier:
        params['tier'] = tier
    if ligue_id:
        params['ligue'] = ligue_id

    data, status = backend_request('GET', '/classement', params=params)
    distribution_data = {"curve": [], "players": []}
    if status == 200 and isinstance(data, dict):
        joueurs = data.get('joueurs', [])
        distribution_data = data.get('distribution_data', distribution_data)
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

    seuils = {}
    seuils_data, seuils_status = backend_request('GET', '/tier-seuils')
    if seuils_status == 200 and isinstance(seuils_data, dict):
        seuils = seuils_data

    saison = None
    if vue == 'saison':
        s_params = {}
        if saison_ligue_id:
            s_params['ligue_id'] = saison_ligue_id
        s_data, s_status = backend_request('GET', '/classement/saison', params=s_params)
        if s_status == 200 and isinstance(s_data, dict):
            saison = s_data

    return render_template("classement.html", joueurs=joueurs, tier_actif=tier, ligue_active=ligue_id, ligues=ligues, seuils=seuils, distribution_data=distribution_data, vue=vue, saison=saison)

def _rendre_fiche_joueur(nom, data):
    return render_template(
        "stats_joueur.html",
        nom=nom,
        stats=data.get('stats', {}),
        historique=data.get('historique', []),
        awards=data.get('awards', []),
        palmares=data.get('palmares', []),
        has_league_data=data.get('has_league_data', False),
        details=data.get('details', []),
        profil=data.get('profil'),
        url_canonique=data.get('url_canonique'),
    )


@app.route('/joueur/<int:joueur_id>')
def joueur_detail(joueur_id):
    """URL canonique d'une fiche joueur.

    Construite sur l'identifiant et non sur le nom : le nom bouge (synchro d'un
    pseudo Discord, anonymisation, correction de faute de frappe) et emporte
    avec lui tous les liens déjà partagés dans Discord.
    """
    data, status = backend_request('GET', f'/joueur/{joueur_id}')
    if status == 200:
        return _rendre_fiche_joueur(data.get('nom'), data)
    flash("Joueur introuvable", "warning")
    return redirect(url_for('index'))


@app.route('/stats/joueur/<nom>')
def stats_joueur_detail(nom):
    """Ancienne URL, conservée : des liens circulent déjà avec cette forme.

    Redirige en 301 vers l'URL canonique, pour que les liens repartagés depuis
    ici soient stables. Le coût est un aller-retour supplémentaire, sur ce seul
    chemin hérité.
    """
    resolu, status = backend_request('GET', f'/joueurs/resolve/{nom}')
    if status == 200 and isinstance(resolu, dict) and resolu.get('id'):
        return redirect(url_for('joueur_detail', joueur_id=resolu['id']), code=301)

    # Backend indisponible : on sert la page à l'ancienne plutôt que d'afficher
    # une erreur. Une 301 est mise en cache par le navigateur — l'émettre sur la
    # foi d'une résolution incertaine graverait une mauvaise redirection.
    data, status = backend_request('GET', f'/stats/joueur/{nom}')
    if status == 200:
        return _rendre_fiche_joueur(nom, data)
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


# ===========================================================================
# Authentification Discord (joueurs)
# ===========================================================================

DISCORD_CLIENT_ID = os.environ.get('DISCORD_CLIENT_ID', '')
# Toujours l'environnement, jamais url_for(_external=True) : Flask est derrière
# nginx puis gunicorn sans ProxyFix et produirait du http://, alors que Discord
# exige une correspondance au caractère près avec le portail développeur.
DISCORD_REDIRECT_URI = os.environ.get('DISCORD_REDIRECT_URI', '')
DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
# L'échange déclenche deux appels réseau vers Discord côté backend.
OAUTH_EXCHANGE_TIMEOUT = 20


# Identite de l'editeur, affichee dans les pages legales. Renseignee par
# l'environnement : ce sont des informations personnelles (nom, adresse de
# contact) qui n'ont pas a etre figees dans un depot public.
# ⚠️ Tant que ces variables ne sont pas definies, les pages legales affichent
# des mentions « a renseigner » : elles sont donc incompletes au sens de la loi.
MENTIONS = {
    'editeur': os.environ.get('SITE_EDITEUR', '[à renseigner : nom de l’éditeur]'),
    'contact': os.environ.get('SITE_CONTACT', '[à renseigner : adresse de contact]'),
    'hebergeur': os.environ.get('SITE_HEBERGEUR', '[à renseigner : hébergeur et pays]'),
    'retention_logs': os.environ.get('SITE_RETENTION_LOGS', '12 mois au maximum'),
}
# ⚠️ Doit rester identique à constants.CGU_VERSION côté backend : c'est le
# backend qui décide si le consentement doit être redemandé, le frontend ne fait
# qu'afficher le numéro. Les désaligner ferait afficher une version et en
# enregistrer une autre.
CGU_VERSION = "1.0"


@app.context_processor
def inject_mentions():
    return dict(cgu_version=CGU_VERSION, cgu_date='2 septembre 2026', **MENTIONS)


@app.context_processor
def inject_discord_configure():
    """Le bouton de connexion ne doit pas s'afficher si Discord n'est pas configuré.

    Lu depuis l'environnement du frontend, sans appel au backend : c'est une
    décision d'affichage sur chaque page, elle ne vaut pas un aller-retour.
    """
    return dict(discord_configure=bool(DISCORD_CLIENT_ID and DISCORD_REDIRECT_URI))


@app.context_processor
def inject_est_admin():
    """Expose la porte d'interface admin aux templates.

    Les templates testaient `session.admin_token`, ce qui masquait le menu
    d'administration à un admin connecté par Discord.
    """
    return dict(est_admin=_est_admin())


@app.context_processor
def inject_compte():
    """Expose le compte joueur aux templates (navbar, pages profil)."""
    return dict(compte_joueur=session.get('compte'))


@app.route('/invite/<token>')
def invite(token):
    """Page d'accueil d'une invitation.

    STRICTEMENT idempotente : elle ne consomme rien. Coller ce lien dans un
    salon Discord déclenche un GET du crawler qui déroule l'aperçu ; si
    l'affichage consommait l'invitation, un lien à usage unique serait brûlé
    avant que quiconque ait pu cliquer.
    """
    data, status = backend_request('GET', f'/auth/invitation/{token}')
    invitation = data if status == 200 and isinstance(data, dict) else None
    if invitation is None:
        motif = data.get('code') if isinstance(data, dict) else 'indisponible'
        return render_template('invite.html', invitation=None, motif=motif), 200
    return render_template('invite.html', invitation=invitation, invite_token=token)


@app.route('/auth/discord/login')
def discord_login():
    """Redirige vers Discord. Mémorise le state et l'invitation en session."""
    if not DISCORD_CLIENT_ID or not DISCORD_REDIRECT_URI:
        flash("La connexion Discord n'est pas configurée sur ce serveur.", 'warning')
        return redirect(url_for('index'))

    state = secrets.token_urlsafe(24)
    session['oauth_state'] = state
    # L'invitation transite par la session, pas par le paramètre state : elle
    # n'a pas à faire l'aller-retour par Discord ni à apparaître dans ses logs.
    invite_token = request.args.get('invite')
    if invite_token:
        session['invite_token'] = invite_token
    # Case cochée sur la page d'invitation. Transite par la session : elle n'a
    # pas à faire l'aller-retour par Discord.
    session['cgu_acceptee'] = request.args.get('cgu') == '1'
    session.permanent = True

    params = {
        'client_id': DISCORD_CLIENT_ID,
        'redirect_uri': DISCORD_REDIRECT_URI,
        'response_type': 'code',
        # identify seul : ni email, ni guilds.
        'scope': 'identify',
        'state': state,
        'prompt': 'none',
    }
    return redirect(f"{DISCORD_AUTHORIZE_URL}?{urlencode(params)}")


@app.route('/auth/discord/callback')
def discord_callback():
    """Retour de Discord : vérifie le state, puis fait échanger le code."""
    erreur = request.args.get('error')
    if erreur:
        # Cas normal : l'utilisateur a cliqué « Annuler ».
        flash("Connexion Discord annulée.", 'info')
        return redirect(url_for('index'))

    state = request.args.get('state')
    attendu = session.pop('oauth_state', None)
    # Comparaison en temps constant, et un state à usage unique : il vient
    # d'être retiré de la session, un rejeu échouera.
    if not state or not attendu or not secrets.compare_digest(state, attendu):
        flash("Requête de connexion invalide ou expirée. Réessayez.", 'danger')
        return redirect(url_for('index'))

    code = request.args.get('code')
    if not code:
        flash("Réponse Discord incomplète.", 'danger')
        return redirect(url_for('index'))

    invite_token = session.pop('invite_token', None)
    data, status = backend_request(
        'POST', '/auth/discord/exchange',
        data={
            'code': code,
            'invite_token': invite_token,
            'redirect_uri': DISCORD_REDIRECT_URI,
            'user_agent': request.headers.get('User-Agent', '')[:255],
            'cgu_acceptee': session.pop('cgu_acceptee', False),
        },
        timeout=OAUTH_EXCHANGE_TIMEOUT,
    )

    if status != 200 or not isinstance(data, dict) or 'session_token' not in data:
        code = data.get('code') if isinstance(data, dict) else None
        if code == 'invitation_requise':
            # Cas normal : quelqu'un a cliqué « Se connecter » sans avoir de
            # compte. Le bouton sert à revenir, pas à s'inscrire.
            flash("Connexion non autorisée. "
                  "L'inscription se fait par lien d'invitation, demandez-en un "
                  "à un administrateur.", 'warning')
        else:
            message = data.get('error') if isinstance(data, dict) else None
            flash(message or "La connexion a échoué. Réessayez dans un instant.", 'danger')
        return redirect(url_for('index'))

    # Seul un jeton opaque va en session : le cookie Flask est côté client et
    # plafonné à 4 Ko, il n'a pas à porter le profil.
    session.permanent = True
    session['player_token'] = data['session_token']
    session['compte'] = data.get('compte')

    compte = data.get('compte') or {}
    if compte.get('joueur_id'):
        flash(f"Connecté en tant que {compte.get('pseudo')}.", 'success')
        return redirect(url_for('index'))

    flash("Connexion réussie. Il reste à vous rattacher à votre fiche joueur.", 'info')
    return redirect(url_for('index'))


@app.route('/logout')
def player_logout():
    """Déconnexion joueur. Ne touche pas à la session admin (miroir de R-13)."""
    token = session.get('player_token')
    if token:
        try:
            requests.post(
                f"{BACKEND_URL}/auth/logout",
                headers={'X-Session-Token': token},
                timeout=2,
            )
        except Exception:
            pass
    session.pop('player_token', None)
    session.pop('compte', None)
    flash('Vous avez été déconnecté', 'info')
    return redirect(url_for('index'))


# ===========================================================================
# Comptes joueurs : liaison, profil, administration
# ===========================================================================

def player_headers():
    """En-tête d'auth joueur, construit depuis la session serveur.

    Le navigateur n'envoie jamais ce jeton lui-même : le mettre dans le DOM
    créerait exactement la surface d'exfiltration qu'on vient de retirer aux
    pages admin.
    """
    token = session.get('player_token')
    return {'X-Session-Token': token} if token else None


@app.route('/mon-compte')
def mon_compte():
    if not session.get('player_token'):
        flash('Connectez-vous pour accéder à votre compte.', 'warning')
        return redirect(url_for('index'))

    moi, status = backend_request('GET', '/auth/me', headers=player_headers())
    if status in (401, 403):
        session.pop('player_token', None)
        session.pop('compte', None)
        flash('Votre session a expiré. Reconnectez-vous.', 'warning')
        return redirect(url_for('index'))
    if status != 200:
        flash('Service momentanément indisponible.', 'warning')
        return redirect(url_for('index'))

    # Le miroir Discord peut avoir changé depuis la connexion : on rafraîchit
    # la copie en session pour que la navbar reste juste.
    session['compte'] = {
        'id': moi.get('id'), 'discord_id': moi.get('discord_id'),
        'pseudo': moi.get('pseudo'), 'avatar_url': moi.get('avatar_url'),
        'joueur_id': moi.get('joueur_id'), 'statut': moi.get('statut'),
        'role': moi.get('role'),
    }

    demande, _ = backend_request('GET', '/auth/ma-demande', headers=player_headers())
    return render_template(
        'mon_compte.html',
        moi=moi,
        demande=(demande or {}).get('demande'),
    )


@app.route('/mon-compte/liaison')
def mon_compte_liaison():
    if not session.get('player_token'):
        flash('Connectez-vous pour vous rattacher à une fiche joueur.', 'warning')
        return redirect(url_for('index'))

    moi, status = backend_request('GET', '/auth/me', headers=player_headers())
    if status != 200:
        flash('Service momentanément indisponible.', 'warning')
        return redirect(url_for('index'))
    if moi.get('joueur_id'):
        return redirect(url_for('mon_compte'))

    joueurs, st = backend_request('GET', '/auth/joueurs-disponibles', headers=player_headers())
    demande, _ = backend_request('GET', '/auth/ma-demande', headers=player_headers())
    return render_template(
        'mon_compte_liaison.html',
        moi=moi,
        joueurs=joueurs if st == 200 else [],
        demande=(demande or {}).get('demande'),
    )


@app.route('/me/notifications', methods=['GET'])
def proxy_mes_notifications():
    """Interrogee par la navbar a chaque page. Repond 200 avec un compteur a
    zero plutot qu'une erreur quand personne n'est connecte : la navbar n'a pas
    a distinguer « pas connecte » de « en panne »."""
    headers = player_headers()
    if headers is None:
        return jsonify({'non_lues': 0, 'notifications': []})
    data, status = backend_request('GET', '/me/notifications', headers=headers)
    if status != 200:
        return jsonify({'non_lues': 0, 'notifications': []})
    return jsonify(data)


@app.route('/me/notifications/lues', methods=['POST'])
def proxy_notifications_lues():
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    data, status = backend_request('POST', '/me/notifications/lues', data={}, headers=headers)
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


@app.route('/admin/notifications', methods=['GET'])
def proxy_notifications_admin():
    """Pastilles de la navbar admin. Meme parti pris : jamais d'erreur, un
    compteur a zero suffit a ne rien afficher."""
    headers = admin_headers()
    if headers is None:
        return jsonify({'total': 0, 'liaisons_en_attente': 0})
    data, status = backend_request('GET', '/admin/notifications', headers=headers)
    if status != 200:
        return jsonify({'total': 0, 'liaisons_en_attente': 0})
    return jsonify(data)


@app.route('/auth/demande-creation', methods=['POST'])
def proxy_demande_creation():
    """Demande de creation d'une fiche joueur. Le nom vient du pseudo Discord,
    lu cote backend : le navigateur ne le choisit pas."""
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    data, status = backend_request(
        'POST', '/auth/demande-creation', data=request.get_json(silent=True) or {},
        headers=headers,
    )
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


@app.route('/auth/demande-liaison', methods=['POST', 'DELETE'])
def proxy_demande_liaison():
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    if request.method == 'DELETE':
        data, status = backend_request('DELETE', '/auth/demande-liaison', headers=headers)
    else:
        data, status = backend_request(
            'POST', '/auth/demande-liaison', data=request.get_json(silent=True) or {},
            headers=headers,
        )
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


# Pas d'écran de réglages de profil : « Mon profil » mène à la fiche publique.
# `GET/PUT /me/profil` existe toujours côté backend, mais n'est plus relayé ici
# — et le backend n'est proxifié par nginx que via ce frontend, donc les deux
# routes sont hors d'atteinte tant que ce proxy n'est pas rétabli.


@app.route('/admin/comptes')
def admin_comptes():
    if not _est_admin():
        flash('Accès réservé aux administrateurs', 'warning')
        return redirect(url_for('admin_login'))
    compte = session.get('compte') or {}
    return render_template('admin_comptes.html', est_superadmin=(compte.get('role') == 'superadmin'))


# Proxies JSON de la page d'administration des comptes. Tous construisent
# l'en-tête depuis la session : le JS n'a aucun jeton à porter.
def _proxy_admin(method, endpoint, json_body=False):
    headers = admin_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    data = (request.get_json(silent=True) or {}) if json_body else None
    resultat, status = backend_request(method, endpoint, data=data, headers=headers)
    return jsonify(resultat if resultat is not None else {'error': 'Service indisponible'}), status


@app.route('/admin/liaisons')
def proxy_liaisons():
    statut = request.args.get('statut', 'pending')
    return _proxy_admin('GET', f'/admin/liaisons?statut={statut}')


@app.route('/admin/liaisons/<int:demande_id>/approve', methods=['POST'])
def proxy_liaison_approve(demande_id):
    return _proxy_admin('POST', f'/admin/liaisons/{demande_id}/approve', json_body=True)


@app.route('/admin/liaisons/<int:demande_id>/reject', methods=['POST'])
def proxy_liaison_reject(demande_id):
    return _proxy_admin('POST', f'/admin/liaisons/{demande_id}/reject', json_body=True)


@app.route('/admin/api/comptes')
def proxy_comptes_liste():
    return _proxy_admin('GET', '/admin/comptes')


@app.route('/admin/comptes/<int:compte_id>/sync-preview')
def proxy_sync_preview(compte_id):
    return _proxy_admin('GET', f'/admin/comptes/{compte_id}/sync-preview')


@app.route('/admin/comptes/<int:compte_id>/sync', methods=['POST'])
def proxy_sync(compte_id):
    return _proxy_admin('POST', f'/admin/comptes/{compte_id}/sync', json_body=True)


@app.route('/admin/comptes/<int:compte_id>/role', methods=['POST'])
def proxy_role(compte_id):
    return _proxy_admin('POST', f'/admin/comptes/{compte_id}/role', json_body=True)


@app.route('/admin/comptes/<int:compte_id>/statut', methods=['POST'])
def proxy_statut(compte_id):
    return _proxy_admin('POST', f'/admin/comptes/{compte_id}/statut', json_body=True)


@app.route('/admin/comptes/<int:compte_id>/delier', methods=['POST'])
def proxy_delier(compte_id):
    return _proxy_admin('POST', f'/admin/comptes/{compte_id}/delier', json_body=True)


@app.route('/admin/comptes/<int:compte_id>/sessions', methods=['DELETE'])
def proxy_sessions(compte_id):
    return _proxy_admin('DELETE', f'/admin/comptes/{compte_id}/sessions')


@app.route('/admin/invitations', methods=['GET', 'POST'])
def proxy_invitations():
    if request.method == 'POST':
        return _proxy_admin('POST', '/admin/invitations', json_body=True)
    return _proxy_admin('GET', '/admin/invitations')


@app.route('/admin/invitations/<int:invitation_id>/revoquer', methods=['POST'])
def proxy_invitation_revoquer(invitation_id):
    return _proxy_admin('POST', f'/admin/invitations/{invitation_id}/revoquer', json_body=True)


# ===========================================================================
# API de service pour les bots Discord
# ===========================================================================
# nginx n'est pas sur le réseau `backend` : il ne proxifie que frontend:5000.
# Aucune route /api/bot/* définie sur le backend n'est donc joignable depuis
# internet sans ce relais. C'est le choix retenu — cohérent avec les routes
# d'administration, et sans élargir la surface réseau exposée.
#
# Contrairement aux proxys admin, celui-ci ne construit AUCUN en-tête : le bot
# porte son propre jeton, on se contente de le transmettre.

BOT_TIMEOUT = 10


@app.route('/api/bot/<path:chemin>', methods=['GET', 'POST'])
@csrf.exempt
def proxy_bot(chemin):
    """Relais vers l'API de service du backend.

    `csrf.exempt` n'est pas une facilité : la protection CSRF défend un
    navigateur qui envoie automatiquement un cookie. Ici l'appelant est une
    machine qui présente un jeton Bearer explicite — il n'y a pas de cookie à
    détourner, et sans cette exemption tout POST de bot serait rejeté par
    CSRFProtect avec un message qui ne parlerait de rien.
    """
    autorisation = request.headers.get('Authorization')
    if not autorisation:
        return jsonify({"error": "Authentification requise", "code": "auth_requise"}), 401

    url = f"{BACKEND_URL}/api/bot/{chemin}"
    entetes = {'Authorization': autorisation}
    try:
        if request.method == 'POST':
            reponse = requests.post(
                url, json=request.get_json(silent=True) or {},
                headers=entetes, timeout=BOT_TIMEOUT,
            )
        else:
            reponse = requests.get(
                url, params=request.args, headers=entetes, timeout=BOT_TIMEOUT,
            )
    except requests.exceptions.RequestException:
        return jsonify({"error": "Service indisponible", "code": "indisponible"}), 503

    try:
        return jsonify(reponse.json()), reponse.status_code
    except ValueError:
        return jsonify({"error": "Réponse illisible"}), 502


@app.route('/admin/matchmaking/generer', methods=['POST'])
def proxy_matchmaking():
    # Chemin distinct de la page /admin/matchmaking : Flask saurait les
    # distinguer par la méthode, mais deux routes homonymes pour deux rôles
    # différents est une confusion qu'on ne se doit pas.
    return _proxy_admin('POST', '/admin/matchmaking', json_body=True)


@app.route('/admin/service-tokens', methods=['GET', 'POST'])
def proxy_service_tokens():
    if request.method == 'POST':
        return _proxy_admin('POST', '/admin/service-tokens', json_body=True)
    return _proxy_admin('GET', '/admin/service-tokens')


@app.route('/admin/service-tokens/<int:token_id>', methods=['DELETE'])
def proxy_service_token_revoquer(token_id):
    return _proxy_admin('DELETE', f'/admin/service-tokens/{token_id}')


# ===========================================================================
# RGPD : information, accès, effacement
# ===========================================================================

@app.route('/confidentialite')
def confidentialite():
    return render_template('confidentialite.html')


@app.route('/mentions-legales')
def mentions_legales():
    return render_template('mentions_legales.html')


@app.route('/me/cgu', methods=['POST'])
def proxy_cgu():
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    data, status = backend_request('POST', '/me/cgu', data={}, headers=headers)
    if status == 200 and isinstance(session.get('compte'), dict):
        session['compte']['cgu_a_accepter'] = False
        session.modified = True
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


@app.route('/mon-compte/export')
def exporter_mes_donnees():
    """Télécharge l'export en JSON.

    Passe par une route dédiée plutôt que par le proxy générique : le navigateur
    doit recevoir un fichier, pas afficher du JSON dans l'onglet.
    """
    headers = player_headers()
    if headers is None:
        flash('Connectez-vous pour exporter vos données.', 'warning')
        return redirect(url_for('index'))

    data, status = backend_request('GET', '/me/export', headers=headers)
    if status != 200:
        flash("L'export a échoué. Réessayez dans un instant.", 'danger')
        return redirect(url_for('mon_compte'))

    charge = json.dumps(data, ensure_ascii=False, indent=2)
    nom = 'mkreset-mes-donnees-%s.json' % date.today().isoformat()
    return Response(
        charge,
        mimetype='application/json',
        headers={'Content-Disposition': 'attachment; filename="%s"' % nom},
    )


@app.route('/mon-compte/supprimer', methods=['POST'])
def supprimer_mon_compte():
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401

    data, status = backend_request('DELETE', '/me', headers=headers)
    if status == 200:
        # La session pointe vers un compte qui n'existe plus.
        session.pop('player_token', None)
        session.pop('compte', None)
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


@app.route('/admin/joueurs/<int:joueur_id>/anonymiser', methods=['POST'])
def proxy_anonymiser_joueur(joueur_id):
    # Contrepartie du refus de suppression : celui-ci renvoie un 409 qui
    # oriente vers l'anonymisation, et la politique de confidentialité la
    # promet. Sans ce proxy, l'action était injoignable depuis l'interface.
    return _proxy_admin('POST', f'/admin/joueurs/{joueur_id}/anonymiser', json_body=True)


@app.route('/admin/purge-rgpd', methods=['POST'])
def proxy_purge_rgpd():
    return _proxy_admin('POST', '/admin/purge-rgpd', json_body=True)


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
    # Pas de session.clear() : le cookie est partagé avec la session joueur,
    # et l'admin qui se déconnecte éjecterait sa propre session Discord.
    session.pop('admin_token', None)
    session.pop('token_start_time', None)
    flash('Vous avez été déconnecté', 'info')
    return redirect(url_for('index'))


@app.route('/add_tournament', methods=['GET', 'POST'])
def add_tournament():
    if not _est_admin():
        flash('Accès réservé aux administrateurs', 'warning')
        return redirect(url_for('admin_login'))

    headers = admin_headers()
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

        headers = admin_headers()
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

@app.route('/admin/matchmaking', methods=['GET'])
def matchmaking():
    # Ouvert à tout le monde : la page ne fait que consulter la liste publique
    # des joueurs (/joueurs/noms) et calcule les équipes côté client, aucune
    # action admin n'est effectuée ici.
    return render_template("matchmaking.html")

@app.route('/admin/revert_last', methods=['POST'])

def admin_revert_last():
    if not _est_admin():
        return jsonify({"error": "Non autorisé"}), 401
    try:
        headers = admin_headers()
        
        resp = requests.post(
            f"{BACKEND_URL}/api/admin/revert-last-tournament",
            headers=headers 
        )
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/admin/gestion')
def admin_gestion():
    if not _est_admin():
        flash('Accès interdit.', 'danger')
        return redirect(url_for('admin_login'))
    headers = admin_headers()
    _, status = backend_request('GET', '/admin/check-token', headers=headers)
    if status in [401, 403]:
        return _session_admin_expiree()
    return render_template('gestion_joueurs.html')

@app.route('/admin/saisons-gestion')
def admin_saisons_page():
    if not _est_admin():
        flash('Accès interdit.', 'danger')
        return redirect(url_for('admin_login'))
    headers = admin_headers()
    _, status = backend_request('GET', '/admin/check-token', headers=headers)
    if status in [401, 403]:
        return _session_admin_expiree()
    return render_template('admin_saisons.html')


@app.route('/admin/saisons', methods=['GET', 'POST'])

def proxy_saisons():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    headers = admin_headers()
    if request.method == 'GET':
        data, status = backend_request('GET', '/admin/saisons', headers=headers)
    elif request.method == 'POST':
        data, status = backend_request('POST', '/admin/saisons', data=request.get_json(), headers=headers)
    return jsonify(data), status

@app.route('/admin/saisons/<int:id>', methods=['DELETE'])

def proxy_saisons_delete(id):
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    headers = admin_headers()
    data, status = backend_request('DELETE', f'/admin/saisons/{id}', headers=headers)
    return jsonify(data), status

@app.route('/admin/count-tournois-range', methods=['GET'])
def proxy_count_tournois_range():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    headers = admin_headers()
    d_debut = request.args.get('date_debut', '')
    d_fin = request.args.get('date_fin', '')
    data, status = backend_request('GET', f'/admin/count-tournois-range?date_debut={d_debut}&date_fin={d_fin}', headers=headers)
    return jsonify(data), status

@app.route('/admin/saisons/<int:id>/count-tournois', methods=['GET'])

def proxy_saisons_count_tournois(id):
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    headers = admin_headers()
    data, status = backend_request('GET', f'/admin/saisons/{id}/count-tournois', headers=headers)
    return jsonify(data), status

@app.route('/admin/saisons/<int:id>/save-awards', methods=['POST'])

def proxy_saisons_save_awards(id):
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    headers = admin_headers()
    payload = request.get_json(silent=True) or {}
    data, status = backend_request('POST', f'/admin/saisons/{id}/save-awards', data=payload, headers=headers)
    return jsonify(data), status

@app.route('/admin/joueurs', methods=['GET', 'POST'])

def proxy_joueurs():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé : Session expirée'}), 403

    headers = admin_headers()

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

def proxy_joueurs_detail(id):
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    headers = admin_headers()
    if request.method == 'PUT':
        data, status = backend_request('PUT', f'/admin/joueurs/{id}', data=request.get_json(), headers=headers)
    elif request.method == 'DELETE':
        data, status = backend_request('DELETE', f'/admin/joueurs/{id}', headers=headers)
    return jsonify(data), status

@app.route('/admin/config', methods=['GET', 'POST'])

def proxy_config():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    headers = admin_headers()
    if request.method == 'GET':
        data, status = backend_request('GET', '/admin/config', headers=headers)
    elif request.method == 'POST':
        data, status = backend_request('POST', '/admin/config', data=request.get_json(), headers=headers)
    return jsonify(data), status

@app.route('/admin/global-reset', methods=['POST'])

def proxy_global_reset():
    if not _est_admin():
        return jsonify({"error": "Non autorisé"}), 401
    headers = admin_headers()
    data, status = backend_request('POST', '/api/admin/global-reset', data=request.get_json(), headers=headers)
    return jsonify(data), status

@app.route('/admin/revert-global-reset', methods=['POST'])

def proxy_revert_global_reset():
    if not _est_admin():
        return jsonify({"error": "Non autorisé"}), 401
    headers = admin_headers()
    data, status = backend_request('POST', '/api/admin/revert-global-reset', headers=headers)
    return jsonify(data), status

@app.route('/api/ligues', methods=['GET'])
def proxy_get_ligues_public():
    data, status = backend_request('GET', '/ligues')
    return jsonify(data), status

@app.route('/admin/ligues/setup', methods=['POST'])

def proxy_setup_ligues():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    
    headers = admin_headers()
    data, status = backend_request('POST', '/admin/ligues/setup', data=request.get_json(), headers=headers)
    return jsonify(data), status

@app.route('/admin/ligues/draft-simulation', methods=['GET'])

def proxy_draft_simulation():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    headers = admin_headers()
    data, status = backend_request('GET', '/admin/ligues/draft-simulation', headers=headers)
    return jsonify(data), status

@app.route('/admin/ligues')
def admin_ligues_page():
    if not _est_admin():
        flash('Accès interdit.', 'danger')
        return redirect(url_for('admin_login'))
    
    headers = admin_headers()
    _, status = backend_request('GET', '/admin/check-token', headers=headers)
    if status in [401, 403]:
        return _session_admin_expiree()
        
    return render_template('admin_ligues.html')


@app.after_request
def add_header(response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
