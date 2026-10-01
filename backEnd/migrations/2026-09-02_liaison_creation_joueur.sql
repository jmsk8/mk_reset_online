-- Une demande de liaison peut viser une fiche a creer : soit joueur_id, soit
-- nom_demande, jamais les deux.

BEGIN;

ALTER TABLE public.liaisons_demandes ALTER COLUMN joueur_id DROP NOT NULL;

ALTER TABLE public.liaisons_demandes
    ADD COLUMN IF NOT EXISTS nom_demande VARCHAR(255);

ALTER TABLE public.liaisons_demandes
    DROP CONSTRAINT IF EXISTS liaisons_cible_exclusive;
ALTER TABLE public.liaisons_demandes
    ADD CONSTRAINT liaisons_cible_exclusive
    CHECK ((joueur_id IS NULL) <> (nom_demande IS NULL));

COMMENT ON COLUMN public.liaisons_demandes.nom_demande IS
    'Nom de la fiche a creer. NULL pour une revendication de fiche existante.';

COMMIT;
