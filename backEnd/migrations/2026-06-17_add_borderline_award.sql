-- Ajoute le reward "Borderline" (joueur aux résultats les plus instables).
-- Idempotent : ON CONFLICT sur le code unique. À jouer sur une DB déjà initialisée
-- (schema.sql/seed.sql ne s'exécutent que sur un volume vierge).
--
--   make db-shell        # puis coller ce fichier
--   ou : docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < backEnd/migrations/2026-06-17_add_borderline_award.sql

INSERT INTO public.types_awards (code, nom, emoji, description) VALUES
    ('borderline', 'Borderline', 'borderline.png', 'Les résultats les plus instables')
ON CONFLICT (code) DO UPDATE
    SET nom = EXCLUDED.nom,
        emoji = EXCLUDED.emoji,
        description = EXCLUDED.description;
