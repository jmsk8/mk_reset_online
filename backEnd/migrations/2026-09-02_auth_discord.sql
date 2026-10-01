-- Authentification Discord et comptes joueurs. L'identite (comptes) est separee
-- du dossier sportif (joueurs). Tables en TIMESTAMPTZ.

BEGIN;

-- ---------------------------------------------------------------------------
-- invitations (seul le hash du token est stocke)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invitations (
    id          SERIAL PRIMARY KEY,
    token_hash  CHAR(64) NOT NULL UNIQUE, -- sha256(token) en hexadecimal
    label       VARCHAR(100),
    joueur_id   INTEGER REFERENCES public.joueurs(id) ON DELETE SET NULL,
    max_uses    INTEGER NOT NULL DEFAULT 1,
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT invitations_uses_positifs CHECK (uses >= 0 AND max_uses >= 1)
);

CREATE INDEX IF NOT EXISTS idx_invitations_expires ON public.invitations(expires_at);

COMMENT ON COLUMN public.invitations.joueur_id IS
    'Renseigne = invitation nominative (liaison pre-remplie). NULL = lien generique.';

-- ---------------------------------------------------------------------------
-- comptes : miroir Discord, role, rattachement au joueur
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comptes (
    id                   SERIAL PRIMARY KEY,
    discord_id           VARCHAR(32) NOT NULL UNIQUE,
    discord_username     VARCHAR(64),
    discord_global_name  VARCHAR(64),
    discord_avatar_hash  VARCHAR(64),
    joueur_id            INTEGER UNIQUE REFERENCES public.joueurs(id) ON DELETE SET NULL,
    statut               VARCHAR(20) NOT NULL DEFAULT 'pending',
    role                 VARCHAR(20) NOT NULL DEFAULT 'player',
    invitation_id        INTEGER REFERENCES public.invitations(id) ON DELETE SET NULL,
    cgu_accepted_at      TIMESTAMPTZ,
    cgu_version          VARCHAR(20),
    discord_synced_at    TIMESTAMPTZ,
    profil_synced_at     TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at        TIMESTAMPTZ,
    CONSTRAINT comptes_role_valide   CHECK (role   IN ('player', 'admin', 'superadmin')),
    CONSTRAINT comptes_statut_valide CHECK (statut IN ('pending', 'linked', 'rejected', 'suspended'))
);

-- Index partiel sur les comptes privilegies.
CREATE INDEX IF NOT EXISTS idx_comptes_role ON public.comptes(role) WHERE role <> 'player';

COMMENT ON COLUMN public.comptes.discord_id IS
    'Snowflake Discord, stocke en TEXTE : depasse 2^53 et se corrompt en entier JS.';
COMMENT ON COLUMN public.comptes.role IS
    'Seule frontiere de privilege de l''application. Ecrite par une unique route superadmin.';
COMMENT ON COLUMN public.comptes.discord_synced_at IS
    'Dernier rafraichissement du miroir Discord (a chaque connexion). Sans effet sur le site.';
COMMENT ON COLUMN public.comptes.profil_synced_at IS
    'Derniere propagation ADMIN du pseudo Discord vers joueurs.nom. Geste explicite, jamais automatique.';

-- ---------------------------------------------------------------------------
-- liaisons_demandes : demandes de rattachement compte <-> joueur
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.liaisons_demandes (
    id          SERIAL PRIMARY KEY,
    compte_id   INTEGER NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    joueur_id   INTEGER NOT NULL REFERENCES public.joueurs(id) ON DELETE CASCADE,
    statut      VARCHAR(20) NOT NULL DEFAULT 'pending',
    message     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at  TIMESTAMPTZ,
    decided_by  INTEGER REFERENCES public.comptes(id) ON DELETE SET NULL,
    CONSTRAINT liaisons_statut_valide CHECK (statut IN ('pending', 'approved', 'rejected'))
);

-- Une seule demande en cours par compte et par joueur.
CREATE UNIQUE INDEX IF NOT EXISTS idx_liaison_pending_compte
    ON public.liaisons_demandes(compte_id) WHERE statut = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_liaison_pending_joueur
    ON public.liaisons_demandes(joueur_id) WHERE statut = 'pending';

-- ---------------------------------------------------------------------------
-- profils : contenu saisi par l'utilisateur (l'avatar vient de Discord)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profils (
    compte_id       INTEGER PRIMARY KEY REFERENCES public.comptes(id) ON DELETE CASCADE,
    bio             VARCHAR(500),
    banniere_path   VARCHAR(255),
    couleur_accent  CHAR(7),
    reseaux         JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- sessions_joueurs : token en sha256, expiration absolue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sessions_joueurs (
    token_hash    CHAR(64) PRIMARY KEY,
    compte_id     INTEGER NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    last_seen_at  TIMESTAMPTZ,
    user_agent    VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_sessions_joueurs_compte  ON public.sessions_joueurs(compte_id);
CREATE INDEX IF NOT EXISTS idx_sessions_joueurs_expires ON public.sessions_joueurs(expires_at);

-- ---------------------------------------------------------------------------
-- audit_admin : journal des actions d'administration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_admin (
    id               SERIAL PRIMARY KEY,
    action           VARCHAR(50) NOT NULL,
    acteur_compte_id INTEGER REFERENCES public.comptes(id) ON DELETE SET NULL,
    cible_type       VARCHAR(30),
    cible_id         INTEGER,
    details          JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_admin_created ON public.audit_admin(created_at DESC);

COMMENT ON COLUMN public.audit_admin.details IS
    'Contient l''avant/apres pour les gestes reversibles (renommage, changement de role).';

-- ---------------------------------------------------------------------------
-- service_tokens : jetons des bots Discord
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.service_tokens (
    id           SERIAL PRIMARY KEY,
    token_hash   CHAR(64) NOT NULL UNIQUE,
    nom          VARCHAR(64) NOT NULL,
    scopes       TEXT[] NOT NULL DEFAULT '{}',
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- joueurs.anonymise_at : marque une fiche anonymisee
-- ---------------------------------------------------------------------------
ALTER TABLE public.joueurs ADD COLUMN IF NOT EXISTS anonymise_at TIMESTAMPTZ;

COMMIT;
