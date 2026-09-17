# État d'avancement global — référence de reprise

> Ce fichier n'est pas un plan de plus : c'est une photo transversale de tous les chantiers du
> projet, pour qu'une prochaine session n'ait pas à refaire l'inventaire. Il liste ce qui est
> réellement fait (vérifié dans le code, pas seulement dans la doc) et ce qui reste en suspens,
> classé par priorité.
>
> **Dernière mise à jour : 2026-09-18**, après audit croisé docs ↔ code, puis après le chantier
> performance/503 et sa troisième vague (§6 et « Chantiers soldés »). **Complété le 2026-09-16**
> par l'ordre recommandé ci-dessous et le §7.
>
> ⚠️ **Incohérence de dates, non corrigée faute de savoir laquelle fait foi.** Ce document est
> daté du 18/09 et décrit des livrables des 17 et 18/09, alors que la date système est le
> **2026-09-16** et que le dernier commit (`fe69c0e`, 503 nginx) date du 16/09. Le **code
> confirme les livrables** (migrations `2026-09-17_*` présentes, tests en place) : seules les
> dates dérivent, d'environ deux jours. À recaler si la chronologie compte.
>
> À chaque reprise de chantier listé ici, mettre à jour la ligne correspondante plutôt que de
> relire tous les docs de zéro. Quand un point est traité, le déplacer dans « Chantiers soldés »
> avec sa date, ou le supprimer si le doc source le documente déjà correctement.

## Ordre recommandé pour la prochaine maj — arbitré le 2026-09-16

> Cette section classe par **urgence réelle**, pas par numéro de chantier. La numérotation de
> « Tâches en suspens » ci-dessous est un inventaire, pas une priorité : les renvois d'autres
> docs s'y appuient, donc elle ne bouge pas. Le critère du classement est simple — **est-ce que
> la dette grossit pendant qu'on attend ?**

| # | Action | Renvoi | Pourquoi ce rang |
|---|---|---|---|
| 1 | **Réaccorder les sous-permissions fiche joueur aux admins en prod** | « Chantiers soldés », 17/09 | Seul point dont l'impact est **déjà en cours** : des admins sont bloqués maintenant. Pas du code, quelques minutes dans le panneau. |
| 2 | ~~**« Mes sessions actives »**~~ | §2 | ✅ **codé le 16/09**, non commité. Recette manuelle à faire. |
| 3 | **Rotation logrotate des journaux nginx** | §3 | Le coût **monte tout seul** (disque). Config à poser, pas du développement. |
| 4 | **Corriger le §8 de schema-base-de-donnees.md** | « Note obsolète » | Doc **fausse sur un contrôle de privilèges** : induit en erreur la prochaine session. ~5 min. |
| 5 | **Test du gate de permission, côté frontend** | §5 | Angle mort réel mais **étroit** — voir la correction de périmètre ci-dessous. |
| 6 | **Journal `audit_admin`** | §4 | **Gagne à attendre** : les INSERT tournent déjà, les données s'accumulent. |
| 7 | **Étape 6 auth Discord** | §1 | **Pas un choix** : bloquée par des prérequis d'exploitation, se reporte d'elle-même. |

**Session minimale utile : 1 + 2 + 4.** Le reste tient sans dommage.

⚠️ **Correction de périmètre sur le §5** (vérifiée dans le code le 2026-09-16) : le gate
`gestion_config` **est déjà testé côté backend** — `test_scission_permissions.py` vérifie qu'un
`gestion_config` seul reçoit bien un 403, et `test_hierarchie_routes.py` couvre les permissions
effectives. Le trou restant est **uniquement côté frontend**
([frontend.py:1471](../frontEnd/frontend.py#L1471)) : la distinction session expirée (redirection)
vs droit manquant (message, sans déconnexion). Le §5 ci-dessous surestime ce qui manque.

ℹ️ **Précision sur le §4** : `audit_admin` reçoit des `INSERT` depuis **7 fichiers**
(`auth_discord.py`, `routes_auth.py`, `services.py`, `routes_admin.py`, `routes_comptes.py`), pas
seulement le domaine « comptes » comme l'affirme le §4. Le constat qui compte reste vrai :
**aucun `SELECT` nulle part**.

## Tâches en suspens, par priorité

### 1. Auth Discord — étape 6 (suppression du mot de passe admin) non franchie

Voir [auth-discord-avancement.md](auth-discord-avancement.md) Phase 4 et
[audit-auth-discord.md](audit-auth-discord.md). Dette assumée (🟡, pas une brèche), mais toujours
active :

- `backEnd/routes_admin.py` — route `POST /admin-auth` toujours vivante (`bcrypt.checkpw` contre
  `ADMIN_PASSWORD_HASH`).
- `backEnd/db.py` — `ADMIN_PASSWORD_HASH` toujours chargée depuis l'environnement.
- `frontEnd/frontend.py` — appelle toujours `/admin-auth`.
- Table `api_tokens` (stockage en clair) toujours présente.

**Prérequis avant de couper**, checklist §2 de [runbook-admin.md](runbook-admin.md), toutes les
cases encore non cochées : deux comptes `superadmin` distincts, procédure break-glass exécutée au
moins une fois pour de vrai, période de recouvrement passée. Ce sont des faits d'exploitation, à
vérifier/cocher manuellement, pas du code.

### 2. "Mes sessions actives" — ✅ CODÉ le 2026-09-16, non commité, recette manuelle à faire

> **Livré dans l'arbre de travail.** `GET` et `DELETE /auth/mes-sessions`, `resumer_appareil()`,
> les deux proxys frontend et la section « Vos appareils connectés » dans `/mon-compte`.
> `test_mes_sessions.py` : **57/57**. A-03 converti en non-régressions dans
> `test_audit_auth_discord.py` (**79/79**), A-06 conservé comme choix acté (D5).
> **Rien n'est commité**, et la recette à deux navigateurs reste à faire (§6 de la préparation).
>
> ⚠️ Un défaut préexistant a été corrigé en passant, hors périmètre annoncé :
> `backend_request` **ignorait le corps des requêtes DELETE**
> ([frontend.py](../frontEnd/frontend.py)) — `requests.delete()` était appelé sans `json=data`.
> Aucun appelant existant n'en envoyait, donc c'était sans effet jusqu'ici ; mais
> `inclure_courante` serait parti en silence. À relire, c'est un helper partagé par six appelants.

Le constat d'origine, pour mémoire :

[mes-sessions-actives-plan.md](mes-sessions-actives-plan.md), daté du 2026-09-15. Referme deux
constats d'audit connus (A-03, A-06 dans audit-auth-discord.md). Petit périmètre, plan déjà prêt.

- Aucune route `/auth/mes-sessions` (`GET`/`DELETE`) dans `backEnd/routes_auth.py`.
- Aucun `backEnd/tests/test_mes_sessions.py`.

**Terrain préparé le 2026-09-16** :
[mes-sessions-actives-preparation.md](mes-sessions-actives-preparation.md). Le plan est confirmé
(13 affirmations recoupées avec le code, les 6 décisions D1→D6 tiennent), mais ses numéros de ligne
ont dérivé et **trois points sont à trancher avant d'écrire** : l'accès au `token_hash` (le
décorateur ne l'expose pas — c'est D2 qui en dépend), l'affichage d'un `last_seen_at` à `NULL`, et
l'absence assumée de trace. ⚠️ Le plan annonce que les assertions A-03 **et** A-06 vont basculer :
**inexact pour A-06**, que D5 laisse volontairement en l'état.

### 3. RGPD — deux tâches opérationnelles non cochées

[rgpd-registre.md](rgpd-registre.md), § « Ce qui reste à faire » :

- `[ ]` Rotation des journaux nginx (T5) — aucune config `logrotate` dans le dépôt.
- `[ ]` Purge RGPD régulière (`POST /admin/purge-rgpd`) — route existe mais aucun ordonnanceur/cron
  ne l'appelle ; geste manuel assumé pour l'instant.

### 4. Journal des actions admin (`audit_admin`) — conçu, non codé

[audit-admin-plan.md](audit-admin-plan.md) (plan complet, 4 phases) et
[hierarchie-admin-avancement.md](hierarchie-admin-avancement.md) Chantier 7.

- `audit_admin` ne reçoit des `INSERT` que sur le domaine « comptes »
  (`backEnd/routes_admin.py`, 2 endroits).
- Aucune route ne lit `audit_admin` (pas de bouton "Logs" par compte, pas d'onglet Logs).
- Bloque en aval la promotion-avec-acceptation prévue au §6.5 du plan.

### 5. Tests des 3 routes d'onglets admin (§8.3)

[hierarchie-admin-avancement.md](hierarchie-admin-avancement.md) Chantier 8,
[permissions-onglets-contexte.md](permissions-onglets-contexte.md) §8.3.

**Partiellement levé le 2026-09-17** : `test_session_expiree.py` couvre désormais les trois routes
(`admin_tournois`, `admin_reglages`, `admin_joueurs_fiches`) pour la **revalidation de session** —
chacune doit appeler `_acces_admin_revoque()` avant de rendre, et le helper lui-même est vérifié
(il interroge bien le backend, traite 401/403, mémoïse sur `g` et non sur la session).

**Reste à couvrir** : le **gate de permission** proprement dit — qu'un admin sans `gestion_config`
soit bien renvoyé de `/admin/reglages`, et la distinction session expirée (redirection) vs droit
manquant (message, pas de déconnexion). C'est le cœur du §8.3, et il n'est toujours pas testé.

### 7. Sous-permissions fiche joueur — geste d'exploitation en attente (prod)

Ce n'est pas du code : la migration `2026-09-17_sous_permissions_fiche_joueur.sql` **n'accorde pas
rétroactivement** les cinq nouvelles sous-permissions, et le dit explicitement (« conséquence
assumée et VISIBLE »). Les admins qui portaient `gestion_joueurs` gardent l'onglet mais **ont
perdu les six gestes** (créer, renommer, couleur, mu/sigma, statut, supprimer/anonymiser).

- `[ ]` Les réaccorder un par un dans le panneau des permissions, pour chaque admin concerné.

Tant que ce n'est pas fait, **des admins sont bloqués en production**. C'est le rang 1 du tableau
en tête de document : aucun autre point de la liste n'a un impact déjà en cours.

### 6. Performance / 503 — réglé le 2026-09-18, après une troisième vague

Les deux réserves ci-dessous sont **levées**, et la seconde a révélé la vraie cause : la
configuration corrigée le 2026-09-17 **n'était jamais entrée en service**.

- `[x]` **`nginx -t` exécuté**, configuration valide.
- `[x]` **Comportement réel vérifié** — et c'est là que le défaut est apparu. Le conteneur servait
  `rate=30r/m` (la valeur d'avant toutes les corrections) alors que le fichier disait `rate=8r/s`,
  soit **16 fois moins de débit**. `nginx.conf` est monté comme *fichier* et non comme dossier :
  Docker en fige l'inode au démarrage, un éditeur qui réécrit le fichier le laisse collé à
  l'ancien contenu, et `nginx -s reload` relit la version d'avant sans que rien ne le signale.
  Réparé par `docker compose up -d --force-recreate nginx`.

Deux correctifs en découlent :

- `make reload-nginx` compare désormais les empreintes disque/conteneur et **échoue** en indiquant
  la commande qui répare — l'échec était muet, c'est ce qui a coûté plusieurs jours.
- Le message du limiteur s'affiche enfin dans `admin_comptes.html` : `api()` composait
  « Patientez N secondes » mais les quatre appelants l'écrasaient par « Chargement impossible. ».
  Verrouillé par `test_rafraichissement_droits.py` (39 assertions).

Détail complet et leçons de méthode : §12 de
[audit-503-zone-admin.md](audit-503-zone-admin.md). Rien d'autre n'est en attente sur ce chantier.

## Note obsolète à corriger (pas une tâche de code)

[schema-base-de-donnees.md](schema-base-de-donnees.md) §8 affirme encore qu'un `admin` peut agir
sur un autre `admin`/`chef_admin` et que la règle de rang générique n'est pas en place. **C'est
faux** : livrée et testée le 2026-09-14 (voir Chantier 6 de
[hierarchie-admin-avancement.md](hierarchie-admin-avancement.md), 149 assertions,
`backEnd/auth.py`). Le §8 de schema-base-de-donnees.md est juste à rafraîchir.

## Chantiers volontairement non commencés (pas des oublis)

Rien à faire ici sans nouvelle décision explicite — listés pour éviter de les re-découvrir comme
« manquants » par erreur :

- [plan-achievements.md](plan-achievements.md) — conception seule, dépend potentiellement du
  refactor historique ci-dessous.
- [refactor-historique-recaps-plan.md](refactor-historique-recaps-plan.md) — préparation seule,
  débloqué depuis la fin du chantier sessions-tournois (15/09) mais pas démarré.
- Notification orpheline après annulation de tournoi (§8/R-session-7 de
  [plan-sessions-tournois.md](plan-sessions-tournois.md)) — `notifications` n'a toujours pas de
  colonne `tournoi_id`, mais déjà repris comme « reste » connu dans
  [sessions-tournois-avancement.md](sessions-tournois-avancement.md).
- Suppression de tournoi (`DELETE /delete-tournament/<id>`) — hors périmètre décidé explicitement
  ([onglets-admin-plan.md](onglets-admin-plan.md)).
- Bot Discord — socle API livré, bot lui-même explicitement hors dépôt (projet à part).
- Déploiement production (migrations non appliquées, app Discord OAuth non créée) — actions
  opérationnelles hors code, transparentes dans
  [auth-discord-avancement.md](auth-discord-avancement.md).

## Chantiers soldés récemment (pour mémoire, contexte)

- Hiérarchie à 4 rôles + permissions à la carte — ✅ 2026-09-10
- Règle de rang générique (`compte_cible_protegee`) — ✅ 2026-09-14
- Tiers dynamiques (remplace S/A/B/C fixes) — ✅ testé,
  [tableau-seuils-tiers-plan.md](tableau-seuils-tiers-plan.md)
- Sessions de tournois (remplace la déduplication par date) — ✅ 2026-09-15, 6 phases, 2
  migrations appliquées, [sessions-tournois-avancement.md](sessions-tournois-avancement.md)
- Amorçage superadmin sans invitation, correction du bootstrap bloquant — ✅ 2026-09-14
- Fiche joueur : un droit par geste — ✅ 2026-09-17. `gestion_joueurs` n'ouvre plus que la
  lecture ; les six gestes (créer, renommer, couleur, mu/sigma, statut, supprimer/anonymiser)
  sont des sous-permissions. `rgpd_joueurs` renommée `joueurs_irreversible` (migration
  `2026-09-17_sous_permissions_fiche_joueur.sql`). **Rouvre 8.5-C**, abandonné le 13/09 —
  voir §8.8 de [permissions-onglets-contexte.md](permissions-onglets-contexte.md).
  ⚠️ **En prod** : les admins portant `gestion_joueurs` gardent l'onglet mais perdent les six
  gestes jusqu'à ce qu'on les leur accorde un par un dans le panneau.

- **503 récurrents sur les pages admin, puis en public** — ✅ 2026-09-18, en trois vagues.
  Document de référence : [audit-503-zone-admin.md](audit-503-zone-admin.md) §10 à §12 (le §1-§9
  est le diagnostic d'origine, partiellement erroné, conservé pour la méthode).

  **Cinq causes indépendantes**, aucune n'expliquant le symptôme à elle seule :

  | # | Cause | Correctif |
  |---|---|---|
  | 1 | Amplification 9 → 4 appels backend par page (sonde rejouée sur chaque appel JSON, vues admin redoublant le `check-token`, `inject_saisons` mort) | `_est_navigation`, `_acces_admin_revoque`, suppression d'`inject_saisons` |
  | 2 | 2 workers gunicorn **sync** bloqués sur le réseau | `-k gthread` (8 threads front, 4 back) |
  | 3 | Budget nginx calibré pour 4 requêtes/page, la plus lourde en vaut 6 | `rate=2r/s→8r/s`, `burst=20→40` |
  | 4 | **Avatars** (`/avatar/joueur/N`, sans extension) comptés dans la zone `general`, 1 par ligne de tableau | `location /avatar/` dédié, sans limiteur |
  | 5 | **La config corrigée n'était jamais entrée en service** : `nginx.conf` monté comme *fichier*, inode figé au démarrage — le conteneur appliquait encore `rate=30r/m` | `--force-recreate nginx`, et `make reload-nginx` compare désormais les empreintes |

  La cause 4 touchait **tous les visiteurs, connectés ou non** — c'est le signalement « ça le fait
  aussi sans compte admin » qui l'a révélée, après deux tours d'analyse centrés sur l'admin.

  **Corollaires obligatoires de la cause 2**, sans lesquels threader était dangereux :
  `SimpleConnectionPool` → `ThreadedConnectionPool` (`backEnd/db.py`) et verrou sur le cache
  mémoire (`backEnd/cache.py`, `del`/`popitem` levaient `KeyError` en concurrence). `_avatars`
  dans `routes_comptes.py` a été vérifié et laissé sans verrou — opérations atomiques uniquement,
  commentaire à l'appui.

  **Effet de bord corrigé** : la page 503 ajoutée en vague 1 est du HTML, et les trois helpers JS
  faisaient un `res.json()` dessus — « Erreur serveur (Réponse invalide) », ou exception non
  rattrapée pour `admin_saisons`. Les trois lisent maintenant `Retry-After` et **rendent la main
  avant tout code de déconnexion** : un débit limité ne dit rien sur la validité d'une session.
  ⚠️ Corrigé une seconde fois le 18/09 : `admin_comptes.html` composait bien le message mais ses
  quatre appelants l'écrasaient par « Chargement impossible. » (§12.4).

  ⚠️ **Redéploiement** : les `CMD` des deux Dockerfiles ont changé — `make re-front` **et**
  `make re-back` (un `restart` ne suffit pas), plus `make reload-nginx`.

  Tests : `test_rafraichissement_droits.py` 23 → **39 assertions**, `test_session_expiree.py` 19 →
  **34**. Le point important n'est pas le nombre : c'est que le premier **balaie tout
  `frontEnd/`** et refuse tout `fetch()` de chargement sans en-tête `Accept`. Deux correctifs
  successifs avaient été incomplets faute de ce balayage (`admin_comptes.html` a son propre helper
  `api()`, oublié la première fois) — un défaut silencieux se rattrape par un test qui balaie, pas
  par la relecture.

**Rappel** : rien n'est commité automatiquement — l'utilisateur fait ses commits lui-même.
