-- Participation hors IP (DNF) : le score du joueur ne compte ni dans son IP, ni
-- dans la moyenne de son lobby pour les autres, ni dans ses tournois joues pour
-- l'IP. Le defaut reproduit le calcul d'avant.

ALTER TABLE public.participations ADD COLUMN IF NOT EXISTS exclude_from_ip BOOLEAN NOT NULL DEFAULT false;
