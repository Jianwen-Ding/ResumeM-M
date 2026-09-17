// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

/*
 * A stand-in for pdf.js that records what it was asked to do. `clear` matters
 * here: the real one takes the drawn page down, and the bug was that nothing
 * took it down — so an emptied letter showed its own last version with "type
 * a first sentence" written across it.
 */
const previewCalls = [];
vi.mock('../web/preview.js', () => ({
  createPreview: (frame) => ({
    show: async (url) => {
      previewCalls.push(['show', url]);
      frame.classList.add('loaded');
      frame.querySelector('.pages')?.replaceChildren(document.createElement('canvas'));
    },
    clear: () => {
      previewCalls.push(['clear']);
      frame.classList.remove('loaded');
      frame.querySelector('.pages')?.replaceChildren();
    },
  }),
}));
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

  /*
   * Whether a letter is wanted is read off the form when the application is
   * opened, and that answer used to be final — the box simply did not exist
   * afterwards. It is the wrong thing to be final about: the form that asks is
   * often three pages in, the detection is a guess, and "send one anyway" is an
   * ordinary decision to make late.
   */
  it('can take a cover letter on an application that did not ask for one', async () => {
    // Switch to the draft that wants no letter.
    const other = [...document.querySelectorAll('.draft-card')].find((c) => c.textContent.includes('Northwind'));
    drafts.other.coverLetter.required = false;
    other.click();
    await vi.waitFor(() =>
      expect(document.querySelector('#draft-editor').textContent).toContain('did not ask for one'),
    );
    expect(document.querySelector('#draft-editor .letter'), 'no letter box yet').toBeNull();

    const add = [...document.querySelectorAll('#draft-editor button')].find(
      (b) => b.textContent === 'Add one anyway',
    );
    expect(add, 'a way to add one').toBeTruthy();
    add.click();

    await vi.waitFor(() => expect(document.querySelector('#draft-editor .letter')).not.toBeNull());
    await vi.advanceTimersByTimeAsync(2000);
    expect(drafts.other.coverLetter.required, 'and it is remembered').toBe(true);

    // And it is a real letter box: what is typed into it is saved.
    type(document.querySelector('#draft-editor .letter'), 'Dear Northwind, I am writing anyway.');
    await vi.advanceTimersByTimeAsync(2000);
    expect(drafts.other.coverLetter.body).toBe('Dear Northwind, I am writing anyway.');
  });

  /*
   * Pressing an AI button spends minutes and, depending on the command, money.
   * Pressing anything else is instant. Nothing on screen distinguished them, so
   * the only way to learn which you had pressed was to wait and see.
   */
  it('marks the buttons that run the AI, and only those', async () => {
    const buttons = [...document.querySelectorAll('#draft-editor button')];
    const named = (label) => buttons.find((b) => b.textContent.includes(label));

    for (const label of ['Draft it', 'Ask for feedback']) {
      const b = named(label);
      expect(b, label).toBeTruthy();
      expect(b.classList.contains('ai-action'), `${label} is marked`).toBe(true);
      expect(b.title, `${label} says what it runs`).toMatch(/Runs your AI command/);
    }

    // And the ones that are not AI are left plain, rather than labelled "not AI".
    const plain = buttons.filter((b) => !b.classList.contains('ai-action'));
    expect(plain.length, 'most buttons are not AI').toBeGreaterThan(0);
    for (const b of plain) expect(b.title ?? '').not.toMatch(/Runs your AI command/);
  });

  /*
   * "Working…" was the whole of it, for something that takes minutes: no way
   * to tell a run that is thinking from one that has died.
   */
  it('says what the AI is doing, and for how long', async () => {
    let release;
    const held = new Promise((go) => (release = go));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (String(url).endsWith('/generate')) {
        await held;
        return { ok: true, json: async () => ({ draft: drafts[draftId], notes: ['Cover letter drafted in your voice.'] }) };
      }
      return realFetch(url, options);
    }));

    const draftIt = [...document.querySelectorAll('#draft-editor button')].find((b) =>
      b.textContent.includes('Draft it'),
    );
    draftIt.click();

    let running = null;
    await vi.waitFor(() => {
      running = document.querySelector('#draft-editor .ai-running');
      expect(running).not.toBeNull();
    });

    // It says what it is doing, that it is safe to keep typing, and nothing
    // else can start a second run on top of this one.
    expect(running.textContent).toContain('Writing the cover letter');
    expect(running.parentElement.textContent).toContain('nothing you type now will be lost');
    expect(draftIt.disabled).toBe(true);

    // And there is a clock, which is what tells a live run from a dead one.
    expect(running.querySelector('.ai-elapsed')?.textContent).toBe('0:00');

    release();
    await vi.waitFor(() => expect(document.querySelector('#draft-editor .ai-running')).toBeNull());
  });

  it('does not write on every keystroke', async () => {
    const before = requests.filter((r) => r.method === 'PUT').length;
    for (const text of ['D', 'De', 'Dea', 'Dear', 'Dear ', 'Dear S']) type(letterBox(), text);
    await vi.advanceTimersByTimeAsync(2000);

    const writes = requests.filter((r) => r.method === 'PUT').length - before;
    expect(writes, 'a burst of typing is one write').toBe(1);
    expect(savedLetter()).toBe('Dear S');
  });
  /*
   * "Clicking draft still doesn't start up a loading bar that signals its
   * being worked on."
   *
   * There was one. The panel it drew into was appended at the foot of the
   * draft editor — below the resume block, the notes box and the
   * complete/discard row — while "Draft it" sits at the top beside the Cover
   * letter heading. So pressing a button that takes minutes scrolled nothing,
   * changed nothing you could see, and the only sign it was running was off
   * the bottom of the page.
   */
  it('shows the AI at work beside the button that started it', async () => {
    const heading = [...document.querySelectorAll('#draft-editor .block-head')].find((h) =>
      h.textContent.includes('Cover letter'),
    );
    const draftIt = [...heading.querySelectorAll('button')].find((b) => b.textContent.includes('Draft it'));
    expect(draftIt).toBeTruthy();

    const block = heading.closest('.block');
    draftIt.click();

    /*
     * In this block, not merely somewhere on the page. `compareDocumentPosition`
     * was the first thing tried and it is not sound here: `generate` re-renders
     * the editor, so one of the two nodes is detached by the time it is asked,
     * and a disconnected comparison still sets the FOLLOWING bit. The test
     * passed with the panel back at the foot of the page.
     */
    const running = await vi.waitFor(() => {
      const node = block.querySelector('.ai-running');
      expect(node).not.toBeNull();
      return node;
    });

    expect(running.textContent).toContain('0:00');
    expect(running.closest('.gen-notes')).not.toBeNull();
  });

  it('marks Draft it as AI work before anyone presses it', () => {
    const heading = [...document.querySelectorAll('#draft-editor .block-head')].find((h) =>
      h.textContent.includes('Cover letter'),
    );
    const draftIt = [...heading.querySelectorAll('button')].find((b) => b.textContent.includes('Draft it'));
    expect(draftIt.classList.contains('ai-action')).toBe(true);
    expect(draftIt.title).toContain('Runs your AI command');
  });
  /*
   * Clearing the letter left the last compiled page on screen with the empty
   * state drawn over the top of it — two things rendering in the same box, the
   * letter you had just deleted still legible under the invitation to write
   * one. Dropping the `loaded` class brings the placeholder back and does
   * nothing at all about the page pdf.js has already painted.
   */
  it('takes the page down when the letter is emptied, not just the class off it', async () => {
    previewCalls.length = 0;
    type(letterBox(), PARAGRAPH);
    await vi.advanceTimersByTimeAsync(3000);
    expect(previewCalls.some(([what]) => what === 'show'), 'a page was drawn to begin with').toBe(true);

    const pane = document.querySelector('#draft-editor .letter-preview');
    expect(pane.classList.contains('loaded')).toBe(true);

    previewCalls.length = 0;
    type(letterBox(), '');
    await vi.advanceTimersByTimeAsync(3000);

    expect(previewCalls.some(([what]) => what === 'clear'), 'and taken down when there is nothing left').toBe(true);
    expect(pane.classList.contains('loaded')).toBe(false);
    expect(pane.querySelector('canvas')).toBeNull();
  });
  /*
   * A feedback run has had a chip in the toolbar since it went into the
   * background, and that chip is why a feedback run is something you can
   * start and then go back to work. A draft had nothing of the kind: the
   * progress bar lives in the panel that started it, so opening the resume
   * builder while a cover letter was being written left no trace anywhere
   * that anything was.
   */
  it('says in the toolbar that something is being written, and stops when it is', async () => {
    const chip = () => document.querySelector('#drafting-chip');
    expect(chip().className).toContain('hidden');

    const heading = [...document.querySelectorAll('#draft-editor .block-head')].find((h) =>
      h.textContent.includes('Cover letter'),
    );
    [...heading.querySelectorAll('button')].find((b) => b.textContent.includes('Draft it')).click();

    await vi.waitFor(() => expect(chip().className).not.toContain('hidden'));
    // Named, and counting — so a run that has died is distinguishable from one
    // that is merely slow, which is the whole question after the first minute.
    expect(chip().textContent).toContain('Writing the cover letter');
    expect(chip().textContent).toMatch(/\d+:\d\d/);

    // The run finishes — the fixture's server answers immediately — and the
    // chip goes with it rather than sitting there for the rest of the session.
    await vi.waitFor(() => expect(chip().className).toContain('hidden'));
  });

  it('takes you back to the draft it is talking about', async () => {
    const heading = [...document.querySelectorAll('#draft-editor .block-head')].find((h) =>
      h.textContent.includes('Cover letter'),
    );
    [...heading.querySelectorAll('button')].find((b) => b.textContent.includes('Draft it')).click();
    await vi.waitFor(() => expect(document.querySelector('#drafting-chip').onclick).toBeTypeOf('function'));
    expect(document.querySelector('#drafting-chip').style.cursor).toBe('pointer');
  });
});
