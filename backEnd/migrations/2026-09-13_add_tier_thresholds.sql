-- Seuils de tiers S/A/B reglables (score = mean + k*stdev). Valeurs par defaut
-- identiques au comportement precedent.
INSERT INTO public.configuration (key, value) VALUES
    ('tier_k_s', '1.0'),
    ('tier_k_a', '0.0'),
    ('tier_k_b', '-1.0')
ON CONFLICT (key) DO NOTHING;
