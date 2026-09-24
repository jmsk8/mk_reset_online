import os
import sys
import logging
import secrets
import requests
import time
from urllib.parse import urlencode, urlparse
import json
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

# 30 jours : la session joueur survit à la fermeture du navigateur. La durée
# réelle est celle que le backend a fixée à la connexion selon le rôle (30 jours
# pour un joueur, 12 h pour un admin) ; ce cookie ne fait que ne pas expirer
# avant elle.
app.permanent_session_lifetime = timedelta(days=30)

app.config['SESSION_COOKIE_HTTPONLY'] = True
# NE PAS passer à 'Strict' : le retour de Discord est une navigation cross-site.
# En Strict le cookie ne partirait pas, le state serait introuvable, et la
# connexion échouerait sans message exploitable.
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
# Le flag Secure suit le TLS_MODE réellement servi par nginx : en http local, il
# bloquerait toute connexion admin.
app.config['SESSION_COOKIE_SECURE'] = (os.environ.get('TLS_MODE', 'http') == 'https')
# flask-wtf a son propre TTL (3600 s), indépendant de la session : une page
# laissée ouverte une heure voyait son enregistrement rejeté. À None, il suit
# la session.
app.config['WTF_CSRF_TIME_LIMIT'] = None

csrf = CSRFProtect(app)

APP_VERSION = "1.4.3"

@app.context_processor
def inject_version():
    return dict(app_version=APP_VERSION)


def _sonde_session(endpoint, headers, sur_reponse=None):
    """Interroge une sonde de session. Renvoie True si le backend la refuse.

    Ne purge QUE sur un refus explicite (401/403) : un 5xx ou un timeout dit que
    le backend a un hoquet, pas que la session est invalide (R-28). Confondre les
    deux déconnecterait tout le monde à chaque redémarrage du backend.

    `sur_reponse` reçoit le corps JSON d'une réponse 200. Sert à récupérer rôle
    et permissions au passage : cet appel a lieu à chaque requête de toute
    façon, et le backend les a déjà lus pour authentifier. En faire un second
    appel coûterait un aller-retour réseau par page, sur 2 workers gunicorn.
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
            # Un corps illisible ne doit jamais casser la requête en cours :
            # cette fonction tourne dans un before_request, sur toutes les pages.
            logger.warning("Réponse de sonde illisible (%s)", e)
    return False


def _est_navigation(chemin):
    """Vrai si ce chemin sert une PAGE, et non une donnée pour une page déjà là.

    Sert à ne sonder la session qu'une fois par page ouverte, au lieu d'une fois
    par requête. Ouvrir les Fiches joueurs, c'est un document puis trois appels
    JSON : sonder les quatre revalidait quatre fois la même session, à quelques
    millisecondes d'intervalle, pour le même verdict.

    La distinction se lit sur l'en-tête `Accept`, que le navigateur pose seul :
    une navigation demande du HTML, un `fetch()` demande du JSON. Un `Accept`
    absent ou exotique est traité comme une navigation -- se tromper dans ce sens
    coûte une sonde de trop, jamais une session laissée valide à tort.

    Ce n'est PAS une frontière de privilège, et ça n'a pas à l'être : le proxy
    transmet le jeton au backend, qui relit rôle et permissions en base à chaque
    requête protégée. Un appel JSON non sondé sur une session morte reçoit donc
    un 401 du backend, relayé tel quel -- exactement ce que la sonde aurait fait.
    """
    if chemin.startswith('/static'):
        return False
    return 'application/json' not in request.headers.get('Accept', '')


@app.before_request
def check_session_validity():
    """Revalide la session auprès du backend à l'ouverture de chaque page.

    La session Discord était la grande absente : rien ne la revalidait jamais, et
    `_est_admin()` lisant une copie figée en cookie, un jeton expiré laissait
    l'utilisateur affiché comme connecté, onglet admin compris, jusqu'à ce qu'il
    visite /mon-compte. Les pages admin s'ouvraient alors sur une erreur au
    chargement des données plutôt que sur une reconnexion.

    UNE sonde par page. Sonder à chaque requête -- appels JSON compris --
    faisait payer 9 allers-retours backend (mesurés) pour ouvrir une page qui
    n'en vaut que 4, sur 2 workers gunicorn qui bloquent pendant l'attente. D'où
    les 503 et les « Erreur Backend » intermittents du 2026-09-17
    (docs/audit-503-zone-admin.md).

    Depuis la suppression du mot de passe admin (2026-09-23), il n'y a plus
    qu'une voie à sonder. Du temps des deux, la règle était déjà : ne sonder que
    celle qu'`admin_headers()` allait réellement employer.
    """
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
            # Sonde concluante : les vues admin n'ont plus à revérifier.
            g.session_revalidee = True
            return _exiger_consentement()


# Pages ouvertes à une session qui n'a pas encore accepté la politique (A-07) :
# celles qu'il faut pouvoir lire avant d'accepter, et les issues -- accepter,
# télécharger ses données, se déconnecter. Pendant de la liste blanche du
# backend (`player_required_sans_cgu`), qui reste la vraie frontière.
_PAGES_SANS_CONSENTEMENT = frozenset({
    'consentement', 'confidentialite', 'mentions_legales', 'player_logout',
    'exporter_mes_donnees', 'discord_login', 'discord_callback', 'static',
})


def _exiger_consentement():
    """Renvoie vers la page d'acceptation si la politique en vigueur manque.

    Le backend refuse déjà tout le reste (428) : sans cette redirection, la
    personne verrait des pages vides ou des « Erreur Backend » sans comprendre
    pourquoi. Ne vise que les pages HTML : une image ou un appel JSON n'a rien
    à faire d'une redirection vers un formulaire.
    """
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

    À appeler en tête de chaque vue admin, avant le rendu. Sans cette
    revalidation, la page s'ouvrait sur la foi du cookie puis son JS se heurtait
    à un 401 au premier chargement de données : l'utilisateur voyait
    « Chargement impossible. » au lieu d'être invité à se reconnecter.

    Ne refait PAS l'appel que le before_request vient de faire sur cette même
    requête HTTP. Les six vues admin le rejouaient à l'identique, quelques
    millisecondes après, pour le même verdict -- un aller-retour backend par
    page, payé pour rien. `g` est remis à zéro à chaque requête : la mémoïsation
    ne peut pas survivre à la requête qui l'a posée, et ne masque donc jamais une
    révocation intervenue depuis.
    """
    if getattr(g, 'session_revalidee', False):
        return False
    _, status = backend_request('GET', '/admin/check-token', headers=admin_headers())
    return status in (401, 403)

# `inject_saisons` a été retiré le 2026-09-17. Ce context processor appelait
# /saisons à CHAQUE rendu de template -- un aller-retour backend synchrone par
# page, sur 2 workers gunicorn -- pour alimenter un `saisons_menu` qu'aucun
# gabarit ne lisait (vérifié sur tout le dépôt). Le menu des saisons est servi
# par les vues qui en ont besoin, pas par une variable globale.
# Si un menu global redevient nécessaire, le remettre AVEC un cache TTL : c'est
# une donnée qui change quelques fois par an, pas à chaque affichage.


def backend_request(method, endpoint, data=None, params=None, headers=None, timeout=5):
    """Appel JSON au backend.

    `timeout` est paramétrable pour l'échange OAuth : 5 s couperaient alors que le
    compte vient d'être créé et l'invitation consommée.
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
            # `json=data` et non rien : un DELETE peut porter un corps, et
            # l'omettre le perdait en silence -- le paramètre partait, la route
            # backend appliquait son défaut, et rien ne le signalait.
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
# Authentification admin : deux voies pendant la bascule
# ---------------------------------------------------------------------------

def _session_admin_expiree():
    """Sortie commune quand le backend refuse la session sur une page admin.

    Renvoie vers l'accueil, et vers lui seul : il n'existe plus de formulaire de
    connexion admin depuis la suppression du mot de passe (2026-09-23). Avant
    elle, cette fonction y renvoyait encore, alors que s'y reconnecter ne
    rouvrait déjà plus rien -- symptôme resté longtemps incompréhensible.
    """
    session.pop('player_token', None)
    session.pop('compte', None)
    flash('Votre session a expiré. Reconnectez-vous avec Discord.', 'warning')
    return redirect(url_for('index'))


# Rôles qui ouvrent les pages d'administration. UNE seule liste : la même
# valeur était écrite en dur dans _est_admin et admin_headers, et n'en corriger
# qu'une donne le symptôme le plus déroutant qui soit -- la page s'ouvre, mais
# aucune requête n'est authentifiée, donc elle reste vide sans message d'erreur.
ROLES_ADMIN = ('admin', 'chef_admin', 'superadmin')

# Copie du catalogue de backEnd/constants.py -- le frontend est un service
# séparé, il ne peut pas l'importer. Même duplication assumée que CGU_VERSION,
# et même exigence : les deux listes doivent rester alignées (test_revue).
PERMISSIONS_CATALOGUE = frozenset({
    'gestion_joueurs', 'joueurs_creation', 'joueurs_nom', 'joueurs_couleur',
    'edition_mu_sigma', 'joueurs_statut', 'joueurs_irreversible',
    'gestion_tournois', 'gestion_ligues',
    'gestion_saisons', 'gestion_liaisons', 'gestion_comptes',
    'gestion_invitations', 'gestion_config', 'gestion_matchmaking',
})

# Copie de backEnd/constants.SOUS_PERMISSIONS (enfant -> parent), même
# duplication assumée que le catalogue lui-même. Sert à l'affichage en retrait
# et au décochage en cascade ; l'autorité reste le backend, qui exige les deux.
SOUS_PERMISSIONS = {
    'joueurs_creation': 'gestion_joueurs',
    'joueurs_nom': 'gestion_joueurs',
    'joueurs_couleur': 'gestion_joueurs',
    'edition_mu_sigma': 'gestion_joueurs',
    'joueurs_statut': 'gestion_joueurs',
    'joueurs_irreversible': 'gestion_joueurs',
}


def _role_session():
    """Rôle réel de la session, '' si absent. Copie potentiellement périmée."""
    return (session.get('compte') or {}).get('role') or ''


def _permissions_session():
    """Permissions de la session, comme un set. Vide plutôt que None.

    Sert UNIQUEMENT à décider ce que l'interface montre. Le backend relit rôle
    et permissions en base à chaque requête protégée : une copie périmée fait
    voir un bouton de trop, jamais obtenir un droit de trop (plan B.0).

    Une session ouverte avant ce chantier n'a pas la clé. Le repli ne vaut que
    pour chef_admin et superadmin, dont le socle EST le catalogue quoi qu'il
    arrive : leur accorder la liste complète ne suppose rien. Un admin, lui,
    repart de zéro jusqu'à sa reconnexion -- montrer un menu complet à qui n'a
    aucune permission ne ferait que produire des 403 au premier clic.
    """
    compte = session.get('compte') or {}
    permissions = compte.get('permissions')
    if permissions is None:
        socle_complet = compte.get('role') in ('chef_admin', 'superadmin')
        return set(PERMISSIONS_CATALOGUE) if socle_complet else set()
    return set(permissions)


def _est_admin():
    """Vrai si la session ouvre les pages d'administration.

    Porte d'INTERFACE, pas frontière de privilège : le rôle vient de la copie mise
    en session à la connexion et peut être périmé. L'autorité reste le backend, qui
    le relit en base à chaque requête protégée. Le rafraîchir ici coûterait un appel
    réseau par page (R-28). Un admin rétrogradé voit donc la page, sans les données.

    Ne dit RIEN des droits réels depuis la hiérarchie à 4 rôles : un admin sans
    aucune permission ouvre la page et n'y verra que ce que le backend lui sert.
    """
    return _role_session() in ROLES_ADMIN


def admin_headers():
    """En-tête d'auth admin, construit depuis la session serveur.

    Une seule voie depuis le 2026-09-23 : la session Discord, si elle porte le
    rôle. `None` sinon -- le backend répondra 401, et c'est le comportement
    voulu : un en-tête absent vaut mieux qu'un en-tête qui n'ouvre rien.
    """
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


# Etape 1 du rattachement a une session : liste les tournois proposables et
# marque ceux qui partagent un joueur. Lecture seule cote backend.
# Conception : docs/plan-sessions-tournois.md, decision 10
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
        # Pas encore de bannière d'automne : sans style dédié, `autumn`
        # retombait sur le fond d'hiver par défaut. L'été tient l'intérim.
        return "summer"
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
        # `recap.html` n'a jamais affiche la variable `error` qu'on lui passait :
        # une saison introuvable rendait une page vide.
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

    # Liste ordonnee par rang decroissant (nom, couleur, seuil) -- plus un
    # dict fige {"S":.., "A":..} depuis les tiers dynamiques (Partie B).
    tiers = []
    tiers_data, tiers_status = backend_request('GET', '/tier-seuils')
    if tiers_status == 200 and isinstance(tiers_data, list):
        tiers = tiers_data
    # Lookup nom -> couleur pour le badge de tier de chaque joueur (evite de
    # coder S/A/B/C en dur dans le gabarit, cf docs/tableau-seuils-tiers-plan.md).
    tiers_couleurs = {t.get('nom'): t.get('couleur') for t in tiers if t.get('nom')}

    saison = None
    if vue == 'saison':
        s_params = {}
        if saison_ligue_id:
            s_params['ligue_id'] = saison_ligue_id
        s_data, s_status = backend_request('GET', '/classement/saison', params=s_params)
        if s_status == 200 and isinstance(s_data, dict):
            saison = s_data

    return render_template("classement.html", joueurs=joueurs, tier_actif=tier, ligue_active=ligue_id, ligues=ligues, tiers=tiers, tiers_couleurs=tiers_couleurs, distribution_data=distribution_data, vue=vue, saison=saison)

def _rendre_fiche_joueur(nom, data):
    # Couleur du tier portee par les donnees (tiers dynamiques, Partie B) :
    # plus de branches S/A/B/C figees dans stats_joueur.html.
    tiers_couleurs = {}
    tiers_data, tiers_status = backend_request('GET', '/tier-seuils')
    if tiers_status == 200 and isinstance(tiers_data, list):
        tiers_couleurs = {t.get('nom'): t.get('couleur') for t in tiers_data if t.get('nom')}

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
    )


@app.route('/joueur/<int:joueur_id>')
def joueur_detail(joueur_id):
    """URL canonique d'une fiche joueur.

    Sur l'identifiant et non sur le nom : le nom bouge, et emporte avec lui tous
    les liens déjà partagés.
    """
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
    """Ancienne URL, conservée : des liens circulent déjà sous cette forme.

    301 vers l'URL canonique, pour que ce qui est repartagé depuis ici soit stable.
    """
    resolu, status = backend_request('GET', f'/joueurs/resolve/{nom}')
    if status == 200 and isinstance(resolu, dict) and resolu.get('id'):
        return redirect(url_for('joueur_detail', joueur_id=resolu['id']), code=301)

    # Backend indisponible : on sert la page à l'ancienne. Une 301 est mise en cache
    # par le navigateur, l'émettre sur une résolution incertaine la graverait.
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

    # Couleur du tier portee par les donnees (tiers dynamiques, Partie B) --
    # plus de classe tier-{{ tier|lower }} figee dans le gabarit.
    tiers_couleurs = {}
    tiers_data, tiers_status = backend_request('GET', '/tier-seuils')
    if tiers_status == 200 and isinstance(tiers_data, list):
        tiers_couleurs = {t.get('nom'): t.get('couleur') for t in tiers_data if t.get('nom')}

    return render_template("stats_joueurs.html", joueurs=joueurs, distribution_tiers=dist, tiers_couleurs=tiers_couleurs)

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
    # Une notification « nouveau tournoi » survit a l'annulation du tournoi :
    # son texte est fige a l'emission. La page doit donc le dire, plutot que
    # de rediriger vers l'accueil avec un bandeau qu'on ne lit pas.
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
# Toujours l'environnement, jamais url_for(_external=True) : derrière nginx puis
# gunicorn sans ProxyFix, Flask produirait du http://.
#
# Une ou plusieurs URI, séparées par des virgules : voir _redirect_uri().
DISCORD_REDIRECT_URI = os.environ.get('DISCORD_REDIRECT_URI', '')
DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
# L'échange déclenche deux appels réseau vers Discord côté backend.
OAUTH_EXCHANGE_TIMEOUT = 20

# Nombre de `state` OAuth gardés en attente simultanément, et leur durée de vie.
#
# Une seule case ne suffit pas : deux onglets, un double-clic, un retour arrière
# ou le préchargement du navigateur suffisent à ce que la seconde tentative
# écrase la première, qui échoue alors sans que rien d'anormal n'ait eu lieu.
# C'était le constat B-01, et la cause des « bugs étranges » à la connexion.
#
# 5 couvre largement les cas réels (on n'ouvre pas six onglets de connexion) et
# borne la session : sans borne, un robot qui appelle /login en boucle ferait
# grossir le cookie jusqu'au refus du navigateur.
#
# 15 minutes : au-delà, l'utilisateur a abandonné. Discord n'impose rien ici,
# c'est notre propre fenêtre — assez large pour une hésitation devant l'écran
# de consentement, assez courte pour qu'un state oublié ne traîne pas.
OAUTH_STATES_MAX = 5
OAUTH_STATE_TTL = 15 * 60


def _redirect_uris():
    return [u.strip() for u in DISCORD_REDIRECT_URI.split(',') if u.strip()]


def _redirect_uri():
    """L'URI de retour déclarée pour l'hôte consulté, à défaut la première.

    Le retour doit arriver sur l'hôte de départ : le cookie de session, qui
    porte le `state`, est lié à l'hôte. Une URI unique obligeait donc à
    naviguer sur cet hôte exact — sur le poste de dev, `127.0.0.1` ou le nom
    `.local` échouaient en « demande expirée », et un changement d'IP (DHCP)
    cassait tout. Avec plusieurs URI (localhost, nom `.local`, IP), chaque
    hôte revient sur lui-même.

    L'en-tête Host ne fait que choisir dans la liste : il n'y ajoute rien.
    """
    uris = _redirect_uris()
    if not uris:
        return ''
    # `//` pour que urlparse lise l'hôte : sans port, sans crochets IPv6, en
    # minuscules — comme `hostname` de chaque URI.
    hote = urlparse('//' + request.host).hostname
    for uri in uris:
        if urlparse(uri).hostname == hote:
            return uri
    return uris[0]


# Identité de l'éditeur, affichée dans les pages légales. Renseignée par
# l'environnement : informations personnelles, hors d'un dépôt public.
# ⚠️ Non définies, les pages légales sont incomplètes au sens de la loi.
MENTIONS = {
    'editeur': os.environ.get('SITE_EDITEUR', '[à renseigner : nom de l’éditeur]'),
    'contact': os.environ.get('SITE_CONTACT', '[à renseigner : adresse de contact]'),
    'hebergeur': os.environ.get('SITE_HEBERGEUR', '[à renseigner : hébergeur et pays]'),
    # 6 mois : arbitré le 2026-09-18, borne basse de la fourchette CNIL.
    # ⚠️ Cette valeur est ce qu'on ANNONCE. Ce qui l'impose aujourd'hui est une
    # borne de TAILLE (30 Mo par service), pas d'âge -- un site peu fréquenté
    # peut donc garder une ligne au-delà. Tant que T5 du registre RGPD n'a pas
    # sa case « imposer réellement » cochée, ne pas raccourcir ce texte : il
    # engage, et une durée annoncée qu'on ne tient pas est pire que pas de
    # durée du tout.
    'retention_logs': os.environ.get('SITE_RETENTION_LOGS', "6 mois au maximum"),
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
    """Le bouton de connexion ne s'affiche pas si Discord n'est pas configuré.

    Lu depuis l'environnement : une décision d'affichage ne vaut pas un
    aller-retour vers le backend sur chaque page.
    """
    return dict(discord_configure=bool(DISCORD_CLIENT_ID and _redirect_uris()))


def _maj_droits_session(corps):
    """Recopie rôle et permissions servis par la sonde de session.

    Appelée depuis le before_request, avec le corps de /auth/check-session. Le
    backend les a lus pour authentifier la requête : les prendre ici ne coûte
    rien de plus, et la copie en session reste fraîche à chaque page.

    C'est ce qui manquait : cette copie était figée à la CONNEXION, donc un
    droit accordé n'apparaissait qu'après déconnexion/reconnexion. La faire
    relire par un appel /auth/me séparé a marché, mais ajoutait un aller-retour
    réseau synchrone par rendu de page -- sur 2 workers gunicorn, le frontend
    saturait et nginx répondait 503 (observé le 2026-09-17).

    Le frontend n'est PAS une frontière de privilège : le backend relit rôle et
    permissions en base à chaque requête protégée. Une copie périmée fait voir
    un bouton de trop, jamais obtenir un droit de trop.

    Recopie aussi `cgu_a_accepter` (A-07) : une nouvelle version de la
    politique doit être présentée dès la page suivante, pas à la reconnexion.
    """
    compte = session.get('compte')
    if not isinstance(compte, dict) or not isinstance(corps, dict):
        return
    if 'role' not in corps and 'permissions' not in corps:
        return      # backend plus ancien que ce champ : on garde la copie
    champs = ('role', 'permissions', 'cgu_a_accepter')
    if all(compte.get(c) == corps.get(c) for c in champs):
        return      # rien de neuf : ne pas réécrire le cookie à chaque requête
    for c in champs:
        compte[c] = corps.get(c)
    session.modified = True


@app.errorhandler(404)
def page_introuvable(_e):
    """Toute URL inexistante aboutit a la meme page que les cibles disparues.

    Sert d'abord les liens de notification : une URL figee a l'emission peut
    designer une route qui n'existe plus apres un renommage, et Flask rendrait
    sinon sa page d'erreur brute, sans navbar ni retour.

    Les appels JSON gardent du JSON : la navbar et les pages d'administration
    font tourner des `fetch()` qui parsent la reponse, et leur servir du HTML
    les casserait sur une erreur bien plus difficile a lire qu'un 404.
    """
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
    """Expose la porte d'interface admin aux templates.

    Trois valeurs, pas une, depuis la hiérarchie à 4 rôles :
      - `est_admin` : la page s'ouvre-t-elle ? (inchangé)
      - `role_admin` : le rôle réel, pour les capacités qui ne sont PAS des
        permissions (reset global, jetons de bot, legs).
      - `peut(...)` : le helper de gate pour tout le reste. Un template ne doit
        jamais tester un rôle en dur pour une zone déléguable -- c'est le
        pendant côté interface de R-50.
    """
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
    """Page d'accueil d'une invitation. STRICTEMENT idempotente.

    Coller ce lien dans un salon déclenche un GET du crawler Discord : si
    l'affichage consommait l'invitation, un lien à usage unique serait brûlé.
    """
    data, status = backend_request('GET', f'/auth/invitation/{token}')
    invitation = data if status == 200 and isinstance(data, dict) else None
    if invitation is None:
        motif = data.get('code') if isinstance(data, dict) else 'indisponible'
        return render_template('invite.html', invitation=None, motif=motif), 200
    return render_template('invite.html', invitation=invitation, invite_token=token)


# ---------------------------------------------------------------------------
# States OAuth en attente
# ---------------------------------------------------------------------------
# Referme B-01. Le défaut n'était pas dans l'un ou l'autre geste -- écrire le
# state à la connexion et le consommer au retour sont tous deux corrects --
# mais dans leur combinaison sur une CASE UNIQUE :
#
#   - la seconde connexion écrasait le state de la première, qui échouait
#     alors qu'elle n'avait rien fait d'anormal ;
#   - le `pop` vidait la case MÊME EN CAS D'ÉCHEC, si bien qu'un échec en
#     provoquait un second, avec un state pourtant valide. C'est ce qui rendait
#     le symptôme incompréhensible : deux échecs, puis un succès.
#
# Les deux règles ci-dessous suffisent, et l'usage unique est préservé : un
# state retiré de la liste ne repasse jamais.

def _deposer_state(state: str) -> None:
    """Ajoute un state en attente, en purgeant les périmés et les surnuméraires."""
    limite = time.time() - OAUTH_STATE_TTL
    # Purge d'abord : sans elle, cinq tentatives abandonnées suffiraient à
    # évincer un state légitime par la borne de taille.
    en_attente = [s for s in session.get('oauth_states', [])
                  if isinstance(s, list) and len(s) == 2 and s[1] > limite]
    en_attente.append([state, time.time()])
    # Les plus ANCIENS sautent en premier : au-delà de la borne, c'est la
    # tentative la plus fraîche qui a le plus de chances d'aboutir.
    session['oauth_states'] = en_attente[-OAUTH_STATES_MAX:]


def _consommer_state(recu: str | None) -> bool:
    """Retire le state correspondant. Ne consomme RIEN si rien ne correspond.

    C'est le point qui referme B-01.2 : un échec ne doit pas emporter les
    tentatives encore valides. Comparaison en temps constant, comme avant.
    """
    if not recu:
        return False
    # En OCTETS et non en str : `compare_digest` LÈVE un TypeError sur deux
    # chaînes dont l'une n'est pas ASCII, et le state arrive d'un paramètre
    # d'URL, donc de l'extérieur. Un `?state=é` suffisait à produire un 500 sur
    # le chemin de connexion -- défaut antérieur à la correction de B-01, hérité
    # tel quel en la portant. Encoder ramène le cas à une comparaison qui
    # échoue proprement, sans rien perdre du temps constant.
    recu_b = recu.encode('utf-8', 'surrogatepass')
    limite = time.time() - OAUTH_STATE_TTL
    en_attente = [s for s in session.get('oauth_states', [])
                  if isinstance(s, list) and len(s) == 2
                  and isinstance(s[0], str) and isinstance(s[1], (int, float))]

    for i, (state, pose_a) in enumerate(en_attente):
        if pose_a > limite and secrets.compare_digest(
                state.encode('utf-8', 'surrogatepass'), recu_b):
            # Retiré : un rejeu du même state ne repassera pas.
            del en_attente[i]
            session['oauth_states'] = en_attente
            return True

    # Aucune correspondance : on garde les states en attente intacts, mais on
    # profite du passage pour évacuer les périmés.
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
        'redirect_uri': _redirect_uri(),
        'response_type': 'code',
        # identify seul : ni email, ni guilds.
        'scope': 'identify',
        'state': state,
        # L'écran d'autorisation s'affiche à CHAQUE connexion, même pour qui a
        # déjà autorisé le site : il dit avec quel compte Discord on entre
        # (« Ce n'est pas vous ? »), ce qui compte avec plusieurs comptes ou
        # sur un ordinateur partagé. Décidé le 2026-09-24, au prix d'un clic
        # de plus par connexion.
        #
        # Jusque-là, `prompt=none` sautait l'écran pour qui avait déjà
        # autorisé : Discord renvoyait aussitôt vers le site, sans laisser lire
        # sa page. (Chez Discord, `none` retombe sur l'écran pour un premier
        # consentement au lieu d'une erreur comme en OIDC : voir
        # `discord-api-docs#6751`.) `consent` est la valeur par défaut de
        # Discord ; l'écrire ne dépend pas de ce défaut.
        'prompt': 'consent',
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
    if not _consommer_state(state):
        # Deux causes très différentes, autrefois confondues sous le même
        # message accusateur. Les distinguer n'est pas cosmétique : le premier
        # cas est fréquent et bénin (lien rouvert, retour arrière, connexion
        # déjà terminée ailleurs), le second est le seul qui mérite un regard.
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
            # Même choix qu'à l'aller : Discord a renvoyé sur cet hôte-là.
            'redirect_uri': _redirect_uri(),
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
    if compte.get('cgu_a_accepter'):
        # Compte antérieur à la politique, amorçage du superadmin, ou nouvelle
        # version publiée depuis : rien d'autre ne s'ouvrira avant l'accord.
        return redirect(url_for('consentement'))
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

    Le mettre dans le DOM recréerait la surface d'exfiltration qu'on vient de
    retirer aux pages admin.
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
        # Rafraîchies en même temps que le rôle : sans ça, un droit accordé
        # aujourd'hui n'apparaîtrait dans les menus qu'à la prochaine connexion.
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


# Plus large que les 5 s des appels JSON : le backend peut avoir a telecharger
# l'image chez Discord avant de repondre.
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


@app.route('/me/notifications', methods=['GET'])
def proxy_mes_notifications():
    """Appelée par la navbar à chaque page. Renvoie un compteur à zéro plutôt
    qu'une erreur : la navbar reste muette au lieu de casser."""
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
    """Pastilles de la navbar admin. Même parti pris : jamais d'erreur."""
    headers = admin_headers()
    if headers is None:
        return jsonify({'total': 0, 'liaisons_en_attente': 0})
    data, status = backend_request('GET', '/admin/notifications', headers=headers)
    if status != 200:
        return jsonify({'total': 0, 'liaisons_en_attente': 0})
    return jsonify(data)


@app.route('/auth/demande-creation', methods=['POST'])
def proxy_demande_creation():
    """Demande de création d'une fiche. Le nom vient du pseudo Discord, lu côté
    backend : le navigateur ne le choisit pas."""
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
# `GET/PUT /me/profil` existe encore côté backend, sans proxy ici — donc hors
# d'atteinte, nginx ne servant le backend qu'à travers ce frontend.


@app.route('/admin/comptes')
def admin_comptes():
    if not _est_admin():
        flash('Accès réservé aux administrateurs', 'warning')
        return redirect(url_for('index'))

    # La page héberge trois domaines, chacun sous sa permission : elle s'ouvre
    # dès qu'on en a un, et chaque onglet est gaté séparément dans le gabarit.
    # Sans ce garde, un admin qui n'en a aucun ouvrait une page vide en tapant
    # l'URL -- la navbar, elle, masque déjà l'entrée dans ce cas.
    if not ({'gestion_comptes', 'gestion_liaisons', 'gestion_invitations'}
            & _permissions_session()):
        flash("Vous n'avez pas accès à la gestion des comptes.", 'warning')
        return redirect(url_for('index'))

    if _acces_admin_revoque():
        return _session_admin_expiree()

    compte = session.get('compte') or {}
    # `role_admin` et `peut()` viennent du context processor ; `mon_compte_id`
    # permet au JS de ne pas proposer à quelqu'un d'agir sur sa propre ligne
    # (auto-modification et auto-legs sont refusés côté backend de toute façon).
    return render_template(
        'admin_comptes.html',
        est_superadmin=(compte.get('role') == 'superadmin'),
        mon_compte_id=compte.get('id'),
        # Le panneau de permissions affiche les sous-permissions en retrait sous
        # leur parent, et les décoche avec lui.
        sous_permissions=SOUS_PERMISSIONS,
    )


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


# La promotion au rang d'admin passe désormais par une proposition que la
# personne accepte elle-même (phase 1bis du journal d'audit). Ces deux routes
# sont côté PROPOSANT ; l'acceptation vit sous /mon-compte, avec les autres
# gestes du titulaire.
@app.route('/admin/comptes/<int:compte_id>/promotion', methods=['POST'])
def proxy_proposer_promotion(compte_id):
    return _proxy_admin('POST', f'/admin/comptes/{compte_id}/promotion', json_body=True)


@app.route('/admin/comptes/<int:compte_id>/promotion', methods=['DELETE'])
def proxy_annuler_promotion(compte_id):
    return _proxy_admin('DELETE', f'/admin/comptes/{compte_id}/promotion')


# Journal d'audit (phase 3). Trois proxys pour trois vues du meme filtre :
# le volet d'une ligne, l'onglet complet, et l'export.
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
    """Relaie le CSV EN STREAMING, sans le matérialiser.

    Contrairement aux autres proxys, celui-ci ne passe pas par
    `backend_request` : cette fonction lit `response.json()`, ce qui chargerait
    tout le fichier en mémoire côté frontend — exactement ce que le streaming
    backend sert à éviter. On relaie le flux tel quel.
    """
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
    # La permission n'est pas validée ici : le backend la confronte au
    # catalogue et au plafond de l'acteur. Filtrer aussi de ce côté donnerait
    # deux listes à garder synchronisées, dont une sans autorité.
    return _proxy_admin(request.method,
                        f'/admin/comptes/{compte_id}/permissions/{permission}')


@app.route('/admin/comptes/<int:compte_id>/leguer-superadmin', methods=['POST'])
def proxy_leguer_superadmin(compte_id):
    # Le corps porte la confirmation forte (pseudo Discord retapé) : elle doit
    # traverser intacte, c'est elle qui distingue le geste voulu du clic.
    reponse, status = _proxy_admin('POST', f'/admin/comptes/{compte_id}/leguer-superadmin',
                                   json_body=True)
    # L'ancien superadmin change de rôle lui aussi : le backend a fermé ses
    # sessions, celle-ci comprise (A-02).
    if status == 200 and (reponse.get_json(silent=True) or {}).get('session_fermee'):
        _session_fermee_par_changement_de_role(
            "Rôle superadmin transmis. Changer de rôle ferme vos sessions sur tous "
            "vos appareils : reconnectez-vous avec Discord, vous êtes désormais "
            "chef_admin.")
    return reponse, status


@app.route('/admin/comptes/<int:compte_id>', methods=['DELETE'])
def proxy_supprimer_compte(compte_id):
    # Même contrat que le legs : la confirmation forte (pseudo Discord retapé)
    # voyage dans le corps, et doit traverser intacte.
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


def _suite_sure(suite):
    """Chemin local où revenir après l'acceptation, sinon l'accueil.

    `suite` vient de l'URL : sans ce filtre, un lien piégé ferait rebondir
    vers un autre site juste après un clic de confiance (redirection ouverte).
    """
    if not suite or not suite.startswith('/') or suite.startswith('//') \
            or '\\' in suite or suite.startswith('/consentement'):
        return url_for('index')
    return suite


@app.route('/consentement', methods=['GET', 'POST'])
def consentement():
    """Page d'acceptation de la politique, imposée depuis le 2026-09-24 (A-07).

    Jusque-là, un bandeau sur /mon-compte proposait d'accepter et rien n'était
    bloqué. Désormais le backend refuse toute route (428) à une session dont le
    consentement manque ou porte une version périmée ; cette page est l'endroit
    où l'on atterrit. Trois issues : accepter, télécharger ses données (le droit
    d'accès ne dépend pas de l'accord), ou se déconnecter.
    """
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
    """Ce que le titulaire doit accepter : proposition de rôle, ou consentement.

    Chargée en fetch depuis /mon-compte, comme la liste des appareils : la page
    fait déjà plusieurs appels, et ce bloc n'existe que pour une minorité de
    comptes.
    """
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    data, status = backend_request('GET', '/me/promotion', headers=headers)
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


def _session_fermee_par_changement_de_role(message):
    """Purge la session Discord du titulaire dont le rôle vient de changer.

    Le backend ferme toutes les sessions d'un compte qui change de rôle, la
    courante comprise (A-01/A-02) : la durée d'une session est figée à sa
    création, sur le rôle du moment. Garder le jeton pointerait vers une session
    détruite, et le navigateur le découvrirait par une erreur.

    Le message est déposé AVANT la reconnexion Discord que la page relance : il
    s'affiche au retour, à côté de « Connecté en tant que … ». Si la reconnexion
    échoue, il reste juste — il ne promet pas qu'elle a eu lieu.
    """
    session.pop('player_token', None)
    session.pop('compte', None)
    flash(message, 'info')


@app.route('/mon-compte/promotion', methods=['POST'])
def repondre_promotion():
    """Accepte ou refuse le rôle proposé.

    En cas d'acceptation, le backend ferme toutes les sessions du compte, celle
    de cette requête comprise : c'est une session de joueur (30 jours), et un
    admin n'en a que 12 heures. La page relance alors la connexion Discord.
    """
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
    """Liste les appareils connectés du titulaire.

    Chargée en fetch depuis /mon-compte plutôt qu'au rendu : la page fait déjà
    deux appels backend, un troisième synchrone ralentirait une page que tout
    le monde visite pour un bloc que peu regardent.
    """
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401
    data, status = backend_request('GET', '/auth/mes-sessions', headers=headers)
    return jsonify(data if data is not None else {'error': 'Service indisponible'}), status


@app.route('/mon-compte/sessions/fermer', methods=['POST'])
def fermer_mes_sessions():
    """Ferme les autres sessions du titulaire.

    En POST et non DELETE : CSRFProtect ne couvre que les méthodes mutantes
    qu'il connaît, et le fetch envoie déjà X-CSRFToken comme les autres actions
    de la page. Le backend, lui, expose bien un DELETE.
    """
    headers = player_headers()
    if headers is None:
        return jsonify({'error': 'Non autorisé'}), 401

    inclure = (request.get_json(silent=True) or {}).get('inclure_courante') is True
    data, status = backend_request(
        'DELETE', '/auth/mes-sessions',
        data={'inclure_courante': inclure}, headers=headers,
    )
    # La session serveur pointerait vers une session backend détruite, et le
    # navigateur découvrirait le problème par une erreur.
    if status == 200 and isinstance(data, dict) and data.get('session_fermee'):
        session.pop('player_token', None)
        session.pop('compte', None)
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


# Plus de /mon-compte/supprimer depuis le 2026-09-22 : la suppression d'un compte
# se demande par écrit et le superadmin l'exécute (proxy_supprimer_compte). Le
# bouton de /mon-compte n'appelle plus rien, il affiche la marche à suivre.


@app.route('/admin/joueurs/<int:joueur_id>/anonymiser', methods=['POST'])
def proxy_anonymiser_joueur(joueur_id):
    # Contrepartie du refus de suppression : celui-ci renvoie un 409 qui
    # oriente vers l'anonymisation, et la politique de confidentialité la
    # promet. Sans ce proxy, l'action était injoignable depuis l'interface.
    return _proxy_admin('POST', f'/admin/joueurs/{joueur_id}/anonymiser', json_body=True)


@app.route('/admin/purge-rgpd', methods=['POST'])
def proxy_purge_rgpd():
    return _proxy_admin('POST', '/admin/purge-rgpd', json_body=True)


# `/admin` (formulaire de mot de passe) et `/admin/logout` ont été supprimés le
# 2026-09-23 avec l'étape 6 de la phase 4. L'administration n'a plus qu'une
# entrée, `/auth/discord`, et qu'une sortie, la déconnexion Discord de
# `/mon-compte` -- celle-ci ferme la session côté backend, ce que l'ancien
# `/admin/logout` ne savait faire que pour le jeton par mot de passe.


@app.route('/admin/tournois', methods=['GET', 'POST'])
def admin_tournois():
    if not _est_admin():
        flash('Accès réservé aux administrateurs', 'warning')
        return redirect(url_for('index'))

    # Permission propre depuis la scission du 2026-09-13 : sans ce garde, un
    # admin qui n'a que « Fiches joueurs » ouvrirait un formulaire dont chaque
    # enregistrement répondrait 403.
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

    # Liste des tournois, rendue côté serveur : /stats/tournois sert un template
    # HTML, pas du JSON, elle n'est donc pas consommable en fetch. La charger ici
    # évite d'ajouter un proxy JSON pour une donnée déjà publique.
    tournois_data, tournois_status = backend_request('GET', '/stats/tournois')
    tournois = tournois_data if tournois_status == 200 else []

    return render_template("add_tournament.html", joueurs=joueurs, tournois=tournois)

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


@app.route('/admin/joueurs-fiches')
def admin_joueurs_fiches():
    if not _est_admin():
        flash('Accès interdit.', 'danger')
        return redirect(url_for('index'))

    # Même gate que les deux autres onglets. La navbar cachait déjà le lien
    # derrière cette permission, mais un lien caché n'est pas un accès fermé :
    # l'URL restait ouverte, et la page s'affichait pour finir sur
    # « Chargement impossible. » au premier appel de données -- le backend
    # répondant 403, correctement. Le droit n'a jamais manqué ; c'est le
    # message qui manquait.
    #
    # `gestion_joueurs` n'ouvre que la LECTURE depuis la scission du
    # 2026-09-17 : chaque geste exige sa sous-permission, revérifiée champ par
    # champ côté backend. Gater la page sur ce droit-là est donc exact -- c'est
    # celui qui autorise à regarder.
    if 'gestion_joueurs' not in _permissions_session():
        flash("Vous n'avez pas accès aux fiches joueurs.", 'warning')
        return redirect(url_for('index'))

    if _acces_admin_revoque():
        return _session_admin_expiree()
    return render_template('gestion_joueurs.html')


@app.route('/admin/reglages')
def admin_reglages():
    """Réglage TS : configuration globale et reset du sigma.

    Un seul droit depuis le 2026-09-13 : le reset global est devenu délégable
    via gestion_config (contexte 8.5-D), il ne relève plus d'une capacité de
    rôle. Le `or role_admin in (...)` d'avant n'a donc plus d'objet -- un
    chef_admin porte gestion_config par construction, son socle EST le catalogue.
    """
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


@app.after_request
def add_header(response):
    # Les avatars gardent le cache posé par _relayer_avatar.
    if not request.path.startswith('/avatar/'):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # Pas de script-src ni de style-src : les gabarits reposent sur des
    # gestionnaires inline, les interdire casserait le site.
    response.headers["Content-Security-Policy"] = (
        "img-src 'self' data:; frame-ancestors 'self'"
    )
    return response

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
