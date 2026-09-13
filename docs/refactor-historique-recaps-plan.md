# Refactor : historique mu/sigma fiable, recaps figés, awards traçables — plan

> **À lire en premier dans une nouvelle session.** Rien n'est commité — l'utilisateur fait ses
> commits lui-même ([[user-handles-commits]]). Document de conception, pas d'implémentation avant
> relecture de ce fichier en entier.
>
> Date de rédaction : 2026-09-11. Origine : analyse complète de la DB (même session), qui a
> confirmé trois angles morts structurels — voir §0.
>
> Décisions déjà actées par l'utilisateur (11/09) :
> 1. Historique mu/sigma : **fusion complète** de `participations.old_mu/old_sigma` et `ghost_log`
>    dans une seule table journal, pas une réparation a minima des deux tables séparées.
> 2. Figeage des recaps : **automatique**, pas un geste manuel séparé (voir §3 — le bon crochet
>    existe déjà, pas besoin d'en inventer un).
> 3. Rythme : par phases, comme [hierarchie-admin-plan.md](hierarchie-admin-plan.md) — pas pressé,
>    chaque phase livrée et testée séparément.

---

## 0. Constat — pourquoi ces trois points sont liés

Un seul fait structurant explique les trois symptômes remontés par l'utilisateur (maintenabilité,
recaps, historique mu/sigma) : **`joueurs.mu/sigma` est un état mutable unique, jamais une série
dans le temps.** Tout le reste est reconstruit *a posteriori* par-dessus cet état :

- L'« historique » mu/sigma existe déjà, mais **éclaté en deux tables** avec des rôles qui se
  recouvrent : `participations.old_mu/old_sigma` (avant un tournoi *joué*) et `ghost_log.old_sigma/
  new_sigma` (pénalité d'absence, `tournoi_id` = le tournoi qui a *déclenché* la pénalité par
  comparaison de dates, le joueur pénalisé n'y ayant pas forcément participé — cf
  `routes_admin.py:1213-1248`). Reconstituer « mu/sigma de X à la date Y » demande de fusionner
  les deux à la main et de les trier par date — c'est déjà ce que fait `compute_ip_evolution`
  (`services.py:454`), avec la complexité que ça implique.
- `revert_last_tournament` (`routes_admin.py:1266`) et `delete_tournament` (`routes_admin.py:1322`)
  **restaurent** `joueurs.mu/sigma` en relisant `old_mu/old_sigma` — commentaire du code lui-même,
  R-37 : *« mu/sigma non restaurés après suppression »*, cas déjà connu comme non fiable à 100 %.
  C'est le symptôme classique d'un état courant qu'il faut rembobiner à la main plutôt que de
  rejouer un historique append-only.
- Les recaps de saison (`/stats/recap/<slug>`) n'ont **aucune table dédiée** : ils sont recalculés
  en direct à chaque requête par `_aggregate_season_stats`, `compute_ip_evolution`,
  `_compute_advanced_stonks`, `compute_position_breakdown` (`services.py`), filtrés sur
  `date_debut`/`date_fin`. Une saison publiée peut donc, en théorie, changer de résultat si la
  formule évolue ou si `delete_tournament` touche à son historique — la migration
  `2026-06-21_repair_orphaned_league_recaps.sql` montre que ce risque s'est déjà matérialisé une
  fois.
- `awards_obtenus` est une vraie table de résultat (bien conçue, contrainte d'unicité correcte),
  mais sans `computed_at`/traçabilité de la version de calcul qui l'a produite : un recalcul
  manuel après correction de données passées changerait silencieusement des awards historiques.

**Conséquence pour la conception** : les trois chantiers ci-dessous partagent une même racine
(figer ce qui doit l'être, dès que ça peut l'être) et doivent être menés dans cet ordre — chacun
simplifie le suivant.

---

## 1. Vue d'ensemble des phases

| Phase | Titre | Dépend de | Risque |
|---|---|---|---|
| 1 | `mu_sigma_history` : table journal unique | — | Élevé (touche `add_tournament`, `revert`, `delete`) |
| 2 | Migration des lectures vers le journal | Phase 1 | Moyen (services.py, plusieurs fonctions) |
| 3 | Figeage automatique des recaps à la publication | Phase 1 (mu/sigma stable simplifie le figeage) | Moyen (routes_admin.py, routes_public.py) |
| 4 | Traçabilité des awards (`computed_at`, réémission) | Phase 3 | Faible |
| 5 | Nettoyage : dépréciation `participations.old_*`/`ghost_log` | Phases 1-4 validées en prod | Faible mais irréversible |

Chaque phase se termine par : migration SQL testée sur une copie de `dumps/`, tests
`backEnd/tests/` étendus, doc mise à jour. Rien n'enchaîne sur la phase suivante sans validation
explicite de l'utilisateur — même discipline que hierarchie-admin.

---

## 2. Phase 1 — `mu_sigma_history` : table journal unique

### 2.1 Schéma cible

```sql
CREATE TABLE public.mu_sigma_history (
    id              BIGSERIAL PRIMARY KEY,
    joueur_id       INTEGER NOT NULL REFERENCES public.joueurs(id) ON DELETE CASCADE,
    -- Le tournoi qui a PROVOQUÉ ce mouvement. Pour une pénalité fantôme,
    -- c'est le tournoi déclencheur (comparaison de dates), pas forcément
    -- un tournoi auquel joueur_id a participé -- même sémantique que
    -- l'actuel ghost_log.tournoi_id, conservée à l'identique.
    tournoi_id      INTEGER REFERENCES public.tournois(id) ON DELETE CASCADE,
    date            DATE NOT NULL,
    source          VARCHAR(20) NOT NULL,
    mu_avant        DOUBLE PRECISION NOT NULL,
    sigma_avant     DOUBLE PRECISION NOT NULL,
    mu_apres        DOUBLE PRECISION NOT NULL,
    sigma_apres     DOUBLE PRECISION NOT NULL,
    -- NULL pour tout ce qui n'est pas un tournoi joué (ghost, correction admin).
    score           INTEGER,
    position        INTEGER,
    exclude_from_ts BOOLEAN DEFAULT false,
    -- Traçabilité admin : qui a fait une correction manuelle. NULL partout
    -- ailleurs (le moteur de calcul n'est pas un compte).
    acteur_compte_id INTEGER REFERENCES public.comptes(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mu_sigma_history_source_valide
        CHECK (source IN ('tournoi', 'ghost', 'reset_global', 'admin_correction'))
);

CREATE INDEX idx_mu_sigma_history_joueur_date ON public.mu_sigma_history(joueur_id, date DESC, id DESC);
CREATE INDEX idx_mu_sigma_history_tournoi ON public.mu_sigma_history(tournoi_id);
```

Points de conception :

- **Append-only, jamais d'UPDATE/DELETE** en usage normal — seule `delete_tournament`/
  `revert_last_tournament` y touchent, et seulement pour retirer les lignes du tournoi annulé (pas
  pour les corriger à la main). C'est ce qui élimine la classe de bug R-37 : annuler un tournoi
  devient « supprimer les lignes de ce `tournoi_id`, puis relire la dernière ligne restante par
  joueur pour republier `joueurs.mu/sigma` » — un SELECT, pas un recalcul.
- `id BIGSERIAL` en plus de `(joueur_id, date)` : plusieurs mouvements peuvent tomber le même jour
  (plusieurs tournois/lobbies) — l'ordre total nécessaire au rejeu vient de `id`, pas de `date`
  seule (déjà le cas implicite aujourd'hui via l'ordre d'insertion, mais non garanti par un index).
- `source` distingue les 4 origines actuelles de mutation de `mu/sigma` repérées dans le code :
  tournoi joué (`add_tournament`), pénalité fantôme (bloc `ghost_inserts`), reset global
  (`global_resets`, table déjà existante mais qui n'écrit *rien* par joueur aujourd'hui — à
  vérifier en Phase 1.1, voir §2.3), et correction manuelle admin (`PUT /admin/joueurs/<id>`,
  `routes_admin.py:373`, qui écrase `mu/sigma` sans laisser de trace).
- Remplace bien les deux rôles actuels : `old_mu/old_sigma` de `participations` **et**
  `old_sigma/new_sigma` de `ghost_log` deviennent chacun une ligne de `mu_sigma_history` avec le
  `source` correspondant.

### 2.2 Ce qui change dans le code d'écriture

- `add_tournament` (`routes_admin.py:948-1249`) : après chaque `UPDATE Joueurs` (tournoi joué,
  bloc `joueur_updates`, et absences, bloc `absent_updates`), insérer la ligne `mu_sigma_history`
  correspondante au lieu de laisser `participations`/`ghost_log` porter seuls l'ancien état.
- `revert_last_tournament` / `delete_tournament` : au lieu de relire `old_mu/old_sigma` /
  `ghost_log.old_sigma` pour reconstituer l'état d'avant, `DELETE FROM mu_sigma_history WHERE
  tournoi_id = %s` puis relire la **dernière ligne restante par joueur concerné**
  (`SELECT DISTINCT ON (joueur_id) ... ORDER BY joueur_id, date DESC, id DESC`) pour republier
  `joueurs.mu/sigma`. Un joueur qui n'a plus aucune ligne après suppression retombe sur
  `DEFAULT_MU`/`DEFAULT_SIGMA` (cas : on supprime son unique tournoi).
- `PUT /admin/joueurs/<id>` (correction manuelle) : insérer une ligne `source = 'admin_correction'`
  avec `acteur_compte_id = g.compte['id']` avant l'UPDATE — aujourd'hui une correction manuelle de
  mu/sigma est **invisible historiquement**, c'est un trou de traçabilité distinct de R-37 mais du
  même ordre.
- Reset global (`global_resets` — à confirmer en 2.3) : si le reset touche mu/sigma par joueur,
  une ligne par joueur avec `source = 'reset_global'`.

### 2.3 Vérification préalable, avant d'écrire la migration

À faire en tout début de Phase 1, avant tout code : lire en entier la route qui écrit dans
`global_resets` (probablement dans `routes_admin.py`, à localiser — pas encore fait dans cette
session) pour savoir si elle modifie `joueurs.mu/sigma` par joueur ou seulement une valeur globale
de config. Ça conditionne si `source = 'reset_global'` a besoin d'une ligne par joueur ou d'un
traitement à part.

### 2.4 Migration — ordre des opérations

1. Créer `mu_sigma_history` (nouvelle table, aucun risque sur l'existant).
2. Script de **backfill** : reconstituer l'historique passé depuis `participations` (une ligne
   `source='tournoi'` par ligne de `participations` ayant `old_mu`/`old_sigma` non NULL,
   `mu_apres`/`sigma_apres` = `mu`/`sigma` de la même ligne) et depuis `ghost_log` (une ligne
   `source='ghost'` par ligne). Trier le résultat par date pour vérifier par sondage que l'état
   reconstitué à la fin égale bien `joueurs.mu/sigma` actuel — un écart signalerait un bug de
   modélisation avant même de toucher au code vivant.
3. **Ne pas supprimer `participations.old_mu/old_sigma`/`ghost_log` dans cette phase** — double
   écriture (ancien + nouveau) le temps de valider en prod que `mu_sigma_history` est fiable.
   La dépréciation est Phase 5, volontairement tardive et distincte.
4. Adapter `add_tournament`, `revert_last_tournament`, `delete_tournament`, `PUT /admin/joueurs`
   pour écrire dans les deux systèmes.
5. Tests : étendre `backEnd/tests/` avec un scénario qui ajoute un tournoi, vérifie la ligne créée,
   l'annule (`revert_last_tournament`), vérifie que `joueurs.mu/sigma` revient exactement à l'état
   d'avant ET que la ligne a bien disparu de `mu_sigma_history` (pas juste marquée).

---

## 3. Phase 3 — Figeage automatique des recaps

### 3.1 Le bon crochet existe déjà, pas besoin d'un job ni d'un nouveau bouton

Contrairement à l'hypothèse initiale (job planifié sur `date_fin`), le code montre que
`is_active` **n'est pas** un flag "saison en cours" — c'est le flag de **publication du recap**,
posé une seule fois, au moment où l'admin clique sur *Publier* (`routes_admin.py:881` et `:983`,
juste après `_save_awards_to_db`). C'est déjà le geste manuel qui correspond exactement à
« cette saison ne doit plus jamais changer de résultat ». Le figeage automatique demandé par
l'utilisateur s'accroche **à ce même instant**, pas à un nouveau déclencheur :

> Publier une saison = calculer les stats, distribuer les awards, **et maintenant aussi** figer
> le recap. Les trois dans la même transaction, comme les awards le sont déjà.

Pas de nouveau bouton, pas de job cron, pas de champ `saisons.gel_snapshot_at` distinct de
`is_active` — `is_active = true` devient, de fait, le marqueur de gel.

### 3.2 Schéma cible

```sql
ALTER TABLE public.saisons ADD COLUMN recap_snapshot JSONB;
```

Un seul champ `jsonb` sur `saisons`, plutôt qu'une table dédiée : le contenu du recap (résultat de
`_aggregate_season_stats` + `compute_ip_evolution` + `_compute_advanced_stonks` +
`compute_position_breakdown`, sérialisable directement) n'a pas de structure interrogeable en SQL
— personne ne fera jamais `WHERE recap_snapshot->>'x' = ...`. Une table séparée n'apporterait que
de la complexité de jointure pour un gain nul. Cohérent avec le pattern déjà choisi pour
`grille_snapshots` (figer un état de calcul), mais ici un blob suffit car il n'y a pas besoin de
requêter ligne par ligne dedans.

### 3.3 Ce qui change dans le code

- Au moment de `UPDATE saisons SET is_active = true` (les deux occurrences, `routes_admin.py:881`
  et `:983`) : calculer une dernière fois `_aggregate_season_stats` + les fonctions d'évolution,
  sérialiser le résultat, et l'écrire dans `recap_snapshot` dans la **même transaction** que
  `_save_awards_to_db` — pas de fenêtre où les awards existent sans snapshot ou l'inverse.
- `GET /stats/recap/<slug>` (`routes_public.py:71`) : si `saisons.is_active` (devenu synonyme de
  « publiée/figée ») et `recap_snapshot IS NOT NULL`, servir le snapshot tel quel. Sinon (saison en
  brouillon, jamais publiée), recalculer en direct comme aujourd'hui — utile pour une prévisualisation
  avant publication.
- Un recap déjà publié ne se recalcule donc plus jamais tout seul, y compris si la formule
  TrueSkill/IP évolue plus tard ou si `delete_tournament` retire un tournoi de la période après
  coup — ce dernier point mérite un garde-fou explicite : refuser `delete_tournament` sur un
  tournoi appartenant à la période d'une saison déjà publiée (`is_active = true`), ou au minimum
  avertir l'admin, plutôt que de laisser un recap figé devenir silencieusement incohérent avec les
  données brutes sous-jacentes.

### 3.4 Migration et rétrocompatibilité

- Colonne `recap_snapshot` nouvelle, nullable : rien ne casse pour les saisons déjà publiées avant
  la migration — elles retombent simplement sur le recalcul en direct (comportement actuel)
  jusqu'à ce qu'un script de backfill leur génère un snapshot a posteriori (à écrire en Phase 3,
  en rejouant `_aggregate_season_stats` sur chaque saison `is_active = true` existante).
- Un recap déjà figé restera figé même si une correction de bug change plus tard le calcul pour
  les saisons futures — c'est le but recherché, mais à dire explicitement à l'utilisateur au moment
  du backfill : les saisons passées, une fois migrées, ne refléteront **pas** rétroactivement une
  correction de formule ultérieure sans re-génération manuelle du snapshot.

---

## 4. Phase 4 — Traçabilité des awards

Une fois Phase 3 en place, `_save_awards_to_db` (`services.py:1037`) écrit déjà dans une table
saine. Ajouts mineurs :

```sql
ALTER TABLE public.awards_obtenus ADD COLUMN computed_at TIMESTAMPTZ NOT NULL DEFAULT now();
```

- Permet de distinguer un award posé à la publication initiale d'un award réémis après correction
  manuelle (aujourd'hui `_save_awards_to_db` fait implicitement un upsert — à vérifier son
  `ON CONFLICT` exact avant d'écrire la migration).
- Si une réémission d'awards sur une saison déjà publiée doit un jour être possible (aujourd'hui
  probablement non exposée dans l'admin — à vérifier), consigner l'événement dans `audit_admin`
  comme les autres actions sensibles, plutôt que de laisser le remplacement silencieux.

---

## 5. Phase 5 — Nettoyage (tardif, seulement après validation prod)

- Une fois `mu_sigma_history` éprouvé (au moins une saison complète vécue dessus sans écart
  constaté), envisager de retirer `participations.old_mu/old_sigma` et la table `ghost_log` au
  profit exclusif du journal. **Ne pas faire ça dans la même session que Phase 1** — le risque
  d'un schéma cassé sur une dette de plusieurs années de données réelles (dépôt public, historique
  git non réécrit — [[repo-public-donnees-reelles-historique]]) justifie une phase de rodage
  longue avant toute suppression.
- Si le nettoyage a lieu, il touche aussi les lectures de `services.py` qui font encore référence
  à `p.old_mu`/`ghost_log` (repérées en §0 : `compute_ip_evolution`, `_aggregate_season_stats`,
  `_compute_advanced_stonks`, `compute_position_evolution`, `compute_position_breakdown`) — prévoir
  un inventaire exhaustif par `grep` avant de couper quoi que ce soit, pas seulement les occurrences
  déjà listées ici qui datent de l'analyse initiale.

---

## 6. Risques transverses (dans l'esprit du registre R-xx de hierarchie-admin-plan.md)

- **R-refactor-1** : `add_tournament` est déjà une fonction longue et dense
  (`routes_admin.py:948-1249`) qui touche 4 tables dans une seule transaction. Y ajouter l'écriture
  `mu_sigma_history` sans la découper en sous-fonctions testables individuellement risque
  d'aggraver la maintenabilité au lieu de l'améliorer — prévoir une extraction de fonctions
  (calcul des mises à jour d'un côté, écriture SQL de l'autre) *avant* d'ajouter la nouvelle table,
  pas après.
- **R-refactor-2** : le double-écriture de la Phase 1 (ancien système + nouveau) est temporaire par
  design, mais toute fonction de lecture ajoutée pendant cette période doit lire **l'ancien**
  système (source de vérité jusqu'à validation), jamais le nouveau — sous peine de découvrir un
  écart de modélisation en prod plutôt qu'en backfill.
- **R-refactor-3** : le garde-fou sur `delete_tournament` (§3.3, refuser/avertir si le tournoi
  appartient à une saison déjà publiée) n'existe pas aujourd'hui et n'est pas dans le périmètre
  strict de « recap figé » — mais sans lui, le figeage de la Phase 3 devient partiellement fictif
  (le recap ne bouge plus, mais les données sources sous-jacentes, elles, le peuvent encore). À
  trancher explicitement avec l'utilisateur avant la Phase 3 : bloquer, avertir, ou accepter le
  risque tel quel (déjà le statu quo aujourd'hui).
- **R-refactor-4** : `dumps/` contient des exports réels de production dans un dépôt public
  ([[repo-public-donnees-reelles-historique]]) — tout script de backfill/vérification doit tourner
  sur une **copie locale non versionnée** de la base, jamais générer un nouveau dump commité
  pendant la phase de mise au point.

---

## 7. Ce qui n'est PAS dans ce plan

- Refonte de `services.py` en modules séparés (calcul IP / awards / matchmaking) — souhaitable pour
  la maintenabilité générale mentionnée par l'utilisateur, mais orthogonale aux trois chantiers
  demandés ; à traiter comme un chantier de simplification à part (`/simplify` ou `/code-review`
  ciblé), pas comme une migration de schéma.
- Renommage de cohérence `Joueurs`/`joueurs`, `Tournois`/`tournois` etc. dans le SQL brut — cosmétique,
  sans risque mais sans urgence, à faire en passant si un fichier est de toute façon réécrit par
  une des phases ci-dessus.
