#!/usr/bin/env bash
# Usage: ./scripts/db-dump.sh [nom]  -> dumps/<nom>.sql (défaut : horodaté)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_RESET='\033[0m'
else
  C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi
info() { printf "${C_GREEN}[dump]${C_RESET} %s\n" "$1"; }
warn() { printf "${C_YELLOW}[dump]${C_RESET} %s\n" "$1"; }
err()  { printf "${C_RED}[dump]${C_RESET} %s\n" "$1" >&2; }

NAME="${1:-}"
mkdir -p dumps

if [ -z "$NAME" ]; then
  NAME="dump_$(date +%Y-%m-%d_%H%M)"
fi

# Un nom, pas un chemin : le dump atterrit toujours dans dumps/.
case "$NAME" in
  */*)
    err "Donne un nom, pas un chemin : « $NAME »"
    err "Le dump est toujours écrit dans dumps/."
    exit 1
    ;;
esac
NAME="${NAME%.sql}"
if ! printf '%s' "$NAME" | grep -qE '^[A-Za-z0-9._-]+$'; then
  err "Nom invalide : « $NAME »"
  err "Caractères autorisés : lettres, chiffres, point, tiret, underscore."
  exit 1
fi
OUT="dumps/$NAME.sql"

if [ -e "$OUT" ]; then
  warn "$OUT existe déjà ($(du -h "$OUT" | cut -f1), modifié le $(date -r "$OUT" '+%d/%m/%Y %H:%M'))."
  if [ ! -t 0 ]; then
    err "Pas de terminal interactif : abandon plutôt qu'un écrasement silencieux."
    exit 1
  fi
  read -rp "  L'écraser ? (y/N) " decision
  [ "$decision" = "y" ] || { info "Annulé — dump existant conservé."; exit 0; }
fi

if ! docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  err "Le conteneur db ne tourne pas. Lance 'make up' d'abord."
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

info "Extraction de la base…"
docker compose exec -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' > "$TMP"

# Garde le dump indépendant du nom de rôle, comme schema.sql.
sed -i -E 's/ OWNER TO [A-Za-z0-9_]+;/ OWNER TO CURRENT_USER;/g' "$TMP"

if ! grep -q '^COPY public\.joueurs ' "$TMP"; then
  err "Le dump ne contient pas la table joueurs — base vide ou extraction ratée."
  err "Rien n'a été écrit."
  exit 1
fi

# 644 obligatoire : le dump est monté dans le conteneur db, où postgres
# tourne en uid 70 et doit pouvoir le lire pour l'initialisation.
chmod 644 "$TMP"
mv "$TMP" "$OUT"
trap - EXIT
info "Écrit dans $OUT ($(du -h "$OUT" | cut -f1))"
