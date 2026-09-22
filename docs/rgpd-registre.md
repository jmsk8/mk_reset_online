# Registre des traitements

> Article 30 du RGPD. Un site personnel de moins de 250 personnes n'y est
> strictement tenu que pour les traitements non occasionnels — ce qui est le cas
> ici. Ce registre existe surtout pour une raison pratique : **pouvoir répondre
> sans réfléchir** le jour où quelqu'un demande ce qui est conservé sur lui.
>
> Version 1.0 — 2 septembre 2026 · Politique publiée : `/confidentialite`

## Responsable du traitement

À renseigner dans le `.env` (`SITE_EDITEUR`, `SITE_CONTACT`) — les pages légales
s'en servent, et **affichent « à renseigner » tant que ce n'est pas fait**.
`scripts/check_env.sh` pose les quatre clés `SITE_*` vides à la création du
fichier ; elles ont le droit de le rester, la stack démarre sans elles.
Ce sont des informations personnelles : elles n'ont pas à être figées dans un
dépôt public.

## T1 — Classement sportif

| | |
|---|---|
| **Finalité** | Tenir le classement TrueSkill de la communauté |
| **Base légale** | Intérêt légitime (art. 6.1.f) — une communauté a un intérêt manifeste à disposer d'un classement exact |
| **Personnes** | Joueurs participant aux tournois |
| **Données** | Pseudo de jeu, résultats, positions, µ/σ, tier, ligue, trophées |
| **Source** | Saisie par un administrateur |
| **Destinataires** | Public (c'est l'objet du site) |
| **Transfert hors UE** | Non |
| **Conservation** | Sans limite — voir la justification ci-dessous |
| **Tables** | `joueurs`, `participations`, `tournois`, `awards_obtenus`, `ghost_log`, `league_movements`, `grille_snapshots` |

**Justification de la conservation sans limite.** Le moteur TrueSkill est
*incrémental* : chaque tournoi part du µ/σ courant de chaque participant et
l'écrase. Il n'existe aucune fonction de recalcul depuis zéro. Retirer les
participations d'une personne rendrait le classement de **tous les autres**
définitivement faux, sans possibilité de reconstruction. C'est l'argument
technique qui fonde toute la stratégie d'effacement, et il doit être opposable :
il est écrit tel quel dans la politique publiée.

**Mesure d'atténuation** : l'anonymisation du pseudo (T4) permet de retirer
l'identité sans toucher aux calculs.

## T2 — Comptes joueurs (connexion Discord)

| | |
|---|---|
| **Finalité** | Permettre à un joueur d'être rattaché à sa fiche et de tenir un profil |
| **Base légale** | **Consentement** (art. 6.1.a), recueilli par case à cocher avant redirection vers Discord |
| **Personnes** | Joueurs qui connectent un compte Discord |
| **Données** | Identifiant Discord (*snowflake*), pseudo, pseudo d'affichage, référence d'avatar, bio, couleur, identifiants de réseaux, user-agent |
| **Non collecté** | **Adresse e-mail** (portée OAuth non demandée), **liste des serveurs Discord**, **adresse IP applicative** |
| **Source** | Discord (`GET /users/@me`) et la personne elle-même |
| **Destinataires** | Discord Inc. (États-Unis) · l'hébergeur · le public pour la partie profil |
| **Sous-traitance d'image** | Aucune : l'avatar est relayé par le backend, le navigateur du visiteur ne contacte jamais le CDN Discord |
| **Transfert hors UE** | **Oui** — Discord Inc., encadré par ses clauses contractuelles types |
| **Conservation** | Tant que le compte existe · session 30 j · compte jamais rattaché et inactif 90 j |
| **Tables** | `comptes`, `profils`, `sessions_joueurs`, `liaisons_demandes`, `invitations`, `notifications` |

**Preuve du consentement** : `comptes.cgu_accepted_at` et `comptes.cgu_version`.
Garder la version et pas seulement la date est ce qui permet de démontrer *quoi*
a été accepté. Ces colonnes ne sont **jamais écrasées** à la reconnexion.

**Avatars — relayés, jamais liés en direct.** Les pages servent `/avatar/joueur/<id>`,
et le backend va chercher l'image chez Discord pour la réémettre. Deux fuites sont
ainsi fermées : l'URL publique ne contient plus le *snowflake* Discord, et le
navigateur d'un visiteur ne contacte plus `cdn.discordapp.com` — Discord ne reçoit
donc plus l'adresse IP des personnes qui consultent le classement.

La contrepartie est une **copie en mémoire vive, une heure au maximum, plafonnée
à 512 Ko par image**, jamais écrite sur disque. Elle disparaît au redémarrage du
service. C'est écrit dans la politique publiée.

L'avatar, la bio et les liens de réseaux ne sont plus servis pour une fiche
`anonymise_at IS NOT NULL` : sans cette condition, l'anonymisation ne remplaçait
que le pseudo et laissait en place ce qui identifie le mieux.

## T3 — Journalisation des actions d'administration

| | |
|---|---|
| **Finalité** | Démontrer le traitement (art. 5.2) et rejouer les suppressions après une restauration de sauvegarde |
| **Base légale** | Obligation légale de responsabilité (*accountability*) |
| **Données** | Action, acteur, cible, avant/après pour les gestes réversibles |
| **Conservation** | Sans limite — le volume est négligeable et la valeur probante disparaît avec la purge |
| **Table** | `audit_admin` |

**Pas d'identifiant Discord en clair** — il n'y figure que sous forme de hash.
En revanche, `details` peut contenir un **pseudo de jeu** : nom d'une fiche créée
ou supprimée, motif d'un refus saisi par un administrateur. La politique publiée
le dit.

La suppression d'un compte y écrit une **empreinte** du snowflake, jamais le snowflake : c'est ce
qui permet, après une restauration, de repérer un compte ressuscité et de le
resupprimer, sans reconserver l'identifiant qu'on vient d'effacer.

## T4 — Anonymisation d'un pseudo de jeu

| | |
|---|---|
| **Finalité** | Retirer l'identité d'une personne du classement sans le fausser |
| **Base légale** | Droit d'opposition et à l'effacement, mis en œuvre par une mesure proportionnée |
| **Déclenchement** | Sur demande, par un administrateur |
| **Effet** | `joueurs.nom` remplacé par un identifiant neutre, `anonymise_at` posé, empreinte de l'ancien nom placée dans `noms_interdits` |

L'empreinte est un SHA-256 du nom en minuscules, **jamais le nom** : elle sert
uniquement à empêcher qu'une saisie ultérieure dans le formulaire de tournoi ne
recrée à la volée l'identité qu'on vient d'effacer.

## T5 — Journaux techniques du serveur web

| | |
|---|---|
| **Finalité** | Sécurité et diagnostic de panne |
| **Base légale** | Intérêt légitime |
| **Données** | Adresse IP, URL demandée, date, user-agent |
| **Conservation** | **6 mois** — arbitré le 2026-09-18. ⚠️ Annoncé, pas encore imposé par un mécanisme : voir la réserve ci-dessous. |
| **Où** | Sortie standard des conteneurs, collectée par `journald` (étiquettes `mk-<service>`) |

⚠️ **Le chemin d'une invitation contient son jeton, et nginx journalise le
chemin complet.** C'est la raison pour laquelle les jetons sont hachés en base,
à durée courte et à usage unique : un jeton qui apparaît dans un journal devient
inexploitable une fois consommé.

### Comment la rotation est assurée — révisé le 2026-09-18

**Il n'y a aucun fichier de journal à faire tourner.** Dans l'image officielle,
nginx écrit ses deux flux sur des liens symboliques vers `stdout`/`stderr` ;
aucune directive `access_log` vers un fichier n'existe dans `nginx/`, et aucun
volume de journaux n'est monté. `logrotate` n'aurait rien à traiter — c'est le
pilote de journalisation de Docker qui collecte tout.

**Pilote : `journald`** (ancre `x-journaux` de `docker-compose.yml`, appliquée
aux cinq services `db`, `backend`, `frontend`, `race`, `nginx`, chacun étiqueté
`mk-<nom>`).

⚠️ **Pourquoi pas `json-file`, le pilote par défaut** : il ne sait borner que la
**taille** (10 Mo × 3 fichiers). Une borne de taille **n'est pas une durée** —
sur un site peu fréquenté une ligne survit bien au-delà de 6 mois, sur un site
chargé elle disparaît avant. On annonçait donc aux visiteurs une durée que rien
ne tenait, ce qui est **pire que ne rien annoncer**. `journald` expire par
**âge** : c'est ce qui rend l'annonce exacte.

**Le réglage qui impose réellement la durée est sur l'hôte**, pas dans le dépôt :
`deploy/host/journald-mk.conf`, à copier dans `/etc/systemd/journald.conf.d/`.

| Réglage | Valeur | Effet |
|---|---|---|
| `Storage` | `persistent` | ⚠️ Sans lui, les journaux vivent dans `/run` et sont **perdus à chaque redémarrage**. C'était le cas ici — `/var/log/journal` n'existait pas. |
| `MaxRetentionSec` | `6month` | La durée annoncée, enfin appliquée |
| `SystemMaxUse` | `500M` | Garde-fou disque, indépendant de l'âge. Les deux bornes se cumulent, la première atteinte gagne. |

**Tant que ce fichier n'est pas déployé sur l'hôte, T5 n'est pas clos** : la
bascule vers `journald` sans `Storage=persistent` raccourcirait la conservation
au lieu de l'allonger.

- `[ ]` ⚠️ **Déployer `deploy/host/journald-mk.conf` sur l'hôte** puis
  `sudo systemctl restart systemd-journald && docker compose up -d`.
  Vérifier : `ls -d /var/log/journal` (doit exister) et
  `journalctl -t mk-nginx -n 5` (doit sortir des lignes).

- `[x]` **Durée arbitrée : 6 mois** (2026-09-18), borne basse de la fourchette CNIL.
- `[x]` **Annoncée dans `/confidentialite`** (2026-09-18) : « 6 mois au maximum », via
  `SITE_RETENTION_LOGS` (`.env`, `docker-compose.yml`, défaut dans `frontend.py`). ⚠️ **Un
  déploiement en ligne doit porter la même valeur dans son propre `.env`** — sinon la prod
  affichera le défaut, et les deux environnements annonceront des choses différentes.
- `[ ]` ⚠️ **L'imposer réellement.** C'est le point à ne pas laisser dormir : la borne Docker
  plafonne la **taille**, pas l'âge. Une ligne peut donc survivre bien au-delà de 6 mois sur un
  site peu fréquenté — c'est-à-dire **annoncer une durée qu'on ne tient pas**, ce qui est pire
  que ne rien annoncer. Deux façons de la tenir :
  - un `logrotate` sur l'hôte visant `/var/lib/docker/containers/*/*-json.log` avec
    `daily` + `rotate 180` — simple, mais touche à l'arborescence de Docker ;
  - ou un collecteur qui expire par âge (journald avec `MaxRetentionSec=6month`, via
    `driver: journald` dans `x-journaux`) — plus propre, change le pilote de journalisation.

## T6 — Journal des actions d'administration (côté administrateur)

| | |
|---|---|
| **Finalité** | Traçabilité des actions d'administration du site |
| **Base légale** | Intérêt légitime |
| **Données** | Identifiant du compte administrateur, action, cible, date, détails |
| **Conservation** | **Sans limite de durée**, et **au-delà de la suppression du compte** (l'identifiant est alors détaché, `ON DELETE SET NULL`) |
| **Où** | Table `audit_admin` |

⚠️ **Distinct de la mention du §4**, qui décrit le journal du point de vue du **joueur** dont le
pseudo peut y figurer. Celui-ci le décrit du point de vue de l'**administrateur** dont les actions
sont tracées — deux traitements différents, et le second n'était documenté nulle part avant le
2026-09-18.

**Consentement recueilli** : le rôle d'administrateur ne s'impose plus, il se **propose**
(`promotions_proposees`). La personne l'accepte ou le refuse, et l'acceptation enregistre
`cgu_admin_accepted_at` + `cgu_admin_version` — la version et pas seulement la date, pour pouvoir
démontrer **quoi** a été accepté.

Le consentement aux CGU donné à la création du compte ne pouvait pas couvrir ce traitement : il a
été donné quand la personne était `player`, pour un traitement qui n'existait pas encore.

- `[x]` Section « Si vous êtes administrateur » dans `/confidentialite` (2026-09-18).
- `[ ]` ⚠️ **Les administrateurs déjà en poste** n'ont pas de consentement enregistré : la
  migration ne rétrograde personne. L'écran le leur demande à leur prochaine connexion, sans
  bloquer leur accès. À vérifier une fois en ligne que chacun l'a bien donné.

## Droits et leur mise en œuvre

| Droit | Où | Effet |
|---|---|---|
| Information | `/confidentialite`, `/mentions-legales` | — |
| Accès et portabilité | `/mon-compte` → « Télécharger mes données » | JSON complet, **dossier sportif inclus** |
| Rectification | sur demande à l'adresse de contact | bio, couleur, réseaux — l'écran de réglages a été retiré |
| Effacement | `/mon-compte` → « Supprimer mon compte » | immédiat, sans validation d'un tiers |
| Opposition / retrait | = suppression du compte | le consentement est retiré avec |
| Anonymisation | sur demande à l'adresse de contact | T4 |

## Ce qui reste à faire

- [x] Renseigner `SITE_EDITEUR`, `SITE_CONTACT`, `SITE_HEBERGEUR` dans le `.env`
      — fait ; `docker-compose.yml` les transmet au conteneur `frontend`, sans quoi
      elles n'atteignaient aucun processus. **Un déploiement neuf doit les remplir :
      vides, les pages légales sont incomplètes au sens de la loi.**
- [x] **Durée de conservation des journaux arbitrée et annoncée (T5)** — 6 mois,
      décidé le 2026-09-18, affiché dans `/confidentialite`. Le pilote est passé à
      `journald`, qui expire par âge.
- [ ] ⚠️ **Déployer `deploy/host/journald-mk.conf` sur l'hôte** — c'est ce fichier,
      et lui seul, qui impose réellement les 6 mois annoncés. Sans lui (et surtout
      sans son `Storage=persistent`), les journaux vivent dans `/run` et sont perdus
      à chaque redémarrage. **Voir T5 avant de cocher.**
- [ ] Faire tourner la purge (`/admin/purge-rgpd`) régulièrement — il n'y a pas
      d'ordonnanceur dans le projet, c'est un geste manuel assumé.
- [ ] **Suppression de compte sur demande par mail** (décidé le 2026-09-22) : le bouton
      « Supprimer mon compte » renverra vers `SITE_CONTACT` au lieu d'effacer directement ;
      la demande sera exécutée par une route réservée au `superadmin`, à créer.
      Le droit à l'effacement reste dû : réponse sous **un mois** (art. 12.3), à écrire
      dans `/confidentialite`, et la section « Droits et leur mise en œuvre » ci-dessus
      à mettre à jour. Détail : §13.1 de
      [etat-avancement-global.md](etat-avancement-global.md).
- [ ] Après toute restauration de sauvegarde : rejouer les suppressions, cf.
      [runbook-admin.md](runbook-admin.md) §5.
