"""Textes affiches sur l'Indice de Performance (IP).

Les chiffres sont calcules depuis constants.py pour rester a jour.
"""
from __future__ import annotations

import math

from constants import (
    MIN_PARTICIPATION_RATIO, GM_MAX_RATIO_CAP, GM_EXTRA_MATCH_BONUS,
    GM_BASE_WEIGHT_V1, GM_BASE_WEIGHT_V2, IP_V2_FORCE_LOBBY_PER_MU,
    IP_VERSION_DEFAULT, IP_SEUIL_ETOILE, IP_SEUIL_BON, IP_SEUIL_MOYEN,
)

VERSIONS = ("v1", "v2")

# Tailles de lobby de l'exemple affiche (illustratives).
_LOBBY_EXEMPLE_GRAND = 12
_LOBBY_EXEMPLE_PETIT = 4
# Nombre de tournois de l'exemple de minimum non entier (40 % de 7 = 2,8).
_SAISON_EXEMPLE = 7

_NOMS = {"v1": "IP brute", "v2": "IP ajustée"}

_RESUMES_ADMIN = {
    "v1": "Compare les points de chaque joueur à la moyenne de son lobby. "
          "Le niveau des adversaires ne compte pas.",
    "v2": "Même comparaison, corrigée par le niveau (Mu) du lobby : bien jouer "
          "contre plus fort rapporte plus. Utile quand une session est coupée "
          "en lobbies de niveaux différents.",
}


def _fr(x: float) -> str:
    """Nombre au format francais, deux decimales au plus (0.3 -> « 0,3 »)."""
    texte = f"{round(x, 2):.2f}".rstrip("0").rstrip(".")
    return texte.replace(".", ",")


def _pct(ratio: float) -> str:
    """0.4 -> « 40 % »."""
    return f"{_fr(ratio * 100)}\u00a0%"


def _tournois(n: int, participe: str = "") -> str:
    s = "s" if n > 1 else ""
    return f"{n} tournoi{s}" + (f" {participe}{s}" if participe else "")


def _version(version: str | None) -> str:
    return version if version in VERSIONS else IP_VERSION_DEFAULT


def minimum_tournois(total_tournois: int) -> int:
    """Nombre de tournois a jouer pour etre classe.

    Meme calcul que le test d'eligibilite de services.py.
    """
    if total_tournois <= 0:
        return 0
    return math.ceil(total_tournois * MIN_PARTICIPATION_RATIO)


def textes_ip(version: str | None) -> dict:
    """Nom et resume d'une version, independants de la saison."""
    v = _version(version)
    nom = _NOMS[v]
    return {
        "version": v,
        "nom": nom,
        "badge": f"{v} · {nom}",
        "infobulle_colonne": f"Indice de Performance — {nom} ({v})",
        "resume_admin": _RESUMES_ADMIN[v],
    }


def _facteur_lobby(version: str) -> str:
    """Poids d'un lobby de 12 face a un lobby de 4 (« 1,9 » en v1)."""
    base = GM_BASE_WEIGHT_V2 if version == "v2" else GM_BASE_WEIGHT_V1
    return _fr(round((_LOBBY_EXEMPLE_GRAND + base) / (_LOBBY_EXEMPLE_PETIT + base), 1))


def _explication(version: str, total_tournois: int, contexte: str) -> list[dict]:
    """Paragraphes de la modale ; `texte` prolonge `titre` quand il existe."""
    plafond = _fr(GM_MAX_RATIO_CAP * 100)
    facteur = _facteur_lobby(version)
    exemple = _fr(_SAISON_EXEMPLE * MIN_PARTICIPATION_RATIO)

    assiduite = (
        f" — Pour être classé, il faut avoir joué au moins "
        f"{_pct(MIN_PARTICIPATION_RATIO)} des tournois."
    )
    if total_tournois > 0:
        n = minimum_tournois(total_tournois)
        quand = "Sur cette saison" if contexte == "recap" else "Pour l'instant"
        assiduite += f" {quand} : {_tournois(n)} sur {total_tournois}."
    assiduite += (
        f" Chaque tournoi joué au-delà ajoute {_fr(GM_EXTRA_MATCH_BONUS)} point."
        f" Quand ce minimum tombe entre deux tournois ({_pct(MIN_PARTICIPATION_RATIO)}"
        f" de {_SAISON_EXEMPLE} = {exemple}), le premier tournoi au-dessus"
        f" rapporte un peu moins."
    )

    if version == "v2":
        return [
            {"titre": None,
             "texte": "L'IP mesure à quel point vous dominez vos lobbies, tournoi "
                      "après tournoi, en tenant compte du niveau de vos adversaires."},
            {"titre": "À chaque tournoi",
             "texte": ", vos points sont comparés à la moyenne de vos adversaires ; "
                      "les vôtres n'en font pas partie. Le résultat est ensuite ajusté "
                      "selon le niveau que TrueSkill leur attribue. Face à un lobby plus "
                      "fort que la moyenne des joueurs classés ce jour-là, il monte ; "
                      "face à un lobby plus faible, il baisse, d'environ "
                      f"{_pct(IP_V2_FORCE_LOBBY_PER_MU)} par point de niveau d'écart. "
                      f"Un tournoi rapporte au maximum {plafond}."},
            {"titre": "Sur la saison",
             "texte": ", votre IP est la moyenne de vos tournois. Les lobbies bien "
                      "remplis pèsent un peu plus lourd : un tournoi à "
                      f"{_LOBBY_EXEMPLE_GRAND} joueurs compte environ {facteur} fois "
                      f"plus qu'un tournoi à {_LOBBY_EXEMPLE_PETIT}."},
            {"titre": "Assiduité", "texte": assiduite},
            {"titre": None,
             "texte": "Ici, 100 correspond à une performance moyenne face à des "
                      "adversaires de niveau moyen. Cette version sert surtout quand "
                      "une soirée est coupée en plusieurs lobbies de niveaux "
                      "différents : à performance égale, le lobby le plus relevé "
                      "rapporte davantage."},
        ]

    return [
        {"titre": None,
         "texte": "L'IP mesure à quel point vous dominez vos lobbies, tournoi après tournoi."},
        {"titre": "À chaque tournoi",
         "texte": ", vos points sont comparés à la moyenne de votre lobby. Faire "
                  "exactement la moyenne vaut 100 ; faire 20\u00a0% de plus vaut 120. "
                  f"Un tournoi rapporte au maximum {plafond}, même si vous écrasez "
                  "tout le monde."},
        {"titre": "Sur la saison",
         "texte": ", votre IP est la moyenne de vos tournois. Les lobbies bien "
                  f"remplis pèsent plus lourd : un tournoi à {_LOBBY_EXEMPLE_GRAND} "
                  f"joueurs compte environ {facteur} fois plus qu'un tournoi à "
                  f"{_LOBBY_EXEMPLE_PETIT}."},
        {"titre": "Assiduité", "texte": assiduite},
        {"titre": None,
         "texte": "Dans cette version, seuls les points comptent : le niveau de vos "
                  "adversaires n'entre pas en jeu."},
    ]


def _legende() -> list[dict]:
    """Paliers de couleur, du meilleur au moins bon."""
    return [
        {"niveau": "etoile", "libelle": f"{IP_SEUIL_ETOILE} et plus", "sens": "domination"},
        {"niveau": "bon", "libelle": f"{IP_SEUIL_BON} à {IP_SEUIL_ETOILE}", "sens": "au-dessus du lot"},
        {"niveau": "moyen", "libelle": f"{IP_SEUIL_MOYEN} à {IP_SEUIL_BON}", "sens": "dans la moyenne"},
        {"niveau": "bas", "libelle": f"moins de {IP_SEUIL_MOYEN}", "sens": "en dessous"},
    ]


def _note_rouge(total_tournois: int, contexte: str) -> str:
    """Explication d'un IP en rouge (le gabarit ajoute « En rouge : » devant)."""
    n = minimum_tournois(total_tournois)
    if contexte == "recap":
        return (f"moins de {_tournois(n, 'joué')} sur {total_tournois} "
                f"({_pct(MIN_PARTICIPATION_RATIO)} minimum). Cet IP est donné à "
                f"titre indicatif.")
    return (f"pas encore assez de tournois joués ({n} minimum sur "
            f"{total_tournois} pour l'instant). Ces joueurs ne peuvent pas encore "
            f"prendre la tête, et le minimum augmente au fil des tournois.")


def bloc_ip(version: str | None, total_tournois: int, contexte: str) -> dict:
    """Bloc `ip` d'un payload public.

    `contexte` vaut « recap » ou « classement ».
    """
    v = _version(version)
    total = int(total_tournois or 0)
    textes = textes_ip(v)
    portee = "ce récap" if contexte == "recap" else "le classement en cours"
    return {
        **textes,
        "ligne_version": f"Version utilisée pour {portee} : {textes['badge']}",
        "explication": _explication(v, total, contexte),
        "legende": _legende(),
        "note_rouge": _note_rouge(total, contexte),
        "seuils": {"etoile": IP_SEUIL_ETOILE, "bon": IP_SEUIL_BON, "moyen": IP_SEUIL_MOYEN},
        "minimum_tournois": minimum_tournois(total),
        "total_tournois": total,
    }
