import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.dirname(desktop);
const [targetOS = process.platform, arch = process.arch] = process.argv.slice(2);
const versions = {
  'darwin-arm64': ['4.1.5', '5.0.1'],
  'darwin-x64': ['4.1.0', '5.1.0'],
  'win32-x64': ['4.1.0', '5.1.0'],
};
if (!versions[`${targetOS}-${arch}`]) throw new Error('Supported targets: darwin-arm64, darwin-x64, win32-x64');
const destination = path.join(desktop, 'runtime/platform');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, { cwd, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8',
    shell: process.platform === 'win32' && command.endsWith('.cmd') });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout;
}
run(npm, ['run', 'build'], project);
// This generated directory contains only the installed app's runtime, never the
// developer's data, environment files, credentials, datasets, or model weights.
await fs.rm(path.dirname(destination), { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });
for (const name of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(desktop, 'runtime-deps', name), path.join(destination, name));
run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], destination);
for (const folder of ['server', 'dist']) {
  await fs.cp(path.join(project, 'platform', folder), path.join(destination, folder), { recursive: true,
    filter: (source) => !source.endsWith('.env') && !source.endsWith('.log') });
}
await fs.mkdir(path.join(destination, 'data'), { recursive: true });
await fs.copyFile(path.join(project, 'platform/data/regulatory-sources.json'), path.join(destination, 'data/regulatory-sources.json'));
const bin = path.join(destination, 'bin');
await fs.mkdir(bin, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-forte-binaries-'));
try {
  for (const [index, name] of ['ffmpeg', 'ffprobe'].entries()) {
    const spec = `@${name}-installer/${targetOS}-${arch}@${versions[`${targetOS}-${arch}`][index]}`;
    const metadata = JSON.parse(run(npm, ['pack', spec, '--json', '--pack-destination', temp], desktop, true))[0];
    const unpack = path.join(temp, name); await fs.mkdir(unpack);
    run('tar', ['-xzf', path.join(temp, metadata.filename), '-C', unpack], desktop);
    const executable = name + (targetOS === 'win32' ? '.exe' : '');
    await fs.copyFile(path.join(unpack, 'package', executable), path.join(bin, executable));
    await fs.chmod(path.join(bin, executable), 0o755);
    // Preserve the binary distributor's notices alongside every shipped binary.
    await fs.cp(path.join(unpack, 'package'), path.join(destination, 'third-party', name), {
      recursive: true, filter: (source) => path.basename(source) !== executable,
    });
  }
} finally { await fs.rm(temp, { recursive: true, force: true }); }
await fs.writeFile(path.join(destination, 'target.json'), JSON.stringify({ platform: targetOS, arch }) + '\n');
console.log(`Prepared standalone platform for ${targetOS}/${arch}.`);
