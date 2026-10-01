"""Lecture du journal d'audit : regle de rang appliquee en SQL, une seule
requete pour le volet, l'onglet et l'export, et acteur supprime attribuable."""
from harness import *
from flask import Flask
import csv as _csv
import importlib
import io as _io
import json as _json
import re

H = {'X-Session-Token': 'tok'}


def monter(plan, role='superadmin'):
    """routes_comptes sur un curseur scripte."""
    cur, conn = install_db(list(plan) + [
        (r"FROM sessions_joueurs s\s+JOIN comptes c",
         ligne_session(compte_id=1, role=role, statut='linked')),
    ])
    recharger()
    sys.modules.pop('routes_comptes', None)
    import auth
    importlib.reload(auth)
    import routes_comptes
    importlib.reload(routes_comptes)
    routes_comptes.invalidate_cache = lambda *a, **k: None
    app = Flask(__name__)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client(), cur, conn


def ligne(id_, action='joueur_modifie', acteur=4, details=None, pseudo='Bob'):
    """Une ligne telle que la requete de lecture la renvoie."""
    from datetime import datetime, timezone
    return (id_, action, acteur, 'joueur', 7, details or {},
            datetime(2026, 9, 19, 12, 0, tzinfo=timezone.utc), pseudo)


LECTURE = r"FROM audit_admin a"


def sql_lecture(cur):
    """Le SQL de la requete de lecture, ou ''."""
    for sql, _ in cur.executed:
        if 'FROM audit_admin a' in sql:
            return ' '.join(sql.split())
    return ''


def params_lecture(cur):
    for sql, params in cur.executed:
        if 'FROM audit_admin a' in sql:
            return params
    return None


# ===========================================================================
print("\n=== La regle de rang du §6.2, appliquee EN SQL ===")

cli, cur, conn = monter([(LECTURE, [ligne(1)])], role='superadmin')
r = cli.get('/admin/audit', headers=H)
check("superadmin : 200", r.status_code == 200, r.get_json())
check("  aucune restriction de role dans sa requete",
      'c.role = ANY' not in sql_lecture(cur), sql_lecture(cur)[:120])

# Un chef_admin ne lit que certains roles, passes en parametre.
cli, cur, conn = monter([(LECTURE, [ligne(1)])], role='chef_admin')
r = cli.get('/admin/audit', headers=H)
_p = params_lecture(cur)
check("chef_admin : 200", r.status_code == 200, r.get_json())
check("  sa requete FILTRE sur le role de l'acteur",
      'c.role = ANY' in sql_lecture(cur), sql_lecture(cur)[:160])
# Le parametre doit etre une liste de roles.
_roles = _p[0] if _p and isinstance(_p[0], list) else None
check("  une liste de roles lisibles part en parametre", _roles is not None, _p)
check("  il lit les admin", bool(_roles) and 'admin' in _roles, _roles)
# Un chef_admin lit aussi ses pairs.
check("  il lit AUSSI ses pairs chef_admin (lire n'est pas agir)",
      bool(_roles) and 'chef_admin' in _roles, _roles)
check("  mais JAMAIS le superadmin : personne ne le surveille par ce biais",
      bool(_roles) and 'superadmin' not in _roles, _roles)

# Filtre dans le SQL, pas a l'affichage.
check("le filtre est dans le WHERE, pas a l'affichage",
      'WHERE' in sql_lecture(cur))

# Un admin n'a pas acces a la route.
cli, cur, conn = monter([], role='admin')
check("admin simple -> 403 sur le journal complet",
      cli.get('/admin/audit', headers=H).status_code == 403)
cli, cur, conn = monter([], role='player')
check("player -> 403", cli.get('/admin/audit', headers=H).status_code == 403)


# ===========================================================================
print("\n=== Le volet par compte porte la meme regle ===")
# Le volet n'a pas compte_cible_protegee (qui refuse le rang egal) : la regle
# vit dans _lire_journal.
cli, cur, conn = monter([
    (r"SELECT role FROM comptes WHERE id = %s", ('chef_admin',)),
    (LECTURE, [ligne(1)]),
], role='chef_admin')
r = cli.get('/admin/comptes/2/audit', headers=H)
check("chef_admin -> journal d'un PAIR : autorise", r.status_code == 200, r.get_json())

cli, cur, conn = monter([
    (r"SELECT role FROM comptes WHERE id = %s", ('superadmin',)),
    (LECTURE, []),
], role='chef_admin')
r = cli.get('/admin/comptes/2/audit', headers=H)
check("chef_admin -> journal du SUPERADMIN : refuse",
      r.status_code == 403 or not (r.get_json() or {}).get('lignes'), r.get_json())

cli, cur, conn = monter([
    (r"SELECT role FROM comptes WHERE id = %s", ('admin',)),
    (LECTURE, [ligne(1)]),
], role='chef_admin')
r = cli.get('/admin/comptes/2/audit', headers=H)
check("chef_admin -> journal d'un ADMIN : 200", r.status_code == 200, r.get_json())
check("  et la requete cible bien ce compte",
      'a.acteur_compte_id = %s' in sql_lecture(cur), sql_lecture(cur)[:200])
# Le volet porte aussi le filtre de rang.
_pv = params_lecture(cur)
check("  et il porte lui aussi le filtre de rang",
      _pv and isinstance(_pv[0], list) and 'superadmin' not in _pv[0], _pv)


# ===========================================================================
print("\n=== Pagination par curseur, jamais par OFFSET ===")

cli, cur, conn = monter([(LECTURE, [ligne(i) for i in range(50, 0, -1)])])
r = cli.get('/admin/audit?limite=50', headers=H)
_d = r.get_json()
check("une page pleine renvoie un curseur",
      _d.get('avant_id') == _d['lignes'][-1]['id'], _d.get('avant_id'))
check("  et le SQL n'utilise PAS d'OFFSET", 'OFFSET' not in sql_lecture(cur))
check("  il trie par id decroissant", 'ORDER BY a.id DESC' in sql_lecture(cur))

cli, cur, conn = monter([(LECTURE, [ligne(1), ligne(2)])])
_d = cli.get('/admin/audit?limite=50', headers=H).get_json()
check("une page incomplete ne renvoie pas de curseur", _d.get('avant_id') is None, _d)

cli, cur, conn = monter([(LECTURE, [ligne(1)])])
cli.get('/admin/audit?avant_id=99', headers=H)
check("le curseur recu est applique", 'a.id < %s' in sql_lecture(cur))

# Limite bornee.
cli, cur, conn = monter([(LECTURE, [ligne(1)])])
cli.get('/admin/audit?limite=999999', headers=H)
check("la limite est plafonnee", params_lecture(cur)[-1] <= 200, params_lecture(cur))


# ===========================================================================
print("\n=== Une ligne dont l'acteur a ete supprime reste attribuable ===")
# details.acteur prend le relais quand acteur_compte_id est NULL.

DENORME = {"acteur": {"pseudo": "Jérémy", "role": "chef_admin",
                      "discord_id_hash": "a3f1"}, "avant": {"mu": 50}}
cli, cur, conn = monter([(LECTURE, [ligne(1, acteur=None, details=DENORME, pseudo=None)])])
_l = cli.get('/admin/audit', headers=H).get_json()['lignes'][0]
check("le pseudo survit a la suppression du compte",
      _l['acteur_pseudo'] == 'Jérémy', _l)
check("  et l'ecran sait que le compte n'existe plus",
      _l['acteur_supprime'] is True, _l)
check("  le role porte au moment de l'action est conserve",
      _l['acteur_role'] == 'chef_admin', _l)
check("  les details metier restent lisibles",
      _l['details'].get('avant') == {"mu": 50}, _l)
check("  et le bloc acteur ne fait pas doublon dans details",
      'acteur' not in _l['details'], _l)

# Compte existant : pseudo issu de la jointure.
cli, cur, conn = monter([(LECTURE, [ligne(1, acteur=4, pseudo='Bob')])])
_l = cli.get('/admin/audit', headers=H).get_json()['lignes'][0]
check("compte vivant : le pseudo vient de la jointure", _l['acteur_pseudo'] == 'Bob', _l)
check("  et acteur_supprime est faux", _l['acteur_supprime'] is False, _l)

# Ligne anterieure a la denormalisation : acteur anonyme.
cli, cur, conn = monter([(LECTURE, [ligne(1, acteur=None, details={}, pseudo=None)])])
_l = cli.get('/admin/audit', headers=H).get_json()['lignes'][0]
check("une ligne anterieure a la denormalisation sort anonyme, sans mentir",
      _l['acteur_pseudo'] is None and _l['acteur_supprime'] is True, _l)


# ===========================================================================
print("\n=== Export CSV : meme filtre, et sur pour un tableur ===")

cli, cur, conn = monter([(LECTURE, [ligne(1), ligne(2)])])
r = cli.get('/admin/audit/export', headers=H)
check("l'export repond 200", r.status_code == 200)
check("  en CSV", 'text/csv' in r.headers.get('Content-Type', ''), r.headers.get('Content-Type'))
check("  en piece jointe", 'attachment' in r.headers.get('Content-Disposition', ''))

_corps = r.get_data(as_text=True)
check("  avec un BOM UTF-8 (sinon Excel casse les accents)", _corps.startswith('﻿'))
_lignes = list(_csv.reader(_io.StringIO(_corps.lstrip('﻿'))))
check("  un en-tete nomme", _lignes[0][:3] == ['id', 'date', 'action'], _lignes[0])
check("  et une ligne par entree", len(_lignes) == 3, len(_lignes))

# Les debuts de formule sont prefixes d'une apostrophe.
for _dangereux in ('=cmd|calc', '+1+1', '@SUM(A1)', '-2+3'):
    cli, cur, conn = monter([(LECTURE, [ligne(1, pseudo=_dangereux)])])
    _c = cli.get('/admin/audit/export', headers=H).get_data(as_text=True)
    _row = list(_csv.reader(_io.StringIO(_c.lstrip('﻿'))))[1]
    check("  « %s » est neutralise pour le tableur" % _dangereux,
          _row[4].startswith("'"), _row[4])

# L'export applique aussi le filtre de rang.
cli, cur, conn = monter([(LECTURE, [ligne(1)])], role='chef_admin')
cli.get('/admin/audit/export', headers=H).get_data()
# Verification sur les parametres (le SQL est le meme pour les trois chemins).
_roles_export = [p[0] for _s, p in cur.executed
                 if 'FROM audit_admin a' in _s and p and isinstance(p[0], list)]
check("l'export applique le MEME filtre de rang",
      _roles_export and all('superadmin' not in r for r in _roles_export),
      _roles_export)
check("  et sur CHAQUE page, pas seulement la premiere",
      len(_roles_export) >= 1, len(_roles_export))
cli, cur, conn = monter([], role='admin')
check("et reste ferme a un admin simple",
      cli.get('/admin/audit/export', headers=H).status_code == 403)


# ===========================================================================
print("\n=== Une seule requete pour les trois chemins ===")
RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
_src = open(os.path.join(RACINE, 'routes_comptes.py'), encoding='utf-8').read()

# Une seule requete de lecture, plus le test d'existence de lister_comptes.
_existence = 'EXISTS (SELECT 1 FROM audit_admin a'
check("il n'existe qu'un seul SELECT qui lit audit_admin",
      _src.count('FROM audit_admin') - _src.count(_existence) == 1,
      (_src.count('FROM audit_admin'), _src.count(_existence)))
_liste = _src[_src.index('def lister_comptes'):_src.index('def _verifier_sync')]
check("  le seul autre est le test d'existence de la liste des comptes",
      _src.count(_existence) == 1 and _existence in _liste)
check("  et il passe par la meme regle de rang que la lecture",
      '_peut_lire_journal(g.compte' in _liste)
for _fn in ('def journal_du_compte', 'def journal_complet', 'def exporter_journal'):
    _corps = _src[_src.index(_fn):]
    _corps = _corps[:_corps.index('\n@comptes_bp') if '\n@comptes_bp' in _corps else len(_corps)]
    check("%s() passe par le lecteur partage" % _fn[4:],
          '_lire_journal(' in _corps, _fn)

# L'export est en streaming.
_exp = _src[_src.index('def exporter_journal'):]
check("l'export streame au lieu de tout charger",
      'stream_with_context' in _exp and 'yield' in _exp)

# ===========================================================================
print("\n=== L'acces aux logs n'est PAS delegable (capacite de role) ===")
# Capacite de role, non delegable.
_rc = open(os.path.join(RACINE, 'routes_comptes.py'), encoding='utf-8').read()
for _fn in ('def journal_du_compte', 'def journal_complet', 'def exporter_journal'):
    _i = _rc.index(_fn)
    _deco = _rc[max(0, _i - 300):_i]
    check("%s() est sous role_required, pas permission_required" % _fn[4:],
          'role_required(ROLE_CHEF_ADMIN)' in _deco and 'permission_required' not in _deco,
          _deco[-120:])

from constants import PERMISSIONS_CATALOGUE, SOUS_PERMISSIONS
_suspectes = [p for p in set(PERMISSIONS_CATALOGUE) | set(SOUS_PERMISSIONS)
              if 'audit' in p or 'log' in p or 'journal' in p]
check("aucune permission delegable ne porte sur les logs", _suspectes == [], _suspectes)

# Un admin avec toutes les permissions reste refuse.
cli, cur, conn = monter([(r"SELECT 1 FROM permissions_admin", (1,))], role='admin')
check("un admin, meme tout-permissions, reste refuse",
      cli.get('/admin/audit', headers=H).status_code == 403)


print("\n=== La liste des comptes dit qui a un journal ===")
# La liste indique si le compte a des lignes de journal.
from datetime import datetime as _dt, timezone as _tz
_cree = _dt(2026, 9, 1, tzinfo=_tz.utc)
def _ligne_compte(id_, role, a_un_journal):
    return (id_, 'snow%d' % id_, 'handle%d' % id_, 'Nom %d' % id_, 'h', None,
            'linked', role, _cree, None, None, None, None, a_un_journal)
cli, cur, conn = monter([
    (r"FROM comptes c\s+LEFT JOIN joueurs j",
     [_ligne_compte(2, 'player', False), _ligne_compte(3, 'player', True)]),
])
r = cli.get('/admin/comptes', headers=H)
_d = {c['id']: c for c in (r.get_json() or [])}
check("liste des comptes -> 200", r.status_code == 200, r.get_json())
check("un joueur qui n'a jamais agi : a_un_journal faux",
      _d.get(2, {}).get('a_un_journal') is False, _d.get(2))
check("un ancien admin redevenu joueur : a_un_journal vrai",
      _d.get(3, {}).get('a_un_journal') is True, _d.get(3))
# La liste donne le handle, distinct du nom affiche.
check("la liste donne le handle, à côté du nom affiché",
      _d.get(2, {}).get('handle') == 'handle2' and _d.get(2, {}).get('pseudo') == 'Nom 2',
      _d.get(2))
_sql = ' '.join(s_ for s_, _ in cur.executed if 'FROM comptes c' in s_)

# Un admin ne sait pas qui a un journal.
cli, cur2, conn2 = monter([
    (r"FROM comptes c\s+LEFT JOIN joueurs j", [_ligne_compte(3, 'player', True)]),
    (r"FROM permissions_admin", [('gestion_comptes',)]),
], role='admin')
r = cli.get('/admin/comptes', headers=H)
_d2 = {c['id']: c for c in (r.get_json() or [])} if r.status_code == 200 else {}
check("un admin simple voit la liste, mais a_un_journal y est toujours faux",
      r.status_code == 200 and _d2.get(3, {}).get('a_un_journal') is False,
      (r.status_code, r.get_json()))
check("  calculé sur l'ACTEUR, comme le volet",
      'EXISTS' in _sql and 'a.acteur_compte_id = c.id' in _sql, _sql[-200:])

print("\n=== Cablage frontend ===")
_FRONT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'frontEnd')
_fp = open(os.path.join(_FRONT, 'frontend.py'), encoding='utf-8').read()
_ac = open(os.path.join(_FRONT, 'templates', 'admin_comptes.html'), encoding='utf-8').read()

for _r in ("'/admin/comptes/<int:compte_id>/audit'", "'/admin/audit'", "'/admin/audit/export'"):
    check("le proxy %s existe" % _r, _r in _fp, _r)

# Le proxy relaie le flux sans le charger en memoire.
_exp = _fp[_fp.index('def proxy_journal_export'):]
_exp = _exp[:_exp.index('\n@app.route')]
# Corps seul (la docstring mentionne backend_request).
_exp_code = re.sub(r'(?s)""".*?"""', '', _exp)
check("l'export frontend streame au lieu de materialiser",
      'stream_with_context' in _exp_code and 'backend_request' not in _exp_code,
      _exp_code[:160])

# Le bouton Logs est gate.
check("le bouton Logs est gate, pas affiche a tous",
      'ouvrirJournal' in _ac and 'const lisible' in _ac)
# Meme regle que le backend : tous sauf le superadmin.
check("  et il exclut le superadmin, pas les pairs",
      "c.role !== 'superadmin'" in _ac)
_lis = _ac[_ac.find('const lisible'):]
_lis = _lis[:_lis.find(';')]
# Lecteur chef_admin ou superadmin seulement.
check("  seulement pour un lecteur chef_admin ou superadmin",
      'PEUT_LIRE_JOURNAL' in _lis
      and "const PEUT_LIRE_JOURNAL = {{ 'true' if role_admin in ('chef_admin', 'superadmin')" in _ac,
      _lis)
check("  et seulement sur un compte qui a un journal", 'c.a_un_journal' in _lis, _lis)
check("l'onglet Logs existe, sous chef_admin/superadmin",
      "data-onglet=\"logs\"" in _ac and "role_admin in ('chef_admin', 'superadmin')" in _ac)
# Onglet et panneau sous la meme condition.
check("l'onglet et son panneau portent la meme condition",
      _ac.count("role_admin in ('chef_admin', 'superadmin')") >= 2)

# Telechargement par lien, pas par fetch.
check("le telechargement passe par un lien, pas un fetch",
      "dl.href = '/admin/audit/export'" in _ac and "dl.setAttribute('download'" in _ac)

# `fade-in` attend la classe `visible`.
import re as _re
for _m in _re.finditer(r"className\s*=\s*[^;]*fade-in[^;]*;", _ac):
    check("aucun element cree en JS ne porte fade-in sans visible",
          'visible' in _m.group(0), _m.group(0).strip())

# Le drapeau score_modifie est affiche.
check("le drapeau score_modifie est montre a l'ecran",
      'score_modifie' in _ac)

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
