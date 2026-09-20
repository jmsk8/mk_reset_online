"""Reset global du sigma : le plafond borne l'ajout, joueur par joueur.

Avant, le reset faisait « UPDATE Joueurs SET sigma = sigma + val » sans WHERE :
tout le monde prenait la meme valeur, sans limite haute. L'admin fournit
desormais un plafond, et deux regles en decoulent :

  - un joueur SOUS le plafond y est amene sans le depasser
    (1.8 + 0.3 plafonne a 2 -> 2.0, pas 2.1) ;
  - un joueur DEJA au plafond ou au-dessus n'est pas touche, et ne laisse
    aucune trace.

Consequence sur l'annulation : les joueurs ecretes n'ont pas recu `val`, donc un
revert uniforme « sigma - val » les ferait descendre SOUS leur point de depart.
Le detail par joueur (global_reset_details) existe pour cela, et ce fichier
verifie que le revert restaure bien old_sigma -- tout en gardant l'ancien
comportement pour les resets anterieurs a la migration, qui n'ont pas de detail.

Limite du banc d'essai : le curseur est scripte, le SQL n'est pas valide contre
Postgres. Ce qui est verifie ici, c'est QUI est touche et avec quelles valeurs.
"""
from harness import *
from datetime import date
from flask import Flask

H = {'X-Session-Token': 'tok'}
SESSION = lambda role: (
    r"FROM sessions_joueurs s JOIN comptes c",
    ligne_session(compte_id=1, discord_id='111', username='a',
                  global_name='A', role=role))

PAS_DE_TOURNOI_APRES = (r"SELECT COUNT\(\*\) FROM Tournois WHERE date >= ", (0,))
RESET_CREE = (r"INSERT INTO global_resets", (42,))


def monter(plan, role='chef_admin'):
    """Monte routes_admin sur un curseur scripte, avec execute_values capture.

    Le harness neutralise psycopg2 : execute_values n'existe pas. On l'installe
    ici pour enregistrer les lots ecrits -- c'est exactement la donnee que ces
    tests inspectent (quel joueur recoit quel sigma).
    """
    cur, conn = install_db(list(plan) + [SESSION(role)])
    recharger()
    for m in ('routes_admin', 'cache', 'services'):
        sys.modules.pop(m, None)

    lots = []

    def execute_values(c, sql, argslist, *a, **kw):
        norm = ' '.join(sql.split())
        lots.append((norm, list(argslist)))
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
    return app.test_client(), cur, conn, lots


def lot(lots, fragment):
    """Le premier lot dont le SQL contient ce fragment."""
    for sql, args in lots:
        if fragment in sql:
            return args
    return None


def sql_execute(cur):
    return [s for s, _ in cur.executed]


print("\n=== apply : le plafond ecrete, et exclut ceux qui sont deja au-dessus ===")

# 10 est loin du plafond -> prend la valeur pleine (1.0 + 0.3 = 1.3)
# 20 est juste sous le plafond -> ecrete (1.8 + 0.3 -> 2.0, pas 2.1)
# Les joueurs a 2.0 ou plus ne sont pas dans cette liste : le SELECT les exclut.
cli, cur, conn, lots = monter([
    PAS_DE_TOURNOI_APRES,
    (r"SELECT id, sigma FROM Joueurs WHERE sigma <", [(10, 1.0), (20, 1.8)]),
    RESET_CREE,
])
r = cli.post('/api/admin/global-reset', headers=H,
             json={'value': 0.3, 'max_sigma': 2, 'date': '2026-09-20'})
check("apply repond 200", r.status_code == 200, r.get_data(as_text=True))

globaux = [s for s in sql_execute(cur)
           if 'UPDATE Joueurs SET sigma = sigma +' in s]
check("plus aucun UPDATE global sans WHERE", not globaux, globaux)

selects = [s for s in sql_execute(cur) if 'SELECT id, sigma FROM Joueurs' in s]
check("les joueurs au-dessus du plafond sont exclus par le WHERE",
      bool(selects) and 'WHERE sigma <' in selects[0], selects)

maj = lot(lots, 'SET sigma = data.new_sigma')
check("un lot de mise a jour est ecrit", maj is not None, lots)
sigmas = dict(maj or [])
check("le joueur loin du plafond prend la valeur pleine (1.0 -> 1.3)",
      abs(sigmas.get(10, 0) - 1.3) < 1e-9, sigmas)
check("le joueur proche du plafond est ecrete a 2.0, pas 2.1",
      abs(sigmas.get(20, 0) - 2.0) < 1e-9, sigmas)

detail = lot(lots, 'INSERT INTO global_reset_details')
check("le detail est trace pour chaque joueur touche",
      detail is not None and len(detail) == 2, detail)
deltas = {d[1]: d[4] for d in (detail or [])}
check("le delta trace du joueur ecrete vaut 0.2, pas 0.3",
      abs(deltas.get(20, 0) - 0.2) < 1e-9, deltas)
check("le delta trace du joueur non ecrete vaut 0.3",
      abs(deltas.get(10, 0) - 0.3) < 1e-9, deltas)


print("\n=== apply : refus quand le plafond ne laisse personne ===")

cli, cur, conn, lots = monter([
    PAS_DE_TOURNOI_APRES,
    (r"SELECT id, sigma FROM Joueurs WHERE sigma <", []),
])
r = cli.post('/api/admin/global-reset', headers=H,
             json={'value': 0.3, 'max_sigma': 1, 'date': '2026-09-20'})
check("apply refuse en 409 si aucun joueur sous le plafond",
      r.status_code == 409, r.status_code)
ecritures = [s for s in sql_execute(cur) if 'INSERT INTO global_resets' in s]
check("aucun reset fantome n'est enregistre", not ecritures, ecritures)


print("\n=== apply : le plafond est obligatoire ===")

cli, cur, conn, lots = monter([PAS_DE_TOURNOI_APRES])
r = cli.post('/api/admin/global-reset', headers=H,
             json={'value': 0.3, 'date': '2026-09-20'})
check("apply refuse en 400 sans plafond", r.status_code == 400, r.status_code)

cli, cur, conn, lots = monter([PAS_DE_TOURNOI_APRES])
r = cli.post('/api/admin/global-reset', headers=H,
             json={'value': 0.3, 'max_sigma': 0, 'date': '2026-09-20'})
check("apply refuse en 400 si le plafond est nul", r.status_code == 400, r.status_code)


print("\n=== apply : le garde-fou tournoi passe avant tout ===")

cli, cur, conn, lots = monter([
    (r"SELECT COUNT\(\*\) FROM Tournois WHERE date >= ", (3,)),
])
r = cli.post('/api/admin/global-reset', headers=H,
             json={'value': 0.3, 'max_sigma': 2, 'date': '2026-09-20'})
check("apply refuse en 409 si un tournoi existe depuis", r.status_code == 409, r.status_code)
check("aucun joueur n'est meme selectionne",
      not [s for s in sql_execute(cur) if 'SELECT id, sigma FROM Joueurs' in s],
      sql_execute(cur))


print("\n=== revert : restaure old_sigma, y compris pour les joueurs ecretes ===")

# Le joueur 20 avait ete ecrete (1.8 -> 2.0, soit +0.2). Un revert uniforme de
# value_applied (0.3) le mettrait a 1.7 : c'est precisement ce qu'on evite.
cli, cur, conn, lots = monter([
    (r"SELECT id, value_applied, date FROM global_resets", (42, 0.3, '2026-09-20')),
    (r"SELECT COUNT\(\*\) FROM Tournois WHERE date >= ", (0,)),
    (r"SELECT joueur_id, old_sigma FROM global_reset_details", [(10, 1.0), (20, 1.8)]),
])
r = cli.post('/api/admin/revert-global-reset', headers=H)
check("revert repond 200", r.status_code == 200, r.get_data(as_text=True))

soustractions = [s for s in sql_execute(cur) if 'sigma = sigma -' in s]
check("aucune soustraction uniforme quand le detail existe",
      not soustractions, soustractions)

restauration = lot(lots, 'SET sigma = data.old_sigma')
check("un lot de restauration est ecrit", restauration is not None, lots)
restaure = dict(restauration or [])
check("le joueur ecrete revient a 1.8, pas a 1.7",
      abs(restaure.get(20, 0) - 1.8) < 1e-9, restaure)
check("le joueur non ecrete revient a 1.0",
      abs(restaure.get(10, 0) - 1.0) < 1e-9, restaure)


print("\n=== revert : un reset anterieur a la migration reste annulable ===")

# Pas de detail en base : reset applique avant le plafond, donc uniforme.
cli, cur, conn, lots = monter([
    (r"SELECT id, value_applied, date FROM global_resets", (7, 0.3, '2026-08-01')),
    (r"SELECT COUNT\(\*\) FROM Tournois WHERE date >= ", (0,)),
    (r"SELECT joueur_id, old_sigma FROM global_reset_details", []),
])
r = cli.post('/api/admin/revert-global-reset', headers=H)
check("revert repond 200 sur un reset legacy", r.status_code == 200,
      r.get_data(as_text=True))
check("il retombe sur la soustraction uniforme",
      any('sigma = sigma -' in s for s in sql_execute(cur)), sql_execute(cur))


print("\n=== revert : le garde-fou tournoi vaut aussi pour l'annulation ===")

cli, cur, conn, lots = monter([
    (r"SELECT id, value_applied, date FROM global_resets", (42, 0.3, '2026-09-20')),
    (r"SELECT COUNT\(\*\) FROM Tournois WHERE date >= ", (2,)),
])
r = cli.post('/api/admin/revert-global-reset', headers=H)
check("revert refuse en 409 si un tournoi a eu lieu depuis",
      r.status_code == 409, r.status_code)
check("aucune restauration n'est tentee",
      lot(lots, 'SET sigma = data.old_sigma') is None, lots)

print("\n=== Le reset s'annonce : il bouge le classement sans tournoi joue ===")

def notif(cur):
    """(type, titre, corps, lien) de la notification diffusee, ou None."""
    for sql, params in cur.executed:
        if 'INSERT INTO notifications' in sql and params:
            return params[-4:]
    return None

cli, cur, conn, lots = monter([
    PAS_DE_TOURNOI_APRES,
    (r"SELECT id, sigma FROM Joueurs WHERE sigma <", [(1, 1.8), (2, 1.0)]),
    RESET_CREE,
])
r = cli.post('/api/admin/global-reset',
             json={'value': 0.3, 'max_sigma': 2.0, 'date': '2026-09-20'}, headers=H)
check("le reset repond 200", r.status_code == 200, r.get_data(as_text=True))
n = notif(cur)
check("une notification est diffusee", n is not None, [s for s, _ in cur.executed][-3:])
check("type = reset_global", n and n[0] == 'reset_global', n)
check("elle mene au classement", n and n[3] == '/classement', n and n[3])
check("elle dit combien de joueurs sont touches", n and '2 joueur' in (n[2] or ''), n and n[2])
check("diffusee a tous, sauf les suspendus",
      any("INSERT INTO notifications" in s and "statut <> 'suspended'" in s
          for s, _ in cur.executed),
      [s for s, _ in cur.executed if 'notifications' in s])

# Aucun joueur concerne : le reset est refuse, donc rien ne doit partir --
# annoncer un reset qui n'a pas eu lieu serait pire que se taire.
cli, cur, conn, lots = monter([
    PAS_DE_TOURNOI_APRES,
    (r"SELECT id, sigma FROM Joueurs WHERE sigma <", []),
])
r = cli.post('/api/admin/global-reset',
             json={'value': 0.3, 'max_sigma': 2.0, 'date': '2026-09-20'}, headers=H)
check("reset sans effet -> 409", r.status_code == 409, r.status_code)
check("et aucune notification", notif(cur) is None, notif(cur))


print("\n=== L'annulation s'annonce aussi : l'annonce du reset est deja partie ===")

cli, cur, conn, lots = monter([
    (r"SELECT id, value_applied, date FROM global_resets", (42, 0.3, date(2026, 9, 20))),
    (r"SELECT COUNT\(\*\) FROM Tournois WHERE date >= ", (0,)),
    (r"SELECT joueur_id, old_sigma FROM global_reset_details", [(1, 1.8)]),
])
r = cli.post('/api/admin/revert-global-reset', headers=H)
check("l'annulation repond 200", r.status_code == 200, r.get_data(as_text=True))
n = notif(cur)
check("type = reset_global_annule", n and n[0] == 'reset_global_annule', n)
check("elle mene au classement", n and n[3] == '/classement', n and n[3])
check("elle date le reset annule", n and '20/09/2026' in (n[2] or ''), n and n[2])

# Un reset anterieur au plafond peut rendre sa date en chaine : la
# notification ne doit pas faire echouer l'annulation pour autant.
cli, cur, conn, lots = monter([
    (r"SELECT id, value_applied, date FROM global_resets", (7, 0.3, '2026-08-01')),
    (r"SELECT COUNT\(\*\) FROM Tournois WHERE date >= ", (0,)),
    (r"SELECT joueur_id, old_sigma FROM global_reset_details", []),
])
r = cli.post('/api/admin/revert-global-reset', headers=H)
check("date en chaine : l'annulation passe quand meme", r.status_code == 200,
      r.get_data(as_text=True))
check("et la notification part", notif(cur) is not None, notif(cur))

# Refus : rien ne doit partir non plus.
cli, cur, conn, lots = monter([
    (r"SELECT id, value_applied, date FROM global_resets", (42, 0.3, date(2026, 9, 20))),
    (r"SELECT COUNT\(\*\) FROM Tournois WHERE date >= ", (2,)),
])
cli.post('/api/admin/revert-global-reset', headers=H)
check("annulation refusee -> aucune notification", notif(cur) is None, notif(cur))


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
