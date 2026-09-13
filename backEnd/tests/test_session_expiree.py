"""Non-regressions du correctif « session Discord expiree toujours affichee ».

Le defaut : rien ne revalidait jamais `player_token`. Le frontend decidant
l'etat connecte et l'onglet admin sur une copie figee dans le cookie
(`session['compte']`), un jeton expire laissait l'utilisateur affiche comme
connecte -- onglet admin compris -- jusqu'a ce qu'il visite /mon-compte. Les
pages admin s'ouvraient alors sur « Chargement impossible. » au premier appel
de donnees, au lieu d'une invitation a se reconnecter.

Ces assertions portent sur le SOURCE, comme test_bascule : c'est du cablage
entre deux services, il n'y a pas de comportement a executer ici.
"""
from harness import *
import re as _re

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FRONT = os.path.join(RACINE, '..', 'frontEnd')


def io_open(chemin):
    with open(chemin, encoding='utf-8') as f:
        return f.read()


def bloc(source, ancre, taille=1200):
    """Portion de source suivant `ancre`, ou '' si l'ancre a disparu.

    Un `.index()` nu leverait, et l'assertion suivante ne s'afficherait jamais :
    le fichier de test mourrait a la premiere regression au lieu de nommer ce
    qui a casse. Renvoyer '' fait echouer l'assertion, proprement.
    """
    i = source.find(ancre)
    return '' if i < 0 else source[i:i + taille]


front = io_open(os.path.join(FRONT, 'frontend.py'))
routes_auth = io_open(os.path.join(RACINE, 'routes_auth.py'))
admin_html = io_open(os.path.join(FRONT, 'templates', 'admin_comptes.html'))


print("\n=== La sonde de session existe et ne coute rien ===")
# Elle est appelee sur CHAQUE page : elle ne doit rien lire de plus que la
# verification de session que player_required fait deja. /auth/me ferait une
# requete supplementaire pour le nom du joueur, payee sur tout le site.
check("le backend expose /auth/check-session",
      "'/auth/check-session'" in routes_auth)
sonde_backend = bloc(routes_auth, "'/auth/check-session'", 900)
check("elle exige une session valide", '@player_required' in sonde_backend)
check("elle ne fait aucune requete SQL",
      bool(sonde_backend) and 'get_db_connection' not in sonde_backend
      and 'cur.execute' not in sonde_backend)


print("\n=== Le frontend revalide les DEUX voies a chaque requete ===")
avant_request = bloc(front, 'def check_session_validity')
check("before_request surveille la session Discord",
      "session.get('player_token')" in avant_request)
check("before_request surveille aussi l'ancien jeton admin",
      "'admin_token' in session" in avant_request)
check("un refus purge le jeton joueur ET sa copie de compte",
      "pop('player_token'" in avant_request and "pop('compte'" in avant_request)

print("\n--- mais ne purge QUE sur un refus explicite (R-28) ---")
# Confondre « session invalide » et « backend en panne » deconnecterait tout le
# monde a chaque redemarrage du backend.
sonde = bloc(front, 'def _sonde_session', 900)
check("seuls 401/403 declenchent la purge",
      '(401, 403)' in sonde or '[401, 403]' in sonde)
check("un timeout conserve la session",
      'return False' in sonde and 'except Exception' in sonde)


print("\n=== Aucune page admin ne se rend sur la seule foi du cookie ===")
# _est_admin() lit une copie potentiellement perimee : c'est une porte
# d'interface, pas une preuve de session. Toute page admin doit donc revalider
# aupres du backend avant de rendre son gabarit.
PAGES_ADMIN = [
    ("admin_comptes", "admin_comptes.html"),
    ("admin_tournois", "add_tournament.html"),
    ("admin_joueurs_fiches", "gestion_joueurs.html"),
    ("admin_reglages", "admin_reglages.html"),
    ("admin_saisons_page", "admin_saisons.html"),
    ("admin_ligues_page", "admin_ligues.html"),
]
for nom, _gabarit in PAGES_ADMIN:
    k = front.find('def %s(' % nom)
    if k < 0:
        check("%s revalide avant de rendre" % nom, False, "vue introuvable")
        continue
    # Jusqu'a la prochaine route : la revalidation doit etre DANS la vue.
    fin = front.find('@app.route', k)
    corps = front[k:fin if fin > k else k + 4000]
    check("%s revalide avant de rendre" % nom,
          '/admin/check-token' in corps, nom)


print("\n=== La sortie de session ne renvoie plus vers le mot de passe ===")
# Plus aucune route backend n'accepte ce jeton : aucun usage de
# admin_or_role_required ne subsiste, et /admin/check-token est passee en
# role_required(ROLE_ADMIN). S'y reconnecter ne rouvrirait donc rien.
sortie = bloc(front, 'def _session_admin_expiree')
check("elle purge les deux voies",
      "pop('player_token'" in sortie and "pop('admin_token'" in sortie)
check("et renvoie vers l'accueil, pas vers l'ecran mot de passe",
      "url_for('index')" in sortie and 'admin_login' not in sortie)
check("plus aucune redirection vers l'ecran mot de passe nulle part",
      "url_for('admin_login')" not in front)


print("\n=== Une page deja ouverte reagit au 401 ===")
# Sans ca, chaque appel affichait « Chargement impossible. » sans dire pourquoi
# ni proposer de se reconnecter -- le serveur ayant deja purge la session.
api_js = bloc(admin_html, 'async function api(', 1400)
check("le helper api() detecte le refus de session",
      'status === 401' in api_js or 'status === 403' in api_js)
check("et redirige au lieu de peindre une erreur",
      'window.location' in api_js)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
