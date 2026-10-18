import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError } from './errors.js';

const run = promisify(execFile);
const invalid = () => { throw new ApiError(502, 'INVALID_REMOTE_RESPONSE', 'Сервер модели вернул неподдерживаемый результат анализа видео.'); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = (value, duration) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= duration;

export async function extractVideoFrame(file, seconds, config, signal) {
  try {
    const { stdout } = await run(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds),
      '-i', file, '-frames:v', '1', '-vf', 'scale=960:540:force_original_aspect_ratio=decrease',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1048576, timeout: 15000, signal });
    return { timestamp_sec: seconds, image_base64: stdout.toString('base64') };
  } catch {
    throw new ApiError(502, 'EVIDENCE_EXTRACTION_FAILED', 'Не удалось извлечь кадр результата. Проверьте установку FFmpeg на компьютере платформы.');
  }
}

// Adapt the observed /v1/analyze-video response. Never infer a clean verdict from
// missing predictions, failed windows, null decisions or insufficient evidence.
export async function normalizeRawVideoResult(response, videoDuration, frameAt) {
  const result = response?.result, p = result?.prediction, c = result?.window_status_counts;
  if (!result || !p || ![true, false, null].includes(p.violation) || typeof p.insufficient_data !== 'boolean'
      || !Array.isArray(p.events) || p.events.length > 20 || !c || !['ok', 'invalid', 'error'].every(k => count(c[k]))) invalid();
  const total = c.ok + c.invalid + c.error;
  if (!total || !c.ok) throw new ApiError(502, 'REMOTE_JOB_FAILED', 'Сервер модели не смог обработать окна видео.');
  const duration = videoDuration ?? result.duration_seconds;
  if (!timestamp(duration, Number.MAX_SAFE_INTEGER) || !timestamp(result.duration_seconds, duration + 0.1)) invalid();
  if (!Array.isArray(result.windows) || result.windows.length !== total) invalid();
  const counts = { ok: 0, invalid: 0, error: 0 };
  for (const window of result.windows) {
    if (!Object.hasOwn(counts, window?.status)) invalid();
    counts[window.status]++;
  }
  if (Object.keys(counts).some(k => counts[k] !== c[k])) invalid();
  let coveredUntil = 0;
  const windows = [...result.windows].sort((a, b) => a.start_seconds - b.start_seconds);
  let coverageValid = true;
  for (const window of windows) {
    if (!timestamp(window.start_seconds, duration + 0.1) || !timestamp(window.end_seconds, duration + 0.1)
        || window.end_seconds < window.start_seconds || window.start_seconds > coveredUntil + 0.1) coverageValid = false;
    coveredUntil = Math.max(coveredUntil, window.end_seconds ?? 0);
  }
  const complete = result.status === 'ok' && c.ok === total && coverageValid && coveredUntil >= duration - 0.1;
  let review = !complete || p.insufficient_data || p.violation === null;
  const warnings = [];
  if (!complete) warnings.push('Не все окна видео успешно обработаны. Результат требует ручной проверки.');
  if (p.insufficient_data || p.violation === null) warnings.push('Модель сообщила о недостатке данных для вывода.');
  const events = [];
  const summary = p.events.map(event => {
    if (!event || typeof event.evidence !== 'string' || typeof event.reason !== 'string') invalid();
    return `${event.evidence}\n${event.reason}`.trim();
  }).filter(Boolean).join('\n\n').slice(0, 12000);
  if (p.violation !== false || review) {
    for (const event of p.events) {
      if (!event || typeof event.evidence !== 'string' || typeof event.reason !== 'string') invalid();
      if (event.start_seconds === null || event.end_seconds === null) {
        review = true;
        if (!warnings.includes('Для части событий модель не указала таймкоды.')) warnings.push('Для части событий модель не указала таймкоды.');
        continue;
      }
      if (!timestamp(event.start_seconds, duration) || !timestamp(event.end_seconds, duration) || event.end_seconds < event.start_seconds) invalid();
      const type = event.event_type ?? p.event_type;
      if (typeof type !== 'string' || !type.trim() || type === 'none') invalid();
      const time = (event.start_seconds + event.end_seconds) / 2;
      // A decoded frame must precede EOF, even when the reported event ends at EOF.
      const frameTime = Math.min(time, Math.max(0, duration - 0.1));
      events.push({ type, timecode_sec: time, description: `${event.evidence}\n${event.reason}`.trim(),
        evidence_frames: [await frameAt(frameTime)], rule_refs: [],
        task: 'server_video_analysis', start_sec: event.start_seconds, end_sec: event.end_seconds });
    }
    if (!events.length) review = true;
  }
  if (events.length) warnings.push('Кадры извлечены платформой по таймкодам модели. Нормативные ссылки сервером не переданы.');
  if (review) {
    let sampled = 0;
    for (const window of result.windows) sampled += Array.isArray(window.input_trace?.sampled_pts_seconds) ? window.input_trace.sampled_pts_seconds.length : 0;
    return { verdict: 'review_required', review_required: true, violations: [], observed_events: events, warnings, ...(summary ? { summary } : {}),
      analysis: { coverage: { complete, duration_sec: duration, candidate_windows: total,
        analyzed_windows: c.ok, sampled_frames: sampled, note: 'Сведения об окнах получены от сервера модели; это не оценка точности.' } } };
  }
  return { verdict: p.violation ? 'violation' : 'no_violation', violations: events, warnings, ...(summary ? { summary } : {}) };
}
