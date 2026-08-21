# Changements non publiés

Notes préparatoires pour la prochaine version. `APP_VERSION` vaut toujours
`1.4.2` dans `frontEnd/frontend.py` — l'incrémentation se fera au moment de la
release, en même temps que le report de ce fichier dans `CHANGELOG.md`.

Périmètre : 19 commits depuis `158f3c0` (1.4.2 du 2026-07-07), 122 fichiers,
+5185 / −1212.

---

## À faire au moment de la release

- [ ] Incrémenter `APP_VERSION` dans `frontEnd/frontend.py`. Cette valeur sert
      aussi de cache-buster à `smk-banner.js`, `physics.js` et `smk-banner.css` :
      sans bump, le cache 7 jours de nginx peut apparier un ancien script avec
      la nouvelle CSS
- [ ] Reporter les sections ci-dessous dans `CHANGELOG.md` sous
      `## [1.4.3] - <date>`
- [ ] Appliquer les deux migrations SQL (voir *Base de données* plus bas) et,
      sur une base existante, lancer `scripts/backfill_grille_snapshots.py`
- [ ] Supprimer ce fichier

---

## Nouvelles fonctionnalités

- **Indice de Performance v2** : nouveau calcul corrigeant le déséquilibre de
  force entre lobbies quand une session est découpée en groupes inégaux. Un
  coefficient `force_lobby` (moyenne mu du lobby rapportée à une référence, en
  *leave-one-out*) amortit l'inflation ou la déflation d'IP qui en résultait. La
  référence est la moyenne mu sur toute la période, toutes ligues confondues,
  ce qui permet aussi aux tournois à lobby unique de bénéficier d'une correction
  dynamique ; elle est figée par journée de tournoi via un instantané de la
  grille pris avant le premier tournoi du jour, pour qu'elle ne bouge plus à
  chaque tournoi ajouté. Le choix de version est piloté par la config
  `ip_version_live` (classement live) et par `saisons.ip_version`, figée à la
  création du récap et jamais modifiée ensuite. Bascules disponibles côté admin,
  et comparaison v1 / v2 côte à côte dans l'infobulle du graphe d'évolution d'IP
- **HTTPS avec Let's Encrypt** : configuration nginx templatisée par domaine et
  par mode TLS, certbot gérant l'émission et le renouvellement des certificats
- **Objets en orbite sur la bannière** : trois nouveaux objets — triple banane,
  triple carapace verte et triple carapace rouge. Trois exemplaires tournent
  autour du kart et blessent tout adversaire qu'ils touchent ; ils encaissent
  aussi les projectiles adverses, un par impact. Chaque exemplaire a une phase
  figée à l'attribution, si bien qu'en perdre un — détruit au contact ou largué
  — ne redistribue jamais les autres : la rotation restante est identique. Un
  objet qui passe au loin reste affiché et glisse sous le z-index du kart, dont
  le sprite opaque l'occulte ; sa hitbox reste active, il est caché et non
  absent. Le porteur les largue ensuite un par un, chacun se comportant alors
  exactement comme l'objet simple correspondant : la banane est posée sur place,
  les carapaces partent vers l'avant et la rouge verrouille le kart de rang
  supérieur. Les trois partagent une même géométrie d'orbite (`GAME_CONFIG.orbit`)
  et se déclarent dans `GAME_CONFIG.orbitItems` : une ligne suffit pour en
  ajouter un quatrième
- **Objets désactivables** : `GAME_CONFIG.disabledItems` liste les types retirés
  du jeu. Leur poids est forcé à 0 dans tous les paliers et le reste du palier
  est renormalisé, sans avoir à retoucher les tableaux de distribution. Si un
  palier se retrouve entièrement désactivé, le kart repart sans objet plutôt que
  d'en recevoir un interdit
- **Tête-à-queue sur la bannière** : quand un kart prend une banane, une
  carapace ou tout autre malus, il fait deux tours complets sur lui-même. Les
  huit orientations viennent de cinq assets, les trois manquantes (ouest,
  sud-ouest, nord-ouest) étant obtenues en miroir. La toupie est jouée sur 80 %
  de la durée du malus, le temps avant que le kart reparte reste identique

## Corrections

- **Plafond d'IP à 150 % par tournoi** : `GM_MAX_RATIO_CAP` avait été retiré
  accidentellement, il est restauré. Il est en outre désormais appliqué *après*
  la correction de force de lobby, un match déjà plafonné pouvant sinon repasser
  au-dessus
- **Connexion admin en local** : `SESSION_COOKIE_SECURE` était forcé à `True`,
  or un cookie `Secure` n'est envoyé par le navigateur que sur une connexion
  HTTPS — ce qui bloquait toute connexion admin en HTTP local. Le flag suit
  maintenant le `TLS_MODE` réellement servi par nginx
- **Désynchronisation des collisions de la bannière** : la physique lisait des
  offsets spécifiques à l'appareil, si bien qu'un client PC et un client mobile
  pouvaient simuler des collisions différentes à partir du même état partagé.
  Les offsets sont désormais séparés entre `offsets.world` (physique, valeurs
  uniques quel que soit l'appareil) et `offsets.render` (affichage uniquement)
- **Assets de bannière dépareillés en cache** : `physics.js`, `smk-banner.js` et
  `smk-banner.css` sont cache-bustés par la version applicative, le cache 7
  jours de nginx pouvant auparavant ne rafraîchir que l'un des trois
- **Nettoyage des conteneurs et volumes** dans le script de dump d'exemple

## Améliorations

### Poids des images

- **Optimisation des 82 PNG du dépôt** : `static/img/` passe de 1482 Ko à
  888 Ko (−40 %), et ce *malgré* l'ajout des 40 nouvelles frames d'animation du
  tête-à-queue. Trois leviers — ré-encodage (représentation minimale
  équivalente, meilleure stratégie de filtrage, métadonnées supprimées),
  quantification en palette 128 ou 256 couleurs choisie par fichier, et
  redimensionnement de ce qui était surdimensionné. Les sprites provenaient
  d'une chaîne de traitement avec perte et embarquaient des milliers de couleurs
  quasi identiques, ce qui les rendait lourds ; l'erreur moyenne après
  quantification est de 1,60 sur 255
- **Images surdimensionnées réduites** : le logo faisait 3648 px de large pour
  un affichage à 450 px, les trophées 500 px pour 120 px. Ramenés à environ deux
  fois leur taille d'affichage, marge pour les écrans à forte densité comprise.
  Le logo passe ainsi de 572 Ko à 122 Ko
- **Charge image de la page d'accueil** : 0,94 Mo → 0,54 Mo à la première visite
  en saison printemps (0,40 Mo en hiver, 0,47 Mo en été). Le poste karts est le
  seul à augmenter, de 127 Ko à 247 Ko, puisqu'il porte désormais 40 frames au
  lieu de 8 images statiques
- **Décor d'été redessiné** : la nouvelle illustration arrivée avec l'IP v2 est
  passée dans le même optimiseur, 216 Ko → 67 Ko

### Bannière SMK

- **HUD de debug** : le classement affiche l'écart en pixels avec le premier,
  la mesure exacte dont dépendent les paliers de distribution d'objets. Il est
  désormais trié sur `totalDistance` comme la physique, et non plus sur
  `(lapCount, worldX)` : ce dernier divergeait du classement réel entre le
  bouclage de `worldX` et le franchissement de la ligne d'arrivée
- **Sprites directionnels** : le kart affiché utilise désormais
  `<perso>-side-right` du sous-dossier d'animation au lieu de
  `<perso>-static.png`. Les noms de fichiers des huit personnages ont été
  normalisés sur une convention unique, un seul constructeur de chemin les
  couvre tous
- **Suppression du flash coloré** qui teintait le kart au moment de l'impact ;
  la toupie signale seule le malus
- **Calques de parallaxe et soleil** ajoutés à la bannière d'été

### Interface

- **Matchmaking ouvert à tous** : la page ne fait que consulter la liste
  publique des joueurs et calcule les équipes côté client, sans aucune action
  d'administration. L'authentification admin qui la protégeait est retirée et
  l'entrée passe dans la navbar principale
- **Animation d'entrée des cartes de tournoi** sur la page d'accueil

### Infrastructure

- **TLS déporté sur un reverse proxy externe**, en remplacement de la gestion
  certbot interne introduite plus tôt dans le cycle
- **Consommation de ressources ajustée à l'hôte** : gunicorn passe de 4 à 2
  workers côté backend et frontend (la machine n'a que 2 CPU), et le service de
  base de données est plafonné à 0,5 CPU et 256 Mo

### Base de données et outillage

- **Migrations** : `2026-08-18_add_ip_version.sql` (config `ip_version_live` et
  colonne `saisons.ip_version`) et `2026-08-20_add_grille_snapshots.sql`
  (instantanés de grille par journée de tournoi)
- **Backfill** : `scripts/backfill_grille_snapshots.py` reconstruit les
  instantanés sur les données déjà en base
- **Scripts de dump** : `db-dump.sh` pour dumper la base en cours,
  `build-example-dump.sh` et `generate_example_data.py` pour régénérer un jeu de
  démonstration fictif. Les dumps personnels sortent du dépôt via `.gitignore`,
  `backEnd/dump.sql` devient un jeu d'exemple généré
- **`scripts/distclean.sh`** pour le nettoyage complet de l'environnement

### Documentation

- **Plan d'authentification Discord** : `docs/auth-discord-plan.md`, notes de
  conception et registre de risques
- **Migration WebSocket de la bannière** : `docs/MIGRATION_BANNER_WSS.md`, notes
  préparatoires au passage de la simulation côté serveur
