SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET row_security = off;

DROP TABLE IF EXISTS public.participations;
DROP TABLE IF EXISTS public.tournois;
DROP TABLE IF EXISTS public.joueurs;
DROP TABLE IF EXISTS public.configuration;


CREATE TABLE public.configuration (
    key character varying(50) NOT NULL PRIMARY KEY, 
    value character varying(255) NOT NULL
);

ALTER TABLE public.configuration OWNER TO username;


INSERT INTO public.configuration (key, value) VALUES ('tau', '0.083');


CREATE TABLE public.joueurs (
    id integer NOT NULL PRIMARY KEY, 
    nom character varying(255) NOT NULL UNIQUE, 
    mu double precision DEFAULT 50.0, 
    sigma double precision DEFAULT 8.333, 
    score_trueskill double precision GENERATED ALWAYS AS ((mu - ((3)::double precision * sigma))) STORED, 
    tier character(1) DEFAULT 'U'::bpchar
);

ALTER TABLE public.joueurs OWNER TO username;

CREATE SEQUENCE public.joueurs_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.joueurs_id_seq OWNED BY public.joueurs.id;
ALTER TABLE ONLY public.joueurs ALTER COLUMN id SET DEFAULT nextval('public.joueurs_id_seq'::regclass);


CREATE TABLE public.tournois (
    id integer NOT NULL PRIMARY KEY, 
    date date NOT NULL
);

ALTER TABLE public.tournois OWNER TO username;

CREATE SEQUENCE public.tournois_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.tournois_id_seq OWNED BY public.tournois.id;
ALTER TABLE ONLY public.tournois ALTER COLUMN id SET DEFAULT nextval('public.tournois_id_seq'::regclass);

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

DROP TABLE IF EXISTS public.api_tokens;

CREATE TABLE public.api_tokens (
    token character varying(64) NOT NULL PRIMARY KEY,
    created_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL
);

ALTER TABLE public.api_tokens OWNER TO username;
