-- Couleur du texte des badges de tier, reglable comme le fond. Le defaut blanc
-- reproduit l'affichage d'avant. Le texte de U se regle dans `configuration`
-- (clef tier_u_couleur_texte) ; sans reglage il reste noir ou blanc selon le fond.

ALTER TABLE public.tiers ADD COLUMN IF NOT EXISTS couleur_texte VARCHAR(20) NOT NULL DEFAULT '#FFFFFF';
