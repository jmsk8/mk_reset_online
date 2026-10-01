"""Journal d'audit : un seul chemin d'ecriture, et l'acteur est bien deduit."""
from harness import *
from flask import Flask, g

import audit

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


class CurseurEspion:
    """Enregistre les requetes sans rien executer."""

    def __init__(self):
        self.executees = []

    def execute(self, sql, params=None):
        self.executees.append((sql, params))

    @property
    def derniers_params(self):
        return self.executees[-1][1]


_app = Flask(__name__)


# ===========================================================================
print("\n=== Un seul chemin d'ecriture (critere de sortie de la phase 1) ===")
# Verification sur le source.
_fichiers = [f for f in os.listdir(RACINE) if f.endswith('.py')]
_porteurs = {}
for _f in _fichiers:
    with open(os.path.join(RACINE, _f), encoding='utf-8') as _fh:
        _src = _fh.read()
    # On compte les requetes (presence des colonnes), pas les mentions.
    _n = sum(1 for _l in _src.splitlines()
             if 'INSERT INTO audit_admin' in _l
             and 'acteur_compte_id' in _l
             and not _l.strip().startswith('#'))
    if _n:
        _porteurs[_f] = _n

check("un seul fichier porte un INSERT INTO audit_admin",
      list(_porteurs) == ['audit.py'], _porteurs)
check("et il n'en porte qu'un", _porteurs.get('audit.py') == 1, _porteurs)

# Une seule definition de _acteur_id.
_defs = [f for f in _fichiers
         if 'def _acteur_id(' in open(os.path.join(RACINE, f), encoding='utf-8').read()]
check("plus aucune definition dupliquee de _acteur_id", _defs == [], _defs)


# ===========================================================================
print("\n=== L'acteur est deduit dans les quatre contextes reels ===")

# 1. Requete avec une session : l'acteur est le titulaire.
with _app.test_request_context():
    g.compte = {'id': 42}
    _c = CurseurEspion()
    audit.ecrire(_c, 'joueur_anonymise', 'joueur', 7, {"nouveau_nom": "X"})
    check("dans une requete, l'acteur vient de g.compte",
          _c.derniers_params[1] == 42, _c.derniers_params)

# 2. Requete sans session : None.
with _app.test_request_context():
    _c = CurseurEspion()
    audit.ecrire(_c, 'joueur_anonymise', 'joueur', 7)
    check("sans g.compte (mot de passe partage), l'acteur est None",
          _c.derniers_params[1] is None, _c.derniers_params)

# 3. Hors requete : None, sans lever.
_c = CurseurEspion()
audit.ecrire(_c, 'purge_rgpd', 'systeme', details={'n': 1}, acteur_id=None)
check("hors requete HTTP, l'ecriture passe sans lever",
      _c.derniers_params[1] is None, _c.derniers_params)
check("et hors requete, acteur_courant() ne leve pas non plus",
      audit.acteur_courant() is None)

# 4. Acteur explicite (amorcage du superadmin).
_c = CurseurEspion()
audit.ecrire(_c, 'role_attribue', 'compte', 1, {"origine": "amorcage"}, acteur_id=1)
check("un acteur explicite prime sur le contexte", _c.derniers_params[1] == 1)

# « Non precise » et « None explicite » sont distincts.
with _app.test_request_context():
    g.compte = {'id': 99}
    _c = CurseurEspion()
    audit.ecrire(_c, 'purge_rgpd', 'systeme', acteur_id=None)
    check("acteur_id=None EXPLICITE n'est pas ecrase par g.compte",
          _c.derniers_params[1] is None, _c.derniers_params)


# ===========================================================================
print("\n=== Forme de la ligne ecrite ===")
_c = CurseurEspion()
audit.ecrire(_c, 'action_x')
check("details absent reste NULL, jamais la chaine 'null'",
      _c.derniers_params[4] is None, _c.derniers_params[4])

_c = CurseurEspion()
audit.ecrire(_c, 'action_x', details={'a': 1})
check("details present est serialise en JSON",
      _c.derniers_params[4] == '{"a": 1}', _c.derniers_params[4])

_c = CurseurEspion()
audit.ecrire(_c, 'action_x', 'compte', 5)
check("cible_type et cible_id sont places dans cet ordre",
      _c.derniers_params[2] == 'compte' and _c.derniers_params[3] == 5,
      _c.derniers_params)

# Le helper n'ouvre ni ne valide de transaction.
_src_audit = open(os.path.join(RACINE, 'audit.py'), encoding='utf-8').read()
check("le helper ne valide aucune transaction",
      'commit()' not in _src_audit and 'rollback()' not in _src_audit)
check("et n'ouvre aucune connexion : il recoit le curseur de l'appelant",
      'get_db_connection' not in _src_audit)


# ===========================================================================
print("\n=== Les deux appels qui avaient PERDU leur acteur (§3.2) ===")
_admin = open(os.path.join(RACINE, 'routes_admin.py'), encoding='utf-8').read()
for _action in ('liaison_annulee', 'joueur_anonymise'):
    check("%s passe desormais par le helper" % _action,
          "audit.ecrire(" in _admin and "'%s'" % _action in _admin, _action)

print("\n" + "=" * 60)
print("%d/%d assertions" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
