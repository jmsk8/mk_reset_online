-- Historique des consentements : une ligne par acceptation, jamais reecrite.
--
-- Pourquoi (lot F de docs/audit-securite-2026-09-24.md, decide le 25/09) :
-- comptes.cgu_accepted_at / cgu_version et leurs pendants cgu_admin_* ne gardent
-- que la DERNIERE acceptation. Le jour ou la politique passe en 1.1, la nouvelle
-- acceptation ecrase l'ancienne, et on perd la preuve que la personne avait
-- accepte la 1.0 -- or c'est sous la 1.0 que ses donnees ont ete traitees
-- jusque-la. Le RGPD demande de pouvoir DEMONTRER un consentement (art. 7.1),
-- pas seulement d'affirmer qu'il existe aujourd'hui.
--
-- Les colonnes de `comptes` restent : elles disent l'etat COURANT, que le
-- decorateur relit a chaque requete pour savoir s'il faut renvoyer vers
-- /consentement. Cette table dit l'HISTOIRE. Les deux s'ecrivent dans la meme
-- transaction (routes_comptes._enregistrer_consentement).
--
-- A la suppression du compte, l'historique part avec lui (decision du 25/09) :
-- plus de traitement, donc plus rien a justifier, et garder la trace serait
-- conserver une donnee personnelle sans raison. La suppression elle-meme reste
-- tracee dans audit_admin, par l'empreinte du snowflake.

CREATE TABLE IF NOT EXISTS public.consentements (
    id          SERIAL PRIMARY KEY,
    -- CASCADE, et effacement explicite dans _effacer_compte : c'est le code qui
    -- decide de ce qui disparait, la contrainte en est le filet.
    compte_id   integer NOT NULL REFERENCES public.comptes(id) ON DELETE CASCADE,
    -- 'cgu' : la politique de tout compte ; 'cgu_admin' : la politique « en
    -- tant qu'administrateur », consentement distinct (migration du 18/09).
    politique   character varying(20) NOT NULL,
    version     character varying(20) NOT NULL,
    accepte_le  timestamp with time zone NOT NULL DEFAULT now(),
    -- Le GESTE qui a produit l'acceptation. Sans lui, une ligne dit « accepte »
    -- sans dire comment -- exactement ce que S-06 reprochait au lien cgu=1.
    origine     character varying(30) NOT NULL,

    CONSTRAINT consentements_politique_valide
        CHECK (politique IN ('cgu', 'cgu_admin')),
    CONSTRAINT consentements_origine_valide
        CHECK (origine IN (
            'page_consentement',        -- POST /me/cgu, bouton de /consentement
            'acceptation_promotion',    -- accepter un role admin (POST /me/promotion)
            'regularisation_admin',     -- admin deja en poste (POST /me/cgu-admin)
            'reprise_migration'         -- acceptation anterieure a cette table
        ))
);

ALTER TABLE public.consentements OWNER TO CURRENT_USER;

-- Lecture type : l'historique d'un compte, dans l'ordre (export, /mon-compte).
CREATE INDEX IF NOT EXISTS idx_consentements_compte
    ON public.consentements(compte_id, accepte_le);

-- ---------------------------------------------------------------------------
-- Ajout seul : une preuve qu'on peut reecrire ne prouve rien
-- ---------------------------------------------------------------------------
-- DELETE reste permis : c'est le chemin de l'effacement (CASCADE, et
-- _effacer_compte). UPDATE ne l'est jamais -- corriger une date ou une version
-- apres coup, c'est fabriquer un consentement.
CREATE OR REPLACE FUNCTION public.consentements_sans_modification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'consentements est en ajout seul : une acceptation ne se modifie pas.'
        USING HINT = 'Inserer une nouvelle ligne pour une nouvelle acceptation.';
END;
$$;

DROP TRIGGER IF EXISTS consentements_ajout_seul ON public.consentements;
CREATE TRIGGER consentements_ajout_seul
    BEFORE UPDATE ON public.consentements
    FOR EACH ROW EXECUTE FUNCTION public.consentements_sans_modification();

-- ---------------------------------------------------------------------------
-- Reprise des acceptations existantes
-- ---------------------------------------------------------------------------
-- Une seule ligne par compte et par politique : la derniere acceptation, seule
-- connue. Les precedentes ont ete ecrasees avant cette table, rien ne permet
-- de les reconstituer -- d'ou l'origine 'reprise_migration', qui le dit.
-- Idempotente : rejouer la migration n'ajoute rien.
INSERT INTO public.consentements (compte_id, politique, version, accepte_le, origine)
SELECT c.id, 'cgu', c.cgu_version, c.cgu_accepted_at, 'reprise_migration'
FROM public.comptes c
WHERE c.cgu_accepted_at IS NOT NULL AND c.cgu_version IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.consentements x
      WHERE x.compte_id = c.id AND x.politique = 'cgu'
        AND x.version = c.cgu_version AND x.accepte_le = c.cgu_accepted_at);

INSERT INTO public.consentements (compte_id, politique, version, accepte_le, origine)
SELECT c.id, 'cgu_admin', c.cgu_admin_version, c.cgu_admin_accepted_at, 'reprise_migration'
FROM public.comptes c
WHERE c.cgu_admin_accepted_at IS NOT NULL AND c.cgu_admin_version IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.consentements x
      WHERE x.compte_id = c.id AND x.politique = 'cgu_admin'
        AND x.version = c.cgu_admin_version AND x.accepte_le = c.cgu_admin_accepted_at);
