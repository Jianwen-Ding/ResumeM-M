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

  /*
   * Text that ran off the right-hand edge, which is the one loss the fit
   * report could not see.
   *
   * Everything about fitting here is vertical: how tall the content came out,
   * how many pages that took. Nothing asked how wide a line was, and TeX does
   * not break a word it cannot break — it sets a long link past the margin and
   * off the paper. The glyphs are not in the PDF, so `pdftotext` cannot find
   * them and neither can an applicant tracking system.
   *
   * Compiled with an ordinary Google Docs share link, this reported "✓ 1 page,
   * ~13 lines of room left", passed `strict`, returned no warnings — and the
   * link in the PDF ended `ouid=1234` where the one in the save ended
   * `ouid=1234567890`.
   *
   * Two assertions on purpose: that the text really does go missing (so the
   * warning is about something), and that the build now says so.
   */
  it('says when a line ran off the page, taking its text with it', async () => {
    const link =
      'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg/edit?usp=sharing&ouid=1234567890';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-toowide-'));
    try {
      const pdfPath = path.join(dir, 'out.pdf');
      const result = await compileResume(resume([`Wrote the runbook: ${link}`]), { pdfPath });
      const { stdout } = await run('pdftotext', [pdfPath, '-']);

      // The loss itself: the end of the link is not on the page.
      expect(stdout).toContain('docs.google.com');
      expect(stdout).not.toContain('ouid=1234567890');

      const said = result.warnings.join(' ');
      expect(said).toContain('past the right-hand edge');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /*
   * A save whose profile.yaml has lost its `name:` key.
   *
   * The heading ends with a `\\`, and with nothing in front of it TeX says
   * "There's no line here to end." — which is what reached the user, from
   * `rmm build`, `rmm check`, `rmm master` and the editor's live preview
   * alike, naming neither the field nor anything to do about it. The sentence
   * that says it properly already existed and was wired only into the bundle
   * builder, which is the last of the five places anybody meets this.
   */
  it('says what is missing when the save has no name, instead of TeX saying it', async () => {
    const nameless = { ...resume(['Cut p99 latency by a third']), profile: { email: 'jane@x.example' } };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-noname-'));
    try {
      const err = await compileResume(nameless as never, { pdfPath: path.join(dir, 'out.pdf') }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const said = (err as Error).message;
      expect(said).toContain('no name in it');
      expect(said).toContain('under Master');
      expect(said).not.toContain('no line here to end');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /*
   * And nothing said about a resume whose lines all fit, which is every
   * ordinary one. A warning that fires on the common case is a warning
   * people learn to scroll past.
   */
  it('says nothing about a resume whose lines fit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fits-'));
    try {
      const pdfPath = path.join(dir, 'out.pdf');
      const result = await compileResume(
        resume(['Cut p99 latency by a third', 'Owned the deploy pipeline end to end']),
        { pdfPath },
      );
      expect(result.warnings.join(' ')).not.toContain('past the right-hand edge');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
