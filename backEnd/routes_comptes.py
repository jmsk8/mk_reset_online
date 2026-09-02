"""Liaison compte <-> joueur, synchronisation des profils, gestion des roles.

Trois gestes vivent ici, et tous les trois sont des gestes ADMIN :

- approuver une revendication d'identite (le joueur declare, l'admin valide) ;
- propager le pseudo Discord vers joueurs.nom (jamais automatique, cf. sync) ;
- attribuer ou retirer un role (reserve au superadmin).

La revendication est purement declarative : n'importe qui disposant d'un lien
d'invitation peut pretendre etre le meilleur joueur du classement. Le seul
controle est la vigilance de l'admin, d'ou l'apercu systematique avant
validation et la preference pour les invitations nominatives.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import secrets
from datetime import datetime, timedelta, timezone

import requests

from flask import Blueprint, jsonify, request, g, make_response

from constants import (ROLE_ADMIN, ROLE_SUPERADMIN, ROLE_HIERARCHY, CGU_VERSION,
                       DEFAULT_MU, DEFAULT_SIGMA, DISCORD_HTTP_TIMEOUT,
                       AVATAR_CACHE_TTL, AVATAR_MAX_BYTES)
from auth import player_required, role_required, admin_or_role_required
from auth_discord import avatar_url, hash_token
from cache import invalidate_cache
from services import (construire_lobbies, resoudre_joueurs_matchmaking,
                      purger_donnees_expirees)
from db import get_db_connection

logger = logging.getLogger(__name__)

comptes_bp = Blueprint('comptes', __name__)


def _audit(cur, action, cible_type=None, cible_id=None, details=None):
    cur.execute(
        """INSERT INTO audit_admin (action, acteur_compte_id, cible_type, cible_id, details)
           VALUES (%s, %s, %s, %s, %s::jsonb)""",
        (action, _acteur_id(), cible_type, cible_id,
         json.dumps(details) if details is not None else None),
    )


def _acteur_id():
    compte = getattr(g, 'compte', None)
    return compte['id'] if compte else None


def notifier(cur, compte_id, type_notif, titre, corps=None):
    """Depose une notification. A appeler DANS la transaction de la decision.

    Le texte est fige ici : une notification parle souvent d'une chose qui
    vient de disparaitre, et une jointure a l'affichage donnerait « votre
    demande pour (null) a ete refusee ».
    """
    if compte_id is None:
        return
    cur.execute(
        """INSERT INTO notifications (compte_id, type, titre, corps)
           VALUES (%s, %s, %s, %s)""",
        (compte_id, type_notif[:40], titre[:160], corps),
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

def notifier_tous(cur, type_notif, titre, corps=None):
    """Notifie tous les comptes non suspendus. Renvoie leur nombre.

    Un compte suspendu ne peut plus ouvrir de session : lui deposer du
    courrier n'aurait aucun sens.
    """
    cur.execute(
        """INSERT INTO notifications (compte_id, type, titre, corps)
           SELECT id, %s, %s, %s FROM comptes WHERE statut <> 'suspended'""",
        (type_notif[:40], titre[:160], corps),
    )
    return cur.rowcount


@comptes_bp.route('/auth/joueurs-disponibles', methods=['GET'])
@player_required
def joueurs_disponibles():
    """Fiches joueur revendicables.

    Ne renvoie QUE les joueurs sans compte : lister les autres reviendrait a
    publier qui possede un compte Discord, ce que personne n'a demande.
    Les fiches anonymisees sont exclues aussi -- elles correspondent a
    quelqu'un qui a justement demande a ne plus etre identifiable.
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

    # `isinstance(True, int)` vaut True en Python : sans exclure les booleens,
    # un corps {"joueur_id": true} passerait la validation et viserait le
    # joueur n°1.
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

                    # Les deux index uniques partiels (un pending par compte, un
                    # par joueur) transformeraient un doublon en 500 : on repond
                    # proprement avant d'y arriver.
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
@admin_or_role_required
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
        # Invitation nominative : l'admin voit si la revendication correspond
        # bien au joueur qu'il visait en creant le lien. Sur une demande de
        # creation, la non-concordance est le signal utile : l'invitation
        # visait une fiche precise, la personne en veut une neuve.
        "joueur_vise_par_invitation": r[13],
        "concordance_invitation": (r[13] is not None and r[13] == r[11]),
    } for r in rows])


@comptes_bp.route('/admin/liaisons/<int:demande_id>/approve', methods=['POST'])
@admin_or_role_required
def approuver_liaison(demande_id):
    """Approuve une revendication et rattache le compte au joueur.

    Tout se joue dans une transaction avec verrouillage : deux approbations
    concurrentes sur la meme fiche violeraient la contrainte UNIQUE de
    comptes.joueur_id et produiraient une 500 illisible. Le SELECT ... FOR
    UPDATE serialise les deux, et la seconde obtient un 409 explicite.

    L'approbation ne synchronise RIEN : propager le pseudo Discord vers
    joueurs.nom est un geste separe et explicite (voir /sync).

    Deux formes de demande arrivent ici. Celle qui vise une fiche existante se
    contente de la rattacher. Celle qui vise une fiche a CREER (joueur_id NULL,
    nom dans nom_demande) la cree d'abord, dans la meme transaction : si le
    rattachement echoue ensuite, aucune fiche orpheline ne subsiste.
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
                        # Le nom est re-valide MAINTENANT : entre la demande et
                        # ce clic, add_tournament a pu creer la fiche a la
                        # volee, ou une autre approbation prendre le nom.
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
@admin_or_role_required
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
@admin_or_role_required
def lister_comptes():
    """Liste des comptes, avec l'ecart entre pseudo Discord et nom du joueur.

    C'est cet ecart qui declenche la proposition de resynchronisation : le
    pseudo Discord bouge quand la personne le change, le nom du joueur ne bouge
    que quand un admin le decide.
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT c.id, c.discord_id, c.discord_username, c.discord_global_name,
                              c.discord_avatar_hash, c.joueur_id, c.statut, c.role,
                              c.created_at, c.last_login_at, c.profil_synced_at,
                              j.nom
                       FROM comptes c
                       LEFT JOIN joueurs j ON j.id = c.joueur_id
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
        })
    return jsonify(comptes)


def _verifier_sync(cur, compte_id):
    """Prepare une synchronisation. Renvoie (donnees, reponse d'erreur).

    Toutes les raisons de refuser sont evaluees ici, pour que l'apercu et
    l'ecriture donnent exactement le meme verdict -- un apercu qui annonce un
    succes suivi d'une ecriture qui echoue serait pire que pas d'apercu.
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

    # joueurs.nom est UNIQUE et sensible a la casse : "Mario" et "mario"
    # coexistent en base, mais on refuse quand meme, sinon deux fiches
    # deviendraient indiscernables a l'oeil.
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
@admin_or_role_required
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
@admin_or_role_required
def synchroniser_profil(compte_id):
    """Propage le pseudo Discord vers joueurs.nom. Geste ADMIN, jamais automatique.

    Quatre raisons de ne pas automatiser : joueurs.nom est UNIQUE, il circule
    dans une septantaine de innerHTML, il sert d'URL publique, et un joueur qui
    change de pseudo tous les deux jours ferait bouger le classement affiche
    sans que personne ne l'ait voulu.
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
@role_required(ROLE_SUPERADMIN)
def changer_role(compte_id):
    """Attribue ou retire un role. Reservee au superadmin.

    C'est la SEULE route qui ecrit comptes.role. Le role etant la seule
    frontiere de privilege de l'application, aucune autre route ne doit pouvoir
    y toucher, meme indirectement par une mise a jour generique de colonnes.

    Le garde-fou du dernier superadmin est ce qui separe « je me suis trompe »
    de « plus personne ne peut administrer le site » : sans mot de passe de
    secours, un retrait de trop verrouille tout.
    """
    nouveau = (request.get_json(silent=True) or {}).get('role')
    if nouveau not in ROLE_HIERARCHY:
        return jsonify({
            "error": "Role invalide", "code": "role_invalide",
            "roles": sorted(ROLE_HIERARCHY, key=ROLE_HIERARCHY.get),
        }), 400

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

                    cur.execute(
                        "UPDATE comptes SET role = %s, updated_at = now() WHERE id = %s",
                        (nouveau, compte_id),
                    )
                    action = ('role_retire'
                              if ROLE_HIERARCHY[nouveau] < ROLE_HIERARCHY[ancien]
                              else 'role_attribue')
                    _audit(cur, action, 'compte', compte_id,
                           {"ancien": ancien, "nouveau": nouveau, "origine": "ihm"})
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Changement de role du compte %s impossible: %s", compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    logger.info("Role du compte %s : %s -> %s (par %s)", compte_id, ancien, nouveau, _acteur_id())
    return jsonify({"status": "success", "ancien": ancien, "role": nouveau})


@comptes_bp.route('/admin/comptes/<int:compte_id>/sessions', methods=['DELETE'])
@admin_or_role_required
def revoquer_sessions(compte_id):
    """Ferme toutes les sessions d'un compte, sur tous ses appareils.

    Sert d'abord a un compte Discord compromis, quand quelqu'un d'autre detient
    le cookie. Pour un retrait de role, c'est une ceinture et non une bretelle :
    le role etant relu en base a chaque requete protegee, la degradation prend
    deja effet immediatement.

    Le decorateur accepte les DEUX voies : le bouton est affiche a tout
    administrateur sur /admin/comptes, y compris connecte par mot de passe
    pendant la bascule. Sur `role_required` seul, il repondait 401 a celui-la --
    un bouton visible et mort.
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
@admin_or_role_required
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
                    # FOR UPDATE : sans lui, un deliement concurrent d'une
                    # approbation laisse joueur_id dans l'etat que l'ordre
                    # d'arrivee decide, et l'audit raconte l'inverse du resultat.
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

                    # Un compte suspendu le reste : la suspension est une
                    # decision independante du rattachement, et la relever ici
                    # rouvrirait un acces que personne n'a demande a rouvrir.
                    nouveau_statut = 'pending' if statut == 'linked' else statut

                    # profil_synced_at datait une propagation de pseudo vers une
                    # fiche qui n'est plus la sienne : le garder ferait mentir la
                    # colonne « derniere synchro » de /admin/comptes.
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


@comptes_bp.route('/admin/comptes/<int:compte_id>/statut', methods=['POST'])
@admin_or_role_required
def changer_statut(compte_id):
    """Suspend ou reactive un compte. Ne touche jamais au role ni au joueur lie."""
    nouveau = (request.get_json(silent=True) or {}).get('statut')
    if nouveau not in ('linked', 'pending', 'suspended'):
        return jsonify({"error": "Statut invalide"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT statut FROM comptes WHERE id = %s FOR UPDATE", (compte_id,))
                row = cur.fetchone()
                if row is None:
                    conn.rollback()
                    return jsonify({"error": "Compte introuvable"}), 404
                cur.execute(
                    "UPDATE comptes SET statut = %s, updated_at = now() WHERE id = %s",
                    (nouveau, compte_id),
                )
                if nouveau == 'suspended':
                    # Suspendre sans fermer les sessions laisserait la personne
                    # connectee jusqu'a expiration : la suspension ne serait
                    # qu'un libelle d'affichage.
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

# On stocke un IDENTIFIANT, jamais une URL. Laisser le joueur saisir une URL
# complete ferait atterrir une valeur qu'il controle dans un href : il suffirait
# d'un « javascript: » pour executer du script chez tous les visiteurs de sa
# fiche. En ne gardant que le handle, l'URL est construite ici, et il n'existe
# aucun moyen d'en sortir.
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
        # `j.anonymise_at IS NULL` : sans cette condition, une fiche
        # anonymisee continuait d'afficher l'avatar Discord, la bio et les
        # liens sociaux de son proprietaire. L'anonymisation ne remplacait
        # que le pseudo -- or l'URL de l'avatar contient l'identifiant
        # Discord, et un handle Twitch identifie mieux qu'un pseudo de jeu.
        # La promesse « votre fiche ne vous identifie plus » etait fausse.
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
@admin_or_role_required
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
@admin_or_role_required
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
                    """SELECT id, type, titre, corps, created_at, lu_at
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
@admin_or_role_required
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
                    """SELECT created_at, type, titre, corps, lu_at
                       FROM notifications WHERE compte_id = %s ORDER BY created_at""",
                    (compte_id,),
                )
                export["notifications"] = [{
                    "recue_le": r[0].isoformat(), "type": r[1], "titre": r[2],
                    "corps": r[3], "lue_le": r[4].isoformat() if r[4] else None,
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


@comptes_bp.route('/me', methods=['DELETE'])
@player_required
def supprimer_mon_compte():
    """Droit a l'effacement (art. 17), niveau 1 : suppression du compte.

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
    """
    compte_id = g.compte['id']
    joueur_id = g.compte['joueur_id']

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    # L'audit AVANT la suppression : la ligne reference le compte,
                    # et acteur_compte_id est en ON DELETE SET NULL. On y consigne
                    # de quoi rejouer la suppression apres une restauration de
                    # sauvegarde, sans conserver la moindre donnee personnelle.
                    cur.execute(
                        """INSERT INTO audit_admin (action, cible_type, cible_id, details)
                           VALUES (%s, %s, %s, %s::jsonb)""",
                        ('compte_supprime', 'compte', compte_id,
                         json.dumps({
                             "joueur_id": joueur_id,
                             "origine": "self-service",
                             # Empreinte et non identifiant : permet de verifier
                             # apres restauration qu'un compte ressuscite doit
                             # etre resupprime, sans reconserver le snowflake.
                             "discord_id_hash": hash_token(g.compte['discord_id']),
                         })),
                    )
                    # Ordre explicite plutot que de s'en remettre aux CASCADE :
                    # le jour ou une contrainte change, on veut que ce soit ce
                    # code qui decide de ce qui disparait.
                    cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s", (compte_id,))
                    cur.execute("DELETE FROM profils WHERE compte_id = %s", (compte_id,))
                    cur.execute("DELETE FROM liaisons_demandes WHERE compte_id = %s", (compte_id,))
                    cur.execute("DELETE FROM comptes WHERE id = %s", (compte_id,))
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
    logger.info("Compte %s supprime a la demande de son titulaire", compte_id)
    return jsonify({
        "status": "success",
        "dossier_sportif_conserve": joueur_id is not None,
    })


@comptes_bp.route('/admin/purge-rgpd', methods=['POST'])
@admin_or_role_required
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
