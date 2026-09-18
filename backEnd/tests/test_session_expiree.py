"""Non-regressions du correctif « session Discord expiree toujours affichee ».

Le defaut : rien ne revalidait jamais `player_token`. Le frontend decidant
l'etat connecte et l'onglet admin sur une copie figee dans le cookie
(`session['compte']`), un jeton expire laissait l'utilisateur affiche comme
connecte -- onglet admin compris -- jusqu'a ce qu'il visite /mon-compte. Les
pages admin s'ouvraient alors sur « Chargement impossible. » au premier appel
de donnees, au lieu d'une invitation a se reconnecter.

Ces assertions portent sur le SOURCE, comme test_bascule : c'est du cablage
entre deux services, il n'y a pas de comportement a executer ici.
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
    """Source de la fonction designee par `ancre`, ou '' si elle a disparu.

    Renvoyer '' plutot que lever : un `.index()` nu ferait mourir le fichier a la
    premiere regression, et les assertions suivantes ne s'afficheraient jamais.
    Une chaine vide fait echouer l'assertion, proprement, en la nommant.

    `ancre` vaut soit « def nom_de_fonction », soit une ligne de decorateur
    (typiquement une route) : dans les deux cas c'est la fonction CONCERNEE qui
    est rendue, decorateurs compris, delimitee par `ast` et non par une fenetre
    de caracteres.

    Le decoupage se faisait auparavant sur une taille fixe de 1200 caracteres.
    Il suffisait qu'une docstring s'allonge pour repousser le code utile hors de
    la fenetre et faire echouer des assertions sur du code pourtant intact --
    desamorce a la main une premiere fois pour `_sonde_session`, puis reapparu
    le 2026-09-17 sur `check_session_validity`. Les bornes textuelles qui ont
    suivi coupaient, elles, sur le `def` ou le decorateur voisin. Un vrai parseur
    supprime la classe de bugs entiere.

    `taille` ne sert plus que de repli pour les sources NON Python -- ce fichier
    inspecte aussi du HTML/JS -- ou aucun parseur n'est disponible. Ces
    sources-la n'ont pas de docstring pour repousser le code hors de la fenetre,
    ce qui rend le decoupage textuel sans danger a cet endroit.
    """
    try:
        arbre = ast.parse(source)
    except SyntaxError:
        # `bloc` sert aussi sur du HTML/JS (le helper api() de admin_comptes).
        # Pas de parseur pour ces sources-la : on retombe sur la fenetre de
        # taille fixe, acceptable parce qu'aucune docstring ne vient l'y
        # repousser -- c'est le code Python qui souffrait de ce decoupage.
        i = source.find(ancre)
        return '' if i < 0 else source[i:i + taille]

    lignes = source.splitlines(keepends=True)

    def texte(noeud):
        # `decorator_list` est exclu de lineno : on remonte au premier
        # decorateur pour que « @player_required » reste dans le bloc rendu.
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
            # Ancre = ligne de decorateur : on cherche la fonction dont l'un des
            # decorateurs contient cette chaine.
            corps = texte(noeud)
            entete = corps[:corps.find('def ')] if 'def ' in corps else corps
            if ancre in entete:
                return corps
    return ''


front = io_open(os.path.join(FRONT, 'frontend.py'))
routes_auth = io_open(os.path.join(RACINE, 'routes_auth.py'))
admin_html = io_open(os.path.join(FRONT, 'templates', 'admin_comptes.html'))


print("\n=== La sonde de session existe et ne coute rien ===")
# Elle est appelee sur CHAQUE page : elle ne doit rien lire de plus que la
# verification de session que player_required fait deja. /auth/me ferait une
# requete supplementaire pour le nom du joueur, payee sur tout le site.
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
check("before_request surveille aussi l'ancien jeton admin",
      "'admin_token' in session" in avant_request)
check("un refus purge le jeton joueur ET sa copie de compte",
      "pop('player_token'" in avant_request and "pop('compte'" in avant_request)

# Une sonde par PAGE, plus une par requete. Sonder aussi les appels JSON faisait
# payer 8 allers-retours backend pour ouvrir une page qui n'en vaut que 4, sur
# 2 workers gunicorn qui bloquaient pendant l'attente : d'ou les 503 et les
# « Erreur Backend » intermittents du 2026-09-17 (docs/audit-503-zone-admin.md).
check("mais pas sur les appels JSON d'une page deja ouverte",
      '_est_navigation' in avant_request)
navigation = bloc(front, 'def _est_navigation')
check("distingue navigation et fetch sur l'en-tete Accept",
      "'Accept'" in navigation and 'application/json' in navigation)
# Se tromper doit couter une sonde de trop, jamais une session laissee valide a
# tort : un Accept absent ou exotique est donc traite comme une navigation.
check("et traite un Accept inconnu comme une navigation",
      'not in' in navigation)

print("\n--- mais ne purge QUE sur un refus explicite (R-28) ---")
# Confondre « session invalide » et « backend en panne » deconnecterait tout le
# monde a chaque redemarrage du backend.
# Borne sur la vraie fin de la fonction plutot que sur un nombre de caracteres :
# une docstring qui s'allonge repoussait le code utile hors de la fenetre, et
# ces deux assertions echouaient sur du code pourtant intact.
_i = front.find('def _sonde_session')
sonde = front[_i:front.find('\n@app.', _i)] if _i >= 0 else ''
check("seuls 401/403 declenchent la purge",
      '(401, 403)' in sonde or '[401, 403]' in sonde)
check("un timeout conserve la session",
      'return False' in sonde and 'except Exception' in sonde)


print("\n=== Aucune page admin ne se rend sur la seule foi du cookie ===")
# _est_admin() lit une copie potentiellement perimee : c'est une porte
# d'interface, pas une preuve de session. Toute page admin doit donc revalider
# aupres du backend avant de rendre son gabarit.
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
    # Jusqu'a la prochaine route : la revalidation doit etre DANS la vue.
    fin = front.find('@app.route', k)
    corps = front[k:fin if fin > k else k + 4000]
    # Soit l'appel en clair, soit le helper qui le porte. Les six vues repetaient
    # mot pour mot le meme backend_request('/admin/check-token') ; il est
    # factorise depuis le 2026-09-17 dans `_acces_admin_revoque`, qui memoise en
    # plus le verdict que le before_request vient d'etablir sur la meme requete.
    # Exiger la chaine litterale ferait echouer cette assertion sur du code qui
    # revalide pourtant bel et bien -- ce qui s'est produit lors de la refonte.
    check("%s revalide avant de rendre" % nom,
          '/admin/check-token' in corps or '_acces_admin_revoque()' in corps, nom)


print("\n--- et le helper qui porte cette revalidation fait vraiment l'appel ---")
# Les six assertions ci-dessus acceptent desormais une indirection : sans les
# trois suivantes, vider `_acces_admin_revoque` de son contenu les laisserait
# toutes vertes en supprimant toute revalidation.
revoque = bloc(front, 'def _acces_admin_revoque')
check("il interroge bien le backend",
      "'/admin/check-token'" in revoque)
check("et traite 401/403 comme un acces revoque",
      '(401, 403)' in revoque or '[401, 403]' in revoque)
# La memoisation ne doit vivre que le temps d'UNE requete HTTP. Portee sur
# `session` (cookie) ou sur un global de module, elle survivrait a la revocation
# qu'elle est censee detecter : un admin retrograde garderait ses pages ouvertes.
# `g` est remis a zero par Flask a chaque requete, c'est la seule portee sure.
check("et memoise sur g, jamais sur la session ni un global",
      'session_revalidee' in revoque and '(g,' in revoque
      and 'session[' not in revoque)


print("\n=== Gate de permission : droit manquant != session expiree ===")
# Le coeur du §8.3 de permissions-onglets-contexte.md, longtemps non teste.
#
# Deux refus coexistent sur ces pages et ne doivent SURTOUT pas se confondre :
#
#   - session expiree  -> purge des jetons + retour accueil (il faut se
#     reconnecter) ;
#   - droit manquant   -> message et redirection, mais AUCUNE deconnexion : la
#     session est parfaitement valide, c'est la permission qui manque.
#
# Les confondre deconnecterait un admin legitime a chaque page interdite, et
# c'est le genre de defaut qu'on prend pour « le site m'a ejecte ».
GATES = [
    ("admin_tournois", 'gestion_tournois'),
    ("admin_reglages", 'gestion_config'),
    # Ajoutee le 2026-09-18. La navbar cachait deja le lien, mais un lien cache
    # n'est pas un acces ferme : l'URL restait ouverte et la page finissait sur
    # « Chargement impossible. ». `gestion_joueurs` n'ouvre que la LECTURE
    # depuis la scission -- c'est bien le droit qui autorise a REGARDER la page.
    ("admin_joueurs_fiches", 'gestion_joueurs'),
]
for nom, permission in GATES:
    corps = bloc(front, 'def %s' % nom)
    check("%s porte un gate de permission" % nom,
          "'%s' not in _permissions_session()" % permission in corps, nom)
    # L'ORDRE compte : le gate doit passer AVANT la revalidation de session.
    # Dans l'autre sens, un admin sans le droit paierait un aller-retour
    # backend pour se voir refuser de toute facon.
    i_gate = corps.find('_permissions_session()')
    i_reval = corps.find('_acces_admin_revoque()')
    check("%s teste la permission avant de revalider la session" % nom,
          i_gate >= 0 and i_reval >= 0 and i_gate < i_reval, (i_gate, i_reval))
    # Le refus de droit ne doit PAS purger les jetons : c'est ce qui le
    # distingue d'une session expiree.
    avant_reval = corps[:i_reval] if i_reval > 0 else corps
    check("%s ne deconnecte PAS sur un simple manque de droit" % nom,
          '_session_admin_expiree' not in avant_reval
          and "pop('player_token'" not in avant_reval, nom)

# Le gate lit les permissions de la SESSION, jamais un role en dur : depuis la
# scission du 2026-09-13, un chef_admin porte gestion_config par construction,
# et un `or role in (...)` reintroduirait un chemin parallele.
# La docstring de la vue EXPLIQUE ce motif retire ; la chercher dans le source
# brut la retrouvait dans le commentaire et faisait echouer une assertion sur du
# code pourtant correct. On inspecte donc le corps executable seul -- meme piege
# que la fenetre de 1200 caracteres documentee plus haut.
reglages = bloc(front, 'def admin_reglages')
_sans_doc = _re.sub(r'(?s)\"\"\".*?\"\"\"', '', reglages)
_sans_doc = _re.sub(r'(?m)#.*$', '', _sans_doc)
check("le gate ne retombe pas sur un test de role en dur",
      'role_admin in (' not in _sans_doc and '_role_session() in' not in _sans_doc,
      _sans_doc[:200])

# Ce que le helper garantit : une session d'avant le chantier n'a pas la cle.
# Le repli ne vaut que pour chef_admin/superadmin, dont le socle EST le
# catalogue -- un admin repart de zero jusqu'a sa reconnexion.
perms = bloc(front, 'def _permissions_session')
check("_permissions_session renvoie un set, jamais None",
      'set(' in perms and 'return set()' in perms or 'set()' in perms)
check("et son repli ne concerne que chef_admin/superadmin",
      'ROLE_CHEF_ADMIN' in perms or 'chef_admin' in perms)

# Les TROIS onglets admin portent desormais un gate : c'est la regle, plus une
# exception a retenir. Une quatrieme page admin qui l'oublierait se verrait ici.
for _nom, _perm in GATES:
    _corps = bloc(front, 'def %s' % _nom)
    check("%s redirige vers l'accueil, sans purger la session" % _nom,
          "url_for('index')" in _corps, _nom)

# Le gate ne doit pas se substituer a la revalidation : les deux repondent a des
# questions differentes (« a-t-il le droit ? » et « sa session vaut-elle encore
# quelque chose ? »). Supprimer l'une en gardant l'autre laisserait un trou.
for _nom, _ in GATES:
    _corps = bloc(front, 'def %s' % _nom)
    check("%s revalide TOUJOURS la session, gate ou pas" % _nom,
          '_acces_admin_revoque()' in _corps, _nom)


print("\n=== Gate par bloc DANS le gabarit (le second etage du double-gate) ===")
# Le gate de route decide si la PAGE s'ouvre ; celui du gabarit decide quels
# BLOCS s'affichent. Les deux sont necessaires et ne se remplacent pas :
#
#   - sans le gate de route, un admin sans aucun des droits ouvrait une page
#     vide en tapant l'URL ;
#   - sans les gates de bloc, il verrait les onglets des domaines qu'il n'a pas.
#
# Aucun des deux n'est une securite : le backend revalide chaque appel. Ils
# decident de ce qu'on MONTRE, et un affichage qui ment fabrique des tickets.
reglages_html = io_open(os.path.join(FRONT, 'templates', 'admin_reglages.html'))

# --- admin_comptes : trois domaines dans une page -------------------------
# C'est LA page mixte du projet. La route s'ouvre sur l'UNION des trois droits,
# chaque onglet est gate separement. Un desaccord entre les deux niveaux donne
# soit une page vide, soit un onglet mort.
DOMAINES_COMPTES = ['gestion_liaisons', 'gestion_comptes', 'gestion_invitations']

route_comptes = bloc(front, 'def admin_comptes')
for _perm in DOMAINES_COMPTES:
    check("admin_comptes : la route connait le domaine %s" % _perm,
          "'%s'" % _perm in route_comptes, _perm)
check("admin_comptes s'ouvre sur l'UNION des droits, pas sur leur intersection",
      '&' in route_comptes and '_permissions_session()' in route_comptes)

# L'invariant qui compte : un onglet et son panneau portent le MEME gate. Les
# dissocier afficherait un onglet dont le contenu n'existe pas -- un clic dans
# le vide, que rien cote serveur ne viendrait rattraper.
for _perm in DOMAINES_COMPTES:
    _n = admin_html.count("{% if peut('" + _perm + "') %}")
    check("admin_comptes : %s gate l'onglet ET son panneau (%d occurrences)"
          % (_perm, _n), _n >= 2, _n)

# Le 4e onglet n'est pas une permission mais un rang : les jetons de bot sont
# reserves au superadmin. Il doit suivre la meme regle de paire.
_nb = admin_html.count('{% if est_superadmin %}')
check("admin_comptes : l'onglet superadmin suit la meme regle de paire", _nb >= 2, _nb)

# L'onglet actif est choisi cote JS, jamais en dur : en dur, ce pourrait etre
# un onglet auquel l'admin n'a pas droit.
check("admin_comptes : aucun onglet n'est marque actif en dur dans le gabarit",
      'class="is-active"' not in admin_html and "class='is-active'" not in admin_html)

# --- admin_reglages : la page n'est PLUS un double-gate -------------------
# Le §8.3 de permissions-onglets-contexte.md la cite comme l'exemple a tester.
# C'etait vrai avant le 2026-09-13 : le reset global exigeait alors chef_admin,
# la configuration demandait gestion_config. Le reset est devenu delegable, les
# deux blocs ont convergé sous le MEME droit. Le verifier evite qu'on
# reintroduise une frontiere que la doc croit encore la.
check("admin_reglages : les blocs sont sous un droit unique (gestion_config)",
      reglages_html.count("{% if peut('gestion_config') " + "%}") >= 2)
check("admin_reglages : plus aucun bloc sous une capacite de ROLE",
      "peut('gestion_config') or role_admin" not in reglages_html
      and "role_admin in ('chef_admin'" not in reglages_html.split('{# ')[0])

# Le repli : si tous les gates sont faux, la page dirait pourquoi au lieu de
# rester blanche. Ce cas ne doit pas arriver (la route refuse avant), mais une
# page vide sans explication est le pire des deux.
check("admin_reglages : une page sans aucun bloc s'explique au lieu de rester vide",
      'n\'avez aucun droit' in reglages_html or 'aucun droit sur' in reglages_html)

# --- gestion_joueurs : un droit par geste ---------------------------------
# Autre forme du meme patron : la page s'ouvre sur gestion_joueurs (lecture),
# et chaque CHAMP porte sa sous-permission. Le gabarit ne masque pas, il grise
# -- un champ absent se lit « la fonction n'existe pas », un champ grise se lit
# « je n'y ai pas droit ». La nuance est ce qui evite un ticket.
joueurs_html = io_open(os.path.join(FRONT, 'templates', 'gestion_joueurs.html'))
SOUS_PERMS = ['joueurs_nom', 'edition_mu_sigma', 'joueurs_couleur',
              'joueurs_statut', 'joueurs_creation', 'joueurs_irreversible']
for _perm in SOUS_PERMS:
    check("gestion_joueurs : le champ sous %s est declare au gabarit" % _perm,
          "peut('%s')" % _perm in joueurs_html, _perm)
check("gestion_joueurs : les droits sont passes au JS, qui grise au lieu de masquer",
      'PEUT_CHAMPS_JOUEUR' in joueurs_html)


print("\n=== La sortie de session ne renvoie plus vers le mot de passe ===")
# Plus aucune route backend n'accepte ce jeton : aucun usage de
# admin_or_role_required ne subsiste, et /admin/check-token est passee en
# role_required(ROLE_ADMIN). S'y reconnecter ne rouvrirait donc rien.
sortie = bloc(front, 'def _session_admin_expiree')
check("elle purge les deux voies",
      "pop('player_token'" in sortie and "pop('admin_token'" in sortie)
check("et renvoie vers l'accueil, pas vers l'ecran mot de passe",
      "url_for('index')" in sortie and 'admin_login' not in sortie)
check("plus aucune redirection vers l'ecran mot de passe nulle part",
      "url_for('admin_login')" not in front)


print("\n=== Une page deja ouverte reagit au 401 ===")
# Sans ca, chaque appel affichait « Chargement impossible. » sans dire pourquoi
# ni proposer de se reconnecter -- le serveur ayant deja purge la session.
# Borne sur la fin REELLE du helper (sa dernière accolade, à son indentation)
# plutôt que sur un nombre de caractères. `bloc` ne peut pas aider ici : c'est du
# HTML, il n'y a pas de parseur Python pour le découper, et son repli textuel a
# la fragilité qu'on cherche à éviter -- ajouter un cas au début de la fonction
# (le 503 du limiteur, 2026-09-17) repoussait le test 401/403 hors de la fenêtre
# et faisait échouer ces assertions sur du code pourtant intact.
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


print("\n=== Un 503 du limiteur est distingue d'une panne ===")
# La page d'erreur du limiteur est du HTML. Les helpers qui faisaient un
# res.json() dessus levaient une exception, ou affichaient « Erreur serveur
# (Reponse invalide) » -- un message qui accuse le serveur d'etre casse alors
# qu'il se protege, et qui tait la seule chose utile : attendre quelques
# secondes. Un 503 n'est PAS une session morte : surtout ne pas deconnecter.
_GESTION = os.path.join(FRONT, 'static', 'js', 'gestion.js')
_SAISONS = os.path.join(FRONT, 'templates', 'admin_saisons.html')
gestion_js = io_open(_GESTION)
saisons_html = io_open(_SAISONS)

for _nom, _src, _ancre in [
        ('apiCall (gestion.js)', gestion_js, 'async function apiCall'),
        ('api (admin_comptes)', admin_html, 'async function api('),
        ('api (admin_saisons)', saisons_html, 'async function api(')]:
    _z = bloc_js(_src, _ancre)
    check("%s traite le 503" % _nom, 'status === 503' in _z, _z[:120])
    check("  et lit Retry-After pour dire quand reessayer" ,
          'Retry-After' in _z, _nom)
    # Le traitement du 503 doit RENDRE LA MAIN avant tout code de déconnexion :
    # un débit limité ne dit rien sur la validité de la session, et déconnecter
    # ferait perdre son travail à quelqu'un qui a simplement cliqué trop vite.
    # On vérifie donc qu'un `return` sépare le test du 503 de la redirection,
    # et non l'absence de `window.location` dans la fonction (il y est
    # légitimement, pour le 401).
    _apres503 = _z[_z.find('status === 503'):]
    _redir = _apres503.find('window.location')
    _retour = _apres503.find('return')
    check("  sans purger la session sur un 503",
          _retour >= 0 and (_redir < 0 or _retour < _redir), _nom)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
