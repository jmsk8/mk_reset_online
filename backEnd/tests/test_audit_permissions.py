"""Coherence d'ensemble des permissions delegables : socle des roles,
catalogue clos, regle de rang, plafond de delegation, 503 sur panne de base."""
from harness import *
from flask import Flask, jsonify

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FRONT = os.path.join(RACINE, '..', 'frontEnd')

H = {'X-Session-Token': 'tok'}


def io_open(chemin):
    with open(chemin, encoding='utf-8') as f:
        return f.read()


from constants import (PERMISSIONS_CATALOGUE, SOUS_PERMISSIONS, ROLE_HIERARCHY,
                       ROLE_PLAYER, ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN)


def app_permission(permission, role='admin', accordees=(), compte_id=1,
                   db_morte=False):
    """Appli minimale derriere @permission_required(<permission>)."""
    accordees = set(accordees)
    plan = [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=compte_id, discord_id='111', username='a',
                       global_name='A', role=role)),
        (r"SELECT 1 FROM permissions_admin",
         lambda params: (1,) if params and params[1] in accordees else None),
    ]
    cur, conn = install_db(plan)
    if db_morte:
        # La lecture des permissions echoue apres la resolution de session.
        _vrai_execute = cur.execute

        def execute(sql, params=None):
            if 'permissions_admin' in sql:
                raise RuntimeError('base injoignable')
            return _vrai_execute(sql, params)
        cur.execute = execute
    recharger()
    import auth, importlib
    importlib.reload(auth)
    app = Flask(__name__)

    @app.route('/protege', methods=['POST'])
    @auth.permission_required(permission)
    def protege():
        return jsonify({"ok": True})

    return app.test_client(), cur, conn


# ===========================================================================
print("\n=== 1. Le socle chef_admin / superadmin couvre TOUT le catalogue ===")
# Une nouvelle permission doit etre couverte par le socle chef_admin.
for permission in sorted(PERMISSIONS_CATALOGUE):
    cli, _, _ = app_permission(permission, role='chef_admin', accordees=set())
    r = cli.post('/protege', headers=H)
    check("chef_admin passe sur %s sans aucune ligne accordee" % permission,
          r.status_code == 200, r.status_code)

for permission in sorted(PERMISSIONS_CATALOGUE):
    cli, _, _ = app_permission(permission, role='superadmin', accordees=set())
    check("superadmin passe sur %s" % permission,
          cli.post('/protege', headers=H).status_code == 200)

# Un player ne passe jamais, meme avec une ligne en base.
for permission in sorted(PERMISSIONS_CATALOGUE):
    cli, _, _ = app_permission(permission, role='player',
                               accordees=PERMISSIONS_CATALOGUE)
    r = cli.post('/protege', headers=H)
    check("player refusé sur %s malgré des lignes en base" % permission,
          r.status_code == 403, r.status_code)


# ===========================================================================
print("\n=== 2. Le catalogue est clos : rien d'orphelin, rien d'inconnu ===")
import re as _re

sources = {f: io_open(os.path.join(RACINE, f))
           for f in os.listdir(RACINE) if f.endswith('.py')}
tout = '\n'.join(sources.values())

# a) toute permission citee par un decorateur existe au catalogue.
citees = set(_re.findall(r"permission_required\(\s*'(\w+)'", tout))
citees |= set(_re.findall(r"compte_a_permission\([^,]+,\s*'(\w+)'", tout))
# Les droits par champ passent par PERMISSIONS_CHAMPS_JOUEUR.
from constants import PERMISSIONS_CHAMPS_JOUEUR
check("la table des champs n'est lue que par une route qui la verifie",
      'PERMISSIONS_CHAMPS_JOUEUR' in sources['routes_admin.py']
      and 'compte_a_permission' in sources['routes_admin.py'])
citees |= set(PERMISSIONS_CHAMPS_JOUEUR.values())
check("toute permission citée dans le backend existe au catalogue",
      citees <= set(PERMISSIONS_CATALOGUE),
      sorted(citees - set(PERMISSIONS_CATALOGUE)))

# b) toute permission du catalogue est verifiee quelque part.
non_portees = set(PERMISSIONS_CATALOGUE) - citees
check("aucune permission du catalogue n'est décorative",
      not non_portees, sorted(non_portees))

# c) les sous-permissions sont citees comme les autres (pas seulement declarees)
for enfant in SOUS_PERMISSIONS:
    check("la sous-permission %s protège au moins une route" % enfant,
          enfant in citees)


# ===========================================================================
print("\n=== 3. Palier admin -> admin : la lacune 8.1, prouvée par exécution ===")
# Regle de rang : un admin n'agit pas sur un autre admin.
import importlib


def app_cible(role_acteur, role_cible, acteur_id=1, cible_id=9):
    """Route en @compte_cible_protegee, acteur et cible de rôles donnés."""
    plan = [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=acteur_id, discord_id='111', username='a',
                       global_name='A', role=role_acteur)),
        (r"SELECT 1 FROM permissions_admin", (1,)),
        (r"SELECT role FROM comptes WHERE id", (role_cible,)),
    ]
    cur, conn = install_db(plan)
    recharger()
    import auth
    importlib.reload(auth)
    app = Flask(__name__)

    @app.route('/cible/<int:compte_id>', methods=['POST'])
    @auth.permission_required('gestion_comptes')
    @auth.compte_cible_protegee
    def agir(compte_id):
        return jsonify({"ok": True})

    return app.test_client(), cur, conn


def statut(role_acteur, role_cible):
    cli, _, _ = app_cible(role_acteur, role_cible)
    return cli.post('/cible/9', headers=H).status_code


check("admin -> superadmin refusé", statut('admin', 'superadmin') == 403)
check("admin -> chef_admin refusé", statut('admin', 'chef_admin') == 403)
check("chef_admin -> chef_admin refusé (R-52)",
      statut('chef_admin', 'chef_admin') == 403)
check("superadmin -> chef_admin autorisé",
      statut('superadmin', 'chef_admin') == 200)
check("superadmin -> superadmin (lui-même via un autre id) refusé",
      statut('superadmin', 'superadmin') == 403)
check("chef_admin -> admin autorisé", statut('chef_admin', 'admin') == 200)
check("admin -> player autorisé", statut('admin', 'player') == 200)

# Rang egal : refus.
code = statut('admin', 'admin')
check("admin -> admin refusé (lacune 8.1, corrigée)",
      code == 403, "reçu %s -- la lacune est rouverte" % code)

# Matrice acteur x cible : rang(acteur) > rang(cible) -> autorise, sinon 403.
# Un player est arrete avant par permission_required (code verifie).
print("  -- matrice acteur x cible --")
for acteur in (ROLE_PLAYER, ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN):
    for cible in (ROLE_PLAYER, ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN):
        cli, _, _ = app_cible(acteur, cible)
        r = cli.post('/cible/9', headers=H)
        attendu = 200 if ROLE_HIERARCHY[acteur] > ROLE_HIERARCHY[cible] else 403
        ok = r.status_code == attendu
        # Le 403 d'un player vient du decorateur de permission.
        if acteur == ROLE_PLAYER:
            ok = r.status_code == 403
        check("  %s -> %s : %s" % (acteur, cible, attendu), ok,
              (r.status_code, (r.get_json() or {}).get('code')))


# ===========================================================================
print("  -- cas limites de la règle de rang --")
# Un role illisible n'ouvre jamais.
check("acteur au rôle inconnu -> refusé (compte comme rang le plus bas)",
      statut('rôle_corrompu', 'player') == 403)
check("cible au rôle inconnu -> refusée (compte comme rang le plus haut)",
      statut('superadmin', 'rôle_corrompu') == 403)

# Agir sur soi reste permis par le decorateur.
cli, cur, _ = app_cible('admin', 'admin', acteur_id=7, cible_id=7)
r = cli.post('/cible/7', headers=H)
check("agir sur soi-même reste permis malgré le rang égal",
      r.status_code == 200, (r.status_code, r.get_json()))
check("  et la base n'est même pas lue pour cela",
      not any('SELECT role FROM comptes' in s for s, _ in cur.executed))

# Cible inexistante : 404 par la route, pas 403.
plan = [
    (r"FROM sessions_joueurs s JOIN comptes c",
     ligne_session(compte_id=1, discord_id='111', username='a',
                   global_name='A', role='chef_admin')),
    (r"SELECT 1 FROM permissions_admin", (1,)),
    (r"SELECT role FROM comptes WHERE id", None),
]
install_db(plan)
recharger()
import auth as _a0
importlib.reload(_a0)
_app = Flask(__name__)


@_app.route('/cible/<int:compte_id>', methods=['POST'])
@_a0.permission_required('gestion_comptes')
@_a0.compte_cible_protegee
def _agir(compte_id):
    return jsonify({"ok": True})


r = _app.test_client().post('/cible/9', headers=H)
check("compte inexistant : laissé à la route (404 de son ressort), pas 403",
      r.status_code == 200, r.status_code)

# La regle est une comparaison de rang, sans role cite en dur.
src_auth = io_open(os.path.join(RACINE, 'auth.py'))
_d = src_auth.find('def compte_cible_protegee')
_f = src_auth.find('\ndef ', _d + 10)
corps_decorateur = src_auth[_d:_f]
# _rangs porte le defaut ferme, refus_de_rang la comparaison.
_d = src_auth.find('def _rangs')
_f = src_auth.find('\ndef ', src_auth.find('def refus_de_rang') + 10)
corps_cible = src_auth[_d:_f]
check("compte_cible_protegee delegue la decision a refus_de_rang",
      'refus_de_rang(' in corps_decorateur and 'ROLE_HIERARCHY' not in corps_decorateur)
check("la décision repose sur ROLE_HIERARCHY, pas sur des rôles en dur",
      'ROLE_HIERARCHY' in corps_cible and 'rang_acteur > rang_cible' in corps_cible)
check("  le cas chef_admin n'est plus un `if` particulier",
      'role_cible == ROLE_CHEF_ADMIN' not in corps_cible)


print("\n=== 4. Plafond de délégation : symétrique octroi / retrait ===")
# Le plafond de delegation vaut aussi pour le retrait.
src_comptes = io_open(os.path.join(RACINE, 'routes_comptes.py'))

for nom in ('accorder_permission', 'retirer_permission'):
    deb = src_comptes.find('def %s' % nom)
    fin = src_comptes.find('\n@comptes_bp.route', deb)
    corps = src_comptes[deb:fin]
    check("%s : plafond vérifié" % nom,
          'permissions_delegables_par(g.compte)' in corps)
    check("%s : code plafond_delegation" % nom,
          'plafond_delegation' in corps)
    check("%s : permission hors catalogue -> 400" % nom,
          'permission_inconnue' in corps)
    check("%s : refus de l'auto-modification" % nom,
          'refuse_auto_modification' in corps)

# Les routes d'ecriture portent compte_cible_protegee.
for nom in ('accorder_permission', 'retirer_permission'):
    i = src_comptes.find('def %s' % nom)
    entete = src_comptes[max(0, i - 320):i]
    check("%s : réservée au chef_admin+" % nom,
          'role_required(ROLE_CHEF_ADMIN)' in entete, entete[-160:])
    check("%s : porte compte_cible_protegee" % nom,
          '@compte_cible_protegee' in entete)

import auth
importlib.reload(auth)
check("un admin ne délègue rien, même chargé de droits",
      auth.permissions_delegables_par({'role': 'admin', 'id': 1}) == frozenset())
check("un player ne délègue rien",
      auth.permissions_delegables_par({'role': 'player', 'id': 1}) == frozenset())
check("un chef_admin délègue le catalogue entier",
      auth.permissions_delegables_par({'role': 'chef_admin', 'id': 1})
      == frozenset(PERMISSIONS_CATALOGUE))
check("un superadmin délègue le catalogue entier",
      auth.permissions_delegables_par({'role': 'superadmin', 'id': 1})
      == frozenset(PERMISSIONS_CATALOGUE))
check("un rôle inconnu ne délègue rien (défaut fermé)",
      auth.permissions_delegables_par({'role': 'inventé', 'id': 1}) == frozenset())


# ===========================================================================
print("\n=== 5. Base indisponible -> 503, jamais 403 (R-28 / R-55) ===")
# Un 403 ferait purger la session cote frontend.
cli, _, _ = app_permission('gestion_comptes', role='admin',
                           accordees={'gestion_comptes'}, db_morte=True)
r = cli.post('/protege', headers=H)
check("permission_required : 503 quand la base tombe",
      r.status_code == 503, (r.status_code, r.get_json()))
check("  et le code est 'indisponible'",
      (r.get_json() or {}).get('code') == 'indisponible', r.get_json())


def app_cible_db_morte():
    plan = [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=1, discord_id='111', username='a',
                       global_name='A', role='chef_admin')),
    ]
    cur, conn = install_db(plan)
    _vrai = cur.execute

    def execute(sql, params=None):
        if 'SELECT role FROM comptes' in sql:
            raise RuntimeError('base injoignable')
        return _vrai(sql, params)
    cur.execute = execute
    recharger()
    import auth as _a
    importlib.reload(_a)
    app = Flask(__name__)

    @app.route('/cible/<int:compte_id>', methods=['POST'])
    @_a.role_required('chef_admin')
    @_a.compte_cible_protegee
    def agir(compte_id):
        return jsonify({"ok": True})
    return app.test_client()

r = app_cible_db_morte().post('/cible/9', headers=H)
check("compte_cible_protegee : 503 quand la base tombe",
      r.status_code == 503, (r.status_code, r.get_json()))

import auth as _auth
importlib.reload(_auth)
cur, conn = install_db([])
_vrai = cur.execute


def _explose(sql, params=None):
    raise RuntimeError('base injoignable')


cur.execute = _explose
recharger()
import auth as _a2
importlib.reload(_a2)
app = Flask(__name__)
with app.test_request_context('/'):
    accordee, erreur = _a2.compte_a_permission({'id': 1, 'role': 'admin'},
                                               'gestion_config')
    check("compte_a_permission : renvoie une erreur, pas un False silencieux",
          erreur is not None and accordee is False)
    check("  et cette erreur est un 503", erreur is not None and erreur[1] == 503,
          erreur[1] if erreur else None)


# ===========================================================================
print("\n=== 6. Une permission inconnue est refusée à la déclaration ===")
# Une faute de frappe doit lever a l'import.
importlib.reload(_a2)
for fabrique, nom in ((_a2.permission_required, 'permission_required'),
                      (None, None)):
    if fabrique is None:
        continue
    try:
        fabrique('gestion_inexistante')
        check("%s refuse une permission hors catalogue" % nom, False,
              'aucune exception')
    except ValueError:
        check("%s refuse une permission hors catalogue" % nom, True)

with app.test_request_context('/'):
    try:
        _a2.compte_a_permission({'id': 1, 'role': 'admin'}, 'gestion_inexistante')
        check("compte_a_permission refuse une permission hors catalogue", False,
              'aucune exception')
    except ValueError:
        check("compte_a_permission refuse une permission hors catalogue", True)


# ===========================================================================
print("\n=== 7. Capacités de rôle : jamais dans le catalogue délégable ===")
# Ces pouvoirs ne doivent pas entrer dans le catalogue.
for interdit in ('jetons_bot', 'gestion_bot', 'purge_rgpd', 'changement_role',
                 'legs_superadmin', 'annulation_tournoi'):
    check("'%s' absent du catalogue (capacité de rôle)" % interdit,
          interdit not in PERMISSIONS_CATALOGUE)

for motif, attendu in (
        (r"@comptes_bp.route\('/admin/bot-tokens'", 'ROLE_SUPERADMIN'),
        (r"def changer_role", 'ROLE_CHEF_ADMIN')):
    m = _re.search(motif, src_comptes)
    if m:
        entete = src_comptes[max(0, m.start() - 400):m.start() + 200]
        check("%s reste une capacité de rôle" % motif,
              'role_required' in entete and attendu in entete, entete[-200:])


# ===========================================================================
print("\n=== 8. Hiérarchie des rôles : ordre strict et complet ===")
check("les 4 rôles sont dans la hiérarchie",
      set(ROLE_HIERARCHY) == {ROLE_PLAYER, ROLE_ADMIN, ROLE_CHEF_ADMIN,
                              ROLE_SUPERADMIN})
check("l'ordre est strictement croissant",
      ROLE_HIERARCHY[ROLE_PLAYER] < ROLE_HIERARCHY[ROLE_ADMIN]
      < ROLE_HIERARCHY[ROLE_CHEF_ADMIN] < ROLE_HIERARCHY[ROLE_SUPERADMIN])
check("aucun rang dupliqué",
      len(set(ROLE_HIERARCHY.values())) == len(ROLE_HIERARCHY))

for exige in (ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN):
    for porte in ROLE_HIERARCHY:
        plan = [(r"FROM sessions_joueurs s JOIN comptes c",
                 ligne_session(compte_id=1, discord_id='111', username='a',
                               global_name='A', role=porte))]
        install_db(plan)
        recharger()
        import auth as _a3
        importlib.reload(_a3)
        app_r = Flask(__name__)

        @app_r.route('/r', methods=['POST'])
        @_a3.role_required(exige)
        def r_route():
            return jsonify({"ok": True})

        code = app_r.test_client().post('/r', headers=H).status_code
        attendu = 200 if ROLE_HIERARCHY[porte] >= ROLE_HIERARCHY[exige] else 403
        check("role_required(%s) vs %s -> %s" % (exige, porte, attendu),
              code == attendu, code)


# ===========================================================================
print("\n=== 9. Le frontend ne peut pas diverger du backend ===")
front = io_open(os.path.join(FRONT, 'frontend.py'))

# Chaque permission du catalogue a un libelle.
comptes_html = io_open(os.path.join(FRONT, 'templates', 'admin_comptes.html'))
i = comptes_html.find('const LIBELLES = {')
# Bloc delimite par son accolade fermante.
fin_bloc = comptes_html.find('\n            };', i)
bloc = comptes_html[i:fin_bloc] if i >= 0 and fin_bloc > i else ''
sans_libelle = [p for p in PERMISSIONS_CATALOGUE if p + ':' not in bloc]
check("chaque permission du catalogue a un libellé dans le panneau",
      bool(bloc) and not sans_libelle, sans_libelle or 'bloc LIBELLES introuvable')

# peut() est une lambda du context processor.
check("le frontend expose un helper peut() aux templates",
      'peut=lambda permission' in front or 'def peut(' in front)

# Table des rangs dupliquee en JS : doit rester alignee.
i_rangs = comptes_html.find('const RANGS = {')
bloc_rangs = comptes_html[i_rangs:comptes_html.find('}', i_rangs)] if i_rangs >= 0 else ''
rangs_front = dict((m.group(1), int(m.group(2)))
                   for m in _re.finditer(r'(\w+):\s*(\d+)', bloc_rangs))
check("les rangs du frontend sont ceux de ROLE_HIERARCHY",
      rangs_front == dict(ROLE_HIERARCHY), (rangs_front, dict(ROLE_HIERARCHY)))

# Les gestes sous compte_cible_protegee sont masques sur une cible protegee.
check("le panneau applique la règle de rang (et non deux rôles en dur)",
      'estCibleProtegee' in comptes_html
      and "c.role === 'chef_admin' && !EST_SUPERADMIN" not in comptes_html)
check("les boutons d'action sont conditionnés à la cible",
      'const peutAgir' in comptes_html)
for geste in ('/sessions', '/statut', '/delier', '/sync'):
    # Chaque appel est garde par peutAgir.
    i_g = comptes_html.find("'/admin/comptes/' + c.id + '" + geste)
    check("  le bouton %s est sous peutAgir" % geste,
          i_g > 0 and 'peutAgir' in comptes_html[max(0, i_g - 2500):i_g], geste)
check("le frontend connaît permissions_effectives",
      'permissions_effectives' in front or 'SOUS_PERMISSIONS' in front)


# ===========================================================================
print("\n=== 10. Toute route d'écriture admin est protégée ===")
# Une route admin sous @player_required doit verifier un droit dans son corps.
for fichier in ('routes_admin.py', 'routes_comptes.py'):
    src = sources[fichier]
    # Entete entre @route et def.
    for m in _re.finditer(r"@\w+\.route\('(/admin/[^']+)'([^)]*)\)", src):
        chemin, reste = m.group(1), m.group(2)
        if 'POST' not in reste and 'PUT' not in reste and 'DELETE' not in reste:
            continue
        fin_def = src.find('\ndef ', m.end())
        entete = src[m.end():fin_def]
        corps_deb = fin_def
        corps_fin = src.find('\n@', corps_deb)
        corps = src[corps_deb:corps_fin if corps_fin > 0 else len(src)]
        protegee = ('permission_required' in entete or 'role_required' in entete
                    or 'admin_required' in entete)
        if not protegee and 'player_required' in entete:
            # Tolere seulement si un droit est verifie dans le corps.
            protegee = 'compte_a_permission' in corps
            check("%s : @player_required mais vérifie un droit dans son corps"
                  % chemin, protegee, entete.strip()[:120])
        else:
            check("%s : protégée" % chemin, protegee, entete.strip()[:120])


print("\n" + "=" * 60)
print("%s/%s assertions" % (sum(1 for o in OK if o), len(OK)))
sys.exit(0 if all(OK) else 1)
