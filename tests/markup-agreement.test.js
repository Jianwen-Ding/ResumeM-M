// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { MARKUP, inlineTex, tex, texHref } from '../src/render/latex.ts';
import { MARKUP as BROWSER_MARKUP, markupFragment, parseMarkup, plainMarkup } from '../web/markup.js';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * The renderer and the editor read the store's inline markup with two copies
 * of one rule, because the two halves cannot share a module: one is
 * TypeScript compiled for node, the other a script the browser loads
 * directly.
 *
 * They had drifted. The renderer learnt `_italic_` and the editor did not, so
 * "I am _really_ keen" was in italics in the PDF and showed its underscores
 * on screen. So the two are pinned here: the same expression, and the same
 * reading of every line below, written out by the editor's parse in the
 * renderer's own LaTeX.
 */

/** The editor's parse, set the way `markup` in src/render/latex.ts sets it. */
function asTex(parts) {
  return parts
    .map((p) => {
      if (typeof p === 'string') return tex(p);
      if (p.tag === 'code') return `\\texttt{${tex(p.text)}}`;
      if (p.tag === 'link') return `\\href{${texHref(p.url)}}{\\underline{${asTex(p.children)}}}`;
      if (p.tag === 'strong') return `\\textbf{${asTex(p.children)}}`;
      return `\\textit{${asTex(p.children)}}`;
    })
    .join('');
}

const LINES = [
  'I am _really_ keen',
  'I am *really* keen',
  '_Emphasis_ at the start, and at the _end_',
  '(_parenthetical_) and "_quoted_"',
  '_pre_-launch QA, done _twice_!',
  'snake_case_names and __init__ stay as typed',
  'Write to morgan_testwell@example.com or morgan.testwell@example.com',
  'See https://example.com/a_b_c and https://example.com/_x_/y',
  'Cleaned up *.log and *.tmp files',
  'Wrote cleanup jobs for (*.log) and (*.tmp) archives',
  'Supports globs (*) and wildcards (*)',
  'Built a pipeline handling **2M events/day**',
  '***critical*** path, **bold with _italic_ inside**',
  'Built a `Kafka` pipeline; ran `npm test **twice**`',
  '`some_var_name` and `_private_`',
  'see [**the docs**](https://x.com/a_b) or [the _wiki_](https://en.wikipedia.org/wiki/Foo_(bar))',
  'Ranked top 5% *nationally*, R&D at $0 -- a _second_ time',
  'a line\nwith _two_\nparts and _an unclosed\nmarker_',
  'Call (555) 010-0199 _today_.',
];

describe('the editor and the renderer read markup alike', () => {
  it('use the same expression', () => {
    expect(BROWSER_MARKUP.source).toBe(MARKUP.source);
    expect(BROWSER_MARKUP.flags).toBe(MARKUP.flags);
  });

  it.each(LINES)('read %j the same way', (line) => {
    expect(asTex(parseMarkup(line))).toBe(inlineTex(line));
  });

  it('shows _italic_ in italics, and the underscores that are not markers as typed', () => {
    const host = document.createElement('div');
    host.append(markupFragment('A _really_ fast fix to snake_case_names for morgan_testwell@example.com'));
    expect(host.innerHTML).toBe(
      'A <em>really</em> fast fix to snake_case_names for morgan_testwell@example.com',
    );
    expect(plainMarkup('A _really_ fast fix to snake_case_names, *truly*, in `a_b`')).toBe(
      'A really fast fix to snake_case_names, truly, in a_b',
    );
  });
});

/*
 * And in the editor itself, both ways a line is drawn: the plain wording of a
 * line that can be edited, and the rendered preview of one switched off.
 */
describe('a line with _italic_ in the editor', () => {
  const TEXT = 'Built a _really_ fast pipeline for snake_case_names, *truly*';

  it('is drawn without its underscores, as the PDF prints it', async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const entry = data.entries.find((e) => e.id === 'exp_acme');
    entry.bullets.find((b) => b.id === 'b_pipeline').variants.find((v) => v.id === 'v_base').text = TEXT;
    // Off in the base resume, so it is drawn as a collapsed preview there.
    const base = data.resumes.find((r) => r.id === 'base');
    const experience = base.sections.find((s) => s.kind === 'experience');
    experience.bullets = { exp_acme: entry.bullets.filter((b) => b.id !== 'b_pipeline').map((b) => b.id) };

    vi.stubGlobal('fetch', vi.fn(async (url) => {
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      return { ok: true, json: async () => structuredClone(result) };
    }));
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    const selector = document.querySelector('#resume-select');

    selector.value = 'base';
    selector.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.bullet.off .text.collapsed')).not.toBeNull());
    const preview = [...document.querySelectorAll('.bullet.off .text.collapsed')].find((n) =>
      n.textContent.includes('fast pipeline'),
    );
    expect(preview.innerHTML).toBe('Built a <em>really</em> fast pipeline for snake_case_names, <em>truly</em>');

    selector.value = '__master__';
    selector.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.master-source-variant')).not.toBeNull());
    const line = [...document.querySelectorAll('.master-source-variant .text')].find((n) =>
      n.textContent.includes('fast pipeline'),
    );
    expect(line.textContent).toBe('Built a really fast pipeline for snake_case_names, truly');
  });
});
