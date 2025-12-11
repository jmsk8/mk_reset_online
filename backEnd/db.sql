--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: joueurs; Type: TABLE; Schema: public; Owner: username
--

CREATE TABLE public.joueurs (
    id integer NOT NULL,
    nom character varying(255) NOT NULL,
    mu double precision DEFAULT 25.0,
    sigma double precision DEFAULT 8.333,
    score_trueskill double precision GENERATED ALWAYS AS ((mu - ((3)::double precision * sigma))) STORED,
    tier character(1) DEFAULT 'U'::bpchar, -- Par défaut U (Unranked)
    CONSTRAINT joueurs_tier_check CHECK ((tier = ANY (ARRAY['S'::bpchar, 'A'::bpchar, 'B'::bpchar, 'C'::bpchar, 'U'::bpchar])))
);


ALTER TABLE public.joueurs OWNER TO username;

--
-- Name: joueurs_id_seq; Type: SEQUENCE; Schema: public; Owner: username
--

CREATE SEQUENCE public.joueurs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.joueurs_id_seq OWNER TO username;

--
-- Name: joueurs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: username
--

ALTER SEQUENCE public.joueurs_id_seq OWNED BY public.joueurs.id;


--
-- Name: participations; Type: TABLE; Schema: public; Owner: username
--

CREATE TABLE public.participations (
    joueur_id integer NOT NULL,
    tournoi_id integer NOT NULL,
    score integer NOT NULL,
    -- Nouveaux champs pour l'historique TrueSkill
    mu double precision,
    sigma double precision,
    new_score_trueskill double precision,
    new_tier character(1),
    position integer
);


ALTER TABLE public.participations OWNER TO username;

--
-- Name: tournois; Type: TABLE; Schema: public; Owner: username
--

CREATE TABLE public.tournois (
    id integer NOT NULL,
    date date NOT NULL
);


ALTER TABLE public.tournois OWNER TO username;

--
-- Name: tournois_id_seq; Type: SEQUENCE; Schema: public; Owner: username
--

CREATE SEQUENCE public.tournois_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.tournois_id_seq OWNER TO username;

--
-- Name: tournois_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: username
--

ALTER SEQUENCE public.tournois_id_seq OWNED BY public.tournois.id;


--
-- Name: joueurs id; Type: DEFAULT; Schema: public; Owner: username
--

ALTER TABLE ONLY public.joueurs ALTER COLUMN id SET DEFAULT nextval('public.joueurs_id_seq'::regclass);


--
-- Name: tournois id; Type: DEFAULT; Schema: public; Owner: username
--

ALTER TABLE ONLY public.tournois ALTER COLUMN id SET DEFAULT nextval('public.tournois_id_seq'::regclass);


--
-- Data for Name: joueurs; Type: TABLE DATA; Schema: public; Owner: username
--

COPY public.joueurs (id, nom, mu, sigma, tier) FROM stdin;
1	Rosalyan	67.897	3.002	S
2	J_sk8	57.662	0.858	S
3	Elite	56.314	0.865	S
4	Rayou	55.923	1.142	S
5	Vakaeltraz	54.805	0.788	S
6	Melwin	52.797	0.838	A
7	Lu_K	53.467	1.123	A
8	Clem	50.023	0.884	A
9	Daytona_69	48.956	1.131	A
10	JeanCube	50.280	1.956	A
11	Oleas	56.247	4.235	U
12	Thaumas	51.464	2.719	B
13	Ether-Zero	52.986	4.335	U
14	Ael	44.339	1.818	B
15	Tomwilson	49.867	4.522	U
16	Falgo	41.529	2.054	B
17	Brook1l	42.095	2.266	B
18	Hardox	40.936	2.108	C
19	ColorOni	47.302	4.294	U
20	Camou	42.971	3.181	C
21	Kemoory	39.060	2.010	C
22	Fozlo	38.119	1.859	C
23	McK17	43.013	3.604	C
24	Kaysuan	43.312	5.890	U
25	PastPlayer	42.099	5.725	U
26	Tomy	35.993	4.691	U
\.


--
-- Data for Name: participations; Type: TABLE DATA; Schema: public; Owner: username
--

COPY public.participations (joueur_id, tournoi_id, score) FROM stdin;
1	2	120
2	2	100
3	2	50
4	3	100
5	3	90
6	3	80
7	3	70
4	4	95
5	4	85
6	4	75
8	4	65
9	4	15
10	5	100
11	5	80
4	5	75
\.


--
-- Data for Name: tournois; Type: TABLE DATA; Schema: public; Owner: username
--

COPY public.tournois (id, date) FROM stdin;
2	1000-12-12
3	2025-04-15
4	2025-04-16
5	2025-05-07
\.


--
-- Name: joueurs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: username
--

SELECT pg_catalog.setval('public.joueurs_id_seq', 11, true);


--
-- Name: tournois_id_seq; Type: SEQUENCE SET; Schema: public; Owner: username
--

SELECT pg_catalog.setval('public.tournois_id_seq', 5, true);


--
-- Name: joueurs joueurs_nom_key; Type: CONSTRAINT; Schema: public; Owner: username
--

ALTER TABLE ONLY public.joueurs
    ADD CONSTRAINT joueurs_nom_key UNIQUE (nom);


--
-- Name: joueurs joueurs_pkey; Type: CONSTRAINT; Schema: public; Owner: username
--

ALTER TABLE ONLY public.joueurs
    ADD CONSTRAINT joueurs_pkey PRIMARY KEY (id);


--
-- Name: participations participations_pkey; Type: CONSTRAINT; Schema: public; Owner: username
--

ALTER TABLE ONLY public.participations
    ADD CONSTRAINT participations_pkey PRIMARY KEY (joueur_id, tournoi_id);


--
-- Name: tournois tournois_date_key; Type: CONSTRAINT; Schema: public; Owner: username
--

ALTER TABLE ONLY public.tournois
    ADD CONSTRAINT tournois_date_key UNIQUE (date);


--
-- Name: tournois tournois_pkey; Type: CONSTRAINT; Schema: public; Owner: username
--

ALTER TABLE ONLY public.tournois
    ADD CONSTRAINT tournois_pkey PRIMARY KEY (id);


--
-- Name: participations participations_joueur_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: username
--

ALTER TABLE ONLY public.participations
    ADD CONSTRAINT participations_joueur_id_fkey FOREIGN KEY (joueur_id) REFERENCES public.joueurs(id) ON DELETE CASCADE;


--
-- Name: participations participations_tournoi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: username
--

ALTER TABLE ONLY public.participations
    ADD CONSTRAINT participations_tournoi_id_fkey FOREIGN KEY (tournoi_id) REFERENCES public.tournois(id) ON DELETE CASCADE;
