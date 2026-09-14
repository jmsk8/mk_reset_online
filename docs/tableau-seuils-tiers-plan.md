# Tableau de réglage des seuils de tiers — journal + plan

> **À lire en premier dans une nouvelle session.** Rien n'est commité — l'utilisateur fait ses
> commits lui-même ([[user-handles-commits]]). **Tout ce document décrit du travail livré et
> testé (13/09/2026)** : Phases 1-3 (Partie A, seuils S/A/B/C réglables) puis Phase 4 (Partie B,
> tiers entièrement dynamiques — CRUD complet, plus aucun S/A/B/C figé dans le code). La Partie B
> a d'abord été rédigée comme un plan de conception avant validation utilisateur, puis implémentée
> dans la foulée le même jour ; le texte du plan est conservé tel quel au §B.1-B.2 pour l'historique
> des décisions, suivi d'un compte-rendu de ce qui a été effectivement livré (§B.7).

Décisions actées avec l'utilisateur (13/09) pour la Phase 4 :
1. Nom de tier **libre, 1 à 10 caractères**, plus une **couleur personnalisable** par tier (au lieu
   de la lettre unique S/A/B/C/U figée aujourd'hui en colonne `character(1)`).
2. Ordre des tiers porté par un **rang numérique explicite** (pas déduit du seuil σ) — l'admin
   contrôle l'ordre indépendamment de la proximité des seuils.
3. **Tous les tiers sont éditables**, y compris l'actuel plancher (« C », qui n'a pas de seuil bas)
   — seul `U` (non classé / hors distribution) garde ses règles fixes, gérées ailleurs dans le code
   (`has_tier`, `IP_V2_REF_REQUIRE_TIER`, etc.), et n'est pas éditable via ce tableau.
4. Stockage : **nouvelle table dédiée `tiers`** (une ligne par tier : nom, couleur, seuil en σ,
   rang), pas un blob JSON dans `configuration`.
5. Le plancher (le tier qui n'a pas de seuil bas, aujourd'hui « C ») est **une propriété dérivée du
   rang**, pas un flag figé : c'est toujours le tier de plus petit rang. Si on le supprime, le tier
   juste au-dessus (nouveau plus-petit-rang) devient automatiquement le plancher.

---

## Partie A — Ce qui a été livré (Phases 1-3, terminé et testé)

Contexte : la page *Réglages TrueSkill* n'avait aucun moyen de régler où passent les frontières de
tier S/A/B/C — elles étaient recalculées à la volée à `mean+stdev / mean / mean-stdev`, en dur dans
le code (`services.py`). Objectif livré : un tableau de bord affichant courbe normale +
positionnement des joueurs, avec les 3 frontières S/A/B **réglables** (glisser sur le graphique ou
saisir au clavier), preview instantané, sauvegarde qui recalcule aussitôt le tier de tous les
joueurs.

### A.1 — Modèle retenu

Les seuils sont devenus des **coefficients d'écart-type** configurables : `score = mean + k·stdev`,
avec `k_S`, `k_A`, `k_B` réglables (au lieu d'être figés à 1.0 / 0.0 / -1.0). Avec les valeurs par
défaut, le comportement est strictement identique à l'ancien système — aucune régression tant que
personne ne touche au réglage.

**Important, corrigé après la première livraison** : dans l'admin, les 3 champs numériques
(`tierInputS/A/B`) et l'étiquette affichent maintenant la valeur **en σ** (`k_s/k_a/k_b`, l'unité
réellement stockée en base), alors que la première version les affichait en score TrueSkill brut
(l'axe du graphique). Seules les lignes/poignées du graphique restent en score brut, puisque c'est
l'axe réel de la distribution du jour — la conversion σ ↔ score se fait dans `tier_thresholds.js`
via `mean`/`stdev` reconstruits depuis la courbe reçue du backend.

### A.2 — Fichiers modifiés

**Backend**
- [`backEnd/constants.py`](../backEnd/constants.py) : `DEFAULT_TIER_K_S/A/B` = 1.0 / 0.0 / -1.0.
- [`backEnd/schema.sql`](../backEnd/schema.sql) +
  [`backEnd/migrations/2026-09-13_add_tier_thresholds.sql`](../backEnd/migrations/2026-09-13_add_tier_thresholds.sql) :
  3 nouvelles clés dans `configuration` (`tier_k_s`, `tier_k_a`, `tier_k_b`).
- [`backEnd/services.py`](../backEnd/services.py) : `tier_thresholds()`, `tier_for_score()` acceptent
  `k_s/k_a/k_b` en paramètres optionnels (défauts rétrocompatibles) ; `recalculate_tiers()` lit les
  3 clés de config en une requête groupée avec `sigma_threshold`.
- [`backEnd/routes_public.py`](../backEnd/routes_public.py) : `/tier-seuils` (consommée par
  `classement.html` public) lit désormais les coefficients configurés — le graphique public suit le
  réglage admin au lieu de rester figé sur l'ancien calcul.
- [`backEnd/routes_admin.py`](../backEnd/routes_admin.py) :
  - `GET /admin/config` expose `tier_k_s/a/b`.
  - `POST /admin/config` valide que les 3 clés arrivent **groupées** et que **S > A > B** (400
    sinon), les persiste sous la permission `gestion_config`, déclenche `recalculate_tiers()`
    immédiatement (comportement déjà existant sur cette route, réutilisé tel quel).
  - Nouvelle route `GET /admin/config/tier-distribution` (gate `gestion_config`) : renvoie
    `build_distribution()` sur les joueurs **rankés actuels** (même population que
    `recalculate_tiers()`) — sert de preview fidèle au tableau de l'admin.

**Frontend**
- [`frontEnd/frontend.py`](../frontEnd/frontend.py) : route proxy `GET /admin/config/tier-distribution`.
- [`frontEnd/templates/admin_reglages.html`](../frontEnd/templates/admin_reglages.html) : nouveau
  bloc carte « Seuils de tiers » (Chart.js + 3 champs `σ` + bouton Réinitialiser + bouton
  Enregistrer), gaté par `peut('gestion_config')` comme le reste de la page.
- [`frontEnd/static/js/tier_thresholds.js`](../frontEnd/static/js/tier_thresholds.js) (nouveau
  fichier) : charge la distribution + la config, dessine courbe/joueurs/zones (Chart.js, plugin
  personnalisé repris du pattern de `classement.html`), gère le **drag** (souris et tactile) des 3
  lignes de seuil avec contrainte d'ordre S > A > B, synchronise les champs numériques en σ dans les
  deux sens, recalcule en direct (côté client, avant tout enregistrement) le tier affiché de chaque
  joueur du graphique, convertit σ → score pour l'affichage et score → σ à la sauvegarde.

### A.3 — Tests

- [`backEnd/tests/test_tier_thresholds.py`](../backEnd/tests/test_tier_thresholds.py) (nouveau,
  27 assertions, toutes vertes) : non-régression des valeurs par défaut, effet des coefficients
  personnalisés, refus si les 3 clés n'arrivent pas groupées, refus si l'ordre S > A > B n'est pas
  respecté, permission `gestion_config` (403 sinon), recalcul immédiat déclenché après écriture,
  lecture des coefficients par `recalculate_tiers()`, route de preview (200/403, filtrage sur les
  joueurs rankés).
- Suites existantes (`test_scission_permissions.py` 34/34, `test_bascule.py` 18/18) : toujours
  vertes, aucune régression détectée.
- **Limite connue** : tests exécutés via le banc d'essai maison (curseur simulé, `harness.py`),
  sans Postgres réel — le SQL n'a pas été validé contre une vraie base (migration comprise). À
  vérifier une fois en local/CI avant mise en production.

---

## Partie B — Tiers dynamiques (Phase 4, à concevoir puis implémenter)

### B.1 — Objectif

Remplacer les 4 tiers fixes (S/A/B/C, plus le cas spécial U) par une liste de tiers **entièrement
gérée par l'admin** : ajout, suppression, renommage, changement de couleur, réglage du seuil (en σ)
et de l'ordre (rang), le tout depuis le même écran que le tableau de la Partie A — avec un bouton
« Réinitialiser » qui restaure exactement la configuration S/A/B/C d'aujourd'hui.

### B.2 — Modèle de données

Nouvelle table, en remplacement progressif du quadruplet actuel S/A/B/C :

```sql
CREATE TABLE public.tiers (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(10) NOT NULL,          -- libre, 1-10 caractères (ex: "S", "GM", "Bronze")
    couleur VARCHAR(20) NOT NULL,      -- ex: '#f77b7b'
    seuil_k DOUBLE PRECISION,          -- NULL pour le plancher (rang le plus bas, pas de seuil bas)
    rang INTEGER NOT NULL              -- ordre explicite, décroissant = du meilleur au pire
);
```

Points à trancher précisément à l'implémentation :
- **Unicité** : `rang` unique (contrainte ou renumérotation systématique après chaque
  ajout/suppression/réordonnancement, pour éviter les trous et les doublons).
- **Le plancher est dérivé** : `seuil_k IS NULL` seulement pour le tier au rang le plus bas de la
  table. Si ce tier est supprimé, le nouveau tier de plus petit rang perd (ou n'a jamais eu besoin
  de) son `seuil_k` — logique à écrire une seule fois côté backend (jamais dans le front) pour
  éviter deux implémentations qui divergent.
- **`Joueurs.tier`** est aujourd'hui `character(1)`. Passer à `VARCHAR(10)` (migration simple,
  `ALTER TABLE ... ALTER COLUMN tier TYPE VARCHAR(10)`) pour accueillir un nom multi-caractères.
  Question ouverte : `Joueurs.tier` référence-t-il `tiers.nom` (texte libre, comme aujourd'hui,
  robuste à la suppression d'un tier — un joueur garde son étiquette même si le tier est supprimé
  entre-temps, jusqu'au prochain `recalculate_tiers()`) ou `tiers.id` (FK stricte, orpheline à gérer
  explicitement si le tier est supprimé) ? Recommandation : garder le texte libre par cohérence
  avec le comportement actuel (`recalculate_tiers()` réattribue de toute façon un tier à chaque
  joueur ranké à chaque appel, donc pas de risque de référence pendante durable).
- **`U`** : reste un cas câblé en dur dans le code (pas une ligne de la table `tiers`), avec ses
  règles déjà existantes inchangées (`has_tier()`, `IP_V2_REF_REQUIRE_TIER`, valeur par défaut à la
  création d'un joueur).

### B.3 — Backend

- `services.py` :
  - `tier_for_score(score, mean, stdev, tiers)` : parcourt la liste des tiers **par rang
    décroissant**, renvoie le premier dont `score > mean + seuil_k*stdev` (le tier de plus petit
    rang, `seuil_k IS NULL`, est le fallback si aucun autre ne matche).
  - `tier_thresholds()` devient probablement `tiers_avec_seuils_calcules()` ou équivalent — la forme
    de retour change (liste ordonnée d'objets `{nom, couleur, seuil_score}` plutôt que
    `{"S":.., "A":.., "B":.., "C":0}` figé), ce qui **impacte tous les appelants** (`classement.html`,
    `recap.html`, la route `/tier-seuils`) : à migrer ensemble, pas en un patch isolé, pour ne pas
    casser l'affichage public entre deux déploiements.
  - `recalculate_tiers()` : charge la table `tiers` (une requête) au lieu des 3 clés `tier_k_*`.
  - `build_distribution()` : les couleurs des points ne viennent plus d'une palette JS en dur
    (`COLORS = {S:.., A:.., ...}`) mais de la couleur du tier assigné, à transmettre depuis le
    backend ou recalculer côté front à partir de la même table.
- `routes_admin.py` — nouvelles routes CRUD, sous `gestion_config` (cohérent avec le reste des
  réglages TrueSkill) :
  - `GET /admin/tiers` : liste ordonnée par rang.
  - `POST /admin/tiers` : création (nom, couleur, seuil_k, position d'insertion).
  - `PUT /admin/tiers/<id>` : renommage / recoloration / changement de seuil.
  - `PUT /admin/tiers/reorder` (ou champ `rang` dans le PUT ci-dessus) : changement d'ordre —
    prévoir un payload qui envoie l'ordre complet plutôt que des rangs individuels, pour éviter les
    états incohérents pendant un réordonnancement partiel.
  - `DELETE /admin/tiers/<id>` : suppression, avec le recalcul de plancher décrit en B.2 ; refuser
    la suppression du dernier tier restant (il en faut au moins un).
  - `POST /admin/tiers/reset` : restaure exactement S/A/B/C avec les seuils par défaut de la
    Partie A (1.0 / 0.0 / -1.0 / plancher) — le bouton « Réinitialiser » demandé.
  - Chaque écriture déclenche `recalculate_tiers()` immédiatement, comme pour `/admin/config`
    aujourd'hui.
- Migration SQL : création de `tiers`, seed avec les 4 lignes S/A/B/C (seuils 1.0/0.0/-1.0/NULL,
  rangs 3/2/1/0 ou équivalent), `ALTER TABLE Joueurs ALTER COLUMN tier TYPE VARCHAR(10)`.

### B.4 — Frontend

- Le tableau de la Partie A garde son rôle de **preview visuel** (courbe + points + lignes
  glissables), mais les lignes deviennent **dynamiques en nombre** — plus seulement 3 : le plugin
  Chart.js (`tierLinesPlugin` dans `tier_thresholds.js`) doit itérer sur la liste des tiers reçue du
  backend plutôt que sur `S/A/B` en dur.
- Nouveau panneau (au-dessus ou à côté du graphique) pour la gestion de la **liste** : une ligne par
  tier avec son nom (éditable), sa couleur (color picker), son seuil en σ (nombre, désactivé pour le
  plancher), des boutons monter/descendre ou glisser-déposer pour le rang, un bouton supprimer, et
  un bouton « + Ajouter un tier ».
- Bouton « Réinitialiser » : remplace l'actuel (qui ne remettait que k_S/A/B à 1/0/-1) par un appel
  à `POST /admin/tiers/reset`, avec confirmation (`confirm()`) puisque l'opération est destructive
  pour toute personnalisation en cours.
- `getTierColor()` (`gestion.js`, utilisé par les fiches joueurs) et les classes CSS `tier-s/a/b/c`
  en dur (`animations.css`, `classement.html`, `gestion_joueurs.html`, `stats_joueur.html`) doivent
  passer d'un mapping figé à une couleur **portée par les données** (renvoyée par le backend avec
  chaque joueur, ou récupérée via `GET /admin/tiers`/une route publique équivalente) — sinon un
  tier renommé ou ajouté n'aura pas de couleur cohérente ailleurs dans le site.

### B.5 — Points de vigilance identifiés (à ne pas découvrir en cours de route)

1. **Portée large du changement** : la Partie A a pu réutiliser `build_distribution` et le pattern
   Chart.js de `classement.html` presque tel quel parce que S/A/B/C restaient fixes. La Phase 4 touche
   en revanche tout endroit du code qui suppose une lettre unique ou une liste figée de 4 tiers —
   recensement non exhaustif fait le 13/09 : `animations.css`, `classement.html`,
   `gestion_joueurs.html`, `stats_joueur.html` (CSS `tier-s/a/b/c`), `gestion.js` (`getTierColor`),
   `services.py`/`routes_admin.py`/`routes_public.py` (logique de calcul et d'affichage). Un audit
   exhaustif est nécessaire avant de coder, pas seulement au moment de la revue.
2. **Cohérence pendant la migration** : le passage d'un tier fixe à un tier texte-libre change la
   forme de plusieurs réponses API (`tier_thresholds` notamment) — bascule à faire en un seul
   déploiement cohérent front+back, pas en deux temps, sous peine d'un état intermédiaire cassé.
3. **`U` reste hors du système éditable** : bien vérifier à l'implémentation qu'aucune route CRUD
   nouvelle ne permet, même indirectement (ex. un nom de tier saisi `"U"` par l'admin), de créer un
   doublon ou un conflit avec le sentinel `U` déjà câblé en dur.
4. **Historique et récaps figés** ([[refactor-historique-recaps-plan]]) : un récap déjà généré
   contient des tiers assignés à un instant T. Si les tiers eux-mêmes (pas seulement leurs seuils)
   deviennent supprimables/renommables, un récap historique qui référence un tier depuis supprimé
   doit rester lisible — probablement en gardant le nom textuel tel quel (cohérent avec la
   recommandation de B.2 sur `Joueurs.tier` en texte libre), à confirmer avec l'utilisateur au
   moment de cette phase.

### B.6 — Découpage proposé (suivi tel quel à l'implémentation)

1. Migration + modèle backend (table `tiers`, seed S/A/B/C, `tier_for_score`/`tier_thresholds`
   généralisés, `recalculate_tiers` mis à jour) — sans toucher au frontend, avec tests de
   non-régression garantissant un comportement identique à la Partie A tant que la table contient
   encore exactement S/A/B/C.
2. Routes CRUD `/admin/tiers` (+ `/reset`) côté backend, testées isolément.
3. Frontend : panneau de gestion de la liste + généralisation du graphique existant à un nombre
   variable de tiers.
4. Propagation de la couleur dynamique aux autres pages (classement, fiches joueurs, stats) qui
   affichent aujourd'hui un tier avec une couleur figée en CSS.

### B.7 — Ce qui a été livré (13/09/2026, même jour que la conception)

Les 4 étapes de B.6 ont été implémentées et testées dans la foulée de la validation du cadrage.

**Modèle de données**
- [`backEnd/migrations/2026-09-13_add_tiers_table.sql`](../backEnd/migrations/2026-09-13_add_tiers_table.sql) :
  table `tiers` (nom, couleur, seuil_k, rang), seed S/A/B/C identique aux valeurs par défaut de la
  Partie A, élargissement de `Joueurs.tier` et `grille_snapshots.tier` de `character(1)` à
  `VARCHAR(10)`, suppression des clés `tier_k_s/a/b` (remplacées par cette table).
  [`backEnd/schema.sql`](../backEnd/schema.sql) mis à jour en parallèle pour une base neuve.
- [`backEnd/constants.py`](../backEnd/constants.py) : `DEFAULT_TIERS` (liste de dicts) remplace
  `DEFAULT_TIER_K_S/A/B` — sert de secours si la table est vide et de cible au reset.

**Backend**
- [`backEnd/services.py`](../backEnd/services.py) : nouvelle fonction `load_tiers(cur)` (lit la
  table, retombe sur `DEFAULT_TIERS` si vide) ; `tier_thresholds()` et `tier_for_score()` prennent
  désormais une liste de tiers triée par rang décroissant au lieu de 3 coefficients nommés —
  fonctionnent pour un nombre quelconque de tiers ; `recalculate_tiers()` charge la liste via
  `load_tiers()`.
- [`backEnd/routes_public.py`](../backEnd/routes_public.py) : `/tier-seuils` renvoie désormais une
  **liste** ordonnée (nom, couleur, rang, seuil calculé) au lieu d'un objet figé `{"S":..}` ; le
  filtre `?tier=` de `/classement` valide contre les noms réellement présents en base plutôt que
  contre `('S','A','B','C')` en dur ; `/stats/joueurs` compte les tiers dynamiquement.
- [`backEnd/routes_admin.py`](../backEnd/routes_admin.py) : CRUD complet sous `gestion_config` —
  `GET /admin/tiers` (lecture, ouverte à toute session comme `get_config`), `POST /admin/tiers`
  (création, validation nom 1-10 caractères + `U` réservé + couleur hex + unicité, renvoie l'id
  créé), `PUT /admin/tiers/<id>` (renommage/couleur/seuil, refuse un seuil sur le plancher),
  `DELETE /admin/tiers/<id>` (refuse de vider la table, renumérote les rangs, promeut
  automatiquement le nouveau plancher via `_appliquer_plancher`), `PUT /admin/tiers/reorder`
  (reçoit l'ordre complet, passe par des rangs temporaires négatifs pour éviter tout conflit avec
  la contrainte `UNIQUE` sur `rang` pendant la bascule), `POST /admin/tiers/reset` (restaure
  `DEFAULT_TIERS`). Chaque écriture déclenche `recalculate_tiers()` immédiatement. `get_config()`
  et `update_config()` ne portent plus `tier_k_s/a/b`.

**Frontend**
- [`frontEnd/frontend.py`](../frontEnd/frontend.py) : routes proxy `/admin/tiers` (GET/POST),
  `/admin/tiers/<id>` (PUT/DELETE), `/admin/tiers/reorder`, `/admin/tiers/reset` ; la route
  `/classement` construit `tiers_couleurs` (dict nom→couleur) et le passe au template ; même chose
  pour `_rendre_fiche_joueur()` (fiche joueur) et `stats_joueurs()` (liste des stats).
- [`frontEnd/static/js/tier_thresholds.js`](../frontEnd/static/js/tier_thresholds.js) : réécrit
  pour un nombre variable de tiers — le graphique (courbe, zones, lignes glissables) itère sur la
  liste reçue au lieu de S/A/B fixes ; nouveau panneau tableau (`tiersListBody`) où chaque tier se
  renomme, se recolore (`<input type="color">`), règle son seuil en σ, se réordonne (boutons
  haut/bas) et se supprime, avec un bouton d'ajout et un bouton Réinitialiser
  (`POST /admin/tiers/reset`, confirmation demandée) ; l'enregistrement (`saveTiers()`) diffe l'état
  local contre l'état serveur (suppressions, créations avec récupération de l'id réel, mises à
  jour) puis réordonne explicitement.
- [`frontEnd/templates/admin_reglages.html`](../frontEnd/templates/admin_reglages.html) : le bloc
  « Seuils de tiers » devient « Tiers », avec le tableau de gestion sous le graphique.
- Couleurs dynamiques propagées à
  [`frontEnd/templates/classement.html`](../frontEnd/templates/classement.html) (onglets, légende
  de seuils, badge de tier, lignes du graphique — tout généré depuis `tiers`/`tiers_couleurs`),
  [`frontEnd/templates/stats_joueur.html`](../frontEnd/templates/stats_joueur.html) et
  [`frontEnd/templates/stats_joueurs.html`](../frontEnd/templates/stats_joueurs.html) (badge de
  tier), [`frontEnd/templates/gestion_joueurs.html`](../frontEnd/templates/gestion_joueurs.html)
  (légende, peuplée par la nouvelle fonction `loadTierLegend()` dans
  [`frontEnd/static/js/gestion.js`](../frontEnd/static/js/gestion.js)) ; `getTierColor()` dans le
  même fichier ne renvoie plus une classe CSS figée mais `{class, style}` avec la couleur du tier
  en style inline, via un cache `tiersColorCache` chargé une fois par page.
- [`frontEnd/static/css/animations.css`](../frontEnd/static/css/animations.css) : les 4 règles
  `.tag.tier-s/a/b/c` (dégradés figés) remplacées par une seule règle `.tag.tier-tag` (habillage
  commun : texte blanc, relief léger), la couleur de fond étant désormais posée en style inline par
  tier.

**`U` reste hors du système éditable**, comme décidé : `_nom_tier_valide()` refuse explicitement ce
nom (insensible à la casse) à la création et au renommage, côté backend ET dans la validation JS du
panneau (`validerAvantEnvoi()`) avant l'envoi.

**Tests** — [`backEnd/tests/test_tier_thresholds.py`](../backEnd/tests/test_tier_thresholds.py),
entièrement réécrit pour le nouveau modèle : 54 assertions couvrant la non-régression du seed par
défaut, la généralisation à un nombre quelconque de tiers (test à 5 tiers dont un plancher renommé),
le CRUD complet (validations, permissions, recalcul immédiat après chaque écriture), les invariants
du plancher après suppression/reorder, et la route de preview. Les suites existantes
(`test_scission_permissions.py` 34/34, `test_bascule.py` 18/18, `test_sous_permissions.py` 59/59)
restent toutes vertes — aucune régression.

### B.8 — Correctif de recette (13/09, après test manuel de l'utilisateur)

Premier essai en conditions réelles : le glissé sur le graphique ne déplaçait **que le tier S** quel
que soit l'endroit cliqué, et l'enregistrement était refusé comme invalide.

**Cause racine** : `load_tiers()` sélectionnait `nom, couleur, seuil_k, rang` — **sans `id`**. La
route `GET /admin/tiers` renvoyait donc des tiers dépourvus d'identifiant, et côté navigateur :
- `nearestHandle()` renvoyait `undefined` au lieu d'un id, et `onDown` ne testait que `=== null` —
  le glissé démarrait donc toujours, sur `draggingId = undefined` ;
- `tiersState.find(t => t.id === draggingId)` faisait correspondre le **premier** tier de la liste
  (tous les `undefined` sont égaux entre eux), d'où « seul S bouge » ;
- à l'enregistrement, `t.id < 0` était faux pour `undefined`, donc chaque tier partait en
  `PUT /admin/tiers/undefined` ; pire, `idsConserves` se retrouvait vide, ce qui aurait fait
  supprimer toute la table si les requêtes avaient abouti.

Les tests backend ne l'avaient pas vu parce qu'ils n'assertaient que sur `nom` et que le plan du
faux curseur reproduisait l'ancienne requête, sans `id`.

**Corrections apportées**
- `load_tiers()` sélectionne et expose `id` ; le fallback `DEFAULT_TIERS` porte `id: None` explicite
  (copie, sans muter la constante).
- Le front identifie désormais la ligne glissée par son **index** (`draggingIdx`, `-1` si aucune) et
  non par un id qui peut manquer — un tier ajouté non encore enregistré n'a légitimement pas d'id.
- `estIdServeur()` centralise le test « existe en base » (`number` fini et `> 0`) ; un tier ajouté
  porte `id: null` au lieu d'un id négatif bricolé.
- `saveTiers()` s'interrompt explicitement si le serveur renvoie des tiers sans id, au lieu de les
  interpréter comme « à supprimer ».
- Pendant un glissé, le tableau n'est plus reconstruit à chaque `mousemove` (`redrawPendantDrag()`
  ne rafraîchit que le champ concerné) : la version précédente détruisait le focus et la saisie en
  cours à chaque pixel.
- `validerAvantEnvoi()` signale désormais quel tier pose problème et avec quelles valeurs, au lieu
  d'un message générique, et refuse un seuil manquant sur un tier qui n'est pas le plancher.

**Tests ajoutés** (vérifiés comme échouant si l'on réintroduit le défaut) : chaque tier renvoyé par
`GET /admin/tiers` porte un `id` entier issu de la base, le fallback porte `id: None` sans muter
`DEFAULT_TIERS`, et `load_tiers()` remonte bien l'id de chaque ligne.

#### Second correctif — « Le tier plancher n'a pas de seuil bas »

Symptôme suivant, sur le même écran : avec S/A/B/C en base, ajouter un tier « D » sous le plancher
(et donner un seuil à C, qui n'est donc plus le plancher) était refusé à l'enregistrement.

**Cause** : `update_tier()` refusait tout `seuil_k` sur le tier ayant `MIN(rang)` *en base*. Or le
panneau envoie ses `PUT` **avant** le `/reorder` final : au moment du `PUT` sur C, la base le voit
encore comme plancher, alors qu'il ne l'est plus dans l'intention de l'admin. Chaque requête était
ainsi validée contre un état intermédiaire nécessairement incohérent, et l'erreur interrompait la
séquence avant même le `POST` de D.

**Corrections**
- `update_tier()` accepte `seuil_k` sans regarder qui est plancher (et accepte `null` explicite,
  écrit comme un vrai `NULL` SQL et non la chaîne `"None"`), puis rejoue `_appliquer_plancher()` :
  l'invariant est rétabli *en fin d'opération* plutôt qu'imposé à chaque étape.
- `_appliquer_plancher()` tenait sa promesse à moitié — elle effaçait le seuil du rang le plus bas
  mais n'en donnait jamais à un ancien plancher promu, qui serait resté inatteignable par
  `tier_for_score()` et affiché comme un second « plancher ». Elle applique désormais les deux sens.
- Côté front, `saveTiers()` transmet toujours `seuil_k` (`null` pour le plancher) au lieu de
  l'omettre, sans quoi un tier promu gardait un seuil vide après réordonnancement.

**Tests ajoutés** : donner un seuil au tier de rang le plus bas renvoie 200 (et non plus 400),
`seuil_k: null` écrit bien `NULL`, et `_appliquer_plancher()` est couverte dans ses deux sens. Le
scénario complet de la capture (PUT sur C → POST de D → reorder) a été rejoué de bout en bout.
Suite portée à 67 assertions.

#### Troisième correctif — glissé à la souris décalé (14/09)

Symptôme : les lignes de seuil restaient difficiles voire impossibles à attraper à la souris.

**Cause** : `pixelXFromEvent()` calculait `clientX - rect.left`, c'est-à-dire une coordonnée dans le
repère **écran**, puis la comparait aux positions rendues par `scales.x.getPixelForValue()`, qui sont
dans le repère **interne du canvas**. Les deux diffèrent dès que le layout redimensionne le canvas
(taille CSS ≠ attribut `width`). Simulé avec un canvas rendu à 860 px pour 700 px affichés :

| tier | px (rendu) | px vu à l'écran | résultat du clic |
|------|-----------:|----------------:|------------------|
| S    | 615,7      | 501,1           | attrape **A**    |
| A    | 496,4      | 404,0           | rien (20 px)     |
| B    | 383,6      | 312,2           | rien (51 px)     |
| C    | 261,7      | 213,0           | rien (49 px)     |

Et lorsqu'une ligne était malgré tout saisie, la valeur sautait immédiatement (−7,1 sur l'exemple).

**Corrections**
- `pixelXFromEvent()` passe par `Chart.helpers.getRelativePosition(evt, chart)`, l'API officielle
  qui gère le ratio rendu/CSS et le `devicePixelRatio`, avec un repli manuel appliquant
  `canvas.width / rect.width` si l'API venait à changer.
- Tolérance d'accroche portée de 10 à 18 px : viser un trait de 2 px est pénible, et la valeur reste
  ajustable au clavier dans le tableau.
- L'écart minimal entre deux lignes voisines (`clampToNeighbors`) n'est plus un epsilon numérique
  (`1e-6`, qui laissait deux lignes se superposer à l'écran et devenir inséparables au clic) mais
  6 px convertis en unités de score.
- Le redessin pendant le glissé passe par `requestAnimationFrame` : un `mousemove` peut arriver
  plusieurs fois par frame, et `chart.update()` à chaque fois faisait saccader le déplacement.

Vérifié hors navigateur sur la géométrie simulée : chaque ligne s'attrape là où elle est affichée
(écart 0,00 px), un clic à 12 px de côté fonctionne, et deux lignes poussées l'une contre l'autre
restent distinctes et sélectionnables séparément.

#### Quatrième correctif — classement corrompu après enregistrement (14/09)

Symptôme : l'enregistrement semblait réussir, mais le classement public partait de travers, un tier
(l'avant-dernier) semblait disparaître, et le tableau de réglages revenait mélangé. La capture
montrait le tier « C » avec un seuil de **1.000**, alors qu'il devait valoir −1,5.

**Cause — deux défauts qui se combinaient**, tous deux introduits par le correctif précédent :

1. `_appliquer_plancher()` **inventait des valeurs** : tout tier sans seuil qui n'était plus le
   plancher recevait d'office `voisin + 1.0`. Une fonction de réparation ne doit jamais fabriquer
   une donnée que l'utilisateur n'a pas saisie — ici elle propulsait le tier au milieu du classement.
2. Elle était rejouée **après chaque `PUT`**, donc pendant la séquence d'enregistrement : au moment
   du `PUT` sur C, celui-ci était encore le plancher en base, et le seuil tout juste écrit était
   effacé. Au `reorder` final, C n'avait donc plus de seuil et héritait du `1.0` fabriqué.

Séquence reproduite à l'identique :

```
PUT C seuil_k=-1.5   -> efface aussitot (C encore plancher en base)
POST D               -> insere au rang max+1 (au sommet)
reorder [S,A,B,C,D]  -> C sans seuil recoit 1.0   <<< corrompu
FINAL : S=1.5  A=0.5  B=-0.5  C=1.0  D=None
```

**Corrections**
- `_appliquer_plancher()` se limite à effacer le seuil du tier de plus petit rang. Elle n'attribue
  plus jamais de valeur : un tier promu reçoit la sienne du `PUT` correspondant.
- `update_tier()` ne rejoue plus l'invariant : c'est `/reorder`, qui connaît l'ordre final, qui s'en
  charge.
- `saveTiers()` envoie désormais le **reorder avant les PUT** : suppressions → créations → reorder →
  seuils. Chaque `PUT` porte ainsi sur un tier déjà à sa place définitive, et aucun n'est plus
  interprété comme plancher à tort.

**Tests** : les deux assertions qui verrouillaient l'ancien comportement (« un tier promu reçoit un
seuil ») ont été remplacées par leur contraire — aucune valeur n'est inventée, et la fonction ne lit
que le tier de plus petit rang. Vérifiées comme échouant si l'on réintroduit le défaut. Quatre
scénarios rejoués de bout en bout (ajout d'un plancher, suppression d'un tier intermédiaire,
suppression du plancher, inversion de deux tiers) : dans chacun, les seuils saisis sont préservés,
restent strictement décroissants, et le plancher est bien le dernier tier. Suite à 68 assertions.

**Limite connue** — même remarque qu'en Partie A : tests exécutés via le banc d'essai maison
(curseur simulé, sans Postgres réel). Le SQL n'a pas été validé contre une vraie base — notamment la
migration (élargissement de colonnes, contrainte `UNIQUE` sur `rang`) et les requêtes `execute_values`.
À vérifier une fois en local/CI avant mise en production.

---

## Statut

- **Partie A (Phases 1-3)** : ✅ livré, testé, non commité (l'utilisateur commit lui-même).
- **Partie B (Phase 4, tiers dynamiques)** : ✅ livré et testé le 13/09/2026 (voir §B.7), non
  commité. Le découpage en 4 étapes du §B.6 a été suivi tel quel.
