#!/usr/bin/env python3
"""Génère un jeu de données de démonstration entièrement fictif.

Émet sur la sortie standard les INSERT à appliquer par-dessus schema.sql
(qui fournit déjà configuration et types_awards). Les classements sont
calculés avec le vrai moteur TrueSkill, donc les courbes de progression et
les tiers du site sont cohérents.

Nécessite le paquet trueskill : à exécuter dans le conteneur backend.
"""
import json
import random
import statistics
from datetime import date, timedelta

import trueskill

SEED = 20260727
DEFAULT_MU = 50.0
DEFAULT_SIGMA = 8.333
SIGMA_THRESHOLD = 4.0
UNRANKED_THRESHOLD = 10

env = trueskill.TrueSkill(
    mu=DEFAULT_MU, sigma=DEFAULT_SIGMA, beta=4.167, tau=0.083, draw_probability=0.1
)

PLAYERS = [
    ("Mario", "#E52521"), ("Luigi", "#43B047"), ("Peach", "#F5A9C7"),
    ("Daisy", "#FF7F00"), ("Yoshi", "#66CC33"), ("Toad", "#F0F0F0"),
    ("Toadette", "#EE6FA0"), ("Birdo", "#FF9EC4"), ("Bowser", "#E8A33D"),
    ("Bowser Jr.", "#7FD4C1"), ("Wario", "#F7D117"), ("Waluigi", "#5B2C87"),
    ("Rosalina", "#B8CDE8"), ("Donkey Kong", "#6B4423"), ("Diddy Kong", "#C8102E"),
    ("Funky Kong", "#F2A900"), ("Koopa", "#3CB44B"), ("Shy Guy", "#D1332E"),
    ("Lakitu", "#7EC8E3"), ("Dry Bones", "#DCDCDC"), ("Dry Bowser", "#4A4A4A"),
    ("King Boo", "#E6E6FA"), ("Petey", "#4CAF50"), ("Wiggler", "#FFB300"),
    ("Lemmy", "#00BCD4"), ("Larry", "#2196F3"), ("Wendy", "#FF4081"),
    ("Ludwig", "#3F51B5"), ("Iggy", "#8BC34A"), ("Morton", "#5D4037"),
]

SEASONS = [
    ("Hiver 2025", "hiver-2025", date(2025, 1, 6), date(2025, 3, 20), False, "stakhanov"),
    ("Printemps 2025", "printemps-2025", date(2025, 3, 24), date(2025, 6, 19), False, "stakhanov"),
    ("Été 2025", "ete-2025", date(2025, 6, 23), date(2025, 9, 18), False, "stakhanov"),
    ("Automne 2025", "automne-2025", date(2025, 9, 22), date(2025, 12, 18), False, "stakhanov"),
    ("Année 2025", "annee-2025", date(2025, 1, 6), date(2025, 12, 18), True, "Indice de Performance"),
    ("Hiver 2026", "hiver-2026", date(2025, 12, 22), date(2026, 3, 19), False, "stakhanov"),
]

CONFIG_AWARDS = json.dumps(
    {"active_awards": ["stakhanov", "pas_loin", "chillguy", "ez", "borderline",
                       "not_stonks", "stonks"]}
)

LIGUES = [(1, "Ligue 0", 0, "#FFD700"), (2, "Ligue 1", 1, "#C0C0C0")]


def sql_str(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def tier_for(score, mean, stdev):
    if score > mean + stdev:
        return "S"
    if score > mean:
        return "A"
    if score > mean - stdev:
        return "B"
    return "C"


def current_tier_stats(ratings, played):
    """Distribution des joueurs classables, comme recalculate_tiers()."""
    scores = [
        r.mu - 3 * r.sigma
        for name, r in ratings.items()
        if r.sigma <= SIGMA_THRESHOLD and played[name] >= UNRANKED_THRESHOLD
    ]
    if len(scores) < 2:
        return None
    return statistics.mean(scores), statistics.stdev(scores) or 1.0


def main():
    rng = random.Random(SEED)

    names = [n for n, _ in PLAYERS]
    colors = dict(PLAYERS)
    player_id = {n: i + 1 for i, n in enumerate(names)}

    # Talent latent : détermine la performance moyenne, invisible dans les données.
    talent = {n: rng.gauss(0, 1) for n in names}
    # Assiduité : certains jouent presque tout, d'autres passent occasionnellement.
    regularity = {n: rng.uniform(0.45, 0.95) for n in names}
    # Trois arrivées tardives : elles restent non classées (tier U), comme un
    # joueur qui rejoint la ligue en cours de saison.
    newcomers = set(names[-3:])
    joined_on = date(2026, 2, 1)

    ratings = {n: env.create_rating() for n in names}
    played = {n: 0 for n in names}

    tournaments = []
    participations = []
    tid = 0

    for _, _, start, end, is_yearly, _ in SEASONS:
        if is_yearly:
            continue
        day = start
        while day <= end:
            if rng.random() < 0.25:  # quelques trous dans le calendrier
                day += timedelta(days=rng.randint(2, 5))
                continue

            available = [n for n in names if n not in newcomers or day >= joined_on]
            pool = [n for n in available if rng.random() < regularity[n]]
            if len(pool) < 6:
                pool = rng.sample(available, 8)
            # Mélanger avant de tronquer : sinon les derniers noms de la liste
            # ne seraient jamais retenus.
            rng.shuffle(pool)
            pool = pool[:12]

            tid += 1
            tournaments.append((tid, day))

            # Performance = talent + aléa de course : le meilleur ne gagne pas toujours.
            perf = {n: talent[n] + rng.gauss(0, 0.9) for n in pool}
            order = sorted(pool, key=lambda n: -perf[n])

            before = {n: ratings[n] for n in order}
            groups = [[ratings[n]] for n in order]
            updated = env.rate(groups, ranks=list(range(len(order))))
            for n, grp in zip(order, updated):
                ratings[n] = grp[0]
                played[n] += 1

            stats = current_tier_stats(ratings, played)
            size = len(order)
            for pos, n in enumerate(order, start=1):
                new = ratings[n]
                old = before[n]
                score = round(60 * (size - pos + 1) / size * rng.uniform(0.82, 1.0))
                ts = new.mu - 3 * new.sigma
                new_tier = tier_for(ts, *stats) if stats else None
                participations.append((
                    player_id[n], tid, score, new.mu, new.sigma, ts, new_tier,
                    pos, old.mu, old.sigma,
                ))

            day += timedelta(days=rng.randint(2, 5))

    # ── Émission SQL ────────────────────────────────────────────────
    out = []
    out.append("-- Jeu de démonstration généré par scripts/generate_example_data.py")
    out.append("-- Données entièrement fictives.")
    out.append("")

    for lid, nom, niveau, couleur in LIGUES:
        out.append(
            f"INSERT INTO public.ligues (id, nom, niveau, couleur) VALUES "
            f"({lid}, {sql_str(nom)}, {niveau}, {sql_str(couleur)});"
        )

    stats = current_tier_stats(ratings, played)
    for n in names:
        r = ratings[n]
        ranked = played[n] >= UNRANKED_THRESHOLD
        ts = r.mu - 3 * r.sigma
        tier = tier_for(ts, *stats) if (stats and ranked and r.sigma <= SIGMA_THRESHOLD) else "U"
        out.append(
            "INSERT INTO public.joueurs "
            "(id, nom, mu, sigma, tier, consecutive_missed, is_ranked, color, ligue_id) VALUES "
            f"({player_id[n]}, {sql_str(n)}, {r.mu:.6f}, {r.sigma:.6f}, {sql_str(tier)}, "
            f"0, {str(ranked).lower()}, {sql_str(colors[n])}, NULL);"
        )

    for t_id, day in tournaments:
        out.append(
            "INSERT INTO public.tournois (id, date, ligue_id, ligue_nom, ligue_couleur) "
            f"VALUES ({t_id}, '{day.isoformat()}', NULL, NULL, NULL);"
        )

    for (jid, t_id, score, mu, sigma, ts, new_tier, pos, old_mu, old_sigma) in participations:
        out.append(
            "INSERT INTO public.participations "
            "(joueur_id, tournoi_id, score, mu, sigma, new_score_trueskill, new_tier, "
            "\"position\", old_mu, old_sigma, exclude_from_ts) VALUES "
            f"({jid}, {t_id}, {score}, {mu:.6f}, {sigma:.6f}, {ts:.6f}, "
            f"{sql_str(new_tier)}, {pos}, {old_mu:.6f}, {old_sigma:.6f}, false);"
        )

    last = len(SEASONS)
    for i, (nom, slug, start, end, is_yearly, victory) in enumerate(SEASONS, start=1):
        out.append(
            "INSERT INTO public.saisons (id, nom, slug, date_debut, date_fin, is_active, "
            "config_awards, victory_condition, is_yearly, ligue_id, ligue_nom, ligue_couleur, "
            "is_league_recap, include_league_stats, include_league_moves) VALUES "
            f"({i}, {sql_str(nom)}, {sql_str(slug)}, '{start.isoformat()}', '{end.isoformat()}', "
            f"true, {sql_str(CONFIG_AWARDS)}::jsonb, {sql_str(victory)}, "
            f"{str(is_yearly).lower()}, NULL, NULL, NULL, false, false, false);"
        )

    # ── Awards, calculés sur les données simulées ───────────────────
    by_tournament = {}
    for p in participations:
        by_tournament.setdefault(p[1], []).append(p)
    t_date = dict(tournaments)

    award_rows = []
    aid = 0
    for sid, (nom, slug, start, end, is_yearly, _) in enumerate(SEASONS, start=1):
        in_season = [
            p for t_id, rows in by_tournament.items() if start <= t_date[t_id] <= end
            for p in rows
        ]
        if not in_season:
            continue

        pts, firsts, seconds, deltas, spread = {}, {}, {}, {}, {}
        for (jid, t_id, score, mu, sigma, ts, _tier, pos, old_mu, old_sigma) in in_season:
            pts[jid] = pts.get(jid, 0) + score
            if pos == 1:
                firsts[jid] = firsts.get(jid, 0) + 1
            if pos == 2:
                seconds[jid] = seconds.get(jid, 0) + 1
            deltas.setdefault(jid, []).append(ts - (old_mu - 3 * old_sigma))
            spread.setdefault(jid, []).append(pos)

        eligible = [j for j in pts if len(spread[j]) >= 5]
        if len(eligible) < 4:
            continue

        progress = {j: sum(deltas[j]) for j in eligible}
        stability = {j: statistics.pstdev(deltas[j]) for j in eligible}
        instability = {j: statistics.pstdev(spread[j]) for j in eligible}

        podium = sorted(eligible, key=lambda j: -pts[j])[:3]
        codes = (["super_gold_moai", "super_silver_moai", "super_bronze_moai"] if is_yearly
                 else ["gold_moai", "silver_moai", "bronze_moai"])
        picks = list(zip(codes, podium, [None, None, None]))
        picks.append(("ez", max(eligible, key=lambda j: firsts.get(j, 0)),
                      str(max(firsts.values()) if firsts else 0)))
        picks.append(("pas_loin", max(eligible, key=lambda j: seconds.get(j, 0)),
                      str(max(seconds.values()) if seconds else 0)))
        picks.append(("stakhanov", max(eligible, key=lambda j: pts[j]), str(max(pts.values()))))
        best = max(eligible, key=lambda j: progress[j])
        picks.append(("stonks", best, f"{progress[best]:+.2f}"))
        worst = min(eligible, key=lambda j: progress[j])
        picks.append(("not_stonks", worst, f"{progress[worst]:+.2f}"))
        calm = min(eligible, key=lambda j: stability[j])
        picks.append(("chillguy", calm, f"{stability[calm]:.3f}"))
        wild = max(eligible, key=lambda j: instability[j])
        picks.append(("borderline", wild, f"{instability[wild]:.3f}"))

        seen = set()
        for code, jid, valeur in picks:
            if (jid, code) in seen:
                continue
            seen.add((jid, code))
            aid += 1
            # created_at explicite : sans ça le DEFAULT now() rendrait chaque
            # régénération différente, et le dump versionné bougerait pour rien.
            award_rows.append(
                "INSERT INTO public.awards_obtenus "
                "(id, joueur_id, saison_id, award_id, valeur, is_league_award, ligue_id, "
                "ligue_nom, ligue_couleur, created_at) SELECT "
                f"{aid}, {jid}, {sid}, id, {sql_str(valeur)}, false, NULL, NULL, NULL, "
                f"'{end.isoformat()} 20:00:00' "
                f"FROM public.types_awards WHERE code = {sql_str(code)};"
            )

    out.extend(award_rows)

    out.append(
        "INSERT INTO public.global_resets (id, date, value_applied, created_at) VALUES "
        "(1, '2025-06-23 09:00:00', 1.5, '2025-06-23 09:00:00'), "
        "(2, '2025-12-22 09:00:00', 1.5, '2025-12-22 09:00:00');"
    )

    for table, col, last_id in (
        ("joueurs", "id", len(names)),
        ("tournois", "id", tid),
        ("saisons", "id", last),
        ("ligues", "id", len(LIGUES)),
        ("awards_obtenus", "id", aid),
        ("global_resets", "id", 2),
    ):
        out.append(
            f"SELECT pg_catalog.setval(pg_get_serial_sequence('public.{table}', '{col}'), "
            f"{last_id}, true);"
        )

    print("\n".join(out))


if __name__ == "__main__":
    main()
