from __future__ import annotations

import math
import logging
from typing import Any

import psycopg2.extras

from constants import (
    DEFAULT_SIGMA_THRESHOLD,
    RANKED_SIGMA_LIMIT, GHOST_SIGMA_CAP, GHOST_MISSED_THRESHOLD,
    CHILLGUY_DELTA_LIMIT, MIN_PARTICIPATION_RATIO, MIN_TOURNAMENT_RATIO,
    GM_MAX_RATIO_CAP, GM_BASE_WEIGHT, GM_EXTRA_MATCH_BONUS, REFERENCE_PLAYER_COUNT,
)
from db import get_db_connection

logger = logging.getLogger(__name__)


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

                valid_scores = []
                for pid, mu, sigma, is_ranked in all_players:
                    if is_ranked and float(sigma) <= threshold:
                        score = float(mu) - (3 * float(sigma))
                        valid_scores.append(score)

                if len(valid_scores) < 2:
                    mean_score = 0
                    std_dev = 1
                else:
                    mean_score = sum(valid_scores) / len(valid_scores)
                    variance = sum((x - mean_score) ** 2 for x in valid_scores) / len(valid_scores)
                    std_dev = math.sqrt(variance)

                tier_updates = []
                for pid, mu, sigma, is_ranked in all_players:
                    mu_val = float(mu)
                    sigma_val = float(sigma)
                    score = mu_val - (3 * sigma_val)

                    new_tier = 'U'

                    if is_ranked and sigma_val <= threshold:
                        if score > (mean_score + std_dev):
                            new_tier = 'S'
                        elif score > mean_score:
                            new_tier = 'A'
                        elif score > (mean_score - std_dev):
                            new_tier = 'B'
                        else:
                            new_tier = 'C'

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


def _compute_grand_master(stats_dict: dict, total_tournois: int) -> tuple[dict | None, list[dict]]:
    if total_tournois <= 0:
        return None, []

    seuil_participation = total_tournois * MIN_PARTICIPATION_RATIO
    BASE_POIDS = GM_BASE_WEIGHT

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
            ratio = min(GM_MAX_RATIO_CAP, S_i / M_barre_i) if M_barre_i > 0 else 0
            weighted_val = ratio * poids

            num_total += weighted_val
            denom_total += poids

        ip_base = (num_total / denom_total) * 100 if denom_total > 0 else 0

        nb_matchs_joueur = d.get("matchs", 0)
        matchs_extra = max(0, nb_matchs_joueur - seuil_participation)
        bonus = matchs_extra * GM_EXTRA_MATCH_BONUS

        final_score = ip_base + bonus
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


def _aggregate_season_stats(d_debut: str, d_fin: str, recap_mode: str | None = None, specific_ligue_id: int | None = None) -> dict:
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            base_query = """
                SELECT
                    j.id, j.nom, p.score, p.position,
                    p.new_score_trueskill, p.mu, p.sigma,
                    t.date, p.tournoi_id, j.sigma, t.ligue_id
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

        tournoi_meta = {}
        for row in rows:
            tid = row[8]
            score = float(row[2])
            if tid not in tournoi_meta:
                tournoi_meta[tid] = {"sum_score": 0.0, "count": 0}
            tournoi_meta[tid]["count"] += 1
            tournoi_meta[tid]["sum_score"] += score

        for tid, meta in tournoi_meta.items():
            meta["avg_score"] = meta["sum_score"] / meta["count"] if meta["count"] > 0 else 1.0

        total_tournois = len(tournoi_meta)
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
            p["gm_history"].append({
                "tid": tid,
                "date": t_date,
                "score": score,
                "avg_score": t["avg_score"],
                "count": t["count"],
                "ligue_id": ligue_id
            })
            p["final_ts"] = float(new_ts) if new_ts else 0.0

        for pid, d in stats.items():
            d["total_points"] = _calculate_adjusted_total_points(d["gm_history"])

        winner_gm, list_gm = _compute_grand_master(stats, total_tournois)
        advanced_stonks_list = _compute_advanced_stonks(conn, d_debut, d_fin, recap_mode, specific_ligue_id)

        candidates = {
            "grand_master": list_gm,
            "stonks": advanced_stonks_list,
            "not_stonks": advanced_stonks_list,
            "ez": [], "pas_loin": [], "stakhanov": [], "chillguy": []
        }

        for pid, d in stats.items():
            candidates["ez"].append({"id": pid, "nom": d["nom"], "val": d["victoires"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
            candidates["pas_loin"].append({"id": pid, "nom": d["nom"], "val": d["second_places"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})
            candidates["stakhanov"].append({"id": pid, "nom": d["nom"], "val": d["total_points"], "matchs": d["matchs"], "sigma": d["sigma_actuel"]})

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

            entry = {
                "nom": d["nom"],
                "matchs": d["matchs"],
                "total_points": int(round(d["total_points"])),
                "victoires": d["victoires"],
                "final_trueskill": round(d["final_ts"], 3),
                "moyenne_points": round(moyenne_pts, 2),
                "moyenne_position": round(moyenne_pos, 2),
                "score_gm": round(score_gm_val, 2) if score_gm_val is not None else None,
                "is_eligible_gm": bool(is_eligible_val)
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

    algos = ['ez', 'pas_loin', 'stakhanov', 'stonks', 'not_stonks', 'chillguy']

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
