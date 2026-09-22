"""Journal des actions d'administration -- le SEUL chemin d'ecriture.

Phase 1 de docs/audit-admin-plan.md. Ce module n'ajoute aucun comportement :
il rassemble en un point les huit `INSERT INTO audit_admin` qui vivaient dans
cinq fichiers. Le critere de sortie de la phase est mecanique -- un seul
`INSERT INTO audit_admin` doit subsister dans tout le backend, celui d'ici.

POURQUOI UN SEUL CHEMIN. Tant qu'il existe deux facons d'ecrire dans cette
table, on continuera d'en oublier une. C'est deja arrive : deux appels de
`routes_admin.py` omettaient purement et simplement `acteur_compte_id`, si
bien que le journal savait QUOI mais pas QUI -- exactement ce qu'un journal
d'audit existe pour dire. Passer par un helper rend l'oubli impossible, parce
que l'acteur n'est plus un parametre a penser mais un defaut a surcharger.

CE QUE CE MODULE NE FAIT PAS : il n'ouvre ni ne valide aucune transaction. Il
recoit un curseur et ecrit dedans, pour que la ligne d'audit vive ou meure
avec le geste qu'elle decrit. Une ligne d'audit validee alors que l'action a
ete annulee serait pire que pas de ligne du tout.
"""
import hashlib
import json
import logging

from flask import g, has_request_context

logger = logging.getLogger(__name__)

# Vocabulaire FERME des actions (R-64, docs/audit-admin-plan.md §5.2bis).
#
# Renommer une action apres coup laisse des lignes orphelines qu'aucun filtre ne
# retrouve : les anciennes gardent l'ancien nom. Toute action ecrite doit donc
# figurer ici, et l'ecran Logs doit savoir la dire en clair (LIBELLES_ACTION,
# admin_comptes.html). test_audit_inventaire.py verifie les deux.
#
# Convention : <objet>_<participe passe>, pour qu'un filtre par prefixe
# (`joueur_%`) ramene tout un domaine. Une action retiree du code RESTE ici :
# ses lignes sont toujours en base et doivent rester lisibles.
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

# Sentinelle : distingue « acteur non precise, prends celui de la requete » de
# « acteur volontairement absent » (None). Sans elle, les deux cas s'ecrivent
# `None` et on ne peut plus exprimer le second.
_AUTO = object()


def acteur_courant():
    """Identifiant du compte a l'origine de la requete, ou None.

    None n'est pas une anomalie, et recouvre trois cas distincts :

      - le geste vient d'un ordonnanceur ou de l'amorcage, hors de toute
        requete HTTP ;
      - l'authentification passe encore par le mot de passe admin partage,
        qui n'identifie PERSONNE -- c'est d'ailleurs la raison d'etre de
        l'etape 6 (docs/runbook-admin.md) ;
      - le compte acteur a ete supprime depuis : la colonne est
        `ON DELETE SET NULL`, donc la ligne d'audit survit a son auteur.

    Les distinguer demanderait une colonne de plus ; tant que le mot de passe
    partage existe, un None reste ambigu et il faut le savoir en lisant le
    journal.
    """
    if not has_request_context():
        return None
    compte = getattr(g, 'compte', None)
    return compte['id'] if compte else None


def _identite_acteur():
    """De quoi reconnaitre l'acteur APRES la suppression de son compte, ou None.

    C'est le §6.3 du plan, et le point dur du journal. `acteur_compte_id` est
    en `ON DELETE SET NULL` : a la suppression d'un compte, TOUTES ses lignes
    passent a NULL d'un coup. Elles survivent, mais deviennent anonymes -- et
    indistinguables entre deux admins supprimes. Un journal ou « quelqu'un a
    modifie ce score » ne prouve rien, et la conservation sans limite decidee
    au §4 perd son objet.

    On copie donc, AU MOMENT DE L'ACTION, de quoi identifier durablement :

      - le pseudo, FIGE a cet instant. C'est un fait historique, pas une
        reference a suivre : si la personne se renomme ensuite, la ligne doit
        continuer de dire sous quel nom elle agissait.
      - une EMPREINTE du snowflake, jamais le snowflake. Elle permet de
        REGROUPER les actions d'un meme acteur supprime sans reconserver son
        identifiant Discord -- meme motif que `compte_supprime` et
        `noms_interdits`, on reste coherent avec le reste du projet.
      - le role porte a cet instant, qui explique ce que l'action lui etait
        permise.

    `acteur_compte_id` reste la jointure tant que le compte existe ; ce bloc
    prend le relais quand il disparait.

    ⚠️ Consequence RGPD, a connaitre : le pseudo d'un admin supprime est
    conserve SANS LIMITE, alors que la suppression efface tout le reste. C'est
    l'obligation de rendre compte (art. 5.2) qui le justifie, et c'est annonce
    dans la politique « en tant qu'administrateur » -- la personne l'accepte
    avant de prendre le role.
    """
    if not has_request_context():
        return None
    compte = getattr(g, 'compte', None)
    if not compte:
        return None
    return {
        "pseudo": compte.get('discord_global_name') or compte.get('discord_username'),
        # sha256 recalcule ici plutot qu'importe d'auth_discord : ce module
        # ne doit dependre de RIEN (auth_discord tire db, donc psycopg2, donc
        # une connexion). Un helper d'ecriture qui entraine la moitie du
        # backend a sa suite devient impossible a appeler depuis un script ou
        # un test. Deux lignes dupliquees valent mieux que ce couplage.
        "discord_id_hash": (hashlib.sha256(compte['discord_id'].encode('utf-8')).hexdigest()
                            if compte.get('discord_id') else None),
        "role": compte.get('role'),
    }


def ecrire(cur, action, cible_type=None, cible_id=None, details=None,
           acteur_id=_AUTO):
    """Ecrit une ligne d'audit dans la transaction en cours.

    `acteur_id` n'est a preciser que lorsque l'acteur n'est PAS celui de la
    requete courante -- deux cas aujourd'hui :

      - l'amorcage du superadmin, ou le compte se promeut lui-meme avant
        d'avoir une session ;
      - la purge RGPD, declenchee par un ordonnanceur et sans acteur humain,
        qui passe explicitement None.

    Partout ailleurs, ne rien passer : l'acteur est deduit de `g.compte`.
    """
    if acteur_id is _AUTO:
        acteur_id = acteur_courant()

    # L'identite denormalisee vit DANS details, sous une clef reservee. Une
    # colonne dediee aurait demande une migration par champ ; ici le bloc peut
    # s'enrichir sans toucher au schema, et les lignes anciennes restent
    # lisibles (la clef est simplement absente).
    #
    # Ecrite meme quand `acteur_id` est surcharge : l'amorcage passe un id
    # explicite, et son identite merite d'etre figee comme les autres.
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
