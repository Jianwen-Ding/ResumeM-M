/**
 * The editor's half of the error log: what it notices, the dialog that logs
 * an entry, and the Error Log section under Save & Files.
 *
 * What it notices is kept in a buffer, as the server keeps its own (see
 * `src/errorlog/buffer.ts`, whose bounds these are): an error the page threw,
 * a promise nobody caught, a request to the server that failed — its route,
 * status and what the server said, never what was sent — and every red line
 * the status bar showed the person. An entry carries the ones from the
 * minutes before it; the server adds its own, scrubs the lot and writes them.
 *
 * Nothing here writes into the save. The error log is its own repository,
 * and logging works with no save open at all.
 */

/** As the server's: fifteen minutes or two thousand events, whichever is less. */
const KEEP_MS = 15 * 60 * 1000;
const KEEP_EVENTS = 2000;
/** What a dialog's screenshots may come to together, as the server allows. */
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOTS = 10;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const held = [];

/** Note something that went wrong in the editor. */
export function recordEditorEvent({ kind, level = 'error', message, detail }) {
  if (!message) return;
  held.push({
    at: new Date().toISOString(),
    source: 'editor',
    kind,
    level,
    message: String(message).slice(0, 2000),
    ...(detail ? { detail } : {}),
  });
  const oldest = Date.now() - KEEP_MS;
  let drop = 0;
  while (drop < held.length && Date.parse(held[drop].at) < oldest) drop++;
  drop = Math.max(drop, held.length - KEEP_EVENTS);
  if (drop > 0) held.splice(0, drop);
}

/** Everything from the last `minutes`, oldest first. */
export function editorEventsSince(minutes) {
  const from = Date.now() - minutes * 60 * 1000;
  return held.filter((e) => Date.parse(e.at) >= from);
}

/**
 * A request to the server that did not succeed. The route without its query
 * — where a code or a token would be — and what the server said about it.
 */
export function recordFailedRequest(method, path, status, said) {
  const route = String(path).split(/[?#]/)[0];
  recordEditorEvent({
    kind: 'api',
    level: !status || status >= 500 ? 'error' : 'warn',
    message: `${method} ${route} ${status ? `→ ${status}` : 'did not reach the server'}${said ? `: ${said}` : ''}`,
    detail: { method, route, status: status ?? null },
  });
}

let capturing = false;
/** The page's own errors, from the moment the editor loads. */
export function captureEditorErrors(target = window) {
  if (capturing) return;
  capturing = true;
  target.addEventListener('error', (event) => {
    const where = event.filename ? ` (${String(event.filename).split(/[?#]/)[0].split('/').pop()}:${event.lineno ?? 0})` : '';
    recordEditorEvent({ kind: 'page-error', message: `${event.message || 'An error with no message'}${where}` });
  });
  target.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    recordEditorEvent({ kind: 'unhandled-rejection', message: `Nobody caught: ${reason?.message ?? String(reason)}` });
  });
}

/** A file as a data URL. */
function asDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read.'));
    reader.readAsDataURL(file);
  });
}

/** How many bytes a base64 data URL holds, without decoding it. */
const bytesIn = (dataUrl) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/** Ctrl+Shift+E, or Cmd+Shift+E on a Mac. */
const isShortcut = (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'E' || e.key === 'e' || e.code === 'KeyE');

/**
 * Wire the header button, the shortcut, the dialog and the section.
 *
 * `context` says what the person had open — the resume, the application —
 * by id only. `showTab` and `setStatus` are the editor's own.
 */
export function setupErrorLog({ el, setChildren, setStatus, showTab, context = () => ({}) }) {
  const $ = (sel) => document.querySelector(sel);
  let dialog = null;
  let shots = [];
  let busy = false;

  async function request(path, options = {}) {
    let res;
    try {
      res = await fetch(`/api/error-log${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } });
    } catch {
      throw new Error('The ResumeM-M server did not answer. Start it again, then log this.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return body;
  }

  /* ---- The dialog ---- */

  function build() {
    const description = el('textarea', {
      id: 'error-log-description',
      rows: 3,
      placeholder: 'What went wrong, in a line or two',
      'aria-label': 'What went wrong',
    });
    const thumbs = el('div', { className: 'error-log-thumbs', 'aria-live': 'polite' });
    const picker = el('input', { type: 'file', accept: IMAGE_TYPES.join(','), multiple: true, hidden: true });
    const zone = el(
      'div',
      {
        className: 'error-log-paste dropzone',
        tabIndex: 0,
        role: 'button',
        'aria-label': 'Add screenshots: paste, drop, or choose a file',
      },
      [el('b', { textContent: 'Paste a screenshot (Ctrl+V), drop one here, or click to choose' }), el('span', { className: 'faint', textContent: 'PNG, JPEG or WebP · up to 8 MB together' })],
    );
    const minutes = el('select', { id: 'error-log-minutes', 'aria-label': 'Automatic logs from' }, [
      el('option', { value: '2', textContent: 'the last 2 minutes' }),
      el('option', { value: '10', textContent: 'the last 10 minutes', selected: true }),
      el('option', { value: '30', textContent: 'the last 30 minutes' }),
    ]);
    const note = el('p', { className: 'hint error-log-note', role: 'status' });
    const save = el('button', { className: 'primary', textContent: 'Save to error log', onclick: () => submit() });
    const cancel = el('button', { textContent: 'Cancel', onclick: () => close() });

    const body = el('div', { className: 'modal-body error-log-body', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'error-log-title' }, [
      el('h2', { id: 'error-log-title', textContent: 'Log an error' }),
      el('div', { className: 'modal-scroll' }, [
        el('label', { className: 'lbl', htmlFor: 'error-log-description', textContent: 'What went wrong' }),
        description,
        el('div', { className: 'lbl', textContent: 'Screenshots' }),
        zone,
        picker,
        thumbs,
        el('label', { className: 'row error-log-window' }, [el('span', { textContent: 'Include automatic logs from ' }), minutes]),
        el('p', {
          className: 'hint',
          textContent:
            'Saved to the error log — a git repository of its own, apart from your saves — with what the editor and the server noticed in that time. Contact details and tokens are taken out; nothing from your resumes or letters goes in.',
        }),
        note,
      ]),
      el('div', { className: 'modal-actions' }, [el('span', { className: 'hint', textContent: 'Ctrl+Enter saves' }), el('span', { className: 'grow' }), cancel, save]),
    ]);
    const overlay = el('div', { id: 'error-log-dialog', className: 'modal hidden' }, [body]);

    zone.onclick = () => picker.click();
    zone.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        picker.click();
      }
    };
    picker.onchange = () => {
      addFiles([...picker.files]);
      picker.value = '';
    };
    zone.ondragover = (e) => {
      e.preventDefault();
      zone.classList.add('over');
    };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      addFiles([...(e.dataTransfer?.files ?? [])]);
    };
    // Anywhere in the dialog: the description box has the focus when it opens.
    overlay.addEventListener('paste', (e) => {
      const items = [...(e.clipboardData?.items ?? [])].filter((item) => item.kind !== 'string' && /^image\//.test(item.type));
      const files = items.map((item) => item.getAsFile()).filter(Boolean);
      if (files.length === 0) return; // Text: the box takes it as usual.
      e.preventDefault();
      addFiles(files);
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        submit();
      } else if (e.key === 'Enter') {
        // A new line in the description, not the editor's own Enter-to-OK.
        e.stopPropagation();
      } else if (e.key === 'Tab') {
        // Kept inside the dialog while it is open, as the editor's own dialog keeps it.
        const focusable = [...overlay.querySelectorAll('textarea, select, button, [tabindex="0"]')].filter((n) => !n.disabled && !n.hidden);
        const at = focusable.indexOf(document.activeElement);
        const next = e.shiftKey ? focusable[at > 0 ? at - 1 : focusable.length - 1] : focusable[at >= 0 && at < focusable.length - 1 ? at + 1 : 0];
        if (next) {
          e.preventDefault();
          e.stopPropagation();
          next.focus();
        }
      }
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.body.append(overlay);
    return { overlay, description, thumbs, minutes, note, save };
  }

  function drawThumbs() {
    setChildren(
      dialog.thumbs,
      shots.map((shot, i) =>
        el('figure', { className: 'error-log-thumb' }, [
          el('img', { src: shot.dataUrl, alt: `Screenshot ${i + 1}` }),
          el('button', {
            className: 'tiny',
            textContent: 'Remove',
            'aria-label': `Remove screenshot ${i + 1}`,
            onclick: () => {
              shots.splice(i, 1);
              drawThumbs();
            },
          }),
        ]),
      ),
    );
  }

  async function addFiles(files) {
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        dialog.note.textContent = `${file.name || 'That file'} is not a PNG, JPEG or WebP image, so it was left out.`;
        continue;
      }
      if (shots.length >= MAX_SCREENSHOTS) {
        dialog.note.textContent = `${MAX_SCREENSHOTS} screenshots is the most one entry takes.`;
        break;
      }
      let dataUrl;
      try {
        dataUrl = await asDataUrl(file);
      } catch (err) {
        dialog.note.textContent = err.message;
        continue;
      }
      const total = shots.reduce((n, s) => n + bytesIn(s.dataUrl), 0) + bytesIn(dataUrl);
      if (total > MAX_SCREENSHOT_BYTES) {
        dialog.note.textContent = 'That one would take the screenshots past 8 MB together, so it was left out.';
        continue;
      }
      shots.push({ dataUrl });
      dialog.note.textContent = '';
      drawThumbs();
    }
  }

  function open() {
    dialog ??= build();
    if (!dialog.overlay.classList.contains('hidden')) {
      dialog.description.focus();
      return;
    }
    dialog.overlay.classList.remove('hidden');
    dialog.note.textContent = '';
    dialog.note.className = 'hint error-log-note';
    dialog.description.focus();
  }

  function close() {
    if (!dialog || busy) return;
    dialog.overlay.classList.add('hidden');
    $('#error-log-chip')?.focus();
  }

  async function submit() {
    if (busy) return;
    const description = dialog.description.value.trim();
    if (!description) {
      dialog.note.textContent = 'Say in a few words what went wrong first.';
      dialog.note.className = 'hint error-log-note warn';
      dialog.description.focus();
      return;
    }
    const minutes = Number(dialog.minutes.value) || 10;
    busy = true;
    dialog.save.disabled = true;
    dialog.note.className = 'hint error-log-note';
    dialog.note.textContent = 'Saving…';
    let result;
    try {
      const { resumeId = null, applicationId = null } = context() ?? {};
      result = await request('', {
        method: 'POST',
        body: JSON.stringify({
          description,
          minutes,
          source: 'editor',
          screenshots: shots.map((s) => s.dataUrl),
          events: editorEventsSince(minutes),
          resumeId,
          applicationId,
        }),
      });
    } catch (err) {
      dialog.note.textContent = `Not logged: ${err.message}`;
      dialog.note.className = 'hint error-log-note warn';
      return;
    } finally {
      busy = false;
      dialog.save.disabled = false;
    }
    dialog.description.value = '';
    shots = [];
    drawThumbs();
    close();
    announce(result.message ?? 'Logged to the error log (not pushed yet).', !result.committed);
    loadPanel().catch(() => undefined);
  }

  /**
   * The status line, as a way to the Error Log section. The whole line is the
   * link: the header cuts a long status short, and a link at its end was the
   * part cut off.
   */
  function announce(text, isError = false) {
    setStatus(text, isError);
    const status = $('#status');
    if (!status) return;
    setChildren(
      status,
      el('a', {
        href: '#save',
        className: 'error-log-link',
        textContent: `${text} · Open the error log`,
        onclick: (e) => {
          e.preventDefault();
          showSection();
        },
      }),
    );
    status.title = `${text} Open the error log under Save & Files.`;
    // `setStatus` clears a plain line by its text, which this has changed; cleared here instead.
    if (!isError) {
      const shown = status.textContent;
      setTimeout(() => {
        if (status.textContent === shown) status.textContent = status.title = '';
      }, 8000);
    }
  }

  function showSection() {
    showTab('save');
    loadPanel().catch(() => undefined);
    $('#error-log')?.scrollIntoView?.({ block: 'start' });
  }

  /* ---- The section under Save & Files ---- */

  function describeRemote(status) {
    const remote = status.remote;
    if (!remote?.url) return 'Local only. Nothing leaves this machine.';
    const last = status.lastPush ? ` Last pushed ${new Date(status.lastPush).toLocaleString()}.` : '';
    if (!remote.tracked) return `${remote.url} — never pushed.${last}`;
    const parts = [];
    if (remote.ahead) parts.push(`${remote.ahead} commit${remote.ahead === 1 ? '' : 's'} to push`);
    if (remote.behind) parts.push(`${remote.behind} to pull`);
    return `${remote.url} — ${parts.length ? parts.join(', ') : 'in step'}, as of the last push or pull.${last}`;
  }

  async function loadPanel() {
    const box = $('#error-log-panel');
    if (!box) return;
    let status;
    let listed;
    try {
      [status, listed] = await Promise.all([request('/status'), request('?limit=10')]);
    } catch (err) {
      setChildren(box, el('div', { className: 'result bad', textContent: `The error log could not be read: ${err.message}` }));
      return;
    }
    const remote = el('input', { type: 'text', value: status.remote?.url ?? '', placeholder: 'git@github.com:you/resumem-m-errors.git', 'aria-label': 'Error log remote' });
    const result = el('div', { className: 'result idle', textContent: describeRemote(status) });
    const setResult = (text, kind = 'idle') => {
      result.className = `result ${kind}`;
      result.textContent = text;
    };
    const push = el('button', {
      className: 'primary',
      textContent: 'Push',
      disabled: !status.remote?.url,
      onclick: async () => {
        setResult('Pushing…');
        try {
          const res = await request('/push', { method: 'POST' });
          setResult(res.ok ? `${res.output}\n${describeRemote(res.status)}` : res.output, res.ok ? 'ok' : 'bad');
          if (res.ok) drawEntries(await request('?limit=10').catch(() => listed));
        } catch (err) {
          setResult(err.message, 'bad');
        }
      },
    });
    const pull = el('button', {
      textContent: 'Pull',
      title: 'Bring in entries pushed from another machine',
      disabled: !status.remote?.url,
      onclick: async () => {
        setResult('Pulling…');
        try {
          const res = await request('/pull', { method: 'POST' });
          setResult(res.message, res.ok ? 'ok' : 'bad');
          drawEntries(await request('?limit=10').catch(() => listed));
        } catch (err) {
          setResult(err.message, 'bad');
        }
      },
    });
    const entries = el('div', { className: 'error-log-entries' });
    const drawEntries = (list) => {
      const items = list?.entries ?? [];
      setChildren(
        entries,
        items.length === 0
          ? el('p', { className: 'hint', textContent: 'Nothing logged yet.' })
          : el(
              'ul',
              { className: 'error-log-list' },
              items.map((entry) =>
                el('li', { title: entry.id }, [
                  el('span', { className: 'error-log-when', textContent: new Date(entry.at).toLocaleString() }),
                  el('span', { className: 'error-log-source', textContent: entry.source }),
                  el('span', { className: 'error-log-what', textContent: entry.description }),
                  el('span', {
                    className: 'hint',
                    textContent: [
                      entry.screenshots ? `${entry.screenshots} screenshot${entry.screenshots === 1 ? '' : 's'}` : '',
                      entry.pushed ? 'pushed' : 'not pushed',
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }),
                ]),
              ),
            ),
      );
    };
    drawEntries(listed);

    setChildren(
      box,
      el('div', {
        className: 'mono-path',
        textContent: status.isRepo ? status.dir : `${status.dir} (made the first time something is logged)`,
      }),
      el('p', { className: 'hint', textContent: `${status.entries} ${status.entries === 1 ? 'entry' : 'entries'}. A git repository of its own — not part of any save.` }),
      status.lastCommitError
        ? el('div', { className: 'result bad', textContent: `The last entry was written but not committed: ${status.lastCommitError.message}` })
        : null,
      el('div', { className: 'row' }, [
        el('button', { textContent: 'Log an error', title: 'Ctrl+Shift+E', onclick: () => open() }),
        el('button', { className: 'tiny', textContent: 'Refresh', onclick: () => loadPanel().catch(() => undefined) }),
      ]),
      el('label', { className: 'f' }, [el('div', { className: 'lbl', textContent: 'Remote (Optional)' }), remote]),
      el('div', { className: 'row' }, [
        el('button', {
          textContent: 'Save Remote',
          onclick: async () => {
            try {
              const next = await request('/remote', { method: 'PUT', body: JSON.stringify({ url: remote.value.trim() }) });
              setResult(next.remote?.url ? describeRemote(next) : 'Remote removed. The error log is local only.', 'ok');
              push.disabled = pull.disabled = !next.remote?.url;
            } catch (err) {
              setResult(err.message, 'bad');
            }
          },
        }),
        pull,
        push,
      ]),
      result,
      el('div', { className: 'lbl', textContent: 'Recent entries' }),
      entries,
    );
  }

  /* ---- Wiring ---- */

  const chip = $('#error-log-chip');
  if (chip) chip.onclick = () => open();
  document.addEventListener('keydown', (e) => {
    if (!isShortcut(e)) return;
    e.preventDefault();
    open();
  });
  const saveTab = document.querySelector('#tabs button[data-tab="save"]');
  saveTab?.addEventListener('click', () => loadPanel().catch(() => undefined));

  return { open, close, loadPanel, showSection };
}
