-- Migration inverse de 2026-09-23_drop_api_tokens.sql, pour un retour arriere
-- uniquement (non montee dans docker-compose.dump.yml). A jouer avant de
-- redemarrer le backend revenu en arriere.

CREATE TABLE IF NOT EXISTS public.api_tokens (
    token character varying(64) NOT NULL PRIMARY KEY,
    created_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL
);
ALTER TABLE public.api_tokens OWNER TO CURRENT_USER;
