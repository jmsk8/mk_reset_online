DEFAULT_MU = 50.0
DEFAULT_SIGMA = 8.333
TRUESKILL_BETA = 4.167
TRUESKILL_DRAW_PROBABILITY = 0.1

DEFAULT_TAU = 0.083
DEFAULT_GHOST_PENALTY = 0.1
DEFAULT_GHOST_THRESHOLD_DAYS = 28
DEFAULT_GHOST_INTERVAL_DAYS = 7
DEFAULT_UNRANKED_THRESHOLD = 10
DEFAULT_SIGMA_THRESHOLD = 4.0

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
# Duree de vie ABSOLUE d'une session joueur : aucune route ne la prolonge.
# C'est ce qui distingue sessions_joueurs de l'ancienne api_tokens, dont le
# renouvellement sans borne rendait un token vole valable indefiniment.
SESSION_JOUEUR_LIFETIME_DAYS = 30
# Les comptes privilegies ont une session bien plus courte : ils ouvrent
# beaucoup plus de portes qu'un compte joueur.
SESSION_ADMIN_LIFETIME_HOURS = 12

INVITATION_LIFETIME_HOURS = 72

DISCORD_API_BASE = "https://discord.com/api/v10"
DISCORD_CDN_BASE = "https://cdn.discordapp.com"
# scope "identify" seul : ni email, ni guilds. L'appartenance au serveur, si on
# la verifie un jour, sera contrôlee par le bot avec son propre token.
DISCORD_OAUTH_SCOPE = "identify"
# Deux appels reseau vers Discord se cachent derriere l'echange du code.
DISCORD_HTTP_TIMEOUT = 10

ROLE_PLAYER = "player"
ROLE_ADMIN = "admin"
ROLE_SUPERADMIN = "superadmin"
# Ordre de privilege : un superadmin satisfait une exigence d'admin.
ROLE_HIERARCHY = {ROLE_PLAYER: 0, ROLE_ADMIN: 1, ROLE_SUPERADMIN: 2}

# --- Matchmaking ----------------------------------------------------------
# Taille maximale d'un lobby. Etait une constante JS dans matchmaking.html ;
# elle vit ici depuis que l'algorithme est cote serveur, pour que la page admin
# et le bot Discord partagent la meme valeur.
MAX_PAR_LOBBY = 10

# --- RGPD -----------------------------------------------------------------
# Version des conditions acceptees. La changer force une nouvelle acceptation :
# comptes.cgu_version garde celle qui a ete reellement acceptee, ce qui permet
# de demontrer QUOI a ete accepte, et pas seulement QUAND.
CGU_VERSION = "1.0"

# Durees de conservation. Chacune doit pouvoir se justifier : conserver sans
# raison est un manquement au meme titre que supprimer ce qu'on doit garder.
PURGE_INVITATIONS_JOURS = 30      # une invitation expiree n'a plus d'usage
PURGE_COMPTES_PENDING_JOURS = 90  # inscrit qui ne s'est jamais fait rattacher
PURGE_LIAISONS_REFUSEES_JOURS = 365

# Avatars relayes : duree du cache memoire et plafond de taille par image.
AVATAR_CACHE_TTL = 3600
AVATAR_MAX_BYTES = 512 * 1024
