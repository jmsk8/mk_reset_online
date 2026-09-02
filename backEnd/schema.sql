SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET row_security = off;

DROP TABLE IF EXISTS public.noms_interdits CASCADE;
DROP TABLE IF EXISTS public.service_tokens CASCADE;
DROP TABLE IF EXISTS public.audit_admin CASCADE;
DROP TABLE IF EXISTS public.sessions_joueurs CASCADE;
DROP TABLE IF EXISTS public.profils CASCADE;
DROP TABLE IF EXISTS public.notifications CASCADE;
DROP TABLE IF EXISTS public.liaisons_demandes CASCADE;
DROP TABLE IF EXISTS public.comptes CASCADE;
DROP TABLE IF EXISTS public.invitations CASCADE;
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
    ligue_id INTEGER REFERENCES public.ligues(id) ON DELETE SET NULL,
    -- Marqueur d'identite retiree : empeche add_tournament de recreer a la
    -- volee une fiche portant un nom qu'on vient d'anonymiser.
    anonymise_at timestamp with time zone
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

-- ===========================================================================
-- AUTHENTIFICATION DISCORD ET COMPTES JOUEURS
-- ---------------------------------------------------------------------------
-- Separation IDENTITE / DOSSIER SPORTIF : comptes + profils + sessions_joueurs
-- decrivent la personne ; joueurs reste un competiteur pseudonyme. Supprimer un
-- compte n'altere donc jamais l'historique des matchs ni le classement.
--
-- Ces tables sont en TIMESTAMPTZ alors que le reste du schema est en TIMESTAMP
-- naif : cote Python, utiliser exclusivement datetime.now(timezone.utc) pour
-- elles, et ne jamais melanger les deux conventions dans une comparaison.
-- Voir aussi migrations/2026-09-02_auth_discord.sql (meme contenu, applique a
-- la main sur une base existante).
-- ===========================================================================

-- INVITATIONS -- le seul moyen d'entrer. Le token brut n'est JAMAIS stocke.
CREATE TABLE public.invitations (
    id          SERIAL PRIMARY KEY,
    token_hash  CHAR(64) NOT NULL UNIQUE,
    label       character varying(100),
    joueur_id   integer REFERENCES public.joueurs(id) ON DELETE SET NULL,
    max_uses    integer NOT NULL DEFAULT 1,
    uses        integer NOT NULL DEFAULT 0,
    expires_at  timestamp with time zone NOT NULL,
    revoked_at  timestamp with time zone,
    created_at  timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT invitations_uses_positifs CHECK (uses >= 0 AND max_uses >= 1)
);

CREATE INDEX idx_invitations_expires ON public.invitations(expires_at);

-- COMPTES -- la personne : miroir Discord, role, rattachement au joueur.
CREATE TABLE public.comptes (
    id                   SERIAL PRIMARY KEY,
    -- Snowflake Discord : TEXTE obligatoire, depasse 2^53 et se corrompt en JS.
    discord_id           character varying(32) NOT NULL UNIQUE,
    discord_username     character varying(64),
    discord_global_name  character varying(64),
    discord_avatar_hash  character varying(64),
    joueur_id            integer UNIQUE REFERENCES public.joueurs(id) ON DELETE SET NULL,
    statut               character varying(20) NOT NULL DEFAULT 'pending',
    -- Seule frontiere de privilege de l'application.
    role                 character varying(20) NOT NULL DEFAULT 'player',
    invitation_id        integer REFERENCES public.invitations(id) ON DELETE SET NULL,
    cgu_accepted_at      timestamp with time zone,
    cgu_version          character varying(20),
    -- Rafraichi a chaque connexion, sans effet sur le site.
    discord_synced_at    timestamp with time zone,
    -- Derniere propagation ADMIN du pseudo vers joueurs.nom (jamais automatique).
    profil_synced_at     timestamp with time zone,
    created_at           timestamp with time zone NOT NULL DEFAULT now(),
    updated_at           timestamp with time zone NOT NULL DEFAULT now(),
    last_login_at        timestamp with time zone,
    CONSTRAINT comptes_role_valide   CHECK (role   IN ('player', 'admin', 'superadmin')),
    CONSTRAINT comptes_statut_valide CHECK (statut IN ('pending', 'linked', 'rejected', 'suspended'))
);

CREATE INDEX idx_comptes_role ON public.comptes(role) WHERE role <> 'player';

-- LIAISONS_DEMANDES -- file d'attente du rattachement compte <-> joueur.
CREATE TABLE public.liaisons_demandes (
    id          SERIAL PRIMARY KEY,
    compte_id   integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    -- NULL = demande de CREATION : la fiche n'existe pas encore, son nom est
    -- dans nom_demande. La contrainte plus bas impose l'un ou l'autre.
    joueur_id   integer REFERENCES public.joueurs(id) ON DELETE CASCADE,
    nom_demande character varying(255),
    statut      character varying(20) NOT NULL DEFAULT 'pending',
    message     text,
    created_at  timestamp with time zone NOT NULL DEFAULT now(),
    decided_at  timestamp with time zone,
    decided_by  integer REFERENCES public.comptes(id) ON DELETE SET NULL,
    CONSTRAINT liaisons_statut_valide CHECK (statut IN ('pending', 'approved', 'rejected')),
    CONSTRAINT liaisons_cible_exclusive CHECK ((joueur_id IS NULL) <> (nom_demande IS NULL))
);

CREATE UNIQUE INDEX idx_liaison_pending_compte ON public.liaisons_demandes(compte_id) WHERE statut = 'pending';
CREATE UNIQUE INDEX idx_liaison_pending_joueur ON public.liaisons_demandes(joueur_id) WHERE statut = 'pending';

-- NOTIFICATIONS -- ce qu'un admin a decide sur le dos de quelqu'un.
-- Texte fige a l'emission : une notification parle souvent d'une chose qui
-- n'existe plus (la fiche supprimee, la demande refusee), et la reconstruire
-- par jointure afficherait « votre demande pour (null) ».
CREATE TABLE public.notifications (
    id          SERIAL PRIMARY KEY,
    compte_id   integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    type        character varying(40) NOT NULL,
    titre       character varying(160) NOT NULL,
    corps       text,
    created_at  timestamp with time zone NOT NULL DEFAULT now(),
    lu_at       timestamp with time zone
);
CREATE INDEX idx_notifications_non_lues ON public.notifications(compte_id) WHERE lu_at IS NULL;
CREATE INDEX idx_notifications_compte_date ON public.notifications(compte_id, created_at DESC);

-- PROFILS -- tout le contenu genere par l'utilisateur, purgeable d'un DELETE.
-- Pas d'avatar : il vient du CDN Discord via comptes.discord_avatar_hash.
CREATE TABLE public.profils (
    compte_id       integer PRIMARY KEY REFERENCES public.comptes(id) ON DELETE CASCADE,
    bio             character varying(500),
    banniere_path   character varying(255),
    couleur_accent  CHAR(7),
    reseaux         jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at      timestamp with time zone NOT NULL DEFAULT now()
);

-- SESSIONS_JOUEURS -- remplacante d'api_tokens : token stocke en sha256 seul,
-- et expiration ABSOLUE (aucune route de renouvellement).
CREATE TABLE public.sessions_joueurs (
    token_hash    CHAR(64) PRIMARY KEY,
    compte_id     integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    created_at    timestamp with time zone NOT NULL DEFAULT now(),
    expires_at    timestamp with time zone NOT NULL,
    last_seen_at  timestamp with time zone,
    -- Pas d'IP : user_agent suffit a un ecran "vos sessions actives".
    user_agent    character varying(255)
);

CREATE INDEX idx_sessions_joueurs_compte  ON public.sessions_joueurs(compte_id);
CREATE INDEX idx_sessions_joueurs_expires ON public.sessions_joueurs(expires_at);

-- AUDIT_ADMIN -- accountability RGPD (art. 5.2), changements de role et
-- synchronisations de profil.
CREATE TABLE public.audit_admin (
    id               SERIAL PRIMARY KEY,
    action           character varying(50) NOT NULL,
    acteur_compte_id integer REFERENCES public.comptes(id) ON DELETE SET NULL,
    cible_type       character varying(30),
    cible_id         integer,
    details          jsonb,
    created_at       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_admin_created ON public.audit_admin(created_at DESC);

-- NOMS_INTERDITS -- sha256(lower(nom)) des identites anonymisees, jamais le nom
-- en clair : empeche add_tournament de recreer a la volee une fiche portant un
-- nom qu'on vient tout juste d'effacer.
CREATE TABLE public.noms_interdits (
    nom_hash    CHAR(64) PRIMARY KEY,
    created_at  timestamp with time zone NOT NULL DEFAULT now()
);

-- SERVICE_TOKENS -- authentification machine des bots Discord.
CREATE TABLE public.service_tokens (
    id           SERIAL PRIMARY KEY,
    token_hash   CHAR(64) NOT NULL UNIQUE,
    nom          character varying(64) NOT NULL,
    scopes       text[] NOT NULL DEFAULT '{}',
    expires_at   timestamp with time zone,
    revoked_at   timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at   timestamp with time zone NOT NULL DEFAULT now()
);

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
