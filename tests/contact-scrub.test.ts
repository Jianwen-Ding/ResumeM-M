import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { personalDetailIn, withoutContactDetails } from '../src/ai/privacy.js';
import { buildVoiceContext, renderVoiceContext } from '../src/ai/voice.js';
import { coverLetterPrompt } from '../src/ai/prompts.js';
import { resolveResume } from '../src/model/resolve.js';
import { WritingSession } from '../src/mcp/writing.js';
import { wireUp } from '../src/mcp/launch.js';
import type { CoverLetter, StoreData, WritingSample } from '../src/model/types.js';
import { makeTempStore, tempDir } from './helpers.js';

/*
 * Contact details in the person's own writing, kept from the AI.
 *
 * A letter is signed with a phone number and an email address, and an old
 * resume pasted into the corpus opens with a home address. All of it went to
 * the AI as "how they write": into the voice section of every job's prompt,
 * the letters `find_my_letters` hands over, what `check_claim` quotes, and
 * the session file in the AI's working directory. The details are replaced
 * by a placeholder; the writing around them stays.
 */

const PHONE = '(617) 555-0199';
const EMAIL = 'morgan.testwell@example.com';
const STREET = '12 Elm Street';

const SIGNED = `Dear Globex team,

I have spent three years building streaming pipelines and want to bring that to Globex's ingestion team, where latency matters.

Best,
Morgan Testwell
${EMAIL} | ${PHONE}
${STREET}, Apt 4, Springfield
`;

const OLD_RESUME = `MORGAN TESTWELL
${STREET}, Springfield | ${PHONE} | ${EMAIL}

Built a Kafka ingestion pipeline handling two million events a day for the analytics team.`;

const leaks = (text: string) => [PHONE, '555-0199', EMAIL, STREET].filter((s) => text.includes(s));

describe('withoutContactDetails', () => {
  it('takes the phone, the email and the street out of a signature, and leaves the letter', () => {
    const out = withoutContactDetails(SIGNED);
    expect(leaks(out)).toEqual([]);
    expect(out).toContain('building streaming pipelines');
    expect(out).toContain('[phone number]');
    expect(out).toContain('[email address]');
    expect(out).toContain('[street address], Apt 4, Springfield');
    expect(leaks(withoutContactDetails(OLD_RESUME))).toEqual([]);
  });

  /*
   * Two numbers joined by a "/" in a signature. A run of digits never starts
   * straight after a "/", so the pair was left whole, or the second kept its
   * "+" and the first number. `personalDetailIn` still reads the text as it
   * was: the "/" is a break only in what the scrub looks through.
   */
  it('takes out both numbers of a pair joined by a slash, and the "+" in front', () => {
    for (const [text, want] of [
      ['Tel/Fax: 617-555-0199/617-555-0100', 'Tel/Fax: [phone number]/[phone number]'],
      ['Tel: 617-555-0199/+44 20 7946 0958', 'Tel: [phone number]/[phone number]'],
      ['Mobile/WhatsApp: +44 7700 900123/+1 617 555 0199', 'Mobile/WhatsApp: [phone number]/[phone number]'],
      ['Tel: 617-555-0199 / 617-555-0100', 'Tel: [phone number] / [phone number]'],
    ]) {
      expect(withoutContactDetails(text!), text).toBe(want);
    }
    // A date or a path is not two numbers.
    for (const text of ['Started 03/2021, left 11/2024', 'Signed 12/03/2024']) {
      expect(withoutContactDetails(text), text).toBe(text);
    }
    expect(personalDetailIn('Tel/Fax: 617-555-0199/617-555-0100')).toBeNull();
  });

  /*
   * Three or more in a chain, a bracketed area code after the "/", and a
   * phone with its last digits written again after one. Each was asked about
   * one "/" at a time with the others left in, so a number between two "/"s
   * never stood alone and the older numbers went to the AI whole.
   */
  it('takes out every number of a chain, a bracketed pair, and a short second ending', () => {
    for (const [text, want] of [
      ['Phones: 415-555-0123/650-555-0100/212-555-0199', 'Phones: [phone number]/[phone number]/[phone number]'],
      ['Tel 4155550123/6505550100/2125550199', 'Tel [phone number]/[phone number]/[phone number]'],
      ['Tel: (415) 555-0123/(650) 555-0100', 'Tel: [phone number]/[phone number]'],
      ['Cell 415-555-0123/0199', 'Cell [phone number]'],
      ['Cell 415-555-0123/99, evenings', 'Cell [phone number], evenings'],
    ]) {
      expect(withoutContactDetails(text!), text).toBe(want);
    }
    // And what `personalDetailIn` says of them is what it said before.
    expect(personalDetailIn('Phones: 415-555-0123/650-555-0100/212-555-0199')).toBe(personalDetailIn('Phones: 415-555-0123/650-555-0100'));
  });

  /*
   * Split at every "/" between digits, the half after an order number, a
   * year or a build was a phone on its own, and the identifier became
   * "[phone number]". A "/" is a break only between two numbers that are
   * each a phone, and never inside a path.
   */
  it('leaves an identifier with a "/" in it alone', () => {
    for (const text of [
      'Order 42/0012345678 shipped',
      'Ref 2024/1234567890',
      'see /api/v2/1234567890',
      'build 2/0123456789 passed',
      'Ticket 123-456-7890/1',
      'Ticket 123-456-7890/12/3',
      'Order 4155550123/0199',
      'Case no. 3/2024/12345678',
      'Coverage 98/100000000',
      'Project page: example.org/p/2024/4155550123',
    ]) {
      expect(withoutContactDetails(text), text).toBe(text);
    }
    // And still two phones, written with spaces in them.
    expect(withoutContactDetails('Call 617 555 0199/617 555 0100 any time')).toBe('Call [phone number]/[phone number] any time');
    expect(withoutContactDetails('+1 415 555 1234/+1 415 555 9876')).toBe('[phone number]/[phone number]');
  });

  /*
   * The same shapes `personalDetailIn` refuses, so the corpus of its verdicts
   * holds for this too: text it lets through is left exactly as it was, and
   * text it refuses for a phone, an email or a street is no longer refused
   * for that once scrubbed.
   */
  it('agrees with every verdict in the privacy corpus', () => {
    const { cases } = JSON.parse(
      fs.readFileSync(new URL('./fixtures/corpus-privacy.json', import.meta.url), 'utf8'),
    ) as { cases: { input: string | { parts: string[] }; expect: unknown; todo?: string }[] };
    const scrubbed = ['an email address', 'a phone number', 'a street address'];
    for (const c of cases) {
      if (c.todo) continue;
      const text = typeof c.input === 'string' ? c.input : c.input.parts.join('');
      const verdict = personalDetailIn(text);
      if (verdict === null) expect(withoutContactDetails(text), text).toBe(text);
      else if (scrubbed.includes(verdict)) {
        expect(scrubbed, text).not.toContain(personalDetailIn(withoutContactDetails(text)));
      }
    }
  });
});

describe('what reaches the AI', () => {
  const letter: CoverLetter = {
    id: '2025-01-01-globex-engineer',
    title: 'Engineer — Globex',
    company: 'Globex',
    role: 'Engineer',
    createdAt: '2025-01-01T00:00:00.000Z',
    body: SIGNED,
  };
  const sample: WritingSample = { id: 'old-resume', title: 'My old resume', kind: 'resume', createdAt: '', text: OLD_RESUME };

  function withWriting(): { data: StoreData; cleanup: () => void } {
    const t = makeTempStore();
    const data = t.store.load();
    data.coverLetters = [letter];
    data.samples = [sample];
    return { data, cleanup: t.cleanup };
  }

  it('the voice samples every prompt is given', () => {
    const { data, cleanup } = withWriting();
    try {
      const voice = renderVoiceContext(buildVoiceContext(data));
      expect(voice).toContain('building streaming pipelines');
      expect(voice).toContain('Kafka ingestion pipeline');
      expect(leaks(voice)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("a cover letter's prompt for another employer", () => {
    const { data, cleanup } = withWriting();
    try {
      const prompt = coverLetterPrompt(
        data,
        resolveResume('base', data),
        { company: 'Helios Robotics', jobTitle: 'Platform Engineer', jobDescription: 'Kafka and Go.' },
        [letter],
      );
      expect(prompt).toContain('building streaming pipelines');
      expect(leaks(prompt)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('find_my_letters and check_claim', () => {
    const session = new WritingSession(
      { coverLetters: [letter], answers: [] },
      { id: 'base', label: 'Base', sections: [], profile: { name: 'Morgan Testwell' } },
      { company: 'Helios', description: 'Kafka.' },
      { coverLetter: { required: true, body: '' }, questions: [] },
      'Morgan Testwell',
    );
    const found = session.findLetters('streaming pipelines', 3);
    expect(found).toContain('building streaming pipelines');
    expect(leaks(found)).toEqual([]);
    // What `check_claim` quotes back is read out of the same words.
    const own = (session as unknown as { ownWords: { text: string }[] }).ownWords;
    expect(own.map((w) => leaks(w.text)).flat()).toEqual([]);
  });

  it('the session file written into the AI\'s working directory', () => {
    const { data, cleanup } = withWriting();
    const sandbox = tempDir('rmm-scrub-sandbox-');
    try {
      wireUp(
        sandbox,
        'claude',
        {
          kind: 'write',
          data,
          resume: resolveResume('base', data),
          posting: { company: 'Helios Robotics', description: 'Kafka.' },
          draft: { coverLetter: { required: true, body: '' }, questions: [] },
          resumeText: 'x',
        } as Parameters<typeof wireUp>[2],
        '/somewhere/bin.js',
      );
      const raw = fs.readFileSync(path.join(sandbox, 'tailor-session.json'), 'utf8');
      expect(raw).toContain('building streaming pipelines');
      expect(leaks(raw)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

/*
 * Round 27: a date and the hour after it are ten digits up to the ":", and
 * were read as a phone — "2024-10-14 12:00" came out "[phone number]:00".
 */
describe('a date and time', () => {
  it('is not a phone number, written year first or day first', () => {
    for (const text of ['2024-10-14 12:00', 'Interview on 2026-10-14 08:15:30', 'Termin am 14.10.2026 12:00']) {
      expect(withoutContactDetails(text), text).toBe(text);
      expect(personalDetailIn(text), text).toBeNull();
    }
    // A phone beside one is still a phone.
    expect(withoutContactDetails('Call 617-555-0134 on 2024-10-14 12:00')).toBe('Call [phone number] on 2024-10-14 12:00');
    // And a month that is no month is not a date.
    expect(withoutContactDetails('2024-55-14 12:00')).toBe('[phone number]:00');
  });
});
