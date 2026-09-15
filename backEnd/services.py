from __future__ import annotations

import json
import math
import statistics
import logging
from math import erf, sqrt
from typing import Any, Callable, Iterable

import psycopg2.extras

from constants import (
    DEFAULT_SIGMA_THRESHOLD,
    DEFAULT_TIERS,
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


# Force du lobby (IP v2, cf IP_V2_* dans constants.py) : ecart de mu entre le
# lobby et la grille figee du jour, toutes ligues confondues. 1.0 si
# non calculable.
def _force_lobby(mu_moyen_lobby: float | None, mu_moyen_reference: float | None) -> float:
    if mu_moyen_lobby is None or mu_moyen_reference is None:
        return 1.0
    force = 1 + IP_V2_FORCE_LOBBY_PER_MU * (mu_moyen_lobby - mu_moyen_reference)
    return max(IP_V2_FORCE_LOBBY_MIN, min(IP_V2_FORCE_LOBBY_MAX, force))


# Un joueur compte dans la reference IP v2 s'il a un rank : present dans la
# grille et pas inactif. Les deux criteres se desactivent via IP_V2_REF_*.
def _counts_in_reference(is_ranked: bool, tier: str | None) -> bool:
    if IP_V2_REF_REQUIRE_RANKED and not is_ranked:
        return False
    if IP_V2_REF_REQUIRE_TIER and (tier or 'U').strip().upper() == 'U':
        return False
    return True


# {date: {"sum": mu cumule, "count": effectif, "mus": {joueur_id: mu}}}, le
# detail par joueur servant au leave-one-out.
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


# Mu moyen de la grille figee du jour, le joueur lui-meme exclu. None si la
# journee n'a pas de grille : l'appelant se rabat sur la moyenne de periode.
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
    """Charge la liste des tiers depuis la table `tiers`, tries par rang
    decroissant (le meilleur en premier). Retombe sur DEFAULT_TIERS si la
    table est vide -- ne devrait pas arriver en usage normal (le seed de
    migration l'evite), mais garantit qu'un recalcul ne classe jamais
    personne en 'U' faute de tiers a comparer.

    Prend un curseur deja ouvert (plutot qu'une connexion) : appele depuis
    des fonctions qui tiennent deja leur propre transaction (recalculate_tiers,
    routes admin), pour ne pas emboiter une seconde connexion.
    """
    cur.execute("SELECT id, nom, couleur, seuil_k, rang FROM tiers ORDER BY rang DESC")
    rows = cur.fetchall()
    if not rows:
        # `id: None` explicite : le panneau admin distingue ainsi une ligne
        # reellement en base d'un simple defaut de secours non persiste.
        return [dict(t, id=None) for t in DEFAULT_TIERS]
    # `id` est indispensable au panneau d'administration : c'est lui qui
    # identifie la ligne a deplacer, modifier ou supprimer. Sans lui, le front
    # confondait tous les tiers (tous `undefined`) et n'agissait que sur le
    # premier -- bug constate en recette le 13/09.
    return [
        {"id": i, "nom": n, "couleur": c, "seuil_k": k, "rang": r}
        for i, n, c, k, r in rows
    ]


def tier_thresholds(scores: Iterable[float], tiers: list[dict]) -> dict[str, float]:
    """Score-frontiere (mean + seuil_k*stdev) pour chaque tier ayant un
    seuil_k -- le plancher (seuil_k None) n'a pas de frontiere basse et vaut
    toujours 0 dans le retour, pour compatibilite avec les gabarits qui
    l'affichent (ex: classement.html) sans avoir a tester sa presence.

    `tiers` doit deja etre trie par rang decroissant (cf load_tiers).
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
    """Premier tier (dans l'ordre decroissant de rang) dont le score-frontiere
    est depasse ; le tier de plus petit rang sert de secours (son seuil_k est
    normalement None -- s'il ne l'est pas, ex. donnee corrompue, le secours
    reste correct : personne n'a matche au-dessus).

    `tiers` doit deja etre trie par rang decroissant (cf load_tiers). Une
    liste vide n'est pas cense arriver (load_tiers retombe sur DEFAULT_TIERS)
    mais retourne 'U' plutot que de lever, par coherence avec has_tier().
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
    # Renvoyes tels quels : le front en a besoin pour convertir les seuils
    # (stockes en ecart-type) en position sur l'axe des scores bruts. Les
    # reconstruire cote JS depuis min/max de la courbe est fragile -- la
    # boucle ci-dessous n'atteint pas toujours x_max exactement (accumulation
    # flottante sur _CURVE_RESOLUTION pas), ce qui decalait legerement mean/
    # stdev recalcules et donc les lignes de seuil affichees (bug du 14/09).
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


# Filet de rattrapage d'un decalage de sequence, appele au demarrage
# (backend.py). Un dump restaure avec des id explicites laisse sa sequence a 1 :
# le prochain INSERT heurte alors une cle primaire existante.
#
# sessions_tournois en fait partie parce que sa migration insere des id
# explicites (backfill par id du tournoi-ancre) -- exactement le cas que cette
# fonction rattrape.
_TABLES_A_SEQUENCE = [
    'Joueurs', 'Tournois', 'sessions_tournois', 'saisons', 'types_awards', 'awards_obtenus',
]


def sync_sequences() -> None:
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            for table in _TABLES_A_SEQUENCE:
                try:
                    # COALESCE(..., 1) : MAX(id) vaut NULL sur une table vide, et
                    # setval(NULL) echoue -- sans lui, l'exception ci-dessous
                    # avalait le cas silencieusement.
                    cur.execute(
                        f"SELECT setval('public.{table.lower()}_id_seq',"
                        f" COALESCE((SELECT MAX(id) FROM public.{table}), 1))"
                    )
                except Exception:
                    # Table absente : une migration n'a pas encore tourne. Non
                    # bloquant au demarrage, mais tracé -- sinon un decalage de
                    # sequence reel reste invisible jusqu'au prochain INSERT.
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
# definit la reference IP v2, les suivants reutilisent la meme grille.
# Existence testee sur la journee entiere et non ligne par ligne : sinon un
# joueur cree entre-temps s'ajouterait a une grille deja figee.
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


# Libere la grille d'une journee dont plus aucun tournoi ne subsiste, pour
# qu'un tournoi rejoue a cette date reparte de l'etat courant.
def drop_grille_snapshot_if_orphan(cur: Any, date_tournoi: Any) -> None:
    cur.execute("SELECT 1 FROM Tournois WHERE date = %s LIMIT 1", (date_tournoi,))
    if cur.fetchone():
        return
    cur.execute("DELETE FROM grille_snapshots WHERE date = %s", (date_tournoi,))


# Supprime une session que plus aucun tournoi ne reference. Meme role et meme
# emplacement d'appel que drop_grille_snapshot_if_orphan ci-dessus : a appeler
# depuis revert_last_tournament et delete_tournament, avec la session_id lue
# AVANT la suppression du tournoi.
#
# Une session vide est inoffensive pour le calcul (aucun tournoi n'y pointe),
# mais la laisser fausserait tout comptage de sessions -- or c'est precisement
# ce que ce chantier rend fiable (classement de saison, recaps, seuils d'awards).
def drop_session_if_orphan(cur: Any, session_id: Any) -> None:
    if session_id is None:
        return
    cur.execute("SELECT 1 FROM Tournois WHERE session_id = %s LIMIT 1", (session_id,))
    if cur.fetchone():
        return
    cur.execute("DELETE FROM sessions_tournois WHERE id = %s", (session_id,))


# Nombre de joueurs a nommer dans un message de conflit. Purement cosmetique :
# la DETECTION ne depend jamais de cette borne, une seule ligne suffit a refuser.
MAX_CONFLITS_NOMMES = 5


# La penalite d'absence est-elle due a cette session-ci ?
#
# `sessions_loupees` est consecutive_missed APRES incrementation pour le tour en
# cours. La penalite tombe au palier `seuil`, puis tous les `intervalle`
# ensuite : seuil=4, intervalle=1 -> 4e, 5e, 6e... ; seuil=2, intervalle=3 ->
# 2e, 5e, 8e...
#
# Remplace un calcul d'ecart calendaire (date de derniere apparition ou de
# derniere penalite, comparee a la date du tournoi). Consequence VOULUE : une
# periode sans session ne penalise personne, puisque le compteur ne bouge pas.
# La penalite sanctionne les occasions loupees, pas le temps qui passe.
# Conception : docs/plan-sessions-tournois.md, decision 8 et 5.4
def penalite_due(sessions_loupees: int, seuil: int, intervalle: int) -> bool:
    if sessions_loupees < seuil:
        return False
    # max(1, ...) : un intervalle nul ou negatif ferait une division par zero,
    # et la configuration est modifiable depuis l'interface d'administration.
    return (sessions_loupees - seuil) % max(1, intervalle) == 0


# Un joueur ne peut jouer qu'UN tournoi par session : deux lobbies simultanes,
# on ne peut pas etre dans les deux (plan-sessions-tournois.md, decision 9).
#
# Renvoie les noms des joueurs de `tournoi_id` deja presents dans un AUTRE
# tournoi de la session cible -- liste vide si la liaison est licite.
#
# Le filtre porte sur la SESSION entiere, pas sur le seul tournoi designe :
# lier C a B quand B est deja avec A doit verifier C contre A et B. Une
# "simplification" en « WHERE t.id = autre_tournoi_id » passerait les tests
# evidents et laisserait ce trou transitif.
#
# `t.id <> tournoi_id` exclut le tournoi courant : sans lui, s'il a deja rejoint
# la session, ses propres joueurs remontent comme conflits et TOUTE liaison est
# refusee. Redondant quand l'appelant verifie avant de fusionner (l'ordre
# recommande), garde de securite sinon.
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


# Variante pour la fusion de deux sessions DEJA peuplees (liaison tardive) : il
# faut comparer les deux ensembles dans leur entier, pas un tournoi contre une
# session. Meme regle, perimetre different.
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


# Reunit deux tournois dans une meme session, en gardant la session d'id le plus
# PETIT et en y reaffectant les tournois de l'autre.
#
# Cette convention rend le resultat independant de l'ordre des arguments et fait
# qu'une session garde son identite au fil des fusions successives.
#
# Idempotente : deux tournois deja dans la meme session -> aucune ecriture,
# l'admin peut cliquer deux fois sans consequence.
#
# NE VERIFIE PAS les conflits de joueurs : c'est a l'appelant de le faire AVANT,
# pour pouvoir refuser sans avoir rien ecrit. Voir joueurs_en_conflit_*.
#
# Renvoie la session_id conservee.
# Recalcule les absences apres une fusion de sessions, et renvoie la liste des
# joueurs corriges.
#
# LE PROBLEME. Deux tournois enregistres separement, puis lies apres coup :
# chacun a compte ses absences comme si l'autre n'existait pas. Une fois les
# deux dans la meme session, la regle « une session manquee = +1 » est violee de
# deux facons :
#
#   1. Un joueur qui a joue l'un des tournois a ete compte ABSENT de l'autre.
#      Jouer un seul tournoi de la session suffit a compter present pour toute
#      la session : son compteur doit perdre ces absences.
#   2. Un joueur absent de TOUS les tournois de la session a ete compte une fois
#      par tournoi, au lieu d'une fois pour la session. Son compteur doit perdre
#      les absences en trop (nb_tournois_manques - 1).
#
# Ne concerne QUE la liaison tardive. Le chemin nominal (liaison demandee avant
# l'enregistrement) connait la session avant de calculer et n'ecrit jamais ces
# absences (docs/plan-sessions-tournois.md, decision 10).
#
# POURQUOI RETIRER penalty_applied ET NON RESTAURER old_sigma. old_sigma est
# l'etat du joueur au moment de cette penalite precise. Le reecrire ecraserait
# tout ce qui a bouge depuis (matchs joues, autres penalites, corrections
# d'admin). On retire donc exactement ce que la penalite avait ajoute -- une
# soustraction est commutative, une restauration d'etat ne l'est pas.
#
# GHOST_SIGMA_CAP complique le calcul : une penalite ecretee par le plafond a
# ajoute MOINS que ghost_penalty. penalty_applied porte la valeur reellement
# appliquee, d'ou son usage ici plutot qu'une relecture de la configuration.
def annuler_penalites_de_session(cur: Any, session_id: Any, threshold: int) -> list:
    # Les tournois de la session, et qui a joue dans chacun.
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

    # Combien d'absences en trop chaque joueur porte-t-il ?
    #
    # Un present doit avoir 0 absence imputable a cette session : on retire
    # toutes celles qu'il a prises pour les tournois qu'il n'a pas joues.
    # Un absent complet doit n'en avoir qu'une : on retire les autres.
    #
    # Le nombre d'absences prises pour cette session n'est stocke nulle part --
    # `consecutive_missed` est un cumul. On le DEDUIT du nombre de tournois de
    # la session auxquels le joueur n'a pas participe, ce qui est exact tant que
    # le joueur etait dans le perimetre de calcul de chacun. Approximation
    # assumee pour le mode ligue, ou un joueur hors perimetre n'avait de toute
    # facon pas ete incremente : la borne max(...) ci-dessous empeche alors de
    # retirer plus que ce qu'il porte.
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

    # Penalites de sigma portees par un tournoi de cette session, par joueur.
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
        # Un present garde 0 absence pour la session, un absent en garde 1.
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

        # Jamais plus que ce que le joueur porte reellement : son compteur a pu
        # etre remis a 0 depuis (il a rejoue), ou ne jamais avoir ete incremente
        # (hors perimetre de ligue).
        retrait = min(max(en_trop, 0), missed_actuel)
        nouveau_missed = missed_actuel - retrait
        nouveau_sigma = max(sigma_actuel - cumul_sigma, 0.0)

        if retrait == 0 and nb_penalites == 0:
            continue

        # is_ranked est recalcule : un joueur exclu du classement par ces
        # absences doit y revenir s'il repasse sous le seuil.
        #
        # Le calcul se fait en Python plutot que dans un UPDATE auto-referent :
        # SET is_ranked = (... consecutive_missed ...) lirait l'ancienne valeur
        # de la colonne (semantique SQL correcte, mais piege a la relecture --
        # on croit lire la nouvelle).
        cur.execute("""
            UPDATE Joueurs
            SET sigma = %s, consecutive_missed = %s, is_ranked = %s
            WHERE id = %s
        """, (nouveau_sigma, nouveau_missed, nouveau_missed < threshold, joueur_id))
        corriges.append(joueur_id)

    # Le journal doit refleter l'etat courant : ces penalites n'existent plus.
    # Toutes celles de la session partent, y compris celles d'un absent complet :
    # sa penalite sera de nouveau due au prochain tournoi s'il reste au palier.
    if penalites:
        cur.execute("""
            DELETE FROM ghost_log
            WHERE tournoi_id = ANY(%s)
        """, (tournois,))

    return corriges


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
    # La session absorbee n'a plus aucun tournoi : la laisser fausserait tout
    # comptage de sessions.
    cur.execute("DELETE FROM sessions_tournois WHERE id = %s", (absorbee,))
    return gardee


# Defait la penalite d'absence d'un tournoi qu'on annule : decremente
# consecutive_missed et redonne is_ranked a qui repasse sous le seuil.
#
# participant_ids = les joueurs a NE PAS toucher (ceux qui ont joue le tournoi
# annule). Leur compteur a ete remis a 0 par add_tournament, et la valeur d'avant
# n'est stockee NULLE PART -- Participations garde old_mu/old_sigma, jamais
# old_missed. Elle est donc definitivement perdue : ils restent a 0. Ce n'est pas
# un oubli, c'est une limite du schema. Les decrementer serait pire encore, ils
# passeraient sous leur vraie valeur.
#
# Le filtre missed > 0 ne distingue pas un absent DE CE TOURNOI d'un joueur qui
# cumulait deja des absences hors perimetre (mode ligue). C'est une approximation
# assumee : les deux routes d'annulation partagent ainsi exactement la meme regle
# plutot que d'en inventer une troisieme. La correction fine suppose de savoir qui
# etait reellement dans le perimetre, ce que seule une session explicite dira
# (cf docs/plan-sessions-tournois.md).
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
        # v1 et v2 calcules en parallele : le tooltip affiche les deux, quelle que
        # soit la version active.
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
        # Sessions distinctes de la periode. Une session = une occasion de jeu :
        # deux lobbies lies comptent pour UN tournoi dans ce denominateur.
        #
        # Remplace un regroupement par (date, ligue_id) recalcule ici, qui
        # dupliquait hors de add_tournament l'heuristique que ce chantier
        # supprime. Comme le backfill a utilise la meme cle, le resultat est
        # identique sur l'historique : c'est un refactor, pas un changement de
        # regle -- la difference n'apparait que pour les liaisons futures.
        #
        # Affichage : cette valeur reste presentee comme un nombre de TOURNOIS
        # (classement de saison, recaps). La session est l'unite de calcul, le
        # tournoi l'unite d'affichage.
        # Conception : docs/plan-sessions-tournois.md, decision 7
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
            # avg_old_mu leave-one-out : calcule par joueur plus bas (cf _leave_one_out).

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


# ---------------------------------------------------------------------------
# Matchmaking
# ---------------------------------------------------------------------------
# Portage de buildLobbies(), qui vivait dans matchmaking.html : la page
# d'administration et le bot Discord doivent appeler le MEME code.
#
# Joueurs tries par score decroissant, puis coupes en k tranches contigues de
# tailles aussi egales que possible. Le point de coupure est choisi la ou
# l'ecart de score est le plus faible.

def construire_lobbies(joueurs, max_par_lobby=None):
    """Repartit des joueurs en lobbies equilibres.

    `joueurs` : liste de dictionnaires comportant au moins la cle 'ts'.
    Le tri decroissant est fait ici, et non par l'appelant, pour que tous les
    appelants se comportent identiquement.

    Renvoie une liste de listes, dans l'ordre : lobby 1 = les meilleurs.
    """
    if max_par_lobby is None:
        max_par_lobby = MAX_PAR_LOBBY

    # Tri stable, comme le tri JS d'origine : a scores egaux, l'ordre d'entree
    # est conserve.
    joueurs = sorted(joueurs, key=lambda p: p['ts'], reverse=True)

    n = len(joueurs)
    if n == 0:
        return []

    k = -(-n // max_par_lobby)          # ceil(n / max_par_lobby)
    if k == 1:
        return [list(joueurs)]

    base = n // k
    pivots = n % k                      # joueurs a repartir en plus du socle

    tailles = [base] * k
    curseur = 0
    places = 0

    for i in range(k):
        taille = tailles[i]
        if i < k - 1 and pivots - places > 0:
            # Le joueur a la frontiere : le laisse-t-on dans ce lobby, ou
            # bascule-t-il dans le suivant ? On le rattache au voisin dont il
            # est le plus proche au score.
            idx_pivot = curseur + taille
            dessus = joueurs[idx_pivot - 1]
            pivot = joueurs[idx_pivot]
            dessous = joueurs[idx_pivot + 1] if idx_pivot + 1 < n else None

            ecart_dessus = abs(pivot['ts'] - dessus['ts'])
            ecart_dessous = abs(pivot['ts'] - dessous['ts']) if dessous else float('inf')

            # CORRECTIF par rapport au JS d'origine : un lobby ne peut recevoir qu'UN
            # joueur en plus du socle. Sans cette condition, un lobby deja agrandi a
            # l'iteration precedente atteignait base+2 -- 11 joueurs pour une limite de
            # 10, dans 3 % des compositions de 11 a 40 joueurs.
            #
            # La repartition est connue d'avance : exactement `pivots` lobbies de taille
            # base+1. Le choix ne porte que sur LESQUELS, jamais sur combien.
            deja_servi = taille > base
            if deja_servi or ecart_dessus > ecart_dessous:
                tailles[i + 1] += 1     # il rejoint le suivant
            else:
                taille += 1             # il reste dans le lobby courant
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

    Le score vient TOUJOURS de la base, jamais de l'appelant : un client qui
    fournirait ses propres scores pourrait composer les lobbies a sa guise.

    Renvoie (joueurs trouves, identifiants introuvables).
    """
    # `demandes` porte les valeurs NORMALISEES, celles qui partent dans la
    # requete. Comparer les valeurs brutes au retour de la base ferait declarer
    # introuvable un joueur pourtant trouve : un bot envoyant ses snowflakes en
    # nombres JSON obtenait les bons lobbies et tous ses joueurs en introuvables.
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
# Art. 5.1.e : garder une donnee sans raison est un manquement. Chaque duree
# ci-dessous doit pouvoir se justifier a l'oral.

def purger_donnees_expirees(cur):
    """Supprime ce qui n'a plus de raison d'etre conserve. Renvoie le detail.

    Prend un curseur : l'appelant maitrise la transaction, et la purge peut
    donc se greffer sur une operation existante sans ouvrir une connexion de
    plus.
    """
    bilan = {}

    # Une session expiree ne sert plus a rien, meme pas a l'ecran des sessions.
    cur.execute("DELETE FROM sessions_joueurs WHERE expires_at < now()")
    bilan['sessions'] = cur.rowcount

    # Le lien est mort depuis un mois, son empreinte n'a plus d'usage.
    cur.execute(
        "DELETE FROM invitations WHERE expires_at < now() - make_interval(days => %s)",
        (PURGE_INVITATIONS_JOURS,),
    )
    bilan['invitations'] = cur.rowcount

    # Inscription abandonnee : jamais rattachee, inactive depuis trois mois. On ne
    # touche pas aux comptes lies, ni a ceux qui portent un role.
    cur.execute(
        """DELETE FROM comptes
           WHERE statut = 'pending'
             AND joueur_id IS NULL
             AND role = 'player'
             AND COALESCE(last_login_at, created_at) < now() - make_interval(days => %s)""",
        (PURGE_COMPTES_PENDING_JOURS,),
    )
    bilan['comptes_abandonnes'] = cur.rowcount

    # Un refus s'explique quelque temps, pas indefiniment.
    cur.execute(
        """DELETE FROM liaisons_demandes
           WHERE statut = 'rejected' AND decided_at < now() - make_interval(days => %s)""",
        (PURGE_LIAISONS_REFUSEES_JOURS,),
    )
    bilan['liaisons_refusees'] = cur.rowcount

    total = sum(bilan.values())
    if total:
        # L'audit garde la trace de la purge, sans conserver ce qui a ete purge.
        cur.execute(
            """INSERT INTO audit_admin (action, cible_type, details)
               VALUES ('purge_rgpd', 'systeme', %s::jsonb)""",
            (json.dumps(bilan),),
        )
        logger.info("Purge RGPD : %s", bilan)
    return bilan
