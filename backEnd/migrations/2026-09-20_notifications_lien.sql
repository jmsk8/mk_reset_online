-- Une notification devient cliquable : elle mene a ce dont elle parle.
--
-- Le lien est FIGE a l'emission, exactement comme le titre et le corps le sont
-- deja. C'est la meme regle, pour la meme raison : reconstruire l'URL a
-- l'affichage depuis un couple (type, entite_id) supposerait que l'entite
-- existe encore. Elle n'existe souvent plus -- c'est meme le sujet de la
-- notification dans le cas de `fiche_supprimee`.
--
-- Stocker l'URL construite plutot que l'identifiant evite aussi de dupliquer
-- cote JS une table de correspondance type -> route, qui divergerait des
-- routes reelles au premier renommage.
--
-- NULL est un etat normal et durable : les notifications emises avant cette
-- migration n'ont pas de lien, et deux types n'en auront jamais
-- (`promotion_acceptee` et `promotion_refusee` sont des accuses de reception
-- adresses au proposant -- il n'y a aucune action a mener dessus).

BEGIN;

ALTER TABLE public.notifications
    ADD COLUMN IF NOT EXISTS lien character varying(255);

COMMENT ON COLUMN public.notifications.lien IS
    'URL interne figee a l''emission. NULL quand la notification n''appelle '
    'aucune action, ou qu''elle precede cette colonne.';

COMMIT;
