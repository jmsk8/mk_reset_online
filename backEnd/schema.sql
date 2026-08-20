SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET row_security = off;

DROP TABLE IF EXISTS public.ghost_log CASCADE;
DROP TABLE IF EXISTS public.awards_obtenus CASCADE;
DROP TABLE IF EXISTS public.participations CASCADE;
DROP TABLE IF EXISTS public.tournois CASCADE;
DROP TABLE IF EXISTS public.joueurs CASCADE;
DROP TABLE IF EXISTS public.configuration CASCADE;
DROP TABLE IF EXISTS public.saisons CASCADE;
DROP TABLE IF EXISTS public.types_awards CASCADE;
DROP TABLE IF EXISTS public.api_tokens CASCADE;
DROP TABLE IF EXISTS public.ligues CASCADE;

-- CONFIGURATION
CREATE TABLE public.configuration (
    key character varying(50) NOT NULL PRIMARY KEY, 
    value character varying(255) NOT NULL
);
ALTER TABLE public.configuration OWNER TO CURRENT_USER;

INSERT INTO public.configuration (key, value) VALUES
('tau', '0.083'),
('ghost_enabled', 'false'),
('ghost_penalty', '0.1'),
('ghost_threshold_days', '28'),
('ghost_interval_days', '7'),
('unranked_threshold', '10'),
('sigma_threshold', '4.0'),
('league_mode_enabled', 'false'),
('inter_league_moves', '0'),
('ip_version_live', 'v1');

-- LIGUES (Déplacé avant pour les références)
CREATE TABLE public.ligues (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(100) NOT NULL,
    niveau INTEGER NOT NULL,
    couleur VARCHAR(20) DEFAULT '#FFFFFF'
);
ALTER TABLE public.ligues OWNER TO CURRENT_USER;

-- JOUEURS
CREATE TABLE public.joueurs (
    id integer NOT NULL PRIMARY KEY, 
    nom character varying(255) NOT NULL UNIQUE, 
    mu double precision DEFAULT 50.0, 
    sigma double precision DEFAULT 8.333, 
    score_trueskill double precision GENERATED ALWAYS AS ((mu - ((3)::double precision * sigma))) STORED, 
    tier character(1) DEFAULT 'U'::bpchar,
    consecutive_missed integer DEFAULT 0,
    is_ranked boolean DEFAULT true,
    color character varying(7) DEFAULT '#FFFFFF',
    ligue_id INTEGER REFERENCES public.ligues(id) ON DELETE SET NULL
);
ALTER TABLE public.joueurs OWNER TO CURRENT_USER;

CREATE SEQUENCE public.joueurs_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.joueurs_id_seq OWNED BY public.joueurs.id;
ALTER TABLE ONLY public.joueurs ALTER COLUMN id SET DEFAULT nextval('public.joueurs_id_seq'::regclass);

-- TOURNOIS
-- Mise à jour : Ajout des colonnes pour l'archivage (snapshot)
CREATE TABLE public.tournois (
    id integer NOT NULL PRIMARY KEY, 
    date date NOT NULL,
    ligue_id INTEGER REFERENCES public.ligues(id) ON DELETE SET NULL,
    ligue_nom character varying(100),    -- Archive du nom au moment du tournoi
    ligue_couleur character varying(20)  -- Archive de la couleur
);
ALTER TABLE public.tournois OWNER TO CURRENT_USER;

CREATE SEQUENCE public.tournois_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.tournois_id_seq OWNED BY public.tournois.id;
ALTER TABLE ONLY public.tournois ALTER COLUMN id SET DEFAULT nextval('public.tournois_id_seq'::regclass);

-- PARTICIPATIONS
CREATE TABLE public.participations (
    joueur_id integer NOT NULL,
    tournoi_id integer NOT NULL,
    score integer NOT NULL,
    mu double precision,
    sigma double precision,
    new_score_trueskill double precision,
    new_tier character(1),
    position integer,
    old_mu double precision,
    old_sigma double precision,
    exclude_from_ts boolean DEFAULT false,
    CONSTRAINT participations_pkey PRIMARY KEY (joueur_id, tournoi_id)
);
ALTER TABLE public.participations OWNER TO CURRENT_USER;

ALTER TABLE ONLY public.participations ADD CONSTRAINT participations_joueur_id_fkey FOREIGN KEY (joueur_id) REFERENCES public.joueurs(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.participations ADD CONSTRAINT participations_tournoi_id_fkey FOREIGN KEY (tournoi_id) REFERENCES public.tournois(id) ON DELETE CASCADE;

-- GRILLE FIGEE (reference IP v2)
-- Etat de la grille des joueurs juste avant la generation du premier tournoi
-- d'une journee. Sert de moyenne de reference fixe a l'IP v2 : tous les
-- tournois d'un meme jour partagent la meme reference. Voir IP_V2_REF_* dans
-- constants.py pour le critere d'inclusion.
CREATE TABLE public.grille_snapshots (
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
ALTER TABLE public.grille_snapshots OWNER TO CURRENT_USER;

CREATE INDEX idx_grille_snapshots_date ON public.grille_snapshots (date);

-- HISTORIQUE FANTOME
CREATE TABLE public.ghost_log (
    id serial PRIMARY KEY,
    joueur_id integer REFERENCES public.joueurs(id) ON DELETE CASCADE,
    tournoi_id integer REFERENCES public.tournois(id) ON DELETE CASCADE,
    date date NOT NULL,
    old_sigma double precision NOT NULL,
    new_sigma double precision NOT NULL,
    penalty_applied double precision NOT NULL
);
ALTER TABLE public.ghost_log OWNER TO CURRENT_USER;

-- HISTORIQUE RESET GLOBAL
CREATE TABLE public.global_resets (
    id SERIAL PRIMARY KEY,
    date TIMESTAMP NOT NULL,
    value_applied REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.global_resets OWNER TO CURRENT_USER;

-- API TOKENS
CREATE TABLE public.api_tokens (
    token character varying(64) NOT NULL PRIMARY KEY,
    created_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL
);
ALTER TABLE public.api_tokens OWNER TO CURRENT_USER;

-- SAISONS
CREATE TABLE public.saisons (
    id serial PRIMARY KEY,
    nom character varying(100) NOT NULL,
    slug character varying(100) NOT NULL UNIQUE,
    date_debut date NOT NULL,
    date_fin date NOT NULL,
    is_active boolean DEFAULT false,
    config_awards jsonb DEFAULT '{}'::jsonb,
    victory_condition character varying(50),
    is_yearly boolean DEFAULT false,
    ligue_id INTEGER REFERENCES public.ligues(id) ON DELETE SET NULL,
    ligue_nom character varying(100),
    ligue_couleur character varying(20),
    is_league_recap boolean DEFAULT false,
    include_league_stats boolean DEFAULT false,
    include_league_moves boolean DEFAULT false,
    ip_version character varying(4) NOT NULL DEFAULT 'v1'
);
ALTER TABLE public.saisons OWNER TO CURRENT_USER;

-- MOUVEMENTS INTER-LIGUES (stockage des promotions/relégations)
CREATE TABLE public.league_movements (
    id SERIAL PRIMARY KEY,
    saison_id INTEGER REFERENCES public.saisons(id) ON DELETE CASCADE,
    joueur_id INTEGER REFERENCES public.joueurs(id) ON DELETE CASCADE,
    from_ligue_id INTEGER REFERENCES public.ligues(id) ON DELETE SET NULL,
    to_ligue_id INTEGER REFERENCES public.ligues(id) ON DELETE SET NULL,
    from_ligue_nom character varying(100),
    to_ligue_nom character varying(100),
    direction character varying(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.league_movements OWNER TO CURRENT_USER;

-- TYPES D'AWARDS
CREATE TABLE public.types_awards (
    id serial PRIMARY KEY,
    code character varying(50) NOT NULL UNIQUE,
    nom character varying(100) NOT NULL,
    emoji character varying(100) NOT NULL,
    description text
);
ALTER TABLE public.types_awards OWNER TO CURRENT_USER;

-- AWARDS OBTENUS
CREATE TABLE public.awards_obtenus (
    id serial PRIMARY KEY,
    joueur_id integer REFERENCES public.joueurs(id) ON DELETE CASCADE,
    saison_id integer REFERENCES public.saisons(id) ON DELETE CASCADE,
    award_id integer REFERENCES public.types_awards(id) ON DELETE CASCADE,
    valeur character varying(50),
    is_league_award boolean DEFAULT false,
    ligue_id integer REFERENCES public.ligues(id) ON DELETE SET NULL,
    ligue_nom character varying(100),
    ligue_couleur character varying(20),
    created_at timestamp DEFAULT now(),
    UNIQUE(joueur_id, saison_id, award_id, ligue_id)
);
ALTER TABLE public.awards_obtenus OWNER TO CURRENT_USER;
CREATE UNIQUE INDEX awards_obtenus_unique_no_ligue ON public.awards_obtenus (joueur_id, saison_id, award_id) WHERE ligue_id IS NULL;

-- INDEXES PERFORMANCE
CREATE INDEX idx_participations_joueur_id ON public.participations(joueur_id);
CREATE INDEX idx_participations_tournoi_id ON public.participations(tournoi_id);
CREATE INDEX idx_joueurs_ligue_id ON public.joueurs(ligue_id);
CREATE INDEX idx_tournois_date ON public.tournois(date);
CREATE INDEX idx_awards_obtenus_joueur_id ON public.awards_obtenus(joueur_id);
CREATE INDEX idx_awards_obtenus_saison_id ON public.awards_obtenus(saison_id);
CREATE INDEX idx_ghost_log_joueur_id ON public.ghost_log(joueur_id);
CREATE INDEX idx_ghost_log_tournoi_id ON public.ghost_log(tournoi_id);

INSERT INTO public.types_awards (code, nom, emoji, description) VALUES 
('gold_moai', '1er', 'trophy/saison/gold_moai.png', 'Vainqueur de Saison'),
('silver_moai', '2ème', 'trophy/saison/silver_moai.png', '2ème de Saison'),
('bronze_moai', '3ème', 'trophy/saison/bronze_moai.png', '3ème de Saison'),
('super_gold_moai', '1er', 'trophy/annee/super_gold_moai.png', 'Vainqueur de l''année'),
('super_silver_moai', '2ème', 'trophy/annee/super_silver_moai.png', '2ème de l''année'),
('super_bronze_moai', '3ème', 'trophy/annee/super_bronze_moai.png', '3ème de l''année'),
('ez', 'EZ', '🥇', 'Le plus de 1ères places'),
('pas_loin', 'C''était pas loin', '🥈', 'Le plus de 2ème places'),
('stonks', 'Stonks', 'award/stonks.png', 'Plus forte progression TrueSkill'),
('not_stonks', 'Not Stonks', 'award/not_stonks.png', 'Plus forte perte TrueSkill'),
('stakhanov', 'Stakhanoviste', 'award/TposingFunky.png', 'Le plus de points marqués au total'),
('chillguy', 'Chill Guy', 'award/chillguy.png', 'Le score TrueSkill le plus stable'),
('borderline', 'Instable', 'award/borderline.png', 'Les résultats les plus instables'),
('Indice de Performance', 'Indice de Performance', '🎯', 'Calcul IP');
