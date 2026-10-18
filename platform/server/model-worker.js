import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

let adapter, controller, shuttingDown = false;
const startupController = new AbortController();
const registerProcess = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid owned process id.');
  parentPort.postMessage({ type: 'owned_process', pid });
  return () => parentPort.postMessage({ type: 'release_process', pid });
};
parentPort.on('message', async (message) => {
  if (message.type === 'cancel') { controller?.abort(); return; }
  if (message.type === 'shutdown') {
    shuttingDown = true; startupController.abort(); controller?.abort();
    try { await adapter?.close?.(); } catch { /* parent terminates the worker regardless */ }
    parentPort.postMessage({ type: 'closed' }); return;
  }
  if (message.type !== 'predict' || !adapter || shuttingDown) return;
  controller = new AbortController();
  try {
    if ((await adapter.isReady()) !== true) { parentPort.postMessage({ type: 'error', id: message.id, code: 'MODEL_NOT_READY' }); return; }
    const result = await adapter.predict({ videoPath: message.videoPath, video: message.video, signal: controller.signal });
    parentPort.postMessage({ type: 'result', id: message.id, result });
  } catch {
    parentPort.postMessage({ type: 'error', id: message.id, code: 'MODEL_ERROR' });
  } finally { controller = null; }
});
try {
  const module = await import(pathToFileURL(workerData.modulePath).href);
  if (typeof module.createAdapter !== 'function') throw Error('Model module must export createAdapter.');
  adapter = await module.createAdapter({ modelDir: workerData.modelDir, signal: startupController.signal, registerProcess });
  if (!adapter || !['load', 'isReady', 'predict'].every((method) => typeof adapter[method] === 'function')) throw Error('Adapter must define load, isReady and predict.');
  await adapter.load({ signal: startupController.signal });
  if (shuttingDown) throw Error('Worker is shutting down.');
  if ((await adapter.isReady()) !== true) throw Error('Adapter reports not ready.');
  const raw = adapter.metadata || {};
  const metadata = { name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : null,
    version: typeof raw.version === 'string' ? raw.version.slice(0, 80) : null,
    supported_categories: Array.isArray(raw.supported_categories) ? raw.supported_categories.filter((s) => typeof s === 'string').slice(0, 100) : [] };
  parentPort.postMessage({ type: 'ready', metadata });
} catch {
  parentPort.postMessage({ type: 'init_error' });
}
