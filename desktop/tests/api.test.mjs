import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { analyzeVideo, normalizeResult, validateBaseUrl } from '../ui/api.js';

const event = { type: 'Событие', description: 'Наблюдаемое действие', timecode_sec: 4, evidence_frames: [{ timestamp_sec: 4, image_base64: '/9j/2Q==' }] };
test('accepts the official clean verdict and rejects contradictory results', () => {
  assert.equal(normalizeResult({ status: 'done', verdict: 'no_violation', violations: [] }).violations.length, 0);
  assert.throws(() => normalizeResult({ status: 'done', verdict: 'no_violation', violations: [event] }));
  assert.throws(() => normalizeResult({ status: 'done', verdict: 'violation', violations: [] }));
});
test('validates evidence and timecodes and orders events', () => {
  const data = normalizeResult({ status: 'done', verdict: 'violation', violations: [{ ...event, timecode_sec: 9 }, event] });
  assert.deepEqual(data.violations.map(e => e.timecode_sec), [4, 9]);
  assert.throws(() => normalizeResult({ status: 'done', verdict: 'violation', violations: [{ ...event, timecode_sec: -1 }] }));
  assert.throws(() => normalizeResult({ status: 'done', verdict: 'violation', violations: [{ ...event, evidence_frames: [] }] }));
});
test('keeps visual actions separate from violations and requires review', () => {
  const input={status:'done',verdict:'review_required',review_required:true,violations:[],observed_events:[event],analysis:{coverage:{complete:false}}};
  const result=normalizeResult(input);
  assert.equal(result.verdict,'review_required');
  assert.equal(result.violations.length,0);
  assert.equal(result.observed_events.length,1);
  assert.equal(result.analysis.coverage.complete,false);
  assert.throws(()=>normalizeResult({...input,review_required:false}));
  assert.throws(()=>normalizeResult({...input,violations:[event]}));
});
test('allows loopback only and rejects misleading or external destinations', () => {
  assert.equal(validateBaseUrl('http://localhost:8000/'), 'http://localhost:8000');
  for (const url of ['https://example.com', 'http://localhost.example.com', 'http://localhost:8000/api', 'http://user:secret@localhost', 'file:///tmp/api']) assert.throws(() => validateBaseUrl(url));
});
async function withAPI(handler, run) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    handler(req, res, Buffer.concat(chunks).toString());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-local-key' }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const file = () => new File(['synthetic-video-placeholder'], 'test.mov', { type: 'video/quicktime' });
test('uploads multipart file with key, polls processing, returns multiple events', async () => {
  let polls = 0;
  await withAPI((req, res, body) => {
    assert.equal(req.headers['x-api-key'], 'test-local-key');
    if (req.method === 'POST') {
      assert.equal(req.url, '/api/v1/analyze'); assert.match(body, /name="file"; filename="test.mov"/);
      res.end(JSON.stringify({ job_id: 'local-job-1' }));
    } else {
      assert.equal(req.url, '/api/v1/jobs/local-job-1');
      res.end(JSON.stringify(++polls < 2 ? { status: 'processing' } : { status: 'done', verdict: 'violation', violations: [event, { ...event, timecode_sec: 8 }] }));
    }
  }, async config => {
    const statuses = [];
    const data = await analyzeVideo(file(), config, { pollMs: 1, onStatus: s => statuses.push(s) });
    assert.equal(data.job_id, 'local-job-1'); assert.equal(data.violations.length, 2); assert.deepEqual(statuses, ['uploading', 'processing']);
  });
});
test('authentication errors are not converted to clean verdicts', async () => {
  await withAPI((_req, res) => { res.statusCode = 401; res.end('{}'); }, config => assert.rejects(analyzeVideo(file(), config), /ключ/));
});
test('failed jobs and timeout remain errors', async () => {
  await withAPI((req, res) => res.end(JSON.stringify(req.method === 'POST' ? { job_id: 'failed-1' } : { status: 'failed' })), config => assert.rejects(analyzeVideo(file(), config), /не смог/));
  await withAPI((req, res) => res.end(JSON.stringify(req.method === 'POST' ? { job_id: 'long-1' } : { status: 'processing' })), config => assert.rejects(analyzeVideo(file(), config, { pollMs: 2, timeoutMs: 80 }), /отведённое время/));
});
test('cancellation stops polling', async () => {
  const controller = new AbortController();
  await withAPI((req, res) => { res.end(JSON.stringify(req.method === 'POST' ? { job_id: 'cancel-1' } : { status: 'processing' })); if (req.method === 'GET') controller.abort(); }, config => assert.rejects(analyzeVideo(file(), config, { signal: controller.signal, pollMs: 1 }), { name: 'AbortError' }));
});
