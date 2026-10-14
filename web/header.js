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
 */
export function fitStatus(status) {
  if (!status) return;
  status.classList.remove('toast');
  if (!status.classList.contains('err') || !status.textContent) return;
  if (isFloating(status)) return; // a phone's, or the side panel's: already whole
  const cut = status.scrollHeight > status.clientHeight + 1 || status.scrollWidth > status.clientWidth + 1;
  if (cut || status.clientWidth < STATUS_MIN) status.classList.add('toast');
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
    // Nor where its words would push it onto a line of its own (a phone's).
    const wrapped = chip.getBoundingClientRect().top >= before.bottom - 1;
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
