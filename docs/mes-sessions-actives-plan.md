# Mes sessions actives — plan

> **Nature de ce document.** Plan de conception, **rien n'est implémenté**. Il referme les
> constats **A-03** (« personne ne peut voir ni fermer ses propres sessions ») et **A-06**
> (« se reconnecter n'invalide aucune session existante ») de
> [audit-auth-discord.md](audit-auth-discord.md).
>
> Rien n'est commité — l'utilisateur fait ses commits lui-même.
>
> **Date : 2026-09-15.** Périmètre : `backEnd/routes_auth.py`, `backEnd/auth_discord.py`,
> `frontEnd/frontend.py`, `frontEnd/templates/mon_compte.html`, un nouveau fichier de tests.
> **Aucune migration** : la table `sessions_joueurs` porte déjà tout ce qu'il faut.

---

## Le problème, en une page

Aujourd'hui, quelqu'un qui soupçonne un vol de token n'a **aucun recours seul**. Inventaire
exhaustif de ce qui existe (vérifié route par route) :

| Geste | Qui peut | Où |
|---|---|---|
| Fermer **la** session courante | le titulaire | `POST /auth/logout` ([routes_auth.py:61](../backEnd/routes_auth.py#L61)) |
| Fermer **toutes** les sessions d'un compte | un admin `gestion_comptes` | `DELETE /admin/comptes/<id>/sessions` ([routes_comptes.py:1172](../backEnd/routes_comptes.py#L1172)) |
| **Lister** ses sessions | le titulaire, **en export RGPD uniquement** | `GET /me/export` ([routes_comptes.py:1885](../backEnd/routes_comptes.py#L1885)) |
| **Fermer** ses autres sessions | *personne* | — |

Le réflexe naturel — se reconnecter — **n'invalide pas** le token volé : `login()` ajoute une
ligne sans toucher aux précédentes ([auth_discord.py:407](../backEnd/auth_discord.py#L407)).
Le seul ménage porte sur les sessions déjà expirées.

La victime doit donc contacter un administrateur, qui appellera `revoquer_sessions`. Sur un
projet sans support permanent, c'est un délai pendant lequel le token volé reste vivant —
jusqu'à **30 jours** pour un compte joueur.

**Toute la donnée nécessaire est déjà en base.** La migration l'avait explicitement prévu :

```sql
-- Pas d'IP : user_agent suffit a un ecran "vos sessions actives".
user_agent    character varying(255)
```
— [schema.sql:407](../backEnd/schema.sql#L407)

L'écran a été conçu, il n'a pas été construit. Ce plan le construit.

---

## Décisions de conception

### D1 — Pas de révocation ciblée par appareil, au moins pas maintenant

`sessions_joueurs` a pour **clé primaire `token_hash`** ([schema.sql:401](../backEnd/schema.sql#L401)).
Il n'existe aucun identifiant de session exposable : le seul qui existe *est* le secret.

Trois options, et pourquoi la deuxième :

| Option | Coût | Verdict |
|---|---|---|
| Exposer `token_hash` comme identifiant | **zéro** migration | ❌ **à ne jamais faire.** Le hash est le vérificateur d'authentification. Le descendre dans le DOM d'une page, c'est publier la moitié du mécanisme qui protège la session, et offrir à un XSS la liste exacte des cibles à révoquer (déni de service sur le compte). |
| **« Déconnecter partout », avec ou sans la session courante** | **zéro** migration | ✅ **retenu.** Couvre le cas réel — quand on soupçonne un vol, on ne trie pas, on ferme tout. Referme A-03 **et** A-06 d'un seul geste. |
| Ajouter `id serial UNIQUE` pour cibler un appareil | une migration | ⏸ **plus tard si le besoin apparaît.** N'invalide rien de ce plan : la colonne s'ajoute et les routes se complètent sans rien réécrire. |

La liste reste donc en **lecture seule par ligne** ; l'action est globale. C'est exactement le
découpage que l'audit proposait (« en gardant ou non la session courante »).

### D2 — Marquer la session courante sans exposer d'identifiant

L'écran doit dire « celle-ci, c'est vous » — sinon « déconnecter partout » est anxiogène et la
liste illisible. Le backend connaît déjà le `token_hash` courant (il vient de s'authentifier
avec) : il compare **côté serveur** et n'émet qu'un booléen `courante: true/false`. Aucun
identifiant ne sort jamais.

### D3 — Ne pas envoyer le `user_agent` brut au navigateur

Deux raisons, dans cet ordre :

1. **Utilité.** Une UA brute de 255 caractères (`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36…`)
   n'aide personne à reconnaître son propre appareil. Or reconnaître son appareil est *la seule*
   fonction de cet écran.
2. **Sûreté d'affichage.** C'est une chaîne **contrôlée par le client** : elle est écrite telle
   quelle en base depuis un en-tête HTTP
   ([frontend.py:703](../frontEnd/frontend.py#L703) → [auth_discord.py:329](../backEnd/auth_discord.py#L329)).
   Jinja échappe par défaut, mais la règle du projet est de ne pas faire reposer une garantie sur
   un défaut : on réduit la chaîne à un libellé issu d'une **liste fermée**.

Le backend renvoie donc un `appareil` résumé (`"Firefox sur Linux"`, `"Application mobile"`,
`"Appareil inconnu"`), produit par une fonction pure et testable, à partir d'un petit tableau de
correspondances. L'UA brute **reste disponible dans l'export RGPD** — c'est bien une donnée
personnelle collectée, et l'export doit continuer à la restituer intégralement.

### D4 — « Déconnecter partout » garde la session courante par défaut

Le geste utile est *« expulse tous les autres, je reste »*. Se déconnecter soi-même en prime est
une punition gratuite qui pousse à ne pas cliquer. Le paramètre `inclure_courante` existe quand
même (utile sur un appareil qu'on est en train d'abandonner), mais il vaut `false` par défaut.

### D5 — Rotation à la connexion (A-06) : par l'écran, pas automatiquement

Fermer automatiquement les anciennes sessions à chaque `login()` réglerait A-06 — mais casserait
l'usage normal « mon téléphone **et** mon PC », qui est légitime et fréquent. La bonne réponse
est de rendre le ménage **possible et visible**, pas obligatoire. A-06 se referme donc par
l'existence du bouton, pas par un changement dans `login()`.

C'est une décision à acter explicitement dans l'audit (voir Phase 5), pas à laisser implicite.

### D6 — Une section, pas un onglet

`mon_compte.html` fait 211 lignes avec une seule `<section>` et aucun système d'onglets
([mon_compte.html:19](../frontEnd/templates/mon_compte.html#L19)). Introduire une mécanique
d'onglets pour un seul ajout créerait un composant à maintenir pour rien. On ajoute une section
`<hr>`-séparée, dans le style des blocs « Fiche joueur » et « Vos données » existants.

---

## Ce qui est construit

### Phase 1 — Backend : lire ses sessions

**Fichier : [`backEnd/routes_auth.py`](../backEnd/routes_auth.py)**

Nouvelle route `GET /auth/mes-sessions`, décorée `@player_required`.

- Requête : `SELECT created_at, expires_at, last_seen_at, user_agent, token_hash
  FROM sessions_joueurs WHERE compte_id = %s AND expires_at > now() ORDER BY last_seen_at DESC NULLS LAST, created_at DESC`
  - **`expires_at > now()`** : une session expirée n'est pas « active ». Les lignes mortes ne sont
    purgées qu'à leur prochaine présentation ([auth.py:108-113](../backEnd/auth.py#L108-L113)) ;
    sans ce filtre, l'écran afficherait des fantômes et le compteur mentirait.
  - Tri sur `last_seen_at` : la session la plus récemment vue en haut, c'est-à-dire la plus
    probablement la sienne.
- `token_hash` est lu **uniquement** pour la comparaison en mémoire avec `hash_token(request.headers[SESSION_HEADER])`,
  et **jamais** placé dans la réponse (D2).
- Réponse :

```json
{"sessions": [
  {"appareil": "Firefox sur Linux",
   "ouverte_le": "2026-09-12T18:04:11+00:00",
   "expire_le": "2026-10-12T18:04:11+00:00",
   "derniere_activite": "2026-09-15T09:21:40+00:00",
   "courante": true}
]}
```

- Erreurs : `401` (session invalide) et `503` (base indisponible) viennent déjà de
  `player_required` et de la convention `_erreur` — rien de nouveau à inventer, juste à respecter.

**Fichier : [`backEnd/auth_discord.py`](../backEnd/auth_discord.py)** (ou un module utilitaire si
`auth_discord.py` paraît déjà chargé)

Fonction pure `resumer_appareil(user_agent: str | None) -> str` :

- liste fermée de correspondances, testée : navigateur (Firefox / Chrome / Edge / Safari — Edge
  **avant** Chrome, Chrome **avant** Safari, car leurs UA se contiennent mutuellement) et système
  (Windows / macOS / Linux / Android / iOS — Android **avant** Linux, pour la même raison) ;
- `None`, chaîne vide ou aucune correspondance → `"Appareil inconnu"` ;
- ne renvoie **jamais** un fragment de l'entrée, seulement une constante du tableau. C'est ce qui
  rend l'affichage sûr par construction plutôt que par échappement.

L'ordre des tests de correspondance est le seul piège de cette fonction : il est commenté sur
place, et verrouillé par un test dédié.

### Phase 2 — Backend : fermer ses autres sessions

**Fichier : [`backEnd/routes_auth.py`](../backEnd/routes_auth.py)**

Nouvelle route `DELETE /auth/mes-sessions`, décorée `@player_required`.

- Corps optionnel : `{"inclure_courante": false}` (défaut `false`, cf. D4).
- Sans `inclure_courante` :
  `DELETE FROM sessions_joueurs WHERE compte_id = %s AND token_hash != %s`
- Avec : `DELETE FROM sessions_joueurs WHERE compte_id = %s` — et la réponse porte
  `session_fermee: true` pour que le frontend sache qu'il doit vider sa session serveur.
- Réponse : `{"status": "success", "sessions_fermees": <n>, "session_fermee": <bool>}`.
- **Pas d'écriture dans `audit_admin`.** Cette table trace ce qu'un administrateur fait *à autrui*
  (`_audit` renseigne `acteur_compte_id` + `cible_id`, [routes_comptes.py:40](../backEnd/routes_comptes.py#L40)) ;
  un titulaire agissant sur son propre compte n'y a pas sa place, et l'y mettre brouillerait la
  lecture du registre RGPD. Un `logger.info` sans donnée personnelle suffit.

### Phase 3 — Frontend : proxy

**Fichier : [`frontEnd/frontend.py`](../frontEnd/frontend.py)**

Deux routes, calquées sur `/me/cgu` ([frontend.py:1158](../frontEnd/frontend.py#L1158)) qui est le
précédent exact (route joueur, CSRF, `player_headers()`) :

- `GET /mon-compte/sessions` → relaie `GET /auth/mes-sessions`, renvoie le JSON tel quel.
- `POST /mon-compte/sessions/fermer` → relaie `DELETE /auth/mes-sessions`.
  En `POST` et non `DELETE` côté frontend : `CSRFProtect` protège les méthodes mutantes et le
  `fetch` envoie déjà `X-CSRFToken` comme les autres actions de la page.
  **Si le backend renvoie `session_fermee: true`**, purger `session['player_token']` et
  `session['compte']` avant de répondre — exactement ce que fait déjà
  `supprimer_mon_compte` ([frontend.py:1204-1207](../frontEnd/frontend.py#L1204-L1207)).
  Sans ça, le navigateur garderait un cookie pointant vers une session détruite et découvrirait le
  problème par une erreur.
- `headers is None` → `401`, même convention que l'existant.

### Phase 4 — Frontend : l'écran

**Fichier : [`frontEnd/templates/mon_compte.html`](../frontEnd/templates/mon_compte.html)**

Nouvelle section entre « Vos données » et le bloc gris d'explication RGPD, dans le style des blocs
voisins (`<hr>`, titre `has-text-weight-semibold`, `content is-small`) :

```
──────────────────────────────────
Vos appareils connectés

  🖥  Firefox sur Linux              ← cet appareil
      Ouverte le 12/09 · vue il y a 3 minutes

  📱  Application mobile
      Ouverte le 02/09 · vue il y a 6 jours

  [ Déconnecter les autres appareils ]

  Vous ne reconnaissez pas un appareil ? Déconnectez-le : la personne qui
  l'utilise devra se reconnecter avec votre compte Discord pour revenir.
──────────────────────────────────
```

Points d'exécution :

- **Chargement en `fetch` au `DOMContentLoaded`**, pas en rendu serveur. `mon_compte()` fait déjà
  deux appels backend (`/auth/me` puis `/auth/ma-demande`) ; en ajouter un troisième synchrone
  ralentirait une page que tout le monde visite, pour un bloc que peu regardent. En attendant :
  une ligne « Chargement… ».
- **Construction par `textContent` / `createElement`**, jamais `innerHTML` avec de la donnée
  serveur — la page le fait déjà partout ailleurs (bannière CGU, `afficher()`), on suit.
- **Le bouton est masqué quand il n'y a qu'une session** : proposer « déconnecter les autres »
  quand il n'y en a pas est une fausse action.
- **Confirmation avant action** (`confirm()`, comme la suppression de compte), texte explicite sur
  ce qui va se passer : les autres appareils devront se reconnecter.
- **Après succès** : recharger la liste et afficher un message via le `afficher()` déjà présent
  (`alerte-rgpd` ou une zone jumelle). Si `session_fermee` est vrai → `window.location.href = '/'`.
- **Dates en relatif** (« il y a 3 minutes ») avec la date absolue en `title` : « vue il y a 6
  jours » se comprend d'un coup d'œil, `2026-09-09T14:22:07+00:00` non.
- **Échec réseau** : message d'erreur, jamais une liste vide silencieuse — une liste vide se lirait
  « aucune session », ce qui est faux et rassurant à tort.

### Phase 5 — Tests et mise à jour de l'audit

**Nouveau fichier : `backEnd/tests/test_mes_sessions.py`**, sur `harness.py` (curseur scripté, ni
Postgres ni Discord, comme le reste de la suite).

Couverture visée :

| # | Ce qui est vérifié | Pourquoi ça compte |
|---|---|---|
| 1 | `GET` sans token → `401` | la route est bien derrière `player_required` |
| 2 | La réponse ne contient **jamais** `token_hash` (ni aucune chaîne de 64 caractères hex) | D2 — c'est **l'assertion centrale** du fichier |
| 3 | Exactement une entrée a `courante: true`, et c'est celle du token présenté | l'écran est illisible sinon |
| 4 | Les sessions expirées sont absentes de la liste | le compteur ne doit pas mentir |
| 5 | `DELETE` par défaut épargne la session courante | D4 |
| 6 | `DELETE` ne touche **aucune** session d'un autre `compte_id` | cloisonnement — la régression la plus grave possible ici |
| 7 | `inclure_courante: true` ferme tout et renvoie `session_fermee: true` | le frontend s'appuie dessus pour purger le cookie |
| 8 | `resumer_appareil` : Edge≠Chrome, Android≠Linux, `None` → `"Appareil inconnu"` | l'ordre des correspondances est le piège de la fonction |
| 9 | `resumer_appareil` sur une UA contenant `<script>` renvoie une constante du tableau | D3 — sûr par construction, pas par échappement |

**Mise à jour de [audit-auth-discord.md](audit-auth-discord.md).** Le mécanisme des assertions
`defaut(...)` va faire virer au rouge celles de A-03 et A-06 dans
`test_audit_auth_discord.py` — **c'est le résultat attendu**, et la consigne du fichier est
d'aller mettre le document à jour. À faire dans le même commit :

- retirer `A_AUCUNE_GESTION_DE_SES_SESSIONS` et `A_PAS_DE_ROTATION_A_LA_CONNEXION` (ou convertir
  les assertions en non-régressions : « le titulaire **peut** lister et fermer ») ;
- passer A-03 et A-06 en ✅ dans le tableau du verdict, en renvoyant à ce document ;
- acter **D5** noir sur blanc : la reconnexion ne fait toujours pas de rotation automatique, et
  c'est un choix, pas un oubli. C'est la même exigence que celle posée pour A-07 — l'ambiguïté
  n'est pas défendable.

---

## Ce que ce plan ne fait pas

- **Pas de révocation par appareil** (D1) — demanderait une migration ; à rouvrir si le besoin
  se manifeste.
- **Pas d'adresse IP**, ni de géolocalisation. La migration a tranché (« Pas d'IP »), et le scope
  OAuth est `identify` seul : collecter une IP pour l'afficher irait à rebours de la minimisation
  revendiquée par la politique de confidentialité.
- **Pas de notification** (« nouvelle connexion depuis un appareil inconnu »). Utile, mais c'est
  un autre chantier : il touche `notifier()` et la boîte de notifications.
- **Pas de rotation automatique à la connexion** (D5).
- **Ne referme ni A-01/A-02** (durée de session figée sur le rôle), **ni A-04/A-05** (dette du mot
  de passe partagé), **ni A-07** (CGU). Indépendants, chacun son commit.

---

## Ordre d'exécution et découpage en commits

Trois commits, chacun laissant la suite verte :

1. **Backend + tests** (phases 1, 2, 5-tests) — les deux routes, `resumer_appareil`, le nouveau
   fichier de tests. Vérifiable sans interface.
2. **Frontend** (phases 3, 4) — proxy et écran.
3. **Mise à jour de l'audit** (phase 5-doc) — les assertions `defaut()` et le tableau du verdict.

Commit 3 ne peut pas précéder le 1 : l'audit deviendrait faux entre les deux.

### Vérification

```bash
cd backEnd/tests && sh run.sh          # suite complète
python3 test_mes_sessions.py           # le nouveau fichier
python3 test_audit_auth_discord.py     # doit devenir ROUGE sur A-03 et A-06 avant le commit 3
```

**État connu de la suite avant ce chantier** (constaté par l'audit, sans rapport avec lui) :
`test_auth.py` échoue sur 1 assertion d'URL d'avatar obsolète, `test_liaisons.py` et
`test_profils.py` sur des fixtures. Ils ne doivent ni s'aggraver, ni être corrigés ici — ce serait
mélanger deux sujets.

### Manuellement, avant de considérer que c'est livré

Deux navigateurs (ou un navigateur + une fenêtre privée), même compte :

1. les deux sessions apparaissent, une seule marquée « cet appareil » ;
2. « Déconnecter les autres » depuis A → B est expulsé **à sa page suivante**, A continue ;
3. B se reconnecte → réapparaît dans la liste de A.

Le point 2 mérite d'être vu en vrai : B n'est pas expulsé instantanément mais à sa requête
suivante, puisque la session est vérifiée à chaque requête protégée et non poussée. C'est le
comportement correct, mais c'est celui qu'on croira cassé si on ne l'a pas anticipé.
