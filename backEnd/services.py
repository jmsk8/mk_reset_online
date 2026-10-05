from __future__ import annotations

import hashlib
import json
import math
import statistics
import logging
from math import erf, sqrt
from typing import Any, Callable, Iterable

import psycopg2.extras

import audit

from constants import (
    DEFAULT_SIGMA_THRESHOLD,
    DEFAULT_TIERS, DEFAULT_TIER_U_COULEUR,
    RANKED_SIGMA_LIMIT, GHOST_SIGMA_CAP,
    CHILLGUY_DELTA_LIMIT, BORDERLINE_INSTABILITY_THRESHOLD, BORDERLINE_AWARD_THRESHOLD,
    BORDERLINE_IP_WEIGHT,
    BORDERLINE_JUMP_EXPONENT, BORDERLINE_MIN_TOURNAMENT_SIZE,
    BORDERLINE_MIN_VALID_MATCHES, BORDERLINE_JUMP_WEIGHT, BORDERLINE_LEVEL_BONUS,
    MIN_PARTICIPATION_RATIO, MIN_TOURNAMENT_RATIO,
    GM_MAX_RATIO_CAP, GM_MAX_IP, GM_BASE_WEIGHT_V1, GM_BASE_WEIGHT_V2, GM_EXTRA_MATCH_BONUS, REFERENCE_PLAYER_COUNT,
    IP_V2_FORCE_LOBBY_PER_MU, IP_V2_FORCE_LOBBY_MIN, IP_V2_FORCE_LOBBY_MAX, IP_VERSION_DEFAULT,
    IP_V2_REF_REQUIRE_TIER, IP_V2_REF_REQUIRE_RANKED,
    MAX_PAR_LOBBY,
    PURGE_INVITATIONS_JOURS, PURGE_COMPTES_PENDING_JOURS, PURGE_LIAISONS_REFUSEES_JOURS,
)
from db import get_db_connection

logger = logging.getLogger(__name__)


_CURVE_RESOLUTION = 120
_CURVE_SPREAD = 3.5


# ---------------------------------------------------------------------------
# Nom d'une fiche joueur
# ---------------------------------------------------------------------------

def empreinte_nom(nom: str) -> str:
    """sha256 du nom nettoye et en minuscules, stocke dans `noms_interdits`."""
    return hashlib.sha256(nom.strip().lower().encode('utf-8')).hexdigest()


def nom_creable(cur: Any, nom: Any, exclure_id: int | None = None):
    """Verifie qu'un nom de fiche est utilisable.

    Renvoie (nom_propre, None) ou (None, erreur) ; `erreur` est un dict pret pour
    jsonify et l'appelant repond 409. `exclure_id` ignore la fiche elle-meme lors
    d'un renommage.
    """
    nom = (nom if isinstance(nom, str) else '').strip()[:255]
    if not nom:
        return None, {"error": "Le nom est vide", "code": "nom_vide"}

    if '/' in nom:
        # Flask ne route pas un nom contenant un slash (/stats/joueur/<nom>).
        return None, {"error": "Le nom contient un « / », incompatible avec l'URL publique",
                      "code": "nom_invalide"}

    cur.execute("SELECT 1 FROM noms_interdits WHERE nom_hash = %s", (empreinte_nom(nom),))
    if cur.fetchone() is not None:
        return None, {"error": "Ce nom correspond à une identité retirée et ne peut pas "
                               "être recréé",
                      "code": "nom_interdit"}

    # La contrainte UNIQUE est sensible a la casse.
    if exclure_id is None:
        cur.execute("SELECT id, nom FROM joueurs WHERE lower(nom) = lower(%s)", (nom,))
    else:
        cur.execute("SELECT id, nom FROM joueurs WHERE lower(nom) = lower(%s) AND id <> %s",
                    (nom, exclure_id))
    collision = cur.fetchone()
    if collision is not None:
        return None, {"error": "La fiche « %s » existe déjà." % collision[1],
                      "code": "nom_deja_pris",
                      "joueur_en_conflit": {"id": collision[0], "nom": collision[1]}}

    return nom, None


def trueskill_score(mu: float, sigma: float) -> float:
    return float(mu) - 3 * float(sigma)


def has_tier(is_ranked: bool, sigma: float, threshold: float) -> bool:
    return bool(is_ranked) and float(sigma) <= threshold


def _gm_base_weight(ip_version: str) -> float:
    return GM_BASE_WEIGHT_V2 if ip_version == "v2" else GM_BASE_WEIGHT_V1


# Moyenne d'un groupe sans le joueur concerne.
def _leave_one_out(sum_mu: float, count_mu: int, own_mu: float | None) -> float | None:
    if own_mu is None or count_mu <= 1:
        return None
    return (sum_mu - float(own_mu)) / (count_mu - 1)


# Force du lobby (IP v2) : ecart de mu avec la grille figee du jour, 1.0 si
# non calculable.
def _force_lobby(mu_moyen_lobby: float | None, mu_moyen_reference: float | None) -> float:
    if mu_moyen_lobby is None or mu_moyen_reference is None:
        return 1.0
    force = 1 + IP_V2_FORCE_LOBBY_PER_MU * (mu_moyen_lobby - mu_moyen_reference)
    return max(IP_V2_FORCE_LOBBY_MIN, min(IP_V2_FORCE_LOBBY_MAX, force))


# Joueurs pris en compte dans la reference IP v2.
def _counts_in_reference(is_ranked: bool, tier: str | None) -> bool:
    if IP_V2_REF_REQUIRE_RANKED and not is_ranked:
        return False
    if IP_V2_REF_REQUIRE_TIER and (tier or 'U').strip().upper() == 'U':
        return False
    return True


# {date: {"sum": mu cumule, "count": effectif, "mus": {joueur_id: mu}}}
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


# Mu moyen de la grille du jour sans le joueur ; None si pas de grille.
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


def load_tiers(cur) -> list[dict]:
    """Tiers tries par rang decroissant, ou DEFAULT_TIERS si la table est vide."""
    cur.execute("SELECT id, nom, couleur, seuil_k, rang, couleur_texte FROM tiers ORDER BY rang DESC")
    rows = cur.fetchall()
    if not rows:
        # id None : defaut non persiste.
        return [dict(t, id=None) for t in DEFAULT_TIERS]
    return [
        {"id": i, "nom": n, "couleur": c, "couleur_texte": ct, "seuil_k": k, "rang": r}
        for i, n, c, k, r, ct in rows
    ]


def load_couleur_u(cur) -> str:
    """Couleur de la pastille U (non classe)."""
    cur.execute("SELECT value FROM Configuration WHERE key = 'tier_u_couleur'")
    row = cur.fetchone()
    return row[0] if row and row[0] else DEFAULT_TIER_U_COULEUR


def texte_lisible(couleur: str) -> str:
    """Noir ou blanc selon le contraste avec `couleur` (meme calcul que le front)."""
    h = (couleur or '').lstrip('#')
    h = ''.join(c * 2 for c in h[:3]) if len(h) in (3, 4) else h[:6]
    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return '#0A0A0A'
    return '#0A0A0A' if (0.299 * r + 0.587 * g + 0.114 * b) > 150 else '#FFFFFF'


def load_couleur_texte_u(cur, fond: str) -> str:
    """Couleur du texte de la pastille U ; sans reglage, lisible sur `fond`."""
    cur.execute("SELECT value FROM Configuration WHERE key = 'tier_u_couleur_texte'")
    row = cur.fetchone()
    return row[0] if row and row[0] else texte_lisible(fond)


def tier_thresholds(scores: Iterable[float], tiers: list[dict]) -> dict[str, float]:
    """Score-frontiere (mean + seuil_k*stdev) de chaque tier ; 0 pour le plancher.

    `tiers` doit etre trie par rang decroissant.
    """
    stats = compute_distribution_stats(scores)
    seuils = {t["nom"]: 0 for t in tiers}
    if stats is None:
        return seuils
    mean, stdev = stats
    for t in tiers:
        if t["seuil_k"] is not None:
            seuils[t["nom"]] = round(mean + t["seuil_k"] * stdev, 3)
    return seuils


def tier_for_score(score: float, mean: float, stdev: float, tiers: list[dict]) -> str:
    """Premier tier dont le score-frontiere est depasse, sinon le dernier.

    `tiers` doit etre trie par rang decroissant.
    """
    if not tiers:
        return 'U'
    for t in tiers:
        if t["seuil_k"] is not None and score > mean + t["seuil_k"] * stdev:
            return t["nom"]
    return tiers[-1]["nom"]


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

    dist: dict = {"curve": [], "players": []}
    if stats is None:
        return dist
    mean, stdev = stats
    # Renvoyes pour que le front place les seuils sans les recalculer.
    dist["mean"] = mean
    dist["stdev"] = stdev

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


# Tables dont la sequence est resynchronisee au demarrage (utile apres la
# restauration d'un dump avec des id explicites).
_TABLES_A_SEQUENCE = [
    'Joueurs', 'Tournois', 'sessions_tournois', 'saisons', 'types_awards', 'awards_obtenus',
]


def sync_sequences() -> None:
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            for table in _TABLES_A_SEQUENCE:
                try:
                    # COALESCE : MAX(id) est NULL sur une table vide.
                    cur.execute(
                        f"SELECT setval('public.{table.lower()}_id_seq',"
                        f" COALESCE((SELECT MAX(id) FROM public.{table}), 1))"
                    )
                except Exception:
                    # Table absente (migration pas encore passee).
                    logger.warning("sync_sequences : sequence de %s non synchronisee", table)
                    conn.rollback()
        conn.commit()


def recalculate_tiers() -> None:
    with get_db_connection() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'sigma_threshold'")
                res = cur.fetchone()
                threshold = float(res[0]) if res else DEFAULT_SIGMA_THRESHOLD

                tiers = load_tiers(cur)

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
                        new_tier = tier_for_score(
                            trueskill_score(mu, sigma), mean_score, std_dev, tiers
                        )
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


# A appeler avant toute modification de mu/sigma : le premier tournoi du jour
# fige la grille de reference IP v2 pour toute la journee.
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


# Supprime la grille d'une journee qui n'a plus aucun tournoi.
def drop_grille_snapshot_if_orphan(cur: Any, date_tournoi: Any) -> None:
    cur.execute("SELECT 1 FROM Tournois WHERE date = %s LIMIT 1", (date_tournoi,))
    if cur.fetchone():
        return
    cur.execute("DELETE FROM grille_snapshots WHERE date = %s", (date_tournoi,))


# Supprime une session que plus aucun tournoi ne reference (session_id lue
# avant la suppression du tournoi).
def drop_session_if_orphan(cur: Any, session_id: Any) -> None:
    if session_id is None:
        return
    cur.execute("SELECT 1 FROM Tournois WHERE session_id = %s LIMIT 1", (session_id,))
    if cur.fetchone():
        return
    cur.execute("DELETE FROM sessions_tournois WHERE id = %s", (session_id,))


# Cle du verrou consultatif des ecritures en masse du dossier sportif (ajout,
# annulation, suppression, liaison de tournoi, reset global).
VERROU_TOURNOIS = 7_300_001


# Serialise ces ecritures jusqu'a la fin de la transaction. A appeler avant
# toute lecture servant au calcul.
def verrou_tournois(cur: Any) -> None:
    cur.execute("SELECT pg_advisory_xact_lock(%s)", (VERROU_TOURNOIS,))


# Vrai si un autre tournoi de la meme ligue existe dans cette session : seul le
# premier tournoi d'une session compte les absences.
def session_a_un_autre_tournoi(cur: Any, session_id: Any, tournoi_id: Any,
                               ligue_id: Any) -> bool:
    if session_id is None:
        return False
    cur.execute("""
        SELECT 1 FROM Tournois
        WHERE session_id = %s AND id <> %s
          AND (ligue_id = %s OR (%s IS NULL AND ligue_id IS NULL))
        LIMIT 1
    """, (session_id, tournoi_id, ligue_id, ligue_id))
    return cur.fetchone() is not None


# Nombre de joueurs cites dans un message de conflit (affichage seulement).
MAX_CONFLITS_NOMMES = 5


# Vrai si la penalite d'absence tombe a ce nombre de sessions loupees : au
# palier `seuil`, puis tous les `intervalle` (seuil=4, intervalle=1 -> 4e, 5e...).
def penalite_due(sessions_loupees: int, seuil: int, intervalle: int) -> bool:
    if sessions_loupees < seuil:
        return False
    # L'intervalle est modifiable depuis l'admin : eviter la division par zero.
    return (sessions_loupees - seuil) % max(1, intervalle) == 0


# Joueurs de `tournoi_id` deja presents dans un autre tournoi de la session de
# `autre_tournoi_id` (un seul tournoi par session et par joueur). Le controle
# porte sur toute la session, pas seulement sur `autre_tournoi_id`.
def joueurs_en_conflit_de_session(cur: Any, tournoi_id: Any, autre_tournoi_id: Any) -> list:
    cur.execute("""
        SELECT DISTINCT j.nom
        FROM Participations p
        JOIN Joueurs j  ON j.id = p.joueur_id
        JOIN Tournois t ON t.id = p.tournoi_id
        WHERE t.session_id = (SELECT session_id FROM Tournois WHERE id = %s)
          AND t.id <> %s
          AND p.joueur_id IN (SELECT joueur_id FROM Participations WHERE tournoi_id = %s)
        ORDER BY j.nom
        LIMIT %s
    """, (autre_tournoi_id, tournoi_id, tournoi_id, MAX_CONFLITS_NOMMES))
    return [r[0] for r in cur.fetchall()]


# Meme controle entre deux sessions deja peuplees.
def joueurs_en_conflit_entre_sessions(cur: Any, session_a: Any, session_b: Any) -> list:
    if session_a == session_b:
        return []
    cur.execute("""
        SELECT DISTINCT j.nom
        FROM Participations pa
        JOIN Tournois ta      ON ta.id = pa.tournoi_id
        JOIN Participations pb ON pb.joueur_id = pa.joueur_id
        JOIN Tournois tb      ON tb.id = pb.tournoi_id
        JOIN Joueurs j        ON j.id = pa.joueur_id
        WHERE ta.session_id = %s AND tb.session_id = %s
        ORDER BY j.nom
        LIMIT %s
    """, (session_a, session_b, MAX_CONFLITS_NOMMES))
    return [r[0] for r in cur.fetchall()]


# Recalcule les absences apres la fusion tardive de deux sessions, et renvoie
# les joueurs corriges : un joueur present a un tournoi de la session ne doit
# avoir aucune absence pour elle, un absent complet une seule.
# On soustrait penalty_applied (valeur reellement appliquee, plafond compris)
# plutot que de restaurer old_sigma, qui ecraserait les changements posterieurs.
def annuler_penalites_de_session(cur: Any, session_id: Any, threshold: int) -> list:
    cur.execute("SELECT id FROM Tournois WHERE session_id = %s", (session_id,))
    tournois = [r[0] for r in cur.fetchall()]
    if len(tournois) < 2:
        # Session a un seul tournoi : aucune absence ne peut etre en trop.
        return []

    cur.execute("""
        SELECT DISTINCT p.joueur_id
        FROM Participations p
        JOIN Tournois t ON t.id = p.tournoi_id
        WHERE t.session_id = %s
    """, (session_id,))
    presents = [r[0] for r in cur.fetchall()]

    # Absences en trop par joueur, deduites du nombre de tournois de la session
    # non joues (consecutive_missed est un cumul).
    cur.execute("""
        SELECT j.id,
               %s - count(DISTINCT p.tournoi_id) AS tournois_manques
        FROM Joueurs j
        LEFT JOIN Participations p
               ON p.joueur_id = j.id AND p.tournoi_id = ANY(%s)
        WHERE COALESCE(j.consecutive_missed, 0) > 0
        GROUP BY j.id
    """, (len(tournois), tournois))
    manques = {jid: n for jid, n in cur.fetchall()}

    cur.execute("""
        SELECT g.joueur_id, SUM(g.penalty_applied), count(*)
        FROM ghost_log g
        JOIN Tournois t ON t.id = g.tournoi_id
        WHERE t.session_id = %s
        GROUP BY g.joueur_id
    """, (session_id,))
    penalites = {jid: (float(cumul), nb) for jid, cumul, nb in cur.fetchall()}

    corriges = []
    for joueur_id, tournois_manques in manques.items():
        a_garder = 0 if joueur_id in presents else 1
        en_trop = tournois_manques - a_garder
        cumul_sigma, nb_penalites = penalites.get(joueur_id, (0.0, 0))

        if en_trop <= 0 and nb_penalites == 0:
            continue

        cur.execute(
            "SELECT sigma, COALESCE(consecutive_missed, 0) FROM Joueurs WHERE id = %s",
            (joueur_id,))
        ligne = cur.fetchone()
        if ligne is None:
            continue
        sigma_actuel, missed_actuel = float(ligne[0]), int(ligne[1])

        # Jamais plus que ce que le joueur porte reellement.
        retrait = min(max(en_trop, 0), missed_actuel)
        nouveau_missed = missed_actuel - retrait
        nouveau_sigma = max(sigma_actuel - cumul_sigma, 0.0)

        if retrait == 0 and nb_penalites == 0:
            continue

        # is_ranked recalcule en Python : dans l'UPDATE, consecutive_missed
        # serait lu avant modification.
        cur.execute("""
            UPDATE Joueurs
            SET sigma = %s, consecutive_missed = %s, is_ranked = %s
            WHERE id = %s
        """, (nouveau_sigma, nouveau_missed, nouveau_missed < threshold, joueur_id))
        # Avant/apres conserves pour la ligne d'audit.
        corriges.append({
            "joueur_id": joueur_id,
            "avant": {"sigma": sigma_actuel, "consecutive_missed": missed_actuel},
            "apres": {"sigma": nouveau_sigma, "consecutive_missed": nouveau_missed},
        })

    # Ces penalites n'existent plus.
    if penalites:
        cur.execute("""
            DELETE FROM ghost_log
            WHERE tournoi_id = ANY(%s)
        """, (tournois,))

    return corriges


# Rattache deux tournois a la meme session (celle d'id le plus petit) et
# renvoie son id. Ne verifie pas les conflits de joueurs.
def fusionner_sessions(cur: Any, tournoi_id: Any, autre_tournoi_id: Any) -> Any:
    cur.execute(
        "SELECT id, session_id FROM Tournois WHERE id IN (%s, %s)",
        (tournoi_id, autre_tournoi_id))
    sessions = {tid: sid for tid, sid in cur.fetchall()}
    gardee, absorbee = sessions.get(tournoi_id), sessions.get(autre_tournoi_id)

    if gardee is None or absorbee is None or gardee == absorbee:
        return gardee if gardee is not None else absorbee

    gardee, absorbee = min(gardee, absorbee), max(gardee, absorbee)
    cur.execute("UPDATE Tournois SET session_id = %s WHERE session_id = %s",
                (gardee, absorbee))
    # La session absorbee n'a plus de tournoi.
    cur.execute("DELETE FROM sessions_tournois WHERE id = %s", (absorbee,))
    return gardee


# Annule la penalite d'absence d'un tournoi supprime : decremente
# consecutive_missed et retablit is_ranked sous le seuil. Les participants ne
# sont pas touches (leur ancienne valeur n'est pas conservee).
def annuler_absences(cur: Any, participant_ids: Iterable[int], threshold: int) -> None:
    ids = list(participant_ids or [])
    if ids:
        cur.execute(
            "SELECT id, consecutive_missed, is_ranked FROM Joueurs WHERE id NOT IN %s",
            (tuple(ids),),
        )
    else:
        cur.execute("SELECT id, consecutive_missed, is_ranked FROM Joueurs")

    batch = []
    for jid, missed, is_ranked in cur.fetchall():
        if not missed or missed <= 0:
            continue
        new_missed = missed - 1
        new_ranked = True if (not is_ranked and new_missed < threshold) else is_ranked
        batch.append((jid, new_missed, new_ranked))

    if batch:
        psycopg2.extras.execute_values(cur, """
            UPDATE Joueurs AS j SET consecutive_missed = data.missed, is_ranked = data.ranked
            FROM (VALUES %s) AS data(id, missed, ranked)
            WHERE j.id = data.id
        """, batch)


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
                # Moyenne sans le joueur juge (leave-one-out).
                denom = m.get('avg_score_excl_self') or M_barre_i
                ratio = min(GM_MAX_RATIO_CAP, S_i / denom) if denom > 0 else 0
                # Plafond reapplique apres la correction de force du lobby.
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
                SELECT t.id, t.date, t.ligue_id, t.session_id
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

            # Reference IP v2 : grille du jour, toutes ligues confondues.
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

    labels = [d.strftime("%d/%m") for _, d, _, _ in tournois]
    tournoi_ids = [tid for tid, _, _, _ in tournois]
    tournoi_dates = {tid: d for tid, d, _, _ in tournois}
    tid_index = {tid: i for i, tid in enumerate(tournoi_ids)}
    # Seuil de participation compte en sessions (deux lobbies lies = une
    # occasion de jeu), comme _aggregate_season_stats.
    total_tournois = len({sid for _t, _d, _lg, sid in tournois})

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

    players: dict[int, dict] = {}
    for tid, jid, nom, color, score, position, old_mu in parts:
        p = players.setdefault(jid, {"nom": nom, "color": color or "#FFFFFF", "by_idx": {}})
        idx = tid_index.get(tid)
        if idx is not None:
            p["by_idx"][idx] = (float(score), position, old_mu)

    base_poids = _gm_base_weight(ip_version)

    datasets = []
    for jid, p in players.items():
        data: list[float | None] = []
        points: list[dict | None] = []
        num_total = 0.0
        denom_total = 0.0
        matchs = 0
        seen_first = False
        for idx in range(len(tournoi_ids)):
            entry = p["by_idx"].get(idx)
            point_detail = None
            if entry is not None:
                score, position, own_old_mu = entry
                seen_first = True
                matchs += 1
                t = meta[tournoi_ids[idx]]

                if ip_version == "v2":
                    # Moyenne sans le joueur juge (leave-one-out).
                    avg_score_excl = _leave_one_out(t["sum"], t["count"], score) or t["avg"]
                    ratio_base = min(GM_MAX_RATIO_CAP, score / avg_score_excl) if avg_score_excl > 0 else 0.0
                    lobby_avg_mu = _leave_one_out(t["sum_mu"], t["count_mu"], own_old_mu)
                    ref_avg_mu = _reference_mu(ref_grids.get(tournoi_dates[tournoi_ids[idx]]), jid)
                    if ref_avg_mu is None:
                        ref_avg_mu = _leave_one_out(period_sum_mu, period_count_mu, own_old_mu)
                    # Plafond reapplique apres la correction de force du lobby.
                    ratio = min(GM_MAX_RATIO_CAP, ratio_base * _force_lobby(lobby_avg_mu, ref_avg_mu))
                else:
                    ratio = min(GM_MAX_RATIO_CAP, score / t["avg"]) if t["avg"] > 0 else 0.0

                poids = t["count"] + base_poids
                num_total += ratio * poids
                denom_total += poids

                point_detail = {
                    "date": tournoi_dates[tournoi_ids[idx]].strftime("%d/%m/%Y"),
                    "position": int(position) if position is not None else None,
                    "score": int(score),
                    "ip_pur": round(ratio * 100, 2),
                }

            if not seen_first:
                data.append(None)
                points.append(None)
                continue

            bonus = max(0, matchs - seuil_participation) * GM_EXTRA_MATCH_BONUS
            ip_base = (num_total / denom_total) * 100 if denom_total > 0 else 0.0
            ip_total = round(min(GM_MAX_IP, ip_base + bonus), 2)
            data.append(ip_total)

            if point_detail is not None:
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
                SELECT t.id, t.date, t.session_id
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

    labels = [d.strftime("%d/%m") for _, d, _ in tournois]
    tournoi_ids = [tid for tid, _, _ in tournois]
    tournoi_dates = {tid: d for tid, d, _ in tournois}
    tid_index = {tid: i for i, tid in enumerate(tournoi_ids)}
    # Seuil de participation compte en sessions, comme _aggregate_season_stats.
    total_tournois = len({sid for _t, _d, sid in tournois})

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
        for idx in range(len(tournoi_ids)):
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
                    t.date, p.tournoi_id, j.sigma, t.ligue_id, p.old_mu,
                    t.session_id
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

            # Reference IP v2 : grille du jour, toutes ligues confondues.
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
        # Denominateur compte en sessions (deux lobbies lies = une occasion de
        # jeu), affiche comme un nombre de tournois.
        sessions_vues = set()
        for row in rows:
            tid = row[8]
            score = float(row[2])
            old_mu = row[11]
            sessions_vues.add(row[12])
            if tid not in tournoi_meta:
                tournoi_meta[tid] = {"sum_score": 0.0, "count": 0, "sum_mu": 0.0, "count_mu": 0}
            tournoi_meta[tid]["count"] += 1
            tournoi_meta[tid]["sum_score"] += score
            if old_mu is not None:
                tournoi_meta[tid]["sum_mu"] += float(old_mu)
                tournoi_meta[tid]["count_mu"] += 1

        for tid, meta in tournoi_meta.items():
            meta["avg_score"] = meta["sum_score"] / meta["count"] if meta["count"] > 0 else 1.0

        total_tournois = len(sessions_vues)
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

    # 'grand_master' est le nom interne du classement IP.
    if vic_cond == 'Indice de Performance':
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


# ---------------------------------------------------------------------------
# Matchmaking
# ---------------------------------------------------------------------------
# Joueurs tries par score decroissant puis coupes en tranches contigues de
# tailles aussi egales que possible (utilise par l'admin et le bot Discord).

def construire_lobbies(joueurs, max_par_lobby=None):
    """Repartit des joueurs (dicts avec la cle 'ts') en lobbies equilibres.

    Renvoie une liste de lobbies, le premier contenant les meilleurs.
    """
    if max_par_lobby is None:
        max_par_lobby = MAX_PAR_LOBBY

    # Tri stable : a score egal, l'ordre d'entree est conserve.
    joueurs = sorted(joueurs, key=lambda p: p['ts'], reverse=True)

    n = len(joueurs)
    if n == 0:
        return []

    k = -(-n // max_par_lobby)          # ceil(n / max_par_lobby)
    if k == 1:
        return [list(joueurs)]

    base = n // k
    pivots = n % k  # joueurs a repartir en plus du socle

    tailles = [base] * k
    curseur = 0
    places = 0

    for i in range(k):
        taille = tailles[i]
        if i < k - 1 and pivots - places > 0:
            # Le joueur a la frontiere rejoint le lobby dont il est le plus proche.
            idx_pivot = curseur + taille
            dessus = joueurs[idx_pivot - 1]
            pivot = joueurs[idx_pivot]
            dessous = joueurs[idx_pivot + 1] if idx_pivot + 1 < n else None

            ecart_dessus = abs(pivot['ts'] - dessus['ts'])
            ecart_dessous = abs(pivot['ts'] - dessous['ts']) if dessous else float('inf')

            # Un lobby ne recoit qu'un joueur en plus du socle (base+1 au maximum).
            deja_servi = taille > base
            if deja_servi or ecart_dessus > ecart_dessous:
                tailles[i + 1] += 1
            else:
                taille += 1
            places += 1

        curseur += taille
        tailles[i] = taille

    lobbies = []
    idx = 0
    for taille in tailles:
        lobbies.append(joueurs[idx:idx + taille])
        idx += taille
    return lobbies


def resoudre_joueurs_matchmaking(cur, noms=None, joueur_ids=None, discord_ids=None):
    """Resout des identifiants de joueurs en {id, nom, ts}.

    Le score est toujours relu en base. Renvoie (joueurs trouves, introuvables).
    """
    # Comparaison sur les valeurs normalisees (un snowflake peut arriver en nombre).
    if joueur_ids:
        cle, condition = 'id', "j.id = ANY(%s)"
        demandes = [int(x) for x in joueur_ids]
    elif discord_ids:
        cle, condition = 'discord_id', "c.discord_id = ANY(%s)"
        demandes = [str(d) for d in discord_ids]
    elif noms:
        cle, condition = 'nom', "j.nom = ANY(%s)"
        demandes = [str(n) for n in noms]
    else:
        return [], []
    valeurs = [demandes]

    cur.execute(
        """SELECT j.id, j.nom, j.score_trueskill, c.discord_id
           FROM Joueurs j
           LEFT JOIN comptes c ON c.joueur_id = j.id AND c.statut = 'linked'
           WHERE """ + condition,
        valeurs,
    )
    trouves = [
        {
            "id": r[0],
            "nom": r[1],
            "ts": round(float(r[2]), 3) if r[2] is not None else 0.0,
            "discord_id": r[3],
        }
        for r in cur.fetchall()
    ]

    vus = {t[cle] for t in trouves}
    introuvables = [d for d in demandes if d not in vus]
    return trouves, introuvables


# ---------------------------------------------------------------------------
# Purges RGPD
# ---------------------------------------------------------------------------

def purger_donnees_expirees(cur):
    """Supprime les donnees dont la duree de conservation est depassee.

    Renvoie le bilan ; l'appelant gere la transaction.
    """
    bilan = {}

    cur.execute("DELETE FROM sessions_joueurs WHERE expires_at < now()")
    bilan['sessions'] = cur.rowcount

    cur.execute(
        "DELETE FROM invitations WHERE expires_at < now() - make_interval(days => %s)",
        (PURGE_INVITATIONS_JOURS,),
    )
    bilan['invitations'] = cur.rowcount

    # Inscription jamais rattachee et inactive, sans role.
    cur.execute(
        """DELETE FROM comptes
           WHERE statut = 'pending'
             AND joueur_id IS NULL
             AND role = 'player'
             AND COALESCE(last_login_at, created_at) < now() - make_interval(days => %s)""",
        (PURGE_COMPTES_PENDING_JOURS,),
    )
    bilan['comptes_abandonnes'] = cur.rowcount

    cur.execute(
        """DELETE FROM liaisons_demandes
           WHERE statut = 'rejected' AND decided_at < now() - make_interval(days => %s)""",
        (PURGE_LIAISONS_REFUSEES_JOURS,),
    )
    bilan['liaisons_refusees'] = cur.rowcount

    total = sum(bilan.values())
    if total:
        # Trace de la purge, sans les donnees purgees.
        audit.ecrire(cur, 'purge_rgpd', 'systeme', details=bilan)
        logger.info("Purge RGPD : %s", bilan)
    return bilan
