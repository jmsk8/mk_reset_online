cmake_minimum_required(VERSION 3.22)
# C et CXX : uSockets est ecrit en C.
project(race_engine C CXX)

# C++20 pour std::to_chars sur les doubles et les designated initializers.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include(FetchContent)

# uWebSockets par FetchContent sur un tag fige ; uSockets (couche C) est compile
# a la main, faute de CMakeLists.
FetchContent_Declare(
    uwebsockets
    GIT_REPOSITORY https://github.com/uNetworking/uWebSockets.git
    GIT_TAG        v20.62.0
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(uwebsockets)

# Sources listees explicitement (un glob serait evalue avant FetchContent).
# Ni OpenSSL, ni libuv, ni io_uring, ni gcd.
set(USOCKETS_SOURCES
    ${uwebsockets_SOURCE_DIR}/uSockets/src/bsd.c
    ${uwebsockets_SOURCE_DIR}/uSockets/src/context.c
    ${uwebsockets_SOURCE_DIR}/uSockets/src/loop.c
    ${uwebsockets_SOURCE_DIR}/uSockets/src/socket.c
    ${uwebsockets_SOURCE_DIR}/uSockets/src/udp.c
    # epoll sous Linux.
    ${uwebsockets_SOURCE_DIR}/uSockets/src/eventing/epoll_kqueue.c
)

add_library(usockets STATIC ${USOCKETS_SOURCES})
target_include_directories(usockets PUBLIC ${uwebsockets_SOURCE_DIR}/uSockets/src)
# Pas de TLS : il est termine par nginx.
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
