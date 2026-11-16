"""Annonces du superadmin : publiees dans la cloche de tous les comptes,
retirees de partout a la suppression. Corps en mini-Markdown, rendu cote
navigateur (navbar.js) sans interpreter de HTML."""
from harness import *
from flask import Flask
from datetime import datetime, timezone
import importlib
import json

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FRONT = os.path.join(RACINE, '..', 'frontEnd')
H = {'X-Session-Token': 'tok'}
QUAND = datetime(2026, 11, 16, 20, 0, tzinfo=timezone.utc)


def monter(plan=(), role='superadmin'):
    plan = list(plan) + [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=1, discord_id='111', username='boss',
                       global_name='Boss', role=role)),
    ]
    cur, conn = install_db(plan)
    recharger()
    sys.modules.pop('routes_comptes', None)
    import auth
    importlib.reload(auth)
    import routes_comptes
    importlib.reload(routes_comptes)
    app = Flask(__name__)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client(), cur, conn


def requetes(cur, motif):
    return [(s, p) for s, p in cur.executed if motif in s]


def ecritures(cur):
    """Ecritures de la fonctionnalite (l'auth, elle, touche sa session et valide)."""
    return [s for s, _ in cur.executed
            if re.search(r'^(INSERT INTO|DELETE FROM|UPDATE) (annonces|notifications|audit_admin)\b', s)]


def audits(cur, action):
    return [(p, json.loads(p[4])) for s, p in cur.executed
            if 'INSERT INTO audit_admin' in s and p and p[0] == action]


print("\n=== Publication : une notification par compte, rattachee a l'annonce ===")
cli, cur, conn = monter([(r"INSERT INTO annonces", (12,))])
r = cli.post('/admin/annonces', headers=H,
             json={'titre': '  Mise à jour   du 16/11 ', 'corps': '- **DNF**\r\n- tiers'})
check("201", r.status_code == 201, (r.status_code, r.get_json()))
ins = requetes(cur, 'INSERT INTO annonces')
check("l'annonce est enregistrée, titre nettoyé, fins de ligne normalisées",
      ins and ins[0][1] == ('Mise à jour du 16/11', '- **DNF**\n- tiers'), ins)
notifs = requetes(cur, 'INSERT INTO notifications')
check("les notifications sont déposées en un seul INSERT … SELECT",
      len(notifs) == 1 and 'SELECT id' in notifs[0][0], notifs)
check("  pour les comptes non suspendus",
      notifs and "statut <> 'suspended'" in notifs[0][0])
check("  rattachées à l'annonce, de type « annonce », sans lien",
      notifs and notifs[0][1] == (12, 'annonce', 'Mise à jour du 16/11',
                                  '- **DNF**\n- tiers', None), notifs and notifs[0][1])
a = audits(cur, 'annonce_publiee')
check("journalisée (annonce_publiee, cible annonce 12)",
      len(a) == 1 and a[0][0][2:4] == ('annonce', 12), a)
check("  avec le titre et le nombre de destinataires",
      a and a[0][1].get('titre') == 'Mise à jour du 16/11' and a[0][1].get('destinataires') == 1,
      a and a[0][1])
check("validée", conn.committed)
check("la réponse donne le nombre de destinataires",
      r.get_json().get('destinataires') == 1, r.get_json())

print("\n=== Corps vide : annonce sans texte ===")
cli, cur, conn = monter([(r"INSERT INTO annonces", (3,))])
r = cli.post('/admin/annonces', headers=H, json={'titre': 'Titre seul', 'corps': '   '})
ins = requetes(cur, 'INSERT INTO annonces')
check("201 et corps NULL", r.status_code == 201 and ins and ins[0][1][1] is None, ins)

print("\n=== Saisie refusée : rien n'est écrit ===")
for nom, corps in (
        ("titre absent", {'corps': 'x'}),
        ("titre blanc", {'titre': '   '}),
        ("titre non texte", {'titre': 42}),
        ("titre trop long", {'titre': 'x' * 161}),
        ("corps non texte", {'titre': 'ok', 'corps': ['x']}),
        ("corps trop long", {'titre': 'ok', 'corps': 'x' * 2001}),
):
    cli, cur, conn = monter()
    r = cli.post('/admin/annonces', headers=H, json=corps)
    check("%s -> 400" % nom, r.status_code == 400, (r.status_code, r.get_json()))
    check("  sans écriture", not ecritures(cur), ecritures(cur))
cli, cur, conn = monter([(r"INSERT INTO annonces", (4,))])
r = cli.post('/admin/annonces', headers=H, json={'titre': 'x' * 160, 'corps': 'y' * 2000})
check("160 et 2000 caractères pile passent", r.status_code == 201, r.status_code)

print("\n=== Suppression : retirée de chez tout le monde ===")
cli, cur, conn = monter([
    (r"SELECT titre FROM annonces WHERE id", ('Mise à jour',)),
    (r"DELETE FROM notifications WHERE annonce_id", None),
])
r = cli.delete('/admin/annonces/12', headers=H)
check("200", r.status_code == 200, (r.status_code, r.get_json()))
sel = requetes(cur, 'SELECT titre FROM annonces')
check("l'annonce est verrouillée avant la suppression", sel and 'FOR UPDATE' in sel[0][0], sel)
d_n = requetes(cur, 'DELETE FROM notifications')
d_a = requetes(cur, 'DELETE FROM annonces')
check("ses notifications sont supprimées, chez tous les comptes",
      len(d_n) == 1 and d_n[0][1] == (12,) and 'compte_id' not in d_n[0][0], d_n)
check("puis l'annonce elle-même", len(d_a) == 1 and d_a[0][1] == (12,), d_a)
check("  dans cet ordre", cur.executed.index(d_n[0]) < cur.executed.index(d_a[0]))
a = audits(cur, 'annonce_supprimee')
check("journalisée (annonce_supprimee) avec le titre et le nombre retiré",
      len(a) == 1 and a[0][1].get('titre') == 'Mise à jour' and 'retirees' in a[0][1], a)
check("validée", conn.committed)

cli, cur, conn = monter([(r"SELECT titre FROM annonces WHERE id", None)])
r = cli.delete('/admin/annonces/99', headers=H)
check("annonce inconnue -> 404", r.status_code == 404, r.status_code)
check("  sans suppression ni trace", not ecritures(cur), ecritures(cur))

print("\n=== Liste ===")
cli, cur, conn = monter([
    (r"FROM annonces a", [(12, 'Mise à jour', '**x**', QUAND, 40, 7),
                          (11, 'Ancienne', None, QUAND, 38, 38)]),
])
r = cli.get('/admin/annonces', headers=H)
res = r.get_json()
check("200, deux annonces", r.status_code == 200 and len(res['annonces']) == 2, res)
check("destinataires et lectures par annonce",
      res['annonces'][0] == {'id': 12, 'titre': 'Mise à jour', 'corps': '**x**',
                             'created_at': QUAND.isoformat(), 'destinataires': 40, 'lues': 7},
      res['annonces'][0])
check("les bornes de saisie sont exposées",
      res.get('titre_max') == 160 and res.get('corps_max') == 2000, res)

print("\n=== Réservé au superadmin ===")
for role in ('chef_admin', 'admin', 'player'):
    for meth, url, corps in (('get', '/admin/annonces', None),
                             ('post', '/admin/annonces', {'titre': 'x'}),
                             ('delete', '/admin/annonces/1', None)):
        cli, cur, conn = monter(role=role)
        r = getattr(cli, meth)(url, headers=H, json=corps)
        check("%s : %s %s -> 403" % (role, meth.upper(), url), r.status_code == 403,
              r.status_code)
        check("  rien n'est lu ni écrit",
              not requetes(cur, 'annonces') and not ecritures(cur), ecritures(cur))

print("\n=== notifier_tous garde ses appelants ===")
cli, cur, conn = monter()
import routes_comptes
n = routes_comptes.notifier_tous(cur, 'recap_publie', 'Récap', 'Texte', lien='/recap/x')
ins = requetes(cur, 'INSERT INTO notifications')
check("sans annonce : annonce_id NULL, le reste inchangé",
      ins and ins[0][1] == (None, 'recap_publie', 'Récap', 'Texte', '/recap/x'), ins)

print("\n=== Schéma et migration ===")
schema = open(os.path.join(RACINE, 'schema.sql'), encoding='utf-8').read()
check("schema.sql : notifications.annonce_id en cascade",
      'annonce_id  integer REFERENCES public.annonces(id) ON DELETE CASCADE' in schema)
check("  la table annonces est créée avant notifications",
      0 <= schema.find('CREATE TABLE public.annonces') < schema.find('CREATE TABLE public.notifications'))
check("  et supprimée au reset du schéma", 'DROP TABLE IF EXISTS public.annonces CASCADE' in schema)
migr = open(os.path.join(RACINE, 'migrations', '2026-11-16_annonces.sql'), encoding='utf-8').read()
check("migration : cascade aussi", 'REFERENCES public.annonces(id) ON DELETE CASCADE' in migr)

print("\n=== Front : page et menu réservés au superadmin ===")
front = open(os.path.join(FRONT, 'frontend.py'), encoding='utf-8').read()
page = front[front.index("def admin_annonces"):front.index("def proxy_annonces")]
check("la page /admin/annonces exige le rôle superadmin", "!= 'superadmin'" in page)
navbar = open(os.path.join(FRONT, 'templates', 'navbar.html'), encoding='utf-8').read()
i = navbar.index('href="/admin/annonces"')
check("l'entrée du menu est sous {% if role_admin == 'superadmin' %}",
      navbar.rfind("{% if role_admin == 'superadmin' %}", 0, i) > navbar.rfind('{% endif %}', 0, i))
js = open(os.path.join(FRONT, 'static', 'js', 'navbar.js'), encoding='utf-8').read()
rendu = js[js.index('const MKNotifs'):js.index('window.MKNotifs')]
check("le mini-Markdown n'utilise innerHTML que pour l'icône (texte fixe)",
      rendu.count('innerHTML') == 1 and "ico.innerHTML" in rendu)
check("seules les annonces passent par le Markdown", "n.type === 'annonce'" in rendu)

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
