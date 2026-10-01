-- Aligne une base issue d'un dump de prod sur schema.sql.
--
-- 1. Index de performance absents des bases migrees
--    (idx_tournois_session est deja cree par 2026-09-15_sessions_tournois.sql).
CREATE INDEX IF NOT EXISTS idx_participations_joueur_id ON public.participations(joueur_id);
CREATE INDEX IF NOT EXISTS idx_participations_tournoi_id ON public.participations(tournoi_id);
CREATE INDEX IF NOT EXISTS idx_joueurs_ligue_id ON public.joueurs(ligue_id);
CREATE INDEX IF NOT EXISTS idx_tournois_date ON public.tournois(date);
CREATE INDEX IF NOT EXISTS idx_awards_obtenus_joueur_id ON public.awards_obtenus(joueur_id);
CREATE INDEX IF NOT EXISTS idx_awards_obtenus_saison_id ON public.awards_obtenus(saison_id);
CREATE INDEX IF NOT EXISTS idx_ghost_log_joueur_id ON public.ghost_log(joueur_id);
CREATE INDEX IF NOT EXISTS idx_ghost_log_tournoi_id ON public.ghost_log(tournoi_id);

-- 2. Defaut de grille_snapshots.tier apres son passage en VARCHAR(10).
ALTER TABLE public.grille_snapshots ALTER COLUMN tier SET DEFAULT 'U';
