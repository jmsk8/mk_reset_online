#!/usr/bin/env bash
# Usage: ./scripts/adapter-dump.sh <dump-source> [dump-sortie]
#
# Amene un dump de production au schema courant du code, en lui appliquant les
# migrations de backEnd/migrations/ dans l'ordre chronologique.
#
# POURQUOI CE SCRIPT EXISTE
# La prod n'a recu AUCUNE migration depuis le 2026-09-02 (cf
# docs/auth-discord-avancement.md, « Ce qui bloque le deploiement »). Un dump
# qui en vient porte donc des donnees recentes sur un schema ancien : il lui
# manque les 11 tables de l'auth Discord, de la hierarchie admin, des
# notifications et des tiers dynamiques.
#
# Editer un tel dump a la main serait une faute : ce ne serait ni reproductible,
# ni documente, ni rejouable sur la prod le jour du deploiement. On le charge
# donc dans une base jetable, on applique les migrations -- ecrites en CREATE
# TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, donc idempotentes -- et on
# redumpe. La sequence appliquee ici est exactement celle a rejouer en prod.
#
# CE QUE CE SCRIPT NE FAIT PAS
# Il ne touche NI a la base de developpement en cours, NI a la prod. Il travaille
# dans une base temporaire portant un nom dedie, et la detruit en sortant.
#
# Par defaut la sortie est ecrite HORS du depot (dumps/ contient deja des donnees
# reelles dans un depot public, cf docs) : passer un chemin explicite pour
# choisir l'emplacement.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_RESET='\033[0m'
else
  C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi
info() { printf "${C_GREEN}[adapter]${C_RESET} %s\n" "$1"; }
warn() { printf "${C_YELLOW}[adapter]${C_RESET} %s\n" "$1"; }
err()  { printf "${C_RED}[adapter]${C_RESET} %s\n" "$1" >&2; }

SRC="${1:-}"
if [ -z "$SRC" ]; then
  err "Usage : ./scripts/adapter-dump.sh <dump-source> [dump-sortie]"
  err ""
  err "Dumps disponibles :"
  ls -1 dumps/*.sql backEnd/dump.sql 2>/dev/null | sed 's/^/  /' >&2 || echo "  (aucun)" >&2
  exit 1
fi
[ -f "$SRC" ] || { err "Dump introuvable : $SRC"; exit 1; }
[ -s "$SRC" ] || { err "Dump vide : $SRC"; exit 1; }

BASE="$(basename "${SRC%.sql}")"
OUT="${2:-${TMPDIR:-/tmp}/${BASE}_migre.sql}"

# Base jetable : un nom dedie, pour qu'aucune confusion avec la base de travail
# ne soit possible meme si le script est interrompu.
TMPDB="adapter_dump_$$"

if ! docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  err "Le conteneur db ne tourne pas. Lance 'make up' d'abord."
  err "(Ce script n'utilise PAS la base de ce conteneur : il en cree une jetable a cote.)"
  exit 1
fi

psql_tmp() { docker compose exec -T db sh -c "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d $TMPDB $*"; }

nettoyer() {
  docker compose exec -T db sh -c \
    "psql -q -U \"\$POSTGRES_USER\" -d postgres -c 'DROP DATABASE IF EXISTS $TMPDB WITH (FORCE);'" \
    >/dev/null 2>&1 || true
}
trap nettoyer EXIT

info "Source  : $SRC ($(du -h "$SRC" | cut -f1))"
info "Sortie  : $OUT"
info "Base jetable : $TMPDB"
echo

# ── 1. Charger le dump dans une base neuve ──────────────────────────────────
info "1/4 Chargement du dump dans une base jetable…"
nettoyer
docker compose exec -T db sh -c \
  "psql -q -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d postgres -c 'CREATE DATABASE $TMPDB;'"

# Le dump de pg_dump 17 ouvre sur \restrict, une directive que psql accepte mais
# qui verrouille la session : on la retire, comme le ferait pg_restore.
sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' "$SRC" \
  | docker compose exec -T db sh -c "psql -q -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d $TMPDB" \
  > /dev/null

avant_t=$(psql_tmp -tAc "'SELECT count(*) FROM tournois'" | tr -d '[:space:]')
avant_j=$(psql_tmp -tAc "'SELECT count(*) FROM joueurs'" | tr -d '[:space:]')
avant_p=$(psql_tmp -tAc "'SELECT count(*) FROM participations'" | tr -d '[:space:]')
info "    charge : $avant_j joueurs, $avant_t tournois, $avant_p participations"

# ── 2. Appliquer les migrations ─────────────────────────────────────────────
# Ordre chronologique par nom de fichier : c'est la convention du projet, et
# elle porte les dependances reelles (auth_discord cree `comptes`, dont
# hierarchie_admin et liaison_creation_joueur ont besoin).
echo
info "2/4 Application des migrations…"
ERRLOG="$(mktemp)"
trap 'rm -f "$ERRLOG"; nettoyer' EXIT
appliquees=0
for f in backEnd/migrations/*.sql; do
  nom="$(basename "$f")"
  if sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' "$f" \
      | docker compose exec -T db sh -c \
        "psql -q -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d $TMPDB" >/dev/null 2>"$ERRLOG"; then
    printf "    ✅ %s\n" "$nom"
    appliquees=$((appliquees + 1))
  else
    printf "    ❌ %s\n" "$nom"
    err "Migration en echec — rien n'a ete ecrit."
    err "Detail :"
    sed 's/^/      /' "$ERRLOG" >&2
    exit 1
  fi
done
info "    $appliquees migrations appliquees"

# ── 3. Verifier que le schema est complet ───────────────────────────────────
# Le controle porte sur les tables que le CODE attend : une migration qui
# echouerait a moitie sans renvoyer d'erreur se verrait ici.
echo
info "3/4 Verification du schema obtenu…"
ATTENDUES="audit_admin comptes invitations liaisons_demandes noms_interdits \
notifications permissions_admin profils service_tokens sessions_joueurs tiers"

manquantes=""
for t in $ATTENDUES; do
  n=$(psql_tmp -tAc "\"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$t'\"" | tr -d '[:space:]')
  [ "$n" = "1" ] || manquantes="$manquantes $t"
done

if [ -n "$manquantes" ]; then
  err "Tables toujours absentes apres migration :$manquantes"
  err "Rien n'a ete ecrit."
  exit 1
fi
info "    les 11 tables attendues sont presentes"

# anonymise_at : ajoutee par auth_discord sur une table preexistante, c'est le
# cas ou un ADD COLUMN IF NOT EXISTS silencieux pourrait passer inapercu.
n=$(psql_tmp -tAc "\"SELECT count(*) FROM information_schema.columns WHERE table_name='joueurs' AND column_name='anonymise_at'\"" | tr -d '[:space:]')
[ "$n" = "1" ] || { err "joueurs.anonymise_at absente apres migration."; exit 1; }
info "    joueurs.anonymise_at presente"

n_tiers=$(psql_tmp -tAc "'SELECT count(*) FROM tiers'" | tr -d '[:space:]')
info "    tiers : $n_tiers lignes (seed par defaut S/A/B/C attendu)"

# Les donnees doivent avoir traverse les migrations sans perte : une migration
# qui toucherait aux donnees existantes se verrait ici.
apres_t=$(psql_tmp -tAc "'SELECT count(*) FROM tournois'" | tr -d '[:space:]')
apres_j=$(psql_tmp -tAc "'SELECT count(*) FROM joueurs'" | tr -d '[:space:]')
apres_p=$(psql_tmp -tAc "'SELECT count(*) FROM participations'" | tr -d '[:space:]')
if [ "$avant_t" != "$apres_t" ] || [ "$avant_j" != "$apres_j" ] || [ "$avant_p" != "$apres_p" ]; then
  err "Les migrations ont modifie le volume de donnees :"
  err "  joueurs       $avant_j -> $apres_j"
  err "  tournois      $avant_t -> $apres_t"
  err "  participations $avant_p -> $apres_p"
  err "Ce n'est pas attendu — rien n'a ete ecrit."
  exit 1
fi
info "    donnees intactes : $apres_j joueurs, $apres_t tournois, $apres_p participations"

# ── 4. Redumper ─────────────────────────────────────────────────────────────
echo
info "4/4 Extraction du dump adapte…"
TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_OUT" "$ERRLOG"; nettoyer' EXIT

docker compose exec -T db sh -c \
  "pg_dump -U \"\$POSTGRES_USER\" -d $TMPDB --clean --if-exists" > "$TMP_OUT"

# Meme normalisation que scripts/db-dump.sh : le dump reste independant du nom
# de role, comme schema.sql.
sed -i -E 's/ OWNER TO [A-Za-z0-9_]+;/ OWNER TO CURRENT_USER;/g' "$TMP_OUT"

grep -q '^COPY public\.joueurs ' "$TMP_OUT" || {
  err "Le dump produit ne contient pas la table joueurs — extraction ratee."
  err "Rien n'a ete ecrit."
  exit 1
}

mkdir -p "$(dirname "$OUT")"
# 644 : le dump est monte dans le conteneur db, ou postgres tourne en uid 70 et
# doit pouvoir le lire pour l'initialisation (meme raison que db-dump.sh).
chmod 644 "$TMP_OUT"
mv "$TMP_OUT" "$OUT"

echo
info "Termine : $OUT ($(du -h "$OUT" | cut -f1))"
echo
cat <<EOF
Pour monter une base dessus :
    make redump DUMP=$OUT

⚠️  Ce dump porte des donnees reelles. Il est ecrit hors depot par defaut :
    ne pas le commiter sans decision explicite (depot public).
EOF
