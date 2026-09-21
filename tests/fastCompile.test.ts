import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileResume, plausiblePageCount } from '../src/render/compile.js';
import { compileFast, compileFastBody, hasFastPath, resetFastPathCache } from '../src/render/fastCompile.js';
import { DEFAULT_LAYOUT, type ResolvedBullet, type ResolvedResume } from '../src/model/types.js';

const available = await hasFastPath();

const bullet = (i: number): ResolvedBullet => ({
  id: `b${i}`,
  variantId: 'v',
  text: `Built subsystem ${i}, cutting latency from 900ms to 180ms and raising throughput`,
});

function resume(entryCount: number, overrides: Partial<ResolvedResume['layout']> = {}): ResolvedResume {
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
          bullets: [bullet(i)],
        })),
      },
    ],
    layout: { ...DEFAULT_LAYOUT, ...overrides },
    warnings: [],
  };
}

describe.skipIf(!available)('the precompiled-format fast path', { timeout: 120_000 }, () => {
  it('produces a real PDF', async () => {
    const raw = await compileFast(resume(2), resume(2).layout);
    expect(raw.pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(raw.aux).toContain('zref@newlabel');
  });

  it('is markedly faster than the trusted engine on the same document', async () => {
    resetFastPathCache();
    await hasFastPath(); // warm the availability check, not the format cache

    /*
     * The one test that must actually run the engine.
     *
     * Everything else in the suite is happy to be answered from the compiled-
     * document cache `tests/setup.ts` switches on, which is the point of it.
     * Here the number being compared *is* the engine's running time, and a
     * cache hit would time a file copy instead — reporting the trusted path as
     * faster than the fast one, or, worse, passing for the wrong reason.
     */
    const saved = process.env.RMM_COMPILE_CACHE;
    delete process.env.RMM_COMPILE_CACHE;
    try {
      const r = resume(2);
      const t0 = Date.now();
      await compileFast(r, r.layout);
      const fastMs = Date.now() - t0;

      const t1 = Date.now();
      await compileResume(r, {}); // default mode: 'final', the trusted engine
      const trustedMs = Date.now() - t1;

      // The format is now warm; a second fast compile should not pay the
      // package-loading cost the trusted engine pays on every run.
      const t2 = Date.now();
      await compileFast(r, r.layout);
      const warmFastMs = Date.now() - t2;

      expect(warmFastMs).toBeLessThan(trustedMs);
      void fastMs;
    } finally {
      if (saved === undefined) delete process.env.RMM_COMPILE_CACHE;
      else process.env.RMM_COMPILE_CACHE = saved;
    }
  });

  it('is used, and reported as used, through the preview mode', async () => {
    const result = await compileResume(resume(1), { mode: 'preview' });
    expect(result.fastPath).toBe(true);
    expect(result.fits).toBe(true);
  });

  it('defaults to the trusted engine when no mode is given', async () => {
    const result = await compileResume(resume(1));
    expect(result.fastPath).toBe(false);
  });

  it('never uses the shortcut for a plain compile, even if available', async () => {
    const result = await compileResume(resume(1), { mode: 'final' });
    expect(result.fastPath).toBe(false);
  });

  it('paginates correctly under realistic content overflow', async () => {
    const overflowing = resume(24, { autoFit: false });
    const result = await compileResume(overflowing, { mode: 'preview' });
    expect(result.pages).toBeGreaterThan(1);
    expect(result.fits).toBe(false);
  });

  it(
    'falls back to the trusted engine when its own page count and height measurement disagree',
    async () => {
      /*
       * A margin large enough to leave under two lines of text height: the
       * layout where a raw `pdftex -fmt=` run was under-reporting the page
       * break while its own height measurement stayed correct.
       *
       * That disagreement turned out to be the layout never reaching the fast
       * path at all — the format skips the document's preamble, so the margin
       * being tested here was one of the settings thrown away. With the layout
       * dumped into the format the two engines now return the same twelve
       * pages and the same 1520.3pt, so the guard has nothing to catch and the
       * shortcut is used. It stays in place regardless: it costs one
       * comparison and it is the only thing standing between a preview that
       * contradicts itself and a user being told an impossible "fits".
       */
      const pathological = resume(6, { marginIn: 4.6, autoFit: false });
      const result = await compileResume(pathological, { mode: 'preview' });
      const trusted = await compileResume(pathological, { mode: 'final' });

      expect(result.fits).toBe(false);
      expect(result.pages).toBeGreaterThan(1);
      // And whichever engine answered, it answered the same thing.
      expect(result.pages).toBe(trusted.pages);
      expect(result.usedPt).toBeCloseTo(trusted.usedPt, 1);
    },
  );

  /*
   * And says so about the attempt that shipped, not about one that was
   * thrown away.
   *
   * The shortcut is only ever tried for the layout as authored, because the
   * format it loads has the layout baked into it and every shrinking step
   * would dump a fourteen-megabyte format of its own. So a resume that does
   * not fit as authored uses the shortcut once, is then shrunk and
   * recompiled by the trusted engine, and ships that PDF — while the flag,
   * set by the first attempt and never cleared, still said the shortcut
   * produced it. `/render/resume` prints that straight out as
   * "tectonic (fast preview)" over a preview tectonic alone had made.
   *
   * Not a cosmetic label: it is the one thing in the response that says
   * whether the number beside it came from the engine that is trusted with
   * the final document or from the one that is not.
   */
  it('does not claim the shortcut for a preview the fit loop recompiled', async () => {
    const tooLong = resume(24);
    expect(tooLong.layout.autoFit, 'the fit loop is what this is about').toBe(true);
    const result = await compileResume(tooLong, { mode: 'preview' });
    // The authored layout really did overflow, so the loop really did run.
    expect(result.adjustments.length > 0 || result.fits === false).toBe(true);
    expect(result.fastPath).toBe(false);
  });

  it('falls back per-attempt, not for the whole compile, once the guard clears', async () => {
    // A resume that fits comfortably at ordinary margins should still use the
    // fast path even though *some* pathological layout elsewhere would not.
    const fine = resume(1);
    const result = await compileResume(fine, { mode: 'preview' });
    expect(result.fastPath).toBe(true);
  });
});

/**
 * Watch the format cache with a cache of its own.
 *
 * The real one is a fixed path under the system temp directory, shared by
 * every process on the machine — including the other vitest workers, which
 * compile previews of their own. A test that wants to see a *cold* build has
 * to either use a layout nothing else uses or delete what it finds, and both
 * turn into a race: the cache key is a hash of the preamble, the preamble
 * rounds its lengths to three decimals, so "an unusual margin" collapses onto
 * the ordinary one and the cleanup takes out a 7MB file another worker is
 * halfway through using. Hence `RMM_FMT_CACHE`: an empty directory per test,
 * every build cold by construction, and nothing shared to race over.
 */
async function withACacheOfItsOwn<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const was = process.env.RMM_FMT_CACHE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fmt-test-'));
  process.env.RMM_FMT_CACHE = dir;
  resetFastPathCache(); // nothing built in the old cache counts towards this one
  await hasFastPath();
  try {
    return await run(dir);
  } finally {
    if (was === undefined) delete process.env.RMM_FMT_CACHE;
    else process.env.RMM_FMT_CACHE = was;
    resetFastPathCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const formatsIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

const HELLO = '\\begin{document}\nHello.\n\\end{document}\n';

describe.skipIf(!available)('what the fast path does with a body it cannot use', { timeout: 120_000 }, () => {
  it('runs a body’s own preamble instead of eating it', async () => {
    /*
     * A format built by mylatexformat skips everything before
     * `\begin{document}`, because that is how it avoids recompiling the
     * preamble it already holds. `\endofdump` is what tells it to stop
     * skipping — and the line writing it lost its backslash to a JavaScript
     * escape, so the marker never reached TeX and anything a body put above
     * `\begin{document}` vanished without a word.
     *
     * Nothing puts settings there today; the layout travels in the format.
     * This is here so that the day something does, it takes effect rather
     * than disappearing. Two inches of text height is loud enough to see
     * from the page count: skipped, this is one page.
     */
    const body = `\\setlength{\\textheight}{2in}
\\begin{document}
${Array.from({ length: 40 }, (_, i) => `Line ${i} of a body long enough to run over several pages once the text height is cut.\\par`).join('\n')}
\\end{document}
`;
    const raw = await compileFastBody(body, 'letter', DEFAULT_LAYOUT);
    const pages = Number(/Output written on .*?\((\d+) page/.exec(raw.log)?.[1]);
    expect(pages).toBeGreaterThan(1);
  });

  it('says what the TeX error was, not just that something failed', async () => {
    await expect(
      compileFastBody('\\begin{document}\n\\thisIsNotACommand\n\\end{document}\n', 'letter', DEFAULT_LAYOUT),
    ).rejects.toThrow(/Undefined control sequence/);
  });

  it('names the construct that was left open', async () => {
    await expect(
      compileFastBody('\\begin{document}\n\\begin{itemize}\nx\n\\end{document}\n', 'letter', DEFAULT_LAYOUT),
    ).rejects.toThrow(/\\begin\{itemize\}/);
  });

  it('refuses a compile that produced no pages, rather than handing back an empty file', async () => {
    // pdftex reports "No pages of output" and *exits cleanly* here, leaving a
    // zero-byte resume.pdf. Waving that through gives the preview an empty
    // buffer and no error to explain the blank frame.
    await expect(compileFastBody('\\begin{document}\n\\end{document}\n', 'letter', DEFAULT_LAYOUT)).rejects.toThrow(
      /produced no PDF/,
    );
  });

  it('reports a format that will not build, and leaves nothing behind', async () => {
    await withACacheOfItsOwn(async (dir) => {
      // A layout whose runtime setup is not valid TeX: \changefontsizes[NaNpt].
      const broken = { ...DEFAULT_LAYOUT, fontSizePt: Number.NaN };
      await expect(compileFastBody(HELLO, 'letter', broken)).rejects.toThrow();
      expect(formatsIn(dir)).toEqual([]);
    });
  });

  it('tries again after a build that failed, rather than remembering the failure', async () => {
    /*
     * A failed build is not cached, so a compile that failed for a reason that
     * has since gone away works on the next try — without it, one unwritable
     * moment poisons that layout for the life of the process and the preview
     * stays broken until the editor is restarted.
     *
     * The failure has to be one that can be undone without changing the
     * layout, because the layout is the cache key. A cache directory that is
     * a file rather than a directory is exactly that: the build cannot even
     * mkdir, and removing the file fixes it.
     */
    const was = process.env.RMM_FMT_CACHE;
    const spot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fmt-test-')), 'cache');
    fs.writeFileSync(spot, 'not a directory', 'utf8');
    process.env.RMM_FMT_CACHE = spot;
    resetFastPathCache();
    await hasFastPath();
    try {
      await expect(compileFastBody(HELLO, 'letter', DEFAULT_LAYOUT)).rejects.toThrow();

      fs.rmSync(spot, { force: true }); // the obstruction goes; nothing else changes
      const raw = await compileFastBody(HELLO, 'letter', DEFAULT_LAYOUT);
      expect(raw.pdf.subarray(0, 4).toString()).toBe('%PDF');
    } finally {
      if (was === undefined) delete process.env.RMM_FMT_CACHE;
      else process.env.RMM_FMT_CACHE = was;
      resetFastPathCache();
      fs.rmSync(path.dirname(spot), { recursive: true, force: true });
    }
  });
});

describe.skipIf(!available)('the format cache', { timeout: 120_000 }, () => {
  it('builds a format for a layout it has never seen', async () => {
    await withACacheOfItsOwn(async (dir) => {
      expect(formatsIn(dir)).toEqual([]);
      const raw = await compileFastBody(HELLO, 'letter', DEFAULT_LAYOUT);
      expect(raw.pdf.subarray(0, 4).toString()).toBe('%PDF');
      expect(formatsIn(dir)).toHaveLength(1);
    });
  });

  it('builds one format per layout, not one per compile', async () => {
    await withACacheOfItsOwn(async (dir) => {
      await compileFastBody(HELLO, 'letter', DEFAULT_LAYOUT);
      await compileFastBody(HELLO, 'letter', DEFAULT_LAYOUT);
      expect(formatsIn(dir)).toHaveLength(1);
      await compileFastBody(HELLO, 'letter', { ...DEFAULT_LAYOUT, marginIn: 0.9 });
      expect(formatsIn(dir)).toHaveLength(2);
    });
  });

  it('reuses the one on disk after the in-memory cache is dropped', async () => {
    await withACacheOfItsOwn(async (dir) => {
      await compileFastBody(HELLO, 'letter', DEFAULT_LAYOUT);
      const built = formatsIn(dir)[0] as string;
      const stamp = fs.statSync(path.join(dir, built)).mtimeMs;

      resetFastPathCache(); // a fresh process knows nothing; the disk still does
      await hasFastPath();

      const raw = await compileFastBody(HELLO, 'letter', DEFAULT_LAYOUT);
      expect(raw.pdf.subarray(0, 4).toString()).toBe('%PDF');
      // The count would be unchanged either way — a rebuild copies over the
      // same path. The mtime is what tells them apart.
      expect(fs.statSync(path.join(dir, built)).mtimeMs).toBe(stamp);
    });
  });
});

describe('availability check', () => {
  it('is cheap to call repeatedly', async () => {
    const a = await hasFastPath();
    const b = await hasFastPath();
    expect(a).toBe(b);
  });

  it('says no, rather than throwing, when pdftex is not on the path', async () => {
    const realPath = process.env.PATH;
    resetFastPathCache();
    try {
      process.env.PATH = path.join(os.tmpdir(), 'rmm-definitely-not-a-bin-dir');
      await expect(hasFastPath()).resolves.toBe(false);
    } finally {
      process.env.PATH = realPath;
      resetFastPathCache();
    }
  });
});

/*
 * The shortcut checking its own answer.
 *
 * `pdftex -fmt=` returns a page count and a measured content height from the
 * same run, and they have to roughly agree; when they do not, the attempt
 * goes to the trusted engine. Tested on the numbers rather than through a
 * compile because the layout that used to provoke the disagreement no longer
 * does — the guard is defence against an engine, and an engine that is
 * behaving cannot be asked to misbehave for a test.
 */
describe('whether a run agrees with itself about how many pages it made', () => {
  const layout = { ...DEFAULT_LAYOUT };
  const pagePt = (11 - layout.marginIn * 2) * 72;

  it('believes a page that is full, and one that is a hair over', () => {
    expect(plausiblePageCount(1, pagePt * 0.8, layout)).toBe(true);
    // `\raggedbottom` and the depth of the last line: a page that fits can
    // measure a little past its own text height, and refusing those would
    // send every nearly-full resume to the slow engine.
    expect(plausiblePageCount(1, pagePt + 8, layout)).toBe(true);
  });

  /*
   * And not a run that says one page over content half a page taller than
   * one. This is the case the guard was built for and the case it let
   * through: written as `pages + 1 >= least`, it only rejected a
   * disagreement of two pages or more, so an under-report by exactly one
   * passed — and a two-page resume came back "1 page, fits".
   */
  it('does not believe one page of content that is half a page longer', () => {
    expect(plausiblePageCount(1, pagePt * 1.5, layout)).toBe(false);
    expect(plausiblePageCount(1, pagePt * 2.4, layout)).toBe(false);
    expect(plausiblePageCount(2, pagePt * 2.9, layout)).toBe(false);
  });

  it('believes the honest multi-page answers', () => {
    expect(plausiblePageCount(2, pagePt * 1.5, layout)).toBe(true);
    expect(plausiblePageCount(3, pagePt * 2.4, layout)).toBe(true);
  });

  it('never asks for less than one page, however little there is on it', () => {
    expect(plausiblePageCount(1, 0, layout)).toBe(true);
    expect(plausiblePageCount(1, 12, layout)).toBe(true);
  });
});
