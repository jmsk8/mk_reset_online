from __future__ import annotations

import math
import json
import uuid
import secrets
import hashlib
import logging
from typing import Any
from datetime import datetime, timedelta

import bcrypt
import trueskill
import psycopg2.extras
from flask import Blueprint, jsonify, request, abort, g

import audit

from constants import (
    DEFAULT_MU, DEFAULT_SIGMA, TRUESKILL_BETA, TRUESKILL_DRAW_PROBABILITY,
    DEFAULT_TAU, DEFAULT_GHOST_PENALTY, DEFAULT_UNRANKED_THRESHOLD, DEFAULT_SIGMA_THRESHOLD,
    DEFAULT_TIERS,
    DEFAULT_GHOST_THRESHOLD_SESSIONS, DEFAULT_GHOST_INTERVAL_SESSIONS,
    GHOST_SIGMA_CAP, TOKEN_LIFETIME_MINUTES, IP_VERSION_DEFAULT,
    ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN,
    PERMISSIONS_CHAMPS_JOUEUR,
)
from db import get_db_connection, ADMIN_PASSWORD_HASH
from auth import (admin_required, admin_or_role_required, permission_required,
                  role_required, player_required, compte_a_permission)
from cache import invalidate_cache
from utils import generate_unique_slug, extract_league_number
from services import (
    recalculate_tiers, snapshot_grille, drop_grille_snapshot_if_orphan,
    drop_session_if_orphan, annuler_absences,
    joueurs_en_conflit_de_session, joueurs_en_conflit_entre_sessions,
    fusionner_sessions, annuler_penalites_de_session,
    MAX_CONFLITS_NOMMES, penalite_due,
    _aggregate_season_stats, _determine_winners, _save_awards_to_db,
    _apply_inter_league_moves,
    build_distribution, trueskill_score, has_tier, load_tiers,
)

logger = logging.getLogger(__name__)

admin_bp = Blueprint('admin', __name__)

# Fenetre de tournois proposes pour un rattachement a une session. Assez large
# pour couvrir une soiree scindee en plusieurs lobbies, assez courte pour ne pas
# derouler tout l'historique dans une modale.
SESSION_CANDIDATS_PAR_DEFAUT = 20
SESSION_CANDIDATS_MAX = 100



from routes_comptes import notifier, notifier_tous


def _notifier_recap_publie(cur, saison_id):
    """Annonce un recap au moment ou il devient visible.

    Pas a sa creation : POST /admin/saisons cree un brouillon que /recap ne
    liste pas encore.
    """
    cur.execute("SELECT nom, slug FROM saisons WHERE id = %s", (saison_id,))
    row = cur.fetchone()
    if row is None:
        return
    notifier_tous(
        cur, 'recap_publie',
        "Nouveau récapitulatif : %s" % row[0],
        "Le récap est en ligne, avec son classement et ses trophées. "
        "À lire dans « Récapitulatifs ».",
        lien="/recap/%s" % row[1],
    )


@admin_bp.route('/admin-auth', methods=['POST'])
def admin_auth():
    data = request.get_json()
    password = data.get('password', '')
    password_bytes = password.encode('utf-8')
    try:
        if bcrypt.checkpw(password_bytes, ADMIN_PASSWORD_HASH):
            new_token = str(uuid.uuid4())
            expiration = datetime.now() + timedelta(minutes=TOKEN_LIFETIME_MINUTES)
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM api_tokens WHERE expires_at < NOW()")
                    cur.execute("INSERT INTO api_tokens (token, expires_at) VALUES (%s, %s)", (new_token, expiration))
                conn.commit()
            return jsonify({"status": "success", "token": new_token})
        else:
            return jsonify({"status": "error", "message": "Identifiants invalides"}), 401
    except Exception:
        return jsonify({"status": "error", "message": "Erreur serveur"}), 500


@admin_bp.route('/admin/refresh-token', methods=['POST'])
@admin_required
def refresh_token():
    old_token = request.headers.get('X-Admin-Token')
    new_token = str(uuid.uuid4())
    expiration = datetime.now() + timedelta(minutes=TOKEN_LIFETIME_MINUTES)
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM api_tokens WHERE token = %s", (old_token,))
                cur.execute("INSERT INTO api_tokens (token, expires_at) VALUES (%s, %s)", (new_token, expiration))
            conn.commit()
        return jsonify({"status": "success", "token": new_token})
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@admin_bp.route('/admin-logout', methods=['POST'])
def admin_logout():
    token = request.headers.get('X-Admin-Token', None)
    if token:
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM api_tokens WHERE token = %s", (token,))
                conn.commit()
        except Exception:
            pass
    return jsonify({"status": "success"})


@admin_bp.route('/admin/check-token', methods=['GET'])
@role_required(ROLE_ADMIN)
def check_token():
    return jsonify({"status": "valid"}), 200



@admin_bp.route('/api/admin/fix-db-structure', methods=['GET'])
@role_required(ROLE_SUPERADMIN)
def fix_db_structure():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    ALTER TABLE Tournois
                    ADD COLUMN IF NOT EXISTS ligue_nom VARCHAR(100),
                    ADD COLUMN IF NOT EXISTS ligue_couleur VARCHAR(20);
                """)

                cur.execute("""
                    UPDATE Tournois t
                    SET ligue_nom = l.nom,
                        ligue_couleur = l.couleur
                    FROM Ligues l
                    WHERE t.ligue_id = l.id
                    AND (t.ligue_nom IS NULL OR t.ligue_nom = '');
                """)

            conn.commit()
        return jsonify({"status": "success", "message": "Structure Tournois mise à jour et historique synchronisé."})
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500



# ---------------------------------------------------------------------------
# Reset global du sigma -- permission gestion_config (« Reglage TS »).
#
# CHANGEMENT DE DOCTRINE, 2026-09-13 (contexte 8.5-D) : ces deux routes etaient
# @role_required(ROLE_CHEF_ADMIN), sous un commentaire « NE JAMAIS convertir »
# qui appliquait R-51. Elles sont desormais DELEGABLES via gestion_config.
#
# Motif : le reset passe PAR le moteur TrueSkill, il est tracable et
# reproductible -- d'une autre nature qu'une saisie manuelle de score. Qui regle
# le TrueSkill regle donc aussi ce qui le remet a zero, et les deux vivent sur
# la meme page (/admin/reglages).
#
# R-51 est inverse en connaissance de cause. Ne pas revenir a chef_admin+ sans
# revalidation : ce n'est pas un oubli.
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/global-reset', methods=['POST'])
@permission_required('gestion_config')
def apply_global_reset():
    """Ajoute du sigma aux joueurs situes SOUS un plafond, sans le leur faire
    depasser.

    Un joueur a 1.8, reset de 0.3, plafond a 2 : il va a 2.0, pas a 2.1. Un
    joueur deja a 2.0 ou au-dessus n'est pas touche et ne laisse aucune trace.

    Le plafond est obligatoire : c'est lui qui borne le geste, et le laisser
    optionnel rendrait « pas de plafond » atteignable par simple oubli du champ.
    """
    data = request.get_json()
    try:
        val = float(data.get('value', 0))
        max_sigma = float(data.get('max_sigma', 0))
        date_str = data.get('date')

        if val <= 0:
            return jsonify({"error": "La valeur doit être positive"}), 400

        if max_sigma <= 0:
            return jsonify({"error": "Le plafond de sigma doit être positif"}), 400

        if not date_str:
            return jsonify({"error": "Une date est requise"}), 400

        try:
            target_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
             return jsonify({"error": "Format de date invalide"}), 400

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM Tournois WHERE date >= %s", (target_date,))
                conflict_count = cur.fetchone()[0]

                if conflict_count > 0:
                    return jsonify({
                        "error": f"Impossible : {conflict_count} tournoi(s) existent à cette date ou après. Le reset invaliderait leurs calculs."
                    }), 409

                cur.execute("SELECT id, sigma FROM Joueurs WHERE sigma < %s", (max_sigma,))
                concernes = cur.fetchall()

                if not concernes:
                    return jsonify({
                        "error": f"Aucun joueur n'a un sigma inférieur à {max_sigma} : le reset n'aurait aucun effet."
                    }), 409

                # min() = c'est le plafond qui gagne quand il est plus proche
                # que la valeur demandee.
                lignes = [
                    (joueur_id, sigma, min(sigma + val, max_sigma))
                    for joueur_id, sigma in concernes
                ]

                cur.execute(
                    "INSERT INTO global_resets (date, value_applied, max_sigma) VALUES (%s, %s, %s) RETURNING id",
                    (target_date, val, max_sigma),
                )
                reset_id = cur.fetchone()[0]

                psycopg2.extras.execute_values(cur, """
                    UPDATE Joueurs AS j SET sigma = data.new_sigma
                    FROM (VALUES %s) AS data(id, new_sigma)
                    WHERE j.id = data.id
                """, [(joueur_id, new_sigma) for joueur_id, _old, new_sigma in lignes])

                psycopg2.extras.execute_values(cur, """
                    INSERT INTO global_reset_details
                        (reset_id, joueur_id, old_sigma, new_sigma, delta_applied)
                    VALUES %s
                """, [
                    (reset_id, joueur_id, old_sigma, new_sigma, new_sigma - old_sigma)
                    for joueur_id, old_sigma, new_sigma in lignes
                ])

                # Le detail par joueur vit deja dans global_reset_details : le
                # dupliquer ici ferait grossir le journal sans rien apprendre.
                # On garde ce qui identifie le GESTE et permet de le retrouver.
                audit.ecrire(cur, 'reset_global_applique', 'systeme', reset_id, {
                    "valeur": val, "max_sigma": max_sigma,
                    "date_cible": str(target_date),
                    "joueurs_touches": len(lignes),
                })

            conn.commit()
            recalculate_tiers()
            invalidate_cache()

        return jsonify({
            "status": "success",
            "message": (
                f"Sigma augmenté de {val} (plafond {max_sigma}) pour "
                f"{len(lignes)} joueur(s) (Date: {date_str})."
            ),
        })
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


# Meme regle que apply_global_reset ci-dessus : delegable via gestion_config.
# Annuler un reset doit suivre le droit de l'appliquer -- separer les deux
# laisserait quelqu'un declencher un geste qu'il ne peut pas reprendre.
@admin_bp.route('/api/admin/revert-global-reset', methods=['POST'])
@permission_required('gestion_config')
def revert_global_reset():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, value_applied, date FROM global_resets ORDER BY id DESC LIMIT 1")
                last = cur.fetchone()
                if not last:
                    return jsonify({"error": "Aucun reset à annuler"}), 404

                reset_id, val, reset_date = last

                cur.execute("SELECT COUNT(*) FROM Tournois WHERE date >= %s", (reset_date,))
                conflict_count = cur.fetchone()[0]

                if conflict_count > 0:
                    return jsonify({
                        "error": f"Annulation impossible : {conflict_count} tournoi(s) ont été enregistrés depuis ce reset ({reset_date}). Annuler maintenant fausserait l'historique."
                    }), 409

                cur.execute(
                    "SELECT joueur_id, old_sigma FROM global_reset_details WHERE reset_id = %s",
                    (reset_id,),
                )
                details = cur.fetchall()

                if details:
                    # Restauration a l'identique : avec un plafond, les joueurs
                    # n'ont pas tous recu `val`, donc le soustraire ferait
                    # descendre les joueurs ecretes plus bas que leur point de
                    # depart. Le garde-fou ci-dessus garantit qu'aucun tournoi
                    # n'a bouge ces sigma depuis.
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET sigma = data.old_sigma
                        FROM (VALUES %s) AS data(id, old_sigma)
                        WHERE j.id = data.id
                    """, details)
                else:
                    # Reset applique avant la migration du plafond : pas de
                    # detail par joueur, mais il etait uniforme et sans plafond.
                    cur.execute("UPDATE Joueurs SET sigma = sigma - %s", (val,))

                # AVANT le DELETE : la ligne disparait, et avec elle la seule
                # trace de ce qui avait ete applique.
                audit.ecrire(cur, 'reset_global_annule', 'systeme', reset_id, {
                    "valeur_annulee": float(val), "date_du_reset": str(reset_date),
                })
                cur.execute("DELETE FROM global_resets WHERE id = %s", (reset_id,))
            conn.commit()
            recalculate_tiers()
            invalidate_cache()

        return jsonify({"status": "success", "message": "Dernier reset annulé."})
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500



@admin_bp.route('/admin/config', methods=['GET'])
@player_required
def get_config():
    """Lecture seule des reglages. Ouverte a toute session authentifiee.

    Trois pages d'administration en dependent sans relever de gestion_config :
    Ligues (etat du mode ligue), Saisons (mouvements inter-ligues) et Fiches
    joueurs. L'exiger ici rendrait ces pages inutilisables a qui porte leur
    propre permission -- et ces valeurs ne sont pas des secrets : le mode ligue
    et le seuil de classement se deduisent deja des pages publiques.
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT key, value FROM Configuration WHERE key IN ('tau', 'ghost_enabled', 'ghost_penalty', 'ghost_threshold_sessions', 'ghost_interval_sessions', 'unranked_threshold', 'sigma_threshold', 'league_mode_enabled', 'inter_league_moves', 'ip_version_live')")
                rows = dict(cur.fetchall())
        return jsonify({
            "tau": float(rows.get('tau', DEFAULT_TAU)),
            "ghost_enabled": rows.get('ghost_enabled', 'false') == 'true',
            "ghost_penalty": float(rows.get('ghost_penalty', DEFAULT_GHOST_PENALTY)),
            "ghost_threshold_sessions": int(rows.get('ghost_threshold_sessions',
                                                     DEFAULT_GHOST_THRESHOLD_SESSIONS)),
            "ghost_interval_sessions": int(rows.get('ghost_interval_sessions',
                                                    DEFAULT_GHOST_INTERVAL_SESSIONS)),
            "unranked_threshold": int(rows.get('unranked_threshold', DEFAULT_UNRANKED_THRESHOLD)),
            "sigma_threshold": float(rows.get('sigma_threshold', DEFAULT_SIGMA_THRESHOLD)),
            "league_mode_enabled": rows.get('league_mode_enabled', 'false') == 'true',
            "inter_league_moves": int(rows.get('inter_league_moves', 0)),
            "ip_version_live": rows.get('ip_version_live', IP_VERSION_DEFAULT),
        })
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@admin_bp.route('/admin/config', methods=['POST'])
@player_required
def update_config():
    """Reglages TrueSkill, et les clefs de mode ligue. DEUX permissions.

    Depuis le 2026-09-13 les clefs de ligue (league_mode_enabled,
    inter_league_moves) relevent de gestion_ligues, le reste de gestion_config
    (« Reglage TS »).

    PAS de @permission_required ici, volontairement : le decorateur s'execute
    avant le corps et exigerait gestion_config de tout le monde -- un admin qui
    n'a que « Ligues » serait refuse avant d'avoir pu activer le mode ligue,
    c'est-a-dire l'inverse de la separation voulue. Chaque domaine porte donc sa
    propre verification ci-dessous, et l'appel qui ne touche a rien est refuse.

    Le refus est EXPLICITE (403) et non un silence : desactiver le mode ligue
    detruit l'affectation de tous les joueurs, croire l'avoir fait sans que rien
    ne bouge serait le pire des deux mondes.
    """
    data = request.get_json()
    try:
        touche_ligues = 'league_mode_enabled' in data or 'inter_league_moves' in data
        if touche_ligues:
            accordee, erreur = compte_a_permission(g.compte, 'gestion_ligues')
            if erreur is not None:
                return erreur
            if not accordee:
                return jsonify({
                    "error": "Le mode ligue releve de la permission « Ligues ».",
                    "code": "permission_manquante",
                }), 403
        # Ces huit clefs ne sont ecrites QUE si elles sont dans le payload.
        # Elles l'etaient auparavant a chaque appel, defauts compris : un client
        # qui n'envoyait que sa propre clef reinitialisait donc tau, la penalite
        # fantome et le seuil de classement sans le savoir. C'est exactement ce
        # que faisait la page Ligues, qui relisait toute la config pour la
        # reposter -- contournable seulement tant que les deux domaines
        # partageaient la meme permission.
        configs = []
        touche_trueskill = False

        if 'tau' in data:
            configs.append(('tau', str(float(data['tau']))))
        if 'ghost_enabled' in data:
            configs.append(('ghost_enabled', str(data['ghost_enabled']).lower()))
        if 'ghost_penalty' in data:
            configs.append(('ghost_penalty', str(float(data['ghost_penalty']))))
        # Seuils exprimes en SESSIONS LOUPEES, plus en jours (decision 8).
        # max(1, ...) : un seuil nul penaliserait des le tournoi ou le joueur
        # vient de jouer, un intervalle nul diviserait par zero.
        if 'ghost_threshold_sessions' in data:
            configs.append(('ghost_threshold_sessions',
                            str(max(1, int(data['ghost_threshold_sessions'])))))
        if 'ghost_interval_sessions' in data:
            configs.append(('ghost_interval_sessions',
                            str(max(1, int(data['ghost_interval_sessions'])))))
        if 'sigma_threshold' in data:
            configs.append(('sigma_threshold', str(float(data['sigma_threshold']))))
        if 'ip_version_live' in data:
            ip_version_live = str(data['ip_version_live'])
            if ip_version_live not in ('v1', 'v2'):
                return jsonify({"error": "ip_version_live invalide"}), 400
            configs.append(('ip_version_live', ip_version_live))

        # Les seuils de tiers (nom/couleur/seuil_k/rang) ne relevent plus de
        # cette route depuis les tiers dynamiques (Partie B) : ils vivent
        # dans la table `tiers`, geree par les routes CRUD /admin/tiers/*
        # plus bas dans ce fichier.

        # A part : sa valeur pilote le reclassement de TOUS les joueurs plus bas.
        unranked_threshold = None
        if 'unranked_threshold' in data:
            unranked_threshold = int(data['unranked_threshold'])
            configs.append(('unranked_threshold', str(unranked_threshold)))

        touche_trueskill = bool(configs)
        if touche_trueskill:
            accordee, erreur = compte_a_permission(g.compte, 'gestion_config')
            if erreur is not None:
                return erreur
            if not accordee:
                return jsonify({
                    "error": "Ces reglages relevent de la permission « Reglage TS ».",
                    "code": "permission_manquante",
                }), 403

        # Sans ce refus, un compte sans aucune des deux permissions obtiendrait
        # un 200 pour un appel qui n'ecrit rien -- une reussite apparente.
        if not touche_trueskill and not touche_ligues:
            return jsonify({"error": "Aucun reglage fourni"}), 400

        with get_db_connection() as conn:
            with conn.cursor() as cur:

                if 'league_mode_enabled' in data:
                    league_mode = str(data.get('league_mode_enabled')).lower()
                    configs.append(('league_mode_enabled', league_mode))

                    if league_mode == 'false':
                        cur.execute("UPDATE Joueurs SET ligue_id = NULL")

                if 'inter_league_moves' in data:
                    inter_league_moves = int(data.get('inter_league_moves', 0))
                    configs.append(('inter_league_moves', str(inter_league_moves)))

                for k, v in configs:
                    cur.execute("""
                        INSERT INTO Configuration (key, value)
                        VALUES (%s, %s)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                    """, (k, v))

                # Uniquement si le seuil a ete fourni : sans ce garde, un appel
                # qui ne touche qu'au mode ligue passerait None ici et
                # declasserait tous les joueurs d'un coup.
                if unranked_threshold is not None:
                    cur.execute("""
                        UPDATE Joueurs
                        SET is_ranked = (COALESCE(consecutive_missed, 0) < %s)
                    """, (unranked_threshold,))

                # DEUX actions distinctes et non une seule : cette route sert
                # deux domaines sous deux permissions differentes
                # (gestion_config et gestion_ligues). Les confondre dans le
                # journal rendrait impossible de filtrer « qui a touche aux
                # ligues » sans relire chaque ligne de details.
                CLES_LIGUE = {'league_mode_enabled', 'inter_league_moves'}
                ligue = {k: v for k, v in configs if k in CLES_LIGUE}
                ts = {k: v for k, v in configs if k not in CLES_LIGUE}
                if ts:
                    audit.ecrire(cur, 'config_modifiee', 'systeme', None, {
                        "cles": ts,
                        # Le declassement touche TOUS les joueurs d'un coup :
                        # le signaler evite de croire a un reglage anodin.
                        "declassement_rejoue": unranked_threshold is not None,
                    })
                if ligue:
                    audit.ecrire(cur, 'ligues_configurees', 'systeme', None, {"cles": ligue})

            conn.commit()
            recalculate_tiers()
            invalidate_cache()

        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Erreur requête: {e}")
        return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/config/tier-distribution', methods=['GET'])
@permission_required('gestion_config')
def get_tier_distribution():
    """Courbe + position des joueurs rankes actuels, pour le tableau de
    reglage des seuils de tiers (page Reglages TrueSkill). Meme population
    que recalculate_tiers() : c'est la distribution qui sera reellement
    utilisee au prochain recalcul, le preview doit lui etre fidele.
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'sigma_threshold'")
                res = cur.fetchone()
                threshold = float(res[0]) if res else DEFAULT_SIGMA_THRESHOLD

                cur.execute("SELECT nom, mu, sigma, is_ranked, color FROM Joueurs")
                rows = cur.fetchall()

        players = [
            {"nom": nom, "mu": mu, "sigma": sigma, "color": color}
            for nom, mu, sigma, is_ranked, color in rows
            if has_tier(is_ranked, sigma, threshold)
        ]
        dist = build_distribution(players, lambda p: trueskill_score(p["mu"], p["sigma"]))
        return jsonify(dist)
    except Exception as e:
        logger.error(f"Erreur tier-distribution: {e}")
        return jsonify({"error": "Erreur serveur"}), 500


# --- Tiers dynamiques (Partie B, docs/tableau-seuils-tiers-plan.md) --------
#
# 'U' (non classe / hors distribution) reste cable en dur ailleurs (has_tier,
# IP_V2_REF_REQUIRE_TIER, valeur par defaut a la creation d'un joueur) : ce
# n'est pas une ligne de cette table, et un admin ne peut ni le nommer ainsi
# ni le supprimer via ces routes -- _nom_valide() le refuse explicitement.
#
# Toutes ces routes sont sous gestion_config, comme le reste des reglages
# TrueSkill (cf update_config plus haut), et recalculent les tiers de tous
# les joueurs immediatement apres chaque ecriture -- meme comportement que
# /admin/config.

def _nom_tier_valide(nom) -> str | None:
    """Normalise et valide un nom de tier ; None si invalide (vide, > 10
    caracteres, ou 'U' qui est reserve au sentinel hors-distribution)."""
    if not isinstance(nom, str):
        return None
    nom = nom.strip()
    if not (1 <= len(nom) <= 10):
        return None
    if nom.upper() == 'U':
        return None
    return nom


def _couleur_valide(couleur) -> str | None:
    import re as _re
    if not isinstance(couleur, str):
        return None
    couleur = couleur.strip()
    return couleur if _re.fullmatch(r'#[0-9a-fA-F]{3,8}', couleur) else None


def _renumeroter_rangs(cur) -> None:
    """Rangs toujours 0..N-1 sans trou, dans l'ordre croissant deja en base.
    A appeler apres toute suppression : un trou casserait l'hypothese
    « le plancher est le tier de plus petit rang » si le trou se trouvait
    juste au-dessus du rang 0."""
    cur.execute("SELECT id FROM tiers ORDER BY rang ASC")
    ids = [r[0] for r in cur.fetchall()]
    for nouveau_rang, tid in enumerate(ids):
        cur.execute("UPDATE tiers SET rang = %s WHERE id = %s", (nouveau_rang, tid))


def _appliquer_plancher(cur) -> None:
    """Efface le seuil du tier de plus petit rang : le plancher n'a pas de
    frontiere basse, par definition.

    NE FABRIQUE AUCUNE VALEUR. Une version precedente donnait d'office
    `voisin + 1.0` a tout tier sans seuil qui n'etait plus le plancher --
    elle inventait donc une frontiere que l'admin n'avait pas demandee, ce qui
    corrompait le classement (bug de recette du 14/09 : un tier se retrouvait
    a 1.0 au milieu du classement, au-dessus de tiers censes lui etre
    superieurs). Un tier promu au-dessus du plancher recoit sa vraie valeur du
    PUT correspondant ; s'il n'en a pas, `tier_for_score()` le traite comme le
    dernier recours, ce qui reste coherent.

    N'est appelee qu'en fin d'operation (creation, suppression,
    reordonnancement), jamais entre deux ecritures d'une meme sequence.
    """
    cur.execute("SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1")
    row = cur.fetchone()
    if row is not None and row[1] is not None:
        cur.execute("UPDATE tiers SET seuil_k = NULL WHERE id = %s", (row[0],))


@admin_bp.route('/admin/tiers', methods=['GET'])
@player_required
def get_tiers():
    """Lecture seule, ouverte a toute session authentifiee -- meme raison
    que get_config() : ces valeurs ne sont pas des secrets, et /classement
    (page publique) en depend deja indirectement via /tier-seuils."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                tiers = load_tiers(cur)
        return jsonify(tiers)
    except Exception as e:
        logger.error(f"Erreur get_tiers: {e}")
        return jsonify({"error": "Erreur serveur"}), 500


@admin_bp.route('/admin/tiers', methods=['POST'])
@permission_required('gestion_config')
def create_tier():
    """Cree un tier. Position d'insertion optionnelle (`apres_rang`) : sans
    elle, le nouveau tier prend le rang le plus haut (meilleur tier) --
    choix par defaut le moins surprenant pour un ajout."""
    data = request.get_json() or {}
    nom = _nom_tier_valide(data.get('nom'))
    if nom is None:
        return jsonify({"error": "Nom de tier invalide (1-10 caracteres, 'U' reserve)"}), 400
    couleur = _couleur_valide(data.get('couleur'))
    if couleur is None:
        return jsonify({"error": "Couleur invalide (format hex, ex: #f77b7b)"}), 400
    seuil_k = data.get('seuil_k')
    try:
        seuil_k = float(seuil_k) if seuil_k is not None else None
    except (TypeError, ValueError):
        return jsonify({"error": "seuil_k invalide"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM tiers WHERE UPPER(nom) = UPPER(%s)", (nom,))
                if cur.fetchone()[0] > 0:
                    return jsonify({"error": f"Un tier « {nom} » existe deja"}), 400

                apres_rang = data.get('apres_rang')
                cur.execute("SELECT rang FROM tiers ORDER BY rang DESC LIMIT 1")
                rang_max = cur.fetchone()
                rang_max = rang_max[0] if rang_max else -1

                if apres_rang is None:
                    # Par defaut : au sommet (meilleur tier).
                    nouveau_rang = rang_max + 1
                else:
                    # Insertion juste au-dessus du rang donne : decale tout ce
                    # qui est strictement au-dessus pour lui faire de la place.
                    apres_rang = int(apres_rang)
                    cur.execute("UPDATE tiers SET rang = rang + 1 WHERE rang > %s", (apres_rang,))
                    nouveau_rang = apres_rang + 1

                # Le nouveau tier n'est jamais le plancher a la creation (sauf
                # table vide, cas degenere non attendu en usage normal) :
                # _appliquer_plancher() rectifie de toute facon juste apres si
                # besoin, donc seuil_k fourni est respecte tel quel ici.
                cur.execute(
                    "INSERT INTO tiers (nom, couleur, seuil_k, rang) VALUES (%s, %s, %s, %s) RETURNING id",
                    (nom, couleur, seuil_k, nouveau_rang),
                )
                nouvel_id = cur.fetchone()[0]
                _appliquer_plancher(cur)
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        # L'id est renvoye pour que l'appelant (panneau de gestion des tiers)
        # puisse suivre ce tier sans avoir a le reidentifier par son nom
        # ensuite (fragile si un renommage est encore en cours cote client).
        return jsonify({"status": "success", "id": nouvel_id})
    except Exception as e:
        logger.error(f"Erreur create_tier: {e}")
        return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/tiers/<int:tier_id>', methods=['PUT'])
@permission_required('gestion_config')
def update_tier(tier_id):
    """Renomme / recolore / change le seuil d'UN tier. Le rang se change via
    /admin/tiers/reorder, pas ici -- un changement de rang isole ouvrirait un
    etat incoherent (deux tiers au meme rang) le temps de plusieurs appels."""
    data = request.get_json() or {}
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, rang FROM tiers WHERE id = %s", (tier_id,))
                row = cur.fetchone()
                if row is None:
                    return jsonify({"error": "Tier introuvable"}), 404

                champs, valeurs = [], []
                if 'nom' in data:
                    nom = _nom_tier_valide(data['nom'])
                    if nom is None:
                        return jsonify({"error": "Nom de tier invalide (1-10 caracteres, 'U' reserve)"}), 400
                    cur.execute(
                        "SELECT COUNT(*) FROM tiers WHERE UPPER(nom) = UPPER(%s) AND id != %s",
                        (nom, tier_id),
                    )
                    if cur.fetchone()[0] > 0:
                        return jsonify({"error": f"Un tier « {nom} » existe deja"}), 400
                    champs.append("nom = %s"); valeurs.append(nom)
                if 'couleur' in data:
                    couleur = _couleur_valide(data['couleur'])
                    if couleur is None:
                        return jsonify({"error": "Couleur invalide (format hex, ex: #f77b7b)"}), 400
                    champs.append("couleur = %s"); valeurs.append(couleur)
                # seuil_k accepte tel quel, y compris sur le tier actuellement
                # plancher : le panneau d'administration envoie ses PUT AVANT
                # le /reorder, donc « qui est le plancher » est encore l'ancien
                # etat a cet instant. Refuser ici bloquait tout ajout d'un
                # nouveau tier sous le plancher existant (bug de recette du
                # 13/09). L'invariant « seul le rang le plus bas a seuil_k
                # NULL » est retabli par _appliquer_plancher() ci-dessous, et
                # de nouveau apres le reorder.
                if 'seuil_k' in data:
                    if data['seuil_k'] is None:
                        champs.append("seuil_k = NULL")
                    else:
                        try:
                            seuil_k = float(data['seuil_k'])
                        except (TypeError, ValueError):
                            return jsonify({"error": "seuil_k invalide"}), 400
                        champs.append("seuil_k = %s"); valeurs.append(seuil_k)

                if not champs:
                    return jsonify({"error": "Aucun champ a modifier"}), 400

                valeurs.append(tier_id)
                cur.execute(f"UPDATE tiers SET {', '.join(champs)} WHERE id = %s", valeurs)
                # PAS de _appliquer_plancher() ici : le panneau envoie un PUT
                # par tier AVANT le /reorder final, donc le tier vise peut
                # encore etre le plancher en base alors qu'il ne le sera plus
                # apres reordonnancement. Rejouer l'invariant a cet instant
                # effacait le seuil tout juste ecrit (bug du 14/09 : la valeur
                # saisie etait perdue, puis remplacee par une valeur inventee).
                # C'est /reorder, qui connait l'ordre final, qui le retablit.
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Erreur update_tier: {e}")
        return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/tiers/<int:tier_id>', methods=['DELETE'])
@permission_required('gestion_config')
def delete_tier(tier_id):
    """Supprime un tier. S'il etait le plancher, le tier juste au-dessus
    devient automatiquement le nouveau plancher (_appliquer_plancher) --
    decision de l'utilisateur (13/09), voir docs/tableau-seuils-tiers-plan.md
    Partie B. Refuse de vider la table : il faut toujours au moins un tier
    pour que has_tier()/recalculate_tiers() aient un resultat autre que 'U'."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM tiers")
                if cur.fetchone()[0] <= 1:
                    return jsonify({"error": "Impossible de supprimer le dernier tier restant"}), 400

                cur.execute("DELETE FROM tiers WHERE id = %s", (tier_id,))
                if cur.rowcount == 0:
                    return jsonify({"error": "Tier introuvable"}), 404

                _renumeroter_rangs(cur)
                _appliquer_plancher(cur)
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Erreur delete_tier: {e}")
        return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/tiers/reorder', methods=['PUT'])
@permission_required('gestion_config')
def reorder_tiers():
    """Recoit l'ordre COMPLET des tiers (liste d'ids, du meilleur au pire) et
    reassigne tous les rangs d'un coup -- evite un etat incoherent (deux
    tiers au meme rang) qu'un reordonnancement fait d'appels individuels
    pourrait produire entre deux requetes."""
    data = request.get_json() or {}
    ordre = data.get('ordre')
    if not isinstance(ordre, list) or not ordre:
        return jsonify({"error": "« ordre » doit etre une liste non vide d'ids"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM tiers")
                ids_existants = {r[0] for r in cur.fetchall()}
                try:
                    ids_recus = {int(i) for i in ordre}
                except (TypeError, ValueError):
                    return jsonify({"error": "« ordre » doit contenir des ids entiers"}), 400
                if ids_recus != ids_existants:
                    return jsonify({"error": "« ordre » doit contenir exactement tous les tiers existants"}), 400

                # Rang decroissant : premier de la liste = meilleur tier =
                # rang le plus haut. Passage par des rangs temporaires
                # negatifs : `rang` est UNIQUE, des UPDATE un par un vers les
                # rangs finaux (0..n-1, deja tous occupes) violeraient la
                # contrainte des le premier si son rang cible est encore pris
                # par un autre tier de la boucle.
                n = len(ordre)
                for position, tid in enumerate(ordre):
                    cur.execute("UPDATE tiers SET rang = %s WHERE id = %s", (-(position + 1), int(tid)))
                for position, tid in enumerate(ordre):
                    cur.execute("UPDATE tiers SET rang = %s WHERE id = %s", (n - 1 - position, int(tid)))

                _appliquer_plancher(cur)
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Erreur reorder_tiers: {e}")
        return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/tiers/reset', methods=['POST'])
@permission_required('gestion_config')
def reset_tiers():
    """Restaure exactement S/A/B/C avec les seuils par defaut (DEFAULT_TIERS)
    -- le bouton « Reinitialiser » du panneau de gestion des tiers. Detruit
    toute personnalisation en cours, le frontend confirme avant d'appeler."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM tiers")
                for t in DEFAULT_TIERS:
                    cur.execute(
                        "INSERT INTO tiers (nom, couleur, seuil_k, rang) VALUES (%s, %s, %s, %s)",
                        (t["nom"], t["couleur"], t["seuil_k"], t["rang"]),
                    )
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Erreur reset_tiers: {e}")
        return jsonify({"error": "Erreur serveur"}), 500


@admin_bp.route('/admin/joueurs', methods=['GET'])
@permission_required('gestion_joueurs')
def api_get_joueurs():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT j.id, j.nom, j.mu, j.sigma, j.tier, j.is_ranked, j.consecutive_missed, j.color,
                           l.id, l.nom, l.couleur,
                           COALESCE(c.discord_global_name, c.discord_username), c.statut
                    FROM Joueurs j
                    LEFT JOIN Ligues l ON j.ligue_id = l.id
                    LEFT JOIN comptes c ON c.joueur_id = j.id
                    ORDER BY j.nom ASC
                """)
                joueurs = [{
                    "id": r[0],
                    "nom": r[1],
                    "mu": r[2],
                    "sigma": r[3],
                    "tier": r[4].strip() if r[4] else "?",
                    "is_ranked": r[5],
                    "consecutive_missed": r[6] if r[6] is not None else 0,
                    "color": r[7] if r[7] else "#FFFFFF",
                    "ligue": { "id": r[8], "nom": r[9], "couleur": r[10] } if r[8] else None,
                    "compte_lie": { "pseudo": r[11], "statut": r[12] } if r[12] else None
                } for r in cur.fetchall()]
        return jsonify(joueurs)
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


@admin_bp.route('/admin/joueurs/<int:id>', methods=['PUT'])
@permission_required('gestion_joueurs')
def api_update_joueur(id):
    """Edite une fiche joueur, un champ a la fois selon les droits de l'acteur.

    `gestion_joueurs` ouvre la route (lecture de la fiche) ; chaque champ exige
    en plus sa sous-permission, listee dans PERMISSIONS_CHAMPS_JOUEUR. La
    verification est ici plutot que dans un decorateur parce que les quatre
    champs partagent un seul UPDATE : un @permission_required de route entiere
    ne saurait pas lequel est en cause.

    Un champ absent du payload, ou renvoye identique a la base, ne demande
    AUCUN droit -- sinon un admin qui n'a que « couleur » ne pourrait rien
    enregistrer, le formulaire renvoyant toujours la fiche entiere.
    """
    data = request.get_json()
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT nom, mu, sigma, is_ranked, color, consecutive_missed"
                    " FROM Joueurs WHERE id=%s",
                    (id,))
                actuel = cur.fetchone()
        if actuel is None:
            return jsonify({"error": "Joueur introuvable"}), 404

        # Valeur demandee par champ, repliee sur l'existant quand le payload ne
        # le porte pas. Les conversions restent groupees ici pour qu'une saisie
        # non numerique sorte en 400 avant toute verification de droit.
        courant = {"nom": actuel[0], "mu": float(actuel[1]), "sigma": float(actuel[2]),
                   "is_ranked": bool(actuel[3]), "color": actuel[4] or '#FFFFFF'}
        # Hors de `courant` : ce champ n'est pas editable par le formulaire
        # (seul le superadmin y touche), donc il n'a rien a faire dans la
        # comparaison qui decide des droits. Il est lu pour le JOURNAL seul --
        # tracer une modification sans dire d'ou elle part ne sert a rien.
        actuel_absences = actuel[5]
        demande = dict(courant)
        if 'nom' in data:
            demande['nom'] = data['nom']
        if 'mu' in data:
            demande['mu'] = float(data['mu'])
        if 'sigma' in data:
            demande['sigma'] = float(data['sigma'])
        if 'is_ranked' in data:
            demande['is_ranked'] = bool(data['is_ranked'])
        if 'color' in data:
            demande['color'] = data['color']

        # Comparaison AVANT verification : renvoyer la valeur affichee sans y
        # toucher n'est pas une modification.
        #
        # mu/sigma se comparent A LA PRECISION AFFICHEE (3 decimales, cf.
        # toFixed(3) dans openEditModal). TrueSkill produit des valeurs bien
        # plus longues -- un sigma de 8.333333333 s'affiche « 8.333 » et revient
        # ainsi : l'ecart est de 3e-7, donc une tolerance plus fine le lirait
        # comme une saisie et refuserait un admin qui n'a touche a rien.
        # C'est le defaut que ce calcul existe pour eviter.
        DECIMALES_AFFICHEES = 3

        def a_change(champ):
            if champ in ('mu', 'sigma'):
                return (round(demande[champ], DECIMALES_AFFICHEES)
                        != round(courant[champ], DECIMALES_AFFICHEES))
            return demande[champ] != courant[champ]

        for champ, permission in PERMISSIONS_CHAMPS_JOUEUR.items():
            if not a_change(champ):
                continue
            accordee, erreur = compte_a_permission(g.compte, permission)
            if erreur is not None:
                return erreur
            if not accordee:
                return jsonify({
                    "error": "Vous n'avez pas le droit de modifier ce champ.",
                    "code": "permission_manquante",
                    "champ": champ,
                    "permission": permission,
                }), 403

        # Un champ juge inchange garde la valeur de la BASE, pas celle du
        # payload. Sans ca, editer le nom d'un joueur reecrirait son sigma avec
        # les 3 decimales affichees (8.333333333 -> 8.333) : une troncature
        # silencieuse du score, a chaque passage dans la modale.
        for champ in PERMISSIONS_CHAMPS_JOUEUR:
            if not a_change(champ):
                demande[champ] = courant[champ]

        mu, sigma, nom = demande['mu'], demande['sigma'], demande['nom']
        is_ranked, color = demande['is_ranked'], demande['color']

        # `consecutive_missed` declenche la penalite de sigma (decision 8 de
        # docs/plan-sessions-tournois.md) : une valeur saisie a la main
        # provoque ou empeche une penalite au tournoi suivant. C'est donc une
        # valeur derivee du calcul, pas une donnee d'edition courante -- et la
        # laisser modifiable par tout detenteur de `gestion_joueurs` l'a rendue
        # non fiable (28 compteurs perimes constates le 15/09).
        #
        # Le SUPERADMIN garde la main : il faut une porte de sortie pour
        # rattraper un compteur faux sans passer par la base. CAPACITE DE ROLE,
        # jamais une permission delegable -- meme regle que l'annulation de
        # tournoi (hierarchie-admin-plan.md 5).
        #
        # Le chemin normal reste scripts/recompter_absences.py, qui recalcule
        # tout le monde selon une regle unique plutot qu'un joueur a la main.
        modifier_absences = (g.compte['role'] == ROLE_SUPERADMIN
                             and 'consecutive_missed' in data)
        if modifier_absences:
            consecutive_missed = max(0, int(data['consecutive_missed']))

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                if modifier_absences:
                    cur.execute(
                        "UPDATE Joueurs SET nom=%s, mu=%s, sigma=%s, is_ranked=%s,"
                        " consecutive_missed=%s, color=%s WHERE id=%s",
                        (nom, mu, sigma, is_ranked, consecutive_missed, color, id))
                else:
                    cur.execute(
                        "UPDATE Joueurs SET nom=%s, mu=%s, sigma=%s, is_ranked=%s,"
                        " color=%s WHERE id=%s",
                        (nom, mu, sigma, is_ranked, color, id))

                # C'est la trace qui repond a la question d'origine : « qui a
                # mis ce joueur a 32.5, et quelle etait sa valeur avant ».
                #
                # `a_change()` fait deja tout le travail : il compare A LA
                # PRECISION AFFICHEE, donc un sigma revenu inchange de la modale
                # (8.333333333 -> 8.333) n'est PAS compte comme une
                # modification. Reutiliser ce predicat plutot que de recomparer
                # ici evite que le journal et la verification de droits ne
                # divergent -- sinon on tracerait des modifications que la
                # route n'a pas jugees telles, et inversement.
                champs = [c for c in PERMISSIONS_CHAMPS_JOUEUR if a_change(c)]
                if modifier_absences and consecutive_missed != actuel_absences:
                    champs.append('consecutive_missed')
                if champs:
                    avant = {c: courant[c] for c in champs if c in courant}
                    apres = {c: demande[c] for c in champs if c in demande}
                    if 'consecutive_missed' in champs:
                        avant['consecutive_missed'] = actuel_absences
                        apres['consecutive_missed'] = consecutive_missed
                    audit.ecrire(cur, 'joueur_modifie', 'joueur', id, {
                        # Le nom de la fiche, FIGE a l'instant de l'action.
                        # Sans lui, la ligne dit « fiche 7 modifiee » et il faut
                        # aller chercher qui est le joueur 7 -- ou le deviner,
                        # si la fiche a ete renommee ou supprimee depuis. C'est
                        # le meme motif que la denormalisation de l'acteur.
                        #
                        # `courant` et non `demande` : on nomme la fiche telle
                        # qu'elle etait AVANT, sinon un renommage afficherait le
                        # nouveau nom pour une ligne qui raconte le changement.
                        "joueur_nom": courant['nom'],
                        "avant": avant, "apres": apres, "champs": champs,
                        # Le drapeau qui permet de filtrer d'un coup d'oeil les
                        # modifications de SCORE parmi les simples renommages.
                        "score_modifie": bool({'mu', 'sigma'} & set(champs)),
                    })
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Erreur requête: {e}")
        return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/joueurs/<int:id>', methods=['DELETE'])
@permission_required('joueurs_irreversible')   # sous-permission : exige aussi gestion_joueurs
def api_delete_joueur(id):
    """Supprime un joueur, sauf s'il a un historique de matchs.

    Toutes les FK vers Joueurs sont en ON DELETE CASCADE : la suppression
    emporte participations, awards, ghost_log et league_movements. Or le moteur
    TrueSkill est incrémental — chaque tournoi part du mu/sigma courant et
    l'écrase — et il n'existe aucune fonction de recalcul depuis zéro. Retirer
    les participations d'un joueur rend donc le classement de TOUS les autres
    définitivement faux, sans moyen de le reconstruire.
    D'où le refus, et l'anonymisation offerte en alternative.
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT nom FROM Joueurs WHERE id = %s", (id,))
                row = cur.fetchone()
                if row is None:
                    conn.rollback()
                    return jsonify({"error": "Joueur introuvable"}), 404

                cur.execute("SELECT COUNT(*) FROM Participations WHERE joueur_id = %s", (id,))
                nb_participations = cur.fetchone()[0]
                if nb_participations > 0:
                    conn.rollback()
                    return jsonify({
                        "error": (
                            f"Ce joueur a participé à {nb_participations} tournoi(s). "
                            "Le supprimer fausserait définitivement le classement de tous "
                            "les autres joueurs, sans possibilité de le recalculer. "
                            "Utilisez l'anonymisation à la place."
                        ),
                        "code": "historique_non_vide",
                        "nb_participations": nb_participations,
                        "alternative": f"/admin/joueurs/{id}/anonymiser",
                    }), 409

                # La FK est en ON DELETE SET NULL : supprimer sans delier
                # laisserait un compte `linked` sans fiche, etat qu'aucun ecran
                # ne sait rattraper.
                cur.execute(
                    """SELECT id, statut,
                              COALESCE(discord_global_name, discord_username)
                       FROM comptes WHERE joueur_id = %s FOR UPDATE""",
                    (id,),
                )
                compte = cur.fetchone()
                compte_delie = None
                if compte is not None:
                    compte_id, statut_compte, pseudo = compte
                    # Une suspension est une decision independante du lien.
                    nouveau_statut = 'pending' if statut_compte == 'linked' else statut_compte
                    cur.execute(
                        """UPDATE comptes
                           SET joueur_id = NULL, statut = %s,
                               profil_synced_at = NULL, updated_at = now()
                           WHERE id = %s""",
                        (nouveau_statut, compte_id),
                    )
                    # Passe par le helper : cet appel omettait `acteur_compte_id`,
                    # donc le journal savait QUOI mais pas QUI (§3.2 du plan).
                    audit.ecrire(
                        cur, 'liaison_annulee', 'compte', compte_id,
                        {"joueur_id": id, "joueur_nom": row[0],
                         "statut": nouveau_statut,
                         "origine": "suppression_fiche"},
                    )
                    # Passe par le helper, comme tous les autres sites : cet
                    # INSERT ecrit a la main etait le seul a diverger, et il
                    # aurait fallu y reporter chaque evolution de la table.
                    notifier(
                        cur, compte_id, 'fiche_supprimee',
                        "Votre fiche joueur a été supprimée",
                        "La fiche « %s » n'existe plus, et votre compte n'y est donc "
                        "plus rattaché. Votre compte Discord, lui, est conservé : vous "
                        "pouvez demander une nouvelle fiche depuis « Mon compte »."
                        % row[0],
                        lien="/mon-compte/liaison",
                    )
                    compte_delie = {"id": compte_id, "pseudo": pseudo,
                                    "statut": nouveau_statut}

                # AVANT le DELETE : la ligne d'audit doit etre ecrite tant que
                # la fiche existe encore, et le nom consigne ici est la SEULE
                # trace qui en restera -- la suppression emporte tout le reste
                # par CASCADE.
                audit.ecrire(cur, 'joueur_supprime', 'joueur', id, {
                    "nom": row[0],
                    "compte_delie": compte_delie['id'] if compte_delie else None,
                })
                cur.execute("DELETE FROM Joueurs WHERE id=%s", (id,))
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        return jsonify({"status": "success", "compte_delie": compte_delie})
    except Exception as e:
        logger.error(f"Erreur suppression joueur {id}: {e}")
        return jsonify({"error": "Erreur serveur"}), 400


@admin_bp.route('/admin/joueurs/<int:id>/anonymiser', methods=['POST'])
@permission_required('joueurs_irreversible')   # sous-permission : exige aussi gestion_joueurs
def api_anonymiser_joueur(id):
    """Détache l'identité d'un joueur sans toucher à son dossier sportif.

    Aucun nom n'étant dénormalisé, un UPDATE du nom se propage partout et laisse
    stats, TrueSkill et awards identiques. Le suffixe aléatoire évite la collision
    avec un joueur qui porterait littéralement « Joueur #12 ».
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT nom FROM Joueurs WHERE id = %s", (id,))
                row = cur.fetchone()
                if row is None:
                    conn.rollback()
                    return jsonify({"error": "Joueur introuvable"}), 404
                ancien_nom = row[0]

                for _ in range(5):
                    nouveau_nom = f"Joueur #{id}-{secrets.token_hex(2)}"
                    cur.execute("SELECT 1 FROM Joueurs WHERE lower(nom) = lower(%s)", (nouveau_nom,))
                    if cur.fetchone() is None:
                        break
                else:
                    conn.rollback()
                    return jsonify({"error": "Impossible de générer un nom libre"}), 500

                cur.execute(
                    "UPDATE Joueurs SET nom = %s, color = %s, anonymise_at = now() WHERE id = %s",
                    (nouveau_nom, '#FFFFFF', id),
                )
                # L'ancien nom est verrouille par son empreinte, jamais en clair : sinon le
                # ressaisir dans le formulaire de tournoi recreerait la fiche effacee.
                cur.execute(
                    "INSERT INTO noms_interdits (nom_hash) VALUES (%s) ON CONFLICT DO NOTHING",
                    (hashlib.sha256(ancien_nom.strip().lower().encode('utf-8')).hexdigest(),),
                )
                # Idem : l'acteur manquait sur une action IRREVERSIBLE.
                audit.ecrire(cur, 'joueur_anonymise', 'joueur', id,
                             {"nouveau_nom": nouveau_nom})
            conn.commit()
            invalidate_cache()

        logger.info(f"Joueur {id} anonymisé")
        return jsonify({
            "status": "success",
            "ancien_nom": ancien_nom,
            "nouveau_nom": nouveau_nom,
        })
    except Exception as e:
        logger.error(f"Erreur anonymisation joueur {id}: {e}")
        return jsonify({"error": "Erreur serveur"}), 500


@admin_bp.route('/admin/joueurs', methods=['POST'])
@permission_required('joueurs_creation')   # sous-permission : exige aussi gestion_joueurs
def api_add_joueur():
    """Cree une fiche joueur.

    Le mu/sigma de depart exige `edition_mu_sigma`, comme sur l'edition : sans
    cette seconde verification, un admin qui n'a que « creation » fixerait le
    score qu'il veut a la creation, et pourrait meme contourner le droit sur un
    joueur existant en le supprimant pour le recreer. Le contournement par
    suppression suppose « irreversible » en plus, mais il resterait ouvert.
    """
    data = request.get_json()
    try:
        nom = data.get('nom')
        mu = float(data.get('mu', DEFAULT_MU))
        sigma = float(data.get('sigma', DEFAULT_SIGMA))
        color = data.get('color', '#FFFFFF')

        if not nom:
            return jsonify({"error": "Le nom du joueur est requis"}), 400

        # Seul un depart HORS defaut demande le droit : creer au score standard
        # ne contourne rien, c'est ce que fait le moteur pour tout nouveau venu.
        #
        # Tolerance stricte ici, contrairement a l'edition : on compare aux
        # constantes DEFAULT_MU/DEFAULT_SIGMA, qui tiennent en 3 decimales et que
        # le formulaire renvoie a l'identique. Rien a absorber, donc rien a
        # relacher -- et un seuil serre ferme mieux le contournement.
        if abs(mu - DEFAULT_MU) > 1e-9 or abs(sigma - DEFAULT_SIGMA) > 1e-9:
            accordee, erreur = compte_a_permission(g.compte, 'edition_mu_sigma')
            if erreur is not None:
                return erreur
            if not accordee:
                return jsonify({
                    "error": "Vous ne pouvez pas fixer le score de depart. "
                             "Creez la fiche au score par defaut.",
                    "code": "permission_manquante",
                    "permission": "edition_mu_sigma",
                }), 403

        # La couleur suit la meme regle que sur l'edition : la choisir a la
        # creation est le meme geste que la changer apres coup.
        if color != '#FFFFFF':
            accordee, erreur = compte_a_permission(g.compte, 'joueurs_couleur')
            if erreur is not None:
                return erreur
            if not accordee:
                return jsonify({
                    "error": "Vous ne pouvez pas choisir la couleur d'une fiche.",
                    "code": "permission_manquante",
                    "permission": "joueurs_couleur",
                }), 403

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM Joueurs WHERE nom = %s", (nom,))
                if cur.fetchone():
                    return jsonify({"error": "Ce nom de joueur existe déjà"}), 409

                cur.execute(
                    """INSERT INTO Joueurs (nom, mu, sigma, tier, is_ranked, consecutive_missed, color)
                       VALUES (%s, %s, %s, 'U', true, 0, %s) RETURNING id""",
                    (nom, mu, sigma, color)
                )
                joueur_id = cur.fetchone()[0]
                # `joueur_cree` EXISTE DEJA (routes_comptes.py, creation a
                # l'approbation d'une liaison) : on le reutilise. Une seconde
                # action homonyme tracant le meme geste par un autre chemin
                # serait indemelable une fois en base.
                audit.ecrire(cur, 'joueur_cree', 'joueur', joueur_id, {
                    "nom": nom, "mu": mu, "sigma": sigma, "color": color,
                    "origine": "formulaire",
                    # Un depart hors defaut est le geste qui exige
                    # `edition_mu_sigma` : le distinguer ici evite de relire
                    # les constantes pour comprendre la ligne.
                    "score_impose": abs(mu - DEFAULT_MU) > 1e-9 or abs(sigma - DEFAULT_SIGMA) > 1e-9,
                })
            conn.commit()

            recalculate_tiers()
            invalidate_cache()

        return jsonify({"status": "success", "message": "Joueur ajouté"}), 201
    except ValueError:
        return jsonify({"error": "Valeurs numériques invalides pour Mu ou Sigma"}), 400
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500



@admin_bp.route('/admin/types-awards', methods=['GET'])
@permission_required('gestion_saisons')
def get_admin_award_types():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT code, nom, emoji, description FROM types_awards WHERE code NOT LIKE %s AND code != 'grand_master' ORDER BY nom ASC", ('%moai',))
                awards = [{"code": r[0], "nom": r[1], "emoji": r[2], "description": r[3]} for r in cur.fetchall()]
        return jsonify(awards)
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500



@admin_bp.route('/admin/saisons', methods=['GET', 'POST'])
@permission_required('gestion_saisons')
def admin_saisons():
    if request.method == 'GET':
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, nom, date_debut, date_fin, slug, config_awards, is_active,
                           victory_condition, is_yearly, ligue_id, ligue_nom, ligue_couleur, is_league_recap,
                           include_league_stats, include_league_moves, ip_version
                    FROM saisons ORDER BY date_fin DESC, ligue_id ASC NULLS FIRST
                """)
                saisons = []
                for r in cur.fetchall():
                    saisons.append({
                        "id": r[0], "nom": r[1],
                        "date_debut": r[2].strftime("%d/%m/%Y"), "date_fin": r[3].strftime("%d/%m/%Y"),
                        "slug": r[4], "config": r[5] if r[5] else {}, "is_active": r[6],
                        "victory_condition": r[7], "is_yearly": r[8],
                        "ligue_id": r[9], "ligue_nom": r[10], "ligue_couleur": r[11],
                        "is_league_recap": r[12] if r[12] else False,
                        "include_league_stats": r[13] if r[13] else False,
                        "include_league_moves": r[14] if r[14] else False,
                        "ip_version": r[15] or IP_VERSION_DEFAULT
                    })
        return jsonify(saisons)

    if request.method == 'POST':
        data = request.get_json()
        nom, d_debut, d_fin = data.get('nom'), data.get('date_debut'), data.get('date_fin')
        victory_cond = data.get('victory_condition')
        is_yearly = bool(data.get('is_yearly', False))
        recap_mode = data.get('recap_mode', 'classic')
        include_league_stats = bool(data.get('include_league_stats', False))
        include_league_moves = bool(data.get('include_league_moves', False))
        config_json = json.dumps({"active_awards": data.get('active_awards', [])})

        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    if 'ip_version' in data:
                        ip_version = str(data.get('ip_version'))
                        if ip_version not in ('v1', 'v2'):
                            return jsonify({"error": "ip_version invalide"}), 400
                    else:
                        cur.execute("SELECT value FROM Configuration WHERE key = 'ip_version_live'")
                        live_row = cur.fetchone()
                        ip_version = live_row[0] if live_row else IP_VERSION_DEFAULT

                    if recap_mode == 'league':
                        cur.execute("SELECT id, nom, couleur FROM Ligues ORDER BY niveau ASC")
                        ligues = cur.fetchall()

                        if not ligues:
                            return jsonify({"error": "Aucune ligue configurée. Créez d'abord des ligues."}), 400

                        cur.execute("""
                            SELECT COUNT(*) FROM Tournois
                            WHERE date >= %s AND date <= %s AND ligue_id IS NOT NULL
                        """, (d_debut, d_fin))
                        league_count = cur.fetchone()[0]

                        if league_count == 0:
                            return jsonify({"error": "Aucun tournoi en mode ligue pendant cette période."}), 400

                        slug = generate_unique_slug(cur, nom)

                        cur.execute(
                            """INSERT INTO saisons (nom, slug, date_debut, date_fin, config_awards, is_active,
                               victory_condition, is_yearly, is_league_recap, ip_version)
                               VALUES (%s, %s, %s, %s, %s, false, %s, %s, true, %s) RETURNING id""",
                            (nom, slug, d_debut, d_fin, config_json, victory_cond, is_yearly, ip_version)
                        )
                        saison_id = cur.fetchone()[0]

                        # `recap_cree` et non `saison_creee` : le brouillon EST
                        # le recap, et c'est sous ce nom que l'ecran le designe.
                        # Suit la convention <objet>_<participe> du §5.2bis.
                        audit.ecrire(cur, 'recap_cree', 'saison', saison_id, {
                            "nom": nom, "slug": slug,
                            "type": "ligue_unifie",
                            "periode": "%s -> %s" % (d_debut, d_fin),
                            # Un brouillon ne publie rien : le distinguer evite
                            # de lire la ligne comme une publication.
                            "brouillon": True,
                        })
                        conn.commit()
                        return jsonify({
                            "status": "success",
                            "message": "Récap de ligue unifié créé en brouillon."
                        })
                    else:
                        slug = generate_unique_slug(cur, nom)

                        cur.execute(
                            """INSERT INTO saisons (nom, slug, date_debut, date_fin, config_awards, is_active,
                               victory_condition, is_yearly, include_league_stats, include_league_moves, ip_version)
                               VALUES (%s, %s, %s, %s, %s, false, %s, %s, %s, %s, %s) RETURNING id""",
                            (nom, slug, d_debut, d_fin, config_json, victory_cond, is_yearly,
                             include_league_stats, include_league_moves, ip_version)
                        )
                        saison_id = cur.fetchone()[0]
                        audit.ecrire(cur, 'recap_cree', 'saison', saison_id, {
                            "nom": nom, "slug": slug,
                            "type": "standard",
                            "periode": "%s -> %s" % (d_debut, d_fin),
                            "brouillon": True,
                        })
                        conn.commit()
                        return jsonify({"status": "success"})
        except Exception as e:
            logger.error(f"Erreur requête: {e}")
            return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/saisons/<int:saison_id>', methods=['DELETE'])
@permission_required('gestion_saisons')
def delete_saison(saison_id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT is_league_recap, include_league_moves FROM saisons WHERE id = %s", (saison_id,))
                row = cur.fetchone()
                if not row:
                    return jsonify({"error": "Saison introuvable"}), 404

                is_league_recap, include_league_moves = row
                rollback_warnings = []

                if is_league_recap or include_league_moves:
                    cur.execute("""
                        SELECT joueur_id, from_ligue_id, from_ligue_nom, created_at
                        FROM league_movements
                        WHERE saison_id = %s
                    """, (saison_id,))
                    movements = cur.fetchall()

                    for joueur_id, from_ligue_id, from_ligue_nom, created_at in movements:
                        cur.execute("""
                            SELECT 1 FROM league_movements
                            WHERE joueur_id = %s AND created_at > %s AND saison_id != %s
                            LIMIT 1
                        """, (joueur_id, created_at, saison_id))
                        has_later_move = cur.fetchone()

                        if has_later_move:
                            rollback_warnings.append(f"{joueur_id}: mouvement postérieur, non restauré")
                            continue

                        if from_ligue_id is None:
                            rollback_warnings.append(f"{from_ligue_nom}: ligue supprimée, impossible de restaurer")
                            continue

                        cur.execute("SELECT id FROM ligues WHERE id = %s", (from_ligue_id,))
                        if not cur.fetchone():
                            rollback_warnings.append(f"{from_ligue_nom}: ligue supprimée, impossible de restaurer")
                            continue

                        cur.execute("UPDATE joueurs SET ligue_id = %s WHERE id = %s", (from_ligue_id, joueur_id))

                cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s", (saison_id,))
                cur.execute("DELETE FROM saisons WHERE id = %s", (saison_id,))
            conn.commit()
            invalidate_cache()

        response = {"status": "success"}
        if rollback_warnings:
            response["warnings"] = rollback_warnings
        return jsonify(response)
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


@admin_bp.route('/admin/count-tournois-range', methods=['GET'])
@permission_required('gestion_saisons')
def count_tournois_by_range():
    d_debut = request.args.get('date_debut')
    d_fin = request.args.get('date_fin')
    if not d_debut or not d_fin:
        return jsonify({'error': 'Dates requises'}), 400

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) FROM Tournois
                WHERE date >= %s AND date <= %s AND ligue_id IS NOT NULL
            """, (d_debut, d_fin))
            league_count = cur.fetchone()[0]

            cur.execute("""
                SELECT COUNT(*) FROM Tournois
                WHERE date >= %s AND date <= %s AND ligue_id IS NULL
            """, (d_debut, d_fin))
            classic_count = cur.fetchone()[0]

    return jsonify({
        'league_count': league_count,
        'classic_count': classic_count
    })


@admin_bp.route('/admin/saisons/<int:id>/count-tournois', methods=['GET'])
@permission_required('gestion_saisons')
def count_tournois_by_mode(id):
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT date_debut, date_fin FROM saisons WHERE id = %s", (id,))
            row = cur.fetchone()
            if not row:
                return jsonify({'error': 'Saison introuvable'}), 404

            d_debut, d_fin = row

            cur.execute("""
                SELECT COUNT(*) FROM Tournois
                WHERE date >= %s AND date <= %s AND ligue_id IS NOT NULL
            """, (d_debut, d_fin))
            league_count = cur.fetchone()[0]

            cur.execute("""
                SELECT COUNT(*) FROM Tournois
                WHERE date >= %s AND date <= %s AND ligue_id IS NULL
            """, (d_debut, d_fin))
            classic_count = cur.fetchone()[0]

    return jsonify({
        'league_count': league_count,
        'classic_count': classic_count
    })


@admin_bp.route('/admin/saisons/<int:id>/save-awards', methods=['POST'])
@permission_required('gestion_saisons')
def save_season_awards(id):
    data = request.get_json() or {}
    move_criterion = data.get('move_criterion')

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT date_debut, date_fin, config_awards, victory_condition, is_yearly, ligue_id, is_league_recap,
                       include_league_stats, include_league_moves, ip_version
                FROM saisons WHERE id = %s
            """, (id,))
            row = cur.fetchone()
            if not row: return jsonify({'error': 'Saison introuvable'}), 404

            d_debut, d_fin, config, vic_cond, is_yearly, saison_ligue_id, is_league_recap, include_league_stats, include_league_moves, ip_version = row
            active_awards = config.get('active_awards', [])
            movements = []

            if is_league_recap:
                cur.execute("""
                    SELECT DISTINCT l.id, l.nom, l.niveau, l.couleur
                    FROM Ligues l
                    JOIN Tournois t ON t.ligue_id = l.id
                    WHERE t.date >= %s AND t.date <= %s
                    ORDER BY l.niveau ASC
                """, (d_debut, d_fin))
                ligues_rows = cur.fetchall()
                ligues = [(r[0], r[1], r[3]) for r in ligues_rows]

                if not ligues:
                    return jsonify({'error': 'Aucun tournoi de ligue pendant cette période'}), 400

                all_rankings = {}

                cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s", (id,))
                conn.commit()

                for ligue_id, ligue_nom, ligue_couleur in ligues:
                    ligue_stats = _aggregate_season_stats(d_debut, d_fin, 'league', ligue_id, ip_version)

                    gm_list = ligue_stats['candidates'].get('grand_master', [])
                    gm_sorted = sorted(gm_list, key=lambda x: x.get('final_score', 0), reverse=True)
                    all_rankings[ligue_id] = {p['id']: rank for rank, p in enumerate(gm_sorted, 1)}

                    top_3, winners_map = _determine_winners(
                        ligue_stats['candidates'], vic_cond, active_awards, ligue_stats['total_tournois']
                    )
                    ligue_info = {'id': ligue_id, 'nom': ligue_nom, 'couleur': ligue_couleur}
                    _save_awards_to_db(conn, id, top_3, winners_map, is_yearly, ligue_info=ligue_info)

                if move_criterion:
                    cur.execute("SELECT value FROM Configuration WHERE key = 'league_mode_enabled'")
                    league_row = cur.fetchone()
                    league_enabled = (league_row[0] == 'true') if league_row else False

                    cur.execute("SELECT value FROM Configuration WHERE key = 'inter_league_moves'")
                    moves_row = cur.fetchone()
                    moves_count = int(moves_row[0]) if moves_row else 0

                    if league_enabled and moves_count > 0:
                        if move_criterion == "ip":
                            movements = _apply_inter_league_moves(conn, moves_count, {}, rankings_by_ligue=all_rankings)
                        else:
                            cur.execute("SELECT id, score_trueskill FROM Joueurs WHERE ligue_id IS NOT NULL ORDER BY score_trueskill DESC")
                            ranking_data = {r[0]: rank for rank, r in enumerate(cur.fetchall(), 1)}
                            movements = _apply_inter_league_moves(conn, moves_count, ranking_data)

                        for m in movements:
                            cur.execute("SELECT id FROM Ligues WHERE nom = %s", (m['from'],))
                            from_row = cur.fetchone()
                            from_ligue_id = from_row[0] if from_row else None

                            cur.execute("SELECT id FROM Ligues WHERE nom = %s", (m['to'],))
                            to_row = cur.fetchone()
                            to_ligue_id = to_row[0] if to_row else None

                            cur.execute("""
                                INSERT INTO league_movements (saison_id, joueur_id, from_ligue_id, to_ligue_id,
                                    from_ligue_nom, to_ligue_nom, direction)
                                VALUES (%s, %s, %s, %s, %s, %s, %s)
                            """, (id, m['joueur_id'], from_ligue_id, to_ligue_id, m['from'], m['to'], m['direction']))

                cur.execute("UPDATE saisons SET is_active = true WHERE id = %s", (id,))
                _notifier_recap_publie(cur, id)

            elif saison_ligue_id:
                cur.execute("""
                    SELECT COUNT(*) FROM Tournois
                    WHERE date >= %s AND date <= %s AND ligue_id = %s
                """, (d_debut, d_fin, saison_ligue_id))
                count = cur.fetchone()[0]
                if count == 0:
                    return jsonify({'error': 'Aucun tournoi pour cette ligue pendant cette période'}), 400
                global_stats = _aggregate_season_stats(d_debut, d_fin, 'league', saison_ligue_id, ip_version)

                top_3, winners_map = _determine_winners(
                    global_stats['candidates'], vic_cond, active_awards, global_stats['total_tournois']
                )
                _save_awards_to_db(conn, id, top_3, winners_map, is_yearly)

                if move_criterion:
                    cur.execute("SELECT value FROM Configuration WHERE key = 'league_mode_enabled'")
                    league_row = cur.fetchone()
                    league_enabled = (league_row[0] == 'true') if league_row else False

                    cur.execute("SELECT value FROM Configuration WHERE key = 'inter_league_moves'")
                    moves_row = cur.fetchone()
                    moves_count = int(moves_row[0]) if moves_row else 0

                    if league_enabled and moves_count > 0:
                        if move_criterion == "ip":
                            gm_list = global_stats['candidates'].get('grand_master', [])
                            gm_sorted = sorted(gm_list, key=lambda x: x.get('final_score', 0), reverse=True)
                            ranking_data = {p['id']: rank for rank, p in enumerate(gm_sorted, 1)}
                        else:
                            cur.execute("SELECT id, score_trueskill FROM Joueurs WHERE ligue_id IS NOT NULL ORDER BY score_trueskill DESC")
                            ranking_data = {r[0]: rank for rank, r in enumerate(cur.fetchall(), 1)}
                        movements = _apply_inter_league_moves(conn, moves_count, ranking_data)
            else:
                cur.execute("""
                    SELECT COUNT(*) FROM Tournois
                    WHERE date >= %s AND date <= %s AND ligue_id IS NULL
                """, (d_debut, d_fin))
                count = cur.fetchone()[0]
                if count == 0:
                    return jsonify({'error': 'Aucun tournoi en mode classique pendant cette période'}), 400
                global_stats = _aggregate_season_stats(d_debut, d_fin, 'classic', None, ip_version)

                top_3, winners_map = _determine_winners(
                    global_stats['candidates'], vic_cond, active_awards, global_stats['total_tournois']
                )
                _save_awards_to_db(conn, id, top_3, winners_map, is_yearly)

                if include_league_stats or include_league_moves:
                    cur.execute("""
                        SELECT DISTINCT l.id, l.nom, l.niveau, l.couleur
                        FROM Ligues l
                        JOIN Tournois t ON t.ligue_id = l.id
                        WHERE t.date >= %s AND t.date <= %s
                        ORDER BY l.niveau ASC
                    """, (d_debut, d_fin))
                    ligues_rows = cur.fetchall()
                    ligues = [(r[0], r[1], r[3]) for r in ligues_rows]

                    if ligues:
                        all_rankings = {}
                        for ligue_id, ligue_nom, ligue_couleur in ligues:
                            ligue_stats = _aggregate_season_stats(d_debut, d_fin, 'league', ligue_id, ip_version)
                            gm_list = ligue_stats['candidates'].get('grand_master', [])
                            gm_sorted = sorted(gm_list, key=lambda x: x.get('final_score', 0), reverse=True)
                            all_rankings[ligue_id] = {p['id']: rank for rank, p in enumerate(gm_sorted, 1)}

                        if include_league_moves and move_criterion:
                            cur.execute("SELECT value FROM Configuration WHERE key = 'league_mode_enabled'")
                            league_row = cur.fetchone()
                            league_enabled = (league_row[0] == 'true') if league_row else False

                            cur.execute("SELECT value FROM Configuration WHERE key = 'inter_league_moves'")
                            moves_row = cur.fetchone()
                            moves_count = int(moves_row[0]) if moves_row else 0

                            if league_enabled and moves_count > 0:
                                if move_criterion == "ip":
                                    movements = _apply_inter_league_moves(conn, moves_count, {}, rankings_by_ligue=all_rankings)
                                else:
                                    cur.execute("SELECT id, score_trueskill FROM Joueurs WHERE ligue_id IS NOT NULL ORDER BY score_trueskill DESC")
                                    ranking_data = {r[0]: rank for rank, r in enumerate(cur.fetchall(), 1)}
                                    movements = _apply_inter_league_moves(conn, moves_count, ranking_data)

                                for m in movements:
                                    cur.execute("SELECT id FROM Ligues WHERE nom = %s", (m['from'],))
                                    from_row = cur.fetchone()
                                    from_ligue_id = from_row[0] if from_row else None

                                    cur.execute("SELECT id FROM Ligues WHERE nom = %s", (m['to'],))
                                    to_row = cur.fetchone()
                                    to_ligue_id = to_row[0] if to_row else None

                                    cur.execute("""
                                        INSERT INTO league_movements (saison_id, joueur_id, from_ligue_id, to_ligue_id,
                                            from_ligue_nom, to_ligue_nom, direction)
                                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                                    """, (id, m['joueur_id'], from_ligue_id, to_ligue_id, m['from'], m['to'], m['direction']))

                cur.execute("UPDATE saisons SET is_active = true WHERE id = %s", (id,))
                _notifier_recap_publie(cur, id)

        conn.commit()
        invalidate_cache()

    response = {'status': 'success', 'message': 'Saison publiée et awards distribués !'}
    if movements:
        response['movements'] = movements
        response['message'] += f' {len(movements)} mouvements inter-ligue effectués.'

    return jsonify(response)



@admin_bp.route('/add-tournament', methods=['POST'])
@permission_required('gestion_tournois')
def add_tournament():
    data = request.get_json()
    date_tournoi_str = data.get('date')
    joueurs_data = data.get('joueurs')
    ligue_id = data.get('ligue_id')
    # Tournoi auquel rattacher celui-ci (deux lobbies d'une meme soiree).
    # None = ce tournoi reste seul dans sa session, cas par defaut.
    autre_tournoi_id = data.get('autre_tournoi_id')

    if not date_tournoi_str or not joueurs_data:
        return jsonify({"error": "Données incomplètes"}), 400

    if autre_tournoi_id is not None:
        try:
            autre_tournoi_id = int(autre_tournoi_id)
        except (TypeError, ValueError):
            return jsonify({"error": "Tournoi à lier invalide."}), 400

    try:
        date_tournoi = datetime.strptime(date_tournoi_str, '%Y-%m-%d').date()
        if date_tournoi > datetime.now().date():
            return jsonify({"error": "Impossible d'ajouter un tournoi dans le futur."}), 400

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM global_resets WHERE date >= %s", (date_tournoi,))
                conflict = cur.fetchone()[0]
                if conflict > 0:
                    return jsonify({"error": "Conflit avec un Reset Global."}), 409

                cur.execute("SELECT value FROM Configuration WHERE key = 'league_mode_enabled'")
                res = cur.fetchone()
                is_league_mode = (res[0] == 'true') if res else False

                is_mixte = (str(ligue_id).lower() == 'mixte') if ligue_id else False

                if is_league_mode and not ligue_id:
                    return jsonify({"error": "Le mode Ligue est activé, veuillez sélectionner une ligue."}), 400

                ligue_nom_archive = None
                ligue_couleur_archive = None

                if is_mixte:
                    ligue_id = None
                    ligue_nom_archive = 'Mixte'
                    ligue_couleur_archive = '#888888'
                elif ligue_id:
                    cur.execute("SELECT nom, couleur FROM Ligues WHERE id = %s", (ligue_id,))
                    res_ligue = cur.fetchone()
                    if res_ligue:
                        ligue_nom_archive = res_ligue[0]
                        ligue_couleur_archive = res_ligue[1]

                # Reference IP v2 : on fige la grille avant que le tournoi ne fasse bouger le
                # moindre mu. Sans effet si un tournoi du meme jour l'a deja figee.
                snapshot_grille(cur, date_tournoi)

                # Toute creation de tournoi ouvre sa propre session : un tournoi
                # non lie est seul dans la sienne, ce n'est pas un cas
                # particulier. C'est ce qui garantit l'invariant session_id NOT
                # NULL, et donc l'absence de branche « tournoi sans session »
                # dans tout le code de calcul.
                # Conception : docs/plan-sessions-tournois.md
                cur.execute("INSERT INTO sessions_tournois DEFAULT VALUES RETURNING id")
                session_id = cur.fetchone()[0]

                cur.execute("""
                    INSERT INTO Tournois (date, ligue_id, ligue_nom, ligue_couleur, session_id)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING id
                """, (date_tournoi_str, ligue_id, ligue_nom_archive, ligue_couleur_archive,
                      session_id))
                tournoi_id = cur.fetchone()[0]

                joueurs_ratings = {}
                joueurs_ids_map = {}
                joueurs_exclude_ts = {}

                for joueur in joueurs_data:
                    nom, score = joueur['nom'], joueur['score']
                    exclude_ts = joueur.get('exclude_from_ts', False)
                    cur.execute("SELECT id, mu, sigma FROM Joueurs WHERE nom = %s", (nom,))
                    res = cur.fetchone()
                    if res:
                        jid, mu, sigma = res
                    else:
                        # Nom inconnu : creation a la volee, sauf identite anonymisee -- la recreer
                        # ferait reapparaitre ce qu'on venait d'effacer, sur un doublon.
                        cur.execute(
                            "SELECT 1 FROM noms_interdits WHERE nom_hash = %s",
                            (hashlib.sha256(nom.strip().lower().encode('utf-8')).hexdigest(),),
                        )
                        if cur.fetchone() is not None:
                            conn.rollback()
                            return jsonify({
                                "error": "Le nom « %s » correspond a un joueur anonymise et ne "
                                         "peut pas etre recree. Choisissez un autre nom." % nom,
                                "code": "nom_interdit",
                            }), 409
                        # Creer une fiche releve de gestion_joueurs, pas de
                        # gestion_tournois. Sans ce garde-fou la scission des
                        # deux permissions (2026-09-13) serait contournable en
                        # tapant simplement un nom absent dans le formulaire de
                        # tournoi -- le chemin normal de cette route, pas un cas
                        # limite.
                        accordee, erreur = compte_a_permission(g.compte, 'gestion_joueurs')
                        if erreur is not None:
                            conn.rollback()
                            return erreur
                        if not accordee:
                            conn.rollback()
                            return jsonify({
                                "error": "Le joueur « %s » n'existe pas. Sa creation releve de la "
                                         "permission « Fiches joueurs » : demandez sa creation "
                                         "prealable, ou verifiez l'orthographe." % nom,
                                "code": "joueur_inconnu",
                            }), 409
                        cur.execute("INSERT INTO Joueurs (nom, mu, sigma, tier, is_ranked) VALUES (%s, %s, %s, 'U', true) RETURNING id", (nom, DEFAULT_MU, DEFAULT_SIGMA))
                        jid, mu, sigma = cur.fetchone()[0], DEFAULT_MU, DEFAULT_SIGMA
                    joueurs_ratings[nom] = trueskill.Rating(mu=float(mu), sigma=float(sigma))
                    joueurs_ids_map[nom] = jid
                    joueurs_exclude_ts[nom] = exclude_ts
                    cur.execute("INSERT INTO Participations (tournoi_id, joueur_id, score, old_mu, old_sigma, exclude_from_ts) VALUES (%s, %s, %s, %s, %s, %s)", (tournoi_id, jid, score, float(mu), float(sigma), exclude_ts))

                # ── RATTACHEMENT A UNE SESSION EXISTANTE ────────────────────
                # L'admin a demande, AVANT validation, de lier ce tournoi a un
                # autre : deux lobbies d'une meme soiree.
                #
                # ORDRE DES TROIS GESTES, a ne pas modifier :
                #   1. les participations sont inserees (fait juste au-dessus),
                #      donc les noms saisis sont resolus en joueur_id -- on
                #      compare des identifiants, jamais des chaines ;
                #   2. on CONTROLE le conflit, alors que ce tournoi est encore
                #      seul dans sa session : l'ensemble teste est donc
                #      exactement « les autres tournois de la session cible » ;
                #   3. on fusionne seulement si le controle passe.
                #
                # Inverser 2 et 3 rendrait le controle auto-referent (les
                # joueurs de ce tournoi seraient deja dans la session cible) et
                # ferait refuser TOUTE liaison.
                #
                # Le controle est refait ici meme si le client l'a deja fait via
                # /admin/tournois/verifier-session : cette route est indicative,
                # celle-ci est autoritaire. Sans cette reverification, deux
                # admins simultanes -- ou un appel direct a l'API -- passeraient
                # au travers (TOCTOU).
                # Conception : docs/plan-sessions-tournois.md, decisions 9 et 10
                if autre_tournoi_id is not None:
                    cur.execute("SELECT 1 FROM Tournois WHERE id = %s", (autre_tournoi_id,))
                    if cur.fetchone() is None:
                        conn.rollback()
                        return jsonify({
                            "error": "Le tournoi auquel lier celui-ci n'existe pas.",
                            "code": "tournoi_cible_absent",
                        }), 404

                    conflits = joueurs_en_conflit_de_session(cur, tournoi_id, autre_tournoi_id)
                    if conflits:
                        # Refus categorique : ni liaison, ni creation. Le
                        # rollback annule le tournoi, ses participations, les
                        # fiches joueurs creees a la volee et la grille figee --
                        # l'etat d'avant est integralement restaure.
                        conn.rollback()
                        return jsonify({
                            "error": "Ces joueurs participent deja a un autre tournoi de cette "
                                     "session : %s. Un joueur ne peut jouer qu'un seul tournoi "
                                     "par session." % ", ".join(conflits),
                            "code": "conflit_session",
                            "joueurs_en_conflit": conflits,
                        }), 409

                    session_id = fusionner_sessions(cur, tournoi_id, autre_tournoi_id)

                sorted_joueurs = sorted(joueurs_data, key=lambda x: x['score'], reverse=True)

                ts_joueurs = [j for j in sorted_joueurs if not joueurs_exclude_ts.get(j['nom'], False)]
                ts_ranks = []
                last_s, rank = -1, 1
                for i, j in enumerate(ts_joueurs):
                    if j['score'] < last_s: rank = i + 1
                    ts_ranks.append(rank)
                    last_s = j['score']

                cur.execute("SELECT value FROM Configuration WHERE key = 'tau'")
                tau_val = float(cur.fetchone()[0])
                ts_env = trueskill.TrueSkill(mu=DEFAULT_MU, sigma=DEFAULT_SIGMA, beta=TRUESKILL_BETA, tau=tau_val, draw_probability=TRUESKILL_DRAW_PROBABILITY)

                new_ratings_map = {}
                if ts_joueurs:
                    new_ratings = ts_env.rate([[joueurs_ratings[j['nom']]] for j in ts_joueurs], ranks=ts_ranks)
                    for i, j in enumerate(ts_joueurs):
                        new_ratings_map[j['nom']] = new_ratings[i][0]

                present_pids = []
                all_ranks = []
                last_s, rank = -1, 1
                for i, j in enumerate(sorted_joueurs):
                    if j['score'] < last_s: rank = i + 1
                    all_ranks.append(rank)
                    last_s = j['score']

                joueur_updates = []
                participation_updates = []

                for i, j in enumerate(sorted_joueurs):
                    nom = j['nom']
                    jid = joueurs_ids_map[nom]
                    present_pids.append(jid)

                    if joueurs_exclude_ts.get(nom, False):
                        old_rating = joueurs_ratings[nom]
                        joueur_updates.append((jid, old_rating.mu, old_rating.sigma, 0, True))
                        participation_updates.append((tournoi_id, jid, old_rating.mu, old_rating.sigma, old_rating.mu - 3 * old_rating.sigma, all_ranks[i]))
                    else:
                        nr = new_ratings_map[nom]
                        joueur_updates.append((jid, nr.mu, nr.sigma, 0, True))
                        participation_updates.append((tournoi_id, jid, nr.mu, nr.sigma, nr.mu - 3 * nr.sigma, all_ranks[i]))

                if joueur_updates:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET mu = data.mu, sigma = data.sigma, consecutive_missed = data.missed, is_ranked = data.ranked
                        FROM (VALUES %s) AS data(id, mu, sigma, missed, ranked)
                        WHERE j.id = data.id
                    """, joueur_updates)

                if participation_updates:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Participations AS p SET mu = data.mu, sigma = data.sigma, new_score_trueskill = data.ts, position = data.pos
                        FROM (VALUES %s) AS data(tid, jid, mu, sigma, ts, pos)
                        WHERE p.tournoi_id = data.tid AND p.joueur_id = data.jid
                    """, participation_updates)

                cur.execute("SELECT key, value FROM Configuration WHERE key IN ('ghost_enabled', 'ghost_penalty', 'ghost_threshold_sessions', 'ghost_interval_sessions', 'unranked_threshold')")
                conf = dict(cur.fetchall())
                ghost_enabled = (conf.get('ghost_enabled') == 'true')
                penalty_val = float(conf.get('ghost_penalty', DEFAULT_GHOST_PENALTY))
                # Seuils en SESSIONS LOUPEES, plus en jours (decision 8).
                seuil_sessions = max(1, int(conf.get('ghost_threshold_sessions',
                                                     DEFAULT_GHOST_THRESHOLD_SESSIONS)))
                intervalle_sessions = max(1, int(conf.get('ghost_interval_sessions',
                                                          DEFAULT_GHOST_INTERVAL_SESSIONS)))
                unranked_limit = int(conf.get('unranked_threshold', DEFAULT_UNRANKED_THRESHOLD))

                not_in_clause = f"id NOT IN ({','.join(['%s']*len(present_pids))})" if present_pids else "TRUE"
                abs_params = list(present_pids)
                query_absents = f"SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs WHERE {not_in_clause}"

                cur.execute(query_absents, tuple(abs_params))
                all_absents = cur.fetchall()

                # La ligue de la derniere apparition determine qui est concerne
                # par ce tournoi quand le mode ligue est actif. Les dates de
                # derniere apparition et de derniere penalite ne sont PLUS lues :
                # le declenchement se base desormais sur consecutive_missed, un
                # compteur de sessions loupees, et non sur un ecart calendaire.
                all_absent_ids = [row[0] for row in all_absents]
                last_played_ligue = {}
                if all_absent_ids and ligue_id is not None:
                    cur.execute("""
                        SELECT DISTINCT ON (p.joueur_id) p.joueur_id, t.ligue_id
                        FROM Participations p
                        JOIN Tournois t ON p.tournoi_id = t.id
                        WHERE p.joueur_id = ANY(%s) AND t.id <> %s AND t.date <= %s
                        ORDER BY p.joueur_id, t.date DESC, t.id DESC
                    """, (all_absent_ids, tournoi_id, date_tournoi))
                    last_played_ligue = {jid: lid for jid, lid in cur.fetchall()}

                absents = [
                    row for row in all_absents
                    if ligue_id is None or last_played_ligue.get(row[0]) == int(ligue_id)
                ]
                absent_ids = [row[0] for row in absents]

                # Presents de la SESSION, et non plus « du meme jour ».
                #
                # Jouer un seul tournoi de la session suffit a compter present
                # pour toute la session : ces joueurs ne prennent donc pas
                # d'absence, meme s'ils manquent ce tournoi-ci.
                #
                # Remplace le couple present_today_ids/same_day_exists, qui
                # reconstituait ce regroupement par comparaison de dates. Un
                # ensemble vide produit exactement le meme resultat que
                # l'ancien « same_day_exists = False » : tous les absents sont
                # comptes. La branche conditionnelle n'a donc plus de raison
                # d'etre.
                # Conception : docs/plan-sessions-tournois.md, 5.1
                deja_presents = set()
                if absent_ids:
                    cur.execute("""
                        SELECT DISTINCT p.joueur_id
                        FROM Participations p
                        JOIN Tournois t ON p.tournoi_id = t.id
                        WHERE t.session_id = %s AND t.id <> %s
                          AND (t.ligue_id = %s OR (%s IS NULL AND t.ligue_id IS NULL))
                    """, (session_id, tournoi_id, ligue_id, ligue_id))
                    deja_presents = {r[0] for r in cur.fetchall()}

                ghost_inserts = []
                absent_updates = []
                for pid, sig, missed, is_r in absents:
                    # Present ailleurs dans la session : ne prend pas d'absence.
                    present_dans_session = pid in deja_presents
                    new_missed = (missed or 0) if present_dans_session else (missed or 0) + 1
                    new_sig = float(sig)

                    # Le compteur de sessions loupees decide seul du
                    # declenchement : plus de lecture de dates ni de ghost_log.
                    # ghost_log reste le journal des penalites (tracabilite et
                    # restauration a l'annulation), mais n'est plus consulte
                    # pour DECIDER.
                    if (ghost_enabled and not present_dans_session and new_sig < GHOST_SIGMA_CAP
                            and penalite_due(new_missed, seuil_sessions, intervalle_sessions)):
                        capped_sig = min(new_sig + penalty_val, GHOST_SIGMA_CAP)
                        applied = round(capped_sig - new_sig, 6)
                        if applied > 0:
                            ghost_inserts.append((pid, tournoi_id, date_tournoi_str, new_sig, capped_sig, applied))
                            new_sig = capped_sig

                    new_is_ranked = is_r
                    if new_missed >= unranked_limit: new_is_ranked = False
                    absent_updates.append((pid, new_sig, new_missed, new_is_ranked))

                if ghost_inserts:
                    psycopg2.extras.execute_values(cur, """
                        INSERT INTO ghost_log (joueur_id, tournoi_id, date, old_sigma, new_sigma, penalty_applied)
                        VALUES %s
                    """, ghost_inserts)
                if absent_updates:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET sigma = data.sigma, consecutive_missed = data.missed, is_ranked = data.ranked
                        FROM (VALUES %s) AS data(id, sigma, missed, ranked)
                        WHERE j.id = data.id
                    """, absent_updates)

                notifier_tous(
                    cur, 'tournoi_ajoute',
                    "Nouveau tournoi du %s" % date_tournoi.strftime('%d/%m/%Y'),
                    "%d joueurs y ont participé. Classement et TrueSkill sont à jour."
                    % len(joueurs_data),
                    lien="/stats/tournoi/%d" % tournoi_id,
                )

                # En RESUME : le detail des scores vit deja dans
                # `participations`, qui ne bouge plus une fois le tournoi
                # enregistre. Le dupliquer ferait grossir le journal sans rien
                # apprendre de plus.
                audit.ecrire(cur, 'tournoi_ajoute', 'tournoi', tournoi_id, {
                    "date": str(date_tournoi),
                    "nb_joueurs": len(joueurs_data),
                    "session_id": session_id,
                })

            conn.commit()
            recalculate_tiers()
            invalidate_cache()

            return jsonify({
                "status": "success",
                "tournoi_id": tournoi_id,
                "session_id": session_id,
            }), 201
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


# Etape 1 du rattachement a une session : quels tournois recents peut-on
# proposer, et lesquels sont interdits parce qu'ils partagent un joueur ?
#
# LECTURE SEULE, et strictement indicative. Elle ne cree rien -- en particulier
# aucune fiche joueur, alors que add_tournament en cree a la volee : un admin qui
# ouvre la modale puis renonce ne doit rien laisser derriere lui. La consequence
# est qu'elle compare sur les NOMS (les joueurs saisis n'ont pas encore d'id),
# la ou add_tournament compare sur les joueur_id.
#
# C'est add_tournament qui tranche. Cette route sert a griser les mauvais choix
# dans l'interface, pas a autoriser quoi que ce soit.
# Conception : docs/plan-sessions-tournois.md, decision 10
@admin_bp.route('/admin/tournois/verifier-session', methods=['POST'])
@permission_required('gestion_tournois')
def verifier_session_tournoi():
    data = request.get_json() or {}
    noms = [j.get('nom') for j in (data.get('joueurs') or []) if j.get('nom')]
    try:
        limite = int(data.get('limite', SESSION_CANDIDATS_PAR_DEFAUT))
    except (TypeError, ValueError):
        limite = SESSION_CANDIDATS_PAR_DEFAUT
    limite = max(1, min(limite, SESSION_CANDIDATS_MAX))

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT t.id, t.date, t.session_id,
                           COALESCE(t.ligue_nom, '') AS ligue,
                           count(p.joueur_id) AS nb_joueurs
                    FROM Tournois t
                    LEFT JOIN Participations p ON p.tournoi_id = t.id
                    GROUP BY t.id, t.date, t.session_id, t.ligue_nom
                    ORDER BY t.date DESC, t.id DESC
                    LIMIT %s
                """, (limite,))
                candidats = cur.fetchall()

                # Les joueurs deja engages dans chaque session, pour les noms
                # saisis. Une seule requete pour tous les candidats : la modale
                # doit s'ouvrir vite, et le nombre de candidats est borne.
                #
                # Comparaison de noms normalisee (minuscules, espaces retires)
                # comme le fait add_tournament pour les noms interdits : sans
                # cela, « toto » et « Toto » seraient vus comme deux joueurs et
                # un conflit resterait invisible dans l'interface.
                engages = {}
                if noms:
                    cur.execute("""
                        SELECT t.session_id, j.nom
                        FROM Participations p
                        JOIN Tournois t ON t.id = p.tournoi_id
                        JOIN Joueurs j  ON j.id = p.joueur_id
                        WHERE lower(btrim(j.nom)) = ANY(%s)
                    """, ([n.strip().lower() for n in noms],))
                    for sid, nom in cur.fetchall():
                        engages.setdefault(sid, set()).add(nom)

        resultat = []
        for tid, tdate, sid, ligue, nb in candidats:
            conflits = sorted(engages.get(sid, ()))
            resultat.append({
                "id": tid,
                "date": tdate.strftime('%d/%m/%Y'),
                "ligue": ligue,
                "nb_joueurs": nb,
                "liable": not conflits,
                "joueurs_en_conflit": conflits[:MAX_CONFLITS_NOMMES],
            })
        return jsonify({"candidats": resultat})
    except Exception as e:
        logger.error(f"Erreur verifier_session_tournoi: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


# Liaison TARDIVE : rattacher deux tournois deja enregistres. Le chemin normal
# est la liaison au moment de la creation (add_tournament) ; celui-ci sert quand
# l'admin a passe l'etape puis change d'avis.
#
# Contrairement a la creation, les deux sessions sont ici deja peuplees : le
# controle de conflit doit comparer les deux ensembles en entier, d'ou
# joueurs_en_conflit_entre_sessions et non sa variante par tournoi.
#
# ⚠️ Ne corrige PAS les penalites d'absence deja calculees sur ces tournois.
# Tant que la Phase 3 n'a pas basculé le calcul sur session_id, la penalite
# ignore les sessions : il n'y a donc rien a corriger. Des que la Phase 3 est
# livree, cette route devra defaire les penalites devenues injustifiees
# (plan 5.2) -- sans quoi lier deux tournois laissera des absences a tort.
@admin_bp.route('/admin/tournois/<int:tournoi_id>/lier-session', methods=['POST'])
@permission_required('gestion_tournois')
def lier_session_tournoi(tournoi_id):
    data = request.get_json() or {}
    try:
        autre_tournoi_id = int(data.get('autre_tournoi_id'))
    except (TypeError, ValueError):
        return jsonify({"error": "Tournoi à lier invalide."}), 400

    if autre_tournoi_id == tournoi_id:
        return jsonify({"error": "Un tournoi ne peut pas être lié à lui-même."}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, session_id FROM Tournois WHERE id IN (%s, %s)",
                    (tournoi_id, autre_tournoi_id))
                sessions = {tid: sid for tid, sid in cur.fetchall()}
                if len(sessions) < 2:
                    return jsonify({"error": "Tournoi introuvable."}), 404

                session_a, session_b = sessions[tournoi_id], sessions[autre_tournoi_id]

                conflits = joueurs_en_conflit_entre_sessions(cur, session_a, session_b)
                if conflits:
                    conn.rollback()
                    return jsonify({
                        "error": "Ces joueurs participent aux deux sessions : %s. Un joueur ne "
                                 "peut jouer qu'un seul tournoi par session."
                                 % ", ".join(conflits),
                        "code": "conflit_session",
                        "joueurs_en_conflit": conflits,
                    }), 409

                session_id = fusionner_sessions(cur, tournoi_id, autre_tournoi_id)

                # Les deux tournois etaient enregistres separement : chacun a
                # compte absents les joueurs de l'autre. Maintenant qu'ils
                # partagent une session, jouer l'un vaut presence pour les deux
                # -- ces absences doivent etre defaites.
                #
                # APRES la fusion, jamais avant : la fonction travaille sur
                # « les presents de la session », un ensemble qui n'existe qu'une
                # fois les deux tournois reunis.
                # Conception : docs/plan-sessions-tournois.md, 5.2
                cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
                res = cur.fetchone()
                seuil_declassement = int(res[0]) if res else DEFAULT_UNRANKED_THRESHOLD
                corriges = annuler_penalites_de_session(cur, session_id, seuil_declassement)
            conn.commit()
            # Les sigma ont pu bouger : les tiers en dependent.
            if corriges:
                recalculate_tiers()
            # Lier deux tournois change ce que la landing page doit afficher :
            # sans cette invalidation, elle garderait l'ancien regroupement en
            # cache jusqu'au prochain ajout de tournoi.
            invalidate_cache()
        return jsonify({
            "status": "success",
            "session_id": session_id,
            "penalites_annulees": len(corriges),
        })
    except Exception as e:
        logger.error(f"Erreur lier_session_tournoi: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


# CAPACITE DE ROLE, jamais une permission delegable (hierarchie-admin-plan.md 5).
# Cible : @role_required(ROLE_CHEF_ADMIN). Son bouton est dans navbar.html (donc
# visible depuis toutes les pages admin) : le gate d'interface va la-bas, pas
# dans une page precise.
@admin_bp.route('/api/admin/revert-last-tournament', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
def revert_last_tournament():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, date, session_id FROM Tournois ORDER BY date DESC, id DESC LIMIT 1")
                last = cur.fetchone()
                if not last: return jsonify({"message": "Aucun tournoi à annuler."}), 404
                # session_id lue MAINTENANT : apres le DELETE, elle est introuvable.
                tid, tdate, tsession = last[0], last[1], last[2]

                cur.execute("SELECT joueur_id, old_mu, old_sigma FROM Participations WHERE tournoi_id = %s", (tid,))
                participants = cur.fetchall()
                for jid, mu, sig in participants:
                    if mu is None: return jsonify({"status": "error", "message": "Trop ancien"}), 400

                if participants:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET mu = data.mu, sigma = data.sigma
                        FROM (VALUES %s) AS data(id, mu, sigma)
                        WHERE j.id = data.id
                    """, [(jid, mu, sig) for jid, mu, sig in participants])

                cur.execute("SELECT joueur_id, old_sigma FROM ghost_log WHERE tournoi_id = %s", (tid,))
                ghost_rows = cur.fetchall()
                if ghost_rows:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET sigma = data.sigma
                        FROM (VALUES %s) AS data(id, sigma)
                        WHERE j.id = data.id
                    """, [(jid, sig) for jid, sig in ghost_rows])

                # Meme geste que delete_tournament : seuls les NON-participants
                # reellement penalises sont decrementes, et is_ranked est recalcule.
                # Avant, un UPDATE global sans WHERE effacait une absence a TOUTE la
                # base -- y compris aux joueurs hors perimetre de ligue, exclus du
                # calcul de penalite -- et l'erreur etait cumulative a chaque annulation.
                cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
                res = cur.fetchone()
                threshold = int(res[0]) if res else DEFAULT_UNRANKED_THRESHOLD
                annuler_absences(cur, [jid for jid, _, _ in participants], threshold)

                # AVANT les DELETE : apres, il ne reste rien a consigner --
                # ni la date, ni le nombre de participants.
                audit.ecrire(cur, 'tournoi_annule', 'tournoi', tid, {
                    "date": str(tdate), "nb_participants": len(participants),
                    "session_id": tsession,
                })
                cur.execute("DELETE FROM ghost_log WHERE tournoi_id = %s", (tid,))
                cur.execute("DELETE FROM Participations WHERE tournoi_id = %s", (tid,))
                cur.execute("DELETE FROM Tournois WHERE id = %s", (tid,))
                drop_grille_snapshot_if_orphan(cur, tdate)
                drop_session_if_orphan(cur, tsession)
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
            return jsonify({"status": "success", "message": "Annulé."}), 200
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


# CAPACITE DE ROLE, jamais une permission delegable (hierarchie-admin-plan.md 5).
# Route deja signalee dangereuse par R-37 (mu/sigma non restaures apres
# suppression) et sans proxy frontend aujourd'hui : si quelqu'un lui en ajoute
# un, il garde le decorateur ci-dessous, pas un chemin d'auth plus permissif
# (R-58).
@admin_bp.route('/delete-tournament/<int:id>', methods=['DELETE'])
@role_required(ROLE_CHEF_ADMIN)
def delete_tournament(id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
                res = cur.fetchone()
                threshold = int(res[0]) if res else DEFAULT_UNRANKED_THRESHOLD

                # Lues AVANT le DELETE : introuvables apres.
                cur.execute("SELECT date, session_id FROM Tournois WHERE id = %s", (id,))
                row_tournoi = cur.fetchone()
                tdate = row_tournoi[0] if row_tournoi else None
                tsession = row_tournoi[1] if row_tournoi else None

                cur.execute("SELECT joueur_id, old_sigma FROM ghost_log WHERE tournoi_id = %s", (id,))
                ghost_rows = cur.fetchall()
                if ghost_rows:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET sigma = data.sigma
                        FROM (VALUES %s) AS data(id, sigma)
                        WHERE j.id = data.id
                    """, [(pid, old_sig) for pid, old_sig in ghost_rows])

                cur.execute("SELECT joueur_id FROM Participations WHERE tournoi_id = %s", (id,))
                parts = [r[0] for r in cur.fetchall()]
                annuler_absences(cur, parts, threshold)

                # AVANT le DELETE, meme raison qu'a l'annulation.
                # ⚠️ Cette route est signalee dangereuse par R-37 : contrairement
                # a l'annulation, elle NE RESTAURE PAS les mu/sigma. Le journal
                # le consigne, faute de pouvoir le corriger ici.
                audit.ecrire(cur, 'tournoi_supprime', 'tournoi', id, {
                    "date": str(tdate), "nb_participants": len(parts),
                    "session_id": tsession,
                    "scores_restaures": False,
                })
                cur.execute("DELETE FROM Tournois WHERE id = %s", (id,))
                if tdate is not None:
                    drop_grille_snapshot_if_orphan(cur, tdate)
                drop_session_if_orphan(cur, tsession)
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500



@admin_bp.route('/admin/ligues/setup', methods=['POST'])
@permission_required('gestion_ligues')
def setup_ligues():
    data = request.get_json()
    ligues_data = data.get('ligues', [])

    if not ligues_data:
        return jsonify({"error": "Aucune donnée de ligue reçue"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE Configuration SET value = 'true' WHERE key = 'league_mode_enabled'")

                cur.execute("SELECT id FROM Ligues")
                existing_ids = set(row[0] for row in cur.fetchall())

                ids_in_use = set()
                all_assigned_players = []

                for l_data in ligues_data:
                    nom = l_data.get('nom', '')
                    couleur = l_data.get('couleur', '#FFFFFF')
                    joueurs_ids = l_data.get('joueurs_ids', [])

                    ligue_num = extract_league_number(nom)
                    if ligue_num is None or ligue_num < 0 or ligue_num > 9:
                        continue

                    ligue_id = ligue_num + 1
                    ids_in_use.add(ligue_id)

                    if ligue_id in existing_ids:
                        cur.execute(
                            "UPDATE Ligues SET nom = %s, couleur = %s, niveau = %s WHERE id = %s",
                            (nom, couleur, ligue_num, ligue_id)
                        )
                    else:
                        cur.execute(
                            "INSERT INTO Ligues (id, nom, couleur, niveau) VALUES (%s, %s, %s, %s)",
                            (ligue_id, nom, couleur, ligue_num)
                        )

                    if joueurs_ids:
                        placeholders = ",".join(["%s"] * len(joueurs_ids))
                        cur.execute(f"UPDATE Joueurs SET ligue_id = %s WHERE id IN ({placeholders})", (ligue_id, *joueurs_ids))
                        all_assigned_players.extend(joueurs_ids)

                ids_to_remove = existing_ids - ids_in_use
                if ids_to_remove:
                    placeholders = ",".join(["%s"] * len(ids_to_remove))
                    cur.execute(f"UPDATE Joueurs SET ligue_id = NULL WHERE ligue_id IN ({placeholders})", tuple(ids_to_remove))
                    cur.execute(f"DELETE FROM Ligues WHERE id IN ({placeholders})", tuple(ids_to_remove))

                if all_assigned_players:
                    placeholders = ",".join(["%s"] * len(all_assigned_players))
                    cur.execute(f"UPDATE Joueurs SET ligue_id = NULL WHERE id NOT IN ({placeholders})", tuple(all_assigned_players))
                else:
                    cur.execute("UPDATE Joueurs SET ligue_id = NULL")

                # Meme action que les clefs de mode ligue d'update_config :
                # c'est le meme domaine, sous la meme permission. Deux noms
                # pour un domaine obligeraient a connaitre les deux pour le
                # filtrer.
                audit.ecrire(cur, 'ligues_configurees', 'systeme', None, {
                    "nb_ligues": len(ligues_data),
                    "ligues_supprimees": len(ids_to_remove),
                    "joueurs_affectes": len(all_assigned_players),
                })

            conn.commit()
            return jsonify({"status": "success", "message": "Configuration des ligues sauvegardée"})

    except Exception as e:
        logger.error(f"Erreur setup_ligues: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


@admin_bp.route('/admin/ligues/draft-simulation', methods=['GET'])
@permission_required('gestion_ligues')
def draft_simulation():
    force_reset = request.args.get('force_reset') == 'true'

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:

                cur.execute("SELECT COUNT(*) FROM Ligues")
                count_ligues = cur.fetchone()[0]

                if count_ligues > 0 and not force_reset:
                    cur.execute("""
                        SELECT l.id, l.nom, l.niveau, l.couleur,
                               j.id, j.nom, j.score_trueskill
                        FROM Ligues l
                        LEFT JOIN Joueurs j ON j.ligue_id = l.id
                        ORDER BY l.niveau ASC, j.score_trueskill DESC NULLS LAST
                    """)
                    rows = cur.fetchall()

                    draft_ligues = []
                    ligues_map = {}
                    ligues_order = []
                    for lid, lnom, lniv, lcoul, jid, jnom, jscore in rows:
                        if lid not in ligues_map:
                            ligues_map[lid] = {"nom": lnom, "couleur": lcoul, "joueurs": []}
                            ligues_order.append(lid)
                        if jid:
                            ligues_map[lid]["joueurs"].append({"id": jid, "nom": jnom, "score": float(jscore) if jscore else 0.0})
                    draft_ligues = [ligues_map[lid] for lid in ligues_order]

                    cur.execute("SELECT id, nom, score_trueskill FROM Joueurs WHERE ligue_id IS NULL ORDER BY score_trueskill DESC NULLS LAST")
                    unassigned = [{"id": r[0], "nom": r[1], "score": float(r[2]) if r[2] else 0.0} for r in cur.fetchall()]

                    return jsonify({
                        "mode": "edition",
                        "ligues": draft_ligues,
                        "unassigned": unassigned
                    })

                else:
                    cur.execute("""
                        SELECT id, nom, score_trueskill
                        FROM Joueurs
                        WHERE is_ranked = true
                        ORDER BY score_trueskill DESC NULLS LAST
                    """)
                    ranked_players = [{"id": r[0], "nom": r[1], "score": float(r[2]) if r[2] else 0.0} for r in cur.fetchall()]

                    cur.execute("""
                        SELECT id, nom, score_trueskill
                        FROM Joueurs
                        WHERE is_ranked = false
                        ORDER BY score_trueskill DESC NULLS LAST
                    """)
                    unranked_players = [{"id": r[0], "nom": r[1], "score": float(r[2]) if r[2] else 0.0} for r in cur.fetchall()]

                    draft = []
                    total = len(ranked_players)
                    colors = ["#FFD700", "#C0C0C0", "#CD7F32", "#48C9B0", "#9B59B6"]

                    if total > 0:
                        nb_ligues = max(1, min(math.ceil(total / 8), 5))
                        chunk = math.ceil(total / nb_ligues)

                        for i in range(nb_ligues):
                            start = i * chunk
                            end = min(start + chunk, total)
                            if start < total:
                                col = colors[i] if i < len(colors) else "#FFFFFF"
                                draft.append({"nom": f"Ligue {i}", "couleur": col, "joueurs": ranked_players[start:end]})

                    return jsonify({
                        "mode": "creation",
                        "ligues": draft,
                        "unassigned": unranked_players
                    })

    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500
