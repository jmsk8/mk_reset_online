"""Mes sessions actives : le titulaire voit et ferme ses propres sessions.

Referme A-03 de l'audit Discord. Jusqu'ici, quelqu'un dont le token avait fuite
devait joindre un administrateur -- et se reconnecter n'invalide rien, donc le
token vole restait vivant jusqu'a 30 jours sur un compte joueur.

Deux assertions portent tout le reste, et c'est pour elles que ce fichier
existe :

  - le `token_hash` ne sort JAMAIS dans la reponse. Il est la cle primaire de
    sessions_joueurs, c'est-a-dire le verificateur d'authentification lui-meme.
    Le descendre dans le DOM offrirait a un XSS la liste exacte des cibles a
    revoquer. Le test cherche le hash ET toute chaine de 64 caracteres hex, pour
    attraper aussi une fuite qu'un futur refactor introduirait sous un autre nom.

  - le DELETE ne touche aucune session d'un autre compte. C'est la MEME requete
    que celle de trois routes admin, a une clause pres : `WHERE compte_id = %s`.
    Se tromper de clause donne une route joueur qui deconnecte tout le monde.
    La regression la plus grave possible ici tient a un caractere.
"""
from harness import *
from flask import Flask
import re as _re

TOKEN = 'tok-courant'
AUTRE_TOKEN = 'tok-autre'


def _hash(t):
    import hashlib
    return hashlib.sha256(t.encode('utf-8')).hexdigest()


HASH_COURANT = _hash(TOKEN)
HASH_AUTRE = _hash(AUTRE_TOKEN)

H = {'X-Session-Token': TOKEN}

# La jointure que player_required execute pour authentifier. compte 42, joueur.
SESSION = (r"FROM sessions_joueurs s JOIN comptes c",
           ligne_session(compte_id=42, role='player'))

MAINTENANT = datetime.now(timezone.utc)
OUVERTURE = MAINTENANT - timedelta(days=3)
EXPIRATION = MAINTENANT + timedelta(days=27)

UA_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'
UA_ANDROID = ('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/126 Mobile Safari/537.36')


# Sentinelle : `vue=None` doit pouvoir signifier « last_seen_at IS NULL », pas
# « prends le defaut ». Sans elle, le test de la session jamais utilisee
# recevait la date par defaut et passait a cote de son sujet.
JAMAIS = object()


def ligne_ma_session(created=None, expires=None, vue=None, ua=UA_FIREFOX, hash_=None):
    """Ligne du SELECT de /auth/mes-sessions, dans l'ordre des colonnes."""
    return (created or OUVERTURE, expires or EXPIRATION,
            None if vue is JAMAIS else (vue or MAINTENANT), ua, hash_ or HASH_COURANT)


def monter(sessions, rowcount=None):
    """Monte routes_auth avec une session joueur valide et un SELECT planifie.

    `sessions` : les lignes que rend la liste. `rowcount` : ce que le DELETE
    declare avoir supprime.

    FakeCursor.execute remet rowcount a 1 a CHAQUE requete : le fixer une fois
    au montage ne survivrait pas au premier execute. On enveloppe donc execute
    pour le repositionner apres coup, sur les seules suppressions.
    """
    plan = [
        SESSION,
        (r"SELECT created_at, expires_at, last_seen_at, user_agent, token_hash",
         list(sessions)),
    ]
    cur, conn = install_db(plan)
    if rowcount is not None:
        _execute = cur.execute

        def execute(sql, params=None):
            _execute(sql, params)
            if ' '.join(sql.split()).startswith('DELETE FROM sessions_joueurs'):
                cur.rowcount = rowcount
        cur.execute = execute
    recharger()
    import routes_auth
    app = Flask(__name__)
    app.register_blueprint(routes_auth.auth_bp)
    return app.test_client(), cur, conn


# ===========================================================================
print("\n=== La route est bien protegee ===")

cli, cur, conn = monter([ligne_ma_session()])
r = cli.get('/auth/mes-sessions')
check("GET sans en-tete de session -> 401", r.status_code == 401, r.status_code)

cli, cur, conn = monter([])
r = cli.delete('/auth/mes-sessions')
check("DELETE sans en-tete de session -> 401", r.status_code == 401, r.status_code)


# ===========================================================================
print("\n=== Le token_hash ne sort jamais (assertion centrale) ===")

cli, cur, conn = monter([
    ligne_ma_session(),
    ligne_ma_session(ua=UA_ANDROID, vue=MAINTENANT - timedelta(days=6),
                     hash_=HASH_AUTRE),
])
r = cli.get('/auth/mes-sessions', headers=H)
brut = r.get_data(as_text=True)

check("GET avec session valide -> 200", r.status_code == 200, r.status_code)
check("le hash de la session courante est absent de la reponse",
      HASH_COURANT not in brut)
check("celui de l'autre session aussi", HASH_AUTRE not in brut)
# Filet plus large que les deux precedents : attrape une fuite qu'un futur
# refactor introduirait sous un autre nom de champ.
check("aucune chaine de 64 caracteres hex nulle part dans la reponse",
      not _re.search(r'[0-9a-f]{64}', brut), brut[:200])
check("le champ token_hash n'existe pas dans le JSON",
      'token_hash' not in brut)


# ===========================================================================
print("\n=== « Cet appareil » : exactement une session marquee ===")

sessions = r.get_json()['sessions']
check("les deux sessions sont rendues", len(sessions) == 2, sessions)
check("exactement une porte courante: true",
      sum(1 for s in sessions if s['courante']) == 1, sessions)
check("et c'est celle du token presente (la premiere, UA Firefox)",
      sessions[0]['courante'] is True and sessions[0]['appareil'] == 'Firefox sur Linux',
      sessions[0])
check("l'autre est bien marquee false",
      sessions[1]['courante'] is False, sessions[1])

# Sans en-tete exploitable, aucune ligne ne doit etre marquee : mieux vaut
# n'en designer aucune que la mauvaise.
check("le resume d'appareil remplace bien l'UA brute",
      'Mozilla' not in brut and 'AppleWebKit' not in brut)


# ===========================================================================
print("\n=== Les sessions expirees sont exclues par le SQL ===")

sql_select = [s for s, _ in cur.executed if 'FROM sessions_joueurs' in s
              and s.startswith('SELECT created_at')]
check("le SELECT filtre sur expires_at > now()",
      any('expires_at > now()' in s for s in sql_select), sql_select)
check("le SELECT est cloisonne sur compte_id",
      any('compte_id = %s' in s for s in sql_select), sql_select)
check("le tri place les NULL de last_seen_at en dernier",
      any('NULLS LAST' in s for s in sql_select), sql_select)


# ===========================================================================
print("\n=== Une session jamais utilisee rend derniere_activite: null ===")

cli, cur, conn = monter([ligne_ma_session(vue=JAMAIS)])
r = cli.get('/auth/mes-sessions', headers=H)
s0 = r.get_json()['sessions'][0]
check("last_seen_at NULL -> derniere_activite null (pas une date bidon)",
      s0['derniere_activite'] is None, s0)
check("les autres dates restent presentes",
      bool(s0['ouverte_le']) and bool(s0['expire_le']), s0)


# ===========================================================================
print("\n=== DELETE : la session courante est epargnee par defaut ===")

cli, cur, conn = monter([], rowcount=3)
r = cli.delete('/auth/mes-sessions', headers=H)
sql_del = [(s, p) for s, p in cur.executed if s.startswith('DELETE FROM sessions_joueurs')]

check("DELETE -> 200", r.status_code == 200, r.status_code)
check("une seule requete de suppression", len(sql_del) == 1, sql_del)
check("elle epargne la session courante (token_hash != %s)",
      'token_hash != %s' in sql_del[0][0], sql_del)
check("elle est cloisonnee sur compte_id",
      'compte_id = %s' in sql_del[0][0], sql_del)
check("le compte vise est celui de la session, pas un parametre client",
      sql_del[0][1][0] == 42, sql_del[0][1])
check("le hash passe en parametre est celui du token presente",
      sql_del[0][1][1] == HASH_COURANT, sql_del[0][1])
check("la reponse compte les sessions fermees",
      r.get_json()['sessions_fermees'] == 3, r.get_json())
check("et annonce que la session courante SURVIT",
      r.get_json()['session_fermee'] is False, r.get_json())
check("la transaction est validee", conn.committed)


# ===========================================================================
print("\n=== DELETE : aucune session d'un autre compte n'est touchee ===")
# Le test le plus important du fichier. La meme requete existe a trois endroits
# dans routes_comptes.py, ou elle vise un compte_id choisi par l'ADMIN. Ici le
# compte_id doit venir de la session authentifiee, jamais du corps de la requete.

cli, cur, conn = monter([], rowcount=1)
r = cli.delete('/auth/mes-sessions', headers=H, json={'compte_id': 999})
sql_del = [(s, p) for s, p in cur.executed if s.startswith('DELETE FROM sessions_joueurs')]
check("un compte_id injecte dans le corps est ignore",
      sql_del[0][1][0] == 42, sql_del[0][1])
check("aucune suppression sans clause compte_id",
      all('compte_id' in s for s, _ in sql_del), sql_del)
check("aucune suppression globale du type DELETE FROM sessions_joueurs seul",
      not any(_re.match(r'DELETE FROM sessions_joueurs\s*$', s) for s, _ in sql_del),
      sql_del)


# ===========================================================================
print("\n=== DELETE avec inclure_courante : ferme tout ===")

cli, cur, conn = monter([], rowcount=4)
r = cli.delete('/auth/mes-sessions', headers=H, json={'inclure_courante': True})
sql_del = [(s, p) for s, p in cur.executed if s.startswith('DELETE FROM sessions_joueurs')]

check("la requete n'epargne plus la session courante",
      'token_hash' not in sql_del[0][0], sql_del)
check("elle reste cloisonnee sur compte_id",
      'compte_id = %s' in sql_del[0][0], sql_del)
check("session_fermee: true -- le frontend doit purger son cookie",
      r.get_json()['session_fermee'] is True, r.get_json())

# Le drapeau doit etre STRICTEMENT true : une valeur molle ("oui", 1, "false")
# ne doit pas fermer la session courante par surprise.
for valeur in ('true', 1, 'oui'):
    cli, cur, conn = monter([], rowcount=1)
    cli.delete('/auth/mes-sessions', headers=H, json={'inclure_courante': valeur})
    sql_del = [s for s, _ in cur.executed if s.startswith('DELETE FROM sessions_joueurs')]
    check("inclure_courante=%r (non booleen) epargne quand meme la courante" % (valeur,),
          'token_hash != %s' in sql_del[0], sql_del)

# Corps absent ou illisible : le defaut prudent s'applique.
cli, cur, conn = monter([], rowcount=1)
cli.delete('/auth/mes-sessions', headers=H)
sql_del = [s for s, _ in cur.executed if s.startswith('DELETE FROM sessions_joueurs')]
check("sans corps JSON, la session courante est epargnee",
      'token_hash != %s' in sql_del[0], sql_del)


# ===========================================================================
print("\n=== Pas d'ecriture dans audit_admin ===")
# audit_admin trace ce qu'un ADMINISTRATEUR fait a autrui : elle porte
# acteur_compte_id + cible_id. Un titulaire agissant sur son propre compte n'y
# a pas sa place, et l'y mettre brouillerait la lecture du registre RGPD.

cli, cur, conn = monter([], rowcount=2)
cli.delete('/auth/mes-sessions', headers=H)
check("aucun INSERT INTO audit_admin",
      not any('audit_admin' in s for s, _ in cur.executed),
      [s for s, _ in cur.executed])


# ===========================================================================
print("\n=== resumer_appareil : l'ordre des correspondances est le piege ===")
from auth_discord import resumer_appareil, APPAREIL_INCONNU

UA = {
    'edge': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
             'Chrome/126 Safari/537.36 Edg/126'),
    'opera': ('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126 '
              'Safari/537.36 OPR/112'),
    'chrome': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
               '(KHTML, like Gecko) Chrome/126 Safari/537.36'),
    'iphone': ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
               'AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1'),
    'mac': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
            'Version/17.5 Safari/605.1.15'),
}

# Chacun de ces UA contient le motif du suivant : c'est tout l'enjeu.
check("Edge n'est pas pris pour Chrome (son UA contient « Chrome »)",
      resumer_appareil(UA['edge']) == 'Edge sur Windows', resumer_appareil(UA['edge']))
check("Opera non plus", resumer_appareil(UA['opera']) == 'Opera sur Windows',
      resumer_appareil(UA['opera']))
check("Chrome n'est pas pris pour Safari (son UA contient « Safari »)",
      resumer_appareil(UA['chrome']) == 'Chrome sur Windows', resumer_appareil(UA['chrome']))
check("Android n'est pas pris pour Linux (son UA contient « Linux »)",
      resumer_appareil(UA_ANDROID) == 'Chrome sur Android', resumer_appareil(UA_ANDROID))
check("iPhone n'est pas pris pour macOS (son UA contient « Mac OS X »)",
      resumer_appareil(UA['iphone']) == 'Safari sur iOS', resumer_appareil(UA['iphone']))
check("un vrai Mac reste macOS",
      resumer_appareil(UA['mac']) == 'Safari sur macOS', resumer_appareil(UA['mac']))
check("Firefox sur Linux",
      resumer_appareil(UA_FIREFOX) == 'Firefox sur Linux', resumer_appareil(UA_FIREFOX))

check("None -> Appareil inconnu", resumer_appareil(None) == APPAREIL_INCONNU)
check("chaine vide -> Appareil inconnu", resumer_appareil('') == APPAREIL_INCONNU)
check("UA non reconnu -> Appareil inconnu",
      resumer_appareil('curl/8.0') == APPAREIL_INCONNU)


# ===========================================================================
print("\n=== resumer_appareil : sur par CONSTRUCTION, pas par echappement ===")
# La sortie est toujours une constante de la liste fermee, jamais un fragment
# de l'entree. Une UA piegee ne peut donc pas atteindre le DOM, meme si un jour
# quelqu'un rendait ce champ sans echapper.

PIEGES = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    "Firefox/127.0 <script>alert('xss')</script>",
    'Mozilla/5.0 (Windows) Chrome/1 <b>gras</b>',
    "'; DROP TABLE sessions_joueurs; --",
]
LIBELLES = {'Edge', 'Opera', 'Firefox', 'Chrome', 'Safari',
            'Android', 'iOS', 'Windows', 'macOS', 'Linux'}

for piege in PIEGES:
    sortie = resumer_appareil(piege)
    mots = set(sortie.replace(' sur ', ' ').split())
    check("« %s… » ne ressort que sous forme de constantes" % piege[:22],
          sortie == APPAREIL_INCONNU or mots <= LIBELLES, sortie)
    check("  et ne contient aucun caractere de balisage",
          not set('<>"\'&;') & set(sortie), sortie)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
