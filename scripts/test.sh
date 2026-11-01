#!/bin/sh
set -eu
# Подготовка изолированной базы переносима между macOS и Linux; psql не нужен.
exec node --import tsx scripts/test.mjs "$@"
