"""Hierarchie a 4 roles et permissions delegables (docs/hierarchie-admin-plan.md).

Ce que ces tests couvrent : qui passe une porte et qui ne la passe pas, et quel
code sort quand la base tombe. Ce qu'ils ne couvrent PAS : l'unicite du
superadmin en base, qui repose sur un index unique partiel -- FakeCursor ne
simule aucune contrainte SQL. Cette garantie-la se verifie sur un vrai Postgres.
"""
from harness import *
from flask import Flask, g


def app_avec(plan, deco_factory, casse=False, kwargs_route=False):
    """Monte une appli minimale protegee par le decorateur a tester.

    kwargs_route : expose /protege/<compte_id> au lieu de /protege, pour les
    decorateurs qui lisent compte_id dans les kwargs Flask.
    """
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

    if kwargs_route:
        @app.route('/protege/<int:compte_id>', methods=['POST'])
        @deco_factory(auth)
        def protege(compte_id):
            from flask import jsonify
            return jsonify({"cible": compte_id})
    else:
        @app.route('/protege')
        @deco_factory(auth)
        def protege():
            from flask import jsonify
            return jsonify({"role": getattr(g, 'compte', {}).get('role')})

    return app.test_client(), auth


SESSION = lambda role: (r"FROM sessions_joueurs s JOIN comptes c",
                        ligne_session(joueur_id=9, role=role))
# La permission est cherchee par un SELECT 1 ; (1,) = accordee, None = absente.
PERM = lambda accordee: (r"FROM permissions_admin", (1,) if accordee else None)
CIBLE = lambda role: (r"SELECT role FROM comptes WHERE id", (role,))

GET = {'X-Session-Token': 'tok'}


print("\n=== permission_required : le socle chef_admin couvre tout le catalogue ===")
for role in ('chef_admin', 'superadmin'):
    # Aucune ligne permissions_admin dans le plan : s'ils la consultaient, ils
    # seraient refuses. Passer prouve qu'ils court-circuitent le catalogue.
    cli, auth = app_avec([SESSION(role)], lambda a: a.permission_required('gestion_saisons'))
    r = cli.get('/protege', headers=GET)
    check("%s passe sans ligne en base" % role, r.status_code == 200, r.status_code)

cli, auth = app_avec([SESSION('player')], lambda a: a.permission_required('gestion_saisons'))
check("player refuse", cli.get('/protege', headers=GET).status_code == 403)


print("\n=== permission_required : l'admin depend de sa ligne permissions_admin ===")
cli, auth = app_avec([SESSION('admin'), PERM(True)],
                     lambda a: a.permission_required('gestion_saisons'))
r = cli.get('/protege', headers=GET)
check("admin AVEC la permission passe", r.status_code == 200, r.status_code)

cli, auth = app_avec([SESSION('admin'), PERM(False)],
                     lambda a: a.permission_required('gestion_saisons'))
r = cli.get('/protege', headers=GET)
check("admin SANS la permission refuse", r.status_code == 403, r.status_code)
check("code 'permission_manquante'", r.get_json().get('code') == 'permission_manquante',
      r.get_json())


print("\n=== R-55 : une panne DB donne 503, jamais 403 ===")
# Le bug d'origine : _a_permission avalait l'exception et renvoyait False, ce
# que permission_required traduisait en 403 -- et le frontend purge la session
# sur 403 (R-28). Un admin qui avait le droit se serait fait ejecter.
cli, auth = app_avec([], lambda a: a.permission_required('gestion_saisons'), casse=True)
r = cli.get('/protege', headers=GET)
check("503 quand la base tombe", r.status_code == 503, r.status_code)
check("le frontend ne purgera pas la session", r.status_code not in (401, 403))


print("\n=== permission_required refuse un nom hors catalogue (a l'import) ===")
recharger()
import auth as _a, importlib; importlib.reload(_a)
try:
    _a.permission_required('gestion_inexistante')
    check("nom inconnu rejete", False, "aucune exception levee")
except ValueError:
    check("nom inconnu rejete par un ValueError", True)
except Exception as e:
    check("nom inconnu rejete par un ValueError", False, type(e).__name__)


print("\n=== permissions_delegables_par : le plafond de delegation ===")
recharger()
import auth as _a2; importlib.reload(_a2)
from constants import PERMISSIONS_CATALOGUE
for role in ('chef_admin', 'superadmin'):
    d = _a2.permissions_delegables_par({'role': role})
    check("%s delegue tout le catalogue" % role, d == PERMISSIONS_CATALOGUE, len(d))
for role in ('admin', 'player'):
    d = _a2.permissions_delegables_par({'role': role})
    check("%s ne delegue rien" % role, d == frozenset(), d)


print("\n=== refuse_auto_modification ===")
# Son retour d'erreur passe par jsonify : contexte d'application obligatoire.
with Flask(__name__).app_context():
    refus = _a2.refuse_auto_modification(42, 42)
    check("agir sur soi-meme est refuse", refus is not None)
    check("  -> 403 auto_modification",
          refus is not None and refus[1] == 403
          and refus[0].get_json().get('code') == 'auto_modification')
    check("agir sur un autre est permis", _a2.refuse_auto_modification(42, 7) is None)


print("\n=== compte_cible_protegee : le superadmin est intouchable ===")
proteger = lambda a: (lambda f: a.role_required('chef_admin')(a.compte_cible_protegee(f)))

cli, auth = app_avec([SESSION('chef_admin'), CIBLE('superadmin')],
                     proteger, kwargs_route=True)
r = cli.post('/protege/7', headers=GET)
check("chef_admin bloque sur le superadmin", r.status_code == 403, r.status_code)
check("code 'cible_protegee'", r.get_json().get('code') == 'cible_protegee', r.get_json())

cli, auth = app_avec([SESSION('chef_admin'), CIBLE('admin')], proteger, kwargs_route=True)
check("chef_admin passe sur un admin ordinaire",
      cli.post('/protege/7', headers=GET).status_code == 200)


print("\n=== R-56 : un chef_admin est intouchable par ses pairs ===")
# Deja [DECIDE] au 2 point 3, mais le sketch initial ne testait que le role
# superadmin sur la cible : un chef_admin pouvait retrograder un pair.
cli, auth = app_avec([SESSION('chef_admin'), CIBLE('chef_admin')],
                     proteger, kwargs_route=True)
r = cli.post('/protege/7', headers=GET)
check("chef_admin bloque sur un pair chef_admin", r.status_code == 403, r.status_code)

cli, auth = app_avec([SESSION('superadmin'), CIBLE('chef_admin')],
                     proteger, kwargs_route=True)
check("le superadmin, lui, agit sur un chef_admin",
      cli.post('/protege/7', headers=GET).status_code == 200)


print("\n=== compte_cible_protegee : agir sur son propre compte reste permis ===")
# La ligne de session porte compte_id=42 : la cible 42 est donc l'acteur.
cli, auth = app_avec([SESSION('chef_admin')], proteger, kwargs_route=True)
check("pas de court-circuit sur soi-meme",
      cli.post('/protege/42', headers=GET).status_code == 200)


print("\n=== compte_cible_protegee : panne DB = 503 ===")
cli, auth = app_avec([], proteger, kwargs_route=True, casse=True)
r = cli.post('/protege/7', headers=GET)
check("503 et non 403", r.status_code == 503, r.status_code)


print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
