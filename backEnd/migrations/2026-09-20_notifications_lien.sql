-- Lien d'une notification, fige a l'emission comme le texte. NULL pour les
-- anciennes notifications et les accuses de reception de promotion.

BEGIN;

ALTER TABLE public.notifications
    ADD COLUMN IF NOT EXISTS lien character varying(255);

COMMENT ON COLUMN public.notifications.lien IS
    'URL interne figee a l''emission. NULL quand la notification n''appelle '
    'aucune action, ou qu''elle precede cette colonne.';

COMMIT;
