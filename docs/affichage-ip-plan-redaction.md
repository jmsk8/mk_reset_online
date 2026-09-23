# IP v1 / v2 — plan de rédaction, page par page

> **État : ✅ clos le 22/09/2026**, affichage validé par l'utilisateur. Décisions du §9
> tranchées, phases 1 à 4 faites. Le dernier reliquat, les branches `grand_master`, est retiré
> le 23/09 après vérification sur les dumps de prod (§10) : **plus rien en attente**.
>
> Ce document dit **quoi écrire, sur quelle page, à quel endroit et dans quel cas**.
> L'analyse (calcul exact de v1 / v2, inventaire, défauts, phases techniques) est dans
> [`affichage-ip-inventaire.md`](affichage-ip-inventaire.md).
>
> **Où vit le texte désormais** : `backEnd/textes_ip.py` (seule source, chiffres calculés
> depuis les constantes), `frontEnd/templates/partiels/cellule_ip.html` (cellule, légende,
> badge) et `partiels/explication_ip.html` (modale). Filets : `test_textes_ip.py` (44
> assertions) et `test_affichage_ip.py` (90).

---

## 1. Rappel en cinq lignes

- **IP du tournoi** = vos points ÷ moyenne de référence × 100, plafonnée à 150.
- **IP de la saison** = moyenne pondérée des IP de tournoi + 0,3 par tournoi au-delà du
  minimum (40 % des tournois), plafonnée à 150.
- **v1 · IP brute** : référence = moyenne du lobby, joueur compris. Le niveau des adversaires
  est ignoré.
- **v2 · IP ajustée** : référence = moyenne des adversaires seuls, puis correction de ±2 % par
  point de Mu d'écart entre le lobby et les joueurs classés du jour. La taille du lobby pèse moins.
- **Version** : le classement en cours suit le réglage admin ; un récap garde celle choisie à
  sa création, mais ses chiffres sont recalculés à chaque affichage.

Détail, exemple chiffré et références de code : `affichage-ip-inventaire.md` §1.

---

## 2. Règles communes

- **Quelle version afficher** : dans un récap, `saisons.ip_version` ; dans le classement de la
  saison, `Configuration.ip_version_live`.
- **Un seul accès à l'explication** : un badge cliquable sur la carte du tableau. Il marche au
  doigt, contrairement aux infobulles.
- **Une seule explication** : une modale partagée par le récap et le classement, avec le texte
  v1 ou v2 selon la page.
- **Les infobulles (`title`, `fast-tip`) sont un bonus sur ordinateur** : elles ne s'affichent
  qu'au survol, donc jamais sur mobile. Aucune information ne doit passer uniquement par elles.
- **Aucun chiffre recopié à la main** : tout vient des constantes ou du payload (§8).

### Notation dans ce document

| Symbole | Sens | Source |
|---|---|---|
| **N** | tournois minimum pour être classé | `ceil(M × MIN_PARTICIPATION_RATIO)` |
| **M** | tournois de la saison (des sessions, cf. [[plan-sessions-tournois]]) | `total_tournois` du payload |
| `v2 · IP ajustée` | badge de la version de la page | `ip.version` du payload |
| 150 | plafond par tournoi | `GM_MAX_RATIO_CAP × 100` |
| 40 % | minimum de participation | `MIN_PARTICIPATION_RATIO × 100` |
| 0,3 | bonus par tournoi au-delà du minimum | `GM_EXTRA_MATCH_BONUS` |
| 2 % | correction v2 par point de Mu | `IP_V2_FORCE_LOBBY_PER_MU × 100` |
| « deux fois » (v1), « 1,4 fois » (v2) | poids d'un lobby de 12 face à un lobby de 4 | `(12 + poids de base) ÷ (4 + poids de base)`, arrondi |
| 95 / 105 / 115 | seuils des couleurs | nouvelles constantes (phase 1) |

---

## 3. Récap de saison — `/recap/<slug>` (`frontEnd/templates/recap.html`)

Quatre cas possibles : récap IP ou Stakhanov, chacun en v1 ou en v2.

### 3.1 Bandeau du haut, sous le nom de la saison (l. 394-411)

| Cas | Texte | Le `?` ouvre… |
|---|---|---|
| Récap IP | `Compétition Indice de Performance (IP)` — inchangé | l'explication de l'IP (§5), à la place du texte actuel |
| Récap Stakhanov | `Compétition Stakhanoviste` — inchangé | les règles Stakhanov, inchangées |

### 3.2 Carte « Classement Général » (l. 529-531)

- Titre inchangé.
- **Nouveau** : badge à droite du titre, dans **tous** les récaps (Stakhanov compris) :
  `v1 · IP brute ⓘ` ou `v2 · IP ajustée ⓘ`. Un clic ouvre l'explication (§5).

### 3.3 Colonne IP (l. 554)

- En-tête `IP` inchangé.
- Infobulle : `Indice de Performance` → `Indice de Performance — IP ajustée (v2)`.

### 3.4 Cellule IP (l. 580-602)

- Couleurs inchangées.
- Supprimer `title="Participation insuffisante"` : la ligne sous le tableau le dit, et on la
  voit sur mobile.

### 3.5 Sous le tableau (l. 608-613, remplace la note actuelle)

Texte actuel :
> Les indices de performance en rouge indiquent que le joueur n'a pas atteint le nombre de
> participation requis pour obtenir un indice de performance fiable.

Texte proposé :
> ★ **115 et plus** : domination · **105 à 115** : au-dessus du lot · **95 à 105** : dans la
> moyenne · **moins de 95** : en dessous
>
> En rouge : moins de **N** tournois joués sur **M** (40 % minimum). Cet IP est donné à titre
> indicatif.

Chaque palier de la légende est écrit dans la couleur de la cellule correspondante.

### 3.6 Podium (récap IP seulement, l. 637, 654, 671)

- `112.35 points` → `112.35 IP`. Aujourd'hui, une valeur d'IP y est présentée comme des points.
- Récap Stakhanov (l. 635, 652, 669) : `1234 points`, inchangé (ce sont bien des points).

### 3.7 Carte « Évolution de l'IP » (l. 759)

- Titre inchangé.
- Infobulle d'un point (l. 1338-1339) :

```
Pseudo
Position : 3
Points : 72
IP du tournoi : 123.53
IP après ce tournoi : 108.20      ← était « IP total : »
```

- Axe vertical (l. 1347) : `IP`, inchangé.

### 3.8 Carte « IP pur gagné par tournoi » (l. 777)

| Élément | Avant | Après |
|---|---|---|
| Titre de la carte | `IP pur gagné par tournoi` | `IP de chaque tournoi` |
| Infobulle (l. 1461) | `IP pur : …` | `IP du tournoi : …` |
| Axe vertical (l. 1469) | `IP pur` | `IP du tournoi` |
| Valeur de légende (l. 1422) | `title="IP pur moyen par match"` | `title="Moyenne des IP de tournoi"` |

---

## 4. Classement, onglet Saison — `/classement?vue=saison` (`frontEnd/templates/classement_saison.html`)

Ici, c'est toujours l'IP, dans la version du réglage en cours. La saison est en cours : **N**
augmente au fil des tournois.

| Emplacement | Avant | Après |
|---|---|---|
| Sous-titre (l. 91) | `Du … au … · Compétition Indice de Performance (IP)` | inchangé |
| Tuile (l. 123) | `Leader (IP)` | inchangé |
| Titre de carte (l. 130) | `Classement de saison (IP)` | `Classement de saison` + badge `v2 · IP ajustée ⓘ` |
| Colonne IP (l. 152) | infobulle `Indice de Performance` | `Indice de Performance — IP ajustée (v2)` |
| Colonne Écart (l. 155) | infobulle `Écart d'IP avec le leader du championnat` | `Écart d'IP avec le leader` |
| Cellule IP (l. 179-201) | `title="Participation insuffisante"` | supprimé (même raison qu'au §3.4) |
| Graphique d'évolution (l. 407-408) | `IP total : …` | `IP après ce tournoi : …` |

**Sous le tableau** (l. 219-224, remplace la note actuelle)

Texte actuel :
> Les indices en rouge indiquent que le joueur n'a pas encore atteint le nombre de
> participations requis pour un IP fiable.

Texte proposé :
> *(même légende des couleurs qu'au §3.5)*
>
> En rouge : pas encore assez de tournois joués (**N** sur **M** minimum pour l'instant). Ces
> joueurs ne peuvent pas encore prendre la tête, et le minimum augmente à chaque nouveau tournoi.

**Modale** : cette page n'en a pas. On ajoute la même que dans le récap (§5).

---

## 5. La modale d'explication (partagée)

À créer une fois (`frontEnd/templates/partiels/explication_ip.html`) et à inclure dans les deux
pages. Elle s'ouvre par le badge, et par le `?` du bandeau d'un récap IP.

**Titre** : `Comment se calcule l'IP`

**Ligne sous le titre** (petite, grise) :
- récap : `Version utilisée pour ce récap : v2 · IP ajustée`
- classement : `Version utilisée pour le classement en cours : v2 · IP ajustée`

### 5.1 Texte v1 · IP brute

> L'IP mesure à quel point vous dominez vos lobbies, tournoi après tournoi.
>
> **À chaque tournoi**, vos points sont comparés à la moyenne de votre lobby. Faire exactement
> la moyenne vaut 100 ; faire 20 % de plus vaut 120. Un tournoi rapporte au maximum 150, même
> si vous écrasez tout le monde.
>
> **Sur la saison**, votre IP est la moyenne de vos tournois. Les lobbies bien remplis pèsent
> plus lourd : un tournoi à 12 joueurs compte environ deux fois plus qu'un tournoi à 4.
>
> **Assiduité** — Pour être classé, il faut avoir joué au moins 40 % des tournois. Sur cette
> saison : **N** sur **M**. Chaque tournoi joué au-delà ajoute 0,3 point. Quand ce minimum
> tombe entre deux tournois (40 % de 7 = 2,8), le premier tournoi au-dessus rapporte un peu moins.
>
> Dans cette version, seuls les points comptent : le niveau de vos adversaires n'entre pas en jeu.

### 5.2 Texte v2 · IP ajustée

> L'IP mesure à quel point vous dominez vos lobbies, tournoi après tournoi, en tenant compte
> du niveau de vos adversaires.
>
> **À chaque tournoi**, vos points sont comparés à la moyenne de vos adversaires ; les vôtres
> n'en font pas partie. Le résultat est ensuite ajusté selon le niveau que TrueSkill leur
> attribue. Face à un lobby plus fort que la moyenne des joueurs classés ce jour-là, il monte ;
> face à un lobby plus faible, il baisse, d'environ 2 % par point de niveau d'écart. Un tournoi
> rapporte au maximum 150.
>
> **Sur la saison**, votre IP est la moyenne de vos tournois. Les lobbies bien remplis pèsent
> un peu plus lourd : un tournoi à 12 joueurs compte environ 1,4 fois plus qu'un tournoi à 4.
>
> **Assiduité** — *(identique à la v1)*
>
> Ici, 100 correspond à une performance moyenne face à des adversaires de niveau moyen. Cette
> version sert surtout quand une soirée est coupée en plusieurs lobbies de niveaux différents :
> à performance égale, le lobby le plus relevé rapporte davantage.

### 5.3 Fin de la modale

La légende des couleurs du §3.5, pour qu'elle soit lisible aussi sur mobile.

### 5.4 Simplifications assumées

- « Niveau » désigne le **Mu**, pas le score TrueSkill affiché dans le classement (Mu − 3σ).
  Le public ne voit jamais le Mu : un joueur ne peut pas refaire le calcul exact, mais le sens
  est juste.
- Les bornes de la correction v2 (×0,5 / ×2) ne sont pas mentionnées : il faut un lobby à
  25 points de Mu sous la référence pour toucher la première, à 50 au-dessus pour la seconde.

---

## 6. Admin › Réglages (`frontEnd/templates/admin_reglages.html:106-123`)

| Emplacement | Avant | Après |
|---|---|---|
| Titre de l'encadré | `Indice de Performance (IP) du classement de saison en cours` | `Version de l'IP — classement de la saison en cours` |
| Choix v1 | `v1` perf brut | **`v1 · IP brute`** — Compare les points de chaque joueur à la moyenne de son lobby. Le niveau des adversaires ne compte pas. |
| Choix v2 | `v2` applique une force de lobby à la perf du joueur | **`v2 · IP ajustée`** — Même comparaison, corrigée par le niveau (Mu) du lobby : bien jouer contre plus fort rapporte plus. Utile quand une session est coupée en lobbies de niveaux différents. |
| Aide | Pilote uniquement le classement de saison en cours. Les récaps déjà générés ne bougent pas. | S'applique tout de suite au classement de la saison en cours. Chaque récap garde la version choisie à sa création. |

---

## 7. Admin › Saisons (`frontEnd/templates/admin_saisons.html`)

### 7.1 Formulaire de création d'un récap (l. 463-480)

| Emplacement | Avant | Après |
|---|---|---|
| Libellé | `Version de l'IP` | `Version de l'IP de ce récap` |
| Choix v1 | `v1` Formule actuelle | mêmes textes qu'au §6 |
| Choix v2 | `v2` Corrige le déséquilibre entre lobbies d'une même session | mêmes textes qu'au §6 |
| Aide | Figée définitivement pour ce récap à sa création (n'affecte jamais les récaps déjà générés). | Pré-cochée sur la version du classement en cours. Ce récap gardera cette version, même si le réglage change ensuite. Ses chiffres, eux, suivent les tournois de la période : corriger un tournoi les met à jour. |

### 7.2 Liste des récaps (`loadSaisons`, l. 798+)

- **Nouveau** : badge `IP v1` ou `IP v2` après `Annuel` / `Saison`, avec l'infobulle `IP brute`
  ou `IP ajustée`. La donnée est déjà dans la réponse de l'API (`routes_admin.py:1393`).

### 7.3 Fenêtre de publication, mouvements inter-ligue (l. 628-629)

- `Indice de Performance (classement de la saison)` →
  `Indice de Performance de ce récap (v2 · IP ajustée)`.
- Raison : les mouvements sont calculés avec la version du récap (`routes_admin.py:1612`), pas
  celle du réglage en cours.

---

## 8. Données que le back doit fournir

À ajouter dans les payloads (phase 2 de `affichage-ip-inventaire.md` §8) :

| Champ | Récap (`routes_public.py:358`) | Classement (`routes_public.py:800`) | `/admin/config` |
|---|---|---|---|
| `ip.version` | `saisons.ip_version` | `ip_version_live` | — |
| `ip.textes` (nom, badge, explication, légende) | version du récap | version live | les deux versions (pour les boutons radio) |
| `ip.seuils` (115 / 105 / 95) | ✓ | ✓ | — |
| `ip.minimum_tournois` (**N**) | ✓ | ✓ | — |
| `total_tournois` (**M**) | déjà présent | déjà présent (`recap_stats`) | — |

Tous les textes sont produits par `backEnd/textes_ip.py` (phase 1), avec les nombres au
format français (`0,3`, pas `0.3`).

---

## 9. Décisions — ✅ tranchées le 2026-09-22

Les cinq propositions ont été retenues telles quelles :

1. **Noms** : « IP brute » (v1) / « IP ajustée » (v2).
2. **Séparateur décimal** : le mélange est accepté — virgule dans les textes, point dans les
   tableaux et les graphiques. Passer les tableaux à la virgule sortirait du chantier (le tri,
   lui, n'en souffrirait pas : il lit `data-val`).
3. **Calcul v1 / v2 en parallèle** : supprimé. `compute_ip_evolution` ne calcule que la
   version demandée ; sortie vérifiée identique à l'ancienne sur un jeu de 43 points, en v1
   comme en v2.
4. **Bonus quand le minimum n'est pas un entier** : expliqué (§5), aucun calcul ne change.
5. **Bornes ×0,5 / ×2** : non montrées aux joueurs.

Écarts assumés par rapport aux textes du §3 au §7, relevés en implémentant :

- **Poids d'un lobby de 12 face à un lobby de 4** : calculé, donc « 1,9 fois » en v1 et non
  « deux fois » ; « 1,4 fois » en v2.
- **Ligne sous le tableau du classement** : « pas encore assez de tournois joués (N minimum sur
  M pour l'instant) […] le minimum augmente **au fil des** tournois » — « à chaque nouveau
  tournoi » était faux : 40 % de M n'augmente pas à chaque tournoi.
- **N** vaut `ceil(M × 0,4)`, la même expression que le test d'éligibilité : vérifié de 1 à 40
  tournois, N joués classe et N − 1 ne classe pas.
- **Aides admin** (§6 et §7.1) : restées dans les gabarits, elles ne citent aucun chiffre ni
  aucune version. Les **noms et résumés** des versions, eux, viennent de `/admin/config`.

---

## 10. Avancement

**Phase 1 — Textes côté back** ✅ 22/09
- [x] `backEnd/textes_ip.py` : textes des §5, §6 et §7, construits à partir des constantes.
  ⚠️ Nouveau module : ajouté aux montages du backend dans `docker-compose.yml`, sans quoi il
  resterait figé après le build.
- [x] Constantes des seuils 95 / 105 / 115 dans `constants.py` (`IP_SEUIL_*`)
- [x] Tests : changer une constante change le texte ; les textes v1 et v2 diffèrent
  (`test_textes_ip.py`)

**Phase 2 — Payloads** ✅ 22/09
- [x] Bloc `ip` dans le payload du récap (version **du récap**)
- [x] Bloc `ip` dans le payload du classement de saison (version **du réglage**)
- [x] Textes des deux versions dans `/admin/config` (`ip_textes`)

**Phase 3 — Pages** ✅ 22/09, sauf la recette mobile
- [x] Partiel `partiels/explication_ip.html` (§5) — hors de toute carte : `.fade-in.visible`
  pose un `transform` qui enfermerait la modale
- [x] Macro `partiels/cellule_ip.html` (seuils lus dans le payload ; sans bloc `ip`, la
  valeur s'affiche sans couleur au lieu de planter)
- [x] Récap : badge, légende, ligne sur le rouge, podium, libellés des graphiques (§3)
- [x] Classement : badge, modale, légende, ligne sur le rouge, libellés (§4)
- [x] Admin Réglages (§6)
- [x] Admin Saisons : formulaire, liste, publication (§7)
- [x] Rendu réel vérifié le 22/09 (app frontend, backend simulé) : récap IP v1, IP v2,
  Stakhanov et classement en cours rendent en 200 avec la bonne version
- [x] Affichage validé par l'utilisateur le 22/09

**Phase 4 — Nettoyage** (détail : `affichage-ip-inventaire.md` §8)
- [x] Calcul parallèle v1 / v2 et commentaire faux de `compute_ip_evolution`
- [x] Clés `rulesDescriptions['Indice de Performance']` et `['grand_master']`
- [x] Garde `Indicateur de Performance`
- [x] Branches `grand_master` — **retirées le 2026-09-23**. Vérification faite sur les **14 dumps
  de prod** de `dumps/` (08/07 → 15/09) plutôt qu'en prod : aucune occurrence, ni en saison ni
  en award, et le formulaire des saisons ne peut pas en créer. La clé **interne**
  `candidates['grand_master']` (le classement IP) est gardée, ce n'est pas un reliquat. Si une
  saison `grand_master` apparaissait malgré tout : `UPDATE saisons SET victory_condition =
  'Indice de Performance' WHERE victory_condition = 'grand_master';`. Requêtes d'origine : Deux requêtes à lancer :
  `SELECT DISTINCT victory_condition FROM saisons;` et
  `SELECT code FROM types_awards WHERE code = 'grand_master';`. Si aucune ne renvoie
  `grand_master`, retirer les branches de `services.py` (`_determine_winners`),
  `recap.html` (`is_ip`) et `routes_admin.py` (`code != 'grand_master'`).
