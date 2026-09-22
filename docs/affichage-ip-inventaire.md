# Indice de Performance (IP) — inventaire de l'affichage et plan v1 / v2

> **État : analyse seule, aucun code modifié.** Première version le 20/09/2026, revue le
> 21/09/2026 contre le code à `d2a2f1f` : numéros de ligne recalés, un faux positif retiré
> (ancien défaut n°10), le défaut sur le plafond recadré, des défauts ajoutés, et un plan
> réorganisé autour d'une idée : **v1 et v2 doivent se distinguer partout où l'IP s'affiche.**
> Rien n'est commité — l'utilisateur fait ses commits lui-même ([[user-handles-commits]]).
>
> **Textes à écrire, page par page, et suivi d'avancement** :
> [`affichage-ip-plan-redaction.md`](affichage-ip-plan-redaction.md). Ce document-ci garde
> l'analyse : calcul, inventaire, défauts, phases techniques.
>
> Vocabulaire : dans ce dépôt, **« IP » = *Indice de Performance***, jamais une adresse réseau
> (voir §10).

---

## 1. Ce que calcule l'IP

Formule dans `_compute_grand_master` (`services.py:703`) pour le classement, reprise telle
quelle par `compute_ip_evolution` (`services.py:827`) pour les courbes.

### Tronc commun v1 / v2

1. **IP du tournoi** = `points du joueur ÷ moyenne de référence × 100`, **plafonnée à 150**
   (`GM_MAX_RATIO_CAP = 1.5`, `services.py:727-732`).
2. **IP de base** = moyenne des IP de tournoi, pondérée par `joueurs du lobby + poids de base`.
3. **Bonus d'assiduité** = `0,3 × (tournois joués − 40 % des tournois de la saison)`, jamais
   négatif (`services.py:741-742`). Le seuil n'est pas arrondi : sur 7 tournois il vaut 2,8,
   et 3 tournois joués rapportent 0,06 pt, pas 0.
4. **IP finale** = `min(150, IP de base + bonus)` (`GM_MAX_IP`, `services.py:744`).
5. **Classé** si le joueur a joué au moins 40 % des tournois (`services.py:745`).

« Tournois de la saison » veut dire **sessions** : deux lobbies d'une même session comptent
pour un (décision 7 de `docs/plan-sessions-tournois.md`, cf. [[plan-sessions-tournois]]).

### Ce qui distingue v1 et v2

| | v1 | v2 |
|---|---|---|
| Moyenne de référence d'un tournoi | moyenne du lobby, **joueur compris** | moyenne du lobby **sans le joueur** |
| Niveau des adversaires | ignoré | coefficient `force_lobby` (ci-dessous) |
| Poids de base (`GM_BASE_WEIGHT_V1/_V2`) | `5` : un lobby de 12 pèse ~1,9× un lobby de 4 | `15` : un lobby de 12 pèse ~1,4× un lobby de 4 |
| « 100 = la moyenne » | exact (avant plafond) | vrai seulement face à un lobby de niveau moyen |

**`force_lobby`** (`services.py:61`) = `1 + 0,02 × (Mu moyen des adversaires − Mu de référence)`,
borné entre ×0,5 et ×2 :

- **Mu des adversaires** : leur Mu *avant* le tournoi, joueur exclu.
- **Mu de référence** : grille figée juste avant le premier tournoi du jour (`grille_snapshots`,
  `snapshot_grille` en `services.py:315`), toutes ligues confondues, joueurs classés seulement
  (tier ≠ U et actifs, `IP_V2_REF_*`), joueur exclu. Journée sans grille : moyenne de la période
  (repli, `services.py:937-938` et `1268-1269`).
- Donnée manquante : coefficient 1.
- Le plafond de 150 est réappliqué **après** la correction.

**Exemple** — lobby de 8, moyenne 60 points, le joueur en marque 72 :

- **v1** : 72 ÷ 60 = 1,20 → **120**.
- **v2** : moyenne des 7 autres = (480 − 72) ÷ 7 = 58,3 → 72 ÷ 58,3 = 1,235. Adversaires à
  5 points de Mu au-dessus de la référence : × 1,10 → **135,9**. À 5 points en dessous :
  × 0,90 → **111,2**.

### Où la version se choisit, et ce qu'elle fige

| Écran | Stockage | Choix | Portée |
|---|---|---|---|
| Classement de la saison en cours | `Configuration.ip_version_live` | Admin › Réglages (`admin_reglages.html:106-123`) | immédiate (le cache est vidé, `routes_admin.py:554`) |
| Récap | `saisons.ip_version` | Admin › Saisons, à la création (`admin_saisons.html:463-480`), pré-coché sur la version live (`:1092-1097`) | **la version** est figée à vie ; **les chiffres** sont recalculés à chaque affichage (`routes_public.py:122-149`) |
| Mouvements inter-ligue (critère `ip`) | version du récap | — | `routes_admin.py:1664, 1714, 1766` |

Figer les chiffres eux-mêmes relève d'un autre chantier ([[refactor-historique-recaps-plan]]).

**Historique** : la v2 est arrivée en 1.4.3 (22/08) avec une comparaison v1 / v2 côte à côte
dans l'infobulle du graphe d'évolution. Cette comparaison a été **retirée volontairement le
même jour** (`e7f8482`) ; le CHANGELOG 1.4.3 la mentionne encore. Le plan ci-dessous ne la
rétablit pas : on distingue les versions par leur nom et leur explication, pas en affichant les
deux chiffres.

---

## 2. Où l'IP s'affiche côté public

### 2.1 Récap — `frontEnd/templates/recap.html`

| Ligne | Élément |
|---|---|
| 398-399 | Sous-titre `Compétition Indice de Performance (IP)`, si `victory_condition` vaut `Indice de Performance` ou `grand_master` |
| 405-411 | Icône `?` → `openRulesModal(victory_condition)` |
| 554 | Colonne `IP`, `title="Indice de Performance"` |
| 580-602 | Cellule IP (couleurs par seuil, non-classé) |
| 608-613 | Note sous le tableau : « Les indices de performance en rouge indiquent que le joueur n'a pas atteint le nombre de participation requis pour obtenir un indice de performance fiable. » |
| 637, 654, 671 | Podium d'un récap IP : la valeur d'IP est suivie de `points` |
| 759 | Carte `Évolution de l'IP` |
| 777 | Carte `IP pur gagné par tournoi` |
| 916-930 | Modale `rulesModal` « Règles de Victoire » |
| 1048-1049 | Texte d'explication de l'IP, en deux exemplaires |
| 1057 | `grand_master` redirigé vers `Indice de Performance` |
| 1338-1339 | Infobulle `IP du tournoi :` / `IP total :` |
| 1347 | Axe Y `IP` |
| 1422 | `title="IP pur moyen par match"` |
| 1461, 1469 | Infobulle `IP pur :`, axe Y `IP pur` |

La colonne, la cellule et les deux graphiques s'affichent **quelle que soit la condition de
victoire**, mais le `?` n'explique que la condition de victoire.

### 2.2 Classement de saison — `frontEnd/templates/classement_saison.html`

Inclus par `classement.html:146` (vue `?vue=saison`).

| Ligne | Élément |
|---|---|
| 91 | `Compétition Indice de Performance (IP)` — juste : la saison en cours est toujours classée à l'IP |
| 123 | Tuile `Leader (IP)` |
| 130 | Carte `Classement de saison (IP)` |
| 152-153 | Colonne `IP` |
| 155-156 | Colonne `Écart`, `title="Écart d'IP avec le leader du championnat"` |
| 179-201 | Cellule IP — copie de `recap.html:580-602` |
| 202-213 | Cellule écart (`leader` ou écart négatif) |
| 219-224 | Note sous le tableau : « Les indices en rouge indiquent que le joueur n'a pas encore atteint le nombre de participations requis pour un IP fiable. » |
| 232 | Carte `Évolution de l'IP au fil des tournois` |
| 407-408 | Infobulle `IP du tournoi :` / `IP total :` |
| 418 | Axe Y `IP` |

À part la note sur le rouge, aucune explication, et aucune indication de version.

### 2.3 La cellule IP (identique dans les deux pages)

- non classé → rouge, `title="Participation insuffisante"`
- `≥ 115` → jaune gras, précédé de `★`
- `≥ 105` → vert gras
- `≥ 95` → blanc
- `< 95` → blanc à 60 % d'opacité
- pas d'IP → `-` gris

---

## 3. Où l'IP s'affiche côté admin

**Réglages** (`admin_reglages.html:106-123`) — encadré vert « Indice de Performance (IP) du
classement de saison en cours » :
- v1 : « perf brut »
- v2 : « applique une force de lobby à la perf du joueur »
- aide : « Pilote uniquement le classement de saison en cours. Les récaps déjà générés ne bougent pas. »

**Saisons** (`admin_saisons.html`) :

| Ligne | Élément |
|---|---|
| 463-480 | « Version de l'IP » ; v1 : « Formule actuelle » ; v2 : « Corrige le déséquilibre entre lobbies d'une même session » ; aide : « Figée définitivement pour ce récap à sa création… » |
| 628-629 | Critère des mouvements inter-ligue : `Indice de Performance (classement de la saison)` |
| 724-732 | Option de condition de victoire `Indice de Performance` 🎯, injectée en JS |
| 739 | Filtre sur `Indice de Performance` **et** `Indicateur de Performance` |
| 798+ | Liste des récaps (`loadSaisons`) : badges Publié/Brouillon, Annuel/Saison, Ligue… **mais pas la version**, que l'API renvoie pourtant (`routes_admin.py:1393`) |

---

## 4. Base de données et données réelles

- `schema.sql:536` et `seed.sql:54` : `('Indice de Performance', 'Indice de Performance', '🎯', 'Calcul IP')`.
  La description `Calcul IP` n'est affichée nulle part.
- `routes_public.py:734` : la saison en cours a toujours `victory_condition = "Indice de Performance"`.
- `services.py:1361` accepte encore `grand_master` comme condition de victoire.
- **`backEnd/dump.sql`** contient 6 récaps : 5 `stakhanov`, 1 `Indice de Performance`, aucun
  `grand_master`. Il n'a pas de colonne `ip_version` (schéma d'avant le 18/08, cf.
  [[rattrapage-migrations-dump]]) : tous ses récaps passent en v1 par défaut.
- `grand_master` n'existe ni comme condition de victoire ni comme code de `types_awards` dans
  `schema.sql`, `seed.sql` ou `dump.sql`. La prod, plus ancienne, reste à vérifier.

---

## 5. Constantes (`backEnd/constants.py`)

| Constante | Valeur | Ligne | Citée à l'écran ? |
|---|---|---|---|
| `MIN_PARTICIPATION_RATIO` | `0.4` | 47 | oui, « 40% » en dur dans `recap.html:1048` |
| `GM_MAX_RATIO_CAP` | `1.5` | 49 | **non** — c'est le plafond de 150 par tournoi |
| `GM_MAX_IP` | `GM_MAX_RATIO_CAP * 100` | 52 | non |
| `GM_EXTRA_MATCH_BONUS` | `0.3` | 53 | oui, « +0,3 pt » en dur dans `recap.html:1048` |
| `REFERENCE_PLAYER_COUNT` | `12.0` | 54 | seulement pour Stakhanov |
| `GM_BASE_WEIGHT_V1` / `_V2` | `5.0` / `15.0` | 58-59 | non |
| `IP_V2_FORCE_LOBBY_PER_MU` | `0.02` | 70 | non |
| `IP_V2_FORCE_LOBBY_MIN` / `_MAX` | `0.5` / `2.0` | 71-72 | non |
| `IP_VERSION_DEFAULT` | `"v1"` | 73 | non |
| `IP_V2_REF_REQUIRE_TIER` / `_RANKED` | `True` / `True` | 80-81 | non |

Les seuils d'affichage **95 / 105 / 115** n'ont pas de constante : ils n'existent qu'en double
dans les deux gabarits.

---

## 6. Défauts relevés

### A. v1 et v2 ne se distinguent pas

1. **Version invisible côté public.** Ni le récap ni le classement ne disent quelle version
   est utilisée ; les payloads ne transmettent même pas `ip_version`
   (`routes_public.py:358-376`, `800-816`).
2. **Le texte d'explication ne décrit que la v1.** Pour un récap v2, « une base de 100
   représente la moyenne » est faux et la correction par le niveau des adversaires n'est
   jamais mentionnée.
3. **Version invisible dans la liste admin des récaps**, alors que la donnée est déjà dans
   la réponse de l'API.
4. **Deux vocabulaires admin** : « perf brut » / « force de lobby » dans Réglages,
   « Formule actuelle » / « Corrige le déséquilibre… » dans Saisons. « Formule actuelle »
   est trompeur dès que le classement live est en v2.
5. **Aide des Réglages imprécise** : « Les récaps déjà générés ne bougent pas » — leur
   *version* ne bouge pas, mais leurs *chiffres* sont recalculés à chaque affichage.
6. **Commentaire faux et calcul inutile** : `services.py:912` affirme que l'infobulle affiche
   v1 et v2 ; ce n'est plus le cas depuis `e7f8482`. `compute_ip_evolution` calcule encore
   les deux versions et envoie `ip_pur_v1/v2`, `ip_total_v1/v2` sans que rien ne les lise.

### B. L'IP n'est pas expliquée

7. **IP inexpliquée dans les récaps Stakhanov** (5 sur 6 dans le dump) : colonne IP et
   graphiques présents, mais le `?` n'explique que Stakhanov.
8. **Classement de saison sans aucune explication** : IP, écart, couleurs, statut « non
   classé », rien n'est dit.
9. **Couleurs muettes** : pas de légende, et seuils 95 / 105 / 115 sans constante.
10. **Plafond par tournoi jamais annoncé** *(ancien n°8, recadré)*. Le plafond final de 150
    (`GM_MAX_IP`) n'agit presque jamais : l'IP de base, moyenne de valeurs toutes ≤ 150, ne
    le dépasse pas, seul le bonus pourrait l'y pousser. Le plafond qu'on subit vraiment est
    celui de **chaque tournoi** : écraser son lobby à 2× la moyenne ne rapporte que 150.
11. **Chiffres en dur** : « 40% » et « +0,3 pt » sont écrits dans un littéral JS ; changer
    la constante rendrait le texte faux sans aucun signal.
12. **Bonus décrit comme un compte rond** : le texte laisse croire que le premier tournoi
    au-dessus du minimum ne rapporte rien ou 0,3 pt, alors qu'il rapporte une fraction
    quand le minimum n'est pas entier.
13. **Le rouge est expliqué de façon floue** : une note sous chaque tableau existe
    (`recap.html:608-613`, `classement_saison.html:219-224`), mais elle parle d'un « nombre de
    participations requis » sans jamais le donner, et d'un IP « fiable » sans dire ce que cela
    change. Le `title="Participation insuffisante"` de la cellule est redondant, et invisible
    au tactile.

### C. Doublons et vocabulaire

14. **Cellule IP copiée-collée** entre `recap.html:580-602` et `classement_saison.html:179-201`.
15. **Texte d'explication en double** (`recap.html:1048-1049`) : la clé `'grand_master'` est
    inatteignable puisque la ligne 1057 redirige déjà vers `'Indice de Performance'`.
16. **Une valeur, deux noms** : « IP du tournoi » (infobulle d'évolution) et « IP pur »
    (graphique en barres, son axe, sa carte) désignent la même chose.
17. **Libellés concurrents** : `Indice de Performance`, `IP`, `grand_master`, `score_gm`,
    `Calcul IP` (en base), `Indicateur de Performance`.
18. **Gardes contre des valeurs absentes** : `Indicateur de Performance`
    (`admin_saisons.html:739`) n'existe nulle part ; `code != 'grand_master'`
    (`routes_admin.py:1361`) filtre un code d'award absent du schéma, du seed et du dump.

### D. Relevés en préparant le plan de rédaction (21/09)

19. **Le podium présente l'IP comme des points** : dans un récap IP, `recap.html:637, 654, 671`
    affichent `112.35 points` alors que c'est une valeur d'IP.
20. **Les infobulles `fast-tip` ne marchent qu'au survol** (`styles.css:159-184`, pseudo-élément
    sur `:hover`) : jamais visibles sur mobile. Le problème dépasse l'IP (aides des awards du
    récap, awards de `stats_joueur.html`) ; ici, on en tire seulement la règle de ne rien
    confier aux infobulles.

### Écartés à la revue du 21/09

- **Titre du classement écrit en dur** (ancien n°10) : faux positif. `_find_active_season`
  impose `Indice de Performance` (`routes_public.py:734`) ; la saison en cours est toujours
  classée à l'IP.
- **Clé de cache du classement sans `ip_version`** (`routes_public.py:783`) : sans effet,
  l'enregistrement des réglages vide tout le cache.

---

## 7. Textes proposés

Déplacés le 21/09/2026 dans [`affichage-ip-plan-redaction.md`](affichage-ip-plan-redaction.md) :
noms des versions, texte exact page par page avec son emplacement et ses cas d'affichage,
modale d'explication, écrans admin, chiffres générés et données que le back doit fournir.
C'est aussi là que se trouvent les décisions à prendre et la liste d'avancement.

---

## 8. Plan

### Phase 1 — Une seule source pour les textes (back)

- Créer `backEnd/textes_ip.py` : `textes_ip(version)` renvoie le nom, le badge, les résumés
  public et admin, l'explication et la légende de `affichage-ip-plan-redaction.md`, construits à partir des constantes, avec
  des nombres au format français (`0,3`, pas `0.3`).
- Ajouter à `constants.py` les seuils d'affichage (ex. `IP_SEUIL_ETOILE = 115`,
  `IP_SEUIL_BON = 105`, `IP_SEUIL_MOYEN = 95`).
- Tests : changer une constante change le texte ; les textes v1 et v2 diffèrent.
- **Terminé quand** aucun chiffre lié à l'IP n'est écrit en dur dans un gabarit.

### Phase 2 — Faire arriver la version jusqu'à l'écran

- `routes_public.py` : ajouter un bloc `ip` (`version` + `textes_ip(version)` + seuils) au
  payload du récap (`:358`) et du classement de saison (`:800`).
- `routes_admin.py` : `/admin/config` renvoie aussi les textes des deux versions, pour les
  boutons radio.
- **Terminé quand** les deux routes renvoient la bonne version pour un récap v1, un récap v2
  et le classement live.

### Phase 3 — Montrer la version et l'expliquer partout

Public :
- Partiel `partiels/explication_ip.html` (modale : explication + légende), inclus dans le récap
  **et** le classement de saison.
- Badge `v1 · IP brute` / `v2 · IP ajustée` à côté du titre du tableau, cliquable → ouvre cette
  explication. Visible dans **tous** les récaps, Stakhanov compris.
- Le `?` du récap garde son rôle (condition de victoire) ; quand la condition est l'IP, il
  ouvre la même explication. Supprimer `rulesDescriptions['Indice de Performance']` et
  `['grand_master']`.
- Macro `partiels/cellule_ip.html` pour la cellule, seuils lus dans le bloc `ip`.
- Légende des couleurs visible sous chaque tableau ; « non classé » visible au tactile.
- Libellés courts (`affichage-ip-plan-redaction.md` §3.7, §3.8 et §4).

Admin :
- Réglages et Saisons : mêmes noms, mêmes résumés, nouvelles aides (`affichage-ip-plan-redaction.md` §6 et §7).
- Liste des récaps : badge `v1` / `v2` à côté de Annuel/Saison.

**Terminé quand** un récap v1, un récap v2, un récap Stakhanov et le classement live affichent
chacun la bonne version et une explication qui s'ouvre au clic comme au doigt (testé sur mobile).

### Phase 4 — Nettoyage

- `compute_ip_evolution` : ne calculer que la version demandée ; supprimer `ip_pur_v1/v2`,
  `ip_total_v1/v2` et le commentaire faux (`services.py:912`).
- Supprimer la garde `Indicateur de Performance` (`admin_saisons.html:739`).
- **Vérifier la prod d'abord**, puis retirer ce qui n'y existe pas :
  `SELECT DISTINCT victory_condition FROM saisons;` et
  `SELECT code FROM types_awards WHERE code = 'grand_master';`
  → branches `grand_master` de `services.py:1361`, `recap.html:398`, `routes_admin.py:1361`.
  La prod contient des données réelles ([[repo-public-donnees-reelles-historique]]).
- **Ne pas toucher** : la clé interne `candidates['grand_master']`, `_compute_grand_master`,
  `score_gm`, `is_eligible_gm`. C'est du code actif ; les renommer coûte cher pour aucun gain
  visible.
- Description `Calcul IP` en base : à laisser tant qu'elle n'est pas affichée.

---

## 9. Décisions à valider

Regroupées dans `affichage-ip-plan-redaction.md` §9.

---

## 10. Hors périmètre — les adresses IP réseau

Le projet ne stocke aucune adresse IP. Occurrences du sens « réseau », pour mémoire :
`confidentialite.html:39, 60, 92` (texte RGPD), `frontend.py:955` (log du callback Discord),
`schema.sql:467` et `backEnd/migrations/2026-09-02_auth_discord.sql:125` (sessions sans IP),
`routes_comptes.py:2239`, `backEnd/tests/test_auth.py:21`, `backEnd/tests/test_profils.py:91`
(relais d'avatar Discord).
