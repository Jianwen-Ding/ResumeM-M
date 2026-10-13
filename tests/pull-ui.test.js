// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
// The real `load` draws the save panel, which is where Pull is.
vi.mock('../web/assets.js', () => ({
  setupAssets: ({ loadProjectSettings }) => ({
    init: async () => {
      for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
      return { current: '/test-save' };
    },
    load: async () => loadProjectSettings(),
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/*
 * Pull, from the Save & Files panel.
 *
 * Two things it must not do. Pull over an edit that has not saved: that edit
 * is on neither side of the merge, and written afterwards it goes whole over
 * whatever the pull brought in to the same resume. And leave the editor
 * drawing the save from before the pull, so that the next edit is made to —
 * and written from — a resume that no longer exists on disk.
 */
describe('the Pull button', () => {
  async function boot() {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes/intern';

    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const server = { refuse: false, asked: [], pullReply: null, afterPull: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        server.asked.push(`${options.method ?? 'GET'} ${url}`);
        let result = {};
        if (url === '/api/store') result = server.afterPull && server.asked.includes('POST /api/config/store/pull') ? server.afterPull : data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (String(url).startsWith('/api/render')) {
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (url === '/api/config') result = { ...data.config, overrides: {} };
        else if (url === '/api/config/store') {
          result = {
            dir: '/test-save', isRepo: true, commits: 3, pending: [],
            remote: { url: 'git@github.com:me/save.git', branch: 'main', ahead: 0, behind: 0, tracked: true },
          };
        } else if (url === '/api/resumes/expiring') result = { due: [], days: 7 };
        else if (url === '/api/config/store/pull') result = server.pullReply;
        else if (String(url).startsWith('/api/resumes/') && options.method === 'PUT') {
          if (server.refuse) {
            return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({ error: 'disk full' }) };
          }
          result = JSON.parse(options.body);
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')?.value).toBe('intern'));
    await vi.waitFor(() => expect(document.querySelector('#tab-resumes .toggle input')).not.toBeNull());
    return { data, server };
  }

  const openPanel = async () => {
    document.querySelector('#tabs button[data-tab="save"]').click();
    await vi.waitFor(() => expect(pullButton()).toBeTruthy());
  };
  const pullButton = () => [...document.querySelectorAll('#project-settings button')].find((b) => b.textContent === 'Pull');
  const result = () => document.querySelector('#project-settings .result:last-child');

  it('sits beside Push, and says what a remote in step means now that there is one', async () => {
    await boot();
    await openPanel();
    const buttons = [...document.querySelectorAll('#project-settings button')].map((b) => b.textContent);
    expect(buttons.indexOf('Pull')).toBe(buttons.indexOf('Push Backup') - 1);
    expect(pullButton().disabled).toBe(false);
    expect(result().textContent).toMatch(/as of the last push or pull/);
    expect(result().textContent).not.toMatch(/nothing to push/);
  });

  it('refuses while an edit has not saved, and says where the way out is', async () => {
    const { server } = await boot();
    server.refuse = true;
    document.querySelector('#tab-resumes .toggle input').click();
    await vi.waitFor(() => expect(document.querySelector('#save-state').className).toMatch(/failed/), { timeout: 4000 });

    await openPanel();
    pullButton().click();

    await vi.waitFor(() => expect(result().textContent).toMatch(/Not pulled: a change you made has not saved yet/));
    expect(result().className).toMatch(/bad/);
    expect(document.querySelector('#status').textContent).toMatch(/Save it or discard it first.*Retry it or discard it/);
    expect(server.asked).not.toContain('POST /api/config/store/pull');
  });

  it('reads the save again after a pull, and stays on the resume that was open', async () => {
    const { data, server } = await boot();
    const pulled = structuredClone(data);
    pulled.resumes.find((r) => r.id === 'intern').label = 'Pulled From The Other Machine';
    server.afterPull = pulled;
    server.pullReply = {
      ok: true, pulled: 2, files: ['resumes/intern.yaml'], message: 'Pulled 2 commits from git@github.com:me/save.git.',
      remote: { url: 'git@github.com:me/save.git', branch: 'main', ahead: 0, behind: 0, tracked: true },
    };

    await openPanel();
    const reads = server.asked.filter((a) => a === 'GET /api/store').length;
    pullButton().click();

    await vi.waitFor(() => expect(document.querySelector('#status').textContent).toBe('Pulled 2 commits — 1 file changed'));
    expect(server.asked.filter((a) => a === 'GET /api/store').length).toBeGreaterThan(reads);
    expect(result().textContent).toMatch(/Pulled 2 commits from/);
    expect(result().className).toMatch(/ok/);
    expect(document.querySelector('#resume-select').value).toBe('intern');
    expect(document.querySelector('#resume-select option[value="intern"]').textContent).toMatch(/Pulled From The Other Machine/);
  });

  it('shows a conflict as one, and does not read the save again', async () => {
    const { server } = await boot();
    server.pullReply = {
      ok: false, pulled: 0, files: [], conflict: ['applications.yaml'],
      message: 'Not pulled: applications.yaml was changed both here and on the remote. The merge was undone.',
      remote: { url: 'git@github.com:me/save.git', branch: 'main', ahead: 1, behind: 1, tracked: true },
    };
    await openPanel();
    const reads = server.asked.filter((a) => a === 'GET /api/store').length;
    pullButton().click();

    await vi.waitFor(() => expect(result().className).toMatch(/bad/));
    expect(result().textContent).toMatch(/merge was undone[\s\S]*1 commit to push, 1 commit to pull/);
    expect(document.querySelector('#status').textContent).toMatch(/applications\.yaml conflict/);
    expect(server.asked.filter((a) => a === 'GET /api/store').length).toBe(reads);
  });
});
