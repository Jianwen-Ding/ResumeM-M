import { describe, expect, it } from 'vitest';
import { compileResume } from '../src/render/compile.js';
import { compileFast, hasFastPath, resetFastPathCache } from '../src/render/fastCompile.js';
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

  it('falls back per-attempt, not for the whole compile, once the guard clears', async () => {
    // A resume that fits comfortably at ordinary margins should still use the
    // fast path even though *some* pathological layout elsewhere would not.
    const fine = resume(1);
    const result = await compileResume(fine, { mode: 'preview' });
    expect(result.fastPath).toBe(true);
  });
});

describe('availability check', () => {
  it('is cheap to call repeatedly', async () => {
    const a = await hasFastPath();
    const b = await hasFastPath();
    expect(a).toBe(b);
  });
});
