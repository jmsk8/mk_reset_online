-- Reference de l'IP v2 : grille des joueurs figee avant le premier tournoi du
-- jour, stockee joueur par joueur (leave-one-out, critere d'inclusion modifiable).

CREATE TABLE IF NOT EXISTS public.grille_snapshots (
    date date NOT NULL,
    joueur_id integer NOT NULL REFERENCES public.joueurs(id) ON DELETE CASCADE,
    mu double precision NOT NULL,
    sigma double precision NOT NULL,
    is_ranked boolean NOT NULL DEFAULT true,
    tier character(1) NOT NULL DEFAULT 'U',
    source character varying(16) NOT NULL DEFAULT 'live',
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT grille_snapshots_pkey PRIMARY KEY (date, joueur_id)
);

CREATE INDEX IF NOT EXISTS idx_grille_snapshots_date ON public.grille_snapshots (date);
