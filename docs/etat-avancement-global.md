# État d'avancement global — référence de reprise

> Ce fichier n'est pas un plan de plus : c'est une photo transversale de tous les chantiers du
> projet, pour qu'une prochaine session n'ait pas à refaire l'inventaire. Il liste ce qui est
> réellement fait (vérifié dans le code, pas seulement dans la doc) et ce qui reste en suspens,
> classé par priorité.
>
> **Dernière mise à jour : 2026-09-23 (soir)** — ✅ **la suppression du mot de passe admin est
> faite et commitée** (`2053a67`, §1). C'était la dernière étape décidée du projet le 18/09 ; les
> deux sont maintenant closes. **L'arbre de travail est propre** : tout ce que ce document disait
> « non commité » l'est désormais — phase 4 d'`audit_admin` (`12d35dc`), suppression de compte
> sur demande (`4472d47`), alertes des karts (`c99c92a`), IP v1/v2 (`3fd2f31`), actions en pop-up
> (`3512a51`), correctif nginx 502 et images Daisy/Birdo (`2053a67`).
> Passages précédents : 23/09 matin (coupure du mot de passe), 22/09 (confrontation au code de tout ce qui avait bougé depuis le 18/09 :
> journal `audit_admin`, banc de scénario, huit chantiers apparus entre-temps, §11), 18/09
> (B-01 à B-05, D-1, D-2, O-1, §8.3, rotation des journaux), audit croisé docs ↔ code, chantier
> performance/503, « Mes sessions actives », intégration des trois audits qui manquaient à cet
> inventaire.
>
> **État de la suite de tests, relancée le 2026-09-23 : 1930 assertions, 36 fichiers, aucune
> rouge.** L'écart d'une seule assertion avec la veille cache un remaniement plus large : six
> fichiers ont rougi à la coupure du mot de passe, tous pour de bonnes raisons (§1), et la
> conversion des `defaut(...)` d'A-04/A-05 en non-régressions rend autant d'assertions qu'elle
> en retire. La veille : **1929 assertions** (1795 dans l'après-midi : l'écart vient des deux fichiers de l'affichage de
> l'IP, §13.2 ; 1647 le matin : suppression de compte sur demande écrite, §13.1, phase 4
> d'`audit_admin`, §4, et A-01/A-02, §8). Il y en
> avait 1401 le 18/09 ; l'écart vient surtout du journal `audit_admin`. Le 18/09
> était déjà une première — trois fichiers étaient rouges en permanence depuis des semaines, ce
> qui neutralisait le dispositif d'audit du projet (une ligne rouge `[B-xx]` est une bonne
> nouvelle, encore faut-il qu'elle se voie).
>
> ✅ **L'incohérence de dates signalée le 17/09 est tranchée** : les commits `ad2bf6b` et
> `2511fd3`, qui portent ces livrables, sont datés du 18/09. C'est donc la bonne date.
>
> ⚠️ **L'état de la production n'est consigné nulle part, et les docs se contredisent.**
> [auth-discord-avancement.md](auth-discord-avancement.md) dit « rien n'est déployé » (14/09) ;
> ce document rangeait encore le déploiement parmi les chantiers non commencés. Pourtant le §7
> note des droits réaccordés **en production** le 17/09, et
> [audit-503-zone-admin.md](audit-503-zone-admin.md) part de 503 constatés **en production**
> sur la zone admin. La bascule Discord y a donc vraisemblablement été déployée entre le 14 et le
> 17/09 — mais aucune trace ne dit **quelles migrations** la prod a reçues. À confirmer et à
> écrire au §12 : c'est un préalable au prochain déploiement (rang 2).
>
> À chaque reprise de chantier listé ici, mettre à jour la ligne correspondante plutôt que de
> relire tous les docs de zéro. Quand un point est traité, le déplacer dans « Chantiers soldés »
> avec sa date, ou le supprimer si le doc source le documente déjà correctement.

## Ordre recommandé pour la prochaine maj — révisé le 2026-09-22

> Cette section classe par **urgence réelle**, pas par numéro de chantier. La numérotation de
> « Tâches en suspens » ci-dessous est un inventaire, pas une priorité : les renvois d'autres
> docs s'y appuient, donc elle ne bouge pas.
>
> **Révision du 2026-09-22.** Deux rangs du 18/09 sont tombés : le banc de scénario a tourné
> (21/09) et le journal `audit_admin` est livré sauf sa phase 4 (19/09). Deux entrées sont
> nouvelles : le **prochain déploiement**, qui doit emporter trois migrations, et **A-01/A-02**,
> jusqu'ici de simples « rappels » au §8. Leur rang est une recommandation du 22/09, pas une
> décision.
>
> **Ajout du 2026-09-22 : cinq demandes de l'utilisateur** (rangs 4, 7, 10, 13 et 14, détail au
> §13) — suppression de compte sur demande par mail, définitions de l'IP, bannière d'automne,
> karts Daisy et Birdo, contrôles de la bannière. Leur rang est lui aussi une proposition.

### ✅ Fait depuis le 2026-09-18

| Constat | Ce qui a été livré |
|---|---|
| **Banc de scénario** (ex-rang 1) | Exécuté le 2026-09-21 avec l'Electron de VS Code, `node` n'étant pas installé : la table des temps de manœuvre sort chiffrée, sans `NaN`. D-5 a été mesuré au passage (§10). |
| **A-01 / A-02** (rang 6) | Livré le 22/09, commité dans `12d35dc` : toute écriture de `comptes.role` ferme les sessions du compte concerné. Les quatre écrivains la portent, dont l'acceptation d'une promotion (session courante comprise, puis reconnexion Discord relancée par la page). Filet : `test_sessions_changement_role.py` (§8). |
| **Journal `audit_admin`** (ex-rang 6) | Phases 1, 1bis, 2 et 3 livrées les 18 et 19/09 (`c0988fd`, `025af10`) : un seul chemin d'écriture, promotion soumise à acceptation, dossier sportif tracé (mu/sigma avant/après), volet « Logs » par compte, onglet Logs, export CSV. **Reste la phase 4** (§4). |

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
| 1 | **Déployer `deploy/host/journald-mk.conf`** | §3 | 🔴 La seule promesse faite aux visiteurs qui n'est **pas tenue aujourd'hui** : `/confidentialite` annonce 6 mois de conservation, et ce fichier est ce qui la rend vraie. Sans son `Storage=persistent`, les journaux sont même **perdus à chaque redémarrage**. Rien à coder : un fichier à poser sur l'hôte. |
| 2 | **Prochain déploiement : emporter quatre migrations** | §12 | 🟠 `2026-09-18_promotions_proposees`, `2026-09-19_audit_index_acteur`, `2026-09-20_notifications_lien`, puis `2026-09-23_drop_api_tokens` (après le code). Le code depuis `025af10` lit les tables et colonnes qu'elles créent : le déployer sans elles casse la gestion des comptes et les notifications. Puis `make re-front` **et** `make re-back`, et la recette https de « Mes sessions actives » (§2). Préalable : établir quelles migrations la prod a déjà reçues (voir l'en-tête). |
| 3 | **Vérifier la zone nginx servie** — ✅ poste de dev (22/09), **serveur à faire** | §8, §12.1 | `docker compose exec nginx nginx -T \| grep "zone=auth"` doit dire `40r/m`. Deux minutes — mais si l'ancien 20 r/min est encore servi, ce sont des connexions en 503. L'épisode du montage par inode a déjà piégé une fois : **vérifier l'effet, pas le geste**. |
| 3bis | **Emporter le correctif nginx du 23/09** (commité dans `2053a67`) — ✅ poste de dev (23/09), **serveur à faire** | [audit-503](audit-503-zone-admin.md) §13 | 🟠 `nginx/snippets/app.conf` résout désormais les noms de services à chaque requête. Sans lui, **tout le site tombe en 502 après chaque `make re-front` / `make re-back` / `make build`** — nginx garde l'IP d'un conteneur qui n'existe plus, pendant que `docker compose ps` affiche un frontend `healthy`. Déployer avec `make reload-nginx`, qui valide par `nginx -t` **avant** de recharger, puis recetter en recréant le frontend : c'est le seul geste qui prouve le correctif. |
| 4 | ⚠️ **Exécuter la procédure break-glass une fois pour de vrai** | §1, [runbook](runbook-admin.md) §3.1 | 🟠 **Monté au rang 4 le 23/09** : depuis la coupure du mot de passe, c'est le **seul garde-fou manquant** de l'accès d'urgence, et il n'a aucun substitut. Un `UPDATE` jamais joué se découvre un soir de panne — citation SQL, `POSTGRES_USER` absent du shell de l'hôte, `make db-shell` indisponible. Une demi-heure sur le poste de dev. |
| 4bis | **« Supprimer mon compte » : passer par une demande par mail** — ✅ clos le 22/09 (`4472d47`) | §13.1 | `DELETE /me` retiré côté backend (pas seulement le bouton), effacement par `DELETE /admin/comptes/<id>` réservé au `superadmin`. Reste mineur : le handle n'est pas affiché dans la liste des comptes (§13.1). |
| 5 | **Phase 4 d'`audit_admin`** — ✅ **close le 22/09** (`12d35dc`) : le journal est terminé | §4 | Le filet (`test_audit_inventaire.py`) a trouvé en arrivant **neuf routes admin qui écrivaient sans trace**, dont la liaison de tournois qui modifie le sigma. Toutes corrigées. |
| 6 | **A-01 / A-02 — sessions figées sur le rôle** — ✅ clos le 22/09 (`12d35dc`) | §8 | Était le dernier 🟠 ouvert. Une promotion laissait à un admin une session de 30 jours au lieu de 12 h, une rétrogradation ne fermait aucune session. Désormais **changer de rôle oblige à se reconnecter**, dans les deux sens. Recette faite en conditions réelles, acceptation et rétrogradation (§8). |
| 7 | **Définitions de l'IP v1 / v2 sur le site** — ✅ **clos le 22/09** | §13.2 | Les 5 décisions tranchées (propositions retenues), les 4 phases déroulées : un seul module de textes (`textes_ip.py`), badge de version et modale d'explication sur le récap et le classement, légende des couleurs, admin aligné. Validé à l'écran par l'utilisateur. Reliquat `grand_master` retiré le 23/09 : **chantier entièrement clos**. |
| 8 | **Prérequis de l'étape 6** — ✅ tranchés le 23/09 | §1 | Le second `superadmin` est **volontairement écarté** : l'accès à la base *est* la porte de secours, et il ne couvrait qu'un des cinq scénarios de panne (raisonnement en table dans [runbook-admin.md](runbook-admin.md) §2). La période de recouvrement était vécue depuis le 13/09. ⚠️ **Reste le break-glass jamais exécuté**, passé au rang 4. |
| 9 | **Étape 6 — couper le mot de passe admin** — ✅ **faite le 23/09** (`2053a67`) | §1 | C'était la **dernière étape décidée** du projet (18/09). A-04/A-05 refermés du même geste, 6 constats d'audit sur 7 désormais clos. ⚠️ Retour arrière en **deux** gestes (le `revert` ne recrée pas `api_tokens`), et le commit porte **aussi** le correctif nginx 502 : voir §1. |
| 10 | **Bannière d'automne** | §13.3 | Demandé le 22/09. L'automne affiche la bannière d'été depuis ce matin, en intérim. Travail daté : la saison s'arrête le 21/12, chaque semaine de retard en est une de moins à l'écran. |
| 10bis | **Écart `changer_role` ↔ plan R-68** | §8 | 🟠 Seul point de **code** encore ouvert sur l'auth : une promotion directe par `/role` contourne le consentement préalable, argument juridique (RGPD). À trancher : fermer la route aux promotions, ou amender le plan (le superadmin qui désigne un `chef_admin`). |
| 11 | **RGPD : purge régulière, et A-07** | §3, §8 | Purge : route existante, aucun ordonnanceur, geste manuel assumé. A-07 🟡 : le consentement CGU est affiché, jamais imposé. |
| 12 | **CHANGELOG** | §12 | La section « Non publié » ne dit **rien** de la bascule Discord, des rôles admin, du journal, des promotions, des notifications ni des sessions de tournois. À écrire avant de publier une version. |
| 13 | **Karts de la bannière : ménage et Daisy + Birdo** | §13.4 | Demandé le 22/09. Supprimer les PNG inutilisés, ajouter Daisy et Birdo (images commitées dans `static/img/`, à renommer). Plus qu'un ajout d'images : 10 karts au lieu de 8 dans chaque course, deux moteurs à mettre à jour, un équilibrage à refaire. |
| 14 | **Bannière : retravailler redémarrage, pause, tour et vitesse** | §13.5 | Demandé le 22/09. Le bouton de vote de redémarrage, le bouton pause, et le cartouche tour/vitesse du kart suivi. |
| 15 | **Les constats banner restants** | §10 | **Arbitrés le 23/09** : O-2, O-4, D-4 et O-3 (le ciblage) actés, D-3 laissé de côté, D-5 et D-6 mesurés (`make race-attention`). Restent : le souvenir du porteur arrière (D-5), O-5 à réfléchir, D-6 à trancher, et un **nouveau chantier**, la rouge qui contourne les pipes (O-3). |
| 16 | **Chantiers de confort** | §11 | Pistes de perf du décor, moteur Rust — plus les chantiers volontairement non commencés (bas du document). |
| — | **Demande à ranger : 13.9** (13.7 et 13.8 ✅) | §13 | Sans rang, à placer par l'utilisateur. 13.7 et 13.8 sont ✅ faites le 23/09. Proposition : 13.9 (zoom des graphiques) un petit chantier, tous les graphiques étant sur Chart.js. |

**Les rangs 1 à 3 se font sur l'hôte, pas dans le code** — ils demandent Docker et un accès à la
machine plutôt qu'une session de développement. Le rang 1 est le seul qui engage juridiquement.

> **✅ Ordre de fin de projet, décidé le 2026-09-18 — tenu et terminé.** Les deux dernières
> étapes décidées étaient, dans cet ordre : **1) le journal `audit_admin`** (rang 5, terminé le
> 22/09), **2) la suppression du mot de passe admin** (rang 9, faite le 23/09). L'ordre a été
> respecté, et il n'était pas négociable dans l'autre sens : couper le mot de passe avant d'avoir
> une lecture de l'audit aurait privé du seul moyen de comprendre après coup ce qui s'est passé
> sur les comptes. A-01/A-02 (rang 6) et les demandes du 22/09 (§13) se sont intercalées sans
> toucher à cet ordre.
>
> **Ce qui reste n'est plus du code décidé** : le rang 1 (une promesse juridique à rendre vraie),
> les rangs 2-4 (des gestes d'exploitation sur l'hôte), l'écart `changer_role` (rang 10bis) et les
> demandes des 22 et 23/09 (§13), plus les
> chantiers mis de côté. Les constats banner et les chantiers de confort restent **hors
> périmètre**.

## Tâches en suspens, par priorité

### 1. Auth Discord — ✅ étape 6 FRANCHIE le 2026-09-23 (`2053a67`)

Voir [auth-discord-avancement.md](auth-discord-avancement.md) « ✅ L'étape 6 » et
[audit-auth-discord.md](audit-auth-discord.md) « ✅ A-04 et A-05 ». **Il n'existe plus de secret
partagé dans le projet** : le but A du plan d'auth est atteint, et la phase 4 est close.

**Ce qui est parti**, dans le commit `2053a67` :

| Où | Quoi |
|---|---|
| `routes_admin.py` | `POST /admin-auth`, `POST /admin/refresh-token`, `POST /admin-logout` |
| `auth.py` | `admin_required`, `admin_or_role_required`, l'en-tête `X-Admin-Token` |
| `db.py`, `check_env.sh`, `docker-compose.yml`, `README.md` | `ADMIN_PASSWORD_HASH`, `bcrypt_hash()` |
| `frontend.py` | `/admin` (formulaire), `/admin/logout`, `/admin/refresh`, `inject_lifetime`, les quatre branches `admin_token` |
| `navbar.html` | la modale « session bientôt expirée » et son minuteur JS |
| base | `api_tokens`, via `2026-09-23_drop_api_tokens.sql` |

**Ce qui reste volontairement** : `GET /admin/check-token`. Le plan la rangeait parmi les
suppressions de l'étape 6 — c'est un **écart assumé**, tracé dans le code. Elle est passée en
`role_required(ROLE_ADMIN)` le 13/09 et porte aujourd'hui la revalidation par page des six vues
admin (`_acces_admin_revoque`). La supprimer les rouvrirait sur la foi du seul cookie : le défaut
🔴 déjà rencontré le 13/09.

**Six fichiers de tests ont rougi**, tous pour de bonnes raisons, et c'est le meilleur retour
qu'on pouvait avoir du dispositif d'audit :

- `test_audit_auth_discord.py` — les `defaut(...)` d'A-04/A-05 ont viré au rouge à la
  correction, comme prévu, et disent où venir l'acter. Convertis en non-régressions.
- `test_audit_inventaire.py` — a signalé une **exemption devenue inutile** (`refresh_token`
  dans la liste des routes qui écrivent sans journaliser). Sa raison d'être exacte.
- `test_migrations_montees.py` — ne connaissait pas la notion de **migration inverse**. Il
  l'apprend, et verrouille au passage le vrai danger : qu'elle soit montée par mégarde sur le
  chemin `make redump`, où elle recréerait la table deux lignes après sa suppression.
- `test_bascule.py`, `test_decorators.py`, `test_session_expiree.py` — décrivaient la
  cohabitation des deux voies. Réécrits pour décrire son absence.

⚠️ **Le retour arrière demande deux gestes, pas un.** Un `git revert` rend le code mais **pas la
table** : le backend reverté répondrait 500 à la première connexion. D'où
`2026-09-23_restore_api_tokens.sql`, et l'ordre imposé au §3.2b de
[runbook-admin.md](runbook-admin.md) — la table d'abord, le code ensuite.

⚠️ **`2053a67` n'est pas isolé** : il emporte aussi le correctif nginx du 23/09
(`nginx/snippets/app.conf`, commentaire du `Makefile`) et le fichier `.engine`. Un
`git revert 2053a67` **ramènerait les 502 après chaque `make re-front`/`re-back`**. En cas de
retour arrière, reverter puis restaurer ces deux fichiers :
`git checkout 2053a67 -- nginx/snippets/app.conf Makefile`.

**Prérequis de R-38, arrêtés au 23/09** ([runbook-admin.md](runbook-admin.md) §2) :

- ✅ **Période de recouvrement** — vécue : le site était administré par Discord seul depuis le 13/09.
- ⚠️ **Deux comptes `superadmin` distincts** — **volontairement écarté.** L'accès à la base *est*
  la porte de secours ; le second compte n'en était qu'un raccourci par l'interface, et il ne
  couvrait qu'**un seul** des cinq scénarios de panne du runbook §1 (compte Discord du superadmin
  perdu). Point de vigilance qui le remplace : **faire ouvrir une session à un second compte
  Discord, même en simple `player`**, pour qu'une ligne existe dans `comptes` —
  `DISCORD_SUPERADMIN_ID` se referme définitivement dès qu'un superadmin existe, et sans cette
  ligne le break-glass passerait d'un `UPDATE` à un `INSERT` à la main.
- ❌ **Break-glass exécuté pour de vrai** — **toujours pas fait**, et c'est désormais le seul
  garde-fou manquant. Passé au rang 4 de la liste ci-dessus.

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

### 3. RGPD — durée arbitrée, reste à la rendre vraie sur l'hôte

[rgpd-registre.md](rgpd-registre.md), § « Ce qui reste à faire » (à jour, il fait foi) :

- `[x]` **Rotation des journaux nginx (T5)** — faite le 2026-09-18. **Il n'y avait aucun fichier à
  faire tourner** : dans l'image officielle, nginx écrit sur `stdout`/`stderr`, aucune directive
  `access_log` vers un fichier n'existe dans `nginx/`, et aucun volume de journaux n'est monté.
  `logrotate` n'aurait rien eu à traiter. C'est le pilote Docker qui borne, ancre `x-journaux` de
  `docker-compose.yml` : 10 Mo × 3 fichiers × 5 services = **150 Mo au plus**. Le coût disque ne
  monte plus tout seul.
- `[x]` **Durée de conservation arbitrée** — **6 mois**, décidé le 2026-09-18 et annoncé dans
  `/confidentialite`. La borne ci-dessus était une **taille**, pas une durée : Docker ne sait pas
  expirer par âge. D'où le passage du pilote à `journald` (`2511fd3`), qui expire par âge.
- `[ ]` ⚠️ **Déployer `deploy/host/journald-mk.conf` sur l'hôte** — rang 1. C'est ce fichier, et
  lui seul, qui impose les 6 mois annoncés ; sans son `Storage=persistent`, les journaux vivent
  dans `/run` et disparaissent à chaque redémarrage.
- `[ ]` **Purge RGPD régulière** (`POST /admin/purge-rgpd`) — la route existe, aucun ordonnanceur ne
  l'appelle ; geste manuel assumé.

### 4. Journal des actions admin (`audit_admin`) — ✅ TERMINÉ le 2026-09-22 (`12d35dc`)

[audit-admin-plan.md](audit-admin-plan.md) §5 porte le détail de chaque phase, et
[hierarchie-admin-avancement.md](hierarchie-admin-avancement.md) le Chantier 7.

- **Phase 1** (18/09, `c0988fd`) — un seul `INSERT INTO audit_admin` dans tout le backend, dans
  `backEnd/audit.py`. Deux actions avaient perdu leur acteur et l'ont retrouvé, dont
  `joueur_anonymise`.
- **Phase 1bis** (18/09) — la promotion vers `admin`/`chef_admin` devient une **proposition à
  accepter**, avec la politique « en tant qu'administrateur » ; le rôle n'est posé qu'à
  l'acceptation. Migration `2026-09-18_promotions_proposees.sql`.
- **Phase 2** (19/09) — le dossier sportif est tracé : mu/sigma avec avant/après, fiches,
  tournois, reset global, configuration. Vocabulaire des actions figé le 18/09.
- **Phase 3** (19/09, `025af10`) — le journal se lit enfin : volet « Logs » sur la ligne d'un
  compte, onglet Logs, export CSV en streaming. Filtre de rang appliqué **en SQL** ; un
  `chef_admin` ne lit jamais le `superadmin`. Migration `2026-09-19_audit_index_acteur.sql`.

⚠️ **Limite définitive** : la dénormalisation de l'acteur (§6.3 du plan) a été oubliée en phase 2
et rattrapée en phase 3. Les lignes écrites entre les deux restent **anonymes si leur compte est
supprimé** — rien ne peut le rattraper après coup.

**Phase 4 — livrée le 2026-09-22**, détail au §5 du plan :

- `[x]` **Le filet** : `test_audit_inventaire.py` (55 assertions) rougit sur toute route
  d'écriture admin qui n'atteint pas `audit.ecrire`, par analyse du source. ⚠️ **Il a trouvé
  neuf trous en arrivant**, tous corrigés : `lier-session` (🔴 modifie le sigma sans trace),
  suppression et publication d'un récap, et les cinq routes des tiers. Huit actions ajoutées.
  Quatre exemptions closes, chacune bornée aux tables qu'elle peut toucher.
- `[x]` **La suppression d'un compte n'efface aucune ligne d'audit** : verrouillé dans
  `test_rgpd.py`, requêtes et schéma (`ON DELETE SET NULL`).
- `[x]` **Vocabulaire fermé (R-64)** : `audit.ACTIONS` (42 actions) ; toute action écrite y
  figure, et l'écran Logs a un libellé pour chacune.
- `[x]` **Recette manuelle** sur le poste de dev le 22/09 (tier, récap publié et supprimé, onglet
  Logs) : phase close. ⚠️ Les deux routes de récap restent sans test automatisé.
- `[x]` Gardes de rang sur les trois chemins (volet, onglet, export), refus pour un `player`,
  acteur identifiable après suppression — couverts par `test_audit_lecture.py`.
- `[x]` **Bouton « Logs » corrigé le 2026-09-22**, deux défauts : il s'affichait
  sur **tous** les joueurs, alors que le volet ne montre que les actions dont le compte est
  l'acteur — vide pour qui n'a jamais été admin ; et il s'affichait à un simple `admin`
  porteur de `gestion_comptes`, que le 403 de la route renvoyait à l'accueil. Désormais : lecteur
  `chef_admin`+, et compte ayant au moins une ligne (`a_un_journal`, filtré par
  `_peut_lire_journal`). 72 assertions dans `test_audit_lecture.py`.

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

**Rappels** portés par le même audit. Les assertions `defaut()` de A-01 et A-02 sont devenues
des non-régressions le 2026-09-22 :

- `[x]` **A-01/A-02** 🟠 — ✅ **corrigé le 2026-09-22, commité dans `12d35dc`.** Toute écriture de
  `comptes.role` ferme les sessions du compte concerné : `changer_role` (la cible, jamais
  l'acteur), `repondre_promotion` (le titulaire, **session courante comprise** — c'est la session
  de joueur qui accepte), le legs (**les deux** comptes), l'amorçage (les anciennes sessions,
  **avant** que `login()` crée la nouvelle). La durée reste figée dans `create_session` : pas de
  recalcul d'`expires_at`, qui aurait fait une seconde source de vérité. Après une acceptation ou
  un legs, la page relance la connexion Discord (`prompt=none` : sans écran pour qui a déjà
  autorisé) avec un message qui explique ; la carte d'acceptation prévient **avant** le clic.
  `test_sessions_changement_role.py`, **47 assertions**, dont un filet qui parcourt tout le
  backend. Sept gardes cassées volontairement, plus un cinquième écrivain fictif : tous
  rougissent. Détail au §A-01/A-02 de [audit-auth-discord.md](audit-auth-discord.md).
  - ⚠️ **L'assertion `defaut()` de A-02 serait restée verte** sur le défaut corrigé : elle lisait
    6000 caractères depuis `def changer_role(`, le `DELETE` est tombé à 6741. Remplacée par une
    délimitation `ast`. Un `not in` sur une fenêtre fixe peut masquer une correction.
  - `[x]` **Recette de la rétrogradation — faite le 2026-09-22** : un `chef_admin` repassé
    `player` a été déconnecté ; à la reconnexion, il était bien `player`.
  - `[x]` **Recette de l'acceptation — faite le 2026-09-22** : compte joueur connecté sur deux
    navigateurs, promotion acceptée sur l'un — reconnexion Discord et retour en admin, l'autre
    déconnecté. **Chantier entièrement clos.**
- `[x]` **A-04/A-05** 🟡 — ✅ **refermés le 2026-09-23** avec l'étape 6 (§1). Mot de passe
  partagé, `api_tokens` en clair et renouvellement sans borne : les trois ont disparu dans le
  même commit. **Six constats d'audit sur sept sont désormais clos ; seul A-07 reste ouvert.**
- `[ ]` **A-07** 🟡 — CGU affichées mais jamais imposées.
- `[ ]` ⚠️ **Écart plan ↔ code, relevé le 2026-09-22, à trancher** : `changer_role` **promeut
  encore** sans proposition si on l'appelle directement (un `chef_admin` qui poste `admin` sur
  `/admin/comptes/<id>/role`). Seule l'interface route les promotions vers `/promotion`. Or le
  plan de la phase 1bis (R-68, [audit-admin-plan.md](audit-admin-plan.md)) dit que
  `changer_role` ne garde que la rétrogradation, et le consentement préalable est un argument
  **juridique** (RGPD) — un lien caché n'est pas un accès fermé. `test_hierarchie_routes.py`
  teste pourtant la promotion directe comme voulue (le superadmin désigne un `chef_admin` par
  `/role`). Depuis A-01/A-02, ce chemin ferme au moins les sessions de la cible.

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

### 10. Moteur de course JS — le banc tourne, les constats attendent

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

✅ **Le banc a tourné le 2026-09-21** ([banner/README.md](banner/README.md)) :
`tools/scenario.js` sort une table de temps de manœuvre chiffrée, sans `NaN`, et
`tools/simulate.js` comme le nouveau `tools/alerts.js` tournent aussi. `node` n'étant pas
installé, l'Electron de VS Code en tient lieu :
`ELECTRON_RUN_AS_NODE=1 /app/extra/vscode/code tools/scenario.js`. **Plus rien ne bloque la
mesure des constats ci-dessous** — ils restent mis de côté par la décision du 18/09.

**Arbitrés par l'utilisateur le 2026-09-23** (mesures : `make race-attention`,
`tools/attention.js`, 300 courses et 1000 graines par kart) :

- `[x]` O-2 🟡 — triples désactivés : **normal**, voulu.
- `[x]` O-4 🔵 — la rouge tirée en arrière part tout droit : **normal**, voulu.
- `[x]` D-4 🟡 — se ranger devant une rouge qui ne le vise pas : **légitime**. Être dans son
  axe suffit à justifier l'écart, cible ou non.
- `[x]` O-3 🟡 — la rouge qui cible à travers les murs : **pas grave**, elle est une tête
  chercheuse. ⚠️ **Mais ce que l'utilisateur attend d'elle n'est pas dans le code** : elle
  devrait **contourner un obstacle fixe** (un pipe) et foncer droit sur sa cible sinon. Or
  elle vise la profondeur de sa cible sans regarder le décor (`step.js`, suivi de
  `targetKartId`) et **se brise** sur le premier pipe de sa trajectoire (`pipes.js`,
  `advanceProjectile`). Chantier à part : faire contourner les pipes par la rouge.
- `[ ]` D-3 🟡 — `heldThreatType` corrige un défaut que `disabledItems` masque. **Laissé de
  côté** pour l'instant.
- `[~]` D-5 🟡 — **vérifié le 2026-09-23.** Le modèle voulu : le kart regarde devant ou
  derrière, retient ce qu'il a vu derrière et agit dessus en regardant devant. Mesures :
  - le souvenir tient : pendant qu'un danger arrière est en mémoire, le kart regarde devant
    37 à 51 % du temps. Il n'est pas cloué vers l'arrière ;
  - ✅ **céder le passage à une rouge** (`giveWay`) : 46 % des décisions prises face à la
    route, sur le souvenir ;
  - ✅ **garder son objet en bouclier** : 13 % sur le souvenir, le reste au premier regard,
    ce qui est logique (l'épisode commence quand il la voit) ;
  - ❌ **se ranger hors de la ligne d'un porteur derrière** (`safety`) : **0 %** sur le
    souvenir, 689 décisions toutes prises dos tourné. Seul le porteur **de devant** a un
    souvenir (`frontAt`, `vision.js`). Celui de derrière s'efface au retour de tête, et le
    tirage n'a lieu que pendant un coup d'œil ;
  - ⚠️ **6 % des touches par l'arrière** tombent sur un kart qui **savait** (souvenir frais),
    regardait devant et n'esquivait pas. Le souvenir d'une carapace en vol ne garde que sa
    **nature** (`dangerKind: 'shot'`), pas sa position : il fait se retourner plus souvent
    mais ne permet pas d'esquiver. 24 % des touches arrière tombent sur un kart qui n'en
    savait rien.
  - Coût du regard inchangé : 33 % du temps tourné vers l'arrière pour le premier, 18 %
    pour le peloton, 6 % pour le dernier.
- `[ ]` O-5 🔵 — `getAggression` lit `state.cachedLeader` avec un repli sur soi-même.
  **À réfléchir.** Analyse du 23/09 : le repli est pratiquement inatteignable
  (`cachedLeader` est posé dès qu'un kart roule et n'est jamais remis à `null`). L'étrange
  est ailleurs : ces lignes **recopient** `getRaceStage()` (`standings.js`), qui calcule la
  même progression du premier mais se replie sur **0**. Deux sources pour une même grandeur,
  avec deux replis différents. Piste : appeler `getRaceStage(state)`.
- `[~]` D-6 🔵 — **banc prêt et passé le 2026-09-23.** Quand une menace apparaît tard
  (≤ 450 px), le tirage est **le même pour tous** (9,5 % à 250 px, 8,4 % à 350 px) :
  l'étalonnage sur l'agilité de référence tient. Plus loin, les deux plus vifs (toad,
  koopa) ouvrent leur fenêtre plus tard et gardent **2 à 6 %** de ratés là où les autres
  sont à 0 %. L'effet de bord existe, mais il reste petit et ne touche que les deux gabarits
  légers. **À trancher** : l'assumer et l'écrire, ou tirer l'inattention sur une fenêtre de
  référence.

### 11. Chantiers apparus depuis le 2026-09-19

Aucun n'était dans l'inventaire du 18/09. Ils sont listés ici pour que ce document reste la photo
de **tous** les chantiers.

| Chantier | État | Où en lire plus |
|---|---|---|
| Cloche de notifications et menu du compte sortis du burger | ✅ commité le 20/09 (`97fb753`, `f935f88`) | — |
| Admin sur mobile, tri des tableaux | ✅ commité le 20/09 (`ede7a8a`) | — |
| Notifications cliquables, page 404 dédiée | ✅ commité le 20/09 (`c48b7f7`) — ⚠️ migration `2026-09-20_notifications_lien.sql`, voir §12 | — |
| Décor Mario Kart en fond de toutes les pages | ✅ commité les 20 et 21/09 (`638db0b`, `d2a2f1f`, avec les pipes 2×2). Pistes d'optimisation encore ouvertes | [decor-perf-notes.md](decor-perf-notes.md) §3 |
| Alertes (ouïe) des karts du bandeau | ✅ livré et mesuré le 21/09, commité (`c99c92a`, `raceEngine/src/engine/alerts.js`, banc `make race-alerts`) | [banner/alertes.md](banner/alertes.md) |
| Bannière d'accueil en automne | 🟡 **intérim** du 22/09, commité : l'automne affiche la bannière d'été (`get_banner_season()`, `frontEnd/frontend.py`), faute de style `autumn`. La vraie bannière est au rang 10 | §13.3 |
| Affichage IP v1/v2 | ✅ clos le 22/09 — rang 7, reliquat `grand_master` retiré le 23/09. Ne pas réafficher v1 et v2 côte à côte : retiré exprès le 22/08 | [affichage-ip-plan-redaction.md](affichage-ip-plan-redaction.md) |
| Moteur de course en Rust | 📋 conception seule (21/09), rien codé | [banner/moteur-rust-plan.md](banner/moteur-rust-plan.md) |

### 12. Déploiement et publication

**Migrations.** `backEnd/migrations/` en compte **20**, dont une inverse (`restore_api_tokens`, réservée au break-glass, à ne **jamais** jouer au déploiement). Le dump de prod du 14/09 était resté au
schéma d'avant le 02/09 ; depuis, la prod a vraisemblablement reçu la bascule Discord (voir
l'en-tête), sans trace de ce qui a été joué. Quoi qu'il en soit, les quatre
dernières sont **postérieures à tout déploiement connu** et doivent partir avec le code qui les
lit :

| Migration | Ce qu'elle crée | Ce qui casse sans elle |
|---|---|---|
| `2026-09-18_promotions_proposees.sql` | table `promotions_proposees`, colonnes `cgu_admin_*` sur `comptes` | la liste des comptes (jointure), les promotions |
| `2026-09-19_audit_index_acteur.sql` | index `idx_audit_admin_acteur` | rien, mais le volet « Logs » balaie toute la table |
| `2026-09-20_notifications_lien.sql` | colonne `notifications.lien` | la lecture **et** l'émission des notifications |
| `2026-09-23_drop_api_tokens.sql` | supprime `api_tokens` | rien ne casse sans elle, mais la table reste avec des jetons morts. **À jouer après** le déploiement du code de `2053a67`, jamais avant : l'ancien code s'en sert |

Rappels du même geste : `make re-front` **et** `make re-back` (un `restart` ne suffit pas),
`make reload-nginx` si la config a bougé, puis la **recette https** de « Mes sessions actives »
(§2). Les répéter à blanc sur un dump avec `scripts/adapter-dump.sh` : c'est exactement la
séquence à rejouer en prod.

- `[ ]` **Établir et écrire ici quelles migrations la prod a déjà reçues.**
- `[ ]` **Compléter le CHANGELOG.** Sa section « Non publié » ne couvre que la bannière, le reset
  global plafonné et le chantier 503 : rien sur la bascule Discord, la hiérarchie des rôles, les permissions, le
  journal des actions, les promotions, les notifications, « Mes sessions actives » ni les
  sessions de tournois.

#### 12.1 Passage sur le serveur — notes du 2026-09-22

**Où tourne quoi.** Le poste de développement (192.168.1.65) fait tourner **sa propre pile
Docker** : c'est elle qui répond sur `http://127.0.0.1/`. Le **serveur** est une autre machine,
et les rangs 1 à 3 s'y jouent à la main. VS Code tourne en **Flatpak** : depuis son terminal, ni
Docker, ni `/etc/systemd`, ni les journaux de l'hôte ne sont visibles — rien de ce qui suit ne
peut se vérifier depuis l'éditeur.

⚠️ **À vérifier sur le poste de dev** : son `.env` porte `DISCORD_REDIRECT_URI=http://192.168.1.20`,
qui **ne répond pas** au 22/09 — le poste est en `.65`. Si l'adresse a changé (DHCP), la
connexion Discord de la pile de dev renvoie vers une machine absente. Le `redirect_uri` doit
aussi correspondre, au caractère près, à celui déclaré dans le portail Discord.

**Règle transversale : ne pas faire de `git pull` sur le serveur pour un geste isolé.** Le
backend monte ses `.py` depuis le dépôt (`docker-compose.yml`) : un pull change le code **sur
le disque**, et le premier redémarrage d'un conteneur — un `up -d`, un reboot, un crash — le
fait tourner **sans ses migrations**. Pour poser un seul fichier, le copier (`scp`). Le pull
appartient au déploiement complet du rang 2, avec les migrations.

**Rang 1 — journald**, procédure complète en tête de `deploy/host/journald-mk.conf` :

1. Relevés, en lecture seule : `systemctl --version | head -1`, `ls -d /var/log/journal`, et
   `docker inspect --format '{{.Name}} {{.HostConfig.LogConfig.Type}}' $(docker ps -q)`.
2. `scp deploy/host/journald-mk.conf <serveur>:/tmp/`, puis sur le serveur : `sudo mkdir -p
   /etc/systemd/journald.conf.d`, `sudo cp`, `sudo systemctl restart systemd-journald`,
   `sudo journalctl --flush`.
3. **Si les conteneurs sont déjà sur `journald`** : c'est fini. **S'ils sont sur `json-file`** :
   ne **pas** lancer `docker compose up -d` maintenant — la bascule des conteneurs part avec le
   rang 2.
4. Vérifier l'effet : `systemd-analyze cat-config systemd/journald.conf | tail -5`,
   `ls -d /var/log/journal`, puis `journalctl -t mk-nginx -n 5` une fois les conteneurs sur
   journald.
5. Reporter le résultat ici et dans [rgpd-registre.md](rgpd-registre.md) (T5).

**Rang 3 — zone nginx `auth`**, à faire **sur le serveur et sur le poste de dev** : même piège
aux deux endroits. La valeur `40r/m` est entrée avec `ad2bf6b` (18/09).

1. Ce que dit le fichier : `grep "limit_req_zone.*zone=auth" nginx/nginx.conf`.
2. Ce que nginx **sert** : `docker compose exec nginx nginx -T 2>/dev/null | grep "limit_req_zone.*zone=auth"`.
3. Lecture :

   | Fichier | Servi | Diagnostic | Geste |
   |---|---|---|---|
   | `40r/m` | `40r/m` | ✅ en place | cocher |
   | `40r/m` | `20r/m` | le piège de l'inode (§6) | `docker compose up -d --force-recreate nginx` puis refaire l'étape 2. Sans risque : ne recrée **que** nginx, qui ne dépend d'aucune migration |
   | `20r/m` | `20r/m` | le dépôt du serveur est antérieur à `ad2bf6b` (18/09) | rien d'isolé : la correction part avec le rang 2. Ne **pas** monter le taux à la main : `ad2bf6b` apporte **aussi** B-01 (`frontend.py`), et l'audit veut B-04 **après** B-01, jamais avant — relâcher le limiteur sans la cause corrigée ne ferait que laisser passer plus d'échecs |

- `[ ]` Rang 1 fait sur le serveur — résultat des relevés :
- `[ ]` Rang 3 vérifié sur le serveur — valeur servie :
- `[x]` Rang 3 vérifié sur le poste de dev — le 2026-09-22 : fichier **et** valeur servie à
  `rate=40r/m`, pas de décalage d'inode.

### 13. Demandes du 2026-09-22

Cinq demandes ajoutées à la liste par l'utilisateur, relevées dans le code le jour même pour
que chacune puisse se reprendre sans refaire l'état des lieux.

#### 13.1 « Supprimer mon compte » → demande par mail — ✅ LIVRÉ le 2026-09-22 (`4472d47`)

**Demandé** : garder le bouton, mais qu'il mène à un message invitant à écrire à `SITE_CONTACT`.
L'effacement direct est jugé trop dangereux.

**Livré :**

- `[x]` **`DELETE /me` et son proxy `/mon-compte/supprimer` sont retirés** — la route, pas
  seulement le bouton : laissée en place, elle restait appelable à la main avec un jeton de
  joueur. Le bouton de `/mon-compte` est gardé et déplie la marche à suivre : écrire à
  `SITE_CONTACT` avec son pseudo Discord, confirmation possible depuis ce compte, réponse sous
  un mois.
- `[x]` **`DELETE /admin/comptes/<id>`, réservée au `superadmin`** (`supprimer_compte`,
  `backEnd/routes_comptes.py`). Capacité de rôle, pas permission délégable. L'effacement
  lui-même est passé dans `_effacer_compte()` **sans changement** — mêmes tables effacées,
  dossier sportif intact, audit écrit *avant*, empreinte au lieu du snowflake. Nouveau : la
  ligne d'audit porte `origine: demande_ecrite` et **le superadmin comme acteur** ; avant, l'acteur
  était le titulaire, et sa ligne perdait son auteur à la suppression.
- `[x]` **Gardes** : confirmation forte par le **handle** Discord retapé (comme le legs, jamais le
  nom affiché), auto-suppression du superadmin refusée (403), `@compte_cible_protegee`, et la
  garde B-02 conservée bien qu'inatteignable tant que le rôle est unique.
- `[x]` **Admin** : bouton « Supprimer le compte » sur la ligne, pour le seul superadmin, avec
  confirmation nommée puis handle retapé.
- `[x]` **Textes** : `/confidentialite` §2.2, §4, §5 et §6 (demande écrite, délai d'un mois,
  vérification d'identité) ; [rgpd-registre.md](rgpd-registre.md) (tableau des droits) ;
  **procédure au §7 de [runbook-admin.md](runbook-admin.md)**, vérification d'identité comprise.
- `[x]` **Tests** : `test_rgpd.py` **61 assertions** (était 33), `test_audit_auth_admin.py`
  (B-02a réécrit sur la nouvelle route), `test_audit_auth_discord.py` (la route porte le garde de
  rang), `test_promotions.py` (formulation). **Trois gardes cassées volontairement** — confirmation
  retirée, rôle abaissé à `admin`, `DELETE /me` rouvert : chacune fait virer des assertions au
  rouge.

**Restent ouverts :**

- `[x]` **Version de la politique : reste à `1.0`** — décidé le 2026-09-22. Le site et sa
  politique sont en reconstruction ; la version ne bougera pas avant la mise en ligne, même
  après plusieurs changements de texte.
- `[ ]` **Le handle n'est pas affiché dans la liste des comptes**, qui ne montre que le nom
  d'usage. C'est lui qu'il faut retaper pour supprimer — et pour léguer, défaut préexistant. Le
  runbook indique où le lire (le profil Discord de qui confirme la demande).
- ⚠️ **Le point sensible s'est déplacé** : ce n'est plus le bouton, c'est le mail. N'importe qui
  peut écrire « supprimez le compte de X » ; seule l'étape 1 du runbook §7 l'arrête.

#### 13.2 Définitions de l'IP v1 / v2 — rang 7 — ✅ CLOS le 2026-09-22

**Demandé** : les définitions affichées sur le site ne sont pas propres. Détail et suivi dans
[affichage-ip-plan-redaction.md](affichage-ip-plan-redaction.md) §9-§10, analyse dans
[affichage-ip-inventaire.md](affichage-ip-inventaire.md).

- `[x]` **Les 5 décisions** (§9 du plan) : les propositions sont toutes retenues — « IP brute »
  / « IP ajustée », virgule dans les textes et point dans les tableaux, calcul parallèle
  supprimé, bonus au minimum non entier expliqué plutôt qu'arrondi, bornes ×0,5 / ×2 tues.
- `[x]` **Phase 1** : `backEnd/textes_ip.py`, seule source des textes, chiffres calculés depuis
  les constantes ; seuils 95/105/115 devenus `IP_SEUIL_*`. ⚠️ Nouveau module **monté** dans
  `docker-compose.yml`, comme les autres.
- `[x]` **Phase 2** : bloc `ip` dans le payload du récap (version du récap) et du classement
  (version du réglage), `ip_textes` dans `/admin/config`.
- `[x]` **Phase 3** : badge de version cliquable et modale partagée (récap, Stakhanov compris,
  et classement), légende des couleurs et ligne du rouge sous chaque tableau, podium en « IP »,
  libellés des graphiques ; Réglages et Saisons au même vocabulaire, version dans la liste des
  récaps et dans la fenêtre de publication.
- `[x]` **Phase 4**, sauf `grand_master` : `compute_ip_evolution` ne calcule plus que la
  version demandée (sortie vérifiée identique), anciennes explications en dur et garde
  `Indicateur de Performance` retirées.
- `[x]` **Tests** : `test_textes_ip.py` (44) et `test_affichage_ip.py` (90), dont un rendu réel
  des partiels et du classement de saison. Quatre gardes cassées volontairement (« 40 % »
  recopié, version par défaut dans le récap, seuil ★ exclusif, clé v1 réintroduite) : chacune
  fait virer une assertion au rouge.
- `[x]` **Recette** : affichage validé par l'utilisateur le 22/09, chantier clos.
- `[x]` **Branches `grand_master` — retirées le 2026-09-23** (`services.py`, `recap.html`, `routes_admin.py`), après vérification sur les 14 dumps de prod : aucune occurrence. La clé interne `candidates['grand_master']` reste (c'est le classement IP). `test_affichage_ip.py` **93 assertions** (était 90). Détail et `UPDATE` de secours au plan, phase 4.
- ⚠️ Ne pas réafficher v1 et v2 côte à côte : c'est retiré exprès depuis le 22/08.

#### 13.3 Bannière d'automne — rang 10

**Intérim en place** depuis le 22/09 : `get_banner_season()` (`frontEnd/frontend.py`) renvoie
`summer` en automne. Avant, `autumn` n'avait aucun style et retombait sur le fond d'hiver par
défaut (`.layer-scrolling-bg`, `banner.css`), sans la neige.

- `[ ]` L'image de fond, sur le modèle des autres saisons (`static/img/banners/`, bande de
  3840 px répétée en X).
- `[ ]` La règle `.hero.smk-snes-banner[data-season="autumn"]` dans `banner.css`. L'été a en plus
  un soleil et un premier plan (`.layer-sun`, `.layer-scrolling-fg`), l'hiver sa neige
  (`snow.js`) : à décider pour l'automne (feuilles qui tombent ?).
- `[ ]` Remettre `return "autumn"` dans `get_banner_season()`.

#### 13.4 Karts : ménage des PNG, ajout de Daisy et Birdo — rang 13

**PNG inutilisés** : dans les dossiers des 8 personnages, seuls les `*-static.png` ne sont
chargés nulle part — sept fichiers, 60 Ko en tout. ⚠️ **Garder `mario/mario-static.png`** : c'est
le favicon de toutes les pages. Les 5 orientations `*-asset-anime/*.png` et les `*-pp.png` sont
toutes utilisées.

**Daisy et Birdo** : les images sont déjà là (`static/img/daisy/`, `static/img/birdo/`, commitées
dans `2053a67` **sans être renommées**), avec les 5 orientations et un portrait. À faire :

- `[ ]` **Renommer pour suivre le modèle** que lit `config.js` (`<nom>/<nom>-asset-anime/<nom>-<dir>.png`,
  `<nom>/<nom>-pp.png`) : le dossier `daisy- asset-anime` contient une **espace**, et le portrait
  de Birdo s'appelle `birdo-pp2.png`. En l'état, aucune des deux ne s'afficherait.
- `[ ]` **Client** : `resources.characters` et `resources.initials` dans
  `frontEnd/static/js/banner/config.js`. ⚠️ Les initiales se **heurtent** : `D` est déjà DK et
  `B` Bowser.
- `[ ]` **Moteur JS** : les stats (`weight`, `power`, `handling`) dans
  `raceEngine/src/config/bodies.js`, et les mesures des sprites, qui se régénèrent avec
  `python3 scripts/sprite-metrics.py`, pas à la main.
- `[ ]` **Moteur C++** : la table des personnages de `raceEngineCpp/src/config/config.hpp`. Le plan
  Rust ([banner/moteur-rust-plan.md](banner/moteur-rust-plan.md)) reprendra la même liste.
- ⚠️ **Décision à prendre : 10 karts par course, ou 8 tirés au sort parmi 10.** Aujourd'hui
  **tous** les personnages courent à chaque course (`world.js` mélange la liste entière), et le
  classement du bandeau a une bulle par personnage. Passer à 10 karts touche la grille de
  départ, la densité sur la piste, la bande passante (1,3 Ko/s par spectateur mesuré à 8) et la
  largeur du classement sur mobile. Puis refaire l'équilibrage au banc (`make race-sim`).

#### 13.5 Contrôles de la bannière : redémarrage, pause, tour, vitesse — rang 14

**Demandé** : retravailler ces quatre éléments. Où ils vivent :

- **Redémarrage** — le bouton de vote, tout à gauche du classement (`leaderboard-vote`,
  `frontEnd/static/js/banner/leaderboard.js`, `toggleVote()` dans `controls.js`). Le serveur
  tient le décompte ; le client n'envoie qu'un changement d'avis.
- **Pause** — le bouton entre la caméra et le vote (`leaderboard-pause`, `togglePause()` dans
  `controls.js`). Il ne fige que **l'affichage local** : la course continue côté serveur.
- **Tour et vitesse** — le cartouche du kart suivi (`focus.js`), affiché seulement quand la
  caméra suit un kart. Les deux se **déduisent** de `totalDistance`, rien n'est ajouté au
  protocole.
- `[ ]` Préciser ce qui doit changer : apparence, placement, comportement.

#### 13.6 Admin/Comptes — actions d'un compte en pop-up — ✅ CLOS le 2026-09-22, validé à l'écran

**Demandé** : retravailler la colonne « Actions » de l'onglet **Comptes** de `/admin/comptes`.

- `[x]` Un **bouton unique** « Actions » (avec le nombre de gestes possibles) par ligne ouvre une **petite modale** (`#modale-actions`, `admin_comptes.html`) titrée au nom du compte. Ligne sans geste possible : un tiret.
- `[x]` Deux groupes : **courants** (synchroniser, désynchroniser, fermer les sessions, permissions, logs), puis, séparés par un trait, **sensibles** (suspendre/réactiver, léguer le superadmin, supprimer).
- `[x]` Fermeture : croix, clic sur le fond, Échap — et automatiquement au clic d'une action, avant son `confirm()` ou le volet déplié.
- `[x]` Habillage : en-tête avatar + rôle/statut, lignes de menu à icône, groupes « Gestion » et « Zone sensible », fond flouté. Validé par l'utilisateur.
- `[x]` Les règles d'affichage de chaque bouton sont inchangées (mêmes conditions, mêmes handlers : les boutons sont seulement déplacés). Onglets liaisons, invitations, logs, bots non touchés. Les 10 fichiers de tests qui lisent ce gabarit restent verts.

#### 13.7 Navbar mobile — connexion Discord hors burger — ✅ FAIT le 2026-09-23, non commité, recette visuelle à faire

**Demandé** : sur téléphone, sortir le lien de connexion Discord du menu burger et le placer à côté, dans un rond, comme l'avatar une fois connecté.

- `[x]` **Rond `connexion-mobile`** dans la `navbar-brand` de `frontEnd/templates/navbar.html`, visible sous 1024 px seulement (`is-hidden-desktop`) : même emprise (2,5 rem), même rond de 1,75 rem et même bordure que l'avatar de `compte-mobile`, fond bleu Discord et icône blanche. Il pousse le burger comme le fait la cloche une fois connecté.
- `[x]` **Le bouton « Se connecter » du menu passe en `is-hidden-touch`** : il reste sur ordinateur, disparaît du burger. **Sur ordinateur aussi, il devient la pilule** (logo + « Se connecter », 2 rem de haut) à la place du bouton Bulma : une seule apparence pour le même geste, CSS commun `.pilule-discord`. Mêmes conditions d'affichage pour les deux (`not compte_joueur and discord_configure`), un seul visible à la fois.
- `[x]` Survol : l'anneau prend la teinte de survol (`interactions.css`), le fond reste bleu.
- `[x]` Tests : `test_revue.py` **25 assertions** (était 19), sur un **rendu réel** du gabarit : le rond est dans la `navbar-brand`, le bouton du menu est masqué au tactile, rien de tout ça une fois connecté. Remplacé le jour même par une **pilule logo + « Connexion »**, même hauteur que l'avatar : le logo seul disait « Discord », pas « se connecter ». Garde cassée volontairement (`is-hidden-touch` retiré) : une assertion vire au rouge. Suite complète : **1940 assertions, 36 fichiers, aucune rouge.**
- `[ ]` **Recette visuelle sur téléphone** (ou mode responsive du navigateur) : alignement de la pilule avec le burger, et place sur un écran de 320 px, à 768 px et en dessous (le burger y passe à 4 rem de haut).

#### 13.8 Notification d'acceptation de promotion — préciser avec le pseudo — ✅ FAIT le 2026-09-23, non commité

**Demandé** : la notification d'acceptation de promotion était trop vague : « Le compte a accepté le rôle chef_admin. »

- `[x]` Le corps porte désormais le **pseudo Discord** de qui répond : « **Toto** a accepté le rôle chef_admin. » (`repondre_promotion`, `backEnd/routes_comptes.py`). Même helper `_pseudo()` que le reste du fichier : `global_name`, repli sur le handle pour les vieux comptes.
- `[x]` **Le refus aussi** (« Toto a refusé le rôle admin. Son rôle reste inchangé. ») : même défaut, même geste. Titres et corps passés en français accentué, comme les autres notifications.
- `[x]` Les autres notifications de rôle n'avaient pas besoin du changement : `promotion_proposee` est adressée **à** la personne concernée, et `changer_role` n'émet aucune notification.
- `[x]` Tests : `test_notifications_liens.py` **20 assertions** (était 16), dont le repli sans `global_name`. Garde cassée volontairement (retour à « Le compte ») : deux assertions virent au rouge. Suite complète : **1934 assertions, 36 fichiers, aucune rouge.**
- ℹ️ Le texte est **figé à l'émission** : les notifications déjà reçues gardent l'ancienne formulation.

#### 13.9 Graphiques : rendre zoomable (comme sur Maps) — à ranger

**Demandé** : les graphiques doivent supporter le **zoom** et le **pan**, comme sur une carte (style Google Maps).

- `[x]` Cible : les 9 graphiques du site, tous sur **Chart.js** — `stats_joueur.html` (1), `recap.html` (5), `classement.html` (1, distribution) + `classement_saison.html` (1), `admin_reglages.html` via `static/js/tier_thresholds.js` (1).
- `[x]` **Phase 0 — Chart.js épinglé (23/09)** : les 4 gabarits (`classement`, `recap`, `admin_reglages`, `stats_joueur`) chargent `chart.js@4.5.1/dist/chart.umd.min.js`. C'est exactement ce que servait l'URL sans version ce jour-là (sha256 identique vérifié), donc aucun changement de rendu. `classement_saison.html` est inclus dans `classement.html` et hérite du script.
- `[~]` **Phases 1 à 4 — Loupe sur les 9 graphiques (23/09), validée sur PC pour les courbes, reste le téléphone** : [frontEnd/static/js/chart_zoom.js](../frontEnd/static/js/chart_zoom.js), `ChartZoom.brancher(chart, options)`, sans dépendance.
  - **Principe, en deux temps** : pendant le geste, le canvas est agrandi par un `transform` CSS (instantané, mais traits et points grossissent). 200 ms après, Chart.js **redessine le graphique à la taille zoomée** (×1 à ×4, `chart.resize(W·z, H·z)`, canvas en absolu dans son parent en `overflow: hidden`) : traits, points, textes et bulles d'info gardent leur taille normale, seules les distances s'étirent, comme sur une carte. Le recalage après redessin repère le centre de la vue en fraction des échelles (`getDecimalForPixel`/`getPixelForDecimal`), la mise en page n'étant pas proportionnelle (les axes gardent leur largeur en pixels). Densité de pixels plafonnée à 12 M pixels réels par canvas (limite iOS ~16,7 M).
  - **Pendant le geste seulement**, un plugin Chart.js global (`chartZoomLoupe`) recalcule la position souris/doigt (`beforeEvent`) et réduit la bulle d'info autour de sa pointe (`beforeTooltipDraw`).
  - **Gestes** : Ctrl + molette ou pincement trackpad (zoom autour du curseur ; la molette seule fait défiler la page, un bandeau rappelle le geste), pincement à deux doigts, glisser une fois zoomé (souris ou doigt), double-clic ou bouton ⟲ pour revenir. Au doigt : `touch-action: pan-x pan-y` non zoomé (la page défile), `none` une fois zoomé. Un clic moins de 300 ms après un glisser est ignoré (pas d'infobulle, de modale ni d'`alert()` du reset en relâchant). Un changement de largeur (rotation, fenêtre) remet la vue complète.
  - **Phases 1-2, courbes par tournoi** (6) : TrueSkill de `stats_joueur`, les 4 courbes de `recap`, l'IP de `classement_saison`.
  - **Phase 3, distributions** (2, `classement` et `recap`) : la mini-bulle HTML posée sur un point passe par `ChartZoom.versVue(chart, x, y)` et se recale à chaque zoom/déplacement (`surChangement`). Corrigé au passage dans `recap` : au toucher d'un point sur mobile, la bulle recevait l'objet du graphique (`name`/`percentile`) au lieu de celui de la légende (`nom`/`top_percent`) et affichait un nom et un pourcentage vides.
  - **Phase 4, tiers de l'admin** : `glisserPermis` réserve l'appui sur une poignée au déplacement du seuil (la vue ne bouge pas), le glisser ailleurs déplace la vue. `pixelXFromEvent` passe par `ChartZoom.depuisEcran` (juste sous transform, au doigt comme à la souris). `touchActionAuRepos: 'none'` garde le comportement d'avant au doigt. Le graphique étant recréé à chaque rechargement des tiers, un nouveau `brancher` défait le précédent (écouteurs via `AbortController`).
  - **Abandonné le même jour** : `chartjs-plugin-zoom@2.2.0` + `hammerjs@2.0.8`. Ce plugin zoome en recalculant les axes, ce qui réarrange le graphique au lieu de l'agrandir, et sur un axe de catégories il ne se déplace que d'un tournoi entier à la fois (`panCategoryScale`), d'où un glisser saccadé. Puis la loupe par simple agrandissement d'image : traits et points grossissaient et empâtaient le graphique (constaté sur PC et téléphone).
- `[ ]` Vérifier au navigateur le redessin à la taille zoomée (phases 1-4), puis sur un vrai téléphone (pincement, défilement de page, infobulle et mini-bulle au toucher une fois zoomé, poignées de l'admin).

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
- ~~Déploiement production~~ — **retiré de cette liste le 2026-09-22** : la prod a
  vraisemblablement reçu la bascule Discord entre le 14 et le 17/09 (voir l'en-tête). Ce qui reste
  à faire est suivi au §12.

## Chantiers soldés récemment (pour mémoire, contexte)

- Sessions figées sur le rôle (A-01/A-02) — ✅ 2026-09-22 (`12d35dc`), recette faite :
  changer de rôle ferme les sessions du compte, filet sur tout écrivain de `comptes.role` (§8).
- Journal des actions admin, phases 1 à 3 — ✅ 2026-09-19 (`c0988fd`, `025af10`) : un seul
  chemin d'écriture, promotion soumise à acceptation, dossier sportif tracé, écran de
  consultation et export CSV. Phase 4 (le filet) livrée le 22/09 (`12d35dc`, §4).
- Banc de scénario exécuté — ✅ 2026-09-21, via l'Electron de VS Code (§10).
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
