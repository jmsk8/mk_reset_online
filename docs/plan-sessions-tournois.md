# Sessions de tournois — plan d'attaque

> **À lire en premier dans une nouvelle session.** Rien n'est commité — l'utilisateur fait ses
> commits lui-même ([[user-handles-commits]]). Document de conception, pas d'implémentation avant
> relecture de ce fichier en entier.
>
> 📋 **Le suivi de chantier est dans
> [sessions-tournois-avancement.md](sessions-tournois-avancement.md)** — état des phases, ce qui a
> été trouvé en chemin, ce qui reste. Ce fichier-ci porte la conception et les audits.
>
> ⚠️ **Audit du 15/09 : voir §13.** Six failles trouvées, **toutes tranchées le jour même** par les
> réponses de l'utilisateur. Plus aucune décision en suspens ; seul point de vigilance technique
> restant : le test F-4 (cohérence compteur/sigma sur le cycle d'annulation, §13.4), à écrire avant
> la Phase 3. Tableau d'état et ordre de travail à jour en **§13.8**.
>
> 🔄 **Deux décisions du 15/09 révisent le plan d'origine** — les lire avant toute implémentation :
> la **décision 9** (un joueur = un seul tournoi par session) et la **décision 10** (la liaison est
> demandée **avant** l'écriture en base, refus = pas de création), toutes deux détaillées en
> §13.1bis. La décision 10 **remplace la décision 2** et désamorce R-session-1 ainsi que la « limite
> assumée » du §5.2.
>
> 🔍 **Seconde passe d'audit (§14)** : les décisions 9 et 10 ont été relues et vérifiées contre le
> code. **Cinq failles d'implémentation trouvées (F-7 à F-11)**, dont **un bug dans le SQL proposé
> par le plan lui-même (F-7)** et **un trou de spécification critique (F-8 : l'ordre
> fusion/vérification)**. Ces deux-là, si ratés, font **refuser toute liaison** sans message
> d'erreur compréhensible. Les décisions restent valides — c'est le *comment* qui était fautif.
>
> Date de rédaction : 2026-09-13. **Révisé deux fois le 2026-09-13** :
> 1. Après analyse de faisabilité sur les données réelles (§10) : le modèle « chaque tournoi porte
>    toujours une session » est confirmé, et le backfill de l'historique est tranché (§10 — pas
>    d'édition de dump à la main).
> 2. Après relecture critique de cohérence : ajout de l'affichage de la landing page (§7) et de la
>    réversibilité par phase (§12) ; correction de trois défauts du plan lui-même — une fonction
>    fantôme au §3.3, une affirmation fausse au §6.1 (« aucun changement nécessaire » : un défaut
>    préexistant de `revert_last_tournament` y a été découvert), et un SQL de backfill non
>    idempotent au §11.2.
> 3. **Ajout de la Phase 0 (§2)** : la correction du défaut de `revert_last_tournament`, d'abord
>    reléguée en Phase 4, devient un préalable à livrer en premier — décision de l'utilisateur
>    (13/09). Elle est indépendante du chantier sessions et assainit la base avant qu'on touche à
>    la sémantique du calcul.
>
> Décisions déjà actées par l'utilisateur (13/09) :
> 1. Ordre des chantiers : **sessions d'abord**, la refonte historique
>    ([[refactor-historique-recaps-plan]]) est conçue *après*, par-dessus une structure de session
>    stable — pas de fusion des deux plans.
> 2. ~~Rattachement d'un tournoi à une session : geste manuel **après** validation du tournoi.~~
>    **RÉVISÉE le 15/09 par la décision 10 (§13.1bis F-1c)** : la question de la session est posée
>    **avant** l'écriture en base et avant tout calcul de score. Ce qui reste de la décision
>    d'origine : le geste est **manuel** (l'admin choisit, rien n'est déduit automatiquement), la
>    liste des tournois proposés est **libre** (pas juste « même jour »), et ne rien lier laisse le
>    tournoi seul dans sa session — comportement 100% rétrocompatible.
> 3. Modèle de données : nouvelle table `sessions` + `tournois.session_id`. **Chaque tournoi porte
>    toujours une `session_id`** (jamais NULL), y compris un tournoi jamais lié : il est alors seul
>    dans sa session. Un tournoi solitaire n'est donc pas un cas particulier mais une session à un
>    seul élément — conséquence : la liaison de Phase 2 est *toujours* une fusion de deux sessions
>    existantes, jamais une création de lien. Validé avec l'utilisateur le 13/09.
> 4. Une session est **neutre vis-à-vis de la ligue** au sens du *schéma* (la table `sessions` n'a
>    pas de colonne `ligue_id`) ; chaque tournoi garde son `ligue_id` propre, la règle d'absence
>    continue de filtrer par ligue *à l'intérieur* de la session.
>    ⚠️ **Précisée le 15/09 (§14)** : en pratique **une session ne contient jamais que des tournois
>    d'une même ligue**. Deux tournois de ligues différentes le même jour sont **deux sessions
>    distinctes** — la clé de regroupement est `(date, ligue_id)`, à la création comme au backfill.
>    Les tournois de ligue sont des tournois séparés, traités différemment seulement pour
>    l'affichage (landing page) et le comptage (membres séparés par ligue).
> 5. Règle de présence : **une session manquée = +1** sur `consecutive_missed` — jouer un seul
>    tournoi de la session suffit à compter présent pour toute la session. Un tournoi resté
>    solitaire continue de valoir +1 à lui seul, à condition de contenir un match de la
>    ligue du joueur absent quand le mode ligue est actif — c'est la règle *déjà en vigueur*
>    aujourd'hui, seulement reformulée en termes de session.
> 6. Annulation (`revert`/`delete`) d'un tournoi membre d'une session : s'il reste au moins un autre
>    tournoi dans la session, rien ne change pour le comptage de présence. Si c'était le dernier,
>    comportement identique à aujourd'hui (le tournoi disparaît, la session devient orpheline — voir
>    §6.3).
> 7. Décision du 15/09 (voir R-session-6, §8) : le nombre de tournois d'une saison, pour le
>    classement de saison et les recaps, se compte désormais **par session** (un regroupement de
>    lobbies liés ne vaut qu'une occasion de jeu) — mais reste **affiché** comme une liste de
>    tournois individuels, jamais comme des « sessions » à l'écran. Ça vaut aussi pour
>    `/stats/tournois` (§7.4) : la session n'y apparaît pas non plus, cet écran ne change pas. La
>    session est un concept de calcul (comptage, pénalité) — **seule exception : la landing page**
>    (§7), qui s'en sert pour décider d'afficher une ou plusieurs cartes de tournoi, sans jamais
>    afficher le mot « session » lui-même. Le mode ligue de la landing page continue d'afficher le
>    dernier tournoi de chaque ligue, indépendamment des sessions.
> 8. Décision du 15/09 (§5.4) : les seuils de la pénalité d'absence passent d'une mesure en **jours
>    calendaires** à un comptage en **sessions loupées consécutives** — `ghost_threshold_days` devient
>    `ghost_threshold_sessions` (à partir de combien de sessions loupées la pénalité démarre) et
>    `ghost_interval_days` devient `ghost_interval_sessions` (tous les combien de sessions loupées
>    elle se répète ensuite). `ghost_penalty` (la valeur ajoutée à `sigma`) ne change pas.
>    **Corollaire acté** : la perte de la notion de temps écoulé est **voulue** — une période sans
>    session ne pénalise personne (§13.3). Et `consecutive_missed` devient **non éditable** par un
>    admin pour être un déclencheur fiable, tout en restant **affiché** là où il l'est déjà (§13.2).
> 9. Décision du 15/09 (§13.1bis) : **un même joueur ne peut pas être enregistré dans deux tournois
>    d'une même session.** Traduction du sens physique d'une session (deux lobbies simultanés).
>    Vérifié : l'invariant est **déjà respecté sur les 658 participations de l'historique**, donc la
>    contrainte se pose sans nettoyage de données. Effet de bord heureux : elle fait coïncider
>    « nombre de participations » et « nombre de sessions jouées », ce qui résout F-1 sans changer
>    aucune valeur affichée. **Point ouvert (F-1b)** : que faire si une fusion a posteriori créerait
>    un tel doublon : **refus catégorique** (F-1b, tranché le 15/09) — ni liaison, ni création.
> 10. Décision du 15/09 (§13.1bis F-1c et F-1d) — **révise la décision 2** : la question de la
>    session est posée **avant** l'écriture en base et avant tout calcul de score. Si la liaison
>    demandée viole la décision 9, **refus et le tournoi n'est pas créé**. Découpage en deux appels
>    sans état serveur intermédiaire, la seconde étape revérifiant le conflit dans sa propre
>    transaction (fermeture du TOCTOU) et refusant par `rollback` — exigence explicite de
>    sécurisation par étapes. **Effet de bord majeur et favorable** : R-session-1 et la « limite
>    assumée » du §5.2 disparaissent du chemin nominal.

---

## 0. Constat — pourquoi le système actuel est dur à maintenir

Le bloc de pénalité d'absence dans `add_tournament`
([routes_admin.py:1281-1301](../backEnd/routes_admin.py#L1281-L1301)) doit aujourd'hui deviner
qu'un tournoi fait partie d'une même « occasion de jeu » que d'autres, **a posteriori**, par
comparaison de dates :

```python
cur.execute("""
    SELECT DISTINCT p.joueur_id
    FROM Participations p JOIN Tournois t ON p.tournoi_id = t.id
    WHERE t.date = %s AND t.id <> %s
      AND (t.ligue_id = %s OR (%s IS NULL AND t.ligue_id IS NULL))
""", (date_tournoi, tournoi_id, ligue_id, ligue_id))
present_today_ids = {r[0] for r in cur.fetchall()}
...
same_day_exists = cur.fetchone() is not None
if same_day_exists:
    counted_today = {pid for pid in absent_ids if pid not in present_today_ids}
```

Deux problèmes structurels :

- **La date sert de clé de regroupement implicite**, alors que rien ne garantit que « même jour »
  == « même occasion de jeu » (une session peut légitimement s'étaler sur deux dates si elle
  déborde après minuit, ou au contraire deux tournois du même jour peuvent être deux occasions
  sans rapport). C'est une heuristique, pas une donnée.
- **La logique de déduplication est mêlée au calcul de pénalité** dans un seul bloc dense de la
  route d'ajout : `counted_today`, `same_day_exists`, `absent_ids` filtré par ligue, tout ça dans
  la même fonction qui fait aussi tourner TrueSkill. Faire évoluer une seule de ces règles oblige à
  relire tout le bloc.

Une notion de **session explicite** remplace l'heuristique de date par une donnée réelle, choisie
par l'admin, et permet d'écrire la règle de présence comme un simple filtre sur `session_id` plutôt
qu'une reconstruction de « qui était là le même jour ».

---

## 1. Vue d'ensemble des phases

| Phase | Titre | Dépend de | Risque | Réversible ? (§12) |
|---|---|---|---|---|
| **0** | ✅ **Corriger `revert_last_tournament`** (§2) — **livré le 2026-09-14**, non commité | — | Moyen (change des valeurs en base) | Non (valeurs corrigées) |
| **1** | ✅ **Schéma : `sessions_tournois` + `tournois.session_id` + backfill** (§11, §16) — **livré le 2026-09-15**, non commité | — | Faible (ajout pur ; 96 tournois, 3 paires à regrouper) | **Oui**, totalement |
| **2** | ✅ **UX de liaison avant enregistrement + refus si joueur commun** (§17) — **livré le 2026-09-15**, non commité | Phase 1 | **Moyen** (touche `add_tournament`) | **Oui**, totalement (aucune valeur de classement altérée) |
| **3** | ✅ **Bascule de la règle de présence + seuils en sessions + comptage des awards** (§18) — **livré le 2026-09-15**, non commité | Phases 0 + 1 | **Élevé** (cœur du calcul) | **Non** : les sigma/compteurs écrits restent |
| **4** | ✅ **Sessions orphelines (§16) + correction rétroactive des pénalités (§19)** — **livré le 2026-09-15**, non commité | Phase 3 | Moyen | Partiellement |
| **5** | ✅ **Landing page — regroupement par session, branche standard** (§17) — **livré le 2026-09-15**, non commité | Phase 1 | Faible (template déjà générique) | **Oui**, totalement |

**Ordre conseillé** : la **Phase 0 d'abord** — elle est indépendante du chantier sessions et assainit
`consecutive_missed`/`is_ranked` *avant* qu'on change la sémantique du calcul. Sans elle, toute
vérification de la Phase 3 reste ambiguë : « l'écart vient-il de mon changement ou du bug ? »
(décision de l'utilisateur, 13/09 — elle était initialement reléguée en Phase 4).

Ensuite 1, 2 et 5 : elles n'altèrent aucune valeur de classement, donc se défont par un simple
revert. On gagne la structure et l'affichage simplifié sans toucher au calcul. Ne passer à la
Phase 3 qu'après, avec un dump de sauvegarde (§12.2).

Chaque phase se termine par : migration SQL testée sur une copie de `dumps/` (jamais sur les dumps
commités eux-mêmes — dépôt public, [[repo-public-donnees-reelles-historique]]), tests
`backEnd/tests/` étendus, doc mise à jour. Rien n'enchaîne sur la phase suivante sans validation
explicite de l'utilisateur — même discipline que [[hierarchie-admin-plan]] et
[[refactor-historique-recaps-plan]].

---

## 2. Phase 0 — Corriger `revert_last_tournament` (préalable indépendant)

> Ajouté le 13/09 sur décision de l'utilisateur. Ce n'est **pas** un chantier « sessions » : c'est
> un défaut préexistant, à corriger avant de changer la sémantique du calcul. Il se livre et se
> teste seul, sans rien de ce qui suit.

### 2.1 Les deux défauts

`add_tournament` écrit deux choses sur les participants
([routes_admin.py:1219](../backEnd/routes_admin.py#L1219) et
[:1224](../backEnd/routes_admin.py#L1224)) : `consecutive_missed = 0` et `is_ranked = true`. Sur les
absents, il incrémente le compteur et peut basculer `is_ranked = false` au franchissement du seuil
([:1325](../backEnd/routes_admin.py#L1325)).

`revert_last_tournament` défait ça avec une seule requête
([routes_admin.py:1393](../backEnd/routes_admin.py#L1393)) :

```python
cur.execute("UPDATE Joueurs SET consecutive_missed = GREATEST(0, consecutive_missed - 1)")
```

**Défaut 1 — pas de clause `WHERE`.** Tous les joueurs de la base sont décrémentés :

| Groupe | Avant tournoi | Après ajout | Après revert | Attendu |
|---|---|---|---|---|
| Participant qui avait 3 absences | 3 | 0 | **0** (`GREATEST` bloque) | 3 |
| Absent pénalisé | 5 | 6 | 5 ✓ | 5 |
| Joueur hors périmètre (autre ligue) | 2 | 2 | **1** ✗ | 2 |

Un joueur d'une autre ligue — exclu du calcul par le filtre `last_played_ligue`
([:1275-1278](../backEnd/routes_admin.py#L1275-L1278)) — reçoit donc une absence effacée
gratuitement, et l'erreur est **cumulative** : chaque annulation fait dériver toute la base d'un
cran.

**Défaut 2 — `is_ranked` jamais restauré.** Un joueur passé `is_ranked = false` par la pénalité y
reste après annulation, alors que son compteur est repassé sous le seuil : il disparaît du
classement sans raison.

`delete_tournament` fait ce travail **correctement** sur les deux points
([routes_admin.py:1435-1451](../backEnd/routes_admin.py#L1435-L1451)) — filtre `missed > 0`, exclut
les participants, recalcule `is_ranked`. C'est la référence à copier ; les deux routes ont
manifestement divergé.

### 2.2 Ce que le correctif peut — et ne peut pas — faire

**Limite dure à connaître avant d'écrire le code** : `add_tournament` écrase `consecutive_missed` à
0 pour les participants **sans sauvegarder la valeur précédente** nulle part (`participations`
stocke `old_mu`/`old_sigma`, jamais `old_missed`). La valeur d'avant est donc **définitivement
perdue** — aucun correctif de `revert_last_tournament` ne peut la restaurer.

Conséquence : le correctif doit viser la **cohérence**, pas la restauration parfaite.

- Ce qui est réparable : ne plus décrémenter les joueurs hors périmètre, ne plus toucher aux
  participants, recalculer `is_ranked`.
- Ce qui ne l'est pas : rendre à un participant son compteur d'avant le tournoi. Il reste à 0.
  C'est acceptable (0 = « il vient de jouer », ce qui est cohérent avec le fait qu'on annule un
  tournoi qu'il a joué) mais **à documenter dans le code**, sinon quelqu'un « corrigera » ça plus
  tard en croyant à un oubli.
- Si la restauration exacte devient un besoin, elle passe par `mu_sigma_history`
  ([[refactor-historique-recaps-plan]]) étendu à `consecutive_missed` — hors périmètre ici.

### 2.3 Forme du correctif

Remplacer la ligne 1393 par une requête calquée sur `delete_tournament` : seuls les joueurs
**non-participants** et **réellement pénalisés** sont décrémentés, avec recalcul de `is_ranked`.

```python
# Le seuil, comme delete_tournament le lit deja (routes_admin.py:1418-1420).
cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
res = cur.fetchone()
threshold = int(res[0]) if res else DEFAULT_UNRANKED_THRESHOLD

# Les participants sont hors jeu : leur compteur a ete remis a 0 par l'ajout,
# et la valeur d'avant n'est stockee nulle part (cf 2.2).
participant_ids = [jid for jid, _, _ in participants]
q = ("SELECT id, consecutive_missed, is_ranked FROM Joueurs"
     + (" WHERE id NOT IN %s" if participant_ids else ""))
cur.execute(q, (tuple(participant_ids),) if participant_ids else ())

batch = []
for pid, missed, is_r in cur.fetchall():
    if missed and missed > 0:
        new_m = missed - 1
        new_r = True if (not is_r and new_m < threshold) else is_r
        batch.append((pid, new_m, new_r))
if batch:
    psycopg2.extras.execute_values(cur, """
        UPDATE Joueurs AS j SET consecutive_missed = data.missed, is_ranked = data.ranked
        FROM (VALUES %s) AS data(id, missed, ranked)
        WHERE j.id = data.id
    """, batch)
```

Note sur le `missed > 0` : il ne distingue pas un absent *de ce tournoi* d'un joueur qui cumulait
déjà des absences sans être concerné (mode ligue). C'est la même approximation que
`delete_tournament` fait aujourd'hui — l'accepter ici pour **aligner les deux routes** plutôt que
d'inventer une troisième règle. La correction fine (ne décrémenter que ceux qui ont une ligne
`ghost_log` ou étaient dans le périmètre de ligue) relève de la Phase 3, où le périmètre d'une
session devient une donnée explicite.

### 2.4 Occasion à saisir : extraire la fonction partagée

Les deux routes feront alors le même geste. **Extraire une fonction unique** plutôt que de
dupliquer une troisième fois :

```python
def annuler_absences(cur, joueur_ids, threshold):
    """Decremente consecutive_missed et recalcule is_ranked pour ces joueurs.

    joueur_ids = None -> tous les joueurs ayant missed > 0 (annulation d'un
    tournoi). Une liste -> seulement ceux-la (fusion de sessions, §6.2).
    """
```

C'est exactement la fonction dont `fusionner_sessions` aura besoin en Phase 3 avec une **liste**
de joueurs (§6.2) — d'où l'intérêt de la créer maintenant, sur un cas simple et testable, plutôt
qu'au milieu du chantier sessions. Elle satisfait aussi R-session-2 (retirer de la complexité de ces
routes plutôt qu'en ajouter).

### 2.5 Validation

- **Test harness** (`backEnd/tests/`) : la séquence est vérifiable sans Postgres — que la requête de
  décrément porte bien une clause d'exclusion des participants, et que `is_ranked` soit recalculé.
  C'est le premier test de cette zone du code, aujourd'hui non couverte (§10.5).
- **Vérification manuelle** sur base locale : noter `consecutive_missed`/`is_ranked` de 3 joueurs
  (un participant, un absent pénalisé, un joueur d'une autre ligue), ajouter un tournoi, annuler,
  comparer. Le joueur hors périmètre doit être **inchangé** — c'est le défaut 1 qui se voit là.
- **Avant/après en prod** : ce correctif ne répare pas les dérives déjà accumulées. Si l'utilisateur
  veut savoir ce que le bug a coûté, un `SELECT id, nom, consecutive_missed, is_ranked FROM Joueurs
  ORDER BY consecutive_missed DESC` avant/après quelques annulations est le seul constat possible —
  l'historique exact n'est pas reconstituable (§2.2).

### 2.6 ✅ Livré le 2026-09-14

Conforme au plan ci-dessus, sans écart de conception. **Non commité** — l'utilisateur commit
lui-même ([[user-handles-commits]]).

| Fichier | Changement |
|---|---|
| `services.py` | **`annuler_absences(cur, participant_ids, threshold)`** créée à côté de `drop_grille_snapshot_if_orphan` (même rôle, même emplacement) |
| `routes_admin.py` | `revert_last_tournament` : l'`UPDATE` global remplacé par la lecture du seuil + l'appel à la fonction |
| `routes_admin.py` | `delete_tournament` : ses 17 lignes de boucle remplacées par le même appel — **pur refactor, comportement identique** |
| `tests/test_annulation_tournoi.py` | nouveau, 33 assertions |

**Ce que le correctif change en pratique** : un joueur hors périmètre de ligue n'est plus décrémenté
à tort (fin de la dérive cumulative), et `is_ranked` est restauré pour qui repasse sous le seuil.

**Validé par mutation** : en réintroduisant l'`UPDATE Joueurs SET consecutive_missed = GREATEST(...)`
d'origine, **17 des 33 assertions tombent**. Le test mord donc réellement sur ce défaut précis.

Deux garde-fous statiques ont été ajoutés au test, contre la reproduction du défaut : il échoue si
un `UPDATE` global de `consecutive_missed` réapparaît dans `routes_admin.py`, et si la boucle de
décrément y est de nouveau dupliquée au lieu de passer par la fonction partagée — c'est exactement
la divergence entre les deux routes qui avait produit le bug.

⚠️ **La limite du §2.2 est documentée en commentaire dans `annuler_absences`** : les participants
restent à 0 car `old_missed` n'existe nulle part. Ne pas « corriger » ça en croyant à un oubli —
les décrémenter les ferait passer **sous** leur valeur réelle.

**Reste à faire avant de considérer la phase close** : la vérification sur base Postgres locale
(§2.5) — le banc d'essai ne valide pas le SQL. Noter `consecutive_missed`/`is_ranked` de trois
joueurs (un participant, un absent pénalisé, un joueur d'une autre ligue), ajouter un tournoi,
annuler, comparer : **le joueur hors périmètre doit être inchangé**.

`annuler_absences` est la fonction que `fusionner_sessions` appellera avec une **liste** de joueurs
en Phase 3 (§5.2) — elle est désormais écrite et éprouvée sur le cas simple, comme prévu au §2.4.

⚠️ **Hors périmètre de cette phase, trouvé en la testant** : annuler un tournoi **laisse sa
notification en place** (R-session-7, §8). La Phase 0 corrige les compteurs d'absence, pas les
notifications — le joueur garde un message annonçant un tournoi qui n'existe plus.

---

## 3. Phase 1 — Schéma

### 3.1 Table `sessions`

```sql
CREATE TABLE public.sessions (
    id          SERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Volontairement minimale : une session n'est qu'un identifiant de regroupement, pas une entité avec
sa propre date/ligue (elle est neutre vis-à-vis de la ligue par décision, et sa « date » n'a pas de
sens propre — chaque tournoi garde la sienne). Pas de colonne `ferme_le`/`is_closed` : rien dans les
décisions actées n'introduit de clôture explicite, une session se construit au fil des liaisons et
n'a pas besoin d'un état fermé/ouvert.

### 3.2 Colonne sur `tournois`

```sql
-- Etape 1 : colonne nullable, le temps du backfill (§10).
ALTER TABLE public.tournois ADD COLUMN session_id INTEGER REFERENCES public.sessions(id) ON DELETE SET NULL;
CREATE INDEX idx_tournois_session ON public.tournois (session_id);

-- Etape 2 : APRES le backfill, qui garantit qu'aucune ligne n'est restee NULL.
ALTER TABLE public.tournois ALTER COLUMN session_id SET NOT NULL;
```

**`session_id` est `NOT NULL` dans l'état final** (décision 3 de l'en-tête) : chaque tournoi porte
toujours une session, seul dedans s'il n'est jamais lié. Conséquence directe : il n'y a **pas** de
branche « tournoi sans session » à écrire dans le code de calcul — un seul chemin, toujours par
`session_id`. C'est ce qui fait disparaître le patch `counted_today`/`same_day_exists` plutôt que de
le déplacer.

La colonne est créée nullable puis passée `NOT NULL` en deux temps, parce que le backfill (§10) doit
pouvoir remplir les 92 lignes existantes entre les deux — un `NOT NULL` immédiat sans `DEFAULT`
échouerait sur une table non vide.

`ON DELETE SET NULL` sur la contrainte reste le bon choix malgré le `NOT NULL` : il ne s'appliquera
jamais en usage normal (on ne supprime pas une session qui a des tournois, cf. §6.3) mais il évite
qu'une suppression accidentelle de session entraîne des tournois en cascade. Si la contrainte
`NOT NULL` fait échouer une telle suppression, c'est le comportement souhaité : mieux vaut un échec
bruyant qu'un tournoi effacé.

### 3.3 Fonction utilitaire de fusion

Une seule fonction serveur, appelée par la route de liaison (Phase 2). Puisque tout tournoi porte
toujours une `session_id` (décision 3), il n'y a **jamais de session à créer ici** : le seul cas est
la fusion de deux sessions existantes.

```python
def fusionner_sessions(cur, tournoi_id_a, tournoi_id_b):
    """Fusionne les sessions de deux tournois en une seule.

    Garde la session d'id le plus petit et y reaffecte tous les tournois de
    l'autre, puis supprime la session vidée. Convention stable : le resultat ne
    depend pas de l'ordre des arguments.

    Idempotent : si les deux tournois sont deja dans la meme session, ne fait
    rien -- l'admin peut cliquer deux fois sans consequence.

    ATTENTION : ne fait PAS que deplacer des session_id. Elle doit aussi
    corriger les penalites deja ecrites (§5.2) et invalider le cache (§7.4).
    Voir §5.2 pour la sequence complete, qui est le vrai contenu de cette
    fonction.
    """
```

La convention « on garde l'`id` le plus petit » évite un comportement dépendant de l'ordre des
arguments, et fait qu'une session garde son identité au fil des fusions successives (utile pour la
lisibilité d'un `ghost_log`/journal futur qui référencerait une `session_id`).

Ce cas de fusion couvre naturellement le scénario « relier deux groupes déjà formés séparément » :
comme la liaison est une « liste libre parmi les tournois récents » (décision actée), rien
n'empêche l'admin de lier A↔B un jour puis B↔C un autre jour sans avoir pensé à lier A↔C — la
fusion transitive se fait alors toute seule, sans cas particulier à écrire.

---

## 4. Phase 2 — UX de liaison

> ⚠️ **Section révisée le 15/09 par la décision 10.** La version d'origine accrochait la liaison à
> la *réponse* d'un tournoi déjà créé. Le flux est désormais inversé : **la question est posée avant
> toute écriture en base**. Le détail de la sécurisation (découpage en deux appels, TOCTOU, refus par
> rollback) est au **§13.1bis F-1d** — à lire avant d'implémenter cette phase.

### 4.1 Où s'accroche le geste

La saisie du tournoi reste inchangée. Après que l'admin valide le formulaire, **et avant que quoi que
ce soit ne soit écrit**, une modale demande « Ce tournoi fait-il partie de la même session qu'un
autre tournoi ? » avec une liste de tournois candidats (les N derniers, toutes ligues confondues
puisqu'une session est neutre vis-à-vis de la ligue) et un bouton « Passer ».

Les candidats qui **partagent un joueur** avec le tournoi en cours de saisie sont **grisés et non
sélectionnables** (décision 9) — le conflit n'est même pas proposable. Le refus serveur (F-1b) reste
le garde-fou qui compte : l'UI ne fait que rendre l'erreur improbable, elle ne la prévient pas.

### 4.2 Routes

**Deux appels, aucun état serveur entre les deux** (justification complète en §13.1bis F-1d) :

```
Etape 1 — POST /admin/tournois/verifier-session     (lecture seule)
  Body   : { date, ligue_id, joueurs: [...] }
  Sortie : { candidats: [ {id, date, ligue, nb_joueurs, liable, joueurs_en_conflit} ] }

Etape 2 — POST /add-tournament                      (l'existante, + un champ)
  Body   : { ...payload actuel..., autre_tournoi_id: <int|null> }
```

Les deux sont protégées par `gestion_tournois`, comme l'ajout aujourd'hui. L'étape 2 **refait
elle-même** la vérification de conflit dans sa transaction et refuse par `rollback` + `409` si
besoin : elle ne fait jamais confiance au résultat de l'étape 1.

Pas de route `lier-session` dédiée dans le chemin nominal — le rattachement est un champ du payload
de création. Une route de liaison **tardive** (deux tournois déjà enregistrés) reste néanmoins
nécessaire, appelant `fusionner_sessions` :

```
POST /admin/tournois/<int:tournoi_id>/lier-session
Body: { "autre_tournoi_id": <int> }
```

Elle porte le même refus F-1b, et c'est elle qui a besoin de la correction rétroactive des pénalités
(§5.2).

Pas de route de **dé**-liaison dans cette phase — pas demandée, et une fois la règle de présence en
Phase 3 en dépend, délier doit rester un geste rare et réfléchi (à réévaluer seulement si le besoin
apparaît en usage réel).

### 4.3 Liste des tournois proposés

`GET /admin/tournois/recents` (ou réutiliser `/stats/tournois` existant côté frontend, qui a déjà
tout : date, ligue, nb joueurs, vainqueur) suffit à peupler la modale — pas besoin d'un nouvel
endpoint dédié si `/stats/tournois` couvre déjà le besoin d'affichage. Limiter à une fenêtre
raisonnable (ex. les 20 derniers) pour ne pas proposer tout l'historique.

---

## 5. Phase 3 — Bascule de la règle de présence

### 5.1 Ce qui change dans `add_tournament`

Le bloc actuel ([routes_admin.py:1236-1338](../backEnd/routes_admin.py#L1236-L1338)) calcule
`counted_today`/`same_day_exists` par comparaison de dates. Il devient : créer la session du
tournoi en même temps que le tournoi, puis chercher les présences **par `session_id`** :

```python
# A l'INSERT du tournoi (§3.2) : une session neuve, ce tournoi seul dedans.
cur.execute("INSERT INTO sessions DEFAULT VALUES RETURNING id")
session_id = cur.fetchone()[0]
# ... INSERT INTO Tournois (..., session_id) ...

# Presences de la session : a l'ajout, la session ne contient que ce tournoi,
# donc cette requete ne renvoie rien -- et c'est correct (cf 4.2).
cur.execute("""
    SELECT DISTINCT p.joueur_id
    FROM Participations p JOIN Tournois t ON p.tournoi_id = t.id
    WHERE t.session_id = %s AND t.id <> %s
      AND (t.ligue_id = %s OR (%s IS NULL AND t.ligue_id IS NULL))
""", (session_id, tournoi_id, ligue_id, ligue_id))
deja_presents = {r[0] for r in cur.fetchall()}
```

Les deux requêtes `present_today_ids`/`same_day_exists` du code actuel fusionnent en cette seule
requête, et la variable `same_day_exists` disparaît : un ensemble `deja_presents` vide produit
exactement le même résultat que `same_day_exists = False` aujourd'hui (`counted_today` vide → tous
les absents comptés). La branche conditionnelle n'a plus de raison d'être.

### 5.2 Le timing de la liaison a posteriori — tranché, puis **largement résolu par la décision 10**

> ⚠️ **Révision du 15/09.** Cette section décrit le problème du modèle « liaison *après* création ».
> La décision 10 (§13.1bis F-1c) inverse le flux : la session est désormais connue **avant** le
> calcul, donc **le scénario décrit ci-dessous ne se produit plus sur le chemin nominal** —
> `deja_presents` est correct du premier coup, et il n'y a aucune pénalité à annuler
> rétroactivement.
>
> **Ce qui reste valable** : tout ce qui suit s'applique encore au chemin **tardif** — l'admin a
> cliqué « Passer », puis décide plus tard de lier deux tournois déjà enregistrés. Ce cas garde
> besoin de la correction rétroactive décrite ici. La décision 10 en fait un cas secondaire, elle ne
> le supprime pas.

Au moment de l'ajout, la session du tournoi ne contient que lui : `deja_presents` est donc toujours
vide, et la pénalité est calculée sur ce tournoi seul — **comportement identique à aujourd'hui pour
le 1er tournoi d'une soirée, mais différent pour le 2e** : le patch actuel déduplique dès l'ajout
du 2e tournoi (il voit le 1er par comparaison de dates), alors que le nouveau modèle ne peut pas
le faire puisque la liaison n'existe pas encore.

C'est la conséquence directe de la décision « liaison manuelle a posteriori », et ça impose que
**la fusion corrige les pénalités déjà écrites**. Scénario complet :

1. Tournoi A (lobby 1) ajouté → session S_A. Les joueurs du lobby 2 ne sont pas encore saisis :
   ils sont donc comptés absents, `consecutive_missed +1`, éventuellement une ligne `ghost_log`.
2. Tournoi B (lobby 2) ajouté → session S_B. Les joueurs du lobby 1 sont comptés absents à leur
   tour, même traitement.
3. L'admin lie A et B → `fusionner_sessions` : il faut **annuler** les pénalités de l'étape 1 pour
   les joueurs présents dans B, et celles de l'étape 2 pour les joueurs présents dans A.

**Ce que fait `fusionner_sessions`**, après avoir réaffecté les `session_id` :

- Calculer l'ensemble des joueurs ayant participé à *au moins un* tournoi de la session fusionnée,
  par ligue (la règle reste filtrée par ligue à l'intérieur de la session, décision 4).
- Pour chaque tournoi de la session, retirer de ses pénalités celles qui visent un joueur de cet
  ensemble : restaurer `joueurs.sigma` depuis `ghost_log.old_sigma`, décrémenter
  `consecutive_missed`, recalculer `is_ranked` par rapport à `unranked_threshold`, supprimer la
  ligne `ghost_log`.
- Réutiliser pour ça la mécanique de restauration que `revert_last_tournament` applique déjà
  ([routes_admin.py:1384-1394](../backEnd/routes_admin.py#L1384-L1394)) — mêmes requêtes, mais sur
  un sous-ensemble de joueurs au lieu de tout le tournoi. À extraire en fonction partagée plutôt
  qu'à dupliquer (cf. R-session-2).
- Terminer par `recalculate_tiers()` + `invalidate_cache()`, comme toute route qui touche aux
  sigma.

**Limite assumée de ce modèle** (à connaître, pas à corriger) : entre l'ajout du tournoi A et la
liaison, la base contient des pénalités qui seront annulées ensuite. Si l'admin oublie de lier, ces
pénalités restent — c'est le prix de la liaison manuelle, et c'est un choix explicite de
l'utilisateur (décision 2) face à l'alternative « session ouverte/fermée explicitement » qui
n'avait pas ce trou mais imposait un geste avant chaque saisie. Ce point est le seul endroit où le
nouveau modèle est *moins* automatique que le patch actuel ; tout le reste est plus simple. Une
atténuation possible, si l'oubli se produit en usage réel : afficher dans la modale de liaison un
avertissement quand un tournoi du même jour existe déjà et n'est pas dans la même session.

### 5.3 ~~Un cas qui devient correct et ne l'est pas aujourd'hui~~ — **section caduque**

> ⛔ **Amendée le 15/09 : ce n'est PAS un objectif du chantier.** L'utilisateur a clarifié que **les
> tournois de ligue ne partagent jamais une session** — ce sont des tournois séparés, gérés
> différemment seulement pour l'affichage (landing page) et pour le comptage (séparation des membres
> par ligue). Voir **§14** pour la clarification complète et ses vérifications.
>
> Conséquence : la « déduplication d'une soirée multi-ligues » décrite ci-dessous **n'aura pas lieu**,
> ni rétroactivement (le backfill sépare 54 et 58, §11.3) ni pour l'avenir (la règle de création
> suit la même clé `(date, ligue_id)`). Le texte est conservé pour mémoire du raisonnement, mais
> **ne pas l'implémenter**.

Le patch actuel ne déduplique que si les deux tournois partagent **la même `ligue_id`**
([routes_admin.py:1288](../backEnd/routes_admin.py#L1288) : `t.ligue_id = %s OR (%s IS NULL AND
t.ligue_id IS NULL)`). Une soirée à deux lobbies de ligues différentes — cas réellement présent
dans les données, tournois 54 (Ligue 0) et 58 (Ligue 1) du 2026-03-02, cf §10.2 — n'est donc pas
dédupliquée aujourd'hui. Avec une session neutre vis-à-vis de la ligue (décision 4), elle le
devient **dès que l'admin lie les deux tournois**. C'est un gain fonctionnel, pas seulement une
simplification de code.

Attention à ne pas confondre deux temps différents (sinon §10.3 semble contredire ce paragraphe) :

- **Pour l'avenir** : la capacité de dédupliquer une soirée multi-ligues existe, via la liaison
  manuelle. C'est le gain décrit ici.
- **Pour le passé** : le backfill ne fusionne **pas** rétroactivement 54 et 58 (§10.3) — il
  reproduit l'ancien comportement à l'identique. Corriger l'historique serait un geste séparé, à
  faire à la main via l'UI si l'utilisateur le souhaite.

Autrement dit : nouvelle capacité, historique préservé.

### 5.4 Configuration des seuils de pénalité — passage de jours à sessions loupées

**Révisé le 15/09, sur décision de l'utilisateur : ce paragraphe remplace l'ancienne version, qui
disait ces réglages inchangés.** Une fois la notion de session en place, les deux réglages temporels
qui gouvernent aujourd'hui le déclenchement de la pénalité passent d'une mesure en **jours
calendaires** à un comptage en **sessions loupées consécutives** :

| Réglage actuel | Sémantique actuelle | Nouveau réglage | Nouvelle sémantique |
|---|---|---|---|
| `ghost_threshold_days` | Nombre de jours depuis la dernière apparition avant que la 1ère pénalité se déclenche | `ghost_threshold_sessions` | Nombre de **sessions loupées** avant que la 1ère pénalité se déclenche |
| `ghost_interval_days` | Nombre de jours entre deux pénalités **répétées** une fois le seuil initial franchi | `ghost_interval_sessions` | Nombre de **sessions loupées** entre deux pénalités répétées |
| `ghost_penalty` | Valeur ajoutée à `sigma` à chaque déclenchement | *(inchangé)* | *(inchangé)* — cette valeur ne mesure pas un délai, rien ne la lie au calendrier |
| `GHOST_SIGMA_CAP`, `unranked_threshold` | | *(inchangés)* | idem |

**Ce que ça change dans le code** ([routes_admin.py:1656-1679](../backEnd/routes_admin.py#L1656-L1679)) :
aujourd'hui, `ref` (la date de dernière apparition ou dernière pénalité, la plus récente des deux) et
`(date_tournoi - ref).days` mesurent un écart calendaire. Ce mécanisme est remplacé par un compteur
déjà présent et fiable : **`consecutive_missed`**, qui compte déjà les sessions loupées d'affilée une
fois la Phase 3 en place (§5.1) — plus besoin de recalculer `ref`/`last_played`/`last_ghost` par une
requête de date. La condition de déclenchement devient de la forme :

```python
# new_missed = consecutive_missed apres incrementation pour ce tour (§5.1).
if ghost_enabled and not already_today and new_sig < GHOST_SIGMA_CAP:
    if new_missed == ghost_threshold_sessions or (
        new_missed > ghost_threshold_sessions
        and (new_missed - ghost_threshold_sessions) % ghost_interval_sessions == 0
    ):
        capped_sig = min(new_sig + penalty_val, GHOST_SIGMA_CAP)
        ...
```

C'est un **gain de simplicité supplémentaire**, dans le même esprit que le reste du plan (§0) : les
requêtes `last_played`/`last_ghost`/`ref` ([routes_admin.py:1605-1626](../backEnd/routes_admin.py#L1605-L1626))
disparaissent, remplacées par une comparaison entière sur une valeur déjà en main. `ghost_log` garde
son rôle de journal (traçabilité, restauration par `annuler_absences`/`fusionner_sessions`), mais
n'est plus consulté pour *décider* du déclenchement.

**Ce qui ne change pas de sémantique** : `ghost_enabled` (interrupteur), le filtrage par ligue en
mode ligue actif, le plafond `GHOST_SIGMA_CAP`, `unranked_threshold`. Seule l'unité de mesure du
délai change, de jours à sessions.

**Migration de `Configuration`** : contrairement à ce que disait la version précédente de ce
paragraphe, une migration **est** nécessaire — renommer/remplacer `ghost_threshold_days` et
`ghost_interval_days` par `ghost_threshold_sessions`/`ghost_interval_sessions`, avec une valeur par
défaut à choisir avec l'utilisateur (pas de conversion automatique fiable : un seuil en jours et un
seuil en sessions ne se déduisent pas l'un de l'autre sans hypothèse sur la fréquence de jeu). Écran
d'admin de configuration à mettre à jour en conséquence (mêmes routes que §3.1 des lignes
[routes_admin.py:263](../backEnd/routes_admin.py#L263) et
[:324](../backEnd/routes_admin.py#L324) citées en §10.3 — labels et validation à adapter, plus de
`max(1, int(...))` sur des jours mais sur un nombre de sessions).

**Ordre de dépendance** : ce changement ne peut pas précéder la bascule de la règle de présence sur
`session_id` (§5.1) — il en est la suite logique, pas un prérequis. Il peut en revanche être livré
dans la **même** Phase 3 ou en sous-phase juste après, à trancher au moment de l'implémentation :
`consecutive_missed` doit déjà compter des sessions (et non plus des tournois/dates) pour que ce
nouveau réglage ait un sens.

---

## 6. Phase 4 — Annulation et sessions orphelines

### 6.1 `revert_last_tournament` / `delete_tournament`

Décision actée : si la session a encore au moins un autre tournoi après le retrait, rien ne change
pour le comptage de présence — la session reste « jouée » du point de vue des absents des autres
jours. Les deux routes suppriment déjà uniquement les lignes de leur propre tournoi
(`Participations`, `ghost_log WHERE tournoi_id = %s`), jamais celles des autres tournois de la
session : sur ce point précis, rien à changer.

**Prérequis** : le défaut de `revert_last_tournament` (décrément sans `WHERE`, `is_ranked` non
restauré) est traité en **Phase 0 (§2)**, avant tout le reste — il n'est donc plus à corriger ici.
Cette phase suppose la Phase 0 livrée, et en particulier la fonction partagée `annuler_absences`
(§2.4) déjà extraite : c'est elle que `fusionner_sessions` appelle avec une liste de joueurs (§5.2).

Si la Phase 0 n'a finalement pas été faite, **ne pas enchaîner sur celle-ci** : le `UPDATE` global
serait recopié dans `fusionner_sessions` et corromprait le compteur de toute la base à chaque
liaison — sur un geste fréquent, cette fois, et non plus sur une annulation rare.

### 6.2 Cas du dernier tournoi d'une session

Si le tournoi supprimé était le seul restant de sa session : `ON DELETE SET NULL` sur
`tournois.session_id` ne s'applique pas ici (c'est le tournoi lui-même qui est supprimé, pas la
session) — la session devient une ligne orpheline dans `sessions` sans plus aucun tournoi qui
pointe vers elle. Comportement identique à aujourd'hui pour le joueur (le tournoi solitaire restant
disparaît, comme actuellement), seule différence : une ligne `sessions` vide traîne en base.

Prévoir un nettoyage, symétrique à `drop_grille_snapshot_if_orphan` déjà présent dans le code
([routes_admin.py:1397](../backEnd/routes_admin.py#L1397) et
[:1455](../backEnd/routes_admin.py#L1455)) :

```python
def drop_session_if_orphan(cur, session_id):
    if session_id is None:
        return
    cur.execute("SELECT 1 FROM Tournois WHERE session_id = %s LIMIT 1", (session_id,))
    if cur.fetchone() is None:
        cur.execute("DELETE FROM sessions WHERE id = %s", (session_id,))
```

Appelée dans `revert_last_tournament` et `delete_tournament`, au même endroit que
`drop_grille_snapshot_if_orphan`, avec le `session_id` du tournoi lu **avant** sa suppression.

### 6.3 Pas de garde-fou supplémentaire dans cette phase

Pas de blocage/avertissement à la suppression d'un tournoi membre d'une session activement utilisée
pour du calcul de présence récent (à la différence du garde-fou envisagé pour les recaps figés dans
[[refactor-historique-recaps-plan]], §3.3 R-refactor-3, qui est un chantier distinct) — la décision
actée (« rien ne change s'il reste un autre tournoi ») couvre déjà le cas courant sans ajouter de
règle de blocage. À reconsidérer seulement si un usage réel révèle un besoin.

---

## 7. Phase 5 — Affichage de la landing page par session

> Idée de l'utilisateur (13/09) : « tournoi seul = un seul tournoi affiché ; plusieurs tournois dans
> une session = tous affichés. Ça simplifie la logique d'affichage. »
>
> **Verdict de l'analyse : l'idée est cohérente et simplifie réellement le code — mais elle ne
> couvre pas le cas du mode ligue, qui s'appuie aujourd'hui sur autre chose qu'une notion de
> journée.** Détail ci-dessous.
>
> **Précision de l'utilisateur (15/09)** : la landing page est le **seul** endroit de l'affichage qui
> se sert réellement de la notion de session — ailleurs (classement de saison, recaps, `/stats/
> tournois`), la session ne sert qu'au comptage et à la pénalité, jamais à l'affichage (décision
> actée n°7, en-tête). Ici, son usage reste limité à une question binaire — *combien de tournois
> cette session contient-elle, pour décider d'en afficher une ou plusieurs cartes* — pas à afficher
> le concept de session lui-même (pas de libellé « session », pas de numéro : voir §7.4, `index.html`
> ne change pas). Le mode ligue reste, comme tranché ci-dessous (option 1), en dehors de ce
> regroupement : il continue d'afficher le dernier tournoi de **chaque** ligue, indépendamment de
> toute session.

### 7.1 Ce que fait la landing page aujourd'hui

Chaîne complète : `frontEnd/frontend.py:329-333` (`/`) appelle `GET /dernier-tournoi`
([routes_public.py:475-557](../backEnd/routes_public.py#L475-L557)), et `index.html:267` boucle sur
le résultat en affichant **une carte par tournoi**. Le template est déjà entièrement générique : il
itère sur une liste, sans aucune hypothèse sur ce qui la compose (`{% if resultats|length > 1 %}` ne
change que le titre, « Résultats des derniers tournois » au pluriel).

`/dernier-tournoi` a **deux branches** qui décident quels tournois entrent dans cette liste :

| Branche | Condition | Règle de regroupement |
|---|---|---|
| « ligue » | le dernier tournoi porte une ligue (≠ Mixte) | `DISTINCT ON (t.ligue_nom)` — **le dernier tournoi de chaque ligue**, quelle que soit sa date |
| « standard » | le dernier tournoi est sans ligue ou Mixte | `date_trunc('week', date) = date_trunc('week', <date du dernier>)` — **tous les tournois de la semaine calendaire** |

La branche standard est donc un troisième regroupement implicite, encore différent des deux déjà
recensés (§0 pour la pénalité, §10.3 pour `session_keys` des awards) : **par semaine ISO**, pas par
jour ni par ligue.

### 7.2 Pourquoi l'idée est cohérente : vérification sur les données

Le regroupement par semaine et le regroupement par session donnent-ils le même résultat
aujourd'hui ? Mesure sur les 63 tournois sans ligue de `dumps/dump_2026-09-03_1119.sql` :

**Aucune semaine ne contient deux dates de jeu distinctes.** Les parties tombent toujours sur un
seul jour par semaine (le lundi), et les 3 paires multi-lobbies sans ligue (90/91, 93/94, 95/96)
tombent chacune le même jour. Exemple sur les dernières semaines :

```
89 | 2026-06-22 | 2026-W26      ← 1 tournoi
90 | 2026-06-29 | 2026-W27  ┐
91 | 2026-06-29 | 2026-W27  ┘   ← 2 tournois, MEME JOUR
92 | 2026-07-06 | 2026-W28      ← 1 tournoi
93 | 2026-07-13 | 2026-W29  ┐
94 | 2026-07-13 | 2026-W29  ┘   ← 2 tournois, MEME JOUR
```

Conséquence : **« les tournois de la semaine du dernier tournoi » et « les tournois de la session du
dernier tournoi » sélectionnent exactement le même ensemble** sur tout l'historique réel. Basculer
la branche standard sur `session_id` ne change donc rien à l'affichage actuel, tout en remplaçant
une heuristique de calendrier par la donnée explicite. C'est une simplification sans régression
visible — le meilleur cas de figure pour un refactor.

Le gain est réel côté code : la requête `date_trunc('week', ...)` (et le `last_date` qu'elle exige)
disparaît au profit d'un `WHERE t.session_id = %s`. Et surtout, la règle devient **la même que
celle de la pénalité d'absence** : un seul concept à comprendre pour l'affichage et pour le calcul,
au lieu de deux heuristiques qui coïncident par chance.

### 7.3 La limite : le mode ligue ne se regroupe pas par session

C'est le point que la proposition ne couvre pas, et il faut le trancher avant d'implémenter.

En mode ligue, les données montrent que **les deux ligues ne jouaient pas le même jour** :

```
64 | 2026-03-23 | Ligue 1      68 | 2026-04-06 | Ligue 1
65 | 2026-03-25 | Ligue 0      69 | 2026-04-08 | Ligue 0
66 | 2026-03-30 | Ligue 1      70 | 2026-04-13 | Ligue 1
67 | 2026-04-01 | Ligue 0      71 | 2026-04-15 | Ligue 0
```

Ligue 1 le lundi, Ligue 0 le mercredi — deux occasions de jeu distinctes, donc **deux sessions
distinctes** par construction. Or la branche « ligue » actuelle les affiche **ensemble** sur la
landing page (`DISTINCT ON (t.ligue_nom)` = le dernier tournoi de chaque ligue, sans contrainte de
date). Son intention n'est pas « la dernière occasion de jeu » mais « où en est chaque ligue » —
une vitrine par ligue, pas un compte-rendu de soirée.

Un regroupement par session **ne peut pas** reproduire cet affichage : il ne montrerait que la
dernière ligue ayant joué. Trois options :

1. **Ne basculer que la branche standard** sur `session_id`, laisser la branche ligue telle quelle.
   Recommandé : chaque branche garde la règle qui correspond à son intention réelle, et on ne casse
   pas un affichage volontaire. Le gain de simplification est acquis là où il a du sens.
2. Basculer les deux, en acceptant que la landing page n'affiche plus qu'une ligue à la fois —
   **changement fonctionnel visible**, à valider explicitement par l'utilisateur, pas un effet de
   bord de refactor.
3. Unifier autrement (ex. « la dernière session de chaque ligue ») — plus proche de l'existant mais
   réintroduit une logique à deux niveaux, donc peu de gain de simplicité.

**Recommandation : option 1.** L'idée de l'utilisateur est juste pour le cas courant (mode ligue
inactif — 63 des 92 tournois, et tous les récents), et c'est là que la simplification paie. Le mode
ligue relève d'un besoin d'affichage différent qu'une session ne modélise pas.

### 7.4 Ce que ça change concrètement

- `GET /dernier-tournoi`, branche standard : remplacer la requête `date_trunc('week', ...)` par une
  sélection sur la `session_id` du dernier tournoi. La variable `last_date` n'est alors plus
  nécessaire dans cette branche.
- `index.html` : **aucun changement**. Le template boucle déjà sur une liste de longueur variable,
  et son titre s'adapte au singulier/pluriel. C'est ce qui rend cette phase peu risquée — toute la
  logique à toucher est dans une seule requête SQL.
- Le cache `dernier_tournoi` (`get_cached`/`set_cached`) est invalidé par `invalidate_cache()` à
  chaque ajout de tournoi, donc rien de spécial à prévoir — **sauf** que `fusionner_sessions`
  (Phase 2) doit aussi appeler `invalidate_cache()` : lier deux tournois change désormais ce que la
  landing page doit afficher. À ne pas oublier, c'est le genre d'omission qui se voit en prod et pas
  en test.
- `GET /stats/tournois` : **décision de l'utilisateur (15/09), qui annule la suggestion initiale
  ci-dessous** — cet écran n'affiche pas la notion de session et ne change pas. La session reste un
  concept de calcul (comptage, pénalité), pas un concept d'affichage ; voir la décision actée n°7 en
  en-tête et R-session-6 (§8). La liste de `add_tournament.html` (proposition de liaison, Phase 2)
  fait exception puisque c'est l'écran où l'admin choisit explicitement à quel tournoi lier — il a
  besoin d'y voir les tournois candidats, pas une colonne « session ».

---

## 8. Risques transverses

- **R-session-1 (tranché le 13/09, puis largement désamorcé le 15/09)** : la liaison étant un geste
  *a posteriori*, une pénalité pouvait avoir déjà été écrite pour un joueur avant que l'admin ne
  relie les deux tournois de sa session. **Résolution actée** : `fusionner_sessions` corrige
  rétroactivement ces pénalités (§5.2).

  ✅ **La décision 10 du 15/09 (§13.1bis F-1c) supprime ce risque sur le chemin nominal** : la
  session étant choisie avant l'écriture et avant le calcul, il n'y a plus de pénalité écrite « trop
  tôt » à annuler. C'était le point le plus délicat du plan ; il ne subsiste que pour la liaison
  **tardive** (deux tournois déjà enregistrés), devenue un cas secondaire.

  Ce qui reste vrai : le chemin tardif écrit toujours dans `ghost_log` depuis un endroit qui n'est
  pas `add_tournament` — à couvrir par un test dédié (§10.5) avant de considérer la Phase 3 finie.
- **R-session-6 (nouveau, §10.3)** : trois notions concurrentes de « nombre de tournois » coexistent
  déjà dans `services.py` — `len(set(session_keys.values()))` regroupé par `(date, ligue)` à la
  ligne 833, contre `len(tournoi_ids)` brut aux lignes 506 et 651. Le regroupement de la ligne 833
  est exactement la même heuristique que celle que ce plan remplace, dupliquée hors de
  `add_tournament`. Elle doit basculer sur `session_id` **dans la même phase** que le calcul de
  pénalité, sinon les awards (Grand Master, seuils `MIN_PARTICIPATION_RATIO`) et la pénalité
  d'absence compteront les sessions différemment. Les lignes 506/651 sont un écart préexistant,
  indépendant de ce plan : à signaler à l'utilisateur, pas à corriger silencieusement ici.

  **Décision de l'utilisateur (15/09), qui étend R-session-6** : le compte fiable de « combien de
  tournois ont eu lieu durant une saison » — utilisé pour le classement de saison **et** pour les
  recaps — doit lui aussi se baser sur les **sessions**, pas sur les lignes `Tournois` brutes. Deux
  lobbies liés dans une même session comptent donc pour **une seule** occasion de jeu dans ces
  calculs, exactement comme pour la pénalité d'absence et les awards (même heuristique, un seul
  endroit où elle est vraie). Point important à ne pas confondre avec ce comptage interne :
  **l'affichage, lui, continue de parler de « tournois »** — un recap ou un classement de saison
  montre toujours la liste des tournois (chacun avec sa date, son vainqueur, etc.), jamais le mot
  « session » ni un numéro de session ; seul le *dénominateur* utilisé dans les ratios et les seuils
  change de base. Autrement dit : la session est l'unité de **calcul**, le tournoi reste l'unité
  d'**affichage** — cohérent avec la Phase 5 (§7), où le template `index.html` ne change pas non
  plus et continue d'afficher une carte par tournoi.

  Conséquence sur le périmètre : ce comptage « tournois par saison » n'est pas encore recensé
  explicitement dans `services.py` au-delà de `session_keys`/`total_tournois` (§10.3) — il faut,
  au moment de la Phase 3, **chercher spécifiquement** tout calcul lié à `saisons` (la table est déjà
  dans `sync_sequences()`, ligne 940) qui compte des tournois pour vérifier s'il utilise déjà
  `session_keys` ou une autre heuristique encore non recensée. Si un quatrième comptage apparaît là,
  l'unifier avec les autres au lieu d'en garder un cinquième. Ce recensement fait partie du travail
  de la Phase 3, pas un préalable séparé — mais **avant** de coder, lister tous les endroits
  concernés (classement de saison, recaps, awards, pénalité) dans un seul inventaire pour vérifier
  qu'ils convergent tous vers `session_id`.
- **R-session-7 (constaté en usage réel le 2026-09-14, non corrigé)** : **annuler un tournoi laisse
  sa notification en place.** `add_tournament` diffuse « Nouveau tournoi du JJ/MM/AAAA — N joueurs y
  ont participé. Classement et TrueSkill sont à jour. » à tous les comptes non suspendus
  ([routes_admin.py:1693](../backEnd/routes_admin.py#L1693), via `notifier_tous`
  [routes_comptes.py:120](../backEnd/routes_comptes.py#L120)). **Ni `revert_last_tournament` ni
  `delete_tournament` ne la retirent ni ne la compensent** : chaque joueur garde un message annonçant
  un tournoi qui n'existe plus, et rien n'indique nulle part qu'il a été supprimé.

  C'est un défaut **distinct** de celui de la Phase 0 (§2) et il n'a pas été corrigé avec lui : la
  Phase 0 portait sur `consecutive_missed`/`is_ranked`, pas sur les notifications. Il est aussi
  **indépendant du chantier sessions** — à traiter comme la Phase 0, c'est-à-dire seul.

  Point de conception à trancher avant de coder, parce que les deux options ne disent pas la même
  chose à l'utilisateur :

  1. **Supprimer la notification d'origine** (`DELETE FROM notifications WHERE type =
     'tournoi_ajoute' AND ...`). Problème : `notifications` n'a **aucune colonne `tournoi_id`**
     ([schema.sql:353](../backEnd/schema.sql#L353)) — la seule accroche serait le titre, qui contient
     la date, ce qui casserait sur deux tournois le même jour (cas réel : 4 dates en portent deux,
     §10.2). Suppose donc d'ajouter une colonne de référence, ou au minimum une clé de corrélation.
     Efface aussi une notification déjà lue, ce qui réécrit l'historique du joueur.
  2. **Émettre une seconde notification d'annulation**, laissant la première en place. Aucun
     changement de schéma, et c'est honnête vis-à-vis de ce qui s'est réellement passé (le tournoi a
     existé puis a été annulé). Coût : deux messages au lieu d'un.

  **Recommandation : option 2**, pour trois raisons — pas de migration, pas de réécriture de
  l'historique du joueur, et cohérence avec le reste du système où l'annulation est un événement
  et non un effacement. L'option 1 devient préférable seulement si l'utilisateur juge le bruit
  gênant, et elle demande alors la colonne `tournoi_id` (utile par ailleurs).

  ⚠️ Si l'option 1 est retenue un jour, **ne pas s'accrocher au titre**. C'est exactement la classe
  d'erreur que ce plan combat : déduire un lien d'une chaîne de caractères au lieu de le stocker.

- **R-session-2** : `add_tournament` est déjà une fonction longue et dense
  ([routes_admin.py:1070-1354](../backEnd/routes_admin.py#L1070-L1354)). Comme relevé dans
  [[refactor-historique-recaps-plan]] (R-refactor-1), y ajouter encore de la logique sans extraction
  préalable en sous-fonctions aggrave la maintenabilité au lieu de la réduire — d'autant plus vrai
  ici puisque le nœud du problème (§5.2) est justement de sortir la déduplication de présence de
  cette fonction. L'occasion de cette phase est plutôt de **retirer** de la complexité d'
  `add_tournament` (la déduplication de date disparaît) que d'en ajouter.
- **R-session-3** : une session neutre vis-à-vis de la ligue veut dire qu'un admin pourrait lier par
  erreur deux tournois de ligues totalement différentes sans rapport (fausse manip dans la liste
  libre de tournois récents). Aucune garde-fou n'est demandé dans les décisions actées, mais la
  Phase 2 devrait au minimum **afficher la ligue** de chaque tournoi proposé dans la modale pour
  limiter le risque d'erreur de clic, sans bloquer le geste.
- **R-session-4** : `dumps/` contient des exports réels de production dans un dépôt public
  ([[repo-public-donnees-reelles-historique]]) — toute vérification de migration doit tourner sur
  une copie locale non versionnée, jamais générer un nouveau dump commité pendant la mise au point.
- **R-session-5** : ordre avec [[refactor-historique-recaps-plan]] — tant que Phase 3 de ce plan-ci
  n'est pas validée en prod, ne pas commencer la Phase 1 de `mu_sigma_history` de l'autre plan : son
  schéma cible (§2.1 de ce plan-là) devra de toute façon apprendre à distinguer une pénalité
  déclenchée par session plutôt que par tournoi isolé, autant le concevoir une fois la notion de
  session stabilisée plutôt que de le migrer deux fois.

---

## 9. Ce qui n'est PAS dans ce plan

- La refonte historique mu/sigma (table journal, recaps figés, awards traçables) : chantier
  séparé, déjà documenté dans [[refactor-historique-recaps-plan]], à reprendre seulement après
  validation complète de celui-ci.
- Toute clôture explicite de session (bouton « fermer la session », statut ouvert/fermé) : pas
  demandée, la session actée se construit uniquement par liaisons successives sans état de cycle de
  vie propre.
- Dé-liaison d'un tournoi d'une session une fois lié : pas demandée dans cette première itération
  (§3.2).
- Garde-fou bloquant la suppression d'un tournoi membre d'une session « active » : pas demandé
  (§6.3), à distinguer du garde-fou proposé pour les recaps figés dans l'autre plan.
- Correction de l'écart `len(tournoi_ids)` vs regroupement par session aux lignes 506/651 de
  `services.py` (R-session-6) : écart préexistant à signaler, hors périmètre.

---
## 10. Analyse de faisabilité (13/09, sur données réelles)

Mesures faites sur `dumps/dump_2026-09-03_1119.sql`, le dump de production le plus récent du dépôt.
**À noter d'emblée : `backEnd/dump.sql` est périmé** (88 tournois, 0 ligne `ghost_log`) par rapport
à ce dump (92 tournois, 128 lignes `ghost_log`) — ne pas se baser sur `backEnd/dump.sql` pour
dimensionner la migration.

### 10.1 Verdict

**Le plan est faisable, et le volume de données le rend peu risqué.** Aucun obstacle bloquant
trouvé. Trois éléments facilitent nettement le chantier, un élément l'alourdit.

### 10.2 Ce que contiennent les données réelles

| Mesure | Valeur |
|---|---|
| Tournois | 92 |
| Dates distinctes | 88 |
| **Dates portant 2 tournois** | **4** (2026-03-02, 2026-06-29, 2026-07-13, 2026-07-20) |
| Dates portant 3+ tournois | 0 |
| Lignes `ghost_log` | 128 |
| Joueurs | 39 |
| Participations | 620 |

Les 4 paires de tournois du même jour, examinées une par une :

| Date | Tournois | Ligues | Joueurs communs | `ghost_log` généré par |
|---|---|---|---|---|
| 2026-03-02 | 54, 58 | Ligue 0 / Ligue 1 | 0 | 58 seulement (4 lignes) |
| 2026-06-29 | 90, 91 | aucune / aucune | 0 | 90 seulement (3 lignes) |
| 2026-07-13 | 93, 94 | aucune / aucune | 0 | 93 seulement (4 lignes) |
| 2026-07-20 | 95, 96 | aucune / aucune | 0 | 95 seulement (5 lignes) |

**Zéro joueur commun dans les 4 paires** : signature nette de vrais multi-lobbies (une soirée
scindée en deux lobbies disjoints), pas de deux occasions de jeu distinctes le même jour. Le
backfill peut donc regrouper ces paires en toute confiance (§11).

**Vérification de l'intégrité de l'historique existant** : pour chacune des 4 paires, aucun joueur
pénalisé par un tournoi n'avait participé à l'autre tournoi du même jour. Autrement dit, le patch
`counted_today` actuel **a fonctionné correctement** — il n'y a aucune double pénalité à réparer
dans l'historique. Le chantier est une simplification structurelle, pas une correction de bug de
données.

### 10.3 Ce qui alourdit le chantier : la duplication dans `services.py`

Le regroupement implicite par date n'est **pas seulement** dans `add_tournament`. `services.py:813-833`
fait le même regroupement, pour un autre usage :

```python
session_keys = {}
...
# Une session de matchmaking peut generer plusieurs tournois le meme jour dans
# la meme ligue : on les regroupe, comme pour la penalisation d'absence.
session_keys[tid] = (row[7], row[10])   # (date, ligue_id)
...
total_tournois = len(set(session_keys.values()))
```

Ce `total_tournois` alimente `_compute_grand_master` et les seuils `MIN_PARTICIPATION_RATIO` /
`MIN_TOURNAMENT_RATIO` des awards. Le commentaire du code dit explicitement « comme pour la
pénalisation d'absence » : c'est la même heuristique, dupliquée. Elle doit basculer sur `session_id`
dans la même phase, sinon awards et pénalités ne compteront plus les sessions de la même façon
(R-session-6).

Écart préexistant repéré au passage, **hors périmètre mais à signaler** : `compute_ip_evolution`
(`services.py:506`) et `compute_position_evolution` (`services.py:651`) utilisent
`total_tournois = len(tournoi_ids)`, un comptage brut **sans** regroupement de session. Trois
notions de « nombre de tournois » coexistent donc déjà aujourd'hui dans le code. Le chantier
session est l'occasion de les unifier, mais c'est une décision à prendre explicitement (ça change
des valeurs affichées), pas un effet de bord à embarquer en silence.

### 10.4 Ce qui facilite le chantier

- **Volume dérisoire** : 92 tournois, 4 paires à regrouper, 39 joueurs. Un backfill se vérifie à
  l'œil nu, ligne par ligne, ce qui est un luxe rare pour une migration de schéma.
- **Migrations déjà outillées** : `backEnd/migrations/` contient 9 migrations SQL versionnées, avec
  la convention `AAAA-MM-JJ_sujet.sql` et des `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT
  EXISTS` idempotents (cf. `2026-08-20_add_grille_snapshots.sql`). Rien de nouveau à inventer.
- **Précédent exact à copier** : `grille_snapshots` est déjà une table qui fige un état par
  journée, avec sa fonction de nettoyage d'orphelin (`drop_grille_snapshot_if_orphan`) appelée dans
  `revert_last_tournament` et `delete_tournament`. La table `sessions` et
  `drop_session_if_orphan` (§6.2) reproduisent ce motif à l'identique — même emplacement d'appel,
  même logique.
- **Le mode ligue est inactif en pratique** : 91 des 92 tournois ont `ligue_id` NULL ou archivé ;
  seuls les tournois 54/58 portent une vraie ligue. Le risque de régression sur le filtrage par
  ligue est donc faible en production immédiate — mais le code doit rester correct pour le mode
  ligue, qui peut être réactivé.

### 10.5 Point de vigilance : les tests ne couvrent pas cette zone

`backEnd/tests/` contient 14 fichiers, mais **aucun ne teste `add_tournament` ni la logique de
pénalité d'absence**. La couverture porte sur l'authentification, les permissions, la hiérarchie
admin, le RGPD, le matchmaking.

De plus, `harness.py` neutralise `psycopg2` **et** `trueskill` par des stubs : le curseur est
scripté (une liste de couples `(regex, ligne renvoyée)`) et, comme le dit son propre en-tête, « ça
ne valide pas le SQL ». Conséquences concrètes pour ce chantier :

- Un test dans ce harness peut valider **l'enchaînement** des requêtes de `fusionner_sessions`
  (qui lit quoi, dans quel ordre, sous quelles conditions) — c'est utile et c'est là qu'un oubli de
  `recalculate_tiers()` ou de décrémentation de `consecutive_missed` se verrait.
- Il ne peut **pas** valider que le SQL du backfill produit les bons regroupements, ni que la
  contrainte `NOT NULL` passe. Ça exige une vraie base Postgres locale chargée depuis une copie du
  dump.

**Recommandation** : pour la Phase 3, deux niveaux de validation — un test dans le harness existant
pour la séquence de `fusionner_sessions`, et une vérification manuelle sur une base locale chargée
depuis une copie non versionnée du dump (R-session-4) pour le SQL et le backfill. Ne pas considérer
la phase finie sur le seul harness.

---

## 11. Faut-il adapter un dump à la main pour ne pas perdre l'historique ?

**Non.** L'historique se migre par un script SQL de backfill, versionné dans
`backEnd/migrations/`, comme les 9 migrations précédentes du projet. Aucune édition manuelle de
dump n'est nécessaire, et il ne faut surtout pas en faire une : un dump édité à la main n'est pas
reproductible, ne documente pas son intention, et ne peut pas être rejoué sur une base de
production qui a évolué depuis.

### 11.1 Pourquoi rien n'est perdu

Ajouter `sessions` + `tournois.session_id` **n'enlève aucune colonne et ne réécrit aucune donnée
existante**. `Tournois`, `Participations`, `ghost_log`, `joueurs.consecutive_missed` gardent
exactement leur contenu actuel. Le backfill ne fait qu'*ajouter* l'information de regroupement qui
n'existait nulle part explicitement — il ne corrige pas l'historique, qui est déjà correct (§10.2).

### 11.2 Le script de backfill

Le regroupement de backfill reprend la clé `(date, ligue_id)` — exactement l'heuristique que le
code appliquait implicitement jusqu'ici. L'historique reconstitué est donc **par construction
identique à ce que le calcul voyait**, ce qui est le but : le backfill documente l'existant, il ne
le réinterprète pas.

Dans la migration `backEnd/migrations/2026-XX-XX_sessions_tournois.sql`, après le `ALTER TABLE`
de §3.2 :

```sql
-- 1. Une session par GROUPE (date, ligue_id), d'id = l'id du tournoi le plus
--    ancien du groupe. Reutiliser cet id evite une table de correspondance
--    temporaire et rend le resultat relisible : session 90 = la soiree du
--    tournoi 90. Les 3 paires de §10.2 partagent donc une seule session.
--    ON CONFLICT DO NOTHING : la migration est rejouable sans echouer.
INSERT INTO public.sessions (id, created_at)
SELECT MIN(t.id), now()
FROM public.tournois t
GROUP BY t.date, t.ligue_id
ON CONFLICT (id) DO NOTHING;

-- 2. Chaque tournoi rejoint la session de son groupe. Le WHERE ... IS NULL
--    rend l'etape rejouable et ne touche jamais une liaison deja faite a la
--    main (important si la migration est relancee apres un usage de l'UI).
UPDATE public.tournois t
SET session_id = anc.ancre
FROM (SELECT date, ligue_id, MIN(id) AS ancre
      FROM public.tournois GROUP BY date, ligue_id) anc
WHERE t.session_id IS NULL
  AND t.date = anc.date
  AND (t.ligue_id = anc.ligue_id OR (t.ligue_id IS NULL AND anc.ligue_id IS NULL));

-- 3. Sequence recalee APRES les INSERT a id explicite, sinon le premier
--    INSERT ... DEFAULT VALUES de add_tournament heurte une PK existante.
--    GREATEST(..., 1) : setval refuse 0, et MAX(id) est NULL sur table vide.
SELECT setval('public.sessions_id_seq',
              GREATEST((SELECT COALESCE(MAX(id), 0) FROM public.sessions), 1));

-- 4. Verrouillage : plus aucune ligne ne doit etre NULL a ce stade.
--    Si cet ALTER echoue, c'est que l'etape 2 a laisse un tournoi de cote --
--    ne PAS forcer, diagnostiquer (cf §10.3).
ALTER TABLE public.tournois ALTER COLUMN session_id SET NOT NULL;
```

Réutiliser l'`id` du tournoi-ancre comme `id` de session est un raccourci volontaire : il rend le
backfill déterministe et relisible (session 90 = la soirée du tournoi 90), sans table de
correspondance temporaire.

Le `setval` sur la séquence est **indispensable** après un INSERT avec `id` explicite, sinon le
prochain `INSERT INTO sessions DEFAULT VALUES` de `add_tournament` échoue sur un conflit de clé
primaire — c'est l'erreur classique de ce genre de backfill.

**Vérifié le 13/09** : `sync_sequences()` ([services.py:182-193](../backEnd/services.py#L182-L193))
ne couvre **pas** `sessions` — sa liste est codée en dur :

```python
tables = ['Joueurs', 'Tournois', 'saisons', 'types_awards', 'awards_obtenus']
```

Il faut donc **ajouter `'sessions'` à cette liste** dans la Phase 1. Ce n'est pas optionnel : la
fonction est appelée au démarrage de l'application (`backend.py:28`), c'est le filet qui rattrape
un décalage de séquence. Noter au passage que son `setval(..., (SELECT MAX(id) ...))` passerait
`NULL` sur une table vide ; ici la table ne l'est jamais après backfill, mais si `sessions` est
ajoutée à la liste avant que la migration ait tourné, le `try/except` de la fonction avale l'erreur
silencieusement — donc pas de casse, mais pas de synchronisation non plus. Ordre à respecter :
migration d'abord, puis l'ajout à la liste.

### 11.3 Vérifications attendues après backfill

Sur une copie locale chargée depuis `dumps/dump_2026-09-03_1119.sql` (jamais sur les dumps
commités eux-mêmes — R-session-4) :

Décompte vérifié sur le dump : les groupes `(date, ligue_id)` distincts sont au nombre de **89**,
pour 92 tournois — soit 3 paires fusionnées (celles sans ligue). Le couple 54/58 du 2026-03-02
n'est pas fusionné puisque ses deux tournois portent des `ligue_id` différents.

| Contrôle | Attendu |
|---|---|
| `SELECT count(*) FROM sessions` | **89** |
| `SELECT count(*) FROM tournois WHERE session_id IS NULL` | 0 |
| Sessions à 2 tournois | 3 (les paires sans ligue : 90/91, 93/94, 95/96) |
| Sessions à 1 tournoi | 86 |
| Tournois 54 et 58 | **2 sessions distinctes** (ligues différentes) |

Ces chiffres valent pour `dumps/dump_2026-09-03_1119.sql`. Les recalculer sur la base réellement
migrée au moment de la migration : la production a pu gagner des tournois depuis le 03/09.

Le cas 54/58 mérite d'être tranché explicitement avec l'utilisateur : le backfill par
`(date, ligue_id)` les laisse en deux sessions, ce qui **reproduit fidèlement l'ancien
comportement**. Mais si ces deux lobbies étaient bien la même soirée (ce que suggèrent la date
commune et l'absence de joueur commun), le modèle cible — session neutre vis-à-vis de la ligue,
§5.3 — voudrait qu'ils soient une seule session. Les fusionner corrigerait l'historique ; ne pas
les fusionner le préserve tel quel. **Recommandation : ne pas les fusionner dans la migration**
(préserver l'historique, principe de moindre surprise) et laisser l'admin les lier à la main via
l'UI de Phase 2 s'il le souhaite — le geste existe désormais pour ça, et il sera tracé comme une
action volontaire plutôt que comme un effet de bord de migration.

### 11.4 Ce qu'il faut faire du dump périmé

`backEnd/dump.sql` (88 tournois, 0 ghost_log) est en retard sur la production. Il sert
vraisemblablement de jeu d'amorçage pour une base de développement. Deux options, à trancher avec
l'utilisateur — mais **pas** dans cette migration :

- le laisser tel quel et compter sur la migration idempotente pour l'amener au schéma courant quand
  il est chargé ;
- le régénérer depuis la production, ce qui implique de committer des données réelles fraîches dans
  un dépôt public ([[repo-public-donnees-reelles-historique]]) — décision qui appartient à
  l'utilisateur, pas un effet de bord de ce chantier.

Dans les deux cas, la migration doit s'appliquer proprement sur une base issue de
`backEnd/dump.sql` *et* sur une base issue du dump récent : d'où le `ON CONFLICT DO NOTHING` de
l'étape 1 et le `WHERE session_id IS NULL` de l'étape 2, qui rendent le backfill rejouable sans
effet de bord.

---

## 12. Réversibilité — que faire si on s'est trompé

Aucune des 9 migrations existantes du projet n'a de section de rollback ; la convention est plutôt
un en-tête qui explique le *pourquoi* et liste les **prérequis à vérifier avant de lancer** (cf.
`2026-09-10_hierarchie_admin.sql`). Ce chantier doit suivre la même convention, mais il mérite en
plus une note explicite de réversibilité, parce qu'il touche au calcul du classement.

### 12.1 Ce qui est réversible sans perte, et ce qui ne l'est pas

| Phase | Réversibilité | Pourquoi |
|---|---|---|
| 1 (schéma + backfill) | **Totale** | `DROP COLUMN session_id` + `DROP TABLE sessions` suffit : aucune donnée préexistante n'est modifiée par la migration (§10.1). Le regroupement `(date, ligue_id)` reste recalculable à tout moment. |
| 2 (UX de liaison) | **Totale** | Ajout d'une route et d'une modale ; rien à défaire côté données tant que personne n'a cliqué. |
| 3 (bascule du calcul) | **Partielle** | Le code se réverte par `git revert`, mais les pénalités **déjà appliquées** sous la nouvelle règle restent en base. |
| 4 (annulation/orphelines) | Totale côté code | Sauf si la correction du défaut de `revert_last_tournament` (§2) a modifié des `consecutive_missed`/`is_ranked` : ces valeurs, elles, ne se reconstituent pas par un revert de code. |
| 5 (affichage) | **Totale** | Une requête SQL de lecture ; aucun effet sur les données. |

La ligne à retenir : **tout ce qui touche `joueurs.sigma`, `consecutive_missed` et `is_ranked` est
un état mutable sans historique** — c'est précisément le constat qui fonde
[[refactor-historique-recaps-plan]]. Un `git revert` ne les rembobine pas.

### 12.2 Conséquence pratique sur l'ordre de travail

- **Phases 1, 2 et 5 peuvent être livrées sans filet particulier** : elles n'altèrent aucune valeur
  de classement. C'est un argument pour les faire d'abord et les laisser tourner un moment — on
  gagne la structure et l'affichage simplifié sans toucher au calcul.
- **Avant la Phase 3**, prendre un dump de la base (non versionné, R-session-4). C'est le seul vrai
  filet : si la nouvelle règle produit un écart inattendu sur `consecutive_missed`, la restauration
  passe par ce dump, pas par un revert de code.
- **La Phase 3 est aussi le bon moment pour envisager** `mu_sigma_history`
  ([[refactor-historique-recaps-plan]] Phase 1) : une fois ce journal en place, une erreur de règle
  de pénalité redevient rejouable au lieu d'être définitive. Ce n'est pas un prérequis (R-session-5
  dit l'inverse pour l'ordre de conception), mais c'est l'argument à peser si la Phase 3 inquiète.

### 12.3 Point de non-retour à surveiller

Le `ALTER COLUMN session_id SET NOT NULL` (étape 4 du backfill) est le seul geste de la Phase 1 qui
peut échouer bruyamment — et c'est voulu : il échoue si un tournoi n'a pas reçu de session, ce qui
signalerait un backfill incomplet. **Ne pas contourner cet échec** en retirant le `NOT NULL` :
diagnostiquer d'abord avec

```sql
SELECT id, date, ligue_id FROM public.tournois WHERE session_id IS NULL;
```

Un tournoi listé ici est un cas que l'étape 2 n'a pas su regrouper — à comprendre avant d'aller
plus loin, car le reste du plan suppose l'invariant « tout tournoi a une session ».

---

## 13. Audit du plan (15/09) — failles trouvées, vérifiées sur le code et les données

> Relecture critique du plan entier après les décisions 7 et 8, avec vérification systématique
> contre le code réel et le dump le plus récent. **Six failles trouvées**, dont deux qui bloquent
> une décision déjà actée. Cette section ne remplace rien : elle liste ce qui doit être tranché ou
> corrigé avant d'implémenter.

### 13.1 ✅ F-1 — Numérateur/dénominateur incohérents → **résolu par la décision 9 (unicité en session)**

> **Tranché le 15/09.** L'utilisateur impose qu'un même joueur ne puisse pas être enregistré dans
> deux tournois d'une même session (décision 9, §13.1bis). Cette règle **supprime la faille à la
> racine** au lieu de choisir entre les options A/B/C ci-dessous : si un joueur ne peut participer
> qu'à un seul tournoi par session, alors « nombre de participations » et « nombre de sessions
> jouées » deviennent **égaux par construction**, et `matchs` / `total_tournois` comparent enfin la
> même unité.
>
> **Vérifié sur les données** : sur les 658 participations de `dumps/dump_2026-09-15_admin.sql`,
> **aucun joueur n'apparaît dans deux tournois d'un même groupe `(date, ligue_id)`**. La règle est
> donc déjà respectée sur tout l'historique — la contrainte peut être posée sans aucun nettoyage de
> données, et aucune valeur affichée ne change. Le `2/1` décrit ci-dessous était un risque
> théorique, jamais matérialisé en production.
>
> L'analyse ci-dessous est conservée car elle documente *pourquoi* la décision 9 est la bonne
> réponse, et parce que les seuils d'awards restent à vérifier (voir la note en fin de section).

**La faille telle qu'elle était diagnostiquée** — elle existait déjà en production ; la décision 7 ne
la créait pas, elle la rendait visible.

Dans `_aggregate_season_stats` ([services.py:929](../backEnd/services.py#L929)) :

```python
total_tournois = len(set(session_keys.values()))   # compte des SESSIONS (regroupe (date, ligue))
...
p["matchs"] += 1                                    # compte des LIGNES DE PARTICIPATION (un TOURNOI)
```

Ce `total_tournois` est affiché comme dénominateur de participation dans
[classement_saison.html:147](../frontEnd/templates/classement_saison.html#L147) et
[recap.html:548](../frontEnd/templates/recap.html#L548) sous la forme `Part. /N`, avec `matchs`
comme numérateur. **Conséquence chiffrée** : un joueur qui a joué les deux lobbies d'une session
multi-lobbies affiche `2/1` pour cette session. Sur le dump du 15/09, 3 sessions sont concernées —
un joueur présent aux deux lobbies des 3 paires peut donc afficher jusqu'à **96/93**, soit un ratio
> 100%.

Pire, `MIN_PARTICIPATION_RATIO` et `MIN_TOURNAMENT_RATIO` comparent `matchs` (tournois) à
`total_tournois * ratio` (sessions) aux lignes [1106, 1112, 1118, 1123](../backEnd/services.py#L1106) :
les seuils d'éligibilité aux awards sont donc **légèrement trop permissifs** pour qui joue plusieurs
lobbies. C'est un bug préexistant réel, pas une conséquence du chantier.

**Ce que ça impose de trancher avant d'implémenter la décision 7** : il faut choisir l'unité du
numérateur, et les deux options ont un sens défendable mais donnent des chiffres différents.

| Option | `matchs` devient | `Part. /N` affiche | Effet de bord |
|---|---|---|---|
| **A — tout en sessions** (cohérent avec la décision 7) | nb de **sessions distinctes** où le joueur a joué | `3/3` pour 3 sessions jouées, même en ayant fait 4 lobbies | Un joueur qui joue les 2 lobbies n'est plus « récompensé » en participation. Les seuils d'awards deviennent exacts. **Change des valeurs affichées et l'éligibilité aux awards.** |
| **B — tout en tournois** | inchangé (nb de participations) | `4/4` — le dénominateur repasse en tournois bruts | Contredit la décision 7 et la décision 5 (pénalité par session) : on aurait deux unités dans le système. |
| **C — statu quo** | inchangé | `4/3` (incohérent) | Ne rien faire = garder le bug. À exclure. |

~~**Recommandation : option A**~~ — **caduc.** La décision 9 rend ces trois options sans objet :
l'unicité en session fait coïncider les deux unités, donc `matchs` reste tel quel (compteur de
participations) **et** devient mécaniquement un compteur de sessions jouées. Aucune valeur affichée
ne change, aucun award passé n'est réévalué. C'est la résolution la moins coûteuse des trois.

✅ **Corollaire, désormais sans risque** : `matchs_ranked`, utilisé aux mêmes lignes, suit
automatiquement la même unité que `matchs` — plus besoin d'arbitrage séparé.

⚠️ **Ce qui reste à vérifier malgré tout** : la contrainte d'unicité empêche les *futurs* doublons,
mais `MIN_PARTICIPATION_RATIO`/`MIN_TOURNAMENT_RATIO` comparent `matchs` à `total_tournois * ratio`
([services.py:1106-1123](../backEnd/services.py#L1106-L1123)). Ces seuils redeviennent exacts une
fois l'unicité garantie — à confirmer par un contrôle après Phase 1 : pour chaque joueur,
`matchs <= total_tournois` doit être vrai sans exception. Si un cas dépasse, c'est qu'une session
contient un doublon que la contrainte n'a pas attrapé (session fusionnée après coup — voir
§13.1bis F-1b).

### 13.1bis 🆕 Décision 9 (15/09) — un joueur ne peut être enregistré que dans un seul tournoi par session

**Règle** : l'enregistrement d'un joueur dans un tournoi doit être refusé s'il participe déjà à un
autre tournoi de la **même session**. C'est la traduction directe du sens physique d'une session :
deux lobbies simultanés d'une même soirée, un joueur ne peut pas être dans les deux.

**Pourquoi c'est la bonne décision** (au-delà de résoudre F-1) : elle transforme un invariant
implicite — respecté de fait sur les 658 participations de l'historique — en **contrainte
vérifiée**. C'est exactement l'esprit du plan (§0) : remplacer une régularité observée par une
donnée garantie.

#### F-1a — Où poser le contrôle

Deux niveaux, complémentaires, à poser **tous les deux** :

1. **Contrôle applicatif dans `add_tournament`** (message d'erreur clair pour l'admin) : avant
   l'INSERT des participations, vérifier qu'aucun joueur saisi n'est déjà présent dans un autre
   tournoi de la session cible. Comme à l'ajout la session ne contient que le tournoi en cours
   (§5.2), **ce contrôle ne peut mordre qu'au moment de la fusion** — voir F-1b.
2. **Contrainte en base**, le filet qui ne peut pas être contourné. Une `UNIQUE` simple ne suffit
   pas : `session_id` est sur `tournois`, pas sur `participations`. Il faut soit un index unique sur
   une vue matérialisée, soit — plus simple et dans l'esprit du projet — un **trigger** ou une
   vérification dans la fonction de fusion. À trancher à l'implémentation ; noter qu'une contrainte
   `EXCLUDE` ou un index fonctionnel n'est pas applicable directement ici car l'information est
   répartie sur deux tables.

**Recommandation** : contrôle applicatif dans `add_tournament` **et** dans `fusionner_sessions`
(refus de fusion, cf. F-1b), plus une requête de contrôle d'intégrité à lancer après migration. Un
trigger PL/pgSQL est possible mais ajoute une mécanique que le projet n'utilise nulle part
ailleurs — à ne faire que si l'utilisateur veut la garantie absolue.

#### F-1b — ✅ Refus catégorique (tranché le 15/09)

**Décision de l'utilisateur : refus catégorique** — l'option A ci-dessous, sans concession. Si on
tente de lier un tournoi à un autre qui contient déjà un même joueur, la liaison est refusée **et le
tournoi n'est pas créé en base**.

| Option | Comportement | Verdict |
|---|---|---|
| **A — refus** | La liaison échoue en nommant le(s) joueur(s) en conflit ; aucune écriture en base | ✅ **Retenu** |
| B — fusion avec avertissement | L'invariant est violé, `matchs > total_tournois` redevient possible | ❌ Rejeté |
| C — déduplication automatique | Détruit des données de match sans décision humaine | ❌ Rejeté |

Le refus est le seul comportement qui préserve l'invariant, et il est informatif : si deux tournois
partagent un joueur, ce ne sont probablement pas deux lobbies simultanés — donc la liaison était une
erreur de clic (R-session-3).

⚠️ **Conséquence sur le §3.3** : `fusionner_sessions` y est décrite comme « idempotente, l'admin peut
cliquer deux fois sans conséquence ». C'est toujours vrai pour un double-clic sur une liaison
valide, mais il faut y ajouter **un cas d'échec explicite** — la fusion n'est plus une opération qui
réussit toujours. À répercuter dans la route de Phase 2 (§4.2), qui doit renvoyer une erreur
exploitable par la modale.

#### F-1c — 🆕 Décision 10 (15/09) : la liaison passe **avant** l'écriture en base

> **Ceci révise la décision 2 du 13/09** (« liaison manuelle *a posteriori*, après validation du
> tournoi »). L'utilisateur tranche désormais : la question de la session est posée **avant** que le
> tournoi ne soit inséré et avant tout calcul de score.

**Nouveau flux demandé** :

1. L'admin saisit le tournoi et valide.
2. **Avant toute écriture en base** : on lui demande si ce tournoi appartient à une session, en
   proposant de le lier à un autre tournoi.
3. Si la liaison demandée viole la décision 9 (joueur commun) → **refus, et le tournoi n'est pas
   créé**.
4. Sinon : création du tournoi, rattachement à la session, calculs de score.

**Pourquoi c'est meilleur que la décision 2** — et c'est un vrai gain, pas seulement une préférence :

- **§5.2 disparaît en grande partie.** La « limite assumée » du modèle a posteriori — des pénalités
  écrites puis annulées rétroactivement par `fusionner_sessions` — **n'a plus lieu d'être** : la
  session est connue **avant** le calcul de pénalité, donc `deja_presents` est correct du premier
  coup. Plus besoin d'annuler des pénalités déjà écrites dans le cas normal.
- **R-session-1 s'effondre** : le risque le plus délicat du plan (« une pénalité peut avoir été
  écrite avant la liaison ») disparaît pour le chemin nominal.
- **Le refus devient possible sans dégât** : refuser une liaison après création laisserait un
  tournoi orphelin déjà calculé ; refuser avant création ne laisse rien.

⚠️ **Ce qui subsiste malgré tout** : `fusionner_sessions` reste nécessaire pour les liaisons
**tardives** (lier deux tournois déjà enregistrés séparément — l'admin a cliqué « Passer » puis
change d'avis). Ce chemin garde la correction rétroactive du §5.2 et le refus F-1b. La décision 10
fait donc du a posteriori un **cas secondaire** au lieu du cas principal, sans le supprimer.

#### F-1d — 🔴 Sécurisation du découpage en étapes (exigence explicite du 15/09)

> « il faut bien veiller à faire en plusieurs étapes pour que ce soit sécurisé »

C'est le point le plus délicat de la décision 10 : poser une question à l'admin **au milieu** d'une
opération d'écriture introduit un aller-retour réseau entre la validation et l'écriture. Trois
pièges à éviter, et une recommandation ferme.

**Piège 1 — l'état intermédiaire côté serveur.** La tentation serait de créer le tournoi « en
brouillon » en attendant la réponse, ou de garder une transaction ouverte pendant que l'admin
réfléchit. **Les deux sont à exclure** : une transaction ouverte sur un temps humain verrouille des
lignes et peut expirer ; un brouillon introduit un état « tournoi pas tout à fait créé » dans un
schéma qui n'en a pas (et qu'il faudrait nettoyer si l'admin ferme son onglet).

**Piège 2 — la double soumission.** Si le client renvoie l'intégralité des données du tournoi à
l'étape 2, un double-clic ou un rejeu crée deux tournois. Il faut une protection.

**Piège 3 — le TOCTOU** (*time-of-check to time-of-use*). Vérifier l'absence de joueur commun à
l'étape de la question, puis créer le tournoi à l'étape suivante, laisse une fenêtre où un autre
admin peut avoir modifié le tournoi cible entre temps. **La vérification doit être refaite au moment
de l'écriture**, dans la même transaction.

**Recommandation : découpage en deux appels, sans état serveur intermédiaire.**

```
Etape 1 — POST /admin/tournois/verifier-session   (lecture seule, AUCUNE ecriture)
  Body   : { date, ligue_id, joueurs: [...], autre_tournoi_id: <int|null> }
  Role   : renvoie la liste des tournois candidats a la liaison, en marquant
           ceux qui partagent un joueur (donc non liables, decision 9).
  Sortie : { candidats: [ {id, date, ligue, nb_joueurs, liable: bool,
                           joueurs_en_conflit: [...]} ] }

Etape 2 — POST /admin/tournois   (l'actuelle add_tournament, transactionnelle)
  Body   : { date, ligue_id, joueurs: [...], autre_tournoi_id: <int|null> }
  Role   : REVERIFIE le conflit dans la transaction, puis cree tout ou rien.
```

**Points clés de ce découpage** :

- **L'étape 1 n'écrit rien.** Elle ne sert qu'à peupler la modale et à griser les candidats non
  liables. On peut la rejouer sans conséquence, et son résultat n'est qu'indicatif.
- **L'étape 2 est autosuffisante et atomique.** Elle reçoit `autre_tournoi_id` et **refait la
  vérification de conflit elle-même**, dans sa propre transaction — c'est ce qui ferme le TOCTOU du
  piège 3. Si l'étape 1 n'a jamais été appelée (client qui court-circuite, appel direct à l'API), la
  sécurité tient quand même : **l'étape 2 ne fait jamais confiance à l'étape 1.**
- **Le refus se fait par `rollback`, un mécanisme déjà en place.** La route utilise déjà
  `conn.rollback()` + réponse `409` pour deux refus métier existants (nom anonymisé
  [routes_admin.py:1499](../backEnd/routes_admin.py#L1499), joueur inconnu sans permission
  [:1515](../backEnd/routes_admin.py#L1515)). Le refus de liaison suit **exactement le même motif** —
  rien de nouveau à inventer, et la garantie « pas de création en base » est celle de Postgres, pas
  du code applicatif.

**Où placer la vérification dans l'étape 2** — l'ordre importe :

```python
# APRES l'INSERT du tournoi et des participations (les joueurs sont alors
# resolus en ids, creations a la volee incluses), AVANT tout calcul TrueSkill
# et avant le bloc de penalite.
if autre_tournoi_id is not None:
    cur.execute("""
        SELECT j.nom
        FROM Participations p
        JOIN Joueurs j ON j.id = p.joueur_id
        JOIN Tournois t ON t.id = p.tournoi_id
        WHERE t.session_id = (SELECT session_id FROM Tournois WHERE id = %s)
          AND p.joueur_id IN (SELECT joueur_id FROM Participations WHERE tournoi_id = %s)
        LIMIT 5
    """, (autre_tournoi_id, tournoi_id))
    conflits = [r[0] for r in cur.fetchall()]
    if conflits:
        conn.rollback()   # le tournoi ET ses participations disparaissent
        return jsonify({
            "error": "Ces joueurs sont deja dans un tournoi de cette session : %s. "
                     "Un joueur ne peut jouer qu'un seul tournoi par session."
                     % ", ".join(conflits),
            "code": "conflit_session",
        }), 409
```

**Pourquoi après l'INSERT et pas avant** : les noms saisis doivent d'abord être résolus en
`joueur_id` (la route crée des fiches à la volée,
[routes_admin.py:1523](../backEnd/routes_admin.py#L1523)), sinon la comparaison se ferait sur des
chaînes de caractères — exactement la classe d'erreur que ce plan combat (§8, R-session-7). Le
`rollback` annule l'INSERT du tournoi, des participations **et** les fiches joueurs créées à la
volée : l'état d'avant est intégralement restauré.

✅ **Vérifié le 15/09 (2e passe)** : `snapshot_grille`
([services.py:293-303](../backEnd/services.py#L293-L303)) écrit uniquement via le curseur passé en
argument (`INSERT INTO grille_snapshots`), donc dans la même transaction — **le rollback l'annule
bien**. Aucune grille figée ne subsiste après un refus. Point clos, mais à garder dans le test de
refus (assertion « aucune ligne `grille_snapshots` créée »).

⚠️ **Le SQL ci-dessus est FAUX — voir §15.1 F-7.** Il compare les joueurs du nouveau tournoi aux
joueurs de la session cible *après* que le nouveau tournoi a potentiellement rejoint cette session,
donc il se détecte lui-même comme conflit. La version corrigée est en §15.1 F-7.

**Protection contre la double soumission (piège 2)** : la contrainte de la décision 9 en est
elle-même une protection partielle — un rejeu à l'identique avec la même liaison serait refusé pour
conflit de joueur (les joueurs du 1er envoi sont déjà dans la session). Mais un rejeu **sans**
liaison créerait bien un doublon. À traiter comme aujourd'hui (le problème préexiste à ce chantier) :
désactivation du bouton côté client pendant la requête, et à défaut, contrôle « un tournoi identique
existe déjà à cette date avec ces joueurs » à évaluer si le cas se produit réellement.

#### F-1e — Impact de la décision 10 sur les phases

Le découpage des phases change : la liaison n'est plus un ajout indépendant après coup, elle entre
dans le chemin de création.

| Phase | Avant (décision 2) | **Après (décision 10)** |
|---|---|---|
| 2 | Modale de liaison après création, route `lier-session` indépendante | **Modale de liaison *avant* création + étape 1 de vérification + `autre_tournoi_id` accepté par `add_tournament`.** Plus gros travail, et ça touche désormais `add_tournament`. |
| 3 | Bascule de la pénalité + `fusionner_sessions` corrige rétroactivement | **Simplifiée** : la session est connue avant le calcul, `deja_presents` est correct du premier coup. La correction rétroactive ne sert plus qu'au chemin tardif. |

⚠️ **La Phase 2 n'est plus « faible risque »** : elle passait pour un simple ajout d'écran, elle
modifie maintenant la route la plus sensible du projet (`add_tournament`, 280 lignes, R-session-2).
Le tableau du §1 doit être corrigé : risque **moyen**, et réversibilité toujours totale tant que
personne n'a lié (aucune donnée de classement altérée).

⚠️ **Conséquence favorable, à ne pas gâcher** : puisque la session est connue avant le calcul, il
devient tentant de supprimer complètement la correction rétroactive de `fusionner_sessions`. **Ne
pas le faire** : le chemin tardif (liaison de deux tournois déjà enregistrés) reste possible et en a
besoin. La décision 10 réduit la fréquence de ce cas, elle ne l'élimine pas.

#### F-1f — Contrôles à ajouter par phase

- **Phase 1** : ajouter au jeu de contrôles post-backfill la requête d'intégrité « aucun joueur dans
  deux tournois d'une même session » (déjà vérifiée à zéro sur le dump, §13.5) :

  ```sql
  SELECT t.session_id, p.joueur_id, count(*)
  FROM participations p JOIN tournois t ON t.id = p.tournoi_id
  GROUP BY t.session_id, p.joueur_id HAVING count(*) > 1;
  -- Attendu : 0 ligne. Toute ligne ici est une violation de la decision 9.
  ```

- **Phase 2** : voir F-1e — la modale, l'étape 1 de vérification, et le refus dans `add_tournament`.
- **Phase 3** : F-1 étant résolu, la bascule du comptage saison/recaps (décision 7) n'a plus de
  décision bloquante en amont.

### 13.2 🔴 F-2 — Le filtrage par ligue rend `consecutive_missed` inutilisable seul (bloquant pour la décision 8)

La décision 8 (§5.4) propose de remplacer le calcul de délai en jours par une simple comparaison sur
`consecutive_missed`. **Ça ne marche pas tel quel en mode ligue**, et le plan ne le dit pas.

Aujourd'hui, `absents` est filtré par ligue avant l'incrémentation
([routes_admin.py:1628-1632](../backEnd/routes_admin.py#L1628-L1632)) :

```python
absents = [row for row in all_absents
           if ligue_id is None or last_played_ligue.get(row[0]) == int(ligue_id)]
```

Un joueur de Ligue 0 n'est donc **pas incrémenté** quand un tournoi de Ligue 1 est ajouté. Son
`consecutive_missed` ne mesure alors pas « combien de sessions j'ai loupées » dans l'absolu, mais
« combien de sessions **de ma ligue** j'ai loupées ». C'est cohérent en soi — mais ça veut dire que
la sémantique du compteur **dépend du mode ligue**, et donc que le réglage
`ghost_threshold_sessions` ne signifie pas la même chose selon que le mode ligue est actif ou non.

Ce n'est pas rédhibitoire (c'est même défendable : « les sessions qui te concernaient »), mais il
faut l'**écrire explicitement dans le §5.4 et dans le libellé du réglage côté admin**, sinon
l'utilisateur réglera « pénalité à partir de 2 sessions loupées » en croyant compter toutes les
sessions. Le mode ligue étant inactif en pratique (§10.4), l'impact immédiat est nul — mais le code
doit rester correct pour sa réactivation.

**Deuxième trou, plus insidieux — ✅ tranché le 15/09** : `consecutive_missed` est **éditable à la
main** par un admin ([routes_admin.py:793-798](../backEnd/routes_admin.py#L793-L798), route
`PUT /admin/joueurs/<id>`). Aujourd'hui ça n'a qu'un effet sur `is_ranked` ; avec la décision 8, ce
champ devient **l'unique déclencheur de la pénalité de sigma** — un admin qui « corrige » un compteur
déclencherait une pénalité au tournoi suivant sans le savoir.

**Décision de l'utilisateur (15/09) : on retire le champ de l'édition, mais on garde l'information
affichée là où elle est.** Autrement dit :

- `consecutive_missed` devient **lecture seule** : retiré du formulaire d'édition de joueur et du
  payload accepté par `PUT /admin/joueurs/<id>` (le champ ne doit plus être lu depuis `data` à la
  [ligne 793](../backEnd/routes_admin.py#L793), et plus figurer dans l'`UPDATE` de la
  [ligne 798](../backEnd/routes_admin.py#L798)).
- L'**affichage** reste inchangé partout où il existe déjà : la liste admin des joueurs
  ([routes_admin.py:760-775](../backEnd/routes_admin.py#L760-L775)), la fiche joueur publique
  ([routes_public.py:1209](../backEnd/routes_public.py#L1209)) et le badge
  « Absent.e depuis N tournois » de
  [stats_joueur.html:148](../frontEnd/templates/stats_joueur.html#L148) continuent d'exposer la
  valeur. C'est une information utile à consulter, elle ne doit simplement plus être modifiable.

**Emplacements exacts à modifier** (relevés le 15/09) :

| Fichier | Quoi |
|---|---|
| [routes_admin.py:793](../backEnd/routes_admin.py#L793) | retirer la lecture `int(data.get('consecutive_missed', 0))` |
| [routes_admin.py:798](../backEnd/routes_admin.py#L798) | retirer `consecutive_missed=%s` de l'`UPDATE` et son paramètre |
| [gestion.js:412](../frontEnd/static/js/gestion.js#L412) | retirer `consecutive_missed` du payload envoyé |
| [gestion.js:237](../frontEnd/static/js/gestion.js#L237) | retirer l'argument passé à `openEditModal` |
| modale d'édition (`editMissed`) | retirer le champ de saisie ; le remplacer par un affichage en lecture seule si on veut garder l'info visible dans la modale |

⚠️ Noter le libellé actuel du badge : « Absent.e depuis N **tournois** ». Avec la décision 7, la
valeur comptera des **sessions** — le libellé reste « tournois » côté affichage (décision 7), donc
rien à changer, mais c'est exactement le genre d'endroit où la distinction calcul/affichage doit
être respectée consciemment.

**Conséquence** : le compteur redevient une valeur **exclusivement dérivée du calcul** (ajout,
annulation, fusion), ce qui est la condition pour qu'il puisse servir de déclencheur fiable à la
pénalité. La décision 8 s'appuie donc bien sur `consecutive_missed`, sans compteur dédié
supplémentaire.

⚠️ **À vérifier à l'implémentation** : si un admin avait besoin de corriger un compteur faussé (par
exemple une dérive héritée du bug d'avant la Phase 0), il n'aura plus de geste pour le faire. Le
chemin de correction devient : annuler/ré-ajouter un tournoi, ou une requête SQL manuelle. C'est
assumé — le champ éditable était précisément ce qui rendait le compteur non fiable. À garder en tête
si une correction ponctuelle devient nécessaire en prod.

**Ce point est un changement de périmètre** : retirer le champ éditable n'était pas dans le plan
initial et touche une route (`PUT /admin/joueurs/<id>`) et un template d'édition qui n'étaient pas
listés. Petit travail, mais à ne pas oublier — il conditionne la validité de la décision 8.

### 13.3 ✅ F-3 — Perte de la notion de temps écoulé : **comportement voulu, confirmé le 15/09**

> **Tranché par l'utilisateur (15/09) : « c'est voulu ».** La pénalité sanctionne le fait de louper
> des occasions de jeu, pas l'écoulement du calendrier. Une période sans session ne pénalise
> personne — c'est le comportement souhaité, pas un effet de bord. Rien à corriger.
>
> **Reste uniquement à faire** : choisir les valeurs par défaut des deux nouveaux réglages (voir le
> dernier point ci-dessous), puisqu'elles ne se déduisent pas des anciennes.

Point de conception assumé, pas un bug : passer des jours aux sessions **supprime toute notion
de temps réel** du déclenchement.

Aujourd'hui, un joueur absent pendant 3 mois est pénalisé même si aucun tournoi n'a eu lieu entre
temps (le délai en jours court tout seul). Avec la décision 8, **s'il n'y a pas de session, il n'y a
pas de pénalité** : un joueur qui disparaît pendant six mois de vacances collectives ne prend rien,
puis prend sa première pénalité à la 2e session de la reprise.

C'est *l'effet voulu* (confirmé le 15/09), et c'est plus juste que le système actuel. Deux
conséquences à connaître :

- **Une saison morte ne pénalise plus personne.** ✅ Souhaité. Pas de décote d'inactivité pure à
  réintroduire.
- **Le réglage n'est plus comparable à l'ancien.** `ghost_threshold_days = 14` ne se convertit pas
  en un nombre de sessions sans connaître la fréquence de jeu. Le §5.4 le dit déjà (« pas de
  conversion automatique fiable »), mais il faut **choisir les nouvelles valeurs par défaut avec
  l'utilisateur** : au rythme observé (1 session/semaine, cf §7.2), `ghost_threshold_days = 14`
  correspond à peu près à `ghost_threshold_sessions = 2`.

### 13.4bis ℹ️ Rappel — où se trouve la fonctionnalité d'annulation (question du 15/09)

L'utilisateur indiquait le 15/09 ne pas avoir connaissance de cette fonctionnalité. **Elle existe
bien, elle est active et exposée dans l'interface** — voici son inventaire exact, utile pour la
Phase 4 :

| Élément | Emplacement |
|---|---|
| **Bouton « Annuler le dernier tournoi »** | Page **Gestion tournois** (`add_tournament.html`), bloc rouge `#bloc-annuler-tournoi`, [add_tournament.html:146-179](../frontEnd/templates/add_tournament.html#L146-L179) |
| Visibilité | **Chef admin et superadmin uniquement** (`{% if role_admin in ('chef_admin', 'superadmin') %}`) — capacité de rôle, pas une permission déléguable |
| Appel JS | `revertLastTournament()` → `fetch('/admin/revert_last')` ([add_tournament.html:258](../frontEnd/templates/add_tournament.html#L258)) |
| Route backend | `POST /api/admin/revert-last-tournament` → `revert_last_tournament()` ([routes_admin.py:1714-1716](../backEnd/routes_admin.py#L1714)), `@role_required(ROLE_CHEF_ADMIN)` |
| Seconde route | `delete_tournament(id)` ([routes_admin.py:1776](../backEnd/routes_admin.py#L1776)) — **pas exposée dans l'UI** ; la liste des tournois est en lecture seule, un tournoi ancien ne peut pas être supprimé depuis l'interface |

Le bouton a été **déplacé de la navbar vers cette page** (commentaire à
[add_tournament.html:146-150](../frontEnd/templates/add_tournament.html#L146-L150)) précisément
parce qu'un geste irréversible accessible partout invitait au clic accidentel. Il est marqué
« Irréversible » et annonce qu'il « restaure les scores des joueurs tels qu'ils étaient avant ».

C'est **cette route** que la Phase 0 a corrigée (§2), et c'est elle qui est concernée par F-4
ci-dessous. Bon à savoir : `delete_tournament` existe en backend mais sans porte d'entrée UI — donc
en pratique, seul « annuler le dernier » est déclenchable par un humain aujourd'hui.

### 13.4 🟠 F-4 — `ghost_log` devient un journal sans rôle de décision, mais `annuler_absences` en dépend

Le §5.4 annonce que `ghost_log` « n'est plus consulté pour décider du déclenchement ». C'est vrai
pour `add_tournament`, mais il faut vérifier que rien d'autre ne s'appuie sur `last_ghost` pour
décider quoi que ce soit — et surtout que la suppression des requêtes `last_played`/`last_ghost` ne
casse pas la restauration.

`annuler_absences` (livrée en Phase 0) décrémente `consecutive_missed` **sans toucher à `sigma`** :
la restauration du sigma après pénalité se fait ailleurs, depuis `ghost_log.old_sigma`. Avec la
décision 8, la pénalité et le compteur deviennent **couplés** (le compteur décide de la pénalité).
Donc décrémenter le compteur sans annuler la pénalité de sigma correspondante crée une
désynchronisation : au tournoi suivant, le même palier peut être franchi une seconde fois et
appliquer **deux fois** la même pénalité.

**À vérifier explicitement en Phase 3** : que `annuler_absences` et `fusionner_sessions` remettent
le compteur *et* le sigma dans un état cohérent, avec un test qui enchaîne
ajout → pénalité → annulation → ré-ajout et vérifie que le sigma final est identique à un simple
ajout. Ce test n'existe pas et c'est exactement le scénario où le couplage mord.

### 13.5 🟡 F-5 — Les chiffres de vérification du backfill sont périmés

Le §11.3 donne comme contrôles attendus « 89 sessions / 92 tournois », calibrés sur
`dumps/dump_2026-09-03_1119.sql`. **Le dépôt contient depuis des dumps plus récents**
(`dump_2026-09-14.sql`, `dump_2026-09-15.sql`, `dump_2026-09-15_admin.sql`).

**Dump de référence — décision de l'utilisateur (15/09) : se fier à
`dumps/dump_2026-09-15_admin.sql`**, le plus récent. Tous les chiffres du plan doivent être
recalibrés dessus ; ceux du §11.3 (calibrés sur le 03/09) sont périmés.

Recalcul complet sur `dumps/dump_2026-09-15_admin.sql` :

| Contrôle | Valeur au 03/09 (plan) | **Valeur de référence (09-15_admin)** |
|---|---|---|
| Tournois | 92 | **96** |
| Groupes `(date, ligue_id)` → **sessions attendues** | 89 | **93** |
| Sessions à 2 tournois | 3 | **3** (inchangé) |
| Sessions à 1 tournoi | 86 | **90** |
| Joueurs | 39 | **41** |
| Participations | 620 | **658** |
| Lignes `ghost_log` | 128 | **151** |
| Joueurs présents 2× dans une même session | — | **0** (invariant de la décision 9 déjà respecté) |

Ces valeurs remplacent celles du §11.3 et du §10.2 comme référence de contrôle du backfill. Elles
restent à revérifier au moment réel de la migration si la prod a encore évolué.

À noter : les IDs de tournois présentent un **trou** (97 puis 100, les 98 et 99 manquent — des
annulations, cf §13.4bis). Le backfill par `MIN(id)` n'en souffre pas, mais ça confirme qu'il ne faut
jamais déduire un nombre de tournois d'un `MAX(id)`.

### 13.6 🟡 F-6 — Les références de lignes du plan ont dérivé

Plusieurs renvois du plan ne pointent plus au bon endroit, ce qui fera perdre du temps en
implémentation :

| Le plan dit | Réalité dans le code |
|---|---|
| `services.py:833` (`session_keys`) | **[services.py:929](../backEnd/services.py#L929)** |
| `services.py:506` (`compute_ip_evolution`) | **[services.py:602](../backEnd/services.py#L602)** |
| `services.py:651` (`compute_position_evolution`) | **[services.py:747](../backEnd/services.py#L747)** |
| `services.py:813-833` (bloc `session_keys`) | **[services.py:908-930](../backEnd/services.py#L908-L930)** |
| `routes_admin.py:1281-1301` (bloc pénalité, §0) | **[routes_admin.py:1634-1654](../backEnd/routes_admin.py#L1634-L1654)** |
| `routes_admin.py:1393` (UPDATE global) | corrigé en Phase 0 — la ligne n'existe plus |
| `services.py:182-193` (`sync_sequences`) | à revérifier, le fichier a grossi |

Le décalage vient des livraisons du 14/09 (Phase 0, tiers dynamiques). **À traiter comme une dette
de doc** : rafraîchir ces renvois au début de la Phase 3, ou mieux, citer les noms de fonctions
plutôt que les numéros de ligne — ce qui ne dérive pas.

### 13.7 ✅ Ce qui est solide

Vérifié et confirmé, aucune action requise :

- **La décision 7 est validée par le code** : `total_tournois` regroupe **déjà** par session
  (`session_keys`) et est **déjà** affiché comme un nombre de tournois dans
  `classement_saison.html` et `recap.html`. La décision 7 ne fait qu'expliciter et généraliser un
  choix qui est déjà celui du code — c'est le signe d'une décision juste. (Sous réserve de F-1, qui
  porte sur le numérateur, pas sur ce principe.)
- **L'invariant « tout tournoi porte une session »** (décision 3) élimine réellement toute branche
  « sans session » du code de calcul. Vérifié : le backfill le garantit, le `NOT NULL` le verrouille,
  et `add_tournament` crée la session en même temps que le tournoi. Solide.
- **Le backfill est idempotent et rejouable** (`ON CONFLICT DO NOTHING` + `WHERE session_id IS NULL`),
  et le `setval` après INSERT à id explicite est correctement identifié comme indispensable. C'est le
  piège classique de ce genre de migration, et il est désamorcé.
- **La Phase 0 est réellement livrée et mord** : validation par mutation (17 assertions sur 33
  tombent si on réintroduit le bug) + deux garde-fous statiques contre la régression. C'est de la
  bonne discipline de test.
- **L'ordre des phases est correct** : 1/2/5 sans effet sur les valeurs de classement, Phase 3
  isolée en fin de chaîne avec dump de sauvegarde. La réversibilité par phase (§12) est honnête sur
  ce qui ne se rembobine pas.
- **Le mode ligue de la landing page** (option 1, §7.3) : garder la branche `DISTINCT ON (ligue_nom)`
  telle quelle est le bon choix, son intention (« où en est chaque ligue ») n'est pas modélisable par
  une session. Confirmé par la décision de l'utilisateur du 15/09.
- **R-session-7** (notification orpheline après annulation) est correctement isolé comme un chantier
  indépendant, avec une recommandation argumentée (option 2 : notifier l'annulation plutôt que
  supprimer la notification). Rien à changer.

### 13.8 État des arbitrages après les réponses du 15/09

| Faille | État | Reste à faire |
|---|---|---|
| **F-1** numérateur/dénominateur | ✅ **Résolu** par la décision 9 (unicité en session) — les deux unités coïncident par construction, aucune valeur affichée ne change | Contrôle d'intégrité post-Phase 1 : `matchs <= total_tournois` pour tous |
| **F-1b** liaison créant un doublon | ✅ **Résolu** — refus catégorique, ni liaison ni création de tournoi | Implémenter le refus dans les deux chemins (création et liaison tardive) |
| **F-1c/d** liaison avant écriture (décision 10) | ✅ **Tranché** — flux inversé, découpage en 2 appels sécurisé | Implémenter selon §13.1bis F-1d. **Désamorce R-session-1 et la limite du §5.2.** |
| **F-2** compteur éditable | ✅ **Résolu** — champ retiré de l'édition, info conservée en affichage | Appliquer les 5 modifications listées au §13.2 |
| **F-2** sémantique en mode ligue | 🟡 À documenter | Libellé du réglage admin doit dire « sessions **qui te concernaient** » en mode ligue |
| **F-3** perte du temps écoulé | ✅ **Voulu**, confirmé | Choisir les valeurs par défaut (≈ `threshold_sessions = 2` au rythme observé) |
| **F-4** couplage compteur/pénalité | 🟠 Ouvert | Écrire le test ajout → pénalité → annulation → ré-ajout **avant** de coder |
| **F-5** chiffres périmés | ✅ **Résolu** — référence = `dump_2026-09-15_admin.sql`, 96 tournois / 93 sessions | Répercuter dans §10.2 et §11.3 |
| **F-6** renvois de lignes dérivés | 🟡 Dette de doc | Rafraîchir, ou citer les noms de fonctions plutôt que les lignes |

**Plus aucune décision en suspens.** Après les réponses du 15/09, il ne reste que du travail
d'implémentation. Le seul point de vigilance technique restant :

- **F-4** — écrire le test de cohérence compteur/sigma sur le cycle
  ajout → pénalité → annulation → ré-ajout **avant** de coupler la pénalité au compteur (Phase 3).

**Ordre de travail recommandé, à jour** :

1. **Phase 1** (schéma + backfill + contrôle d'intégrité décision 9) — sans risque, rien ne change
   fonctionnellement.
2. **Phase 2** (liaison avant création, décision 10 + refus F-1b) — désormais risque moyen car elle
   touche `add_tournament` ; à faire avec le découpage en deux appels du §13.1bis F-1d.
3. **Phase 5** (landing page) — indépendante, sans risque.
4. **Phase 3** (bascule pénalité + seuils en sessions + comptage saison) — après le test F-4 et avec
   un dump de sauvegarde. Nettement simplifiée par la décision 10.
5. **Phase 4** (annulation/orphelines).

---

## 14. Clarification du 15/09 — les tournois de ligue ne partagent jamais une session

> **Question de l'utilisateur** : « les tournois de ligue ne sont pas de la même session, ce sont
> plusieurs tournois séparés, ils sont juste gérés différemment pour l'affichage sur la landing page,
> et le comptage en séparant les membres par ligue. Vérifie si tout est propre de ce côté. »
>
> **Réponse : oui, tout est propre.** La règle de backfill du plan (`GROUP BY date, ligue_id`) est
> exactement celle-ci, et les trois mécanismes concernés sont cohérents. Vérifications ci-dessous.

### 14.1 La règle de regroupement est confirmée : `(date, ligue_id)`

Deux tournois ne partagent une session que s'ils ont **la même date ET la même ligue**. Un tournoi de
Ligue 0 et un tournoi de Ligue 1 le même jour sont **deux sessions distinctes** — ce sont deux
occasions de jeu séparées qui se trouvent tomber le même jour.

⚠️ **Ceci écarte définitivement l'hypothèse « GROUP BY date seul »** évoquée en discussion le 15/09,
et **confirme la recommandation du §11.3** (ne pas fusionner 54 et 58 dans la migration). Le §5.3 du
plan, qui présentait la déduplication d'une « soirée multi-ligues » comme un *gain fonctionnel à
venir*, doit être lu avec cette nuance : ce n'est **pas** un objectif du chantier. Une session ne
regroupe que des tournois de même ligue.

**Conséquence sur `sessions` neutre vis-à-vis de la ligue (décision 4)** : la table `sessions` reste
techniquement neutre (aucune colonne `ligue_id`), mais **en pratique une session ne contiendra jamais
que des tournois d'une même ligue**, puisque c'est la règle de création comme de backfill. La
neutralité du schéma est une simplicité de conception, pas une invitation à mélanger les ligues.

### 14.2 Vérification sur les données réelles (`dump_2026-09-15_admin.sql`)

**Répartition des 96 tournois** :

| `ligue_id` | Tournois | Remarque |
|---|---|---|
| NULL | **69** | mode ligue inactif — tous les tournois récents |
| 1 (« Ligue 0 ») | 13 | mars → juin 2026 |
| 2 (« Ligue 1 ») | 14 | mars → juin 2026 |

**Résultat du backfill `(date, ligue_id)`** : **93 sessions pour 96 tournois**.

| Contrôle | Valeur |
|---|---|
| Sessions à 1 tournoi | **90** |
| Sessions à 2 tournois | **3** — et ce sont bien les 3 vraies paires multi-lobbies |
| Sessions à 3+ tournois | **0** |

Les 3 seules sessions multi-tournois sont **2026-06-29**, **2026-07-13** et **2026-07-20**, toutes
en `ligue_id = NULL`. ✅ Conforme à la règle : aucune session ne mélange deux ligues.

**Le cas 2026-03-02 (tournois 54 + 58)** est le **seul jour de tout l'historique** où deux ligues ont
joué à la même date. Partout ailleurs, les deux ligues **alternent** (Ligue 1 le lundi, Ligue 0 le
mercredi), donc elles tombent déjà sur des dates distinctes :

```
64 | 2026-03-23 | Ligue 1      68 | 2026-04-06 | Ligue 1
65 | 2026-03-25 | Ligue 0      69 | 2026-04-08 | Ligue 0
66 | 2026-03-30 | Ligue 1      70 | 2026-04-13 | Ligue 1
67 | 2026-04-01 | Ligue 0      71 | 2026-04-15 | Ligue 0
```

Avec la règle `(date, ligue_id)`, 54 et 58 restent **deux sessions séparées** — ce qui est le
comportement voulu, et ce qui **reproduit l'historique à l'identique** (aucune pénalité passée n'est
réinterprétée). Rien à corriger à la main.

### 14.3 Mécanisme 1 — l'affichage sur la landing page : ✅ propre

`GET /dernier-tournoi` ([routes_public.py:475-557](../backEnd/routes_public.py#L475-L557)) a bien
deux branches indépendantes, et **seule la branche standard change** (option 1 du §7.3) :

| Branche | Condition | Regroupement | Phase 5 |
|---|---|---|---|
| **ligue** | le dernier tournoi porte une ligue ≠ Mixte | `DISTINCT ON (t.ligue_nom)` — le dernier tournoi **de chaque ligue**, sans contrainte de date ([:496-504](../backEnd/routes_public.py#L496-L504)) | ❌ **inchangée** |
| **standard** | dernier tournoi sans ligue ou Mixte | `date_trunc('week', ...)` ([:521-530](../backEnd/routes_public.py#L521-L530)) | ✅ bascule sur `session_id` |

C'est exactement la séparation que décrit l'utilisateur : les tournois de ligue sont « gérés
différemment pour l'affichage ». La branche ligue affiche une **vitrine par ligue** (« où en est
chaque ligue »), pas une occasion de jeu — une session ne peut pas modéliser ça, et on n'y touche
pas.

✅ **Vérifié, et c'est ce qui rend la Phase 5 sûre** : la branche standard filtre déjà sur
`ligue_id IS NULL AND (ligue_nom IS NULL OR ligue_nom = 'Mixte')`. Puisque le backfill garantit
qu'une session ne contient que des tournois de même ligue, remplacer `date_trunc('week', ...)` par
`t.session_id = <session du dernier tournoi>` **ne peut pas faire entrer un tournoi de ligue** dans
cette branche. Les deux filtres sont cohérents, il n'y a pas de fuite possible entre les branches.

⚠️ **Un détail à ne pas rater en Phase 5** : le filtre `ligue_id IS NULL AND ...` devient
*redondant* avec le filtre par session, mais **le garder** — il documente l'intention de la branche
et protège si une session venait un jour à mélanger des ligues. Le supprimer serait une
« simplification » qui retire un garde-fou.

### 14.4 Mécanisme 2 — le comptage en séparant les membres par ligue : ✅ propre, avec une nuance

Le filtrage par ligue du calcul de pénalité ([routes_admin.py:1628-1632](../backEnd/routes_admin.py#L1628-L1632))
reste **entièrement inchangé** par ce chantier :

```python
absents = [row for row in all_absents
           if ligue_id is None or last_played_ligue.get(row[0]) == int(ligue_id)]
```

La décision 4 le dit déjà : « la règle d'absence continue de filtrer par ligue *à l'intérieur* de la
session ». Avec la clarification du 15/09, ce filtre devient même **plus simple à raisonner** :
puisqu'une session ne contient que des tournois d'une seule ligue, le filtre par ligue et le filtre
par session ne peuvent pas se contredire. ✅

**La nuance, déjà consignée en F-2 (§13.2)** : ce filtrage fait que `consecutive_missed` compte « les
sessions **de ma ligue** que j'ai loupées », pas les sessions dans l'absolu. C'est cohérent avec ce
que décrit l'utilisateur (« le comptage en séparant les membres par ligue »), et c'est le
comportement voulu — mais le libellé du réglage `ghost_threshold_sessions` côté admin doit le dire,
sinon on croit compter toutes les sessions.

### 14.5 Mécanisme 3 — le comptage saison/recaps : ✅ déjà correct

`session_keys` ([services.py:918](../backEnd/services.py#L918)) regroupe **déjà** par
`(date, ligue_id)` :

```python
session_keys[tid] = (row[7], row[10])   # (date, ligue_id)
```

C'est **exactement** la règle confirmée par l'utilisateur. La Phase 3 ne change donc pas la
sémantique de ce comptage — elle remplace une clé calculée `(date, ligue_id)` par une lecture directe
de `session_id`, qui produit **le même regroupement** puisque le backfill utilise la même clé. ✅

C'est une excellente nouvelle pour le risque de la Phase 3 : le basculement de `session_keys` sur
`session_id` est un **refactor à résultat identique**, vérifiable en comparant les deux valeurs avant
/après sur la base migrée (`len(set(session_keys.values()))` doit égaler
`COUNT(DISTINCT session_id)` sur le même périmètre).

### 14.6 Verdict

**Tout est propre de ce côté.** Aucune contradiction trouvée entre la clarification de l'utilisateur
et le plan tel qu'écrit. Trois points sont même *renforcés* par cette clarification :

1. **Le backfill du §11.2 est validé tel quel** — `GROUP BY date, ligue_id`, sans modification, et le
   cas 54/58 se règle tout seul (deux sessions, comme aujourd'hui). **Rien à éditer à la main.**
2. **La Phase 5 est sûre** : les deux branches de la landing page restent étanches (§15.3).
3. **La Phase 3 perd du risque** : le basculement de `session_keys` est un refactor à résultat
   identique, pas un changement de règle (§15.5).

⚠️ **Le seul point de doc à corriger** : le §5.3 (« Un cas qui devient correct et ne l'est pas
aujourd'hui ») présente la déduplication d'une soirée multi-ligues comme un gain à venir. **Ce n'est
pas un objectif** — les tournois de ligue restent des sessions séparées. Section à amender pour ne
pas induire en erreur un lecteur futur.

---

## 15. Seconde passe d'audit (15/09) — faisabilité des décisions 9 et 10

> Relecture ciblée **des ajouts du 15/09 eux-mêmes**, vérifiés contre le code. Les décisions 9 et 10
> étant nées dans la journée, elles n'avaient pas encore subi l'épreuve que le reste du plan a subie.
> **Cinq nouvelles failles (F-7 à F-11)**, dont une dans le code que j'ai moi-même proposé.

### 15.1 🔴 F-7 — Le SQL de vérification de conflit proposé au §13.1bis F-1d est faux

**Le nouveau tournoi se détecte lui-même comme conflit.** La requête proposée sélectionne les joueurs
présents dans « la session de `autre_tournoi_id` » et les intersecte avec les participants du nouveau
tournoi. Mais selon l'ordre d'exécution, le nouveau tournoi **appartient déjà à cette session** au
moment du contrôle (c'est tout l'objet de la liaison) : ses propres joueurs remontent alors comme
conflits, et **toute liaison est refusée**.

C'est une erreur classique d'ensemble mal borné, et elle est silencieuse au pire endroit : elle ne
plante pas, elle refuse tout. Un test naïf « je lie deux tournois sans joueur commun » échouerait
sans qu'on comprenne pourquoi.

**Version corrigée** — exclure explicitement le tournoi courant :

```python
if autre_tournoi_id is not None:
    cur.execute("""
        SELECT DISTINCT j.nom
        FROM Participations p
        JOIN Joueurs j   ON j.id = p.joueur_id
        JOIN Tournois t   ON t.id = p.tournoi_id
        WHERE t.session_id = (SELECT session_id FROM Tournois WHERE id = %s)
          AND t.id <> %s                       -- <<< exclut le tournoi courant
          AND p.joueur_id IN (SELECT joueur_id FROM Participations
                              WHERE tournoi_id = %s)
        ORDER BY j.nom
        LIMIT 5
    """, (autre_tournoi_id, tournoi_id, tournoi_id))
```

Trois corrections par rapport à ma version initiale : le `t.id <> %s` (la faille), le `DISTINCT`
(sans lui un joueur présent dans deux tournois de la session cible apparaît deux fois dans le
message), et l'`ORDER BY` (un message d'erreur dont l'ordre varie est pénible à tester).

⚠️ **Le `LIMIT 5` est un choix d'affichage, pas de logique** : il borne la longueur du message
d'erreur. Ne pas le confondre avec la détection elle-même — dès qu'**une** ligne remonte, c'est un
refus. Si le test doit vérifier « combien de joueurs en conflit », ne pas s'appuyer sur cette
requête.

### 15.2 🔴 F-8 — L'ordre « créer la session, puis vérifier » n'est pas spécifié, et il détermine tout

Le plan dit « après l'INSERT des participations, avant le calcul TrueSkill », mais **ne dit pas à
quel moment le rattachement à la session cible a lieu** — or c'est ce qui décide si F-7 se produit
et si le contrôle a un sens.

Deux ordres possibles, aux conséquences très différentes :

| Ordre | Séquence | Verdict |
|---|---|---|
| **A — fusionner puis vérifier** | INSERT tournoi (session neuve) → INSERT participations → fusion vers la session cible → contrôle de conflit | ❌ **C'est ce qui provoque F-7.** Le contrôle doit alors exclure le tournoi courant, et la fusion doit être défaite si refus (elle l'est par le rollback, mais c'est du travail pour rien). |
| **B — vérifier puis fusionner** (recommandé) | INSERT tournoi (session neuve) → INSERT participations → **contrôle de conflit contre la session cible** → fusion seulement si OK → calcul | ✅ Le tournoi courant n'est pas encore dans la session cible : le contrôle est naturellement correct, sans clause d'exclusion. Le `t.id <> %s` de F-7 devient une ceinture de sécurité redondante plutôt que la condition de correction. |

**Recommandation : ordre B, explicitement écrit dans le code avec un commentaire.** C'est le seul qui
rende le contrôle correct *par construction* plutôt que par une clause qu'on peut oublier. Et il
évite de faire puis défaire une fusion.

**À spécifier dans la Phase 2** : la séquence exacte, dans cet ordre, avec le contrôle **entre** les
participations et la fusion. C'est le genre de détail qui se perd entre le plan et
l'implémentation — et ici, s'il se perd, le résultat est « toute liaison refusée ».

### 15.3 🟠 F-9 — Le contrôle ne couvre pas la liaison transitive

Le §3.3 vante la fusion transitive : « rien n'empêche l'admin de lier A↔B un jour puis B↔C un autre
jour — la fusion transitive se fait toute seule, sans cas particulier à écrire. » **Avec la décision
9, ce n'est plus vrai sans précaution.**

Scénario : sessions `{A, B}` et `{C}`. L'admin lie C à B. Le contrôle doit vérifier que les joueurs
de C ne sont **ni dans B, ni dans A** — c'est-à-dire contre **toute la session cible**, pas contre le
seul tournoi désigné.

✅ **Bonne nouvelle : le SQL corrigé en F-7 le fait déjà** — il filtre sur
`t.session_id = (SELECT session_id FROM Tournois WHERE id = %s)`, donc sur toute la session, pas sur
le seul `autre_tournoi_id`. C'était le bon réflexe. **Mais il faut le dire explicitement**, sinon une
réimplémentation « simplifiée » en `WHERE t.id = autre_tournoi_id` passerait les tests évidents et
laisserait le trou transitif.

⚠️ **Symétrie manquante** : le contrôle vérifie « les joueurs du nouveau tournoi sont-ils dans la
session cible ». Pour la **liaison tardive** (fusion de deux sessions déjà peuplées), il faut
vérifier dans les **deux sens** : aucun joueur commun entre l'union des deux sessions. Le SQL de
F-7 ne suffit pas là — `fusionner_sessions` a besoin de sa propre requête :

```sql
-- Conflit si un joueur participe a un tournoi de S_A ET a un tournoi de S_B.
SELECT DISTINCT j.nom
FROM Participations pa JOIN Tournois ta ON ta.id = pa.tournoi_id
JOIN Participations pb ON pb.joueur_id = pa.joueur_id
JOIN Tournois tb ON tb.id = pb.tournoi_id
JOIN Joueurs j ON j.id = pa.joueur_id
WHERE ta.session_id = %s AND tb.session_id = %s
ORDER BY j.nom;
```

À écrire **une fois**, dans `fusionner_sessions`, et à réutiliser depuis les deux chemins plutôt que
de maintenir deux requêtes divergentes (la leçon de la Phase 0 : `revert_last_tournament` et
`delete_tournament` avaient divergé exactement comme ça, §2.1).

### 15.4 🟠 F-10 — L'étape 1 ne peut pas vérifier les joueurs inconnus, et le plan le laisse croire

L'étape 1 (`POST /admin/tournois/verifier-session`) reçoit `joueurs: [...]` sous forme de **noms** et
doit marquer les candidats « liables ou non ». Mais **un nom saisi peut ne correspondre à aucune
fiche** : `add_tournament` crée les joueurs à la volée
([routes_admin.py:1523](../backEnd/routes_admin.py#L1523)).

Conséquences :

- Un joueur inconnu ne peut pas être en conflit (il n'a aucune participation) — donc l'étape 1 peut
  l'ignorer sans risque de faux négatif. ✅
- **Mais l'étape 1 ne doit surtout pas créer ces fiches** pour pouvoir comparer des ids. Elle est
  déclarée « lecture seule » et doit le rester — sinon un admin qui ouvre la modale puis annule
  laisse des fiches joueurs orphelines derrière lui. ⚠️
- La comparaison à l'étape 1 se fait donc **sur les noms** (`WHERE j.nom = ANY(%s)`), ce qui est
  acceptable *pour un affichage indicatif*, mais c'est exactement le motif que le plan condamne
  ailleurs (§8, R-session-7 : « ne pas s'accrocher au titre »).

**Résolution** : assumer explicitement que l'étape 1 est **indicative et travaille sur les noms**,
tandis que l'étape 2 est **autoritaire et travaille sur les ids**. Ce n'est pas une incohérence si
c'est écrit ; ça en devient une si quelqu'un croit plus tard que l'étape 1 garantit quelque chose.
À documenter en commentaire dans les deux routes.

⚠️ **Piège de casse/espaces** : `add_tournament` résout les noms par `WHERE nom = %s` (égalité
stricte) mais teste les noms interdits sur `nom.strip().lower()`
([routes_admin.py:1496](../backEnd/routes_admin.py#L1496)). L'étape 1 doit utiliser **la même
normalisation que l'étape 2**, sinon un nom saisi avec une majuscule différente serait « inconnu »
à l'étape 1 et « connu » à l'étape 2 — donc un conflit invisible dans la modale et un refus
surprise à la validation.

### 15.5 🟡 F-11 — Le rollback dépend d'un comportement implicite du pool

`get_db_connection` ([db.py:38-43](../backEnd/db.py#L38-L43)) rend la connexion au pool en `finally`
**sans rollback explicite** :

```python
conn = db_pool.getconn()
try:
    yield conn
finally:
    db_pool.putconn(conn)
```

psycopg2 émet un rollback implicite quand une connexion non commitée retourne au pool, donc le
comportement actuel est correct. **Mais la décision 10 ajoute un chemin de refus qui repose
entièrement sur ce mécanisme**, ce qui mérite d'être explicite plutôt qu'implicite.

Le code existant appelle déjà `conn.rollback()` explicitement avant chaque `return` de refus
(nom anonymisé [:1499](../backEnd/routes_admin.py#L1499), joueur inconnu
[:1515](../backEnd/routes_admin.py#L1515)) — **suivre ce motif**, ne pas se contenter du rollback
implicite du pool. Faible risque, mais c'est gratuit à faire correctement.

✅ **Testable sans Postgres** : le harness trace déjà `rolledback`
([tests/harness.py:68-71](../backEnd/tests/harness.py#L68-L71)), donc le test « un refus de liaison
appelle bien rollback et ne commit pas » s'écrit dans l'outillage existant. Pas besoin d'une base
pour couvrir le cas le plus important de la décision 10.

### 15.6 ✅ Ce qui résiste à la seconde passe

- **La décision 10 est réellement un gain, pas un déplacement de problème.** Vérifié : la route est
  déjà transactionnelle avec des refus par `rollback` + `409` en place, donc le « refus sans création »
  s'appuie sur un motif existant et sur une garantie Postgres, pas sur du code nouveau.
- **Le découpage en deux appels sans état serveur est le bon choix.** Aucune alternative examinée
  (brouillon en base, transaction longue, jeton de session) n'évite d'introduire un état à nettoyer.
- **La décision 9 est vérifiée sur les données** : 0 violation sur 658 participations. La contrainte
  se pose sans nettoyage, et l'invariant est réel, pas supposé.
- **Le placement du contrôle après résolution des ids** est correct et pour la bonne raison
  (comparer des ids, jamais des chaînes).
- **F-4 reste le seul point non résolu du plan entier**, et il est antérieur à ces décisions.

### 15.7 Synthèse de cette passe

| Faille | Gravité | Nature |
|---|---|---|
| **F-7** SQL de conflit auto-détectant | 🔴 | Bug dans le plan lui-même — corrigé ci-dessus |
| **F-8** ordre fusion/vérification non spécifié | 🔴 | Trou de spécification — **ordre B à écrire dans la Phase 2** |
| **F-9** transitivité + symétrie de la fusion | 🟠 | Couvert par le SQL corrigé, mais à dire explicitement ; `fusionner_sessions` a besoin de sa propre requête |
| **F-10** étape 1 indicative vs étape 2 autoritaire | 🟠 | À documenter ; piège de normalisation des noms |
| **F-11** rollback explicite vs implicite | 🟡 | Suivre le motif existant, testable dans le harness |

**Aucune de ces failles ne remet en cause les décisions 9 et 10** — elles portent toutes sur *comment*
les implémenter. Les deux points à ne pas rater sont **F-8** (l'ordre, sans quoi tout est refusé) et
**F-7** (le SQL, pour la même raison).

---

## 16. ✅ Phase 1 livrée le 2026-09-15

Conforme au plan, avec **un écart de nommage assumé** (voir ci-dessous). **Non commité** —
l'utilisateur commit lui-même ([[user-handles-commits]]).

### 16.1 Ce qui a été livré

| Fichier | Changement |
|---|---|
| `migrations/2026-09-15_sessions_tournois.sql` | **nouveau** — table, colonne, index, backfill, `setval`, `SET NOT NULL`, contrôle d'intégrité de la décision 9 |
| `schema.sql` | `sessions_tournois` (+ séquence) déclarée **avant** `tournois` qui la référence ; `session_id NOT NULL` sur `tournois` ; `idx_tournois_session` ; `DROP` dans le bon ordre |
| `services.py` | **`drop_session_if_orphan(cur, session_id)`** créée à côté de son jumeau `drop_grille_snapshot_if_orphan` (même rôle, même emplacement d'appel) |
| `services.py` | `sync_sequences` : liste extraite en `_TABLES_A_SEQUENCE` + `sessions_tournois` ajoutée ; **`COALESCE(MAX(id), 1)`** corrige un défaut préexistant (`setval(NULL)` sur table vide, avalé en silence) ; échec désormais tracé par `logger.warning` |
| `routes_admin.py` | `add_tournament` ouvre une session avant l'INSERT du tournoi et la lui passe |
| `routes_admin.py` | `revert_last_tournament` + `delete_tournament` lisent `session_id` **avant** le DELETE et appellent `drop_session_if_orphan` |
| `docker-compose.dump.yml` | migration montée en `15_sessions_tournois.sql` (exigé par `test_migrations_montees`) |
| `scripts/verifier-schema-dump.sql` | `sessions_tournois` ajoutée aux tables attendues + 2 contrôles dédiés (colonne présente, aucun tournoi sans session) |
| `tests/test_sessions_tournois.py` | **nouveau**, 38 assertions |
| `tests/test_annulation_tournoi.py` | motifs scriptés mis à jour (les `SELECT` des deux routes ont gagné `session_id`) |

### 16.2 Écart assumé : la table s'appelle `sessions_tournois`, pas `sessions`

Le plan (§3.1) écrivait `CREATE TABLE sessions`. **Renommée en `sessions_tournois`** parce que
`sessions_joueurs` existe déjà et porte les sessions d'**authentification**. Deux concepts sans
aucun rapport ; une table `sessions` tout court aurait été lue comme « les sessions de connexion »
par quiconque ouvre le schéma. Le nom est ce qu'on lit le plus souvent — il doit lever l'ambiguïté,
pas la créer. Une assertion du test verrouille ce choix.

### 16.3 Validation

**Suite de tests** : `38/38` sur le nouveau fichier, `33/33` sur `test_annulation_tournoi` après mise
à jour. Les 3 fichiers en échec (`test_auth`, `test_liaisons`, `test_profils`) **échouaient déjà à
HEAD** — vérifié sur une copie propre du dépôt, aucun lien avec cette phase.

**Validation par mutation** — le test mord réellement :

| Mutation introduite | Assertions tombées |
|---|---|
| `add_tournament` n'ouvre plus de session | **6** |
| `drop_session_if_orphan` perd son garde (supprime toujours) | **1** |
| Backfill regroupé par `date` seule au lieu de `(date, ligue_id)` | **2** |

**Résultat du backfill simulé sur `dumps/dump_2026-09-15_admin.sql`** (logique exacte de la migration
rejouée hors Postgres) :

| Contrôle | Attendu (plan) | **Obtenu** |
|---|---|---|
| Tournois | 96 | **96** ✅ |
| Sessions créées | 93 | **93** ✅ |
| Tournois sans session | 0 | **0** ✅ |
| Sessions à 1 tournoi | 90 | **90** ✅ |
| Sessions à 2 tournois | 3 | **3** ✅ (90/91, 93/94, 95/96) |
| Joueurs 2× dans une session | 0 | **0** ✅ |
| Tournois 54 et 58 | 2 sessions distinctes | **sessions 54 et 58** ✅ |
| `setval` après backfill | — | **106** → prochaine session : 107 |

### 16.4 ⚠️ Reste à faire avant de considérer la phase close

**La vérification sur une vraie base Postgres n'a pas pu être faite** : ni `psql` ni `docker` n'étaient
disponibles dans l'environnement de développement. Le banc d'essai neutralise `psycopg2` et **ne
valide pas le SQL** (§10.5) — la simulation ci-dessus valide la *logique* du regroupement, pas la
syntaxe ni les contraintes.

À faire avant la Phase 2, sur une copie locale non versionnée du dump (R-session-4) :

```bash
make redump DUMP_FILE=./dumps/dump_2026-09-15_admin.sql   # ou equivalent local
```

Puis vérifier :

```sql
SELECT count(*) FROM sessions_tournois;                        -- 93
SELECT count(*) FROM tournois WHERE session_id IS NULL;        -- 0
SELECT count(*) FROM (SELECT session_id FROM tournois
                      GROUP BY session_id HAVING count(*) > 1) x;   -- 3
SELECT last_value FROM sessions_tournois_id_seq;               -- 106
```

Points spécifiques à confirmer, que seule une vraie base peut valider :

1. **Le `SET NOT NULL` passe** (étape 6) — c'est le point de non-retour du §12.3.
2. **Le bloc `DO $$` de l'étape 7 ne lève pas** — sa syntaxe PL/pgSQL n'a pas été exécutée.
3. **Créer un tournoi après migration fonctionne** — c'est le test du `setval` : sans lui,
   `INSERT INTO sessions_tournois DEFAULT VALUES` heurterait la PK 1. **Le vérifier explicitement**,
   c'est le mode d'échec le plus probable et il n'apparaît qu'au tournoi suivant.
4. **Annuler ce tournoi de test** et vérifier que sa session a disparu (`drop_session_if_orphan`).

### 16.5 Note pour la Phase 2

`drop_session_if_orphan` est en place et testée, donc le §6.2 (Phase 4) est **déjà couvert** pour la
partie « session orpheline ». Ce qui reste en Phase 4 relève de la liaison tardive, pas du nettoyage.

Rien dans cette phase ne modifie le calcul : `session_id` est écrite et lue, mais **aucune règle de
pénalité, d'award ou d'affichage ne s'en sert encore**. C'est ce qui rend la Phase 1 réversible par
un simple `DROP COLUMN` + `DROP TABLE` (§12.1).

---

## 17. ✅ Phases 5 et 2 livrées le 2026-09-15

**Non commité** — l'utilisateur commit lui-même ([[user-handles-commits]]).

Livrées dans cet ordre (Phase 5 d'abord, sans risque, pour valider `session_id` en **lecture** avant
de toucher à l'écriture).

### 17.1 Phase 5 — landing page

| Fichier | Changement |
|---|---|
| `routes_public.py` | `/dernier-tournoi` : la requête initiale lit `session_id` au lieu de `date` ; la branche **standard** filtre `AND session_id = %s` au lieu de `date_trunc('week', ...)`. `last_date` disparaît complètement. |

- **Branche ligue inchangée** (`DISTINCT ON (t.ligue_nom)`) : elle affiche « où en est chaque ligue »,
  pas une occasion de jeu — une session ne modélise pas ça (§7.3, option 1).
- **`index.html` inchangé** : le template boucle déjà sur une liste de longueur variable.
- Le filtre `ligue_id IS NULL AND ...` est conservé bien que redondant avec le filtre de session : il
  documente l'intention de la branche et protège si l'invariant « une session = une ligue » changeait.

### 17.2 Phase 2 — liaison avant enregistrement

| Fichier | Changement |
|---|---|
| `services.py` | **`joueurs_en_conflit_de_session`** — conflits entre un tournoi et la session cible (création) |
| `services.py` | **`joueurs_en_conflit_entre_sessions`** — conflits entre deux sessions peuplées (liaison tardive) |
| `services.py` | **`fusionner_sessions`** — garde la session d'id le plus petit, réaffecte, supprime la vidée ; idempotente ; **ne vérifie pas** les conflits (c'est à l'appelant, pour pouvoir refuser sans rien écrire) |
| `services.py` | `MAX_CONFLITS_NOMMES = 5` — borne d'affichage, jamais de détection |
| `routes_admin.py` | `add_tournament` accepte `autre_tournoi_id` ; contrôle + fusion dans l'**ordre B** ; refus par `rollback` + `409` ; renvoie `session_id` |
| `routes_admin.py` | **`POST /admin/tournois/verifier-session`** — étape 1, lecture seule, indicative |
| `routes_admin.py` | **`POST /admin/tournois/<id>/lier-session`** — liaison tardive, même refus, + `invalidate_cache()` |
| `frontend.py` | deux proxies pour les nouvelles routes (pas de proxy générique dans ce projet) |
| `add_tournament.html` | modale `#sessionModal` : s'ouvre après validation, **avant** tout enregistrement ; candidats en conflit **grisés** ; bouton « Tournoi indépendant » ; message de refus distinct qui précise que rien n'a été créé |
| `tests/test_liaison_session.py` | **nouveau**, 57 assertions |

**L'ordre B est respecté et verrouillé par un test** (positions mesurées dans la route) :

```
INSERT tournoi → INSERT participations → CONTRÔLE conflit → FUSION → calcul TrueSkill
```

Contrôler *après* la fusion rendrait le contrôle auto-référent (F-7/F-8) et ferait **refuser toute
liaison**, silencieusement.

### 17.3 Validation

**Tests** : `57/57` (Phase 2), `38/38` (Phase 1), `33/33` (Phase 0). Les 3 fichiers en échec
(`test_auth`, `test_liaisons`, `test_profils`) échouaient **déjà à HEAD** — aucune régression.

**Validation par mutation** — les quatre défauts identifiés à la relecture du plan sont bien attrapés :

| Mutation introduite | Détecté |
|---|---|
| Refus sans `rollback` (le tournoi serait créé malgré le refus) | ✅ |
| Fusion **avant** contrôle (piège F-8 — refuserait tout) | ✅ |
| Contrôle sans `t.id <> %s` (piège F-7 — auto-détection) | ✅ |
| Contrôle sur le seul tournoi désigné (trou transitif F-9) | ✅ |

**Deux erreurs de ma part corrigées en cours de route**, notées pour mémoire :
- le banc d'essai neutralise `trueskill` : il faut un stub `Rating`/`TrueSkill` pour tester
  `add_tournament` (le test de Phase 1 l'évitait en n'atteignant pas le calcul) ;
- `auth.py` commit sa propre transaction (suivi de `last_seen_at`) et partage le faux objet connexion
  du harness : **vérifier `rolledback`, jamais l'absence de `committed`**. En production ce sont deux
  connexions distinctes du pool.

### 17.4 ⚠️ Reste à faire

**Aucune validation sur base Postgres ni navigateur** — ni `psql`, ni `docker`, ni `node` dans
l'environnement. À faire avant de considérer ces phases closes :

1. **Le parcours complet dans le navigateur** : saisir un tournoi → la modale s'ouvre → choisir
   « Tournoi indépendant » → vérifier la création. Puis recommencer en liant à un tournoi récent.
2. **Le refus** : saisir un tournoi avec un joueur déjà présent dans un tournoi cible, tenter la
   liaison, vérifier que le message s'affiche **et qu'aucun tournoi n'a été créé**
   (`SELECT count(*) FROM tournois`).
3. **La landing page** : après un ajout lié, vérifier que les deux cartes s'affichent ; après un
   ajout indépendant, une seule.
4. **La liaison tardive** : lier deux tournois existants, vérifier que la landing page se met à jour
   (test de l'`invalidate_cache`).

### 17.5 Note pour la Phase 3

⚠️ **`lier-session` ne corrige pas encore les pénalités d'absence** (§5.2). C'est correct
aujourd'hui : tant que la Phase 3 n'a pas basculé le calcul sur `session_id`, la pénalité ignore les
sessions, donc il n'y a rien à défaire. **Dès la Phase 3 livrée, cette route devra défaire les
pénalités devenues injustifiées** — sinon lier deux tournois laissera des absences comptées à tort.
Un commentaire dans la route le signale.

Point favorable : la décision 10 fait que le chemin **nominal** (liaison à la création) n'a jamais ce
problème — la session est connue avant le calcul. Seule la liaison tardive est concernée.

---

## 18. ✅ Phase 3 livrée le 2026-09-15

**Non commité** — l'utilisateur commit lui-même ([[user-handles-commits]]).

La phase la plus sensible du chantier : c'est elle qui fait enfin **servir** `session_id` au calcul.
Jusqu'ici la colonne était écrite et lue pour l'affichage, mais aucune règle ne s'en servait.

### 18.1 Les trois bascules

**1. La présence se mesure par session** ([routes_admin.py](../backEnd/routes_admin.py))

Le patch `counted_today` / `same_day_exists` / `present_today_ids` a **disparu**, remplacé par une
seule requête sur `session_id`. Deux requêtes fusionnent en une, et la branche conditionnelle
s'évapore : un ensemble `deja_presents` vide produit exactement le résultat de l'ancien
`same_day_exists = False`.

**2. Le déclenchement se mesure en sessions loupées** (décision 8)

| Avant | Après |
|---|---|
| `ghost_threshold_days = 28` | `ghost_threshold_sessions = 4` |
| `ghost_interval_days = 7` | `ghost_interval_sessions = 1` |
| Écart calendaire depuis `last_played` / `last_ghost` | Palier sur `consecutive_missed` |

Les requêtes `last_played` et `last_ghost` **disparaissent**. `ghost_log` reste le journal
(traçabilité, restauration à l'annulation) mais n'est plus consulté pour *décider*. Seule la ligue de
dernière apparition est encore lue — elle détermine *qui est concerné* en mode ligue, ce qui n'a rien
à voir avec un délai.

Nouvelle fonction pure **`penalite_due(sessions_loupees, seuil, intervalle)`** dans `services.py`,
testée exhaustivement. Valeurs par défaut choisies avec l'utilisateur pour reproduire le
comportement observé (≈1 session/semaine).

**3. Le comptage des awards lit `session_id`** (décision 7)

`session_keys` — le regroupement `(date, ligue_id)` dupliqué hors de `add_tournament` — a disparu.
`total_tournois` compte désormais `len(sessions_vues)`. `t.session_id` est ajoutée **en fin** de
SELECT pour ne décaler aucun index existant.

**C'est un refactor à résultat identique sur l'historique** : le backfill a utilisé la même clé
`(date, ligue_id)`. La différence n'apparaîtra que pour les liaisons futures.

### 18.2 Fichiers touchés

| Fichier | Changement |
|---|---|
| `constants.py` | `DEFAULT_GHOST_THRESHOLD_SESSIONS = 4`, `DEFAULT_GHOST_INTERVAL_SESSIONS = 1` ; les constantes en jours retirées |
| `services.py` | **`penalite_due()`** ; `session_keys` supprimé au profit de `sessions_vues` ; `t.session_id` dans la requête de saison |
| `routes_admin.py` | bloc de pénalité réécrit ; lecture/écriture de config en sessions ; `already_today` → `present_dans_session` |
| `migrations/2026-09-16_penalite_en_sessions.sql` | **nouvelle** — crée les clés en sessions (en **convertissant** la valeur existante ÷ 7), supprime les anciennes, refuse de tourner sans `tournois.session_id` |
| `schema.sql` | seeds de configuration en sessions |
| `admin_reglages.html` | libellés « sessions loupées » + note expliquant ce qu'est une session et qu'une période sans session ne pénalise personne |
| `gestion.js` | champs et payload renommés |
| `docker-compose.dump.yml` | migration montée en `16_` |
| `tests/test_penalite_sessions.py` | **nouveau**, 68 assertions |

### 18.3 Un détail de nommage qui comptait

La migration s'appelle **`2026-09-16`** et non `2026-09-15` : `test_migrations_montees` exige que
l'ordre lexical des noms reproduise l'ordre de dépendance, et
`penalite_en_sessions` < `sessions_tournois` alphabétiquement. Le test a attrapé le conflit
immédiatement — exactement son rôle.

### 18.4 Validation

**68 assertions**, et les trois défauts critiques sont attrapés par mutation :

| Mutation introduite | Détecté |
|---|---|
| Calcul de palier cassé (`return True`) | ✅ 4 assertions |
| **F-4** : compteur décrémenté avant restauration du sigma | ✅ |
| Awards recomptant par tournoi brut | ✅ |

**F-4 est résolu par l'ordre, et cet ordre est verrouillé** : les deux routes d'annulation restaurent
`sigma` depuis `ghost_log.old_sigma` **avant** d'appeler `annuler_absences`. Décrémenter le compteur
sans restaurer le sigma ferait refranchir le même palier au tournoi suivant et appliquerait la
pénalité en double.

Une assertion vérifie aussi que **les présences sont calculées après la fusion de session** — sinon
le calcul lirait la session provisoire et compterait absents les joueurs de l'autre lobby. C'est le
gain de la décision 10 : la pénalité est juste du premier coup, sans correction rétroactive.

Suite complète : `70/70` + les 4 fichiers du chantier (38 + 57 + 68 + 33). Les 3 fichiers en échec
(`test_auth`, `test_liaisons`, `test_profils`) échouaient **déjà à HEAD**.

### 18.5 ⚠️ Reste à faire

**La migration n'a pas encore tourné** :

```bash
make db-migrate FILE=backEnd/migrations/2026-09-16_penalite_en_sessions.sql
```

Puis vérifier :

```sql
SELECT key, value FROM configuration WHERE key LIKE 'ghost%';
-- attendu : ghost_enabled, ghost_penalty,
--           ghost_threshold_sessions = 4, ghost_interval_sessions = 1
--           (et AUCUNE clé en _days)
```

⚠️ **C'est la première phase non réversible** (§12.1) : les sigma et compteurs écrits sous la
nouvelle règle ne se rembobinent pas par un `git revert`. **Prendre un dump avant** de rejouer des
tournois.

À vérifier dans l'interface :

1. **L'écran de réglages** affiche « sessions loupées » avec les bonnes valeurs, et les enregistre.
2. **Le mode ligue** : le libellé ne le dit pas encore, mais `consecutive_missed` compte les sessions
   **de la ligue du joueur** quand le mode ligue est actif (F-2, §13.2). À surveiller si le mode ligue
   est réactivé.
3. **Un cycle complet** : ajouter un tournoi en laissant un joueur absent 4 fois de suite, vérifier
   que la pénalité tombe à la 4ᵉ puis à chaque suivante.

### 18.6 Ce qui reste du chantier

**Phase 4** — largement couverte : `drop_session_if_orphan` est livrée et testée (§16.5). Il ne reste
que **la correction rétroactive des pénalités dans `lier-session`** (§5.2), qui devient maintenant
nécessaire : la Phase 3 étant livrée, lier deux tournois *déjà enregistrés* laisse des absences
comptées à tort. Le chemin nominal (liaison à la création) n'est pas concerné.

C'est le dernier morceau du plan.

---

## 19. ✅ Phase 4 livrée le 2026-09-15 — le plan est complet

**Non commité** — l'utilisateur commit lui-même ([[user-handles-commits]]).

Dernier morceau du chantier : la correction rétroactive des pénalités lors d'une liaison **tardive**.
Le nettoyage des sessions orphelines (`drop_session_if_orphan`) avait été livré dès la Phase 1 (§16).

### 19.1 Le problème traité

Deux tournois enregistrés séparément, puis liés après coup. Au moment de l'ajout du premier, les
joueurs de l'autre lobby n'étaient pas encore saisis : ils ont donc été comptés absents
(`consecutive_missed +1`, parfois une ligne `ghost_log`). Une fois les deux tournois dans la même
session, jouer l'un vaut présence pour toute la session — ces absences n'ont plus lieu d'être.

**Ne concerne que la liaison tardive.** Le chemin nominal (décision 10 : la liaison est demandée
avant l'enregistrement) connaît la session avant de calculer et n'écrit jamais ces pénalités.

### 19.2 Ce qui a été livré

| Fichier | Changement |
|---|---|
| `services.py` | **`annuler_penalites_de_session(cur, session_id, threshold)`** — défait les pénalités des joueurs présents dans la session fusionnée, renvoie la liste des joueurs corrigés |
| `routes_admin.py` | `lier-session` appelle la fonction **après** la fusion, puis `recalculate_tiers()` si des sigma ont bougé ; la réponse expose `penalites_annulees` |
| `tests/test_liaison_session.py` | +20 assertions (77 au total) |

### 19.3 Une décision de conception à connaître

**On retire `penalty_applied`, on ne restaure pas `old_sigma`.**

`old_sigma` est l'état du joueur au moment de cette pénalité précise. Le réécrire écraserait tout ce
qui a bougé depuis : matchs joués, autres pénalités, corrections d'admin. On retire donc exactement
ce que la pénalité avait ajouté — **une soustraction est commutative, une restauration d'état ne
l'est pas.**

Corollaire : le cumul vient de `SUM(g.penalty_applied)` et **jamais** d'une relecture de
`ghost_penalty`. Une pénalité écrêtée par `GHOST_SIGMA_CAP` a ajouté *moins* que le réglage ;
`penalty_applied` porte la valeur réellement appliquée.

Le calcul se fait en Python plutôt que dans un `UPDATE` auto-référent : `SET is_ranked = (...
consecutive_missed ...)` lirait l'ancienne valeur de la colonne — sémantique SQL correcte, mais
piège à la relecture.

### 19.4 Validation

| Mutation introduite | Détecté |
|---|---|
| Le sigma n'est pas décrémenté du cumul | ✅ 2 assertions |
| Correction **avant** la fusion (ne verrait qu'un lobby) | ✅ |

Un cas « rien à défaire » vérifie qu'aucune écriture inutile n'a lieu quand la liaison ne concerne
aucune pénalité.

### 19.5 État final du chantier

| Phase | Statut |
|---|---|
| 0 — correction `revert_last_tournament` | ✅ livrée 14/09 |
| 1 — schéma + backfill | ✅ livrée 15/09, **migration appliquée et vérifiée en base** |
| 2 — liaison avant création + refus | ✅ livrée 15/09, **vérifiée dans l'interface** |
| 3 — bascule du calcul + seuils en sessions | ✅ livrée 15/09, **migration appliquée** |
| 4 — orphelines + correction rétroactive | ✅ livrée 15/09 |
| 5 — landing page | ✅ livrée 15/09 |

**216 assertions** sur les quatre fichiers de test du chantier (38 + 77 + 68 + 33).

### 19.6 ⚠️ Ce qui reste à vérifier en usage réel

Aucun code ne reste à écrire. Restent des vérifications que seule une base réelle permet :

1. **Le cycle de pénalité** : laisser un joueur absent 4 sessions d'affilée, vérifier que la pénalité
   tombe à la 4ᵉ puis à chaque suivante.
2. **F-4 en pratique** : après une pénalité, annuler le tournoi puis le rajouter — le sigma final doit
   être identique à un simple ajout, pas doublement pénalisé.
3. **La liaison tardive** : enregistrer deux tournois séparément (l'un comptant l'autre absent), les
   lier, et vérifier que `penalites_annulees` > 0 et que les sigma sont revenus.

**Prendre un dump avant ces tests** : les Phases 3 et 4 écrivent dans `joueurs.sigma`, qu'un
`git revert` ne rembobine pas (§12.1).

### 19.7 Suites possibles, hors périmètre

- **R-session-7** (§8) : annuler un tournoi laisse sa notification en place. Défaut indépendant,
  recommandation déjà rédigée (émettre une notification d'annulation plutôt que supprimer).
- **[[refactor-historique-recaps-plan]]** : la notion de session est désormais stable, donc R-session-5
  est levé — ce chantier peut être conçu par-dessus.
- **Dé-liaison** d'un tournoi : toujours pas demandée (§9).

---

## 20. 🔧 Correctif du 15/09 — les absences en trop, pas seulement les pénalités de sigma

**Trou trouvé en usage réel par l'utilisateur**, après la livraison du §19. Corrigé le jour même.

### 20.1 Ce qui ne marchait pas

`annuler_penalites_de_session` ne défaisait que les pénalités inscrites dans `ghost_log` — celles
qui avaient modifié un **sigma**. Or dans le cas courant, aucun joueur n'a atteint le seuil : il n'y
a donc **aucune ligne `ghost_log`**, et la fonction concluait « rien à défaire » en laissant les
compteurs d'absence intacts.

Constaté sur la liaison réelle des tournois 108 et 109 :

| Joueur | Situation | Compteur observé | Attendu |
|---|---|---|---|
| Daytona_69, Rayou, Théo, Vakaeltraz | ont joué 108, comptés absents de 109 | **1** | **0** |
| Lu_K | absent des deux, compté 2 fois | **3** | **2** |

Deux violations directes des règles actées :
- **Règle 5** (« jouer un seul tournoi de la session suffit à compter présent ») pour le 1er groupe.
- **Règle « une session manquée = +1 »** pour Lu_K, compté une fois par *tournoi*.

Le plan lui-même portait ce trou : le §5.2 ne décrivait que « les joueurs du lobby A comptés absents
du lobby B », sans traiter l'absent complet compté plusieurs fois.

### 20.2 Le correctif

La fonction raisonne désormais sur les **absences imputables à la session**, pas sur `ghost_log` :

```
a_garder = 0 si le joueur a joué un tournoi de la session, sinon 1
en_trop  = (nb de tournois de la session qu'il n'a pas joués) - a_garder
retrait  = min(max(en_trop, 0), consecutive_missed)
```

Trois garde-fous :

- **`min(..., missed_actuel)`** : ne jamais retirer plus que ce que le joueur porte réellement. Son
  compteur a pu être remis à 0 depuis (il a rejoué), ou ne jamais avoir été incrémenté (hors
  périmètre de ligue).
- **`len(tournois) < 2` → sortie immédiate** : aucune absence ne peut être en trop dans une session
  à un seul élément.
- Les pénalités de sigma restent retirées en plus, par `SUM(penalty_applied)`.

**Approximation assumée** : le nombre d'absences prises *pour cette session* n'est stocké nulle part
(`consecutive_missed` est un cumul). Il est **déduit** du nombre de tournois de la session que le
joueur n'a pas joués. Exact tant que le joueur était dans le périmètre de calcul de chacun ; la
borne `min(...)` protège le cas contraire.

### 20.3 Validation

Vérifié sur les cas réels avant implémentation :

| Joueur | manqués | à garder | en trop | résultat |
|---|---|---|---|---|
| Daytona_69 (a joué 108) | 1 | 0 | 1 | 1 → **0** |
| Astral (a joué 109, déjà à 0) | 1 | 0 | 1 | 0 → **0**, aucune écriture |
| Lu_K (absent des deux) | 2 | 1 | 1 | 3 → **2** |

**80 assertions** sur `test_liaison_session.py`. Mutation : revenir à l'ancien comportement
(pénalités de sigma seulement) fait tomber **6 assertions**.

### 20.4 Leçon

Le plan avait été relu deux fois et audité deux fois, avec 11 failles trouvées — et il portait
quand même ce trou. Ce qui l'a révélé n'est ni une relecture ni un test : c'est **un essai en usage
réel sur des données réelles**. Les vérifications du §19.6 ne sont pas une formalité.

---

## 21. 🔍 Passe de vérification complète (15/09) — deux trous fermés

Relecture systématique de tout le chantier après la mise en service. **Deux défauts trouvés**, dont
un que le plan avait décidé sans jamais l'appliquer.

### 21.1 🔴 `consecutive_missed` était resté éditable (décision 8 non appliquée)

Le §13.2 tranchait : le compteur devient **non éditable**, sinon il ne peut pas servir de
déclencheur fiable à la pénalité. **Ce n'avait jamais été fait** — le champ restait modifiable via
`PUT /admin/joueurs/<id>` et depuis la modale d'édition.

C'est probablement une cause du compteur périmé constaté en usage : toute édition de fiche joueur
écrasait le compteur par la valeur du formulaire.

| Fichier | Changement |
|---|---|
| `routes_admin.py` | `api_update_joueur` ne touche le compteur que si le compte est **superadmin** et que le payload le porte explicitement |
| `gestion.js` | le champ n'est envoyé que s'il est actif — envoyer une valeur que le serveur ignore donnerait l'illusion d'une modification |
| `gestion_joueurs.html` | champ `readonly disabled`, sauf pour le superadmin ; libellé « Sessions manquées » |

L'information reste **affichée** partout où elle l'était (décision 8).

**Amendement du 15/09 (demande de l'utilisateur) : le superadmin garde la main.** Il faut une porte
de sortie pour rattraper un compteur faux sans passer par la base. C'est une **capacité de rôle**,
jamais une permission déléguable — même règle que l'annulation de tournoi
([[hierarchie-admin-plan]] §5). Le chemin normal reste `make recompter-absences`, qui recalcule tout
le monde selon une règle unique plutôt qu'un joueur à la main ; l'édition manuelle est le recours,
pas l'outil courant.

Deux `UPDATE` distincts selon le droit, plutôt qu'une colonne conditionnelle en SQL : la requête dit
ce qu'elle écrit. La valeur est bornée par `max(0, ...)` — un compteur négatif casserait la
comparaison de palier.

### 21.2 🟠 R-session-6 : deux seuils de participation divergents

`compute_ip_evolution` et `compute_position_evolution` appliquaient `MIN_PARTICIPATION_RATIO` à un
compte de **tournois bruts**, alors que `_aggregate_season_stats` l'applique désormais à un compte de
**sessions**. Deux seuils différents sur la même saison — 96 contre 93 sur l'historique actuel.

Le plan classait cet écart « préexistant, hors périmètre » (§9). Il ne l'est plus : la Phase 3 a
basculé un des deux comptages, donc les laisser divergents crée une incohérence que le chantier
lui-même a introduite.

**Corrigé** : les deux fonctions comptent des sessions distinctes pour le seuil.

⚠️ **Piège évité** : `tournoi_ids` reste une liste de **tournois** — elle indexe les courbes
d'évolution, qui ont un point par tournoi joué. J'avais d'abord réindexé les boucles sur
`total_tournois`, ce qui aurait **décalé silencieusement toutes les courbes**. Une assertion verrouille
désormais `for idx in range(len(tournoi_ids))`.

### 21.3 Le script de recomptage est désormais couvert

`scripts/recompter_absences.py` n'avait aucun test. 13 assertions ajoutées, portant sur ce qui compte :

- **il ne touche jamais `sigma` ni `ghost_log`** — c'est un compteur qu'on remet à jour, pas un
  historique qu'on rejoue ;
- la règle de ligue est respectée (session sans ligue = tout le monde ; sinon seuls les joueurs de
  cette ligue ; sans ligue → la plus faible) ;
- l'appartenance vient des **participations réelles**, pas de `joueurs.ligue_id` (qui est l'état
  courant, sans historique) ;
- il compare les **sessions**, pas seulement les dates : deux sessions non liées peuvent tomber le
  même jour ;
- le mode `--dry-run` n'écrit rien.

### 21.4 Validation

| Mutation introduite | Détecté |
|---|---|
| Le champ redevient éditable | ✅ 2 assertions |
| Courbes réindexées sur les sessions (décalage silencieux) | ✅ 2 assertions |
| Le script perd la règle de ligue | ✅ |

**252 assertions** sur les 4 fichiers du chantier (38 + 88 + 93 + 33). Les 3 échecs de la suite
(`test_auth`, `test_liaisons`, `test_profils`) précèdent ce chantier.

### 21.5 Ce qui a été vérifié sans rien trouver

- Un **seul** `INSERT INTO Tournois` dans tout le code, et il porte `session_id`.
- `add_tournament` appelle bien `invalidate_cache()` et `recalculate_tiers()`.
- Le recalcul de `is_ranked` au changement de seuil (`/admin/config`) est cohérent avec le compteur.
- `penalite_due` se comporte correctement sur les valeurs limites : 0 absence, palier exact,
  compteur très élevé, intervalle nul ou négatif (pas de division par zéro).
- Les paliers ne se déclenchent jamais deux fois pour un même compteur.
