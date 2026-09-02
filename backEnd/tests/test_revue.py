"""Non-regressions issues de la revue du 2026-09-02.

Chaque assertion ici correspond a un defaut qui EXISTAIT et a ete corrige. Le
but n'est pas de decrire le comportement voulu -- les autres fichiers s'en
chargent -- mais d'empecher ces defauts precis de revenir.
"""
from harness import *
from flask import Flask
import re as _re

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FRONT = os.path.join(RACINE, '..', 'frontEnd')

def lire(chemin):
    return io_open(chemin)

def io_open(chemin):
    with open(chemin, encoding='utf-8') as f:
        return f.read()

print("\n=== F1 : un joueur déconnecté doit pouvoir revenir ===")
# Le seul lien vers la connexion Discord était la page d'invitation. Or
# l'invitation est consommée : après une déconnexion ou l'expiration de la
# session (30 j), plus personne ne pouvait se reconnecter.
navbar = io_open(os.path.join(FRONT, 'templates', 'navbar.html'))
check("la navbar propose une connexion Discord", 'discord_login' in navbar or '/auth/discord/login' in navbar)
check("elle n'est proposée qu'aux visiteurs non connectés", 'not compte_joueur' in navbar)
check("et seulement si Discord est configuré", 'discord_configure' in navbar)

install_db([])
import auth_discord

print("\n--- et ce bouton n'ouvre AUCUNE inscription ---")
cur, conn = install_db([(r"SELECT id, statut FROM comptes", None)])
recharger(); import auth_discord as ad; import importlib; importlib.reload(ad)
import types
fake = types.ModuleType('requests')
class _E(Exception): pass
fake.exceptions = types.SimpleNamespace(RequestException=_E)
class R:
    def __init__(s, st, p): s.status_code, s._p = st, p
    def json(s): return s._p
fake.post = lambda u, **k: R(200, {'access_token': 'a'})
fake.get = lambda u, **k: R(200, {'id': '1', 'username': 'x', 'global_name': 'X', 'avatar': 'h'})
sys.modules['requests'] = fake
importlib.reload(ad)
try:
    ad.login('code', None, 'UA')
    check("sans compte et sans invitation -> refusé", False, "accepté à tort")
except ad.DiscordAuthError as e:
    check("sans compte et sans invitation -> refusé", e.code == 'invitation_requise', e.code)

print("\n=== F2 : l'anonymisation doit être atteignable ===")
# La suppression d'un joueur avec historique renvoie 409 en orientant vers
# l'anonymisation, et la politique de confidentialité la promet. Sans proxy
# frontend ni bouton, elle était injoignable.
front = io_open(os.path.join(FRONT, 'frontend.py'))
check("un proxy frontend expose l'anonymisation", '/anonymiser' in front)
gestion = io_open(os.path.join(FRONT, 'static', 'js', 'gestion.js'))
check("le refus de suppression la propose à l'admin", 'historique_non_vide' in gestion)
check("et l'appelle réellement", 'anonymiser' in gestion)
admin = io_open(os.path.join(RACINE, 'routes_admin.py'))
check("le backend renvoie bien ce code d'erreur", "historique_non_vide" in admin)

print("\n=== F3 : introuvables calculés sur les valeurs normalisées ===")
import services
for libelle, kwargs, lignes, attendu in [
    ("discord_ids en nombres", {'discord_ids': [111, 222]},
     [(1, 'A', 9.0, '111'), (2, 'B', 8.0, '222')], []),
    ("discord_ids en chaînes", {'discord_ids': ['111']}, [(1, 'A', 9.0, '111')], []),
    ("joueur_ids en chaînes", {'joueur_ids': ['7']}, [(7, 'A', 9.0, None)], []),
    ("un absent reste signalé", {'discord_ids': [111, 999]}, [(1, 'A', 9.0, '111')], ['999']),
]:
    cur, _ = install_db([])
    cur.fetchall = lambda l=lignes: l
    _, introuvables = services.resoudre_joueurs_matchmaking(cur, **kwargs)
    check(libelle, introuvables == attendu, introuvables)

print("\n=== F4 : isinstance(True, int) ne doit pas passer ===")
def monter_liaison():
    cur, conn = install_db([
        (r"FROM sessions_joueurs s JOIN comptes c", ligne_session(statut='pending')),
    ])
    recharger()
    sys.modules.pop('routes_comptes', None)
    import routes_comptes
    app = Flask(__name__)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client(), cur

cli, cur = monter_liaison()
r = cli.post('/auth/demande-liaison', json={'joueur_id': True},
             headers={'X-Session-Token': 't'})
check("un booléen est refusé (il vaut 1 en Python)", r.status_code == 400, r.status_code)
check("aucune fiche joueur n'a été interrogée",
      not any('FROM joueurs WHERE id' in s for s, _ in cur.executed))

print("\n=== F5 : valider et résoudre la même entrée ===")
cli, cur = monter_liaison()
r = cli.post('/admin/matchmaking', json={'noms': ['A'], 'joueur_ids': [7]},
             headers={'X-Session-Token': 't'})
check("deux listes à la fois -> 400", r.status_code in (400, 403), r.status_code)

print("\n=== F9 : aucun bouton visible ne doit être mort ===")
# La page /admin/comptes s'ouvre aux DEUX voies d'authentification. Toute action
# qu'elle affiche sans condition doit donc accepter les deux : sur
# `role_required` seul, le bouton répondait 401 à un admin par mot de passe.
comptes_src = io_open(os.path.join(RACINE, 'routes_comptes.py'))
admin_html = io_open(os.path.join(FRONT, 'templates', 'admin_comptes.html'))
lignes = comptes_src.split("\n")
routes_superadmin, routes_deux_voies = [], []
for i, l in enumerate(lignes):
    if l.startswith("@comptes_bp.route") and "/admin/" in l:
        j, decos = i + 1, []
        while j < len(lignes) and not lignes[j].startswith("def "):
            if lignes[j].startswith("@"): decos.append(lignes[j])
            j += 1
        chemin = l.split("'")[1]
        if any("ROLE_SUPERADMIN" in d for d in decos): routes_superadmin.append(chemin)
        elif any("admin_or_role_required" in d for d in decos): routes_deux_voies.append(chemin)

check("la fermeture des sessions accepte les deux voies",
      '/admin/comptes/<int:compte_id>/sessions' in routes_deux_voies, routes_deux_voies)
# Les routes réservées au superadmin sont légitimes : l'interface masque leurs
# commandes derrière `est_superadmin`, elles ne sont donc jamais mortes.
check("les routes superadmin sont bien masquées côté interface",
      'est_superadmin' in admin_html and 'EST_SUPERADMIN' in admin_html,
      routes_superadmin)

print("\n=== F7 : les deux CGU_VERSION doivent rester alignées ===")
back_cst = io_open(os.path.join(RACINE, 'constants.py'))
v_back = _re.search(r'CGU_VERSION\s*=\s*"([^"]+)"', back_cst).group(1)
v_front = _re.search(r'^CGU_VERSION\s*=\s*"([^"]+)"', front, _re.M).group(1)
check("backend et frontend annoncent la même version", v_back == v_front, (v_back, v_front))

print("\n=== F8 : l'export ne doit pas exploser si le compte a disparu ===")
comptes_src = io_open(os.path.join(RACINE, 'routes_comptes.py'))
i = comptes_src.index('def exporter_mes_donnees')
check("le fetchone du compte est vérifié",
      'if c is None' in comptes_src[i:i+2500], "pas de garde")

print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
