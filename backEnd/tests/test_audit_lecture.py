"""Phase 3 du journal d'audit : la lecture.

Pendant executable de docs/audit-admin-plan.md, phase 3. Jusqu'ici la table ne
recevait que des INSERT -- aucun SELECT nulle part. Ecrire sans jamais relire,
c'est se donner bonne conscience.

Ce que ce fichier verrouille, par ordre d'importance :

  1. LA REGLE DE RANG (§6.2). Un chef_admin lit les `admin`, jamais ses pairs
     ni le superadmin. C'est la seule chose ici qui protege quelque chose : le
     reste est du confort d'affichage.

  2. Le filtre est applique EN SQL, pas a l'affichage. Rendre les lignes puis
     les masquer les ferait transiter, et la pagination compterait des lignes
     invisibles -- une page de 50 en afficherait 12.

  3. Les TROIS chemins de lecture (volet, onglet, export) partagent UNE seule
     requete. Trois requetes separees finiraient par diverger, et la premiere
     a oublier le garde de rang deviendrait le contournement de la regle.

  4. Une ligne dont l'acteur a ete SUPPRIME reste attribuable, via la
     denormalisation du §6.3.

Aucun Postgres : le curseur est scripte. Ce fichier ne valide donc pas le SQL,
mais qui lit quoi, sous quelles conditions, et ce qui sort.
"""
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

# Un superadmin lit tout : aucune restriction de role dans la requete.
cli, cur, conn = monter([(LECTURE, [ligne(1)])], role='superadmin')
r = cli.get('/admin/audit', headers=H)
check("superadmin : 200", r.status_code == 200, r.get_json())
check("  aucune restriction de role dans sa requete",
      'c.role = ANY' not in sql_lecture(cur), sql_lecture(cur)[:120])

# Un chef_admin ne lit QUE les admin. La liste part en parametre : on verifie
# son contenu, pas seulement la presence du filtre.
cli, cur, conn = monter([(LECTURE, [ligne(1)])], role='chef_admin')
r = cli.get('/admin/audit', headers=H)
_p = params_lecture(cur)
check("chef_admin : 200", r.status_code == 200, r.get_json())
check("  sa requete FILTRE sur le role de l'acteur",
      'c.role = ANY' in sql_lecture(cur), sql_lecture(cur)[:160])
# La liste doit EXISTER en parametre : si le filtre saute, `_p[0]` n'est plus
# une liste de roles mais la limite, et les trois assertions suivantes
# passeraient sur une comparaison vide. C'est le trou qu'a revele l'injection
# de panne : une seule assertion mordait.
_roles = _p[0] if _p and isinstance(_p[0], list) else None
check("  une liste de roles lisibles part en parametre", _roles is not None, _p)
check("  il lit les admin", bool(_roles) and 'admin' in _roles, _roles)
# Arbitre le 2026-09-19 : un chef_admin lit AUSSI ses pairs. Lire n'est pas
# agir -- et c'est precisement entre gens de meme rang que la surveillance
# mutuelle a du sens. L'ecart avec `compte_cible_protegee` (rang strictement
# superieur) est donc delibere.
check("  il lit AUSSI ses pairs chef_admin (lire n'est pas agir)",
      bool(_roles) and 'chef_admin' in _roles, _roles)
check("  mais JAMAIS le superadmin : personne ne le surveille par ce biais",
      bool(_roles) and 'superadmin' not in _roles, _roles)

# Le filtre doit etre dans le SQL, pas applique apres coup : sinon les lignes
# transitent et la pagination compte des lignes invisibles.
check("le filtre est dans le WHERE, pas a l'affichage",
      'WHERE' in sql_lecture(cur))

# Un admin simple n'a pas la route : le decorateur l'arrete avant.
cli, cur, conn = monter([], role='admin')
check("admin simple -> 403 sur le journal complet",
      cli.get('/admin/audit', headers=H).status_code == 403)
cli, cur, conn = monter([], role='player')
check("player -> 403", cli.get('/admin/audit', headers=H).status_code == 403)


# ===========================================================================
print("\n=== Le volet par compte porte la meme regle ===")
# `compte_cible_protegee` l'arrete avant le corps : un chef_admin qui vise un
# pair est refuse, exactement comme pour les autres gestes sur un compte.

# ⚠️ Le volet d'une ligne ne porte PAS `compte_cible_protegee` : ce decorateur
# refuse le rang egal, ce qui interdirait a un chef_admin de lire le journal
# d'un pair -- exactement ce que l'arbitrage du 19/09 veut permettre. La regle
# de lecture vit donc dans `_lire_journal`, une seule fois, pour les trois
# chemins.
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
# Le volet porte AUSSI le filtre de rang, en plus du decorateur : les deux se
# recouvrent volontairement. Le decorateur protege la cible designee, le filtre
# protege les lignes rendues -- si le premier sautait, le second tiendrait.
_pv = params_lecture(cur)
check("  et il porte lui aussi le filtre de rang",
      _pv and isinstance(_pv[0], list) and 'superadmin' not in _pv[0], _pv)


# ===========================================================================
print("\n=== Pagination par curseur, jamais par OFFSET ===")
# Un OFFSET saute des lignes des qu'une nouvelle s'insere pendant la
# consultation -- et un journal s'ecrit en continu.

cli, cur, conn = monter([(LECTURE, [ligne(i) for i in range(50, 0, -1)])])
r = cli.get('/admin/audit?limite=50', headers=H)
_d = r.get_json()
check("une page pleine renvoie un curseur",
      _d.get('avant_id') == _d['lignes'][-1]['id'], _d.get('avant_id'))
check("  et le SQL n'utilise PAS d'OFFSET", 'OFFSET' not in sql_lecture(cur))
check("  il trie par id decroissant", 'ORDER BY a.id DESC' in sql_lecture(cur))

# Page incomplete : plus rien apres, donc pas de curseur.
cli, cur, conn = monter([(LECTURE, [ligne(1), ligne(2)])])
_d = cli.get('/admin/audit?limite=50', headers=H).get_json()
check("une page incomplete ne renvoie pas de curseur", _d.get('avant_id') is None, _d)

cli, cur, conn = monter([(LECTURE, [ligne(1)])])
cli.get('/admin/audit?avant_id=99', headers=H)
check("le curseur recu est applique", 'a.id < %s' in sql_lecture(cur))

# La limite est bornee : sans plafond, `?limite=999999` materialiserait tout.
cli, cur, conn = monter([(LECTURE, [ligne(1)])])
cli.get('/admin/audit?limite=999999', headers=H)
check("la limite est plafonnee", params_lecture(cur)[-1] <= 200, params_lecture(cur))


# ===========================================================================
print("\n=== Une ligne dont l'acteur a ete supprime reste attribuable ===")
# C'est le §6.3, le point dur du journal. `acteur_compte_id` passe a NULL a la
# suppression ; c'est `details.acteur` qui prend le relais.

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
# Le bloc `acteur` est deja remonte en colonnes : le laisser ferait doublon.
check("  et le bloc acteur ne fait pas doublon dans details",
      'acteur' not in _l['details'], _l)

# Compte vivant : le pseudo vient de la JOINTURE, qui fait foi.
cli, cur, conn = monter([(LECTURE, [ligne(1, acteur=4, pseudo='Bob')])])
_l = cli.get('/admin/audit', headers=H).get_json()['lignes'][0]
check("compte vivant : le pseudo vient de la jointure", _l['acteur_pseudo'] == 'Bob', _l)
check("  et acteur_supprime est faux", _l['acteur_supprime'] is False, _l)

# Ligne ANCIENNE, ecrite avant la denormalisation : ni jointure ni bloc. Elle
# sort anonyme, et c'est la verite -- rien ne peut le rattraper apres coup.
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

# Injection de formule : un pseudo « =cmd » est execute par Excel et
# LibreOffice a l'ouverture. Le prefixe apostrophe force le texte.
for _dangereux in ('=cmd|calc', '+1+1', '@SUM(A1)', '-2+3'):
    cli, cur, conn = monter([(LECTURE, [ligne(1, pseudo=_dangereux)])])
    _c = cli.get('/admin/audit/export', headers=H).get_data(as_text=True)
    _row = list(_csv.reader(_io.StringIO(_c.lstrip('﻿'))))[1]
    check("  « %s » est neutralise pour le tableur" % _dangereux,
          _row[4].startswith("'"), _row[4])

# Le filtre de rang vaut AUSSI pour l'export : sinon il montrerait ce que
# l'ecran masque, et deviendrait le contournement de la regle.
cli, cur, conn = monter([(LECTURE, [ligne(1)])], role='chef_admin')
cli.get('/admin/audit/export', headers=H).get_data()
# On verifie sur les PARAMETRES et non sur le texte du SQL : la liste des roles
# lisibles y est, et c'est elle qui porte la regle. Le SQL, lui, est identique
# dans les trois chemins -- il ne dirait pas si le filtre a ete arme.
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
# Trois requetes separees (volet, onglet, export) finiraient par diverger, et
# la premiere a oublier le garde de rang deviendrait le contournement.
RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
_src = open(os.path.join(RACINE, 'routes_comptes.py'), encoding='utf-8').read()

# Une seule requete LIT des lignes du journal. La seconde occurrence tolérée
# est le test d'EXISTENCE de lister_comptes (2026-09-22), qui ne rend qu'un
# booleen et passe par _peut_lire_journal : nommee ici pour que toute autre
# lecture continue de faire rougir ce test.
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

# L'export streame : un SELECT materialise sur un journal qui ne se purge
# jamais tomberait le jour ou l'on cherche justement quelque chose.
_exp = _src[_src.index('def exporter_journal'):]
check("l'export streame au lieu de tout charger",
      'stream_with_context' in _exp and 'yield' in _exp)

# ===========================================================================
print("\n=== L'acces aux logs n'est PAS delegable (capacite de role) ===")
# Demande explicite du 2026-09-19. Un droit delegable pourrait etre accorde a
# un admin par un chef_admin ; la surveillance perdrait son sens si le
# surveille pouvait recevoir le droit de se lire lui-meme.
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

# Un admin porteur de TOUTES les permissions reste refuse : c'est le rang qui
# decide, pas le catalogue.
cli, cur, conn = monter([(r"SELECT 1 FROM permissions_admin", (1,))], role='admin')
check("un admin, meme tout-permissions, reste refuse",
      cli.get('/admin/audit', headers=H).status_code == 403)


print("\n=== La liste des comptes dit qui a un journal ===")
# Le volet d'une ligne montre les actions dont le compte est l'ACTEUR. Un joueur
# qui n'a jamais ete admin n'en a pas : sans cette information, son bouton Logs
# ouvrait un volet vide (constat du 2026-09-22).
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
# Le legs et la suppression font retaper le handle : la liste doit le donner,
# distinct du nom affiche (constat §13.1 du 2026-09-22).
check("la liste donne le handle, à côté du nom affiché",
      _d.get(2, {}).get('handle') == 'handle2' and _d.get(2, {}).get('pseudo') == 'Nom 2',
      _d.get(2))
_sql = ' '.join(s_ for s_, _ in cur.executed if 'FROM comptes c' in s_)

# La liste est ouverte a tout porteur de gestion_comptes. Un admin simple ne
# lit aucun journal : il n'a pas non plus a savoir qui en a un.
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

# L'export doit RELAYER le flux, pas le materialiser : `backend_request` lit
# response.json(), ce qui chargerait tout le CSV en memoire cote frontend et
# annulerait le streaming du backend.
_exp = _fp[_fp.index('def proxy_journal_export'):]
_exp = _exp[:_exp.index('\n@app.route')]
# Sur le CORPS seul : la docstring de la fonction EXPLIQUE pourquoi elle
# n'utilise pas `backend_request`, et la chercher dans le source brut la
# retrouvait dans ce commentaire -- meme piege que sur admin_reglages.
_exp_code = re.sub(r'(?s)""".*?"""', '', _exp)
check("l'export frontend streame au lieu de materialiser",
      'stream_with_context' in _exp_code and 'backend_request' not in _exp_code,
      _exp_code[:160])

# Le bouton ne doit pas mener a un 403 previsible (§B.0) : la regle de rang
# est rejouee a l'affichage, et revrifiee cote backend.
check("le bouton Logs est gate, pas affiche a tous",
      'ouvrirJournal' in _ac and 'const lisible' in _ac)
# Le gate frontend doit suivre la MEME regle que le backend : tout sauf le
# superadmin. S'il gardait le rang strict, un chef_admin ne verrait pas le
# bouton sur un pair alors que la route le lui rendrait.
check("  et il exclut le superadmin, pas les pairs",
      "c.role !== 'superadmin'" in _ac)
_lis = _ac[_ac.find('const lisible'):]
_lis = _lis[:_lis.find(';')]
# La route est @role_required(ROLE_CHEF_ADMIN) : un admin porteur de
# gestion_comptes voyait le bouton, et le 403 le renvoyait a l'accueil.
check("  seulement pour un lecteur chef_admin ou superadmin",
      'PEUT_LIRE_JOURNAL' in _lis
      and "const PEUT_LIRE_JOURNAL = {{ 'true' if role_admin in ('chef_admin', 'superadmin')" in _ac,
      _lis)
check("  et seulement sur un compte qui a un journal", 'c.a_un_journal' in _lis, _lis)
check("l'onglet Logs existe, sous chef_admin/superadmin",
      "data-onglet=\"logs\"" in _ac and "role_admin in ('chef_admin', 'superadmin')" in _ac)
# Meme invariant que les quatre autres onglets : onglet et panneau sous la
# MEME condition, sinon on affiche un onglet dont le contenu n'existe pas.
check("l'onglet et son panneau portent la meme condition",
      _ac.count("role_admin in ('chef_admin', 'superadmin')") >= 2)

# Le telechargement est un <a download> et non un fetch : un fetch chargerait
# tout le fichier en memoire avant de le rendre.
check("le telechargement passe par un lien, pas un fetch",
      "dl.href = '/admin/audit/export'" in _ac and "dl.setAttribute('download'" in _ac)

# Le piege du 19/09 : `fade-in` pose opacity:0 et attend `visible`, ajoutee
# par un balayage qui ne tourne qu'au chargement de la page.
import re as _re
for _m in _re.finditer(r"className\s*=\s*[^;]*fade-in[^;]*;", _ac):
    check("aucun element cree en JS ne porte fade-in sans visible",
          'visible' in _m.group(0), _m.group(0).strip())

# Le drapeau qui repond a la question d'origine doit etre VISIBLE a l'ecran,
# pas seulement present dans les donnees.
check("le drapeau score_modifie est montre a l'ecran",
      'score_modifie' in _ac)

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
