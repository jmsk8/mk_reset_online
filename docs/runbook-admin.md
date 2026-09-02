# Runbook — administration et accès de secours

> Procédures d'exploitation liées à l'authentification. **À lire avant de supprimer
> l'authentification par mot de passe** (étape 6 de la phase 4).
>
> Conception : [auth-discord-plan.md](auth-discord-plan.md) · Avancement :
> [auth-discord-avancement.md](auth-discord-avancement.md)

## 1. Pourquoi ce document existe

Une fois le mot de passe administrateur supprimé, **le seul chemin d'administration passe par
Discord**. Cinq événements, tous hors de notre contrôle, coupent alors l'accès :

- Discord est en panne, ou son OAuth l'est ;
- l'application OAuth est suspendue, ou `DISCORD_CLIENT_SECRET` est révoqué ;
- le compte Discord du super-administrateur est banni, piraté ou supprimé ;
- `SECRET_KEY` tourne et invalide toutes les sessions ;
- **le plus probable** : un `UPDATE` de trop retire le rôle au dernier super-administrateur.

Le code refuse ce dernier cas (`POST /admin/comptes/<id>/role` renvoie 409 sur le dernier
`superadmin`), mais rien ne protège d'un `UPDATE` passé à la main en base.

## 2. Prérequis avant de couper le mot de passe

Les trois sont **obligatoires**. Aucun n'est facultatif.

- [ ] **Au moins deux comptes `superadmin`**, sur deux comptes Discord distincts, idéalement
      avec l'authentification à deux facteurs activée côté Discord.
- [ ] **La procédure §3 exécutée au moins une fois pour de vrai.** Une procédure jamais lancée
      n'est pas une procédure : c'est une intention.
- [ ] **Une période de recouvrement passée** : administrer réellement le site via Discord pendant
      plusieurs jours, les deux voies actives, avant de retirer quoi que ce soit.

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
supprime l'authentification par mot de passe** dans l'historique, afin de pouvoir le révoquer :

```sh
git revert <commit de suppression du mot de passe>   # ne PAS forcer, garder la trace
bash scripts/check_env.sh                            # redemande ADMIN_PASSWORD_HASH
make build && make up
```

> C'est la raison pour laquelle l'étape 6 doit être **un seul commit, isolé et clairement nommé**.
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
