"""docker-compose.dump.yml doit monter toutes les migrations, dans l'ordre."""
import os
import re
import sys

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
COMPOSE = os.path.join(RACINE, 'docker-compose.dump.yml')
MIGRATIONS = os.path.join(RACINE, 'backEnd', 'migrations')
VERIF = os.path.join(RACINE, 'scripts', 'verifier-schema-dump.sql')

OK = []

# Migrations de retour arriere (`_restore_`) : jamais montees.
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

# Une migration de retour arriere montee annulerait celle qu'elle defait.
inverses_montees = [f for f in montees if f in INVERSES]
check("aucune migration de retour arriere n'est montee",
      not inverses_montees, inverses_montees)

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

# Postgres execute initdb.d dans l'ordre lexical : les prefixes decident.
prefixes = [m[1] for m in montages]
ordre_lexical = sorted(montages, key=lambda m: m[1] + '_' + m[2])

check("les prefixes numeriques sont uniques",
      len(prefixes) == len(set(prefixes)),
      [p for p in prefixes if prefixes.count(p) > 1])

check("tous les prefixes ont 2 chiffres (sinon 10_ passe avant 4_)",
      all(len(p) == 2 for p in prefixes),
      [p for p in prefixes if len(p) != 2])

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

# Chaque table creee par une migration doit figurer dans le controle.
creees = set()
for f in sur_disque:  # sans les migrations inverses
    contenu = open(os.path.join(MIGRATIONS, f), encoding='utf-8').read()
    for t in re.findall(r'CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+)', contenu):
        creees.add(t.lower())

# Deja presente dans les dumps.
hors_perimetre = {'grille_snapshots'}
non_verifiees = sorted(t for t in creees - hors_perimetre if t not in verif)
check("toutes les tables creees par une migration sont verifiees",
      not non_verifiees,
      "absentes du controle : %s" % ', '.join(non_verifiees))


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
