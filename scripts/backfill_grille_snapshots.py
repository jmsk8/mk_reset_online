#!/usr/bin/env python3
"""Reconstitue les grilles figees (table grille_snapshots) des tournois deja joues.

La reference de l'IP v2 est la grille des joueurs telle qu'elle etait juste
avant la generation du premier tournoi d'une journee. Les tournois joues avant
la mise en place du snapshot n'en ont pas : ce script la reconstitue en
rembobinant l'historique.

Methode : on part de l'etat actuel de la table Joueurs et on remonte le temps,
tournoi par tournoi, en annulant exactement ce que la generation avait applique
(mu/sigma via Participations.old_mu/old_sigma, sigma via ghost_log.old_sigma,
compteur d'absence des joueurs non presents). L'etat obtenu juste avant un
tournoi est la grille recherchee ; comme on parcourt en ordre decroissant, c'est
le premier tournoi de chaque journee qui fixe la grille de cette journee.

Le compteur d'absence des joueurs presents est remis a zero a la generation et
n'est donc pas rembobinable : il ressort sous-estime, ce qui ne peut affecter
que le drapeau is_ranked (bascule a unranked_threshold absences d'affilee). Le
critere dominant reste le tier, lui recalcule a partir de mu/sigma exacts.

Les journees qui possedent deja une grille ne sont jamais touchees.

Usage, depuis la racine du projet :
    make ip-backfill                    # ecrit les grilles manquantes
    make ip-backfill DRY=1              # affiche ce qui serait ecrit, sans rien ecrire
    make ip-backfill SINCE=2026-06-19   # remonte plus ou moins loin (defaut ci-dessous)

Equivalent sans make :
    docker compose exec -T backend python - < scripts/backfill_grille_snapshots.py [--dry-run] [--since AAAA-MM-JJ]

Alternative : dumps/dump_2026-08-20_ipv2.sql est le dump du 18/08 avec ces
grilles deja reconstituees, restaurable par make redump DUMP=...
"""
import sys
from datetime import date, datetime

import psycopg2.extras

sys.path.insert(0, '/app')

from constants import DEFAULT_SIGMA_THRESHOLD, DEFAULT_UNRANKED_THRESHOLD
from db import get_db_connection
from services import (
    compute_distribution_stats, has_tier, tier_for_score, trueskill_score,
    _counts_in_reference,
)

# Debut de la saison en cours : avant cette date l'IP v2 n'est pas utilisee et
# la reference retombe sur l'ancien calcul de periode.
DEFAULT_SINCE = date(2026, 6, 19)


def parse_args(argv):
    dry_run = '--dry-run' in argv
    since = DEFAULT_SINCE
    if '--since' in argv:
        since = datetime.strptime(argv[argv.index('--since') + 1], '%Y-%m-%d').date()
    return dry_run, since


def load_state(cur):
    cur.execute("SELECT id, mu, sigma, is_ranked, consecutive_missed FROM Joueurs")
    return {
        jid: {
            "mu": float(mu) if mu is not None else None,
            "sigma": float(sigma) if sigma is not None else None,
            "is_ranked": bool(is_ranked),
            "missed": int(missed or 0),
        }
        for jid, mu, sigma, is_ranked, missed in cur.fetchall()
    }


def load_first_participation(cur):
    cur.execute("""
        SELECT DISTINCT ON (p.joueur_id) p.joueur_id, t.date, t.id
        FROM Participations p
        JOIN Tournois t ON p.tournoi_id = t.id
        ORDER BY p.joueur_id, t.date ASC, t.id ASC
    """)
    return {jid: (d, tid) for jid, d, tid in cur.fetchall()}


def apply_tiers(grid, sigma_threshold):
    """Rejoue recalculate_tiers() sur une grille reconstituee."""
    scores = [
        trueskill_score(p["mu"], p["sigma"])
        for p in grid.values()
        if has_tier(p["is_ranked"], p["sigma"], sigma_threshold)
    ]
    stats = compute_distribution_stats(scores)
    for p in grid.values():
        if stats is not None and has_tier(p["is_ranked"], p["sigma"], sigma_threshold):
            p["tier"] = tier_for_score(trueskill_score(p["mu"], p["sigma"]), stats[0], stats[1])
        else:
            p["tier"] = 'U'
    return grid


def main():
    dry_run, since = parse_args(sys.argv[1:])

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT key, value FROM Configuration WHERE key IN ('sigma_threshold', 'unranked_threshold')")
            conf = dict(cur.fetchall())
            sigma_threshold = float(conf.get('sigma_threshold', DEFAULT_SIGMA_THRESHOLD))
            unranked_limit = int(conf.get('unranked_threshold', DEFAULT_UNRANKED_THRESHOLD))

            cur.execute("SELECT DISTINCT date FROM grille_snapshots")
            already_frozen = {r[0] for r in cur.fetchall()}

            cur.execute("SELECT id, date FROM Tournois ORDER BY date DESC, id DESC")
            tournois = cur.fetchall()

            cur.execute("""
                SELECT tournoi_id, joueur_id, old_mu, old_sigma
                FROM Participations
                WHERE old_mu IS NOT NULL AND old_sigma IS NOT NULL
            """)
            parts_by_tid = {}
            for tid, jid, old_mu, old_sigma in cur.fetchall():
                parts_by_tid.setdefault(tid, []).append((jid, float(old_mu), float(old_sigma)))

            cur.execute("SELECT tournoi_id, joueur_id, old_sigma FROM ghost_log")
            ghosts_by_tid = {}
            for tid, jid, old_sigma in cur.fetchall():
                ghosts_by_tid.setdefault(tid, []).append((jid, float(old_sigma)))

            state = load_state(cur)
            first_part = load_first_participation(cur)

            # Rembobinage : chaque tour de boucle annule un tournoi, l'etat
            # obtenu est celui d'avant sa generation. La journee etant parcourue
            # a l'envers, la derniere ecriture pour une date est bien celle qui
            # precede son premier tournoi.
            snapshots = {}
            for tid, tdate in tournois:
                for jid, old_mu, old_sigma in parts_by_tid.get(tid, []):
                    if jid in state:
                        state[jid]["mu"] = old_mu
                        state[jid]["sigma"] = old_sigma
                for jid, old_sigma in ghosts_by_tid.get(tid, []):
                    if jid in state:
                        state[jid]["sigma"] = old_sigma

                presents = {jid for jid, _, _ in parts_by_tid.get(tid, [])}
                for jid, p in state.items():
                    if jid in presents or p["missed"] <= 0:
                        continue
                    p["missed"] -= 1
                    if not p["is_ranked"] and p["missed"] < unranked_limit:
                        p["is_ranked"] = True

                if tdate < since:
                    break

                # Un joueur n'entre dans la grille que s'il avait deja joue avant ce
                # tournoi : celui qui est cree par cette generation-la n'existait pas
                # encore, et celui qui n'a jamais joue n'a pas de date d'apparition
                # exploitable (il serait de toute facon hors reference, tier 'U').
                grid = {
                    jid: dict(p)
                    for jid, p in state.items()
                    if p["mu"] is not None and p["sigma"] is not None
                    and first_part.get(jid) is not None
                    and first_part[jid] < (tdate, tid)
                }
                snapshots[tdate] = apply_tiers(grid, sigma_threshold)

            pending = sorted(d for d in snapshots if d not in already_frozen)
            skipped = sorted(d for d in snapshots if d in already_frozen)

            for d in skipped:
                print(f"  {d} : deja figee, ignoree")

            rows = []
            for d in pending:
                grid = snapshots[d]
                counted = [
                    p["mu"] for p in grid.values()
                    if _counts_in_reference(p["is_ranked"], p["tier"])
                ]
                ref = sum(counted) / len(counted) if counted else 0.0
                print(f"  {d} : {len(grid):3d} joueurs, {len(counted):3d} dans la reference, mu moyen = {ref:.3f}")
                for jid, p in grid.items():
                    rows.append((d, jid, p["mu"], p["sigma"], p["is_ranked"], p["tier"], 'backfill'))

            if dry_run:
                print(f"\n[dry-run] {len(pending)} journee(s), {len(rows)} ligne(s) non ecrites.")
                return

            if rows:
                psycopg2.extras.execute_values(cur, """
                    INSERT INTO grille_snapshots (date, joueur_id, mu, sigma, is_ranked, tier, source)
                    VALUES %s
                    ON CONFLICT (date, joueur_id) DO NOTHING
                """, rows)
            conn.commit()
            print(f"\n{len(pending)} journee(s) figee(s), {len(rows)} ligne(s) inserees.")


if __name__ == '__main__':
    main()
