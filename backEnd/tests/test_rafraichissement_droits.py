"""Un droit accordé ou retiré se voit au rafraîchissement, sans reconnexion.

La sonde /auth/check-session rend role et permissions : aucun appel réseau
supplémentaire par page. Une panne backend ne déconnecte pas.
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
    # Comme un vrai backend : une session revoquee est refusee partout.
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


# Expose ce que le context processor fournit aux gabarits.
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
# Etat juste apres un octroi : la session ne connait que gestion_joueurs.
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
# Le role est rafraichi avec les permissions.

cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs'}, role='chef_admin')
reponse['payload'] = valide(role='admin', permissions=['gestion_joueurs'])
vus = sonde(cli)
check("une rétrogradation est prise en compte", vus['role'] == 'admin', vus)


print("\n=== AUCUN appel réseau de plus : c'est tout l'objet du correctif ===")
# Aucun appel a /auth/me pendant le rendu.

cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs'})
reponse['payload'] = valide(permissions=['gestion_joueurs', 'edition_mu_sigma'])
appels.clear()
sonde(cli)
check("aucun appel à /auth/me", not [u for u in appels if u.endswith('/auth/me')],
      appels)
check("  la sonde de session suffit",
      len([u for u in appels if u.endswith('/auth/check-session')]) == 1, appels)

# La sonde est sur le chemin de chaque requete : timeout court.
import inspect
src_sonde = inspect.getsource(frontend._sonde_session)
check("la sonde garde un timeout court", 'timeout=1' in src_sonde, src_sonde[:200])


print("\n=== Une panne backend ne déconnecte pas et ne vide pas les droits ===")
# Un 503 ne purge pas la session.

for code in (503, 500):
    cli = frontend.app.test_client()
    session_admin(cli, {'gestion_joueurs', 'edition_mu_sigma'})
    reponse['status'] = code
    reponse['payload'] = None
    vus = sonde(cli)
    check("sur %d, les droits connus restent" % code, vus['mu_sigma'], vus)
    with cli.session_transaction() as s:
        check("  la session n'est pas purgée", s.get('compte') is not None)

# 401/403 : deconnexion.
cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs'})
reponse['status'] = 401
reponse['payload'] = None
sonde(cli)
with cli.session_transaction() as s:
    check("un refus explicite déconnecte toujours", s.get('compte') is None)

reponse['status'] = 200


print("\n=== Un corps inattendu ne casse jamais la page ===")
# Une reponse inattendue ne doit pas faire tomber la page.

for corps in (None, [], 'texte', {'status': 'valid'}, {'role': None},
              {'permissions': None}):
    cli = frontend.app.test_client()
    session_admin(cli, {'gestion_joueurs', 'edition_mu_sigma'})
    reponse['payload'] = corps
    r = cli.get('/__sonde__')
    check("corps %r -> la page se rend quand même" % (corps,),
          r.status_code == 200, r.status_code)

# Une sonde sans role/permissions conserve les droits connus.
cli = frontend.app.test_client()
session_admin(cli, {'gestion_joueurs', 'edition_mu_sigma'})
reponse['payload'] = {'status': 'valid'}
vus = sonde(cli)
check("un backend sans ces champs laisse la copie intacte", vus['mu_sigma'], vus)


print("\n=== Le cookie n'est réécrit que si quelque chose a changé ===")
# Pas de Set-Cookie inutile.

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
# Seule la sonde de session doit rester silencieuse sans jeton.
check("un visiteur anonyme ne déclenche aucune sonde",
      not [u for u in appels if 'check-session' in u or u.endswith('/auth/me')],
      appels)


print("\n=== La sonde ne part plus sur les appels JSON d'une page ouverte ===")
# Une page admin = un document + des appels JSON : seul le document est sonde.

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

# Sans en-tete Accept (« */* »), l'appel est revalide.
appels.clear()
cli.get('/admin/joueurs', headers={'Accept': '*/*'})
check("un appel sans Accept explicite est revalide (repli sur)",
      any('check-session' in u for u in appels), appels)


print("\n=== Et les appels du depot posent bien cet en-tete ===")
# Tous les fetch() de chargement du frontend doivent annoncer application/json,
# sinon chaque appel repaye une sonde.
import re as _re2

_IGNORE_HOTE_EXTERNE = ('http://', 'https://', '`http')  # widget Discord, etc.


def _fetchs_de_chargement(source):
    """(ligne, extrait) des fetch() de chargement sans en-tete Accept.

    Ignore les ecritures, les hotes externes et les helpers (options en variable).
    """
    trouves = []
    for m in _re2.finditer(r'fetch\(', source):
        extrait = ' '.join(source[m.start():m.start() + 230].split())
        if extrait.startswith('fetch()`'):
            continue  # occurrence dans un commentaire
        cible = extrait[len('fetch('):].lstrip()
        if any(cible.startswith(h) for h in _IGNORE_HOTE_EXTERNE):
            continue
        if _re2.search(r"method:\s*'(POST|DELETE|PUT)'", extrait):
            continue
        if _re2.search(r'\b(opts|options)\b', extrait):
            continue  # helper, verifie a part
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

# Les helpers centraux portent l'en-tete.
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
      'HEADERS_JSON' in open(os.path.join(FRONT, 'static', 'js', 'navbar.js'),
                             encoding='utf-8').read())


print("\n=== Et le 429 du limiteur reste lisible a l'ecran ===")
# Les chargements ne doivent pas remplacer le message du 429 par un message generique.
_src_comptes = open(os.path.join(FRONT, 'templates', 'admin_comptes.html'),
                    encoding='utf-8').read()

# Garde d'echec qui affiche le message generique en dur.
_generiques = [
    (_src_comptes[:m.start()].count('\n') + 1,
     ' '.join(_src_comptes[m.start():m.start() + 100].split()))
    for m in _re2.finditer(
        r"if \(!ok\) \{[^}]*'Chargement impossible\.'", _src_comptes)
]
check("aucune garde de chargement n'ecrase le message du limiteur",
      not _generiques, ' | '.join("l.%d %s" % g for g in _generiques))

# echecChargement lit le drapeau et relaie le message d'api().
_i = _src_comptes.find('function echecChargement')
_fin_h = _src_comptes.find('function ', _i + 30) if _i >= 0 else -1
_zone_helper = _src_comptes[_i:_fin_h] if _i >= 0 and _fin_h > _i else ''
check("  le helper d'echec lit le drapeau `limite`",
      '.limite' in _zone_helper, _zone_helper[:160])
check("  et relaie le message porte par la reponse",
      '.error' in _zone_helper, _zone_helper[:160])

# api() pose le drapeau sur un 429 et rend la main avant toute deconnexion.
_i = _src_comptes.find('async function api(')
_fin = _src_comptes.find('function ', _i + 30) if _i >= 0 else -1
_zone_api = _src_comptes[_i:_fin] if _i >= 0 and _fin > _i else ''
_pos_503 = _zone_api.find('res.status === 429')
_pos_401 = _zone_api.find('res.status === 401')
check("  api() pose `limite: true` sur un 429",
      'limite: true' in _zone_api, _zone_api[:160])
check("  et traite le 429 AVANT le 401 (pas de deconnexion sur un debit limite)",
      0 <= _pos_503 < _pos_401, (_pos_503, _pos_401))


print("\n=== Mais une session revoquee reste refusee sur les DEUX chemins ===")
# Sans sonde, le refus vient du backend et est relaye tel quel.

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
