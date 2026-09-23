"""Journal des actions admin -- phase 4 : le filet.

Pendant executable de docs/audit-admin-plan.md, phase 4 (R-61, R-64).

R-61 : une route d'ecriture admin ajoutee plus tard oubliera son audit. Ce
n'est pas une hypothese : au 2026-09-22, les cinq routes des tiers dynamiques
(ajoutees apres les phases 1 a 3), la suppression et la publication d'un recap,
et la liaison de deux tournois -- qui modifie le sigma de joueurs -- ecrivaient
toutes sans laisser de trace. Aucun test ne le voyait.

Ce fichier fait pour l'audit ce que test_bascule.py fait pour les decorateurs :
il inventorie les routes PAR ANALYSE DU SOURCE, et rougit sur toute route
d'ecriture admin qui n'atteint pas `audit.ecrire`. La discipline ne tient pas
toute seule ; un inventaire, si.

R-64 : le vocabulaire des actions est ferme (audit.ACTIONS), et l'ecran Logs
sait dire chacune en clair.
"""
import ast
import glob
import re

from harness import *

import audit

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FRONT = os.path.join(RACINE, '..', 'frontEnd')

ECRITURES = ('POST', 'PUT', 'DELETE', 'PATCH')
DECOS_ADMIN = ('permission_required', 'role_required')
APPELS_AUDIT = ('_audit', 'ecrire')
# Cherche dans les CHAINES du code seulement, la ou vit le SQL : sur le source
# brut, `tampon.truncate(0)` (un tampon CSV) passait pour un TRUNCATE.
SQL_ECRIT = re.compile(r'\b(?:INSERT\s+INTO|DELETE\s+FROM|ALTER\s+TABLE|TRUNCATE(?:\s+TABLE)?)\s+(\w+)'
                       r'|\bUPDATE\s+(\w+)\s+(?:\w+\s+)?SET\b', re.I)


def tables_ecrites(fn):
    """Les tables que le SQL de `fn` modifie, docstring exclue."""
    doc = fn.body[0].value if (fn.body and isinstance(fn.body[0], ast.Expr)
                               and isinstance(fn.body[0].value, ast.Constant)) else None
    chaines = ' '.join(n.value for n in ast.walk(fn)
                       if isinstance(n, ast.Constant) and isinstance(n.value, str)
                       and n is not doc)
    return {(a or b).lower() for a, b in SQL_ECRIT.findall(chaines)}


# Les SEULES routes admin qui ecrivent -- au sens HTTP -- sans journaliser.
# Chacune avec sa raison, et les tables qu'elle a le droit de toucher : une
# exemption n'est pas un blanc-seing, et la route qui se mettrait a ecrire
# ailleurs rougirait. Une entree devenue inutile aussi, pour que la liste ne
# grossisse pas en silence.
EXEMPTEES = {
    # `refresh_token` a quitte cette liste le 2026-09-23 : la route a ete
    # supprimee avec l'authentification par mot de passe. C'est ce test qui l'a
    # signale, et c'est sa raison d'etre -- une exemption devenue inutile doit
    # rougir, sinon la liste ne fait que grossir.
    'verifier_session_tournoi': ("POST pour porter une liste de noms ; lecture seule", set()),
    'matchmaking_admin': ("POST pour porter une liste de joueurs ; calcule des lobbies", set()),
    'fix_db_structure': ("migration de schema idempotente (colonnes de Tournois et leur "
                         "remplissage), n'agit sur les donnees de personne", {'tournois'}),
}


def charger_fonctions():
    """Toutes les fonctions de premier niveau du backend, par nom."""
    fonctions = {}
    for f in sorted(glob.glob(os.path.join(RACINE, '*.py'))):
        src = open(f, encoding='utf-8').read()
        for n in ast.parse(src).body:
            if isinstance(n, ast.FunctionDef):
                fonctions.setdefault(n.name, (n, src))
    return fonctions


def appels(fn):
    noms = set()
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            c = n.func
            if isinstance(c, ast.Name):
                noms.add(c.id)
            elif isinstance(c, ast.Attribute):
                noms.add(c.attr)
    return noms


def atteint_audit(fn, fonctions, vus=None):
    """Vrai si `fn` appelle l'audit, directement ou via une fonction du backend.

    Suit les appels d'un module a l'autre : la purge RGPD journalise dans
    services.py, la suppression de compte dans _effacer_compte.
    """
    vus = set() if vus is None else vus
    if fn.name in vus:
        return False
    vus.add(fn.name)
    noms = appels(fn)
    if noms & set(APPELS_AUDIT):
        return True
    return any(atteint_audit(fonctions[n][0], fonctions, vus)
               for n in noms if n in fonctions)


def inventaire(src, fonctions):
    """Les routes admin qui ecrivent, avec (nom, chemin, methodes, audite)."""
    routes = []
    for n in ast.parse(src).body:
        if not isinstance(n, ast.FunctionDef):
            continue
        chemins, methodes, decos = [], set(), []
        for d in n.decorator_list:
            if (isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
                    and d.func.attr == 'route'):
                chemins.append(d.args[0].value)
                meth = ['GET']
                for k in d.keywords:
                    if k.arg == 'methods':
                        meth = [e.value for e in k.value.elts]
                methodes.update(meth)
            else:
                decos.append(ast.unparse(d))
        if not chemins:
            continue
        admin = (any(d.startswith(DECOS_ADMIN) for d in decos)
                 or any(c.startswith(('/admin/', '/api/admin/')) for c in chemins))
        # Un GET qui ecrit en base compte aussi : c'est le cas le plus facile
        # a laisser passer, parce qu'on ne le cherche pas.
        ecrit = bool(methodes & set(ECRITURES)) or bool(tables_ecrites(n))
        if admin and ecrit:
            routes.append((n.name, chemins[0], sorted(methodes),
                           atteint_audit(n, fonctions)))
    return routes


FONCTIONS = charger_fonctions()
ROUTES = []
for f in sorted(glob.glob(os.path.join(RACINE, 'routes_*.py'))):
    ROUTES += inventaire(open(f, encoding='utf-8').read(), FONCTIONS)
PAR_NOM = {r[0]: r for r in ROUTES}


print("\n=== R-61 : aucune route d'ecriture admin sans audit ===")
check("l'inventaire trouve les routes (sinon le test ne prouverait rien)",
      len(ROUTES) >= 40, len(ROUTES))
for nom in ('api_update_joueur', 'add_tournament', 'changer_role', 'supprimer_compte',
            'declencher_purge', 'fix_db_structure'):
    check("  %s est bien inventoriee" % nom, nom in PAR_NOM)

oublis = sorted('%s %s (%s)' % ('/'.join(m), c, n)
                for n, c, m, audite in ROUTES if not audite and n not in EXEMPTEES)
check("toute route d'ecriture admin atteint audit.ecrire", not oublis, oublis)

check("la purge RGPD est reconnue comme journalisee (audit dans services.py)",
      PAR_NOM.get('declencher_purge', (0, 0, 0, False))[3])
check("la suppression de compte aussi (audit dans _effacer_compte)",
      PAR_NOM.get('supprimer_compte', (0, 0, 0, False))[3])

print("\n=== Les exemptions restent justifiees ===")
for nom, (raison, permises) in sorted(EXEMPTEES.items()):
    r = PAR_NOM.get(nom)
    check("%s existe encore (sinon, la retirer de la liste)" % nom, r is not None)
    check("  ne journalise toujours pas (sinon, la retirer de la liste)", r is not None and not r[3])
    ecrites = tables_ecrites(FONCTIONS[nom][0]) if nom in FONCTIONS else set()
    check(("  n'écrit que dans " + ', '.join(sorted(permises))) if permises
          else "  n'écrit dans aucune table",
          ecrites <= permises, sorted(ecrites - permises))

print("\n=== Le filet attrape bien une route oubliee ===")
# Sans cette preuve, un inventaire qui ne trouverait rien serait tout aussi vert.
_ROUTE_OUBLIEE = '''
@admin_bp.route('/admin/nouveau-reglage', methods=['POST'])
@permission_required('gestion_config')
def nouveau_reglage():
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE Configuration SET value = %s WHERE key = %s", ('1', 'x'))
        conn.commit()
    return jsonify({"status": "success"})

@admin_bp.route('/api/admin/maintenance', methods=['GET'])
@role_required(ROLE_SUPERADMIN)
def maintenance():
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM ghost_log")
        conn.commit()
    return jsonify({"status": "success"})

@admin_bp.route('/admin/reglage-trace', methods=['POST'])
@permission_required('gestion_config')
def reglage_trace():
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            _ecrire_et_tracer(cur)
        conn.commit()
    return jsonify({"status": "success"})

def _ecrire_et_tracer(cur):
    audit.ecrire(cur, 'config_modifiee', 'systeme', None, {})
'''
_fct = dict(FONCTIONS)
for _n in ast.parse(_ROUTE_OUBLIEE).body:
    _fct[_n.name] = (_n, _ROUTE_OUBLIEE)
_trouvees = {r[0]: r[3] for r in inventaire(_ROUTE_OUBLIEE, _fct)}
check("une route POST sans audit est detectee", _trouvees.get('nouveau_reglage') is False,
      _trouvees)
check("un GET qui ecrit en base est detecte aussi", _trouvees.get('maintenance') is False,
      _trouvees)
check("une route qui journalise via un helper est reconnue",
      _trouvees.get('reglage_trace') is True, _trouvees)


print("\n=== R-64 : vocabulaire ferme ===")
def actions_ecrites():
    """Chaque action passee a l'audit dans le backend, avec son emplacement.

    Une action calculee (`action = 'a' if ... else 'b'`) est resolue en
    remontant a son affectation : les deux branches doivent etre au catalogue.
    """
    trouvees, opaques = {}, []
    for f in sorted(glob.glob(os.path.join(RACINE, '*.py'))):
        src = open(f, encoding='utf-8').read()
        arbre = ast.parse(src)
        for fn in ast.walk(arbre):
            if not isinstance(fn, ast.FunctionDef):
                continue
            for n in ast.walk(fn):
                if not (isinstance(n, ast.Call) and len(n.args) >= 2):
                    continue
                c = n.func
                nom = c.id if isinstance(c, ast.Name) else getattr(c, 'attr', None)
                if nom not in APPELS_AUDIT:
                    continue
                a = n.args[1]
                lieu = '%s:%d' % (os.path.basename(f), n.lineno)
                if isinstance(a, ast.Constant) and isinstance(a.value, str):
                    trouvees.setdefault(a.value, lieu)
                elif isinstance(a, ast.Name):
                    valeurs = [k.value for m in ast.walk(fn)
                               if isinstance(m, ast.Assign)
                               and any(isinstance(t, ast.Name) and t.id == a.id for t in m.targets)
                               for k in ast.walk(m.value)
                               if isinstance(k, ast.Constant) and isinstance(k.value, str)]
                    if not valeurs:
                        opaques.append(lieu)
                    for v in valeurs:
                        trouvees.setdefault(v, lieu)
                else:
                    opaques.append(lieu)
    return trouvees, opaques

ECRITES, OPAQUES = actions_ecrites()
check("le relevé trouve les actions (sinon le test ne prouverait rien)",
      len(ECRITES) >= 40, len(ECRITES))
check("aucune action impossible à relire dans le source", not OPAQUES, OPAQUES)
hors = sorted('%s (%s)' % (a, l) for a, l in ECRITES.items() if a not in audit.ACTIONS)
check("toute action écrite figure dans audit.ACTIONS", not hors, hors)
check("l'action calculée de changer_role est résolue (role_attribue ET role_retire)",
      {'role_attribue', 'role_retire'} <= set(ECRITES))
mal_formees = sorted(a for a in audit.ACTIONS if not re.fullmatch(r'[a-z]+(_[a-z]+)+', a))
check("toutes suivent <objet>_<participe>", not mal_formees, mal_formees)

_ac = open(os.path.join(FRONT, 'templates', 'admin_comptes.html'), encoding='utf-8').read()
_bloc = _ac[_ac.index('const LIBELLES_ACTION = {'):]
_bloc = _bloc[:_bloc.index('};')]
LIBELLES = set(re.findall(r'\b([a-z]+(?:_[a-z]+)+)\s*:', _bloc))
check("l'écran Logs sait dire chaque action en clair",
      audit.ACTIONS <= LIBELLES, sorted(audit.ACTIONS - LIBELLES))
check("et n'a pas de libellé pour une action inconnue du catalogue",
      LIBELLES <= audit.ACTIONS, sorted(LIBELLES - audit.ACTIONS))


print("\n=== Les nouvelles traces du 2026-09-22 ===")
_admin = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read()
def corps_de(nom):
    fn, src = FONCTIONS[nom]
    return ast.get_source_segment(src, fn)
for nom, action in (('create_tier', 'tier_cree'), ('update_tier', 'tier_modifie'),
                    ('delete_tier', 'tier_supprime'), ('reorder_tiers', 'tiers_reordonnes'),
                    ('reset_tiers', 'tiers_reinitialises'),
                    ('delete_saison', 'recap_supprime'),
                    ('save_season_awards', 'recap_publie'),
                    ('lier_session_tournoi', 'tournoi_lie')):
    corps = corps_de(nom)
    check("%s écrit « %s »" % (nom, action), "'%s'" % action in corps)
    # Dans la transaction du geste, jamais apres : une ligne validee pour une
    # action annulee serait pire que pas de ligne (audit.py).
    i_audit, i_commit = corps.find("'%s'" % action), corps.rfind('conn.commit()')
    check("  avant le commit, dans la même transaction", 0 <= i_audit < i_commit,
          (i_audit, i_commit))
for nom in ('create_tier', 'update_tier', 'delete_tier', 'reorder_tiers', 'reset_tiers'):
    check("%s trace l'état complet avant ET après" % nom,
          'avant' in corps_de(nom) and '_etat_tiers(cur)' in corps_de(nom))
check("tournoi_lie porte l'avant/après du sigma de chaque joueur corrigé",
      '"avant": {"sigma"' in corps_de('annuler_penalites_de_session')
      and '"penalites_annulees": corriges' in corps_de('lier_session_tournoi'))
check("  et le drapeau score_modifie, comme une modification de fiche",
      '"score_modifie": bool(corriges)' in corps_de('lier_session_tournoi'))

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
