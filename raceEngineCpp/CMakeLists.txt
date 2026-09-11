cmake_minimum_required(VERSION 3.22)
# C ET CXX : uSockets, la couche reseau sous uWebSockets, est ecrite en C. Sans
# le `C` ici, CMake ne sait pas quel compilateur employer pour ses .c et refuse
# de lier la cible.
project(race_engine C CXX)

# C++20 pour std::to_chars sur les doubles (representation decimale la plus
# courte, cf. plan §5.4) et les designated initializers des structs de donnees.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include(FetchContent)

# uWebSockets par FetchContent sur un tag fige, jamais en submodule : le depot
# n'en a aucun, et le Dockerfile JS epingle ses dependances de la meme facon
# (`npm install --omit=dev`). uSockets est la couche C sous uWS, livree dans le
# meme depot et compilee a la main : elle n'a pas de CMakeLists.
FetchContent_Declare(
    uwebsockets
    GIT_REPOSITORY https://github.com/uNetworking/uWebSockets.git
    GIT_TAG        v20.62.0
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(uwebsockets)

# Les sources sont listees UNE PAR UNE, jamais par `file(GLOB)` : un glob
# s'evalue a la configuration, avant meme que FetchContent ait telecharge quoi
# que ce soit — la cible sortait vide, sans langage, et CMake refusait de la
# lier. La liste explicite dit aussi ce qu'on N'EMBARQUE PAS : ni OpenSSL, ni
# libuv, ni io_uring, ni gcd.
set(USOCKETS_SOURCES
    ${uwebsockets_SOURCE_DIR}/uSockets/src/bsd.c
    ${uwebsockets_SOURCE_DIR}/uSockets/src/context.c
    ${uwebsockets_SOURCE_DIR}/uSockets/src/loop.c
    ${uwebsockets_SOURCE_DIR}/uSockets/src/socket.c
    ${uwebsockets_SOURCE_DIR}/uSockets/src/udp.c
    # L'evenementiel : epoll sous Linux, le seul systeme que ce service vise.
    ${uwebsockets_SOURCE_DIR}/uSockets/src/eventing/epoll_kqueue.c
)

add_library(usockets STATIC ${USOCKETS_SOURCES})
target_include_directories(usockets PUBLIC ${uwebsockets_SOURCE_DIR}/uSockets/src)
# LIBUS_NO_SSL : le TLS est termine par nginx en amont, le service ne parle que
# du HTTP clair sur le reseau `frontend`. Sans ce define, uSockets exige OpenSSL
# dans l'image de build pour rien.
target_compile_definitions(usockets PUBLIC LIBUS_NO_SSL=1)

find_package(ZLIB REQUIRED)

add_executable(race_engine
    src/main.cpp
    src/service/server.cpp
    src/json.cpp
    src/protocol.cpp
    src/track.cpp
    src/config/config.cpp
    src/engine/geometry.cpp
    src/engine/world.cpp
    src/engine/camera.cpp
    src/engine/race.cpp
    src/engine/standings.cpp
    src/engine/steering.cpp
    src/engine/road.cpp
    src/engine/pipes.cpp
    src/engine/step.cpp
    src/tools/tracks.cpp
    src/tools/simulate.cpp
)

target_include_directories(race_engine PRIVATE
    src
    ${uwebsockets_SOURCE_DIR}/src
)

target_link_libraries(race_engine PRIVATE usockets ZLIB::ZLIB)
