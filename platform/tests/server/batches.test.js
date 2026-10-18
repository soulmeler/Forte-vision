import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../server/index.js';

const key = 'batch-test-key-012345678901234567890';
const adapter = fileURLToPath(new URL('./fixtures/test-adapter.mjs', import.meta.url));
const clip = Buffer.concat([Buffer.from('000000186674797071742020000000007174202000000000', 'hex'), Buffer.alloc(100, 5)]);

// Minimal ZIP writer permits adversarial headers ordinary ZIP tools refuse to
// create. Runtime ZIP parsing still uses yauzl, independently of this fixture.
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const value of entries) {
    const name = Buffer.from(value.name), bytes = value.bytes || clip;
    const method = value.deflate ? 8 : 0, packed = method ? deflateRawSync(bytes) : bytes;
    const checksum = value.badCrc ? 123 : crc32(bytes), flags = 0x800 | (value.encrypted ? 1 : 0);
    const size = value.declaredSize ?? bytes.length;
    const a = Buffer.alloc(30); a.writeUInt32LE(0x04034b50); a.writeUInt16LE(20, 4); a.writeUInt16LE(flags, 6); a.writeUInt16LE(method, 8);
    a.writeUInt32LE(checksum, 14); a.writeUInt32LE(packed.length, 18); a.writeUInt32LE(size, 22); a.writeUInt16LE(name.length, 26);
    const b = Buffer.alloc(46); b.writeUInt32LE(0x02014b50); b.writeUInt16LE(0x314, 4); b.writeUInt16LE(20, 6); b.writeUInt16LE(flags, 8); b.writeUInt16LE(method, 10);
    b.writeUInt32LE(checksum, 16); b.writeUInt32LE(packed.length, 20); b.writeUInt32LE(size, 24); b.writeUInt16LE(name.length, 28);
    b.writeUInt32LE(((value.mode || 0o100600) << 16) >>> 0, 38); b.writeUInt32LE(offset, 42);
    local.push(a, name, packed); central.push(b, name); offset += a.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forte-batch-test-'));
  if (options.mode) await fs.writeFile(path.join(dir, 'fixture-mode.json'), JSON.stringify({ mode: options.mode }));
  const config = { apiKey: key, host: '127.0.0.1', port: 0, localAutoSession: false, publicOrigin: null,
    dataDir: path.join(dir, 'data'), publicDir: path.join(dir, 'dist'), regulatoryPath: path.join(dir, 'rules.json'),
    ffprobePath: false, modelModule: options.mode ? adapter : null, modelDir: dir, batchPollIntervalMs: 10,
    modelLoadTimeoutMs: 2000, maxPendingJobs: 1, ...options };
  let runtime; const instances = [];
  const launch = async () => { runtime = await startServer(config); instances.push(runtime); await runtime.model.initialization; return runtime; };
  await launch();
  const url = route => `http://127.0.0.1:${runtime.server.address().port}/api/v1${route}`;
  const request = (route, init = {}) => fetch(url(route), { ...init, headers: { 'X-API-Key': key, ...init.headers } });
  const upload = (bytes, name = 'операции.zip') => {
    const body = new FormData(); body.append('file', new Blob([bytes], { type: 'application/zip' }), name);
    return request('/batches', { method: 'POST', body });
  };
  const importBatch = async entries => {
    const response = await upload(zip(entries)); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).batch;
  };
  const start = (id, options = {}) => request(`/batches/${id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) });
  const get = async id => (await (await request('/batches/' + id)).json()).batch;
  const until = async (id, predicate) => {
    for (let i = 0; i < 200; i++) { const batch = await get(id); if (predicate(batch)) return batch; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw Error('Batch did not reach expected state');
  };
  t.after(async () => { for (const instance of instances) await instance.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, config, get runtime() { return runtime; }, launch, request, url, upload, importBatch, start, get, until };
}

test('ZIP import is authenticated, accepts nested names, skips metadata, and records per-file failures without starting analysis', async t => {
  const f = await fixture(t);
  for (const [route, method] of [['/batches', 'GET'], ['/batches', 'POST'], ['/batches/unknown', 'GET'], ['/batches/unknown/analyze', 'POST'], ['/batches/unknown/report.xlsx', 'GET']]) {
    assert.equal((await fetch(f.url(route), { method })).status, 401);
  }
  const batch = await f.importBatch([{ name: 'смена/Х-1.mov' }, { name: 'смена2/Х-1.mov', deflate: true },
    { name: '__MACOSX/._Х-1.mov', bytes: Buffer.from('metadata') }, { name: '.DS_Store', bytes: Buffer.from('metadata') },
    { name: 'instructions.txt', bytes: Buffer.from('not a video') }, { name: 'broken.mp4', bytes: Buffer.from('invalid video') }]);
  assert.equal(batch.original_name, 'операции.zip'); assert.equal(batch.status, 'ready');
  assert.deepEqual(batch.counts, { total: 4, queued: 2, processing: 0, done: 0, failed: 2 });
  assert.equal(batch.items[0].original_name, 'смена/Х-1.mov'); assert.notEqual(batch.items[0].video_id, batch.items[1].video_id);
  assert.equal(batch.items[2].error.code, 'UNSUPPORTED_FORMAT'); assert.equal(batch.items[3].error.code, 'INVALID_CONTAINER');
  assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
  assert.equal((await f.start(batch.id)).status, 503);
  const list = (await (await f.request('/batches')).json()).batches;
  assert.equal(list[0].items, undefined); assert.deepEqual(list[0].counts, batch.counts);
  const capability = await (await f.request('/capabilities')).json();
  assert.equal(capability.features.batch_export, true); assert.equal(capability.archive.max_files, f.config.maxArchiveFiles || 100);
  assert.deepEqual(await fs.readdir(f.runtime.store.tempDir), []);
});

test('ZIP traversal, absolute paths, backslashes, symlinks and encryption reject whole import without extracting siblings', async t => {
  const f = await fixture(t);
  const cases = [{ name: '../escape.mov' }, { name: '/tmp/escape.mov' }, { name: 'C:/escape.mov' },
    { name: 'folder\\escape.mov' }, { name: 'link.mov', mode: 0o120777 }, { name: 'secret.mov', encrypted: true }];
  for (const value of cases) {
    const response = await f.upload(zip([{ name: 'good.mov' }, value])); assert.ok(response.status >= 400, value.name);
    assert.ok(['UNSAFE_ARCHIVE', 'INVALID_ARCHIVE'].includes((await response.json()).error.code));
    assert.equal(f.runtime.store.sizeUsed(), 0); assert.deepEqual(await fs.readdir(f.runtime.store.tempDir), []);
    assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'videos')), []);
  }
  assert.equal((await (await f.request('/batches')).json()).batches.length, 0);
});

test('ZIP limits enforce actual compressed bytes, total expanded size, entry count, and false declared sizes', async t => {
  const f = await fixture(t, { maxArchiveBytes: 600, maxArchiveExpandedBytes: 300, maxArchiveFiles: 2 });
  for (const [bytes, code] of [
    [zip([{ name: 'big.mov', bytes: Buffer.alloc(800) }]), 'ARCHIVE_TOO_LARGE'],
    [zip([{ name: 'bomb.mov', bytes: Buffer.alloc(301), deflate: true }]), 'ARCHIVE_EXPANDED_LIMIT'],
    [zip([{ name: '1.mov', deflate: true }, { name: '2.mov', deflate: true }, { name: '3.mov', deflate: true }]), 'ARCHIVE_EXPANDED_LIMIT'],
    [zip([{ name: '1.mov', bytes: Buffer.alloc(1) }, { name: '2.mov', bytes: Buffer.alloc(1) }, { name: '3.mov', bytes: Buffer.alloc(1) }]), 'ARCHIVE_FILE_LIMIT'],
    [zip([{ name: 'lying.mov', bytes: Buffer.alloc(250), deflate: true, declaredSize: 30 }]), 'INVALID_ARCHIVE'],
  ]) {
    const response = await f.upload(bytes); assert.ok(response.status >= 400); assert.equal((await response.json()).error.code, code);
    assert.equal(f.runtime.store.sizeUsed(), 0); assert.deepEqual(await fs.readdir(f.runtime.store.tempDir), []);
  }
});

test('ZIP CRC corruption rolls back already imported siblings; invalid and empty archives leave no files', async t => {
  const f = await fixture(t);
  for (const bytes of [zip([{ name: 'good.mov' }, { name: 'bad.mov', badCrc: true }]), Buffer.from('not zip'), zip([])]) {
    assert.ok((await f.upload(bytes)).status >= 400);
    assert.equal(f.runtime.store.sizeUsed(), 0); assert.deepEqual(await fs.readdir(f.runtime.store.tempDir), []);
    assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'videos')), []);
  }
});

test('ZIP storage quota includes its compressed staging file and releases quota after failure', async t => {
  const bytes = zip([{ name: 'a.mov' }]);
  const f = await fixture(t, { maxStorageBytes: bytes.length + clip.length - 1 });
  const response = await f.upload(bytes); assert.equal(response.status, 507); assert.equal((await response.json()).error.code, 'STORAGE_LIMIT');
  assert.equal(f.runtime.store.sizeUsed(), 0); assert.deepEqual(await fs.readdir(f.runtime.store.tempDir), []);
  const smaller = await f.upload(zip([{ name: 'tiny.mp4', bytes: Buffer.from('invalid') }]));
  assert.equal(smaller.status, 201, await smaller.clone().text());
});

test('durable batch queue processes more videos than model pending limit, does not duplicate start, and exports results', async t => {
  const f = await fixture(t, { mode: 'slow', maxPendingJobs: 1 });
  const batch = await f.importBatch(Array.from({ length: 5 }, (_, i) => ({ name: `video-${i}.mov` })));
  assert.equal((await f.start(batch.id)).status, 202); assert.equal((await f.start(batch.id)).status, 202);
  assert.equal((await f.request('/videos/' + batch.items[4].video_id, { method: 'DELETE' })).status, 409);
  const done = await f.until(batch.id, value => value.status === 'done');
  assert.deepEqual(done.counts, { total: 5, queued: 0, processing: 0, done: 5, failed: 0 });
  assert.ok(done.items.every(item => item.job.verdict === 'no_violation'));
  assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 5);
  assert.equal((await f.start(batch.id)).status, 202); assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 5);
  const response = await f.request(`/batches/${batch.id}/report.xlsx`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /spreadsheetml/);
  assert.equal(Buffer.from(await response.arrayBuffer()).readUInt16LE(), 0x4b50);
  const first = done.items[0]; assert.equal((await f.request('/videos/' + first.video_id, { method: 'DELETE' })).status, 204);
  const after = await f.get(batch.id); assert.equal(after.items[0].video_id, null); assert.equal(after.items[0].job.verdict, 'no_violation');
});

test('batch results preserve event feedback without image payloads', async t => {
  const f = await fixture(t, { mode: 'violation' });
  const batch = await f.importBatch([{ name: 'case.mov' }]); await f.start(batch.id);
  const done = await f.until(batch.id, value => value.status === 'done');
  assert.equal(done.items[0].job.verdict, 'violation'); assert.equal(done.items[0].job.violations[0].timecode_sec, 1.5);
  assert.match(done.items[0].job.violations[0].description, /Synthetic/); assert.equal(done.items[0].job.violations[0].rule_refs.length, 1);
  assert.doesNotMatch(JSON.stringify(done), /image_base64|evidence_frames/);
});

test('restart pauses queued work, preserves links, and explicit retry does not redo completed results', async t => {
  const f = await fixture(t, { mode: 'timeout' });
  const batch = await f.importBatch([{ name: '1.mov' }, { name: '2.mov' }, { name: '3.mov' }]); await f.start(batch.id);
  await f.until(batch.id, value => value.counts.processing === 1);
  await f.runtime.stop(); await fs.writeFile(path.join(f.dir, 'fixture-mode.json'), JSON.stringify({ mode: 'slow' }));
  await f.launch();
  const recovered = await f.get(batch.id); assert.equal(recovered.status, 'paused'); assert.equal(recovered.counts.failed, 1); assert.equal(recovered.counts.queued, 2);
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);
  await f.start(batch.id, { retry_failed: true });
  const done = await f.until(batch.id, value => value.status === 'done'); assert.equal(done.counts.done, 3);
  assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 4);
  await f.start(batch.id, { retry_failed: true }); assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 4);
});

test('staged archive media is hidden and cleaned after interrupted import restart', async t => {
  const f = await fixture(t); const id = randomUUID();
  f.runtime.store.db.prepare('INSERT INTO videos(id,original_name,size_bytes,mime_type,sha256,created_at) VALUES (?,?,?,?,?,?)').run(id, 'staged.mov', clip.length, 'video/quicktime', 'fixture', new Date().toISOString());
  f.runtime.store.db.prepare('INSERT INTO archive_pending_videos(video_id) VALUES (?)').run(id);
  await fs.writeFile(f.runtime.store.videoPath(id), clip);
  assert.equal((await (await f.request('/videos')).json()).total, 0);
  for (const method of ['GET', 'DELETE']) assert.equal((await f.request('/videos/' + id, { method })).status, 404);
  assert.equal((await f.request(`/videos/${id}/analyze`, { method: 'POST' })).status, 404);
  await f.runtime.stop(); await f.launch();
  assert.equal(f.runtime.store.sizeUsed(), 0); assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'videos')), []);
});

test('ready and paused batch videos can be removed; expired idle archives do not lock storage forever', async t => {
  const f = await fixture(t);
  const batch = await f.importBatch([{ name: 'ready.mov' }, { name: 'expired.mov' }]);
  assert.equal((await f.request('/videos/' + batch.items[0].video_id, { method: 'DELETE' })).status, 204);
  const after = await f.get(batch.id);
  assert.equal(after.items[0].status, 'failed'); assert.equal(after.items[0].error.code, 'VIDEO_DELETED'); assert.equal(after.items[0].video_id, null);
  f.runtime.store.db.prepare("UPDATE batches SET status='paused' WHERE id=?").run(batch.id);
  f.runtime.store.db.prepare('UPDATE videos SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', batch.items[1].video_id);
  f.runtime.store.cleanup();
  const expired = await f.get(batch.id); assert.equal(expired.status, 'done'); assert.equal(expired.counts.failed, 2);
  assert.equal(expired.items[1].video_id, null); assert.equal(f.runtime.store.sizeUsed(), 0);
});

test('disconnected ZIP uploads release staging files and byte reservations', async t => {
  const bytes = zip([{ name: 'valid.mov' }]);
  const f = await fixture(t, { maxStorageBytes: bytes.length + clip.length + 30 });
  const request = http.request(f.url('/batches'), { method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'multipart/form-data; boundary=fixture' } });
  request.on('error', () => {});
  request.write('--fixture\r\nContent-Disposition: form-data; name="file"; filename="interrupted.zip"\r\n\r\n'); request.write(bytes.subarray(0, 100));
  for (let i = 0; i < 50 && !(await fs.readdir(f.runtime.store.tempDir)).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  request.destroy();
  for (let i = 0; i < 50 && (await fs.readdir(f.runtime.store.tempDir)).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await fs.readdir(f.runtime.store.tempDir), []);
  const response = await f.upload(bytes); assert.equal(response.status, 201, await response.clone().text());
});

test('shutdown aborts incomplete ZIP bodies before closing the store', async t => {
  const f = await fixture(t);
  const request = http.request(f.url('/batches'), { method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'multipart/form-data; boundary=fixture' } });
  request.on('error', () => {}); request.on('response', response => response.resume());
  request.write('--fixture\r\nContent-Disposition: form-data; name="file"; filename="interrupted.zip"\r\n\r\n'); request.write(Buffer.alloc(100));
  for (let i = 0; i < 50 && !(await fs.readdir(f.runtime.store.tempDir)).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const began = Date.now(); await f.runtime.close(); request.destroy();
  assert.ok(Date.now() - began < 1000); assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'tmp')), []);
});

test('shutdown also aborts ZIP multipart before its first file header arrives', async t => {
  const f = await fixture(t);
  const received = new Promise(resolve => f.runtime.server.once('request', resolve));
  const request = http.request(f.url('/batches'), { method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'multipart/form-data; boundary=fixture' } });
  request.on('error', () => {}); request.on('response', response => response.resume()); request.write('--fixture\r\n');
  await received;
  const began = Date.now(); await f.runtime.close(); request.destroy();
  assert.ok(Date.now() - began < 1000); assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'tmp')), []);
});
