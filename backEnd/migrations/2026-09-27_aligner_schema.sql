-- Aligne une base issue d'un dump de prod sur schema.sql.
--
-- Constate le 27/09 en migrant dumps/avant-ete-2026.sql puis en comparant le
-- schema obtenu a schema.sql : toutes les tables et colonnes y etaient, mais
-- deux ecarts subsistaient.
--
-- 1. Les index de performance. Ils sont dans schema.sql depuis le decoupage
--    du backend (81a8bd5, mars), donc presents sur toute base creee a neuf,
--    mais aucune migration ne les a jamais crees : la prod ne les a pas (le
--    dump d'ete du 27/09 n'en porte aucun). Sans effet sur les resultats,
--    seulement sur la vitesse des lectures.
--    idx_tournois_session n'est pas repris : 2026-09-15_sessions_tournois.sql
--    le cree deja.
CREATE INDEX IF NOT EXISTS idx_participations_joueur_id ON public.participations(joueur_id);
CREATE INDEX IF NOT EXISTS idx_participations_tournoi_id ON public.participations(tournoi_id);
CREATE INDEX IF NOT EXISTS idx_joueurs_ligue_id ON public.joueurs(ligue_id);
CREATE INDEX IF NOT EXISTS idx_tournois_date ON public.tournois(date);
CREATE INDEX IF NOT EXISTS idx_awards_obtenus_joueur_id ON public.awards_obtenus(joueur_id);
CREATE INDEX IF NOT EXISTS idx_awards_obtenus_saison_id ON public.awards_obtenus(saison_id);
CREATE INDEX IF NOT EXISTS idx_ghost_log_joueur_id ON public.ghost_log(joueur_id);
CREATE INDEX IF NOT EXISTS idx_ghost_log_tournoi_id ON public.ghost_log(tournoi_id);

-- 2. Le defaut de grille_snapshots.tier. 2026-09-13_add_tiers_table.sql a
--    elargi la colonne en VARCHAR(10) sans reposer son defaut, reste type
--    'U'::bpchar. Meme geste que pour joueurs.tier dans cette migration-la.
ALTER TABLE public.grille_snapshots ALTER COLUMN tier SET DEFAULT 'U';
