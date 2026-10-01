-- Notifications d'un compte ; texte fige a l'emission.

BEGIN;

CREATE TABLE IF NOT EXISTS public.notifications (
    id          SERIAL PRIMARY KEY,
    compte_id   INTEGER NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    -- Categorie (icone).
    type        VARCHAR(40) NOT NULL,
    titre       VARCHAR(160) NOT NULL,
    corps       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    lu_at       TIMESTAMPTZ
);

-- Index partiel pour le compte des non-lues.
CREATE INDEX IF NOT EXISTS idx_notifications_non_lues
    ON public.notifications(compte_id) WHERE lu_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_compte_date
    ON public.notifications(compte_id, created_at DESC);

COMMENT ON TABLE public.notifications IS
    'Messages destines a un compte. Texte fige a l''emission. Efface avec le compte.';

COMMIT;
