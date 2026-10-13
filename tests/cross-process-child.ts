/**
 * The other process, for `cross-process-writes.test.ts`: a second program
 * writing the same save as the server under test, the way the `rmm` CLI does
 * — through its own `Store`, with its own read cache, in its own process.
 *
 *   tsx tests/cross-process-child.ts <save> apps <n>     file n tracker rows, as `rmm apply` does
 *   tsx tests/cross-process-child.ts <save> config <n>   set ai.model n times, as `rmm config set` does,
 *                                                        and count the ones gone by the next turn
 *   tsx tests/cross-process-child.ts <save> hold <ms>    take the save's lock and sit on it
 *   tsx tests/cross-process-child.ts <save> take <ms>    try to take it, waiting at most <ms>
 *
 * Prints one line of JSON when it is done.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Store } from '../src/model/store.js';

const [root, mode, count] = process.argv.slice(2) as [string, string, string];
const n = Number(count);
const store = new Store(root);
const pause = new Int32Array(new SharedArrayBuffer(4));
const nap = (ms: number) => Atomics.wait(pause, 0, 0, ms);

if (mode === 'apps') {
  for (let i = 0; i < n; i++) {
    store.upsertApplication({
      id: `cli-${i}`,
      company: `Cli${i}`,
      role: 'Dev',
      status: 'applied',
      appliedAt: '2026-10-12T00:00:00.000Z',
      history: [{ at: '2026-10-12T00:00:00.000Z', status: 'applied', note: 'Bundle created' }],
    });
    nap(Math.random() * 4);
  }
  console.log(JSON.stringify({ done: n }));
} else if (mode === 'config') {
  let lost = 0;
  const onDisk = () =>
    (YAML.parse(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8')) as { ai?: { model?: string } }).ai?.model;
  for (let i = 0; i < n; i++) {
    if (i > 0 && onDisk() !== `m${i - 1}`) lost++;
    store.saveConfig({ ai: { model: `m${i}` } as never });
    nap(2 + Math.random() * 4);
  }
  nap(50);
  if (onDisk() !== `m${n - 1}`) lost++;
  console.log(JSON.stringify({ done: n, lost }));
} else if (mode === 'hold') {
  const { holdSaveSync } = await import('../src/model/save-lock.js');
  holdSaveSync(root, () => {
    console.log(JSON.stringify({ holding: process.pid }));
    nap(n);
  });
} else if (mode === 'take') {
  const { SaveLock, holdSaveSync } = await import('../src/model/save-lock.js');
  SaveLock.WAIT_MS = n;
  const started = Date.now();
  try {
    holdSaveSync(root, () => undefined);
    console.log(JSON.stringify({ took: true, waited: Date.now() - started }));
  } catch (err) {
    console.log(JSON.stringify({ took: false, waited: Date.now() - started, error: (err as Error).message }));
  }
}
