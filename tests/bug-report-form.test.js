import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

it('pastes a screenshot, saves notes, shows the queued receipt, and retries without another report', async () => {
  const html = fs.readFileSync(new URL('../../JobHelper/src/reports/report.html', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('../../JobHelper/src/reports/report.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://report.test/' });
  const { window } = dom;
  const reports = [];
  let saves = 0;
  window.chrome = { runtime: { getManifest: () => ({ version: '0.1.0' }),
    sendMessage: async ({ type, payload }) => {
      if (type === 'saveBugReport') {
        saves++;
        reports.push({ ...payload, id: 'test-id', createdAt: new Date().toISOString(), version: '0.1.0', receipt: null, syncError: 'Offline' });
        return { ok: true, data: reports.at(-1) };
      }
      if (type === 'syncBugReport') reports[0].receipt = { directory: '/scratch/inbox/test-id' };
      return { ok: true, data: type === 'listBugReports' ? reports : reports[0] };
    } } };
  try {
    window.eval(script);
    const image = new window.File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'paste.png', { type: 'image/png' });
    const paste = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { items: [{ type: 'image/png', getAsFile: () => image }] } });
    window.document.dispatchEvent(paste);
    const waitFor = async (condition) => {
      for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, 5)); }
      throw new Error('Form did not settle');
    };
    await waitFor(() => window.document.querySelector('#previews img'));
    expect(paste.defaultPrevented).toBe(true);
    const notes = window.document.getElementById('notes');
    notes.value = 'My resume folder stopped updating.';
    const form = window.document.getElementById('reportForm');
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await waitFor(() => window.document.getElementById('inbox').textContent.includes('waiting for the file inbox'));
    expect(saves).toBe(1);
    expect(reports[0].text).toBe('My resume folder stopped updating.');
    expect(reports[0].screenshots[0]).toMatch(/^data:image\/png;base64,/);
    expect(notes.value).toBe('');
    expect(window.document.getElementById('previews').children.length).toBe(0);
    window.document.querySelector('#inbox button').click();
    await waitFor(() => window.document.getElementById('inbox').textContent.includes('/scratch/inbox/test-id'));
    expect(saves).toBe(1);
    expect(window.document.querySelectorAll('#inbox img').length).toBe(1);
  } finally { window.close(); }
});

it('keeps notes and images if the local save fails', async () => {
  const dom = new JSDOM(fs.readFileSync(new URL('../../JobHelper/src/reports/report.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' });
  const { window } = dom;
  window.chrome = { runtime: { getManifest: () => ({ version: '1' }), sendMessage: async ({ type }) =>
    type === 'listBugReports' ? { ok: true, data: [] } : { ok: false, error: 'Storage quota exceeded' } } };
  try {
    window.eval(fs.readFileSync(new URL('../../JobHelper/src/reports/report.js', import.meta.url), 'utf8'));
    window.document.getElementById('notes').value = 'Keep these notes';
    window.document.getElementById('reportForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(window.document.getElementById('status').textContent).toContain('Storage quota exceeded');
    expect(window.document.getElementById('notes').value).toBe('Keep these notes');
    expect(window.document.getElementById('save').disabled).toBe(false);
  } finally { window.close(); }
});
