/**
 * Files written by hand, in the shapes people actually write them.
 *
 * The store is advertised as hand-editable YAML, and each of these is a thing
 * somebody typed that the app then either crashed on or quietly changed: a
 * number for an id, a stray `-`, `sections:` as a mapping, `status: Applied`,
 * a bullet written as one line of text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { syncCurrent } from '../src/model/current.js';
import { normalizeStatus } from '../src/model/normalize.js';
import { resolveResume } from '../src/model/resolve.js';
import { parseSnapshot } from '../src/model/snapshot.js';
import type { Application, Entry } from '../src/model/types.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
beforeEach(() => {
  t = makeTempStore();
});
afterEach(() => t.cleanup());

const raw = (rel: string) => YAML.parse(fs.readFileSync(path.join(t.dir, rel), 'utf8')) as unknown[];

const NUMERIC = `- id: 2024
  kind: experience
  title: Acme
  bullets:
    - id: b_one
      default: v1
      variants:
        - id: v1
          label: Only
          text: Did things
`;

describe('an entry file with a number for an id', () => {
  /*
   * YAML makes `id: 2024` a number, and saveEntry compared it with `===`
   * against the string the load had made of it — so the save appended a second
   * copy, `loadEntries` showed the first, and the edit was gone.
   */
  it('saves over the entry rather than beside it', () => {
    t.write('experience.yaml', NUMERIC);
    const entry = t.store.load().entries.find((e) => e.id === '2024')!;
    t.store.saveEntry({ ...entry, title: 'Acme Corp' });

    const list = raw('experience.yaml') as Entry[];
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('Acme Corp');
    expect(t.store.load().entries.find((e) => e.id === '2024')?.title).toBe('Acme Corp');
  });

  it('deletes it', () => {
    t.write('experience.yaml', NUMERIC);
    expect(t.store.deleteEntry('2024')).toBe(true);
    expect(raw('experience.yaml')).toEqual([]);
  });

  // A stray `-` is a null item, and reading `.id` off it threw.
  it('saves and deletes past a blank item in the list', () => {
    t.write('experience.yaml', `-\n${NUMERIC}`);
    t.write('projects.yaml', `-\n`);
    const entry = t.store.load().entries.find((e) => e.id === '2024')!;
    expect(() => t.store.saveEntry({ ...entry, title: 'Acme Corp' })).not.toThrow();
    expect((raw('experience.yaml') as (Entry | null)[]).filter(Boolean).map((e) => e!.title)).toEqual(['Acme Corp']);
    expect(() => t.store.deleteEntry('2024')).not.toThrow();
    expect(t.store.load().entries.some((e) => e.id === '2024')).toBe(false);
  });
});

describe('a resume whose sections were edited by hand', () => {
  const resume = (sections: string) => t.write('resumes/hand.yaml', `label: Hand\ntier: extended\nsections:\n${sections}`);

  /*
   * Each of these threw out of `Store.load()` — "sections is not iterable",
   * "Cannot read properties of null" — and took every screen down with it,
   * naming neither the resume nor the file.
   */
  it('reads `sections` written as a mapping', () => {
    resume('  experience:\n    entries: [exp_acme]\n');
    const data = t.store.load();
    expect(data.resumes.find((r) => r.id === 'hand')?.sections).toMatchObject([
      { kind: 'experience', entries: ['exp_acme'] },
    ]);
    expect(resolveResume('hand', data).sections[0]?.entries.map((e) => e.id)).toEqual(['exp_acme']);
  });

  it('skips a blank section', () => {
    resume('  -\n  - kind: experience\n    entries: [exp_acme]\n');
    const data = t.store.load();
    expect(data.resumes.find((r) => r.id === 'hand')?.sections).toHaveLength(1);
    expect(() => resolveResume('hand', data)).not.toThrow();
  });

  it('reads a bullet list left empty as no list', () => {
    resume('  - kind: experience\n    entries: [exp_acme]\n    bullets:\n      exp_acme:\n');
    const data = t.store.load();
    const all = (data.entries.find((e) => e.id === 'exp_acme')!.bullets ?? []).filter((b) => !b.archived).length;
    expect(resolveResume('hand', data).sections[0]?.entries[0]?.bullets).toHaveLength(all);
  });

  // Version history rebuilds the same files from old commits.
  it('rebuilds a past version of one without throwing', () => {
    const files = new Map([
      ['resumes/a.yaml', 'label: A\nsections:\n  experience:\n    entries: [x]\n'],
      ['resumes/b.yaml', 'label: B\nsections:\n  -\n  - kind: experience\n    entries: [x]\n    bullets:\n      x:\n'],
    ]);
    const snap = parseSnapshot(files);
    expect(snap.resumes.map((r) => r.sections?.length)).toEqual([1, 1]);
  });
});

describe('an application status typed by hand', () => {
  // `status: Applied` read as interested, and the next save wrote that back.
  it('is read whatever its case', () => {
    expect(normalizeStatus('Applied')).toBe('applied');
    expect(normalizeStatus(' OFFER ')).toBe('offer');
    expect(normalizeStatus('Rejected')).toBe('closed');

    t.write('applications.yaml', '- id: x\n  company: C\n  role: R\n  status: Interview\n');
    expect(t.store.load().applications[0]?.status).toBe('interview');
  });
});

describe('a bullet written as a line of text', () => {
  const ENTRY = `- id: exp_plain
  kind: experience
  title: Plain Co
  bullets:
    - Built the thing
    - id: b_short
      text: Wrote it the short way
`;

  /*
   * Both were filtered out as not being bullets, and the next save of the
   * entry wrote the list back without them.
   */
  it('becomes a bullet with one wording, and survives a save', () => {
    t.write('experience.yaml', ENTRY);
    const entry = t.store.load().entries.find((e) => e.id === 'exp_plain')!;
    const bullets = entry.bullets ?? [];
    expect(bullets.map((b) => b.variants.map((v) => v.text))).toEqual([
      ['Built the thing'],
      ['Wrote it the short way'],
    ]);
    expect(bullets[1]).toMatchObject({ id: 'b_short', default: 'v_1', variants: [{ id: 'v_1' }] });

    // The id a string gets holds still from one read to the next…
    const id = bullets[0]!.id;
    expect(id).toMatch(/^b_[0-9a-f]{8}$/);
    t.write('experience.yaml', ENTRY + '\n');
    expect(t.store.load().entries.find((e) => e.id === 'exp_plain')!.bullets?.[0]?.id).toBe(id);

    // …and is written down by the first save, along with the words.
    t.store.saveEntry({ ...entry, title: 'Plain Co.' });
    const saved = (raw('experience.yaml') as Entry[]).find((e) => e.id === 'exp_plain')!.bullets ?? [];
    expect(saved.map((b) => b.id)).toEqual([id, 'b_short']);
    expect(saved.map((b) => b.variants[0]?.text)).toEqual(['Built the thing', 'Wrote it the short way']);
    expect(saved[1]).not.toHaveProperty('text');
  });
});

describe('the upload folder', () => {
  /*
   * Two bundles holding `Resume.pdf` and a third holding `Resume-Intern.pdf`.
   * The suffixes were checked against each other only, so the intern's copy of
   * the first was named after the third — and one of the two was dropped.
   */
  it('does not rename a file onto a name another one already has', () => {
    const out = t.store.outDir();
    const bundle = (id: string, name: string, body: string) => {
      fs.mkdirSync(path.join(out, 'applications', id), { recursive: true });
      fs.writeFileSync(path.join(out, 'applications', id, name), body);
      return `applications/${id}`;
    };
    const apps = [
      { id: 'a', company: 'X', role: 'Intern', status: 'applying', snapshotDir: bundle('a', 'Resume.pdf', 'A'), appliedAt: '2026-10-01' },
      { id: 'b', company: 'Y', role: 'Engineer', status: 'applying', snapshotDir: bundle('b', 'Resume.pdf', 'B'), appliedAt: '2026-10-02' },
      { id: 'c', company: 'Z', role: 'Other', status: 'applying', snapshotDir: bundle('c', 'Resume-Intern.pdf', 'C'), appliedAt: '2026-10-03' },
    ] as unknown as Application[];

    const result = syncCurrent(t.store, apps);
    const bodies = result.files.map((f) => fs.readFileSync(path.join(result.dir, f), 'utf8')).sort();
    expect(bodies).toEqual(['A', 'B', 'C']);
    expect(result.belongsTo?.['Resume-Intern.pdf']).toBe('c');
  });
});
