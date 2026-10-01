"""Authentification Discord : non-regressions, et defauts encore presents
marques `defaut(...)` (verts tant que le defaut existe, rouges une fois corrige)."""
from harness import *
from flask import Flask, g
import importlib

# Constats encore ouverts.
A_DUREE_SESSION_FIGEE = "A-01"
A_PAS_DE_REVOCATION_SUR_ROLE = "A-02"
A_AUCUNE_GESTION_DE_SES_SESSIONS = "A-03"
A_PAS_DE_ROTATION_A_LA_CONNEXION = "A-06"


def defaut(constat, nom, cond, detail=''):
    """Assertion sur un defaut encore present : verte tant qu'il existe."""
    check("[%s, defaut constate] %s" % (constat, nom), cond,
          detail or "corrige ? mettre a jour docs/audit-auth-discord.md (%s)" % constat)


def app_avec(plan, deco_factory):
    """Appli minimale protegee par le decorateur a tester."""
    cur, conn = install_db(plan)
    recharger()
    import auth
    importlib.reload(auth)
    app = Flask(__name__)

    @app.route('/protege')
    @deco_factory(auth)
    def protege():
        from flask import jsonify
        return jsonify({"role": getattr(g, 'compte', {}).get('role')})
    return app.test_client(), auth, cur


# ===========================================================================
print("\n=== A-01 : la duree de session suit le role (CORRIGE 2026-09-22) ===")
# Duree de session : 12 h pour un privilegie, 30 j pour un joueur.
recharger()
install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", (42, 'linked')),
    (r"INSERT INTO comptes", ligne_compte(joueur_id=9, statut='linked', role='player')),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (0,)),
])
import auth_discord
importlib.reload(auth_discord)
import constants

_, exp_joueur = auth_discord.create_session(cur, 42, 'player', 'UA')
_, exp_admin = auth_discord.create_session(cur, 42, 'admin', 'UA')
_, exp_chef = auth_discord.create_session(cur, 42, 'chef_admin', 'UA')
_, exp_super = auth_discord.create_session(cur, 42, 'superadmin', 'UA')

maintenant = datetime.now(timezone.utc)
jours = lambda e: (e - maintenant).total_seconds() / 86400.0

check("session joueur ~ 30 j", 29.9 < jours(exp_joueur) < 30.1, jours(exp_joueur))
check("session admin ~ 12 h", 0.49 < jours(exp_admin) < 0.51, jours(exp_admin))
check("chef_admin herite de la session courte", jours(exp_chef) < 1.0)
check("superadmin herite de la session courte", jours(exp_super) < 1.0)

# La duree depend du role a la creation ; toute ecriture de comptes.role ferme
# les sessions (voir test_sessions_changement_role.py).
check("la duree reste figee a la creation, sur le role du moment (non-regression)",
      jours(exp_joueur) > 29)
_sources_back = ''.join(
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', f),
         encoding='utf-8').read()
    for f in ('auth.py', 'auth_discord.py', 'routes_auth.py', 'routes_comptes.py'))
check("A-01 corrige par la fermeture, JAMAIS par un recalcul d'expires_at "
      "(une seconde source de verite sur la duree a produit le defaut)",
      not re.search(r"UPDATE\s+sessions_joueurs\s+SET\s+expires_at", _sources_back))

# Expiration absolue, jamais prolongee.
source_auth = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                '..', 'auth.py'), encoding='utf-8').read()
check("aucune route ne prolonge expires_at (expiration absolue)",
      'SET expires_at' not in source_auth)


# ===========================================================================
print("\n=== A-02 : changer le role d'un compte ferme ses sessions (CORRIGE 2026-09-22) ===")
# Detail dans test_sessions_changement_role.py.
source_comptes = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   '..', 'routes_comptes.py'), encoding='utf-8').read()


def corps_de(source, entete, taille=6000):
    i = source.find(entete)
    return '' if i < 0 else source[i:i + taille]


def fonction(source, nom):
    """Source exacte de la fonction `nom`, delimitee par ast ('' si absente)."""
    import ast
    lignes = source.splitlines(keepends=True)
    for n in ast.walk(ast.parse(source)):
        if isinstance(n, ast.FunctionDef) and n.name == nom:
            return ''.join(lignes[n.lineno - 1:n.end_lineno])
    return ''


corps_role = fonction(source_comptes, "changer_role")
check("la route de changement de role existe", bool(corps_role))
check("changer_role ferme les sessions de la cible (A-02 corrige)",
      'DELETE FROM sessions_joueurs WHERE compte_id' in corps_role)
check("accepter une promotion ferme les sessions du titulaire (A-01 corrige)",
      'DELETE FROM sessions_joueurs WHERE compte_id'
      in fonction(source_comptes, "repondre_promotion"))

corps_statut = fonction(source_comptes, "changer_statut")
check("suspendre un compte ferme ses sessions (non-regression)",
      'DELETE FROM sessions_joueurs' in corps_statut)
corps_suppr = fonction(source_comptes, "_effacer_compte")
check("supprimer un compte ferme ses sessions (non-regression)",
      'DELETE FROM sessions_joueurs' in corps_suppr)


# ===========================================================================
print("\n=== A-03 : le titulaire gere ses propres sessions (CORRIGE 2026-09-16) ===")
# Detail dans test_mes_sessions.py.
check("un admin peut fermer les sessions d'un compte (non-regression)",
      "/admin/comptes/<int:compte_id>/sessions" in source_comptes)
check("l'export RGPD liste bien les sessions actives (non-regression)",
      'sessions_actives' in source_comptes)

routes_auth_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    '..', 'routes_auth.py'), encoding='utf-8').read()
check("le titulaire peut LISTER ses sessions (A-03 corrige)",
      "@auth_bp.route('/auth/mes-sessions', methods=['GET'])" in routes_auth_src)
check("le titulaire peut FERMER ses autres sessions (A-03 corrige)",
      "@auth_bp.route('/auth/mes-sessions', methods=['DELETE'])" in routes_auth_src)
# player_required entre la route et le def.
for _route, _fn in (("methods=['GET'])", 'def mes_sessions('),
                    ("methods=['DELETE'])", 'def fermer_mes_sessions(')):
    _i = routes_auth_src.find('/auth/mes-sessions')
    _debut = routes_auth_src.find(_route, _i)
    check("%s est protegee par player_required" % _fn[4:-1],
          '@player_required' in routes_auth_src[_debut:routes_auth_src.find(_fn, _debut)])
check("/auth/logout ne ferme toujours QUE la session courante (non-regression)",
      'WHERE token_hash = %s' in corps_de(routes_auth_src, "def logout(", 900))


# ===========================================================================
print("\n=== A-06 : pas de rotation de session a la connexion ===")
# Chaque connexion ajoute une session sans toucher aux precedentes.
recharger()
install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", (42, 'linked')),
    (r"INSERT INTO comptes", ligne_compte(joueur_id=9, statut='linked')),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (0,)),
])
import auth_discord
importlib.reload(auth_discord)
res = auth_discord.login('code', None, 'UA')
sqls = [s for s, _ in cur.executed]

check("une session est bien creee a la connexion", any('INSERT INTO sessions_joueurs' in s for s in sqls))
suppressions = [s for s in sqls if 'DELETE FROM sessions_joueurs' in s]
check("le menage opportuniste ne vise que les sessions EXPIREES",
      all('expires_at < now()' in s for s in suppressions), suppressions)
defaut(A_PAS_DE_ROTATION_A_LA_CONNEXION,
       "se reconnecter n'invalide aucune session existante du compte",
       not any('DELETE FROM sessions_joueurs WHERE compte_id' in s for s in sqls))


# ===========================================================================
print("\n=== Vol de token : ce qui protege deja (non-regressions) ===")
check("le token de session n'est stocke qu'en sha256",
      all(res['session_token'] not in str(p) for _, p in cur.executed))
check("le token est tire de secrets.token_urlsafe (>= 32 octets d'entropie)",
      len(res['session_token']) >= 40, len(res['session_token']))

source_disc = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                '..', 'auth_discord.py'), encoding='utf-8').read()
check("hash_token utilise sha256", 'hashlib.sha256' in source_disc)
check("le secret Discord ne quitte jamais le backend",
      'DISCORD_CLIENT_SECRET' in source_disc)
front = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          '..', '..', 'frontEnd', 'frontend.py'), encoding='utf-8').read()
check("le frontend ne connait AUCUN secret Discord",
      'DISCORD_CLIENT_SECRET' not in front)
check("le token de session ne descend jamais dans le DOM (session serveur)",
      "session['player_token']" in front)

# Jamais le corps des reponses Discord dans les logs.
check("l'echange ne loggue que des codes HTTP, jamais les corps",
      'token_res.status_code' in source_disc and 'token_res.json()' in source_disc
      and 'logger.warning("Echec /oauth2/token (HTTP %s)"' in source_disc)


# ===========================================================================
print("\n=== Le state OAuth protege le callback (non-regression) ===")
# Le state OAuth (verifie dans _consommer_state) protege contre le login CSRF.
callback = corps_de(front, "def discord_callback(", 2500)
consommer = corps_de(front, "def _consommer_state(", 2500)
check("le state est compare en temps constant",
      'secrets.compare_digest' in consommer)
check("le state est a usage unique (retire de la liste une fois reconnu)",
      'del en_attente[i]' in consommer)
check("un state absent ou vide est refuse",
      'if not recu:' in consommer and 'return False' in consommer)
check("le callback delegue bien a cette verification",
      '_consommer_state(state)' in callback)
check("le cookie de session est HttpOnly",
      "SESSION_COOKIE_HTTPONLY'] = True" in front)
check("le cookie est SameSite=Lax (Strict casserait le retour de Discord)",
      "SESSION_COOKIE_SAMESITE'] = 'Lax'" in front)
check("le cookie passe en Secure des que le site est en https",
      "SESSION_COOKIE_SECURE'] = (os.environ.get('TLS_MODE'" in front)
check("CSRF global actif sur le frontend", 'CSRFProtect(app)' in front)

login_front = corps_de(front, "def discord_login(", 1800)
check("l'invitation ne fait pas l'aller-retour par Discord",
      "session['invite_token']" in login_front and "'state': state" in login_front)


# ===========================================================================
print("\n=== A-07 : le rang est relu en base a CHAQUE requete (non-regression) ===")
# Une session porte une identite, pas des droits.
cli, auth, cur_deco = app_avec(
    [(r"FROM sessions_joueurs s JOIN comptes c", ligne_session(joueur_id=9, role='player'))],
    lambda a: a.role_required('admin'))
r = cli.get('/protege', headers={'X-Session-Token': 'peu-importe'})
check("un player est refuse sur une route admin (403)", r.status_code == 403)
check("le role vient de la jointure en base, pas du token",
      any('FROM sessions_joueurs s JOIN comptes c' in s for s, _ in cur_deco.executed))

cli, auth, _ = app_avec(
    [(r"FROM sessions_joueurs s JOIN comptes c", ligne_session(joueur_id=9, role='superadmin'))],
    lambda a: a.role_required('admin'))
check("un superadmin satisfait une exigence d'admin (hierarchie)",
      cli.get('/protege', headers={'X-Session-Token': 'x'}).status_code == 200)

# Session expiree : refusee et supprimee.
cli, auth, cur_exp = app_avec(
    [(r"FROM sessions_joueurs s JOIN comptes c",
      ligne_session(joueur_id=9, role='admin', expires_at=PASSE))],
    lambda a: a.role_required('admin'))
r = cli.get('/protege', headers={'X-Session-Token': 'x'})
check("une session expiree est refusee (401)", r.status_code == 401)
check("et supprimee de la base au passage",
      any('DELETE FROM sessions_joueurs' in s for s, _ in cur_exp.executed))

cli, auth, _ = app_avec(
    [(r"FROM sessions_joueurs s JOIN comptes c",
      ligne_session(joueur_id=9, role='admin', statut='suspended'))],
    lambda a: a.role_required('admin'))
check("un compte suspendu est refuse meme avec une session valide (403)",
      cli.get('/protege', headers={'X-Session-Token': 'x'}).status_code == 403)

# Base indisponible : 503, jamais 401/403.
import contextlib
import types as _types
recharger()
_fake = _types.ModuleType('db')


@contextlib.contextmanager
def _boom():
    raise RuntimeError("base injoignable")
    yield


_fake.get_db_connection = _boom
sys.modules['db'] = _fake
import auth as _auth
importlib.reload(_auth)
_app = Flask(__name__)


@_app.route('/p')
@_auth.role_required('admin')
def _p():
    return 'ok'


r = _app.test_client().get('/p', headers={'X-Session-Token': 'x'})
check("base injoignable -> 503, jamais 401/403 (R-28)", r.status_code == 503)


# ===========================================================================
print("\n=== A-04 / A-05 : refermes -- le mot de passe partage a disparu ===")
# Plus de secret partage, de jeton stocke en clair ni de renouvellement sans borne.
source_admin = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 '..', 'routes_admin.py'), encoding='utf-8').read()
source_auth = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                '..', 'auth.py'), encoding='utf-8').read()

check("[A-04] l'endpoint de connexion par mot de passe n'existe plus",
      "'/admin-auth'" not in source_admin)
check("[A-04] son decorateur non plus, nulle part",
      'admin_required' not in source_admin and 'admin_required' not in source_auth
      and 'admin_required' not in source_comptes)
check("[A-05] plus aucun jeton admin n'est ecrit en base",
      'INSERT INTO api_tokens' not in source_admin)
check("[A-05] plus aucune route ne prolonge un jeton",
      "'/admin/refresh-token'" not in source_admin)

check("[A-04] _est_admin() ne connait plus que le role",
      'admin_token' not in corps_de(front, "def _est_admin(", 900))
check("[A-04] le formulaire /admin n'est plus servi",
      "def admin_login(" not in front and "'/admin-auth'" not in front)

# sessions_joueurs : empreinte seule et expiration absolue.
check("sa remplacante ne stocke que l'empreinte du jeton",
      'hash_token(token)' in open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                               '..', 'auth_discord.py'),
                                  encoding='utf-8').read())


# ===========================================================================
print("\n=== Invitations : consommation et idempotence (non-regressions) ===")
# Consommation a l'echange seulement (les apercus de lien font un GET).
lire = corps_de(routes_auth_src, "def lire_invitation(", 2000)
check("la lecture d'invitation n'ecrit rien",
      'UPDATE invitations' not in lire and 'INSERT INTO' not in lire)
check("l'invitation n'est stockee qu'en sha256",
      'hash_token(token)' in lire)
creer = corps_de(routes_auth_src, "def creer_invitation(", 2500)
check("le token d'invitation n'est montre qu'a la creation",
      'secrets.token_urlsafe(32)' in creer and 'hash_token(token)' in creer)
lister = corps_de(routes_auth_src, "def lister_invitations(", 1800)
check("la liste des invitations ne renvoie jamais de token",
      'token_hash' not in lister.split('return')[0].split('SELECT')[-1]
      or 'i.token' not in lister)

# Compte existant : pas d'invitation requise.
recharger()
install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", (42, 'linked')),
    (r"INSERT INTO comptes", ligne_compte(joueur_id=9, statut='linked')),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (0,)),
])
import auth_discord
importlib.reload(auth_discord)
auth_discord.login('c', None, 'UA')
check("un compte existant ne reconsomme aucune invitation (idempotence R-11)",
      not any('UPDATE invitations' in s for s, _ in cur.executed))


# ===========================================================================
print("\n=== Amorcage du superadmin : la porte se referme (non-regression) ===")
os.environ['DISCORD_SUPERADMIN_ID'] = '123456789012345678'
recharger()
install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", None),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (1,)),  # un superadmin existe
])
import auth_discord
importlib.reload(auth_discord)
try:
    auth_discord.login('c', None, 'UA')
    check("porte d'amorcage refermee quand un superadmin existe", False, "accepte a tort")
except auth_discord.DiscordAuthError as e:
    check("porte d'amorcage refermee quand un superadmin existe",
          e.code == 'invitation_requise', e.code)

recharger()
install_discord(profil={'id': '999999999999999999', 'username': 'x',
                        'global_name': 'X', 'avatar': None})
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", None),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (0,)),
])
import auth_discord
importlib.reload(auth_discord)
try:
    auth_discord.login('c', None, 'UA')
    check("un autre discord_id reste soumis a invitation", False, "accepte a tort")
except auth_discord.DiscordAuthError as e:
    check("un autre discord_id reste soumis a invitation",
          e.code == 'invitation_requise', e.code)
os.environ.pop('DISCORD_SUPERADMIN_ID', None)


# ===========================================================================
print("\n=== Entrees Discord non fiables : validation avant usage (non-regression) ===")
# Snowflake valide avant d'etre mis dans une URL.
recharger()
install_discord(profil={'id': '../../etc/passwd', 'username': 'x',
                        'global_name': 'X', 'avatar': 'a'})
cur, conn = install_db([])
import auth_discord
importlib.reload(auth_discord)
try:
    auth_discord.exchange_code('c')
    check("un discord_id non numerique est refuse", False, "accepte a tort")
except auth_discord.DiscordAuthError as e:
    check("un discord_id non numerique est refuse", e.code == 'profil_illisible', e.code)

# Hash d'avatar douteux : connexion acceptee, avatar par defaut.
recharger()
install_discord(profil={'id': '123456789012345678', 'username': 'x',
                        'global_name': 'X', 'avatar': '../../evil.png'})
cur, conn = install_db([])
import auth_discord
importlib.reload(auth_discord)
profil = auth_discord.exchange_code('c')
check("un hash d'avatar invalide est ignore, la connexion continue",
      profil['avatar_hash'] is None)
check("l'URL de repli ne contient alors aucune valeur distante",
      '..' not in auth_discord.avatar_url(profil['discord_id'], profil['avatar_hash']))

# Champs texte tronques (varchar(64)).
recharger()
install_discord(profil={'id': '123456789012345678', 'username': 'u' * 500,
                        'global_name': 'g' * 500, 'avatar': None})
cur, conn = install_db([])
import auth_discord
importlib.reload(auth_discord)
profil = auth_discord.exchange_code('c')
check("username tronque a 64", len(profil['username']) == 64)
check("global_name tronque a 64", len(profil['global_name']) == 64)


# ===========================================================================
print("\n=== redirect_uri : seules celles de l'environnement partent a Discord ===")
# Le backend n'accepte qu'une URI de la liste.
_uri_env = os.environ['DISCORD_REDIRECT_URI']
os.environ['DISCORD_REDIRECT_URI'] = 'http://localhost/cb, http://192.168.1.65/cb'

def _echange(redirect_uri):
    recharger()
    calls = install_discord()
    install_db([])
    import auth_discord
    importlib.reload(auth_discord)
    try:
        auth_discord.exchange_code('c', redirect_uri)
    except auth_discord.DiscordAuthError as e:
        return e.code, calls
    return None, calls

err, calls = _echange('http://192.168.1.65/cb')
check("une URI de la liste est transmise telle quelle a /oauth2/token",
      err is None and calls[0][2]['data']['redirect_uri'] == 'http://192.168.1.65/cb',
      (err, calls[:1]))
err, calls = _echange(None)
check("sans URI transmise, la premiere de la liste",
      err is None and calls[0][2]['data']['redirect_uri'] == 'http://localhost/cb',
      (err, calls[:1]))
err, calls = _echange('http://evil.test/cb')
check("une URI hors liste est refusee avant tout appel a Discord",
      err == 'redirect_uri_inconnue' and not calls, (err, calls))
os.environ['DISCORD_REDIRECT_URI'] = _uri_env
recharger()


# ===========================================================================
print("\n=== Rang : la regle generique de compte_cible_protegee (non-regression) ===")
# rang(acteur) > rang(cible) -> autorise ; l'egalite refuse.
def app_cible(role_acteur, role_cible):
    cur, conn = install_db([
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=1, joueur_id=9, role=role_acteur)),
        (r"SELECT role FROM comptes WHERE id", (role_cible,)),
    ])
    recharger()
    import auth
    importlib.reload(auth)
    app = Flask(__name__)

    @app.route('/agir/<int:compte_id>', methods=['POST'])
    @auth.role_required('admin')
    @auth.compte_cible_protegee
    def agir(compte_id):
        from flask import jsonify
        return jsonify({"ok": True})
    return app.test_client()


for acteur, cible, attendu, libelle in [
    ('admin', 'player', 200, "admin -> player : autorise"),
    ('admin', 'admin', 403, "admin -> admin (pair) : REFUSE"),
    ('admin', 'chef_admin', 403, "admin -> chef_admin : refuse"),
    ('admin', 'superadmin', 403, "admin -> superadmin : refuse"),
    ('chef_admin', 'admin', 200, "chef_admin -> admin : autorise"),
    ('chef_admin', 'chef_admin', 403, "chef_admin -> chef_admin (pair) : REFUSE"),
    ('chef_admin', 'superadmin', 403, "chef_admin -> superadmin : refuse"),
    ('superadmin', 'chef_admin', 200, "superadmin -> chef_admin : autorise"),
    ('superadmin', 'superadmin', 403, "superadmin -> superadmin : refuse"),
]:
    r = app_cible(acteur, cible).post('/agir/2', headers={'X-Session-Token': 'x'})
    check(libelle, r.status_code == attendu, r.status_code)

# Role inconnu : defaut ferme des deux cotes.
r = app_cible('admin', 'role_corrompu').post('/agir/2', headers={'X-Session-Token': 'x'})
check("un role de cible inconnu vaut le rang le plus HAUT (intouchable)",
      r.status_code == 403, r.status_code)
r = app_cible('role_corrompu', 'player').post('/agir/2', headers={'X-Session-Token': 'x'})
check("un role d'acteur inconnu vaut le rang le plus BAS (ne peut rien)",
      r.status_code == 403, r.status_code)


# ===========================================================================
print("\n=== Les 4 routes d'ecriture sur un compte portent bien le garde ===")
for route in ('synchroniser_profil', 'delier_compte', 'changer_statut',
              'revoquer_sessions', 'changer_role', 'supprimer_compte'):
    corps = source_comptes[:source_comptes.find("def %s(" % route)]
    dernier_bloc = corps[corps.rfind('@comptes_bp.route'):]
    check("%s est protegee par compte_cible_protegee" % route,
          '@compte_cible_protegee' in dernier_bloc)

# Lecture : pas de garde.
corps = source_comptes[:source_comptes.find("def lister_permissions(")]
check("lister_permissions (lecture seule) n'a pas le garde",
      '@compte_cible_protegee' not in corps[corps.rfind('@comptes_bp.route'):])


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(1 for o in OK if o), len(OK)))
if not all(OK):
    sys.exit(1)
