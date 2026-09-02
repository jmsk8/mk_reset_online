-- Une demande de liaison peut desormais viser une fiche qui N'EXISTE PAS ENCORE.
--
-- Le nouvel arrivant qui ne trouve pas sa fiche n'avait aucune issue : la liste
-- des fiches revendicables pouvait etre vide, et la page se contentait alors de
-- lui dire de contacter un administrateur -- hors du site, sans trace.
--
-- Plutot qu'une seconde table et une seconde file d'attente, la demande de
-- creation emprunte celle qui existe : meme ecran d'admin, meme approbation,
-- meme journal. Une demande porte donc SOIT un joueur_id (rattachement), SOIT
-- un nom a creer, jamais les deux ni aucun des deux -- c'est ce que dit la
-- contrainte.
--
-- Le nom est fige a la demande, et non relu au moment d'approuver : l'admin
-- doit approuver ce qu'il a sous les yeux, pas ce que le pseudo Discord sera
-- devenu entre-temps.

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
