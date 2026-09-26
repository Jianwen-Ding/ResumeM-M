/**
 * A page with room to spare, set as large as it allows.
 *
 * Auto-fit only ever shrank. A resume with three entries came out at 10.5pt
 * inside 0.45in margins with the bottom third of the page empty, and a cover
 * letter was set on the resume's page, 120 characters to the line across the
 * whole sheet. Asked for: "as large fonts and margins as possible without
 * leaking onto another page".
 */
import { describe, expect, it } from 'vitest';
import { compileLetter, compileResume, detectEngine } from '../src/render/compile.js';
import { letterLayout } from '../src/render/letter.js';
import { DEFAULT_LAYOUT, layoutFor, type ResolvedResume } from '../src/model/types.js';
import { makeTempStore } from './helpers.js';

const hasEngine = await detectEngine().then(() => true).catch(() => false);

const bullet = (i: number) => ({
  id: `b${i}`,
  variantId: 'v',
  text: `Built and shipped subsystem number ${i}, cutting processing latency from 900ms to 180ms and raising throughput`,
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
  } as ResolvedResume;
}

describe.skipIf(!hasEngine)('a resume with room to spare', () => {
  it('is set larger, on the same one page', async () => {
    const r = await compileResume(resume(2));
    expect(r.fits).toBe(true);
    expect(r.pages).toBe(1);
    expect(r.grew).toBe(true);
    expect(r.layout.fontSizePt).toBeGreaterThan(DEFAULT_LAYOUT.fontSizePt);
    expect(r.layout.marginIn).toBeGreaterThan(DEFAULT_LAYOUT.marginIn);
    // And says what it did, as it says what shrinking did.
    expect(r.adjustments.join(' ')).toMatch(/font 10\.5pt → /);
  }, 60_000);

  it('no larger than its ceiling', async () => {
    const r = await compileResume(resume(1));
    const { maxFontSizePt, maxSpacing, maxMarginIn } = DEFAULT_LAYOUT.growBounds;
    expect(r.layout.fontSizePt).toBeLessThanOrEqual(maxFontSizePt);
    expect(r.layout.spacing).toBeLessThanOrEqual(maxSpacing);
    expect(r.layout.marginIn).toBeLessThanOrEqual(maxMarginIn);
  }, 60_000);

  /*
   * Type grows in steps: a little larger and every one-line bullet wraps onto
   * two. A resume that stops there still has room, and the line spacing,
   * which never moves a line break, takes it.
   */
  it('and spends what the type could not on line spacing', async () => {
    const r = await compileResume(resume(6));
    expect(r.fits).toBe(true);
    // More than the type's own growth carries with it: font, spacing and
    // margins grow together, so this much spacing goes with the size it
    // reached, and anything past it is the page's leftover room.
    const { maxFontSizePt, maxSpacing } = DEFAULT_LAYOUT.growBounds;
    const grown = (r.layout.fontSizePt - DEFAULT_LAYOUT.fontSizePt) / (maxFontSizePt - DEFAULT_LAYOUT.fontSizePt);
    expect(grown).toBeLessThan(1);
    expect(r.layout.spacing).toBeGreaterThan(DEFAULT_LAYOUT.spacing + grown * (maxSpacing - DEFAULT_LAYOUT.spacing) + 0.01);
  }, 90_000);

  it('stays as written when told it may not grow', async () => {
    const still = { maxFontSizePt: DEFAULT_LAYOUT.fontSizePt, maxSpacing: DEFAULT_LAYOUT.spacing, maxMarginIn: DEFAULT_LAYOUT.marginIn };
    const r = await compileResume(resume(2, { growBounds: still }));
    expect(r.grew).toBe(false);
    expect(r.adjustments).toEqual([]);
    expect(r.layout.fontSizePt).toBe(DEFAULT_LAYOUT.fontSizePt);
  }, 60_000);

  it('and when auto-fit is off', async () => {
    const r = await compileResume(resume(2, { autoFit: false }));
    expect(r.grew).toBe(false);
    expect(r.layout.fontSizePt).toBe(DEFAULT_LAYOUT.fontSizePt);
  }, 60_000);

  it('while one too long for the page is still brought in, not grown', async () => {
    const r = await compileResume(resume(12));
    expect(r.grew).toBe(false);
    expect(r.layout.fontSizePt).toBeLessThanOrEqual(DEFAULT_LAYOUT.fontSizePt);
  }, 120_000);
});

describe('how large it may go, set like the floors', () => {
  it('merges a save’s ceiling with this version’s, one knob at a time', () => {
    const layout = layoutFor(undefined, { growBounds: { maxFontSizePt: 11.5 } });
    expect(layout.growBounds).toEqual({ ...DEFAULT_LAYOUT.growBounds, maxFontSizePt: 11.5 });
  });

  it('and keeps the other two when a save sets one', () => {
    const temp = makeTempStore();
    try {
      temp.store.saveConfig({ layout: { growBounds: { maxMarginIn: 1 } } });
      temp.store.saveConfig({ layout: { growBounds: { maxFontSizePt: 11 } } });
      expect(temp.store.loadConfig().layout?.growBounds).toEqual({ maxMarginIn: 1, maxFontSizePt: 11 });
    } finally {
      temp.cleanup();
    }
  });
});

const profile = { name: 'Morgan Testwell', email: 'morgan.testwell@example.com', phone: '(555) 010-0199' };
const PARAGRAPH =
  'At university I rebuilt the input pipeline for a student action game in C++, cutting input latency ' +
  'from 90ms to 30ms by moving polling off the render thread, and learned to profile before optimising.';

describe('a cover letter’s page', () => {
  it('is a letter’s, not the resume’s: larger type and an inch of margin', () => {
    const page = letterLayout(DEFAULT_LAYOUT);
    expect(page.fontSizePt).toBeGreaterThanOrEqual(11);
    expect(page.marginIn).toBeGreaterThanOrEqual(1);
    // Never brought in to a resume's margins, however long the letter.
    expect(page.fitBounds.minMarginIn).toBeGreaterThanOrEqual(0.75);
  });

  it('keeps the resume’s type when that is larger, and its paper', () => {
    const page = letterLayout({ ...DEFAULT_LAYOUT, fontSizePt: 11.5, paper: 'a4' });
    expect(page.fontSizePt).toBe(11.5);
    expect(page.paper).toBe('a4');
  });

  it.skipIf(!hasEngine)('and a short letter is set larger still, on one page', async () => {
    const r = await compileLetter({ profile, company: 'Emberlight', role: 'Intern', body: `${PARAGRAPH}\n\n${PARAGRAPH}` }, DEFAULT_LAYOUT);
    expect(r.fits).toBe(true);
    expect(r.pages).toBe(1);
    expect(r.tex).toMatch(/\\changefontsizes\[[\d.]+pt\]\{(1[12](\.\d+)?)pt\}/);
    const size = Number(/\\changefontsizes\[[\d.]+pt\]\{([\d.]+)pt\}/.exec(r.tex)?.[1]);
    expect(size).toBeGreaterThan(11);
  }, 90_000);

  it.skipIf(!hasEngine)('while a long one is brought in rather than spilling, if it can be', async () => {
    const body = Array.from({ length: 7 }, () => PARAGRAPH).join('\n\n');
    const r = await compileLetter({ profile, company: 'Emberlight', role: 'Intern', body }, DEFAULT_LAYOUT);
    expect(r.fits).toBe(true);
    expect(r.pages).toBe(1);
  }, 120_000);
});
