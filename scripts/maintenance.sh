#!/usr/bin/env bash
# Mode maintenance : le public voit nginx/maintenance/page.html, le détenteur du
# passe voit le vrai site.
#
#   scripts/maintenance.sh on       active (ou réaffiche le passe si déjà actif)
#   scripts/maintenance.sh off      désactive
#   scripts/maintenance.sh status   dit ce que nginx sert en ce moment
#
# Le passe est un cookie. On l'obtient en ouvrant UNE fois l'adresse affichée
# par `on` dans son navigateur. La clé est tirée au hasard à chaque activation :
# elle n'est pas dans le dépôt (public), et une clé lue dans les journaux nginx
# ne sert plus à rien la fois suivante.
#
# L'interrupteur est le fichier nginx/maintenance/actif.conf, inclus par
# nginx/snippets/app.conf. Après l'avoir écrit ou supprimé, on recharge nginx
# puis on VÉRIFIE le code qu'il renvoie : le reload qui réussit sans rien
# changer est un piège déjà rencontré ici (docs/audit-503-zone-admin.md §12).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTIF="$ROOT_DIR/nginx/maintenance/actif.conf"
COMPOSE=(docker compose --project-directory "$ROOT_DIR")

env_val() {
  [ -f "$ROOT_DIR/.env" ] || return 0
  { grep -E "^$1=" "$ROOT_DIR/.env" || true; } | tail -n1 | cut -d= -f2- | tr -d "\"'"
}

nginx_tourne() {
  [ -n "$("${COMPOSE[@]}" ps -q --status running nginx 2>/dev/null)" ]
}

# Code HTTP que nginx renvoie pour « / » à un visiteur sans passe.
code_servi() {
  local url="http://127.0.0.1/"
  [ "$(env_val TLS_MODE)" = "https" ] && url="https://127.0.0.1/"
  "${COMPOSE[@]}" exec -T nginx sh -c \
    "wget -S --spider --no-check-certificate -T 5 '$url' 2>&1 | awk '/^  HTTP\//{c=\$2} END{print c}'" \
    || true
}

recharger() {
  if ! nginx_tourne; then
    echo "nginx ne tourne pas : l'état sera pris en compte à son démarrage."
    return 0
  fi
  # Le montage n'existe que dans un conteneur créé après son ajout au compose.
  if ! "${COMPOSE[@]}" exec -T nginx test -f /etc/nginx/maintenance/page.html; then
    echo "Le conteneur nginx ne voit pas nginx/maintenance/ : il date d'avant le mode maintenance." >&2
    echo "Recrée-le une fois (quelques secondes de coupure) :" >&2
    echo "  docker compose up -d --force-recreate nginx" >&2
    return 1
  fi
  if ! "${COMPOSE[@]}" exec -T nginx nginx -t -q; then
    echo "Configuration nginx refusée : rien n'a été rechargé." >&2
    return 1
  fi
  # Le « signal process started » de nginx n'apprend rien : la vérification
  # du code servi, elle, dit si le rechargement a pris.
  "${COMPOSE[@]}" exec -T nginx nginx -s reload 2>/dev/null
  # Le reload est asynchrone : les nouveaux workers prennent le relais en un
  # instant, mais pas forcément avant la vérification qui suit.
  sleep 1
}

afficher_passe() {
  local cle domaine
  cle=$(sed -n 's/.*cookie_mk_passe = "\([0-9a-f]*\)".*/\1/p' "$ACTIF" | head -n1)
  domaine=$(env_val DOMAIN)
  echo
  echo "  Ton passe (à ouvrir une fois dans chaque navigateur qui doit voir le vrai site) :"
  if [ -n "$domaine" ] && [ "$domaine" != "localhost" ]; then
    echo "    https://$domaine/_maintenance/entrer?cle=$cle"
  else
    echo "    <adresse du site>/_maintenance/entrer?cle=$cle"
  fi
  echo
}

case "${1:-}" in
  on)
    if [ -f "$ACTIF" ]; then
      echo "Maintenance déjà active : même clé, ton passe reste valable."
    else
      cle=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
      # `umask` : la clé n'a pas à être lisible par les autres comptes de l'hôte.
      # nginx la lit en root au chargement, avant de passer ses workers en nginx.
      ( umask 077; cat > "$ACTIF" <<EOF
# Généré par \`make maintenance-on\` -- supprimé par \`make maintenance-off\`.
# Ne pas commiter (.gitignore) : c'est la clé de passe du moment.

set \$mk_maintenance 1;
if (\$cookie_mk_passe = "$cle") { set \$mk_maintenance 0; }
# La page de maintenance et son décor, et le renouvellement du certificat.
if (\$uri ~ "^/(_maintenance|\.well-known/acme-challenge/)") { set \$mk_maintenance 0; }
if (\$mk_maintenance) { return 503; }

# Pose le passe puis renvoie à l'accueil. Mauvaise clé : 404, comme une page
# qui n'existe pas.
location = /_maintenance/entrer {
    if (\$arg_cle != "$cle") { return 404; }
    add_header Set-Cookie "mk_passe=$cle; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax" always;
    add_header Cache-Control "no-store" always;
    # Redirection relative : en prod, le TLS est fait par le proxy externe et
    # nginx, qui ne voit que du http, écrirait « http://… » en absolu.
    absolute_redirect off;
    return 302 /;
}
EOF
      )
      echo "Interrupteur posé : $ACTIF"
    fi
    recharger || { rm -f "$ACTIF"; echo "Maintenance NON activée." >&2; exit 1; }
    if nginx_tourne; then
      code=$(code_servi)
      if [ "$code" = "503" ]; then
        echo "Vérifié : le public reçoit la page de maintenance (503)."
      else
        echo "ATTENTION : nginx renvoie « ${code:-rien} » au lieu de 503 au public." >&2
        exit 1
      fi
    fi
    afficher_passe
    ;;

  off)
    if [ ! -f "$ACTIF" ]; then
      echo "Maintenance déjà inactive."
    else
      rm -f "$ACTIF"
      echo "Interrupteur retiré."
    fi
    recharger
    if nginx_tourne; then
      code=$(code_servi)
      case "$code" in
        2*|3*) echo "Vérifié : le public voit le site ($code)." ;;
        502|504) echo "Maintenance levée, mais le frontend ne répond pas ($code) : le public voit encore la page d'attente." >&2; exit 1 ;;
        *) echo "ATTENTION : nginx renvoie « ${code:-rien} » au public." >&2; exit 1 ;;
      esac
    fi
    ;;

  status)
    if [ -f "$ACTIF" ]; then echo "Interrupteur : ACTIF"; else echo "Interrupteur : inactif"; fi
    if nginx_tourne; then
      echo "Code servi au public pour / : $(code_servi)"
    else
      echo "nginx ne tourne pas."
    fi
    if [ -f "$ACTIF" ]; then afficher_passe; fi
    ;;

  *)
    echo "usage : $0 on|off|status" >&2
    exit 2
    ;;
esac
