"""A-07 : le consentement a la politique est IMPOSE, plus seulement affiche.

Constat d'origine (audit-auth-discord.md, A-07) : `comptes.cgu_version` etait lu
et transmis, jamais exige. Changer CGU_VERSION affichait un bandeau sur
/mon-compte et ne bloquait rien. Tranche le 2026-09-24 : on impose.

Ce que ce fichier verrouille :
  - backend : tous les decorateurs refusent (428 `cgu_a_accepter`) une session
    sans la version courante, sauf la liste blanche `player_required_sans_cgu`,
    figee ici route par route ;
  - frontend : 428 ne purge pas la session, une page HTML renvoie vers
    /consentement, et le retour apres acceptation ne sort pas du site.
"""
from harness import *
import ast
import glob
import importlib
from flask import Flask, g, jsonify

H = {'X-Session-Token': 'tok'}
SESSION = r"FROM sessions_joueurs s JOIN comptes c"


def app_avec(ligne, deco_factory):
    """Appli minimale protegee par le decorateur a tester."""
    cur, conn = install_db([(SESSION, ligne)])
    recharger()
    import auth
    importlib.reload(auth)
    app = Flask(__name__)

    @app.route('/protege')
    @deco_factory(auth)
    def protege():
        return jsonify({"ok": True})
    return app.test_client(), cur


def statut(ligne, deco_factory):
    cli, cur = app_avec(ligne, deco_factory)
    r = cli.get('/protege', headers=H)
    return r.status_code, (r.get_json() or {}).get('code'), cur


# ===========================================================================
print("\n=== Backend : chaque decorateur exige la version courante ===")
DECOS = {
    'player_required': lambda a: a.player_required,
    'role_required(admin)': lambda a: a.role_required('admin'),
    'permission_required(gestion_comptes)': lambda a: a.permission_required('gestion_comptes'),
}
for nom, deco in DECOS.items():
    role = 'superadmin'     # passe tous les seuils : seul le consentement peut refuser
    s, code, _ = statut(ligne_session(role=role, cgu_version=None), deco)
    check("%s : jamais accepte -> 428 cgu_a_accepter" % nom,
          (s, code) == (428, 'cgu_a_accepter'), (s, code))
    s, code, _ = statut(ligne_session(role=role, cgu_version='0.9'), deco)
    check("  version perimee -> 428 aussi", (s, code) == (428, 'cgu_a_accepter'), (s, code))
    s, _, _ = statut(ligne_session(role=role, cgu_version='1.0'), deco)
    check("  version courante -> 200", s == 200, s)

s, code, cur = statut(ligne_session(cgu_version=None), DECOS['player_required'])
check("428 n'est ni 401 ni 403 : le frontend ne purge pas une session valide (R-28)",
      s not in (401, 403))
check("une session refusee pour consentement ne compte pas comme active (pas de last_seen_at)",
      not any('last_seen_at' in q for q, _ in cur.executed))

s, code, _ = statut(ligne_session(statut='suspended', cgu_version=None), DECOS['player_required'])
check("un compte suspendu l'apprend avant qu'on lui demande d'accepter (403)",
      (s, code) == (403, 'compte_suspendu'), (s, code))
s, code, _ = statut(ligne_session(expires_at=PASSE, cgu_version=None), DECOS['player_required'])
check("une session expiree reste un 401", s == 401, (s, code))

s, _, _ = statut(ligne_session(cgu_version=None), lambda a: a.player_required_sans_cgu)
check("player_required_sans_cgu laisse passer sans consentement", s == 200, s)
s, code, _ = statut(ligne_session(statut='suspended', cgu_version=None),
                    lambda a: a.player_required_sans_cgu)
check("  mais pas un compte suspendu", (s, code) == (403, 'compte_suspendu'), (s, code))


# ===========================================================================
print("\n=== Backend : la liste blanche est figee ===")
# Une route de plus ici ouvre une porte a qui n'a pas accepte. Ce doit etre un
# choix ecrit, pas un copier-coller : ce test rougit tant qu'on ne l'a pas acte.
ATTENDUES = {
    ('/auth/check-session', 'GET'),
    ('/me/cgu', 'POST'),
    ('/me/export', 'GET'),
    ('/avatar/moi', 'GET'),
}
trouvees = set()
backend = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
for fichier in glob.glob(os.path.join(backend, '*.py')):
    arbre = ast.parse(open(fichier, encoding='utf-8').read())
    for noeud in ast.walk(arbre):
        if not isinstance(noeud, ast.FunctionDef):
            continue
        noms = [d.id for d in noeud.decorator_list if isinstance(d, ast.Name)]
        if 'player_required_sans_cgu' not in noms:
            continue
        for d in noeud.decorator_list:
            if isinstance(d, ast.Call) and getattr(d.func, 'attr', None) == 'route':
                chemin = d.args[0].value
                methodes = next((k.value for k in d.keywords if k.arg == 'methods'), None)
                for m in (ast.literal_eval(methodes) if methodes else ['GET']):
                    trouvees.add((chemin, m))
check("exactement les quatre routes prevues", trouvees == ATTENDUES,
      sorted(trouvees ^ ATTENDUES))


# ===========================================================================
print("\n=== Backend : les vraies routes ===")

def monter(cgu_version):
    install_db([(SESSION, ligne_session(joueur_id=9, cgu_version=cgu_version))])
    recharger()
    for m in ('routes_auth', 'routes_comptes', 'services'):
        sys.modules.pop(m, None)
    import routes_auth, routes_comptes
    app = Flask(__name__)
    app.register_blueprint(routes_auth.auth_bp)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client()

cli = monter(None)
r = cli.get('/auth/check-session', headers=H)
check("check-session repond 200 sans consentement", r.status_code == 200, r.status_code)
check("  et dit qu'il manque", (r.get_json() or {}).get('cgu_a_accepter') is True, r.get_json())
check("/me/cgu accepte sans consentement prealable (sinon impasse)",
      cli.post('/me/cgu', headers=H).status_code == 200)
check("/auth/me est refuse (428)", cli.get('/auth/me', headers=H).status_code == 428)
check("/me/notifications est refuse (428)",
      cli.get('/me/notifications', headers=H).status_code == 428)
cli = monter('1.0')
r = cli.get('/auth/check-session', headers=H)
check("check-session : rien a accepter en version courante",
      (r.get_json() or {}).get('cgu_a_accepter') is False, r.get_json())


# ===========================================================================
print("\n=== Frontend : page d'acceptation ===")
os.environ.setdefault('SECRET_KEY', 'audit')
os.environ.setdefault('BACKEND_URL', 'http://audit.invalid')
sys.path.insert(0, os.path.abspath(os.path.join(backend, '..', 'frontEnd')))
front = importlib.import_module('frontend')
front.app.config.update(TESTING=True, WTF_CSRF_ENABLED=False)

class Rep:
    def __init__(self, status, corps=None): self.status_code, self._c = status, corps
    def json(self): return self._c

sonde = {'rep': Rep(200, {'role': 'player', 'permissions': [], 'cgu_a_accepter': True})}
front.requests = types.SimpleNamespace(get=lambda *a, **k: sonde['rep'],
                                       post=lambda *a, **k: Rep(200, {}))

def client(cgu_a_accepter):
    c = front.app.test_client()
    with c.session_transaction() as s:
        s['player_token'] = 'tok'
        s['compte'] = {'id': 42, 'role': 'player', 'permissions': [],
                       'cgu_a_accepter': cgu_a_accepter}
    return c

HTML = {'Accept': 'text/html'}
c = client(None)       # copie de session anterieure au champ : la sonde le pose
r = c.get('/classement?saison=3', headers=HTML)
check("une page HTML renvoie vers /consentement",
      r.status_code == 302 and '/consentement' in r.headers['Location'], r.headers.get('Location'))
from urllib.parse import urlparse, parse_qs
check("  en gardant la page demandee pour y revenir",
      parse_qs(urlparse(r.headers['Location']).query).get('suite') == ['/classement?saison=3'],
      r.headers.get('Location'))
with c.session_transaction() as s:
    check("  et la sonde a recopie le drapeau en session", s['compte'].get('cgu_a_accepter') is True)
    check("  sans purger la session", s.get('player_token') == 'tok')

for chemin in ('/confidentialite', '/mentions-legales', '/consentement'):
    r = client(True).get(chemin, headers=HTML)
    check("%s reste accessible avant d'accepter" % chemin, r.status_code == 200, r.status_code)

r = client(True).get('/consentement', headers=HTML)
page = r.get_data(as_text=True)
check("la page propose d'accepter, de telecharger ses donnees et de se deconnecter",
      'j&#39;accepte' in page.lower() or "j'accepte" in page.lower())
check("  les trois issues sont la",
      '/mon-compte/export' in page and '/logout' in page and 'method="post"' in page)

sonde['rep'] = Rep(428, {'code': 'cgu_a_accepter'})
check("_sonde_session ne purge pas sur 428",
      front._sonde_session('/auth/check-session', H) is False)
sonde['rep'] = Rep(200, {'role': 'player', 'permissions': [], 'cgu_a_accepter': True})

r = client(True).get('/me/notifications', headers={'Accept': 'application/json'})
check("un appel JSON n'est pas redirige vers un formulaire",
      r.status_code != 302, r.status_code)

# --- acceptation ---
appels = []
front.backend_request = lambda m, chemin, **k: (appels.append((m, chemin)) or ({}, 200))
c = client(True)
r = c.post('/consentement', data={'suite': '/classement'})
check("accepter appelle POST /me/cgu", appels == [('POST', '/me/cgu')], appels)
check("  puis ramene a la page demandee",
      r.status_code == 302 and r.headers['Location'].endswith('/classement'),
      r.headers.get('Location'))
with c.session_transaction() as s:
    check("  et leve le drapeau en session", s['compte'].get('cgu_a_accepter') is False)

front.backend_request = lambda m, chemin, **k: ({'error': 'x'}, 500)
c = client(True)
r = c.post('/consentement', data={'suite': '/classement'})
check("un echec du backend laisse sur la page, drapeau intact", r.status_code == 200, r.status_code)
with c.session_transaction() as s:
    check("  (toujours a accepter)", s['compte'].get('cgu_a_accepter') is True)

sonde['rep'] = Rep(200, {'role': 'player', 'permissions': [], 'cgu_a_accepter': False})
r = client(False).get('/consentement?suite=/classement', headers=HTML)
check("deja accepte : /consentement renvoie a la suite",
      r.status_code == 302 and r.headers['Location'].endswith('/classement'))

print("\n=== Frontend : pas de redirection ouverte ===")
with front.app.test_request_context():
    for piege in ('//evil.test', 'https://evil.test', '/\\evil.test', 'evil', '',
                  None, '/consentement?suite=//evil.test'):
        check("suite %r -> accueil" % (piege,), front._suite_sure(piege) == '/',
              front._suite_sure(piege))
    check("un chemin local est garde, parametres compris",
          front._suite_sure('/classement?saison=3') == '/classement?saison=3')

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
