"""Phase 2 du journal d'audit : le dossier sportif est trace.

Pendant executable de docs/audit-admin-plan.md, phase 2. Avant elle, le coeur
du site -- celui qui PRODUIT le classement -- n'avait aucune trace : on pouvait
changer le mu d'un joueur a la main sans que rien ne dise qui, quand, ni depuis
quelle valeur. C'etait le constat 3.1, le seul 🔴 du plan.

Ce que ce fichier verrouille :

  1. Les dix gestes du §3.1 ecrivent bien leur ligne d'audit.
  2. Le vocabulaire FIGE le 2026-09-18 (§5.2bis) est respecte a la lettre.
     Renommer une action apres coup laisse des lignes orphelines qu'aucun
     filtre ne retrouve : ce test est ce qui rend ce gel executable.
  3. L'AVANT/APRES est consigne pour ce qui se modifie, et la trace est ecrite
     AVANT ce qui disparait -- une suppression qui s'audite apres coup n'a plus
     rien a consigner.

Aucun Postgres : le curseur est scripte. Ce fichier ne valide donc pas le SQL,
mais qui ecrit quoi, avec quel contenu, et dans quel ordre.
"""
from harness import *
from flask import Flask
import json as _json

H = {'X-Session-Token': 'tok'}
SESSION = lambda role: (
    r"FROM sessions_joueurs s JOIN comptes c",
    ligne_session(compte_id=1, discord_id='111', username='a',
                  global_name='A', role=role))


def monter(plan, role='superadmin'):
    """routes_admin sur un curseur scripte, execute_values capture."""
    cur, conn = install_db(list(plan) + [SESSION(role)])
    recharger()
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


def lignes_audit(cur):
    """Les (action, cible_type, cible_id, details) ecrites dans le journal."""
    sorties = []
    for sql, params in cur.executed:
        if 'INSERT INTO audit_admin' in sql and params:
            details = params[4]
            sorties.append({
                "action": params[0], "acteur": params[1],
                "cible_type": params[2], "cible_id": params[3],
                "details": _json.loads(details) if details else None,
            })
    return sorties


def une(cur, action):
    """La ligne d'audit portant cette action, ou None."""
    for l in lignes_audit(cur):
        if l['action'] == action:
            return l
    return None


def ordre(cur, fragment):
    """Rang de la premiere requete contenant ce fragment, ou -1."""
    for i, (sql, _) in enumerate(cur.executed):
        if fragment in sql:
            return i
    return -1


# ===========================================================================
print("\n=== Le vocabulaire fige le 2026-09-18 est respecte (§5.2bis) ===")
# Le gel n'a de valeur que s'il est verifiable. Une action renommee apres coup
# laisse en base des lignes que plus aucun filtre ne ramene -- les anciennes
# gardent l'ancien nom, les nouvelles portent le nouveau.
RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
_src = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read()

VOCABULAIRE_PHASE_2 = [
    'joueur_modifie', 'joueur_supprime', 'tournoi_ajoute', 'tournoi_supprime',
    'tournoi_annule', 'reset_global_applique', 'reset_global_annule',
    'config_modifiee', 'ligues_configurees',
    # Ajoute le 2026-09-19 : la creation d'un recap en brouillon est une
    # action d'administration comme une autre, et n'etait pas tracee.
    'recap_cree',
]
for _action in VOCABULAIRE_PHASE_2:
    check("l'action « %s » est ecrite" % _action, "'%s'" % _action in _src, _action)

# `joueur_cree` EXISTAIT DEJA (routes_comptes.py, creation a l'approbation
# d'une liaison). La phase 2 devait le REUTILISER, pas en creer un homonyme :
# deux actions du meme nom tracant deux gestes differents sont indemelables.
check("joueur_cree est reutilise, pas redefini sous un autre nom",
      "'joueur_cree'" in _src)
# Des synonymes concurrents rendraient le filtre par action incomplet : une
# moitie des lignes porterait un nom, l'autre moitie un autre.
for _interdit in ('joueur_ajoute', 'fiche_creee', 'joueur_edite', 'tournoi_cree'):
    check("aucun synonyme concurrent : « %s »" % _interdit,
          "'%s'" % _interdit not in _src, _interdit)

# La convention <objet>_<participe> rend un filtre par prefixe utilisable :
# `joueur_%` ramene tout le domaine d'un coup.
for _a in VOCABULAIRE_PHASE_2:
    check("« %s » suit la convention <objet>_<participe>" % _a, '_' in _a, _a)


# ===========================================================================
print("\n=== mu/sigma : la trace qui repond a la question d'origine ===")
# « Qui a mis ce joueur a 32.5, et quelle etait sa valeur avant ? »

FICHE = ('Alice', 50.0, 8.333333333, True, '#FF0000', 2)
PLAN_JOUEUR = [
    (r"SELECT nom, mu, sigma, is_ranked, color, consecutive_missed", FICHE),
    (r"SELECT 1 FROM permissions_admin", (1,)),
    (r"SELECT id FROM Joueurs WHERE nom", None),
]

cli, cur, conn = monter(PLAN_JOUEUR)
r = cli.put('/admin/joueurs/7', json={
    'nom': 'Alice', 'mu': 32.5, 'sigma': 8.333, 'is_ranked': True, 'color': '#FF0000',
}, headers=H)
_l = une(cur, 'joueur_modifie')

check("modifier mu ecrit une ligne d'audit", _l is not None, r.get_json())
check("  elle vise la bonne fiche",
      _l and _l['cible_type'] == 'joueur' and _l['cible_id'] == 7, _l)
check("  l'AVANT est consigne", _l and _l['details']['avant'].get('mu') == 50.0, _l)
check("  l'APRES aussi", _l and _l['details']['apres'].get('mu') == 32.5, _l)
check("  le drapeau score_modifie est leve", _l and _l['details']['score_modifie'] is True, _l)
# Sans le nom, la ligne dit « fiche 7 modifiee » et il faut aller chercher qui
# est le joueur 7 -- ou le deviner, si la fiche a ete renommee depuis.
check("  la FICHE CONCERNEE est nommee", _l and _l['details'].get('joueur_nom') == 'Alice', _l)
check("  et l'acteur est nomme", _l and _l['acteur'] == 1, _l)

# Le sigma revient de la modale arrondi a 3 decimales (8.333333333 -> 8.333).
# La route ne le compte PAS comme une modification -- sinon elle exigerait
# `edition_mu_sigma` d'un admin qui n'a touche a rien. Le journal doit suivre
# exactement le meme predicat, sinon les deux divergent.
check("  un sigma revenu arrondi n'est pas compte comme modifie",
      _l and 'sigma' not in _l['details']['champs'], _l)

# Un simple renommage ne doit PAS lever score_modifie : c'est tout l'interet du
# drapeau, filtrer les modifications de score parmi les gestes anodins.
cli, cur, conn = monter(PLAN_JOUEUR)
cli.put('/admin/joueurs/7', json={
    'nom': 'Bob', 'mu': 50.0, 'sigma': 8.333, 'is_ranked': True, 'color': '#FF0000',
}, headers=H)
_l = une(cur, 'joueur_modifie')
check("un renommage seul est trace", _l is not None)
check("  mais score_modifie reste FAUX", _l and _l['details']['score_modifie'] is False, _l)
check("  et le champ nom est nomme", _l and _l['details']['champs'] == ['nom'], _l)

# Renvoyer la fiche inchangee n'est pas une modification : aucune ligne.
cli, cur, conn = monter(PLAN_JOUEUR)
cli.put('/admin/joueurs/7', json={
    'nom': 'Alice', 'mu': 50.0, 'sigma': 8.333, 'is_ranked': True, 'color': '#FF0000',
}, headers=H)
check("renvoyer la fiche inchangee n'ecrit RIEN",
      une(cur, 'joueur_modifie') is None, lignes_audit(cur))


# ===========================================================================
print("\n=== Creation et suppression de fiche ===")

cli, cur, conn = monter([
    (r"SELECT 1 FROM permissions_admin", (1,)),
    (r"SELECT id FROM Joueurs WHERE nom", None),
    (r"INSERT INTO Joueurs", (7,)),
])
r = cli.post('/admin/joueurs', json={'nom': 'Neuf'}, headers=H)
_l = une(cur, 'joueur_cree')
check("creer une fiche ecrit joueur_cree", _l is not None, r.get_json())
check("  avec l'id de la fiche posee", _l and _l['cible_id'] == 7, _l)
check("  et le nom consigne", _l and _l['details']['nom'] == 'Neuf', _l)
check("  score_impose est faux au score par defaut",
      _l and _l['details']['score_impose'] is False, _l)

cli, cur, conn = monter([
    (r"SELECT 1 FROM permissions_admin", (1,)),
    (r"SELECT id FROM Joueurs WHERE nom", None),
    (r"INSERT INTO Joueurs", (8,)),
])
cli.post('/admin/joueurs', json={'nom': 'Truque', 'mu': 99.0}, headers=H)
_l = une(cur, 'joueur_cree')
check("  score_impose est VRAI sur un depart hors defaut",
      _l and _l['details']['score_impose'] is True, _l)

cli, cur, conn = monter([
    (r"SELECT 1 FROM permissions_admin", (1,)),
    (r"SELECT nom FROM Joueurs WHERE id", ('Alice',)),
    (r"SELECT COUNT\(\*\) FROM Participations", (0,)),
    (r"FROM comptes WHERE joueur_id", None),
])
r = cli.delete('/admin/joueurs/7', headers=H)
_l = une(cur, 'joueur_supprime')
check("supprimer une fiche ecrit joueur_supprime", _l is not None, r.get_json())
check("  le nom y est consigne -- seule trace qui en restera",
      _l and _l['details']['nom'] == 'Alice', _l)
# L'ordre compte : apres le DELETE, la fiche n'existe plus et son nom non plus.
check("  et la ligne est ecrite AVANT le DELETE",
      ordre(cur, 'INSERT INTO audit_admin') < ordre(cur, 'DELETE FROM Joueurs'),
      (ordre(cur, 'INSERT INTO audit_admin'), ordre(cur, 'DELETE FROM Joueurs')))


# ===========================================================================
print("\n=== Reset global : le geste, pas le detail par joueur ===")

cli, cur, conn = monter([
    (r"SELECT COUNT\(\*\) FROM Tournois WHERE date >= ", (0,)),
    (r"SELECT id, sigma FROM Joueurs", [(1, 5.0), (2, 6.0)]),
    (r"INSERT INTO global_resets", (42,)),
], role='superadmin')
r = cli.post('/api/admin/global-reset',
             json={'value': 2.0, 'max_sigma': 10, 'date': '2026-09-19'}, headers=H)
_l = une(cur, 'reset_global_applique')
check("le reset ecrit reset_global_applique", _l is not None, r.get_json())
check("  il vise l'id du reset, pour le retrouver", _l and _l['cible_id'] == 42, _l)
check("  la valeur appliquee est consignee", _l and _l['details']['valeur'] == 2.0, _l)
check("  ainsi que le nombre de joueurs touches",
      _l and _l['details']['joueurs_touches'] == 2, _l)
# Le detail par joueur vit dans global_reset_details : le dupliquer ferait
# grossir le journal sans rien apprendre.
check("  mais PAS le detail par joueur (il vit dans global_reset_details)",
      _l and 'joueurs' not in _l['details'], _l)


# ===========================================================================
print("\n=== Ce que les gestes irreversibles doivent consigner ===")
# delete_tournament ne restaure PAS les mu/sigma (R-37), contrairement a
# l'annulation. Le journal le dit, faute de pouvoir le corriger ici.
check("tournoi_supprime consigne que les scores ne sont PAS restaures",
      "'scores_restaures': False" in _src or '"scores_restaures": False' in _src)

# Les trois suppressions ecrivent leur audit AVANT de detruire.
for _fn, _del in (('def api_delete_joueur', 'DELETE FROM Joueurs'),
                  ('def revert_last_tournament', 'DELETE FROM Tournois'),
                  ('def delete_tournament', 'DELETE FROM Tournois')):
    _corps = _src[_src.index(_fn):]
    _corps = _corps[:_corps.index('\n@admin_bp.route') if '\n@admin_bp.route' in _corps else len(_corps)]
    _i_audit = _corps.find('audit.ecrire')
    _i_del = _corps.find(_del)
    check("%s() audite AVANT de detruire" % _fn[4:],
          _i_audit >= 0 and _i_del >= 0 and _i_audit < _i_del, (_i_audit, _i_del))


# ===========================================================================
print("\n=== Configuration : deux domaines, deux actions ===")
# update_config sert gestion_config ET gestion_ligues. Les confondre dans le
# journal rendrait impossible de filtrer « qui a touche aux ligues » sans
# relire chaque ligne de details.
_conf = _src[_src.index('def update_config'):]
_conf = _conf[:_conf.index('\n@admin_bp.route')]
check("update_config distingue config_modifiee et ligues_configurees",
      "'config_modifiee'" in _conf and "'ligues_configurees'" in _conf)
check("et setup_ligues reutilise ligues_configurees, meme domaine",
      _src.count("'ligues_configurees'") >= 2)

# Le declassement rejoue touche TOUS les joueurs d'un coup : le signaler evite
# de lire la ligne comme un reglage anodin.
check("un declassement rejoue est signale dans les details",
      'declassement_rejoue' in _conf)


# ===========================================================================
print("\n=== Non-regression : un seul chemin d'ecriture (phase 1) ===")
# La phase 2 ajoute beaucoup d'appels : aucun ne doit rouvrir un second chemin
# d'ecriture vers la table.
_n = sum(1 for _l in _src.splitlines()
         if 'INSERT INTO audit_admin' in _l and 'acteur_compte_id' in _l
         and not _l.strip().startswith('#'))
check("routes_admin.py n'ecrit toujours pas en direct dans audit_admin", _n == 0, _n)
check("il passe par le helper partage", 'audit.ecrire(' in _src)

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
