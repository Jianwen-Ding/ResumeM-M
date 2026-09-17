/**
 * What the PDF actually says, read back out of the PDF.
 *
 * Every other test here checks the LaTeX we generate. That cannot catch the
 * failure this file exists for: source that is perfectly correct, compiles
 * without a murmur, and prints a different character than the one written.
 * Under the default OT1 encoding `<` sets as an inverted exclamation mark and
 * `|` as an em dash, so "Cut p99 latency to <100ms" reaches an employer
 * reading "¡100ms" — and nobody finds out, because the person who sent it
 * never re-reads the PDF and the person who received it assumes you meant it.
 *
 * The other half is machine readability. `\input{glyphtounicode}` and
 * `\pdfgentounicode=1` are in the preamble to make the text extractable, and
 * under OT1 they silently do not: an underscore is drawn rather than set and
 * carries no Unicode at all, so an applicant tracking system reads
 * `jane doe@x.com` off a resume whose contact line says `jane_doe@x.com`.
 *
 * So this compiles for real and extracts the text back with pdftotext.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileResume } from '../src/render/compile.js';
import { hasLatex } from './helpers.js';
import type { ResolvedResume } from '../src/model/types.js';
import { DEFAULT_LAYOUT } from '../src/model/types.js';

const run = promisify(execFile);
const latex = await hasLatex();
const hasPdfToText = await run('pdftotext', ['-v']).then(() => true).catch(() => false);

const resume = (bullets: string[], name = 'Jane Doe'): ResolvedResume => ({
  id: 'r',
  label: 'R',
  profile: { name, email: 'jane_doe@x.com', website: 'example.edu/~jane' },
  sections: [
    {
      kind: 'experience',
      heading: 'Experience',
      entries: [
        {
          id: 'e',
          kind: 'experience',
          title: 'Acme',
          bullets: bullets.map((text, i) => ({ id: `b${i}`, variantId: 'v', text })),
        },
      ],
      skillGroups: [],
    },
  ],
  layout: DEFAULT_LAYOUT,
  warnings: [],
});

async function textOf(r: ResolvedResume): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-pdftext-'));
  try {
    const pdfPath = path.join(dir, 'out.pdf');
    await compileResume(r, { pdfPath });
    const { stdout } = await run('pdftotext', [pdfPath, '-']);
    return stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.runIf(latex && hasPdfToText)('what the reader actually sees', () => {
  it('prints the characters that were written, not lookalikes', async () => {
    const text = await textOf(
      resume(['Cut p99 latency to <100ms', 'Owned C++ | Rust build tooling', 'Kept error rate >99.9%']),
    );
    expect(text).toContain('<100ms');
    expect(text).toContain('C++ | Rust');
    expect(text).toContain('>99.9%');
    // The OT1 substitutions, named so a regression says why it failed.
    expect(text).not.toContain('¡');
    expect(text).not.toContain('¿');
  }, 120_000);

  it('gives an applicant tracking system the contact details as written', async () => {
    const text = await textOf(resume(['Maintained the get_user_data pipeline']));
    expect(text).toContain('jane_doe@x.com');
    expect(text).toContain('~jane');
    expect(text).toContain('get_user_data');
  }, 120_000);

  /*
   * The f-ligatures, which are where this actually broke.
   *
   * T1 is a promise the fonts have to keep, and without a scalable T1 face
   * LaTeX falls back to METAFONT bitmaps — Type 3, with no ToUnicode map,
   * which `\pdfgentounicode` cannot build one for. So every word with an fi,
   * fl, ff or ffi in it came out of the PDF with a hole in it: "Firey Oce Sta
   * eciently classied workows". Those are ordinary words — office, staff,
   * efficiently, classified, workflows — on the one copy of the resume that
   * nobody reads and everybody parses.
   */
  it('gives it whole words where the type has ligatures', async () => {
    const text = await textOf(
      resume([
        'Classified workflows efficiently for the Firefly office staff',
        'Fixed flaky affinity offloading before the final office fit',
      ]),
    );
    for (const word of [
      'Classified', 'workflows', 'efficiently', 'Firefly', 'office', 'staff',
      'flaky', 'affinity', 'offloading', 'final', 'fit',
    ]) {
      expect(text, word).toContain(word);
    }
  }, 120_000);

  it('still sets the accents it always could', async () => {
    const text = await textOf(resume(['Worked at Nestlé on café software'], 'Zoë Müller'));
    expect(text).toContain('Zoë Müller');
    expect(text).toContain('Nestlé');
  }, 120_000);
});
