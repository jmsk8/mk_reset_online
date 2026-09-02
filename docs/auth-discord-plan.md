# Auth Discord + comptes joueurs — conception & registre des risques

> Document de travail interne. Écrit après lecture intégrale du backend, du frontend, des
> templates, des scripts et de l'infra, à la version `1.4.2` (commit `fbb1303`, 2026-08-09).
> Objectif : pouvoir implémenter plus tard sans refaire l'analyse, **et sans retomber dans les
> pièges recensés au §8**.
>
> Conventions : **[DÉCIDÉ]** = tranché · **[À TRANCHER]** = arbitrage attendu de Jérémy ·
> gravité 🔴 critique · 🟠 élevé · 🟡 moyen · 🔵 faible.
>
> ---
>
> **Révision 2 — 2026-09-02.** Nouvelle directive produit, qui **retourne la décision §3.3** :
> l'auth admin par mot de passe partagé **disparaît**. L'admin devient un **rôle** porté par un
> compte Discord, attribué par le **super-admin** (Jérémy). Les joueurs se connectent à Discord
> pour être **rattachés à leur fiche joueur**, avec **synchronisation du pseudo et de la photo de
> profil** ; ce rattachement et cette synchronisation sont **opérés par les admins**, pas en
> self-service. L'**API bot** passe de « plus tard » à objectif de premier rang.
> **Avancement : suivi dans [auth-discord-avancement.md](auth-discord-avancement.md)**, mis à jour
> à chaque livraison. Ce document-ci reste la conception et le registre des risques ; il ne bouge
> que si une décision change. §1 (état des lieux) reste exact sauf mention contraire.
> ⚠️ **R-20 est requalifié 🔴 : le dépôt `jmsk8/mk_reset_online` est PUBLIC** (vérifié par appel à
> l'API GitHub sans authentification, HTTP 200) — la question 1 du §10.2 est donc tranchée, et dans
> le mauvais sens. Les vrais pseudos et l'historique complet des matchs sont en accès libre.

---

## 1. État des lieux

### 1.1 Topologie réelle

```
navigateur
   ↓ 443
nginx (réseau: frontend)          ← ne peut PAS joindre le backend (cf. R-24)
   ↓ proxy_pass frontend:5000
frontend Flask (réseaux: frontend + backend)   gunicorn -w 2, Python 3.10
   ↓ requests, timeout 5 s
backend Flask (réseau: backend)                gunicorn -w 2, Python 3.9
   ↓ psycopg2 SimpleConnectionPool(1, 20)
PostgreSQL 17
```

Le frontend **ne touche jamais la base**. Le backend en est le seul propriétaire. Le frontend sert
aussi de **proxy JSON** pour le JS des pages admin (il rajoute l'en-tête `X-Admin-Token` depuis la
session).

### 1.2 Auth actuelle

> **Rév. 2 : tout ce tableau est voué à disparaître** (§3.3, phase 4). Il reste ici comme état de
> départ et comme inventaire de ce qu'il faudra retirer, ligne par ligne.

| Élément | Détail | Fichier |
|---|---|---|
| Modèle | **Un seul admin**, mot de passe partagé, aucune notion d'utilisateur | — |
| Secret | `ADMIN_PASSWORD_HASH` (bcrypt) dans l'env **backend** | [db.py:19](../backEnd/db.py#L19) |
| Login | `POST /admin-auth` → bcrypt → UUID4 **stocké en clair** dans `api_tokens` | [routes_admin.py:37](../backEnd/routes_admin.py#L37) |
| Durée | 30 min, **renouvelable à l'infini** via `POST /admin/refresh-token` | [routes_admin.py:58](../backEnd/routes_admin.py#L58) |
| Transport | En-tête `X-Admin-Token`, décorateur `@admin_required` | [auth.py:11](../backEnd/auth.py#L11) |
| Côté front | `session['admin_token']` (cookie Flask signé) | [frontend.py:325](../frontEnd/frontend.py#L325) |
| Validation | `before_request` appelle `/admin/check-token` **à chaque requête**, timeout 1 s | [frontend.py:43](../frontEnd/frontend.py#L43) |
| CSRF | `flask-wtf` `CSRFProtect` global (POST/PUT/PATCH/DELETE) | [frontend.py:34](../frontEnd/frontend.py#L34) |
| Cookie | `HTTPONLY` ✓ `SAMESITE=Lax` ✓ `SECURE` ✓ · `permanent_session_lifetime = 30 min` **(global)** | [frontend.py:29-32](../frontEnd/frontend.py#L29-L32) |

### 1.3 Modèle de données actuel

12 tables : `configuration`, `ligues`, `joueurs`, `tournois`, `participations`, `ghost_log`,
`global_resets`, `api_tokens`, `saisons`, `league_movements`, `types_awards`, `awards_obtenus`.

**Deux constats déterminants, vérifiés ligne à ligne :**

**(a) ✅ Aucune dénormalisation du nom de joueur.** `participations`, `awards_obtenus`,
`ghost_log`, `league_movements` référencent tous `joueur_id`. Seuls les noms de **ligue** sont
archivés (`tournois.ligue_nom`, `awards_obtenus.ligue_nom`, `saisons.ligue_nom`).
→ **`UPDATE joueurs SET nom = …` propage partout, sans effet de bord sur un seul calcul.**
C'est ce qui rend l'anonymisation RGPD triviale (§6.4).

**(b) 🔴 Le moteur TrueSkill est incrémental et non recalculable.** Chaque tournoi lit le
`mu/sigma` courant du joueur, archive `old_mu/old_sigma` dans `participations`, puis **écrase**
`joueurs.mu/sigma` ([routes_admin.py:863-925](../backEnd/routes_admin.py#L863-L925)).
Il n'existe **aucune fonction de recalcul depuis zéro** — seulement un *revert* du **dernier**
tournoi ([routes_admin.py:1051](../backEnd/routes_admin.py#L1051)).
→ **Supprimer les participations d'un joueur rend le classement de tous les autres définitivement
faux, sans possibilité de le reconstruire.** C'est l'argument technique décisif de toute la
stratégie RGPD.

### 1.4 Infra & outillage

- **Aucun framework de migration.** `schema.sql` = `DROP`+`CREATE`, joué **uniquement au premier
  démarrage** du conteneur postgres (`docker-entrypoint-initdb.d`). Les évolutions vivent dans
  `backEnd/migrations/AAAA-MM-JJ_*.sql`, **appliquées à la main**. La base de prod n'a donc
  *jamais* été créée par `schema.sql` tel qu'il est aujourd'hui.
- **3 fichiers SQL décrivent le schéma** et doivent rester cohérents :
  `schema.sql` (référence), `seed.sql` (fixture montée en `02_`), `dump.sql` (dump d'exemple
  fictif, monté via `docker-compose.dump.yml`).
- `docker-compose.yml` monte **chaque `.py` backend individuellement** (l. 37-45), alors que le
  Dockerfile fait `COPY *.py .` → cf. R-21, le piège est plus subtil qu'il n'y paraît.
- **Cache backend** : dict en mémoire **par worker gunicorn** (donc 2 copies) + marqueur fichier
  `/tmp/mkreset_cache_invalidated_at` pour l'invalidation croisée. Aucune éviction (cf. R-05).
- **Pas de stockage objet**, pas de volume média, pas de CDN.
- **Aucun test, aucune CI.**
- Deps : backend = flask, psycopg2, trueskill, numpy, bcrypt, gunicorn (**pas de `requests`**) ;
  frontend = flask, requests, flask-wtf, gunicorn.
- Le matchmaking est **du JS client** ([matchmaking.html:132](../frontEnd/templates/matchmaking.html#L132)),
  pas une route backend.

---

## 2. Objectif fonctionnel

**Rév. 2 — les trois buts qui commandent tout le reste :**

- **A. Supprimer l'auth admin par mot de passe.** Plus de secret partagé : `ADMIN_PASSWORD_HASH`,
  `POST /admin-auth`, `api_tokens` et l'en-tête `X-Admin-Token` disparaissent. Un admin est un
  **compte Discord portant `comptes.role='admin'`**, attribué **manuellement par le super-admin**.
- **B. Rattacher chaque joueur à son identité Discord**, pour **synchroniser le pseudo et la photo
  de profil**. La liaison *et* la synchronisation sont **déclenchées par un admin** — le joueur
  déclare, l'admin valide et applique.
- **C. Exposer une API pour les bots Discord** (lecture joueurs/classement, matchmaking).

Le parcours qui en découle :

1. L'admin génère un **lien d'invitation à expiration** (de préférence **nominatif**, cf. R-33).
2. Le joueur l'ouvre → **« Se connecter avec Discord »** → OAuth2 (scope `identify` seul).
3. Le joueur **déclare quelle fiche joueur du site il est**.
4. L'admin **confirme la liaison** sur une page dédiée (file d'attente) — et c'est ce geste qui
   **applique la synchronisation** pseudo + avatar (cf. §3.5).
5. Le joueur lié édite son **profil** : bio, bannière, couleur (l'avatar, lui, vient de Discord).
6. L'admin dispose d'une **page de gestion des comptes** : rôles, liaisons, resynchronisation.
7. Le **super-admin** (et lui seul) attribue et retire le rôle `admin`.
8. Un **bot Discord** interroge l'API (joueurs + scores) pour du matchmaking.
9. **RGPD** : consentement, accès, export, suppression — **sans altérer l'historique des matchs**.

---

## 3. Décisions d'architecture

### 3.1 L'échange OAuth se fait côté **backend** **[DÉCIDÉ]**

`redirect_uri` = `https://mkreset.fr/auth/discord/callback` (le frontend est le seul tiers exposé),
mais l'échange `code → token` et l'appel `GET /users/@me` sont faits par le backend.

```
GET /auth/discord/callback?code&state          (frontend)
  ├─ vérifie state (session), le supprime
  └─ POST backend /auth/discord/exchange {code, redirect_uri, invite_token}   ⚠️ timeout ≥ 15 s (R-11)
        ├─ POST https://discord.com/api/v10/oauth2/token   (⚠️ data=, pas json= — R-12)
        ├─ GET  https://discord.com/api/v10/users/@me
        ├─ upsert comptes / consomme l'invitation / crée la session
        └─ → {session_token, compte}
  └─ session['player_token'] = session_token ; session.permanent = True
```

*Pourquoi* : `DISCORD_CLIENT_SECRET` reste dans l'env backend (comme `ADMIN_PASSWORD_HASH`), la
base garde un seul propriétaire, le frontend ne manipule aucun secret Discord.
*Coût* : `requests==2.32.5` à ajouter au backend (l'egress internet du conteneur est OK, bridge Docker standard).

### 3.2 Un seul cookie de session, 30 jours **[DÉCIDÉ]**

Avec correction obligatoire de trois choses côté frontend : `admin_logout` (R-13),
`inject_lifetime` (R-14), `WTF_CSRF_TIME_LIMIT` (R-15).

### 3.3 L'auth admin **devient** l'auth Discord **[DÉCIDÉ — rév. 2, remplace l'ancienne 3.3]**

*Décision précédente (rév. 1), désormais caduque : « on ne touche pas à l'auth admin en phase 1,
le mot de passe reste en accès de secours ».*

Cible : **un seul mécanisme d'authentification**, Discord, et une **autorisation par rôle**.

| Aujourd'hui | Cible |
|---|---|
| `ADMIN_PASSWORD_HASH` (bcrypt, env backend) | *supprimé* |
| `POST /admin-auth`, `POST /admin/refresh-token` | *supprimés* |
| `api_tokens` (UUID en clair, 30 min renouvelables) | *supprimée* → `sessions_joueurs` |
| en-tête `X-Admin-Token` + `@admin_required` | en-tête `X-Session-Token` + `@role_required('admin')` |
| `session['admin_token']` côté front | `session['player_token']` (unique) |

Conséquences directes, à traiter comme des exigences et non comme des détails :

- **Le rôle est la seule frontière de privilège.** `comptes.role` n'est modifiable que par le
  super-admin, jamais par une route que touche un joueur (R-40).
- **Amorçage.** Le tout premier compte admin ne peut pas être créé par une IHM admin — il faut un
  chemin d'amorçage explicite (R-39).
- **Risque de verrouillage total.** Plus de mot de passe = plus de porte de secours si Discord,
  l'application OAuth ou le compte Discord du super-admin tombent. Une procédure *break-glass*
  documentée devient **obligatoire** (R-38).
- **Ordre imposé.** L'admin Discord doit fonctionner **avant** de retirer le mot de passe. Les deux
  cohabitent le temps d'une phase, puis le mot de passe est supprimé — jamais l'inverse.
- **R-10 s'éteint de lui-même** (plus de `refresh-token` sans borne), à condition que
  `sessions_joueurs` ne reproduise pas le motif : expiration **absolue**, hash en base.

### 3.3bis Trois niveaux d'autorisation **[DÉCIDÉ]**

`comptes.role ∈ {'player', 'admin', 'superadmin'}`, strictement ordonnés.

| Rôle | Peut |
|---|---|
| `player` | voir/éditer **son** profil, demander une liaison, exporter/supprimer **son** compte |
| `admin` | tout l'admin actuel + invitations, liaisons, **synchronisation** des profils, anonymisation |
| `superadmin` | tout ce qui précède + **attribuer/retirer `admin`**, gérer les tokens de service (bot) |

`superadmin` n'est **pas** attribuable par l'IHM : uniquement par migration SQL / variable d'env
(R-39). Il ne doit **jamais** pouvoir être retiré au dernier compte qui le porte (R-38).

### 3.4 `joueurs.nom` reste **admin-only** **[DÉCIDÉ, confirmé en rév. 2]**

Cf. R-04 : le rendre éditable par le joueur transformerait ~72 points d'injection `innerHTML` en
surface XSS stockée à réauditer un par un.

La synchronisation du pseudo Discord (§3.5) **ne contredit pas** cette décision : la valeur est
proposée par Discord, mais **écrite par un admin**, après aperçu. Le joueur n'a toujours aucune
écriture directe sur `joueurs.nom`.

---

### 3.5 La synchronisation pseudo/avatar est un geste **admin** **[DÉCIDÉ — rév. 2]**

Discord fournit trois champs via `GET /users/@me` : `username`, `global_name`, `avatar` (un hash).
On les stocke **tels quels** dans `comptes` à chaque connexion — c'est un simple miroir, sans effet
de bord.

**Ce qui n'est pas automatique, c'est la propagation vers la fiche joueur.** Un admin doit
l'appliquer explicitement (`POST /admin/comptes/<id>/sync`), avec un **aperçu avant/après**.

*Pourquoi ne pas synchroniser automatiquement* — quatre raisons cumulées :

1. `joueurs.nom` est **`UNIQUE` et sensible à la casse** : un pseudo Discord déjà porté par un
   autre joueur ferait échouer l'`UPDATE` (R-41).
2. Le nom du joueur circule dans ~72 `innerHTML` (R-04) : le laisser piloter par une valeur
   librement modifiable côté Discord ouvrirait la XSS stockée que §3.4 refuse. Le passage par une
   validation humaine ne *supprime* pas le risque, mais l'admin voit la chaîne avant qu'elle
   n'entre en base.
3. `/stats/joueur/<nom>` est l'URL publique : un changement de pseudo casse les liens partagés
   (R-23 — d'où l'URL canonique `/joueur/<id>`).
4. Un joueur qui change de pseudo Discord tous les deux jours ferait bouger le classement affiché
   sans qu'aucun admin ne l'ait voulu.

**Avatar** : aucune copie, aucun upload. On stocke le `discord_avatar_hash` et on construit l'URL
CDN à l'affichage — `https://cdn.discordapp.com/avatars/<discord_id>/<hash>.png?size=128`, avec
repli sur l'avatar par défaut Discord si le hash est `NULL` (R-42). Cela **résout la question 2 du
§10** et **annule R-25/R-26 pour la v1** : pas de volume média, pas de sauvegarde à étendre, pas de
pipeline d'upload à sécuriser. La bannière, si elle arrive, rouvrira ce dossier.

## 4. Modèle de données cible

À écrire dans `schema.sql` **et** dans `backEnd/migrations/AAAA-MM-JJ_auth_discord.sql`
(et penser à `seed.sql` / `dump.sql` si on veut des fixtures — cf. R-22).

Toutes les colonnes temporelles en **`TIMESTAMPTZ`** avec des `datetime` *aware* côté Python
(cf. R-17 : l'existant est en `TIMESTAMP` naïf, ne pas mélanger sans le savoir).

### 4.1 `invitations`

```sql
CREATE TABLE public.invitations (
    id          SERIAL PRIMARY KEY,
    token_hash  CHAR(64) NOT NULL UNIQUE,   -- sha256(token) ; le token brut n'est JAMAIS stocké
    label       VARCHAR(100),
    joueur_id   INTEGER REFERENCES public.joueurs(id) ON DELETE SET NULL,  -- invitation nominative
    max_uses    INTEGER NOT NULL DEFAULT 1,
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invitations_expires ON public.invitations(expires_at);
```

- **Nominative** (`joueur_id` renseigné) : l'admin génère le lien *pour* un joueur → liaison
  pré-remplie, confirmation quasi automatique.
- **Générique** (`joueur_id` NULL, `max_uses = N`) : lien posté dans le serveur Discord.

### 4.2 `comptes`

```sql
CREATE TABLE public.comptes (
    id                   SERIAL PRIMARY KEY,
    discord_id           VARCHAR(32) NOT NULL UNIQUE,  -- snowflake en TEXTE (> 2^53, casse en JS)
    discord_username     VARCHAR(64),
    discord_global_name  VARCHAR(64),
    discord_avatar_hash  VARCHAR(64),
    joueur_id            INTEGER UNIQUE REFERENCES public.joueurs(id) ON DELETE SET NULL,
    statut               VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|linked|rejected|suspended
    role                 VARCHAR(20) NOT NULL DEFAULT 'player',   -- player|admin|superadmin
    invitation_id        INTEGER REFERENCES public.invitations(id) ON DELETE SET NULL,
    cgu_accepted_at      TIMESTAMPTZ,
    cgu_version          VARCHAR(20),
    discord_synced_at    TIMESTAMPTZ,   -- dernier rafraîchissement du miroir Discord (login)
    profil_synced_at     TIMESTAMPTZ,   -- dernière propagation admin vers joueurs.nom (§3.5)
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at        TIMESTAMPTZ,
    CONSTRAINT comptes_role_valide CHECK (role IN ('player','admin','superadmin'))
);
CREATE INDEX idx_comptes_role ON public.comptes(role) WHERE role <> 'player';
```

Pas de colonne `email` : on ne demande pas le scope (minimisation, §6.2).
`joueur_id UNIQUE` : Postgres autorise plusieurs `NULL`, donc les comptes non liés cohabitent.

**Rév. 2 — les colonnes qui portent les nouveaux objectifs :**

- `role` est **la seule frontière de privilège** de l'application (§3.3bis). Le `CHECK` évite
  qu'une faute de frappe dans un `UPDATE` manuel crée un rôle fantôme sans privilège… ou
  l'inverse. Toute écriture sur cette colonne passe par une route `superadmin` **et** une ligne
  `audit_admin` (R-40).
- `discord_username` / `discord_global_name` / `discord_avatar_hash` sont un **miroir**
  rafraîchi à chaque connexion (`discord_synced_at`). Les écrire ne change **rien** au site.
- `profil_synced_at` date la dernière **propagation admin** vers `joueurs.nom` (§3.5) : c'est ce
  qui permet à la page admin d'afficher « pseudo Discord ≠ nom du joueur depuis 12 j » et de
  proposer la resynchronisation.
- Le `discord_id` est un **snowflake** : `VARCHAR`, jamais un entier — il dépasse 2^53 et se
  corrompt silencieusement en JS comme en JSON JavaScript.

### 4.3 `liaisons_demandes`

```sql
CREATE TABLE public.liaisons_demandes (
    id          SERIAL PRIMARY KEY,
    compte_id   INTEGER NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    joueur_id   INTEGER NOT NULL REFERENCES public.joueurs(id) ON DELETE CASCADE,
    statut      VARCHAR(20) NOT NULL DEFAULT 'pending',
    message     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at  TIMESTAMPTZ,
    decided_by  VARCHAR(50)
);
CREATE UNIQUE INDEX idx_liaison_pending_compte ON public.liaisons_demandes(compte_id) WHERE statut = 'pending';
CREATE UNIQUE INDEX idx_liaison_pending_joueur ON public.liaisons_demandes(joueur_id) WHERE statut = 'pending';
```

Table séparée : file d'attente propre côté admin, trace des refus, redemande possible.

### 4.4 `profils`

```sql
CREATE TABLE public.profils (
    compte_id       INTEGER PRIMARY KEY REFERENCES public.comptes(id) ON DELETE CASCADE,
    bio             VARCHAR(500),
    avatar_path     VARCHAR(255),
    banniere_path   VARCHAR(255),
    couleur_accent  CHAR(7),
    reseaux         JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Table dédiée = **tout le contenu généré par l'utilisateur au même endroit**, purgeable en un
`DELETE` lors d'une demande d'effacement.

### 4.5 `sessions_joueurs`

```sql
CREATE TABLE public.sessions_joueurs (
    token_hash    CHAR(64) PRIMARY KEY,     -- sha256 : jamais le token en clair (contrairement à api_tokens)
    compte_id     INTEGER NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    last_seen_at  TIMESTAMPTZ,
    user_agent    VARCHAR(255)
);
CREATE INDEX idx_sessions_joueurs_compte  ON public.sessions_joueurs(compte_id);
CREATE INDEX idx_sessions_joueurs_expires ON public.sessions_joueurs(expires_at);
```

Pas de stockage d'IP : `user_agent` suffit pour un écran « vos sessions actives », et c'est autant
de données perso en moins à justifier.

### 4.6 `audit_admin`

```sql
CREATE TABLE public.audit_admin (
    id          SERIAL PRIMARY KEY,
    action      VARCHAR(50) NOT NULL,
    cible_type  VARCHAR(30),
    cible_id    INTEGER,
    details     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

L'art. 5.2 RGPD (*accountability*) demande de pouvoir **démontrer** le traitement. 15 lignes de
code pour prouver « telle suppression a bien été exécutée le … ».

**Rév. 2** : cette table devient aussi le journal des **changements de rôle** et des
**synchronisations de profil** — les deux gestes que le nouveau modèle rend sensibles. Actions à
prévoir : `role_attribue`, `role_retire`, `liaison_approuvee`, `liaison_refusee`, `profil_synchro`,
`compte_supprime`, `joueur_anonymise`, `invitation_creee`, `invitation_revoquee`,
`service_token_cree`, `service_token_revoque`.

`details` (JSONB) doit contenir l'**avant/après** pour les gestes réversibles — indispensable pour
répondre à « qui a renommé ce joueur, et en quoi ? ». Ajouter `acteur_compte_id INTEGER REFERENCES
public.comptes(id) ON DELETE SET NULL` : avec un admin unique et anonyme, la question ne se posait
pas ; avec plusieurs admins, c'est la première chose qu'on cherchera.

### 4.7 `service_tokens` (API bot) **[rév. 2]**

```sql
CREATE TABLE public.service_tokens (
    id          SERIAL PRIMARY KEY,
    token_hash  CHAR(64) NOT NULL UNIQUE,   -- sha256 ; le token brut n'est montré qu'une fois
    nom         VARCHAR(64) NOT NULL,       -- « bot-matchmaking », « bot-annonces »
    scopes      TEXT[] NOT NULL DEFAULT '{}',
    expires_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Préféré à un `BOT_API_KEY` en variable d'environnement : plusieurs bots, révocation unitaire sans
redéploiement, traçabilité (`last_used_at`), et **rotation sans toucher au `.env`** — donc sans
risquer R-19. Création/révocation réservées au `superadmin`.

Comparaison des tokens en **temps constant** (`hmac.compare_digest`), jamais avec `==`.

---

## 5. Découpage en phases

> **Rév. 2** — le découpage change : l'admin par rôle Discord (ex-phase 4) remonte, parce que
> c'est le but A ; la suppression du mot de passe devient une phase à part entière, **après** que
> l'admin Discord ait tourné en vrai ; l'API bot (ex-phase 5) devient la phase 5 mais n'est plus
> conditionnée aux phases 3-4.

### Phase 0 — Correctifs préalables (à faire **avant** d'ouvrir les comptes)

Ce sont des risques déjà présents que l'arrivée des comptes rend exploitables. Détail au §8.

- ✅ **R-19** `check_env.sh` fusionne au lieu de réécrire — *bloquant : ajouter la moindre
  `DISCORD_*` aux `REQUIRED_VARS` aurait déclenché la réécriture au premier `make up`*
- ✅ **R-01** garde-fou sur `DELETE /admin/joueurs/<id>` + route d'anonymisation
- ✅ **R-02** `ADMIN_TOKEN` sorti du DOM des pages admin (4 fichiers)
- ✅ **R-05** clé de cache normalisée + `_cache_store` borné
- 🟡 **R-20** `seed.sql` remplacé par la fixture fictive. **Le dépôt reste public et
  l'historique git conserve les données réelles** — arbitrage assumé, cf. le fichier de suivi

### Phase 1 — Socle auth (connexion Discord, sans encore toucher à l'admin)

**Backend**
- `requirements.txt` : `+ requests==2.32.5`
- `auth_discord.py` (nouveau) : échange OAuth, `/users/@me`, upsert compte
- `routes_auth.py` (nouveau, blueprint `auth_bp`) : `POST /auth/discord/exchange`,
  `POST /auth/logout`, `GET /auth/me`
- `auth.py` : `@player_required` (injecte `g.compte`), `@role_required('admin')` **écrit dès
  maintenant** — même s'il n'est branché qu'en phase 4
- `backend.py` : `register_blueprint(auth_bp)`
- ⚠️ `docker-compose.yml` : ajouter les nouveaux fichiers aux volumes (R-21)
- `.env` : `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`,
  `DISCORD_SUPERADMIN_ID` (amorçage, R-39)

**Frontend**
- `GET /auth/discord/login` (génère `state`, mémorise `invite_token`)
- `GET /auth/discord/callback`
- `GET /invite/<token>` — **GET idempotent, ne consomme rien** (R-09)
- `GET /logout` (joueur)
- correctifs R-13 / R-14 / R-15 / R-16, `permanent_session_lifetime` → 30 j

**nginx** : zone `limit_req_zone … zone=auth:10m rate=20r/m;` + `location /auth` et `location /invite`

**Templates** : `invite.html`, `login_discord.html`, navbar (bloc compte)

**Critère de sortie** : le super-admin se connecte via Discord, `GET /auth/me` renvoie
`role='superadmin'`, et l'auth admin par mot de passe **fonctionne toujours** en parallèle.

### Phase 2 — Liaison compte ↔ joueur + synchronisation

- Backend : `GET /auth/joueurs-disponibles` (**uniquement les joueurs non liés** — R-08),
  `POST /auth/demande-liaison`, `GET /admin/liaisons`,
  `POST /admin/liaisons/<id>/approve|reject`,
  `POST /admin/comptes/<id>/sync` (propagation pseudo → `joueurs.nom`, §3.5),
  `GET /admin/comptes/<id>/sync-preview` (avant/après, sans écrire)
- Frontend : `/mon-compte/liaison` + page admin `/admin/comptes` (file d'attente, écarts de
  pseudo, bouton de resynchronisation)
- ⚠️ Approbation **dans une transaction avec `SELECT … FOR UPDATE`** (R-07)
- ⚠️ La synchro doit gérer la **collision `UNIQUE` sur `joueurs.nom`** en 409 lisible (R-41),
  appeler `invalidate_cache()`, écrire `audit_admin`, et **refuser** de recréer un nom anonymisé
  (R-03)
- Affichage de l'avatar Discord depuis le CDN (§3.5), avec repli (R-42)

### Phase 3 — Profils joueur

- Backend : `GET/PUT /me/profil` (bio, couleur, réseaux — **pas** l'avatar, il vient de Discord)
- Affichage : enrichir `GET /stats/joueur/<nom>` (cette route **n'est pas cachée**, l'affichage est
  donc immédiat — c'est `/classement` qui est caché 5 min)
- URL canonique `/joueur/<id>` + 301 depuis `/stats/joueur/<nom>` (R-23) — à faire ici, tant qu'on
  touche à la page profil et avant que les pseudos ne se mettent à bouger
- **Plus d'upload en v1** (§3.5) : R-25 et R-26 sont hors périmètre tant qu'il n'y a pas de bannière

### Phase 4 — Bascule de l'admin sur Discord **[cœur du but A]**

Ordre **impératif**, chaque étape validée avant la suivante :

1. **Amorçage** : migration `UPDATE comptes SET role='superadmin' WHERE discord_id = :id`, ou
   promotion automatique au premier login si `discord_id = DISCORD_SUPERADMIN_ID` (R-39).
2. `@role_required('admin')` **en plus** de `@admin_required` sur les routes admin — les deux
   chemins acceptés, l'ancien conservé.
3. Frontend : les routes proxy injectent `X-Session-Token` si le compte en session est admin,
   sinon `X-Admin-Token`. Les pages admin deviennent accessibles par les deux voies.
4. Routes super-admin : `GET /admin/comptes`, `POST /admin/comptes/<id>/role` (refuse de retirer
   le **dernier** `superadmin` — R-38), avec `audit_admin` systématique.
5. **Période de recouvrement** : administrer réellement via Discord pendant quelques jours.
6. **Découplage** : `POST /admin-auth`, `POST /admin/refresh-token`, `@admin_required`, la table
   `api_tokens`, `ADMIN_PASSWORD_HASH` dans le `.env` et dans `check_env.sh`, `session['admin_token']`,
   la page de login admin et son minuteur de navbar (R-14) — **tout part dans le même commit**,
   avec une migration `DROP TABLE api_tokens`.
7. Runbook **break-glass** écrit et *testé* avant l'étape 6 (R-38).

**Critère de sortie** : `grep -rn "ADMIN_PASSWORD_HASH\|X-Admin-Token\|admin-auth"` ne renvoie
plus rien hors CHANGELOG et migrations.

### Phase 5 — API bot **[but C]**

- Table `service_tokens` (§4.7) + `@service_required(scope=…)`
- `GET /api/bot/joueurs`, `GET /api/bot/joueur/by-discord/<id>`, `POST /api/bot/matchmaking`
- ⚠️ **R-24 : nginx ne peut pas joindre le backend** — trancher l'exposition (préférence : proxy
  via le frontend)
- ⚠️ **R-06 : le matchmaking est du JS client**, à remonter dans `services.py` d'abord
- IHM super-admin de création/révocation de tokens (le token brut n'est affiché **qu'une fois**)

*Indépendante des phases 2-3 :* dès que la phase 1 fournit `comptes.discord_id`, un bot peut déjà
résoudre « ce Discord ID = ce joueur ». À planifier selon l'urgence côté bot, pas selon ce numéro.

### Phase 6 — RGPD

Export, suppression, anonymisation, pages légales, purges (§6). Peut avancer en parallèle des
phases 3-5, mais **doit être livré avant toute ouverture large des invitations**.

---

## 6. RGPD

### 6.1 Le principe qui résout tout

**Séparer l'identité (le compte) du dossier sportif (le joueur).**

- `joueurs` = un **compétiteur**, entité pseudonyme, cible de toutes les stats.
- `comptes` + `profils` + `sessions_joueurs` = **la personne** (Discord ID, pseudo Discord, avatar, bio).

Une suppression de compte détruit la seconde colonne et ne touche pas la première. Aucun nom
n'étant dénormalisé (§1.3a), l'historique reste intact **et** cohérent.

### 6.2 Minimisation

- Scope OAuth : **`identify` uniquement**. Pas d'`email`, pas de `guilds`. Si on veut vérifier
  l'appartenance au serveur, c'est **le bot** qui le fera avec son propre token.
- Pas d'IP applicative stockée. Les logs nginx en contiennent → fixer une **rétention (6-12 mois,
  recommandation CNIL pour les logs de sécurité)** et la documenter.
- Ne **jamais** logger le `code` OAuth, l'`access_token` Discord, ni un token de session (R-18).

### 6.3 Les droits

| Droit | Implémentation | Effort |
|---|---|---|
| Information | pages `/confidentialite` + `/mentions-legales`, liens en footer | faible |
| Consentement | `cgu_accepted_at` + `cgu_version`, case à cocher | faible |
| Accès / portabilité | `GET /me/export` → JSON (compte, profil, participations, awards, sessions) | faible |
| Rectification | déjà couvert par l'édition de profil | — |
| Effacement | `DELETE /me` (§6.4) | moyen |
| Opposition / retrait | = suppression du compte | — |

**Rév. 2 — deux ajouts** :

- **Le miroir Discord** (`discord_username`, `discord_global_name`, `discord_avatar_hash`) est une
  donnée personnelle traitée sur la base du **consentement** (l'utilisateur clique « se connecter
  avec Discord »). À citer explicitement dans la politique de confidentialité, avec **Discord Inc.
  comme sous-traitant hors UE** et le **CDN appelé par le navigateur du visiteur** (R-42).
- **La synchronisation du pseudo vers `joueurs.nom` est un traitement distinct**, opéré par un
  admin (§3.5). Elle rend le pseudo de jeu *dérivé* d'une donnée personnelle : après suppression du
  compte, le nom synchronisé **reste** dans `joueurs`. C'est cohérent avec §6.4 (le pseudo seul
  n'identifie plus raisonnablement), mais il faut le **dire** dans la politique, et offrir
  l'anonymisation de niveau 2 à qui le demande.

### 6.4 Suppression — deux niveaux **[DÉCIDÉ]**

**Niveau 1 — Suppression du compte (défaut, self-service)**

```sql
BEGIN;
  DELETE FROM sessions_joueurs  WHERE compte_id = :id;
  DELETE FROM profils           WHERE compte_id = :id;
  DELETE FROM liaisons_demandes WHERE compte_id = :id;
  DELETE FROM comptes           WHERE id = :id;
  -- joueurs, participations, tournois, awards_obtenus, ghost_log, league_movements : INTACTS
  INSERT INTO audit_admin(action, cible_type, details) VALUES ('compte_supprime', 'compte', …);
COMMIT;
```
+ suppression des fichiers média associés.

*Justification à écrire noir sur blanc dans la politique de confidentialité* : le pseudo de jeu,
une fois déconnecté de tout identifiant Discord, avatar ou e-mail, ne permet plus d'identifier
raisonnablement la personne ; sa conservation relève de l'intérêt légitime — **un classement
TrueSkill dont on retire des matchs devient faux pour tous les autres joueurs, et le moteur étant
incrémental (§1.3b), il est techniquement impossible de le reconstruire.**

**Niveau 2 — Anonymisation du pseudo (sur demande explicite)**

```sql
UPDATE joueurs SET nom = 'Joueur #' || id, color = '#FFFFFF' WHERE id = :joueur_id;
```
- Stats, calculs TrueSkill, awards : **strictement identiques** (tout est indexé sur `joueur_id`).
- Effets à gérer : `invalidate_cache()` obligatoire, vieux liens `/stats/joueur/<ancien-nom>` en
  404 (acceptable — cf. R-23 pour l'éviter), et **R-03** (recréation fantôme au tournoi suivant).
- Route à créer : `POST /admin/joueurs/<id>/anonymiser`.

### 6.5 Purges automatiques

Sur le modèle du `DELETE FROM api_tokens WHERE expires_at < NOW()` existant :
`sessions_joueurs` expirées · `invitations` expirées > 30 j · `comptes` `pending` inactifs > 90 j ·
`liaisons_demandes` `rejected` > 1 an.

### 6.6 Documents à produire

Politique de confidentialité (finalités, base légale, catégories, destinataires — **Discord Inc.
= sous-traitant hors UE**, hébergement OVH France, durées, droits, contact) · registre des
traitements · mentions légales.

---

## 7. API pour le bot Discord

**Auth machine** : table `service_tokens` (§4.7) plutôt qu'une clé en `.env` — révocation unitaire,
plusieurs bots, traçabilité, rotation sans toucher au `.env` (donc sans réveiller R-19).
En-tête `Authorization: Bearer <token>`, décorateur `@service_required(scope=…)`, comparaison
`hmac.compare_digest` sur le sha256.

**Scopes** (démarrer étroit, on élargit toujours plus facilement qu'on ne restreint) :

| Scope | Donne accès à |
|---|---|
| `read:joueurs` | `GET /api/bot/joueurs`, `GET /api/bot/joueur/by-discord/<id>` |
| `read:classement` | `GET /api/bot/classement` |
| `matchmaking` | `POST /api/bot/matchmaking` |

**Règles de données** — un bot est un tiers, pas un admin :

- Ne renvoyer que `discord_id`, `joueur_id`, `nom`, `mu/sigma` (ou le score dérivé), tier, ligue.
- **Jamais** les bios, les URLs d'avatar personnalisées, les invitations, les rôles, l'audit.
- Ne renvoyer que les comptes `statut='linked'` — un compte `pending` est une identité **non
  vérifiée** (R-33), la publier reviendrait à valider la revendication.
- Ne **jamais** accepter d'écriture sur `joueurs`, `participations` ou `comptes.role` par cette
  voie. L'API bot est **en lecture seule**, sauf `matchmaking` qui ne fait que calculer.

⚠️ **R-24 : nginx ne peut pas joindre le backend.** Il faut choisir : proxifier `/api/bot/` via le
frontend, ou brancher nginx sur le réseau `backend`. Préférence : **via le frontend**.
⚠️ **R-06 : le matchmaking est du JS client**, à remonter dans `services.py` d'abord.
⚠️ **Limitation de débit dédiée** : un bot en boucle d'erreur tape bien plus vite qu'un humain.
Zone nginx séparée de `auth`, et `last_used_at` pour repérer un token qui s'emballe.

---

## 8. Registre des risques

### 8.1 Intégrité des données

---
**R-01 🔴 `DELETE /admin/joueurs/<id>` détruit l'historique en cascade — irréversiblement**

[routes_admin.py:336](../backEnd/routes_admin.py#L336) fait un `DELETE FROM Joueurs WHERE id=%s`
sans aucune vérification. Tous les FK sont en `ON DELETE CASCADE` : `participations`,
`awards_obtenus`, `ghost_log`, `league_movements` partent avec.
Comme le moteur TrueSkill est **incrémental et non recalculable** (§1.3b), le classement de tous
les autres joueurs devient faux **sans aucun moyen de le reconstruire**.

*Probabilité* : élevée — le RGPD va explicitement pousser à cliquer sur ce bouton.
*Mitigation (Phase 0)* :
```python
cur.execute("SELECT COUNT(*) FROM participations WHERE joueur_id = %s", (id,))
if cur.fetchone()[0] > 0:
    return jsonify({"error": "Ce joueur a un historique de matchs. Le supprimer fausserait "
                             "définitivement le classement de tous les autres. "
                             "Utilisez l'anonymisation."}), 409
```
+ route `POST /admin/joueurs/<id>/anonymiser` comme alternative offerte.

---
**R-02 🔴 `ADMIN_TOKEN` est écrit en clair dans le DOM de 4 pages admin**

`gestion_joueurs.html:20`, `admin_ligues.html:98`, `admin_saisons.html:139`,
`add_tournament.html:168` injectent le token de session admin dans le HTML.
Aujourd'hui le risque est théorique : **il n'existe aucun contenu généré par l'utilisateur** sur le
site. **L'arrivée des bios/pseudos Discord crée la première surface de XSS stockée** — et la page
admin de gestion des comptes affichera précisément ces données.
Chaîne d'attaque : bio malveillante → admin ouvre `/admin/comptes` → exfiltration du token →
accès API admin complet, **renouvelable indéfiniment** via `/admin/refresh-token` (R-10).

*Mitigation (Phase 0)* : supprimer purement et simplement ces lignes. Le JS appelle déjà les
**routes proxy du frontend**, qui injectent l'en-tête depuis la session serveur ; `gestion.js`
gère déjà l'absence (`if (typeof ADMIN_TOKEN !== 'undefined')`). Le token dans le DOM est du poids
mort doublé d'un risque.

---
**R-03 🟠 Un joueur anonymisé peut « ressusciter » sous son ancien nom**

`add_tournament` **crée un joueur à la volée si le nom est inconnu**
([routes_admin.py:866-872](../backEnd/routes_admin.py#L866-L872)). Après une anonymisation
(`Toto` → `Joueur #12`), si l'admin ressaisit `Toto` dans le formulaire de tournoi, une **nouvelle
ligne joueur** est créée avec mu/sigma par défaut — l'identité effacée réapparaît, et les stats
partent sur un doublon.
Même mécanisme pour une simple faute de frappe : un doublon silencieux, dont le compte lié pointe
toujours sur l'ancienne ligne.

*Mitigation* : table `noms_interdits` (ou colonne `joueurs.anonymise_at`) refusant la recréation ;
et/ou passer le formulaire de tournoi en **sélection stricte par `joueur_id`** plutôt qu'en saisie
libre de nom.

---
**R-04 🟠 Rendre `joueurs.nom` éditable par le joueur ouvrirait ~72 vecteurs XSS**

72 usages de `innerHTML` dans les templates/JS. L'hygiène est globalement bonne (`escapeHtml()`
présent et utilisé), mais quelques points sont fragiles : `add_tournament.html:255`
(`escapeHtml(nom).replace(/'/g,"\\'")` injecté dans un attribut `onclick`),
`recap.html:1417` (couleur non passée par `sanitizeColor`), et deux `|safe` sur
`award.description` ([stats_joueur.html:204](../frontEnd/templates/stats_joueur.html#L204)).
Tant que ces valeurs sont admin-contrôlées, le risque est faible.

*Mitigation* : **[DÉCIDÉ]** `joueurs.nom` reste admin-only. La bio, elle, ne doit **jamais**
passer par `|safe` ni par un `innerHTML` non échappé.

---
**R-05 🟠 Cache backend non borné, pilotable depuis internet (fuite mémoire / DoS)**

[routes_public.py:566](../backEnd/routes_public.py#L566) :
`cache_key = f"classement:{tier_filtre}:{ligue_filtre}"`, avec `tier_filtre` issu directement du
query string. La requête SQL, elle, **ignore** les tiers invalides — mais la **clé de cache utilise
la valeur brute**. `_cache_store` est un dict sans éviction ; les entrées ne sont supprimées qu'à
la *lecture* d'une clé périmée, donc une clé jamais relue reste indéfiniment.
Le frontend relaie le paramètre tel quel ([frontend.py:220](../frontEnd/frontend.py#L220)) →
`https://mkreset.fr/classement?tier=<aléatoire>` en boucle stocke N copies du classement complet.
Le conteneur backend est plafonné à **512 Mo**. Idem pour `/classement/saison` (l. 746).

*Mitigation (Phase 0)* : normaliser la clé (`tier_filtre.upper() if valide else None`), et/ou
plafonner `_cache_store` (LRU, ~200 entrées).

---
**R-06 🟡 Le matchmaking est du JS client, non réutilisable par le bot**

`buildLobbies()` vit dans [matchmaking.html:132](../frontEnd/templates/matchmaking.html#L132).
Le bot ne pourra pas l'appeler. Le réimplémenter côté bot = deux algorithmes qui divergeront.

*Mitigation* : remonter la logique dans `services.py`, exposer `POST /api/matchmaking`, et faire
consommer la même route par la page admin **et** par le bot.

---
**R-07 🟡 Course à l'approbation de liaison**

Deux approbations concurrentes sur le même `joueur_id` violent `comptes.joueur_id UNIQUE` → 500.

*Mitigation* : `SELECT … FROM comptes WHERE joueur_id = %s FOR UPDATE` dans la même transaction,
et 409 explicite si déjà pris.

---
**R-08 🔵 Énumération des joueurs déjà liés**

`GET /auth/joueurs-disponibles` doit ne renvoyer **que** les joueurs sans compte, sinon il révèle
qui possède un compte Discord.

---

### 8.2 Sécurité / auth

---
**R-09 🔴 Discord déroule (unfurl) les liens — l'invitation serait brûlée avant le premier clic**

Coller le lien d'invitation dans un salon déclenche un `GET` du crawler Discord. Si `uses++` a lieu
à l'affichage, un lien `max_uses=1` est consommé instantanément et personne ne peut s'inscrire.
Même effet avec les *link previews* d'autres clients (Slack, Signal, antivirus d'entreprise).

*Mitigation* : `GET /invite/<token>` **strictement idempotent** (affichage seul). La consommation
se fait dans `POST /auth/discord/exchange`, après retour de Discord. En bonus, `<meta name="robots"
content="noindex">` et une balise OpenGraph neutre.

---
**R-10 🟠 Un token admin volé est renouvelable à l'infini**

`POST /admin/refresh-token` échange un token valide contre un nouveau, sans limite de chaîne ni
d'âge absolu. Un token exfiltré (cf. R-02) donne donc un accès **permanent**, pas 30 minutes.
De plus `api_tokens.token` est **stocké en clair** → un dump SQL (ou `seed.sql`, qui en contient
déjà un, l. 531) expose des sessions valides.

*Mitigation* : **rév. 2 — ce risque s'éteint avec la phase 4** : `api_tokens` et
`/admin/refresh-token` sont supprimés. Il reste une **contrainte de conception** sur
`sessions_joueurs`, qui ne doit surtout pas reproduire le motif : hash en base ✓ (§4.5), pas de
route de renouvellement sans borne, et une **expiration absolue** non extensible. D'ici la phase 4,
la mitigation d'origine tient toujours : `absolute_expiry` sur `api_tokens`, et stocker le hash.

---
**R-11 🟠 Le timeout frontend (5 s) est plus court que l'échange OAuth Discord**

`backend_request()` utilise `timeout=5` ([frontend.py:93](../frontEnd/frontend.py#L93)). L'appel
`/auth/discord/exchange` déclenche **deux appels réseau vers Discord** ; au-delà de 5 s le
frontend renvoie 503 alors que **le compte a été créé et l'invitation consommée**. L'utilisateur
retente, le lien est brûlé, il est bloqué.

*Mitigation* : timeout dédié (15-20 s) pour cet appel + **idempotence** — si `discord_id` existe
déjà, renvoyer la session existante au lieu d'échouer. Et ne consommer l'invitation qu'après
succès complet.

---
**R-12 🟠 Le `redirect_uri` sera généré en `http://` et Discord refusera**

Flask est derrière deux proxys et n'a **aucun `ProxyFix`** configuré : `url_for(..., _external=True)`
produira `http://…`. Or Discord exige que le `redirect_uri` soit **identique** (au caractère près)
entre l'appel `/authorize`, l'appel `/token` et la valeur enregistrée dans le portail développeur
→ `invalid_request`, sans message utile.
Deux pièges Discord voisins : le endpoint `/oauth2/token` attend du
**`application/x-www-form-urlencoded`** (`requests` : `data=`, **pas** `json=`), et le `redirect_uri`
doit être renvoyé dans l'appel `/token`.

*Mitigation* : `DISCORD_REDIRECT_URI` **en dur dans l'env**, jamais construit par `url_for`.

---
**R-13 🟠 `admin_logout` déconnecterait aussi le joueur**

[frontend.py:344](../frontEnd/frontend.py#L344) fait `session.clear()` après avoir déjà fait les
`pop()` ciblés. Avec un cookie partagé, l'admin qui se déconnecte éjecte sa propre session joueur.

*Mitigation* : supprimer le `session.clear()`, garder les `pop()`. Idem en miroir pour le logout joueur.

---
**R-14 🟡 Le minuteur de session admin de la navbar cassera**

`inject_lifetime()` ([frontend.py:67](../frontEnd/frontend.py#L67)) calcule le compte à rebours
depuis `app.permanent_session_lifetime`. Passer le cookie à 30 jours ferait afficher
« expire dans 30 jours » à l'admin, et le `setTimeout` de
[navbar.html:205](../frontEnd/templates/navbar.html#L205) ne déclencherait plus jamais.

*Mitigation* : recalculer depuis `token_start_time + TOKEN_LIFETIME_MINUTES`, indépendamment du cookie.

---
**R-15 🟡 Le token CSRF expire au bout d'1 h, pas 30 jours**

`flask-wtf` a son propre `WTF_CSRF_TIME_LIMIT` (3600 s par défaut). Avec une session de 30 jours,
un joueur qui laisse sa page de profil ouverte plus d'une heure verra son enregistrement rejeté
avec un message incompréhensible.

*Mitigation* : `app.config['WTF_CSRF_TIME_LIMIT'] = None` (la validité suit alors la session), ou
rafraîchir le token en JS.

---
**R-16 🟠 Passer `SESSION_COOKIE_SAMESITE` à `Strict` casserait silencieusement OAuth**

Le retour de Discord est une navigation *cross-site* vers `/auth/discord/callback`. En `Lax`
(valeur actuelle ✓) le cookie est bien envoyé sur une navigation GET de premier niveau, donc la
vérification du `state` fonctionne. En `Strict`, le cookie ne partirait pas → `state` introuvable →
échec de connexion inexplicable. Même problème si le callback devenait un POST.

*Mitigation* : **ne pas toucher à `Lax`**, et l'écrire en commentaire dans le code.

---
**R-17 🟡 Deux conventions temporelles vont cohabiter**

L'existant utilise `TIMESTAMP WITHOUT TIME ZONE` + `datetime.now()` naïf
([auth.py:25](../backEnd/auth.py#L25)), et compare parfois côté SQL (`expires_at < NOW()`), parfois
côté Python — deux horloges. Aucune variable `TZ` n'est définie dans le compose (donc UTC), ce qui
masque le problème aujourd'hui.
Introduire du `TIMESTAMPTZ` comparé à un `datetime.now()` naïf produirait des expirations décalées
(sessions qui sautent, ou qui ne meurent jamais).

*Mitigation* : nouvelles tables en `TIMESTAMPTZ`, et **exclusivement** `datetime.now(timezone.utc)`
côté Python pour ces tables. Ne jamais mélanger dans une même comparaison.

---
**R-18 🟡 Fuite de secrets dans les logs**

`logging.basicConfig(level=logging.INFO)` sur les deux services, et plusieurs
`logger.error(f"Erreur serveur: {e}")` qui recrachent l'exception brute. Un `code` OAuth ou un
token de session apparaissant dans une exception `requests` finirait dans les logs Docker.
Par ailleurs, **le token d'invitation apparaît dans les logs d'accès nginx** (le chemin est logué).

*Mitigation* : ne jamais logger le corps des réponses Discord ; TTL court + usage unique + hash en
base pour les invitations (un token logué devient inexploitable après usage) ; rotation des logs.

---
**R-19 🟠 `check_env.sh` écrase le `.env` complet dès qu'une variable manque**

[scripts/check_env.sh](../scripts/check_env.sh) : si une des `REQUIRED_VARS` est absente, `main()`
reconstruit un `.env` **ne contenant que 5 clés** et fait `mv "$tmp" "$ENV_FILE"`.
→ `DOMAIN`, `TLS_MODE`, `HTTP_PUBLISH`, `HTTPS_PUBLISH` sont **perdus**, une **nouvelle
`SECRET_KEY` est générée** (toutes les sessions invalidées) et le mot de passe admin est redemandé.
`make up` appelle `check-env`. **Donc ajouter `DISCORD_*` à `REQUIRED_VARS` déclencherait
exactement ça au premier `make up` en prod.**

*Mitigation (Phase 0, impérative)* : réécrire le script pour **fusionner** (ne compléter que les
clés manquantes, préserver le reste) avant d'ajouter la moindre variable.

---
**R-20 🟠 `seed.sql` contient des données personnelles réelles, versionnées dans git**

[backEnd/seed.sql:714+](../backEnd/seed.sql#L714) contient les vrais pseudos et tout l'historique
de matchs (`Vakaeltraz`, `Rayou`, `Melwin`, `J_sk8`, `Elite`…), plus un ancien token admin
(l. 531) — poussé sur `github.com:jmsk8/mk_reset_online`. Le fichier est monté en `02_seed.sql`
par le compose par défaut, donc `make up` amorce aussi le dev avec des données réelles.
**L'historique git est immuable** : si un joueur demande l'effacement, réécrire le fichier ne
suffit pas, la donnée reste dans les commits antérieurs.
(Un `dump.sql` fictif — Mario, Luigi… — existe déjà : le bon réflexe est là, il n'a juste pas été
appliqué à `seed.sql`.)

*Mitigation (Phase 0)* : **vérifier d'abord si le dépôt est public ou privé** — ça change la
gravité du tout au tout. Puis remplacer `seed.sql` par la fixture fictive (`dump.sql` fait déjà le
travail), et documenter la position sur l'historique git dans la politique de confidentialité.

---

### 8.3 Infra / déploiement

---
**R-21 🟠 Nouveau fichier backend : le compose et le Dockerfile ne disent pas la même chose**

Le Dockerfile fait `COPY *.py .` (le fichier **est** dans l'image après un rebuild), mais
`docker-compose.yml` monte **individuellement** chaque `.py` (l. 37-45). Un nouveau module non
listé fonctionnera après `make build`, puis **restera figé** : les éditions sur l'hôte ne seront
plus prises en compte par `docker compose restart`, contrairement à tous les autres fichiers.
Symptôme typique : « je corrige, je redémarre, rien ne change ».

*Mitigation* : ajouter chaque nouveau `.py` aux volumes du service `backend` **dans le même commit**
que sa création. (Alternative propre : monter `./backEnd:/app` en entier.)

---
**R-22 🟠 Trois fichiers SQL à synchroniser, et une prod qui n'est régie par aucun d'eux**

`schema.sql`, `seed.sql` et `dump.sql` décrivent chacun les 12 tables. `schema.sql` n'est joué
qu'au **tout premier** démarrage d'un volume postgres vierge — la base de prod n'a donc jamais vu
sa version actuelle.
→ Une nouvelle table écrite seulement dans `schema.sql` **n'existera pas en prod** ; écrite
seulement dans la migration, elle manquera à toute réinstallation propre.

*Mitigation* : checklist systématique — (1) `schema.sql`, (2) `migrations/AAAA-MM-JJ_*.sql`,
(3) fixtures si besoin, (4) **appliquer la migration à la prod à la main**, (5) dump de contrôle
avant/après.

---
**R-23 🟡 Les URLs publiques sont indexées sur le nom du joueur**

`/stats/joueur/<nom>` : une anonymisation ou un simple renommage casse tous les liens existants
(y compris ceux partagés dans Discord), et Flask ne route pas un nom contenant un `/`.

*Mitigation* : introduire `/joueur/<id>` comme URL canonique et conserver `/stats/joueur/<nom>` en
redirection 301. À faire tant qu'on touche à la page profil.

---
**R-24 🟠 Le bot Discord ne pourra pas joindre l'API : nginx n'est pas sur le réseau backend**

`docker-compose.yml` : `nginx.networks = [frontend]`, `backend.networks = [backend]`. nginx ne
proxifie **que** `frontend:5000`. Le backend n'est **pas exposé** — c'est un bon choix de sécurité,
mais ça signifie qu'aucune route `/api/bot/*` définie sur le backend ne sera atteignable depuis
internet. À découvrir au moment de brancher le bot, ce serait une mauvaise surprise de fin de projet.

*Mitigation* : **[À TRANCHER]** soit proxifier `/api/bot/` via le frontend (cohérent avec l'existant,
zéro changement réseau), soit ajouter `backend` aux réseaux de nginx et créer un `location /api/bot/`
dédié (plus direct, mais élargit la surface exposée). Préférence : **via le frontend**.

---
**R-25 🟠 Un volume média échappe complètement aux sauvegardes**

`scripts/db-dump.sh` ne dumpe que PostgreSQL. Des avatars stockés dans un volume Docker ne seraient
dans **aucune** sauvegarde : après restauration, `profils.avatar_path` pointerait dans le vide.

*Mitigation* : **[À TRANCHER]** soit stocker les images en `bytea` (les dumps couvrent tout
automatiquement, dumps plus lourds — largement acceptable vu la taille de la communauté), soit
étendre `db-dump.sh` à un `tar` du volume. **Recommandation : `bytea`**, ou mieux, phase 3a sans
upload du tout (avatar Discord via CDN, zéro stockage).

---
**R-26 🟡 Uploads d'images : la surface d'attaque classique**

Si upload il y a : nom de fichier **aléatoire** (jamais dérivé de l'entrée utilisateur → *path
traversal*), validation par **sniffing du contenu** et non par l'extension, **ré-encodage
systématique via Pillow** (supprime l'EXIF — dont la géolocalisation — et neutralise les fichiers
polyglottes JPEG/HTML), dimensions et poids plafonnés (avatar 512×512 / 2 Mo, bannière 1500×500 /
4 Mo). `client_max_body_size 10M` côté nginx est déjà suffisant.
Note : `backend_request()` ne sait faire que du JSON — un chemin multipart (ou base64) est à prévoir.

---
**R-27 🔵 Le cache est par worker gunicorn, et le marqueur d'invalidation est local au conteneur**

`invalidate_cache()` écrit dans `tempfile.gettempdir()`, partagé entre les 2 workers d'un même
conteneur. Ça marche aujourd'hui. Ça cesserait de marcher si le backend était scalé sur plusieurs
conteneurs (chacun son `/tmp`) : des données périmées seraient servies indéfiniment.

---
**R-28 🟡 Une hoquet du backend déconnecte tout le monde**

`before_request` ([frontend.py:56-65](../frontEnd/frontend.py#L56-L65)) supprime la session dès que
`/admin/check-token` ne renvoie pas 200 — **y compris sur un timeout de 1 s ou une 500**. Sur une
session admin de 30 min c'est un désagrément ; sur une session joueur de 30 jours, c'est une
déconnexion générale à chaque redémarrage du backend.
Note connexe : `admin_required` renvoie **500** sur toute exception DB ([auth.py:29-30](../backEnd/auth.py#L29-L30)),
donc une simple indisponibilité de la base est interprétée comme « session invalide ».

*Mitigation* : ne purger la session que sur **401/403** ; sur 5xx ou timeout, laisser la session en
place et laisser la route protégée échouer proprement. Et **ne pas** valider le token joueur à
chaque requête (coût réseau doublé) : validation paresseuse sur les routes qui en ont besoin, ou
mise en cache de la validité ~60 s dans la session.

---
**R-29 🔵 Rotation de `SECRET_KEY` = déconnexion générale**

Aujourd'hui, changer `SECRET_KEY` ne gêne que l'admin (30 min). Avec des sessions joueur de
30 jours, toute rotation (volontaire ou provoquée par R-19) déconnecte tout le monde et invalide
tous les tokens CSRF en vol. À documenter dans le runbook.

---
**R-30 🔵 Dette technique de la base**

Python 3.9 (**fin de support depuis octobre 2025**) côté backend contre 3.10 côté frontend, sur
`bullseye` (oldstable). `SimpleConnectionPool` n'est pas *thread-safe* — sans conséquence avec les
workers `sync` actuels, mais ajouter `--threads` à gunicorn corromprait le pool en silence.
`recalculate_tiers()` prend une **seconde connexion** alors que l'appelant en détient déjà une
([routes_admin.py:159](../backEnd/routes_admin.py#L159)) : sans risque avec 2 workers et un pool de
20, mais c'est un motif à ne pas reproduire.

---
**R-31 🟡 Aucun test, aucune CI**

Le dépôt ne contient aucun test. Un flux OAuth + sessions + suppression RGPD est précisément le
genre de code dont les régressions sont silencieuses (et où une régression = fuite de données).

*Mitigation* : au minimum un script de fumée sur le parcours complet
(invitation → callback simulé → demande → approbation → profil → export → suppression), et une
vérification que `participations` est bien inchangée après suppression de compte.

---

### 8.4 Risques fonctionnels / organisationnels

---
**R-32 🟠 Restaurer un dump ressuscite les comptes supprimés**

`make redump` / `db-dump.sh` produisent des dumps complets. Si un joueur exerce son droit à
l'effacement le 10, et qu'on restaure le dump du 3 le 15, **ses données sont de retour** — et
personne ne le saura.

*Mitigation* : tenir un **journal des suppressions** (c'est exactement à ça que sert `audit_admin`,
§4.6) et **rejouer les suppressions après toute restauration**. À écrire dans le runbook, c'est un
risque de procédure, pas de code.

---
**R-33 🟠 La revendication d'identité est déclarative**

N'importe qui disposant d'un lien d'invitation peut prétendre être le meilleur joueur du classement.
Le seul contrôle est la vigilance de l'admin. Un lien générique posté dans un salon peut aussi
fuiter hors du serveur.

*Mitigation* : privilégier les **invitations nominatives** ; afficher à l'admin le pseudo Discord,
le joueur revendiqué et le message libre ; TTL court et `max_uses` bas sur les liens génériques ;
plus tard, vérification d'appartenance au serveur Discord **par le bot**.

---
**R-34 🟡 Multi-comptes Discord (smurfing)**

`discord_id UNIQUE` empêche deux comptes site pour un même Discord, mais rien n'empêche une
personne d'avoir deux comptes Discord et de revendiquer deux joueurs. Le contrôle reste humain.
**[À TRANCHER]** : est-ce un problème dans votre communauté, ou un non-sujet ?

---
**R-35 🔵 Collision sur le pseudo anonymisé**

`joueurs.nom` est `UNIQUE` et **sensible à la casse** (`Mario` et `mario` coexistent).
`'Joueur #' || id` est unique par construction, sauf si un joueur porte littéralement ce nom.

*Mitigation* : suffixe aléatoire court (`Joueur #12-a7f3`) et recherche de joueur insensible à la
casse au moment de la revendication.

---
**R-36 🔵 Le cookie de session Flask est côté client (4 Ko)**

Ne stocker qu'un token opaque dans la session — jamais le profil, la bio ou l'avatar.
Et ne pas oublier `session.permanent = True` pour le joueur, sinon le cookie meurt à la fermeture
du navigateur (l'`admin_login` le fait, il faudra le faire aussi côté joueur).

---
**R-37 🔵 Code mort et incohérences mineures**

`routes_public.py:67` appelle `render_template('recap_list.html')` alors que l'image backend ne
contient **aucun template** (`COPY *.py .`) → 500 garantie si la route est atteinte.
`/delete-tournament/<id>`, `/health` et `/api/admin/fix-db-structure` n'ont **aucun proxy frontend**,
donc sont injoignables depuis internet. À noter surtout parce que `delete_tournament` **ne restaure
pas** `mu/sigma` depuis `old_mu/old_sigma` (contrairement à `revert_last_tournament`) : s'il
redevenait joignable, il corromprait les notes. Même famille de risque que R-01.

---

### 8.5 Risques propres à la rév. 2 (suppression du mot de passe, rôles, synchro)

---
**R-38 🔴 Sans mot de passe, plus aucune porte de secours — verrouillage total possible**

Une fois la phase 4 terminée, **le seul chemin d'administration passe par Discord**. Cinq
événements, tous hors de notre contrôle, coupent alors l'accès à l'admin :

- Discord est en panne, ou son OAuth l'est ;
- l'application OAuth est suspendue / le `CLIENT_SECRET` est révoqué ou expire ;
- le compte Discord du super-admin est banni, piraté ou supprimé ;
- une erreur de manipulation retire `superadmin` au dernier compte qui le porte ;
- `SECRET_KEY` tourne (R-19, R-29) au mauvais moment et déconnecte tout le monde.

Le scénario le plus probable n'est pas la panne de Discord, c'est le quatrième : un
`UPDATE comptes SET role='player'` de trop, et **plus personne** ne peut attribuer de rôle.

*Mitigations, cumulatives et toutes obligatoires avant l'étape 6 de la phase 4 :*

1. **Garde-fou en base et en code** : refuser tout retrait de `superadmin` s'il n'en reste qu'un.
   ```sql
   -- au minimum, un contrôle applicatif dans la même transaction :
   SELECT COUNT(*) FROM comptes WHERE role = 'superadmin' AND id <> :cible FOR UPDATE;
   ```
2. **Au moins deux comptes `superadmin`** (deux comptes Discord distincts, idéalement avec 2FA).
3. **Break-glass documenté et testé** : `docs/runbook-admin.md` avec la commande exacte —
   `docker compose exec -T db psql -U … -c "UPDATE comptes SET role='superadmin' WHERE discord_id='…'"`.
   Une procédure jamais exécutée n'est pas une procédure : la **tester une fois** avant de couper
   le mot de passe.
4. **Ne pas couper le mot de passe le jour où on branche Discord.** L'étape 5 (période de
   recouvrement) existe pour ça.

---
**R-39 🟠 Le premier `superadmin` ne peut être créé par aucune IHM (amorçage)**

Toutes les routes d'attribution de rôle exigent d'être `superadmin`. Sur une base neuve — ou sur la
prod le jour de la bascule — **personne ne l'est**.

*Mitigation* : `DISCORD_SUPERADMIN_ID` dans le `.env`. Au login, si `discord_id` correspond **et**
qu'aucun `superadmin` n'existe encore, le compte est promu, avec une ligne `audit_admin`. La
promotion est **conditionnée à l'absence** de super-admin : sinon la variable devient une porte
dérobée permanente, activable par quiconque met la main sur le `.env`.
⚠️ Ajouter cette variable **après** avoir corrigé `check_env.sh` (R-19), et ne pas la mettre dans
`REQUIRED_VARS` — elle n'est utile qu'une fois.
Alternative sans variable : migration SQL nominative, jouée à la main. Plus explicite, mais à
rejouer sur chaque environnement neuf.

---
**R-40 🔴 `comptes.role` devient la seule frontière de privilège de l'application**

Aujourd'hui, connaître le mot de passe *est* l'autorisation. Demain, un `UPDATE` sur une colonne
`VARCHAR` l'est. Toute route qui écrit `comptes` **sans liste blanche de colonnes** devient une
escalade de privilège. Le motif dangereux :

```python
# JAMAIS : un PUT /me/profil qui relaie le corps JSON tel quel
for k, v in request.json.items():
    cur.execute(f"UPDATE comptes SET {k} = %s WHERE id = %s", (v, compte_id))   # ← role inclus
```

*Mitigations* :
- **Liste blanche explicite** des colonnes modifiables dans chaque route, jamais de construction
  dynamique depuis les clés du JSON. Idem pour `statut` et `joueur_id`.
- `role` n'est écrit que par **une seule** route, protégée par `@role_required('superadmin')`.
- Un `admin` ne peut **pas** se promouvoir ni promouvoir un autre compte.
- `audit_admin` sur chaque changement, avec l'ancien et le nouveau rôle, et l'acteur.
- Vérification en base côté `@role_required`, jamais depuis le cookie ou la session : le rôle doit
  pouvoir être **retiré immédiatement**, pas au bout de 30 jours de session.

---
**R-41 🟠 La synchro du pseudo se heurte à `joueurs.nom UNIQUE` et sensible à la casse**

`joueurs.nom` est `UNIQUE`. Un pseudo Discord identique (ou identique à la casse près) à celui d'un
autre joueur fait échouer l'`UPDATE` en `IntegrityError` → 500 côté admin, sans explication.
Cas voisins, tous réels : pseudo Discord de 32 caractères contre `joueurs.nom` plus court, pseudo
contenant un `/` (casse `/stats/joueur/<nom>` — R-23), pseudo vide ou uniquement des emojis,
`global_name` `NULL` sur les vieux comptes Discord (il faut retomber sur `username`).

*Mitigation* : la route de synchro **vérifie avant d'écrire** (`SELECT id FROM joueurs WHERE
lower(nom) = lower(:nouveau) AND id <> :joueur_id`) et renvoie un **409 lisible** proposant à
l'admin de saisir un nom manuel. Normaliser : `strip()`, longueur bornée à celle de la colonne,
refus des chaînes vides. Et **toujours** `invalidate_cache()` après écriture — sinon le classement
affiche l'ancien nom pendant 5 minutes et l'admin croit que le bouton n'a rien fait.

---
**R-42 🟡 L'avatar Discord dépend du CDN : hash volatil, hotlink, et fuite de referrer**

`discord_avatar_hash` change **à chaque fois** que la personne change d'avatar — l'ancienne URL
renvoie alors un 404, et les pages affichent une image cassée jusqu'à la prochaine connexion.
Trois points connexes : le CDN Discord est un **tiers hors UE** appelé par le navigateur du
visiteur (à mentionner dans la politique de confidentialité, §6.6) ; un `<img>` vers Discord
transmet l'URL de la page en `Referer` (mettre `referrerpolicy="no-referrer"`) ; et une éventuelle
CSP devra autoriser `img-src https://cdn.discordapp.com`.

*Mitigation* : rafraîchir le hash à chaque connexion (`discord_synced_at`), `onerror` en JS vers
l'avatar par défaut Discord
(`https://cdn.discordapp.com/embed/avatars/<(discord_id >> 22) % 6>.png`, calculé côté serveur —
le décalage sur un snowflake **doit** se faire en Python, pas en JS, R-42/R-04), et **ne pas**
construire l'URL si `discord_avatar_hash` est `NULL`.

---
**R-43 🟠 Pendant la phase 4, deux systèmes d'auth cohabitent — la double lecture est le piège**

La période de recouvrement (phase 4, étape 5) est nécessaire (R-38) mais crée une fenêtre où une
route peut être protégée par `@admin_required` **ou** `@role_required('admin')`. Deux erreurs
classiques : une route où l'on a retiré l'ancien décorateur sans brancher le nouveau (**route
ouverte**), et un décorateur cumulé en `AND` au lieu de `OR` (**route morte** — l'admin Discord n'a
pas de `X-Admin-Token`).

*Mitigation* : un **seul** décorateur de transition, `@admin_or_role_required`, qui accepte
explicitement les deux et **loggue laquelle des deux voies a servi**. À la fin de l'étape 6, ce
décorateur est supprimé — et les logs disent s'il restait des appels par mot de passe. Compléter
par un inventaire écrit des routes protégées **avant** de commencer, et le recocher à la fin.

---
**R-44 🟡 Le rôle change, la session ne le sait pas**

Avec 30 jours de session, un admin dégradé en `player` (ou un compte `suspendu`) garde ses
privilèges tant que son cookie vit, si le rôle est lu depuis la session. À l'inverse, R-28 demande
de **ne pas** revalider à chaque requête, pour ne pas doubler le coût réseau.

*Mitigation* : le rôle est **toujours** relu en base dans `@role_required` (une requête indexée,
uniquement sur les routes admin, qui sont rares et non publiques) ; seule la validité *de session*
peut être mise en cache ~60 s. Et fournir au super-admin un bouton **« déconnecter toutes les
sessions de ce compte »** (`DELETE FROM sessions_joueurs WHERE compte_id = …`) — c'est aussi la
réponse à un compte Discord compromis.

---
**R-45 🔵 `discord_id` est un snowflake : il ne tient pas dans un entier JS**

Un snowflake dépasse 2^53. `VARCHAR(32)` en base (déjà prévu §4.2), **chaîne** dans tout le JSON de
l'API bot, et jamais de `parseInt()` côté JS : `JSON.parse` d'un `discord_id` numérique corrompt
silencieusement les derniers chiffres — l'identité pointée devient une autre. Même vigilance dans
le bot lui-même.

---

### 8.6 Synthèse — ordre de traitement

| Ordre | Risque | Quand |
|---|---|---|
| 1 | **R-19** `.env` écrasé par `check_env.sh` | Phase 0 — bloque tout déploiement, et R-39 en dépend |
| 2 | **R-01** suppression joueur en cascade | Phase 0 |
| 3 | **R-02** `ADMIN_TOKEN` dans le DOM | Phase 0 |
| 4 | **R-20** données réelles dans git | Phase 0 (vérifier public/privé d'abord) |
| 5 | **R-05** cache non borné | Phase 0 |
| 6 | R-09, R-11, R-12, R-13, R-16 | Phase 1 — pièges d'implémentation OAuth |
| 7 | R-14, R-15, R-28, R-36, R-45 | Phase 1 — sessions & identifiants |
| 8 | R-07, R-08, **R-41**, R-42, R-03 | Phase 2 — liaison & synchro |
| 9 | R-23 | Phase 3 — URL canonique, avant que les pseudos ne bougent |
| 10 | **R-38**, **R-39**, **R-40**, R-43, R-44 | **Phase 4 — bascule admin. R-38 conditionne l'étape 6.** |
| 11 | R-06, R-24 | Phase 5 — API bot |
| 12 | R-25, R-26 | *reporté* — sans upload en v1 (§3.5), hors périmètre |
| — | R-32, R-33 | procédure / runbook, en continu |

**Les trois verrous à ne pas forcer** : R-19 avant toute variable d'env ajoutée · R-38 avant de
supprimer le mot de passe · R-40 avant d'ouvrir la moindre route qui écrit dans `comptes`.

---

## 9. Inventaire des fichiers

**Nouveaux**
```
backEnd/auth_discord.py                        échange OAuth + upsert compte + miroir Discord
backEnd/routes_auth.py                         blueprint auth_bp
backEnd/routes_comptes.py                      profil joueur + admin comptes/liaisons/sync/rôles
backEnd/routes_bot.py                          blueprint API bot (@service_required)     [rév. 2]
backEnd/migrations/AAAA-MM-JJ_auth_discord.sql 6 tables + service_tokens
backEnd/migrations/AAAA-MM-JJ_drop_api_tokens.sql   phase 4 étape 6                      [rév. 2]
frontEnd/templates/invite.html
frontEnd/templates/mon_compte.html
frontEnd/templates/mon_profil.html
frontEnd/templates/admin_comptes.html          liaisons + écarts de pseudo + rôles       [rév. 2]
frontEnd/templates/confidentialite.html
frontEnd/templates/mentions_legales.html
docs/rgpd-registre.md
docs/runbook-rgpd.md                           procédure restauration + rejeu des suppressions (R-32)
docs/runbook-admin.md                          break-glass super-admin, à TESTER (R-38)  [rév. 2]
```

**Modifiés**
```
backEnd/schema.sql              + 7 tables (dont service_tokens)        (R-22)
backEnd/auth.py                 + @player_required, @role_required, @service_required
                                + @admin_or_role_required (transitoire, R-43)
                                — @admin_required supprimé en phase 4   (R-28 : 503 ≠ 403)
backEnd/backend.py              + register_blueprint(auth_bp, bot_bp)
backEnd/requirements.txt        + requests==2.32.5
backEnd/routes_admin.py         garde-fou DELETE joueur (R-01), anonymisation, invitations,
                                liaisons, sync profil (R-41), rôles (R-40)
                                — /admin-auth et /admin/refresh-token supprimés en phase 4
backEnd/routes_public.py        profil dans /stats/joueur, /joueur/<id> (R-23), clé de cache (R-05)
backEnd/services.py             matchmaking remonté du JS client        (R-06)
frontEnd/frontend.py            routes auth, R-11, R-13, R-14, R-15, lifetime 30 j,
                                proxy /api/bot (R-24), retrait du login admin en phase 4
frontEnd/templates/navbar.html  bloc compte joueur ; minuteur admin supprimé en phase 4 (R-14)
frontEnd/templates/stats_joueur.html          avatar Discord + bio (jamais |safe — R-04, R-42)
frontEnd/templates/gestion_joueurs.html       retirer ADMIN_TOKEN (R-02) — l. 20
frontEnd/templates/admin_ligues.html          idem — l. 98
frontEnd/templates/admin_saisons.html         idem — l. 139 (et l. 375 qui le consomme)
frontEnd/templates/add_tournament.html        idem — l. 168 (inline, pas de const)
frontEnd/templates/footer.html                liens légaux
docker-compose.yml              ⚠️ volumes des nouveaux .py (R-21)
nginx/nginx.conf                zones limit_req : auth + bot (distinctes)
nginx/snippets/app.conf         location /auth, /invite, /api/bot
scripts/check_env.sh            ⚠️ fusion au lieu de réécriture (R-19) PUIS ajout des DISCORD_*
                                — ADMIN_PASSWORD_HASH retiré de REQUIRED_VARS en phase 4
scripts/db-dump.sh              anonymisation comptes/profils          (R-25 sans objet en v1)
backEnd/seed.sql                remplacer par une fixture fictive       (R-20)
.env                            DISCORD_CLIENT_ID/_SECRET/_REDIRECT_URI, DISCORD_SUPERADMIN_ID
                                — ADMIN_PASSWORD_HASH supprimé en phase 4
README.md / CHANGELOG.md        1.5.0 (auth Discord) puis 2.0.0 (rupture : plus de mot de passe)
```

**Supprimés (phase 4, étape 6)**
```
table api_tokens · ADMIN_PASSWORD_HASH · POST /admin-auth · POST /admin/refresh-token
GET /admin/check-token · @admin_required · en-tête X-Admin-Token · session['admin_token']
page de login admin + son minuteur de navbar
```

---

## 10. Questions ouvertes

### 10.1 Tranchées par la rév. 2

| # | Question | Réponse |
|---|---|---|
| 2 | Avatars : upload ou Discord ? | **Avatar Discord via CDN, zéro stockage** (§3.5). Annule R-25/R-26 en v1. |
| 4 | Invitations nominatives auto-approuvées ? | **Non** — l'admin confirme toujours : c'est ce geste qui déclenche la synchro (but B). |
| 6 | Compte sans joueur lié ? | **Oui**, `statut='pending'` existe déjà. Un compte non lié voit le site, rien de plus. |
| 9 | Exposition de l'API bot (R-24) | **Via le frontend** — cohérent avec l'existant, aucun changement réseau. |
| — | L'admin garde-t-il un mot de passe de secours ? | **Non** (but A). D'où R-38, et sa procédure break-glass obligatoire. |

### 10.2 Encore ouvertes

1. **Le dépôt GitHub `jmsk8/mk_reset_online` est-il public ou privé ?** (conditionne la gravité de
   R-20 — `gh` n'est pas installé ici, à vérifier à la main).
3. **Couleur** : `joueurs.color` (admin, graphes) vs `profils.couleur_accent` (joueur) — qui gagne où ?
5. **Durée de session joueur** : 30 jours ? Et **pour un admin** ? Une session admin de 30 jours
   est une cible bien plus intéressante qu'une session joueur — un TTL plus court sur les comptes
   `admin`/`superadmin` serait cohérent avec les 30 min d'aujourd'hui (R-44).
7. **Bannière** : sujet reporté avec l'upload. Si elle revient, R-25/R-26 se rouvrent.
8. **Multi-comptes** (R-34) : sujet à traiter ou non-sujet ?
10. **Qui sont les admins ?** Le nombre change la conception : à deux ou trois, `audit_admin` suffit ;
    au-delà, il faudra une notion de « qui a le droit de valider les liaisons de qui ».
11. **La synchro est-elle rétroactive ?** Au moment de la bascule, les fiches `joueurs` existantes
    portent des noms saisis à la main. Faut-il proposer un écran de **rapprochement en masse**
    (pseudo Discord ↔ joueur existant), ou traiter au fil de l'eau, une liaison à la fois ?
12. **Deuxième super-admin** (R-38, mitigation 2) : quel compte Discord ? C'est la seule mitigation
    qui demande une décision humaine et pas du code.

---

## 11. Prochain pas concret

L'ordre n'est pas négociable : **R-19 d'abord**. Tant que `check_env.sh` réécrit le `.env`, ajouter
`DISCORD_CLIENT_ID` au premier `make up` de prod fait perdre `DOMAIN`, `TLS_MODE`, les ports, et
**régénère `SECRET_KEY`**. C'est vingt lignes de shell, et ça débloque tout le reste.

Puis le reste de la phase 0 (R-01, R-02, R-05, R-20), qui ne dépend d'aucune décision produit et
peut être livré dès maintenant.
