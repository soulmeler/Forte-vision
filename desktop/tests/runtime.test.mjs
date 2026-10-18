import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('installed runtime starts on a free port, authenticates locally, keeps credentials out of responses, and shuts down', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-installed-test-'));
  const secret = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [path.join(desktop, 'electron/runtime.cjs')], {
    cwd: data, env: { ...process.env, VISION_RESOURCES: path.resolve(desktop, '../platform'),
      VISION_DATA_DIR: data, VISION_SESSION_KEY: secret, MODEL_ADAPTER_MODULE: '/untrusted/adapter.js' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('startup timed out')), 15000);
      child.once('exit', code => { clearTimeout(timer); reject(Error(`runtime exited: ${code}`)); });
      child.once('message', message => { clearTimeout(timer); resolve(message.origin); });
    });
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await fetch(`${origin}/api/v1/health`);
    const content = await health.text();
    assert.equal(health.status, 200); assert.ok(!content.includes(secret));
    assert.equal(JSON.parse(content).model.ready, false);
    assert.equal((await fetch(`${origin}/api/v1/videos`)).status, 401);
    const login = await fetch(`${origin}/api/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const videos = await fetch(`${origin}/api/v1/videos`, { headers: { Cookie: cookie } });
    assert.equal(videos.status, 200);
    assert.equal((await fs.readdir(data)).some(name => name.startsWith('.env')), false);
    const exit = new Promise(resolve => child.once('exit', resolve));
    child.send({ type: 'shutdown' });
    assert.equal(await exit, 0);
  } finally { child.kill(); await fs.rm(data, { recursive: true, force: true }); }
});
