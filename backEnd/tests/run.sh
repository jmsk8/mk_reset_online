#!/usr/bin/env bash
# Lance les tests backend, sans Postgres ni Discord (seul flask est requis).
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
  # Liste les fichiers en echec (un plantage a l'import n'affiche aucun decompte).
  echo "❌ en echec : ${plantes[*]}"
fi
exit $rc
