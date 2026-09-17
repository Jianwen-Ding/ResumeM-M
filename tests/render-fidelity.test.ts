/**
 * The rendering pipeline, tested where the page it measures and the page it
 * produces can come apart.
 *
 * All four of these began as reproductions and all four failed. They are kept
 * because each one is silent: a preview that reports on a document nobody
 * asked for, a PDF whose words an applicant tracking system cannot read, a
 * letter that goes out unsigned. Nothing throws, and nothing looks wrong on
 * screen.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { compileLetter, compileResume, detectEngine } from '../src/render/compile.js';
import { DEFAULT_LAYOUT, type ResolvedResume } from '../src/model/types.js';

const run = promisify(execFile);
const hasEngine = await detectEngine().then(() => true).catch(() => false);
const hasPdfInfo = await run('pdfinfo', ['-v']).then(() => true).catch(() => true);

const bullet = (i: number, text?: string) => ({
  id: `b${i}`,
  variantId: 'v',
  text: text ?? `Built and shipped subsystem number ${i}, cutting processing latency from 900ms to 180ms and raising throughput`,
});

function resume(entryCount: number, layout: Partial<typeof DEFAULT_LAYOUT> = {}): ResolvedResume {
  return {
    id: 'test',
    label: 'Test',
    profile: { name: 'Test Person', email: 'a@b.com' },
    sections: [
      {
        kind: 'experience',
        heading: 'Experience',
        skillGroups: [],
        entries: Array.from({ length: entryCount }, (_, i) => ({
          id: `e${i}`,
          kind: 'experience' as const,
          title: `Company ${i}`,
          dates: 'Jul. 2024 -- Dec. 2024',
          subtitle: 'Software Engineer',
          location: 'Boston, MA',
          bullets: Array.from({ length: 3 }, (_, j) => bullet(i * 10 + j)),
        })),
      },
    ],
    layout: { ...DEFAULT_LAYOUT, ...layout },
    warnings: [],
  };
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-bugproof-'));
}

async function pdfPages(file: string): Promise<number> {
  const { stdout } = await run('pdfinfo', [file]);
  return Number(/Pages:\s*(\d+)/.exec(stdout)![1]);
}

describe.runIf(hasEngine && hasPdfInfo)('rendering pipeline bugs', { timeout: 300_000 }, () => {
  /*
   * BUG 1 — the highest-harm one.
   *
   * A format built by mylatexformat skips everything in the document file up to
   * `\begin{document}`, so `renderLatexFastBody`'s `runtimeSetup(layout)` — font
   * size, margins, \rmmunit, \textheight — is silently discarded. The preview
   * always renders at the stable preamble's defaults, and the fit verdict
   * describes that document instead of the real one.
   *
   * At 14pt/1.2in margins, five entries genuinely need two pages. Preview mode
   * renders them at 11pt with `fullpage` margins, fits them on one, and reports
   * "fits, 1 page, a line of room to spare".
   */
  it('preview mode does not claim a two-page resume fits on one', async () => {
    const dir = tmp();
    try {
      const layout = { fontSizePt: 14, marginIn: 1.2, autoFit: false };
      const final = await compileResume(resume(5, layout), {
        pdfPath: path.join(dir, 'final.pdf'),
        mode: 'final',
      });
      const preview = await compileResume(resume(5, layout), {
        pdfPath: path.join(dir, 'preview.pdf'),
        mode: 'preview',
      });

      expect(final.pages).toBe(2);
      expect(final.fits).toBe(false);

      // The whole promise of the preview: the same answer, faster.
      expect(preview.pages).toBe(final.pages);
      expect(preview.fits).toBe(final.fits);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * BUG 2 — the same root cause, seen in the bytes. `/render` writes this PDF
   * into the store's out directory and the editor shows it. It is a different
   * document from the one `rmm build` produces.
   */
  it('the preview PDF is the same document as the trusted PDF', async () => {
    const dir = tmp();
    try {
      const final = path.join(dir, 'f.pdf');
      const preview = path.join(dir, 'p.pdf');
      await compileResume(resume(6), { pdfPath: final, mode: 'final' });
      await compileResume(resume(6), { pdfPath: preview, mode: 'preview' });
      expect(await pdfPages(preview)).toBe(await pdfPages(final));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * BUG 3 — `\usepackage[T1]{fontenc}` with no scalable T1 font installed falls
   * back to METAFONT bitmaps, which pdftex embeds as Type 3 fonts with no
   * ToUnicode map. `\input{glyphtounicode}` and `\pdfgentounicode=1` cannot help
   * a Type 3 font, so every f-ligature comes back out of the PDF as a control
   * character: "Firefly Office Staff Engineer" extracts as
   * "Fire\x1dy O\x1ece Sta\x1b Engineer". An ATS reads the garbage.
   *
   * tests/pdf-text.test.ts misses this only because none of its fixtures
   * contain fi/fl/ff.
   */
  it('gives an applicant tracking system words that contain ligatures', async () => {
    const dir = tmp();
    try {
      const r = resume(1);
      r.sections[0]!.entries[0]!.title = 'Firefly Office';
      r.sections[0]!.entries[0]!.subtitle = 'Staff Engineer';
      r.sections[0]!.entries[0]!.bullets = [
        bullet(0, 'Classified workflows efficiently; fixed flaky affinity offloading'),
      ];
      const pdf = path.join(dir, 'lig.pdf');
      await compileResume(r, { pdfPath: pdf });
      const { stdout } = await run('pdftotext', [pdf, '-']);

      for (const word of ['Firefly', 'Office', 'Staff', 'Classified', 'workflows', 'efficiently', 'fixed', 'flaky', 'affinity', 'offloading']) {
        expect(stdout, `"${word}" is not extractable from the PDF`).toContain(word);
      }
      /*
       * And no control characters standing in for glyphs. Form feed is
       * pdftotext's own page separator and tab and newline are ordinary; the
       * rest of C0 appearing in extracted text means a glyph came back with
       * no Unicode behind it, which is exactly the failure this is about.
       */
      // eslint-disable-next-line no-control-regex
      const control = [...new Set([...stdout].filter((c) => c.charCodeAt(0) < 32 && !'\n\t\f'.includes(c)))];
      /*
       * Named with their surroundings, because "a control character appeared"
       * is not actionable and "\x15 in 'Jul. 2024 ... Dec. 2024'" is: that one
       * was the en dash in every date range on every resume.
       */
      const where = control.map((c) => {
        const at = stdout.indexOf(c);
        return `${c.charCodeAt(0).toString(16)} in ${JSON.stringify(stdout.slice(Math.max(0, at - 25), at + 25))}`;
      });
      expect(where.join(' | '), 'control characters in the extracted text').toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * BUG 4 — `hasSignOff` searches the last four lines for the bare words
   * "sincerely|regards|best|thank you|yours" at end of line. A paragraph that
   * merely contains one of them suppresses the closing, and the letter is sent
   * with no "Sincerely," and no name.
   */
  it('signs a letter whose body merely mentions "my best"', async () => {
    const dir = tmp();
    try {
      const pdf = path.join(dir, 'letter.pdf');
      await compileLetter(
        {
          profile: { name: 'Jane Doe', email: 'jane@x.com' },
          company: 'Acme',
          body: 'I am a strong fit for this role.\n\nI do my best\n\nI look forward to talking.',
          date: 'January 1, 2026',
        },
        { ...DEFAULT_LAYOUT },
        { pdfPath: pdf },
      );
      const { stdout } = await run('pdftotext', [pdf, '-']);
      expect(stdout).toContain('Sincerely');
      // The name must appear twice: once in the header, once as the signature.
      expect(stdout.split('Jane Doe').length - 1).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
