# Protocole du banner — `/ws/race`

Contrat entre le service `race` et le navigateur. Il est **écrit dans un
fichier**, pas dans une convention :
[raceEngine/src/protocol.js](../../raceEngine/src/protocol.js) est la source de
vérité ; ce document en donne la carte.

Version courante : **`PROTOCOL_VERSION = 11`**.

Le client refuse toute version qui ne correspond pas à la sienne
([banner/interpolate.js](../../frontEnd/static/js/banner/interpolate.js)) et
retombe sur le décor seul. Les deux constantes se modifient donc ensemble,
jamais l'une sans l'autre.

---

## La règle : le snapshot fait foi

Un spectateur qui se connecte à la 187ᵉ seconde n'a vu passer **aucun
événement**, et doit pourtant afficher une scène complète et juste.

Donc : **tout ce qui est visible à l'écran se trouve dans le snapshot.** Les
événements ne servent qu'à jouer des animations — un client qui les ignorerait
tous verrait la même course, en moins joli.

Avant d'ajouter un élément visuel côté client, se demander : *un arrivant
peut-il le déduire du seul snapshot ?* Si non, c'est ici qu'il manque un champ.
`make race-spectate` vérifie cette règle mécaniquement.

---

## Serveur → client

### `hello` — une fois par connexion

Envoyé à l'ouverture. Contient de quoi construire la scène sans rien savoir de ce
qui s'est passé avant.

| Champ | Contenu |
|---|---|
| `protocol` | la version, vérifiée avant toute autre lecture |
| `serverTime`, `t0` | horloge serveur et instant de départ de la course |
| `world` | **toute** la géométrie et les constantes dont le rendu a besoin |
| `karts[]` | identité de chaque kart : `id`, `char`, `body` (demi-emprise + échelle du sprite) |
| `boxes[]`, `pipes[]` | le décor du circuit en cours |
| `snapshot` | un premier snapshot complet |

Le client **ne garde aucune copie des constantes de simulation** : largeur du
monde, bornes de la piste, durée d'un tête-à-queue, rayon du souffle de la bleue,
échelle d'un kart rapetissé, emprises réelles des corps — tout arrive dans
`world`. C'est ce qui évite qu'un réglage de gameplay change d'un côté sans
l'autre.

`world.ai` porte aussi les clés du relevé de décision **dans l'ordre des indices
envoyés** : le client y lit le sens d'un indice au lieu de maintenir sa propre
copie de cet ordre.

### `s` — snapshot, 10 fois par seconde

Des tuples plutôt que des objets : ça part dix fois par seconde à chaque
spectateur.

| Clé | Contenu |
|---|---|
| `ts` | horloge de simulation, en ms |
| `cx`, `bx` | caméra de course et caméra du décor |
| `k[]` | `[id, worldX, yPercent, distance, drapeaux, rang, objet…]` |
| `ai[]` | le relevé de décision, un entier par kart — purement informatif |
| `i[]` | `[id, type, worldX, y, frame, hop, montée]` |
| `b[]` | boîtes à objets : 1 = pleine |
| `ph`, `lp` | phase de course, tour du leader |
| `sg` | panneau de Lakitu : `[groupe, image]` |
| `st` | orage : `[début, frappe, fin, lanceur]` |
| `fo` | ordre d'arrivée |
| `gp` | grand prix : `[manche, points de la course, cumul]` |
| `vt` | vote de redémarrage : `[posés, spectateurs]` |
| `ev[]` | les événements survenus depuis le dernier envoi (optionnel) |
| `vw` | la vue du kart suivi, **seulement** pour un client qui l'a demandé |

Les drapeaux d'un kart sont un champ de bits : grille, percuté, immobilisé,
étoile, arrivé, rapetissé, Bill, arrêté par un tuyau, écrasé.

`fo`, `gp` et `vt` voyagent dans **chaque** snapshot, et c'est la règle du haut
qui l'impose : un arrivant qui se connecte pendant le classement doit le voir en
entier, pas un compteur à zéro qui sauterait à l'envoi suivant.

### `pong`

Réponse à un `ping`, avec l'horodatage client renvoyé tel quel et l'heure
serveur. C'est ce qui cale l'horloge partagée — aucune date locale n'entre dans
un calcul commun, celles des visiteurs sont fausses.

---

## Client → serveur

Quatre messages, tous minuscules. La charge utile est plafonnée à 512 octets.

| Message | Effet |
|---|---|
| `{ t: 'ping', c }` | mesure de latence et calage d'horloge |
| `{ t: 'vote' }` | vote pour un redémarrage de grand prix |
| `{ t: 'watch', id }` | demande la vue détaillée d'un kart (`vw` dans le snapshot) |
| `{ t: 'vis', hidden }` | onglet passé en arrière-plan : coupe le flux |

`vis` est ce qui rend le banner gratuit dans un onglet oublié : la course
continue sans lui, il redemandera l'état en revenant.

---

## Ce qui ne voyage pas

- **Aucune constante de gameplay ne part du client.** Il n'en a aucune à
  envoyer : il ne simule rien.
- **La vue d'un kart (`vw`) ne part qu'à qui la demande.** Elle coûte une seconde
  sérialisation par kart observé ; zéro tant que personne ne regarde.
- **Le vote de chaque spectateur.** Le snapshot est sérialisé une fois pour tout
  le monde et ne peut donc porter que le total : chaque client se souvient seul
  du sien.

---

## Cycle de vie

La course démarre à la **première** connexion et s'arrête 30 s après le départ du
dernier spectateur. Personne devant l'écran, aucun CPU consommé ; le délai de
grâce évite qu'un simple F5 ne reparte de zéro.

Un `SIGHUP` (`make restart-race`) relit `tracks/` et repart sur un grand prix
neuf, sans couper les connexions.
