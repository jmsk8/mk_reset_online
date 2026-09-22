"""Droits RGPD : acces, portabilite, effacement, purges.

L'assertion qui compte : supprimer un compte ne doit toucher NI joueurs, NI
participations, NI awards. Le moteur TrueSkill etant incremental et non
recalculable, y toucher fausserait le classement de tout le monde sans moyen de
le reconstruire.
"""
from harness import *
import re
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

# Depuis le 2026-09-22, l'effacement d'un compte se demande par ecrit et le
# superadmin l'execute : DELETE /admin/comptes/<id>. Acteur 1 (superadmin),
# cible 42, dont le handle Discord est 'toto' et le nom affiche 'Toto'.
SUPERADMIN = ligne_session(compte_id=1, role='superadmin')

def monter_suppression(acteur=SUPERADMIN, role_cible='player', joueur_id=9, cible=None):
    """La cible telle que la relisent compte_cible_protegee, puis la route sous verrou."""
    plan = [
        (r"SELECT role, joueur_id, discord_id, discord_username FROM comptes WHERE id = %s FOR UPDATE",
         cible if cible is not None else (role_cible, joueur_id, '123456789012345678', 'toto')),
        (r"SELECT role FROM comptes WHERE id = %s", (role_cible,)),
        (r"FROM sessions_joueurs s JOIN comptes c", acteur),
    ]
    cur, conn = install_db(plan)
    recharger()
    sys.modules.pop('routes_comptes', None)
    sys.modules.pop('services', None)
    import routes_comptes
    routes_comptes.invalidate_cache = lambda *a, **k: None
    app = Flask(__name__)
    app.register_blueprint(routes_comptes.comptes_bp)
    return app.test_client(), cur, conn, app

OUI = {'confirmation_pseudo': 'toto'}
def deletes(cur):
    return [s for s, _ in cur.executed if s.startswith('DELETE FROM')]

print("\n=== Effacement : ce qui part et ce qui reste ===")
cli, cur, conn, _ = monter_suppression()
r = cli.delete('/admin/comptes/42', json=OUI, headers=H)
sqls = [s for s, _ in cur.executed]
check("suppression par le superadmin -> 200", r.status_code == 200, r.get_json())
check("la reponse dit que le dossier sportif est conserve",
      (r.get_json() or {}).get('dossier_sportif_conserve') is True, r.get_json())

tables_effacees = {s.split('DELETE FROM ')[1].split()[0].lower() for s in deletes(cur)}
check("efface sessions, profil, demandes et compte",
      tables_effacees == {'sessions_joueurs', 'profils', 'liaisons_demandes', 'comptes'},
      tables_effacees)

for table in ('joueurs', 'participations', 'awards_obtenus', 'tournois', 'ghost_log',
              'league_movements', 'grille_snapshots'):
    check("le dossier sportif est intact : aucun DELETE sur %s" % table,
          not any(('delete from %s' % table) in s.lower() for s in sqls))
check("aucun UPDATE sur joueurs non plus",
      not any('update joueurs' in s.lower() for s in sqls))
check("le compte est verrouille avant d'etre efface",
      any('FOR UPDATE' in s for s in sqls))

print("\n=== Traçabilité de la suppression ===")
idx_audit = next(i for i, s in enumerate(sqls) if 'INSERT INTO audit_admin' in s)
idx_delete = next(i for i, s in enumerate(sqls) if 'DELETE FROM comptes' in s)
check("l'audit est écrit AVANT la suppression du compte", idx_audit < idx_delete,
      (idx_audit, idx_delete))
params_audit = [p for s, p in cur.executed if 'INSERT INTO audit_admin' in s][0]
check("l'action est nommée", 'compte_supprime' in str(params_audit))
check("l'origine dit que c'est une demande écrite", 'demande_ecrite' in str(params_audit))
# Avant le 22/09, l'acteur etait le titulaire lui-meme : sa ligne perdait donc
# son acteur des la suppression (ON DELETE SET NULL). Le superadmin, lui, reste.
check("l'acteur consigné est le superadmin qui exécute, pas le compte effacé",
      params_audit[1] == 1, params_audit[1])
check("le snowflake Discord n'est PAS conservé en clair dans l'audit",
      '123456789012345678' not in str(params_audit[4]), params_audit[4])
check("une empreinte permet quand même de rejouer la suppression après restauration",
      'discord_id_hash' in str(params_audit))
check("transaction validée", conn.committed)

# §6.4 du plan d'audit : le journal survit au compte. La ligne `compte_supprime`
# est ce qui permet de rejouer l'effacement apres une restauration (runbook §5) ;
# la supprimer au passage rendrait la suppression irreversible... a l'envers.
check("la suppression n'efface ni ne réécrit aucune ligne du journal",
      not any(('audit_admin' in s_.lower()) and not s_.startswith('INSERT INTO audit_admin')
              for s_ in sqls), [s_ for s_ in sqls if 'audit_admin' in s_.lower()])
_schema = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'schema.sql'),
               encoding='utf-8').read()
check("  et le schéma détache l'acteur au lieu d'emporter ses lignes (ON DELETE SET NULL)",
      re.search(r'acteur_compte_id integer REFERENCES public\.comptes\(id\) ON DELETE SET NULL',
                _schema) is not None)

print("\n=== Le titulaire ne supprime plus son compte lui-même ===")
# Retirer le bouton ne suffisait pas : une route laissee en place reste
# appelable a la main avec un jeton de joueur.
cli, cur, conn, app = monter_suppression(acteur=ligne_session(compte_id=42, role='player'))
check("aucune route /me n'accepte plus DELETE",
      not [r_ for r_ in app.url_map.iter_rules()
           if r_.rule == '/me' and 'DELETE' in r_.methods])
r = cli.delete('/me', headers=H)
check("DELETE /me par un joueur -> 404 ou 405", r.status_code in (404, 405), r.status_code)
r = cli.delete('/admin/comptes/42', json=OUI, headers=H)
check("un joueur ne passe pas par la route admin, même sur son propre compte -> 403",
      r.status_code == 403, r.status_code)
check("  et rien n'est effacé", not deletes(cur), deletes(cur))

print("\n=== Garde-fous de la route superadmin ===")
# Capacite de ROLE : ni un chef_admin, ni un admin, quelles que soient ses
# permissions.
for role in ('chef_admin', 'admin'):
    cli, cur, conn, _ = monter_suppression(acteur=ligne_session(compte_id=1, role=role))
    r = cli.delete('/admin/comptes/42', json=OUI, headers=H)
    check("un %s -> 403, rien d'effacé" % role,
          r.status_code == 403 and not deletes(cur), (r.status_code, deletes(cur)))

cli, cur, conn, _ = monter_suppression()
r = cli.delete('/admin/comptes/42', headers=H)
check("sans confirmation -> 400 confirmation_invalide",
      r.status_code == 400 and (r.get_json() or {}).get('code') == 'confirmation_invalide',
      r.get_json())
# `committed` ne dirait rien ici : auth.py valide sa propre ecriture de
# last_seen_at sur la meme fausse connexion. Ce qui compte : ni effacement, ni
# ligne d'audit annoncant un effacement qui n'a pas eu lieu.
check("  et rien n'est effacé ni journalisé, transaction annulée",
      not deletes(cur) and conn.rolledback
      and not any('INSERT INTO audit_admin' in s for s, _ in cur.executed))

# Le nom AFFICHE est librement modifiable : un homonyme viderait la
# confirmation de son sens. Seul le handle compte.
cli, cur, conn, _ = monter_suppression()
r = cli.delete('/admin/comptes/42', json={'confirmation_pseudo': 'Toto'}, headers=H)
check("le nom affiché ne vaut pas confirmation -> 400",
      r.status_code == 400 and not deletes(cur), r.get_json())

# Le superadmin est unique : se supprimer laisserait le site sans administration.
cli, cur, conn, _ = monter_suppression(role_cible='superadmin')
r = cli.delete('/admin/comptes/1', json=OUI, headers=H)
check("le superadmin ne peut pas supprimer son propre compte -> 403 auto_modification",
      r.status_code == 403 and (r.get_json() or {}).get('code') == 'auto_modification',
      r.get_json())
check("  et rien n'est effacé", not deletes(cur))

cli, cur, conn, _ = monter_suppression()
cur.plan[0] = (cur.plan[0][0], None)
r = cli.delete('/admin/comptes/42', json=OUI, headers=H)
check("compte introuvable -> 404", r.status_code == 404, r.status_code)

cli, cur, conn, _ = monter_suppression(joueur_id=None)
r = cli.delete('/admin/comptes/42', json=OUI, headers=H)
check("un compte jamais rattaché se supprime aussi, sans dossier sportif annoncé",
      r.status_code == 200
      and (r.get_json() or {}).get('dossier_sportif_conserve') is False, r.get_json())

print("\n=== Côté frontend : le bouton renvoie vers une demande écrite ===")
_FRONT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'frontEnd')
_lire = lambda *p: open(os.path.join(_FRONT, *p), encoding='utf-8').read()
_front_py = _lire('frontend.py')
_mc = _lire('templates', 'mon_compte.html')
_ac = _lire('templates', 'admin_comptes.html')
_conf = _lire('templates', 'confidentialite.html')

check("le proxy /mon-compte/supprimer a disparu",
      "@app.route('/mon-compte/supprimer'" not in _front_py)
check("le bouton « Supprimer mon compte » est toujours là", 'id="btn-supprimer"' in _mc)
check("  mais la page n'appelle plus aucune route d'effacement",
      '/mon-compte/supprimer' not in _mc and "'DELETE'" not in _mc)
_bloc = _mc[_mc.find('id="demande-suppression"'):]
_bloc = _bloc[:_bloc.find('</div>')]
check("  il déplie la marche à suivre, avec l'adresse de contact",
      '{{ contact }}' in _bloc, _bloc[:200])
check("  et le délai d'un mois (art. 12.3)", 'un mois' in _bloc)

check("la politique ne promet plus une suppression « immédiate » depuis Mon compte",
      'immédiatement et sans' not in _conf)
check("  elle dit comment la demander, et en combien de temps",
      'faire supprimer' in _conf and 'un mois' in _conf)

# Le bouton admin ne doit jamais mener a un 403 previsible (§B.0) : la route est
# une capacite du superadmin, le bouton aussi.
_i = _ac.find("'Supprimer le compte'")
check("l'admin des comptes propose « Supprimer le compte »", _i > 0)
check("  au seul superadmin, jamais sur sa propre ligne",
      'EST_SUPERADMIN && c.id !== MON_COMPTE_ID' in _ac[max(0, _i - 300):_i])
_h = _ac[_ac.find('async function supprimerCompte('):]
_h = _h[:_h.find('\n        }\n')]
check("  avec confirmation nommée puis pseudo retapé",
      'confirmer(' in _h and 'prompt(' in _h and 'confirmation_pseudo' in _h)
check("le proxy de la route superadmin transmet le corps (la confirmation)",
      "_proxy_admin('DELETE', f'/admin/comptes/{compte_id}', json_body=True)" in _front_py)

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
