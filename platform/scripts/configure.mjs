import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function configure() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath) && !process.env.FORTE_API_KEY) {
    fs.writeFileSync(envPath, [
      '# Created for this local installation. Keep this file private.',
      'HOST=127.0.0.1', 'PORT=3001', 'LOCAL_AUTO_SESSION=true',
      `FORTE_API_KEY=${randomBytes(32).toString('hex')}`,
      'MAX_UPLOAD_MB=100', 'MAX_STORAGE_MB=4096', 'RETENTION_DAYS=7',
      'JOB_TIMEOUT_MS=1260000', 'MODEL_LOAD_TIMEOUT_MS=60000',
      'MAX_CONCURRENT_JOBS=1', 'MAX_PENDING_JOBS=2', '',
    ].join('\n'), { mode: 0o600, flag: 'wx' });
    console.log('Создана локальная конфигурация .env. Ключ остаётся на этом компьютере.');
  }
  dotenv.config({ path: envPath, quiet: true });
}
