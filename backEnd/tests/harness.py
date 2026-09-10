"""Banc d'essai du flux d'authentification, sans Postgres ni Discord.

Le curseur est scripte : on lui dit quelle ligne renvoyer pour chaque requete,
et il enregistre tout ce qui a ete execute. Ca ne valide pas le SQL, mais ca
valide ce qui compte ici : qui consomme quoi, dans quel ordre, et sous quelles
conditions.
"""
import os, re, sys, types
from datetime import datetime, timedelta, timezone

os.environ.update({
    'POSTGRES_DB': 'x', 'POSTGRES_USER': 'x', 'ADMIN_PASSWORD_HASH': 'x',
    'DISCORD_CLIENT_ID': 'cid', 'DISCORD_CLIENT_SECRET': 'csec',
    'DISCORD_REDIRECT_URI': 'https://mkreset.fr/auth/discord/callback',
})
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

# Dependances tierces neutralisees une fois pour toutes : les tests ne parlent
# ni a Postgres ni au moteur TrueSkill, mais les modules testes les importent en
# cascade. Les stubber ici plutot que dans chaque fichier evite qu'un nouvel
# import dans le code de production ne casse des tests sans rapport -- ce qui
# est exactement arrive quand routes_comptes s'est mis a importer services.
for _m in ('trueskill', 'numpy', 'bcrypt', 'psycopg2', 'psycopg2.extras'):
    sys.modules.setdefault(_m, types.ModuleType(_m))
sys.modules['psycopg2'].extras = sys.modules['psycopg2.extras']

# --- faux psycopg2/db -------------------------------------------------------
# Sentinelle de plan : « cette requete n'a touche aucune ligne » (rowcount = 0).
# Sert aux INSERT ... ON CONFLICT DO NOTHING et aux DELETE sans effet.
ROWCOUNT_ZERO = object()


class FakeCursor:
    def __init__(self, plan):
        self.plan = plan          # liste de (motif regex, ligne renvoyee)
        self.executed = []
        self._row = None
        self.rowcount = 1
    def execute(self, sql, params=None):
        norm = ' '.join(sql.split())
        self.executed.append((norm, params))
        self._row = None
        self.rowcount = 1
        for motif, ligne in self.plan:
            if re.search(motif, norm, re.I):
                self._row = ligne(params) if callable(ligne) else ligne
                # ON CONFLICT DO NOTHING et DELETE distinguent « fait » de
                # « rien a faire » par rowcount. Une entree de plan valant
                # ROWCOUNT_ZERO simule le second cas.
                if self._row is ROWCOUNT_ZERO:
                    self._row, self.rowcount = None, 0
                break
    def fetchone(self):
        # Une requete planifiee avec PLUSIEURS lignes (liste) rend sa premiere
        # ligne a fetchone, comme le ferait psycopg2.
        if isinstance(self._row, list):
            return self._row[0] if self._row else None
        return self._row
    def fetchall(self):
        # Renvoie les lignes planifiees quand le plan en donne une liste. Les
        # plans qui ne prevoient qu'un tuple (le cas majoritaire) gardent
        # l'ancien comportement : fetchall n'a alors rien a rendre.
        return list(self._row) if isinstance(self._row, list) else []
    def __enter__(self): return self
    def __exit__(self, *a): return False

class FakeConn:
    def __init__(self, cur): self._cur = cur; self.committed = False; self.rolledback = False
    def cursor(self): return self._cur
    def commit(self): self.committed = True
    def rollback(self): self.rolledback = True

def install_db(plan):
    cur = FakeCursor(plan)
    conn = FakeConn(cur)
    import contextlib
    fake = types.ModuleType('db')
    @contextlib.contextmanager
    def get_db_connection():
        yield conn
    fake.get_db_connection = get_db_connection
    fake.ADMIN_PASSWORD_HASH = b'x'
    sys.modules['db'] = fake
    return cur, conn

# --- faux Discord -----------------------------------------------------------
class FakeResponse:
    def __init__(self, status, payload): self.status_code = status; self._p = payload
    def json(self): return self._p

def install_discord(profil=None, token_status=200):
    calls = []
    fake = types.ModuleType('requests')
    class _Exc(Exception): pass
    fake.exceptions = types.SimpleNamespace(RequestException=_Exc)
    def post(url, **kw):
        calls.append(('POST', url, kw))
        return FakeResponse(token_status, {'access_token': 'at'})
    def get(url, **kw):
        calls.append(('GET', url, kw))
        return FakeResponse(200, profil or {
            'id': '123456789012345678', 'username': 'toto',
            'global_name': 'Toto', 'avatar': 'abc123'})
    fake.post, fake.get = post, get
    sys.modules['requests'] = fake
    return calls

def recharger():
    for m in ('auth_discord', 'auth', 'routes_auth', 'constants'):
        sys.modules.pop(m, None)

FUTUR = datetime.now(timezone.utc) + timedelta(hours=1)
PASSE = datetime.now(timezone.utc) - timedelta(hours=1)

# Constructeurs de lignes. Les fixtures etaient des tuples positionnels ecrits
# a la main : ajouter une colonne a une requete partagee cassait alors une
# dizaine de tests d'un coup, avec des 500 illisibles. Passer par ces fonctions
# concentre le changement en un seul endroit.

def ligne_session(compte_id=42, discord_id='123456789012345678', username='toto',
                  global_name='Toto', avatar='hash', joueur_id=None,
                  statut='linked', role='player', expires_at=None, cgu_version=None):
    """Ligne renvoyee par la jointure sessions_joueurs x comptes (auth.py)."""
    return (compte_id, discord_id, username, global_name, avatar, joueur_id,
            statut, role, expires_at if expires_at is not None else FUTUR, cgu_version)


def ligne_compte(compte_id=42, discord_id='123456789012345678', username='toto',
                 global_name='Toto', avatar='abc123', joueur_id=None,
                 statut='pending', role='player', cgu_at=None, cgu_version=None):
    """Ligne renvoyee par le RETURNING de upsert_compte (auth_discord.py)."""
    return (compte_id, discord_id, username, global_name, avatar, joueur_id,
            statut, role, cgu_at, cgu_version)

OK = []
def check(nom, cond, detail=''):
    OK.append(cond)
    print(('  ✅ ' if cond else '  ❌ ') + nom + (('  -> ' + str(detail)) if not cond and detail else ''))
