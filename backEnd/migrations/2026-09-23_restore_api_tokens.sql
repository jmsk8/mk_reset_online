-- MIGRATION INVERSE, a ne jouer QUE dans le cadre du break-glass.
--
-- Contrepartie de 2026-09-23_drop_api_tokens.sql. Elle n'est PAS montee dans
-- docker-compose.dump.yml et ne doit jamais tourner sur le chemin normal : la
-- jouer ressusciterait une table que plus aucun code ne lit.
--
-- Son seul usage est celui decrit par runbook-admin.md 3.2b : Discord est
-- durablement indisponible, on revert le commit qui a supprime le mot de passe,
-- et le code ainsi restaure a besoin de sa table. L'ordre compte -- jouer cette
-- migration AVANT de redemarrer le backend revenu en arriere, sinon la premiere
-- tentative de connexion repond 500.
--
-- Definition reprise telle quelle de backEnd/schema.sql avant le 2026-09-23.

CREATE TABLE IF NOT EXISTS public.api_tokens (
    token character varying(64) NOT NULL PRIMARY KEY,
    created_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL
);
ALTER TABLE public.api_tokens OWNER TO CURRENT_USER;
