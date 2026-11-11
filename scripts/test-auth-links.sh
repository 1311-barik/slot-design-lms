#!/usr/bin/env bash
set -euo pipefail
# Только одноразовая локальная БД CI; никаких рабочих ключей или реальных писем.
LMS_LINK_TEST_DIR=$(mktemp -d)
LMS_LINK_TEST_PID=''
cleanup() {
  if [[ -n "$LMS_LINK_TEST_PID" ]]; then kill "$LMS_LINK_TEST_PID" 2>/dev/null || true; wait "$LMS_LINK_TEST_PID" 2>/dev/null || true; fi
  rm -rf -- "$LMS_LINK_TEST_DIR"
}
trap cleanup EXIT
export LMS_MODE=local
export APP_ORIGIN=http://127.0.0.1:8793
export DATABASE_URL="${LMS_TEST_DATABASE_URL:-postgres://$(id -un)@127.0.0.1:54431/igaming_lms_test}"
export LMS_RUNTIME_DIR="$LMS_LINK_TEST_DIR/runtime"
for key in $(compgen -e); do case "$key" in SUPABASE_*|SMTP_*|MAIL_*|BREVO_*) unset "$key" ;; esac; done
node scripts/next.mjs start --hostname 127.0.0.1 --port 8793 >"$LMS_LINK_TEST_DIR/server.log" 2>&1 &
LMS_LINK_TEST_PID=$!
for ((i=0;i<30;i++)); do
  if curl --silent --fail "$APP_ORIGIN/api/v1/config" >/dev/null; then break; fi
  kill -0 "$LMS_LINK_TEST_PID" 2>/dev/null || { cat "$LMS_LINK_TEST_DIR/server.log"; exit 1; }
  sleep 1
done
QA_ORIGIN="$APP_ORIGIN" node --import tsx tests/persistent-links.integration.ts
QA_ORIGIN="$APP_ORIGIN" node --import tsx tests/early-commencement.integration.ts
