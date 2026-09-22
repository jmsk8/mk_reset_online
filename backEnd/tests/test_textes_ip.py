"""Textes de l'IP : une seule source, et aucun chiffre recopie a la main.

Phase 1 de docs/affichage-ip-plan-redaction.md. Avant, l'explication de l'IP
citait « 40% » et « +0,3 pt » en dur dans un litteral JS de recap.html :
changer la constante rendait le texte faux sans aucun signal. Ce fichier est ce
signal. Il verifie que :

  - chaque chiffre affiche SUIT sa constante (on la change, le texte change) ;
  - v1 et v2 se distinguent par leur nom et leur explication ;
  - le minimum de tournois annonce (N) est EXACTEMENT celui que le classement
    applique -- un N calcule autrement afficherait une regle fausse ;
  - les nombres sont au format francais (virgule), jamais « 0.3 ».
"""
from harness import *
import importlib
import re

install_db([])
for m in ('constants', 'textes_ip', 'services'):
    sys.modules.pop(m, None)
import constants
import textes_ip


def tout_le_texte(bloc):
    """Toutes les chaines d'un bloc, a plat : c'est ce que voit le joueur."""
    morceaux = [bloc['nom'], bloc['badge'], bloc['infobulle_colonne'],
                bloc['resume_admin'], bloc['ligne_version'], bloc['note_rouge']]
    for p in bloc['explication']:
        morceaux.append((p['titre'] or '') + p['texte'])
    for palier in bloc['legende']:
        morceaux.append(palier['libelle'] + ' ' + palier['sens'])
    return '\n'.join(morceaux)


def avec_constantes(**valeurs):
    """Recharge textes_ip avec des constantes modifiees, puis rend le module.

    Le module lit ses constantes a l'import : c'est ce chemin reel qu'on
    exerce, pas une fonction qu'on appellerait avec d'autres arguments.
    """
    anciennes = {k: getattr(constants, k) for k in valeurs}
    for k, v in valeurs.items():
        setattr(constants, k, v)
    try:
        return importlib.reload(textes_ip)
    finally:
        for k, v in anciennes.items():
            setattr(constants, k, v)


print("\n--- v1 et v2 se distinguent ---")
v1 = textes_ip.bloc_ip('v1', 7, 'recap')
v2 = textes_ip.bloc_ip('v2', 7, 'recap')
check("v1 s'appelle « IP brute »", v1['nom'] == 'IP brute', v1['nom'])
check("v2 s'appelle « IP ajustée »", v2['nom'] == 'IP ajustée', v2['nom'])
check("badge v1", v1['badge'] == 'v1 · IP brute', v1['badge'])
check("badge v2", v2['badge'] == 'v2 · IP ajustée', v2['badge'])
check("les explications different", v1['explication'] != v2['explication'])
check("seule la v2 parle du niveau des adversaires via TrueSkill",
      'TrueSkill' in tout_le_texte(v2) and 'TrueSkill' not in tout_le_texte(v1))
check("la v1 dit que le niveau des adversaires n'entre pas en jeu",
      "n'entre pas en jeu" in tout_le_texte(v1))
check("les resumes admin different", v1['resume_admin'] != v2['resume_admin'])
check("infobulle de colonne nommee et versionnee",
      v2['infobulle_colonne'] == 'Indice de Performance — IP ajustée (v2)',
      v2['infobulle_colonne'])
check("version inconnue -> version par defaut, pas d'exception",
      textes_ip.textes_ip('v9')['version'] == constants.IP_VERSION_DEFAULT
      and textes_ip.textes_ip(None)['version'] == constants.IP_VERSION_DEFAULT)
check("la ligne de version dit la portee (recap)",
      v2['ligne_version'] == 'Version utilisée pour ce récap : v2 · IP ajustée',
      v2['ligne_version'])
check("la ligne de version dit la portee (classement)",
      textes_ip.bloc_ip('v1', 7, 'classement')['ligne_version']
      == 'Version utilisée pour le classement en cours : v1 · IP brute')


print("\n--- Chiffres tires des constantes (valeurs actuelles) ---")
t1, t2 = tout_le_texte(v1), tout_le_texte(v2)
check("minimum de participation : « 40 % »", '40\u00a0%' in t1, t1)
check("bonus : « 0,3 point »", '0,3 point' in t1)
check("plafond par tournoi : « 150 »", 'au maximum 150' in t1 and 'au maximum 150' in t2)
check("correction v2 : « 2 % par point »", '2\u00a0% par point' in t2)
check("exemple de minimum non entier : « 7 = 2,8 »", 'de 7 = 2,8' in t1)
check("poids d'un lobby de 12 face a 4, v1 : 1,9 fois", '1,9 fois' in t1)
check("poids d'un lobby de 12 face a 4, v2 : 1,4 fois", '1,4 fois' in t2)
check("aucun nombre au format anglais (« 0.3 »)",
      not re.search(r'\d\.\d', t1 + t2), re.findall(r'\S*\d\.\d\S*', t1 + t2))
check("aucune trace de « 40% » colle (ancienne typographie)", '40%' not in t1 + t2)


print("\n--- Changer une constante change le texte ---")
m = avec_constantes(MIN_PARTICIPATION_RATIO=0.5)
t = tout_le_texte(m.bloc_ip('v1', 7, 'recap'))
check("ratio 0.5 -> « 50 % », plus de « 40 % »", '50\u00a0%' in t and '40\u00a0%' not in t)
check("ratio 0.5 -> exemple « 7 = 3,5 »", 'de 7 = 3,5' in t)
check("ratio 0.5 -> N = 4 sur 7", m.minimum_tournois(7) == 4 and '4 tournois sur 7' in t, t)

m = avec_constantes(GM_EXTRA_MATCH_BONUS=0.5)
check("bonus 0.5 -> « 0,5 point »", '0,5 point' in tout_le_texte(m.bloc_ip('v1', 7, 'recap')))

m = avec_constantes(GM_MAX_RATIO_CAP=1.8)
t = tout_le_texte(m.bloc_ip('v2', 7, 'recap'))
check("plafond 1.8 -> « au maximum 180 »", 'au maximum 180' in t and '150' not in t, t)

m = avec_constantes(IP_V2_FORCE_LOBBY_PER_MU=0.03)
check("correction 0.03 -> « 3 % par point »",
      '3\u00a0% par point' in tout_le_texte(m.bloc_ip('v2', 7, 'recap')))

m = avec_constantes(GM_BASE_WEIGHT_V2=5.0)
check("poids de base v2 a 5 -> meme facteur que la v1 (1,9)",
      '1,9 fois' in tout_le_texte(m.bloc_ip('v2', 7, 'recap')))

m = avec_constantes(IP_SEUIL_ETOILE=120, IP_SEUIL_BON=110, IP_SEUIL_MOYEN=90)
b = m.bloc_ip('v1', 7, 'recap')
check("seuils deplaces -> legende deplacee",
      [p['libelle'] for p in b['legende']]
      == ['120 et plus', '110 à 120', '90 à 110', 'moins de 90'],
      [p['libelle'] for p in b['legende']])
check("seuils deplaces -> seuils du payload deplaces",
      b['seuils'] == {'etoile': 120, 'bon': 110, 'moyen': 90}, b['seuils'])

importlib.reload(textes_ip)   # retour aux vraies constantes pour la suite


print("\n--- Le N annonce est celui que le classement applique ---")
import services
ecarts = []
for total in range(1, 41):
    n = textes_ip.minimum_tournois(total)
    stats = {
        1: {"nom": "juste", "matchs": n, "gm_history": []},
        2: {"nom": "manque_un", "matchs": n - 1, "gm_history": []},
    }
    _, candidats = services._compute_grand_master(stats, total)
    elig = {c['nom']: c['eligible'] for c in candidats}
    if not (elig['juste'] and not elig['manque_un']):
        ecarts.append((total, n, elig))
check("pour 1 a 40 tournois : N joues = classe, N-1 = non classe", not ecarts, ecarts)
check("aucun tournoi -> minimum 0, pas d'exception", textes_ip.minimum_tournois(0) == 0)


print("\n--- Ligne sous le tableau (le rouge) ---")
r = textes_ip.bloc_ip('v1', 7, 'recap')['note_rouge']
check("recap : N et M en clair", 'moins de 3 tournois joués sur 7' in r, r)
check("recap : le minimum en pourcentage", '(40\u00a0% minimum)' in r, r)
c = textes_ip.bloc_ip('v1', 7, 'classement')['note_rouge']
check("classement : N et M, « pour l'instant »", "3 minimum sur 7 pour l'instant" in c, c)
check("classement : dit ce que le rouge empeche", 'prendre la tête' in c, c)
un = textes_ip.bloc_ip('v1', 1, 'recap')['note_rouge']
check("singulier a 1 tournoi : « 1 tournoi joué »", 'moins de 1 tournoi joué sur 1' in un, un)
e = tout_le_texte(textes_ip.bloc_ip('v1', 7, 'recap'))
check("explication du recap : « Sur cette saison : 3 tournois sur 7 »",
      'Sur cette saison : 3 tournois sur 7.' in e, e)
check("explication du classement : « Pour l'instant »",
      "Pour l'instant : 3 tournois sur 7." in tout_le_texte(textes_ip.bloc_ip('v1', 7, 'classement')))
check("saison vide : l'explication ne cite pas « 0 tournoi sur 0 »",
      'sur 0' not in ' '.join(p['texte'] for p in textes_ip.bloc_ip('v1', 0, 'recap')['explication']))


print("\n--- Forme du bloc ---")
b = textes_ip.bloc_ip('v2', 12, 'classement')
attendues = {'version', 'nom', 'badge', 'infobulle_colonne', 'resume_admin',
             'ligne_version', 'explication', 'legende', 'note_rouge', 'seuils',
             'minimum_tournois', 'total_tournois'}
check("toutes les cles attendues", attendues <= set(b), attendues - set(b))
check("N et M du bloc", b['minimum_tournois'] == 5 and b['total_tournois'] == 12,
      (b['minimum_tournois'], b['total_tournois']))
check("legende : quatre paliers, du meilleur au moins bon",
      [p['niveau'] for p in b['legende']] == ['etoile', 'bon', 'moyen', 'bas'])
check("explication : chaque paragraphe a un texte",
      all(p['texte'] for p in b['explication']) and len(b['explication']) == 5)


print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
