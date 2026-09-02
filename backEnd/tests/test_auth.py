from harness import *

print("\n=== 1. Nouveau venu avec invitation valide ===")
recharger(); install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", None),                      # compte inexistant
    (r"FROM invitations WHERE token_hash", (7, None, 1, 0, FUTUR, None)),
    (r"INSERT INTO comptes", ligne_compte()),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (0,)),
])
import auth_discord
res = auth_discord.login('code', 'invtok', 'UA/1.0')
sqls = [e[0] for e in cur.executed]
check("compte créé", res['compte']['id'] == 42)
check("invitation consommée", any('UPDATE invitations SET uses = uses + 1' in s for s in sqls))
check("session créée", any('INSERT INTO sessions_joueurs' in s for s in sqls))
check("token en clair renvoyé, absent de la base",
      res['session_token'] and all(res['session_token'] not in str(p) for _, p in cur.executed))
check("transaction validée", conn.committed)
check("avatar depuis le CDN Discord", 'cdn.discordapp.com/avatars/' in res['compte']['avatar_url'])

print("\n=== 2. Rejeu : le compte existe déjà (R-11, idempotence) ===")
recharger(); install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", (42, 'linked')),             # compte existant
    (r"INSERT INTO comptes", ligne_compte(joueur_id=9, statut='linked')),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (0,)),
])
import importlib, auth_discord; importlib.reload(auth_discord)
res2 = auth_discord.login('code2', None, 'UA')
sqls = [e[0] for e in cur.executed]
check("nouvelle session délivrée sans invitation", 'session_token' in res2)
check("AUCUNE invitation consommée", not any('UPDATE invitations' in s for s in sqls))
check("miroir Discord rafraîchi", any('INSERT INTO comptes' in s for s in sqls))

print("\n=== 3. Compte suspendu ===")
recharger(); install_discord()
cur, conn = install_db([(r"SELECT id, statut FROM comptes", (42, 'suspended'))])
import auth_discord; importlib.reload(auth_discord)
try:
    auth_discord.login('c', None, 'UA'); check("refusé", False, "aucune exception")
except auth_discord.DiscordAuthError as e:
    check("connexion refusée (403)", e.status == 403 and e.code == 'compte_suspendu')
    check("aucune session créée", not any('INSERT INTO sessions_joueurs' in s for s,_ in cur.executed))
    check("transaction annulée", conn.rolledback)

print("\n=== 4. Invitations invalides ===")
for libelle, ligne, attendu in [
    ("expirée",  (7, None, 1, 0, PASSE, None),  'invitation_expiree'),
    ("épuisée",  (7, None, 1, 1, FUTUR, None),  'invitation_epuisee'),
    ("révoquée", (7, None, 1, 0, FUTUR, PASSE), 'invitation_revoquee'),
    ("inconnue", None,                          'invitation_inconnue'),
]:
    recharger(); install_discord()
    cur, conn = install_db([
        (r"SELECT id, statut FROM comptes", None),
        (r"FROM invitations WHERE token_hash", ligne),
    ])
    import auth_discord; importlib.reload(auth_discord)
    try:
        auth_discord.login('c', 'tok', 'UA'); check(libelle, False, "acceptée à tort")
    except auth_discord.DiscordAuthError as e:
        check("invitation %s refusée" % libelle, e.code == attendu, e.code)

print("\n=== 5. Nouveau venu SANS invitation ===")
recharger(); install_discord()
cur, conn = install_db([(r"SELECT id, statut FROM comptes", None)])
import auth_discord; importlib.reload(auth_discord)
try:
    auth_discord.login('c', None, 'UA'); check("refusé", False, "accepté à tort")
except auth_discord.DiscordAuthError as e:
    check("inscription refusée sans invitation", e.code == 'invitation_requise')

print("\n=== 6. Amorçage du superadmin (R-39) ===")
os.environ['DISCORD_SUPERADMIN_ID'] = '123456789012345678'
recharger(); install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", None),
    (r"FROM invitations WHERE token_hash", (7, None, 1, 0, FUTUR, None)),
    (r"INSERT INTO comptes", ligne_compte(avatar='')),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (0,)),      # aucun superadmin
])
import auth_discord; importlib.reload(auth_discord)
res6 = auth_discord.login('c', 'tok', 'UA')
check("promu superadmin", res6['compte']['role'] == 'superadmin', res6['compte']['role'])
check("promotion auditée", any('INSERT INTO audit_admin' in s for s,_ in cur.executed))

print("--- et si un superadmin existe déjà : pas de porte dérobée ---")
recharger(); install_discord()
cur, conn = install_db([
    (r"SELECT id, statut FROM comptes", None),
    (r"FROM invitations WHERE token_hash", (7, None, 1, 0, FUTUR, None)),
    (r"INSERT INTO comptes", ligne_compte(avatar='')),
    (r"SELECT COUNT\(\*\) FROM comptes WHERE role", (1,)),      # un superadmin existe
])
import auth_discord; importlib.reload(auth_discord)
res7 = auth_discord.login('c', 'tok', 'UA')
check("NON promu (superadmin déjà présent)", res7['compte']['role'] == 'player', res7['compte']['role'])
os.environ.pop('DISCORD_SUPERADMIN_ID')

print("\n=== 7. Durée de session selon le rôle ===")
recharger(); install_discord()
cur, conn = install_db([(r".*", None)])
import auth_discord; importlib.reload(auth_discord)
c = cur
_, exp_j = auth_discord.create_session(c, 1, 'player', 'UA')
_, exp_a = auth_discord.create_session(c, 1, 'admin', 'UA')
jours_j = (exp_j - datetime.now(timezone.utc)).days
heures_a = (exp_a - datetime.now(timezone.utc)).total_seconds() / 3600
check("session joueur ≈ 30 j", 29 <= jours_j <= 30, jours_j)
check("session admin ≈ 12 h (bien plus courte)", 11 < heures_a <= 12, heures_a)

print("\n=== 8. Avatar : repli quand le hash est absent (R-42) ===")
SNOW = '123456789012345678'
attendu = '/embed/avatars/%d.png' % ((int(SNOW) >> 22) % 6)
check("URL de repli sans hash (index = snowflake >> 22 %% 6)",
      auth_discord.avatar_url(SNOW, None).endswith(attendu),
      auth_discord.avatar_url(SNOW, None))
check("le décalage tient sur un snowflake > 2^53",
      auth_discord.avatar_url('999999999999999999', None).startswith('https://cdn.discordapp.com/embed/avatars/'))
check("pas d'URL construite avec un hash vide",
      'None' not in auth_discord.avatar_url('123456789012345678', None))

print("\n=== 9. Le code OAuth ne fuit pas dans le token stocké ===")
check("seul le sha256 va en base",
      auth_discord.hash_token('secret') != 'secret' and len(auth_discord.hash_token('secret')) == 64)

print("\n" + "="*60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
