/*
 * Every way a resume can ask for something that is not there any more, and
 * whether it can be told to stop.
 *
 * A resume is a set of references — these entries, these lines of them, this
 * wording of that line, these skills out of that group — and the master
 * document underneath it goes on being edited. Delete a line, rename a
 * phrasing, retire a skills group, and every resume that pinned it is left
 * pointing at nothing.
 *
 * The resolver has always said so, and saying so was all it did. A warning
 * about an id that names nothing is a dead end: the thing it points at is in
 * no picker and no tick box, because it does not exist, so the only ways out
 * were editing the YAML by hand or building the resume again. `lost` is what
 * the editor hangs "Remove from this resume" off, so what matters here is
 * that every one of these cases reaches it, carrying the sentence it was
 * reported with and the id that has to come out.
 */
import { describe, expect, it } from 'vitest';
import { describeLost } from '../src/model/applications.js';
import { resolveResume } from '../src/model/resolve.js';
import type { Entry, ResumeSpec, StoreData } from '../src/model/types.js';
import { DEFAULT_CONFIG } from '../src/model/types.js';

const expEntry: Entry = {
  id: 'exp',
  kind: 'experience',
  title: {
    default: 'v_long',
    variants: [
      { id: 'v_long', label: 'Long', text: 'Example Company, Inc.' },
      { id: 'v_short', label: 'Short', text: 'Example Co.' },
    ],
  },
  bullets: [
    { id: 'b_one', default: 'v1', variants: [{ id: 'v1', label: 'One', text: 'First bullet' }] },
    {
      id: 'b_list',
      default: '__list__',
      prefix: 'Built with',
      items: [
        { id: 'i_go', text: 'Go' },
        { id: 'i_ts', text: 'TypeScript' },
      ],
      variants: [],
    },
  ],
};

function store(resume: ResumeSpec): StoreData {
  return {
    profile: { name: 'Test Person' },
    entries: [expEntry],
    skillGroups: [{ id: 'sk', name: 'Languages', items: [{ id: 's_py', text: 'Python' }] }],
    resumes: [resume],
    applications: [],
    coverLetters: [],
    drafts: [],
    samples: [],
    answers: [],
    voice: '',
    config: DEFAULT_CONFIG,
  };
}

/** Resolve a resume built around one section, and hand back what it lost. */
function lostFrom(spec: Omit<ResumeSpec, 'id' | 'label'>) {
  const resume = { id: 'r', label: 'R', ...spec } as ResumeSpec;
  const out = resolveResume('r', store(resume));
  return { out, lost: out.lost ?? [] };
}

describe('what a resume asks for and the store no longer has', () => {
  it('names an entry that is gone', () => {
    const { lost } = lostFrom({ sections: [{ kind: 'experience', entries: ['exp', 'exp_closed'] }] });
    expect(lost).toEqual([
      expect.objectContaining({ kind: 'entry', id: 'exp_closed' }),
    ]);
  });

  it('names a line that is gone', () => {
    const { lost } = lostFrom({
      sections: [{ kind: 'experience', entries: ['exp'], bullets: { exp: ['b_one', 'b_cut'] } }],
    });
    expect(lost).toEqual([expect.objectContaining({ kind: 'bullet', id: 'b_cut' })]);
  });

  it('names a skills group that is gone', () => {
    const { lost } = lostFrom({ sections: [{ kind: 'skills', entries: [], groups: ['sk', 'sk_gone'] }] });
    expect(lost).toEqual([expect.objectContaining({ kind: 'skillGroup', id: 'sk_gone' })]);
  });

  it('names a skill that is gone', () => {
    const { lost } = lostFrom({
      sections: [{ kind: 'skills', entries: [], groups: ['sk'], items: { sk: ['s_py', 's_perl'] } }],
    });
    expect(lost).toEqual([expect.objectContaining({ kind: 'skill', id: 's_perl' })]);
  });

  it('names an item of a list line that is gone', () => {
    const { lost } = lostFrom({
      sections: [{ kind: 'experience', entries: ['exp'] }],
      lists: { b_list: ['i_go', 'i_cobol'] },
    });
    expect(lost).toEqual([expect.objectContaining({ kind: 'listItem', id: 'i_cobol' })]);
  });

  it('names a choice that matches nothing at all', () => {
    const { lost } = lostFrom({
      sections: [{ kind: 'experience', entries: ['exp'] }],
      choices: { 'exp_gone.title': 'v_long' },
    });
    expect(lost).toEqual([expect.objectContaining({ kind: 'wording', id: 'exp_gone.title' })]);
  });

  /*
   * The case that was reported and never recorded: the field is real, the
   * resume's pick of it is not. Renaming a variant in the master document
   * silently dropped every resume that had pinned it back to the default,
   * with a warning nobody could act on — the variant is gone, so there is no
   * alternate to un-pick.
   */
  it('names a choice whose wording has been renamed, on a field', () => {
    const { lost } = lostFrom({
      sections: [{ kind: 'experience', entries: ['exp'] }],
      choices: { 'exp.title': 'v_renamed' },
    });
    expect(lost).toEqual([expect.objectContaining({ kind: 'wording', id: 'exp.title' })]);
  });

  it('and on a bullet', () => {
    const { lost } = lostFrom({
      sections: [{ kind: 'experience', entries: ['exp'] }],
      choices: { b_one: 'v_renamed' },
    });
    expect(lost).toEqual([expect.objectContaining({ kind: 'wording', id: 'b_one' })]);
  });

  /*
   * One problem, one row. The editor draws a row with a button for everything
   * in `lost` and then the warnings that are not one of those, matched on the
   * sentence — so a sentence that differs by a word between the two lists is
   * the same problem printed twice, once actionable and once not.
   */
  it('says it the same way in both places, once', () => {
    const { out, lost } = lostFrom({
      sections: [{ kind: 'experience', entries: ['exp', 'exp_closed'], bullets: { exp: ['b_one', 'b_cut'] } }],
      choices: { b_one: 'v_renamed' },
    });
    expect(lost.length).toBe(3);
    for (const l of lost) {
      expect(typeof l.says).toBe('string');
      expect(l.says).toContain(l.id);
      expect(out.warnings.filter((w) => w === l.says).length).toBe(1);
    }
  });

  /*
   * And nothing is reported when nothing is wrong, which is the half that
   * decides whether any of the above means anything. A panel that offers to
   * remove a reference from a resume where every reference is good is worse
   * than no panel.
   */
  it('finds nothing in a resume that asks only for what exists', () => {
    const { out, lost } = lostFrom({
      sections: [
        { kind: 'experience', entries: ['exp'], bullets: { exp: ['b_one', 'b_list'] } },
        { kind: 'skills', entries: [], groups: ['sk'], items: { sk: ['s_py'] } },
      ],
      lists: { b_list: ['i_go'] },
      choices: { 'exp.title': 'v_short', b_one: 'v1' },
    });
    expect(lost).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  /*
   * An archived line is not a lost one. It exists, it is deliberately out of
   * circulation, and offering to strike it out of the resume would be an
   * offer to lose the only record that the resume ever wanted it — the moment
   * it is brought back, the resume that had it should have it again.
   */
  it('leaves an archived line alone', () => {
    const data = store({
      id: 'r',
      label: 'R',
      sections: [{ kind: 'experience', entries: ['exp'], bullets: { exp: ['b_one'] } }],
    });
    data.entries[0]!.bullets![0]!.archived = true;
    const out = resolveResume('r', data);
    expect(out.warnings.join(' ')).toMatch(/archived/);
    expect(out.lost ?? []).toEqual([]);
  });
});

/*
 * And the one-line summary the extension shows before attaching a file,
 * which reads off the same list. It counted three kinds and the list now
 * holds six, which would have made "  this resume chose is no longer in your
 * store." out of a resume that had lost a line and nothing else.
 */
describe('the sentence that counts them', () => {
  it('counts the kinds that were there before', () => {
    expect(describeLost([{ kind: 'entry' }])).toBe('1 entry this resume chose is no longer in your store.');
    expect(describeLost([{ kind: 'entry' }, { kind: 'wording' }])).toBe(
      '1 entry and 1 wording this resume chose are no longer in your store.',
    );
  });

  it('counts the ones that were added', () => {
    expect(describeLost([{ kind: 'bullet' }, { kind: 'bullet' }])).toBe(
      '2 lines this resume chose are no longer in your store.',
    );
    expect(describeLost([{ kind: 'skillGroup' }])).toBe(
      '1 skills group this resume chose is no longer in your store.',
    );
    expect(describeLost([{ kind: 'listItem' }])).toBe(
      '1 list item this resume chose is no longer in your store.',
    );
  });

  it('worst first, and still nothing to say about nothing', () => {
    expect(describeLost([{ kind: 'wording' }, { kind: 'entry' }, { kind: 'skill' }])).toBe(
      '1 entry, 1 skill and 1 wording this resume chose are no longer in your store.',
    );
    expect(describeLost([])).toBeUndefined();
    expect(describeLost([{ kind: 'something-else-entirely' }])).toBeUndefined();
  });
});
