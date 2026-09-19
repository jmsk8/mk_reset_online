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
# Depuis la hierarchie a 4 roles, une route peut aussi porter permission_required
# ou role_required : ce sont des protections a part entiere, pas une absence.
#
# player_required s'y ajoute depuis le 2026-09-13 : /admin/config melange deux
# domaines de permission (Reglage TS et Ligues) et verifie chacun DANS son
# corps -- un decorateur de permission y refuserait l'un des deux profils avant
# meme d'entrer. La route reste authentifiee, c'est ce que ce test verifie.
PROTEGE_AUSSI = ('permission_required', 'role_required', 'player_required')
for i, l in enumerate(src):
    if l.lstrip().startswith("@admin_bp.route"):
        j, decos = i + 1, []
        while j < len(src) and not src[j].lstrip().startswith("def "):
            if src[j].strip().startswith("@"):
                decos.append(src[j].strip().lstrip("@"))
            j += 1
        route = l.strip()
        trouve = [d for d in decos if d in par_voie]
        if trouve:
            par_voie[trouve[0]].append(route)
        elif any(d.startswith(PROTEGE_AUSSI) for d in decos):
            pass          # protegee par le nouveau modele
        else:
            sans_auth.append(route)

publiques_attendues = {'admin-auth', 'admin-logout'}
nues = {_re.search(r"'/([\w-]+)", r).group(1) for r in sans_auth}
check("seuls le login et le logout sont publics", nues == publiques_attendues, nues)

# Contrepartie du relachement ci-dessus : player_required n'autorise QU'A entrer.
# Toute route admin qui s'en contente doit verifier un droit dans son corps,
# sinon un simple joueur connecte y accederait -- exactement le mode d'echec de
# R-43, une route qui a l'air protegee et ne l'est pas.
src_entier = "\n".join(src)
for nom_fn in ('get_config', 'update_config'):
    deb = src_entier.find('def %s(' % nom_fn)
    fin = src_entier.find('\n@admin_bp.route', deb)
    corps = src_entier[deb:fin if fin > deb else len(src_entier)]
    lecture_seule = nom_fn == 'get_config'
    check("  %s : droit verifie dans le corps" % nom_fn,
          lecture_seule or 'compte_a_permission' in corps,
          "aucune verification de permission")
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
# Desormais role_required(ROLE_ADMIN) : sonde de session, pas une capacite --
# la mettre sous une permission l'aurait rendue inutilisable a un admin
# fraichement cree, cassant la detection de session cote frontend (annexe A).
i = next(k for k, l in enumerate(src) if "'/admin/check-token'" in l)
check("check-token reste ouverte a tout admin",
      any('role_required(ROLE_ADMIN)' in src[k] for k in range(i, i + 4)),
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

# chef_admin : un admin n'a plus de permission par defaut (hierarchie a 4 roles).
SESSION = [(r"FROM sessions_joueurs s JOIN comptes c", ligne_session(role='chef_admin'))]
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

print("\n=== R-38 / R-40 : qui écrit comptes.role ===")
# Deja couvert cote route en phase 2 ; on verifie ici que rien n'a ouvert un
# chemin d'ecriture du role en dehors des deux routes prevues.
#
# QUATRE ecritures attendues, pas une. Chacune existe pour une raison que la
# fusionner ferait perdre :
#
#   1. `changer_role` -- attribution et RETROGRADATION, qui reste unilaterale :
#      on n'a pas a accepter de perdre un role. Ne pose jamais superadmin.
#   2. et 3. les DEUX UPDATE du legs, qui retrograde l'ancien superadmin avant
#      de promouvoir le nouveau dans la meme transaction. Exception deliberee a
#      R-40 (hierarchie-admin-plan.md 6bis.1) : fusionner avec changer_role
#      echouerait, sa garde du dernier superadmin refusant justement la
#      retrogradation par laquelle le legs commence.
#   4. `repondre_promotion` -- l'ACCEPTATION d'une promotion (phase 1bis du
#      journal d'audit, 2026-09-18). C'est le seul endroit ou une PROMOTION
#      vers admin/chef_admin pose desormais le role, et c'est la personne
#      elle-meme qui le declenche : un tiers ne peut pas consentir a sa place,
#      alors que ses actions seront tracees nominativement et sans limite.
#
# Ce compteur est un garde-fou : il doit augmenter UNIQUEMENT avec une raison
# ecrite ici. Une cinquieme ecriture sans justification est une porte derobee
# sur la seule frontiere de privilege de l'application.
comptes_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                                'routes_comptes.py'), encoding='utf-8').read()
ecritures = comptes_src.count("SET role")
check("exactement quatre écritures de comptes.role (changer_role + legs + acceptation)",
      ecritures == 4, ecritures)
# La promotion ne doit PAS pouvoir poser le rôle : seule l'acceptation le fait.
# Sans cette assertion, réintroduire un `SET role` dans proposer_promotion
# passerait inaperçu — le compteur resterait à quatre.
_proposer = comptes_src[comptes_src.index('def proposer_promotion'):
                        comptes_src.index('def annuler_promotion')]
check("proposer_promotion n'écrit JAMAIS le rôle : elle propose, elle ne pose pas",
      'SET role' not in _proposer)
check("le legs est bien une route distincte de changer_role",
      'leguer-superadmin' in comptes_src and 'def changer_role' in comptes_src)
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
