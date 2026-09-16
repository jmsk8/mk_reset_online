-- Reset global du sigma : plafond par joueur.
--
-- Avant : le reset faisait « UPDATE Joueurs SET sigma = sigma + val » sans
-- WHERE, donc tous les joueurs prenaient la meme valeur, sans limite haute.
-- Desormais l'admin fournit aussi un PLAFOND : un joueur sous le plafond y est
-- amene sans le depasser (1.8 + 0.3 plafonne a 2 -> 2.0), un joueur deja au
-- plafond ou au-dessus n'est PAS touche du tout.

-- NULLABLE a dessein : NULL = reset applique avant cette migration, donc sans
-- plafond. C'est l'information exacte -- mettre une valeur par defaut ici
-- ferait croire a un plafond qui n'a jamais ete applique.
ALTER TABLE public.global_resets ADD COLUMN IF NOT EXISTS max_sigma REAL;

-- Detail par joueur. Necessaire au revert : avec un plafond, les joueurs n'ont
-- plus tous recu la meme chose (celui qui butait sur le plafond a pris moins
-- que `value_applied`). Un revert uniforme « sigma - value_applied » leur
-- retirerait plus qu'ils n'ont recu. On retient donc l'etat d'avant, joueur par
-- joueur, et le revert le restaure tel quel.
--
-- Meme forme que ghost_log (old_sigma / new_sigma / penalty_applied), qui trace
-- deja les penalites d'absence de la meme facon.
CREATE TABLE IF NOT EXISTS public.global_reset_details (
    id SERIAL PRIMARY KEY,
    reset_id INTEGER NOT NULL REFERENCES public.global_resets(id) ON DELETE CASCADE,
    joueur_id INTEGER NOT NULL REFERENCES public.joueurs(id) ON DELETE CASCADE,
    old_sigma DOUBLE PRECISION NOT NULL,
    new_sigma DOUBLE PRECISION NOT NULL,
    delta_applied DOUBLE PRECISION NOT NULL
);
ALTER TABLE public.global_reset_details OWNER TO CURRENT_USER;

-- Le revert ne lit jamais que les lignes d'UN reset (le dernier).
CREATE INDEX IF NOT EXISTS idx_global_reset_details_reset
    ON public.global_reset_details(reset_id);
