-- Reset global du sigma avec plafond : un joueur sous le plafond y est amene
-- sans le depasser, un joueur deja au plafond n'est pas touche.

-- NULL : reset applique avant cette migration (sans plafond).
ALTER TABLE public.global_resets ADD COLUMN IF NOT EXISTS max_sigma REAL;

-- Detail par joueur, pour annuler un reset plafonne (meme forme que ghost_log).
CREATE TABLE IF NOT EXISTS public.global_reset_details (
    id SERIAL PRIMARY KEY,
    reset_id INTEGER NOT NULL REFERENCES public.global_resets(id) ON DELETE CASCADE,
    joueur_id INTEGER NOT NULL REFERENCES public.joueurs(id) ON DELETE CASCADE,
    old_sigma DOUBLE PRECISION NOT NULL,
    new_sigma DOUBLE PRECISION NOT NULL,
    delta_applied DOUBLE PRECISION NOT NULL
);
ALTER TABLE public.global_reset_details OWNER TO CURRENT_USER;

CREATE INDEX IF NOT EXISTS idx_global_reset_details_reset
    ON public.global_reset_details(reset_id);
