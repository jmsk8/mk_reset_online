#!/usr/bin/env bash
# Tests de fumee du parcours d'authentification et de l'API de service.
#
# Ni Postgres ni Discord : le curseur est scripte et l'API Discord simulee.
# Ca ne valide pas le SQL, mais ca valide ce qui casse en silence -- qui
# consomme quelle invitation, quel code d'erreur sort quand la base tombe,
# qui a le droit de faire quoi, et comment les lobbies sont composes.
# Seul flask est requis.
set -uo pipefail
cd "$(dirname "$0")"
export PYTHONPATH="$PWD:$PWD/..:${PYTHONPATH:-}"

rc=0
fichiers=0
plantes=()
for t in test_*.py; do
  fichiers=$((fichiers + 1))
  echo "### $t"
  if ! python3 "$t"; then
    rc=1
    plantes+=("$t")
  fi
done

echo
echo "──────────────────────────────────────────────"
if [ "$rc" -eq 0 ]; then
  echo "✅ $fichiers fichiers, tous verts"
else
  # Un fichier qui plante a l'import n'affiche aucun decompte : sans cette
  # ligne, son absence passe inapercue au milieu des autres.
  echo "❌ en echec : ${plantes[*]}"
fi
exit $rc
