# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

---

## [2.0.0] - 2026-09-27

### ⚠️ Changements incompatibles

- **Le mot de passe administrateur n'existe plus.** L'administration du site passait jusqu'ici par un mot de passe unique, partagé par tous ceux qui l'administraient, saisi sur une page dédiée. Il est supprimé : on administre désormais le site avec **son propre compte Discord**, et rien d'autre. Ce n'est pas qu'une commodité — un secret partagé ne dit jamais *qui* a agi, alors que le journal d'administration nomme maintenant chaque action et la personne qui l'a faite. Trois défauts disparaissent du même coup : le jeton de connexion était stocké **en clair** dans la base, il pouvait se renouveler **indéfiniment** — un jeton volé restait donc valable sans limite — et la page de connexion restait ouverte à qui connaissait son adresse. Ce qui disparaît concrètement : la page `/admin`, le minuteur « session bientôt expirée » du menu, et la table qui gardait ces jetons. **Pour qui administre le site**, rien à faire : la connexion Discord était déjà le seul chemin qui ouvrait quoi que ce soit depuis plusieurs jours. **Pour qui déploie** : `ADMIN_PASSWORD_HASH` n'est plus lue et peut être retirée du `.env` ; une migration supprime la table `api_tokens`, et la procédure d'accès de secours est décrite dans `docs/runbook-admin.md`
- **Mise à jour à préparer pour qui déploie.** Cette version ne démarre pas correctement sans configuration préalable. Une application Discord doit être déclarée et renseignée dans le `.env` (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `DISCORD_SUPERADMIN_ID`), ainsi que les informations des mentions légales (`SITE_EDITEUR`, `SITE_CONTACT`, `SITE_HEBERGEUR`, `SITE_RETENTION_LOGS`). Dix-huit migrations sont à appliquer dans l'ordre de leur date, de `2026-09-02_auth_discord.sql` à `2026-09-27_aligner_schema.sql`. Un nouveau service `race` s'ajoute à `docker-compose.yml`, et le limiteur de débit de nginx répond `429` au lieu de `503`. Les anciennes adresses `/admin`, `/admin/gestion` et `/add_tournament` n'existent plus

### Nouvelles fonctionnalités
- **Comptes joueurs avec Discord** : chaque joueur peut désormais se connecter au site avec son compte Discord. L'inscription se fait uniquement sur invitation. Une fois connecté, le joueur demande à relier son compte à sa fiche du classement, ou à en créer une s'il est nouveau ; un administrateur valide la demande. Chaque joueur relié dispose d'un profil public et d'une page « Mon compte ». Les avatars Discord sont servis par le site lui-même, pour que Discord ne voie pas qui consulte le classement. Le site se dote aussi de pages de mentions légales et de politique de confidentialité
- **Données personnelles** : depuis « Mon compte », chacun peut télécharger l'intégralité des données que le site garde sur lui. Les accords donnés à la politique de confidentialité sont historisés, version par version. Un administrateur autorisé peut anonymiser ou supprimer la fiche d'un joueur
- **Notifications** : une cloche dans le menu signale ce qui concerne le compte — demande de liaison acceptée ou refusée, promotion proposée, réponse à une promotion. Un clic sur une notification mène directement à la page concernée
- **Mes sessions** : un titulaire de compte voit la liste des appareils sur lesquels il est connecté et peut fermer à distance une session qu'il ne reconnaît pas
- **Hiérarchie d'administration** : trois niveaux au lieu d'un seul — administrateur, chef administrateur et super-administrateur. Un administrateur ne détient plus que les droits qu'on lui a explicitement accordés, parmi une liste nommée : gestion des joueurs, des tournois, des ligues, de la configuration, données personnelles, etc. Le menu et les pages n'affichent que ce que chacun a le droit d'utiliser. Un administrateur ne peut pas agir sur un pair de même rang. Le super-administrateur est unique et ne peut pas changer son propre rôle : il le lègue à un successeur, en une seule opération. Une promotion n'est plus imposée : elle est proposée, et la personne l'accepte ou la refuse
- **Consultation du journal d'administration** : le journal se consulte désormais depuis le site — un panneau par compte, un onglet « Logs » complet et un export CSV. Un chef administrateur lit le journal de ses pairs, jamais celui du super-administrateur
- **Sessions de tournoi** : les tournois d'une même soirée sont regroupés dans une session déclarée explicitement, au lieu d'être déduits de leur date. Un joueur ne peut participer qu'à un tournoi par session, et la pénalité d'absence compte les sessions manquées plutôt que les jours du calendrier. Un script recompte les absences de tous les joueurs selon cette règle, sans toucher à leur sigma : vingt-huit joueurs avaient un compteur faux, dont certains inactifs depuis des mois et toujours à zéro. Modifier ce compteur à la main est réservé au super-administrateur, puisqu'il détermine la pénalité de sigma
- **Seuils de tiers réglables** : les seuils qui séparent les tiers du classement ne sont plus fixés dans le code. Ils se règlent depuis l'administration, en déplaçant les limites directement sur un graphique de la distribution des joueurs
- **IP v1 et v2 expliquées** : les deux versions de l'Indice de Performance sont nommées et expliquées partout où le site les affiche
- **Décor Mario Kart sur tout le site** : un fond d'objets du jeu — carapaces, champignons, étoiles, bananes, Bob-ombs, éclairs, fleurs de feu — habille désormais toutes les pages, et plus seulement l'accueil
- **Page « introuvable »** : une adresse qui n'existe pas affiche une page aux couleurs du site au lieu de l'erreur brute du serveur
- **Une vraie course dans le bandeau** : la course de l'accueil tournait en boucle, sans départ ni arrivée. Elle se court désormais en cinq tours avec départ arrêté : compte à rebours sous les feux de Lakitu, départ réussi, normal ou raté, classement final puis nouvelle grille dans l'ordre d'arrivée. Les courses s'enchaînent par Grand Prix de quatre, avec un tableau des points entre chaque course et un classement final. Les spectateurs peuvent voter pour relancer le Grand Prix
- **Suivre un kart** : un clic sur une vignette du classement du bandeau fixe la caméra sur ce kart, pour ce spectateur seulement. Le reste du temps, une caméra automatique choisit l'action à montrer. Sur téléphone, le bandeau affiche la même scène que sur ordinateur, réduite, et peut passer en plein écran
- **Nouveaux objets et nouveaux pilotes** : la carapace bleue, l'éclair et Bill balle rejoignent la course, ainsi que Birdo et Daisy. La répartition des objets est entièrement revue : elle dépend de la place du kart, de son retard sur le premier, de l'avancement de la course et de son isolement. Carapace bleue et éclair deviennent plus rares chaque fois que l'un d'eux est lancé
- **Des pilotes plus malins** : un kart tient ses objets en main et choisit quand les lancer, vers l'avant ou vers l'arrière. Il esquive selon le temps qui lui reste avant l'impact, surveille ce qui arrive derrière lui et se souvient d'un kart armé qui le suit. Les carapaces rouges contournent les tuyaux au lieu de s'y briser
- **Plafond de sigma sur le reset global** : le reset de début de saison prend un troisième paramètre, un plafond que personne ne dépassera. Un joueur sous ce plafond y est amené sans le franchir — avec un reset de 0,3 et un plafond de 2, un joueur à 1,8 arrive à 2,0 et non à 2,1 — et un joueur déjà au plafond ou au-dessus n'est pas touché du tout. Auparavant la requête était un `UPDATE` sans clause `WHERE` : tout le monde prenait la même valeur, sans limite haute, y compris les joueurs déjà très incertains que le reset éloignait encore du classement. Le plafond est obligatoire, et le reset est refusé si aucun joueur ne se trouve en dessous plutôt que d'enregistrer une opération sans effet. À ne pas confondre avec le réglage « Limite Sigma » de la même page, qui décide de l'affichage des tiers et ne borne rien : ce sont deux valeurs indépendantes
- **Annulation exacte d'un reset plafonné** : les joueurs ne recevant plus tous la même valeur, une nouvelle table `global_reset_details` retient l'état de chacun avant l'opération. L'annulation restaure ce sigma joueur par joueur, là où une soustraction uniforme ferait redescendre les joueurs écrêtés *sous* leur point de départ — celui qui n'a reçu que 0,2 se verrait retirer 0,3. Les resets antérieurs à ce changement n'ont pas de détail et restent annulés à l'ancienne, sans quoi ils deviendraient irréversibles
- **Bannière synchronisée pour tous les visiteurs** : la course du bandeau d'accueil n'est plus simulée par chaque navigateur mais par un service dédié, `race`, dont tous les spectateurs reçoivent l'état par WebSocket. Deux personnes qui ouvrent le site au même moment voient désormais rigoureusement la même course — mêmes positions, mêmes collisions, même classement. Auparavant chaque onglet avait son propre monde, son propre tirage aléatoire et sa propre horloge : c'étaient autant de courses différentes que de visiteurs
- **Arrivée en cours de course** : un visiteur qui se connecte à la centième seconde reçoit un état complet et affiche immédiatement une scène juste — classement rempli dans le bon ordre, objets tenus avec la bonne image, halo d'étoile allumé, item-boxes déjà consommées masquées, kart percuté figé. Rien à l'écran ne dépend d'un événement qu'il aurait fallu voir passer
- **Rideau de départ** : un damier noir et blanc couvre le bandeau tant que la scène n'est pas prête (images décodées, état reçu, deux snapshots en tampon) puis se lève. Il masque la reconstruction du décor et celle d'une course déjà commencée
- **Indicateur de connexion** : une pastille en haut à droite du bandeau — verte en direct, rouge hors ligne
- **Les karts du bandeau entendent venir le danger** : jusqu'ici un kart ne réagissait qu'à ce qu'il voyait, et ne voyait derrière lui qu'en se retournant. Trois objets se font désormais entendre de ceux qu'ils menacent. Une étoile ou un bill qui arrive fait se retourner les karts devant au bon moment, et ils le suivent du regard jusqu'à avoir décidé leur esquive. La cible d'une carapace rouge sait qu'elle est visée : elle sort son bouclier ou son étoile sans se retourner, et le garde tant que la rouge la vise. Le premier qui entend venir une carapace bleue se protège s'il tient un champignon ou une étoile — le champignon, sorti au moment où elle s'arrête au-dessus de lui, ne réussit qu'environ sept fois sur dix. Sinon, s'il en a le réflexe et qu'un poursuivant est assez près, il lève le pied pour se faire doubler avant qu'elle ne choisisse sa cible. L'alerte dit ce qui arrive, jamais où : le placement se décide toujours sur ce que le kart a vu. Sur 1000 courses, les tête-à-queue baissent de 3 % et le temps passé à regarder derrière augmente de moins d'un point
- **Course à la demande** : la simulation démarre à la première connexion et s'arrête trente secondes après le départ du dernier spectateur. Personne devant l'écran, aucun CPU consommé. Le délai de grâce évite qu'un simple rafraîchissement ne reparte de zéro
- **Suppression de compte sur demande écrite** : le bouton « Supprimer mon compte » n'efface plus rien d'un clic, il indique d'écrire à l'adresse de contact. Un effacement irréversible à la portée de quiconque tenait une session ouverte, sur un appareil partagé ou perdu, était jugé trop dangereux. Le super-administrateur exécute la demande depuis la gestion des comptes, après avoir vérifié qu'elle vient du titulaire et en retapant son identifiant Discord — affiché sous son nom dans la liste des comptes, `@` et majuscules tolérés ; la route d'effacement directe est retirée, pas seulement cachée. Ce qui est effacé et ce qui est conservé ne change pas.
- **Graphiques zoomables** : les neuf graphiques du site — évolution TrueSkill de la fiche joueur, les cinq graphiques d'un récap de saison, la distribution et l'évolution de l'IP du classement, le réglage des tiers de l'administration — se zooment et se parcourent comme une carte. Ctrl + molette (ou pincement du trackpad) zoome jusqu'à ×4 autour du curseur, un glisser déplace la vue dans tous les sens, un double-clic ou le bouton ⟲ ramène la vue complète ; au téléphone, on pince pour zoomer et on glisse d'un doigt une fois zoomé. La molette seule continue de faire défiler la page — un bandeau rappelle le geste — pour qu'une page à graphiques empilés ne reste pas coincée dessus. Le zoom étire le graphique sans le recadrer : traits, textes et bulles d'info gardent leur taille, les points grossissent un peu, et au doigt ils se touchent plus facilement qu'avant, zoomé ou non. Sur les tiers, attraper un seuil le déplace toujours ; c'est un appui ailleurs qui déplace la vue
- **Journal d'administration complet** : la liaison de deux tournois (qui peut corriger le sigma de joueurs), la suppression et la publication d'un récap de saison, et toute modification des tiers laissent désormais une trace dans le journal, avec l'état avant et après. Elles n'en laissaient aucune. Un test d'inventaire empêche désormais qu'une nouvelle action d'administration échappe au journal.
- **Bannière d'automne** : l'accueil a enfin son décor d'automne, au lieu de celui de l'été prêté depuis le 22/09. Une campagne d'automne : un ciel abricot chargé de nuages défile lentement derrière les collines habituelles, entre vert et roux, avec des forêts d'automne au loin sur l'horizon, et au premier plan, à la vitesse de la route, passent des chênes orange, des bouleaux dorés et des érables rouges, avec derrière eux un second rang d'arbres plus petits qui défile un peu moins vite, pour donner de la profondeur, au-dessus d'un pré couvert de feuilles. Les arbres sont dessinés branche par branche, avec du ciel entre les feuilles, une ombre au sol et le grain d'un jeu Super Nintendo. Les images sont dessinées par `scripts/banner-autumn.py` : on retouche le script et on le relance, on ne retouche pas les PNG
- **Page de maintenance** : pendant un déploiement, `make maintenance-on` montre au public une page « Travaux en cours », aux couleurs du site, avec le décor d'objets en fond et Mario bâtisseur qui tape au marteau. Elle se recharge seule chaque minute. Celui qui déploie garde l'accès au vrai site grâce à un lien de passe affiché par la commande, et `make maintenance-off` rouvre le site au public. La même page remplace désormais l'écran « 502 Bad Gateway » quand le site redémarre. **Pour qui déploie** : le limiteur de débit répond maintenant `429` au lieu de `503`, réservé à la maintenance, et le conteneur nginx doit être recréé une fois (`docker compose up -d --force-recreate nginx`). Procédure : `docs/runbook-admin.md` §8

### Corrections
- **Le panneau « dernier tour » de Lakitu ne s'affichait jamais** : il devait sortir quand il restait un tour au premier, mais la course passe en phase d'arrivée deux tours avant la fin, et le panneau n'était guetté qu'avant. Il sort désormais quand le premier approche de la ligne qui ouvre son dernier tour, et reste en main jusqu'à ce que le dernier l'ait passée à son tour : chaque kart entame son dernier tour devant lui, même ralenti juste avant la ligne, et même si un dépassement en queue de peloton change qui ferme la marche. Si le premier prend un tour au dernier, les deux panneaux se chevauchent : Lakitu montre celui du kart que suit la caméra — le drapeau pour le premier, « dernier tour » pour celui qu'il vient de reprendre. Lakitu y flotte comme au départ. Corrigé dans les deux moteurs de course
- **Cases à cocher qui changeaient de couleur au survol** : passer la souris sur le libellé d'une case — celle de la politique de confidentialité sur la page d'invitation, les permissions de la gestion des comptes — passait le texte en gris foncé, presque invisible sur le fond sombre, et le lien qu'il contient changeait à son tour avec un temps de retard. Seul le curseur réagit désormais
- **Page d'invitation plus claire** : elle ne parlait que de retrouver sa fiche dans le classement, alors qu'un nouveau venu peut aussi en créer une. Elle le dit maintenant, et précise qu'un admin valide la demande
- **Bulle vide sur la distribution d'un récap, au téléphone** : toucher un point du graphique affichait une bulle sans nom de joueur ni pourcentage — elle ne se remplissait que depuis la légende. Elle se remplit maintenant dans les deux cas
- **Bill impossible à esquiver dans le bandeau** : les karts le prenaient pour un kart ordinaire, alors qu'il balaie plus du double de largeur. Même ceux qui le voyaient venir et s'écartaient « correctement » restaient dans sa trajectoire : lancé à 900 px derrière eux, il touchait 94 à 100 % des karts, les plus agiles compris. Les karts s'écartent désormais de sa largeur réelle, et mesurent le temps qu'il leur reste jusqu'au contact plutôt que jusqu'au centre — ce qui corrige aussi l'étoile, où ils commençaient leur écart près de 300 ms trop tard. Un kart agile qui le voit venir s'en sort maintenant huit fois sur dix ; un kart lourd reste souvent pris, faute de temps pour traverser la piste
- **Historique de reset sur les fiches joueurs** : la ligne « Reset Global » était affichée sur tous les profils avec la valeur nominale de l'opération, la requête ne consultant que l'en-tête du reset sans jamais regarder le joueur concerné. C'était exact tant que le reset touchait tout le monde à l'identique ; avec le plafond, un joueur épargné voyait une ligne qui ne le concernait pas, et un joueur écrêté un montant qu'il n'avait pas reçu. L'historique lit désormais le détail par joueur et n'affiche que ce qui lui est réellement arrivé
- **Défilement du décor désynchronisé** : la bordure de route tournait sur une animation CSS infinie, dont la phase dépendait du moment où la page avait été chargée. Elle est maintenant positionnée depuis la caméra, comme le reste du décor. Même traitement pour les animations décoratives — rebond des karts, arc-en-ciel de l'étoile, pulsation du soleil — calées sur l'horloge du serveur par un `animation-delay` négatif
- **Constantes de simulation dupliquées** : les valeurs qui décrivent le monde (vitesses, hitboxes, délais, distribution des objets) vivaient dans le même objet que celles qui décrivent son apparence. Elles sont séparées, et le client n'en garde plus aucune copie : le serveur transmet le strict nécessaire à l'affichage lors de la connexion. Un réglage de gameplay ne peut plus changer d'un côté sans l'autre
- **Pages qui tombent en « 503 » ou en « Erreur Backend » après quelques rafraîchissements** : quatre causes indépendantes, dont aucune n'expliquait le symptôme à elle seule. Ouvrir une page d'administration déclenchait jusqu'à neuf allers-retours vers le serveur de données là où quatre suffisent — la session était revalidée sur chaque appel de données et non une fois par page, chaque page refaisait une vérification que le serveur venait de faire, et un menu déroulant interrogeait la base à chaque affichage pour une donnée qu'aucun écran n'utilisait. Le tout sur deux processus qui se bloquaient mutuellement en attendant le réseau. Enfin, la limite de débit était calibrée pour une page à quatre requêtes alors que la plus lourde en vaut six : trois rafraîchissements rapides suffisaient à l'épuiser
- **Classement des joueurs incomplet pour tous les visiteurs** : la page affiche un avatar par ligne, et chaque avatar comptait dans la limite de débit — trente joueurs affichés, c'était trente-et-une requêtes limitées pour une seule page, au-delà du budget autorisé. La page ne pouvait donc pas finir de se charger, sans qu'aucun compte ni aucune connexion ne soit en cause. Les avatars sont désormais traités comme les autres images du site, hors de cette limite
- **Message d'erreur trompeur en cas de débit limité** : quand le serveur refusait une requête pour excès de débit, l'interface affichait « Erreur serveur (Réponse invalide) » — un message qui accuse le serveur d'être en panne alors qu'il se protège, et qui tait la seule chose utile à savoir. Elle indique maintenant combien de temps patienter. Surtout, un refus pour débit ne déconnecte plus : il ne dit rien sur la validité de la session, et fermer la session ferait perdre son travail à quelqu'un qui a simplement cliqué trop vite
- **Changer de rôle ferme les sessions** : la durée d'une session est fixée à la connexion selon le rôle — trente jours pour un joueur, douze heures pour un administrateur. Un joueur promu administrateur gardait donc sa session de trente jours, et un administrateur rétrogradé ses sessions ouvertes. Désormais, tout changement de rôle ferme les sessions du compte concerné sur tous ses appareils. Accepter une promotion, ou léguer le rôle de super-administrateur, relance aussitôt la connexion Discord — sans écran à valider pour qui a déjà autorisé le site — et la page le dit avant le clic. Les droits, eux, suivaient déjà le rôle à chaque requête : c'est la durée qui ne suivait pas
- **Modification du sigma désactivée pour tout le monde** : l'édition du sigma d'un joueur depuis l'administration ne faisait plus rien, sans message d'erreur. Elle fonctionne de nouveau, et le journal nomme le joueur concerné avec ses valeurs de mu et de sigma
- **Droit manquant confondu avec une session expirée** : un administrateur qui ouvrait une page hors de ses droits était déconnecté comme si sa session avait expiré. Il est désormais simplement informé qu'il n'a pas accès à cette page
- **Actions sur les tournois fiabilisées** : les données d'un tournoi sont validées avant d'être enregistrées, deux saisies simultanées ne peuvent plus se mélanger et un double envoi du formulaire est refusé. Une absence compte une fois par session, et non une fois par lobby. Seul le dernier tournoi enregistré peut être annulé, et jamais par-dessus un reset global postérieur. Supprimer un tournoi ou annuler un reset retire les pénalités concernées au lieu de restaurer un ancien sigma. Un reset global daté du jour même ou du futur est refusé
- **Compteur de tours figé dans le bandeau** : il s'arrêtait deux tours avant la fin, ce qui empêchait la carapace bleue et l'éclair de redevenir disponibles
- **Carapaces qui traversaient les tuyaux** du bandeau
- **Cartes de résultats de tournoi trop chargées sur téléphone**, et formulaire de saison mal disposé sur tablette
- **Schéma de base aligné** : une migration ajoute les index manquants et corrige le type des colonnes de tiers, pour qu'une base existante et une base neuve aient exactement la même structure

### Améliorations

#### Bannière
- **Lakitu flotte au départ et au dernier tour** : pendant le compte à rebours et avec le panneau du dernier tour, il monte et descend doucement sur son nuage, au lieu de rester figé. Le mouvement est le même pour tous les spectateurs, et disparaît si le système demande de réduire les animations
- **Place du kart suivi** : en haut à gauche du bandeau, la place du kart que suit la caméra s'affiche comme dans Mario Kart — « 1st » en or, « 2nd » en argent, « 3rd » en bronze, puis en orange jusqu'à « 8th ». À chaque changement de place, l'ancienne s'éclipse en tournant et la nouvelle surgit d'un rebond ; une série de dépassements rapprochés n'enchaîne pas les animations, elle affiche directement la dernière place. Rien ne s'affiche sur la vue d'ensemble, qui ne suit personne
- **Caméra automatique qui tient** : la réalisation automatique revient à chaque nouvelle course, même si l'on suivait un kart à la précédente — on retrouvait jusqu'ici la vue fixe, à devoir recliquer. Le bouton caméra ne la coupe plus : il la remet, et ne fait rien si elle tourne déjà. Seul un clic sur un kart la suspend, le temps de la course
- **Pause et vitesse réservées au mode debug** : ce sont des outils de réglage, pas de spectateur. Le cartouche du kart suivi garde son numéro de tour. Sans la pause, le bouton de vote se range contre la caméra
- **Page d'accueil allégée** : `physics.js` et `physics-config.js` ne sont plus chargés par le navigateur, soit environ 1 800 lignes de JavaScript en moins. Le client ne fait plus que du rendu
- **Le rendu se déduit de l'état, plus des événements** : à chaque image, le DOM est réconcilié avec l'état reçu — ce qui manque est créé, ce qui ne correspond plus à rien est supprimé. C'est ce qui rend affichable une course déjà commencée, et ce qui évite qu'une reconnexion ne laisse des éléments fantômes
- **Interpolation par chemin le plus court** : le monde boucle à 3840 unités, interpoler naïvement entre les deux bords faisait traverser toute la carte à l'envers à chaque tour
- **Horloge calée sur le serveur** par ping/pong, en retenant la meilleure mesure plutôt que la moyenne, et rattrapée progressivement — l'appliquer d'un coup faisait sauter la scène à chaque recalage, ce qui se voyait sur mobile où l'aller-retour est irrégulier
- **Mode dégradé** : si le service est injoignable, le décor continue de défiler sans course, pastille rouge, et la connexion est retentée en backoff exponentiel. Le navigateur ne simule jamais de course de substitution — il n'y a qu'une course, celle du serveur
- **Karts rééquilibrés** : les caractéristiques de chaque kart (vitesse, accélération, maniabilité, poids) découlent d'un budget de points commun et sont calées sur Mario Kart 8 Deluxe. Les chocs entre karts suivent un modèle physique d'impulsions, le bord de piste freine au lieu de bloquer, et la durée d'un tête-à-queue dépend de ce qui l'a provoqué. La piste est deux fois plus longue
- **Moteur de course en C++** *(expérimental, désactivé par défaut)* : une seconde implémentation du moteur, dans `raceEngineCpp/`, parle le même protocole que le moteur JavaScript. Le Makefile permet de basculer de l'un à l'autre ; le moteur JavaScript reste celui utilisé en production
- **Onglet en arrière-plan** : le client demande au serveur de couper son flux, et redemande un état complet au retour. La course continue sans lui, il n'y a plus rien à « reprendre » — l'overlay PAUSE disparaît

#### Bande passante
- **1,3 Ko/s par spectateur**, soit environ 5 Mo/h. Trois décisions y concourent : diffusion à 10 Hz pour une simulation à 30 Hz, compression `permessage-deflate` en conservant le contexte entre messages (76 % de gain mesuré sur des snapshots aussi répétitifs), et suppression des événements de classement qui étaient émis pour les huit karts toutes les 500 ms même quand personne ne changeait de place

#### Infrastructure
- **Service `race`** : Node 22 sans dépendance transitive, utilisateur non-root, limité à 0,25 CPU et 128 Mo, sur le réseau `frontend` uniquement — jamais près de la base. `physics.js` et `physics-config.js` y sont montés depuis `frontEnd/static/js` : une seule version de ces fichiers existe, la simulation ne peut donc pas dériver de ce qui est affiché
- **nginx** : bloc `/ws/` avec relais de l'upgrade WebSocket, timeouts à une heure (sans quoi la connexion serait coupée au bout de 60 s d'inactivité) et `limit_conn` — les limites de débit existantes comptent des requêtes, ce qui ne veut rien dire pour une connexion qui dure des heures
- **Boucle à pas fixe** avec plafond de rattrapage : sans lui, une pause du ramasse-miettes déclenche une spirale où chaque tick rejoue le retard accumulé
- **Surveillance** : le moteur détecte les `NaN` et les karts immobiles, et rend un bilan (pas simulés, objets en vol, mémoire) exploitable en soak. Cibles `make race-soak`, `make race-spectate`, `make race-nginx`, `make re-race` et `make logs-race`
- **`WS_ALLOWED_ORIGINS`** *(optionnel, à renseigner en production)* : liste blanche des origines autorisées à ouvrir le flux. Vide, toutes sont acceptées
- **Processus web en mode threadé** : le site et son serveur de données passent de deux processus bloquants à deux processus de huit et quatre fils d'exécution. Ces services ne calculent presque rien — ils attendent le réseau ou la base — et un processus bloqué sur une attente n'est pas un processus occupé : il ne sert personne. Deux requêtes lentes simultanées suffisaient à faire paraître le site mort. En conséquence directe, le réservoir de connexions à la base passe en variante thread-safe et le cache mémoire reçoit un verrou : sans cela, deux fils d'exécution pouvaient se voir attribuer la même connexion, ou vider un cache que l'autre venait déjà de purger
- **Limite de débit recalibrée sur une mesure** : `8 r/s` avec une réserve de `40` pour la zone d'administration, après avoir compté requête par requête ce que coûte réellement l'ouverture de chaque page (4 pour les fiches joueurs, 5 pour les comptes, 6 pour les réglages). Les trois réglages précédents avaient été posés à l'estime, faute de ce chiffre — et desserrés **après** avoir corrigé la consommation applicative, jamais avant, sous peine de masquer le défaut au lieu de le traiter
- **Page de refus explicite** : un refus pour excès de débit renvoie désormais une page lisible, avec le code `429`, portant un en-tête `Retry-After`, au lieu de l'erreur brute du serveur qui laissait croire à une panne et invitait à rafraîchir — ce qui ne faisait qu'aggraver la situation

#### Connexion et administration
- **Écran d'autorisation Discord à chaque connexion** : jusqu'ici, qui avait déjà autorisé le site était renvoyé aussitôt par Discord, sans pouvoir lire sa page ni voir avec quel compte il entrait. L'écran s'affiche désormais à chaque fois, avec son « Ce n'est pas vous ? » — utile avec plusieurs comptes Discord ou sur un ordinateur partagé. Un clic de plus par connexion, y compris lors de la reconnexion qui suit une promotion
- **Identifiant Discord visible dans la gestion des comptes** : la liste affiche sous chaque nom l'identifiant Discord (`@toto`), que le legs du rôle de super-administrateur et la suppression d'un compte font retaper. Il ne figurait nulle part : retaper le nom affiché échouait sans explication. La saisie tolère désormais le `@`, les espaces autour et les majuscules
- **Plusieurs adresses de retour Discord** *(pour qui déploie)* : `DISCORD_REDIRECT_URI` accepte une liste séparée par des virgules, et chaque connexion revient sur l'adresse par laquelle on consulte le site. Avec une seule adresse, ouvrir le site sous un autre nom de la même machine (`localhost`, nom `.local`, nouvelle IP attribuée par la box) faisait échouer la connexion en « demande expirée ». Une valeur unique fonctionne comme avant. Chaque adresse doit être déclarée dans le portail développeur Discord ; une adresse absente de la liste est refusée par le serveur de données
- **Menus repensés** : la cloche de notifications et le menu du compte restent visibles à côté du menu burger sur téléphone, et le bouton de connexion Discord devient une pastille avec libellé. Les actions sur un compte sont regroupées dans un menu contextuel. Les pages d'administration s'affichent mieux sur téléphone et leurs tableaux se trient par colonne
- **Durcissement de la sécurité** : les corrections de l'audit du 24/09 sont appliquées — contrôles de hiérarchie des rôles, protection contre l'injection de script, validation des profils, nombre d'invitations limité, déconnexion en `POST`. Les bibliothèques du site sont hébergées par le site lui-même et une politique de sécurité du contenu (CSP) n'autorise plus que ses propres ressources ; le widget Discord passe par un relais
- **Journaux gérés par journald**, pour qu'ils expirent automatiquement au bout de la durée de conservation annoncée dans les mentions légales
- **Politique de confidentialité à accepter pour utiliser son compte** : l'accord était demandé par un bandeau sur « Mon compte », qu'on pouvait ignorer indéfiniment — tout le reste du site restait ouvert. Désormais, un compte connecté qui n'a pas accepté la version en vigueur arrive sur une page dédiée à chaque page ouverte, et le serveur de données refuse ses autres demandes. Trois issues sur cette page : accepter (on revient alors sur la page demandée), télécharger ses données, ou se déconnecter — la suppression du compte se demande par mail, comme ailleurs. Les comptes créés par invitation l'avaient déjà acceptée en cochant la case ; sont concernés les comptes plus anciens, le premier super-administrateur, et tout le monde le jour où la politique change de version. Le classement reste consultable sans compte

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
