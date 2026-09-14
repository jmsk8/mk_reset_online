-- Tiers dynamiques (Phase 4, cf docs/tableau-seuils-tiers-plan.md Partie B) :
-- remplace les 4 tiers fixes S/A/B/C par une liste geree par l'admin
-- (nom libre, couleur, seuil en sigma, rang explicite).
--
-- 'U' (non classe / hors distribution) reste un cas cable en dur dans le
-- code (has_tier(), IP_V2_REF_REQUIRE_TIER, valeur par defaut a la creation
-- d'un joueur) : ce n'est PAS une ligne de cette table.
--
-- Le plancher (le tier qui n'a pas de seuil bas) est une propriete DERIVEE :
-- c'est toujours le tier au rang le plus PETIT, reconnu par seuil_k IS NULL.
-- Rang decroissant du meilleur au pire (le plus haut rang = meilleur tier).

CREATE TABLE IF NOT EXISTS public.tiers (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(10) NOT NULL,
    couleur VARCHAR(20) NOT NULL,
    -- NULL uniquement pour le tier de plus petit rang (le plancher, pas de
    -- seuil bas par definition). Pour tous les autres, obligatoire.
    seuil_k DOUBLE PRECISION,
    rang INTEGER NOT NULL UNIQUE
);
ALTER TABLE public.tiers OWNER TO CURRENT_USER;

-- Seed = comportement actuel (Partie A), pour qu'une base existante ne
-- change AUCUN tier tant que l'admin ne touche pas au nouveau panneau.
-- Rang decroissant : S=3 (meilleur) ... C=0 (plancher, seuil_k NULL).
INSERT INTO public.tiers (nom, couleur, seuil_k, rang) VALUES
    ('S', '#f77b7b', 1.0, 3),
    ('A', '#9cda74', 0.0, 2),
    ('B', '#7fe6ee', -1.0, 1),
    ('C', '#ae6ce4', NULL, 0)
ON CONFLICT (rang) DO NOTHING;

-- Joueurs.tier passe de character(1) a un nom libre (1-10 caracteres).
-- Reste un champ TEXTE LIBRE (pas de FK vers tiers.id) : un joueur garde son
-- etiquette meme si le tier correspondant est supprime entre-temps, jusqu'au
-- prochain recalculate_tiers() -- comportement deja implicite aujourd'hui
-- (COALESCE(tier, 'U') partout), juste etendu a un nom plus long.
ALTER TABLE public.joueurs ALTER COLUMN tier TYPE VARCHAR(10);
ALTER TABLE public.joueurs ALTER COLUMN tier SET DEFAULT 'U';

-- grille_snapshots.tier porte le meme genre de valeur (cf services.py
-- snapshot_grille) : meme elargissement, pour ne pas tronquer silencieusement
-- un nom de tier de plus d'un caractere au moment du snapshot quotidien.
ALTER TABLE public.grille_snapshots ALTER COLUMN tier TYPE VARCHAR(10);

-- tier_k_s/a/b (migration 2026-09-13_add_tier_thresholds.sql, Partie A du
-- meme plan) sont remplaces par cette table : 3 frontieres fixes ne
-- suffisent plus a decrire une liste de tiers de taille variable. Supprimes
-- ici pour ne pas laisser deux sources de verite coexister silencieusement.
DELETE FROM public.configuration WHERE key IN ('tier_k_s', 'tier_k_a', 'tier_k_b');
