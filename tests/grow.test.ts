/**
 * A page with room to spare, set as large as it allows.
 *
 * Auto-fit only ever shrank. A resume with three entries came out at 10.5pt
 * inside 0.45in margins with the bottom third of the page empty, and a cover
 * letter was set on the resume's page, 120 characters to the line across the
 * whole sheet. Asked for: "as large fonts and margins as possible without
 * leaking onto another page".
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { compileLetter, compileResume, detectEngine } from '../src/render/compile.js';
import { letterLayout } from '../src/render/letter.js';
import { DEFAULT_LAYOUT, layoutFor, type ResolvedResume } from '../src/model/types.js';
import { makeTempStore, tempDir } from './helpers.js';

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

  /*
   * Larger type and wider margins take room from every line, and a link TeX
   * cannot break is set past the right-hand edge, where it is not in the PDF.
   * This one fits across the page as written and ran 30pt off it once grown.
   */
  it('but never until a line it could set runs off the side of the page', async () => {
    const link = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?usp=sharing';
    const r = resume(2);
    r.sections[0]!.entries[0]!.bullets[0] = { id: 'link', variantId: 'v', text: `Design doc: ${link}` };
    const offTheSide = (warnings: string[]) => warnings.filter((w) => /right-hand edge/.test(w));

    const asWritten = await compileResume({ ...r, layout: { ...r.layout, autoFit: false } });
    expect(offTheSide(asWritten.warnings)).toEqual([]);

    const fitted = await compileResume(r);
    expect(fitted.fits).toBe(true);
    expect(offTheSide(fitted.warnings)).toEqual([]);
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

/*
 * A resume allowed two pages, as `maxPages: 2` permits. Its own profile and
 * entries, so where the page breaks is decided here and not by the helper's.
 */
const run = promisify(execFile);
const twoPager = (entries: number, layout: Partial<typeof DEFAULT_LAYOUT> = {}): ResolvedResume => {
  const long = (i: number) =>
    `Led the telemetry ingestion service ${i}, cutting p99 latency from 900ms to 180ms while raising throughput fourfold across three regions and documenting the rollout plan`;
  const short = (i: number) => `Designed the telemetry ingestion service ${i}, cutting p99 latency from 900ms to 180ms`;
  const entry = (i: number, bullets: string[]) => ({
    id: `e${i}`,
    kind: 'experience' as const,
    title: `Brightline Systems ${i}`,
    dates: 'Jul. 2024 -- Dec. 2024',
    subtitle: i === 90 ? 'B.S. Computer Science' : 'Software Engineer',
    location: 'Boston, MA',
    bullets: bullets.map((text, j) => ({ id: `b${i}_${j}`, variantId: 'v', text })),
  });
  return {
    id: 'two',
    label: 'Two',
    profile: {
      name: 'Morgan Testwell',
      email: 'morgan.testwell@example.com',
      phone: '(555) 010-0199',
      linkedin: 'linkedin.com/in/morgan-testwell',
      github: 'github.com/morgantestwell',
      website: 'morgantestwell.dev',
    },
    sections: [
      { kind: 'education', heading: 'Education', entries: [entry(90, [])], skillGroups: [] },
      {
        kind: 'experience',
        heading: 'Experience',
        entries: Array.from({ length: entries }, (_, i) => entry(i, [long(i * 10), short(i * 10 + 1), long(i * 10 + 2)])),
        skillGroups: [],
      },
      {
        kind: 'skills',
        heading: 'Technical Skills',
        entries: [],
        skillGroups: [
          { id: 'g0', name: 'Languages', items: ['TypeScript', 'Go', 'Python', 'SQL'] },
          { id: 'g1', name: 'Tools', items: ['Kubernetes', 'Terraform', 'PostgreSQL', 'Kafka'] },
        ],
      },
    ],
    layout: { ...DEFAULT_LAYOUT, ...layout },
    warnings: [],
  } as ResolvedResume;
};

async function pageLines(pdfPath: string, page: number): Promise<string[]> {
  const { stdout } = await run('pdftotext', ['-layout', '-f', String(page), '-l', String(page), pdfPath, '-']);
  return stdout.split('\n').filter((l) => l.trim());
}

describe.skipIf(!hasEngine)('a resume over two pages', () => {
  /*
   * Grown to its ceiling, eight entries ended page one on "Brightline
   * Systems 4 / Software Engineer" and set all three of its bullets overleaf.
   */
  it('never ends a page on an entry’s heading, with its bullets overleaf', async () => {
    const dir = tempDir('rmm-two-');
    const pdfPath = path.join(dir, 'two.pdf');
    const r = await compileResume(twoPager(8, { maxPages: 2 }), { pdfPath });
    expect(r.pages).toBe(2);
    const endOfPageOne = (await pageLines(pdfPath, 1)).slice(-2).join('\n');
    expect(endOfPageOne).not.toMatch(/Brightline Systems \d|Software Engineer/);
  }, 90_000);

  /*
   * Five entries fit on one page as written. Allowed two, they were grown to
   * the ceiling, and the last entry's bullets and the skills spilled onto a
   * second page that was otherwise empty.
   */
  it('but one that fits on one page is grown on that page, not onto a second', async () => {
    const asWritten = await compileResume(twoPager(5, { maxPages: 2, autoFit: false }));
    expect(asWritten.pages).toBe(1);
    const r = await compileResume(twoPager(5, { maxPages: 2 }));
    expect(r.pages).toBe(1);
    expect(r.grew).toBe(true);
  }, 90_000);
});

describe.skipIf(!hasEngine)('a page nearly full as written', () => {
  const withExtra = (n: number) => {
    const r = twoPager(5);
    const last = r.sections[1]!.entries[4]!;
    for (let k = 0; k < n; k++) last.bullets.push({ id: `x${k}`, variantId: 'v', text: `Mentored intern cohort ${k} on code review` });
    return r;
  };

  /*
   * TeX shrinks the gaps between items before it breaks a page, so a page
   * measured 98% full as set still has room. Two short bullets more came out
   * at 10.92pt; three, at 10.5pt — the whole growth gone for one line, on a
   * page 10.92pt still fitted.
   */
  it('still grows, and one line more moves the type a little, not all the way back', async () => {
    const two = await compileResume(withExtra(2));
    const three = await compileResume(withExtra(3));
    expect(three.pages).toBe(1);
    expect(three.grew).toBe(true);
    expect(two.layout.fontSizePt - three.layout.fontSizePt).toBeLessThan(0.2);
  }, 120_000);
});

describe.skipIf(!hasEngine)('a contact line too long for one line', () => {
  /*
   * Phone, email and three links wrap, and more of them do once grown. The
   * line broke after a separator and left "… github.com/morgantestwell |"
   * with the bar hanging at its end.
   */
  it('wraps without a separator left hanging at either end of a line', async () => {
    const dir = tempDir('rmm-contact-');
    const pdfPath = path.join(dir, 'contact.pdf');
    await compileResume(twoPager(1, { autoFit: false }), { pdfPath });
    const lines = (await pageLines(pdfPath, 1)).slice(1, 3).map((l) => l.trim());
    expect(lines[1]).toContain('morgantestwell.dev');
    for (const line of lines) expect(line).not.toMatch(/^\||\|$/);
  }, 60_000);
});

describe.skipIf(!hasEngine)('an entry heading too long for its row', () => {
  const long = (entries: Record<string, string>[], layout: Partial<typeof DEFAULT_LAYOUT> = {}) => {
    const r = twoPager(1, layout);
    r.sections = [
      {
        kind: 'experience',
        heading: 'Experience',
        skillGroups: [],
        entries: entries.map((e, i) => ({
          id: `l${i}`,
          kind: (e.kind ?? 'experience') as 'experience',
          title: e.title!,
          subtitle: e.subtitle,
          dates: e.dates,
          location: e.location,
          bullets: [{ id: `lb${i}`, variantId: 'v', text: 'Cut p99 latency from 900ms to 180ms' }],
        })),
      },
    ];
    return r;
  };

  /*
   * A long employer and a long location, on different rows: each row fits on
   * its own, but the table sized its left column by the one and its right by
   * the other, and set the dates and location off the edge of the page.
   */
  it('keeps every part of it on the page', async () => {
    const dir = tempDir('rmm-row-');
    const pdfPath = path.join(dir, 'row.pdf');
    const r = await compileResume(
      long(
        [
          {
            title: 'Brightline Systems International Holdings, Distributed Reliability Engineering',
            subtitle: 'Engineer',
            dates: 'September 2019 -- Present',
            location: 'Cambridge, Massachusetts, United States (Hybrid)',
          },
          {
            title: 'Brightline Systems International Holdings, Distributed Infrastructure and Reliability Engineering Division',
            subtitle: 'Senior Staff Software Engineer',
            dates: 'Jan. 2018 -- Aug. 2019',
            location: 'Boston, MA',
          },
          {
            kind: 'project',
            title: 'Telemetry Ingestion Service Rewrite With Regional Failover',
            subtitle: 'TypeScript, Go, Kafka, PostgreSQL, Kubernetes, Terraform',
            dates: 'Jan. 2023 -- Aug. 2024',
            location: 'Boston, MA',
          },
        ],
        { autoFit: false },
      ),
      { pdfPath },
    );
    expect(r.warnings.filter((w) => /right-hand edge/.test(w))).toEqual([]);
    const text = (await pageLines(pdfPath, 1)).join(' ').replace(/\s+/g, ' ');
    for (const part of [
      'September 2019', 'Cambridge, Massachusetts, United States (Hybrid)',
      'Engineering Division', 'Jan. 2018', 'Aug. 2019', 'Terraform', 'Aug. 2024 | Boston, MA',
    ]) {
      expect(text).toContain(part);
    }
  }, 60_000);

  /*
   * Wrapped as written, and grown: the larger type set the same project
   * heading on three lines instead of two.
   */
  it('and is not wrapped onto more lines by growing', async () => {
    const r = long([
      {
        kind: 'project',
        title: 'Telemetry Ingestion Service Rewrite With Regional Failover',
        subtitle: 'TypeScript, Go, Kafka, PostgreSQL, Kubernetes, Terraform',
        dates: 'Jan. 2023 -- Aug. 2024',
        location: 'Boston, MA',
      },
    ]);
    const dir = tempDir('rmm-row-');
    const headingLines = async (layout: Partial<typeof DEFAULT_LAYOUT>) => {
      const pdfPath = path.join(dir, `${layout.autoFit}.pdf`);
      await compileResume({ ...r, layout: { ...r.layout, ...layout } }, { pdfPath });
      const lines = await pageLines(pdfPath, 1);
      const from = lines.findIndex((l) => /Telemetry Ingestion/.test(l));
      return lines.findIndex((l) => /•/.test(l)) - from;
    };
    expect(await headingLines({ autoFit: false })).toBe(2);
    expect(await headingLines({ autoFit: true })).toBe(2);
  }, 90_000);
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
