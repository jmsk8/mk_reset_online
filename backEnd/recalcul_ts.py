"""Notation TrueSkill d'un tournoi et recalcul de l'historique a partir d'une date.

Deux usages :
- `noter` : note un tournoi sans dependre de l'ordre de saisie des ex-aequo.
  Utilise par add_tournament et par le recalcul.
- `rejouer` : recalcule mu/sigma de tout le monde a partir d'une date, avec un
  tau par periode, jusqu'a aujourd'hui. Fonction pure (aucun acces a la base) ;
  `charger` lit la base et `appliquer` ecrit le resultat.

Pourquoi `noter` moyenne les ordres : la librairie trueskill ne relie chaque
joueur qu'au suivant de la liste. Pour deux ex-aequo A et B derriere C, l'ordre
C, A, B pose « C bat A, A = B » et l'ordre C, B, A pose « C bat B, B = A » :
ce ne sont pas les memes contraintes, et le resultat depend de la saisie. On
note donc le tournoi pour chaque ordre possible des ex-aequo et on moyenne.
"""
from __future__ import annotations

import math
import itertools
from datetime import date as _date
from typing import Any

import trueskill

from constants import (
    DEFAULT_MU, DEFAULT_SIGMA, TRUESKILL_BETA, TRUESKILL_DRAW_PROBABILITY,
    GHOST_SIGMA_CAP, DEFAULT_GHOST_PENALTY, DEFAULT_SIGMA_THRESHOLD,
)


def has_tier(is_ranked: bool, sigma: float, threshold: float) -> bool:
    # Meme regle que services.has_tier (non importe : services tire la base).
    return bool(is_ranked) and float(sigma) <= threshold

# Au-dela, on ne parcourt plus toutes les permutations des ex-aequo mais des
# rotations de chaque groupe (chaque joueur passe a chaque place du groupe).
MAX_ORDRES_EGALITES = 120

# Ecart en dessous duquel deux valeurs de l'historique sont tenues pour egales.
EPS = 1e-9
# Ecart a partir duquel une discontinuite de l'historique est signalee.
EPS_SIGNALE = 1e-6

# Bornes du tau saisi pour un recalcul.
TAU_MIN, TAU_MAX = 0.0, 5.0


def environnement(tau: float):
    return trueskill.TrueSkill(mu=DEFAULT_MU, sigma=DEFAULT_SIGMA, beta=TRUESKILL_BETA,
                               tau=tau, draw_probability=TRUESKILL_DRAW_PROBABILITY)


def _ordres(groupes: list[list[int]]) -> list[list[int]]:
    """Ordres de passage a noter : toutes les permutations des ex-aequo, ou
    des rotations si elles sont trop nombreuses."""
    total = 1
    for g in groupes:
        total *= math.factorial(len(g))
    if total <= MAX_ORDRES_EGALITES:
        return [[i for g in combo for i in g]
                for combo in itertools.product(*(itertools.permutations(g) for g in groupes))]
    n = max(len(g) for g in groupes)
    return [[i for g in groupes for i in (g[r % len(g):] + g[:r % len(g)])] for r in range(n)]


def noter(env, joueurs: list[tuple[Any, Any, int]]) -> dict:
    """Note un tournoi. `joueurs` : (cle, rating, score) ; rating a .mu/.sigma.

    Renvoie {cle: rating}. Sans egalite, un seul appel a la librairie, au
    resultat identique a l'ancien calcul. Avec des ex-aequo, moyenne des mu et
    des variances sur tous les ordres possibles des ex-aequo.
    """
    ordre = sorted(range(len(joueurs)), key=lambda i: -joueurs[i][2])  # stable
    groupes, rang = [], {}
    for position, i in enumerate(ordre):
        if groupes and joueurs[groupes[-1][0]][2] == joueurs[i][2]:
            groupes[-1].append(i)
            rang[i] = rang[groupes[-1][0]]
        else:
            groupes.append([i])
            rang[i] = position + 1

    ordres = _ordres(groupes)
    if len(ordres) == 1:
        o = ordres[0]
        res = env.rate([[joueurs[i][1]] for i in o], ranks=[rang[i] for i in o])
        return {joueurs[i][0]: res[k][0] for k, i in enumerate(o)}

    somme_mu = [0.0] * len(joueurs)
    somme_var = [0.0] * len(joueurs)
    for o in ordres:
        res = env.rate([[joueurs[i][1]] for i in o], ranks=[rang[i] for i in o])
        for k, i in enumerate(o):
            somme_mu[i] += res[k][0].mu
            somme_var[i] += res[k][0].sigma ** 2
    n = len(ordres)
    return {
        joueurs[i][0]: trueskill.Rating(mu=somme_mu[i] / n, sigma=math.sqrt(somme_var[i] / n))
        for i in range(len(joueurs))
    }


# ---------------------------------------------------------------------------
# Periodes de tau
# ---------------------------------------------------------------------------

def valider_periodes(date_debut: _date, periodes: Any) -> tuple[list | None, str | None]:
    """[(debut, tau)] trie, ou (None, message). La 1re periode part de date_debut."""
    if not isinstance(periodes, list) or not periodes:
        return None, "Au moins une période de tau est requise."
    propres = []
    for p in periodes:
        if not isinstance(p, dict):
            return None, "Période de tau invalide."
        try:
            debut = _date.fromisoformat(str(p.get('debut')))
        except ValueError:
            return None, "Date de début de période invalide."
        tau = p.get('tau')
        if isinstance(tau, bool) or not isinstance(tau, (int, float)) \
                or not math.isfinite(tau) or not (TAU_MIN <= tau <= TAU_MAX):
            return None, "tau doit être un nombre entre %g et %g." % (TAU_MIN, TAU_MAX)
        propres.append((debut, float(tau)))
    propres.sort()
    if propres[0][0] != date_debut:
        return None, "La première période doit commencer à la date de départ du recalcul."
    if len({d for d, _ in propres}) != len(propres):
        return None, "Deux périodes commencent le même jour."
    return propres, None


def tau_a_la_date(periodes: list, d: _date) -> float:
    tau = periodes[0][1]
    for debut, t in periodes:
        if debut <= d:
            tau = t
    return tau


# ---------------------------------------------------------------------------
# Rejeu (pur)
# ---------------------------------------------------------------------------
#
# `donnees` (voir `charger`) :
#   joueurs  : {jid: {"nom", "mu", "sigma"}}  valeurs actuelles
#   naissance: {jid: date}  premiere apparition connue (participation ou grille)
#   tournois : [{"id", "date", "participations": [{"joueur_id", "score",
#                "exclude", "old_mu", "old_sigma", "mu", "sigma"}]}]
#   ghosts   : [{"id", "tournoi_id", "date", "joueur_id", "old_sigma",
#                "new_sigma", "penalty"}]
#   resets   : [{"id", "date", "value", "max_sigma",
#                "details": {jid: {"id", "old_sigma", "new_sigma"}}}]
#   grilles  : {date: [{"joueur_id", "mu", "sigma", "is_ranked", "tier"}]}
#   ghost_penalty, sigma_threshold : configuration actuelle
#
# Tout ce qui a lieu a partir de `date_debut` est rejoue dans l'ordre :
#   reset global (avant tout tournoi de sa date), grille du jour (avant le
#   premier tournoi), tournoi, puis ses penalites fantome.
# Les resets sans detail (anterieurs au plafond) ajoutaient la valeur a tous
# les joueurs existants : on les rejoue ainsi.
# Toute autre discontinuite de l'historique (correction manuelle, ancien bug)
# est reportee telle quelle, en ecart, sur le nouveau calcul, et signalee.


def _evenements(donnees: dict, date_debut: _date) -> list:
    ev = []
    for r in donnees['resets']:
        if r['date'] >= date_debut:
            ev.append(((r['date'], 0, r['id'], 0), 'R', r))
    for d, lignes in donnees['grilles'].items():
        if d >= date_debut:
            ev.append(((d, 1, 0, 0), 'S', (d, lignes)))
    for t in donnees['tournois']:
        if t['date'] >= date_debut:
            ev.append(((t['date'], 2, t['id'], 0), 'T', t))
    for g in donnees['ghosts']:
        if g['date'] >= date_debut:
            # Penalite rattachee a son tournoi, juste apres lui.
            ev.append(((g['date'], 2, g['tournoi_id'] or 0, 1), 'G', g))
    ev.sort(key=lambda e: e[0])
    return ev


def _existe(donnees: dict, jid, d: _date) -> bool:
    n = donnees['naissance'].get(jid)
    return n is None or n < d


def rejouer(donnees: dict, date_debut: _date, periodes: list,
            notation=noter) -> dict:
    """Recalcule l'historique a partir de date_debut. Ne touche pas `donnees`."""
    ev = _evenements(donnees, date_debut)
    joueurs = donnees['joueurs']

    # --- Etat de chacun juste avant date_debut --------------------------------
    # mu : old_mu de la premiere participation, sinon la valeur actuelle.
    # sigma : valeur « avant » du premier evenement qui l'enregistre, moins les
    # resets sans detail survenus entre date_debut et cet evenement.
    mu0, sigma0, idx_sigma0 = {}, {}, {}
    for k, (_, typ, x) in enumerate(ev):
        if typ == 'T':
            for p in x['participations']:
                j = p['joueur_id']
                mu0.setdefault(j, p['old_mu'])
                if j not in sigma0:
                    sigma0[j], idx_sigma0[j] = p['old_sigma'], k
        elif typ == 'G':
            j = x['joueur_id']
            if j not in sigma0:
                sigma0[j], idx_sigma0[j] = x['old_sigma'], k
        elif typ == 'R':
            for j, det in x['details'].items():
                if j not in sigma0:
                    sigma0[j], idx_sigma0[j] = det['old_sigma'], k

    uniformes = [(k, x) for k, (_, typ, x) in enumerate(ev) if typ == 'R' and not x['details']]

    orig, etat = {}, {}
    for j, info in joueurs.items():
        m = mu0.get(j, info['mu'])
        s = sigma0.get(j, info['sigma'])
        limite = idx_sigma0.get(j, len(ev))
        for k, r in uniformes:
            if k < limite and _existe(donnees, j, r['date']):
                s -= r['value']
        orig[j] = [m, s]
        etat[j] = [m, s]

    ecarts = []  # discontinuites reportees

    def recaler(j, quand, old_mu, old_sigma, origine):
        """Aligne l'historique d'origine sur la valeur enregistree ; reporte
        l'ecart eventuel sur le nouveau calcul."""
        dmu = 0.0 if old_mu is None else old_mu - orig[j][0]
        dsig = old_sigma - orig[j][1]
        if abs(dmu) > EPS or abs(dsig) > EPS:
            if abs(dmu) > EPS_SIGNALE or abs(dsig) > EPS_SIGNALE:
                ecarts.append({"joueur_id": j, "date": quand, "origine": origine,
                               "delta_mu": dmu, "delta_sigma": dsig})
            etat[j][0] += dmu
            etat[j][1] = max(etat[j][1] + dsig, 0.001)
            orig[j][0] += dmu
            orig[j][1] = old_sigma

    participations, ghosts, grilles = [], [], []
    resets_maj, resets_ajout, resets_suppr = [], [], []
    nb_tournois = 0
    seuil = donnees['sigma_threshold']

    for _, typ, x in ev:
        if typ == 'R':
            r = x
            if not r['details']:
                for j in etat:
                    if _existe(donnees, j, r['date']):
                        etat[j][1] += r['value']
                        orig[j][1] += r['value']
                continue
            plafond = r['max_sigma']
            for j, det in r['details'].items():
                recaler(j, r['date'], None, det['old_sigma'], 'reset')
                orig[j][1] = det['new_sigma']
            for j in etat:
                if not _existe(donnees, j, r['date']) and j not in r['details']:
                    continue
                s = etat[j][1]
                concerne = plafond is None or s < plafond
                nouveau = s + r['value'] if plafond is None else min(s + r['value'], plafond)
                det = r['details'].get(j)
                if concerne:
                    etat[j][1] = nouveau
                    if det is not None:
                        resets_maj.append((det['id'], s, nouveau, nouveau - s))
                    else:
                        resets_ajout.append((r['id'], j, s, nouveau, nouveau - s))
                elif det is not None:
                    resets_suppr.append(det['id'])

        elif typ == 'S':
            d, lignes = x
            for ligne in lignes:
                j = ligne['joueur_id']
                if j not in etat:
                    continue
                m, s = etat[j]
                tier = ligne['tier']
                # Seul le statut U compte pour la reference IP : on ne retouche
                # le tier que si le nouveau sigma le fait basculer (meme seuil
                # des deux cotes, pour ne pas reecrire l'effet d'un ancien seuil).
                avant = has_tier(ligne['is_ranked'], ligne['sigma'], seuil)
                apres = has_tier(ligne['is_ranked'], s, seuil)
                if avant and not apres:
                    tier = 'U'
                elif apres and not avant:
                    tier = None  # a calculer sur la grille (voir appliquer)
                grilles.append({"date": d, "joueur_id": j, "mu": m, "sigma": s, "tier": tier,
                                "tier_avant": ligne['tier']})

        elif typ == 'T':
            t = x
            for p in t['participations']:
                recaler(p['joueur_id'], t['date'], p['old_mu'], p['old_sigma'], 'tournoi')
            notes = [p for p in t['participations'] if not p['exclude']]
            nouveaux = {}
            if len(notes) >= 2:
                nb_tournois += 1
                env = environnement(tau_a_la_date(periodes, t['date']))
                nouveaux = notation(env, [
                    (p['joueur_id'],
                     trueskill.Rating(mu=etat[p['joueur_id']][0], sigma=etat[p['joueur_id']][1]),
                     p['score'])
                    for p in notes])
            for p in t['participations']:
                j = p['joueur_id']
                old_m, old_s = etat[j]
                if j in nouveaux:
                    etat[j] = [nouveaux[j].mu, nouveaux[j].sigma]
                participations.append((t['id'], j, old_m, old_s, etat[j][0], etat[j][1],
                                       etat[j][0] - 3 * etat[j][1]))
                orig[j] = [p['mu'] if p['mu'] is not None else p['old_mu'],
                           p['sigma'] if p['sigma'] is not None else p['old_sigma']]

        elif typ == 'G':
            g = x
            j = g['joueur_id']
            if j not in etat:
                continue
            recaler(j, g['date'], None, g['old_sigma'], 'fantome')
            s = etat[j][1]
            # On reprend la penalite enregistree : le plafond n'a pas toujours
            # existe. Seule une penalite ecretee par lui est recalculee avec la
            # regle actuelle.
            if abs(g['new_sigma'] - GHOST_SIGMA_CAP) < EPS:
                penalite = donnees.get('ghost_penalty', DEFAULT_GHOST_PENALTY)
                nouveau = min(s + penalite, GHOST_SIGMA_CAP) if s < GHOST_SIGMA_CAP else s
            else:
                nouveau = s + g['penalty']
            etat[j][1] = nouveau
            ghosts.append((g['id'], s, nouveau, round(nouveau - s, 6)))
            orig[j][1] = g['new_sigma']

    # Ecart final : valeurs actuelles des fiches contre la fin de l'historique.
    aujourd_hui = _date.today()
    for j, info in joueurs.items():
        recaler(j, aujourd_hui, info['mu'], info['sigma'], 'fiche')

    finaux = {j: (m, s) for j, (m, s) in etat.items()}
    return {
        "participations": participations,
        "ghosts": ghosts,
        "resets_maj": resets_maj,
        "resets_ajout": resets_ajout,
        "resets_suppr": resets_suppr,
        "grilles": grilles,
        "joueurs": finaux,
        "ecarts": ecarts,
        "nb_tournois": nb_tournois,
    }


# ---------------------------------------------------------------------------
# Lecture et ecriture
# ---------------------------------------------------------------------------

def _f(x):
    return None if x is None else float(x)


def fiche_neuve(old_mu, old_sigma) -> bool:
    """Vrai si une participation part des valeurs d'une fiche neuve."""
    return (old_mu is not None and old_sigma is not None
            and abs(float(old_mu) - DEFAULT_MU) < 1e-6
            and abs(float(old_sigma) - DEFAULT_SIGMA) < 1e-6)


def charger(cur, date_debut: _date) -> dict:
    """Lit tout ce dont `rejouer` a besoin."""
    cur.execute("SELECT id, nom, mu, sigma FROM Joueurs WHERE mu IS NOT NULL AND sigma IS NOT NULL")
    joueurs = {jid: {"nom": nom, "mu": float(mu), "sigma": float(sigma)}
               for jid, nom, mu, sigma in cur.fetchall()}

    # Date de creation, connue seulement pour une fiche nee a son premier
    # tournoi (valeurs par defaut) ; une trace anterieure (grille) la recule.
    cur.execute("""
        SELECT DISTINCT ON (p.joueur_id) p.joueur_id, t.date, p.old_mu, p.old_sigma,
               (SELECT MIN(g.date) FROM grille_snapshots g WHERE g.joueur_id = p.joueur_id)
        FROM Participations p JOIN Tournois t ON t.id = p.tournoi_id
        ORDER BY p.joueur_id, t.date, t.id
    """)
    naissance = {}
    for jid, d, om, osg, premiere_grille in cur.fetchall():
        if fiche_neuve(om, osg):
            naissance[jid] = min(d, premiere_grille) if premiere_grille else d

    cur.execute("""
        SELECT t.id, t.date, p.joueur_id, p.score, COALESCE(p.exclude_from_ts, false),
               p.old_mu, p.old_sigma, p.mu, p.sigma
        FROM Tournois t JOIN Participations p ON p.tournoi_id = t.id
        WHERE t.date >= %s
        ORDER BY t.date, t.id
    """, (date_debut,))
    tournois, par_id = [], {}
    for tid, d, jid, score, excl, om, osg, m, s in cur.fetchall():
        t = par_id.get(tid)
        if t is None:
            t = par_id[tid] = {"id": tid, "date": d, "participations": []}
            tournois.append(t)
        t['participations'].append({
            "joueur_id": jid, "score": int(score), "exclude": bool(excl),
            "old_mu": _f(om), "old_sigma": _f(osg), "mu": _f(m), "sigma": _f(s),
        })

    cur.execute("""
        SELECT id, tournoi_id, date, joueur_id, old_sigma, new_sigma, penalty_applied
        FROM ghost_log WHERE date >= %s ORDER BY date, tournoi_id, id
    """, (date_debut,))
    ghosts = [{"id": i, "tournoi_id": tid, "date": d, "joueur_id": jid,
               "old_sigma": float(o), "new_sigma": float(n), "penalty": float(p)}
              for i, tid, d, jid, o, n, p in cur.fetchall()]

    cur.execute("""
        SELECT id, date::date, value_applied, max_sigma FROM global_resets
        WHERE date::date >= %s ORDER BY date, id
    """, (date_debut,))
    resets = [{"id": i, "date": d, "value": float(v), "max_sigma": _f(m), "details": {}}
              for i, d, v, m in cur.fetchall()]
    if resets:
        par_reset = {r['id']: r for r in resets}
        cur.execute("""
            SELECT id, reset_id, joueur_id, old_sigma, new_sigma
            FROM global_reset_details WHERE reset_id = ANY(%s)
        """, (list(par_reset),))
        for i, rid, jid, o, n in cur.fetchall():
            par_reset[rid]['details'][jid] = {"id": i, "old_sigma": float(o), "new_sigma": float(n)}

    cur.execute("""
        SELECT date, joueur_id, mu, sigma, is_ranked, tier
        FROM grille_snapshots WHERE date >= %s
    """, (date_debut,))
    grilles: dict = {}
    for d, jid, m, s, rk, tier in cur.fetchall():
        grilles.setdefault(d, []).append({"joueur_id": jid, "mu": float(m), "sigma": float(s),
                                          "is_ranked": bool(rk), "tier": tier})

    cur.execute("SELECT key, value FROM Configuration "
                "WHERE key IN ('ghost_penalty', 'sigma_threshold')")
    conf = dict(cur.fetchall())
    return {
        "joueurs": joueurs, "naissance": naissance, "tournois": tournois,
        "ghosts": ghosts, "resets": resets, "grilles": grilles,
        "ghost_penalty": float(conf.get('ghost_penalty', DEFAULT_GHOST_PENALTY)),
        "sigma_threshold": float(conf.get('sigma_threshold', DEFAULT_SIGMA_THRESHOLD)),
    }


def resume(donnees: dict, resultat: dict, tiers_avant: dict | None = None) -> dict:
    """Comparatif par joueur (valeurs actuelles contre recalculees)."""
    lignes = []
    for j, info in donnees['joueurs'].items():
        m, s = resultat['joueurs'][j]
        ts_avant = info['mu'] - 3 * info['sigma']
        ts_apres = m - 3 * s
        lignes.append({
            "joueur_id": j, "nom": info['nom'],
            "mu_avant": info['mu'], "sigma_avant": info['sigma'], "ts_avant": ts_avant,
            "mu_apres": m, "sigma_apres": s, "ts_apres": ts_apres,
            "delta_ts": ts_apres - ts_avant,
        })
    lignes.sort(key=lambda l: -abs(l['delta_ts']))
    noms = {j: i['nom'] for j, i in donnees['joueurs'].items()}
    ecarts = [dict(e, nom=noms.get(e['joueur_id'], '?'), date=str(e['date']))
              for e in resultat['ecarts']]
    return {
        "nb_tournois": resultat['nb_tournois'],
        "nb_participations": len(resultat['participations']),
        "nb_penalites": len(resultat['ghosts']),
        "joueurs": lignes,
        "ecarts": ecarts,
    }


def appliquer(cur, resultat: dict, execute_values) -> None:
    """Ecrit le resultat de `rejouer`. Appelant : verrou pris, puis commit."""
    if resultat['participations']:
        execute_values(cur, """
            UPDATE Participations AS p SET old_mu = d.old_mu, old_sigma = d.old_sigma,
                mu = d.mu, sigma = d.sigma, new_score_trueskill = d.ts
            FROM (VALUES %s) AS d(tid, jid, old_mu, old_sigma, mu, sigma, ts)
            WHERE p.tournoi_id = d.tid AND p.joueur_id = d.jid
        """, resultat['participations'])
    if resultat['ghosts']:
        execute_values(cur, """
            UPDATE ghost_log AS g SET old_sigma = d.old_sigma, new_sigma = d.new_sigma,
                penalty_applied = d.applied
            FROM (VALUES %s) AS d(id, old_sigma, new_sigma, applied)
            WHERE g.id = d.id
        """, resultat['ghosts'])
    if resultat['resets_maj']:
        execute_values(cur, """
            UPDATE global_reset_details AS r SET old_sigma = d.old_sigma,
                new_sigma = d.new_sigma, delta_applied = d.delta
            FROM (VALUES %s) AS d(id, old_sigma, new_sigma, delta)
            WHERE r.id = d.id
        """, resultat['resets_maj'])
    if resultat['resets_ajout']:
        execute_values(cur, """
            INSERT INTO global_reset_details
                (reset_id, joueur_id, old_sigma, new_sigma, delta_applied)
            VALUES %s
        """, resultat['resets_ajout'])
    if resultat['resets_suppr']:
        cur.execute("DELETE FROM global_reset_details WHERE id = ANY(%s)",
                    (resultat['resets_suppr'],))
    if resultat['grilles']:
        lignes = _tiers_grilles(cur, resultat['grilles'])
        execute_values(cur, """
            UPDATE grille_snapshots AS g SET mu = d.mu, sigma = d.sigma, tier = d.tier
            FROM (VALUES %s) AS d(date, jid, mu, sigma, tier)
            WHERE g.date = d.date AND g.joueur_id = d.jid
        """, lignes)
    if resultat['joueurs']:
        execute_values(cur, """
            UPDATE Joueurs AS j SET mu = d.mu, sigma = d.sigma
            FROM (VALUES %s) AS d(id, mu, sigma)
            WHERE j.id = d.id
        """, [(j, m, s) for j, (m, s) in resultat['joueurs'].items()])


def _tiers_grilles(cur, grilles: list) -> list:
    """Lignes (date, jid, mu, sigma, tier) ; calcule le tier des joueurs qui
    sortent du statut U, sur la distribution de leur grille."""
    from services import load_tiers, compute_distribution_stats, tier_for_score
    a_calculer = {g['date'] for g in grilles if g['tier'] is None}
    tiers = load_tiers(cur) if a_calculer else None
    par_date: dict = {}
    for g in grilles:
        par_date.setdefault(g['date'], []).append(g)
    lignes = []
    for d, gs in par_date.items():
        stats = None
        if d in a_calculer:
            stats = compute_distribution_stats(
                [g['mu'] - 3 * g['sigma'] for g in gs
                 if (g['tier'] or 'U').strip().upper() != 'U' or g['tier'] is None])
        for g in gs:
            tier = g['tier']
            if tier is None:
                tier = (tier_for_score(g['mu'] - 3 * g['sigma'], stats[0], stats[1], tiers)
                        if stats is not None else 'U')
            lignes.append((d, g['joueur_id'], g['mu'], g['sigma'], tier))
    return lignes
