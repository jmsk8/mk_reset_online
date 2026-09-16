# Audit — 503 récurrents sur les pages admin

> **Statut : CORRIGÉ le 2026-09-18, en trois vagues.** Le corps de ce document (§1 à §9) est le
> diagnostic d'origine, conservé tel quel : il avait identifié le bon mécanisme pour le 503, mais
> pas la cause de l'intermittence, et pas le défaut qui touchait aussi les visiteurs non connectés.
>
> **Lire le §12 en premier** : il explique pourquoi le symptôme a survécu aux deux premières
> vagues — la configuration corrigée n'était jamais entrée en service, et deux affirmations de ce
> document étaient fausses. Puis le §10 (l'amplification applicative, 9 → 4 appels backend par
> page) et le §11 (le budget de la zone, recalibré sur une mesure, et les avatars qui consommaient
> le limiteur pour tout le monde).
>
> Symptôme signalé : après plusieurs rafraîchissements d'une page admin, la page tombe en 503,
> puis se charge partiellement avec « Erreur Backend » sur la liste des joueurs. Puis, second
> signalement : le même comportement en production, **sans compte admin**.

## 1. Ce qui est établi, preuve à l'appui

Les journaux nginx fournis par l'utilisateur tranchent la question :

```
2026/09/16 17:45:38 [error] limiting requests, excess: 10.872 by zone "admin",
    client: 192.168.1.20, request: "GET /admin/joueurs HTTP/1.1"
```

**Le 503 vient du rate limiter de nginx, pas de l'application.** `limiting requests` est le message
de `ngx_http_limit_req_module`. Ni le backend ni le frontend ne sont sollicités : nginx rejette
avant de relayer.

Conséquences directes :

- **Ce n'est pas lié au changement de droits.** Le limiteur compte des requêtes par IP et ne sait
  rien des permissions. L'utilisateur l'avait pressenti (« je ne suis même pas sûr que ce soit dû
  au changement de droit ») — les journaux lui donnent raison.
- **Ce n'est pas une saturation des workers gunicorn**, contrairement au diagnostic posé plus tôt
  dans la session. Cette théorie était plausible (2 workers, appel réseau synchrone dans le rendu)
  mais les journaux ne la soutiennent pas : un worker saturé produirait un timeout amont
  (`upstream timed out`), pas `limiting requests`.
- **Le comportement « charge partiellement »** s'explique : le document HTML passe (il était encore
  dans le budget), mais ses appels JSON suivants sont rejetés. D'où une page rendue, vide de ses
  données, avec l'erreur du JS sur la liste des joueurs.

## 2. Pourquoi les corrections déjà appliquées n'ont pas suffi

Deux changements ont été faits, tous deux justifiés, aucun suffisant :

| Changement | Effet réel |
|---|---|
| `rate=30r/m` → `2r/s` (`nginx.conf`) | Débit ×4. Vrai gain, mais voir §3. |
| `burst=10` → `20` (`snippets/app.conf`) | Réserve ×2. Vrai gain, mais voir §4. |
| Doublon `/admin/tiers` supprimé (`gestion.js`) | 5 → 4 requêtes par page. Gain marginal. |

L'erreur de méthode : ces trois ajustements traitent le **budget**, en supposant que la
consommation était correctement estimée. Le §3 montre qu'elle ne l'était pas.

## 3. Théorie principale — la consommation réelle par page est sous-estimée

Le calcul qui a servi à fixer `2r/s` comptait **4 à 5 requêtes par ouverture de page**. Deux
éléments non pris en compte le rendent optimiste.

### 3.1 La navbar tape sur chaque page

`navbar.html` appelle `/admin/notifications` — et elle est incluse dans **toutes** les pages admin.
Ce coût n'est pas propre à la page Fiches joueurs : il s'ajoute à chaque navigation, y compris
celles où l'on ne fait que passer.

### 3.2 Un rafraîchissement n'est pas une ouverture

Le point décisif, et celui qui manque à l'analyse précédente. Lors d'un rechargement manuel
(F5, et *a fortiori* Ctrl-Shift-R), le navigateur **revalide ou recharge** les ressources. Les
fichiers statiques sont exemptés — le bloc `location ~* \.(js|css|...)$` est prioritaire sur
`location /admin`, ce qui est correct et vérifié — mais **chaque appel JSON repart intégralement**,
aucun n'étant mis en cache.

Un utilisateur qui teste enchaîne les rafraîchissements en quelques secondes. À 4 requêtes par
rechargement, **5 rafraîchissements en 10 secondes = 20 requêtes**, là où le débit de `2r/s` n'en
reconstitue que 20 sur la même durée. Le budget tient tout juste, et la moindre rafale
supplémentaire (voir §4) le fait basculer.

### 3.3 Hypothèse à vérifier en priorité

**Combien de requêtes une ouverture de page génère-t-elle réellement ?** Le comptage a été fait en
lisant le code (`grep` des appels), ce qui rate : les appels conditionnels, ceux déclenchés par un
`include` de gabarit, et surtout les redemandes du navigateur. La mesure doit être faite **dans
l'onglet Réseau du navigateur**, filtré sur `/admin`, en comptant une ouverture puis un
rafraîchissement.

C'est le chiffre qui manque, et sans lui tout réglage de la zone reste une devinette.

## 4. Théorie secondaire — `nodelay` rend la réserve trompeuse

```nginx
limit_req zone=admin burst=20 nodelay;
```

Avec `nodelay`, les requêtes de la réserve passent **immédiatement** au lieu d'être lissées. C'est
voulu (sans lui, une page mettrait plusieurs secondes à charger, chaque appel attendant son tour),
mais l'effet de bord est important :

> La réserve se vide d'un coup, et se reconstitue lentement — au rythme du `rate`, soit une place
> toutes les 0,5 s à `2r/s`.

Après une rafale qui vide les 20 places, il faut **10 secondes** pour revenir à pleine réserve. Un
utilisateur qui rafraîchit toutes les 2 ou 3 secondes ne laisse jamais le compteur remonter : il
consomme plus vite qu'il ne régénère, et finit mécaniquement en 503 après quelques cycles. **Le
symptôme apparaît après « plusieurs refresh », exactement comme décrit.**

Ceci explique aussi pourquoi l'augmentation de `burst` a repoussé le problème sans le supprimer :
elle agrandit le réservoir, elle ne change pas le débit de remplissage.

## 5. Théorie tertiaire — amplification par la page d'erreur

Aucune directive `error_page` ne traite le 503 : nginx sert sa page par défaut. Lorsque le
**document HTML** est rejeté, le navigateur affiche cette page d'erreur, et l'utilisateur
rafraîchit aussitôt — ce qui consomme une requête de plus sur un budget déjà vide.

Plus net encore dans les journaux fournis : le 503 sur `/admin/joueurs-fiches` est suivi d'un
`GET /favicon.ico` **404**. Le navigateur, sur une page d'erreur nue, redemande le favicon qu'une
page normale lui aurait fourni. Ce n'est pas la cause, mais cela confirme qu'un 503 engendre du
trafic supplémentaire plutôt que d'en économiser.

À vérifier également : `gestion.js:44` redirige vers `/admin` sur un 401/403. Si un 503 était un
jour interprété comme une session morte, on obtiendrait une boucle de redirection — **ce n'est pas
le cas aujourd'hui** (la condition porte bien sur 401/403 seulement), mais c'est le genre de
mécanisme à ne pas introduire par inadvertance en corrigeant.

## 6. Piste écartée, et pourquoi la noter

**`real_ip` mal configuré → toutes les requêtes comptées sur une seule IP.** Vérifié :
`set_real_ip_from` couvre les trois plages privées et `real_ip_header X-Forwarded-For` est bien
posé. Les journaux montrent d'ailleurs la vraie IP du poste (`192.168.1.20`), pas celle d'un
conteneur. **La zone compte bien par client.**

Mention conservée parce que c'est la panne classique de ce module, et qu'elle serait la première
chose à re-suspecter si le problème apparaissait un jour derrière un proxy supplémentaire
(Cloudflare, reverse proxy d'hébergeur), où `real_ip_recursive` et les plages de confiance
devraient être revus.

## 7. Ce qu'il faut mesurer avant de recoder

Dans l'ordre, chacune de ces mesures invalide ou confirme une théorie :

1. **Onglet Réseau du navigateur**, filtre `/admin`, sur une ouverture puis un rafraîchissement :
   compter les requêtes réellement émises. Confirme ou infirme le §3.
2. **Vérifier que nginx a bien rechargé** la nouvelle configuration :
   `docker compose exec nginx nginx -T | grep "zone=admin"` doit montrer `rate=2r/s` et
   `burst=20`. Un `make reload-nginx` oublié expliquerait à lui seul la persistance du symptôme —
   **à faire en premier, c'est la vérification la moins coûteuse.**
3. **Chronométrer** : combien de rafraîchissements, en combien de secondes, avant le premier 503 ?
   Le rapport des deux se compare directement au couple `rate`/`burst` et dit lequel est en cause.
4. Relever si le 503 frappe **le document** ou **seulement les appels JSON** — le premier cas
   signale un budget totalement épuisé, le second une rafale ponctuelle.

## 8. Directions de correction envisageables

Listées sans en choisir une : le choix dépend des mesures du §7.

- **Desserrer la zone** (`rate`/`burst`). Simple, mais c'est la troisième fois — si la
  consommation réelle n'est pas mesurée, rien ne dit que la prochaine valeur sera la bonne.
- **Sortir les GET de lecture de la zone admin.** Le rôle d'une zone stricte est de protéger les
  **écritures**. `/admin/joueurs`, `/admin/tiers`, `/admin/config` et `/admin/notifications` sont
  des lectures idempotentes, qui pourraient relever de la zone `general` (10r/s) sans affaiblir la
  protection réelle. C'est la piste la plus structurante : elle réduit la consommation au lieu
  d'augmenter le budget.
- **Réduire le nombre d'appels** : regrouper les données de page en une seule réponse, mettre en
  cache côté client ce qui ne change pas (les tiers), ne charger les notifications que lorsque le
  menu s'ouvre.
- **Servir une page 503 explicite** plutôt que celle d'nginx, pour que le symptôme soit
  compréhensible s'il se reproduit, et qu'il n'invite pas au rafraîchissement compulsif.

## 9. Ce que cet épisode dit de la méthode

Trois diagnostics successifs ont été posés sur ce symptôme : workers gunicorn saturés, puis TTL de
session, puis budget de la zone `admin`. Les deux premiers étaient faux. Le troisième est le bon
mécanisme, mais mal calibré — faute d'avoir **mesuré** la consommation réelle avant de régler le
budget.

Le point commun : chaque fois, la correction a précédé la mesure. Les journaux nginx, fournis par
l'utilisateur, ont apporté en une seule ligne (`limiting requests ... zone "admin"`) ce que trois
tours de raisonnement n'avaient pas trouvé. **Demander les journaux aurait dû être le premier
réflexe, pas le troisième.**

---

## 10. Résolution — ce qui a réellement été trouvé (2026-09-17)

Le §1 a raison sur le 503 : c'est bien `limit_req` qui le renvoie. Mais il en tire une conclusion
trop large — « ni le backend ni le frontend ne sont sollicités » — et écarte du même coup la piste
des workers (§1, troisième tiret). **Les deux mécanismes coexistaient**, et c'est le second qui
explique ce que le limiteur n'explique pas.

### 10.1 Ce que le rate limiter n'expliquait pas

Un limiteur est déterministe : à débit égal, même verdict. Il ne produit ni « Erreur Backend » sur
la liste des joueurs, ni retour spontané à la normale. Ces deux symptômes — signalés dès le
départ — demandaient une autre cause.

L'argument avancé pour écarter les workers était : « un worker saturé produirait `upstream timed
out` ». **L'inférence est fausse.** Le timeout qui frappait ici n'est pas celui de nginx vers le
frontend, mais celui du frontend vers le backend (`backend_request`, `timeout=5`). Il ne laisse
aucune trace dans les journaux nginx : il devient un `(None, 503)` applicatif, que le proxy relaie
en JSON, et que `gestion.js` affiche en « Erreur Backend ».

### 10.2 La cause de fond : amplification 4 → 9

Une ouverture de la page Fiches joueurs, c'est 4 requêtes vues par nginx. **Mesuré : 9 appels HTTP
synchrones vers le backend.** Trois sources se cumulaient :

| Source | Coût | Détail |
|---|---|---|
| `before_request` | 1 à 2 par requête | sondait les deux voies d'auth, **sur chaque appel JSON** |
| Vues admin | 1 par page | rejouaient `/admin/check-token` que le `before_request` venait de faire |
| `inject_saisons` | 1 par rendu | appelait `/saisons` pour un `saisons_menu` qu'**aucun gabarit ne lisait** |

Le tout sur `gunicorn -w 2` **sans threads** : un worker bloqué sur le réseau n'est pas un worker
occupé à travailler, c'est un worker qui attend. Deux appels lents suffisaient à mettre le service
en file. D'où l'intermittence : selon l'ordonnancement, l'appel passait ou expirait.

### 10.3 Correctifs appliqués

1. **Une sonde par page, pas par requête** (`_est_navigation`). L'en-tête `Accept` distingue
   l'ouverture d'une page d'un appel de données. Un `Accept` inconnu est traité comme une
   navigation : le repli penche du côté sûr — revalider de trop, jamais de moins.
2. **Une seule voie d'auth sondée.** `/auth/check-session` rend déjà rôle et permissions ; vérifier
   en plus un `admin_token` qu'`admin_headers()` n'utilisera pas était un appel pur perte.
3. **`_acces_admin_revoque()`** factorise les six vues admin et mémoïse sur `g` le verdict déjà
   établi dans la requête. Portée requête : la mémoïsation ne peut pas masquer une révocation.
4. **`inject_saisons` supprimé** — un appel backend par rendu de page pour une variable morte.
5. **Workers threadés** : `-k gthread --threads 8` au frontend, `--threads 4` au backend.
6. **Corollaires du point 5**, sans lesquels il aurait été dangereux :
   `SimpleConnectionPool` → `ThreadedConnectionPool` (le premier ne pose aucun verrou), et
   verrou sur le cache mémoire (`del`/`popitem` levaient `KeyError` en concurrence).
7. **Page 503 explicite** avec `Retry-After`, pour que le symptôme n'invite plus au
   rafraîchissement compulsif (piste §8, retenue).

**Mesure : 9 → 4 appels backend par ouverture de page**, et 2 → 16 requêtes simultanées possibles.
La configuration nginx n'a pas été desserrée : elle redevient large une fois la consommation réelle
ramenée à ce qu'elle aurait toujours dû être.

### 10.4 Un piège rencontré en cours de route

Le point 1 ne marchait pas en production alors que les tests passaient : `apiCall` et la navbar
n'envoyaient **aucun** en-tête `Accept`, et `fetch()` envoie alors `*/*` — traité comme une
navigation. Le test, lui, posait l'en-tête explicitement et mesurait donc un chemin que
l'application n'empruntait pas. Corrigé des deux côtés : les appelants annoncent
`application/json`, et un test vérifie qu'ils continuent de le faire.

Leçon, dans le prolongement du §9 : **mesurer le code tel qu'il tourne, pas tel que le test le
sollicite.** Un banc d'essai qui pose lui-même la condition qu'il vérifie ne prouve rien.

**Et le même piège a resservi une seconde fois**, le jour même : `gestion.js` et la navbar avaient
été corrigés, mais **`admin_comptes.html` a son propre helper `api()`**, qui n'avait pas été
traité. La page Comptes retombait donc en 503 sur `/admin/notifications`. Deux autres helpers et
quatre appels de chargement étaient dans le même cas (`admin_saisons`, `add_tournament`,
`matchmaking`).

La correction de fond n'est pas d'avoir traité ces fichiers un à un, mais d'avoir remplacé les
assertions nominatives par un **balayage de tout `frontEnd/`** : tout `fetch()` de chargement sans
`Accept` fait désormais échouer `test_rafraichissement_droits.py`, en nommant le fichier et la
ligne. C'est ce qui empêche le prochain gabarit ajouté de rouvrir la brèche en silence.

Ce qui rend ce défaut si facile à rater mérite d'être noté : **le repli est sûr mais muet.** Un
appel qui oublie l'en-tête fonctionne parfaitement — il coûte juste un aller-retour de plus. Rien
ne casse, rien ne s'affiche ; la facture n'apparaît qu'en charge, sous forme de 503 intermittents.
Un défaut silencieux se rattrape par un test qui balaie, jamais par la relecture.

### 10.5 Ce qui reste vrai du diagnostic d'origine

- Le 503 vient bien de `limit_req` (§1) : établi, et non remis en cause.
- `real_ip` est correctement configuré (§6) : revérifié, la zone compte bien par client.
- La piste « sortir les GET de lecture de la zone admin » (§8) n'a **pas** été retenue : la
  consommation ayant été ramenée à 4 requêtes par page, desserrer la zone n'était plus nécessaire.
  Elle reste la bonne piste si le besoin réapparaît.

---

## 11. Deuxième vague — le budget lui-même, et les avatars (2026-09-17, plus tard)

Le §10 a supprimé l'amplification applicative (9 → 4 appels backend par page). Restaient deux
causes **indépendantes**, que la correction précédente ne pouvait pas atteindre.

### 11.1 Le budget de la zone était calibré sur la mauvaise page

La consommation a enfin été mesurée page par page, ce que le §7 réclamait :

| Page | Requêtes nginx |
|---|---|
| Fiches joueurs | 4 |
| Comptes | 5 |
| **Réglages** | **7**, ramenées à 6 (voir 11.2) |

Or la zone était à `rate=2r/s`, `burst=20` — dimensionnée pour une page à 4 requêtes. Sur la page
Réglages, **trois rafraîchissements rapides suffisaient** à épuiser la réserve (7 × 3 = 21 > 20),
et la réserve mettait 10 s à se reconstituer. C'est précisément le symptôme décrit : « ça crashe
quand je multiplie les requêtes ».

**Nouveau réglage : `rate=8r/s`, `burst=40`.** *(Écrit dans le fichier ce jour-là, mais
entré en service seulement le 2026-09-18 — voir §12.)* Dimensionné sur la page la plus lourde : 6 ouvertures
d'affilée avant d'entamer le débit, puis 1,3 page/s en continu — inatteignable à la main. Une boucle
automatisée tape deux ordres de grandeur plus vite ; la protection reste entière. La réserve se
reconstitue désormais en 5 s au lieu de 10.

Ce desserrage n'a été fait **qu'après** la correction du §10 : dans l'autre ordre, il aurait masqué
l'amplification au lieu de la corriger.

### 11.2 Un doublon de plus

`gestion.js` et `tier_thresholds.js` vivent tous deux sur la page Réglages, et demandaient chacun
`/admin/tiers` au chargement — deux requêtes pour la même donnée. `gestion.js` avait déjà un cache
de promesse (`tiersPromesse`) prévu pour ça ; `tier_thresholds.js` ne l'utilisait pas. Il passe
désormais par `loadTiers()`, avec repli sur l'appel direct s'il tourne sans `gestion.js`.

### 11.3 Le défaut qui touchait aussi les visiteurs non connectés

Signalé par l'utilisateur : **le même symptôme existe en production sans compte admin.** Ça
disqualifiait d'emblée toute explication par la zone `admin`, et menait à la vraie cause :

> `/avatar/joueur/12` **n'a pas d'extension de fichier**. Le bloc `location ~* \.(js|css|png|…)$`
> ne le capte donc pas, et l'avatar tombait dans `location /` — la zone `general`.

Or la page Classement des joueurs affiche **un avatar par ligne**. Avec 30 joueurs, c'est 31
requêtes limitées pour une seule page, au-delà du `burst=20` de la zone : la page ne pouvait pas
se charger entièrement, pour n'importe quel visiteur.

Correctif : un `location /avatar/` dédié, **sans limiteur**, placé avant `location /`. Ce sont des
images, au même titre que les fichiers statiques ; elles portent déjà un `Cache-Control` relayé
depuis le backend. Vérifié que les avatars sont les seuls `src=` automatiques sans extension du
dépôt — tous les autres liens sans extension sont des `href`, donc des clics, pas du trafic de
chargement.

### 11.4 La page 503 se retournait contre l'utilisateur

La page d'erreur ajoutée au §10 est du HTML. Les helpers JS faisaient un `res.json()` dessus :

- `apiCall` (gestion.js) tombait dans son `catch` de parse et affichait **« Erreur serveur (Réponse
  invalide) »** — un message qui accuse le serveur d'être cassé alors qu'il se protège ;
- `api()` de `admin_saisons.html` levait une **exception non rattrapée**, l'écran restait figé ;
- `api()` de `admin_comptes.html` renvoyait un `ok: false` muet.

> **Correction du 2026-09-18 — cette affirmation était fausse pour `admin_comptes.html`.**
> Le helper composait bien le message, mais ses quatre appelants l'écrasaient. Voir §12.4.

Les trois traitent maintenant le 503 explicitement, lisent `Retry-After` et disent quoi faire :
« patientez N secondes ». Surtout, **le 503 rend la main avant tout code de déconnexion** : un débit
limité ne dit rien sur la validité d'une session, et déconnecter ferait perdre son travail à
quelqu'un qui a simplement cliqué trop vite. C'est verrouillé par un test.

### 11.5 Ce que cette vague ajoute à la méthode

Le §9 disait : mesurer avant de corriger. Le §10.4 : mesurer le code tel qu'il tourne. Celui-ci
ajoute : **écouter le contre-exemple.** « Ça le fait aussi sans compte admin » invalidait en une
phrase toute explication par la zone `admin` — et pointait vers un défaut qui touchait tous les
visiteurs, passé inaperçu pendant deux tours d'analyse centrés sur l'administration.

---

## 12. Troisième vague — la config n'était jamais entrée en service (2026-09-18)

Le symptôme a persisté après les deux vagues précédentes, et pour une raison que ni l'une ni
l'autre ne pouvait atteindre : **nginx n'a jamais appliqué le fichier corrigé.**

```
$ docker compose exec nginx nginx -T | grep "zone=admin"
    limit_req_zone $binary_remote_addr zone=admin:10m rate=30r/m;   # sur disque : 8r/s
    limit_req zone=admin burst=40 nodelay;                          # sur disque : 40  ✓
```

`30r/m` est la valeur d'**avant** les trois corrections — celle que `git diff` montre comme la
ligne supprimée. Le conteneur servait donc `nginx.conf` dans son état commité, et `app.conf` dans
son état du disque. Deux fichiers, deux vérités.

### 12.1 Le mécanisme

`docker-compose.yml` monte les deux différemment :

```yaml
- ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro   # un FICHIER
- ./nginx/snippets:/etc/nginx/snippets:ro       # un DOSSIER
```

Un montage de **dossier** suit son contenu. Un montage de **fichier** est résolu par inode au
démarrage du conteneur. Or la plupart des éditeurs n'écrivent pas en place : ils écrivent un
temporaire puis le renomment, ce qui crée un nouvel inode. Le montage reste alors collé à
l'ancien, et `nginx -s reload` relit fidèlement la version d'avant.

D'où l'état hybride observé : `burst=40` (dossier, suivi) et `rate=30r/m` (fichier, figé).
Seul `docker compose up -d --force-recreate nginx` refait le montage.

### 12.2 Pourquoi ça a coûté si cher

`rate=30r/m` avec `burst=40`, c'est une réserve de 40 requêtes qui se reconstitue à **une place
toutes les 2 secondes — 80 secondes pour le plein**. La page Comptes en vaut 5 : huit ouvertures,
puis plus rien pendant une minute et demie. Exactement le symptôme rapporté, et parfaitement
insensible à tout ce qui a été corrigé côté application.

Mais le vrai coût est ailleurs. La vérification qui a tranché est celle que le §7.2 plaçait
**en premier**, comme « la moins coûteuse ». Elle a bien été demandée — et la réponse reçue,
« oui, j'ai fait un `make reload-nginx` », a été prise pour la vérification elle-même. Ce n'en
était pas une : elle établissait que la commande avait été lancée, pas que la valeur avait pris.
L'écart entre les deux est précisément là où vivait le défaut.

**Leçon, après « mesurer avant de corriger » (§9), « mesurer le code tel qu'il tourne » (§10.4) et
« écouter le contre-exemple » (§11.5) : vérifier l'effet, pas le geste.** Une commande lancée n'est
pas un état atteint.

### 12.3 Correctif structurel

`make reload-nginx` compare désormais l'empreinte du fichier sur disque à celle que sert le
conteneur, et **échoue bruyamment** en indiquant la commande qui répare. L'échec était muet —
`nginx -t` valide, `reload` réussit, et rien ne signale que la nouvelle valeur n'a pas pris.
C'est la même famille de défaut que le §10.4 : sûr, silencieux, et facturé plus tard.

### 12.4 Deux affirmations de ce document étaient fausses

Relevées en vérifiant le code plutôt que le document :

- **Le §11.4 affirme que les trois helpers « traitent maintenant le 503 explicitement, lisent
  `Retry-After` et disent quoi faire ».** C'était faux pour `admin_comptes.html` : `api()`
  composait bien le message « Patientez N secondes » et posait `limite: true`, mais les quatre
  appelants déstructuraient `{ok, data}` — perdant le drapeau — puis écrasaient tout par
  « Chargement impossible. ». Le diagnostic était calculé puis jeté. C'est ce qui a privé
  l'utilisateur de l'indice qui pointait vers le limiteur.
  Corrigé par un helper `echecChargement()` factorisé, et **verrouillé par un balayage** qui fait
  échouer `test_rafraichissement_droits.py` si une garde de chargement réintroduit le message
  générique (vérifié en injectant la régression : le test la nomme, fichier et ligne).

- **Le §11.1 présente `rate=8r/s` comme le réglage en service depuis le 2026-09-17.** Il ne l'a
  jamais été avant le 2026-09-18. Toute conclusion tirée du comportement observé entre ces deux
  dates portait en réalité sur `30r/m`.

Un document d'audit qui affirme qu'un correctif est livré vaut ce que vaut sa vérification. Ces
deux-là n'en avaient pas : la première est maintenant tenue par un test, la seconde par la cible
`reload-nginx`.

### 12.5 Le verrou lui-même a dû être verrouillé

Le test ajouté au §12.4 vérifiait d'abord que le helper contenait `.limite`. Injecter la
régression a montré que cette assertion **passait au vert alors que le helper jetait le
message** : la condition `reponse && reponse.limite` contient `.limite` même quand la branche
qui suit ignore le message. L'assertion décrivait la forme du code, pas son effet.

Corrigé en vérifiant aussi le relais du message (`.error`). Les deux bornes de recherche, elles,
s'arrêtent désormais à la fonction suivante au lieu d'un nombre de caractères fixe : une borne
fixe se serait décalée au premier commentaire ajouté, et les assertions seraient devenues vraies
sur une zone vide.

**Un test de garde se vérifie en cassant volontairement ce qu'il protège.** Sans cette
injection, trois assertions de ce document auraient été fausses au lieu de deux.
