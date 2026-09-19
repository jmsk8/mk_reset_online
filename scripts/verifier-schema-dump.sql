-- Controle final du chemin `make redump` : le dump a-t-il bien ete rattrape ?
--
-- Monte en 99_ par docker-compose.dump.yml, donc execute APRES le dump et
-- toutes les migrations. Son seul role est d'ECHOUER BRUYAMMENT quand le
-- schema obtenu n'est pas celui que le code attend.
--
-- Pourquoi ce fichier existe : les scripts de /docker-entrypoint-initdb.d
-- s'executent une fois, au premier demarrage, et leurs erreurs se noient dans
-- les logs du conteneur. Une migration qui echoue laisse donc une base a
-- moitie migree sur laquelle le conteneur demarre normalement -- le defaut se
-- decouvre bien plus tard, en naviguant, sur un 500 qui ne pointe pas vers la
-- base. Postgres interrompt l'initialisation quand un script d'init sort en
-- erreur : c'est ce que provoque le RAISE ci-dessous.
--
-- Ce fichier n'est PAS une migration : il ne cree rien et ne modifie rien.
-- Il ne va donc pas dans backEnd/migrations/.
DO $$
DECLARE
    -- Les tables que le code exige et qu'un dump de production ne porte pas
    -- encore (aucune migration n'a ete appliquee en prod). Tenir cette liste a
    -- jour en meme temps que docker-compose.dump.yml.
    attendues TEXT[] := ARRAY[
        'audit_admin', 'comptes', 'global_reset_details', 'invitations',
        'liaisons_demandes', 'noms_interdits', 'notifications',
        'permissions_admin', 'profils', 'promotions_proposees', 'service_tokens',
        'sessions_joueurs', 'sessions_tournois', 'tiers'
    ];
    manquantes TEXT[];
BEGIN
    SELECT array_agg(t ORDER BY t) INTO manquantes
    FROM unnest(attendues) AS t
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = t
    );

    IF manquantes IS NOT NULL THEN
        RAISE EXCEPTION
            'Rattrapage de schema incomplet. Tables absentes : %', array_to_string(manquantes, ', ')
            USING HINT = 'Une migration de docker-compose.dump.yml a echoue. '
                         'Cherche la premiere erreur dans « make logs-db ».';
    END IF;

    -- Colonne ajoutee par auth_discord sur une table PREEXISTANTE. C'est le cas
    -- ou un echec passerait le plus facilement inapercu : la table joueurs
    -- existe de toute facon, seule la colonne manquerait.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'joueurs' AND column_name = 'anonymise_at'
    ) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : joueurs.anonymise_at absente.'
            USING HINT = '2026-09-02_auth_discord.sql n''a pas abouti.';
    END IF;

    -- Les tiers pilotent l'affichage du classement. Une table creee mais vide
    -- donnerait un classement sans aucun tier, sans erreur nulle part.
    IF (SELECT count(*) FROM public.tiers) = 0 THEN
        RAISE EXCEPTION 'Rattrapage incomplet : la table tiers est vide.'
            USING HINT = 'Le seed par defaut de 2026-09-13_add_tiers_table.sql n''a pas eu lieu.';
    END IF;

    -- Colonne ajoutee sur une table PREEXISTANTE, comme joueurs.anonymise_at :
    -- meme mode d'echec discret, la table tournois existe de toute facon.
    -- Le NOT NULL est l'invariant sur lequel s'appuie tout le calcul de session.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tournois' AND column_name = 'session_id'
    ) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : tournois.session_id absente.'
            USING HINT = '2026-09-15_sessions_tournois.sql n''a pas abouti.';
    END IF;

    -- Backfill incomplet : la colonne existe mais des tournois n'ont pas de
    -- session. Le SET NOT NULL de la migration aurait du l'empecher ; si on
    -- arrive ici, c'est que la colonne a ete creee sans que le backfill passe.
    IF EXISTS (SELECT 1 FROM public.tournois WHERE session_id IS NULL) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : % tournoi(s) sans session.',
            (SELECT count(*) FROM public.tournois WHERE session_id IS NULL)
            USING HINT = 'Relancer 2026-09-15_sessions_tournois.sql, puis diagnostiquer avec '
                         'SELECT id, date, ligue_id FROM tournois WHERE session_id IS NULL;';
    END IF;

    -- Colonne ajoutee sur une table PREEXISTANTE : global_resets existe de
    -- toute facon, seul le plafond manquerait. Un reset partirait alors en
    -- erreur a chaque tentative, sans que rien n'ait signale l'echec ici.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'global_resets' AND column_name = 'max_sigma'
    ) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : global_resets.max_sigma absente.'
            USING HINT = '2026-09-17_reset_global_plafond.sql n''a pas abouti.';
    END IF;

    -- Colonnes ajoutees sur une table PREEXISTANTE : `comptes` existe de toute
    -- facon, seul le consentement admin manquerait. L'ecran d'acceptation
    -- tomberait alors en 500 a chaque connexion d'un admin, sans que rien
    -- n'ait signale l'echec ici.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'comptes' AND column_name = 'cgu_admin_accepted_at'
    ) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : comptes.cgu_admin_accepted_at absente.'
            USING HINT = '2026-09-18_promotions_proposees.sql n''a pas abouti.';
    END IF;

    RAISE NOTICE 'Schema verifie : les % tables attendues sont presentes.', array_length(attendues, 1);
END
$$;
