from __future__ import annotations

import math
import json
import secrets
import logging
from typing import Any
from datetime import datetime

import trueskill
import psycopg2.extras
from flask import Blueprint, jsonify, request, abort, g

import audit

from constants import (
    DEFAULT_MU, DEFAULT_SIGMA, TRUESKILL_BETA, TRUESKILL_DRAW_PROBABILITY,
    DEFAULT_TAU, DEFAULT_GHOST_PENALTY, DEFAULT_UNRANKED_THRESHOLD, DEFAULT_SIGMA_THRESHOLD,
    DEFAULT_TIERS, DEFAULT_TIER_COULEUR_TEXTE,
    DEFAULT_GHOST_THRESHOLD_SESSIONS, DEFAULT_GHOST_INTERVAL_SESSIONS,
    GHOST_SIGMA_CAP, IP_VERSION_DEFAULT,
    ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN,
    PERMISSIONS_CHAMPS_JOUEUR, MU_MIN, MU_MAX, SIGMA_MAX,
)
from db import get_db_connection
from auth import (permission_required, role_required, player_required,
                  compte_a_permission, fiche_cible_protegee, hors_de_portee)
from cache import invalidate_cache
from textes_ip import textes_ip, VERSIONS as IP_VERSIONS
from utils import generate_unique_slug, extract_league_number, nombre_fini, couleur_valide
from services import (
    recalculate_tiers, snapshot_grille, drop_grille_snapshot_if_orphan,
    drop_session_if_orphan, annuler_absences,
    verrou_tournois, session_a_un_autre_tournoi,
    joueurs_en_conflit_de_session, joueurs_en_conflit_entre_sessions,
    fusionner_sessions, annuler_penalites_de_session,
    MAX_CONFLITS_NOMMES, penalite_due,
    _aggregate_season_stats, _determine_winners, _save_awards_to_db,
    _apply_inter_league_moves,
    build_distribution, trueskill_score, has_tier, load_tiers, load_couleur_u,
    load_couleur_texte_u,
    nom_creable, empreinte_nom,
)

logger = logging.getLogger(__name__)

admin_bp = Blueprint('admin', __name__)

# Nombre de tournois proposes pour un rattachement a une session.
SESSION_CANDIDATS_PAR_DEFAUT = 20
SESSION_CANDIDATS_MAX = 100


# Message d'erreur par champ numerique (code `valeur_invalide`).
_BORNES_LISIBLES = {
    'mu': "mu doit être un nombre entre %g et %g." % (MU_MIN, MU_MAX),
    'sigma': "sigma doit être un nombre strictement positif, %g au plus." % SIGMA_MAX,
    'color': "La couleur doit être au format #RRGGBB.",
    'couleur': "La couleur doit être au format #RRGGBB.",
    'tau': "tau doit être un nombre entre 0 et %g." % SIGMA_MAX,
    'ghost_penalty': "La pénalité fantome doit être un nombre entre 0 et %g." % SIGMA_MAX,
    'sigma_threshold': "Le seuil de sigma doit être strictement positif, %g au plus." % SIGMA_MAX,
    'value': "La valeur du reset doit être strictement positive, %g au plus." % SIGMA_MAX,
    'max_sigma': "Le sigma maximal doit être strictement positif, %g au plus." % SIGMA_MAX,
}


def _valeur_invalide(champ):
    return jsonify({"error": _BORNES_LISIBLES[champ], "code": "valeur_invalide",
                    "champ": champ}), 400


def _sigma_valide(valeur):
    """Un sigma saisi a la main : fini, > 0, SIGMA_MAX au plus. None sinon."""
    return nombre_fini(valeur, 0.0, SIGMA_MAX, min_exclu=True)



from routes_comptes import notifier, notifier_tous


def _notifier_recap_publie(cur, saison_id):
    """Annonce un recap au moment ou il devient visible (pas a sa creation)."""
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


@admin_bp.route('/admin/check-token', methods=['GET'])
@role_required(ROLE_ADMIN)
def check_token():
    """Verifie que la session donne encore acces a l'administration.

    Appelee par le frontend a chaque page admin.
    """
    return jsonify({"status": "valid"}), 200



# ---------------------------------------------------------------------------
# Reset global du sigma (permission gestion_config)
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/global-reset', methods=['POST'])
@permission_required('gestion_config')
def apply_global_reset():
    """Ajoute du sigma aux joueurs sous un plafond, sans le leur faire depasser.

    Ex. : joueur a 1.8, reset de 0.3, plafond 2 -> 2.0. Un joueur deja au
    plafond n'est pas touche. Le plafond est obligatoire.
    """
    data = request.get_json(silent=True) or {}
    try:
        val = _sigma_valide(data.get('value'))
        max_sigma = _sigma_valide(data.get('max_sigma'))
        date_str = data.get('date')

        if val is None:
            return _valeur_invalide('value')

        if max_sigma is None:
            return _valeur_invalide('max_sigma')

        if not date_str:
            return jsonify({"error": "Une date est requise"}), 400

        try:
            target_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
             return jsonify({"error": "Format de date invalide"}), 400

        # Une date future bloquerait l'ajout de tournois jusqu'a elle.
        if target_date > datetime.now().date():
            return jsonify({"error": "La date du reset ne peut pas être dans le futur."}), 400

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                verrou_tournois(cur)
                # Evite un double envoi.
                cur.execute("SELECT 1 FROM global_resets WHERE date::date = %s LIMIT 1",
                            (target_date,))
                if cur.fetchone() is not None:
                    return jsonify({
                        "error": "Un reset global existe déjà à cette date. Annulez-le "
                                 "d'abord pour en appliquer un autre.",
                        "code": "reset_en_double",
                    }), 409

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

                # Le plafond l'emporte s'il est plus proche.
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

                # Le detail par joueur est dans global_reset_details.
                audit.ecrire(cur, 'reset_global_applique', 'systeme', reset_id, {
                    "valeur": val, "max_sigma": max_sigma,
                    "date_cible": str(target_date),
                    "joueurs_touches": len(lignes),
                })

                # Le classement bouge sans tournoi : on previent tout le monde.
                notifier_tous(
                    cur, 'reset_global',
                    "Reset global du %s" % target_date.strftime('%d/%m/%Y'),
                    "L'incertitude (sigma) de %d joueur(s) a été relevée de %s "
                    "(plafond %s). Les classements en tiennent compte."
                    % (len(lignes), val, max_sigma),
                    lien="/classement",
                )

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


# Meme permission que l'application du reset.
@admin_bp.route('/api/admin/revert-global-reset', methods=['POST'])
@permission_required('gestion_config')
def revert_global_reset():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                verrou_tournois(cur)
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
                    "SELECT joueur_id, delta_applied FROM global_reset_details WHERE reset_id = %s",
                    (reset_id,),
                )
                details = cur.fetchall()

                if details:
                    # On retire ce que chacun a recu (delta_applied) plutot que
                    # de restaurer old_sigma, pour ne pas effacer les changements
                    # posterieurs. Plancher a 0.001 : un sigma nul casse TrueSkill.
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET sigma = GREATEST(j.sigma - data.delta, 0.001)
                        FROM (VALUES %s) AS data(id, delta)
                        WHERE j.id = data.id
                    """, [(jid, float(delta)) for jid, delta in details])
                else:
                    # Reset anterieur au plafond : uniforme, sans detail.
                    cur.execute("UPDATE Joueurs SET sigma = sigma - %s", (val,))

                # Avant le DELETE, qui efface la trace de ce qui a ete applique.
                audit.ecrire(cur, 'reset_global_annule', 'systeme', reset_id, {
                    "valeur_annulee": float(val), "date_du_reset": str(reset_date),
                })

                # Complete l'annonce du reset deja envoyee. La date peut remonter
                # en chaine sur un ancien reset.
                notifier_tous(
                    cur, 'reset_global_annule',
                    "Reset global annulé",
                    "Le reset du %s a été annulé : les sigma sont revenus à leur "
                    "valeur d'avant, et les classements avec eux."
                    % (reset_date.strftime('%d/%m/%Y')
                       if hasattr(reset_date, 'strftime') else reset_date),
                    lien="/classement",
                )
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
    """Lecture des reglages, ouverte a toute session authentifiee.

    Utilisee par les pages Ligues, Saisons et Fiches joueurs, sans gestion_config.
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
            # Les deux versions, proposees cote a cote dans l'admin.
            "ip_textes": {v: textes_ip(v) for v in IP_VERSIONS},
        })
    except Exception:
        return jsonify({"error": "Erreur serveur"}), 500


@admin_bp.route('/admin/config', methods=['POST'])
@player_required
def update_config():
    """Reglages TrueSkill (gestion_config) et mode ligue (gestion_ligues).

    Pas de @permission_required : chaque groupe de cles verifie sa propre
    permission, et un refus est explicite (403).
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
                    "error": "Le mode ligue relève de la permission « Ligues ».",
                    "code": "permission_manquante",
                }), 403
        # Seules les cles presentes dans le payload sont ecrites.
        configs = []
        touche_trueskill = False

        # Reglages flottants finis et bornes.
        if 'tau' in data:
            tau = nombre_fini(data['tau'], 0.0, SIGMA_MAX)
            if tau is None:
                return _valeur_invalide('tau')
            configs.append(('tau', str(tau)))
        if 'ghost_enabled' in data:
            configs.append(('ghost_enabled', str(data['ghost_enabled']).lower()))
        if 'ghost_penalty' in data:
            penalite = nombre_fini(data['ghost_penalty'], 0.0, SIGMA_MAX)
            if penalite is None:
                return _valeur_invalide('ghost_penalty')
            configs.append(('ghost_penalty', str(penalite)))
        # Seuils en sessions loupees, au moins 1.
        if 'ghost_threshold_sessions' in data:
            configs.append(('ghost_threshold_sessions',
                            str(max(1, int(data['ghost_threshold_sessions'])))))
        if 'ghost_interval_sessions' in data:
            configs.append(('ghost_interval_sessions',
                            str(max(1, int(data['ghost_interval_sessions'])))))
        if 'sigma_threshold' in data:
            seuil = _sigma_valide(data['sigma_threshold'])
            if seuil is None:
                return _valeur_invalide('sigma_threshold')
            configs.append(('sigma_threshold', str(seuil)))
        if 'ip_version_live' in data:
            ip_version_live = str(data['ip_version_live'])
            if ip_version_live not in ('v1', 'v2'):
                return jsonify({"error": "ip_version_live invalide"}), 400
            configs.append(('ip_version_live', ip_version_live))

        # Traite a part : declenche le reclassement de tous les joueurs.
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
                    "error": "Ces réglages relèvent de la permission « Réglage TS ».",
                    "code": "permission_manquante",
                }), 403

        # Aucune cle autorisee : rien a ecrire.
        if not touche_trueskill and not touche_ligues:
            return jsonify({"error": "Aucun réglage fourni"}), 400

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

                # Seulement si le seuil a ete fourni.
                if unranked_threshold is not None:
                    cur.execute("""
                        UPDATE Joueurs
                        SET is_ranked = (COALESCE(consecutive_missed, 0) < %s)
                    """, (unranked_threshold,))

                # Une entree d'audit par domaine (config et ligues).
                CLES_LIGUE = {'league_mode_enabled', 'inter_league_moves'}
                ligue = {k: v for k, v in configs if k in CLES_LIGUE}
                ts = {k: v for k, v in configs if k not in CLES_LIGUE}
                if ts:
                    audit.ecrire(cur, 'config_modifiee', 'systeme', None, {
                        "cles": ts,
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
    """Courbe et position des joueurs classes, pour l'apercu des seuils de tiers.

    Meme population que recalculate_tiers().
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


# --- Tiers (permission gestion_config) ------------------------------------
# 'U' (non classe) n'est pas un tier en base : seule sa couleur se regle.
# Chaque ecriture recalcule les tiers de tous les joueurs.

def _nom_tier_valide(nom) -> str | None:
    """Nom de tier normalise, ou None (vide, > 10 caracteres, ou 'U')."""
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
    """Renumerote les rangs 0..N-1 sans trou."""
    cur.execute("SELECT id FROM tiers ORDER BY rang ASC")
    ids = [r[0] for r in cur.fetchall()]
    for nouveau_rang, tid in enumerate(ids):
        cur.execute("UPDATE tiers SET rang = %s WHERE id = %s", (nouveau_rang, tid))


def _appliquer_plancher(cur) -> None:
    """Efface le seuil du tier de plus petit rang (le plancher n'en a pas).

    A n'appeler qu'en fin d'operation.
    """
    cur.execute("SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1")
    row = cur.fetchone()
    if row is not None and row[1] is not None:
        cur.execute("UPDATE tiers SET seuil_k = NULL WHERE id = %s", (row[0],))


def _etat_tiers(cur):
    """Etat complet des tiers pour le journal, du meilleur au pire."""
    return [{"id": t["id"], "nom": t["nom"], "couleur": t["couleur"],
             "couleur_texte": t["couleur_texte"],
             "seuil_k": t["seuil_k"]} for t in load_tiers(cur)]


@admin_bp.route('/admin/tiers', methods=['GET'])
@player_required
def get_tiers():
    """Lecture des tiers, ouverte a toute session authentifiee."""
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
    """Cree un tier, au sommet par defaut ou au-dessus de `apres_rang`."""
    data = request.get_json() or {}
    nom = _nom_tier_valide(data.get('nom'))
    if nom is None:
        return jsonify({"error": "Nom de tier invalide (1-10 caractères, 'U' réservé)"}), 400
    couleur = _couleur_valide(data.get('couleur'))
    if couleur is None:
        return jsonify({"error": "Couleur invalide (format hex, ex: #f77b7b)"}), 400
    couleur_texte = DEFAULT_TIER_COULEUR_TEXTE
    if data.get('couleur_texte') is not None:
        couleur_texte = _couleur_valide(data['couleur_texte'])
        if couleur_texte is None:
            return jsonify({"error": "Couleur du texte invalide (format hex, ex: #ffffff)"}), 400
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
                    return jsonify({"error": f"Un tier « {nom} » existe déjà"}), 400

                avant = _etat_tiers(cur)
                apres_rang = data.get('apres_rang')
                cur.execute("SELECT rang FROM tiers ORDER BY rang DESC LIMIT 1")
                rang_max = cur.fetchone()
                rang_max = rang_max[0] if rang_max else -1

                if apres_rang is None:
                    nouveau_rang = rang_max + 1
                else:
                    # Decale les rangs superieurs pour faire de la place.
                    apres_rang = int(apres_rang)
                    cur.execute("UPDATE tiers SET rang = rang + 1 WHERE rang > %s", (apres_rang,))
                    nouveau_rang = apres_rang + 1

                cur.execute(
                    "INSERT INTO tiers (nom, couleur, couleur_texte, seuil_k, rang)"
                    " VALUES (%s, %s, %s, %s, %s) RETURNING id",
                    (nom, couleur, couleur_texte, seuil_k, nouveau_rang),
                )
                nouvel_id = cur.fetchone()[0]
                _appliquer_plancher(cur)
                audit.ecrire(cur, 'tier_cree', 'systeme', nouvel_id,
                             {"nom": nom, "avant": avant, "apres": _etat_tiers(cur)})
            conn.commit()
            recalculate_tiers()
            invalidate_cache()
        # Id renvoye pour que le panneau suive le tier sans passer par son nom.
        return jsonify({"status": "success", "id": nouvel_id})
    except Exception as e:
        logger.error(f"Erreur create_tier: {e}")
        return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/tiers/<int:tier_id>', methods=['PUT'])
@permission_required('gestion_config')
def update_tier(tier_id):
    """Modifie nom, couleurs ou seuil d'un tier (le rang passe par /reorder)."""
    data = request.get_json() or {}
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, rang FROM tiers WHERE id = %s", (tier_id,))
                row = cur.fetchone()
                if row is None:
                    return jsonify({"error": "Tier introuvable"}), 404
                avant = _etat_tiers(cur)

                champs, valeurs = [], []
                if 'nom' in data:
                    nom = _nom_tier_valide(data['nom'])
                    if nom is None:
                        return jsonify({"error": "Nom de tier invalide (1-10 caractères, 'U' réservé)"}), 400
                    cur.execute(
                        "SELECT COUNT(*) FROM tiers WHERE UPPER(nom) = UPPER(%s) AND id != %s",
                        (nom, tier_id),
                    )
                    if cur.fetchone()[0] > 0:
                        return jsonify({"error": f"Un tier « {nom} » existe déjà"}), 400
                    champs.append("nom = %s"); valeurs.append(nom)
                if 'couleur' in data:
                    couleur = _couleur_valide(data['couleur'])
                    if couleur is None:
                        return jsonify({"error": "Couleur invalide (format hex, ex: #f77b7b)"}), 400
                    champs.append("couleur = %s"); valeurs.append(couleur)
                if 'couleur_texte' in data:
                    couleur_texte = _couleur_valide(data['couleur_texte'])
                    if couleur_texte is None:
                        return jsonify({"error": "Couleur du texte invalide (format hex, ex: #ffffff)"}), 400
                    champs.append("couleur_texte = %s"); valeurs.append(couleur_texte)
                # seuil_k accepte meme sur le plancher actuel : le panneau envoie
                # ses PUT avant le /reorder, qui retablit l'invariant.
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
                    return jsonify({"error": "Aucun champ à modifier"}), 400

                valeurs.append(tier_id)
                cur.execute(f"UPDATE tiers SET {', '.join(champs)} WHERE id = %s", valeurs)
                apres = _etat_tiers(cur)
                # On ne journalise que ce qui a change.
                t_avant = next((t for t in avant if t["id"] == tier_id), {})
                t_apres = next((t for t in apres if t["id"] == tier_id), {})
                changements = {c: [t_avant.get(c), t_apres.get(c)]
                               for c in ('nom', 'couleur', 'couleur_texte', 'seuil_k')
                               if t_avant.get(c) != t_apres.get(c)}
                if changements:
                    audit.ecrire(cur, 'tier_modifie', 'systeme', tier_id, {
                        "nom": t_apres.get("nom"),
                        "champs": list(changements),
                        "changements": changements,
                        "avant": avant, "apres": apres,
                    })
                # Pas de _appliquer_plancher() ici : c'est /reorder qui le fait.
            conn.commit()
            # Recalcul seulement si quelque chose a change.
            if changements:
                recalculate_tiers()
                invalidate_cache()
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Erreur update_tier: {e}")
        return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/tiers/unranked', methods=['PUT'])
@permission_required('gestion_config')
def update_tier_u():
    """Couleurs de la pastille U (non classe) : fond et texte, chacun facultatif.

    Pas de recalcul necessaire."""
    data = request.get_json(silent=True) or {}
    nouvelles = {}
    for champ, clef in (('couleur', 'tier_u_couleur'), ('couleur_texte', 'tier_u_couleur_texte')):
        if champ in data:
            valeur = _couleur_valide(data[champ])
            if valeur is None:
                return jsonify({"error": "Couleur invalide (format hex, ex: #f77b7b)"}), 400
            nouvelles[champ] = (clef, valeur)
    if not nouvelles:
        return jsonify({"error": "Couleur invalide (format hex, ex: #f77b7b)"}), 400
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                fond = load_couleur_u(cur)
                avant = {"couleur": fond, "couleur_texte": load_couleur_texte_u(cur, fond)}
                for champ, (clef, valeur) in nouvelles.items():
                    cur.execute("""
                        INSERT INTO Configuration (key, value)
                        VALUES (%s, %s)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                    """, (clef, valeur))
                apres = dict(avant, **{c: v for c, (_, v) in nouvelles.items()})
                # On ne journalise que ce qui a change.
                changements = {c: [avant[c], apres[c]] for c in nouvelles
                               if apres[c].upper() != avant[c].upper()}
                if changements:
                    audit.ecrire(cur, 'tier_modifie', 'systeme', None, {
                        "nom": "U", "champs": list(changements),
                        "changements": changements,
                        "avant": avant, "apres": apres,
                    })
            conn.commit()
            invalidate_cache()
        return jsonify({"status": "success", **apres})
    except Exception as e:
        logger.error(f"Erreur update_tier_u: {e}")
        return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/tiers/<int:tier_id>', methods=['DELETE'])
@permission_required('gestion_config')
def delete_tier(tier_id):
    """Supprime un tier (le tier au-dessus devient plancher si besoin).

    Refuse de supprimer le dernier tier.
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM tiers")
                if cur.fetchone()[0] <= 1:
                    return jsonify({"error": "Impossible de supprimer le dernier tier restant"}), 400

                avant = _etat_tiers(cur)
                cur.execute("DELETE FROM tiers WHERE id = %s", (tier_id,))
                if cur.rowcount == 0:
                    return jsonify({"error": "Tier introuvable"}), 404

                _renumeroter_rangs(cur)
                _appliquer_plancher(cur)
                audit.ecrire(cur, 'tier_supprime', 'systeme', tier_id, {
                    "nom": next((t["nom"] for t in avant if t["id"] == tier_id), None),
                    "avant": avant, "apres": _etat_tiers(cur),
                })
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
    """Reassigne tous les rangs a partir de l'ordre complet (ids, du meilleur au pire)."""
    data = request.get_json() or {}
    ordre = data.get('ordre')
    if not isinstance(ordre, list) or not ordre:
        return jsonify({"error": "« ordre » doit être une liste non vide d'ids"}), 400

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
                avant = _etat_tiers(cur)

                # Rangs temporaires negatifs : `rang` est UNIQUE.
                n = len(ordre)
                for position, tid in enumerate(ordre):
                    cur.execute("UPDATE tiers SET rang = %s WHERE id = %s", (-(position + 1), int(tid)))
                for position, tid in enumerate(ordre):
                    cur.execute("UPDATE tiers SET rang = %s WHERE id = %s", (n - 1 - position, int(tid)))

                _appliquer_plancher(cur)
                apres = _etat_tiers(cur)
                # Trace et recalcul seulement si l'ordre ou le plancher a change.
                change = apres != avant
                if change:
                    audit.ecrire(cur, 'tiers_reordonnes', 'systeme', None, {
                        "nom": " > ".join(t["nom"] for t in apres),
                        "avant": avant, "apres": apres,
                    })
            conn.commit()
            if change:
                recalculate_tiers()
                invalidate_cache()
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Erreur reorder_tiers: {e}")
        return jsonify({"error": "Requête invalide"}), 400


@admin_bp.route('/admin/tiers/reset', methods=['POST'])
@permission_required('gestion_config')
def reset_tiers():
    """Restaure les tiers par defaut (DEFAULT_TIERS)."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                # Etat complet avant reinitialisation, pour pouvoir le reconstruire.
                avant = _etat_tiers(cur)
                cur.execute("DELETE FROM tiers")
                for t in DEFAULT_TIERS:
                    cur.execute(
                        "INSERT INTO tiers (nom, couleur, couleur_texte, seuil_k, rang)"
                        " VALUES (%s, %s, %s, %s, %s)",
                        (t["nom"], t["couleur"], t["couleur_texte"], t["seuil_k"], t["rang"]),
                    )
                audit.ecrire(cur, 'tiers_reinitialises', 'systeme', None,
                             {"avant": avant, "apres": _etat_tiers(cur)})
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
                           COALESCE(c.discord_global_name, c.discord_username), c.statut,
                           c.id, c.role
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
                    "compte_lie": { "pseudo": r[11], "statut": r[12] } if r[12] else None,
                    # Fiche protegee (rang egal ou superieur), sauf la sienne.
                    "protegee": (r[13] is not None and r[13] != g.compte['id']
                                 and hors_de_portee(g.compte['role'], r[14])),
                } for r in cur.fetchall()]
        return jsonify(joueurs)
    except Exception as e:
        logger.error(f"Erreur serveur: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


@admin_bp.route('/admin/joueurs/<int:id>', methods=['PUT'])
@permission_required('gestion_joueurs')
@fiche_cible_protegee  # pas la fiche d'un rang egal ou superieur
def api_update_joueur(id):
    """Edite une fiche joueur, un champ a la fois selon les droits de l'acteur.

    `gestion_joueurs` ouvre la route (lecture de la fiche) ; chaque champ exige
    en plus sa sous-permission, listee dans PERMISSIONS_CHAMPS_JOUEUR. La
    verification est ici plutot que dans un decorateur parce que les quatre
    champs partagent un seul UPDATE : un @permission_required de route entiere
    ne saurait pas lequel est en cause.

    Un champ absent du payload, ou identique a la base, ne demande aucun droit :
    le formulaire renvoie toujours la fiche entiere.
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
            # Normalisee pour la comparaison ; une valeur invalide est refusee plus bas.
            demande['color'] = couleur_valide(data['color']) or data['color']

        # Une valeur renvoyee telle qu'affichee n'est pas une modification.
        # mu/sigma sont compares a la precision affichee (3 decimales).
        DECIMALES_AFFICHEES = 3

        def a_change(champ):
            if champ in ('mu', 'sigma'):
                return (round(demande[champ], DECIMALES_AFFICHEES)
                        != round(courant[champ], DECIMALES_AFFICHEES))
            if champ == 'color':
                return str(demande[champ]).upper() != str(courant[champ]).upper()
            return demande[champ] != courant[champ]

        # Bornes verifiees seulement sur les valeurs modifiees.
        if a_change('mu') and nombre_fini(demande['mu'], MU_MIN, MU_MAX) is None:
            return _valeur_invalide('mu')
        if a_change('sigma') and _sigma_valide(demande['sigma']) is None:
            return _valeur_invalide('sigma')
        if a_change('color'):
            if couleur_valide(demande['color']) is None:
                return _valeur_invalide('color')

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

        # Un champ inchange garde la valeur de la base (evite la troncature a
        # 3 decimales).
        for champ in PERMISSIONS_CHAMPS_JOUEUR:
            if not a_change(champ):
                demande[champ] = courant[champ]

        mu, sigma, nom = demande['mu'], demande['sigma'], demande['nom']
        is_ranked, color = demande['is_ranked'], demande['color']

        # consecutive_missed n'est modifiable que par le superadmin (correction
        # ponctuelle ; sinon passer par scripts/recompter_absences.py).
        modifier_absences = (g.compte['role'] == ROLE_SUPERADMIN
                             and 'consecutive_missed' in data)
        if modifier_absences:
            consecutive_missed = max(0, int(data['consecutive_missed']))

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                # Meme regle que la creation ; la fiche elle-meme est exclue.
                if a_change('nom'):
                    nom, erreur = nom_creable(cur, nom, exclure_id=id)
                    if erreur is not None:
                        conn.rollback()
                        return jsonify(erreur), 409
                    demande['nom'] = nom

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

                # Memes champs que la verification de droits (a_change).
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
                        # Nom de la fiche avant modification.
                        "joueur_nom": courant['nom'],
                        "avant": avant, "apres": apres, "champs": champs,
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
@permission_required('joueurs_irreversible')
@fiche_cible_protegee
def api_delete_joueur(id):
    """Supprime un joueur, sauf s'il a un historique de matchs.

    Les FK sont en ON DELETE CASCADE et le calcul TrueSkill est incremental :
    supprimer des participations fausserait le classement des autres. Dans ce
    cas, il faut anonymiser.
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

                # Delie d'abord le compte (FK en ON DELETE SET NULL).
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
                    # Une suspension reste en place.
                    nouveau_statut = 'pending' if statut_compte == 'linked' else statut_compte
                    cur.execute(
                        """UPDATE comptes
                           SET joueur_id = NULL, statut = %s,
                               profil_synced_at = NULL, updated_at = now()
                           WHERE id = %s""",
                        (nouveau_statut, compte_id),
                    )
                    audit.ecrire(
                        cur, 'liaison_annulee', 'compte', compte_id,
                        {"joueur_id": id, "joueur_nom": row[0],
                         "statut": nouveau_statut,
                         "origine": "suppression_fiche"},
                    )
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

                # Avant le DELETE : le nom n'existera plus ailleurs.
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
@permission_required('joueurs_irreversible')
@fiche_cible_protegee
def api_anonymiser_joueur(id):
    """Detache l'identite d'un joueur sans toucher a son dossier sportif.

    Le suffixe aleatoire evite une collision avec un nom existant.
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
                # Empreinte de l'ancien nom pour empecher sa recreation.
                cur.execute(
                    "INSERT INTO noms_interdits (nom_hash) VALUES (%s) ON CONFLICT DO NOTHING",
                    (empreinte_nom(ancien_nom),),
                )
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
@permission_required('joueurs_creation')
def api_add_joueur():
    """Cree une fiche joueur.

    Un mu/sigma de depart non standard exige aussi `edition_mu_sigma`.
    """
    data = request.get_json()
    try:
        nom = data.get('nom')
        mu = nombre_fini(data.get('mu', DEFAULT_MU), MU_MIN, MU_MAX)
        sigma = _sigma_valide(data.get('sigma', DEFAULT_SIGMA))
        # Majuscules avant la comparaison au defaut.
        color = couleur_valide(data.get('color', '#FFFFFF'))

        if not nom:
            return jsonify({"error": "Le nom du joueur est requis"}), 400
        for champ, valeur in (('mu', mu), ('sigma', sigma), ('color', color)):
            if valeur is None:
                return _valeur_invalide(champ)

        # Seul un depart hors defaut demande le droit.
        if abs(mu - DEFAULT_MU) > 1e-9 or abs(sigma - DEFAULT_SIGMA) > 1e-9:
            accordee, erreur = compte_a_permission(g.compte, 'edition_mu_sigma')
            if erreur is not None:
                return erreur
            if not accordee:
                return jsonify({
                    "error": "Vous ne pouvez pas fixer le score de départ. "
                             "Créez la fiche au score par défaut.",
                    "code": "permission_manquante",
                    "permission": "edition_mu_sigma",
                }), 403

        # Meme regle que sur l'edition.
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
                # Meme regle que partout ou joueurs.nom s'ecrit.
                nom, erreur = nom_creable(cur, nom)
                if erreur is not None:
                    conn.rollback()
                    return jsonify(erreur), 409

                cur.execute(
                    """INSERT INTO Joueurs (nom, mu, sigma, tier, is_ranked, consecutive_missed, color)
                       VALUES (%s, %s, %s, 'U', true, 0, %s) RETURNING id""",
                    (nom, mu, sigma, color)
                )
                joueur_id = cur.fetchone()[0]
                audit.ecrire(cur, 'joueur_cree', 'joueur', joueur_id, {
                    "nom": nom, "mu": mu, "sigma": sigma, "color": color,
                    "origine": "formulaire",
                    # Depart hors defaut (exige edition_mu_sigma).
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
                cur.execute("SELECT code, nom, emoji, description FROM types_awards WHERE code NOT LIKE %s ORDER BY nom ASC", ('%moai',))
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

                        audit.ecrire(cur, 'recap_cree', 'saison', saison_id, {
                            "nom": nom, "slug": slug,
                            "type": "ligue_unifie",
                            "periode": "%s -> %s" % (d_debut, d_fin),
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
                cur.execute("SELECT is_league_recap, include_league_moves, nom, slug, is_active "
                            "FROM saisons WHERE id = %s", (saison_id,))
                row = cur.fetchone()
                if not row:
                    return jsonify({"error": "Saison introuvable"}), 404

                is_league_recap, include_league_moves, nom, slug, publie = row
                rollback_warnings = []
                ligues_restaurees = []

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
                        ligues_restaurees.append({"joueur_id": joueur_id, "ligue_id": from_ligue_id})

                cur.execute("DELETE FROM awards_obtenus WHERE saison_id = %s", (saison_id,))
                awards_supprimes = cur.rowcount
                cur.execute("DELETE FROM saisons WHERE id = %s", (saison_id,))
                # Garde une trace des trophees et mouvements retires.
                audit.ecrire(cur, 'recap_supprime', 'saison', saison_id, {
                    "nom": nom, "slug": slug, "publie": bool(publie),
                    "awards_supprimes": awards_supprimes,
                    "ligues_restaurees": ligues_restaurees,
                    "avertissements": rollback_warnings,
                })
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

            # Les mouvements de ligue ne sont ecrits qu'ici.
            cur.execute("SELECT COUNT(*) FROM awards_obtenus WHERE saison_id = %s", (id,))
            nb_awards = cur.fetchone()
            audit.ecrire(cur, 'recap_publie', 'saison', id, {
                "awards": nb_awards[0] if nb_awards else None,
                "critere_mouvement": move_criterion,
                "mouvements": movements,
            })

        conn.commit()
        invalidate_cache()

    response = {'status': 'success', 'message': 'Saison publiée et awards distribués !'}
    if movements:
        response['movements'] = movements
        response['message'] += f' {len(movements)} mouvements inter-ligue effectués.'

    return jsonify(response)



def _joueurs_tournoi_invalides(joueurs_data):
    """Controle de forme de la liste des joueurs. Message d'erreur, ou None."""
    if not isinstance(joueurs_data, list) or len(joueurs_data) < 2:
        return "Il faut au moins 2 joueurs."
    for j in joueurs_data:
        if not isinstance(j, dict):
            return "Ligne de joueur invalide."
        nom, score = j.get('nom'), j.get('score')
        if not isinstance(nom, str) or not nom.strip():
            return "Nom de joueur invalide."
        # bool exclu (True est un int) ; borne de la colonne integer.
        if isinstance(score, bool) or not isinstance(score, int) or abs(score) > 1_000_000:
            return "Score invalide pour « %s » : un nombre entier est attendu." % nom.strip()
        if not isinstance(j.get('exclude_from_ts', False), bool):
            return "Option « hors TrueSkill » invalide pour « %s »." % nom.strip()
    return None


@admin_bp.route('/add-tournament', methods=['POST'])
@permission_required('gestion_tournois')
def add_tournament():
    data = request.get_json(silent=True) or {}
    date_tournoi_str = data.get('date')
    joueurs_data = data.get('joueurs')
    ligue_id = data.get('ligue_id')
    # Tournoi a rattacher a la meme session (None : session propre).
    autre_tournoi_id = data.get('autre_tournoi_id')

    if not date_tournoi_str or not joueurs_data:
        return jsonify({"error": "Données incomplètes"}), 400

    if autre_tournoi_id is not None:
        try:
            autre_tournoi_id = int(autre_tournoi_id)
        except (TypeError, ValueError):
            return jsonify({"error": "Tournoi à lier invalide."}), 400

    # Tout le payload est verifie avant la premiere ecriture.
    erreur = _joueurs_tournoi_invalides(joueurs_data)
    if erreur is not None:
        return jsonify({"error": erreur, "code": "saisie_invalide"}), 400

    if ligue_id is not None and str(ligue_id).lower() != 'mixte':
        try:
            ligue_id = int(ligue_id)
        except (TypeError, ValueError):
            return jsonify({"error": "Ligue invalide."}), 400

    try:
        date_tournoi = datetime.strptime(date_tournoi_str, '%Y-%m-%d').date()
        if date_tournoi > datetime.now().date():
            return jsonify({"error": "Impossible d'ajouter un tournoi dans le futur."}), 400

        with get_db_connection() as conn:
            with conn.cursor() as cur:
                verrou_tournois(cur)
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
                    if res_ligue is None:
                        return jsonify({"error": "Cette ligue n'existe pas."}), 400
                    ligue_nom_archive = res_ligue[0]
                    ligue_couleur_archive = res_ligue[1]

                # Fige la grille de reference IP v2 avant de modifier les mu.
                snapshot_grille(cur, date_tournoi)

                # Chaque tournoi ouvre sa propre session (session_id NOT NULL).
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
                    if not isinstance(nom, str):
                        conn.rollback()
                        return jsonify({"error": "Nom de joueur invalide."}), 400
                    # Casse ignoree (decision du 25/09) : « mario » tape a la main
                    # designe la fiche « Mario », au lieu d'en creer un doublon
                    # indiscernable a l'oeil.
                    cur.execute("SELECT id, nom, mu, sigma FROM Joueurs WHERE lower(nom) = lower(%s)",
                                (nom.strip(),))
                    res = cur.fetchone()
                    if res:
                        jid, nom_fiche, mu, sigma = res
                    else:
                        # Nom inconnu : creation a la volee, avec les memes
                        # regles que partout (nom_creable).
                        nom_fiche, erreur = nom_creable(cur, nom)
                        if erreur is not None:
                            conn.rollback()
                            return jsonify(erreur), 409
                        # Creer une fiche exige joueurs_creation, comme sur la
                        # page Fiches joueurs (la sous-permission inclut son parent).
                        accordee, erreur = compte_a_permission(g.compte, 'joueurs_creation')
                        if erreur is not None:
                            conn.rollback()
                            return erreur
                        if not accordee:
                            conn.rollback()
                            return jsonify({
                                "error": "Le joueur « %s » n'existe pas. Sa création relève de la "
                                         "permission « Ajouter un joueur » : demandez sa création "
                                         "préalable, ou vérifiez l'orthographe." % nom_fiche,
                                "code": "joueur_inconnu",
                            }), 409
                        cur.execute("INSERT INTO Joueurs (nom, mu, sigma, tier, is_ranked) VALUES (%s, %s, %s, 'U', true) RETURNING id", (nom_fiche, DEFAULT_MU, DEFAULT_SIGMA))
                        jid, mu, sigma = cur.fetchone()[0], DEFAULT_MU, DEFAULT_SIGMA
                    # Meme fiche saisie deux fois.
                    if jid in joueurs_ids_map.values():
                        conn.rollback()
                        return jsonify({
                            "error": "Le joueur « %s » figure deux fois dans ce tournoi." % nom_fiche,
                            "code": "joueur_en_double",
                        }), 409
                    # Le nom de la fiche remplace celui saisi pour la suite du calcul.
                    joueur['nom'] = nom = nom_fiche
                    joueurs_ratings[nom] = trueskill.Rating(mu=float(mu), sigma=float(sigma))
                    joueurs_ids_map[nom] = jid
                    joueurs_exclude_ts[nom] = exclude_ts
                    cur.execute("INSERT INTO Participations (tournoi_id, joueur_id, score, old_mu, old_sigma, exclude_from_ts) VALUES (%s, %s, %s, %s, %s, %s)", (tournoi_id, jid, score, float(mu), float(sigma), exclude_ts))

                # Doublon : meme date, memes joueurs, memes scores (second envoi).
                cur.execute("""
                    SELECT t.id FROM Tournois t
                    WHERE t.date = %s AND t.id <> %s
                      AND NOT EXISTS (
                          (SELECT joueur_id, score FROM Participations WHERE tournoi_id = t.id)
                          EXCEPT
                          (SELECT joueur_id, score FROM Participations WHERE tournoi_id = %s))
                      AND NOT EXISTS (
                          (SELECT joueur_id, score FROM Participations WHERE tournoi_id = %s)
                          EXCEPT
                          (SELECT joueur_id, score FROM Participations WHERE tournoi_id = t.id))
                    LIMIT 1
                """, (date_tournoi, tournoi_id, tournoi_id, tournoi_id))
                doublon = cur.fetchone()
                if doublon is not None:
                    conn.rollback()
                    return jsonify({
                        "error": "Ce tournoi est déjà enregistré (même date, mêmes joueurs, "
                                 "mêmes scores). Rien n'a été ajouté.",
                        "code": "tournoi_en_double",
                        "tournoi_id": doublon[0],
                    }), 409

                # Rattachement a une session existante. Le controle de conflit
                # se fait apres l'insertion des participations (joueur_id connus)
                # et avant la fusion ; il est refait ici meme si le client l'a
                # deja fait via /admin/tournois/verifier-session.
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
                        # Le rollback annule aussi les fiches creees et la grille figee.
                        conn.rollback()
                        return jsonify({
                            "error": "Ces joueurs participent déjà à un autre tournoi de cette "
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
                # TrueSkill exige au moins deux joueurs.
                if len(ts_joueurs) < 2:
                    joueurs_exclude_ts.update({j['nom']: True for j in ts_joueurs})
                    ts_joueurs = []
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

                # Ligue de la derniere apparition, pour le mode ligue.
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

                # Un joueur present a un autre tournoi de la session ne prend pas
                # d'absence.
                deja_presents = set()
                # Si un autre tournoi de la session a deja compte les absents, on
                # ne les recompte pas.
                session_deja_comptee = session_a_un_autre_tournoi(
                    cur, session_id, tournoi_id, ligue_id)
                if absent_ids and not session_deja_comptee:
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
                    present_dans_session = pid in deja_presents
                    compte_absent = not (present_dans_session or session_deja_comptee)
                    new_missed = (missed or 0) + 1 if compte_absent else (missed or 0)
                    new_sig = float(sig)

                    # Declenchement base uniquement sur le compteur de sessions loupees.
                    if (ghost_enabled and compte_absent and new_sig < GHOST_SIGMA_CAP
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

                # Le detail des scores est dans `participations`.
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


# Liste les tournois recents rattachables et ceux en conflit de joueurs.
# Lecture seule et indicative (comparaison par nom) : add_tournament tranche.
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

                # Joueurs deja engages dans chaque session, noms normalises.
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


# Liaison apres coup de deux tournois deja enregistres.
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
                verrou_tournois(cur)
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

                # Annule les absences comptees a tort maintenant que les deux
                # tournois partagent une session (apres la fusion).
                cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
                res = cur.fetchone()
                seuil_declassement = int(res[0]) if res else DEFAULT_UNRANKED_THRESHOLD
                corriges = annuler_penalites_de_session(cur, session_id, seuil_declassement)

                # Peut modifier des sigma : trace avec avant/apres.
                audit.ecrire(cur, 'tournoi_lie', 'tournoi', tournoi_id, {
                    "autre_tournoi_id": autre_tournoi_id,
                    "session_id": session_id,
                    "penalites_annulees": corriges,
                    "score_modifie": bool(corriges),
                })
            conn.commit()
            if corriges:
                recalculate_tiers()
            # La page d'accueil affiche le regroupement par session.
            invalidate_cache()
        return jsonify({
            "status": "success",
            "session_id": session_id,
            "penalites_annulees": len(corriges),
        })
    except Exception as e:
        logger.error(f"Erreur lier_session_tournoi: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


# Capacite de role (chef_admin), non delegable.
@admin_bp.route('/api/admin/revert-last-tournament', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
def revert_last_tournament():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                verrou_tournois(cur)
                # Le dernier enregistre (id), pas le plus recent par date :
                # c'est lui que old_mu/old_sigma permettent de defaire.
                cur.execute(
                    "SELECT id, date, session_id, ligue_id FROM Tournois ORDER BY id DESC LIMIT 1")
                last = cur.fetchone()
                if not last: return jsonify({"message": "Aucun tournoi à annuler."}), 404
                # Lue avant le DELETE.
                tid, tdate, tsession, tligue = last[0], last[1], last[2], last[3]

                # Un reset global posterieur serait efface par la restauration.
                cur.execute("SELECT 1 FROM global_resets WHERE date >= %s LIMIT 1", (tdate,))
                if cur.fetchone() is not None:
                    return jsonify({
                        "status": "error",
                        "message": "Un reset global a été appliqué après ce tournoi : "
                                   "annulez d'abord le reset.",
                        "code": "reset_posterieur",
                    }), 409

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

                # Seuls les non-participants penalises sont decrementes.
                cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
                res = cur.fetchone()
                threshold = int(res[0]) if res else DEFAULT_UNRANKED_THRESHOLD
                # Si un autre tournoi de la session porte l'absence, rien a defaire.
                if not session_a_un_autre_tournoi(cur, tsession, tid, tligue):
                    annuler_absences(cur, [jid for jid, _, _ in participants], threshold)

                # Avant les DELETE.
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


# Capacite de role (chef_admin), non delegable. Ne restaure pas mu/sigma.
@admin_bp.route('/delete-tournament/<int:id>', methods=['DELETE'])
@role_required(ROLE_CHEF_ADMIN)
def delete_tournament(id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                verrou_tournois(cur)
                cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
                res = cur.fetchone()
                threshold = int(res[0]) if res else DEFAULT_UNRANKED_THRESHOLD

                # Lues avant le DELETE.
                cur.execute("SELECT date, session_id, ligue_id FROM Tournois WHERE id = %s", (id,))
                row_tournoi = cur.fetchone()
                if row_tournoi is None:
                    return jsonify({"error": "Tournoi introuvable."}), 404
                tdate, tsession, tligue = row_tournoi

                # On retire la penalite plutot que de restaurer old_sigma (ce
                # tournoi n'est pas forcement le dernier).
                cur.execute("""
                    SELECT joueur_id, SUM(penalty_applied) FROM ghost_log
                    WHERE tournoi_id = %s GROUP BY joueur_id
                """, (id,))
                ghost_rows = cur.fetchall()
                if ghost_rows:
                    psycopg2.extras.execute_values(cur, """
                        UPDATE Joueurs AS j SET sigma = GREATEST(j.sigma - data.retrait, 0.001)
                        FROM (VALUES %s) AS data(id, retrait)
                        WHERE j.id = data.id
                    """, [(pid, float(retrait)) for pid, retrait in ghost_rows])

                cur.execute("SELECT joueur_id FROM Participations WHERE tournoi_id = %s", (id,))
                parts = [r[0] for r in cur.fetchall()]
                # Les joueurs ayant rejoue depuis ont deja un compteur remis a 0.
                cur.execute("SELECT DISTINCT joueur_id FROM Participations WHERE tournoi_id > %s",
                            (id,))
                ont_rejoue = [r[0] for r in cur.fetchall()]
                if not session_a_un_autre_tournoi(cur, tsession, id, tligue):
                    annuler_absences(cur, parts + ont_rejoue, threshold)

                # Avant le DELETE.
                audit.ecrire(cur, 'tournoi_supprime', 'tournoi', id, {
                    "date": str(tdate), "nb_participants": len(parts),
                    "session_id": tsession,
                    "scores_restaures": False,
                })
                cur.execute("DELETE FROM Tournois WHERE id = %s", (id,))
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

    # Couleurs au format #RRGGBB, verifiees avant toute ecriture.
    for l_data in ligues_data:
        couleur = couleur_valide(l_data.get('couleur', '#FFFFFF'))
        if couleur is None:
            return _valeur_invalide('couleur')
        l_data['couleur'] = couleur

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

                # Meme action que les cles de mode ligue d'update_config.
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
