import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startServer } from '../../server/index.js';

const platformKey = 'platform-test-key-012345678901234567890';
const modelKey = 'remote-model-key-0123456789';
const clip = Buffer.concat([Buffer.from('000000186674797071742020000000007174202000000000', 'hex'), Buffer.alloc(100, 5)]);
async function fixture(t, config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forte-remote-test-'));
  const runtime = await startServer({ apiKey: platformKey, host: '127.0.0.1', port: 0, localAutoSession: false, publicOrigin: null,
    modelModule: null, dataDir: path.join(dir, 'data'), regulatoryPath: path.join(dir, 'regulatory.json'),
    publicDir: path.join(dir, 'dist'), ffprobePath: false,
    remotePollIntervalMs: 10, remoteRequestTimeoutMs: 100, remoteHealthIntervalMs: 20000, ...config });
  const base = `http://127.0.0.1:${runtime.server.address().port}/api/v1`;
  const request = (route, options = {}) => fetch(base + route, { ...options, headers: { 'X-API-Key': platformKey, ...options.headers } });
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const connect = (base_url, api_key = modelKey) => request('/model/connection', json('PUT', { base_url, api_key }));
  const upload = async () => {
    const body = new FormData(); body.set('file', new Blob([clip], { type: 'video/quicktime' }), 'private-label.mov');
    const response = await request('/videos', { method: 'POST', body }); assert.equal(response.status, 201);
    return (await response.json()).video;
  };
  t.after(async () => { await runtime.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { runtime, dir, base, request, connect, upload, json };
}
async function remote(t, options = {}) {
  const calls = [], state = { ready: true, polls: 0, healthMode: 'ok', jobMode: 'done', ...options };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, key: req.headers['x-api-key'], body: Buffer.concat(chunks) });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers['x-api-key'] !== modelKey) return send({ error: { message: 'Do not expose ' + req.headers['x-api-key'] } }, 401);
    if (req.url === '/api/v1/health') {
      if (state.healthMode === 'timeout') return;
      if (state.healthMode === 'redirect') { res.writeHead(302, { Location: state.redirect }); return res.end(); }
      if (state.healthMode === 'bad') return send({ arbitrary: 'not a model server' });
      if (state.healthMode === 'denied') return send({ error: modelKey }, 403);
      return send({ status: 'ok', model: { ready: state.ready, status: state.ready ? 'ready' : 'loading', name: 'Fixture on GPU server', version: 'test' } });
    }
    if (req.url === '/api/v1/analyze') {
      if (state.jobMode === 'auth') return send({ error: modelKey }, 401);
      return send({ job_id: 'remote-job', status: 'processing', stage: 'queued' }, 202);
    }
    if (req.url === '/api/v1/jobs/remote-job') {
      state.polls++;
      if (state.jobMode === 'wait' || state.polls === 1) return send({ job_id: 'remote-job', status: 'processing' });
      if (state.jobMode === 'failed') return send({ job_id: 'remote-job', status: 'failed', error: { message: modelKey } });
      if (state.jobMode === 'invalid') return send({ job_id: 'remote-job', status: 'done', verdict: 'violation', violations: [] });
      return send({ job_id: 'remote-job', status: 'done', verdict: 'no_violation', violations: [] });
    }
    send({}, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/api/v1`, calls, state, server };
}
async function waitJob(f, id) {
  for (let i = 0; i < 100; i++) {
    const job = await (await f.request('/jobs/' + id)).json();
    if (job.status !== 'processing') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('job did not finish');
}

test('team raw-video endpoint uses Bearer, origin health and raw bytes with a synchronous result', async (t) => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${modelKey}`) { res.statusCode = 401; return res.end(JSON.stringify({ detail: modelKey })); }
    if (req.url === '/health') return res.end(JSON.stringify({ ready: true, base_model: 'D:/models/Qwen3-VL-4B-Instruct', adapter: 'checkpoint-96' }));
    if (req.url !== '/v1/analyze-video') { res.statusCode = 404; return res.end('{}'); }
    return res.end(JSON.stringify({ result: { status: 'ok', duration_seconds: 2, prediction: { violation: false, insufficient_data: false, events: [] },
      window_status_counts: { ok: 1, invalid: 0, error: 0 }, windows: [{ status: 'ok', start_seconds: 0, end_seconds: 2 }] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const f = await fixture(t), url = `http://127.0.0.1:${server.address().port}/v1/analyze-video`;
  const connected = await (await f.connect(url)).json();
  assert.equal(connected.model.name, 'Qwen3-VL-4B-Instruct'); assert.equal(connected.model.version, 'checkpoint-96');
  assert.equal(connected.connection.authentication, 'bearer'); assert.equal(connected.model.ready, true);
  const video = await f.upload();
  const accepted = await (await f.request(`/videos/${video.id}/analyze`, { method: 'POST' })).json();
  const job = await waitJob(f, accepted.job_id);
  assert.equal(job.status, 'done'); assert.equal(job.verdict, 'no_violation'); assert.equal(job.source, 'server');
  const upload = calls.find(c => c.path === '/v1/analyze-video');
  assert.deepEqual(upload.body, clip); assert.equal(upload.headers['content-type'], 'video/quicktime');
  assert.equal(upload.headers['ngrok-skip-browser-warning'], '1'); assert.equal(upload.headers['x-api-key'], undefined);
  assert.doesNotMatch(JSON.stringify(job), new RegExp(modelKey));
  const rejected = await f.connect(url, 'wrong'); assert.equal((await rejected.json()).error.code, 'REMOTE_AUTH_FAILED');
  assert.equal((await (await f.request('/model/connection')).json()).model.ready, true);
});

test('remote connection is authenticated, stays in memory, and never returns its key', async (t) => {
  const f = await fixture(t), r = await remote(t);
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await fetch(f.base + '/model/connection', { method })).status, 401);
  assert.equal((await fetch(f.base + '/model/connection/check', { method: 'POST' })).status, 401);
  assert.equal((await f.connect(r.url + '/')).status, 200);
  const response = await (await f.request('/model/connection')).json();
  assert.equal(response.connection.base_url, r.url); assert.equal(response.connection.key_present, true);
  assert.equal(response.connection.persistence, 'memory'); assert.equal(response.model.transport, 'remote_api');
  assert.equal(response.model.ready, true); assert.doesNotMatch(JSON.stringify(response), new RegExp(modelKey));
  assert.equal(r.calls[0].key, modelKey);
  const health = await (await f.request('/health')).json(); assert.equal(health.model.name, 'Fixture on GPU server');
  assert.doesNotMatch(JSON.stringify(health), new RegExp(modelKey));
  const dataFiles = await fs.readdir(path.join(f.dir, 'data'));
  for (const name of dataFiles.filter((name) => name.startsWith('vision-forte.sqlite'))) {
    assert.equal((await fs.readFile(path.join(f.dir, 'data', name))).includes(Buffer.from(modelKey)), false);
  }
  const disconnected = await (await f.request('/model/connection', { method: 'DELETE' })).json();
  assert.equal(disconnected.connection.configured, false); assert.equal(disconnected.model.ready, false);
  assert.equal((await f.request('/model/connection/check', { method: 'POST' })).status, 409);
});

test('remote async analysis sends only video and produces a validated server result', async (t) => {
  const f = await fixture(t), r = await remote(t);
  await f.connect(r.url); const video = await f.upload();
  const accepted = await (await f.request(`/videos/${video.id}/analyze`, { method: 'POST' })).json();
  const job = await waitJob(f, accepted.job_id);
  assert.equal(job.status, 'done'); assert.equal(job.verdict, 'no_violation'); assert.equal(job.source, 'server');
  assert.equal(job.model.transport, 'remote_api'); assert.ok(r.state.polls >= 2);
  const upload = r.calls.find((call) => call.url.endsWith('/analyze'));
  assert.ok(upload.body.includes(clip)); assert.equal(upload.key, modelKey);
  assert.match(upload.body.toString(), /name="file"; filename="video.mov"/);
  assert.doesNotMatch(upload.body.toString(), /private-label|annotation|description/);
  assert.ok(r.calls.every((call) => call.key === modelKey));
});

test('connection validation and failed replacement preserve the working server', async (t) => {
  const f = await fixture(t), r = await remote(t);
  await f.connect(r.url);
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.test/api/v1', r.url + '?api_key=test', r.url + '#test', f.base]) {
    const response = await f.connect(url); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_MODEL_URL');
  }
  assert.equal((await f.connect(r.url, 'bad\nheader')).status, 400);
  const rejected = await f.connect(r.url, 'wrong-key');
  assert.equal(rejected.status, 502); assert.equal((await rejected.json()).error.code, 'REMOTE_AUTH_FAILED');
  const old = await (await f.request('/model/connection')).json(); assert.equal(old.model.ready, true); assert.equal(old.connection.base_url, r.url);
  r.state.healthMode = 'bad'; assert.equal((await (await f.connect(r.url)).json()).error.code, 'INVALID_REMOTE_RESPONSE');
});

test('redirects never forward the model key to another endpoint', async (t) => {
  const f = await fixture(t), target = await remote(t), r = await remote(t, { healthMode: 'redirect', redirect: target.url + '/health' });
  const response = await f.connect(r.url); assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'REMOTE_REDIRECT_REJECTED'); assert.equal(target.calls.length, 0);
});

test('overlapping connection mutations are locked and unreachable hosts fail safely', async (t) => {
  const f = await fixture(t), r = await remote(t, { healthMode: 'timeout' });
  const pending = f.connect(r.url);
  for (let i = 0; i < 20 && !r.calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(r.calls.length);
  for (const response of [await f.connect(r.url), await f.request('/model/connection', { method: 'DELETE' }), await f.request('/model/connection/check', { method: 'POST' })]) {
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'CONNECTION_BUSY');
  }
  assert.equal((await pending).status, 504);
  r.server.closeAllConnections(); await new Promise((resolve) => r.server.close(resolve));
  const unavailable = await f.connect(r.url); assert.equal(unavailable.status, 502);
  assert.equal((await unavailable.json()).error.code, 'REMOTE_UNAVAILABLE');
  assert.equal((await (await f.request('/model/connection')).json()).connection.configured, false);
});

test('remote timeout and background health refresh expose unavailable readiness honestly', async (t) => {
  const f = await fixture(t, { remoteHealthIntervalMs: 25 }), r = await remote(t, { ready: false });
  const initial = await (await f.connect(r.url)).json(); assert.equal(initial.connection.configured, true); assert.equal(initial.model.ready, false);
  r.state.ready = true;
  for (let i = 0; i < 20 && !f.runtime.model.state.ready; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.runtime.model.state.ready, true);
  r.state.healthMode = 'timeout';
  const failed = await (await f.request('/model/connection/check', { method: 'POST' })).json();
  assert.equal(failed.model.ready, false); assert.equal(failed.connection.error.code, 'REMOTE_TIMEOUT');
});

test('active jobs block connection changes and job timeout terminates polling', async (t) => {
  const f = await fixture(t, { jobTimeoutMs: 180 }), r = await remote(t, { jobMode: 'wait' });
  await f.connect(r.url); const video = await f.upload();
  const accepted = await (await f.request(`/videos/${video.id}/analyze`, { method: 'POST' })).json();
  for (const response of [await f.connect(r.url), await f.request('/model/connection', { method: 'DELETE' })]) {
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'MODEL_BUSY');
  }
  const job = await waitJob(f, accepted.job_id); assert.equal(job.error.code, 'JOB_TIMEOUT');
  await new Promise((resolve) => setTimeout(resolve, 30)); const calls = r.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(r.calls.length, calls);
  assert.equal((await f.request('/model/connection', { method: 'DELETE' })).status, 200);
});

for (const [jobMode, code] of [['failed', 'REMOTE_JOB_FAILED'], ['invalid', 'INVALID_MODEL_RESULT'], ['auth', 'REMOTE_AUTH_FAILED']]) {
  test(`remote ${jobMode} result is a sanitized failure, never a verdict`, async (t) => {
    const f = await fixture(t), r = await remote(t, { jobMode }); await f.connect(r.url); const video = await f.upload();
    const accepted = await (await f.request(`/videos/${video.id}/analyze`, { method: 'POST' })).json();
    const job = await waitJob(f, accepted.job_id);
    assert.equal(job.status, 'failed'); assert.equal(job.error.code, code); assert.equal(job.verdict, undefined);
    assert.doesNotMatch(JSON.stringify(job), new RegExp(modelKey));
  });
}
