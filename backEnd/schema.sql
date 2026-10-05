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
DROP TABLE IF EXISTS public.promotions_proposees CASCADE;
DROP TABLE IF EXISTS public.liaisons_demandes CASCADE;
DROP TABLE IF EXISTS public.comptes CASCADE;
DROP TABLE IF EXISTS public.invitations CASCADE;
DROP TABLE IF EXISTS public.ghost_log CASCADE;
DROP TABLE IF EXISTS public.awards_obtenus CASCADE;
DROP TABLE IF EXISTS public.participations CASCADE;
DROP TABLE IF EXISTS public.tournois CASCADE;
DROP TABLE IF EXISTS public.sessions_tournois CASCADE;
DROP TABLE IF EXISTS public.joueurs CASCADE;
DROP TABLE IF EXISTS public.configuration CASCADE;
DROP TABLE IF EXISTS public.saisons CASCADE;
DROP TABLE IF EXISTS public.types_awards CASCADE;
-- Table supprimee, encore presente sur les anciennes bases.
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
('ghost_threshold_sessions', '4'),
('ghost_interval_sessions', '1'),
('unranked_threshold', '10'),
('sigma_threshold', '4.0'),
('league_mode_enabled', 'false'),
('inter_league_moves', '0'),
('ip_version_live', 'v1');

-- TIERS : nom, couleur du badge et de son texte, seuil en ecart-type, rang
-- (decroissant du meilleur au pire). seuil_k NULL uniquement pour le plancher.
-- 'U' n'est pas un tier.
CREATE TABLE public.tiers (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(10) NOT NULL,
    couleur VARCHAR(20) NOT NULL,
    couleur_texte VARCHAR(20) NOT NULL DEFAULT '#FFFFFF',
    seuil_k DOUBLE PRECISION,
    rang INTEGER NOT NULL UNIQUE
);
ALTER TABLE public.tiers OWNER TO CURRENT_USER;

INSERT INTO public.tiers (nom, couleur, seuil_k, rang) VALUES
('S', '#f77b7b', 1.0, 3),
('A', '#9cda74', 0.0, 2),
('B', '#7fe6ee', -1.0, 1),
('C', '#ae6ce4', NULL, 0);

-- LIGUES
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
    tier character varying(10) DEFAULT 'U',
    consecutive_missed integer DEFAULT 0,
    is_ranked boolean DEFAULT true,
    color character varying(7) DEFAULT '#FFFFFF',
    ligue_id INTEGER REFERENCES public.ligues(id) ON DELETE SET NULL,
    -- Fiche anonymisee.
    anonymise_at timestamp with time zone
);
ALTER TABLE public.joueurs OWNER TO CURRENT_USER;

CREATE SEQUENCE public.joueurs_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.joueurs_id_seq OWNED BY public.joueurs.id;
ALTER TABLE ONLY public.joueurs ALTER COLUMN id SET DEFAULT nextval('public.joueurs_id_seq'::regclass);

-- SESSIONS DE TOURNOIS
-- Regroupe un ou plusieurs tournois joues ensemble (lobbies simultanes) ; un
-- tournoi seul forme sa propre session.
CREATE TABLE public.sessions_tournois (
    id integer NOT NULL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.sessions_tournois OWNER TO CURRENT_USER;

CREATE SEQUENCE public.sessions_tournois_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.sessions_tournois_id_seq OWNED BY public.sessions_tournois.id;
ALTER TABLE ONLY public.sessions_tournois ALTER COLUMN id SET DEFAULT nextval('public.sessions_tournois_id_seq'::regclass);

-- TOURNOIS
-- TOURNOIS (ligue_nom / ligue_couleur : archive de la ligue au moment du tournoi)
CREATE TABLE public.tournois (
    id integer NOT NULL PRIMARY KEY,
    date date NOT NULL,
    ligue_id INTEGER REFERENCES public.ligues(id) ON DELETE SET NULL,
    ligue_nom character varying(100),
    ligue_couleur character varying(20),
    session_id INTEGER NOT NULL REFERENCES public.sessions_tournois(id) ON DELETE SET NULL
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

-- GRILLE FIGEE : etat des joueurs avant le premier tournoi du jour, reference
-- de l'IP v2 pour tous les tournois de la journee.
CREATE TABLE public.grille_snapshots (
    date date NOT NULL,
    joueur_id integer NOT NULL REFERENCES public.joueurs(id) ON DELETE CASCADE,
    mu double precision NOT NULL,
    sigma double precision NOT NULL,
    is_ranked boolean NOT NULL DEFAULT true,
    tier character varying(10) NOT NULL DEFAULT 'U',
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
    -- NULL : reset anterieur au plafond.
    max_sigma REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.global_resets OWNER TO CURRENT_USER;

-- Detail par joueur d'un reset global (utilise pour l'annulation).
CREATE TABLE public.global_reset_details (
    id SERIAL PRIMARY KEY,
    reset_id INTEGER NOT NULL REFERENCES public.global_resets(id) ON DELETE CASCADE,
    joueur_id INTEGER NOT NULL REFERENCES public.joueurs(id) ON DELETE CASCADE,
    old_sigma DOUBLE PRECISION NOT NULL,
    new_sigma DOUBLE PRECISION NOT NULL,
    delta_applied DOUBLE PRECISION NOT NULL
);
ALTER TABLE public.global_reset_details OWNER TO CURRENT_USER;
CREATE INDEX idx_global_reset_details_reset
    ON public.global_reset_details(reset_id);

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

-- MOUVEMENTS INTER-LIGUES
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
-- Identite (comptes, profils, sessions) separee du dossier sportif (joueurs).
-- Ces tables sont en TIMESTAMPTZ, contrairement au reste du schema.
-- ===========================================================================

-- INVITATIONS (seul le hash du token est stocke)
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

-- COMPTES
CREATE TABLE public.comptes (
    id                   SERIAL PRIMARY KEY,
    -- Snowflake en texte (depasse 2^53).
    discord_id           character varying(32) NOT NULL UNIQUE,
    discord_username     character varying(64),
    discord_global_name  character varying(64),
    discord_avatar_hash  character varying(64),
    joueur_id            integer UNIQUE REFERENCES public.joueurs(id) ON DELETE SET NULL,
    statut               character varying(20) NOT NULL DEFAULT 'pending',
    role                 character varying(20) NOT NULL DEFAULT 'player',
    invitation_id        integer REFERENCES public.invitations(id) ON DELETE SET NULL,
    cgu_accepted_at      timestamp with time zone,
    cgu_version          character varying(20),
    -- Consentement a la politique admin, distinct des CGU joueur.
    cgu_admin_accepted_at timestamp with time zone,
    cgu_admin_version     character varying(20),
    discord_synced_at    timestamp with time zone,
    -- Derniere propagation du pseudo vers joueurs.nom par un admin.
    profil_synced_at     timestamp with time zone,
    created_at           timestamp with time zone NOT NULL DEFAULT now(),
    updated_at           timestamp with time zone NOT NULL DEFAULT now(),
    last_login_at        timestamp with time zone,
    CONSTRAINT comptes_role_valide   CHECK (role   IN ('player', 'admin', 'chef_admin', 'superadmin')),
    CONSTRAINT comptes_statut_valide CHECK (statut IN ('pending', 'linked', 'rejected', 'suspended'))
);

CREATE INDEX idx_comptes_role ON public.comptes(role) WHERE role <> 'player';

-- Un seul superadmin. Index partiel non differable : le legs retrograde
-- l'ancien avant de promouvoir le nouveau.
CREATE UNIQUE INDEX idx_comptes_superadmin_unique
    ON public.comptes (role)
    WHERE role = 'superadmin';

-- PERMISSIONS_ADMIN : droits accordes un par un a un compte role=admin.
CREATE TABLE public.permissions_admin (
    id          SERIAL PRIMARY KEY,
    compte_id   integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    permission  character varying(50) NOT NULL,
    accorde_par integer REFERENCES public.comptes(id) ON DELETE SET NULL,
    created_at  timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT permissions_admin_unique UNIQUE (compte_id, permission)
);

CREATE INDEX idx_permissions_admin_compte ON public.permissions_admin(compte_id);

-- LIAISONS_DEMANDES : demandes de rattachement compte <-> joueur
CREATE TABLE public.liaisons_demandes (
    id          SERIAL PRIMARY KEY,
    compte_id   integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    -- NULL : demande de creation (nom dans nom_demande).
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

-- PROMOTIONS PROPOSEES : le role est pose a l'acceptation par la personne.
CREATE TABLE public.promotions_proposees (
    id           SERIAL PRIMARY KEY,
    compte_id    integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    role_propose character varying(20) NOT NULL,
    -- SET NULL : l'historique survit au proposant.
    propose_par  integer REFERENCES public.comptes(id) ON DELETE SET NULL,
    statut       character varying(20) NOT NULL DEFAULT 'pending',
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    expires_at   timestamp with time zone NOT NULL,
    decided_at   timestamp with time zone,
    -- superadmin se legue ; player est une retrogradation.
    CONSTRAINT promotions_role_valide
        CHECK (role_propose IN ('admin', 'chef_admin')),
    CONSTRAINT promotions_statut_valide
        CHECK (statut IN ('pending', 'accepted', 'refused', 'cancelled'))
);
ALTER TABLE public.promotions_proposees OWNER TO CURRENT_USER;

-- Une seule proposition en attente par compte.
CREATE UNIQUE INDEX idx_promotion_pending_compte
    ON public.promotions_proposees(compte_id) WHERE statut = 'pending';
CREATE INDEX idx_promotion_compte_statut
    ON public.promotions_proposees(compte_id, statut);

-- CONSENTEMENTS : historique des acceptations (ajout seul), efface avec le compte.
CREATE TABLE public.consentements (
    id          SERIAL PRIMARY KEY,
    compte_id   integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    politique   character varying(20) NOT NULL,
    version     character varying(20) NOT NULL,
    accepte_le  timestamp with time zone NOT NULL DEFAULT now(),
    origine     character varying(30) NOT NULL,
    CONSTRAINT consentements_politique_valide
        CHECK (politique IN ('cgu', 'cgu_admin')),
    CONSTRAINT consentements_origine_valide
        CHECK (origine IN ('page_consentement', 'acceptation_promotion',
                           'regularisation_admin', 'reprise_migration'))
);
ALTER TABLE public.consentements OWNER TO CURRENT_USER;
CREATE INDEX idx_consentements_compte
    ON public.consentements(compte_id, accepte_le);

-- Ajout seul ; DELETE permis pour l'effacement du compte.
CREATE FUNCTION public.consentements_sans_modification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'consentements est en ajout seul : une acceptation ne se modifie pas.'
        USING HINT = 'Inserer une nouvelle ligne pour une nouvelle acceptation.';
END;
$$;
CREATE TRIGGER consentements_ajout_seul
    BEFORE UPDATE ON public.consentements
    FOR EACH ROW EXECUTE FUNCTION public.consentements_sans_modification();

-- NOTIFICATIONS (texte et lien figes a l'emission)
CREATE TABLE public.notifications (
    id          SERIAL PRIMARY KEY,
    compte_id   integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    type        character varying(40) NOT NULL,
    titre       character varying(160) NOT NULL,
    corps       text,
    -- NULL si la notification n'appelle aucune action.
    lien        character varying(255),
    created_at  timestamp with time zone NOT NULL DEFAULT now(),
    lu_at       timestamp with time zone
);
CREATE INDEX idx_notifications_non_lues ON public.notifications(compte_id) WHERE lu_at IS NULL;
CREATE INDEX idx_notifications_compte_date ON public.notifications(compte_id, created_at DESC);

-- PROFILS (contenu saisi par l'utilisateur ; l'avatar vient de Discord)
CREATE TABLE public.profils (
    compte_id       integer PRIMARY KEY REFERENCES public.comptes(id) ON DELETE CASCADE,
    bio             character varying(500),
    banniere_path   character varying(255),
    couleur_accent  CHAR(7),
    reseaux         jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at      timestamp with time zone NOT NULL DEFAULT now()
);

-- SESSIONS_JOUEURS : token en sha256, expiration absolue.
CREATE TABLE public.sessions_joueurs (
    token_hash    CHAR(64) PRIMARY KEY,
    compte_id     integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    created_at    timestamp with time zone NOT NULL DEFAULT now(),
    expires_at    timestamp with time zone NOT NULL,
    last_seen_at  timestamp with time zone,
    user_agent    character varying(255)
);

CREATE INDEX idx_sessions_joueurs_compte  ON public.sessions_joueurs(compte_id);
CREATE INDEX idx_sessions_joueurs_expires ON public.sessions_joueurs(expires_at);

-- AUDIT_ADMIN : journal des actions d'administration.
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
-- Filtre par acteur puis tri par date.
CREATE INDEX idx_audit_admin_acteur ON public.audit_admin(acteur_compte_id, created_at DESC);

-- NOMS_INTERDITS : sha256(lower(nom)) des identites anonymisees.
CREATE TABLE public.noms_interdits (
    nom_hash    CHAR(64) PRIMARY KEY,
    created_at  timestamp with time zone NOT NULL DEFAULT now()
);

-- SERVICE_TOKENS : jetons des bots Discord.
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

-- INDEX
CREATE INDEX idx_participations_joueur_id ON public.participations(joueur_id);
CREATE INDEX idx_participations_tournoi_id ON public.participations(tournoi_id);
CREATE INDEX idx_joueurs_ligue_id ON public.joueurs(ligue_id);
CREATE INDEX idx_tournois_date ON public.tournois(date);
CREATE INDEX idx_tournois_session ON public.tournois(session_id);
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
