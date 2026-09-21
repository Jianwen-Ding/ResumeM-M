// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * Your voice is a selection over the writing the save already holds.
 *
 * The Voice panel used to say "letters you send and answers you save are
 * included automatically" and show none of them — so the budget bar was
 * reporting on a corpus mostly made of things that were not on the screen,
 * and there was nowhere to say "not that one". A letter written to somebody
 * else's template is still a letter you sent, and an answer that is a date is
 * still an answer; neither is how you write.
 *
 * One switch, in both places it belongs: beside the letter or answer itself,
 * and in the list of them on the panel about your voice.
 */
describe('choosing which letters and answers count as your writing', () => {
  /** What the server would hold, as the two routes that report it see it. */
  let out;

  const LETTERS = [
    { id: 'l-acme', title: 'SWE — Acme', company: 'Acme', createdAt: '2026-01-01', body: 'Dear Acme, '.repeat(12) },
    { id: 'l-zen', title: 'SWE — Zenith', company: 'Zenith', createdAt: '2026-02-01', body: 'Dear Zenith, '.repeat(12) },
  ];

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    out = new Set();
    const inVoice = (id) => !out.has(id);

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      let result = {};
      if (url === '/api/store') {
        result = { ...data, answers: data.answers.map((a) => ({ ...a, voice: inVoice(a.id) ? undefined : false })) };
      } else if (url === '/api/letters') {
        result = LETTERS.map((l) => ({ ...l, voice: inVoice(l.id) ? undefined : false }));
      } else if (url === '/api/voice/include') {
        if (body.include) out.delete(body.id);
        else out.add(body.id);
        result = { kind: body.kind, id: body.id, inVoice: Boolean(body.include) };
      } else if (url === '/api/voice') {
        result = {
          voice: '',
          preview: '',
          samples: [],
          context: { chars: 0, available: 1000, used: [] },
          writing: {
            letters: LETTERS.map((l) => ({ id: l.id, title: l.title, chars: l.body.length, inVoice: inVoice(l.id) })),
            answers: data.answers.map((a) => ({
              id: a.id,
              question: a.question,
              chars: 80,
              inVoice: inVoice(a.id),
            })),
          },
        };
      } else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/ai/presets') result = { presets: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/config') {
        result = {
          ai: { enabled: false, research: false, command: 'claude', args: [], timeoutMs: 1000 },
          latex: { engine: '' },
          git: { autoCommit: false },
          output: { dir: 'out', fileNames: 'type' },
          overrides: {},
        };
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
  });

  const open = async (tab) => {
    document.querySelector(`button[data-tab="${tab}"]`).click();
    await vi.advanceTimersByTimeAsync(50);
  };

  /** Every voice switch on the page, by the text it is showing. */
  const flags = (root = document) => [...root.querySelectorAll('button.voice-flag')];
  const labels = (root = document) => flags(root).map((b) => b.textContent);

  it('shows the switch beside every letter and every answer', async () => {
    await open('letters');
    const letters = flags(document.querySelector('#letters'));
    const answers = flags(document.querySelector('#answers'));
    expect(letters).toHaveLength(LETTERS.length);
    expect(answers.length).toBeGreaterThan(0);
    // In, until somebody says otherwise. That is what the save already meant.
    expect(labels(document.querySelector('#letters'))).toEqual(['In your voice', 'In your voice']);
  });

  it('turns one off, and says so where it was pressed', async () => {
    await open('letters');
    flags(document.querySelector('#letters'))[1].click();
    await vi.advanceTimersByTimeAsync(80);

    expect(labels(document.querySelector('#letters'))).toEqual(['In your voice', 'Not in your voice']);
    expect(out.has('l-zen')).toBe(true);
  });

  it('and the Voice panel shows the same thing, without being told', async () => {
    await open('letters');
    flags(document.querySelector('#letters'))[1].click();
    await vi.advanceTimersByTimeAsync(80);

    await open('voice');
    const panel = document.querySelector('#voice-writing');
    // The ones counted, then the ones left out, so "what is my voice made of"
    // is answered by reading down rather than by hunting.
    const rows = [...panel.querySelectorAll('.mini-card b')].map((b) => b.textContent);
    expect(rows[0]).toBe('SWE — Acme');
    expect(rows).toContain('SWE — Zenith');
    expect(panel.textContent).toMatch(/left out/i);
    expect(document.querySelector('#voice-writing-box summary').textContent).toMatch(/\b\d+ of \d+\b/);
  });

  it('turns one back on from the Voice panel', async () => {
    out.add('l-zen');
    await open('voice');

    const off = flags(document.querySelector('#voice-writing')).find((b) => b.textContent === 'Not in your voice');
    expect(off).toBeTruthy();
    off.click();
    await vi.advanceTimersByTimeAsync(80);

    expect(out.has('l-zen')).toBe(false);
    const panel = document.querySelector('#voice-writing');
    expect(labels(panel).every((t) => t === 'In your voice')).toBe(true);
    expect(panel.textContent).not.toMatch(/left out/i);
  });

  it('counts them on the summary, so the panel need not be opened to be read', async () => {
    out.add('l-zen');
    await open('voice');
    const summary = document.querySelector('#voice-writing-box summary').textContent;
    const [, counted, all] = summary.match(/(\d+) of (\d+)/);
    expect(Number(counted)).toBe(Number(all) - 1);
  });

  it('counts the ones left out in English', async () => {
    out.add('l-zen');
    await open('voice');
    const said = document.querySelector('#voice-writing').textContent;
    // `plural(n, 'one')` would have written "1 one left out", and "2 ones"
    // for the pair — which reads as the program not knowing what it is
    // counting, on a panel whose whole job is saying what it is counting.
    expect(said).toContain('One left out');
    expect(said).not.toMatch(/\bones?\b(?! left)/i);

    out.add('l-acme');
    await open('resumes');
    await open('voice');
    const both = document.querySelector('#voice-writing').textContent;
    expect(both).toContain('2 left out');
    expect(both).not.toMatch(/\bones\b/i);
  });

  it('says what it would do, not only what is true, in the tooltip', async () => {
    await open('letters');
    const on = flags(document.querySelector('#letters'))[0];
    expect(on.title).toMatch(/leave it out/i);
    on.click();
    await vi.advanceTimersByTimeAsync(80);
    expect(flags(document.querySelector('#letters'))[0].title).toMatch(/count it/i);
  });
});
