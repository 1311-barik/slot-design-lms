#!/bin/sh
set -eu
# Без локали Postgres 16 на macOS не стартует: «postmaster became multithreaded during startup».
export LC_ALL=${LC_ALL:-en_US.UTF-8}
LMS_RUNTIME_DIR=${LMS_RUNTIME_DIR:-/private/tmp/igaming-lms-development}
LMS_PG_BIN=${LMS_PG_BIN:-/opt/homebrew/bin}
mkdir -p "$LMS_RUNTIME_DIR"
if [ ! -f "$LMS_RUNTIME_DIR/pg/PG_VERSION" ]; then
  "$LMS_PG_BIN/initdb" -D "$LMS_RUNTIME_DIR/pg" --auth-local=trust --auth-host=trust --no-locale -E UTF8 >/dev/null
fi
if ! "$LMS_PG_BIN/pg_ctl" -D "$LMS_RUNTIME_DIR/pg" status >/dev/null 2>&1; then
  "$LMS_PG_BIN/pg_ctl" -D "$LMS_RUNTIME_DIR/pg" -l "$LMS_RUNTIME_DIR/postgres.log" -o "-p 54431 -h 127.0.0.1 -k $LMS_RUNTIME_DIR" start
fi
if ! "$LMS_PG_BIN/psql" -h 127.0.0.1 -p 54431 -d postgres -tAc "select 1 from pg_database where datname='igaming_lms'" | /usr/bin/grep -q 1; then
  "$LMS_PG_BIN/createdb" -h 127.0.0.1 -p 54431 igaming_lms
fi
