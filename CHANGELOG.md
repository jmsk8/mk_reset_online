# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

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

*Ce changelog couvre les versions 1.0.0 à 1.2.0 (du 11 décembre 2025 au 26 janvier 2026).*
