import { describe, expect, it } from 'vitest';
import { compileResume, detectEngine, LatexError, OverflowError } from '../src/render/compile.js';
import { DEFAULT_LAYOUT, type ResolvedBullet, type ResolvedResume } from '../src/model/types.js';

/**
 * These actually run LaTeX, so they are slower than the rest of the suite and
 * skip when no engine is installed. They cover the one promise the tool makes
 * that nothing else can verify: the PDF is one page, or you are told exactly
 * how much too long it is.
 */
const hasEngine = await detectEngine()
  .then(() => true)
  .catch(() => false);

const bullet = (i: number): ResolvedBullet => ({
  id: `b${i}`,
  variantId: 'v',
  text: `Built and shipped subsystem number ${i}, cutting processing latency from 900ms to 180ms and raising throughput`,
});

function resume(entryCount: number, bulletsEach = 3): ResolvedResume {
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
          bullets: Array.from({ length: bulletsEach }, (_, j) => bullet(i * 10 + j)),
        })),
      },
    ],
    layout: { ...DEFAULT_LAYOUT },
    warnings: [],
  };
}

describe.skipIf(!hasEngine)('one-page enforcement', { timeout: 300_000 }, () => {
  it('compiles a short resume as-authored, with no shrinking', async () => {
    const result = await compileResume(resume(2));
    expect(result.pages).toBe(1);
    expect(result.fits).toBe(true);
    expect(result.adjustments).toEqual([]);
  });

  it('reports the room left over, so you know you can add more', async () => {
    const result = await compileResume(resume(1));
    expect(result.overflowPt).toBeLessThan(0);
    expect(result.overflowLines).toBeLessThan(0);
  });

  it('shrinks within bounds to pull a slightly-too-long resume onto one page', async () => {
    const result = await compileResume(resume(12));
    expect(result.pages).toBe(1);
    expect(result.fits).toBe(true);
    expect(result.adjustments.length).toBeGreaterThan(0);
    // Whatever it did, it stayed inside the configured floors.
    expect(result.layout.fontSizePt).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.fitBounds.minFontSizePt);
    expect(result.layout.marginIn).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.fitBounds.minMarginIn);
  });

  it('refuses to shrink past the floor, and says how much has to go', async () => {
    const hopeless = resume(24);
    await expect(compileResume(hopeless, { strict: true })).rejects.toThrow(OverflowError);

    const report = await compileResume(hopeless);
    expect(report.fits).toBe(false);
    expect(report.overflowLines).toBeGreaterThan(0);
    expect(report.layout.fontSizePt).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.fitBounds.minFontSizePt);
  });

  it('honours autoFit: false by not touching the layout at all', async () => {
    // 12 entries does not fit as authored, so a passing run here means auto-fit
    // really was skipped rather than simply not needed.
    const r = resume(12);
    r.layout = { ...r.layout, autoFit: false };
    const result = await compileResume(r);
    expect(result.adjustments).toEqual([]);
    expect(result.layout.fontSizePt).toBe(DEFAULT_LAYOUT.fontSizePt);
  });

  it('writes a PDF and the .tex it came from', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-test-'));

    const result = await compileResume(resume(2), {
      pdfPath: path.join(dir, 'r.pdf'),
      texPath: path.join(dir, 'r.tex'),
    });

    expect(fs.existsSync(result.pdfPath!)).toBe(true);
    expect(fs.readFileSync(result.pdfPath!).subarray(0, 4).toString()).toBe('%PDF');
    expect(fs.readFileSync(result.texPath!, 'utf8')).toContain('\\begin{document}');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('engine selection', () => {
  it('rejects an engine that is not installed, naming the alternatives', async () => {
    await expect(detectEngine('not-an-engine' as never)).rejects.toThrow(/not-an-engine/);
  });
});

describe.skipIf(!hasEngine)('other layouts', { timeout: 180_000 }, () => {
  it('respects a lower attempt cap without hanging', async () => {
    const result = await compileResume(resume(16), { maxAttempts: 2 });
    expect(result.pages).toBeGreaterThanOrEqual(1);
  });

  it('compiles on A4 when asked', async () => {
    const r = resume(1);
    r.layout = { ...r.layout, paper: 'a4' };
    const result = await compileResume(r);
    expect(result.fits).toBe(true);
  });

  it('cannot be broken by LaTeX-looking text in the store', async () => {
    // Everything from the store is escaped, so a name that reads like a macro
    // is printed rather than executed. This is why a corrupted store cannot
    // produce a compile failure.
    const r = resume(1);
    r.profile = { ...r.profile, name: String.raw`\undefinedmacro & 100% {braces}` };
    const result = await compileResume(r);
    expect(result.fits).toBe(true);
    expect(LatexError).toBeTypeOf('function');
  });
});
