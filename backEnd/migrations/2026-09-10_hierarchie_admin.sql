-- Hierarchie de roles a 4 paliers et permissions delegables.
--
-- Prerequis : un seul superadmin (sinon l'index unique echoue).
--     SELECT COUNT(*) FROM comptes WHERE role = 'superadmin';   -- doit valoir 1

BEGIN;

-- 1. Quatre roles au lieu de trois.
ALTER TABLE public.comptes DROP CONSTRAINT comptes_role_valide;
ALTER TABLE public.comptes ADD CONSTRAINT comptes_role_valide
    CHECK (role IN ('player', 'admin', 'chef_admin', 'superadmin'));

-- 2. Un seul superadmin. Index partiel non differable : le legs retrograde
--    l'ancien avant de promouvoir le nouveau.
CREATE UNIQUE INDEX IF NOT EXISTS idx_comptes_superadmin_unique
    ON public.comptes (role)
    WHERE role = 'superadmin';

-- 3. Permissions delegables, accordees une par une a un compte role=admin.
CREATE TABLE IF NOT EXISTS public.permissions_admin (
    id          SERIAL PRIMARY KEY,
    compte_id   INTEGER NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    permission  VARCHAR(50) NOT NULL,
    -- Qui a accorde.
    accorde_par INTEGER REFERENCES public.comptes(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT permissions_admin_unique UNIQUE (compte_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_permissions_admin_compte
    ON public.permissions_admin(compte_id);

-- Etat courant des droits : un retrait fait un DELETE, trace dans audit_admin.
COMMENT ON TABLE public.permissions_admin IS
    'Permissions a la carte accordees a un compte role=admin. Les jetons de bot n''y '
    'figurent jamais : ce sont une capacite de role, verifiee par role_required(superadmin) '
    'directement, jamais par ce catalogue.';

COMMENT ON COLUMN public.permissions_admin.accorde_par IS
    'Qui a accorde ce droit. ON DELETE SET NULL : si le compte accordant est supprime '
    '(RGPD), la permission accordee reste valide -- audit_admin garde la tracabilite '
    'historique complete meme apres.';

COMMIT;
