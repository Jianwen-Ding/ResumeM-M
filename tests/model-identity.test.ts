import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeSections, resolveResume } from '../src/model/resolve.js';
import type { Entry, SectionSpec } from '../src/model/types.js';
import { makeTempStore } from './helpers.js';

/*
 * Four ways the store could hold two of something, or hide one, and the
 * document you print disagreed with the document you were looking at.
 */

let temp: ReturnType<typeof makeTempStore>;

beforeEach(() => {
  temp = makeTempStore();
});
afterEach(() => temp.cleanup());

describe('an entry that changes kind', () => {
  /*
   * Entries are split across four files by kind, so changing the kind moves the
   * entry between files. Writing the new one without removing the old left the
   * same id in two files at once; `load()` concatenates them with no dedupe and
   * `resolveResume` takes the first match — which for education → project is
   * the stale copy. The master document showed the edit, the PDF that went to
   * the employer showed the old title and the old bullets.
   */
  it('exists in exactly one place afterwards', () => {
    const before = temp.store.load().entries.filter((e) => e.id === 'edu_neu');
    expect(before).toHaveLength(1);

    temp.store.saveEntry({ ...(before[0] as Entry), kind: 'project', title: 'Capstone' });

    const after = temp.store.load().entries.filter((e) => e.id === 'edu_neu');
    expect(after).toHaveLength(1);
    expect(after[0]?.kind).toBe('project');
    expect(after[0]?.title).toBe('Capstone');
  });

  it('is what the rendered resume prints, not the copy left behind', () => {
    const entry = temp.store.load().entries.find((e) => e.id === 'edu_neu') as Entry;
    temp.store.saveEntry({ ...entry, kind: 'project', title: 'Capstone' });

    temp.write('resumes/base.yaml', {
      id: 'base',
      label: 'Base',
      sections: [{ kind: 'project', entries: ['edu_neu'] }],
    });

    const resolved = resolveResume('base', temp.store.load());
    const titles = resolved.sections.flatMap((s) => s.entries.map((e) => e.title));
    expect(titles).toContain('Capstone');
    expect(titles).not.toContain('Northeastern University');
  });

  it('can still be deleted once it has moved', () => {
    const entry = temp.store.load().entries.find((e) => e.id === 'edu_neu') as Entry;
    temp.store.saveEntry({ ...entry, kind: 'project' });

    expect(temp.store.deleteEntry('edu_neu')).toBe(true);
    expect(temp.store.load().entries.some((e) => e.id === 'edu_neu')).toBe(false);
  });
});

describe('two resume files claiming one id', () => {
  /*
   * The comment always said the filename decides the id; the code preferred the
   * id written inside the file. Copy resumes/base.yaml to resumes/base-old.yaml
   * — an ordinary thing to do in a folder advertised as hand-editable — and the
   * copy sorted first and answered every lookup for `base`. Edits went to
   * base.yaml and appeared to be thrown away, and every child of `base`
   * resolved through the copy.
   */
  it('is two resumes, named for their files', () => {
    temp.write('resumes/base-old.yaml', { id: 'base', label: 'Old copy', sections: [] });

    const ids = temp.store.loadResumes().map((r) => r.id).sort();
    expect(ids).toEqual(['base', 'base-old', 'intern', 'newgrad']);
    expect(temp.store.getResume('base')?.label).toBe('Base resume');
    expect(temp.store.getResume('base-old')?.label).toBe('Old copy');
  });

  it('leaves the children of the real resume resolving through it', () => {
    temp.write('resumes/base-old.yaml', { id: 'base', label: 'Old copy', sections: [] });
    const resolved = resolveResume('newgrad', temp.store.load());
    expect(resolved.sections.length).toBeGreaterThan(0);
  });
});

describe('an archived entry', () => {
  /*
   * Archiving takes something out of circulation without throwing it away, and
   * everything honoured it — the master document, the pickers, the matcher, the
   * AI's view of the store — except the renderer. So an archived entry vanished
   * from every screen and went on being printed on every resume that listed it.
   */
  it('is left off the resume, and says so', () => {
    const entry = temp.store.load().entries.find((e) => e.id === 'exp_acme') as Entry;
    temp.store.saveEntry({ ...entry, archived: true });

    const resolved = resolveResume('base', temp.store.load());
    const titles = resolved.sections.flatMap((s) => s.entries.map((e) => e.title));
    expect(titles).not.toContain(entry.title);
    expect(resolved.warnings.join(' ')).toMatch(/exp_acme.*archived/i);
  });
});

describe('a child resume overriding one section', () => {
  const custom = (heading: string, entries: string[]): SectionSpec =>
    ({ kind: 'custom', heading, entries }) as SectionSpec;

  /*
   * `heading` exists so a store can have two custom sections. Matching on kind
   * alone replaced both of them with the one the child restated: Awards printed
   * twice, Leadership silently gone with its entries.
   */
  it('leaves the parent\'s other section of the same kind alone', () => {
    const merged = mergeSections(
      [custom('Awards', ['a1']), custom('Leadership', ['l1'])],
      [custom('Awards', ['a2'])],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((s) => s.heading)).toEqual(['Awards', 'Leadership']);
    expect(merged[0]?.entries).toEqual(['a2']);
    expect(merged[1]?.entries).toEqual(['l1']);
  });

  it('still replaces the parent section when the child does not repeat the heading', () => {
    // The ordinary case, and how this has always worked: a child listing
    // different entries under Experience replaces Experience, not adds to it.
    const merged = mergeSections(
      [{ kind: 'experience', heading: 'Work Experience', entries: ['e1'] } as SectionSpec],
      [{ kind: 'experience', entries: ['e2'] } as SectionSpec],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.entries).toEqual(['e2']);
  });

  it('lets a child rename the one section of its kind', () => {
    const merged = mergeSections(
      [custom('Additional', ['a1'])],
      [custom('Awards', ['a2'])],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.heading).toBe('Awards');
  });

  it('appends a section the parent never had', () => {
    const merged = mergeSections(
      [{ kind: 'education', entries: ['edu'] } as SectionSpec],
      [{ kind: 'project', entries: ['p'] } as SectionSpec],
    );
    expect(merged.map((s) => s.kind)).toEqual(['education', 'project']);
  });
});
