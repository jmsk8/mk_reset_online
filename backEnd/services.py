from __future__ import annotations

import math
import statistics
import logging
from math import erf, sqrt
from typing import Any, Callable, Iterable

import psycopg2.extras

from constants import (
    DEFAULT_SIGMA_THRESHOLD,
    RANKED_SIGMA_LIMIT, GHOST_SIGMA_CAP,
    CHILLGUY_DELTA_LIMIT, BORDERLINE_INSTABILITY_THRESHOLD, BORDERLINE_AWARD_THRESHOLD,
    BORDERLINE_IP_WEIGHT,
    BORDERLINE_JUMP_EXPONENT, BORDERLINE_MIN_TOURNAMENT_SIZE,
    BORDERLINE_MIN_VALID_MATCHES, BORDERLINE_JUMP_WEIGHT, BORDERLINE_LEVEL_BONUS,
    MIN_PARTICIPATION_RATIO, MIN_TOURNAMENT_RATIO,
    GM_MAX_RATIO_CAP, GM_MAX_IP, GM_BASE_WEIGHT_V1, GM_BASE_WEIGHT_V2, GM_EXTRA_MATCH_BONUS, REFERENCE_PLAYER_COUNT,
    IP_V2_FORCE_LOBBY_PER_MU, IP_V2_FORCE_LOBBY_MIN, IP_V2_FORCE_LOBBY_MAX, IP_VERSION_DEFAULT,
    IP_V2_REF_REQUIRE_TIER, IP_V2_REF_REQUIRE_RANKED,
)
from db import get_db_connection

logger = logging.getLogger(__name__)


_CURVE_RESOLUTION = 120
_CURVE_SPREAD = 3.5


def trueskill_score(mu: float, sigma: float) -> float:
    return float(mu) - 3 * float(sigma)


def has_tier(is_ranked: bool, sigma: float, threshold: float) -> bool:
    return bool(is_ranked) and float(sigma) <= threshold


def _gm_base_weight(ip_version: str) -> float:
    return GM_BASE_WEIGHT_V2 if ip_version == "v2" else GM_BASE_WEIGHT_V1


# Moyenne d'un groupe en excluant le joueur concerne, pour ne pas biaiser sa
# propre reference avec son propre niveau.
def _leave_one_out(sum_mu: float, count_mu: int, own_mu: float | None) -> float | None:
    if own_mu is None or count_mu <= 1:
        return None
    return (sum_mu - float(own_mu)) / (count_mu - 1)


# Coefficient de force du lobby (IP v2, voir IP_V2_* dans constants.py) : ecart
# en points de mu entre le lobby et la grille figee du jour du tournoi (toutes
# ligues confondues). Vaut 1.0 si non calculable.
def _force_lobby(mu_moyen_lobby: float | None, mu_moyen_reference: float | None) -> float:
    if mu_moyen_lobby is None or mu_moyen_reference is None:
        return 1.0
    force = 1 + IP_V2_FORCE_LOBBY_PER_MU * (mu_moyen_lobby - mu_moyen_reference)
    return max(IP_V2_FORCE_LOBBY_MIN, min(IP_V2_FORCE_LOBBY_MAX, force))


# Un joueur compte dans la moyenne de reference IP v2 s'il "a un rank" :
# present dans la grille (tier attribue) et pas inactif. Les deux criteres se
# desactivent independamment via IP_V2_REF_* dans constants.py.
def _counts_in_reference(is_ranked: bool, tier: str | None) -> bool:
    if IP_V2_REF_REQUIRE_RANKED and not is_ranked:
        return False
    if IP_V2_REF_REQUIRE_TIER and (tier or 'U').strip().upper() == 'U':
        return False
    return True


# Grilles figees des journees couvertes par la periode (cf grille_snapshots).
# Retourne {date: {"sum": mu cumule, "count": effectif, "mus": {joueur_id: mu}}},
# le detail par joueur servant au leave-one-out.
def _load_reference_grids(cur: Any, d_debut: str, d_fin: str) -> dict:
    cur.execute("""
        SELECT date, joueur_id, mu, is_ranked, tier
        FROM grille_snapshots
        WHERE date >= %s AND date <= %s
    """, [d_debut, d_fin])
    grids: dict = {}
    for d, jid, mu, is_ranked, tier in cur.fetchall():
        if mu is None or not _counts_in_reference(is_ranked, tier):
            continue
        g = grids.setdefault(d, {"sum": 0.0, "count": 0, "mus": {}})
        g["sum"] += float(mu)
        g["count"] += 1
        g["mus"][jid] = float(mu)
    return grids


# Moyenne de reference pour un joueur donne : mu moyen de la grille figee du
# jour, le joueur lui-meme exclu s'il en fait partie (meme principe de
# leave-one-out que pour le lobby). None si la journee n'a pas de grille figee,
# auquel cas l'appelant se rabat sur la moyenne de periode.
def _reference_mu(grid: dict | None, joueur_id: int) -> float | None:
    if not grid or grid["count"] <= 0:
        return None
    own = grid["mus"].get(joueur_id)
    if own is None:
        return grid["sum"] / grid["count"]
    if grid["count"] <= 1:
        return None
    return (grid["sum"] - own) / (grid["count"] - 1)


def compute_distribution_stats(scores: Iterable[float]) -> tuple[float, float] | None:
    scores = list(scores)
    if len(scores) < 2:
        return None
    mean = statistics.mean(scores)
    stdev = statistics.stdev(scores) or 1.0
    return mean, stdev


def tier_thresholds(scores: Iterable[float]) -> dict[str, float]:
    stats = compute_distribution_stats(scores)
    if stats is None:
        return {"S": 0, "A": 0, "B": 0, "C": 0}
    mean, stdev = stats
    return {
        "S": round(mean + stdev, 3),
        "A": round(mean, 3),
        "B": round(mean - stdev, 3),
        "C": 0,
    }


def tier_for_score(score: float, mean: float, stdev: float) -> str:
    if score > mean + stdev:
        return "S"
    if score > mean:
        return "A"
    if score > mean - stdev:
        return "B"
    return "C"


def normal_top_percent(score: float, mean: float, stdev: float) -> float:
    z = (score - mean) / stdev
    percentile = 0.5 * (1 + erf(z / sqrt(2))) * 100
    return round(100 - percentile, 1)


def _normal_pdf(x: float, mean: float, stdev: float) -> float:
    return (1 / (stdev * math.sqrt(2 * math.pi))) * math.exp(-0.5 * ((x - mean) / stdev) ** 2)


def build_distribution(
    players: Iterable[dict],
    score_fn: Callable[[dict], float | None],
) -> dict:
    scored = [(p, score_fn(p)) for p in players]
    scored = [(p, s) for p, s in scored if s is not None]
    stats = compute_distribution_stats(s for _, s in scored)

    dist: dict[str, list] = {"curve": [], "players": []}
    if stats is None:
        return dist
    mean, stdev = stats

    x_min = mean - _CURVE_SPREAD * stdev
    x_max = mean + _CURVE_SPREAD * stdev
    step = (x_max - x_min) / _CURVE_RESOLUTION
    x = x_min
    while x <= x_max:
        dist["curve"].append({"x": round(x, 2), "y": _normal_pdf(x, mean, stdev)})
        x += step

    for p, score in scored:
        dist["players"].append({
            "nom": p.get("nom"),
            "x": score,
            "y": _normal_pdf(score, mean, stdev),
            "color": p.get("color", "#FFFFFF"),
            "top_percent": normal_top_percent(score, mean, stdev),
        })
    dist["players"].sort(key=lambda k: k["x"], reverse=True)
    return dist


def sync_sequences() -> None:
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            tables = ['Joueurs', 'Tournois', 'saisons', 'types_awards', 'awards_obtenus']
            for table in tables:
                try:
                    seq_name = f"public.{table.lower()}_id_seq"
                    query = f"SELECT setval('{seq_name}', (SELECT MAX(id) FROM public.{table}))"
                    cur.execute(query)
                except Exception:
                    conn.rollback()
        conn.commit()


def recalculate_tiers() -> None:
    with get_db_connection() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'sigma_threshold'")
                res = cur.fetchone()
                threshold = float(res[0]) if res else DEFAULT_SIGMA_THRESHOLD

                cur.execute("SELECT id, mu, sigma, is_ranked FROM Joueurs")
                all_players = cur.fetchall()

                valid_scores = [
                    trueskill_score(mu, sigma)
                    for _, mu, sigma, is_ranked in all_players
                    if has_tier(is_ranked, sigma, threshold)
                ]
                stats = compute_distribution_stats(valid_scores)

                tier_updates = []
                for pid, mu, sigma, is_ranked in all_players:
                    if stats is not None and has_tier(is_ranked, sigma, threshold):
                        mean_score, std_dev = stats
                        new_tier = tier_for_score(trueskill_score(mu, sigma), mean_score, std_dev)
                    else:
                        new_tier = 'U'
                    tier_updates.append((pid, new_tier))

                if tier_updates:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET tier = data.tier
                        FROM (VALUES %s) AS data(id, tier)
                        WHERE j.id = data.id
                    """, tier_updates)
            conn.commit()
        except Exception as e:
            logger.error(f"Erreur recalcul tiers: {e}")
            conn.rollback()


# Fige la grille des joueurs pour cette journee, si elle ne l'est pas deja.
# A appeler avant toute modification de mu/sigma : c'est le premier tournoi du
# jour qui definit la reference IP v2, les suivants (session de matchmaking
# scindee en plusieurs lobbies) reutilisent la meme grille.
# L'existence est testee sur la journee entiere, et pas ligne par ligne : sinon
# un joueur cree entre-temps viendrait s'ajouter a une grille deja figee.
def snapshot_grille(cur: Any, date_tournoi: Any) -> bool:
    cur.execute("SELECT 1 FROM grille_snapshots WHERE date = %s LIMIT 1", (date_tournoi,))
    if cur.fetchone():
        return False
    cur.execute("""
        INSERT INTO grille_snapshots (date, joueur_id, mu, sigma, is_ranked, tier, source)
        SELECT %s, id, mu, sigma, COALESCE(is_ranked, true), COALESCE(tier, 'U'), 'live'
        FROM Joueurs
        WHERE mu IS NOT NULL AND sigma IS NOT NULL
    """, (date_tournoi,))
    return True


# Libere la grille figee d'une journee dont plus aucun tournoi ne subsiste,
# pour qu'un tournoi rejoue a cette date reparte de l'etat courant. Tant qu'il
# reste un tournoi ce jour-la, la grille reste valable et n'est pas touchee.
def drop_grille_snapshot_if_orphan(cur: Any, date_tournoi: Any) -> None:
    cur.execute("SELECT 1 FROM Tournois WHERE date = %s LIMIT 1", (date_tournoi,))
    if cur.fetchone():
        return
    cur.execute("DELETE FROM grille_snapshots WHERE date = %s", (date_tournoi,))


def _compute_advanced_stonks(conn: Any, d_debut: str, d_fin: str, recap_mode: str | None = None, specific_ligue_id: int | None = None) -> list[dict]:
    with conn.cursor() as cur:
        ligue_filter = ""
        params = [d_debut, d_fin]
        if recap_mode == 'league' and specific_ligue_id:
            ligue_filter = " AND t.ligue_id = %s"
            params.append(specific_ligue_id)
        elif recap_mode == 'league':
            ligue_filter = " AND t.ligue_id IS NOT NULL"
        elif recap_mode == 'classic':
            ligue_filter = " AND t.ligue_id IS NULL"

        cur.execute(f"""
            SELECT p.joueur_id, j.nom, p.new_score_trueskill, p.sigma, p.old_mu, p.old_sigma, t.date, t.id
            FROM participations p
            JOIN tournois t ON p.tournoi_id = t.id
            JOIN joueurs j ON p.joueur_id = j.id
            WHERE t.date >= %s AND t.date <= %s{ligue_filter}
            ORDER BY p.joueur_id, t.date ASC, t.id ASC
        """, params)
        all_rows = cur.fetchall()

        player_history = {}
        for jid, nom, score, sig, old_mu, old_sigma, t_date, tid in all_rows:
            if jid not in player_history:
                player_history[jid] = {'nom': nom, 'history': []}
            player_history[jid]['history'].append((score, sig, old_mu, old_sigma))

        stonks_list = []

        for jid, data in player_history.items():
            historique = data['history']
            nom = data['nom']
            nb_matchs = len(historique)
            if nb_matchs == 0:
                continue

            baseline_ts = None
            baseline_idx = None
            for idx, (score, sig, old_mu, old_sigma) in enumerate(historique):
                if float(sig) < RANKED_SIGMA_LIMIT:
                    baseline_ts = float(score)
                    baseline_idx = idx
                    break

            if baseline_ts is None and historique:
                first_old_mu, first_old_sigma = historique[0][2], historique[0][3]
                if first_old_mu is not None and first_old_sigma is not None and float(first_old_sigma) < RANKED_SIGMA_LIMIT:
                    baseline_ts = float(first_old_mu) - 3 * float(first_old_sigma)
                    baseline_idx = 0

            if baseline_ts is not None:
                final_ts = float(historique[-1][0])
                final_sigma = float(historique[-1][1])
                delta = final_ts - baseline_ts
                matchs_ranked = nb_matchs - baseline_idx

                stonks_list.append({
                    'id': jid,
                    'nom': nom,
                    'val': delta,
                    'sigma': final_sigma,
                    'matchs': nb_matchs,
                    'matchs_ranked': matchs_ranked
                })

        return stonks_list


def _compute_grand_master(stats_dict: dict, total_tournois: int, ip_version: str = IP_VERSION_DEFAULT) -> tuple[dict | None, list[dict]]:
    if total_tournois <= 0:
        return None, []

    seuil_participation = total_tournois * MIN_PARTICIPATION_RATIO
    BASE_POIDS = _gm_base_weight(ip_version)

    candidates = []

    for pid, d in stats_dict.items():
        num_total = 0.0
        denom_total = 0.0
        matches = d.get("gm_history", [])

        for m in matches:
            S_i = float(m['score'])
            M_barre_i = float(m['avg_score'])
            N_i = float(m['count'])

            poids = N_i + BASE_POIDS
            if ip_version == "v2":
                # M_barre_i exclut le joueur juge (leave-one-out), sinon son propre
                # score tire sa propre reference et amortit artificiellement son ratio.
                denom = m.get('avg_score_excl_self') or M_barre_i
                ratio = min(GM_MAX_RATIO_CAP, S_i / denom) if denom > 0 else 0
                # Le plafond s'applique de nouveau apres la correction de force du
                # lobby : sinon un match deja plafonne en ressortirait au-dessus.
                ratio = min(GM_MAX_RATIO_CAP, ratio * _force_lobby(m.get('avg_old_mu'), m.get('ref_avg_mu')))
            else:
                ratio = min(GM_MAX_RATIO_CAP, S_i / M_barre_i) if M_barre_i > 0 else 0
            weighted_val = ratio * poids

            num_total += weighted_val
            denom_total += poids

        ip_base = (num_total / denom_total) * 100 if denom_total > 0 else 0

        nb_matchs_joueur = d.get("matchs", 0)
        matchs_extra = max(0, nb_matchs_joueur - seuil_participation)
        bonus = matchs_extra * GM_EXTRA_MATCH_BONUS

        final_score = min(GM_MAX_IP, ip_base + bonus)
        is_eligible = (nb_matchs_joueur >= seuil_participation)

        candidates.append({
            "id": pid,
            "nom": d["nom"],
            "nb_matchs": nb_matchs_joueur,
            "ip_base": ip_base,
            "bonus": bonus,
            "final_score": final_score,
            "eligible": is_eligible
        })

    if not candidates:
        return None, []

    candidates.sort(key=lambda x: x["final_score"], reverse=True)

    eligible_candidates = [c for c in candidates if c['eligible']]

    winner_data = None
    if eligible_candidates:
        winner_data = {
            "id": eligible_candidates[0]["id"],
            "nom": eligible_candidates[0]["nom"],
            "val": eligible_candidates[0]["final_score"],
            "details": eligible_candidates[0]
        }

    return winner_data, candidates


def _calculate_adjusted_total_points(match_history: list[dict]) -> float:
    total = 0.0
    for m in match_history:
        score = float(m['score'])
        nb_joueurs = float(m['count'])
        valeur_ponderee = score * (nb_joueurs / REFERENCE_PLAYER_COUNT)
        total += valeur_ponderee
    return total


def _compute_borderline_scores(stats: dict) -> dict[Any, float]:
    g = BORDERLINE_JUMP_EXPONENT
    scores: dict[Any, float] = {}
    for pid, d in stats.items():
        points: list[tuple[Any, float, float]] = []
        for m in d["gm_history"]:
            position = m.get('position')
            nb_joueurs = m.get('count')
            score = m.get('score')
            avg_score = m.get('avg_score')
            if position is None or nb_joueurs is None or score is None or avg_score is None:
                continue
            r = float(position)
            n = float(nb_joueurs)
            if n < BORDERLINE_MIN_TOURNAMENT_SIZE or float(avg_score) <= 0:
                continue
            s_pos = (n - r) / (n - 1)
            ratio = min(GM_MAX_RATIO_CAP, float(score) / float(avg_score))
            s_ip = max(0.0, min(1.0, (ratio - 0.5) / (GM_MAX_RATIO_CAP - 0.5)))
            value = (1 - BORDERLINE_IP_WEIGHT) * s_pos + BORDERLINE_IP_WEIGHT * s_ip
            points.append((m.get('date'), value, s_pos))

        if len(points) < BORDERLINE_MIN_VALID_MATCHES:
            continue

        points.sort(key=lambda p: (p[0] is None, p[0]))
        xs = [v for _, v, _ in points]

        sauts = [abs(xs[i] - xs[i - 1]) for i in range(1, len(xs))]
        jump_base = (sum(saut ** g for saut in sauts) / len(sauts)) ** (1.0 / g)
        median_xs = statistics.median(xs)
        mad_base = 1.4826 * statistics.median([abs(x - median_xs) for x in xs])
        base = BORDERLINE_JUMP_WEIGHT * jump_base + (1 - BORDERLINE_JUMP_WEIGHT) * mad_base

        mean_pos = statistics.mean(s for _, _, s in points)
        damp = max(0.0, 1.0 - base / BORDERLINE_INSTABILITY_THRESHOLD)
        scores[pid] = max(0.0, base - BORDERLINE_LEVEL_BONUS * mean_pos * damp)

    return scores


def compute_ip_evolution(d_debut: str, d_fin: str, recap_mode: str | None = None, specific_ligue_id: int | None = None, ip_version: str = IP_VERSION_DEFAULT) -> dict:
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            ligue_filter = ""
            params: list[Any] = [d_debut, d_fin]
            if recap_mode == 'league' and specific_ligue_id:
                ligue_filter = " AND t.ligue_id = %s"
                params.append(specific_ligue_id)
            elif recap_mode == 'league':
                ligue_filter = " AND t.ligue_id IS NOT NULL"
            elif recap_mode == 'classic':
                ligue_filter = " AND t.ligue_id IS NULL"

            cur.execute(f"""
                SELECT t.id, t.date, t.ligue_id
                FROM tournois t
                WHERE t.date >= %s AND t.date <= %s{ligue_filter}
                ORDER BY t.date ASC, t.id ASC
            """, params)
            tournois = cur.fetchall()

            cur.execute(f"""
                SELECT p.tournoi_id, p.joueur_id, j.nom, j.color, p.score, p.position, p.old_mu
                FROM participations p
                JOIN tournois t ON p.tournoi_id = t.id
                JOIN joueurs j ON p.joueur_id = j.id
                WHERE t.date >= %s AND t.date <= %s{ligue_filter}
            """, params)
            parts = cur.fetchall()

            # Reference IP v2 : grille figee du jour du tournoi, toutes ligues
            # confondues (pas de ligue_filter ici, volontairement).
            ref_grids = _load_reference_grids(cur, d_debut, d_fin)

            # Repli pour les journees sans grille figee : mu moyen de la periode.
            cur.execute("""
                SELECT p.old_mu
                FROM participations p
                JOIN tournois t ON p.tournoi_id = t.id
                WHERE t.date >= %s AND t.date <= %s
            """, [d_debut, d_fin])
            period_sum_mu = 0.0
            period_count_mu = 0
            for (old_mu,) in cur.fetchall():
                if old_mu is not None:
                    period_sum_mu += float(old_mu)
                    period_count_mu += 1

    labels = [d.strftime("%d/%m") for _, d, _ in tournois]
    tournoi_ids = [tid for tid, _, _ in tournois]
    tournoi_dates = {tid: d for tid, d, _ in tournois}
    tid_index = {tid: i for i, tid in enumerate(tournoi_ids)}
    total_tournois = len(tournoi_ids)

    seuil_participation = total_tournois * MIN_PARTICIPATION_RATIO

    meta: dict[int, dict] = {}
    for tid, _jid, _nom, _col, score, _pos, old_mu in parts:
        m = meta.setdefault(tid, {"sum": 0.0, "count": 0, "sum_mu": 0.0, "count_mu": 0})
        m["sum"] += float(score)
        m["count"] += 1
        if old_mu is not None:
            m["sum_mu"] += float(old_mu)
            m["count_mu"] += 1
    for m in meta.values():
        m["avg"] = m["sum"] / m["count"] if m["count"] > 0 else 1.0
        # avg_mu leave-one-out : calcule par joueur plus bas (cf _leave_one_out).

    players: dict[int, dict] = {}
    for tid, jid, nom, color, score, position, old_mu in parts:
        p = players.setdefault(jid, {"nom": nom, "color": color or "#FFFFFF", "by_idx": {}})
        idx = tid_index.get(tid)
        if idx is not None:
            p["by_idx"][idx] = (float(score), position, old_mu)

    datasets = []
    for jid, p in players.items():
        data: list[float | None] = []
        points: list[dict | None] = []
        # v1 et v2 calcules en parallele pour pouvoir afficher les deux dans
        # le tooltip, quelle que soit la version active sur le graphique.
        num_total_v1 = 0.0
        denom_total_v1 = 0.0
        num_total_v2 = 0.0
        denom_total_v2 = 0.0
        matchs = 0
        seen_first = False
        for idx in range(total_tournois):
            entry = p["by_idx"].get(idx)
            point_detail = None
            if entry is not None:
                score, position, own_old_mu = entry
                seen_first = True
                matchs += 1
                t = meta[tournoi_ids[idx]]

                ratio_v1 = min(GM_MAX_RATIO_CAP, score / t["avg"]) if t["avg"] > 0 else 0.0

                # avg_score exclut le joueur juge (leave-one-out), meme principe que
                # pour le mu : sinon son propre score amortit son propre ratio.
                avg_score_excl = _leave_one_out(t["sum"], t["count"], score) or t["avg"]
                ratio_v2_base = min(GM_MAX_RATIO_CAP, score / avg_score_excl) if avg_score_excl > 0 else 0.0
                lobby_avg_mu = _leave_one_out(t["sum_mu"], t["count_mu"], own_old_mu)
                ref_avg_mu = _reference_mu(ref_grids.get(tournoi_dates[tournoi_ids[idx]]), jid)
                if ref_avg_mu is None:
                    ref_avg_mu = _leave_one_out(period_sum_mu, period_count_mu, own_old_mu)
                # Plafond applique apres la correction de force du lobby, comme
                # dans _compute_grand_master.
                ratio_v2 = min(GM_MAX_RATIO_CAP, ratio_v2_base * _force_lobby(lobby_avg_mu, ref_avg_mu))

                poids_v1 = t["count"] + _gm_base_weight("v1")
                poids_v2 = t["count"] + _gm_base_weight("v2")

                num_total_v1 += ratio_v1 * poids_v1
                denom_total_v1 += poids_v1
                num_total_v2 += ratio_v2 * poids_v2
                denom_total_v2 += poids_v2

                point_detail = {
                    "date": tournoi_dates[tournoi_ids[idx]].strftime("%d/%m/%Y"),
                    "position": int(position) if position is not None else None,
                    "score": int(score),
                    "ip_pur_v1": round(ratio_v1 * 100, 2),
                    "ip_pur_v2": round(ratio_v2 * 100, 2),
                }

            if not seen_first:
                data.append(None)
                points.append(None)
                continue

            bonus = max(0, matchs - seuil_participation) * GM_EXTRA_MATCH_BONUS
            ip_base_v1 = (num_total_v1 / denom_total_v1) * 100 if denom_total_v1 > 0 else 0.0
            ip_base_v2 = (num_total_v2 / denom_total_v2) * 100 if denom_total_v2 > 0 else 0.0
            ip_total_v1 = round(min(GM_MAX_IP, ip_base_v1 + bonus), 2)
            ip_total_v2 = round(min(GM_MAX_IP, ip_base_v2 + bonus), 2)
            ip_total = ip_total_v2 if ip_version == "v2" else ip_total_v1
            data.append(ip_total)

            if point_detail is not None:
                point_detail["ip_pur"] = point_detail["ip_pur_v2"] if ip_version == "v2" else point_detail["ip_pur_v1"]
                point_detail["ip_total_v1"] = ip_total_v1
                point_detail["ip_total_v2"] = ip_total_v2
                point_detail["ip_total"] = ip_total
            points.append(point_detail)

        final_ip = next((v for v in reversed(data) if v is not None), 0.0)
        datasets.append({
            "joueur_id": jid,
            "nom": p["nom"],
            "color": p["color"],
            "data": data,
            "points": points,
            "final_ip": final_ip,
            "matchs": matchs,
            "eligible": matchs >= seuil_participation,
        })

    datasets.sort(key=lambda d: d["final_ip"], reverse=True)

    return {"labels": labels, "tournoi_ids": tournoi_ids, "datasets": datasets}


def compute_position_evolution(d_debut: str, d_fin: str, recap_mode: str | None = None, specific_ligue_id: int | None = None) -> dict:
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            ligue_filter = ""
            params: list[Any] = [d_debut, d_fin]
            if recap_mode == 'league' and specific_ligue_id:
                ligue_filter = " AND t.ligue_id = %s"
                params.append(specific_ligue_id)
            elif recap_mode == 'league':
                ligue_filter = " AND t.ligue_id IS NOT NULL"
            elif recap_mode == 'classic':
                ligue_filter = " AND t.ligue_id IS NULL"

            cur.execute(f"""
                SELECT t.id, t.date
                FROM tournois t
                WHERE t.date >= %s AND t.date <= %s{ligue_filter}
                ORDER BY t.date ASC, t.id ASC
            """, params)
            tournois = cur.fetchall()

            cur.execute(f"""
                SELECT p.tournoi_id, p.joueur_id, j.nom, j.color, p.position
                FROM participations p
                JOIN tournois t ON p.tournoi_id = t.id
                JOIN joueurs j ON p.joueur_id = j.id
                WHERE t.date >= %s AND t.date <= %s{ligue_filter}
            """, params)
            parts = cur.fetchall()

    labels = [d.strftime("%d/%m") for _, d in tournois]
    tournoi_ids = [tid for tid, _ in tournois]
    tournoi_dates = {tid: d for tid, d in tournois}
    tid_index = {tid: i for i, tid in enumerate(tournoi_ids)}
    total_tournois = len(tournoi_ids)

    field_size = {}
    for tid, _jid, _nom, _col, _pos in parts:
        field_size[tid] = field_size.get(tid, 0) + 1

    players: dict[int, dict] = {}
    for tid, jid, nom, color, position in parts:
        p = players.setdefault(jid, {"nom": nom, "color": color or "#FFFFFF", "by_idx": {}})
        idx = tid_index.get(tid)
        if idx is not None and position is not None:
            p["by_idx"][idx] = (int(position), field_size.get(tid, 0))

    max_position = 1
    datasets = []
    for jid, p in players.items():
        data: list[int | None] = []
        points: list[dict | None] = []
        sum_pos = 0
        matchs = 0
        wins = 0
        for idx in range(total_tournois):
            entry = p["by_idx"].get(idx)
            if entry is None:
                data.append(None)
                points.append(None)
                continue
            position, nb = entry
            matchs += 1
            sum_pos += position
            if position == 1:
                wins += 1
            if position > max_position:
                max_position = position
            data.append(position)
            points.append({
                "date": tournoi_dates[tournoi_ids[idx]].strftime("%d/%m/%Y"),
                "position": position,
                "nb_joueurs": nb,
            })

        if matchs == 0:
            continue
        datasets.append({
            "joueur_id": jid,
            "nom": p["nom"],
            "color": p["color"],
            "data": data,
            "points": points,
            "moyenne_position": round(sum_pos / matchs, 2),
            "victoires": wins,
            "matchs": matchs,
        })

    datasets.sort(key=lambda d: (d["moyenne_position"], -d["victoires"]))

    return {"labels": labels, "tournoi_ids": tournoi_ids, "datasets": datasets, "max_position": max_position}


def compute_position_breakdown(d_debut: str, d_fin: str, recap_mode: str | None = None, specific_ligue_id: int | None = None) -> dict:
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            ligue_filter = ""
            params: list[Any] = [d_debut, d_fin]
            if recap_mode == 'league' and specific_ligue_id:
                ligue_filter = " AND t.ligue_id = %s"
                params.append(specific_ligue_id)
            elif recap_mode == 'league':
                ligue_filter = " AND t.ligue_id IS NOT NULL"
            elif recap_mode == 'classic':
                ligue_filter = " AND t.ligue_id IS NULL"

            cur.execute(f"""
                SELECT p.joueur_id, j.nom, j.color, p.position
                FROM participations p
                JOIN tournois t ON p.tournoi_id = t.id
                JOIN joueurs j ON p.joueur_id = j.id
                WHERE t.date >= %s AND t.date <= %s{ligue_filter}
            """, params)
            parts = cur.fetchall()

    players: dict[int, dict] = {}
    max_position = 1
    for jid, nom, color, position in parts:
        if position is None:
            continue
        position = int(position)
        if position > max_position:
            max_position = position
        p = players.setdefault(jid, {"nom": nom, "color": color or "#FFFFFF", "counts": {}, "matchs": 0})
        p["counts"][position] = p["counts"].get(position, 0) + 1
        p["matchs"] += 1

    rows = []
    for jid, p in players.items():
        counts = p["counts"]
        podiums = counts.get(1, 0) + counts.get(2, 0) + counts.get(3, 0)
        rows.append({
            "joueur_id": jid,
            "nom": p["nom"],
            "color": p["color"],
            "matchs": p["matchs"],
            "podiums": podiums,
            "counts": [counts.get(pos, 0) for pos in range(1, max_position + 1)],
        })

    rows.sort(key=lambda r: (r["counts"][0], podiums_key(r)), reverse=True)

    return {"max_position": max_position, "rows": rows}


def podiums_key(row: dict) -> tuple:
    c = row["counts"]
    return (c[1] if len(c) > 1 else 0, c[2] if len(c) > 2 else 0)


def _aggregate_season_stats(d_debut: str, d_fin: str, recap_mode: str | None = None, specific_ligue_id: int | None = None, ip_version: str = IP_VERSION_DEFAULT) -> dict:
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            base_query = """
                SELECT
                    j.id, j.nom, p.score, p.position,
                    p.new_score_trueskill, p.mu, p.sigma,
                    t.date, p.tournoi_id, j.sigma, t.ligue_id, p.old_mu
                FROM Participations p
                JOIN Tournois t ON p.tournoi_id = t.id
                JOIN Joueurs j ON p.joueur_id = j.id
                WHERE t.date >= %s AND t.date <= %s
            """
            params = [d_debut, d_fin]

            if recap_mode == 'league' and specific_ligue_id:
                base_query += " AND t.ligue_id = %s"
                params.append(specific_ligue_id)
            elif recap_mode == 'league':
                base_query += " AND t.ligue_id IS NOT NULL"
            elif recap_mode == 'classic':
                base_query += " AND t.ligue_id IS NULL"

            base_query += " ORDER BY t.date ASC, p.tournoi_id ASC"
            cur.execute(base_query, params)
            rows = cur.fetchall()

            # Reference IP v2 : grille figee du jour du tournoi, toutes ligues
            # confondues (pas de filtre ligue ici, volontairement).
            ref_grids = _load_reference_grids(cur, d_debut, d_fin)

            # Repli pour les journees sans grille figee : mu moyen de la periode.
            cur.execute("""
                SELECT p.old_mu
                FROM Participations p
                JOIN Tournois t ON p.tournoi_id = t.id
                WHERE t.date >= %s AND t.date <= %s
            """, [d_debut, d_fin])
            period_sum_mu = 0.0
            period_count_mu = 0
            for (old_mu,) in cur.fetchall():
                if old_mu is not None:
                    period_sum_mu += float(old_mu)
                    period_count_mu += 1

        tournoi_meta = {}
        session_keys = {}
        for row in rows:
            tid = row[8]
            score = float(row[2])
            old_mu = row[11]
            if tid not in tournoi_meta:
                tournoi_meta[tid] = {"sum_score": 0.0, "count": 0, "sum_mu": 0.0, "count_mu": 0}
                # Une session (ex: matchmaking qui scinde un gros groupe) peut generer
                # plusieurs tournois le meme jour dans la meme ligue. On les regroupe
                # ici comme pour la penalisation d'absence (cf routes_admin.py).
                session_keys[tid] = (row[7], row[10])
            tournoi_meta[tid]["count"] += 1
            tournoi_meta[tid]["sum_score"] += score
            if old_mu is not None:
                tournoi_meta[tid]["sum_mu"] += float(old_mu)
                tournoi_meta[tid]["count_mu"] += 1

        for tid, meta in tournoi_meta.items():
            meta["avg_score"] = meta["sum_score"] / meta["count"] if meta["count"] > 0 else 1.0
            # avg_old_mu leave-one-out : calcule par joueur plus bas (cf _leave_one_out).

        total_tournois = len(set(session_keys.values()))
        min_participation_req = total_tournois * MIN_PARTICIPATION_RATIO

        stats = {}
        for row in rows:
            pid = row[0]
            nom = row[1]
            score = float(row[2])
            position = int(row[3])
            new_ts = row[4]
            t_date = row[7]
            tid = row[8]
            current_sigma = row[9]
            ligue_id = row[10]
            own_old_mu = row[11]

            if pid not in stats:
                stats[pid] = {
                    "id": pid, "nom": nom,
                    "matchs": 0,
                    "raw_total_points": 0.0,
                    "total_points": 0.0,
                    "total_position": 0,
                    "victoires": 0, "second_places": 0,
                    "final_ts": 0.0,
                    "sigma_actuel": float(current_sigma),
                    "gm_history": []
                }

            p = stats[pid]
            p["matchs"] += 1
            p["raw_total_points"] += float(score)
            p["total_position"] += int(position)
            if position == 1: p["victoires"] += 1
            if position == 2: p["second_places"] += 1

            t = tournoi_meta[tid]
            ref_avg_mu = _reference_mu(ref_grids.get(t_date), pid)
            if ref_avg_mu is None:
                ref_avg_mu = _leave_one_out(period_sum_mu, period_count_mu, own_old_mu)
            p["gm_history"].append({
                "tid": tid,
                "date": t_date,
                "score": score,
                "position": position,
                "avg_score": t["avg_score"],
                "avg_score_excl_self": _leave_one_out(t["sum_score"], t["count"], score),
                "count": t["count"],
                "avg_old_mu": _leave_one_out(t["sum_mu"], t["count_mu"], own_old_mu),
                "ref_avg_mu": ref_avg_mu,
                "ligue_id": ligue_id
            })
            p["final_ts"] = float(new_ts) if new_ts else 0.0

        for pid, d in stats.items():
            d["total_points"] = _calculate_adjusted_total_points(d["gm_history"])

        winner_gm, list_gm = _compute_grand_master(stats, total_tournois, ip_version)
        advanced_stonks_list = _compute_advanced_stonks(conn, d_debut, d_fin, recap_mode, specific_ligue_id)
        borderline_scores = _compute_borderline_scores(stats)

        candidates = {
            "grand_master": list_gm,
            "stonks": advanced_stonks_list,
            "not_stonks": advanced_stonks_list,
            "ez": [], "pas_loin": [], "stakhanov": [], "chillguy": [], "borderline": []
        }

        for pid, d in stats.items():
            candidates["ez"].append({"id": pid, "nom": d["nom"], "val": d["victoires"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
            candidates["pas_loin"].append({"id": pid, "nom": d["nom"], "val": d["second_places"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
            candidates["stakhanov"].append({"id": pid, "nom": d["nom"], "val": d["total_points"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})

            if pid in borderline_scores:
                candidates["borderline"].append({"id": pid, "nom": d["nom"], "val": borderline_scores[pid], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})

            player_stonks = next((x for x in advanced_stonks_list if x['id'] == pid), None)
            if player_stonks:
                 candidates["chillguy"].append({"id": pid, "nom": d["nom"], "val": abs(player_stonks['val']), "matchs": d["matchs"], "matchs_ranked": player_stonks.get('matchs_ranked', d["matchs"]), "sigma": d["sigma_actuel"]})

        gm_score_map = { item['id']: item['final_score'] for item in list_gm }

        classement_points = []
        classement_moyenne = []

        for pid, d in stats.items():
            moyenne_pts = d["raw_total_points"] / d["matchs"] if d["matchs"] > 0 else 0.0
            moyenne_pos = d["total_position"] / d["matchs"] if d["matchs"] > 0 else 0.0

            score_gm_val = gm_score_map.get(pid)
            is_eligible_val = (d["matchs"] >= min_participation_req)

            bl_val = borderline_scores.get(pid)

            entry = {
                "nom": d["nom"],
                "matchs": d["matchs"],
                "total_points": int(round(d["total_points"])),
                "victoires": d["victoires"],
                "final_trueskill": round(d["final_ts"], 3),
                "moyenne_points": round(moyenne_pts, 2),
                "moyenne_position": round(moyenne_pos, 2),
                "score_gm": round(score_gm_val, 2) if score_gm_val is not None else None,
                "is_eligible_gm": bool(is_eligible_val),
                "borderline_score": round(bl_val, 3) if bl_val is not None else None
            }
            classement_points.append(entry)
            classement_moyenne.append(entry)

        classement_points.sort(key=lambda x: (x['total_points'], x['victoires']), reverse=True)

        classement_moyenne.sort(
            key=lambda x: (
                x['is_eligible_gm'],
                (x['score_gm'] if x['score_gm'] is not None else -1)
            ),
            reverse=True
        )

        return {
            "classement_points": classement_points,
            "classement_moyenne": classement_moyenne,
            "candidates": candidates,
            "total_tournois": total_tournois
        }


def _determine_winners(candidates: dict, vic_cond: str, active_awards: list[str], total_tournois: int) -> tuple[list[dict], dict]:
    winners_map = {}
    top_3_players = []

    if vic_cond == 'grand_master' or vic_cond == 'Indice de Performance':
        raw_list = candidates.get('grand_master', [])
        top_3_players = [c for c in raw_list if c.get('eligible', False)]
    elif vic_cond == 'ez':
        sorted_list = sorted(candidates.get('ez', []), key=lambda x: x['val'], reverse=True)
        top_3_players = [{"id": x['id'], "final_score": x['val'], "nom": x['nom']} for x in sorted_list]
    elif vic_cond == 'stakhanov':
        sorted_list = sorted(candidates.get('stakhanov', []), key=lambda x: x['val'], reverse=True)
        top_3_players = [{"id": x['id'], "final_score": x['val'], "nom": x['nom']} for x in sorted_list]
    elif vic_cond == 'stonks':
        filtered = [c for c in candidates.get('stonks', []) if float(c['sigma']) < RANKED_SIGMA_LIMIT]
        sorted_list = sorted(filtered, key=lambda x: x['val'], reverse=True)
        top_3_players = [{"id": x['id'], "final_score": x['val'], "nom": x['nom']} for x in sorted_list]

    algos = ['ez', 'pas_loin', 'stakhanov', 'stonks', 'not_stonks', 'chillguy', 'borderline']

    for code in algos:
        if (code not in active_awards) or (code == vic_cond):
            continue

        raw_list = candidates.get(code, [])
        award_winners = []

        if code == 'ez':
            if raw_list:
                m = max(c['val'] for c in raw_list)
                if m > 0: award_winners = [c for c in raw_list if c['val'] == m]

        elif code == 'pas_loin':
            ez_candidates = candidates.get('ez', [])
            if ez_candidates:
                max_ez = max([x['val'] for x in ez_candidates] or [0])
                ez_winners_ids = [c['id'] for c in ez_candidates if c['val'] == max_ez]
            else:
                ez_winners_ids = []

            filtered = [c for c in raw_list if c['id'] not in ez_winners_ids]
            if filtered:
                m = max(c['val'] for c in filtered)
                if m > 0: award_winners = [c for c in filtered if c['val'] == m]

        elif code == 'stakhanov':
            if raw_list:
                award_winners = [sorted(raw_list, key=lambda x: x['val'], reverse=True)[0]]

        elif code == 'stonks':
            valid = [c for c in raw_list if float(c['sigma']) < RANKED_SIGMA_LIMIT and c.get('matchs_ranked', c['matchs']) >= (total_tournois * MIN_TOURNAMENT_RATIO)]
            if valid:
                w = sorted(valid, key=lambda x: x['val'], reverse=True)[0]
                if w['val'] > 0.001: award_winners = [w]

        elif code == 'not_stonks':
            valid = [c for c in raw_list if float(c['sigma']) < RANKED_SIGMA_LIMIT and c.get('matchs_ranked', c['matchs']) >= (total_tournois * MIN_TOURNAMENT_RATIO)]
            if valid:
                w = sorted(valid, key=lambda x: x['val'], reverse=False)[0]
                if w['val'] < -0.001: award_winners = [w]

        elif code == 'chillguy':
            valid = [c for c in raw_list if float(c['sigma']) < RANKED_SIGMA_LIMIT and c.get('matchs_ranked', c['matchs']) >= (total_tournois * MIN_TOURNAMENT_RATIO) and c['val'] < CHILLGUY_DELTA_LIMIT]
            if valid:
                award_winners = [sorted(valid, key=lambda x: x['val'], reverse=False)[0]]

        elif code == 'borderline':
            valid = [c for c in raw_list if float(c['sigma']) < RANKED_SIGMA_LIMIT and c.get('matchs_ranked', c['matchs']) >= (total_tournois * MIN_PARTICIPATION_RATIO) and c['val'] > BORDERLINE_AWARD_THRESHOLD]
            if valid:
                award_winners = [max(valid, key=lambda x: x['val'])]

        if award_winners:
            winners_map[code] = award_winners

    return top_3_players, winners_map


def _save_awards_to_db(conn: Any, season_id: int, top_3: list[dict], special_winners_map: dict, is_yearly: bool, ligue_info: dict | None = None) -> None:
    with conn.cursor() as cur:
        if ligue_info:
            cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s AND ligue_id = %s", (season_id, ligue_info['id']))
        else:
            cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s AND ligue_id IS NULL", (season_id,))

        cur.execute("SELECT code, id FROM types_awards")
        types_map = {r[0]: r[1] for r in cur.fetchall()}

        is_league = ligue_info is not None
        l_id = ligue_info['id'] if ligue_info else None
        l_nom = ligue_info['nom'] if ligue_info else None
        l_couleur = ligue_info['couleur'] if ligue_info else None

        moai_codes = ['super_gold_moai', 'super_silver_moai', 'super_bronze_moai'] if is_yearly else ['gold_moai', 'silver_moai', 'bronze_moai']

        for i in range(min(3, len(top_3))):
            player = top_3[i]
            code_award = moai_codes[i]
            if code_award in types_map:
                valeur_str = str(player['final_score'])
                if isinstance(player.get('final_score'), float):
                    valeur_str = f"{player['final_score']:.3f}"

                cur.execute("""
                    INSERT INTO awards_obtenus (joueur_id, saison_id, award_id, valeur, is_league_award, ligue_id, ligue_nom, ligue_couleur)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (player['id'], season_id, types_map[code_award], valeur_str, is_league, l_id, l_nom, l_couleur))

        for code, winners in special_winners_map.items():
            if code in types_map:
                award_id = types_map[code]
                for w in winners:
                    val_str = str(int(w['val'])) if code in ['ez', 'pas_loin', 'stakhanov'] else str(round(w['val'], 3))
                    cur.execute("""
                        INSERT INTO awards_obtenus (joueur_id, saison_id, award_id, valeur, is_league_award, ligue_id, ligue_nom, ligue_couleur)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """, (w['id'], season_id, award_id, val_str, is_league, l_id, l_nom, l_couleur))

        cur.execute("UPDATE saisons SET is_active = true WHERE id = %s", (season_id,))
    conn.commit()


def _apply_inter_league_moves(conn: Any, moves_count: int, ranking_data: dict, rankings_by_ligue: dict | None = None) -> list[dict]:
    if moves_count <= 0:
        return []

    movements = []

    with conn.cursor() as cur:
        cur.execute("SELECT id, nom, niveau FROM Ligues ORDER BY niveau ASC")
        ligues = cur.fetchall()

        if len(ligues) < 2:
            return []

        for i in range(len(ligues) - 1):
            ligue_haute_id, ligue_haute_nom, _ = ligues[i]
            ligue_basse_id, ligue_basse_nom, _ = ligues[i + 1]

            ranking_haute = rankings_by_ligue.get(ligue_haute_id, {}) if rankings_by_ligue else ranking_data
            ranking_basse = rankings_by_ligue.get(ligue_basse_id, {}) if rankings_by_ligue else ranking_data

            cur.execute("SELECT id, nom FROM Joueurs WHERE ligue_id = %s", (ligue_haute_id,))
            joueurs_haute = cur.fetchall()

            joueurs_haute_sorted = sorted(
                joueurs_haute,
                key=lambda j: ranking_haute.get(j[0], float('inf')),
                reverse=True
            )
            relegues = joueurs_haute_sorted[:moves_count]

            cur.execute("SELECT id, nom FROM Joueurs WHERE ligue_id = %s", (ligue_basse_id,))
            joueurs_basse = cur.fetchall()

            joueurs_basse_sorted = sorted(
                joueurs_basse,
                key=lambda j: ranking_basse.get(j[0], float('inf'))
            )
            promus = joueurs_basse_sorted[:moves_count]

            for jid, jnom in relegues:
                cur.execute("UPDATE Joueurs SET ligue_id = %s WHERE id = %s", (ligue_basse_id, jid))
                movements.append({
                    "joueur_id": jid,
                    "nom": jnom,
                    "from": ligue_haute_nom,
                    "to": ligue_basse_nom,
                    "direction": "relegation"
                })

            for jid, jnom in promus:
                cur.execute("UPDATE Joueurs SET ligue_id = %s WHERE id = %s", (ligue_haute_id, jid))
                movements.append({
                    "joueur_id": jid,
                    "nom": jnom,
                    "from": ligue_basse_nom,
                    "to": ligue_haute_nom,
                    "direction": "promotion"
                })

    return movements
