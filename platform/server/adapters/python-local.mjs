/**
 * Real local Python process adapter. This contains no trained model or synthetic
 * verdicts. MODEL_DIR/inference.py must implement the protocol in server/API.md.
 * Each prediction starts a process; use a custom persistent adapter for large
 * weights whose cold-start time would exceed the five-minute budget.
 */
import path from 'node:path';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

function invoke(python, script, args, { signal, timeoutMs = 290000, registerProcess = () => () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    const releaseProcess = child.pid ? registerProcess(child.pid) : () => {};
    let settled = false, size = 0; const chunks = [];
    function kill() {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    }
    function finish(error, value) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { kill(); reject(error); } else resolve(value);
    }
    const abort = () => finish(new Error('Local inference aborted.'));
    const timer = setTimeout(() => finish(new Error('Local inference exceeded its deadline.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) return finish(new Error('Local model output is too large.'));
      chunks.push(chunk);
    });
    // Drain diagnostics without exposing patient/customer/video details via HTTP or logs.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Could not start local Python inference.')));
    child.on('close', (code) => {
      releaseProcess();
      if (settled) return;
      if (code !== 0) return finish(new Error('Local Python inference failed.'));
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new Error('Local Python inference must output one JSON object.')); }
    });
  });
}

export async function createAdapter({ modelDir, registerProcess }) {
  const script = path.join(modelDir, 'inference.py'), python = process.env.PYTHON_BIN || 'python3';
  let ready = false;
  const adapter = {
    metadata: { name: null, version: null, supported_categories: [] },
    async load({ signal } = {}) {
      await access(script);
      const health = await invoke(python, script, ['--health', '--model-dir', modelDir], { timeoutMs: 15000, signal, registerProcess });
      if (health.ready !== true) throw new Error('Local Python model is not ready.');
      adapter.metadata = { name: health.name, version: health.version, supported_categories: health.supported_categories || [] };
      ready = true;
    },
    isReady() { return ready; },
    async predict({ videoPath, video, signal }) {
      return invoke(python, script, ['--predict', videoPath, '--model-dir', modelDir, '--metadata-json', JSON.stringify(video), '--visual-only'], { signal, registerProcess });
    },
  };
  return adapter;
}
