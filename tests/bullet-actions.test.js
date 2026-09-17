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
 * What sits beside a bullet, and what waits behind the disclosure.
 *
 * Two different promises, and freeing one broke the other. The stepper —
 * ‹ 1/3 › — has to be visible: stepping through the wordings and watching the
 * preview redraw is the fastest thing in the editor and it cannot be behind a
 * click. AI Feedback must not be: it spends minutes and, depending on the
 * command, money, and a button like that on every bullet of every resume is
 * an invitation nobody asked for.
 *
 * Lifting the stepper out of the disclosure took the whole action bar with
 * it, AI Feedback included, and it then showed permanently on every line.
 */
describe('what shows beside a bullet', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/config') result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {} };
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('.bullet-disclosure')).not.toBeNull());
  });

  /*
   * A bullet, not a field. Both use the same disclosure, and the first
   * `.bullet-disclosure` on the page is the profile's name field — which was
   * never the thing that broke, so a test that found it passed either way.
   */
  const bulletWithAlternates = () =>
    [...document.querySelectorAll('.bullet-disclosure')].find(
      (b) => b.querySelector('.bullet-quick-actions .stepper'),
    );

  const feedbackIn = (block) =>
    [...block.querySelectorAll('button')].find((b) => b.textContent.includes('AI Feedback'));

  it('shows the stepper without asking', () => {
    const block = bulletWithAlternates();
    expect(block).toBeTruthy();
    expect(block.querySelector('.stepper').hidden).toBe(false);
  });

  it('keeps AI Feedback behind the disclosure', () => {
    const block = bulletWithAlternates();
    const feedback = feedbackIn(block);
    expect(feedback).toBeTruthy();
    expect(feedback.hidden).toBe(true);
  });

  it('brings it out on a double-click, with the stepper still there', async () => {
    bulletWithAlternates().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await vi.waitFor(() => expect(feedbackIn(bulletWithAlternates()).hidden).toBe(false));
    expect(bulletWithAlternates().querySelector('.stepper').hidden).toBe(false);
  });

  /*
   * And it says it is AI. Pressing one spends minutes; the button beside it
   * is instant, and nothing on screen used to tell them apart.
   */
  it('marks it as AI work', () => {
    const feedback = feedbackIn(bulletWithAlternates());
    expect(feedback.classList.contains('ai-action')).toBe(true);
    expect(feedback.querySelector('.ai-mark')).not.toBeNull();
    expect(feedback.title).toContain('Runs your AI command');
  });
});
