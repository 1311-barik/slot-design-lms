#!/usr/bin/env bash
# Только одноразовый GitHub Actions runner; никогда не запускать на рабочем сервере.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_OS:-} == Linux ]] || { echo 'Only the disposable GitHub Linux runner is allowed.' >&2; exit 2; }
[[ ! -e /opt/slot-design-lms && ! -e /etc/slot-design-lms ]] || { echo 'Refusing to touch an existing deployment.' >&2; exit 2; }
SOURCE=$(pwd)
CHECKOUT=$(mktemp -d /var/tmp/lms-deploy-checkout.XXXXXXXX)
git clone --no-hardlinks "$SOURCE" "$CHECKOUT"
sudo useradd --system --home-dir /var/lib/slot-design-lms --shell /usr/sbin/nologin lms
sudo install -d -m 0755 /opt/slot-design-lms/releases
sudo install -d -o lms -g lms -m 0750 /var/lib/slot-design-lms
sudo install -d -m 0700 /etc/slot-design-lms
sudo ln -s "$(dirname "$(dirname "$(command -v node)")")" /opt/slot-design-node
sudo install -m 0644 docs/deployment/slot-design-lms.service.example /etc/systemd/system/slot-design-lms.service
# Все значения синтетические; только loopback-БД одноразового runner.
cat > "$CHECKOUT/test-env" <<'ENV'
LMS_MODE=local
APP_ORIGIN=http://127.0.0.1:8787
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54431/igaming_lms_test
LMS_RUNTIME_DIR=/var/lib/slot-design-lms
ENV
sudo install -m 0600 "$CHECKOUT/test-env" /etc/slot-design-lms/env
rm "$CHECKOUT/test-env"
sudo systemctl daemon-reload
trap 'sudo systemctl stop slot-design-lms.service || true' EXIT
cd "$CHECKOUT"
bash scripts/deploy.sh http://127.0.0.1:8787
GOOD=$(readlink -f /opt/slot-design-lms/current)
curl --fail --silent http://127.0.0.1:8787/api/v1/config | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{if(JSON.parse(s).local!==true)process.exit(1)})'
[[ $(curl --silent -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/v1/workspace) == 401 ]]

# Имитируем рабочую сборку с отказавшим API; прежний release должен автоматически вернуться.
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'src/app/api/v1/[...path]/route.ts';
const source = readFileSync(path, 'utf8');
if (!source.includes('const cfg = config();')) throw new Error('Fault injection seam changed');
writeFileSync(path, source.replace('const cfg = config();', 'const cfg = config(); throw new Error("synthetic deployment failure");'));
JS
git add src
git -c user.name='Deployment test' -c user.email='ci@example.test' commit -m 'Synthetic failed release (CI only)'
if bash scripts/deploy.sh http://127.0.0.1:8787 2>&1 | tee failed-deploy.log; then echo 'A broken release was accepted.' >&2; exit 1; fi
# Ошибка сборки не считается доказательством отката после переключения сервиса.
grep -q 'Health check failed; automatic code rollback follows.' failed-deploy.log
grep -q 'Activation failed; restoring the previous code release.' failed-deploy.log
[[ $(readlink -f /opt/slot-design-lms/current) == "$GOOD" ]]
for ((attempt=0; attempt<15; attempt++)); do curl --silent --fail http://127.0.0.1:8787/api/v1/config >/dev/null && break; sleep 1; done
curl --silent --fail http://127.0.0.1:8787/api/v1/config >/dev/null
[[ ! -e /opt/slot-design-lms/.deploy-lock ]]
# Ручной выбор сохранённого release тоже работает после неудачного обновления.
bash scripts/deploy.sh http://127.0.0.1:8787 --rollback "$(basename "$GOOD")"
[[ $(readlink -f /opt/slot-design-lms/current) == "$GOOD" ]]
curl --silent --fail http://127.0.0.1:8787/api/v1/config >/dev/null
echo 'Deployment, failed-release recovery and explicit rollback passed on the disposable runner.'
