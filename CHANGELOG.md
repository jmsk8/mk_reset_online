# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

---

## [1.3.0] - 2026-03-18

### Nouvelles fonctionnalités
- **Palmarès joueur** : nouvelle section sur le profil joueur affichant le nombre de podiums (or, argent, bronze) avec distinction par ligue quand le mode ligue est actif
- **Mode hybride ligue pour récaps classiques** : un récap en mode classique peut désormais inclure les stats de ligue et/ou les mouvements inter-ligue via deux options cochables à la création de saison. Détection automatique des tournois en ligue dans la période via le nouvel endpoint `/admin/count-tournois-range`. Les stats de ligue s'affichent dans des onglets dédiés (sans awards ni vainqueur), tandis que les awards et trophées restent exclusifs à l'onglet principal "Résultats". Choix du critère de mouvement (IP ou TrueSkill) à la publication. Nouvelles colonnes `include_league_stats` et `include_league_moves` dans la table `saisons`
- **Mode Mixte** : nouveau type de tournoi en mode ligue, jouable entre toutes les ligues sans restriction. Enregistré avec `ligue_id = NULL` et affiché avec un tag gris "Mixte". Exclu des récaps de ligue, inclus dans les récaps classiques. Pénalités ghost appliquées normalement
- **Colonne +/- TrueSkill** dans l'historique des tournois (`stats_tournoi.html`) et le profil joueur (`stats_joueur.html`) : affiche le gain/perte TrueSkill par match avec un tag coloré (vert pour les gains, rouge pour les pertes). Calcul basé sur `new_ts - (old_mu - 3*old_sigma)`
- **Refonte du tableau d'historique joueur** : colonnes réordonnées en Position, Score, +/-, Ligue, Date, Détails (au lieu de Date, Score, Ligue, Position, Détails)
- **Awards distribués par ligue** : en mode récap ligue, les awards (Stonks, Not Stonks, Chillguy, EZ, etc.) sont calculés indépendamment pour chaque ligue. Nouvelles colonnes `is_league_award`, `ligue_id`, `ligue_nom`, `ligue_couleur` dans `awards_obtenus`. Suppression d'une saison de ligue annule les mouvements inter-ligue associés
- **Glow de ligue sur les trophées** : les trophées et awards obtenus en ligue affichent un effet de lueur (`drop-shadow`) dans la couleur de la ligue, sur les pages de récap et les profils joueurs
- **Seuils de tier sur la page de classement** : nouvel endpoint `/tier-seuils` qui calcule les seuils mathématiques (S ≥ mean+σ, A ≥ mean, B ≥ mean−σ, C < mean−σ). Affichés comme tags colorés sur la page classement, remplaçant l'ancien champ de recherche joueur
- **Format de date français** : toutes les dates affichées sur le site sont désormais au format DD/MM/YYYY (API, templates, JavaScript). Les dates internes (tri, filtrage, inputs) restent en ISO

### Corrections
- **Pénalités d'absence scopées par ligue** : en mode ligue, les pénalités ghost ne s'appliquent plus qu'aux joueurs de la ligue concernée. Pour la ligue la plus basse, les joueurs sans ligue (`ligue_id IS NULL`) sont aussi inclus
- **Calcul ts_diff des pénalités ghost** : utilise maintenant le mu réel issu de la dernière participation avant la pénalité (sous-requête sur `Participations`) au lieu du mu courant du joueur
- **Contamination inter-ligue des awards** : `_compute_advanced_stonks()` accepte maintenant `recap_mode` et `specific_ligue_id` pour filtrer les participations par ligue
- **Seuil de participation pour awards** : Stonks, Not Stonks et Chillguy exigent désormais 50% de participation avec sigma < 2.5 (`matchs_ranked >= total_tournois * 0.5`)

### Améliorations

#### Architecture & Infrastructure
- **Refactoring backend** : éclatement du monolithique `backend.py` (~2800 lignes) en modules dédiés avec Flask Blueprints :
  - `routes_admin.py` — endpoints d'administration (1247 lignes)
  - `routes_public.py` — endpoints publics (1154 lignes)
  - `services.py` — logique métier (stats, tiers, awards)
  - `db.py` — pool de connexions PostgreSQL
  - `auth.py` — décorateur d'authentification admin
  - `cache.py` — système de cache en mémoire avec TTL
  - `constants.py` — constantes TrueSkill et configuration
  - `utils.py` — fonctions utilitaires (slugify, extraction de ligue)
- **Reverse proxy nginx** : nouveau fichier `nginx.conf` avec rate limiting (10r/s général, 30r/m admin), compression gzip, cache des assets statiques (7 jours), et headers de sécurité
- **Makefile** : 29 targets dont `build`, `re`, `redump`, `logs-{service}`, `db-shell`, `db-backup`, `fclean`, et rebuild par service (`re-front`, `re-back`, `re-db`, `re-db-dump`)
- **docker-compose.dump.yml** : fichier override pour seeder la base depuis `dump.sql` au lieu de `schema.sql`
- **PostgreSQL 13 → 17** (alpine) dans `docker-compose.yml`
- **Limites de ressources Docker** : CPU et mémoire plafonnés par conteneur (backend 1CPU/512M, frontend 1CPU/256M, nginx 0.5CPU/128M)
- **Réseaux Docker isolés** : séparation frontend/backend avec réseaux nommés
- **Health checks** : vérification de santé sur le frontend et la base de données
- **Dépendances pinées** : versions exactes dans `requirements.txt` (Flask 3.1.3, psycopg2 2.9.11, trueskill 0.4.5, gunicorn 23/25)
- **Dockerfiles optimisés** : builds multi-stage, utilisateur non-root (`appuser`), `.dockerignore` ajoutés

#### Sécurité
- **Protection CSRF activée** : suppression des `@csrf.exempt` sur 13 routes admin, token CSRF requis pour toutes les opérations d'écriture
- **Sanitization des entrées** : fonctions `escapeHtml()` et `sanitizeColor()` ajoutées côté frontend pour les modales d'awards, tooltips et légendes
- **Headers de sécurité** : `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy` via nginx et Flask
- **Cookies sécurisés** : `SESSION_COOKIE_SECURE = True`
- **`.env` ajouté au `.gitignore`** pour éviter la fuite de secrets

#### Base de données
- **Index de performance** : 8 nouveaux index sur les tables `Participations`, `Joueurs`, `Tournois`, `awards_obtenus`, et `ghost_log`
- **Contrainte unique étendue** sur `awards_obtenus` pour supporter les awards par ligue (`joueur_id, saison_id, award_id, ligue_id`)

#### Interface utilisateur
- **Responsive mobile** : layout en cartes pour les tableaux de tournoi sous 460px (`stats_tournoi.html`), layout vertical des stats joueur sous 346px, grille 2 colonnes entre 512-768px pour `stats_joueurs.html`, macro `joueur_card` pour le rendu DRY des cartes, tailles de police fluides avec `clamp()`
- **Tooltips enrichis** : les descriptions de trophées/awards incluent le nom de la saison, l'année (pour les Super Moai), et la ligue d'obtention. Affichage multiline dans les tooltips (`&#10;`) et dans la modale (conversion `\n` → `<br>`). Taille des Super Moai augmentée à 62px
- **Séparation classés/non-classés** : la page `stats_joueurs.html` affiche les joueurs classés et non-classés dans deux sections distinctes avec un séparateur "Non classés"
- **Onglet "Résultats"** : renommage de l'onglet "Classique" en "Résultats" dans les récaps
- **Récaps groupés par année** : la liste des récaps affiche les saisons regroupées par année avec des en-têtes visuels
- **Ratio V/D** : renommage de "Ratio V/T" en "Ratio V/D" (Victoires/Défaites) sur le profil joueur
- **README** : réécriture complète avec documentation des fonctionnalités, architecture (nginx → frontend → backend → PostgreSQL), structure du projet, variables d'environnement, et instructions de lancement (Docker Compose + Nix Flakes)

#### Banner SMK
- **Stats individuels par personnage** : 8 personnages avec `topSpeed`, `acceleration`, `handling`, `weight` uniques (ex: Bowser lourd/rapide, Toad léger/maniable)
- **Nouveaux items** : Red Shell (auto-guidée vers la cible), Shroom (boost instantané), Star (invincibilité + effet rainbow)
- **Distribution d'items style MK8DX** : 5 tiers basés sur le rang et la distance au leader, probabilités dynamiques
- **Collisions kart-vs-kart** basées sur le poids (les karts lourds repoussent les légers)
- **Système de momentum** : vitesse qui oscille naturellement entre 55% et 100% du `topSpeed`, transitions fluides
- **Items tenus en mains** : shroom/star devant le kart, banane/carapaces derrière
- **Récupération après impact** : pause → décélération progressive → redémarrage à 0
- **Anti-spam** : 2s d'invincibilité aux items après un impact (collisions kart restent actives)
- **Activation shroom/star** = vitesse max instantanée (ignore l'accélération)
- **Handling** module l'intensité d'esquive IA
- **Respawn des item boxes** réduit à 1 seconde
- **Effet neige** : système de particules avec dérive pour le thème hivernal
- **Leaderboard optimisé** : throttling à 500ms, tracking du leader en cache

---

## [1.2.0] - 2026-01-26

### Nouvelles fonctionnalités
- Ajout d'un thème hivernal avec effet de neige sur le banner SMK
- Refonte visuelle majeure du banner SMK (winter theme, assets optimisés)
- Implémentation stable du système de **Ligue** avec calcul et récap par ligue
- Ajout des couleurs de ligue dans l'historique des tournois

### Corrections
- Correction du calcul TrueSkill pour les resets globaux dans l'historique joueur
- Correction du bug de recalcul de ligue
- Correction du bug empêchant le mode ligue de se désactiver lors de la mise à jour des paramètres joueur
- Correction du bug de reset du graphe global

### Améliorations
- Amélioration des performances et de l'apparence du banner SMK
- Ajout de l'historique manquant des matchs du début 2025
- Finalisation de la logique de récap en mode ligue

---

## [1.1.0] - 2026-01-12

### Nouvelles fonctionnalités
- Ajout du **versionnage du site** affiché dans le footer
- Ajout du logo Mario sur toutes les pages
- Refonte complète du banner SMK avec un système de grille virtuelle et responsive
- Ajout d'une pause sur le banner et correction de la logique des égalités au classement
- Ajout du système de **désactivation du classement** (manuel + inactivité)
- Ajout d'un système d'augmentation de sigma pour les joueurs inactifs
- Ajout des liens vers les profils joueurs depuis la page d'accueil
- Ajout de l'award Moai et Super Moai, restructuration du système d'awards
- Ajout d'une condition de victoire de saison dans le récap
- Ajout de pages de récap saisonnier et d'un système d'awards de performance

### Corrections
- Correction de la résolution des URLs backend et de l'affichage du graphe joueur
- Correction d'un bug mineur dans `get_joueur_stats`
- Correction de la suppression, visibilité et définitions des awards (EZ, Stonks)
- Correction de la gestion de session admin (déconnexion si token invalide)
- Correction des headers d'authentification admin et du revert de tournoi
- Remplacement de l'utilisateur SQL `username` par `mk_reset`
- Corrections diverses SQL (global_resets, erreurs de schéma)
- Correction de l'emoji victoire (feu → trophée)

### Améliorations
- Refonte de l'interface ergonomique : suppression des paramètres joueurs codés en dur
- Amélioration de l'indentation des pages et de la mécanique de l'animation Mario Kart
- Refonte de l'animation de la page d'accueil, ajout de la banane
- Optimisation et compression de tous les sprites PNG
- Refonte de la page `admin-season` pour afficher correctement les awards `.png`
- Amélioration de l'aperçu des stats joueurs (vue globale et détails)
- Refactorisation du système de token admin
- Séparation de `db.sql` en `schema.sql` et `seed.sql`
- Amélioration des descriptions d'awards dans la page de récap

---

## [1.0.0] - 2025-12-11

### Point de départ — Première version officielle

**MK Reset Online** est une application web de suivi de classement pour des sessions Mario Kart entre joueurs réguliers. Le classement est calculé via l'algorithme **TrueSkill** de Microsoft, qui estime le niveau de chaque joueur sous forme d'une distribution gaussienne (µ ± σ).

### Fonctionnalités du site

**Classement**
- Classement dynamique avec attribution automatique de **tiers** (S, A, B, C...) basés sur l'écart-type de la distribution des scores
- Les joueurs non-classés (`U`) apparaissent en bas du classement
- Désactivation possible du classement (manuelle ou par inactivité)

**Profils joueurs**
- Page de statistiques par joueur : historique des tournois, évolution TrueSkill, awards obtenus
- Graphe d'évolution du score dans le temps

**Tournois**
- Enregistrement de sessions de tournois avec résultats par joueur
- Historique complet des tournois

**Récap saisonnier**
- Pages de récap de fin de saison avec awards de performance (EZ, Stonks, Moai, Grand Champion, PI scoring...)
- Workflow de publication géré par l'administrateur

**Administration**
- Interface admin sécurisée avec session timeout automatique
- Gestion des joueurs : ajout, modification, suppression
- Sauvegarde automatique de la base de données après chaque tournoi
- Possibilité de revert du dernier tournoi enregistré
- Personnalisation des couleurs des tiers de rang
- Configuration manuelle des paramètres TrueSkill (Tau)

**Infrastructure**
- Backend Python/Flask, base de données PostgreSQL dans un conteneur dédié
- Secrets et configuration via `.env`

---

*Ce changelog couvre les versions 1.0.0 à 1.3.0 (du 11 décembre 2025 au 18 mars 2026).*
