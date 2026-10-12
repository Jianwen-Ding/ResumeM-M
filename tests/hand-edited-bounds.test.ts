/**
 * Fit and grow bounds edited by hand past what can be set.
 *
 * `checkLayoutNumbers` refuses a font, margin or spacing TeX cannot take, so
 * that a save edited by hand says which setting is wrong rather than failing
 * eight times deep in TeX. But the search hands it layouts made from the
 * bounds as well as from the layout, so `fitBounds.minFontSizePt: 2` refused
 * the whole build and blamed "font size (fontSizePt)" for a number that is
 * not the font size — and every build of that resume failed, where before
 * the check it had built fine. The bounds are how far the search may go; a
 * bound past what can be set is the furthest that can, and one that is not a
 * number is the default.
 */
import { describe, expect, it } from 'vitest';
import { compileResume, detectEngine, layoutAt, legalBounds } from '../src/render/compile.js';
import { runtimeSetup } from '../src/render/latex.js';
import { DEFAULT_LAYOUT, type LayoutOptions, type ResolvedResume } from '../src/model/types.js';

const hasEngine = await detectEngine().then(() => true).catch(() => false);

const withBounds = (fit: Record<string, unknown> = {}, grow: Record<string, unknown> = {}): LayoutOptions =>
  ({
    ...DEFAULT_LAYOUT,
    fitBounds: { ...DEFAULT_LAYOUT.fitBounds, ...fit },
    growBounds: { ...DEFAULT_LAYOUT.growBounds, ...grow },
  }) as LayoutOptions;

const handEdits: [string, LayoutOptions][] = [
  ['fitBounds.minFontSizePt: 2', withBounds({ minFontSizePt: 2 })],
  ['fitBounds.minSpacing: 0', withBounds({ minSpacing: 0 })],
  ['fitBounds.minMarginIn: -1', withBounds({ minMarginIn: -1 })],
  ['fitBounds.minFontSizePt: null', withBounds({ minFontSizePt: null })],
  ['growBounds.maxFontSizePt: 48', withBounds({}, { maxFontSizePt: 48 })],
  ['growBounds.maxSpacing: 50', withBounds({}, { maxSpacing: 50 })],
  ['growBounds.maxMarginIn: 6', withBounds({}, { maxMarginIn: 6 })],
  ['growBounds.maxFontSizePt: "big"', withBounds({}, { maxFontSizePt: 'big' })],
];

describe('a bound edited by hand past what can be set', () => {
  it.each(handEdits)('%s: every layout the search can reach is one the engine takes', (_, base) => {
    for (const t of [-1, -0.5, 0, 0.5, 1]) expect(() => runtimeSetup(layoutAt(base, t)), `t=${t}`).not.toThrow();
  });

  it('is taken as the furthest that can be set', () => {
    expect(layoutAt(withBounds({ minFontSizePt: 2 }), 1).fontSizePt).toBe(4);
    expect(layoutAt(withBounds({}, { maxFontSizePt: 48 }), -1).fontSizePt).toBe(40);
    expect(layoutAt(withBounds({ minSpacing: 0 }), 1).spacing).toBeGreaterThan(0);
    // Two inches of type left across a letter page at the widest.
    expect(layoutAt(withBounds({}, { maxMarginIn: 6 }), -1).marginIn).toBe(3.25);
  });

  it('and one that is not a number as the default', () => {
    expect(legalBounds(withBounds({ minFontSizePt: null })).fit.minFontSizePt).toBe(DEFAULT_LAYOUT.fitBounds.minFontSizePt);
    expect(legalBounds(withBounds({}, { maxFontSizePt: 'big' })).grow.maxFontSizePt).toBe(DEFAULT_LAYOUT.growBounds.maxFontSizePt);
  });

  it('leaves bounds that were fine as they were', () => {
    expect(legalBounds(DEFAULT_LAYOUT)).toEqual({ fit: DEFAULT_LAYOUT.fitBounds, grow: DEFAULT_LAYOUT.growBounds });
  });

  it('while the layout as written is still refused, by name', () => {
    expect(() => runtimeSetup({ ...DEFAULT_LAYOUT, fontSizePt: 2 })).toThrow(/font size \(fontSizePt\).*not 2/);
    expect(() => runtimeSetup({ ...DEFAULT_LAYOUT, spacing: 0 })).toThrow(/spacing.*not 0/);
    expect(() => runtimeSetup({ ...DEFAULT_LAYOUT, marginIn: 9 })).toThrow(/margin \(marginIn\)/);
  });
});

function resume(entryCount: number, layout: LayoutOptions): ResolvedResume {
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
          bullets: Array.from({ length: 4 }, (_, j) => ({
            id: `b${i}${j}`,
            variantId: 'v',
            text: `Built and shipped subsystem number ${i * 10 + j}, cutting processing latency from 900ms to 180ms and raising throughput`,
          })),
        })),
      },
    ],
    layout,
    warnings: [],
  } as ResolvedResume;
}

describe.skipIf(!hasEngine)('built with the real engine', () => {
  it('a long resume with fitBounds.minFontSizePt: 2 still builds', async () => {
    const r = await compileResume(resume(14, withBounds({ minFontSizePt: 2, minSpacing: 0 })));
    expect(r.pages).toBeGreaterThan(0);
    expect(r.layout.fontSizePt).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it('a short resume with growBounds.maxFontSizePt: 48 still builds', async () => {
    const r = await compileResume(resume(1, withBounds({}, { maxFontSizePt: 48 })));
    expect(r.pages).toBe(1);
    expect(r.layout.fontSizePt).toBeLessThanOrEqual(40);
  }, 120_000);
});
