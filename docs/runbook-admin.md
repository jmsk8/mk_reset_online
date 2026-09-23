# Runbook — administration et accès de secours

> Procédures d'exploitation liées à l'authentification. **Le mot de passe
> administrateur a été supprimé le 2026-09-23** (étape 6 de la phase 4) : ce
> document n'est plus une préparation, c'est le mode d'emploi du seul accès de
> secours qui reste.
>
> Conception : [auth-discord-plan.md](auth-discord-plan.md) · Avancement :
> [auth-discord-avancement.md](auth-discord-avancement.md)

## 1. Pourquoi ce document existe

Le mot de passe administrateur supprimé, **le seul chemin d'administration passe par
Discord**. Cinq événements, tous hors de notre contrôle, coupent cet accès :

- Discord est en panne, ou son OAuth l'est ;
- l'application OAuth est suspendue, ou `DISCORD_CLIENT_SECRET` est révoqué ;
- le compte Discord du super-administrateur est banni, piraté ou supprimé ;
- `SECRET_KEY` tourne et invalide toutes les sessions ;
- **le plus probable** : un `UPDATE` de trop retire le rôle au dernier super-administrateur.

Le code refuse ce dernier cas (`POST /admin/comptes/<id>/role` renvoie 409 sur le dernier
`superadmin`), mais rien ne protège d'un `UPDATE` passé à la main en base.

## 2. Ce qui remplace le mot de passe — état des garde-fous

Trois prérequis avaient été posés avant la coupure (R-38). Voici où ils en sont,
**arrêté au 2026-09-23**.

- [x] **Période de recouvrement** — vécue dans les faits. Depuis le 2026-09-13, plus aucune
      route métier n'acceptait le mot de passe : le site était administré uniquement par
      Discord depuis dix jours au moment de la coupure.
- [ ] ⚠️ **La procédure §3.1 exécutée au moins une fois pour de vrai.** Toujours pas faite, et
      c'est désormais **le seul garde-fou qui manque vraiment**. Une procédure jamais lancée
      n'est pas une procédure : c'est une intention. Ce qu'un essai à blanc révèle — citation
      SQL, `POSTGRES_USER` absent du shell de l'hôte, `make db-shell` indisponible — se découvre
      sinon un soir de panne.
- [~] **Deux comptes `superadmin` distincts** — **volontairement abandonné**, décision du
      2026-09-23.

### Pourquoi le second `superadmin` a été écarté, et ce que ça coûte

Le raisonnement retenu : **avoir la base, c'est déjà avoir la porte de secours.** Le
break-glass du §3.1 *est* une commande SQL ; le second compte n'en est qu'un raccourci
par l'interface. Scénario par scénario, sur les cinq du §1 :

| Scénario | Un 2e `superadmin` aurait aidé ? |
|---|---|
| Discord ou son OAuth en panne | **Non** — il est sur Discord lui aussi |
| Application OAuth suspendue, `DISCORD_CLIENT_SECRET` révoqué | **Non** |
| `SECRET_KEY` tournée | **Non**, sans objet |
| Un `UPDATE` de trop retire le dernier rôle | Non — c'est exactement ce que §3.1 répare |
| **Compte Discord du superadmin banni, piraté ou supprimé** | **Oui** — seul cas, et l'accès base le couvre |

Le risque résiduel est donc **un seul scénario**, et il se paie en minutes de SQL plutôt
qu'en clics. Ce qui le rendrait coûteux, en revanche :

1. ⚠️ **Le compte de secours doit déjà exister dans `comptes`**, donc s'être connecté au moins
   une fois. L'amorçage par `DISCORD_SUPERADMIN_ID` se referme **définitivement** dès qu'un
   `superadmin` existe (troisième condition de `peut_amorcer_sans_invitation`) : si le compte
   Discord du superadmin disparaît, cette variable ne fera entrer personne. On passerait alors
   d'un `UPDATE` (§3.1) à un `INSERT` à la main dans `comptes`, puis dans `invitations`.
   **Faire ouvrir une session à un second compte Discord, même en simple `player`, suffit à
   éviter ça** — et ne donne aucun privilège.
2. **L'accès à l'hôte doit rester joignable depuis ailleurs que le poste de dev.** Sans shell
   sur la machine, il n'y a plus aucune porte : ni mot de passe, ni SQL.

## 3. Accès de secours (*break-glass*)

À utiliser quand plus personne ne peut administrer le site.

### 3.1 Promouvoir un compte existant

Le compte doit s'être déjà connecté une fois — c'est ce qui crée sa ligne dans `comptes`.

```sh
# 1. Retrouver le compte : le discord_id se lit dans Discord en activant le
#    mode développeur, puis « Copier l'identifiant » sur le profil.
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
   "SELECT id, discord_id, discord_username, role, statut FROM comptes ORDER BY id;"' 

# 2. Promouvoir.
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
   "UPDATE comptes SET role='"'"'superadmin'"'"', updated_at=now() WHERE discord_id='"'"'<SNOWFLAKE>'"'"';"' 

# 3. Tracer le geste : l'audit ne doit pas avoir de trou.
# Plus simple par un shell interactif, la citation SQL devenant vite pénible :
make db-shell
#   INSERT INTO audit_admin (action, cible_type, details)
#   VALUES ('role_attribue', 'compte', '{"origine": "break-glass"}'::jsonb);
```

Le rôle est relu en base à **chaque** requête protégée : la promotion prend effet immédiatement,
sans redémarrage ni reconnexion.

### 3.2 Si aucun compte ne peut se connecter

Quand Discord lui-même est indisponible, promouvoir ne sert à rien : personne ne peut ouvrir de
session. Deux issues, dans cet ordre.

**a. Attendre.** Une panne Discord dure rarement plus de quelques heures, et le site reste
consultable — seule l'administration est bloquée. C'est presque toujours la bonne réponse.

**b. Réactiver temporairement le mot de passe.** Uniquement si une opération ne peut pas attendre
(enregistrer un tournoi le soir même, par exemple). Cela suppose d'avoir **conservé le commit qui
supprime l'authentification par mot de passe** dans l'historique, afin de pouvoir le révoquer.

⚠️ **Le `revert` seul ne suffit pas, et c'est le piège de cette procédure.** Il rend le code,
pas la table : la coupure du 2026-09-23 emportait aussi un `DROP TABLE api_tokens`. Un backend
reverté sans sa table répondrait **500** à la première tentative de connexion, ce qui, un soir
de panne Discord, ressemblerait à s'y méprendre à une panne de plus.

**L'ordre compte** — la table d'abord, le code ensuite :

```sh
# 1. Rendre la table AVANT tout. Migration inverse, ecrite pour ce seul usage.
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < backEnd/migrations/2026-09-23_restore_api_tokens.sql

# 2. Rendre le code. Ne PAS forcer : on garde la trace des deux mouvements.
git revert <commit de suppression du mot de passe>

# 3. Le revert rend aussi check_env.sh, qui redemande alors ADMIN_PASSWORD_HASH.
bash scripts/check_env.sh
make build && make up
```

**Et le chemin du retour**, une fois Discord revenu : rejouer
`2026-09-23_drop_api_tokens.sql` après avoir annulé le `revert`. Ne pas laisser la table
derrière soi — c'est elle, et son stockage en clair, qui a motivé la coupure (A-05).

> C'est la raison pour laquelle l'étape 6 est **un seul commit, isolé et clairement nommé**.
> Un `revert` propre est le vrai filet de sécurité ; le reste n'est que de la procédure.

### 3.3 Compte Discord compromis

```sh
# Fermer toutes ses sessions immédiatement.
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
   "DELETE FROM sessions_joueurs WHERE compte_id = <ID>;"' 

# Puis le suspendre, ou lui retirer son rôle, depuis /admin/comptes.
```

L'interface fait les deux (`Fermer les sessions`, `Suspendre`) ; la commande n'est là que si
l'interface est justement inaccessible.

## 4. Rotation de `SECRET_KEY`

Changer `SECRET_KEY` invalide **tous les cookies de session et tous les jetons CSRF en vol** :
tout le monde est déconnecté, et un formulaire ouvert au mauvais moment sera rejeté.

Sans conséquence du temps où seul l'admin avait une session de 30 minutes. Avec des sessions
joueur de 30 jours, c'est une déconnexion générale. À faire hors des heures de tournoi, et à
annoncer.

⚠️ `scripts/check_env.sh` ne régénère `SECRET_KEY` que si elle est **absente** du `.env`.
Ne jamais supprimer cette ligne « pour voir ».

## 5. Après une restauration de sauvegarde

Une restauration **ressuscite les comptes supprimés**. Si quelqu'un a exercé son droit à
l'effacement le 10 et qu'on restaure le dump du 3 le 15, ses données sont de retour, et personne
ne le saura.

Après toute restauration :

```sh
# Lister les suppressions postérieures à la date du dump, et les rejouer.
make db-shell
#   SELECT created_at, action, cible_id, details FROM audit_admin
#   WHERE action IN ('compte_supprime', 'joueur_anonymise')
#     AND created_at > '<date du dump>' ORDER BY created_at;
```

C'est précisément à cela que sert `audit_admin`. Sans ce rejeu, la table n'est qu'un journal
décoratif.

⚠️ **`docker-compose.dump.yml` neutralise `01_schema.sql`** : sur le chemin `make redump`, la
structure vient entièrement du dump. Les migrations d'authentification sont montées en `04_` et
`05_` pour rattraper un dump antérieur à leur création. En ajouter une nouvelle sans la monter là
donnerait une base restaurée sans cette table.

> **Convention de ce runbook** : `POSTGRES_USER` et `POSTGRES_DB` ne sont définis que **dans le
> conteneur**, jamais dans le shell de l'hôte. D'où le `sh -c '…'` systématique. Pour tout ce qui
> est interactif, `make db-shell` est plus simple et c'est ce que fait déjà le projet.

## 6. Appliquer une migration en production

Il n'existe aucun framework de migration : `schema.sql` n'est joué qu'au tout premier démarrage
d'un volume vierge, et la base de production n'a jamais vu sa version actuelle.

```sh
# 1. Dump de contrôle AVANT.
bash scripts/db-dump.sh avant_migration

# 2. Appliquer, dans l'ordre chronologique des noms de fichiers.
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < backEnd/migrations/AAAA-MM-JJ_nom.sql

# 3. Vérifier que la table est bien là.
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\dt public.*"' 

# 4. Dump de contrôle APRÈS.
bash scripts/db-dump.sh apres_migration
```

`-v ON_ERROR_STOP=1` n'est pas décoratif : sans lui, `psql` continue après une erreur et laisse
une migration à moitié appliquée.

Toute migration doit ensuite être reportée dans **`schema.sql`**, sans quoi une réinstallation
propre repartira d'un schéma incomplet.

## 7. Traiter une demande de suppression de compte

Depuis le 2026-09-22, un joueur ne supprime plus son compte lui-même : le bouton de
`/mon-compte` lui indique d'écrire à `SITE_CONTACT`, et **le superadmin exécute la demande**
depuis `/admin/comptes` → onglet Comptes → « Supprimer le compte ». C'est une capacité de rôle :
ni un `chef_admin` ni un `admin` ne peuvent le faire, quelles que soient leurs permissions.

⚠️ **Le point dangereux n'est plus le bouton, c'est le mail.** N'importe qui peut écrire
« supprimez le compte de X ». Rien dans l'application ne vérifie que la demande vient du
titulaire : **c'est l'étape 1 qui le fait**, et elle ne se saute pas.

1. **Vérifier que la demande vient bien du titulaire.** Le site ne connaît aucune adresse
   e-mail — il n'en récupère pas auprès de Discord —, donc l'adresse d'expédition ne prouve
   rien. Demander une confirmation **depuis le compte Discord concerné** : par exemple, répondre
   au mail avec un code, et attendre ce code en message privé venant de ce compte. Sans cette
   confirmation, ne rien supprimer.
2. **Relever le pseudo Discord technique** (le *handle*, pas le nom affiché) : c'est lui qu'il
   faudra retaper. La liste des comptes n'affiche que le nom ; le handle se lit sur le profil
   Discord de qui a envoyé la confirmation.
3. **Proposer l'export avant** : « Télécharger mes données » n'est accessible qu'au titulaire,
   et seulement tant que le compte existe.
4. **Supprimer** : bouton « Supprimer le compte » sur sa ligne, confirmer, retaper le handle.
   Un handle qui ne correspond pas est refusé (400), sans rien effacer.
5. **Répondre** dans le délai d'**un mois** (RGPD, art. 12.3) : dire que c'est fait, et
   rappeler ce qui reste — le pseudo de jeu et l'historique de tournois — ainsi que la
   possibilité de demander l'anonymisation du pseudo.

Rien d'autre à faire : la ligne d'audit `compte_supprime` (origine `demande_ecrite`, acteur =
le superadmin) est ce qui permet de rejouer la suppression après une restauration (§5).

**Cas particuliers**

- **Un compte `admin` ou `chef_admin`** se supprime de la même façon. Ses permissions partent
  avec lui ; ses lignes du journal d'administration **restent**, avec son identité figée
  (politique de confidentialité, section administrateurs).
- **Le compte du superadmin lui-même** : refusé (403). Le rôle est unique, le supprimer
  laisserait le site sans administration. Léguer d'abord le rôle, puis adresser la demande au
  nouveau superadmin.
- **Anonymiser aussi le pseudo de jeu** est un geste distinct, sur la fiche joueur (droit
  `joueurs_irreversible`) : la suppression du compte ne touche pas au dossier sportif.
- **Le superadmin est seul à pouvoir supprimer.** S'il est indisponible, les demandes
  attendent — et le délai d'un mois court quand même.
