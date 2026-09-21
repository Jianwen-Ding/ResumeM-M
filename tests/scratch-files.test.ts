/*
 * Two saves at once, and the history that quietly stopped recording.
 *
 * Every write to the store goes out through `Store.writeAtomic`: a scratch
 * file `.rmm-<uuid>.tmp` beside the target, fsynced, then renamed over it.
 * One per save, in `resumes/` and `letters/` and the store root.
 *
 * Auto-commit stages the store with `git add -- .`, which walks the tree and
 * stats what it finds — and a second save finishing during that walk takes
 * its scratch file away between the readdir and the stat:
 *
 *   fatal: unable to stat 'resumes/.rmm-fb6b0e43-…-5eb7148d587c.tmp':
 *   No such file or directory
 *
 * git aborts the whole add, so the commit never happens. Nothing is lost from
 * disk and the editor goes on saying "All changes saved", because that is
 * true; what stops is the history, and "restore this version", the diff
 * between two resumes and the sweep are all built on it. Measured before the
 * ignore: nine of forty commits, with one save looping.
 *
 * When the walk wins the race instead, the scratch file is committed —
 * quieter, deterministic, and the case the first test here pins down.
 *
 * The `.rmm-building-` folders were already ignored for exactly this reason, one
 * directory up and for the rarer case of two bundles being built at once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
let repo: Repo;

beforeEach(async () => {
  t = makeTempStore({ config: { ai: { enabled: false }, git: { autoCommit: true }, output: { dir: 'out' } } });
  repo = Repo.forStore(t.dir);
  await repo.ensure();
});

afterEach(() => t.cleanup());

/** Every path the newest commit touched. */
const lastCommitFiles = () =>
  execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: t.dir, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);

describe('a save that is still in flight when another one commits', () => {
  it('is not committed as a file of its own', async () => {
    fs.writeFileSync(path.join(t.dir, 'resumes', '.rmm-2f1c4e-half.tmp'), 'half a resume\n');
    fs.writeFileSync(path.join(t.dir, 'resumes', 'extra.yaml'), 'id: extra\nlabel: Extra\nsections: []\n');

    await repo.commitAll('Add extra');
    expect(lastCommitFiles()).toEqual(['resumes/extra.yaml']);
  });

  /*
   * And a save that already exists gets told, which is the half that matters:
   * the stores needing this are the ones with a year of history in them, and
   * `ensure` returns early on a store that is already a repository. The
   * migration is the next commit finding the entry missing and appending it,
   * so this is a fresh `Repo` over an old store — a server starting up.
   */
  it('and a save written before any of this learns to, on its next commit', async () => {
    const at = path.join(t.dir, '.gitignore');
    fs.writeFileSync(at, '# mine\nout/scratch/\n', 'utf8');

    const restarted = Repo.forStore(t.dir);
    fs.writeFileSync(path.join(t.dir, 'resumes', '.rmm-abc-half.tmp'), 'half\n');
    fs.writeFileSync(path.join(t.dir, 'resumes', 'another.yaml'), 'id: another\nlabel: A\nsections: []\n');
    await restarted.commitAll('Add another');

    const lines = fs.readFileSync(at, 'utf8').split('\n');
    expect(lines).toContain('.rmm-*.tmp');
    // Without disturbing what was already in it: this file is the user's.
    expect(lines).toContain('# mine');
    expect(lines).toContain('out/scratch/');
    // And the scratch file did not ride in on the commit that added the line.
    expect(lastCommitFiles()).not.toContain('resumes/.rmm-abc-half.tmp');
  });

  /*
   * The expensive half, driven rather than argued: one save looping while
   * commits happen, which is an ordinary afternoon with the editor open in
   * two windows or the extension building while somebody types.
   *
   * Asserting on the commits rather than on git's stderr, because what is
   * wrong is not the message — it is that an edit made it to disk and never
   * made it into the history.
   */
  it('does not stop the history recording', { timeout: 120_000 }, async () => {
    const dir = path.join(t.dir, 'resumes');
    for (let i = 0; i < 400; i++) {
      fs.writeFileSync(path.join(dir, `bulk${i}.yaml`), `id: bulk${i}\nlabel: B\nsections: []\n`);
    }
    await repo.commitAll('bulk');

    let stop = false;
    const saving = (async () => {
      let n = 0;
      while (!stop) {
        const temp = path.join(dir, `.rmm-${randomUUID()}.tmp`);
        fs.writeFileSync(temp, `id: live${n % 8}\nlabel: L\nsections: []\n`);
        fs.renameSync(temp, path.join(dir, `live${n % 8}.yaml`));
        n++;
        await new Promise((go) => setImmediate(go));
      }
      return n;
    })();

    let missed = 0;
    try {
      for (let round = 0; round < 40; round++) {
        fs.writeFileSync(path.join(dir, `edit${round}.yaml`), `id: edit${round}\nlabel: E\nsections: []\n`);
        const hash = await repo.commitAll(`Update ${round}`).catch(() => undefined);
        if (!hash) missed++;
      }
    } finally {
      stop = true;
      await saving;
    }
    expect(missed).toBe(0);
  });
});
