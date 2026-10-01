-- Index du journal d'audit filtre par acteur puis trie par date.
CREATE INDEX IF NOT EXISTS idx_audit_admin_acteur
    ON public.audit_admin(acteur_compte_id, created_at DESC);

