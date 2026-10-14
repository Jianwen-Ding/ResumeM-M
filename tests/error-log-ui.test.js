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
  localStorage.clear();
});

/*
 * Logging an error from the editor: one shortcut from anywhere, a pasted
 * screenshot, and the editor's own record of what went wrong in the minutes
 * before — a request that failed, a red status line — sent with it.
 */
describe('the Log an error dialog', () => {
  async function boot(many) {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes/intern';

    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const server = { asked: [], posted: null, many: many ?? 0 };
    const entries = (from, to) =>
      Array.from({ length: to - from }, (_, i) => ({ id: `entries/2026-10-14/1200${from + i}-x`, at: new Date().toISOString(), description: `Entry ${from + i + 1}`, source: 'CLI', screenshots: 0, events: 0, pushed: false }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        const method = options.method ?? 'GET';
        server.asked.push(`${method} ${url}`);
        let result = {};
        // Something going wrong before the error is logged: the AI's job list answers 500.
        if (url === '/api/ai/jobs') {
          return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({ error: 'jobs exploded' }) };
        }
        if (url === '/api/store') result = data;
        else if (String(url).startsWith('/api/render')) {
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (url === '/api/config') result = { ...data.config, overrides: {} };
        else if (url === '/api/error-log/status') {
          result = { dir: '/home/me/.resumem-m/error-log', isRepo: true, entries: 1, remote: null, lastPush: null, lastCommitError: null };
        } else if (url === '/api/error-log?limit=10') {
          result = server.many
            ? { entries: entries(0, 10), total: server.many, offset: 0 }
            : { entries: [{ id: 'entries/2026-10-14/120000-x', at: new Date().toISOString(), description: 'Earlier one', source: 'CLI', screenshots: 0, events: 0, pushed: false }], total: 1 };
        } else if (/^\/api\/error-log\?limit=20&offset=\d+$/.test(url)) {
          const offset = Number(/offset=(\d+)/.exec(url)[1]);
          result = { entries: entries(offset, Math.min(offset + 20, server.many)), total: server.many, offset };
        } else if (url === '/api/error-log' && method === 'POST') {
          server.posted = JSON.parse(options.body);
          return { ok: true, status: 201, json: async () => ({ committed: true, message: 'Logged to the error log (not pushed yet).', entry: { id: 'entries/x' } }) };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')?.value).toBe('intern'));
    await vi.waitFor(() => expect(document.querySelector('#tab-resumes .toggle input')).not.toBeNull());
    return { server };
  }

  const dialog = () => document.querySelector('#error-log-dialog');
  const press = (init) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

  it('is in the header, beside the status line, from the start', async () => {
    await boot();
    const chip = document.querySelector('header #error-log-chip');
    expect(chip?.querySelector('.error-log-chip-label').textContent).toBe('Log an error');
    expect(chip.querySelector('.error-log-chip-mark').getAttribute('aria-hidden')).toBe('true');
    expect(chip.previousElementSibling?.id).toBe('status');
    chip.click();
    expect(dialog().classList.contains('hidden')).toBe(false);
  });

  it('opens on Ctrl+Shift+E, takes a pasted image as a thumbnail, and sends it with the editor’s logs', async () => {
    const { server } = await boot();
    // The failed request from boot is in the editor's buffer.
    await vi.waitFor(() => expect(server.asked).toContain('GET /api/ai/jobs'));

    press({ key: 'E', ctrlKey: true, shiftKey: true });
    expect(dialog()).not.toBeNull();
    expect(dialog().classList.contains('hidden')).toBe(false);
    const description = document.querySelector('#error-log-description');
    expect(document.activeElement).toBe(description);

    // Escape closes it; Cmd+Shift+E (a Mac) opens it again.
    description.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(dialog().classList.contains('hidden')).toBe(true);
    press({ key: 'e', metaKey: true, shiftKey: true });
    expect(dialog().classList.contains('hidden')).toBe(false);

    const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], 'paste.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }] } });
    description.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(dialog().querySelectorAll('.error-log-thumb img')).toHaveLength(1));
    const thumb = dialog().querySelector('.error-log-thumb img');
    expect(thumb.src).toMatch(/^data:image\/png;base64,/);

    // A second, removed again.
    const another = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(another, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }] } });
    description.dispatchEvent(another);
    await vi.waitFor(() => expect(dialog().querySelectorAll('.error-log-thumb')).toHaveLength(2));
    dialog().querySelectorAll('.error-log-thumb button')[1].click();
    expect(dialog().querySelectorAll('.error-log-thumb')).toHaveLength(1);

    // Text pasted goes into the box as usual.
    const text = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(text, 'clipboardData', { value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } });
    description.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);

    description.value = 'The jobs list never loads';
    document.querySelector('#error-log-minutes').value = '30';
    description.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(server.posted).not.toBeNull());
    expect(server.posted.description).toBe('The jobs list never loads');
    expect(server.posted.minutes).toBe(30);
    expect(server.posted.source).toBe('editor');
    expect(server.posted.screenshots).toEqual([thumb.src]);
    expect(server.posted.resumeId).toBe('intern');
    const failed = server.posted.events.find((e) => e.kind === 'api');
    expect(failed).toMatchObject({ source: 'editor', level: 'error', detail: { route: '/api/ai/jobs', status: 500 } });
    expect(failed.message).toBe('GET /api/ai/jobs → 500: jobs exploded');

    await vi.waitFor(() => expect(dialog().classList.contains('hidden')).toBe(true));
    const status = document.querySelector('#status');
    expect(status.textContent).toMatch(/^Logged to the error log \(not pushed yet\)/);
    const link = status.querySelector('a.error-log-link');
    expect(link?.textContent).toBe('Logged to the error log (not pushed yet). · Open the error log');
    link.click();
    expect(document.querySelector('#tab-save').classList.contains('active')).toBe(true);
    await vi.waitFor(() => expect(document.querySelector('#error-log-panel .error-log-list')?.textContent).toMatch(/Earlier one/));
    expect(document.querySelector('#error-log-panel .mono-path').textContent).toBe('/home/me/.resumem-m/error-log');
  });

  /*
   * Round 26. The hint said contact details are taken out, and the
   * description kept them: it is the person's own words, so it is kept as
   * written, and the hint says what is really taken out. Typing one in says
   * so, without stopping the save.
   */
  it('says exactly what is taken out, and warns about an email or phone in the description without refusing it', async () => {
    const { server } = await boot();
    document.querySelector('#error-log-chip').click();
    expect(dialog().textContent).toContain(
      'Contact details and tokens are taken out of the automatic logs; tokens are also taken out of your description.',
    );
    const description = document.querySelector('#error-log-description');
    const warning = document.querySelector('#error-log-contact');
    expect(warning.hidden).toBe(true);
    const type = (text) => {
      description.value = text;
      description.dispatchEvent(new Event('input', { bubbles: true }));
    };
    type('Mail jane.doe@example.com bounced');
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toBe('Your description has an email in it — it will be kept as written.');
    type('Call 617-555-0134 and jane.doe@example.com');
    expect(warning.textContent).toBe('Your description has an email and a phone number in it — it will be kept as written.');
    type('Call (617) 555-0134');
    expect(warning.textContent).toBe('Your description has a phone number in it — it will be kept as written.');
    type('Build 2024-10-14 failed on job 4462047454');
    expect(warning.hidden).toBe(true);
    type('Mail jane.doe@example.com bounced');
    document.querySelector('#error-log-dialog .modal-actions button.primary').click();
    await vi.waitFor(() => expect(server.posted).not.toBeNull());
    expect(server.posted.description).toBe('Mail jane.doe@example.com bounced');
  });

  // Round 26: ten entries, and nothing to say there were more.
  it('says how many of how many entries it shows, and shows twenty more at a time', async () => {
    const { server } = await boot(35);
    document.querySelector('#tabs button[data-tab="save"]').click();
    const panel = () => document.querySelector('#error-log-panel');
    await vi.waitFor(() => expect(panel().querySelectorAll('.error-log-list li')).toHaveLength(10));
    expect(panel().querySelector('.error-log-count').textContent).toBe('10 of 35');
    panel().querySelector('.error-log-more').click();
    await vi.waitFor(() => expect(panel().querySelectorAll('.error-log-list li')).toHaveLength(30));
    expect(server.asked).toContain('GET /api/error-log?limit=20&offset=10');
    expect(panel().querySelector('.error-log-count').textContent).toBe('30 of 35');
    expect(panel().querySelectorAll('.error-log-what')[10].textContent).toBe('Entry 11');
    panel().querySelector('.error-log-more').click();
    await vi.waitFor(() => expect(panel().querySelectorAll('.error-log-list li')).toHaveLength(35));
    expect(panel().querySelector('.error-log-count').textContent).toBe('35 of 35');
    expect(panel().querySelector('.error-log-more')).toBeNull();
  });

  it('will not save without a description, and keeps the red lines the person saw', async () => {
    const { server } = await boot();
    document.querySelector('#error-log-chip').click();
    document.querySelector('#error-log-dialog .modal-actions button.primary').click();
    expect(document.querySelector('.error-log-note').textContent).toMatch(/Say in a few words/);
    expect(server.posted).toBeNull();
    // The note was a hint inside the dialog, not a red status line; one that is red is kept.
    document.querySelector('#error-log-description').value = 'x';
    document.querySelector('#error-log-dialog .modal-actions button.primary').click();
    await vi.waitFor(() => expect(server.posted).not.toBeNull());
    expect(server.posted.events.some((e) => e.kind === 'status')).toBe(false);
  });
});
