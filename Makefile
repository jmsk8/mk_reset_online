# ──────────────────────────────────────────────
#  MK Reset Online – Docker Management
# ──────────────────────────────────────────────

COMPOSE       = docker compose
COMPOSE_DUMP  = $(COMPOSE) -f docker-compose.yml -f docker-compose.dump.yml

# ── Pré-requis ────────────────────────────────

check-env:           ## Vérifie/crée le .env nécessaire au lancement
	@bash scripts/check_env.sh

# ── Lifecycle ─────────────────────────────────

up: check-env        ## Start containers
	$(COMPOSE) up -d

stop:                ## Stop containers (keep volumes)
	$(COMPOSE) stop

start:               ## Restart stopped containers
	$(COMPOSE) start

build: check-env     ## Build/rebuild images and start
	$(COMPOSE) up --build -d

down:                ## Stop and remove containers/networks
	$(COMPOSE) down

fclean:              ## Full cleanup (containers + volumes + images)
	$(COMPOSE) down -v --rmi local

distclean:           ## Full cleanup + .env (CERTS=1 to also remove certbot/)
	@bash scripts/distclean.sh $(if $(CERTS),--certs,)

# ── Re-create ────────────────────────────────

re: fclean build     ## Full cleanup then rebuild (schema + seed)

redump: check-env fclean ## Full cleanup then rebuild with dump.sql
	$(COMPOSE_DUMP) up --build -d

# ── Rebuild individual services ──────────────

re-front:            ## Rebuild and restart frontend
	$(COMPOSE) up --build -d --no-deps frontend

re-back:             ## Rebuild and restart backend
	$(COMPOSE) up --build -d --no-deps backend

re-db:               ## Recreate database (schema + seed)
	$(COMPOSE) stop db
	$(COMPOSE) rm -f db
	docker volume rm -f $$($(COMPOSE) config --volumes | grep pg_data | head -1) 2>/dev/null || true
	$(COMPOSE) up -d db

re-db-dump:          ## Recreate database with dump.sql
	$(COMPOSE) stop db
	$(COMPOSE) rm -f db
	docker volume rm -f $$($(COMPOSE) config --volumes | grep pg_data | head -1) 2>/dev/null || true
	$(COMPOSE_DUMP) up -d db

# ── HTTPS (Let's Encrypt) ────────────────────

ssl-init:            ## Issue initial certificate and switch to https
	@bash scripts/init-letsencrypt.sh $(DOMAIN) $(EMAIL)

ssl-renew:           ## Force certificate renewal and reload nginx
	$(COMPOSE) run --rm --entrypoint certbot certbot renew --force-renewal
	$(COMPOSE) exec nginx nginx -s reload

ssl-off:             ## Switch back to http (certificate kept)
	@sed -i 's/^TLS_MODE=.*/TLS_MODE=http/' .env
	$(COMPOSE) up -d nginx

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

# ── Help ─────────────────────────────────────

help:                ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

.PHONY: check-env up stop start build down fclean distclean re redump \
        re-front re-back re-db re-db-dump \
        ssl-init ssl-renew ssl-off \
        logs logs-nginx logs-front logs-back logs-db ps \
        db-shell help

.DEFAULT_GOAL := help
