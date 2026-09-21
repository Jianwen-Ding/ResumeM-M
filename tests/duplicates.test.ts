/*
 * The same option, twice.
 *
 * A skills group is a list of options and so is a list bullet — "Unity,
 * Unreal, Godot" — and nothing stopped the same one going in again. It is an
 * easy thing to do: the groups are long, the add dialog shows none of what is
 * already in them, and a technology added six months ago is not something
 * anybody remembers. What comes out is a line reading "Unity, Unreal, Unity",
 * which the reader notices and the writer does not.
 *
 * Enforced in the store rather than in the dialog, because the editor, the
 * HTTP API, the CLI and the MCP authoring tools all write through it and a
 * rule in one of them is a rule three ways round. Enforced against the write
 * rather than against the file: a save that already holds a duplicate — hand
 * written, or made by an older build — has to go on saving, or the fix for a
 * resume you cannot open is a worse error message.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { andList, newlyRepeated, optionKey, repeatedIn } from '../src/model/duplicates.js';
import { makeTempStore, type TempStore } from './helpers.js';
import type { Entry, SkillGroup } from '../src/model/types.js';

describe('when two options are the same option', () => {
  it('reads past case and spacing, which is the same thing typed twice', () => {
    expect(optionKey('Unity')).toBe(optionKey('  unity '));
    expect(optionKey('Unreal  Engine')).toBe(optionKey('unreal engine'));
  });

  /*
   * And not past punctuation. "Node" and "Node.js" are two names somebody may
   * mean to keep apart, and a rule that merged them would be deleting a
   * decision rather than catching a slip.
   */
  it('and not past punctuation, which can be the difference', () => {
    expect(optionKey('Node')).not.toBe(optionKey('Node.js'));
    expect(optionKey('C')).not.toBe(optionKey('C++'));
  });

  it('finds the repeats and says which ids carry them', () => {
    const again = repeatedIn([
      { id: 'a', text: 'Unity' },
      { id: 'b', text: 'Godot' },
      { id: 'c', text: 'unity' },
    ]);
    expect([...again.keys()]).toEqual(['unity']);
    expect(again.get('unity')).toEqual(['a', 'c']);
  });

  /*
   * Only what the write adds. The one property that keeps a save with a
   * duplicate already in it from becoming a save nobody can write to.
   */
  it('counts only what this write would newly repeat', () => {
    const had = [
      { id: 'a', text: 'Unity' },
      { id: 'b', text: 'unity' },
    ];
    expect(newlyRepeated(had, [...had, { id: 'c', text: 'Godot' }])).toEqual([]);
    expect(newlyRepeated(had, [...had, { id: 'c', text: 'godot' }, { id: 'd', text: 'Godot' }])).toEqual(['godot']);
  });

  it('names them the way a sentence does', () => {
    expect(andList(['Unity'])).toBe('"Unity"');
    expect(andList(['Unity', 'Godot'])).toBe('"Unity" and "Godot"');
    expect(andList(['Unity', 'Godot', 'Unreal'])).toBe('"Unity", "Godot" and "Unreal"');
  });
});

describe('a store that will not take the same option twice', () => {
  let t: TempStore;
  beforeEach(() => {
    t = makeTempStore();
  });
  afterEach(() => t.cleanup());

  const groups = (): SkillGroup[] => t.store.load().skillGroups;

  it('refuses a skill the group already lists, and names it', () => {
    const next = groups().map((g) =>
      g.id === 'sk_lang' ? { ...g, items: [...g.items, { id: 's_python2', text: 'python' }] } : g,
    );
    expect(() => t.store.saveSkillGroups(next)).toThrow(/"Python" is already in "Languages"/);
    // And nothing was written: a refusal that half-lands is worse than none.
    expect(groups().find((g) => g.id === 'sk_lang')!.items).toHaveLength(4);
  });

  it('takes one that is genuinely new', () => {
    const next = groups().map((g) =>
      g.id === 'sk_lang' ? { ...g, items: [...g.items, { id: 's_rust', text: 'Rust' }] } : g,
    );
    t.store.saveSkillGroups(next);
    expect(groups().find((g) => g.id === 'sk_lang')!.items.map((i) => i.text)).toContain('Rust');
  });

  it('refuses a second group by the same name', () => {
    expect(() => t.store.saveSkillGroups([...groups(), { id: 'sk_two', name: 'languages', items: [] }])).toThrow(
      /already a skills group called "Languages"/i,
    );
  });

  /*
   * The property that keeps an old save openable. A group that already holds
   * the same skill twice goes on saving — it is somebody's file and refusing
   * to write it fixes nothing — and simply does not acquire a third.
   */
  it('goes on saving a group that was already repeating itself', () => {
    // Put there the way an older build or a hand edit would have: straight
    // into the file, past the rule, because the rule is what is under test
    // and a case it set up would prove nothing.
    const at = path.join(t.dir, 'skills.yaml');
    const doubled = groups().map((g) =>
      g.id === 'sk_lang' ? { ...g, items: [...g.items, { id: 's_py2', text: 'Python' }] } : g,
    );
    fs.writeFileSync(at, YAML.stringify(doubled), 'utf8');

    // Saving it back is fine: this store's duplicate is its own business.
    expect(() => t.store.saveSkillGroups(doubled)).not.toThrow();
    // A third is not.
    expect(() =>
      t.store.saveSkillGroups(
        doubled.map((g) => (g.id === 'sk_lang' ? { ...g, items: [...g.items, { id: 's_go2', text: 'go' }] } : g)),
      ),
    ).toThrow(/"Go" is already in "Languages"/);
  });

  const entry = (): Entry => t.store.load().entries.find((e) => e.id === 'exp_acme')!;

  it('refuses a wording of a line that the line already has', () => {
    const now = entry();
    const bullet = now.bullets![0]!;
    const twice = {
      ...now,
      bullets: now.bullets!.map((b) =>
        b.id !== bullet.id
          ? b
          : { ...b, variants: [...b.variants, { id: 'v_again', label: 'Again', text: b.variants[0]!.text }] },
      ),
    };
    expect(() => t.store.saveEntry(twice)).toThrow(/already a wording of this line/);
  });

  it('refuses a list item the list already has', () => {
    const now = entry();
    const withList = {
      ...now,
      bullets: [
        ...now.bullets!,
        {
          id: 'b_built',
          default: '__list__',
          prefix: 'Built with',
          variants: [],
          items: [
            { id: 'i_unity', text: 'Unity' },
            { id: 'i_unity2', text: 'unity' },
          ],
        },
      ],
    } as Entry;
    expect(() => t.store.saveEntry(withList)).toThrow(/"Unity" is already in this list/i);
  });

  it('takes a list that says each thing once', () => {
    const now = entry();
    const withList = {
      ...now,
      bullets: [
        ...now.bullets!,
        {
          id: 'b_built',
          default: '__list__',
          prefix: 'Built with',
          variants: [],
          items: [
            { id: 'i_unity', text: 'Unity' },
            { id: 'i_godot', text: 'Godot' },
          ],
        },
      ],
    } as Entry;
    expect(() => t.store.saveEntry(withList)).not.toThrow();
    expect(t.store.load().entries.find((e) => e.id === 'exp_acme')!.bullets!.some((b) => b.id === 'b_built')).toBe(true);
  });
});
