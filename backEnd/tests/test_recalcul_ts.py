"""Recalcul TrueSkill : ex-aequo independants de l'ordre de saisie, rejeu fidele
de l'historique, tau par periode, routes reservees au superadmin.

Les calculs utilisent la vraie librairie trueskill (importee avant le banc,
qui sinon la neutralise) ; sans elle, seules les routes sont testees.
"""
import sys
try:
    import trueskill as _vrai_trueskill  # noqa: F401  (avant harness)
    TRUESKILL = hasattr(_vrai_trueskill, 'TrueSkill')
except ImportError:
    TRUESKILL = False

from harness import *
import re
from datetime import date
from flask import Flask

PROCHE = lambda a, b, eps=1e-12: abs(a - b) <= eps

if TRUESKILL:
    import recalcul_ts as R
    from trueskill import Rating

    print("\n=== noter : l'ordre de saisie des ex-aequo ne change plus rien ===")
    env = R.environnement(0.2)
    base = [('C', Rating(50.19, 1.349), 112), ('A', Rating(47.71, 1.371), 106),
            ('O', Rating(52.78, 2.379), 106)]
    r1 = R.noter(env, base)
    r2 = R.noter(env, [base[0], base[2], base[1]])
    check("Oleas identique quel que soit l'ordre",
          PROCHE(r1['O'].mu, r2['O'].mu) and PROCHE(r1['O'].sigma, r2['O'].sigma),
          (r1['O'], r2['O']))
    check("Astral identique quel que soit l'ordre",
          PROCHE(r1['A'].mu, r2['A'].mu) and PROCHE(r1['A'].sigma, r2['A'].sigma))
    brut_ao = env.rate([[base[0][1]], [base[1][1]], [base[2][1]]], ranks=[1, 2, 2])
    brut_oa = env.rate([[base[0][1]], [base[2][1]], [base[1][1]]], ranks=[1, 2, 2])
    check("le resultat est entre les deux ordres bruts",
          min(brut_ao[2][0].mu, brut_oa[1][0].mu) <= r1['O'].mu
          <= max(brut_ao[2][0].mu, brut_oa[1][0].mu), r1['O'].mu)

    sans = [('X', Rating(55, 2), 150), ('Y', Rating(50, 1.5), 120), ('Z', Rating(48, 2.5), 90)]
    r = R.noter(env, sans)
    brut = env.rate([[x[1]] for x in sans], ranks=[1, 2, 3])
    check("sans egalite : exactement l'ancien calcul",
          all(r[k].mu == brut[i][0].mu and r[k].sigma == brut[i][0].sigma
              for i, k in enumerate('XYZ')))
    r = R.noter(env, [sans[2], sans[0], sans[1]])
    check("sans egalite : saisie dans le desordre, meme resultat",
          all(r[k].mu == brut[i][0].mu for i, k in enumerate('XYZ')))

    grand = [('P%d' % i, Rating(50 + i, 2), 100) for i in range(7)]  # 5040 ordres
    r = R.noter(env, grand)
    check("egalite a 7 : rotations au lieu des 5040 permutations, sans planter",
          len(r) == 7 and all(v.sigma > 0 for v in r.values()))

    print("\n=== valider_periodes ===")
    d0 = date(2026, 1, 1)
    p, err = R.valider_periodes(d0, [{"debut": "2026-03-01", "tau": 0.1},
                                     {"debut": "2026-01-01", "tau": 0.2}])
    check("periodes triees", err is None and p == [(d0, 0.2), (date(2026, 3, 1), 0.1)], (p, err))
    check("tau a la date", R.tau_a_la_date(p, date(2026, 2, 28)) == 0.2
          and R.tau_a_la_date(p, date(2026, 3, 1)) == 0.1)
    for nom, periodes in [
        ("premiere periode apres le depart", [{"debut": "2026-02-01", "tau": 0.2}]),
        ("tau negatif", [{"debut": "2026-01-01", "tau": -1}]),
        ("tau booleen", [{"debut": "2026-01-01", "tau": True}]),
        ("deux periodes le meme jour", [{"debut": "2026-01-01", "tau": 0.2},
                                        {"debut": "2026-01-01", "tau": 0.3}]),
        ("aucune periode", []),
        ("date illisible", [{"debut": "hier", "tau": 0.2}]),
    ]:
        p, err = R.valider_periodes(d0, periodes)
        check("refuse : " + nom, p is None and bool(err), (p, err))

    # --- Historique synthetique, ecrit comme le ferait l'application ---------
    TAU = 0.2
    etat = {1: [55.0, 2.0], 2: [50.0, 1.5], 3: [48.0, 2.5], 4: [45.0, 3.0]}
    tournois, ghosts, resets, grilles = [], [], [], {}

    def tournoi(tid, d, scores, exclus=()):
        parts = []
        notes = R.noter(R.environnement(TAU), [
            (j, Rating(*etat[j]), s) for j, s in scores.items() if j not in exclus])
        for j, s in scores.items():
            old = list(etat[j])
            if j in notes:
                etat[j] = [notes[j].mu, notes[j].sigma]
            parts.append({"joueur_id": j, "score": s, "exclude": j in exclus,
                          "old_mu": old[0], "old_sigma": old[1],
                          "mu": etat[j][0], "sigma": etat[j][1]})
        tournois.append({"id": tid, "date": d, "participations": parts})

    def fantome(gid, tid, d, j, p):
        old = etat[j][1]
        etat[j][1] += p
        ghosts.append({"id": gid, "tournoi_id": tid, "date": d, "joueur_id": j,
                       "old_sigma": old, "new_sigma": etat[j][1], "penalty": p})

    def grille(d):
        grilles[d] = [{"joueur_id": j, "mu": m, "sigma": s, "is_ranked": True,
                       "tier": 'A' if s <= 3.3 else 'U'} for j, (m, s) in etat.items()]

    tournoi(10, date(2026, 1, 5), {1: 100, 2: 80, 3: 60})
    fantome(1, 10, date(2026, 1, 5), 4, 0.1)
    for j in etat:                                   # reset ancien, sans detail
        etat[j][1] += 0.3
    resets.append({"id": 1, "date": date(2026, 1, 10), "value": 0.3, "max_sigma": None,
                   "details": {}})
    grille(date(2026, 1, 12))
    tournoi(11, date(2026, 1, 12), {1: 90, 2: 70, 3: 70, 4: 50})   # ex-aequo 2 et 3
    details = {}
    for j in etat:                                   # reset plafonne a 2.0
        s = etat[j][1]
        if s < 2.0:
            n = min(s + 0.3, 2.0)
            details[j] = {"id": 100 + j, "old_sigma": s, "new_sigma": n}
            etat[j][1] = n
    resets.append({"id": 2, "date": date(2026, 1, 15), "value": 0.3, "max_sigma": 2.0,
                   "details": details})
    etat[1][0] += 1.0                                # correction manuelle, sans trace
    etat[5] = [50.0, 8.333]                          # fiche creee a son 1er tournoi
    tournoi(12, date(2026, 1, 19), {1: 60, 2: 90, 4: 75, 5: 40, 3: 10}, exclus=(3,))

    donnees = {
        "joueurs": {j: {"nom": "J%d" % j, "mu": m, "sigma": s} for j, (m, s) in etat.items()},
        "naissance": {5: date(2026, 1, 19)},
        "tournois": tournois, "ghosts": ghosts, "resets": resets, "grilles": grilles,
        "ghost_penalty": 0.1, "sigma_threshold": 3.3,
    }
    stock = {(t['id'], p['joueur_id']): p for t in tournois for p in t['participations']}

    print("\n=== rejeu avec les reglages d'origine : l'historique est retrouve ===")
    res = R.rejouer(donnees, date(2026, 1, 1), [(date(2026, 1, 1), TAU)])
    check("3 tournois rejoues", res['nb_tournois'] == 3, res['nb_tournois'])
    check("participations identiques",
          all(PROCHE(m, stock[(t, j)]['mu'], 1e-9) and PROCHE(s, stock[(t, j)]['sigma'], 1e-9)
              and PROCHE(om, stock[(t, j)]['old_mu'], 1e-9)
              for t, j, om, os_, m, s, ts in res['participations']))
    check("fiches finales identiques",
          all(PROCHE(m, etat[j][0], 1e-9) and PROCHE(s, etat[j][1], 1e-9)
              for j, (m, s) in res['joueurs'].items()), res['joueurs'])
    check("la correction manuelle est la seule discontinuite signalee",
          len(res['ecarts']) == 1 and res['ecarts'][0]['joueur_id'] == 1
          and PROCHE(res['ecarts'][0]['delta_mu'], 1.0, 1e-9), res['ecarts'])
    check("penalite fantome reprise a l'identique",
          res['ghosts'] == [(1, ghosts[0]['old_sigma'], ghosts[0]['new_sigma'], 0.1)], res['ghosts'])
    check("reset plafonne : details mis a jour, aucun ajout ni retrait",
          len(res['resets_maj']) == len(details) and not res['resets_ajout']
          and not res['resets_suppr'], (res['resets_maj'], res['resets_ajout']))
    check("la fiche creee apres le reset n'en recoit pas",
          PROCHE(stock[(12, 5)]['old_sigma'], 8.333)
          and all(t != 12 or j != 5 or PROCHE(os_, 8.333)
                  for t, j, om, os_, m, s, ts in res['participations']))
    check("grille du 12/01 identique",
          all(PROCHE(g['mu'], next(x['mu'] for x in grilles[g['date']]
                                   if x['joueur_id'] == g['joueur_id']), 1e-9)
              for g in res['grilles']))
    joueur3 = [x for x in res['participations'] if x[0] == 12 and x[1] == 3][0]
    check("le joueur hors TrueSkill garde ses valeurs", joueur3[2] == joueur3[4]
          and joueur3[3] == joueur3[5])

    print("\n=== rejeu depuis le 12/01 seulement ===")
    res2 = R.rejouer(donnees, date(2026, 1, 12), [(date(2026, 1, 12), TAU)])
    check("2 tournois rejoues, memes valeurs finales",
          res2['nb_tournois'] == 2 and all(PROCHE(m, etat[j][0], 1e-9)
                                           for j, (m, s) in res2['joueurs'].items()))

    print("\n=== tau par periode ===")
    res3 = R.rejouer(donnees, date(2026, 1, 1), [(date(2026, 1, 1), TAU),
                                                 (date(2026, 1, 12), 1.0)])
    t10 = {j: (m, s) for t, j, om, os_, m, s, ts in res3['participations'] if t == 10}
    t11 = {j: (m, s) for t, j, om, os_, m, s, ts in res3['participations'] if t == 11}
    check("avant le changement de tau : inchange",
          all(PROCHE(t10[j][1], stock[(10, j)]['sigma'], 1e-9) for j in t10))
    check("apres : le sigma monte avec le tau",
          all(t11[j][1] > stock[(11, j)]['sigma'] for j in t11), (t11, stock))
    check("la correction manuelle est toujours reportee",
          len(res3['ecarts']) == 1, res3['ecarts'])
    check("les donnees source ne sont pas modifiees",
          donnees['joueurs'][1]['mu'] == etat[1][0] and tournois[0]['participations'][0]['mu']
          == stock[(10, 1)]['mu'])

    print("\n=== resume ===")
    rs = R.resume(donnees, res3)
    check("un joueur par ligne, du plus grand ecart au plus petit",
          len(rs['joueurs']) == 5 and abs(rs['joueurs'][0]['delta_ts'])
          >= abs(rs['joueurs'][-1]['delta_ts']), rs['joueurs'])
    check("discontinuite nommee et datee",
          rs['ecarts'][0]['nom'] == 'J1' and rs['ecarts'][0]['date'] == '2026-01-19', rs['ecarts'])
else:
    print("\n(trueskill absent : calculs non testes, routes seulement)")


# --- Routes -----------------------------------------------------------------
print("\n=== routes : superadmin seulement, saisie verifiee, apercu perime ===")
H = {'X-Session-Token': 'tok'}
SESSION = lambda role: (
    r"FROM sessions_joueurs s JOIN comptes c",
    ligne_session(compte_id=1, discord_id='111', username='a', global_name='A', role=role))


def monter(plan, role='superadmin'):
    cur, conn = install_db(list(plan) + [SESSION(role)])
    recharger()
    for m in ('routes_admin', 'cache', 'services'):
        sys.modules.pop(m, None)
    ecrits = []

    def execute_values(c, sql, argslist, *a, **kw):
        ecrits.append(' '.join(sql.split()))
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


# Ecritures du recalcul (l'authentification touche, elle, a la session).
TABLES_DOSSIER = ('participations', 'joueurs', 'ghost_log', 'global_reset_details',
                  'grille_snapshots')
touche_dossier = lambda s: (s.split()[0].upper() in ('UPDATE', 'INSERT', 'DELETE')
                            and re.search(r'\b(%s)\b' % '|'.join(TABLES_DOSSIER), s, re.I))


CORPS = {"date_debut": "2026-01-01", "periodes": [{"debut": "2026-01-01", "tau": 0.2}]}

cli, cur, conn, _ = monter([], role='chef_admin')
r = cli.post('/api/admin/recalcul-ts/apercu', headers=H, json=CORPS)
check("chef_admin : apercu refuse (403)", r.status_code == 403, r.status_code)
r = cli.post('/api/admin/recalcul-ts/appliquer', headers=H, json=CORPS)
check("chef_admin : application refusee (403)", r.status_code == 403, r.status_code)

cli, cur, conn, _ = monter([])
r = cli.post('/api/admin/recalcul-ts/apercu', headers=H, json={"date_debut": "2026-13-01",
                                                               "periodes": CORPS['periodes']})
check("date illisible -> 400", r.status_code == 400
      and r.get_json().get('code') == 'saisie_invalide', r.get_data(as_text=True))
r = cli.post('/api/admin/recalcul-ts/apercu', headers=H,
             json={"date_debut": "2026-01-01", "periodes": [{"debut": "2026-02-01", "tau": 0.2}]})
check("premiere periode decalee -> 400", r.status_code == 400, r.get_data(as_text=True))
r = cli.post('/api/admin/recalcul-ts/apercu', headers=H,
             json={"date_debut": "2999-01-01", "periodes": [{"debut": "2999-01-01", "tau": 0.2}]})
check("date future -> 400", r.status_code == 400, r.get_data(as_text=True))

if TRUESKILL:
    cli, cur, conn, _ = monter([(r"SELECT md5", ('empreinte-1',))])
    r = cli.post('/api/admin/recalcul-ts/apercu', headers=H, json=CORPS)
    corps = r.get_json() or {}
    check("apercu : 200 avec l'empreinte et le comparatif",
          r.status_code == 200 and corps.get('empreinte') == 'empreinte-1'
          and 'joueurs' in corps and 'ecarts' in corps, r.get_data(as_text=True))
    check("apercu : rien n'est ecrit dans le dossier sportif",
          not any(touche_dossier(s) for s, _ in cur.executed),
          [s for s, _ in cur.executed if touche_dossier(s)])

cli, cur, conn, ecrits = monter([(r"SELECT md5", ('empreinte-2',))])
r = cli.post('/api/admin/recalcul-ts/appliquer', headers=H, json=dict(CORPS, empreinte='empreinte-1'))
check("donnees changees depuis l'apercu -> 409 apercu_perime",
      r.status_code == 409 and r.get_json().get('code') == 'apercu_perime', r.get_data(as_text=True))
check("et rien n'est ecrit", not ecrits
      and not any(touche_dossier(s) or 'audit_admin' in s for s, _ in cur.executed), ecrits)
check("le verrou des tournois est pris avant la comparaison",
      any('pg_advisory_xact_lock' in s for s, _ in cur.executed))

if TRUESKILL:
    cli, cur, conn, ecrits = monter([(r"SELECT md5", ('empreinte-1',))])
    r = cli.post('/api/admin/recalcul-ts/appliquer', headers=H,
                 json=dict(CORPS, empreinte='empreinte-1'))
    check("empreinte a jour -> 200 et commit", r.status_code == 200 and conn.committed,
          r.get_data(as_text=True))
    check("une ligne d'audit ts_recalcule",
          any('INSERT INTO audit_admin' in s and p and p[0] == 'ts_recalcule'
              for s, p in cur.executed))


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
