-- Sessions de tournois : regroupe les tournois d'une meme occasion de jeu,
-- par (date, ligue_id) pour l'historique. Rejouable : ne defait jamais une
-- liaison faite depuis l'interface.
--
-- Prerequis :
--     SELECT count(*) FROM public.tournois WHERE date IS NULL;   -- doit valoir 0

BEGIN;

-- 1. La table : un simple identifiant de regroupement.
CREATE TABLE IF NOT EXISTS public.sessions_tournois (
    id          SERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sessions_tournois IS
    'Occasion de jeu regroupant un ou plusieurs tournois (typiquement deux lobbies '
    'simultanes). Un tournoi seul forme une session a un seul element : c''est le cas '
    'normal, pas un cas particulier. Sans rapport avec sessions_joueurs, qui porte les '
    'sessions d''authentification.';

-- 2. Rattachement, nullable le temps du backfill (verrouille a l'etape 6).
ALTER TABLE public.tournois
    ADD COLUMN IF NOT EXISTS session_id INTEGER
    REFERENCES public.sessions_tournois(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tournois.session_id IS
    'Occasion de jeu de ce tournoi. Jamais NULL : un tournoi non lie est seul dans sa '
    'session. Remplace le regroupement implicite par (date, ligue_id) qui etait '
    'recalcule a deux endroits du code.';

CREATE INDEX IF NOT EXISTS idx_tournois_session
    ON public.tournois(session_id);

-- 3. Backfill : une session par groupe (date, ligue_id), avec l'id du tournoi
--    le plus ancien du groupe.
INSERT INTO public.sessions_tournois (id, created_at)
SELECT MIN(t.id), now()
FROM public.tournois t
GROUP BY t.date, t.ligue_id
ON CONFLICT (id) DO NOTHING;

-- 4. Chaque tournoi rejoint la session de son groupe. ligue_id NULL est traite
--    explicitement (NULL = NULL est NULL).
UPDATE public.tournois t
SET session_id = ancre.session_id
FROM (
    SELECT date, ligue_id, MIN(id) AS session_id
    FROM public.tournois
    GROUP BY date, ligue_id
) AS ancre
WHERE t.session_id IS NULL
  AND t.date = ancre.date
  AND (t.ligue_id = ancre.ligue_id
       OR (t.ligue_id IS NULL AND ancre.ligue_id IS NULL));

-- 5. Recale la sequence apres les INSERT a id explicite (GREATEST : setval
--    refuse 0).
SELECT setval('public.sessions_tournois_id_seq',
              GREATEST((SELECT COALESCE(MAX(id), 0) FROM public.sessions_tournois), 1));

-- 6. Echoue si un tournoi est reste sans session. Diagnostic :
--        SELECT id, date, ligue_id FROM public.tournois WHERE session_id IS NULL;
ALTER TABLE public.tournois ALTER COLUMN session_id SET NOT NULL;

-- 7. Un joueur ne peut pas etre dans deux tournois d'une meme session : la
--    migration s'arrete sinon (la regle est ensuite appliquee par le code).
DO $$
DECLARE
    doublons TEXT;
BEGIN
    SELECT string_agg(format('session %s / joueur %s (%s tournois)',
                             s.session_id, s.joueur_id, s.n), ', ')
    INTO doublons
    FROM (
        SELECT t.session_id, p.joueur_id, count(*) AS n
        FROM public.participations p
        JOIN public.tournois t ON t.id = p.tournoi_id
        GROUP BY t.session_id, p.joueur_id
        HAVING count(*) > 1
    ) AS s;

    IF doublons IS NOT NULL THEN
        RAISE EXCEPTION 'Un joueur participe a plusieurs tournois d''une meme session : %', doublons
            USING HINT = 'Le regroupement (date, ligue_id) a reuni des tournois qui partagent un '
                         'joueur. Verifier ces tournois : ce ne sont probablement pas deux lobbies '
                         'simultanes. Voir docs/plan-sessions-tournois.md, decision 9.';
    END IF;

    RAISE NOTICE 'Sessions creees : %. Tournois rattaches : %.',
        (SELECT count(*) FROM public.sessions_tournois),
        (SELECT count(*) FROM public.tournois WHERE session_id IS NOT NULL);
END
$$;

COMMIT;
