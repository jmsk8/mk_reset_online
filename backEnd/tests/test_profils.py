from harness import *
from flask import Flask

def monter(plan):
    plan = list(plan) + [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=7, discord_id='333', joueur_id=9)),
    ]
    cur, conn = install_db(plan)
    recharger()
    sys.modules.pop('routes_comptes', None)
    import routes_comptes
    app = Flask(__name__)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client(), cur, conn, routes_comptes

H = {'X-Session-Token': 'tok'}

print("\n=== Les réseaux : on stocke un handle, jamais une URL ===")
cli, cur, conn, rc = monter([])
# Le danger : une URL fournie par l'utilisateur atterrit dans un href.
for mauvais, quoi in [
    ('javascript:alert(1)',            'javascript:'),
    ('https://evil.example/x',         'URL complète'),
    ('data:text/html,<script>a</script>', 'data:'),
    ('a b',                            'espace'),
    ('x' * 60,                         'trop long'),
    ('<script>',                       'balise'),
    ('"onload="alert(1)',              'échappement d attribut'),
]:
    r = cli.put('/me/profil', json={'reseaux': {'twitch': mauvais}}, headers=H)
    check("refusé : %s" % quoi, r.status_code == 400, r.status_code)

r = cli.put('/me/profil', json={'reseaux': {'monsite': 'toto'}}, headers=H)
check("réseau hors liste blanche refusé", r.status_code == 400, r.status_code)

cli, cur, conn, rc = monter([])
r = cli.put('/me/profil', json={'reseaux': {'twitch': 'j_sk8'}}, headers=H)
check("handle valide accepté", r.status_code == 200, r.get_json())
url = r.get_json()['reseaux_affichables']['twitch']['url']
check("URL construite côté serveur", url == 'https://twitch.tv/j_sk8', url)
check("l'URL commence toujours par https://",
      all(u.startswith('https://') for u in rc.RESEAUX_CONNUS.values()))

print("\n=== Couleur d'accent ===")
for mauvais in ['red', '#GGG', '#12345', 'rgb(1,2,3)', '#123456; background:url(x)']:
    cli, cur, conn, rc = monter([])
    r = cli.put('/me/profil', json={'couleur_accent': mauvais}, headers=H)
    check("couleur refusée : %s" % mauvais, r.status_code == 400, r.status_code)
cli, cur, conn, rc = monter([])
r = cli.put('/me/profil', json={'couleur_accent': '#4a9dec'}, headers=H)
check("#RRGGBB accepté et normalisé", r.status_code == 200 and r.get_json()['couleur_accent'] == '#4A9DEC',
      r.get_json())

print("\n=== R-40 : la liste blanche des champs éditables ===")
cli, cur, conn, rc = monter([])
r = cli.put('/me/profil', json={
    'bio': 'coucou', 'role': 'superadmin', 'statut': 'linked',
    'joueur_id': 1, 'compte_id': 99,
}, headers=H)
check("requête acceptée (les champs inconnus sont ignorés)", r.status_code == 200)
ecrits = ' '.join(s for s, _ in cur.executed if 'INSERT INTO profils' in s)
check("seule la table profils est écrite",
      not any('UPDATE comptes' in s or 'comptes SET role' in s for s, _ in cur.executed))
check("le rôle n'apparaît dans aucun paramètre",
      not any(p and 'superadmin' in str(p) for _, p in cur.executed))
check("l'écriture ne cible que bio/couleur/reseaux",
      'bio' in ecrits and 'couleur_accent' in ecrits and 'reseaux' in ecrits and 'role' not in ecrits)

print("\n=== Bio ===")
cli, cur, conn, rc = monter([])
r = cli.put('/me/profil', json={'bio': ' ' * 10}, headers=H)
check("bio vide -> None (pas une chaîne d'espaces)", r.get_json()['bio'] is None, r.get_json())
cli, cur, conn, rc = monter([])
r = cli.put('/me/profil', json={'bio': 'x' * 900}, headers=H)
check("bio tronquée à 500 (la colonne fait 500)", len(r.get_json()['bio']) == 500)
cli, cur, conn, rc = monter([])
check("bio non textuelle refusée",
      cli.put('/me/profil', json={'bio': {'a': 1}}, headers=H).status_code == 400)

print("\n=== Profil public : ce qui sort, et ce qui ne sort pas ===")
cli, cur, conn, rc = monter([])
cur.plan = [(r"FROM comptes c LEFT JOIN profils p",
             ('123456789012345678', 'abc', 'ma bio', '#FF0000', {'twitch': 'j_sk8', 'monsite': 'x'}))]
pub = rc.profil_public(cur, 9)
check("bio publiée", pub['bio'] == 'ma bio')
check("réseau hors liste blanche filtré à l'affichage aussi", 'monsite' not in pub['reseaux'])
check("avatar servi par le CDN Discord", pub['avatar_url'].startswith('https://cdn.discordapp.com/'))
check("ni rôle ni statut dans la charge publique",
      'role' not in pub and 'statut' not in pub and 'discord_id' not in pub)
sql = ' '.join(s for s, _ in cur.executed)
check("seuls les comptes 'linked' sont publiés", "statut = 'linked'" in sql, sql[:150])

cur.plan = [(r"FROM comptes c LEFT JOIN profils p", None)]
check("joueur sans compte -> pas de profil", rc.profil_public(cur, 9) is None)

print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
