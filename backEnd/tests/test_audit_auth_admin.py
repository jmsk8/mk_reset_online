"""Audit auth Discord + administration, second passage (2026-09-17).

Pendant executable de docs/audit-auth-admin-2026-09-17.md. Chaque section porte
le numero du constat (B-xx), et vaut PREUVE : un constat qu'on ne sait pas faire
echouer par execution n'est qu'une opinion.

Meme convention que test_audit_auth_discord.py, dont ce fichier est la suite :

  - les assertions de NON-REGRESSION decrivent ce qui est correct et doit le
    rester ;
  - les assertions `defaut(...)` decrivent le comportement ACTUEL, celui qui
    pose probleme. Elles sont vertes TANT QUE le defaut est la. Le jour ou il
    est corrige, elles virent au rouge et nomment le constat a refermer.

Une ligne rouge marquee [B-xx, defaut constate] est une BONNE NOUVELLE.

Aucun Postgres, aucun Discord : le curseur est scripte (harness.py). Ce que ce
fichier ne prouve donc PAS : les verrous SQL, les contraintes et l'index
partiel, qui sont lus et raisonnes, jamais executes.
"""
from harness import *
from flask import Flask
import importlib
import secrets as _secrets
from urllib.parse import urlencode, urlparse, parse_qs

# Constats ouverts, pour que l'echec d'un `defaut()` dise quoi aller refermer.
B_STATE_CASE_UNIQUE = "B-01"
B_SUPERADMIN_SE_VERROUILLE = "B-02"
B_STATUT_SANS_GARDE = "B-03"


def _leve(appel):
    """Vrai si l'appel leve une exception. Pour verifier un refus a la
    definition (ValueError) plutot qu'a l'execution."""
    try:
        appel()
        return False
    except Exception:
        return True


def defaut(constat, nom, cond, detail=''):
    """Assertion qui documente un defaut ENCORE PRESENT.

    Verte tant que le defaut existe. Rouge quand il est corrige -- et c'est
    alors le message qui dit ou acter la correction.
    """
    check("[%s, defaut constate] %s" % (constat, nom), cond,
          detail or "corrige ? mettre a jour docs/audit-auth-admin-2026-09-17.md (%s)" % constat)


def monter_comptes(plan):
    """Appli minimale portant routes_comptes, sur un curseur scripte."""
    cur, conn = install_db(plan)
    recharger()
    sys.modules.pop('routes_comptes', None)
    import auth
    importlib.reload(auth)
    import routes_comptes
    importlib.reload(routes_comptes)
    # Le cache memoire n'a rien a faire dans un test d'autorisation.
    routes_comptes.invalidate_cache = lambda *a, **k: None
    app = Flask(__name__)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client(), cur, conn


H = {'X-Session-Token': 'tok'}


# ===========================================================================
# B-01 -- Le `state` OAuth est une case unique en session.
#
# Reproduit le couple discord_login / discord_callback du frontend a
# l'identique (frontEnd/frontend.py). On ne teste pas le frontend lui-meme :
# il exige SECRET_KEY, BACKEND_URL et un backend joignable. On teste le
# MECANISME, qui est integralement contenu dans ces deux gestes :
#
#     session['oauth_state'] = state        (ecrase)
#     attendu = session.pop('oauth_state')  (consomme, meme en cas d'echec)
# ===========================================================================
print("\n=== B-01 : le state OAuth est une case unique ===")

_app = Flask(__name__)
_app.secret_key = 'audit'


@_app.route('/login')
def _login():
    from flask import session, redirect
    state = _secrets.token_urlsafe(24)
    session['oauth_state'] = state      # <-- ecrase la valeur precedente
    session.permanent = True
    return redirect("https://discord.test/?" + urlencode({'state': state}))


@_app.route('/callback')
def _callback():
    from flask import session, request
    state = request.args.get('state')
    attendu = session.pop('oauth_state', None)   # <-- consomme meme si echec
    if not state or not attendu or not _secrets.compare_digest(state, attendu):
        return "ECHEC", 400
    return "OK", 200


def _state_de(reponse):
    return parse_qs(urlparse(reponse.headers['Location']).query)['state'][0]


# --- 1) Deux connexions en parallele s'annulent ---------------------------
cli = _app.test_client()
s1 = _state_de(cli.get('/login'))        # onglet 1
s2 = _state_de(cli.get('/login'))        # onglet 2 : ecrase le state du 1
r_onglet1 = cli.get('/callback?state=' + s1)

check("deux connexions produisent bien deux states distincts", s1 != s2)
defaut(B_STATE_CASE_UNIQUE,
       "terminer dans le PREMIER onglet echoue (son state a ete ecrase)",
       r_onglet1.status_code == 400,
       "le state du 1er onglet est de nouveau accepte : plusieurs states en attente ?")

# Le dernier state, lui, fonctionne : le defaut n'est pas « rien ne marche »,
# c'est « seule la derniere tentative marche ». D'ou l'apparence d'aleatoire.
cli = _app.test_client()
_state_de(cli.get('/login'))
s_dernier = _state_de(cli.get('/login'))
check("le DERNIER state fonctionne (le defaut est selectif, pas total)",
      cli.get('/callback?state=' + s_dernier).status_code == 200)


# --- 2) Un echec en provoque un second ------------------------------------
# Le pop() vide la case meme quand la comparaison echoue. Le callback suivant,
# y compris avec un state valide, trouve alors attendu=None.
cli = _app.test_client()
s_perime = _state_de(cli.get('/login'))
s_valide = _state_de(cli.get('/login'))

r_premier = cli.get('/callback?state=' + s_perime)    # echoue (state ecrase)
r_second = cli.get('/callback?state=' + s_valide)     # devrait marcher

check("la premiere tentative echoue (state perime)", r_premier.status_code == 400)
defaut(B_STATE_CASE_UNIQUE,
       "un echec CONSOMME le state : la tentative suivante echoue AUSSI, "
       "meme avec le bon state",
       r_second.status_code == 400,
       "le state n'est plus consomme en cas d'echec : B-01.2 corrige ?")

# Non-regression a preserver pendant la correction : quoi qu'il arrive, un
# state rejoue ne doit JAMAIS repasser. C'est ce que le pop() protege, et la
# correction ne doit pas l'echanger contre le confort.
cli = _app.test_client()
s = _state_de(cli.get('/login'))
check("premier usage du state accepte", cli.get('/callback?state=' + s).status_code == 200)
check("REJEU du meme state refuse (usage unique -- a preserver)",
      cli.get('/callback?state=' + s).status_code == 400)
check("state absent refuse", cli.get('/callback').status_code == 400)
check("state vide refuse", cli.get('/callback?state=').status_code == 400)


# ===========================================================================
# B-02a -- Le superadmin peut supprimer son propre compte.
#
# DELETE /me est decoree @player_required SEUL : elle ne lit jamais le role.
# Resultat : plus aucun superadmin en base, donc plus aucune attribution de
# role, plus de legs, plus de jetons de bot, plus de purge RGPD.
# ===========================================================================
print("\n=== B-02a : le superadmin supprime son propre compte ===")

cli, cur, conn = monter_comptes([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"INSERT INTO audit_admin", None),
    (r"DELETE FROM", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.delete('/me', headers=H)
sqls = [s for s, _ in cur.executed]

defaut(B_SUPERADMIN_SE_VERROUILLE,
       "DELETE /me par le SUPERADMIN -> 200 (aucune garde de rang)",
       r.status_code == 200,
       "une garde refuse maintenant la suppression du dernier superadmin ?")
defaut(B_SUPERADMIN_SE_VERROUILLE,
       "la ligne comptes est reellement supprimee",
       any('DELETE FROM comptes' in s for s in sqls))
check("aucun COUNT des superadmins restants n'est effectue",
      not any('COUNT(*)' in s and 'superadmin' in s.lower() for s in sqls))

# Contraste : la meme protection existe pourtant ailleurs, et fonctionne.
cli, cur, conn = monter_comptes([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('superadmin',)),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (0,)),
])
r = cli.post('/admin/comptes/2/role', json={'role': 'player'}, headers=H)
check("NON-REGRESSION : changer_role refuse bien de retrograder le dernier "
      "superadmin (409)",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'dernier_superadmin',
      r.get_json())


# ===========================================================================
# B-02b / B-03 -- Le superadmin peut se suspendre lui-meme.
#
# PIRE que la suppression : le compte EXISTE toujours, donc l'amorcage par
# DISCORD_SUPERADMIN_ID ne rattrape rien (peut_amorcer_sans_invitation n'est
# consultee que pour un compte INEXISTANT), et login() refuse en amont sur le
# statut 'suspended'. Seul un UPDATE SQL en production repare.
# ===========================================================================
print("\n=== B-02b : le superadmin se suspend lui-meme (irrattrapable) ===")

cli, cur, conn = monter_comptes([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT statut FROM comptes WHERE id = %s FOR UPDATE", ('linked',)),
    (r"UPDATE comptes SET statut", None),
    (r"DELETE FROM sessions_joueurs", None),
    (r"INSERT INTO audit_admin", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/admin/comptes/1/statut', json={'statut': 'suspended'}, headers=H)
sqls = [s for s, _ in cur.executed]

defaut(B_SUPERADMIN_SE_VERROUILLE,
       "le superadmin peut se suspendre LUI-MEME -> 200",
       r.status_code == 200,
       "une garde refuse maintenant l'auto-suspension du dernier superadmin ?")
defaut(B_SUPERADMIN_SE_VERROUILLE,
       "ses sessions sont fermees dans la foulee : il est dehors immediatement",
       any('DELETE FROM sessions_joueurs' in s for s in sqls))
defaut(B_STATUT_SANS_GARDE,
       "changer_statut ne compte JAMAIS les superadmins restants",
       not any('COUNT(*)' in s and 'superadmin' in s.lower() for s in sqls))

# La raison technique : compte_cible_protegee laisse passer l'auto-action.
# C'est un choix DELIBERE et documente (« fermer ses propres sessions est
# legitime ») -- juste pour les sessions, pas pour le statut.
import auth as _auth
check("compte_cible_protegee laisse deliberement passer l'auto-action "
      "(cause racine de B-02b)",
      'cible_id == acteur' in __import__('inspect').getsource(_auth.compte_cible_protegee))

# Non-regression : sur une CIBLE d'un autre rang, la protection fonctionne.
# L'acteur porte bien gestion_comptes : sans cette ligne il serait refuse un
# cran plus tot (permission_manquante), et l'assertion ne prouverait plus la
# regle de RANG qu'elle vise.
cli, cur, conn = monter_comptes([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='admin', statut='linked')),
    (r"SELECT 1 FROM permissions_admin", (1,)),
    (r"SELECT role FROM comptes WHERE id = %s", ('admin',)),
])
r = cli.post('/admin/comptes/2/statut', json={'statut': 'suspended'}, headers=H)
check("NON-REGRESSION : un admin porteur de gestion_comptes ne peut pas "
      "suspendre un PAIR admin (403 cible_protegee)",
      r.status_code == 403 and (r.get_json() or {}).get('code') == 'cible_protegee',
      r.get_json())

cli, cur, conn = monter_comptes([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='chef_admin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('superadmin',)),
])
r = cli.post('/admin/comptes/2/statut', json={'statut': 'suspended'}, headers=H)
check("NON-REGRESSION : un chef_admin ne peut pas suspendre le superadmin (403)",
      r.status_code == 403 and (r.get_json() or {}).get('code') == 'cible_protegee',
      r.get_json())


# ===========================================================================
# B-03 -- Asymetrie des gardes entre changer_role et changer_statut.
#
# La suspension est fonctionnellement AUSSI FORTE qu'une retrogradation (elle
# ferme les sessions et interdit la reconnexion), mais elle est traitee comme
# un geste mineur.
# ===========================================================================
print("\n=== B-03 : asymetrie changer_role / changer_statut ===")

import inspect
import routes_comptes as _rc

src_role = inspect.getsource(_rc.changer_role)
src_statut = inspect.getsource(_rc.changer_statut)

check("NON-REGRESSION : changer_role garde le dernier superadmin",
      'dernier_superadmin' in src_role)
check("NON-REGRESSION : changer_role garde le dernier chef_admin",
      'dernier_chef_admin' in src_role)
check("NON-REGRESSION : changer_role refuse l'auto-modification",
      'refuse_auto_modification' in src_role)

defaut(B_STATUT_SANS_GARDE, "changer_statut n'a AUCUNE garde 'dernier superadmin'",
       'dernier_superadmin' not in src_statut)
defaut(B_STATUT_SANS_GARDE, "changer_statut n'a AUCUNE garde 'dernier chef_admin'",
       'dernier_chef_admin' not in src_statut)
defaut(B_STATUT_SANS_GARDE, "changer_statut ne refuse PAS l'auto-modification",
       'refuse_auto_modification' not in src_statut)

src_suppr = inspect.getsource(_rc.supprimer_mon_compte)
defaut(B_SUPERADMIN_SE_VERROUILLE,
       "supprimer_mon_compte ne consulte JAMAIS le role du titulaire",
       "role" not in src_suppr.split('"""')[-1])


# ===========================================================================
# NON-REGRESSIONS -- ce que j'ai cherche a casser sans y parvenir.
#
# Ces lignes ne decrivent aucun defaut : elles verrouillent ce qui tient, pour
# qu'une correction de B-01/B-02 ne l'echange pas contre autre chose.
# ===========================================================================
print("\n=== Non-regressions : le socle qui tient ===")

import auth_discord as _ad

# -- Le token de session ne doit jamais exister en clair en base.
check("le token de session part en base en sha256 seul",
      _ad.hash_token('abc') == __import__('hashlib').sha256(b'abc').hexdigest())
check("create_session insere le HASH, jamais le token",
      'hash_token(token)' in inspect.getsource(_ad.create_session))
check("entropie de session : token_urlsafe(32) = 256 bits",
      'token_urlsafe(32)' in inspect.getsource(_ad.create_session))

# -- resumer_appareil : sur par CONSTRUCTION, pas par echappement.
piege = '<script>alert(1)</script> Chrome/120 (Windows)'
resume = _ad.resumer_appareil(piege)
check("resumer_appareil ne renvoie jamais un fragment de l'entree",
      '<script>' not in resume and resume == 'Chrome sur Windows', resume)
check("resumer_appareil : None -> libelle inconnu",
      _ad.resumer_appareil(None) == _ad.APPAREIL_INCONNU)
check("resumer_appareil : ordre Edge avant Chrome",
      _ad.resumer_appareil('Edg/120 Chrome/120 (Windows)') == 'Edge sur Windows')
check("resumer_appareil : ordre Android avant Linux",
      _ad.resumer_appareil('Linux; Android 14; Chrome/120') == 'Chrome sur Android')

# -- /auth/mes-sessions ne doit JAMAIS laisser fuir le token_hash.
import routes_auth as _ra
src_mes = inspect.getsource(_ra.mes_sessions)
check("mes_sessions lit token_hash pour comparer, mais ne le renvoie pas",
      'token_hash' in src_mes and '"token_hash"' not in src_mes)
check("mes_sessions exclut les sessions expirees",
      'expires_at > now()' in src_mes)
src_fermer = inspect.getsource(_ra.fermer_mes_sessions)
check("fermer_mes_sessions cloisonne bien par compte_id",
      src_fermer.count('compte_id = %s') >= 2)

# -- Le role est relu en base a chaque requete : la garantie centrale.
src_charger = inspect.getsource(_auth._charger_compte_session)
check("le role est relu en base a chaque requete protegee (jamais en cache)",
      'c.role' in src_charger)
check("une session expiree est supprimee et refusee en 401",
      'session_expiree' in src_charger)
check("un compte suspendu est refuse en 403",
      'compte_suspendu' in src_charger)

# -- 503 et non 403 quand la base ne repond pas (R-28 / R-55).
check("une panne DB donne 503, jamais 403 (sinon le front deconnecte a tort)",
      'indisponible' in src_charger and '503' in src_charger)
check("_a_permission leve _DbIndisponible plutot que de renvoyer False",
      '_DbIndisponible' in inspect.getsource(_auth._a_permission))

# -- Sous-permission sans parent = aucun droit, verifie AU BACKEND.
from constants import permissions_effectives, SOUS_PERMISSIONS
check("une sous-permission orpheline ne donne aucun droit",
      permissions_effectives({'joueurs_nom'}) == set())
check("avec son parent, elle compte",
      permissions_effectives({'joueurs_nom', 'gestion_joueurs'})
      == {'joueurs_nom', 'gestion_joueurs'})
check("permission_required exige aussi le parent",
      'SOUS_PERMISSIONS' in inspect.getsource(_auth.permission_required))
check("une permission hors catalogue leve a la DEFINITION (pas a l'appel)",
      _leve(lambda: _auth.permission_required('inexistante')))

# -- Legs du superadmin : l'ordre et les verrous.
src_legs = inspect.getsource(_rc.leguer_superadmin)
check("le legs retrograde l'ancien AVANT de promouvoir (index partiel)",
      src_legs.index('ROLE_CHEF_ADMIN, acteur_id') < src_legs.index('ROLE_SUPERADMIN, compte_id'))
check("le legs verrouille les deux lignes en UNE requete triee (anti-interblocage)",
      'ORDER BY id FOR UPDATE' in src_legs)
check("le legs relit le role de l'acteur SOUS verrou",
      'plus_superadmin' in src_legs)
check("le legs confirme sur discord_username, pas sur le nom d'affichage",
      'discord_username' in src_legs)
check("le legs refuse l'auto-legs", 'refuse_auto_modification' in src_legs)
check("changer_role ne pose JAMAIS superadmin",
      'superadmin_non_attribuable' in src_role)
check("un chef_admin ne peut pas designer un pair",
      'acteur_est_superadmin' in src_role)
check("quitter le role admin purge les permissions a la carte (R-53)",
      'DELETE FROM permissions_admin' in src_role)

# -- Amorcage : entree et promotion doivent avoir les MEMES conditions.
src_amorce = inspect.getsource(_ad.peut_amorcer_sans_invitation)
src_promo = inspect.getsource(_ad.promote_bootstrap_superadmin)
check("l'amorcage exige DISCORD_SUPERADMIN_ID des deux cotes",
      'DISCORD_SUPERADMIN_ID' in src_amorce and 'DISCORD_SUPERADMIN_ID' in src_promo)
check("l'amorcage se referme des qu'un superadmin existe (pas une porte derobee)",
      'COUNT(*)' in src_amorce and 'COUNT(*)' in src_promo)
check("la promotion pose un verrou FOR UPDATE (deux connexions simultanees)",
      'FOR UPDATE' in src_promo)

# -- OAuth : les pieges classiques, tous evites.
src_exch = inspect.getsource(_ad.exchange_code)
check("le snowflake est valide avant de finir dans une URL",
      'RE_SNOWFLAKE' in src_exch)
check("un hash d'avatar invalide DEGRADE au lieu de bloquer la connexion",
      'avatar_hash = None' in src_exch)
check("le corps des reponses Discord n'est jamais journalise",
      'status_code' in src_exch and 'token_res.json()' in src_exch)
check("l'invitation n'est consommee QUE pour un compte inexistant",
      'existant is None' in inspect.getsource(_ad.login))
check("login() fait tout en une seule transaction",
      'rollback' in inspect.getsource(_ad.login))
check("un compte suspendu n'obtient pas de session a la connexion",
      'compte_suspendu' in inspect.getsource(_ad.login))

# -- Le bot est un tiers : lecture seule, et le role n'est jamais publie.
import routes_bot as _rb
src_bot = inspect.getsource(_rb)
check("le bot n'expose JAMAIS le role (cela designerait les administrateurs)",
      'c.role' not in src_bot and 'role' not in src_bot.split('SELECT')[1][:400])
check("le bot ne voit que les comptes 'linked'", "statut = 'linked'" in src_bot)
check("le snowflake sort en chaine, jamais en entier (piege des 2^53)",
      'discord_id' in src_bot)


print("\n" + "=" * 60)
print("%s/%s assertions" % (sum(1 for o in OK if o), len(OK)))
print("Rappel : une ligne [B-xx, defaut constate] EN ROUGE est une bonne")
print("nouvelle -- le defaut est corrige, aller mettre a jour")
print("docs/audit-auth-admin-2026-09-17.md")
sys.exit(0 if all(OK) else 1)
