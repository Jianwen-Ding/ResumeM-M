// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({
  createPreview: () => ({ show: async () => {}, clear: () => {} }),
}));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }),
}));

afterEach(() => {
  delete document.visibilityState;
  vi.unstubAllGlobals();
});

/*
 * A Workspace draft changed somewhere other than the panel showing it.
 *
 * Each save sent the whole draft as this page held it, and the server merges
 * what it is sent over what it has, so every field went back to this page's
 * copy: the letter "Draft it" wrote, when a note typed during the run was
 * saved as the reply came in; another tab's letter, when a note was typed in
 * this one; the answer JobHelper filed from the posting, at the editor's next
 * save. The stand-in server merges a save the way the draft PUT in
 * src/server/api.ts does.
 */
describe('a Workspace draft changed elsewhere while it is open', () => {
  const id = 'halcyon';
  let drafts;
  let puts;
  let data;
  /** Held until released: the run "Draft it" starts. */
  let holdGenerate;

  const letter = () => document.querySelector('#draft-editor .letter');
  const notes = () => document.querySelector('#draft-editor textarea[placeholder^="Notes to yourself"]');
  const answerBox = (n) => document.querySelectorAll('#draft-editor .block textarea:not(.letter)')[n];
  const chip = () => document.querySelector('#draft-save-state').textContent;
  const type = (box, text) => {
    box.value = text;
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const saved = async () =>
    vi.waitFor(() => expect(chip()).toBe('All changes saved'), { timeout: 3000 });

  async function boot(draft) {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();
    puts = [];
    holdGenerate = null;
    drafts = { [id]: draft };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        const method = options.method ?? 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        const [path] = url.split('?');
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/render' || url === '/api/render/letter') {
          result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
        } else if (url === '/api/workspace') result = { drafts: Object.values(drafts) };
        else if (path === `/api/workspace/${id}/generate`) {
          // The server writes the letter as the run finishes; the reply comes after.
          drafts[id] = { ...drafts[id], coverLetter: { ...drafts[id].coverLetter, body: 'Dear Halcyon, drafted by the AI.' } };
          if (holdGenerate) await holdGenerate;
          result = { notes: ['Drafted the letter.'] };
        } else if (path === `/api/workspace/${id}` && method === 'PUT') {
          puts.push(body);
          const existing = drafts[id];
          drafts[id] = {
            ...existing,
            ...body,
            id,
            coverLetter: { ...existing.coverLetter, ...(body.coverLetter ?? {}) },
            questions: body.questions ?? existing.questions,
          };
          result = drafts[id];
        } else if (path === `/api/workspace/${id}`) result = drafts[id];
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="workspace"]').click();
    await vi.waitFor(() => expect(notes()).not.toBeNull());
  }

  const draftWith = (extra = {}) => ({
    id,
    company: 'Halcyon',
    role: 'Platform Engineer',
    resumeId: 'intern',
    createdAt: '2026-10-11T09:00:00.000Z',
    updatedAt: '2026-10-11T09:00:00.000Z',
    status: 'drafting',
    coverLetter: { required: true, body: '', edited: false },
    questions: [
      { id: 'q1', question: 'Why Halcyon?', answer: '' },
      { id: 'q2', question: 'Anything else?', answer: '' },
    ],
    notes: '',
    ...extra,
  });

  /*
   * The hint under a running "Draft it" says to keep writing, nothing typed
   * meanwhile will be lost. A note typed meanwhile was saved as the reply came
   * in, and that save carried the letter from before the run.
   */
  it('keeps the drafted letter when a note was typed while it was being written', async () => {
    await boot(draftWith());
    let release;
    holdGenerate = new Promise((go) => (release = go));
    const draftIt = [...document.querySelectorAll('#draft-editor button.ai-action')].find((b) => b.textContent.includes('Draft it'));
    draftIt.click();
    await vi.waitFor(() => expect(drafts[id].coverLetter.body).toBe('Dear Halcyon, drafted by the AI.'));
    type(notes(), 'Call the recruiter');
    release();

    await vi.waitFor(() => expect(letter().value).toBe('Dear Halcyon, drafted by the AI.'), { timeout: 3000 });
    expect(drafts[id].coverLetter.body).toBe('Dear Halcyon, drafted by the AI.');
    expect(drafts[id].notes).toBe('Call the recruiter');
    expect(notes().value).toBe('Call the recruiter');
  });

  /* What was typed into the letter while the run went is the person’s, and stays. */
  it('keeps the letter typed while it was being drafted, over the drafted one', async () => {
    await boot(draftWith());
    let release;
    holdGenerate = new Promise((go) => (release = go));
    const draftIt = [...document.querySelectorAll('#draft-editor button.ai-action')].find((b) => b.textContent.includes('Draft it'));
    draftIt.click();
    await vi.waitFor(() => expect(drafts[id].coverLetter.body).toBe('Dear Halcyon, drafted by the AI.'));
    type(letter(), 'Dear Halcyon, my own words.');
    release();

    await vi.waitFor(() => expect(drafts[id].coverLetter.body).toBe('Dear Halcyon, my own words.'), { timeout: 3000 });
    await vi.waitFor(() => expect(letter().value).toBe('Dear Halcyon, my own words.'));
  });

  /* Another tab wrote the letter; this one writes a note. */
  it('leaves a letter written in another tab alone when a note is saved here', async () => {
    await boot(draftWith());
    drafts[id] = { ...drafts[id], coverLetter: { required: true, body: 'Dear Halcyon, typed in tab A.', edited: true } };
    type(notes(), 'note from tab B');
    await vi.waitFor(() => expect(drafts[id].notes).toBe('note from tab B'), { timeout: 3000 });
    await saved();
    expect(drafts[id].coverLetter.body).toBe('Dear Halcyon, typed in tab A.');
    expect(puts.at(-1)).toEqual({ notes: 'note from tab B' });
  });

  /*
   * JobHelper filed an answer from the posting, and added a question the form
   * asked. Answering another question here sends the questions as a list, and
   * the list here had neither.
   */
  it('keeps what JobHelper filed when another answer is written here', async () => {
    await boot(draftWith());
    drafts[id] = {
      ...drafts[id],
      questions: [
        { id: 'q1', question: 'Why Halcyon?', answer: 'Answer typed on the posting page via JobHelper' },
        drafts[id].questions[1],
        { id: 'q3', question: 'Start date?', answer: 'January' },
      ],
    };
    type(answerBox(1), 'Nothing more.');
    await vi.waitFor(() => expect(drafts[id].questions.find((q) => q.id === 'q2').answer).toBe('Nothing more.'), {
      timeout: 3000,
    });
    await saved();
    const byId = Object.fromEntries(drafts[id].questions.map((q) => [q.id, q.answer]));
    expect(byId).toEqual({
      q1: 'Answer typed on the posting page via JobHelper',
      q2: 'Nothing more.',
      q3: 'January',
    });
  });

  /* And a note, which touches no question, sends none. */
  it('does not send the questions back with a note', async () => {
    await boot(draftWith());
    drafts[id] = {
      ...drafts[id],
      questions: [{ ...drafts[id].questions[0], answer: 'From JobHelper' }, drafts[id].questions[1]],
    };
    type(notes(), 'call recruiter');
    await vi.waitFor(() => expect(drafts[id].notes).toBe('call recruiter'), { timeout: 3000 });
    expect(drafts[id].questions[0].answer).toBe('From JobHelper');
    expect(puts.every((p) => !('questions' in p))).toBe(true);
  });

  /* Coming back to the tab shows what was written while it was away. */
  it('shows the draft as it is now on coming back to the tab', async () => {
    await boot(draftWith());
    drafts[id] = { ...drafts[id], coverLetter: { required: true, body: 'Written elsewhere.', edited: true } };
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(letter().value).toBe('Written elsewhere.'));
  });

  /*
   * The resume it names was deleted. No option matched, so the picker showed
   * its first resume as the one chosen, and nothing said otherwise until the
   * files would not build.
   */
  it('says the resume it was using is gone rather than showing another as chosen', async () => {
    await boot(draftWith({ resumeId: 'deleted-long-ago' }));
    const picker = document.querySelector('#draft-editor select.draft-resume');
    expect(picker.value).toBe('');
    expect(picker.options[picker.selectedIndex].textContent).toContain('deleted');
    const build = [...document.querySelectorAll('#draft-editor button')].find((b) => b.textContent === 'Build files and record it');
    expect(build.disabled).toBe(true);
    expect(document.querySelector('#draft-editor').textContent).toContain('has been deleted');
  });
});
