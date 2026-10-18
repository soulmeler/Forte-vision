export function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Укажите адрес API, например http://127.0.0.1:8000'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Для этой версии укажите API на localhost или 127.0.0.1 без дополнительного пути.');
  return url.origin;
}

export function normalizeResult(data) {
  if (!data || data.status !== 'done' || !['violation', 'no_violation', 'review_required'].includes(data.verdict) || !Array.isArray(data.violations)) throw new Error('Ответ API не соответствует формату кейса.');
  if ((data.verdict === 'violation') !== (data.violations.length > 0)) throw new Error('Вердикт API противоречит списку событий.');
  if (data.verdict === 'review_required' && (data.review_required !== true || !Array.isArray(data.observed_events))) throw new Error('Наблюдения должны явно требовать проверки.');
  const normalizeEvents = events => events.map((event, index) => {
      if (!event || typeof event.type !== 'string' || !event.type.trim() || typeof event.description !== 'string' || !Number.isFinite(event.timecode_sec) || event.timecode_sec < 0 || !Array.isArray(event.evidence_frames) || event.evidence_frames.length < 1 || event.evidence_frames.length > 3) throw new Error(`Некорректные данные события ${index + 1}.`);
      const frames = event.evidence_frames.map(frame => {
        if (!frame || !Number.isFinite(frame.timestamp_sec) || frame.timestamp_sec < 0 || typeof frame.image_base64 !== 'string' || frame.image_base64.length > 20_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.image_base64) || !frame.image_base64.startsWith('/9j/')) throw new Error(`Некорректный JPEG-доказательство в событии ${index + 1}.`);
        return { timestamp_sec: frame.timestamp_sec, image_base64: frame.image_base64 };
      });
      // Optional extension: the official example has no dedicated rule field.
      const rule = event.rule && typeof event.rule === 'object' ? {
        title: String(event.rule.title || ''), section: String(event.rule.section || ''), url: String(event.rule.url || '')
      } : null;
      return { type: event.type, description: event.description, timecode_sec: event.timecode_sec, evidence_frames: frames, rule };
    }).sort((a, b) => a.timecode_sec - b.timecode_sec);
  return {
    job_id: data.job_id || '', status: 'done', verdict: data.verdict,
    review_required: data.review_required === true,
    violations: normalizeEvents(data.violations),
    observed_events: normalizeEvents(data.observed_events || []),
    analysis: data.analysis || null
  };
}

function abortError() { return new DOMException('Ожидание остановлено', 'AbortError'); }
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError());
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
  });
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

export async function analyzeVideo(file, config, { signal, onStatus = () => {}, pollMs = 1500, timeoutMs = 1260000 } = {}) {
  const baseUrl = validateBaseUrl(config.baseUrl);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) controller.abort();
  let expired = false;
  const timeout = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
  async function request(action, jobId) {
    if (controller.signal.aborted) throw abortError();
    const payload = { action, baseUrl, apiKey: config.apiKey || '', jobId };
    if (globalThis.window?.desktop) {
      if (action === 'analyze') Object.assign(payload, { bytes: await file.arrayBuffer(), name: file.name, mime: file.type });
      const result = await abortable(window.desktop.request(payload), controller.signal);
      if (controller.signal.aborted) throw abortError();
      return result;
    }
    const headers = { 'X-API-Key': config.apiKey || '' };
    let body;
    if (action === 'analyze') { body = new FormData(); body.append('file', file); }
    let response;
    try { response = await fetch(baseUrl + (action === 'analyze' ? '/api/v1/analyze' : '/api/v1/jobs/' + encodeURIComponent(jobId)), { method: action === 'analyze' ? 'POST' : 'GET', headers, body, signal: controller.signal, redirect: 'error' }); }
    catch (error) { if (controller.signal.aborted) throw abortError(); throw new Error('Не удалось подключиться к локальному API. Проверьте сервер и настройки CORS для браузера.'); }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'API отклонил ключ доступа.' : `API вернул HTTP ${response.status}.`);
    return response.json();
  }
  try {
    onStatus('uploading');
    const job = await request('analyze');
    if (typeof job?.job_id !== 'string' || !/^[\w-]{1,128}$/.test(job.job_id)) throw new Error('API не вернул корректный job_id.');
    onStatus('processing');
    while (true) {
      const result = await request('job', job.job_id);
      if (result.status === 'done') return normalizeResult({ ...result, job_id: job.job_id });
      if (result.status === 'failed') throw new Error('Сервер не смог обработать видео. Повторите проверку или посмотрите журнал backend.');
      if (result.status !== 'processing') throw new Error('API вернул неизвестный статус задачи.');
      await delay(pollMs, controller.signal);
    }
  } catch (error) {
    if (expired) throw new Error('API не вернул результат за отведённое время. Проверьте очередь и скорость модели.');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', stop); }
}
