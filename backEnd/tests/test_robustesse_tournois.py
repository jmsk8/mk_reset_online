"""Robustesse de l'ajout, l'annulation et la suppression de tournoi, et du
reset global : validation prealable, verrou commun, doublons, absences par
session."""
from harness import *
from flask import Flask

H = {'X-Session-Token': 'tok'}
SESSION = (r"FROM sessions_joueurs s JOIN comptes c",
           ligne_session(compte_id=1, discord_id='111', username='a',
                         global_name='A', role='chef_admin'))
VERROU = 'SELECT pg_advisory_xact_lock(%s)'


class _Rating:
    def __init__(self, mu=25.0, sigma=8.333):
        self.mu, self.sigma = float(mu), float(sigma)


APPELS_RATE = []


class _Env:
    """Comme TrueSkill : un seul groupe leve ValueError."""
    def __init__(self, **kw):
        pass

    def rate(self, groupes, ranks=None):
        APPELS_RATE.append(len(groupes))
        if len(groupes) < 2:
            raise ValueError('need multiple rating groups')
        return [[_Rating(g[0].mu + 1, g[0].sigma - 0.1)] for g in groupes]


def monter(plan):
    cur, conn = install_db(list(plan) + [SESSION])
    recharger()
    ts = sys.modules['trueskill']
    ts.Rating, ts.TrueSkill = _Rating, _Env
    for m in ('routes_admin', 'cache', 'services'):
        sys.modules.pop(m, None)

    lots = []

    def execute_values(c, sql, argslist, *a, **kw):
        lots.append((' '.join(sql.split()), list(argslist)))
        c.execute(sql, None)

    sys.modules['psycopg2'].extras.execute_values = execute_values

    import cache
    cache.invalidate_cache = lambda: None
    import services
    services.recalculate_tiers = lambda: None
    import routes_admin
    routes_admin.recalculate_tiers = lambda: None
    app = Flask(__name__)
    app.register_blueprint(routes_admin.admin_bp)
    return app.test_client(), cur, conn, lots


sql_de = lambda cur: [s for s, _ in cur.executed]


def lot(lots, fragment):
    for sql, args in lots:
        if fragment in sql:
            return args
    return None


def plan_ajout(doublon=None, autre_tournoi_session=None, absents=(), ghost=False):
    return [
        (r"FROM global_resets WHERE date >=", (0,)),
        (r"key = 'league_mode_enabled'", ('false',)),
        (r"FROM grille_snapshots WHERE date", None),
        (r"INSERT INTO sessions_tournois DEFAULT VALUES", (501,)),
        (r"INSERT INTO Tournois", (777,)),
        (r"SELECT id, nom, mu, sigma FROM Joueurs WHERE lower\(nom\)",
         lambda p: (10 + sum(map(ord, p[0])), p[0], 25.0, 8.333)),
        (r"FROM Tournois t WHERE t.date = %s AND t.id <> %s", doublon),
        (r"FROM Tournois WHERE session_id = %s AND id <> %s", autre_tournoi_session),
        (r"key = 'tau'", ('0.08',)),
        (r"key IN \('ghost_enabled'", [
            ('ghost_enabled', 'true' if ghost else 'false'), ('ghost_penalty', '0.5'),
            ('ghost_threshold_sessions', '1'), ('ghost_interval_sessions', '1'),
            ('unranked_threshold', '10')]),
        (r"SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs", list(absents)),
        (r"SELECT DISTINCT ON \(p.joueur_id\)", []),
        (r"SELECT DISTINCT p.joueur_id FROM Participations p", []),
    ]


def ajouter(joueurs, **kw):
    corps = kw.pop('corps', None)
    cli, cur, conn, lots = monter(plan_ajout(**kw))
    if corps is None:
        corps = {'date': '2026-09-15', 'joueurs': joueurs}
    return cli.post('/add-tournament', headers=H, json=corps), cur, conn, lots


A_B = [{'nom': 'A', 'score': 100}, {'nom': 'B', 'score': 80}]


# ===========================================================================
print("\n=== 1. La saisie est verifiee avant toute ecriture ===")
# ===========================================================================

for titre, joueurs in (
        ("un seul joueur", [{'nom': 'A', 'score': 1}]),
        ("aucune liste", None),
        ("score en chaine (« 12 » trie apres « 9 »)", [{'nom': 'A', 'score': '12'},
                                                       {'nom': 'B', 'score': '9'}]),
        ("score decimal", [{'nom': 'A', 'score': 12.5}, {'nom': 'B', 'score': 9}]),
        ("score booleen", [{'nom': 'A', 'score': True}, {'nom': 'B', 'score': 9}]),
        ("score hors borne (depasse la colonne integer)",
         [{'nom': 'A', 'score': 10 ** 12}, {'nom': 'B', 'score': 9}]),
        ("ligne sans nom", [{'score': 12}, {'nom': 'B', 'score': 9}]),
        ("nom vide", [{'nom': '  ', 'score': 12}, {'nom': 'B', 'score': 9}]),
        ("hors TrueSkill non booleen", [{'nom': 'A', 'score': 12, 'exclude_from_ts': 'oui'},
                                        {'nom': 'B', 'score': 9}]),
):
    r, cur, conn, lots = ajouter(joueurs)
    check("%s -> 400, rien d'ecrit" % titre,
          r.status_code == 400 and not any('INSERT' in s for s in sql_de(cur)),
          (r.status_code, r.get_json()))

r, cur, conn, lots = ajouter(None, corps={'date': '2026-09-15', 'joueurs': A_B,
                                          'ligue_id': 'abc'})
check("ligue_id non numerique -> 400", r.status_code == 400, r.get_json())

cli, cur, conn, lots = monter(plan_ajout())
r = cli.post('/add-tournament', headers=H, data='pas du json',
             content_type='application/json')
check("corps illisible -> 400 et pas 500", r.status_code == 400, r.status_code)


# ===========================================================================
print("\n=== 2. Un seul verrou pour tous les gestes qui ecrivent le dossier ===")
# ===========================================================================

r, cur, conn, lots = ajouter(A_B)
check("ajout : 201", r.status_code == 201, r.get_json())
check("ajout : le verrou est la PREMIERE requete apres l'authentification",
      bool(sql_de(cur)) and VERROU in sql_de(cur)
      and not any('Tournois' in s or 'global_resets' in s
                  for s in sql_de(cur)[:sql_de(cur).index(VERROU)]),
      sql_de(cur)[:6])

for route, corps, plan in (
        ('/api/admin/revert-last-tournament', None, []),
        ('/delete-tournament/5', None, []),
        ('/admin/tournois/5/lier-session', {'autre_tournoi_id': 6}, []),
        ('/api/admin/global-reset', {'value': 0.3, 'max_sigma': 2.0, 'date': '2026-09-01'}, []),
        ('/api/admin/revert-global-reset', None, []),
):
    cli, cur, conn, lots = monter(plan)
    methode = cli.delete if route.startswith('/delete') else cli.post
    methode(route, headers=H, json=corps)
    check("%s prend le verrou" % route, VERROU in sql_de(cur), sql_de(cur)[:4])

import services
check("le verrou est transactionnel (libere au commit comme au rollback)",
      'pg_advisory_xact_lock' in open(services.__file__).read())


# ===========================================================================
print("\n=== 3. Un tournoi envoye deux fois est refuse ===")
# ===========================================================================

r, cur, conn, lots = ajouter(A_B, doublon=(412,))
check("doublon -> 409 tournoi_en_double",
      r.status_code == 409 and r.get_json().get('code') == 'tournoi_en_double'
      and r.get_json().get('tournoi_id') == 412, r.get_json())
# L'authentification commite deja : on verifie le rollback.
check("  la transaction est annulee", conn.rolledback)
check("  aucun mu/sigma n'est ecrit", lot(lots, 'UPDATE Joueurs') is None, lots)

r, cur, conn, lots = ajouter(A_B, doublon=None)
check("sans doublon : 201", r.status_code == 201, r.get_json())


# ===========================================================================
print("\n=== 4. Moins de deux joueurs dans TrueSkill : pas de 500 ===")
# ===========================================================================

APPELS_RATE.clear()
r, cur, conn, lots = ajouter([{'nom': 'A', 'score': 100},
                              {'nom': 'B', 'score': 80, 'exclude_from_ts': True}])
check("un seul joueur compte -> 201", r.status_code == 201, r.get_json())
check("  TrueSkill n'est pas appele sur un groupe unique", APPELS_RATE == [], APPELS_RATE)
maj = dict((jid, (mu, sig)) for jid, mu, sig, *_ in (lot(lots, 'UPDATE Joueurs AS j SET mu') or []))
check("  personne ne bouge (mu 25, sigma 8.333)",
      bool(maj) and all(v == (25.0, 8.333) for v in maj.values()), maj)

APPELS_RATE.clear()
r, cur, conn, lots = ajouter(A_B)
check("deux joueurs comptes : TrueSkill tourne normalement", APPELS_RATE == [2], APPELS_RATE)


# ===========================================================================
print("\n=== 5. Une absence par SESSION, pas par tournoi ===")
# ===========================================================================
# Joueur 20 : absent, 3 sessions manquees, sigma 2.0 ; +0.5 par absence comptee.
ABSENT = [(20, 2.0, 3, True)]

r, cur, conn, lots = ajouter(A_B, absents=ABSENT, ghost=True, autre_tournoi_session=None)
absences = {a[0]: a for a in (lot(lots, 'SET sigma = data.sigma, consecutive_missed') or [])}
check("premier tournoi de la session : l'absent prend +1 (3 -> 4)",
      absences.get(20, (0, 0, 0))[2] == 4, absences)
check("  et la penalite de sigma", lot(lots, 'INSERT INTO ghost_log') is not None, lots)

r, cur, conn, lots = ajouter(A_B, absents=ABSENT, ghost=True, autre_tournoi_session=(1,))
absences = {a[0]: a for a in (lot(lots, 'SET sigma = data.sigma, consecutive_missed') or [])}
check("lobby lie a une session deja comptee : l'absent reste a 3",
      absences.get(20, (0, 0, 0))[2] == 3, absences)
check("  sans seconde penalite de sigma", lot(lots, 'INSERT INTO ghost_log') is None, lots)
check("  sigma inchange (2.0)", absences.get(20, (0, 0))[1] == 2.0, absences)


# ===========================================================================
print("\n=== 6. Annuler le dernier tournoi ===")
# ===========================================================================

def annuler(reset_posterieur=False, autre_tournoi_session=None):
    cli, cur, conn, lots = monter([
        (r"FROM Tournois ORDER BY id DESC", (77, '2026-09-01', 501, None)),
        (r"FROM global_resets WHERE date >=", (1,) if reset_posterieur else None),
        (r"SELECT joueur_id, old_mu, old_sigma FROM Participations", [(10, 25.0, 8.0)]),
        (r"SELECT joueur_id, old_sigma FROM ghost_log", []),
        (r"key = 'unranked_threshold'", ('5',)),
        (r"FROM Tournois WHERE session_id = %s AND id <> %s", autre_tournoi_session),
        (r"SELECT id, consecutive_missed, is_ranked FROM Joueurs", [(20, 2, True)]),
    ])
    return cli.post('/api/admin/revert-last-tournament', headers=H), cur, conn, lots

r, cur, conn, lots = annuler()
check("annulation : 200", r.status_code == 200, r.get_json())
check("  le dernier ENREGISTRE est vise (ORDER BY id DESC, pas par date)",
      any('ORDER BY id DESC' in s and 'FROM Tournois' in s for s in sql_de(cur)), sql_de(cur))
check("  seul tournoi de sa session : l'absence est retiree",
      lot(lots, 'SET consecutive_missed = data.missed') == [(20, 1, True)], lots)

r, cur, conn, lots = annuler(autre_tournoi_session=(1,))
check("un autre lobby porte l'absence de la session : rien a retirer",
      r.status_code == 200 and lot(lots, 'SET consecutive_missed = data.missed') is None, lots)

r, cur, conn, lots = annuler(reset_posterieur=True)
check("reset global posterieur -> 409 reset_posterieur",
      r.status_code == 409 and r.get_json().get('code') == 'reset_posterieur', r.get_json())
check("  aucun sigma restaure, rien supprime",
      not lots and not any(s.startswith('DELETE') for s in sql_de(cur)), (lots, sql_de(cur)))


# ===========================================================================
print("\n=== 7. Supprimer un tournoi ===")
# ===========================================================================

cli, cur, conn, lots = monter([
    (r"key = 'unranked_threshold'", ('5',)),
    (r"SELECT date, session_id, ligue_id FROM Tournois WHERE id", None),
])
r = cli.delete('/delete-tournament/999', headers=H)
check("tournoi inexistant -> 404", r.status_code == 404, r.get_json())
check("  ni journal ni DELETE",
      not any('audit' in s.lower() or s.startswith('DELETE') for s in sql_de(cur)), sql_de(cur))

cli, cur, conn, lots = monter([
    (r"key = 'unranked_threshold'", ('5',)),
    (r"SELECT date, session_id, ligue_id FROM Tournois WHERE id", ('2026-08-01', 300, None)),
    (r"SUM\(penalty_applied\) FROM ghost_log", [(20, 0.5)]),
    (r"SELECT joueur_id FROM Participations WHERE tournoi_id = %s", [(10,)]),
    (r"SELECT DISTINCT joueur_id FROM Participations WHERE tournoi_id > %s", [(30,)]),
    (r"FROM Tournois WHERE session_id = %s AND id <> %s", None),
    (r"SELECT id, consecutive_missed, is_ranked FROM Joueurs", []),
])
r = cli.delete('/delete-tournament/5', headers=H)
check("suppression : 200", r.status_code == 200, r.get_json())
check("  la penalite est RETIREE (0.5), old_sigma n'est pas restaure",
      lot(lots, 'GREATEST(j.sigma - data.retrait') == [(20, 0.5)]
      and lot(lots, 'SET sigma = data.sigma') is None, lots)
exclus = next((p for s, p in cur.executed if 'FROM Joueurs WHERE id NOT IN' in s), None)
check("  participants ET joueurs ayant rejoue depuis sont epargnes",
      exclus is not None and set(exclus[0]) == {10, 30}, exclus)


# ===========================================================================
print("\n=== 8. Reset global ===")
# ===========================================================================

cli, cur, conn, lots = monter([])
r = cli.post('/api/admin/global-reset', headers=H,
             json={'value': 0.3, 'max_sigma': 2.0, 'date': '2999-01-01'})
check("date future -> 400", r.status_code == 400, r.get_json())
check("  rien d'ecrit", not any('INSERT' in s for s in sql_de(cur)), sql_de(cur))

cli, cur, conn, lots = monter([
    (r"FROM global_resets WHERE date::date = %s", (1,)),
])
r = cli.post('/api/admin/global-reset', headers=H,
             json={'value': 0.3, 'max_sigma': 2.0, 'date': '2026-09-01'})
check("second reset le meme jour -> 409 reset_en_double",
      r.status_code == 409 and r.get_json().get('code') == 'reset_en_double', r.get_json())
check("  aucun sigma releve", not lots, lots)

cli, cur, conn, lots = monter([])
r = cli.post('/api/admin/global-reset', headers=H, data='x', content_type='application/json')
check("corps illisible -> 400 et pas 500", r.status_code == 400, r.status_code)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(bool(x) for x in OK), len(OK)))
sys.exit(0 if all(OK) else 1)
