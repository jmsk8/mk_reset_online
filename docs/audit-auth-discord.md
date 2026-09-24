# Audit de l'authentification Discord — état des lieux

> **Nature de ce document.** Ce n'est ni un plan ni un suivi de chantier : c'est un **état de
> l'auth Discord à une date donnée**, constat par constat, avec ce qui tient et ce qui ne tient
> pas. La conception vit dans [auth-discord-plan.md](auth-discord-plan.md), l'avancement dans
> [auth-discord-avancement.md](auth-discord-avancement.md), la couche rôles dans
> [hierarchie-admin-avancement.md](hierarchie-admin-avancement.md).
>
> **Date de l'audit : 2026-09-15.** Périmètre : `backEnd/auth.py`, `backEnd/auth_discord.py`,
> `backEnd/routes_auth.py`, `backEnd/routes_comptes.py`, `backEnd/routes_admin.py`,
> `backEnd/routes_bot.py`, `frontEnd/frontend.py`, `nginx/`, les deux migrations d'auth.
> Les quatre rôles (`player`, `admin`, `chef_admin`, `superadmin`) ont été suivis de bout en bout.
>
> **Chaque constat est prouvé par exécution**, pas par lecture : voir
> `backEnd/tests/test_audit_auth_discord.py` (82 assertions au 2026-09-23, toutes vertes).

---

## Verdict en une page

Le socle est **sain et bien pensé**. Les pièges classiques de l'OAuth sont tous évités, et
souvent commentés à l'endroit exact où quelqu'un serait tenté de « simplifier » : `state`
comparé en temps constant et à usage unique, secret Discord confiné au backend, token de session
jamais stocké en clair ni descendu dans le DOM, invitation consommée seulement à l'échange,
`role` relu en base à **chaque** requête protégée, distinction 401/403/503 tenue partout.

Les défauts trouvés ne sont **pas des trous d'autorisation** — je n'ai trouvé aucun chemin
permettant à un compte d'obtenir un droit qu'il n'a pas. Ils portent tous sur le **cycle de vie
des sessions** : une session, une fois ouverte, est trop difficile à reprendre.

| # | Constat | Gravité | Nature |
|---|---|---|---|
| **A-01** | ~~La durée de session est figée sur le rôle **au moment de la connexion**~~ | ✅ **corrigé 2026-09-22** | Session |
| **A-02** | ~~Changer le rôle d'un compte ne ferme aucune de ses sessions~~ | ✅ **corrigé 2026-09-22** | Session |
| **A-03** | ~~Personne ne peut voir ni fermer **ses propres** sessions~~ | ✅ **corrigé 2026-09-16** | Session |
| **A-04** | ~~`/admin-auth` (mot de passe partagé) est toujours ouvert~~ | ✅ **corrigé 2026-09-23** | Dette |
| **A-05** | ~~`api_tokens` stocke le jeton **en clair**, renouvelable sans borne~~ | ✅ **corrigé 2026-09-23** | Dette |
| **A-06** | Se reconnecter n'invalide aucune session existante | 🟡 faible — **choix acté** (voir A-06) | Session |
| **A-07** | ~~Le consentement CGU est affiché mais jamais **imposé**~~ | ✅ **corrigé 2026-09-24** | RGPD |

Aucun constat n'est 🔴. Les trois 🟠 se corrigent ensemble, et partagent une seule cause.
**Tous trois sont refermés** : A-03 le 2026-09-16, A-01 et A-02 le 2026-09-22.

**Au 2026-09-23, six constats sur sept sont refermés.** A-04 et A-05 sont tombés ensemble avec
l'étape 6 de la phase 4, comme la recommandation §3 le prévoyait.

**Au 2026-09-24, les sept sont traités** : A-07 est tranché dans le sens de l'imposition (voir
A-07). A-06 reste un choix acté, pas un défaut ouvert.

---

## La cause commune des trois constats 🟠

`create_session(cur, compte_id, role, user_agent)` lit le rôle **une fois**, à la connexion, et
en déduit une expiration absolue :

```python
if role == ROLE_PLAYER:
    expires_at = now + timedelta(days=SESSION_JOUEUR_LIFETIME_DAYS)   # 30 jours
else:
    expires_at = now + timedelta(hours=SESSION_ADMIN_LIFETIME_HOURS)  # 12 heures
```

L'intention est explicite et juste : *« un compte privilégié ouvre bien plus de portes : session
courte »*. Mais la durée est **gravée dans la ligne** au moment de l'`INSERT`, alors que le rôle,
lui, est relu en base à chaque requête. Les deux ne sont jamais resynchronisés.

### A-01 / A-02 — ✅ CORRIGÉS le 2026-09-22

> **Résolu, par la recommandation n° 1 ci-dessous : une seule règle, « changer de rang oblige à
> se reconnecter ».** Toute écriture de `comptes.role` ferme les sessions du compte concerné,
> dans les deux sens. Il y a **quatre** écrivains, et les quatre la portent :
>
> | Écrivain | Sessions fermées |
> |---|---|
> | `changer_role` (rétrogradation, et promotion directe) | celles de la cible — jamais l'acteur, que `refuse_auto_modification` écarte |
> | `repondre_promotion` (acceptation) | **toutes** celles du titulaire, **la courante comprise** : c'est la session de joueur (30 jours) qui vient d'accepter |
> | `leguer_superadmin` | celles de la cible **et** de l'acteur : deux rôles changent |
> | `promote_bootstrap_superadmin` | les anciennes, **avant** que `login()` crée la nouvelle à la bonne durée |
>
> La durée reste figée à la création dans `create_session` — une seule source de vérité. La
> recalculer (`UPDATE … SET expires_at`) aurait été une seconde source de vérité, exactement ce
> qui a produit le défaut ; un test interdit ce chemin.
>
> **Côté personne**, la déconnexion n'est jamais muette : la carte d'acceptation prévient
> *avant* le clic, puis la page relance la connexion Discord (avec l'écran d'autorisation à
> valider depuis le 2026-09-24 : `prompt=consent` a remplacé `prompt=none`) ; le legs fait de même pour l'ancien
> superadmin. Un message déposé par le frontend explique la reconnexion au retour. La cible d'une
> rétrogradation, elle, se retrouve simplement déconnectée à sa prochaine page — la confirmation
> côté admin le dit.
>
> **Couverture** : `backEnd/tests/test_sessions_changement_role.py` (47 assertions), dont un
> **filet** qui parcourt tout le backend et rougit sur toute fonction écrivant `comptes.role`
> sans fermer de session. Chaque garde a été cassée volontairement (7 mutations, plus un
> cinquième écrivain fictif) : toutes font virer des assertions au rouge.
>
> ⚠️ **Piège rencontré en corrigeant** : l'assertion `defaut()` de A-02 lisait une fenêtre fixe
> de 6000 caractères depuis `def changer_role(`, et le `DELETE` ajouté tombait à 6741. Elle
> serait restée **verte sur un défaut corrigé** — le rouge que ce dispositif existe pour
> produire ne serait jamais venu. Remplacée par une délimitation `ast`. Tout `not in` sur une
> fenêtre fixe a le même risque.

Les constats d'origine, conservés pour le contexte.

### A-01 — la durée ne suit pas la promotion

Un joueur se connecte lundi : session de **30 jours**. Mardi, un chef_admin le promeut `admin`.
Sa session reste valable **29 jours**, alors que la règle destine 12 heures à un compte de ce rang.
Il obtient immédiatement tous les droits d'admin (le rôle est relu à chaque requête — c'est
correct), mais avec la durée de vie d'un compte joueur.

L'écart est d'un facteur **60**. C'est exactement la propriété que
`SESSION_ADMIN_LIFETIME_HOURS` existe pour garantir, et elle ne tient pas pour tout compte promu
après coup — c'est-à-dire, en pratique, pour **tous** les admins : personne ne naît admin, on le
devient.

> Prouvé par `test_audit_auth_discord.py`, section A-01.

### A-02 — la rétrogradation ne ferme rien

`changer_role` ne contient aucun `DELETE FROM sessions_joueurs`. C'est **sans conséquence sur les
droits** : `_charger_compte_session` relit `comptes.role` à chaque requête, un rétrogradé perd ses
droits instantanément. Le commentaire du code le dit, et il a raison.

Mais deux choses restent :

- une **promotion** laisse une session longue (c'est A-01, vu depuis l'autre bout) ;
- après rétrogradation, la session **reste ouverte**. Ce n'est pas un droit de trop, c'est une
  ceinture manquante : `revoquer_sessions` existe précisément pour ça, et un admin doit
  aujourd'hui penser à l'appeler **à la main** après chaque changement de rôle.

Par contraste, les deux routes qui *doivent* fermer les sessions le font bien : `changer_statut`
(suspension) et `supprimer_mon_compte`. La suspension a même le bon commentaire : *« sans fermer
les sessions, la suspension ne serait qu'un libellé d'affichage »*. Le même raisonnement
s'applique au changement de rôle, il n'y a juste pas été appliqué.

### A-03 — aucune reprise en main par le titulaire — ✅ CORRIGÉ le 2026-09-16

> **Résolu.** `GET /auth/mes-sessions` liste les sessions actives du titulaire et
> `DELETE /auth/mes-sessions` ferme les autres, épargnant la session courante par défaut. L'écran
> « Vos appareils connectés » vit dans `/mon-compte`. Couverture : `backEnd/tests/test_mes_sessions.py`
> (57 assertions), dont les deux qui portent le reste — le `token_hash` ne sort jamais dans la
> réponse, et le `DELETE` ne peut toucher aucun autre `compte_id`.
>
> Trois décisions à connaître : pas de révocation par appareil (il n'existe aucun identifiant de
> session exposable, la clé primaire *est* le secret), le `user_agent` est résumé en libellé issu
> d'une liste fermée plutôt que rendu brut, et le geste ne laisse **aucune trace consultable**
> (`audit_admin` trace ce qu'un admin fait à autrui, pas ce qu'un titulaire fait chez lui).
> Conception : [mes-sessions-actives-plan.md](mes-sessions-actives-plan.md) et
> [mes-sessions-actives-preparation.md](mes-sessions-actives-preparation.md).

Le constat d'origine, conservé pour le contexte. Inventaire complet de ce qui existait :

| Geste | Qui peut | Route |
|---|---|---|
| Fermer **la** session courante | le titulaire | `POST /auth/logout` |
| Fermer **toutes** les sessions d'un compte | un admin `gestion_comptes` | `DELETE /admin/comptes/<id>/sessions` |
| **Lister** ses sessions | le titulaire, **en export RGPD uniquement** | `GET /me/export` |
| **Fermer** ses autres sessions | *personne* | — |

Le titulaire peut donc **voir** ses sessions actives (elles figurent dans l'export RGPD, avec
`user_agent`, `created_at`, `last_seen_at`) mais n'a **aucun moyen de les fermer**. Quelqu'un qui
soupçonne un vol de token doit contacter un administrateur.

C'est d'autant plus dommage que **toute la donnée nécessaire est déjà là** : la table
`sessions_joueurs` stocke déjà `user_agent` et `last_seen_at`, et le commentaire de la migration
dit explicitement *« `user_agent` suffit à un écran "vos sessions actives" »*. L'écran a été
prévu, il n'a pas été construit.

---

## Vol de token : ce qui protège déjà

C'est la partie la plus solide de l'audit. Point par point, ce qui est **déjà correct** et doit
le rester (chaque ligne est une assertion de non-régression dans la suite de tests) :

| Protection | Où | Détail |
|---|---|---|
| Token jamais stocké en clair | `auth_discord.py` | Seul le `sha256` va en base. Une fuite du dump ne donne aucun token utilisable. |
| Entropie suffisante | `create_session` | `secrets.token_urlsafe(32)` = 256 bits. |
| Token jamais dans le DOM | `frontend.py` | Il vit dans la **session serveur** Flask ; le navigateur ne voit qu'un cookie signé. C'était le correctif R-02, il tient. |
| Cookie `HttpOnly` | `frontend.py` | Un XSS ne peut pas lire le cookie. |
| Cookie `Secure` en https | `frontend.py` | Suit `TLS_MODE`, pour ne pas casser le dev local. |
| Cookie `SameSite=Lax` | `frontend.py` | `Strict` casserait le retour de Discord — le commentaire le dit, ne pas « corriger ». |
| CSRF global | `frontend.py` | `CSRFProtect(app)`. |
| Expiration **absolue** | `constants.py` | Aucune route ne prolonge `expires_at`. C'est ce qui distingue `sessions_joueurs` de l'ancienne `api_tokens`. |
| Secret Discord confiné | `auth_discord.py` | Le frontend ne connaît que `CLIENT_ID` et `REDIRECT_URI`, jamais le secret. |
| Rien de sensible dans les logs | `auth_discord.py` | Seuls les codes HTTP sont journalisés : le corps contient le code OAuth et l'`access_token`. |
| Rate limiting dédié | `nginx/` | Zone `auth` à 20 r/min, séparée de `admin` et `bot` pour qu'un bourrage n'épuise pas le budget des autres. |
| En-têtes de sécurité | `nginx/` | `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS en https. |

### Le `state` OAuth

Correctement implémenté, ce qui est plus rare qu'il n'y paraît :

- comparé avec `secrets.compare_digest` (temps constant) ;
- **à usage unique** — retiré par `session.pop`, donc un rejeu échoue ;
- un `state` absent ou vide est refusé explicitement.

Sans cela, un tiers pourrait faire consommer **son** code d'autorisation par le navigateur de la
victime, et lier ce navigateur à son propre compte Discord (*login CSRF*). Le chemin est fermé.

L'invitation, elle, **ne transite pas par Discord** : elle reste en session serveur plutôt que
dans le paramètre `state`. Elle n'apparaît donc pas dans les logs de Discord.

### Validation des données venues de Discord

Le snowflake finit dans un **chemin d'URL** (le CDN des avatars) : il est validé par
`RE_SNOWFLAKE` avant tout usage, et une valeur non numérique fait échouer la connexion. Le hash
d'avatar est validé aussi, mais **dégrade** au lieu de bloquer — perdre une image ne justifie pas
de refuser une connexion. Les champs texte sont tronqués à 64 caractères avant la base. Tout cela
est testé, y compris avec un `id` contenant `../../`.

### Ce qui reste exposé, et pourquoi c'est acceptable

Le cookie de session Flask est le **seul** porteur d'authentification côté navigateur. S'il est
volé (XSS sur le frontend, vol de machine, extension malveillante), l'attaquant obtient la session
— c'est vrai de toute application à cookie, et `HttpOnly` couvre le cas le plus courant.

Ce qui manque n'est pas une protection supplémentaire mais une **capacité de reprise** : c'est
exactement A-03 et A-06. Aujourd'hui, la victime d'un vol ne peut rien faire seule, et se
reconnecter — le réflexe naturel — **n'invalide pas** le token volé (A-06) : chaque connexion
ajoute une ligne sans toucher aux précédentes. Le seul ménage effectué porte sur les sessions
**déjà expirées**.

> **Mise à jour du 2026-09-16 — A-03 corrigé, A-06 devient un choix assumé.**
>
> La capacité de reprise existe désormais (voir A-03 ci-dessus). **A-06 reste vrai dans les faits
> et le restera : `login()` n'a pas changé.** Ce n'est pas un reste à faire.
>
> Fermer automatiquement les anciennes sessions à chaque connexion réglerait A-06 sur le papier,
> mais casserait l'usage normal « mon téléphone **et** mon PC », qui est légitime et fréquent. La
> bonne réponse est de rendre le ménage **possible et visible**, pas obligatoire : c'est ce que
> fait le bouton « Déconnecter les autres appareils ». Le réflexe de la victime n'est plus « me
> reconnecter en espérant », c'est un geste explicite qui fait ce qu'il annonce.
>
> L'assertion correspondante de `test_audit_auth_discord.py` reste donc **volontairement rouge** :
> elle constate un comportement choisi, pas un défaut en attente. La lever reviendrait à prétendre
> que `login()` fait une rotation — ce qui serait faux.

---

## Le parcours, rôle par rôle

Suivi de bout en bout pour les quatre rôles. Rien d'anormal trouvé sur les autorisations.

### Un joueur (`player`)

1. Reçoit un lien `/invite/<token>`. L'affichage est **strictement idempotent** : le crawler
   Discord qui déréférence le lien collé dans un salon ne brûle pas une invitation `max_uses=1`.
   Piège classique, correctement évité.
2. `/auth/discord/login` → `state` en session, redirection vers Discord, scope `identify` seul
   (ni email, ni guilds — minimisation RGPD réelle, pas déclarative).
3. Retour sur `/auth/discord/callback` → vérification du `state` → le backend échange le code.
4. `login()` fait tout en **une transaction** : compte, invitation consommée, session. Soit les
   trois existent, soit rien n'a eu lieu.
5. L'échange est **idempotent** : un compte existant n'a pas besoin d'invitation, donc un
   frontend qui abandonne en cours de route ne laisse pas l'utilisateur avec une invitation
   consommée et pas de compte.
6. Session de 30 jours. Statut `pending` jusqu'à rattachement à une fiche joueur.

### Un `admin`

Promu par un `chef_admin` ou le superadmin. Ne détient que les permissions qu'on lui accorde
**une par une** (`permissions_admin`). Deux garde-fous notables :

- une **sous-permission ne vaut rien sans son parent** : `rgpd_joueurs` sans `gestion_joueurs` ne
  donne aucun droit, et la règle est appliquée **au backend**, pas seulement dans l'interface —
  un octroi direct par l'API ne contourne rien ;
- il ne peut **pas agir sur un pair admin** : c'est `compte_cible_protegee`, la correction du
  2026-09-14. Vérifié exhaustivement sur les 9 combinaisons de rangs.

~~Hérite du défaut **A-01** : promu depuis `player`, il garde une session de 30 jours.~~
✅ Plus depuis le 2026-09-22 : accepter la promotion ferme ses sessions, il se reconnecte en 12 h.

### Un `chef_admin`

Socle = **le catalogue entier**, par construction. Ne peut pas désigner un pair (seul le
superadmin le fait), ni toucher un autre `chef_admin` (règle de rang). Le retrait du **dernier**
`chef_admin` exige une confirmation nommée — pas un clic silencieux.

### Le `superadmin`

Unique à tout instant, garanti par un **index unique partiel** en base. Trois écrivains seulement
pour ce rôle, et c'est documenté à chacun :

1. l'amorçage par `DISCORD_SUPERADMIN_ID` ;
2. le legs (transaction atomique : rétrograder **puis** promouvoir — l'ordre inverse viole
   l'index, ce n'est pas un cas limite mais un échec systématique, et le commentaire le dit) ;
3. `changer_role`, qui ne pose **jamais** `superadmin`.

**L'amorçage est propre.** `peut_amorcer_sans_invitation` et `promote_bootstrap_superadmin`
appliquent des conditions **strictement identiques**, et un test verrouille cette symétrie. Le
raisonnement est le bon : laisser entrer quelqu'un que la promotion refuserait ensuite créerait un
`player` ordinaire ne devant son existence qu'à une variable d'environnement. La troisième
condition (« aucun superadmin existant ») **referme définitivement** la porte après le premier
déploiement — ce n'est pas une porte dérobée permanente. Vérifié par exécution, y compris qu'un
autre `discord_id` n'en profite jamais.

---

## ✅ A-04 et A-05 — refermés le 2026-09-23

L'étape 6 de la phase 4 a supprimé le mot de passe partagé. Ce qui était constaté le
2026-09-15, et qui n'existe plus :

- **`POST /admin-auth`** était exposé sans rate limiting applicatif (seul nginx protégeait,
  zone `admin` à 30 r/min) et délivrait encore un jeton ;
- **`api_tokens` stockait le jeton en clair** — pas de `sha256`, contrairement à
  `sessions_joueurs` ;
- **`/admin/refresh-token`** le renouvelait **sans borne absolue** : précisément le défaut que
  `sessions_joueurs` a été créée pour corriger ;
- côté frontend, `_est_admin()` renvoyait vrai sur un simple `admin_token`, et le formulaire
  `/admin` était toujours servi.

Les quatre sont partis dans le même commit, avec `admin_required`, `admin_or_role_required`,
`ADMIN_PASSWORD_HASH` et une migration `DROP TABLE api_tokens`. Inventaire complet :
[auth-discord-avancement.md](auth-discord-avancement.md), « ✅ L'étape 6 ».

**Ce qui rendait ces constats 🟡 et non 🔴 mérite d'être gardé en mémoire**, parce que c'est le
raisonnement qui a permis de ne pas les traiter dans l'urgence : le jeton obtenu n'ouvrait plus
aucune route métier depuis le 13/09. Un attaquant qui aurait deviné le mot de passe aurait
obtenu un jeton capable de se renouveler indéfiniment… et de rien d'autre côté backend. Il
aurait en revanche vu s'ouvrir les **pages** d'administration côté frontend, qui se seraient
remplies d'erreurs.

C'était donc une **dette**, pas une brèche — mais une dette qui ressemblait à une brèche, ce qui
est la pire des dettes : le jour où quelqu'un aurait remis `@admin_or_role_required` sur une
route « pour dépanner », elle en serait redevenue une. **C'est exactement ce que `test_bascule.py`
interdit désormais**, en refusant les noms de ces décorateurs n'importe où dans le backend.

**Les huit assertions `defaut(...)` qui décrivaient ces deux constats sont devenues des
non-régressions** dans `test_audit_auth_discord.py`. Le mécanisme a fonctionné comme prévu :
elles ont rougi à la correction, et c'est leur rougissement qui a dit où venir écrire ces lignes.

---

## A-07 — le consentement CGU n'est jamais imposé

`comptes.cgu_version` est renseigné à la première connexion et exposé par `cgu_a_accepter`, que
l'interface utilise pour afficher une invitation à accepter. Mais **aucun décorateur ne refuse**
une session dont le consentement manque ou porte une version périmée : `player_required` lit
`cgu_version` et le transmet, sans jamais en tirer de conséquence.

Concrètement, changer `CGU_VERSION` affiche une bannière et ne bloque rien. Pour un site de
classement entre amis, c'est défendable ; c'est un **choix**, et il mérite d'être écrit plutôt que
d'être une omission. Si l'intention était de bloquer, le point d'application naturel est
`player_required`, avec une liste blanche pour les routes d'acceptation et de déconnexion.

### ✅ Tranché et corrigé le 2026-09-24 : le consentement est imposé

- **Backend, la frontière.** `_charger_compte_session` (`auth.py`), par où passent les trois
  décorateurs, refuse une session dont `cgu_version` n'est pas la version courante :
  **428 `cgu_a_accepter`**. Ni 401 ni 403, que le frontend purge (R-28) : la session est
  valide, il lui manque un accord. Le contrôle vient après l'expiration et la suspension (un
  compte suspendu l'apprend d'abord), et avant `last_seen_at`.
- **Liste blanche** : `player_required_sans_cgu`, sur quatre routes seulement :
  `/auth/check-session` (la sonde doit pouvoir dire « à accepter »), `/me/cgu`
  (l'acceptation), `/me/export` (le droit d'accès ne dépend pas de l'accord) et `/avatar/moi`
  (la navbar). La déconnexion n'en a pas besoin : elle ne demande aucune session valide.
- **Frontend.** La sonde de chaque page recopie `cgu_a_accepter` ; une page HTML renvoie alors
  vers **`/consentement`** (accepter, télécharger ses données, se déconnecter, ou demander la
  suppression par mail), puis ramène à la page demandée, par un chemin local uniquement.
  Le retour de Discord y mène directement. Le bandeau de `/mon-compte` est retiré.
- **Qui est concerné** : les comptes créés hors invitation (amorçage du superadmin), ceux
  antérieurs à la politique, et tout le monde le jour où `CGU_VERSION` change. Une invitation
  exigeait déjà la case cochée.
- **Filet** : `test_cgu_imposee.py`, 47 assertions, dont la liste blanche figée route par route
  (lecture `ast`). `harness.ligne_session` porte désormais la version courante par défaut.

---

## Recommandations, par ordre de valeur

### 1. Aligner la durée de session sur le rôle (A-01 + A-02) — ✅ fait le 2026-09-22

> Appliquée telle quelle, étendue aux quatre écrivains de `comptes.role` (voir A-01 / A-02).

Un seul geste referme les deux constats. Dans `changer_role`, après l'`UPDATE` :

```python
# La durée de session est figée à la connexion (create_session lit le rôle une
# seule fois). Sans ça, un compte promu garderait une session de 30 jours, soit
# 60 fois ce que SESSION_ADMIN_LIFETIME_HOURS lui destine.
cur.execute("DELETE FROM sessions_joueurs WHERE compte_id = %s", (compte_id,))
```

Fermer les sessions **dans les deux sens** (promotion *et* rétrogradation) est le choix le plus
simple à tenir : une seule règle, « changer de rang oblige à se reconnecter », plutôt qu'un calcul
d'expiration à recaler. Le coût pour la personne est une reconnexion Discord, c'est-à-dire deux
clics.

L'alternative — recalculer `expires_at` — est plus douce mais introduit une seconde source de
vérité sur la durée, et c'est exactement ce qui a produit le défaut.

### 2. Donner à chacun la main sur ses sessions (A-03 + A-06)

Deux routes, la donnée est déjà en base :

- `GET /auth/mes-sessions` → la liste (`user_agent`, `created_at`, `last_seen_at`), avec un
  marqueur sur la session courante. L'écran était prévu dès la migration.
- `DELETE /auth/mes-sessions` → **« déconnecter partout »**, en gardant ou non la session
  courante.

C'est ce qui rend un vol de token **rattrapable par la victime elle-même**, sans passer par un
administrateur. À faire précéder, dans l'interface, d'un mot clair : *« vous ne reconnaissez pas
un appareil ? Déconnectez-le. »*

### 3. ~~Refermer la dette du mot de passe partagé (A-04 + A-05)~~ — ✅ fait le 2026-09-23

Suivie à la lettre, en commit isolé. Une seule chose n'a pas été supprimée de la liste :
`/admin/check-token`, passée en `role_required(ROLE_ADMIN)` dès le 13/09 et devenue la
revalidation par page des vues admin. Le retour arrière demande en revanche **deux** gestes et
non un — le `revert` ne recrée pas la table ([runbook-admin.md](runbook-admin.md) §3.2b).

### 4. Trancher explicitement sur les CGU (A-07) — ✅ tranché le 2026-09-24 : on impose

Soit on impose (dans `player_required`, avec liste blanche), soit on écrit dans le plan que
l'affichage suffit. Les deux sont défendables ; l'ambiguïté ne l'est pas.

---

## Comment rejouer cet audit

```bash
cd backEnd/tests && sh run.sh                    # suite complète
python3 test_audit_auth_discord.py               # ce seul fichier
```

`test_audit_auth_discord.py` contient **82 assertions, toutes vertes** au 2026-09-23 (83 au
2026-09-22, 76 au 2026-09-15 — le fichier a *perdu* une assertion en refermant A-04/A-05 : six
`defaut(...)` sont devenues sept non-régressions, et une vérification du décorateur restant n'a
plus d'objet). Deux natures cohabitent, et c'est délibéré :

- les **non-régressions** décrivent ce qui est correct et doit le rester ;
- les assertions `defaut(...)` décrivent le comportement **actuel, problématique**. Elles passent
  au vert *tant que le défaut est là*. Le jour où l'un est corrigé, l'assertion correspondante
  **vire au rouge** et nomme le constat à refermer ici — c'est le mécanisme qui empêche ce
  document de mentir en silence.

Autrement dit : une ligne rouge marquée `[A-xx, defaut constate]` est une **bonne nouvelle**, et
la consigne est d'aller mettre à jour ce fichier. **Le mécanisme a servi deux fois** : le
2026-09-22 pour A-01/A-02, le 2026-09-23 pour A-04/A-05. Dans les deux cas, c'est le rouge qui a
dit où venir écrire.

Il ne reste qu'un seul `defaut(...)` dans ce fichier, celui d'**A-06** — et celui-là décrit un **choix acté** (D5), pas une dette à refermer : s'il rougit un jour, c'est que quelqu'un aura changé la politique de rotation sans le dire ici.

### État de la suite au moment de l'audit

`run.sh` signale trois fichiers en échec, **tous antérieurs à cet audit et sans rapport avec lui** :

- `test_auth.py` — 1 assertion sur 33 : elle attend une URL d'avatar pointant vers le CDN Discord,
  alors que le code sert désormais un proxy (`/avatar/moi`). **Test obsolète, pas régression** ;
  le changement est délibéré et documenté (l'URL du CDN contient le snowflake).
- `test_liaisons.py`, `test_profils.py` — échecs de fixture, hors périmètre auth.

Ils méritent d'être repris, mais séparément : les corriger dans le même geste que cet audit
mélangerait deux sujets.
