"""Sous-permissions : une permission qui ne vaut rien sans son parent.

Exigee avec son parent, refusee a l'octroi sans lui, retiree avec lui.
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

GESTES_FICHE = ('joueurs_creation', 'joueurs_nom', 'joueurs_couleur',
                'edition_mu_sigma', 'joueurs_statut', 'joueurs_irreversible')
for _geste in GESTES_FICHE:
    check("%s est une sous-permission de gestion_joueurs" % _geste,
          SOUS_PERMISSIONS.get(_geste) == 'gestion_joueurs', SOUS_PERMISSIONS)
check("l'ex-rgpd_joueurs a bien disparu du catalogue",
      'rgpd_joueurs' not in PERMISSIONS_CATALOGUE)
check("enfants et parents appartiennent tous au catalogue",
      all(e in PERMISSIONS_CATALOGUE and p in PERMISSIONS_CATALOGUE
          for e, p in SOUS_PERMISSIONS.items()), SOUS_PERMISSIONS)
check("aucun parent n'est lui-même un enfant (pas de chaîne à gérer)",
      not (set(SOUS_PERMISSIONS.values()) & set(SOUS_PERMISSIONS)), SOUS_PERMISSIONS)

# Le frontend duplique catalogue et table : ils doivent rester alignes.
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
# Une sous-permission orpheline ne doit pas etre exposee a l'affichage.
from constants import permissions_effectives

check("l'orpheline est retirée",
      permissions_effectives({'edition_mu_sigma'}) == set(),
      permissions_effectives({'edition_mu_sigma'}))
check("avec son parent, elle est conservée",
      permissions_effectives({'edition_mu_sigma', 'gestion_joueurs'})
      == {'edition_mu_sigma', 'gestion_joueurs'})
check("les permissions ordinaires passent intactes",
      permissions_effectives({'gestion_saisons', 'gestion_ligues'})
      == {'gestion_saisons', 'gestion_ligues'})
check("un ensemble vide reste vide", permissions_effectives(set()) == set())

# /auth/me et la connexion filtrent les orphelines.
for fichier in ('routes_auth.py', 'auth_discord.py'):
    src = io_open(os.path.join(RACINE, fichier))
    check("%s filtre avant d'exposer" % fichier,
          'permissions_effectives(' in src, fichier)


print("\n=== permission_required exige l'enfant ET le parent ===")


def app_protegee(accordees):
    """Appli minimale derriere @permission_required('joueurs_irreversible')."""
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
    @auth.permission_required('joueurs_irreversible')
    def protege():
        from flask import jsonify
        return jsonify({"ok": True})

    return app.test_client(), cur, conn


H = {'X-Session-Token': 'tok'}

cli, _, _ = app_protegee({'joueurs_irreversible', 'gestion_joueurs'})
check("les deux permissions -> passe", cli.post('/protege', headers=H).status_code == 200)

cli, _, _ = app_protegee({'joueurs_irreversible'})
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
    check("%s sous joueurs_irreversible" % methode,
          i >= 0 and "@permission_required('joueurs_irreversible')" in src_admin[i:i + 220],
          src_admin[i:i + 200] if i >= 0 else 'route introuvable')


print("\n=== L'édition d'une fiche se vérifie CHAMP PAR CHAMP ===")
# Le PUT exige gestion_joueurs, puis chaque champ sa sous-permission.
from constants import PERMISSIONS_CHAMPS_JOUEUR

i = src_admin.find("'/admin/joueurs/<int:id>', methods=['PUT']")
j = src_admin.find('\n@admin_bp.route', i + 10)
corps_put = src_admin[i:j]
check("le PUT garde gestion_joueurs comme porte d'entrée",
      "@permission_required('gestion_joueurs')" in corps_put[:220])
check("  et vérifie chaque champ dans son corps",
      'PERMISSIONS_CHAMPS_JOUEUR' in corps_put and 'compte_a_permission' in corps_put)
check("  en refusant par un code lisible, pas un 403 muet",
      'permission_manquante' in corps_put and '"champ"' in corps_put)

check("les cinq champs éditables sont couverts",
      set(PERMISSIONS_CHAMPS_JOUEUR) == {'nom', 'mu', 'sigma', 'is_ranked', 'color'},
      sorted(PERMISSIONS_CHAMPS_JOUEUR))
check("  mu et sigma relèvent du MÊME droit",
      PERMISSIONS_CHAMPS_JOUEUR['mu'] == PERMISSIONS_CHAMPS_JOUEUR['sigma']
      == 'edition_mu_sigma')
check("  et chaque droit cité existe au catalogue",
      all(p in PERMISSIONS_CATALOGUE for p in PERMISSIONS_CHAMPS_JOUEUR.values()))

# Un champ absent ou inchange n'exige aucun droit.
check("un champ inchangé n'exige aucun droit",
      'def a_change(' in corps_put and 'if not a_change(champ)' in corps_put)
check("  mu/sigma se comparent à la précision AFFICHÉE, pas à l'identique",
      'DECIMALES_AFFICHEES' in corps_put,
      "le front affiche 3 décimales là où TrueSkill en produit plus")
# Un champ inchange reprend la valeur de la base.
check("  et un champ inchangé reprend la valeur de la base",
      'demande[champ] = courant[champ]' in corps_put, corps_put[-600:])

# La creation verifie aussi edition_mu_sigma.
i = src_admin.find("'/admin/joueurs', methods=['POST']")
j = src_admin.find('\n@admin_bp.route', i + 10)
corps_post = src_admin[i:j]
check("la création est sous joueurs_creation",
      "@permission_required('joueurs_creation')" in corps_post[:220], corps_post[:200])
check("  et un score de départ hors défaut exige edition_mu_sigma",
      "'edition_mu_sigma'" in corps_post and 'DEFAULT_MU' in corps_post)
check("  une couleur choisie exige joueurs_couleur",
      "'joueurs_couleur'" in corps_post)


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
for _geste in GESTES_FICHE:
    check("le libellé de %s existe" % _geste, _geste + ':' in comptes_html)
check("  et « Fiches joueurs » n'annonce plus que la lecture",
      "l'anonymisation RGPD." not in comptes_html
      and 'Créer, renommer et corriger le score' not in comptes_html)

# Les champs sans droit sont grises, pas masques.
fiches = io_open(os.path.join(FRONT, 'templates', 'gestion_joueurs.html'))
check("la page Fiches joueurs expose les droits par geste au JS",
      'PEUT_CHAMPS_JOUEUR' in fiches)
for _cle in ('nom', 'mu', 'color', 'is_ranked', 'creation', 'irreversible'):
    check("  le drapeau %s est déclaré" % _cle, _cle + ':' in fiches)
check("le formulaire d'ajout disparaît sans joueurs_creation",
      "{% if peut('joueurs_creation') %}" in fiches)
check("  les champs mu/sigma d'ajout sont gatés",
      fiches.count("peut('edition_mu_sigma')") >= 2)

gestion_js = io_open(os.path.join(FRONT, 'static', 'js', 'gestion.js'))
check("le JS lit les droits par geste", 'PEUT_CHAMPS_JOUEUR' in gestion_js)
check("  un champ interdit n'est PAS envoyé au backend",
      'if (champ && !champ.disabled) data[cle]' in gestion_js,
      "sinon le backend répond 403 sur un champ non modifié")
check("  le bouton Supprimer est grisé plutôt que masqué",
      "peutChamp('irreversible')" in gestion_js and 'est-interdit' in gestion_js)
check("  le bouton de statut reste inerte sans le droit",
      "btn.classList.contains('est-interdit')) return" in gestion_js)
check("  et un rafraîchissement visuel ne le rend pas cliquable",
      'const interdit =' in gestion_js,
      "updateRankedVisuals réécrit className en entier")

css = io_open(os.path.join(FRONT, 'static', 'css', 'styles.css'))
check("le curseur interdit est défini", '.est-interdit' in css and 'not-allowed' in css)
check("  et l'infobulle reste visible sur un champ désactivé",
      'pointer-events: auto' in css)


print("\n=== Ergonomie du panneau : confirmation et scroll ===")
import re as _re2

# Un succes de permission ne fait pas remonter la page.
i = comptes_html.find('function afficher(')
corps_afficher = comptes_html[i:i + 900]
check("afficher() sait ne pas bouger la page",
      'discret' in corps_afficher, corps_afficher[:200])

i = comptes_html.find("case_.addEventListener('change'")
# Borne sur la vraie fin du handler.
handler = comptes_html[i:comptes_html.find('ligne.appendChild(case_)', i)]
check("un succès de permission n'appelle plus le bandeau",
      "afficher('success'" not in handler, handler[-600:])
check("  le retour se fait sur la ligne cochée",
      'flash(entete_l' in handler)
check("  mais un échec reste visible en haut",
      "afficher('danger'" in handler)
check("flash() ne touche jamais au défilement",
      'scrollTo' not in comptes_html[comptes_html.find('function flash('):
                                     comptes_html.find('function flash(') + 700])

# Toute modification de droits ou d'etat confirme en nommant la cible.
check("un helper de confirmation nommant la cible existe",
      'function confirmer(' in comptes_html and 'const nomDe' in comptes_html)

ecritures = [(m.group(2), m.group(1)) for m in _re2.finditer(
    r"api\(\s*'([^']+)'[^)]*?,\s*'(POST|DELETE|PUT)'", comptes_html, _re2.S)]
# Seules les creations (invitation, jeton) restent sans confirmation.
SANS_CONFIRMATION = {'/admin/invitations', '/admin/service-tokens'}
manquantes = []
for methode, url in ecritures:
    if url in SANS_CONFIRMATION:
        continue
    j = comptes_html.find("'%s'" % url)
    amont = comptes_html[max(0, j - 900):j]
    if not ('confirmer(' in amont or 'confirm(' in amont or 'prompt(' in amont):
        manquantes.append((methode, url))
check("toute écriture destructrice demande confirmation", not manquantes, manquantes)

for geste in ('Changer le rôle', 'Suspendre ce compte', 'Fermer toutes les sessions',
              'Révoquer cette invitation'):
    check("  « %s » est confirmé" % geste, geste in comptes_html)

check("annuler un changement de rôle remet le sélecteur",
      'sel.value = c.role;' in comptes_html)
check("annuler une permission remet la case",
      _re2.search(r"case_\.checked = !case_\.checked;\s*\n\s*return;", comptes_html)
      is not None)


print("\n=== Onglets : ce qu'on ne peut pas faire ne s'affiche pas ===")
# Chaque onglet de /admin/comptes depend de sa permission.
for onglet, perm in (('liaisons', 'gestion_liaisons'),
                     ('comptes', 'gestion_comptes'),
                     ('invitations', 'gestion_invitations')):
    i = comptes_html.find('data-onglet="%s"' % onglet)
    amont = comptes_html[max(0, i - 260):i]
    check("l'onglet %s est gaté par %s" % (onglet, perm),
          "peut('%s')" % perm in amont, amont[-120:])
    # La vue suit l'onglet.
    j = comptes_html.find('id="vue-%s"' % onglet)
    check("  et sa vue l'est aussi",
          "peut('%s')" % perm in comptes_html[max(0, j - 200):j])

# Une vue absente ne doit jamais etre dereferencee.
for fn in ('chargerLiaisons', 'chargerComptes', 'chargerInvitations', 'chargerBots'):
    i = comptes_html.find('function %s(' % fn)
    check("%s sort si sa vue n'existe pas" % fn,
          'if (!vue) return;' in comptes_html[i:i + 700], fn)

check("l'onglet actif est choisi parmi ceux rendus",
      'montrer(onglets[0])' in comptes_html)
check("  et plus codé en dur dans le gabarit",
      'class="is-active" data-onglet' not in comptes_html)

# Sans aucune des trois permissions, la route refuse.
i = front.find('def admin_comptes(')
check("la route refuse qui n'a aucune des trois permissions",
      "'gestion_comptes', 'gestion_liaisons', 'gestion_invitations'"
      in front[i:i + 900])


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
