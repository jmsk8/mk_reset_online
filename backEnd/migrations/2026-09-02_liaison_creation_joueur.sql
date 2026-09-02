-- Une demande de liaison peut desormais viser une fiche a CREER.
--
-- Elle emprunte la file d'attente existante plutot qu'une seconde table :
-- meme ecran d'admin, meme approbation, meme journal. Une demande porte donc
-- soit un joueur_id, soit un nom a creer, jamais les deux -- c'est la
-- contrainte plus bas.

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
