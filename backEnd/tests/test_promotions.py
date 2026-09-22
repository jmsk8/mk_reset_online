"""La promotion au rang d'admin est une PROPOSITION, pas un decret.

Phase 1bis de docs/audit-admin-plan.md. Ce que ce fichier verrouille :

  1. Le role n'est JAMAIS pose a la proposition -- seulement a l'acceptation,
     par la personne elle-meme. C'est l'invariant central : un tiers ne peut
     pas consentir a la place de quelqu'un dont les actions seront ensuite
     tracees nominativement, sans limite de duree, et au-dela de la
     suppression de son compte.

  2. Les plafonds par acteur de `changer_role` valent AUSSI pour la
     proposition. Sans ca, proposer un role qu'on n'a pas le droit
     d'attribuer contournerait la hierarchie par un detour.

  3. Les garde-fous de concurrence de `liaisons_demandes` (R-07) sont repris :
     verrous FOR UPDATE, et un 409 lisible sur chaque cas que l'index unique
     partiel transformerait sinon en 500.

Aucun Postgres : le curseur est scripte. Ce fichier ne valide donc pas le SQL
lui-meme, mais qui ecrit quoi, dans quel ordre, et sous quelles conditions.
"""
from harness import *
from flask import Flask
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
    (r"SELECT role FROM comptes WHERE id = %s", ('player',)),          # cible_protegee
    (r"SELECT role, statut FROM comptes WHERE id = %s FOR UPDATE", ('player', 'linked')),
    (r"FROM promotions_proposees", None),                              # aucune en attente
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
# Sans ca, proposer serait un contournement de la hierarchie : on proposerait
# un role qu'on n'a pas le droit d'attribuer, et l'acceptation le poserait.

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
# `idx_promotion_pending_compte` garantit UNE proposition en attente par
# compte. Sans ces refus explicites, la seconde proposition heurterait
# l'index et remonterait en 500 -- illisible pour qui la declenche.

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=1, role='superadmin', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s", ('player',)),
    (r"SELECT role, statut FROM comptes WHERE id = %s FOR UPDATE", ('player', 'linked')),
    (r"FROM promotions_proposees", PROMO),      # une est deja en attente
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

# Un compte suspendu ne peut pas se connecter, donc ne pourra jamais accepter :
# la proposition resterait en attente jusqu'a expiration, en bloquant l'index.
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


# ===========================================================================
print("\n=== Accepter : c'est ICI, et seulement ici, que le role est pose ===")

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='player', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('player',)),
    (r"FROM promotions_proposees", PROMO),
    (r"UPDATE promotions_proposees", None),
    (r"UPDATE comptes", None),
    (r"INSERT INTO audit_admin", None),
    (r"INSERT INTO notifications", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/me/promotion', json={'accepte': True, 'cgu_admin_version': '1.0'}, headers=H)
_s = sqls(cur)
_params = [p for s, p in cur.executed if 'UPDATE comptes' in s]

check("accepter -> 200", r.status_code == 200, r.get_json())
check("le role EST pose a l'acceptation",
      any('SET role' in s for s in _s), _s)
check("et le consentement admin est enregistre DANS LE MEME UPDATE",
      any('cgu_admin_accepted_at' in s for s in _s))
check("la version acceptee est stockee, pas seulement la date "
      "-- c'est ce qui permet de demontrer QUOI a ete accepte",
      any('1.0' in str(p) for p in _params), _params)
check("la proposition passe a 'accepted'",
      any('UPDATE promotions_proposees' in s for s in _s))
check("l'attribution est tracee", any('INSERT INTO audit_admin' in s for s in _s))
check("le proposant est notifie de l'acceptation",
      any('INSERT INTO notifications' in s for s in _s))

# Le verrou sur le COMPTE doit precede celui sur la proposition, dans le meme
# ordre que proposer_promotion -- sinon deux transactions qui se croisent
# s'interbloquent (R-07).
_ordre = [i for i, s in enumerate(_s) if 'FOR UPDATE' in s]
check("le compte est verrouille AVANT la proposition (ordre anti-interblocage)",
      len(_ordre) >= 2 and 'FROM comptes' in _s[_ordre[0]],
      [_s[i][:60] for i in _ordre])


# ===========================================================================
print("\n=== Accepter : le role et la politique sont UN SEUL geste ===")
# Les separer laisserait un admin trace sans l'avoir su : il aurait le role, et
# le consentement resterait a demander « plus tard ».

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
# Expiree, annulee, ou jamais faite : meme reponse. Le message doit dire que la
# proposition a pu expirer, sinon le refus parait arbitraire.

cli, cur, conn = monter([
    (r"FROM sessions_joueurs s\s+JOIN comptes c",
     ligne_session(compte_id=5, role='player', statut='linked')),
    (r"SELECT role FROM comptes WHERE id = %s FOR UPDATE", ('player',)),
    (r"FROM promotions_proposees", None),
    (r"UPDATE sessions_joueurs SET last_seen_at", None),
])
r = cli.post('/me/promotion', json={'accepte': True, 'cgu_admin_version': '1.0'}, headers=H)
check("repondre a une proposition absente/expiree -> 409",
      r.status_code == 409 and (r.get_json() or {}).get('code') == 'aucune_promotion',
      r.get_json())
check("et aucun role n'est pose", not any('SET role' in s for s in sqls(cur)))

# L'expiration est portee par la REQUETE, pas par un balayage : une ligne
# expiree reste en base (l'historique a de la valeur) mais n'ouvre plus rien.
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
# La migration ne retrograde personne : les admins existants gardent leur role
# et n'ont pas de consentement enregistre. L'ecran le leur demandera sans
# bloquer leur acces -- c'est une regularisation, pas une punition.

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
    (r"SELECT cgu_admin_accepted_at", (PASSE, '1.0')),
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
r = cli.post('/me/cgu-admin', json={'version': '1.0'}, headers=H)
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
r = cli.post('/me/cgu-admin', json={'version': '1.0'}, headers=H)
_s = sqls(cur)
check("un admin regularise son consentement -> 200", r.status_code == 200, r.get_json())
check("sans qu'aucun role ne soit touche : il l'a deja",
      not any('SET role' in s for s in _s), [s for s in _s if 'SET role' in s])
check("et le geste est trace", any('INSERT INTO audit_admin' in s for s in _s))


# ===========================================================================
print("\n=== Les routes de reponse sont ouvertes au TITULAIRE, pas aux admins ===")
# /me/promotion doit etre joignable par un player : c'est tout l'interet. Si
# elle exigeait un role admin, la personne ne pourrait jamais accepter celui
# qu'on lui propose.
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

# Accepter change le role en base : la copie figee dans le cookie devient
# fausse, et la navbar continuerait d'afficher un player.
_rep = _fp[_fp.index('def repondre_promotion'):_fp.index('def accepter_cgu_admin')]
check("accepter purge la copie de compte du cookie (sinon navbar perimee)",
      "session.pop('compte'" in _rep)

check("l'ecran d'acceptation vit dans /mon-compte",
      'bloc-promotion' in _mc and '/mon-compte/promotion' in _mc)
# Une case a cocher renvoyant vers une politique que personne n'ouvre ne vaut
# pas consentement : ce qui engage doit etre lisible sur place.
# « votre compte est supprimé » et non plus « vous supprimez votre compte » :
# depuis le 2026-09-22 le titulaire ne supprime plus lui-meme, il le demande.
# Ce que la phrase doit dire ne change pas -- le journal survit au compte.
for _phrase in ('sans limite de durée', 'votre compte est supprimé', 'à votre nom'):
    check("l'ecran dit en clair : « %s »" % _phrase, _phrase in _mc, _phrase)
check("et renvoie quand meme a la politique complete", '/confidentialite' in _mc)

check("l'ecran distingue proposition et consentement a regulariser",
      'afficherProposition' in _mc and 'afficherConsentement' in _mc)

# Piege reel, rencontre le 2026-09-19 : `.fade-in` vaut `opacity: 0`, et c'est
# `.visible` qui la revele. Le balayage qui pose `.visible` ne tourne qu'au
# CHARGEMENT de la page -- un element cree par fetch apres coup reste donc
# invisible, present dans le DOM, sans la moindre erreur en console. Le defaut
# est silencieux par construction : on voit une page vide et rien n'explique
# pourquoi.
import re as _re
for _m in _re.finditer(r"className\s*=\s*[^;]*fade-in[^;]*;", _mc):
    check("tout element cree en JS avec fade-in porte aussi visible",
          'visible' in _m.group(0), _m.group(0).strip())

# Le selecteur de role doit router : proposer pour une promotion, changer pour
# une retrogradation. S'il appelait /role dans les deux cas, la promotion
# redeviendrait un decret.
check("le selecteur de role PROPOSE au lieu de poser (promotion)",
      "'/promotion'" in _ac and "promotion = sel.value !== 'player'" in _ac)
check("et garde le chemin direct pour la RETROGRADATION",
      "'/role'" in _ac)
check("le badge « en attente » est affiche sur la ligne",
      'promotion_en_attente' in _ac)
check("le backend fournit ce champ a la liste des comptes",
      'promotion_en_attente' in _src)

# La politique doit porter la section « en tant qu'administrateur » AVANT que
# quiconque accepte : un consentement a un texte qui n'existe pas ne vaut rien.
_conf = open(os.path.join(_FRONT, 'templates', 'confidentialite.html'), encoding='utf-8').read()
check("la politique a une section dediee aux administrateurs",
      'Si vous êtes administrateur' in _conf)
for _point in ('Sans limite de durée', 'subsiste si votre compte est supprimé'):
    check("elle annonce : « %s »" % _point, _point in _conf, _point)

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
