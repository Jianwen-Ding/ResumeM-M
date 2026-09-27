/**
 * The editor inside the browser extension's side panel.
 *
 * The panel is an extension page with this editor in a frame, and it has to
 * be able to do three things the address bar alone cannot:
 *
 *  - Move to another resume when the tab beside it changes, and know whether
 *    the move happened. `#resumes/<id>` already moves, through `leaveResume`,
 *    which writes a pending edit first and refuses to move when it cannot —
 *    and a refusal puts the address back, which a frame's parent cannot see.
 *  - Have what is pending written before it points the frame somewhere else
 *    altogether (another server), which no hash change covers.
 *  - Say what is on screen: which resume, and whether it has saved.
 *
 * So a small message protocol, and only with the page that framed us, and
 * only when that page is an extension's. The server refuses to be framed by
 * anything else (`frame-ancestors`), and this checks again rather than
 * trusting that: a message from any other window, or from a parent that is
 * not an extension, is ignored, and nothing is ever posted to one.
 *
 * Messages in:  { rmm: 'open', id, seq } · { rmm: 'flush', seq } ·
 *               { rmm: 'view', view?, focus? } · { rmm: 'refresh' } ·
 *               { rmm: 'hello' }
 * Messages out: { rmm: 'state', … } whenever what is on screen changes,
 *               { rmm: 'opened', seq, ok, reason, id } and { rmm: 'flushed', seq, ok }.
 */

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/** The extension page this editor is framed by, or null. */
export function embeddingOrigin(win = window) {
  if (!win.parent || win.parent === win) return null;
  const ancestor = win.location?.ancestorOrigins?.[0] ?? (() => {
    try {
      return win.document?.referrer ? new URL(win.document.referrer).origin : null;
    } catch {
      return null;
    }
  })();
  return ancestor && EXTENSION_ORIGIN.test(ancestor) ? ancestor : null;
}

export function setupEmbed({ win = window, getState, open, flush, refresh = async () => {}, compact } = {}) {
  const origin = embeddingOrigin(win);
  if (!origin) return { embedded: false, announce() {} };

  win.document.documentElement.classList.add('embedded');

  const post = (message) => {
    try {
      win.parent.postMessage(message, origin);
    } catch {
      // The panel went away mid-send; there is nobody left to tell.
    }
  };

  let last = '';
  let queued = false;
  /** Say what is on screen, once per change and once per batch of them. */
  const announce = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const now = { rmm: 'state', ...getState() };
      const said = JSON.stringify(now);
      if (said === last) return;
      last = said;
      post(now);
    });
  };

  win.addEventListener('message', async (ev) => {
    if (ev.source !== win.parent || ev.origin !== origin) return;
    const message = ev.data;
    if (!message || typeof message !== 'object' || typeof message.rmm !== 'string') return;
    if (message.rmm === 'open' && typeof message.id === 'string') {
      // 'moved', or why not: 'missing' (not in the save) or 'unsaved' (the
      // edit on screen has not landed, so the editor stays where it is).
      let result;
      try {
        result = await open(message.id);
      } catch {
        result = 'failed';
      }
      const ok = result === true || result === 'moved';
      post({ rmm: 'opened', seq: message.seq, ok, reason: ok ? null : String(result || 'failed'), id: getState().resumeId });
      announce();
    } else if (message.rmm === 'flush') {
      let ok = false;
      try {
        ok = await flush();
      } catch {
        ok = false;
      }
      post({ rmm: 'flushed', seq: message.seq, ok: Boolean(ok) });
    } else if (message.rmm === 'view') {
      if (typeof message.view === 'string') compact?.setView(message.view);
      if (typeof message.focus === 'boolean') compact?.setFocus(message.focus);
      announce();
    } else if (message.rmm === 'refresh') {
      // Something else wrote to the save — the card building its copy, a
      // resume deleted in another tab. Taken only when nothing here is
      // unsaved; see `refreshOnReturn`.
      await refresh().catch(() => undefined);
      announce();
    } else if (message.rmm === 'hello') {
      // The panel asking again, after it was reloaded with this frame kept.
      last = '';
      announce();
    }
  });

  announce();
  return { embedded: true, origin, announce };
}
