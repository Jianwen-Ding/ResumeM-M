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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * JobHelper's "Get a code": `#save/pair?make=1`.
 *
 * JobHelper's card asks for a pairing code on the job page, and its "Get a
 * code" opens the editor here. The link is meant to leave the person nothing
 * to do but read: the pairing section on screen, a code already made and shown
 * large. And only once — a link that made a code on every load would void the
 * code being typed the moment the tab was reloaded, or the hash looked at
 * again, and the person would be typing a code that no longer works.
 */
describe('arriving from JobHelper to pair it', () => {
  let made;
  let pairings;

  const boot = async (hash) => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.history.replaceState(null, '', hash);
    await import('../web/app.js');
  };

  beforeEach(() => {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    made = 0;
    pairings = { code: null, paired: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
        else if (url === '/api/extension/pairings/code' && options.method === 'POST') {
          made += 1;
          pairings.code = { code: `ABCD${String(made).padStart(4, '2')}`.slice(0, 8), expiresAt: new Date(Date.now() + 600_000).toISOString() };
          result = pairings.code;
        } else if (url === '/api/extension/pairings') result = pairings;
        return { ok: true, status: 200, json: async () => structuredClone(result) };
      }),
    );
  });

  it('makes one code, shows it large on the Save & Files tab, and puts the address back to #pair', async () => {
    await boot('#save/pair?make=1');
    await vi.waitFor(() => expect(document.querySelector('#pair-code')?.textContent).toBe('ABCD-2221'));
    expect(made).toBe(1);
    expect(location.hash).toBe('#pair');
    expect([...document.querySelectorAll('section.tab.active')].map((t) => t.id)).toEqual(['tab-save']);
    expect(document.querySelector('#pair-copy')?.textContent).toBe('Copy');
    expect(document.querySelector('#pair-waiting')?.textContent).toMatch(/Waiting for JobHelper/);
  });

  it('does not make another on a hashchange, or on the reload the address now gives', async () => {
    await boot('#save/pair?make=1');
    await vi.waitFor(() => expect(document.querySelector('#pair-code')).not.toBeNull());
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise((r) => setTimeout(r, 50));
    expect(made).toBe(1);
    // A reload lands on what the address says now, which is `#pair`.
    await boot(location.hash);
    await vi.waitFor(() => expect(document.querySelector('#pair-code')?.textContent).toBe('ABCD-2221'));
    expect(made).toBe(1);
  });

  it('a link without make=1 shows the section and makes nothing', async () => {
    await boot('#save/pair');
    await vi.waitFor(() => expect(document.querySelector('#pair-make')).not.toBeNull());
    expect(made).toBe(0);
    expect(document.querySelector('#pair-code')).toBeNull();
  });

  it('says which extension paired once the code is used, so the tab can be closed', async () => {
    await boot('#save/pair?make=1');
    await vi.waitFor(() => expect(document.querySelector('#pair-code')).not.toBeNull());
    // JobHelper sends the code back: it is gone, and the list has the extension.
    pairings = {
      code: null,
      paired: [{ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', id: 'abcdefghijklmnopabcdefghijklmnop', pairedAt: new Date().toISOString() }],
    };
    /*
     * Round 26: by name. "Paired with chrome-extension://kfdjd…" was thirty-two
     * letters nobody recognises; the origin is still the title, and the start
     * of the id is there to tell two apart.
     */
    await vi.waitFor(
      () => expect(document.querySelector('#pair-done')?.textContent).toMatch(/^Paired with JobHelper abcdef…\. JobHelper can reach/),
      { timeout: 5000 },
    );
    const named = document.querySelector('#pair-done span[title]');
    expect(named.title).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    expect(named.querySelector('small.ext-id').textContent).toBe('abcdef…');
    const listed = document.querySelector('#pair-list .pair-origin');
    expect(listed.textContent).toBe('JobHelper abcdef…');
    expect(listed.title).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    expect(document.querySelector('#pair-list').textContent).not.toContain('chrome-extension://');
    expect(document.querySelector('#pair-code')).toBeNull();
    expect(document.querySelector('#pair-waiting')).toBeNull();
  });

  it('shows an origin that is not an extension as it is', async () => {
    pairings = { code: null, paired: [{ origin: 'http://localhost:9999', id: 'x', pairedAt: new Date().toISOString() }] };
    await boot('#save/pair');
    await vi.waitFor(() => expect(document.querySelector('#pair-list .pair-origin')?.textContent).toBe('http://localhost:9999'));
  });
});
