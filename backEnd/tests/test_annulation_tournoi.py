"""Annulation d'un tournoi : la penalite d'absence doit se defaire proprement.

Phase 0 de docs/plan-sessions-tournois.md (2026-09-14). Zone jusqu'ici NON
COUVERTE : aucun test ne touchait revert_last_tournament ni delete_tournament.

Le defaut corrige : revert_last_tournament faisait
    UPDATE Joueurs SET consecutive_missed = GREATEST(0, consecutive_missed - 1)
sans aucun WHERE. Toute la base etait decrementee -- y compris les joueurs hors
perimetre de ligue, exclus du calcul de penalite -- et l'erreur etait CUMULATIVE :
chaque annulation faisait deriver la base d'un cran. is_ranked n'etait par
ailleurs jamais restaure, laissant hors classement un joueur repasse sous le seuil.

delete_tournament, lui, faisait deja le bon geste. Les deux routes partagent
desormais annuler_absences() : ce fichier verifie que les deux appellent la meme
regle, et qu'aucune ne retombe sur un UPDATE global.

Limite du banc d'essai : le curseur est scripte, le SQL n'est pas valide contre
Postgres. Ce qui est verifie ici, c'est QUI est touche et avec quelles valeurs.
"""
from harness import *
from flask import Flask

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

H = {'X-Session-Token': 'tok'}
SESSION = lambda role: (
    r"FROM sessions_joueurs s JOIN comptes c",
    ligne_session(compte_id=1, discord_id='111', username='a',
                  global_name='A', role=role))


def monter(plan, role='chef_admin'):
    """Monte routes_admin sur un curseur scripte, avec execute_values capture.

    Le harness neutralise psycopg2 : execute_values n'existe pas. On l'installe
    ici pour enregistrer les lots ecrits -- c'est exactement la donnee que ces
    tests inspectent (qui est decremente, et a quelle valeur).
    """
    cur, conn = install_db(list(plan) + [SESSION(role)])
    recharger()
    for m in ('routes_admin', 'cache', 'services'):
        sys.modules.pop(m, None)

    lots = []

    def execute_values(c, sql, argslist, *a, **kw):
        norm = ' '.join(sql.split())
        lots.append((norm, list(argslist)))
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


def lot_compteur(lots):
    """Le lot qui ecrit consecutive_missed + is_ranked, s'il existe."""
    for sql, args in lots:
        if 'consecutive_missed = data.missed' in sql and 'is_ranked = data.ranked' in sql:
            return args
    return None


def sql_execute(cur):
    return [s for s, _ in cur.executed]


# Trois joueurs, le triplet qui revele le defaut :
#   10 = participant au tournoi annule      -> a NE PAS toucher
#   20 = absent penalise (missed 5, non classe) -> doit redescendre a 4 et revenir classe
#   30 = joueur hors perimetre (autre ligue, missed 2) -> etait decremente a tort
#
# La requete de selection des absents renvoie (id, consecutive_missed, is_ranked).
ABSENTS_SANS_PARTICIPANT = [(20, 5, False), (30, 2, True)]
ABSENTS_TOUS = [(10, 3, True), (20, 5, False), (30, 2, True)]


print("\n=== revert_last_tournament : le decrement ne touche plus toute la base ===")

cli, cur, conn, lots = monter([
    (r"SELECT id, date FROM Tournois ORDER BY date DESC", (77, '2026-09-01')),
    (r"SELECT joueur_id, old_mu, old_sigma FROM Participations", [(10, 25.0, 8.0)]),
    (r"SELECT joueur_id, old_sigma FROM ghost_log", [(20, 7.5)]),
    (r"key = 'unranked_threshold'", ('5',)),
    (r"SELECT id, consecutive_missed, is_ranked FROM Joueurs", ABSENTS_SANS_PARTICIPANT),
])
r = cli.post('/api/admin/revert-last-tournament', headers=H)
check("revert repond 200", r.status_code == 200, r.get_data(as_text=True))

globaux = [s for s in sql_execute(cur)
           if 'UPDATE Joueurs SET consecutive_missed' in s and 'WHERE' not in s]
check("plus aucun UPDATE global sans WHERE", not globaux, globaux)

select_absents = [s for s in sql_execute(cur)
                  if 'SELECT id, consecutive_missed, is_ranked FROM Joueurs' in s]
check("les participants sont exclus par NOT IN",
      select_absents and 'NOT IN' in select_absents[0], select_absents)

batch = lot_compteur(lots)
check("un lot de decrement est ecrit", batch is not None, lots)
touches = {jid for jid, _, _ in (batch or [])}
check("le participant (10) n'est PAS touche", 10 not in touches, touches)
check("l'absent penalise (20) est decremente", 20 in touches, touches)

par_id = {jid: (m, r_) for jid, m, r_ in (batch or [])}
check("20 : missed 5 -> 4", par_id.get(20, (None,))[0] == 4, par_id.get(20))
check("20 : is_ranked restaure (4 < seuil 5)", par_id.get(20, (None, None))[1] is True,
      par_id.get(20))
check("30 : missed 2 -> 1", par_id.get(30, (None,))[0] == 1, par_id.get(30))
check("30 : reste classe, sans faux passage a False",
      par_id.get(30, (None, None))[1] is True, par_id.get(30))
check("le seuil unranked_threshold est bien relu",
      any("unranked_threshold" in s for s in sql_execute(cur)), None)
check("transaction validee", conn.committed, None)


print("\n=== Le compteur d'un participant n'est jamais decremente ===")
# Un participant a missed > 0 ne doit pas etre repris : add_tournament l'a remis
# a 0, la valeur d'avant est perdue (aucun old_missed en base). Le decrementer
# le ferait passer SOUS sa valeur reelle.
cli, cur, conn, lots = monter([
    (r"SELECT id, date FROM Tournois ORDER BY date DESC", (77, '2026-09-01')),
    (r"SELECT joueur_id, old_mu, old_sigma FROM Participations", [(10, 25.0, 8.0)]),
    (r"SELECT joueur_id, old_sigma FROM ghost_log", []),
    (r"key = 'unranked_threshold'", ('5',)),
    # Le curseur renvoie sciemment le participant : si la route ne l'excluait
    # pas de sa requete, il se retrouverait dans le lot.
    (r"SELECT id, consecutive_missed, is_ranked FROM Joueurs", ABSENTS_TOUS),
])
r = cli.post('/api/admin/revert-last-tournament', headers=H)
batch = lot_compteur(lots)
ids = [jid for jid, _, _ in (batch or [])]
check("la liste des participants est transmise a l'exclusion",
      any('NOT IN' in s for s in sql_execute(cur)
          if 'SELECT id, consecutive_missed, is_ranked' in s), None)
check("aucun doublon dans le lot ecrit", len(ids) == len(set(ids)), ids)


print("\n=== Un joueur a missed = 0 n'est jamais decremente sous zero ===")
cli, cur, conn, lots = monter([
    (r"SELECT id, date FROM Tournois ORDER BY date DESC", (77, '2026-09-01')),
    (r"SELECT joueur_id, old_mu, old_sigma FROM Participations", [(10, 25.0, 8.0)]),
    (r"SELECT joueur_id, old_sigma FROM ghost_log", []),
    (r"key = 'unranked_threshold'", ('5',)),
    (r"SELECT id, consecutive_missed, is_ranked FROM Joueurs",
     [(20, 0, True), (30, None, True), (40, 3, True)]),
])
r = cli.post('/api/admin/revert-last-tournament', headers=H)
batch = lot_compteur(lots)
touches = {jid for jid, _, _ in (batch or [])}
check("missed = 0 est ignore", 20 not in touches, touches)
check("missed NULL est ignore", 30 not in touches, touches)
check("missed = 3 est bien decremente", 40 in touches, touches)
check("aucune valeur negative ecrite",
      all(m >= 0 for _, m, _ in (batch or [])), batch)


print("\n=== is_ranked : restaure sous le seuil, jamais retire au-dessus ===")
cli, cur, conn, lots = monter([
    (r"SELECT id, date FROM Tournois ORDER BY date DESC", (77, '2026-09-01')),
    (r"SELECT joueur_id, old_mu, old_sigma FROM Participations", []),
    (r"SELECT joueur_id, old_sigma FROM ghost_log", []),
    (r"key = 'unranked_threshold'", ('3',)),
    (r"SELECT id, consecutive_missed, is_ranked FROM Joueurs",
     # 20 repasse sous le seuil -> reclasse ; 21 reste au-dessus -> non classe ;
     # 22 est deja classe avec un compteur haut -> on ne le declasse pas ici.
     [(20, 3, False), (21, 9, False), (22, 8, True)]),
])
r = cli.post('/api/admin/revert-last-tournament', headers=H)
par_id = {jid: (m, r_) for jid, m, r_ in (lot_compteur(lots) or [])}
check("20 : 3 -> 2, sous le seuil 3, reclasse",
      par_id.get(20) == (2, True), par_id.get(20))
check("21 : 9 -> 8, toujours au-dessus, reste non classe",
      par_id.get(21) == (8, False), par_id.get(21))
check("22 : deja classe, la route ne le declasse pas",
      par_id.get(22) == (7, True), par_id.get(22))


print("\n=== delete_tournament : meme regle, comportement inchange ===")
cli, cur, conn, lots = monter([
    (r"key = 'unranked_threshold'", ('5',)),
    (r"SELECT date FROM Tournois WHERE id", ('2026-09-01',)),
    (r"SELECT joueur_id, old_sigma FROM ghost_log", [(20, 7.5)]),
    (r"SELECT joueur_id FROM Participations WHERE tournoi_id", [(10,)]),
    (r"SELECT id, consecutive_missed, is_ranked FROM Joueurs", ABSENTS_SANS_PARTICIPANT),
])
r = cli.delete('/delete-tournament/77', headers=H)
check("delete repond 200", r.status_code == 200, r.get_data(as_text=True))

globaux = [s for s in sql_execute(cur)
           if 'UPDATE Joueurs SET consecutive_missed' in s and 'WHERE' not in s]
check("aucun UPDATE global sans WHERE", not globaux, globaux)

par_id = {jid: (m, r_) for jid, m, r_ in (lot_compteur(lots) or [])}
check("le participant (10) n'est pas touche", 10 not in par_id, par_id)
check("20 : missed 5 -> 4, reclasse", par_id.get(20) == (4, True), par_id.get(20))
check("30 : missed 2 -> 1, reste classe", par_id.get(30) == (1, True), par_id.get(30))
check("transaction validee", conn.committed, None)


print("\n=== Les deux routes passent par la MEME fonction ===")
src = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read()
check("annuler_absences est importee depuis services",
      'annuler_absences' in src.split('logger =')[0], None)
check("exactement deux appels a annuler_absences (un par route)",
      src.count('annuler_absences(cur') == 2, src.count('annuler_absences(cur'))
check("plus aucun UPDATE global de consecutive_missed dans le source",
      'UPDATE Joueurs SET consecutive_missed = GREATEST' not in src, None)

# Le calcul ne doit vivre qu'a un seul endroit : si quelqu'un recopie la boucle
# dans une route, ce test le signale avant que les regles ne divergent a nouveau.
check("la boucle de decrement n'est pas dupliquee dans routes_admin",
      'new_m = missed - 1' not in src and 'missed - 1' not in src, None)

src_services = open(os.path.join(RACINE, 'services.py'), encoding='utf-8').read()
check("annuler_absences est definie dans services.py",
      'def annuler_absences(' in src_services, None)
check("elle documente pourquoi les participants restent a 0",
      'old_missed' in src_services, None)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
