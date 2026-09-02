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
| **Transfert hors UE** | **Oui** — Discord Inc., encadré par ses clauses contractuelles types |
| **Conservation** | Tant que le compte existe · session 30 j · compte jamais rattaché et inactif 90 j |
| **Tables** | `comptes`, `profils`, `sessions_joueurs`, `liaisons_demandes`, `invitations` |

**Preuve du consentement** : `comptes.cgu_accepted_at` et `comptes.cgu_version`.
Garder la version et pas seulement la date est ce qui permet de démontrer *quoi*
a été accepté. Ces colonnes ne sont **jamais écrasées** à la reconnexion.

⚠️ **Point de vigilance — l'avatar publie l'identifiant Discord.** L'URL affichée
sur la fiche publique est `cdn.discordapp.com/avatars/<snowflake>/<hash>.png` :
elle contient l'identifiant Discord en clair, sur une page publique. C'est la
contrepartie assumée du choix « aucune copie d'image stockée ». **Mentionné
explicitement dans la politique publiée.** Si cela devait poser problème, la
parade est un interrupteur par joueur dans `profils`.

## T3 — Journalisation des actions d'administration

| | |
|---|---|
| **Finalité** | Démontrer le traitement (art. 5.2) et rejouer les suppressions après une restauration de sauvegarde |
| **Base légale** | Obligation légale de responsabilité (*accountability*) |
| **Données** | Action, acteur, cible, avant/après pour les gestes réversibles |
| **Conservation** | Sans limite — le volume est négligeable et la valeur probante disparaît avec la purge |
| **Table** | `audit_admin` |

**Aucune donnée personnelle n'y est conservée en clair.** La suppression d'un
compte y écrit une **empreinte** du snowflake, jamais le snowflake : c'est ce
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
| **Conservation** | **À fixer et à appliquer** — 6 à 12 mois, recommandation CNIL pour les journaux de sécurité |
| **Où** | Journaux nginx |

⚠️ **Le chemin d'une invitation contient son jeton, et nginx journalise le
chemin complet.** C'est la raison pour laquelle les jetons sont hachés en base,
à durée courte et à usage unique : un jeton qui apparaît dans un journal devient
inexploitable une fois consommé.

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
- [ ] Fixer et appliquer une rotation des journaux nginx (T5).
- [ ] Faire tourner la purge (`/admin/purge-rgpd`) régulièrement — il n'y a pas
      d'ordonnanceur dans le projet, c'est un geste manuel assumé.
- [ ] Après toute restauration de sauvegarde : rejouer les suppressions, cf.
      [runbook-admin.md](runbook-admin.md) §5.
