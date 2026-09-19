-- La promotion au rang d'admin devient une PROPOSITION a accepter.
--
-- Pourquoi : a partir de la phase 2 du journal d'audit, les actions d'un admin
-- sont tracees NOMINATIVEMENT, conservees sans limite de duree, et survivent a
-- la suppression de son compte (ON DELETE SET NULL sur acteur_compte_id).
-- Le RGPD impose d'informer la personne AVANT ce traitement -- pas le jour ou
-- elle decouvre que son pseudo figure encore dans un journal deux ans apres
-- son depart.
--
-- Le consentement aux CGU donne a la creation du compte ne peut pas couvrir
-- ca : il a ete donne quand la personne etait `player`, pour un traitement qui
-- n'existait pas encore. Un consentement ne vaut pas pour ce qu'on ne pouvait
-- pas connaitre en le donnant. D'ou un consentement DISTINCT et versionne.
--
-- Consequence de conception : le role n'est plus pose par `changer_role` pour
-- une promotion. Il est pose a l'ACCEPTATION, par la personne elle-meme --
-- un tiers ne peut pas consentir a sa place.
--
-- Le patron est celui de `liaisons_demandes`, deja eprouve dans ce projet :
-- un etat en attente, une decision, une notification, un index unique partiel.

-- ---------------------------------------------------------------------------
-- 1. Le consentement, sur le modele exact de cgu_accepted_at / cgu_version
-- ---------------------------------------------------------------------------
-- Versionne et pas seulement date : garder la version acceptee est ce qui
-- permet de demontrer QUOI a ete accepte. Meme argument que pour les CGU
-- joueur, on ne reinvente rien.
ALTER TABLE public.comptes
    ADD COLUMN IF NOT EXISTS cgu_admin_accepted_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS cgu_admin_version     character varying(20);

COMMENT ON COLUMN public.comptes.cgu_admin_accepted_at IS
    'Acceptation de la politique « en tant qu''administrateur ». NULL pour un '
    'player, et pour les admins anterieurs a cette migration.';

-- ---------------------------------------------------------------------------
-- 2. Les propositions en attente
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.promotions_proposees (
    id           SERIAL PRIMARY KEY,
    -- CASCADE : une proposition n'a aucun sens sans le compte qu'elle vise.
    compte_id    integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    role_propose character varying(20) NOT NULL,
    -- SET NULL et non CASCADE : si le proposant supprime son compte, la
    -- proposition reste valide -- elle a ete faite par quelqu'un qui en avait
    -- le droit A CE MOMENT-LA. La notification de refus partira alors dans le
    -- vide, ce que `notifier()` gere deja (compte_id NULL -> no-op).
    propose_par  integer REFERENCES public.comptes(id) ON DELETE SET NULL,
    statut       character varying(20) NOT NULL DEFAULT 'pending',
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    -- Une proposition ouverte il y a huit mois et jamais lue n'engage plus
    -- personne. 30 jours, comme les invitations.
    expires_at   timestamp with time zone NOT NULL,
    decided_at   timestamp with time zone,

    -- On ne propose QUE ces deux roles. `superadmin` ne se propose pas : il se
    -- legue (transfert atomique, voir leguer_superadmin), et `player` n'est pas
    -- une promotion mais une retrogradation -- qui, elle, reste unilaterale et
    -- n'a pas a etre acceptee.
    CONSTRAINT promotions_role_valide
        CHECK (role_propose IN ('admin', 'chef_admin')),
    CONSTRAINT promotions_statut_valide
        CHECK (statut IN ('pending', 'accepted', 'refused', 'cancelled'))
);

ALTER TABLE public.promotions_proposees OWNER TO CURRENT_USER;

-- UNE SEULE proposition en attente par compte. Sans cet index, deux chef_admin
-- peuvent proposer deux roles differents au meme compte, et l'acceptation
-- devient ambigue -- laquelle des deux pose le role ?
-- Partiel sur 'pending' : l'historique des decisions passees, lui, s'accumule
-- librement.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promotion_pending_compte
    ON public.promotions_proposees(compte_id) WHERE statut = 'pending';

-- L'ecran d'acceptation interroge « ai-je une proposition en attente ? » a
-- chaque connexion : c'est la requete la plus frequente de cette table.
CREATE INDEX IF NOT EXISTS idx_promotion_compte_statut
    ON public.promotions_proposees(compte_id, statut);

-- ---------------------------------------------------------------------------
-- 3. Ce que cette migration NE fait PAS, volontairement
-- ---------------------------------------------------------------------------
-- Les admins DEJA en poste gardent leur role et n'ont pas de consentement
-- enregistre (cgu_admin_accepted_at reste NULL). Ils ne sont pas retrogrades :
-- ce serait casser une installation qui tourne pour un motif de forme.
--
-- Consequence assumee et VISIBLE : `GET /me/promotion` leur repondra qu'un
-- consentement est attendu a leur prochaine connexion, et l'ecran le leur
-- demandera -- sans bloquer leur acces entre-temps. C'est la regularisation,
-- pas une punition. Le journal de la phase 2 ne commencera a tracer leurs
-- actions qu'une fois ce consentement donne.
