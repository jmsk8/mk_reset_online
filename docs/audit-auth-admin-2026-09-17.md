# Audit auth Discord + administration — second passage

> **Nature de ce document.** État des lieux à une date donnée, constat par constat. Ce n'est ni un
> plan ni un suivi de chantier. **Rien n'a été codé ni commité** dans le cadre de cet audit.
>
> **Date : 2026-09-17.** Second passage, après [audit-auth-discord.md](audit-auth-discord.md)
> (2026-09-15). Ce document ne le remplace pas : il le **prolonge**, sur un périmètre élargi à
> l'administration, la hiérarchie, le legs et la suppression de compte.
>
> Périmètre lu intégralement : `backEnd/auth.py`, `backEnd/auth_discord.py`,
> `backEnd/routes_auth.py`, `backEnd/routes_comptes.py`, `backEnd/routes_bot.py`,
> `backEnd/constants.py`, `frontEnd/frontend.py`, `nginx/`, les migrations d'auth et de hiérarchie.
>
> **Chaque constat 🔴 et 🟠 est prouvé par exécution**, pas par lecture :
> `backEnd/tests/test_audit_auth_admin.py`. Les constats prouvés portent la mention *(prouvé)*.
>
> **Demande explicite de l'utilisateur** : « parfois il y a des bugs un peu étranges » à la
> connexion. Le §1 y répond — c'est le constat **B-01**, et il est reproduit par exécution.

---

## Verdict en une page

Le socle cryptographique et le modèle d'autorisation restent **sains**, et le second passage n'a
trouvé **aucun chemin d'élévation de privilège** : personne ne peut obtenir un droit qu'il n'a pas.
Le travail fait depuis le 15/09 est réel — l'écran « mes sessions » referme A-03 et A-06, et
`check-session` rend désormais rôle et permissions, ce qui referme la dérive d'affichage.

Les défauts trouvés cette fois sont d'une **autre famille** que ceux du premier passage. Là où
l'audit du 15/09 trouvait des défauts de *cycle de vie*, celui-ci trouve deux défauts de
**disponibilité** : des chemins par lesquels l'utilisateur légitime — ou l'administrateur unique —
se retrouve **dehors**.

| # | Constat | Gravité | Nature |
|---|---|---|---|
| **B-01** | ~~Le `state` OAuth est une case unique~~ | ✅ **corrigé 2026-09-17** | Connexion |
| **B-02** | ~~Le superadmin peut se supprimer ou se suspendre lui-même~~ | ✅ **corrigé 2026-09-17** | Verrouillage |
| **B-03** | ~~`changer_statut` n'a aucune garde « dernier superadmin »~~ | ✅ **corrigé 2026-09-17** (voir réserve) | Hiérarchie |
| **B-04** | ~~La zone nginx `auth` (20 r/min) amplifie B-01~~ | ✅ **corrigé 2026-09-18** (40 r/min) | Connexion |
| **B-05** | ~~Trois fichiers de tests en échec~~ | ✅ **corrigé 2026-09-18** | Tests |
| **B-06** | ~~`prompt=none` n'est ni commenté ni justifié~~ | ✅ **corrigé 2026-09-18** | Dette |
| **A-01/A-02** | ~~La durée de session reste figée sur le rôle~~ *(rappel)* | ✅ **corrigé 2026-09-22** | Session |
| **A-04/A-05/A-07** | Dette du mot de passe partagé, CGU non imposées *(rappel, non corrigé)* | 🟡 faible | Dette |

**Deux constats 🔴, tous deux confirmés par exécution.** Aucun n'est une faille de confidentialité :
ce sont des pannes de disponibilité, dont l'une explique les « bugs étranges » signalés.

> ## ✅ Mise à jour du 2026-09-18 — cinq constats sur six sont refermés
>
> **B-01, B-02, B-03, B-04 et B-05 sont corrigés**, dans l'ordre que le §8 recommandait :
> la cause d'abord (B-01), la mesure ensuite (B-04). Les assertions `defaut()` qui les
> portaient sont devenues des **non-régressions**, et chaque garde a été vérifiée **en la
> cassant volontairement** avant d'être livrée — six assertions comportementales virent au
> rouge quand `_refus_auto_verrouillage` est neutralisée, deux quand le gate de permission
> est retiré. Sans cette injection, rien ne prouverait qu'elles décrivent l'effet du code
> plutôt que sa forme (leçon du §12.5 de l'audit 503).
>
> Suite complète : **1401 assertions, aucune rouge, aucun fichier en échec** — une première
> depuis l'ouverture de cet audit.
>
> | Constat | Ce qui a été fait |
> |---|---|
> | **B-01** | Liste bornée de `state` en attente (5 max, TTL 15 min), consommés **seulement en cas de correspondance**. L'usage unique est préservé. Les deux messages sont enfin distingués : « déjà servi ou expiré » (fréquent, bénin) vs refus réel (journalisé). |
> | **B-02 / B-03** | Garde unique `_refus_auto_verrouillage`, appliquée à `DELETE /me` **et** à `changer_statut`, sous `FOR UPDATE`. Réutilise la définition du « dernier » de `changer_role` plutôt que de la recopier. |
> | **B-04** | Zone `auth` portée de 20 à **40 r/min**, après B-01 et pas avant. Volontairement modeste : un budget large masquerait la prochaine boucle d'échec. |
> | **B-05** | Les trois fichiers réparés. Aucun ne signalait un défaut du code : tous testaient un état antérieur (avatar au CDN, demande de liaison à 3 colonnes, jointure `joueurs`). |
>
> **Les six constats sont refermés.** B-06 l'a été le 2026-09-18 : `prompt=none` porte
> désormais le commentaire qui manquait, et il consigne surtout **l'écart de Discord avec
> l'OIDC standard** — là où la norme impose au serveur de renvoyer une erreur plutôt que
> d'afficher un écran, Discord retombe sur le consentement. C'est ce qui rend le paramètre
> sans danger pour une première connexion, et c'est ce qui l'avait fait soupçonner à tort
> d'être la cause des « bugs étranges ». Le commentaire existe pour qu'on ne le re-suspecte
> pas une troisième fois.
>
> **Une réserve reste assumée sur B-03** — voir la fin du §3. **Arbitrée le 2026-09-18 :
> pas de confirmation à la suspension du dernier chef_admin.**
>
> ℹ️ **Un défaut antérieur trouvé en relisant la correction** (2026-09-18) : `compare_digest`
> **lève** un `TypeError` sur deux chaînes dont l'une n'est pas ASCII. Le `state` venant d'un
> paramètre d'URL, un simple `?state=é` produisait un **500 sur le chemin de connexion** — et
> ce, *avant* la correction de B-01 comme après, la nouvelle version ayant hérité du geste tel
> quel. Corrigé en comparant des octets, sans rien perdre du temps constant. Cinq assertions
> couvrent désormais les entrées hostiles (non-ASCII, emoji, octet nul, très long, session
> bricolée) : toutes doivent refuser en 400, jamais en 500.
>
> ⚠️ **Non vérifié ici, et à faire avant de conclure quoi que ce soit sur nginx** :
> `docker compose exec nginx nginx -T | grep "zone=auth"` doit confirmer la valeur **servie**.
> Docker n'était pas disponible dans l'environnement où la correction a été écrite. L'épisode
> du montage par inode (§12 de l'audit 503) a déjà piégé une fois.

---

## 1. B-01 — les « bugs étranges » à la connexion 🔴

*(prouvé — `test_audit_auth_admin.py`, section B-01)*

**C'est la réponse à la question posée.** Le symptôme décrit — « parfois » — est exactement ce que
produit ce défaut : il ne se déclenche pas à chaque fois, il dépend de ce que l'utilisateur a fait
juste avant, et **réessayer le fait disparaître**. D'où l'impression d'aléatoire.

### Le mécanisme

`discord_login` écrit le `state` dans **une case unique** de la session Flask
([frontend.py:768](../frontEnd/frontend.py#L768)) :

```python
state = secrets.token_urlsafe(24)
session['oauth_state'] = state      # écrase la valeur précédente
```

Et `discord_callback` le **consomme** par `pop`
([frontend.py:801](../frontEnd/frontend.py#L801)) :

```python
attendu = session.pop('oauth_state', None)
```

Chacun des deux gestes est correct isolément — le `pop` est même une bonne pratique, c'est ce qui
rend le `state` à usage unique et bloque le rejeu. **C'est leur combinaison, sur une case unique,
qui casse.** Deux conséquences distinctes, mesurées toutes les deux :

#### 1.1 Deux connexions en parallèle s'annulent

Le second `state` écrase le premier. Terminer la connexion dans le **premier** onglet échoue, alors
que rien d'anormal ne s'est produit du point de vue de l'utilisateur :

```
state onglet 1: U0sKLFAo20Ty | state onglet 2: utbr9Ps_xuwf
Retour onglet 1 -> 400 « Requête de connexion invalide ou expirée »
```

#### 1.2 Un échec en provoque un second — le plus perfide

Le `pop` vide la case **même quand la comparaison échoue**. Le callback suivant, y compris avec un
`state` parfaitement valide, trouve alors `attendu = None` et échoue à son tour :

```
callback avec le state périmé  -> ECHEC (attendu=2SywzKK1rk)
callback avec le BON state     -> ECHEC (attendu=None)
```

C'est ce qui transforme une gêne ponctuelle en **comportement incompréhensible** : l'utilisateur
voit deux échecs d'affilée, puis un succès au troisième essai (nouveau cycle complet).

### Comment on y arrive sans rien faire d'anormal

Aucun de ces scénarios ne demande un usage inhabituel :

- ouvrir le lien d'invitation dans deux onglets, ou le rouvrir après hésitation ;
- double-cliquer sur « Se connecter » (le second clic écrase le `state` du premier) ;
- utiliser le **bouton Retour** après avoir atterri chez Discord, puis recliquer ;
- le **préchargement** du navigateur, qui suit spéculativement le lien de connexion ;
- deux appareils, ou deux onglets, sur le même compte.

### Ce qui aggrave le diagnostic

Le message affiché est *« Requête de connexion invalide ou expirée. Réessayez. »* — il **accuse la
requête** alors que la cause est un écrasement côté serveur, et il invite à réessayer, ce qui
marche effectivement (nouveau cycle). Rien dans les journaux ne distingue ce cas d'une vraie
tentative de CSRF : les deux produisent le même `flash`.

### Direction de correction

Ne pas retirer le `pop` — il porte l'usage unique. La correction tient en deux points :

1. **Porter plusieurs `state` en attente** plutôt qu'un seul : une petite liste bornée (3 à 5,
   avec horodatage), et le callback retire **celui qui correspond**, pas « le dernier ». L'usage
   unique est préservé, l'écrasement disparaît.
2. **Ne consommer qu'en cas de correspondance**, pour que l'échec 1.2 cesse de se propager.

Distinguer alors les deux messages : « connexion déjà utilisée ou expirée, recommencez » (cas
normal, fréquent) et le refus réel. Aujourd'hui les deux sont confondus.

> **Piste écartée, et pourquoi la noter.** J'ai d'abord soupçonné `prompt=none`
> ([frontend.py:783](../frontEnd/frontend.py#L783)) : en OIDC standard, ce paramètre **impose** au
> serveur de renvoyer une erreur plutôt que d'afficher un écran de consentement, ce qui aurait
> produit exactement le symptôme. **Vérification faite, ce n'est pas le cas chez Discord** : sa
> documentation ne décrit `prompt` que pour les utilisateurs *déjà* autorisés, et la discussion
> officielle `discord-api-docs#6751` confirme que le comportement strict n'existe pas — Discord
> retombe sur l'écran de consentement. `prompt=none` n'est donc **pas** la cause, et ne doit pas
> être présenté comme telle. C'était le constat mineur B-06, **refermé le 2026-09-18** :
> le paramètre porte maintenant ce raisonnement en commentaire, sur place.
> **Suite du 2026-09-24** : `prompt=none` est remplacé par `prompt=consent`, par choix
> d'ergonomie et non pour un défaut. L'écran d'autorisation s'affiche désormais à chaque
> connexion, pour qu'on voie avec quel compte Discord on entre.

---

## 2. B-02 — le superadmin peut se verrouiller dehors 🔴

*(prouvé — sections B-02a et B-02b)*

Le projet protège soigneusement le « jamais zéro superadmin » sur **deux** chemins, et le
documente longuement :

- `changer_role` refuse de rétrograder le dernier superadmin (409 `dernier_superadmin`) ;
- le legs est **atomique** : rétrograder puis promouvoir dans une seule transaction.

Le commentaire de `changer_role` est explicite sur l'enjeu : *« il n'existe pas de mot de passe de
secours »*. **Deux autres chemins mènent pourtant au même résultat, sans aucune garde.**

### 2.1 `DELETE /me` — le superadmin supprime son propre compte

`supprimer_mon_compte` ([routes_comptes.py:1972](../backEnd/routes_comptes.py#L1972)) est décorée
`@player_required` **seul**. Elle ne lit jamais `role`. Exécuté :

```
=== superadmin supprime SON PROPRE compte ===
status: 200  body: {'status': 'success', 'dossier_sportif_conserve': False}
DELETE FROM comptes exécuté ? True
```

Après quoi la base ne contient **plus aucun superadmin** : plus aucune attribution de rôle, plus de
legs, plus de jetons de bot, plus de purge RGPD.

### 2.2 `POST /statut` — le superadmin se suspend lui-même

`changer_statut` porte pourtant `@compte_cible_protegee`. Mais ce décorateur **laisse
délibérément passer l'auto-action** ([auth.py:379](../backEnd/auth.py#L379)) :

```python
if cible_id is None or cible_id == acteur['id']:
    return f(*args, **kwargs)
```

Ce choix est justifié dans sa docstring — « fermer ses propres sessions est légitime » — et il est
juste **pour les sessions**. Il ne l'est pas pour le statut. Exécuté :

```
=== superadmin se suspend LUI-MÊME ===
status: 200  body: {'status': 'success', 'statut': 'suspended'}
DELETE sessions exécuté ? True
```

Le compte est suspendu **et** ses sessions sont fermées dans le même geste. Or `login()` refuse
explicitement un compte `suspended` ([auth_discord.py:~428](../backEnd/auth_discord.py#L428)) :
il ne peut donc **plus jamais se reconnecter**, et personne n'a le rang pour le réactiver.

### 2.3 Y a-t-il un rattrapage ?

Partiellement, et seulement dans un cas.

| Chemin | Rattrapable ? |
|---|---|
| **Suppression** (2.1) | **Oui**, *si* `DISCORD_SUPERADMIN_ID` est encore renseigné : le compte étant détruit, `peut_amorcer_sans_invitation` le laisse rentrer (aucun superadmin en base), et `promote_bootstrap_superadmin` le repromeut. C'est le « filet de secours assumé » de la docstring. |
| **Suspension** (2.2) | **Non.** Le compte **existe toujours**, donc `peut_amorcer_sans_invitation` n'est jamais consulté (elle ne l'est que pour un compte inexistant), et `login()` refuse en amont sur le statut. L'amorçage ne rattrape rien. **Seul un `UPDATE` SQL en production répare.** |

La suspension est donc le cas **le plus grave des deux**, alors que c'est le geste qui paraît le
plus anodin. Et la variable d'environnement n'est pas une garantie : elle est optionnelle
(`${DISCORD_SUPERADMIN_ID:-}`), et rien n'incite à la conserver une fois l'amorçage fait.

### 2.4 Pourquoi ce trou existe

C'est un angle mort de répartition, pas une négligence. Les gardes « jamais zéro » ont été posées
sur les routes qui **écrivent `role`** — c'est là qu'on les cherche. Or ces deux chemins ne
touchent pas `role` : l'un écrit `statut`, l'autre supprime la ligne. Ils atteignent le même
résultat par une autre colonne.

### Direction de correction

Une règle unique, appliquée aux deux routes : **un compte ne peut pas se retirer lui-même la
capacité d'administrer s'il est le dernier à la détenir.** Concrètement, refuser (409, code dédié)
quand l'acteur est superadmin et qu'aucun autre superadmin n'existe — la même requête que celle
déjà écrite dans `changer_role`, réutilisée. Le superadmin qui veut vraiment partir **lègue
d'abord**, ce qui est précisément le geste prévu pour ça.

Le même raisonnement mérite d'être tenu pour le **dernier chef_admin** : `changer_role` lui demande
une confirmation nommée (R-60), les deux autres routes ne demandent rien.

---

## 3. B-03 — asymétrie entre `changer_role` et `changer_statut` 🟠

C'est la généralisation de B-02.2, et elle vaut d'être notée séparément parce qu'elle concerne
**aussi les cibles, pas seulement soi-même**.

| Garde | `changer_role` | `changer_statut` |
|---|---|---|
| Rang de la cible (`compte_cible_protegee`) | ✅ | ✅ |
| Dernier superadmin | ✅ 409 | ❌ **rien** |
| Dernier chef_admin | ✅ confirmation nommée | ❌ **rien** |
| Auto-modification | ✅ `refuse_auto_modification` | ❌ **rien** |

La suspension est fonctionnellement **aussi forte qu'une rétrogradation** — elle ferme les sessions
et interdit la reconnexion — mais elle est traitée comme un geste mineur. Un chef_admin ne peut pas
rétrograder un pair (rang égal), et c'est correct ; il ne peut pas non plus le suspendre (même
décorateur), correct aussi. Mais **personne ne l'empêche de se suspendre lui-même**, ni de suspendre
le dernier chef_admin sans confirmation.

> **✅ Corrigé le 2026-09-17, avec une réserve explicite.**
>
> `changer_statut` porte désormais la même garde que `DELETE /me` : l'auto-suspension du
> **dernier superadmin** est refusée en 409 `dernier_superadmin`. La réactivation n'est pas
> concernée — elle n'a jamais verrouillé personne, et une assertion le vérifie pour que la
> garde ne déborde pas.
>
> **Ce qui n'a PAS été fait, et c'est un choix — ARBITRÉ le 2026-09-18** : le **dernier
> chef_admin** ne déclenche aucune confirmation à la suspension, là où `changer_role` en
> demande une nommée (R-60). La raison : suspendre un chef_admin est **réversible par le
> superadmin**, qui reste souverain — ce n'est donc pas un verrouillage, et c'est exactement
> le critère qui a guidé toute la correction B-02.
>
> Le contre-argument a été pesé et écarté : le chef_admin est le filet qui sert si le
> superadmin perd son accès, et tomber à zéro en silence retire ce filet. Mais un filet
> qu'on peut remettre d'un clic ne justifie pas le même garde-fou qu'une porte qui se
> referme définitivement. **L'assertion `defaut()` correspondante reste volontairement
> verte** : elle constate un comportement choisi, pas une dette. Ne pas la « corriger ».

---

## 4. B-04 — la zone `auth` amplifie B-01 🟠

`nginx/nginx.conf:47` : `limit_req_zone ... zone=auth:10m rate=20r/m;` avec `burst=10`.

**20 requêtes par minute, soit une toutes les 3 secondes**, sur `/auth` **et** `/invite`. C'est la
zone la plus stricte du projet (les autres sont à 8 r/s, 10 r/s, 60 r/min), et c'est défendable sur
le principe : ces URI sont publiques et mènent à des écritures.

Le problème est l'**interaction avec B-01**. Un cycle de connexion consomme déjà plusieurs requêtes
de cette zone (`/invite/<token>`, `/auth/discord/login`, `/auth/discord/callback`). Quand B-01 fait
échouer la tentative, l'utilisateur **recommence** — et chaque reprise repaye le cycle. Trois ou
quatre essais suffisent à épuiser la réserve, et le message devient alors un **503 nginx** au lieu
du message d'échec applicatif.

C'est exactement le motif décrit dans [audit-503-zone-admin.md](audit-503-zone-admin.md) §11.1
pour la zone `admin` : un budget calibré sur le chemin nominal, qui s'effondre sur le chemin de
reprise. La leçon du §12 de ce document s'applique telle quelle — **vérifier l'effet, pas le
geste** : `docker compose exec nginx nginx -T | grep "zone=auth"` doit être fait avant toute
conclusion sur cette zone, l'épisode du montage par inode ayant déjà piégé une fois.

Corriger B-01 réduit mécaniquement la pression. Recalibrer la zone sans corriger B-01 ne ferait que
repousser le seuil.

---

## 5. B-05 — trois fichiers de tests en échec 🟠

`sh backEnd/tests/run.sh` : **`test_auth.py`, `test_liaisons.py`, `test_profils.py`** en échec.
L'audit du 15/09 les mentionnait comme « antérieurs et sans rapport ». C'est vrai, mais
**incomplet** : deux d'entre eux masquent de la couverture réelle sur le périmètre de cet audit.

| Fichier | Nature réelle | Effet |
|---|---|---|
| `test_auth.py` | 1/33 — attend une URL CDN Discord, le code sert `/avatar/moi` | **Test obsolète.** Le changement est délibéré et documenté. Sans gravité. |
| `test_liaisons.py` | **6 assertions** — fixture à 3 colonnes, la requête en lit 4 (`d.nom_demande`) | **Fixture périmée**, pas une régression : j'ai vérifié que le code de production est cohérent. Mais elle rend muette toute la section « course à l'approbation » (R-07), qui teste un verrou de concurrence. |
| `test_profils.py` | Plante à l'import (`TypeError`) sur le profil public | **Fichier interrompu** : les assertions qui suivent ne s'exécutent jamais. |

Le vrai coût n'est pas l'échec, c'est le **bruit** : trois fichiers rouges en permanence, et le
mécanisme des assertions `defaut(...)` de l'audit précédent repose précisément sur le fait qu'un
rouge attire l'œil. Une suite qui est rouge en régime normal ne peut plus signaler quoi que ce soit.

C'est exactement ce que `test_liaisons.py` démontre : sa section R-07 vérifie un verrou
`SELECT ... FOR UPDATE` contre une course à l'approbation. Elle ne vérifie plus rien depuis que la
fixture est périmée, et personne ne s'en est aperçu.

---

## 6. Ce qui a été vérifié et qui tient

Cette section est la contrepartie des constats : elle liste ce que j'ai **cherché à casser sans y
parvenir**. Chaque ligne est une assertion de non-régression dans le fichier de tests.

### Hiérarchie et droits délégués

| Point | Verdict |
|---|---|
| Aucun chemin d'élévation de privilège | ✅ Rien trouvé, sur les 4 rôles et les 9 combinaisons de rangs |
| `compte_cible_protegee` — règle de rang unique | ✅ Correcte, y compris l'égalité (admin vs admin) |
| Défaut fermé des deux côtés sur un rôle inconnu en base | ✅ Acteur au rang le plus bas, cible au plus haut |
| Sous-permission sans parent = aucun droit | ✅ Appliqué **au backend**, pas seulement à l'affichage |
| `permission_required` refuse une permission hors catalogue | ✅ `raise ValueError` à la définition, pas à l'appel |
| Purge des permissions à la sortie du rôle admin (R-53) | ✅ Dans `changer_role` **et** dans le legs |
| Un chef_admin ne peut pas désigner un pair | ✅ Seul le superadmin |
| `changer_role` ne pose jamais `superadmin` | ✅ 400 `superadmin_non_attribuable` |
| Legs — ordre imposé par l'index partiel | ✅ Rétrograder **puis** promouvoir, commenté au bon endroit |
| Legs — verrou des deux lignes en une requête triée par id | ✅ Prévient l'interblocage de deux legs concurrents |
| Legs — rôle de l'acteur relu **sous verrou** | ✅ Deux legs concurrents ne réussissent pas tous les deux |
| Legs — confirmation sur `discord_username`, pas le nom d'affichage | ✅ Le handle est stable, le nom d'affichage est libre |
| Unicité du superadmin | ✅ Index unique partiel en base, pas seulement applicatif |
| Amorçage — conditions d'entrée ≡ conditions de promotion | ✅ Symétrie verrouillée par un test |
| Amorçage — verrou `FOR UPDATE` contre deux connexions simultanées | ✅ Ajouté et correct |
| `_DbIndisponible` → 503, jamais 403 | ✅ Une panne DB ne déconnecte pas un ayant droit |

### Sessions et vol de token

| Point | Verdict |
|---|---|
| Token en base : `sha256` seul | ✅ Une fuite du dump ne donne aucun token utilisable |
| Entropie `secrets.token_urlsafe(32)` = 256 bits | ✅ |
| Token jamais dans le DOM | ✅ Vit en session serveur Flask |
| `token_hash` jamais exposé par `/auth/mes-sessions` | ✅ Comparaison **en mémoire**, booléen `courante` seul |
| `resumer_appareil` ne renvoie jamais un fragment de l'entrée | ✅ Liste fermée — sûr par construction, pas par échappement |
| Cloisonnement du `DELETE` par `compte_id` | ✅ La clause est présente et commentée comme frontière |
| Expiration **absolue**, aucune route ne prolonge | ✅ |
| Sessions expirées exclues de la liste | ✅ `expires_at > now()` |
| Rôle relu en base à **chaque** requête protégée | ✅ Jamais mis en cache — c'est la garantie centrale |
| Suspension et suppression ferment les sessions | ✅ |

### OAuth et données venues de Discord

| Point | Verdict |
|---|---|
| `state` comparé en temps constant | ✅ `secrets.compare_digest` |
| `state` à usage unique | ✅ (c'est son **stockage** qui pose problème, cf. B-01) |
| Secret Discord confiné au backend | ✅ Le frontend ne connaît que `CLIENT_ID` et `REDIRECT_URI` |
| Invitation hors du paramètre `state` | ✅ Reste en session serveur, absente des logs Discord |
| Invitation consommée seulement à l'échange | ✅ L'affichage est strictement idempotent (crawler Discord) |
| `login()` en une seule transaction | ✅ Compte + invitation + session, ou rien |
| Échange idempotent | ✅ Un compte existant n'a pas besoin d'invitation |
| Snowflake validé avant usage dans une URL | ✅ `RE_SNOWFLAKE`, testé avec `../../` |
| Hash d'avatar : **dégrade** au lieu de bloquer | ✅ Perdre une image ne justifie pas de refuser une connexion |
| Corps des réponses Discord jamais journalisé | ✅ Statuts HTTP seuls |
| Scope `identify` seul | ✅ Ni email, ni guilds — minimisation réelle |
| `SameSite=Lax` et non `Strict` | ✅ `Strict` casserait le retour de Discord — commenté |

### Bot

`routes_bot.py` est **propre** : lecture seule, `service_required` avec portée, jeton haché en
`sha256`, révocation et expiration vérifiées, comptes `pending` exclus, et le rôle n'est **jamais**
publié (« publier le rôle désignerait les administrateurs à quiconque possède un jeton »). Le
snowflake sort en chaîne, jamais en entier — le piège des 2^53 est évité et commenté.

---

## 7. Rappel des constats non corrigés du 15/09

Toujours ouverts, vérifiés lors de ce passage :

- ~~**A-01 / A-02** 🟠 — la durée de session reste figée sur le rôle au moment de la connexion.
  `changer_role` ne contient toujours aucun `DELETE FROM sessions_joueurs` (vérifié). Un compte
  promu garde une session de 30 jours là où la règle lui en destine 12 heures.~~
  ✅ **Corrigé le 2026-09-22** : les quatre écrivains de `comptes.role` ferment les sessions du
  compte concerné. Détail au §A-01/A-02 de [audit-auth-discord.md](audit-auth-discord.md).
- **A-04 / A-05** 🟡 — `/admin-auth` et `/admin/refresh-token` sont toujours exposés, `api_tokens`
  stocke encore le jeton en clair. Il ne reste **qu'un seul** `@admin_required` dans tout le
  backend, sur `/admin/refresh-token` lui-même.
- ~~**A-07** 🟡 — le consentement CGU n'est toujours pas imposé : aucune lecture de `cgu_version`
  dans `auth.py` hors du passage de la valeur.~~ ✅ **Imposé le 2026-09-24** : 428
  `cgu_a_accepter` sur toute route hors d'une liste blanche de quatre, page `/consentement` côté
  frontend. Détail au §A-07 de [audit-auth-discord.md](audit-auth-discord.md).

**A-03 et A-06 sont refermés** par l'écran « mes sessions » livré depuis (non commité). Les
assertions `defaut()` correspondantes de `test_audit_auth_discord.py` doivent virer au rouge — c'est
le mécanisme voulu, et le document du 15/09 reste à mettre à jour.

---

## 8. Recommandations, par ordre de valeur

### 1. Refermer B-01 — *la plus rentable, et celle qui répond à la question posée*

C'est le seul constat qui **dégrade l'usage quotidien** de tout le monde, et il a une cause unique
et locale. Porter plusieurs `state` en attente et ne consommer qu'en cas de correspondance : le
changement tient dans `discord_login` et `discord_callback`, sans toucher au backend ni à la base.

### 2. Refermer B-02 et B-03 — *la plus grave en cas de survenue*

Faible probabilité, conséquence maximale et **irréversible sans accès SQL en production**. La
correction réutilise une requête déjà écrite. À traiter dans le même geste que B-03, la règle étant
la même.

### 3. Réparer les trois fichiers de tests (B-05)

Pas pour le score, mais parce que le dispositif d'audit du projet **repose sur la lisibilité du
rouge**. Trois fichiers rouges en permanence le neutralisent. `test_liaisons.py` en premier : sa
section de concurrence ne teste plus rien.

### 4. Recalibrer la zone `auth` (B-04) — *après* B-01

Dans cet ordre : corriger d'abord la cause des reprises, mesurer ensuite. L'inverse masquerait B-01
au lieu de le corriger — exactement l'erreur de méthode décrite au §9 de l'audit 503.

### 5. Reprendre A-01/A-02, puis trancher A-04/A-05/A-07

A-01/A-02 ✅ refermés le 2026-09-22, A-04/A-05 ✅ le 2026-09-23 avec l'étape 6, A-07 ✅ le 2026-09-24 (consentement imposé).

---

## 9. Comment rejouer cet audit

```bash
cd backEnd/tests && python3 test_audit_auth_admin.py    # ce seul fichier
cd backEnd/tests && sh run.sh                           # suite complète
```

`test_audit_auth_admin.py` suit la convention posée par `test_audit_auth_discord.py` : les
assertions `defaut(...)` décrivent le comportement **actuel et problématique**, et sont vertes
**tant que le défaut est là**. Le jour où l'un est corrigé, l'assertion vire au rouge et nomme le
constat à refermer ici.

**Une ligne rouge marquée `[B-xx, defaut constate]` est une bonne nouvelle.**

**Les gardes ont été vérifiées en cassant volontairement ce qu'elles protègent** — la leçon du §12.5
de [audit-503-zone-admin.md](audit-503-zone-admin.md). Une garde ajoutée dans `changer_statut` a
été injectée temporairement : les cinq assertions `defaut()` de B-02b et B-03 sont bien passées au
rouge, y compris les deux **comportementales** (le 200 sur l'auto-suspension, et la fermeture des
sessions), pas seulement celles qui lisent le source. Le fichier a ensuite été restauré à
l'identique (`git diff` vide). Sans cette injection, rien ne prouverait que ces assertions décrivent
l'effet du code plutôt que sa forme.

### Ce que cet audit n'a pas couvert

Dit explicitement, pour que l'absence ne se lise pas comme un blanc-seing :

- **Aucun test contre un vrai Postgres.** Le harnais script le curseur : les verrous
  (`FOR UPDATE`), les contraintes et l'index partiel sont lus et raisonnés, pas exécutés. Les
  constats de concurrence (legs concurrents, amorçage simultané) reposent sur la lecture.
- **Aucun test contre le vrai Discord.** Le comportement de `prompt=none` vient de la documentation
  et d'une discussion officielle, pas d'une observation.
- **Le frontend n'a pas été audité au-delà du parcours d'authentification** — ni les gabarits
  admin, ni le JS de gestion.
- **`nginx` n'a pas été rejoué en conteneur.** Vu l'épisode du §12 de l'audit 503, toute
  conclusion sur les zones doit être confirmée par `nginx -T` sur le conteneur en service.
