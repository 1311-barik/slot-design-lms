#!/usr/bin/env bash
# Сборка обычным пользователем; sudo нужен только для установки release и управления LMS.
set -euo pipefail
ROOT=/opt/slot-design-lms
NODE_BIN=${LMS_NODE_BIN:-/opt/slot-design-node/bin/node}
usage() { echo 'Usage: bash scripts/deploy.sh https://lms.example.org [--rollback RELEASE_NAME]' >&2; exit 2; }
[[ $# == 1 || ( $# == 3 && $2 == --rollback ) ]] || usage
[[ $(uname -s) == Linux && $EUID != 0 ]] || { echo 'Run on Linux as the regular deploy user, not root.' >&2; exit 2; }
[[ -x "$NODE_BIN" ]] || { echo 'Install Node 24 and set /opt/slot-design-node (see SERVER-SETUP).' >&2; exit 2; }
PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || { echo 'Node 24 is required.' >&2; exit 2; }
ORIGIN=$1
HOST=$(node -e 'const u=new URL(process.argv[1]); const local=["127.0.0.1","localhost","[::1]"].includes(u.hostname); if(u.origin!==process.argv[1]||(!local&&u.protocol!=="https:"))process.exit(2); process.stdout.write(u.host)' "$ORIGIN") || usage
for tool in git npm curl tar sudo; do command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 2; }; done
cd "$(dirname "$0")/.."
sudo -v
id lms >/dev/null
sudo test -f /etc/slot-design-lms/env
sudo test -f /etc/systemd/system/slot-design-lms.service
sudo test -d "$ROOT/releases"
[[ ! -e "$ROOT/current" || -L "$ROOT/current" ]] || { echo 'current must be a symlink, not a directory.' >&2; exit 2; }
sudo mkdir "$ROOT/.deploy-lock" || { echo 'Another deployment is running (or a stale .deploy-lock needs inspection).' >&2; exit 2; }
BUILD=''
SWITCHED=false
MAIL_WAS_RUNNING=false
PREVIOUS=''
if [[ -L "$ROOT/current" ]]; then PREVIOUS=$(readlink -f "$ROOT/current"); fi
if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$ROOT/releases/"* ]]; then sudo rmdir "$ROOT/.deploy-lock"; echo 'Unexpected current target.' >&2; exit 2; fi
link_release() {
  sudo ln -s "$1" "$ROOT/current.next" && sudo mv -Tf "$ROOT/current.next" "$ROOT/current"
}
cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if [[ $result != 0 && $SWITCHED == true ]]; then
    echo 'Activation failed; restoring the previous code release.' >&2
    if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
      if link_release "$PREVIOUS"; then
        sudo systemctl restart slot-design-lms.service || echo 'Previous release could not restart; inspect journalctl.' >&2
      else
        sudo systemctl stop slot-design-lms.service
        echo 'Could not restore the previous symlink; manual recovery is required.' >&2
      fi
    else
      sudo systemctl stop slot-design-lms.service || true
      echo 'First installation failed. No previous release exists; the application is stopped.' >&2
    fi
  fi
  if [[ $MAIL_WAS_RUNNING == true ]]; then
    sudo systemctl start slot-design-lms-mail.service || { echo 'Mail worker did not restart; inspect it separately.' >&2; result=1; }
  fi
  [[ -z "$BUILD" ]] || rm -rf -- "$BUILD"
  sudo rmdir "$ROOT/.deploy-lock" || true
  exit "$result"
}
trap cleanup EXIT

if [[ $# == 3 ]]; then
  [[ $3 =~ ^[a-f0-9]{12}-[0-9]{14}$ ]] || usage
  RELEASE="$ROOT/releases/$3"
  [[ -d "$RELEASE" && ! -L "$RELEASE" && -f "$RELEASE/.next/BUILD_ID" && -f "$RELEASE/DEPLOYED_COMMIT" ]] || { echo 'Not a prepared release.' >&2; exit 2; }
else
  [[ -z $(git status --porcelain) ]] || { echo 'Commit or remove working changes before deploying an exact Git revision.' >&2; exit 2; }
  COMMIT=$(git rev-parse HEAD)
  RELEASE="$ROOT/releases/${COMMIT:0:12}-$(date -u +%Y%m%d%H%M%S)"
  BUILD=$(mktemp -d /var/tmp/slot-design-lms-build.XXXXXXXX)
  git archive HEAD | tar -x -C "$BUILD"
  (
    cd "$BUILD"
    # Сборка не должна получать рабочие ключи или почтовые настройки.
    for key in $(compgen -e); do
      case "$key" in DATABASE_URL|LMS_*|APP_ORIGIN|SUPABASE_*|MAIL_*|SMTP_*|BREVO_*) unset "$key" ;; esac
    done
    export NEXT_TELEMETRY_DISABLED=1
    npm ci
    npm run build
    printf '%s\n' "$COMMIT" > DEPLOYED_COMMIT
  )
  sudo mkdir "$RELEASE"
  sudo cp -a "$BUILD/." "$RELEASE/"
  sudo chown -R root:root "$RELEASE"
  sudo chmod -R u+rwX,go+rX "$RELEASE"
  sudo install -d -o lms -g lms -m 0750 "$RELEASE/.next/cache"
  sudo chown -R lms:lms "$RELEASE/.next/cache"
fi

if systemctl is-active --quiet slot-design-lms-mail.service; then
  MAIL_WAS_RUNNING=true
  sudo systemctl stop slot-design-lms-mail.service
fi
link_release "$RELEASE"
SWITCHED=true
sudo systemctl restart slot-design-lms.service
HEALTHY=false
for ((attempt=0; attempt<20; attempt++)); do
  if curl --silent --show-error --fail --max-time 3 -H "Host: $HOST" http://127.0.0.1:8787/api/v1/config 2>/dev/null | node -e 'try{if(typeof JSON.parse(require("node:fs").readFileSync(0,"utf8")).local!=="boolean")process.exit(1)}catch{process.exit(1)}'; then
    HEALTHY=true; break
  fi
  sleep 1
done
[[ $HEALTHY == true ]] || { echo 'Health check failed; automatic code rollback follows.' >&2; exit 1; }
sudo systemctl enable slot-design-lms.service
SWITCHED=false
echo "Active release: $(basename "$RELEASE")"
echo "Previous release: ${PREVIOUS:-none}"
echo "Next: verify HTTPS and sign-in at $ORIGIN. Database migrations are not reverted by this script."
