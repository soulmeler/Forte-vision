import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
export { createApp } from './app.js';

export async function startServer(overrides = {}) {
  const runtime = createApp(overrides);
  let server;
  try {
    server = runtime.app.listen(runtime.config.port, runtime.config.host);
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  } catch (error) {
    if (server?.listening) server.close();
    await runtime.close();
    throw error;
  }
  server.requestTimeout = 180000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;
  let stopping;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      const timeout = setTimeout(() => server.closeAllConnections(), 5000); timeout.unref();
      await closed; clearTimeout(timeout); await runtime.close();
    })();
    return stopping;
  }
  return { ...runtime, server, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtime = await startServer();
    console.log(`Vision Forte is available at http://${runtime.config.host}:${runtime.server.address().port}`);
    console.log('Model state:', runtime.model.state.status);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => runtime.stop().then(() => process.exit(0)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
