import { describe, expect, it } from 'vitest';
import { buildMaster, flattenSpec, resolveResume } from '../src/model/resolve.js';
import type { Entry, ResumeSpec, StoreData } from '../src/model/types.js';
import { DEFAULT_CONFIG } from '../src/model/types.js';

const eduEntry: Entry = {
  id: 'edu',
  kind: 'education',
  title: 'Northeastern University',
  dates: {
    default: 'v_may',
    variants: [
      { id: 'v_may', label: 'May 2026', text: 'Sep. 2022 -- May 2026', tags: ['newgrad'] },
      { id: 'v_dec', label: 'Dec 2026', text: 'Sep. 2022 -- Dec. 2026', tags: ['intern'] },
    ],
  },
  bullets: [
    {
      id: 'b_course',
      default: 'v_broad',
      variants: [
        { id: 'v_broad', label: 'Broad', text: 'Algorithms, Databases' },
        { id: 'v_systems', label: 'Systems', text: 'Operating Systems, Networks', tags: ['systems'] },
      ],
    },
  ],
};

const expEntry: Entry = {
  id: 'exp',
  kind: 'experience',
  title: 'Example Co.',
  bullets: [
    { id: 'b_one', default: 'v1', variants: [{ id: 'v1', label: 'One', text: 'First bullet' }] },
    { id: 'b_two', default: 'v1', variants: [{ id: 'v1', label: 'Two', text: 'Second bullet' }] },
  ],
};

function store(resumes: ResumeSpec[]): StoreData {
  return {
    profile: { name: 'Test Person' },
    entries: [eduEntry, expEntry],
    skillGroups: [
      {
        id: 'sk',
        name: 'Languages',
        items: [
          { id: 's_py', text: 'Python' },
          { id: 's_ts', text: 'TypeScript' },
        ],
      },
    ],
    resumes,
    applications: [],
    coverLetters: [],
    drafts: [],
    answers: [],
    voice: '',
    config: DEFAULT_CONFIG,
  };
}

const base: ResumeSpec = {
  id: 'base',
  label: 'Base',
  sections: [
    { kind: 'education', entries: ['edu'] },
    { kind: 'experience', entries: ['exp'] },
    { kind: 'skills', entries: [], groups: ['sk'] },
  ],
};

describe('variant selection', () => {
  it('uses the default when a resume expresses no preference', () => {
    const r = resolveResume('base', store([base]));
    expect(r.sections[0]?.entries[0]?.dates).toBe('Sep. 2022 -- May 2026');
  });

  it('switches a field to the chosen variant', () => {
    const intern: ResumeSpec = { id: 'intern', label: 'Intern', extends: 'base', choices: { 'edu.dates': 'v_dec' } };
    const r = resolveResume('intern', store([base, intern]));
    expect(r.sections[0]?.entries[0]?.dates).toBe('Sep. 2022 -- Dec. 2026');
  });

  it('switches a bullet to the chosen variant', () => {
    const spec: ResumeSpec = { id: 's', label: 'S', extends: 'base', choices: { b_course: 'v_systems' } };
    const r = resolveResume('s', store([base, spec]));
    expect(r.sections[0]?.entries[0]?.bullets[0]?.text).toBe('Operating Systems, Networks');
  });

  it('is the only difference between new-grad and intern resumes', () => {
    // The point of the whole model: two resumes, one overridden field.
    const newgrad: ResumeSpec = { id: 'ng', label: 'NG', extends: 'base', choices: { 'edu.dates': 'v_may' } };
    const intern: ResumeSpec = { id: 'in', label: 'In', extends: 'base', choices: { 'edu.dates': 'v_dec' } };
    const data = store([base, newgrad, intern]);

    const a = resolveResume('ng', data);
    const b = resolveResume('in', data);

    expect(a.sections[0]?.entries[0]?.dates).not.toBe(b.sections[0]?.entries[0]?.dates);
    // Everything else is identical, because it is literally the same data.
    expect(a.sections[1]).toEqual(b.sections[1]);
  });
});

describe('inheritance', () => {
  it('merges choices with the child winning', () => {
    const mid: ResumeSpec = { id: 'mid', label: 'Mid', extends: 'base', choices: { 'edu.dates': 'v_dec', b_course: 'v_broad' } };
    const leaf: ResumeSpec = { id: 'leaf', label: 'Leaf', extends: 'mid', choices: { b_course: 'v_systems' } };

    const flat = flattenSpec(leaf, [base, mid, leaf]);
    expect(flat.choices).toEqual({ 'edu.dates': 'v_dec', b_course: 'v_systems' });
  });

  it('inherits sections when the child declares none', () => {
    const leaf: ResumeSpec = { id: 'leaf', label: 'Leaf', extends: 'base' };
    const flat = flattenSpec(leaf, [base, leaf]);
    expect(flat.sections?.map((s) => s.kind)).toEqual(['education', 'experience', 'skills']);
  });

  it('replaces a section of the same kind rather than merging entry lists', () => {
    const leaf: ResumeSpec = {
      id: 'leaf',
      label: 'Leaf',
      extends: 'base',
      sections: [{ kind: 'experience', entries: [] }],
    };
    const r = resolveResume('leaf', store([base, leaf]));
    expect(r.sections.find((s) => s.kind === 'experience')?.entries).toHaveLength(0);
    // Untouched sections still come through.
    expect(r.sections.find((s) => s.kind === 'education')?.entries).toHaveLength(1);
  });

  it('rejects an inheritance cycle instead of hanging', () => {
    const a: ResumeSpec = { id: 'a', label: 'A', extends: 'b' };
    const b: ResumeSpec = { id: 'b', label: 'B', extends: 'a' };
    expect(() => flattenSpec(a, [a, b])).toThrow(/cycle/i);
  });

  it('names the missing parent when `extends` points nowhere', () => {
    const orphan: ResumeSpec = { id: 'orphan', label: 'O', extends: 'ghost' };
    expect(() => flattenSpec(orphan, [orphan])).toThrow(/ghost/);
  });
});

describe('bullet selection and ordering', () => {
  it('includes only the listed bullets, in the listed order', () => {
    const spec: ResumeSpec = {
      id: 's',
      label: 'S',
      extends: 'base',
      sections: [{ kind: 'experience', entries: ['exp'], bullets: { exp: ['b_two'] } }],
    };
    const r = resolveResume('s', store([base, spec]));
    const bullets = r.sections.find((s) => s.kind === 'experience')?.entries[0]?.bullets ?? [];
    expect(bullets.map((b) => b.id)).toEqual(['b_two']);
  });
});

describe('warnings', () => {
  it('flags a choice that matches nothing, rather than silently ignoring it', () => {
    // A renamed id is exactly how a resume quietly reverts to the wrong date.
    const spec: ResumeSpec = { id: 's', label: 'S', extends: 'base', choices: { 'edu.graduation': 'v_dec' } };
    const r = resolveResume('s', store([base, spec]));
    expect(r.warnings.join(' ')).toMatch(/edu\.graduation/);
  });

  it('flags a choice naming a variant that does not exist', () => {
    const spec: ResumeSpec = { id: 's', label: 'S', extends: 'base', choices: { 'edu.dates': 'v_nope' } };
    const r = resolveResume('s', store([base, spec]));
    expect(r.warnings.join(' ')).toMatch(/v_nope/);
    // …and falls back to the default rather than dropping the field.
    expect(r.sections[0]?.entries[0]?.dates).toBe('Sep. 2022 -- May 2026');
  });

  it('flags a section referencing a missing entry', () => {
    const spec: ResumeSpec = {
      id: 's',
      label: 'S',
      extends: 'base',
      sections: [{ kind: 'experience', entries: ['nope'] }],
    };
    const r = resolveResume('s', store([base, spec]));
    expect(r.warnings.join(' ')).toMatch(/nope/);
  });
});

describe('skills', () => {
  it('keeps every item when the section names no subset', () => {
    const r = resolveResume('base', store([base]));
    expect(r.sections.find((s) => s.kind === 'skills')?.skillGroups[0]?.items).toEqual(['Python', 'TypeScript']);
  });

  it('narrows to the listed items', () => {
    const spec: ResumeSpec = {
      id: 's',
      label: 'S',
      extends: 'base',
      sections: [{ kind: 'skills', entries: [], groups: ['sk'], items: { sk: ['s_py'] } }],
    };
    const r = resolveResume('s', store([base, spec]));
    expect(r.sections.find((s) => s.kind === 'skills')?.skillGroups[0]?.items).toEqual(['Python']);
  });
});

describe('master document', () => {
  it('shows every phrasing of every bullet, not just the defaults', () => {
    const master = buildMaster(store([base]));
    const bullets = master.sections.flatMap((s) => s.entries.flatMap((e) => e.bullets));
    expect(bullets.some((b) => b.text.includes('Algorithms, Databases'))).toBe(true);
    expect(bullets.some((b) => b.text.includes('Operating Systems, Networks'))).toBe(true);
  });

  it('marks which phrasing is the default', () => {
    const master = buildMaster(store([base]));
    const bullets = master.sections.flatMap((s) => s.entries.flatMap((e) => e.bullets));
    expect(bullets.find((b) => b.variantId === 'v_broad')?.text).toMatch(/\(default\)/);
  });

  it('lifts the page limit, since it is an inventory and not a resume', () => {
    expect(buildMaster(store([base])).layout.maxPages).toBeGreaterThan(1);
  });
});

describe('list bullets', () => {
  const listEntry: Entry = {
    id: 'edu_list',
    kind: 'education',
    title: 'University',
    bullets: [
      {
        id: 'b_courses',
        default: 'v_list',
        prefix: '**Coursework:**',
        separator: '; ',
        variants: [],
        items: [
          { id: 'c_a', text: 'Algorithms' },
          { id: 'c_b', text: 'Databases' },
        ],
      },
    ],
  };

  const listBase: ResumeSpec = {
    id: 'base',
    label: 'Base',
    sections: [{ kind: 'education', entries: ['edu_list'] }],
  };

  const listStore = (resumes: ResumeSpec[], entry: Entry = listEntry): StoreData => ({
    ...store(resumes),
    entries: [entry],
  });

  const textOf = (data: StoreData, id = 'base') =>
    resolveResume(id, data).sections[0]?.entries[0]?.bullets[0]?.text;

  it('joins every item with the configured separator', () => {
    expect(textOf(listStore([listBase]))).toBe('**Coursework:** Algorithms; Databases');
  });

  it('omits the prefix when there is not one', () => {
    const noPrefix = structuredClone(listEntry);
    delete noPrefix.bullets![0]!.prefix;
    expect(textOf(listStore([listBase], noPrefix))).toBe('Algorithms; Databases');
  });

  it('defaults the separator to a comma', () => {
    const noSep = structuredClone(listEntry);
    delete noSep.bullets![0]!.separator;
    expect(textOf(listStore([listBase], noSep))).toContain('Algorithms, Databases');
  });

  it('merges list selections down the inheritance chain', () => {
    const child: ResumeSpec = { id: 'c', label: 'C', extends: 'base', lists: { b_courses: ['c_b'] } };
    expect(textOf(listStore([listBase, child]), 'c')).toBe('**Coursework:** Databases');
  });

  it('drops the bullet when the selection is empty', () => {
    const child: ResumeSpec = { id: 'c', label: 'C', extends: 'base', lists: { b_courses: [] } };
    const r = resolveResume('c', listStore([listBase, child]));
    expect(r.sections[0]?.entries[0]?.bullets).toHaveLength(0);
  });

  it('warns about an item that no longer exists', () => {
    const child: ResumeSpec = { id: 'c', label: 'C', extends: 'base', lists: { b_courses: ['c_a', 'c_gone'] } };
    const r = resolveResume('c', listStore([listBase, child]));
    expect(r.warnings.join(' ')).toMatch(/c_gone/);
    expect(r.sections[0]?.entries[0]?.bullets[0]?.text).toBe('**Coursework:** Algorithms');
  });

  it('shows every item in the master document, with its id', () => {
    const master = buildMaster(listStore([listBase]));
    const text = master.sections
      .flatMap((s) => s.entries.flatMap((e) => e.bullets))
      .map((b) => b.text)
      .join(' ');
    expect(text).toContain('Algorithms [c_a]');
    expect(text).toContain('(list)');
  });
});
