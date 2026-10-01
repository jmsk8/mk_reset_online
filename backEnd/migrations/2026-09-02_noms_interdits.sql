-- Empeche la recreation d'une identite anonymisee : sha256 du nom en minuscules.

BEGIN;

CREATE TABLE IF NOT EXISTS public.noms_interdits (
    nom_hash    CHAR(64) PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.noms_interdits IS
    'sha256(lower(nom)) des identites anonymisees. Jamais le nom en clair.';

COMMIT;
