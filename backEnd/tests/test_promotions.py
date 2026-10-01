"""Promotion au rang d'admin : une proposition que la personne accepte.

Le role n'est pose qu'a l'acceptation, les plafonds de changer_role
s'appliquent, et les cas de concurrence renvoient un 409 lisible.
"""
from harness import *
from flask import Flask
# Version lue plutot que recopiee.
from constants import CGU_ADMIN_VERSION as V_ADMIN
import importlib


def monter(plan):
    """Appli minimale portant routes_comptes, sur un curseur scripte."""
    cur, conn = install_db(plan)
    recharger()
    sys.modules.pop('routes_comptes', None)
    import auth
    importlib.reload(auth)
    import routes_comptes
    importlib.reload(routes_comptes)
    routes_comptes.invalidate_cache = lambda *a, **k: None
    app = Flask(__name__)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client(), cur, conn


H = {'X-Session-Token': 'tok'}

# Lignes renvoyees par _promotion_en_attente :
# (id, role_propose, propose_par, created_at, expires_at)
PROMO = (7, 'admin', 1, PASSE, FUTUR)


def sqls(cur):
    return [s for s, _ in cur.executed]


# ===========================================================================
print("\n=== Proposer : la route ne pose AUCUN role ===")

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('player',)),  # cible_protegee
    (r"SELECT role, statut FROM comptes WHERE id = %s FOR UPDATE", ('player', 'linked')),
    (r"FROM promotions_proposees", None),  # aucune en attente
    (r"UPDATE promotions_proposees SET statut = 'cancelled'", None),
    (r"INSERT INTO promotions_proposees", (7, FUTUR)),
    (r"INSERT INTO audit_admin", None),
    (r"INSERT INTO notifications", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/admin/comptes/2/promotion', json={'role': 'admin'}, headers=H)
_s = sqls(cur)

check("proposer un role -> 200", r.status_code == 200, r.get_json())
check("une proposition est bien inseree",
      any('INSERT INTO promotions_proposees' in s for s in _s))
check("L'INVARIANT : aucun UPDATE de comptes.role a la proposition",
      not any('SET role' in s for s in _s), [s for s in _s if 'SET role' in s])
check("la proposition est tracee dans l'audit",
      any('INSERT INTO audit_admin' in s for s in _s))
check("et la cible est notifiee -- sinon elle ne saurait pas qu'on l'attend",
      any('INSERT INTO notifications' in s for s in _s))
check("le compte est verrouille avant d'inserer (course a la proposition)",
      any('FOR UPDATE' in s for s in _s))


# ===========================================================================
print("\n=== Proposer : les plafonds de changer_role s'appliquent ===")

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='chef_admin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('player',)),
])
r = cli.post('/admin/comptes/2/promotion', json={'role': 'chef_admin'}, headers=H)
check("un chef_admin ne propose pas un PAIR (403)",
      r.status_code == 403 and (r.get_json() or {}).get('code') == 'droits_insuffisants',
      r.get_json())

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('player',)),
])
r = cli.post('/admin/comptes/2/promotion', json={'role': 'superadmin'}, headers=H)
check("superadmin ne se propose pas : il se legue (400)",
      r.status_code == 400 and (r.get_json() or {}).get('code') == 'role_non_proposable',
      r.get_json())

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('player',)),
])
r = cli.post('/admin/comptes/2/promotion', json={'role': 'player'}, headers=H)
check("player ne se propose pas : retrograder reste unilateral (400)",
      r.status_code == 400 and (r.get_json() or {}).get('code') == 'role_non_proposable',
      r.get_json())

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
])
r = cli.post('/admin/comptes/1/promotion', json={'role': 'admin'}, headers=H)
check("on ne se propose pas un role a soi-meme (403)", r.status_code == 403, r.get_json())


# ===========================================================================
print("\n=== Proposer : les cas que l'index unique ferait tomber en 500 ===")
# Une seule proposition en attente par compte : 409 plutot qu'un 500.

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('player',)),
    (r"SELECT role, statut FROM comptes WHERE id = %s FOR UPDATE", ('player', 'linked')),
    (r"FROM promotions_proposees", PROMO),  # deja en attente
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/admin/comptes/2/promotion', json={'role': 'admin'}, headers=H)
check("une seconde proposition -> 409 lisible, jamais un 500",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'promotion_deja_en_attente',
      r.get_json())

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('admin',)),
    (r"SELECT role, statut FROM comptes WHERE id = %s FOR UPDATE", ('admin', 'linked')),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/admin/comptes/2/promotion', json={'role': 'admin'}, headers=H)
check("proposer le role deja porte -> 409",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'role_inchange',
      r.get_json())

# Un compte suspendu ne pourrait jamais accepter.
cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('player',)),
    (r"SELECT role, statut FROM comptes WHERE id = %s FOR UPDATE", ('player', 'suspended')),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/admin/comptes/2/promotion', json={'role': 'admin'}, headers=H)
check("proposer a un compte SUSPENDU -> 409 (il ne pourrait pas accepter)",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'compte_suspendu',
      r.get_json())

# Une descente ne se propose pas (elle passe par /role).
cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('chef_admin',)),
    (r"SELECT role, statut FROM comptes WHERE id = %s FOR UPDATE", ('chef_admin', 'linked')),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/admin/comptes/2/promotion', json={'role': 'admin'}, headers=H)
check("proposer admin a un chef_admin (une descente) -> 409 pas_une_promotion",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'pas_une_promotion',
      r.get_json())
check("  aucune proposition creee",
      not any('INSERT INTO promotions_proposees' in s for s in sqls(cur)))


# ===========================================================================
print("\n=== Accepter : c'est ICI, et seulement ici, que le role est pose ===")

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='player', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('player',)),
    (r"FROM promotions_proposees", PROMO),
    (r"SELECT role, statut FROM comptes WHERE id = %s$", ('superadmin', 'linked')),
    (r"UPDATE promotions_proposees", None),
    (r"UPDATE comptes", None),
    (r"INSERT INTO audit_admin", None),
    (r"INSERT INTO notifications", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/me/promotion', json={'accepte': True, 'cgu_admin_version': V_ADMIN}, headers=H)
_s = sqls(cur)
_params = [p for s, p in cur.executed if 'UPDATE comptes' in s]

check("accepter -> 200", r.status_code == 200, r.get_json())
check("le role EST pose a l'acceptation",
      any('SET role' in s for s in _s), _s)
check("et le consentement admin est enregistre DANS LE MEME UPDATE",
      any('cgu_admin_accepted_at' in s for s in _s))
check("la version acceptee est stockee, pas seulement la date "
      "-- c'est ce qui permet de demontrer QUOI a ete accepte",
      any(V_ADMIN in str(p) for p in _params), _params)
check("la proposition passe a 'accepted'",
      any('UPDATE promotions_proposees' in s for s in _s))
check("l'attribution est tracee", any('INSERT INTO audit_admin' in s for s in _s))
check("le proposant est notifie de l'acceptation",
      any('INSERT INTO notifications' in s for s in _s))

# Verrou sur le compte avant celui sur la proposition.
_ordre = [i for i, s in enumerate(_s) if 'FOR UPDATE' in s]
check("le compte est verrouille AVANT la proposition (ordre anti-interblocage)",
      len(_ordre) >= 2 and 'FROM comptes' in _s[_ordre[0]],
      [_s[i][:60] for i in _ordre])


# Accepter chef_admin purge les permissions a la carte.
def _accepter(role_actuel, role_propose):
    cli, cur, conn = monter([
        (r"FROM sessions_joueurs s\s+JOIN comptes c",
         ligne_session(compte_id=5, role=role_actuel, statut='linked')),
        (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", (role_actuel,)),
        (r"FROM promotions_proposees", (7, role_propose, 1, PASSE, FUTUR)),
        (r"SELECT role, statut FROM comptes WHERE id = %s$", ('superadmin', 'linked')),
        (r"UPDATE promotions_proposees", None),
        (r"UPDATE comptes", None),
        (r"INSERT INTO audit_admin", None),
        (r"INSERT INTO notifications", None),
        (r"UPDATE sessions_joueurs SET last_seen_at", None),
    ])
    r = cli.post('/me/promotion', json={'accepte': True, 'cgu_admin_version': V_ADMIN},
                 headers=H)
    return r, cur

r, cur = _accepter('admin', 'chef_admin')
_purge = [(s, p) for s, p in cur.executed if 'DELETE FROM permissions_admin' in s]
check("un admin qui accepte chef_admin -> 200", r.status_code == 200, r.get_json())
check("  ses permissions a la carte sont purgees (R-53), les siennes seulement",
      len(_purge) == 1 and _purge[0][1] == (5,), _purge)
check("  la purge est tracee",
      any('permissions_purgees' in str(p) for s, p in cur.executed
          if 'INSERT INTO audit_admin' in s))

r, cur = _accepter('player', 'admin')
check("un player qui accepte admin n'a rien a purger",
      r.status_code == 200
      and not any('DELETE FROM permissions_admin' in s for s in sqls(cur)),
      r.get_json())


# ===========================================================================
print("\n=== Accepter : le role et la politique sont UN SEUL geste ===")

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='player', statut='linked')),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/me/promotion', json={'accepte': True}, headers=H)
check("accepter SANS la version de politique -> 400",
      r.status_code == 400 and (r.get_json() or {}).get('code') == 'version_cgu_admin',
      r.get_json())

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='player', statut='linked')),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/me/promotion', json={'accepte': True, 'cgu_admin_version': '0.9'}, headers=H)
check("accepter une version PERIMEE de la politique -> 400",
      r.status_code == 400, r.get_json())
check("et aucun role n'est pose dans ce cas",
      not any('SET role' in s for s in sqls(cur)))


# ===========================================================================
print("\n=== Refuser : le compte reste inchange, le proposant est prevenu ===")

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='player', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('player',)),
    (r"FROM promotions_proposees", PROMO),
    (r"UPDATE promotions_proposees", None),
    (r"INSERT INTO audit_admin", None),
    (r"INSERT INTO notifications", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/me/promotion', json={'accepte': False}, headers=H)
_s = sqls(cur)

check("refuser -> 200", r.status_code == 200, r.get_json())
check("LE COMPTE RESTE PLAYER : aucun UPDATE du role",
      not any('SET role' in s for s in _s), [s for s in _s if 'SET role' in s])
check("aucun consentement n'est enregistre non plus",
      not any('cgu_admin_accepted_at' in s for s in _s))
check("la proposition passe a 'refused'",
      any('UPDATE promotions_proposees' in s for s in _s))
check("le proposant est notifie du refus",
      any('INSERT INTO notifications' in s for s in _s))


# ===========================================================================
print("\n=== Repondre sans proposition valide ===")
# Expiree, annulee ou inexistante : meme reponse, qui mentionne l'expiration.

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='player', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('player',)),
    (r"FROM promotions_proposees", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/me/promotion', json={'accepte': True, 'cgu_admin_version': V_ADMIN}, headers=H)
check("repondre a une proposition absente/expiree -> 409",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'aucune_promotion',
      r.get_json())
check("et aucun role n'est pose", not any('SET role' in s for s in sqls(cur)))

# Expiration evaluee par la requete.
_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                         'routes_comptes.py'), encoding='utf-8').read()
_lecture = _src[_src.index('def _promotion_en_attente'):_src.index('def proposer_promotion')]
check("la lecture d'une proposition filtre les expirees en SQL",
      'expires_at > now()' in _lecture)


# ===========================================================================
print("\n=== Annuler : le proposant peut se retracter ===")

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('player',)),
    (r"FROM promotions_proposees", PROMO),
    (r"UPDATE promotions_proposees", None),
    (r"INSERT INTO audit_admin", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.delete('/admin/comptes/2/promotion', headers=H)
_s = sqls(cur)
check("annuler une proposition -> 200", r.status_code == 200, r.get_json())
check("elle passe a 'cancelled'", any('UPDATE promotions_proposees' in s for s in _s))
check("l'annulation est tracee", any('INSERT INTO audit_admin' in s for s in _s))

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('player',)),
    (r"FROM promotions_proposees", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.delete('/admin/comptes/2/promotion', headers=H)
check("annuler ce qui n'existe pas -> 404",
      r.status_code == 404 and (r.get_json() or {}).get('code') == 'aucune_promotion',
      r.get_json())


# ===========================================================================
print("\n=== Consentement d'un admin DEJA en poste (regularisation) ===")
# Les admins existants donnent leur consentement sans perdre leur acces.

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='admin', statut='linked')),
    (r"FROM promotions_proposees", None),
    (r"SELECT cgu_admin_accepted_at", (None, None)),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.get('/me/promotion', headers=H)
_d = r.get_json()
check("un admin sans consentement se voit demander de regulariser",
      r.status_code == 200 and _d.get('consentement_requis') is True, _d)
check("et aucune proposition n'est inventee au passage",
      _d.get('proposition') is None, _d)

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='admin', statut='linked')),
    (r"FROM promotions_proposees", None),
    (r"SELECT cgu_admin_accepted_at", (PASSE, V_ADMIN)),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
_d = cli.get('/me/promotion', headers=H).get_json()
check("un admin a jour n'est plus sollicite", _d.get('consentement_requis') is False, _d)

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='player', statut='linked')),
    (r"FROM promotions_proposees", None),
    (r"SELECT cgu_admin_accepted_at", (None, None)),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
_d = cli.get('/me/promotion', headers=H).get_json()
check("un PLAYER n'est jamais sollicite : ce consentement ne le concerne pas",
      _d.get('consentement_requis') is False, _d)

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='player', statut='linked')),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/me/cgu-admin', json={'version': V_ADMIN}, headers=H)
check("un player ne peut pas accepter la politique admin -> 403",
      r.status_code == 403 and (r.get_json() or {}).get('code') == 'non_concerne',
      r.get_json())

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='admin', statut='linked')),
    (r"UPDATE comptes", None),
    (r"INSERT INTO audit_admin", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/me/cgu-admin', json={'version': V_ADMIN}, headers=H)
_s = sqls(cur)
check("un admin regularise son consentement -> 200", r.status_code == 200, r.get_json())
check("sans qu'aucun role ne soit touche : il l'a deja",
      not any('SET role' in s for s in _s), [s for s in _s if 'SET role' in s])
check("et le geste est trace", any('INSERT INTO audit_admin' in s for s in _s))


# ===========================================================================
print("\n=== Les routes de reponse sont ouvertes au TITULAIRE, pas aux admins ===")
# /me/promotion doit etre joignable par un player.
_prop = _src[_src.index("@comptes_bp.route('/me/promotion', methods=['GET'])"):
             _src.index('def accepter_cgu_admin')]
check("/me/promotion est sous player_required, jamais sous role_required",
      '@player_required' in _prop and '@role_required' not in _prop)

_admin_routes = _src[_src.index('def proposer_promotion'):_src.index('def ma_promotion')]
check("proposer et annuler restent sous role_required(chef_admin)",
      _src.count("@role_required(ROLE_CHEF_ADMIN)\n@compte_cible_protegee\ndef proposer_promotion") == 1
      or 'ROLE_CHEF_ADMIN' in _src[:_src.index('def proposer_promotion')])

# ===========================================================================
print("\n=== Cablage frontend (source : c'est du cablage, pas du comportement) ===")
_FRONT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'frontEnd')
_fp = open(os.path.join(_FRONT, 'frontend.py'), encoding='utf-8').read()
_mc = open(os.path.join(_FRONT, 'templates', 'mon_compte.html'), encoding='utf-8').read()
_ac = open(os.path.join(_FRONT, 'templates', 'admin_comptes.html'), encoding='utf-8').read()

check("le proxy de proposition existe (cote proposant)",
      "/admin/comptes/<int:compte_id>/promotion" in _fp and "methods=['POST']" in _fp)
check("le proxy d'annulation existe",
      "methods=['DELETE']" in _fp and 'proxy_annuler_promotion' in _fp)
check("les proxys de reponse sont sous /mon-compte (titulaire)",
      "'/mon-compte/promotion'" in _fp and "'/mon-compte/cgu-admin'" in _fp)

# Le proxy purge le jeton et la copie du compte apres acceptation.
_rep = _fp[_fp.index('def repondre_promotion'):_fp.index('def accepter_cgu_admin')]
_purge = _fp[_fp.index('def _session_fermee_par_changement_de_role'):
             _fp.index('def repondre_promotion')]
check("accepter purge la copie de compte du cookie (sinon navbar perimee)",
      "_session_fermee_par_changement_de_role(" in _rep
      and "session.pop('compte'" in _purge)

check("l'ecran d'acceptation vit dans /mon-compte",
      'bloc-promotion' in _mc and '/mon-compte/promotion' in _mc)
# Ce qui engage doit etre lisible sur place.
for _phrase in ('sans limite de durée', 'votre compte est supprimé', 'à votre nom'):
    check("l'ecran dit en clair : « %s »" % _phrase, _phrase in _mc, _phrase)
check("et renvoie quand meme a la politique complete", '/confidentialite' in _mc)

check("l'ecran distingue proposition et consentement a regulariser",
      'afficherProposition' in _mc and 'afficherConsentement' in _mc)

# `.fade-in` est a opacity 0 : un element cree apres coup doit recevoir `.visible`.
import re as _re
for _m in _re.finditer(r"className\s*=\s*[^;]*fade-in[^;]*;", _mc):
    check("tout element cree en JS avec fade-in porte aussi visible",
          'visible' in _m.group(0), _m.group(0).strip())

# Le selecteur propose une promotion et change directement pour une retrogradation.
check("le selecteur de role PROPOSE au lieu de poser (promotion)",
      "'/promotion'" in _ac and "promotion = RANGS[sel.value] > RANGS[c.role]" in _ac)
check("et garde le chemin direct pour la RETROGRADATION",
      "'/role'" in _ac)
# Bouton de legs sur les lignes admin/chef_admin seulement.
_i_legs = _ac.find("leguerSuperadmin(c)")
_garde_legs = _ac[max(0, _i_legs - 700):_i_legs]
check("le bouton de legs n'est propose que sur un admin ou chef_admin",
      _i_legs > 0 and "c.role === 'admin'" in _garde_legs
      and "c.role === 'chef_admin'" in _garde_legs, _garde_legs[-300:])
check("le badge « en attente » est affiche sur la ligne",
      'promotion_en_attente' in _ac)
check("le backend fournit ce champ a la liste des comptes",
      'promotion_en_attente' in _src)

# La politique contient la section administrateur.
_conf = open(os.path.join(_FRONT, 'templates', 'confidentialite.html'), encoding='utf-8').read()
check("la politique a une section dediee aux administrateurs",
      'Si vous êtes administrateur' in _conf)
for _point in ('Sans limite de durée', 'subsiste si votre compte est supprimé'):
    check("elle annonce : « %s »" % _point, _point in _conf, _point)

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
