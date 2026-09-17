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
 * The Workspace is where the writing happens, and it used to save on blur and
 * on nothing else.
 *
 * A cover letter is a textarea someone types into for twenty minutes without
 * clicking anywhere — and the letter's preview retypesets while they do, which
 * says, convincingly, that the text is being handled. It was not. Reloading the
 * page, closing the tab, or following the link across to the resume builder
 * threw away everything written since focus last happened to move.
 */
describe('typing in the Workspace', () => {
  let drafts;
  let requests;

  const draftId = 'streamly-intern';

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    // jsdom keeps one `location` for the whole file, so a draft opened by an
    // earlier test is still in the hash when the next one boots the app — and
    // `applyHash()` would reopen it over the draft this test just clicked.
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    requests = [];

    drafts = {
      [draftId]: {
        id: draftId,
        company: 'Streamly',
        role: 'Data Platform Intern',
        resumeId: 'intern',
        coverLetter: { required: true, body: '', edited: false },
        questions: [{ id: 'q1', question: 'Why this role?', answer: '', source: 'empty' }],
        notes: '',
      },
      other: {
        id: 'other',
        company: 'Northwind',
        role: 'Engineer',
        resumeId: 'intern',
        coverLetter: { required: true, body: '', edited: false },
        questions: [],
        notes: '',
      },
    };

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method: options.method ?? 'GET', body });
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/workspace') result = { drafts: Object.values(drafts) };
      else if (url.startsWith('/api/workspace/') && options.method === 'PUT') {
        const id = decodeURIComponent(url.split('/').pop());
        drafts[id] = body;
        result = body;
      } else if (url.startsWith('/api/workspace/')) {
        result = drafts[decodeURIComponent(url.split('/').pop())];
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());

    // `assets.js` enables the tabs once a save is open, and it is mocked here.
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="workspace"]').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.draft-card').length).toBeGreaterThan(0));
    const mine = [...document.querySelectorAll('.draft-card')].find((c) => c.textContent.includes('Streamly'));
    mine.click();
    await vi.waitFor(() => expect(document.querySelector('#draft-editor .letter')).not.toBeNull());
  });

  const letterBox = () => document.querySelector('#draft-editor .letter');
  const type = (node, text) => {
    node.value = text;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const savedLetter = () => drafts[draftId].coverLetter.body;

  const PARAGRAPH = 'Dear Streamly, I have spent the last year building ingest pipelines.';

  it('writes the letter without waiting for the caret to leave the box', async () => {
    type(letterBox(), PARAGRAPH);
    expect(savedLetter(), 'nothing is written on the keystroke itself').toBe('');

    await vi.advanceTimersByTimeAsync(2000);
    expect(savedLetter()).toBe(PARAGRAPH);
  });

  it('says so while it is unsaved, and again once it is not', async () => {
    const chip = () => document.querySelector('#draft-save-state').textContent;
    expect(chip()).toBe('All changes saved');

    type(letterBox(), PARAGRAPH);
    expect(chip()).toBe('Unsaved changes');

    await vi.advanceTimersByTimeAsync(2000);
    expect(chip()).toBe('All changes saved');
  });

  /*
   * The exact failure: type, then leave. `visibilitychange` is what actually
   * fires when a tab is closed or hidden, and the Workspace was not on the
   * list of things it flushed.
   */
  it('writes what is typed when the tab goes away mid-sentence', async () => {
    type(letterBox(), PARAGRAPH);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(50);

    expect(savedLetter()).toBe(PARAGRAPH);
  });

  it('writes what is typed before another draft replaces it on screen', async () => {
    type(letterBox(), PARAGRAPH);

    const cards = [...document.querySelectorAll('.draft-card')];
    const other = cards.find((c) => c.textContent.includes('Northwind'));
    expect(other, 'the other draft in the list').toBeTruthy();
    other.click();
    await vi.advanceTimersByTimeAsync(500);

    expect(savedLetter()).toBe(PARAGRAPH);
  });

  it('covers the answers and the notes, not only the letter', async () => {
    const boxFor = (fragment) =>
      [...document.querySelectorAll('#draft-editor textarea')].find((t) =>
        (t.placeholder ?? '').includes(fragment),
      );
    const answer = boxFor('saved for next time');
    expect(answer, 'an answer box').toBeTruthy();
    type(answer, 'Because the ingest work is the part I like.');

    const notes = boxFor('Notes to yourself');
    expect(notes, 'the notes box').toBeTruthy();
    type(notes, 'Referred by someone on the team.');

    await vi.advanceTimersByTimeAsync(2000);
    expect(drafts[draftId].questions[0].answer).toBe('Because the ingest work is the part I like.');
    expect(drafts[draftId].notes).toBe('Referred by someone on the team.');
  });

  it('does not write on every keystroke', async () => {
    const before = requests.filter((r) => r.method === 'PUT').length;
    for (const text of ['D', 'De', 'Dea', 'Dear', 'Dear ', 'Dear S']) type(letterBox(), text);
    await vi.advanceTimersByTimeAsync(2000);

    const writes = requests.filter((r) => r.method === 'PUT').length - before;
    expect(writes, 'a burst of typing is one write').toBe(1);
    expect(savedLetter()).toBe('Dear S');
  });
});
