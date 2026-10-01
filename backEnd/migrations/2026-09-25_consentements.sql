-- Historique des consentements : une ligne par acceptation, jamais reecrite.
-- Les colonnes cgu_* de comptes gardent l'etat courant. L'historique est
-- supprime avec le compte.

CREATE TABLE IF NOT EXISTS public.consentements (
    id          SERIAL PRIMARY KEY,
    -- CASCADE en filet ; _effacer_compte supprime explicitement.
    compte_id   integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    -- 'cgu' : politique de tout compte ; 'cgu_admin' : politique administrateur.
    politique   character varying(20) NOT NULL,
    version     character varying(20) NOT NULL,
    accepte_le  timestamp with time zone NOT NULL DEFAULT now(),
    -- Parcours qui a produit l'acceptation.
    origine     character varying(30) NOT NULL,

    CONSTRAINT consentements_politique_valide
        CHECK (politique IN ('cgu', 'cgu_admin')),
    CONSTRAINT consentements_origine_valide
        CHECK (origine IN (
            'page_consentement', -- POST /me/cgu
            'acceptation_promotion', -- POST /me/promotion
            'regularisation_admin', -- POST /me/cgu-admin
            'reprise_migration' -- reprise des acceptations existantes
        ))
);

ALTER TABLE public.consentements OWNER TO CURRENT_USER;

CREATE INDEX IF NOT EXISTS idx_consentements_compte
    ON public.consentements(compte_id, accepte_le);

-- ---------------------------------------------------------------------------
-- Ajout seul (DELETE permis pour l'effacement du compte)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consentements_sans_modification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'consentements est en ajout seul : une acceptation ne se modifie pas.'
        USING HINT = 'Inserer une nouvelle ligne pour une nouvelle acceptation.';
END;
$$;

DROP TRIGGER IF EXISTS consentements_ajout_seul ON public.consentements;
CREATE TRIGGER consentements_ajout_seul
    BEFORE UPDATE ON public.consentements
    FOR EACH ROW EXECUTE FUNCTION public.consentements_sans_modification();

-- ---------------------------------------------------------------------------
-- Reprise des acceptations existantes
-- ---------------------------------------------------------------------------
-- Une ligne par compte et par politique (derniere acceptation connue). Idempotent.
INSERT INTO public.consentements (compte_id, politique, version, accepte_le, origine)
SELECT c.id, 'cgu', c.cgu_version, c.cgu_accepted_at, 'reprise_migration'
FROM public.comptes c
WHERE c.cgu_accepted_at IS NOT NULL AND c.cgu_version IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.consentements x
      WHERE x.compte_id = c.id AND x.politique = 'cgu'
        AND x.version = c.cgu_version AND x.accepte_le = c.cgu_accepted_at);

INSERT INTO public.consentements (compte_id, politique, version, accepte_le, origine)
SELECT c.id, 'cgu_admin', c.cgu_admin_version, c.cgu_admin_accepted_at, 'reprise_migration'
FROM public.comptes c
WHERE c.cgu_admin_accepted_at IS NOT NULL AND c.cgu_admin_version IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.consentements x
      WHERE x.compte_id = c.id AND x.politique = 'cgu_admin'
        AND x.version = c.cgu_admin_version AND x.accepte_le = c.cgu_admin_accepted_at);
