"""Revue des permissions deleguables : coherence du modele, bout en bout.

Ce fichier ne re-teste pas ce que test_permissions.py, test_scission_permissions.py
et test_sous_permissions.py couvrent deja. Il attaque les JOINTURES entre les
pieces -- les endroits ou chaque morceau est correct isolement mais ou l'ensemble
peut mentir :

  - le palier admin -> admin, que RIEN ne teste aujourd'hui (avancement 8.1) ;
  - la cloture du catalogue : toute permission declaree est-elle portee par au
    moins une route, et toute route protegee cite-t-elle une permission connue ;
  - le plafond de delegation applique symetriquement a l'octroi ET au retrait ;
  - la non-regression du socle chef_admin/superadmin sur le catalogue entier ;
  - 503 plutot que 403 quand la base tombe, sur les TROIS chemins d'autorisation.
"""
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
        # La session se resout, puis la lecture des permissions explose : c'est
        # exactement le cas que R-55 distingue de « pas le droit ».
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
# Regression majeure si elle casse : une permission ajoutee au catalogue sans y
# penser laisserait un chef_admin dehors de sa propre route, sans qu'aucun test
# existant ne s'en apercoive (ils citent des permissions nommees une a une).
for permission in sorted(PERMISSIONS_CATALOGUE):
    cli, _, _ = app_permission(permission, role='chef_admin', accordees=set())
    r = cli.post('/protege', headers=H)
    check("chef_admin passe sur %s sans aucune ligne accordee" % permission,
          r.status_code == 200, r.status_code)

for permission in sorted(PERMISSIONS_CATALOGUE):
    cli, _, _ = app_permission(permission, role='superadmin', accordees=set())
    check("superadmin passe sur %s" % permission,
          cli.post('/protege', headers=H).status_code == 200)

# Le pendant : un player connecte ne passe JAMAIS, meme si une ligne existait
# en base a son nom (role rétrogradé, purge R-53 ratee).
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

# a) toute permission citee par un decorateur existe au catalogue. Une faute de
#    frappe leverait ValueError a l'import -- mais seulement si le module est
#    importe ; ce controle statique ne depend pas de l'import.
citees = set(_re.findall(r"permission_required\(\s*'(\w+)'", tout))
citees |= set(_re.findall(r"compte_a_permission\([^,]+,\s*'(\w+)'", tout))
# Les droits par champ de la fiche joueur ne sont jamais ecrits en dur : la
# route boucle sur PERMISSIONS_CHAMPS_JOUEUR (constants.py). Ils portent donc
# bel et bien une verification, que ce controle statique ne verrait pas.
from constants import PERMISSIONS_CHAMPS_JOUEUR
check("la table des champs n'est lue que par une route qui la verifie",
      'PERMISSIONS_CHAMPS_JOUEUR' in sources['routes_admin.py']
      and 'compte_a_permission' in sources['routes_admin.py'])
citees |= set(PERMISSIONS_CHAMPS_JOUEUR.values())
check("toute permission citée dans le backend existe au catalogue",
      citees <= set(PERMISSIONS_CATALOGUE),
      sorted(citees - set(PERMISSIONS_CATALOGUE)))

# b) toute permission du catalogue est reellement portee quelque part. Une
#    entree jamais citee est une case a cocher qui n'ouvre aucune porte :
#    l'admin croit deleguer un droit, il ne delegue rien.
non_portees = set(PERMISSIONS_CATALOGUE) - citees
check("aucune permission du catalogue n'est décorative",
      not non_portees, sorted(non_portees))

# c) les sous-permissions sont citees comme les autres (pas seulement declarees)
for enfant in SOUS_PERMISSIONS:
    check("la sous-permission %s protège au moins une route" % enfant,
          enfant in citees)


# ===========================================================================
print("\n=== 3. Palier admin -> admin : la lacune 8.1, prouvée par exécution ===")
# Aucun test n'a jamais couvert ce palier (avancement, « Ce qui reste » §1).
# Ces assertions DECRIVENT LA REGLE VOULUE : elles echouent tant que la regle de
# rang generique n'est pas posee. C'est leur role -- figer la cible.
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


# Ce qui marche deja -- la partie cablee en dur.
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

# LA LACUNE 8.1, corrigee le 2026-09-14. rang(admin) == rang(admin) : refus.
code = statut('admin', 'admin')
check("admin -> admin refusé (lacune 8.1, corrigée)",
      code == 403, "reçu %s -- la lacune est rouverte" % code)

# La matrice complete acteur x cible, pour que la regle soit lue d'un coup
# d'oeil le jour ou on la corrige. Attendu selon la regle de rang generique :
# rang(acteur) > rang(cible) -> autorise, sinon 403.
#
# NB : un player est deja arrete en amont par permission_required (code
# 'permission_manquante'), jamais par compte_cible_protegee. Sa ligne passe donc
# pour de bonnes raisons de facade -- on verifie le CODE d'erreur, sinon
# l'assertion affirmerait une protection de rang qui n'a pas joue.
print("  -- matrice acteur x cible --")
for acteur in (ROLE_PLAYER, ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN):
    for cible in (ROLE_PLAYER, ROLE_ADMIN, ROLE_CHEF_ADMIN, ROLE_SUPERADMIN):
        cli, _, _ = app_cible(acteur, cible)
        r = cli.post('/cible/9', headers=H)
        attendu = 200 if ROLE_HIERARCHY[acteur] > ROLE_HIERARCHY[cible] else 403
        ok = r.status_code == attendu
        # Un player n'atteint jamais compte_cible_protegee : son 403 vient du
        # decorateur de permission. On ne le compte pas comme une preuve de la
        # regle de rang, mais on verifie qu'il est bien refuse.
        if acteur == ROLE_PLAYER:
            ok = r.status_code == 403
        check("  %s -> %s : %s" % (acteur, cible, attendu), ok,
              (r.status_code, (r.get_json() or {}).get('code')))


# ===========================================================================
print("  -- cas limites de la règle de rang --")
# Defaut ferme des deux cotes : un role illisible ne doit jamais ouvrir.
check("acteur au rôle inconnu -> refusé (compte comme rang le plus bas)",
      statut('rôle_corrompu', 'player') == 403)
check("cible au rôle inconnu -> refusée (compte comme rang le plus haut)",
      statut('superadmin', 'rôle_corrompu') == 403)

# Agir sur SOI reste permis : le decorateur sort avant meme de lire la base
# (fermer ses propres sessions est legitime). Ce sont les routes qui refusent
# l'auto-modification quand elle n'a pas de sens, via refuse_auto_modification.
cli, cur, _ = app_cible('admin', 'admin', acteur_id=7, cible_id=7)
r = cli.post('/cible/7', headers=H)
check("agir sur soi-même reste permis malgré le rang égal",
      r.status_code == 200, (r.status_code, r.get_json()))
check("  et la base n'est même pas lue pour cela",
      not any('SELECT role FROM comptes' in s for s, _ in cur.executed))

# Cible inexistante : c'est a la route de repondre 404, pas au decorateur --
# un 403 ici revelerait l'inexistence par un code d'erreur different.
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

# La regle est UNE comparaison de rang : plus aucun role cite en dur dans le
# corps de la decision. Sans ce controle, un futur `if role_cible == ...`
# re-introduirait un cas particulier et la lacune avec.
src_auth = io_open(os.path.join(RACINE, 'auth.py'))
_d = src_auth.find('def compte_cible_protegee')
_f = src_auth.find('\ndef ', _d + 10)
corps_cible = src_auth[_d:_f]
check("la décision repose sur ROLE_HIERARCHY, pas sur des rôles en dur",
      'ROLE_HIERARCHY' in corps_cible and 'rang_acteur <= rang_cible' in corps_cible)
check("  le cas chef_admin n'est plus un `if` particulier",
      'role_cible == ROLE_CHEF_ADMIN' not in corps_cible)


print("\n=== 4. Plafond de délégation : symétrique octroi / retrait ===")
# « Il ne peut pas donner des droits qu'il n'a pas » doit valoir AUSSI au
# retrait, sinon un acteur defait ce qu'il n'aurait pas pu faire.
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

# Les deux routes d'ecriture portent bien le decorateur de cible protegee, et
# sont hors d'atteinte d'un simple admin.
for nom in ('accorder_permission', 'retirer_permission'):
    i = src_comptes.find('def %s' % nom)
    entete = src_comptes[max(0, i - 320):i]
    check("%s : réservée au chef_admin+" % nom,
          'role_required(ROLE_CHEF_ADMIN)' in entete, entete[-160:])
    check("%s : porte compte_cible_protegee" % nom,
          '@compte_cible_protegee' in entete)

# permissions_delegables_par : le plafond lui-meme.
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
# Un 403 ferait purger la session cote frontend et ejecterait un admin qui avait
# pourtant le droit. Les trois chemins d'autorisation doivent le respecter.
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

# compte_a_permission : la verification secondaire, dans le corps des routes.
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
# Faute de frappe d'un dev : doit exploser a l'import du module, pas ouvrir la
# route en grand ni la fermer en silence.
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
# Le coeur du modele : ces pouvoirs n'existent PAS dans le systeme de
# permissions. Si l'un d'eux y entrait, un chef_admin pourrait le deleguer.
for interdit in ('jetons_bot', 'gestion_bot', 'purge_rgpd', 'changement_role',
                 'legs_superadmin', 'annulation_tournoi'):
    check("'%s' absent du catalogue (capacité de rôle)" % interdit,
          interdit not in PERMISSIONS_CATALOGUE)

# Et le pendant cote code : les routes correspondantes sont bien en role_required.
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

# role_required : un rang superieur satisfait toujours une exigence inferieure.
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

# Les libelles du panneau doivent couvrir le catalogue : une permission sans
# libelle s'afficherait sous son nom technique, ou pas du tout.
comptes_html = io_open(os.path.join(FRONT, 'templates', 'admin_comptes.html'))
i = comptes_html.find('const LIBELLES = {')
# Le bloc se ferme sur la premiere accolade en debut de ligne indentee : le
# delimiter par une fenetre de N caracteres le tronquait, et faisait passer pour
# manquantes les permissions declarees en fin de bloc.
fin_bloc = comptes_html.find('\n            };', i)
bloc = comptes_html[i:fin_bloc] if i >= 0 and fin_bloc > i else ''
sans_libelle = [p for p in PERMISSIONS_CATALOGUE if p + ':' not in bloc]
check("chaque permission du catalogue a un libellé dans le panneau",
      bool(bloc) and not sans_libelle, sans_libelle or 'bloc LIBELLES introuvable')

# Le helper peut() est expose aux templates par le context processor, sous forme
# de lambda -- pas de `def peut(`.
check("le frontend expose un helper peut() aux templates",
      'peut=lambda permission' in front or 'def peut(' in front)

# La table des rangs est dupliquee en JS : desalignee, l'interface masquerait un
# bouton legitime ou en afficherait un voue au 403.
i_rangs = comptes_html.find('const RANGS = {')
bloc_rangs = comptes_html[i_rangs:comptes_html.find('}', i_rangs)] if i_rangs >= 0 else ''
rangs_front = dict((m.group(1), int(m.group(2)))
                   for m in _re.finditer(r'(\w+):\s*(\d+)', bloc_rangs))
check("les rangs du frontend sont ceux de ROLE_HIERARCHY",
      rangs_front == dict(ROLE_HIERARCHY), (rangs_front, dict(ROLE_HIERARCHY)))

# Les quatre gestes sous compte_cible_protegee ne doivent plus s'afficher sur
# une cible protegee -- ils menaient a un 403 previsible (plan B.0).
check("le panneau applique la règle de rang (et non deux rôles en dur)",
      'estCibleProtegee' in comptes_html
      and "c.role === 'chef_admin' && !EST_SUPERADMIN" not in comptes_html)
check("les boutons d'action sont conditionnés à la cible",
      'const peutAgir' in comptes_html)
for geste in ('/sessions', '/statut', '/delier', '/sync'):
    # Chaque appel doit se trouver dans une portee gardee par peutAgir.
    i_g = comptes_html.find("'/admin/comptes/' + c.id + '" + geste)
    check("  le bouton %s est sous peutAgir" % geste,
          i_g > 0 and 'peutAgir' in comptes_html[max(0, i_g - 2500):i_g], geste)
check("le frontend connaît permissions_effectives",
      'permissions_effectives' in front or 'SOUS_PERMISSIONS' in front)


# ===========================================================================
print("\n=== 10. Toute route d'écriture admin est protégée ===")
# Le mode d'echec R-43 : une route admin qui ne porte qu'@player_required est
# une porte ouverte a tout joueur connecte, sauf si elle verifie un droit dans
# son corps.
for fichier in ('routes_admin.py', 'routes_comptes.py'):
    src = sources[fichier]
    # Decoupe naive par route, suffisante : on lit l'entete entre @route et def.
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
            # Tolere UNIQUEMENT si un droit est verifie dans le corps.
            protegee = 'compte_a_permission' in corps
            check("%s : @player_required mais vérifie un droit dans son corps"
                  % chemin, protegee, entete.strip()[:120])
        else:
            check("%s : protégée" % chemin, protegee, entete.strip()[:120])


print("\n" + "=" * 60)
print("%s/%s assertions" % (sum(1 for o in OK if o), len(OK)))
sys.exit(0 if all(OK) else 1)
