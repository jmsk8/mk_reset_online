import trueskill
import math
from datetime import datetime

# === CONFIGURATION ===
env = trueskill.TrueSkill(mu=50.0, sigma=8.333, beta=4.167, tau=0.083, draw_probability=0.1)

# === CIBLES (ORDRE DES IDs) ===
final_targets_order = [
    "Rosalyan", "J_sk8", "Elite", "Rayou", "Vakaeltraz", "Melwin", "Lu_K", 
    "Clem", "Daytona_69", "JeanCube", "Oleas", "Thaumas", "Ether-Zero", 
    "Ael", "Tomwilson", "Falgo", "Brook1l", "Hardox", "ColorOni", "Camou", 
    "Keemory", "Fozlo", "McK17", "Kaysuan", "PastPlayer", "Tomy", "Mirijason"
]

initial_stats = {
    "Elite": (60.812, 1.594),
    "Vakaeltraz": (58.046, 1.273),
    "J_sk8": (54.004, 1.226),
    "Melwin": (52.741, 1.449),
    "Clem": (48.739, 1.368),
    "Lu_K": (53.820, 3.335),
    "Oleas": (56.247, 4.235),
    "Thaumas": (51.464, 2.719),
    "Ether-Zero": (52.986, 4.335),
    "Daytona_69": (45.619, 2.056),
    "Tomwilson": (49.867, 4.522),
    "Camou": (50.053, 4.679),
    "Brook1l": (43.382, 2.539),
    "Hardox": (40.936, 2.108),
    "JeanCube": (45.816, 3.812),
    "Kemoory": (39.914, 2.369),
    "Fozlo": (36.466, 2.307),
    "McK17": (50.000, 8.333),
    "Kaysuan": (50.000, 8.333),
    "PastPlayer": (50.000, 8.333),
    "Tomy": (50.000, 8.333),
    "Mirijason": (50.000, 8.333),
    "Rosalyan": (50.000, 8.333),
    "ColorOni": (50.000, 8.333),
    "Falgo": (50.000, 8.333),
    "Ael": (50.000, 8.333),
    "Rayou": (50.000, 8.333),
    "Corentin": (50.000, 8.333)
}

current_ratings = {}
for name, (mu, sigma) in initial_stats.items():
    current_ratings[name] = trueskill.Rating(mu=mu, sigma=sigma)

tournaments = [
    # === HIVER 2025 ===
    ("2025-02-06", {"Clem": 154, "Elite": 173, "J_sk8": 180, "Kemoory": 124, "Lu_K": 152, "Mirijason": 116, "Vakaeltraz": 149}),
    ("2025-02-13", {"Clem": 154, "Elite": 142, "Lu_K": 138, "Rosalyan": 197, "Vakaeltraz": 143}),
    ("2025-02-20", {"Elite": 175, "Fozlo": 73, "J_sk8": 163, "Lu_K": 159, "Vakaeltraz": 199}),
    ("2025-02-27", {"Camou": 94, "Clem": 128, "Elite": 172, "Fozlo": 111, "J_sk8": 134, "JeanCube": 150, "Lu_K": 144, "Melwin": 127, "Tomy": 69, "Vakaeltraz": 116}),
    ("2025-03-06", {"Lu_K": 178, "Rayou": 195, "Rosalyan": 219}),
    ("2025-03-13", {"Clem": 164, "Melwin": 157, "Rosalyan": 227, "Vakaeltraz": 173}),
     # === PRINTEMPS 2025 ===
    ("2025-03-20", {"Brook1l": 127, "Elite": 175, "Lu_K": 174, "Rosalyan": 202, "Tomy": 111, "Vakaeltraz": 164}),
    ("2025-03-27", {"Clem": 134, "Elite": 166, "J_sk8": 158, "JeanCube": 154, "Lu_K": 145, "Melwin": 152, "Vakaeltraz": 143}),
    ("2025-04-03", {"Clem": 185, "Daytona_69": 171, "Lu_K": 189, "Vakaeltraz": 185}),
    ("2025-04-10", {"Daytona_69": 153, "Fozlo": 107, "J_sk8": 150, "Lu_K": 156, "Melwin": 142, "Rosalyan": 194, "Vakaeltraz": 149}),
    ("2025-04-17", {"Clem": 167, "Elite": 179, "JeanCube": 163, "Melwin": 148, "Vakaeltraz": 194}),
    ("2025-04-24", {"Camou": 117, "Clem": 123, "Daytona_69": 128, "Elite": 150, "J_sk8": 157, "Melwin": 157, "Rosalyan": 215}),
    ("2025-05-08", {"Clem": 179, "Elite": 180, "Melwin": 175, "Vakaeltraz": 180}),
    ("2025-05-15", {"Lu_K": 162, "Melwin": 171, "Rosalyan": 207, "Vakaeltraz": 183}),
    ("2025-05-22", {"Clem": 141, "J_sk8": 191, "JeanCube": 162, "Lu_K": 171, "PastPlayer": 113, "Vakaeltraz": 170}),
    ("2025-06-12", {"Clem": 199, "Elite": 103, "Melwin": 181, "Vakaeltraz": 193}),
    ("2025-06-19", {"Elite": 146, "J_sk8": 173, "Lu_K": 147, "Rayou": 148, "Rosalyan": 186, "Vakaeltraz": 158}),
        # === ÉTÉ 2025 ===
    ("2025-06-26", {"Elite": 178, "J_sk8": 153, "Kemoory": 97, "Lu_K": 161, "Melwin": 162, "Rayou": 144, "Vakaeltraz": 146}),
    ("2025-07-03", {"Clem": 122, "Elite": 143, "J_sk8": 172, "Kemoory": 113, "Melwin": 159, "Rayou": 145, "Vakaeltraz": 189}),
    ("2025-07-10", {"Fozlo": 168, "Lu_K": 196, "Melwin": 176, "Rayou": 177}),
    ("2025-07-17", {"Clem": 170, "Elite": 184, "Melwin": 187, "Vakaeltraz": 183}),
    ("2025-07-24", {"Brook1l": 122, "Elite": 170, "Fozlo": 128, "J_sk8": 201, "Melwin": 162, "Rayou": 188}),
    ("2025-07-31", {"Clem": 161, "ColorOni": 123, "Daytona_69": 128, "Elite": 148, "J_sk8": 140, "JeanCube": 113, "Rayou": 169, "Vakaeltraz": 148}),
    ("2025-08-07", {"Clem": 177, "Melwin": 174, "Rayou": 181, "Vakaeltraz": 173}),
    ("2025-08-14", {"Elite": 177, "Kaysuan": 113, "Lu_K": 184, "Melwin": 158, "Rayou": 144, "Vakaeltraz": 162}),
    ("2025-08-21", {"Elite": 164, "J_sk8": 188, "Lu_K": 162, "Melwin": 163, "Rayou": 58, "Vakaeltraz": 159}),
    ("2025-08-28", {"Daytona_69": 158, "Elite": 170, "J_sk8": 165, "Lu_K": 143, "Melwin": 161, "Vakaeltraz": 166}),
    ("2025-09-04", {"Elite": 181, "J_sk8": 196, "Lu_K": 147, "Rayou": 157, "Vakaeltraz": 164}),
    ("2025-09-18", {"Clem": 139, "Daytona_69": 150, "Elite": 149, "J_sk8": 160, "Melwin": 116, "Rayou": 169, "Vakaeltraz": 152}),
        # === AUTOMNE 2025 ===
    ("2025-09-29", {"Ael": 108, "Clem": 131, "Daytona_69": 157, "Elite": 159, "Falgo": 104, "J_sk8": 163, "Melwin": 156, "Vakaeltraz": 158}),
    ("2025-10-06", {"Ael": 152, "Daytona_69": 180, "Elite": 184, "Falgo": 118, "Melwin": 151, "Vakaeltraz": 164}),
    ("2025-10-13", {"Ael": 132, "Clem": 144, "Daytona_69": 169, "Elite": 171, "Falgo": 109, "Melwin": 135, "Rayou": 160}),
    ("2025-10-20", {"Ael": 118, "Clem": 142, "Daytona_69": 147,"Falgo": 91, "Lu_K": 153, "Melwin": 157, "Rayou": 161, "Vakaeltraz": 148}),
    ("2025-10-27", {"Clem": 152, "Daytona_69": 147, "Elite": 156, "J_sk8": 187, "Melwin": 161, "Rayou": 160,}),
    ("2025-11-03", {"Clem": 150, "Elite": 154, "Fozlo": 109, "J_sk8": 177, "Melwin": 157, "Rayou": 160, "Vakaeltraz": 155}),
    ("2025-11-10", {"Daytona_69": 121, "Elite": 150, "Falgo": 123, "Fozlo": 62, "J_sk8": 175, "Melwin": 167, "Rayou": 174, "Vakaeltraz": 140,}),
    ("2025-11-17", {"Ael": 120, "Clem": 118, "Daytona_69": 114, "Elite": 119, "Falgo": 86, "J_sk8": 151, "Lu_K": 125, "Melwin": 127, "Rayou": 149, "Vakaeltraz": 133}),
    ("2025-11-24", {"Ael": 110, "Daytona_69": 110, "Falgo": 112, "J_sk8": 184, "Lu_K": 151, "Melwin": 171, "Rayou": 128, "Vakaeltraz": 163}),
    ("2025-12-01", {"Ael": 87, "Clem": 128, "Daytona_69": 142, "Elite": 142, "Falgo": 102, "J_sk8": 140, "McK17": 68, "Melwin": 137, "Rayou": 155, "Vakaeltraz": 126}),
    ("2025-12-08", {"Ael": 103, "Clem": 132, "Elite": 115, "Falgo": 86, "J_sk8": 151, "Kemoory": 74, "McK17": 104, "Melwin": 145, "Rayou": 150, "Vakaeltraz": 140}),
    ("2025-12-15", {"J_sk8": 154, "Melwin": 149, "Rayou": 114, "Vakaeltraz": 176, "Elite": 119, "Clem": 133, "Ael": 98, "Falgo": 90, "McK17": 109, "Corentin": 94})
]

# === 1. INITIALISATION DES IDs ===
player_ids = {}
next_pid = 1
next_tid = 1

for pname in final_targets_order:
    player_ids[pname] = next_pid
    next_pid += 1

for pname in initial_stats:
    if pname not in player_ids:
        player_ids[pname] = next_pid
        next_pid += 1

for _, results in tournaments:
    for pname in results:
        if pname not in player_ids:
            player_ids[pname] = next_pid
            next_pid += 1

# === 2. SIMULATION ET GÉNÉRATION DE SEED ===
seed_sql = []

# En-têtes et Nettoyage
seed_sql.append("SET statement_timeout = 0;")
seed_sql.append("SET client_encoding = 'UTF8';")
seed_sql.append("SET standard_conforming_strings = on;")
seed_sql.append("")
seed_sql.append("-- Nettoyage des données existantes (pour éviter les conflits) --")
seed_sql.append("TRUNCATE TABLE public.participations CASCADE;")
seed_sql.append("TRUNCATE TABLE public.tournois CASCADE;")
seed_sql.append("TRUNCATE TABLE public.joueurs CASCADE;")
seed_sql.append("")

# Mise à jour de la configuration pour matcher la simulation
seed_sql.append("-- Mise à jour de la configuration --")
seed_sql.append(f"INSERT INTO public.configuration (key, value) VALUES ('tau', '{env.tau}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;")
seed_sql.append("")

# Génération des données de tournois
history_sql = []
for date_str, results in tournaments:
    tid = next_tid
    next_tid += 1
    
    history_sql.append(f"INSERT INTO public.tournois (id, date) VALUES ({tid}, '{date_str}');")
    
    match_players = []
    match_scores = []
    sorted_results = sorted(results.items(), key=lambda item: item[1], reverse=True)
    
    ranks = []
    current_rank = 1
    last_score = -1
    
    for i, (pname, score) in enumerate(sorted_results):
        if pname not in current_ratings:
            current_ratings[pname] = env.create_rating()
                
        if score != last_score:
            current_rank = i + 1
        ranks.append(current_rank)
        last_score = score
        
        match_players.append(current_ratings[pname])
        match_scores.append(score)

    teams = [[r] for r in match_players]
    if len(teams) > 1:
        new_ratings_list = env.rate(teams, ranks=ranks)
        
        for i, (pname, score) in enumerate(sorted_results):
            pid = player_ids[pname]
            old_r = match_players[i]
            new_r = new_ratings_list[i][0]
            current_ratings[pname] = new_r
            ts_score = new_r.mu - 3 * new_r.sigma
            tier = 'U'
            history_sql.append(f"INSERT INTO public.participations (joueur_id, tournoi_id, score, mu, sigma, new_score_trueskill, new_tier, position, old_mu, old_sigma) VALUES ({pid}, {tid}, {score}, {new_r.mu:.4f}, {new_r.sigma:.4f}, {ts_score:.4f}, '{tier}', {ranks[i]}, {old_r.mu:.4f}, {old_r.sigma:.4f});")

# Insertion des joueurs (avec leurs stats finales issues de la simulation)
seed_sql.append("-- 1. INSERTION DES JOUEURS (VALEURS CALCULÉES FINALES) --")
for pname, pid in player_ids.items():
    rating = current_ratings.get(pname, env.create_rating())
    mu, sigma = rating.mu, rating.sigma
    tier = 'U'
    seed_sql.append(f"INSERT INTO public.joueurs (id, nom, mu, sigma, tier) VALUES ({pid}, '{pname}', {mu:.4f}, {sigma:.4f}, '{tier}');")

seed_sql.append("")
seed_sql.append("-- 2. INSERTION DE L'HISTORIQUE --")
seed_sql.extend(history_sql)

seed_sql.append("")
seed_sql.append("-- 3. RESET DES SÉQUENCES --")
seed_sql.append(f"SELECT pg_catalog.setval('public.joueurs_id_seq', {next_pid}, true);")
seed_sql.append(f"SELECT pg_catalog.setval('public.tournois_id_seq', {next_tid}, true);")

# Écriture du fichier SEED seulement
with open("seed.sql", "w", encoding="utf-8") as f:
    f.write("\n".join(seed_sql))

print("✅ seed.sql généré avec succès")

# tournaments = [
#("2025-02-06", {"Clem": 154, "Elite": 173, "J_sk8": 180, "Kemoory": 124, "Lu_K": 152, "Mirijason": 116, "Vakaeltraz": 149}),
#("2025-02-13", {"Clem": 154, "Elite": 142, "Lu_K": 138, "Rosalyan": 197, "Vakaeltraz": 143}),
#("2025-02-20", {"Elite": 175, "Fozlo": 73, "J_sk8": 163, "Lu_K": 159, "Vakaeltraz": 199}),
#("2025-02-27", {"Camou": 94, "Clem": 128, "Elite": 172, "Fozlo": 111, "J_sk8": 134, "JeanCube": 150, "Lu_K": 144, "Melwin": 127, "Tomy": 69, "Vakaeltraz": 116}),
#("2025-03-06", {"Lu_K": 178, "Rayou": 195, "Rosalyan": 219}),
#("2025-03-13", {"Clem": 164, "Melwin": 157, "Rosalyan": 227, "Vakaeltraz": 173}),
#("2025-03-20", {"Brook1l": 127, "Elite": 175, "Lu_K": 174, "Rosalyan": 202, "Tomy": 111, "Vakaeltraz": 164}),
#("2025-03-27", {"Clem": 134, "Elite": 166, "J_sk8": 158, "JeanCube": 154, "Lu_K": 145, "Melwin": 152, "Vakaeltraz": 143}),
#("2025-04-03", {"Clem": 185, "Daytona_69": 171, "Lu_K": 189, "Vakaeltraz": 185}),
#("2025-04-10", {"Daytona_69": 153, "Fozlo": 107, "J_sk8": 150, "Lu_K": 156, "Melwin": 142, "Rosalyan": 194, "Vakaeltraz": 149}),
#("2025-04-17", {"Clem": 167, "Elite": 179, "JeanCube": 163, "Melwin": 148, "Vakaeltraz": 194}),
#("2025-04-24", {"Camou": 117, "Clem": 123, "Daytona_69": 128, "Elite": 150, "J_sk8": 157, "Melwin": 157, "Rosalyan": 215}),
#("2025-05-08", {"Clem": 179, "Elite": 180, "Melwin": 175, "Vakaeltraz": 180}),
#("2025-05-15", {"Lu_K": 162, "Melwin": 171, "Rosalyan": 207, "Vakaeltraz": 183}),
#("2025-05-22", {"Clem": 141, "J_sk8": 191, "JeanCube": 162, "Lu_K": 171, "PastPlayer": 113, "Vakaeltraz": 170}),
#("2025-06-12", {"Clem": 199, "Elite": 103, "Melwin": 181, "Vakaeltraz": 193}),
## Note : Dates du 04/06 et 05/06 ignorées (erreurs/pas de tournoi)
#("2025-06-19", {"Elite": 146, "J_sk8": 173, "Lu_K": 147, "Rayou": 148, "Rosalyan": 186, "Vakaeltraz": 158}),
#("2025-06-26", {"Elite": 178, "J_sk8": 153, "Kemoory": 97, "Lu_K": 161, "Melwin": 162, "Rayou": 144, "Vakaeltraz": 146}),
#("2025-07-03", {"Clem": 122, "Elite": 143, "J_sk8": 172, "Kemoory": 113, "Melwin": 159, "Rayou": 145, "Vakaeltraz": 189}),
#("2025-07-10", {"Fozlo": 168, "Lu_K": 196, "Melwin": 176, "Rayou": 177}),
#("2025-07-17", {"Clem": 170, "Elite": 184, "Melwin": 187, "Vakaeltraz": 183}),
#("2025-07-24", {"Brook1l": 122, "Elite": 170, "Fozlo": 128, "J_sk8": 201, "Melwin": 162, "Rayou": 188}),
#("2025-07-31", {"Clem": 161, "ColorOni": 123, "Daytona_69": 128, "Elite": 148, "J_sk8": 140, "JeanCube": 113, "Rayou": 169, "Vakaeltraz": 148}),
#("2025-08-07", {"Clem": 177, "Melwin": 174, "Rayou": 181, "Vakaeltraz": 173}),
#("2025-08-14", {"Elite": 177, "Kaysuan": 113, "Lu_K": 184, "Melwin": 158, "Rayou": 144, "Vakaeltraz": 162}),
#("2025-08-21", {"Elite": 164, "J_sk8": 188, "Lu_K": 162, "Melwin": 163, "Rayou": 58, "Vakaeltraz": 159}),
#("2025-08-28", {"Daytona_69": 158, "Elite": 170, "J_sk8": 165, "Lu_K": 143, "Melwin": 161, "Vakaeltraz": 166}),
#("2025-09-04", {"Elite": 181, "J_sk8": 196, "Lu_K": 147, "Rayou": 157, "Vakaeltraz": 164}),
#("2025-09-18", {"Clem": 139, "Daytona_69": 150, "Elite": 149, "J_sk8": 160, "Melwin": 116, "Rayou": 169, "Vakaeltraz": 152}),
#("2025-09-29", {"Ael": 108, "Clem": 131, "Daytona_69": 157, "Elite": 159, "Falgo": 104, "J_sk8": 163, "Melwin": 156, "Vakaeltraz": 158}),
#("2025-10-06", {"Ael": 152, "Daytona_69": 180, "Elite": 184, "Falgo": 118, "Melwin": 151, "Vakaeltraz": 164}),
#("2025-10-13", {"Ael": 132, "Clem": 144, "Daytona_69": 169, "Elite": 171, "Falgo": 109, "Melwin": 135, "Rayou": 160}),
#("2025-10-20", {"Ael": 118, "Clem": 142, "Daytona_69": 147,"Falgo": 91, "Lu_K": 153, "Melwin": 157, "Rayou": 161, "Vakaeltraz": 148}),
#("2025-10-27", {"Clem": 152, "Daytona_69": 147, "Elite": 156, "J_sk8": 187, "Melwin": 161, "Rayou": 160,}),
#("2025-11-03", {"Clem": 150, "Elite": 154, "Fozlo": 109, "J_sk8": 177, "Melwin": 157, "Rayou": 160, "Vakaeltraz": 155}),
#("2025-11-10", {"Daytona_69": 121, "Elite": 150, "Falgo": 123, "Fozlo": 62, "J_sk8": 175, "Melwin": 167, "Rayou": 174, "Vakaeltraz": 140,}),
#("2025-11-17", {"Ael": 120, "Clem": 118, "Daytona_69": 114, "Elite": 119, "Falgo": 86, "J_sk8": 151, "Lu_K": 125, "Melwin": 127, "Rayou": 149, "Vakaeltraz": 133}),
#("2025-11-24", {"Ael": 110, "Daytona_69": 110, "Falgo": 112, "J_sk8": 184, "Lu_K": 151, "Melwin": 171, "Rayou": 128, "Vakaeltraz": 163}),
#("2025-12-01", {"Ael": 87, "Clem": 128, "Daytona_69": 142, "Elite": 142, "Falgo": 102, "J_sk8": 140, "McK17": 68, "Melwin": 137, "Rayou": 155, "Vakaeltraz": 126}),
#("2025-12-08", {"Ael": 103, "Clem": 132, "Elite": 115, "Falgo": 86, "J_sk8": 151, "Kemoory": 74, "McK17": 104, "Melwin": 145, "Rayou": 150, "Vakaeltraz": 140})
#] 
