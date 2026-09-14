-- Seuils de tiers S/A/B reglables en admin (page Reglages TrueSkill).
-- Exprimes en multiples d'ecart-type autour de la moyenne des scores
-- ranked : score = mean + k*stdev. Valeurs par defaut = comportement
-- historique de tier_for_score (mean+stdev / mean / mean-stdev), donc ce
-- changement ne modifie aucun tier tant que personne ne touche au reglage.
-- Voir services.py (tier_for_score, tier_thresholds, recalculate_tiers).
INSERT INTO public.configuration (key, value) VALUES
    ('tier_k_s', '1.0'),
    ('tier_k_a', '0.0'),
    ('tier_k_b', '-1.0')
ON CONFLICT (key) DO NOTHING;
