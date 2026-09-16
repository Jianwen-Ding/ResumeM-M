/**
 * The editor GUI. Deliberately dependency-free: it is a local tool whose value
 * is in the store and the renderer, and a build step for the front end would be
 * one more thing to keep working.
 *
 * The idea on screen: you are never editing a document, you are picking among
 * phrasings that already exist — and adding to them should be one click from
 * wherever you noticed the gap.
 */

import { createPreview } from './preview.js';
import { setupAssets } from './assets.js';
import { renderFeedbackMarkdown } from './feedback.js';
let activeProject;
let assetUI;
const inlineSaves = new Set();

const $ = (sel) => document.querySelector(sel);

/**
 * Replace a node's children, dropping nulls. `replaceChildren(null)` renders
 * the literal text "null", which is exactly the sort of thing that reaches a
 * screenshot.
 */
const setChildren = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

/** Build an element. `children` may contain strings, nodes, or null. */
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) if (c != null && c !== false) node.append(c);
  return node;
};

const state = {
  store: null,
  resumeId: null,
  masterView: false,
  /** Unsaved variant selections, layered over the resume's own. */
  choices: {},
  /** Unsaved skill-item selections, keyed by group id. */
  skillEdits: null,
  /** Unsaved entry inclusion, keyed by section kind. */
  entryEdits: null,
  /** Unsaved bullet inclusion, keyed by entry id. */
  bulletEdits: null,
  /** Unsaved list-item selections on list bullets, keyed by bullet id. */
  listEdits: null,
  dirty: false,
  /**
   * The application that sent you to the builder, if one did.
   *
   * Kept so the way back names the posting rather than dropping you at the
   * Workspace to find it again. `fromDraftId` comes out of the hash and so
   * survives a reload; `fromDraft` is what it resolved to, for the label.
   */
  fromDraftId: null,
  fromDraft: null,
};

/** Forget every unsaved edit — used when switching resumes. */
function clearEdits() {
  state.choices = {};
  state.skillEdits = null;
  state.entryEdits = null;
  state.bulletEdits = null;
  state.listEdits = null;
  state.dirty = false;
}

/* ------------------------------------------------------------------ *
 * Plumbing                                                            *
 * ------------------------------------------------------------------ */

let statusTimer;
function setStatus(text, isError = false) {
  const s = $('#status');
  s.textContent = text;
  s.className = isError ? 'status err' : 'status';
  clearTimeout(statusTimer);
  if (text && !isError) {
    statusTimer = setTimeout(() => {
      if (s.textContent === text) s.textContent = '';
    }, 3500);
  }
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(activeProject ? { 'X-RMM-Project': activeProject } : {}), ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** "1 change" / "3 changes" — the `(s)` suffix reads like a form letter. */
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Render the store's inline markup as real nodes. Raw `**asterisks**` on screen
 * were the single most obviously wrong thing about the first version.
 */
function markup(text) {
  const frag = document.createDocumentFragment();
  const re = /\*\*(.+?)\*\*|`(.+?)`|(?:^|(?<=[\s(]))\*([^*]+)\*(?=[\s).,;:]|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] !== undefined) frag.append(el('strong', { textContent: m[1] }));
    else if (m[2] !== undefined) frag.append(el('span', { className: 'mono', textContent: m[2] }));
    else frag.append(el('em', { textContent: m[3] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/**
 * Display text for stored source. The store holds LaTeX-flavoured text — `--`
 * for an en dash, `**bold**` — which is right for the renderer and looks like a
 * typo everywhere else.
 */
function display(text) {
  return String(text ?? '')
    .replace(/\s--\s/g, ' \u2013 ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[`*]/g, '')
    .trim();
}

/**
 * What one option in a phrasing dropdown reads as: the wording that will be
 * printed, with the store's markup stripped, truncated only when it would
 * otherwise blow out the control.
 */
function optionText(variant) {
  const text = display(variant.text);
  const shown = text.length > 110 ? `${text.slice(0, 110).trimEnd()}…` : text;
  return variant.suggested ? `${shown}  · unreviewed` : shown;
}

/** Turn a label into a usable id fragment. */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

/* ------------------------------------------------------------------ *
 * Spec helpers                                                        *
 * ------------------------------------------------------------------ */

function resumeById(id) {
  return state.store.resumes.find((r) => r.id === id);
}

/** The `extends` chain, root first. */
function chain(id) {
  const out = [];
  let spec = resumeById(id);
  const seen = new Set();
  while (spec && !seen.has(spec.id)) {
    seen.add(spec.id);
    out.unshift(spec);
    spec = spec.extends ? resumeById(spec.extends) : null;
  }
  return out;
}

/** Choices as they resolve today, including unsaved edits. */
function effectiveChoices() {
  return Object.assign({}, ...chain(state.resumeId).map((s) => s.choices ?? {}), state.choices);
}

/** Flattened section list through the chain, child replacing parent by kind. */
function resolveSections(id = state.resumeId) {
  let sections = [];
  for (const spec of chain(id)) {
    if (!spec.sections?.length) continue;
    const next = sections.map((base) => spec.sections.find((o) => o.kind === base.kind) ?? base);
    for (const o of spec.sections) if (!next.some((x) => x.kind === o.kind)) next.push(o);
    sections = next;
  }
  return sections;
}

/** Which items a list bullet shows right now, including unsaved edits. */
function listSelection(bullet) {
  const saved = Object.assign({}, ...chain(state.resumeId).map((s) => s.lists ?? {}));
  return state.listEdits?.[bullet.id] ?? saved[bullet.id] ?? bullet.items.map((i) => i.id);
}

/** Which entries a section shows right now, including unsaved edits. */
function entrySelection(section) {
  return state.entryEdits?.[section.kind] ?? section.entries ?? [];
}

/** Which bullets an entry shows right now, including unsaved edits. */
function bulletSelection(section, entry) {
  return (
    state.bulletEdits?.[entry.id] ??
    section.bullets?.[entry.id] ??
    (entry.bullets ?? []).filter((b) => !b.archived).map((b) => b.id)
  );
}

/**
 * The spec to compile: the selected resume plus everything unsaved. Inclusion
 * edits live on the sections, variant choices on `choices`, and list-item
 * selections on `lists`.
 */
function currentSpec() {
  const base = resumeById(state.resumeId);
  const spec = {
    ...base,
    choices: { ...(base.choices ?? {}), ...state.choices },
    lists: { ...(base.lists ?? {}), ...(state.listEdits ?? {}) },
  };

  const touchesSections = state.skillEdits || state.entryEdits || state.bulletEdits;
  if (touchesSections) {
    spec.sections = resolveSections().map((section) => {
      if (section.kind === 'skills') {
        return state.skillEdits
          ? { ...section, items: { ...(section.items ?? {}), ...state.skillEdits } }
          : section;
      }
      const entries = entrySelection(section);
      const bullets = { ...(section.bullets ?? {}) };
      for (const eid of entries) {
        const entry = state.store.entries.find((e) => e.id === eid);
        if (entry && state.bulletEdits?.[eid]) bullets[eid] = state.bulletEdits[eid];
      }
      return { ...section, entries, bullets };
    });
  }
  return spec;
}

function isVariantField(f) {
  return f && typeof f === 'object' && Array.isArray(f.variants);
}

/** The choice key for the name on the page. Mirrors PROFILE_NAME_KEY on the server. */
const PROFILE_NAME_KEY = 'profile.name';

function fieldText(field, choices, key) {
  if (field == null) return '';
  if (!isVariantField(field)) return String(field);
  const id = choices[key] ?? field.default;
  return String((field.variants.find((v) => v.id === id) ?? field.variants[0])?.text ?? '');
}

/** An entry's name as a person would say it, for dialog titles. */
function entryName(entry) {
  const title = fieldText(entry.title, effectiveChoices(), `${entry.id}.title`);
  return title || entry.id;
}

/**
 * A bullet named by its own opening words. Ids are how the store refers to
 * things; they are not what belongs in a dialog title asking you to confirm a
 * deletion.
 */
function bulletName(entry, bullet) {
  const chosen = bullet.variants.find((v) => v.id === bullet.default) ?? bullet.variants[0];
  const text = String(chosen?.text ?? '').replace(/[*`]/g, '').trim();
  if (!text) return bullet.id;
  return text.length > 44 ? `${text.slice(0, 44).trimEnd()}…` : text;
}

/**
 * Record an unsaved change — and start recompiling it.
 *
 * Every edit path in the editor goes through here, which is what makes the
 * preview live: there is no way to change something and be left looking at a
 * stale page, and nothing to press to catch up.
 */
function markDirty(message = 'Changed') {
  state.dirty = true;
  if (message !== 'Changed') setStatus(message);
  scheduleRender();
  scheduleAutoSave();
}

/* ---- Auto-save ------------------------------------------------------ *
 * Edits used to live in memory until you explicitly saved, which meant
 * switching resumes or closing the tab threw them away — and the thing you
 * lose that way is always the ten minutes of small decisions you have just
 * finished making.
 *
 * Saving and committing are deliberately separated. The file is written
 * almost immediately, so nothing is ever at risk; the commit waits for the
 * editing to stop, so the version history stays a list of decisions rather
 * than one entry per keystroke.
 * -------------------------------------------------------------------- */

const AUTOSAVE_DELAY_MS = 900;
const COMMIT_IDLE_MS = 15_000;

let autoSaveTimer = null;
let commitTimer = null;
let autoSaving = null;

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  setSaveState('unsaved');
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    autoSave();
  }, AUTOSAVE_DELAY_MS);
}

/** Write the current selection to the store, without making a commit. */
async function autoSave() {
  if (!state.dirty || !state.resumeId) return;
  const spec = currentSpec();
  state.dirty = false; // further edits re-dirty it; this one is in flight
  setSaveState('saving');

  autoSaving = (async () => {
    try {
      await api(`/resumes/${encodeURIComponent(spec.id)}?commit=0`, {
        method: 'PUT',
        body: JSON.stringify(spec),
      });
      // The store now holds what the editor shows, so the unsaved edits are
      // no longer overlays on top of it.
      const stored = state.store?.resumes?.find((r) => r.id === spec.id);
      if (stored) Object.assign(stored, spec);
      setSaveState('saved');
      scheduleCommit();
    } catch (err) {
      state.dirty = true; // it did not land; try again on the next edit
      setSaveState('failed', err.message);
    } finally {
      autoSaving = null;
    }
  })();
  return autoSaving;
}

/** Commit once the editing stops, so one sitting is one version. */
function scheduleCommit() {
  if (!state.store?.config?.git?.autoCommit) return; // the user turned it off
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    api('/store/save', { method: 'POST', body: JSON.stringify({}) }).catch(() => {
      /* the work is on disk either way; the next save will pick it up */
    });
  }, COMMIT_IDLE_MS);
}

/**
 * Write and commit right now — before switching resumes, or on the way out of
 * the page. `keepalive` is what lets the last write survive the tab closing.
 */
async function flushEdits() {
  await Promise.all([...inlineSaves]);
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  if (state.dirty) await autoSave();
  await autoSaving;
  clearTimeout(commitTimer);
  commitTimer = null;
  if (state.store?.config?.git?.autoCommit) {
    await api('/store/save', { method: 'POST', body: JSON.stringify({}), keepalive: true }).catch(() => {});
  }
}

/** Docs says "All changes saved"; so does this, in the same quiet way. */
function setSaveState(mode, detail) {
  const chip = $('#save-state');
  if (!chip) return;
  chip.className = `save ${mode}`;
  chip.textContent =
    mode === 'saving'
      ? 'Saving…'
      : mode === 'saved'
        ? 'All changes saved'
        : mode === 'failed'
          ? `Not saved — ${detail ?? 'the server did not accept it'}`
          : 'Unsaved changes';
}

/* ------------------------------------------------------------------ *
 * Store mutations                                                     *
 * ------------------------------------------------------------------ */

async function saveEntry(entry, message) {
  await api(`/entries/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: JSON.stringify(entry) });
  setStatus(message ?? `Saved ${entry.id}`);
  await loadStore();
  render();
}

async function saveResumeSpec(spec, message) {
  await api(`/resumes/${encodeURIComponent(spec.id)}`, { method: 'PUT', body: JSON.stringify(spec) });
  setStatus(message ?? `Saved ${spec.id}`);
  await loadStore();
}

/* ------------------------------------------------------------------ *
 * Build tab: the editor                                               *
 * ------------------------------------------------------------------ */

const SECTION_LABELS = {
  education: 'Education',
  experience: 'Experience',
  project: 'Projects',
  skills: 'Technical skills',
  custom: 'Additional',
};

const FIELD_LABELS = {
  title: 'Title',
  dates: 'Dates',
  subtitle: 'Role / degree / stack',
  location: 'Location',
};

let activeSourceTools = null;

/** Keep one field or bullet's secondary actions open without rebuilding its editor. */
function revealSourceTools(key) {
  activeSourceTools = key;
  for (const block of $('#editor').querySelectorAll('.bullet-disclosure')) {
    const open = block.dataset.toolsKey === key;
    block.classList.toggle('tools-open', open);
    for (const action of block.querySelectorAll('[data-bullet-action]')) action.hidden = !open;
    const button = block.querySelector('.bullet-more');
    const kind = block.dataset.toolsKind;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? `Hide ${kind} actions` : `Show ${kind} actions`);
    button.title = open ? 'Hide actions (Escape)' : `Show actions — or double-click this ${kind}`;
    button.textContent = open ? '×' : '…';
  }
}

function attachSourceTools(block, key, actions, anchor, kind = 'bullet') {
  block.classList.add('bullet-disclosure');
  block.dataset.toolsKind = kind;
  block.dataset.toolsKey = `${state.masterView ? 'master' : state.resumeId}:${key}`;
  for (const action of actions.filter(Boolean)) {
    action.dataset.bulletAction = '';
    action.hidden = block.dataset.toolsKey !== activeSourceTools;
  }
  const button = el('button', {
    className: 'bullet-more tiny',
    textContent: block.dataset.toolsKey === activeSourceTools ? '×' : '…',
    title: block.dataset.toolsKey === activeSourceTools ? 'Hide actions (Escape)' : `Show actions — or double-click this ${kind}`,
    onclick: () => revealSourceTools(activeSourceTools === block.dataset.toolsKey ? null : block.dataset.toolsKey),
  });
  button.setAttribute('aria-label', block.dataset.toolsKey === activeSourceTools ? `Hide ${kind} actions` : `Show ${kind} actions`);
  button.setAttribute('aria-expanded', String(block.dataset.toolsKey === activeSourceTools));
  block.classList.toggle('tools-open', block.dataset.toolsKey === activeSourceTools);
  anchor.append(button);
  block.addEventListener('dblclick', event => {
    if (event.target.closest('button, input, select, label')) return;
    revealSourceTools(block.dataset.toolsKey);
  });
  block.addEventListener('keydown', event => {
    if (event.key === 'Escape' && activeSourceTools === block.dataset.toolsKey) {
      revealSourceTools(null);
      button.focus();
      event.stopPropagation();
    }
  });
  for (const line of block.querySelectorAll('.editable')) line.title = `Double-click to edit and show ${kind} actions. Shared wording updates every resume using it.`;
  return block;
}

/**
 * The dropdown that picks a phrasing, plus the affordances for adding to and
 * editing the set it is picking from.
 */
/**
 * The row under a line: what else it could say, and what you can do to it.
 *
 * The chosen wording is not repeated here — it is the line itself, editable in
 * place, with a stepper beside it. Showing the same sentence twice was how
 * this read before, and it made the page twice as long for no extra
 * information. Stepping covers two or three alternates; past that, "choose"
 * lists them all at once.
 */
function variantPicker({ key, field, current, onAdd, onEdit, addLabel = '+ alternate', extraActions = [], trailingActions = [] }) {
  const choose =
    field.variants.length > 3
      ? el('button', {
          className: 'tiny',
          textContent: 'Choose…',
          title: 'Pick from all the ways this can be said',
          onclick: () => chooseVariant(key, field, current),
        })
      : null;

  // Order matters: status chips, then the two things you do most (edit the
  // wording, add another), then the incidental actions.
  const actions = el('div', { className: 'actions' });
  for (const a of extraActions) actions.append(a);
  if (field.variants.length > 1) actions.append(pinControl(key, field, current));
  if (choose) actions.append(choose);
  if (onEdit) {
    actions.append(
      el('button', {
        className: 'tiny',
        textContent: 'Details',
        title: 'Label, tags, and a note to yourself — the text itself is editable on the line above',
        onclick: onEdit,
      }),
    );
  }
  if (onAdd) {
    actions.append(
      el('button', {
        className: 'link',
        textContent: addLabel,
        title: 'Add another way of saying this — available to every resume',
        onclick: onAdd,
      }),
    );
  }
  for (const a of trailingActions) actions.append(a);

  return el('div', { className: 'variant-row' }, [el('span', { className: 'grow' }), actions]);
}

/**
 * Pin this wording as the one used wherever nothing else is chosen.
 *
 * Choosing a wording on one resume says "here"; pinning says "unless told
 * otherwise, everywhere". The difference is worth a control of its own —
 * without it, deciding a phrasing is simply the better one meant editing YAML.
 */
function pinControl(key, field, current) {
  const isDefault = current === field.default;
  if (isDefault) {
    return el('span', {
      className: 'chip pinned',
      textContent: 'Default',
      title: 'Used by every resume that does not choose otherwise',
    });
  }
  return el('button', {
    className: 'tiny',
    textContent: 'Make default',
    title: 'Use this wording wherever a resume does not choose otherwise',
    onclick: () => pinDefault(key, current),
  });
}

async function pinDefault(key, variantId) {
  try {
    await api(`/defaults/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ variantId }),
    });
    await loadStore();
    setStatus('Pinned as the default everywhere');
    render();
  } catch (err) {
    setStatus(err.message, true);
  }
}

/** Pick from every wording at once, for fields with more than a few. */
async function chooseVariant(key, field, current) {
  const answer = await form(
    'Choose a wording',
    [
      {
        name: 'id',
        label: 'Wordings',
        type: 'select',
        value: current,
        options: field.variants.map((v) => ({ value: v.id, label: optionText(v) })),
      },
    ],
    'Only this resume changes; the wordings themselves stay as they are.',
  );
  if (!answer?.id || answer.id === current) return;
  state.choices[key] = answer.id;
  markDirty();
  render();
}

/**
 * A line you can edit where it sits.
 *
 * Double-click to edit, Enter or click away to keep it, Escape to put it back.
 * Editing the wording is the most common thing anyone does here, and routing it
 * through a dialog made the quickest action the most ceremonious one.
 *
 * The text belongs to the store, not to this resume: editing it here changes it
 * everywhere it appears, which is the whole point of keeping one copy.
 */
function editableLine(text, { onCommit, className = 'text', title } = {}) {
  const node = el('div', {
    // `editable` is what carries the affordance in CSS: a line that merely
    // looks like this one — a list bullet's preview, say — must not invite a
    // double-click that does nothing.
    className: `${className} editable`,
    title: title ?? 'Double-click to edit. This wording is shared by every resume using it.',
  });
  node.append(markup(display(text)));

  let editing = false;
  const stop = (commit) => {
    if (!editing) return;
    editing = false;
    node.contentEditable = 'false';
    node.classList.remove('editing');
    const next = node.textContent.trim();
    if (commit && next && next !== display(text)) {
      const save = Promise.resolve().then(() => onCommit(next));
      inlineSaves.add(save);
      save.catch(err => setStatus(err.message, true)).finally(() => inlineSaves.delete(save));
    } else {
      // Put the markup back: the raw text is what gets edited, the rendered
      // form is what gets shown.
      node.replaceChildren(markup(display(text)));
    }
  };

  node.ondblclick = () => {
    if (editing) return;
    editing = true;
    node.contentEditable = 'plaintext-only';
    node.classList.add('editing');
    node.textContent = display(text); // edit the sentence, not the markup
    node.focus();
    // Put the caret where the pointer was, rather than at the start.
    const sel = window.getSelection();
    if (sel && sel.rangeCount === 0) node.textContent = node.textContent;
  };
  node.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stop(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stop(false);
    }
  };
  node.onblur = () => stop(true);
  return node;
}

/** Review the complete entry through the same background feedback panel. */
function entryFeedbackButton(entry) {
  return el('button', {
    className: 'tiny entry-feedback',
    textContent: 'AI Feedback',
    title: 'Review this entire entry: heading, bullets, and alternate phrasings',
    onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await askSourceFeedback({ entryId: entry.id }); }
      finally { button.disabled = false; }
    },
  });
}

/** A keyboard-accessible, one-click critique beside the exact wording. */
function phraseFeedbackButton(entry, target) {
  return el('button', {
    className: 'tiny phrase-feedback',
    textContent: 'AI Feedback',
    title: 'Get AI feedback on this exact phrasing',
    onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await askSourceFeedback({ entryId: entry.id, ...target }); }
      finally { button.disabled = false; }
    },
  });
}

/**
 * Step through the alternates from beside the line, without opening the list.
 * Most fields have two or three; clicking through them is faster than reading
 * a dropdown, and you see each one typeset in the preview as you go.
 */
function alternateStepper(key, field, currentId) {
  const ids = field.variants.map((v) => v.id);
  const at = Math.max(0, ids.indexOf(currentId));
  if (ids.length < 2) return null;

  const go = (delta) => {
    state.choices[key] = ids[(at + delta + ids.length) % ids.length];
    markDirty();
    render();
  };

  return el('div', { className: 'stepper', title: 'Other ways to say this' }, [
    el('button', { className: 'step', textContent: '‹', title: 'Previous wording', onclick: () => go(-1) }),
    el('span', { className: 'count', textContent: `${at + 1}/${ids.length}` }),
    el('button', { className: 'step', textContent: '›', title: 'Next wording', onclick: () => go(1) }),
  ]);
}

/** A checkbox that includes or excludes something from this variation. */
function toggle({ on, title, onChange }) {
  const cb = el('input', { type: 'checkbox', checked: on, title });
  cb.onchange = () => {
    onChange(cb.checked);
    markDirty();
    render();
  };
  return el('label', { className: 'toggle', title }, [cb]);
}

/** The courses/awards inside a list bullet, picked the way skills are. */
function listItems(entry, bullet) {
  const picked = listSelection(bullet);
  const wrap = el('div', { className: 'chip-set' });

  for (const item of bullet.items) {
    const on = picked.includes(item.id);
    const chip = el('label', { className: `chip-toggle${on ? ' on' : ''}` });
    const cb = el('input', { type: 'checkbox', checked: on });
    cb.onchange = () => {
      // Preserve store order, so the printed list does not reshuffle as you
      // click around.
      const next = new Set(picked);
      if (cb.checked) next.add(item.id);
      else next.delete(item.id);
      state.listEdits = {
        ...(state.listEdits ?? {}),
        [bullet.id]: bullet.items.filter((i) => next.has(i.id)).map((i) => i.id),
      };
      markDirty();
      render();
    };
    chip.append(cb, item.text);
    chip.append(
      el('span', {
        className: 'x',
        textContent: '×',
        title: 'Delete this item from the save',
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          removeListItem(entry, bullet, item);
        },
      }),
    );
    wrap.append(chip);
  }

  wrap.append(
    el('button', {
      className: 'link',
      textContent: '+ item',
      onclick: () => addListItem(entry, bullet),
    }),
  );
  return wrap;
}

/** Flip a bullet's inclusion in `section`, keeping the entry's store order. */
function setBulletIncluded(entry, section, bullet, checked) {
  const current = bulletSelection(section, entry);
  const next = new Set(current);
  if (checked) next.add(bullet.id);
  else next.delete(bullet.id);
  state.bulletEdits = {
    ...(state.bulletEdits ?? {}),
    [entry.id]: (entry.bullets ?? []).filter((b) => next.has(b.id)).map((b) => b.id),
  };
}

/** Everything the user can do to one bullet, in one block. */
function bulletBlock(entry, section, bullet, choices) {
  const included = bulletSelection(section, entry).includes(bullet.id);
  const isList = Array.isArray(bullet.items) && bullet.items.length > 0;

  // Off is collapsed to a single line: no picker, no list chips, no per-item
  // controls. That space is the whole point of turning something off, and
  // ticking the box back on brings the full editor straight back.
  if (!included) {
    const preview = isList ? listPreview(bullet) : markup(String(currentText(bullet, choices) ?? ''));
    const row = el('div', { className: 'bullet off' }, [
      toggle({
        on: false,
        title: 'Hidden on this variation — click to show',
        onChange: (checked) => setBulletIncluded(entry, section, bullet, checked),
      }),
      el('div', { className: 'text collapsed' }, [preview]),
    ]);
    // The row itself is also a click target, so re-enabling does not require
    // aiming at the small checkbox.
    row.onclick = (ev) => {
      if (ev.target.closest('input')) return;
      setBulletIncluded(entry, section, bullet, true);
      markDirty();
      render();
    };
    return row;
  }

  const wrap = el('div', { className: 'bullet' });

  const head = el('div', { className: 'bullet-head' }, [
    toggle({
      on: included,
      title: 'Showing on this variation',
      onChange: (checked) => setBulletIncluded(entry, section, bullet, checked),
    }),
    isList
      ? el('div', { className: 'text' }, listPreview(bullet))
      : editableLine(String(currentText(bullet, choices) ?? ''), {
          onCommit: (text) => saveVariantText(entry, bullet, choices[bullet.id] ?? bullet.default, text),
        }),
  ].filter(Boolean));
  wrap.append(head);

  if (isList) {
    wrap.append(listItems(entry, bullet));
    wrap.append(
      el('div', { className: 'variant-row' }, [
        el('span', { className: 'grow' }),
        el('div', { className: 'actions' }, [
          el('span', { className: 'chip count', textContent: `${listSelection(bullet).length}/${bullet.items.length} shown` }),
          el('button', { className: 'tiny', textContent: 'Feedback', onclick: () => askBulletFeedback(entry, bullet) }),
          el('button', { className: 'tiny danger', textContent: 'Remove', onclick: () => removeBullet(entry, bullet) }),
        ]),
      ]),
    );
    return attachSourceTools(wrap, `${entry.id}/${bullet.id}`, [...wrap.children].filter(child => child !== head), head);
  }

  const key = bullet.id;
  const chosenId = choices[key] ?? bullet.default;
  const chosen = bullet.variants.find((v) => v.id === chosenId) ?? bullet.variants[0];

  wrap.append(el('div', { className: 'bullet-quick-actions toolbar' }, [
    alternateStepper(bullet.id, bullet, chosenId),
    phraseFeedbackButton(entry, { bulletId: bullet.id, variantId: chosen?.id ?? chosenId }),
  ].filter(Boolean)));

  wrap.append(
    variantPicker({
      key,
      field: bullet,
      current: chosenId,
      addLabel: '+ phrasing',
      onAdd: () => addBulletVariant(entry, bullet),
      onEdit: chosen ? () => editVariant(entry, bullet, chosen) : null,
      extraActions: [
        el('span', {
          className: 'chip count',
          textContent: plural(bullet.variants.length, 'phrasing'),
          title: 'How many ways this point can be said',
        }),
        chosen?.suggested ? el('span', { className: 'chip suggested', textContent: 'unreviewed' }) : null,
        // Differs from what the store falls back to — not merely "was touched",
        // since pinning this wording as the default settles the difference.
        chosenId !== bullet.default
          ? el('span', {
              className: 'chip overridden',
              textContent: 'changed',
              title: 'This resume uses a different wording from the pinned default',
            })
          : null,
      ].filter(Boolean),
      trailingActions: [
        el('button', { className: 'tiny', textContent: 'Compare Phrasings', onclick: () => askBulletFeedback(entry, bullet) }),
        el('button', {
          className: 'tiny danger',
          textContent: 'Remove',
          title: 'Delete this bullet from the save',
          onclick: () => removeBullet(entry, bullet),
        }),
      ],
    }),
  );

  if (chosen?.note) wrap.append(el('div', { className: 'note', textContent: chosen.note }));
  return attachSourceTools(wrap, `${entry.id}/${bullet.id}`, [...wrap.children].filter(child => child !== head), head);
}

/** The text a non-list bullet currently resolves to. */
function currentText(bullet, choices) {
  const chosen = bullet.variants.find((v) => v.id === (choices[bullet.id] ?? bullet.default)) ?? bullet.variants[0];
  return chosen?.text ?? '(no phrasings yet)';
}

/** What a list bullet will print, given the current selection. */
function listPreview(bullet) {
  const picked = listSelection(bullet);
  const chosen = bullet.items.filter((i) => picked.includes(i.id)).map((i) => i.text);
  const body = chosen.join(bullet.separator ?? ', ') || '(nothing selected)';
  return markup(bullet.prefix ? `${bullet.prefix} ${body}` : body);
}

/** Flip an entry's inclusion in `section`, keeping the section's own order. */
function setEntryIncluded(section, entry, checked) {
  const current = entrySelection(section);
  const next = new Set(current);
  if (checked) next.add(entry.id);
  else next.delete(entry.id);
  const ordered = (section.entries ?? []).filter((id) => next.has(id));
  for (const id of next) if (!ordered.includes(id)) ordered.push(id);
  state.entryEdits = { ...(state.entryEdits ?? {}), [section.kind]: ordered };
}

function entryBlock(entry, section, choices) {
  const included = entrySelection(section).includes(entry.id);

  // Off collapses to one line — no fields, no bullets — so a variation with
  // several entries switched off does not cost you a screen of scrolling to
  // reach the ones that are on.
  if (!included) {
    const row = el('div', { className: 'entry off collapsed' }, [
      toggle({
        on: false,
        title: 'Hidden on this variation — click to show',
        onChange: (checked) => setEntryIncluded(section, entry, checked),
      }),
      el('span', { className: 'title', textContent: fieldText(entry.title, choices, `${entry.id}.title`) || 'Untitled' }),
    ]);
    row.onclick = (ev) => {
      if (ev.target.closest('input')) return;
      setEntryIncluded(section, entry, true);
      markDirty();
      render();
    };
    return row;
  }

  const box = el('div', {});
  const head = el('div', { className: 'entry-head' }, [
    toggle({
      on: included,
      title: 'Showing on this variation',
      onChange: (checked) => setEntryIncluded(section, entry, checked),
    }),
    el('span', { className: 'title', textContent: fieldText(entry.title, choices, `${entry.id}.title`) || 'Untitled' }),
    el('span', { className: 'grow' }),
    entryFeedbackButton(entry),
    el('div', { className: 'entry-actions' }, [
      // The title has no meta-line row of its own, so its "give this
      // alternates" action lives here beside the name it applies to.
      isVariantField(entry.title)
        ? null
        : el('button', {
            className: 'link',
            textContent: '+ alt',
            title: 'Give the title a second option',
            onclick: () => addFieldAlternate(entry, 'title'),
          }),
      el('button', { className: 'tiny', textContent: 'Edit', title: 'Edit this entry’s heading fields', onclick: () => editEntry(entry) }),
      el('button', { className: 'tiny danger', textContent: 'Delete', onclick: () => removeEntry(entry) }),
    ]),
  ]);
  box.append(head);

  /*
   * Heading fields get weight in proportion to how much there is to decide.
   * A field with alternates is a choice, and gets a labelled row with its
   * dropdown. A plain string is just a fact, and gets one compact line with an
   * affordance to give it alternates — that conversion is the heart of the
   * model and must not require opening YAML.
   */
  const plainFields = [];
  for (const name of ['title', 'dates', 'subtitle', 'location']) {
    const field = entry[name];
    const key = `${entry.id}.${name}`;

    if (isVariantField(field)) {
      const current = choices[key] ?? field.default;
      const chosen = field.variants.find((v) => v.id === current);
      const control = variantPicker({
        key,
        field,
        current,
        addLabel: '+ alternate',
        onAdd: () => addFieldAlternate(entry, name),
        onEdit: chosen ? () => editFieldVariant(entry, name, chosen) : null,
        extraActions: [
          el('span', { className: 'chip count', textContent: plural(field.variants.length, 'alternate') }),
          current !== field.default
            ? el('span', {
                className: 'chip overridden',
                textContent: 'changed',
                title: 'This resume uses a different alternate from the pinned default',
              })
            : null,
        ].filter(Boolean),
      });
      if (chosen?.note) control.append(el('div', { className: 'note', textContent: chosen.note }));
      const line = el('div', { className: 'field-line' }, [
        editableLine(String(chosen?.text ?? ''), {
          className: 'text field-text',
          onCommit: (text) => saveFieldText(entry, name, current, text),
        }),
      ]);
      const actions = [alternateStepper(key, field, current),
        phraseFeedbackButton(entry, { fieldName: name, variantId: current })].filter(Boolean);
      line.append(...actions);
      const row = el('div', { className: 'field' }, [
        el('div', { className: 'field-label' }, FIELD_LABELS[name] ?? name), line, control,
      ]);
      box.append(attachSourceTools(row, key, [...actions, control], line, 'field'));
      continue;
    }

    // The title already reads as the entry heading, so it never joins the
    // meta line; its "+ alternate" lives in the header instead.
    if (field == null || name === 'title') continue;
    plainFields.push({ name, text: String(field) });
  }

  if (plainFields.length > 0) {
    const meta = el('div', { className: 'meta-row' });
    for (const f of plainFields) {
      const row = el('span', { className: 'meta-item' }, [
        el('span', { className: 'meta-label', textContent: FIELD_LABELS[f.name] }),
        editableLine(f.text, {
          className: 'meta-value',
          onCommit: (text) => savePlainField(entry, f.name, text),
        }),
        phraseFeedbackButton(entry, { fieldName: f.name }),
        el('button', {
          className: 'link meta-add',
          textContent: '+ alt',
          title: `Give ${FIELD_LABELS[f.name] ?? f.name} a second option — a different graduation date, say`,
          onclick: () => addFieldAlternate(entry, f.name),
        }),
      ]);
      meta.append(attachSourceTools(row, `${entry.id}.${f.name}`,
        [...row.querySelectorAll('button')], row, 'field'));
    }
    // Fields the entry does not have yet, so a missing date is still reachable.
    const missing = ['dates', 'subtitle', 'location'].filter((n) => entry[n] == null);
    if (missing.length > 0) {
      meta.append(
        el('button', {
          className: 'link',
          textContent: `+ ${missing.map((m) => FIELD_LABELS[m].toLowerCase()).join(' / ')}`,
          title: 'Fill in a heading field this entry does not have yet',
          onclick: () => editEntry(entry),
        }),
      );
    }
    box.append(meta);
  }

  for (const bullet of entry.bullets ?? []) {
    if (bullet.archived) continue;
    box.append(bulletBlock(entry, section, bullet, choices));
  }

  box.append(
    el('div', { className: 'add-row' }, [
      el('button', { className: 'link', textContent: '+ Add bullet', onclick: () => addBullet(entry) }),
    ]),
  );
  box.className = 'entry';
  return box;
}

function skillsBlock(section) {
  const frag = document.createDocumentFragment();

  for (const gid of section.groups ?? []) {
    const group = state.store.skillGroups.find((g) => g.id === gid);
    if (!group) continue;

    const picked = state.skillEdits?.[gid] ?? section.items?.[gid] ?? group.items.map((i) => i.id);
    const box = el('div', { className: 'entry' });
    box.append(
      el('div', { className: 'entry-head' }, [
        el('span', { className: 'title', textContent: group.name }),

        el('span', { className: 'grow' }),
        el('div', { className: 'entry-actions' }, [
          el('button', { className: 'tiny danger', textContent: 'Delete group', onclick: () => removeSkillGroup(group) }),
        ]),
      ]),
    );

    const items = el('div', { className: 'skill-items' });
    for (const item of group.items) {
      const on = picked.includes(item.id);
      const chip = el('label', { className: `skill-chip${on ? ' on' : ''}` });
      const cb = el('input', { type: 'checkbox', checked: on });
      cb.onchange = () => {
        const cur = new Set(state.skillEdits?.[gid] ?? picked);
        if (cb.checked) cur.add(item.id);
        else cur.delete(item.id);
        state.skillEdits = { ...(state.skillEdits ?? {}), [gid]: [...cur] };
        markDirty();
        render();
      };
      chip.append(cb, item.text);
      chip.append(
        el('span', {
          className: 'x',
          textContent: '×',
          title: 'Delete this skill from the save',
          onclick: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            removeSkill(group, item);
          },
        }),
      );
      items.append(chip);
    }
    box.append(items);
    box.append(
      el('div', { className: 'add-row' }, [
        el('button', { className: 'link', textContent: '+ Add skill', onclick: () => addSkill(group) }),
      ]),
    );
    frag.append(box);
  }

  frag.append(
    el('div', { className: 'add-row' }, [
      el('button', { className: 'link', textContent: '+ Add skill group', onclick: addSkillGroup }),
    ]),
  );
  return frag;
}

/**
 * Who this is: the block that prints at the top of every resume, and the
 * fields the extension fills forms from.
 *
 * It is the one part of a resume with no variants and no choices — there is
 * only one of you — so it lives above the sections rather than inside them,
 * and it was the last thing in the store that could only be changed by opening
 * YAML.
 */
const PROFILE_FIELDS = [
  ['name', 'Name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['location', 'Address / location'],
  ['linkedin', 'LinkedIn'],
  ['github', 'GitHub'],
  ['website', 'Website'],
];

function profileBlock() {
  const profile = state.store.profile ?? {};
  const box = el('div', { className: 'entry profile-entry' });

  box.append(el('div', { className: 'head' }, nameHead(profile)));

  const grid = el('div', { className: 'profile-grid' });
  for (const [key, label] of PROFILE_FIELDS) {
    if (key === 'name') continue;
    const value = profile[key];
    grid.append(
      el('div', { className: 'profile-field' }, [
        el('span', { className: 'meta-label', textContent: label }),
        value
          ? editableLine(String(value), {
              className: 'meta-value',
              title: `Double-click to edit. ${label} appears in the header of every resume.`,
              onCommit: (text) => saveProfileField(key, text),
            })
          : el('button', {
              className: 'link',
              textContent: `+ ${label.toLowerCase()}`,
              onclick: () => addProfileField(key, label),
            }),
        value
          ? el('button', {
              className: 'link',
              textContent: '×',
              title: `Remove ${label.toLowerCase()} from the header`,
              onclick: () => saveProfileField(key, ''),
            })
          : null,
      ].filter(Boolean)),
    );
  }
  box.append(grid);

  // Extra fields exist for the extension: a portal that asks for a school or a
  // work-authorisation answer should not need typing twice.
  const extras = Object.entries(profile.autofill ?? {});
  const extraWrap = el('div', { className: 'profile-grid' });
  for (const [key, value] of extras) {
    extraWrap.append(
      el('div', { className: 'profile-field' }, [
        el('span', { className: 'meta-label', textContent: key }),
        editableLine(String(value), {
          className: 'meta-value',
          title: 'Double-click to edit. Used to fill forms, never printed on a resume.',
          onCommit: (text) => saveAutofillField(key, text),
        }),
        el('button', { className: 'link', textContent: '×', title: 'Remove', onclick: () => saveAutofillField(key, '') }),
      ]),
    );
  }
  box.append(
    el('div', { className: 'profile-extras' }, [
      el('div', { className: 'field-label', textContent: 'For filling forms' }),
      extras.length > 0 ? extraWrap : el('div', { className: 'hint', textContent: 'Nothing extra yet.' }),
      el('button', { className: 'link', textContent: '+ Field', onclick: addAutofillField }),
    ]),
  );

  return box;
}

/**
 * The name at the top of the page, with its alternates.
 *
 * A name is not one fixed thing — the one on your degree, the one people call
 * you, the initialled form that buys back a line on a full page. It is a field
 * like a graduation date, so it gets the field's controls rather than its own:
 * the same picker, the same stepper, the same pin.
 */
function nameHead(profile) {
  const field = profile.name;
  const said = 'prints at the top of every resume';

  if (!isVariantField(field)) {
    return [
      editableLine(String(field ?? '') || 'Your Name', {
        className: 'title',
        title: 'Double-click to edit. This is the name at the top of every resume.',
        onCommit: (text) => saveProfileField('name', text),
      }),
      el('button', {
        className: 'link meta-add',
        textContent: '+ alt',
        title: 'Give your name a second form — the name people call you, or an initialled one',
        onclick: () => addNameAlternate(),
      }),
      el('span', { className: 'id', textContent: said }),
    ];
  }

  const key = PROFILE_NAME_KEY;
  const current = state.choices[key] ?? field.default;
  const chosen = field.variants.find((v) => v.id === current);

  return [
    editableLine(String(chosen?.text ?? ''), {
      className: 'title',
      title: 'Double-click to edit this form of your name.',
      onCommit: (text) => saveNameText(current, text),
    }),
    alternateStepper(key, field, current),
    variantPicker({
      key,
      field,
      current,
      addLabel: '+ alternate',
      onAdd: () => addNameAlternate(),
      onEdit: null,
      extraActions: [
        el('span', { className: 'chip count', textContent: plural(field.variants.length, 'alternate') }),
        current !== field.default
          ? el('span', {
              className: 'chip overridden',
              textContent: 'changed',
              title: 'This resume uses a different form of your name from the pinned default',
            })
          : null,
      ].filter(Boolean),
    }),
    el('span', { className: 'id', textContent: said }),
  ].filter(Boolean);
}

/** Rewrite one form of the name, leaving the others alone. */
async function saveNameText(variantId, text) {
  const field = state.store.profile.name;
  const next = {
    ...field,
    variants: field.variants.map((v) => (v.id !== variantId ? v : { ...v, text: undisplay(text) })),
  };
  await saveProfileName(next, 'Name updated');
}

/**
 * Give the name another form. The name as it stands is kept as the default, so
 * adding a second one never changes what any existing resume prints.
 */
async function addNameAlternate() {
  const field = state.store.profile.name;
  const existing = isVariantField(field) ? field : null;
  const currentText = existing
    ? (existing.variants.find((v) => v.id === existing.default) ?? existing.variants[0])?.text ?? ''
    : String(field ?? '');

  const answer = await form('New form of your name', [
    { name: 'label', label: 'Label', value: '' },
    { name: 'text', label: 'Name', value: currentText, multiline: false },
    { name: 'note', label: 'Note to self (optional)', value: '' },
    ...(!state.masterView ? [{ name: 'useNow', label: 'Use it in this resume straight away', type: 'checkbox', value: true }] : []),
  ], existing ? null : `"${currentText || '(empty)'}" is kept as the default.`);
  if (!answer?.text?.trim()) return;

  let id = `v_${slug(answer.label || answer.text)}` || `v_${Date.now()}`;
  const taken = new Set((existing?.variants ?? []).map((v) => v.id));
  let n = 2;
  while (taken.has(id)) id = `v_${slug(answer.label || answer.text)}_${n++}`;

  const added = {
    id,
    label: answer.label?.trim() || answer.text.trim().slice(0, 24),
    text: answer.text.trim(),
    ...(answer.note?.trim() ? { note: answer.note.trim() } : {}),
  };

  const next = existing
    ? { ...existing, variants: [...existing.variants, added] }
    : {
        default: 'v_base',
        variants: [
          { id: 'v_base', label: currentText.slice(0, 24) || 'Default', text: currentText },
          added,
        ],
      };

  await saveProfileName(next, 'Added another form of your name');
  if (!state.masterView && answer.useNow) {
    state.choices[PROFILE_NAME_KEY] = id;
    markDirty();
    render();
  }
}

async function saveProfileName(name, message) {
  const profile = { ...state.store.profile, name };
  await api('/profile?commit=0', { method: 'PUT', body: JSON.stringify(profile) });
  state.store.profile = profile;
  setStatus(message);
  render();
  scheduleRender();
  scheduleCommit();
}

async function saveProfileField(key, text) {
  const profile = { ...state.store.profile };
  if (text.trim()) profile[key] = undisplay(text);
  else delete profile[key];
  await api('/profile?commit=0', { method: 'PUT', body: JSON.stringify(profile) });
  state.store.profile = profile;
  setStatus('Saved');
  render();
  scheduleRender();
  scheduleCommit();
}

async function saveAutofillField(key, text) {
  const autofill = { ...(state.store.profile.autofill ?? {}) };
  if (text.trim()) autofill[key] = text.trim();
  else delete autofill[key];

  const profile = { ...state.store.profile, autofill };
  if (Object.keys(autofill).length === 0) delete profile.autofill;
  await api('/profile?commit=0', { method: 'PUT', body: JSON.stringify(profile) });
  state.store.profile = profile;
  setStatus('Saved');
  render();
  scheduleCommit();
}

async function addProfileField(key, label) {
  const answer = await form(`Add ${label.toLowerCase()}`, [{ name: 'value', label, value: '' }]);
  if (answer?.value?.trim()) await saveProfileField(key, answer.value.trim());
}

async function addAutofillField() {
  const answer = await form('Add a field for forms', [
    { name: 'key', label: 'What the form calls it', value: '' },
    { name: 'value', label: 'What to fill in', value: '' },
  ], 'Matched loosely against form labels — "school", "work authorization", and so on.');
  if (answer?.key?.trim() && answer?.value?.trim()) {
    await saveAutofillField(answer.key.trim(), answer.value.trim());
  }
}

function renderEditor() {
  const editor = $('#editor');
  editor.replaceChildren();
  if (!state.store) return;
  if (state.masterView) { renderMasterEditor(editor); return; }
  if (!state.resumeId) return;

  const choices = effectiveChoices();
  const sections = resolveSections();

  editor.append(
    el('div', { className: 'section-heading' }, [
      el('span', { className: 'name', textContent: 'You' }),
      el('span', { className: 'rule' }),
    ]),
    profileBlock(),
  );

  for (const section of sections) {
    const heading = el('div', { className: 'section-heading' }, [
      el('span', { className: 'name', textContent: SECTION_LABELS[section.kind] ?? section.kind }),
      el('span', { className: 'rule' }),
      section.kind !== 'skills'
        ? el('button', {
            className: 'link',
            textContent: '+ Add entry',
            onclick: () => addEntry(section.kind),
          })
        : null,
    ]);
    editor.append(heading);

    if (section.kind === 'skills') {
      editor.append(skillsBlock(section));
      continue;
    }

    // Everything of this kind in the store, with the entries this resume
    // already lists first. Showing only the included ones would make a
    // toggled-off entry disappear, with no way to bring it back.
    const listed = section.entries ?? [];
    const entries = [
      ...listed.map((eid) => state.store.entries.find((e) => e.id === eid)).filter(Boolean),
      ...state.store.entries.filter((e) => e.kind === section.kind && !e.archived && !listed.includes(e.id)),
    ];

    if (entries.length === 0) {
      editor.append(
        el('div', { className: 'empty' }, [
          el('b', {}, `No ${SECTION_LABELS[section.kind].toLowerCase()} yet`),
          'Add an entry and it becomes available to every resume.',
        ]),
      );
      continue;
    }
    for (const entry of entries) editor.append(entryBlock(entry, section, choices));
  }
}

/** The master edits shared source text, without changing any resume's selections. */
function renderMasterEditor(editor) {
  editor.append(profileBlock());
  for (const kind of ['education', 'experience', 'project', 'custom']) {
    const entries = state.store.entries.filter(entry => entry.kind === kind && !entry.archived);
    editor.append(el('div', { className: 'section-heading' }, [
      el('span', { className: 'name', textContent: SECTION_LABELS[kind] ?? kind }),
      el('span', { className: 'rule' }),
      el('button', { className: 'link', textContent: '+ Add Entry', onclick: () => addEntry(kind) }),
    ]));
    if (!entries.length) editor.append(el('p', { className: 'hint', textContent: 'No source entries yet.' }));
    for (const entry of entries) {
      const box = el('article', { className: 'master-source-entry' });
      box.append(el('div', { className: 'entry-head' }, [
        el('span', { className: 'grow' }), entryFeedbackButton(entry),
      ]));
      for (const name of ['title', 'subtitle', 'dates', 'location']) {
        const field = entry[name];
        if (!field) continue;
        const variants = isVariantField(field) ? field.variants : [{ id: null, text: field }];
        for (const variant of variants) {
          const row = el('div', { className: 'master-source-field' }, [
            el('span', { className: 'hint', textContent: `${FIELD_LABELS[name] ?? name}${variant.label ? ` · ${variant.label}` : ''}${variant.id && variant.id === field.default ? ' · Default' : ''}` }),
            el('div', { className: 'phrase-line' }, [
              editableLine(String(variant.text), { onCommit: text => variant.id
                ? saveFieldText(entry, name, variant.id, text) : savePlainField(entry, name, text) }),
              phraseFeedbackButton(entry, { fieldName: name, ...(variant.id ? { variantId: variant.id } : {}) }),
            ]),
          ]);
          box.append(attachSourceTools(row, `${entry.id}.${name}/${variant.id ?? 'plain'}`,
            [row.querySelector('.phrase-feedback')], row.querySelector('.phrase-line'), 'field'));
        }
      }
      for (const bullet of entry.bullets ?? []) {
        const row = el('div', { className: 'master-source-bullet' });
        if (Array.isArray(bullet.items)) {
          row.append(el('div', { className: 'text', textContent: `${bullet.prefix ?? ''} ${bullet.items.map(item => item.text).join(bullet.separator ?? ', ')}` }));
          row.append(el('button', { className: 'tiny', textContent: '+ Item', onclick: () => addListItem(entry, bullet) }));
          row.append(el('button', { className: 'tiny', textContent: 'AI Feedback', onclick: () => askBulletFeedback(entry, bullet) }));
        } else {
          for (const variant of bullet.variants) row.append(el('div', { className: 'master-source-variant' }, [
            el('span', { className: 'hint', textContent: `${variant.label}${variant.id === bullet.default ? ' · Default' : ''}${variant.suggested ? ' · AI Suggestion' : ''}${bullet.archived ? ' · Archived' : ''}` }),
            el('div', { className: 'phrase-line' }, [
              editableLine(String(variant.text), { onCommit: text => saveVariantText(entry, bullet, variant.id, text) }),
              phraseFeedbackButton(entry, { bulletId: bullet.id, variantId: variant.id }),
            ]),
          ]));
          row.append(el('div', { className: 'toolbar' }, [
            el('button', { className: 'tiny', textContent: '+ Phrasing', onclick: () => addBulletVariant(entry, bullet) }),
            el('button', { className: 'tiny', textContent: 'Compare Phrasings', onclick: () => askBulletFeedback(entry, bullet) }),
          ]));
        }
        const actions = [...row.querySelectorAll('.phrase-feedback, :scope > button, :scope > .toolbar')];
        const anchor = row.querySelector('.phrase-line') ?? row;
        attachSourceTools(row, `${entry.id}/${bullet.id}`, actions, anchor);
        box.append(row);
      }
      box.append(el('button', { className: 'tiny', textContent: '+ Bullet', onclick: () => addBullet(entry) }));
      editor.append(box);
    }
  }
  editor.append(el('div', { className: 'section-heading' }, [el('span', { className: 'name', textContent: 'Skills' }), el('span', { className: 'rule' })]));
  for (const group of state.store.skillGroups) editor.append(el('div', { className: 'master-source-entry' }, [
    el('b', { textContent: group.name }),
    el('p', { textContent: group.items.map(item => item.text).join(', ') }),
    el('button', { className: 'tiny', textContent: '+ Skill', onclick: () => addSkill(group) }),
  ]));
}

/* ------------------------------------------------------------------ *
 * Adding and editing                                                  *
 * ------------------------------------------------------------------ */

async function addEntry(kind) {
  const answer = await form(`New ${kind} entry`, [
    { name: 'title', label: kind === 'education' ? 'School' : kind === 'project' ? 'Project name' : 'Company', value: '' },
    { name: 'subtitle', label: FIELD_LABELS.subtitle, value: '' },
    { name: 'dates', label: 'Dates', value: '' },
    { name: 'location', label: 'Location', value: '' },
    { name: 'bullet', label: 'First bullet (optional)', value: '', multiline: true },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
  ]);
  if (!answer?.title?.trim()) return;

  const prefix = { education: 'edu', experience: 'exp', project: 'proj' }[kind] ?? 'entry';
  let id = `${prefix}_${slug(answer.title)}`;
  // Ids must be unique: they are how every resume refers to this entry.
  let n = 2;
  while (state.store.entries.some((e) => e.id === id)) id = `${prefix}_${slug(answer.title)}_${n++}`;

  const entry = {
    id,
    kind,
    title: answer.title.trim(),
    ...(answer.subtitle?.trim() ? { subtitle: answer.subtitle.trim() } : {}),
    ...(answer.dates?.trim() ? { dates: answer.dates.trim() } : {}),
    ...(answer.location?.trim() ? { location: answer.location.trim() } : {}),
    ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
    bullets: answer.bullet?.trim()
      ? [{ id: `b_${slug(answer.title)}_1`, default: 'v_base', variants: [{ id: 'v_base', label: 'Base', text: answer.bullet.trim() }] }]
      : [],
  };

  await api(`/entries/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(entry) });

  if (state.masterView) {
    await loadStore();
    render();
    scheduleRender();
    setStatus('Added to the master. Select it in a tailored resume when needed.');
    return;
  }

  // A new entry nobody references is invisible, so add it to the section of the
  // resume being edited — at the root of the chain, so every resume gets it.
  const root = chain(state.resumeId)[0];
  const sections = resolveSections().map((s) =>
    s.kind === kind ? { ...s, entries: [...(s.entries ?? []), id] } : s,
  );
  if (!sections.some((s) => s.kind === kind)) sections.push({ kind, entries: [id] });
  await saveResumeSpec({ ...root, sections }, `Added ${id}`);
  render();
  scheduleRender();
}

async function editEntry(entry) {
  const plainOrNote = (f) => (isVariantField(f) ? '' : (f ?? ''));
  const answer = await form(`Edit ${entryName(entry)}`, [
    { name: 'title', label: FIELD_LABELS.title, value: plainOrNote(entry.title), disabled: isVariantField(entry.title) },
    { name: 'subtitle', label: FIELD_LABELS.subtitle, value: plainOrNote(entry.subtitle), disabled: isVariantField(entry.subtitle) },
    { name: 'dates', label: FIELD_LABELS.dates, value: plainOrNote(entry.dates), disabled: isVariantField(entry.dates) },
    { name: 'location', label: FIELD_LABELS.location, value: plainOrNote(entry.location), disabled: isVariantField(entry.location) },
    { name: 'tags', label: 'Tags, comma separated', value: (entry.tags ?? []).join(', ') },
  ], 'Fields that have alternates are edited through their own dropdown.');
  if (!answer) return;

  const next = { ...entry };
  for (const f of ['title', 'subtitle', 'dates', 'location']) {
    if (isVariantField(entry[f])) continue;
    const v = answer[f]?.trim();
    if (v) next[f] = v;
    else delete next[f];
  }
  next.tags = answer.tags ? answer.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  await saveEntry(next);
  scheduleRender();
}

async function removeEntry(entry) {
  if (!(await confirmModal(`Delete ${entryName(entry)}?`, 'The entry and all of its phrasings are removed from the save. Resumes referencing it will warn until you remove the reference.'))) return;
  await api(`/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });

  // Drop the reference too, so the next compile does not warn about it.
  const root = chain(state.resumeId)[0];
  const sections = resolveSections().map((s) => ({
    ...s,
    entries: (s.entries ?? []).filter((id) => id !== entry.id),
  }));
  await saveResumeSpec({ ...root, sections }, `Deleted ${entry.id}`);
  render();
  scheduleRender();
}

/** Add a new bullet to an entry, with its first phrasing. */
async function addBullet(entry) {
  const answer = await form(`New bullet — ${entryName(entry)}`, [
    { name: 'text', label: 'Text', value: '', multiline: true },
    { name: 'label', label: 'Label for this phrasing', value: 'Base' },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
  ], 'Markup: **bold**, *italic*, `code`.');
  if (!answer?.text?.trim()) return;

  let id = `b_${slug(entry.id).replace(/^(exp|edu|proj)_/, '')}_${(entry.bullets?.length ?? 0) + 1}`;
  const taken = new Set((entry.bullets ?? []).map((b) => b.id));
  let n = 2;
  while (taken.has(id)) id = `${id}_${n++}`;

  const next = {
    ...entry,
    bullets: [
      ...(entry.bullets ?? []),
      {
        id,
        default: 'v_base',
        variants: [
          {
            id: 'v_base',
            label: answer.label?.trim() || 'Base',
            text: answer.text.trim(),
            ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
          },
        ],
      },
    ],
  };
  await saveEntry(next, `Added bullet ${id}`);
  scheduleRender();
}

async function removeBullet(entry, bullet) {
  if (!(await confirmModal(`Delete “${bulletName(entry, bullet)}”?`, `All ${plural(bullet.variants.length, 'phrasing')} of it are removed from the save.`))) return;
  await saveEntry({ ...entry, bullets: (entry.bullets ?? []).filter((b) => b.id !== bullet.id) }, `Deleted ${bullet.id}`);
  scheduleRender();
}

/** Add another phrasing of an existing bullet. */
async function addBulletVariant(entry, bullet) {
  const current = bullet.variants.find((v) => v.id === bullet.default) ?? bullet.variants[0];
  const answer = await form(`New phrasing — ${bulletName(entry, bullet)}`, [
    { name: 'label', label: 'Label', value: '' },
    { name: 'text', label: 'Text', value: current?.text ?? '', multiline: true },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
    { name: 'note', label: 'Note to self (optional)', value: '' },
    ...(!state.masterView ? [{ name: 'useNow', label: 'Use it in this resume straight away', type: 'checkbox', value: true }] : []),
  ], 'Starts from the current wording so you can adjust rather than retype.');
  if (!answer?.text?.trim()) return;

  const variant = await api(
    `/entries/${encodeURIComponent(entry.id)}/bullets/${encodeURIComponent(bullet.id)}/variants`,
    {
      method: 'POST',
      body: JSON.stringify({
        label: answer.label?.trim() || 'New phrasing',
        text: answer.text,
        tags: answer.tags ? answer.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        note: answer.note?.trim() || undefined,
      }),
    },
  );

  if (!state.masterView && answer.useNow) {
    state.choices[bullet.id] = variant.id;
    markDirty();
  }
  setStatus(`Added phrasing "${variant.label}"`);
  await loadStore();
  render();
  if (state.masterView || answer.useNow) scheduleRender();
}

/** Edit an existing phrasing in place — it changes everywhere it is used. */
/**
 * Write an inline edit back to the store. Only the text changes: the label,
 * tags and note belong to the fuller editor, and nobody retypes those while
 * fixing a sentence.
 */
async function saveVariantText(entry, bullet, variantId, text) {
  const raw = undisplay(text);
  const next = {
    ...entry,
    bullets: entry.bullets.map((b) =>
      b.id !== bullet.id
        ? b
        : {
            ...b,
            variants: b.variants.map((v) =>
              // Editing it is the review: a suggested phrasing you have
              // touched is no longer unreviewed.
              v.id !== variantId ? v : { ...v, text: raw, suggested: undefined },
            ),
          },
    ),
  };
  await saveEntry(next, 'Wording updated');
  scheduleRender();
}

/** The same, for one alternate of a heading field. */
async function saveFieldText(entry, name, variantId, text) {
  const field = entry[name];
  const next = {
    ...entry,
    [name]: {
      ...field,
      variants: field.variants.map((v) => (v.id !== variantId ? v : { ...v, text: undisplay(text) })),
    },
  };
  await saveEntry(next, `${FIELD_LABELS[name] ?? name} updated`);
  scheduleRender();
}

/** And for a field that is a plain string rather than a set of alternates. */
async function savePlainField(entry, name, text) {
  await saveEntry({ ...entry, [name]: undisplay(text) }, `${FIELD_LABELS[name] ?? name} updated`);
  scheduleRender();
}

/** The inverse of `display()`: back to the store's LaTeX-flavoured text. */
function undisplay(text) {
  return String(text ?? '').replace(/\s–\s/g, ' -- ');
}

async function editVariant(entry, bullet, variant) {
  const answer = await form(`Edit "${variant.label}"`, [
    { name: 'label', label: 'Label', value: variant.label },
    { name: 'text', label: 'Text', value: variant.text, multiline: true },
    { name: 'tags', label: 'Tags, comma separated', value: (variant.tags ?? []).join(', ') },
    { name: 'note', label: 'Note to self', value: variant.note ?? '' },
  ], 'This wording is shared: every resume using it changes too. That is the point.');
  if (!answer?.text?.trim()) return;

  const next = {
    ...entry,
    bullets: entry.bullets.map((b) =>
      b.id !== bullet.id
        ? b
        : {
            ...b,
            variants: b.variants.map((v) =>
              v.id !== variant.id
                ? v
                : {
                    ...v,
                    label: answer.label?.trim() || v.label,
                    text: answer.text.trim(),
                    tags: answer.tags ? answer.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
                    note: answer.note?.trim() || undefined,
                    // Editing it is the review.
                    suggested: undefined,
                  },
            ),
          },
    ),
  };
  await saveEntry(next, 'Phrasing updated');
  scheduleRender();
}

/**
 * Give a heading field an alternate. When the field is currently a plain
 * string, this converts it into a variant set, keeping the existing text as
 * the default — the "two graduation dates" move, without touching YAML.
 */
async function addFieldAlternate(entry, name) {
  const field = entry[name];
  const existing = isVariantField(field) ? field : null;
  const currentText = existing
    ? (existing.variants.find((v) => v.id === existing.default) ?? existing.variants[0])?.text ?? ''
    : String(field ?? '');

  const answer = await form(`New alternate — ${FIELD_LABELS[name] ?? name} of ${entryName(entry)}`, [
    { name: 'label', label: 'Label', value: '' },
    { name: 'text', label: 'Text', value: currentText, multiline: false },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
    { name: 'note', label: 'Note to self (optional)', value: '' },
    ...(!state.masterView ? [{ name: 'useNow', label: 'Use it in this resume straight away', type: 'checkbox', value: true }] : []),
  ], existing ? null : `"${currentText || '(empty)'}" is kept as the default.`);
  if (!answer?.text?.trim()) return;

  const key = `${entry.id}.${name}`;
  let id = `v_${slug(answer.label || answer.text)}` || `v_${Date.now()}`;
  const taken = new Set((existing?.variants ?? []).map((v) => v.id));
  let n = 2;
  while (taken.has(id)) id = `v_${slug(answer.label || answer.text)}_${n++}`;

  const newVariant = {
    id,
    label: answer.label?.trim() || answer.text.trim().slice(0, 24),
    text: answer.text.trim(),
    ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
    ...(answer.note?.trim() ? { note: answer.note.trim() } : {}),
  };

  const nextField = existing
    ? { ...existing, variants: [...existing.variants, newVariant] }
    : {
        default: 'v_base',
        variants: [
          { id: 'v_base', label: currentText.slice(0, 24) || 'Default', text: currentText },
          newVariant,
        ],
      };

  await saveEntry({ ...entry, [name]: nextField }, `Added alternate for ${key}`);
  if (!state.masterView && answer.useNow) {
    state.choices[key] = id;
    markDirty();
    render();
    scheduleRender();
  }
}

async function editFieldVariant(entry, name, variant) {
  const field = entry[name];
  const answer = await form(`Edit "${variant.label}"`, [
    { name: 'label', label: 'Label', value: variant.label },
    { name: 'text', label: 'Text', value: variant.text },
    { name: 'tags', label: 'Tags, comma separated', value: (variant.tags ?? []).join(', ') },
    { name: 'note', label: 'Note to self', value: variant.note ?? '' },
    { name: 'remove', label: 'Delete this alternate instead', type: 'checkbox', value: false },
  ]);
  if (!answer) return;

  let variants;
  if (answer.remove) {
    if (field.variants.length < 2) {
      setStatus('An alternate set needs at least one option', true);
      return;
    }
    variants = field.variants.filter((v) => v.id !== variant.id);
  } else {
    if (!answer.text?.trim()) return;
    variants = field.variants.map((v) =>
      v.id !== variant.id
        ? v
        : {
            ...v,
            label: answer.label?.trim() || v.label,
            text: answer.text.trim(),
            tags: answer.tags ? answer.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
            note: answer.note?.trim() || undefined,
          },
    );
  }

  const nextDefault = variants.some((v) => v.id === field.default) ? field.default : variants[0].id;
  await saveEntry({ ...entry, [name]: { default: nextDefault, variants } }, 'Alternate updated');
  scheduleRender();
}

/* ---- List bullets ---- */

async function addListItem(entry, bullet) {
  const answer = await form(`Add to ${bullet.prefix?.replace(/[*:]/g, '').trim() || 'the list'}`, [
    { name: 'text', label: 'Item', value: '' },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
  ], 'Tags are what the extension matches against a job posting.');
  if (!answer?.text?.trim()) return;

  const id = `i_${slug(answer.text)}`;
  const next = {
    ...entry,
    bullets: entry.bullets.map((b) =>
      b.id !== bullet.id
        ? b
        : {
            ...b,
            items: [
              ...b.items,
              {
                id,
                text: answer.text.trim(),
                ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
              },
            ],
          },
    ),
  };
  await saveEntry(next, 'Item added');

  // A newly added item is shown by default; not doing so makes the click
  // look like it failed.
  if (!state.masterView) {
    state.listEdits = { ...(state.listEdits ?? {}), [bullet.id]: [...listSelection(bullet), id] };
    markDirty();
  }
  render();
  scheduleRender();
}

async function removeListItem(entry, bullet, item) {
  const next = {
    ...entry,
    bullets: entry.bullets.map((b) =>
      b.id !== bullet.id ? b : { ...b, items: b.items.filter((i) => i.id !== item.id) },
    ),
  };
  await saveEntry(next, `Removed ${item.text}`);
  scheduleRender();
}

/* ---- Skills ---- */

async function addSkill(group) {
  const answer = await form(`Add a skill to ${group.name}`, [
    { name: 'text', label: 'Skill', value: '' },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
  ], 'Tags are what the extension matches against a job posting.');
  if (!answer?.text?.trim()) return;

  const groups = state.store.skillGroups.map((g) =>
    g.id !== group.id
      ? g
      : {
          ...g,
          items: [
            ...g.items,
            {
              id: `s_${slug(answer.text)}`,
              text: answer.text.trim(),
              ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
            },
          ],
        },
  );
  await api('/skills', { method: 'PUT', body: JSON.stringify(groups) });
  setStatus('Skill added');
  await loadStore();
  render();
  scheduleRender();
}

async function removeSkill(group, item) {
  const groups = state.store.skillGroups.map((g) =>
    g.id !== group.id ? g : { ...g, items: g.items.filter((i) => i.id !== item.id) },
  );
  await api('/skills', { method: 'PUT', body: JSON.stringify(groups) });
  setStatus(`Removed ${item.text}`);
  await loadStore();
  render();
  scheduleRender();
}

async function addSkillGroup() {
  const answer = await form('New skill group', [
    { name: 'name', label: 'Group name, e.g. Languages', value: '' },
    { name: 'items', label: 'Skills, comma separated', value: '' },
  ]);
  if (!answer?.name?.trim()) return;

  const id = `sk_${slug(answer.name)}`;
  const groups = [
    ...state.store.skillGroups,
    {
      id,
      name: answer.name.trim(),
      items: (answer.items ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((text) => ({ id: `s_${slug(text)}`, text })),
    },
  ];
  await api('/skills', { method: 'PUT', body: JSON.stringify(groups) });

  const root = chain(state.resumeId)[0];
  const sections = resolveSections().map((s) =>
    s.kind === 'skills' ? { ...s, groups: [...(s.groups ?? []), id] } : s,
  );
  if (!sections.some((s) => s.kind === 'skills')) sections.push({ kind: 'skills', entries: [], groups: [id] });
  await saveResumeSpec({ ...root, sections }, 'Skill group added');
  render();
  scheduleRender();
}

async function removeSkillGroup(group) {
  if (!(await confirmModal(`Delete "${group.name}"?`, 'The group and its skills are removed from the save.'))) return;
  await api('/skills', {
    method: 'PUT',
    body: JSON.stringify(state.store.skillGroups.filter((g) => g.id !== group.id)),
  });
  const root = chain(state.resumeId)[0];
  const sections = resolveSections().map((s) =>
    s.kind === 'skills' ? { ...s, groups: (s.groups ?? []).filter((g) => g !== group.id) } : s,
  );
  await saveResumeSpec({ ...root, sections }, 'Group deleted');
  render();
  scheduleRender();
}

/* ------------------------------------------------------------------ *
 * Compiling and feedback                                              *
 * ------------------------------------------------------------------ */

/* ---- Live preview -------------------------------------------------- *
 * Nothing in the editor should require pressing a button to see. Every
 * change schedules a recompile; the debounce keeps a burst of toggles (or a
 * run of keystrokes) to one compile, and the token discards any answer that
 * arrives after a newer one has already been asked for — without it, a slow
 * early compile can land last and put a stale page on screen.
 * -------------------------------------------------------------------- */

const LIVE_DELAY_MS = 350;
let renderTimer = null;
let renderToken = 0;

function scheduleRender({ delay = LIVE_DELAY_MS } = {}) {
  clearTimeout(renderTimer);
  setLive('working');
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderPreview();
  }, delay);
}

/**
 * Show a PDF in a preview pane, without a flash.
 *
 * Each pane gets one pdf.js renderer, created on first use and reused after
 * that. The renderer draws offscreen and swaps in a finished page, so the
 * previous page stays on screen until the new one is ready — see preview.js
 * for why the browser's own PDF viewer cannot do this.
 */
const previews = new WeakMap();

function showPdf(frame, url) {
  let preview = previews.get(frame);
  if (!preview) {
    preview = createPreview(frame);
    previews.set(frame, preview);
  }
  return preview.show(url).catch((err) => {
    console.warn('[rmm] preview failed:', err);
  });
}

/** The "is what I see current?" indicator that replaced the Preview button. */
function setLive(mode) {
  const chip = $('#live-state');
  if (!chip) return;
  chip.className = `live ${mode}`;
  chip.textContent = mode === 'working' ? 'Updating…' : mode === 'bad' ? 'Compile failed' : 'Live';
}

async function renderPreview() {
  const token = ++renderToken;
  const fit = $('#fit');
  setLive('working');
  if (fit.classList.contains('idle')) fit.textContent = 'Compiling…';
  try {
    const master = state.masterView;
    const result = await api('/render', { method: 'POST', body: JSON.stringify(master ? { master: true } : { spec: currentSpec() }) });
    // A newer edit already asked for a newer compile; this answer is stale.
    if (token !== renderToken) return;
    setLive('ok');

    showPdf($('#preview-pane'), result.pdfUrl);

    fit.className = master || result.fits ? 'fit' : 'fit bad';
    fit.replaceChildren(
      master ? `Master Document · ${plural(result.pages, 'page')} · All source phrasings; may exceed two pages`
      : result.fits
        ? `Fits on one page${
            result.overflowLines < 0 ? ` — room for about ${plural(Math.abs(result.overflowLines), 'more line')}` : ''
          }`
        : `${plural(result.pages, 'page')} — about ${plural(result.overflowLines, 'line')} too long. Pick a shorter phrasing or drop a bullet.`,
    );
    if (!master && result.adjustments.length) {
      fit.append(el('span', { className: 'adj', textContent: ` · auto-fit: ${result.adjustments.join('; ')}` }));
    }

    $('#warnings').replaceChildren(...(result.warnings ?? []).map((w) => el('div', { textContent: w })));
  } catch (err) {
    if (token !== renderToken) return;
    setLive('bad');
    fit.className = 'fit bad';
    fit.textContent = err.message;
  }
}

async function saveAsVariation() {
  const answer = await form('Save as variation', [
    { name: 'id', label: 'Id — becomes the filename', value: `${state.resumeId}-variant` },
    { name: 'label', label: 'Label', value: `${resumeById(state.resumeId)?.label ?? state.resumeId} variation` },
  ], `Inherits from "${state.resumeId}", so later edits there still reach it.`);
  if (!answer?.id?.trim()) return;

  // A variation is the whole bundle: which entries and bullets are switched
  // on, which phrasings are used, and which list items are shown. Saving only
  // the phrasings would silently drop half of what you just did.
  const built = currentSpec();
  const spec = {
    id: answer.id.trim(),
    label: answer.label?.trim() || answer.id.trim(),
    extends: state.resumeId,
    choices: { ...state.choices },
    ...(state.listEdits ? { lists: { ...state.listEdits } } : {}),
    ...(built.sections ? { sections: built.sections } : {}),
  };

  await saveResumeSpec(spec, `Saved ${spec.id}`);
  clearEdits();
  state.resumeId = spec.id;
  render();
}

/**
 * Ask for a critique and carry on working.
 *
 * A good critique takes the AI a minute or three, and holding a dialog open
 * for it is the wrong shape — you asked a question, you should be able to go
 * and do something else. The request goes off as a job; the header says when
 * an answer is waiting.
 */
async function askFeedback(master = false) {
  const button = $('#btn-feedback');
  button.disabled = true;
  try {
    await flushEdits();
    if (state.dirty) throw new Error('Save your edits before requesting feedback');
    setStatus(master ? 'Preparing Master Feedback…' : 'Preparing feedback…');
    const { job } = await api('/ai/feedback', {
      method: 'POST',
      body: JSON.stringify(master ? { master: true, background: true } : { resumeId: state.resumeId, background: true }),
    });
    await openJob(job);
    setStatus(master ? 'Reading the master inventory — feedback will appear in the results indicator' : 'Reading your resume — this keeps working while you do');
    watchJobs();
    return job;
  } catch (err) {
    showModal('Feedback failed', el('pre', { textContent: err.message }));
    return null;
  } finally {
    button.disabled = false;
  }
}

/* ---- Work you walked away from ------------------------------------- *
 * Jobs are polled rather than pushed: this is a local server and one small
 * request every few seconds costs nothing, where a socket would be a second
 * transport to keep working for one badge.
 * -------------------------------------------------------------------- */

let jobTimer = null;
let feedbackJobs = [];
let feedbackJobId = null;
let feedbackShownStatus = null;
let feedbackRequest = 0;

function updateFeedbackPicker() {
  $('#feedback-select').replaceChildren(...feedbackJobs.map(job => el('option', {
    value: job.id,
    textContent: `${job.about}${job.status === 'running' ? ' — Working…' : job.status === 'failed' ? ' — Failed' : ''}`,
  })));
  if (feedbackJobId) $('#feedback-select').value = feedbackJobId;
}

function watchJobs() {
  clearInterval(jobTimer);
  jobTimer = setInterval(() => refreshJobs().catch(() => {}), 3000);
  refreshJobs().catch(() => {});
}

async function refreshJobs() {
  const { jobs } = await api('/ai/jobs');
  feedbackJobs = jobs.filter(job => job.kind === 'feedback');
  updateFeedbackPicker();
  const selected = feedbackJobs.find(job => job.id === feedbackJobId);
  if (selected && !$('#feedback-panel').hidden && selected.status !== feedbackShownStatus) await openJob(selected, false);
  renderJobChip(jobs);
  // Nothing running and nothing unread: stop asking.
  if (!jobs.some((j) => j.status === 'running' || j.unread)) {
    clearInterval(jobTimer);
    jobTimer = null;
  }
}

function renderJobChip(jobs) {
  const chip = $('#jobs-chip');
  if (!chip) return;

  const running = jobs.filter((j) => j.status === 'running');
  const ready = jobs.filter((j) => j.status !== 'running' && j.unread);

  if (running.length === 0 && ready.length === 0) {
    chip.className = jobs.length ? 'jobs-chip' : 'jobs-chip hidden';
    chip.textContent = jobs.length ? 'Feedback Results' : '';
    chip.onclick = () => { if (jobs[0]) openJob(jobs[0]); };
    return;
  }

  chip.className = `jobs-chip${ready.length > 0 ? ' ready' : ' working'}`;
  chip.textContent =
    ready.length > 0
      ? `${plural(ready.length, 'result')} ready`
      : `Thinking about ${running[0].about}…`;
  chip.onclick = () => openJob(ready[0] ?? running[0]);
}

async function openJob(job, reveal = true) {
  const request = ++feedbackRequest;
  feedbackJobId = job.id;
  feedbackShownStatus = job.status;
  if (!feedbackJobs.some(item => item.id === job.id)) feedbackJobs.unshift(job);
  updateFeedbackPicker();
  $('#feedback-panel').hidden = false;
  if (reveal) showTab('resumes');
  $('#feedback-status').textContent = job.status === 'running' ? `Reading ${job.about}… You can keep editing.` : 'Loading feedback…';
  $('#feedback-content').replaceChildren();
  if (job.status === 'running') return;
  try {
    const full = await api(`/ai/jobs/${encodeURIComponent(job.id)}`);
    if (request !== feedbackRequest) return;
    feedbackShownStatus = full.status;
    $('#feedback-status').textContent = full.status === 'failed' ? 'Feedback failed'
      : full.result?.executed ? full.about : 'AI is off — showing the prompt it would run';
    if (full.status === 'failed') $('#feedback-content').textContent = full.error ?? 'Unknown error';
    else $('#feedback-content').replaceChildren(renderFeedbackMarkdown(full.result?.output ?? ''));
    const local = feedbackJobs.find(item => item.id === job.id);
    if (local) local.unread = false;
    renderJobChip(feedbackJobs);
  } catch (err) {
    if (request !== feedbackRequest) return;
    $('#feedback-status').textContent = 'Could not load feedback';
    $('#feedback-content').textContent = err.message;
  }
}

async function askBulletFeedback(entry, bullet) {
  return askSourceFeedback({ entryId: entry.id, bulletId: bullet.id });
}

async function askSourceFeedback(target) {
  try {
    await flushEdits();
    if (state.dirty) throw new Error('Save your edits before requesting feedback');
    const { job } = await api('/ai/feedback', {
      method: 'POST',
      body: JSON.stringify({ ...target, background: true }),
    });
    await openJob(job);
    setStatus('AI feedback requested — you can keep editing. Watch the results indicator.');
    watchJobs();
  } catch (err) {
    showModal('Feedback failed', el('pre', { textContent: err.message }));
  }
}

/* ------------------------------------------------------------------ *
 * Applications                                                        *
 * ------------------------------------------------------------------ */

const STATUSES = ['interested', 'applying', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'];

let openApplicationId = null;

async function loadApplications() {
  const { applications, stats, current } = await api('/applications');

  // Where to point a file picker: everything still in flight, in one folder,
  // already named the way portals want it.
  const files = $('#current-files');
  if (files) {
    setChildren(
      files,
      el('span', { className: 'meta-label', textContent: 'Ready to upload' }),
      el('span', { className: 'mono-path', textContent: current?.dir ?? '' }),
      el('span', {
        className: 'hint',
        // An empty folder with applications in flight is a different fact from
        // an empty folder with nothing in flight, and the useful one to say.
        textContent: current?.files?.length
          ? `${plural(current.files.length, 'file')} from ${plural(current.applications, 'application')} still being sent.`
          : current?.inFlight
            ? `Empty — ${plural(current.inFlight, 'application')} in flight, none with a built folder yet.`
            : 'Empty — nothing is mid-application.',
      }),
    );
  }

  $('#stats').replaceChildren(
    ...[
      ['Total', stats.total],
      ['Last 7 days', stats.last7],
      ['Last 30 days', stats.last30],
      ['Response rate', `${stats.responseRate}%`],
    ].map(([label, value]) =>
      el('div', { className: 'stat' }, [el('b', { textContent: String(value) }), el('span', { textContent: label })]),
    ),
  );

  const wrap = $('#apps-wrap');
  if (applications.length === 0) {
    wrap.replaceChildren(
      el('div', { className: 'empty' }, [
        el('b', {}, 'Nothing tracked yet'),
        'Applications land here when you use “Save application folder” in the browser extension, or run ',
        el('code', {}, 'rmm apply'),
        '.',
      ]),
    );
    return;
  }

  const rows = [...applications]
    .sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))
    .map((a) => {
      const sel = el('select');
      for (const s of STATUSES) sel.append(el('option', { value: s, textContent: s, selected: s === a.status }));
      sel.onchange = async () => {
        await api(`/applications/${encodeURIComponent(a.id)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: sel.value }),
        });
        setStatus('Status updated');
        loadApplications();
      };
      const row = el('tr', { className: a.id === openApplicationId ? 'selected' : '' }, [
        el('td', { textContent: a.appliedAt?.slice(0, 10) ?? '' }),
        el('td', { textContent: a.company }),
        el('td', { textContent: a.role }),
        el('td', {}, [sel]),
        el('td', {}, [
          a.coverLetter ? el('span', { className: 'chip count', textContent: 'letter' }) : null,
          a.answers?.length
            ? el('span', { className: 'chip count', textContent: plural(a.answers.length, 'answer') })
            : null,
        ].filter(Boolean)),
        el('td', {}, [
          el('button', {
            className: 'tiny danger',
            textContent: 'Remove',
            onclick: async (ev) => {
              ev.stopPropagation();
              if (!(await confirmModal(`Remove ${a.company}?`, 'The tracker row goes; the files on disk stay.'))) return;
              await api(`/applications/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
              if (openApplicationId === a.id) openApplicationId = null;
              loadApplications();
            },
          }),
        ]),
      ]);

      // Clicking the row opens the full record; the status dropdown and the
      // remove button stop the event so they still work on their own.
      row.onclick = () => openApplication(a.id);
      sel.onclick = (ev) => ev.stopPropagation();
      return row;
    });

  wrap.replaceChildren(
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, ['Date', 'Company', 'Role', 'Status', 'Sent', ''].map((h) => el('th', { textContent: h }))),
      ]),
      el('tbody', {}, rows),
    ]),
  );
}

/** Everything that was actually submitted for one application. */
async function openApplication(id) {
  openApplicationId = id;
  const panel = $('#app-detail');
  setChildren(panel, skeleton('detail', 3));

  try {
    const { application: a, resume, letter, files } = await api(`/applications/${encodeURIComponent(id)}`);

    const sections = [];

    sections.push(
      el('div', { className: 'sect' }, [
        el('h4', {}, 'Resume sent'),
        el('div', { className: 'file', textContent: resume ? `${resume.label} (${resume.id})` : (a.resumeId ?? '—') }),
        resume?.extends
          ? el('div', { className: 'hint', textContent: `Built on ${resume.extends}.` })
          : null,
      ]),
    );

    if (letter?.body?.trim()) {
      sections.push(
        el('div', { className: 'sect' }, [
          el('h4', {}, 'Cover letter'),
          el('div', { className: 'prose', textContent: letter.body }),
        ]),
      );
    }

    if (a.answers?.length) {
      sections.push(
        el('div', { className: 'sect' }, [
          el('h4', {}, `Answers (${a.answers.length})`),
          ...a.answers.map((qa) =>
            el('div', { className: 'qa' }, [
              el('div', { className: 'q', textContent: qa.question }),
              el('div', { className: 'prose', textContent: qa.answer }),
            ]),
          ),
        ]),
      );
    }

    if (files.length) {
      sections.push(
        el('div', { className: 'sect' }, [
          el('h4', {}, 'Files'),
          ...files.map((f) => el('div', { className: 'file', textContent: f })),
        ]),
      );
    }

    if (a.history?.length) {
      sections.push(
        el('div', { className: 'sect' }, [
          el('h4', {}, 'History'),
          el(
            'div',
            { className: 'timeline' },
            a.history.map((h) =>
              el('div', { className: 'tl' }, [
                el('span', { className: 'when', textContent: h.at?.slice(0, 10) ?? '' }),
                el('span', { textContent: `${h.status}${h.note ? ` — ${h.note}` : ''}` }),
              ]),
            ),
          ),
        ]),
      );
    }

    if (a.notes?.trim()) {
      sections.push(el('div', { className: 'sect' }, [el('h4', {}, 'Notes'), el('div', { className: 'prose', textContent: a.notes })]));
    }

    setChildren(
      panel,
      el('h3', { textContent: a.role }),
      el('div', { className: 'sub' }, [
        document.createTextNode(a.company),
        a.url ? document.createTextNode(' · ') : null,
        a.url ? el('a', { href: a.url, target: '_blank', textContent: 'posting' }) : null,
      ]),
      ...sections,
    );
  } catch (err) {
    setChildren(panel, el('div', { className: 'err', textContent: err.message }));
  }
  loadApplications();
}

async function addApplication() {
  const answer = await form('Record an application', [
    { name: 'company', label: 'Company', value: '' },
    { name: 'role', label: 'Role', value: '' },
    { name: 'url', label: 'URL', value: '' },
    { name: 'notes', label: 'Notes', value: '', multiline: true },
  ]);
  if (!answer?.company?.trim() || !answer?.role?.trim()) return;
  await api('/applications', { method: 'POST', body: JSON.stringify({ ...answer, resumeId: state.resumeId }) });
  loadApplications();
}

/* ------------------------------------------------------------------ *
 * Workspace — applications in progress                                *
 * ------------------------------------------------------------------ */

let openDraftId = null;

async function loadDrafts() {
  const { drafts } = await api('/workspace');
  const list = $('#draft-list');

  if (drafts.length === 0) {
    setChildren(
      list,
      el('div', { className: 'empty' }, [
        el('b', {}, 'Nothing in progress'),
        'When a posting wants a cover letter or written answers, send it here from the browser extension.',
      ]),
    );
    if (!openDraftId) renderDraft(null);
    return;
  }

  setChildren(
    list,
    ...drafts.map((d) => {
      const answered = d.questions.filter((q) => q.answer.trim()).length;
      const letterDone = !d.coverLetter.required || Boolean(d.coverLetter.body.trim());
      const ready = letterDone && answered === d.questions.length;

      return el(
        'div',
        {
          className: `draft-card${d.id === openDraftId ? ' selected' : ''}`,
          onclick: () => openDraft(d.id),
        },
        [
          el('div', { className: 'co', textContent: d.company }),
          el('div', { className: 'role', textContent: d.role }),
          el('div', { className: 'bits' }, [
            d.coverLetter.required
              ? el('span', {
                  className: `badge ${d.coverLetter.body.trim() ? 'done' : 'required'}`,
                  textContent: d.coverLetter.body.trim() ? 'letter written' : 'letter needed',
                })
              : null,
            d.questions.length
              ? el('span', {
                  className: `badge ${answered === d.questions.length ? 'done' : 'required'}`,
                  textContent: `${answered}/${d.questions.length} answered`,
                })
              : null,
            ready ? el('span', { className: 'badge done', textContent: 'ready' }) : null,
          ]),
        ],
      );
    }),
  );

  if (!openDraftId && drafts[0]) openDraft(drafts[0].id);
}

/**
 * Start a workspace by hand, for a posting that did not come through the
 * extension — a referral, an email, a job board the extension does not read.
 * Everything is optional except who it is for: the questions can be pasted in
 * one per line, straight from the form.
 */
async function newDraft() {
  const answer = await form(
    'New application',
    [
      { name: 'company', label: 'Company', value: '' },
      { name: 'role', label: 'Role', value: '' },
      { name: 'url', label: 'Posting url (optional)', value: '' },
      {
        name: 'resumeId',
        label: 'Resume to send',
        type: 'select',
        value: state.resumeId,
        options: state.store.resumes.map((r) => ({ value: r.id, label: r.label })),
      },
      { name: 'coverLetter', label: 'It asks for a cover letter', type: 'checkbox', value: false },
      {
        name: 'questions',
        label: 'Questions it asks, one per line',
        value: '',
        multiline: true,
      },
      { name: 'jobDescription', label: 'Posting text (optional — used when drafting)', value: '', multiline: true },
    ],
    'Anything your answer bank already covers arrives filled in.',
  );
  if (!answer?.company?.trim() || !answer?.role?.trim()) {
    if (answer) setStatus('A company and a role are needed', true);
    return;
  }

  const questions = String(answer.questions ?? '')
    .split('\n')
    .map((q) => q.trim())
    .filter(Boolean)
    .map((question) => ({ question, required: false }));

  const created = await api('/workspace', {
    method: 'POST',
    body: JSON.stringify({
      company: answer.company.trim(),
      role: answer.role.trim(),
      url: answer.url?.trim() || undefined,
      resumeId: answer.resumeId,
      source: 'by hand',
      jobDescription: answer.jobDescription?.trim() || undefined,
      coverLetterRequired: Boolean(answer.coverLetter),
      questions,
    }),
  });

  setStatus(`Workspace opened for ${created.draft.company}`);
  await loadDrafts();
  await openDraft(created.draft.id);
}

async function openDraft(id) {
  openDraftId = id;
  location.hash = `#workspace/${encodeURIComponent(id)}`;
  try {
    renderDraft(await api(`/workspace/${encodeURIComponent(id)}`));
  } catch (err) {
    setStatus(err.message, true);
  }
  loadDrafts();
}

const SOURCE_LABEL = { bank: 'from your answer bank', ai: 'drafted by AI', human: 'written by you', empty: 'not answered' };

/* The letter preview gets the same treatment as the resume's: debounce a burst
 * of typing into one compile, and ignore any answer that a newer keystroke has
 * already superseded. */
let letterTimer = null;
let letterToken = 0;

function renderDraft(draft) {
  const panel = $('#draft-editor');
  if (!draft) {
    setChildren(
      panel,
      el('div', { className: 'empty' }, [
        el('b', {}, 'Nothing open'),
        'Pick an application on the left, or send one over from the extension.',
      ]),
    );
    return;
  }

  const notes = el('div', { className: 'gen-notes' });

  /** Persist the draft as it stands, marking edited fields so generation
   *  never overwrites something a human wrote. */
  const save = async (message) => {
    await api(`/workspace/${encodeURIComponent(draft.id)}`, { method: 'PUT', body: JSON.stringify(draft) });
    if (message) setStatus(message);
  };

  const blocks = [];

  /* Cover letter — written on the left, typeset on the right, live. */
  if (draft.coverLetter.required) {
    const letter = el('textarea', {
      className: 'letter',
      value: draft.coverLetter.body,
      placeholder: 'Write the letter here, or press Draft to start from your previous ones.',
    });

    // Drawn by pdf.js, so retypesetting mid-sentence swaps in a finished page
    // instead of blinking the letter away while a new PDF loads.
    const letterEmpty = el('div', {
      className: 'preview-empty',
      textContent: 'Type a first sentence and it appears here, set like your resume.',
    });
    const letterPane = el('div', { className: 'preview-frame letter-preview' }, [letterEmpty]);
    const letterFit = el('div', { className: 'fit idle', textContent: 'Not compiled yet.' });
    const liveChip = el('span', { className: 'live ok', textContent: 'Live' });

    const compile = async () => {
      if (!draft.coverLetter.body.trim()) {
        letterPane.classList.remove('loaded');
        letterFit.className = 'fit idle';
        letterFit.textContent = 'Nothing written yet.';
        liveChip.className = 'live ok';
        liveChip.textContent = 'Live';
        return;
      }
      const token = ++letterToken;
      liveChip.className = 'live working';
      liveChip.textContent = 'Updating…';
      try {
        const r = await api('/render/letter', {
          method: 'POST',
          body: JSON.stringify({
            body: draft.coverLetter.body,
            company: draft.company,
            role: draft.role,
            draftId: draft.id,
            resumeId: draft.resumeId,
          }),
        });
        if (token !== letterToken) return; // a newer keystroke already asked
        showPdf(letterPane, r.pdfUrl);
        liveChip.className = 'live ok';
        liveChip.textContent = 'Live';
        letterFit.className = r.fits ? 'fit' : 'fit bad';
        letterFit.textContent = r.fits
          ? 'Fits on one page.'
          : `${plural(r.pages, 'page')} — about ${plural(r.overflowLines, 'line')} too long for one.`;
      } catch (err) {
        if (token !== letterToken) return;
        liveChip.className = 'live bad';
        liveChip.textContent = 'Compile failed';
        letterFit.className = 'fit bad';
        letterFit.textContent = err.message;
      }
    };

    // Longer than the resume's debounce: this one fires on every keystroke,
    // and recompiling mid-word is wasted work.
    const scheduleLetter = () => {
      clearTimeout(letterTimer);
      liveChip.className = 'live working';
      liveChip.textContent = 'Updating…';
      letterTimer = setTimeout(compile, 700);
    };

    letter.oninput = () => {
      draft.coverLetter.body = letter.value;
      draft.coverLetter.edited = true;
      scheduleLetter();
    };
    letter.onblur = () => save();

    blocks.push(
      el('div', { className: 'block' }, [
        el('div', { className: 'block-head' }, [
          el('h4', {}, 'Cover letter'),
          el('span', {
            className: `badge ${draft.coverLetter.body.trim() ? 'done' : 'required'}`,
            textContent: draft.coverLetter.body.trim() ? 'written' : 'required',
          }),
          liveChip,
          el('span', { className: 'grow', style: 'flex:1' }),
          el('button', {
            className: 'tiny',
            textContent: 'Draft it',
            title: 'Write a first draft from the posting and the letters you have written before',
            onclick: () => generate(draft, 'letter', notes),
          }),
          el('button', {
            className: 'tiny',
            textContent: 'Ask for feedback',
            title: 'The AI reads what you have written and says what is weak — it does not rewrite it',
            disabled: !draft.coverLetter.body.trim(),
            onclick: () => askDraftFeedback(draft, {}, notes),
          }),
        ]),
        el('div', { className: 'letter-split' }, [letter, letterPane]),
        letterFit,
      ]),
    );

    // Show the letter as it stands the moment the draft opens.
    queueMicrotask(compile);
  }

  /* Questions */
  if (draft.questions.length > 0) {
    const qs = el('div');
    for (const q of draft.questions) {
      const box = el('textarea', {
        value: q.answer,
        placeholder: 'No stored answer yet — what you write here is saved for next time.',
      });
      box.oninput = () => {
        q.answer = box.value;
        q.edited = true;
        q.source = 'human';
      };
      box.onblur = () => save();

      qs.append(
        el('div', { style: 'margin-bottom:16px' }, [
          el('div', { className: 'q-label' }, [
            document.createTextNode(q.question),
            q.required ? el('span', { className: 'badge required', style: 'margin-left:6px', textContent: 'required' }) : null,
          ]),
          el('div', { className: 'row-tight', style: 'margin-bottom:5px' }, [
            el('span', {
              className: `badge ${q.edited ? 'human' : (q.source ?? 'empty')}`,
              textContent: q.edited ? SOURCE_LABEL.human : (SOURCE_LABEL[q.source] ?? SOURCE_LABEL.empty),
            }),
            el('span', { style: 'flex:1' }),
            el('button', {
              className: 'link',
              textContent: 'Draft this one',
              title: 'Write an answer from the posting and the answers you have given before',
              onclick: () => generate(draft, 'questions', notes, { questionId: q.id }),
            }),
            el('button', {
              className: 'link',
              textContent: 'Feedback',
              title: 'The AI reads this answer and says what is weak — it does not rewrite it',
              disabled: !q.answer?.trim(),
              onclick: () => askDraftFeedback(draft, { questionId: q.id }, notes),
            }),
          ]),
          box,
        ]),
      );
    }

    blocks.push(
      el('div', { className: 'block' }, [
        el('div', { className: 'block-head' }, [
          el('h4', {}, `Questions (${draft.questions.length})`),
          el('span', { style: 'flex:1' }),
          el('button', {
            className: 'tiny',
            textContent: 'Fill in what is empty',
            onclick: () => generate(draft, 'questions', notes),
          }),
        ]),
        qs,
      ]),
    );
  }

  if (blocks.length === 0) {
    blocks.push(
      el('div', { className: 'block' }, [
        el('p', { className: 'hint' }, 'This posting asked for no cover letter and no written answers — just the resume.'),
      ]),
    );
  }

  /* Notes and actions */
  const notesBox = el('textarea', { value: draft.notes ?? '', placeholder: 'Notes to yourself about this application.' });
  notesBox.oninput = () => (draft.notes = notesBox.value);
  notesBox.onblur = () => save();

  const resumeSelect = el('select');
  for (const r of state.store.resumes) {
    resumeSelect.append(el('option', { value: r.id, textContent: r.label, selected: r.id === draft.resumeId }));
  }
  resumeSelect.onchange = () => {
    draft.resumeId = resumeSelect.value;
    save('Resume changed');
  };

  setChildren(
    panel,
    el('h3', { textContent: `${draft.role}` }),
    el('div', { className: 'where' }, [
      document.createTextNode(draft.company),
      draft.url ? document.createTextNode(' · ') : null,
      draft.url ? el('a', { href: draft.url, target: '_blank', textContent: 'posting' }) : null,
    ]),
    ...blocks,
    el('div', { className: 'block' }, [
      el('div', { className: 'block-head' }, [el('h4', {}, 'Resume and notes')]),
      el('div', { className: 'toolbar' }, [el('span', { className: 'hint' }, 'Send'), resumeSelect]),
      el('div', { className: 'toolbar' }, [
        el('button', {
          textContent: 'Tailor one for this posting',
          title: draft.url
            ? 'Read the posting and pick the phrasings that suit it'
            : 'Works from the posting text; add a link to this draft to read it automatically',
          onclick: () => tailorDraft(draft, notes, false),
        }),
        el('button', {
          className: 'tiny',
          textContent: 'Let the AI choose',
          title: 'The AI reads the posting and decides which phrasings and bullets to use',
          onclick: () => tailorDraft(draft, notes, true),
        }),
        /*
         * The third thing you want, and the one that was missing: neither
         * matching nor AI, but going and deciding yourself. Working on an
         * application is where you notice the resume needs a version for it.
         */
        el('button', {
          className: 'tiny',
          textContent: 'Start one to edit myself',
          title: 'Create a variation for this application and open it in the builder',
          onclick: () => startVariation(draft, notes),
        }),
      ]),
      draft.resumeId
        ? el('div', { className: 'toolbar' }, [
            el('button', {
              className: 'link',
              textContent: 'Open this resume in the builder →',
              title: 'Edit the resume this application will send, and come back here after',
              onclick: () => {
                location.hash = `#resumes/${encodeURIComponent(draft.resumeId)}/from/${encodeURIComponent(draft.id)}`;
              },
            }),
          ])
        : null,
      el('div', {
        className: 'hint',
        textContent: draft.url
          ? 'The posting is read from its link, the same way the extension reads the page you are on.'
          : 'No link on this draft, so it works from whatever posting text it already has.',
      }),
      notesBox,
    ]),
    el('div', { className: 'block' }, [
      el('div', { className: 'toolbar' }, [
        el('button', {
          className: 'primary',
          textContent: 'Build files and record it',
          title: 'Compile the resume, name the files, and log the answers in the application history',
          onclick: () => completeDraft(draft, notes),
        }),
        el('button', { textContent: 'Save', onclick: () => save('Saved') }),
        el('span', { style: 'flex:1' }),
        el('button', {
          className: 'tiny danger',
          textContent: 'Discard',
          onclick: async () => {
            if (!(await confirmModal(`Discard the draft for ${draft.company}?`, 'The written answers are lost. The resume and the answer bank are untouched.'))) return;
            await api(`/workspace/${encodeURIComponent(draft.id)}`, { method: 'DELETE' });
            openDraftId = null;
            renderDraft(null);
            loadDrafts();
          },
        }),
      ]),
      notes,
    ]),
  );
}

/**
 * Make a resume for this posting from inside the workspace — the same
 * pipeline the extension runs, given a link instead of a page.
 */
/**
 * Start a resume variation for this application and go and edit it.
 *
 * The walk matters as much as the variation: it lands in the builder already
 * on the new resume, and the builder knows which application sent it, so the
 * way back is one click to this posting rather than a hunt through the list.
 */
async function startVariation(draft, notes) {
  try {
    setStatus('Starting a variation…');
    const result = await api(`/workspace/${encodeURIComponent(draft.id)}/variation`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadStore();
    setStatus(`Started "${result.spec.label}"`);
    // The server hands back where to go, so the two ends cannot disagree about
    // the shape of the link.
    location.hash = result.url.slice(result.url.indexOf('#'));
  } catch (err) {
    notes.textContent = err.message;
    setStatus(err.message, true);
  }
}

async function tailorDraft(draft, notes, useAi) {
  setChildren(notes, el('div', { textContent: useAi ? 'Reading the posting…' : 'Matching against the posting…' }));
  try {
    const res = await api(`/workspace/${encodeURIComponent(draft.id)}/tailor`, {
      method: 'POST',
      body: JSON.stringify({ useAi, baseResumeId: draft.resumeId }),
    });

    const changed = (res.diff ?? []).filter((c) => c.kind !== 'none');
    setChildren(
      notes,
      el('div', {
        textContent: res.fetched
          ? `Read the posting and made "${res.spec.label}".`
          : `Made "${res.spec.label}" from the posting text on this draft.`,
      }),
      el('div', {
        textContent: changed.length
          ? `${plural(changed.length, 'change')} from the resume it started from${res.usedAi ? ', chosen by the AI' : ''}.`
          : 'Nothing needed changing — the resume already suited it.',
      }),
      ...changed.slice(0, 6).map((c) => el('div', { className: 'hint', textContent: c.text })),
    );

    await loadStore();
    await openDraft(draft.id);
  } catch (err) {
    setChildren(notes, el('div', { className: 'err', textContent: err.message }));
  }
}

async function generate(draft, what, notes, extra = {}) {
  setChildren(notes, el('div', { textContent: 'Working…' }));
  try {
    const res = await api(`/workspace/${encodeURIComponent(draft.id)}/generate`, {
      method: 'POST',
      body: JSON.stringify({ what, ...extra }),
    });
    renderDraft(res.draft);
    const panel = $('#draft-editor .gen-notes');
    if (panel) setChildren(panel, ...res.notes.map((n) => el('div', { textContent: n })));
    setStatus('Draft updated');
  } catch (err) {
    setChildren(notes, el('div', { className: 'err', textContent: err.message }));
  }
}

/**
 * Ask the AI what is wrong with what you have written.
 *
 * The letter and the answers were the one part of an application it could
 * write but never read back — which is the wrong way round, because reviewing
 * your own prose is the thing it is best at and the thing you least want to do
 * at midnight.
 *
 * It runs as a background job like resume feedback does, and lands in the same
 * results panel, because a critique takes as long here as it does there and
 * nobody should watch a spinner for it.
 */
async function askDraftFeedback(draft, target, notes) {
  try {
    setChildren(notes, el('div', { textContent: 'Reading it…' }));
    const { job } = await api('/ai/feedback', {
      method: 'POST',
      body: JSON.stringify({ draftId: draft.id, ...target, background: true }),
    });
    await openJob(job);
    setChildren(
      notes,
      el('div', {
        textContent: 'Reading it — the feedback will appear in the results indicator, and this keeps working while you write.',
      }),
    );
    watchJobs();
    return job;
  } catch (err) {
    setChildren(notes, el('div', { className: 'err', textContent: err.message }));
    return null;
  }
}

async function completeDraft(draft, notes) {
  const unanswered = draft.questions.filter((q) => q.required && !q.answer.trim());
  if (unanswered.length > 0) {
    const go = await showModal(
      'Some required questions are blank',
      el('p', {}, `${plural(unanswered.length, 'required question')} still has no answer. Build the files anyway?`),
      { okLabel: 'Build anyway', showCancel: true },
    );
    if (!go) return;
  }

  setChildren(notes, el('div', { textContent: 'Compiling…' }));
  try {
    const res = await api(`/workspace/${encodeURIComponent(draft.id)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ saveAnswersToBank: true }),
    });
    openDraftId = null;
    renderDraft(null);
    await loadDrafts();
    await showModal(
      'Filed',
      el('div', {}, [
        el('p', {}, 'Ready to attach:'),
        ...res.files.map((f) => el('div', { className: 'hint', textContent: f })),
        el('p', { className: 'hint', style: 'margin-top:8px', textContent: res.dir }),
        el('p', { className: 'hint', textContent: 'Answers are in the application history and saved to your bank.' }),
      ]),
    );
  } catch (err) {
    setChildren(notes, el('div', { className: 'err', textContent: err.message }));
  }
}

/* ------------------------------------------------------------------ *
 * Letters and answers                                                 *
 * ------------------------------------------------------------------ */

async function loadLetters() {
  const [letters, store] = await Promise.all([api('/letters'), api('/store')]);

  // How often each stored question has actually gone out, so the bank shows
  // which answers are pulling their weight.
  const usedBy = {};
  for (const app of store.applications ?? []) {
    for (const qa of app.answers ?? []) usedBy[qa.question] = (usedBy[qa.question] ?? 0) + 1;
  }

  $('#letters').replaceChildren(
    letters.length === 0
      ? el('div', { className: 'empty' }, [
          el('b', {}, 'No letters yet'),
          'Drafts written by the extension are saved here, and become the voice reference for the next one.',
        ])
      : el(
          'div',
          { className: 'card-list' },
          letters.map((l) =>
            el('div', { className: 'mini-card' }, [
              el('div', { className: 'row1' }, [
                el('b', { textContent: l.title }),
                el('span', { className: 'faint', textContent: l.createdAt?.slice(0, 10) ?? '' }),
                el('span', { style: 'flex:1' }),
                // A letter written for an application belongs to it; say so,
                // and link across rather than making the two lists be
                // cross-read by eye.
                l.applicationId
                  ? el('button', {
                      className: 'link',
                      textContent: 'application',
                      title: 'Open the application this was written for',
                      onclick: () => {
                        showTab('applications');
                        openApplication(l.applicationId);
                      },
                    })
                  : null,
                el('button', { className: 'tiny', textContent: 'Open', onclick: () => editLetter(l) }),
              ]),
              el('div', { className: 'body', textContent: l.body.slice(0, 260) }),
            ]),
          ),
        ),
  );

  $('#answers').replaceChildren(
    store.answers.length === 0
      ? el('div', { className: 'empty' }, [el('b', {}, 'No saved answers'), 'Add the questions every form asks.'])
      : el(
          'div',
          { className: 'card-list' },
          store.answers.map((a) => {
            const v = a.variants.find((x) => x.id === a.default) ?? a.variants[0];
            return el('div', { className: 'mini-card' }, [
              el('div', { className: 'row1' }, [
                el('b', { textContent: a.question }),
                el('span', { style: 'flex:1' }),
                usedBy[a.question]
                  ? el('span', {
                      className: 'chip count',
                      textContent: `used in ${plural(usedBy[a.question], 'application')}`,
                    })
                  : null,
                el('span', { className: 'chip count', textContent: plural(a.variants.length, 'version') }),
                el('button', { className: 'tiny', textContent: 'Edit', onclick: () => editAnswer(a) }),
              ]),
              el('div', { className: 'body', textContent: v?.text ?? '' }),
            ]);
          }),
        ),
  );
}

async function editLetter(letter) {
  const answer = await form(letter.title ?? 'Cover letter', [
    { name: 'title', label: 'Title', value: letter.title ?? '' },
    { name: 'company', label: 'Company', value: letter.company ?? '' },
    { name: 'role', label: 'Role', value: letter.role ?? '' },
    { name: 'body', label: 'Body', value: letter.body ?? '', multiline: true, tall: true },
  ]);
  if (!answer) return;
  await api(`/letters/${encodeURIComponent(letter.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ ...letter, ...answer }),
  });
  setStatus('Letter saved');
  loadLetters();
}

async function addLetter() {
  const answer = await form('New cover letter', [
    { name: 'company', label: 'Company', value: '' },
    { name: 'role', label: 'Role', value: '' },
    { name: 'body', label: 'Body', value: '', multiline: true, tall: true },
  ]);
  if (!answer?.body?.trim()) return;
  const id = `${new Date().toISOString().slice(0, 10)}-${slug(answer.company || 'letter')}`;
  await api(`/letters/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      id,
      title: `${answer.role || 'Role'} — ${answer.company || 'Unknown'}`,
      company: answer.company,
      role: answer.role,
      createdAt: new Date().toISOString(),
      body: answer.body,
    }),
  });
  setStatus('Letter saved');
  loadLetters();
}

async function addAnswer() {
  const answer = await form('New saved answer', [
    { name: 'question', label: 'Question, as forms usually word it', value: '' },
    { name: 'answer', label: 'Your answer', value: '', multiline: true, tall: true },
  ], 'Offered automatically when a form asks something close to this.');
  if (!answer?.question?.trim() || !answer?.answer?.trim()) return;
  await api('/answers/save', { method: 'POST', body: JSON.stringify(answer) });
  setStatus('Answer saved');
  loadLetters();
}

async function editAnswer(item) {
  const v = item.variants.find((x) => x.id === item.default) ?? item.variants[0];
  const answer = await form(item.question, [
    { name: 'answer', label: 'Answer', value: v?.text ?? '', multiline: true, tall: true },
    { name: 'label', label: 'Label for this version', value: 'Updated' },
    { name: 'asNew', label: 'Keep the old wording as another version', type: 'checkbox', value: false },
  ]);
  if (!answer?.answer?.trim()) return;

  if (answer.asNew) {
    await api('/answers/save', {
      method: 'POST',
      body: JSON.stringify({ itemId: item.id, question: item.question, answer: answer.answer, label: answer.label }),
    });
  } else {
    const answers = (await api('/store')).answers.map((a) =>
      a.id !== item.id
        ? a
        : { ...a, variants: a.variants.map((x) => (x.id === v.id ? { ...x, text: answer.answer.trim() } : x)) },
    );
    await api('/answers', { method: 'PUT', body: JSON.stringify(answers) });
  }
  setStatus('Answer saved');
  loadLetters();
}

/* ------------------------------------------------------------------ *
 * Voice — inferred from real writing, not self-description            *
 * ------------------------------------------------------------------ */

const SAMPLE_KINDS = [
  { value: 'letter', label: 'Cover letter' },
  { value: 'resume', label: 'Resume or bullets' },
  { value: 'answer', label: 'Application answer' },
  { value: 'other', label: 'Something else you wrote' },
];

async function loadVoice() {
  const data = await api('/voice');
  $('#voice').value = data.voice ?? '';
  $('#voice-preview').textContent = data.preview;

  // What is actually being sent, and how much of what exists fits.
  const pct = data.context.available
    ? Math.min(100, Math.round((data.context.chars / data.context.available) * 100))
    : 0;
  setChildren(
    $('#voice-budget'),
    data.context.chars === 0
      ? el('span', {}, 'No samples yet — every request will fall back to generic instructions.')
      : el('span', {}, `${plural(data.context.used.length, 'sample')} sent to the AI`),
    el('div', { className: 'bar' }, [el('span', { style: `width:${Math.max(pct, 4)}%` })]),
    el('span', {
      className: 'faint',
      textContent: data.context.available
        ? `${data.context.chars.toLocaleString()} of ${data.context.available.toLocaleString()} characters`
        : '',
    }),
  );

  // Samples the user pasted in are editable; the rest are shown as what they
  // are so it is clear the corpus is bigger than this list.
  const derived = data.context.used.filter((u) => !data.samples.some((x) => x.title === u.title));

  setChildren(
    $('#samples'),
    data.samples.length === 0 && derived.length === 0
      ? el('div', { className: 'empty' }, [
          el('b', {}, 'Nothing to learn from yet'),
          'Paste in an old resume or a cover letter you liked. One or two is enough.',
        ])
      : el('div', { className: 'card-list' }, [
          ...data.samples.map((sample) =>
            el('div', { className: 'mini-card' }, [
              el('div', { className: 'row1' }, [
                el('b', { textContent: sample.title }),
                el('span', { className: 'chip count sample-kind', textContent: sample.kind }),
                el('span', { style: 'flex:1' }),
                el('button', { className: 'tiny', textContent: 'Edit', onclick: () => editSample(sample) }),
                el('button', {
                  className: 'tiny danger',
                  textContent: 'Remove',
                  onclick: async () => {
                    if (!(await confirmModal(`Remove “${sample.title}”?`, 'It stops informing your voice. Nothing else changes.'))) return;
                    await api(`/voice/samples/${encodeURIComponent(sample.id)}`, { method: 'DELETE' });
                    loadVoice();
                  },
                }),
              ]),
              el('div', { className: 'body sample', textContent: sample.text.slice(0, 300) }),
            ]),
          ),
          ...derived.map((u) =>
            el('div', { className: 'mini-card' }, [
              el('div', { className: 'row1' }, [
                el('b', { textContent: u.title }),
                el('span', { className: 'chip count sample-kind', textContent: u.kind }),
                el('span', { style: 'flex:1' }),
                el('span', {
                  className: 'faint',
                  textContent: 'already in your save',
                  title: 'Letters you have sent and answers you have saved count automatically',
                }),
              ]),
            ]),
          ),
        ]),
  );
}

/* ------------------------------------------------------------------ *
 * Adding files to the corpus                                          *
 * ------------------------------------------------------------------ */

/**
 * The drop zone. Dragging a file onto a page is the one gesture everyone
 * already knows, so it is the main way in; the click and the keyboard are
 * there because a gesture nobody can reach is not an affordance.
 */
function wireVoiceDrop() {
  const zone = $('#voice-drop');
  const input = $('#voice-files');
  if (!zone || !input) return;

  const open = () => input.click();
  zone.onclick = open;
  // The toolbar button opens the same picker. Dropping is the gesture this is
  // built around, but a button is what people look for first.
  const button = $('#btn-add-files');
  if (button) button.onclick = open;
  zone.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };
  input.onchange = () => {
    const files = [...input.files];
    input.value = ''; // so the same file can be dropped again
    if (files.length) ingestFiles(files).catch((e) => setStatus(e.message, true));
  };

  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, () => zone.classList.remove('over'));
  }
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) ingestFiles(files).catch((err) => setStatus(err.message, true));
  });
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

/** Read each file, ask the server what is in it, then show the lot for review. */
async function ingestFiles(files) {
  const zone = $('#voice-drop');
  zone.classList.add('busy');

  const proposals = [];
  const failed = [];
  try {
    for (const [n, file] of files.entries()) {
      setChildren(
        zone,
        el('b', { textContent: `Reading ${file.name}…` }),
        el('span', {
          className: 'faint',
          textContent:
            files.length > 1
              ? `File ${n + 1} of ${files.length}. Sorting what is inside it.`
              : 'Sorting what is inside it.',
        }),
        el('div', { className: 'bar indeterminate' }, [el('span')]),
      );

      try {
        const result = await api('/voice/ingest', {
          method: 'POST',
          body: JSON.stringify({ name: file.name, data: await readAsBase64(file) }),
        });
        for (const item of result.items) proposals.push({ ...item, source: file.name });
        if (result.aiError) setStatus(`Sorted ${file.name} without AI: ${result.aiError}`, true);
      } catch (err) {
        failed.push(`${file.name}: ${err.message}`);
      }
    }
  } finally {
    zone.classList.remove('busy');
    resetVoiceDrop();
  }

  if (failed.length) setStatus(failed.join(' · '), true);
  if (proposals.length === 0) {
    if (!failed.length) setStatus('Nothing in those files looked like writing', true);
    return;
  }
  await reviewProposals(proposals);
}

function resetVoiceDrop() {
  setChildren(
    $('#voice-drop'),
    el('b', {}, 'Drop files here'),
    el('span', {
      className: 'faint',
      textContent:
        'PDF, Word, Markdown, LaTeX, plain text — a file with four old cover letters in it is split into four. Nothing is saved until you have looked at it.',
    }),
  );
}

const PROPOSAL_NOTE =
  'Each of these was taken from the file as it stands — nothing was rewritten. Correct anything filed wrongly, untick what you do not want, then add them.';

/**
 * What was found, before it is kept. Everything is ticked and ready; the work
 * left is glancing down the list, which is the point.
 */
async function reviewProposals(proposals) {
  const rows = [];
  const content = el('div', { className: 'proposals' });

  const files = new Set(proposals.map((p) => p.source)).size;
  const summaryLine = el('p', { className: 'hint' });

  // What will actually be added, recounted as boxes are ticked: the button
  // says "Add them", and this is the sentence that says what "them" is.
  const retally = () => {
    const kept = rows.filter((r) => r.keep.checked);
    const counts = {};
    for (const r of kept) counts[r.kind.value] = (counts[r.kind.value] ?? 0) + 1;
    const byKind = SAMPLE_KINDS.filter((k) => counts[k.value])
      .map((k) => `${counts[k.value]} × ${k.label.toLowerCase()}`)
      .join(', ');

    const skipped = rows.length - kept.length;
    summaryLine.textContent = kept.length === 0
      ? `Nothing ticked — all ${plural(rows.length, 'piece')} from ${plural(files, 'file')} will be left out.`
      : `${plural(kept.length, 'piece')} of writing from ${plural(files, 'file')}${
          byKind ? `: ${byKind}` : ''
        }${skipped > 0 ? `. ${skipped} left out.` : '.'}`;
  };

  content.append(summaryLine);

  for (const p of proposals) {
    const keep = el('input', { type: 'checkbox', checked: true });
    const title = el('input', { type: 'text', value: p.title, className: 'proposal-title' });
    const kind = el('select');
    for (const k of SAMPLE_KINDS) {
      kind.append(el('option', { value: k.value, textContent: k.label, selected: k.value === p.kind }));
    }

    const body = el('div', { className: 'body sample', textContent: p.text });
    const row = el('div', { className: 'proposal' }, [
      el('div', { className: 'row1' }, [
        keep,
        title,
        kind,
        el('span', {
          className: 'faint',
          textContent: `${p.source} · ${p.by === 'ai' ? 'sorted by AI' : 'sorted by rules'}`,
        }),
      ]),
      body,
    ]);

    // Untick and the row recedes, so what will be kept reads at a glance.
    keep.onchange = () => {
      row.classList.toggle('dropped', !keep.checked);
      retally();
    };
    kind.onchange = retally;
    content.append(row);
    rows.push({ p, keep, title, kind });
  }

  retally();

  const ok = await showModal('Add these to your writing?', content, {
    note: PROPOSAL_NOTE,
    okLabel: 'Add them',
    showCancel: true,
  });
  if (!ok) return;

  const items = rows
    .filter((r) => r.keep.checked)
    .map((r) => ({ kind: r.kind.value, title: r.title.value, text: r.p.text }));
  if (items.length === 0) {
    setStatus('Nothing added');
    return;
  }

  const sources = [...new Set(proposals.map((p) => p.source))];
  const result = await api('/voice/ingest/accept', {
    method: 'POST',
    body: JSON.stringify({ items, source: sources.length === 1 ? sources[0] : `${sources.length} files` }),
  });
  setStatus(`Added ${plural(result.added, 'sample')} to your writing`);
  loadVoice();
}

async function addSample() {
  const answer = await form('Add a writing sample', [
    { name: 'title', label: 'What is it?', value: '' },
    {
      name: 'kind',
      label: 'Kind',
      type: 'select',
      value: 'letter',
      options: SAMPLE_KINDS.map((k) => ({ value: k.value, label: k.label })),
    },
    { name: 'text', label: 'Paste the text', value: '', multiline: true, tall: true },
  ], 'It need not relate to any application. Older material is fine — voice changes slowly.');
  if (!answer?.text?.trim()) return;

  const id = `${slug(answer.title) || 'sample'}-${Date.now().toString(36)}`;
  await api(`/voice/samples/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ title: answer.title || 'Untitled', kind: answer.kind, text: answer.text }),
  });
  setStatus('Sample added');
  loadVoice();
}

async function editSample(sample) {
  const answer = await form(sample.title, [
    { name: 'title', label: 'What is it?', value: sample.title },
    {
      name: 'kind',
      label: 'Kind',
      type: 'select',
      value: sample.kind,
      options: SAMPLE_KINDS.map((k) => ({ value: k.value, label: k.label })),
    },
    { name: 'text', label: 'Text', value: sample.text, multiline: true, tall: true },
  ]);
  if (!answer?.text?.trim()) return;
  await api(`/voice/samples/${encodeURIComponent(sample.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ ...sample, ...answer }),
  });
  setStatus('Sample saved');
  loadVoice();
}

/* ------------------------------------------------------------------ *
 * Settings                                                            *
 * ------------------------------------------------------------------ */

/**
 * Presets carry each CLI's own confinement flags as well as its invocation.
 *
 * Every one of these tasks is pure text — the prompt already contains
 * everything to reason about — so the agent is given no tools and no writable
 * directory. The server additionally runs the child in an empty scratch
 * directory, so even a CLI with no flags of its own cannot reach your files;
 * these flags are the second lock, not the only one.
 */
/**
 * The CLIs this knows how to drive. Fetched rather than hard-coded here: they
 * are a fact about external programs, and a preset fixed on the server
 * but not in this file is how a config ends up broken.
 */
let AI_PRESETS = [];
const CUSTOM_PRESET = { label: 'Custom…', command: '', args: [], note: '' };

async function loadAiPresets() {
  if (AI_PRESETS.length > 0) return AI_PRESETS;
  const { presets } = await api('/ai/presets').catch(() => ({ presets: [] }));
  AI_PRESETS = [...presets, CUSTOM_PRESET];
  return AI_PRESETS;
}

/** Where the store lives, and whether it is backed up anywhere. */
async function loadProjectSettings() {
  const [info, config] = await Promise.all([api('/config/store'), api('/config')]);
  const box = $('#project-settings');
  const autoCommit = el('input', { type: 'checkbox', checked: config.git.autoCommit, disabled: config.overrides.autoCommit });
  autoCommit.onchange = async () => {
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify({ git: { autoCommit: autoCommit.checked } }) });
      state.store.config.git.autoCommit = autoCommit.checked;
      setStatus('Save history setting saved');
    } catch (error) { autoCommit.checked = !autoCommit.checked; setStatus(error.message, true); }
  };

  const remote = el('input', {
    type: 'text',
    value: info.remote.url ?? '',
    placeholder: 'git@github.com:you/my-resume-save.git',
  });
  const result = el('div', {
    className: 'result idle',
    textContent: info.remote.url
      ? describeRemote(info.remote)
      : 'Local only. Nothing leaves this machine.',
  });

  const setResult = (text, kind = 'idle') => {
    result.className = `result ${kind}`;
    result.textContent = text;
  };

  const pending = info.pending ?? [];
  const unsaved = el('div', {
    className: pending.length > 0 ? 'result idle' : 'result ok',
    textContent:
      pending.length > 0
        ? `${plural(pending.length, 'file')} changed since the last save: ${pending
            .slice(0, 4)
            .map((f) => f.path)
            .join(', ')}${pending.length > 4 ? '…' : ''}`
        : 'Everything is saved.',
  });

  setChildren(
    box,
    el('label', { className: 'row' }, [autoCommit, el('span', { textContent: 'Automatically Save History' })]),
    config.overrides.autoCommit ? el('p', { className: 'hint', textContent: 'Automatic history is disabled by the launch settings.' }) : null,
    el('div', {
      className: 'hint',
      style: 'margin-bottom:12px',
      textContent: info.isRepo
        ? `Its own git repository, ${plural(info.commits, 'commit')} so far.`
        : 'Not a git repository yet — it becomes one the first time you save.',
    }),

    // Edits made here are committed as they happen; this is for everything
    // else — YAML edited by hand, or auto-commit switched off.
    el('div', { className: 'row' }, [
      el('button', {
        className: 'primary',
        textContent: 'Save History',
        onclick: async () => {
          unsaved.className = 'result idle';
          unsaved.textContent = 'Saving…';
          try {
            const res = await api('/store/save', { method: 'POST', body: JSON.stringify({}) });
            unsaved.className = 'result ok';
            unsaved.textContent = res.saved
              ? `Saved ${plural(res.files.length, 'file')} — ${res.message}`
              : 'Everything was already saved.';
            setStatus(res.saved ? 'Saved to git' : 'Already saved');
            loadProjectSettings().catch(() => {});
          } catch (err) {
            unsaved.className = 'result bad';
            unsaved.textContent = err.message;
          }
        },
      }),
      el('span', {
        className: 'hint',
        textContent: 'Edits made here are committed as you make them. This catches anything else.',
      }),
    ]),
    unsaved,
    el('label', { className: 'f' }, [
      el('div', { className: 'lbl', textContent: 'Backup Remote (Optional)' }),
      remote,
      el('div', {
        className: 'hint',
        textContent: 'Create an empty private repository on GitHub, then paste its url here.',
      }),
    ]),
    el('div', { className: 'row' }, [
      el('button', {
        textContent: 'Save Remote',
        onclick: async () => {
          try {
            const status = await api('/config/store/remote', {
              method: 'PUT',
              body: JSON.stringify({ url: remote.value.trim() }),
            });
            setResult(status.url ? describeRemote(status) : 'Remote removed. The save is local only.', 'ok');
          } catch (err) {
            setResult(err.message, 'bad');
          }
        },
      }),
      el('button', {
        className: 'primary',
        textContent: 'Push Backup',
        disabled: !info.remote.url,
        onclick: async () => {
          setResult('Pushing…');
          try {
            const res = await api('/config/store/push', { method: 'POST' });
            setResult(res.output, res.ok ? 'ok' : 'bad');
          } catch (err) {
            setResult(err.message, 'bad');
          }
        },
      }),
    ]),
    result,
  );
}

function describeRemote(remote) {
  if (!remote.tracked) return `${remote.url} — never pushed.`;
  if (remote.ahead === 0 && remote.behind === 0) return `${remote.url} — up to date.`;
  const bits = [];
  if (remote.ahead) bits.push(`${plural(remote.ahead, 'commit')} to push`);
  if (remote.behind) bits.push(`${plural(remote.behind, 'commit')} behind`);
  return `${remote.url} — ${bits.join(', ')}.`;
}

async function loadSettings() {
  const config = await api('/config');
  const box = $('#settings');

  const field = (labelText, input, note) =>
    el('label', { className: 'f' }, [
      el('div', { className: 'lbl', textContent: labelText }),
      input,
      note ? el('div', { className: 'hint', textContent: note }) : null,
    ]);

  await loadAiPresets();

  /*
   * The one switch that matters takes effect the moment it is flipped.
   *
   * It used to need the Save button below it, like the command and the
   * arguments — so ticking it and walking away left the AI off, with nothing
   * saying so. The command needs saving because a half-typed command is not a
   * command; a checkbox is never half-ticked.
   */
  const enabled = el('input', { type: 'checkbox', checked: config.ai.enabled });
  const aiState = el('span', { className: 'chip' });

  const showAiState = (on) => {
    aiState.textContent = on ? `On — ${config.ai.command || 'no command set'}` : 'Off';
    aiState.className = `chip ai-state ${on ? 'on' : 'off'}`;
  };
  showAiState(config.ai.enabled);

  /*
   * Looking things up is its own decision, not part of "use the AI".
   * Everything else here runs against text the user supplied; this is the one
   * setting that lets the model go and read something they did not choose.
   */
  const research = el('input', { type: 'checkbox', checked: Boolean(config.ai.research) });
  research.onchange = async () => {
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify({ ai: { research: research.checked } }) });
      setStatus(
        research.checked
          ? 'The AI may look up the company while it writes'
          : 'The AI works only from what you gave it',
      );
      loadSettings();
    } catch (err) {
      research.checked = !research.checked;
      setStatus(err.message, true);
    }
  };

  enabled.onchange = async () => {
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify({ ai: { enabled: enabled.checked } }) });
      showAiState(enabled.checked);
      setStatus(enabled.checked ? 'AI on — it will run your command' : 'AI off — every action hands you the prompt');
    } catch (err) {
      enabled.checked = !enabled.checked;
      setStatus(err.message, true);
    }
  };
  const command = el('input', { type: 'text', value: config.ai.command });
  const args = el('input', { type: 'text', value: (config.ai.args ?? []).join(' ') });
  const timeout = el('input', { type: 'text', value: String(Math.round(config.ai.timeoutMs / 1000)) });

  const preset = el('select');
  for (const p of AI_PRESETS) preset.append(el('option', { value: p.label, textContent: p.label }));
  const matching = AI_PRESETS.find(
    (p) => p.label !== 'Custom…' && p.command === config.ai.command && p.args.join(' ') === (config.ai.args ?? []).join(' '),
  );
  preset.value = matching?.label ?? 'Custom…';
  const presetNote = el('div', { className: 'hint' });
  const showPresetNote = () => {
    presetNote.textContent = AI_PRESETS.find((p) => p.label === preset.value)?.note ?? '';
  };
  showPresetNote();

  preset.onchange = () => {
    const chosen = AI_PRESETS.find((p) => p.label === preset.value);
    showPresetNote();
    if (!chosen || chosen.label === 'Custom…') return;
    command.value = chosen.command;
    args.value = chosen.args.join(' ');
  };

  const engine = el('select');
  for (const e of ['', 'tectonic', 'latexmk', 'pdflatex']) {
    engine.append(
      el('option', { value: e, textContent: e || 'Auto-detect', selected: (config.latex.engine ?? '') === e }),
    );
  }

  const result = el('div', { className: 'result idle', textContent: 'Not tested yet.' });

  const save = async () => {
    const seconds = Number(timeout.value);
    await api('/config', {
      method: 'PUT',
      body: JSON.stringify({
        ai: {
          enabled: enabled.checked,
          command: command.value.trim(),
          // The template is whitespace-separated; `{prompt}` becomes the path
          // to a file holding the prompt, `{promptText}` the prompt itself.
          args: args.value.split(/\s+/).filter(Boolean),
          timeoutMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 180_000,
        },
        latex: { engine: engine.value || undefined },
      }),
    });
    setStatus('Settings saved');
  };

  setChildren(
    box,
    el('div', { className: 'ai-switch' }, [
      el('label', { className: 'check' }, [enabled, el('span', {}, 'Let the tool run the AI command')]),
      aiState,
    ]),
    el('label', { className: 'check', style: 'margin-bottom:6px' }, [
      research,
      el('span', {}, 'Let it look up the company online'),
    ]),
    el('div', { className: 'hint', style: 'margin-bottom:12px' },
      config.ai.research
        ? 'It may read about the company before writing. What it finds can shape which of your experience is worth raising — it never becomes a claim about you. Your files stay out of reach either way.'
        : 'Off: it works only from the posting and what you have written. A letter that knows what the team actually ships reads differently from one that knows only the advertisement.'),
    config.overrides.ai
      ? el('div', { className: 'override', textContent: 'RMM_AI=0 is set, so the AI stays off whatever this says.' })
      : null,
    field('Preset', preset),
    presetNote,
    field('Command', command, 'Must be on your PATH.'),
    field(
      'Arguments',
      args,
      '{prompt} is a file holding the prompt, {promptText} inlines it, {sandbox} is the scratch directory.',
    ),
    el('div', { className: 'sandbox-note' }, [
      el('b', {}, 'Confined to a scratch directory. '),
      'The command runs in an empty temporary folder containing only the prompt — never your save folder, ' +
        'your home directory, or this source tree. The presets add each CLI’s own read-only flags on top.',
    ]),
    field('Timeout, seconds', timeout),
    field('LaTeX engine', engine, 'Auto-detect tries tectonic, then latexmk, then pdflatex.'),
    el('div', { className: 'row' }, [
      el('button', { className: 'primary', textContent: 'Save', onclick: () => save().catch((e) => setStatus(e.message, true)) }),
      el('button', {
        textContent: 'Save and test',
        onclick: async () => {
          try {
            await save();
            result.className = 'result idle';
            result.textContent = 'Running…';
            const test = await api('/config/test-ai', { method: 'POST' });
            if (test.ok) {
              result.className = 'result ok';
              result.textContent = `${test.command} replied in ${(test.ms / 1000).toFixed(1)}s: ${test.output.slice(0, 160)}`;
            } else {
              result.className = 'result bad';
              result.textContent = test.message;
            }
          } catch (err) {
            result.className = 'result bad';
            result.textContent = err.message;
          }
        },
      }),
    ]),
    result,
  );
}

/* ------------------------------------------------------------------ *
 * History                                                             *
 * ------------------------------------------------------------------ */

let selectedCommit = null;
let historyResumeId = null;

/**
 * The friendly, Google-Docs-style view: every version *this one resume* has
 * been, not a flat log of every commit the whole store ever made. Raw git
 * history stays reachable behind a toggle for anyone who wants it, but it is
 * not the thing you land on.
 */
async function loadResumeHistory() {
  const select = $('#history-resume');
  select.replaceChildren(
    ...state.store.resumes.map((r) =>
      el('option', { value: r.id, textContent: r.label, selected: r.id === historyResumeId }),
    ),
  );
  if (!historyResumeId || !state.store.resumes.some((r) => r.id === historyResumeId)) {
    historyResumeId = state.resumeId ?? state.store.resumes[0]?.id ?? null;
  }
  select.value = historyResumeId;

  const timeline = $('#resume-timeline');
  if (!historyResumeId) {
    timeline.replaceChildren(el('div', { className: 'empty', textContent: 'No resumes yet.' }));
    return;
  }

  timeline.replaceChildren(skeleton('versions', 4));
  try {
    const { versions } = await api(`/resumes/${encodeURIComponent(historyResumeId)}/history`);
    renderResumeTimeline(versions);
  } catch (err) {
    timeline.replaceChildren(el('div', { className: 'err', textContent: err.message }));
  }
}


/**
 * A placeholder shaped like the thing being fetched.
 *
 * "Loading…" in the middle of an empty page tells you only that nothing is
 * there. Rebuilding a long version history takes a second or two the first
 * time, and a few grey rows in the shape of the list say what is coming and
 * roughly how much of it — which is the question you are actually asking
 * while you wait.
 */
function skeleton(kind, rows = 3) {
  return el(
    'div',
    { className: `skeleton ${kind}`, 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: rows }, () =>
      el('div', { className: 'sk-row' }, [
        el('span', { className: 'sk-line wide' }),
        el('span', { className: 'sk-line' }),
      ]),
    ),
  );
}

/**
 * One change, as a reader of the resume would see it: what it used to say
 * struck through, what it says now beneath. The server sends the full before
 * and after text, so nothing here has to guess or re-truncate.
 */
function changeRow(c) {
  const where = c.where ? el('span', { className: 'c-where', textContent: c.where }) : null;
  // `text` is a self-contained sentence, so it names the place it happened —
  // and the place is already the label beside it.
  const detail = c.where && c.text?.startsWith(`${c.where}: `) ? c.text.slice(c.where.length + 2) : c.text;

  if (c.from && c.to) {
    return el('div', { className: `c ${c.kind}` }, [
      where,
      el('div', { className: 'c-diff' }, [
        el('del', { textContent: c.from }),
        el('ins', { textContent: c.to }),
      ]),
    ]);
  }
  if (c.kind === 'added' && c.to) {
    return el('div', { className: 'c added' }, [where, el('div', { className: 'c-diff' }, [el('ins', { textContent: c.to })])]);
  }
  if (c.kind === 'removed' && c.from) {
    return el('div', { className: 'c removed' }, [where, el('div', { className: 'c-diff' }, [el('del', { textContent: c.from })])]);
  }
  return el('div', { className: `c ${c.kind}` }, [where, el('span', { className: 'c-plain', textContent: detail })]);
}

function renderResumeTimeline(versions) {
  const timeline = $('#resume-timeline');
  if (versions.length === 0) {
    timeline.replaceChildren(
      el('div', { className: 'empty' }, [
        el('b', {}, 'No history yet'),
        'Save an edit to this resume and its versions will show up here.',
      ]),
    );
    return;
  }

  // The API already returns newest first, so the current version reads like
  // the top of a document history — the same order Google Docs uses.
  timeline.replaceChildren(
    ...versions.map((v, i) => {
      const isCurrent = i === 0;
      const changes = (v.changes ?? []).filter((c) => c.kind !== 'none');
      return el('div', { className: `version-card${isCurrent ? ' current' : ''}` }, [
        el('div', { className: 'vhead' }, [
          el('span', { className: 'dot' }),
          el('span', { className: 'when', textContent: formatWhen(v.date) }),
          el('span', { className: 'rel', textContent: new Date(v.date).toLocaleString() }),
          isCurrent ? el('span', { className: 'badge done', textContent: 'Current' }) : null,
          el('span', { className: 'grow' }),
        ]),
        el(
          'div',
          { className: 'changes' },
          changes.length > 0
            ? changes.map(changeRow)
            : [el('div', { className: 'c', textContent: v.message || 'Edited' })],
        ),
        el('div', { className: 'actions-row' }, [
          isCurrent
            ? null
            : el('button', {
                className: 'tiny',
                textContent: 'Restore this version',
                onclick: () => restoreResumeVersion(v.hash),
              }),
        ]),
      ]);
    }),
  );
}

async function restoreResumeVersion(hash) {
  if (!historyResumeId) return;
  if (!confirm('Restore this version? The current version will be replaced (its own history is kept, so you can still get back to it).')) {
    return;
  }
  try {
    await api(`/resumes/${encodeURIComponent(historyResumeId)}/history/${encodeURIComponent(hash)}/restore`, {
      method: 'POST',
    });
    setStatus('Restored.');
    await loadStore();
    if (historyResumeId === state.resumeId) {
      clearEdits();
      render();
      scheduleRender();
    }
    await loadResumeHistory();
  } catch (err) {
    setStatus(err.message, true);
  }
}

function setupHistoryTab() {
  $('#history-resume').onchange = (e) => {
    historyResumeId = e.target.value;
    loadResumeHistory().catch((err) => setStatus(err.message, true));
  };
  $('#btn-raw-history').onclick = () => {
    const showingRaw = $('#raw-history').style.display !== 'none';
    $('#raw-history').style.display = showingRaw ? 'none' : '';
    $('#resume-timeline').style.display = showingRaw ? '' : 'none';
    $('#history-resume').closest('.toolbar').querySelector('.hint').style.display = showingRaw ? '' : 'none';
    $('#btn-raw-history').textContent = showingRaw ? 'Show raw git log instead' : 'Show this resume’s timeline instead';
    if (!showingRaw) loadHistory().catch((err) => setStatus(err.message, true));
  };
}

async function loadHistory() {
  const { commits } = await api('/history?limit=80');
  const list = $('#commits');

  if (commits.length === 0) {
    list.replaceChildren(
      el('div', { className: 'empty' }, [
        el('b', {}, 'No history yet'),
        'The save is not a Git repository, or nothing has been committed. Run ',
        el('code', {}, 'rmm serve'),
        ' once and it will be initialised.',
      ]),
    );
    return;
  }

  list.replaceChildren(
    ...commits.map((c) =>
      el(
        'div',
        {
          className: `commit${c.hash === selectedCommit ? ' selected' : ''}`,
          onclick: () => showCommit(c.hash),
        },
        [
          el('div', { className: 'msg', textContent: c.message }),
          el('div', {
            className: 'meta',
            textContent: `${c.hash.slice(0, 8)} · ${formatWhen(c.date)}`,
          }),
        ],
      ),
    ),
  );
}

/** Dates in a history are read as "how long ago", not as timestamps. */
function formatWhen(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${plural(mins, 'minute')} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${plural(days, 'day')} ago`;
  return new Date(then).toISOString().slice(0, 10);
}

async function showCommit(hash) {
  selectedCommit = hash;
  const panel = $('#commit-detail');
  panel.replaceChildren(skeleton('detail', 3));
  await loadHistory();

  try {
    const c = await api(`/history/${encodeURIComponent(hash)}`);
    setChildren(
      panel,
      el('h3', { textContent: c.message }),
      el('div', {
        className: 'sub',
        textContent: `${c.hash.slice(0, 10)} · ${c.author} · ${formatWhen(c.date)}`,
      }),
      c.body ? el('p', { className: 'hint commit-body', textContent: c.body }) : null,
      ...c.files.map((f) =>
        el('div', { className: 'file-row' }, [
          el('span', { className: 'add', textContent: f.added === null ? '—' : `+${f.added}` }),
          el('span', { className: 'del', textContent: f.removed === null ? '—' : `−${f.removed}` }),
          el('span', { textContent: f.path }),
        ]),
      ),
      renderDiff(c.diff),
    );
  } catch (err) {
    panel.replaceChildren(el('div', { className: 'err', textContent: err.message }));
  }
}

/** A unified diff, coloured. Reading a patch as flat text is unpleasant. */
function renderDiff(diff) {
  if (!diff?.trim()) return el('p', { className: 'hint', textContent: 'No textual changes.' });

  const pre = el('pre');
  for (const line of diff.split('\n')) {
    let cls = '';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (/^(diff |index |\+\+\+ |--- |new file|deleted file|similarity|rename )/.test(line)) cls = 'meta';
    pre.append(el('div', { className: `line ${cls}`.trim(), textContent: line || ' ' }));
  }
  return el('div', { className: 'diff' }, [pre]);
}

/* ------------------------------------------------------------------ *
 * Modals                                                              *
 * ------------------------------------------------------------------ */

function showModal(title, content, { note = '', okLabel = 'Close', showCancel = false } = {}) {
  $('#modal-title').textContent = title;
  $('#modal-content').replaceChildren(content);
  $('#modal-note').textContent = note;
  $('#modal-cancel').style.display = showCancel ? '' : 'none';
  $('#modal-ok').textContent = okLabel;
  $('#modal').classList.remove('hidden');
  return new Promise((resolve) => {
    $('#modal-ok').onclick = () => {
      $('#modal').classList.add('hidden');
      resolve(true);
    };
    $('#modal-cancel').onclick = () => {
      $('#modal').classList.add('hidden');
      resolve(false);
    };
  });
}

function confirmModal(title, body) {
  return showModal(title, el('p', { textContent: body }), { okLabel: 'Delete', showCancel: true });
}

/** A multi-field form modal. `prompt()` can only ask for one thing. */
function form(title, fields, note) {
  return new Promise((resolve) => {
    const inputs = {};
    const content = el('div');

    for (const f of fields) {
      if (f.type === 'checkbox') {
        const cb = el('input', { type: 'checkbox', checked: Boolean(f.value), id: `f_${f.name}` });
        inputs[f.name] = { get: () => cb.checked };
        content.append(
          el('label', { className: 'form-label', style: 'display:flex;gap:7px;align-items:center;cursor:pointer' }, [
            cb,
            f.label,
          ]),
        );
        continue;
      }
      content.append(el('div', { className: 'form-label', textContent: f.label }));

      if (f.type === 'select') {
        const sel = el('select', { style: 'width:100%' });
        for (const o of f.options) {
          sel.append(
            el('option', {
              value: o.value ?? o,
              textContent: o.label ?? o,
              selected: (o.value ?? o) === f.value,
            }),
          );
        }
        inputs[f.name] = { get: () => sel.value };
        content.append(sel);
        continue;
      }

      const input = f.multiline
        ? el('textarea', { value: f.value ?? '', style: f.tall ? 'min-height:220px' : '' })
        : el('input', { type: 'text', value: f.value ?? '' });
      if (f.disabled) {
        input.disabled = true;
        input.title = 'This field has alternates — edit it through its dropdown.';
      }
      inputs[f.name] = { get: () => input.value };
      content.append(input);
    }

    $('#modal-title').textContent = title;
    $('#modal-content').replaceChildren(content);
    $('#modal-note').textContent = note ?? '';
    $('#modal-cancel').style.display = '';
    $('#modal-ok').textContent = 'Save';
    $('#modal').classList.remove('hidden');

    // Focus the first editable field so the form is usable from the keyboard.
    const first = content.querySelector('input[type=text], textarea');
    if (first) setTimeout(() => first.focus(), 0);

    const close = (value) => {
      $('#modal').classList.add('hidden');
      resolve(value);
    };
    $('#modal-ok').onclick = () =>
      close(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.get()])));
    $('#modal-cancel').onclick = () => close(null);
  });
}

/* ------------------------------------------------------------------ *
 * Boot                                                                *
 * ------------------------------------------------------------------ */

function render() {
  const select = $('#resume-select');
  const option = (r) => el('option', { value: r.id, textContent: r.label, selected: r.id === state.resumeId });

  // Bases in their own group. A store fills up with resumes tailored for one
  // posting each; the two or three you actually build from should not have to
  // be found among them.
  const bases = state.store.resumes.filter((r) => r.base);
  const rest = state.store.resumes.filter((r) => !r.base);
  select.replaceChildren(
    el('option', { value: '__master__', textContent: 'Master Document — All Source Content' }),
    ...(bases.length > 0
      ? [
          el('optgroup', { label: 'Bases' }, bases.map(option)),
          rest.length > 0 ? el('optgroup', { label: 'Variations' }, rest.map(option)) : null,
        ].filter(Boolean)
      : state.store.resumes.map(option)),
  );
  select.value = state.masterView ? '__master__' : state.resumeId;
  drawWayBack();
  $('#btn-base').hidden = state.masterView;
  $('#btn-save-as').hidden = state.masterView;
  $('#btn-feedback').textContent = state.masterView ? 'Master Feedback' : 'Resume Feedback';
  $('#resume-view-note').textContent = state.masterView
    ? 'All source entries and phrasings. Edits here update every tailored resume that uses them.'
    : 'Select source content for this resume. Shared wording edits also update the master and other resumes that use it.';
  renderBaseButton();
  renderEditor();
}

/** The pin itself: what this resume is, and the one click that changes it. */
function renderBaseButton() {
  const btn = $('#btn-base');
  if (!btn) return;
  const spec = state.store.resumes.find((r) => r.id === state.resumeId);
  const pinned = Boolean(spec?.base);

  btn.textContent = pinned ? '★ Base' : '☆ Pin as base';
  btn.className = pinned ? 'tiny pinned' : 'tiny';
  btn.title = pinned
    ? 'New resumes and tailored drafts start from this one. Click to unpin.'
    : 'Pin this as a starting point for new resumes and tailored drafts';
  btn.disabled = !spec;
  btn.onclick = async () => {
    try {
      await api(`/resumes/${encodeURIComponent(state.resumeId)}/base`, {
        method: 'PUT',
        body: JSON.stringify({ base: !pinned }),
      });
      await loadStore();
      setStatus(pinned ? 'No longer a base' : 'Pinned as a base');
      render();
    } catch (err) {
      setStatus(err.message, true);
    }
  };
}

async function loadStore() {
  state.store = await api('/store');
  if (!state.resumeId || !state.store.resumes.some((r) => r.id === state.resumeId)) {
    // A pinned base is what this store says it starts from; the old
    // conventional id is only the guess for a store that has never said.
    const resumes = state.store.resumes;
    state.resumeId =
      resumes.find((r) => r.base)?.id ??
      resumes.find((r) => r.id === 'newgrad')?.id ??
      resumes.find((r) => !r.extends)?.id ??
      resumes[0]?.id ??
      null;
  }
  if (!state.resumeId) state.masterView = true;
}

/**
 * The way back to the application that sent you here.
 *
 * Named, because "back to the Workspace" would leave you looking for which of
 * eleven drafts you had open. You came from one posting; the button says which,
 * and returns to it rather than to a list.
 */
function drawWayBack() {
  const bar = $('#way-back');
  if (!bar) return;
  const draft = state.fromDraft;
  bar.hidden = !state.fromDraftId;
  if (!state.fromDraftId) return;

  const where = draft ? `${draft.role} — ${draft.company}` : 'the application you came from';
  bar.replaceChildren(
    el('button', {
      className: 'tiny',
      textContent: `← Back to ${where}`,
      title: 'Return to the application you were working on',
      onclick: () => {
        location.hash = `#workspace/${encodeURIComponent(state.fromDraftId)}`;
      },
    }),
    el('span', {
      className: 'faint',
      textContent: 'This resume is the one that application will send.',
    }),
  );
}

/**
 * Look up the application named in the hash, for the label on the way back.
 *
 * Quietly forgotten if it has gone — completed, or discarded from another
 * window — because a dead trail back should just not be offered, rather than
 * being an error about a thing the user never asked for.
 */
async function loadFromDraft() {
  const id = state.fromDraftId;
  try {
    const draft = await api(`/workspace/${encodeURIComponent(id)}`);
    if (state.fromDraftId !== id) return;
    state.fromDraft = draft;
  } catch {
    if (state.fromDraftId === id) {
      state.fromDraftId = null;
      state.fromDraft = null;
    }
  }
  render();
}

/** Switch tabs programmatically, so a deep link lands in the right place. */
function showTab(name) {
  const btn = document.querySelector(`#tabs button[data-tab="${name}"]`);
  if (btn) btn.click();
}

/**
 * `#workspace/<id>` opens that draft. The extension links here, so a posting
 * that wants an essay moves from the browser to the editor in one click.
 */
async function applyHash() {
  const draft = /^#workspace\/(.+)$/.exec(location.hash);
  if (draft) {
    showTab('workspace');
    await openDraft(decodeURIComponent(draft[1]));
    return true;
  }

  /*
   * `#resumes/<id>` opens the builder on one resume, and the optional
   * `/from/<draftId>` remembers which application sent you there.
   *
   * In the hash rather than in a variable, because the way back has to survive
   * a reload: you go to the builder to make the decisions, spend twenty
   * minutes there, refresh, and the trail back to the posting you were
   * answering should not be the thing that goes missing.
   */
  const build = /^#resumes\/([^/]+)(?:\/from\/(.+))?$/.exec(location.hash);
  if (build) {
    const wanted = decodeURIComponent(build[1]);
    state.fromDraftId = build[2] ? decodeURIComponent(build[2]) : null;
    state.fromDraft = null;
    showTab('resumes');
    if (state.store.resumes.some((r) => r.id === wanted)) {
      state.masterView = false;
      state.resumeId = wanted;
      clearEdits();
    } else {
      setStatus(`No resume "${wanted}" — it may have been deleted.`, true);
    }
    if (state.fromDraftId) loadFromDraft().catch(() => undefined);
    render();
    scheduleRender();
    return true;
  }

  // A bare `#voice` or `#applications` opens that tab. The extension links
  // here when it needs to send someone to a setting, and a link that lands on
  // the wrong tab is worse than no link.
  const requestedTab = /^#([a-z]+)$/.exec(location.hash)?.[1];
  const tab = ['assets', 'project'].includes(requestedTab) ? 'save'
    : ['build', 'master'].includes(requestedTab) ? 'resumes' : requestedTab;
  if (requestedTab === 'master' || requestedTab === 'build') {
    state.masterView = requestedTab === 'master' || !state.resumeId;
    render();
    scheduleRender();
  }
  if (tab && document.querySelector(`#tabs button[data-tab="${tab}"]`)) {
    showTab(tab);
    return true;
  }
  return false;
}

function setupTabs() {
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.onclick = () => {
      for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b === btn);
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`);
      if (btn.dataset.tab === 'resumes') scheduleRender();
      if (btn.dataset.tab === 'save') assetUI.load().catch((e) => setStatus(e.message, true));
      if (btn.dataset.tab === 'workspace') loadDrafts().catch((e) => setStatus(e.message, true));
      if (btn.dataset.tab === 'applications') loadApplications().catch((e) => setStatus(e.message, true));
      if (btn.dataset.tab === 'letters') loadLetters().catch((e) => setStatus(e.message, true));
      if (btn.dataset.tab === 'history') {
        loadResumeHistory().catch((e) => setStatus(e.message, true));
        if ($('#raw-history').style.display !== 'none') loadHistory().catch((e) => setStatus(e.message, true));
      }
      if (btn.dataset.tab === 'voice') {
        loadVoice().catch((e) => setStatus(e.message, true));
        loadSettings().catch((e) => setStatus(e.message, true));
      }
    };
  }
}

async function boot() {
  $('#feedback-close').onclick = () => { $('#feedback-panel').hidden = true; };
  $('#feedback-select').onchange = event => {
    const job = feedbackJobs.find(item => item.id === event.target.value);
    if (job) openJob(job);
  };
  assetUI = setupAssets({ api, el, setChildren, readAsBase64, flushEdits, isDirty: () => state.dirty,
    reloadStore: async () => { await loadStore(); render(); }, entryName, status: setStatus,
    projectChanged: dir => { activeProject = dir; }, loadProjectSettings });
  setupTabs();
  const project = await assetUI.init();
  if (!project.current) { showTab('save'); return; }
  setupHistoryTab();
  await loadStore();
  render();

  // A deep link means the user came here to write, not to look at a resume;
  // skip the compile they did not ask for.
  const deepLinked = await applyHash().catch(() => false);
  if (!deepLinked) showTab('resumes');
  window.addEventListener('hashchange', () => applyHash().catch(() => {}));

  $('#resume-select').onchange = async (e) => {
    const next = e.target.value;
    // Save what is on screen before leaving it: clearEdits() is about to throw
    // the unsaved overlay away.
    await flushEdits();
    if (state.dirty) { e.target.value = state.masterView ? '__master__' : state.resumeId; return; }
    clearTimeout(renderTimer);
    renderToken++;
    state.masterView = next === '__master__';
    if (!state.masterView) state.resumeId = next;
    clearEdits();
    setSaveState('saved');
    render();
    scheduleRender();
  };

  // Leaving the page: write and commit on the way out. `visibilitychange` is
  // the event that actually fires when a tab is closed or hidden; `unload`
  // does not, reliably.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushEdits().catch(() => {});
  });
  // The preview keeps itself current; this is only for the rare "recompile it
  // anyway" — after changing the LaTeX engine, say.
  $('#live-state').onclick = renderPreview;
  $('#btn-save-as').onclick = saveAsVariation;
  $('#btn-feedback').onclick = () => askFeedback(state.masterView);
  $('#btn-rebuild').onclick = renderPreview;
  $('#btn-add-entry').onclick = async () => {
    const answer = await form('Add an entry', [
      {
        name: 'kind',
        label: 'Which section?',
        type: 'select',
        value: 'experience',
        options: [
          { value: 'experience', label: 'Experience — a job, co-op, or internship' },
          { value: 'project', label: 'Project' },
          { value: 'education', label: 'Education' },
          { value: 'custom', label: 'Additional' },
        ],
      },
    ]);
    if (answer?.kind) addEntry(answer.kind);
  };
  // Anything the AI was still doing when the tab was closed is picked up here.
  refreshJobs().catch(() => {});

  $('#btn-add-app').onclick = addApplication;
  $('#btn-new-draft').onclick = () => newDraft().catch((e) => setStatus(e.message, true));
  // The extension writes drafts from another tab, so there is something to
  // refresh to — this list is not only changed from here.
  $('#btn-refresh-drafts').onclick = async () => {
    try {
      await loadDrafts();
      setStatus('Up to date');
    } catch (e) {
      setStatus(e.message, true);
    }
  };
  $('#btn-add-letter').onclick = addLetter;
  $('#btn-add-answer').onclick = addAnswer;
  $('#btn-add-sample').onclick = () => addSample().catch((e) => setStatus(e.message, true));
  wireVoiceDrop();
  $('#btn-save-voice').onclick = async () => {
    await api('/voice', { method: 'PUT', body: JSON.stringify({ voice: $('#voice').value }) });
    setStatus('Notes saved');
    loadVoice();
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) $('#modal-cancel').click();
  });
}

boot().catch((err) => setStatus(err.message, true));
