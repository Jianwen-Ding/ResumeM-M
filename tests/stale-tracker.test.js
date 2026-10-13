// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
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
});

/*
 * A list drawn a while ago, and a form filled from it.
 *
 * The tracker reads its list when the tab is opened and keeps it; the
 * extension, the CLI or another tab can correct a row meanwhile. The row's
 * Edit form was filled from the kept list and sent both the company and the
 * role whatever was touched, so changing only the role wrote the old company
 * straight back over a correction made elsewhere. The answer bank's Edit did
 * the same to a version's label when only its text was changed.
 */
describe('editing from a list another writer has changed since', () => {
  async function boot(hash) {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = hash;
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    const server = {
      data,
      apps: [
        {
          id: '2026-10-10-acme-engineer',
          company: 'Summer 2027',
          role: 'Engineer',
          status: 'applied',
          appliedAt: '2026-10-10T16:00:00.000Z',
          history: [{ at: '2026-10-10T16:00:00.000Z', status: 'applied' }],
        },
      ],
      sent: [],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        const method = options.method ?? 'GET';
        let result = {};
        if (url === '/api/store') result = server.data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/letters') result = [];
        else if (url === '/api/applications') {
          result = {
            applications: server.apps,
            stats: { total: server.apps.length, last7: 0, last30: 0, responseRate: 0 },
            current: { dir: '/tmp/current', files: [], applications: 0, inFlight: 0 },
          };
        } else if (url === '/api/answers' && method === 'PUT') {
          server.data.answers = JSON.parse(options.body);
          result = server.data.answers;
        } else if (String(url).startsWith('/api/applications/') && method !== 'GET') {
          const body = JSON.parse(options.body);
          server.sent.push({ url, method, body });
          server.apps = server.apps.map((a) => ({ ...a, ...body }));
          result = server.apps[0];
        } else if (String(url).startsWith('/api/applications/')) {
          result = { application: server.apps[0], resume: null, copiedFromLabel: null, letter: null, files: [] };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    return server;
  }

  const rowText = () => document.querySelector('#apps-wrap tbody tr:not(.group)')?.textContent ?? '';

  it('sends only the field the form changed, and keeps the correction made elsewhere', async () => {
    const server = await boot('#applications');
    await vi.waitFor(() => expect(rowText()).toContain('Summer 2027'));

    // The card puts the company right while this list sits on screen.
    server.apps = server.apps.map((a) => ({ ...a, company: 'Acme Corp' }));

    const edit = [...document.querySelectorAll('#apps-wrap button')].find((b) => b.textContent === 'Edit');
    edit.click();
    await vi.waitFor(() => expect(document.querySelector('#f_role')).not.toBeNull());
    document.querySelector('#f_role').value = 'Software Engineer';
    document.querySelector('#modal-ok').click();

    await vi.waitFor(() => expect(server.sent.length).toBe(1));
    expect(server.sent[0].body).toEqual({ role: 'Software Engineer' });
    expect(server.apps[0].company, 'the correction made elsewhere stands').toBe('Acme Corp');
    await vi.waitFor(() => expect(rowText()).toContain('Acme Corp'));
  });

  it('sends nothing when nothing in the form was changed', async () => {
    const server = await boot('#applications');
    await vi.waitFor(() => expect(rowText()).toContain('Summer 2027'));
    server.apps = server.apps.map((a) => ({ ...a, company: 'Acme Corp' }));

    const edit = [...document.querySelectorAll('#apps-wrap button')].find((b) => b.textContent === 'Edit');
    edit.click();
    await vi.waitFor(() => expect(document.querySelector('#f_role')).not.toBeNull());
    document.querySelector('#modal-ok').click();
    await vi.waitFor(() => expect(document.querySelector('#modal').classList.contains('hidden')).toBe(true));
    expect(server.sent).toEqual([]);
    expect(server.apps[0].company).toBe('Acme Corp');
  });

  it('the status dropdown sends the status and nothing else', async () => {
    const server = await boot('#applications');
    await vi.waitFor(() => expect(rowText()).toContain('Summer 2027'));
    server.apps = server.apps.map((a) => ({ ...a, company: 'Acme Corp' }));

    const sel = document.querySelector('#apps-wrap tbody tr:not(.group) select');
    sel.value = 'interview';
    sel.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(server.sent.length).toBe(1));
    expect(server.sent[0].body).toEqual({ status: 'interview' });
    expect(server.apps[0].company).toBe('Acme Corp');
  });

  it('reads the list again on coming back to the tab', async () => {
    const server = await boot('#applications');
    await vi.waitFor(() => expect(rowText()).toContain('Summer 2027'));
    server.apps = server.apps.map((a) => ({ ...a, company: 'Acme Corp' }));

    const shown = (v) => Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    shown('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    shown('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(rowText()).toContain('Acme Corp'));
  });

  it('an answer edited for its words keeps a label set elsewhere since', async () => {
    const server = await boot('#letters');
    server.data.answers = [
      {
        id: 'ans_why',
        question: 'Why do you want to work here?',
        default: 'v_a',
        variants: [{ id: 'v_a', text: 'Because of the mission.', label: 'Typed on a form' }],
      },
    ];
    document.querySelector('#tabs button[data-tab="letters"]').click();
    await vi.waitFor(() => expect(document.querySelector('#answers')?.textContent).toContain('Because of the mission.'));

    // Relabelled in another tab while this list is on screen.
    server.data = structuredClone(server.data);
    server.data.answers[0].variants[0].label = 'Acme';

    const edit = [...document.querySelectorAll('#answers button')].find((b) => b.textContent === 'Edit');
    edit.click();
    await vi.waitFor(() => expect(document.querySelector('#f_answer')).not.toBeNull());
    document.querySelector('#f_answer').value = 'Because of the mission, and the people.';
    document.querySelector('#modal-ok').click();

    await vi.waitFor(() => expect(server.data.answers[0].variants[0].text).toBe('Because of the mission, and the people.'));
    expect(server.data.answers[0].variants[0].label, 'the label set elsewhere stands').toBe('Acme');
  });
});
