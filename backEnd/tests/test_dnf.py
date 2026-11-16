"""DNF : joueur hors IP et/ou hors TrueSkill, a la saisie comme apres coup.

Hors IP : le tournoi sort de l'IP du joueur (moyenne et participation) et de la
moyenne du lobby pour les autres ; points, places et participations affichees
ne bougent pas. Hors TS apres coup : rejeu du TrueSkill depuis la date du
tournoi, apres un apercu. Le geste exige gestion_tournois et un droit sur le
TrueSkill (Reglage TS ou Corriger le score).

Les calculs TrueSkill utilisent la vraie librairie (importee avant le banc, qui
sinon la neutralise) ; sans elle, ces parties sont sautees.
"""
import sys
try:
    import trueskill as _vrai_trueskill  # noqa: F401  (avant harness)
    TRUESKILL = hasattr(_vrai_trueskill, 'TrueSkill')
except ImportError:
    TRUESKILL = False

from harness import *
import json
from datetime import date, timedelta
from flask import Flask

PROCHE = lambda a, b, eps=1e-9: abs(a - b) <= eps
D1, D2, D3 = date(2026, 10, 5), date(2026, 10, 12), date(2026, 10, 19)


def saison(lignes, version='v1'):
    """_aggregate_season_stats sur des lignes (jid, nom, score, place, tournoi,
    date, session, hors_ip). Renvoie (stats, curseur)."""
    rows = [(jid, nom, score, place, 50.0, 50.0, 2.0, d, tid, 2.0, None, 50.0, sid, hors_ip)
            for jid, nom, score, place, tid, d, sid, hors_ip in lignes]
    cur, _ = install_db([
        (r"SELECT j\.id, j\.nom, p\.score, p\.position", rows),
        (r"FROM grille_snapshots", []),
        (r"SELECT p\.old_mu FROM Participations", [(50.0,) for l in lignes if not l[7]]),
        (r"SELECT p\.joueur_id, j\.nom, p\.new_score_trueskill", []),
    ])
    sys.modules.pop('services', None)
    import services
    return services._aggregate_season_stats('2026-10-01', '2026-10-31', 'classic', None, version), cur


def par_nom(stats):
    return {e['nom']: e for e in stats['classement_moyenne']}


def lobbies(c_hors_ip):
    # T1 : C fait 30 (DNF possible) ; T2 : tout le monde a 100.
    return [
        (1, 'A', 150, 1, 1, D1, 1, False), (2, 'B', 100, 2, 1, D1, 1, False),
        (3, 'C', 30, 3, 1, D1, 1, c_hors_ip),
        (1, 'A', 100, 1, 2, D2, 2, False), (2, 'B', 100, 1, 2, D2, 2, False),
        (3, 'C', 100, 1, 2, D2, 2, False),
    ]


print("\n=== IP : un tournoi hors IP sort du calcul, pour lui comme pour les autres ===")
sans, _ = saison(lobbies(False))
avec, cur = saison(lobbies(True))
s, a = par_nom(sans), par_nom(avec)
# v1, poids = joueurs du lobby + 5, bonus 0,3 par tournoi au-dela de 40 % de 2.
check("sans DNF : l'IP d'avant (A 125,36 ; B 103,93 ; C 66,43)",
      (s['A']['score_gm'], s['B']['score_gm'], s['C']['score_gm']) == (125.36, 103.93, 66.43),
      (s['A']['score_gm'], s['B']['score_gm'], s['C']['score_gm']))
check("C hors IP au 1er tournoi : la moyenne du lobby est 125, sans lui (A 109,69 ; B 91,03)",
      (a['A']['score_gm'], a['B']['score_gm']) == (109.69, 91.03),
      (a['A']['score_gm'], a['B']['score_gm']))
check("son IP ne compte que l'autre tournoi (100 + 0,06 de bonus)",
      a['C']['score_gm'] == 100.06, a['C']['score_gm'])
check("ses points, places et participations ne bougent pas",
      all(a['C'][k] == s['C'][k] for k in ('matchs', 'total_points', 'victoires')),
      (a['C'], s['C']))
check("ses moyennes de points et de places ignorent le DNF (100 et 1 au lieu de 65 et 2)",
      (a['C']['moyenne_points'], a['C']['moyenne_position']) == (100.0, 1.0)
      and (s['C']['moyenne_points'], s['C']['moyenne_position']) == (65.0, 2.0),
      (a['C'], s['C']))
check("le DNF est compte a part (matchs_hors_ip)",
      a['C']['matchs_hors_ip'] == 1 and s['C']['matchs_hors_ip'] == 0)
check("le repli « mu moyen de la periode » ignore aussi les DNF",
      any('NOT COALESCE(p.exclude_from_ip, false)' in sql for sql, _ in cur.executed))

print("\n=== IP : le DNF ne compte pas comme participation ===")
fin = [(1, 'A', 120, 1, 3, D3, 3, False), (2, 'B', 80, 2, 3, D3, 3, False)]
s3, _ = saison(lobbies(False) + fin)
a3, _ = saison(lobbies(True) + fin)
check("3 sessions (minimum 1,2) : C classe avec ses 2 tournois",
      par_nom(s3)['C']['is_eligible_gm'] is True)
check("C non classe quand l'un des deux est hors IP",
      par_nom(a3)['C']['is_eligible_gm'] is False and par_nom(a3)['C']['matchs'] == 2)

seul, _ = saison([(1, 'A', 150, 1, 1, D1, 1, False), (2, 'B', 100, 2, 1, D1, 1, False),
                  (4, 'D', 10, 3, 1, D1, 1, True)])
d = par_nom(seul)['D']
check("que des tournois hors IP : pas d'IP, mais toujours au classement des points",
      d['score_gm'] is None and d['is_eligible_gm'] is False and d['matchs'] == 1, d)
check("  et absent des candidats au classement IP",
      all(c['nom'] != 'D' for c in seul['candidates']['grand_master']))

print("\n=== borderline : lit l'historique IP, et la place sur le lobby complet ===")
import services
hist = [{"date": D1 + timedelta(days=7 * i), "position": p, "score": sc, "avg_score": 120.0,
         "count": 8, "taille_lobby": 10}
        for i, (p, sc) in enumerate([(9, 60), (2, 150), (7, 90), (1, 170), (5, 120)])]
lu = services._compute_borderline_scores({1: {"gm_history": [], "ip_history": hist}})
ref = services._compute_borderline_scores(
    {1: {"gm_history": [dict(m, count=m['taille_lobby']) for m in hist]}})
check("meme score qu'un historique complet de lobbies a 10", lu == ref and 1 in lu, (lu, ref))

print("\n=== courbe d'IP : le point DNF garde l'IP d'avant ===")
tournois = [(1, D1, None, 1), (2, D2, None, 2)]
parts = [(1, 1, 'A', '#fff', 150, 1, 50.0, False), (1, 2, 'B', '#fff', 100, 2, 50.0, False),
         (1, 3, 'C', '#fff', 100, 2, 50.0, False),
         (2, 1, 'A', '#fff', 100, 1, 50.0, False), (2, 2, 'B', '#fff', 100, 1, 50.0, False),
         (2, 3, 'C', '#fff', 10, 3, 50.0, True), (2, 4, 'D', '#fff', 5, 4, 50.0, True)]
install_db([(r"SELECT t\.id, t\.date, t\.ligue_id, t\.session_id", tournois),
            (r"SELECT p\.tournoi_id, p\.joueur_id", parts),
            (r"FROM grille_snapshots", []),
            (r"SELECT p\.old_mu FROM participations", [(50.0,)] * 5)])
sys.modules.pop('services', None)
import services
evo = {d['nom']: d for d in services.compute_ip_evolution(
    '2026-10-01', '2026-10-31', None, None, 'v1')['datasets']}
c = evo['C']
check("C : point DNF marque, sans IP du tournoi",
      c['points'][1] and c['points'][1].get('dnf') is True and c['points'][1]['ip_pur'] is None,
      c['points'])
check("  et son IP reste celle d'avant", c['data'][1] == c['data'][0], c['data'])
check("  un seul tournoi compte", c['matchs'] == 1, c['matchs'])
check("A : moyenne du 2e lobby sans les DNF (100 et non 53,75)",
      evo['A']['points'][1]['ip_pur'] == 100.0, evo['A']['points'][1])
check("D, que des DNF : pas de courbe", 'D' not in evo, list(evo))


if TRUESKILL:
    import recalcul_ts as R
    from trueskill import Rating

    print("\n=== hors TS apres coup : rejeu sans le joueur ===")
    env = R.environnement(0.2)
    etat = {1: (55.0, 2.0), 2: (50.0, 1.5), 3: (48.0, 2.5)}
    scores = ((1, 100), (2, 80), (3, 60))
    notes = R.noter(env, [(j, Rating(*etat[j]), sc) for j, sc in scores])
    donnees = {
        "joueurs": {j: {"nom": "J%d" % j, "mu": notes[j].mu, "sigma": notes[j].sigma} for j in etat},
        "naissance": {},
        "tournois": [{"id": 7, "date": D1, "participations": [
            {"joueur_id": j, "score": sc, "exclude": False, "old_mu": etat[j][0],
             "old_sigma": etat[j][1], "mu": notes[j].mu, "sigma": notes[j].sigma}
            for j, sc in scores]}],
        "ghosts": [], "resets": [], "grilles": {},
        "ghost_penalty": 0.1, "sigma_threshold": 3.3,
    }
    R.marquer_hors_ts(donnees, 7, {3: True})
    res = R.rejouer(donnees, D1, [(D1, 0.2)])
    j3 = [p for p in res['participations'] if p[1] == 3][0]
    check("le joueur hors TS garde ses valeurs dans ce tournoi",
          j3[2] == j3[4] and j3[3] == j3[5], j3)
    sans3 = R.noter(env, [(j, Rating(*etat[j]), sc) for j, sc in scores[:2]])
    check("les autres sont notes sans lui",
          all(PROCHE(res['joueurs'][j][0], sans3[j].mu) for j in (1, 2)), res['joueurs'])
    check("sa fiche revient a l'avant-tournoi",
          PROCHE(res['joueurs'][3][0], etat[3][0]) and PROCHE(res['joueurs'][3][1], etat[3][1]))
    R.marquer_hors_ts(donnees, 7, {3: False})
    res = R.rejouer(donnees, D1, [(D1, 0.2)])
    check("decocher retrouve l'historique d'origine",
          all(PROCHE(res['joueurs'][j][0], notes[j].mu) for j in etat) and not res['ecarts'])


# --- Routes -----------------------------------------------------------------
H = {'X-Session-Token': 'tok'}
PARTICIPANTS = [(1, 'j_sk8', 168, 1, False, False), (9, 'Le Chauvalier', 51, 9, False, False),
                (11, 'Oleas', 39, 10, False, False)]
# Lectures de recalcul_ts.charger (un seul tournoi, deja note sans DNF).
CHARGER = [
    (r"SELECT id, nom, mu, sigma FROM Joueurs", [(1, 'j_sk8', 59.0, 1.5), (9, 'Le Chauvalier', 53.0, 1.3),
                                                 (11, 'Oleas', 52.0, 2.0)]),
    (r"SELECT DISTINCT ON \(p\.joueur_id\)", []),
    (r"SELECT t\.id, t\.date, p\.joueur_id, p\.score", [
        (108, D1, 1, 168, False, 58.0, 1.6, 59.0, 1.5),
        (108, D1, 9, 51, False, 53.5, 1.35, 53.0, 1.3),
        (108, D1, 11, 39, False, 52.8, 2.1, 52.0, 2.0)]),
    (r"FROM ghost_log WHERE date", []),
    (r"FROM global_resets", []),
    (r"SELECT date, joueur_id, mu, sigma, is_ranked, tier", []),
    (r"SELECT key, value FROM Configuration WHERE key IN", []),
]


def monter(role='admin', accordees=(), empreinte='emp-1', tournoi=(D1,)):
    plan = [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=1, discord_id='111', username='a', global_name='A', role=role)),
        (r"SELECT 1 FROM permissions_admin",
         lambda params: (1,) if params and params[1] in accordees else None),
        (r"SELECT date FROM Tournois WHERE id", tournoi),
        (r"SELECT p\.joueur_id, j\.nom, p\.score, p\.position", PARTICIPANTS),
        (r"SELECT value FROM Configuration WHERE key = 'tau'", ('0.2',)),
        (r"FROM saisons s", [('Automne 2026', False)]),
        (r"SELECT md5", (empreinte,)),
    ] + CHARGER
    cur, conn = install_db(plan)
    recharger()
    for m in ('routes_admin', 'cache', 'services'):
        sys.modules.pop(m, None)
    ecrits = []

    def execute_values(c, sql, argslist, *a, **kw):
        ecrits.append((' '.join(sql.split()), list(argslist)))
        c.execute(sql, None)

    sys.modules['psycopg2'].extras.execute_values = execute_values
    import cache
    cache.invalidate_cache = lambda *a, **k: None
    import services
    services.recalculate_tiers = lambda: None
    import routes_admin
    routes_admin.recalculate_tiers = lambda: None
    app = Flask(__name__)
    app.register_blueprint(routes_admin.admin_bp)
    return app.test_client(), cur, conn, ecrits


def audit_dnf(cur):
    return [json.loads(p[4]) for s, p in cur.executed
            if 'INSERT INTO audit_admin' in s and p and p[0] == 'dnf_modifie']


DROIT_TS = {'gestion_tournois', 'gestion_config'}
NO_IP = {"joueurs": [{"joueur_id": 11, "exclu_ts": False, "exclu_ip": True},
                     {"joueur_id": 9, "exclu_ip": True}]}
NO_TS = {"joueurs": [{"joueur_id": 11, "exclu_ts": True, "exclu_ip": True}]}
URL = '/admin/tournois/108/dnf'

print("\n=== droits : gestion_tournois ET un droit sur le TrueSkill ===")
cli, cur, conn, ecrits = monter(accordees={'gestion_tournois'})
r = cli.get(URL, headers=H)
check("gestion_tournois seul : lecture permise, sans droit de modifier",
      r.status_code == 200 and r.get_json().get('peut_modifier') is False, r.get_data(as_text=True))
check("  les joueurs par place, avec leurs cases",
      [j['nom'] for j in r.get_json()['joueurs']] == ['j_sk8', 'Le Chauvalier', 'Oleas']
      and r.get_json()['joueurs'][2] == {"joueur_id": 11, "nom": 'Oleas', "score": 39,
                                          "position": 10, "exclu_ts": False, "exclu_ip": False})
r = cli.post(URL, headers=H, json=NO_IP)
check("  application refusee (403 permission_manquante)",
      r.status_code == 403 and r.get_json().get('code') == 'permission_manquante', r.status_code)
r = cli.post(URL + '/apercu', headers=H, json=NO_TS)
check("  apercu refuse (403)", r.status_code == 403, r.status_code)
check("  et rien n'est ecrit", not ecrits and not audit_dnf(cur))

cli, *_ = monter(accordees={'gestion_config'})
check("Reglage TS sans gestion_tournois : 403 (page fermee)",
      cli.post(URL, headers=H, json=NO_IP).status_code == 403)
cli, *_ = monter(accordees={'gestion_tournois', 'edition_mu_sigma'})
check("Corriger le score sans son parent Fiches joueurs : 403",
      cli.post(URL, headers=H, json=NO_IP).status_code == 403)
cli, *_ = monter(accordees={'gestion_tournois', 'edition_mu_sigma', 'gestion_joueurs'})
check("Corriger le score (avec Fiches joueurs) : permis",
      cli.post(URL, headers=H, json=NO_IP).status_code == 200)
cli, *_ = monter(role='chef_admin')
check("chef_admin : permis", cli.post(URL, headers=H, json=NO_IP).status_code == 200)

print("\n=== saisie verifiee ===")
cli, cur, conn, ecrits = monter(accordees=DROIT_TS)
for nom, corps in [
    ("joueur absent du tournoi", {"joueurs": [{"joueur_id": 99, "exclu_ip": True}]}),
    ("case non booleenne", {"joueurs": [{"joueur_id": 11, "exclu_ip": "oui"}]}),
    ("joueur en double", {"joueurs": [{"joueur_id": 11, "exclu_ip": True},
                                      {"joueur_id": 11, "exclu_ts": True}]}),
    ("rien ne change", {"joueurs": [{"joueur_id": 11, "exclu_ip": False}]}),
    ("liste vide", {"joueurs": []}),
]:
    r = cli.post(URL, headers=H, json=corps)
    check("refuse : " + nom, r.status_code == 400
          and r.get_json().get('code') == 'saisie_invalide', r.get_data(as_text=True))
check("  rien n'est ecrit", not ecrits and not audit_dnf(cur))
cli, *_ = monter(accordees=DROIT_TS, tournoi=None)
check("tournoi inconnu : 404", cli.post(URL, headers=H, json=NO_IP).status_code == 404)

print("\n=== hors IP : drapeaux poses, sans rejeu du TrueSkill ===")
cli, cur, conn, ecrits = monter(accordees=DROIT_TS)
r = cli.post(URL, headers=H, json=NO_IP)
check("200 et commit", r.status_code == 200 and conn.committed, r.get_data(as_text=True))
maj = [a for s, a in ecrits if 'exclude_from_ip' in s]
check("une mise a jour des deux joueurs, TS inchange",
      len(maj) == 1 and sorted(maj[0]) == [(108, 9, False, True), (108, 11, False, True)], ecrits)
check("pas de rejeu (aucune valeur de TrueSkill reecrite)",
      not any('new_score_trueskill' in s or 'UPDATE Joueurs' in s for s, _ in ecrits), ecrits)
trace = audit_dnf(cur)
check("une ligne d'audit dnf_modifie, par joueur, sans score modifie",
      len(trace) == 1 and trace[0]['score_modifie'] is False and trace[0]['recalcul_ts'] is None
      and [c['nom'] for c in trace[0]['changements']] == ['Oleas', 'Le Chauvalier']
      and trace[0]['changements'][0]['ip'] == [False, True] and 'ts' not in trace[0]['changements'][0],
      trace)

print("\n=== hors TS : apercu exige, empreinte comparee sous verrou ===")
cli, cur, conn, ecrits = monter(accordees=DROIT_TS, empreinte='emp-2')
r = cli.post(URL, headers=H, json=dict(NO_TS, empreinte='emp-1'))
check("donnees changees depuis l'apercu : 409 apercu_perime",
      r.status_code == 409 and r.get_json().get('code') == 'apercu_perime', r.get_data(as_text=True))
check("  rien n'est ecrit", not ecrits and not audit_dnf(cur))
check("  le verrou des tournois est pris avant la comparaison",
      any('pg_advisory_xact_lock' in s for s, _ in cur.executed))
r = cli.post(URL, headers=H, json=NO_TS)
check("sans apercu (pas d'empreinte) : 409", r.status_code == 409, r.status_code)

if TRUESKILL:
    cli, cur, conn, ecrits = monter(accordees=DROIT_TS)
    r = cli.post(URL + '/apercu', headers=H, json=NO_TS)
    corps = r.get_json() or {}
    check("apercu : 200 avec l'empreinte et l'effet sur le TrueSkill",
          r.status_code == 200 and corps.get('empreinte') == 'emp-1'
          and corps['recalcul_ts']['nb_tournois'] == 1 and corps['recalcul_ts']['tau'] == 0.2
          and corps['recalcul_ts']['date_debut'] == '05/10/2026', r.get_data(as_text=True))
    # La session met a jour last_seen_at : seul le dossier sportif compte ici.
    check("  rien n'est ecrit", not ecrits and not any(
        s.split()[0].upper() in ('UPDATE', 'INSERT', 'DELETE') and 'sessions_joueurs' not in s
        for s, _ in cur.executed), [s for s, _ in cur.executed if not s.startswith('SELECT')])

    cli, cur, conn, ecrits = monter(accordees=DROIT_TS)
    r = cli.post(URL, headers=H, json=dict(NO_TS, empreinte='emp-1'))
    check("application : 200 et commit", r.status_code == 200 and conn.committed,
          r.get_data(as_text=True))
    i_flag = next(i for i, (s, _) in enumerate(ecrits) if 'exclude_from_ts' in s)
    i_rejeu = next((i for i, (s, _) in enumerate(ecrits) if 'new_score_trueskill' in s), -1)
    check("drapeaux poses, puis TrueSkill rejoue", 0 <= i_flag < i_rejeu, ecrits)
    trace = audit_dnf(cur)
    check("audit : score modifie, date et tau du rejeu",
          len(trace) == 1 and trace[0]['score_modifie'] is True
          and trace[0]['recalcul_ts']['date_debut'] == '2026-10-05'
          and trace[0]['recalcul_ts']['tau'] == 0.2, trace)

print("\n=== saisie d'un tournoi : case No IP ===")
cli, cur, conn, ecrits = monter(accordees={'gestion_tournois'})
r = cli.post('/add-tournament', headers=H, json={
    "date": "2026-10-05",
    "joueurs": [{"nom": "A", "score": 12, "exclude_from_ip": "oui"}, {"nom": "B", "score": 8}]})
check("No IP non booleen : 400 avant toute ecriture",
      r.status_code == 400 and r.get_json().get('code') == 'saisie_invalide'
      and not any(s.startswith('INSERT') for s, _ in cur.executed), r.get_data(as_text=True))
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'routes_admin.py'),
           encoding='utf-8').read()
check("la participation enregistre exclude_from_ip",
      'exclude_from_ts, exclude_from_ip) VALUES' in src)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
