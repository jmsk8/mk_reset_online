# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

---

## [1.4.3] - 2026-08-22

### Nouvelles fonctionnalités
- **Indice de Performance v2** : nouveau calcul corrigeant le déséquilibre de force entre lobbies quand une session est découpée en groupes inégaux. Un coefficient `force_lobby` (1 + une correction proportionnelle à l'écart en points de mu entre le lobby et une référence, moyennes en *leave-one-out*) amortit l'inflation ou la déflation d'IP qui en résultait. L'écart est pris en points de mu et non en rapport : le mu TrueSkill est une échelle d'intervalle à origine arbitraire, donc seule la différence a un sens — un rapport rendrait la correction dépendante du niveau général, qu'un reset global suffirait à déplacer. La référence est la moyenne mu sur toute la période, toutes ligues confondues, ce qui permet aussi aux tournois à lobby unique de bénéficier d'une correction dynamique ; elle est figée par journée de tournoi via un instantané de la grille pris avant le premier tournoi du jour, pour qu'elle ne bouge plus à chaque tournoi ajouté. Le choix de version est piloté par la config `ip_version_live` (classement live) et par `saisons.ip_version`, figée à la création du récap et jamais modifiée ensuite. Bascules disponibles côté admin, et comparaison v1 / v2 côte à côte dans l'infobulle du graphe d'évolution d'IP
- **HTTPS avec Let's Encrypt** : configuration nginx templatisée par domaine et par mode TLS, certbot gérant l'émission et le renouvellement des certificats
- **Objets en orbite sur la bannière** *(désactivés pour le moment)* : trois nouveaux objets — triple banane, triple carapace verte et triple carapace rouge. Ils sont en place et testés mais **ne sont pas en jeu dans cette version** : les trois figurent dans `GAME_CONFIG.disabledItems`, vider cette liste suffit à les activer. Fonctionnement prévu : trois exemplaires tournent autour du kart et blessent tout adversaire qu'ils touchent ; ils encaissent aussi les projectiles adverses, un par impact. Chaque exemplaire a une phase figée à l'attribution, si bien qu'en perdre un — détruit au contact ou largué — ne redistribue jamais les autres : la rotation restante est identique. Un objet qui passe au loin reste affiché et glisse sous le z-index du kart, dont le sprite opaque l'occulte ; sa hitbox reste active, il est caché et non absent. Le porteur les largue ensuite un par un, chacun se comportant alors exactement comme l'objet simple correspondant : la banane est posée sur place, les carapaces partent vers l'avant et la rouge verrouille le kart de rang supérieur. Les trois partagent une même géométrie d'orbite (`GAME_CONFIG.orbit`) et se déclarent dans `GAME_CONFIG.orbitItems` : une ligne suffit pour en ajouter un quatrième
- **Objets désactivables** : `GAME_CONFIG.disabledItems` liste les types retirés du jeu. Leur poids est forcé à 0 dans tous les paliers et le reste du palier est renormalisé, sans avoir à retoucher les tableaux de distribution. Si un palier se retrouve entièrement désactivé, le kart repart sans objet plutôt que d'en recevoir un interdit
- **Tête-à-queue sur la bannière** : quand un kart prend une banane, une carapace ou tout autre malus, il fait deux tours complets sur lui-même. Les huit orientations viennent de cinq assets, les trois manquantes (ouest, sud-ouest, nord-ouest) étant obtenues en miroir. La toupie est jouée sur 80 % de la durée du malus, le temps avant que le kart reparte reste identique

### Corrections
- **Plafond d'IP à 150 % par tournoi** : `GM_MAX_RATIO_CAP` avait été retiré accidentellement, il est restauré. Il est en outre désormais appliqué *après* la correction de force de lobby, un match déjà plafonné pouvant sinon repasser au-dessus
- **Connexion admin en local** : `SESSION_COOKIE_SECURE` était forcé à `True`, or un cookie `Secure` n'est envoyé par le navigateur que sur une connexion HTTPS — ce qui bloquait toute connexion admin en HTTP local. Le flag suit maintenant le `TLS_MODE` réellement servi par nginx
- **Désynchronisation des collisions de la bannière** : la physique lisait des offsets spécifiques à l'appareil, si bien qu'un client PC et un client mobile pouvaient simuler des collisions différentes à partir du même état partagé. Les offsets sont désormais séparés entre `offsets.world` (physique, valeurs uniques quel que soit l'appareil) et `offsets.render` (affichage uniquement)
- **Assets de bannière dépareillés en cache** : `physics.js`, `smk-banner.js` et `smk-banner.css` sont cache-bustés par la version applicative, le cache 7 jours de nginx pouvant auparavant ne rafraîchir que l'un des trois
- **Nettoyage des conteneurs et volumes** dans le script de dump d'exemple

### Améliorations

#### Poids des images
- **Optimisation des 82 PNG du dépôt** : `static/img/` passe de 1482 Ko à 888 Ko (−40 %), et ce *malgré* l'ajout des 40 nouvelles frames d'animation du tête-à-queue. Trois leviers — ré-encodage (représentation minimale équivalente, meilleure stratégie de filtrage, métadonnées supprimées), quantification en palette 128 ou 256 couleurs choisie par fichier, et redimensionnement de ce qui était surdimensionné. Les sprites provenaient d'une chaîne de traitement avec perte et embarquaient des milliers de couleurs quasi identiques, ce qui les rendait lourds ; l'erreur moyenne après quantification est de 1,60 sur 255
- **Images surdimensionnées réduites** : le logo faisait 3648 px de large pour un affichage à 450 px, les trophées 500 px pour 120 px. Ramenés à environ deux fois leur taille d'affichage, marge pour les écrans à forte densité comprise. Le logo passe ainsi de 572 Ko à 122 Ko
- **Charge image de la page d'accueil** : 0,94 Mo → 0,54 Mo à la première visite en saison printemps (0,40 Mo en hiver, 0,47 Mo en été). Le poste karts est le seul à augmenter, de 127 Ko à 247 Ko, puisqu'il porte désormais 40 frames au lieu de 8 images statiques
- **Décor d'été redessiné** : la nouvelle illustration arrivée avec l'IP v2 est passée dans le même optimiseur, 216 Ko → 67 Ko

#### Bannière SMK
- **HUD de debug** : le classement affiche l'écart en pixels avec le premier, la mesure exacte dont dépendent les paliers de distribution d'objets. Il est désormais trié sur `totalDistance` comme la physique, et non plus sur `(lapCount, worldX)` : ce dernier divergeait du classement réel entre le bouclage de `worldX` et le franchissement de la ligne d'arrivée
- **Sprites directionnels** : le kart affiché utilise désormais `<perso>-side-right` du sous-dossier d'animation au lieu de `<perso>-static.png`. Les noms de fichiers des huit personnages ont été normalisés sur une convention unique, un seul constructeur de chemin les couvre tous
- **Suppression du flash coloré** qui teintait le kart au moment de l'impact ; la toupie signale seule le malus
- **Calques de parallaxe et soleil** ajoutés à la bannière d'été

#### Interface
- **Matchmaking ouvert à tous** : la page ne fait que consulter la liste publique des joueurs et calcule les équipes côté client, sans aucune action d'administration. L'authentification admin qui la protégeait est retirée et l'entrée passe dans la navbar principale
- **Animation d'entrée des cartes de tournoi** sur la page d'accueil

#### Infrastructure
- **TLS déporté sur un reverse proxy externe**, en remplacement de la gestion certbot interne introduite plus tôt dans le cycle
- **Consommation de ressources ajustée à l'hôte** : gunicorn passe de 4 à 2 workers côté backend et frontend (la machine n'a que 2 CPU), et le service de base de données est plafonné à 0,5 CPU et 256 Mo

#### Base de données et outillage
- **Migrations** : `2026-08-18_add_ip_version.sql` (config `ip_version_live` et colonne `saisons.ip_version`) et `2026-08-20_add_grille_snapshots.sql` (instantanés de grille par journée de tournoi)
- **Backfill** : `scripts/backfill_grille_snapshots.py` reconstruit les instantanés sur les données déjà en base
- **Scripts de dump** : `db-dump.sh` pour dumper la base en cours, `build-example-dump.sh` et `generate_example_data.py` pour régénérer un jeu de démonstration fictif. Les dumps personnels sortent du dépôt via `.gitignore`, `backEnd/dump.sql` devient un jeu d'exemple généré
- **`scripts/distclean.sh`** pour le nettoyage complet de l'environnement

#### Documentation
- **Plan d'authentification Discord** : `docs/auth-discord-plan.md`, notes de conception et registre de risques
- **Migration WebSocket de la bannière** : `docs/MIGRATION_BANNER_WSS.md`, notes préparatoires au passage de la simulation côté serveur

---

## [1.4.2] - 2026-07-07

### Nouvelles fonctionnalités
- **Onglet Matchmaking** : nouvel écran d'administration permettant de répartir les joueurs présents en lobbies équilibrés par niveau TrueSkill (10 joueurs maximum par lobby)

---

## [1.4.1] - 2026-06-22

### Nouvelles fonctionnalités
- **Award Instable** : nouvel award récompensant le joueur aux résultats les plus instables sur la période. Le score mesure l'amplitude des écarts de performance d'un tournoi à l'autre à partir de la position normalisée et de l'indice de performance. Pour rester fiable, le calcul ignore les tournois de moins de 3 joueurs (où la position devient quasi binaire), exige un minimum de 4 tournois joués, et combine l'amplitude des sauts consécutifs avec une mesure robuste (écart médian) pour ne pas surévaluer un accident isolé suivi d'un retour au niveau habituel. Un léger bonus récompense la régularité dans le haut du classement. Affiché sur les profils et dans les récaps, avec son trophée dédié
- **Graphe d'évolution de l'Indice de Performance** : nouveau graphique retraçant l'évolution de l'IP cumulé des joueurs au fil des tournois, présent sur les récaps de saison et sur le classement. Suit le mode du récap (classique, ligue, mixte)
- **Graphe de suivi des positions** : nouveau graphique d'évolution des positions des joueurs sur les pages de récap, accompagné d'un récapitulatif de la répartition des positions (nombre de 1res, 2es, 3es places, position moyenne) sur la période
- **Vue classement de saison** : nouvel onglet de classement basé sur la saison active, accessible via l'endpoint `/classement/saison`, avec sélection de ligue. Le graphe d'IP de cette vue est aligné sur l'ordre du classement
- **Détail des stats par ligue sur le profil joueur** : les statistiques et le palmarès du profil joueur sont désormais cliquables et ouvrent une fenêtre détaillant les chiffres ligue par ligue (matchs, podiums, position et score moyens)

### Améliorations

#### Banner SMK
- **Extraction du moteur physique** : toute la logique de simulation du banner (momentum, collisions, items, esquives) est sortie de `smk-banner.js` dans un module dédié `physics.js`, réutilisable et isolé du rendu
- **Compression de l'image de printemps** : la bannière de printemps passe de ~1,4 Mo à ~150 Ko

---

## [1.3.1] - 2026-06-09

### Corrections
- **Calcul des tiers et du top %** : unification de toute la logique (tiers, top %, seuils, courbes de distribution) sur une seule base de calcul.
- **Bannière saisonnière** : bascule désormais aux dates exactes au lieu du mois entier

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

#### Sécurité
- **Protection CSRF activée** : suppression des `@csrf.exempt` sur 13 routes admin, token CSRF requis pour toutes les opérations d'écriture
- **Sanitization des entrées** : fonctions `escapeHtml()` et `sanitizeColor()` ajoutées côté frontend pour les modales d'awards, tooltips et légendes
- **Headers de sécurité** : `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy` via nginx et Flask
- **Cookies sécurisés** : `SESSION_COOKIE_SECURE = True`

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
- **Banner saisonnier automatique** : le fond du banner change automatiquement selon la date actuelle (hiver/printemps). Images déplacées dans `img/banners/`, effet neige limité à l'hiver. Cache nginx passé de `immutable` à `must-revalidate`

#### Page Classement
- **Courbe de loi normale** : nouveau bloc "Positionnement des joueurs (Loi Normale)" sous le tableau de classement, affichant la distribution gaussienne des scores TrueSkill des joueurs ranked avec légende interactive, tooltips et highlight au survol
- **Zones de tiers sur la courbe** : zones colorées semi-transparentes (S/A/B/C) avec lignes de seuil en pointillés
- **Onglets de tier colorés** : les filtres S, A, B, C ont désormais la couleur de leur tier respectif

#### Palmarès
- **Podiums mixte comptés en classique** : les podiums obtenus en tournoi mixte sont désormais comptabilisés dans la section "Mode classique" du palmarès joueur

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

*Ce changelog couvre les versions 1.0.0 à 1.4.0 (depuis le 11 décembre 2025).*
