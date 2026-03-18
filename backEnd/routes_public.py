from __future__ import annotations

import math
import statistics
import logging
from math import erf, sqrt
from typing import Any

from flask import Blueprint, jsonify, request, abort, render_template

from constants import DEFAULT_MU, DEFAULT_SIGMA, DEFAULT_SIGMA_THRESHOLD, DEFAULT_PAGE_SIZE
from db import get_db_connection
from cache import get_cached, set_cached
from services import _aggregate_season_stats, _determine_winners

logger = logging.getLogger(__name__)

public_bp = Blueprint('public', __name__)


@public_bp.route('/saisons', methods=['GET'])
def get_public_saisons():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT nom, slug, date_debut, date_fin, is_yearly, ligue_id, ligue_nom, ligue_couleur, is_league_recap
                    FROM saisons WHERE is_active = true
                    ORDER BY date_fin DESC, ligue_id ASC NULLS FIRST
                """)
                saisons = []
                for r in cur.fetchall():
                    nom, slug, d_debut, d_fin, is_yearly, ligue_id, ligue_nom, ligue_couleur, is_league_recap = r
                    saisons.append({
                        "nom": nom, "slug": slug,
                        "date_debut": str(d_debut), "date_fin": str(d_fin),
                        "is_yearly": is_yearly,
                        "ligue_id": ligue_id, "ligue_nom": ligue_nom, "ligue_couleur": ligue_couleur,
                        "is_league_recap": is_league_recap if is_league_recap else False
                    })
        return jsonify(saisons)
    except Exception:
        return jsonify([])


@public_bp.route('/recap')
def recap_list():
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT nom, date_debut, date_fin, slug, victory_condition, is_yearly,
                       ligue_nom, ligue_couleur, is_league_recap
                FROM saisons
                WHERE is_active = true
                ORDER BY date_fin DESC
            """)
            rows = cur.fetchall()
            saisons = [{
                "nom": r[0], "date_debut": r[1], "date_fin": r[2],
                "slug": r[3], "victory_condition": r[4], "is_yearly": r[5],
                "ligue_nom": r[6], "ligue_couleur": r[7],
                "is_league_recap": r[8] if r[8] else False
            } for r in rows]
    return render_template('recap_list.html', saisons=saisons)


def _normal_top_percent(score, mean, stdev):
    z = (score - mean) / stdev
    percentile = 0.5 * (1 + erf(z / sqrt(2))) * 100
    return round(100 - percentile, 1)


@public_bp.route('/stats/recap/<slug>')
def get_recap(slug):
    ligue_id_param = request.args.get('ligue_id', type=int)

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, nom, date_debut, date_fin, slug,
                       config_awards, victory_condition, is_yearly, is_league_recap, ligue_id
                FROM saisons
                WHERE slug = %s
            """, (slug,))
            saison_row = cur.fetchone()
            if not saison_row:
                return jsonify({"error": "Saison introuvable"}), 404

            saison_id, nom, d_debut, d_fin, slug_bdd, config, vic_cond, is_yearly, is_league_recap, saison_ligue_id = saison_row

            ligues_disponibles = []
            ligue_courante = None

            if is_league_recap:
                cur.execute("""
                    SELECT DISTINCT l.id, l.nom, l.couleur, l.niveau
                    FROM Ligues l
                    JOIN Tournois t ON t.ligue_id = l.id
                    WHERE t.date >= %s AND t.date <= %s
                    ORDER BY l.niveau ASC
                """, (d_debut, d_fin))
                ligues_rows = cur.fetchall()
                ligues_disponibles = [
                    {"id": r[0], "nom": r[1], "couleur": r[2], "niveau": r[3]}
                    for r in ligues_rows
                ]

                if ligue_id_param:
                    ligue_courante = next((l for l in ligues_disponibles if l["id"] == ligue_id_param), None)
                if not ligue_courante and ligues_disponibles:
                    ligue_courante = ligues_disponibles[0]

                if ligue_courante:
                    global_stats = _aggregate_season_stats(d_debut, d_fin, 'league', ligue_courante["id"])
                else:
                    global_stats = _aggregate_season_stats(d_debut, d_fin, 'league')
            elif saison_ligue_id:
                global_stats = _aggregate_season_stats(d_debut, d_fin, 'league', saison_ligue_id)
            else:
                global_stats = _aggregate_season_stats(d_debut, d_fin, 'classic')

            cur.execute("SELECT code, nom, emoji, description, id FROM types_awards")
            types_ref = {
                r[0]: {"nom": r[1], "emoji": r[2], "desc": r[3], "id": r[4]}
                for r in cur.fetchall()
            }

            awards_data = {}

            award_ligue_filter = ""
            award_params = [saison_id]
            if is_league_recap and ligue_courante:
                award_ligue_filter = " AND a.ligue_id = %s"
                award_params.append(ligue_courante["id"])
            elif is_league_recap:
                award_ligue_filter = " AND a.ligue_id IS NOT NULL"

            cur.execute(f"""
                SELECT t.code, t.nom, t.emoji, t.description, j.nom, a.valeur,
                       a.is_league_award, a.ligue_id, a.ligue_nom, a.ligue_couleur,
                       l.couleur AS current_ligue_couleur, l.nom AS current_ligue_nom
                FROM awards_obtenus a
                JOIN types_awards t ON a.award_id = t.id
                JOIN joueurs j ON a.joueur_id = j.id
                LEFT JOIN ligues l ON a.ligue_id = l.id
                WHERE a.saison_id = %s{award_ligue_filter}
            """, award_params)
            saved_rows = cur.fetchall()

            if saved_rows:
                for row in saved_rows:
                    code, award_name, emoji, desc, player_name, valeur = row[:6]
                    is_league_award, a_ligue_id, a_ligue_nom, a_ligue_couleur, cur_ligue_couleur, cur_ligue_nom = row[6:]

                    award_entry = {
                        "nom": player_name,
                        "val": valeur,
                        "emoji": emoji,
                        "award_name": award_name,
                        "description": desc
                    }

                    if is_league_award:
                        ligue_supprimee = a_ligue_id is None
                        award_entry["is_league_award"] = True
                        award_entry["ligue_nom"] = cur_ligue_nom if not ligue_supprimee else a_ligue_nom
                        award_entry["ligue_couleur"] = cur_ligue_couleur if not ligue_supprimee else a_ligue_couleur
                        award_entry["ligue_supprimee"] = ligue_supprimee

                    awards_data.setdefault(code, []).append(award_entry)
            else:
                active_list = config.get('active_awards', [])
                top_3, winners_map = _determine_winners(
                    global_stats['candidates'],
                    vic_cond,
                    active_list,
                    global_stats['total_tournois']
                )

                moai_codes = (
                    ['super_gold_moai', 'super_silver_moai', 'super_bronze_moai']
                    if is_yearly else
                    ['gold_moai', 'silver_moai', 'bronze_moai']
                )

                for i in range(min(3, len(top_3))):
                    p = top_3[i]
                    code = moai_codes[i]
                    if code in types_ref:
                        ref = types_ref[code]
                        awards_data.setdefault(code, []).append({
                            "nom": p.get("nom", "?"),
                            "val": f"{p.get('final_score', 0):.3f}",
                            "emoji": ref["emoji"],
                            "award_name": ref["nom"],
                            "description": ref["desc"]
                        })

                for code, winners in winners_map.items():
                    if code in types_ref:
                        ref = types_ref[code]
                        for w in winners:
                            val_fmt = (
                                str(int(w["val"]))
                                if code in ['ez', 'pas_loin', 'stakhanov']
                                else str(round(w["val"], 3))
                            )
                            awards_data.setdefault(code, []).append({
                                "nom": w["nom"],
                                "val": val_fmt,
                                "emoji": ref["emoji"],
                                "award_name": ref["nom"],
                                "description": ref["desc"]
                            })

            if is_league_recap and ligue_courante:
                cur.execute("""
                    SELECT id, date
                    FROM Tournois
                    WHERE date >= %s AND date <= %s AND ligue_id = %s
                    ORDER BY date ASC
                """, (d_debut, d_fin, ligue_courante["id"]))
            elif saison_ligue_id:
                cur.execute("""
                    SELECT id, date
                    FROM Tournois
                    WHERE date >= %s AND date <= %s AND ligue_id = %s
                    ORDER BY date ASC
                """, (d_debut, d_fin, saison_ligue_id))
            else:
                cur.execute("""
                    SELECT id, date
                    FROM Tournois
                    WHERE date >= %s AND date <= %s AND ligue_id IS NULL
                    ORDER BY date ASC
                """, (d_debut, d_fin))
            tournois = cur.fetchall()

            labels = [t[1].strftime("%d/%m") for t in tournois]
            tournoi_ids = [t[0] for t in tournois]

            cur.execute("SELECT id, nom, color FROM Joueurs")
            player_colors = {
                r[0]: {"nom": r[1], "color": r[2] or "#FFFFFF"}
                for r in cur.fetchall()
            }

            datasets = []

            if tournoi_ids:
                cur.execute("""
                    SELECT joueur_id, tournoi_id, new_score_trueskill, old_mu, old_sigma
                    FROM Participations
                    WHERE tournoi_id = ANY(%s)
                """, (tournoi_ids,))
                all_parts = cur.fetchall()

                tid_index = {tid: idx for idx, tid in enumerate(tournoi_ids)}

                players_data = {}
                for jid, tid, new_score, old_mu, old_sigma in all_parts:
                    if jid not in players_data:
                        players_data[jid] = {'parts_map': {}, 'first_idx': 9999, 'initial_score': None}
                    pd = players_data[jid]
                    pd['parts_map'][tid] = float(new_score)
                    idx = tid_index.get(tid)
                    if idx is not None and idx < pd['first_idx'] and old_mu is not None and old_sigma is not None:
                        pd['first_idx'] = idx
                        pd['initial_score'] = float(old_mu) - 3 * float(old_sigma)

                for jid, pd in players_data.items():
                    p_info = player_colors.get(jid)
                    if not p_info:
                        continue

                    data = []
                    current = pd['initial_score']

                    for tid in tournoi_ids:
                        if tid in pd['parts_map']:
                            current = round(pd['parts_map'][tid], 2)
                            data.append(current)
                        else:
                            data.append(round(current, 2) if current is not None else None)

                    datasets.append({
                        "label": p_info["nom"],
                        "data": data,
                        "borderColor": p_info["color"],
                        "backgroundColor": p_info["color"],
                        "borderWidth": 2,
                        "fill": False,
                        "tension": 0.3,
                        "pointRadius": 0,
                        "spanGaps": True
                    })

                datasets.sort(
                    key=lambda d: next((v for v in reversed(d["data"]) if v is not None), 0),
                    reverse=True
                )

            final_scores = [
                p["final_trueskill"]
                for p in global_stats["classement_points"]
                if p["matchs"] > 0
            ]

            dist_data = {"curve": [], "players": []}

            if len(final_scores) > 1:
                mean = statistics.mean(final_scores)
                stdev = statistics.stdev(final_scores) or 1.0

                x_min = mean - 3.5 * stdev
                x_max = mean + 3.5 * stdev
                step = (x_max - x_min) / 120

                x = x_min
                while x <= x_max:
                    y = (1 / (stdev * math.sqrt(2 * math.pi))) * math.exp(
                        -0.5 * ((x - mean) / stdev) ** 2
                    )
                    dist_data["curve"].append({"x": round(x, 2), "y": y})
                    x += step

                for p in global_stats["classement_points"]:
                    if p["matchs"] == 0:
                        continue

                    score = p["final_trueskill"]
                    y_pos = (1 / (stdev * math.sqrt(2 * math.pi))) * math.exp(
                        -0.5 * ((score - mean) / stdev) ** 2
                    )

                    top_pct = _normal_top_percent(score, mean, stdev)

                    color = "#FFFFFF"
                    for info in player_colors.values():
                        if info["nom"] == p["nom"]:
                            color = info["color"]
                            break

                    dist_data["players"].append({
                        "nom": p["nom"],
                        "x": score,
                        "y": y_pos,
                        "color": color,
                        "top_percent": top_pct
                    })

                dist_data["players"].sort(key=lambda k: k["x"], reverse=True)

            response_data = {
                "nom_saison": nom,
                "classement_points": global_stats["classement_points"],
                "classement_moyenne": global_stats["classement_moyenne"],
                "total_tournois": global_stats["total_tournois"],
                "awards": awards_data,
                "victory_condition": vic_cond,
                "chart_data": {
                    "labels": labels,
                    "datasets": datasets
                },
                "distribution_data": dist_data,
                "is_league_recap": is_league_recap if is_league_recap else False
            }

            if is_league_recap:
                response_data["ligues_disponibles"] = ligues_disponibles
                response_data["ligue_courante"] = ligue_courante

            return jsonify(response_data)


@public_bp.route('/stats/recap/<slug>/new-leagues')
def get_new_leagues(slug):
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, is_league_recap, is_active
                FROM saisons WHERE slug = %s
            """, (slug,))
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "Saison introuvable"}), 404

            saison_id, is_league_recap, is_active = row

            if not is_league_recap:
                return jsonify({"error": "Cette saison n'est pas un récap de ligue"}), 400

            cur.execute("""
                SELECT joueur_id, from_ligue_nom, to_ligue_nom, direction
                FROM league_movements
                WHERE saison_id = %s
            """, (saison_id,))
            movements_rows = cur.fetchall()

            movements_by_player = {}
            for joueur_id, from_nom, to_nom, direction in movements_rows:
                movements_by_player[joueur_id] = {
                    "from": from_nom,
                    "to": to_nom,
                    "direction": direction
                }

            cur.execute("SELECT id, nom, couleur, niveau FROM Ligues ORDER BY niveau ASC")
            ligues_rows = cur.fetchall()

            ligues_data = []
            mouvements_summary = []

            for ligue_id, ligue_nom, ligue_couleur, niveau in ligues_rows:
                cur.execute("""
                    SELECT id, nom FROM Joueurs
                    WHERE ligue_id = %s
                    ORDER BY score_trueskill DESC
                """, (ligue_id,))
                joueurs = cur.fetchall()

                joueurs_list = []
                for jid, jnom in joueurs:
                    mouvement_info = movements_by_player.get(jid)
                    joueurs_list.append({
                        "id": jid,
                        "nom": jnom,
                        "mouvement": mouvement_info["direction"] if mouvement_info else None
                    })

                    if mouvement_info:
                        mouvements_summary.append({
                            "nom": jnom,
                            "from": mouvement_info["from"],
                            "to": mouvement_info["to"],
                            "direction": mouvement_info["direction"]
                        })

                ligues_data.append({
                    "id": ligue_id,
                    "nom": ligue_nom,
                    "couleur": ligue_couleur,
                    "niveau": niveau,
                    "joueurs": joueurs_list
                })

            return jsonify({
                "ligues": ligues_data,
                "mouvements_summary": mouvements_summary,
                "is_published": is_active
            })


@public_bp.route('/dernier-tournoi')
def dernier_tournoi():
    try:
        cached = get_cached("dernier_tournoi")
        if cached is not None:
            return jsonify(cached)

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT ligue_id, ligue_nom FROM Tournois ORDER BY date DESC, id DESC LIMIT 1")
                last_record = cur.fetchone()

                if not last_record:
                    return jsonify([])

                is_league_latest = (last_record[0] is not None) or (last_record[1] is not None and last_record[1] != 'Mixte')

                final_data = []

                if is_league_latest:
                    cur.execute("""
                        SELECT DISTINCT ON (t.ligue_nom)
                            t.id, t.date,
                            t.ligue_nom,
                            COALESCE(t.ligue_couleur, l.couleur)
                        FROM Tournois t
                        LEFT JOIN Ligues l ON t.ligue_id = l.id
                        WHERE t.ligue_nom IS NOT NULL AND t.ligue_nom != 'Mixte'
                        ORDER BY t.ligue_nom, t.date DESC
                    """)
                    rows = cur.fetchall()

                    tournois_to_fetch = []
                    for tid, tdate, lnom, lcoul in rows:
                        tournois_to_fetch.append({
                            "id": tid,
                            "date": tdate.strftime("%Y-%m-%d"),
                            "ligue_nom": lnom,
                            "ligue_couleur": lcoul if lcoul else "#FFFFFF",
                            "type": "ligue"
                        })

                    tournois_to_fetch.sort(key=lambda x: x['date'], reverse=True)

                else:
                    cur.execute("SELECT id, date FROM Tournois ORDER BY date DESC, id DESC LIMIT 1")
                    last = cur.fetchone()
                    tournois_to_fetch = [{
                        "id": last[0],
                        "date": last[1].strftime("%Y-%m-%d"),
                        "type": "standard"
                    }]

                for t in tournois_to_fetch:
                    cur.execute("""
                        SELECT Joueurs.nom, Participations.score
                        FROM Participations
                        JOIN Joueurs ON Participations.joueur_id = Joueurs.id
                        WHERE Participations.tournoi_id = %s
                        ORDER BY Participations.score DESC
                    """, (t['id'],))

                    resultats = [{"nom": nom, "score": score} for nom, score in cur.fetchall()]

                    final_data.append({
                        "meta": t,
                        "resultats": resultats
                    })

        set_cached("dernier_tournoi", final_data)
        return jsonify(final_data)
    except Exception as e:
        logger.error(f"Erreur dernier_tournoi: {e}")
        return jsonify({"error": "Erreur serveur"}), 500


@public_bp.route('/classement')
def classement():
    try:
        tier_filtre = request.args.get('tier', None)
        ligue_filtre = request.args.get('ligue', None)
        page = request.args.get('page', type=int)
        limit = request.args.get('limit', DEFAULT_PAGE_SIZE, type=int)

        cache_key = f"classement:{tier_filtre}:{ligue_filtre}"
        cached = get_cached(cache_key)
        if cached is not None and page is None:
            return jsonify(cached)

        query = """
            SELECT
                j.nom, j.mu, j.sigma, j.score_trueskill, j.tier,
                COUNT(p.tournoi_id) as nb_tournois,
                SUM(CASE WHEN p.position = 1 THEN 1 ELSE 0 END) as victoires,
                j.color
            FROM Joueurs j
            LEFT JOIN Participations p ON j.id = p.joueur_id
        """
        params: list[Any] = []
        conditions = []

        if tier_filtre and tier_filtre.upper() in ['S', 'A', 'B', 'C']:
            conditions.append("j.tier = %s")
            params.append(tier_filtre.upper())

        if ligue_filtre:
            try:
                ligue_id_int = int(ligue_filtre)
                conditions.append("j.ligue_id = %s")
                params.append(ligue_id_int)
            except ValueError:
                pass

        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        query += " GROUP BY j.id, j.nom, j.mu, j.sigma, j.score_trueskill, j.tier"
        query += " ORDER BY j.score_trueskill DESC NULLS LAST"

        joueurs = []
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(query, params)
                rows = cur.fetchall()
                total_joueurs = len(rows)
                for index, row in enumerate(rows):
                    nom, mu, sigma, score_trueskill, tier, nb_tournois, victoires, color = row
                    score_ts = round(float(score_trueskill), 3) if score_trueskill is not None else 0.000
                    nb = int(nb_tournois)
                    vic = int(victoires) if victoires else 0
                    ratio = round((vic / nb * 100), 1) if nb > 0 else 0

                    percentile = 0
                    if total_joueurs > 1:
                        rank = index + 1
                        percentile = round(((total_joueurs - rank) / (total_joueurs - 1)) * 100, 1)
                    elif total_joueurs == 1:
                        percentile = 100

                    joueurs.append({
                        "nom": nom,
                        "mu": float(mu),
                        "sigma": float(sigma),
                        "score_trueskill": score_ts,
                        "tier": tier.strip() if tier else "?",
                        "nombre_tournois": nb,
                        "victoires": vic,
                        "ratio_victoires": ratio,
                        "percentile_trueskill": percentile,
                        "color": color if color else "#FFFFFF"
                    })

        if page is None:
            set_cached(cache_key, joueurs)
            return jsonify(joueurs)

        # Pagination optionnelle
        offset = (page - 1) * limit
        paginated = joueurs[offset:offset + limit]
        return jsonify({
            "data": paginated,
            "total": total_joueurs,
            "page": page,
            "limit": limit,
            "pages": math.ceil(total_joueurs / limit) if limit > 0 else 1
        })
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@public_bp.route('/tier-seuils')
def tier_seuils():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'sigma_threshold'")
                res = cur.fetchone()
                threshold = float(res[0]) if res else DEFAULT_SIGMA_THRESHOLD

                cur.execute("SELECT mu, sigma FROM Joueurs WHERE is_ranked = true")
                all_players = cur.fetchall()

                valid_scores = []
                for mu, sigma in all_players:
                    if float(sigma) <= threshold:
                        valid_scores.append(float(mu) - 3 * float(sigma))

                if len(valid_scores) < 2:
                    return jsonify({"S": 0, "A": 0, "B": 0, "C": 0})

                mean_score = sum(valid_scores) / len(valid_scores)
                variance = sum((x - mean_score) ** 2 for x in valid_scores) / len(valid_scores)
                std_dev = math.sqrt(variance)

                return jsonify({
                    "S": round(mean_score + std_dev, 3),
                    "A": round(mean_score, 3),
                    "B": round(mean_score - std_dev, 3),
                    "C": 0
                })
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@public_bp.route('/stats/joueur/<nom>')
def get_joueur_stats(nom):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'sigma_threshold'")
                res_conf = cur.fetchone()
                threshold = float(res_conf[0]) if res_conf else DEFAULT_SIGMA_THRESHOLD

                cur.execute("""
                    SELECT j.id, j.mu, j.sigma, j.score_trueskill, j.tier, j.is_ranked, j.consecutive_missed, j.color,
                           l.nom, l.couleur
                    FROM Joueurs j
                    LEFT JOIN Ligues l ON j.ligue_id = l.id
                    WHERE j.nom = %s
                """, (nom,))
                current_stats = cur.fetchone()

                if not current_stats:
                    return jsonify({"error": "Joueur non trouvé"}), 404

                jid, mu, sigma, score_trueskill, tier, is_ranked, consecutive_missed, color, ligue_nom, ligue_color = current_stats

                safe_ts = float(score_trueskill) if score_trueskill is not None else 0.0
                sigma_val = float(sigma)
                missed_val = int(consecutive_missed) if consecutive_missed is not None else 0

                is_legit = (is_ranked and sigma_val <= threshold)
                top_percent = "?"
                if is_legit:
                    cur.execute("SELECT score_trueskill FROM Joueurs WHERE is_ranked = true AND sigma <= %s", (threshold,))
                    rows = cur.fetchall()
                    valid_scores = [float(r[0]) for r in rows if r[0] is not None]
                    if len(valid_scores) > 1:
                        mean = sum(valid_scores) / len(valid_scores)
                        variance = sum((x - mean) ** 2 for x in valid_scores) / len(valid_scores)
                        std_dev = math.sqrt(variance)
                        if std_dev > 0.0001:
                            z_score = (safe_ts - mean) / std_dev
                            cdf = 0.5 * (1 + math.erf(z_score / math.sqrt(2)))
                            top_val = (1 - cdf) * 100
                            top_percent = round(max(top_val, 0.01), 2)
                        else: top_percent = 50.0
                    elif len(valid_scores) == 1: top_percent = 1.0

                cur.execute("""
                    SELECT t.id, t.date, p.score, p.position, p.new_score_trueskill, p.mu, p.sigma,
                           COALESCE(t.ligue_nom, l.nom),
                           COALESCE(t.ligue_couleur, l.couleur)
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    JOIN Joueurs j ON p.joueur_id = j.id
                    LEFT JOIN Ligues l ON t.ligue_id = l.id
                    WHERE j.nom = %s
                    ORDER BY t.date DESC
                """, (nom,))
                raw_history = cur.fetchall()

                cur.execute("""
                    SELECT g.date, g.old_sigma, g.new_sigma,
                           COALESCE(
                               (SELECT p2.mu FROM Participations p2
                                JOIN Tournois t2 ON p2.tournoi_id = t2.id
                                WHERE p2.joueur_id = g.joueur_id AND t2.date <= g.date
                                ORDER BY t2.date DESC, t2.id DESC LIMIT 1),
                               j.mu
                           ) as mu_at_ghost
                    FROM ghost_log g
                    JOIN Joueurs j ON g.joueur_id = j.id
                    WHERE j.nom = %s
                    ORDER BY g.date DESC
                """, (nom,))
                raw_ghosts = cur.fetchall()

                cur.execute("SELECT date, value_applied FROM global_resets ORDER BY date DESC")
                raw_resets = cur.fetchall()

                historique_data = []
                scores_bruts = []
                positions = []
                victoires = 0

                for tid, date, score, position, hist_ts, h_mu, h_sigma, hist_ligue_nom, hist_ligue_couleur in raw_history:
                    s_val = float(score) if score is not None else 0.0
                    p_val = int(position) if position is not None else 0
                    ts_val = float(hist_ts) if hist_ts is not None else 0.0
                    scores_bruts.append(s_val)
                    positions.append(p_val)
                    if p_val == 1: victoires += 1

                    historique_data.append({
                        "type": "tournoi",
                        "id": tid,
                        "date": date.strftime("%Y-%m-%d"),
                        "score": s_val,
                        "position": p_val,
                        "score_trueskill": round(ts_val, 3),
                        "ligue": hist_ligue_nom if hist_ligue_nom else "N/A",
                        "ligue_couleur": hist_ligue_couleur if hist_ligue_couleur else None
                    })

                for g_date, old_sig, new_sig, current_mu in raw_ghosts:
                    ts_ghost = float(current_mu) - 3 * float(new_sig)
                    penalty_val = round(float(new_sig) - float(old_sig), 3)
                    historique_data.append({
                        "type": "absence", "date": g_date.strftime("%Y-%m-%d"),
                        "score": 0, "position": "-", "score_trueskill": round(ts_ghost, 3),
                        "valeur": penalty_val, "ligue": "-"
                    })

                for r_date, val in raw_resets:
                    val_float = float(val)
                    r_date_only = r_date.date() if hasattr(r_date, 'date') else r_date
                    reset_ts = None
                    for tid, t_date, score, position, hist_ts, _, _, _, _ in raw_history:
                        if t_date <= r_date_only and hist_ts is not None:
                            reset_ts = float(hist_ts) - val_float * 3
                            break

                    if reset_ts is None:
                        continue

                    historique_data.append({
                        "type": "reset", "date": r_date_only.strftime("%Y-%m-%d"),
                        "score": 0, "position": "-", "score_trueskill": round(reset_ts, 3),
                        "valeur": val_float, "ligue": "-"
                    })

                historique_data.sort(key=lambda x: x['date'], reverse=True)

                for i in range(len(historique_data)):
                    if i < len(historique_data) - 1:
                        historique_data[i]['ts_diff'] = round(historique_data[i]['score_trueskill'] - historique_data[i + 1]['score_trueskill'], 3)
                    else:
                        historique_data[i]['ts_diff'] = None

                nb_tournois = len(scores_bruts)
                if nb_tournois > 0:
                    score_moyen = sum(scores_bruts) / nb_tournois
                    meilleur_score = max(scores_bruts)
                    position_moyenne = sum(positions) / nb_tournois
                    ratio_victoires = (victoires / nb_tournois) * 100
                    variance = sum((x - score_moyen) ** 2 for x in scores_bruts) / nb_tournois
                    ecart_type_scores = math.sqrt(variance)
                else:
                    score_moyen = 0; meilleur_score = 0; position_moyenne = 0; ratio_victoires = 0; ecart_type_scores = 0

                progression_recente = 0
                if nb_tournois >= 2:
                    tournois_only = [x for x in historique_data if x['type'] == 'tournoi']
                    if len(tournois_only) >= 2:
                        current_ts_val = tournois_only[0]['score_trueskill']
                        prev_ts_val = tournois_only[1]['score_trueskill']
                        progression_recente = current_ts_val - prev_ts_val

                cur.execute("""
                    SELECT t.emoji, t.nom, t.description, t.code, s.nom AS saison_nom, s.is_yearly,
                           o.is_league_award, o.ligue_nom, o.ligue_couleur, o.ligue_id,
                           l.couleur AS current_couleur, l.nom AS current_nom
                    FROM awards_obtenus o
                    JOIN types_awards t ON o.award_id = t.id
                    JOIN saisons s ON o.saison_id = s.id
                    LEFT JOIN ligues l ON o.ligue_id = l.id
                    WHERE o.joueur_id = %s
                    ORDER BY s.date_fin ASC
                """, (jid,))
                awards_list = []
                award_groups = {}
                for r in cur.fetchall():
                    emoji, nom, description, code, saison_nom, is_yearly = r[:6]
                    is_league_award, a_ligue_nom, a_ligue_couleur, a_ligue_id, cur_couleur, cur_nom = r[6:]

                    ligue_supprimee = is_league_award and a_ligue_id is None
                    ligue_nom_final = cur_nom if (is_league_award and not ligue_supprimee) else a_ligue_nom
                    ligue_couleur_final = cur_couleur if (is_league_award and not ligue_supprimee) else a_ligue_couleur

                    is_moai = 'moai' in code

                    if is_moai:
                        if is_yearly:
                            trophy_desc = description.replace("de l'année", "de l'année " + saison_nom.replace("Année ", ""))
                        else:
                            trophy_desc = description + " " + saison_nom
                        if is_league_award and ligue_nom_final:
                            trophy_desc += "\nObtenu en " + ligue_nom_final
                            if ligue_supprimee:
                                trophy_desc += " (cette ligue n'existe plus)"
                        entry = {"emoji": emoji, "nom": nom, "description": trophy_desc, "count": 1}
                        if is_league_award:
                            entry["is_league_award"] = True
                            entry["ligue_nom"] = ligue_nom_final
                            entry["ligue_couleur"] = ligue_couleur_final
                            entry["ligue_supprimee"] = ligue_supprimee
                        awards_list.append(entry)
                    else:
                        group_key = (emoji, nom, description, bool(is_league_award),
                                     ligue_nom_final if is_league_award else None,
                                     ligue_couleur_final if is_league_award else None,
                                     ligue_supprimee if is_league_award else None)
                        if group_key not in award_groups:
                            desc = description
                            if is_league_award and ligue_nom_final:
                                desc += "\nObtenu en " + ligue_nom_final
                                if ligue_supprimee:
                                    desc += " (cette ligue n'existe plus)"
                            entry = {"emoji": emoji, "nom": nom, "description": desc, "count": 0}
                            if is_league_award:
                                entry["is_league_award"] = True
                                entry["ligue_nom"] = ligue_nom_final
                                entry["ligue_couleur"] = ligue_couleur_final
                                entry["ligue_supprimee"] = ligue_supprimee
                            award_groups[group_key] = entry
                        award_groups[group_key]["count"] += 1
                awards_list.extend(award_groups.values())

                # Palmarès : podiums par ligue
                cur.execute("""
                    SELECT p.position,
                           COALESCE(t.ligue_nom, l.nom) AS ligue_nom,
                           COALESCE(t.ligue_couleur, l.couleur) AS ligue_couleur,
                           COALESCE(t.ligue_id, l.id) AS ligue_id,
                           COALESCE(l2.niveau, 999) AS ligue_niveau
                    FROM Participations p
                    JOIN Tournois t ON p.tournoi_id = t.id
                    LEFT JOIN Ligues l ON t.ligue_id = l.id
                    LEFT JOIN Ligues l2 ON COALESCE(t.ligue_id, l.id) = l2.id
                    WHERE p.joueur_id = %s AND p.position IN (1, 2, 3)
                    ORDER BY ligue_niveau
                """, (jid,))
                podium_rows = cur.fetchall()

                palmares = {}
                has_league_data = False
                for pos, l_nom, l_coul, l_id, l_niv in podium_rows:
                    key = l_nom if l_nom else "__classique__"
                    if l_nom:
                        has_league_data = True
                    if key not in palmares:
                        palmares[key] = {
                            "ligue_nom": l_nom,
                            "ligue_couleur": l_coul,
                            "ligue_niveau": l_niv if l_niv else 999,
                            "gold": 0, "silver": 0, "bronze": 0
                        }
                    if pos == 1:
                        palmares[key]["gold"] += 1
                    elif pos == 2:
                        palmares[key]["silver"] += 1
                    elif pos == 3:
                        palmares[key]["bronze"] += 1

                palmares_list = sorted(palmares.values(), key=lambda x: x["ligue_niveau"])

        return jsonify({
            "stats": {
                "mu": round(float(mu), 3) if mu else DEFAULT_MU,
                "sigma": round(float(sigma), 3) if sigma else DEFAULT_SIGMA,
                "score_trueskill": round(safe_ts, 3),
                "tier": tier.strip() if tier else '?',
                "is_ranked": is_ranked,
                "consecutive_missed": missed_val,
                "nombre_tournois": nb_tournois,
                "victoires": victoires,
                "ratio_victoires": round(ratio_victoires, 1),
                "score_moyen": round(score_moyen, 3),
                "meilleur_score": meilleur_score,
                "ecart_type_scores": round(ecart_type_scores, 3),
                "position_moyenne": round(position_moyenne, 1),
                "progression_recente": round(progression_recente, 3),
                "percentile_trueskill": top_percent,
                "color": color if color else "#FFFFFF",
                "ligue": {"nom": ligue_nom, "couleur": ligue_color} if ligue_nom else None
            },
            "historique": historique_data,
            "awards": awards_list,
            "palmares": palmares_list,
            "has_league_data": has_league_data
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@public_bp.route('/joueurs/noms')
def get_joueur_names():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT nom, ligue_id FROM Joueurs ORDER BY score_trueskill DESC NULLS LAST")
                joueurs = [{"nom": row[0], "ligue_id": row[1]} for row in cur.fetchall()]
        return jsonify(joueurs)
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@public_bp.route('/stats/joueurs', methods=['GET'])
def stats_joueurs():
    try:
        cached = get_cached("stats_joueurs")
        if cached is not None:
            return jsonify(cached)
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT tier FROM joueurs")
                tier_rows = cur.fetchall()
                dist = {'S': 0, 'A': 0, 'B': 0, 'C': 0, 'U': 0}
                for tr in tier_rows:
                    t = tr[0] if tr[0] and tr[0] not in ['Unranked', '?', ''] else 'U'
                    if t in dist: dist[t] += 1
                    else: dist['U'] += 1

                cur.execute("""
                    SELECT
                        j.nom, j.mu, j.sigma, j.tier,
                        COUNT(p.tournoi_id) as nb_tournois,
                        COALESCE(SUM(CASE WHEN p.position = 1 THEN 1 ELSE 0 END), 0) as victoires,
                        AVG(p.score) as score_moyen,
                        j.color
                    FROM joueurs j
                    LEFT JOIN participations p ON j.id = p.joueur_id
                    GROUP BY j.id, j.nom, j.mu, j.sigma, j.tier
                    ORDER BY (j.mu - 3 * j.sigma) DESC;
                """)
                rows = cur.fetchall()

        joueurs = []
        for row in rows:
            mu, sigma = row[1], row[2]
            ts = mu - 3 * sigma
            joueurs.append({
                "nom": row[0],
                "score_trueskill": round(ts, 3),
                "tier": row[3],
                "nombre_tournois": row[4],
                "victoires": row[5],
                "score_moyen": round(float(row[6]), 1) if row[6] else 0.0,
                "color": row[7] if row[7] else "#FFFFFF"
            })

        result = {"joueurs": joueurs, "distribution_tiers": dist}
        set_cached("stats_joueurs", result)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@public_bp.route('/stats/tournois')
def get_tournois_list():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT t.id, t.date, COUNT(p.joueur_id),
                           COALESCE(t.ligue_nom, l.nom),
                           COALESCE(t.ligue_couleur, l.couleur),
                           (SELECT j.nom FROM Participations p2
                            JOIN Joueurs j ON p2.joueur_id = j.id
                            WHERE p2.tournoi_id = t.id
                            ORDER BY p2.score DESC LIMIT 1) as vainqueur
                    FROM Tournois t
                    JOIN Participations p ON t.id = p.tournoi_id
                    LEFT JOIN Ligues l ON t.ligue_id = l.id
                    GROUP BY t.id, t.date, t.ligue_nom, t.ligue_couleur, l.nom, l.couleur
                    ORDER BY t.date DESC
                """)
                tournois = [{
                    "id": r[0],
                    "date": r[1].strftime("%Y-%m-%d"),
                    "nb_joueurs": r[2],
                    "participants": r[2],
                    "ligue_nom": r[3] if r[3] else "N/A",
                    "ligue_couleur": r[4] if r[4] else None,
                    "vainqueur": r[5]
                } for r in cur.fetchall()]
        return jsonify(tournois)
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@public_bp.route('/stats/tournoi/<int:tournoi_id>')
def get_tournoi_details(tournoi_id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT date FROM Tournois WHERE id = %s", (tournoi_id,))
                td = cur.fetchone()
                if not td: abort(404)
                cur.execute("""
                    SELECT j.nom, p.score, p.new_score_trueskill, p.new_tier, p.position, j.color,
                           p.old_mu, p.old_sigma
                    FROM Participations p JOIN Joueurs j ON p.joueur_id = j.id
                    WHERE p.tournoi_id = %s ORDER BY p.position ASC
                """, (tournoi_id,))
                res = []
                for r in cur.fetchall():
                    new_ts = round(float(r[2]), 3) if r[2] else 0
                    old_ts = round(float(r[6]) - 3 * float(r[7]), 3) if r[6] is not None and r[7] is not None else None
                    ts_diff = round(new_ts - old_ts, 3) if old_ts is not None else None
                    res.append({
                        "nom": r[0], "score_tournoi": r[1],
                        "score_trueskill": new_ts,
                        "tier": r[3].strip() if r[3] else "?", "position": r[4],
                        "color": r[5] if r[5] else "#FFFFFF",
                        "ts_diff": ts_diff
                    })
        return jsonify({"date": td[0].strftime("%Y-%m-%d"), "resultats": res})
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@public_bp.route('/ligues', methods=['GET'])
def get_ligues_public():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT l.id, l.nom, l.niveau, l.couleur,
                           j.nom, j.score_trueskill, j.tier
                    FROM Ligues l
                    LEFT JOIN Joueurs j ON j.ligue_id = l.id
                    ORDER BY l.niveau ASC, j.score_trueskill DESC NULLS LAST
                """)
                rows = cur.fetchall()

                ligues_map = {}
                ligues_order = []
                for lid, lnom, lniv, lcoul, jnom, jscore, jtier in rows:
                    if lid not in ligues_map:
                        ligues_map[lid] = {
                            "id": lid, "nom": lnom, "niveau": lniv, "couleur": lcoul,
                            "joueurs": []
                        }
                        ligues_order.append(lid)
                    if jnom:
                        ligues_map[lid]["joueurs"].append({"nom": jnom, "score": jscore, "tier": jtier})

                ligues = [ligues_map[lid] for lid in ligues_order]
        return jsonify(ligues)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@public_bp.route('/health', methods=['GET'])
def health():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('SELECT 1')
        return jsonify({'status': 'healthy'}), 200
    except Exception as e:
        return jsonify({'status': 'unhealthy', 'error': str(e)}), 503
