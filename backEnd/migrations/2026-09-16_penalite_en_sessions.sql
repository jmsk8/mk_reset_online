-- Penalite d'absence : seuils en sessions loupees au lieu de jours. Les anciens
-- seuils sont convertis a raison d'une session par semaine (28 j -> 4, 7 j -> 1).
--
-- Prerequis : 2026-09-15_sessions_tournois.sql. Rejouable.

BEGIN;

-- 1. Refuse de tourner avant la migration des sessions.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tournois' AND column_name = 'session_id'
    ) THEN
        RAISE EXCEPTION 'tournois.session_id est absente : migration des sessions non appliquee.'
            USING HINT = 'Lancer d''abord 2026-09-15_sessions_tournois.sql.';
    END IF;
END
$$;

-- 2. Nouveaux reglages, convertis depuis les anciens (division entiere par 7,
--    plancher a 1).
INSERT INTO public.Configuration (key, value)
VALUES (
    'ghost_threshold_sessions',
    GREATEST(1, COALESCE(
        (SELECT (value::int) / 7 FROM public.Configuration
         WHERE key = 'ghost_threshold_days' AND value ~ '^[0-9]+$'),
        4))::text
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.Configuration (key, value)
VALUES (
    'ghost_interval_sessions',
    GREATEST(1, COALESCE(
        (SELECT (value::int) / 7 FROM public.Configuration
         WHERE key = 'ghost_interval_days' AND value ~ '^[0-9]+$'),
        1))::text
)
ON CONFLICT (key) DO NOTHING;

-- 3. Suppression des anciennes cles, plus lues par le code.
DELETE FROM public.Configuration
WHERE key IN ('ghost_threshold_days', 'ghost_interval_days');

DO $$
BEGIN
    RAISE NOTICE 'Penalite en sessions -- seuil : % session(s), intervalle : % session(s).',
        (SELECT value FROM public.Configuration WHERE key = 'ghost_threshold_sessions'),
        (SELECT value FROM public.Configuration WHERE key = 'ghost_interval_sessions');
END
$$;

COMMIT;
