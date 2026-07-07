# 🏁 Mario Kart Reset Online `v1.4.2`

> Plateforme de compétition Mario Kart avec classement basé sur l'algorithme TrueSkill.

Mario Kart Reset Online est une application web de gestion de tournois et de classement de joueurs. Elle utilise l'algorithme **TrueSkill** pour fournir un classement équitable et dynamique, indépendamment du nombre de participants par tournoi. Le site propose un suivi complet des performances individuelles, un système de ligues, de saisons, ainsi qu'un panneau d'administration complet.

---

## 🎮 Fonctionnalites

### 📈 Classement et Tiers

Les joueurs sont classés via le moteur TrueSkill qui attribue à chacun un score calculé à partir de deux variables : la performance estimée (mu) et l'incertitude (sigma). Le score final est `R = mu - 3 * sigma`. Les joueurs sont automatiquement répartis en tiers (S, A, B, C, U) selon la distribution statistique de la population active. Les seuils de chaque tier (S ≥ mean+σ, A ≥ mean, B ≥ mean−σ) sont affichés directement sur la page de classement.

Un mécanisme de **ghost** pénalise automatiquement le sigma des joueurs absents pour éviter la stagnation du classement.

### 👤 Profils joueurs

Chaque joueur dispose d'une page de statistiques personnelle avec :
- Graphique de progression TrueSkill dans le temps
- Historique complet des tournois et résultats, avec le gain/perte TrueSkill par match (colonne +/-)
- Vitrine des awards et trophées obtenus
- Palmarès des podiums (or, argent, bronze), détaillé par ligue en mode ligue
- Statistiques et palmarès cliquables pour afficher le détail ligue par ligue (matchs, podiums, position et score moyens)
- Tier actuel et score détaillé

### 🏆 Tournois

- Saisie rapide de tournois jusqu'à 12 joueurs avec auto-complétion
- Historique consultable avec détail de chaque tournoi (positions, scores, variations TrueSkill)
- Possibilité d'annuler les derniers tournois enregistrés
- **Mode Mixte** : tournois jouables entre toutes les ligues sans restriction (en mode ligue)

### ⚔️ Ligues et saisons

- Organisation des tournois par saisons et par ligues
- Système de promotion/relégation entre ligues
- Reset global du sigma en début de saison
- Suivi du classement IP de la saison en cours via l'onglet « Saison » de la page de classement
- Recap de fin de saison avec podiums, statistiques globales et awards
- Graphiques d'évolution de l'Indice de Performance et des positions au fil des tournois, accompagnés d'un tableau récapitulant la répartition des positions de chaque joueur
- Awards calculés indépendamment par ligue en mode récap ligue
- Mode hybride : un récap classique peut inclure les stats et mouvements de ligue dans des onglets dédiés

### 🗿 Systeme d'awards

Chaque saison attribue des distinctions aux joueurs :
- **Moai d'Or / Argent / Bronze** : podium de la saison
- **EZ** : plus grand nombre de 1eres places
- **Pas Loin** : plus grand nombre de 2emes places
- **Stonks / Not Stonks** : meilleure progression / plus grosse chute TrueSkill
- **Stakhanoviste** : plus grand nombre de points cumulés
- **Chill Guy** : score TrueSkill le plus stable
- **Instable** : résultats les plus irréguliers d'un tournoi à l'autre

### 🎨 Interface

- Design glassmorphism avec mode sombre
- Bannière interactive simulant une course Super Mario Kart (8 personnages, items, thème correspondant à la saison actuelle)
- Interface responsive adaptée au mobile
- Navigation par saison et par ligue
- Dates affichées au format français (JJ/MM/AAAA)

### 🛡️ Administration

- Création, modification et suppression de joueurs
- Création et configuration des saisons avec attribution des awards
- Ajout rapide de tournois jusqu'à 12 joueurs avec recherche prédictive
- Annulation du dernier tournoi enregistré (revert)
- Mise en place des ligues avec simulation de draft
- Reset global du sigma pour les nouvelles saisons (avec possibilité de revert)
- Configuration du moteur TrueSkill (tau, seuil sigma, activation du ghost)
- Matchmaking : répartition des joueurs présents en lobbies équilibrés par niveau TrueSkill (10 joueurs max par lobby)



---

## 🛠️ Stack technique

| Composant | Technologie |
| :--- | :--- |
| **Frontend** | Python (Flask), Jinja2, Bulma CSS, Vanilla JS |
| **Backend** | Python 3.9+, API RESTful |
| **Moteur de classement** | TrueSkill, NumPy |
| **Base de données** | PostgreSQL 17 |
| **Serveur** | Gunicorn, Nginx (reverse proxy) |
| **Déploiement** | Docker, Docker Compose, Nix Flakes |

### 🏗️ Architecture

Le projet suit une architecture frontend/backend découplée, orchestrée via Docker Compose :

```
nginx (port 80) -> frontend Flask (port 5000) -> backend API (port 8080) -> PostgreSQL
```

- **Backend** : API REST qui gère toute la logique métier (TrueSkill, awards, ligues, administration). Point d'entrée `backEnd/backend.py`, logique répartie en modules dédiés (`routes_public.py`, `routes_admin.py`, `services.py`).
- **Frontend** : Serveur Flask qui consomme l'API backend et rend les templates Jinja2. Code principal dans `frontEnd/frontend.py`.
- **Nginx** : Reverse proxy qui route les requêtes vers le frontend.
- **PostgreSQL** : Base relationnelle initialisée via `schema.sql` et `seed.sql`.

### 📁 Structure du projet

```
mk_reset_online/
├── backEnd/           # API REST (Flask, TrueSkill, logique métier)
├── frontEnd/
│   ├── templates/     # Templates Jinja2 (16 pages)
│   └── static/        # CSS, JS, images, sprites
├── nginx/             # Configuration Nginx
├── nix/               # Environnement Nix Flakes
└── docker-compose.yml
```

### 🔐 Variables d'environnement

Le fichier `.env` doit contenir :

```
POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_DB=...
SECRET_KEY=...
ADMIN_PASSWORD_HASH=...    # Hash Bcrypt du mot de passe admin
```

### 🚀 Lancement

Le projet peut être lancé de deux façons :

**Docker Compose** (production) :
```bash
docker compose up --build
```

**Nix Flakes** (développement) :
```bash
nix develop
backend_start   # lance le backend
frontend_start  # lance le frontend
```

Nix Flakes garantit un environnement de développement identique à la production.

Le site est accessible sur `http://localhost`.
