"""Liaison compte <-> joueur, synchronisation des profils, gestion des roles.

La revendication est declarative : n'importe qui disposant d'une invitation
peut pretendre etre le meilleur joueur du classement. Le seul controle est
la vigilance de l'admin, d'ou l'apercu avant validation.
"""

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
from auth import (player_required, role_required, permission_required,
                 compte_cible_protegee, permissions_delegables_par,
                 refuse_auto_modification)
from auth_discord import avatar_url, hash_token
from cache import invalidate_cache
from services import (construire_lobbies, resoudre_joueurs_matchmaking,
                      purger_donnees_expirees)
from db import get_db_connection

logger = logging.getLogger(__name__)

comptes_bp = Blueprint('comptes', __name__)


# Alias local vers le chemin d'ecriture unique (backEnd/audit.py). Le nom est
# conserve parce qu'il porte plus de quarante appels dans ce fichier : les
# renommer aurait fait un diff illisible pour un gain nul.
_audit = audit.ecrire
_acteur_id = audit.acteur_courant


def notifier(cur, compte_id, type_notif, titre, corps=None, lien=None):
    """Depose une notification. A appeler DANS la transaction de la decision.

    Le texte est fige ici : une notification parle souvent d'une chose qui vient
    de disparaitre, et une jointure a l'affichage donnerait « (null) ».

    `lien` suit la meme regle : c'est l'URL construite maintenant, pas un
    identifiant qu'on re-resoudrait a l'affichage. NULL quand la notification
    n'appelle aucune action.
    """
    if compte_id is None:
        return
    cur.execute(
        """INSERT INTO notifications (compte_id, type, titre, corps, lien)
           VALUES (%s, %s, %s, %s, %s)""",
        (compte_id, type_notif[:40], titre[:160], corps, lien[:255] if lien else None),
    )


def _pseudo(username, global_name):
    """Discord expose deux noms ; global_name est absent des vieux comptes."""
    return global_name or username


def _nom_creable(cur, nom):
    """Un nom de fiche est-il utilisable ? Renvoie (nom_propre, reponse d'erreur).

    Appele a la demande et de nouveau a l'approbation : add_tournament cree des
    fiches a la volee, le nom a pu etre pris entre-temps.
    """
    nom = (nom or '').strip()[:255]
    if not nom:
        return None, (jsonify({"error": "Le nom est vide", "code": "nom_vide"}), 409)

    if '/' in nom:
        # /stats/joueur/<nom> : Flask ne route pas un nom contenant un slash.
        return None, (jsonify({
            "error": "Le nom contient un « / », incompatible avec l'URL publique",
            "code": "nom_invalide",
        }), 409)

    cur.execute(
        "SELECT 1 FROM noms_interdits WHERE nom_hash = %s",
        (hashlib.sha256(nom.lower().encode('utf-8')).hexdigest(),),
    )
    if cur.fetchone() is not None:
        return None, (jsonify({
            "error": "Ce nom correspond a une identite retiree et ne peut pas etre recree",
            "code": "nom_interdit",
        }), 409)

    # joueurs.nom est UNIQUE mais sensible a la casse : « Mario » et « mario »
    # coexisteraient en base tout en etant indiscernables a l'oeil.
    cur.execute("SELECT id, nom FROM joueurs WHERE lower(nom) = lower(%s)", (nom,))
    collision = cur.fetchone()
    if collision is not None:
        return None, (jsonify({
            "error": "La fiche « %s » existe deja : revendiquez-la au lieu d'en creer une."
                     % collision[1],
            "code": "nom_deja_pris",
            "joueur_en_conflit": {"id": collision[0], "nom": collision[1]},
        }), 409)

    return nom, None


# ---------------------------------------------------------------------------
# Cote joueur : revendiquer une fiche
# ---------------------------------------------------------------------------

def notifier_tous(cur, type_notif, titre, corps=None, lien=None):
    """Notifie tous les comptes non suspendus. Renvoie leur nombre.

    Un compte suspendu ne peut plus ouvrir de session : lui deposer du
    courrier n'aurait aucun sens.
    """
    cur.execute(
        """INSERT INTO notifications (compte_id, type, titre, corps, lien)
           SELECT id, %s, %s, %s, %s FROM comptes WHERE statut <> 'suspended'""",
        (type_notif[:40], titre[:160], corps, lien[:255] if lien else None),
    )
    return cur.rowcount


@comptes_bp.route('/auth/joueurs-disponibles', methods=['GET'])
@player_required
def joueurs_disponibles():
    """Fiches revendicables : sans compte, et non anonymisees.

    Lister les autres publierait qui possede un compte Discord.
    """
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

    # isinstance(True, int) vaut True : sans exclure les booleens, un corps
    # {"joueur_id": true} viserait le joueur n°1.
    if not isinstance(joueur_id, int) or isinstance(joueur_id, bool):
        return jsonify({"error": "Joueur manquant", "code": "joueur_manquant"}), 400

    compte = g.compte
    if compte['joueur_id'] is not None:
        return jsonify({"error": "Ce compte est deja rattache", "code": "deja_lie"}), 409

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
                            "error": "Cette fiche est deja rattachee a un compte",
                            "code": "joueur_deja_pris",
                        }), 409

                    # Les index uniques partiels transformeraient un doublon en 500.
                    cur.execute(
                        "SELECT id FROM liaisons_demandes WHERE compte_id = %s AND statut = 'pending'",
                        (compte['id'],),
                    )
                    if cur.fetchone() is not None:
                        conn.rollback()
                        return jsonify({
                            "error": "Vous avez deja une demande en cours",
                            "code": "demande_en_cours",
                        }), 409

                    cur.execute(
                        "SELECT id FROM liaisons_demandes WHERE joueur_id = %s AND statut = 'pending'",
                        (joueur_id,),
                    )
                    if cur.fetchone() is not None:
                        conn.rollback()
                        return jsonify({
                            "error": "Une demande est deja en attente sur cette fiche",
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

    Rejoint la file d'attente des revendications, avec joueur_id NULL et le nom
    voulu dans nom_demande. Le nom est fige ici : l'admin approuve ce qu'il a
    sous les yeux. Rien n'est cree avant son accord.
    """
    compte = g.compte
    if compte['joueur_id'] is not None:
        return jsonify({"error": "Ce compte est deja rattache", "code": "deja_lie"}), 409

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

                    # L'index unique partiel transformerait un doublon en 500.
                    cur.execute(
                        "SELECT id FROM liaisons_demandes WHERE compte_id = %s AND statut = 'pending'",
                        (compte['id'],),
                    )
                    if cur.fetchone() is not None:
                        conn.rollback()
                        return jsonify({
                            "error": "Vous avez deja une demande en cours",
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
                    # LEFT JOIN : une demande de creation n'a pas de joueur,
                    # un INNER JOIN la rendrait invisible a son auteur.
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
               d.nom_demande
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
        # Nom de la fiche a creer, fige au moment de la demande.
        "nom_demande": r[14],
        # Invitation nominative : l'admin voit si la revendication correspond au joueur
        # vise. Sur une demande de creation, c'est la non-concordance qui informe.
        "joueur_vise_par_invitation": r[13],
        "concordance_invitation": (r[13] is not None and r[13] == r[11]),
    } for r in rows])


@comptes_bp.route('/admin/liaisons/<int:demande_id>/approve', methods=['POST'])
@permission_required('gestion_liaisons')
def approuver_liaison(demande_id):
    """Approuve une revendication et rattache le compte au joueur.

    SELECT ... FOR UPDATE : deux approbations concurrentes sur la meme fiche
    violeraient la contrainte UNIQUE de comptes.joueur_id ; la seconde obtient
    un 409 explicite.

    Une demande visant une fiche a CREER la cree dans la meme transaction :
    si le rattachement echoue, aucune fiche orpheline ne subsiste.

    Ne synchronise RIEN : propager le pseudo est un geste separe (voir /sync).
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
                            "error": "Cette demande a deja ete traitee",
                            "code": "deja_traitee",
                        }), 409

                    creation = joueur_id is None
                    if creation:
                        # Re-valide maintenant : add_tournament a pu creer la fiche entre-temps.
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

                    # Verrou sur la fiche joueur convoitee.
                    cur.execute(
                        "SELECT id FROM comptes WHERE joueur_id = %s FOR UPDATE",
                        (joueur_id,),
                    )
                    occupant = cur.fetchone()
                    if occupant is not None and occupant[0] != compte_id:
                        # Relache le verrou pose sur la fiche joueur : sans ca on
                        # s'en remet au rollback implicite de putconn().
                        conn.rollback()
                        return jsonify({
                            "error": "Cette fiche vient d'etre rattachee a un autre compte",
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
                            "fiche_creee": creation})
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
        # Le classement est en cache : sans ca, la fiche neuve n'apparait qu'a
        # l'expiration, et l'admin croit que rien ne s'est passe.
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
                        return jsonify({"error": "Deja traitee", "code": "deja_traitee"}), 409

                    cur.execute(
                        """UPDATE liaisons_demandes
                           SET statut = 'rejected', decided_at = now(), decided_by = %s
                           WHERE id = %s""",
                        (_acteur_id(), demande_id),
                    )
                    _audit(cur, 'liaison_refusee', 'compte', compte_id,
                           {"joueur_id": joueur_id, "demande_id": demande_id, "motif": motif})
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
    """Liste des comptes, avec l'ecart entre pseudo Discord et nom du joueur.

    C'est cet ecart qui declenche la proposition de resynchronisation.
    """
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
            "avatar_url": "/avatar/compte/%d" % r[0],
            "joueur_id": r[5], "joueur_nom": nom_joueur,
            "statut": r[6], "role": r[7],
            "created_at": r[8].isoformat(),
            "last_login_at": r[9].isoformat() if r[9] else None,
            "profil_synced_at": r[10].isoformat() if r[10] else None,
            # Vrai seulement si le compte est lie ET que les deux noms different.
            "desynchronise": bool(nom_joueur and pseudo and nom_joueur != pseudo),
            # Role propose et non encore accepte, ou None. Le role ci-dessus
            # reste l'ACTUEL : les confondre ferait croire la promotion faite.
            "promotion_en_attente": r[12],
            # Au moins une ligne du journal dont ce compte est l'acteur -- et
            # que CE lecteur a le droit de lire. Passe par la meme regle que la
            # lecture (_peut_lire_journal) : cette liste est ouverte a tout
            # porteur de gestion_comptes, un simple admin compris, qui n'a pas
            # a apprendre qui a agi. Pour lui, c'est toujours faux.
            "a_un_journal": bool(r[13]) and _peut_lire_journal(g.compte, r[7]),
        })
    return jsonify(comptes)


def _verifier_sync(cur, compte_id):
    """Prepare une synchronisation. Renvoie (donnees, reponse d'erreur).

    Toutes les raisons de refuser sont evaluees ici : l'apercu et l'ecriture
    doivent rendre le meme verdict.
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
            "error": "Ce compte n'est rattache a aucune fiche joueur",
            "code": "non_lie",
        }), 409)

    nouveau = (_pseudo(username, global_name) or '').strip()
    if not nouveau:
        return None, (jsonify({
            "error": "Le pseudo Discord est vide", "code": "pseudo_vide",
        }), 409)

    # joueurs.nom est en varchar(255) ; un pseudo Discord tient toujours, mais
    # on tronque plutot que de laisser la base trancher.
    nouveau = nouveau[:255]

    if '/' in nouveau:
        # L'URL publique est /stats/joueur/<nom> : Flask ne route pas un nom
        # contenant un slash, la fiche deviendrait inatteignable.
        return None, (jsonify({
            "error": "Le pseudo Discord contient un « / », incompatible avec l'URL publique",
            "code": "pseudo_invalide",
        }), 409)

    if nouveau == nom_actuel:
        return None, (jsonify({
            "error": "Le nom du joueur est deja a jour", "code": "deja_synchro",
        }), 409)

    # joueurs.nom est UNIQUE mais sensible a la casse : "Mario" et "mario"
    # coexisteraient tout en etant indiscernables a l'oeil.
    cur.execute(
        "SELECT id, nom FROM joueurs WHERE lower(nom) = lower(%s) AND id <> %s",
        (nouveau, joueur_id),
    )
    collision = cur.fetchone()
    if collision is not None:
        return None, (jsonify({
            "error": "Un autre joueur porte deja ce nom (%s). Renommez-le d'abord, "
                     "ou modifiez le nom a la main." % collision[1],
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
    """Propage le pseudo Discord vers joueurs.nom. Geste ADMIN, jamais automatique.

    joueurs.nom est UNIQUE, circule dans une septantaine de innerHTML et sert
    d'URL publique ; et un pseudo qui change tous les deux jours ferait bouger
    le classement affiche sans que personne l'ait voulu.
    """
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

    # Sans ca, le classement affiche l'ancien nom pendant 5 minutes et l'admin
    # croit que le bouton n'a rien fait.
    invalidate_cache()
    return jsonify({"status": "success", **donnees})


@comptes_bp.route('/admin/comptes/<int:compte_id>/role', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
@compte_cible_protegee
def changer_role(compte_id):
    """Retire un role, ou le fait descendre. Ouverte au chef_admin et au superadmin.

    Ne PROMEUT jamais (R-68, docs/audit-admin-plan.md) : une montee en rang est
    une proposition (proposer_promotion), posee a l'acceptation par la personne
    elle-meme (repondre_promotion). Ce partage entre les deux ecrivains est ce
    qui garantit qu'aucun admin n'est trace sans y avoir consenti.

    Frontiere de privilege de l'application. Le garde-fou du dernier superadmin
    separe « je me suis trompe » de « plus personne ne peut administrer le
    site ».

    Cette route ne pose JAMAIS superadmin : ce role ne se transmet que par legs
    (docs/hierarchie-admin-plan.md 6bis), une transaction unique qui retrograde
    l'ancien et promeut le nouveau. La garde du dernier superadmin ci-dessous
    est ce qui porte le « jamais zero » ICI ; le legs le porte autrement, par
    son atomicite -- d'ou deux routes distinctes, a ne pas fusionner (6bis.1).

    Portee par acteur : le superadmin fait descendre un chef_admin (vers admin
    ou player) ou un admin (vers player) ; un chef_admin seulement un admin. Il
    ne peut pas toucher une cible deja chef_admin : c'est compte_cible_protegee
    qui l'en empeche, pas ce corps de fonction (R-56). Le refus « un chef_admin
    ne designe pas un pair » ci-dessous est garde : il repond 403 avant toute
    I/O, la ou le refus de promotion attend la lecture du role actuel.
    """
    acteur = g.compte
    acteur_est_superadmin = acteur['role'] == ROLE_SUPERADMIN

    corps = request.get_json(silent=True) or {}
    nouveau = corps.get('role')
    if nouveau not in ROLE_HIERARCHY:
        return jsonify({
            "error": "Role invalide", "code": "role_invalide",
            "roles": sorted(ROLE_HIERARCHY, key=ROLE_HIERARCHY.get),
        }), 400

    # Le role superadmin ne s'attribue pas : il se legue. Sans ce refus,
    # ROLE_HIERARCHY (qui a gagne chef_admin) laisserait poser 'superadmin'
    # ici et heurter idx_comptes_superadmin_unique.
    if nouveau == ROLE_SUPERADMIN:
        return jsonify({
            "error": "Le role superadmin ne s'attribue pas : il se legue.",
            "code": "superadmin_non_attribuable",
        }), 400

    # Un chef_admin ne designe pas un pair : seul le superadmin le fait
    # (plan 2, contrainte 3).
    if nouveau == ROLE_CHEF_ADMIN and not acteur_est_superadmin:
        return jsonify({
            "error": "Seul le super-administrateur peut designer un chef d'administration.",
            "code": "droits_insuffisants",
        }), 403

    # Auto-modification de role interdite, superadmin compris : sa seule sortie
    # du role est le legs (plan 2, contrainte 4).
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

                    # R-68 : cette route ne fait plus que DESCENDRE. Toute
                    # montee en rang (player -> admin, admin -> chef_admin...)
                    # passe par une proposition que la personne accepte
                    # (/promotion), parce que le consentement prealable a la
                    # tracabilite nominative est une exigence RGPD, pas une
                    # politesse : un tiers ne consent pas a la place de
                    # quelqu'un. L'IHM routait deja ainsi, mais un lien cache
                    # n'est pas un acces ferme -- sans ce refus, un POST a la
                    # main promouvait sans rien demander.
                    #
                    # Le superadmin n'est pas concerne : il ne s'obtient ni ici
                    # (refuse plus haut) ni par proposition, seulement par legs
                    # ou par l'amorcage de DISCORD_SUPERADMIN_ID
                    # (auth_discord.promote_bootstrap_superadmin), que ce refus
                    # ne touche pas.
                    if ROLE_HIERARCHY[nouveau] > ROLE_HIERARCHY[ancien]:
                        conn.rollback()
                        return jsonify({
                            "error": "Une promotion ne s'impose pas : proposez le role, "
                                     "la personne l'acceptera depuis son compte.",
                            "code": "promotion_par_proposition",
                        }), 409

                    # CEINTURE. Depuis la hierarchie a 4 roles, ce cas n'est plus
                    # atteignable par cette route : une cible superadmin est
                    # arretee avant par compte_cible_protegee (403), et l'acteur
                    # lui-meme par refuse_auto_modification (403). Un superadmin
                    # ne quitte son role que par le legs.
                    #
                    # Conservee volontairement : elle ne coute qu'un SELECT dans
                    # un cas qui ne se produit pas, et redeviendrait la derniere
                    # barriere si l'un de ces deux gardes sautait. Ne pas la
                    # retirer au motif qu'elle « ne sert jamais ».
                    if ancien == ROLE_SUPERADMIN and nouveau != ROLE_SUPERADMIN:
                        cur.execute(
                            "SELECT COUNT(*) FROM comptes WHERE role = %s AND id <> %s",
                            (ROLE_SUPERADMIN, compte_id),
                        )
                        if cur.fetchone()[0] == 0:
                            conn.rollback()
                            return jsonify({
                                "error": "C'est le dernier super-administrateur. Le retrograder "
                                         "rendrait toute attribution de role impossible, et il "
                                         "n'existe pas de mot de passe de secours. Promouvez "
                                         "d'abord un autre compte.",
                                "code": "dernier_superadmin",
                            }), 409

                    # R-60 : retomber a zero chef_admin retire le filet sur lequel
                    # R-47 s'appuie en cas de verrouillage du superadmin. Pas un
                    # blocage -- le superadmin reste souverain -- mais jamais un
                    # clic silencieux : la confirmation est un champ nomme.
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
                                         "super-administrateur perd son acces, plus personne ne "
                                         "pourra administrer le site sans intervention en base. "
                                         "Confirmez pour continuer.",
                                "code": "dernier_chef_admin",
                            }), 409

                    cur.execute(
                        "UPDATE comptes SET role = %s, updated_at = now() WHERE id = %s",
                        (nouveau, compte_id),
                    )
                    # A-01/A-02 : la duree d'une session est figee a sa creation,
                    # sur le role du moment (create_session). Changer de rang
                    # oblige donc a se reconnecter, dans les deux sens : promu,
                    # le compte garderait une session de joueur (30 jours) ;
                    # retrograde, des sessions ouvertes sur un rang qu'il n'a
                    # plus. Les droits, eux, suivaient deja : le role est relu a
                    # chaque requete. La cible n'est jamais l'acteur
                    # (refuse_auto_modification) : on ne ferme pas sa propre
                    # session ici.
                    cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s",
                                (compte_id,))
                    action = ('role_retire'
                              if ROLE_HIERARCHY[nouveau] < ROLE_HIERARCHY[ancien]
                              else 'role_attribue')
                    _audit(cur, action, 'compte', compte_id,
                           {"ancien": ancien, "nouveau": nouveau, "origine": "ihm"})

                    # R-53 : quitter le role admin purge les permissions a la
                    # carte. Sans ca, un compte retrograde puis re-promu plus
                    # tard retrouverait des droits que personne n'a redonnes.
                    if ancien == ROLE_ADMIN and nouveau != ROLE_ADMIN:
                        cur.execute("DELETE FROM permissions_admin WHERE compte_id = %s",
                                    (compte_id,))
                        if cur.rowcount:
                            _audit(cur, 'permissions_purgees', 'compte', compte_id,
                                   {"motif": "sortie_role_admin", "nouveau_role": nouveau})
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
# Permissions a la carte -- accordees a un compte role=admin, une par une.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Promotion : une proposition, pas un decret
# ---------------------------------------------------------------------------
# Phase 1bis de docs/audit-admin-plan.md. Le role d'admin ne s'impose plus, il
# s'accepte -- et la raison est juridique avant d'etre courtoise.
#
# A partir de la phase 2, les actions d'un admin sont tracees NOMINATIVEMENT,
# conservees sans limite de duree, et survivent a la suppression de son compte.
# Le RGPD impose d'informer AVANT. Le consentement aux CGU, donne a la creation
# du compte quand la personne etait `player`, ne peut pas couvrir un traitement
# qui n'existait pas encore : un consentement ne vaut pas pour ce qu'on ne
# pouvait pas connaitre en le donnant.
#
# D'ou trois etats et un seul chemin entre eux :
#
#   player --propose--> proposition EN ATTENTE --accepte--> admin/chef_admin
#                                              --refuse---> player (inchange)
#
# Le role est pose A L'ACCEPTATION, jamais a la proposition. Un tiers ne peut
# pas consentir a la place de quelqu'un.
#
# Le patron est celui de `liaisons_demandes`, deja eprouve ici : etat en
# attente, decision, notification, index unique partiel. Les memes pieges s'y
# appliquent -- notamment la course a l'approbation (R-07), d'ou les FOR UPDATE.

def _promotion_en_attente(cur, compte_id, pour_update=False):
    """Proposition `pending` NON EXPIREE de ce compte, ou None.

    L'expiration est evaluee ICI plutot que par un balayage periodique : une
    ligne expiree reste en base (l'historique a de la valeur) mais ne doit plus
    rien ouvrir. Sans ce filtre, une proposition vieille de huit mois resterait
    acceptable.
    """
    cur.execute(
        """SELECT id, role_propose, propose_par, created_at, expires_at
           FROM promotions_proposees
           WHERE compte_id = %s AND statut = 'pending' AND expires_at > now()
           ORDER BY id DESC LIMIT 1""" + (" FOR UPDATE" if pour_update else ""),
        (compte_id,),
    )
    return cur.fetchone()


@comptes_bp.route('/admin/comptes/<int:compte_id>/promotion', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
@compte_cible_protegee
def proposer_promotion(compte_id):
    """Propose un role a un compte. Ne pose RIEN : la cible decide.

    Reprend a l'identique les plafonds par acteur de `changer_role` -- un
    chef_admin ne designe pas un pair, superadmin ne s'attribue pas -- parce
    que proposer un role qu'on n'a pas le droit d'attribuer reviendrait a
    contourner ces regles par un detour.
    """
    acteur = g.compte
    corps = request.get_json(silent=True) or {}
    role = corps.get('role')

    if role not in (ROLE_ADMIN, ROLE_CHEF_ADMIN):
        return jsonify({
            "error": "Seuls les roles admin et chef_admin se proposent.",
            "code": "role_non_proposable",
        }), 400

    # Meme plafond que changer_role : un chef_admin ne designe pas un pair.
    if role == ROLE_CHEF_ADMIN and acteur['role'] != ROLE_SUPERADMIN:
        return jsonify({
            "error": "Seul le super-administrateur peut designer un chef d'administration.",
            "code": "droits_insuffisants",
        }), 403

    erreur = refuse_auto_modification(_acteur_id(), compte_id)
    if erreur is not None:
        return erreur

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    # FOR UPDATE des la lecture du compte : deux chef_admin qui
                    # proposent simultanement doivent se serialiser ici, sinon
                    # l'index unique partiel transforme le second en 500.
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
                            "error": "Ce compte porte deja ce role.",
                            "code": "role_inchange",
                        }), 409

                    # Pendant exact du refus de promotion de changer_role
                    # (R-68) : descendre ne se propose pas, cela se fait par
                    # /role. On n'a pas a accepter de PERDRE un role, et une
                    # proposition de descente laisserait la personne garder
                    # indefiniment un rang qu'on veut lui retirer.
                    if ROLE_HIERARCHY[role] < ROLE_HIERARCHY[role_actuel]:
                        conn.rollback()
                        return jsonify({
                            "error": "Ce n'est pas une promotion : changez le role "
                                     "directement.",
                            "code": "pas_une_promotion",
                        }), 409

                    # Un compte suspendu ne peut pas se connecter, donc ne
                    # pourra jamais accepter : la proposition resterait en
                    # attente jusqu'a expiration, en bloquant l'index unique.
                    if statut == 'suspended':
                        conn.rollback()
                        return jsonify({
                            "error": "Ce compte est suspendu : il ne pourrait pas accepter.",
                            "code": "compte_suspendu",
                        }), 409

                    if _promotion_en_attente(cur, compte_id, pour_update=True):
                        conn.rollback()
                        return jsonify({
                            "error": "Une proposition est deja en attente pour ce compte.",
                            "code": "promotion_deja_en_attente",
                        }), 409

                    # Les propositions perimees encore 'pending' bloqueraient
                    # l'index unique partiel. On les solde avant d'inserer.
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
                        "Un administrateur vous propose ce role. Ouvrez votre compte "
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
    """Retire une proposition en attente. Le proposant peut se retracter.

    Sans cette route, la seule sortie d'une proposition serait que la personne
    reponde -- et une proposition faite par erreur resterait affichee sur sa
    ligne pendant trente jours.
    """
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
    """Ce que le titulaire doit accepter, s'il y a quelque chose.

    Deux choses distinctes peuvent etre en attente, et l'ecran doit savoir
    laquelle :

      - une PROPOSITION de role, pour un compte qui n'est pas encore admin ;
      - un CONSENTEMENT manquant, pour un admin promu AVANT cette mecanique
        (migration du 18/09) ou dont la politique a change de version.

    Le second cas est une regularisation, pas une punition : l'acces n'est pas
    bloque entre-temps, mais la phase 2 ne tracera ses actions qu'une fois le
    consentement donne.
    """
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
    """Accepte ou refuse la proposition. C'est ICI que le role est pose.

    Le corps porte `accepte` (booleen) et, en cas d'acceptation,
    `cgu_admin_version` -- l'acceptation du role et celle de la politique sont
    un seul geste, et refuser de les separer est deliberé : accepter le role
    sans la politique laisserait un admin trace sans l'avoir su.
    """
    compte = g.compte
    corps = request.get_json(silent=True) or {}
    accepte = corps.get('accepte') is True

    if accepte and corps.get('cgu_admin_version') != CGU_ADMIN_VERSION:
        return jsonify({
            "error": "La politique administrateur doit etre acceptee dans sa version courante.",
            "code": "version_cgu_admin",
            "attendue": CGU_ADMIN_VERSION,
        }), 400

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    # Verrou sur le COMPTE avant la proposition : meme ordre que
                    # dans proposer_promotion, sinon deux transactions qui se
                    # croisent s'interbloquent (R-07).
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
                                     "ou etre annulee.",
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
                        # Le proposant a pu partir entre-temps : notifier()
                        # ignore un compte_id nul, rien a verifier ici.
                        # Sans lien, volontairement : c'est un accuse de
                        # reception, il n'y a rien a faire dessus -- et le
                        # proposant a pu perdre l'acces a /admin/comptes.
                        # Le pseudo est fige ici comme le reste du texte : le
                        # proposant peut recevoir plusieurs reponses, et « le
                        # compte » ne lui disait pas laquelle il lisait.
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

                    # ACCEPTATION : le role est pose ici, et seulement ici.
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
                    # A-01 : TOUTES les sessions, celle-ci comprise. C'est la
                    # session de joueur qui vient d'accepter, ouverte pour 30
                    # jours : la garder donnerait a un admin soixante fois la
                    # duree que la regle lui destine. La personne se reconnecte
                    # (le frontend purge son jeton et relance Discord) et
                    # obtient une session d'admin, avec un jeton neuf.
                    cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s",
                                (compte['id'],))
                    _audit(cur, 'role_attribue', 'compte', compte['id'],
                           {"ancien": compte['role'], "nouveau": role,
                            "origine": "acceptation", "promotion_id": promotion_id,
                            "propose_par": proposant})

                    # R-53, comme dans changer_role : un admin qui accepte
                    # chef_admin quitte le role admin, ses permissions a la
                    # carte tombent. Depuis que changer_role ne promeut plus
                    # (R-68), ce chemin est le SEUL par lequel admin devient
                    # chef_admin -- sans la purge ici, un chef_admin retrograde
                    # plus tard en admin retrouverait des droits que personne
                    # ne lui a redonnes. Role relu sous verrou, pas g.compte.
                    if role_actuel == ROLE_ADMIN and role != ROLE_ADMIN:
                        cur.execute("DELETE FROM permissions_admin WHERE compte_id = %s",
                                    (compte['id'],))
                        if cur.rowcount:
                            _audit(cur, 'permissions_purgees', 'compte', compte['id'],
                                   {"motif": "sortie_role_admin", "nouveau_role": role})
                    # Sans lien, pour la meme raison que le refus ci-dessus.
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
    # `session_fermee`, meme nom que dans DELETE /auth/mes-sessions : le jeton
    # qui a porte cette requete n'ouvre plus rien.
    return jsonify({"status": "success", "accepte": True, "role": role,
                    "session_fermee": True})


@comptes_bp.route('/me/cgu-admin', methods=['POST'])
@player_required
def accepter_cgu_admin():
    """Consentement d'un admin DEJA en poste (regularisation).

    Sert les admins promus avant cette mecanique, et le jour ou la politique
    changera de version. Ne pose aucun role -- il est deja la.
    """
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
                _audit(cur, 'cgu_admin_acceptee', 'compte', compte['id'],
                       {"version": CGU_ADMIN_VERSION})
            conn.commit()
    except Exception as e:
        logger.error("Acceptation CGU admin du compte %s impossible: %s", compte['id'], e)
        return jsonify({"error": "Erreur serveur"}), 500

    return jsonify({"status": "success", "cgu_admin_version": CGU_ADMIN_VERSION})



# ---------------------------------------------------------------------------
# Journal d'audit : la lecture
# ---------------------------------------------------------------------------
# Phase 3 de docs/audit-admin-plan.md. Jusqu'ici la table ne recevait que des
# INSERT : aucun SELECT nulle part, donc un journal que personne ne pouvait
# lire. Ecrire sans jamais relire, c'est se donner bonne conscience.
#
# TROIS chemins de lecture, UNE seule requete. Le volet par compte, l'onglet
# complet et l'export sont trois vues du meme filtre : les separer en trois
# requetes les ferait diverger, et la premiere a oublier le garde de rang
# deviendrait le contournement de la regle.

AUDIT_PAGE = 50
AUDIT_PAGE_MAX = 200


def _peut_lire_journal(acteur, cible_role):
    """Qui peut lire le journal de qui. Arbitre le 2026-09-19.

        superadmin  -> tout le monde
        chef_admin  -> tout le monde SAUF le superadmin (ses pairs compris)
        admin       -> personne (la route lui est fermee)
        player      -> personne

    ⚠️ Cette regle N'EST PAS celle de `compte_cible_protegee`, et l'ecart est
    delibere. Ce decorateur exige un rang STRICTEMENT superieur, parce qu'il
    protege une ACTION : suspendre un pair, lui retirer un role. Ici on ne fait
    que LIRE, et un chef_admin qui ne verrait pas les actions de ses pairs ne
    pourrait pas exercer la surveillance qui justifie ce journal -- c'est
    precisement entre gens de meme rang que le controle mutuel a du sens.
    Le §6.2 du plan proposait le rang strict ; l'arbitrage l'a elargi.

    Seul le superadmin reste hors de portee : il est le sommet, personne ne le
    surveille par ce biais.
    """
    if acteur['role'] == ROLE_SUPERADMIN:
        return True
    if acteur['role'] == ROLE_CHEF_ADMIN:
        # Un role inconnu est traite comme superadmin : l'inconnu ne donne
        # jamais d'acces, meme regle que partout ailleurs dans le projet.
        return cible_role not in (ROLE_SUPERADMIN, None) and cible_role in ROLE_HIERARCHY
    return False


def _lire_journal(cur, acteur, compte_id=None, avant_id=None, limite=AUDIT_PAGE):
    """Les lignes du journal visibles par cet acteur, les plus recentes d'abord.

    `compte_id` restreint a un acteur precis (le volet) ; sans lui, c'est le
    journal complet (l'onglet). `avant_id` pagine par CURSEUR et non par
    OFFSET : un OFFSET saute des lignes des qu'une nouvelle s'insere pendant
    la consultation -- et sur un journal qui s'ecrit en continu, ca arrive.

    Le filtre de rang est applique EN SQL et non a l'affichage : rendre les
    lignes puis les masquer les aurait fait transiter, et la pagination
    compterait des lignes invisibles -- une page de 50 en afficherait 12.
    """
    conditions = []
    params = []

    # Les roles que cet acteur a le droit de lire. Un superadmin lit tout, y
    # compris les lignes dont l'acteur a ete supprime (acteur_compte_id NULL).
    if acteur['role'] != ROLE_SUPERADMIN:
        roles_lisibles = [r for r in ROLE_HIERARCHY
                          if _peut_lire_journal(acteur, r)]
        if not roles_lisibles:
            return []
        # Le rang est relu EN BASE a chaque consultation, jamais pris dans
        # details.acteur : une personne retrogradee depuis ne doit pas rester
        # lisible au motif qu'elle etait admin au moment de l'action.
        #
        # ⚠️ Corollaire assume : les lignes d'un compte SUPPRIME (jointure
        # nulle) ne sont visibles que du superadmin. Un chef_admin ne peut pas
        # verifier le rang de quelqu'un qui n'existe plus, donc il ne le lit
        # pas -- prudence plutot que fuite.
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
    """Une ligne du journal, prete a afficher.

    Le pseudo vient de la JOINTURE tant que le compte existe, et retombe sur
    `details.acteur.pseudo` quand il a ete supprime -- c'est precisement ce
    que la denormalisation du §6.3 sert a faire. Une ligne dont l'acteur a
    disparu AVANT cette denormalisation (septembre) n'a ni l'un ni l'autre :
    elle sort avec un acteur nul, et c'est la verite.
    """
    details = r[5] or {}
    denorme = details.get('acteur') or {}
    return {
        "id": r[0],
        "action": r[1],
        "acteur_compte_id": r[2],
        "acteur_pseudo": r[7] or denorme.get('pseudo'),
        # Vrai quand le compte n'existe plus : l'ecran doit pouvoir le dire,
        # sinon on lit « Jérémy » sans savoir que le compte a ete supprime.
        "acteur_supprime": r[2] is None,
        "acteur_role": denorme.get('role'),
        "cible_type": r[3],
        "cible_id": r[4],
        # Le bloc `acteur` est retire des details affiches : il est deja
        # remonte en colonnes ci-dessus, et le laisser ferait doublon dans
        # chaque ligne de l'ecran.
        "details": {k: v for k, v in details.items() if k != 'acteur'},
        "created_at": r[6].isoformat(),
    }


@comptes_bp.route('/admin/comptes/<int:compte_id>/audit', methods=['GET'])
@role_required(ROLE_CHEF_ADMIN)
def journal_du_compte(compte_id):
    """Les actions d'administration d'UN compte (le volet de sa ligne).

    ⚠️ PAS de `compte_cible_protegee` ici, et c'est deliberé : ce decorateur
    refuse le rang EGAL, ce qui interdirait a un chef_admin de lire le journal
    d'un pair. Or lire n'est pas agir, et c'est entre gens de meme rang que la
    surveillance mutuelle a du sens (arbitrage du 2026-09-19).

    La regle de lecture vit donc dans `_lire_journal`, UNE SEULE FOIS, pour les
    trois chemins. Un compte hors de portee -- le superadmin vu par un
    chef_admin -- ressort avec une liste VIDE plutot qu'un 403 : la route ne
    doit pas devenir un revelateur de rang pour qui la sonde.
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
        # Le curseur de la page suivante, ou None. Calcule ici plutot que
        # devine par le frontend : lui faire lire le dernier id supposerait
        # qu'il connait l'ordre de tri.
        "avant_id": sorties[-1]['id'] if len(sorties) == limite else None,
    })


@comptes_bp.route('/admin/audit', methods=['GET'])
@role_required(ROLE_CHEF_ADMIN)
def journal_complet():
    """Le journal entier (l'onglet Logs), meme filtre de rang, sans cible.

    Repond a « meme si le compte n'est plus admin, ou n'existe plus » : la
    requete ne filtre pas sur le role ACTUEL de la cible d'une action, mais
    sur celui de l'ACTEUR -- et les lignes restent la quoi qu'il arrive.
    """
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


# Cellules commencant par ces caracteres : Excel et LibreOffice les
# interpretent comme des FORMULES. Un pseudo Discord « =cmd » deviendrait donc
# du code a l'ouverture du fichier. On prefixe d'une apostrophe, qui force le
# texte et reste invisible a l'affichage.
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
    """Le journal entier en CSV, par streaming.

    EN STREAMING et non materialise : ce journal ne se purge jamais (§4), donc
    un `SELECT *` chargerait un jour toute la table en memoire et tomberait --
    le jour ou l'on cherche justement quelque chose. On pagine en interne par
    curseur et on rend les lignes au fil de l'eau ; la memoire reste bornee a
    une page quelle que soit la taille du journal.

    CSV et non JSON : un export de journal sert a CHERCHER -- trier par date,
    filtrer une action, retrouver qui a touche a un joueur. Ca se fait dans un
    tableur. `details` reste du JSON dans sa propre colonne : rien n'est perdu,
    et les colonnes qui portent l'essentiel des recherches sont triables.

    MEME filtre de rang que les deux vues : l'export ne doit jamais montrer ce
    que l'ecran masque.
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

        # BOM UTF-8 : sans lui, Excel lit le fichier en latin-1 et rend les
        # accents illisibles. Inoffensif pour tout le reste.
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

                        # Le curseur doit AVANCER strictement. Sans ce garde,
                        # une source qui rend deux fois la meme page boucle a
                        # l'infini -- et un export qui ne se termine jamais
                        # tient la connexion ouverte jusqu'au timeout, sans
                        # rien dire. Constate au premier jet contre un curseur
                        # de test qui rejoue sa reponse ; le meme blocage
                        # viendrait d'un ORDER BY perdu.
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
            # Le flux a deja commence : impossible de renvoyer un 500 propre.
            # On journalise et on ferme sur une ligne qui DIT que l'export est
            # incomplet -- un fichier tronque en silence se lirait comme un
            # journal qui s'arrete la.
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
    """Permissions d'un compte, plus le catalogue delegable par l'acteur.

    Lecture seule : pas de compte_cible_protegee, voir un compte n'est pas agir
    dessus (plan 4.4, point B).
    """
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
        # Ce que l'acteur peut accorder, pour que l'IHM grise le reste. Le
        # backend reste seul juge : ce champ informe, il n'autorise pas.
        "delegables": sorted(permissions_delegables_par(g.compte)),
    })


@comptes_bp.route('/admin/comptes/<int:compte_id>/permissions/<permission>', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
@compte_cible_protegee
def accorder_permission(compte_id, permission):
    """Accorde une permission nommee a un compte role=admin.

    Trois refus distincts, a ne pas confondre : la permission n'existe pas
    (catalogue), l'acteur ne la possede pas lui-meme (plafond, contrainte 5),
    la cible n'est pas un admin (les autres roles n'en ont pas l'usage).
    """
    if permission not in PERMISSIONS_CATALOGUE:
        return jsonify({
            "error": "Permission inconnue", "code": "permission_inconnue",
            "permissions": sorted(PERMISSIONS_CATALOGUE),
        }), 400

    # « Il ne peut pas donner des droits qu'il n'a pas » (plan 2, contrainte 5).
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
                            "error": "Les permissions ne s'accordent qu'a un compte admin. "
                                     "Un chef d'administration a deja tout le catalogue.",
                            "code": "cible_non_admin",
                        }), 409

                    # Une sous-permission sans son parent ne donnerait aucun
                    # droit (permission_required exige les deux) : l'accorder
                    # afficherait une case cochee sans effet. Refus explicite
                    # plutot qu'un 200 trompeur. Lu dans la transaction, apres le
                    # FOR UPDATE : le parent ne peut pas disparaitre entre-temps.
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
                                "error": "Ce droit complete « %s », qui doit etre accorde "
                                         "d'abord." % parent,
                                "code": "parent_manquant",
                                "parent": parent,
                            }), 409

                    # accorde_par vient de la session, JAMAIS du corps (R-49).
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
    """Retire une permission. Un DELETE, pas un drapeau : permissions_admin est
    l'etat courant des droits, l'historique vit dans audit_admin (plan 3.3).

    Le plafond s'applique aussi au retrait : sans ca, un acteur pourrait defaire
    ce qu'il n'aurait pas pu faire.
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

    # Retirer un parent emporte ses sous-permissions : laissees seules elles ne
    # donneraient aucun droit (permission_required exige le parent), mais elles
    # resteraient cochees dans l'interface et reviendraient a la vie au moindre
    # re-octroi du parent -- un droit rendu sans que personne ne l'ait decide.
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
# Legs du role superadmin -- geste unique, atomique, irreversible.
# ---------------------------------------------------------------------------

@comptes_bp.route('/admin/comptes/<int:compte_id>/leguer-superadmin', methods=['POST'])
@role_required(ROLE_SUPERADMIN)
# PAS de @compte_cible_protegee : ce decorateur refuse toute action sur un
# superadmin, or l'acteur EST le superadmin et la cible ne l'est pas encore.
# La protection equivalente est portee par role_required(SUPERADMIN) ci-dessus
# (seul le superadmin appelle) et par le refus d'auto-legs plus bas.
def leguer_superadmin(compte_id):
    """Legue le role superadmin a un admin ou chef_admin qui a consenti.

    SECONDE route qui ecrit comptes.role, avec changer_role -- exception
    deliberee et etroite a R-40. Ne JAMAIS fusionner les deux : la garde du
    dernier superadmin de changer_role refuserait precisement la retrogradation
    par laquelle ce legs commence. Chacune porte le « jamais zero » a sa facon,
    l'une par un refus, l'autre par son atomicite (plan 6bis.1).

    L'ancien superadmin devient chef_admin : il redevient touchable par le
    nouveau, sans retomber a zero.

    Cible restreinte depuis le 2026-09-23 (R-68). Le plan 6bis ouvrait le legs
    a « n'importe quel compte, quel que soit son role », decide le 10/09 --
    AVANT que le consentement a la politique administrateur existe (18/09).
    Leguer a un player le faisait superadmin, trace nominativement, sans qu'il
    ait rien accepte : le meme contournement que la promotion directe par
    /role. La cible doit donc etre admin ou chef_admin (elle a accepte un role
    d'administration) ET avoir accepte la politique en version courante. Pour
    leguer a un player : lui proposer admin d'abord.

    L'amorcage (DISCORD_SUPERADMIN_ID) n'est pas concerne : c'est la personne
    elle-meme qui se connecte, et sa regularisation passe par /me/cgu-admin.
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
                    # Les deux lignes verrouillees en UNE requete, triees par id :
                    # deux SELECT ... FOR UPDATE dans un ordre dependant des
                    # parametres sont un interblocage en attente.
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

                    # Role de l'acteur relu SOUS verrou : role_required l'a lu
                    # avant la transaction, et deux legs concurrents ne doivent
                    # pas reussir tous les deux.
                    moi = lignes.get(acteur_id)
                    if moi is None or moi[1] != ROLE_SUPERADMIN:
                        conn.rollback()
                        return jsonify({
                            "error": "Vous n'etes plus super-administrateur.",
                            "code": "plus_superadmin",
                        }), 409

                    # Consentement de la cible, lu sous le meme verrou que son
                    # role : entre l'affichage et le clic, elle a pu etre
                    # retrogradee. Avant la confirmation, pour que le refus
                    # dise le vrai blocage plutot qu'un pseudo a retaper.
                    if (cible[1] not in (ROLE_ADMIN, ROLE_CHEF_ADMIN)
                            or cible[3] != CGU_ADMIN_VERSION):
                        conn.rollback()
                        return jsonify({
                            "error": "Ce compte n'a pas accepte de role d'administration "
                                     "dans la version courante de la politique. Proposez-lui "
                                     "d'abord le role admin : le legs ne se fait qu'a un "
                                     "compte qui a consenti.",
                            "code": "legs_sans_consentement",
                        }), 409

                    # Confirmation forte sur discord_username (le handle stable),
                    # jamais sur le nom d'affichage : celui-ci est librement
                    # modifiable et un homonyme rendrait la confirmation vide de
                    # sens (plan 6bis.2).
                    if not confirmation or confirmation != cible[2]:
                        conn.rollback()
                        return jsonify({
                            "error": "Le pseudo saisi ne correspond pas au compte cible.",
                            "code": "confirmation_invalide",
                        }), 400

                    ancien_role_cible = cible[1]

                    # ORDRE IMPOSE par l'index partiel non-deferrable (plan 3.2) :
                    # retrograder l'ancien AVANT de promouvoir le nouveau.
                    # L'inverse leve 23505 a chaque tentative.
                    cur.execute(
                        "UPDATE comptes SET role = %s, updated_at = now() WHERE id = %s",
                        (ROLE_CHEF_ADMIN, acteur_id),
                    )
                    cur.execute(
                        "UPDATE comptes SET role = %s, updated_at = now() WHERE id = %s",
                        (ROLE_SUPERADMIN, compte_id),
                    )

                    # Deux roles changent, deux comptes se reconnectent (A-01/A-02,
                    # voir changer_role). La cible surtout : si elle etait player,
                    # elle deviendrait superadmin sur une session de 30 jours.
                    # L'acteur aussi, session courante comprise -- meme regle,
                    # sans exception a retenir : le frontend le reconnecte.
                    cur.execute(
                        "DELETE FROM sessions_joueurs WHERE compte_id IN (%s, %s)",
                        (acteur_id, compte_id),
                    )

                    # La cible quitte le role admin : meme purge qu'ailleurs (R-53).
                    if ancien_role_cible == ROLE_ADMIN:
                        cur.execute("DELETE FROM permissions_admin WHERE compte_id = %s",
                                    (compte_id,))
                        if cur.rowcount:
                            _audit(cur, 'permissions_purgees', 'compte', compte_id,
                                   {"motif": "legs_superadmin"})

                    # UNE seule ligne d'audit : c'est un seul geste (plan 3.4).
                    _audit(cur, 'superadmin_legue', 'compte', compte_id,
                           {"ancien": acteur_id, "nouveau": compte_id,
                            "ancien_role_cible": ancien_role_cible})
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
    """Ferme toutes les sessions d'un compte, sur tous ses appareils.

    Pour un compte compromis. Un changement de role n'a plus besoin d'elle :
    toute ecriture de comptes.role ferme deja les sessions du compte (A-01/A-02).

    Le decorateur accepte les deux voies d'authentification : sur
    `role_required` seul, un admin connecte par mot de passe voyait un bouton
    mort.
    """
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
    """Detache un compte de sa fiche joueur. L'inverse de /approve.

    Rien n'est detruit : seul le lien saute, la fiche redevient revendicable
    et la personne peut se rattacher de nouveau.

    Nomme `delier` et non `sync` : /sync existe deja pour une tout autre
    operation, la propagation du pseudo Discord vers joueurs.nom.
    """
    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    # FOR UPDATE : sans lui, un deliement concurrent d'une approbation laisse
                    # joueur_id dans l'etat que l'ordre d'arrivee decide.
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
                            "error": "Ce compte n'est rattache a aucune fiche joueur",
                            "code": "non_lie",
                        }), 409

                    # Une suspension est une decision independante du rattachement.
                    nouveau_statut = 'pending' if statut == 'linked' else statut

                    # profil_synced_at datait une propagation vers une fiche qui n'est plus la
                    # sienne.
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

    # Meme raison : l'avatar disparait de /stats/joueurs des le deliement.
    invalidate_cache()
    logger.info("Compte %s delie du joueur %s (par %s)", compte_id, joueur_id, _acteur_id())
    return jsonify({"status": "success", "joueur_id": joueur_id, "statut": nouveau_statut})


# ---------------------------------------------------------------------------
# « Jamais zero superadmin » -- la regle, appliquee partout
# ---------------------------------------------------------------------------
# Referme B-02 et B-03. La garde existait deja dans changer_role, mais elle
# avait ete posee la ou on la CHERCHE : sur la route qui ecrit `role`. Or deux
# autres chemins menent au meme resultat sans jamais toucher a cette colonne --
# suspendre (ecrit `statut`) et supprimer (efface la ligne). C'est un angle
# mort de repartition, pas une negligence.
#
# La suspension est le pire des deux, alors qu'elle parait la plus anodine :
#
#   - supprimer est RATTRAPABLE si DISCORD_SUPERADMIN_ID est encore renseigne,
#     le compte n'existant plus, l'amorcage le laisse rentrer ;
#   - suspendre ne l'est PAS : le compte existe toujours, donc l'amorcage n'est
#     jamais consulte, et login() refuse en amont sur le statut. Seul un UPDATE
#     SQL en production repare.
#
# D'ou une regle unique, et non deux gardes distinctes : un compte ne peut pas
# se retirer a lui-meme la capacite d'administrer s'il est le dernier a la
# detenir. Le superadmin qui veut vraiment partir LEGUE d'abord -- c'est
# exactement le geste prevu pour ca.

def _dernier_de_son_role(cur, compte_id: int, role: str) -> bool:
    """Vrai si ce compte est le dernier a porter ce role.

    Meme requete que celle de changer_role, volontairement : une divergence
    entre les deux donnerait deux definitions du « dernier », et c'est le genre
    d'ecart qu'on ne decouvre qu'une fois dehors.
    """
    cur.execute(
        "SELECT COUNT(*) FROM comptes WHERE role = %s AND id <> %s",
        (role, compte_id),
    )
    return cur.fetchone()[0] == 0


def _refus_auto_verrouillage(cur, compte_id: int, role: str, geste: str):
    """Renvoie une reponse 409 si ce geste laisserait le site sans superadmin.

    `geste` est le verbe a afficher (« suspendre », « supprimer »). Renvoie
    None quand il n'y a rien a empecher -- l'appelant continue.
    """
    if role != ROLE_SUPERADMIN or not _dernier_de_son_role(cur, compte_id, ROLE_SUPERADMIN):
        return None
    return jsonify({
        "error": "Vous etes le dernier super-administrateur. Vous %s maintenant "
                 "rendrait toute administration impossible, et il n'existe pas de "
                 "mot de passe de secours. Leguez d'abord votre role a un autre "
                 "compte." % geste,
        "code": "dernier_superadmin",
    }), 409


@comptes_bp.route('/admin/comptes/<int:compte_id>/statut', methods=['POST'])
@permission_required('gestion_comptes')
@compte_cible_protegee
def changer_statut(compte_id):
    """Suspend ou reactive un compte. Ne touche jamais au role ni au joueur lie."""
    nouveau = (request.get_json(silent=True) or {}).get('statut')
    if nouveau not in ('linked', 'pending', 'suspended'):
        return jsonify({"error": "Statut invalide"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT statut, role FROM comptes WHERE id = %s FOR UPDATE",
                            (compte_id,))
                row = cur.fetchone()
                if row is None:
                    conn.rollback()
                    return jsonify({"error": "Compte introuvable"}), 404

                # B-02.2 / B-03. Suspendre est fonctionnellement AUSSI FORT que
                # retrograder -- ca ferme les sessions et interdit la
                # reconnexion -- mais c'etait traite comme un geste mineur.
                # `compte_cible_protegee` laisse deliberement passer
                # l'auto-action (« fermer ses propres sessions est legitime »),
                # ce qui est juste pour les sessions et faux pour le statut :
                # c'est precisement par la que le superadmin se mettait dehors.
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
                    # Sans fermer les sessions, la suspension ne serait qu'un libelle d'affichage.
                    cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s", (compte_id,))
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

# On stocke un IDENTIFIANT, jamais une URL : une URL complete saisie par le
# joueur atterrirait dans un href, et un « javascript: » suffirait a executer
# du script chez tous les visiteurs de sa fiche.
RESEAUX_CONNUS = {
    'twitch':  'https://twitch.tv/%s',
    'youtube': 'https://youtube.com/@%s',
    'bluesky': 'https://bsky.app/profile/%s',
    'twitter': 'https://x.com/%s',
}

# Handles admis par les plateformes ci-dessus : lettres, chiffres, et quelques
# separateurs. Volontairement strict -- on peut toujours elargir.
_RE_HANDLE = re.compile(r'^[A-Za-z0-9_.\-]{1,50}$')
_RE_COULEUR = re.compile(r'^#[0-9A-Fa-f]{6}$')


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
            return None, "La bio doit etre du texte"
        bio = bio.strip()[:500] or None

    couleur = data.get('couleur_accent')
    if couleur is not None:
        if not isinstance(couleur, str) or not _RE_COULEUR.match(couleur.strip()):
            return None, "La couleur doit etre au format #RRGGBB"
        couleur = couleur.strip().upper()

    reseaux = data.get('reseaux')
    if reseaux is None:
        reseaux = {}
    if not isinstance(reseaux, dict):
        return None, "Format de reseaux invalide"
    propres = {}
    for cle, handle in reseaux.items():
        if cle not in RESEAUX_CONNUS:
            return None, "Reseau inconnu : %s" % cle
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
    """Edite le profil du joueur connecte.

    Liste blanche stricte des champs : ni le role, ni le statut, ni le joueur
    rattache ne sont modifiables ici. Une route qui relaierait le corps JSON tel
    quel vers un UPDATE serait une escalade de privilege -- le role est la seule
    frontiere de l'application.

    L'avatar n'est pas editable : il vient de Discord.
    """
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

    # La fiche publique n'est pas cachee (c'est /classement qui l'est), donc
    # l'edition est visible immediatement : rien a invalider.
    return jsonify({"status": "success", **champs,
                    "reseaux_affichables": _reseaux_avec_urls(champs['reseaux'])})


def profil_public(cur, joueur_id):
    """Partie publique du profil d'un joueur, ou None.

    Ne renvoie que ce qui est destine a etre lu par n'importe quel visiteur.
    Le statut du compte, son role et sa date de connexion restent internes.

    A noter : l'URL d'avatar contient le snowflake Discord du joueur. C'est
    inherent au choix « avatar servi par le CDN Discord, aucune copie stockee »,
    et ca revient a publier son identifiant Discord. C'est assumable dans une
    communaute qui se connait, mais ca doit figurer dans la politique de
    confidentialite -- ce n'est pas une consequence evidente pour la personne
    qui clique « se connecter avec Discord ».
    """
    cur.execute(
        # anonymise_at IS NULL : sans cette condition, une fiche anonymisee affichait
        # encore l'avatar, la bio et les liens de son proprietaire -- et l'URL de
        # l'avatar contenait l'identifiant Discord.
        """SELECT c.discord_id, c.discord_avatar_hash, p.bio, p.couleur_accent, p.reseaux
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
    }


# ---------------------------------------------------------------------------
# Avatars, relayes et jamais lies en direct : une <img> vers cdn.discordapp.com
# donnerait a Discord l'IP de chaque visiteur et publierait le snowflake du
# joueur dans la source de la page.
# ---------------------------------------------------------------------------

# Partage entre threads depuis le passage aux workers gthread (2026-09-17), et
# sans verrou volontairement : toutes les operations faites ici sont atomiques
# (`get`, affectation, `clear`), sans sequence lire-puis-supprimer sur une meme
# cle -- contrairement au cache de cache.py, qui a du en recevoir un. Le pire
# cas est que deux threads telechargent le meme avatar en parallele : du travail
# en double, jamais une reponse fausse.
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
@player_required
def avatar_moi():
    return _servir_avatar(g.compte['discord_id'], g.compte['discord_avatar_hash'])


@comptes_bp.route('/avatar/compte/<int:compte_id>', methods=['GET'])
@role_required(ROLE_ADMIN)
def avatar_compte(compte_id):
    """Avatar d'un compte, quel que soit son statut : l'administration montre
    aussi les comptes en attente et suspendus."""
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
    """Compose les lobbies pour la page d'administration.

    Appelle exactement le meme service que /api/bot/matchmaking. C'est tout
    l'interet de l'avoir sorti du navigateur : deux implementations du meme
    algorithme divergent toujours, et l'ecart ne se voit qu'au moment ou un
    lobby est mal compose.
    """
    data = request.get_json(silent=True) or {}
    noms = data.get('noms')
    joueur_ids = data.get('joueur_ids')

    # On exige exactement une liste, comme la route du bot : valider `noms` puis
    # resoudre sur `joueur_ids` parce que le resolveur les teste en premier
    # serait un piege silencieux.
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
            "error": "Selectionnez au moins deux joueurs.",
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
# Jetons de service (bots) -- reserve au super-administrateur
# ---------------------------------------------------------------------------

SCOPES_CONNUS = ('read:joueurs', 'read:classement', 'matchmaking')


@comptes_bp.route('/admin/service-tokens', methods=['GET'])
@role_required(ROLE_SUPERADMIN)
def lister_service_tokens():
    """Liste les jetons. Ne renvoie JAMAIS de jeton : seul le hash existe."""
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
    """Cree un jeton et le renvoie UNE SEULE FOIS.

    Seul le sha256 part en base : le jeton est irrecuperable ensuite. C'est
    aussi ce qui limite les degats d'un dump SQL -- contrairement a l'ancienne
    table api_tokens, qui stockait ses jetons en clair.
    """
    data = request.get_json(silent=True) or {}
    nom = (data.get('nom') or '').strip()[:64]
    scopes = data.get('scopes') or []

    if not nom:
        return jsonify({"error": "Un nom est requis", "code": "nom_manquant"}), 400
    if not isinstance(scopes, list) or not scopes:
        return jsonify({"error": "Au moins une portee est requise", "code": "scopes_manquants"}), 400
    inconnus = [s for s in scopes if s not in SCOPES_CONNUS]
    if inconnus:
        return jsonify({"error": "Portee inconnue : %s" % ', '.join(inconnus),
                        "code": "scope_inconnu", "scopes_valides": list(SCOPES_CONNUS)}), 400

    jours = data.get('jours')
    expires_at = None
    if jours:
        try:
            expires_at = datetime.now(timezone.utc) + timedelta(days=max(1, int(jours)))
        except (TypeError, ValueError):
            return jsonify({"error": "Duree invalide"}), 400

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
        "token": jeton,                  # visible une seule fois
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
                    return jsonify({"error": "Jeton introuvable ou deja revoque"}), 404
                _audit(cur, 'service_token_revoque', 'service_token', token_id)
            conn.commit()
    except Exception as e:
        logger.error("Revocation de jeton impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success"})


# ---------------------------------------------------------------------------
# RGPD : consentement, acces, portabilite, effacement
# ---------------------------------------------------------------------------

@comptes_bp.route('/me/cgu', methods=['POST'])
@player_required
def accepter_cgu():
    """Enregistre l'acceptation des conditions.

    On garde la VERSION acceptee et pas seulement la date : sans elle, on sait
    quand la personne a accepte, mais pas quoi -- ce qui ne demontre rien.
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE comptes SET cgu_accepted_at = now(), cgu_version = %s,
                                          updated_at = now()
                       WHERE id = %s""",
                    (CGU_VERSION, g.compte['id']),
                )
            conn.commit()
    except Exception as e:
        logger.error("Enregistrement du consentement impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success", "cgu_version": CGU_VERSION})


@comptes_bp.route('/me/notifications', methods=['GET'])
@player_required
def mes_notifications():
    """Les 30 dernieres notifications du compte, et le nombre de non-lues.

    Tout en une requete : la navbar l'appelle a chaque chargement de page.
    """
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
    """Ce qui attend une decision d'administrateur, pour les pastilles de la
    navbar. Appelee a chaque chargement de page : elle reste un COUNT."""
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
@player_required
def exporter_mes_donnees():
    """Droit d'acces et de portabilite (art. 15 et 20) : tout, en JSON.

    Inclut le dossier sportif en plus de l'identite. Il n'est pas supprime par
    l'effacement du compte -- raison de plus pour que la personne puisse en
    obtenir copie.
    """
    compte_id = g.compte['id']
    joueur_id = g.compte['joueur_id']
    export = {
        "genere_le": datetime.now(timezone.utc).isoformat(),
        "avertissement": (
            "Le dossier sportif (participations, awards) est rattache a une fiche "
            "joueur pseudonyme et n'est PAS supprime avec le compte. Voir la "
            "politique de confidentialite."
        ),
    }

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT discord_id, discord_username, discord_global_name,
                              discord_avatar_hash, joueur_id, statut, role,
                              cgu_accepted_at, cgu_version, created_at, updated_at,
                              last_login_at, discord_synced_at, profil_synced_at
                       FROM comptes WHERE id = %s""",
                    (compte_id,),
                )
                c = cur.fetchone()
                if c is None:
                    # Le compte a pu etre supprime depuis la validation de la
                    # session : mieux vaut un 404 qu'un TypeError en 500.
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
                }

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

                cur.execute(
                    """SELECT d.statut, d.message, d.created_at, d.decided_at, j.nom
                       FROM liaisons_demandes d JOIN joueurs j ON j.id = d.joueur_id
                       WHERE d.compte_id = %s ORDER BY d.created_at""",
                    (compte_id,),
                )
                export["demandes_de_liaison"] = [{
                    "statut": r[0], "message": r[1], "faite_le": r[2].isoformat(),
                    "decidee_le": r[3].isoformat() if r[3] else None, "joueur": r[4],
                } for r in cur.fetchall()]

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
    """Droit a l'effacement (art. 17), niveau 1 : efface un compte.

    Detruit l'IDENTITE -- compte, profil, sessions, demandes de liaison -- et
    laisse INTACT le dossier sportif, qui appartient a une fiche joueur
    pseudonyme.

    Pourquoi le dossier sportif reste : le moteur TrueSkill est incremental.
    Chaque tournoi part du mu/sigma courant des joueurs et l'ecrase ; il
    n'existe aucune fonction de recalcul depuis zero. Retirer les
    participations d'une personne rendrait le classement de TOUS les autres
    definitivement faux, sans moyen de le reconstruire. Le pseudo de jeu, une
    fois detache de tout identifiant Discord, ne permet plus d'identifier
    raisonnablement la personne.

    Qui veut aller plus loin demande l'anonymisation du pseudo (niveau 2), que
    seul un administrateur peut faire.

    A appeler dans une transaction, le compte deja verrouille (FOR UPDATE) et
    les gardes deja passees : cette fonction n'arbitre rien, elle efface.
    """
    # L'audit AVANT la suppression : la ligne reference le compte, et
    # acteur_compte_id est en ON DELETE SET NULL. On y consigne de quoi rejouer
    # la suppression apres une restauration de sauvegarde (runbook §5), sans
    # conserver la moindre donnee personnelle.
    _audit(
        cur, 'compte_supprime', 'compte', compte_id,
        {
             "joueur_id": joueur_id,
             "origine": origine,
             # Empreinte et non identifiant : permet de verifier apres
             # restauration qu'un compte ressuscite doit etre resupprime, sans
             # reconserver le snowflake.
             "discord_id_hash": hash_token(discord_id),
        },
    )
    # Ordre explicite plutot que de s'en remettre aux CASCADE : le jour ou une
    # contrainte change, on veut que ce soit ce code qui decide de ce qui
    # disparait.
    cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s", (compte_id,))
    cur.execute("DELETE FROM profils WHERE compte_id = %s", (compte_id,))
    cur.execute("DELETE FROM liaisons_demandes WHERE compte_id = %s", (compte_id,))
    cur.execute("DELETE FROM comptes WHERE id = %s", (compte_id,))


# Il n'y a PLUS de `DELETE /me` : depuis le 2026-09-22, le titulaire ne supprime
# plus son compte lui-meme. L'effacement direct etait juge trop dangereux --
# irreversible, a un clic, et a la portee de quiconque tient une session ouverte
# sur un poste partage ou vole. Le bouton de /mon-compte renvoie desormais vers
# une demande ecrite a SITE_CONTACT, executee ici par le superadmin.
#
# Retirer la route et pas seulement le bouton : une route laissee en place reste
# appelable a la main avec un jeton de joueur. L'acces direct serait cache, pas
# ferme. test_rgpd.py verifie qu'aucune route /me n'accepte plus DELETE.
@comptes_bp.route('/admin/comptes/<int:compte_id>', methods=['DELETE'])
@role_required(ROLE_SUPERADMIN)
@compte_cible_protegee
def supprimer_compte(compte_id):
    """Execute une demande d'effacement recue par ecrit.

    Capacite de ROLE, pas permission delegable, comme la purge RGPD : un geste
    irreversible sur l'identite d'une personne n'a pas a se distribuer. Avant de
    l'appeler, verifier que la demande vient bien du titulaire
    (docs/runbook-admin.md §7) -- c'est ce qui la distingue d'une demande
    ecrite par n'importe qui au nom de n'importe qui.
    """
    acteur_id = _acteur_id()

    # Le superadmin est unique : se supprimer laisserait le site sans
    # administration. compte_cible_protegee laisse deliberement passer
    # l'auto-action, d'ou ce refus explicite, comme pour le legs.
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

                    # B-02.1 : jamais zero superadmin. Inatteignable en l'etat
                    # -- la cible superadmin est arretee par
                    # compte_cible_protegee, soi-meme par le refus ci-dessus --
                    # mais c'est la seule garde qui ne depend pas de l'unicite
                    # du role. Elle reste le jour ou il y en aura deux.
                    refus = _refus_auto_verrouillage(cur, compte_id, role, 'supprimer')
                    if refus is not None:
                        conn.rollback()
                        return refus

                    # Confirmation forte sur discord_username, comme le legs :
                    # le handle stable, jamais le nom d'affichage, librement
                    # modifiable. Un clic seul ne doit pas pouvoir effacer une
                    # identite.
                    if not confirmation or confirmation != discord_username:
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

    # /stats/joueurs est en cache 5 minutes et publie les avatars : sans
    # invalidation, celui d'un compte supprime lui survivrait a l'ecran.
    invalidate_cache()
    logger.warning("Compte %s supprime par %s, sur demande ecrite", compte_id, acteur_id)
    return jsonify({
        "status": "success",
        "dossier_sportif_conserve": joueur_id is not None,
    })


@comptes_bp.route('/admin/purge-rgpd', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
def declencher_purge():
    """Lance la purge des donnees expirees.

    Route manuelle et non tache planifiee : le projet n'a pas d'ordonnanceur,
    et une purge qui s'execute toute seule sans que personne ne regarde son
    bilan est une purge dont on ne sait rien. La page d'administration en
    affiche le detail.
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                bilan = purger_donnees_expirees(cur)
            conn.commit()
    except Exception as e:
        logger.error("Purge RGPD impossible: %s", e)
        return jsonify({"error": "Erreur serveur"}), 500
    return jsonify({"status": "success", "bilan": bilan})
