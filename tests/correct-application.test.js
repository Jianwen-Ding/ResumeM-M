// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * "Correct this application", put down with Escape while its save is out.
 *
 * The row's Edit button ran its own copy of the save-in-the-dialog loop, with
 * no answer for a dialog dismissed mid-save. A refusal came back to a dialog
 * that was gone and was said nowhere at all; a save that landed left the
 * table showing the old company, because the redraw waited on an answer the
 * dismissed form never gave.
 */
describe('correcting an application, dismissed while it saves', () => {
  let apps;
  let release;
  let outcome;

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#applications';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    apps = [
      {
        id: '2026-10-10-acme-engineer',
        company: 'Acme Corp',
        role: 'Engineer',
        status: 'applied',
        appliedAt: '2026-10-10T16:00:00.000Z',
        history: [{ at: '2026-10-10T16:00:00.000Z', status: 'applied' }],
      },
    ];
    outcome = 'ok';
    release = undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        const method = options.method ?? 'GET';
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/applications') {
          result = {
            applications: apps,
            stats: { total: apps.length, last7: 0, last30: 0, responseRate: 0 },
            current: { dir: '/tmp/current', files: [], applications: 0, inFlight: 0 },
          };
        } else if (String(url).startsWith('/api/applications/') && method === 'PATCH') {
          await new Promise((go) => (release = go));
          if (outcome === 'fail') {
            return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({ error: 'could not write applications.yaml' }) };
          }
          const patch = JSON.parse(options.body);
          apps = apps.map((a) => ({ ...a, ...patch }));
          result = apps[0];
        } else if (String(url).startsWith('/api/applications/')) {
          result = { application: apps[0], resume: null, copiedFromLabel: null, letter: null, files: [] };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#apps-wrap tbody tr:not(.group)').length).toBe(1));
  });

  const rowText = () => document.querySelector('#apps-wrap tbody tr:not(.group)')?.textContent ?? '';

  async function correctThenEscape() {
    const edit = [...document.querySelectorAll('#apps-wrap button')].find((b) => b.textContent === 'Edit');
    expect(edit, 'the row offers Edit').toBeTruthy();
    edit.click();
    await vi.waitFor(() => expect(document.querySelector('#f_company')).not.toBeNull());
    document.querySelector('#f_company').value = 'Acme Corporation';
    document.querySelector('#modal-ok').click();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('#modal').classList.contains('hidden'), 'Escape put the dialog down').toBe(true);
    release();
  }

  it('redraws the table when the save lands after all', async () => {
    await correctThenEscape();
    await vi.waitFor(() => expect(rowText()).toContain('Acme Corporation'));
  });

  it('says so when the save is refused', async () => {
    outcome = 'fail';
    await correctThenEscape();
    await vi.waitFor(() => expect(document.querySelector('#status')?.textContent ?? '').toMatch(/not saved/i));
    expect(document.querySelector('#status').textContent).toContain('could not write applications.yaml');
  });
});
