-- Index sur l'acteur du journal d'audit -- phase 3 (ecran de consultation).
--
-- `audit_admin` n'avait qu'un index sur `created_at`. Or tout l'ecran de la
-- phase 3 filtre sur l'ACTEUR : « les actions de ce compte, les plus recentes
-- d'abord ». Sans index, chaque ouverture du volet « Logs » balaie la table
-- entiere -- imperceptible sur 16 lignes, ruineux sur un journal qui ne se
-- purge jamais (conservation sans limite, §4 du plan).
--
-- COMPOSITE et dans cet ordre : `acteur_compte_id` d'abord pour la selection,
-- `created_at DESC` ensuite pour que le tri soit deja fait. Un index sur le
-- seul `acteur_compte_id` obligerait a trier le resultat a chaque page.
CREATE INDEX IF NOT EXISTS idx_audit_admin_acteur
    ON public.audit_admin(acteur_compte_id, created_at DESC);

-- L'onglet « Logs » lit le journal COMPLET, sans filtre d'acteur, avec la meme
-- pagination par curseur. `idx_audit_admin_created` (deja present depuis la
-- creation de la table) sert ce cas-la : rien a ajouter.
--
-- Pas d'index sur `action` : la volumetrie ne le justifie pas encore, et un
-- index qu'aucune requete n'emprunte coute a chaque ecriture. A reconsiderer
-- le jour ou le filtre par action devient lent -- pas avant.
