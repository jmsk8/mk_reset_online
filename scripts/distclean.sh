#!/usr/bin/env bash
# Usage: ./scripts/distclean.sh [--certs]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

WITH_CERTS=0
[ "${1:-}" = "--certs" ] && WITH_CERTS=1

if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_RESET='\033[0m'
else
  C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi
info() { printf "${C_GREEN}[distclean]${C_RESET} %s\n" "$1"; }
warn() { printf "${C_YELLOW}[distclean]${C_RESET} %s\n" "$1"; }
err()  { printf "${C_RED}[distclean]${C_RESET} %s\n" "$1" >&2; }

echo
warn "Cette opération est IRRÉVERSIBLE. Seront supprimés :"
echo "       - conteneurs, réseaux, volumes (dont la base de données)"
echo "       - images construites localement"
[ -f .env ] && echo "       - .env (mots de passe, SECRET_KEY, config de déploiement)"
if [ "$WITH_CERTS" = "1" ]; then
  echo "       - certbot/ (certificats TLS)"
  echo
  err "Réémettre un certificat dépend de quotas Let's Encrypt :"
  err "  · 5 certificats identiques par semaine"
  err "  · un quota par domaine enregistré, partagé chez certains hébergeurs"
  err "En cas de blocage, le site repasse en HTTP sans recours immédiat."
fi
echo

if [ ! -t 0 ]; then
  err "Pas de terminal interactif : confirmation impossible, abandon."
  exit 1
fi

read -rp "  Tape 'oui' pour confirmer : " answer
[ "$answer" = "oui" ] || { info "Annulé."; exit 0; }

# Avant la suppression du .env, dont compose a besoin (COMPOSE_PROFILES).
info "Suppression des conteneurs, volumes et images…"
docker compose down -v --rmi local

if [ -f .env ]; then
  rm -f .env
  info ".env supprimé"
fi

if [ "$WITH_CERTS" = "1" ] && [ -d certbot ]; then
  rm -rf certbot
  info "certbot/ supprimé"
elif [ -d certbot ]; then
  info "certbot/ conservé (utilise --certs pour le supprimer aussi)"
fi

echo
info "Terminé. Relance avec : make build"
