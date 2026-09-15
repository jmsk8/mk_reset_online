# Plan de conception — Système d'achievements

Statut : conception uniquement, rien implémenté. À faire par phases, comme les autres plans du dossier `docs/`.

## 1. Positionnement par rapport aux awards existants

Les awards actuels (`types_awards` / `awards_obtenus`) sont **par saison, recalculés en batch et remplacés** (delete + insert au clic admin, cf `save_season_awards`). Un achievement est structurellement différent :

- **permanent** : une fois débloqué, jamais retiré ni recalculé
- **débloqué à un instant précis** (le tournoi qui l'a déclenché), pas "le meilleur sur une période"
- **événementiel** : calculé juste après `add_tournament()`, pas via un bouton admin
- **non rétroactif** (décision explicite) : un achievement ne compte qu'à partir du moment où son critère existe dans le code. Pas de script de rattrapage sur l'historique passé, même si ça laisse les comptes existants "vierges" au lancement.

Conséquence : nouvelles tables séparées de `awards_obtenus`, pas d'extension du système actuel.

## 2. Modèle de données

### `types_achievements` (catalogue)

```sql
CREATE TABLE types_achievements (
    id serial PRIMARY KEY,
    code varchar(50) NOT NULL UNIQUE,      -- ex: 'streak_podium_5', 'assiduite_10', 'assiduite_30', 'crusher_ip_mu'
    nom varchar(100) NOT NULL,
    emoji varchar(100) NOT NULL,           -- même convention que types_awards (emoji brut ou chemin /static/img/)
    description text,
    actif boolean NOT NULL DEFAULT true    -- permet de désactiver un critère sans supprimer l'historique des joueurs qui l'ont
);
```

Catalogue géré en dur dans le code (comme le seed actuel de `types_awards`), pas d'UI d'admin en V1 — chaque nouvel achievement est un ajout de code + une ligne de catalogue, pas une config.

### `achievements_obtenus` (déblocages)

```sql
CREATE TABLE achievements_obtenus (
    id serial PRIMARY KEY,
    joueur_id integer NOT NULL REFERENCES joueurs(id) ON DELETE CASCADE,
    achievement_id integer NOT NULL REFERENCES types_achievements(id) ON DELETE CASCADE,
    tournoi_id integer REFERENCES tournois(id) ON DELETE SET NULL,  -- tournoi déclencheur, traçabilité
    valeur varchar(50),             -- valeur numérique au moment du déblocage (ex: "127.4" pour l'IP)
    unlocked_at timestamp NOT NULL DEFAULT now(),
    UNIQUE(joueur_id, achievement_id)   -- binaire : un seul déblocage possible par joueur/achievement
);
```

Pas de `saison_id` ni `ligue_id` : un achievement transcende les saisons. `tournoi_id` en `SET NULL` (pas `CASCADE`) : si un tournoi est supprimé/annulé après coup, l'achievement débloqué reste acquis (cohérent avec "permanent").

### Question ouverte : annulation de tournoi

Le repo a un système de `revert_last_tournament` (cf mémoire "Plan sessions de tournois"). Si le tournoi qui a débloqué un achievement est annulé juste après, faut-il retirer l'achievement ? Proposition V1 : **non** — cohérent avec "permanent, jamais recalculé". À documenter comme comportement assumé plutôt que bug.

## 3. Déclenchement : événementiel, hook après commit

D'après l'exploration de `add_tournament()` (`backEnd/routes_admin.py`) :

- `snapshot_grille(cur, date_tournoi)` : ligne 1495 (avant tout)
- écriture définitive `Participations` (mu, sigma, new_score_trueskill, position) : lignes 1665-1670
- `notifier_tous(...)` : lignes 1774-1779
- `conn.commit()` : ligne 1781, puis `recalculate_tiers()` / `invalidate_cache()`

**Point d'insertion retenu : juste après `conn.commit()` (après la ligne 1781)**, sur une connexion séparée, pas dans la transaction principale. Raison : si la détection d'achievement plante, ça ne doit pas faire échouer/rollback l'enregistrement du tournoi. On a alors `tournoi_id`, `date_tournoi` et la liste des `joueur_id` du tournoi disponibles pour lancer la détection.

```python
# après conn.commit() dans add_tournament()
try:
    check_achievements_for_tournament(tournoi_id, joueur_ids, date_tournoi)
except Exception:
    log_exception(...)   # ne doit jamais faire échouer la requête HTTP
```

`check_achievements_for_tournament` ouvre sa propre connexion/transaction, insère dans `achievements_obtenus`, et déclenche `notifier_tous` pour chaque déblocage (import du même helper que `add_tournament` utilise déjà).

### Détection = fonctions pures, une par achievement

Chaque critère est une fonction `(cur, joueur_id, tournoi_id, date_tournoi) -> bool | dict | None` qui retourne soit `None` (pas débloqué), soit un dict `{valeur: ...}` si débloqué. Un petit registre `ACHIEVEMENT_CHECKS = {code: fonction}` permet d'itérer dessus sans if/else en cascade. Ça garde la porte ouverte à un futur mode "rejouable sur l'historique" même si on ne l'utilise pas en V1 (décision : pas de rattrapage, mais pas d'architecture qui l'empêcherait structurellement).

Avant d'insérer, vérifier l'absence dans `achievements_obtenus` (contrainte UNIQUE de toute façon, mais autant éviter l'exception) : `INSERT ... ON CONFLICT (joueur_id, achievement_id) DO NOTHING`.

## 4. Achievements pilotes (3-5, pour valider le modèle)

### A. `streak_podium_5` — 5 podiums d'affilée

- **Donnée** : `participations.position` triée par date de tournoi, pour le joueur.
- **Détection** : après écriture de la position du joueur pour `tournoi_id`, vérifier que ses positions aux 5 derniers tournois (incluant celui-ci) sont toutes ≤ 3. Requête simple :
  ```sql
  SELECT p.position FROM participations p
  JOIN tournois t ON t.id = p.tournoi_id
  WHERE p.joueur_id = %s AND p.exclude_from_ts = false
  ORDER BY t.date DESC, t.id DESC
  LIMIT 5
  ```
  Si 5 lignes ET toutes `position <= 3` → débloqué, `valeur` = nombre de podiums (ici 5, fixe, mais utile si on ajoute plus tard un variant "10 podiums d'affilée" en réutilisant la même fonction paramétrée).
- **Remarque** : traiter `exclude_from_ts` (tournois hors-classement) comme une rupture de la série ou les ignorer ? Proposition : les ignorer purement (filtrés hors de la requête), un tournoi non classé ne casse pas une série de podiums en tournois classés. À confirmer si un cas concret se présente.

### B. `assiduite_10` et `assiduite_30` — présence sans absence

- **Donnée** : `joueurs.consecutive_missed` (compteur d'absences consécutives déjà maintenu par le système de pénalité/ghost) et le nombre de tournois joués consécutivement sans que ce compteur soit jamais remonté au-dessus de 0 entre deux participations.
- **Reformulation opérationnelle** : "10 tournois d'affilée sans absence" = les 10 dernières sessions de tournoi (au sens `sessions_tournois`, pas tournoi individuel — sinon plusieurs lobbies le même soir compteraient double) auxquelles le joueur était censé participer ont toutes une participation enregistrée, sans absence entre-temps.
- **Détection** : au lieu de recalculer une fenêtre complexe, plus simple et robuste : maintenir un compteur dédié `joueurs.tournois_consecutifs_sans_absence`, incrémenté à chaque participation si `consecutive_missed == 0` juste avant cette participation, remis à zéro sinon (le mécanisme de ghost existant remet déjà `consecutive_missed` à 0 quand le joueur revient — il suffit de brancher sur le même point de code). Puis l'achievement se déclenche quand ce compteur atteint 10, puis 30 (deux checks distincts sur la même valeur, chacun avec son propre `UNIQUE` donc pas de double déclenchement).
- **Point d'attention** : nécessite une colonne supplémentaire (`joueurs.tournois_consecutifs_sans_absence`) — à ajouter dans la même migration que les tables achievements. Alternative sans nouvelle colonne : recalculer par requête sur `participations` + `ghost_log` à chaque tournoi, plus coûteux mais sans migration de `joueurs`. **Recommandation** : commencer par la requête recalculée (pas de nouvelle colonne), optimiser seulement si ça devient un point chaud — cohérent avec "ne pas complexifier avant d'en avoir besoin".

### C. `crusher_ip_mu` — gros score dans une room au mu moyen élevé

- **Donnée** : `ip_pur_v2` du tournoi (déjà calculé par tournoi dans `compute_ip_evolution`, cf section 1 de l'exploration) — ratio score/moyenne-lobby (leave-one-out) corrigé par `_force_lobby(mu_moyen_lobby, mu_moyen_référence_du_jour)`, plafonné à 1.5 (donc IP max 150).
- **Action nécessaire** : extraire ce calcul par-tournoi de `compute_ip_evolution` dans une fonction indépendante `compute_ip_pur_v2_single(cur, tournoi_id)`, réutilisable à la fois par l'écran d'évolution IP existant et par ce hook d'achievement — pas de duplication de formule.
- **Détection** : après le tournoi, pour chaque joueur y ayant participé, calculer `ip_pur_v2` de ce tournoi ; si `>= 120` → débloqué, `valeur` = l'IP obtenu (ex: `"127.4"`).
- **Cas du snapshot manquant** : si `grille_snapshots` n'a pas de ligne pour cette date (ne devrait pas arriver puisque `snapshot_grille` est appelé en tout début de `add_tournament`, mais défensif), `_force_lobby` retourne `1.0` (neutre) — comportement déjà celui du code existant, pas de cas particulier à gérer.

## 5. Notifications

Réutilisation directe de `notifier_tous(cur, type, titre, message)`, déjà branché dans `add_tournament()`. Un déblocage envoie une notification par achievement débloqué (potentiellement plusieurs si un tournoi en débloque plusieurs pour un même joueur — rare mais possible, ex: streak + crusher le même soir). Format proposé :

```python
notifier_tous(cur, 'achievement_debloque',
    f"🏆 {joueur_pseudo} a débloqué : {achievement_nom}",
    achievement_description)
```

À vérifier : le système de notifications actuel notifie-t-il "tous" les utilisateurs ou peut-il cibler un seul joueur ? Si `notifier_tous` est littéralement "tout le monde", un déblocage d'achievement individuel notifiant tout le site peut être bruyant si beaucoup d'achievements se débloquent — à valider lors de l'implémentation, potentiellement prévoir un ciblage par joueur si le mécanisme le permet déjà pour d'autres cas d'usage.

## 6. Frontend (réutilisation du pattern existant)

- **Fiche joueur** (`stats_joueur.html`) : nouvelle section "Achievements" à côté de "Palmarès", même pattern de grille d'icônes cliquables (`showAwardInfo()` → équivalent `showAchievementInfo()`), tooltip avec description + date de déblocage + tournoi lié (lien vers le tournoi si pertinent).
- Pas de page catalogue globale "tous les achievements possibles" en V1 (pas demandé) — peut être une phase 2 si utile pour donner envie aux joueurs de savoir ce qui reste à débloquer.

## 7. Fichiers à créer/modifier (implémentation, phases suivantes)

- `backEnd/migrations/2026-XX-XX_add_achievements.sql` : tables `types_achievements`, `achievements_obtenus`, seed du catalogue pilote (3-4 lignes)
- `backEnd/schema.sql` : refléter les nouvelles tables (comme pour chaque migration précédente)
- `backEnd/services.py` :
  - `compute_ip_pur_v2_single(cur, tournoi_id, joueur_id)` — extraction isolée depuis `compute_ip_evolution`
  - `check_achievements_for_tournament(tournoi_id, joueur_ids, date_tournoi)` + registre `ACHIEVEMENT_CHECKS`
  - une fonction de détection par achievement pilote (`_check_streak_podium`, `_check_assiduite`, `_check_crusher_ip_mu`)
- `backEnd/routes_admin.py` : appel du hook après `conn.commit()` dans `add_tournament()` (~ligne 1781+)
- `backEnd/routes_public.py` : requête pour exposer `achievements_obtenus` sur la fiche joueur (JOIN `types_achievements`, pattern identique à la section palmarès existante)
- `backEnd/constants.py` : seuils (`ACHIEVEMENT_STREAK_PODIUM_LEN = 5`, `ACHIEVEMENT_IP_MU_THRESHOLD = 120`, `ACHIEVEMENT_ASSIDUITE_PALIERS = [10, 30]`)
- `frontEnd/templates/stats_joueur.html` : section Achievements

## 8. Ordre d'implémentation suggéré

1. Migration + tables + catalogue pilote (sans aucun code de détection branché)
2. `compute_ip_pur_v2_single` isolée + test unitaire comparant son résultat à `compute_ip_evolution` sur un cas connu (non-régression de la formule)
3. Hook + registre + 1er achievement (`streak_podium_5`, le plus simple, pas de dépendance à grille_snapshots)
4. `crusher_ip_mu` (dépend de l'étape 2)
5. `assiduite_10`/`assiduite_30` (dépend de la décision colonne vs requête recalculée, section 4.B)
6. Frontend fiche joueur + notification
