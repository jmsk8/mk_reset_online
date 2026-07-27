#!/usr/bin/env bash
# Usage: ./scripts/init-letsencrypt.sh [domaine] [email]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
COMPOSE="docker compose"

if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_RESET='\033[0m'
else
  C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi
info() { printf "${C_GREEN}[ssl]${C_RESET} %s\n" "$1"; }
warn() { printf "${C_YELLOW}[ssl]${C_RESET} %s\n" "$1"; }
err()  { printf "${C_RED}[ssl]${C_RESET} %s\n" "$1" >&2; }

read_env_value() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true
}

set_env_value() {
  local key="$1" value="$2"
  if [ -f "$ENV_FILE" ] && grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

DOMAIN="${1:-$(read_env_value DOMAIN)}"
EMAIL="${2:-$(read_env_value LETSENCRYPT_EMAIL)}"

if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "localhost" ]; then
  err "Aucun domaine défini."
  err "Usage : ./scripts/init-letsencrypt.sh <domaine> [email]  (ou DOMAIN=... dans .env)"
  exit 1
fi

if [ -d "certbot/conf/live/$DOMAIN" ]; then
  warn "Un certificat existe déjà pour $DOMAIN."
  read -rp "  Le remplacer ? (y/N) " decision
  [ "$decision" = "y" ] || exit 0
fi

mkdir -p certbot/conf certbot/www

info "Domaine : $DOMAIN"
set_env_value DOMAIN "$DOMAIN"
[ -n "$EMAIL" ] && set_env_value LETSENCRYPT_EMAIL "$EMAIL"

# Le challenge webroot exige nginx en clair sur le port 80, le certificat
# n'existant pas encore.
info "Démarrage de nginx en mode http pour le challenge ACME…"
set_env_value TLS_MODE http
$COMPOSE up -d nginx

EMAIL_ARG="--register-unsafely-without-email"
[ -n "$EMAIL" ] && EMAIL_ARG="--email $EMAIL --no-eff-email"

info "Demande du certificat auprès de Let's Encrypt…"
if ! $COMPOSE run --rm --entrypoint certbot certbot certonly \
  --webroot -w /var/www/certbot \
  $EMAIL_ARG \
  -d "$DOMAIN" \
  --rsa-key-size 4096 \
  --agree-tos \
  --non-interactive \
  --force-renewal; then
  err "Échec de l'émission du certificat — la stack reste en mode http."
  err "Vérifie que $DOMAIN pointe bien vers ce serveur et que le port 80 est ouvert."
  exit 1
fi

info "Bascule en mode https…"
set_env_value TLS_MODE https
set_env_value COMPOSE_PROFILES ssl
$COMPOSE up -d

info "Terminé — site accessible sur https://$DOMAIN"
