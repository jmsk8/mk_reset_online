"""Audit de l'authentification Discord : ce qui tient, et ce qui ne tient pas.

Ce fichier est le pendant executable de docs/audit-auth-discord.md. Chaque
section porte le numero du constat correspondant (A-xx), et vaut PREUVE : un
constat qu'on ne sait pas faire echouer par execution n'est qu'une opinion.

Deux natures d'assertions cohabitent ici, volontairement :

  - Les assertions de NON-REGRESSION : elles decrivent ce qui est correct
    aujourd'hui et doit le rester (le token n'est jamais stocke en clair, la
    suspension ferme les sessions, le rang est relu a chaque requete...).
  - Les assertions de DEFAUT CONSTATE, marquees `defaut(...)` : elles decrivent
    le comportement ACTUEL, celui qui pose probleme. Elles passent au vert tant
    que le defaut est la. Le jour ou il est corrige, elles virent au rouge et
    nomment le constat a refermer dans le document de suivi -- c'est le but,
    pas un accident.

Aucun Postgres, aucun Discord : le curseur est scripte (harness.py).
"""
from harness import *
from flask import Flask, g
import importlib

# Numeros de constat encore ouverts, pour que l'echec d'un `defaut()` dise quoi
# aller refermer dans docs/audit-auth-discord.md.
A_DUREE_SESSION_FIGEE = "A-01"
A_PAS_DE_REVOCATION_SUR_ROLE = "A-02"
A_AUCUNE_GESTION_DE_SES_SESSIONS = "A-03"
A_ADMIN_AUTH_TOUJOURS_OUVERT = "A-04"
A_TOKEN_ADMIN_EN_CLAIR = "A-05"
A_PAS_DE_ROTATION_A_LA_CONNEXION = "A-06"


def defaut(constat, nom, cond, detail=''):
    """Assertion qui documente un defaut ENCORE PRESENT.

    Verte tant que le defaut existe. Rouge quand il est corrige -- et c'est
    alors le message qui dit ou acter la correction.
    """
    check("[%s, defaut constate] %s" % (constat, nom), cond,
          detail or "corrige ? mettre a jour docs/audit-auth-discord.md (%s)" % constat)


def app_avec(plan, deco_factory):
    """Appli minimale protegee par le decorateur a tester. Calque test_decorators."""
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
print("\n=== A-01 : la duree de session est figee sur le role AU MOMENT DE LA "
      "CONNEXION ===")
# create_session(role) choisit 12 h pour un privilegie et 30 j pour un joueur.
# Le role est lu une seule fois, a la connexion. Une promotion posterieure ne
# raccourcit donc PAS la session deja ouverte : un compte promu admin garde une
# session de 30 jours, trente fois la duree que la regle lui destine.
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

# Le coeur du constat : la duree ne depend QUE du role passe a l'appel. Rien ne
# la revisite ensuite.
defaut(A_DUREE_SESSION_FIGEE,
       "une session ouverte en 'player' reste longue meme apres promotion",
       jours(exp_joueur) > 29,
       "create_session ne lit le role qu'une fois, a la connexion")

# Et l'expiration est ABSOLUE : aucune route ne la prolonge. C'est le bon
# comportement, il doit le rester (c'est ce qui distingue sessions_joueurs de
# l'ancienne api_tokens, renouvelable sans borne).
source_auth = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                '..', 'auth.py'), encoding='utf-8').read()
check("aucune route ne prolonge expires_at (expiration absolue)",
      'SET expires_at' not in source_auth)


# ===========================================================================
print("\n=== A-02 : changer le role d'un compte ne ferme AUCUNE de ses sessions ===")
# Consequence directe de A-01. Un admin retrograde en player garde ses sessions
# ouvertes ; elles ne portent plus aucun droit (le role est relu en base a chaque
# requete, cf. A-07), mais elles gardent la duree COURTE, et surtout le chemin
# inverse est le vrai probleme : promu, il garde une session de 30 jours.
source_comptes = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   '..', 'routes_comptes.py'), encoding='utf-8').read()


def corps_de(source, entete, taille=6000):
    i = source.find(entete)
    return '' if i < 0 else source[i:i + taille]


corps_role = corps_de(source_comptes, "def changer_role(")
check("la route de changement de role existe", bool(corps_role))
defaut(A_PAS_DE_REVOCATION_SUR_ROLE,
       "changer_role ne supprime aucune session",
       'DELETE FROM sessions_joueurs' not in corps_role)

# Par contraste, les deux routes qui DOIVENT fermer les sessions le font bien.
corps_statut = corps_de(source_comptes, "def changer_statut(")
check("suspendre un compte ferme ses sessions (non-regression)",
      'DELETE FROM sessions_joueurs' in corps_statut)
corps_suppr = corps_de(source_comptes, "def supprimer_mon_compte(", 8000)
check("supprimer son compte ferme ses sessions (non-regression)",
      'DELETE FROM sessions_joueurs' in corps_suppr)


# ===========================================================================
print("\n=== A-03 : le titulaire gere ses propres sessions (CORRIGE 2026-09-16) ===")
# Constat d'origine : l'admin pouvait fermer les sessions d'autrui et l'export
# RGPD les listait, mais le titulaire n'avait aucun moyen de les fermer lui-meme.
# Corrige par /auth/mes-sessions (GET + DELETE). Ces assertions sont devenues
# des NON-REGRESSIONS : elles gardent la capacite, elles ne constatent plus un
# defaut. Couverture detaillee dans test_mes_sessions.py.
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
# Sans player_required, ces routes rendraient les sessions de n'importe qui.
# Le decorateur doit se trouver entre la route et le def -- c'est le seul
# endroit ou il s'applique.
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
# Chaque connexion Discord AJOUTE une session sans toucher aux precedentes. Un
# token vole reste donc valide jusqu'a sa date d'expiration, meme si la victime
# se reconnecte dix fois entre-temps. Se reconnecter est pourtant le reflexe
# naturel de qui se croit compromis.
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
# Ces proprietes sont le socle de la resistance au vol de jeton. Elles sont
# correctes aujourd'hui ; ces assertions existent pour qu'elles le restent.
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

# L'echange OAuth ne doit jamais logger le corps des reponses Discord : il
# contient le code d'autorisation et l'access_token.
check("l'echange ne loggue que des codes HTTP, jamais les corps",
      'token_res.status_code' in source_disc and 'token_res.json()' in source_disc
      and 'logger.warning("Echec /oauth2/token (HTTP %s)"' in source_disc)


# ===========================================================================
print("\n=== Le state OAuth protege le callback (non-regression) ===")
# Sans state verifie, un tiers peut faire consommer SON code a la victime et lier
# le navigateur de celle-ci a son propre compte Discord (login CSRF).
# Depuis la correction de B-01 (2026-09-17), la verification ne vit plus dans
# le callback mais dans `_consommer_state` : une case unique a ete remplacee
# par une liste bornee de states en attente. Les garanties, elles, sont les
# memes -- et c'est elles qu'on verifie, pas l'endroit ou elles vivent.
callback = corps_de(front, "def discord_callback(", 2500)
# 2500 et non 1200 : la fenetre etait trop courte des qu'un commentaire
# s'allongeait dans la fonction, et l'assertion « usage unique » virait au rouge
# sur du code pourtant intact -- exactement le piege documente dans
# test_session_expiree.py, qui a fini par passer a un vrai parseur.
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

# L'invitation ne transite PAS par Discord : elle reste en session serveur.
login_front = corps_de(front, "def discord_login(", 1800)
check("l'invitation ne fait pas l'aller-retour par Discord",
      "session['invite_token']" in login_front and "'state': state" in login_front)


# ===========================================================================
print("\n=== A-07 : le rang est relu en base a CHAQUE requete (non-regression) ===")
# C'est la garantie centrale du modele : une session ne porte pas de droits, elle
# porte une identite. Retirer un role prend effet immediatement.
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

# Session expiree : refusee ET supprimee, pas seulement refusee.
cli, auth, cur_exp = app_avec(
    [(r"FROM sessions_joueurs s JOIN comptes c",
      ligne_session(joueur_id=9, role='admin', expires_at=PASSE))],
    lambda a: a.role_required('admin'))
r = cli.get('/protege', headers={'X-Session-Token': 'x'})
check("une session expiree est refusee (401)", r.status_code == 401)
check("et supprimee de la base au passage",
      any('DELETE FROM sessions_joueurs' in s for s, _ in cur_exp.executed))

# Compte suspendu : la session existe encore mais ne vaut plus rien.
cli, auth, _ = app_avec(
    [(r"FROM sessions_joueurs s JOIN comptes c",
      ligne_session(joueur_id=9, role='admin', statut='suspended'))],
    lambda a: a.role_required('admin'))
check("un compte suspendu est refuse meme avec une session valide (403)",
      cli.get('/protege', headers={'X-Session-Token': 'x'}).status_code == 403)

# Base indisponible : 503, JAMAIS 401/403 -- sinon le frontend purge la session
# de tout le monde a chaque hoquet de la base.
import contextlib
import types as _types
recharger()
_fake = _types.ModuleType('db')


@contextlib.contextmanager
def _boom():
    raise RuntimeError("base injoignable")
    yield


_fake.get_db_connection = _boom
_fake.ADMIN_PASSWORD_HASH = b'x'
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
print("\n=== A-04 / A-05 : l'authentification par mot de passe partage survit ===")
# La bascule est faite cote ROUTES (plus aucun usage d'admin_or_role_required),
# mais l'endpoint de connexion, lui, est toujours ouvert et delivre encore des
# jetons stockes EN CLAIR dans api_tokens.
source_admin = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 '..', 'routes_admin.py'), encoding='utf-8').read()

check("plus aucune route metier n'accepte le mot de passe partage",
      '@admin_or_role_required' not in source_admin
      and '@admin_or_role_required' not in source_comptes)

defaut(A_ADMIN_AUTH_TOUJOURS_OUVERT,
       "/admin-auth est toujours expose et delivre un jeton",
       "'/admin-auth'" in source_admin)
defaut(A_TOKEN_ADMIN_EN_CLAIR,
       "api_tokens stocke le jeton EN CLAIR (pas de hash)",
       'INSERT INTO api_tokens (token, expires_at)' in source_admin)
defaut(A_TOKEN_ADMIN_EN_CLAIR,
       "/admin/refresh-token prolonge indefiniment (pas d'expiration absolue)",
       "'/admin/refresh-token'" in source_admin)

# Le jeton ainsi obtenu n'ouvre plus rien d'UTILE cote backend : @admin_required
# ne protege plus qu'une seule route, et c'est celle qui renouvelle le jeton
# lui-meme. C'est ce qui rend le defaut moins grave qu'il n'y parait -- mais le
# chemin reste vivant, d'ou A-04. On le prouve plutot que de l'affirmer.
#
# Le decorateur est pose AVANT le `def`, donc on cherche dans le bloc qui
# precede la definition, pas dans son corps.
avant_refresh = source_admin[:source_admin.find("def refresh_token(")]
bloc_refresh = avant_refresh[avant_refresh.rfind('@admin_bp.route'):]
check("le seul @admin_required restant est sur /admin/refresh-token",
      source_admin.count('\n@admin_required') == 1
      and '@admin_required' in bloc_refresh
      and "'/admin/refresh-token'" in bloc_refresh)
check("aucune route METIER ne porte @admin_required",
      '@admin_required' not in source_comptes)

# En revanche, cote FRONTEND, ce jeton ouvre encore la porte d'interface.
check("_est_admin() accepte encore un simple admin_token",
      "bool(session.get('admin_token'))" in corps_de(front, "def _est_admin(", 900))
defaut(A_ADMIN_AUTH_TOUJOURS_OUVERT,
       "le formulaire /admin (mot de passe) est toujours servi",
       "def admin_login(" in front and "'/admin-auth'" in front)


# ===========================================================================
print("\n=== Invitations : consommation et idempotence (non-regressions) ===")
# La consommation n'a lieu QU'a l'echange, jamais a l'affichage : un lien colle
# dans un salon Discord declenche un GET du crawler, qui brulerait un lien
# max_uses=1 avant le premier clic humain.
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

# Un compte deja existant n'a pas besoin d'invitation : l'echange est rejouable.
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
# DISCORD_SUPERADMIN_ID ne doit jamais etre une porte derobee permanente.
os.environ['DISCORD_SUPERADMIN_ID'] = '123456789012345678'
recharger()
install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", None),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (1,)),   # un superadmin existe
])
import auth_discord
importlib.reload(auth_discord)
try:
    auth_discord.login('c', None, 'UA')
    check("porte d'amorcage refermee quand un superadmin existe", False, "accepte a tort")
except auth_discord.DiscordAuthError as e:
    check("porte d'amorcage refermee quand un superadmin existe",
          e.code == 'invitation_requise', e.code)

# Un autre compte Discord n'en profite jamais.
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
# Le snowflake finit dans un chemin d'URL (CDN avatar) : il doit etre valide.
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

# Un hash d'avatar douteux degrade l'affichage, il ne bloque pas la connexion.
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

# Les champs texte sont tronques avant d'aller en base (colonnes varchar(64)).
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
print("\n=== Rang : la regle generique de compte_cible_protegee (non-regression) ===")
# rang(acteur) > rang(cible) -> autorise. L'egalite refuse, entre pairs compris.
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

# Role inconnu en base : defaut ferme des DEUX cotes.
r = app_cible('admin', 'role_corrompu').post('/agir/2', headers={'X-Session-Token': 'x'})
check("un role de cible inconnu vaut le rang le plus HAUT (intouchable)",
      r.status_code == 403, r.status_code)
r = app_cible('role_corrompu', 'player').post('/agir/2', headers={'X-Session-Token': 'x'})
check("un role d'acteur inconnu vaut le rang le plus BAS (ne peut rien)",
      r.status_code == 403, r.status_code)


# ===========================================================================
print("\n=== Les 4 routes d'ecriture sur un compte portent bien le garde ===")
# C'est la correction du 2026-09-14 : un admin porteur de gestion_comptes
# pouvait agir sur un pair admin. Le garde doit rester pose sur les quatre.
for route in ('synchroniser_profil', 'delier_compte', 'changer_statut',
              'revoquer_sessions', 'changer_role'):
    corps = source_comptes[:source_comptes.find("def %s(" % route)]
    dernier_bloc = corps[corps.rfind('@comptes_bp.route'):]
    check("%s est protegee par compte_cible_protegee" % route,
          '@compte_cible_protegee' in dernier_bloc)

# Lecture : PAS de garde, voir n'est pas agir.
corps = source_comptes[:source_comptes.find("def lister_permissions(")]
check("lister_permissions (lecture seule) n'a pas le garde",
      '@compte_cible_protegee' not in corps[corps.rfind('@comptes_bp.route'):])


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(1 for o in OK if o), len(OK)))
if not all(OK):
    sys.exit(1)
