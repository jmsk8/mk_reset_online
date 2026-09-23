"""docker-compose.dump.yml monte-t-il TOUTES les migrations ?

Ce test existe a cause d'un defaut reel (14/09) : le fichier n'en montait que
2 sur 11, fige au 02/09. Monter un dump de production donnait donc une base a
laquelle il manquait 9 migrations -- notifications, hierarchie admin, tiers
dynamiques -- et le backend tombait en 500 sur les pages concernees.

Ce mode d'echec est particulierement couteux : l'oubli ne casse rien au moment
ou on ajoute la migration. Il se manifeste plus tard, quand quelqu'un monte un
vieux dump, sur un symptome qui ne pointe pas vers ce fichier. D'ou ce test :
c'est le seul endroit ou l'oubli se voit TOT.

Aucune dependance : ni Postgres, ni Docker, ni flask. On lit les fichiers.
"""
import os
import re
import sys

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
COMPOSE = os.path.join(RACINE, 'docker-compose.dump.yml')
MIGRATIONS = os.path.join(RACINE, 'backEnd', 'migrations')
VERIF = os.path.join(RACINE, 'scripts', 'verifier-schema-dump.sql')

OK = []

# Migrations de RETOUR ARRIERE : elles defont une autre migration et ne doivent
# JAMAIS tourner sur le chemin normal. Les monter serait pire qu'un oubli --
# 2026-09-23_restore_api_tokens.sql recreerait, deux lignes plus bas, la table
# que 2026-09-23_drop_api_tokens.sql vient de supprimer, et le defaut ne se
# verrait nulle part : la base serait simplement revenue en arriere en silence.
#
# Leur seul usage est le break-glass de runbook-admin.md 3.2b, joue a la main.
# D'ou la convention de nom `_restore_`, verifiee plus bas dans les deux sens :
# non montee, et effectivement absente du compose.
INVERSES = {'2026-09-23_restore_api_tokens.sql'}


def check(nom, cond, detail=''):
    OK.append(cond)
    print(('  ✅ ' if cond else '  ❌ ') + nom + (('  -> ' + str(detail)) if not cond and detail else ''))


compose = open(COMPOSE, encoding='utf-8').read()
toutes = sorted(f for f in os.listdir(MIGRATIONS) if f.endswith('.sql'))
sur_disque = [f for f in toutes if f not in INVERSES]

# Chaque ligne « - ./backEnd/migrations/X.sql:/docker-entrypoint-initdb.d/NN_y.sql »
montages = re.findall(
    r'\./backEnd/migrations/([^:\s]+\.sql):/docker-entrypoint-initdb\.d/(\d+)_([^:\s]+\.sql)',
    compose)
montees = [m[0] for m in montages]


print("\n=== Toutes les migrations sont montees ===")

oubliees = [f for f in sur_disque if f not in montees]
check("aucune migration oubliee dans docker-compose.dump.yml",
      not oubliees,
      "manquantes : %s" % ', '.join(oubliees))

fantomes = [f for f in montees if f not in toutes]
check("aucun montage ne pointe vers un fichier absent",
      not fantomes, fantomes)

# L'inverse de l'oubli, et le plus dangereux des deux : une migration de retour
# arriere montee annulerait celle qu'elle defait, sans aucun symptome.
inverses_montees = [f for f in montees if f in INVERSES]
check("aucune migration de retour arriere n'est montee",
      not inverses_montees, inverses_montees)

# La liste INVERSES ne doit pas servir a exempter une migration ordinaire d'un
# oubli : elle ne couvre que des fichiers qui portent la convention de nom.
check("INVERSES ne contient que des migrations `_restore_`",
      all('_restore_' in f for f in INVERSES),
      [f for f in INVERSES if '_restore_' not in f])

check("chaque migration d'INVERSES existe bien sur le disque",
      all(f in toutes for f in INVERSES),
      [f for f in INVERSES if f not in toutes])

check("aucune migration montee deux fois",
      len(montees) == len(set(montees)),
      [f for f in montees if montees.count(f) > 1])

check("le compte correspond (%d migrations)" % len(sur_disque),
      len(montees) == len(sur_disque),
      "%d montees / %d sur disque" % (len(montees), len(sur_disque)))


print("\n=== L'ordre d'execution respecte les dependances ===")

# postgres execute /docker-entrypoint-initdb.d/* dans l'ordre LEXICAL, pas dans
# l'ordre du fichier YAML. Ce sont donc les prefixes qui decident.
prefixes = [m[1] for m in montages]
ordre_lexical = sorted(montages, key=lambda m: m[1] + '_' + m[2])

check("les prefixes numeriques sont uniques",
      len(prefixes) == len(set(prefixes)),
      [p for p in prefixes if prefixes.count(p) > 1])

check("tous les prefixes ont 2 chiffres (sinon 10_ passe avant 4_)",
      all(len(p) == 2 for p in prefixes),
      [p for p in prefixes if len(p) != 2])

# L'ordre lexical des prefixes doit reproduire l'ordre chronologique des noms
# de migration : c'est lui qui porte les dependances reelles.
attendu = sorted(m[0] for m in montages)
obtenu = [m[0] for m in ordre_lexical]
check("l'ordre d'execution suit l'ordre chronologique des migrations",
      obtenu == attendu,
      "obtenu %s" % obtenu)

# Dependance dure : auth_discord cree `comptes`, dont ces deux-la ont besoin.
def rang(nom_partiel):
    for i, (f, _, _) in enumerate(ordre_lexical):
        if nom_partiel in f:
            return i
    return -1

r_auth = rang('auth_discord')
check("auth_discord est monte", r_auth >= 0, None)
check("hierarchie_admin s'execute APRES auth_discord (elle a besoin de comptes)",
      r_auth >= 0 and rang('hierarchie_admin') > r_auth,
      "auth=%d hierarchie=%d" % (r_auth, rang('hierarchie_admin')))
check("liaison_creation_joueur s'execute APRES auth_discord",
      r_auth >= 0 and rang('liaison_creation_joueur') > r_auth,
      "auth=%d liaison=%d" % (r_auth, rang('liaison_creation_joueur')))

check("le dump (03_) s'execute avant toutes les migrations",
      all(int(p) > 3 for p in prefixes), prefixes)


print("\n=== Le controle final est monte et arrete l'initialisation ===")

check("verifier-schema-dump.sql est monte",
      'verifier-schema-dump.sql' in compose, None)
check("il s'execute en dernier (prefixe 99)",
      '99_verifier_schema.sql' in compose, None)

verif = open(VERIF, encoding='utf-8').read()
check("il leve une exception (sinon il n'arreterait rien)",
      'RAISE EXCEPTION' in verif, None)

# Le controle liste les tables attendues : si une migration ajoute une table
# sans l'y declarer, le garde-fou devient partiellement aveugle. On verifie au
# moins que chaque table creee par une migration y figure.
creees = set()
for f in sur_disque:  # sans les inverses : elles recreent, elles n'ajoutent pas
    contenu = open(os.path.join(MIGRATIONS, f), encoding='utf-8').read()
    for t in re.findall(r'CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+)', contenu):
        creees.add(t.lower())

# grille_snapshots est cree par une migration anterieure a la prod courante :
# il est deja present dans les dumps, donc hors du perimetre du rattrapage.
hors_perimetre = {'grille_snapshots'}
non_verifiees = sorted(t for t in creees - hors_perimetre if t not in verif)
check("toutes les tables creees par une migration sont verifiees",
      not non_verifiees,
      "absentes du controle : %s" % ', '.join(non_verifiees))


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
