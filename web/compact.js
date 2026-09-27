/**
 * The builder at the width of a side panel.
 *
 * The browser extension shows this editor beside a job posting, in a panel
 * 320–500px wide. The two-column builder there was one long column with the
 * preview at the very bottom, a toolbar five rows tall that stuck to the top
 * and covered a third of the screen, and a header wider than the window.
 *
 * Narrow, three things change, all of them views of the same page rather than
 * a second editor:
 *
 *  - Edit or Preview. One of the two columns at a time, switched from the
 *    toolbar, so the preview gets the whole panel rather than the bottom of a
 *    long scroll. Both columns stay in the page — the one not shown is only
 *    hidden — so nothing typed, scrolled or half-saved is lost by looking.
 *  - Focus. Only the entry being worked in is shown whole; every other entry
 *    folds to its heading until clicked. Nothing is written: the fold that is
 *    saved with a resume (`setCollapsed`) is a fact about the document, and
 *    this is only about the screen.
 *  - The toolbar's less-used half behind "More", so the row that stays on
 *    screen is the resume, whether it saved, and these switches. More is a
 *    menu floating over the page: opening it had put its buttons in rows of
 *    their own that pushed the resume down by a fifth of a 320px panel and
 *    wrapped the bar. It closes on Escape (back to More), a click anywhere
 *    else, focus leaving it, or once one of its buttons is pressed; the
 *    arrow keys, Home and End move through it, and so does Tab.
 *
 * Kept apart from app.js so it can be tested on its own, and so the wide
 * layout — where none of this applies — is untouched by it: every rule it
 * relies on is under the narrow media query in style.css, and the classes it
 * sets mean nothing outside it.
 */

export const NARROW_QUERY = '(max-width: 640px)';

/**
 * Which entry this is, stable across redraws. Entries and projects carry
 * their id; the profile and the skill groups do not, and are named by what
 * they are.
 */
export function keyOf(entry) {
  if (!entry) return null;
  if (entry.dataset.dragId) return entry.dataset.dragId;
  if (entry.classList.contains('profile-entry')) return 'profile';
  const title = entry.querySelector('.entry-head .title')?.textContent;
  return title ? `group:${title}` : null;
}
const VIEWS = ['edit', 'preview'];
const STORAGE_KEY = 'rmm.compact';

export function setupCompact({ doc = document, win = window, onPreviewShown = () => {}, onChange = () => {}, onZoom = () => {} } = {}) {
  const body = doc.body;
  const toolbar = doc.querySelector('#tab-resumes .sticky-toolbar');
  const editor = doc.querySelector('#editor');
  const viewButtons = [...doc.querySelectorAll('#narrow-view [data-view]')];
  const focusButton = doc.querySelector('#btn-focus');
  const moreButton = doc.querySelector('#btn-more');
  const moreMenu = doc.querySelector('#toolbar-more');
  const zoomButton = doc.querySelector('#preview-zoom');
  const tipsButton = doc.querySelector('#btn-tips');
  const fit = doc.querySelector('#fit');
  const warnings = doc.querySelector('#warnings');

  const saved = (() => {
    try {
      return JSON.parse(win.localStorage?.getItem(STORAGE_KEY) ?? '{}') ?? {};
    } catch {
      return {};
    }
  })();
  const state = {
    view: VIEWS.includes(saved.view) ? saved.view : 'edit',
    focus: saved.focus === true,
    more: false,
    zoomed: false,
    tips: false,
    fitOpen: false,
    /** The entry last worked in, by id, which Focus keeps open. */
    active: null,
  };

  const remember = () => {
    try {
      win.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ view: state.view, focus: state.focus }));
    } catch {
      // Storage refused (a partitioned or full store): the view still works,
      // it just starts from Edit next time.
    }
  };

  /** Mark which entry Focus keeps open, on whatever the editor last drew. */
  const markActive = () => {
    if (!editor) return;
    const entries = [...editor.querySelectorAll('.entry:not(.off)')];
    // Nothing chosen yet, or the one chosen has gone: the first entry with an
    // id — a job, a project — so Focus never opens on headings alone.
    const known = entries.some((e) => keyOf(e) === state.active);
    const active = known ? state.active : keyOf(entries.find((e) => e.dataset.dragId) ?? entries[0]);
    for (const entry of entries) entry.classList.toggle('focus-active', keyOf(entry) === active);
  };

  const paint = () => {
    body.dataset.view = state.view;
    body.classList.toggle('focus-mode', state.focus);
    for (const b of viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
    if (focusButton) {
      focusButton.setAttribute('aria-pressed', String(state.focus));
      // Focus is about the list of entries, which the preview does not show.
      focusButton.disabled = state.view !== 'edit';
    }
    if (moreButton) moreButton.setAttribute('aria-expanded', String(state.more));
    body.classList.toggle('tips-open', state.tips);
    tipsButton?.setAttribute('aria-expanded', String(state.tips));
    body.classList.toggle('fit-open', state.fitOpen);
    fit?.setAttribute('aria-expanded', String(state.fitOpen));
    if (zoomButton) {
      zoomButton.setAttribute('aria-pressed', String(state.zoomed));
      zoomButton.textContent = state.zoomed ? 'Fit width' : 'Actual size';
    }
    toolbar?.classList.toggle('more-open', state.more);
    markActive();
  };

  const narrow = () => Boolean(win.matchMedia?.(NARROW_QUERY).matches);

  const api = {
    get view() {
      return state.view;
    },
    get focus() {
      return state.focus;
    },
    narrow,
    setView(view) {
      if (!VIEWS.includes(view) || view === state.view) return;
      state.view = view;
      paint();
      remember();
      // The preview was hidden, so what it last drew was drawn for no width.
      if (view === 'preview') onPreviewShown();
      onChange();
    },
    setFocus(on) {
      if (Boolean(on) === state.focus) return;
      state.focus = Boolean(on);
      paint();
      remember();
      onChange();
    },
    setMore(open) {
      state.more = Boolean(open);
      paint();
      // Hung from More itself, which is on the toolbar's first row of two in
      // a tab of its own, rather than from the toolbar's foot; 6px down, clear
      // of More's focus ring.
      if (state.more && moreMenu && moreButton && toolbar) {
        const below = moreButton.getBoundingClientRect().bottom - toolbar.getBoundingClientRect().top;
        if (below > 0) moreMenu.style.top = `${Math.round(below + 6)}px`;
      }
    },
    setTips(open) {
      state.tips = Boolean(open);
      paint();
    },
    setFitOpen(open) {
      state.fitOpen = Boolean(open);
      paint();
    },
    /** Called after the editor redraws, which replaces every entry. */
    refresh: markActive,
  };

  for (const b of viewButtons) b.addEventListener('click', () => api.setView(b.dataset.view));
  focusButton?.addEventListener('click', () => api.setFocus(!state.focus));
  moreButton?.addEventListener('click', () => api.setMore(!state.more));
  tipsButton?.addEventListener('click', () => api.setTips(!state.tips));

  /* ---- More, as a menu ---- */

  /** The buttons in the menu that can be pressed now, in order. */
  const menuItems = () =>
    [...(moreMenu?.children ?? [])].filter(
      (el) => el.tagName === 'BUTTON' && !el.hidden && !el.disabled && doc.defaultView?.getComputedStyle(el).display !== 'none',
    );
  /** Shut, and — if focus was in it or on More — back to More, not to nowhere. */
  const closeMore = ({ refocus = false } = {}) => {
    if (!state.more) return;
    const inside = moreMenu?.contains(doc.activeElement);
    api.setMore(false);
    if ((refocus || inside) && moreButton) moreButton.focus({ preventScroll: true });
  };
  const moveIn = (to) => {
    const items = menuItems();
    if (!items.length) return;
    const at = items.indexOf(doc.activeElement);
    const next =
      to === 'first' ? 0 : to === 'last' ? items.length - 1 : at < 0 ? (to > 0 ? 0 : items.length - 1) : (at + to + items.length) % items.length;
    items[next].focus();
  };

  moreButton?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    if (!state.more) api.setMore(true);
    moveIn(ev.key === 'ArrowDown' ? 'first' : 'last');
  });
  moreMenu?.addEventListener('keydown', (ev) => {
    if (!state.more) return;
    const step = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' }[ev.key];
    if (step === undefined) return;
    ev.preventDefault();
    moveIn(step);
  });
  // A choice made: the menu goes, after the button has done its work.
  moreMenu?.addEventListener('click', (ev) => {
    if (state.more && ev.target?.closest?.('button')) closeMore();
  });
  doc.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !state.more) return;
    ev.preventDefault();
    closeMore({ refocus: true });
  });
  // A click anywhere else, in this page. Pointerdown, so a click that starts
  // something else (a drag, an edit) does not have the menu still over it.
  doc.addEventListener(
    'pointerdown',
    (ev) => {
      if (!state.more) return;
      if (moreMenu?.contains(ev.target) || moreButton?.contains(ev.target)) return;
      closeMore();
    },
    true,
  );
  // Tab or Shift+Tab out of it, or a click outside this page altogether (the
  // side panel's own bar, around the frame this page is in).
  moreMenu?.addEventListener('focusout', (ev) => {
    const to = ev.relatedTarget;
    if (!state.more || !to || moreMenu.contains(to) || to === moreButton) return;
    api.setMore(false);
  });
  win.addEventListener?.('blur', () => closeMore());
  // Widened past the narrow layout, there is no menu for it to be.
  win.matchMedia?.(NARROW_QUERY).addEventListener?.('change', (ev) => {
    if (!ev.matches) api.setMore(false);
  });

  /*
   * The fit line opens on a tap or Enter, narrow only: wide, the whole
   * banner is already there and there is nothing behind it to open.
   */
  if (fit) {
    const toggleFit = () => {
      if (narrow()) api.setFitOpen(!state.fitOpen);
    };
    fit.addEventListener('click', (ev) => {
      if (!ev.target.closest?.('button, a')) toggleFit();
    });
    fit.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      toggleFit();
    });
    const role = () => {
      if (narrow()) {
        fit.setAttribute('role', 'button');
        fit.tabIndex = 0;
      } else {
        fit.removeAttribute('role');
        fit.removeAttribute('tabindex');
      }
    };
    role();
    win.matchMedia?.(NARROW_QUERY).addEventListener?.('change', role);
  }

  /*
   * What is behind the fit line, counted onto it: the notes a compile left
   * that ask for nothing, and the line saying how it was squeezed. The ones
   * with a button stay on screen, so they are not counted.
   */
  const countNotes = () => {
    if (!fit) return;
    const notes = warnings ? [...warnings.children].filter((w) => !w.querySelector('button')).length : 0;
    const squeezed = fit.querySelector('.squeezed') ? 1 : 0;
    const said = notes ? `${notes} note${notes === 1 ? '' : 's'}` : squeezed ? 'More' : '';
    if (said) fit.dataset.notes = said;
    else delete fit.dataset.notes;
  };
  if (typeof win.MutationObserver === 'function') {
    const watch = new win.MutationObserver(countNotes);
    if (fit) watch.observe(fit, { childList: true });
    if (warnings) watch.observe(warnings, { childList: true });
  }
  countNotes();

  zoomButton?.addEventListener('click', () => {
    state.zoomed = !state.zoomed;
    paint();
    onZoom(state.zoomed ? 1 : 'fit');
  });

  /*
   * What counts as working in an entry: a click or the keyboard landing
   * anywhere inside it. A folded entry's heading is the way to open it, so
   * that click is the choice, and the switch on it still works as a switch.
   */
  const choose = (ev) => {
    const entry = ev.target?.closest?.('.entry:not(.off)');
    const key = keyOf(entry);
    if (!key || key === state.active) return;
    state.active = key;
    if (!state.focus) return;
    /*
     * Held where it was clicked. Opening it folds the one above, and the page
     * under the pointer would jump up by however tall that entry was — the
     * heading just clicked sliding away from the hand that clicked it.
     */
    const before = entry.getBoundingClientRect().top;
    markActive();
    const moved = entry.getBoundingClientRect().top - before;
    if (moved) win.scrollBy?.(0, moved);
  };
  editor?.addEventListener('pointerdown', choose, true);
  editor?.addEventListener('focusin', choose);

  // The editor is redrawn from scratch on nearly every change; the mark has
  // to follow it onto the new entries.
  // Once per batch of changes: a redraw is hundreds of insertions, and the
  // classes this toggles are attributes, which the observer does not watch.
  if (editor && typeof win.MutationObserver === 'function') {
    let queued = false;
    new win.MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        markActive();
      });
    }).observe(editor, { childList: true, subtree: true });
  }

  /*
   * AI feedback opens in the preview's column, which the Edit view hides —
   * so asking for it narrow put the answer somewhere nobody could see. It
   * brings its column with it.
   */
  const feedback = doc.querySelector('#feedback-panel');
  if (feedback && typeof win.MutationObserver === 'function') {
    new win.MutationObserver(() => {
      if (!feedback.hidden && narrow()) api.setView('preview');
    }).observe(feedback, { attributes: true, attributeFilter: ['hidden'] });
  }

  paint();
  return api;
}
