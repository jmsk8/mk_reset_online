-- Tiers dynamiques geres par l'admin (nom, couleur, seuil en ecart-type, rang
-- decroissant du meilleur au pire). Le plancher est le tier de plus petit rang
-- (seuil_k NULL). 'U' n'est pas un tier.

CREATE TABLE IF NOT EXISTS public.tiers (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(10) NOT NULL,
    couleur VARCHAR(20) NOT NULL,
    -- NULL uniquement pour le plancher.
    seuil_k DOUBLE PRECISION,
    rang INTEGER NOT NULL UNIQUE
);
ALTER TABLE public.tiers OWNER TO CURRENT_USER;

-- Valeurs initiales identiques aux tiers fixes : S=3 ... C=0 (plancher).
INSERT INTO public.tiers (nom, couleur, seuil_k, rang) VALUES
    ('S', '#f77b7b', 1.0, 3),
    ('A', '#9cda74', 0.0, 2),
    ('B', '#7fe6ee', -1.0, 1),
    ('C', '#ae6ce4', NULL, 0)
ON CONFLICT (rang) DO NOTHING;

-- Joueurs.tier devient un nom libre (1-10 caracteres), sans FK vers tiers.
ALTER TABLE public.joueurs ALTER COLUMN tier TYPE VARCHAR(10);
ALTER TABLE public.joueurs ALTER COLUMN tier SET DEFAULT 'U';

-- Meme elargissement pour grille_snapshots.tier.
ALTER TABLE public.grille_snapshots ALTER COLUMN tier TYPE VARCHAR(10);

-- Les seuils tier_k_s/a/b sont remplaces par cette table.
DELETE FROM public.configuration WHERE key IN ('tier_k_s', 'tier_k_a', 'tier_k_b');
