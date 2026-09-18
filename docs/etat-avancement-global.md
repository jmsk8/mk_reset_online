# État d'avancement global — référence de reprise

> Ce fichier n'est pas un plan de plus : c'est une photo transversale de tous les chantiers du
> projet, pour qu'une prochaine session n'ait pas à refaire l'inventaire. Il liste ce qui est
> réellement fait (vérifié dans le code, pas seulement dans la doc) et ce qui reste en suspens,
> classé par priorité.
>
> **Dernière mise à jour : 2026-09-18**, après le chantier qui a refermé B-01 à B-05, D-1, D-2,
> O-1, le §8.3 et la rotation des journaux. Passages précédents : audit croisé docs ↔ code,
> chantier performance/503, « Mes sessions actives », puis l'intégration des trois audits qui
> manquaient à cet inventaire.
>
> **État de la suite de tests : 1401 assertions, aucune rouge, aucun fichier en échec.** C'est
> une première — trois fichiers étaient rouges en permanence depuis des semaines, ce qui
> neutralisait le dispositif d'audit du projet (une ligne rouge `[B-xx]` est une bonne
> nouvelle, encore faut-il qu'elle se voie).
>
> ⚠️ **Incohérence de dates, toujours non tranchée.** Plusieurs passages de ce document et des
> docs liées portent des dates du 18/09 pour des livrables antérieurs, alors que la date système
> est le **2026-09-17** et que le dernier commit (`fe69c0e`, 503 nginx) date du 16/09. Le **code
> confirme les livrables** (migrations `2026-09-17_*` présentes, tests en place) : seules les
> dates dérivent, d'un à deux jours. À recaler si la chronologie compte — ce document ne l'a pas
> fait faute de savoir laquelle fait foi.
>
> À chaque reprise de chantier listé ici, mettre à jour la ligne correspondante plutôt que de
> relire tous les docs de zéro. Quand un point est traité, le déplacer dans « Chantiers soldés »
> avec sa date, ou le supprimer si le doc source le documente déjà correctement.

## Ordre recommandé pour la prochaine maj — révisé le 2026-09-18

> Cette section classe par **urgence réelle**, pas par numéro de chantier. La numérotation de
> « Tâches en suspens » ci-dessous est un inventaire, pas une priorité : les renvois d'autres
> docs s'y appuient, donc elle ne bouge pas.
>
> **Révision du 2026-09-18.** Les huit premiers rangs du classement du 17/09 ont été traités.
> Ce qui reste n'a **aucun caractère d'urgence** : plus aucun 🔴, plus aucun blocage de
> production, et la suite de tests est **entièrement verte pour la première fois**
> (1401 assertions, aucun fichier en échec).

### ✅ Fait le 2026-09-18

| Constat | Ce qui a été livré |
|---|---|
| **B-01** 🔴 | Liste bornée de `state` OAuth en attente (5, TTL 15 min), consommés **seulement en cas de correspondance**. Les « bugs étranges » à la connexion viennent de là. |
| **B-02 / B-03** 🔴🟠 | Garde `_refus_auto_verrouillage` sur `DELETE /me` **et** `changer_statut`, sous `FOR UPDATE`. |
| **B-04** 🟠 | Zone nginx `auth` 20 → **40 r/min**, après B-01 et pas avant. |
| **B-05** 🟠 | Les trois fichiers de tests rouges réparés — aucun ne signalait un défaut du code. |
| **§8 schema-base-de-donnees** | La note fausse sur `compte_cible_protegee` corrigée. |
| **T5 — journaux** | Durée arbitrée (**6 mois**), annoncée dans `/confidentialite`, et pilote passé à `journald` qui expire par **âge** — `json-file` ne bornait que la taille. Reste à déployer `deploy/host/journald-mk.conf` sur l'hôte. |
| **D-1 / D-2** 🟠🔵 | Le banc de scénario lit la bonne clé (`vision.place.margin.item`). |
| **O-1** 🟠 | `shieldHold` remis à `false` dans `giveKartItem`, en amont des deux branches. |
| **§8.3 — gate de permission** | 71 assertions, chantier soldé. Les **trois** onglets admin portent un gate (`admin_joueurs_fiches` n'en avait aucun), l'ordre gate/revalidation est verrouillé, la distinction droit manquant ≠ session expirée aussi, et le **gate par bloc** dans les gabarits est couvert (`admin_comptes` : onglet et panneau sous le même droit). |

### Ce qui reste

| # | Action | Renvoi | Pourquoi ce rang |
|---|---|---|---|
| 1 | **Faire tourner le banc de scénario** (`node tools/scenario.js`) | §10 | D-1 corrigé **sans avoir été exécuté**. C'est ce qui débloque la mesure des neuf constats banner restants. |
| 2 | **Vérifier la zone nginx servie** | §8 | `docker compose exec nginx nginx -T \| grep "zone=auth"` doit dire `40r/m`. L'épisode du montage par inode a déjà piégé une fois : **vérifier l'effet, pas le geste**. |
| 3 | **Déployer `deploy/host/journald-mk.conf`** | §3 | ⚠️ Une durée de 6 mois est **annoncée aux visiteurs**. Ce fichier est ce qui la rend vraie. Sans son `Storage=persistent`, les journaux sont même **perdus à chaque redémarrage** — c'est l'état actuel de la machine. |
| 4 | **Purge RGPD régulière** | §3 | Route existante, aucun ordonnanceur. Geste manuel assumé. |
| 5 | **Les neuf constats banner restants** | §10 | 🟡 et 🔵. Bloqués derrière le rang 1 pour la mesure. **Mis de côté** par décision du 18/09. |
| 6 | **Journal `audit_admin`** | §4 | ⚠️ **Avant-dernière étape décidée** (18/09). Les INSERT tournent depuis des semaines, aucun `SELECT` nulle part. |
| 7 | **Étape 6 — couper le mot de passe admin** | §1 | ⚠️ **Dernière étape décidée** (18/09). Bloquée par trois prérequis d'exploitation qui se cochent avec le temps, pas en une session. |

**Les rangs 1 à 3 sont des gestes d'exploitation, pas du développement** — ils demandent `node`,
Docker et un accès à l'hôte plutôt qu'une session de code. Le rang 3 est le seul qui engage
juridiquement : une durée de 6 mois est désormais **annoncée aux visiteurs**, et seul le fichier
journald la rend vraie.

> **Ordre de fin de projet, décidé le 2026-09-18.** Les rangs 5 (constats banner) et les chantiers
> de confort sont **mis de côté**. Les deux dernières étapes du projet sont, dans cet ordre :
> **1) le journal `audit_admin`** (rang 6), **2) la suppression du mot de passe admin** (rang 7).
> Cet ordre n'est pas négociable dans l'autre sens : couper le mot de passe avant d'avoir une
> lecture de l'audit reviendrait à se priver du seul moyen de comprendre après coup ce qui s'est
> passé sur les comptes.

⚠️ **Correction de périmètre sur le §5**, vérifiée le 2026-09-16 et toujours valable : le gate
`gestion_config` est testé côté backend (`test_scission_permissions.py`, `test_hierarchie_routes.py`)
et, depuis le 18/09, côté frontend (`test_session_expiree.py`) : **les trois onglets admin portent
désormais un gate**. Le gate par bloc dans les gabarits est couvert depuis le 18/09 (voir §5) : **plus rien
n'est découvert** sur ce chantier.

ℹ️ **Précision sur le §4** : `audit_admin` reçoit des `INSERT` depuis **7 fichiers**, pas seulement
le domaine « comptes » comme l'affirme le §4. Le constat qui compte reste vrai : **aucun `SELECT`
nulle part**.

## Tâches en suspens, par priorité

### 1. Auth Discord — étape 6 (suppression du mot de passe admin) non franchie

Voir [auth-discord-avancement.md](auth-discord-avancement.md) Phase 4 et
[audit-auth-discord.md](audit-auth-discord.md). Dette assumée (🟡, pas une brèche), mais toujours
active :

- `backEnd/routes_admin.py` — route `POST /admin-auth` toujours vivante (`bcrypt.checkpw` contre
  `ADMIN_PASSWORD_HASH`).
- `backEnd/db.py` — `ADMIN_PASSWORD_HASH` toujours chargée depuis l'environnement.
- `frontEnd/frontend.py` — appelle toujours `/admin-auth`.
- Table `api_tokens` (stockage en clair) toujours présente.

**Prérequis avant de couper**, checklist §2 de [runbook-admin.md](runbook-admin.md), toutes les
cases encore non cochées : deux comptes `superadmin` distincts, procédure break-glass exécutée au
moins une fois pour de vrai, période de recouvrement passée. Ce sont des faits d'exploitation, à
vérifier/cocher manuellement, pas du code.

### 2. "Mes sessions actives" — ✅ CLOS (`d2a543c`, recette faite le 18/09)

> **Livré et commité.** `GET` et `DELETE /auth/mes-sessions`, `resumer_appareil()`, les deux proxys
> frontend et la section « Vos appareils connectés » dans `/mon-compte`. Tests rejoués :
> `test_mes_sessions.py` **57/57**, `test_audit_auth_discord.py` **80/80** (A-03 converti en
> non-régressions, A-06 conservé comme choix acté — D5).
>
> Les trois points que la préparation demandait de trancher sont **tenus dans le code** : P1
> (relecture de l'en-tête via `.get()` + `hash_token`), P3 (`NULL` → « jamais utilisée », jamais
> une date d'epoch), P5 (aucun `INSERT INTO audit_admin`). A1, la régression la plus grave
> possible, est écartée : le `DELETE` porte bien `WHERE compte_id = %s` dans ses deux branches.

**✅ Recette faite et concluante le 2026-09-18.** Deux navigateurs, comportement conforme :
sessions listées, « cet appareil » correctement marqué, déconnexion des autres effective.
Ce chantier est **entièrement clos**.

- `[ ]` Reste à **refaire la recette en https** au premier déploiement en ligne. Le seul point
  où dev (http) et prod (https) peuvent diverger est le `fetch` `POST` avec `X-CSRFToken`.

ℹ️ Un défaut préexistant a été corrigé en passant : `backend_request` **ignorait le corps des
requêtes DELETE** (`requests.delete()` sans `json=data`). Vérifié : aucun autre appelant n'envoie de
corps en DELETE, le changement est donc sans effet ailleurs — mais `inclure_courante` serait parti
en silence.

### 3. RGPD — rotation faite, deux décisions restent

[rgpd-registre.md](rgpd-registre.md), § « Ce qui reste à faire » :

- `[x]` **Rotation des journaux nginx (T5)** — faite le 2026-09-18. **Il n'y avait aucun fichier à
  faire tourner** : dans l'image officielle, nginx écrit sur `stdout`/`stderr`, aucune directive
  `access_log` vers un fichier n'existe dans `nginx/`, et aucun volume de journaux n'est monté.
  `logrotate` n'aurait rien eu à traiter. C'est le pilote Docker qui borne, ancre `x-journaux` de
  `docker-compose.yml` : 10 Mo × 3 fichiers × 5 services = **150 Mo au plus**. Le coût disque ne
  monte plus tout seul.
- `[ ]` ⚠️ **Arbitrer la durée de conservation** (6 à 12 mois, recommandation CNIL). La borne
  ci-dessus est une **taille**, pas une durée — Docker ne sait pas expirer par âge. Sur un site peu
  fréquenté, une adresse IP peut donc rester **au-delà** de la durée annoncée ; sur un site chargé,
  elle disparaît avant. Si la durée doit être garantie et non subie, il faudra un collecteur qui
  expire par âge.
- `[ ]` **Purge RGPD régulière** (`POST /admin/purge-rgpd`) — la route existe, aucun ordonnanceur ne
  l'appelle ; geste manuel assumé.

### 4. Journal des actions admin (`audit_admin`) — conçu, non codé

[audit-admin-plan.md](audit-admin-plan.md) (plan complet, 4 phases) et
[hierarchie-admin-avancement.md](hierarchie-admin-avancement.md) Chantier 7.

- `audit_admin` ne reçoit des `INSERT` que sur le domaine « comptes »
  (`backEnd/routes_admin.py`, 2 endroits).
- Aucune route ne lit `audit_admin` (pas de bouton "Logs" par compte, pas d'onglet Logs).
- Bloque en aval la promotion-avec-acceptation prévue au §6.5 du plan.

### 5. Tests des 3 routes d'onglets admin (§8.3) — ✅ SOLDÉ le 2026-09-18

[permissions-onglets-contexte.md](permissions-onglets-contexte.md) §8.3.
`test_session_expiree.py` porte désormais **44 assertions** sur ces routes :

- **revalidation de session** (acquis le 17/09) — les six pages admin, plus le helper
  `_acces_admin_revoque` lui-même : il interroge bien le backend, traite 401/403, et mémoïse sur
  `g` et non sur la session (une mémoïsation portée par le cookie survivrait à la révocation
  qu'elle est censée détecter) ;
- **gate de permission** (18/09) — `admin_tournois` et `admin_reglages` portent leur gate et le
  testent **avant** de revalider la session : l'ordre inverse ferait payer un aller-retour backend
  pour un refus certain ;
- **la distinction qui est le cœur du §8.3** — un droit manquant redirige avec un message **sans
  déconnecter**, là où une session expirée purge les deux jetons. Les confondre éjecterait un admin
  légitime à chaque page interdite, et se lirait comme « le site m'a éjecté ».

Vérifié en cassant volontairement le gate : deux assertions virent au rouge.

**`admin_joueurs_fiches` a reçu son gate le 2026-09-18** (`gestion_joueurs`, le droit de
lecture). La navbar cachait déjà le lien, mais **un lien caché n'est pas un accès fermé** :
l'URL restait ouverte et la page finissait sur « Chargement impossible. ». Le gate est
désormais **la règle sur les trois onglets**, plus une exception à retenir — une quatrième page
admin qui l'oublierait se verrait dans les tests.

✅ **Vérifié en conditions réelles le 2026-09-18** : l'accès direct à `/admin/joueurs-fiches`
sans le droit est bien bloqué, avec le message attendu.

ℹ️ À savoir pour toute recette future de ce type : un **chef_admin ou superadmin passera
toujours** le gate, et c'est voulu. `_permissions_session()` leur rend le catalogue complet
quand la session ne porte pas encore la clé `permissions` — leur socle *est* le catalogue.
Tester un gate demande donc un compte `admin` sans la permission visée ; avec un rang
supérieur, on ne teste rien.

**Le gate par bloc est couvert depuis le 2026-09-18** — 71 assertions au total sur ce
fichier. ⚠️ **En le faisant, la prémisse du §8.3 s'est révélée périmée** : il désigne
`admin_reglages.html` comme la page à double-gate, ce qui était vrai avant le 13/09. Depuis
que le reset global est délégable, ses deux blocs sont sous le **même** droit — la page n'est
plus mixte.

La vraie page mixte est **`admin_comptes`** (trois domaines), et c'est elle qui est
verrouillée : route ouverte sur l'**union** des droits, et surtout **chaque onglet et son
panneau sous le même gate**. Les dissocier afficherait un onglet dont le contenu n'existe pas
— un clic dans le vide que rien côté serveur ne rattraperait. `admin_reglages` est couvert
autrement : on vérifie que ses blocs restent sous un droit unique, pour ne pas réintroduire
la frontière que la doc croit encore là.

**Plus rien n'est découvert sur ce chantier.**

### 7. Sous-permissions fiche joueur — ✅ RÉGLÉ le 2026-09-17, plus rien en attente

Conservé ici comme repère : ce point a occupé le **rang 1** du classement pendant deux jours, et
des renvois visent « §7 ». **Le geste a été fait.**

La migration `2026-09-17_sous_permissions_fiche_joueur.sql` n'accordait **pas** rétroactivement les
cinq nouvelles sous-permissions, et le disait explicitement (« conséquence assumée et VISIBLE »).
Les admins qui portaient `gestion_joueurs` gardaient l'onglet mais avaient perdu les six gestes
(créer, renommer, couleur, mu/sigma, statut, supprimer/anonymiser). Ils ont été **réaccordés un par
un dans le panneau des permissions**.

- `[x]` Sous-permissions réaccordées en production — 2026-09-17.

⚠️ **À refaire au même titre après toute migration de ce type.** C'est le motif qui compte : une
migration qui scinde un droit existant en sous-droits **ne les accorde pas d'office**, par choix de
conception. Le geste d'exploitation qui suit n'est pas optionnel, et rien dans le code ne le
rappellera — c'est pourquoi il est resté visible ici plutôt que supprimé.

### 6. Performance / 503 — ✅ SOLDÉ, plus rien en attente

Conservé ici comme repère : les renvois d'autres docs visent « §6 ». Le détail est dans
« Chantiers soldés » en fin de document et au §12 de
[audit-503-zone-admin.md](audit-503-zone-admin.md). **Rien n'est en attente sur ce chantier.**

⚠️ **La leçon à ne pas perdre** — `nginx.conf` est monté comme *fichier* et non comme dossier :
Docker en fige l'inode au démarrage, un éditeur qui réécrit le fichier le laisse collé à l'ancien
contenu, et `nginx -s reload` **relit la version d'avant sans que rien ne le signale**. Le
conteneur a servi `rate=30r/m` pendant des jours alors que le fichier disait `rate=8r/s`. C'est ce
qui a coûté plusieurs jours, et c'est la raison d'être du contrôle d'empreinte ajouté à
`make reload-nginx` — il **échoue** désormais en indiquant la commande qui répare.

### 8. Audit auth + administration — ✅ cinq constats sur six refermés

[audit-auth-admin-2026-09-17.md](audit-auth-admin-2026-09-17.md). **B-01, B-02, B-03, B-04 et
B-05 sont corrigés le 2026-09-18**, dans l'ordre que l'audit recommandait : la cause d'abord
(B-01), la mesure ensuite (B-04). Les assertions `defaut()` correspondantes sont devenues des
non-régressions, et chaque garde a été vérifiée **en la cassant volontairement** avant livraison.

| # | Constat | État |
|---|---|---|
| **B-01** | `state` OAuth en case unique | ✅ liste bornée (5, TTL 15 min), consommée sur correspondance seule |
| *(bonus)* | `?state=é` → **500** sur le chemin de connexion | ✅ défaut **antérieur** à B-01, hérité en le corrigeant, trouvé en relisant : `compare_digest` lève sur du non-ASCII. Comparaison sur octets. |
| **B-02** | Le superadmin peut se mettre dehors | ✅ `_refus_auto_verrouillage` sur les deux routes |
| **B-03** | `changer_statut` sans garde | ✅ même garde, sous `FOR UPDATE` — *réserve ci-dessous* |
| **B-04** | Zone nginx `auth` trop stricte | ✅ 20 → 40 r/min |
| **B-05** | Trois fichiers de tests rouges | ✅ voir §9 |
| **B-06** | `prompt=none` non commenté | ✅ commenté le 18/09, avec l'écart Discord/OIDC |

**Restent ouverts :**

- `[x]` **B-06** — commenté le 2026-09-18. Le commentaire consigne surtout l'**écart de
  Discord avec l'OIDC standard**, qui avait fait soupçonner ce paramètre à tort.
- `[ ]` **Vérifier la zone `auth` réellement servie** :
  `docker compose exec nginx nginx -T | grep "zone=auth"`. Docker n'était pas disponible au moment
  de la correction. ⚠️ `nginx.conf` est monté **comme fichier** : Docker en fige l'inode, et un
  reload peut servir l'ancienne configuration en silence. C'est ce qui a coûté plusieurs jours en
  septembre — **vérifier l'effet, jamais le geste**.

⚠️ **Réserve assumée sur B-03** : le **dernier chef_admin** ne déclenche toujours aucune
confirmation à la suspension, là où `changer_role` en demande une nommée (R-60). Raison : suspendre
un chef_admin est **réversible par le superadmin**, donc ce n'est pas un verrouillage — le critère
qui a guidé toute la correction. L'assertion reste volontairement verte, elle constate un choix.

**Rappels non corrigés** portés par le même audit : A-01/A-02 (durée de session figée sur le rôle)
🟠, A-04/A-05/A-07 (mot de passe partagé, `api_tokens` en clair, CGU non imposées) 🟡 — voir §1.

**Ce que cet audit n'a pas couvert**, pour que l'absence ne se lise pas comme un blanc-seing :
aucun test contre un vrai Postgres (les verrous et l'index partiel sont raisonnés, pas exécutés),
aucun test contre le vrai Discord, le frontend non audité au-delà du parcours d'authentification.

### 9. Trois fichiers de tests rouges (B-05) — ✅ RÉPARÉS le 2026-09-18

**Aucun des trois ne signalait un défaut du code.** Tous testaient un état antérieur du projet, et
c'est ce qui rendait leur rouge permanent si coûteux : le dispositif d'audit repose sur la
lisibilité du rouge, et trois fichiers rouges en continu le neutralisent.

| Fichier | Cause réelle | Correction |
|---|---|---|
| `test_profils.py` | **Crash**, pas un échec. La requête de `profil_public` joint désormais `joueurs` (pour écarter les fiches anonymisées) ; le motif du curseur scripté ne correspondait plus, la fonction rendait `None`. | Motif élargi + avatar relayé |
| `test_liaisons.py` | La demande de liaison porte **4 colonnes** depuis qu'elle peut créer une fiche. Le 3-uplet faisait échouer le dépaquetage, la route répondait « Erreur serveur » — **toute la section de concurrence R-07 ne testait plus rien.** | Fixtures à 4 colonnes |
| `test_auth.py` | Assertion « avatar depuis le CDN Discord » : l'avatar est **relayé** depuis, pour ne pas donner à Discord l'IP de chaque visiteur ni publier le snowflake dans la source. | Assertion inversée en non-régression |

Le cas `test_liaisons.py` mérite d'être retenu : un test qui **échoue bruyamment** est moins
dangereux qu'un test qui passe sans rien vérifier. Ici il faisait les deux — rouge sur six
assertions, et muet sur la concurrence qu'il prétendait couvrir.

### 10. Moteur de course JS — le banc est réparé, la mesure reste à faire

[audit-decision-direction-2026-09-17.md](banner/audit-decision-direction-2026-09-17.md) et
[audit-decision-objets-2026-09-17.md](banner/audit-decision-objets-2026-09-17.md). Ce sont des
**états des lieux, pas des plans**.

**✅ Fait le 2026-09-18 :**

- **D-1** 🟠 — `tools/scenario.js` lisait `cfg.ai.crossDodgeMargin`, clé morte : la table des temps
  de manœuvre rendait `NaN`. Elle a migré vers `vision.place.margin.item`.
- **D-2** 🔵 — le commentaire de `vision.threatLane` citait le même fantôme, avec une valeur
  chiffrée devenue invérifiable. Retirée plutôt que recalculée à vue.
- **O-1** 🟠 — `shieldHold` est remis à `false` dans `giveKartItem`, **en amont des deux branches**
  et non dans `planItemUse` : cette dernière n'est pas appelée pour les objets en orbite. Placé là,
  le correctif couvre aussi les triples le jour où ils reviennent (O-2).

⚠️ **Le banc n'a pas été exécuté** : `node` n'était pas disponible. La clé et son chemin sont
vérifiés dans le source, mais **la table reste à regarder tourner** — c'est un
`node tools/scenario.js`, et c'est ce qui débloque la mesure de tout le reste.

**Restent ouverts**, par gravité — tous en attente de mesure :

- `[ ]` O-3 🟡 — `findRedShellTarget` ignore l'occlusion : la rouge cible à travers les murs.
- `[ ]` D-3 🟡 — `heldThreatType` corrige un défaut que `disabledItems` masque (rien ne l'exerce).
- `[ ]` D-4 🟡 — le `giveWay` ne vérifie pas que la rouge vise **bien lui**.
- `[ ]` D-5 🟡 — l'attention est un goulot non chiffré : voir devant **coûte** l'arrière.
- `[ ]` O-2 🟡 — les trois triples sont désactivés, tout leur code dort.
- `[ ]` O-4 🔵 — la rouge tirée en arrière part **sans cible**, en ligne droite.
- `[ ]` O-5 🔵 — `getAggression` lit `state.cachedLeader` avec un repli sur soi-même.
- `[ ]` D-6 🔵 — l'étalonnage de `missChance`, à confirmer au banc.

## Note obsolète — ✅ corrigée le 2026-09-18

[schema-base-de-donnees.md](schema-base-de-donnees.md) §8 affirmait qu'un `admin` pouvait encore
agir sur un autre `admin`/`chef_admin` et que la règle de rang générique n'était pas en place.
**C'était faux, et sur un contrôle de privilèges** — donc de nature à induire en erreur qui s'y
fierait. La règle est livrée et testée depuis le 2026-09-14.

Le §8 porte désormais la correction, et signale au passage l'exception délibérée du décorateur
(l'auto-action passe, ce qui est juste pour les sessions et faux pour le statut — c'est par là que
le superadmin pouvait se suspendre lui-même, constat B-02).

## Chantiers volontairement non commencés (pas des oublis)

Rien à faire ici sans nouvelle décision explicite — listés pour éviter de les re-découvrir comme
« manquants » par erreur :

- [plan-achievements.md](plan-achievements.md) — conception seule, dépend potentiellement du
  refactor historique ci-dessous.
- [refactor-historique-recaps-plan.md](refactor-historique-recaps-plan.md) — préparation seule,
  débloqué depuis la fin du chantier sessions-tournois (15/09) mais pas démarré.
- Notification orpheline après annulation de tournoi (§8/R-session-7 de
  [plan-sessions-tournois.md](plan-sessions-tournois.md)) — `notifications` n'a toujours pas de
  colonne `tournoi_id`, mais déjà repris comme « reste » connu dans
  [sessions-tournois-avancement.md](sessions-tournois-avancement.md).
- Suppression de tournoi (`DELETE /delete-tournament/<id>`) — hors périmètre décidé explicitement
  ([onglets-admin-plan.md](onglets-admin-plan.md)).
- Bot Discord — socle API livré, bot lui-même explicitement hors dépôt (projet à part).
- Déploiement production (migrations non appliquées, app Discord OAuth non créée) — actions
  opérationnelles hors code, transparentes dans
  [auth-discord-avancement.md](auth-discord-avancement.md).

## Chantiers soldés récemment (pour mémoire, contexte)

- Hiérarchie à 4 rôles + permissions à la carte — ✅ 2026-09-10
- Règle de rang générique (`compte_cible_protegee`) — ✅ 2026-09-14
- Tiers dynamiques (remplace S/A/B/C fixes) — ✅ testé,
  [tableau-seuils-tiers-plan.md](tableau-seuils-tiers-plan.md)
- Sessions de tournois (remplace la déduplication par date) — ✅ 2026-09-15, 6 phases, 2
  migrations appliquées, [sessions-tournois-avancement.md](sessions-tournois-avancement.md)
- Amorçage superadmin sans invitation, correction du bootstrap bloquant — ✅ 2026-09-14
- Fiche joueur : un droit par geste — ✅ 2026-09-17. `gestion_joueurs` n'ouvre plus que la
  lecture ; les six gestes (créer, renommer, couleur, mu/sigma, statut, supprimer/anonymiser)
  sont des sous-permissions. `rgpd_joueurs` renommée `joueurs_irreversible` (migration
  `2026-09-17_sous_permissions_fiche_joueur.sql`). **Rouvre 8.5-C**, abandonné le 13/09 —
  voir §8.8 de [permissions-onglets-contexte.md](permissions-onglets-contexte.md).
  ✅ **En prod** : les six gestes ont été réaccordés un par un dans le panneau le 2026-09-17.
  La migration ne les accordait pas rétroactivement, par choix assumé — voir §7 pour le motif,
  qui vaut pour toute migration scindant un droit existant.

- **503 récurrents sur les pages admin, puis en public** — ✅ 2026-09-18, en trois vagues.
  Document de référence : [audit-503-zone-admin.md](audit-503-zone-admin.md) §10 à §12 (le §1-§9
  est le diagnostic d'origine, partiellement erroné, conservé pour la méthode).

  **Cinq causes indépendantes**, aucune n'expliquant le symptôme à elle seule :

  | # | Cause | Correctif |
  |---|---|---|
  | 1 | Amplification 9 → 4 appels backend par page (sonde rejouée sur chaque appel JSON, vues admin redoublant le `check-token`, `inject_saisons` mort) | `_est_navigation`, `_acces_admin_revoque`, suppression d'`inject_saisons` |
  | 2 | 2 workers gunicorn **sync** bloqués sur le réseau | `-k gthread` (8 threads front, 4 back) |
  | 3 | Budget nginx calibré pour 4 requêtes/page, la plus lourde en vaut 6 | `rate=2r/s→8r/s`, `burst=20→40` |
  | 4 | **Avatars** (`/avatar/joueur/N`, sans extension) comptés dans la zone `general`, 1 par ligne de tableau | `location /avatar/` dédié, sans limiteur |
  | 5 | **La config corrigée n'était jamais entrée en service** : `nginx.conf` monté comme *fichier*, inode figé au démarrage — le conteneur appliquait encore `rate=30r/m` | `--force-recreate nginx`, et `make reload-nginx` compare désormais les empreintes |

  La cause 4 touchait **tous les visiteurs, connectés ou non** — c'est le signalement « ça le fait
  aussi sans compte admin » qui l'a révélée, après deux tours d'analyse centrés sur l'admin.

  **Corollaires obligatoires de la cause 2**, sans lesquels threader était dangereux :
  `SimpleConnectionPool` → `ThreadedConnectionPool` (`backEnd/db.py`) et verrou sur le cache
  mémoire (`backEnd/cache.py`, `del`/`popitem` levaient `KeyError` en concurrence). `_avatars`
  dans `routes_comptes.py` a été vérifié et laissé sans verrou — opérations atomiques uniquement,
  commentaire à l'appui.

  **Effet de bord corrigé** : la page 503 ajoutée en vague 1 est du HTML, et les trois helpers JS
  faisaient un `res.json()` dessus — « Erreur serveur (Réponse invalide) », ou exception non
  rattrapée pour `admin_saisons`. Les trois lisent maintenant `Retry-After` et **rendent la main
  avant tout code de déconnexion** : un débit limité ne dit rien sur la validité d'une session.
  ⚠️ Corrigé une seconde fois le 18/09 : `admin_comptes.html` composait bien le message mais ses
  quatre appelants l'écrasaient par « Chargement impossible. » (§12.4).

  ⚠️ **Redéploiement** : les `CMD` des deux Dockerfiles ont changé — `make re-front` **et**
  `make re-back` (un `restart` ne suffit pas), plus `make reload-nginx`.

  Tests : `test_rafraichissement_droits.py` 23 → **39 assertions**, `test_session_expiree.py` 19 →
  **34**. Le point important n'est pas le nombre : c'est que le premier **balaie tout
  `frontEnd/`** et refuse tout `fetch()` de chargement sans en-tête `Accept`. Deux correctifs
  successifs avaient été incomplets faute de ce balayage (`admin_comptes.html` a son propre helper
  `api()`, oublié la première fois) — un défaut silencieux se rattrape par un test qui balaie, pas
  par la relecture.

**Rappel** : rien n'est commité automatiquement — l'utilisateur fait ses commits lui-même.
