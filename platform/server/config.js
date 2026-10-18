import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const isLoopback = (host) => ['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(host);
function int(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error('Invalid numeric server configuration.');
  return n;
}
export function getConfig(overrides = {}, env = process.env) {
  const config = {
    host: env.HOST || '127.0.0.1', port: int(env.PORT, 3000, 0, 65535),
    apiKey: env.FORTE_API_KEY || '', localAutoSession: env.LOCAL_AUTO_SESSION === 'true',
    dataDir: path.resolve(env.DATA_DIR || path.join(rootDir, 'data')),
    publicDir: path.join(rootDir, 'dist'),
    regulatoryPath: path.join(rootDir, 'data', 'regulatory-sources.json'),
    maxUploadBytes: int(env.MAX_UPLOAD_MB, 300, 1, 2048) * 1000000,
    maxArchiveBytes: int(env.MAX_ARCHIVE_MB, 500, 1, 2048) * 1000000,
    maxArchiveFiles: int(env.MAX_ARCHIVE_FILES, 100, 1, 500),
    maxArchiveExpandedBytes: int(env.MAX_ARCHIVE_EXPANDED_MB, 2048, 1, 102400) * 1000000,
    maxStorageBytes: int(env.MAX_STORAGE_MB, 4096, 1, 102400) * 1000000,
    jobTimeoutMs: int(env.JOB_TIMEOUT_MS, 300000, 100, 1260000),
    modelLoadTimeoutMs: int(env.MODEL_LOAD_TIMEOUT_MS, 60000, 100, 300000),
    maxConcurrentJobs: int(env.MAX_CONCURRENT_JOBS, 1, 1, 4),
    maxPendingJobs: int(env.MAX_PENDING_JOBS, 10, 1, 100),
    retentionDays: int(env.RETENTION_DAYS, 7, 1, 365),
    modelModule: env.MODEL_ADAPTER_MODULE ? path.resolve(env.MODEL_ADAPTER_MODULE) : null,
    modelDir: path.resolve(env.MODEL_DIR || path.join(rootDir, 'models')),
    ffprobePath: env.FORTE_FFPROBE_PATH || env.FFPROBE_PATH || null,
    ffmpegPath: env.FORTE_FFMPEG_PATH || env.FFMPEG_PATH || 'ffmpeg',
    sessionTtlMs: 8 * 60 * 60 * 1000,
    publicOrigin: env.PUBLIC_ORIGIN || null,
    ...overrides,
  };
  if (typeof config.apiKey !== 'string' || config.apiKey.length < 24) throw new Error('FORTE_API_KEY must contain at least 24 characters. Generate a random key and save it in .env.');
  if (config.localAutoSession && !isLoopback(config.host)) throw new Error('LOCAL_AUTO_SESSION requires a loopback HOST.');
  if (config.publicOrigin) {
    const url = new URL(config.publicOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== config.publicOrigin) throw new Error('PUBLIC_ORIGIN must be an exact http(s) origin without path.');
    if (!isLoopback(config.host) && url.protocol !== 'https:') throw new Error('Public access requires an HTTPS PUBLIC_ORIGIN.');
  }
  if (!isLoopback(config.host) && !config.publicOrigin) throw new Error('A public HOST requires PUBLIC_ORIGIN with HTTPS and a TLS reverse proxy.');
  return config;
}
