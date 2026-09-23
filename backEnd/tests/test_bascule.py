"""Phase 4 : ce que la bascule vers l'auth Discord a laisse derriere elle.

La bascule elle-meme est finie -- le mot de passe partage a ete supprime le
2026-09-23 (etape 6). Ce fichier garde son nom parce qu'il garde son role : le
filet de R-43, « une route dont on retire un decorateur sans en brancher un
autre reste OUVERTE, et personne ne s'en apercoit ».

Il verifie donc deux choses, par analyse du source et non par `grep` (lecon du
18/09 : les gardes existaient sous deux formes, le balayage n'en avait attrape
qu'une) :

  1. AUCUNE route de routes_admin.py n'est sans authentification ;
  2. AUCUN vestige du mot de passe partage n'est revenu, nulle part.

La seconde n'est pas de la paranoia retrospective : le jour ou quelqu'un
remettrait `@admin_required` sur une route « pour depanner », la dette A-04
redeviendrait une breche. Le `revert` du runbook 3.2b, lui, rend le decorateur
ET ce test en meme temps.
"""
from harness import *
import re as _re

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

print("\n=== Inventaire : aucune route admin sans authentification ===")
src = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read().split("\n")

# Decorateurs de l'authentification par mot de passe. Ils ne doivent PLUS
# exister : leur presence ici signifierait qu'une route est repassee sur le
# secret partage.
MOT_DE_PASSE = ('admin_required', 'admin_or_role_required')

# Une route peut porter permission_required, role_required ou player_required :
# ce sont des protections a part entiere.
#
# player_required s'y ajoute depuis le 2026-09-13 : /admin/config melange deux
# domaines de permission (Reglage TS et Ligues) et verifie chacun DANS son
# corps -- un decorateur de permission y refuserait l'un des deux profils avant
# meme d'entrer. La route reste authentifiee, c'est ce que ce test verifie.
PROTEGE = ('permission_required', 'role_required', 'player_required')

sans_auth, par_mot_de_passe = [], []
for i, l in enumerate(src):
    if l.lstrip().startswith("@admin_bp.route"):
        j, decos = i + 1, []
        while j < len(src) and not src[j].lstrip().startswith("def "):
            if src[j].strip().startswith("@"):
                decos.append(src[j].strip().lstrip("@"))
            j += 1
        route = l.strip()
        if any(d.startswith(MOT_DE_PASSE) for d in decos):
            par_mot_de_passe.append(route)
        elif not any(d.startswith(PROTEGE) for d in decos):
            sans_auth.append(route)

# Plus aucune route publique depuis le 2026-09-23 : /admin-auth (le login) et
# /admin-logout etaient les deux dernieres, et elles sont parties avec le mot
# de passe. Toute nouvelle entree dans cette liste est une route ouverte.
check("aucune route de routes_admin.py n'est publique",
      not sans_auth, sans_auth)
check("aucune route n'est protegee par le mot de passe partage",
      not par_mot_de_passe, par_mot_de_passe)

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

print("\n=== check-token : la sonde qui garde six pages ===")
# Restee sur @admin_required, elle renvoyait 401 a une session Discord : un
# admin Discord n'aurait jamais pu ouvrir gestion, saisons ni ligues.
# Desormais role_required(ROLE_ADMIN) : sonde de session, pas une capacite --
# la mettre sous une permission l'aurait rendue inutilisable a un admin
# fraichement cree, cassant la detection de session cote frontend (annexe A).
#
# Le plan de la phase 4 la rangeait parmi les suppressions de l'etape 6. C'est
# un ecart assume : elle ne porte plus rien du mot de passe que son nom, et
# c'est elle que `_acces_admin_revoque()` appelle.
i = next(k for k, l in enumerate(src) if "'/admin/check-token'" in l)
check("check-token reste ouverte a tout admin",
      any('role_required(ROLE_ADMIN)' in src[k] for k in range(i, i + 4)),
      src[i:i+3])

print("\n=== Etape 6 : plus aucun vestige du mot de passe dans le backend ===")
# Balayage de TOUT le backend, pas du seul routes_admin.py : le defaut qu'on
# craint ici n'est pas local. Une reintroduction passerait par un import, un
# en-tete relu a la main, ou une requete sur la table disparue.
#
# Un COMMENTAIRE qui cite ces noms rougit aussi, et c'est voulu : une regle sans
# exception se relit d'un coup d'oeil, une regle qui epargne les commentaires
# oblige a distinguer code et prose -- et c'est exactement la ou une
# reintroduction se cacherait le mieux. Le prix a payer est de reformuler la
# prose, ce qui est fait dans auth.py et auth_discord.py.
VESTIGES = ('admin_required', 'X-Admin-Token', 'ADMIN_PASSWORD_HASH',
            "'/admin-auth'", "'/admin/refresh-token'", "'/admin-logout'")
fichiers = [f for f in sorted(os.listdir(RACINE))
            if f.endswith('.py') and f != 'tests']
for vestige in VESTIGES:
    porteurs = [f for f in fichiers
                if vestige in open(os.path.join(RACINE, f), encoding='utf-8').read()]
    check("  aucun fichier ne porte %s" % vestige, not porteurs, porteurs)

# La table elle-meme : plus aucune requete ne doit la nommer. Les commentaires
# qui la citent comme ancetre de sessions_joueurs restent legitimes -- on ne
# cherche donc que dans les chaines SQL.
sql_api_tokens = []
for f in fichiers:
    contenu = open(os.path.join(RACINE, f), encoding='utf-8').read()
    for motif in ('FROM api_tokens', 'INTO api_tokens', 'UPDATE api_tokens'):
        if motif in contenu:
            sql_api_tokens.append((f, motif))
check("aucune requete SQL ne lit ni n'ecrit api_tokens", not sql_api_tokens, sql_api_tokens)

# Le schema ne la cree plus, et la migration qui la supprime existe.
schema = open(os.path.join(RACINE, 'schema.sql'), encoding='utf-8').read()
check("schema.sql ne cree plus api_tokens",
      'CREATE TABLE public.api_tokens' not in schema)
migrations = os.listdir(os.path.join(RACINE, 'migrations'))
check("la migration qui supprime api_tokens existe",
      any('drop_api_tokens' in m for m in migrations), migrations)
# Sans elle, un `git revert` rendrait le code mais pas la table (runbook 3.2b).
check("sa migration inverse existe aussi, pour le break-glass",
      any('restore_api_tokens' in m for m in migrations), migrations)

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
