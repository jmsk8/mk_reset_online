# Hiérarchie de rôles admin + permissions à la carte — conception & registre des risques

> Document de travail interne, dans le même esprit que
> [auth-discord-plan.md](auth-discord-plan.md) : pouvoir implémenter plus tard sans refaire
> l'analyse. Écrit après lecture du backend (`constants.py`, `auth.py`, `routes_admin.py`,
> `routes_comptes.py`, `routes_auth.py`, `schema.sql`, les migrations), du frontend (`navbar.html`,
> `admin_comptes.html`, `gestion_joueurs.html`, `gestion.js`) et des tests (`test_decorators.py`,
> `harness.py`).
>
> Conventions : **[DÉCIDÉ]** = tranché par l'utilisateur · **[À TRANCHER]** = arbitrage attendu ·
> gravité 🔴 critique · 🟠 élevé · 🟡 moyen · 🔵 faible. Le registre de risques **continue la
> numérotation de [auth-discord-plan.md](auth-discord-plan.md#8-registre-des-risques) à partir de
> R-46** — les deux registres se lisent comme un seul.
>
> **Rien n'est codé.** Ce document est la conception à implémenter, pas un journal d'avancement —
> celui-ci (`hierarchie-admin-avancement.md`) sera créé au démarrage réel du chantier, sur le modèle
> de [auth-discord-avancement.md](auth-discord-avancement.md).

---

## 1. Contexte

Le projet a déjà un système d'auth Discord + rôles **livré et en fonctionnement**
(`player`/`admin`/`superadmin`), conçu dans [auth-discord-plan.md](auth-discord-plan.md). Son
§3.3bis fige le modèle actuel à 3 rôles strictement ordonnés, et son §10.2 (question 10) anticipe
déjà la suite :

> « Qui sont les admins ? Le nombre change la conception : à deux ou trois, `audit_admin` suffit ;
> au-delà, il faudra une notion de « qui a le droit de valider les liaisons de qui ». »

C'est exactement ce sujet. Le modèle plat à 3 rôles ne suffit plus dès qu'on veut que deux comptes
`admin` aient des droits différents et non emboîtés (l'un gère les joueurs, l'autre les tournois,
sans que l'un soit strictement « supérieur » à l'autre) : ce n'est plus un niveau sur une échelle,
c'est un ensemble de droits nommés. D'où l'ajout d'un palier intermédiaire (`chef_admin`) et d'un
système de permissions déléguées pour le palier `admin`.

Ce paragraphe remplace le modèle documenté en §3.3bis de `auth-discord-plan.md`, qui reste en place
comme référence historique du modèle initial (voir le bandeau ajouté à cet endroit).

---

## 2. Modèle cible à 4 rôles **[DÉCIDÉ]**

| Rôle | Niveau (`ROLE_HIERARCHY`) | Droits de base | Attribué par |
|---|---|---|---|
| `player` | 0 | inchangé | — |
| `admin` | 1 | **aucun.** Reçoit des permissions nommées, une par une, jamais au-delà du plafond de qui les accorde | `chef_admin` ou `superadmin` |
| `chef_admin` | 2 | **bloc fixe et immuable** = tout le catalogue de permissions délégables, SAUF les jetons de bot | `superadmin` seul, jamais un pair |
| `superadmin` | 3 | tout, y compris les jetons de bot. **Unique à tout instant** | — (legs atomique uniquement, §6) |

**Vocabulaire, utilisé partout dans ce document :**

- **Capacité de rôle** : un pouvoir câblé en dur via `@role_required(...)`, jamais délégable — les
  jetons de bot, la désignation d'un `chef_admin`, le transfert du rôle `superadmin`.
- **Permission déléguable** : une entrée du catalogue (`PERMISSIONS_CATALOGUE`), vérifiée via
  `@permission_required(...)`, qu'un `chef_admin` ou le `superadmin` peut accorder à un `admin`.

Cette distinction est ce qui garde structurellement les jetons de bot hors de toute délégation
possible : ils ne sont **jamais** une entrée du catalogue, y compris pour le superadmin qui
voudrait déléguer — ce n'est pas une case décochée, c'est une capacité qui n'existe pas dans le
système de permissions.

**Jetons de bot et rôles humains sont deux systèmes indépendants, sans interaction. [DÉCIDÉ]**
`service_tokens` n'est pas rattaché à `comptes` (ce ne sont pas des identifiants Discord, mais des
jetons pour un programme automatisé — un bot de matchmaking). Rien n'empêche, et rien n'a besoin
d'empêcher, qu'un même humain possède à la fois un rôle (`admin`/`chef_admin`/`superadmin`) et soit
par ailleurs l'opérateur d'un bot détenteur d'un jeton de service — les deux mécanismes d'accès ne
se recoupent jamais dans le schéma actuel, aucune règle supplémentaire à ajouter.

**Contraintes du modèle, à respecter par toute implémentation :**

1. **Unicité stricte du superadmin** — jamais zéro, jamais deux ou plus, à tout instant.
2. **Intouchabilité du superadmin** — aucun autre compte, y compris un `chef_admin`, ne peut agir
   sur le compte `superadmin` (rôle, sessions, statut, déliaison, synchro...), sur aucune route.
3. **`chef_admin` ne peut ni créer, ni promouvoir, ni supprimer un autre `chef_admin`** — seul le
   `superadmin` désigne ou rétrograde un `chef_admin`.
4. **Auto-modification de rôle interdite, y compris pour le superadmin lui-même** — un `chef_admin`
   ne peut pas changer son propre rôle ni s'auto-accorder une permission ; le `superadmin` ne peut
   **jamais** changer son propre rôle par la route `changer_role`, même vers `chef_admin` de son
   plein gré. La seule façon pour lui de quitter le rôle est de le **léguer** (§6bis) — un geste
   distinct, à sens unique, qui n'est pas une auto-modification mais un transfert vers un tiers.
5. **Plafond de délégation** — un compte ne peut jamais accorder un droit qu'il ne possède pas
   lui-même (« il ne peut pas donner des droits qu'il n'a pas »).

---

## 3. Schéma de données cible

### 3.1 Extension de `comptes_role_valide`

```sql
ALTER TABLE public.comptes DROP CONSTRAINT comptes_role_valide;
ALTER TABLE public.comptes ADD CONSTRAINT comptes_role_valide
    CHECK (role IN ('player', 'admin', 'chef_admin', 'superadmin'));
```

### 3.2 Unicité stricte du superadmin

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_comptes_superadmin_unique
    ON public.comptes (role)
    WHERE role = 'superadmin';
```

Deux points techniques à ne pas oublier à l'implémentation :

- Cet index garantit **« jamais 2+ »**, pas **« jamais 0 »**. La seconde moitié reste une garde
  applicative (déjà présente dans `changer_role` aujourd'hui pour « jamais 0 », à généraliser en
  « exactement 1 », §6).
- L'index est **non-deferrable** (Postgres ne permet pas `ADD CONSTRAINT ... UNIQUE USING INDEX`
  sur un index partiel). Conséquence directe : le transfert de superadmin doit **rétrograder
  l'ancien avant de promouvoir le nouveau**, dans cet ordre, dans la même transaction — l'ordre
  inverse percute l'index et lève `23505 unique_violation` à chaque tentative, pas seulement dans
  un cas limite.

### 3.3 Table `permissions_admin`

```sql
CREATE TABLE IF NOT EXISTS public.permissions_admin (
    id          SERIAL PRIMARY KEY,
    compte_id   INTEGER NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    permission  VARCHAR(50) NOT NULL,
    accorde_par INTEGER REFERENCES public.comptes(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT permissions_admin_unique UNIQUE (compte_id, permission)
);
CREATE INDEX IF NOT EXISTS idx_permissions_admin_compte ON public.permissions_admin(compte_id);

COMMENT ON TABLE public.permissions_admin IS
    'Permissions a la carte accordees a un compte role=admin. Les jetons de bot n''y '
    'figurent jamais : ce sont une capacite de role, verifiee par role_required(superadmin) '
    'directement, jamais par ce catalogue.';
COMMENT ON COLUMN public.permissions_admin.accorde_par IS
    'Qui a accorde ce droit. ON DELETE SET NULL : si le compte accordant est supprime '
    '(RGPD), la permission accordee reste valide -- audit_admin garde la tracabilite '
    'historique complete meme apres.';
```

- **Pas de `revoked_at`** (contrairement à `service_tokens`) : cette table représente l'état
  courant des droits, pas un historique. Une révocation fait un `DELETE` ; `audit_admin` porte la
  trace `permission_retiree` avec l'avant/après. Alternative écartée : garder les lignes révoquées
  comme `service_tokens` — rejetée parce que `permission_required` ferait alors un
  `WHERE revoked_at IS NULL` sur **chaque requête admin protégée**, alors qu'un `DELETE` donne une
  table plus petite et une requête plus simple sur le chemin chaud.
- `accorde_par ON DELETE SET NULL` suit le précédent déjà dans le schéma
  (`liaisons_demandes.decided_by`).
- `UNIQUE(compte_id, permission)` rend l'octroi idempotent (`INSERT ... ON CONFLICT DO NOTHING`).

### 3.4 `audit_admin` — nouveau vocabulaire, structure inchangée

Nouvelles valeurs pour la colonne `action` : `permission_accordee`, `permission_retiree`,
`chef_admin_designe`, `chef_admin_retrograde`, `superadmin_legue`, `permissions_purgees`
(cf. R-53). Le legs de superadmin (§6bis) écrit **une seule ligne** `superadmin_legue` avec
`details = {"ancien": id, "nouveau": id}` — c'est un seul geste atomique, l'audit doit le refléter
comme tel, pas comme un `role_retire` + `role_attribue` séparés.

### 3.5 Prérequis avant d'appliquer la migration

Si la mitigation n°2 de R-38 (« au moins deux comptes superadmin ») a été suivie en prod, le
`CREATE UNIQUE INDEX` **échouera net** à la création (Postgres refuse un index unique sur des
données qui le violent déjà). C'est un échec bruyant, donc sûr, mais à vérifier avant :

```sql
SELECT COUNT(*) FROM comptes WHERE role = 'superadmin';  -- doit valoir 1
```

Sinon, rétrograder manuellement tous les superadmin sauf un avant d'appliquer la migration.

---

## 4. Décorateurs et fonctions dans `auth.py`

### 4.1 Catalogue (`constants.py`)

```python
ROLE_CHEF_ADMIN = "chef_admin"
ROLE_HIERARCHY = {ROLE_PLAYER: 0, ROLE_ADMIN: 1, ROLE_CHEF_ADMIN: 2, ROLE_SUPERADMIN: 3}

# Catalogue des permissions delegables. Les jetons de bot n'y figurent JAMAIS --
# capacite de role (@role_required(ROLE_SUPERADMIN) direct), pas une permission.
PERMISSIONS_CATALOGUE = frozenset({
    "gestion_joueurs", "gestion_ligues", "gestion_saisons",
    "gestion_liaisons", "gestion_comptes", "gestion_invitations",
    "gestion_config", "gestion_matchmaking",
})
```

### 4.2 `permission_required`

À côté de `role_required`/`service_required`, **jamais construit sur `admin_or_role_required`**
(décorateur de transition, transitoire — R-43 de `auth-discord-plan.md` — qui accepte encore
l'ancien mot de passe partagé). Ce nouveau décorateur n'accepte que l'auth Discord.

```python
def permission_required(permission: str):
    """Exige une session admin+, et soit un role >= chef_admin, soit la permission
    nommee dans permissions_admin.

    chef_admin et superadmin passent TOUJOURS : leur socle couvre le catalogue
    delegable en entier par construction (les jetons de bot n'y sont jamais).
    """
    assert permission in PERMISSIONS_CATALOGUE  # erreur de programmation sinon
    seuil_chef = ROLE_HIERARCHY[ROLE_CHEF_ADMIN]

    def decorateur(f):
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            compte, erreur = _charger_compte_session()
            if erreur is not None:
                return erreur
            role = compte['role']
            if ROLE_HIERARCHY.get(role, 0) >= seuil_chef:
                g.compte = compte
                return f(*args, **kwargs)
            if role != ROLE_ADMIN or not _a_permission(compte['id'], permission):
                logger.warning("Permission '%s' refusee a %s (role %s) sur %s",
                                permission, compte['id'], role, request.path)
                return _erreur("Droits insuffisants", 403, 'permission_manquante')
            g.compte = compte
            return f(*args, **kwargs)
        return decorated_function
    return decorateur


def _a_permission(compte_id: int, permission: str) -> bool:
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM permissions_admin WHERE compte_id = %s AND permission = %s",
                    (compte_id, permission),
                )
                return cur.fetchone() is not None
    except Exception as e:
        logger.error("Verification de permission impossible: %s", e)
        return False   # ferme par defaut
```

### 4.2bis Garantie temps réel — pas de cache de rôle/permissions **[DÉCIDÉ]**

Un retrait de rôle ou de permission doit être **effectif à la requête suivante**, jamais différé à
la reconnexion ou à l'expiration de session. Ce n'est déjà pas un problème avec le sketch actuel —
`_charger_compte_session()` (§4.2) relit `comptes.role` en base à chaque appel, et `_a_permission`
fait de même sur `permissions_admin` — mais c'est une garantie à ne **jamais** régresser par une
optimisation future (ex. mettre le rôle en cache dans la session pour épargner une requête DB) :
un rôle ou une permission mis en cache dans la session contredirait directement l'intouchabilité et
le plafond de délégation stricts déjà décidés (§2) — un droit retiré resterait actif jusqu'à
expiration de session (jusqu'à 30 jours, §3.2 de `auth-discord-plan.md`).

*À consigner comme commentaire non manquable au-dessus de `_charger_compte_session` le jour de
l'implémentation*, sur le modèle des autres garde-fous « ne jamais » du document (Phase 0, §4.4).

### 4.3 Plafond de délégation — une fonction, deux appelants

```python
def permissions_delegables_par(compte: dict) -> frozenset:
    """Ce qu'un compte peut accorder a un admin -- meme fonction pour chef_admin
    et superadmin, pas de duplication.

    Aujourd'hui les deux ont le meme plafond (le catalogue entier), puisque le
    socle du chef_admin EST le catalogue entier. Reste un vrai calcul (pas un
    court-circuit "si chef_admin ou superadmin: True") pour qu'une future
    permission reservee au superadmin seul n'oblige a changer qu'un seul endroit.
    """
    if ROLE_HIERARCHY.get(compte['role'], 0) >= ROLE_HIERARCHY[ROLE_CHEF_ADMIN]:
        return frozenset(PERMISSIONS_CATALOGUE)
    return frozenset()
```

La route qui accorde une permission à un `admin` doit vérifier
`permission in permissions_delegables_par(g.compte)` avant d'écrire — c'est le point d'application
concret de la contrainte 5 (§2).

### 4.3bis Intouchabilité du `chef_admin` face à ses pairs **[DÉCIDÉ]**

Répond à la question C (§9) : fail-closed retenu, pas seulement par défaut en attendant — c'est la
décision finale. Un `chef_admin` ne peut agir sur le compte d'un **autre** `chef_admin` sur aucune
route d'écriture, y compris les actions mineures (révoquer ses sessions, changer son statut) — ce
n'est pas réservé aux actions lourdes déjà couvertes par la contrainte 3 (§2, création/promotion/
suppression). Seul le `superadmin` peut agir sur un `chef_admin`.

Implémentation : extension de `compte_cible_protegee` (§4.4) annoncée dès l'origine comme point
d'extension naturel — ajout de la branche `role == ROLE_CHEF_ADMIN and acteur['role'] !=
ROLE_SUPERADMIN and acteur_id != cible_id` (l'exclusion `acteur_id != cible_id` laisse un
`chef_admin` agir sur son propre compte quand c'est légitime, ex. changer son propre statut n'est
pas concerné par ce garde-là spécifiquement — voir contrainte 4/§4.5 pour l'auto-modification de
rôle, qui reste interdite séparément).

### 4.4 Intouchabilité du superadmin — décorateur, pas fonction manuelle

Choix retenu et alternative écartée, à documenter dans le code :

- **Écarté** : une fonction `verifie_cible_protegee()` appelée à la main dans chaque route.
  Rejeté car ça retombe dans le travers que ce garde-fou doit justement éviter : rien n'empêche un
  futur endpoint d'oublier l'appel (même mode d'échec que R-50 ci-dessous).
- **Retenu** : un décorateur composable, posé une fois par route, auditable par `grep`.

```python
def compte_cible_protegee(f):
    """Un superadmin est intouchable par quiconque d'autre que lui-meme, sur TOUTE
    route qui agit en ecriture sur un compte cible (compte_id dans les kwargs Flask).

    A poser SOUS role_required/permission_required dans l'empilement (le decorateur
    le plus proche de @route s'execute en premier) : g.compte doit deja exister
    quand celui-ci s'execute -- meme piege d'ordre que R-43.
    """
    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        cible_id = kwargs.get('compte_id')
        acteur = g.compte
        if cible_id is not None and cible_id != acteur['id']:
            try:
                with get_db_connection() as conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT role FROM comptes WHERE id = %s", (cible_id,))
                        row = cur.fetchone()
            except Exception as e:
                logger.error("Verification de cible protegee impossible: %s", e)
                return _erreur("Service indisponible", 503, 'indisponible')
            if row and row[0] == ROLE_SUPERADMIN:
                return _erreur(
                    "Ce compte est le super-administrateur : action impossible.",
                    403, 'cible_protegee',
                )
        return f(*args, **kwargs)
    return decorated_function
```

Usage (ordre impératif, identique partout) :

```python
@comptes_bp.route('/admin/comptes/<int:compte_id>/role', methods=['POST'])
@role_required(ROLE_CHEF_ADMIN)
@compte_cible_protegee
def changer_role(compte_id): ...
```

Ce décorateur porte **uniquement sur l'écriture** — `GET /admin/comptes` (liste) reste accessible à
un `chef_admin`, l'intouchabilité protège les actions, pas le fait de voir que le compte existe.
**[DÉCIDÉ, point B, §9]** : portée écriture seule, pas de filtrage supplémentaire en lecture, y
compris pour les vues détaillées (historique, sessions) — un `chef_admin` peut tout voir sur le
superadmin, il ne peut juste rien modifier.

Ce même décorateur porte aussi la branche `chef_admin` face à ses pairs, tranchée en §4.3bis.

### 4.5 Auto-modification interdite

```python
def refuse_auto_modification(acteur_id: int, cible_id: int):
    if acteur_id == cible_id:
        return _erreur("Action impossible sur son propre compte.", 403, 'auto_modification')
    return None
```

Posée à la main (pas en décorateur générique, car elle ne s'applique qu'à 2 routes précises :
`changer_role` et l'octroi de permission), juste après le chargement de la cible.

---

## 5. Mapping permission ↔ routes

| Permission / capacité | Onglet ou page | Routes (fichier:ligne) | Statut |
|---|---|---|---|
| `gestion_joueurs` | Gestion TrueSkill | `/admin/joueurs*` (routes_admin.py:312-553) | délégable — **hors** reset global (Phase 0, §6) |
| *(capacité chef_admin)* | même page, bloc « Reset Global » | `/api/admin/global-reset`, `/api/admin/revert-global-reset` (routes_admin.py:148-224) | **non délégable**, `@role_required(ROLE_CHEF_ADMIN)` |
| `gestion_ligues` | Gestion Ligues | `/admin/ligues/*` (routes_admin.py:1351-1449) | délégable |
| `gestion_saisons` | Gestion Saisons | `/admin/saisons*`, `/admin/count-tournois-range`, `/admin/saisons/<id>/count-tournois`, `/admin/saisons/<id>/save-awards` (routes_admin.py:568-980) | délégable |
| `gestion_saisons` *(angle mort)* | consommée par `admin_saisons.html` | `/admin/types-awards` (routes_admin.py:553-555) | sert la page **saisons**, pas joueurs, malgré son nom générique — à ne pas classer sous `gestion_joueurs` par réflexe |
| `gestion_liaisons` | Comptes → « Demandes de liaison » | `/admin/liaisons*` (routes_comptes.py:344-559) | délégable |
| `gestion_comptes` | Comptes → « Comptes » | `/admin/comptes*` **hors** `/role` (routes_comptes.py:560-825, moins 731-794) | délégable |
| *(capacité chef_admin)* | même onglet | `/admin/comptes/<id>/role` (routes_comptes.py:731) | **jamais par préfixe** — câblée à la main, `@role_required(ROLE_CHEF_ADMIN)` + logique de plafond (§6 Phase 3) |
| `gestion_invitations` | Comptes → « Invitations » | `/admin/invitations*` (routes_auth.py:158-264) | délégable |
| *(capacité superadmin)* | Comptes → « Jetons de bot » | `/admin/service-tokens*` (routes_comptes.py:1253-1350) | **hors catalogue**, déjà `@role_required(ROLE_SUPERADMIN)`, ne change pas |
| `gestion_config` | — | `/admin/config` (routes_admin.py:225-311) | **[DÉCIDÉ]** délégable |
| `gestion_matchmaking` | lien nav public (navbar.html:153, hors du bloc `{% if est_admin %}`) | `POST /admin/matchmaking` (routes_comptes.py:1194) | **[DÉCIDÉ]** permission séparée de `gestion_joueurs` |
| aucune (lecture libre admin+) | cloche de notifications | `GET /admin/notifications` (routes_comptes.py:1431) | **[DÉCIDÉ]** lisible par tout `admin`/`chef_admin`/`superadmin` sans permission dédiée |
| *(capacité chef_admin+)* | — | `POST /admin/purge-rgpd` (routes_comptes.py:1657) | **[DÉCIDÉ]** non délégable, `@role_required(ROLE_CHEF_ADMIN)` |
| *(capacité superadmin seul)* | — | `GET /api/admin/fix-db-structure` (routes_admin.py:119-147) | **[DÉCIDÉ]** non délégable, `@role_required(ROLE_SUPERADMIN)` — durci par rapport à la proposition initiale (chef_admin+), vu la sensibilité d'une opération touchant au schéma |
| `gestion_joueurs` *(angle mort)* | — | `POST /add-tournament` (routes_admin.py:982) | **[DÉCIDÉ]** saisie routinière, faible risque |
| *(capacité chef_admin+)* *(angle mort)* | bouton global en navbar (navbar.html:238), pas sur une page dédiée | `POST /api/admin/revert-last-tournament` (routes_admin.py:1251) | **[DÉCIDÉ]** non délégable — son gate JS doit être posé dans `navbar.html`, pas dans une page précise, puisqu'il est accessible depuis toutes les pages admin |
| *(capacité chef_admin+)* *(angle mort)* | — | `DELETE /delete-tournament/<id>` (routes_admin.py:1297) | **[DÉCIDÉ]** non délégable, `@role_required(ROLE_CHEF_ADMIN)` — route déjà signalée dangereuse par R-37 de `auth-discord-plan.md` (mu/sigma non restauré après suppression) |

---

## 6. Découpage en phases

### Phase 0 — Séparer le reset global de `gestion_joueurs` ✅ **LIVRÉE le 2026-09-10**

> Fait : fragment `frontEnd/templates/partiels/reset_global.html` (bloc sorti de la grille des
> outils, bordure et tag « Action globale »), include dans `gestion_joueurs.html`, et commentaires
> « NE JAMAIS convertir » au-dessus des 4 routes concernées dans `routes_admin.py`
> (`global-reset`, `revert-global-reset`, `revert-last-tournament`, `delete-tournament`).
> **Aucun décorateur modifié** — pas de changement de comportement, c'était l'objet de la phase.

Pas un problème de collision d'URL (les routes ne sont déjà pas sous `/admin/joueurs*`), mais un
risque de **proximité de code** : `apply_global_reset`/`revert_global_reset`
(routes_admin.py:148-224) sont juste avant `/admin/config` et `/admin/joueurs` (ligne 312) — une
conversion route par route faite vite y verra un bloc homogène et les rendrait déléguables par
erreur en même temps que l'édition normale des joueurs.

1. Frontend : extraire le bloc « Reset Global » de `gestion_joueurs.html` dans son propre fragment,
   distinct visuellement et dans le DOM des autres boutons de gestion joueurs.
2. Backend : commentaire non manquable au-dessus des deux routes (« NE JAMAIS convertir en
   `@permission_required('gestion_joueurs')` — voir hierarchie-admin-plan.md §6 »), décorateur cible
   fixé dès maintenant : `@role_required(ROLE_CHEF_ADMIN)`.
3. Même vigilance pour `revert-last-tournament` (bouton global navbar) et `delete-tournament`
   (§5, derniers angles morts).

### Phase 1 — Migration SQL ✅ **ÉCRITE le 2026-09-10, non appliquée**

> Fait : `backEnd/migrations/2026-09-10_hierarchie_admin.sql` (4 rôles, index unique superadmin,
> table `permissions_admin`), report dans `schema.sql`, `ROLE_CHEF_ADMIN` + `PERMISSIONS_CATALOGUE`
> dans `constants.py`, verrou `FOR UPDATE` sur `promote_bootstrap_superadmin` (§6bis.0).
>
> **Deux gardes ajoutées à `changer_role` en même temps, non prévues initialement** : passer
> `ROLE_HIERARCHY` à 4 entrées rend `chef_admin` **et** `superadmin` acceptables par cette route,
> qui validait seulement `nouveau in ROLE_HIERARCHY`. Elle refuse désormais `superadmin` (code
> `superadmin_non_attribuable`) et l'auto-modification (code `auto_modification`) — sinon la
> Phase 1 ouvrait un trou que seule la Phase 3a aurait refermé.
>
> ⚠️ **`SELECT COUNT(*) FROM comptes WHERE role = 'superadmin'` doit valoir 1 avant d'appliquer**
> (§3.5). Non vérifiable depuis l'environnement de développement — à faire sur la base réelle.

### Phase 2 — Décorateurs et fonctions génériques ✅ **LIVRÉE le 2026-09-10**

> Fait dans `auth.py` : `permission_required`, `_a_permission` + `_DbIndisponible`,
> `permissions_delegables_par`, `refuse_auto_modification`, `compte_cible_protegee`. Commentaire
> « ne jamais mettre en cache » sur `_charger_compte_session` (§4.2bis), en-tête du module
> réécrit avec la distinction capacité de rôle / permission déléguable.
>
> **Les trois correctifs de l'auto-revue sont intégrés dès l'écriture**, pas ajoutés après :
> R-55 (`_DbIndisponible` → 503, jamais 403), R-56 (`compte_cible_protegee` couvre la cible
> `chef_admin` face à un pair), R-59 (`raise ValueError` au lieu d'`assert`, qui disparaît sous
> `python -O`).
>
> **Tests** : `backEnd/tests/test_permissions.py`, 23/23 assertions vertes (conventions
> `harness.py`, pas pytest). Suite complète relancée : aucune régression — les trois fichiers
> rouges (`test_auth` 25/26, `test_liaisons` 28/34, `test_profils`) l'étaient déjà avant ce
> chantier, vérifié par `git stash`.
>
> Une ligne ajoutée aux plans de `test_auth.py` (§6, amorçage) : le `SELECT … FOR UPDATE` de
> §6bis.0 n'y figurait pas, `FakeCursor` renvoyait donc `None` et la promotion échouait. Test
> incomplet, pas code fautif.
>
> ⚠️ **Aucune route n'utilise encore ces décorateurs** — c'est la Phase 3. `permission_required`
> est écrit et testé, jamais branché, exactement comme `auth-discord-plan.md` phase 1 l'avait fait
> pour `role_required`.

### Phase 3 — Câblage route par route ✅ **LIVRÉE le 2026-09-10**

> **3a** — `changer_role` réécrite : `@role_required(ROLE_CHEF_ADMIN)` + `@compte_cible_protegee`,
> plafond par acteur (un `chef_admin` ne pose ni `chef_admin` ni `superadmin`), purge R-53 à la
> sortie du rôle `admin`, confirmation R-60 sur le dernier `chef_admin`.
> **3b** — 4 routes nouvelles : `GET /permissions`, `POST`/`DELETE /permissions/<permission>`,
> `POST /leguer-superadmin` (transaction du §6bis.2, verrou des deux lignes trié par `id`, rôle de
> l'acteur relu sous verrou, confirmation sur `discord_username`).
> **3c** — `@compte_cible_protegee` sur 8 routes d'écriture. `sync-preview` en est exclue (GET), le
> legs aussi et **délibérément** (§6bis.2 point 1).
> **3d** — 38 conversions faites, vérifiées par `grep -rn "@admin_or_role_required" routes_*.py`
> qui ne renvoie plus rien. Répartition : 30 `permission_required` (8 permissions distinctes),
> 12 `chef_admin`, 5 `superadmin`, 3 `admin`.
>
> **Frontend** : proxys des 4 routes nouvelles, et **correctif B.1 avancé ici par nécessité** —
> `_est_admin()` et `admin_headers()` portaient chacun `('admin', 'superadmin')` en dur, ce qui
> aurait verrouillé tout `chef_admin` hors de l'administration. Une seule constante `ROLES_ADMIN`
> désormais : n'en corriger qu'une donnait le symptôme le plus déroutant possible — page ouverte,
> requêtes non authentifiées, écran vide sans message.
>
> **Tests** : 16/16 (`bascule`), 19/19 (`revue`), 30/36 (`liaisons`). Trois fichiers ont dû être
> mis à jour parce qu'ils encodaient des règles que ce chantier remplace :
> - `test_bascule` scannait deux décorateurs seulement, et exigeait *« une seule écriture de
>   `comptes.role` »* — il en compte 3 (1 + les 2 du legs), l'exception assumée de R-40/§6bis.1.
> - `test_revue` vérifiait que la révocation de sessions *« accepte les deux voies d'auth »* —
>   caduc, `permission_required` n'accepte que Discord (R-54).
> - `test_liaisons` rétrogradait un superadmin par `changer_role` — désormais impossible.
>
> ⚠️ **Découverte à l'exécution** : la garde `dernier_superadmin` de `changer_role` est devenue
> **inatteignable** (`compte_cible_protegee` et `refuse_auto_modification` l'arrêtent avant).
> Conservée comme ceinture, avec un commentaire disant pourquoi elle ne se déclenche jamais — à ne
> pas supprimer au motif qu'elle « ne sert à rien ».
>
> Échecs **préexistants**, hors périmètre, vérifiés par `git stash` : `test_auth` 25/26,
> `test_liaisons` groupe R-07 (`not enough values to unpack`), `test_profils` (`TypeError`).

Checklist explicite listant chaque route une par une (jamais un remplacement en masse par
regex/préfixe) :

- **3a.** Réécriture de `changer_role` : plafond selon l'acteur (`superadmin` peut poser
  `player`/`admin`/`chef_admin`, jamais `superadmin` par cette route ; `chef_admin` peut poser
  seulement `player`/`admin`), `refuse_auto_modification`, `compte_cible_protegee`. Ajout d'une
  **confirmation bloquante** (paramètre explicite dans le corps de requête, ex.
  `{"confirmer_dernier_chef_admin": true}`, jamais un défaut silencieux) quand l'action ferait
  tomber le nombre de `chef_admin` à zéro — cf. R-60.

  ⚠️ **Cette réécriture élargit délibérément un privilège — à assumer explicitement en revue.**
  Aujourd'hui `changer_role` est `@role_required(ROLE_SUPERADMIN)` (routes_comptes.py:732) et sa
  docstring la décrit comme *« SEULE route qui écrit comptes.role, seule frontière de privilège de
  l'application »*. Après ce chantier, **deux choses changent d'un coup sur cette route** : elle
  descend à `@role_required(ROLE_CHEF_ADMIN)` (un `chef_admin` pourra donc promouvoir/rétrograder
  des `admin`), et elle n'est plus la seule à écrire `comptes.role` (le legs aussi, §6bis.1). Ce
  n'est pas une régression : c'est le §2 du présent document (« `admin` — attribué par `chef_admin`
  ou `superadmin` »). Mais les deux docstrings — celle de `changer_role` et celle du legs — doivent
  être réécrites **dans le même commit** pour qu'aucune ne mente sur l'état réel du système, sinon
  la prochaine revue de sécurité lira une garantie d'unicité qui n'existe plus.

  Garde-fous qui **restent** en place malgré cet élargissement, à vérifier un par un :
  `chef_admin` ne peut poser que `player`/`admin` (jamais `chef_admin`, §2 contrainte 3) ; il ne
  peut pas toucher une cible déjà `chef_admin` (R-56) ni le superadmin (`compte_cible_protegee`) ;
  la garde « dernier superadmin » existante (routes_comptes.py:760-773) est **conservée telle
  quelle** — c'est elle qui porte le « jamais zéro » pour cette route (§6bis.1).
- **3b.** Nouvelles routes : `POST/DELETE/GET /admin/comptes/<id>/permissions[/<permission>]`,
  `POST /admin/comptes/<id>/leguer-superadmin` (§6bis — acteur = superadmin courant, cible = le
  `<id>` de l'URL, jamais l'inverse).
- **3c.** `compte_cible_protegee` posé sur **toutes** les routes `/admin/comptes/<id>/*`
  d'écriture (`role`, `sessions`, `statut`, `delier`, `sync`, `permissions`) — cochées une à une
  contre la liste du §5.
- **3d.** Conversion `@admin_or_role_required` → `@permission_required('xxx')` /
  `@role_required(...)`, **route par route**, en suivant la checklist exhaustive de l'**annexe A**
  — 38 décorateurs à traiter, pas 8 zones. Aucune conversion par regex, préfixe ou
  chercher-remplacer : c'est le mode d'échec exact de R-50.

⚠️ Chaque route convertie perd immédiatement le chemin d'auth par mot de passe legacy
(`permission_required` ne l'accepte jamais), avant même la fin de la phase 4 étape 6 de
`auth-discord-plan.md`. Cohérent avec la trajectoire déjà actée (le mot de passe part de toute
façon) — à dire explicitement dans chaque commit de conversion, pas une régression silencieuse.

### Phase 4 — UI ✅ **LIVRÉE le 2026-09-10**

> **B.3 — les trois écrans** (`admin_comptes.html`) : sélecteur de rôle à 4 valeurs
> (`chef_admin` seulement pour le superadmin, `superadmin` jamais proposé — il se lègue), panneau
> de permissions déplié sous la ligne du compte (cases grisées hors du plafond, catalogue venu du
> backend, jamais écrit en dur), bouton de legs à double confirmation dont la seconde est vérifiée
> côté serveur contre `discord_username`. La confirmation R-60 est rejouée automatiquement quand
> le backend renvoie `dernier_chef_admin`.
>
> **B.5 — 403 propres.** Deux endroits purgeaient la session sur n'importe quel 403 :
> `gestion.js:23` (redirection vers `/admin`) et `add_tournament.html:353`, qui partait sur
> `/admin/logout` — donc **détruisait vraiment la session** pour une permission non accordée.
> Les deux distinguent désormais un refus de droit d'une session morte, sur le code renvoyé.
>
> **Gate du reset global** posé (`role_admin in ('chef_admin','superadmin')`), fermant le point 1
> de la Phase 0 laissé pour cette phase.
>
> Vérifié par rendu réel sur 4 profils : constantes JS bien formées y compris quand
> `mon_compte_id` est absent (`null`, pas une erreur de syntaxe), onglet « Jetons de bot » invisible
> pour un `chef_admin`. Catalogues backend/frontend alignés (8 = 8), suite de tests inchangée.

### Phase 4 (détail d'origine) — ce qui était prévu

> **B.1 — signal enrichi.** `/auth/me` et l'échange OAuth renvoient désormais `permissions` (lues
> dans la transaction déjà ouverte de `login()`, aucune requête ajoutée). Côté frontend :
> `ROLES_ADMIN`, `_role_session()`, `_permissions_session()`, catalogue dupliqué comme
> `CGU_VERSION`. Le repli pour une session ouverte avant ce chantier ne vaut que pour
> `chef_admin`/`superadmin`, dont le socle est le catalogue quoi qu'il arrive — un `admin` repart
> de zéro jusqu'à sa reconnexion, plutôt que de voir un menu complet menant à des 403.
> **B.2 — templates.** Le context processor expose `est_admin`, `role_admin` et `peut(...)`.
> **B.4 — gates de navbar.** Chaque entrée sous sa permission ; « Annuler le dernier tournoi »
> sous `role_admin in ('chef_admin','superadmin')` (capacité, pas permission). **Matchmaking
> corrigé** : le lien était affiché à *tous les visiteurs*, y compris non connectés, alors que la
> route exige `gestion_matchmaking` — il menait à un 403 pour presque tous ceux qui le voyaient.
>
> Vérifié par rendu réel de `navbar.html` sur 6 profils : un visiteur et un admin sans permission
> ne voient aucune entrée, un admin `gestion_saisons` ne voit que Gestion Saisons, un `chef_admin`
> voit tout.
>
> **Reste** : B.3 (les trois écrans d'`admin_comptes.html`) et B.5 (403 `permission_manquante`
> traité comme un cas normal, sans purge de session).

Détaillée en **annexe B** : c'est le morceau le plus volumineux du chantier (23 appels à
`_est_admin()` à réexaminer, un modèle de session à enrichir, trois écrans nouveaux). Résumé des
livrables :

- Signal d'interface enrichi (`_est_admin` → rôle réel + permissions), §B.1–B.2.
- Sélecteur de rôle à 4 valeurs, checklist de permissions, bouton de legs, §B.3.
- Gates de navbar et de pages par permission, §B.4.

⚠️ **`chef_admin` est verrouillé hors de l'admin tant que B.1 n'est pas fait** : `_est_admin()`
teste `role in ('admin', 'superadmin')` (frontend.py:173) — un `chef_admin` échoue ce test et se
fait rediriger vers la page de login sur **toutes** les pages admin. B.1 n'est donc pas une
amélioration cosmétique, c'est un prérequis bloquant de la Phase 4.

### Phase 5 — Tests ✅ **LIVRÉE le 2026-09-10 — 99 assertions**

> `test_permissions.py` (23) couvre les décorateurs du §4 ; `test_hierarchie_routes.py` (76)
> couvre les **routes** de la Phase 3, qui n'avaient d'abord aucun test dédié — un manque signalé
> par l'utilisateur, pas un choix.
>
> Couvert : `changer_role` (plafond par acteur, refus d'attribuer `superadmin`, auto-modification,
> purge R-53 et son absence quand rien n'est à purger, confirmation R-60 y compris le cas d'une
> valeur non booléenne) · octroi/retrait/lecture de permissions (idempotence par `rowcount`, audit
> non trompeur, `accorde_par` venu de la session — R-49, cible non-admin, auto-octroi) ·
> **le legs** : tous les refus (rôle, auto-legs sans I/O, cible absente, confirmation fausse ou
> manquante, `plus_superadmin` sur double legs) et le cas nominal, où sont vérifiés **l'ordre des
> deux `UPDATE`** (rétrograder avant promouvoir — §3.2), la ligne d'audit **unique** (§3.4), le
> verrou en **une** requête aux bornes **triées** (anti-interblocage), et la purge R-53 · les deux
> fonctions qui alimentent l'interface, panne DB comprise.
>
> **`harness.py` étendu** pour rendre ces tests possibles, de façon rétrocompatible :
> `fetchall()` rend les lignes quand le plan en fournit une liste (le legs lit deux lignes d'un
> coup), et la sentinelle `ROWCOUNT_ZERO` simule un `ON CONFLICT DO NOTHING` ou un `DELETE` sans
> effet. Les plans existants, qui ne donnent qu'un tuple, gardent leur comportement — vérifié sur
> toute la suite.
>
> ⚠️ Rappel de ce que ces tests **ne** prouvent pas : `FakeCursor` ne simule ni contrainte SQL, ni
> verrou, ni rollback. L'unicité du superadmin et l'atomicité réelle du legs ne se vérifient que
> sur un vrai Postgres.

### Phase 5 (détail d'origine) — ce qui était prévu

Conventions `harness.py`/`test_decorators.py` (pas pytest, `check()`, plan de `(regex, ligne)`) :
`permission_required` (admin avec/sans permission, bypass chef_admin/superadmin),
`permissions_delegables_par`, `compte_cible_protegee` (chef_admin bloqué sur superadmin, chef_admin
bloqué sur un pair chef_admin — §4.3bis, superadmin bloqué sur lui-même),
`refuse_auto_modification`.

Cas propres au legs (§6bis), à ne pas oublier — ce sont les plus faciles à casser sans s'en
apercevoir :

- auto-legs refusé (`acteur_id == cible_id`) ;
- confirmation invalide refusée (pseudo qui ne correspond pas) et confirmation portant bien sur
  `discord_username`, pas `discord_global_name` ;
- acteur qui n'est plus superadmin au moment du verrou → 409 `plus_superadmin` (double legs
  concurrent) ;
- cible `admin` → ses `permissions_admin` sont purgées dans la même transaction (R-53) ;
- une seule ligne d'audit `superadmin_legue`, pas deux lignes `role_*`.

Cas propres à `changer_role` réécrite : `chef_admin` refusé sur une cible déjà `chef_admin` (R-56),
`chef_admin` refusé s'il demande la valeur `chef_admin` (§2 contrainte 3), confirmation
`confirmer_dernier_chef_admin` exigée quand le compteur tomberait à zéro (R-60).

⚠️ **L'unicité stricte en base n'est pas testable avec `FakeCursor`** (pas de vraies contraintes SQL
simulées) — seule une vérification Postgres réelle ou manuelle post-migration la couvre. Idem pour
l'atomicité réelle du legs : `FakeCursor` ne simule ni `FOR UPDATE`, ni rollback, ni `23505`. Le
test unitaire couvre l'enchaînement des appels et les refus ; **la garantie « exactement un
superadmin » se vérifie sur une vraie base**, en Phase 1 et après le premier legs réel.

---

## 6bis. Le legs de superadmin **[DÉCIDÉ]**

Remplace et referme la question A de §9 (mécanisme). Reste ouvert dans ce paragraphe : rien —
tout est tranché ci-dessous.

**Principe** : le rôle `superadmin` ne se perd jamais par auto-modification (contrainte 4, §2). Il
ne se transmet que par un **legs** : un geste volontaire, unique, où l'acteur (le superadmin actuel)
désigne un successeur. Ce n'est pas symétrique à `changer_role` — c'est une route à part, avec sa
propre sémantique :

- **Acteur** : le superadmin en cours, et lui seul (`@role_required(ROLE_SUPERADMIN)`).
- **Cible du legs** : n'importe quel compte existant, quel que soit son rôle actuel —
  `player`, `admin` ou `chef_admin`. Le legs promeut directement `superadmin`, sans exiger un
  passage préalable par `chef_admin`.
- **Rôle de repli de l'ancien superadmin** : `chef_admin`, systématiquement, non configurable.
  Cohérent avec §9 (ancienne proposition A) : il redevient touchable par le nouveau superadmin, et
  garde un rôle de confiance élevé plutôt que de retomber à zéro.
- **Atomicité** : une seule transaction, ordre imposé démote-l'ancien-puis-promeut-le-nouveau
  (contrainte technique de l'index non-deferrable, §3.2) — c'est déjà ce que R-46 exige ; le legs
  en est l'unique porte d'entrée, il n'y a pas d'autre chemin pour que `comptes.role` passe à
  `superadmin`.
- **Auto-legs interdit** : `acteur_id == cible_id` doit être rejeté explicitement (R-57) — se
  léguer à soi-même n'a pas de sens et ne doit pas être une façon détournée de rester superadmin
  tout en passant une confirmation vide.
- **Confirmation forte** : proposition maintenue de §9 — retaper le pseudo Discord de la cible
  avant validation, vu l'irréversibilité du geste pour l'acteur (il ne peut pas se le rendre à
  lui-même après coup, seul le nouveau superadmin le pourrait).

**Ce qui NE change PAS par ailleurs** : `changer_role` (§6 Phase 3a) reste la route qui pose
`player`/`admin`/`chef_admin`, jamais `superadmin` — un `chef_admin` ne peut toujours pas produire
un superadmin par cette route ni par aucune autre que le legs. Le legs est la seule **route HTTP**
qui écrive `role = 'superadmin'` (l'amorçage, §6bis.0, n'est pas une route), et la seule que le
superadmin peut utiliser sur lui-même (en tant que source, jamais comme cible).

### 6bis.0 L'amorçage par `DISCORD_SUPERADMIN_ID` — troisième écrivain, déjà en place

Le mécanisme existe **déjà et fonctionne** : `promote_bootstrap_superadmin`
(auth_discord.py:205-239), appelée à chaque connexion Discord (auth_discord.py:327), promeut le
compte dont le `discord_id` vaut `DISCORD_SUPERADMIN_ID` — **uniquement s'il n'existe aucun
superadmin**. Cette condition est ce qui l'empêche d'être une porte dérobée permanente, comme le
dit sa propre docstring.

C'est donc un **troisième écrivain de `comptes.role = 'superadmin'`**, à côté de `changer_role`
(qui ne l'écrit jamais) et du legs. Il ne casse pas le modèle — sa garde `COUNT(*) = 0` est
exactement le « jamais 2 » du §3.2 — mais trois points doivent être traités :

1. **Ajouter `FOR UPDATE` au `COUNT`.** Le `SELECT COUNT(*)` (ligne 216) puis l'`UPDATE` (ligne 227)
   ne sont pas verrouillés : deux connexions Discord simultanées du compte d'amorçage sur une base
   vierge pourraient passer la garde toutes les deux. Aujourd'hui la seconde échouerait en 500 ;
   après la migration, elle heurtera l'index unique (`23505`) — même conclusion (une seule réussit),
   mais autant rendre l'échec propre. Correctif d'une ligne, à faire en Phase 1.
2. **L'amorçage reste possible après un legs, et c'est voulu.** Après un legs, la variable pointe
   toujours l'**ancien** superadmin. Tant qu'un superadmin existe, elle est ignorée (avec un
   `logger.warning` déjà en place). Mais si le nouveau superadmin disparaît (compte supprimé,
   RGPD), l'ancien redevient éligible à la simple reconnexion. **[DÉCIDÉ]** : on garde ce
   comportement — c'est un filet de secours gratuit face à R-47, bien moins lourd que le break-glass
   SQL. À documenter dans `runbook-admin.md` comme *première* option de récupération.
3. **La purge R-53 ne s'y applique pas** : le compte d'amorçage passe `player` → `superadmin` sans
   jamais avoir été `admin`, donc il n'a aucune permission à purger. Rien à ajouter, mais à ne pas
   « corriger » par symétrie avec le legs.

Aucun changement de comportement n'est nécessaire au-delà du point 1. La variable garde son rôle
actuel : amorcer une base vierge, jamais contourner le modèle.

### 6bis.1 La garde « dernier superadmin » ne s'applique **pas** au legs — et pourquoi

⚠️ **Piège majeur, à lire avant d'écrire une ligne de code.** `changer_role` contient déjà
aujourd'hui (routes_comptes.py:760-773) une garde qui **refuse en 409 `dernier_superadmin`** toute
rétrogradation du seul superadmin restant. C'est elle qui implémente le « jamais zéro » du §3.2.

Le legs commence précisément par rétrograder le seul superadmin existant. **Si la route de legs
réutilisait telle quelle la logique de `changer_role`, elle se bloquerait elle-même à chaque appel.**
Ce n'est pas un cas limite : c'est le chemin nominal, à 100 % des tentatives.

La résolution n'est pas d'affaiblir la garde de `changer_role`, mais de comprendre que les deux
routes protègent la même invariante par des moyens différents :

| | `changer_role` | legs (§6bis) |
|---|---|---|
| Peut poser `superadmin` ? | **non, jamais** | oui, c'est son objet |
| Garde « dernier superadmin » | **oui**, refuse (409) — sinon on tombe à zéro | **non**, inutile : la promotion du successeur est dans la même transaction |
| Ce qui garantit « exactement 1 » | la garde applicative | l'atomicité des deux `UPDATE` + l'index unique |

Autrement dit : `changer_role` ne peut pas garantir qu'un autre superadmin apparaîtra ensuite, donc
elle refuse ; le legs le garantit *dans la même transaction*, donc elle n'a pas besoin de refuser.
**C'est la raison d'être de la séparation en deux routes** — celle que R-40 (§7) demande de ne pas
« corriger » par une fusion.

### 6bis.2 Transaction de legs — pseudo-code de référence

Conventions du fichier existant : `get_db_connection()`, `_audit(cur, ...)` (routes_comptes.py:37),
`_acteur_id()` qui lit `g.compte` (routes_comptes.py:46), `commit`/`rollback` explicites.

```python
@comptes_bp.route('/admin/comptes/<int:compte_id>/leguer-superadmin', methods=['POST'])
@role_required(ROLE_SUPERADMIN)
# PAS de @compte_cible_protegee ici : ce decorateur refuse toute action sur un
# superadmin, or l'acteur EST le superadmin et la cible ne l'est pas encore.
# L'equivalent de la protection est porte par role_required(SUPERADMIN) ci-dessus
# (seul le superadmin appelle) + le refus d'auto-legs ci-dessous.
def leguer_superadmin(compte_id):
    """Legue le role superadmin a un autre compte. Geste unique, atomique, irreversible.

    SECONDE route (avec changer_role) qui ecrit comptes.role -- exception
    deliberee et etroite a R-40, voir 6bis.1. Ne JAMAIS fusionner les deux.
    """
    acteur_id = _acteur_id()

    # 1. Auto-legs interdit (R-57) -- avant toute I/O.
    erreur = refuse_auto_modification(acteur_id, compte_id)
    if erreur is not None:
        return erreur

    # 2. Confirmation forte : le pseudo Discord de la cible, retape par l'acteur.
    confirmation = (request.get_json(silent=True) or {}).get('confirmation_pseudo')

    try:
        with get_db_connection() as conn:
            try:
                with conn.cursor() as cur:
                    # 3. Verrouiller les DEUX lignes, dans un ordre stable (id croissant)
                    #    pour ne pas creer d'interblocage avec un changer_role concurrent.
                    cur.execute(
                        "SELECT id, role, discord_username FROM comptes WHERE id IN (%s, %s) "
                        "ORDER BY id FOR UPDATE",
                        (min(acteur_id, compte_id), max(acteur_id, compte_id)),
                    )
                    lignes = {r[0]: r for r in cur.fetchall()}
                    cible = lignes.get(compte_id)
                    if cible is None:
                        conn.rollback()
                        return jsonify({"error": "Compte introuvable"}), 404

                    # 4. Relire le role de l'acteur SOUS verrou : il peut avoir ete
                    #    legue par une autre session entre role_required et ici.
                    if lignes[acteur_id][1] != ROLE_SUPERADMIN:
                        conn.rollback()
                        return jsonify({
                            "error": "Vous n'etes plus super-administrateur.",
                            "code": "plus_superadmin",
                        }), 409

                    if confirmation != cible[2]:
                        conn.rollback()
                        return jsonify({
                            "error": "Le pseudo saisi ne correspond pas au compte cible.",
                            "code": "confirmation_invalide",
                        }), 400

                    ancien_role_cible = cible[1]

                    # 5. ORDRE IMPOSE par l'index partiel non-deferrable (3.2) :
                    #    demote-l'ancien PUIS promeut-le-nouveau. L'inverse leve 23505.
                    cur.execute(
                        "UPDATE comptes SET role = %s, updated_at = now() WHERE id = %s",
                        (ROLE_CHEF_ADMIN, acteur_id),
                    )
                    cur.execute(
                        "UPDATE comptes SET role = %s, updated_at = now() WHERE id = %s",
                        (ROLE_SUPERADMIN, compte_id),
                    )

                    # 6. La cible quitte le role admin -> purge de ses permissions (R-53).
                    if ancien_role_cible == ROLE_ADMIN:
                        cur.execute("DELETE FROM permissions_admin WHERE compte_id = %s",
                                    (compte_id,))
                        _audit(cur, 'permissions_purgees', 'compte', compte_id,
                               {"motif": "legs_superadmin"})

                    # 7. UNE SEULE ligne d'audit pour le geste (3.4).
                    _audit(cur, 'superadmin_legue', 'compte', compte_id,
                           {"ancien": acteur_id, "nouveau": compte_id,
                            "ancien_role_cible": ancien_role_cible})
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except Exception as e:
        logger.error("Legs du superadmin %s -> %s impossible: %s", acteur_id, compte_id, e)
        return jsonify({"error": "Erreur serveur"}), 500

    logger.warning("LEGS SUPERADMIN : %s -> %s", acteur_id, compte_id)
    return jsonify({"status": "success", "ancien": acteur_id, "nouveau": compte_id})
```

Quatre points que ce pseudo-code fixe et qui ne sont **pas** négociables à l'implémentation :

1. **Pas de `@compte_cible_protegee`** sur cette route (raison en commentaire ci-dessus) — c'est la
   seule exception à la Phase 3c, à noter dans la checklist pour qu'elle ne ressemble pas à un oubli.
2. **Verrouillage des deux lignes en une requête, triées par `id`** — deux `SELECT ... FOR UPDATE`
   séparés dans un ordre dépendant des paramètres sont un interblocage en attente.
3. **Re-vérification du rôle de l'acteur sous verrou** — `role_required` a lu le rôle *avant* la
   transaction ; deux legs concurrents doivent en voir un seul réussir.
4. **La purge R-53 s'applique aussi ici** : une cible qui était `admin` et devient `superadmin`
   quitte le rôle `admin`, donc ses permissions déléguées disparaissent (elles seraient de toute
   façon sans effet, mais les laisser violerait la règle « repart de zéro » du §7 R-53).

**Sur quel champ porte la confirmation.** `comptes` a deux colonnes de pseudo (schema.sql:258-259) :
`discord_username` (le handle unique, stable, ex. `jskode`) et `discord_global_name` (le nom
d'affichage, modifiable à volonté par le porteur). La confirmation doit porter sur
**`discord_username`** : un nom d'affichage peut être copié par un autre utilisateur, et c'est
exactement le genre de confusion qu'une confirmation forte est censée empêcher. L'UI (Phase 4)
affichera donc le `discord_username` de la cible à retaper, pas son nom d'affichage.

---

## 7. Registre des risques (R-46 et suivants)

**Deux tensions avec le registre existant, à corriger explicitement — pas laisser une mitigation
obsolète en place :**

- **R-38** (`auth-discord-plan.md`) recommande *« au moins deux comptes superadmin »* — le nouveau
  modèle l'interdit par construction (unicité stricte, §2). Voir R-47.
- **R-40** dit *« role n'est écrit que par une seule route »* — avec le legs atomique, deux routes
  écrivent désormais `comptes.role` (`changer_role` et `leguer-superadmin`). Pas un problème si
  documenté comme exception délibérée et étroite ; en devient un si quelqu'un « corrige » ça en
  fusionnant les deux routes sans comprendre pourquoi elles sont séparées — la raison exacte est
  en **§6bis.1** (les deux gardes du « jamais zéro » ne sont pas les mêmes), et les docstrings des
  deux routes doivent la porter (§6 Phase 3a).

### Continuité du pouvoir

---
**R-46 🔴 Legs de superadmin non atomique = fenêtre à 0 ou 2 superadmins**

Deux appels HTTP séparés (démote puis promeut) créent une fenêtre à zéro superadmin si l'un des
deux échoue entre les deux ; l'ordre inverse (promeut puis démote) percute directement l'index
unique (`23505`).

*Mitigation* : route dédiée unique (§6bis), une seule transaction, ordre démote-puis-promeut imposé
par la nature non-deferrable de l'index (§3.2), une seule ligne `audit_admin` (§3.4).

---
**R-47 🔴 L'unicité stricte aggrave R-38 : elle interdit sa propre mitigation « deux superadmins »**

Avant, on pouvait ajouter un deuxième superadmin en garde-fou humain contre un verrouillage total.
Ce nouveau modèle l'interdit *par construction*. Si l'unique superadmin perd son accès Discord
avant d'avoir légué, plus rien ne peut recréer un superadmin sans passer en break-glass SQL
direct — et le snippet actuel de `docs/runbook-admin.md`
(`UPDATE comptes SET role='superadmin' WHERE discord_id=…`) **échouera** désormais tant qu'un
superadmin existe déjà (violation de l'index).

*Mitigation* : plusieurs `chef_admin` comme filet fonctionnel (le site continue de tourner, seuls
la désignation de rôle et les jetons de bot sont bloqués — périmètre bien plus restreint qu'avant) ;
exiger un 2FA fort sur le compte Discord du superadmin (mesure humaine, à documenter) ; réécrire le
runbook break-glass en transaction à deux `UPDATE` dans le bon ordre, et **le retester** avant de
considérer ce chantier terminé.

### Frontières entre paliers

---
**R-48 🟠 Intouchabilité oubliée si posée à la main plutôt qu'en décorateur**

*Mitigation* : `@compte_cible_protegee` (§4.4), checklist explicite des routes concernées (§6
Phase 3c), grep de revue avant livraison.

---
**R-49 🟠 R-40 (liste blanche de colonnes) doit s'étendre à `permissions_admin`**

`accorde_par` doit toujours venir de `g.compte['id']`, jamais du corps de requête ;
`permission`/`compte_id` toujours validés contre `PERMISSIONS_CATALOGUE` et l'existence réelle du
compte cible.

*Mitigation* : même discipline que R-40, à citer par pointeur plutôt qu'à dupliquer.

---
**R-50 🟠 `/admin/comptes/<id>/role` oubliée dans une implémentation par préfixe**

Si la permission `gestion_comptes` est implémentée par préfixe d'URL (`/admin/comptes/*`) plutôt
que route par route, `/role` serait incluse par accident alors qu'elle doit rester une capacité de
rôle, jamais une permission déléguable.

*Mitigation* : câblage manuel documenté (§5), jamais généré par préfixe.

---
**R-51 🟡 Reset global bundlé avec `gestion_joueurs` si la Phase 0 n'est pas faite en premier**

*Mitigation* : Phase 0 (§6), à faire avant toute autre chose — déjà confirmé bloquant par
l'utilisateur.

---
**R-52 🟡 Point C — historique de la décision, gardé pour traçabilité**

Un `chef_admin` peut-il agir sur le compte d'un *autre* `chef_admin` pour des actions moins lourdes
que la promotion/suppression (ex. révoquer ses sessions en cas de piratage) ?

*Décision (2026-09-10)* : non, fail-closed retenu comme choix final (pas seulement provisoire) —
`chef_admin` protégé face à ses pairs sur toute action d'écriture, extension du décorateur en
§4.3bis. Risque refermé.

### Système de permissions

---
**R-53 🟡 Permissions fantômes : un compte rétrogradé puis re-promu `admin` récupère ses anciens droits**

Un compte qui quitte le rôle `admin` (rétrogradé `player`, ou promu `chef_admin`) puis y revient
plus tard récupère silencieusement ses permissions passées, potentiellement obsolètes.

*Mitigation, **[DÉCIDÉ]*** : `changer_role` purge `permissions_admin` pour le compte dès que son
rôle quitte `admin`, avec une ligne `audit_admin` `permissions_purgees`. Un compte qui repasse
`admin` plus tard repart de zéro permission, à réattribuer explicitement.

---
**R-54 🔵 La conversion route par route coupe l'auth par mot de passe progressivement, pas d'un coup**

*Mitigation* : documenté dans chaque commit de conversion (§6 Phase 3), cohérent avec la
trajectoire déjà actée par `auth-discord-plan.md` phase 4 étape 6.

### Anomalies trouvées à la relecture de ce document (auto-revue du 2026-09-08)

Les entrées précédentes ont été vérifiées contre le code réel (numéros de ligne, R-37, ordre des
décorateurs) et tiennent. En rejouant la logique du §4 en détail, quatre problèmes concrets
ressortent — le premier est un vrai bug, à corriger avant toute implémentation.

---
**R-55 🔴 `_a_permission` transforme une panne DB en 403, exactement ce que R-28 interdit**

`_a_permission` (§4.2) attrape **toute** exception et renvoie `False`. `permission_required`
traduit ça en `403 droits insuffisants`. Or R-28 (`auth-discord-plan.md`) est explicite : *« une
indisponibilité de la base ne doit jamais produire ces codes »*, précisément parce que le frontend
**purge la session** sur 401/403. Un admin qui a réellement la permission, mais tombe sur un hoquet
DB transitoire au moment du `SELECT`, se ferait éjecter comme si sa session était invalide.

Ironie du sort : `compte_cible_protegee`, juste en dessous dans ce même document (§4.4), gère le
même type d'erreur **correctement** (`return _erreur("Service indisponible", 503, ...)`). Les deux
fonctions font le même genre de requête DB et devraient suivre la même convention.

*Mitigation* : `_a_permission` doit laisser remonter l'exception (ou la signaler autrement) pour
que `permission_required` renvoie 503, pas 403, sur une panne DB — même patron que
`compte_cible_protegee` et que `role_required` existant.

---
**R-56 🟠 La contrainte « chef_admin ne peut pas rétrograder un pair chef_admin » (§2, point 3) n'a aucun mécanisme d'application**

Ce n'est pas la question C encore ouverte (sessions, actions mineures) — **celle-ci est déjà
`[DÉCIDÉ]`** en §2. Mais rien dans le §4 ne l'implémente : `compte_cible_protegee` (§4.4) ne teste
que `role == ROLE_SUPERADMIN` sur la cible, jamais `ROLE_CHEF_ADMIN`. Et le plan de `changer_role`
(§6 Phase 3a — *« chef_admin peut poser seulement player/admin »*) ne restreint que la **valeur
demandée**, jamais le **rôle actuel de la cible**. Tel que sketché, un `chef_admin` qui appelle
`changer_role` sur le compte d'un autre `chef_admin` en demandant `admin` passe les deux contrôles
sans encombre : rien ne s'y oppose.

*Mitigation* : ajouter un contrôle explicite dans `changer_role` (ou étendre
`compte_cible_protegee`) : si le rôle **actuel** de la cible est `chef_admin` et l'acteur n'est pas
`superadmin` → refus. Distinct de la question C (§9), qui porte sur les actions *autres* que le
changement de rôle (sessions, statut...).

---
**R-57 🟡 `refuse_auto_modification` n'est prévue que sur 2 routes ; la Phase 3b en introduit une 3ᵉ**

§4.5 dit explicitement que ce garde n'est posé « que » sur `changer_role` et l'octroi de
permission. Mais §6 Phase 3b ajoute `POST /admin/comptes/<id>/leguer-superadmin` (§6bis), qui a
évidemment besoin du même garde — un legs du rôle superadmin vers soi-même n'a aucun sens et doit
être rejeté explicitement (auto-legs interdit, §6bis), pas laissé au hasard du reste de la logique.

*Mitigation* : élargir `refuse_auto_modification` à cette 3ᵉ route explicitement nommée — tranché
en §6bis, `acteur_id == cible_id` y est un cas d'erreur nommé, pas un oubli.

---
**R-58 🔵 `fix-db-structure` et `delete-tournament` sont discutées comme un choix de permission, alors qu'elles sont déjà injoignables depuis internet (R-37)**

Vérifié dans le code : ni `/api/admin/fix-db-structure` ni `/delete-tournament/<id>` n'ont de proxy
dans `frontEnd/frontend.py` — R-37 (`auth-discord-plan.md`) le signalait déjà, et c'est toujours
vrai. Le §5 de ce document propose une classification pour ces deux routes comme si elles étaient
en service, sans rappeler qu'elles ne le sont pas.

*Mitigation* : pas un problème pour ce document en tant que tel (autant décider maintenant du
décorateur cible), mais **le jour où quelqu'un corrige R-37 en ajoutant un proxy**, il faut relier
ce geste au décorateur retenu ici — les deux chantiers ne sont référencés nulle part l'un vers
l'autre aujourd'hui, et un proxy ajouté « vite fait » pourrait rouvrir ces routes avec seulement
`@admin_or_role_required` (l'état actuel), pas le nouveau modèle.

---
**R-59 🔵 Deux nits mineurs**

- La justification de l'ordre des décorateurs en §4.4 (*« même piège d'ordre que R-43 »*) est un
  raccourci trompeur : R-43 parle du piège ET-au-lieu-de-OU de `admin_or_role_required`, pas de la
  disponibilité de `g.compte`. Pièges voisins (tous deux liés à l'empilement de décorateurs), pas
  identiques — à reformuler pour ne pas envoyer un futur lecteur vérifier au mauvais endroit.
- `assert permission in PERMISSIONS_CATALOGUE` (§4.2) est un garde-fou de développement (détecte
  une faute de frappe sur un littéral écrit par un dev, pas une entrée utilisateur), mais `assert`
  disparaît sous `python -O`. Sans gravité ici vu ce qu'il protège, mais un `if ... : raise
  ValueError(...)` serait plus sûr et coûte rien.

---
**R-60 🟡 Rien n'empêche de retomber à zéro `chef_admin`, aggravant le filet fonctionnel de R-47 sans avertissement**

R-47 s'appuie explicitement sur *« plusieurs `chef_admin` comme filet fonctionnel »* en cas de
verrouillage du `superadmin`. Mais `changer_role` (§6 Phase 3a), tel que sketché, laisse le
`superadmin` rétrograder son dernier `chef_admin` restant sans le moindre avertissement — un clic
malheureux aggrave silencieusement l'exposition à R-47 au pire moment (juste avant, par exemple,
que le compte Discord du `superadmin` ne devienne indisponible).

*Décision (2026-09-10)* : pas un blocage dur (le `superadmin` reste souverain sur ses `chef_admin`,
§2 contrainte 3) — une **confirmation bloquante explicite** côté route et UI quand l'action ferait
tomber le compte de `chef_admin` à zéro (`COUNT(*) WHERE role = 'chef_admin'` avant écriture,
excluant la cible en cours de rétrogradation). Le paramètre de confirmation doit être un champ
nommé du corps de requête, jamais un défaut silencieux côté client.

---

## Annexe A — Checklist exhaustive des 38 conversions (Phase 3d)

Relevé exact du code au 2026-09-10 (`grep -B4 "@admin_or_role_required"`) : **38 décorateurs**,
répartis en 22 (`routes_admin.py`) + 13 (`routes_comptes.py`) + 3 (`routes_auth.py`). Le §5 mappe
des *zones fonctionnelles* ; cette annexe est la liste opérationnelle à cocher une par une. Toute
route absente de cette liste et portant encore `@admin_or_role_required` après la Phase 3 est un
oubli, pas un choix.

**Convention de la colonne « Cible »** : `perm:xxx` = `@permission_required('xxx')` ·
`chef` = `@role_required(ROLE_CHEF_ADMIN)` · `super` = `@role_required(ROLE_SUPERADMIN)` ·
`admin+` = `@role_required(ROLE_ADMIN)` (tout admin, sans permission dédiée).

### `routes_admin.py` — 22 conversions

| ☐ | Ligne | Route | Cible |
|---|---|---|---|
| ☐ | 112 | `GET /admin/check-token` | `admin+` — simple sonde de validité de session, aucune donnée métier (cf. note ci-dessous) |
| ☐ | 119 | `GET /api/admin/fix-db-structure` | `super` (§5, durci — R-58 : pas de proxy aujourd'hui) |
| ☐ | 148 | `POST /api/admin/global-reset` | `chef` — **Phase 0**, ne jamais passer en `perm:gestion_joueurs` |
| ☐ | 191 | `POST /api/admin/revert-global-reset` | `chef` — **Phase 0**, idem |
| ☐ | 225 | `GET /admin/config` | `perm:gestion_config` |
| ☐ | 249 | `POST /admin/config` | `perm:gestion_config` |
| ☐ | 312 | `GET /admin/joueurs` | `perm:gestion_joueurs` |
| ☐ | 345 | `PUT /admin/joueurs/<id>` | `perm:gestion_joueurs` |
| ☐ | 367 | `DELETE /admin/joueurs/<id>` | `perm:gestion_joueurs` |
| ☐ | 458 | `POST /admin/joueurs/<id>/anonymiser` | `perm:gestion_joueurs` ⚠️ RGPD — cf. note |
| ☐ | 515 | `POST /admin/joueurs` | `perm:gestion_joueurs` |
| ☐ | 553 | `GET /admin/types-awards` | `perm:gestion_saisons` (§5 : sert la page saisons, **pas** joueurs) |
| ☐ | 568 | `GET,POST /admin/saisons` | `perm:gestion_saisons` |
| ☐ | 664 | `DELETE /admin/saisons/<id>` | `perm:gestion_saisons` |
| ☐ | 723 | `GET /admin/count-tournois-range` | `perm:gestion_saisons` |
| ☐ | 751 | `GET /admin/saisons/<id>/count-tournois` | `perm:gestion_saisons` |
| ☐ | 781 | `POST /admin/saisons/<id>/save-awards` | `perm:gestion_saisons` |
| ☐ | 982 | `POST /add-tournament` | `perm:gestion_joueurs` (§5, angle mort tranché) |
| ☐ | 1251 | `POST /api/admin/revert-last-tournament` | `chef` — gate JS dans `navbar.html` (§5) |
| ☐ | 1297 | `DELETE /delete-tournament/<id>` | `chef` (§5 ; R-37 : pas de proxy aujourd'hui) |
| ☐ | 1351 | `POST /admin/ligues/setup` | `perm:gestion_ligues` |
| ☐ | 1419 | `GET /admin/ligues/draft-simulation` | `perm:gestion_ligues` |

### `routes_comptes.py` — 13 conversions

| ☐ | Ligne | Route | Cible |
|---|---|---|---|
| ☐ | 344 | `GET /admin/liaisons` | `perm:gestion_liaisons` |
| ☐ | 402 | `POST /admin/liaisons/<id>/approve` | `perm:gestion_liaisons` |
| ☐ | 511 | `POST /admin/liaisons/<id>/reject` | `perm:gestion_liaisons` |
| ☐ | 560 | `GET /admin/comptes` | `perm:gestion_comptes` — lecture, **pas** de `compte_cible_protegee` (§4.4, portée écriture) |
| ☐ | 670 | `GET /admin/comptes/<id>/sync-preview` | `perm:gestion_comptes` — GET, **pas** de `compte_cible_protegee` |
| ☐ | 686 | `POST /admin/comptes/<id>/sync` | `perm:gestion_comptes` **+ `compte_cible_protegee`** (3c) |
| ☐ | 797 | `DELETE /admin/comptes/<id>/sessions` | `perm:gestion_comptes` **+ `compte_cible_protegee`** (3c) |
| ☐ | 826 | `POST /admin/comptes/<id>/delier` | `perm:gestion_comptes` **+ `compte_cible_protegee`** (3c) |
| ☐ | 897 | `POST /admin/comptes/<id>/statut` | `perm:gestion_comptes` **+ `compte_cible_protegee`** (3c) |
| ☐ | 1169 | `GET /avatar/compte/<id>` | `admin+` — sert une image, pas une donnée d'administration (cf. note) |
| ☐ | 1194 | `POST /admin/matchmaking` | `perm:gestion_matchmaking` (§5, permission séparée) |
| ☐ | 1431 | `GET /admin/notifications` | `admin+` (§5 : lecture libre, sans permission dédiée) |
| ☐ | 1657 | `POST /admin/purge-rgpd` | `chef` (§5, non délégable) |

*Non listée ici car elle ne porte pas `@admin_or_role_required`* : `POST /admin/comptes/<id>/role`
(ligne 731) est déjà `@role_required(ROLE_SUPERADMIN)` et fait l'objet de la Phase **3a**
(réécriture + élargissement à `chef`), pas d'une simple conversion.

### `routes_auth.py` — 3 conversions

| ☐ | Ligne | Route | Cible |
|---|---|---|---|
| ☐ | 158 | `GET /admin/invitations` | `perm:gestion_invitations` |
| ☐ | 191 | `POST /admin/invitations` | `perm:gestion_invitations` |
| ☐ | 244 | `POST /admin/invitations/<id>/revoquer` | `perm:gestion_invitations` |

### Notes sur les trois routes absentes du mapping §5

Le §5 raisonne par zone fonctionnelle et ne les couvrait pas. Décidées ici :

- **`/admin/check-token` (112)** — renvoie `{"status": "valid"}`, rien d'autre. C'est une sonde de
  session, pas une capacité : `admin+` suffit. La passer sous une permission la rendrait
  inutilisable pour un `admin` fraîchement créé sans permission, ce qui casserait la détection de
  session côté frontend.
- **`/avatar/compte/<id>` (1169)** — sert l'image d'un compte, y compris en attente/suspendu.
  `admin+` : c'est un rendu d'image, pas de la donnée de gestion, et le gater sous
  `gestion_comptes` afficherait des avatars cassés dans la liste pour un `admin` qui a d'autres
  permissions.
- **`/admin/joueurs/<id>/anonymiser` (458)** — reste sous `perm:gestion_joueurs` comme le reste de
  la zone, **mais c'est une opération RGPD irréversible**. Divergence assumée avec `purge-rgpd`
  (1657, `chef`) : celle-ci détruit des données de compte, l'anonymisation joueur préserve
  l'historique des matchs (c'est son objet). Si cette asymétrie gêne à la revue, la remonter en
  `chef` est un changement d'une ligne — à décider en Phase 3, pas maintenant.

### Vérification de fin de Phase 3

```bash
grep -rn "@admin_or_role_required" backEnd/routes_*.py   # doit ne rien renvoyer
```

Tant que cette commande renvoie une ligne, la Phase 3 n'est pas finie — et le décorateur
`admin_or_role_required` lui-même ne peut pas être supprimé de `auth.py` (R-43).

---

## Annexe B — Organisation du front (Phase 4)

### B.0 Le principe qui commande tout le reste

Le front ne devient **jamais** une frontière de privilège. `_est_admin()` le dit déjà dans sa
docstring (frontend.py:164-173) : *« Porte d'INTERFACE, pas frontière de privilège […] L'autorité
reste le backend, qui le relit en base à chaque requête protégée. »*

Cette phrase reste vraie avec 4 rôles et 8 permissions, et elle a une conséquence directe : le rôle
et les permissions affichés viennent d'une **copie en session, potentiellement périmée**. Un admin
dont on vient de retirer `gestion_saisons` verra encore l'onglet jusqu'à sa prochaine reconnexion,
et recevra un 403 en cliquant. C'est le comportement voulu — le rafraîchir à chaque page coûterait
un appel réseau par page (R-28) — mais l'UI doit le **gérer proprement** (B.5) au lieu de faire
semblant que ça n'arrive pas.

### B.1 Enrichir le signal de session — prérequis bloquant

**Le problème immédiat** : `_est_admin()` teste `compte.get('role') in ('admin', 'superadmin')`
(frontend.py:173). Un `chef_admin` **échoue ce test** et se fait rediriger vers le login sur les 23
points d'appel. Rien de la Phase 4 ne fonctionne tant que ce n'est pas corrigé.

Trois fonctions à reprendre dans `frontend.py`, toutes au même endroit :

```python
def _compte_session():
    return session.get('compte') or {}

def _role():
    """Role reel de la session, '' si non connecte. Copie potentiellement perimee."""
    return _compte_session().get('role') or ''

def _est_admin():
    """Porte d'INTERFACE (inchangee dans son role) : la page s'ouvre-t-elle ?

    Desormais admin+ INCLUT chef_admin. Ne dit RIEN des droits reels : un admin
    sans aucune permission ouvre la page et n'y voit que ce que B.4 lui laisse.
    """
    return bool(session.get('admin_token')) or _role() in (
        'admin', 'chef_admin', 'superadmin')

def _permissions():
    """Permissions delegables de la session, comme un set de chaines.

    chef_admin et superadmin recoivent le catalogue entier : le front reflete
    ainsi la regle du backend (4.2) sans la reimplementer en conditions eparses.
    """
    role = _role()
    if role in ('chef_admin', 'superadmin'):
        return set(PERMISSIONS_CATALOGUE_FRONT)
    return set(_compte_session().get('permissions') or [])
```

`admin_headers()` (frontend.py:176-187) porte la **même liste de rôles en dur** et doit être
corrigée en même temps, sinon un `chef_admin` ouvre la page mais n'envoie aucun en-tête d'auth au
backend — symptôme déroutant (page vide sans erreur claire) pour une cause triviale.

**D'où viennent les permissions en session** : le backend les renvoie déjà au même endroit que le
rôle (`/auth/moi`, consommé en frontend.py:654). Il suffit d'ajouter la liste à cette réponse et de
la stocker dans `session['compte']` à la connexion, à côté de `role`. Pas de nouvel appel réseau.

`PERMISSIONS_CATALOGUE_FRONT` est une **copie** de la liste du §4.1 côté front. Duplication assumée
(le front ne peut pas importer `backEnd/constants.py`), à commenter des deux côtés comme devant
rester synchronisée.

### B.2 Ce que les templates reçoivent

Le context processor actuel expose `est_admin` seul (frontend.py:476-481). Il en expose trois :

```python
@app.context_processor
def inject_contexte_admin():
    return dict(
        est_admin=_est_admin(),                        # existant, inchange
        role_admin=_role(),                            # 'admin' | 'chef_admin' | 'superadmin'
        peut=lambda p: p in _permissions(),             # helper de gate, cf. B.4
    )
```

Le helper `peut()` est ce qui garde les templates lisibles : `{% if peut('gestion_saisons') %}`
plutôt qu'une comparaison de rôle recopiée à chaque bloc. **Aucun template ne doit tester un rôle
en dur pour une zone déléguable** — c'est le pendant front de R-50 (jamais par préfixe, jamais par
raccourci).

Exception assumée : les capacités de rôle (§2) se testent bien par rôle, puisqu'elles ne sont pas
des permissions — `{% if role_admin in ('chef_admin', 'superadmin') %}` pour le reset global,
`{% if role_admin == 'superadmin' %}` pour les jetons de bot (patron déjà en place,
admin_comptes.html:47).

### B.3 Les trois écrans nouveaux, dans `admin_comptes.html`

Tout se greffe sur l'onglet « Comptes » existant, qui a déjà le patron JS
`const EST_SUPERADMIN = {{ ... }}` (admin_comptes.html:62) — on l'étend plutôt que d'inventer autre
chose.

**1. Sélecteur de rôle à 4 valeurs.** `chef_admin` n'apparaît dans la liste que si
`role_admin == 'superadmin'`. Un `chef_admin` qui édite un compte ne voit que `player`/`admin`.

**2. Checklist de permissions**, visible uniquement quand la cible est `role == 'admin'` (les
autres rôles n'en ont pas l'usage : `player` n'a rien, `chef_admin`+ a tout par construction).
Cases grisées au-delà du plafond de l'acteur (§4.3) — défensif, le backend reste seul juge.
Chaque case appelle `POST`/`DELETE /admin/comptes/<id>/permissions/<permission>`.

**3. Bouton « Léguer le rôle superadmin »**, visible **uniquement** si
`role_admin == 'superadmin'`, et jamais sur sa propre ligne (auto-legs interdit, §6bis). La
confirmation forte demande de retaper le **`discord_username`** de la cible — pas le nom
d'affichage, pour la raison donnée en §6bis.2. Le libellé doit dire ce qui va se passer sans
ambiguïté : *« Vous perdrez le rôle superadmin et deviendrez chef_admin. Cette action est
irréversible sans l'accord du nouveau superadmin. »*

Le compteur de `chef_admin` de R-60 se traite au même endroit : quand la rétrogradation ferait
tomber le total à zéro, la modale ajoute une seconde confirmation explicite, et le JS envoie
`{"confirmer_dernier_chef_admin": true}`.

### B.4 Gates de navbar et de pages

`navbar.html` teste `est_admin` à deux endroits (lignes 207, 446). Ce test grossier reste correct
pour **ouvrir** le menu admin, mais chaque entrée du menu doit ensuite être gatée par sa
permission, sinon un `admin` sans droits voit un menu complet dont chaque lien mène à un 403 :

| Entrée de menu | Gate |
|---|---|
| Gestion TrueSkill | `peut('gestion_joueurs')` |
| Gestion Ligues | `peut('gestion_ligues')` |
| Gestion Saisons | `peut('gestion_saisons')` |
| Comptes | `peut('gestion_comptes') or peut('gestion_liaisons') or peut('gestion_invitations')` |
| Matchmaking (navbar.html:153) | `peut('gestion_matchmaking')` — aujourd'hui **hors** du bloc `est_admin`, à corriger |
| Config | `peut('gestion_config')` |
| Revert dernier tournoi (navbar.html:238) | `role_admin in ('chef_admin', 'superadmin')` — capacité, pas permission (§5) |

L'onglet « Comptes » est le seul composite : il regroupe trois zones déléguables séparément, donc
**chaque sous-onglet** (`Comptes` / `Demandes de liaison` / `Invitations` / `Jetons de bot`) porte
son propre gate à l'intérieur de la page, en plus du gate d'entrée.

Côté `frontend.py`, les 23 `if not _est_admin(): return 403` restent tels quels — ils protègent
l'ouverture de page, pas la donnée. **Ne pas les convertir en tests de permission** : ce serait
réimplémenter l'autorisation côté front, ce que B.0 interdit. Le proxy transmet, le backend juge.

### B.5 Le cas « droits périmés », à traiter explicitement

Conséquence directe de B.0 : un utilisateur peut voir un bouton et recevoir un 403 en cliquant.
C'est rare mais réel (retrait de permission pendant une session ouverte, §4.2bis).

Le JS admin doit donc traiter `403 permission_manquante` comme un cas **normal et explicable**, pas
comme une erreur générique : message *« Ce droit vous a été retiré. Rechargez la page. »* plutôt
qu'un « Erreur serveur » opaque. À distinguer du `403 cible_protegee` (§4.4), qui n'est pas un
droit périmé mais une règle permanente — message différent.

⚠️ Ne **jamais** purger la session sur ces 403 : R-28 (`auth-discord-plan.md`) rappelle que le
frontend purge la session sur 401/403, ce qui déconnecterait l'utilisateur pour un simple bouton
devenu indisponible. Vérifier ce point précis lors de l'implémentation — c'est le pendant front du
bug R-55 côté backend.

### B.6 Ordre de livraison conseillé

1. **B.1 + B.2** (signal enrichi) — sans ça `chef_admin` est enfermé dehors, rien d'autre n'est
   testable.
2. **B.4** (gates) — rend l'interface cohérente avec les droits réels.
3. **B.3** (écrans nouveaux) — le gros du travail visuel, dépend de B.1.
4. **B.5** (403 propres) — dernier, mais avant la mise en prod : c'est ce qui distingue « ça marche
   sur ma machine » d'une interface utilisable par quelqu'un d'autre.

---

## 8. Inventaire des fichiers *(à créer/modifier le jour de l'implémentation)*

**Nouveaux**
```
backEnd/migrations/AAAA-MM-JJ_hierarchie_admin.sql
backEnd/tests/test_permissions.py
docs/hierarchie-admin-avancement.md          (au demarrage reel du chantier, pas avant)
```

**Modifiés**
```
backEnd/schema.sql              comptes_role_valide (4 valeurs), index unique superadmin,
                                 table permissions_admin
backEnd/constants.py            ROLE_CHEF_ADMIN, ROLE_HIERARCHY (4 niveaux), PERMISSIONS_CATALOGUE
backEnd/auth.py                 + permission_required, compte_cible_protegee,
                                 permissions_delegables_par, refuse_auto_modification, _a_permission
backEnd/routes_comptes.py       changer_role reecrite, nouvelles routes permissions +
                                 leguer-superadmin (6bis), compte_cible_protegee sur /admin/comptes/<id>/*,
                                 purge des permissions a la sortie du role admin (R-53)
backEnd/routes_admin.py         conversions @admin_or_role_required -> @permission_required/@role_required,
                                 separation reset global (Phase 0)
backEnd/routes_auth.py          conversion routes invitations
backEnd/auth_discord.py         FOR UPDATE sur le COUNT de promote_bootstrap_superadmin (6bis.0)
frontEnd/frontend.py            _est_admin/_role/_permissions + admin_headers (chef_admin manquant
                                 dans les deux listes en dur, B.1), context processor (B.2),
                                 proxys des nouvelles routes
frontEnd/templates/admin_comptes.html   role chef_admin, checklist permissions, bouton legs superadmin,
                                 gates par sous-onglet (B.3, B.4)
frontEnd/templates/gestion_joueurs.html separation du bloc Reset Global (Phase 0)
frontEnd/templates/navbar.html          gates par permission sur chaque entree de menu (B.4),
                                 matchmaking a rapatrier dans le bloc admin
frontEnd/static/js/gestion.js           gate du bloc reset, appels aux nouvelles routes,
                                 403 permission_manquante sans purge de session (B.5)
backEnd/tests/test_decorators.py        cas permission_required, cible protegee, plafond
docs/runbook-admin.md                   break-glass reecrit (transaction a 2 UPDATE, ordre impose)
                                 + amorcage DISCORD_SUPERADMIN_ID en 1re option de recuperation (6bis.0)
docs/auth-discord-plan.md               bandeau de renvoi en tete de §3.3bis, rien d'autre
```

---

## 9. Questions ouvertes — toutes tranchées le 2026-09-10

Historique de l'arbitrage, gardé pour mémoire — plus aucun point bloquant pour la conception.

- **A. Legs de superadmin.** **[DÉCIDÉ]**, voir §6bis : legs vers n'importe quel rôle
  (player/admin/chef_admin), repli de l'ancien superadmin en `chef_admin`, confirmation forte par
  pseudo Discord retapé, auto-modification de rôle interdite même pour le superadmin (§2 contrainte
  4) — seule sortie possible du rôle : léguer.
- **B. Portée du garde-fou « intouchable ».** **[DÉCIDÉ]** Écriture seulement (§4.4) — pas de
  filtrage supplémentaire en lecture.
- **C. `chef_admin` intouchable par ses pairs.** **[DÉCIDÉ]** Oui, fail-closed, sans exception pour
  les actions mineures — seul le `superadmin` agit sur un `chef_admin` (§4.3bis).
- **Classement des 5 zones hors du périmètre initial** (§5). **[DÉCIDÉ]** `gestion_config`
  délégable ; `gestion_matchmaking` permission séparée (pas fusionnée) ; notifications lecture
  libre sans permission dédiée ; `purge-rgpd` non délégable `chef_admin`+ ; `fix-db-structure`
  non délégable **`superadmin` seul** (durci par rapport à la proposition initiale).
- **Angles morts découverts en relisant le code** (§5). **[DÉCIDÉ]** propositions du document
  retenues telles quelles : `/admin/types-awards` sous `gestion_saisons`, `/add-tournament` sous
  `gestion_joueurs`, `revert-last-tournament` et `delete-tournament` non délégables `chef_admin`+.
- **R-53.** **[DÉCIDÉ]** Purge automatique des permissions à la sortie du rôle `admin`.

---

## 10. Prochain pas concret

Toutes les questions du §9 sont tranchées (2026-09-10) — plus de point bloquant sur la conception.
Reste, avant de coder :

1. **Phase 0** (§6) — séparer le reset global de la gestion joueurs — indépendante de tout le
   reste, livrable dès maintenant, avant même la migration SQL.
2. **Vérification pré-migration** (§3.5) — confirmer qu'il n'existe bien qu'un seul `superadmin`
   en prod avant d'appliquer l'index unique.
3. **Mitigations R-47** (2FA Discord fort sur le compte superadmin, runbook break-glass réécrit et
   retesté) — à traiter avant de considérer le chantier terminé, pas après un incident.

**Avant d'écrire le code du §4**, intégrer les correctifs R-55, R-56 et R-57 (§7) dans la
conception elle-même — ce ne sont pas des risques à surveiller après coup, ce sont des erreurs dans
le sketch actuel de `permission_required`/`compte_cible_protegee`/`refuse_auto_modification` à
corriger avant la Phase 2.

### Relecture croisée avec le code réel (2026-09-10)

Le document a été relu intégralement et confronté au code (`auth.py`, `routes_*.py`,
`schema.sql`). Trois écarts ont été trouvés et **corrigés dans cette révision** :

1. **§6bis.1 + §6bis.2 (nouveaux)** — le legs, tel qu'il était décrit, se serait bloqué lui-même :
   la garde « dernier superadmin » déjà présente dans `changer_role` (routes_comptes.py:760-773)
   refuse la rétrogradation qui ouvre le legs. Le document expliquait l'ordre des `UPDATE` mais
   jamais la coexistence des deux gardes. Pseudo-code de référence et tableau comparatif ajoutés.
2. **§6 Phase 3a** — la réécriture de `changer_role` **abaisse** son décorateur de `SUPERADMIN` à
   `CHEF_ADMIN` et lui retire son statut de « seule route qui écrit `comptes.role` ». C'était
   implicite dans le §2 et le §5, jamais signalé comme un élargissement de privilège à assumer en
   revue. Encadré ajouté, avec la liste des garde-fous conservés.
3. **Annexe A (nouvelle)** — le §5 mappait 8 zones fonctionnelles, le code contient **38**
   décorateurs `@admin_or_role_required`. La Phase 3d exigeait une conversion « route par route »
   sans fournir la liste. Checklist exhaustive ajoutée, avec trois routes qui n'apparaissaient dans
   aucune zone (`check-token`, `avatar/compte`, `joueurs/<id>/anonymiser`) et leur classement.

Vérifiés et exacts par ailleurs : les numéros de ligne cités, l'existence de
`_charger_compte_session`/`role_required`/`_audit`/`_acteur_id`, la garantie temps réel du §4.2bis,
et le fait que la Phase 3c couvre bien 5 routes d'écriture (la 6ᵉ, `sync-preview`, est un GET et
sort donc de la portée écriture-seule décidée en §4.4).
