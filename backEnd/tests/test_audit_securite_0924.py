"""Constats de docs/audit-securite-2026-09-24.md -- ce qui se passe ENTRE deux gestes.

L'audit n'a rien trouve dans les decorateurs. Ce qu'il a trouve, c'est un etat
qui survit a ce qui aurait du l'annuler :

  S-02  une proposition de role survit a la retrogradation, a la suspension
        et au depart du proposant ;
  S-03  legs + proposition en attente : le nouveau superadmin se retrogradait
        seul en l'acceptant, zero superadmin ;
  S-04  approuver une demande de liaison levait la suspension du compte ;
  S-13  un admin approuvait sa propre demande de liaison ;
  S-14  un chef_admin annulait une proposition faite par le superadmin.

Et, corriges le meme jour :

  S-01  un nom de joueur ou de ligue s'executait dans un onclick (test statique
        sur tout le frontend) ;
  S-06  le consentement s'enregistrait a l'inscription sans geste reel ;
  S-08  les invitations n'avaient ni plafond de duree ni d'usages ;
  S-11  la regle de rang ne protegeait pas la FICHE d'un compte (decision du
        25/09 : la hierarchie s'applique partout, dossier sportif compris).

Curseur scripte, comme partout ici : on verifie qui passe, quelles requetes
partent et dans quel ordre -- pas que Postgres tienne ses verrous.
"""
from harness import *
from flask import Flask


def monter(plan, role='superadmin', compte_id=1):
    plan = list(plan) + [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=compte_id, discord_id='111', username='moi',
                       global_name='Moi', role=role)),
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
# Version courante de la politique admin : lue, pas recopiee, pour que le
# prochain changement de version ne casse pas ces tests.
from constants import CGU_ADMIN_VERSION as V_ADMIN
ACCEPTER = {'accepte': True, 'cgu_admin_version': V_ADMIN}
sql_de = lambda cur: [s for s, _ in cur.executed]
annulations = lambda cur: [(s, p) for s, p in cur.executed
                           if "UPDATE promotions_proposees SET statut = 'cancelled'" in s]
audits = lambda cur: [p for s, p in cur.executed if 'INSERT INTO audit_admin' in s]


def accepter(role_actuel, role_propose, proposant_id, proposant):
    """Le titulaire (compte 5) accepte une proposition faite par `proposant_id`.

    `proposant` : (role, statut) relu a l'acceptation, ou None s'il n'existe plus.
    """
    cli, cur, conn = monter([
        (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", (role_actuel,)),
        (r"FROM promotions_proposees WHERE compte_id",
         (7, role_propose, proposant_id, PASSE, FUTUR)),
        (r"SELECT role, statut FROM comptes WHERE id = %s$", proposant),
    ], role=role_actuel, compte_id=5)
    r = cli.post('/me/promotion', json=ACCEPTER, headers=H)
    return r, cur, conn


def caduque(r, cur, conn):
    return (r.status_code == 409
            and (r.get_json() or {}).get('code') == 'proposition_caduque')


# ===========================================================================
print("\n=== S-02 : le droit de proposer est reverifie a l'acceptation ===")
# ===========================================================================

# Scenario 3 de l'audit : le chef_admin C propose admin, puis est retrograde.
r, cur, conn = accepter('player', 'admin', 3, ('admin', 'linked'))
check("proposant retrograde admin -> 409 proposition_caduque", caduque(r, cur, conn), r.get_json())
check("  aucun role n'est pose", not any('SET role' in s for s in sql_de(cur)))
check("  la proposition est soldee en 'cancelled'",
      any("statut = 'cancelled'" in s for s in sql_de(cur)))
check("  et c'est VALIDE (commit), pour qu'elle ne se retente pas", conn.committed)
check("  l'annulation est tracee avec son motif",
      any('proposant_sans_droit' in str(p) for p in audits(cur)), audits(cur))

r, cur, conn = accepter('player', 'admin', 3, ('chef_admin', 'suspended'))
check("proposant suspendu -> 409", caduque(r, cur, conn), r.get_json())

# Proposant supprime : propose_par passe a NULL. Plus rien a verifier.
r, cur, conn = accepter('player', 'admin', None, None)
check("proposant supprime (propose_par NULL) -> 409", caduque(r, cur, conn), r.get_json())
check("  sans chercher a relire un compte NULL",
      not any(s.startswith('SELECT role, statut FROM comptes') for s in sql_de(cur)))

# chef_admin ne propose pas chef_admin : seul le superadmin le peut. Un ancien
# superadmin devenu chef_admin par legs perd donc ses propositions de ce role.
r, cur, conn = accepter('admin', 'chef_admin', 1, ('chef_admin', 'linked'))
check("proposition chef_admin d'un proposant devenu chef_admin -> 409",
      caduque(r, cur, conn), r.get_json())

# NON-REGRESSION : sans ces deux-la, un refus general passerait pour correct.
r, cur, conn = accepter('player', 'admin', 3, ('chef_admin', 'linked'))
check("NON-REGRESSION : proposant chef_admin toujours en poste -> 200",
      r.status_code == 200, r.get_json())
r, cur, conn = accepter('admin', 'chef_admin', 1, ('superadmin', 'linked'))
check("NON-REGRESSION : chef_admin propose par le superadmin -> 200",
      r.status_code == 200, r.get_json())

# Le refus n'a rien a verifier : refuser ne donne aucun droit.
cli, cur, conn = monter([
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('player',)),
    (r"FROM promotions_proposees WHERE compte_id", (7, 'admin', None, PASSE, FUTUR)),
], role='player', compte_id=5)
r = cli.post('/me/promotion', json={'accepte': False}, headers=H)
check("refuser la proposition d'un proposant parti reste possible -> 200",
      r.status_code == 200, r.get_json())


# ===========================================================================
print("\n=== S-03 : accepter doit rester une MONTEE (jamais zero superadmin) ===")
# ===========================================================================

# Le superadmin S propose chef_admin a T, puis lui legue. T, superadmin,
# accepte la vieille proposition : sans garde, il redescendait chef_admin.
r, cur, conn = accepter('superadmin', 'chef_admin', 1, ('superadmin', 'linked'))
check("superadmin qui accepte chef_admin -> 409, meme d'un proposant valide",
      caduque(r, cur, conn), r.get_json())
check("  AUCUNE ecriture de comptes.role", not any('SET role' in s for s in sql_de(cur)))
check("  motif : plus_une_promotion",
      any('plus_une_promotion' in str(p) for p in audits(cur)), audits(cur))

r, cur, conn = accepter('chef_admin', 'admin', 1, ('superadmin', 'linked'))
check("chef_admin qui accepte admin (descente) -> 409", caduque(r, cur, conn), r.get_json())

r, cur, conn = accepter('admin', 'admin', 1, ('superadmin', 'linked'))
check("accepter le role deja porte -> 409", caduque(r, cur, conn), r.get_json())

r, cur, conn = accepter('role_inconnu', 'chef_admin', 1, ('superadmin', 'linked'))
check("role actuel inconnu -> 409 (defaut ferme)", caduque(r, cur, conn), r.get_json())


# ===========================================================================
print("\n=== S-02 : les gestes qui changent la situation soldent les propositions ===")
# ===========================================================================
UNE_ANNULEE = (r"UPDATE promotions_proposees SET statut = 'cancelled'", [(7, 2, 'chef_admin')])

# Retrogradation : scenario 1 de l'audit.
cli, cur, conn = monter([
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('admin',)),
    (r"SELECT role FROM comptes WHERE id", ('admin',)),
    UNE_ANNULEE,
], role='superadmin')
r = cli.post('/admin/comptes/2/role', json={'role': 'player'}, headers=H)
a = annulations(cur)
check("retrograder -> 200", r.status_code == 200, r.get_json())
check("  les propositions RECUES par la cible sont soldees",
      any('compte_id = %s' in s and p == (2,) for s, p in a), a)
check("  et celles qu'elle a FAITES aussi",
      any('propose_par = %s' in s and p == (2,) for s, p in a), a)
check("  chaque annulation est tracee avec son motif",
      any('cible_retrogradee' in str(p) for p in audits(cur))
      and any('proposant_retrograde' in str(p) for p in audits(cur)), audits(cur))
check("  jamais les propositions expirees (elles n'engagent deja plus rien)",
      all('expires_at > now()' in s for s, _ in a), a)

# Suspension : scenario 2.
cli, cur, conn = monter([
    (r"SELECT statut, role, joueur_id FROM comptes WHERE id = %s FOR UPDATE",
     ('linked', 'admin', 9)),
    (r"SELECT role FROM comptes WHERE id", ('admin',)),
], role='superadmin')
r = cli.post('/admin/comptes/2/statut', json={'statut': 'suspended'}, headers=H)
a = annulations(cur)
check("suspendre -> 200", r.status_code == 200, r.get_json())
check("  propositions recues ET faites soldees",
      any('compte_id = %s' in s for s, _ in a) and any('propose_par = %s' in s for s, _ in a), a)

cli, cur, conn = monter([
    (r"SELECT statut, role, joueur_id FROM comptes WHERE id = %s FOR UPDATE",
     ('suspended', 'admin', 9)),
    (r"SELECT role FROM comptes WHERE id", ('admin',)),
], role='superadmin')
r = cli.post('/admin/comptes/2/statut', json={'statut': 'actif'}, headers=H)
check("reactiver ne touche a aucune proposition",
      r.status_code == 200 and not annulations(cur), annulations(cur))

# Legs : S-03, la ceinture.
cli, cur, conn = monter([
    (r"SELECT id, role, discord_username, cgu_admin_version\s+FROM comptes WHERE id IN",
     [(1, 'superadmin', 'moi', V_ADMIN), (5, 'chef_admin', 'cible', V_ADMIN)]),
], role='superadmin')
r = cli.post('/admin/comptes/5/leguer-superadmin',
             json={'confirmation_pseudo': 'cible'}, headers=H)
a = annulations(cur)
check("legs -> 200", r.status_code == 200, r.get_json())
check("  les propositions en attente du NOUVEAU superadmin sont soldees",
      any('compte_id = %s' in s and p == (5,) for s, p in a), a)
check("  l'ancien, devenu chef_admin, perd ses propositions chef_admin",
      any('propose_par = %s' in s and 'role_propose = %s' in s and p == (1, 'chef_admin')
          for s, p in a), a)
check("  mais PAS ses propositions admin : un chef_admin peut toujours les faire",
      not any('propose_par = %s' in s and 'role_propose' not in s for s, _ in a), a)

# Suppression : les propositions faites resteraient affichees, a NULL.
cli, cur, conn = monter([
    (r"SELECT role, joueur_id, discord_id, discord_username FROM comptes WHERE id = %s FOR UPDATE",
     ('chef_admin', None, '123456789012345678', 'cible')),
    (r"SELECT role FROM comptes WHERE id", ('chef_admin',)),
], role='superadmin')
r = cli.delete('/admin/comptes/2', json={'confirmation_pseudo': 'cible'}, headers=H)
_s = sql_de(cur)
check("supprimer -> 200", r.status_code == 200, r.get_json())
check("  les propositions FAITES par le compte sont soldees avant sa disparition",
      any('propose_par = %s' in s for s, _ in annulations(cur))
      and max(i for i, s in enumerate(_s) if "statut = 'cancelled'" in s)
      < _s.index('DELETE FROM comptes WHERE id = %s'), _s)

# Garde-fou du helper : un UPDATE sans filtre de compte solderait toute la table.
import routes_comptes
try:
    routes_comptes._annuler_promotions(cur, 'test')
    check("_annuler_promotions sans cible ni proposant leve", False)
except ValueError:
    check("_annuler_promotions sans cible ni proposant leve", True)


# ===========================================================================
print("\n=== S-04 : approuver une liaison ne leve pas une suspension ===")
# ===========================================================================

def approuver(statut_compte, acteur=1, role_cible='player', role_acteur='chef_admin'):
    cli, cur, conn = monter([
        (r"FROM liaisons_demandes d WHERE d.id", (5, 9, 'pending', None)),
        (r"SELECT statut, role FROM comptes WHERE id = %s FOR UPDATE",
         (statut_compte, role_cible)),
        (r"SELECT nom FROM joueurs WHERE id", ('Mario',)),
        (r"SELECT id FROM comptes WHERE joueur_id = %s FOR UPDATE", None),
        (r"SELECT 1 FROM permissions_admin", (1,)),     # gestion_liaisons, pour un admin
    ], role=role_acteur, compte_id=acteur)
    return cli.post('/admin/liaisons/1/approve', headers=H), cur, conn

r, cur, conn = approuver('suspended')
check("approuver la demande d'un compte suspendu -> 409 compte_suspendu",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'compte_suspendu',
      r.get_json())
check("  le compte n'est PAS repasse en 'linked'",
      not any("statut = 'linked'" in s for s in sql_de(cur)))
check("  la demande reste en attente (rien n'est ecrit)",
      not any('UPDATE liaisons_demandes' in s for s in sql_de(cur)))
check("  le statut est lu SOUS verrou",
      any(s == 'SELECT statut, role FROM comptes WHERE id = %s FOR UPDATE' for s in sql_de(cur)))

r, cur, conn = approuver('pending')
check("NON-REGRESSION : compte non suspendu -> 200", r.status_code == 200, r.get_json())


# ===========================================================================
print("\n=== S-13 : on ne statue pas sur sa propre demande de liaison ===")
# ===========================================================================

r, cur, conn = approuver('pending', acteur=5)
check("approuver SA propre demande -> 403 auto_modification",
      r.status_code == 403 and (r.get_json() or {}).get('code') == 'auto_modification',
      r.get_json())
check("  aucun rattachement", not any('SET joueur_id' in s for s in sql_de(cur)))

cli, cur, conn = monter([
    (r"SELECT compte_id, joueur_id, statut FROM liaisons_demandes", (5, 9, 'pending')),
], role='chef_admin', compte_id=5)
r = cli.post('/admin/liaisons/1/reject', json={}, headers=H)
check("refuser SA propre demande -> 403 (symetrie)",
      r.status_code == 403 and (r.get_json() or {}).get('code') == 'auto_modification',
      r.get_json())

# Exception du superadmin : S-13 + S-11 l'enfermaient -- lui ne statue pas sur
# soi, et personne n'a de rang superieur au sien pour le faire.
r, cur, conn = approuver('pending', acteur=5, role_cible='superadmin', role_acteur='superadmin')
check("le superadmin approuve SA propre demande -> 200", r.status_code == 200, r.get_json())
check("  le compte est rattache", any('SET joueur_id' in s for s in sql_de(cur)))
check("  le journal le marque sur_soi",
      any('"sur_soi": true' in str(p) or "'sur_soi': True" in str(p) for p in audits(cur)),
      audits(cur))

cli, cur, conn = monter([
    (r"SELECT compte_id, joueur_id, statut FROM liaisons_demandes", (5, 9, 'pending')),
    (r"SELECT role FROM comptes WHERE id", ('superadmin',)),
], role='superadmin', compte_id=5)
r = cli.post('/admin/liaisons/1/reject', json={}, headers=H)
check("le superadmin refuse SA propre demande -> 200", r.status_code == 200, r.get_json())

r, cur, conn = approuver('pending', acteur=1, role_cible='superadmin', role_acteur='superadmin')
check("NON-REGRESSION : un superadmin sur la demande d'un AUTRE superadmin -> 403 cible_protegee",
      r.status_code == 403 and (r.get_json() or {}).get('code') == 'cible_protegee',
      r.get_json())


# ===========================================================================
print("\n=== S-11 : la hierarchie protege aussi la FICHE d'un compte ===")
# ===========================================================================
# Decision du 25/09 : un admin ne touche ni aux autres admins ni a ses
# superieurs, un chef_admin pas a un pair -- dossier sportif compris.
import routes_admin


def monter_admin(plan, role, compte_id=1, permissions=()):
    plan = list(plan) + [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=compte_id, discord_id='111', username='moi',
                       global_name='Moi', role=role)),
        (r"SELECT 1 FROM permissions_admin",
         lambda params: (1,) if params and params[1] in permissions else None),
    ]
    cur, conn = install_db(plan)
    recharger()
    for m in ('routes_admin', 'routes_comptes', 'cache', 'services'):
        sys.modules.pop(m, None)
    import cache
    cache.invalidate_cache = lambda *a, **k: None
    import services
    services.recalculate_tiers = lambda: None
    import routes_admin
    # trueskill est neutralise par le harness : le formulaire de tournoi a besoin
    # d'un Rating pour aller au-dela du premier joueur. La valeur n'importe pas.
    routes_admin.trueskill.Rating = lambda mu=0, sigma=0: (mu, sigma)
    app = Flask(__name__)
    app.register_blueprint(routes_admin.admin_bp)
    return app.test_client(), cur, conn


# L'admin porte TOUS les droits de fiche : seul le rang peut le bloquer.
DROITS_FICHE = ('gestion_joueurs', 'joueurs_nom', 'joueurs_couleur', 'edition_mu_sigma',
                'joueurs_statut', 'joueurs_irreversible')
GESTES = [('PUT', '/admin/joueurs/9', {'nom': 'Autre'}),
          ('DELETE', '/admin/joueurs/9', None),
          ('POST', '/admin/joueurs/9/anonymiser', {})]


def geste(methode, url, corps, role_acteur, lien, compte_id=1):
    """`lien` : (id, role) du compte lie a la fiche 9, ou None."""
    cli, cur, conn = monter_admin([(r"SELECT id, role FROM comptes WHERE joueur_id", lien)],
                                  role_acteur, compte_id=compte_id,
                                  permissions=DROITS_FICHE)
    r = cli.open(url, method=methode, json=corps, headers=H)
    return r, cur


def refuse(r):
    return r.status_code == 403 and (r.get_json() or {}).get('code') == 'cible_protegee'


for methode, url, corps in GESTES:
    nom = '%s %s' % (methode, url)
    for acteur, cible in (('admin', 'admin'), ('admin', 'chef_admin'),
                          ('admin', 'superadmin'), ('chef_admin', 'chef_admin'),
                          ('chef_admin', 'superadmin')):
        r, cur = geste(methode, url, corps, acteur, (2, cible))
        check("%s : %s sur la fiche d'un %s -> 403" % (nom, acteur, cible), refuse(r),
              (r.status_code, r.get_json()))
        check("  rien n'est ecrit",
              not any(s.startswith(('UPDATE', 'DELETE', 'INSERT INTO noms_interdits'))
                      for s in sql_de(cur) if 'sessions_joueurs' not in s))
    # Portee legitime : ne doit PAS etre refusee par le rang (la route peut
    # repondre autre chose, 404 sur un curseur vide par exemple, peu importe ici).
    for acteur, lien in (('admin', (2, 'player')), ('admin', None),
                         ('chef_admin', (2, 'admin')), ('superadmin', (2, 'chef_admin')),
                         ('admin', (1, 'admin'))):
        r, cur = geste(methode, url, corps, acteur, lien)
        check("%s : %s sur %s -> pas de refus de rang" % (
                  nom, acteur, 'sa propre fiche' if lien == (1, 'admin')
                  else 'une fiche sans compte' if lien is None
                  else "la fiche d'un %s" % lien[1]),
              not refuse(r), (r.status_code, r.get_json()))

r, cur = geste('POST', '/admin/joueurs/9/anonymiser', {}, 'admin', (2, 'superadmin'))
check("le message dit que la fiche est celle du super-administrateur",
      'super-administrateur' in (r.get_json() or {}).get('error', ''), r.get_json())

# Les trois routes qui visent une fiche portent le decorateur.
_ra = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'routes_admin.py'),
           encoding='utf-8').read()
for _route in ("'/admin/joueurs/<int:id>', methods=['PUT']",
               "'/admin/joueurs/<int:id>', methods=['DELETE']",
               "'/admin/joueurs/<int:id>/anonymiser'"):
    _bloc = _ra[_ra.index(_route):]
    _bloc = _bloc[:_bloc.index('def ')]
    check("%s porte @fiche_cible_protegee" % _route, '@fiche_cible_protegee' in _bloc)

# Liaisons : la route recoit l'id de la DEMANDE, la regle est posee a la main.
r, cur, conn = approuver('pending', role_cible='chef_admin', role_acteur='chef_admin')
check("approuver la liaison d'un PAIR chef_admin -> 403", refuse(r), r.get_json())
check("  aucun rattachement", not any('SET joueur_id' in s for s in sql_de(cur)))
r, cur, conn = approuver('pending', role_cible='admin', role_acteur='admin')
check("admin qui approuve la liaison d'un admin -> 403", refuse(r), r.get_json())
r, cur, conn = approuver('pending', role_cible='admin', role_acteur='chef_admin')
check("NON-REGRESSION : chef_admin approuve la liaison d'un admin -> 200",
      r.status_code == 200, r.get_json())

cli, cur, conn = monter([
    (r"SELECT compte_id, joueur_id, statut FROM liaisons_demandes", (5, 9, 'pending')),
    (r"SELECT role FROM comptes WHERE id = %s", ('superadmin',)),
], role='chef_admin', compte_id=1)
r = cli.post('/admin/liaisons/1/reject', json={}, headers=H)
check("refuser la liaison du superadmin -> 403", refuse(r), r.get_json())
check("  la demande n'est pas touchee",
      not any('UPDATE liaisons_demandes' in s for s in sql_de(cur)))


# Les ecrans grisent d'avance ce que les routes refuseraient : le drapeau vient
# du backend, meme calcul que la frontiere (hors_de_portee / refus_de_rang).
def _fiche(jid, compte_id, role):
    return (jid, 'N%d' % jid, 25.0, 8.3, 'U', True, 0, '#FFFFFF', None, None, None,
            'pseudo' if compte_id else None, 'linked' if compte_id else None,
            compte_id, role)

cli, cur, conn = monter_admin([(r"FROM Joueurs j", [
    _fiche(1, None, None), _fiche(2, 7, 'player'), _fiche(3, 8, 'admin'),
    _fiche(4, 9, 'superadmin'), _fiche(5, 1, 'admin')])], 'admin', permissions=DROITS_FICHE)
_l = {j['id']: j['protegee'] for j in (cli.get('/admin/joueurs', headers=H).get_json() or [])}
check("liste des fiches : protegee seulement pour un rang egal ou superieur",
      _l == {1: False, 2: False, 3: True, 4: True, 5: False}, _l)

def _demande(did, compte_id, role):
    return (did, 'pending', None, PASSE, None, compte_id, '111', 'u', 'U', None, 'pending',
            9, 'Mario', None, None, role)

cli, cur, conn = monter([(r"FROM liaisons_demandes d", [
    _demande(1, 7, 'player'), _demande(2, 8, 'chef_admin'), _demande(3, 1, 'chef_admin')])],
    role='chef_admin', compte_id=1)
_l = {d['id']: (d['hors_de_portee'], d['est_moi'])
      for d in (cli.get('/admin/liaisons', headers=H).get_json() or [])}
check("file des liaisons : hors_de_portee et est_moi exposes",
      _l == {1: (False, False), 2: (True, False), 3: (True, True)}, _l)

cli, cur, conn = monter([(r"FROM liaisons_demandes d", [
    _demande(1, 7, 'player'), _demande(3, 1, 'superadmin')])],
    role='superadmin', compte_id=1)
_l = {d['id']: (d['hors_de_portee'], d['est_moi'])
      for d in (cli.get('/admin/liaisons', headers=H).get_json() or [])}
check("file des liaisons : le superadmin n'a rien de grise sur SA demande",
      _l == {1: (False, False), 3: (False, False)}, _l)


# ===========================================================================
print("\n=== S-14 : un chef_admin ne defait pas une proposition du superadmin ===")
# ===========================================================================

def annuler(role_acteur, promo, role_proposant):
    cli, cur, conn = monter([
        (r"FROM promotions_proposees WHERE compte_id", promo),
        # Meme requete pour compte_cible_protegee (cible, player) et pour le
        # proposant : la premiere lecture sert la cible, la suivante le proposant.
        (r"SELECT role FROM comptes WHERE id = %s",
         lambda params: ('player',) if params == (2,) else (role_proposant,)),
    ], role=role_acteur, compte_id=3)
    return cli.delete('/admin/comptes/2/promotion', headers=H), cur

r, cur = annuler('chef_admin', (7, 'chef_admin', 1, PASSE, FUTUR), 'superadmin')
check("chef_admin annule une proposition du superadmin -> 403",
      r.status_code == 403
      and (r.get_json() or {}).get('code') == 'proposition_rang_superieur', r.get_json())
check("  la proposition n'est pas touchee",
      not any('UPDATE promotions_proposees' in s for s in sql_de(cur)))

r, cur = annuler('chef_admin', (7, 'admin', 4, PASSE, FUTUR), 'chef_admin')
check("chef_admin annule la proposition d'un PAIR -> 200", r.status_code == 200, r.get_json())

r, cur = annuler('chef_admin', (7, 'admin', None, PASSE, FUTUR), None)
check("proposant parti : l'annulation reste libre -> 200", r.status_code == 200, r.get_json())

r, cur = annuler('superadmin', (7, 'admin', 4, PASSE, FUTUR), 'chef_admin')
check("le superadmin annule la proposition d'un chef_admin -> 200",
      r.status_code == 200, r.get_json())


# ===========================================================================
print("\n=== S-08 : une invitation a une duree et un nombre d'usages plafonnes ===")
# ===========================================================================

def creer_invitation(corps):
    cur, conn = install_db([
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=1, discord_id='111', username='moi',
                       global_name='Moi', role='chef_admin')),
        (r"SELECT 1 FROM joueurs", (1,)),
        (r"INSERT INTO invitations", (12,)),
    ])
    recharger()
    sys.modules.pop('routes_auth', None)
    import routes_auth
    app = Flask(__name__)
    app.register_blueprint(routes_auth.auth_bp)
    return app.test_client().post('/admin/invitations', json=corps, headers=H), cur

hors_plafond = lambda r: (r.status_code == 400
                          and (r.get_json() or {}).get('code') == 'invitation_hors_plafond')

for corps, libelle in (({'max_uses': 51}, "51 usages"),
                       ({'max_uses': 10000, 'heures': 876000}, "10 000 usages sur 100 ans"),
                       ({'heures': 721}, "721 heures"),
                       ({'max_uses': 0}, "0 usage"),
                       ({'heures': 10 ** 12}, "une duree qui debordait timedelta (500)")):
    r, cur = creer_invitation(corps)
    check("%s -> 400 invitation_hors_plafond" % libelle, hors_plafond(r), (r.status_code, r.get_json()))
    check("  rien n'est insere", not any('INSERT INTO invitations' in s for s in sql_de(cur)))

r, cur = creer_invitation({'max_uses': 50, 'heures': 720})
check("pile au plafond (50 usages, 30 jours) -> 201", r.status_code == 201, r.get_json())
r, cur = creer_invitation({})
check("valeurs par defaut (1 usage, 72 h) -> 201", r.status_code == 201, r.get_json())

for jid in ('3', True, 3.5, [3]):
    r, cur = creer_invitation({'joueur_id': jid})
    check("joueur_id %r -> 400 (et non un 500 a la requete SQL)" % (jid,),
          r.status_code == 400, (r.status_code, r.get_json()))
r, cur = creer_invitation({'joueur_id': 3})
check("joueur_id entier -> 201", r.status_code == 201, r.get_json())


# ===========================================================================
print("\n=== S-06 : le consentement ne s'enregistre plus a l'inscription ===")
# ===========================================================================
# Le lien de la page d'invitation portait cgu=1 en dur ; la case ne faisait que
# le griser. Seul POST /me/cgu (page /consentement, jeton CSRF) l'ecrit desormais.
_RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
_lire = lambda *p: open(os.path.join(_RACINE, *p), encoding='utf-8').read()

import auth_discord
cur, conn = install_db([(r"INSERT INTO comptes", (42, '1', 'u', 'U', None, None,
                                                   'pending', 'player', None, None))])
compte = auth_discord.upsert_compte(cur, {'discord_id': '1', 'username': 'u',
                                          'global_name': 'U', 'avatar_hash': None})
_ins = [(s, p) for s, p in cur.executed if 'INSERT INTO comptes' in s]
check("un compte neuf nait SANS consentement (aucune colonne cgu_* a l'INSERT)",
      _ins and 'cgu_' not in _ins[0][0].split('VALUES')[0] and len(_ins[0][1]) == 5, _ins)
check("upsert_compte n'accepte plus de drapeau de consentement",
      'cgu_acceptee' not in _lire('backEnd', 'auth_discord.py'))
check("la route d'echange ne le relaie plus",
      'cgu_acceptee' not in _lire('backEnd', 'routes_auth.py'))
check("le frontend ne le transporte plus",
      'cgu_acceptee' not in _lire('frontEnd', 'frontend.py'))
_invite = _lire('frontEnd', 'templates', 'invite.html')
check("la page d'invitation ne porte plus cgu= dans son lien",
      "cgu=1)" not in _invite and "cgu=" not in _invite.split('{#')[0]
      + _invite.split('#}')[-1])
check("et annonce l'etape de consentement qui suit",
      '/confidentialite' in _invite)


# ===========================================================================
print("\n=== S-01 : aucune donnee textuelle dans un gestionnaire inline ===")
# ===========================================================================
# `onclick="f('${escapeHtml(nom).replace(/'/g, "\\'")}')"` : escapeHtml change
# `'` en `&#039;` AVANT le replace, qui ne trouve donc plus rien ; le navigateur
# redecode `&#039;` en lisant l'attribut, et l'apostrophe ferme la chaine. Un
# pseudo Discord suffisait a executer du code dans la page d'un admin.
#
# Regle verifiee : dans un attribut on*="..." construit par un gabarit JS, chaque
# ${...} est un identifiant numerique -- rien qui puisse porter du texte. Le
# texte se relit dans une table JS (joueursCharges, saisonsParId) ou passe par
# addEventListener.
import glob as _glob

_FRONT = os.path.join(_RACINE, 'frontEnd')
_fichiers = (_glob.glob(os.path.join(_FRONT, 'templates', '*.html'))
             + _glob.glob(os.path.join(_FRONT, 'static', 'js', '*.js')))
_ID_SUR = re.compile(r'^(Number\([\w.]+\)|[\w.]*[iI]d|index|i|idx)$')


def _gestionnaires_inline(src):
    """(position, contenu de chaque ${...}) des attributs on*="..." du source.

    Parcours a la main plutot qu'une regex : un ${...} peut contenir des
    guillemets (`${x ? "'" + y + "'" : 'null'}`), qui couperaient une regex
    `on\\w+="[^"]*"` au milieu de l'expression -- exactement la ou le defaut se
    cachait.
    """
    for m in re.finditer(r'\bon[a-z]+="', src):
        i, profondeur, debut, trouve = m.end(), 0, None, []
        while i < len(src):
            if profondeur == 0 and src.startswith('${', i):
                profondeur, debut, i = 1, i + 2, i + 2
                continue
            c = src[i]
            if profondeur:
                if c == '{':
                    profondeur += 1
                elif c == '}':
                    profondeur -= 1
                    if profondeur == 0:
                        trouve.append(src[debut:i].strip())
            elif c == '"':
                break
            i += 1
        for expr in trouve:
            yield m.start(), expr


_fautes = []
for _f in _fichiers:
    _src = open(_f, encoding='utf-8').read()
    _nom = os.path.relpath(_f, _FRONT)
    if re.search(r"escapeHtml\([^)]*\)\.replace\(/'/g", _src):
        _fautes.append((_nom, "escapeHtml(...).replace(/'/g : echappement dans le mauvais ordre"))
    for _pos, _expr in _gestionnaires_inline(_src):
        if not _ID_SUR.match(_expr):
            _ligne = _src.count('\n', 0, _pos) + 1
            _fautes.append(('%s:%d' % (_nom, _ligne), _expr))

check("%d fichiers frontend parcourus" % len(_fichiers), len(_fichiers) > 20, len(_fichiers))
check("aucun ${...} textuel dans un gestionnaire inline, aucun echappement inverse",
      not _fautes, _fautes)

# Le detecteur doit voir les trois formes du defaut d'origine, sinon il ne
# prouve rien. Echantillons tires tels quels du code d'avant correction.
_ech = [
    '''onclick="openEditModal(${player.id}, '${escapeHtml(player.nom).replace(/'/g, "\\\\'")}')"''',
    '''onclick="removePlayer('${escapeHtml(nom).replace(/'/g, "\\\\'")}', this)"''',
    '''onclick="saveAwards(${s.id}, ${escapedLigueNom ? "'" + escapedLigueNom + "'" : 'null'})"''',
]
for _e in _ech:
    check("  le detecteur attrape : %s..." % _e[:45],
          any(not _ID_SUR.match(x) for _, x in _gestionnaires_inline(_e)))
check("  et laisse passer un identifiant seul",
      all(_ID_SUR.match(x) for _, x in
          _gestionnaires_inline('onclick="f(${Number(s.id)})" onclick="g(${player.id}, ${index})"')))


# ===========================================================================
print("\n=== Lot A (S-05, S-09, S-10, couleurs) : validation des fiches ===")
# ===========================================================================
from utils import nombre_fini, couleur_valide
import services as _services

# -- Les deux outils, sur les valeurs qui passaient avant.
for v, attendu in ((float('nan'), None), (float('inf'), None), ('nan', None), ('inf', None),
                   (True, None), (None, None), ('abc', None), (101, None), (-1, None),
                   (50, 50.0), ('42.5', 42.5), (0, 0.0), (100, 100.0)):
    check("nombre_fini(%r, 0, 100) -> %r" % (v, attendu), nombre_fini(v, 0, 100) == attendu)
check("nombre_fini : borne basse exclue quand demande",
      nombre_fini(0, 0, 20, min_exclu=True) is None and nombre_fini(0.1, 0, 20, min_exclu=True) == 0.1)
for v, attendu in (('#ff00aa', '#FF00AA'), (' #FFFFFF ', '#FFFFFF'), ('red', None),
                   ('#fff', None), ('#12345G', None), ('#FFFFFF;background:url(x)', None),
                   (None, None), (123, None)):
    check("couleur_valide(%r) -> %r" % (v, attendu), couleur_valide(v) == attendu)


# -- nom_creable : la regle unique de joueurs.nom.
def _nc(nom, interdit=False, collision=None, exclure_id=None):
    cur, _ = install_db([(r"FROM noms_interdits", (1,) if interdit else None),
                         (r"FROM joueurs WHERE lower\(nom\)", collision)])
    return _services.nom_creable(cur, nom, exclure_id=exclure_id), cur

(n, e), _ = _nc('  Mario  ')
check("nom_creable : nom libre accepte et nettoye", n == 'Mario' and e is None, (n, e))
for nom, code, kw in (('', 'nom_vide', {}), (None, 'nom_vide', {}), (42, 'nom_vide', {}),
                      ('a/b', 'nom_invalide', {}), ('Ancien', 'nom_interdit', {'interdit': True}),
                      ('mario', 'nom_deja_pris', {'collision': (3, 'Mario')})):
    (n, e), _ = _nc(nom, **kw)
    check("nom_creable(%r) -> %s" % (nom, code), n is None and e and e['code'] == code, e)
(n, e), cur = _nc('mario', exclure_id=3)
check("renommage : la fiche elle-meme est exclue de la collision",
      any('id <> %s' in s and p == ('mario', 3) for s, p in cur.executed), cur.executed)
check("l'empreinte est celle de l'anonymisation (strip + minuscules)",
      _services.empreinte_nom('  MaRiO ') == _services.empreinte_nom('mario'))


# -- Creation d'une fiche (page Fiches joueurs).
def creer(corps, permissions=DROITS_FICHE + ('joueurs_creation',), interdit=False,
          collision=None):
    cli, cur, conn = monter_admin([
        (r"FROM noms_interdits", (1,) if interdit else None),
        (r"FROM joueurs WHERE lower\(nom\)", collision),
        (r"INSERT INTO Joueurs", (7,)),
    ], 'admin', permissions=permissions)
    return cli.post('/admin/joueurs', json=corps, headers=H), cur

ecrit = lambda cur: any('INSERT INTO Joueurs' in s for s in sql_de(cur))
invalide = lambda r, champ: (r.status_code == 400 and (r.get_json() or {}).get('code')
                             == 'valeur_invalide' and r.get_json().get('champ') == champ)

r, cur = creer({'nom': 'Ancien'}, interdit=True)
check("S-05 : creer une fiche au nom anonymise -> 409 nom_interdit",
      r.status_code == 409 and r.get_json()['code'] == 'nom_interdit' and not ecrit(cur), r.get_json())
r, cur = creer({'nom': 'mario'}, collision=(3, 'Mario'))
check("S-05 : « mario » alors que « Mario » existe -> 409 nom_deja_pris",
      r.status_code == 409 and r.get_json()['code'] == 'nom_deja_pris' and not ecrit(cur), r.get_json())
r, cur = creer({'nom': 'a/b'})
check("S-05 : un « / » -> 409", r.status_code == 409 and not ecrit(cur), r.get_json())
for champ, corps in (('mu', {'mu': float('nan')}), ('mu', {'mu': 500}), ('mu', {'mu': -1}),
                     ('sigma', {'sigma': 0}), ('sigma', {'sigma': float('inf')}),
                     ('sigma', {'sigma': 21}), ('color', {'color': 'red'}),
                     ('color', {'color': '#fff;x'})):
    r, cur = creer(dict(corps, nom='Neuf'))
    check("S-10 : creation avec %s -> 400 valeur_invalide(%s)" % (corps, champ),
          invalide(r, champ) and not ecrit(cur), r.get_json())
r, cur = creer({'nom': 'Neuf', 'color': '#ffffff'},
               permissions=('gestion_joueurs', 'joueurs_creation'))
check("couleur blanche en minuscules : aucun droit couleur exige (normalisee avant comparaison)",
      r.status_code in (200, 201) and ecrit(cur), r.get_json())
r, cur = creer({'nom': '  Neuf  '})
_ins = [p for s, p in cur.executed if 'INSERT INTO Joueurs' in s]
check("NON-REGRESSION : creation valide -> ecrite avec le nom nettoye",
      r.status_code in (200, 201) and _ins and _ins[0][0] == 'Neuf', (r.get_json(), _ins))


# -- Modification d'une fiche.
FICHE_9 = ('Mario', 50.0, 8.333333, True, '#FF0000', 0)

def modifier(corps, fiche=FICHE_9, interdit=False, collision=None):
    cli, cur, conn = monter_admin([
        (r"SELECT id, role FROM comptes WHERE joueur_id", None),
        (r"SELECT nom, mu, sigma, is_ranked, color, consecutive_missed", fiche),
        (r"FROM noms_interdits", (1,) if interdit else None),
        (r"FROM joueurs WHERE lower\(nom\)", collision),
    ], 'admin', permissions=DROITS_FICHE)
    return cli.put('/admin/joueurs/9', json=corps, headers=H), cur

maj = lambda cur: any(s.startswith('UPDATE Joueurs SET nom') for s in sql_de(cur))

r, cur = modifier({'nom': 'Ancien'}, interdit=True)
check("S-05 : renommer vers un nom anonymise -> 409 nom_interdit",
      r.status_code == 409 and r.get_json()['code'] == 'nom_interdit' and not maj(cur), r.get_json())
r, cur = modifier({'nom': 'luigi'}, collision=(4, 'Luigi'))
check("S-05 : renommer en « luigi » alors que « Luigi » existe -> 409",
      r.status_code == 409 and not maj(cur), r.get_json())
r, cur = modifier({'nom': 'MARIO'})
check("renommer sa propre fiche en changeant la casse -> 200 (elle s'exclut)",
      r.status_code == 200 and maj(cur), r.get_json())
for champ, corps in (('mu', {'mu': float('nan')}), ('mu', {'mu': 500}),
                     ('sigma', {'sigma': -2}), ('sigma', {'sigma': float('nan')}),
                     ('color', {'color': 'javascript:x'})):
    r, cur = modifier(corps)
    check("S-10 : modification %s -> 400 valeur_invalide(%s)" % (corps, champ),
          invalide(r, champ) and not maj(cur), r.get_json())
r, cur = modifier({'nom': 'Mario Bis', 'mu': 50.0, 'sigma': 25.0},
                  fiche=('Mario', 50.0, 25.0, True, '#FF0000', 0))
check("une fiche au sigma deja hors borne (25) reste renommable sans toucher au score",
      r.status_code == 200 and maj(cur), r.get_json())
r, cur = modifier({'color': '#ff0000'})
_up = [p for s, p in cur.executed if s.startswith('UPDATE Joueurs SET nom')]
check("couleur renvoyee en minuscules : pas une modification, la base est gardee",
      r.status_code == 200 and _up and '#FF0000' in _up[0], (r.get_json(), _up))


# -- Formulaire de tournoi.
def tournoi(joueurs, permissions, existants=None, interdit=False):
    """`existants` : {nom en minuscules: (id, nom)} des fiches deja en base."""
    existants = existants or {}
    cli, cur, conn = monter_admin([
        (r"FROM global_resets WHERE date >=", (0,)),
        (r"key = 'league_mode_enabled'", ('false',)),
        (r"FROM grille_snapshots WHERE date", None),
        (r"INSERT INTO sessions_tournois DEFAULT VALUES", (501,)),
        (r"INSERT INTO Tournois", (777,)),
        (r"SELECT id, nom, mu, sigma FROM Joueurs WHERE lower\(nom\)",
         lambda p: (existants[p[0].lower()] + (50.0, 8.333)) if p[0].lower() in existants
         else None),
        (r"FROM noms_interdits", (1,) if interdit else None),
        (r"FROM joueurs WHERE lower\(nom\)", None),
        (r"INSERT INTO Joueurs", (99,)),
    ], 'admin', permissions=permissions)
    return cli.post('/add-tournament', json={'date': '2026-09-01', 'joueurs': joueurs},
                    headers=H), cur

TOURNOI_SEUL = ('gestion_tournois', 'gestion_joueurs')
r, cur = tournoi([{'nom': 'Mario', 'score': 10}, {'nom': 'mario', 'score': 5}],
                 TOURNOI_SEUL, existants={'mario': (10, 'Mario')})
check("« Mario » et « mario » : la meme fiche, reconnue sans tenir compte de la casse -> 409 doublon",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'joueur_en_double', r.get_json())
check("  et aucune fiche n'est creee pour « mario »", not ecrit(cur))

# Un joueur connu en plus : un tournoi exige au moins deux lignes.
LUIGI = {'luigi': (11, 'Luigi')}
r, cur = tournoi([{'nom': 'Luigi', 'score': 12}, {'nom': 'Inconnu', 'score': 10}],
                 TOURNOI_SEUL, existants=LUIGI)
check("S-09 : gestion_joueurs sans joueurs_creation ne cree pas de fiche -> 409 joueur_inconnu",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'joueur_inconnu'
      and not ecrit(cur), r.get_json())

r, cur = tournoi([{'nom': 'Luigi', 'score': 12}, {'nom': 'Ancien', 'score': 10}],
                 TOURNOI_SEUL + ('joueurs_creation',), existants=LUIGI, interdit=True)
check("S-05 : un nom anonymise n'est pas recree par le tournoi -> 409 nom_interdit",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'nom_interdit'
      and not ecrit(cur), r.get_json())

r, cur = tournoi([{'nom': 'Luigi', 'score': 12}, {'nom': 'a/b', 'score': 10}],
                 TOURNOI_SEUL + ('joueurs_creation',), existants=LUIGI)
check("S-05 : un « / » n'est pas cree par le tournoi -> 409",
      r.status_code == 409 and not ecrit(cur), r.get_json())


# -- Reglages et reset global (S-10).
def config(corps):
    cli, cur, conn = monter_admin([], 'admin', permissions=('gestion_config',))
    return cli.post('/admin/config', json=corps, headers=H), cur

for cle, v in (('tau', float('nan')), ('tau', -1), ('ghost_penalty', float('inf')),
               ('sigma_threshold', 0), ('sigma_threshold', 'nan')):
    r, cur = config({cle: v})
    check("S-10 : reglage %s=%r -> 400" % (cle, v), invalide(r, cle)
          and not any('Configuration' in s and s.startswith(('UPDATE', 'INSERT'))
                      for s in sql_de(cur)), r.get_json())

def reset(corps):
    cli, cur, conn = monter_admin([], 'admin', permissions=('gestion_config',))
    return cli.post('/api/admin/global-reset', json=dict(corps, date='2026-09-01'), headers=H), cur

for champ, corps in (('value', {'value': float('nan'), 'max_sigma': 8}),
                     ('value', {'value': float('inf'), 'max_sigma': 8}),
                     ('max_sigma', {'value': 1, 'max_sigma': float('nan')})):
    r, cur = reset(corps)
    check("S-10 : reset global %s -> 400 (NaN passait `<= 0`)" % corps, invalide(r, champ),
          r.get_json())

# -- Couleur d'une ligue.
cli, cur, conn = monter_admin([], 'admin', permissions=('gestion_ligues',))
r = cli.post('/admin/ligues/setup', json={'ligues': [{'nom': 'Ligue 1',
                                                      'couleur': 'red;background:url(x)'}]},
             headers=H)
check("couleur de ligue hors #RRGGBB -> 400, rien d'ecrit",
      r.status_code == 400 and not any(s.startswith('UPDATE Configuration') for s in sql_de(cur)),
      (r.status_code, r.get_json()))

# -- Synchronisation du pseudo Discord : quatrieme ecrivain de joueurs.nom.
cli, cur, conn = monter([
    (r"FROM comptes c LEFT JOIN joueurs j", ('ancien', 'Ancien', 9, 'Mario')),
    (r"FROM noms_interdits", (1,)),
    (r"SELECT role FROM comptes WHERE id", ('player',)),
], role='chef_admin')
r = cli.get('/admin/comptes/5/sync-preview', headers=H)
check("S-05 : synchroniser vers un pseudo anonymise -> 409 nom_interdit",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'nom_interdit', r.get_json())


# ===========================================================================
print("\n=== Lot F : historique des consentements, ajout seul ===")
# ===========================================================================
consent = lambda cur: [p for s, p in cur.executed if 'INSERT INTO consentements' in s]

# /consentement -> POST /me/cgu
cli, cur, conn = monter([(r"UPDATE comptes SET cgu_accepted_at", None)], role='player', compte_id=5)
r = cli.post('/me/cgu', headers=H)
_c = consent(cur)
check("accepter la politique -> 200", r.status_code == 200, r.get_json())
check("  une ligne d'historique : (compte, 'cgu', version, 'page_consentement')",
      _c == [(5, 'cgu', '1.0', 'page_consentement')], _c)
_s = sql_de(cur)
check("  dans la MEME transaction que l'etat courant, apres lui",
      conn.committed and any('UPDATE comptes SET cgu_accepted_at' in x for x in _s)
      and [i for i, x in enumerate(_s) if 'UPDATE comptes SET cgu_accepted_at' in x][0]
      < [i for i, x in enumerate(_s) if 'INSERT INTO consentements' in x][0])

# Accepter un role admin : consentement distinct, origine distincte.
r, cur, conn = accepter('player', 'admin', 3, ('chef_admin', 'linked'))
check("accepter une promotion -> ligne ('cgu_admin', 'acceptation_promotion')",
      consent(cur) == [(5, 'cgu_admin', V_ADMIN, 'acceptation_promotion')], consent(cur))
r, cur, conn = accepter('player', 'admin', 3, ('admin', 'linked'))
check("  une proposition caduque n'enregistre AUCUN consentement", not consent(cur), consent(cur))
cli, cur, conn = monter([
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('player',)),
    (r"FROM promotions_proposees WHERE compte_id", (7, 'admin', 3, PASSE, FUTUR)),
], role='player', compte_id=5)
cli.post('/me/promotion', json={'accepte': False}, headers=H)
check("  un refus non plus", not consent(cur), consent(cur))

# Admin deja en poste qui regularise.
cli, cur, conn = monter([(r"UPDATE comptes", None)], role='admin', compte_id=5)
r = cli.post('/me/cgu-admin', json={'version': V_ADMIN}, headers=H)
check("regularisation admin -> ligne ('cgu_admin', 'regularisation_admin')",
      r.status_code == 200 and consent(cur) == [(5, 'cgu_admin', V_ADMIN, 'regularisation_admin')],
      (r.get_json(), consent(cur)))

# Effacement : l'historique part avec le compte (decision du 25/09).
cli, cur, conn = monter([
    (r"SELECT role, joueur_id, discord_id, discord_username FROM comptes WHERE id = %s FOR UPDATE",
     ('player', None, '123456789012345678', 'cible')),
    (r"SELECT role FROM comptes WHERE id", ('player',)),
], role='superadmin')
r = cli.delete('/admin/comptes/2', json={'confirmation_pseudo': 'cible'}, headers=H)
_s = sql_de(cur)
check("supprimer un compte efface son historique de consentements, AVANT le compte",
      r.status_code == 200 and 'DELETE FROM consentements WHERE compte_id = %s' in _s
      and _s.index('DELETE FROM consentements WHERE compte_id = %s')
      < _s.index('DELETE FROM comptes WHERE id = %s'), _s)

# Schema : migration, schema.sql, montage du dump, controle final.
_mig = _lire('backEnd', 'migrations', '2026-09-25_consentements.sql')
_sch = _lire('backEnd', 'schema.sql')
for nom, src in (('migration', _mig), ('schema.sql', _sch)):
    check("%s : table consentements en CASCADE sur le compte" % nom,
          'CREATE TABLE' in src and 'consentements' in src
          and re.search(r"compte_id\s+integer NOT NULL REFERENCES public\.comptes\(id\) "
                        r"ON DELETE CASCADE", src.split('consentements (')[1]) is not None)
    check("%s : UPDATE interdit par trigger, DELETE laisse libre (effacement)" % nom,
          'BEFORE UPDATE ON public.consentements' in src
          and 'BEFORE DELETE ON public.consentements' not in src)
    # Chaque origine ecrite par le code doit etre admise par la contrainte :
    # sinon l'INSERT echoue en production, et le consentement avec lui.
    _check = src[src.index('consentements_origine_valide'):]
    _check = _check[:_check.index('))')]
    for origine in re.findall(r"_enregistrer_consentement\([^)]*'([a-z_]+)'\)",
                              _lire('backEnd', 'routes_comptes.py'), re.S):
        check("  %s admet l'origine « %s » ecrite par le code" % (nom, origine),
              "'%s'" % origine in _check)
check("la migration reprend les acceptations existantes (cgu et cgu_admin)",
      _mig.count("'reprise_migration'") >= 3 and 'cgu_admin_accepted_at IS NOT NULL' in _mig)
check("montee dans docker-compose.dump.yml",
      '2026-09-25_consentements.sql' in _lire('docker-compose.dump.yml'))
check("controlee par verifier-schema-dump.sql et adapter-dump.sh",
      "'consentements'" in _lire('scripts', 'verifier-schema-dump.sql')
      and 'consentements' in _lire('scripts', 'adapter-dump.sh'))

# La politique ne doit plus decrire le lien cgu=1 supprime par S-06.
_conf = _lire('frontEnd', 'templates', 'confidentialite.html')
check("la politique ne dit plus que le consentement se donne en cliquant « Se connecter avec Discord »",
      'donné en cliquant\n                            « Se connecter avec Discord »' not in _conf
      and 'en cliquant « Se connecter avec Discord » après' not in ' '.join(_conf.split()))


# ===========================================================================
print("\n=== Lot C (S-07) : l'export « mes donnees » est complet ===")
# ===========================================================================

def exporter(role, journal=()):
    cli, cur, conn = monter([
        (r"SELECT discord_id, discord_username",
         ('111', 'moi', 'Moi', None, None, 'pending', role, PASSE, '1.0',
          PASSE, PASSE, PASSE, PASSE, None, PASSE, '1.0')),
        (r"FROM consentements WHERE compte_id",
         [('cgu', '1.0', PASSE, 'reprise_migration'), ('cgu_admin', '1.0', PASSE,
                                                        'acceptation_promotion')]),
        (r"FROM liaisons_demandes d LEFT JOIN joueurs j",
         [('pending', 'Je suis nouveau', PASSE, None, None, None, 'MonPseudo')]),
        (r"FROM promotions_proposees WHERE compte_id",
         [('admin', 'accepted', PASSE, FUTUR, PASSE)]),
        (r"SELECT permission, created_at FROM permissions_admin",
         [('gestion_liaisons', PASSE)]),
        (r"FROM audit_admin a", list(journal)),
    ], role=role, compte_id=5)
    r = cli.get('/me/export', headers=H)
    return r, (r.get_json() or {}), cur

LIGNE = (40, 'liaison_approuvee', 5, 'compte', 8,
         {'joueur_id': 9, 'acteur': {'pseudo': 'Moi', 'role': 'admin'}}, PASSE, 'Moi')
r, d, cur = exporter('admin', journal=[LIGNE])
check("export -> 200", r.status_code == 200, d)
check("la demande de CREATION de fiche figure (nom demande et message compris)",
      d.get('demandes_de_liaison') == [{'type': 'creation', 'statut': 'pending',
                                        'message': 'Je suis nouveau',
                                        'faite_le': PASSE.isoformat(), 'decidee_le': None,
                                        'joueur': None, 'nom_demande': 'MonPseudo'}],
      d.get('demandes_de_liaison'))
check("  par une jointure EXTERNE (la fiche n'existe pas encore)",
      any('LEFT JOIN joueurs j' in x and 'liaisons_demandes' in x for x in sql_de(cur)))
check("le consentement administrateur figure dans « compte »",
      d.get('compte', {}).get('politique_admin_version') == '1.0', d.get('compte'))
check("l'historique des consentements (lot F) figure, dans l'ordre",
      [c['politique'] for c in d.get('consentements', [])] == ['cgu', 'cgu_admin'],
      d.get('consentements'))
check("les propositions de role recues figurent",
      d.get('propositions_de_role', [{}])[0].get('statut') == 'accepted',
      d.get('propositions_de_role'))
check("les permissions accordees figurent",
      d.get('permissions') == [{'permission': 'gestion_liaisons',
                                'accordee_le': PASSE.isoformat()}], d.get('permissions'))
_j = d.get('journal_de_mes_actions') or []
check("le journal des actions dont on est l'AUTEUR figure",
      len(_j) == 1 and _j[0]['action'] == 'liaison_approuvee'
      and _j[0]['details'] == {'joueur_id': 9}, _j)

_aud = [(x, p) for x, p in cur.executed if 'FROM audit_admin a' in x]
check("  lu par le lecteur partage, filtre sur l'auteur = soi",
      _aud and 'a.acteur_compte_id = %s' in _aud[0][0] and 5 in _aud[0][1], _aud)
check("  sans filtre de rang : un admin, qui ne lit pas le journal, obtient ses propres lignes",
      _aud and 'c.role = ANY' not in _aud[0][0], _aud)
check("  et sans limite (LIMIT NULL)", _aud and _aud[0][1][-1] is None, _aud)
check("aucune identite d'un AUTRE compte (proposant, auteur d'un octroi) n'est exportee",
      'propose_par' not in str(d) and 'accorde_par' not in str(d))

# Le lecteur partage garde son filtre de rang pour les lignes des AUTRES.
import routes_comptes as _rc
cur, _ = install_db([(r"FROM audit_admin a", [])])
_rc._lire_journal(cur, {'id': 1, 'role': 'chef_admin'}, compte_id=7)
check("lire le journal d'un AUTRE compte reste soumis au filtre de rang",
      any('c.role = ANY' in x for x, _ in cur.executed), cur.executed)


# ===========================================================================
print("\n=== Lot D (S-16) : purge nommee, politique exacte sur le journal ===")
# ===========================================================================
cli, cur, conn = monter([], role='chef_admin', compte_id=3)
r = cli.post('/admin/purge-rgpd', headers=H)
_p = [p for x, p in cur.executed if 'INSERT INTO audit_admin' in x and p and p[0] == 'purge_rgpd']
check("la purge -> 200", r.status_code == 200, r.get_json())
check("le journal nomme le chef_admin qui a purge (acteur 3, et plus None)",
      _p and _p[0][1] == 3, _p)
check("  services ne force plus acteur_id=None",
      "'purge_rgpd', 'systeme', details=bilan, acteur_id=None" not in _lire('backEnd', 'services.py'))

_conf = ' '.join(_lire('frontEnd', 'templates', 'confidentialite.html').split())
check("politique §4 : le journal peut contenir un motif redige et les pseudos Discord synchronises",
      'motif' in _conf and 'ancien et votre nouveau pseudo Discord' in _conf)
check("politique : l'empreinte du snowflake est dite pseudonyme, pas anonyme",
      _conf.count('pseudonyme') >= 2 and 'identifiant y est alors détaché' not in _conf)
check("politique §6 : la suppression efface aussi l'historique des acceptations (lot F)",
      "l'historique de vos acceptations" in _conf)
check("le code ne presente plus l'empreinte comme « sans la moindre donnee personnelle »",
      'sans\n    # conserver la moindre donnee personnelle' not in _lire('backEnd', 'routes_comptes.py')
      and 'PSEUDONYMISATION' in _lire('backEnd', 'routes_comptes.py'))


# ===========================================================================
print("\n=== Lot E (S-17) : hygiene ===")
# ===========================================================================

# -- Route morte : GET qui ecrivait en base, sans appelant.
import routes_admin as _ra_mod
check("GET /api/admin/fix-db-structure n'existe plus",
      not hasattr(_ra_mod, 'fix_db_structure')
      and 'fix-db-structure' not in _lire('backEnd', 'routes_admin.py'))

# -- Statut : actif ou suspendu, le reste se deduit de la fiche.
def statut(corps, joueur_id):
    cli, cur, conn = monter([
        (r"SELECT statut, role, joueur_id FROM comptes WHERE id = %s FOR UPDATE",
         ('suspended', 'player', joueur_id)),
        (r"SELECT role FROM comptes WHERE id", ('player',)),
    ], role='chef_admin')
    r = cli.post('/admin/comptes/2/statut', json=corps, headers=H)
    ecrit = [p for x, p in cur.executed if x.startswith('UPDATE comptes SET statut')]
    return r, ecrit

for v in ('linked', 'pending', 'n_importe_quoi', None):
    r, ecrit = statut({'statut': v}, 9)
    check("statut %r -> 400 (seuls « actif » et « suspended » se choisissent)" % v,
          r.status_code == 400 and not ecrit, (r.status_code, r.get_json()))
r, ecrit = statut({'statut': 'actif'}, 9)
check("reactiver un compte AVEC fiche -> linked", r.status_code == 200 and ecrit
      and ecrit[0][0] == 'linked' and r.get_json()['statut'] == 'linked', (r.get_json(), ecrit))
r, ecrit = statut({'statut': 'actif'}, None)
check("reactiver un compte SANS fiche -> pending", r.status_code == 200 and ecrit
      and ecrit[0][0] == 'pending', (r.get_json(), ecrit))
check("la page Comptes envoie « actif » et n'invente plus linked/pending",
      "suspendu ? 'actif' : 'suspended'" in _lire('frontEnd', 'templates', 'admin_comptes.html'))

# -- Deconnexion : POST + CSRF.
import importlib, types as _types
os.environ.setdefault('SECRET_KEY', 'audit')
os.environ.setdefault('BACKEND_URL', 'http://audit.invalid')
sys.path.insert(0, os.path.join(_RACINE, 'frontEnd'))
_front = importlib.import_module('frontend')
_appels = []

class _Rep:
    status_code = 200
    def json(self): return {'role': 'player', 'permissions': [], 'cgu_a_accepter': False}

_front.requests = _types.SimpleNamespace(
    get=lambda *a, **k: _Rep(),
    post=lambda url, *a, **k: (_appels.append(url), _Rep())[1])

def _client_connecte(csrf):
    _front.app.config.update(TESTING=True, WTF_CSRF_ENABLED=csrf)
    c = _front.app.test_client()
    with c.session_transaction() as sess:
        sess['player_token'] = 'tok'
        sess['compte'] = {'id': 42, 'role': 'player', 'permissions': [],
                          'cgu_a_accepter': False}
    return c

def _connecte(c):
    with c.session_transaction() as sess:
        return sess.get('player_token') == 'tok'

del _appels[:]
c = _client_connecte(csrf=True)
r = c.get('/logout')
check("GET /logout ne deconnecte plus (une <img> sur un autre site ne suffit plus)",
      _connecte(c) and not any('/auth/logout' in u for u in _appels), r.status_code)
check("  et renvoie simplement a l'accueil", r.status_code == 302, r.status_code)
r = c.post('/logout')
check("POST /logout SANS jeton CSRF -> refuse, session intacte",
      r.status_code == 400 and _connecte(c), r.status_code)
c = _client_connecte(csrf=False)
r = c.post('/logout')
check("POST /logout (jeton verifie) -> deconnecte, et ferme la session cote backend",
      not _connecte(c) and any('/auth/logout' in u for u in _appels), (r.status_code, _appels))

for gabarit in ('navbar.html', 'consentement.html', 'mon_compte.html'):
    src = _lire('frontEnd', 'templates', gabarit)
    i = src.find('logout')
    bloc = src[max(0, i - 300):i + 300]
    check("%s : plus de lien GET vers /logout, un formulaire POST avec csrf_token" % gabarit,
          'href="/logout"' not in src and "href=\"{{ url_for('player_logout') }}\"" not in src
          and 'method="post"' in bloc and 'csrf_token' in bloc)

check("etat-avancement ne dit plus que debugMode est a true",
      'encore à `true`' not in _lire('docs', 'etat-avancement-global.md')
      and 'debugMode: false' in _lire('frontEnd', 'static', 'js', 'banner', 'config.js'))


# ===========================================================================
print("\n=== Lot B (S-15) : CSP, et plus aucun tiers ne voit les visiteurs ===")
# ===========================================================================

# -- L'en-tete : chaque regle, pour qu'aucune ne disparaisse en silence.
_REGLES_CSP = (
    "default-src 'self'", "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "object-src 'none'", "base-uri 'self'",
    "form-action 'self'", "frame-ancestors 'self'",
)
_regles = [r.strip() for r in _front.CSP_COMPLETE.split(';')]
for regle in _REGLES_CSP:
    check("CSP : %s" % regle, regle in _regles, _front.CSP_COMPLETE)
check("CSP : aucune origine externe autorisee",
      not re.search(r'https?:|\*', _front.CSP_COMPLETE), _front.CSP_COMPLETE)

_front.app.config.update(TESTING=True, WTF_CSRF_ENABLED=True)
r = _front.app.test_client().get('/mentions-legales')
check("la CSP complete part sur les pages, en bloquant",
      r.headers.get('Content-Security-Policy') == _front.CSP_COMPLETE,
      r.headers.get('Content-Security-Policy'))
check("  et plus aucun en-tete en observation",
      'Content-Security-Policy-Report-Only' not in r.headers, dict(r.headers))

# -- Aucun gabarit ni script ne charge ou n'appelle une origine externe. Les
#    liens cliquables (<a href>) ne sont pas vises : ils ne partent qu'au clic.
_gabarits = os.path.join(_RACINE, 'frontEnd', 'templates')
_js = os.path.join(_RACINE, 'frontEnd', 'static', 'js')
_sources = [os.path.join(_gabarits, f) for f in os.listdir(_gabarits) if f.endswith('.html')]
for base, _, fichiers in os.walk(_js):
    _sources += [os.path.join(base, f) for f in fichiers if f.endswith('.js')]
_externes = []
for chemin in _sources:
    src = open(chemin, encoding='utf-8').read()
    for m in re.finditer(r'<(?:script|link|img|iframe)\b[^>]*?(?:src|href)="(?:https?:)?//[^"]+"'
                         r'|fetch\(\s*[\'"`](?:https?:)?//[^\'"`]+', src):
        _externes.append((os.path.basename(chemin), m.group(0)[:90]))
check("%d gabarits et scripts : aucune ressource ni appel vers un autre site" % len(_sources),
      not _externes and len(_sources) > 40, _externes)

# -- Les copies locales existent bien, polices de Font Awesome comprises.
_static = os.path.join(_RACINE, 'frontEnd', 'static')
_references = set()
for chemin in _sources:
    _references.update(re.findall(r"filename='(vendor/[^']+)'", open(chemin, encoding='utf-8').read()))
check("gabarits : les 4 librairies locales sont referencees",
      {'vendor/bulma-0.9.4/bulma.min.css', 'vendor/fontawesome-6.4.0/css/all.min.css',
       'vendor/jquery-3.6.0/jquery.min.js', 'vendor/chartjs-4.5.1/chart.umd.min.js'} <= _references,
      sorted(_references))
_manquants = [p for p in _references if not os.path.isfile(os.path.join(_static, p))]
_fa = os.path.join(_static, 'vendor', 'fontawesome-6.4.0')
_manquants += [p for p in re.findall(r'url\(\.\./(webfonts/[^)]+)\)',
                                     open(os.path.join(_fa, 'css', 'all.min.css')).read())
               if not os.path.isfile(os.path.join(_fa, p))]
check("chaque fichier reference existe dans static/ (polices comprises)", not _manquants, _manquants)

# -- Widget Discord relaye par le backend.
import routes_public as _rp
_rp.get_cached = lambda k, ttl=None: _cache_widget.get(k)
_rp.set_cached = lambda k, v: _cache_widget.__setitem__(k, v)
_appels_discord = []

def widget(reponse_discord):
    """reponse_discord : (status, json) ou une exception a lever."""
    def get(url, **kw):
        _appels_discord.append((url, kw))
        if isinstance(reponse_discord, Exception):
            raise reponse_discord
        return FakeResponse(*reponse_discord)
    _rp.requests = _types.SimpleNamespace(
        get=get, exceptions=_types.SimpleNamespace(RequestException=OSError))
    app = Flask(__name__)
    app.register_blueprint(_rp.public_bp)
    r = app.test_client().get('/discord/widget')
    return r.status_code, r.get_json()

_cache_widget, _appels_discord[:] = {}, []
status, data = widget((200, {'presence_count': 12, 'instant_invite': 'https://discord.com/invite/abc-DEF',
                             'members': [{'username': 'x', 'avatar_url': 'https://cdn.discordapp.com/x'}],
                             'name': 'MK Reset'}))
check("widget : seuls le nombre en ligne et l'invitation sortent",
      status == 200 and data == {'presence_count': 12, 'instant_invite': 'https://discord.com/invite/abc-DEF'},
      data)
check("  appel au widget du serveur, avec un timeout",
      _appels_discord and _appels_discord[0][0].endswith('/guilds/%s/widget.json' % _rp.DISCORD_GUILD_ID)
      and bool(_appels_discord[0][1].get('timeout')), _appels_discord)
widget((200, {'presence_count': 99}))
check("  mis en cache : la visite suivante n'appelle pas Discord",
      len(_appels_discord) == 1, _appels_discord)

for invitation in ('javascript:alert(1)', 'https://evil.example/invite/x',
                   'https://discord.gg/abc"onmouseover="x', 42):
    _cache_widget = {}
    _, data = widget((200, {'presence_count': 3, 'instant_invite': invitation}))
    check("widget : invitation %r refusee" % (invitation,),
          data['instant_invite'] is None and data['presence_count'] == 3, data)
for compte in (-1, '12', True, None):
    _cache_widget = {}
    _, data = widget((200, {'presence_count': compte}))
    check("widget : presence_count %r ignore" % (compte,), data['presence_count'] is None, data)

for panne in (OSError('timeout'), (404, {'message': 'Unknown Guild'}), (200, ['pas', 'un', 'objet'])):
    _cache_widget, _appels_discord[:] = {}, []
    status, data = widget(panne)
    check("widget : Discord en panne (%r) -> 200 et champs nuls" % (panne,),
          status == 200 and data == {'presence_count': None, 'instant_invite': None}, (status, data))
    widget(panne)
    check("  et la panne est gardee en cache (Discord pas relance a chaque visite)",
          len(_appels_discord) == 1, _appels_discord)

# -- Cote frontend : jamais d'erreur, et l'accueil n'appelle plus discord.com.
_front.requests = _types.SimpleNamespace(
    get=lambda *a, **k: FakeResponse(503, {'error': 'x'}),
    exceptions=_types.SimpleNamespace(RequestException=OSError))
r = _front.app.test_client().get('/discord/widget')
check("frontend /discord/widget : backend en panne -> 200, champs nuls",
      r.status_code == 200 and r.get_json() == {'presence_count': None, 'instant_invite': None},
      (r.status_code, r.get_json()))
_accueil = _lire('frontEnd', 'templates', 'index.html')
check("l'accueil interroge /discord/widget et plus discord.com/api",
      "fetch('/discord/widget'" in _accueil and 'discord.com/api' not in _accueil)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
