#!/usr/bin/env python3
"""Remet `joueurs.consecutive_missed` a jour, en comptant des SESSIONS manquees.

POURQUOI. Le compteur a ete alimente pendant des mois par un systeme qui
raisonnait en jours, puis par des regles successives (mode ligue active puis
desactive, filtre par ligue de derniere apparition, et un defaut de
revert_last_tournament qui decrementait toute la base sans clause WHERE,
corrige le 14/09). Sa valeur actuelle porte la trace cumulee de tout cela : sur
le dump du 15/09, 20 joueurs sur 41 affichaient un compteur en ecart avec le
nombre reel de sessions ecoulees depuis leur derniere partie -- jusqu'a 14
sessions manquantes.

Ce script n'essaie pas de deviner « la bonne valeur d'origine » : elle n'existe
pas. Il IMPOSE une definition unique et la calcule pour tout le monde.

CE QU'IL NE FAIT PAS. Il ne touche ni `sigma`, ni `ghost_log` : aucune penalite
n'est appliquee ni annulee rétroactivement. C'est un compteur qu'on remet a
jour, pas un historique qu'on rejoue. `is_ranked` est en revanche recalcule,
puisqu'il derive directement du compteur et du seuil `unranked_threshold`.

LA DEFINITION APPLIQUEE. Pour chaque joueur ayant deja joue : le nombre de
sessions posterieures a sa derniere participation, dans lesquelles il etait
concerne.

« Concerne » suit la regle de ligue du projet :
  - une session SANS ligue concerne tout le monde ;
  - une session de ligue N ne concerne que les joueurs de la ligue N ;
  - un joueur sans ligue voit ses absences comptees sur la LIGUE LA PLUS FAIBLE
    (le plus grand `niveau` dans la table Ligues).

L'appartenance a une ligue est deduite des PARTICIPATIONS reelles du joueur sur
la periode de ce mode ligue, et non de `joueurs.ligue_id` : cette colonne porte
l'etat courant, et le schema ne conserve aucun historique d'appartenance. Un
joueur qui n'a jamais joue en ligue est donc rattache a la ligue la plus faible,
par la regle ci-dessus.

Les joueurs n'ayant jamais participe a aucun tournoi ne sont pas touches : leur
compteur ne mesure rien.

Usage, depuis la racine du projet :
    make recompter-absences DRY=1   # affiche ce qui changerait, n'ecrit rien
    make recompter-absences         # applique

Equivalent sans make :
    docker compose exec -T backend python - [--dry-run] < scripts/recompter_absences.py

⚠️ Prendre un dump avant d'appliquer : `consecutive_missed` ne se rembobine pas
par un revert de code (docs/plan-sessions-tournois.md 12.1).
"""
from __future__ import annotations

import sys

import psycopg2.extras

from constants import DEFAULT_UNRANKED_THRESHOLD
from db import get_db_connection


def charger_ligue_la_plus_faible(cur) -> int | None:
    """Id de la ligue de plus grand `niveau` -- celle ou tombent les sans-ligue."""
    cur.execute("SELECT id FROM Ligues ORDER BY niveau DESC, id DESC LIMIT 1")
    row = cur.fetchone()
    return row[0] if row else None


def main() -> None:
    dry_run = '--dry-run' in sys.argv

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT value FROM Configuration WHERE key = 'unranked_threshold'")
            row = cur.fetchone()
            seuil = int(row[0]) if row else DEFAULT_UNRANKED_THRESHOLD

            ligue_faible = charger_ligue_la_plus_faible(cur)

            # Une session = une occasion de jeu. Sa date est celle de son
            # tournoi le plus ancien, sa ligue celle de ses tournois (le
            # backfill garantit qu'une session ne melange pas deux ligues).
            cur.execute("""
                SELECT session_id, min(date) AS date_session, min(ligue_id) AS ligue_id
                FROM Tournois
                GROUP BY session_id
                ORDER BY date_session
            """)
            sessions = cur.fetchall()

            # Derniere participation de chaque joueur, et ligues dans lesquelles
            # il a reellement joue (pour deduire son appartenance d'epoque).
            cur.execute("""
                SELECT p.joueur_id, max(t.date) AS derniere
                FROM Participations p
                JOIN Tournois t ON t.id = p.tournoi_id
                GROUP BY p.joueur_id
            """)
            derniere_partie = dict(cur.fetchall())

            # Sessions auxquelles chaque joueur a participe. Comparer les dates
            # ne suffit pas : deux sessions distinctes peuvent tomber le meme
            # jour (lobbies non lies), et « date > derniere_partie » les
            # exclurait toutes les deux.
            cur.execute("""
                SELECT DISTINCT p.joueur_id, t.session_id
                FROM Participations p
                JOIN Tournois t ON t.id = p.tournoi_id
            """)
            sessions_jouees: dict[int, set] = {}
            for jid, sid in cur.fetchall():
                sessions_jouees.setdefault(jid, set()).add(sid)

            cur.execute("""
                SELECT DISTINCT p.joueur_id, t.ligue_id
                FROM Participations p
                JOIN Tournois t ON t.id = p.tournoi_id
                WHERE t.ligue_id IS NOT NULL
            """)
            ligues_jouees: dict[int, set] = {}
            for jid, lid in cur.fetchall():
                ligues_jouees.setdefault(jid, set()).add(lid)

            cur.execute("""
                SELECT id, nom, COALESCE(consecutive_missed, 0), is_ranked
                FROM Joueurs
                ORDER BY nom
            """)
            joueurs = cur.fetchall()

            batch = []
            inchanges = 0
            jamais_joue = 0

            for jid, nom, missed_actuel, is_ranked in joueurs:
                derniere = derniere_partie.get(jid)
                if derniere is None:
                    jamais_joue += 1
                    continue

                # Les ligues qui concernent ce joueur. Un joueur qui n'a jamais
                # joue en ligue est rattache a la ligue la plus faible.
                mes_ligues = ligues_jouees.get(jid) or (
                    {ligue_faible} if ligue_faible is not None else set())

                # Une session compte comme manquee si elle est posterieure a la
                # derniere partie du joueur, qu'il n'y a pas participe, et
                # qu'elle le concernait (regle de ligue ci-dessus).
                #
                # Le test de participation n'est pas redondant avec celui de la
                # date : deux sessions distinctes peuvent tomber le meme jour,
                # et le joueur peut avoir joue l'une sans jouer l'autre.
                mes_sessions = sessions_jouees.get(jid, ())
                manquees = sum(
                    1 for sid, date_session, ligue_session in sessions
                    if date_session >= derniere
                    and sid not in mes_sessions
                    and (ligue_session is None or ligue_session in mes_ligues)
                )

                if manquees == missed_actuel:
                    inchanges += 1
                    continue

                nouveau_ranked = manquees < seuil
                batch.append((jid, nom, missed_actuel, manquees, is_ranked, nouveau_ranked))

            print("Seuil de declassement : %d absences. Ligue la plus faible : %s."
                  % (seuil, ligue_faible if ligue_faible is not None else "aucune"))
            print("%d session(s) dans l'historique, %d joueur(s) examines.\n"
                  % (len(sessions), len(joueurs)))

            if not batch:
                print("Aucun compteur a corriger.")
                return

            print("%-18s %9s %9s %s" % ("joueur", "actuel", "corrige", "is_ranked"))
            for _jid, nom, avant, apres, r_avant, r_apres in batch:
                drapeau = ""
                if r_avant != r_apres:
                    drapeau = "  %s -> %s" % (r_avant, r_apres)
                print("%-18s %9d %9d%s" % (nom[:18], avant, apres, drapeau))

            hausses = sum(1 for b in batch if b[3] > b[2])
            baisses = sum(1 for b in batch if b[3] < b[2])
            declasses = sum(1 for b in batch if b[4] and not b[5])
            reclasses = sum(1 for b in batch if not b[4] and b[5])

            print("\n%d corrige(s) : %d en hausse, %d en baisse. %d inchange(s), "
                  "%d sans participation (ignores)."
                  % (len(batch), hausses, baisses, inchanges, jamais_joue))
            if declasses or reclasses:
                print("is_ranked : %d declasse(s), %d reclasse(s)." % (declasses, reclasses))
            print("Aucun sigma touche, aucune penalite ajoutee ni retiree.")

            if dry_run:
                print("\n[dry-run] rien n'a ete ecrit.")
                return

            psycopg2.extras.execute_values(cur, """
                UPDATE Joueurs AS j
                SET consecutive_missed = data.missed, is_ranked = data.ranked
                FROM (VALUES %s) AS data(id, missed, ranked)
                WHERE j.id = data.id
            """, [(b[0], b[3], b[5]) for b in batch])
            conn.commit()
            print("\n%d compteur(s) mis a jour." % len(batch))


if __name__ == '__main__':
    main()
