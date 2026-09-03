-- Empeche la resurrection d'une identite anonymisee.
--
-- add_tournament cree un joueur a la volee quand le nom saisi est inconnu :
-- apres une anonymisation, ressaisir "Toto" recreerait la fiche qu'on venait
-- de retirer.
--
-- On stocke un SHA256 du nom en minuscules, jamais le nom : la table repond
-- « ce nom est-il interdit ? » sans conserver l'identite effacee.

BEGIN;

CREATE TABLE IF NOT EXISTS public.noms_interdits (
    nom_hash    CHAR(64) PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.noms_interdits IS
    'sha256(lower(nom)) des identites anonymisees. Jamais le nom en clair.';

COMMIT;
