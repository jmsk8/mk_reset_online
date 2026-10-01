# Build en deux etapes : compilation, puis image finale avec le seul binaire.
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

# FetchContent telecharge uWebSockets ici (seule etape reseau).
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel

# ── Image finale ───────────────────────────────────────────────
# Alpine pour le wget du healthcheck (docker-compose.yml).
FROM alpine:3.20

RUN apk add --no-cache libstdc++ zlib

WORKDIR /app

COPY --from=builder /build/build/race_engine /app/race_engine

# tracks/ est monte par docker-compose (pas besoin de reconstruire l'image).

# Utilisateur non root.
RUN adduser -D -u 1000 race
USER race

EXPOSE 3000

CMD ["/app/race_engine"]
