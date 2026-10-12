import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { classifyPage, type PageKind } from '../src/jobs/extract.js';

/*
 * Every page `classifyPage` has been asked to judge, in one place.
 *
 * The rules for a job application that is not a loan, an admission or a
 * career fair were tightened and loosened round after round, and each time
 * some earlier round's case went the other way: `acme.example/events/careers/
 * apply` and `/careers/jobs/events` were job forms through round 14 and
 * stopped being in round 16, when "events" anywhere in the path came to mean
 * an event's form. The cases were in each round's own tests and review notes,
 * so a later change was never run against the earlier ones.
 *
 * `fixtures/corpus-classifier.json` is all of them, with the round and the
 * source each came from. Where two rounds disagreed, round 17 decided, and
 * the case says so in `comment`. Pages the reviews only probed, with no
 * verdict anybody stated, are left out.
 */

type Expect = PageKind | { not: PageKind };
type Text = string | { parts: string[] };
interface Case {
  id: string;
  input: { url: Text; html: Text };
  expect: Expect;
  round: string;
  source: string;
  comment?: string;
  todo?: string;
}

const join = (v: Text): string => (typeof v === 'string' ? v : v.parts.join(''));

const { cases } = JSON.parse(
  fs.readFileSync(new URL('./fixtures/corpus-classifier.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

describe('the classifier corpus', () => {
  it('has every case it was built with', () => {
    expect(cases.length).toBeGreaterThan(150);
  });

  for (const c of cases) {
    const url = join(c.input.url);
    const name = `${c.id} (${c.round}): ${url} -> ${JSON.stringify(c.expect)}`;
    if (c.todo) {
      it.todo(`${name} — ${c.todo}`);
      continue;
    }
    it(name, () => {
      const { kind } = classifyPage(join(c.input.html), url);
      if (typeof c.expect === 'object') expect(kind).not.toBe(c.expect.not);
      else expect(kind).toBe(c.expect);
    });
  }
});
