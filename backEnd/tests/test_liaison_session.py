"""Liaison d'un tournoi a une session : le refus doit etre categorique.

Phase 2 de docs/plan-sessions-tournois.md (2026-09-15), decisions 9 et 10.

La regle : un joueur ne peut jouer qu'UN tournoi par session (deux lobbies
simultanes, on ne peut pas etre dans les deux). Si la liaison demandee la
violerait, le tournoi n'est PAS cree -- ni liaison, ni enregistrement.

Trois defauts que ce fichier empeche, tous identifies a la relecture du plan
avant ecriture du code :

1. **Controle auto-referent** (F-7). Si on fusionne AVANT de controler, le
   tournoi courant est deja dans la session cible : ses propres joueurs
   remontent comme conflits et TOUTE liaison est refusee. Le defaut est
   silencieux -- il ne plante pas, il refuse tout. D'ou l'ordre verifie ici :
   participations -> controle -> fusion.

2. **Creation malgre le refus** (decision 10). Le refus doit passer par
   rollback : sans lui, un tournoi reste en base avec des scores calcules pour
   une liaison qui n'a pas eu lieu.

3. **Confiance dans l'etape 1** (F-10). La route de verification est
   indicative : elle compare des NOMS, faute d'ids (les joueurs ne sont pas
   encore crees). add_tournament doit refaire le controle sur les joueur_id,
   sinon un appel direct a l'API passe au travers (TOCTOU).

Limite du banc d'essai : psycopg2 est neutralise, le SQL n'est pas valide contre
Postgres. Ce qui est verifie, c'est l'ENCHAINEMENT des requetes et le fait que
la transaction soit annulee -- exactement ce qui casse en silence.
"""
from harness import *
from flask import Flask

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

H = {'X-Session-Token': 'tok'}
SESSION = lambda role: (
    r"FROM sessions_joueurs s JOIN comptes c",
    ligne_session(compte_id=1, discord_id='111', username='a',
                  global_name='A', role=role))

# Socle commun d'un ajout de tournoi : tout ce que la route lit avant d'arriver
# au controle de session. Les tests ne divergent qu'apres.
def plan_ajout(conflits=None, cible_existe=True):
    return [
        (r"FROM global_resets WHERE date >=", (0,)),
        (r"key = 'league_mode_enabled'", ('false',)),
        (r"FROM grille_snapshots WHERE date", None),
        (r"INSERT INTO sessions_tournois DEFAULT VALUES", (501,)),
        (r"INSERT INTO Tournois", (777,)),
        (r"SELECT id, mu, sigma FROM Joueurs WHERE nom", (10, 25.0, 8.333)),
        (r"SELECT 1 FROM Tournois WHERE id = %s", (1,) if cible_existe else None),
        (r"SELECT DISTINCT j.nom", [(n,) for n in (conflits or [])]),
        (r"SELECT id, session_id FROM Tournois WHERE id IN", [(777, 501), (400, 300)]),
        (r"key = 'tau'", ('0.08',)),
        (r"key IN \('ghost_enabled'", [('ghost_enabled', 'false'),
                                       ('unranked_threshold', '5')]),
        (r"SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs", []),
        (r"SELECT DISTINCT ON \(p.joueur_id\)", []),
        (r"FROM ghost_log g", []),
    ]


class _Rating:
    """Substitut de trueskill.Rating : le harness neutralise le vrai module.

    Les valeurs renvoyees n'ont aucune importance ici -- ces tests portent sur
    l'enchainement des requetes et sur le refus, pas sur le calcul de score.
    """
    def __init__(self, mu=25.0, sigma=8.333):
        self.mu, self.sigma = float(mu), float(sigma)


class _Env:
    def __init__(self, **kw):
        pass

    def rate(self, groupes, ranks=None):
        return [[_Rating()] for _ in groupes]


def installer_trueskill():
    ts = sys.modules['trueskill']
    ts.Rating = _Rating
    ts.TrueSkill = _Env


def monter(plan, role='chef_admin'):
    cur, conn = install_db(list(plan) + [SESSION(role)])
    recharger()
    installer_trueskill()
    for m in ('routes_admin', 'cache', 'services'):
        sys.modules.pop(m, None)

    def execute_values(c, sql, argslist, *a, **kw):
        c.execute(sql, None)

    sys.modules['psycopg2'].extras.execute_values = execute_values

    import cache
    cache.invalidate_cache = lambda: None
    import services
    services.recalculate_tiers = lambda: None
    import routes_admin
    routes_admin.recalculate_tiers = lambda: None
    app = Flask(__name__)
    app.register_blueprint(routes_admin.admin_bp)
    return app.test_client(), cur, conn


def sqls(cur):
    return [s for s, _ in cur.executed]


def indice(cur, motif):
    """Rang de la premiere requete contenant `motif`, ou None."""
    for i, s in enumerate(sqls(cur)):
        if motif in s:
            return i
    return None


JOUEURS = {"date": "2026-09-15", "joueurs": [{"nom": "A", "score": 100},
                                             {"nom": "B", "score": 90}]}


# ───────────────────────────────────────────────────────────────────────────
print("\n=== Sans liaison demandee : comportement inchange ===")

cli, cur, conn = monter(plan_ajout())
r = cli.post('/add-tournament', headers=H, json=dict(JOUEURS))
check("le tournoi est cree (201)", r.status_code == 201, r.get_data(as_text=True))
check("aucun controle de conflit n'a lieu",
      indice(cur, 'SELECT DISTINCT j.nom') is None, None)
check("aucune fusion n'a lieu",
      indice(cur, 'UPDATE Tournois SET session_id') is None, None)
check("la transaction est validee", conn.committed, None)


print("\n=== Liaison licite : controle AVANT fusion (F-7, F-8) ===")

cli, cur, conn = monter(plan_ajout(conflits=[]))
r = cli.post('/add-tournament', headers=H, json=dict(JOUEURS, autre_tournoi_id=1))
check("le tournoi est cree (201)", r.status_code == 201, r.get_data(as_text=True))

i_parts = indice(cur, 'INSERT INTO Participations')
i_ctrl = indice(cur, 'SELECT DISTINCT j.nom')
i_fusion = indice(cur, 'SELECT id, session_id FROM Tournois WHERE id IN')

check("les participations sont inserees avant le controle",
      i_parts is not None and i_ctrl is not None and i_parts < i_ctrl,
      (i_parts, i_ctrl))

# LE point du fichier : controler apres avoir fusionne rendrait le controle
# auto-referent et ferait refuser toute liaison.
check("le controle a lieu AVANT la fusion",
      i_ctrl is not None and i_fusion is not None and i_ctrl < i_fusion,
      (i_ctrl, i_fusion))

# Le controle doit exclure le tournoi courant, sinon il se detecte lui-meme.
ctrl_sql = next((s for s in sqls(cur) if 'SELECT DISTINCT j.nom' in s), '')
check("le controle exclut le tournoi courant (t.id <> ...)",
      't.id <> %s' in ctrl_sql, ctrl_sql[:120])

# Et porter sur la session entiere, pas le seul tournoi designe : sinon une
# liaison transitive (C vers B alors que B est avec A) laisse passer un conflit.
check("le controle porte sur la session entiere, pas un tournoi",
      't.session_id = (SELECT session_id FROM Tournois WHERE id = %s)' in ctrl_sql,
      ctrl_sql[:200])

check("la transaction est validee", conn.committed, None)


print("\n=== Liaison conflictuelle : REFUS CATEGORIQUE (decision 9) ===")

cli, cur, conn = monter(plan_ajout(conflits=['Toto', 'Titi']))
r = cli.post('/add-tournament', headers=H, json=dict(JOUEURS, autre_tournoi_id=1))
corps = r.get_json() or {}

check("la reponse est 409", r.status_code == 409, r.status_code)
check("le code d'erreur est exploitable par le client",
      corps.get('code') == 'conflit_session', corps)
check("les joueurs en conflit sont nommes",
      corps.get('joueurs_en_conflit') == ['Toto', 'Titi'], corps)
check("le message cite les noms", 'Toto' in (corps.get('error') or ''), corps)

# L'exigence centrale de la decision 10 : pas de creation en base.
#
# On verifie le rollback, pas l'absence de commit : le middleware
# d'authentification valide sa propre transaction (auth.py, suivi de
# last_seen_at) et partage le meme faux objet connexion dans ce banc d'essai,
# la ou la production utilise deux connexions distinctes du pool.
check("la transaction est ANNULEE", conn.rolledback, None)

# Garde-fou de lecture : chaque refus doit etre suivi d'un return, sinon
# l'execution continuerait jusqu'au commit final et creerait le tournoi malgre
# le refus. C'est le mode d'echec le plus grave de cette phase.
src_route = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read()
lignes_ajout = src_route[src_route.index('def add_tournament'):
                         src_route.index('def verifier_session_tournoi')].splitlines()
sans_return = []
for i, ligne in enumerate(lignes_ajout):
    if ligne.strip() == 'conn.rollback()':
        suite = ' '.join(l.strip() for l in lignes_ajout[i + 1:i + 3])
        if not suite.startswith('return'):
            sans_return.append(i)
check("chaque rollback de add_tournament est suivi d'un return",
      not sans_return, "lignes %s" % sans_return)

# Un refus ne doit pas laisser la moitie du travail derriere lui : ni fusion,
# ni calcul, ni notification.
check("aucune fusion n'a eu lieu",
      indice(cur, 'UPDATE Tournois SET session_id') is None, None)
check("aucune penalite d'absence n'est calculee",
      indice(cur, 'INSERT INTO ghost_log') is None, None)
check("aucune notification n'est diffusee",
      indice(cur, 'INSERT INTO notifications') is None, None)


print("\n=== Tournoi cible inexistant : refus propre, pas de 500 ===")

cli, cur, conn = monter(plan_ajout(cible_existe=False))
r = cli.post('/add-tournament', headers=H, json=dict(JOUEURS, autre_tournoi_id=99999))
check("la reponse est 404", r.status_code == 404, r.status_code)
check("la transaction est annulee", conn.rolledback, None)


print("\n=== autre_tournoi_id invalide : rejete avant toute ecriture ===")

for mauvais in ('abc', [], {'a': 1}):
    cli, cur, conn = monter(plan_ajout())
    r = cli.post('/add-tournament', headers=H, json=dict(JOUEURS, autre_tournoi_id=mauvais))
    check("autre_tournoi_id=%r -> 400" % (mauvais,), r.status_code == 400, r.status_code)
    check("  aucune session n'est creee",
          indice(cur, 'INSERT INTO sessions_tournois') is None, None)


print("\n=== La route de verification est en LECTURE SEULE (F-10) ===")

cli, cur, conn = monter([
    (r"SELECT t.id, t.date, t.session_id", [(1, __import__('datetime').date(2026, 9, 14), 1,
                                             '', 8)]),
    (r"SELECT t.session_id, j.nom", [(1, 'Toto')]),
])
r = cli.post('/admin/tournois/verifier-session', headers=H,
             json={"joueurs": [{"nom": "Toto", "score": 1}]})
check("la route repond 200", r.status_code == 200, r.get_data(as_text=True))

# `sessions_joueurs` est touchee par le middleware d'authentification (suivi
# de derniere activite), sur toutes les routes : ce n'est pas une ecriture de
# cette route. On verifie les tables du domaine.
ecritures = [s for s in sqls(cur)
             if any(s.upper().startswith(v) for v in ('INSERT', 'UPDATE', 'DELETE'))
             and 'sessions_joueurs' not in s]
# Elle ne doit surtout pas creer les fiches joueurs pour pouvoir comparer des
# ids : un admin qui ouvre la modale puis renonce ne laisse rien derriere lui.
check("aucune ecriture sur les tables du domaine", not ecritures, ecritures)

cands = (r.get_json() or {}).get('candidats') or []
check("un candidat est renvoye", len(cands) == 1, cands)
check("le candidat en conflit est marque non liable",
      cands and cands[0]['liable'] is False, cands)
check("les joueurs en conflit sont exposes a l'interface",
      cands and cands[0]['joueurs_en_conflit'] == ['Toto'], cands)

# La comparaison de noms doit etre normalisee, sinon « toto » et « Toto »
# passent pour deux joueurs et le conflit reste invisible dans la modale.
sql_noms = next((s for s in sqls(cur) if 'SELECT t.session_id, j.nom' in s), '')
check("la comparaison de noms est normalisee (casse et espaces)",
      'lower(btrim(j.nom))' in sql_noms, sql_noms[:160])


print("\n=== Liaison tardive : meme refus, perimetre different (F-9) ===")

cli, cur, conn = monter([
    (r"SELECT id, session_id FROM Tournois WHERE id IN", [(10, 100), (20, 200)]),
    (r"SELECT DISTINCT j.nom", [('Toto',)]),
])
r = cli.post('/admin/tournois/10/lier-session', headers=H, json={"autre_tournoi_id": 20})
check("le conflit est refuse en 409", r.status_code == 409, r.get_data(as_text=True))
check("la transaction est annulee", conn.rolledback, None)
check("aucune fusion n'a eu lieu",
      indice(cur, 'UPDATE Tournois SET session_id') is None, None)

# Deux sessions deja peuplees : il faut comparer les deux ensembles en entier,
# pas un tournoi contre une session.
sql_conflit = next((s for s in sqls(cur) if 'SELECT DISTINCT j.nom' in s), '')
check("le controle compare les deux sessions entre elles",
      'ta.session_id = %s AND tb.session_id = %s' in sql_conflit, sql_conflit[:200])

cli, cur, conn = monter([
    (r"SELECT id, session_id FROM Tournois WHERE id IN", [(10, 100), (20, 200)]),
    (r"SELECT DISTINCT j.nom", []),
])
r = cli.post('/admin/tournois/10/lier-session', headers=H, json={"autre_tournoi_id": 20})
check("une liaison licite reussit", r.status_code == 200, r.get_data(as_text=True))
check("la session conservee est la plus petite (convention stable)",
      (r.get_json() or {}).get('session_id') == 100, r.get_json())
check("les tournois de l'autre session sont reaffectes",
      indice(cur, 'UPDATE Tournois SET session_id') is not None, sqls(cur))
check("la session videe est supprimee",
      indice(cur, 'DELETE FROM sessions_tournois') is not None, sqls(cur))
check("la transaction est validee", conn.committed, None)

r = cli.post('/admin/tournois/10/lier-session', headers=H, json={"autre_tournoi_id": 10})
check("lier un tournoi a lui-meme -> 400", r.status_code == 400, r.status_code)


print("\n=== Liaison tardive : les absences en trop sont retirees (5.2) ===")

# Scenario reel (constate en usage le 15/09) : deux tournois enregistres
# separement, puis lies. La session {10, 20} contient donc deux tournois.
#
#   - joueur 3 a joue le tournoi 10 -> compte absent du 20, a tort.
#     Jouer un seul tournoi de la session suffit : son compteur doit revenir a 0.
#   - joueur 7 est absent des DEUX -> compte 2 fois au lieu d'une.
#     « Une session manquee = +1 » : il doit perdre 1 absence, pas 2.
#
# L'ancienne version ne defaisait que les penalites inscrites dans ghost_log,
# donc ne corrigeait AUCUN de ces deux cas tant qu'aucun seuil n'etait atteint.
def plan_liaison(manques, sigma_missed, penalites=None, presents=((3,),)):
    return [
        (r"SELECT id, session_id FROM Tournois WHERE id IN", [(10, 100), (20, 200)]),
        (r"SELECT DISTINCT j.nom", []),
        (r"key = 'unranked_threshold'", ('5',)),
        (r"SELECT id FROM Tournois WHERE session_id", [(10,), (20,)]),
        (r"SELECT DISTINCT p.joueur_id", list(presents)),
        (r"count\(DISTINCT p.tournoi_id\)", manques),
        (r"SELECT g.joueur_id, SUM\(g.penalty_applied\)", penalites or []),
        (r"SELECT sigma, COALESCE\(consecutive_missed, 0\) FROM Joueurs", sigma_missed),
    ]


cli, cur, conn = monter(plan_liaison(
    manques=[(3, 1), (7, 2)],          # joueur 3 : 1 tournoi manque ; joueur 7 : 2
    sigma_missed=(3.0, 1),             # etat lu pour chaque joueur corrige
))
r = cli.post('/admin/tournois/10/lier-session', headers=H, json={"autre_tournoi_id": 20})
check("la liaison reussit", r.status_code == 200, r.get_data(as_text=True))

maj = [p for sql, p in cur.executed if 'UPDATE Joueurs' in sql and 'SET sigma' in sql]
check("les DEUX joueurs sont corriges (present ET absent complet)",
      len(maj) == 2, maj)

par_id = {p[3]: p for p in maj}
# Joueur 3 a joue un tournoi de la session : 0 absence imputable.
check("le present (3) perd son absence : 1 -> 0",
      3 in par_id and par_id[3][1] == 0, par_id.get(3))
# Joueur 7 absent des deux : garde UNE absence pour la session, pas deux.
check("l'absent complet (7) perd l'absence en trop : 1 -> 0",
      7 in par_id and par_id[7][1] == 0, par_id.get(7))
check("la transaction est validee", conn.committed, None)

# Le nombre retire ne doit jamais depasser ce que le joueur porte : son compteur
# a pu etre remis a 0 depuis (il a rejoue), ou ne jamais avoir ete incremente
# (hors perimetre de ligue).
cli, cur, conn = monter(plan_liaison(
    manques=[(7, 2)],
    sigma_missed=(3.0, 0),             # compteur deja a 0
    presents=(),
))
r = cli.post('/admin/tournois/10/lier-session', headers=H, json={"autre_tournoi_id": 20})
maj = [p for sql, p in cur.executed if 'UPDATE Joueurs' in sql and 'SET sigma' in sql]
check("un compteur deja a 0 n'est pas rendu negatif",
      not maj or all(p[1] >= 0 for p in maj), maj)


print("\n=== La penalite de sigma est retiree en plus du compteur ===")

# Joueur 7 : 5 absences, 2 penalites de 0.1 portees par la session.
cli, cur, conn = monter(plan_liaison(
    manques=[(7, 2)],
    sigma_missed=(3.0, 5),
    penalites=[(7, 0.2, 2)],
    presents=(),
))
r = cli.post('/admin/tournois/10/lier-session', headers=H, json={"autre_tournoi_id": 20})
check("la liaison reussit", r.status_code == 200, r.get_data(as_text=True))
check("le nombre de joueurs corriges est renvoye",
      (r.get_json() or {}).get('penalites_annulees') == 1, r.get_json())

maj = [p for sql, p in cur.executed if 'UPDATE Joueurs' in sql and 'SET sigma' in sql]
if maj:
    sigma, missed, ranked, jid = maj[0]
    # On RETIRE le cumul applique, on ne restaure pas un old_sigma fige : sinon
    # on ecraserait tout ce qui a bouge depuis (matchs, autres penalites).
    check("sigma : 3.0 - 0.2 de penalites = 2.8", abs(sigma - 2.8) < 1e-9, sigma)
    # Absent complet : garde 1 absence sur les 2 comptees.
    check("compteur : 5 - 1 absence en trop = 4", missed == 4, missed)
    check("is_ranked recalcule (4 < seuil 5)", ranked is True, ranked)

check("les lignes ghost_log de la session sont supprimees",
      indice(cur, 'DELETE FROM ghost_log') is not None, sqls(cur))

# Le sigma est du dossier sportif : lier deux tournois qui le fait bouger doit
# laisser une trace aussi precise qu'une modification de fiche (2026-09-22).
import json as _json
_audits = [p for sql, p in cur.executed if 'INSERT INTO audit_admin' in sql]
_det = _json.loads(_audits[0][4]) if _audits and _audits[0][4] else {}
check("la liaison écrit une ligne d'audit « tournoi_lie »",
      bool(_audits) and _audits[0][0] == 'tournoi_lie', _audits)
_corr = (_det.get('penalites_annulees') or [{}])[0]
check("  avec l'avant/après du sigma du joueur corrigé",
      _corr.get('joueur_id') == 7 and _corr.get('avant', {}).get('sigma') == 3.0
      and abs((_corr.get('apres', {}).get('sigma') or 0) - 2.8) < 1e-9, _det)
check("  et le drapeau score_modifie", _det.get('score_modifie') is True, _det)
check("  dans la transaction validée, avant le commit",
      indice(cur, 'INSERT INTO audit_admin') is not None and conn.committed)

# L'ordre est essentiel : « les tournois de la session » n'existe qu'une fois
# les deux reunis. Corriger avant la fusion ne verrait qu'un lobby.
i_fusion = indice(cur, 'UPDATE Tournois SET session_id')
i_tournois = indice(cur, 'SELECT id FROM Tournois WHERE session_id')
check("la correction a lieu APRES la fusion",
      i_fusion is not None and i_tournois is not None and i_fusion < i_tournois,
      (i_fusion, i_tournois))


print("\n=== Session a un seul tournoi : rien a corriger ===")

# Aucune absence ne peut etre « en trop » dans une session a un element : la
# fonction doit sortir sans lire ni ecrire quoi que ce soit.
cli, cur, conn = monter([
    (r"SELECT id, session_id FROM Tournois WHERE id IN", [(10, 100), (20, 100)]),
    (r"SELECT DISTINCT j.nom", []),
    (r"key = 'unranked_threshold'", ('5',)),
    (r"SELECT id FROM Tournois WHERE session_id", [(10,)]),
])
r = cli.post('/admin/tournois/10/lier-session', headers=H, json={"autre_tournoi_id": 20})
check("la liaison reussit", r.status_code == 200, r.get_data(as_text=True))
check("aucun joueur touche",
      not [s for s, _ in cur.executed if 'UPDATE Joueurs' in s], sqls(cur))
check("aucune purge de ghost_log",
      indice(cur, 'DELETE FROM ghost_log') is None, sqls(cur))


print("\n=== La correction ne vit qu'a un seul endroit ===")

src_services_p3 = open(os.path.join(RACINE, 'services.py'), encoding='utf-8').read()
src_admin_p3 = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read()
check("annuler_penalites_de_session est dans services.py",
      'def annuler_penalites_de_session(' in src_services_p3, None)
check("routes_admin l'appelle sans la reimplementer",
      src_admin_p3.count('annuler_penalites_de_session(cur') == 1
      and 'SUM(g.penalty_applied)' not in src_admin_p3, None)

corps_annul = src_services_p3[src_services_p3.index('def annuler_penalites_de_session('):]
corps_annul = corps_annul[:corps_annul.index('\ndef ')]
# penalty_applied porte la valeur REELLEMENT appliquee : une penalite ecretee
# par GHOST_SIGMA_CAP a ajoute moins que ghost_penalty.
check("le cumul retire vient de penalty_applied (et non de la config)",
      'SUM(g.penalty_applied)' in corps_annul
      and 'ghost_penalty' not in corps_annul, None)
check("sigma ne peut pas devenir negatif",
      'max(sigma_actuel - cumul_sigma, 0.0)' in corps_annul, None)
check("le retrait est borne par ce que le joueur porte",
      'min(max(en_trop, 0), missed_actuel)' in corps_annul, None)
check("un present garde 0 absence, un absent complet en garde 1",
      'a_garder = 0 if joueur_id in presents else 1' in corps_annul, None)
check("une session a un seul tournoi sort immediatement",
      'if len(tournois) < 2:' in corps_annul, None)


print("\n=== La liaison tardive est accessible depuis l'interface ===")

# Sans porte d'entree dans l'UI, cette route n'etait testable qu'a la console --
# donc en pratique jamais utilisee, alors qu'elle corrige des absences fausses.
src_public_p4 = open(os.path.join(RACINE, 'routes_public.py'), encoding='utf-8').read()
check("/stats/tournois expose session_id",
      '"session_id": r[6]' in src_public_p4, None)
check("/stats/tournois expose le nombre de tournois de la session",
      '"nb_dans_session": r[7]' in src_public_p4, None)
# Le GROUP BY doit inclure session_id, sinon Postgres refuse la requete.
check("session_id est dans le GROUP BY",
      'GROUP BY t.id, t.date, t.session_id' in src_public_p4, None)

tpl = open(os.path.join(RACINE, '..', 'frontEnd', 'templates', 'add_tournament.html'),
           encoding='utf-8').read()
check("un bouton de liaison existe dans la liste des tournois",
      'ouvrirLiaisonTardive(' in tpl, None)
check("la modale de liaison tardive existe",
      'liaisonTardiveModal' in tpl, None)
# Le jeton CSRF doit venir du template : le recuperer en JS depuis le DOM
# echouait sur cette page (constate le 15/09).
check("le CSRF vient du template, pas d'une recherche dans le DOM",
      "'X-CSRFToken': \"{{ csrf_token() }}\"" in tpl, None)
check("un tournoi deja en session affiche son etat au lieu du bouton",
      'nb_dans_session > 1' in tpl, None)
check("le retour indique combien de joueurs ont ete corriges",
      'penalites_annulees' in tpl, None)


print("\n=== Idempotence : deux tournois deja lies ===")

cli, cur, conn = monter([
    (r"SELECT id, session_id FROM Tournois WHERE id IN", [(10, 100), (20, 100)]),
    (r"SELECT DISTINCT j.nom", []),
])
r = cli.post('/admin/tournois/10/lier-session', headers=H, json={"autre_tournoi_id": 20})
check("la liaison reussit sans rien changer", r.status_code == 200, r.get_data(as_text=True))
check("aucune reaffectation",
      indice(cur, 'UPDATE Tournois SET session_id') is None, sqls(cur))
check("aucune suppression de session",
      indice(cur, 'DELETE FROM sessions_tournois') is None, sqls(cur))


print("\n=== Permissions : les deux routes exigent gestion_tournois ===")

for chemin, corps_req in (('/admin/tournois/verifier-session', {"joueurs": []}),
                          ('/admin/tournois/10/lier-session', {"autre_tournoi_id": 20})):
    cli, cur, conn = monter([
        (r"SELECT id, session_id FROM Tournois WHERE id IN", [(10, 100), (20, 200)]),
        (r"SELECT t.id, t.date, t.session_id", []),
        (r"FROM permissions_admin", None),
    ], role='admin')
    r = cli.post(chemin, headers=H, json=corps_req)
    check("%s refuse un admin sans la permission" % chemin.split('/')[-1],
          r.status_code == 403, r.status_code)


print("\n=== Invalidation du cache apres liaison tardive ===")

# Lier deux tournois change ce que la landing page doit afficher : sans
# invalidation, elle garde l'ancien regroupement jusqu'au prochain ajout.
src_admin = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read()
bloc = src_admin[src_admin.index('def lier_session_tournoi'):]
bloc = bloc[:bloc.index('\n@')] if '\n@' in bloc else bloc
check("lier_session_tournoi appelle invalidate_cache",
      'invalidate_cache()' in bloc, None)


print("\n=== Le code de conflit vit a UN seul endroit ===")

src_services = open(os.path.join(RACINE, 'services.py'), encoding='utf-8').read()

check("joueurs_en_conflit_de_session est dans services.py",
      'def joueurs_en_conflit_de_session(' in src_services, None)
check("joueurs_en_conflit_entre_sessions est dans services.py",
      'def joueurs_en_conflit_entre_sessions(' in src_services, None)
check("fusionner_sessions est dans services.py",
      'def fusionner_sessions(' in src_services, None)

# La lecon de la Phase 0 : deux routes qui recopient la meme regle finissent par
# diverger. routes_admin doit appeler, jamais reimplementer.
check("routes_admin ne reimplemente pas la requete de conflit",
      'SELECT DISTINCT j.nom' not in src_admin, None)
check("routes_admin ne reimplemente pas la fusion",
      'UPDATE Tournois SET session_id' not in src_admin, None)


print("\n=== Phase 5 : la landing page regroupe par session ===")

src_public = open(os.path.join(RACINE, 'routes_public.py'), encoding='utf-8').read()

check("la branche standard filtre sur session_id",
      'AND session_id = %s' in src_public, None)
check("le regroupement par semaine a disparu",
      "date_trunc('week'" not in src_public, None)
# La branche ligue affiche « ou en est chaque ligue », pas une occasion de jeu :
# une session ne peut pas modeliser ca.
check("la branche ligue est inchangee (DISTINCT ON ligue_nom)",
      'DISTINCT ON (t.ligue_nom)' in src_public, None)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
