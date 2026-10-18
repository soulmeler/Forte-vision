import { openAsBlob } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, modelNotReady } from './errors.js';
import { ModelManager } from './model-manager.js';
import { validateResult } from './result-validation.js';
import { normalizeRawVideoResult, extractVideoFrame } from './raw-video-result.js';

const emptyState = () => ({ status: 'not_configured', ready: false, name: null, version: null, supported_categories: [] });
const remoteError = (code, message, status = 502) => new ApiError(status, code, message);
const invalidResponse = () => remoteError('INVALID_REMOTE_RESPONSE', 'Сервер модели вернул неподдерживаемый ответ API.');

function connectionInput(value) {
  let url;
  try {
    if (typeof value?.base_url !== 'string' || value.base_url.length > 2000) throw Error();
    url = new URL(value.base_url.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.hostname) throw Error();
  } catch { throw remoteError('INVALID_MODEL_URL', 'Введите HTTP(S) адрес API сервера модели без ключа, параметров и фрагмента.', 400); }
  if (typeof value.api_key !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.api_key)) {
    throw remoteError('INVALID_MODEL_API_KEY', 'Введите API-ключ сервера модели без пробелов и переносов строк.', 400);
  }
  const baseUrl = url.href.replace(/\/+$/, '');
  // The team's video endpoint uses a synchronous raw-body API with Bearer auth.
  // Other addresses retain the platform's asynchronous multipart job protocol.
  const rawVideo = url.pathname.replace(/\/+$/, '').endsWith('/v1/analyze-video');
  return { baseUrl, apiKey: value.api_key, rawVideo,
    requestBase: rawVideo ? url.origin : baseUrl,
    analyzePath: rawVideo ? url.pathname.replace(/\/+$/, '') : '/analyze' };
}

// The browser talks only to this platform. Credentials and remote HTTP requests stay here.
class RemoteModelManager extends ModelManager {
  constructor(config, store, connection) {
    super({ ...config, modelModule: null }, store);
    this.connection = connection;
    this.remoteState = { ...emptyState(), status: 'loading', transport: 'remote_api' };
    this.checkedAt = null; this.connectionError = null; this.checking = null;
    this.lifetime = new AbortController(); this.running = 0;
    this.healthTimer = setInterval(() => { void this.check().catch(() => {}); }, config.remoteHealthIntervalMs ?? 20000);
    this.healthTimer.unref();
  }
  get state() { return this.remoteState; }
  get connectionDTO() {
    return { configured: true, base_url: this.connection.baseUrl, key_present: true,
      authentication: this.connection.rawVideo ? 'bearer' : 'api_key',
      protocol: this.connection.rawVideo ? 'raw_video' : 'async_jobs',
      persistence: 'memory', checked_at: this.checkedAt, error: this.connectionError };
  }
  async request(route, options = {}, signal = this.lifetime.signal, large = false) {
    const timeout = AbortSignal.timeout(large ? this.config.jobTimeoutMs : (this.config.remoteRequestTimeoutMs ?? 10000));
    const combined = AbortSignal.any([signal, this.lifetime.signal, timeout]);
    try {
      const response = await fetch(this.connection.requestBase + route, {
        ...options, headers: { ...options.headers, Accept: 'application/json', 'ngrok-skip-browser-warning': '1',
          ...(this.connection.rawVideo ? { Authorization: `Bearer ${this.connection.apiKey}` } : { 'X-API-Key': this.connection.apiKey }) },
        redirect: 'manual', signal: combined,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw remoteError('REMOTE_REDIRECT_REJECTED', 'Сервер модели перенаправляет запрос. Укажите конечный адрес API.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw remoteError('REMOTE_AUTH_FAILED', 'Сервер модели не принял API-ключ.');
        throw remoteError('REMOTE_UNAVAILABLE', 'Сервер модели отклонил запрос. Проверьте его состояние и адрес API.');
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 9 * 1024 * 1024) { throw invalidResponse(); }
        chunks.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw invalidResponse(); }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timeout.aborted || combined.aborted) throw remoteError('REMOTE_TIMEOUT', 'Сервер модели не ответил вовремя.', 504);
      throw remoteError('REMOTE_UNAVAILABLE', 'Не удалось связаться с сервером модели. Проверьте адрес API и сеть.');
    }
  }
  async check() {
    if (this.checking) return this.checking;
    if (this.closed) return;
    this.checking = (async () => {
      try {
        const health = await this.request('/health');
        const model = this.connection.rawVideo ? {
          ready: health?.ready,
          name: typeof health?.base_model === 'string' ? health.base_model.split(/[\\/]/).pop() : null,
          version: health?.adapter,
        } : health?.model;
        if (typeof model?.ready !== 'boolean') throw invalidResponse();
        const safeText = (value, max = 200) => typeof value === 'string' ? value.replaceAll(this.connection.apiKey, '[hidden]').slice(0, max) : null;
        this.remoteState = { status: model.ready ? 'ready' : model.status === 'loading' ? 'loading' : 'error',
          ready: model.ready, name: safeText(model.name), version: safeText(model.version), transport: 'remote_api',
          supported_categories: Array.isArray(model.supported_categories) ? model.supported_categories.slice(0, 100).filter((v) => typeof v === 'string').map((v) => safeText(v, 160)) : [] };
        this.connectionError = null;
      } catch (error) {
        this.remoteState = { ...this.remoteState, status: 'error', ready: false };
        this.connectionError = { code: error.code || 'REMOTE_UNAVAILABLE', message: error.message };
        throw error;
      } finally { this.checkedAt = new Date().toISOString(); }
    })();
    try { await this.checking; } finally { this.checking = null; }
  }
  drain() {
    if (this.closed) return;
    while (this.running < this.config.maxConcurrentJobs) {
      const task = [...this.tasks.values()].find((entry) => !entry.started && !entry.done);
      if (!task) break;
      task.started = true; task.controller = new AbortController(); this.running++;
      this.store.db.prepare("UPDATE jobs SET stage='analyzing', updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
      void this.predict(task).then((result) => { if (!task.done) this.finish(task, validateResult(result, task.video.duration_sec), null); })
        .catch((error) => {
          if (['REMOTE_AUTH_FAILED', 'REMOTE_UNAVAILABLE', 'REMOTE_TIMEOUT', 'REMOTE_REDIRECT_REJECTED'].includes(error.code)) {
            this.remoteState = { ...this.remoteState, status: 'error', ready: false };
            this.connectionError = { code: error.code, message: error.message };
          }
          this.finish(task, null, error instanceof ApiError ? error : invalidResponse());
        }).finally(() => { this.running--; this.drain(); });
    }
  }
  async predict(task) {
    if (this.connection.rawVideo) {
      const response = await this.request(this.connection.analyzePath, {
        method: 'POST', headers: { 'Content-Type': task.video.mime_type },
        body: await openAsBlob(this.store.videoPath(task.video.id), { type: task.video.mime_type }),
      }, task.controller.signal, true);
      return normalizeRawVideoResult(response, task.video.duration_sec,
        seconds => extractVideoFrame(this.store.videoPath(task.video.id), seconds, this.config, task.controller.signal));
    }
    const body = new FormData();
    // Generic filename and only the video bytes: no Excel text, labels, annotations or prompts.
    body.set('file', await openAsBlob(this.store.videoPath(task.video.id), { type: task.video.mime_type }), task.video.mime_type === 'video/mp4' ? 'video.mp4' : 'video.mov');
    let job = await this.request('/analyze', { method: 'POST', body }, task.controller.signal, true);
    const id = job?.job_id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw invalidResponse();
    while (true) {
      if (task.done || task.controller.signal.aborted) throw remoteError('REMOTE_TIMEOUT', 'Проверка остановлена.', 504);
      if (job?.job_id !== id || !['processing', 'done', 'failed'].includes(job.status)) throw invalidResponse();
      if (job.status === 'done') return job;
      if (job.status === 'failed') throw remoteError('REMOTE_JOB_FAILED', 'Сервер модели не смог обработать видео. Проверьте его журналы и повторите анализ.');
      await delay(this.config.remotePollIntervalMs ?? 1000, undefined, { signal: task.controller.signal });
      job = await this.request('/jobs/' + encodeURIComponent(id), {}, task.controller.signal);
    }
  }
  expire(task) {
    this.finish(task, null, new ApiError(504, 'JOB_TIMEOUT', `За ${Math.ceil(this.config.jobTimeoutMs / 60000)} мин. результат не получен. Попробуйте повторить проверку.`));
    task.controller?.abort();
    this.drain();
  }
  async close() {
    this.closed = true; clearInterval(this.healthTimer); this.lifetime.abort();
    for (const task of [...this.tasks.values()]) {
      this.finish(task, null, new ApiError(503, 'SERVER_SHUTDOWN', 'Платформа остановлена. Запустите проверку повторно.'));
      task.controller?.abort();
    }
    // Each task is marked done before the store closes; late fetch continuations cannot write it.
  }
}

export class ModelConnectionManager {
  constructor(config, store) {
    this.config = config; this.store = store; this.local = new ModelManager(config, store);
    this.remote = null; this.changing = false; this.closed = false;
    this.initialization = this.local.initialization;
  }
  get active() { return this.remote || this.local; }
  get state() { return this.active.state; }
  get tasks() { return this.active.tasks; }
  get connectionState() {
    return { connection: this.remote?.connectionDTO || { configured: false, base_url: null, key_present: false,
      authentication: null, persistence: 'memory', checked_at: null, error: null }, model: this.state };
  }
  assertReady() {
    if (this.changing) throw remoteError('CONNECTION_BUSY', 'Подключение сервера модели обновляется. Повторите после завершения.', 409);
    if (!this.state.ready) throw modelNotReady();
  }
  submit(video) { this.assertReady(); return this.active.submit(video); }
  async mutation(action, requireIdle = false) {
    if (this.closed) throw remoteError('SERVER_SHUTDOWN', 'Платформа остановлена.', 503);
    if (this.changing) throw remoteError('CONNECTION_BUSY', 'Дождитесь завершения проверки подключения.', 409);
    if (requireIdle && this.tasks.size) throw remoteError('MODEL_BUSY', 'Дождитесь завершения анализа перед изменением подключения.', 409);
    this.changing = true;
    try { return await action(); } finally { this.changing = false; }
  }
  connect(input, ownOrigin) {
    return this.mutation(async () => {
      const connection = connectionInput(input);
      const target = new URL(connection.baseUrl), own = new URL(ownOrigin);
      const loopback = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
      if (target.origin === own.origin || (loopback(target.hostname) && loopback(own.hostname) && target.port === own.port)) {
        throw remoteError('INVALID_MODEL_URL', 'Укажите API отдельного сервера модели, а не адрес этой платформы.', 400);
      }
      const candidate = new RemoteModelManager(this.config, this.store, connection);
      this.candidate = candidate;
      try {
        await candidate.check();
        if (this.closed) throw remoteError('SERVER_SHUTDOWN', 'Платформа остановлена.', 503);
        await this.active.close();
        if (this.closed) throw remoteError('SERVER_SHUTDOWN', 'Платформа остановлена.', 503);
        this.remote = candidate;
        this.local = new ModelManager({ ...this.config, modelModule: null }, this.store);
      } catch (error) { await candidate.close(); throw error; }
      finally { this.candidate = null; }
      return this.connectionState;
    }, true);
  }
  check() {
    return this.mutation(async () => {
      if (!this.remote) throw remoteError('MODEL_NOT_CONFIGURED', 'Сначала укажите адрес API и ключ сервера модели.', 409);
      await this.remote.check().catch(() => {});
      return this.connectionState;
    });
  }
  disconnect() {
    return this.mutation(async () => {
      await this.active.close(); this.remote = null;
      this.local = new ModelManager({ ...this.config, modelModule: null }, this.store);
      return this.connectionState;
    }, true);
  }
  async close() { this.closed = true; await Promise.all([this.active.close(), this.candidate?.close()]); }
}
