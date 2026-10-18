import { randomUUID } from 'node:crypto';
import { ApiError, missing } from './errors.js';
import { jobDTO } from './storage.js';

// Batch lists and reports intentionally omit large image payloads. The ordinary
// video/job endpoint remains the source for playback and evidence frames.
function compactJob(row) {
  const job = jobDTO(row);
  const event = ({ evidence_frames: _frames, ...value }) => value;
  return { job_id: job.job_id, status: job.status, model: job.model,
    ...(job.verdict ? { verdict: job.verdict } : {}),
    ...(job.summary ? { summary: job.summary } : {}),
    violations: (job.violations || []).map(event),
    observed_events: (job.observed_events || []).map(event),
    warnings: job.warnings || [], ...(job.error ? { error: job.error } : {}) };
}

export class BatchManager {
  constructor(config, store, model) {
    this.config = config; this.store = store; this.model = model; this.closed = false;
    this.reconcile();
    this.timer = setInterval(() => this.tick(), config.batchPollIntervalMs || 500);
    this.timer.unref();
  }
  require(id) {
    const row = this.store.db.prepare('SELECT * FROM batches WHERE id=?').get(id);
    if (!row) throw missing();
    return row;
  }
  reconcile() {
    for (const item of this.store.db.prepare("SELECT * FROM batch_items WHERE status='processing'").all()) {
      const job = item.job_id ? this.store.getJob(item.job_id) : null;
      if (job?.status === 'processing') continue;
      const result = job ? compactJob(job) : null;
      this.store.db.prepare('UPDATE batch_items SET status=?,job_json=?,error_code=?,error_message=? WHERE id=?')
        .run(job?.status === 'done' ? 'done' : 'failed', result ? JSON.stringify(result) : null,
          result?.error?.code || (job ? null : 'JOB_UNAVAILABLE'), result?.error?.message || (job ? null : 'Результат проверки отсутствует. Повторите анализ.'), item.id);
    }
    this.store.db.prepare("UPDATE batches SET status='done' WHERE status IN ('processing','paused') AND NOT EXISTS (SELECT 1 FROM batch_items WHERE batch_id=batches.id AND status IN ('queued','processing'))").run();
  }
  dto(id) {
    this.reconcile();
    const row = this.require(id);
    const items = this.store.db.prepare('SELECT * FROM batch_items WHERE batch_id=? ORDER BY position').all(id).map(item => {
      const snapshot = item.status !== 'processing' && item.job_json ? JSON.parse(item.job_json) : null;
      const live = !snapshot && item.job_id ? this.store.getJob(item.job_id) : null;
      const job = snapshot || (live ? compactJob(live) : null);
      return { id: item.id, original_name: item.original_name, video_id: item.video_id,
        status: item.status, job,
        review: item.video_id ? JSON.parse(this.store.getVideo(item.video_id)?.review_json || 'null') : null,
        error: item.error_code ? { code: item.error_code, message: item.error_message } : job?.error || null };
    });
    const counts = { total: items.length, queued: 0, processing: 0, done: 0, failed: 0 };
    for (const item of items) counts[item.status]++;
    return { ...row, counts, items };
  }
  list() {
    this.reconcile();
    return this.store.db.prepare('SELECT * FROM batches ORDER BY created_at DESC,rowid DESC LIMIT 100').all().map(row => {
      const counts = { total: 0, queued: 0, processing: 0, done: 0, failed: 0 };
      for (const item of this.store.db.prepare('SELECT status,COUNT(*) AS n FROM batch_items WHERE batch_id=? GROUP BY status').all(row.id)) { counts[item.status] = Number(item.n); counts.total += Number(item.n); }
      return { ...row, counts };
    });
  }
  create(originalName, items) {
    const id = randomUUID();
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare("INSERT INTO batches(id,original_name,created_at,status) VALUES (?,?,?,'ready')").run(id, originalName, new Date().toISOString());
      const insert = this.store.db.prepare('INSERT INTO batch_items(id,batch_id,position,original_name,video_id,status,error_code,error_message) VALUES (?,?,?,?,?,?,?,?)');
      items.forEach((item, i) => insert.run(randomUUID(), id, i, item.original_name, item.video_id || null, item.error ? 'failed' : 'queued', item.error?.code || null, item.error?.message || null));
      const clearPending = this.store.db.prepare('DELETE FROM archive_pending_videos WHERE video_id=?');
      for (const item of items) if (item.video_id) clearPending.run(item.video_id);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return this.dto(id);
  }
  start(id, options = {}) {
    this.reconcile(); this.require(id);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'retry_failed') || (options.retry_failed !== undefined && typeof options.retry_failed !== 'boolean')) {
      throw new ApiError(400, 'INVALID_BATCH_OPTIONS', 'Для повторной проверки укажите retry_failed: true.');
    }
    const pending = this.store.db.prepare("SELECT COUNT(*) AS n FROM batch_items WHERE batch_id=? AND (status='queued' OR (? AND status='failed' AND video_id IS NOT NULL))").get(id, options.retry_failed ? 1 : 0).n;
    if (pending) this.model.assertReady();
    if (options.retry_failed) this.store.db.prepare("UPDATE batch_items SET status='queued',job_id=NULL,job_json=NULL,error_code=NULL,error_message=NULL WHERE batch_id=? AND status='failed' AND video_id IS NOT NULL").run(id);
    const active = this.store.db.prepare("SELECT 1 FROM batch_items WHERE batch_id=? AND status IN ('queued','processing')").get(id);
    this.store.db.prepare('UPDATE batches SET status=? WHERE id=?').run(active ? 'processing' : 'done', id);
    this.tick(); return this.dto(id);
  }
  tick() {
    if (this.closed) return;
    this.reconcile();
    const next = this.store.db.prepare("SELECT batch_items.* FROM batch_items JOIN batches ON batches.id=batch_items.batch_id WHERE batches.status='processing' AND batch_items.status='queued' ORDER BY batches.created_at,batches.rowid,batch_items.position LIMIT 1").get();
    if (!next) return;
    // Importing a large archive never consumes the model's short pending queue.
    // Submit one video only when all current model work has finished.
    if (this.model.tasks.size || this.store.db.prepare("SELECT 1 FROM batch_items WHERE status='processing'").get()) return;
    if (!this.model.state.ready) {
      this.store.db.prepare("UPDATE batches SET status='paused' WHERE status='processing'").run(); return;
    }
    const video = this.store.getVideo(next.video_id);
    if (!video) {
      this.store.db.prepare("UPDATE batch_items SET status='failed',error_code='VIDEO_UNAVAILABLE',error_message='Видео отсутствует в хранилище.' WHERE id=?").run(next.id); return;
    }
    try {
      const job = this.model.submit(video);
      this.store.db.prepare("UPDATE batch_items SET status='processing',job_id=?,job_json=NULL,error_code=NULL,error_message=NULL WHERE id=?").run(job.job_id, next.id);
    } catch (error) {
      if (error.code === 'QUEUE_FULL' || error.code === 'CONNECTION_BUSY') return;
      if (error.code === 'MODEL_NOT_READY') { this.store.db.prepare("UPDATE batches SET status='paused' WHERE id=?").run(next.batch_id); return; }
      this.store.db.prepare("UPDATE batch_items SET status='failed',error_code=?,error_message=? WHERE id=?").run(error instanceof ApiError ? error.code : 'BATCH_ANALYSIS_FAILED', error instanceof ApiError ? error.message : 'Не удалось запустить проверку видео.', next.id);
    }
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
