-- Annonces du superadmin (notes de mise a jour) : une ligne par annonce, et une
-- notification par compte qui la reference. Supprimer l'annonce retire ses
-- notifications de chez tout le monde (ON DELETE CASCADE).

BEGIN;

CREATE TABLE IF NOT EXISTS public.annonces (
    id          SERIAL PRIMARY KEY,
    titre       character varying(160) NOT NULL,
    -- Mini-Markdown, rendu cote navigateur sans HTML saisi.
    corps       text,
    created_at  timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.notifications
    ADD COLUMN IF NOT EXISTS annonce_id integer
        REFERENCES public.annonces(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_annonce
    ON public.notifications(annonce_id) WHERE annonce_id IS NOT NULL;

COMMENT ON COLUMN public.notifications.annonce_id IS
    'Annonce d''origine. NULL pour les notifications emises par le code.';

COMMIT;
