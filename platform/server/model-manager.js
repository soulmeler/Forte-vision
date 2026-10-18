import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { ApiError, modelNotReady } from './errors.js';
import { validateResult } from './result-validation.js';
import { jobDTO } from './storage.js';

export class ModelManager {
  constructor(config, store) {
    this.config = config; this.store = store; this.slots = []; this.tasks = new Map(); this.closed = false;
    this.initialization = config.modelModule ? Promise.all(Array.from({ length: config.maxConcurrentJobs }, (_, index) => this.spawn(index))) : Promise.resolve();
  }
  get state() {
    const ready = this.slots.filter((slot) => slot?.state === 'ready');
    return { status: !this.config.modelModule ? 'not_configured' : ready.length ? 'ready' : this.slots.some((slot) => slot?.state === 'loading') ? 'loading' : 'error',
      ready: ready.length > 0, name: ready[0]?.metadata?.name || null, version: ready[0]?.metadata?.version || null,
      supported_categories: ready[0]?.metadata?.supported_categories || [] };
  }
  async spawn(index) {
    if (this.closed) return;
    const slot = { state: 'loading', busy: false, pending: null, metadata: null, ownedProcesses: new Set(), stopping: null };
    this.slots[index] = slot;
    const worker = new Worker(new URL('./model-worker.js', import.meta.url), { workerData: { modulePath: this.config.modelModule, modelDir: this.config.modelDir } });
    slot.worker = worker;
    await new Promise((resolve) => {
      let settled = false;
      const finishInit = (state) => {
        if (settled) return; settled = true; clearTimeout(initTimer); slot.state = state; resolve(); this.drain();
      };
      const initTimer = setTimeout(() => { finishInit('error'); this.stopWorker(slot); }, this.config.modelLoadTimeoutMs);
      worker.on('message', (message) => {
        if (message.type === 'owned_process' && Number.isSafeInteger(message.pid) && message.pid > 1) slot.ownedProcesses.add(message.pid);
        else if (message.type === 'release_process') slot.ownedProcesses.delete(message.pid);
        else if (message.type === 'ready') { slot.metadata = message.metadata; finishInit('ready'); }
        else if (message.type === 'init_error') { finishInit('error'); this.stopWorker(slot); }
        else if (slot.pending && slot.pending.id === message.id) {
          const pending = slot.pending; slot.pending = null;
          if (message.type === 'result') pending.resolve(message.result);
          else {
            if (message.code === 'MODEL_NOT_READY') slot.state = 'error';
            pending.reject(new ApiError(502, message.code || 'MODEL_ERROR', 'Модель не смогла обработать видео. Проверьте подключение и повторите попытку.'));
          }
        }
      });
      worker.on('error', () => { finishInit('error'); slot.state = 'error'; slot.pending?.reject(new ApiError(502, 'MODEL_WORKER_ERROR', 'Процесс модели завершился с ошибкой.')); slot.pending = null; });
      worker.on('exit', () => { this.killOwnedProcesses(slot); finishInit('error'); slot.state = 'error'; slot.pending?.reject(new ApiError(502, 'MODEL_WORKER_EXITED', 'Процесс модели завершился до получения результата.')); slot.pending = null; });
    });
  }
  killOwnedProcesses(slot, clear = true) {
    for (const pid of slot.ownedProcesses) {
      try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    if (clear) slot.ownedProcesses.clear();
  }
  stopWorker(slot) {
    if (slot.stopping) return slot.stopping;
    slot.stopping = (async () => {
      await new Promise((resolve) => {
        const timer = setTimeout(finish, 150);
        function onMessage(message) { if (message.type === 'closed') finish(); }
        function finish() { clearTimeout(timer); slot.worker.off('message', onMessage); resolve(); }
        slot.worker.on('message', onMessage); slot.worker.postMessage({ type: 'shutdown' });
      });
      this.killOwnedProcesses(slot, false);
      // Let the worker reap its child processes before closing its event loop.
      if (slot.ownedProcesses.size) await new Promise((resolve) => {
        const timer = setTimeout(finish, 150);
        function onMessage(message) { if (message.type === 'release_process' && slot.ownedProcesses.size === 0) finish(); }
        function finish() { clearTimeout(timer); slot.worker.off('message', onMessage); resolve(); }
        slot.worker.on('message', onMessage);
      });
      await slot.worker.terminate();
    })();
    return slot.stopping;
  }
  assertReady() { if (!this.state.ready) throw modelNotReady(); }
  submit(video) {
    this.assertReady();
    const active = this.store.db.prepare("SELECT * FROM jobs WHERE video_id=? AND status='processing'").get(video.id);
    if (active) return jobDTO(active);
    if (this.tasks.size >= this.config.maxPendingJobs) throw new ApiError(429, 'QUEUE_FULL', 'Очередь анализа заполнена. Повторите позже.');
    const id = randomUUID(), now = new Date().toISOString();
    this.store.db.prepare("INSERT INTO jobs (id,video_id,status,stage,created_at,updated_at,model_json) VALUES (?,?,'processing','queued',?,?,?)")
      .run(id, video.id, now, now, JSON.stringify(this.state));
    const task = { id, video, slot: null, done: false, timer: null };
    task.timer = setTimeout(() => this.expire(task), this.config.jobTimeoutMs);
    this.tasks.set(id, task); this.drain();
    return jobDTO(this.store.getJob(id));
  }
  finish(task, result, error) {
    if (task.done) return;
    task.done = true; clearTimeout(task.timer); this.tasks.delete(task.id);
    this.store.db.prepare('UPDATE jobs SET status=?,stage=?,result_json=?,error_code=?,error_message=?,updated_at=? WHERE id=?')
      .run(error ? 'failed' : 'done', error ? 'failed' : 'done', result ? JSON.stringify(result) : null,
        error?.code || null, error?.message || null, new Date().toISOString(), task.id);
  }
  expire(task) {
    this.finish(task, null, new ApiError(504, 'JOB_TIMEOUT', `За ${Math.ceil(this.config.jobTimeoutMs / 60000)} мин. результат не получен. Попробуйте повторить проверку.`));
    if (task.slot) {
      const slot = task.slot, index = this.slots.indexOf(slot);
      slot.state = 'error'; slot.worker.postMessage({ type: 'cancel' });
      this.stopWorker(slot).then(() => { if (!this.closed) return this.spawn(index); });
    } else this.drain();
  }
  drain() {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.state !== 'ready' || slot.busy) continue;
      const task = [...this.tasks.values()].find((entry) => !entry.slot && !entry.done);
      if (!task) break;
      slot.busy = true; task.slot = slot;
      this.store.db.prepare("UPDATE jobs SET stage='analyzing', updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
      const promise = new Promise((resolve, reject) => { slot.pending = { id: task.id, resolve, reject }; });
      // Only the video and its technical metadata reach the model.
      slot.worker.postMessage({ type: 'predict', id: task.id, videoPath: this.store.videoPath(task.video.id), video: {
        id: task.video.id, duration_sec: task.video.duration_sec, width: task.video.width, height: task.video.height,
        codec: task.video.codec, mime_type: task.video.mime_type,
      } });
      promise.then((result) => { if (!task.done) this.finish(task, validateResult(result, task.video.duration_sec), null); })
        .catch((error) => this.finish(task, null, error instanceof ApiError ? error : new ApiError(502, 'MODEL_ERROR', 'Модель вернула некорректный результат.')))
        .finally(() => { slot.busy = false; this.drain(); });
    }
  }
  async close() {
    this.closed = true;
    for (const task of [...this.tasks.values()]) this.finish(task, null, new ApiError(503, 'SERVER_SHUTDOWN', 'Сервис остановлен. Запустите проверку повторно.'));
    await Promise.all(this.slots.map((slot) => this.stopWorker(slot)));
  }
}
