import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
// Кэш и зависимости могут находиться вне workspace; CJS-файлы сборки должны их видеть.
const modules = realpathSync(new URL('../node_modules', import.meta.url));
const child = spawn(process.execPath, [join(modules, 'next/dist/bin/next'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, NODE_PATH: modules },
});
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
