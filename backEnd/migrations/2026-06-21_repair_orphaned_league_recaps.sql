BEGIN;

INSERT INTO public.ligues (id, nom, niveau, couleur)
SELECT DISTINCT
    (substring(t.ligue_nom from '(\d+)'))::int + 1 AS id,
    t.ligue_nom,
    (substring(t.ligue_nom from '(\d+)'))::int     AS niveau,
    COALESCE(t.ligue_couleur, '#FFFFFF')
FROM public.tournois t
WHERE t.ligue_id IS NULL
  AND t.ligue_nom IS NOT NULL
  AND t.ligue_nom <> ''
  AND t.ligue_nom <> 'Mixte'
  AND substring(t.ligue_nom from '(\d+)') IS NOT NULL
ON CONFLICT (id) DO NOTHING;

SELECT setval('public.ligues_id_seq', (SELECT COALESCE(MAX(id), 1) FROM public.ligues));

UPDATE public.tournois t
SET ligue_id = (substring(t.ligue_nom from '(\d+)'))::int + 1
WHERE t.ligue_id IS NULL
  AND t.ligue_nom IS NOT NULL
  AND t.ligue_nom <> ''
  AND t.ligue_nom <> 'Mixte'
  AND substring(t.ligue_nom from '(\d+)') IS NOT NULL;

COMMIT;
