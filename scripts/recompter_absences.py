#!/usr/bin/env python3
"""Recalcule `joueurs.consecutive_missed` en sessions manquees.

Pour chaque joueur ayant deja joue : nombre de sessions posterieures a sa
derniere participation qui le concernaient. Une session sans ligue concerne
tout le monde, une session de ligue N les joueurs de la ligue N ; un joueur
sans ligue est rattache a la ligue la plus faible (plus grand `niveau`).
L'appartenance a une ligue est deduite des participations reelles, pas de
`joueurs.ligue_id`.

`is_ranked` est recalcule ; `sigma` et `ghost_log` ne sont pas touches. Les
joueurs sans participation sont ignores.

Usage, depuis la racine du projet :
    make recompter-absences DRY=1   # affiche ce qui changerait, n'ecrit rien
    make recompter-absences         # applique

Equivalent sans make :
    docker compose exec -T backend python - [--dry-run] < scripts/recompter_absences.py

Faire un dump avant d'appliquer.
"""
from __future__ import annotations

import sys

import psycopg2.extras

from constants import DEFAULT_UNRANKED_THRESHOLD
from db import get_db_connection


def charger_ligue_la_plus_faible(cur) -> int | None:
    """Id de la ligue de plus grand `niveau` (celle des joueurs sans ligue)."""
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

            # Date d'une session : celle de son premier tournoi ; ligue : celle
            # de ses tournois (une session ne melange pas deux ligues).
            cur.execute("""
                SELECT session_id, min(date) AS date_session, min(ligue_id) AS ligue_id
                FROM Tournois
                GROUP BY session_id
                ORDER BY date_session
            """)
            sessions = cur.fetchall()

            # Derniere participation de chaque joueur et ligues ou il a joue.
            cur.execute("""
                SELECT p.joueur_id, max(t.date) AS derniere
                FROM Participations p
                JOIN Tournois t ON t.id = p.tournoi_id
                GROUP BY p.joueur_id
            """)
            derniere_partie = dict(cur.fetchall())

            # Sessions jouees par joueur : deux sessions peuvent tomber le meme
            # jour, la date seule ne suffit pas.
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

                # Ligues du joueur ; a defaut, la plus faible.
                mes_ligues = ligues_jouees.get(jid) or (
                    {ligue_faible} if ligue_faible is not None else set())

                # Manquee : posterieure a sa derniere partie, non jouee, et le
                # concernant.
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
