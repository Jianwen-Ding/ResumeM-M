import { describe, expect, it } from 'vitest';
import { diffResumes, sameDocument } from '../src/model/diff.js';
import { DEFAULT_LAYOUT, type ResolvedResume } from '../src/model/types.js';

/** A resolved resume, i.e. the document itself with every choice already made. */
function doc(overrides: Partial<ResolvedResume> = {}): ResolvedResume {
  return {
    id: 'newgrad',
    label: 'New grad',
    profile: { name: 'Test Person', email: 'a@b.com' },
    sections: [
      {
        kind: 'experience',
        heading: 'Experience',
        skillGroups: [],
        entries: [
          {
            id: 'exp_acme',
            kind: 'experience',
            title: 'Acme Co.',
            dates: 'Jul. 2024 -- Dec. 2024',
            subtitle: 'Software Engineer',
            location: 'Boston, MA',
            bullets: [{ id: 'b1', variantId: 'v', text: 'Built a pipeline handling **2M events/day**' }],
          },
        ],
      },
    ],
    layout: DEFAULT_LAYOUT,
    warnings: [],
    ...overrides,
  };
}

/** Mutate a copy of the document, the way an edit in the editor would. */
function edited(fn: (d: ResolvedResume) => void): ResolvedResume {
  const copy = structuredClone(doc());
  fn(copy);
  return copy;
}

describe('diffing two versions of a resume', () => {
  it('calls the first version created, and counts what is on it', () => {
    const changes = diffResumes(undefined, doc());
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('created');
    expect(changes[0]?.text).toBe('First version — 1 sections, 1 bullet points');
  });

  it('reports a reworded bullet with both sentences in full', () => {
    const after = edited((d) => {
      d.sections[0]!.entries[0]!.bullets[0]!.text = 'Built a pipeline handling **9M events/day**';
    });
    const change = diffResumes(doc(), after).find((c) => c.kind === 'reworded');
    expect(change?.where).toBe('Acme Co.');
    expect(change?.from).toBe('Built a pipeline handling 2M events/day');
    expect(change?.to).toBe('Built a pipeline handling 9M events/day');
  });

  it('strips store markup, so a history entry reads as prose', () => {
    const after = edited((d) => {
      d.sections[0]!.entries[0]!.bullets[0]!.text = 'Shipped `kafka` and *more*';
    });
    const change = diffResumes(doc(), after)[0];
    expect(change?.to).toBe('Shipped kafka and more');
    expect(change?.to).not.toContain('`');
  });

  it('normalises the LaTeX en dash in dates', () => {
    const after = edited((d) => {
      d.sections[0]!.entries[0]!.dates = 'Jul. 2024 -- Mar. 2025';
    });
    const change = diffResumes(doc(), after)[0];
    expect(change?.from).toBe('Jul. 2024 – Dec. 2024');
    expect(change?.to).toBe('Jul. 2024 – Mar. 2025');
    expect(change?.text).toContain('dates');
  });

  it('reports a dropped bullet as dropped, and an added one as added', () => {
    const dropped = edited((d) => {
      d.sections[0]!.entries[0]!.bullets = [];
    });
    expect(diffResumes(doc(), dropped)[0]).toMatchObject({
      kind: 'removed',
      where: 'Acme Co.',
      from: 'Built a pipeline handling 2M events/day',
    });

    const added = edited((d) => {
      d.sections[0]!.entries[0]!.bullets.push({ id: 'b2', variantId: 'v', text: 'Ran on-call' });
    });
    expect(diffResumes(doc(), added)[0]).toMatchObject({ kind: 'added', to: 'Ran on-call' });
  });

  it('names the section an entry joined or left', () => {
    const removed = edited((d) => {
      d.sections[0]!.entries = [];
    });
    expect(diffResumes(doc(), removed)[0]?.text).toBe('Removed from Experience: Acme Co.');

    const added = edited((d) => {
      d.sections[0]!.entries.push({
        id: 'exp_new',
        kind: 'experience',
        title: 'Streamly',
        bullets: [{ id: 'x', variantId: 'v', text: 'Did a thing' }],
      });
    });
    expect(diffResumes(doc(), added)[0]?.text).toBe('Added to Experience: Streamly (1 bullet)');
  });

  it('reports a changed role or location as its own line', () => {
    const after = edited((d) => {
      d.sections[0]!.entries[0]!.subtitle = 'Senior Software Engineer';
      d.sections[0]!.entries[0]!.location = 'Remote';
    });
    const changes = diffResumes(doc(), after);
    expect(changes.map((c) => c.text).join(' ')).toContain('role');
    expect(changes.map((c) => c.text).join(' ')).toContain('location');
  });

  it('reports a field being cleared as removed rather than as an empty arrow', () => {
    const after = edited((d) => {
      d.sections[0]!.entries[0]!.location = undefined;
    });
    expect(diffResumes(doc(), after)[0]?.text).toBe('Acme Co.: location removed');
  });

  it('reports skills joining and leaving a group', () => {
    const withSkills = doc({
      sections: [
        { kind: 'skills', heading: 'Technical Skills', skillGroups: [{ id: 'g', name: 'Languages', items: ['Go', 'Python'] }], entries: [] },
      ],
    });
    const after = structuredClone(withSkills);
    after.sections[0]!.skillGroups[0]!.items = ['Go', 'Rust'];

    const changes = diffResumes(withSkills, after);
    expect(changes.map((c) => c.text)).toContain('Languages: added Rust');
    expect(changes.map((c) => c.text)).toContain('Languages: dropped Python');
  });

  it('notices a rename and a new name on the header', () => {
    const after = edited((d) => {
      d.label = 'New grad 2026';
      d.profile.name = 'Test Person Jr.';
    });
    const texts = diffResumes(doc(), after).map((c) => c.text);
    expect(texts).toContain('Renamed to "New grad 2026"');
    expect(texts).toContain('Name changed to Test Person Jr.');
  });

  it('mentions reordering only when nothing else changed', () => {
    const two = edited((d) => {
      d.sections[0]!.entries.push({ id: 'exp_b', kind: 'experience', title: 'B Co.', bullets: [] });
    });
    const swapped = structuredClone(two);
    swapped.sections[0]!.entries.reverse();

    expect(diffResumes(two, swapped).map((c) => c.kind)).toEqual(['moved']);

    // With a real edit in the same version, the reorder is noise.
    const swappedAndEdited = structuredClone(swapped);
    swappedAndEdited.sections[0]!.entries[0]!.title = 'B Corporation';
    expect(diffResumes(two, swappedAndEdited).map((c) => c.kind)).not.toContain('moved');
  });

  it('finds nothing to say about an identical document', () => {
    expect(diffResumes(doc(), doc())).toEqual([]);
  });
});

describe('sameDocument', () => {
  it('is true for identical documents', () => {
    expect(sameDocument(doc(), doc())).toBe(true);
  });

  it('is false when a single word of a bullet changes', () => {
    const after = edited((d) => {
      d.sections[0]!.entries[0]!.bullets[0]!.text = 'Built a pipeline handling **3M events/day**';
    });
    expect(sameDocument(doc(), after)).toBe(false);
  });

  it('ignores layout, which does not change what the resume says', () => {
    const shrunk = edited((d) => {
      d.layout = { ...d.layout, fontSizePt: 9.4, marginIn: 0.38 };
    });
    expect(sameDocument(doc(), shrunk)).toBe(true);
  });

  it('ignores warnings, which are about the store and not the page', () => {
    const warned = edited((d) => {
      d.warnings = ['Section "project" lists entry "gone", which does not exist.'];
    });
    expect(sameDocument(doc(), warned)).toBe(true);
  });
});
