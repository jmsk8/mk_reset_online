from harness import *
from flask import Flask, g

def app_avec(plan, deco_factory, casse=False):
    """Monte une appli minimale protegee par le decorateur a tester."""
    cur, conn = install_db(plan)
    if casse:
        import contextlib, types
        fake = types.ModuleType('db')
        @contextlib.contextmanager
        def boom():
            raise RuntimeError("base injoignable")
            yield
        fake.get_db_connection = boom
        fake.ADMIN_PASSWORD_HASH = b'x'
        sys.modules['db'] = fake
    recharger()
    import auth, importlib; importlib.reload(auth)
    app = Flask(__name__)
    @app.route('/protege')
    @deco_factory(auth)
    def protege():
        from flask import jsonify
        return jsonify({"role": getattr(g, 'compte', {}).get('role')})
    return app.test_client(), auth

SESSION_OK = lambda role: [
    (r"FROM sessions_joueurs s JOIN comptes c", ligne_session(joueur_id=9, role=role)),
]

print("\n=== R-44 : le rôle est relu en base à chaque requête ===")
cli, auth = app_avec(SESSION_OK('admin'), lambda a: a.role_required('admin'))
r = cli.get('/protege', headers={'X-Session-Token': 'tok'})
check("admin accepté sur une route admin", r.status_code == 200, r.status_code)

cli, auth = app_avec(SESSION_OK('player'), lambda a: a.role_required('admin'))
r = cli.get('/protege', headers={'X-Session-Token': 'tok'})
check("joueur refusé (403) sur une route admin", r.status_code == 403, r.status_code)
check("code d'erreur explicite", r.get_json().get('code') == 'droits_insuffisants')

print("\n=== Hiérarchie des rôles : superadmin satisfait admin ===")
cli, auth = app_avec(SESSION_OK('superadmin'), lambda a: a.role_required('admin'))
check("superadmin accepté sur admin", cli.get('/protege', headers={'X-Session-Token':'tok'}).status_code == 200)
cli, auth = app_avec(SESSION_OK('admin'), lambda a: a.role_required('superadmin'))
check("admin REFUSÉ sur superadmin", cli.get('/protege', headers={'X-Session-Token':'tok'}).status_code == 403)

print("\n=== R-28 : base indisponible = 503, jamais 401/403 ===")
cli, auth = app_avec([], lambda a: a.role_required('admin'), casse=True)
r = cli.get('/protege', headers={'X-Session-Token': 'tok'})
check("503 et non 403 quand la base tombe", r.status_code == 503, r.status_code)
check("le frontend ne purgera donc pas la session", r.status_code not in (401, 403))

cli, auth = app_avec([], lambda a: a.admin_required, casse=True)
r = cli.get('/protege', headers={'X-Admin-Token': 'tok'})
check("admin_required aussi : 503 et non 500", r.status_code == 503, r.status_code)

print("\n=== Sessions invalides / expirées ===")
cli, auth = app_avec([(r"FROM sessions_joueurs", None)], lambda a: a.player_required)
check("session inconnue -> 401", cli.get('/protege', headers={'X-Session-Token':'x'}).status_code == 401)

cli, auth = app_avec([(r"FROM sessions_joueurs s JOIN comptes c",
                       ligne_session(joueur_id=9, expires_at=PASSE))], lambda a: a.player_required)
r = cli.get('/protege', headers={'X-Session-Token':'x'})
check("session expirée -> 401", r.status_code == 401, r.status_code)
check("expiration absolue : aucune route ne prolonge", not hasattr(auth, 'refresh_session'))

cli, auth = app_avec(SESSION_OK('player'), lambda a: a.player_required)
check("sans en-tête -> 401", cli.get('/protege').status_code == 401)

print("\n=== Compte suspendu : 403 même avec une session valide ===")
cli, auth = app_avec([(r"FROM sessions_joueurs s JOIN comptes c",
                       ligne_session(joueur_id=9, statut='suspended', role='admin'))],
                     lambda a: a.role_required('admin'))
r = cli.get('/protege', headers={'X-Session-Token':'x'})
check("suspendu refusé malgré le rôle admin", r.status_code == 403 and r.get_json()['code'] == 'compte_suspendu', r.get_json())

print("\n=== R-43 : décorateur de transition, un OU et pas un ET ===")
cli, auth = app_avec(SESSION_OK('admin'), lambda a: a.admin_or_role_required)
check("voie Discord acceptée seule",
      cli.get('/protege', headers={'X-Session-Token':'tok'}).status_code == 200)

cli, auth = app_avec([(r"SELECT expires_at FROM api_tokens", (datetime.now() + timedelta(hours=1),))],
                     lambda a: a.admin_or_role_required)
check("voie mot de passe acceptée seule",
      cli.get('/protege', headers={'X-Admin-Token':'tok'}).status_code == 200)

cli, auth = app_avec([], lambda a: a.admin_or_role_required)
check("aucune des deux -> 401", cli.get('/protege').status_code == 401)

print("\n=== service_required (API bot) ===")
BOT = lambda scopes, exp=None, rev=None: [
    (r"FROM service_tokens", (1, 'bot-mm', scopes, exp, rev))]
cli, auth = app_avec(BOT(['read:joueurs']), lambda a: a.service_required('read:joueurs'))
check("scope présent -> 200", cli.get('/protege', headers={'Authorization':'Bearer t'}).status_code == 200)
cli, auth = app_avec(BOT(['read:joueurs']), lambda a: a.service_required('matchmaking'))
check("scope absent -> 403", cli.get('/protege', headers={'Authorization':'Bearer t'}).status_code == 403)
cli, auth = app_avec(BOT(['matchmaking'], rev=PASSE), lambda a: a.service_required('matchmaking'))
check("jeton révoqué -> 401", cli.get('/protege', headers={'Authorization':'Bearer t'}).status_code == 401)
cli, auth = app_avec(BOT(['matchmaking'], exp=PASSE), lambda a: a.service_required('matchmaking'))
check("jeton expiré -> 401", cli.get('/protege', headers={'Authorization':'Bearer t'}).status_code == 401)
cli, auth = app_avec(BOT(['matchmaking']), lambda a: a.service_required('matchmaking'))
check("sans en-tête Bearer -> 401", cli.get('/protege').status_code == 401)

print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
