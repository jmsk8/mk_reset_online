-- Sessions de tournois : rendre explicite le regroupement « meme occasion de jeu ».
-- Conception complete : docs/plan-sessions-tournois.md (Phase 1, sections 3 et 11).
--
-- POURQUOI. Plusieurs endroits du code devinent aujourd'hui, a posteriori, que
-- deux tournois font partie de la meme occasion de jeu, en comparant leurs
-- dates -- la penalite d'absence (routes_admin, `same_day_exists`) et le
-- comptage des awards (services, `session_keys`). Deux heuristiques distinctes
-- pour la meme notion, qu'aucune donnee ne porte. Cette migration cree la
-- donnee : chaque tournoi pointe vers une session, et « meme session » remplace
-- « meme jour » partout ensuite.
--
-- NOM DE LA TABLE. `sessions_tournois`, jamais `sessions` : `sessions_joueurs`
-- existe deja et porte les sessions d'AUTHENTIFICATION. Deux concepts sans
-- rapport, dont la confusion en lecture de code serait couteuse.
--
-- REGLE DE REGROUPEMENT : (date, ligue_id). Deux tournois partagent une session
-- s'ils ont la meme date ET la meme ligue. Deux tournois de ligues differentes
-- le meme jour restent deux sessions distinctes -- ce sont deux occasions de
-- jeu separees (plan 14, clarification du 15/09). C'est exactement la cle que
-- `session_keys` calcule deja dans services.py : le backfill reproduit donc
-- l'historique a l'identique, il ne le reinterprete pas.
--
-- INVARIANT CIBLE : tournois.session_id est NOT NULL. Un tournoi jamais lie est
-- seul dans sa session, ce n'est pas un cas particulier. Consequence voulue :
-- le code de calcul n'a AUCUNE branche « tournoi sans session » a ecrire.
--
-- PREREQUIS -- a verifier AVANT de lancer ce fichier :
--     SELECT count(*) FROM public.tournois WHERE date IS NULL;   -- doit valoir 0
-- Un tournoi sans date ne peut pas etre regroupe : l'etape 4 (SET NOT NULL)
-- echouerait, et c'est voulu. Diagnostiquer plutot que contourner.
--
-- REJOUABLE. ON CONFLICT DO NOTHING + WHERE session_id IS NULL : relancer ce
-- fichier sur une base deja migree ne fait rien, et ne defait jamais une
-- liaison faite a la main depuis l'interface.

BEGIN;

-- 1. La table. Volontairement minimale : une session n'est qu'un identifiant de
--    regroupement. Pas de colonne `date` (chaque tournoi garde la sienne), pas
--    de `ligue_id` (c'est une propriete des tournois membres), pas de statut
--    ouvert/ferme (une session se construit par liaisons successives, elle n'a
--    pas de cycle de vie propre).
--
--    Tout ajout de colonne ici merite de se demander si l'information
--    n'appartient pas plutot aux tournois membres.
CREATE TABLE IF NOT EXISTS public.sessions_tournois (
    id          SERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sessions_tournois IS
    'Occasion de jeu regroupant un ou plusieurs tournois (typiquement deux lobbies '
    'simultanes). Un tournoi seul forme une session a un seul element : c''est le cas '
    'normal, pas un cas particulier. Sans rapport avec sessions_joueurs, qui porte les '
    'sessions d''authentification.';

-- 2. Le rattachement. Cree NULLABLE, le temps que le backfill remplisse les
--    lignes existantes -- un NOT NULL immediat sans DEFAULT echouerait sur une
--    table non vide. L'etape 4 le verrouille.
--
--    ON DELETE SET NULL ne s'appliquera jamais en usage normal (on ne supprime
--    pas une session qui a des tournois). Il est la pour qu'une suppression
--    accidentelle de session n'entraine pas les tournois en cascade : avec le
--    NOT NULL de l'etape 4, une telle suppression echoue bruyamment au lieu
--    d'effacer des tournois. Echec preferable a une perte silencieuse.
ALTER TABLE public.tournois
    ADD COLUMN IF NOT EXISTS session_id INTEGER
    REFERENCES public.sessions_tournois(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tournois.session_id IS
    'Occasion de jeu de ce tournoi. Jamais NULL : un tournoi non lie est seul dans sa '
    'session. Remplace le regroupement implicite par (date, ligue_id) qui etait '
    'recalcule a deux endroits du code.';

CREATE INDEX IF NOT EXISTS idx_tournois_session
    ON public.tournois(session_id);

-- 3. Backfill. Une session par groupe (date, ligue_id), dont l'id est celui du
--    tournoi le plus ancien du groupe.
--
--    Reutiliser l'id du tournoi-ancre evite une table de correspondance
--    temporaire et rend le resultat lisible a l'oeil nu : « session 90 = la
--    soiree du tournoi 90 ». Sur les donnees reelles au 15/09, ce backfill
--    produit 93 sessions pour 96 tournois (3 paires de lobbies regroupees).
INSERT INTO public.sessions_tournois (id, created_at)
SELECT MIN(t.id), now()
FROM public.tournois t
GROUP BY t.date, t.ligue_id
ON CONFLICT (id) DO NOTHING;

-- 4. Chaque tournoi rejoint la session de son groupe.
--
--    Le « WHERE session_id IS NULL » rend l'etape rejouable ET protege les
--    liaisons deja faites depuis l'interface : relancer la migration ne defait
--    jamais un regroupement decide par un admin.
--
--    Le predicat de ligue doit traiter NULL explicitement : « ligue_id =
--    ancre.ligue_id » est NULL (donc faux) quand les deux valent NULL, ce qui
--    laisserait sans session les 69 tournois hors mode ligue. C'est le piege
--    classique de ce backfill.
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

-- 5. Recaler la sequence APRES les INSERT a id explicite.
--
--    Sans ce setval, le premier « INSERT INTO sessions_tournois DEFAULT VALUES »
--    de add_tournament repartirait de 1 et heurterait une cle primaire
--    existante. C'est l'erreur classique de ce type de backfill, et elle ne se
--    manifeste qu'a la creation du tournoi suivant -- donc apres la migration,
--    sur un symptome qui ne pointe pas vers elle.
--
--    GREATEST(..., 1) : setval refuse 0, et MAX(id) vaut NULL sur table vide.
SELECT setval('public.sessions_tournois_id_seq',
              GREATEST((SELECT COALESCE(MAX(id), 0) FROM public.sessions_tournois), 1));

-- 6. Verrouillage de l'invariant. Cet ALTER echoue si l'etape 4 a laisse un
--    tournoi de cote -- et c'est le comportement voulu.
--
--    ⚠️ NE PAS contourner un echec ici en retirant le NOT NULL. Diagnostiquer :
--        SELECT id, date, ligue_id FROM public.tournois WHERE session_id IS NULL;
--    Tout le code qui suit cette migration suppose « tout tournoi a une
--    session ». Un NULL tolere ici ressortirait plus tard en erreur de calcul,
--    beaucoup plus difficile a relier a sa cause.
ALTER TABLE public.tournois ALTER COLUMN session_id SET NOT NULL;

-- 7. Controle d'integrite : un joueur ne peut pas etre dans deux tournois d'une
--    meme session (decision 9 du plan -- deux lobbies simultanes, un joueur ne
--    peut pas etre dans les deux).
--
--    Verifie a 0 sur les 658 participations de l'historique au 15/09 : la regle
--    etait deja respectee de fait. Ce bloc transforme cette regularite observee
--    en invariant verifie, et ARRETE la migration si les donnees la violent --
--    plutot que de laisser le code aval s'appuyer sur une hypothese fausse.
--
--    Pas de contrainte declarative possible : l'information est repartie sur
--    deux tables (session_id sur tournois, joueur_id sur participations). Le
--    respect en ecriture est donc applicatif, dans add_tournament et
--    fusionner_sessions.
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
