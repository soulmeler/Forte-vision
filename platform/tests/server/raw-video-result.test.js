import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizeRawVideoResult } from '../../server/raw-video-result.js';
import { validateResult } from '../../server/result-validation.js';

const jpeg = (await fs.readFile(new URL('./fixtures/evidence.jpg', import.meta.url))).toString('base64');
const frame = async timestamp_sec => ({ timestamp_sec, image_base64: jpeg });
function response(violation = false) {
  return { result: { status: 'ok', duration_seconds: 10,
    prediction: { violation, insufficient_data: false, event_type: violation ? 'cash_transfer' : 'none',
      events: [{ start_seconds: violation ? 2 : null, end_seconds: violation ? 4 : null, evidence: 'Visible action.', reason: 'Model explanation.' }] },
    window_status_counts: { ok: 1, invalid: 0, error: 0 }, windows: [{ status: 'ok', start_seconds: 0, end_seconds: 10 }] } };
}
test('raw response maps clean and violation verdicts, global timestamps and real frame data', async () => {
  const clear = validateResult(await normalizeRawVideoResult(response(), 10, frame), 10);
  assert.equal(clear.verdict, 'no_violation');
  assert.equal(clear.summary, 'Visible action.\nModel explanation.');
  const result = validateResult(await normalizeRawVideoResult(response(true), 10, frame), 10);
  assert.equal(result.verdict, 'violation');
  assert.equal(result.violations[0].timecode_sec, 3);
  assert.equal(result.violations[0].evidence_frames[0].timestamp_sec, 3);
  assert.equal(result.violations[0].evidence_frames[0].image_base64, jpeg);
  assert.deepEqual(result.violations[0].rule_refs, []);
});
test('insufficient data, null verdict, missing times and incomplete coverage never become clean verdicts', async () => {
  const uncertain = response(); uncertain.result.prediction.insufficient_data = true;
  const undecided = response(); undecided.result.prediction.violation = null;
  const untimed = response(true); untimed.result.prediction.events[0].start_seconds = null;
  const partial = response(); partial.result.window_status_counts.error = 1;
  partial.result.windows = [{ status: 'ok', start_seconds: 0, end_seconds: 5 }, { status: 'error', start_seconds: 5, end_seconds: 10 }];
  const short = response(); short.result.windows[0].end_seconds = 5;
  const gap = response(); gap.result.windows[0].start_seconds = 3;
  for (const value of [uncertain, undecided, untimed, partial, short, gap]) {
    const result = validateResult(await normalizeRawVideoResult(value, 10, frame), 10);
    assert.equal(result.verdict, 'review_required'); assert.deepEqual(result.violations, []);
  }
});
test('invalid predictions, failed windows and out-of-range timestamps fail without invented results', async () => {
  const malformed = response(); delete malformed.result.prediction;
  const failed = response(); failed.result.window_status_counts = { ok: 0, error: 1, invalid: 0 };
  const mismatch = response(); mismatch.result.window_status_counts.ok = 2;
  const late = response(true); late.result.prediction.events[0].end_seconds = 11;
  const backwards = response(true); backwards.result.prediction.events[0].end_seconds = 1;
  for (const value of [malformed, failed, mismatch, late, backwards]) await assert.rejects(normalizeRawVideoResult(value, 10, frame));
});
