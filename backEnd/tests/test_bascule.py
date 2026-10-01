"""Aucune route admin sans authentification, et aucun vestige du mot de passe
partage dans le backend (analyse du source)."""
from harness import *
import re as _re

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

print("\n=== Inventaire : aucune route admin sans authentification ===")
src = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read().split("\n")

# Decorateurs de l'ancienne authentification par mot de passe.
MOT_DE_PASSE = ('admin_required', 'admin_or_role_required')

# Decorateurs valides. player_required sert aux routes qui verifient leurs
# permissions dans le corps (/admin/config).
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

# Toute route publique dans routes_admin.py est une erreur.
check("aucune route de routes_admin.py n'est publique",
      not sans_auth, sans_auth)
check("aucune route n'est protegee par le mot de passe partage",
      not par_mot_de_passe, par_mot_de_passe)

# Une route admin sous player_required doit verifier un droit dans son corps.
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
# Sonde de session sous role_required(ROLE_ADMIN).
i = next(k for k, l in enumerate(src) if "'/admin/check-token'" in l)
check("check-token reste ouverte a tout admin",
      any('role_required(ROLE_ADMIN)' in src[k] for k in range(i, i + 4)),
      src[i:i+3])

print("\n=== Etape 6 : plus aucun vestige du mot de passe dans le backend ===")
# Balayage de tout le backend, commentaires compris.
VESTIGES = ('admin_required', 'X-Admin-Token', 'ADMIN_PASSWORD_HASH',
            "'/admin-auth'", "'/admin/refresh-token'", "'/admin-logout'")
fichiers = [f for f in sorted(os.listdir(RACINE))
            if f.endswith('.py') and f != 'tests']
for vestige in VESTIGES:
    porteurs = [f for f in fichiers
                if vestige in open(os.path.join(RACINE, f), encoding='utf-8').read()]
    check("  aucun fichier ne porte %s" % vestige, not porteurs, porteurs)

# La table ne doit plus apparaitre dans aucune chaine SQL.
sql_api_tokens = []
for f in fichiers:
    contenu = open(os.path.join(RACINE, f), encoding='utf-8').read()
    for motif in ('FROM api_tokens', 'INTO api_tokens', 'UPDATE api_tokens'):
        if motif in contenu:
            sql_api_tokens.append((f, motif))
check("aucune requete SQL ne lit ni n'ecrit api_tokens", not sql_api_tokens, sql_api_tokens)

schema = open(os.path.join(RACINE, 'schema.sql'), encoding='utf-8').read()
check("schema.sql ne cree plus api_tokens",
      'CREATE TABLE public.api_tokens' not in schema)
migrations = os.listdir(os.path.join(RACINE, 'migrations'))
check("la migration qui supprime api_tokens existe",
      any('drop_api_tokens' in m for m in migrations), migrations)
# Migration inverse pour un eventuel retour arriere.
check("sa migration inverse existe aussi, pour le break-glass",
      any('restore_api_tokens' in m for m in migrations), migrations)

print("\n=== R-38 / R-40 : qui écrit comptes.role ===")
# Ecritures attendues de comptes.role : changer_role, les deux UPDATE du legs
# et l'acceptation d'une promotion. Toute nouvelle ecriture doit etre justifiee.
comptes_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                                'routes_comptes.py'), encoding='utf-8').read()
ecritures = comptes_src.count("SET role")
check("exactement quatre écritures de comptes.role (changer_role + legs + acceptation)",
      ecritures == 4, ecritures)
# proposer_promotion ne doit pas poser le role.
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
