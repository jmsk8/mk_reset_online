-- Hierarchie de roles admin a 4 paliers + permissions delegables a la carte.
-- Conception complete : docs/hierarchie-admin-plan.md (3).
--
-- Le modele plat a 3 roles ne suffit plus des que deux comptes admin doivent
-- avoir des droits differents et NON emboites (l'un les joueurs, l'autre les
-- tournois). Ce n'est plus un niveau sur une echelle, c'est un ensemble de
-- droits nommes : d'ou le palier chef_admin et la table permissions_admin.
--
-- PREREQUIS -- a verifier AVANT de lancer ce fichier (plan 3.5) :
--     SELECT COUNT(*) FROM comptes WHERE role = 'superadmin';   -- doit valoir 1
-- Si la mitigation « au moins deux superadmin » de R-38 a ete suivie en prod,
-- l'index unique ci-dessous echouera net a la creation. Echec bruyant, donc
-- sur, mais autant le savoir avant : retrograder manuellement tous les
-- superadmin sauf un.

BEGIN;

-- 1. Quatre roles au lieu de trois.
ALTER TABLE public.comptes DROP CONSTRAINT comptes_role_valide;
ALTER TABLE public.comptes ADD CONSTRAINT comptes_role_valide
    CHECK (role IN ('player', 'admin', 'chef_admin', 'superadmin'));

-- 2. Unicite STRICTE du superadmin : jamais deux, jamais zero.
--
-- Cet index ne garantit que la moitie « jamais 2+ ». Le « jamais 0 » reste
-- applicatif : garde du dernier superadmin dans changer_role, et atomicite du
-- legs (plan 6bis.1).
--
-- Index PARTIEL, donc non-deferrable : Postgres refuse
-- ADD CONSTRAINT ... UNIQUE USING INDEX dessus. Consequence directe et non
-- negociable pour le legs : retrograder l'ancien AVANT de promouvoir le
-- nouveau, dans cet ordre, dans la meme transaction. L'ordre inverse leve
-- 23505 a chaque tentative -- pas seulement dans un cas limite.
CREATE UNIQUE INDEX IF NOT EXISTS idx_comptes_superadmin_unique
    ON public.comptes (role)
    WHERE role = 'superadmin';

-- 3. Permissions delegables, accordees une par une a un compte role=admin.
CREATE TABLE IF NOT EXISTS public.permissions_admin (
    id          SERIAL PRIMARY KEY,
    compte_id   INTEGER NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    permission  VARCHAR(50) NOT NULL,
    -- Qui a accorde. Jamais lu depuis le corps de la requete (R-49).
    accorde_par INTEGER REFERENCES public.comptes(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Rend l'octroi idempotent : INSERT ... ON CONFLICT DO NOTHING.
    CONSTRAINT permissions_admin_unique UNIQUE (compte_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_permissions_admin_compte
    ON public.permissions_admin(compte_id);

-- Pas de colonne revoked_at, contrairement a service_tokens : cette table est
-- l'etat COURANT des droits, pas un historique. Une revocation fait un DELETE,
-- et audit_admin garde la trace (permission_retiree). Conserver les lignes
-- revoquees obligerait permission_required a filtrer sur chaque requete admin
-- protegee, c'est-a-dire sur le chemin chaud.
COMMENT ON TABLE public.permissions_admin IS
    'Permissions a la carte accordees a un compte role=admin. Les jetons de bot n''y '
    'figurent jamais : ce sont une capacite de role, verifiee par role_required(superadmin) '
    'directement, jamais par ce catalogue.';

COMMENT ON COLUMN public.permissions_admin.accorde_par IS
    'Qui a accorde ce droit. ON DELETE SET NULL : si le compte accordant est supprime '
    '(RGPD), la permission accordee reste valide -- audit_admin garde la tracabilite '
    'historique complete meme apres.';

COMMIT;
