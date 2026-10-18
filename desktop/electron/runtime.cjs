// Runs as a Node child using the Node runtime bundled with Electron.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const resources = process.env.VISION_RESOURCES;
  const dataDir = process.env.VISION_DATA_DIR;
  const apiKey = process.env.VISION_SESSION_KEY;
  if (!resources || !dataDir || !apiKey || !process.send) throw new Error('Invalid desktop runtime configuration');
  // Do not load any inherited .env or local model adapter in installed apps.
  for (const name of ['MODEL_ADAPTER_MODULE', 'MODEL_DIR', 'PUBLIC_ORIGIN', 'FORTE_API_KEY']) delete process.env[name];
  const { startServer } = await import(pathToFileURL(path.join(resources, 'server/index.js')).href);
  const binary = (name) => path.join(resources, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const runtime = await startServer({
    host: '127.0.0.1', port: 0, localAutoSession: true, apiKey,
    dataDir, publicDir: path.join(resources, 'dist'),
    regulatoryPath: path.join(resources, 'data/regulatory-sources.json'),
    ffmpegPath: binary('ffmpeg'), ffprobePath: binary('ffprobe'),
    modelModule: null, publicOrigin: null,
    maxUploadBytes: 100000000, maxArchiveBytes: 500000000,
    maxArchiveFiles: 100, maxArchiveExpandedBytes: 2048000000,
    maxStorageBytes: 4096000000, jobTimeoutMs: 1260000,
    maxConcurrentJobs: 1, maxPendingJobs: 2,
  });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await runtime.stop(); process.exit(0); };
  process.on('message', (message) => { if (message?.type === 'shutdown') void stop(); });
  process.once('disconnect', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  process.send({ type: 'ready', origin: `http://127.0.0.1:${runtime.server.address().port}` });
})().catch(() => { console.error('Vision Forte runtime startup failed.'); process.exit(1); });
