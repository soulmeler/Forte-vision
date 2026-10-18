import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openStore(config) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const videosDir = path.join(config.dataDir, 'videos');
  const tempDir = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(videosDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(config.dataDir, 'vision-forte.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY, original_name TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
      duration_sec REAL, width INTEGER, height INTEGER, codec TEXT, has_audio INTEGER,
      metadata_source TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('processing','done','failed')),
      stage TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      result_json TEXT, error_code TEXT, error_message TEXT, model_json TEXT
    ); CREATE INDEX IF NOT EXISTS jobs_video ON jobs(video_id);
    CREATE INDEX IF NOT EXISTS videos_created ON videos(created_at);
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY, original_name TEXT NOT NULL, created_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ready','processing','paused','done'))
    );
    CREATE TABLE IF NOT EXISTS batch_items (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, original_name TEXT NOT NULL,
      video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
      job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','processing','done','failed')),
      job_json TEXT, error_code TEXT, error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS batch_items_batch ON batch_items(batch_id,position);
    CREATE INDEX IF NOT EXISTS batch_items_video ON batch_items(video_id);
    CREATE TABLE IF NOT EXISTS archive_pending_videos (
      video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE
    );`);
  // Remove the retired annotation snapshot without rebuilding video identities
  // or changing the jobs that reference them. A transaction makes this migration
  // safe to retry after an interrupted startup.
  if (db.prepare('PRAGMA table_info(videos)').all().some((column) => column.name === 'annotation_json')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE videos DROP COLUMN annotation_json; COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK'); db.close(); throw error;
    }
  }
  db.prepare("UPDATE jobs SET status='failed', stage='failed', error_code='SERVER_RESTARTED', error_message='Сервис был перезапущен. Запустите проверку повторно.', updated_at=? WHERE status='processing'").run(new Date().toISOString());
  db.prepare("UPDATE batches SET status='paused' WHERE status='processing'").run();
  // A killed importer must not leave partial batches or invisible stored media.
  for (const row of db.prepare('SELECT video_id FROM archive_pending_videos').all()) {
    fs.rmSync(path.join(videosDir, `${row.video_id}.video`), { force: true });
    db.prepare('DELETE FROM videos WHERE id=?').run(row.video_id);
  }
  // Only service-owned transient/orphan files are removed after a process restart.
  for (const name of fs.readdirSync(tempDir)) if (/^[a-f0-9-]{36}\.upload$/.test(name)) fs.rmSync(path.join(tempDir, name), { force: true });
  for (const name of fs.readdirSync(videosDir)) {
    if (/^[a-f0-9-]{36}\.video$/.test(name) && !db.prepare('SELECT 1 FROM videos WHERE id=?').get(name.slice(0, -6))) fs.rmSync(path.join(videosDir, name), { force: true });
  }
  const videoPath = (id) => path.join(videosDir, `${id}.video`);
  const getVideo = (id) => db.prepare('SELECT * FROM videos WHERE id=?').get(id);
  const getJob = (id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  const sizeUsed = () => Number(db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS total FROM videos').get().total);
  const videoInPendingBatch = (id) => Boolean(db.prepare("SELECT 1 FROM batch_items JOIN batches ON batches.id=batch_items.batch_id WHERE video_id=? AND (batch_items.status='processing' OR (batches.status='processing' AND batch_items.status='queued'))").get(id));
  function deleteVideo(id) {
    // Keep the DB row if unlink fails; next request can retry the deletion.
    fs.rmSync(videoPath(id), { force: true });
    db.prepare("UPDATE batch_items SET status='failed',error_code='VIDEO_DELETED',error_message='Видео удалено из хранилища. Загрузите запись повторно.' WHERE video_id=? AND status='queued'").run(id);
    db.prepare('DELETE FROM videos WHERE id=?').run(id);
  }
  function cleanup() {
    const cutoff = new Date(Date.now() - config.retentionDays * 86400000).toISOString();
    const rows = db.prepare("SELECT id FROM videos WHERE created_at < ? AND id NOT IN (SELECT video_id FROM jobs WHERE status='processing') AND id NOT IN (SELECT video_id FROM batch_items JOIN batches ON batches.id=batch_items.batch_id WHERE video_id IS NOT NULL AND (batch_items.status='processing' OR (batches.status='processing' AND batch_items.status='queued'))) AND id NOT IN (SELECT video_id FROM archive_pending_videos)").all(cutoff);
    for (const row of rows) { try { deleteVideo(row.id); } catch { /* next cleanup retries */ } }
    return rows.length;
  }
  cleanup();
  return { db, videoPath, tempDir, getVideo, getJob, sizeUsed, videoInPendingBatch, deleteVideo, cleanup, close: () => db.close() };
}
export function videoDTO(row) {
  return { id: row.id, original_name: row.original_name, size_bytes: row.size_bytes,
    mime_type: row.mime_type, sha256: row.sha256, created_at: row.created_at,
    duration_sec: row.duration_sec, width: row.width, height: row.height, codec: row.codec,
    has_audio: row.has_audio === null ? null : Boolean(row.has_audio),
    metadata_source: row.metadata_source, preview_url: `/api/v1/videos/${row.id}/content` };
}
export function jobDTO(row) {
  const result = row.result_json ? JSON.parse(row.result_json) : {};
  const model = row.model_json ? JSON.parse(row.model_json) : null;
  return { job_id: row.id, video_id: row.video_id, status: row.status, stage: row.stage,
    created_at: row.created_at, updated_at: row.updated_at, source: model?.transport === 'remote_api' ? 'server' : 'local',
    model,
    ...result, ...(row.error_code ? { error: { code: row.error_code, message: row.error_message } } : {}) };
}
