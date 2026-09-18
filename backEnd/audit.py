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
import json
import logging

from flask import g, has_request_context

logger = logging.getLogger(__name__)

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

    cur.execute(
        """INSERT INTO audit_admin (action, acteur_compte_id, cible_type, cible_id, details)
           VALUES (%s, %s, %s, %s, %s::jsonb)""",
        (action, acteur_id, cible_type, cible_id,
         json.dumps(details) if details is not None else None),
    )
