# 🏁 Mario Kart Reset Online `v1.0.0`

> **La plateforme de compétition ultime pour Mario Kart, pilotée par la science du classement.**

Mario Kart Reset Online est une application web de gestion de tournois conçue pour offrir un suivi rigoureux et une analyse profonde des performances. Elle se distingue par l'utilisation de l'algorithme **TrueSkill™** pour garantir un classement équitable, même avec des effectifs de joueurs variables.

---

## 🌟 Points Forts du Projet

### 📈 Intelligence du Classement
Contrairement aux systèmes ELO classiques, notre moteur calcule deux variables pour chaque joueur afin de définir son niveau réel :
* **$\mu$ (Mu) :** La performance moyenne estimée.
* **$\sigma$ (Sigma) :** L'indice d'incertitude du système (plus tu joues, plus le système est sûr de ton niveau).
* **Score Final :** Ton rang est calculé selon la formule $$R = \mu - 3\sigma$$ garantissant une progression basée sur la régularité et la preuve de niveau.

### 🎨 Expérience Utilisateur (UX)
* **Design Glassmorphism :** Interface moderne avec effets de transparence, flous directionnels et animations fluides.
* **Bannière Rétro SNES :** Un script JavaScript personnalisé simulant une course interactive de *Super Mario Kart* en haut de page.
* **Ergonomie des Awards :** Descriptions interactives des trophées et des distinctions de saison (Stakhanov, Stonks, etc.).

### 🛠️ Robustesse & DevOps
* **Déploiement Isomorphe :** Utilisation de **Nix Flakes** pour garantir que l'environnement de développement est identique au serveur de production.
* **Gestion des "Ghosts" :** Système automatique de pénalité d'incertitude ($\sigma$) pour les joueurs absents, évitant que les classements ne stagnent.

---

## 🚀 Fonctionnalités

### 👤 Interface Joueurs
* **Système de Tiers :** Répartition automatique en classes (S, A, B, C, U) basée sur la distribution statistique (moyenne et écart-type) de la population active.
* **Profils Personnalisés :** Graphiques de progression temporelle via **Chart.js**, historique des tournois et vitrine de trophées.
* **Recaps de Saisons :** Archivage complet des saisons passées avec podiums et statistiques globales.

### 🛡️ Panneau d'Administration
* **Saisie Optimisée :** Ajout rapide de tournois (jusqu'à 12 joueurs) avec recherche prédictive.
* **Contrôle Total :** Annulation du dernier tournoi (Revert), modification manuelle des profils, et reset global du Sigma pour les nouvelles saisons.
* **Sécurité :** Authentification Bcrypt, protection contre les failles CSRF et gestion de sessions sécurisées.

---

## 🛠️ Stack Technique

| Composant | Technologie |
| :--- | :--- |
| **Frontend** | Python (Flask), Jinja2, Bulma CSS, Vanilla JS |
| **Backend** | Python 3.10+, API RESTful, TrueSkill Engine |
| **Base de données** | PostgreSQL 13 (Relationnel) |
| **Infra** | Docker, Docker Compose, Nginx (Reverse Proxy) |
| **DevOps** | Nix (Flakes), Gunicorn, Shell Scripting |

---

## ⚙️ Installation et Démarrage

### 1. Cloner le projet
```bash
git clone [https://github.com/votre-compte/mk_reset_online.git](https://github.com/votre-compte/mk_reset_online.git)
cd mk_reset_online

---

## Configuration .env

