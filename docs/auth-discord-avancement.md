# Auth Discord — avancement de l'implémentation

> Suivi de chantier. La conception, les décisions et le registre des risques vivent dans
> [auth-discord-plan.md](auth-discord-plan.md) ; **ce fichier-ci ne dit que ce qui est fait,
> ce qui a été trouvé en chemin, et ce qui reste**. Les codes `R-xx` renvoient au §8 du plan.
>
> **Dernière mise à jour : 2026-09-02** — après une revue complète (§ « Revue du 2026-09-02 »).

## Où on en est

| Phase | État | Contenu |
|---|---|---|
| **0** — correctifs préalables | ✅ faite | R-19, R-01, R-02, R-05, R-20 (partiel) |
| **1** — socle auth | ✅ livrée | schéma, échange OAuth, décorateurs, invitations, nginx |
| **2** — liaison & synchro | ✅ livrée | revendication, file d'attente admin, sync pseudo, rôles |
| **3** — profils joueur | ✅ livrée | bio, couleur, réseaux, URL canonique `/joueur/<id>` |
| **4** — bascule admin | 🟡 partielle | étapes 1-5 et 7 faites · **étape 6 (suppression du mot de passe) bloquée** |
| **5** — API bot | ✅ livrée | 4 routes, matchmaking remonté côté serveur, jetons révocables |
| **6** — RGPD | ✅ livrée | consentement, export, effacement, purges, pages légales |

**Toutes les phases sont livrées sauf l'étape 6 de la phase 4** (suppression effective du mot
de passe), qui attend une décision humaine.

**Rien n'est déployé.** Les deux migrations n'ont pas été appliquées à la production, et
l'application Discord n'existe pas encore. Voir « Ce qui bloque le déploiement » en bas.

---

## Phase 0 — correctifs préalables

| Risque | Ce qui a été fait | Où |
|---|---|---|
| **R-19** | `check_env.sh` ne demande plus que **les clés manquantes** et les **ajoute**. Commentaires, `DOMAIN`, `TLS_MODE`, ports et surtout `SECRET_KEY` préservés à l'octet près, avec sauvegarde `.env.bak` | `scripts/check_env.sh` |
| **R-01** | `DELETE /admin/joueurs/<id>` renvoie **409** si le joueur a des participations, et pointe vers l'anonymisation | `routes_admin.py` |
| **R-02** | Token admin sorti du DOM des 4 templates et de ses consommateurs JS. Purement soustractif : les 23 routes proxy injectaient déjà l'en-tête côté serveur | 4 templates, `gestion.js`, `frontend.py` |
| **R-05** | Clé de cache construite sur les valeurs **normalisées** ; `_cache_store` plafonné à 200 entrées en LRU | `routes_public.py`, `cache.py` |
| **R-20** | `seed.sql` régénéré en fixture fictive, sans réécriture d'historique | `backEnd/seed.sql` |

### Trouvé en chemin

**Deux défauts dans `check_env.sh`**, absents du registre initial :

- Les invites écrivaient sur **stdout**, capturé par la substitution de commande : la valeur écrite
  dans le `.env` contenait les sauts de ligne des invites. Tous les diagnostics passent désormais
  sur stderr.
- `bcrypt_hash` appelle `exit 1` **à l'intérieur d'un `$( )`** : seul le sous-shell mourait, et le
  script écrivait un `ADMIN_PASSWORD_HASH=` **vide** sans rien signaler. Ce défaut existait déjà
  dans la version d'origine. Un garde-fou refuse maintenant toute valeur vide.

**Deux pièges de montage SQL**, capables de faire disparaître les nouvelles tables sans un message :

- L'ancien `seed.sql` faisait ses propres `DROP` + `CREATE`. Monté en `02_`, il **écrasait
  intégralement** ce que `01_schema.sql` venait de créer : toute table ajoutée au schéma aurait
  disparu à la première installation propre. Le nouveau ne contient que des `COPY` — `schema.sql`
  redevient la seule référence de structure, ce qui sert directement R-22.
- `docker-compose.dump.yml` **neutralise `01_schema.sql`** : sur le chemin `make redump`, la
  structure vient entièrement du dump. Restaurer un dump antérieur à l'auth Discord aurait donné
  une base sans tables de comptes, et toutes les routes `/auth` en 500. Les migrations sont
  désormais montées en `04_` et `05_` sur ce chemin ; écrites en `CREATE TABLE IF NOT EXISTS`,
  elles créent ce qui manque et ne font rien sur un dump récent.

---

## Phase 1 — socle auth

**Base** — `migrations/2026-09-02_auth_discord.sql`, miroir dans `schema.sql` (R-22) : 7 tables
(`invitations`, `comptes`, `liaisons_demandes`, `profils`, `sessions_joueurs`, `audit_admin`,
`service_tokens`) + `joueurs.anonymise_at`.

**Backend** — `auth_discord.py` (échange OAuth, miroir Discord, sessions, amorçage),
`routes_auth.py` (`/auth/discord/exchange`, `/auth/logout`, `/auth/me`, `/auth/config`,
`/auth/invitation/<token>`, gestion des invitations), `auth.py` réécrit avec `player_required`,
`role_required`, `admin_or_role_required`, `service_required`.

**Frontend** — `/auth/discord/login`, `/auth/discord/callback`, `/invite/<token>`, `/logout`,
`invite.html`, bloc compte en navbar.

**Infra** — modules montés dans le compose (R-21), variables `DISCORD_*`, zone `limit_req` dédiée
et `location /auth` + `/invite` côté nginx.

**Risques traités dans le code** : R-09 (invitation idempotente à l'affichage — le crawler Discord
qui déroule l'aperçu ne brûle plus le lien), R-11 (timeout dédié 20 s + échange rejouable),
R-12 (`data=` et `redirect_uri` depuis l'env), R-13, R-14, R-15, R-16, R-18, R-28 (503 ≠ 401/403),
R-36, R-39, R-42, R-44, R-45.

---

## Phase 2 — liaison compte ↔ joueur et synchronisation

**Base** — `migrations/2026-09-02_noms_interdits.sql` : table `noms_interdits`, qui stocke le
**sha256 du nom en minuscules** des identités anonymisées, jamais le nom en clair. Elle doit
pouvoir répondre « ce nom est-il interdit ? » sans conserver l'identité qu'on vient d'effacer.

**Backend** — `routes_comptes.py` :

| Geste | Route | Garde-fou |
|---|---|---|
| Lister les fiches revendicables | `GET /auth/joueurs-disponibles` | **R-08** — uniquement les joueurs sans compte et non anonymisés |
| Revendiquer une fiche | `POST /auth/demande-liaison` | 409 lisible sur chaque cas que les index uniques partiels transformeraient en 500 |
| File d'attente admin | `GET /admin/liaisons` | affiche la **concordance avec l'invitation nominative** (R-33) |
| Approuver | `POST /admin/liaisons/<id>/approve` | **R-07** — `FOR UPDATE` sur la demande *et* sur la fiche convoitée, 409 si prise entre-temps |
| Aperçu de synchro | `GET /admin/comptes/<id>/sync-preview` | même verdict que l'écriture, sans écrire |
| Synchroniser le pseudo | `POST /admin/comptes/<id>/sync` | **R-41** — collision insensible à la casse, `/` refusé, `invalidate_cache()`, avant/après audité |
| Changer un rôle | `POST /admin/comptes/<id>/role` | **R-40** — seule route qui écrit `role` · **R-38** — refuse de retirer le dernier `superadmin` |
| Fermer les sessions | `DELETE /admin/comptes/<id>/sessions` | complément au retrait de rôle (R-44) |
| Suspendre | `POST /admin/comptes/<id>/statut` | ferme les sessions dans la foulée, sinon la suspension n'est qu'un libellé |

**R-03 traité** : l'anonymisation pose `joueurs.anonymise_at` et verrouille l'empreinte de l'ancien
nom ; `add_tournament` refuse en **409** de recréer à la volée une identité anonymisée.

**Frontend** — `/mon-compte`, `/mon-compte/liaison`, `/admin/comptes` (trois onglets : demandes,
comptes, invitations) et les proxies JSON. **Aucun jeton ne descend dans le DOM.**

**R-04, la première surface de contenu non maîtrisé.** Les pseudos Discord et les messages de
revendication s'affichent chez un admin. `admin_comptes.html` ne construit **aucun HTML par
concaténation** : chaque valeur passe par `textContent`, et les seules URL d'image acceptées sont
celles commençant par `https://cdn.discordapp.com/`.

### Trouvé en chemin

Les sorties anticipées en 404/409 des routes qui posent un `SELECT … FOR UPDATE` revenaient
**sans `rollback()`**. En pratique `putconn()` de psycopg2 annule la transaction au retour au pool
— ce n'était donc pas une fuite de verrous —, mais rien dans le code ne le disait. Les 15 sorties
concernées les relâchent maintenant explicitement.

---

## Phase 3 — profils joueur

**Backend** — `routes_comptes.py` : `GET/PUT /me/profil` (bio, couleur d'accent, réseaux).
`routes_public.py` : `GET /joueur/<id>`, `GET /joueurs/resolve/<nom>`, et le profil public ajouté
à la charge utile de `/stats/joueur/<nom>`.

**Frontend** — `/joueur/<id>` (fiche canonique), bloc bio + réseaux + avatar sur la fiche
publique, `<link rel="canonical">`. L'écran de réglages `/mon-compte/profil` a été retiré : « Mon
profil » mène désormais à la fiche publique. `GET/PUT /me/profil` survit côté backend, sans proxy
frontend — donc injoignable de l'extérieur tant qu'il n'est pas rétabli.

**Pas d'upload** : l'avatar vient du CDN Discord, conformément à la décision de la phase 1.
R-25 et R-26 restent hors périmètre.

### Le choix qui compte : on stocke un handle, jamais une URL

Un lien de réseau social, c'est une valeur fournie par l'utilisateur qui atterrit dans un `href`.
Laisser saisir l'adresse complète suffirait à placer un `javascript:` sur la fiche publique d'un
joueur, exécuté chez tous ses visiteurs.

Le profil ne stocke donc que l'**identifiant** (`j_sk8`), validé contre
`^[A-Za-z0-9_.\-]{1,50}$`, et l'URL est construite côté serveur depuis une liste blanche de
quatre plateformes. Il n'existe aucun chemin par lequel une valeur saisie devienne un schéma
d'URL. Onze assertions couvrent ce point.

Même logique pour la couleur d'accent : `^#[0-9A-Fa-f]{6}$` strict, puisqu'elle est injectée dans
un attribut `style`.

### R-23 : l'URL canonique

`/joueur/<id>` devient la forme à partager, parce qu'elle survit à un renommage — et le nom va
désormais bouger : synchronisation d'un pseudo Discord, anonymisation, simple correction de faute
de frappe. `/stats/joueur/<nom>` est conservée et redirige en **301**.

Une subtilité de la redirection : si le backend ne répond pas, on sert la page à l'ancienne au
lieu d'émettre la 301. Un navigateur met une 301 en cache — la graver sur la foi d'une résolution
incertaine laisserait une mauvaise redirection derrière soi.

Les 18 liens internes en `/stats/joueur/<nom>` n'ont pas été réécrits : ils fonctionnent via la
redirection. À reprendre si le saut supplémentaire devient gênant.

### ⚠️ Une conséquence à porter dans la politique de confidentialité

L'URL d'avatar publiée sur la fiche joueur est
`https://cdn.discordapp.com/avatars/<discord_id>/<hash>.png`. **Elle contient donc le snowflake
Discord du joueur, en clair, sur une page publique** — cela revient à publier son identifiant
Discord.

C'est inhérent au choix « avatar servi par le CDN, aucune copie stockée », et c'est probablement
assumable dans une communauté qui se connaît. Mais **ce n'est pas une conséquence évidente pour la
personne qui clique « se connecter avec Discord »** : elle doit figurer explicitement dans la
politique de confidentialité (§6.6 du plan). Si elle est jugée gênante, la parade est un
interrupteur par joueur dans `profils` — une colonne et une condition, à décider avant que les
comptes ne s'ouvrent largement.

---

## Phase 4 — bascule de l'admin sur Discord

La phase se découpe en 7 étapes, à faire dans l'ordre. **Six sont faites ; la sixième, celle qui
supprime réellement le mot de passe, ne peut pas l'être sans une décision humaine.**

| # | Étape | État |
|---|---|---|
| 1 | Amorçage du premier `superadmin` | ✅ livré en phase 1 (`DISCORD_SUPERADMIN_ID`) |
| 2 | Les routes admin acceptent les deux voies | ✅ 22 routes sur 23 |
| 3 | Le frontend envoie la bonne voie | ✅ 21 en-têtes, 19 gardes, navbar |
| 4 | Routes super-admin | ✅ livré en phase 2 |
| 5 | Période de recouvrement | ⬜ **à vivre** : administrer via Discord plusieurs jours |
| 6 | Découplage du mot de passe | 🔴 **bloqué** — voir ci-dessous |
| 7 | Runbook break-glass écrit **et testé** | 🟡 écrit ([runbook-admin.md](runbook-admin.md)), **pas testé** |

**Ce qui reste sur le mot de passe, volontairement** : `POST /admin/refresh-token`. Une session
Discord n'a rien à renouveler — son expiration est absolue, c'est ce qui la distingue de l'ancien
`api_tokens` dont le renouvellement sans borne rendait un jeton volé valable indéfiniment.

### Ce qui bloque l'étape 6

R-38 exige trois prérequis avant de couper, et **deux ne dépendent pas du code** :

1. **Au moins deux comptes `superadmin`**, sur deux comptes Discord distincts. Aucun n'existe
   encore. C'est la seule mitigation qui demande une décision humaine.
2. **La procédure break-glass exécutée pour de vrai au moins une fois.** Une procédure jamais
   lancée est une intention, pas une procédure.
3. Une période de recouvrement passée, les deux voies actives.

Quand ce sera fait, l'étape 6 doit être **un seul commit isolé et clairement nommé** : c'est ce
qui rend un `git revert` possible si Discord tombe durablement. Le vrai filet de sécurité est là,
pas dans la procédure.

### Problèmes rencontrés pendant la bascule

Le balayage de 23 routes et 40 points d'appel est exactement le terrain de **R-43** — « une route
dont on retire l'ancien décorateur sans brancher le nouveau reste ouverte ». Trois défauts, dont
un bloquant et un que j'ai introduit moi-même :

**a. 🔴 `/admin/check-token` aurait fermé trois pages aux admins Discord.**
Cette route est la sonde « suis-je toujours admin ? » appelée avant le rendu de *Gestion
TrueSkill*, *Gestion Saisons* et *Gestion Ligues*. Laissée sur `@admin_required` — elle a l'air
d'appartenir au mécanisme du mot de passe —, elle renvoyait 401 à une session Discord, et les
trois pages redirigeaient vers « Session expirée ». **Un admin Discord n'aurait jamais pu les
ouvrir.** Elle accepte désormais les deux voies.

**b. 🟠 `/admin/refresh` envoyait le mauvais en-tête (défaut introduit par le balayage).**
Le remplacement en masse a fait passer ce proxy à `admin_headers()`, qui **préfère la voie
Discord**. Il envoyait donc `X-Session-Token` à `/admin/refresh-token`, restée volontairement sur
`@admin_required` → 401. L'en-tête y est maintenant explicite, avec le commentaire qui dit
pourquoi.

**c. 🟠 Les gardes existaient sous deux formes.**
`if 'admin_token' not in session:` (15 fois) mais aussi `if not session.get('admin_token'):`
(5 fois). Le balayage n'a attrapé que la première. Les quatre proxys concernés — dont
`add-tournament` et `global-reset` — auraient refusé un admin Discord. Rattrapées une par une.

**Leçon pour l'étape 6** : ne pas faire confiance à un `grep` sur une seule forme. Le test
`test_bascule.py` inventorie désormais les décorateurs **par analyse du fichier source**, et
échouera si une route se retrouve sans authentification, ou avec les deux décorateurs empilés
(ce qui donnerait un ET là où on veut un OU).

### Limite connue et assumée

`_est_admin()`, côté frontend, lit le rôle depuis la **copie mise en session à la connexion**.
Un admin rétrogradé à l'instant voit donc encore la page d'administration — mais n'en obtient plus
les données, le backend relisant le rôle en base à chaque requête protégée. La frontière de
privilège est au backend ; la fonction côté frontend n'est qu'une porte d'interface.

Le rafraîchir coûterait un appel réseau sur chaque page **et** chaque proxy, exactement ce que
R-28 demande d'éviter. Si la confusion devient gênante, la parade est de rafraîchir le rôle sur
les seules pages admin, pas sur les proxys.

---

## Phase 5 — API de service pour les bots Discord

Le bot n'existe pas encore : cette phase pose le socle pour qu'il n'y ait plus qu'à le brancher.

**Backend** — `routes_bot.py` : `GET /api/bot/joueurs`, `GET /api/bot/joueur/by-discord/<id>`
(« ce membre Discord, c'est quel joueur ? », la question centrale), `GET /api/bot/classement`,
`POST /api/bot/matchmaking`. Authentification par `Authorization: Bearer <jeton>`, portées
`read:joueurs` / `read:classement` / `matchmaking`.

**Gestion des jetons** — `GET/POST /admin/service-tokens`, `DELETE …/<id>`, réservées au
super-administrateur, plus un onglet dans `/admin/comptes`. Le jeton n'est affiché **qu'une seule
fois** : seule son empreinte part en base, contrairement à l'ancienne table `api_tokens` qui
stockait ses jetons en clair.

**R-24 — l'exposition.** nginx n'est pas sur le réseau `backend` : sans relais, aucune route
`/api/bot/*` n'est joignable depuis internet. Le frontend proxifie, comme il le fait déjà pour
l'administration — zéro changement réseau. Zone `limit_req` propre au bot (60 r/m) : une machine
en boucle d'erreur tape bien plus vite qu'un humain et ne doit pas consommer le budget des pages.

⚠️ **Le proxy bot est exempté de CSRF, et c'est délibéré.** `CSRFProtect` est global sur le
frontend : sans `@csrf.exempt`, **tout POST de bot serait rejeté**, avec un message qui ne
parlerait de rien. La protection CSRF défend un navigateur qui envoie automatiquement un cookie ;
ici l'appelant est une machine qui présente un jeton explicite — il n'y a pas de cookie à
détourner.

**Trois règles de données**, parce qu'un bot est un tiers et pas un administrateur : lecture seule
(un test vérifie qu'aucun `UPDATE`/`INSERT`/`DELETE` n'existe dans `routes_bot.py`), comptes
`linked` seulement (un compte `pending` est une identité **non vérifiée**), et ni bio, ni rôle, ni
invitation, ni audit — publier le rôle désignerait les administrateurs à quiconque possède un
jeton.

### R-06 : le matchmaking quitte le navigateur

`buildLobbies()` vivait dans `matchmaking.html`. Il est désormais dans `services.py`, et la page
d'administration l'appelle par `POST /admin/matchmaking/generer` — **le même code que le bot**.
La page n'envoie que des noms : les scores sont relus en base, sinon un client pourrait composer
les lobbies à sa guise (un test le vérifie en glissant un score dans le corps de la requête).

### 🔴 Un défaut trouvé dans l'algorithme d'origine

**Le matchmaking en production peut produire un lobby de 11 joueurs alors que la limite est 10**,
dans environ **3 % des compositions de 11 à 40 joueurs**. Plus petit cas reproduit : 29 joueurs,
tailles `[9, 11, 9]`.

Le mécanisme : quand le joueur pivot bascule dans le lobby suivant, ce lobby passe à `base+1` ;
à l'itération d'après, il peut recevoir un **second** pivot et atteindre `base+2`. Rien dans le
JS ne l'en empêchait.

Ce n'est pas un défaut de portage — il était là avant, et le lobby produit est simplement
injouable, à rattraper à la main. **Corrigé** : un lobby ne reçoit qu'un seul joueur en plus du
socle. La répartition correcte est d'ailleurs connue d'avance — exactement `pivots` lobbies de
taille `base+1` et `k - pivots` de taille `base` —, le choix ne porte que sur *lesquels*.

⚠️ **Conséquence à connaître : la composition change par rapport à la page actuelle** dans ces
~3 % de cas. Elle passe d'un résultat invalide à un résultat valide, mais elle change.

**Comment ça a été validé.** Aucun runtime JS n'était disponible : les cas attendus ont été
**dérivés à la main** en déroulant le JS d'origine, et non produits par le code testé — comparer
une implémentation à elle-même ne prouverait rien. S'y ajoutent cinq invariants vérifiés sur
400 tirages aléatoires (partition exacte, ordre décroissant préservé, `ceil(n/10)` lobbies,
tailles à ±1, plafond respecté).

---

## Phase 6 — RGPD

**Consentement** — case à cocher sur la page d'invitation, qui rend le bouton Discord inerte tant
qu'elle n'est pas cochée. `comptes.cgu_accepted_at` **et** `cgu_version` : garder la version et pas
seulement la date est ce qui permet de démontrer *quoi* a été accepté. Ces colonnes sont
volontairement absentes du `DO UPDATE` de l'upsert — sinon la date d'origine serait écrasée à
chaque reconnexion, et on ne saurait plus quand la personne a accepté. Les comptes antérieurs se
voient réclamer leur accord depuis `/mon-compte`.

**Accès et portabilité** — `GET /me/export`, téléchargé en JSON depuis `/mon-compte`. Contient le
compte, le profil, les sessions, les demandes de liaison **et le dossier sportif** — qui n'est pas
supprimé avec le compte, raison de plus pour que la personne puisse en obtenir copie.

**Effacement** — `DELETE /me`, immédiat, sans validation d'un tiers. Efface identité Discord,
profil, sessions et demandes. **Ne touche ni `joueurs`, ni `participations`, ni `awards_obtenus`.**
Sept assertions le vérifient table par table, et une huitième qu'aucun `UPDATE joueurs` n'a lieu.

L'audit est écrit **avant** la suppression (la ligne référence le compte), et il consigne une
**empreinte** du snowflake, jamais le snowflake : c'est ce qui permet, après une restauration de
sauvegarde, de repérer un compte ressuscité et de le resupprimer — sans reconserver l'identifiant
qu'on vient d'effacer.

**Purges** — `purger_donnees_expirees()` : sessions expirées, invitations expirées depuis 30 j,
comptes jamais rattachés et inactifs depuis 90 j, refus de liaison de plus d'un an. Trois
garde-fous testés : un compte **lié à un joueur**, un compte **porteur d'un rôle** et un compte
non `pending` ne sont jamais purgés.

⚠️ **Route manuelle, pas tâche planifiée.** Le projet n'a pas d'ordonnanceur, et une purge qui
s'exécute seule sans que personne ne regarde son bilan est une purge dont on ne sait rien.
`POST /admin/purge-rgpd` en renvoie le détail.

**Documents** — `/confidentialite` et `/mentions-legales` (liens en pied de page),
[rgpd-registre.md](rgpd-registre.md) : cinq traitements, leur base légale, leurs durées.

### Les trois points que la politique dit explicitement

Ce sont ceux qu'on aurait pu taire, et c'est précisément pour ça qu'ils y sont :

1. **L'avatar publie l'identifiant Discord.** L'URL affichée sur la fiche publique contient le
   snowflake en clair. Contrepartie assumée du « aucune copie d'image stockée ».
2. **L'historique git conserve de vrais pseudos.** Décision du 2026-09-02 de ne pas le réécrire.
   La politique précise ce qui s'y trouve — des pseudos et des résultats, déjà publics — et ce qui
   ne s'y trouve pas : aucun identifiant Discord, aucune adresse e-mail, aucun mot de passe.
3. **Pourquoi le dossier sportif survit à la suppression.** L'argument du moteur incrémental est
   écrit en toutes lettres, avec l'anonymisation offerte comme recours.

### ⚠️ Les pages légales sont incomplètes tant que le `.env` n'est pas renseigné

`SITE_EDITEUR`, `SITE_CONTACT`, `SITE_HEBERGEUR` : ce sont des informations personnelles (nom,
adresse de contact), elles n'ont pas à être figées dans un dépôt public. Tant qu'elles sont
absentes, les pages affichent « à renseigner » — et sont donc **incomplètes au sens de la loi**.

### Trouvé en chemin

Ajouter `cgu_version` aux requêtes partagées a cassé **cinq fichiers de test d'un coup**, avec des
500 illisibles : toutes les fixtures construisaient leurs lignes en **tuples positionnels** écrits
à la main. Le harness expose désormais `ligne_session()` et `ligne_compte()` — le prochain ajout de
colonne ne touchera qu'un seul endroit.

---

## Revue du 2026-09-02

Relecture de bout en bout, par **vérifications mécaniques** plutôt que par lecture : c'est là que
les écarts se voient. Ce qui a été passé au crible et **n'a rien donné** compte autant que ce qui
a été trouvé.

### Contrôles passés sans écart

| Contrôle | Résultat |
|---|---|
| Chaque appel frontend → backend correspond à une route existante, méthode comprise | ✅ 77 appels |
| Colonnes SQL qualifiées existantes (alias résolus **requête par requête**) | ✅ 52 requêtes |
| Colonnes des `INSERT` et `UPDATE` existantes dans `schema.sql` | ✅ |
| Arité des `SELECT` vs déballage `row[N]` | ✅ |
| Migration ≡ `schema.sql`, colonne par colonne (R-22) | ✅ 8 tables identiques |
| Tous les modules backend montés dans le compose (R-21) | ✅ 13/13 |
| Compatibilité **Python 3.9** (le backend n'est pas en 3.13 comme les tests) | ✅ syntaxe + PEP 604 sous `from __future__` |
| Aucun jeton, code OAuth ou corps de réponse Discord journalisé (R-18) | ✅ |
| `check_env.sh` toujours idempotent | ✅ |

Deux de ces contrôles ont d'abord produit des **faux positifs** de mon vérificateur — mapping
d'alias global (`p.` vaut *participations* dans le code existant, pas *profils*) et arrêt à la
première route correspondante alors que plusieurs règles partagent un chemin. Corrigés avant
conclusion.

### Neuf défauts trouvés, tous corrigés

**F1 🔴 — Un joueur déconnecté ne pouvait plus jamais revenir.**
Le seul lien vers `/auth/discord/login` était sur la page d'invitation — or l'invitation est
consommée. Après une déconnexion ou l'expiration de la session (30 jours), **plus personne ne
pouvait se reconnecter**. Le backend l'autorisait pourtant : un compte existant ne reconsomme
aucune invitation. Il manquait uniquement le bouton.
*Corrigé* : entrée « Se connecter » dans la navbar, visible aux seuls visiteurs non connectés et
seulement si Discord est configuré. **Elle n'ouvre aucune inscription** — créer un compte exige
toujours une invitation, et le refus est explicite pour qui arrive sans compte.

**F2 🟠 — L'anonymisation d'un joueur était injoignable.**
Créée en phase 0, citée dans le message d'erreur 409 du refus de suppression *et* promise dans la
politique de confidentialité — mais sans proxy frontend ni bouton. On refusait donc une
suppression en orientant vers une action impossible, et la mitigation R-01 restait incomplète.
*Corrigé* : proxy ajouté, et le refus de suppression propose désormais l'anonymisation avec un
aperçu de ce qu'elle change.

**F3 🟠 — Un bot recevait ses joueurs listés comme « introuvables ».**
La requête normalise les identifiants Discord en chaînes, mais le calcul des introuvables les
comparait aux valeurs brutes. Un bot envoyant ses snowflakes en **nombres JSON** — ce que fait un
client naïf — obtenait les bons lobbies *et* la totalité de ses joueurs signalés absents.
*Corrigé* : le calcul porte sur les valeurs normalisées.

**F4 🔵 — `isinstance(True, int)` vaut `True` en Python.** Un corps `{"joueur_id": true}` passait
la validation et visait le joueur n°1. *Corrigé* : les booléens sont exclus.

**F5 🔵 — Valider une entrée et en résoudre une autre.** Dans `matchmaking_admin`, la validation
regardait `noms` tandis que le résolveur privilégie `joueur_ids` : fournir les deux validait l'un
et utilisait l'autre. *Corrigé* : exactement une liste, comme la route du bot.

**F6 🔵 — `/auth/config` n'était appelée par personne.** Plutôt que la supprimer, elle sert
maintenant son objet : le bouton de connexion ne s'affiche pas si Discord n'est pas configuré.

**F7 🔵 — `CGU_VERSION` défini des deux côtés sans lien.** Les désaligner ferait afficher une
version et en enregistrer une autre. *Corrigé* : commentaire explicite, et un test échoue si elles
divergent.

**F8 🔵 — L'export ne vérifiait pas son `fetchone()`.** Un compte supprimé entre la validation de
la session et la lecture produisait un `TypeError` en 500. *Corrigé* : 404.

**F9 🟠 — « Fermer les sessions » était un bouton mort pour un admin par mot de passe.**
Trouvé en répondant à une question sur ce que fait ce bouton. La page `/admin/comptes` s'ouvre aux
**deux** voies d'authentification, et affiche cette action pour tous les comptes — mais la route
était protégée par `role_required(ROLE_ADMIN)`, qui exige une session Discord. Un administrateur
connecté par mot de passe voyait donc le bouton et recevait « Authentification requise » en le
cliquant. Même famille que F1 et F2 : une fonction présente mais inatteignable par le chemin qui
la propose.
*Corrigé* : `admin_or_role_required`. Les autres routes en `role_required` sont, elles, légitimes —
elles sont réservées au super-administrateur, et l'interface masque leurs commandes derrière
`est_superadmin` : jamais visibles, donc jamais mortes.

Les neuf sont verrouillés par `test_revue.py` (19 assertions) : le but n'y est pas de décrire le
comportement voulu — les autres fichiers s'en chargent — mais d'empêcher **ces défauts précis** de
revenir.

### ⚠️ Point d'exploitation relevé au passage

**Le service `frontend` n'a aucun volume dans le compose.** Contrairement au backend, ses fichiers
sont uniquement embarqués par `COPY` dans l'image. Les **7 nouveaux templates et toutes les
modifications de `frontend.py` n'apparaîtront qu'après un `make build`** — un simple
`docker compose restart` ne suffira pas. C'est le comportement d'origine du projet, pas une
régression, mais il devient piégeur maintenant que le frontend porte autant de code.

---

## Tests

`backEnd/tests/run.sh` — **224 assertions**, 9 fichiers, sans Postgres ni Discord : le curseur est scripté et
l'API Discord simulée. Seul `flask` est requis.

| Fichier | Couvre |
|---|---|
| `test_auth.py` | consommation d'invitation, idempotence du rejeu, refus d'un compte suspendu, amorçage du superadmin **et son refus quand il en existe déjà un**, durées de session par rôle, avatar de repli |
| `test_decorators.py` | hiérarchie des rôles, 503 sur base indisponible, sessions expirées, scopes de l'API bot |
| `test_liaisons.py` | R-07 (course à l'approbation), R-08, R-41 (collisions de nom), R-38 (dernier superadmin), R-40 |
| `test_bascule.py` | inventaire des décorateurs par analyse du source (aucune route ouverte, aucun ET déguisé), OU strict du décorateur de transition, unicité du point d'écriture de `comptes.role` |
| `test_bot.py` | portées, lecture seule, ce que l'API ne publie pas, snowflake en chaîne, scores non falsifiables |
| `test_matchmaking.py` | fidélité du portage (cas dérivés à la main) et invariants sur 400 tirages |
| `test_revue.py` | non-régressions des 9 défauts trouvés en revue (F1 à F9) |
| `test_rgpd.py` | effacement (le dossier sportif est intact, table par table), audit avant suppression, empreinte au lieu du snowflake, export complet, garde-fous des purges |
| `test_profils.py` | validation des réseaux (`javascript:`, `data:`, URL complète, échappement d'attribut), couleur, liste blanche des champs éditables, contenu du profil public |

`run.sh` affiche un décompte final et nomme les fichiers en échec : un fichier qui plante à
l'import n'affiche aucune assertion, et son absence passerait autrement inaperçue au milieu des
autres — c'est arrivé une fois, quand `routes_comptes` s'est mis à importer `services`.

**Limite à connaître : ces tests ne valident pas le SQL.** Ni docker, ni psql, ni Postgres embarqué
n'étaient disponibles pendant l'implémentation. Une passe sur une vraie base reste nécessaire avant
la production — c'est le premier point de la liste ci-dessous.

---

## Ce qui bloque le déploiement

0. **`make build`** et non un simple `restart` : le frontend n'a pas de volume monté.
1. **Appliquer les deux migrations à la prod**, à la main, dans l'ordre
   (`2026-09-02_auth_discord.sql` puis `2026-09-02_noms_interdits.sql`), avec un dump de contrôle
   avant/après. C'est aussi la première vraie validation du SQL.
2. **Créer l'application Discord** et renseigner `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
   `DISCORD_REDIRECT_URI` et `DISCORD_SUPERADMIN_ID`. Le `redirect_uri` doit être déclaré
   **au caractère près** dans le portail développeur, sinon Discord refuse sans message utile.
3. **Désigner un second compte `superadmin`** (R-38). C'est la seule mitigation qui demande une
   décision humaine et pas du code — et elle conditionne l'étape 6 de la phase 4.
4. **Renseigner `SITE_EDITEUR`, `SITE_CONTACT`, `SITE_HEBERGEUR`** dans le `.env` — sans quoi
   les pages légales sont incomplètes.
5. **Exécuter la procédure break-glass une fois** ([runbook-admin.md](runbook-admin.md) §3.1),
   pour vérifier qu'elle fonctionne avant d'en dépendre.

## Décisions prises en cours de route

- **2026-09-02, R-20** : `seed.sql` assaini, mais **ni réécriture de l'historique git, ni passage
  du dépôt en privé**. Les vrais pseudos restent donc accessibles dans les commits antérieurs d'un
  dépôt public. À écrire noir sur blanc dans la politique de confidentialité (§6.6 du plan) :
  c'est une donnée du dossier RGPD, plus un risque ouvert.
- **Pas d'upload d'image en v1** : l'avatar vient du CDN Discord. R-25 et R-26 sont hors périmètre
  tant qu'il n'y a pas de bannière.
- **Réseaux sociaux : handle et non URL.** Quatre plateformes en liste blanche (Twitch, YouTube,
  Bluesky, X). En ajouter une, c'est une ligne dans `RESEAUX_CONNUS`.

## Pour brancher un bot le jour venu

1. Créer un jeton dans `/admin/comptes`, onglet **Jetons de bot** (super-administrateur requis),
   en cochant les seules portées nécessaires. Le copier immédiatement : il ne réapparaîtra pas.
2. Le bot appelle `https://<domaine>/api/bot/…` avec `Authorization: Bearer <jeton>`.
3. Pour associer un membre Discord à un joueur : `GET /api/bot/joueur/by-discord/<snowflake>`.
   Le `discord_id` est **toujours une chaîne** dans le JSON — un snowflake dépasse 2^53 et se
   corrompt silencieusement dès qu'un client le lit comme un nombre.
4. Pour composer des lobbies : `POST /api/bot/matchmaking` avec `{"discord_ids": [...]}`.
   Les joueurs non reconnus sont renvoyés dans `introuvables` plutôt que silencieusement ignorés.

Révoquer un jeton coupe l'accès immédiatement, sans redéploiement.

## Questions encore ouvertes

Reprises du §10.2 du plan, celles qui touchent l'implémentation à venir :

- **Rapprochement en masse ?** La liaison se fait une fiche à la fois. Avec ~30 joueurs c'est une
  demi-heure de clics. Un écran de rapprochement groupé se greffe mal après la phase 3.
- **Durée de session admin** : 12 h aujourd'hui, contre 30 jours pour un joueur. À confirmer.
- **Couleur** : `profils.couleur_accent` sert aujourd'hui de liseré sur la fiche publique, et
  `joueurs.color` continue de piloter les graphes. Les deux cohabitent sans se marcher dessus,
  mais si le joueur doit pouvoir choisir sa couleur de courbe, il faut trancher.
- **Avatar public** : faut-il un interrupteur pour ne pas exposer le snowflake Discord ? (voir
  phase 3)
- **Multi-comptes** (R-34) : sujet à traiter ou non-sujet ?
