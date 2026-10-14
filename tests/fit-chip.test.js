// @vitest-environment jsdom
/**
 * The fit chip: what it says, and about which document.
 *
 * `renderPreview` was the only thing that wrote `#fit`, and it wrote it only
 * once a compile answered. Everything that asked for a compile — switching
 * resumes, changing the page settings — left the chip saying what it said
 * last, which after a switch was the previous resume's verdict over the new
 * resume's page. And what it said of a fit was "Fits on one page", whatever
 * the count: a two-page resume allowed two pages was called one.
 */
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

/** Every `/render` body the page sent, as `resume:fit`, in order. */
let renders;
/** When set, the next `/render` for this resume id is held open until `release()`. */
let holdNext;
let release;

/**
 * A server whose compiles answer with `answer(resumeId)`.
 *
 * `GET /store` sends config down to git and the AI switch, as the real one
 * does; the save-wide page settings come from `GET /config`, as they really
 * do, and `configLayout` is what that says.
 */
function boot(answer, { configLayout = {}, resumeLayout } = {}) {
  renders = [];
  holdNext = null;
  release = undefined;
  const fixture = makeTempStore();
  const data = fixture.store.load();
  fixture.cleanup();
  if (resumeLayout) data.resumes.find((r) => r.id === 'newgrad').layout = resumeLayout;
  const store = { ...data, config: { git: data.config.git, ai: { enabled: false } } };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      if (url === '/api/store') return { ok: true, json: async () => structuredClone(store) };
      if (url === '/api/config') return { ok: true, json: async () => ({ layout: configLayout }) };
      if (url === '/api/ai/jobs') return { ok: true, json: async () => ({ jobs: [] }) };
      if (url !== '/api/render') return { ok: true, json: async () => ({}) };

      const body = JSON.parse(init?.body ?? '{}');
      const id = body.spec?.id;
      renders.push(`${id}:${body.fit ?? 'auto'}`);
      if (holdNext === id) {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return { ok: true, json: async () => answer(id) };
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  window.location.hash = '#resumes/newgrad';
});

const fit = () => document.querySelector('#fit');
/** An answer, and the final one: the interim "Squeezing it…" is not. */
const settled = () =>
  vi.waitFor(() => {
    expect(fit()?.classList.contains('idle')).toBe(false);
    expect(fit()?.querySelector('.squeezed.working')).toBeNull();
  });

const onOnePage = { pages: 1, fits: true, overflowLines: -6, adjustments: [], warnings: [], pdfUrl: '/pdf/a.pdf' };
const overTwo = { pages: 2, fits: false, overflowLines: 12, adjustments: [], warnings: [], pdfUrl: '/pdf/b.pdf' };

describe('the fit chip across a switch of resume', () => {
  /*
   * The newgrad resume fits; the intern one is two pages and cannot be
   * rescued. Between choosing the second and its compile answering, the chip
   * read "Fits on one page" — settled, in the colour of a verdict, and about
   * the other document.
   */
  it('forgets the previous resume’s verdict while the next one compiles', async () => {
    boot((id) => (id === 'newgrad' ? onOnePage : overTwo));
    await import('../web/app.js');
    await vi.waitFor(() => expect(fit()?.textContent).toContain('Fits on one page'));
    await settled();

    holdNext = 'intern';
    const select = document.querySelector('#resume-select');
    select.value = 'intern';
    select.dispatchEvent(new Event('change'));
    // Past the debounce: the request for the new resume is in flight and held open.
    await vi.waitFor(() => expect(renders.some((r) => r.startsWith('intern:'))).toBe(true), { timeout: 5000 });
    expect(fit().className).toBe('fit idle');
    expect(fit().textContent).toBe('Compiling…');

    release();
    await vi.waitFor(() => expect(fit()?.textContent).toContain('too long'), { timeout: 5000 });
    expect(fit().className).toBe('fit bad');
  });
});

describe('what the chip says of a resume that fits', () => {
  it('counts the pages a resume allowed two really has', async () => {
    boot(() => ({
      pages: 2,
      fits: true,
      maxPages: 2,
      overflowLines: -15,
      adjustments: ['font 10.5pt → 12pt'],
      grew: true,
      warnings: [],
      pdfUrl: '/pdf/two.pdf',
    }));
    await import('../web/app.js');
    await vi.waitFor(() => expect(fit()?.textContent).toContain('Fits on'));
    await settled();
    expect(fit().textContent).toContain('Fits on 2 pages (2 allowed)');
    expect(fit().textContent).not.toContain('one page');
  });

  it('still says one page of a one-page resume, as it always did', async () => {
    boot(() => ({ ...onOnePage, maxPages: 1 }));
    await import('../web/app.js');
    await vi.waitFor(() => expect(fit()?.textContent).toContain('Fits on one page'));
    await settled();
    expect(fit().textContent).not.toContain('allowed');
  });

  // An older server says nothing about the allowance; the save's own page settings do.
  it('and reads the allowance off the save when the server does not say', async () => {
    boot(() => onOnePage, { configLayout: { maxPages: 2 } });
    await import('../web/app.js');
    await vi.waitFor(() => expect(fit()?.textContent).toContain('Fits on'));
    await settled();
    expect(fit().textContent).toContain('Fits on one page (2 allowed)');
  });
});

describe('a save whose page settings turn auto-fit off', () => {
  /*
   * `autoFit: false` in config.yaml, and a resume with no page settings of
   * its own. The server answers the fitted compile as written — there is
   * nothing to fit — and the editor, reading only the resume's own layout,
   * asked for it anyway and said "Squeezing it onto one page…" over a resume
   * nothing was going to squeeze.
   */
  it('asks for the resume as written only, and promises no squeeze', async () => {
    boot(() => overTwo, { configLayout: { autoFit: false } });
    await import('../web/app.js');
    await vi.waitFor(() => expect(fit()?.textContent).toContain('too long'));
    // Long enough for a second request to have been made, had one been coming.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(renders).toEqual(['newgrad:as-written']);
    expect(fit().querySelector('.squeezed.working')).toBeNull();
  });

  it('unless the resume on screen turns it back on for itself', async () => {
    boot(() => overTwo, { configLayout: { autoFit: false }, resumeLayout: { autoFit: true } });
    await import('../web/app.js');
    await vi.waitFor(() => expect(renders).toEqual(['newgrad:as-written', 'newgrad:auto']), { timeout: 5000 });
  });
});
