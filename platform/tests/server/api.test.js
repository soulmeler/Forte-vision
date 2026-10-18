import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../../server/index.js';
import { getConfig } from '../../server/config.js';
import { validateResult } from '../../server/result-validation.js';

const key = 'test-key-012345678901234567890123456789';
const adapter = fileURLToPath(new URL('./fixtures/test-adapter.mjs', import.meta.url));
const clip = Buffer.concat([Buffer.from('000000186674797071742020000000007174202000000000', 'hex'), Buffer.alloc(100, 5)]);
const hash = createHash('sha256').update(clip).digest('hex');
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forte-api-test-'));
  if (options.mode) await fs.writeFile(path.join(dir, 'fixture-mode.json'), JSON.stringify({ mode: options.mode }));
  const config = { apiKey: key, host: '127.0.0.1', port: 0, localAutoSession: false, publicOrigin: null,
    dataDir: path.join(dir, 'data'), regulatoryPath: path.join(dir, 'regulatory.json'),
    publicDir: path.join(dir, 'dist'), modelDir: dir, modelModule: options.mode ? adapter : null,
    ffprobePath: false, modelLoadTimeoutMs: 2000, ...options };
  const runtime = await startServer(config);
  await runtime.model.initialization;
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const request = (route, opts = {}) => fetch(base + '/api/v1' + route, { ...opts, headers: { 'X-API-Key': key, ...opts.headers } });
  const form = (name = 'sample.mov', bytes = clip) => { const body = new FormData(); body.set('file', new Blob([bytes], { type: 'video/quicktime' }), name); return body; };
  const upload = async (name = 'sample.mov', bytes = clip) => { const response = await request('/videos', { method: 'POST', body: form(name, bytes) }); assert.equal(response.status, 201, await response.clone().text()); return response.json(); };
  t.after(async () => { await runtime.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { runtime, config, base, request, form, upload, dir };
}
async function waitJob(request, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await (await request('/jobs/' + id)).json();
    if (value.status !== 'processing') return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw Error('Job did not complete');
}

test('public readiness is honest; protected data require an API key', async (t) => {
  const f = await fixture(t);
  const health = await (await fetch(f.base + '/api/v1/health')).json();
  assert.equal(health.model.status, 'not_configured'); assert.equal(health.model.ready, false);
  assert.equal((await fetch(f.base + '/api/v1/videos')).status, 401);
  assert.equal((await f.request('/videos', { headers: { 'X-API-Key': 'wrong' } })).status, 401);
  const response = await f.request('/analyze', { method: 'POST', body: f.form() });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'MODEL_NOT_READY');
  assert.equal((await fs.readdir(path.join(f.config.dataDir, 'videos'))).length, 0);
});

test('session cookies are HttpOnly/Strict and never reveal the API key; foreign origins are rejected', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const response = await fetch(f.base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.base }, body: JSON.stringify({ api_key: key }) });
  assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.doesNotMatch(await response.text(), new RegExp(key));
  assert.equal((await fetch(f.base + '/api/v1/videos', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
  assert.equal((await f.request('/videos', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await f.request('/videos', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  await f.request('/session', { method: 'DELETE', headers: { Cookie: cookie.split(';')[0] } });
  assert.equal((await fetch(f.base + '/api/v1/videos', { headers: { Cookie: cookie.split(';')[0] } })).status, 401);
});

test('explicit local auto session works only for a loopback configuration', async (t) => {
  const f = await fixture(t, { localAutoSession: true });
  const response = await fetch(f.base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).local_auto_session, true);
  assert.throws(() => getConfig({ apiKey: key, localAutoSession: true, host: '0.0.0.0' }), /loopback/);
  assert.throws(() => getConfig({ apiKey: key, localAutoSession: false, host: '0.0.0.0', publicOrigin: null }), /HTTPS/);
});

test('uploads persist without annotation data and the retired endpoint is unavailable', async (t) => {
  const f = await fixture(t);
  const uploaded = await f.upload('Х-20.mov');
  assert.equal(uploaded.video.sha256, hash);
  assert.equal(Object.hasOwn(uploaded, 'annotation'), false);
  assert.equal(Object.hasOwn(uploaded.video, 'annotation_available'), false);
  const retired = await f.request(`/videos/${uploaded.video.id}/annotation`);
  assert.equal(retired.status, 404);
  const capabilities = await (await f.request('/capabilities')).json();
  assert.equal(Object.hasOwn(capabilities.features, 'dataset_annotation'), false);
  const listing = await (await f.request('/videos')).json();
  assert.deepEqual(listing.videos, [uploaded.video]);
  await f.runtime.stop();
  const restarted = await startServer(f.config); t.after(() => restarted.stop());
  const response = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/v1/videos/${uploaded.video.id}`, { headers: { 'X-API-Key': key } });
  assert.deepEqual(await response.json(), { video: uploaded.video, latest_job: null });
});

test('regulatory catalog remains public and reports unavailable or invalid sources honestly', async (t) => {
  const f = await fixture(t);
  const endpoint = f.base + '/api/v1/regulatory-sources';
  assert.deepEqual(await (await fetch(endpoint)).json(), { available: false, checkedAt: null, sources: [] });
  const catalog = { checkedAt: '2026-10-17', sources: [{ id: 'V1900019680', url: 'https://adilet.zan.kz/rus/docs/V1900019680',
    provisions: [{ id: 'C20', url: 'https://adilet.zan.kz/rus/docs/V1900019680#z111', verification: { status: 'verified', scope: 'source_provision_only', checkedAt: '2026-10-17' } }] }] };
  await fs.writeFile(f.config.regulatoryPath, JSON.stringify(catalog));
  assert.deepEqual(await (await fetch(endpoint)).json(), { ...catalog, available: true });
  assert.equal((await fetch(endpoint, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  await fs.writeFile(f.config.regulatoryPath, '{bad json');
  const unavailable = await fetch(endpoint);
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error.code, 'REGULATORY_CATALOG_UNAVAILABLE');
});

test('legacy annotation column migration preserves videos, completed jobs and foreign keys', async (t) => {
  const f = await fixture(t, { mode: 'violation' });
  const uploaded = await f.upload('Х-20.mov');
  const accepted = await (await f.request(`/videos/${uploaded.video.id}/analyze`, { method: 'POST' })).json();
  const completed = await waitJob(f.request, accepted.job_id);
  assert.equal(completed.status, 'done');
  const originalRow = { ...f.runtime.store.getVideo(uploaded.video.id) };
  await f.runtime.stop();
  // Recreate the previous schema to exercise upgrading an existing installation.
  const legacy = new DatabaseSync(path.join(f.config.dataDir, 'vision-forte.sqlite'));
  legacy.exec('ALTER TABLE videos ADD COLUMN annotation_json TEXT');
  legacy.prepare('UPDATE videos SET annotation_json=? WHERE id=?')
    .run(JSON.stringify({ description_raw: 'Historical annotation snapshot', timestamp_seconds: 1.5 }), uploaded.video.id);
  legacy.close();
  const restarted = await startServer({ ...f.config, modelModule: null }); t.after(() => restarted.stop());
  const request = (route, options = {}) => fetch(`http://127.0.0.1:${restarted.server.address().port}/api/v1${route}`, { ...options, headers: { 'X-API-Key': key } });
  assert.equal(restarted.store.db.prepare('PRAGMA table_info(videos)').all().some((column) => column.name === 'annotation_json'), false);
  assert.deepEqual({ ...restarted.store.getVideo(uploaded.video.id) }, originalRow);
  assert.deepEqual(restarted.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  const detail = await (await request(`/videos/${uploaded.video.id}`)).json();
  assert.deepEqual(detail, { video: uploaded.video, latest_job: completed });
  assert.deepEqual(Buffer.from(await (await request(`/videos/${uploaded.video.id}/content`)).arrayBuffer()), clip);
  assert.equal((await request('/videos', { method: 'POST', body: f.form('after-migration.mov') })).status, 201);
  await restarted.stop();
  const again = await startServer({ ...f.config, modelModule: null }); t.after(() => again.stop());
  assert.equal(again.store.db.prepare('SELECT COUNT(*) AS count FROM videos').get().count, 2);
  assert.equal(again.store.getJob(completed.job_id).status, 'done');
});

test('media supports byte, suffix, open-ended and HEAD ranges and blocks invalid paths', async (t) => {
  const f = await fixture(t), { video } = await f.upload();
  for (const [range, expected] of [['bytes=0-11', clip.subarray(0, 12)], ['bytes=-5', clip.subarray(-5)], ['bytes=10-', clip.subarray(10)]]) {
    const response = await f.request(`/videos/${video.id}/content`, { headers: { Range: range } });
    assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  const head = await f.request(`/videos/${video.id}/content`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(clip.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await f.request(`/videos/${video.id}/content`, { headers: { Range: 'bytes=999999-' } })).status, 416);
  assert.equal((await f.request(`/videos/${video.id}/content`, { headers: { Range: 'bytes=0-2,5-9' } })).status, 416);
  assert.equal((await f.request('/videos/%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await f.request(`/videos/${video.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await f.request(`/videos/${video.id}`)).status, 404);
  assert.equal((await fs.readdir(path.join(f.config.dataDir, 'videos'))).length, 0);
});

test('wrong extension, forged header, oversized and multi-part uploads leave no files', async (t) => {
  const f = await fixture(t, { maxUploadBytes: 200 });
  for (const [name, data, status] of [['clip.txt', clip, 415], ['fake.mov', Buffer.from('not a video'), 415], ['big.mov', Buffer.concat([clip, Buffer.alloc(100)]), 413], ['../escape.mov', clip, 400]]) {
    const response = await f.request('/videos', { method: 'POST', body: f.form(name, data) }); assert.equal(response.status, status, await response.clone().text());
  }
  for (const second of ['file', 'field']) {
    const body = f.form();
    if (second === 'file') body.append('file', new Blob([clip]), 'another.mov'); else body.append('unexpected', 'field');
    assert.equal((await f.request('/videos', { method: 'POST', body })).status, 400);
  }
  assert.equal((await fs.readdir(path.join(f.config.dataDir, 'videos'))).length, 0);
  assert.equal((await fs.readdir(path.join(f.config.dataDir, 'tmp'))).length, 0);
});

test('disconnected upload cleans up its partial file and storage reservation', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => {
    const request = http.request(f.base + '/api/v1/videos', { method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'multipart/form-data; boundary=fixture' } });
    request.on('error', resolve);
    request.write('--fixture\r\nContent-Disposition: form-data; name="file"; filename="partial.mov"\r\nContent-Type: video/quicktime\r\n\r\n');
    request.write(clip);
    setTimeout(() => { request.destroy(); resolve(); }, 30);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await fs.readdir(path.join(f.config.dataDir, 'tmp'))).length, 0);
  assert.equal((await f.upload()).video.size_bytes, clip.length);
});

test('aborting an already rejected file stream does not crash the server', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => {
    const request = http.request(f.base + '/api/v1/videos', { method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'multipart/form-data; boundary=fixture' } });
    request.on('error', resolve);
    request.write('--fixture\r\nContent-Disposition: form-data; name="file"; filename="invalid.txt"\r\n\r\n');
    request.write(Buffer.alloc(10000));
    setTimeout(() => { request.destroy(); resolve(); }, 30);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await f.request('/health')).status, 200);
  assert.equal((await fs.readdir(path.join(f.config.dataDir, 'tmp'))).length, 0);
});

test('storage exhaustion during a large stream rejects promptly and cleans up', async (t) => {
  const f = await fixture(t, { maxStorageBytes: 8, maxUploadBytes: 2000000 });
  const body = f.form('large.mov', Buffer.concat([clip, Buffer.alloc(1000000)]));
  const response = await f.request('/videos', { method: 'POST', body, signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 507);
  assert.equal((await fs.readdir(path.join(f.config.dataDir, 'tmp'))).length, 0);
});

test('the advertised maximum upload size is inclusive', async (t) => {
  const f = await fixture(t, { maxUploadBytes: clip.length });
  assert.equal((await f.upload()).video.size_bytes, clip.length);
  assert.equal((await f.request('/videos', { method: 'POST', body: f.form('over.mov', Buffer.concat([clip, Buffer.from([0])])) })).status, 413);
});

test('configured local model produces strict case-compatible jobs and evidence', async (t) => {
  const f = await fixture(t, { mode: 'violation' });
  assert.equal(f.runtime.model.state.ready, true);
  const response = await f.request('/analyze', { method: 'POST', body: f.form() });
  assert.equal(response.status, 202); const accepted = await response.json();
  const job = await waitJob(f.request, accepted.job_id);
  assert.equal(job.status, 'done'); assert.equal(job.verdict, 'violation');
  assert.equal(job.violations[0].timecode_sec, 1.5); assert.match(job.violations[0].evidence_frames[0].image_base64, /^\/9j/);
  assert.equal(job.source, 'local'); assert.equal(job.model.name, 'TEST FIXTURE — not a trained model');
});

test('action review survives validation, storage and reload without becoming a violation', async (t) => {
  const f = await fixture(t, { mode: 'review' });
  const accepted = await (await f.request('/analyze', { method: 'POST', body: f.form() })).json();
  const job = await waitJob(f.request, accepted.job_id);
  assert.equal(job.status, 'done'); assert.equal(job.verdict, 'review_required');
  assert.equal(job.review_required, true); assert.deepEqual(job.violations, []);
  assert.equal(job.observed_events[0].task, 'handover');
  assert.equal(job.observed_events[0].end_sec, 2);
  assert.match(job.observed_events[0].evidence_frames[0].image_base64, /^\/9j/);
  assert.equal(job.analysis.coverage.complete, true);
  const detail = await (await f.request('/videos/' + job.video_id)).json();
  assert.deepEqual(detail.latest_job, job);
  assert.throws(() => validateResult({ ...job, review_required: false }), /проверки/);
  assert.throws(() => validateResult({ ...job, verdict: 'no_violation' }), /заключение/);
  assert.throws(() => validateResult({ ...job, observed_events: [{ ...job.observed_events[0], end_sec: -1 }] }), /таймкод/);
});

test('queue respects worker concurrency, protects busy video and succeeds without fake percentages', async (t) => {
  const f = await fixture(t, { mode: 'slow', maxConcurrentJobs: 1 });
  const a = await f.upload(), b = await f.upload();
  const ja = await (await f.request(`/videos/${a.video.id}/analyze`, { method: 'POST' })).json();
  const jb = await (await f.request(`/videos/${b.video.id}/analyze`, { method: 'POST' })).json();
  assert.equal(ja.stage, 'analyzing'); assert.equal(jb.stage, 'queued'); assert.equal(jb.progress, undefined);
  assert.equal((await f.request(`/videos/${a.video.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await waitJob(f.request, ja.job_id)).verdict, 'no_violation');
  assert.equal((await waitJob(f.request, jb.job_id)).status, 'done');
});

for (const [mode, expected] of [['invalid', 'INVALID_MODEL_RESULT'], ['error', 'MODEL_ERROR'], ['timeout', 'JOB_TIMEOUT']]) {
  test(`model ${mode} fails honestly and leaves HTTP responsive`, async (t) => {
    const f = await fixture(t, { mode, jobTimeoutMs: mode === 'timeout' ? 150 : 2000 });
    const { video } = await f.upload();
    const accepted = await (await f.request(`/videos/${video.id}/analyze`, { method: 'POST' })).json();
    const job = await waitJob(f.request, accepted.job_id);
    assert.equal(job.status, 'failed'); assert.equal(job.error.code, expected); assert.equal(job.verdict, undefined);
    assert.doesNotMatch(JSON.stringify(job), /Private failure/); assert.equal((await f.request('/health')).status, 200);
  });
}

test('adapter load failure is distinct from service health', async (t) => {
  const f = await fixture(t, { mode: 'load-error' });
  assert.equal(f.runtime.model.state.status, 'error');
  const health = await (await f.request('/health')).json(); assert.equal(health.status, 'ok'); assert.equal(health.model.ready, false);
  assert.equal((await f.request('/analyze', { method: 'POST', body: f.form() })).status, 503);
});

test('a model that reports not-ready no longer advertises analysis availability', async (t) => {
  const f = await fixture(t, { mode: 'loses-ready' }), { video } = await f.upload();
  const first = await (await f.request(`/videos/${video.id}/analyze`, { method: 'POST' })).json();
  assert.equal((await waitJob(f.request, first.job_id)).status, 'done');
  const second = await (await f.request(`/videos/${video.id}/analyze`, { method: 'POST' })).json();
  assert.equal((await waitJob(f.request, second.job_id)).error.code, 'MODEL_NOT_READY');
  assert.equal(f.runtime.model.state.ready, false);
  assert.equal((await f.request(`/videos/${video.id}/analyze`, { method: 'POST' })).status, 503);
});

test('shutdown terminates registered inference subprocesses even when the adapter ignores abort', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t, { mode: 'owned-child' }), { video } = await f.upload();
  await f.request(`/videos/${video.id}/analyze`, { method: 'POST' });
  let pid;
  for (let i = 0; i < 40; i++) {
    try { pid = Number(await fs.readFile(path.join(f.dir, 'child.pid'), 'utf8')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.ok(pid); await f.runtime.stop();
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  assert.fail('Registered inference subprocess survived shutdown');
});

test('a busy listen port cleans up the partially initialized model worker', async (t) => {
  const f = await fixture(t, { mode: 'slow' });
  const otherDir = path.join(f.dir, 'busy-port-data');
  await assert.rejects(startServer({ ...f.config, dataDir: otherDir, port: f.runtime.server.address().port }), { code: 'EADDRINUSE' });
});

test('restart recovers interrupted job metadata as failed', async (t) => {
  const f = await fixture(t), { video } = await f.upload(), id = randomUUID(), now = new Date().toISOString();
  f.runtime.store.db.prepare("INSERT INTO jobs (id,video_id,status,stage,created_at,updated_at) VALUES (?,?,'processing','analyzing',?,?)").run(id, video.id, now, now);
  await f.runtime.stop();
  const restarted = await startServer(f.config); t.after(() => restarted.stop());
  assert.equal(restarted.store.getJob(id).status, 'failed'); assert.equal(restarted.store.getJob(id).error_code, 'SERVER_RESTARTED');
});

test('video detail recovers only its latest persisted job in done, processing and failed states', async (t) => {
  const f = await fixture(t, { mode: 'slow' }), { video } = await f.upload(), other = await f.upload();
  assert.equal((await (await f.request(`/videos/${video.id}`)).json()).latest_job, null);
  const accepted = await (await f.request(`/videos/${video.id}/analyze`, { method: 'POST' })).json();
  const processing = (await (await f.request(`/videos/${video.id}`)).json()).latest_job;
  assert.equal(processing.job_id, accepted.job_id); assert.equal(processing.video_id, video.id); assert.equal(processing.status, 'processing');
  await waitJob(f.request, accepted.job_id);
  const done = (await (await f.request(`/videos/${video.id}`)).json()).latest_job;
  assert.equal(done.status, 'done'); assert.equal(done.verdict, 'no_violation'); assert.deepEqual(done.violations, []);
  assert.equal((await (await f.request(`/videos/${other.video.id}`)).json()).latest_job, null);
  const failedId = randomUUID();
  // Same creation timestamp deliberately checks deterministic rowid tie-breaking.
  f.runtime.store.db.prepare("INSERT INTO jobs (id,video_id,status,stage,created_at,updated_at,error_code,error_message) VALUES (?,?,'failed','failed',?,?,?,?)")
    .run(failedId, video.id, done.created_at, done.updated_at, 'MODEL_ERROR', 'Сохранённая ошибка модели.');
  await f.runtime.stop();
  const restarted = await startServer({ ...f.config, modelModule: null }); t.after(() => restarted.stop());
  const response = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/v1/videos/${video.id}`, { headers: { 'X-API-Key': key } });
  const failed = (await response.json()).latest_job;
  assert.equal(failed.job_id, failedId); assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'MODEL_ERROR'); assert.equal(failed.verdict, undefined);
});

test('result validator rejects fabricated evidence, nonfinite time and unsafe links', async () => {
  const image = (await fs.readFile(new URL('./fixtures/evidence.jpg', import.meta.url))).toString('base64');
  const result = { verdict: 'violation', violations: [{ type: 'test', timecode_sec: 1, description: 'test', evidence_frames: [{ timestamp_sec: 1, image_base64: image }] }] };
  assert.equal(validateResult(result, 2).violations.length, 1);
  assert.throws(() => validateResult(result, 0.5), /таймкод/);
  assert.throws(() => validateResult({ ...result, violations: [{ ...result.violations[0], timecode_sec: NaN }] }), /таймкод/);
  assert.throws(() => validateResult({ ...result, violations: [{ ...result.violations[0], rule_refs: [{ title: 'bad', url: 'javascript:alert(1)' }] }] }), /HTTP/);
  assert.throws(() => validateResult({ ...result, violations: [{ ...result.violations[0], evidence_frames: [{ timestamp_sec: 1, image_base64: 'eHl6' }] }] }), /JPEG/);
});
