-- Reference de l'IP v2 : mu moyen de la grille des joueurs, fige par journee.
-- La grille complete est sauvegardee juste avant la generation du premier
-- tournoi du jour, et tous les tournois de cette journee (session de
-- matchmaking scindee en plusieurs lobbies) partagent la meme reference.
--
-- La grille est stockee joueur par joueur, et non sous forme de moyenne
-- pre-calculee, pour deux raisons : le leave-one-out doit pouvoir retirer le
-- mu du joueur juge, et le critere d'inclusion (cf IP_V2_REF_* dans
-- constants.py) doit rester modifiable sans avoir a re-figer l'historique.

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
