# Sessions de tournois — plan d'attaque

> **À lire en premier dans une nouvelle session.** Rien n'est commité — l'utilisateur fait ses
> commits lui-même ([[user-handles-commits]]). Document de conception, pas d'implémentation avant
> relecture de ce fichier en entier.
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
> 2. Rattachement d'un tournoi à une session : **geste manuel, au moment d'enregistrer le
>    tournoi**. On garde l'écran `add_tournament` tel qu'il est ; après validation, on propose de
>    lier ce tournoi à un autre tournoi récent (liste libre, pas juste « même jour »). Si l'admin ne
>    lie rien, le tournoi reste seul dans sa session — comportement 100% rétrocompatible.
> 3. Modèle de données : nouvelle table `sessions` + `tournois.session_id`. **Chaque tournoi porte
>    toujours une `session_id`** (jamais NULL), y compris un tournoi jamais lié : il est alors seul
>    dans sa session. Un tournoi solitaire n'est donc pas un cas particulier mais une session à un
>    seul élément — conséquence : la liaison de Phase 2 est *toujours* une fusion de deux sessions
>    existantes, jamais une création de lien. Validé avec l'utilisateur le 13/09.
> 4. Une session est **neutre vis-à-vis de la ligue** : elle peut contenir des tournois de ligues
>    différentes ; chaque tournoi garde son `ligue_id` propre, la règle d'absence continue de
>    filtrer par ligue *à l'intérieur* de la session.
> 5. Règle de présence : **une session manquée = +1** sur `consecutive_missed` — jouer un seul
>    tournoi de la session suffit à compter présent pour toute la session. Un tournoi resté
>    solitaire continue de valoir +1 à lui seul, à condition de contenir un match de la
>    ligue du joueur absent quand le mode ligue est actif — c'est la règle *déjà en vigueur*
>    aujourd'hui, seulement reformulée en termes de session.
> 6. Annulation (`revert`/`delete`) d'un tournoi membre d'une session : s'il reste au moins un autre
>    tournoi dans la session, rien ne change pour le comptage de présence. Si c'était le dernier,
>    comportement identique à aujourd'hui (le tournoi disparaît, la session devient orpheline — voir
>    §6.3).

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
| **0** | **Corriger `revert_last_tournament`** (§2) — défaut préexistant, indépendant des sessions | — | Moyen (change des valeurs en base) | Non (valeurs corrigées) |
| 1 | Schéma : `sessions` + `tournois.session_id` + **backfill** (§11) + `sessions` dans `sync_sequences()` | — | Faible (ajout pur ; 92 tournois, 3 paires à regrouper) | **Oui**, totalement |
| 2 | UX de liaison après enregistrement d'un tournoi | Phase 1 | Faible (nouvel écran/modale) | **Oui**, totalement |
| 3 | Bascule de la règle de présence sur `session_id`, **y compris `session_keys` de `services.py`** (R-session-6) | Phases 0 + 1 | **Élevé** (cœur du calcul de pénalité + seuils d'awards) | **Non** : les sigma/compteurs écrits restent |
| 4 | Annulation/suppression et sessions orphelines | Phase 3 | Moyen | Partiellement |
| 5 | Affichage : landing page par session (§7) + sessions dans les écrans de stats | Phase 1 | Faible (template déjà générique) | **Oui**, totalement |

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

### 4.1 Où s'accroche le geste

Décision actée : on ne touche pas à l'écran de saisie d'`add_tournament`. Le point d'accroche est
la **réponse** de `POST /add-tournament` une fois le tournoi créé avec succès
([add_tournament.html:504-511](../frontEnd/templates/add_tournament.html#L504-L511)) : au lieu de
rediriger immédiatement vers `/classement`, afficher une modale « Ce tournoi fait-il partie de la
même session qu'un autre tournoi récent ? » avec une liste (les N derniers tournois, toutes ligues
confondues puisqu'une session est neutre vis-à-vis de la ligue) et un bouton « Passer ».

### 4.2 Nouvelle route

```
POST /admin/tournois/<int:tournoi_id>/lier-session
Body: { "autre_tournoi_id": <int> }
```

Protégée par la même permission que l'ajout (`gestion_tournois`), appelle
`fusionner_sessions(cur, tournoi_id, autre_tournoi_id)`. Renvoie la `session_id` résultante.

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

### 5.2 Le timing de la liaison a posteriori — tranché

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

### 5.3 Un cas qui devient correct et ne l'est pas aujourd'hui

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

### 5.4 Configuration, seuils, cap — inchangés

`ghost_enabled`, `ghost_penalty`, `ghost_threshold_days`, `ghost_interval_days`,
`unranked_threshold`, `GHOST_SIGMA_CAP` : aucune de ces règles ne change de sémantique, seule
l'unité de déduplication (session au lieu de date) change. Pas de migration de `Configuration`
nécessaire pour cette phase.

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
- `GET /stats/tournois` et la liste de `add_tournament.html` : hors périmètre de ce point, mais
  afficher la session dans ces listes est le sujet de la Phase 5 (§1) — utile pour que l'admin
  vérifie d'un coup d'œil ce qu'il a lié.

---

## 8. Risques transverses

- **R-session-1 (tranché le 13/09, reste le point le plus délicat à implémenter)** : la liaison
  étant un geste *a posteriori*, une pénalité peut avoir déjà été écrite pour un joueur avant que
  l'admin ne relie les deux tournois de sa session. **Résolution actée** : `fusionner_sessions`
  corrige rétroactivement ces pénalités (§5.2), et chaque tournoi porte toujours une session dès sa
  création pour que la fusion soit l'unique endroit où cette correction a lieu. Ce n'est donc plus
  un point de conception ouvert, mais ça reste la partie du chantier qui écrit dans `ghost_log`
  depuis un endroit qui n'est pas `add_tournament` — à couvrir par un test dédié (§10.5) avant de
  considérer la Phase 3 finie.
- **R-session-6 (nouveau, §10.3)** : trois notions concurrentes de « nombre de tournois » coexistent
  déjà dans `services.py` — `len(set(session_keys.values()))` regroupé par `(date, ligue)` à la
  ligne 833, contre `len(tournoi_ids)` brut aux lignes 506 et 651. Le regroupement de la ligne 833
  est exactement la même heuristique que celle que ce plan remplace, dupliquée hors de
  `add_tournament`. Elle doit basculer sur `session_id` **dans la même phase** que le calcul de
  pénalité, sinon les awards (Grand Master, seuils `MIN_PARTICIPATION_RATIO`) et la pénalité
  d'absence compteront les sessions différemment. Les lignes 506/651 sont un écart préexistant,
  indépendant de ce plan : à signaler à l'utilisateur, pas à corriger silencieusement ici.
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
