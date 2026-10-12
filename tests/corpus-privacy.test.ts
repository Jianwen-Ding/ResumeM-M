import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { personalDetailIn } from '../src/ai/privacy.js';

/*
 * Every verdict `personalDetailIn` has been asked for, in one place.
 *
 * Each round of review fixed the phone and address rules for the cases it
 * found, and more than one round broke a case an earlier round had fixed:
 * "IDs 12345 67890" was let through in round 12, refused again in round 14
 * and let through in round 15, and the French and Australian mobiles went the
 * other way in round 15. The cases lived in each round's own test lines and
 * review notes, so a later tweak was never run against the earlier ones.
 *
 * `fixtures/corpus-privacy.json` is all of them, gathered from every round's
 * tests and reviews, with the round and the source each came from. Where two
 * rounds disagreed, round 17 decided, and the case says so in `comment`.
 * A case marked `todo` is an open gap no rule yet closes cleanly; it is
 * listed so it is not forgotten, and not asserted.
 *
 * Secret-shaped strings are stored split into `parts` and joined here, so
 * the fixture never holds a realistic key that push protection would refuse.
 */

/** Let through; refused, for any reason; refused with exactly this; or with a reason containing this. */
type Expect = null | 'refuse' | string | { match: string };
interface Case {
  id: string;
  input: string | { parts: string[] };
  expect: Expect;
  round: string;
  source: string;
  comment?: string;
  todo?: string;
}

const join = (v: Case['input']): string => (typeof v === 'string' ? v : v.parts.join(''));

const { cases } = JSON.parse(
  fs.readFileSync(new URL('./fixtures/corpus-privacy.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

describe('the privacy corpus', () => {
  it('has every case it was built with', () => {
    expect(cases.length).toBeGreaterThan(200);
  });

  for (const c of cases) {
    const text = join(c.input);
    const name = `${c.id} (${c.round}): ${JSON.stringify(text).slice(0, 80)} -> ${JSON.stringify(c.expect)}`;
    if (c.todo) {
      it.todo(`${name} — ${c.todo}`);
      continue;
    }
    it(name, () => {
      const actual = personalDetailIn(text);
      if (c.expect === null) expect(actual).toBeNull();
      else if (c.expect === 'refuse') expect(actual).not.toBeNull();
      else if (typeof c.expect === 'object') expect(actual).toContain(c.expect.match);
      else expect(actual).toBe(c.expect);
    });
  }
});
