-- Donnees DEJA en base qui violent les regles posees le 25/09 (lot A de
-- docs/audit-securite-2026-09-24.md : S-05, S-10, couleurs).
--
-- Les nouvelles regles ne s'appliquent qu'aux ECRITURES a venir : ce qui est
-- entre avant reste en place, et une fiche au sigma NaN continue d'empoisonner
-- chaque tournoi ou elle apparait. Ce fichier le montre, il ne corrige rien.
-- Chaque requete doit revenir VIDE ; une ligne est a regarder a la main.
--
-- Lecture seule. A lancer sur la base a verifier :
--   docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--       < scripts/verifier-fiches-audit.sql
--
-- Ce n'est PAS une migration : il ne va pas dans backEnd/migrations/.

\echo '== 1. mu / sigma hors bornes, NaN ou infinis (mu dans [0,100], sigma dans ]0,20]) =='
-- En Postgres, NaN est plus grand que tout nombre : `> 100` le compte deja.
-- Un sigma au-dela de 20 peut etre legitime (penalites fantomes accumulees) :
-- il n'est refuse qu'a la SAISIE, pas dans le moteur. A lire, pas a corriger d'office.
SELECT id, nom, mu, sigma
FROM joueurs
WHERE mu IS NULL OR sigma IS NULL
   OR mu < 0 OR mu > 100
   OR sigma <= 0 OR sigma > 20
ORDER BY id;

\echo '== 2. Couleurs de fiche hors #RRGGBB =='
SELECT id, nom, color
FROM joueurs
WHERE color IS NOT NULL AND color !~ '^#[0-9A-Fa-f]{6}$'
ORDER BY id;

\echo '== 3. Couleurs de ligue hors #RRGGBB (et leur copie archivee dans les tournois) =='
SELECT 'ligues' AS source, id, nom, couleur
FROM ligues
WHERE couleur IS NOT NULL AND couleur !~ '^#[0-9A-Fa-f]{6}$'
UNION ALL
SELECT 'tournois', id, ligue_nom, ligue_couleur
FROM tournois
WHERE ligue_couleur IS NOT NULL AND ligue_couleur !~ '^#[0-9A-Fa-f]{6}$'
ORDER BY 1, 2;

\echo '== 4. Doublons de casse (« Mario » et « mario ») =='
-- Le formulaire de tournoi les rattache desormais a la PREMIERE fiche trouvee :
-- deux fiches pour un meme nom rendent ce choix arbitraire. A fusionner a la main.
SELECT lower(nom) AS nom_normalise, array_agg(id ORDER BY id) AS ids,
       array_agg(nom ORDER BY id) AS noms
FROM joueurs
GROUP BY lower(nom)
HAVING count(*) > 1;

\echo '== 5. Noms anonymises revenus sur une fiche =='
-- Meme empreinte que services.empreinte_nom : sha256 du nom sans espaces de
-- bord, en minuscules. (trim ne retire que les espaces, strip() de Python
-- tous les blancs : un nom borde d'une tabulation echapperait a ce controle.)
SELECT j.id, j.nom, j.anonymise_at
FROM joueurs j
JOIN noms_interdits n
  ON n.nom_hash = encode(sha256(convert_to(lower(trim(j.nom)), 'UTF8')), 'hex')
ORDER BY j.id;

\echo '== 6. Noms contenant « / » (fiche inatteignable par /stats/joueur/<nom>) =='
SELECT id, nom FROM joueurs WHERE nom LIKE '%/%' ORDER BY id;

\echo '== 7. Reglages TrueSkill non numeriques ou hors bornes =='
SELECT key, value
FROM configuration
WHERE key IN ('tau', 'ghost_penalty', 'sigma_threshold')
  -- CASE et non OR : Postgres ne garantit pas l'ordre d'un OR, et la
  -- conversion planterait sur une valeur non numerique avant la regex.
  AND CASE
        WHEN value !~ '^[0-9]+(\.[0-9]+)?$' THEN true
        WHEN key = 'sigma_threshold' THEN value::double precision NOT BETWEEN 0.000001 AND 20
        ELSE value::double precision > 20
      END;

\echo '== 8. Resets globaux enregistres avec une valeur NaN, infinie ou negative =='
SELECT id, date, value_applied, max_sigma
FROM global_resets
WHERE value_applied = 'NaN'::real OR value_applied <= 0 OR value_applied > 20
   OR max_sigma = 'NaN'::real OR max_sigma <= 0 OR max_sigma > 20
ORDER BY id;
