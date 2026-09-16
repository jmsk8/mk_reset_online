"""Fiche joueur : un droit par geste, verifie EN EXECUTANT les routes.

test_sous_permissions.py couvre la structure (catalogue, table, libelles) par
lecture du source. Ici on appelle vraiment PUT/POST/DELETE avec un compte dont
on choisit les permissions, et on regarde le code HTTP et le SQL produit.

Ce que ces tests protegent en particulier, parce que ce sont les endroits ou une
regression serait silencieuse :

  - un champ NON MODIFIE n'exige aucun droit. Le formulaire renvoie la fiche
    entiere ; exiger le droit sur ce qui n'a pas bouge interdirait a un admin
    « couleur » d'enregistrer quoi que ce soit.
  - mu/sigma se comparent a 1e-9 pres. Le front affiche 3 decimales la ou
    TrueSkill en produit plus : une egalite stricte lirait 8.333 comme un
    changement et refuserait un admin qui n'a touche a rien.
  - la creation est la 2e porte vers mu/sigma. Sans verification la-bas, le
    droit sur l'edition se contourne en supprimant puis recreant la fiche.
"""
from harness import *
from flask import Flask

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

# Etat de la fiche 7 en base, avant toute modification. Le sigma porte
# volontairement plus de 3 decimales : c'est le cas normal d'un score calcule
# par TrueSkill, et celui que l'arrondi du frontend met en danger.
NOM, MU, SIGMA, IS_RANKED, COLOR = 'Alice', 50.0, 8.333333333, True, '#FF0000'
FICHE = (NOM, MU, SIGMA, IS_RANKED, COLOR)

LIRE_FICHE = (r"SELECT nom, mu, sigma, is_ranked, color FROM Joueurs", FICHE)
NOM_LIBRE = (r"SELECT id FROM Joueurs WHERE nom", None)


def monter(accordees, role='admin', fiche=FICHE):
    """Monte routes_admin avec un compte portant exactement `accordees`."""
    plan = [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=1, discord_id='111', username='a',
                       global_name='A', role=role)),
        (r"SELECT 1 FROM permissions_admin",
         lambda params: (1,) if params and params[1] in accordees else None),
        (r"SELECT nom, mu, sigma, is_ranked, color FROM Joueurs", fiche),
        NOM_LIBRE,
    ]
    cur, conn = install_db(plan)
    recharger()
    for m in ('routes_admin', 'cache', 'services'):
        sys.modules.pop(m, None)
    import cache
    cache.invalidate_cache = lambda: None
    import services
    services.recalculate_tiers = lambda: None
    import routes_admin
    routes_admin.recalculate_tiers = lambda: None
    app = Flask(__name__)
    app.register_blueprint(routes_admin.admin_bp)
    return app.test_client(), cur, conn


H = {'X-Session-Token': 'tok'}
SOCLE = {'gestion_joueurs'}

# Le payload que le frontend envoie quand il a TOUS les droits : la fiche
# entiere, mu/sigma arrondis a 3 decimales comme les affiche la modale.
def payload(**ecrase):
    p = {'nom': NOM, 'mu': round(MU, 3), 'sigma': round(SIGMA, 3),
         'is_ranked': IS_RANKED, 'color': COLOR}
    p.update(ecrase)
    return p


def maj(cur):
    """Le premier UPDATE Joueurs execute, (sql, params), ou None."""
    for sql, params in cur.executed:
        if sql.startswith('UPDATE Joueurs SET'):
            return sql, params
    return None


print("\n=== Le socle seul ouvre la route, mais n'ecrit aucun champ ===")

cli, cur, conn = monter(SOCLE)
r = cli.put('/admin/joueurs/7', json=payload(), headers=H)
check("renvoyer la fiche inchangee est accepte", r.status_code == 200,
      (r.status_code, r.get_json()))
check("  et le sigma a 3 decimales ne compte PAS comme un changement",
      r.status_code == 200,
      "8.333 vs 8.333333333 : c'est l'arrondi du front, pas une saisie")

cli, cur, conn = monter(SOCLE)
r = cli.put('/admin/joueurs/7', json={'nom': NOM}, headers=H)
check("un payload partiel inchange passe aussi", r.status_code == 200)

cli, cur, conn = monter(SOCLE)
r = cli.put('/admin/joueurs/7', json={}, headers=H)
check("un payload vide ne touche a rien", r.status_code == 200)

cli, cur, conn = monter(set())
r = cli.put('/admin/joueurs/7', json=payload(), headers=H)
check("sans meme le socle -> 403 sur la route entiere", r.status_code == 403)


print("\n=== Chaque champ exige SON droit, et lui seul ===")

CAS = [
    ('nom', {'nom': 'Bob'}, 'joueurs_nom'),
    ('color', {'color': '#00FF00'}, 'joueurs_couleur'),
    ('mu', {'mu': 99.0}, 'edition_mu_sigma'),
    ('sigma', {'sigma': 2.0}, 'edition_mu_sigma'),
    ('is_ranked', {'is_ranked': False}, 'joueurs_statut'),
]

for champ, modif, droit in CAS:
    cli, cur, conn = monter(SOCLE)
    r = cli.put('/admin/joueurs/7', json=payload(**modif), headers=H)
    corps = r.get_json() or {}
    check("modifier %s sans %s -> 403" % (champ, droit),
          r.status_code == 403, (r.status_code, corps))
    check("  le refus nomme le champ et la permission",
          corps.get('champ') == champ and corps.get('permission') == droit,
          corps)
    # `conn.committed` ne prouve rien ici : la couche d'authentification commit
    # son propre `last_seen_at` avant meme d'entrer dans la route. Seule
    # l'absence d'UPDATE Joueurs dit que la fiche n'a pas bouge.
    check("  et aucun UPDATE Joueurs n'est emis", maj(cur) is None,
          maj(cur))

    cli, cur, conn = monter(SOCLE | {droit})
    r = cli.put('/admin/joueurs/7', json=payload(**modif), headers=H)
    check("  avec %s -> 200" % droit, r.status_code == 200,
          (r.status_code, r.get_json()))
    check("  et l'UPDATE part", maj(cur) is not None)

# Un droit ne doit pas en ouvrir un autre : c'est tout l'objet du decoupage.
cli, cur, conn = monter(SOCLE | {'joueurs_couleur'})
r = cli.put('/admin/joueurs/7', json=payload(color='#00FF00', mu=99.0), headers=H)
check("« couleur » n'ouvre pas mu/sigma", r.status_code == 403,
      (r.status_code, r.get_json()))

cli, cur, conn = monter(SOCLE | {'edition_mu_sigma'})
r = cli.put('/admin/joueurs/7', json=payload(mu=99.0), headers=H)
check("mu et sigma partagent le meme droit (mu passe)", r.status_code == 200)
cli, cur, conn = monter(SOCLE | {'edition_mu_sigma'})
r = cli.put('/admin/joueurs/7', json=payload(sigma=2.0), headers=H)
check("  et sigma aussi", r.status_code == 200)


print("\n=== La valeur ecrite est bien celle demandee ===")

cli, cur, conn = monter(SOCLE | {'joueurs_nom'})
r = cli.put('/admin/joueurs/7', json=payload(nom='Bob'), headers=H)
_, params = maj(cur)
check("le nouveau nom est ecrit", params[0] == 'Bob', params)
# Le payload porte sigma=8.333 (l'arrondi affiche) alors que la base tient
# 8.333333333. Un champ juge inchange doit repartir de la BASE : sinon editer un
# nom tronquerait le score du joueur au passage, silencieusement, a chaque
# ouverture de la modale.
check("  le sigma garde sa precision d'origine, pas l'arrondi du front",
      params[2] == SIGMA, (params[2], 'attendu', SIGMA))
check("  et les autres champs sont intacts",
      params[1] == MU and params[4] == COLOR, params)

# Le meme joueur edite deux fois de suite ne doit pas deriver : c'est ce que
# produirait une troncature repetee.
cli, cur, conn = monter(SOCLE | {'joueurs_nom'},
                        fiche=('Bob', MU, SIGMA, IS_RANKED, COLOR))
r = cli.put('/admin/joueurs/7', json=payload(nom='Carol'), headers=H)
_, params = maj(cur)
check("  une 2e edition ne le tronque pas davantage", params[2] == SIGMA, params)

# En revanche, une VRAIE saisie de mu/sigma doit bien s'ecrire telle quelle.
cli, cur, conn = monter(SOCLE | {'edition_mu_sigma'})
r = cli.put('/admin/joueurs/7', json=payload(sigma=2.5), headers=H)
_, params = maj(cur)
check("une saisie explicite de sigma s'ecrit bien", params[2] == 2.5, params)

# Le champ absent du payload doit repartir de la BASE, pas d'un defaut : sinon
# un payload partiel ecraserait silencieusement ce qu'il ne mentionne pas.
cli, cur, conn = monter(SOCLE | {'joueurs_nom'})
r = cli.put('/admin/joueurs/7', json={'nom': 'Bob'}, headers=H)
_, params = maj(cur)
check("un champ absent du payload est repris de la base",
      params[1] == MU and params[2] == SIGMA and params[3] == IS_RANKED
      and params[4] == COLOR, params)

# is_ranked=False est le piege classique du `or` : une valeur fausse mais
# legitime ne doit pas etre remplacee par le defaut.
cli, cur, conn = monter(SOCLE | {'joueurs_statut'},
                        fiche=(NOM, MU, SIGMA, False, COLOR))
r = cli.put('/admin/joueurs/7', json=payload(is_ranked=True), headers=H)
check("passer de non-classe a classe est bien vu comme un changement",
      r.status_code == 200 and maj(cur) is not None)


print("\n=== Fiche introuvable : 404, jamais un 403 trompeur ===")

cli, cur, conn = monter(SOCLE, fiche=None)
r = cli.put('/admin/joueurs/999', json=payload(nom='Bob'), headers=H)
check("un id inconnu renvoie 404", r.status_code == 404, r.get_json())
check("  et n'ecrit rien", maj(cur) is None)


print("\n=== Creation : la 2e porte vers mu/sigma ===")

cli, cur, conn = monter(SOCLE)
r = cli.post('/admin/joueurs', json={'nom': 'Neo'}, headers=H)
check("sans joueurs_creation -> 403", r.status_code == 403, r.get_json())

cli, cur, conn = monter(SOCLE | {'joueurs_creation'})
r = cli.post('/admin/joueurs', json={'nom': 'Neo'}, headers=H)
check("avec joueurs_creation, au score par defaut -> 201",
      r.status_code == 201, (r.status_code, r.get_json()))

cli, cur, conn = monter(SOCLE | {'joueurs_creation'})
r = cli.post('/admin/joueurs', json={'nom': 'Neo', 'mu': 99.0}, headers=H)
corps = r.get_json() or {}
check("fixer un mu de depart sans edition_mu_sigma -> 403",
      r.status_code == 403, (r.status_code, corps))
check("  le refus nomme edition_mu_sigma",
      corps.get('permission') == 'edition_mu_sigma', corps)

cli, cur, conn = monter(SOCLE | {'joueurs_creation'})
r = cli.post('/admin/joueurs', json={'nom': 'Neo', 'sigma': 1.0}, headers=H)
check("  idem pour sigma", r.status_code == 403)

cli, cur, conn = monter(SOCLE | {'joueurs_creation', 'edition_mu_sigma'})
r = cli.post('/admin/joueurs', json={'nom': 'Neo', 'mu': 99.0}, headers=H)
check("  avec les deux droits -> 201", r.status_code == 201, r.get_json())

# Renvoyer EXACTEMENT les defauts n'est pas un contournement : c'est ce que fait
# le formulaire, dont les champs sont pre-remplis a 50 / 8.333.
from constants import DEFAULT_MU, DEFAULT_SIGMA
cli, cur, conn = monter(SOCLE | {'joueurs_creation'})
r = cli.post('/admin/joueurs',
             json={'nom': 'Neo', 'mu': DEFAULT_MU, 'sigma': DEFAULT_SIGMA}, headers=H)
check("renvoyer les valeurs par defaut ne demande aucun droit",
      r.status_code == 201, (r.status_code, r.get_json()))

cli, cur, conn = monter(SOCLE | {'joueurs_creation'})
r = cli.post('/admin/joueurs', json={'nom': 'Neo', 'color': '#123456'}, headers=H)
check("choisir une couleur a la creation exige joueurs_couleur",
      r.status_code == 403, r.get_json())

cli, cur, conn = monter(SOCLE | {'joueurs_creation', 'joueurs_couleur'})
r = cli.post('/admin/joueurs', json={'nom': 'Neo', 'color': '#123456'}, headers=H)
check("  avec le droit -> 201", r.status_code == 201)


print("\n=== Suppression et anonymisation sous un seul droit ===")

for chemin, methode in (('/admin/joueurs/7', 'delete'),
                        ('/admin/joueurs/7/anonymiser', 'post')):
    cli, cur, conn = monter(SOCLE)
    r = getattr(cli, methode)(chemin, headers=H)
    check("%s sans joueurs_irreversible -> 403" % chemin, r.status_code == 403)

    cli, cur, conn = monter(SOCLE | {'joueurs_irreversible'})
    r = getattr(cli, methode)(chemin, headers=H)
    check("  avec le droit, la route s'execute (plus de 403)",
          r.status_code != 403, (r.status_code, r.get_json()))


print("\n=== Le parent est exige en plus de l'enfant, partout ===")
# Une sous-permission orpheline (accordee sans son parent) ne vaut RIEN. Sans
# cette regle, retirer `gestion_joueurs` laisserait les six gestes actifs.
from constants import SOUS_PERMISSIONS

for enfant in SOUS_PERMISSIONS:
    cli, cur, conn = monter({enfant})          # l'enfant SANS le parent
    r = cli.put('/admin/joueurs/7', json=payload(nom='Bob'), headers=H)
    check("%s sans gestion_joueurs -> 403" % enfant, r.status_code == 403)


print("\n=== chef_admin et superadmin : le socle EST le catalogue ===")

for role in ('chef_admin', 'superadmin'):
    cli, cur, conn = monter(set(), role=role)   # AUCUNE ligne en base
    r = cli.put('/admin/joueurs/7',
                json=payload(nom='Bob', mu=99.0, color='#00FF00',
                             is_ranked=False), headers=H)
    check("%s modifie tout sans ligne de permission" % role,
          r.status_code == 200, (r.status_code, r.get_json()))

    cli, cur, conn = monter(set(), role=role)
    r = cli.post('/admin/joueurs', json={'nom': 'Neo', 'mu': 99.0}, headers=H)
    check("  et cree avec un score libre", r.status_code == 201)

# Un player n'entre pas, quoi que contienne permissions_admin.
cli, cur, conn = monter({'gestion_joueurs', 'joueurs_nom'}, role='player')
r = cli.put('/admin/joueurs/7', json=payload(nom='Bob'), headers=H)
check("un player reste dehors malgre des lignes en base", r.status_code == 403)


print("\n=== consecutive_missed reste une capacite de role ===")
# Decision du 15/09 : ce compteur declenche la penalite de sigma, il n'est
# modifiable que par le superadmin et n'est PAS une permission delegable.
cli, cur, conn = monter(SOCLE | set(SOUS_PERMISSIONS))
r = cli.put('/admin/joueurs/7',
            json=payload(consecutive_missed=3), headers=H)
sql, _ = maj(cur) or ('', None)
check("un admin, meme avec les six droits, ne l'ecrit pas",
      'consecutive_missed' not in sql, sql)

cli, cur, conn = monter(set(), role='superadmin')
r = cli.put('/admin/joueurs/7', json=payload(consecutive_missed=3), headers=H)
sql, _ = maj(cur) or ('', None)
check("  le superadmin, si", 'consecutive_missed' in sql, sql)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
