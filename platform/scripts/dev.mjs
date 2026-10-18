import { spawn } from 'node:child_process';
import { configure, root } from './configure.mjs';
configure();
const api = spawn(process.execPath, ['--watch', 'server/index.js'], { cwd: root, env: process.env, stdio: 'inherit' });
const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: root, env: process.env, stdio: 'inherit' });
const children = [api, ui];
let closing = false;
function close(signal = 'SIGTERM') {
  if (closing) return;
  closing = true;
  children.forEach((child) => child.kill(signal));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close(signal));
children.forEach((child) => {
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; close(); });
  child.on('exit', (code) => { if (!closing) { process.exitCode = code ?? 1; close(); } });
});
