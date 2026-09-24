"""Routes de la hierarchie admin : roles, permissions a la carte, legs.

Complement de test_permissions.py, qui couvre les decorateurs. Ici ce sont les
ROUTES : changer_role reecrite, l'octroi/retrait de permissions, et surtout le
legs du superadmin -- le geste le plus irreversible du systeme, et celui dont
un echec a mi-chemin laisserait la base sans superadmin ou avec deux.

Limite assumee du banc d'essai : FakeCursor ne simule ni contrainte SQL, ni
verrou, ni rollback reel. Ces tests verifient QUI passe, QUELLES requetes
partent et DANS QUEL ORDRE -- pas que Postgres tienne ses promesses. L'unicite
du superadmin se verifie sur une vraie base.
"""
from harness import *
from flask import Flask


def monter(plan, role='superadmin', compte_id=1):
    """Monte le blueprint des comptes avec une session au role voulu."""
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
# Le legs lit DEUX lignes d'un coup : (id, role, discord_username,
# cgu_admin_version). La version sert au consentement de la cible (R-68).
DEUX_LIGNES = lambda acteur, cible: (
    r"SELECT id, role, discord_username, cgu_admin_version\s+FROM comptes WHERE id IN",
    [acteur, cible])

sql_de = lambda cur: [s for s, _ in cur.executed]


# ===========================================================================
print("\n=== changer_role : plafond selon l'acteur ===")
# ===========================================================================

# Un chef_admin ne designe pas un pair : seul le superadmin le fait (2, contrainte 3).
cli, cur, conn = monter([CIBLE('admin')], role='chef_admin')
r = cli.post('/admin/comptes/5/role', json={'role': 'chef_admin'}, headers=H)
check("chef_admin ne peut pas créer un chef_admin -> 403",
      r.status_code == 403 and r.get_json()['code'] == 'droits_insuffisants', r.get_json())
check("  aucune écriture", not any('UPDATE comptes SET role' in s for s in sql_de(cur)))

# Le superadmin non plus ne designe pas un chef_admin PAR CETTE ROUTE : il le
# propose (R-68, section suivante). Le plafond ci-dessus reste le premier refus
# pour un chef_admin, avant toute I/O.
cli, cur, conn = monter([CIBLE('admin')], role='superadmin')
r = cli.post('/admin/comptes/5/role', json={'role': 'chef_admin'}, headers=H)
check("le superadmin ne pose pas non plus chef_admin par /role -> 409",
      r.status_code == 409 and r.get_json()['code'] == 'promotion_par_proposition',
      r.get_json())

# Le role superadmin ne s'attribue pas : il se legue (6bis).
for role in ('superadmin', 'chef_admin'):
    cli, cur, conn = monter([CIBLE('admin')], role=role)
    r = cli.post('/admin/comptes/5/role', json={'role': 'superadmin'}, headers=H)
    check("%s ne peut pas ATTRIBUER superadmin -> 400" % role,
          r.status_code == 400 and r.get_json()['code'] == 'superadmin_non_attribuable',
          r.get_json())

# Auto-modification interdite, superadmin compris (2, contrainte 4).
cli, cur, conn = monter([CIBLE('superadmin')], role='superadmin', compte_id=5)
r = cli.post('/admin/comptes/5/role', json={'role': 'chef_admin'}, headers=H)
check("le superadmin ne peut pas changer SON PROPRE rôle -> 403",
      r.status_code == 403 and r.get_json()['code'] == 'auto_modification', r.get_json())

# Role inconnu : refuse avant toute I/O.
cli, cur, conn = monter([CIBLE('admin')], role='superadmin')
r = cli.post('/admin/comptes/5/role', json={'role': 'root'}, headers=H)
check("rôle hors hiérarchie -> 400",
      r.status_code == 400 and r.get_json()['code'] == 'role_invalide', r.get_json())


# ===========================================================================
print("\n=== R-68 : changer_role ne promeut plus, il ne fait que descendre ===")
# ===========================================================================
# Le consentement prealable a la tracabilite nominative est un argument RGPD :
# toute montee en rang passe par /promotion, posee a l'acceptation. Avant le
# 23/09, seule l'IHM routait ainsi -- un POST a la main sur /role promouvait
# sans rien demander.

for acteur, ancien, nouveau in (('superadmin', 'player', 'admin'),
                                ('superadmin', 'player', 'chef_admin'),
                                ('superadmin', 'admin', 'chef_admin'),
                                ('chef_admin', 'player', 'admin')):
    cli, cur, conn = monter([CIBLE(ancien)], role=acteur)
    r = cli.post('/admin/comptes/5/role', json={'role': nouveau}, headers=H)
    check("%s : %s -> %s par /role refusé (409 promotion_par_proposition)"
          % (acteur, ancien, nouveau),
          r.status_code == 409 and r.get_json()['code'] == 'promotion_par_proposition',
          r.get_json())
    check("  aucune écriture du rôle, aucune session fermée, aucun audit",
          not any('UPDATE comptes SET role' in s or 'DELETE FROM sessions_joueurs' in s
                  or 'INSERT INTO audit_admin' in s for s in sql_de(cur)))
    check("  transaction annulée", conn.rolledback)

# Le refus se decide sur le role LU SOUS VERROU, pas sur ce que l'IHM croyait :
# une cible retrogradee entre l'affichage et le clic est bien une promotion.
cli, cur, conn = monter([CIBLE('player')], role='superadmin')
cli.post('/admin/comptes/5/role', json={'role': 'admin'}, headers=H)
# (La premiere lecture sans verrou est celle de compte_cible_protegee.)
_lecture = [s for s in sql_de(cur) if 'SELECT role FROM comptes WHERE id' in s]
check("  le rôle actuel est lu FOR UPDATE avant de juger",
      any('FOR UPDATE' in l for l in _lecture), _lecture)

# Les descentes, elles, passent toutes.
for acteur, ancien, nouveau in (('superadmin', 'chef_admin', 'admin'),
                                ('superadmin', 'chef_admin', 'player'),
                                ('superadmin', 'admin', 'player'),
                                ('chef_admin', 'admin', 'player')):
    cli, cur, conn = monter([
        CIBLE(ancien),
        (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (2,)),
    ], role=acteur)
    r = cli.post('/admin/comptes/5/role', json={'role': nouveau}, headers=H)
    check("%s : %s -> %s par /role -> 200" % (acteur, ancien, nouveau),
          r.status_code == 200 and r.get_json().get('role') == nouveau, r.get_json())
    check("  audité en role_retire",
          any('role_retire' in str(p) for s, p in cur.executed
              if 'INSERT INTO audit_admin' in s))


# ===========================================================================
print("\n=== R-53 : purge des permissions à la sortie du rôle admin ===")
# ===========================================================================

cli, cur, conn = monter([CIBLE('admin')], role='superadmin')
r = cli.post('/admin/comptes/5/role', json={'role': 'player'}, headers=H)
check("admin -> player : 200", r.status_code == 200, r.get_json())
check("  permissions purgées", any('DELETE FROM permissions_admin' in s for s in sql_de(cur)))
check("  purge auditée", any("permissions_purgees" in str(p) for _, p in cur.executed))

# Une purge sans effet ne doit pas ecrire de ligne d'audit mensongere.
cli, cur, conn = monter([
    CIBLE('admin'),
    (r"DELETE FROM permissions_admin", ROWCOUNT_ZERO),
], role='superadmin')
cli.post('/admin/comptes/5/role', json={'role': 'player'}, headers=H)
check("aucune ligne d'audit si rien n'était à purger",
      not any("permissions_purgees" in str(p) for _, p in cur.executed))

# Un chef_admin ramene a admin n'avait pas de permissions a la carte (son
# socle EST le catalogue) : rien a purger. La purge ne vise que la SORTIE du
# role admin. (L'ancien cas « player -> admin » passe par /promotion, R-68.)
cli, cur, conn = monter([
    CIBLE('chef_admin'),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (2,)),
], role='superadmin')
cli.post('/admin/comptes/5/role', json={'role': 'admin'}, headers=H)
check("chef_admin -> admin : pas de purge",
      not any('DELETE FROM permissions_admin' in s for s in sql_de(cur)))


# ===========================================================================
print("\n=== R-60 : le dernier chef_admin ===")
# ===========================================================================

cli, cur, conn = monter([
    CIBLE('chef_admin'),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (0,)),
], role='superadmin')
r = cli.post('/admin/comptes/5/role', json={'role': 'admin'}, headers=H)
check("rétrograder le DERNIER chef_admin sans confirmer -> 409",
      r.status_code == 409 and r.get_json()['code'] == 'dernier_chef_admin', r.get_json())
check("  aucune écriture", not any('UPDATE comptes SET role' in s for s in sql_de(cur)))

cli, cur, conn = monter([
    CIBLE('chef_admin'),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (0,)),
], role='superadmin')
r = cli.post('/admin/comptes/5/role',
             json={'role': 'admin', 'confirmer_dernier_chef_admin': True}, headers=H)
check("avec la confirmation explicite -> 200", r.status_code == 200, r.get_json())

# La confirmation doit valoir True, pas « quelque chose de vrai ».
cli, cur, conn = monter([
    CIBLE('chef_admin'),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (0,)),
], role='superadmin')
r = cli.post('/admin/comptes/5/role',
             json={'role': 'admin', 'confirmer_dernier_chef_admin': 'oui'}, headers=H)
check("une confirmation non booléenne ne suffit pas -> 409", r.status_code == 409, r.status_code)

# S'il en reste un autre, aucune confirmation n'est demandee.
cli, cur, conn = monter([
    CIBLE('chef_admin'),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (2,)),
], role='superadmin')
r = cli.post('/admin/comptes/5/role', json={'role': 'admin'}, headers=H)
check("s'il reste d'autres chef_admin -> 200 sans confirmation", r.status_code == 200, r.get_json())


# ===========================================================================
print("\n=== Permissions à la carte : octroi ===")
# ===========================================================================

cli, cur, conn = monter([CIBLE('admin')], role='chef_admin')
r = cli.post('/admin/comptes/5/permissions/gestion_saisons', headers=H)
check("chef_admin accorde une permission -> 200", r.status_code == 200, r.get_json())
check("  INSERT idempotent (ON CONFLICT DO NOTHING)",
      any('ON CONFLICT' in s for s in sql_de(cur)))
check("  R-49 : accorde_par vient de la session, pas du corps",
      any(p and 1 in p for s, p in cur.executed if 'INSERT INTO permissions_admin' in s))
check("  octroi audité", any("permission_accordee" in str(p) for _, p in cur.executed))

# Deuxieme octroi identique : idempotent, signale comme inchange.
cli, cur, conn = monter([
    CIBLE('admin'),
    (r"INSERT INTO permissions_admin", ROWCOUNT_ZERO),
], role='chef_admin')
r = cli.post('/admin/comptes/5/permissions/gestion_saisons', headers=H)
check("accorder deux fois -> 200 'inchange'",
      r.status_code == 200 and r.get_json().get('inchange') is True, r.get_json())
check("  pas d'audit trompeur", not any("permission_accordee" in str(p) for _, p in cur.executed))

# Hors catalogue : refuse avant toute I/O.
cli, cur, conn = monter([CIBLE('admin')], role='chef_admin')
r = cli.post('/admin/comptes/5/permissions/gestion_inexistante', headers=H)
check("permission hors catalogue -> 400",
      r.status_code == 400 and r.get_json()['code'] == 'permission_inconnue', r.get_json())

# Les permissions n'ont de sens que sur un admin.
for role_cible in ('player', 'chef_admin'):
    cli, cur, conn = monter([CIBLE(role_cible)], role='superadmin')
    r = cli.post('/admin/comptes/5/permissions/gestion_saisons', headers=H)
    check("cible %s -> 409 (les permissions vont aux admin)" % role_cible,
          r.status_code == 409 and r.get_json()['code'] == 'cible_non_admin', r.get_json())

# Auto-octroi interdit.
cli, cur, conn = monter([CIBLE('admin')], role='chef_admin', compte_id=5)
r = cli.post('/admin/comptes/5/permissions/gestion_saisons', headers=H)
check("s'accorder une permission à soi-même -> 403",
      r.status_code == 403 and r.get_json()['code'] == 'auto_modification', r.get_json())

# Un admin, meme avec gestion_comptes, n'accorde rien : role_required(chef_admin).
cli, cur, conn = monter([CIBLE('admin')], role='admin')
r = cli.post('/admin/comptes/5/permissions/gestion_saisons', headers=H)
check("un admin ne peut accorder aucune permission -> 403", r.status_code == 403, r.status_code)


# ===========================================================================
print("\n=== Permissions à la carte : retrait ===")
# ===========================================================================

cli, cur, conn = monter([], role='chef_admin')
r = cli.delete('/admin/comptes/5/permissions/gestion_saisons', headers=H)
check("retrait -> 200", r.status_code == 200, r.get_json())
check("  DELETE, pas un drapeau", any('DELETE FROM permissions_admin' in s for s in sql_de(cur)))
check("  retrait audité", any("permission_retiree" in str(p) for _, p in cur.executed))

cli, cur, conn = monter([(r"DELETE FROM permissions_admin", ROWCOUNT_ZERO)], role='chef_admin')
r = cli.delete('/admin/comptes/5/permissions/gestion_saisons', headers=H)
check("retirer un droit absent -> 200 'inchange'",
      r.status_code == 200 and r.get_json().get('inchange') is True, r.get_json())
check("  pas d'audit trompeur", not any("permission_retiree" in str(p) for _, p in cur.executed))

# compte_cible_protegee s'applique aussi au retrait.
cli, cur, conn = monter([CIBLE('superadmin')], role='chef_admin')
r = cli.delete('/admin/comptes/5/permissions/gestion_saisons', headers=H)
check("retirer une permission au superadmin -> 403",
      r.status_code == 403 and r.get_json()['code'] == 'cible_protegee', r.get_json())


# ===========================================================================
print("\n=== Lecture des permissions ===")
# ===========================================================================

cli, cur, conn = monter([
    (r"SELECT role FROM comptes WHERE id", ('admin',)),
    (r"SELECT permission FROM permissions_admin", [('gestion_saisons',), ('gestion_ligues',)]),
], role='chef_admin')
r = cli.get('/admin/comptes/5/permissions', headers=H)
d = r.get_json()
check("lecture -> 200", r.status_code == 200, d)
check("  permissions accordées listées",
      d.get('permissions') == ['gestion_saisons', 'gestion_ligues'], d.get('permissions'))
# Compare au catalogue plutot qu'a un compte en dur : le socle d'un chef_admin
# EST le catalogue, et un nombre fige cassait ce test a chaque ajout de
# permission sans rien reveler d'autre que sa propre obsolescence.
from constants import PERMISSIONS_CATALOGUE as _CATALOGUE
check("  plafond de l'acteur exposé pour l'IHM",
      set(d.get('delegables') or []) == set(_CATALOGUE), d.get('delegables'))

cli, cur, conn = monter([(r"SELECT role FROM comptes WHERE id", None)], role='chef_admin')
check("compte inexistant -> 404",
      cli.get('/admin/comptes/5/permissions', headers=H).status_code == 404)


# ===========================================================================
print("\n=== Legs du superadmin : les refus ===")
# ===========================================================================

# Seul le superadmin lègue.
for role in ('chef_admin', 'admin', 'player'):
    cli, cur, conn = monter([], role=role)
    r = cli.post('/admin/comptes/5/leguer-superadmin',
                 json={'confirmation_pseudo': 'cible'}, headers=H)
    check("%s ne peut pas léguer -> 403" % role, r.status_code == 403, r.status_code)

# Auto-legs : refuse avant toute I/O (R-57).
cli, cur, conn = monter([], role='superadmin', compte_id=5)
r = cli.post('/admin/comptes/5/leguer-superadmin',
             json={'confirmation_pseudo': 'chef'}, headers=H)
check("se léguer à soi-même -> 403",
      r.status_code == 403 and r.get_json()['code'] == 'auto_modification', r.get_json())
check("  aucune requête de legs partie",
      not any('WHERE id IN' in s for s in sql_de(cur)))

# Cible inexistante.
cli, cur, conn = monter([
    (r"SELECT id, role, discord_username, cgu_admin_version\s+FROM comptes WHERE id IN",
     [(1, 'superadmin', 'chef', '1.0')]),
], role='superadmin')
r = cli.post('/admin/comptes/5/leguer-superadmin',
             json={'confirmation_pseudo': 'x'}, headers=H)
check("cible inexistante -> 404", r.status_code == 404, r.get_json())

# Confirmation : c'est discord_username qui fait foi, pas le nom affiche.
cli, cur, conn = monter([
    DEUX_LIGNES((1, 'superadmin', 'chef', '1.0'), (5, 'admin', 'vraipseudo', '1.0')),
], role='superadmin')
r = cli.post('/admin/comptes/5/leguer-superadmin',
             json={'confirmation_pseudo': 'Nom Affiche'}, headers=H)
check("pseudo de confirmation faux -> 400",
      r.status_code == 400 and r.get_json()['code'] == 'confirmation_invalide', r.get_json())
check("  aucune écriture du rôle",
      not any('UPDATE comptes SET role' in s for s in sql_de(cur)))

cli, cur, conn = monter([
    DEUX_LIGNES((1, 'superadmin', 'chef', '1.0'), (5, 'admin', 'vraipseudo', '1.0')),
], role='superadmin')
r = cli.post('/admin/comptes/5/leguer-superadmin', json={}, headers=H)
check("confirmation absente -> 400", r.status_code == 400, r.get_json())

# Course : l'acteur n'est plus superadmin au moment du verrou.
cli, cur, conn = monter([
    DEUX_LIGNES((1, 'chef_admin', 'chef', '1.0'), (5, 'admin', 'vraipseudo', '1.0')),
], role='superadmin')
r = cli.post('/admin/comptes/5/leguer-superadmin',
             json={'confirmation_pseudo': 'vraipseudo'}, headers=H)
check("rôle perdu entre-temps (double legs) -> 409",
      r.status_code == 409 and r.get_json()['code'] == 'plus_superadmin', r.get_json())


# ===========================================================================
print("\n=== Legs du superadmin : le cas nominal ===")
# ===========================================================================

cli, cur, conn = monter([
    DEUX_LIGNES((1, 'superadmin', 'chef', '1.0'), (5, 'chef_admin', 'vraipseudo', '1.0')),
], role='superadmin')
r = cli.post('/admin/comptes/5/leguer-superadmin',
             json={'confirmation_pseudo': 'vraipseudo'}, headers=H)
check("legs -> 200", r.status_code == 200, r.get_json())
check("  ancien et nouveau renvoyés",
      r.get_json().get('ancien') == 1 and r.get_json().get('nouveau') == 5, r.get_json())

ecritures = [(s, p) for s, p in cur.executed if 'UPDATE comptes SET role' in s]
check("  exactement deux écritures du rôle", len(ecritures) == 2, len(ecritures))
# ORDRE IMPOSE par l'index partiel non-deferrable (3.2) : l'inverse leve 23505.
check("  1. l'ancien est rétrogradé chef_admin D'ABORD",
      ecritures[0][1] == ('chef_admin', 1), ecritures[0][1])
check("  2. le nouveau est promu superadmin ENSUITE",
      ecritures[1][1] == ('superadmin', 5), ecritures[1][1])
check("  transaction validée", conn.committed)

# Un seul geste, donc une seule ligne d'audit (3.4).
audits = [p for s, p in cur.executed if 'INSERT INTO audit_admin' in s]
check("  une SEULE ligne d'audit", len(audits) == 1, len(audits))
check("  action 'superadmin_legue'", any('superadmin_legue' in str(p) for p in audits), audits)

# Verrou : une seule requete, bornes triees, pour ne pas s'interbloquer.
verrou = [(s, p) for s, p in cur.executed if 'WHERE id IN' in s]
check("  les deux lignes verrouillées en UNE requête", len(verrou) == 1, len(verrou))
check("  bornes triées par id (anti-interblocage)", verrou[0][1] == (1, 5), verrou[0][1])
check("  FOR UPDATE posé", 'FOR UPDATE' in verrou[0][0])

# R-53 s'applique aussi ici : une cible admin quitte le role admin.
cli, cur, conn = monter([
    DEUX_LIGNES((1, 'superadmin', 'chef', '1.0'), (5, 'admin', 'vraipseudo', '1.0')),
], role='superadmin')
cli.post('/admin/comptes/5/leguer-superadmin',
         json={'confirmation_pseudo': 'vraipseudo'}, headers=H)
check("cible admin : ses permissions sont purgées (R-53)",
      any('DELETE FROM permissions_admin' in s for s in sql_de(cur)))

# Une cible chef_admin n'a rien a purger.
cli, cur, conn = monter([
    DEUX_LIGNES((1, 'superadmin', 'chef', '1.0'), (5, 'chef_admin', 'vraipseudo', '1.0')),
], role='superadmin')
r = cli.post('/admin/comptes/5/leguer-superadmin',
             json={'confirmation_pseudo': 'vraipseudo'}, headers=H)
check("léguer à un chef_admin qui a consenti -> 200", r.status_code == 200, r.get_json())
check("  aucune purge inutile",
      not any('DELETE FROM permissions_admin' in s for s in sql_de(cur)))


# ===========================================================================
print("\n=== Legs : la cible doit avoir consenti (R-68) ===")
# ===========================================================================
# Le plan 6bis (10/09) ouvrait le legs a tout compte, player compris -- avant
# que le consentement a la politique administrateur existe (18/09). Leguer a un
# player en faisait un superadmin trace sans qu'il ait rien accepte : le meme
# contournement que la promotion directe par /role.

for role_cible, version, motif in (
        ('player', None, "un player (n'a accepté aucun rôle)"),
        ('player', '1.0', "un player ayant consenti autrefois (n'a pas accepté CE rôle)"),
        ('admin', None, "un admin promu avant le consentement, jamais régularisé"),
        ('chef_admin', '0.9', "un chef_admin sur une version périmée de la politique")):
    cli, cur, conn = monter([
        DEUX_LIGNES((1, 'superadmin', 'chef', '1.0'), (5, role_cible, 'vraipseudo', version)),
    ], role='superadmin')
    r = cli.post('/admin/comptes/5/leguer-superadmin',
                 json={'confirmation_pseudo': 'vraipseudo'}, headers=H)
    check("léguer à %s -> 409 legs_sans_consentement" % motif,
          r.status_code == 409 and r.get_json()['code'] == 'legs_sans_consentement',
          r.get_json())
    check("  aucune écriture du rôle, aucune session fermée",
          not any('UPDATE comptes SET role' in s or 'DELETE FROM sessions_joueurs' in s
                  for s in sql_de(cur)))
    check("  transaction annulée", conn.rolledback)

# Le blocage est dit AVANT la confirmation : sinon le superadmin retaperait le
# pseudo pour rien, et lirait « pseudo faux » au lieu du vrai motif.
cli, cur, conn = monter([
    DEUX_LIGNES((1, 'superadmin', 'chef', '1.0'), (5, 'player', 'vraipseudo', None)),
], role='superadmin')
r = cli.post('/admin/comptes/5/leguer-superadmin',
             json={'confirmation_pseudo': 'mauvais'}, headers=H)
check("cible sans consentement ET pseudo faux : c'est le consentement qui est signalé",
      r.get_json().get('code') == 'legs_sans_consentement', r.get_json())

# Le consentement est lu dans la MEME requete verrouillee que le role.
verrou = [s for s in sql_de(cur) if 'WHERE id IN' in s]
check("  version de la politique lue sous le verrou du legs",
      len(verrou) == 1 and 'cgu_admin_version' in verrou[0] and 'FOR UPDATE' in verrou[0],
      verrou)


# ===========================================================================
print("\n=== Permissions exposées à l'interface ===")
# ===========================================================================
# Ces deux fonctions ne donnent aucun droit -- elles decident de ce que l'IHM
# AFFICHE. Une erreur ici ne cree pas de faille (le backend juge a chaque
# requete), mais fait disparaitre des onglets ou en montre d'inutiles.

install_db([])
recharger()
import importlib
import auth_discord; importlib.reload(auth_discord)
from constants import PERMISSIONS_CATALOGUE

class _CurPerm:
    """Curseur minimal : rend les permissions demandees, note les appels."""
    def __init__(self, lignes): self.lignes, self.appels = lignes, 0
    def execute(self, sql, params=None): self.appels += 1
    def fetchall(self): return self.lignes

for role in ('chef_admin', 'superadmin'):
    c = _CurPerm([])
    res = auth_discord._permissions_pour_session(c, {'id': 1, 'role': role})
    check("%s reçoit le catalogue entier" % role, set(res) == set(PERMISSIONS_CATALOGUE), res)
    check("  sans interroger permissions_admin", c.appels == 0, c.appels)

c = _CurPerm([('gestion_saisons',), ('gestion_ligues',)])
res = auth_discord._permissions_pour_session(c, {'id': 1, 'role': 'admin'})
check("admin : ses lignes accordées, triées",
      res == ['gestion_ligues', 'gestion_saisons'], res)

c = _CurPerm([])
res = auth_discord._permissions_pour_session(c, {'id': 1, 'role': 'admin'})
check("admin sans permission : liste vide, jamais None", res == [], res)

for role in ('player', ''):
    c = _CurPerm([('gestion_saisons',)])
    res = auth_discord._permissions_pour_session(c, {'id': 1, 'role': role})
    check("rôle '%s' n'a rien, même si des lignes traînent" % role, res == [], res)
    check("  sans interroger permissions_admin", c.appels == 0, c.appels)

# Meme regle cote /auth/me, avec sa propre connexion.
cur, conn = install_db([(r"SELECT permission FROM permissions_admin",
                         [('gestion_config',)])])
recharger()
import routes_auth; importlib.reload(routes_auth)
check("/auth/me : chef_admin -> catalogue entier",
      routes_auth._permissions_effectives({'id': 1, 'role': 'chef_admin'})
      == set(PERMISSIONS_CATALOGUE))
check("/auth/me : admin -> ses lignes",
      routes_auth._permissions_effectives({'id': 1, 'role': 'admin'}) == {'gestion_config'})
check("/auth/me : player -> rien",
      routes_auth._permissions_effectives({'id': 1, 'role': 'player'}) == set())

# Base injoignable : l'affichage se degrade, il ne s'ouvre pas.
import contextlib, types
_fake = types.ModuleType('db')
@contextlib.contextmanager
def _boom():
    raise RuntimeError("base injoignable")
    yield
_fake.get_db_connection = _boom
_fake.ADMIN_PASSWORD_HASH = b'x'
sys.modules['db'] = _fake
recharger()
import routes_auth as _ra; importlib.reload(_ra)
check("panne DB : aucune permission exposée, pas de plantage",
      _ra._permissions_effectives({'id': 1, 'role': 'admin'}) == set())


print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
