-- IPv2 : correction "force de lobby" pour les sessions matchmaking scindees
-- en plusieurs lobbies de niveau different. Voir constants.py (IP_V2_*).

-- Reglage global qui pilote le classement de saison en cours (toujours
-- recalcule a la volee, donc pas de figeage possible).
INSERT INTO public.configuration (key, value) VALUES
    ('ip_version_live', 'v1')
ON CONFLICT (key) DO NOTHING;

-- Version figee au moment de la generation de chaque recap : un recap deja
-- publie ne change jamais de resultat, meme si le reglage global bascule
-- ensuite.
ALTER TABLE public.saisons
    ADD COLUMN IF NOT EXISTS ip_version character varying(4) NOT NULL DEFAULT 'v1';
