# Permissions et onglets d'administration — contexte de reprise

> **À lire en premier dans une nouvelle session.** Ce document résume ce qui a été construit,
> pourquoi, et ce qui reste à faire sur la question : *« quelles permissions accorder à un admin
> pour chacun des nouveaux onglets ? »*
>
> Date de rédaction : 2026-09-10. Rien n'est commité — l'utilisateur fait ses commits lui-même.
>
> Documents liés, à lire dans cet ordre si besoin de détail :
> 1. [hierarchie-admin-plan.md](hierarchie-admin-plan.md) — le modèle de rôles et permissions
>    (conception complète + registre des risques R-46 à R-60). **Les 5 phases sont livrées.**
> 2. [onglets-admin-plan.md](onglets-admin-plan.md) — la réorganisation des 7 onglets.
>    **Livrée.**
> 3. [auth-discord-plan.md](auth-discord-plan.md) — la couche d'authentification en dessous
>    (historique, R-01 à R-45).

---

## 1. Le modèle en une page

Quatre rôles strictement ordonnés dans `comptes.role` :

| Rôle | Niveau | Ce qu'il peut |
|---|---|---|
| `player` | 0 | rien d'administratif |
| `admin` | 1 | **rien par défaut** — uniquement les permissions nommées qu'on lui accorde |
| `chef_admin` | 2 | tout le catalogue délégable, **plus** les capacités de rôle (reset global, purge RGPD…) |
| `superadmin` | 3 | tout, y compris les jetons de bot. **Unique à tout instant** |

**Deux façons d'autoriser, à ne jamais confondre** — c'est la distinction structurante :

- **Capacité de rôle** — câblée en dur via `@role_required(...)`, **jamais délégable**. Exemples :
  reset global, purge RGPD, annulation de tournoi, jetons de bot, changement de rôle, legs.
  Ce n'est pas une case décochée : c'est un pouvoir qui n'existe pas dans le système de
  permissions.
- **Permission déléguable** — une entrée de `PERMISSIONS_CATALOGUE`, vérifiée par
  `@permission_required(...)`, qu'un `chef_admin` ou le `superadmin` accorde à un `admin`.

Le catalogue compte **8 permissions**, définies dans `backEnd/constants.py` (et dupliquées dans
`frontEnd/frontend.py`, les deux listes devant rester alignées — `test_revue.py` le vérifie) :

```
gestion_joueurs   gestion_ligues   gestion_saisons   gestion_liaisons
gestion_comptes   gestion_invitations   gestion_config   gestion_matchmaking
```

### Règles à respecter par toute évolution

1. **Unicité du superadmin** — jamais zéro, jamais deux. Index unique partiel en base.
2. **Intouchabilité** — personne n'agit sur le superadmin ; un `chef_admin` est intouchable par
   ses pairs (seul le superadmin agit sur lui).
3. **Un `chef_admin` ne crée pas un `chef_admin`** — seul le superadmin le désigne.
4. **Auto-modification de rôle interdite**, superadmin compris. Sa seule sortie est le **legs**.
5. **Plafond de délégation** — on ne peut accorder un droit qu'on n'a pas soi-même.

---

## 2. Ce qui existe déjà (livré et testé)

### Backend

| Élément | Où |
|---|---|
| `permission_required`, `compte_cible_protegee`, `permissions_delegables_par`, `refuse_auto_modification` | `backEnd/auth.py` |
| `ROLE_CHEF_ADMIN`, `PERMISSIONS_CATALOGUE` | `backEnd/constants.py` |
| Table `permissions_admin` + index unique superadmin | `backEnd/migrations/2026-09-10_hierarchie_admin.sql` (**appliquée**) |
| Routes d'octroi/retrait/lecture des permissions, legs du superadmin | `backEnd/routes_comptes.py` |

**Répartition réelle des décorateurs** (38 routes converties, plus aucun `@admin_or_role_required`) :

```
gestion_joueurs 7 · gestion_saisons 6 · gestion_comptes 6 · gestion_liaisons 3
gestion_invitations 3 · gestion_ligues 2 · gestion_config 2 · gestion_matchmaking 1
role_required : CHEF_ADMIN 12 · SUPERADMIN 5 · ADMIN 3
```

### Frontend

- `_role_session()`, `_permissions_session()`, constante `ROLES_ADMIN` — `frontEnd/frontend.py`.
- Le context processor expose aux templates : `est_admin`, `role_admin`, et le helper
  **`peut('nom_permission')`**.
- Panneau de gestion des permissions par compte, dans `admin_comptes.html` (bouton
  « Permissions » sur chaque ligne d'un compte `admin`).

### Tests

- `backEnd/tests/test_permissions.py` — 23 assertions (les décorateurs).
- `backEnd/tests/test_hierarchie_routes.py` — 76 assertions (les routes, dont le legs).
- ⚠️ Trois échecs **préexistants** au chantier, hors périmètre : `test_auth` 25/26,
  `test_liaisons` (groupe R-07, `not enough values to unpack`), `test_profils` (`TypeError`).
- Les tests tournent avec `harness.py` (pas pytest) : `backEnd/tests/run.sh`. Flask et `requests`
  sont nécessaires — ils vivent normalement dans Docker.

---

## 3. Les 7 onglets et leur gate actuel

Ordre réel du menu Admin (`frontEnd/templates/navbar.html`) :

| # | Onglet | URL | Gate du menu | Template |
|---|---|---|---|---|
| 1 | Gestion tournois | `/admin/tournois` | `peut('gestion_joueurs')` | `add_tournament.html` |
| 2 | Réglages TrueSkill | `/admin/reglages` | `peut('gestion_config')` **ou** `chef_admin`+ | `admin_reglages.html` |
| 3 | Fiches joueurs | `/admin/joueurs-fiches` | `peut('gestion_joueurs')` | `gestion_joueurs.html` |
| 4 | Gestion Ligues | `/admin/ligues` | `peut('gestion_ligues')` | `admin_ligues.html` |
| 5 | Gestion Saisons | `/admin/saisons-gestion` | `peut('gestion_saisons')` | `admin_saisons.html` |
| 6 | Gestion Comptes | `/admin/comptes` | `gestion_comptes` **ou** `gestion_liaisons` **ou** `gestion_invitations` | `admin_comptes.html` |
| 7 | Matchmaking | `/admin/matchmaking` | `peut('gestion_matchmaking')` | `matchmaking.html` |

### Blocs à droits mixtes, gatés séparément DANS la page

- **Onglet 1** : le bloc « Annuler le dernier tournoi » (bouton **et** fonction JS) est sous
  `role_admin in ('chef_admin', 'superadmin')` — capacité de rôle.
- **Onglet 2** : le Reset global sous `chef_admin`+, la Configuration globale sous
  `peut('gestion_config')`. **C'est le patron à suivre** pour toute page mixte.
- **Onglet 6** : quatre sous-onglets, dont « Jetons de bot » réservé au superadmin.

---

## 4. Le sujet de la prochaine session

> *Quelles permissions accorder à un admin pour chacun de ces nouveaux onglets ?*

### 4.1 Le problème qui reste

Le découpage actuel est hérité des **routes backend**, pas des **onglets**. Deux onglets partagent
aujourd'hui la même permission :

| Onglet | Permission | Conséquence |
|---|---|---|
| 1 — Gestion tournois | `gestion_joueurs` | **Impossible** de donner l'un sans l'autre |
| 3 — Fiches joueurs | `gestion_joueurs` | |

Concrètement : on ne peut pas confier l'enregistrement des tournois à quelqu'un sans lui donner
aussi le droit de **supprimer une fiche joueur** et de lancer une **anonymisation RGPD**. C'est
exactement le genre de regroupement que la hiérarchie était censée casser.

### 4.2 Piste principale : scinder `gestion_joueurs`

Une découpe possible, à discuter :

| Nouvelle permission | Couvre | Routes concernées |
|---|---|---|
| `gestion_tournois` | enregistrer un tournoi | `POST /add-tournament` |
| `gestion_joueurs` | fiches joueurs (créer, éditer, supprimer, anonymiser) | `/admin/joueurs*` (5 routes) |

**Points à trancher :**

- Un compte qui enregistre des tournois peut **créer un joueur à la volée** depuis le formulaire
  de l'onglet 1. **Vérifié dans le code** : ce bouton n'appelle *pas* `POST /admin/joueurs` — il
  ajoute le nom à la liste locale, et c'est `POST /add-tournament` qui crée la fiche au moment de
  l'enregistrement. Une permission `gestion_tournois` séparée donnerait donc **déjà** le pouvoir
  de créer des joueurs, sans passer par `gestion_joueurs`. À prendre en compte : le découpage ne
  serait pas aussi étanche qu'il en a l'air.
- L'**anonymisation RGPD** (`POST /admin/joueurs/<id>/anonymiser`) est irréversible. Rester dans
  `gestion_joueurs`, ou devenir une capacité `chef_admin` comme `purge-rgpd` ? Cette asymétrie
  était déjà signalée dans l'annexe A de `hierarchie-admin-plan.md` comme « à décider en Phase 3 ».

### 4.3 Autres questions ouvertes

- **`gestion_config` et le reset global** cohabitent sur l'onglet 2. Faut-il une permission
  déléguable pour le reset, ou reste-t-il une capacité `chef_admin` ? (Décision actuelle :
  capacité, non délégable — cf. Phase 0 du chantier précédent, R-51.)
- **Vue d'ensemble des droits** : le `chef_admin` doit aujourd'hui ouvrir le panneau de chaque
  admin un par un pour savoir qui peut quoi. Un tableau récapitulatif (admins en lignes,
  permissions en colonnes) avait été évoqué mais n'est pas fait.
- **Profils de permissions** : proposer des ensembles pré-cochés (« organisateur de tournois »,
  « modérateur de comptes ») plutôt que 8 cases à cocher une par une.

---

## 5. Règles de travail à respecter

Elles ont structuré tout le chantier précédent, et le prochain doit les suivre :

1. **Jamais de conversion par regex ou par préfixe d'URL** — route par route, une checklist
   explicite. C'est le mode d'échec de R-50 : une implémentation par préfixe `/admin/comptes/*`
   aurait inclus `/role` par accident.
2. **Le frontend n'est jamais une frontière de privilège.** `peut()` décide de ce qui s'affiche ;
   le backend relit rôle et permissions **en base à chaque requête**. Ne jamais mettre le rôle en
   cache dans la session (§4.2bis du plan) — un droit retiré resterait actif jusqu'à 30 jours.
3. **Une panne DB ne produit jamais un 401/403** — le frontend purge la session sur ces codes.
   C'était le bug R-55. Utiliser 503.
4. **Un 403 « droit manquant » ne déconnecte pas.** Corrigé dans `gestion.js` et
   `add_tournament.html` (B.5) : distinguer sur le code renvoyé (`permission_manquante`,
   `cible_protegee`…) d'une vraie session expirée.
5. **Toute nouvelle permission doit être ajoutée aux DEUX catalogues** (backend et frontend) et
   documentée dans le panneau de `admin_comptes.html`, qui porte un libellé lisible, une
   description en verbes d'action, et parfois un avertissement.

---

## 6. Pièges rencontrés — à ne pas retrouver

- **`fade-in` rend invisible.** La classe pose `opacity: 0` et attend `visible`, ajoutée par
  `gestion.js`. Sur une page qui ne charge pas ce script, tout élément `fade-in` est construit,
  inséré… et invisible. (14 autres templates ont ce problème latent, **préexistant** et non
  traité.)
- **`admin_comptes.html` interdit `innerHTML`** avec du balisage : tout passe par `textContent`
  ou `createElement` (protection XSS documentée en tête de fichier). Un helper `icone()` existe
  pour les icônes Font Awesome.
- **`/stats/tournois` sert du HTML**, pas du JSON — impossible à consommer en `fetch`. La liste
  des tournois est rendue côté serveur.
- **`/admin/joueurs` est déjà pris** par un proxy JSON : la page s'appelle `/admin/joueurs-fiches`.
- **Node n'est pas installé.** Pour valider du JS : `esprima` via pip (attention, il ignore le
  chaînage optionnel `?.`, que le projet utilise — le neutraliser avant de parser).
- **`loadConfig()` plantait** sur une page sans le formulaire de config (`getElementById(...).value`
  sur `null`). Corrigé, mais le motif existe peut-être ailleurs.

---

## 7. État de la base

La migration est **appliquée**. Un seul superadmin existe. La table `permissions_admin` est en
place mais probablement **vide** : aucun admin n'a encore reçu de permission par l'interface.

Pour vérifier :

```sh
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
   "SELECT c.discord_username, c.role, p.permission
    FROM comptes c LEFT JOIN permissions_admin p ON p.compte_id = c.id
    WHERE c.role <> '"'"'player'"'"' ORDER BY c.id;"'
```

⚠️ **Non testé en conditions réelles.** Tout est validé par tests unitaires et rendus de
templates ; le parcours dans un navigateur reste à faire, en particulier le **legs du superadmin**
(geste irréversible) et le comportement d'un admin avec une seule permission.
