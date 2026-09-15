-- Penalite d'absence : seuils en SESSIONS LOUPEES au lieu de jours calendaires.
-- Conception complete : docs/plan-sessions-tournois.md (Phase 3, section 5.4).
--
-- POURQUOI. Les deux seuils mesuraient un ecart de dates depuis la derniere
-- apparition (ou la derniere penalite). Deux consequences genantes :
--   - un joueur etait penalise meme si AUCUN tournoi n'avait eu lieu entre
--     temps : le calendrier courait tout seul ;
--   - le reglage ne disait rien de ce qu'il sanctionnait reellement, puisque le
--     nombre d'occasions loupees depend du rythme de jeu.
-- Desormais le declenchement lit `consecutive_missed`, un compteur de sessions
-- loupees. Une periode sans session ne penalise donc plus personne -- c'est le
-- comportement voulu : on sanctionne les occasions manquees, pas le temps.
--
-- CONVERSION. Aucune equivalence automatique n'existe entre un delai en jours
-- et un nombre de sessions (il faudrait connaitre le rythme de jeu). Les
-- valeurs ci-dessous reproduisent le comportement observe -- environ une
-- session par semaine -- pour les reglages actuels (28 jours -> 4 sessions,
-- 7 jours -> 1 session). Elles sont modifiables depuis l'interface
-- d'administration.
--
-- PREREQUIS : 2026-09-15_sessions_tournois.sql doit avoir tourne. Sans
-- `tournois.session_id`, `consecutive_missed` compte encore des tournois isoles
-- et non des sessions, donc les nouveaux seuils n'auraient pas le sens annonce.
--
-- REJOUABLE : ON CONFLICT DO NOTHING a l'insertion, et les anciennes cles sont
-- supprimees sans condition (DELETE sur une cle absente ne fait rien).

BEGIN;

-- 1. Garde-fou : refuser de tourner avant la migration des sessions, plutot que
--    d'installer des seuils dont la semantique serait fausse.
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

-- 2. Les nouveaux reglages. Reprend la valeur convertie de l'ancien seuil quand
--    il existe, plutot qu'une constante seche : une base ou l'admin avait
--    regle 56 jours (8 semaines) doit se retrouver a 8 sessions, pas a 4.
--    Division entiere par 7, plancher a 1.
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

-- 3. Les anciennes cles n'ont plus aucun lecteur dans le code. Les laisser
--    serait pire que les supprimer : un admin pourrait les modifier en croyant
--    agir sur la penalite, sans aucun effet.
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
