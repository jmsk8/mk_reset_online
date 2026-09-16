# Permissions et onglets d'administration — contexte de reprise

> **À lire en premier dans une nouvelle session.** Ce document résume ce qui a été construit,
> pourquoi, et ce qui reste à faire sur la question : *« quelles permissions accorder à un admin
> pour chacun des nouveaux onglets ? »*
>
> Date de rédaction : 2026-09-10. Rien n'est commité — l'utilisateur fait ses commits lui-même.
>
> ⚠️ **Depuis le 2026-09-13, l'état d'avancement consolidé vit dans
> [hierarchie-admin-avancement.md](hierarchie-admin-avancement.md)** — c'est le fichier à lire en
> premier. Celui-ci garde le détail des arbitrages et des sujets ouverts (§8), que l'avancement
> résume sans les remplacer.
>
> Documents liés, à lire dans cet ordre si besoin de détail :
> 1. [hierarchie-admin-avancement.md](hierarchie-admin-avancement.md) — **où en est le chantier**,
>    ce qui reste, les pièges rencontrés.
> 2. [hierarchie-admin-plan.md](hierarchie-admin-plan.md) — le modèle de rôles et permissions
>    (conception complète + registre des risques R-46 à R-60). **Les 6 phases sont livrées.**
> 3. [onglets-admin-plan.md](onglets-admin-plan.md) — la réorganisation des 7 onglets.
>    **Livrée.**
> 4. [auth-discord-plan.md](auth-discord-plan.md) — la couche d'authentification en dessous
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
  purge RGPD, annulation de tournoi, jetons de bot, changement de rôle, legs.
  Ce n'est pas une case décochée : c'est un pouvoir qui n'existe pas dans le système de
  permissions. *(Le reset global en faisait partie jusqu'au 13/09 — il est désormais délégable,
  §8.7.)*
- **Permission déléguable** — une entrée de `PERMISSIONS_CATALOGUE`, vérifiée par
  `@permission_required(...)`, qu'un `chef_admin` ou le `superadmin` accorde à un `admin`.

Le catalogue compte **9 permissions** (8 jusqu'au 13/09, cf. §8.7), définies dans
`backEnd/constants.py` (et dupliquées dans `frontEnd/frontend.py`, les deux listes devant rester
alignées — `test_revue.py` le vérifie) :

```
gestion_joueurs   gestion_tournois   gestion_ligues   gestion_saisons
gestion_liaisons  gestion_comptes    gestion_invitations
gestion_config    gestion_matchmaking
```

⚠️ **Le reset global est une exception à la règle ci-dessus** : c'était une capacité de rôle, il
est devenu une **permission déléguable** (`gestion_config`) le 13/09. Voir §8.7.

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
| 1 | Gestion tournois | `/admin/tournois` | `peut('gestion_tournois')` | `add_tournament.html` |
| 2 | Réglage TS | `/admin/reglages` | `peut('gestion_config')` | `admin_reglages.html` |
| 3 | Fiches joueurs | `/admin/joueurs-fiches` | `peut('gestion_joueurs')` | `gestion_joueurs.html` |
| 4 | Gestion Ligues | `/admin/ligues` | `peut('gestion_ligues')` | `admin_ligues.html` |
| 5 | Gestion Saisons | `/admin/saisons-gestion` | `peut('gestion_saisons')` | `admin_saisons.html` |
| 6 | Gestion Comptes | `/admin/comptes` | `gestion_comptes` **ou** `gestion_liaisons` **ou** `gestion_invitations` | `admin_comptes.html` |
| 7 | Matchmaking | `/admin/matchmaking` | `peut('gestion_matchmaking')` | `matchmaking.html` |

### Blocs à droits mixtes, gatés séparément DANS la page

- **Onglet 1** : le bloc « Annuler le dernier tournoi » (bouton **et** fonction JS) est sous
  `role_admin in ('chef_admin', 'superadmin')` — capacité de rôle.
- **Onglet 2** : les deux blocs (Reset global et Configuration globale) sont désormais sous
  `peut('gestion_config')` — le reset est devenu délégable le 13/09 (§8.7). La page n'est donc
  **plus** un exemple de double-gate ; le patron à suivre pour une page mixte est l'onglet 1
  (bloc « Annuler le dernier tournoi » sous capacité de rôle) ou l'onglet 6.
- **Onglet 4 (Ligues)** : la page écrit deux clés de `/admin/config` (`league_mode_enabled`,
  `inter_league_moves`) qui relèvent de `gestion_ligues`, pas de `gestion_config` — la route
  vérifie chaque domaine séparément dans son corps (§8.7).
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

---

## 8. Plan d'attaque — suite (revue du 2026-09-11)

**Rien de ce qui suit n'est codé.** Trois sujets ouverts, trouvés en relisant le chantier livré,
tous en attente de décision ou d'implémentation. Ordre proposé : 8.1 en premier (vraie lacune de
sécurité, déjà tranchée avec l'utilisateur), 8.2 et 8.3 ensuite (dette de process/tests, moins
urgents).

### 8.1 `compte_cible_protegee` ne connaît que 2 cas en dur — un admin peut agir sur un autre admin/chef_admin

Trouvé en testant en tant qu'admin simple : sur la page Comptes, les boutons Désynchroniser /
Fermer les sessions / Suspendre s'affichent (et aboutissent) même sur des cibles qui ne devraient
pas être touchables par ce rang. Détail complet, décisions et pseudo-code dans la mémoire de
session (`compte-cible-protegee-regle-rang`, voir aussi §4.3bis et R-56 de
`hierarchie-admin-plan.md`, qui documentaient déjà partiellement ce trou pour le cas chef_admin).

**Diagnostic vérifié dans le code (11/09) :**
- Backend (`backEnd/auth.py:285`, `compte_cible_protegee`) : bloque bien via HTTP (pas de faille
  d'autorisation *fonctionnelle*), mais ne code que 2 cas en dur — cible `superadmin` toujours
  refusée, cible `chef_admin` refusée si acteur non-superadmin. Aucun 3ᵉ cas pour `admin` vs
  `admin`/`chef_admin`.
- Frontend (`frontEnd/templates/admin_comptes.html:290-330`) : la variable `cibleProtegee` n'est
  calculée que pour le sélecteur de rôle ; les 3 boutons d'action (lignes 336-390) n'ont aucun
  garde équivalent → bouton actif menant à un 403 prévisible, contraire au principe §B.0 du plan
  hiérarchie (« le front ne doit jamais laisser un bouton mener à un 403 prévisible »).

**Décision utilisateur (11/09) : remplacer par une règle générique de rang**, pas une délégation
configurable par le superadmin. Sur les 4 actions « mineures » (sessions/statut/delier/sync —
**jamais** `changer_role`, qui garde sa propre logique de plafond par valeur, ni le legs) :

```
rang(acteur) > rang(cible)  →  autorisé
rang(acteur) <= rang(cible) →  refusé (403 cible_protegee)
```

en réutilisant `ROLE_HIERARCHY` déjà existant. Conséquence : `admin` → seulement `player` ;
`chef_admin` → `player` et `admin`, jamais un pair `chef_admin` ni le `superadmin` ; `superadmin` →
tout le monde. Le cas chef_admin-vs-chef_admin (R-52, déjà tranché fail-closed) tombe naturellement
de cette règle générique, plus besoin d'un cas à part.

**Explicitement écarté par l'utilisateur** : pas de mécanisme où le superadmin autoriserait
nommément un chef_admin/admin à toucher son propre compte — la hiérarchie reste stricte et fixe,
symétrique au reste du modèle.

**Portée du changement, à ne pas dévier à l'implémentation :**
- `compte_cible_protegee` réécrite avec un seul calcul de rang au lieu des 2 `if` en dur (un seul
  message d'erreur `cible_protegee` au lieu des deux formulations actuelles).
- `admin_comptes.html` : variable JS `cibleProtegee` recalculée par rang (dupliquer `ROLE_HIERARCHY`
  côté front comme le catalogue de permissions l'est déjà en `PERMISSIONS_CATALOGUE_FRONT`),
  étendue aux 3 boutons non gatés identifiés ci-dessus.
- Tests `test_permissions.py`/`test_hierarchie_routes.py` : ajouter le 3ᵉ palier (admin bloqué sur
  admin, admin bloqué sur chef_admin, admin autorisé sur player).
- Docs : mettre à jour la docstring de `compte_cible_protegee` (parle actuellement de « deux
  règles ») et ajouter une entrée au registre de risques de `hierarchie-admin-plan.md` après R-60.
- **Ne pas toucher `changer_role`** : sa logique de plafond (quelle *valeur* de rôle poser) est
  distincte de celle-ci (quelle *cible* on peut toucher) — les deux ne doivent pas fusionner.

### 8.2 Hygiène git : ce chantier n'a pas de commit à lui

Vérifié le 11/09 : `admin_reglages.html`, `onglets-admin-plan.md`, `permissions-onglets-contexte.md`
et les modifications de `add_tournament.html`/`navbar.html`/`gestion.js`/`frontend.py` pour ce
chantier sont tous entrés dans le dépôt via le commit `372db58 "Add C++ race engine (M0-M5), keep
JS as default"`, qui ne les mentionne pas — mélangé avec ~800 lignes sans rapport (le moteur de
course C++, `raceEngineCpp/`). Rien de cassé fonctionnellement, mais l'historique ne raconte plus
fidèlement ce chantier (un futur `git log`/`git blame` sur les fichiers admin ne mènera pas à un
commit qui en parle). Pas d'action corrective a posteriori proposée (réécrire l'historique est
explicitement écarté, voir la mémoire de session `repo-public-donnees-reelles-historique`) — juste
un point de vigilance pour le prochain commit touchant à ce sujet : le garder distinct.

Détail mineur trouvé au passage : le commentaire au-dessus de `revert_last_tournament`
(`backEnd/routes_admin.py:1268-1270`) dit encore *« son bouton est dans navbar.html »* — obsolète
depuis que le bouton a migré vers `add_tournament.html` (§3.1 de `onglets-admin-plan.md`). Cosmétique,
à corriger dans la foulée d'un prochain commit sur ce fichier.

### 8.3 Aucun test dédié aux 3 nouvelles routes de `onglets-admin-plan.md`

Contrairement à `hierarchie-admin-plan.md` (Phase 5, 99 assertions), `onglets-admin-plan.md` n'a pas
de phase tests, et aucun test (`backEnd/tests/`) ne touche `admin_tournois`, `admin_reglages` ou
`admin_joueurs_fiches` — confirmé par recherche le 11/09. Le §7 de ce document le disait déjà
implicitement (« non testé en conditions réelles »), mais spécifiquement : rien ne vérifie que
- la page `/admin/reglages` applique bien son double-gate (accès à la page **et** gate séparé par
  bloc à l'intérieur du template) ;
- un admin avec `gestion_config` seul ne voit pas le bloc reset, et réciproquement ;
- les 3 routes renvoient bien un flash/redirect cohérent sur une session expirée vs un droit
  manquant (patron B.5 déjà appliqué dans le code, jamais vérifié par un test).

À écrire avant de considérer ce chantier clos — indépendant de 8.1 et 8.2, peut se faire en
parallèle.

### 8.4 Ordre de traitement proposé

1. **8.1** — trancher/coder la règle de rang générique (sécurité, déjà décidée avec l'utilisateur,
   il ne reste que l'implémentation).
2. **8.5** (ci-dessous) — scission de `gestion_joueurs` et nouvelle permission mu/sigma, tranchées
   avec l'utilisateur le 11/09. Reste à implémenter.
3. **8.3** — tests manquants des 3 nouvelles routes.
4. **8.2** — pas d'action corrective, juste vigilance sur le prochain commit.

### 8.5 Scission de `gestion_joueurs` + nouvelle permission mu/sigma — **[DÉCIDÉ] 2026-09-11**

Répond à la question 4.2 ci-dessus. Trois permissions séparées remplacent l'actuelle
`gestion_joueurs`, catégorisant des risques de nature différente (saisie routinière / gestion de
fiche / donnée sensible sans trace) plutôt qu'une seule permission fourre-tout.

**A. `gestion_tournois`** *(nouvelle)* — enregistrer un tournoi.
- Couvre : `POST /add-tournament` (le seul appel de l'onglet 1 « Gestion tournois »).
- **[DÉCIDÉ]** Conséquence assumée : un admin avec seulement `gestion_tournois` **ne peut plus
  créer de joueur à la volée** depuis le formulaire. Un joueur absent de la liste doit être créé
  au préalable par quelqu'un ayant `gestion_joueurs` — ce n'est **pas** un bug à corriger, c'est le
  comportement voulu (c'était justement la fuite signalée en §4.2 : sans ce garde-fou, donner
  `gestion_tournois` seul aurait quand même donné un pouvoir de création de fiche).
- Implémentation : `POST /add-tournament` (routes_admin.py:982 selon l'annexe A de
  `hierarchie-admin-plan.md`) passe de `perm:gestion_joueurs` à `perm:gestion_tournois`. Si cette
  route crée aujourd'hui un joueur absent de la table au moment de l'enregistrement (à vérifier
  dans le code au moment d'implémenter — le doc §4.2 ne tranche pas ce point précis, seulement le
  cas du bouton « créer à la volée » côté formulaire), il faudra soit refuser explicitement les
  noms inconnus avec une erreur claire, soit vérifier que **ce n'est déjà pas le cas** et que
  seul le formulaire (`POST /admin/joueurs`, sous `gestion_joueurs`) crée des fiches.

**B. `gestion_joueurs`** *(sens réduit)* — gestion de fiche : créer, éditer (hors mu/sigma, voir C),
lister, supprimer.
- Couvre : `GET/POST/PUT/DELETE /admin/joueurs*` (hors `anonymiser`, voir D), `GET
  /admin/types-awards` (reste rattachée par héritage historique du mapping §5 de
  `hierarchie-admin-plan.md`, à revalider — sert en réalité la page saisons, pas joueurs).
- `PUT /admin/joueurs/<id>` (`api_update_joueur`, routes_admin.py:361-380) reste sous cette
  permission pour les champs `nom`, `is_ranked`, `consecutive_missed`, `color` — **mais plus pour
  `mu`/`sigma`**, voir C pour le découpage à l'intérieur de cette même route.

**C. Nouvelle permission `edition_mu_sigma`** *(nom provisoire, à confirmer)* — modifier
**manuellement** le mu/sigma d'un joueur depuis sa fiche.
- **[DÉCIDÉ]** Séparée de `gestion_joueurs` précisément parce que cette modification **ne laisse
  pas de trace claire** contrairement au reset global (voir D) : c'est un contournement direct du
  moteur TrueSkill, pas une action passant par le système normal.
- **[DÉCIDÉ]** Délégable comme une permission normale du catalogue (pas réservée chef_admin+),
  malgré la sensibilité — cohérent avec le principe « permission à la carte » du reste du système.
- **[DÉCIDÉ] Frontend** : un admin avec `gestion_joueurs` mais sans `edition_mu_sigma` doit
  **voir** les champs mu/sigma sur la fiche joueur (lecture), mais ils doivent être **non
  éditables** (`disabled`/`readonly`) — jamais un champ actif qui échoue silencieusement à
  l'enregistrement. Même principe que le double-gate déjà en place sur `admin_reglages.html`
  (config vs reset) : ne jamais laisser un bouton/champ mener à un 403 prévisible (§B.0 du plan
  hiérarchie).
- **[DÉCIDÉ] Backend** : `api_update_joueur` (routes_admin.py:361-380) doit distinguer la
  permission `gestion_joueurs` (accès à la route) de `edition_mu_sigma` (droit d'écrire ces deux
  champs précis) **à l'intérieur de la même route**, pas via un `@permission_required` de route
  entière — mu/sigma partagent aujourd'hui le même `UPDATE` SQL que `nom`/`is_ranked`/`color`.
  ⚠️ **Piège technique déjà identifié dans le code actuel** : `mu` et `sigma` sont lus par
  `data['mu']`/`data['sigma']` (accès direct, pas `.get()`) — **obligatoires** dans le payload
  JSON aujourd'hui. Un admin sans `edition_mu_sigma` doit pouvoir enregistrer les autres champs
  (nom, statut…) sans que la requête échoue faute de `mu`/`sigma` absents ou parce qu'il a envoyé
  les valeurs actuelles inchangées. Deux implémentations possibles à trancher au moment de coder :
  (a) le frontend envoie toujours mu/sigma (valeurs actuelles si non éditables, donc no-op côté
  data), et le backend compare aux valeurs en base pour savoir si un vrai changement est demandé
  avant de vérifier la permission ; (b) rendre `mu`/`sigma` optionnels dans le payload et n'exiger
  `edition_mu_sigma` que s'ils sont présents et différents. (a) est plus simple côté backend mais
  fragile si un futur appel API direct (hors frontend) omet ces champs ; (b) est plus robuste mais
  demande de comparer aux valeurs actuelles en base avant d'écrire, pour distinguer « renvoyé tel
  quel » de « pas envoyé ». À trancher à l'implémentation, pas ici.

**D. Le reset global reste une capacité `chef_admin`+, mais rattachée à `gestion_config`**
- **[DÉCIDÉ]** Contrairement à la modification manuelle de mu/sigma (C), le reset global passe
  par le moteur TrueSkill lui-même — c'est une action de masse **via le système**, traçable et
  reproductible, pas un contournement. D'où la distinction voulue par l'utilisateur : « si on
  autorise un admin à toucher aux réglages TrueSkill, qu'il ait le droit à tout ce qui peut
  toucher au TrueSkill » — le reset global rejoint donc `gestion_config` (déjà la permission de
  l'onglet 2 « Réglages TrueSkill », où vit déjà le bouton).
  ⚠️ Ceci **inverse** la décision R-51 du 03/09 (`hierarchie-admin-plan.md`), qui sortait le reset
  du champ délégable précisément pour l'empêcher d'être accordé à un simple `admin`. C'est un
  changement de doctrine assumé et explicite, pas un oubli — **si un jour ce fichier ou
  `hierarchie-admin-plan.md` est relu sans ce contexte, ne pas « corriger » en revenant à
  chef_admin+ sans revalidation avec l'utilisateur.**
- Implémentation : `POST /api/admin/global-reset` et `POST /api/admin/revert-global-reset`
  (routes_admin.py:148-224, aujourd'hui `@role_required(ROLE_CHEF_ADMIN)`, commentaire « NE JAMAIS
  convertir ») passent à `@permission_required('gestion_config')`. **Le commentaire « NE JAMAIS
  convertir » doit être retiré/réécrit dans le même commit**, sinon il contredit le code et
  induira en erreur la prochaine lecture.
- `admin_reglages.html` : le bloc reset (`partiels/reset_global.html`) passe de son gate actuel
  `role_admin in ('chef_admin', 'superadmin')` à `peut('gestion_config')` — le double-gate de la
  page (config vs reset, séparés) **disparaît** : les deux blocs partagent désormais le même gate,
  la distinction visuelle en deux blocs peut être conservée pour la lisibilité mais n'a plus de
  rôle de sécurité.

**E. `gestion_joueurs/<id>/anonymiser` devient une capacité `chef_admin`+ — [DÉCIDÉ] 2026-09-11**
- Route : `POST /admin/joueurs/<id>/anonymiser` (routes_admin.py:474-476), aujourd'hui
  `perm:gestion_joueurs`, passe à `@role_required(ROLE_CHEF_ADMIN)` — alignée sur `purge-rgpd`
  (déjà non délégable) pour la même raison : action irréversible avec obligation légale, distincte
  d'une simple édition ou suppression de fiche. Referme l'asymétrie notée dans l'annexe A de
  `hierarchie-admin-plan.md` comme « à décider en Phase 3 » et jamais tranchée jusqu'ici.
- `gestion_joueurs.html` : le bouton d'anonymisation doit passer sous son propre gate
  `role_admin in ('chef_admin', 'superadmin')`, séparé du reste des actions de fiche (patron
  identique au double-gate déjà en place sur `admin_reglages.html`).

### 8.6 Incohérences trouvées en relisant 8.5 — **[À TRANCHER]**, revue du 2026-09-11

Cinq points trouvés en vérifiant le code réel derrière les décisions de 8.5, avant toute
implémentation. Les deux premiers contredisent directement ce qui a été décidé et doivent être
tranchés avant de coder quoi que ce soit sur A/B/C ; les trois suivants sont des angles morts ou
des points de vigilance, moins urgents.

**1. 🔴 `gestion_tournois` seul ne bloque pas la création de joueur — contredit la décision du
point A.** Vérifié dans le code (`add_tournament`, routes_admin.py:1060-1078) :
`INSERT INTO Joueurs (...)` s'exécute dès qu'un nom absent de la table apparaît dans le payload
du tournoi, **indépendamment de tout bouton dédié côté formulaire** — ce n'est pas un chemin de
code annexe, c'est le comportement normal de la route à chaque enregistrement. Changer seulement
le décorateur de `add_tournament` de `gestion_joueurs` vers `gestion_tournois` (comme prévu au
point A) **ne suffit pas** à empêcher un admin `gestion_tournois` sans `gestion_joueurs` de créer
des fiches joueurs : il lui suffit de taper un nom inconnu dans le formulaire de tournoi.
  *Pour que la décision du point A tienne réellement* : `add_tournament` doit refuser
  explicitement un nom absent de la table quand l'acteur n'a pas `gestion_joueurs` (erreur claire,
  ex. `{"error": "Joueur inconnu, à créer au préalable dans Fiches joueurs.", "code":
  "joueur_inconnu"}`, 404 ou 409), plutôt que de le créer silencieusement. Nécessite de vérifier
  `permissions_delegables_par`/`_a_permission` à l'intérieur même de la route (double vérification
  de permission dans une seule route, motif déjà utilisé ailleurs pour C).

**2. 🟠 `POST /admin/joueurs` (création manuelle) accepte `mu`/`sigma` en paramètre libre, hors
`edition_mu_sigma`.** Vérifié dans le code (`api_add_joueur`, routes_admin.py:531-560) :
`mu = float(data.get('mu', DEFAULT_MU))` et pareil pour `sigma` — un admin avec seulement
`gestion_joueurs` peut fixer n'importe quelle valeur de score à la création d'une fiche, sans
passer par le moteur TrueSkill ni par `edition_mu_sigma`. C'est exactement le contournement non
tracé que le point C est censé empêcher, par une porte différente.
  *Deux résolutions possibles, à trancher avec l'utilisateur avant de coder C* :
  (a) la création ignore désormais `mu`/`sigma` du payload et force toujours `DEFAULT_MU`/
  `DEFAULT_SIGMA`, quel que soit l'acteur — simple, mais retire une fonctionnalité qui existe
  peut-être pour une bonne raison (réinsérer un joueur avec un historique connu, migration de
  données) ;
  (b) fixer `mu`/`sigma` à la création exige aussi `edition_mu_sigma`, sinon la requête les ignore
  silencieusement (ou refuse si les valeurs demandées diffèrent des défauts) — cohérent avec le
  reste du modèle, mais ajoute une 2ᵉ vérification de permission dans cette route en plus de
  `gestion_joueurs`.

**3. 🟡 Angle mort symétrique du point 2 : `DELETE` + recréation contourne `edition_mu_sigma`.**
Tant que le point 2 n'est pas réglé, un admin avec `gestion_joueurs` (sans `edition_mu_sigma`)
peut supprimer un joueur (`DELETE /admin/joueurs/<id>`, sous `gestion_joueurs`) puis le recréer
avec le `mu`/`sigma` de son choix via `POST /admin/joueurs`. **Se referme automatiquement une fois
le point 2 résolu** (option a ou b) — noté séparément pour vérifier explicitement, à
l'implémentation, que la correction du point 2 ferme bien aussi ce chemin-là et pas seulement la
création directe.

**4. 🟡 Chevauchement `gestion_matchmaking` / `gestion_tournois` / `gestion_joueurs`, déjà signalé
le 03/09 (point 6 de la mémoire de conception initiale), jamais retranché.** La scission
d'aujourd'hui repose la question plus précisément : `/admin/matchmaking` (routes_comptes.py:1194)
lit-il seulement les scores TrueSkill pour composer des lobbies (lecture seule, pas de conflit), ou
écrit-il quelque chose qui chevaucherait `gestion_joueurs`/`gestion_tournois` ? À vérifier dans le
code au moment d'implémenter plutôt que de laisser cet angle mort une session de plus.

**5. 🔵 Lisibilité du catalogue : deux permissions distinctes (`gestion_config` et
`edition_mu_sigma`) peuvent chacune, séparément, changer le mu/sigma de tout le monde ou d'un
joueur — par des chemins différents (reset système vs saisie manuelle).** Pas une incohérence
fonctionnelle (décision assumée, cf. point D), mais risque d'être déroutant relu à froid sans le
contexte de cette section. À traiter uniquement par le libellé/la description affichés dans le
panneau de permissions de `admin_comptes.html` (règle §5 point 5 de ce document) : préciser
explicitement pour `edition_mu_sigma` qu'elle ne couvre **que** la modification manuelle
individuelle, pas le reset global.

**Récapitulatif du catalogue de permissions après ce chantier** (8 → 10 entrées) :
```
gestion_tournois *(nouvelle, A)*    gestion_joueurs *(sens réduit, B)*
edition_mu_sigma *(nouvelle, C)*    gestion_ligues        gestion_saisons
gestion_liaisons                    gestion_comptes       gestion_invitations
gestion_config *(couvre aussi le reset global, D)*         gestion_matchmaking
```
Capacités de rôle inchangées par ailleurs : jetons de bot, purge-rgpd, **anonymisation joueur
(E, nouvellement non délégable)**, désignation de chef_admin, legs de superadmin, changer_role.

**À faire avant de coder** (checklist, dans l'ordre) :
1. Confirmer le nom définitif de `edition_mu_sigma` (proposition provisoire, jamais validée
   explicitement par l'utilisateur — juste utilisée dans cette section pour en parler).
2. Vérifier dans le code actuel si `POST /add-tournament` peut créer un joueur absent de la table
   (point A, conséquence sur `gestion_tournois` seul).
3. Trancher (a) vs (b) du point C pour le payload mu/sigma optionnel.
4. Ajouter les deux nouvelles permissions aux deux catalogues (`backEnd/constants.py` **et**
   `frontEnd/frontend.py`, `PERMISSIONS_CATALOGUE`/`PERMISSIONS_CATALOGUE_FRONT`) — piège déjà
   documenté au §5 point 5 des règles de travail de ce fichier.
5. Retirer le commentaire « NE JAMAIS convertir » au-dessus du reset global (point D) dans le même
   commit que la conversion.
6. Étendre `admin_comptes.html` (panneau de permissions par compte) pour afficher les 2 nouvelles
   entrées avec un libellé lisible et une description en verbes d'action (règle §5 point 5 déjà
   en place).
7. Tests : couvrir le nouveau 3ᵉ palier de granularité sur les fiches joueurs (admin avec
   `gestion_joueurs` seul → 403 sur mu/sigma ; avec `edition_mu_sigma` en plus → passe ; sans
   aucune des deux → 403 sur la route entière) et le nouveau statut `chef_admin`+ de
   l'anonymisation.

---

## 8.7 Scission des permissions — ✅ **LIVRÉE le 2026-09-13**

Demande de l'utilisateur, arbitrée en séance. **Remplace partiellement 8.5** : les points A, B et D
sont livrés (sous une forme révisée), les points C et E ne le sont pas et sont **abandonnés** — voir
« Ce qui est caduc » en bas.

### Ce qui a été fait

**Catalogue : 8 → 9 entrées.** `gestion_tournois` ajoutée aux deux catalogues
(`backEnd/constants.py` et `frontEnd/frontend.py` — ils doivent rester alignés).

| Permission | Libellé | Couvre désormais |
|---|---|---|
| `gestion_joueurs` | **Fiches joueurs** | Créer, renommer, supprimer une fiche, **corriger le score** |
| `gestion_tournois` | **Tournois** *(nouvelle)* | `POST /add-tournament`, et rien d'autre |
| `gestion_config` | **Réglage TS** | Mode fantôme, seuil de classement, **+ reset global** — plus le mode ligue |
| `gestion_ligues` | Ligues | Ligues et draft, **+ mode ligue et mouvements inter-ligues** |

### Les trois contournements fermés au passage

Sans eux la scission aurait été décorative — c'est l'essentiel de ce qui a été codé :

1. **🔴 `add-tournament` créait une fiche joueur à la volée** (`routes_admin.py`, branche « nom
   inconnu »). Un admin `gestion_tournois` seul pouvait donc créer des joueurs en tapant un nom
   absent — le chemin normal de la route, pas un cas limite. La création vérifie maintenant
   `gestion_joueurs` dans le corps et refuse en 409 `joueur_inconnu` sinon.
2. **🔴 La page Ligues réémettait TOUTE la config.** `toggleLeagueMode()` et
   `saveInterLeagueMoves()` faisaient `{...currentConfig, <leur clé>}` : activer le mode ligue
   réécrivait `tau`, la pénalité fantôme et le seuil de classement, écrasant ce qu'un autre admin
   venait d'y changer et déclenchant le reclassement de tous les joueurs. Elles n'envoient plus que
   leur propre clé.
3. **🔴 `update_config` écrivait les 8 clés TrueSkill à CHAQUE appel**, avec leurs valeurs par
   défaut si absentes du payload. Un payload partiel réinitialisait donc les réglages. Chaque clé
   n'est désormais écrite que si elle est présente, et le reclassement (`SET is_ranked`) ne part
   que si `unranked_threshold` a été fourni.

### Le point de conception à connaître

**`/admin/config` ne porte plus de décorateur de permission**, seulement `@player_required`, et
vérifie `gestion_config` / `gestion_ligues` **dans son corps**, chacune pour ses propres clés.

Raison : un `@permission_required('gestion_config')` s'exécute avant le corps et refuserait un
admin « Ligues » avant qu'il puisse activer le mode ligue — l'inverse exact de la séparation
voulue. Le helper `compte_a_permission()` (nouveau, dans `auth.py`) sert cette vérification
secondaire, et renvoie 503 plutôt que False si la base ne répond pas (même raison qu'en R-55).

⚠️ `test_bascule.py` accepte donc `player_required` dans son inventaire de décorateurs, **avec une
assertion de contrepartie** : toute route admin qui s'en contente doit vérifier un droit dans son
corps. Sans elle, `player_required` deviendrait une porte dérobée ouverte à tout joueur connecté.

`GET /admin/config` est passée en lecture ouverte à toute session authentifiée : trois pages en
dépendent sans relever de `gestion_config` (Ligues, Saisons, Fiches joueurs), et ces valeurs ne sont
pas des secrets.

### Ce qui est caduc — ne pas « corriger » sans revalidation

- **R-51 est définitivement inversé.** Le reset global est **délégable** via `gestion_config`.
  Le commentaire « NE JAMAIS convertir » de `routes_admin.py` a été réécrit pour dire l'inverse et
  expliquer pourquoi. Motif retenu : le reset passe *par* le moteur TrueSkill, il est traçable et
  reproductible, contrairement à une saisie manuelle de score.
- **8.5-C (`edition_mu_sigma`) est abandonné.** Corriger un score reste dans `gestion_joueurs`,
  conformément à la formulation de l'utilisateur. Le catalogue compte donc 9 entrées, pas 10, et
  les points 2 et 3 de §8.6 (contournement par `POST /admin/joueurs` puis par DELETE+recréation)
  **tombent d'eux-mêmes** : sans permission séparée, il n'y a plus rien à contourner.
- **8.5-E (anonymisation en `chef_admin`+) n'est pas livré** et reste ouvert.
- **§8.6 point 4 est un non-sujet** : vérifié le 13/09, `/admin/matchmaking` est en lecture seule
  (aucun `UPDATE`/`INSERT`/`DELETE`). Aucun chevauchement avec `gestion_joueurs`/`gestion_tournois`.

### Conséquence en production

Les admins qui portent aujourd'hui `gestion_joueurs` **perdent le droit d'enregistrer un tournoi**
tant que `gestion_tournois` ne leur est pas accordée. C'est mécanique et voulu, mais ça se verra :
`permissions_admin` stocke des chaînes libres, aucune migration ne peut deviner l'intention.

### Tests

`backEnd/tests/test_scission_permissions.py` — **34 assertions** : les deux sens de la séparation
Réglage TS / Ligues, le refus explicite plutôt que silencieux, le non-écrasement des clés absentes,
le garde-fou de création de joueur, le reset délégable, et l'alignement des libellés et des gates
d'interface.

---

## 8.8 Fiche joueur : un droit par geste — ✅ **LIVRÉE le 2026-09-17**

Demande de l'utilisateur, arbitrée en séance. **Rouvre 8.5-C**, que le §8.7 avait abandonné le
13/09 — ce n'est pas une régression ni un oubli de relecture : c'est une décision explicite qui
revient sur la précédente, prise en connaissance de cause. **Ne pas la « corriger » en revenant à
un `gestion_joueurs` fourre-tout sans revalidation.**

### Le principe

`gestion_joueurs` n'ouvre plus que la **lecture** : ouvrir l'onglet Fiches joueurs et consulter la
liste. Chacun des six gestes devient une sous-permission, fille de `gestion_joueurs` — même
mécanisme que l'ex-`rgpd_joueurs`, qui était déjà le premier cas du genre.

| Sous-permission | Geste | Cible technique |
|---|---|---|
| `joueurs_creation` | Ajouter un joueur | `POST /admin/joueurs` |
| `joueurs_nom` | Renommer | `PUT` — champ `nom` |
| `joueurs_couleur` | Changer la couleur | `PUT` — champ `color` |
| `edition_mu_sigma` | Corriger le score | `PUT` — champs `mu`/`sigma` |
| `joueurs_statut` | Changer le statut classé | `PUT` — champ `is_ranked` |
| `joueurs_irreversible` | Supprimer / anonymiser | `DELETE` + `POST .../anonymiser` |

Catalogue : **10 → 15 entrées**.

### `rgpd_joueurs` devient `joueurs_irreversible`

Le nom promettait un dispositif RGPD qui n'existe pas, et l'utilisateur l'a relevé en relisant le
catalogue. La suppression n'a rien de légal : elle **refuse** tout joueur ayant un match (les FK en
CASCADE fausseraient le classement de tout le monde), donc elle ne sert qu'à effacer une fiche
créée par erreur. Seule l'anonymisation relève du droit à l'effacement. Leur vrai point commun est
d'être **sans retour** — d'où le nom.

Option retenue : **un seul droit pour les deux routes** (et non deux droits séparés), l'anonymisation
étant littéralement la porte de sortie proposée quand la suppression refuse.

Migration `2026-09-17_sous_permissions_fiche_joueur.sql` : `UPDATE` du nom, précédé d'un `DELETE`
des doublons éventuels (la contrainte `UNIQUE(compte_id, permission)` ferait échouer l'UPDATE si un
compte portait déjà les deux lignes).

### Le point de conception à connaître

**`api_update_joueur` vérifie CHAMP PAR CHAMP dans son corps**, pas par décorateur — les cinq champs
partagent un seul `UPDATE`, qu'un `@permission_required` de route entière ne saurait pas découper.
La correspondance champ → droit vit dans `PERMISSIONS_CHAMPS_JOUEUR` (`constants.py`), lue par la
route, le gabarit et les tests : ajouter un champ éditable ne demande pas de retrouver les trois.

Deux règles qui en découlent, à ne pas défaire :

1. **Un champ absent du payload, ou renvoyé identique, n'exige aucun droit.** Sinon un admin qui n'a
   que « couleur » ne pourrait rien enregistrer, le formulaire renvoyant la fiche entière.
2. **mu/sigma se comparent à 1e-9 près, jamais à l'identique.** Le frontend les affiche arrondis à
   3 décimales là où TrueSkill en produit bien plus : une égalité stricte lirait `8.333` comme un
   changement de valeur et refuserait un admin qui n'a pourtant touché à rien. Le JS ne renvoie de
   toute façon pas un champ désactivé — la comparaison serveur est le filet pour les appels directs.

### Les deux contournements fermés au passage

Sans eux la séparation aurait été décorative :

1. **`POST /admin/joueurs` acceptait `mu`/`sigma` libres.** Un admin « création » fixait le score
   qu'il voulait sans `edition_mu_sigma`. Un départ hors défaut exige désormais ce droit.
2. **DELETE puis recréation.** Fermé par le point 1 : recréer au score voulu demande maintenant le
   même droit que le corriger en place.

### L'interface : grisé, jamais masqué

**Décision d'ergonomie de l'utilisateur** : un champ qu'un droit manquant rend inopérant reste
**visible et grisé**, avec le curseur `not-allowed` et une infobulle nommant la permission qui
manque (classe `.est-interdit`, `styles.css`). L'admin voit la valeur et comprend qu'un droit lui
manque, au lieu de croire que la fonction n'existe pas.

Ceci **change le patron précédent** : le bouton Supprimer était *caché* sans `rgpd_joueurs`, il est
désormais grisé comme le reste. Seul le formulaire d'ajout disparaît entièrement sans
`joueurs_creation` — il n'y a là aucune valeur à montrer, un formulaire vide et inerte
n'apprendrait rien.

⚠️ Piège rencontré : `updateRankedVisuals()` réécrit `btn.className` en entier à chaque bascule, ce
qui effaçait `est-interdit` et rendait le bouton de statut cliquable après un simple rafraîchissement
visuel. La classe est relue et réappliquée à chaque passage.

### Conséquence en production

Les admins qui portent `gestion_joueurs` **gardent l'onglet mais perdent les six gestes** tant que
les sous-permissions ne leur sont pas accordées une par une. Mécanique et voulu : `permissions_admin`
stocke des chaînes libres, aucune migration ne peut deviner l'intention. Même rupture que
`gestion_tournois` le 13/09, même raison — la migration le documente explicitement.

### Deux bugs trouvés par les tests d'exécution — à ne pas réintroduire

Les tests statiques (lecture du source) ne les voyaient pas. Ils sont sortis en appelant
réellement les routes, et tous deux touchaient le même point : **le frontend renvoie mu/sigma
arrondis à 3 décimales (`toFixed(3)`) alors que TrueSkill en produit bien plus.**

1. **🔴 Un admin sans `edition_mu_sigma` ne pouvait rien enregistrer du tout.** La comparaison se
   faisait à `1e-9` près, or l'écart entre `8.333` (renvoyé) et `8.333333333` (en base) vaut
   `3e-7`. Tout enregistrement — même un simple changement de couleur — partait en 403 sur le
   sigma. La comparaison se fait désormais **à la précision affichée** (`DECIMALES_AFFICHEES = 3`).
   Ne pas « resserrer » cette tolérance : c'est exactement ce qui cassait.

2. **🔴 Éditer le nom d'un joueur tronquait son score.** Une fois le point 1 corrigé, le champ
   jugé inchangé était quand même réécrit avec la valeur du payload : `sigma` passait de
   `8.333333333` à `8.333` en base, silencieusement, à chaque ouverture de la modale. Un champ
   inchangé **reprend désormais la valeur de la base**, jamais celle du payload.

La tolérance reste volontairement stricte (`1e-9`) à la **création**, elle : on y compare aux
constantes `DEFAULT_MU`/`DEFAULT_SIGMA`, qui tiennent en 3 décimales et que le formulaire renvoie
à l'identique. Rien à absorber, donc rien à relâcher — et un seuil serré ferme mieux le
contournement.

### 🔴 Un droit accordé n'apparaissait qu'à la RECONNEXION

Trouvé en testant l'interface, après coup. `session['compte']['permissions']` est une copie figée
à la connexion, et **toutes les pages la lisaient** : accorder « Corriger le score » à un admin ne
changeait rien pour lui, rafraîchissement compris. Il fallait se déconnecter et se reconnecter,
sans qu'aucun écran ne le dise.

**Le correctif : `/auth/check-session` rend désormais `role` et `permissions`.** Cette sonde est
déjà appelée à chaque requête par le `before_request` du frontend, et `player_required` a de toute
façon lu ces deux valeurs en base pour authentifier. Les renvoyer ne coûte donc **rien** : ni
requête SQL, ni aller-retour réseau. Le frontend les recopie en session au passage
(`_maj_droits_session`), et n'écrit le cookie que si quelque chose a changé.

Referme au passage la limite que la docstring de `check_session` annonçait elle-même depuis le
début (« un admin rétrogradé garde son onglet jusqu'à sa prochaine visite sur /mon-compte »).

### ⚠️ La version intermédiaire qui a provoqué des 503 — ne pas y revenir

Le premier correctif appelait `/auth/me` **séparément, depuis le context processor**. Ça marchait,
et les tests passaient. Mais le context processor s'exécute avant **chaque rendu de template** :
chaque page déclenchait donc un aller-retour réseau synchrone, avec le timeout de 5 s de
`backend_request`.

Le frontend tourne sur **2 workers gunicorn** (`Dockerfile.frontend`). Deux pages chargées en même
temps, ou une page et ses appels JS, occupaient les deux workers en attente du backend — plus aucun
worker libre, et nginx répondait **503 Service Temporarily Unavailable** à tout le monde. Observé
en conditions réelles le 2026-09-17, après un changement de droits.

Trois règles qui en sortent, valables au-delà de ce chantier :

1. **Un rendu de page ne fait pas d'appel réseau bloquant.** Si une donnée est nécessaire à chaque
   page, elle voyage avec un appel qui a déjà lieu — pas dans un appel de plus.
2. **Dans le chemin d'une requête, le timeout est court.** `_sonde_session` utilise `timeout=1`
   depuis toujours, précisément pour cette raison ; les 5 s de `backend_request` sont faites pour
   des actions ponctuelles, pas pour du rendu.
3. **Compter les workers.** Avec `-w 2`, il suffit de deux requêtes lentes simultanées pour que le
   service entier paraisse mort.

Un TTL de 30 s avait été tenté pour limiter la casse : il réduisait la fréquence des appels mais
gardait le défaut de structure, et produisait un second symptôme — un droit modifié ne se voyait
qu'après plusieurs rafraîchissements, le temps que la copie expire. La solution actuelle n'a ni
TTL ni invalidation manuelle : la copie est fraîche à chaque requête, gratuitement.

**Ce qui n'a pas changé** : le frontend n'est pas une frontière de privilège. Le backend relit rôle
et permissions en base à chaque requête protégée. Une copie périmée fait voir un bouton de trop,
jamais obtenir un droit de trop. Et une panne (5xx, timeout) ne purge jamais la session — seuls
401/403 déconnectent, comme avant (R-28).

> **Suite de l'enquête — ce paragraphe ne raconte que la première cause.** Supprimer l'appel
> `/auth/me` était nécessaire, mais n'a pas suffi : les 503 sont revenus. Trois autres causes
> indépendantes ont été trouvées ensuite (sonde rejouée sur chaque appel JSON, budget nginx
> calibré sur la mauvaise page, avatars qui consommaient le limiteur pour **tous** les visiteurs,
> y compris non connectés). Le récit complet, mesures à l'appui, est aux §10 et §11 de
> [audit-503-zone-admin.md](audit-503-zone-admin.md) — c'est le document de référence sur ce sujet.
> Les trois règles ci-dessus restent valables telles quelles.

### Tests

Trois fichiers, trois natures :

- `backEnd/tests/test_sous_permissions.py` — **95 assertions** (contre 47 avant) : la structure,
  lue dans le source. Catalogue, table des sous-permissions, alignement backend/frontend, libellés
  du panneau, gabarit/JS/CSS de l'interdiction visuelle.
- `backEnd/tests/test_fiche_joueur_droits.py` — **68 assertions**, *nouveau* : les routes
  **exécutées** sur un curseur scripté. Chaque champ avec et sans son droit, le refus qui nomme le
  champ, l'absence d'`UPDATE` sur refus, la précision du sigma préservée, les deux portes vers
  mu/sigma, le parent exigé en plus de l'enfant, le passe-droit de chef_admin/superadmin, et
  `consecutive_missed` qui reste hors catalogue.

- `backEnd/tests/test_rafraichissement_droits.py` — **34 assertions**, *nouveau* : le
  rafraîchissement des droits, monté sur le vrai `frontend.app`. Un droit accordé vu sans
  reconnexion, un droit retiré qui disparaît, le rôle qui suit, **l'absence de tout appel réseau
  supplémentaire** (c'est la régression qui a causé les 503), le timeout court de la sonde, les
  pannes qui ne déconnectent pas, et six formes de corps inattendu qui ne cassent pas la page.
  Complété le 2026-09-17 par le volet « une sonde par page » : le balayage de tout `frontEnd/` qui
  refuse un `fetch()` de chargement sans en-tête `Accept`, et le refus d'une session révoquée sur
  les deux chemins (document ET appel JSON non sondé). Voir §10 et §11 de
  [audit-503-zone-admin.md](audit-503-zone-admin.md).

C'est le second qui a trouvé les deux bugs de comparaison. Une vérification champ par champ ne se
valide pas en lisant le code : il faut l'appeler.

Deux tests voisins ont dû suivre, sans changement de comportement de leur côté :
`test_penalite_sessions.py` (le compteur d'absences passe maintenant par le helper `siActif` commun
au lieu de son propre `if`) et `test_audit_permissions.py` (son contrôle « aucune permission
décorative » cherchait les permissions citées en dur ; `joueurs_nom` et `joueurs_statut` ne le sont
jamais, elles sont lues depuis `PERMISSIONS_CHAMPS_JOUEUR`).

**Hors périmètre, inchangé** : `consecutive_missed` reste une capacité de rôle du superadmin, jamais
une permission déléguable (décision du 15/09, 28 compteurs périmés constatés).
