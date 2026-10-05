DEFAULT_MU = 50.0
DEFAULT_SIGMA = 8.333

# Bornes d'une saisie manuelle de mu/sigma (le moteur, lui, n'est pas borne).
MU_MIN, MU_MAX = 0.0, 100.0
SIGMA_MAX = 20.0          # sigma > 0, borne basse exclue
TRUESKILL_BETA = 4.167
TRUESKILL_DRAW_PROBABILITY = 0.1

DEFAULT_TAU = 0.083
DEFAULT_GHOST_PENALTY = 0.1
DEFAULT_UNRANKED_THRESHOLD = 10

# Penalite d'absence, comptee en sessions loupees (pas en jours).
DEFAULT_GHOST_THRESHOLD_SESSIONS = 4   # sessions loupees avant la 1re penalite
DEFAULT_GHOST_INTERVAL_SESSIONS = 1    # sessions loupees entre deux penalites
DEFAULT_SIGMA_THRESHOLD = 4.0

# Tiers par defaut (seuil en multiples d'ecart-type), utilises si la table
# `tiers` est vide et par le bouton de reinitialisation. seuil_k None = plancher.
DEFAULT_TIERS = [
    {"nom": "S", "couleur": "#f77b7b", "couleur_texte": "#FFFFFF", "seuil_k": 1.0, "rang": 3},
    {"nom": "A", "couleur": "#9cda74", "couleur_texte": "#FFFFFF", "seuil_k": 0.0, "rang": 2},
    {"nom": "B", "couleur": "#7fe6ee", "couleur_texte": "#FFFFFF", "seuil_k": -1.0, "rang": 1},
    {"nom": "C", "couleur": "#ae6ce4", "couleur_texte": "#FFFFFF", "seuil_k": None, "rang": 0},
]

# Couleur du texte d'un badge de tier quand rien n'est regle (l'apparence d'avant).
DEFAULT_TIER_COULEUR_TEXTE = "#FFFFFF"

# U (non classe) n'est pas un tier en base : ses couleurs sont dans `configuration`.
# Sans reglage, le texte de U est noir ou blanc selon le fond (texte_lisible).
DEFAULT_TIER_U_COULEUR = "#FFFFFF"

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
# Plafond de l'IP, en points.
GM_MAX_IP = GM_MAX_RATIO_CAP * 100
GM_EXTRA_MATCH_BONUS = 0.3
REFERENCE_PLAYER_COUNT = 12.0

# poids = nb_joueurs_du_lobby + GM_BASE_WEIGHT. Plus la valeur est petite,
# plus l'effectif du lobby pese dans la moyenne ponderee de l'IP.
GM_BASE_WEIGHT_V1 = 5.0
GM_BASE_WEIGHT_V2 = 15.0

# IP v2 : ratio_ajuste = ratio * force_lobby, avec
#   force_lobby = 1 + PER_MU * (mu_moyen_du_lobby - mu_moyen_de_reference)
# (moyennes calculees sans le joueur concerne).
IP_V2_FORCE_LOBBY_PER_MU = 0.02   # correction par point de mu d'ecart. 0 = desactive
IP_V2_FORCE_LOBBY_MIN = 0.5
IP_V2_FORCE_LOBBY_MAX = 2.0
IP_VERSION_DEFAULT = "v1"

# La moyenne de reference est figee par journee (table grille_snapshots).
IP_V2_REF_REQUIRE_TIER = True     # exclut les joueurs sans tier (tier = 'U')
IP_V2_REF_REQUIRE_RANKED = True   # exclut les joueurs inactifs (is_ranked = false)

# Seuils de couleur de la cellule IP (affichage seulement).
IP_SEUIL_ETOILE = 115
IP_SEUIL_BON = 105
IP_SEUIL_MOYEN = 95

CACHE_TTL_SECONDS = 300

DEFAULT_PAGE_SIZE = 50

# --- Authentification Discord / comptes joueurs ---------------------------
# Duree de vie absolue, jamais prolongee.
SESSION_JOUEUR_LIFETIME_DAYS = 30
# Session plus courte pour les comptes privilegies.
SESSION_ADMIN_LIFETIME_HOURS = 12

INVITATION_LIFETIME_HOURS = 72

# Plafonds d'une invitation.
INVITATION_MAX_HOURS = 30 * 24
INVITATION_MAX_USES = 50

# Duree de validite d'une proposition de promotion au rang d'admin.
PROMOTION_LIFETIME_DAYS = 30

# Version de la politique admin, independante de CGU_VERSION.
CGU_ADMIN_VERSION = "1.1"

DISCORD_API_BASE = "https://discord.com/api/v10"
DISCORD_CDN_BASE = "https://cdn.discordapp.com"
# Scope minimal : ni email, ni guilds.
DISCORD_OAUTH_SCOPE = "identify"
DISCORD_HTTP_TIMEOUT = 10

# Widget Discord relaye par /discord/widget pour ne pas exposer l'IP des
# visiteurs. Le timeout reste sous celui de backend_request (5 s).
DISCORD_GUILD_ID = "1240353798753620039"
DISCORD_WIDGET_TIMEOUT = 3
DISCORD_WIDGET_CACHE_TTL = 300

ROLE_PLAYER = "player"
ROLE_ADMIN = "admin"
# Toutes les permissions delegables sauf les jetons de bot.
ROLE_CHEF_ADMIN = "chef_admin"
ROLE_SUPERADMIN = "superadmin"
# Ordre de privilege : un superadmin satisfait une exigence d'admin.
ROLE_HIERARCHY = {ROLE_PLAYER: 0, ROLE_ADMIN: 1, ROLE_CHEF_ADMIN: 2, ROLE_SUPERADMIN: 3}

# Permissions delegables a un compte admin. Les jetons de bot, la purge RGPD,
# l'annulation de tournoi, l'anonymisation et le changement de role n'en font
# pas partie : ce sont des capacites de role.
PERMISSIONS_CATALOGUE = frozenset({
    # Lecture seule de l'onglet Fiches joueurs ; chaque action a sa sous-permission.
    "gestion_joueurs",
    # Sous-permissions de gestion_joueurs (voir SOUS_PERMISSIONS).
    "joueurs_creation",
    "joueurs_nom",
    "joueurs_couleur",
    # Saisie manuelle du score d'une fiche.
    "edition_mu_sigma",
    "joueurs_statut",
    # Suppression d'une fiche sans match, anonymisation d'une fiche avec matchs.
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
SOUS_PERMISSIONS = {
    "joueurs_creation": "gestion_joueurs",
    "joueurs_nom": "gestion_joueurs",
    "joueurs_couleur": "gestion_joueurs",
    "edition_mu_sigma": "gestion_joueurs",
    "joueurs_statut": "gestion_joueurs",
    "joueurs_irreversible": "gestion_joueurs",
}

# Droit exige par champ dans api_update_joueur (un seul UPDATE pour tous).
PERMISSIONS_CHAMPS_JOUEUR = {
    "nom": "joueurs_nom",
    "color": "joueurs_couleur",
    "mu": "edition_mu_sigma",
    "sigma": "edition_mu_sigma",
    "is_ranked": "joueurs_statut",
}


def permissions_effectives(accordees) -> set:
    """Retire les sous-permissions dont le parent manque. Renvoie un set."""
    accordees = set(accordees)
    return {p for p in accordees
            if SOUS_PERMISSIONS.get(p) is None or SOUS_PERMISSIONS[p] in accordees}

# --- Matchmaking ----------------------------------------------------------
# --- Matchmaking ----------------------------------------------------------
MAX_PAR_LOBBY = 10

# --- RGPD -----------------------------------------------------------------
# --- RGPD -----------------------------------------------------------------
# Version des conditions ; la changer force une nouvelle acceptation.
CGU_VERSION = "1.0"

# Durees de conservation.
PURGE_INVITATIONS_JOURS = 30      # une invitation expiree n'a plus d'usage
PURGE_COMPTES_PENDING_JOURS = 90  # inscrit qui ne s'est jamais fait rattacher
PURGE_LIAISONS_REFUSEES_JOURS = 365

# Avatars relayes : duree du cache memoire et plafond de taille par image.
AVATAR_CACHE_TTL = 3600
AVATAR_MAX_BYTES = 512 * 1024
