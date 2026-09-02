from harness import *
from flask import Flask

def monter(plan, role='admin'):
    """Monte le blueprint des comptes avec une session au role voulu."""
    plan = list(plan) + [
        (r"FROM sessions_joueurs s JOIN comptes c",
         ligne_session(compte_id=1, discord_id='111', username='admin',
                       global_name='Admin', role=role)),
    ]
    cur, conn = install_db(plan)
    recharger()
    sys.modules.pop('routes_comptes', None)
    sys.modules.pop('cache', None)
    import cache
    appels = {'invalidate': 0}
    cache.invalidate_cache = lambda: appels.__setitem__('invalidate', appels['invalidate'] + 1)
    import routes_comptes
    app = Flask(__name__)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client(), cur, conn, appels

H = {'X-Session-Token': 'tok'}

print("\n=== R-08 : joueurs-disponibles n'expose pas qui possède un compte ===")
cli, cur, conn, _ = monter([(r"FROM joueurs j LEFT JOIN comptes c", None)], role='player')
cli.get('/auth/joueurs-disponibles', headers=H)
sql = ' '.join(s for s, _ in cur.executed if 'FROM joueurs' in s)
check("filtre sur les joueurs sans compte", 'c.id IS NULL' in sql, sql[:120])
check("exclut les fiches anonymisées", 'anonymise_at IS NULL' in sql)

print("\n=== Demande de liaison : les refus ===")
cli, cur, conn, _ = monter([
    (r"FROM sessions_joueurs s JOIN comptes c",
     ligne_session(compte_id=5, discord_id='222', joueur_id=9)),   # deja lie
], role='player')
r = cli.post('/auth/demande-liaison', json={'joueur_id': 3}, headers=H)
check("compte déjà rattaché -> 409", r.status_code == 409 and r.get_json()['code'] == 'deja_lie', r.get_json())

cli, cur, conn, _ = monter([
    (r"SELECT nom FROM joueurs WHERE id", ('Mario',)),
    (r"SELECT 1 FROM comptes WHERE joueur_id", (1,)),                  # fiche prise
    (r"FROM sessions_joueurs s JOIN comptes c",
     ligne_session(compte_id=5, discord_id='222', statut='pending')),
], role='player')
r = cli.post('/auth/demande-liaison', json={'joueur_id': 3}, headers=H)
check("fiche déjà rattachée -> 409", r.status_code == 409 and r.get_json()['code'] == 'joueur_deja_pris', r.get_json())

cli, cur, conn, _ = monter([
    (r"SELECT nom FROM joueurs WHERE id", ('Mario',)),
    (r"SELECT 1 FROM comptes WHERE joueur_id", None),
    (r"WHERE compte_id = %s AND statut = 'pending'", (12,)),           # demande en cours
    (r"FROM sessions_joueurs s JOIN comptes c",
     ligne_session(compte_id=5, discord_id='222', statut='pending')),
], role='player')
r = cli.post('/auth/demande-liaison', json={'joueur_id': 3}, headers=H)
check("demande déjà en cours -> 409 (pas une 500 d'index unique)",
      r.status_code == 409 and r.get_json()['code'] == 'demande_en_cours', r.get_json())

print("\n=== R-07 : course à l'approbation ===")
cli, cur, conn, _ = monter([
    (r"FROM liaisons_demandes d WHERE d.id", (5, 9, 'pending')),
    (r"SELECT id FROM comptes WHERE joueur_id = %s FOR UPDATE", (77,)),  # pris entre-temps
])
r = cli.post('/admin/liaisons/1/approve', headers=H)
check("fiche prise entre-temps -> 409 explicite",
      r.status_code == 409 and r.get_json()['code'] == 'joueur_deja_pris', r.get_json())
check("verrou posé sur la demande", any('FOR UPDATE' in s for s, _ in cur.executed))
check("verrou posé sur la fiche joueur convoitée",
      any('FROM comptes WHERE joueur_id = %s FOR UPDATE' in s for s, _ in cur.executed))
check("transaction annulée", conn.rolledback or not conn.committed)

cli, cur, conn, _ = monter([(r"FROM liaisons_demandes d WHERE d.id", (5, 9, 'approved'))])
r = cli.post('/admin/liaisons/1/approve', headers=H)
check("demande déjà traitée -> 409", r.status_code == 409 and r.get_json()['code'] == 'deja_traitee')

cli, cur, conn, _ = monter([
    (r"FROM liaisons_demandes d WHERE d.id", (5, 9, 'pending')),
    (r"SELECT id FROM comptes WHERE joueur_id = %s FOR UPDATE", None),
])
r = cli.post('/admin/liaisons/1/approve', headers=H)
sqls = [s for s, _ in cur.executed]
check("approbation nominale -> 200", r.status_code == 200, r.get_json())
check("compte rattaché et passé en 'linked'",
      any("UPDATE comptes SET joueur_id = %s, statut = 'linked'" in s for s in sqls))
check("approbation auditée", any('INSERT INTO audit_admin' in s for s in sqls))
check("l'approbation ne renomme AUCUN joueur",
      not any('UPDATE joueurs SET nom' in s for s in sqls))

print("\n=== R-41 : synchronisation du pseudo ===")
def plan_sync(nom_actuel, username, global_name, collision=None):
    return [
        (r"FROM comptes c LEFT JOIN joueurs j", (username, global_name, 9, nom_actuel)),
        (r"WHERE lower\(nom\) = lower\(%s\) AND id <> %s", collision),
    ]

cli, cur, conn, _ = monter(plan_sync('Mario', 'toto', 'Toto', collision=(4, 'toto')))
r = cli.post('/admin/comptes/5/sync', headers=H)
check("collision de nom (insensible à la casse) -> 409",
      r.status_code == 409 and r.get_json()['code'] == 'collision_nom', r.get_json())
check("le joueur en conflit est nommé à l'admin", 'joueur_en_conflit' in r.get_json())
check("aucun renommage effectué", not any('UPDATE joueurs SET nom' in s for s, _ in cur.executed))

cli, cur, conn, _ = monter(plan_sync('Mario', 'a/b', 'a/b'))
r = cli.post('/admin/comptes/5/sync', headers=H)
check("pseudo contenant « / » -> 409 (casse /stats/joueur/<nom>)",
      r.status_code == 409 and r.get_json()['code'] == 'pseudo_invalide', r.get_json())

cli, cur, conn, _ = monter(plan_sync('Toto', 'toto', 'Toto'))
r = cli.post('/admin/comptes/5/sync', headers=H)
check("déjà synchronisé -> 409", r.status_code == 409 and r.get_json()['code'] == 'deja_synchro')

cli, cur, conn, _ = monter([(r"FROM comptes c LEFT JOIN joueurs j", ('toto', 'Toto', None, None))])
r = cli.post('/admin/comptes/5/sync', headers=H)
check("compte non rattaché -> 409", r.status_code == 409 and r.get_json()['code'] == 'non_lie')

cli, cur, conn, appels = monter(plan_sync('Mario', 'toto', 'Toto'))
r = cli.post('/admin/comptes/5/sync', headers=H)
sqls = [s for s, _ in cur.executed]
check("synchronisation nominale -> 200", r.status_code == 200, r.get_json())
check("renommage effectué", any('UPDATE joueurs SET nom' in s for s in sqls))
check("cache invalidé (sinon l'admin croit que rien ne s'est passé)", appels['invalidate'] == 1)
check("avant/après tracés dans l'audit",
      any('INSERT INTO audit_admin' in s for s in sqls)
      and any(p and 'Mario' in str(p) and 'Toto' in str(p) for _, p in cur.executed))

print("\n--- l'aperçu donne le même verdict que l'écriture ---")
cli, cur, conn, _ = monter(plan_sync('Mario', 'toto', 'Toto', collision=(4, 'toto')))
ra = cli.get('/admin/comptes/5/sync-preview', headers=H)
check("aperçu refuse aussi la collision", ra.status_code == 409 and ra.get_json()['code'] == 'collision_nom')
# On exclut le UPDATE de last_seen_at : c'est la comptabilité de session du
# décorateur, pas l'aperçu.
check("l'aperçu n'écrit rien",
      not any('UPDATE' in s and 'sessions_joueurs' not in s for s, _ in cur.executed),
      [s for s, _ in cur.executed if 'UPDATE' in s])

print("\n=== R-40 / R-38 : les rôles ===")
cli, cur, conn, _ = monter([(r"SELECT role FROM comptes WHERE id", ('player',))], role='admin')
r = cli.post('/admin/comptes/5/role', json={'role': 'superadmin'}, headers=H)
check("un admin ne peut PAS attribuer de rôle -> 403", r.status_code == 403, r.status_code)

cli, cur, conn, _ = monter([
    (r"SELECT role FROM comptes WHERE id", ('superadmin',)),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (0,)),
], role='superadmin')
r = cli.post('/admin/comptes/5/role', json={'role': 'player'}, headers=H)
check("rétrograder le DERNIER superadmin -> 409",
      r.status_code == 409 and r.get_json()['code'] == 'dernier_superadmin', r.get_json())
check("aucune écriture du rôle", not any('UPDATE comptes SET role' in s for s, _ in cur.executed))

cli, cur, conn, _ = monter([
    (r"SELECT role FROM comptes WHERE id", ('superadmin',)),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role = %s AND id <> %s", (1,)),
], role='superadmin')
r = cli.post('/admin/comptes/5/role', json={'role': 'player'}, headers=H)
check("rétrogradation possible s'il en reste un autre -> 200", r.status_code == 200, r.get_json())
check("changement de rôle audité", any('INSERT INTO audit_admin' in s for s, _ in cur.executed))

cli, cur, conn, _ = monter([(r"SELECT role FROM comptes WHERE id", ('player',))], role='superadmin')
r = cli.post('/admin/comptes/5/role', json={'role': 'root'}, headers=H)
check("rôle inconnu -> 400", r.status_code == 400 and r.get_json()['code'] == 'role_invalide')

print("\n=== Suspension : fermer les sessions, pas seulement l'étiquette ===")
cli, cur, conn, _ = monter([(r"SELECT statut FROM comptes WHERE id", ('linked',))])
r = cli.post('/admin/comptes/5/statut', json={'statut': 'suspended'}, headers=H)
check("suspension -> 200", r.status_code == 200)
check("sessions du compte fermées dans la foulée",
      any('DELETE FROM sessions_joueurs WHERE compte_id' in s for s, _ in cur.executed))

print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
