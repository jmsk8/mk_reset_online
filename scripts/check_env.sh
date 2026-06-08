#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

REQUIRED_VARS=(POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB ADMIN_PASSWORD_HASH SECRET_KEY)

if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_RESET='\033[0m'
else
  C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi
info()  { printf "${C_GREEN}[env]${C_RESET} %s\n" "$1"; }
warn()  { printf "${C_YELLOW}[env]${C_RESET} %s\n" "$1"; }
err()   { printf "${C_RED}[env]${C_RESET} %s\n" "$1" >&2; }

read_env_value() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2- || true
}

env_is_complete() {
  [ -f "$ENV_FILE" ] || return 1
  local k v
  for k in "${REQUIRED_VARS[@]}"; do
    v="$(read_env_value "$k" "$ENV_FILE")"
    [ -n "$v" ] || return 1
  done
  return 0
}

bcrypt_hash() {
  local pwd="$1"
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import bcrypt' >/dev/null 2>&1; then
    PWD_INPUT="$pwd" python3 - <<'PY'
import os, bcrypt
pw = os.environ["PWD_INPUT"].encode("utf-8")
print(bcrypt.hashpw(pw, bcrypt.gensalt()).decode("utf-8"))
PY
  elif command -v htpasswd >/dev/null 2>&1; then
    printf '%s' "$pwd" | htpasswd -niB admin 2>/dev/null | cut -d: -f2
  else
    err "Aucun outil bcrypt trouvé (python3+bcrypt ou htpasswd requis)."
    exit 1
  fi
}

escape_for_compose() {
  printf '%s' "$1" | sed 's/\$/$$/g'
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

PROMPT_RESULT=""

prompt_password() {
  local label="$1" p1 p2
  while true; do
    read -rsp "  $label : " p1; echo
    read -rsp "  Confirme    : " p2; echo
    if [ -z "$p1" ]; then
      warn "Vide, recommence."
    elif [ "$p1" != "$p2" ]; then
      warn "Les saisies diffèrent, recommence."
    else
      PROMPT_RESULT="$p1"
      return 0
    fi
  done
}

prompt_value() {
  local label="$1" default="${2:-}" val
  if [ -n "$default" ]; then
    read -rp "  $label [$default] : " val
    printf '%s' "${val:-$default}"
  else
    while true; do
      read -rp "  $label : " val
      [ -n "$val" ] && { printf '%s' "$val"; return 0; }
      warn "Vide, recommence."
    done
  fi
}

main() {
  if env_is_complete; then
    info ".env présent et complet ✓"
    exit 0
  fi

  if [ -f "$ENV_FILE" ]; then
    warn ".env présent mais incomplet — il manque une ou plusieurs clés :"
    for k in "${REQUIRED_VARS[@]}"; do
      [ -n "$(read_env_value "$k" "$ENV_FILE")" ] || printf "       - %s\n" "$k"
    done
    echo
  else
    warn ".env absent — création nécessaire."
  fi

  if [ ! -t 0 ]; then
    err "Pas de terminal interactif : impossible de demander les credentials."
    err "Crée le .env manuellement (clés : ${REQUIRED_VARS[*]})."
    exit 1
  fi

  echo
  info "Configuration des credentials (saisie manuelle) :"
  echo

  local db_user db_pass db_name admin_pwd
  db_user="$(prompt_value 'POSTGRES_USER' 'mk_reset')"
  db_name="$(prompt_value 'POSTGRES_DB'   'mk_reset')"
  echo "  Mot de passe PostgreSQL :"
  prompt_password 'POSTGRES_PASSWORD'; db_pass="$PROMPT_RESULT"
  echo "  Mot de passe administrateur du site (stocké en bcrypt) :"
  prompt_password 'ADMIN_PASSWORD'; admin_pwd="$PROMPT_RESULT"

  echo
  info "Génération du hash bcrypt et de la SECRET_KEY…"
  local admin_hash admin_hash_escaped secret_key
  admin_hash="$(bcrypt_hash "$admin_pwd")"
  admin_hash_escaped="$(escape_for_compose "$admin_hash")"
  secret_key="$(gen_secret)"
  unset admin_pwd

  local tmp
  tmp="$(umask 077; mktemp "$ROOT_DIR/.env.XXXXXX")"
  {
    echo "POSTGRES_USER=$db_user"
    echo "POSTGRES_PASSWORD=$db_pass"
    echo "POSTGRES_DB=$db_name"
    echo "ADMIN_PASSWORD_HASH=$admin_hash_escaped"
    echo "SECRET_KEY=$secret_key"
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"

  echo
  info ".env créé avec succès (permissions 600) ✓"
}

main "$@"
