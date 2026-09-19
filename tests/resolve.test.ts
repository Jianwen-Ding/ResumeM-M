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
  samples: [],
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

  /*
   * Throwing is the one thing that cannot be right here. A resume whose
   * `extends` points back at itself is already saved, and the error came out
   * of every read of it — so the editor would not open it, which is where
   * the only controls for changing its base or deleting it are. The fault
   * made itself unfixable.
   */
  it('stops at an inheritance cycle rather than hanging, and still resolves', () => {
    const a: ResumeSpec = { id: 'a', label: 'A', extends: 'b' };
    const b: ResumeSpec = { id: 'b', label: 'B', extends: 'a' };
    const warnings: string[] = [];
    const flat = flattenSpec(a, [a, b], new Set(), warnings);
    expect(flat.id).toBe('a');
    expect(warnings.join(' ')).toMatch(/inherits from itself/i);
  });

  it('says so for a resume that names itself directly', () => {
    const self: ResumeSpec = { id: 'job-adobe', label: 'Adobe', extends: 'job-adobe' };
    const warnings: string[] = [];
    expect(flattenSpec(self, [self], new Set(), warnings).id).toBe('job-adobe');
    expect(warnings.join(' ')).toMatch(/job-adobe/);
  });

  /*
   * And the resume opens — which is the whole point, because opening it is
   * how it gets fixed.
   */
  it('resolves a self-inheriting resume instead of refusing to read it', () => {
    const self: ResumeSpec = {
      id: 'job-adobe',
      label: 'Adobe',
      extends: 'job-adobe',
      sections: [{ kind: 'education', entries: ['edu'] }],
    };
    const resolved = resolveResume('job-adobe', store([self]));
    expect(resolved.label).toBe('Adobe');
    expect(resolved.warnings.join(' ')).toMatch(/inherits from itself/i);
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

  it('marks which phrasing is the default, by its label rather than its key', () => {
    const master = buildMaster(store([base]));
    const bullets = master.sections.flatMap((s) => s.entries.flatMap((e) => e.bullets));
    const line = bullets.find((b) => b.variantId === 'v_broad')?.text ?? '';
    expect(line).toMatch(/\(default\)/);
    expect(line).toContain('Broad');
    expect(line).not.toContain('v_broad');
  });

  it('names a heading field the way the editor names it', () => {
    const master = buildMaster(store([base]));
    const lines = master.sections.flatMap((s) => s.entries.flatMap((e) => e.bullets)).map((b) => b.text);
    expect(lines.some((l) => l.includes('*Dates*'))).toBe(true);
    expect(lines.some((l) => l.includes('edu_neu.dates'))).toBe(false);
  });

  it('lifts the page limit, since it is an inventory and not a resume', () => {
    expect(buildMaster(store([base])).layout.maxPages).toBeGreaterThan(2);
    expect(buildMaster(store([base])).layout.autoFit).toBe(false);
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

  it('shows every item in the master document, named as a reader would name it', () => {
    const master = buildMaster(listStore([listBase]));
    const text = master.sections
      .flatMap((s) => s.entries.flatMap((e) => e.bullets))
      .map((b) => b.text)
      .join(' ');
    expect(text).toContain('Algorithms');
    expect(text).toContain('every item on this list');
    // The store's keys stopped appearing in the interface; this was the last
    // place they showed, and an inventory of text is what it is for.
    expect(text).not.toContain('[c_a]');
  });
});

/*
 * The name is a field like any other.
 *
 * A name is not one fixed thing — the one on your degree, the one people call
 * you, the initialled form that buys back a line on a full page — and which
 * belongs on a given application is a decision worth pinning. It goes through
 * the same machinery as a graduation date rather than a parallel one, so the
 * thing to check is that nothing about it is special.
 */
describe('alternates for the name', () => {
  // The file's own fixture, with the name given alternates.
  const withNames = (): StoreData => ({
    ...store([
      { id: 'base', label: 'Base', sections: [] },
      { id: 'short', label: 'Short', extends: 'base', choices: { 'profile.name': 'v_short' } },
    ]),
    profile: {
      name: {
        default: 'v_legal',
        variants: [
          { id: 'v_legal', label: 'Legal', text: 'Jianwen Ding' },
          { id: 'v_known', label: 'Known as', text: 'Jason Ding' },
          { id: 'v_short', label: 'Initialled', text: 'J. Ding' },
        ],
      },
      email: 'test@example.com',
    },
  });

  it('prints the pinned name when a resume says nothing', () => {
    expect(resolveResume('base', withNames()).profile.name).toBe('Jianwen Ding');
  });

  it('prints the one a resume asks for', () => {
    expect(resolveResume('short', withNames()).profile.name).toBe('J. Ding');
  });

  it('is not reported as a choice matching nothing in the store', () => {
    // The key has to be known, or pinning it warns on every render.
    expect(resolveResume('short', withNames()).warnings).toEqual([]);
  });

  it('falls back to the pinned one when a resume asks for a name that is gone', () => {
    const data = withNames();
    data.resumes[1]!.choices = { 'profile.name': 'v_deleted' };
    const out = resolveResume('short', data);
    expect(out.profile.name).toBe('Jianwen Ding');
    expect(out.warnings.join(' ')).toMatch(/v_deleted/);
  });

  it('leaves a plain string alone, which is what most stores have', () => {
    const data = store([{ id: 'base', label: 'Base', sections: [] }]);
    expect(resolveResume('base', data).profile.name).toBe('Test Person');
  });
});


/*
 * Archiving a bullet means "keep the text, never print it". That held for a
 * resume which says nothing about bullets, and not for one that lists them —
 * and AI tailoring writes an explicit list every time it hides anything, so
 * the moment you tailored a resume, every bullet you had retired in that entry
 * came back onto the copy you send.
 */
describe('an archived bullet stays archived', () => {
  const withArchived = (): StoreData => {
    const data = store([{ id: 'base', label: 'Base', sections: [] }]);
    data.entries = [
      {
        id: 'e1',
        kind: 'experience',
        title: 'Acme',
        bullets: [
          { id: 'b_keep', default: 'v', variants: [{ id: 'v', label: 'a', text: 'Kept bullet' }] },
          { id: 'b_old', archived: true, default: 'v', variants: [{ id: 'v', label: 'a', text: 'RETIRED — never print' }] },
        ],
      },
    ];
    return data;
  };

  const textOf = (data: StoreData) =>
    resolveResume('base', data).sections.flatMap((s) => s.entries).flatMap((e) => e.bullets).map((b) => b.text);

  it('is left out when the resume says nothing about bullets', () => {
    const data = withArchived();
    data.resumes[0]!.sections = [{ kind: 'experience', entries: ['e1'] }];
    expect(textOf(data)).toEqual(['Kept bullet']);
  });

  it('is left out even when the resume names it outright', () => {
    const data = withArchived();
    data.resumes[0]!.sections = [{ kind: 'experience', entries: ['e1'], bullets: { e1: ['b_keep', 'b_old'] } }];
    const out = resolveResume('base', data);
    expect(out.sections.flatMap((s) => s.entries).flatMap((e) => e.bullets).map((b) => b.text)).toEqual(['Kept bullet']);
    // Said out loud, because a resume asking for a bullet it cannot have is
    // worth knowing about rather than silently trimming.
    expect(out.warnings.join(' ')).toMatch(/b_old/);
  });
});

/*
 * A date that runs backwards, reported where somebody will see it.
 *
 * The control accepts any year at either end, because it has to — moving
 * both ends of a range means passing through a state where only one of them
 * has moved. So nothing anywhere looked at the result, and a 6 typed for a 4
 * printed "Jul. 2026 -- Dec. 2024" onto the one document that has to be
 * right. It is equally what a hand-written or imported YAML file can already
 * contain, which is why the check lives here rather than only in the editor:
 * this is the path every resume takes on its way to a page.
 */
describe('a date that ends before it starts', () => {
  const dated = (period: Entry['period'], dates?: string): StoreData => {
    const data = store([{ id: 'base', label: 'Base', sections: [{ kind: 'experience', entries: ['exp'] }] }]);
    data.entries = [{ ...expEntry, dates, period }];
    return data;
  };

  it('is said out loud, naming the entry as the user names it', () => {
    const said = resolveResume('base', dated({ start: { year: 2026, month: 7 }, end: { year: 2024, month: 12 } }, 'Jul. 2026 -- Dec. 2024')).warnings;
    expect(said.join(' ')).toMatch(/Example Co\./);
    expect(said.join(' ')).toMatch(/ends before it starts/i);
  });

  it('quotes the words that will print, so it can be found on the page', () => {
    const said = resolveResume('base', dated({ start: { year: 2026 }, end: { year: 2024 } }, 'Jul. 2026 -- Dec. 2024')).warnings;
    expect(said.join(' ')).toContain('Jul. 2026 -- Dec. 2024');
  });

  it('still says it for an entry whose date has no words yet', () => {
    const said = resolveResume('base', dated({ start: { year: 2026 }, end: { year: 2024 } })).warnings;
    expect(said.join(' ')).toMatch(/ends before it starts/i);
  });

  /*
   * And says nothing otherwise. A warning that fires on good dates is a
   * warning nobody reads, which costs more than the one it was added for.
   */
  it('says nothing about an ordinary date', () => {
    for (const period of [
      { start: { year: 2024, month: 7 }, end: { year: 2024, month: 12 } },
      { start: { year: 2024 }, end: { year: 2024 } },
      { start: { year: 2024, month: 7 }, ongoing: true },
      { start: { year: 2024 } },
      undefined,
    ] as Entry['period'][]) {
      const said = resolveResume('base', dated(period)).warnings.join(' ');
      expect(said, JSON.stringify(period)).not.toMatch(/ends before it starts/i);
    }
  });

  /*
   * Nothing is rewritten. The only thing this program is entitled to do
   * about somebody's dates is point at them — the entry prints exactly the
   * words it was given, backwards or not.
   */
  it('changes nothing about what prints', () => {
    const out = resolveResume('base', dated({ start: { year: 2026 }, end: { year: 2024 } }, 'Jul. 2026 -- Dec. 2024'));
    expect(out.sections[0]?.entries[0]?.dates).toBe('Jul. 2026 -- Dec. 2024');
  });
});
