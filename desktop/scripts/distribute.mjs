import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [target = 'mac', arch = 'arm64', mode] = process.argv.slice(2);
if (!['mac', 'win'].includes(target) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported target');
const run = (args) => {
  const result = spawnSync(process.execPath, args, { cwd: desktop, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
};
run(['scripts/prepare-runtime.mjs', target === 'mac' ? 'darwin' : 'win32', arch]);
run(['node_modules/electron-builder/cli.js', `--${target}`, ...(mode === '--dir' ? ['--dir'] : [target === 'mac' ? 'dmg' : 'nsis']), `--${arch}`, '--publish', 'never']);
