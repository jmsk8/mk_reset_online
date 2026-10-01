"""Une session Discord expiree ne doit plus rester affichee comme connectee.

Verifications sur le source (cablage frontend/backend).
"""
from harness import *
import ast
import re as _re

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FRONT = os.path.join(RACINE, '..', 'frontEnd')


def io_open(chemin):
    with open(chemin, encoding='utf-8') as f:
        return f.read()


def bloc(source, ancre, taille=1200):
    """Source de la fonction designee par `ancre` (« def nom » ou ligne de
    decorateur), decorateurs compris, ou '' si elle a disparu.

    Delimitee par `ast` pour le Python ; `taille` sert de repli pour le HTML/JS.
    """
    try:
        arbre = ast.parse(source)
    except SyntaxError:
        # Source non Python : fenetre de taille fixe.
        i = source.find(ancre)
        return '' if i < 0 else source[i:i + taille]

    lignes = source.splitlines(keepends=True)

    def texte(noeud):
        # On remonte au premier decorateur.
        debut = min([noeud.lineno] + [d.lineno for d in noeud.decorator_list]) - 1
        return ''.join(lignes[debut:noeud.end_lineno])

    cible = ancre[4:].strip() if ancre.startswith('def ') else None
    for noeud in ast.walk(arbre):
        if not isinstance(noeud, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if cible is not None:
            if noeud.name == cible:
                return texte(noeud)
        else:
            # Ancre = ligne de decorateur.
            corps = texte(noeud)
            entete = corps[:corps.find('def ')] if 'def ' in corps else corps
            if ancre in entete:
                return corps
    return ''


front = io_open(os.path.join(FRONT, 'frontend.py'))
routes_auth = io_open(os.path.join(RACINE, 'routes_auth.py'))
admin_html = io_open(os.path.join(FRONT, 'templates', 'admin_comptes.html'))


print("\n=== La sonde de session existe et ne coute rien ===")
# Appelee a chaque page : pas de lecture supplementaire.
check("le backend expose /auth/check-session",
      "'/auth/check-session'" in routes_auth)
sonde_backend = bloc(routes_auth, "'/auth/check-session'", 900)
check("elle exige une session valide", '@player_required' in sonde_backend)
check("elle ne fait aucune requete SQL",
      bool(sonde_backend) and 'get_db_connection' not in sonde_backend
      and 'cur.execute' not in sonde_backend)


print("\n=== Le frontend revalide la session a l'ouverture de chaque page ===")
avant_request = bloc(front, 'def check_session_validity')
check("before_request surveille la session Discord",
      "session.get('player_token')" in avant_request)
# L'ancienne sonde par mot de passe a disparu.
check("plus de sonde vers l'ancienne voie",
      'admin_token' not in avant_request and 'check-token' not in avant_request)
check("un refus purge le jeton joueur ET sa copie de compte",
      "pop('player_token'" in avant_request and "pop('compte'" in avant_request)

# Une sonde par page, pas par appel JSON.
check("mais pas sur les appels JSON d'une page deja ouverte",
      '_est_navigation' in avant_request)
navigation = bloc(front, 'def _est_navigation')
check("distingue navigation et fetch sur l'en-tete Accept",
      "'Accept'" in navigation and 'application/json' in navigation)
# Un Accept absent ou inconnu est traite comme une navigation.
check("et traite un Accept inconnu comme une navigation",
      'not in' in navigation)

print("\n--- mais ne purge QUE sur un refus explicite (R-28) ---")
# « Session invalide » et « backend en panne » ne doivent pas se confondre.
_i = front.find('def _sonde_session')
sonde = front[_i:front.find('\n@app.', _i)] if _i >= 0 else ''
check("seuls 401/403 declenchent la purge",
      '(401, 403)' in sonde or '[401, 403]' in sonde)
check("un timeout conserve la session",
      'return False' in sonde and 'except Exception' in sonde)


print("\n=== Aucune page admin ne se rend sur la seule foi du cookie ===")
# Chaque page admin revalide la session aupres du backend avant de rendre.
PAGES_ADMIN = [
    ("admin_comptes", "admin_comptes.html"),
    ("admin_tournois", "add_tournament.html"),
    ("admin_joueurs_fiches", "gestion_joueurs.html"),
    ("admin_reglages", "admin_reglages.html"),
    ("admin_saisons_page", "admin_saisons.html"),
    ("admin_ligues_page", "admin_ligues.html"),
]
for nom, _gabarit in PAGES_ADMIN:
    k = front.find('def %s(' % nom)
    if k < 0:
        check("%s revalide avant de rendre" % nom, False, "vue introuvable")
        continue
    # Jusqu'a la prochaine route.
    fin = front.find('@app.route', k)
    corps = front[k:fin if fin > k else k + 4000]
    # Appel direct ou via _acces_admin_revoque.
    check("%s revalide avant de rendre" % nom,
          '/admin/check-token' in corps or '_acces_admin_revoque()' in corps, nom)


print("\n--- et le helper qui porte cette revalidation fait vraiment l'appel ---")
# Et _acces_admin_revoque revalide vraiment.
revoque = bloc(front, 'def _acces_admin_revoque')
check("il interroge bien le backend",
      "'/admin/check-token'" in revoque)
check("et traite 401/403 comme un acces revoque",
      '(401, 403)' in revoque or '[401, 403]' in revoque)
# Memoisation limitee a la requete (g).
check("et memoise sur g, jamais sur la session ni un global",
      'session_revalidee' in revoque and '(g,' in revoque
      and 'session[' not in revoque)


print("\n=== Gate de permission : droit manquant != session expiree ===")
# Session expiree -> purge et retour accueil ; droit manquant -> message et
# redirection, sans deconnexion.
GATES = [
    ("admin_tournois", 'gestion_tournois'),
    ("admin_reglages", 'gestion_config'),
    ("admin_joueurs_fiches", 'gestion_joueurs'),
]
for nom, permission in GATES:
    corps = bloc(front, 'def %s' % nom)
    check("%s porte un gate de permission" % nom,
          "'%s' not in _permissions_session()" % permission in corps, nom)
    # Le gate passe avant la revalidation de session.
    i_gate = corps.find('_permissions_session()')
    i_reval = corps.find('_acces_admin_revoque()')
    check("%s teste la permission avant de revalider la session" % nom,
          i_gate >= 0 and i_reval >= 0 and i_gate < i_reval, (i_gate, i_reval))
    # Un refus de droit ne purge pas les jetons.
    avant_reval = corps[:i_reval] if i_reval > 0 else corps
    check("%s ne deconnecte PAS sur un simple manque de droit" % nom,
          '_session_admin_expiree' not in avant_reval
          and "pop('player_token'" not in avant_reval, nom)

# Le gate lit les permissions de la session, jamais un role en dur (corps
# executable seul, la docstring en parle).
reglages = bloc(front, 'def admin_reglages')
_sans_doc = _re.sub(r'(?s)\"\"\".*?\"\"\"', '', reglages)
_sans_doc = _re.sub(r'(?m)#.*$', '', _sans_doc)
check("le gate ne retombe pas sur un test de role en dur",
      'role_admin in (' not in _sans_doc and '_role_session() in' not in _sans_doc,
      _sans_doc[:200])

# Repli pour une session sans la cle : catalogue complet pour chef_admin et
# superadmin seulement.
perms = bloc(front, 'def _permissions_session')
check("_permissions_session renvoie un set, jamais None",
      'set(' in perms and 'return set()' in perms or 'set()' in perms)
check("et son repli ne concerne que chef_admin/superadmin",
      'ROLE_CHEF_ADMIN' in perms or 'chef_admin' in perms)

# Chaque page admin porte un gate.
for _nom, _perm in GATES:
    _corps = bloc(front, 'def %s' % _nom)
    check("%s redirige vers l'accueil, sans purger la session" % _nom,
          "url_for('index')" in _corps, _nom)

# Gate et revalidation sont tous deux necessaires.
for _nom, _ in GATES:
    _corps = bloc(front, 'def %s' % _nom)
    check("%s revalide TOUJOURS la session, gate ou pas" % _nom,
          '_acces_admin_revoque()' in _corps, _nom)


print("\n=== Gate par bloc DANS le gabarit (le second etage du double-gate) ===")
# Gate de route (la page) et gates de gabarit (les blocs) sont complementaires.
reglages_html = io_open(os.path.join(FRONT, 'templates', 'admin_reglages.html'))

# --- admin_comptes : trois domaines dans une page -------------------------
# Route ouverte sur l'union des trois droits, chaque onglet gate separement.
DOMAINES_COMPTES = ['gestion_liaisons', 'gestion_comptes', 'gestion_invitations']

route_comptes = bloc(front, 'def admin_comptes')
for _perm in DOMAINES_COMPTES:
    check("admin_comptes : la route connait le domaine %s" % _perm,
          "'%s'" % _perm in route_comptes, _perm)
check("admin_comptes s'ouvre sur l'UNION des droits, pas sur leur intersection",
      '&' in route_comptes and '_permissions_session()' in route_comptes)

# Un onglet et son panneau portent le meme gate.
for _perm in DOMAINES_COMPTES:
    _n = admin_html.count("{% if peut('" + _perm + "') %}")
    check("admin_comptes : %s gate l'onglet ET son panneau (%d occurrences)"
          % (_perm, _n), _n >= 2, _n)

# Onglet des jetons de bot : superadmin seulement.
_nb = admin_html.count('{% if est_superadmin %}')
check("admin_comptes : l'onglet superadmin suit la meme regle de paire", _nb >= 2, _nb)

# Onglet actif choisi en JS.
check("admin_comptes : aucun onglet n'est marque actif en dur dans le gabarit",
      'class="is-active"' not in admin_html and "class='is-active'" not in admin_html)

# --- admin_reglages : un seul droit (gestion_config) -----------------------
check("admin_reglages : les blocs sont sous un droit unique (gestion_config)",
      reglages_html.count("{% if peut('gestion_config') " + "%}") >= 2)
check("admin_reglages : plus aucun bloc sous une capacite de ROLE",
      "peut('gestion_config') or role_admin" not in reglages_html
      and "role_admin in ('chef_admin'" not in reglages_html.split('{# ')[0])

# Une page sans aucun bloc affiche une explication.
check("admin_reglages : une page sans aucun bloc s'explique au lieu de rester vide",
      'n\'avez aucun droit' in reglages_html or 'aucun droit sur' in reglages_html)

# --- gestion_joueurs : un droit par geste ---------------------------------
# Chaque champ porte sa sous-permission ; les champs sont grises, pas masques.
joueurs_html = io_open(os.path.join(FRONT, 'templates', 'gestion_joueurs.html'))
SOUS_PERMS = ['joueurs_nom', 'edition_mu_sigma', 'joueurs_couleur',
              'joueurs_statut', 'joueurs_creation', 'joueurs_irreversible']
for _perm in SOUS_PERMS:
    check("gestion_joueurs : le champ sous %s est declare au gabarit" % _perm,
          "peut('%s')" % _perm in joueurs_html, _perm)
check("gestion_joueurs : les droits sont passes au JS, qui grise au lieu de masquer",
      'PEUT_CHAMPS_JOUEUR' in joueurs_html)


print("\n=== La sortie de session : l'ecran mot de passe n'existe plus ===")
# La route /admin n'existe plus : aucune redirection ne doit y mener.
sortie = bloc(front, 'def _session_admin_expiree')
check("elle purge la session Discord et sa copie de compte",
      "pop('player_token'" in sortie and "pop('compte'" in sortie)
check("et renvoie vers l'accueil",
      "url_for('index')" in sortie and 'admin_login' not in sortie)
check("plus aucune redirection vers l'ecran mot de passe nulle part",
      "url_for('admin_login')" not in front and "url_for('admin_logout')" not in front)
check("la vue admin_login n'existe plus",
      'def admin_login(' not in front and 'def admin_logout(' not in front)
check("son gabarit non plus",
      not os.path.exists(os.path.join(FRONT, 'templates', 'admin_login.html')))


print("\n=== Une page deja ouverte reagit au 401 ===")
# Sur 401/403, les helpers JS proposent de se reconnecter. Borne sur la fin
# reelle de la fonction JS.
def bloc_js(source, ancre):
    i = source.find(ancre)
    if i < 0:
        return ''
    indent = ' ' * (i - source.rfind('\n', 0, i) - 1)
    fin = source.find('\n' + indent + '}', i)
    return source[i:fin + len(indent) + 3] if fin > i else source[i:]


api_js = bloc_js(admin_html, 'async function api(')
check("le helper api() detecte le refus de session",
      'status === 401' in api_js or 'status === 403' in api_js)
check("et redirige au lieu de peindre une erreur",
      'window.location' in api_js)


print("\n=== Un 429 du limiteur est distingue d'une panne ===")
# Un 429 (limiteur) affiche un message d'attente et ne deconnecte pas.
_GESTION = os.path.join(FRONT, 'static', 'js', 'gestion.js')
_SAISONS = os.path.join(FRONT, 'templates', 'admin_saisons.html')
gestion_js = io_open(_GESTION)
saisons_html = io_open(_SAISONS)

for _nom, _src, _ancre in [
        ('apiCall (gestion.js)', gestion_js, 'async function apiCall'),
        ('api (admin_comptes)', admin_html, 'async function api('),
        ('api (admin_saisons)', saisons_html, 'async function api(')]:
    _z = bloc_js(_src, _ancre)
    check("%s traite le 429" % _nom, 'status === 429' in _z, _z[:120])
    check("  et lit Retry-After pour dire quand reessayer" ,
          'Retry-After' in _z, _nom)
    # Un `return` doit separer le traitement du 429 de la redirection du 401.
    _apres503 = _z[_z.find('status === 429'):]
    _redir = _apres503.find('window.location')
    _retour = _apres503.find('return')
    check("  sans purger la session sur un 429",
          _retour >= 0 and (_redir < 0 or _retour < _redir), _nom)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
