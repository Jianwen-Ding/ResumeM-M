import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { Store } from '../src/model/store.js';

/*
 * Not re-parsing the whole save on every call, and the two ways that could go
 * wrong.
 *
 * `load()` re-read and re-parsed every file each time it was called, and every
 * API route calls it. Measured on a store the size a year of applying
 * produces: 52ms at ten applications, 102ms at a hundred, 186ms at three
 * hundred, growing about half a millisecond per application. Asking the
 * filesystem what changed instead costs 2.2ms for nine hundred files, so the
 * parse is worth keeping.
 *
 * A cache over somebody's resume store has to answer two questions before it
 * is worth having, and neither is about speed:
 *
 *   - Does it notice a change it did not make? Hand-edited YAML is the point
 *     of this store being YAML. A git checkout, a second server, the `rmm`
 *     CLI, a restored snapshot — all of them write behind this process's back,
 *     and serving a stale copy after any of them is a data bug wearing a
 *     performance improvement's clothes.
 *   - Can a caller corrupt it? `load()` hands its result to forty callers and
 *     some of them treat it as theirs. Handing out the cached object itself
 *     would let one of them quietly rewrite what the next one reads.
 */

const stores: string[] = [];
afterEach(() => {
  for (const dir of stores.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function aStore(applications = 3): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-cache-'));
  stores.push(dir);
  fs.mkdirSync(path.join(dir, 'resumes'));
  fs.writeFileSync(path.join(dir, 'profile.yaml'), 'name: Someone\nemail: s@e.com\n');
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'ai:\n  enabled: false\n');
  fs.writeFileSync(path.join(dir, 'resumes', 'base.yaml'), 'id: base\nlabel: Base\nbase: true\n');
  fs.writeFileSync(
    path.join(dir, 'applications.yaml'),
    YAML.stringify(
      Array.from({ length: applications }, (_, i) => ({
        id: `2026-01-01-c${i}`,
        company: `Company ${i}`,
        role: 'Platform Engineer',
        status: 'applied',
        appliedAt: '2026-01-01T00:00:00Z',
      })),
    ),
  );
  return { store: new Store(dir), dir };
}

/** Rewrite a file the way something outside this process would. */
function editBehindItsBack(dir: string, rel: string, contents: string) {
  const f = path.join(dir, rel);
  fs.writeFileSync(f, contents);
  // Some filesystems keep whole-second mtimes, and the test would then be
  // asserting the clock rather than the cache. Push the time forward so the
  // change is unambiguous — the size check catches it either way.
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(f, later, later);
}

describe('reading a store more than once', () => {
  it('gives the same answer twice', () => {
    const { store } = aStore(3);
    expect(store.load().applications).toEqual(store.load().applications);
  });

  it('sees a file edited by hand', () => {
    const { store, dir } = aStore(3);
    expect(store.load().applications).toHaveLength(3);

    editBehindItsBack(
      dir,
      'applications.yaml',
      YAML.stringify([{ id: 'x', company: 'Only One', role: 'R', status: 'applied' }]),
    );
    const after = store.load().applications;
    expect(after).toHaveLength(1);
    expect(after[0]?.company).toBe('Only One');
  });

  /*
   * The case a modification time alone would miss: same file, same instant,
   * different length. Keyed on both, so it does not.
   */
  it('sees a change that keeps the modification time', () => {
    const { store, dir } = aStore(3);
    const f = path.join(dir, 'applications.yaml');
    const when = fs.statSync(f);
    expect(store.load().applications).toHaveLength(3);

    fs.writeFileSync(f, YAML.stringify([{ id: 'x', company: 'Shorter', role: 'R', status: 'applied' }]));
    fs.utimesSync(f, when.atime, when.mtime);

    expect(store.load().applications).toHaveLength(1);
  });

  it('sees a file appear, and sees one go away', () => {
    const { store, dir } = aStore(1);
    expect(store.load().resumes).toHaveLength(1);

    fs.writeFileSync(path.join(dir, 'resumes', 'second.yaml'), 'id: second\nlabel: Second\n');
    expect(store.load().resumes).toHaveLength(2);

    fs.rmSync(path.join(dir, 'resumes', 'second.yaml'));
    expect(store.load().resumes).toHaveLength(1);
  });

  it('sees a write made through the store itself', () => {
    const { store } = aStore(1);
    store.saveResume({ id: 'another', label: 'Another' });
    expect(store.load().resumes.map((r) => r.id)).toContain('another');
  });

  /*
   * The one that would be worst. Several callers treat what `load()` returns
   * as theirs — pushing onto the application list, sorting entries in place.
   * If that reached the cache, one route would quietly rewrite what the next
   * one reads, and nothing about it would look wrong from either end.
   */
  it('cannot be corrupted by a caller that edits what it was given', () => {
    const { store } = aStore(3);

    /*
     * Warmed first, deliberately. The first read is a miss and copies on its
     * way out whatever else is true, so mutating what it returns proves
     * nothing about the cache — which is exactly the hole the first version of
     * this test had: it passed against a build that handed out the cached
     * object on every hit.
     */
    store.load();
    const mine = store.load();
    mine.applications.push({ id: 'invented', company: 'Nobody', role: 'None', status: 'applied' });
    mine.applications[0]!.company = 'Overwritten';
    mine.profile.name = 'Someone Else';

    const fresh = store.load();
    expect(fresh.applications).toHaveLength(3);
    expect(fresh.applications[0]?.company).toBe('Company 0');
    expect(fresh.profile.name).toBe('Someone');
  });

  /*
   * The nested case, which is the one that can actually bite. The loaders
   * spread a parsed file into a new shape and that is a shallow copy, so a
   * section or a choices map stays shared with whatever it came from. One
   * route sorting a section in place would rewrite what the next route reads.
   */
  it('cannot be corrupted through something nested inside what it gave', () => {
    const { store, dir } = aStore(1);
    fs.writeFileSync(
      path.join(dir, 'resumes', 'tailored.yaml'),
      YAML.stringify({ id: 'tailored', label: 'Tailored', sections: [{ kind: 'experience', entries: ['a', 'b', 'c'] }] }),
    );

    store.load(); // warm, so the read below is a hit
    const mine = store.load().resumes.find((r) => r.id === 'tailored');
    mine!.sections![0]!.entries.reverse();
    mine!.sections!.push({ kind: 'project', entries: ['invented'] });

    const fresh = store.load().resumes.find((r) => r.id === 'tailored');
    expect(fresh?.sections).toHaveLength(1);
    expect(fresh?.sections?.[0]?.entries).toEqual(['a', 'b', 'c']);
  });

  it('gives each caller its own copy, not a shared one', () => {
    const { store } = aStore(2);
    store.load(); // warm, so both of the reads below are hits
    const a = store.load();
    const b = store.load();
    expect(a.applications).not.toBe(b.applications);
    a.applications[0]!.company = 'Changed';
    expect(b.applications[0]?.company).toBe('Company 0');
  });

  it('is not upset by a file that is not there at all', () => {
    const { store, dir } = aStore(1);
    fs.rmSync(path.join(dir, 'applications.yaml'));
    expect(store.load().applications).toEqual([]);
    // And notices when it comes back, as a restored snapshot would bring it.
    fs.writeFileSync(path.join(dir, 'applications.yaml'), YAML.stringify([{ id: 'r', company: 'Restored', role: 'R', status: 'applied' }]));
    expect(store.load().applications).toHaveLength(1);
  });

  it('does not confuse two stores that happen to be open at once', () => {
    const one = aStore(1);
    const two = aStore(5);
    expect(one.store.load().applications).toHaveLength(1);
    expect(two.store.load().applications).toHaveLength(5);
    expect(one.store.load().applications).toHaveLength(1);
  });
});
