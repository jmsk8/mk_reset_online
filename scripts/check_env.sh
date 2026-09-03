#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

# Clés sans lesquelles la stack ne démarre pas. En ajouter une ici ne réécrit
# PAS le fichier : seule la clé manquante est demandée et ajoutée.
REQUIRED_VARS=(POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB ADMIN_PASSWORD_HASH SECRET_KEY)

# Clés FACULTATIVES : jamais demandées, jamais bloquantes, et elles ont le
# droit de rester vides — le compose les interpole en `${VAR:-à renseigner}`,
# dont le `:-` couvre aussi bien l'absence que la valeur vide.
OPTIONAL_VARS=(SITE_EDITEUR SITE_CONTACT SITE_HEBERGEUR SITE_RETENTION_LOGS)

if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_RESET='\033[0m'
else
  C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi
# Tous les diagnostics partent sur stderr : value_for_key() capture stdout pour
# en faire la valeur écrite dans le .env.
info()  { printf "${C_GREEN}[env]${C_RESET} %s\n" "$1" >&2; }
warn()  { printf "${C_YELLOW}[env]${C_RESET} %s\n" "$1" >&2; }
err()   { printf "${C_RED}[env]${C_RESET} %s\n" "$1" >&2; }

read_env_value() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2- || true
}

missing_vars() {
  local k
  for k in "${REQUIRED_VARS[@]}"; do
    [ -n "$(read_env_value "$k" "$ENV_FILE")" ] || printf '%s\n' "$k"
  done
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

# Sur EOF (entrée redirigée), `read` échoue : on sort au lieu de boucler.
prompt_password() {
  local label="$1" p1 p2
  while true; do
    read -rsp "  $label : " p1 || { echo >&2; err "Entrée interrompue."; exit 1; }; echo >&2
    read -rsp "  Confirme    : " p2 || { echo >&2; err "Entrée interrompue."; exit 1; }; echo >&2
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
    read -rp "  $label [$default] : " val || true
    printf '%s' "${val:-$default}"
  else
    while true; do
      read -rp "  $label : " val || { err "Entrée interrompue."; exit 1; }
      [ -n "$val" ] && { printf '%s' "$val"; return 0; }
      warn "Vide, recommence."
    done
  fi
}

# Demande la valeur d'une clé manquante. Ne renvoie QUE la valeur sur stdout :
# les messages partent sur stderr, sinon ils atterrissent dans le .env.
value_for_key() {
  local key="$1" v
  case "$key" in
    POSTGRES_USER)
      prompt_value 'POSTGRES_USER' 'mk_reset' ;;
    POSTGRES_DB)
      prompt_value 'POSTGRES_DB' 'mk_reset' ;;
    POSTGRES_PASSWORD)
      echo "  Mot de passe PostgreSQL :" >&2
      prompt_password 'POSTGRES_PASSWORD'
      printf '%s' "$PROMPT_RESULT" ;;
    ADMIN_PASSWORD_HASH)
      echo "  Mot de passe administrateur du site (stocké en bcrypt) :" >&2
      prompt_password 'ADMIN_PASSWORD'
      v="$(bcrypt_hash "$PROMPT_RESULT")"
      printf '%s' "$(escape_for_compose "$v")" ;;
    SECRET_KEY)
      # Jamais demandée : générée, et jamais régénérée si déjà présente — une
      # rotation déconnecte toutes les sessions (R-29).
      info "SECRET_KEY absente — génération d'une nouvelle clé."
      gen_secret ;;
    DISCORD_CLIENT_ID)
      prompt_value 'DISCORD_CLIENT_ID' ;;
    DISCORD_CLIENT_SECRET)
      echo "  Secret de l'application Discord :" >&2
      prompt_password 'DISCORD_CLIENT_SECRET'
      printf '%s' "$(escape_for_compose "$PROMPT_RESULT")" ;;
    DISCORD_REDIRECT_URI)
      prompt_value 'DISCORD_REDIRECT_URI' 'https://mkreset.fr/auth/discord/callback' ;;
    *)
      prompt_value "$key" ;;
  esac
}

# Ajoute les clés manquantes SANS toucher au reste : commentaires, ordre et
# variables hors REQUIRED_VARS sont préservés à l'octet près.
merge_into_env() {
  local -n _keys="$1"
  local -n _vals="$2"
  local tmp key i

  tmp="$(umask 077; mktemp "$ROOT_DIR/.env.XXXXXX")"

  if [ -f "$ENV_FILE" ]; then
    # Recopie l'existant, en retirant les lignes vides des clés qu'on réécrit.
    local filter=""
    for key in "${_keys[@]}"; do
      filter="${filter}/^${key}=[[:space:]]*$/d;"
    done
    sed "$filter" "$ENV_FILE" > "$tmp"
    # Garantit un saut de ligne avant d'ajouter, si le fichier n'en finit pas par un.
    [ -s "$tmp" ] && [ -n "$(tail -c1 "$tmp")" ] && echo >> "$tmp"
  fi

  for i in "${!_keys[@]}"; do
    printf '%s=%s\n' "${_keys[$i]}" "${_vals[$i]}" >> "$tmp"
  done

  chmod 600 "$tmp"

  if [ -f "$ENV_FILE" ]; then
    cp -p "$ENV_FILE" "$ENV_FILE.bak"
    info "Sauvegarde de l'ancien fichier : .env.bak"
  fi
  mv "$tmp" "$ENV_FILE"
}

# Ajoute les clés facultatives ABSENTES du fichier, vides. Absentes et non
# vides : une clé laissée à `KEY=` doit le rester.
seed_optional_vars() {
  local k manquantes=()
  [ -f "$ENV_FILE" ] || return 0
  for k in "${OPTIONAL_VARS[@]}"; do
    grep -qE "^${k}=" "$ENV_FILE" || manquantes+=("$k")
  done
  [ "${#manquantes[@]}" -eq 0 ] && return 0

  # Saut de ligne préalable si le fichier n'en finit pas par un.
  [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ] && echo >> "$ENV_FILE"
  {
    echo "# Mentions légales — facultatif. Laisser vide affiche « à renseigner »"
    echo "# sur /mentions-legales et /confidentialite : la page reste lisible, mais"
    echo "# elle est incomplète au sens de la LCEN."
    printf '%s=\n' "${manquantes[@]}"
  } >> "$ENV_FILE"
  info "${#manquantes[@]} clé(s) facultative(s) ajoutée(s), vides : ${manquantes[*]}"
}

main() {
  local missing
  mapfile -t missing < <(missing_vars)

  if [ "${#missing[@]}" -eq 0 ]; then
    seed_optional_vars
    info ".env présent et complet ✓"
    exit 0
  fi

  if [ -f "$ENV_FILE" ]; then
    warn ".env présent mais incomplet — il manque :"
  else
    warn ".env absent — création nécessaire. Clés à renseigner :"
  fi
  printf '       - %s\n' "${missing[@]}"
  echo

  # SECRET_KEY se génère seule : si c'est la seule manquante, pas besoin de TTY.
  local needs_tty=0 k
  for k in "${missing[@]}"; do
    [ "$k" = "SECRET_KEY" ] || needs_tty=1
  done

  if [ "$needs_tty" -eq 1 ] && [ ! -t 0 ]; then
    err "Pas de terminal interactif : impossible de demander les credentials."
    err "Complète le .env à la main (clés manquantes ci-dessus)."
    err "Les autres clés déjà présentes ne sont PAS modifiées."
    exit 1
  fi

  [ "$needs_tty" -eq 1 ] && { info "Saisie des clés manquantes uniquement :"; echo; }

  local keys=() vals=() v
  for k in "${missing[@]}"; do
    v="$(value_for_key "$k")"
    # value_for_key tourne dans un $( ) : un `exit 1` interne ne tue que le
    # sous-shell et renverrait une valeur vide. Sans ce garde-fou, on écrirait un
    # .env d'apparence complète avec un hash vide.
    if [ -z "$v" ]; then
      err "Impossible d'obtenir une valeur pour $k — abandon, le .env n'est pas modifié."
      exit 1
    fi
    keys+=("$k")
    vals+=("$v")
  done

  merge_into_env keys vals
  seed_optional_vars

  echo
  info ".env complété (${#keys[@]} clé(s) ajoutée(s), le reste intact) ✓"
}

main "$@"
