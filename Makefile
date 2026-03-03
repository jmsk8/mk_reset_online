# ──────────────────────────────────────────────
#  MK Reset Online – Docker Management
# ──────────────────────────────────────────────

COMPOSE       = docker compose
COMPOSE_DUMP  = $(COMPOSE) -f docker-compose.yml -f docker-compose.dump.yml

# ── Lifecycle ─────────────────────────────────

up:                  ## Start containers
	$(COMPOSE) up -d

stop:                ## Stop containers (keep volumes)
	$(COMPOSE) stop

start:               ## Restart stopped containers
	$(COMPOSE) start

build:               ## Build/rebuild images and start
	$(COMPOSE) up --build -d

down:                ## Stop and remove containers/networks
	$(COMPOSE) down

fclean:              ## Full cleanup (containers + volumes + images)
	$(COMPOSE) down -v --rmi local

# ── Re-create ────────────────────────────────

re: fclean build     ## Full cleanup then rebuild (schema + seed)

redump: fclean       ## Full cleanup then rebuild with dump.sql
	$(COMPOSE_DUMP) up --build -d

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

db-backup:           ## Dump database to backups/
	@mkdir -p backups
	$(COMPOSE) exec db pg_dump -U $${POSTGRES_USER} $${POSTGRES_DB} > backups/backup_$$(date +%Y%m%d_%H%M%S).sql
	@echo "Backup saved to backups/"

# ── Help ─────────────────────────────────────

help:                ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

.PHONY: up stop start build down fclean re redump \
        logs logs-nginx logs-front logs-back logs-db ps \
        db-shell db-backup help

.DEFAULT_GOAL := help
