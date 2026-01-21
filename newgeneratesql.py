import trueskill
import math
from datetime import datetime

# === CONFIGURATION ===
env = trueskill.TrueSkill(mu=50.0, sigma=8.333, beta=4.167, tau=0.083, draw_probability=0.1)

# === COULEURS (Astral garde sa couleur, Clem disparait) ===
PLAYER_COLORS = {
    "Rosalyan": "#4285F4", "Elite": "#EA4335", "J_sk8": "#FBBC05", "Vakaeltraz": "#34A853",
    "Lu_K": "#FF6D01", "Rayou": "#00BCD4", "Melwin": "#64B5F6", "Astral": "#E57373",
    "JeanCube": "#FFF176", "Daytona_69": "#81C784", "Oleas": "#FF9800", "Thaumas": "#4DD0E1",
    "Ether-Zero": "#7986CB", "Tomwilson": "#F06292", "Brook1l": "#FFF59D", "Hardox": "#AED581",
    "ColorOni": "#FFB74D", "Kemoory": "#B2DFDB", "Camou": "#E3F2FD", "Fozlo": "#FFEBEE",
    "Kaysuan": "#FFFDE7", "PastPlayer": "#E8F5E9", "Ael": "#9C27B0", "Falgo": "#795548",
    "McK17": "#607D8B", "Corentin": "#3F51B5", "Mirijason": "#009688", "Tomy": "#CDDC39"
}

# === CIBLES (ORDRE DES IDs) ===
final_targets_order = [
    "Rosalyan", "J_sk8", "Elite", "Rayou", "Vakaeltraz", "Melwin", "Lu_K", 
    "Astral", "Daytona_69", "JeanCube", "Oleas", "Thaumas", "Ether-Zero", 
    "Ael", "Tomwilson", "Falgo", "Brook1l", "Hardox", "ColorOni", "Camou", 
    "Kemoory", "Fozlo", "McK17", "Kaysuan", "PastPlayer", "Tomy", "Mirijason"
]

# === STATS CIBLES (CE QUE L'ON DOIT TROUVER LE 6 FEVRIER) ===
# Note : Les stats de Clem sont maintenant attribuées à Astral
target_stats_feb = {
    "Elite": (60.812, 1.594), "Vakaeltraz": (58.046, 1.273), "J_sk8": (54.004, 1.226),
    "Melwin": (52.741, 1.449), "Astral": (48.739, 1.368), "Lu_K": (53.820, 3.335),
    "Oleas": (56.247, 4.235), "Thaumas": (51.464, 2.719), "Ether-Zero": (52.986, 4.335),
    "Daytona_69": (45.619, 2.056), "Tomwilson": (49.867, 4.522), "Camou": (50.053, 4.679),
    "Brook1l": (43.382, 2.539), "Hardox": (40.936, 2.108), "JeanCube": (45.816, 3.812),
    "Kemoory": (39.914, 2.369), "Fozlo": (36.466, 2.307), "McK17": (50.000, 8.333),
    "Kaysuan": (50.000, 8.333), "PastPlayer": (50.000, 8.333), "Tomy": (50.000, 8.333),
    "Mirijason": (50.000, 8.333), "Rosalyan": (50.000, 8.333), "ColorOni": (50.000, 8.333),
    "Falgo": (50.000, 8.333), "Ael": (50.000, 8.333), "Rayou": (50.000, 8.333),
    "Corentin": (50.000, 8.333)
}

# === TOURNOIS DE CALIBRATION (JANVIER) ===
calibration_tournaments = [
    ("2025-01-16", {"Fozlo": 121, "Elite": 184, "J_sk8": 171, "Lu_K": 148, "Melwin": 138, "Vakaeltraz": 184}),
    ("2025-01-23", {"Astral": 161, "Fozlo": 127, "J_sk8": 180, "Kemoory": 109, "Lu_K": 203, "Vakaeltraz": 171}),
    ("2025-01-30", {"Fozlo": 140, "Elite": 189, "J_sk8": 193, "Vakaeltraz": 194})
]

# === EXCLUSIONS TS PAR TOURNOI ===
# Joueurs dont le score TS ne doit pas être mis à jour (ex: invités)
ts_exclusions = {
    "2025-02-13": ["J_sk8", "Fozlo", "JeanCube"]
}

# === TOURNOIS RESTANTS (FEVRIER -> DECEMBRE) ===
# Remplacement de "Clem" par "Astral" partout ici
main_tournaments = [
    # === HIVER 2025 ===
    ("2025-02-06", {"Astral": 154, "Elite": 173, "J_sk8": 180, "Kemoory": 124, "Lu_K": 152, "Mirijason": 116, "Vakaeltraz": 149}),
    ("2025-02-13", {"J_sk8": 111, "Fozlo": 94, "JeanCube": 130, "Astral": 154, "Elite": 142, "Lu_K": 138, "Rosalyan": 197, "Vakaeltraz": 143}),
    ("2025-02-20", {"Elite": 175, "Fozlo": 73, "J_sk8": 163, "Lu_K": 159, "Vakaeltraz": 199}),
    ("2025-02-27", {"Camou": 94, "Astral": 128, "Elite": 172, "Fozlo": 111, "J_sk8": 134, "JeanCube": 150, "Lu_K": 144, "Melwin": 127, "Tomy": 69, "Vakaeltraz": 116}),
    ("2025-03-06", {"Lu_K": 178, "Rayou": 195, "Rosalyan": 219}),
    ("2025-03-13", {"Astral": 164, "Melwin": 157, "Rosalyan": 227, "Vakaeltraz": 173}),
     # === PRINTEMPS 2025 ===
    ("2025-03-20", {"Brook1l": 127, "Elite": 175, "Lu_K": 174, "Rosalyan": 202, "Tomy": 111, "Vakaeltraz": 164}),
    ("2025-03-27", {"Astral": 134, "Elite": 166, "J_sk8": 158, "JeanCube": 154, "Lu_K": 145, "Melwin": 152, "Vakaeltraz": 143}),
    ("2025-04-03", {"Astral": 185, "Daytona_69": 171, "Lu_K": 189, "Vakaeltraz": 185}),
    ("2025-04-10", {"Daytona_69": 153, "Fozlo": 107, "J_sk8": 150, "Lu_K": 156, "Melwin": 142, "Rosalyan": 194, "Vakaeltraz": 149}),
    ("2025-04-17", {"Astral": 167, "Elite": 179, "JeanCube": 163, "Melwin": 148, "Vakaeltraz": 194}),
    ("2025-04-24", {"Camou": 117, "Astral": 123, "Daytona_69": 128, "Elite": 150, "J_sk8": 157, "Melwin": 157, "Rosalyan": 215}),
    ("2025-05-08", {"Astral": 179, "Elite": 180, "Melwin": 175, "Vakaeltraz": 180}),
    ("2025-05-15", {"Lu_K": 162, "Melwin": 171, "Rosalyan": 207, "Vakaeltraz": 183}),
    ("2025-05-22", {"Astral": 141, "J_sk8": 191, "JeanCube": 162, "Lu_K": 171, "PastPlayer": 113, "Vakaeltraz": 170}),
    ("2025-06-12", {"Astral": 199, "Elite": 103, "Melwin": 181, "Vakaeltraz": 193}),
    ("2025-06-19", {"Elite": 146, "J_sk8": 173, "Lu_K": 147, "Rayou": 148, "Rosalyan": 186, "Vakaeltraz": 158}),
        # === ÉTÉ 2025 ===
    ("2025-06-26", {"Elite": 178, "J_sk8": 153, "Kemoory": 97, "Lu_K": 161, "Melwin": 162, "Rayou": 144, "Vakaeltraz": 146}),
    ("2025-07-03", {"Astral": 122, "Elite": 143, "J_sk8": 172, "Kemoory": 113, "Melwin": 159, "Rayou": 145, "Vakaeltraz": 189}),
    ("2025-07-10", {"Fozlo": 168, "Lu_K": 196, "Melwin": 176, "Rayou": 177}),
    ("2025-07-17", {"Astral": 170, "Elite": 184, "Melwin": 187, "Vakaeltraz": 183}),
    ("2025-07-24", {"Brook1l": 122, "Elite": 170, "Fozlo": 128, "J_sk8": 201, "Melwin": 162, "Rayou": 188}),
    ("2025-07-31", {"Astral": 161, "ColorOni": 123, "Daytona_69": 128, "Elite": 148, "J_sk8": 140, "JeanCube": 113, "Rayou": 169, "Vakaeltraz": 148}),
    ("2025-08-07", {"Astral": 177, "Melwin": 174, "Rayou": 181, "Vakaeltraz": 173}),
    ("2025-08-14", {"Elite": 177, "Kaysuan": 113, "Lu_K": 184, "Melwin": 158, "Rayou": 144, "Vakaeltraz": 162}),
    ("2025-08-21", {"Elite": 164, "J_sk8": 188, "Lu_K": 162, "Melwin": 163, "Rayou": 58, "Vakaeltraz": 159}),
    ("2025-08-28", {"Daytona_69": 158, "Elite": 170, "J_sk8": 165, "Lu_K": 143, "Melwin": 161, "Vakaeltraz": 166}),
    ("2025-09-04", {"Elite": 181, "J_sk8": 196, "Lu_K": 147, "Rayou": 157, "Vakaeltraz": 164}),
    ("2025-09-18", {"Astral": 139, "Daytona_69": 150, "Elite": 149, "J_sk8": 160, "Melwin": 116, "Rayou": 169, "Vakaeltraz": 152}),
        # === AUTOMNE 2025 ===
    ("2025-09-29", {"Ael": 108, "Astral": 131, "Daytona_69": 157, "Elite": 159, "Falgo": 104, "J_sk8": 163, "Melwin": 156, "Vakaeltraz": 158}),
    ("2025-10-06", {"Ael": 152, "Daytona_69": 180, "Elite": 184, "Falgo": 118, "Melwin": 151, "Vakaeltraz": 164}),
    ("2025-10-13", {"Ael": 132, "Astral": 144, "Daytona_69": 169, "Elite": 171, "Falgo": 109, "Melwin": 135, "Rayou": 160}),
    ("2025-10-20", {"Ael": 118, "Astral": 142, "Daytona_69": 147,"Falgo": 91, "Lu_K": 153, "Melwin": 157, "Rayou": 161, "Vakaeltraz": 148}),
    ("2025-10-27", {"Astral": 152, "Daytona_69": 147, "Elite": 156, "J_sk8": 187, "Melwin": 161, "Rayou": 160,}),
    ("2025-11-03", {"Astral": 150, "Elite": 154, "Fozlo": 109, "J_sk8": 177, "Melwin": 157, "Rayou": 160, "Vakaeltraz": 155}),
    ("2025-11-10", {"Daytona_69": 121, "Elite": 150, "Falgo": 123, "Fozlo": 62, "J_sk8": 175, "Melwin": 167, "Rayou": 174, "Vakaeltraz": 140,}),
    ("2025-11-17", {"Ael": 120, "Astral": 118, "Daytona_69": 114, "Elite": 119, "Falgo": 86, "J_sk8": 151, "Lu_K": 125, "Melwin": 127, "Rayou": 149, "Vakaeltraz": 133}),
    ("2025-11-24", {"Ael": 110, "Daytona_69": 110, "Falgo": 112, "J_sk8": 184, "Lu_K": 151, "Melwin": 171, "Rayou": 128, "Vakaeltraz": 163}),
    ("2025-12-01", {"Ael": 87, "Astral": 128, "Daytona_69": 142, "Elite": 142, "Falgo": 102, "J_sk8": 140, "McK17": 68, "Melwin": 137, "Rayou": 155, "Vakaeltraz": 126}),
    ("2025-12-08", {"Ael": 103, "Astral": 132, "Elite": 115, "Falgo": 86, "J_sk8": 151, "Kemoory": 74, "McK17": 104, "Melwin": 145, "Rayou": 150, "Vakaeltraz": 140}),
    ("2025-12-15", {"J_sk8": 154, "Melwin": 149, "Rayou": 114, "Vakaeltraz": 176, "Elite": 119, "Astral": 133, "Ael": 98, "Falgo": 90, "McK17": 109, "Corentin": 94})
]

# === 1. ALGORITHME DE RÉSOLUTION (Trouver le Mu/Sigma du 16 Janvier) ===
print("🔄 Calcul des stats d'avant le 16 janvier...")

# Initialisation des estimations (On commence en supposant que Start = Target)
estimated_start = {name: {'mu': stat[0], 'sigma': stat[1]} for name, stat in target_stats_feb.items()}

# Boucle d'ajustement (On affine l'estimation)
ITERATIONS = 50
for it in range(ITERATIONS):
    # Création d'un environnement temporaire pour la simulation
    sim_ratings = {}
    for name, stats in estimated_start.items():
        sim_ratings[name] = trueskill.Rating(mu=stats['mu'], sigma=stats['sigma'])
    
    # Simulation des 3 tournois de Janvier
    for _, results in calibration_tournaments:
        match_players = []
        match_scores = []
        sorted_results = sorted(results.items(), key=lambda item: item[1], reverse=True)
        ranks = []
        current_rank = 1
        last_score = -1
        
        # Préparation du match
        temp_ratings = []
        active_players = [] # Liste pour garder l'ordre
        
        for i, (pname, score) in enumerate(sorted_results):
            # Si un joueur joue en janvier mais n'est pas dans la target list, on l'init par défaut
            if pname not in sim_ratings:
                sim_ratings[pname] = env.create_rating()
            
            if score != last_score:
                current_rank = i + 1
            ranks.append(current_rank)
            last_score = score
            
            temp_ratings.append(sim_ratings[pname])
            active_players.append(pname)

        teams = [[r] for r in temp_ratings]
        if len(teams) > 1:
            new_ratings_list = env.rate(teams, ranks=ranks)
            for i, pname in enumerate(active_players):
                sim_ratings[pname] = new_ratings_list[i][0]

    # Comparaison et Correction
    total_error = 0
    for name, target_stat in target_stats_feb.items():
        if name in sim_ratings:
            calculated = sim_ratings[name]
            
            # Différence entre ce qu'on a calculé et la cible réelle
            diff_mu = target_stat[0] - calculated.mu
            diff_sigma = target_stat[1] - calculated.sigma
            
            # Correction de l'estimation de départ
            # Si le résultat calculé est trop bas, on augmente le départ, et inversement.
            estimated_start[name]['mu'] += diff_mu
            estimated_start[name]['sigma'] += diff_sigma
            
            total_error += abs(diff_mu)

    if total_error < 0.01:
        print(f"✅ Convergé en {it+1} itérations !")
        break

print("✅ Stats initiales du 16 Janvier reconstruites.")

# === 2. GÉNÉRATION DU SQL (Avec les stats reconstruites) ===

# On fusionne toutes les listes de tournois
full_schedule = calibration_tournaments + main_tournaments

# On applique les stats estimées comme point de départ RÉEL
current_ratings = {}
for name, stats in estimated_start.items():
    current_ratings[name] = trueskill.Rating(mu=stats['mu'], sigma=stats['sigma'])

# Gestion des IDs
player_ids = {}
next_pid = 1
next_tid = 1
all_known_players = set(final_targets_order) 
for _, results in full_schedule:
    all_known_players.update(results.keys())

for pname in final_targets_order:
    player_ids[pname] = next_pid
    next_pid += 1

for pname in all_known_players:
    if pname not in player_ids:
        player_ids[pname] = next_pid
        next_pid += 1

consecutive_missed = {pname: 0 for pname in player_ids}
seed_sql = []

# Headers SQL
seed_sql.append("SET statement_timeout = 0;")
seed_sql.append("SET client_encoding = 'UTF8';")
seed_sql.append("SET standard_conforming_strings = on;")
seed_sql.append("")
seed_sql.append("TRUNCATE TABLE public.saisons CASCADE;")
seed_sql.append("TRUNCATE TABLE public.participations CASCADE;")
seed_sql.append("TRUNCATE TABLE public.tournois CASCADE;")
seed_sql.append("TRUNCATE TABLE public.joueurs CASCADE;")
seed_sql.append("")
seed_sql.append(f"INSERT INTO public.configuration (key, value) VALUES ('tau', '{env.tau}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;")
seed_sql.append("")

history_sql = []

# Traitement de TOUS les tournois (Janvier inclus)
for date_str, results in full_schedule:
    tid = next_tid
    next_tid += 1

    history_sql.append(f"INSERT INTO public.tournois (id, date) VALUES ({tid}, '{date_str}');")

    participants = results.keys()
    for pname in player_ids:
        if pname in participants:
            consecutive_missed[pname] = 0
        else:
            consecutive_missed[pname] += 1

    excluded_players = ts_exclusions.get(date_str, [])

    sorted_results = sorted(results.items(), key=lambda item: item[1], reverse=True)

    ts_results = [(pname, score) for pname, score in sorted_results if pname not in excluded_players]

    ts_match_players = []
    ts_ranks = []
    current_rank = 1
    last_score = -1

    for i, (pname, score) in enumerate(ts_results):
        if pname not in current_ratings:
            current_ratings[pname] = env.create_rating()
        if score != last_score:
            current_rank = i + 1
        ts_ranks.append(current_rank)
        last_score = score
        ts_match_players.append(current_ratings[pname])

    new_ratings_map = {}
    if len(ts_match_players) > 1:
        teams = [[r] for r in ts_match_players]
        new_ratings_list = env.rate(teams, ranks=ts_ranks)
        for i, (pname, score) in enumerate(ts_results):
            new_ratings_map[pname] = new_ratings_list[i][0]

    all_ranks = []
    current_rank = 1
    last_score = -1
    for i, (pname, score) in enumerate(sorted_results):
        if score != last_score:
            current_rank = i + 1
        all_ranks.append(current_rank)
        last_score = score

    for i, (pname, score) in enumerate(sorted_results):
        pid = player_ids[pname]
        if pname not in current_ratings:
            current_ratings[pname] = env.create_rating()
        old_r = current_ratings[pname]
        exclude_ts = pname in excluded_players

        if exclude_ts:
            new_r = old_r
        else:
            new_r = new_ratings_map.get(pname, old_r)
            current_ratings[pname] = new_r

        ts_score = new_r.mu - 3 * new_r.sigma
        tier = 'U'
        exclude_str = 'true' if exclude_ts else 'false'
        history_sql.append(f"INSERT INTO public.participations (joueur_id, tournoi_id, score, mu, sigma, new_score_trueskill, new_tier, position, old_mu, old_sigma, exclude_from_ts) VALUES ({pid}, {tid}, {score}, {new_r.mu:.4f}, {new_r.sigma:.4f}, {ts_score:.4f}, '{tier}', {all_ranks[i]}, {old_r.mu:.4f}, {old_r.sigma:.4f}, {exclude_str});")

# Insertion Joueurs
seed_sql.append("-- 1. INSERTION DES JOUEURS --")
for pname, pid in player_ids.items():
    rating = current_ratings.get(pname, env.create_rating())
    mu, sigma = rating.mu, rating.sigma
    tier = 'U'
    missed = consecutive_missed.get(pname, 0)
    color = PLAYER_COLORS.get(pname, "#FFFFFF") 
    seed_sql.append(f"INSERT INTO public.joueurs (id, nom, mu, sigma, tier, consecutive_missed, color) VALUES ({pid}, '{pname}', {mu:.4f}, {sigma:.4f}, '{tier}', {missed}, '{color}');")

seed_sql.append("")
seed_sql.append("-- 2. INSERTION DE L'HISTORIQUE --")
seed_sql.extend(history_sql)

# Saisons
saisons_data = [
    {"nom": "Hiver 2025", "slug": "hiver-2025", "debut": "2025-01-16", "fin": "2025-03-13", "victoire": "stakhanov", "yearly": False},
    {"nom": "Printemps 2025", "slug": "printemps-2025", "debut": "2025-03-20", "fin": "2025-06-19", "victoire": "stakhanov", "yearly": False},
    {"nom": "Été 2025", "slug": "ete-2025", "debut": "2025-06-26", "fin": "2025-09-18", "victoire": "stakhanov", "yearly": False},
    {"nom": "Automne 2025", "slug": "automne-2025", "debut": "2025-09-29", "fin": "2025-12-15", "victoire": "stakhanov", "yearly": False},
    {"nom": "Année 2025", "slug": "annee-2025", "debut": "2025-01-16", "fin": "2025-12-15", "victoire": "Indice de Performance", "yearly": True}
]

default_awards_config = '{"active_awards": ["ez", "pas_loin", "stonks", "not_stonks", "chillguy"]}'

seed_sql.append("")
seed_sql.append("-- 4. INSERTION DES SAISONS --")
sid = 1
for s in saisons_data:
    is_yearly_str = 'true' if s['yearly'] else 'false'
    seed_sql.append(f"INSERT INTO public.saisons (id, nom, slug, date_debut, date_fin, is_active, config_awards, victory_condition, is_yearly) VALUES ({sid}, '{s['nom']}', '{s['slug']}', '{s['debut']}', '{s['fin']}', true, '{default_awards_config}', '{s['victoire']}', {is_yearly_str});")
    sid += 1

seed_sql.append("")
seed_sql.append(f"SELECT pg_catalog.setval('public.joueurs_id_seq', {next_pid}, true);")
seed_sql.append(f"SELECT pg_catalog.setval('public.tournois_id_seq', {next_tid}, true);")
seed_sql.append(f"SELECT pg_catalog.setval('public.saisons_id_seq', {sid}, true);")

with open("seed.sql", "w", encoding="utf-8") as f:
    f.write("\n".join(seed_sql))

print("✅ Fichier seed.sql généré ! Astral et Clem sont désormais unifiés sous le nom 'Astral' avec l'historique complet.")
