-- Notifications destinees a un compte.
--
-- Jusqu'ici, tout ce qu'un administrateur decidait sur le dos de quelqu'un se
-- passait en silence : une revendication refusee, une fiche supprimee, un
-- compte delie. La personne revenait un jour sur /mon-compte et constatait
-- que quelque chose avait change, sans savoir quoi ni pourquoi.
--
-- Le texte est FIGE a l'emission, et non reconstruit a l'affichage. Une
-- notification parle souvent d'une chose qui n'existe plus -- la fiche qu'on
-- vient de supprimer, la demande qu'on vient de refuser. La reconstruire par
-- jointure donnerait « votre demande pour (null) a ete refusee ».

BEGIN;

CREATE TABLE IF NOT EXISTS public.notifications (
    id          SERIAL PRIMARY KEY,
    compte_id   INTEGER NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    -- Categorie, pour l'icone et rien d'autre : le texte affiche est celui
    -- des colonnes titre/corps.
    type        VARCHAR(40) NOT NULL,
    titre       VARCHAR(160) NOT NULL,
    corps       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    lu_at       TIMESTAMPTZ
);

-- Index partiel : la seule question posee a chaque chargement de page est
-- « combien de non-lues ? ». Les lues, elles, ne sont lues que sur ouverture
-- du panneau.
CREATE INDEX IF NOT EXISTS idx_notifications_non_lues
    ON public.notifications(compte_id) WHERE lu_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_compte_date
    ON public.notifications(compte_id, created_at DESC);

COMMENT ON TABLE public.notifications IS
    'Messages destines a un compte. Texte fige a l''emission. Efface avec le compte.';

COMMIT;
