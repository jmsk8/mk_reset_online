import hashlib
import os
import re
import sys
import logging
import secrets
import requests
import time
from urllib.parse import urlencode, urlparse
import json
from pathlib import Path
from flask import (Flask, g, render_template, request, redirect, url_for, session,
                   flash, jsonify, Response, stream_with_context)
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

# Le cookie ne doit pas expirer avant la session backend (30 j joueur, 12 h admin).
app.permanent_session_lifetime = timedelta(days=30)

app.config['SESSION_COOKIE_HTTPONLY'] = True
# Pas 'Strict' : le retour de Discord est une navigation cross-site.
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
# Secure seulement en https (sinon la connexion echoue en http local).
app.config['SESSION_COOKIE_SECURE'] = (os.environ.get('TLS_MODE', 'http') == 'https')
# Jeton CSRF valable aussi longtemps que la session.
app.config['WTF_CSRF_TIME_LIMIT'] = None

csrf = CSRFProtect(app)

APP_VERSION = "2.0.0"


def _empreinte_statiques():
    """Change des qu'un fichier statique change : sert de `?v=` aux liens."""
    racine = Path(app.static_folder)
    h = hashlib.sha1()
    for f in sorted(p for p in racine.rglob('*') if p.is_file()):
        h.update(f.relative_to(racine).as_posix().encode())
        h.update(f.read_bytes())
    return h.hexdigest()[:10]


STATIC_VERSION = _empreinte_statiques()

@app.context_processor
def inject_version():
    return dict(app_version=APP_VERSION, static_version=STATIC_VERSION)


def _sonde_session(endpoint, headers, sur_reponse=None):
    """Interroge une sonde de session. Renvoie True si le backend la refuse.

    Ne purge que sur 401/403 (un 5xx ou un timeout n'invalide pas la session).
    `sur_reponse` recoit le corps JSON d'une reponse 200 (role et permissions).
    """
    try:
        response = requests.get(f"{BACKEND_URL}{endpoint}", headers=headers, timeout=1)
    except Exception as e:
        logger.warning("Vérification de session impossible (%s) — session conservée", e)
        return False

    if response.status_code in (401, 403):
        return True
    if response.status_code != 200:
        logger.warning(
            "Backend indisponible (HTTP %s) — session conservée.", response.status_code
        )
    elif sur_reponse is not None:
        try:
            sur_reponse(response.json())
        except Exception as e:
            # Ne jamais casser la requete en cours (before_request).
            logger.warning("Réponse de sonde illisible (%s)", e)
    return False


def _est_navigation(chemin):
    """Vrai si ce chemin sert une page HTML plutot que des donnees.

    Lu sur l'en-tete Accept ; un Accept absent ou inconnu compte comme une
    navigation. Permet de ne sonder la session qu'une fois par page.
    """
    if chemin.startswith(('/static', '/avatar/')):
        return False
    return 'application/json' not in request.headers.get('Accept', '')


@app.before_request
def check_session_validity():
    """Revalide la session aupres du backend a l'ouverture de chaque page."""
    if not _est_navigation(request.path):
        return

    if session.get('player_token'):
        if _sonde_session('/auth/check-session',
                          {'X-Session-Token': session['player_token']},
                          sur_reponse=_maj_droits_session):
            logger.warning("Session Discord refusée -> déconnexion.")
            session.pop('player_token', None)
            session.pop('compte', None)
        else:
            g.session_revalidee = True
            return _exiger_consentement()


# Pages accessibles avant d'accepter la politique (le backend reste la vraie
# frontiere via player_required_sans_cgu).
_PAGES_SANS_CONSENTEMENT = frozenset({
    'consentement', 'confidentialite', 'mentions_legales', 'player_logout',
    'exporter_mes_donnees', 'discord_login', 'discord_callback', 'static',
})


def _exiger_consentement():
    """Renvoie vers la page d'acceptation si la politique en vigueur manque
    (pages HTML seulement)."""
    compte = session.get('compte')
    if not isinstance(compte, dict) or not compte.get('cgu_a_accepter'):
        return None
    if request.endpoint in _PAGES_SANS_CONSENTEMENT:
        return None
    if 'text/html' not in request.headers.get('Accept', ''):
        return None
    return redirect(url_for('consentement', suite=request.full_path.rstrip('?')))



def _acces_admin_revoque():
    """Vrai si le backend refuse maintenant cette session admin.

    A appeler en tete de chaque vue admin. Reutilise le verdict du
    before_request de la meme requete (memorise dans g).
    """
    if getattr(g, 'session_revalidee', False):
        return False
    _, status = backend_request('GET', '/admin/check-token', headers=admin_headers())
    return status in (401, 403)


def backend_request(method, endpoint, data=None, params=None, headers=None, timeout=5):
    """Appel JSON au backend (`timeout` allonge pour l'echange OAuth)."""
    url = f"{BACKEND_URL}{endpoint}"
    try:
        if method == 'GET':
            response = requests.get(url, params=params, headers=headers, timeout=timeout)
        elif method == 'POST':
            response = requests.post(url, json=data, headers=headers, timeout=timeout)
        elif method == 'PUT':
            response = requests.put(url, json=data, headers=headers, timeout=timeout)
        elif method == 'DELETE':
            # Un DELETE peut porter un corps.
            response = requests.delete(url, json=data, headers=headers, timeout=timeout)
        else:
            return None, 405
        
        try:
            return response.json(), response.status_code
        except ValueError:
            return response.text, response.status_code
    except requests.exceptions.RequestException:
        return None, 503


# ---------------------------------------------------------------------------
# Authentification admin
# ---------------------------------------------------------------------------

def _session_admin_expiree():
    """Sortie commune quand le backend refuse la session sur une page admin."""
    session.pop('player_token', None)
    session.pop('compte', None)
    flash('Votre session a expiré. Reconnectez-vous avec Discord.', 'warning')
    return redirect(url_for('index'))


# Roles qui ouvrent les pages d'administration.
ROLES_ADMIN = ('admin', 'chef_admin', 'superadmin')

# Copie du catalogue de backEnd/constants.py (alignement verifie par test_revue).
PERMISSIONS_CATALOGUE = frozenset({
    'gestion_joueurs', 'joueurs_creation', 'joueurs_nom', 'joueurs_couleur',
    'edition_mu_sigma', 'joueurs_statut', 'joueurs_irreversible',
    'gestion_tournois', 'gestion_ligues',
    'gestion_saisons', 'gestion_liaisons', 'gestion_comptes',
    'gestion_invitations', 'gestion_config', 'gestion_matchmaking',
})

# Copie de backEnd/constants.SOUS_PERMISSIONS (enfant -> parent).
SOUS_PERMISSIONS = {
    'joueurs_creation': 'gestion_joueurs',
    'joueurs_nom': 'gestion_joueurs',
    'joueurs_couleur': 'gestion_joueurs',
    'edition_mu_sigma': 'gestion_joueurs',
    'joueurs_statut': 'gestion_joueurs',
    'joueurs_irreversible': 'gestion_joueurs',
}


def _role_session():
    """Role de la session, '' si absent (copie potentiellement perimee)."""
    return (session.get('compte') or {}).get('role') or ''


def _permissions_session():
    """Permissions de la session, pour l'affichage seulement (set).

    Sans la cle, le catalogue complet est suppose pour chef_admin et superadmin.
    """
    compte = session.get('compte') or {}
    permissions = compte.get('permissions')
    if permissions is None:
        socle_complet = compte.get('role') in ('chef_admin', 'superadmin')
        return set(PERMISSIONS_CATALOGUE) if socle_complet else set()
    return set(permissions)


def _est_admin():
    """Vrai si la session ouvre les pages d'administration (affichage ; le
    backend reverifie a chaque requete)."""
    return _role_session() in ROLES_ADMIN


def admin_headers():
    """En-tete d'auth admin depuis la session serveur, ou None."""
    if session.get('player_token') and _role_session() in ROLES_ADMIN:
        return {'X-Session-Token': session['player_token']}
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


# Tournois rattachables a une session, et ceux en conflit de joueurs.
@app.route('/admin/tournois/verifier-session', methods=['POST'])
def proxy_verifier_session():
    if not _est_admin():
        return jsonify({'status': 'error', 'message': 'Non autorisé'}), 403
    try:
        response = requests.post(
            f'{BACKEND_URL}/admin/tournois/verifier-session',
            json=request.get_json(), headers=admin_headers())
        return jsonify(response.json()), response.status_code
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


# Liaison tardive de deux tournois deja enregistres.
@app.route('/admin/tournois/<int:tournoi_id>/lier-session', methods=['POST'])
def proxy_lier_session(tournoi_id):
    if not _est_admin():
        return jsonify({'status': 'error', 'message': 'Non autorisé'}), 403
    try:
        response = requests.post(
            f'{BACKEND_URL}/admin/tournois/{tournoi_id}/lier-session',
            json=request.get_json(), headers=admin_headers())
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
        # Message d'erreur affiche par recap.html.
        return render_template(
            "introuvable.html",
            titre="Ce récapitulatif n'existe plus",
            message="La saison a été supprimée.",
            retour_url=url_for('recap_default'),
            retour_libelle="Voir les récapitulatifs",
        ), 404

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

    # Tiers par rang decroissant (nom, couleur, seuil).
    tiers = []
    tiers_data, tiers_status = backend_request('GET', '/tier-seuils')
    if tiers_status == 200 and isinstance(tiers_data, list):
        tiers = tiers_data
    # Couleur de chaque tier pour les badges.
    tiers_couleurs = {t.get('nom'): t.get('couleur') for t in tiers if t.get('nom')}
    couleur_u = _couleur_u()

    saison = None
    if vue == 'saison':
        s_params = {}
        if saison_ligue_id:
            s_params['ligue_id'] = saison_ligue_id
        s_data, s_status = backend_request('GET', '/classement/saison', params=s_params)
        if s_status == 200 and isinstance(s_data, dict):
            saison = s_data

    return render_template("classement.html", joueurs=joueurs, tier_actif=tier, ligue_active=ligue_id, ligues=ligues, tiers=tiers, tiers_couleurs=tiers_couleurs, couleur_u=couleur_u, distribution_data=distribution_data, vue=vue, saison=saison)


_RE_COULEUR_HEX = re.compile(r'#[0-9a-fA-F]{3,8}')


def _couleur_u():
    """Couleur de la pastille U, blanc si le backend ne repond pas (revalidee :
    elle finit dans un attribut style)."""
    data, status = backend_request('GET', '/tiers/unranked')
    couleur = data.get('couleur') if status == 200 and isinstance(data, dict) else None
    return couleur if isinstance(couleur, str) and _RE_COULEUR_HEX.fullmatch(couleur) else '#FFFFFF'


@app.template_filter('texte_lisible')
def texte_lisible(couleur):
    """Noir ou blanc selon le contraste avec `couleur` (meme calcul que texteSur()
    de tier_thresholds.js)."""
    if not isinstance(couleur, str) or not _RE_COULEUR_HEX.fullmatch(couleur):
        return '#0a0a0a'
    h = couleur[1:]
    h = ''.join(c * 2 for c in h[:3]) if len(h) in (3, 4) else h[:6]
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return '#0a0a0a' if (0.299 * r + 0.587 * g + 0.114 * b) > 150 else '#ffffff'


def _rendre_fiche_joueur(nom, data):
    # Couleur de chaque tier.
    tiers_couleurs = {}
    tiers_data, tiers_status = backend_request('GET', '/tier-seuils')
    if tiers_status == 200 and isinstance(tiers_data, list):
        tiers_couleurs = {t.get('nom'): t.get('couleur') for t in tiers_data if t.get('nom')}
    stats = data.get('stats') or {}
    couleur_u = _couleur_u() if stats.get('tier') == 'U' else None

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
        tiers_couleurs=tiers_couleurs,
        couleur_u=couleur_u,
    )


@app.route('/joueur/<int:joueur_id>')
def joueur_detail(joueur_id):
    """URL canonique d'une fiche joueur, par identifiant."""
    data, status = backend_request('GET', f'/joueur/{joueur_id}')
    if status == 200:
        return _rendre_fiche_joueur(data.get('nom'), data)
    return render_template(
        "introuvable.html",
        titre="Cette fiche joueur n'existe plus",
        message="Elle a été supprimée ou anonymisée. Si c'était la vôtre, vous "
                "pouvez en demander une nouvelle depuis « Mon compte ».",
        retour_url=url_for('classement'),
        retour_libelle="Voir le classement",
    ), 404


@app.route('/stats/joueur/<nom>')
def stats_joueur_detail(nom):
    """Ancienne URL par nom : redirection 301 vers l'URL canonique."""
    resolu, status = backend_request('GET', f'/joueurs/resolve/{nom}')
    if status == 200 and isinstance(resolu, dict) and resolu.get('id'):
        return redirect(url_for('joueur_detail', joueur_id=resolu['id']), code=301)

    # Backend indisponible : pas de 301 (mise en cache par le navigateur).
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

    # Couleur de chaque tier.
    tiers_couleurs = {}
    tiers_data, tiers_status = backend_request('GET', '/tier-seuils')
    if tiers_status == 200 and isinstance(tiers_data, list):
        tiers_couleurs = {t.get('nom'): t.get('couleur') for t in tiers_data if t.get('nom')}

    return render_template("stats_joueurs.html", joueurs=joueurs, distribution_tiers=dist,
                           tiers_couleurs=tiers_couleurs, couleur_u=_couleur_u())

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
    # Cible disparue (ex. tournoi annule apres sa notification).
    return render_template(
        "introuvable.html",
        titre="Ce tournoi n'existe plus",
        message="Il a été annulé ou supprimé.",
        retour_url=url_for('stats_tournois'),
        retour_libelle="Voir tous les tournois",
    ), 404


# ===========================================================================
# Authentification Discord (joueurs)
# ===========================================================================

DISCORD_CLIENT_ID = os.environ.get('DISCORD_CLIENT_ID', '')
# Toujours l'environnement : derriere nginx, url_for(_external=True) donnerait du
# http://. Une ou plusieurs URI separees par des virgules.
DISCORD_REDIRECT_URI = os.environ.get('DISCORD_REDIRECT_URI', '')
DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
# Deux appels a Discord cote backend.
OAUTH_EXCHANGE_TIMEOUT = 20

# States OAuth en attente : plusieurs a la fois (onglets, double clic), en
# nombre et en duree bornes.
OAUTH_STATES_MAX = 5
OAUTH_STATE_TTL = 15 * 60


def _redirect_uris():
    return [u.strip() for u in DISCORD_REDIRECT_URI.split(',') if u.strip()]


def _redirect_uri():
    """URI de retour declaree pour l'hote consulte, a defaut la premiere.

    Le cookie qui porte le `state` est lie a l'hote : le retour doit y revenir.
    """
    uris = _redirect_uris()
    if not uris:
        return ''
    # `//` pour que urlparse lise l'hote.
    hote = urlparse('//' + request.host).hostname
    for uri in uris:
        if urlparse(uri).hostname == hote:
            return uri
    return uris[0]


# Identite de l'editeur pour les pages legales, fournie par l'environnement.
MENTIONS = {
    'editeur': os.environ.get('SITE_EDITEUR', '[à renseigner : nom de l’éditeur]'),
    'contact': os.environ.get('SITE_CONTACT', '[à renseigner : adresse de contact]'),
    'hebergeur': os.environ.get('SITE_HEBERGEUR', '[à renseigner : hébergeur et pays]'),
    # Duree annoncee ; la limite technique actuelle est une taille (30 Mo par service).
    'retention_logs': os.environ.get('SITE_RETENTION_LOGS', "6 mois au maximum"),
}
# Doit rester identique a constants.CGU_VERSION cote backend.
CGU_VERSION = "1.0"


@app.context_processor
def inject_mentions():
    return dict(cgu_version=CGU_VERSION, cgu_date='26 septembre 2026', **MENTIONS)


@app.context_processor
def inject_discord_configure():
    """Affiche le bouton de connexion seulement si Discord est configure."""
    return dict(discord_configure=bool(DISCORD_CLIENT_ID and _redirect_uris()))


def _maj_droits_session(corps):
    """Recopie role, permissions et cgu_a_accepter servis par la sonde de session.

    Appelee depuis le before_request : la copie en session reste a jour sans
    appel supplementaire.
    """
    compte = session.get('compte')
    if not isinstance(compte, dict) or not isinstance(corps, dict):
        return
    if 'role' not in corps and 'permissions' not in corps:
        return  # backend sans ces champs : on garde la copie
    champs = ('role', 'permissions', 'cgu_a_accepter')
    if all(compte.get(c) == corps.get(c) for c in champs):
        return  # rien de neuf : pas de reecriture du cookie
    for c in champs:
        compte[c] = corps.get(c)
    session.modified = True


@app.errorhandler(404)
def page_introuvable(_e):
    """Page commune pour toute URL inexistante (JSON pour les appels fetch)."""
    if not _est_navigation(request.path):
        return jsonify({'error': 'Ressource introuvable'}), 404
    return render_template(
        "introuvable.html",
        titre="Page introuvable",
        message="Cette adresse ne correspond à aucune page. Le lien est "
                "peut-être périmé.",
    ), 404


@app.context_processor
def inject_est_admin():
    """Expose aux templates : `est_admin`, `role_admin` (capacites de role) et
    `peut(...)` (permissions)."""
    permissions = _permissions_session()
    return dict(
        est_admin=_est_admin(),
        role_admin=_role_session(),
        peut=lambda permission: permission in permissions,
    )


@app.context_processor
def inject_compte():
    """Expose le compte joueur aux templates (navbar, pages profil)."""
    return dict(compte_joueur=session.get('compte'))


@app.route('/invite/<token>')
def invite(token):
    """Page d'accueil d'une invitation, sans la consommer (apercus de lien)."""
    data, status = backend_request('GET', f'/auth/invitation/{token}')
    invitation = data if status == 200 and isinstance(data, dict) else None
    if invitation is None:
        motif = data.get('code') if isinstance(data, dict) else 'indisponible'
        return render_template('invite.html', invitation=None, motif=motif), 200
    return render_template('invite.html', invitation=invitation, invite_token=token)


# ---------------------------------------------------------------------------
# States OAuth en attente
# ---------------------------------------------------------------------------
# Une liste de states plutot qu'une case unique : une seconde connexion
# n'ecrase pas la premiere, et un echec ne consomme pas les states valides.

def _deposer_state(state: str) -> None:
    """Ajoute un state en attente, en purgeant les périmés et les surnuméraires."""
    limite = time.time() - OAUTH_STATE_TTL
    # Purge des perimes avant d'appliquer la borne de taille.
    en_attente = [s for s in session.get('oauth_states', [])
                  if isinstance(s, list) and len(s) == 2 and s[1] > limite]
    en_attente.append([state, time.time()])
    # Les plus anciens sautent en premier.
    session['oauth_states'] = en_attente[-OAUTH_STATES_MAX:]


def _consommer_state(recu: str | None) -> bool:
    """Retire le state correspondant (comparaison en temps constant). Ne
    consomme rien si rien ne correspond."""
    if not recu:
        return False
    # En octets : compare_digest leve sur une chaine non ASCII.
    recu_b = recu.encode('utf-8', 'surrogatepass')
    limite = time.time() - OAUTH_STATE_TTL
    en_attente = [s for s in session.get('oauth_states', [])
                  if isinstance(s, list) and len(s) == 2
                  and isinstance(s[0], str) and isinstance(s[1], (int, float))]

    for i, (state, pose_a) in enumerate(en_attente):
        if pose_a > limite and secrets.compare_digest(
                state.encode('utf-8', 'surrogatepass'), recu_b):
            # Usage unique.
            del en_attente[i]
            session['oauth_states'] = en_attente
            return True

    # Aucune correspondance : on retire seulement les perimes.
    restants = [s for s in en_attente if s[1] > limite]
    if len(restants) != len(en_attente):
        session['oauth_states'] = restants
    return False


@app.route('/auth/discord/login')
def discord_login():
    """Redirige vers Discord. Mémorise le state et l'invitation en session."""
    if not DISCORD_CLIENT_ID or not _redirect_uris():
        flash("La connexion Discord n'est pas configurée sur ce serveur.", 'warning')
        return redirect(url_for('index'))

    state = secrets.token_urlsafe(24)
    _deposer_state(state)
    # L'invitation passe par la session, pas par Discord.
    invite_token = request.args.get('invite')
    if invite_token:
        session['invite_token'] = invite_token
    session.permanent = True

    params = {
        'client_id': DISCORD_CLIENT_ID,
        'redirect_uri': _redirect_uri(),
        'response_type': 'code',
        'scope': 'identify',
        'state': state,
        # Ecran d'autorisation a chaque connexion : il montre avec quel compte
        # Discord on entre.
        'prompt': 'consent',
    }
    return redirect(f"{DISCORD_AUTHORIZE_URL}?{urlencode(params)}")


@app.route('/auth/discord/callback')
def discord_callback():
    """Retour de Discord : vérifie le state, puis fait échanger le code."""
    erreur = request.args.get('error')
    if erreur:
        flash("Connexion Discord annulée.", 'info')
        return redirect(url_for('index'))

    state = request.args.get('state')
    if not _consommer_state(state):
        # State present mais inconnu (lien rouvert, retour arriere) ou absent.
        if state:
            flash("Cette demande de connexion a déjà servi ou a expiré. "
                  "Relancez la connexion.", 'info')
        else:
            logger.warning("Callback Discord sans state (IP %s)", request.remote_addr)
            flash("Requête de connexion invalide. Réessayez.", 'danger')
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
            # Meme URI qu'a l'aller.
            'redirect_uri': _redirect_uri(),
            'user_agent': request.headers.get('User-Agent', '')[:255],
        },
        timeout=OAUTH_EXCHANGE_TIMEOUT,
    )

    if status != 200 or not isinstance(data, dict) or 'session_token' not in data:
        code = data.get('code') if isinstance(data, dict) else None
        if code == 'invitation_requise':
            # Pas de compte : il faut une invitation.
            flash("Connexion non autorisée. "
                  "L'inscription se fait par lien d'invitation, demandez-en un "
                  "à un administrateur.", 'warning')
        else:
            message = data.get('error') if isinstance(data, dict) else None
            flash(message or "La connexion a échoué. Réessayez dans un instant.", 'danger')
        return redirect(url_for('index'))

    # Seul un jeton opaque va dans le cookie (limite de 4 Ko).
    session.permanent = True
    session['player_token'] = data['session_token']
    session['compte'] = data.get('compte')

    compte = data.get('compte') or {}
    if compte.get('cgu_a_accepter'):
        # Consentement a donner avant tout le reste.
        return redirect(url_for('consentement'))
    if compte.get('joueur_id'):
        flash(f"Connecté en tant que {compte.get('pseudo')}.", 'success')
        return redirect(url_for('index'))

    flash("Connexion réussie. Il reste à vous rattacher à votre fiche joueur.", 'info')
    return redirect(url_for('index'))


@app.route('/logout', methods=['GET', 'POST'])
def player_logout():
    """Deconnexion joueur, en POST avec jeton CSRF. Un GET renvoie simplement
    a l'accueil."""
    if request.method == 'GET':
        return redirect(url_for('index'))
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
    """En-tete d'auth joueur, construit depuis la session serveur."""
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

    # Rafraichit la copie du compte en session.
    session['compte'] = {
        'id': moi.get('id'), 'discord_id': moi.get('discord_id'),
        'pseudo': moi.get('pseudo'), 'avatar_url': moi.get('avatar_url'),
        'joueur_id': moi.get('joueur_id'), 'statut': moi.get('statut'),
        'role': moi.get('role'),
        'permissions': moi.get('permissions'),
        'cgu_a_accepter': moi.get('cgu_a_accepter'),
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


# Le backend peut devoir telecharger l'image chez Discord.
AVATAR_TIMEOUT = 10


def _relayer_avatar(chemin, headers=None):
    """Relaie une image depuis le backend, en conservant son cache navigateur."""
    try:
        amont = requests.get(
            f"{BACKEND_URL}{chemin}", headers=headers or {}, timeout=AVATAR_TIMEOUT,
        )
    except requests.exceptions.RequestException:
        return '', 502
    if amont.status_code != 200:
        return '', amont.status_code
    reponse = Response(amont.content,
                       mimetype=amont.headers.get('Content-Type', 'image/png'))
    reponse.headers['Cache-Control'] = amont.headers.get(
        'Cache-Control', 'public, max-age=3600')
    return reponse


@app.route('/avatar/joueur/<int:joueur_id>')
def proxy_avatar_joueur(joueur_id):
    return _relayer_avatar(f'/avatar/joueur/{joueur_id}')


@app.route('/avatar/moi')
def proxy_avatar_moi():
    headers = player_headers()
    if headers is None:
        return '', 404
    return _relayer_avatar('/avatar/moi', headers)


@app.route('/avatar/compte/<int:compte_id>')
def proxy_avatar_compte(compte_id):
    headers = admin_headers()
    if headers is None:
        return '', 404
    return _relayer_avatar(f'/avatar/compte/{compte_id}', headers)


@app.route('/discord/widget')
def proxy_discord_widget():
    """Widget Discord de l'accueil, relaye par le backend. Jamais d'erreur."""
    data, status = backend_request('GET', '/discord/widget')
    if status != 200 or not isinstance(data, dict):
        data = {}
    return jsonify({'presence_count': data.get('presence_count'),
                    'instant_invite': data.get('instant_invite')})


@app.route('/me/notifications', methods=['GET'])
def proxy_mes_notifications():
    """Notifications de la navbar ; compteur a zero en cas d'erreur."""
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
    """Pastilles de la navbar admin ; jamais d'erreur."""
    headers = admin_headers()
    if headers is None:
        return jsonify({'total': 0, 'liaisons_en_attente': 0})
    data, status = backend_request('GET', '/admin/notifications', headers=headers)
    if status != 200:
        return jsonify({'total': 0, 'liaisons_en_attente': 0})
    return jsonify(data)


@app.route('/auth/demande-creation', methods=['POST'])
def proxy_demande_creation():
    """Demande de creation d'une fiche (nom tire du pseudo Discord cote backend)."""
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


@app.route('/admin/comptes')
def admin_comptes():
    if not _est_admin():
        flash('Accès réservé aux administrateurs', 'warning')
        return redirect(url_for('index'))

    # Page ouverte avec au moins une des trois permissions ; chaque onglet est
    # gate dans le gabarit.
    if not ({'gestion_comptes', 'gestion_liaisons', 'gestion_invitations'}
            & _permissions_session()):
        flash("Vous n'avez pas accès à la gestion des comptes.", 'warning')
        return redirect(url_for('index'))

    if _acces_admin_revoque():
        return _session_admin_expiree()

    compte = session.get('compte') or {}
    # mon_compte_id : le JS ne propose pas d'agir sur sa propre ligne.
    return render_template(
        'admin_comptes.html',
        est_superadmin=(compte.get('role') == 'superadmin'),
        mon_compte_id=compte.get('id'),
        # Sous-permissions affichees en retrait sous leur parent.
        sous_permissions=SOUS_PERMISSIONS,
    )


# Proxies JSON de la page Comptes (en-tete construit depuis la session).
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


# Propositions de promotion, cote proposant (l'acceptation est sous /mon-compte).
@app.route('/admin/comptes/<int:compte_id>/promotion', methods=['POST'])
def proxy_proposer_promotion(compte_id):
    return _proxy_admin('POST', f'/admin/comptes/{compte_id}/promotion', json_body=True)


@app.route('/admin/comptes/<int:compte_id>/promotion', methods=['DELETE'])
def proxy_annuler_promotion(compte_id):
    return _proxy_admin('DELETE', f'/admin/comptes/{compte_id}/promotion')


# Journal d'audit : volet d'une ligne, onglet complet et export.
@app.route('/admin/comptes/<int:compte_id>/audit')
def proxy_journal_compte(compte_id):
    qs = request.query_string.decode()
    return _proxy_admin('GET', '/admin/comptes/%d/audit%s'
                        % (compte_id, ('?' + qs) if qs else ''))


@app.route('/admin/audit')
def proxy_journal_complet():
    qs = request.query_string.decode()
    return _proxy_admin('GET', '/admin/audit' + (('?' + qs) if qs else ''))


@app.route('/admin/audit/export')
def proxy_journal_export():
    """Relaie le CSV en streaming (backend_request chargerait tout en memoire)."""
    headers = admin_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    try:
        amont = requests.get(f"{BACKEND_URL}/admin/audit/export",
                             headers=headers, stream=True, timeout=120)
    except Exception as e:
        logger.error("Export du journal injoignable : %s", e)
        return jsonify({'error': 'Service indisponible'}), 503
    if amont.status_code != 200:
        return jsonify({'error': 'Export refusé'}), amont.status_code
    return Response(
        stream_with_context(amont.iter_content(chunk_size=8192)),
        mimetype=amont.headers.get('Content-Type', 'text/csv'),
        headers={'Content-Disposition':
                 amont.headers.get('Content-Disposition', 'attachment')},
    )


@app.route('/admin/comptes/<int:compte_id>/permissions', methods=['GET'])
def proxy_permissions(compte_id):
    return _proxy_admin('GET', f'/admin/comptes/{compte_id}/permissions')


@app.route('/admin/comptes/<int:compte_id>/permissions/<permission>',
           methods=['POST', 'DELETE'])
def proxy_permission(compte_id, permission):
    # Permission validee par le backend.
    return _proxy_admin(request.method,
                        f'/admin/comptes/{compte_id}/permissions/{permission}')


@app.route('/admin/comptes/<int:compte_id>/leguer-superadmin', methods=['POST'])
def proxy_leguer_superadmin(compte_id):
    # Le corps porte la confirmation (handle Discord retape).
    reponse, status = _proxy_admin('POST', f'/admin/comptes/{compte_id}/leguer-superadmin',
                                   json_body=True)
    # Le backend a aussi ferme les sessions de l'ancien superadmin.
    if status == 200 and (reponse.get_json(silent=True) or {}).get('session_fermee'):
        _session_fermee_par_changement_de_role(
            "Rôle superadmin transmis. Changer de rôle ferme vos sessions sur tous "
            "vos appareils : reconnectez-vous avec Discord, vous êtes désormais "
            "chef_admin.")
    return reponse, status


@app.route('/admin/comptes/<int:compte_id>', methods=['DELETE'])
def proxy_supprimer_compte(compte_id):
    # Le corps porte la confirmation (handle Discord retape).
    return _proxy_admin('DELETE', f'/admin/comptes/{compte_id}', json_body=True)


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
# nginx ne joint que le frontend : ce relais transmet le jeton du bot tel quel.

BOT_TIMEOUT = 10


@app.route('/api/bot/<path:chemin>', methods=['GET', 'POST'])
@csrf.exempt
def proxy_bot(chemin):
    """Relais vers l'API de service du backend (exempte de CSRF : jeton Bearer,
    pas de cookie)."""
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
    # Chemin distinct de la page /admin/matchmaking.
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


def _suite_sure(suite):
    """Chemin local ou revenir apres l'acceptation, sinon l'accueil (evite une
    redirection ouverte)."""
    if not suite or not suite.startswith('/') or suite.startswith('//') \
            or '\\' in suite or suite.startswith('/consentement'):
        return url_for('index')
    return suite


@app.route('/consentement', methods=['GET', 'POST'])
def consentement():
    """Page d'acceptation de la politique : accepter, telecharger ses donnees
    ou se deconnecter."""
    suite = _suite_sure(request.values.get('suite'))
    headers = player_headers()
    compte = session.get('compte')
    if headers is None or not isinstance(compte, dict):
        return redirect(url_for('index'))
    if not compte.get('cgu_a_accepter'):
        return redirect(suite)

    if request.method == 'POST':
        data, status = backend_request('POST', '/me/cgu', data={}, headers=headers)
        if status == 200:
            compte['cgu_a_accepter'] = False
            session.modified = True
            return redirect(suite)
        if status in (401, 403):
            session.pop('player_token', None)
            session.pop('compte', None)
            flash('Votre session a expiré. Reconnectez-vous.', 'warning')
            return redirect(url_for('index'))
        flash("L'enregistrement a échoué. Réessayez dans un instant.", 'danger')

    return render_template('consentement.html', suite=suite)


@app.route('/mon-compte/promotion')
def ma_promotion():
    """Ce que le titulaire doit accepter : proposition de role ou consentement."""
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    data, status = backend_request('GET', '/me/promotion', headers=headers)
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


def _session_fermee_par_changement_de_role(message):
    """Purge la session du titulaire dont le role vient de changer (le backend
    a ferme ses sessions) et prepare le message affiche apres reconnexion."""
    session.pop('player_token', None)
    session.pop('compte', None)
    flash(message, 'info')


@app.route('/mon-compte/promotion', methods=['POST'])
def repondre_promotion():
    """Accepte ou refuse le role propose (une acceptation ferme les sessions)."""
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401

    corps = request.get_json(silent=True) or {}
    data, status = backend_request('POST', '/me/promotion', data={
        'accepte': corps.get('accepte') is True,
        'cgu_admin_version': corps.get('cgu_admin_version'),
    }, headers=headers)

    if status == 200 and isinstance(data, dict) and data.get('session_fermee'):
        _session_fermee_par_changement_de_role(
            "Rôle accepté. Changer de rôle ferme vos sessions sur tous vos "
            "appareils : reconnectez-vous avec Discord pour ouvrir votre session "
            "d'administrateur.")
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


@app.route('/mon-compte/cgu-admin', methods=['POST'])
def accepter_cgu_admin():
    """Régularisation d'un admin déjà en poste. Ne change aucun rôle."""
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    data, status = backend_request('POST', '/me/cgu-admin', data={
        'version': (request.get_json(silent=True) or {}).get('version'),
    }, headers=headers)
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


@app.route('/mon-compte/sessions')
def mes_sessions():
    """Liste les appareils connectes du titulaire."""
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    data, status = backend_request('GET', '/auth/mes-sessions', headers=headers)
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


@app.route('/mon-compte/sessions/fermer', methods=['POST'])
def fermer_mes_sessions():
    """Ferme les autres sessions du titulaire (POST, protege par CSRF)."""
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401

    inclure = (request.get_json(silent=True) or {}).get('inclure_courante') is True
    data, status = backend_request(
        'DELETE', '/auth/mes-sessions',
        data={'inclure_courante': inclure}, headers=headers,
    )
    # La session backend a ete fermee.
    if status == 200 and isinstance(data, dict) and data.get('session_fermee'):
        session.pop('player_token', None)
        session.pop('compte', None)
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


@app.route('/mon-compte/export')
def exporter_mes_donnees():
    """Telecharge l'export en JSON, en piece jointe."""
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


@app.route('/admin/joueurs/<int:joueur_id>/anonymiser', methods=['POST'])
def proxy_anonymiser_joueur(joueur_id):
    # Alternative a la suppression d'une fiche ayant des matchs.
    return _proxy_admin('POST', f'/admin/joueurs/{joueur_id}/anonymiser', json_body=True)


@app.route('/admin/purge-rgpd', methods=['POST'])
def proxy_purge_rgpd():
    return _proxy_admin('POST', '/admin/purge-rgpd', json_body=True)


@app.route('/admin/tournois', methods=['GET', 'POST'])
def admin_tournois():
    if not _est_admin():
        flash('Accès réservé aux administrateurs', 'warning')
        return redirect(url_for('index'))

    # Permission propre a l'ajout de tournoi.
    if 'gestion_tournois' not in _permissions_session():
        flash("Vous n'avez pas accès à l'enregistrement des tournois.", 'warning')
        return redirect(url_for('index'))

    headers = admin_headers()
    if _acces_admin_revoque():
        return _session_admin_expiree()

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
                return redirect(url_for('admin_tournois'))
            i += 1
            
        if len(joueurs_data) < 2:
            flash("Il faut au moins 2 joueurs.", "warning")
            return redirect(url_for('admin_tournois'))

        headers = admin_headers()
        payload = {"date": date_tournoi, "joueurs": joueurs_data}
        _, status = backend_request('POST', '/add-tournament', data=payload, headers=headers)
        
        if status == 201:
            flash('Tournoi ajouté avec succès !', 'success')
            return redirect(url_for('confirmation'))
        elif status == 403:
            return _session_admin_expiree()
        else:
            flash('Erreur lors de l\'ajout du tournoi.', 'danger')

    data, status = backend_request('GET', '/joueurs/noms')
    joueurs = data if status == 200 else []

    # Liste des tournois rendue cote serveur (/stats/tournois sert du HTML).
    tournois_data, tournois_status = backend_request('GET', '/stats/tournois')
    tournois = tournois_data if tournois_status == 200 else []

    return render_template("add_tournament.html", joueurs=joueurs, tournois=tournois)

@app.route('/admin/matchmaking', methods=['GET'])
def matchmaking():
    # Page publique : equipes calculees a partir de la liste publique des joueurs.
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


@app.route('/admin/joueurs-fiches')
def admin_joueurs_fiches():
    if not _est_admin():
        flash('Accès interdit.', 'danger')
        return redirect(url_for('index'))

    # gestion_joueurs donne la lecture ; chaque action a sa sous-permission.
    if 'gestion_joueurs' not in _permissions_session():
        flash("Vous n'avez pas accès aux fiches joueurs.", 'warning')
        return redirect(url_for('index'))

    if _acces_admin_revoque():
        return _session_admin_expiree()
    return render_template('gestion_joueurs.html')


@app.route('/admin/reglages')
def admin_reglages():
    """Reglage TS : configuration globale et reset du sigma (gestion_config)."""
    if not _est_admin():
        flash('Accès interdit.', 'danger')
        return redirect(url_for('index'))

    if 'gestion_config' not in _permissions_session():
        flash("Vous n'avez pas accès aux réglages du classement.", 'warning')
        return redirect(url_for('index'))

    if _acces_admin_revoque():
        return _session_admin_expiree()
    return render_template('admin_reglages.html')

@app.route('/admin/saisons-gestion')
def admin_saisons_page():
    if not _est_admin():
        flash('Accès interdit.', 'danger')
        return redirect(url_for('index'))
    if _acces_admin_revoque():
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

@app.route('/admin/config/tier-distribution', methods=['GET'])

def proxy_tier_distribution():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    headers = admin_headers()
    data, status = backend_request('GET', '/admin/config/tier-distribution', headers=headers)
    return jsonify(data), status

@app.route('/admin/tiers', methods=['GET', 'POST'])

def proxy_tiers():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    return _proxy_admin(request.method, '/admin/tiers', json_body=(request.method == 'POST'))

@app.route('/admin/tiers/unranked', methods=['GET', 'PUT'])

def proxy_tier_u():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    if request.method == 'GET':
        # Lecture publique.
        data, status = backend_request('GET', '/tiers/unranked')
        return jsonify(data if data is not None else {'error': 'Service indisponible'}), status
    return _proxy_admin('PUT', '/admin/tiers/unranked', json_body=True)

@app.route('/admin/tiers/reorder', methods=['PUT'])

def proxy_tiers_reorder():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    return _proxy_admin('PUT', '/admin/tiers/reorder', json_body=True)

@app.route('/admin/tiers/reset', methods=['POST'])

def proxy_tiers_reset():
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    return _proxy_admin('POST', '/admin/tiers/reset', json_body=True)

@app.route('/admin/tiers/<int:tier_id>', methods=['PUT', 'DELETE'])

def proxy_tier_detail(tier_id):
    if not _est_admin():
        return jsonify({'error': 'Non autorisé'}), 403
    return _proxy_admin(request.method, f'/admin/tiers/{tier_id}', json_body=(request.method == 'PUT'))

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
        return redirect(url_for('index'))
    
    if _acces_admin_revoque():
        return _session_admin_expiree()

    return render_template('admin_ligues.html')


# Tout est servi par le site (librairies locales, widget Discord relaye).
# 'unsafe-inline' reste necessaire pour les onclick et <script> des gabarits.
# connect-src 'self' couvre le WebSocket de la banniere (/ws/race).
CSP_COMPLETE = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
])


@app.after_request
def add_header(response):
    if not request.path.startswith('/avatar/'):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = CSP_COMPLETE
    return response

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
