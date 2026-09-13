"""Sous-permissions : une permission qui ne vaut rien sans son parent.

Premier cas : `rgpd_joueurs` sous `gestion_joueurs` (2026-09-13). Elle protege
les deux gestes irreversibles sur une fiche -- anonymiser et supprimer -- pour
qu'ils ne soient plus emportes par le simple droit d'editer une fiche.

La regle tient a TROIS endroits, et ces tests couvrent les trois :
  - permission_required exige l'enfant ET le parent ;
  - accorder l'enfant sans le parent est refuse (409 parent_manquant) ;
  - retirer le parent emporte ses enfants, sinon une permission orpheline
    reviendrait a la vie au prochain re-octroi du parent.
"""
from harness import *
from flask import Flask

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FRONT = os.path.join(RACINE, '..', 'frontEnd')


def io_open(chemin):
    with open(chemin, encoding='utf-8') as f:
        return f.read()


print("\n=== La table des sous-permissions est cohérente ===")
from constants import PERMISSIONS_CATALOGUE, SOUS_PERMISSIONS

check("rgpd_joueurs est une sous-permission de gestion_joueurs",
      SOUS_PERMISSIONS.get('rgpd_joueurs') == 'gestion_joueurs', SOUS_PERMISSIONS)
check("enfants et parents appartiennent tous au catalogue",
      all(e in PERMISSIONS_CATALOGUE and p in PERMISSIONS_CATALOGUE
          for e, p in SOUS_PERMISSIONS.items()), SOUS_PERMISSIONS)
check("aucun parent n'est lui-même un enfant (pas de chaîne à gérer)",
      not (set(SOUS_PERMISSIONS.values()) & set(SOUS_PERMISSIONS)), SOUS_PERMISSIONS)

# Le frontend duplique catalogue ET table : desalignes, l'interface montrerait
# une case autonome la ou le backend exige un parent -- ou masquerait un droit
# reellement accorde. La doc affirmait que ce controle existait ; il n'existait
# nulle part, d'ou sa place ici.
import re as _re
front = io_open(os.path.join(FRONT, 'frontend.py'))

_i = front.find('PERMISSIONS_CATALOGUE = frozenset')
_cat_front = set(_re.findall(r"'(\w+)'", front[_i:front.find('})', _i)]))
check("les deux catalogues sont identiques",
      _cat_front == set(PERMISSIONS_CATALOGUE),
      sorted(_cat_front ^ set(PERMISSIONS_CATALOGUE)))

_j = front.find('SOUS_PERMISSIONS = {')
_sous_front = dict(_re.findall(r"'(\w+)':\s*'(\w+)'", front[_j:front.find('}', _j)]))
check("les deux tables de sous-permissions sont identiques",
      _sous_front == dict(SOUS_PERMISSIONS), (_sous_front, dict(SOUS_PERMISSIONS)))


print("\n=== Une sous-permission orpheline n'est jamais exposée à l'interface ===")
# permissions_admin peut contenir un orphelin : octroi anterieur a la creation
# de la sous-permission, ou SQL direct. Il ne donne aucun droit, mais l'exposer
# ferait afficher un bouton voue au 403 -- le defaut que tout ce chantier evite.
from constants import permissions_effectives

check("l'orpheline est retirée",
      permissions_effectives({'rgpd_joueurs'}) == set(),
      permissions_effectives({'rgpd_joueurs'}))
check("avec son parent, elle est conservée",
      permissions_effectives({'rgpd_joueurs', 'gestion_joueurs'})
      == {'rgpd_joueurs', 'gestion_joueurs'})
check("les permissions ordinaires passent intactes",
      permissions_effectives({'gestion_saisons', 'gestion_ligues'})
      == {'gestion_saisons', 'gestion_ligues'})
check("un ensemble vide reste vide", permissions_effectives(set()) == set())

# Les deux endroits qui servent les permissions a l'affichage doivent filtrer :
# /auth/me (rafraichissement) et la connexion (copie mise en session).
for fichier in ('routes_auth.py', 'auth_discord.py'):
    src = io_open(os.path.join(RACINE, fichier))
    check("%s filtre avant d'exposer" % fichier,
          'permissions_effectives(' in src, fichier)


print("\n=== permission_required exige l'enfant ET le parent ===")


def app_protegee(accordees):
    """Appli minimale derriere @permission_required('rgpd_joueurs')."""
    plan = [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=1, discord_id='111', username='a',
                       global_name='A', role='admin')),
        (r"SELECT 1 FROM permissions_admin",
         lambda params: (1,) if params and params[1] in accordees else None),
    ]
    cur, conn = install_db(plan)
    recharger()
    import auth, importlib
    importlib.reload(auth)
    app = Flask(__name__)

    @app.route('/protege', methods=['POST'])
    @auth.permission_required('rgpd_joueurs')
    def protege():
        from flask import jsonify
        return jsonify({"ok": True})

    return app.test_client(), cur, conn


H = {'X-Session-Token': 'tok'}

cli, _, _ = app_protegee({'rgpd_joueurs', 'gestion_joueurs'})
check("les deux permissions -> passe", cli.post('/protege', headers=H).status_code == 200)

cli, _, _ = app_protegee({'rgpd_joueurs'})
r = cli.post('/protege', headers=H)
check("l'enfant SANS le parent -> 403", r.status_code == 403, (r.status_code, r.get_json()))

cli, _, _ = app_protegee({'gestion_joueurs'})
check("le parent seul -> 403 (c'est tout l'objet de la scission)",
      cli.post('/protege', headers=H).status_code == 403)

cli, _, _ = app_protegee(set())
check("aucune des deux -> 403", cli.post('/protege', headers=H).status_code == 403)


print("\n=== Les deux gestes irréversibles sont derrière la sous-permission ===")
src_admin = io_open(os.path.join(RACINE, 'routes_admin.py'))
for route, methode in (("'/admin/joueurs/<int:id>', methods=['DELETE']", 'suppression'),
                       ("'/admin/joueurs/<int:id>/anonymiser'", 'anonymisation')):
    i = src_admin.find(route)
    check("%s sous rgpd_joueurs" % methode,
          i >= 0 and "@permission_required('rgpd_joueurs')" in src_admin[i:i + 220],
          src_admin[i:i + 200] if i >= 0 else 'route introuvable')

# L'edition ordinaire d'une fiche NE doit PAS avoir bouge : c'est le sens meme
# de la sous-permission, isoler l'irreversible sans gener le courant.
i = src_admin.find("'/admin/joueurs/<int:id>', methods=['PUT']")
check("l'édition d'une fiche reste sous gestion_joueurs",
      "@permission_required('gestion_joueurs')" in src_admin[i:i + 220],
      src_admin[i:i + 200])


print("\n=== Octroi : l'enfant sans son parent est refusé ===")
src_comptes = io_open(os.path.join(RACINE, 'routes_comptes.py'))
deb = src_comptes.find('def accorder_permission')
fin = src_comptes.find('\n@comptes_bp.route', deb)
octroi = src_comptes[deb:fin]
check("le parent est vérifié avant d'accorder",
      'SOUS_PERMISSIONS.get(permission)' in octroi)
check("  refus explicite, code parent_manquant",
      "'parent_manquant'" in octroi or '"parent_manquant"' in octroi)
check("  et rollback avant de sortir",
      octroi.count('conn.rollback()') >= 3, octroi.count('conn.rollback()'))
check("  la vérification est DANS la transaction, après le FOR UPDATE",
      octroi.find('FOR UPDATE') < octroi.find('SOUS_PERMISSIONS.get'))


print("\n=== Retrait : le parent emporte ses enfants ===")
deb = src_comptes.find('def retirer_permission')
fin = src_comptes.find('\n@comptes_bp.route', deb)
retrait = src_comptes[deb:fin]
check("les enfants du parent retiré sont calculés",
      'SOUS_PERMISSIONS.items()' in retrait)
check("  et supprimés dans la même requête",
      'permission = ANY(%s)' in retrait)
check("  l'audit consigne ce qui a été emporté",
      'sous_permissions_emportees' in retrait)


print("\n=== L'interface ne propose jamais un bouton menant à un 403 ===")
comptes_html = io_open(os.path.join(FRONT, 'templates', 'admin_comptes.html'))
check("le panneau connaît la table des sous-permissions",
      'const SOUS_PERMISSIONS' in comptes_html)
check("la case est désactivée tant que le parent manque",
      'parentManquant' in comptes_html)
check("  et le dit, plutôt que de rester inerte",
      'nécessite' in comptes_html)
check("cocher/décocher le parent répercute sur ses enfants",
      "SOUS_PERMISSIONS[enfant] !== p" in comptes_html)
check("le libellé RGPD existe", 'rgpd_joueurs:' in comptes_html)
check("  et « Fiches joueurs » ne revendique plus l'anonymisation",
      "l'anonymisation RGPD." not in comptes_html)

# La page des fiches joueurs porte les boutons Supprimer/Anonymiser : sans ce
# drapeau ils resteraient visibles pour qui n'a pas la sous-permission.
fiches = io_open(os.path.join(FRONT, 'templates', 'gestion_joueurs.html'))
check("la page Fiches joueurs expose le droit RGPD au JS",
      'PEUT_RGPD_JOUEURS' in fiches)
gestion_js = io_open(os.path.join(FRONT, 'static', 'js', 'gestion.js'))
check("  et le bouton Supprimer y est conditionné",
      'PEUT_RGPD_JOUEURS' in gestion_js)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
