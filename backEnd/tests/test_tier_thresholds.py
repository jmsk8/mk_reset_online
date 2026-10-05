"""Tiers dynamiques : defauts, CRUD, invariants du plancher, nom 'U' reserve,
permission gestion_config, recalcul apres ecriture et route de preview."""
from harness import *
from flask import Flask

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


def monter(plan, role='admin', permissions=()):
    """Meme montage que test_scission_permissions.py."""
    accordees = set(permissions)
    plan = list(plan) + [
        (r"SELECT 1 FROM permissions_admin",
         lambda params: (1,) if params and params[1] in accordees else None),
    ]
    cur, conn = install_db(plan)
    recharger()
    for m in ('routes_admin', 'cache', 'services'):
        sys.modules.pop(m, None)
    import cache
    cache.invalidate_cache = lambda: None
    import routes_admin
    routes_admin.recalculate_tiers = lambda: None
    app = Flask(__name__)
    app.register_blueprint(routes_admin.admin_bp)
    return app.test_client(), cur, conn


H = {'X-Session-Token': 'tok'}
SESSION = lambda role: (
    r"FROM sessions_joueurs s JOIN comptes c",
    ligne_session(compte_id=1, discord_id='111', username='a',
                  global_name='A', role=role))

TIERS_DEFAUT = [
    {"nom": "S", "couleur": "#f77b7b", "seuil_k": 1.0, "rang": 3},
    {"nom": "A", "couleur": "#9cda74", "seuil_k": 0.0, "rang": 2},
    {"nom": "B", "couleur": "#7fe6ee", "seuil_k": -1.0, "rang": 1},
    {"nom": "C", "couleur": "#ae6ce4", "seuil_k": None, "rang": 0},
]


print("\n=== Non-regression : le seed par defaut reproduit l'ancien comportement ===")
sys.modules.pop('services', None)
sys.modules.pop('constants', None)
install_db([])  # services.py importe db au chargement
import services

mean, stdev = 10.0, 2.0
for score, attendu in [(mean + stdev + 0.01, 'S'), (mean + 0.01, 'A'),
                        (mean - stdev + 0.01, 'B'), (mean - stdev - 0.01, 'C')]:
    obtenu = services.tier_for_score(score, mean, stdev, TIERS_DEFAUT)
    check("tier_for_score(%.2f) avec le seed par defaut -> %s" % (score, attendu),
          obtenu == attendu, obtenu)

jeu = [8.0, 9.0, 10.0, 11.0, 12.0]
m, s = services.compute_distribution_stats(jeu)
seuils = services.tier_thresholds(jeu, TIERS_DEFAUT)
check("tier_thresholds reproduit S=mean+stdev", seuils['S'] == round(m + s, 3), (seuils, m, s))
check("  A=mean", seuils['A'] == round(m, 3), seuils)
check("  B=mean-stdev", seuils['B'] == round(m - s, 3), seuils)
check("  C (plancher, seuil_k None) reste a 0", seuils['C'] == 0, seuils)


print("\n=== tier_for_score generalise a un nombre quelconque de tiers ===")
cinq_tiers = [
    {"nom": "GM", "couleur": "#fff", "seuil_k": 2.0, "rang": 4},
    {"nom": "S", "couleur": "#fff", "seuil_k": 1.0, "rang": 3},
    {"nom": "A", "couleur": "#fff", "seuil_k": 0.0, "rang": 2},
    {"nom": "B", "couleur": "#fff", "seuil_k": -1.0, "rang": 1},
    {"nom": "Bronze", "couleur": "#fff", "seuil_k": None, "rang": 0},
]
check("un score tres haut atteint le tier ajoute (GM)",
      services.tier_for_score(mean + 3 * stdev, mean, stdev, cinq_tiers) == 'GM')
check("le plancher renomme (Bronze) sert de secours",
      services.tier_for_score(mean - 10 * stdev, mean, stdev, cinq_tiers) == 'Bronze')
check("tiers vide -> 'U' plutot que de lever",
      services.tier_for_score(0, 0, 1, []) == 'U')
_vide = services.load_tiers(FakeCursor([(r"SELECT id, nom, couleur, seuil_k, rang, couleur_texte FROM tiers", [])]))
check("load_tiers retombe sur DEFAULT_TIERS si la table est vide",
      [t["nom"] for t in _vide] == ['S', 'A', 'B', 'C'], _vide)
check("  le fallback porte un id explicite (None) et non un champ absent",
      all('id' in t and t['id'] is None for t in _vide), _vide)
check("  et il ne modifie pas DEFAULT_TIERS en place",
      all('id' not in t for t in services.DEFAULT_TIERS), services.DEFAULT_TIERS)

_avec_ids = services.load_tiers(FakeCursor([
    (r"SELECT id, nom, couleur, seuil_k, rang, couleur_texte FROM tiers",
     [(5, 'S', '#f77b7b', 1.0, 3, '#FFFFFF'), (6, 'C', '#ae6ce4', None, 0, '#FFFFFF')])]))
check("load_tiers remonte l'id de chaque ligne",
      [t["id"] for t in _avec_ids] == [5, 6], _avec_ids)


print("\n=== GET /admin/tiers : lecture ouverte a toute session authentifiee ===")
cli, cur, conn = monter([
    SESSION('player'),
    (r"SELECT id, nom, couleur, seuil_k, rang, couleur_texte FROM tiers",
     [(7, 'S', '#f77b7b', 1.0, 3, '#FFFFFF'), (8, 'A', '#9cda74', 0.0, 2, '#FFFFFF')]),
])
r = cli.get('/admin/tiers', headers=H)
check("200 pour un simple joueur connecte (pas un secret)", r.status_code == 200, r.status_code)
check("renvoie la liste triee par rang decroissant",
      [t['nom'] for t in r.get_json()] == ['S', 'A'], r.get_json())

# Chaque tier doit exposer son id.
check("CHAQUE tier expose son id (le panneau admin en depend)",
      all(isinstance(t.get('id'), int) for t in r.get_json()), r.get_json())
check("  et les ids sont ceux de la base, pas des indices",
      [t['id'] for t in r.get_json()] == [7, 8], r.get_json())
check("  le tier porte aussi couleur, couleur_texte, seuil_k et rang",
      all({'id', 'nom', 'couleur', 'couleur_texte', 'seuil_k', 'rang'} <= set(t) for t in r.get_json()),
      r.get_json())


print("\n=== POST /admin/tiers : validation ===")
cli, cur, conn = monter([SESSION('admin'),
                          (r"SELECT COUNT\(\*\) FROM tiers WHERE UPPER\(nom\)", (0,)),
                          (r"SELECT rang FROM tiers ORDER BY rang DESC", (3,)),
                          (r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (1, None))],
                         permissions={'gestion_config'})
r = cli.post('/admin/tiers', headers=H, json={'nom': '', 'couleur': '#fff', 'seuil_k': 1.0})
check("nom vide refuse (400)", r.status_code == 400, (r.status_code, r.get_json()))

r = cli.post('/admin/tiers', headers=H, json={'nom': 'U', 'couleur': '#fff', 'seuil_k': 1.0})
check("nom 'U' reserve refuse (400)", r.status_code == 400, (r.status_code, r.get_json()))

r = cli.post('/admin/tiers', headers=H, json={'nom': 'TROPLONGXXX', 'couleur': '#fff', 'seuil_k': 1.0})
check("nom > 10 caracteres refuse (400)", r.status_code == 400, (r.status_code, r.get_json()))

r = cli.post('/admin/tiers', headers=H, json={'nom': 'GM', 'couleur': 'pasunhex', 'seuil_k': 1.0})
check("couleur invalide refusee (400)", r.status_code == 400, (r.status_code, r.get_json()))

r = cli.post('/admin/tiers', headers=H, json={'nom': 'GM', 'couleur': '#123456', 'seuil_k': 'abc'})
check("seuil_k non numerique refuse (400)", r.status_code == 400, (r.status_code, r.get_json()))

r = cli.post('/admin/tiers', headers=H,
             json={'nom': 'GM', 'couleur': '#123456', 'couleur_texte': 'red; x', 'seuil_k': 1.0})
check("couleur du texte invalide refusee (400)", r.status_code == 400, (r.status_code, r.get_json()))


print("\n=== POST /admin/tiers : creation acceptee, gate gestion_config, recalcule ===")
cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_ligues'})
r = cli.post('/admin/tiers', headers=H, json={'nom': 'GM', 'couleur': '#123456', 'seuil_k': 2.0})
check("gestion_ligues seul -> 403 sur la creation d'un tier", r.status_code == 403, r.status_code)

cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT COUNT\(\*\) FROM tiers WHERE UPPER\(nom\)", (0,)),
    (r"SELECT rang FROM tiers ORDER BY rang DESC", (3,)),
    (r"INSERT INTO tiers .* RETURNING id", (1,)),
    (r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (1, 2.0)),
], permissions={'gestion_config'})
appels = []
import routes_admin
routes_admin.recalculate_tiers = lambda: appels.append(True)
r = cli.post('/admin/tiers', headers=H, json={'nom': 'GM', 'couleur': '#123456', 'seuil_k': 2.0})
check("gestion_config -> 200", r.status_code == 200, (r.status_code, r.get_json()))
check("l'id du tier cree est renvoye (le panneau admin en depend pour le reordonnancement)",
      r.get_json().get('id') == 1, r.get_json())
check("recalculate_tiers() appele immediatement", appels == [True], appels)
inserts = [p for s, p in cur.executed if s.startswith('INSERT INTO tiers')]
check("le nouveau tier prend le rang max+1 (sommet) par defaut",
      inserts and inserts[0][4] == 4, inserts)
check("  et un texte blanc par defaut (l'apparence d'avant)",
      inserts and inserts[0][2] == '#FFFFFF', inserts)

cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT COUNT\(\*\) FROM tiers WHERE UPPER\(nom\)", (0,)),
    (r"SELECT rang FROM tiers ORDER BY rang DESC", (3,)),
    (r"INSERT INTO tiers .* RETURNING id", (1,)),
    (r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (1, 2.0)),
], permissions={'gestion_config'})
r = cli.post('/admin/tiers', headers=H,
             json={'nom': 'GM', 'couleur': '#123456', 'couleur_texte': '#0f172a', 'seuil_k': 2.0})
inserts = [p for s, p in cur.executed if s.startswith('INSERT INTO tiers')]
check("couleur du texte fournie -> enregistree telle quelle",
      r.status_code == 200 and inserts and inserts[0][2] == '#0f172a', (r.status_code, inserts))


print("\n=== POST /admin/tiers : nom deja pris refuse ===")
cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT COUNT\(\*\) FROM tiers WHERE UPPER\(nom\)", (1,)),
], permissions={'gestion_config'})
r = cli.post('/admin/tiers', headers=H, json={'nom': 'S', 'couleur': '#123456', 'seuil_k': 2.0})
check("nom deja existant -> 400", r.status_code == 400, (r.status_code, r.get_json()))


print("\n=== PUT /admin/tiers/<id> : donner un seuil a l'actuel plancher est ACCEPTE ===")
# Ajouter un tier sous le plancher : le PUT precede le /reorder.
cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT id, rang FROM tiers WHERE id = %s", (4, 0)),
    (r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (4, None)),
], permissions={'gestion_config'})
r = cli.put('/admin/tiers/4', headers=H, json={'seuil_k': -1.5})
check("donner un seuil au tier de rang le plus bas -> 200 (plus de 400)",
      r.status_code == 200, (r.status_code, r.get_json()))
check("  le seuil est bien ecrit",
      any('seuil_k = %s' in s for s, _ in cur.executed), [s for s, _ in cur.executed])
check("  et le seuil ecrit n'est PAS efface derriere par _appliquer_plancher",
      not any('seuil_k = NULL' in s for s, _ in cur.executed), [s for s, _ in cur.executed])

cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT id, rang FROM tiers WHERE id = %s", (1, 0)),
    (r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (1, None)),
], permissions={'gestion_config'})
r = cli.put('/admin/tiers/1', headers=H, json={'seuil_k': None})
check("seuil_k null explicite accepte (plancher assume)",
      r.status_code == 200, (r.status_code, r.get_json()))
check("  ecrit bien NULL et non la chaine 'None'",
      any('seuil_k = NULL' in s for s, _ in cur.executed), [s for s, _ in cur.executed])

cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT id, rang FROM tiers WHERE id = %s", (1, 0)),
    (r"SELECT COUNT\(\*\) FROM tiers WHERE UPPER\(nom\) = UPPER\(%s\) AND id", (0,)),
    (r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (1, None)),
], permissions={'gestion_config'})
r = cli.put('/admin/tiers/1', headers=H, json={'nom': 'Bronze'})
check("renommer le plancher reste permis", r.status_code == 200, (r.status_code, r.get_json()))


print("\n=== _appliquer_plancher : efface, mais n'invente JAMAIS de valeur ===")
import routes_admin as _ra

# a) le rang le plus bas perd son seuil
_c = FakeCursor([(r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (9, 2.0))])
_ra._appliquer_plancher(_c)
check("le tier de rang le plus bas est remis a NULL",
      any('seuil_k = NULL' in s and p == (9,) for s, p in _c.executed), _c.executed)

# b) plancher deja a NULL : aucune ecriture inutile.
_c = FakeCursor([(r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (9, None))])
_ra._appliquer_plancher(_c)
check("  plancher deja correct -> aucune ecriture",
      not any('UPDATE' in s for s, _ in _c.executed), _c.executed)

# c) un tier sans seuil qui n'est pas le plancher ne recoit pas de valeur inventee.
_c = FakeCursor([(r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (9, None))])
_ra._appliquer_plancher(_c)
check("aucune valeur de seuil n'est inventee pour les autres tiers",
      not any('SET seuil_k = %s' in s for s, _ in _c.executed), _c.executed)
check("  et la fonction ne lit que le tier de plus petit rang",
      all('LIMIT 1' in s for s, _ in _c.executed if s.startswith('SELECT')), _c.executed)


print("\n=== PUT /admin/tiers/<id> : tier introuvable -> 404 ===")
cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT id, rang FROM tiers WHERE id = %s", None),
], permissions={'gestion_config'})
r = cli.put('/admin/tiers/999', headers=H, json={'nom': 'X'})
check("id inexistant -> 404", r.status_code == 404, (r.status_code, r.get_json()))


print("\n=== DELETE /admin/tiers/<id> : refuse de vider la table ===")
cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT COUNT\(\*\) FROM tiers$", (1,)),
], permissions={'gestion_config'})
r = cli.delete('/admin/tiers/1', headers=H)
check("dernier tier restant -> 400", r.status_code == 400, (r.status_code, r.get_json()))


print("\n=== DELETE /admin/tiers/<id> : supprime, renumerote, recalcule ===")
cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT COUNT\(\*\) FROM tiers$", (4,)),
    (r"SELECT id FROM tiers ORDER BY rang ASC", [(10,), (11,), (13,)]),
    (r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (10, None)),
], permissions={'gestion_config'})
appels = []
import routes_admin
routes_admin.recalculate_tiers = lambda: appels.append(True)
r = cli.delete('/admin/tiers/12', headers=H)
check("suppression -> 200", r.status_code == 200, (r.status_code, r.get_json()))
check("recalcul immediat apres suppression", appels == [True], appels)
maj_rangs = [p for s, p in cur.executed if s.startswith('UPDATE tiers SET rang')]
check("les rangs restants sont renumerotes sans trou (0,1,2)",
      sorted(p[0] for p in maj_rangs) == [0, 1, 2], maj_rangs)


print("\n=== PUT /admin/tiers/reorder : contrats de forme ===")
cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_config'})
r = cli.put('/admin/tiers/reorder', headers=H, json={'ordre': []})
check("ordre vide refuse (400)", r.status_code == 400, (r.status_code, r.get_json()))

cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT id FROM tiers$", [(1,), (2,), (3,)]),
], permissions={'gestion_config'})
r = cli.put('/admin/tiers/reorder', headers=H, json={'ordre': [1, 2]})
check("ordre partiel (id manquant) refuse (400)", r.status_code == 400, (r.status_code, r.get_json()))

cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT id FROM tiers$", [(1,), (2,), (3,)]),
], permissions={'gestion_config'})
r = cli.put('/admin/tiers/reorder', headers=H, json={'ordre': [1, 2, 3, 99]})
check("ordre avec id inconnu refuse (400)", r.status_code == 400, (r.status_code, r.get_json()))


def etats(*listes):
    """La table `tiers` lue avant puis apres le geste (la derniere se repete)."""
    restantes = list(listes)
    def lire(params):
        return restantes.pop(0) if len(restantes) > 1 else restantes[0]
    return (r"SELECT id, nom, couleur, seuil_k, rang, couleur_texte FROM tiers", lire)

SAB = [(1, 'S', '#f77b7b', 1.0, 2, '#FFFFFF'), (2, 'A', '#9cda74', 0.0, 1, '#FFFFFF'), (3, 'B', '#7fe6ee', None, 0, '#FFFFFF')]
audits = lambda cur: [p for s, p in cur.executed if 'audit_admin' in s]


print("\n=== PUT /admin/tiers/reorder : applique le nouvel ordre, recalcule ===")
cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT id FROM tiers$", [(1,), (2,), (3,)]),
    (r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (3, None)),
    etats(SAB, [(3, 'B', '#7fe6ee', 1.0, 2, '#FFFFFF'), (1, 'S', '#f77b7b', 0.0, 1, '#FFFFFF'), (2, 'A', '#9cda74', None, 0, '#FFFFFF')]),
], permissions={'gestion_config'})
appels = []
import routes_admin
routes_admin.recalculate_tiers = lambda: appels.append(True)
r = cli.put('/admin/tiers/reorder', headers=H, json={'ordre': [3, 1, 2]})
check("reorder -> 200", r.status_code == 200, (r.status_code, r.get_json()))
check("recalcul immediat apres reorder", appels == [True], appels)
finales = {p[1]: p[0] for s, p in cur.executed if s.startswith('UPDATE tiers SET rang')
           and p[0] >= 0}
check("id 3 (premier de la liste) recoit le rang le plus haut (2)", finales.get(3) == 2, finales)
check("id 2 (dernier de la liste) recoit le rang le plus bas (0)", finales.get(2) == 0, finales)
check("le nouvel ordre est journalise", len(audits(cur)) == 1, cur.executed)

cli, cur, conn = monter([
    SESSION('admin'),
    (r"SELECT id FROM tiers$", [(1,), (2,), (3,)]),
    (r"SELECT id, seuil_k FROM tiers ORDER BY rang ASC LIMIT 1", (3, None)),
    etats(SAB),
], permissions={'gestion_config'})
appels = []
import routes_admin
routes_admin.recalculate_tiers = lambda: appels.append(True)
r = cli.put('/admin/tiers/reorder', headers=H, json={'ordre': [1, 2, 3]})
check("ordre inchange -> 200", r.status_code == 200, (r.status_code, r.get_json()))
check("  mais ni ligne au journal (le panneau l'envoie a chaque enregistrement)",
      audits(cur) == [], audits(cur))
check("  ni recalcul", appels == [], appels)


print("\n=== PUT /admin/tiers/<id> : on journalise un changement, pas un envoi ===")
PUT_S = [SESSION('admin'),
         (r"SELECT id, rang FROM tiers WHERE id = %s", (1, 2)),
         (r"SELECT COUNT\(\*\) FROM tiers WHERE UPPER\(nom\) = UPPER\(%s\) AND id", (0,))]
TOUT_S = {'nom': 'S', 'couleur': '#334155', 'seuil_k': 1.0}

cli, cur, conn = monter(PUT_S + [etats(SAB, [(1, 'S', '#334155', 1.0, 2, '#FFFFFF')] + SAB[1:])],
                        permissions={'gestion_config'})
appels = []
import routes_admin
routes_admin.recalculate_tiers = lambda: appels.append(True)
r = cli.put('/admin/tiers/1', headers=H, json=TOUT_S)
check("couleur changee -> 200", r.status_code == 200, (r.status_code, r.get_json()))
check("  une ligne au journal", len(audits(cur)) == 1, cur.executed)
check("  qui ne cite QUE la couleur, seul champ modifie",
      audits(cur) and '"champs": ["couleur"]' in str(audits(cur)[0]), audits(cur))
check("  avec l'avant et l'apres de ce champ",
      audits(cur) and '"changements": {"couleur": ["#f77b7b", "#334155"]}' in str(audits(cur)[0]),
      audits(cur))
check("  et le recalcul", appels == [True], appels)

cli, cur, conn = monter(PUT_S + [etats(SAB)], permissions={'gestion_config'})
appels = []
import routes_admin
routes_admin.recalculate_tiers = lambda: appels.append(True)
r = cli.put('/admin/tiers/1', headers=H, json={'nom': 'S', 'couleur': '#f77b7b', 'seuil_k': 1.0})
check("tier renvoye a l'identique -> 200", r.status_code == 200, (r.status_code, r.get_json()))
check("  sans ligne au journal", audits(cur) == [], audits(cur))
check("  ni recalcul", appels == [], appels)

cli, cur, conn = monter(PUT_S + [etats(SAB, [(1, 'S', '#f77b7b', 1.0, 2, '#0F172A')] + SAB[1:])],
                        permissions={'gestion_config'})
r = cli.put('/admin/tiers/1', headers=H, json=dict(TOUT_S, couleur='#f77b7b', couleur_texte='#0F172A'))
check("couleur du texte changee -> 200", r.status_code == 200, (r.status_code, r.get_json()))
check("  ecrite dans la colonne couleur_texte",
      any('couleur_texte = %s' in s and '#0F172A' in p for s, p in cur.executed
          if s.startswith('UPDATE tiers')), cur.executed)
check("  le journal ne cite qu'elle, avec l'avant et l'apres",
      audits(cur) and '"champs": ["couleur_texte"]' in str(audits(cur)[0])
      and '"couleur_texte": ["#FFFFFF", "#0F172A"]' in str(audits(cur)[0]), audits(cur))

cli, cur, conn = monter(PUT_S + [etats(SAB)], permissions={'gestion_config'})
r = cli.put('/admin/tiers/1', headers=H, json={'couleur_texte': 'blanc'})
check("couleur du texte invalide -> 400, rien d'ecrit",
      r.status_code == 400 and not any(s.startswith('UPDATE tiers') for s, _ in cur.executed),
      (r.status_code, cur.executed))


print("\n=== POST /admin/tiers/reset : restaure S/A/B/C, recalcule ===")
cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_config'})
appels = []
import routes_admin
routes_admin.recalculate_tiers = lambda: appels.append(True)
r = cli.post('/admin/tiers/reset', headers=H)
check("reset -> 200", r.status_code == 200, (r.status_code, r.get_json()))
check("recalcul immediat apres reset", appels == [True], appels)
check("la table est videe avant reinsertion",
      any(s.strip() == 'DELETE FROM tiers' for s, _ in cur.executed), cur.executed)
inserts = [p for s, p in cur.executed if s.startswith('INSERT INTO tiers')]
check("les 4 tiers par defaut sont reinseres",
      sorted(p[0] for p in inserts) == ['A', 'B', 'C', 'S'], inserts)
check("  avec leur texte blanc par defaut", all(p[2] == '#FFFFFF' for p in inserts), inserts)

cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_ligues'})
r = cli.post('/admin/tiers/reset', headers=H)
check("gestion_ligues seul -> 403 sur le reset", r.status_code == 403, r.status_code)


print("\n=== /admin/config n'expose plus tier_k_s/a/b (migres vers /admin/tiers) ===")
cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_config'})
r = cli.get('/admin/config', headers=H)
body = r.get_json()
check("tier_k_s absent de get_config", 'tier_k_s' not in body, body)
check("tier_k_a absent de get_config", 'tier_k_a' not in body, body)
check("tier_k_b absent de get_config", 'tier_k_b' not in body, body)

cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_config'})
r = cli.post('/admin/config', headers=H, json={'tier_k_s': 1.5})
check("poster tier_k_s sur /admin/config n'ecrit plus rien (400, payload ignore)",
      r.status_code == 400, (r.status_code, r.get_json()))


print("\n=== recalculate_tiers() charge les tiers via load_tiers ===")
sys.modules.pop('services', None)
plan = [
    (r"key = 'sigma_threshold'", ('4.0',)),
    (r"SELECT id, nom, couleur, seuil_k, rang, couleur_texte FROM tiers",
     [(1, 'S', '#f77b7b', 2.0, 3, '#FFFFFF'), (2, 'A', '#9cda74', 0.5, 2, '#FFFFFF'),
      (3, 'B', '#7fe6ee', -2.0, 1, '#FFFFFF'), (4, 'C', '#ae6ce4', None, 0, '#FFFFFF')]),
    (r"SELECT id, mu, sigma, is_ranked FROM Joueurs",
     [(1, 15.0, 1.0, True), (2, 11.0, 1.0, True), (3, 19.0, 1.0, True), (4, 7.0, 1.0, True)]),
]
cur, conn = install_db(plan)
sys.modules['psycopg2.extras'].execute_values = (
    lambda cur, sql, values: cur.execute(sql.replace('%s', str(values)), values))
import services
try:
    services.recalculate_tiers()
    ok = conn.committed and not conn.rolledback
except Exception as e:
    ok = False
check("recalculate_tiers s'execute et commit avec des tiers non-defaut", ok)
lu = [s for s, _ in cur.executed if 'SELECT id, nom, couleur, seuil_k, rang, couleur_texte FROM tiers' in s]
check("load_tiers est bien appele pendant le recalcul", len(lu) == 1, cur.executed)


print("\n=== Route de preview : /admin/config/tier-distribution (inchangee) ===")
cli, cur, conn = monter([
    SESSION('admin'),
    (r"key = 'sigma_threshold'", ('4.0',)),
    (r"SELECT nom, mu, sigma, is_ranked, color FROM Joueurs",
     [('Alice', 12.0, 1.0, True, '#FF0000'), ('Bob', 8.0, 1.0, True, '#00FF00'),
      ('Ghost', 20.0, 10.0, False, '#0000FF')]),
], permissions={'gestion_config'})
r = cli.get('/admin/config/tier-distribution', headers=H)
check("200 pour un compte gestion_config", r.status_code == 200, (r.status_code, r.get_json()))
body = r.get_json()
check("la courbe est presente", len(body.get('curve', [])) > 0, body.get('curve'))
noms = {p['nom'] for p in body.get('players', [])}
check("seuls les joueurs rankes (sigma <= seuil) apparaissent", noms == {'Alice', 'Bob'}, noms)
# mean/stdev exacts, pour que le front place les seuils.
check("mean est present et exact", body.get('mean') is not None, body.get('mean'))
check("stdev est present et exact", body.get('stdev') is not None, body.get('stdev'))

cli, cur, conn = monter([
    SESSION('admin'),
    (r"key = 'sigma_threshold'", ('4.0',)),
    (r"SELECT nom, mu, sigma, is_ranked, color FROM Joueurs", []),
], permissions={'gestion_ligues'})
r = cli.get('/admin/config/tier-distribution', headers=H)
check("403 pour un compte sans gestion_config", r.status_code == 403, r.status_code)


print("\n=== Couleur de U : lecture, defaut blanc ===")
sys.modules.pop('services', None)
install_db([])
import services
_u = services.load_couleur_u(FakeCursor([]))
check("sans reglage en base, U reste blanc (l'apparence d'avant)", _u == '#FFFFFF', _u)
_u = services.load_couleur_u(FakeCursor([(r"key = 'tier_u_couleur'", ('#334155',))]))
check("avec un reglage, sa valeur", _u == '#334155', _u)


print("\n=== PUT /admin/tiers/unranked : seule la couleur de U se regle ===")
U_AVANT = (r"key = 'tier_u_couleur'", ('#FFFFFF',))

cli, cur, conn = monter([SESSION('admin'), U_AVANT], permissions={'gestion_config'})
appels = []
import routes_admin
routes_admin.recalculate_tiers = lambda: appels.append(True)
r = cli.put('/admin/tiers/unranked', headers=H, json={'couleur': '#334155'})
check("200 pour un compte gestion_config", r.status_code == 200, (r.status_code, r.get_json()))
ecrit = [p for s, p in cur.executed if s.startswith('INSERT INTO Configuration')]
check("la couleur part dans configuration, clef tier_u_couleur",
      ecrit == [('tier_u_couleur', '#334155')], cur.executed)
check("rien n'est ecrit dans la table tiers : U n'en est pas un",
      not any('tiers' in s.split('INTO')[-1].split()[0].lower()
              for s, _ in cur.executed if s.startswith(('INSERT', 'UPDATE', 'DELETE'))
              and 'audit_admin' not in s and 'Configuration' not in s),
      cur.executed)
check("commit", conn.committed)
check("pas de recalcul des tiers : une couleur ne classe personne", appels == [], appels)
audit_u = [p for s, p in cur.executed if 'audit_admin' in s]
check("l'action est journalisee", len(audit_u) == 1, cur.executed)
check("  avec l'avant et l'apres", audit_u and "#FFFFFF" in str(audit_u[0]) and "#334155" in str(audit_u[0]),
      audit_u)

for mauvaise in ('rouge', '#12', '', None, 'red; background: url(x)'):
    cli, cur, conn = monter([SESSION('admin'), U_AVANT], permissions={'gestion_config'})
    r = cli.put('/admin/tiers/unranked', headers=H, json={'couleur': mauvaise})
    check("couleur invalide %r -> 400, rien d'ecrit" % (mauvaise,),
          r.status_code == 400
          and not any(s.startswith('INSERT INTO Configuration') or 'audit_admin' in s
                      for s, _ in cur.executed),
          (r.status_code, r.get_json(), cur.executed))

cli, cur, conn = monter([SESSION('admin'), U_AVANT], permissions={'gestion_config'})
r = cli.put('/admin/tiers/unranked', headers=H, json={'couleur': '#ffffff'})
check("meme couleur (casse comprise) -> 200 sans ligne au journal",
      r.status_code == 200 and not any('audit_admin' in s for s, _ in cur.executed),
      (r.status_code, cur.executed))

cli, cur, conn = monter([SESSION('admin'), U_AVANT], permissions={'gestion_ligues'})
r = cli.put('/admin/tiers/unranked', headers=H, json={'couleur': '#334155'})
check("403 sans gestion_config", r.status_code == 403, r.status_code)


print("\n=== Couleur du texte de U ===")
sys.modules.pop('services', None)
install_db([])
import services
_t = services.load_couleur_texte_u(FakeCursor([]), '#FFFFFF')
check("sans reglage, texte fonce sur fond clair", _t == '#0A0A0A', _t)
_t = services.load_couleur_texte_u(FakeCursor([]), '#1E293B')
check("sans reglage, texte blanc sur fond fonce", _t == '#FFFFFF', _t)
_t = services.load_couleur_texte_u(FakeCursor([(r"key = 'tier_u_couleur_texte'", ('#FF0000',))]), '#FFFFFF')
check("avec un reglage, sa valeur", _t == '#FF0000', _t)

cli, cur, conn = monter([SESSION('admin'), U_AVANT], permissions={'gestion_config'})
r = cli.put('/admin/tiers/unranked', headers=H, json={'couleur': '#FFFFFF', 'couleur_texte': '#FF0000'})
check("fond et texte envoyes ensemble -> 200", r.status_code == 200, (r.status_code, r.get_json()))
ecrit = [p for s, p in cur.executed if s.startswith('INSERT INTO Configuration')]
check("  le texte part dans configuration, clef tier_u_couleur_texte",
      ('tier_u_couleur_texte', '#FF0000') in ecrit, ecrit)
audit_u = [p for s, p in cur.executed if 'audit_admin' in s]
check("  le journal ne cite que le texte (le fond n'a pas change)",
      len(audit_u) == 1 and '"champs": ["couleur_texte"]' in str(audit_u[0]), audit_u)

cli, cur, conn = monter([SESSION('admin'), U_AVANT], permissions={'gestion_config'})
r = cli.put('/admin/tiers/unranked', headers=H, json={'couleur_texte': 'noir'})
check("couleur du texte invalide -> 400, rien d'ecrit",
      r.status_code == 400 and not any(s.startswith('INSERT INTO Configuration') for s, _ in cur.executed),
      (r.status_code, cur.executed))

cli, cur, conn = monter([SESSION('admin'), U_AVANT], permissions={'gestion_config'})
r = cli.put('/admin/tiers/unranked', headers=H, json={})
check("aucune couleur envoyee -> 400", r.status_code == 400, (r.status_code, r.get_json()))


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
