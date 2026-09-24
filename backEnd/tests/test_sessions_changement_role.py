"""Changer de role ferme les sessions du compte (A-01/A-02, 2026-09-22).

La duree d'une session est figee a sa creation, sur le role du moment
(create_session), et rien ne la revisite. La regle qui la tient : toute
ecriture de comptes.role ferme les sessions du compte concerne, dans les deux
sens. Promu, un compte garderait sinon sa session de joueur de 30 jours --
soixante fois les 12 heures destinees a un admin ; retrograde, des sessions
ouvertes sur un rang qu'il n'a plus.

Ce que ce fichier verrouille :

  1. LE FILET : toute fonction du backend qui ecrit comptes.role ferme aussi
     des sessions. Un cinquieme ecrivain qui l'oublierait rougit ici, par
     analyse du source -- c'est le cas que les quatre tests suivants, ecrits
     pour les ecrivains connus, ne verraient pas.
  2. Les quatre ecrivains, par execution : changer_role, l'acceptation d'une
     promotion, le legs (DEUX comptes changent de role), l'amorcage.
  3. Ce qui ne doit PAS fermer : un refus, un role inchange, une connexion
     ordinaire (A-06 reste un choix acte).
  4. Le frontend : le jeton purge et la reconnexion relancee, plutot qu'une
     deconnexion muette que la personne lirait comme une panne.

Aucun Postgres : le curseur est scripte.
"""
from harness import *
from flask import Flask
import ast
import glob
import importlib

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FRONT = os.path.join(RACINE, '..', 'frontEnd')
FERME = 'DELETE FROM sessions_joueurs WHERE compte_id'
ECRIT_ROLE = re.compile(r"UPDATE\s+comptes\s+SET\s+role\b")


def lire(*chemin):
    with open(os.path.join(*chemin), encoding='utf-8') as f:
        return f.read()


def fonctions(source):
    """{nom: source} de chaque fonction, delimitee par ast.

    Pas de fenetre de taille fixe : c'est une fenetre de 6000 caracteres qui a
    failli laisser VERTE l'assertion defaut() de A-02 une fois le defaut
    corrige (test_audit_auth_discord.py, fonction()).
    """
    lignes = source.splitlines(keepends=True)
    return {n.name: ''.join(lignes[n.lineno - 1:n.end_lineno])
            for n in ast.walk(ast.parse(source))
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}


def entre(source, debut, fin):
    """Texte de `debut` a `fin` ('' si l'un manque : l'assertion echoue, nommee)."""
    i = source.find(debut)
    j = source.find(fin, i + 1) if i >= 0 else -1
    return '' if i < 0 or j < 0 else source[i:j]


def fermetures(cur):
    """(index, params) de chaque fermeture de sessions par compte."""
    return [(i, p) for i, (s, p) in enumerate(cur.executed) if FERME in s]


def index_de(cur, motif):
    return [i for i, (s, _) in enumerate(cur.executed) if re.search(motif, s)]


def monter(plan, role='superadmin', compte_id=1):
    """Blueprint des comptes, avec une session au role voulu (calque test_hierarchie_routes)."""
    plan = list(plan) + [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=compte_id, discord_id='111', username='chef',
                       global_name='Chef', role=role)),
    ]
    cur, conn = install_db(plan)
    recharger()
    for m in ('routes_comptes', 'cache'):
        sys.modules.pop(m, None)
    import cache
    cache.invalidate_cache = lambda: None
    import routes_comptes
    app = Flask(__name__)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client(), cur, conn


H = {'X-Session-Token': 'tok'}
CIBLE = lambda role: (r"SELECT role FROM comptes WHERE id", (role,))


# ===========================================================================
print("\n=== 1. Le filet : toute ecriture de comptes.role ferme des sessions ===")
# ===========================================================================
# Tout le backend, pas une liste de fichiers : un ecrivain ajoute dans un
# nouveau module doit tomber dans le filet comme les autres.
ecrivains = {}
for chemin in sorted(glob.glob(os.path.join(RACINE, '*.py'))):
    for nom, corps in fonctions(lire(chemin)).items():
        if ECRIT_ROLE.search(corps):
            ecrivains[nom] = (os.path.basename(chemin), corps)

# Un filet qui ne trouverait aucun ecrivain passerait a vide : on verifie
# d'abord qu'il voit bien ceux qu'on connait.
ATTENDUS = {'changer_role', 'repondre_promotion', 'leguer_superadmin',
            'promote_bootstrap_superadmin'}
check("le filet voit les quatre ecrivains connus", ATTENDUS <= set(ecrivains),
      sorted(ATTENDUS - set(ecrivains)))
for nom, (fichier, corps) in sorted(ecrivains.items()):
    check("%s (%s) ferme les sessions du compte dont il change le role" % (nom, fichier),
          FERME in corps,
          "ecrit comptes.role sans fermer de session : A-01/A-02 rouvert")


# ===========================================================================
print("\n=== 2a. changer_role : la cible se reconnecte, dans les deux sens ===")
# ===========================================================================

# Retrogradation admin -> player (A-02).
cli, cur, conn = monter([CIBLE('admin')])
r = cli.post('/admin/comptes/5/role', json={'role': 'player'}, headers=H)
f = fermetures(cur)
check("retrogradation -> 200", r.status_code == 200, r.get_json())
check("les sessions de la CIBLE sont fermees", [p for _, p in f] == [(5,)], f)
check("pas celles de l'acteur : il continue sa session",
      all(p != (1,) for _, p in f), f)
_maj = index_de(cur, r"UPDATE comptes SET role")
check("fermees dans la transaction du changement de role, apres l'UPDATE",
      bool(f) and bool(_maj) and f[0][0] > _maj[0] and conn.committed,
      (f, _maj, conn.committed))

# Retrogradation chef_admin -> admin : l'autre sens de A-02, sur le seul chemin
# qui reste a changer_role depuis R-68 (la promotion directe y est refusee, et
# c'est l'acceptation, section 2b, qui ferme les sessions du promu).
cli, cur, conn = monter([
    CIBLE('chef_admin'),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (2,)),
])
r = cli.post('/admin/comptes/5/role', json={'role': 'admin'}, headers=H)
check("chef_admin -> admin -> 200", r.status_code == 200, r.get_json())
check("  les sessions de la cible sont fermees aussi",
      [p for _, p in fermetures(cur)] == [(5,)], fermetures(cur))

# Promotion directe refusee (R-68) : rien n'est ecrit, donc rien n'est ferme.
cli, cur, conn = monter([CIBLE('admin')])
r = cli.post('/admin/comptes/5/role', json={'role': 'chef_admin'}, headers=H)
check("promotion directe refusee -> 409 promotion_par_proposition",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'promotion_par_proposition',
      r.get_json())
check("  aucune session fermee", not fermetures(cur), fermetures(cur))

# Ce qui ne change aucun role ne ferme rien.
cli, cur, conn = monter([CIBLE('player')])
r = cli.post('/admin/comptes/5/role', json={'role': 'player'}, headers=H)
check("role inchange -> 200 inchange", (r.get_json() or {}).get('inchange') is True,
      r.get_json())
check("  aucune session fermee", not fermetures(cur), fermetures(cur))

cli, cur, conn = monter([
    CIBLE('chef_admin'),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (0,)),
])
r = cli.post('/admin/comptes/5/role', json={'role': 'admin'}, headers=H)
check("dernier chef_admin sans confirmation -> 409",
      r.status_code == 409 and r.get_json()['code'] == 'dernier_chef_admin', r.get_json())
check("  aucune session fermee : le role n'a pas change", not fermetures(cur),
      fermetures(cur))

cli, cur, conn = monter([CIBLE('admin')], role='superadmin', compte_id=5)
r = cli.post('/admin/comptes/5/role', json={'role': 'player'}, headers=H)
check("auto-modification -> 403", r.status_code == 403, r.get_json())
check("  aucune session fermee", not fermetures(cur), fermetures(cur))


# ===========================================================================
print("\n=== 2b. Accepter une promotion : TOUTES les sessions, la courante comprise ===")
# ===========================================================================
# C'est le chemin de toute promotion depuis la phase 1bis : on devient admin en
# acceptant DEPUIS sa session de joueur, ouverte pour 30 jours.
PROMO = (7, 'admin', 1, PASSE, FUTUR)
PLAN_PROMO = [
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('player',)),
    (r"FROM promotions_proposees", PROMO),
]

cli, cur, conn = monter(PLAN_PROMO, role='player', compte_id=5)
r = cli.post('/me/promotion', json={'accepte': True, 'cgu_admin_version': '1.0'}, headers=H)
f = fermetures(cur)
d = r.get_json() or {}
check("accepter -> 200", r.status_code == 200, d)
check("toutes les sessions du titulaire sont fermees (A-01)",
      [p for _, p in f] == [(5,)], f)
check("  sans exception pour la courante : pas de filtre sur token_hash",
      all('token_hash' not in cur.executed[i][0] for i, _ in f),
      [cur.executed[i][0] for i, _ in f])
_maj = index_de(cur, r"UPDATE comptes SET role")
check("  dans la transaction qui pose le role",
      bool(f) and bool(_maj) and f[0][0] > _maj[0] and conn.committed,
      (f, _maj, conn.committed))
check("la reponse dit que la session est fermee (le frontend purge le jeton)",
      d.get('session_fermee') is True, d)

cli, cur, conn = monter(PLAN_PROMO, role='player', compte_id=5)
r = cli.post('/me/promotion', json={'accepte': False}, headers=H)
d = r.get_json() or {}
check("refuser -> 200", r.status_code == 200, d)
check("  refuser ne ferme rien : le role reste player", not fermetures(cur),
      fermetures(cur))
check("  et ne dit pas le contraire au frontend", not d.get('session_fermee'), d)

cli, cur, conn = monter([
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('player',)),
    (r"FROM promotions_proposees", None),
], role='player', compte_id=5)
r = cli.post('/me/promotion', json={'accepte': True, 'cgu_admin_version': '1.0'}, headers=H)
check("proposition expiree -> 409", r.status_code == 409, r.get_json())
check("  aucune session fermee", not fermetures(cur), fermetures(cur))


# ===========================================================================
print("\n=== 2c. Legs : deux roles changent, deux comptes se reconnectent ===")
# ===========================================================================
DEUX_LIGNES = lambda acteur, cible: (
    r"SELECT id, role, discord_username, cgu_admin_version\s+FROM comptes WHERE id IN",
    [acteur, cible])

# Cible admin : sans la fermeture, elle deviendrait superadmin sur une session
# d'admin ouverte avant le legs. (Une cible player n'est plus leguable, R-68.)
cli, cur, conn = monter([DEUX_LIGNES((1, 'superadmin', 'chef', '1.0'),
                                     (5, 'admin', 'vraipseudo', '1.0'))])
r = cli.post('/admin/comptes/5/leguer-superadmin',
             json={'confirmation_pseudo': 'vraipseudo'}, headers=H)
f = fermetures(cur)
d = r.get_json() or {}
check("legs -> 200", r.status_code == 200, d)
_vises = {x for _, p in f for x in (p or ())}
check("les sessions de la cible ET de l'acteur sont fermees", _vises == {1, 5}, f)
_maj = index_de(cur, r"UPDATE comptes SET role")
check("  apres les deux ecritures du role, dans la meme transaction",
      bool(f) and len(_maj) == 2 and f[0][0] > _maj[1] and conn.committed,
      (f, _maj, conn.committed))
check("la reponse dit que la session de l'acteur est fermee",
      d.get('session_fermee') is True, d)

cli, cur, conn = monter([DEUX_LIGNES((1, 'superadmin', 'chef', '1.0'),
                                     (5, 'admin', 'vraipseudo', '1.0'))])
r = cli.post('/admin/comptes/5/leguer-superadmin',
             json={'confirmation_pseudo': 'Nom Affiche'}, headers=H)
check("legs refuse (pseudo faux) -> 400", r.status_code == 400, r.get_json())
check("  aucune session fermee", not fermetures(cur), fermetures(cur))


# ===========================================================================
print("\n=== 2d. Amorcage : les anciennes sessions de joueur tombent, pas la nouvelle ===")
# ===========================================================================
# Le compte designe par DISCORD_SUPERADMIN_ID existait en player, avec une
# session sur un autre appareil. Il se connecte ici et devient superadmin : la
# session de l'autre appareil garderait 30 jours de superadmin.
os.environ['DISCORD_SUPERADMIN_ID'] = '123456789012345678'
recharger(); install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", (42, 'linked')),
    (r"INSERT INTO comptes", ligne_compte(joueur_id=9, statut='linked', role='player')),
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('player',)),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (0,)),
])
import auth_discord; importlib.reload(auth_discord)
res = auth_discord.login('c', None, 'UA')
f = fermetures(cur)
_creees = index_de(cur, r"INSERT INTO sessions_joueurs")
check("promu superadmin", res['compte']['role'] == 'superadmin', res['compte']['role'])
check("ses sessions anterieures sont fermees", [p for _, p in f] == [(42,)], f)
check("AVANT la creation de la nouvelle : celle-ci survit",
      bool(f) and bool(_creees) and f[0][0] < _creees[0], (f, _creees))
_duree = (datetime.fromisoformat(res['expires_at']) - datetime.now(timezone.utc))
check("et la nouvelle a la duree d'un superadmin (12 h)",
      _duree.total_seconds() / 3600 < 12.1, _duree)

# Connexion ordinaire : aucun role ne change, aucune session ne tombe. Se
# reconnecter n'invalide pas les autres sessions -- A-06, choix acte (D5).
os.environ.pop('DISCORD_SUPERADMIN_ID')
recharger(); install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", (42, 'linked')),
    (r"INSERT INTO comptes", ligne_compte(joueur_id=9, statut='linked', role='player')),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (0,)),
])
import auth_discord; importlib.reload(auth_discord)
auth_discord.login('c', None, 'UA')
check("connexion ordinaire : aucune session fermee (A-06 inchange)",
      not fermetures(cur), fermetures(cur))


# ===========================================================================
print("\n=== 3. Frontend : purger le jeton, relancer la connexion ===")
# ===========================================================================
_fp = lire(FRONT, 'frontend.py')
_fns = fonctions(_fp)
_purge = _fns.get('_session_fermee_par_changement_de_role', '')
check("le helper purge le jeton ET la copie du compte",
      "session.pop('player_token'" in _purge and "session.pop('compte'" in _purge)
check("  et depose un message, pour que la deconnexion ne se lise pas comme une panne",
      'flash(' in _purge)
# Pas de `admin_token` : c'est le mot de passe partage, sans lien avec le
# compte, et il disparait avec l'etape 6.
check("le proxy d'acceptation purge sur `session_fermee`",
      "_session_fermee_par_changement_de_role(" in _fns.get('repondre_promotion', '')
      and "session_fermee" in _fns.get('repondre_promotion', ''))
check("le proxy du legs aussi (l'ancien superadmin change de role)",
      "_session_fermee_par_changement_de_role(" in _fns.get('proxy_leguer_superadmin', '')
      and "session_fermee" in _fns.get('proxy_leguer_superadmin', ''))

_mc = lire(FRONT, 'templates', 'mon_compte.html')
_carte = entre(_mc, 'function afficherProposition', 'function afficherConsentement')
check("la carte d'acceptation PREVIENT avant le clic",
      'déconnecte de tous vos appareils' in _carte, _carte[:80])
_accepter = entre(_carte, "bouton('Accepter le rôle'", "bouton('Refuser'")
check("accepter relance la connexion Discord au lieu de recharger une page morte",
      'session_fermee' in _accepter and "'/auth/discord/login'" in _accepter)

_ac = lire(FRONT, 'templates', 'admin_comptes.html')
_legs = entre(_ac, 'async function leguerSuperadmin', 'async function supprimerCompte')
check("le legs previent de la reconnexion avant le clic",
      'reconnecté par Discord' in _legs)
check("et relance la connexion Discord une fois fait",
      "'/auth/discord/login'" in _legs)
_selecteur = entre(_ac, "const promotion = RANGS[sel.value] > RANGS[c.role]", "const corps = {role: sel.value}")
check("la retrogradation previent que les sessions de la cible seront fermees",
      'sessions' in _selecteur)

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
