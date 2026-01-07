SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET row_security = off;

-- Nettoyage complet
DROP TABLE IF EXISTS public.ghost_log CASCADE;
DROP TABLE IF EXISTS public.awards_obtenus CASCADE;
DROP TABLE IF EXISTS public.participations CASCADE;
DROP TABLE IF EXISTS public.tournois CASCADE;
DROP TABLE IF EXISTS public.joueurs CASCADE;
DROP TABLE IF EXISTS public.configuration CASCADE;
DROP TABLE IF EXISTS public.saisons CASCADE;
DROP TABLE IF EXISTS public.types_awards CASCADE;
DROP TABLE IF EXISTS public.api_tokens CASCADE;

-- CONFIGURATION
CREATE TABLE public.configuration (
    key character varying(50) NOT NULL PRIMARY KEY, 
    value character varying(255) NOT NULL
);
ALTER TABLE public.configuration OWNER TO username;

INSERT INTO public.configuration (key, value) VALUES 
('tau', '0.083'),
('ghost_enabled', 'false'),
('ghost_penalty', '0.1'),
('unranked_threshold', '10');

-- JOUEURS
CREATE TABLE public.joueurs (
    id integer NOT NULL PRIMARY KEY, 
    nom character varying(255) NOT NULL UNIQUE, 
    mu double precision DEFAULT 50.0, 
    sigma double precision DEFAULT 8.333, 
    score_trueskill double precision GENERATED ALWAYS AS ((mu - ((3)::double precision * sigma))) STORED, 
    tier character(1) DEFAULT 'U'::bpchar,
    consecutive_missed integer DEFAULT 0,
    is_ranked boolean DEFAULT true
);
ALTER TABLE public.joueurs OWNER TO username;

CREATE SEQUENCE public.joueurs_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.joueurs_id_seq OWNED BY public.joueurs.id;
ALTER TABLE ONLY public.joueurs ALTER COLUMN id SET DEFAULT nextval('public.joueurs_id_seq'::regclass);

-- TOURNOIS
CREATE TABLE public.tournois (
    id integer NOT NULL PRIMARY KEY, 
    date date NOT NULL
);
ALTER TABLE public.tournois OWNER TO username;

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
    CONSTRAINT participations_pkey PRIMARY KEY (joueur_id, tournoi_id)
);
ALTER TABLE public.participations OWNER TO username;

ALTER TABLE ONLY public.participations ADD CONSTRAINT participations_joueur_id_fkey FOREIGN KEY (joueur_id) REFERENCES public.joueurs(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.participations ADD CONSTRAINT participations_tournoi_id_fkey FOREIGN KEY (tournoi_id) REFERENCES public.tournois(id) ON DELETE CASCADE;

-- HISTORIQUE FANTÔME
CREATE TABLE public.ghost_log (
    id serial PRIMARY KEY,
    joueur_id integer REFERENCES public.joueurs(id) ON DELETE CASCADE,
    tournoi_id integer REFERENCES public.tournois(id) ON DELETE CASCADE,
    date date NOT NULL,
    old_sigma double precision NOT NULL,
    new_sigma double precision NOT NULL,
    penalty_applied double precision NOT NULL
);
ALTER TABLE public.ghost_log OWNER TO username;

-- API TOKENS
CREATE TABLE public.api_tokens (
    token character varying(64) NOT NULL PRIMARY KEY,
    created_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL
);
ALTER TABLE public.api_tokens OWNER TO username;

-- SAISONS (Modifiée pour is_yearly)
CREATE TABLE public.saisons (
    id serial PRIMARY KEY,
    nom character varying(100) NOT NULL,
    slug character varying(100) NOT NULL UNIQUE,
    date_debut date NOT NULL,
    date_fin date NOT NULL,
    is_active boolean DEFAULT false,
    config_awards jsonb DEFAULT '{}'::jsonb,
    victory_condition character varying(50),
    is_yearly boolean DEFAULT false
);
ALTER TABLE public.saisons OWNER TO username;

-- TYPES D'AWARDS
CREATE TABLE public.types_awards (
    id serial PRIMARY KEY,
    code character varying(50) NOT NULL UNIQUE,
    nom character varying(100) NOT NULL,
    emoji character varying(100) NOT NULL,
    description text
);
ALTER TABLE public.types_awards OWNER TO username;

-- AWARDS OBTENUS
CREATE TABLE public.awards_obtenus (
    id serial PRIMARY KEY,
    joueur_id integer REFERENCES public.joueurs(id) ON DELETE CASCADE,
    saison_id integer REFERENCES public.saisons(id) ON DELETE CASCADE,
    award_id integer REFERENCES public.types_awards(id) ON DELETE CASCADE,
    valeur character varying(50),
    created_at timestamp DEFAULT now(),
    UNIQUE(joueur_id, saison_id, award_id)
);
ALTER TABLE public.awards_obtenus OWNER TO username;

-- NOUVELLE HIÉRARCHIE D'AWARDS
INSERT INTO public.types_awards (code, nom, emoji, description) VALUES 
-- Récompenses de Saison (Moai)
('gold_moai', '1er', 'gold_moai.png', 'Vainqueur de Saison'),
('silver_moai', '2ème', 'silver_moai.png', '2ème de Saison'),
('bronze_moai', '3ème', 'bronze_moai.png', '3ème de Saison'),

-- Récompenses Annuelles (Super Moai)
('super_gold_moai', '1er', 'super_gold_moai.png', 'Vainqueur de l''année'),
('super_silver_moai', '2ème', 'super_silver_moai.png', '2ème de l''année'),
('super_bronze_moai', '3ème', 'super_bronze_moai.png', '3ème de l''année'),

-- Awards Normaux
('ez', 'EZ', '🥇', 'Le plus de 1ères places'),
('pas_loin', 'C''était pas loin', '🥈', 'Le plus de 2ème places'),
('stonks', 'Stonks', 'stonks.png', 'Plus forte progression TrueSkill'),
('not_stonks', 'Not Stonks', 'not_stonks.png', 'Plus forte perte TrueSkill'),
('stakhanov', 'Stakhanoviste', 'TposingFunky.png', 'Le plus de points marqués au total'),
('chillguy', 'Chill Guy', 'chillguy.png', 'Le score TrueSkill le plus stable'),

-- Logic mapping (caché, sert pour la victoire)
('Indice de Performance', 'Indice de Performance', '🎯', 'Calcul IP');
