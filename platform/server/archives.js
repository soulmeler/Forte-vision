import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import yauzl from 'yauzl';
import { ApiError } from './errors.js';
import { probe, supportedContainer } from './uploads.js';

const unsafe = () => new ApiError(400, 'UNSAFE_ARCHIVE', 'Архив содержит небезопасные пути, ссылки или зашифрованные файлы. Создайте обычный ZIP с видео.');
const corrupt = () => new ApiError(422, 'INVALID_ARCHIVE', 'ZIP-архив повреждён или не поддерживается. Создайте архив заново.');
const full = () => new ApiError(507, 'STORAGE_LIMIT', 'Для архива и распакованных видео недостаточно места. Удалите ненужные записи.');
const expanded = () => new ApiError(413, 'ARCHIVE_EXPANDED_LIMIT', 'Распакованный архив превышает допустимый размер. Разделите записи на несколько архивов.');
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0;
});
function updateCrc(crc, chunk) { for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc; }
function safeEntry(entry) {
  const name = entry.fileName;
  if (!name || name.length > 1024 || /[\x00-\x1f\x7f\\]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part === '.')) throw unsafe();
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if ((type && ![0o100000, 0o040000].includes(type)) || (entry.generalPurposeBitFlag & 1)) throw unsafe();
  if (![0, 8].includes(entry.compressionMethod) || !Number.isSafeInteger(entry.uncompressedSize) || !Number.isSafeInteger(entry.compressedSize)) throw corrupt();
  return name.endsWith('/') || name.split('/').some(part => part === '__MACOSX') || path.posix.basename(name) === '.DS_Store';
}
async function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(corrupt()) : resolve(zip)));
}
async function inventory(zip, config, signal) {
  return new Promise((resolve, reject) => {
    const entries = []; let count = 0, total = 0;
    const finish = error => { zip.off('entry', onEntry); zip.off('end', onEnd); zip.off('error', onError); signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(entries); };
    const onError = () => finish(corrupt());
    const onAbort = () => finish(new ApiError(400, 'UPLOAD_ABORTED', 'Загрузка архива прервана.'));
    const onEnd = () => finish();
    const onEntry = entry => {
      try {
        count++;
        if (count > config.maxArchiveFiles * 4 + 20) throw new ApiError(413, 'ARCHIVE_FILE_LIMIT', 'В архиве слишком много файлов и каталогов.');
        const skip = safeEntry(entry);
        total += entry.uncompressedSize;
        if (total > config.maxArchiveExpandedBytes || !Number.isSafeInteger(total)) throw expanded();
        if (!skip) entries.push(entry);
        if (entries.length > config.maxArchiveFiles) throw new ApiError(413, 'ARCHIVE_FILE_LIMIT', `В одном архиве допускается до ${config.maxArchiveFiles} файлов.`);
        zip.readEntry();
      } catch (error) { finish(error); }
    };
    zip.on('entry', onEntry); zip.once('end', onEnd); zip.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort(); else zip.readEntry();
  });
}

async function receiveZip(req, config, store, quota, signal) {
  if (!/^multipart\/form-data(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'MULTIPART_REQUIRED', 'Отправьте ZIP-архив в поле file.');
  if (Number(req.headers['content-length']) > config.maxArchiveBytes + 65536) throw new ApiError(413, 'ARCHIVE_TOO_LARGE', 'Размер ZIP-архива превышает лимит.');
  const file = path.join(store.tempDir, `${randomUUID()}.upload`);
  let parser;
  try { parser = Busboy({ headers: req.headers, preservePath: true, defParamCharset: 'utf8', limits: { files: 1, fields: 0, parts: 2, fileSize: config.maxArchiveBytes + 1, headerPairs: 100 } }); }
  catch { throw new ApiError(400, 'INVALID_MULTIPART', 'Не удалось прочитать форму загрузки.'); }
  let error, task, name, size = 0, files = 0;
  const fail = cause => { error ||= cause; };
  const abort = () => {
    fail(new ApiError(400, 'UPLOAD_ABORTED', 'Загрузка архива прервана.'));
    req.unpipe(parser); parser.destroy(error); req.resume();
  };
  const parsed = new Promise((resolve, reject) => {
    parser.on('file', (field, stream, info) => {
      files++; name = info.filename;
      stream.on('error', fail);
      if (field !== 'file' || !name || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name)) { fail(new ApiError(400, 'INVALID_FILE_NAME', 'Используйте поле file с обычным именем ZIP-архива.')); stream.resume(); return; }
      if (path.extname(name).toLowerCase() !== '.zip') { fail(new ApiError(415, 'UNSUPPORTED_ARCHIVE', 'Поддерживаются архивы ZIP.')); stream.resume(); return; }
      stream.on('limit', () => fail(new ApiError(413, 'ARCHIVE_TOO_LARGE', 'Размер ZIP-архива превышает лимит.')));
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        if (size + chunk.length > config.maxArchiveBytes) return callback(new ApiError(413, 'ARCHIVE_TOO_LARGE', 'Размер ZIP-архива превышает лимит.'));
        if (store.sizeUsed() + quota.bytes + chunk.length > config.maxStorageBytes) return callback(full());
        size += chunk.length; quota.bytes += chunk.length; callback(null, chunk);
      } });
      task = pipeline(stream, meter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal }).catch(cause => {
        fail(cause.code === 'ENOSPC' ? full() : cause.name === 'AbortError' ? new ApiError(400, 'UPLOAD_ABORTED', 'Загрузка архива прервана.') : cause);
        req.unpipe(parser); parser.destroy(error); req.resume();
      });
    });
    parser.on('filesLimit', () => fail(new ApiError(400, 'ONE_FILE_REQUIRED', 'Загрузите один ZIP-архив.')));
    parser.on('fieldsLimit', () => fail(new ApiError(400, 'INVALID_MULTIPART', 'Допускается только поле file.')));
    parser.on('partsLimit', () => fail(new ApiError(400, 'ONE_FILE_REQUIRED', 'Загрузите один ZIP-архив.')));
    parser.once('error', () => reject(error || new ApiError(400, 'INVALID_MULTIPART', 'Загрузка прервана или форма повреждена.')));
    parser.once('close', resolve);
    req.once('aborted', () => { parser.destroy(); reject(new ApiError(400, 'UPLOAD_ABORTED', 'Загрузка архива прервана.')); });
    req.pipe(parser);
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await parsed; await task;
    if (error) throw error;
    if (files !== 1 || !task) throw new ApiError(400, 'FILE_REQUIRED', 'Добавьте ZIP-архив в поле file.');
    return { file, size, name };
  } catch (cause) {
    await task; await fsp.rm(file, { force: true }); quota.bytes = Math.max(0, quota.bytes - size); throw cause;
  } finally { signal?.removeEventListener('abort', abort); }
}

async function extractVideo(zip, entry, config, store, quota, state, signal) {
  const id = randomUUID(), temp = path.join(store.tempDir, `${id}.upload`);
  const name = path.posix.basename(entry.fileName), hash = createHash('sha256');
  let size = 0, crc = 0xffffffff, header = Buffer.alloc(0), moved = false;
  try {
    const source = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(corrupt()) : resolve(stream)));
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      if (size + chunk.length > config.maxUploadBytes) return callback(new ApiError(413, 'FILE_TOO_LARGE', 'Видео превышает допустимый размер одного файла.'));
      if (state.expanded + chunk.length > config.maxArchiveExpandedBytes) return callback(expanded());
      if (store.sizeUsed() + quota.bytes + chunk.length > config.maxStorageBytes) return callback(full());
      size += chunk.length; state.expanded += chunk.length; quota.bytes += chunk.length;
      hash.update(chunk); crc = updateCrc(crc, chunk);
      if (header.length < 65536) header = Buffer.concat([header, chunk.subarray(0, 65536 - header.length)]);
      callback(null, chunk);
    } });
    await pipeline(source, meter, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
    if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw corrupt();
    if (!supportedContainer(header)) throw new ApiError(415, 'INVALID_CONTAINER', 'Файл не является поддерживаемым MOV или MP4 контейнером.');
    const meta = await probe(temp, config, signal);
    if (signal?.aborted) throw new ApiError(400, 'UPLOAD_ABORTED', 'Загрузка архива прервана.');
    await fsp.rename(temp, store.videoPath(id)); moved = true;
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.db.prepare('INSERT INTO videos (id,original_name,size_bytes,mime_type,sha256,created_at,duration_sec,width,height,codec,has_audio,metadata_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, name, size, path.extname(name).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4', hash.digest('hex'), new Date().toISOString(), meta.duration, meta.width, meta.height, meta.codec, meta.hasAudio, meta.source);
      store.db.prepare('INSERT INTO archive_pending_videos(video_id) VALUES (?)').run(id);
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    return id;
  } catch (error) {
    if (moved) await fsp.rm(store.videoPath(id), { force: true });
    throw error;
  } finally { await fsp.rm(temp, { force: true }); quota.bytes = Math.max(0, quota.bytes - size); }
}

export async function receiveArchive(req, config, store, quota, batches, signal) {
  const upload = await receiveZip(req, config, store, quota, signal);
  const created = [], items = []; let zip, committed = false;
  try {
    zip = await openZip(upload.file);
    const entries = await inventory(zip, config, signal);
    // Keep a listener while extracting: yauzl may emit errors independently of
    // an entry stream. The stream error is handled below without process exit.
    let zipError; zip.on('error', () => { zipError = corrupt(); });
    if (!entries.length) throw new ApiError(422, 'EMPTY_ARCHIVE', 'В архиве нет файлов для обработки.');
    const state = { expanded: 0 };
    for (const entry of entries) {
      if (signal?.aborted) throw new ApiError(400, 'UPLOAD_ABORTED', 'Загрузка архива прервана.');
      if (zipError) throw zipError;
      const item = { original_name: entry.fileName, video_id: null, error: null };
      if (!['.mp4', '.mov'].includes(path.extname(entry.fileName).toLowerCase())) item.error = { code: 'UNSUPPORTED_FORMAT', message: 'Файл пропущен: поддерживаются только видео MOV и MP4.' };
      else if (path.posix.basename(entry.fileName).length > 255) item.error = { code: 'INVALID_FILE_NAME', message: 'Имя видео длиннее 255 символов.' };
      else if (entry.uncompressedSize > config.maxUploadBytes) item.error = { code: 'FILE_TOO_LARGE', message: 'Видео превышает допустимый размер одного файла.' };
      else {
        try { item.video_id = await extractVideo(zip, entry, config, store, quota, state, signal); created.push(item.video_id); }
        catch (error) {
          if (!(error instanceof ApiError) || ['UNSAFE_ARCHIVE', 'INVALID_ARCHIVE', 'ARCHIVE_EXPANDED_LIMIT', 'STORAGE_LIMIT', 'UPLOAD_ABORTED'].includes(error.code)) throw error;
          item.error = { code: error.code, message: error.message };
        }
      }
      items.push(item);
    }
    if (zipError) throw zipError;
    const batch = batches.create(upload.name, items); committed = true; return batch;
  } catch (error) {
    if (!committed) for (const id of created) store.deleteVideo(id);
    if (error.code === 'ENOSPC') throw full();
    if (error.name === 'AbortError') throw new ApiError(400, 'UPLOAD_ABORTED', 'Загрузка архива прервана.');
    throw error instanceof ApiError ? error : corrupt();
  } finally {
    zip?.close(); await fsp.rm(upload.file, { force: true }); quota.bytes = Math.max(0, quota.bytes - upload.size);
  }
}
