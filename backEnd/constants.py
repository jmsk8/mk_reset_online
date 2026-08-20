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

# IP v2 : force_lobby = mu_moyen_du_lobby / mu_moyen_de_reference (calcules
# en excluant le joueur concerne). ratio_ajuste = ratio * force_lobby ** ALPHA.
# Lobby au niveau de la reference => force_lobby = 1.0, donc v2 = v1.
IP_V2_FORCE_LOBBY_ALPHA = 1       # 0 = desactive, 1 = correction brute
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
