"""La version de l'IP arrive jusqu'a l'ecran, et chaque page dit la bonne.

Phases 2 et 3 de docs/affichage-ip-plan-redaction.md. Le defaut d'origine : ni
le recap ni le classement ne disaient quelle version de l'IP ils affichaient --
les payloads ne transmettaient meme pas `ip_version` -- et l'explication ne
decrivait que la v1, fausse pour un recap v2.

Ce fichier verifie :
  - payloads : un recap v1, un recap v2 et le classement live portent chacun
    le bloc `ip` de LEUR version (la version du recap n'est pas celle du
    reglage, et inversement) ; /admin/config porte les textes des deux ;
  - gabarits : plus aucun chiffre de l'IP ecrit en dur, plus de seuil
    95/105/115 recopie, plus d'information confiee a une infobulle seule
    (invisible au doigt), et v1/v2 jamais affichees cote a cote.

Limite : le curseur est scripte, le calcul de l'IP est remplace par des
bouchons. Ce qui est verifie ici, c'est le cheminement de la version.
"""
from harness import *
from datetime import date
from flask import Flask

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
GABARITS = os.path.join(RACINE, 'frontEnd', 'templates')


def lire(nom):
    with open(os.path.join(GABARITS, nom), encoding='utf-8') as f:
        return f.read()


# --- montage de routes_public, calcul bouchonne -----------------------------
def monter_public(plan):
    """routes_public sur un curseur scripte. Le calcul de l'IP est bouchonne :
    on enregistre la version qu'il recoit, c'est elle qu'on suit."""
    cur, conn = install_db(plan)
    recharger()
    for m in ('routes_public', 'routes_comptes', 'cache', 'services', 'textes_ip'):
        sys.modules.pop(m, None)
    import routes_public as rp
    appels = []

    def stats(d1, d2, mode, ligue, version):
        appels.append(('stats', version))
        return {"classement_points": [], "classement_moyenne": [],
                "total_tournois": 7, "candidates": {}}

    def evolution(d1, d2, mode, ligue, version):
        appels.append(('evolution', version))
        return {"labels": [], "tournoi_ids": [], "datasets": []}

    rp._aggregate_season_stats = stats
    rp.compute_ip_evolution = evolution
    rp.compute_position_evolution = lambda *a: {}
    rp.compute_position_breakdown = lambda *a: {}
    rp._determine_winners = lambda *a: ([], {})
    rp.build_distribution = lambda *a: {}
    rp.get_cached = lambda k: None
    rp.set_cached = lambda k, v: None
    app = Flask(__name__)
    app.register_blueprint(rp.public_bp)
    return app.test_client(), appels


def ligne_saison(ip_version):
    """Ligne de `saisons` lue par get_recap (13 colonnes)."""
    return (1, 'Printemps', date(2026, 3, 1), date(2026, 5, 31), 'printemps',
            {}, 'Indice de Performance', False, False, None, False, False, ip_version)


print("\n--- Recap : la version du recap, pas celle du reglage ---")
for version_base, attendue in (('v1', 'v1'), ('v2', 'v2'), (None, 'v1')):
    cli, appels = monter_public([
        (r"FROM saisons WHERE slug", ligne_saison(version_base)),
        # Le reglage live dit l'inverse : s'il fuitait dans le recap, ca se verrait.
        (r"key = 'ip_version_live'", ('v1' if attendue == 'v2' else 'v2',)),
    ])
    r = cli.get('/stats/recap/printemps')
    body = r.get_json() or {}
    ip = body.get('ip') or {}
    check(f"recap {version_base} -> 200", r.status_code == 200, (r.status_code, body))
    check(f"recap {version_base} -> bloc ip en {attendue}", ip.get('version') == attendue, ip.get('version'))
    check(f"recap {version_base} -> le calcul a tourne en {attendue} lui aussi",
          appels and all(v == attendue for _, v in appels), appels)
    check(f"recap {version_base} -> ligne de version « ce récap »",
          ip.get('ligne_version', '').startswith('Version utilisée pour ce récap'), ip.get('ligne_version'))
    check(f"recap {version_base} -> N et M du recap",
          ip.get('total_tournois') == 7 and ip.get('minimum_tournois') == 3,
          (ip.get('minimum_tournois'), ip.get('total_tournois')))
    check(f"recap {version_base} -> seuils des couleurs fournis",
          ip.get('seuils') == {'etoile': 115, 'bon': 105, 'moyen': 95}, ip.get('seuils'))


print("\n--- Classement de saison : la version du reglage en cours ---")
for live in ('v1', 'v2'):
    cli, appels = monter_public([
        (r"FROM saisons WHERE is_active", (date(2026, 5, 31),)),
        (r"SELECT MIN\(date\), MAX\(date\) FROM tournois", (date(2026, 6, 2), date(2026, 9, 20))),
        (r"key = 'league_mode_enabled'", ('false',)),
        (r"key = 'ip_version_live'", (live,)),
    ])
    r = cli.get('/classement/saison')
    body = r.get_json() or {}
    ip = body.get('ip') or {}
    check(f"live {live} -> 200", r.status_code == 200, (r.status_code, body))
    check(f"live {live} -> bloc ip en {live}", ip.get('version') == live, ip.get('version'))
    check(f"live {live} -> calcul en {live}", appels and all(v == live for _, v in appels), appels)
    check(f"live {live} -> ligne de version « classement en cours »",
          'le classement en cours' in ip.get('ligne_version', ''), ip.get('ligne_version'))
    check(f"live {live} -> note du rouge au futur (« pour l'instant »)",
          "pour l'instant" in ip.get('note_rouge', ''), ip.get('note_rouge'))


print("\n--- Graphe d'evolution : la version de la page, et elle seule ---")
# Le calcul parallele v1/v2 nourrissait une comparaison cote a cote retiree le
# 22/08 (e7f8482). S'il revenait, l'autre version repartirait dans le payload.
tournois = [(1, date(2026, 6, 1), None, 10), (2, date(2026, 6, 8), None, 11)]
parts = [(1, 1, 'A', '#fff', 80, 1, 60.0), (1, 2, 'B', '#fff', 40, 2, 45.0),
         (1, 3, 'C', '#fff', 30, 3, 40.0), (2, 1, 'A', '#fff', 70, 1, 61.0),
         (2, 2, 'B', '#fff', 50, 2, 44.0), (2, 3, 'C', '#fff', 20, 3, 41.0)]
install_db([(r"SELECT t.id, t.date, t.ligue_id, t.session_id", tournois),
            (r"SELECT p.tournoi_id, p.joueur_id", parts),
            (r"FROM grille_snapshots", []),
            (r"SELECT p.old_mu FROM participations", [(p[6],) for p in parts])])
sys.modules.pop('services', None)
import services
evo = {v: services.compute_ip_evolution('2026-06-01', '2026-06-30', None, None, v) for v in ('v1', 'v2')}
cles = {k for v in evo.values() for d in v['datasets'] for p in d['points'] if p for k in p}
check("points : seules les cles de la version demandee",
      cles == {'date', 'position', 'score', 'ip_pur', 'ip_total'}, cles)
premier = {v: evo[v]['datasets'][0]['points'][0] for v in evo}
check("v1 et v2 donnent bien des valeurs differentes (le calcul suit la version)",
      premier['v1']['ip_pur'] != premier['v2']['ip_pur'], premier)


print("\n--- /admin/config : les deux versions pour les boutons radio ---")
cur, conn = install_db([
    (r"FROM sessions_joueurs s JOIN comptes c",
     ligne_session(compte_id=1, discord_id='111', username='a', global_name='A', role='admin')),
    (r"SELECT key, value FROM Configuration WHERE key IN", [('ip_version_live', 'v2')]),
])
recharger()
for m in ('routes_admin', 'cache', 'services', 'textes_ip'):
    sys.modules.pop(m, None)
import routes_admin
app = Flask(__name__)
app.register_blueprint(routes_admin.admin_bp)
r = app.test_client().get('/admin/config', headers={'X-Session-Token': 'tok'})
body = r.get_json() or {}
textes = body.get('ip_textes') or {}
check("/admin/config -> 200", r.status_code == 200, (r.status_code, body))
check("ip_version_live toujours la", body.get('ip_version_live') == 'v2', body.get('ip_version_live'))
check("textes des deux versions", set(textes) == {'v1', 'v2'}, textes)
check("noms v1/v2", textes.get('v1', {}).get('nom') == 'IP brute'
      and textes.get('v2', {}).get('nom') == 'IP ajustée', textes)
check("resume admin present pour chaque version",
      all(textes.get(v, {}).get('resume_admin') for v in ('v1', 'v2')), textes)


print("\n--- Gabarits : plus de chiffre de l'IP ecrit en dur ---")
recap = lire('recap.html')
saison = lire('classement_saison.html')
cellule = lire('partiels/cellule_ip.html')
publics = {'recap.html': recap, 'classement_saison.html': saison}

for nom, src in publics.items():
    check(f"{nom} : aucun seuil 115/105/95 recopie",
          not re.search(r'score_gm\s*>=\s*\d', src), re.findall(r'score_gm\s*>=\s*\d+', src))
    check(f"{nom} : la cellule passe par la macro partagee",
          "import 'partiels/cellule_ip.html'" in src, nom)
    check(f"{nom} : la modale d'explication est incluse",
          "include 'partiels/explication_ip.html'" in src, nom)
    check(f"{nom} : plus de « Participation insuffisante » en infobulle seule",
          'title="Participation insuffisante"' not in src)
    check(f"{nom} : plus de « IP total » (renomme « IP après ce tournoi »)",
          'IP total' not in src and 'IP après ce tournoi' in src)
    check(f"{nom} : jamais v1 et v2 cote a cote (retire le 22/08)",
          not re.search(r'ip_(pur|total)_v[12]', src), re.findall(r'ip_(?:pur|total)_v[12]', src))
    check(f"{nom} : badge de version par la macro partagee", 'ipm.badge_ip(ip)' in src, nom)
    check(f"{nom} : notes sous le tableau par la macro partagee", 'ipm.notes_tableau_ip(ip)' in src, nom)

check("cellule : seuils lus dans le bloc ip", 'seuils.etoile' in cellule and 'seuils.bon' in cellule
      and 'seuils.moyen' in cellule and not re.search(r'>=\s*\d', cellule))
check("recap : l'ancienne explication (40% / +0,3 en dur) a disparu",
      '40%' not in recap and '+0,3' not in recap
      and "'Indice de Performance':" not in recap and "'grand_master':" not in recap)
check("recap : « IP pur » renomme « IP du tournoi »", 'IP pur' not in recap)
check("recap : le podium d'un recap IP dit « IP », pas « points »",
      re.search(r"is_ip\s*%\}\s*\{\{[^}]*\}\}\s*IP", recap) is not None)
check("recap : le ? d'un recap IP ouvre l'explication partagee",
      'onclick="ouvrirExplicationIp()"' in recap)


print("\n--- Rendu reel des partiels (Jinja) ---")
from jinja2 import Environment, FileSystemLoader
import textes_ip
env = Environment(loader=FileSystemLoader(GABARITS), autoescape=True)
IP = textes_ip.bloc_ip('v2', 7, 'recap')


def cellule(score, eligible=True, ip=IP):
    t = env.from_string("{% import 'partiels/cellule_ip.html' as ipm %}{{ ipm.cellule_ip(j, ip) }}")
    return ' '.join(t.render(j={'score_gm': score, 'is_eligible_gm': eligible}, ip=ip).split())


for score, attendu, nom in (
        (120, 'has-text-warning has-text-weight-bold">★ 120.00', 'etoile'),
        (115, 'has-text-warning has-text-weight-bold">★ 115.00', 'etoile (borne incluse)'),
        (110, 'has-text-success has-text-weight-bold">110.00', 'bon'),
        (105, 'has-text-success has-text-weight-bold">105.00', 'bon (borne incluse)'),
        (100, '<span class="has-text-white">100.00', 'moyen'),
        (95, '<span class="has-text-white">95.00', 'moyen (borne incluse)'),
        (94.99, 'opacity: 0.6;">94.99', 'bas')):
    html = cellule(score)
    check(f"cellule {score} -> {nom}", attendu in html, html)
html = cellule(130, eligible=False)
check("non classe -> rouge, sans infobulle", 'has-text-danger' in html and 'title=' not in html
      and '★' not in html, html)
check("non classe -> le tri le range quand meme", 'data-eligible="false"' in html and 'data-val="130"' in html, html)
check("pas d'IP -> tiret", '>-</span>' in cellule(None), cellule(None))
html = cellule(120, ip=None)
check("sans bloc ip (backend plus ancien) -> valeur sans couleur, pas de plantage",
      '120.00' in html and '★' not in html, html)

t = env.from_string("{% import 'partiels/cellule_ip.html' as ipm %}{{ ipm.notes_tableau_ip(ip) }}{{ ipm.badge_ip(ip) }}")
html = ' '.join(t.render(ip=IP).split())
check("notes : legende complete, chaque palier colore",
      all(p['libelle'] in html for p in IP['legende']) and '★ 115 et plus' in html, html)
check("notes : ligne du rouge, mot « rouge » en rouge",
      'En <span class="has-text-danger">rouge</span> : moins de 3 tournois joués sur 7' in html, html)
check("badge : un vrai bouton qui ouvre l'explication",
      '<button type="button"' in html and 'onclick="ouvrirExplicationIp()"' in html
      and 'v2 · IP ajustée' in html, html)
check("badge et notes absents sans bloc ip", t.render(ip=None).strip() == '')

t = env.from_string("{% include 'partiels/explication_ip.html' %}")
html = t.render(ip=IP)
check("modale : titre et ligne de version", "Comment se calcule l'IP" in html
      and 'Version utilisée pour ce récap : v2 · IP ajustée' in html)
check("modale : chaque paragraphe de l'explication", all(
      p['texte'].replace("'", '&#39;') in html for p in IP['explication']))
check("modale : titres de paragraphe en gras",
      '<strong class="has-text-white">Assiduité</strong>' in html)
check("modale : legende des couleurs (lisible sur mobile)", '★ 115 et plus' in html)
check("modale : fermeture par croix, fond, bouton et Echap",
      html.count('onclick="fermerExplicationIp()"') == 3 and "'Escape'" in html)
check("modale : rien sans bloc ip", t.render(ip=None).strip() == '')


print("\n--- Rendu reel du classement de saison ---")
payload = {
    "saison": {"nom": "Saison en cours", "slug": None, "date_debut": "02/06/2026",
               "date_fin": "20/09/2026", "victory_condition": "Indice de Performance"},
    "is_league": False,
    "classement_ip": [
        {"nom": "Alice", "moyenne_points": 70.5, "total_points": 423, "matchs": 6,
         "victoires": 3, "score_gm": 117.2, "is_eligible_gm": True},
        {"nom": "Bob", "moyenne_points": 50.0, "total_points": 100, "matchs": 2,
         "victoires": 0, "score_gm": 140.0, "is_eligible_gm": False},
    ],
    "ip_evolution": {"labels": [], "datasets": []},
    "recap_stats": {"total_tournois": 7, "nb_participants": 2, "leader": "Alice"},
    "ip": textes_ip.bloc_ip('v1', 7, 'classement'),
}
html = env.get_template('classement_saison.html').render(saison=payload)
check("classement : le badge de la version live", 'v1 · IP brute' in html)
check("classement : la modale incluse recoit le bloc ip",
      'Version utilisée pour le classement en cours : v1 · IP brute' in html)
check("classement : explication v1, pas v2",
      "n&#39;entre pas en jeu" in html and 'TrueSkill' not in html)
check("classement : leader en etoile, non classe en rouge",
      '★ 117.20' in html and 'has-text-danger" style="opacity: 0.9;">140.00' in html)
check("classement : note du rouge « pour l'instant »", "3 minimum sur 7 pour l&#39;instant" in html)
check("classement : titre sans « (IP) », le badge le remplace",
      'Classement de saison (IP)' not in html)
html = env.get_template('classement_saison.html').render(saison=dict(payload, ip=None))
check("classement sans bloc ip : la page rend quand meme", 'Alice' in html and 'explicationIpModal' not in html)


print("\n--- Admin : memes noms, depuis /admin/config ---")
reglages = lire('admin_reglages.html')
saisons_admin = lire('admin_saisons.html')
gestion = open(os.path.join(RACINE, 'frontEnd', 'static', 'js', 'gestion.js'), encoding='utf-8').read()
check("Reglages : plus de « perf brut » ni « force de lobby »",
      'perf brut' not in reglages and 'force de lobby' not in reglages)
check("Saisons : plus de « Formule actuelle » (trompeur des que le live est en v2)",
      'Formule actuelle' not in saisons_admin)
check("Reglages : libelles remplis depuis ip_textes", 'ip_textes' in gestion)
check("Saisons : libelles remplis depuis ip_textes", 'ip_textes' in saisons_admin)
check("Saisons : la liste des recaps montre la version", 's.ip_version' in saisons_admin)
check("Saisons : plus de garde « Indicateur de Performance »",
      'Indicateur de Performance' not in saisons_admin)


print("\n=== Condition de victoire IP : un seul nom depuis le 2026-09-23 ===")
# L'ancien synonyme 'grand_master' de saisons.victory_condition est retire
# (absent de tous les dumps de prod). La cle INTERNE candidates['grand_master']
# reste : c'est le classement IP, et c'est elle qui doit continuer a servir.
_cands = {'grand_master': [{'id': 1, 'nom': 'A', 'final_score': 110, 'eligible': True},
                           {'id': 2, 'nom': 'B', 'final_score': 90, 'eligible': False}]}
_top, _ = services._determine_winners(_cands, 'Indice de Performance', [], 10)
check("'Indice de Performance' lit le classement IP, eligibles seuls",
      [c['id'] for c in _top] == [1], _top)
_src = open(os.path.join(os.path.dirname(services.__file__), 'services.py'), encoding='utf-8').read()
check("plus de branche vic_cond == 'grand_master'",
      "vic_cond == 'grand_master'" not in _src)
check("recap : is_ip ne teste plus que 'Indice de Performance'",
      "victory_condition == 'Indice de Performance' %}" in recap and "'grand_master')" not in recap)

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
