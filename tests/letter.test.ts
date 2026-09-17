import { describe, expect, it } from 'vitest';
import { compileLetter } from '../src/render/compile.js';
import { renderLetterFastBody, renderLetterLatex } from '../src/render/letter.js';
import { DEFAULT_LAYOUT, type ResolvedProfile } from '../src/model/types.js';
import { hasLatex } from './helpers.js';

const latex = await hasLatex();

const PROFILE: ResolvedProfile = {
  name: 'Test Person',
  email: 'test@example.com',
  phone: '555-0100',
  github: 'github.com/test',
  location: 'Boston, MA',
};

const letter = (body: string, extra: Record<string, unknown> = {}) => ({
  profile: PROFILE,
  company: 'Streamly',
  role: 'Data Platform Intern',
  body,
  date: 'January 2, 2026',
  ...extra,
});

describe('the cover letter template', () => {
  it('sets the sender block the same way the resume does', () => {
    const tex = renderLetterLatex(letter('Hello there.'), DEFAULT_LAYOUT);
    expect(tex).toContain('\\Huge \\scshape Test Person');
    expect(tex).toContain('\\href{mailto:test@example.com}');
    expect(tex).toContain('Boston, MA');
  });

  it('addresses the company and names the role', () => {
    const tex = renderLetterLatex(letter('Hello there.'), DEFAULT_LAYOUT);
    expect(tex).toContain('Streamly');
    expect(tex).toContain('Re: Data Platform Intern');
    expect(tex).toContain('January 2, 2026');
  });

  it('adds a greeting and a sign-off when the writer did not', () => {
    const tex = renderLetterLatex(letter('I would like to work on ingest.'), DEFAULT_LAYOUT);
    expect(tex).toContain('Dear Streamly Hiring Team,');
    expect(tex).toContain('Sincerely,');
    expect(tex).toContain('Test Person');
  });

  it('does not add a second greeting when the letter already opens with one', () => {
    const tex = renderLetterLatex(letter('Dear team,\n\nI would like to work on ingest.\n\nSincerely,\nTest Person'), DEFAULT_LAYOUT);
    expect(tex).not.toContain('Dear Streamly Hiring Team,');
    expect(tex.match(/Sincerely,/g) ?? []).toHaveLength(1);
  });

  it('keeps paragraphs apart and treats a single newline as a wrap', () => {
    const tex = renderLetterLatex(letter('First para line one\nstill first para.\n\nSecond para.'), DEFAULT_LAYOUT);
    expect(tex).toContain('First para line one still first para.');
    expect(tex).toContain('Second para.');
    // Blank line between them: that is what ends a paragraph in LaTeX.
    expect(tex).toMatch(/still first para\.\n\nSecond para\./);
  });

  it('honours the store markup a bullet would use', () => {
    const tex = renderLetterLatex(letter('I handled **2M events/day** in `Kafka`.'), DEFAULT_LAYOUT);
    expect(tex).toContain('\\textbf{2M events/day}');
    expect(tex).toContain('\\texttt{Kafka}');
  });

  it('escapes LaTeX specials in what the writer typed', () => {
    const tex = renderLetterLatex(letter('Cut costs by 40% & shipped #1.'), DEFAULT_LAYOUT);
    expect(tex).toContain('40\\%');
    expect(tex).toContain('\\&');
    expect(tex).toContain('\\#1');
  });

  it('says so, rather than producing an empty page, when nothing is written', () => {
    const tex = renderLetterLatex(letter(''), DEFAULT_LAYOUT);
    expect(tex).toContain('(nothing written yet)');
  });

  it('works without a company, for a letter with no addressee yet', () => {
    const tex = renderLetterLatex({ profile: PROFILE, body: 'Hello.' }, DEFAULT_LAYOUT);
    expect(tex).toContain('Dear Hiring Team,');
    expect(tex).not.toContain('Re:');
  });

  it('shares the resume preamble, so the fast body carries no document class', () => {
    const full = renderLetterLatex(letter('Hello.'), DEFAULT_LAYOUT);
    const fast = renderLetterFastBody(letter('Hello.'), DEFAULT_LAYOUT);
    expect(full).toContain('\\documentclass');
    expect(fast).not.toContain('\\documentclass');
    expect(fast).toContain('\\begin{document}');
    // The fit checker's markers must survive in both.
    expect(fast).toContain('\\zsavepos{rmmstart}');
  });
});

describe.skipIf(!latex)('compiling a cover letter', { timeout: 180_000 }, () => {
  it('produces a one-page PDF', async () => {
    const result = await compileLetter(letter('I would like to work on ingest at scale.'), DEFAULT_LAYOUT);
    expect(result.pages).toBe(1);
    expect(result.fits).toBe(true);
    expect(result.overflowLines).toBeLessThan(0); // room to spare
  });

  it('reports honestly when a letter runs past a page instead of shrinking it', async () => {
    const long = Array.from({ length: 70 }, (_, i) => `Paragraph ${i} about distributed systems work at some length.`).join('\n\n');
    const result = await compileLetter(letter(long), DEFAULT_LAYOUT);
    expect(result.fits).toBe(false);
    expect(result.pages).toBeGreaterThan(1);
    expect(result.overflowLines).toBeGreaterThan(0);
  });

  it('uses the trusted engine unless a preview is asked for', async () => {
    const trusted = await compileLetter(letter('Short.'), DEFAULT_LAYOUT);
    expect(trusted.fastPath).toBe(false);
  });

  it('cannot be broken by LaTeX-looking text in the letter', async () => {
    const result = await compileLetter(letter('I used \\newcommand{} and $x^2$ and 100% of it.'), DEFAULT_LAYOUT);
    expect(result.pages).toBe(1);
  });
});
