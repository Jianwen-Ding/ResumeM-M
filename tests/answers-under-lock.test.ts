/**
 * The answer bank, saved while another process holds the save's lock.
 *
 * `POST /answers/save` and `/voice/include` read the bank, then waited in
 * `withCommit` for the other process — `rmm`, a second server — to finish,
 * and wrote back the bank they had read: what the other process had written
 * to the same answer meanwhile was gone. Read, changed and written under the
 * lock now, the way every other read-modify-write is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { SaveLock } from '../src/model/save-lock.js';
import { makeTempStore, tempDir, type TempStore } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..');
const tsx = path.join(root, 'node_modules/.bin/tsx');

/*
 * The other process: takes the lock, holds it a while — long enough for the
 * request to start and wait on it — and then writes a phrasing and a tag of
 * its own onto answer `why` before letting go.
 */
const childDir = tempDir('rmm-answers-child-');
const child = path.join(childDir, 'child.ts');
fs.writeFileSync(
  child,
  `import { Store } from ${JSON.stringify(path.join(root, 'src/model/store.ts'))};
import { holdSaveSync } from ${JSON.stringify(path.join(root, 'src/model/save-lock.ts'))};
const [save, ms, mode] = process.argv.slice(2);
const store = new Store(save);
const pause = new Int32Array(new SharedArrayBuffer(4));
holdSaveSync(save, () => {
  console.log('holding');
  Atomics.wait(pause, 0, 0, Number(ms));
  if (mode === 'entry') {
    const entry = store.load().entries.find((e) => e.id === 'exp_acme');
    entry.bullets[0].variants.push({ id: 'v_cli', label: 'From the CLI', text: 'Written by the other process.' });
    store.saveEntry(entry);
    return;
  }
  const answers = store.loadAnswers();
  const why = answers.find((a) => a.id === 'why');
  why.variants.push({ id: 'v_cli', label: 'From the CLI', text: 'Written by the other process.' });
  why.tags = ['from-cli'];
  store.saveAnswers(answers);
});
console.log('done');
`,
  'utf8',
);

function otherProcessHolding(save: string, ms: number, mode = 'answers') {
  const proc = spawn(process.execPath, [tsx, child, save, String(ms), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  proc.stdout.on('data', (b) => (out += String(b)));
  proc.stderr.on('data', (b) => (err += String(b)));
  const done = new Promise<void>((resolve, reject) =>
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the other process failed: ${out}${err}`)))),
  );
  const holding = (async () => {
    while (!out.includes('holding')) {
      if (proc.exitCode !== null) throw new Error(`the other process never held the lock: ${out}${err}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  return { done, holding };
}

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore({ config: { git: { autoCommit: false } } });
  t.write('answers.yaml', [
    { id: 'why', question: 'Why do you want to work here?', default: 'v_1', variants: [{ id: 'v_1', label: 'Saved', text: 'Because.' }] },
  ]);
  app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  // Read once, as a running server has.
  t.store.load();
});

afterEach(() => t?.cleanup());

const why = () => (t.read('answers.yaml') as { id: string; tags?: string[]; voice?: boolean; variants: { id: string }[] }[]).find((a) => a.id === 'why')!;

describe('the answer bank under another process’s lock', () => {
  it('keeps what the other process wrote to the answer, and the phrasing saved here', async () => {
    const other = otherProcessHolding(t.store.root, 600);
    await other.holding;
    expect(fs.existsSync(SaveLock.where(t.store.root).lock)).toBe(true);
    await request(app)
      .post('/api/answers/save')
      .send({ question: 'Why do you want to work here?', answer: 'For the people.', label: 'Mine', itemId: 'why' })
      .expect(200);
    await other.done;
    const ids = why().variants.map((v) => v.id);
    expect(ids).toContain('v_cli');
    expect(ids).toContain('v_mine');
    expect(why().tags).toEqual(['from-cli']);
  }, 20_000);

  it('keeps it when an answer is taken out of the voice, too', async () => {
    const other = otherProcessHolding(t.store.root, 600);
    await other.holding;
    await request(app).post('/api/voice/include').send({ kind: 'answer', id: 'why', include: false }).expect(200);
    await other.done;
    expect(why().variants.map((v) => v.id)).toContain('v_cli');
    expect(why().voice).toBe(false);
  }, 20_000);

  it('keeps what the other process wrote to an entry, when a phrasing is added here', async () => {
    const other = otherProcessHolding(t.store.root, 600, 'entry');
    await other.holding;
    await request(app)
      .post('/api/entries/exp_acme/bullets/b_pipeline/variants')
      .send({ id: 'v_mine', label: 'Mine', text: 'Built it myself.' })
      .expect(200);
    await other.done;
    const entry = t.store.load().entries.find((e) => e.id === 'exp_acme')!;
    const ids = entry.bullets![0]!.variants.map((v) => v.id);
    expect(ids).toContain('v_cli');
    expect(ids).toContain('v_mine');
  }, 20_000);
});
