"""Sessions de tournois : tout tournoi porte une session, une session videe est
supprimee, et la migration respecte ses invariants (verification statique)."""
from harness import *
from flask import Flask

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
MIGRATION = os.path.join(RACINE, 'migrations', '2026-09-15_sessions_tournois.sql')

H = {'X-Session-Token': 'tok'}
SESSION = lambda role: (
    r"FROM sessions_joueurs s JOIN comptes c",
    ligne_session(compte_id=1, discord_id='111', username='a',
                  global_name='A', role=role))


def monter(plan, role='chef_admin'):
    """Monte routes_admin sur un curseur scripte, execute_values capture."""
    cur, conn = install_db(list(plan) + [SESSION(role)])
    recharger()
    for m in ('routes_admin', 'cache', 'services'):
        sys.modules.pop(m, None)

    lots = []

    def execute_values(c, sql, argslist, *a, **kw):
        lots.append((' '.join(sql.split()), list(argslist)))
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
    return app.test_client(), cur, conn, lots


def sql_joints(cur):
    """Les requetes executees, normalisees sur une ligne."""
    return [sql for sql, _ in cur.executed]


def avant(texte, premier, second):
    """Vrai si `premier` apparait avant `second` dans `texte` (False si l'un manque)."""
    i, j = texte.find(premier), texte.find(second)
    return i != -1 and j != -1 and i < j


# ───────────────────────────────────────────────────────────────────────────
print("\n=== La migration cree la structure attendue ===")

mig = open(MIGRATION, encoding='utf-8').read()

check("la table s'appelle sessions_tournois, pas sessions",
      'CREATE TABLE IF NOT EXISTS public.sessions_tournois' in mig, None)

# Pas de confusion possible avec `sessions_joueurs`.
check("aucune table nommee simplement « sessions »",
      'CREATE TABLE IF NOT EXISTS public.sessions (' not in mig
      and 'CREATE TABLE public.sessions (' not in mig, None)

check("la colonne session_id est ajoutee a tournois",
      'ADD COLUMN IF NOT EXISTS session_id' in mig, None)

check("un index couvre session_id (jointures du calcul de presence)",
      'idx_tournois_session' in mig, None)

check("l'invariant est verrouille par SET NOT NULL",
      'ALTER COLUMN session_id SET NOT NULL' in mig, None)


print("\n=== Le backfill regroupe par (date, ligue_id), jamais par date seule ===")

# Deux ligues le meme jour = deux sessions.
check("le groupement porte sur date ET ligue_id",
      mig.count('GROUP BY t.date, t.ligue_id') >= 1
      and 'GROUP BY date, ligue_id' in mig, None)

check("aucun regroupement par date seule",
      'GROUP BY t.date\n' not in mig and 'GROUP BY date\n' not in mig, None)

# ligue_id NULL doit etre traite explicitement (NULL = NULL est NULL).
check("le cas ligue_id NULL est traite explicitement",
      'IS NULL AND ancre.ligue_id IS NULL' in mig, None)


print("\n=== La migration est rejouable sans effet de bord ===")

check("les INSERT de session tolerent un rejeu",
      'ON CONFLICT (id) DO NOTHING' in mig, None)

# Un rejeu ne doit pas ecraser les liaisons faites depuis.
check("le rattachement ne touche jamais une liaison existante",
      'WHERE t.session_id IS NULL' in mig, None)

check("la table est creee en IF NOT EXISTS",
      'CREATE TABLE IF NOT EXISTS' in mig, None)


print("\n=== La sequence est recalee apres les INSERT a id explicite ===")

# Le backfill insere des id explicites : la sequence doit etre recalee.
check("setval est appele sur sessions_tournois_id_seq",
      "setval('public.sessions_tournois_id_seq'" in mig, None)

check("setval est protege contre une table vide (MAX(id) NULL)",
      'COALESCE(MAX(id), 0)' in mig and 'GREATEST' in mig, None)

check("setval vient APRES l'INSERT (sinon il ne sert a rien)",
      avant(mig, 'INSERT INTO public.sessions_tournois (id, created_at)',
            "setval('public.sessions_tournois_id_seq'"), None)

check("SET NOT NULL vient APRES le backfill",
      avant(mig, 'SET session_id = ancre.session_id',
            'ALTER COLUMN session_id SET NOT NULL'), None)


print("\n=== Le controle d'integrite de la decision 9 est present ===")

# Un joueur ne peut pas etre dans deux tournois d'une meme session.
check("la migration refuse un joueur present deux fois dans une session",
      'HAVING count(*) > 1' in mig and 'RAISE EXCEPTION' in mig, None)

check("l'erreur renvoie vers la doc de conception",
      'plan-sessions-tournois' in mig, None)


print("\n=== add_tournament ouvre une session pour chaque tournoi ===")

src_admin = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read()

check("une session est creee a l'ajout",
      'INSERT INTO sessions_tournois DEFAULT VALUES RETURNING id' in src_admin, None)

check("session_id est passee a l'INSERT du tournoi",
      'INSERT INTO Tournois (date, ligue_id, ligue_nom, ligue_couleur, session_id)' in src_admin,
      None)

check("la session est creee AVANT l'INSERT du tournoi",
      avant(src_admin, 'INSERT INTO sessions_tournois DEFAULT VALUES',
            'INSERT INTO Tournois (date, ligue_id'), None)


print("\n=== Les deux routes d'annulation nettoient la session orpheline ===")

check("drop_session_if_orphan est importee",
      'drop_session_if_orphan' in src_admin.split('logger =')[0], None)

check("elle est appelee deux fois (revert + delete)",
      src_admin.count('drop_session_if_orphan(cur') == 2,
      src_admin.count('drop_session_if_orphan(cur'))

# session_id doit etre lue avant le DELETE.
check("revert lit session_id dans son SELECT initial",
      'SELECT id, date, session_id, ligue_id FROM Tournois ORDER BY id DESC' in src_admin, None)

check("delete lit session_id avant de supprimer",
      'SELECT date, session_id, ligue_id FROM Tournois WHERE id' in src_admin, None)

def corps_fonction(src, nom):
    """Le source d'une fonction, de sa signature au prochain decorateur."""
    debut = src.find('def %s(' % nom)
    if debut == -1:
        return ''
    suite = src.find('\n@', debut)
    return src[debut:suite if suite != -1 else len(src)]


# Verifie route par route.
for route, lecture in (('revert_last_tournament', 'session_id, ligue_id FROM Tournois'),
                       ('delete_tournament', 'session_id, ligue_id FROM Tournois WHERE id')):
    corps = corps_fonction(src_admin, route)
    check("%s : session_id lue avant l'appel de nettoyage" % route.split('_')[0],
          avant(corps, lecture, 'drop_session_if_orphan(cur'), None)


print("\n=== drop_session_if_orphan : la logique ===")

src_services = open(os.path.join(RACINE, 'services.py'), encoding='utf-8').read()

check("la fonction est definie dans services.py",
      'def drop_session_if_orphan(' in src_services, None)

corps = src_services[src_services.index('def drop_session_if_orphan('):]
corps = corps[:corps.index('\n\n\n')] if '\n\n\n' in corps else corps

check("elle tolere une session_id absente",
      'if session_id is None' in corps, None)

# Ne supprime que si plus aucun tournoi n'y pointe.
check("elle ne supprime que si plus aucun tournoi n'y pointe",
      'SELECT 1 FROM Tournois WHERE session_id' in corps
      and 'if cur.fetchone():' in corps
      and 'return' in corps, None)

check("elle cible la bonne table",
      'DELETE FROM sessions_tournois WHERE id' in corps, None)


print("\n=== sync_sequences couvre sessions_tournois ===")

# sync_sequences doit rattraper la sequence de sessions_tournois.
check("sessions_tournois est dans la liste des sequences",
      "'sessions_tournois'" in src_services, None)

check("setval tolere une table vide",
      'COALESCE((SELECT MAX(id)' in src_services, None)

check("un echec de synchronisation est trace, pas avale en silence",
      'sync_sequences' in src_services and 'logger.warning' in src_services, None)


print("\n=== La creation de tournoi fonctionne de bout en bout ===")

# Scenario complet : session creee, referencee, transaction validee.
cli, cur, conn, lots = monter([
    (r"FROM global_resets WHERE date >=", (0,)),
    (r"key = 'league_mode_enabled'", ('false',)),
    (r"FROM grille_snapshots WHERE date", None),
    (r"INSERT INTO sessions_tournois DEFAULT VALUES", (501,)),
    (r"INSERT INTO Tournois", (777,)),
    # Fiche retrouvee sans tenir compte de la casse.
    (r"SELECT id, nom, mu, sigma FROM Joueurs WHERE lower\(nom\)",
     lambda p: (10 + sum(map(ord, p[0])), p[0], 25.0, 8.333)),
    (r"key IN \('ghost_enabled'", [('ghost_enabled', 'false'),
                                   ('unranked_threshold', '5')]),
    (r"SELECT id, sigma, consecutive_missed, is_ranked FROM Joueurs", []),
    (r"SELECT DISTINCT ON \(p.joueur_id\)", []),
    (r"FROM ghost_log g", []),
    (r"key = 'tau'", ('0.083',)),
])
# Deux joueurs minimum.
r = cli.post('/add-tournament', headers=H, json={
    "date": "2026-09-15",
    "joueurs": [{"nom": "A", "score": 100}, {"nom": "B", "score": 80}],
})

executes = sql_joints(cur)
check("une session est ouverte avant le tournoi",
      any('INSERT INTO sessions_tournois DEFAULT VALUES' in s for s in executes),
      [s for s in executes if 'sessions_tournois' in s])

insert_tournoi = [s for s in executes if 'INSERT INTO Tournois' in s]
check("l'INSERT du tournoi porte bien session_id",
      insert_tournoi and 'session_id' in insert_tournoi[0], insert_tournoi)

i_session = next((i for i, s in enumerate(executes)
                  if 'INSERT INTO sessions_tournois' in s), None)
i_tournoi = next((i for i, s in enumerate(executes)
                  if 'INSERT INTO Tournois' in s), None)
check("la session est creee avant le tournoi qui la reference",
      i_session is not None and i_tournoi is not None and i_session < i_tournoi,
      "session=%s tournoi=%s" % (i_session, i_tournoi))


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
