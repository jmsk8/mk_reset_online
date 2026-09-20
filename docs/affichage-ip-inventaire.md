# Affichage de l'Indice de Performance (IP) — inventaire + plan de nettoyage

> **État : analyse seule, aucun code modifié (20/09/2026).** Ce document recense tous les
> endroits où l'IP est affichée ou décrite dans le site, et les défauts relevés. Rien n'est
> commité — l'utilisateur fait ses commits lui-même ([[user-handles-commits]]).
>
> Point de vocabulaire important : dans ce dépôt, **« IP » signifie *Indice de Performance***,
> jamais une adresse réseau. Les rares occurrences d'adresse IP (page confidentialité, log de
> callback Discord, commentaires de schéma sur le non-stockage) sont **hors périmètre** de ce
> document et listées au §6 uniquement pour lever l'ambiguïté du sigle.

---

## 1. Récap de saison — `frontEnd/templates/recap.html`

C'est la page qui contient le plus d'affichages IP, et la **seule** qui explique ce qu'est l'IP.

| Ligne | Ce qui est affiché |
|---|---|
| 396-397 | Sous-titre hero : `Compétition Indice de Performance (IP)`, conditionné sur `victory_condition == 'Indice de Performance' or == 'grand_master'` |
| 403-408 | Icône `?` (`far fa-question-circle`) qui appelle `openRulesModal(victory_condition)` |
| 552-553 | En-tête de colonne `IP`, tri par `sortTable('ip')`, `title="Indice de Performance"` |
| 578-600 | Cellule IP : coloration par seuil + cas non-éligible |
| 757 | Titre de carte `Évolution de l'IP` |
| 775 | Titre de carte `IP pur gagné par tournoi` |
| 914-928 | Modale `rulesModal`, titre `Règles de Victoire` |
| 1046-1047 | **Les descriptions longues de l'IP** (objet JS `rulesDescriptions`) |
| 1055 | `openRulesModal` réalias `grand_master` → `'Indice de Performance'` |
| 1336-1337 | Tooltips graphique : `IP du tournoi :` / `IP total :` |
| 1345 | Titre d'axe Y `IP` |
| 1420 | `title="IP pur moyen par match"` sur la valeur de légende |
| 1459 | Tooltip `IP pur :` |
| 1467 | Titre d'axe Y `IP pur` |

Texte exact de la description (ligne 1046, et copie identique ligne 1047) :

> **L'Indice de Performance (IP)** — Évalue la dominance relative et la régularité. L'IP compare
> votre score à la moyenne du lobby, pondéré par le nombre de participants. Une base de 100
> représente la moyenne. Un bonus d'assiduité de +0,3 pt est ajouté pour chaque tournoi joué
> au-delà du seuil de qualification de 40%.

---

## 2. Classement de saison — `frontEnd/templates/classement_saison.html`

Inclus par `classement.html:144` (vue `?vue=saison`), donc partage son contexte de rendu.

| Ligne | Ce qui est affiché |
|---|---|
| 91 | `Compétition Indice de Performance (IP)` — **écrit en dur**, non conditionné par `victory_condition` (contrairement au récap) |
| 123 | Tuile de stat `Leader (IP)` |
| 130 | Titre de carte `Classement de saison (IP)` |
| 152-153 | Colonne `IP`, tri `sortSaisonTable('ip')`, `title="Indice de Performance"` |
| 155-156 | Colonne `Écart`, `title="Écart d'IP avec le leader du championnat"` |
| 178-201 | Cellule IP — **copie littérale** du bloc `recap.html:578-600` |
| 202-213 | Cellule écart : `leader` si en tête, sinon l'écart négatif formaté |
| 232 | Titre de carte `Évolution de l'IP au fil des tournois` |
| 407-408 | Tooltips `IP du tournoi :` / `IP total :` |
| 418 | Titre d'axe Y `IP` |

**Cette page n'a aucune modale d'explication** : elle affiche l'IP, l'écart, les couleurs et le
statut d'éligibilité sans jamais dire ce que ça signifie. Le `?` n'existe que dans le récap.

### Le bloc de cellule dupliqué (recap.html:578-600 ≡ classement_saison.html:178-201)

Environ 23 lignes identiques dans les deux fichiers :

- non-éligible → `has-text-danger`, `opacity: 0.9`, `title="Participation insuffisante"`
- `score_gm >= 115` → `has-text-warning has-text-weight-bold`, préfixé d'une étoile `★`
- `score_gm >= 105` → `has-text-success has-text-weight-bold`
- `score_gm >= 95` → `has-text-white`
- `< 95` → `has-text-white` avec `opacity: 0.6`
- `score_gm is none` → tiret `-` en `has-text-grey-light`

---

## 3. Admin — Réglages : `frontEnd/templates/admin_reglages.html:104-121`

Encadré vert (`border: 1px solid #22c55e`) :

- Label : `Indice de Performance (IP) du classement de saison en cours`
- Radio **v1** : « perf brut »
- Radio **v2** : « applique une force de lobby à la perf du joueur »
- Aide : « Pilote uniquement le classement de saison en cours. Les récaps déjà générés ne bougent pas. »

## 4. Admin — Saisons : `frontEnd/templates/admin_saisons.html`

| Ligne | Ce qui est affiché |
|---|---|
| 461-477 | Label `Version de l'IP` ; **v1** = « Formule actuelle », **v2** = « Corrige le déséquilibre entre lobbies d'une même session » ; aide « Figée définitivement pour ce récap à sa création (n'affecte jamais les récaps déjà générés). » |
| 626-628 | Radio de critère des mouvements inter-ligue : `Indice de Performance (classement de la saison)` (valeur `ip`, alternative `trueskill`) |
| 723-730 | Option de condition de victoire injectée en JS : libellé `Indice de Performance`, emoji 🎯 |
| 737 | Filtre qui ignore `"Indice de Performance"` **et** une variante fantôme `"Indicateur de Performance"` |

Le critère `ip` est consommé côté back dans `routes_admin.py` aux lignes 1630, 1680 et 1732.

## 5. Base de données — la description stockée

`backEnd/schema.sql:536` (identique dans `seed.sql:54` et `dump.sql:1946`) :

```sql
('Indice de Performance', 'Indice de Performance', '🎯', 'Calcul IP');
```

La description en base vaut **`Calcul IP`**. Elle n'est pas affichée dans les écrans IP
recensés ci-dessus, mais constitue une troisième source de vérité pour le libellé.

Côté back, `routes_public.py:734` renvoie `"victory_condition": "Indice de Performance"` comme
valeur par défaut, et `services.py:1361` teste `vic_cond == 'grand_master' or vic_cond ==
'Indice de Performance'`.

**Vérifié dans les données** (`grep` sur `backEnd/dump.sql`) : les seules valeurs de
`victory_condition` présentes sont `Indice de Performance` (×3) et `stakhanov` (×12).
**`grand_master` n'apparaît dans aucune donnée** — c'est du code de compatibilité pour une
valeur historique qui n'existe plus dans ce dump. De même, `Indicateur de Performance`
n'apparaît **qu'à la seule ligne `admin_saisons.html:737`** et nulle part ailleurs dans le
dépôt ni en base : c'est une garde défensive contre une faute de frappe jamais advenue.

---

## 6. Hors périmètre — les vraies adresses IP réseau

Listé pour mémoire, afin que personne ne confonde les deux sens du sigle :

- `frontEnd/templates/confidentialite.html:37, 58, 90` — texte RGPD sur les journaux serveur et
  le non-enregistrement de l'adresse IP
- `frontEnd/frontend.py:912` — `logger.warning("Callback Discord sans state (IP %s)", request.remote_addr)`
- `backEnd/schema.sql:463` et `migrations/2026-09-02_auth_discord.sql:125` — commentaires
  documentant que les sessions **ne stockent pas** d'IP (`user_agent` suffit)
- `backEnd/routes_comptes.py:2227`, `tests/test_auth.py:21`, `tests/test_profils.py:91` —
  commentaires sur le relais d'avatar Discord, qui évite de livrer l'IP des visiteurs à Discord

Le projet ne persiste aucune adresse IP : rien à nettoyer de ce côté.

---

## 7. Les constantes réellement appliquées (`backEnd/constants.py`)

Les textes affichés citent des valeurs chiffrées qui vivent en dur dans le HTML/JS, alors
qu'elles sont définies côté back :

| Constante | Valeur | Ligne | Citée dans l'UI ? |
|---|---|---|---|
| `MIN_PARTICIPATION_RATIO` | `0.4` | constants.py:47 | oui — « seuil de qualification de 40% » en dur dans recap.html:1046 |
| `GM_EXTRA_MATCH_BONUS` | `0.3` | constants.py:54 | oui — « +0,3 pt » en dur dans recap.html:1046 |
| `GM_MAX_RATIO_CAP` | `1.5` | constants.py:49 | non |
| `GM_MAX_IP` | `150.0` | constants.py:52 | **non** — plafond dur réellement appliqué (`services.py:744, 967-968`), jamais annoncé |
| `GM_BASE_WEIGHT_V1` / `_V2` | `5.0` / `15.0` | constants.py:58-59 | non |
| `IP_V2_FORCE_LOBBY_PER_MU` | `0.02` | constants.py:70 | non |
| `IP_V2_FORCE_LOBBY_MIN` / `_MAX` | `0.5` / `2.0` | constants.py:71-72 | non |
| `IP_VERSION_DEFAULT` | `"v1"` | constants.py:73 | non |
| `IP_V2_REF_REQUIRE_TIER` / `_RANKED` | `True` / `True` | constants.py:80-81 | non |
| `REFERENCE_PLAYER_COUNT` | `12.0` | constants.py:55 | seulement dans la description Stakhanov (recap.html:1045) |

Les seuils d'affichage **95 / 105 / 115** n'ont aucune constante côté back : ils n'existent
que dupliqués dans les deux gabarits.

---

## 8. Défauts relevés

1. **Description dupliquée, dont une copie morte** — `recap.html:1046-1047` contient deux fois
   le même paragraphe sous les clés `'Indice de Performance'` et `'grand_master'`, alors que la
   ligne 1055 réalias déjà `grand_master` vers la première. La clé `'grand_master'` est
   inatteignable.
2. **Bloc de cellule IP copié-collé** entre `recap.html:578-600` et
   `classement_saison.html:178-201` — ~23 lignes identiques à maintenir en double.
3. **Seuils 95 / 105 / 115 magiques** — codés en dur dans les deux gabarits, sans constante
   back, et **sans aucune légende** expliquant ce que chaque couleur signifie.
4. **Le classement de saison n'explique rien** — il affiche IP, écart, couleurs et éligibilité
   sans modale ni renvoi ; l'icône `?` n'existe que dans le récap.
5. **Libellés concurrents pour une même notion** — `Indice de Performance`, `IP`,
   `grand_master`, `score_gm`, `Calcul IP` (en base), plus la variante fantôme
   `Indicateur de Performance` filtrée en `admin_saisons.html:737`.
6. **v1 / v2 décrits en deux vocabulaires différents** selon l'écran admin :
   - Réglages : « perf brut » / « applique une force de lobby à la perf du joueur »
   - Saisons : « Formule actuelle » / « Corrige le déséquilibre entre lobbies d'une même session »
7. **Valeurs chiffrées désynchronisables** — « 40% » et « +0,3 pt » sont écrits en dur dans un
   littéral JS ; changer `MIN_PARTICIPATION_RATIO` ou `GM_EXTRA_MATCH_BONUS` rendrait la
   description mensongère sans aucun signal.
8. **Plafond invisible** — `GM_MAX_IP` (150) écrête réellement les scores mais n'est mentionné
   nulle part côté utilisateur, qui ne peut pas comprendre pourquoi une IP plafonne.
9. **`title="Participation insuffisante"` en tooltip natif** — invisible au tactile, alors que
   c'est l'information qui explique pourquoi un joueur est affiché en rouge et hors course.
10. **`classement_saison.html:91` annonce « Compétition Indice de Performance (IP) » en dur**,
    même si la saison courante utilise une autre `victory_condition` (Stakhanov, etc.).

---

## 9. Plan de nettoyage proposé (à valider, rien n'est fait)

### Phase 1 — Dédoublonner l'affichage
- Créer `frontEnd/templates/partiels/cellule_ip.html` (macro Jinja `cellule_ip(joueur)`),
  l'appeler depuis `recap.html` et `classement_saison.html`.
- Y inclure les seuils, sortis en variables plutôt qu'en littéraux.

### Phase 2 — Une seule source de vérité pour les textes
- Descendre les descriptions IP / v1 / v2 côté back (`constants.py` ou un module de libellés),
  construites par f-string à partir des constantes réelles (`MIN_PARTICIPATION_RATIO`,
  `GM_EXTRA_MATCH_BONUS`, `GM_MAX_IP`) pour supprimer le risque de désynchronisation.
- Les exposer au gabarit ; supprimer la clé morte `'grand_master'`.
- Harmoniser le vocabulaire v1/v2 entre `admin_reglages.html` et `admin_saisons.html`.

### Phase 3 — Rendre l'IP compréhensible
- Ajouter la modale d'explication (ou un renvoi) au classement de saison.
- Ajouter une **légende des seuils** visible sous chaque tableau (★ ≥115 / ≥105 / ≥95 / <95 /
  rouge = participation insuffisante), au lieu de couleurs muettes.
- Remplacer les `title=` natifs par un affichage visible au tactile.
- Mentionner le plafond de 150 dans la description.

### Phase 4 — Vocabulaire
- Retenir `Indice de Performance` comme libellé canonique (c'est déjà la seule valeur IP
  présente en base).
- `grand_master` : absent des données du dump, mais la prod peut porter autre chose — vérifier
  sur la prod avant de retirer les branches de compatibilité (`services.py:1361`,
  `recap.html:396` et `1055`), la base de prod contenant des données réelles
  (cf. [[repo-public-donnees-reelles-historique]]).
- `Indicateur de Performance` : garde défensive sans contrepartie nulle part — supprimable
  telle quelle en `admin_saisons.html:737`.
