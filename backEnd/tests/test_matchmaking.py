"""Fidelite du portage de buildLobbies() depuis matchmaking.html.

Aucun runtime JS n'etait disponible : les cas attendus ci-dessous ont donc ete
derives A LA MAIN en deroulant le JS d'origine, et non produits par le code
teste. Comparer une implementation a elle-meme ne prouverait rien.
"""
from harness import *
import random

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
install_db([])
from services import construire_lobbies

def j(*scores):
    return [{"nom": "J%d" % i, "ts": s} for i, s in enumerate(scores)]

def tailles(lobbies):
    return [len(l) for l in lobbies]

def noms(lobbies):
    return [[p["nom"] for p in l] for l in lobbies]

print("\n=== Cas dégénérés ===")
check("aucun joueur -> aucun lobby", construire_lobbies([]) == [])
check("un seul joueur -> un lobby", tailles(construire_lobbies(j(50))) == [1])
check("10 joueurs -> un seul lobby (pas de découpe)", tailles(construire_lobbies(j(*range(10)))) == [10])

print("\n=== n=11 : le pivot reste dans le premier lobby ===")
# Derive a la main : k=2, base=5, pivots=1, idx_pivot=5.
# dessus=joueurs[4]=60, pivot=joueurs[5]=50, dessous=joueurs[6]=40
# ecart_dessus=10, ecart_dessous=10 -> 10<=10 vrai -> il RESTE. tailles=[6,5]
r = construire_lobbies(j(100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0))
check("égalité d'écart -> le pivot reste (<=)", tailles(r) == [6, 5], tailles(r))
check("découpe contiguë et ordonnée",
      noms(r) == [['J0','J1','J2','J3','J4','J5'], ['J6','J7','J8','J9','J10']], noms(r))

# ecart_dessus=1, ecart_dessous=19 -> il reste
r = construire_lobbies(j(100, 90, 80, 70, 60, 59, 40, 30, 20, 10, 0))
check("pivot plus proche du dessus -> il reste", tailles(r) == [6, 5], tailles(r))

print("\n=== n=11 : le pivot bascule dans le lobby suivant ===")
# dessus=joueurs[4]=60, pivot=joueurs[5]=40, dessous=joueurs[6]=39
# ecart_dessus=20, ecart_dessous=1 -> 20<=1 faux -> il BASCULE. tailles=[5,6]
r = construire_lobbies(j(100, 90, 80, 70, 60, 40, 39, 30, 20, 10, 0))
check("pivot plus proche du dessous -> il bascule", tailles(r) == [5, 6], tailles(r))
check("le pivot est bien en tête du second lobby",
      noms(r)[1][0] == 'J5', noms(r))

print("\n=== n=25 et n=26 : plusieurs pivots ===")
r = construire_lobbies(j(*range(25, 0, -1)))
check("n=25 -> 3 lobbies, 25 joueurs", len(r) == 3 and sum(tailles(r)) == 25, tailles(r))
check("n=25 -> un seul pivot à placer", sorted(tailles(r)) == [8, 8, 9], tailles(r))
r = construire_lobbies(j(*range(26, 0, -1)))
check("n=26 -> deux pivots", sorted(tailles(r)) == [8, 9, 9], tailles(r))

print("\n=== Le tri est fait par le service, pas par l'appelant ===")
r = construire_lobbies(j(10, 100, 50, 70, 30))
check("entrée désordonnée -> lobby trié décroissant",
      [p["ts"] for p in r[0]] == [100, 70, 50, 30, 10], r[0])

print("\n=== Invariants, sur 400 tirages aléatoires ===")
random.seed(20260902)
ok_partition = ok_taille = ok_ordre = ok_nb = ok_ecart = True
for _ in range(400):
    n = random.randint(1, 97)
    joueurs = [{"nom": "P%d" % i, "ts": round(random.uniform(0, 100), 3)} for i in range(n)]
    lob = construire_lobbies(joueurs)

    plats = [p for l in lob for p in l]
    if len(plats) != n or {p["nom"] for p in plats} != {p["nom"] for p in joueurs}:
        ok_partition = False
    if any(len(l) > 10 for l in lob):
        ok_taille = False
    if [p["ts"] for p in plats] != sorted((p["ts"] for p in joueurs), reverse=True):
        ok_ordre = False
    if len(lob) != -(-n // 10):
        ok_nb = False
    t = [len(l) for l in lob]
    if t and max(t) - min(t) > 1:
        ok_ecart = False

check("chaque joueur apparaît exactement une fois", ok_partition)
# Ces deux invariants ÉCHOUAIENT sur le JS d'origine : un lobby pouvait
# atteindre base+2, soit 11 joueurs pour une limite de 10 (≈3 % des cas).
check("aucun lobby ne dépasse 10 joueurs [corrigé vs le JS d'origine]", ok_taille)
check("l'ordre décroissant global est préservé (tranches contiguës)", ok_ordre)
check("le nombre de lobbies vaut toujours ceil(n/10)", ok_nb)
check("les tailles ne diffèrent jamais de plus de 1 [corrigé vs le JS d'origine]", ok_ecart)

print("\n=== Le cas qui débordait avant correctif (n=29) ===")
scores_29 = [97.36, 95.65, 95.03, 94.37, 88.26, 85.57, 78.14, 73.62, 73.61, 68.45,
             67.72, 64.79, 61.69, 60.63, 60.15, 58.53, 56.16, 46.81, 43.37, 40.91,
             37.66, 36.32, 36.24, 30.56, 30.4, 27.73, 27.13, 23.75, 16.47]
r = construire_lobbies(j(*scores_29))
check("n=29 donne [9,11,9] avant correctif, [10,10,9] ou équivalent après",
      max(tailles(r)) <= 10 and sum(tailles(r)) == 29, tailles(r))

print("\n=== Le lobby 1 contient bien les meilleurs ===")
r = construire_lobbies(j(*range(30, 0, -1)))
check("le meilleur score est dans le lobby 1", r[0][0]["ts"] == 30)
check("le plus faible est dans le dernier lobby", r[-1][-1]["ts"] == 1)

print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
