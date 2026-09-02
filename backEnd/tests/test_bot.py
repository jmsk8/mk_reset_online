"""API de service : ce qui sort, ce qui n'en sort pas, et qui peut appeler."""
from harness import *
from flask import Flask

def monter(plan, scopes=('read:joueurs', 'read:classement', 'matchmaking')):
    plan = list(plan) + [(r"FROM service_tokens", (1, 'bot-test', list(scopes), None, None))]
    cur, conn = install_db(plan)
    recharger()
    for m in ('routes_bot', 'routes_comptes', 'services'):
        sys.modules.pop(m, None)
    import routes_bot
    app = Flask(__name__)
    app.register_blueprint(routes_bot.bot_bp)
    return app.test_client(), cur, routes_bot

BEARER = {'Authorization': 'Bearer jeton'}

print("\n=== Portées : un jeton ne peut pas tout faire ===")
cli, cur, _ = monter([], scopes=('read:joueurs',))
check("scope manquant -> 403",
      cli.post('/api/bot/matchmaking', json={'noms': ['a', 'b']}, headers=BEARER).status_code == 403)
cli, cur, _ = monter([], scopes=('read:joueurs',))
check("classement refusé sans read:classement",
      cli.get('/api/bot/classement', headers=BEARER).status_code == 403)
cli, cur, _ = monter([])
check("sans en-tête Bearer -> 401", cli.get('/api/bot/joueurs').status_code == 401)

print("\n=== Ce que l'API ne doit jamais publier ===")
cli, cur, _ = monter([])
cli.get('/api/bot/joueurs', headers=BEARER)
sql = ' '.join(s for s, _ in cur.executed if 'FROM Joueurs' in s)
check("le rôle n'est pas sélectionné", 'c.role' not in sql and ' role' not in sql, sql[:200])
check("la bio n'est pas sélectionnée", 'bio' not in sql)
check("seuls les comptes 'linked' sont joints", "statut = 'linked'" in sql, sql[:200])
check("les joueurs anonymisés sont exclus", 'anonymise_at IS NULL' in sql)

cli, cur, _ = monter([])
cli.get('/api/bot/classement', headers=BEARER)
sql = ' '.join(s for s, _ in cur.executed if 'FROM Joueurs' in s)
check("le classement n'expose aucun identifiant Discord", 'discord' not in sql.lower(), sql[:200])

print("\n=== Lecture seule ===")
import glob
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'routes_bot.py'),
           encoding='utf-8').read().lower()
for mot in ('update ', 'insert into', 'delete from'):
    check("aucun « %s » dans routes_bot.py" % mot.strip(), mot not in src)

print("\n=== Résolution Discord ===")
cli, cur, _ = monter([(r"FROM comptes c JOIN Joueurs j", None)])
r = cli.get('/api/bot/joueur/by-discord/123456789012345678', headers=BEARER)
check("compte inconnu -> 404", r.status_code == 404 and r.get_json()['code'] == 'non_lie')

cli, cur, _ = monter([(r"FROM comptes c JOIN Joueurs j", (9, 'Mario', 52.917, 'A', True))])
r = cli.get('/api/bot/joueur/by-discord/123456789012345678', headers=BEARER)
d = r.get_json()
check("compte lié -> 200", r.status_code == 200, d)
check("le snowflake reste une CHAÎNE (dépasse 2^53)",
      isinstance(d['discord_id'], str), type(d['discord_id']).__name__)
check("le rôle n'est pas dans la réponse", 'role' not in d and 'statut' not in d, d)

print("\n=== Matchmaking : les scores viennent de la base ===")
JOUEURS = [(1, 'A', 90.0, '111'), (2, 'B', 80.0, '222'), (3, 'C', 70.0, '333')]
cli, cur, rb = monter([(r"FROM Joueurs j LEFT JOIN comptes c", None)])
# On force le retour du curseur pour la résolution.
cur.plan = [(r"FROM service_tokens", (1, 'bot', ['matchmaking'], None, None)),
            (r"FROM Joueurs j\s+LEFT JOIN comptes c", None)]
class _C(type(cur)):
    pass
cur.fetchall = lambda: JOUEURS
r = cli.post('/api/bot/matchmaking', json={'noms': ['A', 'B', 'C']}, headers=BEARER)
d = r.get_json()
check("composition -> 200", r.status_code == 200, d)
check("un seul lobby pour 3 joueurs", len(d['lobbies']) == 1, d)
check("moyenne calculée par le serveur", d['lobbies'][0]['moyenne'] == 80.0, d['lobbies'][0])
# Un appelant qui fournirait ses propres scores pourrait composer les lobbies
# à sa guise : on vérifie qu'un champ « ts » glissé dans le corps est ignoré.
cli, cur, _ = monter([])
cur.fetchall = lambda: JOUEURS
r2 = cli.post('/api/bot/matchmaking',
              json={'noms': ['A', 'B', 'C'], 'ts': {'A': 9999}, 'scores': [1, 2, 3]},
              headers=BEARER)
check("un score fourni par l'appelant est ignoré",
      r2.status_code == 200 and r2.get_json()['lobbies'][0]['moyenne'] == 80.0,
      r2.get_json())
check("les scores renvoyés sont ceux de la base",
      sorted(p['ts'] for p in r2.get_json()['lobbies'][0]['joueurs']) == [70.0, 80.0, 90.0],
      r2.get_json()['lobbies'][0]['joueurs'])

print("\n=== Entrées invalides ===")
for corps, libelle in [
    ({}, "aucune liste"),
    ({'noms': ['a'], 'joueur_ids': [1]}, "deux listes à la fois"),
    ({'noms': 'abc'}, "pas une liste"),
    ({'noms': ['x'] * 500}, "trop de joueurs"),
]:
    cli, cur, _ = monter([])
    r = cli.post('/api/bot/matchmaking', json=corps, headers=BEARER)
    check("refusé : %s" % libelle, r.status_code == 400, r.status_code)

cli, cur, _ = monter([])
cur.fetchall = lambda: [(1, 'A', 90.0, None)]
r = cli.post('/api/bot/matchmaking', json={'noms': ['A', 'Inconnu']}, headers=BEARER)
check("moins de 2 joueurs connus -> 400", r.status_code == 400, r.get_json())
check("les introuvables sont nommés, pas tus",
      'Inconnu' in r.get_json().get('introuvables', []), r.get_json())

print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
