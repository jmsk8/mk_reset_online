#!/bin/sh
set -e

[ "${TLS_MODE:-http}" = "https" ] || exit 0

( while :; do sleep 6h; nginx -s reload; done ) &
