"""Ecriture du journal d'audit (table audit_admin).

Le module ecrit dans le curseur fourni sans valider : la ligne d'audit suit la
transaction de l'action qu'elle decrit.
"""
import hashlib
import json
import logging

from flask import g, has_request_context

logger = logging.getLogger(__name__)

# Liste fermee des actions journalisees, au format <objet>_<participe passe>.
# Une action retiree du code reste ici : ses lignes existent toujours en base.
ACTIONS = frozenset({
    # Comptes, roles et permissions
    'role_attribue', 'role_retire', 'superadmin_legue',
    'permission_accordee', 'permission_retiree', 'permissions_purgees',
    'promotion_proposee', 'promotion_refusee', 'promotion_annulee',
    'cgu_admin_acceptee', 'statut_change', 'sessions_revoquees',
    'profil_synchro', 'compte_supprime',
    # Liaisons et invitations
    'liaison_approuvee', 'liaison_refusee', 'liaison_annulee',
    'invitation_creee', 'invitation_revoquee',
    'service_token_cree', 'service_token_revoque',
    # Dossier sportif
    'joueur_cree', 'joueur_modifie', 'joueur_supprime', 'joueur_anonymise',
    'tournoi_ajoute', 'tournoi_supprime', 'tournoi_annule', 'tournoi_lie',
    'reset_global_applique', 'reset_global_annule',
    # Configuration
    'config_modifiee', 'ligues_configurees',
    'tier_cree', 'tier_modifie', 'tier_supprime',
    'tiers_reordonnes', 'tiers_reinitialises',
    # Recaps de saison
    'recap_cree', 'recap_publie', 'recap_supprime',
    # RGPD
    'purge_rgpd',
})

# Distingue "acteur non precise" (prendre celui de la requete) d'un None explicite.
_AUTO = object()


def acteur_courant():
    """Id du compte a l'origine de la requete, ou None hors requete."""
    if not has_request_context():
        return None
    compte = getattr(g, 'compte', None)
    return compte['id'] if compte else None


def _identite_acteur():
    """Identite figee de l'acteur : pseudo, empreinte du snowflake et role.

    acteur_compte_id passe a NULL quand le compte est supprime ; ce bloc permet
    alors encore d'identifier l'auteur de la ligne.
    """
    if not has_request_context():
        return None
    compte = getattr(g, 'compte', None)
    if not compte:
        return None
    return {
        "pseudo": compte.get('discord_global_name') or compte.get('discord_username'),
        # Recalcule ici pour ne pas importer auth_discord (qui tire la base).
        "discord_id_hash": (hashlib.sha256(compte['discord_id'].encode('utf-8')).hexdigest()
                            if compte.get('discord_id') else None),
        "role": compte.get('role'),
    }


def ecrire(cur, action, cible_type=None, cible_id=None, details=None,
           acteur_id=_AUTO):
    """Ecrit une ligne d'audit dans la transaction en cours.

    acteur_id n'est a fournir que si l'acteur n'est pas le compte de la requete
    (ex. amorcage du superadmin).
    """
    if acteur_id is _AUTO:
        acteur_id = acteur_courant()

    # Identite stockee dans details['acteur'] plutot que dans une colonne dediee.
    identite = _identite_acteur()
    if identite:
        details = dict(details or {})
        details['acteur'] = identite

    cur.execute(
        """INSERT INTO audit_admin (action, acteur_compte_id, cible_type, cible_id, details)
           VALUES (%s, %s, %s, %s, %s::jsonb)""",
        (action, acteur_id, cible_type, cible_id,
         json.dumps(details) if details is not None else None),
    )
