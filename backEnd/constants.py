DEFAULT_MU = 50.0
DEFAULT_SIGMA = 8.333
TRUESKILL_BETA = 4.167
TRUESKILL_DRAW_PROBABILITY = 0.1

DEFAULT_TAU = 0.083
DEFAULT_GHOST_PENALTY = 0.1
DEFAULT_UNRANKED_THRESHOLD = 10

# Penalite d'absence : seuils en SESSIONS LOUPEES, plus en jours calendaires.
#
# La penalite sanctionne le fait de louper des occasions de jeu, pas
# l'ecoulement du temps : une periode sans session ne penalise personne. C'est
# voulu (docs/plan-sessions-tournois.md, decision 8).
#
# Valeurs choisies pour reproduire l'ancien comportement au rythme observe
# (≈1 session/semaine) : 28 jours -> 4 sessions, 7 jours -> 1 session.
DEFAULT_GHOST_THRESHOLD_SESSIONS = 4   # sessions loupees avant la 1re penalite
DEFAULT_GHOST_INTERVAL_SESSIONS = 1    # sessions loupees entre deux penalites
DEFAULT_SIGMA_THRESHOLD = 4.0

# Tiers par defaut (nom, couleur, seuil en multiples d'ecart-type, rang) :
# comportement historique de tier_for_score (mean+stdev / mean / mean-stdev),
# desormais une liste geree en base (table `tiers`, voir services.py et
# docs/tableau-seuils-tiers-plan.md Partie B). Sert de valeur de secours si la
# table est vide, et de cible au bouton « Reinitialiser » de l'admin. Rang
# decroissant du meilleur au pire ; seuil_k None = plancher (pas de seuil bas).
DEFAULT_TIERS = [
    {"nom": "S", "couleur": "#f77b7b", "seuil_k": 1.0, "rang": 3},
    {"nom": "A", "couleur": "#9cda74", "seuil_k": 0.0, "rang": 2},
    {"nom": "B", "couleur": "#7fe6ee", "seuil_k": -1.0, "rang": 1},
    {"nom": "C", "couleur": "#ae6ce4", "seuil_k": None, "rang": 0},
]

RANKED_SIGMA_LIMIT = 2.5
GHOST_SIGMA_CAP = 3.5
GHOST_MISSED_THRESHOLD = 4
CHILLGUY_DELTA_LIMIT = 0.3
BORDERLINE_INSTABILITY_THRESHOLD = 0.40
BORDERLINE_AWARD_THRESHOLD = 0.30
BORDERLINE_IP_WEIGHT = 0.2
BORDERLINE_JUMP_EXPONENT = 1.5
BORDERLINE_MIN_TOURNAMENT_SIZE = 3
BORDERLINE_MIN_VALID_MATCHES = 4
BORDERLINE_JUMP_WEIGHT = 0.5
BORDERLINE_LEVEL_BONUS = 0.025
MIN_PARTICIPATION_RATIO = 0.4
MIN_TOURNAMENT_RATIO = 0.5
GM_MAX_RATIO_CAP = 1.5
# Plafond dur de l'IP, en points. Rien ne peut le depasser : ni un match isole
# apres correction de force du lobby, ni un total apres bonus d'assiduite.
GM_MAX_IP = GM_MAX_RATIO_CAP * 100
GM_EXTRA_MATCH_BONUS = 0.3
REFERENCE_PLAYER_COUNT = 12.0

# poids = nb_joueurs_du_lobby + GM_BASE_WEIGHT. Plus la valeur est petite,
# plus l'effectif du lobby pese dans la moyenne ponderee de l'IP.
GM_BASE_WEIGHT_V1 = 5.0
GM_BASE_WEIGHT_V2 = 15.0

# IP v2 : ratio_ajuste = ratio * force_lobby, avec
#   force_lobby = 1 + PER_MU * (mu_moyen_du_lobby - mu_moyen_de_reference)
# les deux moyennes etant calculees en excluant le joueur concerne. Lobby au
# niveau de la reference => force_lobby = 1.0, donc v2 = v1.
#
# L'ecart est pris en points de mu et non en rapport : le mu TrueSkill est une
# echelle d'intervalle dont l'origine est arbitraire (50 ici, 25 dans la lib),
# donc seule la difference a un sens. Un rapport rendrait la correction
# dependante du niveau general, qu'un reset global suffirait a deplacer.
IP_V2_FORCE_LOBBY_PER_MU = 0.02   # correction par point de mu d'ecart. 0 = desactive
IP_V2_FORCE_LOBBY_MIN = 0.5
IP_V2_FORCE_LOBBY_MAX = 2.0
IP_VERSION_DEFAULT = "v1"

# La moyenne de reference est figee par journee : la grille des joueurs est
# sauvegardee (table grille_snapshots) juste avant la generation du premier
# tournoi du jour, et les tournois suivants de la meme journee (session de
# matchmaking scindee en plusieurs lobbies) reutilisent cette meme grille.
# Ces deux drapeaux definissent qui compte dans la moyenne.
IP_V2_REF_REQUIRE_TIER = True     # exclut les joueurs sans tier (tier = 'U')
IP_V2_REF_REQUIRE_RANKED = True   # exclut les joueurs inactifs (is_ranked = false)

TOKEN_LIFETIME_MINUTES = 60

CACHE_TTL_SECONDS = 300

DEFAULT_PAGE_SIZE = 50

# --- Authentification Discord / comptes joueurs ---------------------------
# Duree de vie ABSOLUE : aucune route ne la prolonge. C'est ce qui distingue
# sessions_joueurs de l'ancienne api_tokens, dont le renouvellement sans borne
# rendait un token vole valable indefiniment.
SESSION_JOUEUR_LIFETIME_DAYS = 30
# Les comptes privilegies ont une session bien plus courte : ils ouvrent
# beaucoup plus de portes qu'un compte joueur.
SESSION_ADMIN_LIFETIME_HOURS = 12

INVITATION_LIFETIME_HOURS = 72

# Duree de validite d'une proposition de promotion au rang d'admin.
#
# 30 jours et non 72 heures comme une invitation : une invitation s'envoie a
# quelqu'un qu'on vient de solliciter, une promotion tombe sans prevenir sur
# quelqu'un qui n'a rien demande. Il lui faut le temps de revenir sur le site
# et de LIRE ce qu'il accepte -- ses actions y seront tracees nominativement et
# sans limite de duree.
#
# Borne quand meme : une proposition ouverte il y a huit mois n'engage plus
# personne, et son auteur a pu changer d'avis sans penser a l'annuler.
PROMOTION_LIFETIME_DAYS = 30

# Version de la politique « en tant qu'administrateur ». Distincte de
# CGU_VERSION : les deux textes evoluent independamment, et melanger leurs
# numeros rendrait impossible de demontrer QUOI a ete accepte.
CGU_ADMIN_VERSION = "1.0"

DISCORD_API_BASE = "https://discord.com/api/v10"
DISCORD_CDN_BASE = "https://cdn.discordapp.com"
# scope "identify" seul : ni email, ni guilds. L'appartenance au serveur, si on
# la verifie un jour, sera contrôlee par le bot avec son propre token.
DISCORD_OAUTH_SCOPE = "identify"
# Deux appels reseau vers Discord se cachent derriere l'echange du code.
DISCORD_HTTP_TIMEOUT = 10

ROLE_PLAYER = "player"
ROLE_ADMIN = "admin"
# Palier intermediaire : tout le catalogue delegable ci-dessous, SAUF les jetons
# de bot. Designe par le superadmin seul, jamais par un pair.
ROLE_CHEF_ADMIN = "chef_admin"
ROLE_SUPERADMIN = "superadmin"
# Ordre de privilege : un superadmin satisfait une exigence d'admin.
ROLE_HIERARCHY = {ROLE_PLAYER: 0, ROLE_ADMIN: 1, ROLE_CHEF_ADMIN: 2, ROLE_SUPERADMIN: 3}

# Catalogue des permissions delegables a un compte role=admin, une par une.
#
# Les jetons de bot n'y figurent JAMAIS : c'est une capacite de role, verifiee
# par role_required(ROLE_SUPERADMIN) en direct. Ce n'est pas une case decochee,
# c'est un pouvoir qui n'existe pas dans ce systeme -- y compris pour un
# superadmin qui voudrait le deleguer.
#
# Meme chose pour la purge RGPD, l'annulation de tournoi, l'anonymisation et le
# changement de role : capacites de role, jamais des entrees d'ici.
# Cartographie complete : docs/hierarchie-admin-plan.md, annexe A.
#
# LE RESET GLOBAL, LUI, EST DELEGABLE depuis le 2026-09-13 : il releve de
# gestion_config. Decision explicite (contexte 8.5-D), qui INVERSE R-51 du plan
# hierarchie -- ne pas le « corriger » en le remettant hors catalogue sans
# revalidation. Motif : le reset passe PAR le moteur TrueSkill, il est tracable
# et reproductible, contrairement a une saisie manuelle de score.
PERMISSIONS_CATALOGUE = frozenset({
    # Depuis le 2026-09-17, `gestion_joueurs` ne donne que la LECTURE : ouvrir
    # l'onglet Fiches joueurs et voir la liste. Chacun des six gestes est une
    # sous-permission ci-dessous. Un admin qui n'a que celle-ci ne peut donc
    # rien modifier -- c'est voulu, pas un oubli d'octroi.
    "gestion_joueurs",
    # SOUS-PERMISSIONS de gestion_joueurs : un droit par geste. Les routes
    # concernees exigent les DEUX -- c'est une restriction au sein du domaine,
    # jamais un droit autonome. Entrees du catalogue a part entiere malgre
    # tout : elles s'accordent et se retirent comme les autres, et
    # permissions_delegables_par n'a pas a connaitre de cas particulier.
    "joueurs_creation",
    "joueurs_nom",
    "joueurs_couleur",
    # Saisie manuelle du score, sur UNE fiche. A ne pas confondre avec le reset
    # global, qui releve de gestion_config : celui-la passe par le moteur
    # TrueSkill (tracable, reversible), celle-ci l'ecrase directement.
    "edition_mu_sigma",
    "joueurs_statut",
    # Les deux gestes irreversibles : supprimer une fiche sans match, anonymiser
    # une fiche qui en a. Ex-`rgpd_joueurs` -- renommee le 2026-09-17 parce que
    # le nom promettait un dispositif RGPD qui n'existe pas : la suppression est
    # du menage (elle refuse tout joueur ayant un match), seule l'anonymisation
    # releve du droit a l'effacement. Leur vrai point commun est d'etre sans
    # retour.
    "joueurs_irreversible",
    "gestion_tournois",
    "gestion_ligues",
    "gestion_saisons",
    "gestion_liaisons",
    "gestion_comptes",
    "gestion_invitations",
    "gestion_config",
    "gestion_matchmaking",
})

# Sous-permissions : enfant -> parent exige en plus.
#
# Une entree ici veut dire « cette permission ne vaut RIEN seule » : la route
# protegee exige l'enfant ET le parent. Donnee plutot que regle eparpillee, pour
# que l'interface (case en retrait, decochee avec son parent) et le backend
# lisent la meme source -- et qu'ajouter une sous-permission n'oblige pas a
# retrouver tous les endroits qui la supposent.
SOUS_PERMISSIONS = {
    "joueurs_creation": "gestion_joueurs",
    "joueurs_nom": "gestion_joueurs",
    "joueurs_couleur": "gestion_joueurs",
    "edition_mu_sigma": "gestion_joueurs",
    "joueurs_statut": "gestion_joueurs",
    "joueurs_irreversible": "gestion_joueurs",
}

# Sous-permissions verifiees CHAMP PAR CHAMP dans api_update_joueur, et non par
# un decorateur : les quatre champs partagent un seul UPDATE, donc un
# @permission_required de route entiere ne saurait pas les distinguer. Cette
# table dit quel champ du payload exige quel droit.
#
# Donnee plutot que suite de `if` : la route, le frontend et les tests lisent la
# meme source, et ajouter un champ edite ne demande pas de retrouver les trois.
PERMISSIONS_CHAMPS_JOUEUR = {
    "nom": "joueurs_nom",
    "color": "joueurs_couleur",
    "mu": "edition_mu_sigma",
    "sigma": "edition_mu_sigma",
    "is_ranked": "joueurs_statut",
}


def permissions_effectives(accordees) -> set:
    """Retire les sous-permissions dont le parent manque. Renvoie un set.

    `permissions_admin` peut contenir un orphelin : octroi anterieur a la
    creation de la sous-permission, SQL direct, ou parent retire par un chemin
    qui l'aurait ignore. Une telle ligne ne donne AUCUN droit -- permission_required
    exige le parent -- mais l'interface la lirait comme accordee et afficherait
    un bouton qui repond 403.

    A appliquer partout ou l'on expose des permissions a l'affichage.
    """
    accordees = set(accordees)
    return {p for p in accordees
            if SOUS_PERMISSIONS.get(p) is None or SOUS_PERMISSIONS[p] in accordees}

# --- Matchmaking ----------------------------------------------------------
# Taille maximale d'un lobby. Cote serveur depuis que la page admin et le bot
# Discord partagent le meme algorithme.
MAX_PAR_LOBBY = 10

# --- RGPD -----------------------------------------------------------------
# Version des conditions acceptees. La changer force une nouvelle acceptation :
# comptes.cgu_version garde celle reellement acceptee, ce qui demontre QUOI a
# ete accepte et pas seulement QUAND.
CGU_VERSION = "1.0"

# Durees de conservation. Chacune doit pouvoir se justifier : conserver sans
# raison est un manquement au meme titre que supprimer ce qu'on doit garder.
PURGE_INVITATIONS_JOURS = 30      # une invitation expiree n'a plus d'usage
PURGE_COMPTES_PENDING_JOURS = 90  # inscrit qui ne s'est jamais fait rattacher
PURGE_LIAISONS_REFUSEES_JOURS = 365

# Avatars relayes : duree du cache memoire et plafond de taille par image.
AVATAR_CACHE_TTL = 3600
AVATAR_MAX_BYTES = 512 * 1024
