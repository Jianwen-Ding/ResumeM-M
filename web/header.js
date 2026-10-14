/**
 * The header: one row where everything in it fits, the tabs on a row of their
 * own where it does not.
 *
 * Between the phone layout (640px, where style.css already gives the tabs a
 * row of their own) and roughly 1230px, the tabs were narrower than their
 * buttons and scrolled sideways inside a fixed 56px header — with no scrollbar
 * on a system whose scrollbars only show while scrolling, so History and
 * Voice & AI were simply not there. Where the tabs first stop fitting depends
 * on what else is in the row (the save's name, the AI chips while something
 * is running, the error-log button's words), so it is measured here rather
 * than set as a breakpoint: `tabs-row` puts them under the rest whenever one
 * row would hide any of them.
 *
 * The same measuring decides two smaller things:
 *
 *  - The "Log an error" button keeps its words whenever the row still leaves
 *    the status line `STATUS_ROOM` beside them, and goes to its "!" only when
 *    it does not (`log-mark-only`). It used to lose them below a fixed
 *    1500px — and so also where the tabs have a row of their own and the
 *    row above them is half empty.
 *  - An error in the status line wraps onto a second line in the header; one
 *    longer than two lines, or squeezed too narrow to be read, floats whole in
 *    the corner instead (`toast`), as it does on a phone. It was cut at 40
 *    characters with an ellipsis, which is to say the reason was cut off.
 *
 * The header is sticky, and things under it stick below it: its height is
 * `--header-h` on the root, for their offsets (see style.css).
 */

/**
 * What the status line keeps beside the error-log button's words, in px:
 * about eighteen characters, enough for "Saved" or "Compiling…" whole, with
 * anything longer cut with its title holding the rest (an error floats). The
 * old fixed 1500px breakpoint left it about 185px; this lets the words show
 * down to about 1430px with the tabs on one row, and again wherever the tabs
 * have a row of their own. At 1280 with the tabs on one row there is no room
 * for them at all: they would push the status line to nothing and still cut
 * the tabs by some 30px.
 */
export const STATUS_ROOM = 120;
/** Narrower than this, an error in the header could not be read: it floats. */
const STATUS_MIN = 120;

const isFloating = (node) => {
  const style = getComputedStyle(node);
  return style.display === 'none' || style.position === 'fixed' || style.position === 'absolute';
};

/**
 * How wide the status line could be, on the row it shares with `beside`:
 * the row's width less everything else on it. The status is left out, since
 * it is the one that gives up its room (it shrinks first), and the tabs are
 * counted at their whole width, not the width they have been squeezed to.
 */
export function statusRoom(header, beside) {
  const style = getComputedStyle(header);
  const inner = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const gap = parseFloat(style.columnGap) || 0;
  const row = beside.getBoundingClientRect();
  let used = 0;
  let items = 0;
  for (const node of header.children) {
    if (isFloating(node)) continue;
    const box = node.getBoundingClientRect();
    // On another row of the header.
    if (box.bottom <= row.top || box.top >= row.bottom) continue;
    items++;
    if (node.id === 'status') continue;
    used += node.id === 'tabs' ? node.scrollWidth : box.width;
  }
  return inner - used - gap * Math.max(0, items - 1);
}

/**
 * An error in the status line, in the header if two lines hold it and
 * otherwise in the corner. Anything else stays one line, as it was.
 *
 * Nor in the header where it would make the header taller: where the tabs
 * have a row of their own the header wraps, and an error that pushed it onto
 * another line moved everything under it — and `--header-h` was not measured
 * again, so the sticky toolbar slid under the header. It floats instead, and
 * the header keeps the height it had.
 */
export function fitStatus(status) {
  if (!status) return;
  noteFocusBefore(status);
  status.classList.remove('toast');
  if (status.classList.contains('err') && status.textContent && !isFloating(status)) {
    const cut = status.scrollHeight > status.clientHeight + 1 || status.scrollWidth > status.clientWidth + 1;
    let toast = cut || status.clientWidth < STATUS_MIN;
    const header = status.closest('header');
    // The side panel's header floats in a corner (fixed): growing there moves
    // nothing under it, and the error stays in it, above "Log an error".
    if (!toast && header && getComputedStyle(header).position !== 'fixed') {
      const tall = header.getBoundingClientRect().height;
      status.classList.add('toast');
      const without = header.getBoundingClientRect().height;
      status.classList.remove('toast');
      toast = tall > without + 0.01;
    }
    if (toast) status.classList.add('toast');
  }
  fitDismiss(status);
  fitFloating(status.closest('header'));
}

/**
 * In the side panel, what is left of the header floats in the bottom corner —
 * "Log an error", any AI chip, the status — over the page. The page keeps that
 * much room at its foot (`--float-h`, see `.embedded .tab`), so its last
 * controls can be scrolled clear of it: at 360px they ended under the chip.
 * Measured whenever the header is fitted or the status line changes.
 */
function fitFloating(header) {
  const root = document.documentElement;
  if (!header || !root.classList.contains('embedded')) {
    root.style.removeProperty('--float-h');
    return;
  }
  const top = header.getBoundingClientRect().top;
  root.style.setProperty('--float-h', `${Math.max(0, Math.ceil(window.innerHeight - top + 8))}px`);
}

/**
 * The ×, on an error floating in the corner. An error there never clears by
 * itself (it is the reason something did not happen), and on a phone it sat
 * over whatever was at the foot of the page — "+ Add skill group" at 390px —
 * with no way to put it away. While one is showing, the page keeps room for
 * it at the bottom (`status-toast` on the body, `--status-toast-h`), so the
 * last controls can be scrolled clear of it.
 *
 * Placed from the error's own box, so it is the same in the corner on a
 * desktop, on a phone, and in the side panel's floating header. Only the
 * body's class and the button's own style change: the header's observer
 * would re-fit for anything else, and so on for ever.
 */
function fitDismiss(status) {
  const root = document.documentElement;
  const body = document.body;
  const button = document.getElementById('status-dismiss');
  if (!body) return;
  let on = false;
  let box;
  if (status.classList.contains('err') && status.textContent) {
    const style = getComputedStyle(status);
    box = status.getBoundingClientRect();
    on = style.display !== 'none' && box.width > 0 &&
      (style.position === 'fixed' || root.classList.contains('embedded'));
  }
  body.classList.toggle('status-toast', on);
  if (!on) {
    root.style.removeProperty('--status-toast-h');
    return;
  }
  root.style.setProperty('--status-toast-h', `${Math.ceil(window.innerHeight - box.top + 8)}px`);
  if (button) {
    button.style.top = `${Math.round(box.top + 4)}px`;
    button.style.left = `${Math.round(box.right - 4 - 26)}px`;
  }
}

/*
 * Where the person was when an error appeared, to go back to when they put it
 * away. The × hides itself as it is pressed, and focus fell to <body>: a
 * keyboard or screen-reader user was sent back to the top of the page.
 */
let focusBefore = null;
let errorShowing = false;

function noteFocusBefore(status) {
  const showing = status.classList.contains('err') && Boolean(status.textContent);
  if (showing && !errorShowing) {
    const at = document.activeElement;
    focusBefore = at && at !== document.body && at.id !== 'status-dismiss' ? at : null;
  }
  errorShowing = showing;
}

/** Put the error away: what the × does. */
export function dismissStatus(status = document.getElementById('status')) {
  if (!status) return;
  const at = document.activeElement;
  // Only when the focus would be lost with the ×: not taken from where the person has gone since.
  const lost = !at || at === document.body || at.id === 'status-dismiss';
  const back = focusBefore;
  focusBefore = null;
  status.textContent = '';
  status.title = '';
  status.className = 'status';
  fitStatus(status);
  if (!lost) return;
  const usable = (el) => el && el.isConnected && !el.disabled && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0;
  const target = usable(back) ? back : document.getElementById('error-log-chip');
  target?.focus();
}

/** Lay the header out for the width it has now. */
export function fitHeader(header = document.querySelector('header')) {
  if (!header) return;
  const root = document.documentElement;
  const tabs = header.querySelector('#tabs');
  const chip = header.querySelector('#error-log-chip');
  const status = header.querySelector('#status');
  // The side panel floats what is left of the header in a corner: none of this.
  if (root.classList.contains('embedded')) {
    header.classList.remove('tabs-row', 'log-mark-only');
    root.style.removeProperty('--header-h');
    fitStatus(status);
    return;
  }

  // The tabs first: on the one row, with the button at its narrowest.
  header.classList.remove('tabs-row');
  header.classList.add('log-mark-only');
  if (tabs && tabs.scrollWidth > tabs.clientWidth + 1) header.classList.add('tabs-row');

  // Then the button's words, if the status line keeps its room beside them.
  if (chip) {
    const before = chip.getBoundingClientRect();
    header.classList.remove('log-mark-only');
    const tabsCut = !header.classList.contains('tabs-row') && tabs && tabs.scrollWidth > tabs.clientWidth + 1;
    // Nor where its words would push it onto a line of its own (a phone's),
    // nor anywhere off the first row: where the "!" alone has wrapped already
    // (both AI chips showing), the words had a row to themselves.
    const first = header.querySelector('h1')?.getBoundingClientRect();
    const top = chip.getBoundingClientRect().top;
    const wrapped = top >= before.bottom - 1 || (first !== undefined && first.height > 0 && top >= first.bottom - 1);
    if (tabsCut || wrapped || statusRoom(header, chip) < STATUS_ROOM) header.classList.add('log-mark-only');
  }

  fitStatus(status);
  root.style.setProperty('--header-h', `${header.offsetHeight}px`);
}

/**
 * Fit it now, and again whenever the window or what is in the header changes:
 * the save's name, a chip appearing, the fonts arriving. A change to the
 * status line's words only re-fits the status line; `setStatus` does that.
 */
export function setupHeader(header = document.querySelector('header')) {
  if (!header) return () => {};
  let queued = false;
  const refit = () => {
    if (queued) return;
    queued = true;
    // Before the next paint; a timer where there is none (jsdom without it).
    (window.requestAnimationFrame ?? ((fn) => setTimeout(fn, 16)))(() => {
      queued = false;
      fitHeader(header);
    });
  };
  fitHeader(header);
  window.addEventListener('resize', refit);
  const status = header.querySelector('#status');
  /*
   * And the status line again when what is in it changes after `setStatus`:
   * the error log's announcement puts a longer link in its place, and the ×
   * and the room kept at the foot of the page stayed fitted to the shorter
   * words. Only its words are watched; `fitStatus` changes its classes.
   */
  if (status) new MutationObserver(() => fitStatus(status)).observe(status, { childList: true, characterData: true, subtree: true });
  header.querySelector('#status-dismiss')?.addEventListener('click', () => dismissStatus(status));
  const watcher = new MutationObserver((changes) => {
    // Its own classes are this function's doing, and the status line's
    // words are `setStatus`'s.
    if (changes.some((c) => c.target !== header && !status?.contains(c.target))) refit();
  });
  watcher.observe(header, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  // `embedded` is set on the root by embed.js, after this.
  watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  document.fonts?.ready?.then(refit);
  return refit;
}
