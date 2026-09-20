"""Une notification mene a ce dont elle parle.

Le lien est FIGE a l'emission, comme le titre et le corps le sont deja. Ce
fichier verrouille les deux moities de cette regle :

  1. Chaque decision depose bien l'URL attendue, construite au moment ou elle
     est prise -- pas un identifiant qu'on re-resoudrait a l'affichage, ce qui
     supposerait que la cible existe encore.

  2. Deux types n'ont deliberement PAS de lien : `promotion_acceptee` et
     `promotion_refusee` sont des accuses de reception adresses au proposant.
     Sans test, un tel NULL se relit comme un oubli, et quelqu'un le
     « corrigera » vers /admin/comptes -- ou le proposant retrograde entre-temps
     se fera rediriger vers l'accueil.

Aucun Postgres : le curseur est scripte. Ce fichier valide donc qui ecrit quoi
et avec quels parametres, pas le SQL lui-meme.
"""
from harness import *
from flask import Flask
import importlib


def monter(plan, role='chef_admin', compte_id=1, joueur_id=None):
    """Appli minimale portant routes_comptes, sur un curseur scripte."""
    plan = list(plan) + [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=compte_id, discord_id='111', username='admin',
                       global_name='Admin', role=role, joueur_id=joueur_id)),
    ]
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


def notif_inseree(cur):
    """(type, titre, corps, lien) de la notification deposee, ou None.

    Passe par les parametres et non par le SQL : c'est la valeur reellement
    ecrite qui nous interesse.
    """
    for sql, params in cur.executed:
        if 'INSERT INTO notifications' in sql and params:
            return params[-4:] if len(params) >= 4 else None
    return None


print("\n=== Liaison approuvee -> la fiche joueur, par son id ===")
# L'URL canonique est /joueur/<id> et non /stats/joueur/<nom> : le nom bouge,
# et emporterait le lien avec lui.
cli, cur, conn = monter([
    (r"SELECT d\.compte_id, d\.joueur_id, d\.statut", (5, 9, 'pending', None)),
    (r"SELECT id FROM comptes WHERE joueur_id", None),
    (r"SELECT nom FROM joueurs WHERE id", ('Mario',)),
    (r"SELECT joueur_id FROM comptes WHERE id", (None,)),
])
r = cli.post('/admin/liaisons/3/approve', headers=H)
n = notif_inseree(cur)
check("une notification est deposee", n is not None, [s for s, _ in cur.executed][:6])
if n:
    check("type = liaison_approuvee", n[0] == 'liaison_approuvee', n[0])
    check("lien -> /joueur/9 (id, pas nom)", n[3] == '/joueur/9', n[3])


print("\n=== Liaison refusee -> refaire une demande ===")
cli, cur, conn = monter([
    (r"SELECT compte_id, joueur_id, statut FROM liaisons_demandes", (5, 9, 'pending')),
])
r = cli.post('/admin/liaisons/3/reject', json={'motif': 'doublon'}, headers=H)
n = notif_inseree(cur)
check("type = liaison_refusee", n and n[0] == 'liaison_refusee', n)
check("lien -> /mon-compte/liaison", n and n[3] == '/mon-compte/liaison', n and n[3])


print("\n=== Promotion proposee -> le bloc qui porte les boutons ===")
cli, cur, conn = monter([
    (r"SELECT role, statut FROM comptes WHERE id", ('player', 'linked')),
    (r"FROM promotions_proposees WHERE compte_id", None),
    (r"INSERT INTO promotions_proposees", (7, FUTUR)),
])
r = cli.post('/admin/comptes/5/promotion', json={'role': 'admin'}, headers=H)
n = notif_inseree(cur)
check("type = promotion_proposee", n and n[0] == 'promotion_proposee', n)
check("lien -> l'ancre du bloc, pas la page nue",
      n and n[3] == '/mon-compte#bloc-promotion', n and n[3])


print("\n=== Les accuses de reception n'ont PAS de lien (choix, pas oubli) ===")
# Refus : la notification part au PROPOSANT, qui n'a rien a faire dessus -- et
# qui a pu perdre l'acces a /admin/comptes entre-temps.
cli, cur, conn = monter([
    (r"SELECT role FROM comptes WHERE id", ('player',)),
    (r"FROM promotions_proposees WHERE compte_id", (7, 'admin', 99, PASSE, FUTUR)),
], role='player', compte_id=5)
r = cli.post('/me/promotion', json={'accepte': False}, headers=H)
n = notif_inseree(cur)
check("type = promotion_refusee", n and n[0] == 'promotion_refusee', n)
check("lien NULL", n and n[3] is None, n and n[3])

cli, cur, conn = monter([
    (r"SELECT role FROM comptes WHERE id", ('player',)),
    (r"FROM promotions_proposees WHERE compte_id", (7, 'admin', 99, PASSE, FUTUR)),
], role='player', compte_id=5)
r = cli.post('/me/promotion', json={'accepte': True, 'cgu_admin_version': '1.0'}, headers=H)
n = notif_inseree(cur)
check("type = promotion_acceptee", n and n[0] == 'promotion_acceptee', n)
check("lien NULL", n and n[3] is None, n and n[3])


print("\n=== Deliement -> redemander un rattachement ===")
cli, cur, conn = monter([
    (r"SELECT joueur_id, statut FROM comptes WHERE id", (9, 'linked')),
    (r"SELECT nom FROM joueurs WHERE id", ('Mario',)),
])
r = cli.post('/admin/comptes/5/delier', headers=H)
n = notif_inseree(cur)
check("type = liaison_annulee", n and n[0] == 'liaison_annulee', n)
check("lien -> /mon-compte/liaison", n and n[3] == '/mon-compte/liaison', n and n[3])


print("\n=== L'API rend le lien, sinon rien n'est cliquable ===")
cli, cur, conn = monter([
    (r"FROM notifications WHERE compte_id",
     [(1, 'tournoi_ajoute', 'Nouveau tournoi', 'corps', PASSE, None, '/stats/tournoi/12')]),
], role='player', compte_id=5)
r = cli.get('/me/notifications', headers=H)
corps = r.get_json()
check("200", r.status_code == 200, corps)
check("le SELECT demande la colonne lien",
      any('lien' in s for s, _ in cur.executed if 'FROM notifications' in s))
check("lien present dans la reponse",
      corps['notifications'][0].get('lien') == '/stats/tournoi/12',
      corps['notifications'][0])


print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
