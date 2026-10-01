-- Suppression de la table de l'ancienne authentification par mot de passe,
-- remplacee par sessions_joueurs. Retour arriere : 2026-09-23_restore_api_tokens.sql.

DROP TABLE IF EXISTS public.api_tokens;
