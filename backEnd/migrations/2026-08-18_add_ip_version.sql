-- IP v2 : correction par la force du lobby (voir IP_V2_* dans constants.py).

-- Reglage global, utilise pour le classement de saison en cours.
INSERT INTO public.configuration (key, value) VALUES
    ('ip_version_live', 'v1')
ON CONFLICT (key) DO NOTHING;

-- Version figee a la generation de chaque recap.
ALTER TABLE public.saisons
    ADD COLUMN IF NOT EXISTS ip_version character varying(4) NOT NULL DEFAULT 'v1';
