/**
 * A letter set neatly on its page.
 *
 * Reported with a screenshot: the contact line broke wherever it ran out of
 * room — a long row over a stub — and a short letter hung off the top of the
 * page under the letterhead with the rest of the sheet empty.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileLetter } from '../src/render/compile.js';
import { contactRows } from '../src/render/letter.js';
import { DEFAULT_LAYOUT } from '../src/model/types.js';
import { hasLatex } from './helpers.js';

const run = promisify(execFile);
const profile = {
  name: 'Morgan Testwell',
  email: 'morgan.testwell@example.com',
  phone: '(555) 010-0199',
  linkedin: 'linkedin.com/in/morgan-testwell',
  github: 'github.com/morgantestwell',
  website: 'morgantestwell.dev',
};
const P =
  'At university I rebuilt the input pipeline for a student action game in C++, cutting input latency ' +
  'from 90ms to 30ms by moving polling off the render thread, and learned to profile before optimising.';

async function lines(letter: Parameters<typeof compileLetter>[0]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-letter-'));
  try {
    const pdfPath = path.join(dir, 'letter.pdf');
    const r = await compileLetter(letter, DEFAULT_LAYOUT, { pdfPath });
    const { stdout } = await run('pdftotext', ['-layout', pdfPath, '-']);
    // Where each word is on the page, in points down from the top.
    const { stdout: boxes } = await run('pdftotext', ['-bbox', pdfPath, '-']);
    const words = [...boxes.matchAll(/xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"[^>]*>([^<]*)</g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
      right: Number(m[3]),
      bottom: Number(m[4]),
      text: m[5]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    }));
    const pageWidth = Number(/<page width="([\d.]+)"/.exec(boxes)?.[1]);
    return { r, lines: stdout.split('\n').map((l) => l.trim()).filter(Boolean), words, pageWidth };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the contact rows it offers', () => {
  const item = (text: string, link = false) => ({ text, link });

  it('puts the ways to reach you above the places to look you up', () => {
    const rows = contactRows([item('(555) 010-0199'), item('a@b.com'), item('linkedin.com/in/x', true), item('x.dev', true)]);
    expect(rows.reach.map((i) => i.text)).toEqual(['(555) 010-0199', 'a@b.com']);
    expect(rows.look.map((i) => i.text)).toEqual(['linkedin.com/in/x', 'x.dev']);
  });

  it('and an even split as the fallback', () => {
    const rows = contactRows([item('aaaaaaaaaa'), item('bbbbbbbbbb'), item('cccccccccc'), item('dddddddddd')]);
    expect(rows.even.map((r) => r.map((i) => i.text))).toEqual([['aaaaaaaaaa', 'bbbbbbbbbb'], ['cccccccccc', 'dddddddddd']]);
  });
});

describe.skipIf(!hasLatex())('a letter on its page', () => {
  it('sets the contact details too long for one row as details over links, never a row broken mid-list', async () => {
    const { lines: got } = await lines({ profile, company: 'Emberlight', role: 'Intern', body: P, date: 'September 26, 2026' });
    const contact = got.slice(1, 3);
    expect(contact[0]).toMatch(/010-0199.*morgan\.testwell@example\.com/);
    expect(contact[0]).not.toMatch(/linkedin|github|\.dev/);
    expect(contact[1]).toMatch(/linkedin\.com.*github\.com.*morgantestwell\.dev/);
  }, 120_000);

  it('keeps a contact line that fits on one row', async () => {
    const { lines: got } = await lines({ profile: { name: 'Morgan Testwell', email: 'm@t.dev', phone: '(555) 010-0199' }, body: P, date: 'September 26, 2026' });
    expect(got[1]).toMatch(/010-0199.*m@t\.dev/);
  }, 120_000);

  it('sits a short letter lower on the page than a full one, under the same letterhead', async () => {
    const where = async (body: string) => {
      const { words } = await lines({ profile, company: 'Emberlight', role: 'Intern', body, date: 'September 26, 2026' });
      const y = (text: string) => words.find((w) => w.text.includes(text))?.y ?? NaN;
      return { date: y('September'), rule: y('morgantestwell.dev') };
    };
    const short = await where('Thank you for your time.');
    const full = await where(Array.from({ length: 4 }, () => `${P} ${P}`).join('\n\n'));
    // The letterhead where it always is; the letter an inch or more lower.
    // Fitted at its own size and margin, so within a few points of each other.
    expect(Math.abs(short.rule - full.rule)).toBeLessThan(20);
    expect(short.date - short.rule).toBeGreaterThan(full.date - full.rule + 72);
  }, 180_000);

  it('keeps the greeting and the closing the writer typed on their own lines', async () => {
    const { lines: got, words } = await lines({
      profile, company: 'Emberlight', role: 'Intern', date: 'September 26, 2026',
      body: `Dear Hiring Manager,\n${P}\n\nBest regards,\nMorgan Testwell\nmorgan.testwell@example.com`,
    });
    expect(got).toContain('Dear Hiring Manager,');
    expect(got).toContain('Best regards,');
    expect(got.slice(-2)).toEqual(['Morgan Testwell', 'morgan.testwell@example.com']);
    // With room to sign under the sign-off, as under the one the letter adds.
    const y = (text: string) => words.filter((w) => w.text === text).at(-1)?.y ?? NaN;
    expect(y('Testwell') - y('regards,')).toBeGreaterThan(2 * (y('morgan.testwell@example.com') - y('Testwell')));
  }, 120_000);

  it('signs a letter that ends on a sign-off with no name under it', async () => {
    const { lines: got } = await lines({ profile, company: 'Emberlight', role: 'Intern', date: 'September 26, 2026', body: `${P}\n\nThank you,` });
    expect(got.slice(-2)).toEqual(['Thank you,', 'Morgan Testwell']);
  }, 120_000);

  it('sets a list the writer typed as a list, not as one run-on paragraph', async () => {
    const { lines: got, words } = await lines({
      profile, company: 'Emberlight', role: 'Intern', date: 'September 26, 2026',
      body: `Here is what I bring:\n- ${P}\n- **Shipped** two student games\n\n1. First thing\n2. Second thing\n\n${P}`,
    });
    expect(got).toContain('Here is what I bring:');
    // The bullet is whatever the font maps it to; the item is its own line.
    expect(got.some((l) => /^(\S\s+)?Shipped two student games$/.test(l))).toBe(true);
    expect(got).toContain('1. First thing');
    expect(got).toContain('2. Second thing');
    expect(got.join(' ')).not.toMatch(/ - /);
    // The marker in the margin, the item's own lines under its text.
    const x = (text: string) => words.find((w) => w.text === text)?.x ?? NaN;
    const wrapped = words.find((w) => w.y > words.find((v) => v.text === 'university')!.y + 10)!;
    expect(Math.abs(wrapped.x - x('At'))).toBeLessThan(1);
    expect(x('At') - x('Here')).toBeGreaterThan(10);
  }, 120_000);

  it('breaks a pasted address rather than running it off the right margin', async () => {
    const url = 'https://morgantestwell.dev/projects/inputpipelinerewrite/benchmarks/latencyresults2026/summary.html';
    const bare = 'docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh/edit?usp=sharing&ouid=1234567890';
    const { words, pageWidth } = await lines({
      profile, company: 'Emberlight', role: 'Intern', date: 'September 26, 2026',
      body: `My work is at ${url} which shows the numbers.\n\nThe write-up is at ${bare} if you want it.\n\n${P}`,
    });
    const left = Math.min(...words.map((w) => w.x));
    // Nothing past the right margin, which is as wide as the left one.
    expect(Math.max(...words.map((w) => w.right))).toBeLessThanOrEqual(pageWidth - left + 1);
    // And the addresses still all there, over two lines each.
    expect(words.map((w) => w.text).join('')).toContain(url);
    expect(words.map((w) => w.text).join('')).toContain(bare);
  }, 120_000);

  it('keeps a long name on one line, a size or two down, and a longer one apart', async () => {
    const long = await lines({ profile: { ...profile, name: 'Morgan Alexandra Testwell-Fitzgerald' }, body: P, date: 'September 26, 2026' });
    expect(long.lines[0]).toBe('Morgan Alexandra Testwell-Fitzgerald');

    // Too long even for that: wrapped, but at the name's own leading, the
    // second line clear of the first.
    const longer = await lines({ profile: { ...profile, name: 'Morgan Alexandra Wilhelmina Testwell-Fitzroy' }, body: P, date: 'September 26, 2026' });
    const first = longer.words.find((w) => w.text === 'Morgan')!;
    const second = longer.words.find((w) => w.y > first.y + 1)!;
    expect(second.y).toBeGreaterThan(first.bottom);
  }, 120_000);

  it('and a long one still on one page', async () => {
    const { r } = await lines({ profile, company: 'Emberlight', role: 'Intern', body: Array.from({ length: 6 }, () => `${P} ${P}`).join('\n\n') });
    expect(r.pages).toBe(1);
  }, 180_000);
});
