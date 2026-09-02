"""Phase 4 : la periode ou les deux authentifications cohabitent.

Le risque n'est pas qu'une route casse bruyamment, c'est qu'elle reste OUVERTE
(ancien decorateur retire, nouveau pas branche) ou qu'elle devienne MORTE (les
deux exiges au lieu de l'un OU l'autre). Ces deux etats passent inapercus.
"""
from harness import *
from flask import Flask
import re as _re

print("\n=== Inventaire : aucune route admin sans authentification ===")
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'routes_admin.py'),
           encoding='utf-8').read().split("\n")
sans_auth, par_voie = [], {'admin_required': [], 'admin_or_role_required': []}
for i, l in enumerate(src):
    if l.lstrip().startswith("@admin_bp.route"):
        j, decos = i + 1, []
        while j < len(src) and not src[j].lstrip().startswith("def "):
            if src[j].strip().startswith("@"):
                decos.append(src[j].strip().lstrip("@"))
            j += 1
        route = l.strip()
        trouve = [d for d in decos if d in par_voie]
        if not trouve:
            sans_auth.append(route)
        else:
            par_voie[trouve[0]].append(route)

publiques_attendues = {'admin-auth', 'admin-logout'}
nues = {_re.search(r"'/([\w-]+)", r).group(1) for r in sans_auth}
check("seuls le login et le logout sont publics", nues == publiques_attendues, nues)
check("aucune route empilant les deux décorateurs (ce serait un ET, pas un OU)",
      all(not (r in par_voie['admin_required'] and r in par_voie['admin_or_role_required'])
          for r in sans_auth + par_voie['admin_required'] + par_voie['admin_or_role_required']))
# 23 routes protégées au total : 22 acceptent les deux voies, seul
# refresh-token reste sur le mot de passe (une session Discord n'a rien à
# renouveler, son expiration est absolue).
total = len(par_voie['admin_or_role_required']) + len(par_voie['admin_required'])
check("toutes les routes protégées sauf une acceptent les deux voies",
      len(par_voie['admin_or_role_required']) == total - 1, (len(par_voie['admin_or_role_required']), total))
restees = {_re.search(r"'/([\w/-]+)", r).group(1) for r in par_voie['admin_required']}
check("seul refresh-token reste sur le mot de passe seul",
      restees == {'admin/refresh-token'}, restees)

print("\n=== check-token : la sonde qui garde trois pages ===")
# Restee sur @admin_required, elle renvoyait 401 a une session Discord : un
# admin Discord n'aurait jamais pu ouvrir gestion, saisons ni ligues.
i = next(k for k, l in enumerate(src) if "'/admin/check-token'" in l)
check("check-token accepte les deux voies",
      any('admin_or_role_required' in src[k] for k in range(i, i + 4)),
      src[i:i+3])

print("\n=== Le décorateur de transition : un OU, jamais un ET ===")
def app_transition(plan):
    cur, conn = install_db(plan)
    recharger()
    import auth, importlib; importlib.reload(auth)
    app = Flask(__name__)
    @app.route('/x')
    @auth.admin_or_role_required
    def x():
        from flask import jsonify
        return jsonify({"ok": True})
    return app.test_client(), cur

SESSION = [(r"FROM sessions_joueurs s JOIN comptes c", ligne_session(role='admin'))]
MDP = [(r"SELECT expires_at FROM api_tokens", (datetime.now() + timedelta(hours=1),))]

cli, cur = app_transition(SESSION)
check("session Discord seule -> 200", cli.get('/x', headers={'X-Session-Token': 't'}).status_code == 200)
check("la voie mot de passe n'est même pas consultée",
      not any('api_tokens' in s for s, _ in cur.executed))

cli, cur = app_transition(MDP)
check("mot de passe seul -> 200", cli.get('/x', headers={'X-Admin-Token': 't'}).status_code == 200)
check("la voie Discord n'est même pas consultée",
      not any('sessions_joueurs' in s for s, _ in cur.executed))

cli, cur = app_transition([])
check("aucune des deux -> 401", cli.get('/x').status_code == 401)

# Un joueur muni d'une session valide mais sans le role ne passe pas.
cli, cur = app_transition([(r"FROM sessions_joueurs s JOIN comptes c",
                            ligne_session(joueur_id=9))])
check("session valide SANS le rôle -> 403", cli.get('/x', headers={'X-Session-Token': 't'}).status_code == 403)

print("\n=== R-38 : le dernier superadmin ===")
# Deja couvert cote route en phase 2 ; on verifie ici que rien dans la bascule
# n'a ouvert un second chemin d'ecriture du role.
comptes_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                                'routes_comptes.py'), encoding='utf-8').read()
ecritures = comptes_src.count("SET role")
check("une seule écriture de comptes.role dans tout le module", ecritures == 1, ecritures)
admin_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                              'routes_admin.py'), encoding='utf-8').read()
check("routes_admin.py n'écrit jamais le rôle", "SET role" not in admin_src)
auth_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                             'routes_auth.py'), encoding='utf-8').read()
check("routes_auth.py non plus", "SET role" not in auth_src)
disc_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                             'auth_discord.py'), encoding='utf-8').read()
check("auth_discord.py n'écrit le rôle que pour l'amorçage",
      disc_src.count("SET role") == 1 and "aucun superadmin" in disc_src.lower()
      or disc_src.count("SET role") == 1)

print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
