import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const bundle = path.resolve(process.argv[2] || 'desktop/release/mac-arm64/Vision Forte.app');
const mac = bundle.endsWith('.app');
const resources = path.join(bundle, mac ? 'Contents/Resources' : 'resources');
const executable = path.join(bundle, mac ? 'Contents/MacOS/Vision Forte' : 'Vision Forte.exe');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-installer-smoke-'));
const apiKey = randomBytes(32).toString('hex');
const child = spawn(executable, [path.join(resources, 'app.asar/electron/runtime.cjs')], {
  cwd: data, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VISION_RESOURCES: path.join(resources, 'platform'),
    VISION_DATA_DIR: data, VISION_SESSION_KEY: apiKey },
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
});
child.stderr.resume();
try {
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Installed runtime startup timed out')); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Installed runtime exited: ${code}`)); });
    child.once('message', message => { clearTimeout(timer); resolve(message.origin); });
  });
  const health = await (await fetch(`${origin}/api/v1/health`)).json();
  assert.equal(health.service, 'vision-forte'); assert.equal(health.model.ready, false);
  const html = await (await fetch(origin)).text(); assert.match(html, /Vision Forte/);
  const login = await fetch(`${origin}/api/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const video = path.join(data, 'fixture.mp4');
  const suffix = mac ? '' : '.exe';
  execFileSync(path.join(resources, 'platform/bin/ffmpeg' + suffix), ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=gray:s=128x96:d=2', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], { windowsHide: true });
  const form = new FormData(); form.append('file', new Blob([await fs.readFile(video)], { type: 'video/mp4' }), 'fixture.mp4');
  const upload = await fetch(`${origin}/api/v1/videos`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  assert.equal(upload.status, 201, await upload.clone().text());
  const result = await upload.json();
  const stored = result.video || result;
  assert.ok(stored.duration_sec > 0, 'Bundled FFprobe must read video duration');
  const playback = await fetch(`${origin}/api/v1/videos/${stored.id}/content`, { headers: { Cookie: cookie, Range: 'bytes=0-31' } });
  assert.equal(playback.status, 206);
  const analysis = await fetch(`${origin}/api/v1/videos/${stored.id}/analyze`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(analysis.status, 503, 'An unconnected model must not produce a prediction');
  const exit = new Promise(resolve => child.once('exit', resolve)); child.send({ type: 'shutdown' });
  assert.equal(await exit, 0);
  console.log('Installed app smoke passed: bundled Electron/Node, HTTP UI, SQLite, sessions, video upload, FFmpeg, FFprobe, Range playback and graceful shutdown.');
} finally { child.kill(); await fs.rm(data, { recursive: true, force: true }); }
