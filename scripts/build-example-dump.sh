#!/usr/bin/env bash
# Reconstruit backEnd/dump.sql : jeu de démonstration entièrement fictif.
# Les données sont générées, chargées dans un Postgres jetable puis ré-extraites
# avec pg_dump, ce qui garantit le même format que les autres dumps.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_RESET='\033[0m'
else
  C_GREEN=''; C_RED=''; C_RESET=''
fi
info() { printf "${C_GREEN}[example]${C_RESET} %s\n" "$1"; }
err()  { printf "${C_RED}[example]${C_RESET} %s\n" "$1" >&2; }

OUT="backEnd/dump.sql"
CONTAINER="mk_reset_example_build"
DATA="$(mktemp)"
cleanup() { rm -f "$DATA"; docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# trueskill n'est pas installé sur l'hôte : on emprunte l'image du backend.
info "Génération des données (moteur TrueSkill)…"
docker compose run --rm --no-deps -T backend python - \
  < scripts/generate_example_data.py > "$DATA"
[ -s "$DATA" ] || { err "Le générateur n'a rien produit."; exit 1; }

info "Chargement dans une base jetable…"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=example -e POSTGRES_PASSWORD=example -e POSTGRES_DB=example \
  postgres:17-alpine >/dev/null
until docker exec "$CONTAINER" pg_isready -U example -d example >/dev/null 2>&1; do
  sleep 1
done

docker exec -i "$CONTAINER" psql -U example -d example -v ON_ERROR_STOP=1 -q -o /dev/null \
  < backEnd/schema.sql
docker exec -i "$CONTAINER" psql -U example -d example -v ON_ERROR_STOP=1 -q -o /dev/null \
  < "$DATA"

info "Extraction…"
docker exec "$CONTAINER" pg_dump -U example -d example --clean --if-exists > "$OUT"
sed -i -E 's/ OWNER TO [A-Za-z0-9_]+;/ OWNER TO CURRENT_USER;/g' "$OUT"
# 644 obligatoire : postgres tourne en uid 70 dans le conteneur db et doit
# pouvoir lire le fichier lors de l'initialisation.
chmod 644 "$OUT"

info "Contenu :"
docker exec "$CONTAINER" psql -U example -d example -tAc \
  "SELECT '  ' || (SELECT COUNT(*) FROM joueurs) || ' joueurs, '
       || (SELECT COUNT(*) FROM tournois) || ' tournois, '
       || (SELECT COUNT(*) FROM participations) || ' participations, '
       || (SELECT COUNT(*) FROM awards_obtenus) || ' awards'"

info "Écrit dans $OUT ($(du -h "$OUT" | cut -f1))"
