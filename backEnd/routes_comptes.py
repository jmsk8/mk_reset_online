"""Liaison compte <-> joueur, synchronisation des profils, gestion des roles."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import re
import time
import secrets
from datetime import datetime, timedelta, timezone

import requests

from flask import (Blueprint, jsonify, request, g, make_response,
                   Response, stream_with_context)

import audit

from constants import (ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN, ROLE_HIERARCHY,
                       CGU_VERSION, PERMISSIONS_CATALOGUE, SOUS_PERMISSIONS,
                       DEFAULT_MU, DEFAULT_SIGMA, DISCORD_HTTP_TIMEOUT,
                       AVATAR_CACHE_TTL, AVATAR_MAX_BYTES,
                       PROMOTION_LIFETIME_DAYS, CGU_ADMIN_VERSION)
from auth import (player_required, player_required_sans_cgu, role_required,
                 permission_required, compte_cible_protegee, permissions_delegables_par,
                 refuse_auto_modification, refus_de_rang, hors_de_portee)
from auth_discord import avatar_url, hash_token
from cache import invalidate_cache
from services import (construire_lobbies, resoudre_joueurs_matchmaking,
                      purger_donnees_expirees, nom_creable, empreinte_nom)
from utils import RE_COULEUR
from db import get_db_connection

logger = logging.getLogger(__name__)

comptes_bp = Blueprint('comptes', __name__)


_audit = audit.ecrire
_acteur_id = audit.acteur_courant


def notifier(cur, compte_id, type_notif, titre, corps=None, lien=None):
    """Depose une notification, dans la transaction de la decision.

    Le texte et le lien sont figes a la creation.
    """
    if compte_id is None:
        return
    cur.execute(
        """INSERT INTO notifications (compte_id, type, titre, corps, lien)
           VALUES (%s, %s, %s, %s, %s)""",
        (compte_id, type_notif[:40], titre[:160], corps, lien[:255] if lien else None),
    )


def _pseudo(username, global_name):
    """Nom affiche Discord, ou le handle a defaut."""
    return global_name or username


def _confirmation_handle_valide(saisie, handle):
    """Vrai si la saisie designe ce handle Discord (legs, suppression de compte).

    Tolere un « @ » initial, les espaces et la casse.
    """
    if not isinstance(saisie, str) or not handle:
        return False
    saisie = saisie.strip()
    if saisie.startswith('@'):
        saisie = saisie[1:].strip()
    return bool(saisie) and saisie.lower() == handle.lower()


def _nom_creable(cur, nom):
    """services.nom_creable en reponse Flask, pour les demandes de liaison."""
    nom, erreur = nom_creable(cur, nom)
    if erreur is None:
        return nom, None
    if erreur['code'] == 'nom_deja_pris':
        erreur['error'] = ("La fiche « %s » existe déjà : revendiquez-la au lieu d'en créer une."
                           % erreur['joueur_en_conflit']['nom'])
    return None, (jsonify(erreur), 409)


# ---------------------------------------------------------------------------
# Cote joueur : revendiquer une fiche
# ---------------------------------------------------------------------------

def notifier_tous(cur, type_notif, titre, corps=None, lien=None):
    """Notifie tous les comptes non suspendus. Renvoie leur nombre."""
    cur.execute(
        """INSERT INTO notifications (compte_id, type, titre, corps, lien)
           SELECT id, %s, %s, %s, %s FROM comptes WHERE statut <> 'suspended'""",
        (type_notif[:40], titre[:160], corps, lien[:255] if lien else None),
    )
    return cur.rowcount


@comptes_bp.route('/auth/joueurs-disponibles', methods=['GET'])
@player_required
def joueurs_disponibles():
    """Fiches revendicables : sans compte et non anonymisees."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT j.id, j.nom
                       FROM joueurs j
                       LEFT JOIN comptes c ON c.joueur_id = j.id
                       WHERE c.id IS NULL AND j.anonymise_at IS NULL
                       ORDER BY j.nom"""
                )
                rows = cur.fetchall()
    except Exception as e:
        logger.error("Liste des joueurs disponibles impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify([{"id": r[0], "nom": r[1]} for r in rows])


@comptes_bp.route('/auth/demande-liaison', methods=['POST'])
@player_required
def demander_liaison():
    data = request.get_json(silent=True) or {}
    joueur_id = data.get('joueur_id')
    message = (data.get('message') or '')[:500] or None

    # bool exclu : isinstance(True, int) est vrai.
    if not isinstance(joueur_id, int) or isinstance(joueur_id, bool):
        return jsonify({"error": "Joueur manquant", "code": "joueur_manquant"}), 400

    compte = g.compte
    if compte['joueur_id'] is not None:
        return jsonify({"error": "Ce compte est déjà rattaché", "code": "deja_lie"}), 409

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT nom FROM joueurs WHERE id = %s AND anonymise_at IS NULL",
                        (joueur_id,),
                    )
                    row = cur.fetchone()
                    if row is None:
                        conn.rollback()
                        return jsonify({"error": "Joueur introuvable"}), 404

                    cur.execute("SELECT 1 FROM comptes WHERE joueur_id = %s", (joueur_id,))
                    if cur.fetchone() is not None:
                        conn.rollback()
                        return jsonify({
                            "error": "Cette fiche est déjà rattachée à un compte",
                            "code": "joueur_deja_pris",
                        }), 409

                    # Evite un 500 sur les index uniques partiels.
                    cur.execute(
                        "SELECT id FROM liaisons_demandes WHERE compte_id = %s AND statut = 'pending'",
                        (compte['id'],),
                    )
                    if cur.fetchone() is not None:
                        conn.rollback()
                        return jsonify({
                            "error": "Vous avez déjà une demande en cours",
                            "code": "demande_en_cours",
                        }), 409

                    cur.execute(
                        "SELECT id FROM liaisons_demandes WHERE joueur_id = %s AND statut = 'pending'",
                        (joueur_id,),
                    )
                    if cur.fetchone() is not None:
                        conn.rollback()
                        return jsonify({
                            "error": "Une demande est déjà en attente sur cette fiche",
                            "code": "joueur_revendique",
                        }), 409

                    cur.execute(
                        """INSERT INTO liaisons_demandes (compte_id, joueur_id, message)
                           VALUES (%s, %s, %s) RETURNING id""",
                        (compte['id'], joueur_id, message),
                    )
                    demande_id = cur.fetchone()[0]
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Creation de demande de liaison impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({"status": "success", "id": demande_id}), 201


@comptes_bp.route('/auth/demande-creation', methods=['POST'])
@player_required
def demander_creation():
    """Demande la creation d'une fiche au nom du compte connecte.

    Le nom est fige dans nom_demande ; rien n'est cree avant l'accord d'un admin.
    """
    compte = g.compte
    if compte['joueur_id'] is not None:
        return jsonify({"error": "Ce compte est déjà rattaché", "code": "deja_lie"}), 409

    message = ((request.get_json(silent=True) or {}).get('message') or '')[:500] or None
    voulu = _pseudo(compte['discord_username'], compte['discord_global_name'])

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    nom, erreur = _nom_creable(cur, voulu)
                    if erreur is not None:
                        conn.rollback()
                        return erreur

                    # Evite un 500 sur l'index unique partiel.
                    cur.execute(
                        "SELECT id FROM liaisons_demandes WHERE compte_id = %s AND statut = 'pending'",
                        (compte['id'],),
                    )
                    if cur.fetchone() is not None:
                        conn.rollback()
                        return jsonify({
                            "error": "Vous avez déjà une demande en cours",
                            "code": "demande_en_cours",
                        }), 409

                    cur.execute(
                        """INSERT INTO liaisons_demandes (compte_id, nom_demande, message)
                           VALUES (%s, %s, %s) RETURNING id""",
                        (compte['id'], nom, message),
                    )
                    demande_id = cur.fetchone()[0]
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Creation de demande de fiche impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({"status": "success", "id": demande_id, "nom_demande": nom}), 201


@comptes_bp.route('/auth/ma-demande', methods=['GET'])
@player_required
def ma_demande():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    # LEFT JOIN : une demande de creation n'a pas de joueur.
                    """SELECT d.id, d.joueur_id, j.nom, d.statut, d.message, d.created_at,
                              d.decided_at, d.nom_demande
                       FROM liaisons_demandes d
                       LEFT JOIN joueurs j ON j.id = d.joueur_id
                       WHERE d.compte_id = %s
                       ORDER BY d.created_at DESC LIMIT 1""",
                    (g.compte['id'],),
                )
                row = cur.fetchone()
    except Exception as e:
        logger.error("Lecture de la demande impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    if row is None:
        return jsonify({"demande": None})
    return jsonify({"demande": {
        "id": row[0], "joueur_id": row[1], "joueur_nom": row[2], "statut": row[3],
        "message": row[4], "created_at": row[5].isoformat(),
        "decided_at": row[6].isoformat() if row[6] else None,
        "nom_demande": row[7],
        "type": 'creation' if row[1] is None else 'rattachement',
    }})


@comptes_bp.route('/auth/demande-liaison', methods=['DELETE'])
@player_required
def annuler_demande():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM liaisons_demandes WHERE compte_id = %s AND statut = 'pending'",
                    (g.compte['id'],),
                )
                supprimees = cur.rowcount
            conn.commit()
    except Exception as e:
        logger.error("Annulation de demande impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    if supprimees == 0:
        return jsonify({"error": "Aucune demande en cours"}), 404
    return jsonify({"status": "success"})


# ---------------------------------------------------------------------------
# Cote admin : file d'attente des liaisons
# ---------------------------------------------------------------------------

@comptes_bp.route('/admin/liaisons', methods=['GET'])
@permission_required('gestion_liaisons')
def lister_liaisons():
    statut = request.args.get('statut', 'pending')
    if statut not in ('pending', 'approved', 'rejected', 'all'):
        return jsonify({"error": "Statut invalide"}), 400

    requete = """
        SELECT d.id, d.statut, d.message, d.created_at, d.decided_at,
               c.id, c.discord_id, c.discord_username, c.discord_global_name,
               c.discord_avatar_hash, c.statut,
               j.id, j.nom,
               i.joueur_id,
               d.nom_demande,
               c.role
        FROM liaisons_demandes d
        JOIN comptes c ON c.id = d.compte_id
        -- LEFT JOIN : une demande de creation n'a pas encore de fiche. Avec un
        -- INNER JOIN elle n'apparaitrait dans aucune file d'attente, et
        -- personne ne pourrait jamais l'approuver.
        LEFT JOIN joueurs j ON j.id = d.joueur_id
        LEFT JOIN invitations i ON i.id = c.invitation_id
    """
    params = []
    if statut != 'all':
        requete += " WHERE d.statut = %s"
        params.append(statut)
    requete += " ORDER BY d.created_at ASC"

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(requete, params)
                rows = cur.fetchall()
    except Exception as e:
        logger.error("Liste des liaisons impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    superadmin = g.compte['role'] == ROLE_SUPERADMIN
    return jsonify([{
        "id": r[0], "statut": r[1], "message": r[2],
        "created_at": r[3].isoformat(),
        "decided_at": r[4].isoformat() if r[4] else None,
        "compte": {
            "id": r[5], "discord_id": r[6],
            "pseudo": _pseudo(r[7], r[8]),
            "avatar_url": "/avatar/compte/%d" % r[5],
            "statut": r[10],
        },
        "type": 'creation' if r[11] is None else 'rattachement',
        "joueur": {"id": r[11], "nom": r[12]} if r[11] is not None else None,
        "nom_demande": r[14],
        # Joueur vise par l'invitation nominative, a comparer a la demande.
        "joueur_vise_par_invitation": r[13],
        "concordance_invitation": (r[13] is not None and r[13] == r[11]),
        # Pour griser les boutons a l'avance.
        "hors_de_portee": (not superadmin or r[5] != g.compte['id'])
                          and hors_de_portee(g.compte['role'], r[15]),
        "est_moi": r[5] == g.compte['id'] and not superadmin,
    } for r in rows])


def _statue_sur_soi(compte_id: int):
    """True si l'acteur statue sur sa propre demande (permis au superadmin
    seulement), False s'il s'agit de celle d'un autre, None s'il doit etre refuse."""
    if compte_id != _acteur_id():
        return False
    return True if g.compte['role'] == ROLE_SUPERADMIN else None


@comptes_bp.route('/admin/liaisons/<int:demande_id>/approve', methods=['POST'])
@permission_required('gestion_liaisons')
def approuver_liaison(demande_id):
    """Approuve une revendication et rattache le compte au joueur.

    Une fiche a creer l'est dans la meme transaction. Le pseudo n'est pas
    synchronise (voir /sync).
    """
    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """SELECT d.compte_id, d.joueur_id, d.statut, d.nom_demande
                           FROM liaisons_demandes d WHERE d.id = %s FOR UPDATE""",
                        (demande_id,),
                    )
                    row = cur.fetchone()
                    if row is None:
                        conn.rollback()
                        return jsonify({"error": "Demande introuvable"}), 404
                    compte_id, joueur_id, statut, nom_demande = row
                    if statut != 'pending':
                        conn.rollback()
                        return jsonify({
                            "error": "Cette demande a déjà été traitée",
                            "code": "deja_traitee",
                        }), 409

                    # On ne valide pas sa propre demande (sauf superadmin).
                    soi = _statue_sur_soi(compte_id)
                    if soi is None:
                        conn.rollback()
                        return refuse_auto_modification(_acteur_id(), compte_id)

                    # Lu sous verrou : l'approbation ne doit pas lever une suspension.
                    cur.execute("SELECT statut, role FROM comptes WHERE id = %s FOR UPDATE",
                                (compte_id,))
                    ligne_compte = cur.fetchone()
                    if ligne_compte is None:
                        conn.rollback()
                        return jsonify({"error": "Compte introuvable"}), 404
                    # Regle de rang sur le compte demandeur (sauf sur soi).
                    refus = None if soi else refus_de_rang(g.compte, compte_id, ligne_compte[1])
                    if refus is not None:
                        conn.rollback()
                        return refus
                    if ligne_compte[0] == 'suspended':
                        conn.rollback()
                        return jsonify({
                            "error": "Ce compte est suspendu : sa demande ne peut pas être "
                                     "approuvée tant qu'il n'est pas réactivé.",
                            "code": "compte_suspendu",
                        }), 409

                    creation = joueur_id is None
                    if creation:
                        # Revalide : la fiche a pu etre creee entre-temps.
                        nom, erreur = _nom_creable(cur, nom_demande)
                        if erreur is not None:
                            conn.rollback()
                            return erreur
                        cur.execute(
                            """INSERT INTO joueurs (nom, mu, sigma, tier, is_ranked)
                               VALUES (%s, %s, %s, 'U', true) RETURNING id""",
                            (nom, DEFAULT_MU, DEFAULT_SIGMA),
                        )
                        joueur_id = cur.fetchone()[0]
                        nom_final = nom
                        _audit(cur, 'joueur_cree', 'joueur', joueur_id,
                               {"nom": nom, "compte_id": compte_id, "demande_id": demande_id})
                    else:
                        cur.execute("SELECT nom FROM joueurs WHERE id = %s", (joueur_id,))
                        ligne_nom = cur.fetchone()
                        nom_final = ligne_nom[0] if ligne_nom else '?'

                    cur.execute(
                        "SELECT id FROM comptes WHERE joueur_id = %s FOR UPDATE",
                        (joueur_id,),
                    )
                    occupant = cur.fetchone()
                    if occupant is not None and occupant[0] != compte_id:
                        # Relache le verrou pose sur la fiche.
                        conn.rollback()
                        return jsonify({
                            "error": "Cette fiche vient d'être rattachée à un autre compte",
                            "code": "joueur_deja_pris",
                        }), 409

                    cur.execute(
                        """UPDATE comptes SET joueur_id = %s, statut = 'linked', updated_at = now()
                           WHERE id = %s""",
                        (joueur_id, compte_id),
                    )
                    cur.execute(
                        """UPDATE liaisons_demandes
                           SET statut = 'approved', decided_at = now(), decided_by = %s
                           WHERE id = %s""",
                        (_acteur_id(), demande_id),
                    )
                    _audit(cur, 'liaison_approuvee', 'compte', compte_id,
                           {"joueur_id": joueur_id, "demande_id": demande_id,
                            "fiche_creee": creation, "sur_soi": soi})
                    notifier(
                        cur, compte_id, 'liaison_approuvee',
                        "Votre compte est synchronisé",
                        ("La fiche « %s » vient d'être créée et rattachée à votre compte."
                         if creation else
                         "Votre compte est désormais rattaché à la fiche « %s ».")
                        % nom_final,
                        lien="/joueur/%d" % joueur_id,
                    )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Approbation de liaison %s impossible: %s", demande_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    if creation:
        # La nouvelle fiche doit apparaitre tout de suite au classement.
        invalidate_cache()
    return jsonify({"status": "success", "compte_id": compte_id,
                    "joueur_id": joueur_id, "fiche_creee": creation})


@comptes_bp.route('/admin/liaisons/<int:demande_id>/reject', methods=['POST'])
@permission_required('gestion_liaisons')
def refuser_liaison(demande_id):
    motif = ((request.get_json(silent=True) or {}).get('motif') or '')[:500] or None
    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT compte_id, joueur_id, statut FROM liaisons_demandes WHERE id = %s FOR UPDATE",
                        (demande_id,),
                    )
                    row = cur.fetchone()
                    if row is None:
                        conn.rollback()
                        return jsonify({"error": "Demande introuvable"}), 404
                    compte_id, joueur_id, statut = row
                    if statut != 'pending':
                        conn.rollback()
                        return jsonify({"error": "Déjà traitée", "code": "deja_traitee"}), 409

                    # On ne statue pas sur sa propre demande (sauf superadmin).
                    soi = _statue_sur_soi(compte_id)
                    if soi is None:
                        conn.rollback()
                        return refuse_auto_modification(_acteur_id(), compte_id)

                    # Meme regle de rang que l'approbation.
                    cur.execute("SELECT role FROM comptes WHERE id = %s", (compte_id,))
                    ligne_compte = cur.fetchone()
                    if ligne_compte is not None and not soi:
                        refus = refus_de_rang(g.compte, compte_id, ligne_compte[0])
                        if refus is not None:
                            conn.rollback()
                            return refus

                    cur.execute(
                        """UPDATE liaisons_demandes
                           SET statut = 'rejected', decided_at = now(), decided_by = %s
                           WHERE id = %s""",
                        (_acteur_id(), demande_id),
                    )
                    _audit(cur, 'liaison_refusee', 'compte', compte_id,
                           {"joueur_id": joueur_id, "demande_id": demande_id, "motif": motif,
                            "sur_soi": soi})
                    notifier(
                        cur, compte_id, 'liaison_refusee',
                        "Votre demande a été refusée",
                        ("Motif : " + motif) if motif
                        else "Aucun motif n'a été précisé. Contactez un administrateur.",
                        lien="/mon-compte/liaison",
                    )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Refus de liaison %s impossible: %s", demande_id, e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success"})


# ---------------------------------------------------------------------------
# Cote admin : comptes, synchronisation, roles
# ---------------------------------------------------------------------------

@comptes_bp.route('/admin/comptes', methods=['GET'])
@permission_required('gestion_comptes')
def lister_comptes():
    """Liste des comptes, avec l'ecart entre pseudo Discord et nom du joueur."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT c.id, c.discord_id, c.discord_username, c.discord_global_name,
                              c.discord_avatar_hash, c.joueur_id, c.statut, c.role,
                              c.created_at, c.last_login_at, c.profil_synced_at,
                              j.nom, p.role_propose,
                              -- Le compte a-t-il AGI au moins une fois ? C'est ce
                              -- que montre son volet « Logs » (les actions dont
                              -- il est l'acteur), donc ce qui decide d'afficher
                              -- le bouton : un joueur qui n'a jamais ete admin
                              -- n'a rien a montrer. Un EXISTS par ligne, servi
                              -- par idx_audit_admin_acteur sans lire la table.
                              EXISTS (SELECT 1 FROM audit_admin a
                                      WHERE a.acteur_compte_id = c.id)
                       FROM comptes c
                       LEFT JOIN joueurs j ON j.id = c.joueur_id
                       -- La proposition en attente vient par JOINTURE et non par
                       -- une seconde requete : le badge doit etre la des le
                       -- premier rendu, sinon il apparait apres coup sur une
                       -- ligne qu'on est peut-etre deja en train de modifier.
                       -- Les propositions EXPIREES sont exclues ici : elles
                       -- restent en base pour l'historique, mais n'affichent
                       -- plus rien.
                       LEFT JOIN promotions_proposees p
                              ON p.compte_id = c.id AND p.statut = 'pending'
                             AND p.expires_at > now()
                       ORDER BY c.created_at DESC"""
                )
                rows = cur.fetchall()
    except Exception as e:
        logger.error("Liste des comptes impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    comptes = []
    for r in rows:
        pseudo = _pseudo(r[2], r[3])
        nom_joueur = r[11]
        comptes.append({
            "id": r[0], "discord_id": r[1], "pseudo": pseudo,
            # Handle Discord, demande en confirmation du legs et de la suppression.
            "handle": r[2],
            "avatar_url": "/avatar/compte/%d" % r[0],
            "joueur_id": r[5], "joueur_nom": nom_joueur,
            "statut": r[6], "role": r[7],
            "created_at": r[8].isoformat(),
            "last_login_at": r[9].isoformat() if r[9] else None,
            "profil_synced_at": r[10].isoformat() if r[10] else None,
            "desynchronise": bool(nom_joueur and pseudo and nom_joueur != pseudo),
            # Role propose et non encore accepte, ou None.
            "promotion_en_attente": r[12],
            # Ce compte a des lignes de journal que le lecteur peut consulter.
            "a_un_journal": bool(r[13]) and _peut_lire_journal(g.compte, r[7]),
        })
    return jsonify(comptes)


def _verifier_sync(cur, compte_id):
    """Prepare une synchronisation. Renvoie (donnees, reponse d'erreur).

    Utilise par l'apercu et l'ecriture, pour un verdict identique.
    """
    cur.execute(
        """SELECT c.discord_username, c.discord_global_name, c.joueur_id, j.nom
           FROM comptes c LEFT JOIN joueurs j ON j.id = c.joueur_id
           WHERE c.id = %s""",
        (compte_id,),
    )
    row = cur.fetchone()
    if row is None:
        return None, (jsonify({"error": "Compte introuvable"}), 404)

    username, global_name, joueur_id, nom_actuel = row
    if joueur_id is None:
        return None, (jsonify({
            "error": "Ce compte n'est rattaché à aucune fiche joueur",
            "code": "non_lie",
        }), 409)

    nouveau = (_pseudo(username, global_name) or '').strip()
    if not nouveau:
        return None, (jsonify({
            "error": "Le pseudo Discord est vide", "code": "pseudo_vide",
        }), 409)

    # joueurs.nom est en varchar(255).
    nouveau = nouveau[:255]

    if '/' in nouveau:
        # Flask ne route pas un nom contenant un slash (/stats/joueur/<nom>).
        return None, (jsonify({
            "error": "Le pseudo Discord contient un « / », incompatible avec l'URL publique",
            "code": "pseudo_invalide",
        }), 409)

    if nouveau == nom_actuel:
        return None, (jsonify({
            "error": "Le nom du joueur est déjà à jour", "code": "deja_synchro",
        }), 409)

    # Un pseudo identique a une identite anonymisee est refuse.
    cur.execute("SELECT 1 FROM noms_interdits WHERE nom_hash = %s", (empreinte_nom(nouveau),))
    if cur.fetchone() is not None:
        return None, (jsonify({
            "error": "Ce pseudo correspond à une identité retirée et ne peut pas devenir "
                     "le nom d'une fiche. Modifiez le nom à la main.",
            "code": "nom_interdit",
        }), 409)

    # La contrainte UNIQUE est sensible a la casse.
    cur.execute(
        "SELECT id, nom FROM joueurs WHERE lower(nom) = lower(%s) AND id <> %s",
        (nouveau, joueur_id),
    )
    collision = cur.fetchone()
    if collision is not None:
        return None, (jsonify({
            "error": "Un autre joueur porte déjà ce nom (%s). Renommez-le d'abord, "
                     "ou modifiez le nom à la main." % collision[1],
            "code": "collision_nom",
            "joueur_en_conflit": {"id": collision[0], "nom": collision[1]},
        }), 409)

    return {
        "joueur_id": joueur_id,
        "ancien_nom": nom_actuel,
        "nouveau_nom": nouveau,
    }, None


@comptes_bp.route('/admin/comptes/<int:compte_id>/sync-preview', methods=['GET'])
@permission_required('gestion_comptes')
def apercu_sync(compte_id):
    """Avant/apres, sans rien ecrire."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                donnees, erreur = _verifier_sync(cur, compte_id)
    except Exception as e:
        logger.error("Apercu de synchronisation impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    if erreur is not None:
        return erreur
    return jsonify(donnees)


@comptes_bp.route('/admin/comptes/<int:compte_id>/sync', methods=['POST'])
@permission_required('gestion_comptes')
@compte_cible_protegee
def synchroniser_profil(compte_id):
    """Propage le pseudo Discord vers joueurs.nom (geste admin, jamais automatique)."""
    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    donnees, erreur = _verifier_sync(cur, compte_id)
                    if erreur is not None:
                        conn.rollback()
                        return erreur

                    cur.execute(
                        "UPDATE joueurs SET nom = %s WHERE id = %s",
                        (donnees['nouveau_nom'], donnees['joueur_id']),
                    )
                    cur.execute(
                        "UPDATE comptes SET profil_synced_at = now(), updated_at = now() WHERE id = %s",
                        (compte_id,),
                    )
                    _audit(cur, 'profil_synchro', 'joueur', donnees['joueur_id'], {
                        "compte_id": compte_id,
                        "ancien": donnees['ancien_nom'],
                        "nouveau": donnees['nouveau_nom'],
                    })
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Synchronisation du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    # Le classement doit afficher le nouveau nom tout de suite.
    invalidate_cache()
    return jsonify({"status": "success", **donnees})


@comptes_bp.route('/admin/comptes/<int:compte_id>/role', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
@compte_cible_protegee
def changer_role(compte_id):
    """Retire un role ou le fait descendre (chef_admin et superadmin).

    Ne promeut jamais : une montee en rang passe par proposer_promotion et
    l'acceptation de la personne. Ne pose jamais superadmin (voir le legs).
    Le dernier superadmin ne peut pas etre retire.
    """
    acteur = g.compte
    acteur_est_superadmin = acteur['role'] == ROLE_SUPERADMIN

    corps = request.get_json(silent=True) or {}
    nouveau = corps.get('role')
    if nouveau not in ROLE_HIERARCHY:
        return jsonify({
            "error": "Rôle invalide", "code": "role_invalide",
            "roles": sorted(ROLE_HIERARCHY, key=ROLE_HIERARCHY.get),
        }), 400

    # Le role superadmin se legue, il ne s'attribue pas.
    if nouveau == ROLE_SUPERADMIN:
        return jsonify({
            "error": "Le rôle superadmin ne s'attribue pas : il se lègue.",
            "code": "superadmin_non_attribuable",
        }), 400

    # Seul le superadmin designe un chef_admin.
    if nouveau == ROLE_CHEF_ADMIN and not acteur_est_superadmin:
        return jsonify({
            "error": "Seul le super-administrateur peut désigner un chef d'administration.",
            "code": "droits_insuffisants",
        }), 403

    # Pas de modification de son propre role (le superadmin passe par le legs).
    erreur = refuse_auto_modification(_acteur_id(), compte_id)
    if erreur is not None:
        return erreur

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT role FROM comptes WHERE id = %s FOR UPDATE", (compte_id,))
                    row = cur.fetchone()
                    if row is None:
                        conn.rollback()
                        return jsonify({"error": "Compte introuvable"}), 404
                    ancien = row[0]
                    if ancien == nouveau:
                        conn.rollback()
                        return jsonify({"status": "success", "role": nouveau, "inchange": True})

                    # Cette route ne fait que descendre : une montee passe par une
                    # proposition acceptee par la personne (/promotion).
                    if ROLE_HIERARCHY[nouveau] > ROLE_HIERARCHY[ancien]:
                        conn.rollback()
                        return jsonify({
                            "error": "Une promotion ne s'impose pas : proposez le rôle, "
                                     "la personne l'acceptera depuis son compte.",
                            "code": "promotion_par_proposition",
                        }), 409

                    # Garde-fou : normalement deja bloque par compte_cible_protegee
                    # et refuse_auto_modification.
                    if ancien == ROLE_SUPERADMIN and nouveau != ROLE_SUPERADMIN:
                        cur.execute(
                            "SELECT COUNT(*) FROM comptes WHERE role = %s AND id <> %s",
                            (ROLE_SUPERADMIN, compte_id),
                        )
                        if cur.fetchone()[0] == 0:
                            conn.rollback()
                            return jsonify({
                                "error": "C'est le dernier super-administrateur. Le rétrograder "
                                         "rendrait toute attribution de rôle impossible, et il "
                                         "n'existe pas de mot de passe de secours. Promouvez "
                                         "d'abord un autre compte.",
                                "code": "dernier_superadmin",
                            }), 409

                    # Retirer le dernier chef_admin exige une confirmation explicite.
                    if ancien == ROLE_CHEF_ADMIN and nouveau != ROLE_CHEF_ADMIN:
                        cur.execute(
                            "SELECT COUNT(*) FROM comptes WHERE role = %s AND id <> %s",
                            (ROLE_CHEF_ADMIN, compte_id),
                        )
                        if (cur.fetchone()[0] == 0
                                and corps.get('confirmer_dernier_chef_admin') is not True):
                            conn.rollback()
                            return jsonify({
                                "error": "C'est le dernier chef d'administration. Sans lui, si le "
                                         "super-administrateur perd son accès, plus personne ne "
                                         "pourra administrer le site sans intervention en base. "
                                         "Confirmez pour continuer.",
                                "code": "dernier_chef_admin",
                            }), 409

                    cur.execute(
                        "UPDATE comptes SET role = %s, updated_at = now() WHERE id = %s",
                        (nouveau, compte_id),
                    )
                    # La duree de session depend du role : on ferme les sessions
                    # de la cible pour forcer une reconnexion.
                    cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s",
                                (compte_id,))
                    action = ('role_retire'
                              if ROLE_HIERARCHY[nouveau] < ROLE_HIERARCHY[ancien]
                              else 'role_attribue')
                    _audit(cur, action, 'compte', compte_id,
                           {"ancien": ancien, "nouveau": nouveau, "origine": "ihm"})

                    # Quitter le role admin purge les permissions a la carte.
                    if ancien == ROLE_ADMIN and nouveau != ROLE_ADMIN:
                        cur.execute("DELETE FROM permissions_admin WHERE compte_id = %s",
                                    (compte_id,))
                        if cur.rowcount:
                            _audit(cur, 'permissions_purgees', 'compte', compte_id,
                                   {"motif": "sortie_role_admin", "nouveau_role": nouveau})

                    # Les propositions recues ou faites par la cible n'ont plus d'objet.
                    _annuler_promotions(cur, 'cible_retrogradee', cible=compte_id)
                    _annuler_promotions(cur, 'proposant_retrograde', proposant=compte_id)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Changement de role du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    logger.info("Role du compte %s : %s -> %s (par %s)", compte_id, ancien, nouveau, _acteur_id())
    return jsonify({"status": "success", "ancien": ancien, "role": nouveau})


# ---------------------------------------------------------------------------
# Promotion : une proposition, pas un decret
# ---------------------------------------------------------------------------
# Le role d'admin se propose et s'accepte : les actions d'un admin sont
# tracees nominativement, il doit en etre informe avant.
#
#   player --propose--> proposition en attente --accepte--> admin/chef_admin
#                                              --refuse---> player (inchange)

def _promotion_en_attente(cur, compte_id, pour_update=False):
    """Proposition en attente et non expiree de ce compte, ou None."""
    cur.execute(
        """SELECT id, role_propose, propose_par, created_at, expires_at
           FROM promotions_proposees
           WHERE compte_id = %s AND statut = 'pending' AND expires_at > now()
           ORDER BY id DESC LIMIT 1""" + (" FOR UPDATE" if pour_update else ""),
        (compte_id,),
    )
    return cur.fetchone()


def _annuler_promotions(cur, motif, cible=None, proposant=None, role_propose=None):
    """Annule les propositions en attente devenues sans objet. Renvoie leur nombre.

    `cible` vise les propositions recues par un compte, `proposant` celles qu'il
    a faites ; `role_propose` restreint a un role. Chaque annulation est tracee.
    """
    conditions, params = ["statut = 'pending'", "expires_at > now()"], []
    if cible is not None:
        conditions.append("compte_id = %s")
        params.append(cible)
    if proposant is not None:
        conditions.append("propose_par = %s")
        params.append(proposant)
    if role_propose is not None:
        conditions.append("role_propose = %s")
        params.append(role_propose)
    # Toujours au moins un filtre de compte.
    if cible is None and proposant is None:
        raise ValueError("_annuler_promotions exige une cible ou un proposant")
    cur.execute(
        "UPDATE promotions_proposees SET statut = 'cancelled', decided_at = now() "
        "WHERE " + " AND ".join(conditions) + " RETURNING id, compte_id, role_propose",
        tuple(params),
    )
    annulees = cur.fetchall()
    for promotion_id, compte_id, role in annulees:
        _audit(cur, 'promotion_annulee', 'compte', compte_id,
               {"role_propose": role, "promotion_id": promotion_id, "motif": motif})
    return len(annulees)


@comptes_bp.route('/admin/comptes/<int:compte_id>/promotion', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
@compte_cible_protegee
def proposer_promotion(compte_id):
    """Propose un role a un compte, qui decide. Memes plafonds que changer_role."""
    acteur = g.compte
    corps = request.get_json(silent=True) or {}
    role = corps.get('role')

    if role not in (ROLE_ADMIN, ROLE_CHEF_ADMIN):
        return jsonify({
            "error": "Seuls les rôles admin et chef_admin se proposent.",
            "code": "role_non_proposable",
        }), 400

    if role == ROLE_CHEF_ADMIN and acteur['role'] != ROLE_SUPERADMIN:
        return jsonify({
            "error": "Seul le super-administrateur peut désigner un chef d'administration.",
            "code": "droits_insuffisants",
        }), 403

    erreur = refuse_auto_modification(_acteur_id(), compte_id)
    if erreur is not None:
        return erreur

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    # Verrou des la lecture : serialise deux propositions simultanees.
                    cur.execute("SELECT role, statut FROM comptes WHERE id = %s FOR UPDATE",
                                (compte_id,))
                    row = cur.fetchone()
                    if row is None:
                        conn.rollback()
                        return jsonify({"error": "Compte introuvable"}), 404
                    role_actuel, statut = row

                    if role_actuel == role:
                        conn.rollback()
                        return jsonify({
                            "error": "Ce compte porte déjà ce rôle.",
                            "code": "role_inchange",
                        }), 409

                    # Une descente ne se propose pas, elle passe par /role.
                    if ROLE_HIERARCHY[role] < ROLE_HIERARCHY[role_actuel]:
                        conn.rollback()
                        return jsonify({
                            "error": "Ce n'est pas une promotion : changez le rôle "
                                     "directement.",
                            "code": "pas_une_promotion",
                        }), 409

                    # Un compte suspendu ne pourrait jamais accepter.
                    if statut == 'suspended':
                        conn.rollback()
                        return jsonify({
                            "error": "Ce compte est suspendu : il ne pourrait pas accepter.",
                            "code": "compte_suspendu",
                        }), 409

                    if _promotion_en_attente(cur, compte_id, pour_update=True):
                        conn.rollback()
                        return jsonify({
                            "error": "Une proposition est déjà en attente pour ce compte.",
                            "code": "promotion_deja_en_attente",
                        }), 409

                    # Solde les propositions perimees, qui bloqueraient l'index unique.
                    cur.execute(
                        """UPDATE promotions_proposees SET statut = 'cancelled', decided_at = now()
                           WHERE compte_id = %s AND statut = 'pending' AND expires_at <= now()""",
                        (compte_id,),
                    )

                    cur.execute(
                        """INSERT INTO promotions_proposees
                               (compte_id, role_propose, propose_par, expires_at)
                           VALUES (%s, %s, %s, now() + make_interval(days => %s))
                           RETURNING id, expires_at""",
                        (compte_id, role, _acteur_id(), PROMOTION_LIFETIME_DAYS),
                    )
                    promotion_id, expires_at = cur.fetchone()

                    _audit(cur, 'promotion_proposee', 'compte', compte_id,
                           {"role_propose": role, "promotion_id": promotion_id})
                    notifier(
                        cur, compte_id, 'promotion_proposee',
                        "Proposition : devenir %s" % role,
                        "Un administrateur vous propose ce rôle. Ouvrez votre compte "
                        "pour l'accepter ou le refuser.",
                        lien="/mon-compte#bloc-promotion",
                    )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Proposition de promotion pour %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    logger.info("Promotion %s proposee au compte %s (par %s)", role, compte_id, _acteur_id())
    return jsonify({"status": "success", "role_propose": role,
                    "expires_at": expires_at.isoformat()})


@comptes_bp.route('/admin/comptes/<int:compte_id>/promotion', methods=['DELETE'])
@role_required(ROLE_CHEF_ADMIN)
@compte_cible_protegee
def annuler_promotion(compte_id):
    """Retire une proposition en attente."""
    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    ligne = _promotion_en_attente(cur, compte_id, pour_update=True)
                    if ligne is None:
                        conn.rollback()
                        return jsonify({
                            "error": "Aucune proposition en attente pour ce compte.",
                            "code": "aucune_promotion",
                        }), 404

                    # Un chef_admin n'annule pas la proposition d'un rang superieur.
                    if ligne[2] is not None:
                        cur.execute("SELECT role FROM comptes WHERE id = %s", (ligne[2],))
                        p = cur.fetchone()
                        if (p is not None and ROLE_HIERARCHY.get(p[0], 99)
                                > ROLE_HIERARCHY.get(g.compte['role'], 0)):
                            conn.rollback()
                            return jsonify({
                                "error": "Cette proposition a été faite par un rang supérieur "
                                         "au vôtre : seul lui peut la retirer.",
                                "code": "proposition_rang_superieur",
                            }), 403

                    cur.execute(
                        """UPDATE promotions_proposees
                           SET statut = 'cancelled', decided_at = now() WHERE id = %s""",
                        (ligne[0],),
                    )
                    _audit(cur, 'promotion_annulee', 'compte', compte_id,
                           {"role_propose": ligne[1], "promotion_id": ligne[0]})
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Annulation de promotion pour %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({"status": "success"})


@comptes_bp.route('/me/promotion', methods=['GET'])
@player_required
def ma_promotion():
    """Ce que le titulaire doit accepter : une proposition de role, ou le
    consentement manquant d'un admin deja en poste."""
    compte = g.compte
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                ligne = _promotion_en_attente(cur, compte['id'])
                cur.execute(
                    "SELECT cgu_admin_accepted_at, cgu_admin_version FROM comptes WHERE id = %s",
                    (compte['id'],),
                )
                accepte_le, version = cur.fetchone()
    except Exception as e:
        logger.error("Lecture de la promotion du compte %s impossible: %s", compte['id'], e)
        return jsonify({"error": "Service indisponible", "code": "indisponible"}), 503

    consentement_requis = (
        compte['role'] in (ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN)
        and version != CGU_ADMIN_VERSION
    )

    return jsonify({
        "proposition": {
            "role_propose": ligne[1],
            "propose_le": ligne[3].isoformat(),
            "expire_le": ligne[4].isoformat(),
        } if ligne else None,
        "consentement_requis": consentement_requis,
        "cgu_admin_version": CGU_ADMIN_VERSION,
        "cgu_admin_acceptee_le": accepte_le.isoformat() if accepte_le else None,
    })


@comptes_bp.route('/me/promotion', methods=['POST'])
@player_required
def repondre_promotion():
    """Accepte ou refuse la proposition ; le role est pose a l'acceptation.

    L'acceptation porte aussi `cgu_admin_version` : role et politique admin
    s'acceptent ensemble.
    """
    compte = g.compte
    corps = request.get_json(silent=True) or {}
    accepte = corps.get('accepte') is True

    if accepte and corps.get('cgu_admin_version') != CGU_ADMIN_VERSION:
        return jsonify({
            "error": "La politique administrateur doit être acceptée dans sa version courante.",
            "code": "version_cgu_admin",
            "attendue": CGU_ADMIN_VERSION,
        }), 400

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    # Verrou sur le compte d'abord, meme ordre que proposer_promotion.
                    cur.execute("SELECT role FROM comptes WHERE id = %s FOR UPDATE",
                                (compte['id'],))
                    row = cur.fetchone()
                    if row is None:
                        conn.rollback()
                        return jsonify({"error": "Compte introuvable"}), 404
                    role_actuel = row[0]

                    ligne = _promotion_en_attente(cur, compte['id'], pour_update=True)
                    if ligne is None:
                        conn.rollback()
                        return jsonify({
                            "error": "Aucune proposition en attente. Elle a pu expirer "
                                     "ou être annulée.",
                            "code": "aucune_promotion",
                        }), 409

                    promotion_id, role, proposant = ligne[0], ligne[1], ligne[2]

                    if not accepte:
                        cur.execute(
                            """UPDATE promotions_proposees
                               SET statut = 'refused', decided_at = now() WHERE id = %s""",
                            (promotion_id,),
                        )
                        _audit(cur, 'promotion_refusee', 'compte', compte['id'],
                               {"role_propose": role, "promotion_id": promotion_id})
                        # Pas de lien : simple accuse de reception.
                        notifier(
                            cur, proposant, 'promotion_refusee',
                            "Promotion refusée",
                            "%s a refusé le rôle %s. Son rôle reste inchangé."
                            % (_pseudo(compte['discord_username'],
                                       compte['discord_global_name']), role),
                        )
                        conn.commit()
                        logger.info("Promotion %s refusee par le compte %s", role, compte['id'])
                        return jsonify({"status": "success", "accepte": False})

                    # La proposition doit encore etre valable a l'acceptation :
                    # le proposant a toujours le rang requis, et c'est bien une
                    # montee. Proposant lu sans verrou pour eviter un interblocage.
                    seuil = ROLE_SUPERADMIN if role == ROLE_CHEF_ADMIN else ROLE_CHEF_ADMIN
                    rang_proposant = None
                    if proposant is not None:
                        cur.execute("SELECT role, statut FROM comptes WHERE id = %s",
                                    (proposant,))
                        p = cur.fetchone()
                        if p is not None and p[1] != 'suspended':
                            rang_proposant = ROLE_HIERARCHY.get(p[0], 0)
                    proposant_valide = (rang_proposant is not None
                                        and rang_proposant >= ROLE_HIERARCHY[seuil])
                    # Role inconnu : jamais une montee.
                    toujours_une_montee = (ROLE_HIERARCHY[role]
                                           > ROLE_HIERARCHY.get(role_actuel, 99))
                    if not (proposant_valide and toujours_une_montee):
                        cur.execute(
                            """UPDATE promotions_proposees
                               SET statut = 'cancelled', decided_at = now() WHERE id = %s""",
                            (promotion_id,),
                        )
                        _audit(cur, 'promotion_annulee', 'compte', compte['id'],
                               {"role_propose": role, "promotion_id": promotion_id,
                                "motif": ("proposant_sans_droit" if not proposant_valide
                                          else "plus_une_promotion")})
                        # Commit : la proposition est soldee.
                        conn.commit()
                        return jsonify({
                            "error": "Cette proposition n'est plus valable : la situation "
                                     "a changé depuis qu'elle a été faite.",
                            "code": "proposition_caduque",
                        }), 409

                    cur.execute(
                        """UPDATE promotions_proposees
                           SET statut = 'accepted', decided_at = now() WHERE id = %s""",
                        (promotion_id,),
                    )
                    cur.execute(
                        """UPDATE comptes
                           SET role = %s, cgu_admin_accepted_at = now(),
                               cgu_admin_version = %s, updated_at = now()
                           WHERE id = %s""",
                        (role, CGU_ADMIN_VERSION, compte['id']),
                    )
                    _enregistrer_consentement(cur, compte['id'], 'cgu_admin',
                                              CGU_ADMIN_VERSION, 'acceptation_promotion')
                    # Ferme toutes les sessions, y compris la courante : la
                    # personne se reconnecte avec une session d'admin.
                    cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s",
                                (compte['id'],))
                    _audit(cur, 'role_attribue', 'compte', compte['id'],
                           {"ancien": compte['role'], "nouveau": role,
                            "origine": "acceptation", "promotion_id": promotion_id,
                            "propose_par": proposant})

                    # Quitter le role admin purge les permissions a la carte.
                    if role_actuel == ROLE_ADMIN and role != ROLE_ADMIN:
                        cur.execute("DELETE FROM permissions_admin WHERE compte_id = %s",
                                    (compte['id'],))
                        if cur.rowcount:
                            _audit(cur, 'permissions_purgees', 'compte', compte['id'],
                                   {"motif": "sortie_role_admin", "nouveau_role": role})
                    # Pas de lien : simple accuse de reception.
                    notifier(
                        cur, proposant, 'promotion_acceptee',
                        "Promotion acceptée",
                        "%s a accepté le rôle %s."
                        % (_pseudo(compte['discord_username'],
                                   compte['discord_global_name']), role),
                    )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Reponse a la promotion du compte %s impossible: %s", compte['id'], e)
        return jsonify({"error": "Erreur serveur"}), 500

    logger.info("Promotion %s acceptee par le compte %s", role, compte['id'])
    # La session courante est fermee.
    return jsonify({"status": "success", "accepte": True, "role": role,
                    "session_fermee": True})


@comptes_bp.route('/me/cgu-admin', methods=['POST'])
@player_required
def accepter_cgu_admin():
    """Consentement d'un admin deja en poste (nouvelle version de la politique)."""
    compte = g.compte
    if compte['role'] not in (ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN):
        return jsonify({
            "error": "Ce consentement ne concerne que les administrateurs.",
            "code": "non_concerne",
        }), 403

    if (request.get_json(silent=True) or {}).get('version') != CGU_ADMIN_VERSION:
        return jsonify({
            "error": "Version de politique inattendue.",
            "code": "version_cgu_admin",
            "attendue": CGU_ADMIN_VERSION,
        }), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE comptes SET cgu_admin_accepted_at = now(),
                           cgu_admin_version = %s, updated_at = now()
                       WHERE id = %s""",
                    (CGU_ADMIN_VERSION, compte['id']),
                )
                _enregistrer_consentement(cur, compte['id'], 'cgu_admin',
                                          CGU_ADMIN_VERSION, 'regularisation_admin')
                _audit(cur, 'cgu_admin_acceptee', 'compte', compte['id'],
                       {"version": CGU_ADMIN_VERSION})
            conn.commit()
    except Exception as e:
        logger.error("Acceptation CGU admin du compte %s impossible: %s", compte['id'], e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({"status": "success", "cgu_admin_version": CGU_ADMIN_VERSION})



# ---------------------------------------------------------------------------
# Journal d'audit : lecture
# ---------------------------------------------------------------------------
# Le volet par compte, l'onglet complet et l'export partagent _lire_journal.

AUDIT_PAGE = 50
AUDIT_PAGE_MAX = 200


def _peut_lire_journal(acteur, cible_role):
    """Vrai si l'acteur peut lire le journal d'un compte de ce role.

        superadmin  -> tout le monde
        chef_admin  -> tout le monde sauf le superadmin (ses pairs compris)
        admin       -> personne
    """
    if acteur['role'] == ROLE_SUPERADMIN:
        return True
    if acteur['role'] == ROLE_CHEF_ADMIN:
        # Un role inconnu ne donne jamais acces.
        return cible_role not in (ROLE_SUPERADMIN, None) and cible_role in ROLE_HIERARCHY
    return False


def _lire_journal(cur, acteur, compte_id=None, avant_id=None, limite=AUDIT_PAGE):
    """Lignes du journal visibles par cet acteur, les plus recentes d'abord.

    `compte_id` restreint a un acteur ; `avant_id` pagine par curseur. Le
    filtre de rang est fait en SQL pour que la pagination reste juste.
    """
    conditions = []
    params = []

    # Chacun peut toujours lire ses propres lignes.
    ses_propres_lignes = compte_id is not None and compte_id == acteur['id']

    # Le superadmin lit tout, y compris les lignes d'acteurs supprimes.
    if acteur['role'] != ROLE_SUPERADMIN and not ses_propres_lignes:
        roles_lisibles = [r for r in ROLE_HIERARCHY
                          if _peut_lire_journal(acteur, r)]
        if not roles_lisibles:
            return []
        # Rang relu en base ; les lignes d'un compte supprime ne sont visibles
        # que du superadmin.
        conditions.append("c.role = ANY(%s)")
        params.append(roles_lisibles)

    if compte_id is not None:
        conditions.append("a.acteur_compte_id = %s")
        params.append(compte_id)

    if avant_id is not None:
        conditions.append("a.id < %s")
        params.append(avant_id)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    cur.execute(
        """SELECT a.id, a.action, a.acteur_compte_id, a.cible_type, a.cible_id,
                  a.details, a.created_at,
                  COALESCE(c.discord_global_name, c.discord_username)
           FROM audit_admin a
           LEFT JOIN comptes c ON c.id = a.acteur_compte_id
           %s
           ORDER BY a.id DESC
           LIMIT %%s""" % where,
        tuple(params) + (limite,),
    )
    return cur.fetchall()


def _ligne_journal(r):
    """Une ligne du journal prete a afficher (pseudo fige si le compte a ete supprime)."""
    details = r[5] or {}
    denorme = details.get('acteur') or {}
    return {
        "id": r[0],
        "action": r[1],
        "acteur_compte_id": r[2],
        "acteur_pseudo": r[7] or denorme.get('pseudo'),
        "acteur_supprime": r[2] is None,
        "acteur_role": denorme.get('role'),
        "cible_type": r[3],
        "cible_id": r[4],
        # Le bloc `acteur` est deja remonte en colonnes.
        "details": {k: v for k, v in details.items() if k != 'acteur'},
        "created_at": r[6].isoformat(),
    }


@comptes_bp.route('/admin/comptes/<int:compte_id>/audit', methods=['GET'])
@role_required(ROLE_CHEF_ADMIN)
def journal_du_compte(compte_id):
    """Actions d'administration d'un compte.

    Un compte hors de portee renvoie une liste vide plutot qu'un 403.
    """
    try:
        avant_id = request.args.get('avant_id', type=int)
        limite = min(request.args.get('limite', AUDIT_PAGE, type=int), AUDIT_PAGE_MAX)
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                lignes = _lire_journal(cur, g.compte, compte_id=compte_id,
                                       avant_id=avant_id, limite=limite)
    except Exception as e:
        logger.error("Lecture du journal du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    sorties = [_ligne_journal(r) for r in lignes]
    return jsonify({
        "lignes": sorties,
        # Curseur de la page suivante, ou None.
        "avant_id": sorties[-1]['id'] if len(sorties) == limite else None,
    })


@comptes_bp.route('/admin/audit', methods=['GET'])
@role_required(ROLE_CHEF_ADMIN)
def journal_complet():
    """Journal complet (onglet Logs), avec le meme filtre de rang."""
    try:
        avant_id = request.args.get('avant_id', type=int)
        limite = min(request.args.get('limite', AUDIT_PAGE, type=int), AUDIT_PAGE_MAX)
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                lignes = _lire_journal(cur, g.compte, avant_id=avant_id, limite=limite)
    except Exception as e:
        logger.error("Lecture du journal complet impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    sorties = [_ligne_journal(r) for r in lignes]
    return jsonify({
        "lignes": sorties,
        "avant_id": sorties[-1]['id'] if len(sorties) == limite else None,
    })


# Prefixes interpretes comme formules par les tableurs : on ajoute une apostrophe.
_CSV_DANGEREUX = ('=', '+', '-', '@', '\t', '\r')


def _cellule_csv(valeur):
    """Rend une valeur sure pour un tableur."""
    if valeur is None:
        return ''
    texte = valeur if isinstance(valeur, str) else json.dumps(valeur, ensure_ascii=False)
    return "'" + texte if texte.startswith(_CSV_DANGEREUX) else texte


@comptes_bp.route('/admin/audit/export', methods=['GET'])
@role_required(ROLE_CHEF_ADMIN)
def exporter_journal():
    """Journal complet en CSV, en streaming (pagination par curseur).

    Meme filtre de rang que les vues.
    """
    acteur = g.compte

    def flux():
        tampon = io.StringIO()
        ecrivain = csv.writer(tampon, lineterminator='\n')

        def vider():
            valeur = tampon.getvalue()
            tampon.seek(0)
            tampon.truncate(0)
            return valeur

        # BOM UTF-8 pour qu'Excel lise correctement les accents.
        yield '﻿'
        ecrivain.writerow(['id', 'date', 'action', 'acteur_id', 'acteur_pseudo',
                           'acteur_supprime', 'cible_type', 'cible_id', 'details'])
        yield vider()

        avant_id = None
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    while True:
                        lignes = _lire_journal(cur, acteur, avant_id=avant_id,
                                               limite=AUDIT_PAGE_MAX)
                        if not lignes:
                            break

                        # Le curseur doit avancer, sinon boucle infinie.
                        if avant_id is not None and lignes[-1][0] >= avant_id:
                            logger.error("Export du journal : curseur bloque a %s", avant_id)
                            break

                        for r in lignes:
                            l = _ligne_journal(r)
                            ecrivain.writerow([
                                l['id'], l['created_at'], l['action'],
                                l['acteur_compte_id'] or '',
                                _cellule_csv(l['acteur_pseudo']),
                                'oui' if l['acteur_supprime'] else 'non',
                                l['cible_type'] or '', l['cible_id'] or '',
                                _cellule_csv(l['details']),
                            ])
                            yield vider()
                        avant_id = lignes[-1][0]
        except Exception as e:
            # Le flux a commence : on signale l'interruption dans le fichier.
            logger.error("Export du journal interrompu: %s", e)
            ecrivain.writerow(['#', 'EXPORT INTERROMPU', 'fichier incomplet'])
            yield vider()

    horodatage = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')
    return Response(
        stream_with_context(flux()),
        mimetype='text/csv; charset=utf-8',
        headers={'Content-Disposition':
                 'attachment; filename="journal-admin-%s.csv"' % horodatage},
    )


@comptes_bp.route('/admin/comptes/<int:compte_id>/permissions', methods=['GET'])
@role_required(ROLE_CHEF_ADMIN)
def lister_permissions(compte_id):
    """Permissions d'un compte, et le catalogue que l'acteur peut deleguer."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT role FROM comptes WHERE id = %s", (compte_id,))
                row = cur.fetchone()
                if row is None:
                    return jsonify({"error": "Compte introuvable"}), 404
                cur.execute(
                    "SELECT permission FROM permissions_admin WHERE compte_id = %s "
                    "ORDER BY permission",
                    (compte_id,),
                )
                accordees = [r[0] for r in cur.fetchall()]
    except Exception as e:
        logger.error("Lecture des permissions du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({
        "compte_id": compte_id,
        "role": row[0],
        "permissions": accordees,
        # Pour griser l'interface ; le backend reverifie.
        "delegables": sorted(permissions_delegables_par(g.compte)),
    })


@comptes_bp.route('/admin/comptes/<int:compte_id>/permissions/<permission>', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
@compte_cible_protegee
def accorder_permission(compte_id, permission):
    """Accorde une permission du catalogue a un compte role=admin.

    L'acteur ne peut accorder que ce qu'il peut deleguer.
    """
    if permission not in PERMISSIONS_CATALOGUE:
        return jsonify({
            "error": "Permission inconnue", "code": "permission_inconnue",
            "permissions": sorted(PERMISSIONS_CATALOGUE),
        }), 400

    if permission not in permissions_delegables_par(g.compte):
        return jsonify({
            "error": "Vous ne pouvez pas accorder un droit que vous n'avez pas.",
            "code": "plafond_delegation",
        }), 403

    erreur = refuse_auto_modification(_acteur_id(), compte_id)
    if erreur is not None:
        return erreur

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT role FROM comptes WHERE id = %s FOR UPDATE", (compte_id,))
                    row = cur.fetchone()
                    if row is None:
                        conn.rollback()
                        return jsonify({"error": "Compte introuvable"}), 404
                    if row[0] != ROLE_ADMIN:
                        conn.rollback()
                        return jsonify({
                            "error": "Les permissions ne s'accordent qu'à un compte admin. "
                                     "Un chef d'administration a déjà tout le catalogue.",
                            "code": "cible_non_admin",
                        }), 409

                    # Une sous-permission exige son parent (lu apres le verrou).
                    parent = SOUS_PERMISSIONS.get(permission)
                    if parent is not None:
                        cur.execute(
                            "SELECT 1 FROM permissions_admin "
                            "WHERE compte_id = %s AND permission = %s",
                            (compte_id, parent),
                        )
                        if cur.fetchone() is None:
                            conn.rollback()
                            return jsonify({
                                "error": "Ce droit complète « %s », qui doit être accordé "
                                         "d'abord." % parent,
                                "code": "parent_manquant",
                                "parent": parent,
                            }), 409

                    # accorde_par vient de la session, jamais du corps.
                    cur.execute(
                        "INSERT INTO permissions_admin (compte_id, permission, accorde_par) "
                        "VALUES (%s, %s, %s) ON CONFLICT (compte_id, permission) DO NOTHING",
                        (compte_id, permission, _acteur_id()),
                    )
                    nouvelle = bool(cur.rowcount)
                    if nouvelle:
                        _audit(cur, 'permission_accordee', 'compte', compte_id,
                               {"permission": permission})
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Octroi de '%s' au compte %s impossible: %s", permission, compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({"status": "success", "permission": permission, "inchange": not nouvelle})


@comptes_bp.route('/admin/comptes/<int:compte_id>/permissions/<permission>', methods=['DELETE'])
@role_required(ROLE_CHEF_ADMIN)
@compte_cible_protegee
def retirer_permission(compte_id, permission):
    """Retire une permission (l'historique est dans audit_admin).

    Le plafond de delegation s'applique aussi au retrait.
    """
    if permission not in PERMISSIONS_CATALOGUE:
        return jsonify({
            "error": "Permission inconnue", "code": "permission_inconnue",
        }), 400

    if permission not in permissions_delegables_par(g.compte):
        return jsonify({
            "error": "Vous ne pouvez pas retirer un droit que vous n'avez pas.",
            "code": "plafond_delegation",
        }), 403

    erreur = refuse_auto_modification(_acteur_id(), compte_id)
    if erreur is not None:
        return erreur

    # Retirer un parent retire aussi ses sous-permissions.
    enfants = [e for e, p in SOUS_PERMISSIONS.items() if p == permission]
    a_retirer = [permission] + enfants

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM permissions_admin WHERE compte_id = %s "
                        "AND permission = ANY(%s)",
                        (compte_id, a_retirer),
                    )
                    retiree = bool(cur.rowcount)
                    if retiree:
                        _audit(cur, 'permission_retiree', 'compte', compte_id,
                               {"permission": permission,
                                "sous_permissions_emportees": enfants})
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Retrait de '%s' au compte %s impossible: %s", permission, compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({"status": "success", "permission": permission,
                    "inchange": not retiree, "sous_permissions_retirees": enfants})


# ---------------------------------------------------------------------------
# Legs du role superadmin
# ---------------------------------------------------------------------------

@comptes_bp.route('/admin/comptes/<int:compte_id>/leguer-superadmin', methods=['POST'])
@role_required(ROLE_SUPERADMIN)
# Pas de @compte_cible_protegee : l'acteur est le superadmin.
def leguer_superadmin(compte_id):
    """Legue le role superadmin a un admin ou chef_admin.

    La cible doit avoir accepte la politique admin en version courante.
    L'ancien superadmin devient chef_admin. Route distincte de changer_role,
    dont la garde du dernier superadmin bloquerait le legs.
    """
    acteur_id = _acteur_id()

    erreur = refuse_auto_modification(acteur_id, compte_id)
    if erreur is not None:
        return erreur

    confirmation = (request.get_json(silent=True) or {}).get('confirmation_pseudo')

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    # Verrouillage des deux lignes en une requete triee (evite l'interblocage).
                    cur.execute(
                        "SELECT id, role, discord_username, cgu_admin_version "
                        "FROM comptes WHERE id IN (%s, %s) "
                        "ORDER BY id FOR UPDATE",
                        (min(acteur_id, compte_id), max(acteur_id, compte_id)),
                    )
                    lignes = {r[0]: r for r in cur.fetchall()}

                    cible = lignes.get(compte_id)
                    if cible is None:
                        conn.rollback()
                        return jsonify({"error": "Compte introuvable"}), 404

                    # Role de l'acteur relu sous verrou.
                    moi = lignes.get(acteur_id)
                    if moi is None or moi[1] != ROLE_SUPERADMIN:
                        conn.rollback()
                        return jsonify({
                            "error": "Vous n'êtes plus super-administrateur.",
                            "code": "plus_superadmin",
                        }), 409

                    # Role et consentement de la cible relus sous verrou.
                    if (cible[1] not in (ROLE_ADMIN, ROLE_CHEF_ADMIN)
                            or cible[3] != CGU_ADMIN_VERSION):
                        conn.rollback()
                        return jsonify({
                            "error": "Ce compte n'a pas accepté de rôle d'administration "
                                     "dans la version courante de la politique. Proposez-lui "
                                     "d'abord le rôle admin : le legs ne se fait qu'à un "
                                     "compte qui a consenti.",
                            "code": "legs_sans_consentement",
                        }), 409

                    # Confirmation sur le handle Discord, pas sur le nom affiche.
                    if not _confirmation_handle_valide(confirmation, cible[2]):
                        conn.rollback()
                        return jsonify({
                            "error": "Le pseudo saisi ne correspond pas au compte cible.",
                            "code": "confirmation_invalide",
                        }), 400

                    ancien_role_cible = cible[1]

                    # Retrograder avant de promouvoir (index unique non differable).
                    cur.execute(
                        "UPDATE comptes SET role = %s, updated_at = now() WHERE id = %s",
                        (ROLE_CHEF_ADMIN, acteur_id),
                    )
                    cur.execute(
                        "UPDATE comptes SET role = %s, updated_at = now() WHERE id = %s",
                        (ROLE_SUPERADMIN, compte_id),
                    )

                    # Les deux comptes doivent se reconnecter (duree de session liee au role).
                    cur.execute(
                        "DELETE FROM sessions_joueurs WHERE compte_id IN (%s, %s)",
                        (acteur_id, compte_id),
                    )

                    # La cible quitte le role admin : purge des permissions a la carte.
                    if ancien_role_cible == ROLE_ADMIN:
                        cur.execute("DELETE FROM permissions_admin WHERE compte_id = %s",
                                    (compte_id,))
                        if cur.rowcount:
                            _audit(cur, 'permissions_purgees', 'compte', compte_id,
                                   {"motif": "legs_superadmin"})

                    _audit(cur, 'superadmin_legue', 'compte', compte_id,
                           {"ancien": acteur_id, "nouveau": compte_id,
                            "ancien_role_cible": ancien_role_cible})

                    # Annule les propositions devenues sans objet.
                    _annuler_promotions(cur, 'legs_superadmin', cible=compte_id)
                    _annuler_promotions(cur, 'proposant_retrograde', proposant=acteur_id,
                                        role_propose=ROLE_CHEF_ADMIN)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Legs du superadmin %s -> %s impossible: %s", acteur_id, compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    logger.warning("LEGS SUPERADMIN : %s -> %s", acteur_id, compte_id)
    return jsonify({"status": "success", "ancien": acteur_id, "nouveau": compte_id,
                    "session_fermee": True})


@comptes_bp.route('/admin/comptes/<int:compte_id>/sessions', methods=['DELETE'])
@permission_required('gestion_comptes')
@compte_cible_protegee
def revoquer_sessions(compte_id):
    """Ferme toutes les sessions d'un compte (compte compromis)."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM comptes WHERE id = %s", (compte_id,))
                if cur.fetchone() is None:
                    conn.rollback()
                    return jsonify({"error": "Compte introuvable"}), 404
                cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s", (compte_id,))
                fermees = cur.rowcount
                _audit(cur, 'sessions_revoquees', 'compte', compte_id, {"nombre": fermees})
            conn.commit()
    except Exception as e:
        logger.error("Revocation des sessions du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success", "sessions_fermees": fermees})


@comptes_bp.route('/admin/comptes/<int:compte_id>/delier', methods=['POST'])
@permission_required('gestion_comptes')
@compte_cible_protegee
def delier_compte(compte_id):
    """Detache un compte de sa fiche joueur (inverse de /approve).

    La fiche redevient revendicable.
    """
    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    # Verrou contre une approbation concurrente.
                    cur.execute(
                        "SELECT joueur_id, statut FROM comptes WHERE id = %s FOR UPDATE",
                        (compte_id,),
                    )
                    row = cur.fetchone()
                    if row is None:
                        conn.rollback()
                        return jsonify({"error": "Compte introuvable"}), 404

                    joueur_id, statut = row
                    if joueur_id is None:
                        conn.rollback()
                        return jsonify({
                            "error": "Ce compte n'est rattaché à aucune fiche joueur",
                            "code": "non_lie",
                        }), 409

                    # Une suspension reste en place.
                    nouveau_statut = 'pending' if statut == 'linked' else statut

                    cur.execute(
                        """UPDATE comptes
                           SET joueur_id = NULL, statut = %s,
                               profil_synced_at = NULL, updated_at = now()
                           WHERE id = %s""",
                        (nouveau_statut, compte_id),
                    )
                    _audit(cur, 'liaison_annulee', 'compte', compte_id,
                           {"joueur_id": joueur_id, "statut": nouveau_statut})
                    cur.execute("SELECT nom FROM joueurs WHERE id = %s", (joueur_id,))
                    ligne = cur.fetchone()
                    notifier(
                        cur, compte_id, 'liaison_annulee',
                        "Votre compte a été désynchronisé",
                        "Il n'est plus rattaché à la fiche « %s ». La fiche et son "
                        "historique sont intacts ; vous pouvez demander un nouveau "
                        "rattachement depuis « Mon compte »." % (ligne[0] if ligne else '?'),
                        lien="/mon-compte/liaison",
                    )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Deliement du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    # L'avatar disparait de /stats/joueurs.
    invalidate_cache()
    logger.info("Compte %s delie du joueur %s (par %s)", compte_id, joueur_id, _acteur_id())
    return jsonify({"status": "success", "joueur_id": joueur_id, "statut": nouveau_statut})


# ---------------------------------------------------------------------------
# Jamais zero superadmin
# ---------------------------------------------------------------------------
# Suspendre ou supprimer le dernier superadmin est refuse : il doit leguer
# son role d'abord.

def _dernier_de_son_role(cur, compte_id: int, role: str) -> bool:
    """Vrai si ce compte est le dernier a porter ce role."""
    cur.execute(
        "SELECT COUNT(*) FROM comptes WHERE role = %s AND id <> %s",
        (role, compte_id),
    )
    return cur.fetchone()[0] == 0


def _refus_auto_verrouillage(cur, compte_id: int, role: str, geste: str):
    """Reponse 409 si ce geste laisserait le site sans superadmin, sinon None.

    `geste` est le verbe a afficher (« suspendre », « supprimer »).
    """
    if role != ROLE_SUPERADMIN or not _dernier_de_son_role(cur, compte_id, ROLE_SUPERADMIN):
        return None
    return jsonify({
        "error": "Vous êtes le dernier super-administrateur. Vous %s maintenant "
                 "rendrait toute administration impossible, et il n'existe pas de "
                 "mot de passe de secours. Léguez d'abord votre rôle à un autre "
                 "compte." % geste,
        "code": "dernier_superadmin",
    }), 409


@comptes_bp.route('/admin/comptes/<int:compte_id>/statut', methods=['POST'])
@permission_required('gestion_comptes')
@compte_cible_protegee
def changer_statut(compte_id):
    """Suspend ou reactive un compte (`suspended` ou `actif`).

    La reactivation remet `linked` s'il y a une fiche, `pending` sinon.
    """
    demande = (request.get_json(silent=True) or {}).get('statut')
    if demande not in ('actif', 'suspended'):
        return jsonify({"error": "Statut invalide : « actif » ou « suspended ».",
                        "code": "statut_invalide"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT statut, role, joueur_id FROM comptes WHERE id = %s FOR UPDATE",
                            (compte_id,))
                row = cur.fetchone()
                if row is None:
                    conn.rollback()
                    return jsonify({"error": "Compte introuvable"}), 404
                if demande == 'suspended':
                    nouveau = 'suspended'
                else:
                    nouveau = 'linked' if row[2] is not None else 'pending'

                if nouveau == 'suspended':
                    refus = _refus_auto_verrouillage(cur, compte_id, row[1], 'suspendre')
                    if refus is not None:
                        conn.rollback()
                        return refus

                cur.execute(
                    "UPDATE comptes SET statut = %s, updated_at = now() WHERE id = %s",
                    (nouveau, compte_id),
                )
                if nouveau == 'suspended':
                    # Ferme les sessions du compte suspendu.
                    cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s", (compte_id,))
                    # Annule les propositions recues ou faites par le compte.
                    _annuler_promotions(cur, 'cible_suspendue', cible=compte_id)
                    _annuler_promotions(cur, 'proposant_suspendu', proposant=compte_id)
                _audit(cur, 'statut_change', 'compte', compte_id,
                       {"ancien": row[0], "nouveau": nouveau})
            conn.commit()
    except Exception as e:
        logger.error("Changement de statut du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success", "statut": nouveau})


# ---------------------------------------------------------------------------
# Profil joueur
# ---------------------------------------------------------------------------

# On stocke un identifiant, jamais une URL saisie (risque de « javascript: »).
RESEAUX_CONNUS = {
    'twitch':  'https://twitch.tv/%s',
    'youtube': 'https://youtube.com/@%s',
    'bluesky': 'https://bsky.app/profile/%s',
    'twitter': 'https://x.com/%s',
}

_RE_HANDLE = re.compile(r'^[A-Za-z0-9_.\-]{1,50}$')
_RE_COULEUR = RE_COULEUR


def _reseaux_avec_urls(reseaux):
    """Ajoute l'URL construite a chaque handle, pour l'affichage."""
    sortie = {}
    for cle, handle in (reseaux or {}).items():
        gabarit = RESEAUX_CONNUS.get(cle)
        if gabarit and isinstance(handle, str) and _RE_HANDLE.match(handle):
            sortie[cle] = {"handle": handle, "url": gabarit % handle}
    return sortie


def _valider_profil(data):
    """Renvoie (champs propres, message d'erreur)."""
    bio = data.get('bio')
    if bio is not None:
        if not isinstance(bio, str):
            return None, "La bio doit être du texte"
        bio = bio.strip()[:500] or None

    couleur = data.get('couleur_accent')
    if couleur is not None:
        if not isinstance(couleur, str) or not _RE_COULEUR.match(couleur.strip()):
            return None, "La couleur doit être au format #RRGGBB"
        couleur = couleur.strip().upper()

    reseaux = data.get('reseaux')
    if reseaux is None:
        reseaux = {}
    if not isinstance(reseaux, dict):
        return None, "Format de réseaux invalide"
    propres = {}
    for cle, handle in reseaux.items():
        if cle not in RESEAUX_CONNUS:
            return None, "Réseau inconnu : %s" % cle
        if handle in (None, ''):
            continue
        if not isinstance(handle, str) or not _RE_HANDLE.match(handle.strip()):
            return None, ("Identifiant %s invalide : lettres, chiffres, « . », « _ » et « - » "
                          "uniquement, sans l'URL complete" % cle)
        propres[cle] = handle.strip()

    return {"bio": bio, "couleur_accent": couleur, "reseaux": propres}, None


@comptes_bp.route('/me/profil', methods=['GET'])
@player_required
def lire_mon_profil():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT bio, couleur_accent, reseaux, updated_at FROM profils WHERE compte_id = %s",
                    (g.compte['id'],),
                )
                row = cur.fetchone()
    except Exception as e:
        logger.error("Lecture du profil impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    if row is None:
        return jsonify({"bio": None, "couleur_accent": None, "reseaux": {}, "updated_at": None})
    return jsonify({
        "bio": row[0], "couleur_accent": row[1], "reseaux": row[2] or {},
        "updated_at": row[3].isoformat() if row[3] else None,
    })


@comptes_bp.route('/me/profil', methods=['PUT'])
@player_required
def ecrire_mon_profil():
    """Edite le profil du joueur connecte (liste blanche de champs)."""
    champs, erreur = _valider_profil(request.get_json(silent=True) or {})
    if erreur is not None:
        return jsonify({"error": erreur, "code": "profil_invalide"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO profils (compte_id, bio, couleur_accent, reseaux, updated_at)
                       VALUES (%s, %s, %s, %s::jsonb, now())
                       ON CONFLICT (compte_id) DO UPDATE SET
                           bio            = EXCLUDED.bio,
                           couleur_accent = EXCLUDED.couleur_accent,
                           reseaux        = EXCLUDED.reseaux,
                           updated_at     = now()""",
                    (g.compte['id'], champs['bio'], champs['couleur_accent'],
                     json.dumps(champs['reseaux'])),
                )
            conn.commit()
    except Exception as e:
        logger.error("Ecriture du profil impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    # La fiche publique n'est pas en cache : rien a invalider.
    return jsonify({"status": "success", **champs,
                    "reseaux_affichables": _reseaux_avec_urls(champs['reseaux'])})


def profil_public(cur, joueur_id):
    """Partie publique du profil d'un joueur, ou None.

    Le role n'est expose que pour les roles d'administration (badge).
    """
    cur.execute(
        # Rien pour une fiche anonymisee.
        """SELECT c.discord_id, c.discord_avatar_hash, p.bio, p.couleur_accent, p.reseaux,
                  c.role
           FROM comptes c
           JOIN joueurs j ON j.id = c.joueur_id
           LEFT JOIN profils p ON p.compte_id = c.id
           WHERE c.joueur_id = %s AND c.statut = 'linked'
             AND j.anonymise_at IS NULL""",
        (joueur_id,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    return {
        "avatar_url": "/avatar/joueur/%d" % joueur_id,
        "bio": row[2],
        "couleur_accent": row[3],
        "reseaux": _reseaux_avec_urls(row[4]),
        "role": row[5] if row[5] in (ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN) else None,
    }


# ---------------------------------------------------------------------------
# Avatars, relayes pour ne pas exposer l'IP des visiteurs ni le snowflake
# ---------------------------------------------------------------------------

# Partage entre threads sans verrou : seules des operations atomiques du dict.
_avatars = {}


def _avatar_distant(url):
    """Telecharge un avatar, avec un cache memoire. Renvoie (type_mime, octets)."""
    entree = _avatars.get(url)
    if entree is not None and time.time() - entree[0] < AVATAR_CACHE_TTL:
        return entree[1], entree[2]

    try:
        reponse = requests.get(url, timeout=DISCORD_HTTP_TIMEOUT, stream=True)
    except requests.exceptions.RequestException:
        return None, None

    type_mime = reponse.headers.get('Content-Type', '')
    if reponse.status_code != 200 or not type_mime.startswith('image/'):
        reponse.close()
        return None, None

    octets = b''
    for morceau in reponse.iter_content(8192):
        octets += morceau
        if len(octets) > AVATAR_MAX_BYTES:
            reponse.close()
            return None, None
    reponse.close()

    if len(_avatars) > 500:
        _avatars.clear()
    _avatars[url] = (time.time(), type_mime, octets)
    return type_mime, octets


def _servir_avatar(discord_id, avatar_hash):
    type_mime, octets = _avatar_distant(avatar_url(discord_id, avatar_hash))
    if octets is None:
        return jsonify({"error": "Avatar indisponible"}), 404
    reponse = make_response(octets)
    reponse.headers['Content-Type'] = type_mime
    reponse.headers['Cache-Control'] = 'public, max-age=%d' % AVATAR_CACHE_TTL
    return reponse


@comptes_bp.route('/avatar/joueur/<int:joueur_id>', methods=['GET'])
def avatar_joueur(joueur_id):
    """Avatar public d'une fiche. Memes conditions que profil_public."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT c.discord_id, c.discord_avatar_hash
                       FROM comptes c JOIN joueurs j ON j.id = c.joueur_id
                       WHERE c.joueur_id = %s AND c.statut = 'linked'
                         AND j.anonymise_at IS NULL""",
                    (joueur_id,),
                )
                row = cur.fetchone()
    except Exception as e:
        logger.error("Lecture de l'avatar du joueur %s impossible: %s", joueur_id, e)
        return jsonify({"error": "Erreur serveur"}), 500
    if row is None:
        return jsonify({"error": "Aucun avatar"}), 404
    return _servir_avatar(row[0], row[1])


@comptes_bp.route('/avatar/moi', methods=['GET'])
@player_required_sans_cgu
def avatar_moi():
    return _servir_avatar(g.compte['discord_id'], g.compte['discord_avatar_hash'])


@comptes_bp.route('/avatar/compte/<int:compte_id>', methods=['GET'])
@role_required(ROLE_ADMIN)
def avatar_compte(compte_id):
    """Avatar d'un compte, quel que soit son statut (administration)."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT discord_id, discord_avatar_hash FROM comptes WHERE id = %s",
                    (compte_id,),
                )
                row = cur.fetchone()
    except Exception as e:
        logger.error("Lecture de l'avatar du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500
    if row is None:
        return jsonify({"error": "Compte introuvable"}), 404
    return _servir_avatar(row[0], row[1])


# ---------------------------------------------------------------------------
# Matchmaking (page d'administration)
# ---------------------------------------------------------------------------

@comptes_bp.route('/admin/matchmaking', methods=['POST'])
@permission_required('gestion_matchmaking')
def matchmaking_admin():
    """Compose les lobbies (meme service que /api/bot/matchmaking)."""
    data = request.get_json(silent=True) or {}
    noms = data.get('noms')
    joueur_ids = data.get('joueur_ids')

    # Exactement une liste, comme la route du bot.
    fournis = [x for x in (noms, joueur_ids) if x]
    if len(fournis) != 1 or not isinstance(fournis[0], list):
        return jsonify({
            "error": "Fournir exactement une liste : noms ou joueur_ids",
            "code": "entree_invalide",
        }), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                joueurs, introuvables = resoudre_joueurs_matchmaking(
                    cur, noms=noms, joueur_ids=joueur_ids,
                )
    except Exception as e:
        logger.error("Matchmaking admin impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    if len(joueurs) < 2:
        return jsonify({
            "error": "Sélectionnez au moins deux joueurs.",
            "code": "pas_assez_de_joueurs",
            "introuvables": introuvables,
        }), 400

    lobbies = construire_lobbies(joueurs)
    return jsonify({
        "lobbies": [{
            "numero": i + 1,
            "joueurs": lobby,
            "moyenne": round(sum(p['ts'] for p in lobby) / len(lobby), 3),
        } for i, lobby in enumerate(lobbies)],
        "introuvables": introuvables,
    })


# ---------------------------------------------------------------------------
# Jetons de service (bots), reserve au superadmin
# ---------------------------------------------------------------------------

SCOPES_CONNUS = ('read:joueurs', 'read:classement', 'matchmaking')


@comptes_bp.route('/admin/service-tokens', methods=['GET'])
@role_required(ROLE_SUPERADMIN)
def lister_service_tokens():
    """Liste les jetons (seul le hash est stocke)."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT id, nom, scopes, expires_at, revoked_at, last_used_at, created_at
                       FROM service_tokens ORDER BY created_at DESC"""
                )
                rows = cur.fetchall()
    except Exception as e:
        logger.error("Liste des jetons de service impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify([{
        "id": r[0], "nom": r[1], "scopes": r[2] or [],
        "expires_at": r[3].isoformat() if r[3] else None,
        "revoquee": r[4] is not None,
        "last_used_at": r[5].isoformat() if r[5] else None,
        "created_at": r[6].isoformat(),
    } for r in rows])


@comptes_bp.route('/admin/service-tokens', methods=['POST'])
@role_required(ROLE_SUPERADMIN)
def creer_service_token():
    """Cree un jeton et le renvoie une seule fois (seul le hash est stocke)."""
    data = request.get_json(silent=True) or {}
    nom = (data.get('nom') or '').strip()[:64]
    scopes = data.get('scopes') or []

    if not nom:
        return jsonify({"error": "Un nom est requis", "code": "nom_manquant"}), 400
    if not isinstance(scopes, list) or not scopes:
        return jsonify({"error": "Au moins une portée est requise", "code": "scopes_manquants"}), 400
    inconnus = [s for s in scopes if s not in SCOPES_CONNUS]
    if inconnus:
        return jsonify({"error": "Portée inconnue : %s" % ', '.join(inconnus),
                        "code": "scope_inconnu", "scopes_valides": list(SCOPES_CONNUS)}), 400

    jours = data.get('jours')
    expires_at = None
    if jours:
        try:
            expires_at = datetime.now(timezone.utc) + timedelta(days=max(1, int(jours)))
        except (TypeError, ValueError):
            return jsonify({"error": "Durée invalide"}), 400

    jeton = secrets.token_urlsafe(32)
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO service_tokens (token_hash, nom, scopes, expires_at)
                       VALUES (%s, %s, %s, %s) RETURNING id""",
                    (hash_token(jeton), nom, scopes, expires_at),
                )
                token_id = cur.fetchone()[0]
                _audit(cur, 'service_token_cree', 'service_token', token_id,
                       {"nom": nom, "scopes": scopes})
            conn.commit()
    except Exception as e:
        logger.error("Creation de jeton de service impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({
        "id": token_id, "nom": nom, "scopes": scopes,
        "token": jeton,  # visible une seule fois
        "expires_at": expires_at.isoformat() if expires_at else None,
    }), 201


@comptes_bp.route('/admin/service-tokens/<int:token_id>', methods=['DELETE'])
@role_required(ROLE_SUPERADMIN)
def revoquer_service_token(token_id):
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE service_tokens SET revoked_at = now() WHERE id = %s AND revoked_at IS NULL",
                    (token_id,),
                )
                if cur.rowcount == 0:
                    conn.rollback()
                    return jsonify({"error": "Jeton introuvable ou déjà révoqué"}), 404
                _audit(cur, 'service_token_revoque', 'service_token', token_id)
            conn.commit()
    except Exception as e:
        logger.error("Revocation de jeton impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success"})


# ---------------------------------------------------------------------------
# RGPD : consentement, acces, portabilite, effacement
# ---------------------------------------------------------------------------

def _enregistrer_consentement(cur, compte_id, politique, version, origine):
    """Ajoute une acceptation a l'historique (table consentements).

    A appeler dans la meme transaction que la mise a jour des colonnes cgu_*.
    `origine` nomme le parcours (page_consentement, acceptation_promotion...).
    """
    cur.execute(
        """INSERT INTO consentements (compte_id, politique, version, origine)
           VALUES (%s, %s, %s, %s)""",
        (compte_id, politique, version, origine),
    )


@comptes_bp.route('/me/cgu', methods=['POST'])
@player_required_sans_cgu
def accepter_cgu():
    """Enregistre l'acceptation des conditions, avec leur version."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE comptes SET cgu_accepted_at = now(), cgu_version = %s,
                                          updated_at = now()
                       WHERE id = %s""",
                    (CGU_VERSION, g.compte['id']),
                )
                _enregistrer_consentement(cur, g.compte['id'], 'cgu', CGU_VERSION,
                                          'page_consentement')
            conn.commit()
    except Exception as e:
        logger.error("Enregistrement du consentement impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success", "cgu_version": CGU_VERSION})


@comptes_bp.route('/me/notifications', methods=['GET'])
@player_required
def mes_notifications():
    """Les 30 dernieres notifications du compte et le nombre de non-lues."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT id, type, titre, corps, created_at, lu_at, lien
                       FROM notifications WHERE compte_id = %s
                       ORDER BY created_at DESC LIMIT 30""",
                    (g.compte['id'],),
                )
                rows = cur.fetchall()
    except Exception as e:
        logger.error("Lecture des notifications impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({
        "non_lues": sum(1 for r in rows if r[5] is None),
        "notifications": [{
            "id": r[0], "type": r[1], "titre": r[2], "corps": r[3],
            "created_at": r[4].isoformat(), "lue": r[5] is not None,
            "lien": r[6],
        } for r in rows],
    })


@comptes_bp.route('/me/notifications/lues', methods=['POST'])
@player_required
def marquer_notifications_lues():
    """Marque tout comme lu. Ne supprime rien."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE notifications SET lu_at = now()
                       WHERE compte_id = %s AND lu_at IS NULL""",
                    (g.compte['id'],),
                )
                marquees = cur.rowcount
            conn.commit()
    except Exception as e:
        logger.error("Marquage des notifications impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success", "marquees": marquees})



@comptes_bp.route('/admin/notifications', methods=['GET'])
@role_required(ROLE_ADMIN)
def compteur_admin():
    """Compteurs des demandes en attente, pour les pastilles de la navbar."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM liaisons_demandes WHERE statut = 'pending'"
                )
                liaisons = cur.fetchone()[0]
    except Exception as e:
        logger.error("Compteur admin impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"liaisons_en_attente": liaisons, "total": liaisons})


@comptes_bp.route('/me/export', methods=['GET'])
@player_required_sans_cgu
def exporter_mes_donnees():
    """Export des donnees du compte en JSON (droit d'acces et de portabilite).

    Inclut le dossier sportif, mais pas l'identite des autres comptes.
    """
    compte_id = g.compte['id']
    joueur_id = g.compte['joueur_id']
    export = {
        "genere_le": datetime.now(timezone.utc).isoformat(),
        "avertissement": (
            "Le dossier sportif (participations, awards) est rattaché à une fiche "
            "joueur pseudonyme et n'est PAS supprimé avec le compte. Voir la "
            "politique de confidentialité."
        ),
    }

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT discord_id, discord_username, discord_global_name,
                              discord_avatar_hash, joueur_id, statut, role,
                              cgu_accepted_at, cgu_version, created_at, updated_at,
                              last_login_at, discord_synced_at, profil_synced_at,
                              cgu_admin_accepted_at, cgu_admin_version
                       FROM comptes WHERE id = %s""",
                    (compte_id,),
                )
                c = cur.fetchone()
                if c is None:
                    # Compte supprime depuis la verification de session.
                    return jsonify({"error": "Compte introuvable"}), 404
                export["compte"] = {
                    "discord_id": c[0], "discord_username": c[1],
                    "discord_global_name": c[2], "discord_avatar_hash": c[3],
                    "joueur_id": c[4], "statut": c[5], "role": c[6],
                    "cgu_acceptees_le": c[7].isoformat() if c[7] else None,
                    "cgu_version": c[8],
                    "cree_le": c[9].isoformat(), "modifie_le": c[10].isoformat(),
                    "derniere_connexion": c[11].isoformat() if c[11] else None,
                    "miroir_discord_rafraichi_le": c[12].isoformat() if c[12] else None,
                    "pseudo_synchronise_le": c[13].isoformat() if c[13] else None,
                    "politique_admin_acceptee_le": c[14].isoformat() if c[14] else None,
                    "politique_admin_version": c[15],
                }

                # Historique complet des acceptations.
                cur.execute(
                    """SELECT politique, version, accepte_le, origine
                       FROM consentements WHERE compte_id = %s ORDER BY accepte_le, id""",
                    (compte_id,),
                )
                export["consentements"] = [{
                    "politique": r[0], "version": r[1],
                    "accepte_le": r[2].isoformat(), "origine": r[3],
                } for r in cur.fetchall()]

                cur.execute(
                    "SELECT bio, couleur_accent, reseaux, updated_at FROM profils WHERE compte_id = %s",
                    (compte_id,),
                )
                pr = cur.fetchone()
                export["profil"] = None if pr is None else {
                    "bio": pr[0], "couleur_accent": pr[1], "reseaux": pr[2] or {},
                    "modifie_le": pr[3].isoformat() if pr[3] else None,
                }

                cur.execute(
                    """SELECT created_at, expires_at, last_seen_at, user_agent
                       FROM sessions_joueurs WHERE compte_id = %s ORDER BY created_at DESC""",
                    (compte_id,),
                )
                export["sessions_actives"] = [{
                    "ouverte_le": r[0].isoformat(), "expire_le": r[1].isoformat(),
                    "derniere_activite": r[2].isoformat() if r[2] else None,
                    "navigateur": r[3],
                } for r in cur.fetchall()]

                # LEFT JOIN : une demande de creation n'a pas encore de fiche.
                cur.execute(
                    """SELECT d.statut, d.message, d.created_at, d.decided_at, j.nom,
                              d.joueur_id, d.nom_demande
                       FROM liaisons_demandes d LEFT JOIN joueurs j ON j.id = d.joueur_id
                       WHERE d.compte_id = %s ORDER BY d.created_at""",
                    (compte_id,),
                )
                export["demandes_de_liaison"] = [{
                    "type": 'rattachement' if r[5] is not None else 'creation',
                    "statut": r[0], "message": r[1], "faite_le": r[2].isoformat(),
                    "decidee_le": r[3].isoformat() if r[3] else None,
                    "joueur": r[4], "nom_demande": r[6],
                } for r in cur.fetchall()]

                cur.execute(
                    """SELECT role_propose, statut, created_at, expires_at, decided_at
                       FROM promotions_proposees WHERE compte_id = %s ORDER BY created_at""",
                    (compte_id,),
                )
                export["propositions_de_role"] = [{
                    "role_propose": r[0], "statut": r[1], "proposee_le": r[2].isoformat(),
                    "expirait_le": r[3].isoformat(),
                    "decidee_le": r[4].isoformat() if r[4] else None,
                } for r in cur.fetchall()]

                cur.execute(
                    """SELECT permission, created_at FROM permissions_admin
                       WHERE compte_id = %s ORDER BY created_at""",
                    (compte_id,),
                )
                export["permissions"] = [{
                    "permission": r[0], "accordee_le": r[1].isoformat(),
                } for r in cur.fetchall()]

                # Actions d'administration dont la personne est l'auteur (sans limite).
                export["journal_de_mes_actions"] = [
                    {k: v for k, v in _ligne_journal(r).items()
                     if k not in ('acteur_compte_id', 'acteur_pseudo', 'acteur_supprime')}
                    for r in _lire_journal(cur, g.compte, compte_id=compte_id, limite=None)
                ]

                cur.execute(
                    """SELECT created_at, type, titre, corps, lu_at, lien
                       FROM notifications WHERE compte_id = %s ORDER BY created_at""",
                    (compte_id,),
                )
                export["notifications"] = [{
                    "recue_le": r[0].isoformat(), "type": r[1], "titre": r[2],
                    "corps": r[3], "lue_le": r[4].isoformat() if r[4] else None,
                    "lien": r[5],
                } for r in cur.fetchall()]

                export["dossier_sportif"] = None
                if joueur_id:
                    cur.execute(
                        """SELECT nom, mu, sigma, score_trueskill, tier, is_ranked, color
                           FROM joueurs WHERE id = %s""",
                        (joueur_id,),
                    )
                    j = cur.fetchone()
                    cur.execute(
                        """SELECT t.date, p.score, p.position, p.new_score_trueskill,
                                  p.old_mu, p.old_sigma
                           FROM participations p JOIN tournois t ON t.id = p.tournoi_id
                           WHERE p.joueur_id = %s ORDER BY t.date""",
                        (joueur_id,),
                    )
                    participations = [{
                        "date": r[0].isoformat(), "score": r[1], "position": r[2],
                        "score_trueskill_apres": float(r[3]) if r[3] is not None else None,
                        "mu_avant": float(r[4]) if r[4] is not None else None,
                        "sigma_avant": float(r[5]) if r[5] is not None else None,
                    } for r in cur.fetchall()]

                    cur.execute(
                        """SELECT a.created_at, ta.nom, a.valeur, a.ligue_nom
                           FROM awards_obtenus a JOIN types_awards ta ON ta.id = a.award_id
                           WHERE a.joueur_id = %s ORDER BY a.created_at""",
                        (joueur_id,),
                    )
                    awards = [{
                        "obtenu_le": r[0].isoformat() if r[0] else None,
                        "award": r[1], "valeur": r[2], "ligue": r[3],
                    } for r in cur.fetchall()]

                    export["dossier_sportif"] = {
                        "joueur_id": joueur_id,
                        "nom": j[0], "mu": float(j[1]), "sigma": float(j[2]),
                        "score_trueskill": float(j[3]) if j[3] is not None else None,
                        "tier": j[4].strip() if j[4] else None,
                        "classe": j[5], "couleur": j[6],
                        "participations": participations,
                        "awards": awards,
                    }
    except Exception as e:
        logger.error("Export des donnees du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify(export)


def _effacer_compte(cur, compte_id, joueur_id, discord_id, origine):
    """Efface un compte : identite, profil, sessions, demandes, consentements.

    Le dossier sportif reste attache a la fiche joueur (calcul TrueSkill
    incremental). A appeler dans une transaction, compte deja verrouille et
    gardes passees.
    """
    # Audit avant la suppression (la ligne reference le compte). On garde une
    # empreinte du snowflake, pas l'identifiant, pour pouvoir resupprimer le
    # compte apres une restauration de sauvegarde. Cette empreinte reste une
    # donnee personnelle (pseudonymisation), declaree dans la politique de
    # confidentialite.
    _audit(
        cur, 'compte_supprime', 'compte', compte_id,
        {
             "joueur_id": joueur_id,
             "origine": origine,
             # Empreinte, pas l'identifiant en clair.
             "discord_id_hash": hash_token(discord_id),
        },
    )
    # Suppressions explicites plutot que de dependre des CASCADE.
    cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s", (compte_id,))
    cur.execute("DELETE FROM profils WHERE compte_id = %s", (compte_id,))
    cur.execute("DELETE FROM liaisons_demandes WHERE compte_id = %s", (compte_id,))
    # L'historique des consentements part avec le compte.
    cur.execute("DELETE FROM consentements WHERE compte_id = %s", (compte_id,))
    # Les propositions faites par ce compte sont annulees.
    _annuler_promotions(cur, 'proposant_supprime', proposant=compte_id)
    cur.execute("DELETE FROM comptes WHERE id = %s", (compte_id,))


# L'effacement se fait sur demande ecrite, par le superadmin (pas de DELETE /me).
@comptes_bp.route('/admin/comptes/<int:compte_id>', methods=['DELETE'])
@role_required(ROLE_SUPERADMIN)
@compte_cible_protegee
def supprimer_compte(compte_id):
    """Execute une demande d'effacement recue par ecrit (verifier qu'elle vient
    du titulaire)."""
    acteur_id = _acteur_id()

    # Le superadmin ne peut pas se supprimer lui-meme.
    erreur = refuse_auto_modification(acteur_id, compte_id)
    if erreur is not None:
        return erreur

    confirmation = (request.get_json(silent=True) or {}).get('confirmation_pseudo')

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT role, joueur_id, discord_id, discord_username "
                        "FROM comptes WHERE id = %s FOR UPDATE",
                        (compte_id,),
                    )
                    row = cur.fetchone()
                    if row is None:
                        conn.rollback()
                        return jsonify({"error": "Compte introuvable"}), 404
                    role, joueur_id, discord_id, discord_username = row

                    # Garde-fou : jamais zero superadmin.
                    refus = _refus_auto_verrouillage(cur, compte_id, role, 'supprimer')
                    if refus is not None:
                        conn.rollback()
                        return refus

                    # Confirmation sur le handle Discord.
                    if not _confirmation_handle_valide(confirmation, discord_username):
                        conn.rollback()
                        return jsonify({
                            "error": "Le pseudo saisi ne correspond pas au compte cible.",
                            "code": "confirmation_invalide",
                        }), 400

                    _effacer_compte(cur, compte_id, joueur_id, discord_id,
                                    origine='demande_ecrite')
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Suppression du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    # /stats/joueurs publie les avatars et est en cache.
    invalidate_cache()
    logger.warning("Compte %s supprime par %s, sur demande ecrite", compte_id, acteur_id)
    return jsonify({
        "status": "success",
        "dossier_sportif_conserve": joueur_id is not None,
    })


@comptes_bp.route('/admin/purge-rgpd', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
def declencher_purge():
    """Lance la purge des donnees expirees (declenchement manuel)."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                bilan = purger_donnees_expirees(cur)
            conn.commit()
    except Exception as e:
        logger.error("Purge RGPD impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success", "bilan": bilan})
