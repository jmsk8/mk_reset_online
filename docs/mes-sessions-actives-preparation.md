# Mes sessions actives — préparation avant implémentation

> **Nature de ce document.** Vérification du terrain faite le **2026-09-16**, avant d'écrire la
> moindre ligne. Le plan [mes-sessions-actives-plan.md](mes-sessions-actives-plan.md) (2026-09-15)
> reste la référence de conception : ce document ne le remplace pas, il **corrige ses ancres**,
> **confirme ce qui tient** et **lève les cinq points qu'il laisse ouverts**.
>
> Conclusion générale : **le plan est solide, ses six décisions tiennent, aucune n'est à rouvrir.**
> Rien n'est implémenté à ce jour. Rien n'est commité — l'utilisateur fait ses commits lui-même.

---

## 1. Ce qui a été vérifié dans le code, et qui tient

Chaque affirmation du plan a été recoupée avec le source. Toutes sont exactes sur le fond :

| Affirmation du plan | Vérifié | Où |
|---|---|---|
| Aucune route `/auth/mes-sessions` n'existe | ✅ | absente de `routes_auth.py` |
| Aucun `backEnd/tests/test_mes_sessions.py` | ✅ | absent du dossier |
| `sessions_joueurs` porte tout le nécessaire, **aucune migration** | ✅ | [schema.sql:418-426](../backEnd/schema.sql#L418) |
| La PK est `token_hash`, aucun identifiant exposable | ✅ | [schema.sql:419](../backEnd/schema.sql#L419) |
| Le commentaire « Pas d'IP : user_agent suffit » est bien en base | ✅ | [schema.sql:424](../backEnd/schema.sql#L424) |
| `login()` empile une session sans toucher aux précédentes | ✅ | [auth_discord.py:327](../backEnd/auth_discord.py#L327) |
| Le seul ménage automatique vise les sessions **expirées** | ✅ | [auth_discord.py:332](../backEnd/auth_discord.py#L332), `WHERE expires_at < now()` |
| `logout()` ne ferme que la session courante | ✅ | [routes_auth.py:70](../backEnd/routes_auth.py#L70) |
| L'export RGPD liste déjà les sessions (UA brute incluse) | ✅ | [routes_comptes.py:1896](../backEnd/routes_comptes.py#L1896) |
| `player_required` existe et injecte `g.compte` | ✅ | [auth.py:135](../backEnd/auth.py#L135) |
| Le précédent proxy joueur (CSRF + `player_headers()`) | ✅ | [frontend.py:1264](../frontEnd/frontend.py#L1264) |
| La purge du cookie après destruction de session | ✅ | [frontend.py:1303](../frontEnd/frontend.py#L1303) |
| Deux index utiles existent déjà sur la table | ✅ | [schema.sql:428-429](../backEnd/schema.sql#L428) |

**Aucune décision (D1→D6) n'est remise en cause par cette relecture.**

## 2. Ancres à corriger dans le plan (dérive de numérotation)

Le code a bougé depuis le 15/09. Les numéros de ligne du plan sont faux — le fond est juste, mais
suivre les liens mène au mauvais endroit. À rectifier **dans le plan** au moment de l'implémenter :

| Le plan dit | En réalité | Objet |
|---|---|---|
| `routes_auth.py:61` | [routes_auth.py:62](../backEnd/routes_auth.py#L62) | `logout()` |
| `routes_comptes.py:1172` | [routes_comptes.py:1175](../backEnd/routes_comptes.py#L1175) | `revoquer_sessions()` |
| `routes_comptes.py:1885` | [routes_comptes.py:1835](../backEnd/routes_comptes.py#L1835) | `/me/export` |
| `schema.sql:401` / `:407` | [schema.sql:419](../backEnd/schema.sql#L419) / [:424](../backEnd/schema.sql#L424) | PK et `user_agent` |
| `auth_discord.py:407` | [auth_discord.py:406](../backEnd/auth_discord.py#L406) | appel `create_session` |
| `auth_discord.py:329` | [auth_discord.py:327](../backEnd/auth_discord.py#L327) | `INSERT` de session |
| `frontend.py:703` | [frontend.py:814](../frontEnd/frontend.py#L814) | capture de l'UA |
| `frontend.py:1158` | [frontend.py:1264](../frontEnd/frontend.py#L1264) | proxy `/me/cgu` |
| `frontend.py:1204-1207` | [frontend.py:1303](../frontEnd/frontend.py#L1303) | purge du cookie |
| `auth.py:108-113` | [auth.py:108-113](../backEnd/auth.py#L108-L113) | ✅ exact, ne pas toucher |

## 3. Les cinq points que le plan laisse ouverts

Ce sont les seules vraies questions. Aucune n'invalide le plan ; toutes doivent être tranchées
**avant** d'écrire le code, sinon elles le seront par accident pendant.

> **Arbitrées le 2026-09-16.** P1 → relecture de l'en-tête + `hash_token` (au choix de
> l'implémentation). P3 → **« jamais utilisée »**. P5 → **journal technique seul**, sans trace
> consultable, choix assumé. P2 et P4 ne demandaient pas d'arbitrage (constats de recette).

### P1 — `player_required` n'expose pas le `token_hash` ⚠️ le seul vrai piège

Le plan écrit (phase 1) que la route compare `token_hash` avec
`hash_token(request.headers[SESSION_HEADER])`. C'est **faisable mais mal dit**, et l'imprécision
coûterait une erreur :

- `player_required` injecte `g.compte` et **rien d'autre** ([auth.py:135](../backEnd/auth.py#L135)) :
  ni le token, ni son hash. La route doit donc **relire l'en-tête elle-même**, exactement comme
  `logout()` le fait déjà ([routes_auth.py:64](../backEnd/routes_auth.py#L64)).
- Il existe **deux** fonctions de hachage identiques : `_hash` (privée,
  [auth.py:42](../backEnd/auth.py#L42)) et `hash_token` (publique,
  [auth_discord.py:66](../backEnd/auth_discord.py#L66)). **Utiliser `hash_token`** — `routes_auth.py`
  l'importe déjà, et importer une privée d'un autre module serait une régression de style.
- `request.headers[SESSION_HEADER]` avec des crochets **lève `KeyError`** si l'en-tête manque.
  Utiliser `.get()`. Le cas est théoriquement impossible derrière `player_required`, mais un 500
  sur une page « sécurité » est le pire endroit pour un théorème.

**Décision à acter : la route relit l'en-tête via `request.headers.get(SESSION_HEADER)` et hache
avec `hash_token`.** Une ligne, mais c'est celle qui porte D2 tout entière.

### P2 — `last_seen_at` est mis à jour *avant* que la route ne s'exécute

Non mentionné par le plan, et **visible à l'écran** : `_charger_compte_session` fait
`UPDATE sessions_joueurs SET last_seen_at = now()` à **chaque** requête protégée
([auth.py:119](../backEnd/auth.py#L119)), donc avant le corps de la route.

Conséquence : la session courante affichera toujours « vue à l'instant ». C'est **correct** (elle
vient effectivement d'être vue) mais il ne faut pas le découvrir en croyant à un bug, ni écrire un
test qui attend autre chose. À commenter sur place.

### P3 — `last_seen_at` peut être `NULL`, et le tri en dépend

La colonne est **nullable** ([schema.sql:423](../backEnd/schema.sql#L423)) : une session créée mais
jamais représentée l'a à `NULL`. Le plan y pense pour le tri (`NULLS LAST`, correct) mais **pas pour
l'affichage** : la phase 4 prévoit « vue il y a 3 minutes » sans dire quoi faire d'un `NULL`.

**À trancher** : afficher « jamais utilisée » (recommandé — c'est informatif, et une session jamais
utilisée sur un compte qu'on croit compromis est précisément le signal qu'on cherche), et surtout
**ne pas** laisser passer un « il y a 56 ans » d'epoch.

### P4 — Durées de session très inégales selon le rôle

Un compte joueur a `SESSION_JOUEUR_LIFETIME_DAYS`, un admin `SESSION_ADMIN_LIFETIME_HOURS`
([auth_discord.py:321-324](../backEnd/auth_discord.py#L321)). L'écran montrera donc des horizons
d'expiration sans commune mesure entre un joueur et un admin.

Ce n'est pas un défaut (c'est A-01/A-02, hors périmètre), mais **la colonne « expire le » n'a pas le
même sens** selon qui regarde. Afficher la date sans commentaire est acceptable ; l'oublier dans la
recette ne l'est pas.

### P5 — Le geste est irréversible et sans trace

Le plan écrit, à juste titre, qu'il ne faut **pas** écrire dans `audit_admin` (phase 2) : cette table
trace ce qu'un admin fait *à autrui*. D'accord. Mais il en résulte que **« déconnecter partout » ne
laisse aucune trace exploitable** — ni pour l'utilisateur, ni pour le support.

Le `logger.info` prévu suffit pour ce périmètre. **À acter comme choix**, pas à laisser implicite :
si quelqu'un se plaint plus tard d'avoir été déconnecté sans comprendre pourquoi, il n'y aura rien
à lui montrer.

## 4. Deux angles que le plan ne couvre pas du tout

### A1 — Les sessions sont aussi détruites par trois routes admin

`DELETE FROM sessions_joueurs WHERE compte_id = %s` existe à **trois** endroits de
`routes_comptes.py` — [1192](../backEnd/routes_comptes.py#L1192) (révocation),
[1297](../backEnd/routes_comptes.py#L1297) et [2019](../backEnd/routes_comptes.py#L2019)
(suspension / anonymisation).

La nouvelle route `DELETE /auth/mes-sessions` sera donc la **quatrième** écriture de cette forme.
Aucun conflit — mais le test 6 du plan (« ne touche aucune session d'un autre `compte_id` ») prend
ici tout son sens : c'est la même requête que celle des routes admin, à une clause près. **Se
tromper de clause donne une route joueur qui déconnecte tout le monde.** C'est la régression la
plus grave possible sur ce chantier, et elle est à un caractère près.

### A2 — L'API bot ne crée pas de sessions : rien à traiter

Vérifié : `INSERT INTO sessions_joueurs` n'existe **qu'à un seul endroit**
([auth_discord.py:327](../backEnd/auth_discord.py#L327)). Le bot porte un jeton Bearer distinct et
n'apparaîtra pas dans la liste. **Aucune action** — noté pour que la question ne soit pas reposée.

## 4bis. HTTP en dev, HTTPS en ligne — contrainte de compatibilité

Précisé le 2026-09-16 : **le développement tourne en `http`, la version en ligne en `https`.** Le
`.env` du dépôt est celui de dev (`DISCORD_REDIRECT_URI` en `http:`, pas de `TLS_MODE` → défaut
`http`) ; la prod porte son propre `.env` avec `TLS_MODE=https`. C'est le fonctionnement documenté
([README.md:167](../README.md#L167) et §201), **pas un oubli** — une première version de cette
section le signalait à tort comme un défaut de configuration.

Le mécanisme est déjà en place et n'a rien à recevoir de ce chantier :

- `SESSION_COOKIE_SECURE = (os.environ.get('TLS_MODE', 'http') == 'https')`
  ([frontend.py:47](../frontEnd/frontend.py#L47)) — le commentaire sur place dit exactement
  pourquoi : en http local, `Secure` bloquerait toute connexion admin.
- `SAMESITE='Lax'` en dur, **à ne pas passer à `Strict`** : le retour de Discord est une navigation
  cross-site ([frontend.py:44](../frontEnd/frontend.py#L44)).
- `ProxyFix` ([frontend.py:641](../frontEnd/frontend.py#L641)) et deux jeux de templates nginx
  (`nginx/templates/http/` et `https/`) sélectionnés par `TLS_MODE`.

**Ce que ça impose au code de ce chantier — la règle tient en une phrase : ne rien écrire qui
dépende du schéma.** Concrètement :

- `[ ]` **Aucune URL absolue en dur** (ni `http://`, ni `https://`) dans le proxy ou le template.
  Les appels backend passent par `BACKEND_URL`, les liens par `url_for`. Le `fetch` de l'écran vise
  un chemin relatif (`/mon-compte/sessions`), qui suit le schéma de la page sans le nommer.
- `[ ]` **Ne pas toucher aux réglages de cookie** : ce chantier n'en pose aucun. La purge de session
  côté proxy réutilise `session.pop(...)`, qui hérite de la configuration existante.
- `[ ]` **Ne rien supposer du transport dans les tests** : `test_mes_sessions.py` tourne sur
  `harness.py`, sans serveur — il ne doit ni lire `TLS_MODE` ni fabriquer d'URL absolue.
- `[ ]` **Recette à faire deux fois** : en dev http, et une fois en ligne en https. Le point à
  surveiller en ligne est le `fetch` `POST` avec `X-CSRFToken` — un cookie `Secure` absent en dev
  est présent en prod, et c'est le seul endroit où les deux environnements peuvent diverger.

Rien de tout cela n'est un obstacle : le code prévu (chemins relatifs, proxy existant, pas de
cookie nouveau) est **compatible des deux côtés par construction**. Ces cases sont là pour que ça
le reste.

## 5. Impact sur la suite de tests, mesuré

Deux assertions `defaut()` basculeront au rouge, **ce qui est le résultat attendu** :

- [test_audit_auth_discord.py:149](../backEnd/tests/test_audit_auth_discord.py#L149) — A-03,
  « aucune route self-service ne liste ses sessions ». Elle teste littéralement
  `'/auth/mes-sessions' not in routes_auth_src` : elle tombera **dès la phase 1**.
- [test_audit_auth_discord.py:180](../backEnd/tests/test_audit_auth_discord.py#L180) — A-06,
  « se reconnecter n'invalide aucune session ». ⚠️ **Celle-ci ne basculera pas**, car D5 maintient
  qu'on ne touche pas à `login()`. Elle restera rouge/vraie, et c'est cohérent : A-06 se referme par
  l'existence du bouton, pas par un changement de comportement à la connexion. **Le plan dit que les
  deux vont virer — c'est inexact pour A-06.**

L'assertion [:153](../backEnd/tests/test_audit_auth_discord.py#L153) (« logout ne ferme QUE la
session courante ») doit **rester verte** : on n'y touche pas.

**État connu de la suite avant ce chantier** (sans rapport avec lui, à ne pas corriger ici) :
`test_auth.py` échoue sur 1 assertion d'URL d'avatar, `test_liaisons.py` et `test_profils.py` sur des
fixtures.

## 6. Ordre d'exécution retenu

Inchangé par rapport au plan — trois commits, chacun laissant la suite verte :

1. **Backend + tests** : les deux routes, `resumer_appareil`, `test_mes_sessions.py`.
2. **Frontend** : proxy + écran.
3. **Mise à jour de l'audit** : A-03 en ✅, D5 actée noir sur blanc pour A-06.

Le commit 3 ne peut pas précéder le 1 (l'audit deviendrait faux entre les deux).

### Avant d'écrire la première ligne

- [ ] Trancher **P3** (affichage d'un `last_seen_at` à `NULL`).
- [ ] Acter **P1** (relecture de l'en-tête + `hash_token`) — c'est D2 qui en dépend.
- [ ] Acter **P5** (pas de trace persistante, choix assumé).

### Recette manuelle, non négociable

Deux navigateurs, même compte : les deux sessions visibles, une seule « cet appareil » ; A déconnecte
les autres, **B n'est expulsé qu'à sa requête suivante** (la session est vérifiée, pas poussée —
c'est correct, et c'est ce qu'on croira cassé) ; B se reconnecte et réapparaît.
