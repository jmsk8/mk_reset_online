# Mode admin & hiérarchie des rôles — avancement

> Suivi de chantier. La conception, les décisions et le registre des risques vivent dans
> [hierarchie-admin-plan.md](hierarchie-admin-plan.md) ; **ce fichier-ci ne dit que ce qui est
> fait, ce qui a été trouvé en chemin, et ce qui reste**. Les codes `R-xx` renvoient au §7 du plan
> (numérotation continue depuis [auth-discord-plan.md](auth-discord-plan.md)).
>
> **Dernière mise à jour : 2026-09-22** — état recalé sur le code : journal des actions admin
> **terminé** (Chantier 7, phase 4 livrée le 22/09, non commitée), tests des onglets soldés (Chantier 8), catalogue passé à
> 15 permissions avec la fiche joueur « un droit par geste » (Chantier 9). Les sections datées
> plus bas décrivent l'état **à leur date**.
>
> Passage précédent : 2026-09-14, règle de rang générique (Chantier 6).
>
> Documents liés : [hierarchie-admin-plan.md](hierarchie-admin-plan.md) (le modèle) ·
> [onglets-admin-plan.md](onglets-admin-plan.md) (les 7 onglets, livré) ·
> [permissions-onglets-contexte.md](permissions-onglets-contexte.md) (contexte de reprise et
> sujets ouverts) · [auth-discord-avancement.md](auth-discord-avancement.md) (la couche
> d'authentification en dessous).

## Où on en est

| Chantier | État | Contenu |
|---|---|---|
| **1** — Hiérarchie à 4 rôles + permissions | ✅ livré le 2026-09-10 | 6 phases, migration appliquée, 99 assertions |
| **2** — Réorganisation des 7 onglets | ✅ livré le 2026-09-10 | pages dédiées, menu réordonné |
| **3** — Session Discord expirée | ✅ livré le 2026-09-13 | revalidation des deux voies, 19 assertions |
| **4** — Scission des permissions | ✅ livré le 2026-09-13 | 9 permissions, 3 contournements fermés, 34 assertions |
| **5** — Sous-permission RGPD | ✅ livré le 2026-09-13 | `rgpd_joueurs`, mécanique parent/enfant, 26 assertions |
| **6** — Règle de rang générique (8.1) | ✅ livré le 2026-09-14 | lacune fermée, matrice 4×4, 149 assertions |
| **7** — Journal des actions admin | ✅ **terminé** — phases 1 à 3 (18-19/09), phase 4 (22/09, non commitée) | [audit-admin-plan.md](audit-admin-plan.md) §5 |
| **8** — Tests des 3 routes d'onglets (8.3) | ✅ soldé le 2026-09-18 | gate sur les trois onglets, gate par bloc, 71 assertions dans `test_session_expiree.py` |
| **9** — Fiche joueur : un droit par geste | ✅ livré le 2026-09-17 | 6 sous-permissions de `gestion_joueurs`, `rgpd_joueurs` → `joueurs_irreversible` |

Tout ce qui précède est **commité** (dernier en date : `025af10`, 19/09). L'utilisateur fait ses
commits lui-même.

---

## Le modèle en vigueur

Quatre rôles strictement ordonnés dans `comptes.role` :

| Rôle | Niveau | Ce qu'il peut |
|---|---|---|
| `player` | 0 | rien d'administratif |
| `admin` | 1 | **rien par défaut** — uniquement les permissions nommées qu'on lui accorde |
| `chef_admin` | 2 | tout le catalogue délégable + les capacités de rôle |
| `superadmin` | 3 | tout, y compris les jetons de bot. **Unique à tout instant** |

**Deux façons d'autoriser, à ne jamais confondre :**

- **Capacité de rôle** — câblée en dur via `@role_required(...)`, **jamais délégable** : purge
  RGPD, annulation de tournoi, jetons de bot, changement de rôle, legs du superadmin. Ce n'est pas
  une case décochée, c'est un pouvoir absent du système de permissions.
- **Permission déléguable** — une entrée de `PERMISSIONS_CATALOGUE`, vérifiée par
  `@permission_required(...)`, qu'un `chef_admin` ou le `superadmin` accorde à un `admin`.

### Le catalogue — 15 permissions (depuis le 2026-09-17)

```
gestion_joueurs   gestion_tournois   gestion_ligues       gestion_saisons
gestion_liaisons  gestion_comptes    gestion_invitations
gestion_config    gestion_matchmaking
  └─ sous-permissions de gestion_joueurs, un droit par geste :
     joueurs_creation  joueurs_nom  joueurs_couleur  edition_mu_sigma
     joueurs_statut    joueurs_irreversible  (ex-rgpd_joueurs, renommée le 17/09)
```

Depuis le 17/09, `gestion_joueurs` seul n'ouvre que la **lecture** de l'onglet Fiches joueurs.
Détail et motif : §8.8 de [permissions-onglets-contexte.md](permissions-onglets-contexte.md).

Défini dans `backEnd/constants.py`, **dupliqué** dans `frontEnd/frontend.py` — le frontend est un
service séparé qui ne peut pas l'importer. Les deux listes doivent rester alignées, un test le
vérifie.

### Sous-permissions

`SOUS_PERMISSIONS` (`constants.py`) déclare `enfant -> parent`. Une entrée signifie que la
permission **ne vaut rien seule** : la route protégée exige l'enfant **et** le parent. La règle
tient à trois endroits, et chacun est nécessaire :

| Où | Ce qui est garanti |
|---|---|
| `permission_required` / `compte_a_permission` | la route exige les deux — c'est là que la règle est **appliquée** |
| `accorder_permission` | accorder l'enfant sans le parent est refusé (409 `parent_manquant`), vérifié **dans** la transaction après le `FOR UPDATE` |
| `retirer_permission` | retirer le parent **emporte ses enfants** dans la même requête, et l'audit le consigne |

Le troisième point n'est pas cosmétique : une sous-permission orpheline ne donne aucun droit, mais
elle resterait cochée et **reviendrait à la vie au prochain re-octroi du parent** — un droit rendu
sans que personne ne l'ait décidé.

Côté interface, la sous-permission s'affiche **en retrait sous son parent** (décalage + liseré),
sa case est inactive tant que le parent n'est pas accordé (avec le tag « nécessite *parent* »
plutôt qu'une case inerte), et décocher le parent décoche l'enfant sans rechargement.

### Répartition réelle des décorateurs (2026-09-13)

```
permission_required : gestion_saisons 6 · gestion_comptes 6 · gestion_joueurs 5 ·
                      gestion_liaisons 3 · gestion_invitations 3 · gestion_ligues 2 ·
                      gestion_config 2 · gestion_tournois 1 · gestion_matchmaking 1
role_required       : CHEF_ADMIN 9 · SUPERADMIN 5 · ADMIN 3
```

Plus aucun `@admin_or_role_required` : la bascule vers Discord est terminée dans les faits (voir
Chantier 3).

---

## Chantier 1 — Hiérarchie à 4 rôles ✅ 2026-09-10

Les 6 phases du plan sont livrées. Migration `2026-09-10_hierarchie_admin.sql` **appliquée**
(table `permissions_admin` + index unique partiel sur le superadmin).

**Backend** — `permission_required`, `compte_cible_protegee`, `permissions_delegables_par`,
`refuse_auto_modification` (`auth.py`) · `ROLE_CHEF_ADMIN`, `PERMISSIONS_CATALOGUE`
(`constants.py`) · routes d'octroi/retrait/lecture des permissions et legs du superadmin
(`routes_comptes.py`) · 38 routes converties.

**Frontend** — `_role_session()`, `_permissions_session()`, helper `peut('nom_permission')` exposé
aux templates, panneau de permissions par compte dans `admin_comptes.html`.

**Tests** — `test_permissions.py` (23) et `test_hierarchie_routes.py` (76).

### Les garanties qui tiennent le modèle

- **Pas de cache de rôle ni de permissions.** `_charger_compte_session` les relit **en base à
  chaque requête protégée**. C'est ce qui donne son sens à l'intouchabilité du superadmin et au
  plafond de délégation : un droit retiré prend effet immédiatement, pas à l'expiration de la
  session.
- **Le legs est la seule sortie du rôle superadmin** — l'auto-modification de rôle est interdite,
  y compris pour lui. Deux routes distinctes pour préserver l'atomicité (6bis.1 du plan).
- **R-53** — `changer_role` purge `permissions_admin` dès qu'un compte quitte le rôle `admin` :
  sans ça, un compte rétrogradé puis re-promu récupérerait silencieusement ses anciens droits.

---

## Chantier 2 — Les 7 onglets ✅ 2026-09-10

Des **pages** et non des onglets JavaScript. Détail dans
[onglets-admin-plan.md](onglets-admin-plan.md) §6bis.

| # | Onglet | URL | Gate du menu |
|---|---|---|---|
| 1 | Gestion tournois | `/admin/tournois` | `peut('gestion_tournois')` |
| 2 | Réglage TS | `/admin/reglages` | `peut('gestion_config')` |
| 3 | Fiches joueurs | `/admin/joueurs-fiches` | `peut('gestion_joueurs')` |
| 4 | Gestion Ligues | `/admin/ligues` | `peut('gestion_ligues')` |
| 5 | Gestion Saisons | `/admin/saisons-gestion` | `peut('gestion_saisons')` |
| 6 | Gestion Comptes | `/admin/comptes` | `gestion_comptes` **ou** `gestion_liaisons` **ou** `gestion_invitations` |
| 7 | Matchmaking | `/admin/matchmaking` | `peut('gestion_matchmaking')` |

⚠️ `/admin/joueurs` (proxy JSON) et `/admin/joueurs-fiches` (page) coexistent : le suffixe `-fiches`
évite la collision. Ne pas « simplifier » l'un en l'autre.

---

## Chantier 3 — Session Discord expirée ✅ 2026-09-13

**Symptômes** : après expiration du jeton, l'utilisateur se voyait toujours connecté, onglet admin
compris ; l'onglet ouvrait une page qui échouait sur « Chargement impossible. » ; un retour arrière
le réaffichait connecté ; parfois l'ancienne page de connexion par mot de passe réapparaissait.

**Cause unique.** Le frontend décide l'état connecté et l'ouverture des pages admin en lisant une
copie figée dans le cookie (`session['compte']`, via `_est_admin()`), et **rien ne revalidait jamais
`player_token`** — contrairement à `admin_token`, surveillé à chaque requête depuis toujours. Seul
`/mon-compte` purgeait une session Discord périmée.

| Où | Correctif |
|---|---|
| `before_request` | surveille les **deux** voies, via la nouvelle sonde `/auth/check-session` (`@player_required`, aucune lecture SQL au-delà de la vérification de session) |
| `/admin/comptes` | **seule page admin sans revalidation** avant rendu — elle s'ouvrait sur la foi du cookie puis son JS se heurtait au 401 |
| `admin_tournois` | sur 401/403, ne purgeait qu'`admin_token`, laissant la session Discord périmée |
| JS d'`admin_comptes.html` | `api()` redirige sur 401/403 au lieu d'afficher un message inerte |

**Ce qui n'était pas en cause**, vérifié : le cache HTTP. `after_request` pose déjà
`no-cache, no-store, must-revalidate` partout.

**Ce n'était pas une faille de privilège** : le backend relit rôle et permissions à chaque requête
protégée. L'interface était fausse, jamais les données.

### Découverte : le mot de passe n'ouvre plus rien

`admin_or_role_required` n'est utilisé sur **aucune** route ; `/admin/check-token` est en
`role_required(ROLE_ADMIN)` ; seul `/admin/refresh-token` garde `@admin_required`. **L'étape 5 de
la phase 4 d'auth-discord (période de recouvrement) est donc terminée dans les faits.**

`/admin-auth` délivre encore un jeton, mais ce jeton n'ouvre plus aucune porte — d'où le symptôme
de l'écran de login réapparaissant. Correctif minimal appliqué : toutes les sorties de session
renvoient vers l'accueil, et le bouton « Admin » a été retiré de la navbar (la route `/admin` reste
atteignable en tapant l'URL, comme filet break-glass).

⚠️ **L'étape 6 (suppression effective du mot de passe) reste à faire**, en commit isolé, et ses
trois prérequis sont intacts : deux `superadmin` distincts, break-glass exécuté une fois, période
de recouvrement.

**Tests** — `test_session_expiree.py` (19 assertions).

---

## Chantier 4 — Scission des permissions ✅ 2026-09-13

Demande de l'utilisateur : séparer « Joueurs et tournois », et sortir le mode ligue des réglages.
Détail complet et décisions dans [permissions-onglets-contexte.md](permissions-onglets-contexte.md)
§8.7.

| Permission | Libellé | Couvre désormais |
|---|---|---|
| `gestion_joueurs` | **Fiches joueurs** | créer, renommer, **corriger le score** *(l'anonymisation et la suppression en sont sorties — Chantier 5)* |
| `gestion_tournois` | **Tournois** *(nouvelle)* | `POST /add-tournament`, et rien d'autre |
| `gestion_config` | **Réglage TS** | mode fantôme, seuil de classement, **+ reset global** — plus le mode ligue |
| `gestion_ligues` | Ligues | ligues et draft, **+ mode ligue et mouvements inter-ligues** |

### 🔴 Trois contournements fermés — sans eux la scission aurait été décorative

1. **`add-tournament` créait une fiche joueur à la volée.** Un admin `gestion_tournois` seul
   pouvait créer des joueurs en tapant un nom absent — le chemin **normal** de la route, pas un cas
   limite. La création vérifie maintenant `gestion_joueurs` dans le corps, et refuse en 409
   `joueur_inconnu`.
2. **La page Ligues réémettait TOUTE la config.** `toggleLeagueMode()` et `saveInterLeagueMoves()`
   faisaient `{...currentConfig, <leur clé>}` : activer le mode ligue réécrivait `tau`, la pénalité
   fantôme et le seuil de classement, écrasant le travail d'un autre admin et déclenchant le
   reclassement de tous les joueurs.
3. **`update_config` écrivait les 8 clés TrueSkill à CHAQUE appel**, valeurs par défaut comprises
   si absentes du payload. Chaque clé n'est désormais écrite que si elle est fournie, et le
   `SET is_ranked` ne part que si `unranked_threshold` l'est.

### Le point de conception à connaître

**`/admin/config` ne porte plus de décorateur de permission**, seulement `@player_required`, et
vérifie `gestion_config` / `gestion_ligues` **dans son corps**, chacune pour ses propres clés.

Raison : un `@permission_required('gestion_config')` s'exécute avant le corps et refuserait un
admin « Ligues » avant qu'il puisse activer le mode ligue — l'inverse exact de la séparation
voulue. Le helper `compte_a_permission()` (nouveau, `auth.py`) sert cette vérification secondaire
et renvoie 503 plutôt que False si la base ne répond pas (même raison qu'en R-55).

⚠️ **Contrepartie dans `test_bascule.py`** : `player_required` est accepté dans l'inventaire des
décorateurs, **mais** une assertion exige que toute route admin qui s'en contente vérifie un droit
dans son corps. Sans elle, ce décorateur deviendrait une porte ouverte à tout joueur connecté —
mode d'échec de R-43.

`GET /admin/config` est passée en lecture ouverte à toute session authentifiée : trois pages en
dépendent sans relever de `gestion_config` (Ligues, Saisons, Fiches joueurs), et ces valeurs ne
sont pas des secrets.

### Décisions actées, à ne pas « corriger » sans revalidation

- **R-51 est définitivement inversé.** Le reset global est **délégable** via `gestion_config`. Le
  commentaire « NE JAMAIS convertir » de `routes_admin.py` a été réécrit pour dire l'inverse et
  expliquer pourquoi : le reset passe *par* le moteur TrueSkill, il est traçable et reproductible,
  contrairement à une saisie manuelle de score.
- **`edition_mu_sigma` (8.5-C) est abandonné.** Corriger un score reste dans `gestion_joueurs`. Le
  catalogue compte donc 9 entrées, pas 10 — et les points 2 et 3 de §8.6 (contournement par
  `POST /admin/joueurs`, puis par DELETE+recréation) **tombent d'eux-mêmes** : sans permission
  séparée, il n'y a plus rien à contourner.
- **8.5-E (anonymisation en `chef_admin`+) n'est pas livré** et reste ouvert.
- **§8.6 point 4 est un non-sujet** : `/admin/matchmaking` est en lecture seule (aucun
  `UPDATE`/`INSERT`/`DELETE`), aucun chevauchement avec `gestion_joueurs`/`gestion_tournois`.

### ⚠️ Conséquence en production

Les admins qui portent aujourd'hui `gestion_joueurs` **perdent le droit d'enregistrer un tournoi**
tant que `gestion_tournois` ne leur est pas accordée, à la main, dans l'onglet Comptes. Aucune
migration ne peut deviner l'intention : `permissions_admin` stocke des chaînes libres.

**Tests** — `test_scission_permissions.py` (34 assertions).

---

## Chantier 5 — Sous-permission RGPD ✅ 2026-09-13

Demande de l'utilisateur : une **sous-autorisation sur la même case** que « Fiches joueurs », pour
les gestes RGPD. Premier usage du mécanisme de sous-permissions décrit plus haut.

| Permission | Couvre |
|---|---|
| `gestion_joueurs` | créer, renommer, corriger le score — l'édition courante |
| └─ `rgpd_joueurs` | **anonymiser** une fiche, **supprimer** définitivement (refusée si le joueur a des matchs) |

**Pourquoi ces deux routes ensemble** : ce sont les deux gestes irréversibles sur une fiche, et le
panneau de permissions les signalait déjà comme tels — l'avertissement de `gestion_joueurs` disait
« inclut la suppression définitive d'une fiche et l'anonymisation RGPD ». Ils sont maintenant
derrière leur propre case au lieu d'être emportés par le droit d'éditer un nom.

**Portée décidée** : l'anonymisation **et** la suppression ; la sous-permission **ne s'active
qu'avec son parent**. L'édition ordinaire (`PUT /admin/joueurs/<id>`) n'a pas bougé — c'est le sens
même de la scission, isoler l'irréversible sans gêner le courant.

### Ce qu'il a fallu ajouter au-delà de la case

- `SOUS_PERMISSIONS` dans `constants.py` : la relation parent/enfant comme **donnée**, lue par le
  backend et servie au template. Ajouter une sous-permission demain ne supposera pas de retrouver
  tous les endroits qui la supposent.
- `permission_required` et `compte_a_permission` exigent le parent en plus de l'enfant. Le log
  distingue les deux refus (`(parent 'gestion_joueurs' manquant)`).
- L'octroi refuse `parent_manquant` en 409, **dans la transaction, après le `FOR UPDATE`**.
- Le retrait du parent emporte ses enfants (`permission = ANY(%s)`), audité via
  `sous_permissions_emportees`.
- La page Fiches joueurs expose `PEUT_RGPD_JOUEURS` et **masque le bouton Supprimer** sans le
  droit — il n'avait aucun gate et aurait mené à un 403 prévisible.

⚠️ **Le tri du panneau a dû changer** : une sous-permission est triée **avec son parent**, pas
selon son propre libellé. Sans ça, « Fiches joueurs » accordée et sa sous-permission refusée se
retrouvaient aux deux extrémités de la liste (les accordées passant en tête), et le retrait ne
voulait plus rien dire visuellement.

### ⚠️ Conséquence en production

Les admins qui portent `gestion_joueurs` **perdent l'anonymisation et la suppression** tant que
`rgpd_joueurs` ne leur est pas accordée. Même mécanique que pour `gestion_tournois` : à faire à la
main dans l'onglet Comptes.

### Trouvé en relecture : la sous-permission orpheline

Une ligne `rgpd_joueurs` sans son parent peut exister en base (octroi antérieur à la création de la
sous-permission, ou SQL direct). Elle ne donne **aucun droit** — `permission_required` exige le
parent — mais les deux fonctions qui servent les permissions à l'affichage renvoyaient les lignes
brutes de `permissions_admin`. L'interface aurait donc lu `peut('rgpd_joueurs')` comme vrai et
affiché le bouton Supprimer, pour un 403 garanti.

*Corrigé* : `permissions_effectives()` (`constants.py`) filtre les orphelines, appliqué aux deux
points d'exposition (`/auth/me` et la copie mise en session à la connexion). Les purges existantes
(R-53, legs) suppriment déjà toutes les lignes d'un compte, elles ne créent donc pas d'orphelin.

### Trouvé en relecture : une garantie annoncée mais absente

La documentation affirmait que `test_revue.py` vérifiait l'alignement des deux catalogues
(backend / frontend). **Aucun test ne le faisait.** Le contrôle existe maintenant dans
`test_sous_permissions.py`, et porte aussi sur les deux tables `SOUS_PERMISSIONS` ; vérifié en
désalignant volontairement un catalogue, il échoue en nommant la permission fautive.

### Ergonomie du panneau (2026-09-13, retours d'usage)

- **Le bandeau de message remontait la page à chaque succès.** Cocher un droit dans le volet des
  permissions — déplié en bas de page — renvoyait en haut, et il fallait redescendre pour cocher le
  suivant. **Un succès de permission n'affiche plus de bandeau du tout** : le retour se fait sur la
  ligne cochée (étiquette « accordé »/« retiré » qui s'efface), et le compteur du panneau se met à
  jour. Un *échec*, lui, remonte toujours — il doit se voir.
  > Première tentative insuffisante : ne remonter que si le bandeau est hors de vue. Or il l'est
  > précisément quand on travaille dans le volet déplié — la condition se déclenchait donc à chaque
  > fois. C'est le geste répété qui ne doit rien déplacer, pas la position du bandeau qui compte.
- **Confirmation sur tout changement de droits ou d'état d'un compte** : rôle, statut
  (suspendre/réactiver), permissions, fermeture des sessions, approbation de liaison, révocation
  d'invitation. Chaque question **nomme la cible** — sur une liste de comptes, « Confirmer ? » ne
  dit pas sur qui on agit, et une ligne voisine se clique vite.
- **Annuler remet le contrôle dans son état réel** : sélecteur de rôle et case à cocher basculent
  visuellement *avant* le handler, les laisser ainsi ferait affirmer à l'écran un droit que la base
  n'a pas.
- Restent volontairement sans confirmation : **créer** une invitation ou un jeton de bot — elles ne
  détruisent ni ne modifient rien d'existant.
- **Les onglets suivent les permissions.** Seul « Jetons de bot » était gaté : un admin sans
  `gestion_invitations` voyait l'onglet *Invitations*, cliquait, et atterrissait sur la page
  d'accueil sans explication. Les trois onglets (et leurs vues) sont désormais gatés chacun par sa
  permission, l'onglet actif au chargement est le premier **autorisé** (il était codé en dur sur
  *Demandes de liaison*), et la route refuse qui n'a aucune des trois — la navbar le faisait déjà.
  > 🐛 **Bug latent trouvé au passage** : approuver une liaison appelle `chargerComptes()` pour
  > rafraîchir l'autre onglet. Un admin ayant `gestion_liaisons` mais pas `gestion_comptes` aurait
  > donc déclenché une `TypeError` sur une vue absente — et tout le script serait mort avec. Les
  > quatre fonctions de chargement sortent maintenant si leur vue n'existe pas.

**Tests** — `test_sous_permissions.py` (42 assertions) : les quatre combinaisons parent/enfant sur
le décorateur, les trois points où la règle tient, le filtrage des orphelines, l'alignement des
catalogues, les gates d'interface, et l'ergonomie ci-dessus (dont un inventaire automatique qui
échoue si une écriture destructrice perd sa confirmation).

---

## Chantier 6 — Règle de rang générique ✅ 2026-09-14

La lacune `admin` → `admin` est **fermée**. Les deux `if` en dur de `compte_cible_protegee`
(`auth.py`) sont remplacés par la comparaison de rang décidée en §8.1, lue sur `ROLE_HIERARCHY` :

```
rang(acteur) >  rang(cible)  -> autorisé
rang(acteur) <= rang(cible)  -> refusé (403 cible_protegee)
```

### La matrice, vérifiée par exécution

Les 16 combinaisons acteur × cible sont testées. **Une seule case changeait** : `admin → admin`,
qui renvoyait 200 — un admin porteur de `gestion_comptes` suspendait un pair et fermait ses
sessions, sur les 4 routes `/sync` `/sessions` `/delier` `/statut`.

| Acteur ↓ / Cible → | player | admin | chef_admin | superadmin |
|---|---|---|---|---|
| **player** | 403 | 403 | 403 | 403 |
| **admin** | 200 | **403** *(était 200)* | 403 | 403 |
| **chef_admin** | 200 | 200 | 403 | 403 |
| **superadmin** | 200 | 200 | 200 | 403 |

Le cas chef_admin-vs-chef_admin (R-52) tombe désormais de l'égalité des rangs, sans cas à part.

Un `player` n'atteint jamais ce décorateur : `permission_required` l'arrête avant, avec le code
`permission_manquante` et non `cible_protegee`. Le test le vérifie explicitement — sinon sa ligne
verte affirmerait une protection de rang qui n'a pas joué.

### Trois points que la règle a dû trancher au-delà du rang

- **Défaut fermé des deux côtés.** Un rôle illisible en base vaut le rang le plus **bas** pour
  l'acteur et le plus **haut** pour la cible. Une colonne corrompue ne doit jamais ouvrir de porte.
- **Agir sur soi reste permis.** Le décorateur sort avant même de lire la base — fermer ses propres
  sessions est légitime. C'est aux routes de refuser l'auto-modification quand elle n'a pas de
  sens, via `refuse_auto_modification` ; ce partage n'a pas bougé.
- **Cible inexistante : on laisse passer.** C'est à la route de répondre 404. Un 403 ici
  révélerait l'inexistence d'un compte par un code d'erreur différent.

Le message d'erreur nomme maintenant le rang de la cible (pair, plus privilégié, ou superadmin) :
« action impossible » sans motif renvoyait l'admin vers un support qui ne pouvait pas deviner non
plus.

### Côté interface — le garde qui manquait

`admin_comptes.html` ne calculait `cibleProtegee` que pour le sélecteur de rôle, en dupliquant les
deux anciennes règles en JS. Il applique maintenant la **même** règle de rang, via une table
`RANGS` alignée sur `ROLE_HIERARCHY` (un test échoue si les deux divergent).

Surtout, **les quatre boutons d'action n'avaient aucun garde** et menaient à un 403 prévisible,
contraire au §B.0 du plan : « Synchroniser », « Désynchroniser », « Fermer les sessions » et
« Suspendre » sont désormais sous une condition `peutAgir` unique. Ils restent affichés sur sa
propre ligne, puisque le backend l'autorise.

⚠️ **Ne pas ré-introduire de `if role_cible == ...`** dans le corps de la décision : un test
statique échoue si un rôle y est cité en dur. C'est exactement ce qui avait produit la lacune.

**Portée respectée** : `changer_role` n'a **pas** été touché — sa logique de plafond (quelle
*valeur* de rôle poser) reste distincte de celle-ci (quelle *cible* on peut toucher).

**Tests** — `test_audit_permissions.py` (149 assertions). Vérifié par mutation : en remettant `<`
au lieu de `<=`, 8 assertions tombent, dont R-52 — qu'aucun test ne couvrait réellement avant.

---

## Ce qui reste

> Recalé le 2026-09-22. L'ordre de priorité transversal, tous chantiers confondus, est tenu dans
> [etat-avancement-global.md](etat-avancement-global.md) — celui-ci ne fait que le détailler pour
> la couche admin.

### 1. Journal des actions admin — ✅ terminé le 2026-09-22

[audit-admin-plan.md](audit-admin-plan.md) §5. Livré les 18 et 19/09 : un seul chemin
d'écriture (`backEnd/audit.py`), la **promotion devenue proposition à accepter** (le rôle n'est
posé qu'à l'acceptation, `test_bascule.py` compte désormais **quatre** écrivains de
`comptes.role`), le dossier sportif tracé — mu/sigma compris, avec l'avant/après —, et l'écran de
consultation : volet « Logs » par compte, onglet Logs, export CSV.

Les deux décisions qui révisaient des choix antérieurs sont **en place et testées** : un
`chef_admin` ne lit pas les logs du `superadmin`, et la suppression d'un compte n'efface ni ses
lignes d'audit ni l'identité de leur auteur.

**Phase 4, le filet — livrée le 22/09** (non commitée) :

- `[x]` `test_audit_inventaire.py` échoue sur toute route d'écriture admin qui n'atteint pas
  l'audit. Il a trouvé **neuf routes sans trace** en arrivant — liaison de tournois (sigma),
  récaps, tiers —, toutes corrigées ;
- `[x]` aucune ligne d'audit ne disparaît à la suppression d'un compte (`test_rgpd.py`) ;
- `[x]` vocabulaire fermé : `audit.ACTIONS`, 42 actions, chacune avec son libellé à l'écran.

### 2. Sessions figées sur le rôle (A-01/A-02 de l'audit auth) — ✅ CORRIGÉ le 2026-09-22

Pas un chantier de ce document à l'origine, mais il le touche directement : une promotion laissait
une session longue (30 jours) à un admin, une rétrogradation ne fermait aucune session — et depuis
la phase 1bis, c'était le cas de **toute** promotion.

**Règle livrée** : toute écriture de `comptes.role` ferme les sessions du compte concerné. Les
quatre écrivains la portent — `changer_role` (la cible), `repondre_promotion` (le titulaire,
session courante comprise), le legs (les deux comptes), l'amorçage (les anciennes sessions, avant
la nouvelle). La page relance la connexion Discord après une acceptation ou un legs. Un filet dans
`test_sessions_changement_role.py` rougit sur tout cinquième écrivain qui l'oublierait. Détail au
§A-01/A-02 de [audit-auth-discord.md](audit-auth-discord.md).

### 3. Hygiène git (§8.2)

Ce chantier n'a jamais eu de commit à lui — tout est entré via `372db58 "Add C++ race engine"`, qui
ne le mentionne pas. Pas d'action corrective (réécrire l'historique est écarté), juste garder les
prochains commits distincts.

---

## Tests

`backEnd/tests/run.sh` — sans Postgres ni Discord, le curseur est scripté. Flask et `requests`
requis.

| Fichier | Couvre |
|---|---|
| `test_permissions.py` | les décorateurs : hiérarchie, plafond, 503 sur base indisponible |
| `test_hierarchie_routes.py` | les routes : `changer_role`, octroi/retrait, legs du superadmin |
| `test_scission_permissions.py` | la scission du 13/09, dans les deux sens, et les 3 contournements |
| `test_sous_permissions.py` | la mécanique parent/enfant : décorateur, octroi, retrait en cascade, gates d'interface |
| `test_session_expiree.py` | la revalidation des deux voies et les gates de page |
| `test_bascule.py` | inventaire des décorateurs par analyse du source (aucune route ouverte) |
| `test_audit_permissions.py` | revue transverse : matrice de rang 4×4, clôture du catalogue, plafond, 503, gates |
| `test_fiche_joueur_droits.py` | la fiche joueur « un droit par geste » : chaque champ exige sa sous-permission |
| `test_promotions.py` | la promotion à accepter : proposer n'écrit jamais `comptes.role`, expiration, annulation, verrous |
| `test_sessions_changement_role.py` | changer de rôle ferme les sessions (A-01/A-02) : les quatre écrivains, et le filet qui attrape un cinquième |
| `test_audit_journal.py` · `test_audit_dossier_sportif.py` · `test_audit_lecture.py` | le journal : chemin d'écriture unique, dossier sportif tracé, lecture sous règle de rang |

✅ **Les trois échecs préexistants** (`test_auth`, `test_liaisons`, `test_profils`) ont été
**réparés le 2026-09-18** — aucun ne signalait un défaut du code (§9 de
[etat-avancement-global.md](etat-avancement-global.md)). Suite complète au 2026-09-22 :
**1795 assertions, 34 fichiers, aucune rouge.**

**Limite du banc d'essai** : `FakeCursor` ne simule ni contrainte SQL, ni verrou, ni rollback réel.
L'unicité du superadmin repose sur un index unique partiel et ne se vérifie que sur un vrai
Postgres.

---

## Pièges rencontrés — à ne pas retrouver

- **Les deux catalogues doivent rester alignés.** Ajouter une permission au backend sans l'ajouter
  à `frontEnd/frontend.py` donne le symptôme le plus déroutant qui soit : la page s'ouvre, mais
  aucune requête n'est autorisée. *La doc affirmait qu'un test le vérifiait — c'était faux jusqu'au
  13/09.* Ne pas croire une garantie sur parole : la chercher dans les tests.
- **Une permission accordée n'est pas une permission effective.** Toute fonction qui expose des
  permissions à l'affichage doit passer par `permissions_effectives()`, sinon une ligne orpheline
  fait afficher un bouton que le backend refuse.
- **Ne jamais coder un compte en dur dans un test.** `test_hierarchie_routes` vérifiait
  `len(delegables) == 8` : il cassait à chaque ajout de permission sans rien révéler d'autre que sa
  propre obsolescence. Il compare maintenant au catalogue lui-même. *Le piège s'est reproduit le
  jour même* — `test_scission_permissions` comptait « 9 entrées » et a cassé en ajoutant
  `rgpd_joueurs` ; il vérifie désormais la présence des permissions qui l'intéressent.
- **Une permission retirée doit emporter ce qui en dépend.** Laisser une sous-permission orpheline
  ne donne aucun droit sur le moment, mais elle revient à la vie au prochain re-octroi du parent.
- **Un décorateur de permission ne peut pas arbitrer une route à deux domaines.** Il s'exécute
  avant le corps et refuse un profil légitime. C'est ce qui a imposé `compte_a_permission()`.
- **`_est_admin()` est une porte d'interface, pas une frontière de privilège.** Elle lit une copie
  en cookie, potentiellement périmée. L'autorité reste le backend.
- **Un `.index()` dans un test de source fait mourir le fichier** au lieu d'afficher l'assertion en
  échec. Utiliser un helper qui renvoie une chaîne vide.

## Limite connue et assumée

`_est_admin()` et `peut()` lisent le rôle et les permissions depuis la copie mise en session. Un
admin **rétrogradé** à l'instant voit donc encore l'onglet, jusqu'à sa prochaine visite sur
`/mon-compte` — mais n'obtient plus les données, le backend relisant le rôle en base à chaque
requête protégée.

Depuis le 2026-09-13, cette limite ne vaut **plus que pour le changement de rôle** : une session
expirée ou révoquée est détectée à chaque requête et purgée. Relire le rôle sur chaque page
coûterait un appel réseau par page et par proxy, ce que R-28 demande d'éviter.
