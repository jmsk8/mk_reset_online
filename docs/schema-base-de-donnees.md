# Schéma de la base de données

> État du schéma au 16/09/2026, tel que défini par `backEnd/schema.sql` et les migrations
> de `backEnd/migrations/` jusqu'à `2026-09-17_reset_global_plafond.sql` incluse.
> PostgreSQL, schéma `public`, 26 tables.

Ce document décrit ce que contient la base et **pourquoi** elle est découpée ainsi. Pour
la mécanique de chaque chantier, voir les plans dans `docs/` référencés en fin de section.

---

## 1. Vue d'ensemble

La base se lit en quatre blocs qui ne se mélangent presque jamais. La frontière la plus
importante passe entre le bloc **Compétition** et le bloc **Identité** :

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  ██  BLOC 1 — COMPÉTITION                        le dossier sportif, anonyme ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║   ┄┄ Référentiel ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄   ┄┄ Déroulé des matchs ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄   ║
║                                                                              ║
║     tiers  ····▶ classe les joueurs         sessions_tournois                ║
║                                                     ▲ 1..n                   ║
║     ligues ◀────────── joueurs ◀───────── participations ──────▶ tournois    ║
║        ▲                                                            │        ║
║        └────────────────────────────────────────────────────────────┘        ║
║                              ▲                                               ║
║   ┄┄ Saisons ┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │  ┄┄ Journaux de sigma ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄    ║
║                              │                                               ║
║     saisons ◀─┬─── awards_obtenus ──▶ types_awards     ghost_log             ║
║               │                                        grille_snapshots      ║
║               └─── league_movements                    global_resets         ║
║                                                          ▲                   ║
║                                                          └── global_reset_   ║
║                                                                details       ║
╚═══════════════════════════════════╤══════════════════════════════════════════╝
                                    │
                         comptes.joueur_id  UNIQUE, ON DELETE SET NULL
                    ═════════════════╪═════════════════  ← LA frontière
                       rompable des deux côtés sans perte pour l'autre
                                    │
╔═══════════════════════════════════╧══════════════════════════════════════════╗
║  ██  BLOC 2 — IDENTITÉ                    la personne, effaçable (RGPD)      ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║   ┄┄ Entrée ┄┄┄┄┄┄┄┄   ┄┄ La personne ┄┄┄┄   ┄┄ Ce qui pend au compte ┄┄┄┄   ║
║                                                                              ║
║    invitations ◀─────   comptes   ◀────┬─── profils            (1‑1)         ║
║                                        ├─── sessions_joueurs   (1‑n)         ║
║        les flèches vont de             ├─── permissions_admin  (1‑n)         ║
║        l'ENFANT vers le PARENT,        ├─── liaisons_demandes  (file)        ║
║        dans le sens de la FK           ├─── notifications      (figées)      ║
║                                        └─── audit_admin        (acteur)      ║
║                                                                              ║
║    noms_interdits   ⟂ aucune FK — survit volontairement à tout le reste      ║
╚══════════════════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════╗  ╔═══════════════════════════════════════╗
║  ██  BLOC 3 — RÉGLAGES            ║  ║  ██  BLOC 4 — ACCÈS MACHINE           ║
╠═══════════════════════════════════╣  ╠═══════════════════════════════════════╣
║   configuration   clé/valeur      ║  ║   service_tokens   bots Discord       ║
║   tiers           → voir bloc 1   ║  ║   api_tokens       hérité, déprécié   ║
╚═══════════════════════════════════╝  ╚═══════════════════════════════════════╝
```

**Légende commune à tous les diagrammes de ce document.**

| Symbole | Sens | | Symbole | Sens |
|---|---|---|---|---|
| `PK` | clé primaire | | `──▶` | une FK, **de l'enfant vers le parent** |
| `FK` | clé étrangère | | `····▶` | relation logique, sans FK |
| `UK` | contrainte `UNIQUE` | | `⚙` | colonne générée, jamais écrite |
| `IX` | index notable | | `⟂` | table sans aucune FK, volontairement |

Les flèches suivent le sens de la référence : `participations ──▶ tournois` se lit
« `participations` porte une FK vers `tournois` ». La cardinalité se lit donc à l'envers de
la flèche — un tournoi a *n* participations.

Inventaire des 26 tables par bloc :

| Bloc | Tables |
|---|---|
| **1. Compétition** (14) | `ligues`, `tiers`, `joueurs`, `sessions_tournois`, `tournois`, `participations`, `grille_snapshots`, `ghost_log`, `global_resets`, `global_reset_details`, `saisons`, `types_awards`, `awards_obtenus`, `league_movements` |
| **2. Identité** (9) | `invitations`, `comptes`, `profils`, `sessions_joueurs`, `permissions_admin`, `liaisons_demandes`, `notifications`, `audit_admin`, `noms_interdits` |
| **3. Réglages** (1) | `configuration` — (`tiers` est listée au bloc 1, où elle sert) |
| **4. Machine** (2) | `service_tokens`, `api_tokens` |

**La règle structurante** : `comptes` + `profils` + `sessions_joueurs` décrivent une
*personne* ; `joueurs` est un *compétiteur pseudonyme*. Supprimer un compte (droit à
l'effacement) ne touche jamais aux matchs ni au classement — le lien
`comptes.joueur_id` est en `ON DELETE SET NULL` dans les deux sens.

### Convention de temps ⚠️

Le schéma mélange deux conventions, et c'est délibéré :

| Bloc | Type | Côté Python |
|---|---|---|
| Compétition, réglages | `TIMESTAMP` (naïf) | heure locale |
| Identité, tokens de service | `TIMESTAMPTZ` | `datetime.now(timezone.utc)` **exclusivement** |

Ne jamais comparer une colonne d'un bloc avec une colonne de l'autre.

---

## 2. Compétition

### 2.1 Le cœur : joueur → participation → tournoi → session

```
   ┌─ sessions_tournois ──────────────┐
   │ PK id                            │  une occasion de jeu
   │    created_at                    │  (souvent 2 lobbies simultanés)
   └─────────────────▲────────────────┘
                     │  n tournois pour 1 session
                     │
                     │  ⚠ session_id est NOT NULL : un tournoi seul forme
                     │    une session à un seul élément — le cas normal
                     │
   ┌─ tournois ──────┴────────────────┐        ┌─ ligues ─────────────────┐
   │ PK id                            │        │ PK id                    │
   │    date                        IX│        │    nom                   │
   │ FK session_id                  IX│        │    niveau                │
   │ FK ligue_id ─────────────────────┼───────▶│    couleur               │
   │    ligue_nom        ┐ archive    │        └──────────────────────────┘
   │    ligue_couleur    ┘ figée      │                    ▲
   └─────────────────▲────────────────┘                    │
                     │  n participations pour 1 tournoi    │
                     │                                     │
   ┌─ participations ┴────────────────┐                    │
   │ PK joueur_id + tournoi_id        │                    │
   │    score, position               │                    │
   │    old_mu,   old_sigma  ┐ avant  │  le couple         │
   │    mu,       sigma      ┤ après  │  avant/après       │
   │    new_score_trueskill  ┤ du     │  alimente la       │
   │    new_tier             ┘ match  │  colonne +/-       │
   │    exclude_from_ts               │                    │
   └─────────────────┬────────────────┘                    │
                     │  n participations pour 1 joueur     │
                     ▼                                     │
   ┌─ joueurs ────────────────────────┐                    │
   │ PK id                            │                    │
   │ UK nom                           │                    │
   │    mu, sigma                     │                    │
   │  ⚙ score_trueskill = mu − 3·σ    │  colonne générée   │
   │    tier, is_ranked               │                    │
   │    consecutive_missed            │  en SESSIONS       │
   │    anonymise_at                  │  identité retirée  │
   │ FK ligue_id                    IX├────────────────────┘
   └──────────────────────────────────┘
```

**`joueurs`** — le compétiteur. `mu` et `sigma` sont les deux variables TrueSkill ;
`score_trueskill` est une colonne **générée** (`mu - 3 * sigma`), donc jamais écrite à la
main. `consecutive_missed` compte les *sessions* loupées (plus les jours, depuis
`2026-09-16_penalite_en_sessions.sql`) et pilote la pénalité ghost. `anonymise_at` marque
une identité retirée : il empêche `add_tournament` de recréer à la volée une fiche portant
un nom qu'on vient d'anonymiser.

**`sessions_tournois`** — une occasion de jeu regroupant un ou plusieurs tournois.
`tournois.session_id` est `NOT NULL` : **un tournoi seul forme une session à un seul
élément**, c'est le cas normal et non un cas particulier. Cette table remplace le
regroupement implicite par `(date, ligue_id)` qui était recalculé à deux endroits du code.
→ `docs/plan-sessions-tournois.md`

**`tournois`** — `ligue_nom` et `ligue_couleur` dupliquent la ligue *au moment du tournoi*.
C'est voulu : renommer une ligue aujourd'hui ne doit pas réécrire l'historique. Ce motif
d'archivage se retrouve dans `saisons`, `awards_obtenus` et `league_movements`.

**`participations`** — la ligne de résultat. Elle porte le *couple avant/après* de chaque
match : `old_mu`/`old_sigma` (avant calcul) et `mu`/`sigma`/`new_score_trueskill`/`new_tier`
(après). C'est ce qui permet d'afficher la colonne « +/- » d'un profil sans rejouer le
moteur. `exclude_from_ts` neutralise une participation dans le calcul TrueSkill tout en la
gardant visible.

### 2.2 Tiers et classement

**`tiers`** — la liste des tiers est **gérée par l'admin** (nom, couleur, seuil en
écart-type `seuil_k`, `rang` unique). Elle a remplacé les clés `tier_k_s/a/b` de
`configuration` pour permettre d'ajouter, supprimer et réordonner des tiers, pas seulement
de régler trois frontières fixes.

- Rang décroissant du meilleur au pire.
- `seuil_k` est `NULL` **uniquement** pour le tier de plus petit rang — le plancher n'a pas
  de seuil bas par définition.
- Le tier `'U'` (non classé) **ne figure pas** dans cette table : il est câblé en dur dans
  le code (`has_tier()`, `IP_V2_REF_REQUIRE_TIER`).

→ `docs/tableau-seuils-tiers-plan.md` (Partie B)

**`grille_snapshots`** — état figé de la grille juste avant le premier tournoi d'une
journée (PK `date + joueur_id`). Sert de moyenne de référence **fixe** à l'IP v2 : tous les
tournois d'un même jour partagent la même référence, sinon l'indice dériverait au fil de la
soirée. Critère d'inclusion : `IP_V2_REF_*` dans `constants.py`.

### 2.3 Les trois journaux de sigma

Trois tables tracent les modifications de `sigma` hors match, toutes sur la même forme
`old_sigma` / `new_sigma` / delta :

| Table | Ce qu'elle trace | Pourquoi |
|---|---|---|
| `ghost_log` | pénalité d'absence, joueur par joueur | reconstituer pourquoi un sigma a monté |
| `global_resets` | un reset de début de saison (valeur + **plafond**) | en-tête de l'opération |
| `global_reset_details` | le détail par joueur du reset | **rendre le revert exact** |

`global_reset_details` existe parce que depuis l'ajout du plafond
(`2026-09-17_reset_global_plafond.sql`) les joueurs ne reçoivent plus tous la même valeur :
celui qui butait sur le plafond a pris moins que `value_applied`. Un revert uniforme
`sigma - value_applied` lui retirerait plus qu'il n'a reçu. Le revert restaure donc
`old_sigma`, joueur par joueur.

`global_resets.max_sigma` est `NULL` pour les resets appliqués **avant** cette migration,
donc sans plafond. C'est l'information exacte : y mettre une valeur par défaut ferait croire
à un plafond qui n'a jamais été appliqué.

Les trois partagent la même forme, d'où la lecture en colonnes :

```
   ┌─ ghost_log ───────────┐  ┌─ global_resets ───────┐  ┌─ grille_snapshots ────┐
   │ PK id                 │  │ PK id                 │  │ PK date + joueur_id   │
   │ FK joueur_id        IX│  │    date               │  │ FK joueur_id          │
   │ FK tournoi_id       IX│  │    value_applied      │  │    mu, sigma          │
   │    date               │  │    max_sigma  (NULL = │  │    is_ranked, tier    │
   │    old_sigma          │  │      avant le plafond)│  │    source             │
   │    new_sigma          │  └───────────┬───────────┘  │    date             IX│
   │    penalty_applied    │              │ 1            └───────────────────────┘
   └───────────────────────┘              │ n              réf. FIXE de l'IP v2 :
     pénalité d'absence      ┌─ global_reset_details ─┐    tous les tournois d'un
     joueur par joueur       │ PK id                 │    même jour partagent la
                             │ FK reset_id         IX│    même moyenne
                             │ FK joueur_id          │
                             │    old_sigma          │
                             │    new_sigma          │
                             │    delta_applied      │
                             └───────────────────────┘
                               sans lui, pas de revert
                               exact sous plafond
```

### 2.4 Saisons, ligues et awards

```
   ┌─ saisons ──────────────────────────┐   ┌─ types_awards ───────────┐
   │ PK id                              │   │ PK id                    │
   │ UK slug                            │   │ UK code                  │
   │    nom, date_debut, date_fin       │   │    nom                   │
   │    is_active                       │   │    emoji — un vrai emoji │
   │    config_awards            jsonb  │   │      OU un chemin d'image│
   │    victory_condition               │   │    description           │
   │    ip_version  ← fige le calcul IP │   └────────────▲─────────────┘
   │  ┄ mode récap ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │                │
   │    is_yearly                       │                │ FK award_id
   │    is_league_recap                 │                │
   │    include_league_stats            │   ┌────────────┴─────────────┐
   │    include_league_moves            │   │ awards_obtenus           │
   │ FK ligue_id                        │   │ PK id                    │
   │    ligue_nom       ┐ archive       │   │ FK joueur_id           IX│
   │    ligue_couleur   ┘ figée         │   │ FK saison_id ────────────┼──┐
   └─────────▲──────────────────────────┘   │ FK award_id              │  │
             │                              │ FK ligue_id              │  │
             │ FK saison_id                 │    valeur                │  │
             │                              │    is_league_award       │  │
             │                              │    ligue_nom / _couleur  │  │
             │                              │ UK (joueur, saison,      │  │
             │                              │     award, ligue)        │  │
             │                              │ IX idem WHERE            │  │
             │                              │    ligue_id IS NULL      │  │
             │                              └──────────────────────────┘  │
             │                                                            │
             │                              ┌─────────────────────────────┘
             │                              │  les deux pointent vers saisons
   ┌─────────┴──────────────────┐           │
   │ league_movements           │◀──────────┘
   │ PK id                      │
   │ FK saison_id               │
   │ FK joueur_id               │──▶ joueurs (§2.1)
   │ FK from_ligue_id  ┐        │
   │ FK to_ligue_id    ┘        │──▶ ligues
   │    from_ligue_nom ┐archive │
   │    to_ligue_nom   ┘ figée  │
   │    direction               │
   └────────────────────────────┘

   ┌─ ligues ───────────────────┐
   │ PK id                      │   référencée par joueurs.ligue_id (IX),
   │    nom, niveau, couleur    │   tournois.ligue_id, saisons.ligue_id,
   └────────────────────────────┘   awards_obtenus.ligue_id, league_movements

        toutes ces FK sont en ON DELETE SET NULL, d'où les colonnes
        ligue_nom / ligue_couleur archivées partout à côté
```

**`saisons`** — une saison classique, une saison annuelle (`is_yearly`) ou un **récap de
ligue** (`is_league_recap`). Les drapeaux `include_league_stats` / `include_league_moves`
donnent le mode hybride : un récap classique peut embarquer les onglets ligue.
`config_awards` (jsonb) porte le paramétrage des awards de la saison. `ip_version` fige la
version de l'Indice de Performance utilisée — une saison passée garde son calcul d'origine.

**`types_awards`** — catalogue (14 entrées seedées). `emoji` contient soit un vrai emoji,
soit un chemin d'image (`trophy/saison/gold_moai.png`).

**`awards_obtenus`** — un award attribué. L'unicité est en deux morceaux, parce qu'un award
existe soit globalement, soit par ligue :

```sql
UNIQUE (joueur_id, saison_id, award_id, ligue_id)          -- awards de ligue
CREATE UNIQUE INDEX ... WHERE ligue_id IS NULL             -- award global
```

L'index partiel est nécessaire : en SQL, `NULL` n'égale pas `NULL`, donc la contrainte
`UNIQUE` seule laisserait insérer deux fois le même award global.

**`league_movements`** — promotions et relégations d'une saison, avec le nom des ligues
archivé.

---

## 3. Identité et authentification Discord

> Ces tables sont en `TIMESTAMPTZ`. Voir `docs/auth-discord-plan.md` et
> `docs/hierarchie-admin-plan.md`.

```
   ┌─ invitations ─────────────┐
   │ PK id                     │   le SEUL moyen d'entrer.
   │ UK token_hash      sha256 │   Le token brut n'est jamais stocké.
   │    label                  │
   │ FK joueur_id              │
   │    max_uses / uses        │
   │    expires_at           IX│
   │    revoked_at             │
   └─────────────▲─────────────┘
                 │ FK invitation_id
                 │
   ┌─ comptes ───┴─────────────────────────────┐
   │ PK id                                     │
   │ UK discord_id    varchar(32) ⚠ pas un int │
   │    discord_username / global_name / avatar│
   │    statut     pending / linked /          │
   │               rejected / suspended        │
   │    role       player / admin /          IX│
   │               chef_admin / superadmin     │
   │    ⚠ UK partiel : role WHERE role =       │
   │        'superadmin'  → jamais 2 superadmin│
   │    cgu_accepted_at / cgu_version          │
   │    discord_synced_at   (à chaque login)   │
   │    profil_synced_at    (propagation ADMIN)│
   │    last_login_at                          │
   │ UK joueur_id ═══════════▶ joueurs (bloc 1)│
   └──────────────────▲────────────────────────┘
                      │
      Les 6 tables ci-dessous portent toutes une FK vers comptes.
      Sauf audit_admin (SET NULL), elles sont en ON DELETE CASCADE :
      supprimer un compte purge tout ce bloc d'un seul DELETE.


 ┌───────────────────────────┐   ┌───────────────────────────┐
 │ profils            (1‑1)  │   │ sessions_joueurs   (1‑n)  │
 │ PK compte_id              │   │ PK token_hash      sha256 │
 │    bio                    │   │ FK compte_id            IX│
 │    banniere_path          │   │    expires_at   ABSOLU  IX│
 │    couleur_accent         │   │    last_seen_at           │
 │    reseaux          jsonb │   │    user_agent (pas d'IP)  │
 └───────────────────────────┘   └───────────────────────────┘

 ┌───────────────────────────┐   ┌───────────────────────────┐
 │ permissions_admin  (1‑n)  │   │ liaisons_demandes  (file) │
 │ PK id                     │   │ PK id                     │
 │ FK compte_id            IX│   │ FK compte_id              │
 │    permission             │   │ FK joueur_id   ┐          │
 │ FK accorde_par            │   │    nom_demande ┘ XOR      │
 │ UK (compte_id,permission) │   │    statut                 │
 │    → octroi idempotent    │   │ FK decided_by             │
 └───────────────────────────┘   │ IX pending / compte       │
                                 │ IX pending / joueur       │
                                 └───────────────────────────┘

 ┌───────────────────────────┐   ┌─────────────────────────────────────┐
 │ notifications             │   │ audit_admin                         │
 │ PK id                     │   │ PK id                               │
 │ FK compte_id              │   │    action                           │
 │    type                   │   │ FK acteur_compte_id  ← SET NULL :   │
 │    titre, corps           │   │      le fait survit à son auteur    │
 │      ↑ texte FIGÉ à       │   │    cible_type ┐ référence polymorphe│
 │        l'émission         │   │    cible_id   ┘ (aucune FK)         │
 │    lu_at                IX│   │    details               jsonb      │
 │ IX (compte_id, date DESC) │   │    created_at DESC                IX│
 └───────────────────────────┘   └─────────────────────────────────────┘

   ┌─ noms_interdits ──────────┐
   │ PK nom_hash        sha256 │   ⟂ aucune FK, volontairement :
   │    created_at             │     doit survivre à la suppression
   └───────────────────────────┘     de tout le reste
```

### 3.1 Entrée : invitations

`invitations` est **le seul moyen d'entrer**. Le token brut n'est jamais stocké, seulement
son `token_hash` (sha256, `CHAR(64)`). `max_uses` / `uses` autorisent une invitation
collective ; `revoked_at` la coupe avant expiration.

### 3.2 `comptes` — la personne

Colonnes notables :

| Colonne | Remarque |
|---|---|
| `discord_id` | **`varchar(32)`, pas un entier** : un snowflake dépasse 2^53 et se corrompt en JS |
| `role` | `player` \| `admin` \| `chef_admin` \| `superadmin` — seule frontière de privilège |
| `statut` | `pending` \| `linked` \| `rejected` \| `suspended` |
| `discord_synced_at` | rafraîchi à chaque connexion, sans effet sur le site |
| `profil_synced_at` | dernière propagation **admin** du pseudo vers `joueurs.nom` (jamais automatique) |

**Unicité stricte du superadmin** :

```sql
CREATE UNIQUE INDEX idx_comptes_superadmin_unique
    ON public.comptes (role) WHERE role = 'superadmin';
```

Cet index garantit « jamais 2+ ». Le « jamais 0 » reste applicatif (garde du dernier
superadmin). Comme l'index est **partiel**, il n'est pas déferrable : le legs du rôle
**doit** rétrograder l'ancien superadmin *avant* de promouvoir le nouveau, sinon `23505`.

### 3.3 `permissions_admin` — droits à la carte

Droits nommés accordés un par un à un compte `role = 'admin'`. Les rôles `chef_admin` et
`superadmin` **n'y figurent jamais** : leur socle couvre le catalogue entier par
construction. `accorde_par` doit toujours venir de `g.compte['id']`, jamais de la requête.
La contrainte `UNIQUE (compte_id, permission)` rend l'octroi idempotent
(`ON CONFLICT DO NOTHING`).

### 3.4 `liaisons_demandes` — rattachement compte ↔ joueur

Deux cas dans une seule table, arbitrés par un XOR :

```sql
CHECK ((joueur_id IS NULL) <> (nom_demande IS NULL))
```

- `joueur_id` renseigné → **rattachement** à une fiche existante ;
- `nom_demande` renseigné → **création** d'une fiche qui n'existe pas encore.

Deux index partiels sur `statut = 'pending'` interdisent qu'un compte ait deux demandes en
attente, et qu'un même joueur soit convoité par deux comptes simultanément.

### 3.5 Les autres

**`profils`** — tout le contenu généré par l'utilisateur (bio, bannière, couleur, réseaux),
`compte_id` en clé primaire. Regroupé ici pour être purgeable d'un seul `DELETE`. Pas
d'avatar : il vient du CDN Discord via `comptes.discord_avatar_hash`.

**`sessions_joueurs`** — remplaçante d'`api_tokens`. Token stocké en sha256 seul, et
expiration **absolue** : aucune route de renouvellement. Pas d'IP stockée — `user_agent`
suffit à un écran « vos sessions actives ». → `docs/mes-sessions-actives-plan.md`

**`notifications`** — texte **figé à l'émission** (`titre`, `corps`). Une notification parle
souvent d'une chose qui n'existe plus (fiche supprimée, demande refusée) ; la reconstruire
par jointure afficherait « votre demande pour (null) ».

**`audit_admin`** — accountability RGPD (art. 5.2) : changements de rôle, synchronisations
de profil. `cible_type` + `cible_id` forment une référence polymorphe non contrainte, pour
pouvoir tracer une cible même après sa suppression. `details` en jsonb.
→ `docs/rgpd-registre.md`, `docs/audit-admin-plan.md`

**`noms_interdits`** — `sha256(lower(nom))` des identités anonymisées, **jamais le nom en
clair**. Empêche `add_tournament` de recréer à la volée une fiche portant un nom qu'on vient
d'effacer. Table hors graphe, sans aucune FK — c'est le but : elle doit survivre à la
suppression de tout le reste.

---

## 4. Réglages et accès machine

**`configuration`** — table clé/valeur, tout en `varchar` (le cast est côté applicatif) :

| Clé | Défaut | Rôle |
|---|---|---|
| `tau` | `0.083` | paramètre TrueSkill |
| `ghost_enabled` | `false` | active la pénalité d'absence |
| `ghost_penalty` | `0.1` | sigma ajouté par pénalité |
| `ghost_threshold_sessions` | `4` | sessions loupées avant la 1re pénalité |
| `ghost_interval_sessions` | `1` | sessions entre deux pénalités |
| `unranked_threshold` | `10` | participations avant d'être classé |
| `sigma_threshold` | `4.0` | seuil de sigma pour être classé |
| `league_mode_enabled` | `false` | active le mode ligue |
| `inter_league_moves` | `0` | nombre de promotions/relégations |
| `ip_version_live` | `v1` | version d'IP des saisons nouvellement créées |

⚠️ Les clés `ghost_threshold_days` / `ghost_interval_days` ont été **supprimées** par
`2026-09-16_penalite_en_sessions.sql`. Les seuils comptent désormais des *sessions loupées*
et non des jours : une période sans aucune session ne pénalise plus personne, ce qui est le
comportement voulu — on sanctionne les occasions manquées, pas le temps qui passe.

**`service_tokens`** — authentification machine des bots Discord : `token_hash` sha256,
`scopes` en `text[]`, révocable, `last_used_at`.

**`api_tokens`** — ancêtre de `sessions_joueurs`, conservé pour la compatibilité.

---

## 5. Ce qui survit à quoi (`ON DELETE`)

Le comportement des FK encode la politique de rétention. Trois familles :

**`CASCADE` — la ligne n'a pas de sens seule.** Supprimer un `joueur` emporte ses
`participations`, `awards_obtenus`, `ghost_log`, `grille_snapshots`,
`global_reset_details`, `league_movements`. Supprimer un `compte` emporte son `profil`, ses
`sessions_joueurs`, `permissions_admin`, `notifications`, `liaisons_demandes`.

**`SET NULL` — la ligne survit, amputée de son contexte.** Supprimer une `ligue` laisse les
`joueurs` et `tournois` en place ; c'est exactement pourquoi `ligue_nom` et `ligue_couleur`
sont archivés à côté. Supprimer un `compte` acteur laisse l'entrée `audit_admin` (le fait
s'est produit) et la permission accordée.

**Aucune FK — volontaire.** `noms_interdits` et `audit_admin.cible_id` doivent rester
lisibles après la disparition de ce qu'ils désignent.

> ⚠️ **Anomalie repérée** : `tournois.session_id` est déclarée
> `NOT NULL ... ON DELETE SET NULL` ([schema.sql:130](../backEnd/schema.sql#L130), et
> identiquement dans
> [2026-09-15_sessions_tournois.sql:68](../backEnd/migrations/2026-09-15_sessions_tournois.sql#L68)).
> Les deux clauses se contredisent — supprimer une ligne de `sessions_tournois`
> déclencherait une violation de `NOT NULL` plutôt qu'un nettoyage propre.
> `ON DELETE CASCADE` (ou `RESTRICT`) serait cohérent avec l'intention.

---

## 6. Index

Au-delà des PK et des `UNIQUE`, les index posés visent trois usages :

| Usage | Index |
|---|---|
| Jointures du moteur | `participations(joueur_id)`, `participations(tournoi_id)`, `joueurs(ligue_id)` |
| Historique et regroupement | `tournois(date)`, `tournois(session_id)`, `grille_snapshots(date)` |
| Pages de profil et de récap | `awards_obtenus(joueur_id)`, `awards_obtenus(saison_id)`, `ghost_log(joueur_id)`, `ghost_log(tournoi_id)` |
| Revert d'un reset | `global_reset_details(reset_id)` |
| Auth | `sessions_joueurs(compte_id)`, `sessions_joueurs(expires_at)`, `invitations(expires_at)` |
| Écrans admin | `notifications(compte_id) WHERE lu_at IS NULL`, `notifications(compte_id, created_at DESC)`, `audit_admin(created_at DESC)`, `comptes(role) WHERE role <> 'player'`, `permissions_admin(compte_id)` |

Les index partiels (`WHERE lu_at IS NULL`, `WHERE role <> 'player'`) exploitent le fait que
la requête ne s'intéresse jamais qu'à une petite fraction des lignes.

---

## 7. Migrations

`schema.sql` est la **création à neuf**. Une base existante passe par les fichiers de
`backEnd/migrations/`, dans l'ordre chronologique :

| Fichier | Apport |
|---|---|
| `2026-06-17_add_borderline_award.sql` | award « Instable » |
| `2026-06-21_repair_orphaned_league_recaps.sql` | réparation de récaps de ligue orphelins |
| `2026-08-18_add_ip_version.sql` | `saisons.ip_version`, `configuration.ip_version_live` |
| `2026-08-20_add_grille_snapshots.sql` | `grille_snapshots` (référence IP v2) |
| `2026-09-02_auth_discord.sql` | bloc identité complet |
| `2026-09-02_liaison_creation_joueur.sql` | `liaisons_demandes.nom_demande` + XOR |
| `2026-09-02_noms_interdits.sql` | `noms_interdits`, `joueurs.anonymise_at` |
| `2026-09-02_notifications.sql` | `notifications` |
| `2026-09-10_hierarchie_admin.sql` | 4 rôles + `permissions_admin` |
| `2026-09-13_add_tiers_table.sql` | `tiers` |
| `2026-09-13_add_tier_thresholds.sql` | `tiers.seuil_k` |
| `2026-09-15_sessions_tournois.sql` | `sessions_tournois`, `tournois.session_id` |
| `2026-09-16_penalite_en_sessions.sql` | seuils ghost en sessions |
| `2026-09-17_reset_global_plafond.sql` | `global_resets.max_sigma`, `global_reset_details` |

⚠️ **La production est au schéma d'avant le 02/09.** Tout dump qui en provient doit passer
par `scripts/adapter-dump.sh` avant d'être utilisable en local. Vérification :
`scripts/verifier-schema-dump.sql`.

Dépendance d'ordre à connaître : `2026-09-16_penalite_en_sessions.sql` **refuse de
tourner** si `tournois.session_id` n'existe pas — sans elle, `consecutive_missed` compterait
encore des tournois isolés et non des sessions, et les nouveaux seuils n'auraient pas le
sens annoncé.

---

## 8. Chantiers en cours touchant le schéma

- **`docs/refactor-historique-recaps-plan.md`** — historique mu/sigma, recaps figés et
  awards traçables. Préparation seule, rien d'implémenté.
- **`docs/plan-achievements.md`** — système d'achievements, non implémenté.
> ⚠️ **Correction du 2026-09-17.** Ce paragraphe affirmait jusqu'ici qu'un `admin` pouvait
> encore agir sur un autre `admin` ou un `chef_admin`, la règle de rang générique n'étant
> « pas encore en place ». **C'était faux, et sur un contrôle de privilèges** — donc de
> nature à induire en erreur qui s'y fierait.

- **`compte_cible_protegee`** — ✅ **livré et testé le 2026-09-14.** La règle de rang
  générique est en place : un acteur ne peut agir que sur un compte de rang
  **strictement inférieur** au sien, les pairs compris (un `chef_admin` ne peut rien
  sur un autre `chef_admin`). Un rôle de cible inconnu vaut le rang le plus haut, un
  rôle d'acteur inconnu le rang le plus bas — l'inconnu ne donne jamais de droits.
  Voir `backEnd/auth.py` et `backEnd/tests/test_audit_auth_discord.py`. Applicatif,
  pas schéma.

  ⚠️ **Une exception délibérée**, à connaître : le décorateur laisse passer
  l'**auto-action** (`cible_id == acteur['id']`), parce que fermer ses propres sessions
  est légitime. C'est juste pour les sessions et faux pour le reste — c'est par là que
  le superadmin pouvait se suspendre lui-même (constat B-02). Les routes concernées
  portent depuis le 2026-09-17 une garde propre, `_refus_auto_verrouillage`.
