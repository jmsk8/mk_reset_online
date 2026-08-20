# ──────────────────────────────────────────────
#  MK Reset Online – Docker Management
# ──────────────────────────────────────────────

COMPOSE       = docker compose
WEB_NETWORK  ?= web
# Un -f explicite annule le chargement automatique de l'override.
OVERRIDE      = $(wildcard docker-compose.override.yml)
COMPOSE_DUMP  = $(COMPOSE) -f docker-compose.yml $(if $(OVERRIDE),-f $(OVERRIDE)) -f docker-compose.dump.yml

# Dump utilisé par les cibles *dump*. Surchargeable : make redump DUMP=dumps/dump_2026-07-27.sql
DUMP         ?= backEnd/dump.sql
DUMP_FILE     = $(if $(filter /%,$(DUMP)),$(DUMP),./$(DUMP))
export DUMP_FILE

# Le volume porte le nom du projet en préfixe : `config --volumes` ne renvoie
# que le nom déclaré, insuffisant pour docker volume rm.
RM_PG_VOLUME = vol=$$($(COMPOSE) config | awk '/^volumes:/{v=1} v && /name:/{print $$2; exit}'); \
	if docker volume inspect "$$vol" >/dev/null 2>&1; then \
		docker volume rm -f "$$vol" >/dev/null && echo "Volume $$vol supprimé"; \
	else \
		echo "Volume $$vol absent (rien à supprimer)"; \
	fi

WAIT_DB = printf 'Attente de la base'; \
	for i in $$(seq 1 60); do \
		if $(COMPOSE) exec -T db pg_isready -q 2>/dev/null; then echo " prête"; break; fi; \
		printf '.'; sleep 1; \
	done

# Vérifie que l'initialisation a bien peuplé la base : sans ça, un échec du
# script d'init passe inaperçu (docker compose up réussit malgré tout).
DB_STATUS = $(COMPOSE) exec -T db sh -c \
	'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -tAc \
	 "SELECT '\''joueurs='\'' || (SELECT COUNT(*) FROM joueurs) || '\''  tournois='\'' || (SELECT COUNT(*) FROM tournois);"' \
	|| echo "ATTENTION : base vide ou non initialisée — vérifie 'make logs-db'"

# Le backend garde un cache mémoire de 300 s, invalidé seulement par ses
# propres écritures : après une restauration, il faut le relancer.
RESTART_APP = echo "Redémarrage du backend (vidage du cache)"; \
	$(COMPOSE) restart backend >/dev/null

# ── Pré-requis ────────────────────────────────

check-env:           ## Vérifie/crée le .env nécessaire au lancement
	@bash scripts/check_env.sh

check-net:           ## Crée le réseau du reverse proxy si un override local l'utilise
	@test -n "$(OVERRIDE)" || exit 0; \
	docker network inspect $(WEB_NETWORK) >/dev/null 2>&1 \
		|| { docker network create $(WEB_NETWORK) >/dev/null && echo "Réseau $(WEB_NETWORK) créé"; }

check-dump:          ## Vérifie que le dump ciblé existe et est lisible par le conteneur
	@test -f "$(DUMP)" || { \
		echo "Dump introuvable : $(DUMP)"; \
		echo "Dumps disponibles :"; \
		ls -1 dumps/*.sql backEnd/dump.sql 2>/dev/null | sed 's/^/  /' || echo "  (aucun)"; \
		exit 1; }
	@test -s "$(DUMP)" || { echo "Dump vide : $(DUMP)"; exit 1; }
	@# postgres tourne en uid 70 dans le conteneur : sans o+r, l'init échoue
	@# silencieusement (docker compose up réussit malgré tout).
	@if [ ! -r "$(DUMP)" ] || [ -z "$$(find "$(DUMP)" -perm -o=r)" ]; then \
		chmod o+r "$(DUMP)" 2>/dev/null \
			&& echo "Permissions corrigées (o+r) : $(DUMP) est maintenant lisible par postgres (uid 70)" \
			|| { echo "$(DUMP) n'est pas lisible par le conteneur (uid 70) et chmod a échoué."; exit 1; }; \
	fi
	@echo "Dump ciblé : $(DUMP) ($$(du -h "$(DUMP)" | cut -f1))"

# ── Lifecycle ─────────────────────────────────

up: check-env check-net ## Start containers
	$(COMPOSE) up -d

stop:                ## Stop containers (keep volumes)
	$(COMPOSE) stop

start:               ## Restart stopped containers
	$(COMPOSE) start

build: check-env check-net ## Build/rebuild images and start
	$(COMPOSE) up --build -d

down:                ## Stop and remove containers/networks
	$(COMPOSE) down

fclean:              ## Full cleanup (containers + volumes + images)
	$(COMPOSE) down -v --rmi local

distclean:           ## Full cleanup + .env (CERTS=1 to also remove certbot/)
	@bash scripts/distclean.sh $(if $(CERTS),--certs,)

# ── Re-create ────────────────────────────────

re: fclean build     ## Full cleanup then rebuild (schema + seed)

redump: check-env check-net check-dump fclean ## Full cleanup then rebuild from DUMP
	$(COMPOSE_DUMP) up --build -d
	@$(WAIT_DB)
	@$(DB_STATUS)

# ── Rebuild individual services ──────────────

re-front:            ## Rebuild and restart frontend
	$(COMPOSE) up --build -d --no-deps frontend

re-back:             ## Rebuild and restart backend
	$(COMPOSE) up --build -d --no-deps backend

re-db:               ## Recreate database (schema + seed)
	$(COMPOSE) stop db
	$(COMPOSE) rm -f db
	@$(RM_PG_VOLUME)
	$(COMPOSE) up -d db
	@$(WAIT_DB)
	@$(DB_STATUS)
	@$(RESTART_APP)

re-db-dump: check-dump ## Recreate database from DUMP
	$(COMPOSE) stop db
	$(COMPOSE) rm -f db
	@$(RM_PG_VOLUME)
	$(COMPOSE_DUMP) up -d db
	@$(WAIT_DB)
	@$(DB_STATUS)
	@$(RESTART_APP)

# ── Monitoring ───────────────────────────────

logs:                ## Follow all logs
	$(COMPOSE) logs -f

logs-nginx:          ## Follow nginx logs
	$(COMPOSE) logs -f nginx

logs-front:          ## Follow frontend logs
	$(COMPOSE) logs -f frontend

logs-back:           ## Follow backend logs
	$(COMPOSE) logs -f backend

logs-db:             ## Follow database logs
	$(COMPOSE) logs -f db

ps:                  ## Show running containers
	$(COMPOSE) ps

# ── Database ─────────────────────────────────

db-shell:            ## Open psql shell
	$(COMPOSE) exec db psql -U $${POSTGRES_USER} -d $${POSTGRES_DB}

db-dump:             ## Dump the running database into dumps/ (NAME=... to pick the file name)
	@bash scripts/db-dump.sh $(NAME)

db-example:          ## Rebuild the fictional example dump (backEnd/dump.sql)
	@bash scripts/build-example-dump.sh

db-migrate:          ## Applique une migration SQL (FILE=backEnd/migrations/xxx.sql)
	@test -n "$(FILE)" || { echo "Usage : make db-migrate FILE=backEnd/migrations/xxx.sql"; exit 1; }
	$(COMPOSE) exec -T db psql -U $${POSTGRES_USER} -d $${POSTGRES_DB} < $(FILE)
	@$(RESTART_APP)

ip-backfill:         ## Reconstitue les grilles figées IP v2 des tournois déjà joués (DRY=1 pour simuler, SINCE=AAAA-MM-JJ)
	$(COMPOSE) exec -T backend python - $(if $(DRY),--dry-run) $(if $(SINCE),--since $(SINCE)) < scripts/backfill_grille_snapshots.py
	@$(if $(DRY),true,$(RESTART_APP))

# ── Help ─────────────────────────────────────

help:                ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

.PHONY: check-env check-net check-dump up stop start build down fclean distclean re redump \
        re-front re-back re-db re-db-dump db-migrate ip-backfill \
        logs logs-nginx logs-front logs-back logs-db ps \
        db-shell db-dump db-example help

.DEFAULT_GOAL := help
