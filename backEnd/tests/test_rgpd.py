"""Droits RGPD : acces, portabilite, effacement, purges.

L'assertion qui compte : supprimer un compte ne doit toucher NI joueurs, NI
participations, NI awards. Le moteur TrueSkill etant incremental et non
recalculable, y toucher fausserait le classement de tout le monde sans moyen de
le reconstruire.
"""
from harness import *
from flask import Flask

def monter(plan, joueur_id=9, role='player'):
    plan = list(plan) + [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(joueur_id=joueur_id, role=role)),
    ]
    cur, conn = install_db(plan)
    recharger()
    sys.modules.pop('routes_comptes', None)
    sys.modules.pop('services', None)
    import routes_comptes
    app = Flask(__name__)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client(), cur, conn, routes_comptes

H = {'X-Session-Token': 'tok'}

print("\n=== Effacement : ce qui part et ce qui reste ===")
cli, cur, conn, _ = monter([])
r = cli.delete('/me', headers=H)
sqls = [s for s, _ in cur.executed]
check("suppression -> 200", r.status_code == 200, r.get_json())

efface = [s for s in sqls if s.startswith('DELETE FROM')]
tables_effacees = {s.split('DELETE FROM ')[1].split()[0].lower() for s in efface}
check("efface sessions, profil, demandes et compte",
      tables_effacees == {'sessions_joueurs', 'profils', 'liaisons_demandes', 'comptes'},
      tables_effacees)

for table in ('joueurs', 'participations', 'awards_obtenus', 'tournois', 'ghost_log',
              'league_movements', 'grille_snapshots'):
    check("le dossier sportif est intact : aucun DELETE sur %s" % table,
          not any(('delete from %s' % table) in s.lower() for s in sqls))
check("aucun UPDATE sur joueurs non plus",
      not any('update joueurs' in s.lower() for s in sqls))

print("\n=== Traçabilité de la suppression ===")
idx_audit = next(i for i, s in enumerate(sqls) if 'INSERT INTO audit_admin' in s)
idx_delete = next(i for i, s in enumerate(sqls) if 'DELETE FROM comptes' in s)
check("l'audit est écrit AVANT la suppression du compte", idx_audit < idx_delete,
      (idx_audit, idx_delete))
params_audit = [p for s, p in cur.executed if 'INSERT INTO audit_admin' in s][0]
check("l'action est nommée", 'compte_supprime' in str(params_audit))
check("le snowflake Discord n'est PAS conservé en clair dans l'audit",
      '123456789012345678' not in str(params_audit), params_audit)
check("une empreinte permet quand même de rejouer la suppression après restauration",
      'discord_id_hash' in str(params_audit))
check("transaction validée", conn.committed)

print("\n=== Export ===")
class CurExport(type(cur)):
    pass
cli, cur, conn, _ = monter([])
cur.plan = [
    (r"SELECT discord_id, discord_username", ('123', 'toto', 'Toto', 'h', 9, 'linked',
                                              'player', None, None, PASSE, PASSE, PASSE, PASSE, PASSE)),
    (r"SELECT bio, couleur_accent", ('ma bio', '#FF0000', {'twitch': 'x'}, PASSE)),
    (r"SELECT nom, mu, sigma, score_trueskill", ('Mario', 50.0, 2.0, 44.0, 'A', True, '#FFF')),
    (r"FROM sessions_joueurs s JOIN comptes c", ligne_session(joueur_id=9)),
]
cur.fetchall = lambda: []
r = cli.get('/me/export', headers=H)
d = r.get_json()
check("export -> 200", r.status_code == 200, d)
for cle in ('compte', 'profil', 'sessions_actives', 'demandes_de_liaison', 'dossier_sportif'):
    check("l'export contient « %s »" % cle, cle in d, list(d))
check("l'export avertit que le dossier sportif survit à la suppression",
      'avertissement' in d and 'PAS supprim' in d['avertissement'], d.get('avertissement'))
check("le dossier sportif est exporté aussi (portabilité)",
      d['dossier_sportif'] is not None and d['dossier_sportif']['nom'] == 'Mario')

print("\n=== Consentement ===")
cli, cur, conn, _ = monter([])
r = cli.post('/me/cgu', headers=H)
check("acceptation -> 200", r.status_code == 200)
sql = ' '.join(s for s, _ in cur.executed if 'UPDATE comptes' in s)
check("la date ET la version sont enregistrées",
      'cgu_accepted_at' in sql and 'cgu_version' in sql, sql)
check("la version acceptée est renvoyée", r.get_json().get('cgu_version') == '1.0')

print("\n=== Purges : ce qu'elles ne doivent PAS emporter ===")
install_db([])
recharger()
sys.modules.pop('services', None)
import services
cur2, _ = install_db([])
services.purger_donnees_expirees(cur2)
sqls2 = [s for s, _ in cur2.executed]
purge_comptes = [s for s in sqls2 if 'DELETE FROM comptes' in s][0]
check("un compte lié à un joueur n'est jamais purgé", 'joueur_id IS NULL' in purge_comptes, purge_comptes)
check("un compte porteur d'un rôle n'est jamais purgé", "role = 'player'" in purge_comptes)
check("seuls les comptes 'pending' sont concernés", "statut = 'pending'" in purge_comptes)
# On cible la TABLE et pas la sous-chaîne : « sessions_joueurs » contient
# « joueurs », et l'assertion naïve tombait dessus.
import re as _re
_tables = {m.group(1).lower()
           for s in sqls2
           for m in _re.finditer(r'(?:DELETE FROM|UPDATE|INTO)\s+(\w+)', s)}
check("la purge ne touche ni joueurs, ni participations, ni awards",
      not (_tables & {'joueurs', 'participations', 'awards_obtenus', 'tournois'}), _tables)
check("sessions expirées purgées", any('sessions_joueurs' in s and 'expires_at <' in s for s in sqls2))
check("invitations expirées purgées", any('DELETE FROM invitations' in s for s in sqls2))
check("liaisons refusées purgées",
      any('liaisons_demandes' in s and "rejected" in s for s in sqls2))

print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
