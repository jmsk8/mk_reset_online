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

# --force-recreate : physics.js et physics-config.js sont montes, pas copies
# dans l'image. Sans lui, quand seuls ces deux fichiers changent l'image reste
# identique, compose repond « up-to-date » et ne recree rien — le process Node
# garde alors l'ancienne config en cache (require au demarrage). Avec, le
# moteur repart toujours d'un process neuf, donc d'un grand prix neuf.
re-race:             ## Rebuild and restart the banner race engine (nouveau grand prix)
	$(COMPOSE) up --build -d --no-deps --force-recreate race

# SIGHUP plutot qu'un redemarrage de conteneur : le service, les connexions
# WebSocket et l'image restent en place, mais le grand prix repart de zero —
# scores effaces et grille tiree au sort.
restart-race:        ## Relance un grand prix neuf sans couper le service
	$(COMPOSE) kill -s HUP race

# A lancer apres une modification de nginx/. Le rechargement relit la config et
# reresout les upstreams, sans couper les connexions en cours.
reload-nginx:        ## Recharge la configuration nginx
	$(COMPOSE) exec nginx nginx -t
	$(COMPOSE) exec nginx nginx -s reload

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

logs-race:           ## Follow race engine logs
	$(COMPOSE) logs -f race

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

# ── Moteur de course (banner) ────────────────

# Emprunte une image node le temps d'un test, sans rien installer sur la machine
# ni toucher a la stack. Les options de `docker run` et l'image sont separees :
# tout ce qui vient apres l'image serait passe au conteneur, pas a docker.
RACE_DOCKER = docker run --rm -u "$$(id -u):$$(id -g)" -e npm_config_cache=/tmp/.npm \
	-v "$$(pwd):/repo" -w /repo/raceEngine
RACE_IMAGE  = node:22-alpine
RACE_NODE   = $(RACE_DOCKER) $(RACE_IMAGE)

race-deps:           ## Installe ws dans raceEngine/node_modules (pour les tests hors conteneur)
	$(RACE_NODE) npm install --no-audit --no-fund

# Relit les circuits dessines dans tracks/ et les traduit en chiffres : longueur
# du tour, place de la ligne, profondeur des boites. A passer apres chaque coup
# de crayon — le service, lui, refuse de demarrer sur un dessin faux.
race-tracks:         ## Verifie les circuits de tracks/ (ORDER=1 pour l'ordre des manches)
	$(RACE_NODE) node tools/tracks.js $(if $(ORDER),--order,)

race-soak:           ## Soak du moteur seul, 10 min, sans WebSocket (DURATION=... pour changer)
	$(RACE_NODE) node server.js --duration $${DURATION:-600} --always-on

# Banc d'equilibrage : enchaine des courses hors horloge, des milliers en
# quelques secondes. RACES=... pour la taille de l'echantillon, SEED=... pour
# rejouer la meme campagne, CHAIN=1 pour enchainer les grilles comme en prod
# (vainqueur en pole) au lieu de tirer au sort a chaque course.
#
# Par defaut la campagne enchaine tous les circuits de tracks/, comme le fait un
# grand prix : c'est le jeu tel qu'il se joue. TRACK=... n'en garde qu'un, pour
# juger un trace en particulier sans que les autres diluent la mesure.
race-sim:            ## Simule N courses et sort les stats (RACES=1000 SEED=42 CHAIN=1 CSV=1 TRACK=anneau)
	$(RACE_NODE) node tools/simulate.js --races $${RACES:-200} \
		$(if $(SEED),--seed $(SEED),) $(if $(CHAIN),--chain,) $(if $(CSV),--csv,) \
		$(if $(TRACK),--track $(TRACK),)

race-spectate:       ## Test de l'arrivant contre le service `race` en cours d'execution (AFTER=... secondes)
	$(COMPOSE) exec race node tools/spectate.js --after $${AFTER:-30}

# Meme test, mais par l'URL publique : c'est le seul qui traverse nginx, donc le
# seul qui verifie l'upgrade WebSocket, les timeouts et limit_conn.
#
# 127.0.0.1 et non localhost : node resout localhost en ::1 en priorite, alors
# que docker ne publie le port que sur 0.0.0.0 — donc en IPv4 uniquement.
race-nginx:          ## Test de l'arrivant a travers nginx (URL=... pour viser un autre hote)
	$(RACE_DOCKER) --network host $(RACE_IMAGE) node tools/spectate.js --url $${URL:-ws://127.0.0.1/ws/race} --after $${AFTER:-10}

# ── Help ─────────────────────────────────────

help:                ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

.PHONY: check-env check-net check-dump up stop start build down fclean distclean re redump \
        re-front re-back re-race restart-race re-db re-db-dump db-migrate ip-backfill \
        race-deps race-tracks race-soak race-sim race-spectate race-nginx \
        reload-nginx logs logs-nginx logs-front logs-back logs-race logs-db ps \
        db-shell db-dump db-example help

.DEFAULT_GOAL := help

