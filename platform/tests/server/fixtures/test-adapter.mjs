// TEST FIXTURE ONLY. Never use this adapter in an application deployment.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
export async function createAdapter({ modelDir, registerProcess }) {
  const mode = JSON.parse(await readFile(path.join(modelDir, 'fixture-mode.json'), 'utf8')).mode;
  let ready = false;
  return {
    metadata: { name: 'TEST FIXTURE — not a trained model', version: 'test-only' },
    async load() { if (mode === 'load-error') throw Error('fixture'); ready = true; },
    isReady() { return ready; },
    async predict({ signal }) {
      if (mode === 'owned-child') {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
        const release = registerProcess(child.pid); child.on('exit', release);
        await writeFile(path.join(modelDir, 'child.pid'), String(child.pid));
        await new Promise(() => {});
      }
      if (mode === 'loses-ready') ready = false;
      if (mode === 'timeout') { await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })); }
      if (mode === 'error') throw Error('Private failure information must not reach HTTP clients.');
      if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 100));
      if (mode === 'invalid') return { verdict: 'violation', violations: [] };
      if (mode === 'review') return { verdict: 'review_required', review_required: true, violations: [],
        observed_events: [{ task: 'handover', type: 'Передача предмета', timecode_sec: 1, start_sec: 0, end_sec: 2,
          description: 'Synthetic action fixture, not a violation.', evidence_frames: [{ timestamp_sec: 1,
            image_base64: (await readFile(new URL('./evidence.jpg', import.meta.url))).toString('base64') }] }],
        warnings: ['TEST FIXTURE ONLY'], analysis: { coverage: { complete: true, duration_sec: 2,
          candidate_windows: 1, analyzed_windows: 1, sampled_frames: 4, note: 'Sampled frames only.' } } };
      if (mode === 'violation') return { verdict: 'violation', violations: [{ type: 'fixture_event', timecode_sec: 1.5,
        description: 'Synthetic test evidence, not a real video analysis.', evidence_frames: [{ timestamp_sec: 1.5,
          image_base64: (await readFile(new URL('./evidence.jpg', import.meta.url))).toString('base64') }],
        rule_refs: [{ title: 'Synthetic fixture reference', section: null, url: 'https://example.com/reference', verified: false }] }] };
      return { verdict: 'no_violation', violations: [], warnings: ['TEST FIXTURE ONLY'] };
    },
  };
}
