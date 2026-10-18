import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getConfig } from './config.js';
import { ApiError, missing } from './errors.js';
import { openStore, videoDTO, jobDTO } from './storage.js';
import { createAuth } from './auth.js';
import { receiveVideo } from './uploads.js';
import { readRegulatoryCatalog } from './regulatory-catalog.js';
import { ModelConnectionManager } from './remote-model.js';
import { BatchManager } from './batches.js';
import { receiveArchive } from './archives.js';
import { createBatchReport } from './batch-report.js';

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function createApp(overrides = {}) {
  const config = getConfig(overrides), store = openStore(config), auth = createAuth(config);
  const model = new ModelConnectionManager(config, store), app = express(), quota = { bytes: 0 };
  const batches = new BatchManager(config, store, model), archiveImports = new Map();
  let closed = false;
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (config.publicOrigin?.startsWith('https:')) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use('/api', auth.protectOrigin, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', express.json({ limit: '8kb', strict: true }));
  app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok', service: 'vision-forte', model: model.state, timestamp: new Date().toISOString() }));
  app.get('/api/v1/capabilities', (req, res) => res.json({ formats: ['.mov', '.mp4'], max_upload_bytes: config.maxUploadBytes,
    archive: { formats: ['.zip'], max_upload_bytes: config.maxArchiveBytes, max_files: config.maxArchiveFiles, max_expanded_bytes: config.maxArchiveExpandedBytes },
    job_timeout_ms: config.jobTimeoutMs, model: model.state, authentication: { local_auto_session: auth.localAllowed(req) },
    features: { upload: true, preview: true, analysis: model.state.ready, batch_upload: true, batch_analysis: true, batch_export: true }, retention_days: config.retentionDays }));
  app.get('/api/v1/session', (req, res) => res.json({ authenticated: auth.authenticated(req), local_auto_session: auth.localAllowed(req) }));
  app.get('/api/v1/regulatory-sources', (_req, res) => res.json(readRegulatoryCatalog(config)));
  app.post('/api/v1/session', auth.login);
  app.delete('/api/v1/session', auth.logout);
  app.use('/api/v1', auth.requireAuth);
  app.get('/api/v1/model/connection', (_req, res) => res.json(model.connectionState));
  app.put('/api/v1/model/connection', async (req, res) => res.json(await model.connect(req.body, config.publicOrigin || `http://${req.headers.host}`)));
  app.post('/api/v1/model/connection/check', async (_req, res) => res.json(await model.check()));
  app.delete('/api/v1/model/connection', async (_req, res) => res.json(await model.disconnect()));
  const uploadAttempts = new Map();
  function limitUploads(req, _res, next) {
    const ip = req.socket.remoteAddress, now = Date.now();
    for (const [key, value] of uploadAttempts) if (value.until < now) uploadAttempts.delete(key);
    const value = uploadAttempts.get(ip) || { count: 0, until: now + 3600000 };
    value.count++; uploadAttempts.set(ip, value);
    if (value.count > 60) return next(new ApiError(429, 'RATE_LIMITED', 'Лимит загрузок исчерпан. Повторите позже.'));
    next();
  }
  const videoFor = (id) => {
    if (!uuidPattern.test(id)) throw missing();
    const row = store.getVideo(id);
    if (!row || store.db.prepare('SELECT 1 FROM archive_pending_videos WHERE video_id=?').get(id)) throw missing();
    return row;
  };
  app.post('/api/v1/batches', limitUploads, async (req, res) => {
    if (closed) throw new ApiError(503, 'SERVER_SHUTDOWN', 'Сервис остановлен. Повторите загрузку после запуска.');
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    const promise = receiveArchive(req, config, store, quota, batches, controller.signal);
    archiveImports.set(controller, promise);
    try { res.status(201).json({ batch: await promise }); }
    finally { archiveImports.delete(controller); res.off('close', abort); }
  });
  app.get('/api/v1/batches', (_req, res) => res.json({ batches: batches.list() }));
  app.get('/api/v1/batches/:id/report.xlsx', async (req, res) => {
    const batch = batches.dto(req.params.id), file = await createBatchReport(batch);
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="vision-forte-${batch.id}.xlsx"` });
    res.send(file);
  });
  app.get('/api/v1/batches/:id', (req, res) => res.json({ batch: batches.dto(req.params.id) }));
  app.post('/api/v1/batches/:id/analyze', (req, res) => res.status(202).json({ batch: batches.start(req.params.id, req.body || {}) }));
  app.post('/api/v1/videos', limitUploads, async (req, res) => {
    const { row } = await receiveVideo(req, config, store, quota);
    res.status(201).json({ video: videoDTO(row) });
  });
  app.get('/api/v1/videos', (req, res) => {
    const requested = Number(req.query.limit || 20);
    if (!Number.isInteger(requested) || requested < 1 || requested > 100) throw new ApiError(400, 'INVALID_LIMIT', 'Лимит списка: от 1 до 100.');
    const rows = store.db.prepare('SELECT * FROM videos WHERE id NOT IN (SELECT video_id FROM archive_pending_videos) ORDER BY created_at DESC LIMIT ?').all(requested);
    res.json({ videos: rows.map(videoDTO), total: Number(store.db.prepare('SELECT COUNT(*) AS total FROM videos WHERE id NOT IN (SELECT video_id FROM archive_pending_videos)').get().total) });
  });
  app.get('/api/v1/videos/:id/content', async (req, res) => {
    const row = videoFor(req.params.id), size = row.size_bytes, file = store.videoPath(row.id);
    if (!fs.existsSync(file)) throw new ApiError(410, 'VIDEO_UNAVAILABLE', 'Исходный видеофайл отсутствует в хранилище.');
    const etag = `"${row.sha256}"`;
    res.set({ 'Content-Type': row.mime_type, 'Accept-Ranges': 'bytes', ETag: etag,
      'Content-Disposition': `inline; filename="video${row.mime_type === 'video/mp4' ? '.mp4' : '.mov'}"; filename*=UTF-8''${encodeURIComponent(row.original_name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`)}` });
    let start = 0, end = size - 1;
    if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      const invalidRange = () => { res.set('Content-Range', `bytes */${size}`); throw new ApiError(416, 'INVALID_RANGE', 'Диапазон видео недоступен.'); };
      if (!match || (!match[1] && !match[2])) invalidRange();
      if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) invalidRange(); start = Math.max(0, size - suffix); }
      else { start = Number(match[1]); end = match[2] ? Number(match[2]) : end; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) invalidRange();
      end = Math.min(end, size - 1); res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.set('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return res.end();
    try { await pipeline(fs.createReadStream(file, { start, end }), res); } catch (e) { if (!req.destroyed && !res.destroyed) throw e; }
  });
  app.get('/api/v1/videos/:id', (req, res) => {
    const row = videoFor(req.params.id);
    const latest = store.db.prepare('SELECT * FROM jobs WHERE video_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(row.id);
    res.json({ video: videoDTO(row), latest_job: latest ? jobDTO(latest) : null });
  });
  app.delete('/api/v1/videos/:id', (req, res) => {
    const row = videoFor(req.params.id);
    if (store.videoInPendingBatch(row.id) || store.db.prepare("SELECT 1 FROM jobs WHERE video_id=? AND status='processing'").get(row.id)) throw new ApiError(409, 'VIDEO_BUSY', 'Видео находится в очереди или обрабатывается. Дождитесь завершения проверки перед удалением.');
    store.deleteVideo(row.id); res.status(204).end();
  });
  app.post('/api/v1/videos/:id/analyze', (req, res) => res.status(202).json(model.submit(videoFor(req.params.id))));
  app.post('/api/v1/analyze', limitUploads, async (req, res) => {
    model.assertReady();
    if (model.tasks.size >= config.maxPendingJobs) throw new ApiError(429, 'QUEUE_FULL', 'Очередь анализа заполнена. Повторите позже.');
    const { row } = await receiveVideo(req, config, store, quota);
    try { res.status(202).json(model.submit(row)); }
    catch (error) { if (error instanceof ApiError) error.details = { video_id: row.id }; throw error; }
  });
  app.get('/api/v1/jobs/:id', (req, res) => {
    if (!uuidPattern.test(req.params.id)) throw missing();
    const job = store.getJob(req.params.id); if (!job) throw missing(); res.json(jobDTO(job));
  });
  app.use('/api', (_req, _res, next) => next(missing()));
  app.use(express.static(config.publicDir, { dotfiles: 'deny', index: false, maxAge: 0 }));
  app.get('/{*path}', (_req, res, next) => {
    const entry = path.join(config.publicDir, 'index.html');
    if (!fs.existsSync(entry)) return next(new ApiError(503, 'FRONTEND_NOT_BUILT', 'Интерфейс ещё не собран. Выполните npm run build.'));
    res.set('Cache-Control', 'no-cache').sendFile(entry);
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof ApiError ? error.status : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
    const code = error instanceof ApiError ? error.code : status === 413 ? 'REQUEST_TOO_LARGE' : status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
    const message = error instanceof ApiError ? error.message : status === 500 ? 'Внутренняя ошибка сервиса. Повторите попытку.' : 'Запрос имеет неверный формат.';
    res.status(status).json({ error: { code, message, ...(error instanceof ApiError && error.details ? { details: error.details } : {}) } });
  });
  const cleanupTimer = setInterval(() => store.cleanup(), 3600000); cleanupTimer.unref();
  const close = async () => {
    if (closed) return; closed = true; clearInterval(cleanupTimer); batches.close();
    for (const controller of archiveImports.keys()) controller.abort();
    await Promise.allSettled([...archiveImports.values()]);
    await model.close(); batches.reconcile(); store.close();
  };
  return { app, config, store, model, batches, close };
}
