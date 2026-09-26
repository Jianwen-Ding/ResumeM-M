import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flattenOne, flattenResumes, needsFlattening } from '../src/model/flatten.js';
import { resolveResume } from '../src/model/resolve.js';
import { Store } from '../src/model/store.js';
import { makeTempStore } from './helpers.js';
import { RESUME_IDS, writeInheritedStore } from './fixtures/inherited-store.js';
import goldenFile from './fixtures/pre-flatten-documents.json';
import type { ResumeSpec, SectionSpec, StoreData } from '../src/model/types.js';

/** The documents the old code produced, by resume id. See below for why. */
const golden = goldenFile as Record<string, unknown>;

/*
 * Folding an older save's inheritance away, without changing a single
 * document.
 *
 * Resumes used to inherit: a variation recorded `extends: base` and a handful
 * of overrides, and what it actually contained was worked out at render time.
 * They stand alone now, and a save on disk can be any age — so every store is
 * folded flat on the way in.
 *
 * That migration has exactly one promise to keep. Nobody asked for their
 * resumes to be rewritten; it happens because the program changed underneath
 * them, and a person who opens the editor after an upgrade has every right to
 * see what they saw before. So the tests that matter here are not about the
 * shape of the YAML. They are about what comes out of the renderer, before
 * and after, being the same thing.
 */

let temp: ReturnType<typeof makeTempStore>;

beforeEach(() => {
  temp = makeTempStore();
});
afterEach(() => temp.cleanup());

/** Everything that reaches the page, as one comparable value. */
function printed(spec: ResumeSpec, data: StoreData) {
  const r = resolveResume(spec, data);
  // `growBounds` came after these were recorded, so the oracle cannot have
  // it. It is how large auto-fit may go, not anything the fold decides.
  const { growBounds: _growBounds, ...layout } = r.layout;
  return {
    label: r.label,
    profile: r.profile,
    layout,
    sections: r.sections,
  };
}

/*
 * The only check that actually pins the promise, and the reason it is built
 * this way.
 *
 * The obvious test — resolve each resume before the fold and after it, and
 * compare — proves nothing at all, because both sides run the same fold: the
 * resolver still folds a spec that arrives carrying `extends`, so a bug in
 * the fold appears identically on both sides and the assertion passes.
 * Breaking `mergeSections` so a child's sections replace its base's outright
 * — which empties a section and is exactly the failure this is guarding
 * against — did not fail that test.
 *
 * So the expected documents were produced by the *old* code, in a worktree of
 * the last commit where resumes still inherited, and committed. They are an
 * oracle this code cannot influence. `tests/fixtures/inherited-store.ts`
 * writes the store both sides read, so the only difference between the two
 * runs is the program.
 */
describe('a resume still prints what it printed before the fold', () => {
  it.each(RESUME_IDS)('%s', (id) => {
    const dir = writeInheritedStore(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-flatten-')),
    );
    try {
      const store = new Store(dir);
      // `loadResumes` folds on the way in, so this is today's flat resume —
      // resolved by a resolver that no longer has a merge to fall back on.
      const data = store.load();
      expect(data.resumes.find((r) => r.id === id)?.extends, 'still inheriting').toBeUndefined();
      expect(printed(data.resumes.find((r) => r.id === id)!, data)).toEqual(golden[id]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('and still prints it after the files themselves are rewritten', () => {
    const dir = writeInheritedStore(fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-flatten-')));
    try {
      const store = new Store(dir);
      store.migrateResumes();
      const data = store.load();
      for (const id of RESUME_IDS) {
        expect(printed(data.resumes.find((r) => r.id === id)!, data), id).toEqual(golden[id]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('folding an inherited save flat', () => {
  it('writes the files back, and says which it touched', () => {
    const { flattened, problems } = temp.store.migrateResumes();

    expect(flattened.sort()).toEqual(['intern', 'newgrad']);
    // `base` was not folded — it never inherited — but it is rewritten all
    // the same, because the same pass gives every resume a tier.
    expect(problems).toEqual([]);
    // On disk, not only in memory: the point of the writing pass.
    expect(temp.read('resumes/newgrad.yaml')).not.toHaveProperty('extends');
    expect(temp.read('resumes/newgrad.yaml')).toHaveProperty('copiedFrom', 'base');
  });

  it('does nothing at all to a save that is already flat', () => {
    temp.store.migrateResumes();
    const untouched = temp.read('resumes/newgrad.yaml');

    // The second pass is the one every start after the first makes.
    expect(temp.store.migrateResumes()).toEqual({ flattened: [], tiered: [], lifted: [], problems: [] });
    expect(temp.read('resumes/newgrad.yaml')).toEqual(untouched);
  });

  it('keeps the child’s own answer where it and its base disagreed', () => {
    temp.write('resumes/base.yaml', {
      id: 'base',
      label: 'Base resume',
      choices: { 'edu_neu.dates': 'v_may2026', 'exp_acme.title': 'v_long' },
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
    });
    temp.write('resumes/newgrad.yaml', {
      id: 'newgrad',
      label: 'New grad',
      extends: 'base',
      choices: { 'edu_neu.dates': 'v_dec2026' },
    });

    temp.store.migrateResumes();

    const child = temp.store.getResume('newgrad');
    expect(child?.choices?.['edu_neu.dates']).toBe('v_dec2026'); // its own
    expect(child?.choices?.['exp_acme.title']).toBe('v_long'); // the base's, kept
  });

  /*
   * What the base *was*, as opposed to what it contained, must not come down
   * the chain. Every one of these went wrong once, in the code that folded a
   * deleted base into its children: a variation with no label of its own took
   * the base's, leaving two resumes with one name; every variation of a
   * pinned base came back pinned; and a resume made for one posting came back
   * claiming it was written for another.
   */
  it('does not hand the base’s identity to its children', () => {
    temp.write('resumes/base.yaml', {
      id: 'base',
      label: 'Base resume',
      base: true,
      notes: 'The one I keep up to date.',
      generatedFor: { company: 'Somewhere Else', role: 'Something Else' },
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
    });
    temp.write('resumes/child.yaml', { id: 'child', label: 'Child', extends: 'base' });

    temp.store.migrateResumes();

    const child = temp.store.getResume('child');
    expect(child?.label).toBe('Child');
    expect(child?.base).toBeUndefined();
    expect(child?.notes).toBeUndefined();
    expect(child?.generatedFor).toBeUndefined();
    // And what it did contain came across.
    expect(child?.sections?.[0]?.entries).toEqual(['edu_neu']);
  });

  it('records where a resume came from, now that nothing merges behind it', () => {
    temp.store.migrateResumes();
    expect(temp.store.getResume('newgrad')?.copiedFrom).toBe('base');
    expect(temp.store.getResume('newgrad')?.extends).toBeUndefined();
    // A root was never copied from anything, and does not acquire a source.
    expect(temp.store.getResume('base')?.copiedFrom).toBeUndefined();
  });
});

/*
 * A save on disk can hold anything — the folder is advertised as editable
 * YAML, and a store can be cloned, restored from history, or half-merged.
 * The migration is the code that exists to clean that up, so it is the one
 * piece that must not refuse to run.
 */
describe('a save that is already wrong when the fold reaches it', () => {
  it('drops a base that is not there, and says so, rather than throwing', () => {
    temp.write('resumes/orphan.yaml', { id: 'orphan', label: 'Orphan', extends: 'gone', choices: { a: 'x' } });

    const { flattened, problems } = temp.store.migrateResumes();

    expect(flattened).toContain('orphan');
    expect(problems.join(' ')).toMatch(/orphan/);
    expect(problems.join(' ')).toMatch(/gone/);
    const orphan = temp.store.getResume('orphan');
    expect(orphan?.extends).toBeUndefined();
    expect(orphan?.choices).toEqual({ a: 'x' }); // its own selections survive
  });

  it('breaks a loop and keeps the resume, rather than leaving it unopenable', () => {
    // The shape a real store arrived in: a resume tailored for a posting,
    // handed itself as the base to build from.
    temp.write('resumes/selfy.yaml', { id: 'selfy', label: 'Selfy', extends: 'selfy', choices: { a: 'x' } });

    const { problems } = temp.store.migrateResumes();

    expect(problems.join(' ')).toMatch(/selfy/);
    expect(problems.join(' ')).toMatch(/itself/i);
    expect(temp.store.getResume('selfy')?.extends).toBeUndefined();
    expect(temp.store.getResume('selfy')?.choices).toEqual({ a: 'x' });
  });

  it('breaks a longer loop too, and leaves every resume in it readable', () => {
    temp.write('resumes/a.yaml', { id: 'a', label: 'A', extends: 'b', choices: { one: '1' } });
    temp.write('resumes/b.yaml', { id: 'b', label: 'B', extends: 'a', choices: { two: '2' } });

    temp.store.migrateResumes();

    const all = temp.store.loadResumes();
    expect(all.find((r) => r.id === 'a')?.extends).toBeUndefined();
    expect(all.find((r) => r.id === 'b')?.extends).toBeUndefined();
    // Each keeps its own answer, and picks up the other's where it had none —
    // which is what the resolver did with this store, so it is what prints.
    expect(all.find((r) => r.id === 'a')?.choices).toMatchObject({ one: '1', two: '2' });
  });

  it('one bad resume does not stop the rest from being folded', () => {
    temp.write('resumes/orphan.yaml', { id: 'orphan', label: 'Orphan', extends: 'gone' });

    const { flattened } = temp.store.migrateResumes();

    expect(flattened).toContain('newgrad');
    expect(flattened).toContain('intern');
  });
});

describe('reading a store that has not been written back yet', () => {
  it('folds on the way in, so nothing downstream ever sees a base', () => {
    // No `migrateResumes` call: this is a server that started against a store
    // it has no permission to rewrite, or one hand-edited underneath it.
    for (const r of temp.store.loadResumes()) expect(r.extends, r.id).toBeUndefined();
  });

  it('and the resume still prints what it printed', () => {
    const raw = temp.store.loadResumesAsWritten();
    const data = temp.store.load();
    const rawData = { ...data, resumes: raw };

    for (const spec of raw) {
      const folded = data.resumes.find((r) => r.id === spec.id)!;
      expect(printed(folded, data), spec.id).toEqual(printed(spec, rawData));
    }
  });
});

describe('knowing whether there is anything to do', () => {
  it('says no for a save that never inherited', () => {
    expect(needsFlattening([{ id: 'a', label: 'A' }])).toBe(false);
  });

  it('says yes for one that did', () => {
    expect(needsFlattening([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', extends: 'a' }])).toBe(true);
  });

  it('hands back the very same array when there is nothing to do', () => {
    // Not a copy: `loadResumes` runs this on every read, and a store a year of
    // applying has filled up is not a thing to clone for no reason.
    const flat = [{ id: 'a', label: 'A' }];
    expect(flattenResumes(flat)).toBe(flat);
  });
});

describe('folding one resume on its own', () => {
  it('leaves a resume that never inherited untouched', () => {
    const solo: ResumeSpec = { id: 'solo', label: 'Solo', choices: { a: 'x' } };
    expect(flattenOne(solo, [solo])).toEqual(solo);
  });

  it('lays the child’s sections over the base’s rather than replacing them', () => {
    /*
     * The rule the whole merge existed for, and the one a fold has to keep:
     * a child that mentions only bullets still shows the base's entries. Get
     * this wrong and the migration empties a section — the document changes,
     * which is the one thing it may not do.
     */
    const base: ResumeSpec = {
      id: 'base',
      label: 'Base',
      sections: [{ kind: 'experience', entries: ['e1', 'e2'] }],
    };
    const child: ResumeSpec = {
      id: 'child',
      label: 'Child',
      extends: 'base',
      sections: [{ kind: 'experience', entries: undefined, bullets: { e1: ['b2', 'b1'] } } as unknown as SectionSpec],
    };

    const flat = flattenOne(child, [base, child]);

    expect(flat.sections?.[0]?.entries).toEqual(['e1', 'e2']);
    expect(flat.sections?.[0]?.bullets).toEqual({ e1: ['b2', 'b1'] });
  });

  it('does not let a child’s one custom section swallow the other', () => {
    /*
     * Two `custom` sections — "Awards" and "Leadership" — and a child that
     * re-states only Awards. Matching on kind alone replaced both, so the
     * document printed Awards twice and Leadership was silently gone.
     */
    const base: ResumeSpec = {
      id: 'base',
      label: 'Base',
      sections: [
        { kind: 'custom', heading: 'Awards', entries: ['a1'] },
        { kind: 'custom', heading: 'Leadership', entries: ['l1'] },
      ],
    };
    const child: ResumeSpec = {
      id: 'child',
      label: 'Child',
      extends: 'base',
      sections: [{ kind: 'custom', heading: 'Awards', entries: ['a1', 'a2'] }],
    };

    const flat = flattenOne(child, [base, child]);

    expect(flat.sections?.map((s) => s.heading)).toEqual(['Awards', 'Leadership']);
    expect(flat.sections?.[1]?.entries).toEqual(['l1']);
  });

  it('leaves the specs it was handed alone', () => {
    // It runs on every read of the store. A fold that wrote into the cached
    // spec objects would corrupt them one read at a time.
    const base: ResumeSpec = { id: 'base', label: 'Base', choices: { a: 'x' }, sections: [{ kind: 'education', entries: ['e'] }] };
    const child: ResumeSpec = { id: 'child', label: 'Child', extends: 'base', choices: { b: 'y' } };
    const baseBefore = structuredClone(base);
    const childBefore = structuredClone(child);

    flattenOne(child, [base, child]);

    expect(base).toEqual(baseBefore);
    expect(child).toEqual(childBefore);
  });
});
