-- Controle final de `make redump` : le schema obtenu est-il celui du code ?
--
-- Monte en 99_ par docker-compose.dump.yml, donc execute apres le dump et les
-- migrations. Une erreur ici interrompt l'initialisation de Postgres au lieu de
-- laisser demarrer une base a moitie migree. Ne cree ni ne modifie rien.
DO $$
DECLARE
    -- Tables absentes d'un dump de production, a tenir a jour avec
    -- docker-compose.dump.yml.
    attendues TEXT[] := ARRAY[
        'audit_admin', 'comptes', 'consentements', 'global_reset_details', 'invitations',
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

    -- Colonne ajoutee par auth_discord a une table existante.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'joueurs' AND column_name = 'anonymise_at'
    ) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : joueurs.anonymise_at absente.'
            USING HINT = '2026-09-02_auth_discord.sql n''a pas abouti.';
    END IF;

    -- Une table tiers vide donnerait un classement sans tier.
    IF (SELECT count(*) FROM public.tiers) = 0 THEN
        RAISE EXCEPTION 'Rattrapage incomplet : la table tiers est vide.'
            USING HINT = 'Le seed par defaut de 2026-09-13_add_tiers_table.sql n''a pas eu lieu.';
    END IF;

    -- Colonne ajoutee a une table existante ; le calcul de session suppose
    -- NOT NULL.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tournois' AND column_name = 'session_id'
    ) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : tournois.session_id absente.'
            USING HINT = '2026-09-15_sessions_tournois.sql n''a pas abouti.';
    END IF;

    -- Colonne creee sans backfill.
    IF EXISTS (SELECT 1 FROM public.tournois WHERE session_id IS NULL) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : % tournoi(s) sans session.',
            (SELECT count(*) FROM public.tournois WHERE session_id IS NULL)
            USING HINT = 'Relancer 2026-09-15_sessions_tournois.sql, puis diagnostiquer avec '
                         'SELECT id, date, ligue_id FROM tournois WHERE session_id IS NULL;';
    END IF;

    -- Colonne ajoutee a une table existante (sans elle, tout reset echoue).
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'global_resets' AND column_name = 'max_sigma'
    ) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : global_resets.max_sigma absente.'
            USING HINT = '2026-09-17_reset_global_plafond.sql n''a pas abouti.';
    END IF;

    -- Colonnes ajoutees a une table existante (sans elles, l'ecran
    -- d'acceptation admin tombe en 500).
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'comptes' AND column_name = 'cgu_admin_accepted_at'
    ) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : comptes.cgu_admin_accepted_at absente.'
            USING HINT = '2026-09-18_promotions_proposees.sql n''a pas abouti.';
    END IF;

    -- Colonne ajoutee a une table existante (sans elle, l'approbation d'une
    -- liaison tombe en 500).
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notifications' AND column_name = 'lien'
    ) THEN
        RAISE EXCEPTION 'Rattrapage incomplet : notifications.lien absente.'
            USING HINT = '2026-09-20_notifications_lien.sql n''a pas abouti.';
    END IF;

    RAISE NOTICE 'Schema verifie : les % tables attendues sont presentes.', array_length(attendues, 1);
END
$$;
