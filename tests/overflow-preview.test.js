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
 * A resume that is too long, while somebody is trying to make it shorter.
 *
 * Auto-fit is a search — compile, measure, shrink, compile again — and it
 * costs one compile on a document that fits and seven on one that is slightly
 * over. Measured on the bundled store: 0.47s against 6.8s, for the difference
 * between 9.93pt and 9.2pt of font. The editor spent all 6.8 seconds holding
 * the previous page on screen with no page count and nothing moving, which is
 * reported, accurately, as "it just freezes" — and it happens exactly when
 * someone is cutting a line and needs to see what they cut.
 *
 * So the preview asks twice: once for the document as written, which is fast
 * and true, and then for the fitted one only if the first did not fit.
 */
describe('a preview of a resume that is too long', () => {
  /** Every `/render` body the page sent, in order. */
  let asked;
  /** Resolves the fitted compile, so the in-between state can be inspected. */
  let releaseFitted;

  const fitLine = () => document.querySelector('#fit');
  const squeezed = () => document.querySelector('#fit .squeezed');

  function boot({ fitsAsWritten, fitsAfterSqueezing = true }) {
    asked = [];
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (url === '/api/store') return { ok: true, json: async () => structuredClone(data) };
        if (url === '/api/ai/jobs') return { ok: true, json: async () => ({ jobs: [] }) };
        if (url !== '/api/render') return { ok: true, json: async () => ({}) };

        const body = JSON.parse(init?.body ?? '{}');
        asked.push(body.fit ?? 'auto');

        if (body.fit === 'as-written') {
          return {
            ok: true,
            json: async () =>
              fitsAsWritten
                ? { pages: 1, fits: true, overflowLines: -6, adjustments: [], warnings: [], pdfUrl: '/pdf/as-written.pdf' }
                : { pages: 2, fits: false, overflowLines: 9, adjustments: [], warnings: [], pdfUrl: '/pdf/as-written.pdf' },
          };
        }

        // The slow one. Held open so the state while it runs can be asserted.
        await new Promise((resolve) => {
          releaseFitted = resolve;
        });
        return {
          ok: true,
          json: async () =>
            fitsAfterSqueezing
              ? {
                  pages: 1,
                  fits: true,
                  overflowLines: -1,
                  adjustments: ['font 11pt → 10pt', 'margins 0.5in → 0.4in'],
                  warnings: [],
                  pdfUrl: '/pdf/fitted.pdf',
                }
              : {
                  pages: 2,
                  fits: false,
                  overflowLines: 40,
                  adjustments: ['font 11pt → 10pt'],
                  warnings: [],
                  pdfUrl: '/pdf/fitted.pdf',
                },
        };
      }),
    );
  }

  beforeEach(() => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    releaseFitted = undefined;
  });

  it('compiles once, and says nothing about squeezing, when it already fits', async () => {
    boot({ fitsAsWritten: true });
    await import('../web/app.js');
    await vi.waitFor(() => expect(fitLine()?.textContent).toContain('Fits on one page'));

    // The second compile is the expensive one. A document that fits must never
    // pay for it.
    expect(asked).toEqual(['as-written']);
    expect(squeezed()).toBeNull();
  });

  /*
   * The half-second that used to be six and a half. The point is not that it
   * is fast — it is that the page count and the overflow are on screen, and
   * the pane is showing the document that produced them, before the fit has
   * even started.
   */
  it('shows the real page count and the real spill before it starts squeezing', async () => {
    boot({ fitsAsWritten: false });
    await import('../web/app.js');

    await vi.waitFor(() => expect(fitLine()?.textContent).toContain('2 pages'));
    expect(fitLine()?.textContent).toContain('9 lines too long');
    expect(squeezed()?.textContent).toContain('Squeezing it onto one page');
    // And it is saying so about the document it is actually showing.
    expect(asked).toEqual(['as-written', 'auto']);
  });

  it('swaps in the squeezed version, and names what it did to get there', async () => {
    boot({ fitsAsWritten: false });
    await import('../web/app.js');
    await vi.waitFor(() => expect(releaseFitted).toBeTypeOf('function'));
    releaseFitted();

    await vi.waitFor(() => expect(fitLine()?.textContent).toContain('Fits on one page'));
    const note = squeezed();
    expect(note?.textContent).toContain('Squeezed to fit');
    expect(note?.textContent).toContain('font 11pt → 10pt');
    expect(note?.textContent).toContain('margins 0.5in → 0.4in');
    // Still on its own line rather than trailing off the end of "Fits".
    expect(note?.tagName).toBe('DIV');
    expect(note?.classList.contains('working')).toBe(false);
  });

  /*
   * Squeezing has a floor, and below it the honest answer is "this is two
   * pages". The fit line has to keep saying so after the second compile comes
   * back, rather than reverting to whatever the first one said.
   */
  it('still reports two pages when even the squeezed version does not fit', async () => {
    boot({ fitsAsWritten: false, fitsAfterSqueezing: false });
    await import('../web/app.js');
    await vi.waitFor(() => expect(releaseFitted).toBeTypeOf('function'));
    releaseFitted();

    await vi.waitFor(() => expect(squeezed()?.classList.contains('working')).toBe(false));
    expect(fitLine()?.className).toContain('bad');
    expect(fitLine()?.textContent).toContain('2 pages');
    expect(fitLine()?.textContent).toContain('40 lines too long');
  });
});
