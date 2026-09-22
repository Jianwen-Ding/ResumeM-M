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
      // Empty, so it does not change the section count above — it is here so
      // an entry has somewhere to move to.
      { kind: 'project', heading: 'Projects', skillGroups: [], entries: [] },
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

  /*
   * Whatever counts as a new version has to be describable as one.
   *
   * `sameDocument` decides *whether* a version exists and `diffResumes`
   * decides what it says, and wherever the two disagree the card falls back
   * to the raw commit message — a version in the timeline with an empty
   * change list and a blank before/after. Worse on the restore path, which
   * fires "Some of that version is in things this resume shares with
   * others…" off `sameDocument` and then lists nothing underneath it.
   *
   * Three ordinary edits landed in that gap, all of them plainly visible to a
   * reader:
   *
   *   - any contact detail but the name — `diffResumes` compared only
   *     `resolveProfile(...).name` while `strip` shipped the whole profile, so
   *     adding a GitHub link made an empty version on *every* resume at once;
   *   - a section heading renamed, which nothing read except to quote it;
   *   - an entry moved from one section to another, which `entriesOf`
   *     flattens across sections, so the id was present in both and the order
   *     filter still matched. The job now prints under "Projects" and the
   *     history said the document had not changed.
   */
  const says = (after: ResolvedResume) => diffResumes(doc(), after).map((c) => c.text).join(' | ');

  it('describes a contact detail changing, rather than making a blank version', () => {
    const after = edited((d) => {
      (d.profile as Record<string, unknown>).email = 'new@b.com';
    });
    expect(sameDocument(doc(), after)).toBe(false);
    expect(says(after)).toMatch(/email/i);
  });

  it('describes a section heading being renamed', () => {
    const after = edited((d) => {
      d.sections[0]!.heading = 'Work';
    });
    expect(sameDocument(doc(), after)).toBe(false);
    // The rename itself, not an entry reported as having moved into it: the
    // entry did not go anywhere, and saying it did hides what actually
    // happened behind a sentence that reads almost right.
    expect(says(after)).toMatch(/Renamed the "Experience" section to "Work"/);
    expect(says(after)).not.toMatch(/Moved/);
  });

  it('describes an entry moving from one section to another', () => {
    const after = edited((d) => {
      d.sections[1]!.entries.push(d.sections[0]!.entries.pop()!);
    });
    expect(sameDocument(doc(), after)).toBe(false);
    expect(says(after)).toMatch(/Acme Co\./);
    expect(says(after)).toMatch(/Projects/);
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
    /*
     * And what is left, which is the half that can actually be judged: the
     * line that prints is the one that is kept, and naming only the cuts
     * makes a proposal read as destruction with no way to weigh it.
     */
    expect(changes.map((c) => c.text)).toContain('Languages: dropped Python — keeping Go, Rust');
  });

  it('says so when a cut takes the whole line', () => {
    const withSkills = doc({
      sections: [
        { kind: 'skills', heading: 'Technical Skills', skillGroups: [{ id: 'g', name: 'Languages', items: ['Go', 'Python'] }], entries: [] },
      ],
    });
    const after = structuredClone(withSkills);
    after.sections[0]!.skillGroups[0]!.items = [];

    const texts = diffResumes(withSkills, after).map((c) => c.text);
    expect(texts).toContain('Languages: dropped Go, Python, which is all of them, so the line will not print');
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

  /*
   * Reordering is reported whatever else happened in the same version.
   *
   * This used to be suppressed whenever anything else had changed — "the
   * reorder is noise" — which was defensible while reordering was something a
   * person did on its own. The AI reorders now, in the same pass in which it
   * turns entries on and off, so the suppression hid it on exactly the
   * versions where it mattered: every tailoring pass that moved an entry and
   * changed one reported only the change, and the order on the page moved
   * with nothing saying so.
   */
  it('mentions reordering, including alongside a real edit', () => {
    const two = edited((d) => {
      d.sections[0]!.entries.push({ id: 'exp_b', kind: 'experience', title: 'B Co.', bullets: [] });
    });
    const swapped = structuredClone(two);
    swapped.sections[0]!.entries.reverse();

    expect(diffResumes(two, swapped).map((c) => c.kind)).toEqual(['moved']);

    const swappedAndEdited = structuredClone(swapped);
    swappedAndEdited.sections[0]!.entries[0]!.title = 'B Corporation';
    expect(diffResumes(two, swappedAndEdited).map((c) => c.kind)).toContain('moved');
  });

  /*
   * A bullet swap prints in a different order on every resume that shows the
   * entry, and `diffBullets` keys on `bullet.id` — so it matched every id and
   * reported nothing, while `sameDocument` compares the list in order and
   * therefore made a version. An empty change list on a version that exists
   * is what this file exists to prevent, and reordering is one of the three
   * things the AI is allowed to do.
   */
  it('notices two bullets swapping places', () => {
    const second = { id: 'b2', variantId: 'v', text: 'Kept the on-call rota honest' };
    const two = edited((d) => {
      d.sections[0]!.entries[0]!.bullets.push(second);
    });
    const swapped = structuredClone(two);
    swapped.sections[0]!.entries[0]!.bullets.reverse();

    // The documents really are different, which is why a version was made.
    expect(sameDocument(two, swapped)).toBe(false);
    const changes = diffResumes(two, swapped);
    expect(changes.map((c) => c.kind)).toContain('moved');
    expect(changes.map((c) => c.text).join(' ')).toMatch(/bullets reordered/i);
  });

  /*
   * And a markup-only edit. `plain` strips `**`, backticks, `*` and links
   * before comparing — right for an entry that should read as prose — but
   * `sameDocument` compares the raw text, so taking the bold off a bullet
   * made a version whose change list was empty and whose card fell back to
   * the raw commit message.
   */
  it('says something about a change that is only formatting', () => {
    const before = doc();
    const first = before.sections[0]!.entries[0]!.bullets[0]!;
    const after = edited((d) => {
      d.sections[0]!.entries[0]!.bullets[0]!.text = first.text.replace(/\*\*/g, '');
    });
    // Only meaningful if the fixture bullet actually carries markup.
    if (!/\*\*/.test(first.text)) {
      after.sections[0]!.entries[0]!.bullets[0]!.text = `**${first.text}**`;
    }
    const changes = diffResumes(before, after);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.map((c) => c.text).join(' ')).toMatch(/different formatting/i);
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
