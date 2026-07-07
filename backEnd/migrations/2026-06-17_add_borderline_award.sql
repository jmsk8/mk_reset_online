INSERT INTO public.types_awards (code, nom, emoji, description) VALUES
    ('borderline', 'Instable', 'award/borderline.png', 'Les résultats les plus instables')
ON CONFLICT (code) DO UPDATE
    SET nom = EXCLUDED.nom,
        emoji = EXCLUDED.emoji,
        description = EXCLUDED.description;
