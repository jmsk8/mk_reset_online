🏁 Mario Kart Reset Online

Mario Kart Reset Online est une application web compétitive conçue pour suivre, classer et analyser les performances des joueurs lors de tournois Mario Kart.

Elle se distingue par l'utilisation de l'algorithme TrueSkill™ pour un classement équitable, une interface Dark Mode "Glassmorphism" moderne, et un panel d'administration sécurisé.
📸 Aperçu
Classement	Statistiques Joueur	Admin Panel
		
🚀 Fonctionnalités
👤 Côté Utilisateur

    🏆 Classement TrueSkill : Système de rang (S, A, B, C) basé sur le Mu et Sigma (incertitude) de chaque joueur.

    📊 Statistiques Avancées : Graphiques interactifs montrant l'évolution du niveau, ratio victoires/défaites, et historique complet.

    🎨 Interface Immersive : Design sombre avec effets de transparence (Glassmorphism) et animations fluides.

    📱 Responsive : Accessible sur mobile et desktop.

🛡️ Côté Administrateur

    🔐 Authentification Forte : Système de login sécurisé par hashage (Bcrypt) et tokens de session dynamiques.

    📝 Gestion des Tournois : Ajout rapide de tournois avec recherche dynamique de joueurs et calcul immédiat des nouveaux scores.

    undo Annulation (Revert) : Possibilité d'annuler le dernier tournoi en cas d'erreur (restauration des scores précédents).

    💾 Backups Automatiques : Sauvegarde de la base de données à chaque modification critique via script shell.

🛠️ Stack Technique

    Frontend : Python (Flask, Jinja2), Bulma CSS, Chart.js, Vanilla JS.

    Backend : Python (Flask), Algorithme TrueSkill, Bcrypt.

    Base de données : PostgreSQL.

    Infra : Docker, Docker Compose, Nginx (Reverse Proxy).

⚙️ Installation et Démarrage
1. Cloner le projet
Bash

git@github.com:jmsk8/mk_reset_online.git
cd mk_reset_online

2. Configuration (.env)

Créez un fichier .env à la racine basé sur le modèle ci-dessous.

Note : Le mot de passe admin doit être hashé.
Bash

# Configuration PostgreSQL
POSTGRES_USER=mon_user
POSTGRES_PASSWORD=mon_password
POSTGRES_DB=tournament_db
POSTGRES_HOST=db

# Configuration Sécurité Flask
SECRET_KEY=une_chaine_aleatoire_tres_longue

# Configuration Admin
# Générez le hash via le script python ci-dessous
ADMIN_PASSWORD_HASH=$$2b$$12$$ExempleDeHashBcrypt...

    Astuce : Pour générer le hash de votre mot de passe admin, lancez cette commande Python :
    Python

    python3 -c "import bcrypt; print(bcrypt.hashpw(b'VOTRE_MOT_DE_PASSE', bcrypt.gensalt()).decode())"

3. Lancement avec Docker

L'application est entièrement conteneurisée. Assurez-vous que Docker est lancé.
Bash

# Construire et lancer les conteneurs (en arrière-plan)
docker-compose up --build -d

L'application sera accessible sur : http://localhost
4. Commandes Utiles

Arrêter l'application :
Bash

docker-compose down

Gérer les sauvegardes (Backup/Restore) : Le projet inclut un script backup.sh à la racine.
Bash

# Créer une sauvegarde manuelle
./backup.sh save

# Restaurer une sauvegarde (ex: 2025-01-02)
./backup.sh restore 2025-01-02

📂 Architecture

mk_reset_online/
├── backEnd/             # API Flask, Logique TrueSkill
│   ├── backend.py
│   ├── schema.sql       # Structure DB
│   └── ...
├── frontEnd/            # Serveur Web & UI
│   ├── templates/       # HTML (Jinja2)
│   ├── static/          # CSS, JS, Images
│   └── frontend.py
├── backups/             # Dossier de stockage des dumps SQL
├── nginx.conf           # Configuration du Reverse Proxy
├── docker-compose.yml   # Orchestration
└── backup.sh            # Script de maintenance
