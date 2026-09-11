# Réorganisation des onglets d'administration — conception

> Document de travail, même esprit que [hierarchie-admin-plan.md](hierarchie-admin-plan.md) :
> pouvoir implémenter plus tard sans refaire l'analyse. Écrit après lecture de `frontend.py`,
> `navbar.html`, `gestion_joueurs.html`, `admin_comptes.html`, `routes_admin.py` et
> `routes_public.py`.
>
> Conventions : **[DÉCIDÉ]** = tranché par l'utilisateur · **[À TRANCHER]** = arbitrage attendu.
>
> **Rien n'est codé.** Suite directe de `hierarchie-admin-plan.md`, dont les 5 phases sont livrées.

---

## 1. Pourquoi

La hiérarchie à 4 rôles est en place, mais l'organisation des pages date d'avant : elle ignore
le découpage en permissions. Le défaut le plus net est dans `gestion_joueurs.html`, qui empile
**trois niveaux de droits différents** sur une seule page :

| Bloc de la page « Gestion TrueSkill » | Droit réellement requis |
|---|---|
| Configuration Globale (tau, seuils, mode fantôme, mode ligue, version d'IP) | `gestion_config` |
| Reset Global du Sigma | `chef_admin`+ (capacité, non délégable) |
| Ajouter un joueur · Liste des joueurs | `gestion_joueurs` |

Conséquence concrète : un admin qui n'a que `gestion_joueurs` **voit le formulaire de
Configuration Globale, peut le remplir, et reçoit un 403 en enregistrant**. Ni caché, ni
fonctionnel — le pire des deux.

Symétriquement, accorder `gestion_config` seul ne sert quasiment à rien : le formulaire n'est
atteignable que par une page intitulée « Gestion TrueSkill », dont le nom ne parle pas de réglages.

**L'objectif : un onglet = une permission**, autant que possible, pour que déléguer un droit
revienne à ouvrir un onglet, et rien d'autre.

---

## 2. Organisation cible **[DÉCIDÉ]**

Sept entrées dans le menu Admin, dans cet ordre :

| # | Onglet | Contenu | Droit requis |
|---|---|---|---|
| 1 | **Gestion tournois** | Ajouter un tournoi · Annuler le dernier · Liste des tournois enregistrés | `gestion_joueurs` |
| 2 | **Réglages TrueSkill** | Configuration globale (tau, seuils, version d'IP) · Mode fantôme · Reset global | `gestion_config`, + `chef_admin` pour le reset |
| 3 | **Fiches joueurs** | Ajouter · Liste · Éditer · Anonymiser | `gestion_joueurs` |
| 4 | Gestion ligues | inchangé | `gestion_ligues` |
| 5 | Gestion saisons | inchangé | `gestion_saisons` |
| 6 | Gestion comptes | inchangé (ses 4 sous-onglets) | `gestion_comptes` / `gestion_liaisons` / `gestion_invitations` |
| 7 | Matchmaking | inchangé | `gestion_matchmaking` |

### 2.1 Structure technique **[DÉCIDÉ]** : des pages, pas des onglets JavaScript

Chaque entrée reste **une page avec sa propre URL** (`/admin/tournois`, `/admin/reglages`, …).
Le mot « onglet » désigne ici une entrée du menu Admin, pas un onglet JS.

*Pourquoi* : une seule page à 7 onglets imposerait de refondre 4 templates existants qui
fonctionnent, et de tout charger d'un coup. Les pages séparées gardent chaque écran indépendant,
ne chargent que leurs propres données, et rendent le gate d'accès trivial (une permission par
route frontend).

`admin_comptes.html` garde ses sous-onglets internes : ils regroupent trois permissions autour
d'un même sujet (les comptes humains), ce qui reste cohérent.

---

## 3. Ce qui bouge, fichier par fichier

### 3.1 Onglet 1 — Gestion tournois *(nouveau)*

**[DÉCIDÉ]** L'onglet **absorbe** le formulaire : c'est `add_tournament.html` qui devient la page
« Gestion tournois », enrichie de deux blocs. On ne crée pas de nouveau template.

*Pourquoi absorber plutôt que réécrire* : ce fichier fait 386 lignes et porte un formulaire non
trivial (recherche de joueurs, ajout à la volée, sélection de ligue, table de participants,
soumission). Le recopier ailleurs, c'est risquer d'en casser une partie sans rien y gagner.

Trois blocs, dans cet ordre :

1. **Enregistrer un tournoi** — l'existant, inchangé. Seul le titre de la page devient
   « Gestion tournois », le bloc gardant son propre intitulé.
2. **Annuler le dernier tournoi** — déplacé depuis `navbar.html` (bouton ligne 258, fonction JS
   `revertLastTournament` lignes 551-560). C'est aujourd'hui un bouton global de navbar, donc
   présent sur *toutes* les pages admin alors qu'il n'a de sens qu'ici. Gate :
   `role_admin in ('chef_admin', 'superadmin')` — capacité de rôle, pas une permission.
3. **Liste des tournois enregistrés** — la donnée existe déjà : `GET /stats/tournois`
   (routes_public.py:1333) renvoie id, date, nombre de joueurs, ligue et vainqueur. Rien à
   écrire côté backend, seulement à consommer.

**Conséquences à ne pas oublier :**

- La route reste **`/admin/tournois`** en cible, mais `add_tournament()` (frontend.py:1152) sert
  aujourd'hui `/add_tournament` en GET **et** POST, et trois `redirect(url_for('add_tournament'))`
  y renvoient (lignes 1130, 1178, 1183). Renommer la route impose de reprendre ces trois renvois,
  sinon un enregistrement réussi redirige vers une URL morte.
- L'entrée de menu « Enregistrer un Tournoi » devient « Gestion tournois ».
- `add_tournament.html` porte déjà le correctif B.5 (403 `permission_manquante` qui ne déconnecte
  plus) : ne pas le perdre en réorganisant le fichier.

### 3.2 Onglet 2 — Réglages TrueSkill *(nouveau)*

**Nouveau** : `frontEnd/templates/admin_reglages.html` + route `/admin/reglages`.

Reçoit, **extraits de `gestion_joueurs.html`** :

- la carte « Configuration Globale » (lignes ~40-140) ;
- le fragment `partiels/reset_global.html`, déjà isolé lors de la Phase 0 du chantier précédent.

⚠️ **Cette page porte deux niveaux de droits, et c'est assumé** — mais elle ne doit pas
reproduire le défaut du §1. Deux exigences :

- l'accès à la page est gaté par `peut('gestion_config') or role_admin in ('chef_admin',
  'superadmin')` ;
- **chaque bloc porte son propre gate à l'intérieur** : la config sous `peut('gestion_config')`,
  le reset sous `role_admin in ('chef_admin', 'superadmin')`. Un admin `gestion_config` ne doit
  pas voir le reset, et réciproquement.

C'est la différence avec la situation actuelle : aujourd'hui les blocs cohabitent **sans** gate.

### 3.3 Onglet 3 — Fiches joueurs

`gestion_joueurs.html` **perd** la Configuration Globale et le Reset Global, et ne garde que
l'ajout et la liste des joueurs. Renommage de l'entrée de menu : « Gestion TrueSkill » →
« Fiches joueurs », le nom actuel désignant surtout ce qui en part.

La route frontend `/admin/gestion` peut rester telle quelle (pas de rupture de lien) ou devenir
`/admin/joueurs` — cf. §5, point B.

### 3.4 Onglets 4 à 7

Inchangés dans leur contenu. Seul l'ordre du menu change.

---

## 4. Suppression de tournoi — **hors périmètre [DÉCIDÉ]**

L'onglet 1 n'expose **que** « Annuler le dernier tournoi » (`revert_last_tournament`), qui
restaure correctement `mu/sigma` depuis `old_mu/old_sigma`.

`DELETE /delete-tournament/<id>` **reste non exposée**. Raison, documentée en R-37 de
`auth-discord-plan.md` et vérifiée à nouveau : cette route **ne restaure pas** `mu/sigma`
contrairement à `revert_last_tournament`. Elle est aujourd'hui inoffensive parce qu'aucun proxy
frontend ne la rend joignable depuis internet.

**Lui ajouter un proxy sans corriger la fonction mettrait en service un outil qui corrompt
silencieusement les classements.** La réparer est un vrai chantier backend (restaurer les notes de
chaque participant, recalculer les tiers, invalider le cache), écarté pour l'instant.

> À faire le jour où quelqu'un s'y attaque : corriger `delete_tournament` **avant** d'ajouter le
> proxy, jamais l'inverse. Le décorateur cible est déjà fixé (`@role_required(ROLE_CHEF_ADMIN)`,
> annexe A de `hierarchie-admin-plan.md`) et un commentaire en ce sens est déjà posé au-dessus de
> la route.

---

## 5. Questions ouvertes

- ~~**A. `add_tournament.html`.**~~ **[DÉCIDÉ]** L'onglet 1 absorbe le formulaire : c'est cette
  page qui devient « Gestion tournois » (§3.1), pas un nouveau template.
- ~~**B. URL.**~~ **[DÉCIDÉ, fait]** Renommage effectué :
  `/add_tournament` → **`/admin/tournois`** (endpoint `admin_tournois`) et
  `/admin/gestion` → **`/admin/joueurs-fiches`** (endpoint `admin_joueurs_fiches`).
  Les trois `redirect(url_for('add_tournament'))` ont suivi, dont celui d'après-connexion
  (frontend.py:1130), et les deux liens de `navbar.html`.

  > ⚠️ `/admin/joueurs` était déjà pris par le **proxy JSON** des fiches joueurs — d'où le
  > suffixe `-fiches` pour la page. Les deux coexistent sans conflit, mais ne pas « simplifier »
  > l'un en l'autre plus tard.
- **C. Ordre du menu.** L'ordre demandé place « Gestion tournois » en premier et « Matchmaking »
  en dernier. À confirmer une fois vu en place.
- **D. Entrée « Annuler le dernier tournoi » dans la navbar.** Une fois déplacée dans l'onglet 1,
  faut-il la retirer complètement du menu, ou en garder un raccourci ? Proposition : la retirer —
  un geste destructeur accessible depuis toutes les pages est une invitation au clic accidentel.

---

## 6bis. Avancement

- ✅ **Renommage des URL** (2026-09-10) — `/add_tournament` → `/admin/tournois`,
  `/admin/gestion` → `/admin/joueurs-fiches`, avec les 3 `redirect` et les liens de menu.
- ✅ **Onglet 2 — Réglages TrueSkill** (2026-09-10) — `admin_reglages.html` + route
  `/admin/reglages`. La Configuration Globale et le Reset Global ont quitté
  `gestion_joueurs.html`, **chacun sous son propre gate** : `peut('gestion_config')` pour la
  config, `role_admin in ('chef_admin','superadmin')` pour le reset. Le défaut du §1 est corrigé —
  un admin `gestion_config` seul voit désormais une page utilisable, et un admin `gestion_joueurs`
  ne voit plus un formulaire qu'il ne peut pas enregistrer.
  > Correctif nécessaire en cours de route : `loadConfig()` (gestion.js) appelait
  > `document.getElementById('configTau').value` **sans vérifier l'existence de l'élément**. Le
  > script servant les deux pages, la page Fiches joueurs aurait levé une `TypeError` qui
  > interrompait tout le reste. La fonction sort maintenant tôt si le formulaire est absent.
- ✅ **Onglet 3 — Fiches joueurs** (2026-09-10) — ce qui reste de `gestion_joueurs.html`, titre
  et entrée de menu renommés.
- ✅ **Menu réordonné** (2026-09-10) — les 7 entrées dans l'ordre demandé.
- ✅ **Onglet 1 — Gestion tournois** (2026-09-10) — `add_tournament.html` absorbe deux blocs :
  « Annuler le dernier tournoi » (déplacé depuis `navbar.html`, bouton **et** fonction JS, tous
  deux sous `role_admin in ('chef_admin','superadmin')`) et la liste des tournois enregistrés.
  Titre et entrée de menu renommés.
  > `/stats/tournois` sert un **template HTML**, pas du JSON : impossible à consommer en `fetch`.
  > La liste est donc rendue côté serveur, la route `admin_tournois` la chargeant à côté des
  > joueurs — plutôt que d'ajouter un proxy JSON pour une donnée déjà publique.

**Les 7 onglets sont livrés.** Restent les points ouverts du §5 (C et D), tranchés de fait :
l'ordre demandé est en place, et le bouton d'annulation a bien été retiré de la navbar.

---

## 6. Ordre de livraison proposé

1. **Onglet 2 (Réglages)** en premier : c'est lui qui résout le défaut du §1. Extraire la config
   et le reset de `gestion_joueurs.html` vers la nouvelle page, avec leurs gates respectifs.
2. **Onglet 3** : ce qui reste de `gestion_joueurs.html`, renommé.
3. **Onglet 1 (Tournois)** : nouvelle page, déplacement du bouton d'annulation depuis la navbar,
   liste alimentée par `/stats/tournois`.
4. **Menu** : réordonner les 7 entrées, retirer le bouton d'annulation global.

Les étapes 1 et 2 sont indissociables (elles touchent le même fichier). L'étape 3 est
indépendante et peut attendre.
