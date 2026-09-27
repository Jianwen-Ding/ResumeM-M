// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { setupCompact } from '../web/compact.js';

/*
 * The editor inside the browser extension's side panel: what it leaves out.
 *
 * In a 360px panel the app's header, its tabs, the save chip, the AI chip and
 * the editor's own resume picker came to a third of the height before any of
 * the resume — and the panel's own bar already names the resume, switches it,
 * says when another save is open and opens the whole editor in a tab. So
 * framed by the extension (`.embedded`, set by embed.js) they are not drawn,
 * and in the editor's own tab nothing changes.
 *
 * jsdom applies the stylesheet's plain rules though not its media queries,
 * which is why these rules are written outside one.
 */

const load = (embedded) => {
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  const style = document.createElement('style');
  style.textContent = fs.readFileSync('web/style.css', 'utf8');
  document.head.append(style);
  document.documentElement.classList.toggle('embedded', embedded);
};
const shown = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none';
const HIDDEN_IN_PANEL = ['header h1', '#tabs', '#project-chip', '#ai-peek-chip', '#resume-select'];

describe('framed by the extension', () => {
  it('leaves out the header, the tabs, the save and AI chips, and its own picker', () => {
    load(true);
    for (const sel of HIDDEN_IN_PANEL) expect(shown(sel), sel).toBe(false);
  });

  it('keeps what it still has to say, floating rather than taking a row', () => {
    load(true);
    const header = getComputedStyle(document.querySelector('header'));
    expect(header.position).toBe('fixed');
    // A status line only when there is something in it.
    expect(shown('#status')).toBe(false);
    document.querySelector('#status').textContent = 'Saved';
    expect(shown('#status')).toBe(true);
    expect(shown('#tab-resumes .sticky-toolbar')).toBe(true);
    expect(shown('#btn-undo')).toBe(true);
    expect(shown('#save-state')).toBe(true);
  });
});

describe('in its own tab', () => {
  it('draws every one of them, as it always did', () => {
    load(false);
    for (const sel of HIDDEN_IN_PANEL) expect(shown(sel), sel).toBe(true);
    expect(getComputedStyle(document.querySelector('header')).position).toBe('sticky');
  });
});

describe('the compact how-to and fit line', () => {
  const narrow = () => ({
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    localStorage: window.localStorage,
    MutationObserver: window.MutationObserver,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => load(true));

  it('opens the two lines of how-to from "?", and says it has', () => {
    setupCompact({ win: narrow() });
    const tips = document.querySelector('#btn-tips');
    expect(document.body.classList.contains('tips-open')).toBe(false);
    tips.click();
    expect(document.body.classList.contains('tips-open')).toBe(true);
    expect(tips.getAttribute('aria-expanded')).toBe('true');
  });

  it('counts what is behind the fit line, and opens it on a tap or Enter', async () => {
    setupCompact({ win: narrow() });
    const fit = document.querySelector('#fit');
    fit.innerHTML = 'Fits on one page<div class="squeezed">Enlarged to fill the page</div>';
    document.querySelector('#warnings').innerHTML =
      '<div>Ligatures are switched off</div><div class="orphan"><span class="what">Gone</span><button>Remove</button></div>';
    await tick();
    // The one with a button stays on screen and is not counted.
    expect(fit.dataset.notes).toBe('1 note');
    expect(fit.getAttribute('role')).toBe('button');

    fit.click();
    expect(document.body.classList.contains('fit-open')).toBe(true);
    expect(fit.getAttribute('aria-expanded')).toBe('true');
    fit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(document.body.classList.contains('fit-open')).toBe(false);

    document.querySelector('#warnings').innerHTML = '';
    await tick();
    expect(fit.dataset.notes).toBe('More');
    fit.innerHTML = 'Fits on one page';
    await tick();
    expect(fit.dataset.notes).toBeUndefined();
  });

  it('leaves the fit banner alone wide, where nothing is behind it', () => {
    const wide = { ...narrow(), matchMedia: () => ({ matches: false, addEventListener() {} }) };
    setupCompact({ win: wide });
    const fit = document.querySelector('#fit');
    expect(fit.hasAttribute('role')).toBe(false);
    fit.click();
    expect(document.body.classList.contains('fit-open')).toBe(false);
  });
});
