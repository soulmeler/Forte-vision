import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import Busboy from 'busboy';
import { ApiError } from './errors.js';
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export function supportedContainer(header) {
  if (header.length < 12) return false;
  let offset = 0;
  while (offset + 12 <= header.length && offset < 65500) {
    const size = header.readUInt32BE(offset);
    const type = header.toString('ascii', offset + 4, offset + 8);
    if (type === 'ftyp') {
      const brand = header.toString('ascii', offset + 8, offset + 12);
      return size >= 16 && /^(qt  |isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/.test(brand);
    }
    if (!['wide', 'free', 'skip'].includes(type) || size < 8 || offset + size > header.length) return false;
    offset += size;
  }
  return false;
}

export async function probe(filePath, config, signal) {
  let binary = config.ffprobePath;
  if (binary !== false && !binary) { try { binary = require('ffprobe-static').path; } catch { /* metadata remains unknown */ } }
  if (binary) {
    try {
      const { stdout } = await execFileAsync(binary, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, signal });
      const result = JSON.parse(stdout);
      const video = result.streams?.find((stream) => stream.codec_type === 'video');
      if (!video) throw new ApiError(422, 'NO_VIDEO_TRACK', 'Файл не содержит видеодорожку.');
      const duration = Number(result.format?.duration || video.duration);
      return { duration: Number.isFinite(duration) && duration > 0 ? duration : null, width: video.width || null,
        height: video.height || null, codec: video.codec_name || null,
        hasAudio: result.streams.some((stream) => stream.codec_type === 'audio') ? 1 : 0, source: 'ffprobe' };
    } catch (e) {
      if (signal?.aborted) throw new ApiError(400, 'UPLOAD_ABORTED', 'Загрузка архива прервана.');
      if (e instanceof ApiError) throw e;
      if (e.code !== 'ENOENT' && e.code !== 'EACCES') throw new ApiError(422, 'INVALID_VIDEO', 'Видеоконтейнер повреждён или не читается. Выберите другой файл.');
    }
  }
  return { duration: null, width: null, height: null, codec: null, hasAudio: null, source: null };
}

export async function receiveVideo(req, config, store, quota) {
  if (!/^multipart\/form-data(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'MULTIPART_REQUIRED', 'Отправьте видео как multipart/form-data в поле file.');
  if (Number(req.headers['content-length']) > config.maxUploadBytes + 65536) throw new ApiError(413, 'FILE_TOO_LARGE', 'Размер файла превышает лимит сервиса.');
  const id = randomUUID(), tempPath = path.join(store.tempDir, `${id}.upload`);
  let parser;
  try { parser = Busboy({ headers: req.headers, defParamCharset: 'utf8', preservePath: true, limits: { files: 1, fields: 0, parts: 2, fileSize: config.maxUploadBytes + 1, headerPairs: 100 } }); }
  catch { throw new ApiError(400, 'INVALID_MULTIPART', 'Не удалось прочитать форму загрузки.'); }
  let error, task, fileCount = 0, size = 0, name, digest;
  const hash = createHash('sha256'), headerParts = [];
  let headerLength = 0;
  const fail = (e) => { error ||= e; };
  const parsed = new Promise((resolve, reject) => {
    parser.on('file', (field, stream, info) => {
      // Rejected streams are drained without pipeline; they still need an error
      // listener because an aborted multipart request destroys every file stream.
      stream.on('error', (cause) => fail(cause));
      fileCount++;
      name = info.filename;
      if (field !== 'file' || !name || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name)) { fail(new ApiError(400, 'INVALID_FILE_NAME', 'Используйте поле file с обычным именем файла.')); stream.resume(); return; }
      if (!['.mov', '.mp4'].includes(path.extname(name).toLowerCase())) { fail(new ApiError(415, 'UNSUPPORTED_FORMAT', 'Поддерживаются видео MOV и MP4.')); stream.resume(); return; }
      stream.on('limit', () => fail(new ApiError(413, 'FILE_TOO_LARGE', 'Размер файла превышает лимит сервиса.')));
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        if (size + chunk.length > config.maxUploadBytes) return callback(new ApiError(413, 'FILE_TOO_LARGE', 'Размер файла превышает лимит сервиса.'));
        if (store.sizeUsed() + quota.bytes + chunk.length > config.maxStorageBytes) return callback(new ApiError(507, 'STORAGE_LIMIT', 'Хранилище заполнено. Удалите ненужные видео.'));
        size += chunk.length; quota.bytes += chunk.length; hash.update(chunk);
        if (headerLength < 65536) { const part = chunk.subarray(0, 65536 - headerLength); headerParts.push(part); headerLength += part.length; }
        callback(null, chunk);
      } });
      task = pipeline(stream, meter, fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })).catch((cause) => {
        fail(cause.code === 'ENOSPC' ? new ApiError(507, 'STORAGE_LIMIT', 'На диске закончилось место. Удалите ненужные видео.') : cause);
        req.unpipe(parser); parser.destroy(error); req.resume();
      });
    });
    parser.on('filesLimit', () => fail(new ApiError(400, 'ONE_FILE_REQUIRED', 'Загрузите один файл за запрос.')));
    parser.on('fieldsLimit', () => fail(new ApiError(400, 'INVALID_MULTIPART', 'Допускается только поле file.')));
    parser.on('partsLimit', () => fail(new ApiError(400, 'ONE_FILE_REQUIRED', 'Загрузите один файл за запрос.')));
    parser.once('error', () => reject(error || new ApiError(400, 'INVALID_MULTIPART', 'Загрузка прервана или форма повреждена.')));
    parser.once('close', resolve);
    req.once('aborted', () => { parser.destroy(); reject(new ApiError(400, 'UPLOAD_ABORTED', 'Загрузка прервана.')); });
    req.pipe(parser);
  });
  let moved = false;
  try {
    await parsed;
    await task;
    if (error) throw error;
    if (fileCount !== 1 || !task) throw new ApiError(400, 'FILE_REQUIRED', 'Добавьте один видеофайл в поле file.');
    if (!supportedContainer(Buffer.concat(headerParts))) throw new ApiError(415, 'INVALID_CONTAINER', 'Файл не является поддерживаемым MOV или MP4 контейнером.');
    digest = hash.digest('hex');
    const meta = await probe(tempPath, config);
    const created = new Date().toISOString();
    await fsp.rename(tempPath, store.videoPath(id)); moved = true;
    store.db.prepare('INSERT INTO videos (id,original_name,size_bytes,mime_type,sha256,created_at,duration_sec,width,height,codec,has_audio,metadata_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, size, path.extname(name).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4', digest, created,
        meta.duration, meta.width, meta.height, meta.codec, meta.hasAudio, meta.source);
    return { row: store.getVideo(id) };
  } catch (e) {
    if (task) await task;
    await fsp.rm(tempPath, { force: true });
    if (moved) await fsp.rm(store.videoPath(id), { force: true });
    throw e;
  } finally { quota.bytes = Math.max(0, quota.bytes - size); }
}
