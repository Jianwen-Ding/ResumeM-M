// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { keyOf, setupCompact } from '../web/compact.js';

/*
 * The builder at the width of a side panel. See web/compact.js.
 *
 * The switches are views of one page: which column is shown, which entry is
 * open, whether the toolbar's second half is out. Checked here on the real
 * markup, with a window whose width is whatever the test says.
 */

const page = () => {
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  // Three entries as the editor draws them, and the profile above them.
  document.querySelector('#editor').innerHTML = `
    <div class="entry profile-entry"><div class="head">Morgan Testwell</div><div class="profile-grid">x</div></div>
    <div class="entry" data-drag-id="acme"><div class="entry-head"><span class="title">Acme</span></div><div class="field">a</div></div>
    <div class="entry off collapsed" data-drag-id="old"><span class="title">Old job</span></div>
    <div class="entry" data-drag-id="globex"><div class="entry-head"><span class="title">Globex</span></div><div class="field">g</div></div>
    <div class="entry"><div class="entry-head"><span class="title">Languages</span></div></div>`;
};

const windowAt = (width) => ({
  matchMedia: (q) => ({ matches: /max-width:\s*640px/.test(q) && width <= 640 }),
  localStorage: window.localStorage,
  MutationObserver: window.MutationObserver,
  scrollBy: vi.fn(),
});

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  window.localStorage.clear();
  page();
});
afterEach(() => {
  document.body.removeAttribute('data-view');
  document.body.className = '';
});

describe('Edit or Preview', () => {
  it('shows one column at a time and says which is pressed', () => {
    const shown = vi.fn();
    const compact = setupCompact({ win: windowAt(400), onPreviewShown: shown });
    expect(document.body.dataset.view).toBe('edit');

    document.querySelector('#narrow-view [data-view=preview]').click();
    expect(document.body.dataset.view).toBe('preview');
    expect(compact.view).toBe('preview');
    expect(document.querySelector('#narrow-view [data-view=preview]').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('#narrow-view [data-view=edit]').getAttribute('aria-pressed')).toBe('false');
    // The preview was hidden, so it is asked to draw itself for the width it
    // has now.
    expect(shown).toHaveBeenCalledTimes(1);
    // Focus is about the list of entries, which is not on screen.
    expect(document.querySelector('#btn-focus').disabled).toBe(true);
  });

  it('is remembered in this browser, and put back', () => {
    setupCompact({ win: windowAt(400) }).setView('preview');
    page();
    const again = setupCompact({ win: windowAt(400) });
    expect(again.view).toBe('preview');
    expect(document.body.dataset.view).toBe('preview');
  });

  it('brings the preview column out when AI feedback opens in it, narrow only', async () => {
    const compact = setupCompact({ win: windowAt(400) });
    document.querySelector('#feedback-panel').hidden = false;
    await tick();
    expect(compact.view).toBe('preview');

    page();
    window.localStorage.clear();
    const wide = setupCompact({ win: windowAt(1200) });
    document.querySelector('#feedback-panel').hidden = false;
    await tick();
    expect(wide.view).toBe('edit');
  });
});

describe('Focus', () => {
  const active = () => [...document.querySelectorAll('#editor .focus-active')].map(keyOf);

  it('keeps one entry open — the first job until another is chosen', async () => {
    setupCompact({ win: windowAt(400) });
    document.querySelector('#btn-focus').click();
    expect(document.body.classList.contains('focus-mode')).toBe(true);
    expect(document.querySelector('#btn-focus').getAttribute('aria-pressed')).toBe('true');
    expect(active()).toEqual(['acme']);

    document.querySelector('[data-drag-id=globex] .title').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(active()).toEqual(['globex']);
  });

  it('follows the editor redrawing every entry', async () => {
    setupCompact({ win: windowAt(400) });
    document.querySelector('#btn-focus').click();
    document.querySelector('[data-drag-id=globex] .title').dispatchEvent(new Event('pointerdown', { bubbles: true }));

    // What `renderEditor` does: throw every control away and build new ones.
    const editor = document.querySelector('#editor');
    editor.innerHTML = editor.innerHTML.replace(/ focus-active/g, '');
    await tick();
    expect(active()).toEqual(['globex']);
  });

  it('names the profile and the skill groups, which carry no id', () => {
    const [profile, , , , skills] = document.querySelectorAll('#editor .entry');
    expect(keyOf(profile)).toBe('profile');
    expect(keyOf(skills)).toBe('group:Languages');
  });

  it('holds the chosen heading where it was clicked', () => {
    const win = windowAt(400);
    setupCompact({ win });
    document.querySelector('#btn-focus').click();
    const globex = document.querySelector('[data-drag-id=globex]');
    const acme = document.querySelector('[data-drag-id=acme]');
    // Opening it folds Acme above it, which moves it up by Acme's height.
    globex.getBoundingClientRect = () => ({ top: acme.classList.contains('focus-active') ? 500 : 320 });
    globex.querySelector('.title').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(win.scrollBy).toHaveBeenCalledWith(0, -180);
  });
});

describe('More', () => {
  it('opens and closes the toolbar’s second half, and says which', () => {
    setupCompact({ win: windowAt(400) });
    const more = document.querySelector('#btn-more');
    const bar = document.querySelector('#tab-resumes .sticky-toolbar');
    more.click();
    expect(bar.classList.contains('more-open')).toBe(true);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    more.click();
    expect(bar.classList.contains('more-open')).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps every button the wide toolbar had, in the order it had them', () => {
    /*
     * The order on screen: Undo and Redo sit after More's group in the markup,
     * so they can stay on the bar when it is a menu, and the stylesheet's
     * `order`s (outside any media query, which jsdom does not apply anyway)
     * put the wide toolbar back as it was. #toolbar-more is `display:
     * contents` wide, so its buttons are ordered as the toolbar's own.
     */
    const style = document.createElement('style');
    style.textContent = fs.readFileSync('web/style.css', 'utf8');
    document.head.append(style);
    const orderOf = (b) => Number(getComputedStyle(b).order || 0);
    const ids = [...document.querySelectorAll('#tab-resumes .sticky-toolbar button')]
      .filter((b) => !b.closest('.narrow-only') && !b.classList.contains('narrow-only'))
      .map((b, i) => ({ b, i }))
      .sort((x, y) => orderOf(x.b) - orderOf(y.b) || x.i - y.i)
      .map(({ b }) => b.id);
    expect(getComputedStyle(document.querySelector('#toolbar-more')).display).toBe('contents');
    style.remove();
    expect(ids).toEqual([
      'btn-base', 'btn-save-as', 'btn-rename-resume', 'btn-delete-resume', 'btn-feedback',
      'btn-rebuild', 'btn-undo', 'btn-redo', 'btn-add-entry',
    ]);
  });

  it('says what it opens: a group of buttons, named, that More controls', () => {
    const more = document.querySelector('#btn-more');
    const menu = document.querySelector('#toolbar-more');
    expect(more.getAttribute('aria-haspopup')).toBe('true');
    expect(more.getAttribute('aria-controls')).toBe('toolbar-more');
    expect(menu.getAttribute('role')).toBe('group');
    expect(menu.getAttribute('aria-label')).toBeTruthy();
    // Undo and Redo stay on the bar; the how-to and what the resume is go in the menu.
    expect(menu.contains(document.querySelector('#btn-undo'))).toBe(false);
    expect(menu.contains(document.querySelector('#btn-redo'))).toBe(false);
    expect(menu.contains(document.querySelector('#btn-tips'))).toBe(true);
    expect(menu.contains(document.querySelector('#btn-base'))).toBe(true);
    // Right after More, so Tab from it goes into the menu.
    expect(more.nextElementSibling).toBe(menu);
  });
});

describe('More, as a menu', () => {
  const open = () => {
    const compact = setupCompact({ win: windowAt(320) });
    const more = document.querySelector('#btn-more');
    more.focus();
    more.click();
    return { compact, more, bar: document.querySelector('#tab-resumes .sticky-toolbar') };
  };
  const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));

  it('closes on Escape, and puts focus back on More', () => {
    const { more, bar } = open();
    document.querySelector('#btn-rename-resume').focus();
    key(document.activeElement, 'Escape');
    expect(bar.classList.contains('more-open')).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more);
  });

  it('closes on a click anywhere else, and not on one inside it', () => {
    const { bar } = open();
    document.querySelector('#toolbar-more').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(bar.classList.contains('more-open')).toBe(true);
    document.querySelector('#editor').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(bar.classList.contains('more-open')).toBe(false);
  });

  it('closes once something in it is chosen, after that has run', () => {
    const { more, bar } = open();
    const rebuild = document.querySelector('#btn-rebuild');
    let ranOpen = null;
    rebuild.addEventListener('click', () => (ranOpen = bar.classList.contains('more-open')));
    rebuild.focus();
    rebuild.click();
    expect(ranOpen).toBe(true);
    expect(bar.classList.contains('more-open')).toBe(false);
    // Not left on a button that is no longer on screen.
    expect(document.activeElement).toBe(more);
  });

  it('opens the how-to from inside it, and closes', () => {
    const { bar } = open();
    document.querySelector('#btn-tips').click();
    expect(document.body.classList.contains('tips-open')).toBe(true);
    expect(bar.classList.contains('more-open')).toBe(false);
  });

  it('moves through its buttons with the arrow keys, Home and End', () => {
    const { more } = open();
    const menu = document.querySelector('#toolbar-more');
    const ids = [...menu.querySelectorAll('button')].filter((b) => !b.disabled && !b.hidden).map((b) => b.id);
    key(more, 'ArrowDown');
    expect(document.activeElement.id).toBe(ids[0]);
    key(document.activeElement, 'ArrowDown');
    expect(document.activeElement.id).toBe(ids[1]);
    key(document.activeElement, 'ArrowUp');
    key(document.activeElement, 'ArrowUp');
    expect(document.activeElement.id).toBe(ids.at(-1));
    key(document.activeElement, 'Home');
    expect(document.activeElement.id).toBe(ids[0]);
    key(document.activeElement, 'End');
    expect(document.activeElement.id).toBe(ids.at(-1));
  });

  it('opens from the keyboard on More with ArrowDown', () => {
    setupCompact({ win: windowAt(320) });
    const more = document.querySelector('#btn-more');
    key(more, 'ArrowDown');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('#toolbar-more').contains(document.activeElement)).toBe(true);
  });

  it('closes when focus leaves it for somewhere else', () => {
    const { bar } = open();
    const last = document.querySelector('#btn-add-entry');
    last.focus();
    document.querySelector('#btn-undo').disabled = false;
    document.querySelector('#btn-undo').focus();
    expect(bar.classList.contains('more-open')).toBe(false);
  });
});

describe('the zoom on the preview', () => {
  it('toggles between the page’s real size and the pane’s width', () => {
    const zoom = vi.fn();
    setupCompact({ win: windowAt(400), onZoom: zoom });
    const button = document.querySelector('#preview-zoom');
    button.click();
    expect(zoom).toHaveBeenLastCalledWith(1);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toBe('Fit width');
    button.click();
    expect(zoom).toHaveBeenLastCalledWith('fit');
    expect(button.textContent).toBe('Actual size');
  });
});

/*
 * The stylesheet, read as rules.
 *
 * jsdom lays nothing out and ignores media queries, so the narrow layout
 * itself is checked in a real browser (JobHelper's tests/panel.mjs). What can
 * be checked here is the one mistake that already happened once: a rule
 * later in the file giving the narrow-only controls a display of their own,
 * which put Edit / Preview on the wide toolbar.
 */
describe('the stylesheet', () => {
  const css = fs.readFileSync('web/style.css', 'utf8');
  const outside = css.replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');

  it('hides the narrow-only controls wide, after anything that gives them a display', () => {
    const hidden = outside.lastIndexOf('.narrow-only { display: none; }');
    expect(hidden).toBeGreaterThan(-1);
    for (const rule of ['.segmented {', 'button.tiny[aria-pressed="true"]']) {
      expect(outside.indexOf(rule)).toBeLessThan(hidden);
    }
  });

  it('keeps the whole narrow layout under one query', () => {
    const narrow = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    for (const rule of ['.narrow-only { display: inline-flex; }', 'body:not([data-view="preview"]) .pane-right',
      'body.focus-mode #editor', '.modal-body { width: calc(100vw - 16px)']) {
      expect(narrow).toContain(rule);
    }
  });
});
