# Journal des actions admin — conception & plan d'attaque

> Document de conception, dans l'esprit de [hierarchie-admin-plan.md](hierarchie-admin-plan.md).
> **Rien n'est codé.** Écrit après lecture de `audit_admin` en base, des 17 points d'écriture
> existants et des routes d'administration, le 2026-09-13.
>
> L'avancement sera suivi dans
> [hierarchie-admin-avancement.md](hierarchie-admin-avancement.md), ce chantier étant la suite
> directe de la hiérarchie des rôles.
>
> Conventions : **[DÉCIDÉ]** = tranché par l'utilisateur · gravité 🔴 critique · 🟠 élevé ·
> 🟡 moyen. Le registre de risques continue la numérotation à partir de **R-61**.

---

## 1. Le besoin

> « Est-il possible d'avoir un système de logs complet de ce que font les admin et chef admin ?
> Je veux que ça aille jusqu'au changement manuel du score mu/sigma d'un joueur. »

Et pour la consultation :

> « Je veux que les logs soient obtenables en allant dans `/admin/comptes`, sur le petit onglet
> comptes, pouvoir cliquer sur un logo "logs". Le superadmin pourra faire ça sur tout le monde, le
> chef admin sur tous les admin. Et évidemment rien pour les players, ils n'ont rien à logs. »

Puis, en complément :

> « Je pense qu'un onglet Logs serait à ajouter dans l'espace Gestion des comptes. On y verrait tous
> les logs enregistrés depuis le début, et disponibles au téléchargement, même si le compte n'est
> plus admin, ou même s'il n'existe plus. »

> « La suppression d'un compte ne doit pas mener à la suppression des logs en tant qu'admin. »

**Deux vues, donc** : par personne depuis sa ligne (le chemin rapide), et un journal complet
téléchargeable (le chemin exhaustif, qui survit au rôle et au compte).

---

## 2. État des lieux — ce qui existe déjà

**La table `audit_admin` existe et est bien conçue.** Aucune migration de structure n'est
nécessaire pour la tracer ; seul un index manque (§6.1).

```sql
CREATE TABLE public.audit_admin (
    id               SERIAL PRIMARY KEY,
    action           varchar(50) NOT NULL,
    acteur_compte_id integer REFERENCES public.comptes(id) ON DELETE SET NULL,
    cible_type       varchar(30),
    cible_id         integer,
    details          jsonb,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_admin_created ON public.audit_admin(created_at DESC);
```

**13 actions sont déjà tracées**, toutes sur le domaine des comptes :
`role_attribue`, `permission_accordee`, `permission_retiree`, `permissions_purgees`,
`liaison_approuvee`, `liaison_refusee`, `liaison_annulee`, `statut_change`, `sessions_revoquees`,
`profil_synchro`, `superadmin_legue`, `service_token_cree`, `service_token_revoque`,
`compte_supprime`, `joueur_anonymise`, `joueur_cree`.

`_audit()` (`routes_comptes.py`) est le helper qui écrit, et il remplit l'acteur automatiquement
depuis `g.compte`.

---

## 3. Les trois trous

### 🔴 3.1 Rien du dossier sportif n'est tracé

Vérifié route par route. Le cœur du site — celui qui produit le classement — n'a **aucune** trace :

| Action | Route | Fichier |
|---|---|---|
| **mu/sigma modifié à la main** | `PUT /admin/joueurs/<id>` | `routes_admin.py` |
| Créer une fiche joueur | `POST /admin/joueurs` | `routes_admin.py` |
| Supprimer une fiche | `DELETE /admin/joueurs/<id>` | `routes_admin.py` |
| Enregistrer un tournoi | `POST /add-tournament` | `routes_admin.py` |
| **Reset global** | `POST /api/admin/global-reset` | `routes_admin.py` |
| Annuler le reset global | `.../revert-global-reset` | `routes_admin.py` |
| Annuler le dernier tournoi | `.../revert-last-tournament` | `routes_admin.py` |
| Supprimer un tournoi | `delete_tournament` | `routes_admin.py` |
| Réglages TrueSkill / mode ligue | `POST /admin/config` | `routes_admin.py` |
| Configuration des ligues | `/admin/ligues/setup` | `routes_admin.py` |

### 🟠 3.2 Quatre écritures n'enregistrent pas *qui*

Ces quatre `INSERT` sont écrits à la main plutôt que via `_audit()`, et **omettent
`acteur_compte_id`** :

| Où | Action concernée |
|---|---|
| `routes_admin.py:516` | `liaison_annulee` |
| `routes_admin.py:585` | **`joueur_anonymise`** |
| `routes_comptes.py:1998` | `compte_supprime` |
| `services.py:1320` | (audit interne) |

Elles disent *ce qui* s'est passé, jamais *par qui* — précisément la question à laquelle ce
chantier doit répondre.

### 🟠 3.3 Le journal est illisible

**Aucune route ne lit `audit_admin`.** La table se remplit depuis des mois et personne ne peut la
consulter. Un journal qu'on ne peut pas ouvrir ne prouve rien.

---

## 4. Décisions **[DÉCIDÉ, 2026-09-13]**

| Question | Décision |
|---|---|
| **Qui consulte** | `chef_admin` et `superadmin` — **capacité de rôle**, jamais délégable |
| **Qui est consultable** | superadmin → tout le monde · chef_admin → les `admin` seulement |
| **Les players** | aucun journal, aucun bouton — ils n'ont aucune action à tracer |
| **Point d'entrée** | **deux** : un bouton « Logs » sur la ligne du compte (§4.1), **et** un onglet *Logs* dans `/admin/comptes` donnant le journal complet (§4.2) |
| **Tournois** | tracés **en résumé** (date, nombre de joueurs, acteur), pas le détail des scores |
| **Rétention** | **aucune limite** — le journal conserve tout |
| **Devenir admin** | une **proposition à accepter**, pas une attribution (§6.5). Refus → le compte reste `player` et le proposant est notifié |

**Pourquoi la consultation n'est pas délégable** : le journal révèle qui a fait quoi sur tout le
site. L'accorder à un `admin` permettrait à celui qui est surveillé de surveiller celui qui le
surveille. Même famille que `purge-rgpd`, déjà `chef_admin`+.

**Pourquoi un chef_admin ne voit pas les logs d'un autre chef_admin** : c'est la règle
d'intouchabilité entre pairs (§4.3bis du plan hiérarchie, R-52) appliquée à la lecture. Elle est
cohérente avec la règle de rang générique prévue au chantier 8.1.

### 4.1 Point d'entrée A — le bouton « Logs » d'une ligne de compte

Le chemin rapide : « qu'a fait cette personne ? », depuis la ligne où on la regarde déjà. Volet
déplié sous la ligne, filtré sur cet acteur, soumis à la règle de rang du §6.2.

Ne s'affiche **jamais** sur un compte `player` : il n'a aucune action à tracer.

### 4.2 Point d'entrée B — l'onglet *Logs* **[DÉCIDÉ, 2026-09-13]**

Un 5ᵉ onglet dans `/admin/comptes`, à côté de *Comptes*, *Invitations* et *Jetons de bot*, qui
donne **le journal entier depuis le début**, tous acteurs confondus, et **téléchargeable**.

Ce que cet onglet résout, et que le bouton par ligne ne peut pas :

- **Les lignes d'un compte rétrogradé.** Un ancien `admin` repassé `player` garde ses lignes, mais
  son bouton a disparu avec son rôle. C'était la question ouverte §8.1 — **elle est tranchée par
  cet onglet** : rien ne devient invisible.
- **Les lignes d'un compte supprimé.** Elles survivent **et restent attribuées** — voir §6.3, qui
  décrit ce que la phase 2 doit poser pour que ce soit vrai.
- **« Que s'est-il passé hier ? »** — la vue chronologique, qu'un journal par personne ne donne pas.
- **L'archivage**. Un journal consultable seulement à l'écran n'est pas exploitable ; le
  téléchargement le rend vérifiable hors ligne et conservable indépendamment de la base.

**Accès** : `chef_admin` et `superadmin`, comme le reste de ce chantier.

⚠️ **Mais le filtrage par rang du §6.2 s'applique aussi ici.** Un `chef_admin` ne doit pas voir les
lignes du `superadmin` — ni dans cet onglet, ni dans l'export. Sinon l'onglet devient le
contournement de la règle qu'on vient d'écrire : le chemin le plus visible serait aussi le moins
protégé. **Le filtre est donc appliqué dans la requête SQL**, pas à l'affichage, et l'export
réutilise exactement la même requête — deux chemins, une seule règle.

**Téléchargement** : JSON, sur le patron déjà en place pour l'export RGPD
(`frontEnd/frontend.py`, `Response` + `Content-Disposition: attachment`) — rien de neuf à inventer.
Format à figer en phase 3 ; JSON plutôt que CSV parce que `details` est un objet structuré qu'un
CSV aplatirait.

### ⚠️ Ceci RÉVISE le point B du plan hiérarchie **[DÉCIDÉ, 2026-09-13]**

Le §4.4 de [hierarchie-admin-plan.md](hierarchie-admin-plan.md) (point B du §9, décidé le
2026-09-10) dit :

> « portée écriture seule, pas de filtrage supplémentaire en lecture, y compris pour les vues
> détaillées (**historique**, sessions) — un `chef_admin` peut tout voir sur le superadmin, il ne
> peut juste rien modifier. »

**Cette phrase ne vaut plus pour le journal d'actions.** Un `chef_admin` ne doit pas pouvoir lire
les logs du `superadmin`.

*Pourquoi la décision d'origine ne tient pas ici* : elle a été prise alors qu'aucun journal
n'existait — le mot « historique » y désignait les vues d'état d'un compte (sessions, liaisons
passées), pas une trace des actions. Or les deux n'ont pas la même nature :

- **Voir l'état d'un compte** (ses sessions, sa fiche liée) ne dit rien de ce que la personne
  *fait*. Le laisser ouvert est sans conséquence.
- **Lire le journal de quelqu'un, c'est l'auditer.** Si un `chef_admin` peut auditer le
  `superadmin`, la hiérarchie s'inverse sur le seul terrain où elle doit tenir — celui du contrôle.
  C'est le même raisonnement qui rend la consultation non délégable à un `admin` (§4).

La portée **écriture seule** du décorateur `compte_cible_protegee` reste inchangée pour tout le
reste : ce n'est pas le décorateur qu'on modifie, c'est **cette route-ci** qui ajoute son propre
garde-fou de rang à la lecture (§6.2). Le point B du §9 du plan hiérarchie doit être annoté en
conséquence le jour de l'implémentation.

---

## 5. Découpage en phases

### Phase 1 — Un seul chemin d'écriture

Déplacer `_audit()` dans un module partagé (`audit.py`, ou `services.py`) et **convertir les quatre
`INSERT` manuels** du §3.2 pour qu'ils passent par lui.

*Pourquoi en premier* : tant qu'il existe deux façons d'écrire dans cette table, on continuera d'en
oublier une. Phase **purement soustractive** — aucun comportement ne change, sauf que quatre lignes
d'audit gagnent leur acteur.

**Critère de sortie** : `grep -c "INSERT INTO audit_admin"` ne renvoie plus qu'une occurrence, celle
du helper.

### Phase 1bis — La promotion devient une proposition à accepter

**Bloquante pour la phase 2**, et c'est la seule dépendance d'ordre stricte de ce plan (§6.5).

C'est la phase la plus substantielle du plan après la 2 : elle ne se réduit pas à une case à
cocher, elle transforme la promotion en un geste à deux temps.

**Base** — une proposition en attente, sur le patron de `liaisons_demandes` : qui propose, vers
quel rôle, quand, son état, plus un **index unique partiel** garantissant une seule proposition
`pending` par compte. Et les colonnes de consentement `cgu_admin_accepted_at` /
`cgu_admin_version`, sur le modèle exact de `cgu_accepted_at` / `cgu_version`.

**Backend** — proposer, accepter, refuser, annuler. `changer_role` cesse d'être le chemin de
promotion vers `admin`/`chef_admin` ; il reste celui de la **rétrogradation**, qui n'a pas à être
acceptée. L'acceptation est la seule à poser le rôle, et elle écrit son audit.

⚠️ **Reprendre les garde-fous de `liaisons_demandes`** : `SELECT … FOR UPDATE` sur la proposition
*et* sur le compte (course à l'approbation, R-07), et un 409 lisible sur chaque cas que l'index
unique transformerait en 500.

**Frontend** — l'écran d'acceptation (rôle + politique « en tant qu'administrateur ») à la
connexion suivante, le badge « promotion en attente » sur la ligne du compte, et la notification de
refus au proposant via `notifier()`.

**Politique de confidentialité** — section « en tant qu'administrateur » : ce qui est tracé,
conservé sans limite, et qui survit à la suppression du compte.

*Pourquoi avant la phase 2* : celle-ci commence à écrire des identités d'acteur conservées
indéfiniment. Les écrire avant d'avoir informé les personnes concernées, c'est créer précisément le
problème que ce consentement doit prévenir — et ce n'est pas rattrapable après coup (§6.3).

### Phase 2 — Tracer le dossier sportif

Les 10 actions du §3.1, avec l'**avant/après** dans `details`.

Vocabulaire proposé (à figer avant de coder) :

```
joueur_modifie      joueur_cree        joueur_supprime
tournoi_ajoute      tournoi_supprime   tournoi_annule
reset_global        reset_global_annule
config_modifiee     ligues_configurees
```

**Pour mu/sigma**, `details` doit porter de quoi répondre à « qui a mis ce joueur à 32.5, et quelle
était sa valeur avant » :

```json
{"avant": {"mu": 25.0, "sigma": 8.33}, "apres": {"mu": 32.5, "sigma": 4.1},
 "champs": ["mu", "sigma"], "score_modifie": true}
```

Le drapeau `score_modifie` permet de filtrer d'un coup d'œil les modifications de score parmi les
simples renommages — c'est la question posée à l'origine.

> ⚠️ **Le piège technique de cette phase.** `api_update_joueur` fait son `UPDATE` **sans jamais
> relire l'état précédent** (`routes_admin.py`, `UPDATE Joueurs SET nom=%s, mu=%s, …` directement).
> Tracer l'avant/après n'est donc pas « ajouter une ligne d'audit » : il faut un
> `SELECT … FOR UPDATE` dans la transaction avant l'écriture, et réorganiser la route autour.
> Même remarque pour `api_delete_joueur` et le reset global. **C'est le vrai coût de la phase 2**,
> pas les appels à `_audit()`.

**Tournois, en résumé** : `{"date": …, "nb_joueurs": 12}`. Le détail des scores vit déjà dans
`participations`, qui ne bouge plus une fois le tournoi enregistré — le dupliquer ferait grossir la
table sans rien apprendre.

### Phase 3 — L'écran de consultation

**Backend** — `GET /admin/comptes/<compte_id>/audit`, `@role_required(ROLE_CHEF_ADMIN)`, plus un
garde-fou de rang sur la cible (§6.2). Pagination par curseur sur `created_at`.

**Frontend** — un bouton « Logs » (icône `fa-clipboard-list`) sur la ligne du compte, à côté de
« Permissions » et « Léguer le superadmin » — dans le même bloc `actions`. Ouvre un volet déplié
sous la ligne, **sur le modèle exact de `ouvrirPermissions()`** : même patron, même endroit, aucune
nouvelle mécanique d'affichage à inventer.

Le bouton n'apparaît **que** si l'acteur a le droit de lire ce compte (§6.2) — jamais un bouton
menant à un 403 prévisible (§B.0 du plan hiérarchie).

**Puis l'onglet *Logs*** (§4.2), qui réutilise la même requête sans le filtre d'acteur :

- `GET /admin/audit` — journal complet, paginé, mêmes gardes de rang ;
- `GET /admin/audit/export` — téléchargement JSON, **exactement la même requête** que la vue, pour
  qu'aucun des deux chemins ne puisse montrer ce que l'autre masque ;
- un 5ᵉ onglet dans `admin_comptes.html`, sur le patron des quatre existants (`data-onglet`).

> Les deux routes de lecture se construisent sur une **fonction de requête unique** prenant un
> filtre d'acteur optionnel. Trois requêtes SQL séparées (volet, onglet, export) finiraient par
> diverger, et la première à oublier le garde de rang deviendrait le contournement de la règle.

### Phase 4 — Tests et documentation

Un test qui **échoue si une route d'écriture admin n'écrit pas dans l'audit**, par analyse du
source — exactement ce que `test_bascule.py` fait pour les décorateurs. C'est ce qui empêchera le
trou de se reformer à la prochaine route ajoutée.

Plus, en propre à ce chantier :

- **Les gardes de rang à la lecture**, sur les **trois** chemins : volet, onglet, export. Un
  `chef_admin` ne doit voir les lignes du `superadmin` par aucun d'eux.
- **Le bouton n'apparaît pas sur un `player`.**
- **La suppression de compte n'efface aucune ligne d'audit** — à ajouter à `test_rgpd.py`, qui
  vérifie déjà table par table ce que la suppression n'emporte pas (§6.4).
- **L'acteur reste identifiable après suppression** : une ligne écrite par un compte ensuite
  supprimé garde son pseudo et son empreinte dans `details` (§6.3).
- **Le vocabulaire d'actions** : toute chaîne passée à `_audit()` appartient à la liste fermée
  (R-64).

---

## 6. Points de conception

### 6.1 L'index manquant

Il n'existe **aucun index sur `acteur_compte_id`** — seulement sur `created_at`. Or tout cet écran
filtre sur l'acteur. Migration nécessaire :

```sql
CREATE INDEX idx_audit_admin_acteur ON public.audit_admin(acteur_compte_id, created_at DESC);
```

L'index composite sert la requête exacte de l'écran (« les actions de X, les plus récentes
d'abord ») sans balayer la table.

### 6.2 Qui peut lire le journal de qui

Règle de rang, à écrire une fois et à vérifier **côté backend** :

| Acteur | Peut lire le journal de |
|---|---|
| `superadmin` | tout le monde |
| `chef_admin` | les comptes `admin` uniquement (ni ses pairs, ni le superadmin) |
| `admin` | personne — la route lui est fermée |
| `player` | personne |

Un compte `player` n'a **aucun journal** : il ne peut effectuer aucune action tracée. Le bouton ne
s'affiche pas, et la route renvoie une liste vide plutôt qu'une erreur — un player *peut* avoir des
lignes s'il a été `admin` par le passé, et les masquer serait un mensonge ; à trancher en §8.

### 6.3 🔴 « Même si le compte n'existe plus » — le point dur

La demande de l'onglet *Logs* inclut : les lignes restent lisibles **même si le compte a été
supprimé**. Or aujourd'hui ce n'est vrai qu'à moitié.

`acteur_compte_id` est en `ON DELETE SET NULL` : à la suppression d'un compte, **toutes ses lignes
passent à `NULL` d'un coup**. Elles survivent, mais deviennent :

- **anonymes** — impossible de dire qui a agi ;
- **indistinguables** — les lignes de deux admins supprimés se mélangent, rien ne les sépare.

Un journal où « quelqu'un a modifié le score de ce joueur » ne prouve rien. La conservation
illimitée décidée au §4 perd son objet si l'identité s'efface à la première suppression de compte.

**[DÉCIDÉ, 2026-09-13]** — *« La suppression d'un compte ne doit pas mener à la suppression des logs
en tant qu'admin. »*

Les lignes d'audit **survivent à la suppression du compte, et restent attribuables**. Ce n'est donc
pas seulement la ligne qui doit survivre (elle survit déjà), mais **l'identité de l'acteur**.

Deux mécanismes à poser en **phase 2**, ensemble :

**1. Dénormaliser l'acteur à l'écriture.** `_audit()` copie, au moment de l'action, de quoi
identifier durablement qui agissait :

```json
{"acteur": {"pseudo": "Jérémy", "discord_id_hash": "a3f1…", "role": "chef_admin"}, "…": "…"}
```

Le pseudo est **figé à l'instant de l'action** — c'est un fait historique, pas une référence à
suivre. `acteur_compte_id` reste en `ON DELETE SET NULL` et sert de jointure tant que le compte
existe ; `details.acteur` prend le relais quand il disparaît.

**2. Conserver une empreinte, pas le snowflake.** `discord_id_hash` permet de **regrouper** les
actions d'un même acteur supprimé sans reconserver son identifiant Discord. Motif déjà retenu pour
`compte_supprime` et `noms_interdits` — on reste cohérent avec le reste du projet.

⚠️ **Limite à connaître : ce n'est pas rétroactif.** Les lignes déjà écrites (16 actions depuis
septembre) n'ont pas ce bloc. Si leur compte est supprimé, elles resteront anonymes — rien ne peut
le rattraper après coup. La dénormalisation ne protège que ce qui sera écrit **à partir de la
phase 2**.

⚠️ **Ceci a une conséquence RGPD directe** : le pseudo Discord d'un admin supprimé est **conservé
sans limite de durée**, alors que la suppression de compte efface tout le reste. C'est un choix
défendable — l'obligation de rendre compte (art. 5.2) justifie de conserver la trace de qui a agi
sur les données d'autrui — mais il **doit figurer dans la politique de confidentialité**, pas
seulement au registre : la personne qui accepte un rôle d'admin doit savoir que ses actions
d'administration lui resteront attribuées après la suppression de son compte.

### 6.4 La suppression de compte ne doit jamais toucher au journal

`DELETE /me` (`routes_comptes.py`) énumère explicitement ce qu'elle efface — `sessions_joueurs`,
`profils`, `liaisons_demandes`, `comptes` — plutôt que de s'en remettre aux `CASCADE`.
**`audit_admin` n'y figure pas** : le comportement demandé est donc **déjà celui du code**.

Il n'y a rien à coder, mais tout à **verrouiller** : un test doit échouer si un `DELETE FROM
audit_admin` apparaît dans la route de suppression, ou si la purge RGPD s'y met un jour. Une
garantie que personne ne vérifie finira par céder à la première refonte — c'est exactement le mode
d'échec de R-43 et R-48.

Le test existant `test_rgpd.py` vérifie déjà, table par table, ce que la suppression n'emporte pas.
**Y ajouter `audit_admin`** est l'endroit naturel, plutôt que d'ouvrir un nouveau fichier.

### 6.5 🔴 Le consentement au rôle d'admin **[DÉCIDÉ, 2026-09-13]**

> *« Quand on promeut quelqu'un au rang d'admin ou de chef admin, il doit accepter ce rôle, ainsi
> que la politique de confidentialité en tant qu'admin. »*

**C'est la conséquence directe du §6.3**, et elle est juridiquement nécessaire, pas seulement
courtoise. Le raisonnement :

1. Le §6.3 fait qu'un admin voit ses actions **conservées sans limite de durée, et nominativement,
   même après suppression de son compte**.
2. Or le RGPD impose que la personne soit **informée avant** — pas au moment où elle découvre que
   son pseudo figure encore dans un journal deux ans après son départ.
3. La politique actuelle ne le dit **nulle part**. Elle mentionne bien le journal
   (`confidentialite.html`, §4 : *« Journal des actions d'administration — conservé ; il peut
   contenir un pseudo de jeu »*), mais **du point de vue du joueur dont le pseudo apparaît**, jamais
   de celui de l'admin dont les actions sont tracées.
4. Le consentement aux CGU est donné **à la création du compte**, quand la personne est `player`.
   Il ne peut pas couvrir un traitement qui n'existera qu'au moment de sa promotion, des mois plus
   tard. **Un consentement ne vaut pas pour ce qu'on ne pouvait pas connaître en le donnant.**

**Ce qu'il faut donc :**

| Élément | Détail |
|---|---|
| **Un consentement distinct** | `comptes.cgu_admin_accepted_at` + `cgu_admin_version`, sur le modèle exact de `cgu_accepted_at`/`cgu_version` déjà en place |
| **Une section dédiée** dans la politique | ce que devient le journal, sa durée illimitée, sa survie à la suppression du compte |
| **Un écran d'acceptation** | à la première connexion suivant la promotion, avant tout accès aux pages d'administration |
| **La promotion ne l'attribue pas** | `changer_role` pose le rôle ; le consentement est demandé **ensuite**, à la personne elle-même — un tiers ne peut pas consentir à sa place |

**Pourquoi versionner comme les CGU joueur** : garder la version acceptée et pas seulement la date
est ce qui permet de démontrer **quoi** a été accepté. C'est déjà l'argument retenu pour
`cgu_version` (`routes_comptes.py`, `accepter_cgu`) — on ne réinvente rien.

#### La promotion devient une **proposition** **[DÉCIDÉ, 2026-09-13]**

> *« En cas de refus : notification de refus au chef admin ou super admin qui a voulu promouvoir
> l'user + compte qui reste en player. Tant que la proposition d'être promu est en suspens, il faut
> que ce soit affiché dans la gestion de compte. »*

Ce n'est donc **pas** « poser le rôle puis demander le consentement » : le rôle n'est posé
**qu'après** acceptation. Trois états, et un seul chemin entre eux :

```
          propose par un chef_admin/superadmin
  player ──────────────────────────────────────▶ player + proposition EN ATTENTE
                                                   │
                          accepte ────────────────►│──► admin / chef_admin   (role pose ICI)
                          refuse  ────────────────►│──► player  (inchange) + notif au proposant
```

**Ce que ça implique, et qui n'est pas anodin :**

| Point | Conséquence |
|---|---|
| **Le rôle n'est jamais posé sans accord** | `changer_role` ne peut plus être le seul écrivain de `comptes.role` pour une promotion — il faut un état intermédiaire. **C'est le vrai coût de cette décision** |
| **Une proposition est un objet** | qui l'a faite, vers quel rôle, quand, et son état — il faut le stocker (table `promotions_proposees`, ou colonnes sur `comptes`) |
| **Le refus notifie le proposant** | `notifier()` existe déjà (`routes_comptes.py`) et fait exactement ça — rien à inventer |
| **L'attente est visible** | badge « promotion en attente → admin » sur la ligne du compte, onglet *Comptes* |
| **Le refus ne rétrograde pas** | le compte **reste `player`** : il n'a jamais cessé de l'être |

**Questions que cette mécanique laisse ouvertes**, à trancher avant de coder :

1. **Une proposition expire-t-elle ?** Une promotion proposée il y a huit mois et jamais ouverte
   est-elle encore valable ? Proposition : oui, expiration à 30 jours, sur le modèle des invitations.
2. **Peut-on annuler une proposition en attente ?** Le proposant devrait pouvoir se rétracter —
   sinon la seule sortie est que la personne réponde.
3. **Que se passe-t-il si le proposant perd son rôle entre-temps ?** La proposition reste-t-elle
   valide ? Proposition : oui — elle a été faite par quelqu'un qui en avait le droit **à ce
   moment-là**, et la notification de refus part alors dans le vide (`notifier()` ignore déjà un
   `compte_id` nul).
4. **Une seule proposition à la fois par compte** — sinon deux chef_admin peuvent proposer deux
   rôles différents, et l'acceptation devient ambiguë. Index unique partiel, comme
   `idx_liaison_pending_compte` le fait déjà pour les demandes de liaison.

> 💡 **Ce mécanisme existe déjà dans le projet, sous un autre nom.** Les demandes de liaison
> (`liaisons_demandes`) sont exactement ça : un état en attente, une décision, une notification, un
> index unique partiel sur le `pending`, et un affichage dans `/admin/comptes`. **La phase 1bis doit
> s'en inspirer plutôt que d'inventer** — le patron est éprouvé, et les mêmes pièges (course à
> l'approbation, R-07) s'y appliquent.

⚠️ **Dépendance d'ordre** : ce consentement doit exister **avant** que la phase 2 ne commence à
écrire des identités d'acteur conservées indéfiniment. Sinon on trace nominativement des personnes
qui n'ont pas été informées — exactement ce que ce paragraphe cherche à éviter.

### 6.6 Ce qu'il faut porter au registre RGPD

Trois points de ce chantier y ont leur place, à inscrire dans
[rgpd-registre.md](rgpd-registre.md) avec leur justification (obligation de rendre compte,
art. 5.2 RGPD) :

1. **Rétention illimitée** du journal **[DÉCIDÉ]** — durée non bornée, donc à justifier
   explicitement, c'est précisément ce que le règlement demande.
2. **`details` fige des données personnelles** : pseudo Discord, nom de joueur, tels qu'ils étaient
   au moment de l'action. Ils survivent donc à un renommage comme à une anonymisation.
3. **La survie de l'identité de l'acteur après suppression du compte** (§6.3) : le pseudo d'un
   admin supprimé reste dans le journal, sans limite de durée.
4. **Le consentement au rôle d'admin** (§6.5) : un traitement distinct de celui du joueur, avec sa
   propre base légale et sa propre trace de consentement. À faire figurer comme **traitement à part
   entière**, pas comme une ligne du traitement « comptes ».

Et, dans la **politique de confidentialité** elle-même : une section « en tant qu'administrateur ».
Le §4 actuel mentionne déjà le journal (*« Journal des actions d'administration — conservé ; il peut
contenir un pseudo de jeu »*), mais uniquement du point de vue du **joueur dont le pseudo
apparaît** — jamais de celui de l'**admin dont les actions sont tracées**. C'est ce trou que la
phase 1bis comble.

### 6.7 Le journal affiche du contenu non maîtrisé

`details` contient des pseudos Discord et des noms de joueurs — **saisis par des utilisateurs**, et
affichés chez un chef_admin. C'est R-04.

La page devra suivre la règle déjà en vigueur dans `admin_comptes.html` : **aucun HTML construit par
concaténation**, chaque valeur par `textContent`. Un JSON brut rendu en `innerHTML` serait la
première XSS stockée du site.

---

## 7. Registre des risques

**R-61 🟠 Une route d'écriture ajoutée plus tard oubliera son audit.**
Même mode d'échec que R-43 et R-48 : la discipline ne tient pas toute seule.
*Mitigation* : le test d'inventaire de la phase 4, qui échoue sur toute route d'écriture sans appel
à `_audit()`.

**R-62 🟠 Tracer l'avant/après introduit un `SELECT` supplémentaire dans des routes chaudes.**
`api_update_joueur` et `add_tournament` sont les routes les plus utilisées de l'administration.
*Mitigation* : le `SELECT` est dans la transaction déjà ouverte, sur une clé primaire — coût
négligeable. Mais il doit être `FOR UPDATE`, sinon deux modifications concurrentes produiraient deux
lignes d'audit affirmant chacune un « avant » différent.

**R-63 🟡 Le volume : un tournoi par semaine, mais une correction de fiche peut être massive.**
Rétention illimitée **[DÉCIDÉ]**. À surveiller si la table dépasse quelques centaines de milliers de
lignes — l'index composite du §6.1 la garde lisible bien au-delà.

**R-64 🟡 `action` est un `varchar(50)` sans contrainte.**
Une faute de frappe dans un littéral crée une action fantôme qu'aucun filtre ne retrouvera.
*Mitigation* : constantes nommées dans un seul module, comme `PERMISSIONS_CATALOGUE`, et un test
qui vérifie que toute chaîne passée à `_audit()` appartient au vocabulaire.

**R-65 🔵 Le journal peut devenir une surface de fuite entre admins.**
Les lignes d'un `admin` contiennent les noms des joueurs qu'il a touchés — déjà publics. Rien de
sensible ne transite par `details` aujourd'hui, mais toute nouvelle action devra se poser la
question avant d'y écrire.

**R-66 🔴 Tracer nominativement quelqu'un qui n'a pas été informé.**
La phase 2 conserve l'identité des acteurs sans limite de durée (§6.3). Si elle est livrée avant le
consentement de la phase 1bis, on trace des personnes qui n'ont jamais su que leurs actions leur
resteraient attribuées après la suppression de leur compte — et **c'est irrattrapable** : on ne
peut pas consentir rétroactivement.
*Mitigation* : ordre imposé (§9), phase 1bis **avant** phase 2. C'est la seule dépendance stricte
de ce plan.

**R-67 🟡 Une proposition de promotion jamais ouverte bloque le compte dans l'entre-deux.**
Le rôle n'étant posé qu'à l'acceptation, une proposition ignorée laisse le compte `player`
indéfiniment, avec un badge « en attente » que personne ne lève. Le proposant peut croire la
promotion faite.
*Mitigation* : expiration de la proposition (30 j, sur le modèle des invitations) et possibilité
pour le proposant de l'annuler — les deux à trancher en §6.5. Le badge dans `/admin/comptes` rend
l'attente visible, c'est déjà ce qui évite le malentendu.

**R-68 🟠 Deux écrivains concurrents sur `comptes.role`.**
`changer_role` posait seul le rôle (R-40 : « seule route qui écrit `comptes.role` »). L'acceptation
d'une proposition devient un **second** écrivain, et R-40 ne tient plus tel quel.
*Mitigation* : partage explicite — `changer_role` garde la rétrogradation, l'acceptation détient la
promotion vers `admin`/`chef_admin`. À réécrire dans le plan hiérarchie plutôt qu'à laisser deux
documents se contredire.

⚠️ **Un test existant échouera, et c'est normal** : `test_bascule.py` (« exactement trois écritures
de `comptes.role` ») en comptera **quatre**. Ne pas le neutraliser — le mettre à jour en nommant le
quatrième écrivain et pourquoi il existe. Ce test est précisément là pour qu'un ajout d'écrivain ne
passe pas inaperçu ; il fait son travail.
---

## 8. Questions ouvertes

1. ~~**Un compte rétrogradé `player` garde-t-il ses lignes visibles ?**~~ **[TRANCHÉ, 13/09]** Oui,
   et elles restent **atteignables** : l'onglet *Logs* (§4.2) donne le journal entier, indépendamment
   du rôle actuel. Le bouton par ligne reste le chemin rapide, l'onglet le chemin exhaustif.
2. ~~**Faut-il aussi un flux global ?**~~ **[TRANCHÉ, 13/09]** Oui — c'est l'onglet *Logs* (§4.2),
   avec téléchargement.
3. **Faut-il tracer les lectures** (qui a consulté le journal de qui) ? Classique en audit, mais
   ça se mord la queue si mal borné.
4. **Le vocabulaire d'actions de la phase 2** est une proposition — à figer avant de coder, parce
   que renommer une action après coup laisse des lignes orphelines qu'aucun filtre ne retrouve.
5. **L'export doit-il être paginé ou complet ?** Un journal illimité finira par peser. Un export
   « tout depuis le début » est ce qui a été demandé, mais il faudra une borne technique (streaming,
   ou filtre de période obligatoire au-delà d'un certain volume) — à décider en phase 3, quand on
   saura combien la table pèse réellement.

---

## 9. Ordre recommandé

1. **Phase 1** — sans risque, purement soustractive, prépare tout le reste.
2. **Phase 1bis** — le consentement au rôle d'admin. **Bloquante** : la phase 2 conserve des
   identités sans limite de durée, informer après coup ne rattrape rien.
3. **Phase 2** — le gros du travail, et la réponse à la demande d'origine (mu/sigma).
4. **Phase 3** — les écrans, inutiles avant que la phase 2 ne les alimente.
5. **Phase 4** — le filet.

Chaque phase est commitable séparément. Deux migrations : les colonnes de consentement (phase 1bis)
et l'index sur l'acteur (§6.1, phase 3 — la première à en avoir besoin).

⚠️ **La phase 1bis est la seule dépendance d'ordre stricte.** Les autres phases peuvent se
réordonner selon l'urgence ; celle-là ne peut pas venir après la phase 2.
