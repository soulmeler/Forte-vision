import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configure, root } from './configure.mjs';
configure();
if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
  console.error('Сначала соберите интерфейс: npm run build');
  process.exit(1);
}
const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
server.on('exit', (code) => { process.exitCode = code ?? 0; });
