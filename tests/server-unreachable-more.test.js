// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {}, clear: () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({
    init: async () => {
      for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
      return { current: '/test-save' };
    },
    load: async () => {},
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/*
 * The server stopping and coming back, for the three places the resume's
 * preview and autosave fix (server-unreachable.test.js) did not reach: the
 * Workspace letter's preview, the Workspace draft's own save chip, and a line
 * edited in place in the builder.
 *
 * Each said "Failed to fetch" and asked nothing again by itself, so each
 * stayed that way after the server was back until something else was touched.
 * And each is checked for the content that lands being the newest: an edit
 * made a second time while the server was away is the one it gets.
 */
describe('a server that stops and comes back, outside the resume preview', () => {
  function serve() {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const draft = {
      id: 'testwell-draft',
      company: 'Example Corp',
      role: 'Platform Engineer',
      resumeId: 'intern',
      coverLetter: { required: true, body: '', edited: false },
      questions: [{ id: 'q_why', question: 'Why do you want to work here?', answer: '', required: true }],
      notes: '',
    };
    const net = { down: false, data, draft, draftPuts: [], entryPuts: [], letters: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        // Stopped: nothing answers, reads included.
        if (net.down) throw new TypeError('Failed to fetch');
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(init.body) : null;
        const path = String(url).split('?')[0];
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/config') {
          result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        } else if (url === '/api/resumes/expiring') result = { due: [] };
        else if (path === '/api/render/letter') {
          net.letters.push(body.body);
          result = { pages: 1, fits: true, warnings: [], pdfUrl: '/pdf/letter.pdf' };
        } else if (path.startsWith('/api/render')) {
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (path === '/api/workspace') result = { drafts: [net.draft] };
        else if (path.startsWith('/api/workspace/') && method === 'PUT') {
          net.draftPuts.push(body);
          net.draft = body;
          result = body;
        } else if (path.startsWith('/api/workspace/')) result = net.draft;
        else if (path.startsWith('/api/entries/') && method === 'PUT') {
          net.entryPuts.push(body);
          data.entries = data.entries.map((e) => (e.id === body.id ? body : e));
          result = body;
        } else if (path.startsWith('/api/resumes/') && method === 'PUT') {
          data.resumes = data.resumes.map((r) => (r.id === body.id ? body : r));
          result = body;
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );
    return net;
  }

  const text = (sel) => document.querySelector(sel)?.textContent ?? '';

  async function bootWorkspace() {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#workspace';
    const net = serve();
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#draft-editor .letter')).not.toBeNull(), { timeout: 4000 });
    return net;
  }

  const letter = () => document.querySelector('#draft-editor .letter');
  const answer = () => document.querySelector('#draft-editor textarea:not(.letter):not(.notes)');
  const type = (box, value) => {
    box.value = value;
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
  };

  it('says the letter preview cannot reach the server, and compiles the newest letter once it is back', async () => {
    const net = await bootWorkspace();

    net.down = true;
    type(letter(), 'Dear Example Corp, first try.');
    await vi.waitFor(() => expect(text('#draft-editor .fit')).toMatch(/can’t reach the server/i), { timeout: 4000 });
    expect(text('#draft-editor .fit')).not.toMatch(/failed to fetch/i);
    expect(text('#draft-editor .live')).toMatch(/can’t reach/i);
    expect(text('#draft-editor .letter-preview')).toMatch(/can’t reach the server/i);

    // Written again while it is away; this is the one the preview should show.
    type(letter(), 'Dear Example Corp, second try, from Morgan Testwell.');
    await new Promise((go) => setTimeout(go, 1200));

    // Back, and nothing else touched.
    net.down = false;
    await vi.waitFor(() => expect(net.letters.length).toBeGreaterThan(0), { timeout: 8000 });
    await vi.waitFor(() => expect(text('#draft-editor .live')).toBe('Live'));
    expect(net.letters.at(-1)).toBe('Dear Example Corp, second try, from Morgan Testwell.');
    expect(text('#draft-editor .fit')).toBe('Fits on one page.');
    expect(text('#draft-editor .letter-preview')).not.toMatch(/reach/i);
  }, 20_000);

  it('does not call the draft saved while the server is away, and saves the newest letter and answer once it is back', async () => {
    const net = await bootWorkspace();
    const chip = () => text('#draft-save-state');

    net.down = true;
    type(letter(), 'Dear Example Corp, first try.');
    await vi.waitFor(() => expect(chip()).toMatch(/not saved/i), { timeout: 4000 });
    expect(chip()).toMatch(/can’t reach the server/i);
    expect(chip()).toMatch(/retry/i);
    expect(chip()).not.toMatch(/failed to fetch/i);

    // Both edited again while it is away, and each save of them fails too.
    type(letter(), 'Dear Example Corp, second try.');
    type(answer(), 'Because Morgan Testwell likes platforms.');
    await vi.waitFor(() => expect(chip()).toMatch(/can’t reach the server/i), { timeout: 4000 });
    expect(net.draftPuts).toHaveLength(0);

    net.down = false;
    await vi.waitFor(() => expect(chip()).toBe('All changes saved'), { timeout: 8000 });
    expect(net.draft.coverLetter.body).toBe('Dear Example Corp, second try.');
    expect(net.draft.questions[0].answer).toBe('Because Morgan Testwell likes platforms.');
    expect(net.draftPuts.at(-1).coverLetter.body).toBe('Dear Example Corp, second try.');
  }, 20_000);

  async function bootBuilder() {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    const net = serve();
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#editor .entry').length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(text('#live-state')).toBe('Live'), { timeout: 4000 });
    return net;
  }

  const pipelineLine = () =>
    [...document.querySelectorAll('#editor .editable')].find((n) => /^Built a/.test(n.textContent));
  const storedPipeline = (net) =>
    net.data.entries
      .find((e) => e.id === 'exp_acme')
      .bullets.find((b) => b.id === 'b_pipeline')
      .variants.map((v) => v.text);
  const enter = (node) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  it('does not call a line edited in place saved while the server is away, and saves its newest wording once it is back', async () => {
    const net = await bootBuilder();
    const line = pipelineLine();
    expect(line, 'the pipeline bullet on screen').toBeTruthy();

    net.down = true;
    line.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    line.textContent = 'Built a pipeline, first try';
    enter(line);
    await vi.waitFor(() => expect(text('#status')).toMatch(/can’t reach the server/i), { timeout: 4000 });
    expect(text('#status')).not.toMatch(/failed to fetch/i);
    expect(text('#save-state')).toMatch(/not saved/i);
    expect(text('#save-state')).toMatch(/retry/i);
    // Still in the line, still editable.
    expect(line.classList.contains('editing')).toBe(true);
    expect(line.textContent).toBe('Built a pipeline, first try');

    // Corrected while it is away: once with Enter, which fails again, and once more without.
    line.textContent = 'Built a pipeline, second try';
    enter(line);
    await vi.waitFor(() => expect(line.classList.contains('editing')).toBe(true), { timeout: 4000 });
    line.textContent = 'Built a pipeline, third try';
    expect(net.entryPuts).toHaveLength(0);

    net.down = false;
    await vi.waitFor(() => expect(net.entryPuts.length).toBeGreaterThan(0), { timeout: 8000 });
    await vi.waitFor(() => expect(text('#save-state')).toBe('All changes saved'), { timeout: 4000 });
    expect(storedPipeline(net)).toContain('Built a pipeline, third try');
    expect(net.entryPuts.every((e) => JSON.stringify(e).includes('third try'))).toBe(true);
  }, 20_000);
});
