# Deux etapes : une image de build avec le compilateur, une image finale qui
# n'a que le binaire. Meme posture que le Dockerfile JS — les dependances sont
# declarees et epinglees (le tag uWebSockets dans CMakeLists.txt), rien n'est
# recupere a l'execution.
FROM alpine:3.20 AS builder

RUN apk add --no-cache \
    build-base \
    cmake \
    git \
    linux-headers \
    zlib-dev

WORKDIR /build

COPY CMakeLists.txt ./
COPY src/ src/

# `FetchContent` va chercher uWebSockets ici, a la construction : c'est la seule
# etape qui a besoin du reseau.
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel

# ── Image finale ────────────────────────────────────────────────────────────
#
# Alpine, et pas `scratch` : docker-compose.yml teste la sante du service avec
# `wget -qO- http://localhost:3000/healthz`, et sans healthcheck vert nginx ne
# demarre pas du tout (`depends_on: race: service_healthy`). Alpine fournit le
# wget de busybox — c'est ce qui decide du choix de cette image.
FROM alpine:3.20

RUN apk add --no-cache libstdc++ zlib

WORKDIR /app

COPY --from=builder /build/build/race_engine /app/race_engine

# tracks/ n'est PAS copie, et c'est delibere : ce sont des dessins, pas du code.
# Monte par docker-compose, un circuit retouche part en course au prochain
# `make restart-race` ; copie, il faudrait reconstruire l'image pour deplacer
# une boite a objets.

# Convention du depot : aucun service ne tourne en root.
RUN adduser -D -u 1000 race
USER race

EXPOSE 3000

CMD ["/app/race_engine"]
