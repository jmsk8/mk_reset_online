# TrueSkill defaults (used when creating new players)
DEFAULT_MU = 50.0
DEFAULT_SIGMA = 8.333
TRUESKILL_BETA = 4.167
TRUESKILL_DRAW_PROBABILITY = 0.1

# Default configuration values (fallbacks when DB config is missing)
DEFAULT_TAU = 0.083
DEFAULT_GHOST_PENALTY = 0.1
DEFAULT_UNRANKED_THRESHOLD = 10
DEFAULT_SIGMA_THRESHOLD = 4.0

# Hardcoded thresholds (not configurable via DB)
RANKED_SIGMA_LIMIT = 2.5
GHOST_SIGMA_CAP = 3.5
GHOST_MISSED_THRESHOLD = 4
CHILLGUY_DELTA_LIMIT = 0.3
BORDERLINE_INSTABILITY_THRESHOLD = 0.40
BORDERLINE_IP_WEIGHT = 0.2
BORDERLINE_JUMP_EXPONENT = 1.0
BORDERLINE_DISP_WEIGHT = 0.13
# En dessous de cette taille, s_pos = (n-r)/(n-1) devient quasi binaire
# (ex. n=2 -> s_pos in {0, 1}) et genere des sauts artificiels : on ignore ces tournois.
BORDERLINE_MIN_TOURNAMENT_SIZE = 3
# Bonus de niveau : a stabilite egale, rester stable dans le haut du classement
# "demande de l'effort" et est legerement recompense (score d'instabilite plus bas).
# Additif, dose pour rester leger, amorti pour ne PAS toucher les joueurs instables.
BORDERLINE_LEVEL_BONUS = 0.025
MIN_PARTICIPATION_RATIO = 0.4
MIN_TOURNAMENT_RATIO = 0.5
GM_MAX_RATIO_CAP = 1.5
GM_BASE_WEIGHT = 5.0
GM_EXTRA_MATCH_BONUS = 0.3
REFERENCE_PLAYER_COUNT = 12.0

# Session / token
TOKEN_LIFETIME_MINUTES = 30

# Cache
CACHE_TTL_SECONDS = 300

# Pagination
DEFAULT_PAGE_SIZE = 50
