import { ApiError } from './errors.js';
const invalid = (message) => { throw new ApiError(502, 'INVALID_MODEL_RESULT', message); };
const boundedText = (value, limit, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) invalid(`Некорректное поле результата: ${field}.`);
  return value.trim();
};
function time(value, duration) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (duration !== null && value > duration + 0.1)) invalid('Модель вернула таймкод вне видео.');
  return value;
}
function jpeg(value) {
  if (typeof value !== 'string' || value.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) invalid('Доказательство должно быть JPEG в base64 размером до 1 МБ.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > 1048576 || bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9 || bytes.toString('base64') !== value) invalid('Доказательство не является JPEG.');
  let offset = 2, foundSOF = false, foundSOS = false;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid('Некорректная структура JPEG.');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) { foundSOS = true; break; }
    if (marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalid('Некорректная структура JPEG.');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) invalid('Некорректные размеры JPEG.');
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      if (!height || !width || height > 8192 || width > 8192) invalid('Некорректные размеры JPEG.');
      foundSOF = true;
    }
    offset += length;
  }
  if (!foundSOF || !foundSOS) invalid('В JPEG отсутствуют данные изображения.');
  return value;
}
function ruleRef(ref) {
  if (!ref || typeof ref !== 'object') invalid('Некорректное нормативное основание.');
  const title = boundedText(ref.title, 500, 'rule_refs.title');
  const section = ref.section == null ? null : boundedText(ref.section, 250, 'rule_refs.section');
  let url = null;
  if (ref.url != null) {
    if (typeof ref.url !== 'string' || ref.url.length > 2000) invalid('Слишком длинная нормативная ссылка.');
    try { const parsed = new URL(ref.url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error(); url = parsed.href; }
    catch { invalid('Нормативная ссылка должна быть HTTP(S) URL.'); }
  }
  return { title, section, url, verified: ref.verified === true };
}
export function validateResult(value, duration = null) {
  if (!value || typeof value !== 'object' || !['violation', 'no_violation', 'review_required'].includes(value.verdict) || !Array.isArray(value.violations) || value.violations.length > 20) invalid('Модель вернула неподдерживаемую структуру результата.');
  if ((value.verdict === 'violation') !== (value.violations.length > 0)) invalid('Вердикт модели противоречит списку событий.');
  const review = value.verdict === 'review_required';
  if (review && (value.review_required !== true || !Array.isArray(value.observed_events) || value.observed_events.length > 100)) invalid('Ожидались наблюдаемые действия и необходимость проверки.');
  if (!review && (value.review_required === true || value.observed_events?.length)) invalid('Наблюдаемые действия не должны превращаться в заключение о нарушении.');
  const normalizeEvent = (event) => {
    if (!event || !Array.isArray(event.evidence_frames) || event.evidence_frames.length < 1 || event.evidence_frames.length > 3) invalid('Для события требуется от одного до трёх JPEG кадров.');
    if (event.rule_refs !== undefined && (!Array.isArray(event.rule_refs) || event.rule_refs.length > 5)) invalid('Некорректный список нормативных оснований.');
    const result = { type: boundedText(event.type, 160, 'type'), timecode_sec: time(event.timecode_sec, duration),
      description: boundedText(event.description, 4000, 'description'),
      evidence_frames: event.evidence_frames.map((frame) => {
        if (!frame || typeof frame !== 'object') invalid('Некорректный кадр доказательства.');
        return { timestamp_sec: time(frame.timestamp_sec, duration), image_base64: jpeg(frame.image_base64) };
      }),
      rule_refs: (event.rule_refs || []).map(ruleRef) };
    if (review) {
      result.task = boundedText(event.task, 80, 'task');
      result.start_sec = time(event.start_sec, duration);
      result.end_sec = time(event.end_sec, duration);
      if (result.end_sec < result.start_sec || result.timecode_sec < result.start_sec - 0.5 || result.timecode_sec > result.end_sec + 0.5) invalid('Некорректный интервал наблюдаемого действия.');
    }
    return result;
  };
  const violations = value.violations.map(normalizeEvent);
  const warnings = value.warnings === undefined ? [] : value.warnings;
  if (!Array.isArray(warnings) || warnings.length > 10) invalid('Некорректные ограничения модели.');
  const result = { verdict: value.verdict, violations, warnings: warnings.map((text) => boundedText(text, 1000, 'warnings')) };
  if (value.summary !== undefined) result.summary = boundedText(value.summary, 12000, 'summary');
  if (review) {
    result.review_required = true;
    result.observed_events = value.observed_events.map(normalizeEvent);
    const c = value.analysis?.coverage;
    if (!c || typeof c.complete !== 'boolean') invalid('Нет сведений о полноте проверки.');
    const count = (value) => { if (!Number.isSafeInteger(value) || value < 0) invalid('Некорректное число окон или кадров.'); return value; };
    result.analysis = { coverage: { complete: c.complete, duration_sec: time(c.duration_sec, duration),
      candidate_windows: count(c.candidate_windows), analyzed_windows: count(c.analyzed_windows),
      sampled_frames: count(c.sampled_frames), note: boundedText(c.note, 1000, 'coverage.note') } };
    const coverage = result.analysis.coverage;
    if (coverage.analyzed_windows > coverage.candidate_windows || (coverage.complete && coverage.analyzed_windows !== coverage.candidate_windows)) invalid('Противоречивые сведения о полноте проверки.');
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) invalid('Результат модели превышает 8 МБ.');
  return result;
}
