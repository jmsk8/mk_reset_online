"""Penalite d'absence comptee en sessions loupees.

Presence par session, declenchement par consecutive_missed, denominateur des
awards par session, et cycle ajout -> penalite -> annulation neutre.
"""
from harness import *

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

# Faux module `db` requis a l'import de services.py.
install_db([])
recharger()
for _m in ('services', 'cache'):
    sys.modules.pop(_m, None)
from services import penalite_due


# ───────────────────────────────────────────────────────────────────────────
print("\n=== penalite_due : le palier de declenchement (decision 8) ===")

# Reglages par defaut : seuil 4, intervalle 1.
attendu_4_1 = {1: False, 2: False, 3: False, 4: True, 5: True, 6: True, 7: True}
for loupees, doit in attendu_4_1.items():
    check("seuil=4 int=1 : %d session(s) loupee(s) -> %s"
          % (loupees, "penalite" if doit else "rien"),
          penalite_due(loupees, 4, 1) is doit, penalite_due(loupees, 4, 1))

# Un intervalle > 1 espace les penalites suivantes.
attendu_2_3 = {1: False, 2: True, 3: False, 4: False, 5: True, 6: False, 7: False, 8: True}
for loupees, doit in attendu_2_3.items():
    check("seuil=2 int=3 : %d -> %s" % (loupees, "penalite" if doit else "rien"),
          penalite_due(loupees, 2, 3) is doit, penalite_due(loupees, 2, 3))

check("0 session loupee ne penalise jamais", penalite_due(0, 1, 1) is False, None)
check("le palier exact declenche (seuil=1)", penalite_due(1, 1, 1) is True, None)

# Intervalle modifiable depuis l'admin : pas de division par zero.
check("intervalle 0 ne divise pas par zero", penalite_due(5, 2, 0) is True,
      "doit se comporter comme intervalle=1")
check("intervalle negatif ne leve pas", penalite_due(5, 2, -3) is True, None)


print("\n=== Aucune notion de temps ne subsiste dans le declenchement ===")

src_admin = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read()

check("plus de calcul d'ecart de dates (date_tournoi - ref)",
      '(date_tournoi - ref).days' not in src_admin, None)
check("plus de lecture de la derniere date de jeu (last_played)",
      'last_played[jid]' not in src_admin and 'last_played.get(' not in src_admin, None)
check("plus de lecture de la derniere penalite (last_ghost)",
      'last_ghost' not in src_admin, None)
check("les constantes en jours ne sont plus importees",
      'DEFAULT_GHOST_THRESHOLD_DAYS' not in src_admin
      and 'DEFAULT_GHOST_INTERVAL_DAYS' not in src_admin, None)
check("le declenchement passe par penalite_due",
      'penalite_due(new_missed, seuil_sessions, intervalle_sessions)' in src_admin, None)

# La ligue de derniere apparition reste lue (mode ligue).
check("le filtrage par ligue est conserve",
      'last_played_ligue' in src_admin, None)


print("\n=== La presence se mesure par session, plus par date ===")

check("le patch de deduplication par date a disparu",
      'same_day_exists' not in src_admin.replace('# Remplace le couple present_today_ids/same_day_exists, qui', '')
      .replace("# l'ancien « same_day_exists = False » : tous les absents sont", ''),
      None)
check("plus de present_today_ids",
      'present_today_ids = {' not in src_admin, None)
check("les presents sont cherches par session_id",
      'WHERE t.session_id = %s AND t.id <> %s' in src_admin, None)
check("la variable dit ce qu'elle contient (deja_presents)",
      'deja_presents = {r[0] for r in cur.fetchall()}' in src_admin, None)
check("un present dans la session n'est pas incremente",
      'compte_absent = not (present_dans_session or session_deja_comptee)' in src_admin
      and 'new_missed = (missed or 0) + 1 if compte_absent else (missed or 0)' in src_admin,
      None)
# Un absent de tous les lobbies ne prend qu'une absence par session.
check("un second tournoi de la session ne recompte pas les absents",
      'session_deja_comptee = session_a_un_autre_tournoi(' in src_admin, None)
check("la penalite de sigma suit la meme regle que le compteur",
      'if (ghost_enabled and compte_absent and' in src_admin, None)
check("les annulations ne retirent l'absence que si la session disparait",
      src_admin.count('if not session_a_un_autre_tournoi(cur, tsession') == 2, None)


# La session est connue avant le calcul des presences.
bloc_ajout = src_admin[src_admin.index('def add_tournament'):
                       src_admin.index('def verifier_session_tournoi')]
i_fusion = bloc_ajout.find('session_id = fusionner_sessions(cur')
i_presences = bloc_ajout.find('WHERE t.session_id = %s AND t.id <> %s')
check("les presences sont calculees APRES la fusion de session",
      i_fusion != -1 and i_presences != -1 and i_fusion < i_presences,
      (i_fusion, i_presences))


print("\n=== Les seuils sont lus et ecrits en sessions ===")

check("la lecture de config demande les cles en sessions",
      "'ghost_threshold_sessions', 'ghost_interval_sessions'" in src_admin, None)
check("l'ecriture accepte les cles en sessions",
      "configs.append(('ghost_threshold_sessions'" in src_admin
      and "configs.append(('ghost_interval_sessions'" in src_admin, None)
check("aucune cle en jours ne subsiste",
      'ghost_threshold_days' not in src_admin and 'ghost_interval_days' not in src_admin, None)

src_const = open(os.path.join(RACINE, 'constants.py'), encoding='utf-8').read()
check("les constantes en sessions existent",
      'DEFAULT_GHOST_THRESHOLD_SESSIONS = 4' in src_const
      and 'DEFAULT_GHOST_INTERVAL_SESSIONS = 1' in src_const, None)
check("les constantes en jours ont ete retirees",
      'DEFAULT_GHOST_THRESHOLD_DAYS' not in src_const
      and 'DEFAULT_GHOST_INTERVAL_DAYS' not in src_const, None)


print("\n=== Le comptage des awards lit session_id (decision 7) ===")

src_services = open(os.path.join(RACINE, 'services.py'), encoding='utf-8').read()

check("le regroupement (date, ligue_id) des awards a disparu",
      'session_keys' not in src_services, None)
check("total_tournois compte des sessions distinctes",
      'total_tournois = len(sessions_vues)' in src_services, None)
check("session_id est bien selectionne par la requete de saison",
      't.session_id' in src_services, None)
check("les sessions sont collectees depuis les lignes",
      'sessions_vues.add(row[12])' in src_services, None)

# Le denominateur des awards ne doit pas decaler les index existants.
requete = src_services[src_services.index('def _aggregate_season_stats'):]
requete = requete[:requete.index('params = [d_debut, d_fin]')]
check("session_id est ajoutee EN FIN de SELECT (aucun index decale)",
      requete.index('t.session_id') > requete.index('p.old_mu'), None)


print("\n=== Le compteur n'est modifiable que par le superadmin (decision 8) ===")

# consecutive_missed n'est modifiable que par le superadmin.
bloc_edit = src_admin[src_admin.index('def api_update_joueur'):]
bloc_edit = bloc_edit[:bloc_edit.index('\n@')]

check("la modification est reservee au superadmin",
      "g.compte['role'] == ROLE_SUPERADMIN" in bloc_edit, None)
check("le compteur n'est touche que s'il est explicitement fourni",
      "'consecutive_missed' in data" in bloc_edit, None)
check("deux UPDATE distincts selon le droit, pas de colonne conditionnelle en SQL",
      bloc_edit.count('UPDATE Joueurs SET nom=%s') == 2, None)
check("un compteur negatif est impossible",
      "max(0, int(data['consecutive_missed']))" in bloc_edit, None)

gestion_js = open(os.path.join(RACINE, '..', 'frontEnd', 'static', 'js', 'gestion.js'),
                  encoding='utf-8').read()
# Le JS n'envoie que les champs actifs.
check("le JS n'envoie le compteur que si le champ est actif",
      "if (champ && !champ.disabled) data[cle]" in gestion_js
      and "siActif('editMissed', 'consecutive_missed'" in gestion_js, None)

gestion_html = open(os.path.join(RACINE, '..', 'frontEnd', 'templates',
                                 'gestion_joueurs.html'), encoding='utf-8').read()
check("le champ est verrouille sauf pour le superadmin",
      "{% if role_admin == 'superadmin' %}" in gestion_html
      and 'id="editMissed" readonly disabled' in gestion_html, None)
check("le libelle parle de sessions",
      'Sessions manquées' in gestion_html, None)
check("le superadmin est averti de l'effet sur la penalite",
      'il décide de la pénalité' in gestion_html, None)


print("\n=== Les courbes d'evolution comptent aussi des sessions (R-session-6) ===")

# Seuil de participation compte en sessions, comme _aggregate_season_stats.
for fn in ('compute_ip_evolution', 'compute_position_evolution'):
    bloc = src_services[src_services.index('def %s' % fn):]
    bloc = bloc[:bloc.index('\ndef ')]
    check("%s : le seuil se base sur des sessions distinctes" % fn.split('_')[1],
          'total_tournois = len({sid for' in bloc, None)
    check("%s : session_id est selectionnee" % fn.split('_')[1],
          't.session_id' in bloc, None)
    # Les courbes restent indexees par tournoi.
    check("%s : les courbes restent indexees sur les tournois" % fn.split('_')[1],
          'for idx in range(len(tournoi_ids)):' in bloc
          and 'for idx in range(total_tournois):' not in bloc, None)


print("\n=== F-4 : le cycle d'annulation reste coherent ===")

# Le compteur ne doit pas etre decremente avant la restauration du sigma.
def corps(fn):
    d = src_admin.find('def %s' % fn)
    if d == -1:
        return ''
    f = src_admin.find('\n@', d)
    return src_admin[d:f if f != -1 else len(src_admin)]


# revert restaure old_sigma (dernier tournoi) ; delete retire penalty_applied.
for fn, motif_sigma, source in (
        ('revert_last_tournament', 'SET sigma = data.sigma', 'old_sigma FROM ghost_log'),
        ('delete_tournament', 'SET sigma = GREATEST(j.sigma - data.retrait',
         'SUM(penalty_applied) FROM ghost_log')):
    c = corps(fn)
    i_sigma = c.find(motif_sigma)
    i_compteur = c.find('annuler_absences(cur')
    check("%s : sigma corrige AVANT le decrement du compteur" % fn.split('_')[0],
          i_sigma != -1 and i_compteur != -1 and i_sigma < i_compteur,
          (i_sigma, i_compteur))
    check("%s : le sigma vient de ghost_log (%s)" % (fn.split('_')[0], source),
          source in c, None)

# Une seule implementation du decrement.
check("les deux routes partagent annuler_absences",
      src_admin.count('annuler_absences(cur') == 2,
      src_admin.count('annuler_absences(cur'))
check("aucun UPDATE global de consecutive_missed n'est revenu",
      'UPDATE Joueurs SET consecutive_missed = GREATEST' not in src_admin, None)

# Le decrement compense exactement l'increment de l'ajout.
corps_annuler = src_services[src_services.index('def annuler_absences('):]
corps_annuler = corps_annuler[:corps_annuler.index('\ndef ')]
check("annuler_absences decremente de 1 exactement",
      'new_missed = missed - 1' in corps_annuler, None)
check("annuler_absences ne touche pas au sigma (c'est le role de ghost_log)",
      'sigma' not in corps_annuler, None)
check("elle recalcule is_ranked par rapport au seuil",
      'new_missed < threshold' in corps_annuler, None)


print("\n=== Le script de recomptage des absences ===")

# Script de recalcul des compteurs d'absence.
SCRIPT = os.path.join(RACINE, '..', 'scripts', 'recompter_absences.py')
script = open(SCRIPT, encoding='utf-8').read()

# Le script ne doit jamais ecrire de sigma (docstring exclue).
corps_script = script.split('"""', 2)[-1]
check("le script ne contient aucune ecriture de sigma",
      'SET sigma' not in corps_script and 'sigma =' not in corps_script, None)
check("le script n'ecrit jamais dans ghost_log",
      'INSERT INTO ghost_log' not in script and 'DELETE FROM ghost_log' not in script, None)
check("il n'ecrit que consecutive_missed et is_ranked",
      'SET consecutive_missed = data.missed, is_ranked = data.ranked' in script, None)

check("une session sans ligue concerne tout le monde",
      'ligue_session is None or ligue_session in mes_ligues' in script, None)
check("un joueur sans ligue compte sur la ligue la plus faible",
      'ORDER BY niveau DESC' in script, None)
check("l'appartenance est deduite des participations, pas de joueurs.ligue_id",
      'ligues_jouees' in script and 'j.ligue_id' not in script, None)

# Deux sessions distinctes peuvent tomber le meme jour.
check("le script compare les sessions, pas seulement les dates",
      'sid not in mes_sessions' in script, None)
check("les joueurs sans aucune participation sont ignores",
      'jamais_joue' in script, None)
check("is_ranked est recalcule par rapport au seuil",
      'manquees < seuil' in script, None)

check("un mode simulation existe",
      "'--dry-run' in sys.argv" in script, None)
check("le mode simulation n'ecrit rien",
      "[dry-run] rien n'a ete ecrit" in script, None)

makefile = open(os.path.join(RACINE, '..', 'Makefile'), encoding='utf-8').read()
check("une cible make expose le script",
      'recompter-absences:' in makefile, None)
check("la cible accepte DRY=1",
      'recompter_absences.py' in makefile and '$(if $(DRY),--dry-run)' in makefile, None)


print("\n=== La migration de configuration ===")

MIG = os.path.join(RACINE, 'migrations', '2026-09-16_penalite_en_sessions.sql')
mig = open(MIG, encoding='utf-8').read()

check("elle refuse de tourner sans tournois.session_id",
      "column_name = 'session_id'" in mig and 'RAISE EXCEPTION' in mig, None)
check("elle cree les deux nouvelles cles",
      "'ghost_threshold_sessions'" in mig and "'ghost_interval_sessions'" in mig, None)
check("elle supprime les anciennes cles (sinon un admin les reglerait en vain)",
      "DELETE FROM public.Configuration" in mig
      and "'ghost_threshold_days', 'ghost_interval_days'" in mig, None)
# La conversion part de la valeur existante.
check("elle convertit la valeur existante plutot que d'imposer une constante",
      "/ 7 FROM public.Configuration" in mig, None)
check("elle plancher a 1 (un seuil nul penaliserait un joueur present)",
      'GREATEST(1,' in mig, None)
check("elle est rejouable",
      'ON CONFLICT (key) DO NOTHING' in mig, None)

compose = open(os.path.join(RACINE, '..', 'docker-compose.dump.yml'), encoding='utf-8').read()
check("la migration est montee dans docker-compose.dump.yml",
      '2026-09-16_penalite_en_sessions.sql' in compose, None)
check("elle passe APRES celle des sessions",
      compose.index('15_sessions_tournois') < compose.index('16_penalite_en_sessions'), None)

schema = open(os.path.join(RACINE, 'schema.sql'), encoding='utf-8').read()
check("schema.sql seme les cles en sessions",
      "('ghost_threshold_sessions', '4')" in schema
      and "('ghost_interval_sessions', '1')" in schema, None)
check("schema.sql ne seme plus les cles en jours",
      'ghost_threshold_days' not in schema and 'ghost_interval_days' not in schema, None)


print("\n=== L'interface d'administration parle de sessions ===")

reglages = open(os.path.join(RACINE, '..', 'frontEnd', 'templates', 'admin_reglages.html'),
                encoding='utf-8').read()
check("les champs sont renommes en sessions",
      'configGhostThresholdSessions' in reglages
      and 'configGhostIntervalSessions' in reglages, None)
check("les anciens champs en jours ont disparu",
      'configGhostThresholdDays' not in reglages
      and 'configGhostIntervalDays' not in reglages, None)
check("le libelle dit « sessions loupees »",
      'sessions loupées' in reglages, None)
check("une note explique ce qu'est une session",
      'occasion de jeu' in reglages, None)
check("la note previent qu'une periode sans session ne penalise pas",
      'ne pénalise personne' in reglages, None)

gestion = open(os.path.join(RACINE, '..', 'frontEnd', 'static', 'js', 'gestion.js'),
               encoding='utf-8').read()
check("le JS envoie les cles en sessions",
      'ghost_threshold_sessions: ghostThresholdSessions' in gestion
      and 'ghost_interval_sessions: ghostIntervalSessions' in gestion, None)
check("le JS relit les cles en sessions",
      'res.ghost_threshold_sessions' in gestion
      and 'res.ghost_interval_sessions' in gestion, None)
check("aucune cle en jours ne subsiste dans le JS",
      'ghost_threshold_days' not in gestion and 'ghost_interval_days' not in gestion, None)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
