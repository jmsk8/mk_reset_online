-- La promotion au rang d'admin devient une proposition, acceptee par la
-- personne avec un consentement a la politique admin (distinct et versionne).

-- ---------------------------------------------------------------------------
-- 1. Consentement a la politique admin
-- ---------------------------------------------------------------------------
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
    compte_id    integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    role_propose character varying(20) NOT NULL,
    -- SET NULL : la proposition reste valable si le proposant supprime son compte.
    propose_par  integer REFERENCES public.comptes(id) ON DELETE SET NULL,
    statut       character varying(20) NOT NULL DEFAULT 'pending',
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    -- Validite de 30 jours.
    expires_at   timestamp with time zone NOT NULL,
    decided_at   timestamp with time zone,

    -- superadmin se legue ; player est une retrogradation.
    CONSTRAINT promotions_role_valide
        CHECK (role_propose IN ('admin', 'chef_admin')),
    CONSTRAINT promotions_statut_valide
        CHECK (statut IN ('pending', 'accepted', 'refused', 'cancelled'))
);

ALTER TABLE public.promotions_proposees OWNER TO CURRENT_USER;

-- Une seule proposition en attente par compte.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promotion_pending_compte
    ON public.promotions_proposees(compte_id) WHERE statut = 'pending';

-- Recherche d'une proposition en attente.
CREATE INDEX IF NOT EXISTS idx_promotion_compte_statut
    ON public.promotions_proposees(compte_id, statut);

-- Les admins deja en poste gardent leur role ; leur consentement leur sera
-- demande a la prochaine connexion.
