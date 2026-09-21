# Décor de fond : suivi des performances

Journal du travail d'optimisation du décor Mario Kart (motifs en filigrane
derrière toutes les pages). But : un décor qui ne coûte presque rien, ni en
téléchargement ni en fluidité, y compris sur téléphone.

Fichiers concernés :

| Fichier | Rôle |
|---|---|
| `frontEnd/templates/decor.html` | Conteneur `.decor-mk` + chargement du script. Inclus dans 22 pages. |
| `frontEnd/static/js/decor-mk.js` | Bibliothèque des 7 formes (SVG) + semis + parallaxe. |
| `frontEnd/static/css/decor-mk.css` | Habillage, apparition, empilement. |

---

## 1. Point de départ (avant le 21/09/2026)

Le décor était entièrement **en ligne dans `decor.html`** : les formes SVG
(`<defs>`) et le script étaient recopiés dans le HTML de chaque page.

| Élément | Brut | Gzip |
|---|---|---|
| `<defs>` des formes (commentaires Jinja retirés) | 60,0 Ko | 22,8 Ko |
| Script | 13,8 Ko | 4,9 Ko |
| **Total par page vue** | **~74 Ko** | **~28 Ko** |

Le HTML n'étant jamais mis en cache, ces ~28 Ko étaient **retéléchargés à
chaque navigation**. Dix pages visitées ≈ 280 Ko rien que pour le décor.

Répartition des formes (brut) : Bob-omb 28,0 Ko · fleur 18,2 Ko · banane
5,8 Ko · carapace 4,6 Ko · champignon 2,2 Ko · étoile 0,6 Ko · éclair 0,3 Ko.

---

## 2. Fait le 21/09/2026

### 2.1 Poids téléchargé

1. **Décor sorti du HTML** vers `static/js/decor-mk.js`, chargé en `defer`
   avec `?v={{ app_version }}`. Le fichier est mis en cache par le navigateur
   (nginx : `expires 7d`) et servi compressé (le type `application/javascript`
   fait partie des `gzip_types`).
2. **Tracés allégés**, sans changement visible :
   - coordonnées arrondies à l'entier dans les formes vectorisées (banane,
     Bob-omb, fleur). Sans risque : elles n'utilisent que des commandes
     absolues, donc l'erreur ne s'accumule pas ;
   - lettres de commande répétées retirées (`C … C …` → `C … …`) ;
   - commentaires Jinja et HTML retirés de la bibliothèque ;
   - silhouette de la Bob-omb retracée sur l'image ×2 au lieu de ×4
     (18,4 Ko → 10,1 Ko pour ce seul tracé).
3. **Cache-buster `?v=` ajouté au lien `decor-mk.css`** dans les 22 pages :
   sans lui, un déploiement pouvait laisser l'ancien CSS jusqu'à 7 jours.

**Résultat :**

| | Brut | Gzip |
|---|---|---|
| `decor.html` (dans chaque page) | 1,3 Ko | 0,7 Ko |
| `decor-mk.js` (une fois, puis en cache) | 53,7 Ko | 20,8 Ko |

- Première page : ~21 Ko au lieu de ~28 Ko.
- **Pages suivantes : ~0,7 Ko au lieu de ~28 Ko.**

Contrôle visuel : chaque forme a été rendue avant et après à 260 px (taille
maximale du décor), en blanc sur noir pour pousser le contraste. Écart :
0 px pour 4 formes, 21 px (fleur), 41 px (banane) et 138 px (Bob-omb) sur
67 600, uniquement de l'anticrénelage sur les bords. Invisible avec la vraie
teinte du décor.

### 2.2 Fluidité

1. **Parallaxe coupée sur écran tactile** (`pointer: coarse`) : sur téléphone,
   le défilement tourne sur le compositeur et les événements `scroll` arrivent
   en retard. Le JS déplaçait les motifs une ou deux images après la page,
   d'où les saccades constatées.
2. **Hauteur du décor en `100lvh`** au lieu de `inset: 0` : quand la barre
   d'adresse mobile se repliait, le cadre changeait de taille et les motifs
   (placés en `top: %`) sautaient.
3. **Parallaxe sur ordinateur allégée** :
   - `zone.children` (liste vivante) remplace le `querySelectorAll` qui
     s'exécutait à chaque image ;
   - plus aucun calcul au-delà de la butée : passé ~6,5 écrans de
     défilement, tous les motifs sont à leur déplacement maximal.
4. **`contain: strict` sur `.decor-mk`** : ce qui s'y passe ne déclenche plus
   de recalcul de mise en page ailleurs.
5. Suppression d'une règle CSS sans effet (opacité 0.4 sur mobile, toujours
   écrasée par `.est-apparu`).

### 2.3 Vérifié

- Syntaxe JS validée par un analyseur (esprima).
- Test réel dans Chromium sans interface (Playwright), page minimale avec
  les vrais CSS et JS :
  - ordinateur 1440×900 : 21 motifs, les 7 formes présentes, parallaxe
    active (`--para` = −261 px après défilement), aucune erreur ;
  - téléphone 390×844 tactile : 10 motifs, 7 formes, parallaxe bien coupée
    (`--para` = 0), aucune erreur.
- **Pas encore vérifié** : dans l'application complète (navbar, voile de la
  page d'accueil, pages admin) et sur un vrai téléphone.

---

## 3. Pistes restantes (par gain attendu)

### A. Poids

1. **Minifier `decor-mk.js` au déploiement.** Les commentaires pèsent lourd :
   code seul 5,7 Ko gzip avec commentaires, 2,0 Ko sans. Gain ~3,7 Ko gzip.
   Il faudrait une étape de build (esbuild, terser) : il n'y a pas de Node
   sur le poste de dev actuel, à prévoir dans le Makefile ou l'image Docker.
   Garder le fichier commenté comme source.
2. **Cache long et `immutable`.** Comme les URL sont versionnées (`?v=`),
   les statiques pourraient partir en `Cache-Control: public, max-age=31536000,
   immutable` au lieu de `expires 7d` + `must-revalidate`. Les visiteurs
   réguliers ne referaient plus aucune requête de revalidation. À faire dans
   `nginx/snippets/app.conf`, **en vérifiant que TOUTES les URL statiques
   portent `?v=`**, sinon un déploiement resterait invisible pendant un an.
3. **Brotli** (`ngx_brotli`) : ~15-20 % de moins que gzip sur du texte.
   Demande un module nginx : à évaluer selon l'image utilisée.
4. **Formes encore lourdes** (bibliothèque actuelle, brut) : Bob-omb 16,9 Ko,
   fleur 11,4 Ko, alors que le reste fait moins de 4 Ko par forme. Pistes :
   - Bob-omb : modéliser le corps en cercle exact (comme les ellipses de la
     fleur) et ne tracer que la clé, les pieds et le bouchon ;
   - fleur : les feuilles (~10 Ko) pourraient être refaites en quelques
     courbes de Bézier ajustées au contour, comme la tête l'a été en ellipses ;
   - vérifier chaque version avec la comparaison pixel décrite en 2.1.
5. **Si la bibliothèque passe un jour en fichier `.svg`** séparé (sprite
   externe) : ajouter `image/svg+xml` aux `gzip_types` de `nginx/nginx.conf`,
   sinon il partirait non compressé. Attention aussi : les styles de la page
   ne s'appliquent pas à l'intérieur d'un `<use>` qui pointe vers un fichier
   externe. `.decor-creux` devrait alors être défini dans le sprite lui-même.

### B. Fluidité et rendu

1. **Parallaxe en CSS pur** (`animation-timeline: scroll()`) : elle
   tournerait sur le compositeur, sans JS. Elle serait alors assez fluide pour
   être **réactivée sur téléphone**. Support : Chrome/Edge 115+, Safari 26+,
   Firefox derrière un réglage. Contraintes :
   - l'animation écrase `transform` en entier, donc il faut un conteneur par
     motif (le conteneur porte la parallaxe, le `<svg>` garde la rotation et
     le « pop ») ;
   - l'amplitude par motif passe par `animation-range` ou une variable ;
   - garder le JS actuel en repli via `@supports`.
2. **Mesurer le coût de rendu** avant d'ajouter `will-change: transform` :
   ~20-30 calques promus coûtent de la mémoire GPU, surtout sur mobile.
   À décider sur un vrai relevé DevTools (onglet Performance, case
   « Screenshots » et « Layers »), pas à l'intuition.
3. **Semis en `requestIdleCallback`** : génération et animation d'apparition
   pourraient attendre que le navigateur soit libre, pour ne pas concurrencer
   le premier affichage. À mesurer : le semis complet est déjà court (moins de
   30 éléments).
4. **Onglet caché** : les `setTimeout` d'apparition continuent de tourner.
   Négligeable aujourd'hui, à revoir si l'animation se complique.

### C. Robustesse

1. **`recap_list.html` est rendue par le backend** (`backEnd/routes_public.py`),
   qui ne définit pas `app_version` : le lien y devient `?v=` vide. Ça
   fonctionne, mais sans forcer le rechargement après un déploiement. Solution :
   un `context_processor` équivalent côté backend, ou une version partagée.
2. `APP_VERSION` est écrit à la main dans `frontEnd/frontend.py` : un
   déploiement sans incrément garde les anciens fichiers en cache. À lier au
   hash du commit ou au contenu des fichiers.

---

## 4. Protocole de mesure

Pour que chaque étape se compare à la précédente :

1. **Poids** : taille brute et gzip de `decor-mk.js` et de `decor.html`
   (`gzip -c fichier | wc -c`), et poids par forme dans la bibliothèque.
2. **Réseau** : DevTools → Réseau, cache désactivé puis activé. Relever les
   octets transférés sur une première visite, puis sur une deuxième page.
3. **Rendu** : DevTools → Performance, sur un vrai téléphone (débogage USB) :
   défilement d'une page longue pendant 5 s, relever les images perdues et
   le temps de « Paint » / « Composite ».
4. **Lighthouse** (mobile) sur l'accueil et une page de classement : Total
   Blocking Time et Cumulative Layout Shift, avant/après.
5. **Fidélité visuelle** : toute retouche de tracé passe par la comparaison
   pixel avant/après (rendu 260 px, seuil 25 % d'écart), sans accepter
   d'écart en dehors des bords.
