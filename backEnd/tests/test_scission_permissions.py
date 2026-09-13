"""Scission des permissions du 2026-09-13 (contexte 8.5, revu avec l'utilisateur).

Trois separations, chacune avec un moyen de contournement a fermer :

  1. gestion_joueurs (fiches) / gestion_tournois (enregistrer un tournoi)
     -> contournable en tapant un nom inconnu, qui creait une fiche a la volee ;
  2. gestion_config « Reglage TS » / gestion_ligues (mode ligue)
     -> la page Ligues repostait TOUTE la config, donc reecrivait les reglages
        TrueSkill a chaque geste ;
  3. le reset global devient delegable via gestion_config (inverse R-51).

Ces tests verifient QUI passe et CE QUI est ecrit. L'unicite des contraintes SQL
n'est pas simulee par FakeCursor, comme partout dans ce banc d'essai.
"""
from harness import *
from flask import Flask

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FRONT = os.path.join(RACINE, '..', 'frontEnd')


def io_open(chemin):
    with open(chemin, encoding='utf-8') as f:
        return f.read()


def monter(plan, role='admin', permissions=()):
    """Monte routes_admin avec une session au role voulu.

    `permissions` : celles que porte l'acteur. _a_permission interroge
    permissions_admin avec la permission en 2e parametre -- d'ou une entree de
    plan CALLABLE, qui repond selon ce parametre et pas seulement selon le SQL.
    """
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


print("\n=== Le catalogue porte les deux nouvelles entrées ===")
from constants import PERMISSIONS_CATALOGUE
check("gestion_tournois est au catalogue", 'gestion_tournois' in PERMISSIONS_CATALOGUE)
check("gestion_joueurs y reste", 'gestion_joueurs' in PERMISSIONS_CATALOGUE)
check("gestion_joueurs et gestion_tournois sont bien distinctes",
      {'gestion_joueurs', 'gestion_tournois'} <= set(PERMISSIONS_CATALOGUE),
      sorted(PERMISSIONS_CATALOGUE))

# Le frontend duplique le catalogue : les deux listes doivent rester alignées,
# sinon un menu affiche une permission que le backend refuse (ou l'inverse).
front = io_open(os.path.join(FRONT, 'frontend.py'))
check("le catalogue frontend porte gestion_tournois",
      "'gestion_tournois'" in front)


print("\n=== Réglage TS ≠ Ligues : les clés de ligue exigent gestion_ligues ===")
# Un admin « Réglage TS » seul ne doit pas pouvoir activer le mode ligue --
# désactiver détruit l'affectation de TOUS les joueurs.
cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_config'})
r = cli.post('/admin/config', headers=H, json={'league_mode_enabled': 'false'})
check("gestion_config seul -> 403 sur league_mode_enabled", r.status_code == 403,
      (r.status_code, r.get_json()))
check("  et le refus est explicite, pas un silence",
      (r.get_json() or {}).get('code') == 'permission_manquante', r.get_json())
check("  aucun UPDATE des ligues n'est parti",
      not any('ligue_id = NULL' in s for s, _ in cur.executed),
      [s for s, _ in cur.executed])

cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_config'})
r = cli.post('/admin/config', headers=H, json={'inter_league_moves': 3})
check("gestion_config seul -> 403 sur inter_league_moves", r.status_code == 403,
      r.status_code)

cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_ligues'})
r = cli.post('/admin/config', headers=H, json={'league_mode_enabled': 'true'})
check("gestion_ligues -> accepté", r.status_code == 200, (r.status_code, r.get_json()))

# La séparation vaut dans les DEUX sens : la route ne porte plus de décorateur
# de permission (il aurait refusé « Ligues » avant le corps), chaque domaine
# garde donc la sienne.
cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_ligues'})
r = cli.post('/admin/config', headers=H, json={'tau': 0.5})
check("gestion_ligues seul -> 403 sur les réglages TrueSkill",
      r.status_code == 403, (r.status_code, r.get_json()))
check("  aucun réglage n'est écrit",
      not any('INSERT INTO Configuration' in s for s, _ in cur.executed))

cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_config'})
r = cli.post('/admin/config', headers=H, json={'tau': 0.5})
check("gestion_config -> accepté sur les réglages TrueSkill",
      r.status_code == 200, (r.status_code, r.get_json()))

# Un compte sans aucune des deux ne doit rien obtenir.
cli, cur, conn = monter([SESSION('admin')], permissions={'gestion_saisons'})
r = cli.post('/admin/config', headers=H, json={'tau': 0.5})
check("une permission étrangère -> 403", r.status_code == 403, r.status_code)

# Un chef_admin porte le catalogue entier par construction.
cli, cur, conn = monter([SESSION('chef_admin')])
r = cli.post('/admin/config', headers=H, json={'league_mode_enabled': 'true'})
check("chef_admin -> accepté (socle = catalogue)", r.status_code == 200, r.status_code)


print("\n=== Un payload partiel n'écrase plus les réglages absents ===")
# Le défaut d'origine : les 8 clés TrueSkill étaient écrites à CHAQUE appel,
# avec leurs valeurs par défaut si absentes. La page Ligues, qui repostait la
# config entière, réinitialisait donc tau et consorts.
cli, cur, conn = monter([SESSION('chef_admin')])
cli.post('/admin/config', headers=H, json={'league_mode_enabled': 'true'})
ecrits = [p[0] for s, p in cur.executed
          if 'INSERT INTO Configuration' in s and p]
check("seule la clé de ligue est écrite", ecrits == ['league_mode_enabled'], ecrits)
check("  tau n'est pas réécrit", 'tau' not in ecrits, ecrits)
check("  le reclassement de tous les joueurs ne part pas",
      not any('SET is_ranked' in s for s, _ in cur.executed),
      [s for s, _ in cur.executed])

cli, cur, conn = monter([SESSION('chef_admin')])
cli.post('/admin/config', headers=H, json={'unranked_threshold': 4})
check("un seuil fourni déclenche bien le reclassement",
      any('SET is_ranked' in s for s, _ in cur.executed))

cli, cur, conn = monter([SESSION('chef_admin')])
r = cli.post('/admin/config', headers=H, json={})
check("un payload vide est refusé", r.status_code == 400, r.status_code)


print("\n=== La page Ligues n'envoie plus que ses propres clés ===")
ligues = io_open(os.path.join(FRONT, 'templates', 'admin_ligues.html'))
check("plus de réémission de toute la config",
      '...currentConfig' not in ligues,
      "la page reposte encore l'objet complet")


print("\n=== Tournois ≠ fiches joueurs ===")
src = io_open(os.path.join(RACINE, 'routes_admin.py'))
i = src.find("@admin_bp.route('/add-tournament'")
check("add-tournament exige gestion_tournois",
      "@permission_required('gestion_tournois')" in src[i:i + 200], src[i:i + 200])

# Le contournement à fermer : un nom absent créait une fiche à la volée, ce qui
# aurait rendu la scission décorative.
deb = src.find('def add_tournament')
fin = src.find('\n@admin_bp.route', deb)
bloc = src[deb:fin if fin > deb else len(src)]
check("la création à la volée vérifie gestion_joueurs",
      "compte_a_permission(g.compte, 'gestion_joueurs')" in bloc)
check("  et refuse par un code lisible",
      '"joueur_inconnu"' in bloc or "'joueur_inconnu'" in bloc)
check("  avec rollback avant de sortir",
      bloc.count('conn.rollback()') >= 2, bloc.count('conn.rollback()'))


print("\n=== Le reset global est délégable via gestion_config (inverse R-51) ===")
for route in ('/api/admin/global-reset', '/api/admin/revert-global-reset'):
    j = src.find("@admin_bp.route('%s'" % route)
    check("%s sous gestion_config" % route,
          "@permission_required('gestion_config')" in src[j:j + 220],
          src[j:j + 220])

# La phrase subsiste dans le commentaire qui RETRACE le changement -- c'est
# voulu. Ce qui ne doit plus exister, c'est la consigne active : le bloc qui
# annonçait chef_admin comme cible.
check("la consigne « cible : role_required(ROLE_CHEF_ADMIN) » a disparu",
      'Decorateur cible du chantier' not in src)
check("  et le commentaire dit que R-51 est inversé",
      'R-51 est inverse en connaissance de cause' in src)

# L'interface doit suivre le backend : un bloc gaté chef_admin alors que la
# route accepte gestion_config cacherait un droit réellement accordé.
reglages = io_open(os.path.join(FRONT, 'templates', 'admin_reglages.html'))
check("le bloc reset est gaté par gestion_config",
      "peut('gestion_config')" in reglages)
check("  et plus par le rôle",
      "role_admin in ('chef_admin', 'superadmin')" not in reglages, reglages[:0])


print("\n=== Les gates de navigation suivent la scission ===")
navbar = io_open(os.path.join(FRONT, 'templates', 'navbar.html'))
check("l'entrée Tournois est gatée par gestion_tournois",
      "peut('gestion_tournois')" in navbar)
comptes_html = io_open(os.path.join(FRONT, 'templates', 'admin_comptes.html'))
check("le panneau de permissions décrit gestion_tournois",
      'gestion_tournois:' in comptes_html)
check("« Réglage TS » est le libellé retenu",
      "'Réglage TS'" in comptes_html)
check("  et sa description ne parle plus du mode ligue",
      'Régler le mode fantôme' in comptes_html
      and comptes_html.count('le mode ligue.') == 0)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
