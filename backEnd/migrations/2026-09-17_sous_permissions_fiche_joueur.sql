-- Fiche joueur : un droit par geste, au lieu d'un `gestion_joueurs` fourre-tout.
--
-- `gestion_joueurs` ne donne plus que la LECTURE (ouvrir l'onglet, voir la
-- liste). Chacun des six gestes passe sous sa propre sous-permission, toutes
-- filles de `gestion_joueurs` -- meme mecanisme que `rgpd_joueurs` depuis le
-- 2026-09-13, voir SOUS_PERMISSIONS dans constants.py.
--
-- Renommage inclus : `rgpd_joueurs` devient `joueurs_irreversible`. Le nom
-- promettait un dispositif RGPD qui n'existe pas -- la suppression n'a rien de
-- legal (elle refuse d'ailleurs tout joueur ayant un match, parce que les FK en
-- CASCADE fausseraient le classement de tout le monde), et seule
-- l'anonymisation releve du droit a l'effacement. Le vrai critere commun aux
-- deux routes est qu'elles sont IRREVERSIBLES, d'ou le nom.

-- Un compte pourrait deja porter les deux lignes (octroi manuel en SQL, ou
-- migration rejouee) : la contrainte UNIQUE(compte_id, permission) ferait
-- echouer l'UPDATE. On efface donc d'abord les doublons eventuels.
DELETE FROM public.permissions_admin a
 WHERE a.permission = 'rgpd_joueurs'
   AND EXISTS (SELECT 1 FROM public.permissions_admin b
                WHERE b.compte_id = a.compte_id
                  AND b.permission = 'joueurs_irreversible');

UPDATE public.permissions_admin
   SET permission = 'joueurs_irreversible'
 WHERE permission = 'rgpd_joueurs';

-- Les cinq autres sous-permissions ne sont PAS accordees retroactivement.
--
-- Un `gestion_joueurs` existant valait « tout faire sur une fiche » ; le
-- convertir en six lignes reproduirait exactement l'etat qu'on vient de casser,
-- et personne ne s'apercevrait que la granularite existe. `permissions_admin`
-- stocke des chaines libres : aucune requete ne peut distinguer un admin a qui
-- on voulait tout donner d'un admin qui n'avait ce droit que pour consulter.
--
-- Consequence assumee et VISIBLE : apres cette migration, les admins qui
-- portent `gestion_joueurs` gardent l'onglet mais perdent les six gestes,
-- jusqu'a ce qu'on leur accorde un par un dans le panneau des permissions.
-- Meme rupture que `gestion_tournois` le 2026-09-13, meme raison.
