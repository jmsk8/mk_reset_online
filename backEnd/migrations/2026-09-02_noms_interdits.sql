-- Empeche la resurrection d'une identite anonymisee.
--
-- add_tournament cree un joueur a la volee quand le nom saisi est inconnu.
-- Apres une anonymisation ("Toto" -> "Joueur #12-a7f3"), ressaisir "Toto" dans
-- le formulaire recreerait donc une fiche portant l'identite qu'on venait tout
-- juste de retirer -- et les stats repartiraient sur un doublon.
--
-- On stocke un SHA256 du nom en minuscules, jamais le nom lui-meme : la table
-- doit pouvoir repondre « ce nom est-il interdit ? » sans conserver l'identite
-- qu'on vient d'effacer. C'est le seul usage prevu, et il n'y a aucune route
-- qui lise cette table autrement qu'en comparant un hash fourni.

BEGIN;

CREATE TABLE IF NOT EXISTS public.noms_interdits (
    nom_hash    CHAR(64) PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.noms_interdits IS
    'sha256(lower(nom)) des identites anonymisees. Jamais le nom en clair.';

COMMIT;
