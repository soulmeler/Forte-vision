import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const staged = process.argv.includes('--staged');
const files = execFileSync('git', staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const knownSecrets = [];
// Also check for accidental copies of the developer's real local credentials.
for (const filename of ['.env', 'platform/.env']) {
  const full = path.join(root, filename);
  if (!fs.existsSync(full)) continue;
  for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([\w]*(?:KEY|TOKEN|SECRET|PASSWORD)[\w]*)\s*=\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/i.exec(line);
    if (match?.[2]?.length >= 16) knownSecrets.push(match[2]);
  }
}
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{25,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  // Long literal credentials; tests use deliberately synthetic credentials.
  /(?:api[_-]?key|password|secret|auth[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_+/=-]{32,}["']/i,
];
let failed = false;
for (const file of files) {
  let buffer;
  try { buffer = staged ? execFileSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 40 * 1024 * 1024 }) : fs.readFileSync(path.join(root, file)); } catch { continue; }
  const unsafePath = /(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials)(?:$|\/)/.test(file) && !file.endsWith('.env.example');
  const content = buffer.toString('utf8');
  const testFile = /(^|\/)tests\//.test(file);
  const matches = patterns.some((pattern, index) => (!testFile || index !== patterns.length - 1) && pattern.test(content));
  if (unsafePath || matches || knownSecrets.some((secret) => buffer.includes(secret))) {
    console.error(`Potential secret in ${file}; value redacted.`); failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`Secret scan passed: ${files.length} ${staged ? 'staged' : 'tracked'} files; no credentials detected.`);
