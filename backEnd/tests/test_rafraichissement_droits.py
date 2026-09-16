"""Un droit accordé se voit au rafraîchissement, sans reconnexion.

Avant : la session portait une copie des permissions figée à la CONNEXION, et
toutes les pages la lisaient. Accorder « Corriger le score » à un admin ne
changeait rien pour lui -- il devait se déconnecter et se reconnecter, sans
qu'aucun écran ne le lui dise.

Le correctif passe par la sonde de session déjà appelée à chaque requête
(`/auth/check-session`, before_request) : elle rend désormais `role` et
`permissions`, que `player_required` a de toute façon lus en base pour
authentifier. Rien ne coûte un appel réseau de plus.

⚠️ Une version intermédiaire appelait `/auth/me` séparément depuis le context
processor. Ça marchait, mais ajoutait un aller-retour synchrone par rendu de
page : sur les 2 workers gunicorn du frontend, deux pages simultanées les
bloquaient tous les deux et nginx répondait **503** (observé le 2026-09-17).
Ne pas y revenir -- un rendu de page ne doit pas faire d'appel réseau.

Ce que ces tests verrouillent :
  - un droit accordé apparaît sans reconnexion, et un droit retiré disparaît ;
  - le rôle suit les permissions (sinon un rétrogradé garde son menu) ;
  - AUCUN appel réseau supplémentaire n'est fait pour ça ;
  - une panne backend ne déconnecte pas et ne vide pas les droits connus ;
  - un corps de réponse inattendu ne casse pas la page.
"""
from harness import *

FRONT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'frontEnd')
sys.path.insert(0, FRONT)

import types

appels = []
reponse = {'status': 200, 'payload': None}


class _Rep:
    def __init__(self, code, payload):
        self.status_code = code
        self._p = payload
        self.text = '' if payload is None else str(payload)
    def json(self):
        if self._p is None:
            raise ValueError('pas de json')
        return self._p


def _get(url, **kw):
    appels.append(url)
    if url.endswith('/auth/check-session'):
        return _Rep(reponse['status'], reponse['payload'])
    # Un backend reel refuse TOUTES les routes protegees d'une session revoquee,
    # pas seulement la sonde. Repondre 200 ici ferait passer pour sur un
    # frontend qui laisse fuir des donnees des qu'il ne sonde plus : le test
    # mesurerait la complaisance du stub, pas le comportement de l'appli.
    if reponse['status'] in (401, 403) and '/admin/' in url:
        return _Rep(reponse['status'], {'error': 'session expiree'})
    return _Rep(200, {})


faux = types.ModuleType('requests')
faux.get = _get
faux.post = lambda url, **kw: _Rep(200, {})
faux.put = lambda url, **kw: _Rep(200, {})
faux.delete = lambda url, **kw: _Rep(200, {})


class _Exc(Exception):
    pass


faux.exceptions = types.SimpleNamespace(RequestException=_Exc, Timeout=_Exc)
sys.modules['requests'] = faux

os.environ.setdefault('SECRET_KEY', 'test-secret')
os.environ.setdefault('BACKEND_URL', 'http://backend:5000')

import frontend
frontend.app.config['WTF_CSRF_ENABLED'] = False
frontend.app.config['TESTING'] = True


# Sonde : rend ce que le context processor expose. C'est le chemin reel --
# inject_est_admin tourne avant chaque rendu de template.
@frontend.app.route('/__sonde__')
def _sonde_page():
    from flask import render_template_string
    return render_template_string(
        "{{ role_admin }}|{{ 'O' if peut('edition_mu_sigma') else 'N' }}"
        "|{{ 'O' if peut('joueurs_nom') else 'N' }}")


def session_admin(cli, permissions, role='admin', compte_id=7):
    with cli.session_transaction() as s:
        s['player_token'] = 'tok'
        s['compte'] = {'id': compte_id, 'pseudo': 'A', 'role': role,
                       'statut': 'linked', 'permissions': sorted(permissions)}


def valide(role='admin', permissions=('gestion_joueurs',)):
    """Corps d'une sonde /auth/check-session qui accepte la session."""
    return {'status': 'valid', 'role': role, 'permissions': sorted(permissions)}


def sonde(cli):
    role, mu, nom = cli.get('/__sonde__').get_data(as_text=True).split('|')
    return {'role': role, 'mu_sigma': mu == 'O', 'nom': nom == 'O'}


print("\n=== Un droit accordé apparaît sans reconnexion ===")

cli = frontend.app.test_client()
# La session ne connaît que gestion_joueurs ; le backend, lui, a déjà la
# nouvelle permission -- c'est exactement l'état après un octroi.
session_admin(cli, {'gestion_joueurs'})
reponse['status'] = 200
reponse['payload'] = valide(permissions=['gestion_joueurs', 'edition_mu_sigma'])
vus = sonde(cli)
check("le droit fraîchement accordé est vu", vus['mu_sigma'], vus)

with cli.session_transaction() as s:
    check("  et la copie en session est mise à jour",
          'edition_mu_sigma' in (s['compte'].get('permissions') or []),
          s['compte'])


print("\n=== Un droit RETIRÉ disparaît aussi ===")

cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs', 'edition_mu_sigma', 'joueurs_nom'})
reponse['payload'] = valide(permissions=['gestion_joueurs'])
vus = sonde(cli)
check("le droit retiré n'est plus vu", not vus['mu_sigma'], vus)
check("  ni l'autre", not vus['nom'], vus)


print("\n=== Le rôle suit les permissions ===")
# N'en rafraîchir qu'une laisserait un chef_admin rétrogradé garder son menu
# complet jusqu'à sa déconnexion.

cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs'}, role='chef_admin')
reponse['payload'] = valide(role='admin', permissions=['gestion_joueurs'])
vus = sonde(cli)
check("une rétrogradation est prise en compte", vus['role'] == 'admin', vus)


print("\n=== AUCUN appel réseau de plus : c'est tout l'objet du correctif ===")
# La panne du 2026-09-17 : un /auth/me en plus par rendu de page saturait les
# 2 workers gunicorn du frontend, et nginx répondait 503.

cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs'})
reponse['payload'] = valide(permissions=['gestion_joueurs', 'edition_mu_sigma'])
appels.clear()
sonde(cli)
check("aucun appel à /auth/me", not [u for u in appels if u.endswith('/auth/me')],
      appels)
check("  la sonde de session suffit",
      len([u for u in appels if u.endswith('/auth/check-session')]) == 1, appels)

# Le timeout de la sonde doit rester court : elle est dans le chemin de CHAQUE
# requête. C'est ce qui borne le risque de saturation.
import inspect
src_sonde = inspect.getsource(frontend._sonde_session)
check("la sonde garde un timeout court", 'timeout=1' in src_sonde, src_sonde[:200])


print("\n=== Une panne backend ne déconnecte pas et ne vide pas les droits ===")
# R-55 : purger la session sur un 503 déconnecterait tout le monde au premier
# hoquet de la base.

for code in (503, 500):
    cli = frontend.app.test_client()
    session_admin(cli, {'gestion_joueurs', 'edition_mu_sigma'})
    reponse['status'] = code
    reponse['payload'] = None
    vus = sonde(cli)
    check("sur %d, les droits connus restent" % code, vus['mu_sigma'], vus)
    with cli.session_transaction() as s:
        check("  la session n'est pas purgée", s.get('compte') is not None)

# 401/403 : la session est refusée, et là on déconnecte bien (comportement
# antérieur à ce chantier, porté par _sonde_session).
cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs'})
reponse['status'] = 401
reponse['payload'] = None
sonde(cli)
with cli.session_transaction() as s:
    check("un refus explicite déconnecte toujours", s.get('compte') is None)

reponse['status'] = 200


print("\n=== Un corps inattendu ne casse jamais la page ===")
# _maj_droits_session tourne dans un before_request : une exception y ferait
# tomber TOUTE page, et les routes proxy renverraient du HTML là où le JS
# attend du JSON (« Erreur serveur (Réponse invalide) »).

for corps in (None, [], 'texte', {'status': 'valid'}, {'role': None},
              {'permissions': None}):
    cli = frontend.app.test_client()
    session_admin(cli, {'gestion_joueurs', 'edition_mu_sigma'})
    reponse['payload'] = corps
    r = cli.get('/__sonde__')
    check("corps %r -> la page se rend quand même" % (corps,),
          r.status_code == 200, r.status_code)

# Un backend plus ancien (sans role/permissions dans la sonde) ne doit pas
# effacer les droits connus : sinon un déploiement partiel viderait les menus.
cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs', 'edition_mu_sigma'})
reponse['payload'] = {'status': 'valid'}
vus = sonde(cli)
check("un backend sans ces champs laisse la copie intacte", vus['mu_sigma'], vus)


print("\n=== Le cookie n'est réécrit que si quelque chose a changé ===")
# session.modified force un Set-Cookie. Le poser à chaque requête alourdirait
# toutes les réponses du site pour rien.

cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs'})
reponse['payload'] = valide(permissions=['gestion_joueurs'])
r = cli.get('/__sonde__')
check("droits inchangés -> pas de Set-Cookie",
      'Set-Cookie' not in r.headers, dict(r.headers))

reponse['payload'] = valide(permissions=['gestion_joueurs', 'edition_mu_sigma'])
r = cli.get('/__sonde__')
check("droits changés -> cookie réécrit", 'Set-Cookie' in r.headers)


print("\n=== Sans session, aucune sonde ===")

cli = frontend.app.test_client()
appels.clear()
sonde(cli)
# La page appelle /saisons pour sa navbar : c'est hors sujet ici. Seule la
# sonde de session doit rester silencieuse sans jeton.
check("un visiteur anonyme ne déclenche aucune sonde",
      not [u for u in appels if 'check-session' in u or u.endswith('/auth/me')],
      appels)


print("\n=== La sonde ne part plus sur les appels JSON d'une page ouverte ===")
# Ouvrir une page admin, c'est un document puis trois appels JSON. Sonder les
# quatre revalidait quatre fois la meme session en quelques millisecondes : 9
# allers-retours backend pour une page qui n'en vaut que 4, sur 2 workers
# gunicorn qui bloquent pendant l'attente. D'ou les 503 et les « Erreur
# Backend » intermittents du 2026-09-17 (docs/audit-503-zone-admin.md).

cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs'})
reponse['status'] = 200
reponse['payload'] = valide(permissions=['gestion_joueurs'])

appels.clear()
cli.get('/__sonde__', headers={'Accept': 'text/html'})
sondes_doc = [u for u in appels if 'check-session' in u]
check("une navigation HTML sonde bien la session", len(sondes_doc) == 1, appels)

appels.clear()
cli.get('/admin/joueurs', headers={'Accept': 'application/json'})
sondes_json = [u for u in appels if 'check-session' in u]
check("un fetch JSON ne sonde plus", not sondes_json, appels)
check("  mais relaie bien l'appel utile au backend",
      any(u.endswith('/admin/joueurs') for u in appels), appels)

# Le repli doit pencher du BON cote. `fetch()` sans `Accept` envoie « */* » :
# tant qu'un appel oublie l'en-tete, il doit etre revalide, pas exempte. Se
# tromper coute une sonde de trop ; l'inverse laisserait une session morte
# servir des donnees. Les appels du depot posent l'en-tete (apiCall, navbar),
# cette assertion protege ceux qu'on ajoutera plus tard.
appels.clear()
cli.get('/admin/joueurs', headers={'Accept': '*/*'})
check("un appel sans Accept explicite est revalide (repli sur)",
      any('check-session' in u for u in appels), appels)


print("\n=== Et les appels du depot posent bien cet en-tete ===")
# Le gain ci-dessus n'existe que si les appelants annoncent « application/json ».
# Le repli (revalider) est sur, mais SILENCIEUX : un fetch qui oublie l'en-tete
# refait payer une sonde par appel, sans qu'aucune erreur ne le signale. C'est
# exactement ce qui est arrive apres le premier correctif -- gestion.js et la
# navbar avaient ete traites, mais le helper api() de admin_comptes.html, non :
# la page Comptes retombait en 503 (rapporte le 2026-09-17).
#
# D'ou un balayage de TOUT le frontend plutot que quelques fichiers nommes :
# c'est la seule forme qui attrape aussi les pages qu'on ajoutera plus tard.
import re as _re2

_IGNORE_HOTE_EXTERNE = ('http://', 'https://', '`http')   # widget Discord & co.


def _fetchs_de_chargement(source):
    """(ligne, extrait) des fetch() qui chargent des donnees, sans en-tete.

    Ecarte : les ecritures (POST/PUT/DELETE, declenchees par un clic, hors du
    chemin de chargement), les appels a un hote externe (ils ne passent ni par
    nginx ni par le frontend), et ceux dont les options viennent d'une variable
    (`opts`/`options`) -- c'est la forme des helpers, verifies a part.
    """
    trouves = []
    for m in _re2.finditer(r'fetch\(', source):
        extrait = ' '.join(source[m.start():m.start() + 230].split())
        if extrait.startswith('fetch()`'):
            continue                      # occurrence citee dans un commentaire
        cible = extrait[len('fetch('):].lstrip()
        if any(cible.startswith(h) for h in _IGNORE_HOTE_EXTERNE):
            continue
        if _re2.search(r"method:\s*'(POST|DELETE|PUT)'", extrait):
            continue
        if _re2.search(r'\b(opts|options)\b', extrait):
            continue                      # helper : porte l'en-tete ailleurs
        if 'Accept' in extrait or 'HEADERS_JSON' in extrait:
            continue
        trouves.append((source[:m.start()].count('\n') + 1, extrait[:90]))
    return trouves


_oublis = []
for _dossier, _, _fichiers in os.walk(FRONT):
    if 'node_modules' in _dossier:
        continue
    for _f in sorted(_fichiers):
        if not _f.endswith(('.js', '.html')):
            continue
        _p = os.path.join(_dossier, _f)
        for _ligne, _ex in _fetchs_de_chargement(open(_p, encoding='utf-8').read()):
            _oublis.append("%s:%d %s" % (os.path.basename(_p), _ligne, _ex))

check("aucun fetch de chargement n'oublie Accept", not _oublis,
      ' | '.join(_oublis))

# Les trois helpers centraux, verifies nommement : le balayage ci-dessus les
# ignore (leurs options passent par une variable), et ce sont eux qui portent
# l'en-tete pour la grande majorite des appels.
_HELPERS = [
    ('gestion.js', 'static/js/gestion.js', 'async function apiCall'),
    ('admin_comptes.html', 'templates/admin_comptes.html', 'async function api('),
    ('admin_saisons.html', 'templates/admin_saisons.html', 'method: method,'),
]
for _nom, _rel, _ancre in _HELPERS:
    _src = open(os.path.join(FRONT, *_rel.split('/')), encoding='utf-8').read()
    _i = _src.find(_ancre)
    _zone = _src[_i:_i + 900] if _i >= 0 else ''
    check("  le helper de %s annonce Accept" % _nom,
          "'Accept': 'application/json'" in _zone, _zone[:160])

check("  et les fetch de la navbar aussi",
      'HEADERS_JSON' in open(os.path.join(FRONT, 'templates', 'navbar.html'),
                             encoding='utf-8').read())


print("\n=== Et le 503 du limiteur reste lisible a l'ecran ===")
# Meme famille de defaut silencieux que ci-dessus, cote affichage : `api()`
# compose « Patientez N secondes » sur un 503, mais les appelants ecrasaient ce
# message par un « Chargement impossible. » generique -- le seul indice pointant
# vers le limiteur etait calcule puis jete.
#
# Balayage plutot qu'assertions nominatives, pour la meme raison qu'au-dessus :
# le prochain chargement ajoute doit echouer ici s'il reintroduit le motif.
_src_comptes = open(os.path.join(FRONT, 'templates', 'admin_comptes.html'),
                    encoding='utf-8').read()

# La forme fautive : une garde d'echec qui peint le message generique en dur.
_generiques = [
    (_src_comptes[:m.start()].count('\n') + 1,
     ' '.join(_src_comptes[m.start():m.start() + 100].split()))
    for m in _re2.finditer(
        r"if \(!ok\) \{[^}]*'Chargement impossible\.'", _src_comptes)
]
check("aucune garde de chargement n'ecrase le message du limiteur",
      not _generiques, ' | '.join("l.%d %s" % g for g in _generiques))

# Et le helper qui le remplace doit lire le drapeau ET relayer le message
# d'`api()`. Verifier la seule presence de `.limite` ne suffirait pas : elle
# reste vraie d'un helper qui teste le drapeau puis jette le message.
_i = _src_comptes.find('function echecChargement')
_fin_h = _src_comptes.find('function ', _i + 30) if _i >= 0 else -1
_zone_helper = _src_comptes[_i:_fin_h] if _i >= 0 and _fin_h > _i else ''
check("  le helper d'echec lit le drapeau `limite`",
      '.limite' in _zone_helper, _zone_helper[:160])
check("  et relaie le message porte par la reponse",
      '.error' in _zone_helper, _zone_helper[:160])

# Enfin, la source du drapeau : api() doit continuer de le poser sur un 503,
# et de rendre la main AVANT toute deconnexion -- un debit limite ne dit rien
# sur la validite d'une session.
#
# La zone s'arrete a la fonction suivante, et non a un nombre de caracteres :
# une borne fixe se decalerait au premier commentaire ajoute, et les deux
# assertions passeraient au vert sans rien verifier.
_i = _src_comptes.find('async function api(')
_fin = _src_comptes.find('function ', _i + 30) if _i >= 0 else -1
_zone_api = _src_comptes[_i:_fin] if _i >= 0 and _fin > _i else ''
_pos_503 = _zone_api.find('res.status === 503')
_pos_401 = _zone_api.find('res.status === 401')
check("  api() pose `limite: true` sur un 503",
      'limite: true' in _zone_api, _zone_api[:160])
check("  et traite le 503 AVANT le 401 (pas de deconnexion sur un debit limite)",
      0 <= _pos_503 < _pos_401, (_pos_503, _pos_401))


print("\n=== Mais une session revoquee reste refusee sur les DEUX chemins ===")
# C'est le risque du raccourci ci-dessus : sans sonde, le refus doit venir du
# backend lui-meme, relaye tel quel. Le frontend n'est pas une frontiere de
# privilege -- c'est ce qui rend l'optimisation sure, et c'est verifie ici.

cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs'})
reponse['status'] = 401
reponse['payload'] = {'error': 'session expiree'}

r = cli.get('/admin/joueurs-fiches', headers={'Accept': 'text/html'},
            follow_redirects=False)
check("le document admin redirige au lieu de se rendre", r.status_code == 302,
      r.status_code)

session_admin(cli, {'gestion_joueurs'})
r = cli.get('/admin/joueurs', headers={'Accept': 'application/json'})
check("l'appel JSON non sonde est refuse quand meme",
      r.status_code in (401, 403), r.status_code)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
