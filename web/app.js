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
import { createHistory, docKeyFor, readDoc, restoreRequest } from './undo.js';
import { renderFeedbackMarkdown } from './feedback.js';
import { rebase, same } from './rebase.js';
import { moveBefore, moveBy, orderEntryIds } from './reorder.js';
import { DEFAULT_STYLE, endsBeforeItStarts, formatPeriod, inferStyle, parsePeriod } from './dates.js';
import { bulletsAreHandOrdered, orderedBullets } from './sections.js';
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

/**
 * A text field that waits for a Save button, and survives its panel being
 * rebuilt around it.
 *
 * Most of this editor saves as you go, and the handful of fields that do not
 * are the ones a reload can silently destroy — the AI command, its arguments,
 * the timeout, the git remote. Each of those lives in a panel that is
 * rebuilt wholesale from the server whenever it is shown, or whenever a
 * button elsewhere in it finishes: press "Save History" and the remote URL
 * you were halfway through typing is replaced by the empty one on disk.
 *
 * Half-typed is exactly the state worth keeping. The reason these fields wait
 * for a button is that a half-typed command should not be *run*, which is not
 * an argument for deleting it.
 *
 * So the new field looks for the one it is replacing, and keeps what is in it
 * when that differs from what the store last supplied. A field nobody has
 * touched still refreshes, or a change made in another window would never
 * arrive here.
 */
function keptField(name, stored, props = {}) {
  return keepsValue(el('input', { type: 'text', ...props, value: stored }), name, stored);
}

/**
 * The same rescue, for a control that is not a text box.
 *
 * Everything above is written about typing, and the AI panel has two controls
 * that wait for the same Save button without any typing in them: the effort
 * slider and the LaTeX engine picker. They were built fresh each time and so
 * were not covered — drag the slider to Thorough, glance at another tab, come
 * back, and it is on "As it comes" again with the "Not saved yet." warning
 * gone with it, because the warning is computed from the control that no
 * longer holds the change.
 *
 * That is the worse half. A command that reverts is at least visible: it is a
 * line of text you wrote and can see is not there. A slider that has slid back
 * one notch looks exactly like a slider you never touched, and the setting it
 * governs is one whose effect you would not notice for another three minutes.
 *
 * `value` is the whole interface a range input and a select have in common
 * with a text box, and it is all this needs. The caller passes what the store
 * said in the same units the control reads — the index for the slider, the
 * engine name for the select.
 */
function keepsValue(input, name, stored) {
  const previous = document.querySelector(`[data-keeps="${name}"]`);
  if (previous != null && previous.value !== previous.dataset.stored) input.value = previous.value;
  input.dataset.keeps = name;
  input.dataset.stored = stored;
  return input;
}

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

/**
 * Which tier comes first, wherever resumes are listed or stepped through.
 *
 * One list because two would drift: the dropdown draws them in this order and
 * `deleteVariation` steps to the neighbour in it, and a delete that landed
 * somewhere other than the next line of the list you are looking at would
 * read as the editor losing its place.
 */
const TIER_ORDER = ['base', 'extended', 'temporary'];

/** A resume's tier, with the reading that never deletes anything: see tiers.ts. */
const tierOf = (r) => r.tier ?? 'extended';

/**
 * What the drafting buttons are actually drawing on, said beside them.
 *
 * The AI here does not write out of nothing, and it is not meant to sound
 * like an AI: it is handed the notes on how you write, the letters you have
 * already sent and the answers you have already given, and asked for one in
 * that voice. That is the entire reason the letter bank, the answer bank and
 * the writing notes exist — and it was said only in a tooltip, so the button
 * read as "have a machine write this", which is the thing people are right to
 * be wary of and the thing this does not do.
 *
 * Counted, because a count is checkable and a claim is not: "from the nine
 * letters you have sent" is something somebody can go and look at. And honest
 * when there is nothing to draw on yet, because a first letter with an empty
 * bank really is written from the posting and the notes alone, and saying
 * otherwise would be the one thing worse than saying nothing.
 */
function draftedFrom(kind) {
  const bank = kind === 'letter' ? (state.store.coverLetters ?? []) : (state.store.answers ?? []);
  const samples = (state.store.samples ?? []).length;
  const notes = String(state.store.voice ?? '').trim().length > 0;
  const written = kind === 'letter' ? 'letter' : 'answer';

  const sources = [];
  if (bank.length > 0) sources.push(`the ${plural(bank.length, `${written} you have already written`, `${written}s you have already written`)}`);
  if (samples > 0) sources.push(plural(samples, 'writing sample'));
  if (notes) sources.push('your notes on how you write');

  if (sources.length === 0) {
    return (
      `Written in your voice — but there is nothing of yours to learn it from yet. ` +
      `Add a ${written} you have written, or say how you write, under Voice & AI.`
    );
  }
  const last = sources.pop();
  const from = sources.length > 0 ? `${sources.join(', ')} and ${last}` : last;
  return `Written in your voice, from ${from} — not from nothing.`;
}

/** Forget every unsaved edit — used when switching resumes. */
function clearEdits() {
  state.choices = {};
  state.skillEdits = null;
  state.entryEdits = null;
  state.bulletEdits = null;
  state.bulletOrderEdits = null;
  state.listEdits = null;
  state.collapsedEdits = null;
  state.orderEdits = null;
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
  /*
   * Undo is recorded here, and only here.
   *
   * Every editing action in this file ends as one write of one whole document,
   * so snapshotting the document either side of the write covers all of them —
   * deleting a group, adding one, adding a phrasing, renaming, reordering —
   * without a list of actions that goes stale the moment a button is added.
   */
  const docKey = undoing ? null : docKeyFor(path, options.method);
  const before = docKey ? readDoc(state.store, docKey) : null;

  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(activeProject ? { 'X-RMM-Project': activeProject } : {}), ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);

  /*
   * Recorded here, from the response, rather than from the store on the next
   * reload. Several actions update the client's copy in place and never
   * reload — and hanging the "after" snapshot on a reload that may not come
   * meant those actions were silently unundoable.
   *
   * The response is also the better snapshot: these routes hand back what was
   * actually saved, so a server that normalises or fills in defaults is
   * reflected, and a redo puts back what really happened.
   */
  if (docKey) {
    const isDelete = String(options.method ?? 'GET').toUpperCase() === 'DELETE';
    const after = isDelete ? null : documentFrom(body, options.body);
    if (openGroup) {
      // One user action, however many requests it takes. The group records the
      // lot as a single step once it finishes.
      if (!openGroup.before.has(docKey)) openGroup.before.set(docKey, before);
      openGroup.after.set(docKey, after);
    } else {
      history.record({ docKey, before, after, label: undoLabel });
      undoLabel = 'change';
      paintUndo();
    }
  }
  return body;
}

/**
 * What was saved, as best the reply tells us.
 *
 * Most document routes return the saved document; a couple return an
 * acknowledgement instead, and for those the body that was sent is the honest
 * answer.
 */
function documentFrom(reply, sentBody) {
  const acknowledgement = reply && typeof reply === 'object' && !Array.isArray(reply)
    && Object.keys(reply).length <= 2 && ('ok' in reply || 'key' in reply);
  if (reply !== undefined && reply !== null && !acknowledgement) return reply;
  try {
    return typeof sentBody === 'string' ? JSON.parse(sentBody) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Undo and redo                                                       *
 * ------------------------------------------------------------------ */

const history = createHistory({ limit: 60 });
/** True while an undo/redo is being applied, so it does not record itself. */
let undoing = false;

/**
 * The action currently being performed, when it is more than one request.
 *
 * A step of undo should be a thing the user did, and several of the editor's
 * actions are not one request: deleting an entry writes the entry and the
 * resume that referenced it; adding one writes the entry and the section that
 * lists it. Recorded per request those cost two presses each, and the state
 * between the presses is one no action ever produced — an entry that exists
 * with nothing pointing at it.
 *
 * `watch` is for the actions whose write is not a whole-document PUT at all.
 * Adding a phrasing is `POST …/variants`, which `docKeyFor` rightly ignores,
 * so it was simply not undoable: the only way back was to find the phrasing
 * and delete it. Naming the document it changes makes it a step like any
 * other, without this file having to know what the route does.
 */
let openGroup = null;

async function undoGroup(label, watch, run) {
  if (openGroup) return run(); // nested: the outermost action owns the step
  /*
   * Let the auto-save land first, on its own step.
   *
   * `openGroup` is a module global and `api` folds *every* write into it, so
   * a debounced auto-save whose 900ms happened to elapse while a grouped
   * action was in flight became part of that action. Measured: step a bullet
   * to a different wording, then press "Make default" — which commits
   * server-side and so takes long enough — and one press of Ctrl+Z took back
   * both, under the label "pin the default wording". Two deliberate, separate
   * decisions, one of them unnamed.
   *
   * Flushing rather than filtering, because the edit really is pending and
   * dropping it from the group would only mean it was never recorded at all.
   */
  await flushAutoSave();
  openGroup = { label, before: new Map(), after: new Map() };
  for (const key of watch ?? []) openGroup.before.set(key, readDoc(state.store, key));

  try {
    return await run();
  } finally {
    const group = openGroup;
    openGroup = null;
    try {
      /*
       * Read the end state back rather than trusting what was sent. A watched
       * document changed by a POST has no reply to snapshot, and the server
       * normalises and fills in defaults besides — so the only honest "after"
       * is the store as it now is.
       */
      if (group.before.size) {
        await loadStore();
        const changes = [...group.before.keys()].map((docKey) => ({
          docKey,
          before: group.before.get(docKey) ?? null,
          after: group.after.has(docKey) ? group.after.get(docKey) : readDoc(state.store, docKey),
        }));
        history.record({ changes, label });
        paintUndo();
      }
    } catch {
      // A step that cannot be recorded is not a reason to fail the action the
      // user asked for; it only means this one cannot be taken back.
    }
  }
}
/** What the write in flight should be called, set by the action that starts it. */
let undoLabel = 'change';
/** Name the next write, so the menu can say "Undo delete group". */
function describeNext(label) {
  undoLabel = label;
}

async function stepHistory(direction) {
  /*
   * Whatever is still on the debounce goes down first, for the reason
   * `undoGroup` gives and one more.
   *
   * A change made in the nine hundred milliseconds before it saves is held
   * only in `state.choices` and friends, and `clearEdits` below drops all of
   * them and sets `state.dirty` false. So an undo landing in that window
   * replayed an older step and took the newest change with it — never
   * written, never recorded, never undoable. The timer then fired into
   * `autoSave`'s `if (!state.dirty) return`: no request, no error, and the
   * save chip left reading "Unsaved changes" for ever about a change that no
   * longer existed anywhere.
   *
   * The mid-typing guard is no help. It reads `document.activeElement`, and a
   * tick box or an order nudge calls `render()`, which rebuilds the editor and
   * puts focus on the body — so the key goes straight through, from exactly
   * the actions most likely to be followed by one.
   *
   * Flushed rather than blocked, because the edit is real: it lands as its own
   * step, and then this undo takes back the thing the person actually did last.
   */
  await flushAutoSave();
  const entry = direction === 'undo' ? history.undo() : history.redo();
  if (!entry) {
    setStatus(direction === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
    return;
  }
  // Undo reinstates what was there before; redo puts back what the action did.
  // In reverse for an undo, so a step that created a document and then pointed
  // something at it is taken apart in the order it was put together.
  const changes = direction === 'undo' ? [...entry.changes].reverse() : entry.changes;
  undoing = true;
  try {
    for (const change of changes) {
      const { path, options } = restoreRequest(change.docKey, direction === 'undo' ? change.before : change.after);
      await api(path, options);
    }
    /*
     * The selections on screen are dropped, not kept.
     *
     * A resume is a thin overlay and the editor holds the unsaved part of it
     * in `state.choices` and friends. Undoing a selection change put the old
     * spec back on disk and left that overlay untouched, so the next render
     * re-applied exactly what had just been undone and the next auto-save
     * wrote it out again. From the outside, Ctrl+Z did nothing at all.
     */
    clearEdits();
    await loadStore();

    /*
     * Go to the resume that moved, so what happened is on screen.
     *
     * The stack is per-save, and `stepHistory` never checked that the step it
     * was about to replay belonged to the resume being edited. So: edit
     * resume A, pick resume B from the dropdown, press Ctrl+Z — and A was
     * rolled back behind your back. The screen did not change, the status
     * line said "Undid change", and nothing named the resume that had moved.
     * Ctrl+Z was already refused on the other tabs for exactly this reason;
     * two resumes inside the Build tab was the case that was left.
     *
     * Switched rather than refused, because the press means something: the
     * step is the user's own most recent edit, and taking them to it is
     * kinder than telling them they are in the wrong place. Only when the
     * step names exactly one resume — a step that touched an entry or a
     * skills group changed something every resume shares, and there is
     * nowhere in particular to go.
     */
    const moved = [
      ...new Set(
        entry.changes
          .map((c) => c.docKey)
          .filter((k) => k.startsWith('resume:'))
          .map((k) => k.slice('resume:'.length)),
      ),
    ];
    const elsewhere =
      moved.length === 1 && moved[0] !== state.resumeId && state.store.resumes.some((r) => r.id === moved[0])
        ? moved[0]
        : null;
    if (elsewhere) {
      state.masterView = false;
      state.resumeId = elsewhere;
      const select = $('#resume-select');
      if (select) select.value = elsewhere;
    }

    render();
    scheduleRender();
    scheduleCommit();
    const label = elsewhere
      ? `${entry.label} in "${state.store.resumes.find((r) => r.id === elsewhere)?.label ?? elsewhere}"`
      : entry.label;
    setStatus(`${direction === 'undo' ? 'Undid' : 'Redid'} ${label}`);
  } catch (err) {
    // Put it back on the stack it came off: a failed undo has not happened.
    if (direction === 'undo') history.redo();
    else history.undo();
    setStatus(err.message, true);
  } finally {
    undoing = false;
    paintUndo();
  }
}

/**
 * Throw the stack away, and say so on the buttons.
 *
 * `history.clear()` on its own leaves Undo enabled, and titled with the label
 * of a step that no longer exists — a button that says "Undo remove a line"
 * and does nothing when pressed, which reads as the editor being broken
 * rather than as there being nothing to undo.
 */
function forgetHistory() {
  history.clear();
  paintUndo();
}

/** Keep the two buttons honest about what they would do. */
function paintUndo() {
  const undoBtn = $('#btn-undo');
  const redoBtn = $('#btn-redo');
  if (!undoBtn || !redoBtn) return;
  undoBtn.disabled = !history.canUndo();
  redoBtn.disabled = !history.canRedo();
  undoBtn.title = history.canUndo() ? `Undo ${history.peekUndoLabel()}` : 'Nothing to undo';
  redoBtn.title = history.canRedo() ? `Redo ${history.peekRedoLabel()}` : 'Nothing to redo';
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
/*
 * The same shape the server makes, because they name the same things.
 *
 * This produced underscores and the server's `slug` produces hyphens, so a
 * filename derived here came out `kafka_heavy_variation` in a folder where
 * every other file is `intern-kafka.yaml` and
 * `job-helios-platform-engineer.yaml`. Two functions with one name and two
 * answers, and the visible result was a store that looked like two people had
 * been at it.
 *
 * Ids already stored keep whatever they were given; nothing regenerates them.
 */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/**
 * A bullet id nothing else in the store is using.
 *
 * Unique across the whole store, not just the entry it is going into. A chosen
 * wording is recorded as `choices[bulletId]` with no entry beside it, so two
 * lines sharing an id share one choice: picking a wording on one silently
 * changes the other wherever it has a wording by the same name, and two lines
 * minted from the same title usually do.
 *
 * Two roles at the same company was enough. `addEntry` named the first line
 * after the title and nothing else — "Acme Co." twice gave `b_acme-co_1`
 * twice — and the check it did run looked only inside the entry being added
 * to, which is the one place a collision cannot come from. The drafted-entry
 * path names its lines the same way.
 */
function freeBulletId(base) {
  return unusedId(base, (state.store?.entries ?? []).flatMap((e) => (e.bullets ?? []).map((b) => b.id)));
}

/**
 * A skills group id nothing else is using.
 *
 * Worse than a line if it collides. A section lists groups by id and the
 * lookup takes the first match, so two groups named "Languages" print the
 * first one twice and the second one never, and choosing which of its items
 * to show edits the wrong group. Nothing said so — the group you just made
 * simply did not appear.
 */
function freeSkillGroupId(groups, base) {
  return unusedId(base, (groups ?? []).map((g) => g.id));
}

/**
 * A skills item id nothing in its own group is using.
 *
 * Scoped to the group, which is the scope that matters: a resume records the
 * items it wants as `items[groupId]`. Two items with one id in a group left
 * the second unselectable, and removing either removed both.
 */
function freeSkillItemId(group, base) {
  return unusedId(base, (group?.items ?? []).map((i) => i.id));
}

function unusedId(base, taken) {
  const used = new Set(taken);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  return id;
}

/* ------------------------------------------------------------------ *
 * Spec helpers                                                        *
 * ------------------------------------------------------------------ */

function resumeById(id) {
  return state.store.resumes.find((r) => r.id === id);
}

/**
 * Choices as they resolve today, including unsaved edits.
 *
 * One resume's own choices and nothing else. This used to fold in every
 * ancestor's, because a resume inherited; resumes stand alone now, and a key
 * absent here still means "whatever the store has pinned as the default",
 * which is the cascade that actually earns its keep.
 */
function effectiveChoices() {
  return { ...(resumeById(state.resumeId)?.choices ?? {}), ...state.choices };
}

/** The sections this resume shows. */
function resolveSections(id = state.resumeId) {
  return resumeById(id)?.sections ?? [];
}

/** Which items a list bullet shows right now, including unsaved edits. */
function listSelection(bullet) {
  const saved = resumeById(state.resumeId)?.lists ?? {};
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
    // Folding prints nothing, so this never reaches the renderer — but it has
    // to ride along on the save, or it is a preference that lasts until the
    // page is reloaded.
    ...(state.collapsedEdits ? { collapsed: state.collapsedEdits } : {}),
  };

  /*
   * The resume's own sections, with this session's edits written into them.
   *
   * There is nothing underneath any more, so "leave it out and it stays
   * inherited" — which every line below used to be arranged around — no
   * longer says anything. What the resume holds is what it prints.
   */
  const touchesSections =
    state.skillEdits || state.entryEdits || state.bulletEdits || state.orderEdits || state.bulletOrderEdits;
  if (touchesSections) {
    const sections = [];

    /*
     * The resume's own sections, in place, rather than a map keyed by kind.
     * A store can hold two `custom` sections — "Awards" and "Leadership" —
     * and a map keyed by kind silently keeps one of them.
     */
    for (const mine of resolveSections()) {
      const entries = entrySelection(mine);

      const editedHere =
        mine.kind === 'skills'
          ? Boolean(state.skillEdits && (mine.groups ?? []).some((g) => g in state.skillEdits))
          : Boolean(state.entryEdits && mine.kind in state.entryEdits) ||
            Boolean(state.orderEdits && mine.kind in state.orderEdits) ||
            Boolean(state.bulletEdits && entries.some((eid) => eid in state.bulletEdits)) ||
            Boolean(state.bulletOrderEdits && entries.some((eid) => eid in state.bulletOrderEdits));

      if (!editedHere) {
        sections.push(mine);
        continue;
      }

      if (mine.kind === 'skills') {
        sections.push({ ...mine, items: { ...(mine.items ?? {}), ...state.skillEdits } });
        continue;
      }

      const next = { ...mine };
      // The entry list is written down when the user changed which entries
      // show. A bullet they hid is not a decision about the entry list.
      if (state.entryEdits && mine.kind in state.entryEdits) next.entries = entries;
      /* What decides the order, written down whenever it was chosen here. */
      if (state.orderEdits && mine.kind in state.orderEdits) next.order = state.orderEdits[mine.kind];
      const bullets = { ...(mine.bullets ?? {}) };
      for (const eid of entries) {
        if (state.bulletEdits?.[eid]) bullets[eid] = state.bulletEdits[eid];
      }
      if (Object.keys(bullets).length > 0) next.bullets = bullets;

      /*
       * Which entries arranged their own lines, rather than taking the
       * master's order. Written whenever it was decided here, and cleared
       * outright when the last one goes back to following the master, so a
       * resume that follows it everywhere says so by holding nothing.
       */
      const byHand = { ...(mine?.bulletOrder ?? {}) };
      for (const [eid, mode] of Object.entries(state.bulletOrderEdits ?? {})) {
        if (mode === 'manual') byHand[eid] = 'manual';
        else delete byHand[eid];
      }
      if (Object.keys(byHand).length > 0) next.bulletOrder = byHand;
      else delete next.bulletOrder;
      sections.push(next);
    }
    spec.sections = sections;
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
/**
 * Something changed, so save it — and recompile, unless it cannot show.
 *
 * `recompile: false` is for changes that alter the save without altering the
 * document: folding an entry away in the editor is the whole of that category
 * today. Recompiling for those is not merely wasted work, it is visibly wrong
 * — the preview flickers and the fit line goes to "Compiling…" because
 * somebody collapsed a heading.
 */
function markDirty(message = 'Changed', { recompile = true } = {}) {
  state.dirty = true;
  /*
   * An edit past a redo throws the redo away — now, not when the save lands.
   *
   * `history.record` clears it, and that runs on the write coming back: 900ms
   * of debounce plus a round trip later. Until then Redo was enabled and
   * destructive, because `stepHistory` drops the unsaved overlay — so making
   * an edit, pressing Ctrl+Z, making a different edit and pressing Redo
   * within the second took the new edit with it, with nothing said and no
   * step recorded for what was lost.
   *
   * Not while an undo is being applied: that is the one caller whose writes
   * are the redo stack rather than an edit past it.
   */
  if (!undoing && history.dropRedo()) paintUndo();
  if (message !== 'Changed') setStatus(message);
  if (recompile) scheduleRender();
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

/**
 * Get any pending edit written before doing something else.
 *
 * The debounce is what makes an auto-save cheap and what makes it arrive at
 * an arbitrary moment; `undoGroup` needs the second of those not to happen
 * inside it. Both halves matter: a timer still counting down is brought
 * forward, and a save already in flight is waited for.
 */
async function flushAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    await autoSave();
    return;
  }
  if (autoSaving) await autoSaving;
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
  // The Workspace's typing too. Every path out of a page already calls this —
  // closing the tab, switching resumes, following a deep link — and the draft
  // was the one thing it did not cover.
  await flushDraftEdits().catch(() => {});
  /*
   * Settled, and reported. `Promise.all` rejects on the first inline commit
   * that failed, and nothing here caught it — the `.catch` at the call site
   * is on a *derived* promise, so the one in this set is still rejected. That
   * rejection went straight out through `leaveResume` and out of the
   * dropdown's own handler, past both of `leaveResume`'s exits, so neither
   * its refusal message nor the line that puts the dropdown back ever ran: an
   * unhandled rejection in the console, and a resume switch that half
   * happened.
   *
   * The answer for the caller is the same one `state.dirty` gets — the edit
   * did not land, so the screen stays where it is and says why.
   */
  const inline = await Promise.allSettled([...inlineSaves]);
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  if (state.dirty) await autoSave();
  await autoSaving;
  clearTimeout(commitTimer);
  commitTimer = null;
  if (state.store?.config?.git?.autoCommit) {
    await api('/store/save', { method: 'POST', body: JSON.stringify({}), keepalive: true }).catch(() => {});
  }
  return inline.every((r) => r.status === 'fulfilled');
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

/**
 * One in-flight write per entry, and what the last one left on the server.
 *
 * An entry is saved whole, and the copy an edit is built from is the copy that
 * was on screen when it started — which is the copy from before any edit still
 * in flight. Two changes a moment apart therefore both send the old text for
 * whatever the other one changed, and the second lands on top of the first.
 * Waiting for each write and rebasing the next onto it is what stops the
 * second edit from carrying the first one away with it.
 */
const entryWrites = new Map(); // id → { queue, server, pending }

/**
 * Run something that changes one entry in that entry's lane.
 *
 * Every route that touches an entry goes through here, not only the whole-entry
 * PUT: adding a phrasing, adding an entry and deleting one each have their own
 * endpoint, and a queue that only some writes respect is worse than no queue.
 * A delete that overtakes a PUT still sitting in the lane gets recreated by it
 * — `PUT /entries/:id` has no existence check — as an orphan no resume
 * references, and a phrasing added beside a queued write is deleted by it.
 */
async function inEntryLane(id, run) {
  const lane = entryWrites.get(id) ?? { queue: Promise.resolve(), server: null, pending: 0 };
  entryWrites.set(id, lane);
  lane.pending++;

  // `queue` never rejects, so one failed write does not wedge the ones behind
  // it — each is still worth attempting on its own.
  const mine = lane.queue.then(() => run(lane));
  lane.queue = mine.then(
    () => {},
    () => {},
  );

  try {
    return await mine;
  } finally {
    await loadStore();
    /*
     * The server's own copy, read back, so anything a differently-shaped write
     * did to this entry is what the next edit in the lane rebases onto.
     *
     * And the lane is only released after that reload, not before it. `state
     * .store` still shows the pre-write entry for the length of that request,
     * so an edit started inside that window would otherwise open a fresh lane,
     * find nothing to rebase onto, and PUT the stale entry whole — undoing the
     * write that had just landed.
     */
    lane.server = state.store?.entries?.find((e) => e.id === id) ?? lane.server;
    if (--lane.pending === 0 && entryWrites.get(id) === lane) entryWrites.delete(id);
  }
}

async function saveEntry(entry, message) {
  describeNext(message ?? 'the change');
  const id = entry.id;
  // What this edit was derived from: the store as the client last saw it.
  const base = state.store?.entries?.find((e) => e.id === id) ?? null;

  await inEntryLane(id, async (lane) => {
    // Something landed while this edit was being made: keep it, and put only
    // what this edit actually changed on top of it.
    const body = lane.server && base && !same(lane.server, base) ? rebase(base, entry, lane.server) : entry;
    const saved = await api(`/entries/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
    lane.server = saved?.id ? saved : body;
  });

  setStatus(message ?? `Saved ${id}`);
  render();
}

async function saveResumeSpec(spec, message) {
  describeNext(message ?? 'the change');
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
  // Filtered here rather than at each call site: `append(null)` puts the
  // string "null" on the screen, which is a strange thing to discover.
  for (const a of extraActions) if (a) actions.append(a);
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
  for (const a of trailingActions) if (a) actions.append(a);

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

/**
 * Which document "Make default" actually changes.
 *
 * `PUT /defaults/:key` is a route of its own, so nothing about it looks like a
 * whole-document write and it recorded no undo step. It always lands on the
 * profile or on one entry, and which is decided by the same reading of the key
 * the server does — `entryId.field` for a heading, a bare bullet id otherwise.
 */
function documentBehind(key) {
  if (key === PROFILE_NAME_KEY) return 'profile';
  const dot = String(key).indexOf('.');
  if (dot > 0) return `entry:${key.slice(0, dot)}`;
  const owner = (state.store?.entries ?? []).find((e) => (e.bullets ?? []).some((b) => b.id === key));
  return owner ? `entry:${owner.id}` : null;
}

async function pinDefault(key, variantId) {
  try {
    const doc = documentBehind(key);
    await undoGroup('pin the default wording', doc ? [doc] : [], () =>
      api(`/defaults/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ variantId }),
      }),
    );
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
/*
 * The line as the store holds it is what gets edited; the rendered form is what
 * gets shown. That was always the intent — the comment below said so — and the
 * code did the opposite: it put `display(text)` into the box, and `display`
 * strips `**bold**`, backticks and `*italic*`. Whatever came back was saved
 * over the original, so editing a bullet to add one word silently deleted its
 * markup from the shared store, for every resume using that phrasing, and the
 * bold metric in the PDF turned to body text with nothing having said so.
 *
 * `undisplay` was supposed to be the inverse and only ever restored the en
 * dash. Editing the raw text needs no inverse.
 */
function editableLine(text, { onCommit, className = 'text', title } = {}) {
  const raw = String(text ?? '');
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
    if (commit && next && next !== raw) {
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
    // The sentence as written, markup and all: what is saved is what is shown
    // here, so there is nothing to lose in translation.
    node.textContent = raw;
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
  return aiButton({
    className: 'tiny entry-feedback',
    label: 'AI Feedback',
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
  return aiButton({
    className: 'tiny phrase-feedback',
    label: 'AI Feedback',
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
    el('button', { className: 'step', textContent: '‹', title: 'Previous wording', ariaLabel: 'Previous wording', onclick: () => go(-1) }),
    el('span', { className: 'count', textContent: `${at + 1}/${ids.length}` }),
    el('button', { className: 'step', textContent: '›', title: 'Next wording', ariaLabel: 'Next wording', onclick: () => go(1) }),
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
      /*
       * A button, because it was a span: clickable with a mouse and reachable
       * by nothing else. There is no keyboard route to deleting an item, and
       * a screen reader is told only that there is an "×" here.
       */
      el('button', {
        type: 'button',
        className: 'x',
        textContent: '×',
        title: 'Delete this item from the save',
        ariaLabel: `Delete "${item.text}" from the save`,
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
    bulletGrip(entry, section, bullet),
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
          aiButton({ label: 'Feedback', title: 'Review this list and the items in it', onclick: () => askBulletFeedback(entry, bullet) }),
          el('button', { className: 'tiny danger', textContent: 'Remove', onclick: () => removeBullet(entry, bullet) }),
        ]),
      ]),
    );
    return asBulletTarget(
      attachSourceTools(wrap, `${entry.id}/${bullet.id}`, [...wrap.children].filter(child => child !== head), head),
      entry, section, bullet,
    );
  }

  const key = bullet.id;
  const chosenId = choices[key] ?? bullet.default;
  const chosen = bullet.variants.find((v) => v.id === chosenId) ?? bullet.variants[0];

  /*
   * Quick, and therefore not behind the "…".
   *
   * Everything else on a bullet is folded into the disclosure to keep eight
   * of them readable at once, and this bar was folded in with them by a
   * filter that took every child except the heading. That put the stepper —
   * the one control this whole editor exists for, and the one whose own
   * description is "step through the alternates without opening the list" —
   * behind a menu. Three bullets with two and three phrasings each, and no
   * way to see that there was anything to step through.
   *
   * It stays out. `alternateStepper` returns nothing when there is only one
   * wording, so this appears exactly where there is a choice to make.
   */
  /*
   * The stepper is quick; asking an AI to read the line is not.
   *
   * Taking this bar out of the disclosure to free the stepper took the
   * feedback button with it, so every bullet — including the ones with a
   * single phrasing and therefore no stepper at all — carried an "AI
   * Feedback" in its corner for good. That is a button that costs minutes
   * and, depending on the command, money, sitting permanently on every line
   * of the document.
   *
   * The bar stays out so the stepper can be seen; the button inside it folds
   * away with the rest, and is listed among the actions below.
   */
  const phraseFeedback = phraseFeedbackButton(entry, { bulletId: bullet.id, variantId: chosen?.id ?? chosenId });
  const quickActions = el('div', { className: 'bullet-quick-actions toolbar' }, [
    alternateStepper(bullet.id, bullet, chosenId),
    phraseFeedback,
  ].filter(Boolean));
  wrap.append(quickActions);

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
        aiButton({ label: 'Compare Phrasings', title: 'Ask which of these wordings is strongest, and why', onclick: () => askBulletFeedback(entry, bullet) }),
        /*
         * Deleting the wording you are looking at, beside deleting the line
         * it belongs to. Only where there is more than one: with a single
         * wording the two actions would mean the same thing and sit next to
         * each other saying different words.
         */
        bullet.variants.length > 1 && chosen
          ? el('button', {
              className: 'tiny danger',
              textContent: 'Delete phrasing',
              title: 'Delete this one wording, and keep the line',
              onclick: () => removeBulletVariant(entry, bullet, chosen),
            })
          : null,
        el('button', {
          className: 'tiny danger',
          textContent: 'Remove',
          title: 'Delete this bullet from the save',
          onclick: () => removeBullet(entry, bullet),
        }),
      ].filter(Boolean),
    }),
  );

  if (chosen?.note) wrap.append(el('div', { className: 'note', textContent: chosen.note }));
  return asBulletTarget(
    attachSourceTools(
      wrap,
      `${entry.id}/${bullet.id}`,
      // The bar itself stays visible for the stepper; the button inside it
      // does not.
      [...[...wrap.children].filter((child) => child !== head && child !== quickActions), phraseFeedback].filter(Boolean),
      head,
    ),
    entry, section, bullet,
  );
}

/** A bullet row that accepts another bullet dropped onto it. */
function asBulletTarget(row, entry, section, bullet) {
  return dropTarget(row, {
    kind: 'bullet',
    id: bullet.id,
    onDrop: (moved, side) => dropBullet(entry, section, moved, bullet.id, side),
  });
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

/* ------------------------------------------------------------------ *
 * Arranging: moving things, and folding them away                      *
 * ------------------------------------------------------------------ */

/**
 * The grip that lets something be moved, by mouse or by keyboard.
 *
 * Dragging is how anyone expects to reorder a list, and it is also the one
 * interaction that is unavailable to somebody who is not using a mouse — so
 * the same handle takes Alt with the arrow keys. That is not a consolation
 * prize: it is the faster way to move one line up by one, which is most of
 * what actually gets done here.
 *
 * `kind` keeps bullets from being dropped into the entry list and the other
 * way round, since both are drag sources on the same screen.
 */
function dragHandle({ kind, id, label, onMove, onStep }) {
  const grip = el('button', {
    className: 'grip',
    type: 'button',
    draggable: true,
    title: `Drag to reorder ${label}, or Alt with the up and down arrows`,
    'aria-label': `Reorder ${label}`,
    textContent: '⠿',
  });

  grip.addEventListener('dragstart', (ev) => {
    /*
     * Held in a variable as well as in the DataTransfer, because `dragover`
     * cannot read the payload — every browser blanks it during the drag, by
     * design, so a page cannot snoop at what is being dragged over it. The
     * DataTransfer is still set so a drop outside the app is a sensible
     * no-op rather than a silent one.
     */
    dragging = { kind, id };
    ev.dataTransfer?.setData('text/plain', `${kind}:${id}`);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    grip.closest('[data-drag-id]')?.classList.add('dragging');
  });
  grip.addEventListener('dragend', () => {
    dragging = null;
    grip.closest('[data-drag-id]')?.classList.remove('dragging');
    for (const row of document.querySelectorAll('.drop-before, .drop-after')) {
      row.classList.remove('drop-before', 'drop-after');
    }
  });

  grip.addEventListener('keydown', (ev) => {
    if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    ev.preventDefault();
    onStep(ev.key === 'ArrowUp' ? -1 : 1);
  });

  // Held so the row's own drop handler can tell what is being dragged without
  // reading the DataTransfer, which is empty during `dragover` in every
  // browser by design.
  grip.dataset.dragKind = kind;
  void onMove;
  return grip;
}

/** What is currently being dragged, since `dragover` cannot see the payload. */
let dragging = null;

/**
 * Make a row a drop target for its own kind of thing.
 *
 * The drop lands *before* the row it is over, which is the rule that makes a
 * list reorderable at all — without a way to express "after the last one", the
 * bottom position is unreachable. The row's lower half therefore means after.
 */
function dropTarget(row, { kind, id, onDrop }) {
  row.dataset.dragId = id;

  row.addEventListener('dragover', (ev) => {
    if (dragging?.kind !== kind || dragging.id === id) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const box = row.getBoundingClientRect();
    const after = ev.clientY > box.top + box.height / 2;
    row.classList.toggle('drop-before', !after);
    row.classList.toggle('drop-after', after);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', (ev) => {
    if (dragging?.kind !== kind) return;
    ev.preventDefault();
    const after = row.classList.contains('drop-after');
    row.classList.remove('drop-before', 'drop-after');
    onDrop(dragging.id, after ? 'after' : 'before');
    dragging = null;
  });
  return row;
}

/* ------------------------------------------------------------------ *
 * What decides the order of a section                                  *
 * ------------------------------------------------------------------ */

/** How this section is ordered right now, including unsaved changes. */
function sectionOrder(section) {
  return state.orderEdits?.[section.kind] ?? section.order ?? 'manual';
}

function setSectionOrder(section, order) {
  state.orderEdits = { ...(state.orderEdits ?? {}), [section.kind]: order };
  markDirty();
  render();
}

const ORDER_LABELS = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  manual: 'In the order you arranged',
};

/**
 * Newest first, oldest first, or the order you put them in.
 *
 * Newest first is what a resume wants nearly always — it is not so much a
 * preference as the convention every reader of the document already has — so
 * it is what a new section gets, and the dates maintain it. Dragging switches
 * to manual on its own, because dragging is an instruction and a sort that
 * immediately undid it would make the handle a lie.
 *
 * A section carried over from before any of this existed says nothing about
 * what it wants, and `adoptDateOrder` on the server has already taken over the
 * ones where sorting provably changes nothing. This is how the rest get asked
 * rather than told: they read "In the order you arranged", which is true, and
 * one click sorts them.
 */
function orderControl(section) {
  const current = sectionOrder(section);
  const select = el('select', {
    className: 'order-by',
    title: 'What decides the order of this section',
    onchange: (ev) => setSectionOrder(section, ev.target.value),
  });
  for (const [value, label] of Object.entries(ORDER_LABELS)) {
    select.append(el('option', { value, textContent: label, selected: value === current }));
  }

  /*
   * How many of these the program cannot place. Sorting quietly leaves them at
   * the bottom, which is right and is also the sort of thing that reads as a
   * bug when you have not been told — "why is that project last?".
   */
  const undated =
    current === 'manual'
      ? 0
      : entrySelection(section).filter((id) => !state.store.entries.find((e) => e.id === id)?.period).length;

  return el('span', { className: 'order-control' }, [
    el('label', { className: 'sr-only', htmlFor: '' }, 'Order'),
    select,
    undated > 0
      ? el('span', {
          className: 'chip',
          textContent: `${undated} undated`,
          title: 'These have no date the program could read, so they keep their place at the end. Fix the date to sort them.',
        })
      : null,
  ].filter(Boolean));
}

/**
 * Which entries are folded away, for the resume that is open.
 *
 * On the resume rather than in the browser. Folding prints nothing, but which
 * entries you are done with is a fact about the document you are building, and
 * it should still be true on another machine or after the save is cloned — a
 * preference kept in localStorage is a preference that exists on one computer.
 *
 * One resume's own, not shared with the ones copied from it: folding is about
 * the list in front of you, and another resume is a different list.
 */
function collapsedIds() {
  return state.collapsedEdits ?? resumeById(state.resumeId)?.collapsed ?? [];
}

function setCollapsed(entryId, folded) {
  const next = new Set(collapsedIds());
  if (folded) next.add(entryId);
  else next.delete(entryId);
  state.collapsedEdits = [...next];
  // Saved, but not recompiled: folding changes the editor and not the page.
  markDirty('Changed', { recompile: false });
  render();
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

  const folded = collapsedIds().includes(entry.id);
  const box = el('div', {});
  const head = el('div', { className: 'entry-head' }, [
    entryGrip(section, entry),
    toggle({
      on: included,
      title: 'Showing on this variation',
      onChange: (checked) => setEntryIncluded(section, entry, checked),
    }),
    /*
     * Folding, for an entry that is switched *on*.
     *
     * Switching one off already collapsed it, which covers the entries you are
     * not using — and those were never the ones filling the screen. The entry
     * with six bullets, four of them with three phrasings each, is on, and it
     * is on because you want it: you just are not editing it right now. There
     * was no way to say that.
     *
     * Nothing here changes what compiles. It is still kept in the save
     * rather than in this browser, per resume — see `collapsedIds`: which
     * entries you are done with is a fact about the document you are
     * building, and it should still be true on another machine.
     */
    el('button', {
      className: 'fold',
      type: 'button',
      title: folded ? 'Show this entry’s lines' : 'Fold this entry away, without switching it off',
      'aria-expanded': folded ? 'false' : 'true',
      textContent: folded ? '▸' : '▾',
      onclick: () => setCollapsed(entry.id, !folded),
    }),
    el('span', { className: 'title', textContent: fieldText(entry.title, choices, `${entry.id}.title`) || 'Untitled' }),
    folded
      ? el('span', {
          className: 'chip count',
          textContent: plural((entry.bullets ?? []).filter((b) => !b.archived).length, 'line'),
        })
      : null,
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

  // Folded: the header and nothing else. Everything below is reachable again
  // in one click, and the entry goes on printing exactly as it did.
  if (folded) {
    box.className = 'entry folded';
    return dropTarget(box, {
      kind: 'entry',
      id: entry.id,
      onDrop: (moved, side) => dropEntry(section, moved, entry.id, side),
    });
  }

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
        /*
         * Beside "+ alternate", because adding and removing one are the same
         * act in two directions.
         *
         * Offered on the last one too, which it was not. The rule was that a
         * field with one alternate is a field that should go back to being a
         * plain string — true of the model, and no use to somebody who wants
         * the line gone: there was no control anywhere that would remove it,
         * so a role you tried two ways and then dropped, or an AI-drafted
         * location you never wanted, could be narrowed to one alternate and
         * never to none. A line is the last thing it says, so the button
         * says that.
         */
        trailingActions: [
          chosen
            ? el('button', {
                className: 'tiny danger',
                textContent: field.variants.length > 1 ? 'Delete alternate' : `Delete ${FIELD_LABELS[name] ?? name}`,
                title:
                  field.variants.length > 1
                    ? 'Remove this wording from the save — every resume loses it'
                    : `Remove the ${FIELD_LABELS[name] ?? name} line from this entry`,
                onclick: () => removeFieldAlternate(entry, name, chosen),
              })
            : null,
        ],
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
      /*
       * A graduation date is a date too.
       *
       * This is the case the variant system was built for — one education
       * entry, two endings — and it was the one place the date control did not
       * reach, because it only replaced plain-string fields. So the field most
       * likely to hold a date was the last one still asking you to type
       * "Sep. 2022 -- May 2026" by hand, and to type it the same way twice.
       *
       * Each alternate gets its own control, editing its own text: they are
       * different dates, which is the entire point of there being two. The
       * entry's sort order still comes from the default one.
       */
      const asDate = name === 'dates' && parsePeriod(String(chosen?.text ?? ''));
      const line = el('div', { className: 'field-line' }, [
        asDate
          ? variantDateEditor(entry, name, current, asDate)
          : editableLine(String(chosen?.text ?? ''), {
              className: 'text field-text',
              onCommit: (text) => saveFieldText(entry, name, current, text),
            }),
      ]);
      // Same as on a bullet: the stepper stays out of the disclosure, and
      // exists at all only where there is more than one wording to step
      // between. Everything else about the field folds away.
      const stepper = alternateStepper(key, field, current);
      const feedback = phraseFeedbackButton(entry, { fieldName: name, variantId: current });
      line.append(...[stepper, feedback].filter(Boolean));
      const row = el('div', { className: 'field' }, [
        el('div', { className: 'field-label' }, FIELD_LABELS[name] ?? name), line, control,
      ]);
      box.append(attachSourceTools(row, key, [feedback, control].filter(Boolean), line, 'field'));
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
      /*
       * Dates are edited as dates, and everything else as text.
       *
       * The exception is a date nothing could read — "Various", "Two
       * semesters". Replacing that with two blank month-and-year boxes would
       * throw away what the person wrote in order to offer them a control they
       * did not ask for, so it keeps the text box and says why it is not being
       * sorted, which is the only consequence.
       */
      const asDate = f.name === 'dates' && Boolean(entry.period);
      const row = el('span', { className: 'meta-item' }, [
        el('span', { className: 'meta-label', textContent: FIELD_LABELS[f.name] }),
        asDate
          ? dateEditor(entry)
          : editableLine(f.text, {
              className: 'meta-value',
              onCommit: (text) => savePlainField(entry, f.name, text),
            }),
        f.name === 'dates' && !entry.period
          ? el('span', {
              className: 'chip',
              textContent: 'not a date',
              title: 'Nothing here could be read as a date, so this entry keeps its place by hand instead of being sorted.',
            })
          : null,
        phraseFeedbackButton(entry, { fieldName: f.name }),
        el('button', {
          className: 'link meta-add',
          textContent: '+ alt',
          title: `Give ${FIELD_LABELS[f.name] ?? f.name} a second option — a different graduation date, say`,
          onclick: () => addFieldAlternate(entry, f.name),
        }),
      ].filter(Boolean));
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

  /*
   * In the order this resume shows them, not the order the store holds them.
   *
   * The same bug the entry list had, and the reason dragging a bullet did
   * nothing you could see: the drop rewrote the selection, the selection is
   * what compiles, and this loop then drew the bullets in `entry.bullets`
   * order regardless. So the PDF moved and the editor did not — which reads as
   * the handle being broken, and is worse than that, because the document
   * quietly disagreed with the screen.
   *
   * Bullets that are switched off follow the ones that are on, so turning one
   * off does not make it unreachable.
   */
  /*
   * Which lines, from this resume; what order, from the master — unless this
   * resume was arranged by hand, which is recorded by the two disagreeing.
   * See `orderedBullets`.
   */
  const picked = bulletSelection(section, entry);
  const byHand = handOrdered(section, entry.id);
  const shown = byHand ? picked : orderedBullets(picked, entry);
  const ordered = [
    ...shown.map((id) => (entry.bullets ?? []).find((b) => b.id === id)).filter(Boolean),
    ...(entry.bullets ?? []).filter((b) => !shown.includes(b.id)),
  ];
  for (const bullet of ordered) {
    if (bullet.archived) continue;
    box.append(bulletBlock(entry, section, bullet, choices));
  }

  box.append(
    el('div', { className: 'add-row' }, [
      el('button', { className: 'link', textContent: '+ Add bullet', onclick: () => addBullet(entry) }),
      /*
       * Said out loud, and undoable. Arranging the lines here detaches this
       * entry from the master's order, so rearranging the master will no
       * longer restack it — which is right, and is also the sort of thing
       * that has to be visible or it is a rule you discover by being
       * surprised.
       */
      byHand
        ? el('span', { className: 'by-hand' }, [
            el('span', { textContent: 'Lines arranged here' }),
            el('button', {
              className: 'link',
              textContent: 'Follow the master’s order',
              title: 'Put these lines back in the order the master document puts them, and follow it again',
              onclick: () => followMasterOrder(entry, section),
            }),
          ])
        : null,
    ].filter(Boolean)),
  );
  box.className = 'entry';
  return dropTarget(box, {
    kind: 'entry',
    id: entry.id,
    onDrop: (moved, side) => dropEntry(section, moved, entry.id, side),
  });
}

/* ------------------------------------------------------------------ *
 * Reordering entries and bullets                                       *
 * ------------------------------------------------------------------ */

/**
 * Where a section's order is written.
 *
 * `entrySelection` is the list of ids this resume shows, in the order it shows
 * them, which means reordering and including are the same field — and that is
 * right: an entry's position and whether it is there at all are both this
 * resume's business rather than the store's. Moving one on a variation does
 * not move it on the resume it inherits from.
 */
function setEntryOrder(section, ordered) {
  state.entryEdits = { ...(state.entryEdits ?? {}), [section.kind]: ordered };
  /*
   * Dragging is an instruction, so it also turns the sort off.
   *
   * Without this the drop lands, the list is rewritten, and the date sort puts
   * everything straight back — a handle that visibly does nothing, which is
   * worse than no handle at all. The sort is still one click away in the
   * heading, and turning it back on restores date order without having lost
   * anything: the arrangement stays in the list underneath.
   */
  if (sectionOrder(section) !== 'manual') {
    state.orderEdits = { ...(state.orderEdits ?? {}), [section.kind]: 'manual' };
    setStatus('Arranged by hand — the date sort for this section is off');
  }
  markDirty();
  render();
}

function dropEntry(section, moved, onto, side) {
  // The order on screen, which is what the user was aiming at. Dropping
  // against the stored list while a sort is on would move things relative to
  // an order nobody can see.
  const list = orderEntryIds(entrySelection(section), state.store.entries, sectionOrder(section));
  // Only entries this resume actually shows can be reordered: the ones below
  // are the store's other entries, offered so they can be switched on, and
  // they have no position yet to move.
  if (!list.includes(moved)) return;
  const at = list.indexOf(onto);
  const before = side === 'after' ? (list[at + 1] ?? null) : onto;
  setEntryOrder(section, moveBefore(list, moved, before));
}

function entryGrip(section, entry) {
  const list = entrySelection(section);
  if (!list.includes(entry.id) || list.length < 2) {
    // Nothing to move it among. A grip that cannot do anything is a button
    // that has to be explained.
    return null;
  }
  return dragHandle({
    kind: 'entry',
    id: entry.id,
    label: 'this entry',
    onStep: (delta) =>
      setEntryOrder(
        section,
        moveBy(orderEntryIds(entrySelection(section), state.store.entries, sectionOrder(section)), entry.id, delta),
      ),
  });
}

function setBulletOrder(entry, ordered, { byHand = true } = {}) {
  state.bulletEdits = { ...(state.bulletEdits ?? {}), [entry.id]: ordered };
  /*
   * Dragging here is this resume saying it wants its own order, and that has
   * to be written down rather than inferred from the order itself — see
   * `SectionSpec.bulletOrder`. Without it, the next rearrangement of the
   * master would restack this entry and throw the arrangement away.
   */
  state.bulletOrderEdits = { ...(state.bulletOrderEdits ?? {}), [entry.id]: byHand ? 'manual' : null };
  markDirty();
  render();
}

/** Whether this entry's lines were arranged here, including unsaved changes. */
function handOrdered(section, entryId) {
  const edited = state.bulletOrderEdits?.[entryId];
  if (edited !== undefined) return edited === 'manual';
  return bulletsAreHandOrdered(section, entryId);
}

/**
 * Put this entry's lines back in the master's order.
 *
 * The way out of a hand arrangement, and the reason the arrangement can be
 * made at all without it being a one-way door. A resume that disagrees with
 * the master stops following it — deliberately — and this is how you say you
 * are done disagreeing.
 */
function followMasterOrder(entry, section) {
  setBulletOrder(entry, orderedBullets(bulletSelection(section, entry), entry), { byHand: false });
  setStatus('Back in the master’s order');
}

/**
 * Reorder the lines of an entry in the master itself, which is the order
 * every resume that has not been arranged by hand will follow.
 *
 * This writes the entry, not a resume: the master is the shared inventory,
 * and an order set here is the one the documents inherit.
 */
async function setMasterBulletOrder(entry, ordered) {
  const bullets = ordered.map((id) => (entry.bullets ?? []).find((b) => b.id === id)).filter(Boolean);
  // Anything the drag did not name — archived lines are still in the file and
  // are not shown here — keeps its place at the end rather than being dropped.
  const rest = (entry.bullets ?? []).filter((b) => !ordered.includes(b.id));
  const next = { ...entry, bullets: [...bullets, ...rest] };

  // On screen first: `saveEntry` redraws from the store the client is holding,
  // which has not heard about this yet. Same reason as `saveEntryPeriod`.
  const held = state.store?.entries?.find((e) => e.id === entry.id);
  if (held) held.bullets = next.bullets;
  render();

  await saveEntry(next, 'Lines reordered');
  await loadStore();
  render();
  scheduleRender();
}

function dropBullet(entry, section, moved, onto, side) {
  const list = bulletSelection(section, entry);
  if (!list.includes(moved)) return;
  const at = list.indexOf(onto);
  const before = side === 'after' ? (list[at + 1] ?? null) : onto;
  setBulletOrder(entry, moveBefore(list, moved, before));
}

/** The order shown in the master, which is the entry's own line order. */
function masterBulletIds(entry) {
  return (entry.bullets ?? []).map((b) => b.id);
}

function dropMasterBullet(entry, moved, onto, side) {
  const list = masterBulletIds(entry);
  if (!list.includes(moved)) return;
  const at = list.indexOf(onto);
  const before = side === 'after' ? (list[at + 1] ?? null) : onto;
  setMasterBulletOrder(entry, moveBefore(list, moved, before)).catch((err) => setStatus(err.message, true));
}

function masterBulletGrip(entry, bullet) {
  const list = masterBulletIds(entry);
  if (!list.includes(bullet.id) || list.length < 2) return null;
  return dragHandle({
    kind: 'master-bullet',
    id: bullet.id,
    label: 'this line, for every resume',
    onStep: (delta) =>
      setMasterBulletOrder(entry, moveBy(masterBulletIds(entry), bullet.id, delta)).catch((err) =>
        setStatus(err.message, true),
      ),
  });
}

function bulletGrip(entry, section, bullet) {
  const list = bulletSelection(section, entry);
  if (!list.includes(bullet.id) || list.length < 2) return null;
  return dragHandle({
    kind: 'bullet',
    id: bullet.id,
    label: 'this line',
    onStep: (delta) => setBulletOrder(entry, moveBy(bulletSelection(section, entry), bullet.id, delta)),
  });
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
        // As above: a button, and named for the skill it deletes.
        el('button', {
          type: 'button',
          className: 'x',
          textContent: '×',
          title: 'Delete this skill from the save',
          ariaLabel: `Delete "${item.text}" from the save`,
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
              ariaLabel: `Remove ${label.toLowerCase()} from the header`,
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
        el('button', {
          className: 'link',
          textContent: '×',
          title: `Remove ${key.replace(/_/g, ' ')}`,
          ariaLabel: `Remove ${key.replace(/_/g, ' ')}`,
          onclick: () => saveAutofillField(key, ''),
        }),
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
  /*
   * `effectiveChoices()`, not `state.choices` — which is only what is unsaved.
   * Every other field renderer uses the merged view; this one did not, so the
   * moment a name choice was saved or inherited the editor stopped seeing it:
   * the line showed the pinned name while the PDF printed the chosen one, with
   * nothing on screen to say which would be sent. Worse, double-clicking to
   * fix it then edited the *pinned* form, changing it for every other resume.
   */
  const current = effectiveChoices()[key] ?? field.default;
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
      // As on a heading field: adding and removing an alternate are the same
      // act, and the last form of your name is not one to delete.
      trailingActions: [
        field.variants.length > 1 && chosen
          ? el('button', {
              className: 'tiny danger',
              textContent: 'Delete alternate',
              title: 'Remove this form of your name from the save',
              onclick: () => removeNameAlternate(chosen),
            })
          : null,
      ],
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
  describeNext(message ?? 'the change');
  const profile = { ...state.store.profile, name };
  await api('/profile?commit=0', { method: 'PUT', body: JSON.stringify(profile) });
  state.store.profile = profile;
  setStatus(message);
  render();
  scheduleRender();
  scheduleCommit();
}

async function saveProfileField(key, text) {
  const label = (PROFILE_FIELDS.find(([k]) => k === key) ?? [key, key])[1].toLowerCase();
  describeNext(text.trim() ? `the ${label}` : `removing the ${label}`);
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
      section.kind !== 'skills' ? orderControl(section) : null,
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

    /*
     * Everything of this kind in the store, with the entries this resume
     * already lists first. Showing only the included ones would make a
     * toggled-off entry disappear, with no way to bring it back.
     *
     * `entrySelection` rather than `section.entries`, because the first is
     * this resume's list *including anything unsaved* and the second is only
     * what was last written down. Reading the saved one meant a reorder
     * changed the spec that compiles and did not change the list on screen —
     * the preview moved and the editor did not.
     */
    const listed = orderEntryIds(entrySelection(section), state.store.entries, sectionOrder(section));
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
      aiButton({
        className: 'link',
        label: '+ Draft with AI',
        title: 'Paste a repository link, or say a line about it, and get a first draft to edit',
        onclick: () => draftEntryWithAi(kind),
      }),
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
        /*
         * Arranged here, followed everywhere. The master is the one place an
         * order can be stated once and mean something on every resume, so
         * this is where the lines inside an entry are put in order — every
         * resume that has not been arranged by hand takes this order, and
         * rearranging it here restacks all of them.
         */
        const grip = masterBulletGrip(entry, bullet);
        if (grip) row.append(grip);
        if (Array.isArray(bullet.items)) {
          row.append(el('div', { className: 'text', textContent: `${bullet.prefix ?? ''} ${bullet.items.map(item => item.text).join(bullet.separator ?? ', ')}` }));
          row.append(el('button', { className: 'tiny', textContent: '+ Item', onclick: () => addListItem(entry, bullet) }));
          row.append(aiButton({ label: 'AI Feedback', title: 'Review this list and the items in it', onclick: () => askBulletFeedback(entry, bullet) }));
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
            aiButton({
              label: 'Draft one',
              title: 'Ask for another way to say this line — same claim, different wording',
              onclick: () => draftPhrasings(entry, { bulletId: bullet.id }),
            }),
            aiButton({ label: 'Compare Phrasings', title: 'Ask which of these wordings is strongest, and why', onclick: () => askBulletFeedback(entry, bullet) }),
          ]));
        }
        const actions = [...row.querySelectorAll('.phrase-feedback, :scope > button, :scope > .toolbar')];
        const anchor = row.querySelector('.phrase-line') ?? row;
        attachSourceTools(row, `${entry.id}/${bullet.id}`, actions, anchor);
        box.append(
          dropTarget(row, {
            kind: 'master-bullet',
            id: bullet.id,
            onDrop: (moved, side) => dropMasterBullet(entry, moved, bullet.id, side),
          }),
        );
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

/**
 * Draft an entry from a repository, or from a line of notes.
 *
 * The case this is for: you built something, the code is the record of it, and
 * turning that into three bullets from memory is the part of writing a resume
 * people put off for weeks. The repository is evidence, so working from it is
 * not invention — but nothing is written until it has been read, which is why
 * this shows the draft and asks.
 */
async function draftEntryWithAi(kind) {
  const asked = await form(`New ${kind} entry, drafted`, [
    { name: 'repoUrl', label: 'Repository link (optional)', value: '' },
    { name: 'notes', label: 'Or say a little about it', value: '', multiline: true },
  ], 'Nothing is saved until you have read it. Drafted wordings stay marked unreviewed.');
  if (!asked || (!asked.repoUrl?.trim() && !asked.notes?.trim())) return;

  setStatus('Reading and drafting…');
  const stopChip = startDrafting(`Drafting a ${kind} entry`, () => showTab('resumes'));
  let result;
  try {
    result = await api('/ai/draft-entry', {
      method: 'POST',
      body: JSON.stringify({ repoUrl: asked.repoUrl, notes: asked.notes, kind }),
    });
  } catch (err) {
    showModal('Could not draft it', el('pre', { textContent: err.message }));
    setStatus(err.message, true);
    return;
  } finally {
    stopChip();
  }

  if (!result.executed) {
    showModal(
      'The AI is switched off',
      el('div', {}, [
        el('p', {
          textContent:
            'Turn it on under Voice & AI to draft entries. Or copy what it would have been asked and paste it into a chat of your own — the reply comes back as a new entry you can paste in.',
        }),
        advanced('Show what it would have been asked', promptBlock(result.prompt)),
      ]),
    );
    setStatus('AI is off');
    return;
  }

  await reviewDraftedEntry(result.entry, result.repo, kind);
}

/** Show what came back and let it be edited before anything is written. */
/**
 * Wait for a background job, without holding a request open for it.
 *
 * Polling rather than a socket: the jobs list is already polled for the
 * toolbar chip, a store server has one client, and a second transport for a
 * thing that finishes in minutes is machinery nobody has to maintain.
 */
async function waitForJob(id, every = 2000) {
  for (;;) {
    const job = await api(`/ai/jobs/${encodeURIComponent(id)}`);
    if (job.status === 'failed') throw new Error(job.error ?? 'It failed, and said nothing about why.');
    if (job.status !== 'running') return job.result;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/**
 * Read everything in the corpus into a proposal, and offer it one at a time.
 *
 * One at a time is the whole design. A model that has read four files and
 * proposes eleven entries is proposing eleven decisions, and a single "Add
 * them all" makes those eleven into one — which is how a resume ends up with
 * a line nobody read on it. Each is shown with the sentence in the material it
 * came from, because "where did this come from" is the only question worth
 * asking about a bullet you did not write.
 */
async function readMaterial(notes) {
  const stop = showAiProgress(
    notes,
    'Reading your material',
    () => showTab('voice'),
    'This takes a few minutes for a few files. You can go and work on something else — it carries on.',
  );
  let result;
  try {
    /*
     * A background job, like feedback, because this is the longest-running
     * thing in the product: four files read end to end and an entry proposed
     * out of each. A request held open for four minutes is one a proxy or a
     * browser gives up on while the work carries on invisibly.
     */
    const { job } = await api('/ai/read-material', { method: 'POST', body: JSON.stringify({}) });
    result = await waitForJob(job.id);
  } catch (err) {
    setChildren(notes, el('div', { className: 'err', textContent: err.message }));
    return;
  } finally {
    stop();
  }

  if (!result.executed) {
    setChildren(notes, el('div', {}, [
      el('p', { textContent: 'The AI is switched off, so nothing was read. Turn it on under Voice & AI.' }),
      advanced('Show what it would have been asked', promptBlock(result.prompt)),
    ]));
    return;
  }

  const proposal = result.proposal ?? {};
  const entries = proposal.entries ?? [];
  const alternates = proposal.alternates ?? [];
  const orders = proposal.orders ?? [];

  if (entries.length === 0 && alternates.length === 0 && orders.length === 0) {
    setChildren(notes, el('div', {}, [
      el('p', {
        textContent:
          `Read ${plural(result.read?.length ?? 0, 'file')} and found nothing new to add — which usually means ` +
          'what is in them is already in your store.',
      }),
      proposal.notes ? el('p', { className: 'hint', textContent: proposal.notes }) : null,
    ]));
    return;
  }

  setChildren(notes, el('div', {}, [
    el('p', {
      textContent:
        `Read ${plural(result.read?.length ?? 0, 'file')}. ` +
        `${plural(entries.length, 'entry', 'entries')}, ${plural(alternates.length, 'other wording')}` +
        `${orders.length ? ` and ${plural(orders.length, 'entry', 'entries')} to reorder` : ''} to look at. ` +
        'Nothing is saved yet.',
    }),
    proposal.notes ? el('p', { className: 'hint', textContent: proposal.notes }) : null,
  ]));

  let added = 0;
  const failures = [];
  for (const entry of entries) {
    const accepted = await showModal(
      `From your material — ${entry.title}`,
      el('div', {}, [
        el('p', {
          className: 'hint',
          textContent: [entry.subtitle, entry.dates, entry.location].filter(Boolean).join(' · ') || entry.kind,
        }),
        el('ul', {}, (entry.bullets ?? []).map((b) =>
          el('li', {}, [
            el('div', { textContent: b.text }),
            // Where it came from, which is the only question worth asking
            // about a line you did not write.
            el('div', { className: 'hint', textContent: `from your material: “${b.source}”` }),
          ]),
        )),
        el('p', { className: 'hint', textContent: 'Every wording is saved unreviewed, so you can see what you have not read yet.' }),
      ]),
      { okLabel: 'Add it', showCancel: true, cancelLabel: 'Skip' },
    );
    if (!accepted) continue;

    let id = entry.id;
    for (let n = 2; state.store.entries.some((e) => e.id === id); n++) id = `${entry.id}_${n}`;
    describeNext(`adding "${entry.title}" from your material`);
    /*
     * One failing save must not take the rest of the list with it. You have
     * just said yes to eleven things one at a time; a throw on the fourth
     * would drop seven you had already agreed to, silently.
     */
    try {
      await saveEntry(
        {
          id,
          kind: entry.kind,
          title: entry.title,
          ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
          ...(entry.dates ? { dates: entry.dates } : {}),
          ...(entry.location ? { location: entry.location } : {}),
          bullets: (entry.bullets ?? []).map((b, i) => ({
            id: freeBulletId(`${id}_b${i + 1}`),
            default: 'v_read',
            variants: [{ id: 'v_read', label: b.label || 'From your material', text: b.text, suggested: true }],
          })),
        },
        `Added "${entry.title}" from your material`,
      );
      added++;
    } catch (err) {
      failures.push(`${entry.title}: ${err.message}`);
    }
  }

  for (const alt of alternates) {
    const entry = state.store.entries.find((e) => (e.bullets ?? []).some((b) => b.id === alt.bulletId));
    const bullet = entry?.bullets?.find((b) => b.id === alt.bulletId);
    if (!bullet) continue;
    const accepted = await showModal(
      'Another way you have put it',
      el('div', {}, [
        el('p', { className: 'hint', textContent: 'The line you have now:' }),
        el('p', { textContent: (bullet.variants.find((v) => v.id === bullet.default) ?? bullet.variants[0])?.text ?? '' }),
        el('p', { className: 'hint', textContent: 'From your material:' }),
        el('p', { textContent: alt.text }),
        el('div', { className: 'hint', textContent: `quoted from: “${alt.source}”` }),
      ]),
      { okLabel: 'Keep both', showCancel: true, cancelLabel: 'Skip' },
    );
    if (!accepted) continue;
    describeNext('adding a wording from your material');
    try {
      await saveEntry(
        {
          ...entry,
          bullets: entry.bullets.map((b) =>
            b.id !== alt.bulletId
              ? b
              : { ...b, variants: [...b.variants, { id: `v_read_${Date.now().toString(36)}`, label: alt.label || 'From your material', text: alt.text, suggested: true }] },
          ),
        },
        'Added a wording from your material',
      );
      added++;
    } catch (err) {
      failures.push(`${alt.bulletId}: ${err.message}`);
    }
  }

  /*
   * And the orders, last, because accepting one moves every resume that has
   * not arranged its own lines — so it is the proposal with the widest
   * reach and the one worth meeting after the small additive ones.
   *
   * Shown as the two orders side by side rather than as a list of ids. The
   * question being asked is "does this read better", and that cannot be
   * answered from `b_ec_pipeline, b_ec_testing`.
   */
  for (const order of orders) {
    const entry = state.store.entries.find((e) => e.id === order.entryId);
    if (!entry) continue;
    const textOf = (id) => {
      const bullet = (entry.bullets ?? []).find((b) => b.id === id);
      if (!bullet) return id;
      return String((bullet.variants?.find((v) => v.id === bullet.default) ?? bullet.variants?.[0])?.text ?? id);
    };
    const now = (entry.bullets ?? []).filter((b) => !b.archived).map((b) => b.id);
    const wanted = order.bullets.filter((id) => now.includes(id));

    const accepted = await showModal(
      `A different order — ${fieldText(entry.title, effectiveChoices(), `${entry.id}.title`) || entry.id}`,
      el('div', {}, [
        el('p', { className: 'hint', textContent: order.why }),
        el('p', { className: 'hint', textContent: 'It reads now:' }),
        el('ol', {}, now.map((id) => el('li', { textContent: textOf(id) }))),
        el('p', { className: 'hint', textContent: 'It would read:' }),
        el('ol', {}, wanted.map((id) => el('li', { textContent: textOf(id) }))),
        el('p', {
          className: 'hint',
          textContent:
            'This is the master’s order, so it moves every resume that has not arranged its own lines. The ones ' +
            'you arranged yourself stay as they are.',
        }),
      ]),
      { okLabel: 'Use this order', showCancel: true, cancelLabel: 'Leave it' },
    );
    if (!accepted) continue;
    try {
      await setMasterBulletOrder(entry, wanted);
      added++;
    } catch (err) {
      failures.push(`${order.entryId}: ${err.message}`);
    }
  }

  if (failures.length > 0) {
    // Said, not swallowed: you agreed to these, and a silent "nothing
    // happened" is the worst possible answer to that.
    setChildren(
      notes,
      el('div', { textContent: `Added ${plural(added, 'thing')}.` }),
      el('div', { className: 'err', textContent: `${plural(failures.length, 'one')} could not be saved:` }),
      ...failures.map((f) => el('div', { className: 'hint', textContent: f })),
    );
  }
  setStatus(added ? `Added ${plural(added, 'thing')} from your material` : 'Nothing added');
}

async function reviewDraftedEntry(entry, repo, kind) {
  const lines = (entry.bullets ?? []).flatMap((b) => b.variants.map((v) => `${v.label}: ${v.text}`));
  const accepted = await showModal(
    'Draft entry',
    el('div', {}, [
      el('p', { className: 'hint', textContent: repo ? `From ${repo.owner}/${repo.name}.` : 'From what you wrote.' }),
      el('h3', { textContent: entry.title }),
      el('p', {
        className: 'hint',
        textContent: [entry.subtitle, entry.dates, entry.location].filter(Boolean).join(' · '),
      }),
      el('ul', {}, lines.map((t) => el('li', { textContent: t }))),
      el('p', { className: 'hint', textContent: 'Every wording is saved unreviewed, so you can see at a glance what you have not read yet.' }),
    ]),
    { okLabel: 'Add it', showCancel: true },
  );
  if (!accepted) return;

  // Ids are assigned by the server, but the store is the client's to keep
  // unique — another entry may have been added since. The lines need the same
  // treatment as the entry: the server names them after the title, and a
  // second draft about the same company would otherwise carry the first's
  // line ids, which is one shared chosen wording between two unrelated lines.
  let id = entry.id;
  for (let n = 2; state.store.entries.some((e) => e.id === id); n++) id = `${entry.id}_${n}`;
  const bullets = (entry.bullets ?? []).map((b) => ({ ...b, id: freeBulletId(b.id) }));

  describeNext(`drafting "${entry.title}"`);
  await saveEntry({ ...entry, id, kind: entry.kind ?? kind, bullets }, `Added "${entry.title}"`);
  setStatus(`Added "${entry.title}" — every wording is unreviewed`);
}

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
      ? [{ id: freeBulletId(`b_${slug(answer.title)}_1`), default: 'v_base', variants: [{ id: 'v_base', label: 'Base', text: answer.bullet.trim() }] }]
      : [],
  };

  /*
   * The entry and the section that lists it are one thing the user did, so
   * they are one press of Ctrl+Z.
   *
   * `removeEntry` was grouped and this was not, even though the note on
   * `openGroup` names adding an entry as the other half of the same case.
   * Recorded per request, "+ Add entry" cost two presses — and the state
   * between them is one no action ever produced: the entry is still in the
   * save and nothing points at it. On screen the first press looked like it
   * had worked, so the orphan stayed, showed up in the master view and the
   * pickers, and became permanent as soon as the next edit dropped the redo
   * stack.
   */
  await undoGroup(`add ${answer.title.trim()}`, [], async () => {
    // In the entry's lane like every other write to it, so a phrasing or an
    // edit queued against the same id cannot cross with this one.
    await inEntryLane(id, async (lane) => {
      lane.server = await api(`/entries/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(entry) });
    });

    if (state.masterView) return;

    /*
     * A new entry nobody references is invisible, so it is switched on in the
     * resume being edited — that one and no other.
     *
     * It used to go to the root of the inheritance chain, so every variation
     * got it. Resumes stand alone now, and quietly writing into a resume other
     * than the open one is exactly the surprise that was worth removing. The
     * entry itself is in the save either way; switching it on elsewhere is a
     * tick per resume, and a decision rather than a side effect.
     */
    const root = resumeById(state.resumeId);
    const rootEntries = (id2) => (root.sections ?? []).find((s) => s.kind === id2)?.entries ?? [];
    const sections = (root.sections ?? []).map((s) =>
      s.kind === kind ? { ...s, entries: [...(s.entries ?? []), id] } : s,
    );
    if (!sections.some((s) => s.kind === kind)) {
      sections.push({ kind, entries: [...rootEntries(kind), id] });
    }
    await saveResumeSpec({ ...root, sections }, `Added ${id}`);
  });

  if (state.masterView) {
    render();
    scheduleRender();
    setStatus('Added to the master. Select it in a tailored resume when needed.');
    return;
  }

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

  /*
   * The same refusal the alternates dropdown gives, on the form that was the
   * other way in.
   *
   * Deleting the last alternate of a title says "An entry needs a title —
   * rewrite it rather than deleting it"; emptying the box here simply did
   * `delete next.title` and saved. Nothing downstream asks for one, so the
   * entry went to the renderer nameless and printed a blank where the
   * employer's name belongs.
   */
  if (!isVariantField(entry.title) && !answer.title?.trim()) {
    setStatus('An entry needs a title — rewrite it rather than clearing it', true);
    return;
  }

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
  // The entry and the resume that pointed at it are one thing the user did, so
  // they are one press of Ctrl+Z — not two, with an orphaned reference in
  // between that no action ever produces.
  await undoGroup(`delete ${entryName(entry)}`, [], async () => {
    /*
     * In the lane, so a whole-entry write still queued behind it goes first.
     * `PUT /entries/:id` has no existence check, so a delete that overtook one
     * saw the entry recreated a moment later as an orphan no resume references.
     */
    await inEntryLane(entry.id, async (lane) => {
      await api(`/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      lane.server = null;
    });

    // Drop the reference too, so the next compile does not warn about it.
    const root = resumeById(state.resumeId);
    const sections = (root.sections ?? []).map((s) => ({
      ...s,
      entries: (s.entries ?? []).filter((id) => id !== entry.id),
    }));
    await saveResumeSpec({ ...root, sections }, `Deleted ${entry.id}`);
  });
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

  const id = freeBulletId(`b_${slug(entry.id).replace(/^(exp|edu|proj)_/, '')}_${(entry.bullets?.length ?? 0) + 1}`);

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
/**
 * Ask for other ways to say a line that already exists.
 *
 * Different from drafting an entry: the fact is settled and only the wording
 * is in question. The failure mode is an alternate that quietly claims more
 * than the original — hard to catch precisely because it reads better — so
 * each one is shown against the line it came from before anything is kept,
 * and kept marked unreviewed after.
 */
async function draftPhrasings(entry, target) {
  const asked = await form('Draft another wording', [
    { name: 'angle', label: 'Anything to aim for? (optional)', value: '' },
    { name: 'count', label: 'How many', value: '2' },
  ], 'Same claim, different wording. Nothing is saved until you have read it.');
  if (!asked) return;

  setStatus('Drafting…');
  const stopChip = startDrafting('Drafting another wording', () => showTab('resumes'));
  let result;
  try {
    result = await api('/ai/draft-phrasing', {
      method: 'POST',
      body: JSON.stringify({ entryId: entry.id, ...target, angle: asked.angle, count: Number(asked.count) || 2 }),
    });
  } catch (err) {
    showModal('Could not draft it', el('pre', { textContent: err.message }));
    setStatus(err.message, true);
    return;
  } finally {
    stopChip();
  }

  if (!result.executed) {
    showModal('The AI is switched off', el('div', {}, [
      el('p', {
        textContent:
          'Turn it on under Voice & AI to draft wordings. Or copy what it would have been asked and paste it into a chat of your own.',
      }),
      advanced('Show what it would have been asked', promptBlock(result.prompt)),
    ]));
    return;
  }

  const field = target.fieldName ? entry[target.fieldName] : entry.bullets.find((b) => b.id === target.bulletId);
  const current = isVariantField(field)
    ? (field.variants.find((v) => v.id === field.default) ?? field.variants[0])?.text ?? ''
    : String(field ?? '');

  const keep = new Set(result.variants.map((_, i) => i));
  const accepted = await showModal(
    'Drafted wordings',
    el('div', {}, [
      el('p', { className: 'hint', textContent: 'The line as it stands:' }),
      el('p', { textContent: current }),
      el('p', { className: 'hint', textContent: 'Untick anything that says more than that one does.' }),
      ...result.variants.map((v, i) =>
        el('label', { className: 'row' }, [
          el('input', {
            type: 'checkbox',
            checked: true,
            onchange: (e) => (e.target.checked ? keep.add(i) : keep.delete(i)),
          }),
          el('span', {}, `${v.label}: ${v.text}`),
        ]),
      ),
    ]),
    { okLabel: 'Add them', showCancel: true },
  );
  if (!accepted || keep.size === 0) return;

  const chosen = result.variants.filter((_, i) => keep.has(i));
  const existing = isVariantField(field) ? field : { default: 'v_base', variants: [{ id: 'v_base', label: current.slice(0, 24) || 'Default', text: current }] };
  const taken = new Set(existing.variants.map((v) => v.id));
  const added = chosen.map((v) => {
    let id = `v_${slug(v.label || v.text)}`;
    for (let n = 2; taken.has(id); n++) id = `v_${slug(v.label || v.text)}_${n}`;
    taken.add(id);
    return { id, label: v.label, text: v.text, suggested: true };
  });

  const nextField = { ...existing, variants: [...existing.variants, ...added] };
  const next = target.fieldName
    ? { ...entry, [target.fieldName]: nextField }
    : { ...entry, bullets: entry.bullets.map((b) => (b.id === target.bulletId ? { ...b, ...nextField } : b)) };

  describeNext(`drafting ${plural(added.length, 'wording')}`);
  await saveEntry(next, `Added ${plural(added.length, 'drafted wording')}`);
}

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

  /*
   * Adding a phrasing is a POST to a sub-resource, so nothing about it looks
   * like a whole-document write and it recorded no undo step at all — the only
   * way back was to find the new phrasing and delete it by hand. Naming the
   * document it changes makes it a step like any other.
   *
   * In the lane too: a whole-entry write queued beside this one would
   * otherwise rebase onto a copy of the entry without the new phrasing in it,
   * and delete it.
   */
  const variant = await undoGroup(`add phrasing to ${bulletName(entry, bullet)}`, [`entry:${entry.id}`], () =>
    inEntryLane(entry.id, () =>
    api(`/entries/${encodeURIComponent(entry.id)}/bullets/${encodeURIComponent(bullet.id)}/variants`, {
      method: 'POST',
      body: JSON.stringify({
        label: answer.label?.trim() || 'New phrasing',
        text: answer.text,
        tags: answer.tags ? answer.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        note: answer.note?.trim() || undefined,
      }),
    }),
    ),
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
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The date on an entry, edited as a date.
 *
 * It was a text box holding "Jul. 2024 -- Dec. 2024", which is the thing a
 * person has to get exactly right for the program to be able to sort by it —
 * and which the program then could not check, because any string is a valid
 * string. Two ends, a month and a year each, and the two switches that cover
 * everything else a resume date says.
 *
 * The month may be left blank: "2024" is a perfectly good date for a project,
 * and a control that forced a month onto it would be inventing precision the
 * person does not have. A blank month means the year as a whole, which is what
 * the model has always meant by a period with no month.
 *
 * The words that print are the server's business, not this control's: it sends
 * the period and the server renders the text in the style the rest of the
 * store already uses. That is why there is one implementation of the
 * formatting rather than two, and why nothing is respelt unless the date
 * itself moved.
 */
function dateEditor(entry) {
  return datesControl(entry.period, (period) => saveEntryPeriod(entry, period));
}

/**
 * The control itself, given a date and somewhere to send the new one.
 *
 * Separate from what it is bound to, because it is bound to two different
 * things: the entry's own date, where the server renders the words, and one
 * alternate of a field, where this side does. The controls are the same either
 * way, and so is what counts as a date.
 */
function datesControl(from, onChange) {
  const period = from ? structuredClone(from) : {};
  const wrap = el('div', { className: 'dates' });

  const commit = () => {
    const next = { ...period };
    // A start is what makes a date a date. Without one there is nothing to
    // record, and the text is left exactly as it was.
    if (!next.start?.year) return;
    if (next.ongoing) delete next.end;
    if (!next.end?.year) delete next.end;
    onChange(next);
  };

  /** One end of the range: a month that may be blank, and a year. */
  const end = (which, label) => {
    const value = () => period[which] ?? {};
    const month = el('select', { className: 'date-month', title: `${label} month, or blank for the whole year` });
    month.append(el('option', { value: '', textContent: '—' }));
    for (const [i, name] of MONTHS.entries()) {
      month.append(el('option', { value: String(i + 1), textContent: name.slice(0, 3), selected: value().month === i + 1 }));
    }
    month.onchange = () => {
      const n = Number(month.value);
      const now = { ...value() };
      if (n) now.month = n;
      else delete now.month;
      period[which] = now;
      commit();
    };

    const year = el('input', {
      className: 'date-year',
      type: 'number',
      min: '1900',
      max: '2100',
      step: '1',
      placeholder: 'Year',
      value: value().year ? String(value().year) : '',
      title: `${label} year`,
    });
    year.onchange = () => {
      const n = Number(year.value);
      if (n >= 1900 && n <= 2100) period[which] = { ...value(), year: n };
      else delete period[which];
      commit();
    };

    return el('span', { className: 'date-end' }, [
      el('span', { className: 'date-label', textContent: label }),
      month,
      year,
    ]);
  };

  const switches = el('span', { className: 'date-switches' }, [
    labelled('Still going', Boolean(period.ongoing), (on) => {
      period.ongoing = on;
      if (on) delete period.end;
      // `commit` saves, and the save redraws; calling renderEditor here as
      // well drew the row twice and the second one won, from stale state.
      commit();
    }, 'No end date yet — prints as "Present". Works the same on a project as on a job.'),
    labelled('Not yet', Boolean(period.expected), (on) => {
      period.expected = on;
      commit();
    }, 'A date still to come, such as a graduation — prints as "Expected"'),
  ]);

  wrap.append(end('start', 'From'));
  if (!period.ongoing) wrap.append(end('end', 'to'));
  wrap.append(switches);
  /*
   * A range that runs backwards, said beside the control that made it.
   *
   * Not refused: changing both ends means passing through a moment where
   * only one of them has moved, and a control that rejected that state
   * would be unusable. The resume's warnings say it too — see
   * `endsBeforeItStarts` — but by then you have looked away from the dates,
   * and this is the half-second where fixing it is free.
   */
  if (endsBeforeItStarts(period)) {
    wrap.append(
      el('span', {
        className: 'date-wrong',
        role: 'status',
        textContent: 'ends before it starts',
        title: 'The end of this range is earlier than its start. Nothing has been changed — check the two years.',
      }),
    );
  }
  return wrap;
}

/**
 * The date control, bound to one alternate of a field rather than to the entry.
 *
 * The words are written here rather than by the server, because the server
 * only renders the entry's own `dates` and these are phrasings of a field —
 * rewriting one of several from a period is a thing only the person editing
 * that one alternate has any business asking for. The style still comes from
 * the rest of the store, so the form written here is the form already in use,
 * and `tests/date-agreement.test.js` holds this side and the server's to the
 * same answers.
 */
function variantDateEditor(entry, name, variantId, period) {
  return datesControl(period, (next) => {
    const style = inferStyle(storeDateTexts());
    const text = formatPeriod(next, style);
    if (text) saveFieldText(entry, name, variantId, text);
  });
}

/** Every date already written down, for working out how this store writes them. */
function storeDateTexts() {
  const out = [];
  for (const entry of state.store?.entries ?? []) {
    const field = entry.dates;
    if (typeof field === 'string') out.push(field);
    else if (field?.variants) for (const v of field.variants) out.push(String(v.text ?? ''));
  }
  return out.filter(Boolean);
}

/** A checkbox with its words, which is two elements every single time. */
function labelled(text, on, onChange, title) {
  const box = el('input', { type: 'checkbox', checked: on });
  box.onchange = () => onChange(box.checked);
  return el('label', { className: 'date-switch', title: title ?? '' }, [box, el('span', { textContent: text })]);
}

/**
 * Save the date, and let the server decide what it should say.
 *
 * The entry goes up carrying its period; `withDatesFrom` on the other side
 * renders the text from it, in the style the rest of this store writes dates
 * in, and only when the period actually disagrees with what the text already
 * says. So editing a date rewrites that one date, and editing anything else
 * leaves every date in the store spelt exactly as its author spelt it.
 */
async function saveEntryPeriod(entry, period) {
  /*
   * On screen first, then on disk.
   *
   * `saveEntry` redraws when it returns, from the store the client is holding
   * — and that copy has not heard about this change yet, so the redraw put the
   * old date straight back. Ticking "Still going" left the far end sitting
   * there, filled in, on an entry that no longer had one.
   */
  const held = state.store?.entries?.find((e) => e.id === entry.id);
  if (held) held.period = period;
  await saveEntry({ ...entry, period }, 'Dates updated');
  /*
   * And then from the store, because the server has the last word on this
   * one: it renders the printed text from the period, in the style the rest
   * of the save uses, so the words on screen after an edit are the words that
   * will be on the page. The optimistic update above is what keeps the
   * control from flickering back to the old date in the meantime.
   */
  await loadStore();
  render();
  scheduleRender();
}

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
 * Take one wording of a line out of the save.
 *
 * The one thing here that only ever grew. Every other way of saying a line is
 * added — by hand, by "+ phrasing", and most of all by the AI, which is asked
 * for alternates a few at a time and never asked to take one back — and
 * nothing removed one. A line with nine wordings, six of them from a model
 * and two of them nearly the same sentence, is a picker nobody can use.
 *
 * Deleted rather than archived, and committed, which is the answer to "what
 * if I wanted it": the version history has it, the same as it has a deleted
 * entry. Archiving would keep the file growing and put the retired wordings
 * somewhere the editor then has to show.
 *
 * The last one cannot go. A bullet is its wordings — an empty variant set is
 * a line with no text, which every reader of it would have to special-case,
 * and "delete the line" is what that action already is.
 */
/**
 * What deleting one wording would cost, beyond the wording.
 *
 * Two things make a deletion more than local, and neither was said before
 * pressing it. A wording other resumes have *chosen* leaves them naming
 * something that is not there — `resolveResume` falls back to the default and
 * warns, which is right, but the warning turns up later on a build nobody
 * connected to this ("Choice edu_neu.subtitle asked for variant v_systems,
 * which does not exist"). And the *pinned* one is the answer every resume
 * that has not chosen gets, so deleting it moves all of them at once.
 *
 * The open resume is left out of the count: its own choice is cleared by the
 * callers as part of the delete, so it is not something that happens to
 * somebody else later.
 */
function variantFallout(key, variantId, isDefault, nextDefaultText) {
  const others = (state.store?.resumes ?? []).filter(
    (r) => r.id !== state.resumeId && (r.choices ?? {})[key] === variantId,
  );
  const lines = [];
  if (isDefault) {
    lines.push(
      `This is the pinned wording — what every resume that has not chosen another one gets. ` +
        `“${clipText(nextDefaultText, 50)}” becomes the pinned one instead.`,
    );
  }
  if (others.length > 0) {
    const named = others.slice(0, 3).map((r) => r.label ?? r.id);
    const rest = others.length - named.length;
    lines.push(
      `${plural(others.length, 'other resume')} ${others.length === 1 ? 'chooses' : 'choose'} it — ` +
        `${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}. ` +
        `${others.length === 1 ? 'It falls' : 'They fall'} back to the pinned wording.`,
    );
  }
  return lines;
}

/** A wording, short enough to put in a sentence. */
function clipText(text, max = 60) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function removeBulletVariant(entry, bullet, variant) {
  const remaining = bullet.variants.filter((v) => v.id !== variant.id);

  /*
   * The last wording of a line is the line.
   *
   * This used to refuse and say "delete the line itself instead", which is
   * correct about the model and unhelpful about the act: somebody deleting
   * the only phrasing of a line wants the line gone, and was sent to find
   * another button to do it with. It is offered here instead, named for what
   * it actually does.
   */
  if (remaining.length === 0) {
    const ok = await confirmModal(`Delete the line “${clipText(variant.text)}”?`, [
      'It is the only wording this line has, so the line goes with it.',
      ...variantFallout(bullet.id, variant.id, true, '(nothing)'),
    ].join(' '));
    if (!ok) return;
    await saveEntry({ ...entry, bullets: entry.bullets.filter((b) => b.id !== bullet.id) }, 'Line deleted');
    if (state.choices[bullet.id]) {
      const { [bullet.id]: _gone, ...rest } = state.choices;
      state.choices = rest;
      markDirty();
    }
    scheduleRender();
    return;
  }

  const left = remaining.length;
  const isDefault = bullet.default === variant.id;
  const ok = await confirmModal(
    `Delete “${clipText(variant.text)}”?`,
    [
      `This wording is removed from the save. The line keeps its other ${plural(left, 'phrasing')}.`,
      ...variantFallout(bullet.id, variant.id, isDefault, remaining[0].text),
    ].join(' '),
  );
  if (!ok) return;

  const next = {
    ...entry,
    bullets: entry.bullets.map((b) =>
      b.id !== bullet.id
        ? b
        : {
            ...b,
            variants: remaining,
            /*
             * Something has to be the default. Removing the pinned wording
             * without moving the pin leaves `default` naming a variant that
             * is gone, which resolves to "using default" and a warning on
             * every build for a reason nobody would connect to this.
             */
            default: b.default === variant.id ? remaining[0].id : b.default,
          },
    ),
  };
  await saveEntry(next, 'Phrasing deleted');
  /*
   * A resume that had chosen this wording now names one that is not there.
   * `resolveResume` says so and falls back to the default, which is the right
   * behaviour and is already tested — but the choice is this resume's and
   * clearing it here is what stops the warning appearing on a build the user
   * did not cause.
   */
  if (state.choices[bullet.id] === variant.id) {
    const { [bullet.id]: _gone, ...rest } = state.choices;
    state.choices = rest;
    markDirty();
  }
  scheduleRender();
}

/**
 * Take an alternate back off a heading field.
 *
 * The same act as deleting one wording of a line, on the other half of the
 * model — a role, a degree, a location, a graduation date. Lines had this and
 * headings did not, so a heading collected alternates and never lost one: an
 * AI-drafted degree line, a company name you tried two ways, a location from
 * before you moved. The only way back was to open the YAML.
 *
 * Never the last one. A field with one alternate left is a field that should
 * be a plain string, and collapsing it back to one is a different act with a
 * different answer — so this refuses, and says which act you wanted.
 */
async function removeFieldAlternate(entry, name, variant) {
  const field = entry[name];
  if (!isVariantField(field)) {
    setStatus('That field has no alternates to delete', true);
    return;
  }
  const remaining = field.variants.filter((v) => v.id !== variant.id);
  const key = `${entry.id}.${name}`;
  const label = FIELD_LABELS[name] ?? name;

  /*
   * The last alternate of a field.
   *
   * This used to refuse outright — "a field needs at least one wording" —
   * which is true of a field that stays and unhelpful to somebody who wants
   * it gone. A heading field is optional except for the title, which is what
   * the entry is called and cannot be nothing; so the title refuses and says
   * why, and the rest offer to take the field off the entry.
   */
  if (remaining.length === 0) {
    if (name === 'title') {
      setStatus('An entry needs a title — rewrite it rather than deleting it', true);
      return;
    }
    const gone = await confirmModal(`Delete the ${label} “${clipText(variant.text)}”?`, [
      `It is the only one this entry has, so the ${label} line goes with it.`,
      ...variantFallout(key, variant.id, true, '(nothing)'),
    ].join(' '));
    if (!gone) return;
    const { [name]: _dropped, ...without } = entry;
    await saveEntry(without, `${label} deleted`);
    if (state.choices[key]) {
      const { [key]: _stale, ...rest } = state.choices;
      state.choices = rest;
      markDirty();
    }
    scheduleRender();
    return;
  }

  const left = remaining.length;
  const ok = await confirmModal(
    `Delete “${clipText(variant.text)}”?`,
    [
      `This wording is removed from the save. ${label} keeps its other ${plural(left, 'alternate')}.`,
      ...variantFallout(key, variant.id, field.default === variant.id, remaining[0].text),
    ].join(' '),
  );
  if (!ok) return;

  await saveEntry(
    {
      ...entry,
      // Something has to be the default; see the note in removeBulletVariant.
      [name]: { ...field, variants: remaining, default: field.default === variant.id ? remaining[0].id : field.default },
    },
    'Alternate deleted',
  );
  if (state.choices[key] === variant.id) {
    const { [key]: _gone, ...rest } = state.choices;
    state.choices = rest;
    markDirty();
  }
  scheduleRender();
}

/** And the same for the profile name, which carries alternates like any field. */
async function removeNameAlternate(variant) {
  const field = state.store.profile.name;
  if (!isVariantField(field) || field.variants.length < 2) {
    setStatus('Your name needs at least one form', true);
    return;
  }
  const left = field.variants.length - 1;
  const ok = await confirmModal(
    `Delete “${String(variant.text)}”?`,
    `This form of your name is removed from the save. It keeps its other ${plural(left, 'form')}.`,
  );
  if (!ok) return;

  const remaining = field.variants.filter((v) => v.id !== variant.id);
  await saveProfileName(
    { ...field, variants: remaining, default: field.default === variant.id ? remaining[0].id : field.default },
    'Deleted a form of your name',
  );
  if (state.choices[PROFILE_NAME_KEY] === variant.id) {
    const { [PROFILE_NAME_KEY]: _gone, ...rest } = state.choices;
    state.choices = rest;
    markDirty();
    render();
  }
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

/**
 * One in-flight write for the skills list, and each change built when its turn
 * comes rather than when the button was pressed.
 *
 * Every skills write is a read-modify-write of the whole list: read
 * `state.store.skillGroups`, change one thing in it, PUT all of it. The store
 * is reloaded afterwards, and until that lands `state.store` still shows what
 * was there before — so a second write started inside that window builds its
 * list from the old one and puts back whatever the first had just removed.
 *
 * A form makes that window hard to hit. The × on a skill chip does not:
 * deleting three skills is three clicks with nothing in between, and the way
 * it failed was for one of them to reappear. Entries have had a lane for this
 * reason since they were given one; this is the same lane for the one other
 * list that is written whole.
 *
 * `change` is handed the groups as they stand when it runs, and returns the
 * list to write — or nothing, to write nothing at all.
 */
let skillsQueue = Promise.resolve();

function inSkillsLane(change) {
  const mine = skillsQueue.then(async () => {
    const groups = await change(state.store?.skillGroups ?? []);
    if (!groups) return undefined;
    const written = await api('/skills', { method: 'PUT', body: JSON.stringify(groups) });
    // Inside the lane, so the next change in the queue builds on this one
    // rather than on what was on screen before it.
    await loadStore();
    return written;
  });
  skillsQueue = mine.then(
    () => {},
    () => {},
  );
  return mine;
}

async function addSkill(group) {
  const answer = await form(`Add a skill to ${group.name}`, [
    { name: 'text', label: 'Skill', value: '' },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
  ], 'Tags are what the extension matches against a job posting.');
  if (!answer?.text?.trim()) return;

  await inSkillsLane((groups) =>
    groups.map((g) =>
      g.id !== group.id
        ? g
        : {
            ...g,
            items: [
              ...g.items,
              {
                // Against `g`, the group as it now stands, not the copy this
                // button was drawn from: a skill added a moment ago is in one
                // and not the other.
                id: freeSkillItemId(g, `s_${slug(answer.text)}`),
                text: answer.text.trim(),
                ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
              },
            ],
          },
    ),
  );
  setStatus('Skill added');
  render();
  scheduleRender();
}

async function removeSkill(group, item) {
  await inSkillsLane((groups) =>
    groups.map((g) => (g.id !== group.id ? g : { ...g, items: g.items.filter((i) => i.id !== item.id) })),
  );
  setStatus(`Removed ${item.text}`);
  render();
  scheduleRender();
}

async function addSkillGroup() {
  const answer = await form('New skill group', [
    { name: 'name', label: 'Group name, e.g. Languages', value: '' },
    { name: 'items', label: 'Skills, comma separated', value: '' },
  ]);
  if (!answer?.name?.trim()) return;

  /*
   * The group and the section that lists it, in one step.
   *
   * Same shape as adding an entry, and the same two problems: it cost two
   * presses, and the state in between is one no action produces. Deleting a
   * group was the worse of the pair — one press put the *reference* back
   * without the group, so `resolveResume` pushed `Skills group "sk_lang" does
   * not exist.` on every compile from then on.
   */
  await undoGroup(`add the group "${answer.name.trim()}"`, [], async () => {
    let id;
    await inSkillsLane((groups) => {
      id = freeSkillGroupId(groups, `sk_${slug(answer.name)}`);
      return [
        ...groups,
        {
          id,
          name: answer.name.trim(),
          // Built against what has already been taken from the same list:
          // "Python, Go, Python" is a typo, not two skills, and letting both be
          // `s_python` would leave the second unselectable and remove both at
          // once.
          items: (answer.items ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
            .reduce((items, text) => [...items, { id: freeSkillItemId({ items }, `s_${slug(text)}`), text }], []),
        },
      ];
    });

    // The open resume's own sections, for the reason given in addEntry.
    const root = resumeById(state.resumeId);
    const sections = (root.sections ?? []).map((s) =>
      s.kind === 'skills' ? { ...s, groups: [...(s.groups ?? []), id] } : s,
    );
    if (!sections.some((s) => s.kind === 'skills')) {
      sections.push({ kind: 'skills', entries: [], groups: [id] });
    }
    await saveResumeSpec({ ...root, sections }, 'Skill group added');
  });
  render();
  scheduleRender();
}

async function removeSkillGroup(group) {
  if (!(await confirmModal(`Delete "${group.name}"?`, 'The group and its skills are removed from the save.'))) return;
  /*
   * The group and the reference to it, in one step — see `addSkillGroup`.
   * One press used to put the reference back without the group, which is a
   * state no action produces: `resolveResume` then warns "Skills group
   * "sk_lang" does not exist." on every compile from then on.
   */
  await undoGroup(`delete the group "${group.name}"`, [], async () => {
    await inSkillsLane((groups) => groups.filter((g) => g.id !== group.id));
    const root = resumeById(state.resumeId);
    const sections = (root.sections ?? []).map((s) =>
      s.kind === 'skills' ? { ...s, groups: (s.groups ?? []).filter((g) => g !== group.id) } : s,
    );
    await saveResumeSpec({ ...root, sections }, 'Group deleted');
  });
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

/**
 * Something the tool needs and the person using it mostly does not.
 *
 * The prompts are thousands of words of instructions nobody here wrote, and
 * they were shown in full every time the AI was switched off — a modal whose
 * entire content was machinery. The command line and its `{prompt}` templates
 * are the same kind of thing: necessary, occasionally essential, and not what
 * anyone opens Settings to look at.
 *
 * `<details>` rather than a button that toggles a class, because it is the
 * one disclosure the browser already knows how to make keyboard- and
 * screen-reader-accessible, and because it stays open once opened — someone
 * who needs the command line usually needs it more than once.
 */
/**
 * A prompt, with the one thing anyone actually wants to do to it.
 *
 * Reading it is rare; pasting it into a chat window is the whole reason it is
 * offered at all. Selecting several thousand words out of a scrolling <pre>
 * by hand is not something to make somebody do.
 */
function promptBlock(text) {
  const body = el('pre', { className: 'prompt-dump', textContent: text ?? '' });
  const copy = el('button', {
    className: 'tiny',
    textContent: 'Copy',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text ?? '');
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      } catch {
        // No clipboard permission: the text is right there to select.
        copy.textContent = 'Select it and copy';
      }
    },
  });
  return el('div', {}, [el('div', { className: 'toolbar' }, [copy]), body]);
}

/**
 * Put text into a pane without taking the reader's place away.
 *
 * Assigning `textContent` replaces the node, so an unchanged value is not a
 * free write — it drops a selection somebody is part-way through making. And a
 * pane that has grown should follow the tail only if the reader was already at
 * the tail; otherwise reading back through a long run is impossible, which is
 * the state every one of these panes was permanently in.
 */
function keepPlace(node, text) {
  if (node.textContent === text) return;
  const tail = node.scrollHeight - node.scrollTop - node.clientHeight < 8;
  node.textContent = text;
  if (tail) node.scrollTop = node.scrollHeight;
}

function advanced(summary, ...children) {
  const box = el('details', { className: 'advanced' });
  box.append(el('summary', { textContent: summary }));
  for (const child of children) if (child != null && child !== false) box.append(child);
  return box;
}

/**
 * What the AI has been running, and whether the one running now is alive.
 *
 * The question a timeout cannot answer: a model part-way through a long
 * reasoning pass and a CLI sitting on a prompt it will never read both end as
 * "ran for longer than 180s and was stopped", and raising the timeout is the
 * right move for exactly one of them. What tells them apart is whether
 * anything has arrived lately, so that is what this leads with.
 *
 * Folded away and polled only while it is open. Nothing here is needed to use
 * the tool; it is needed on the day the tool will not work.
 */
/*
 * The mounted activity panel's own refresh, so the end of a run can reveal it.
 *
 * It is hidden while there is nothing to show and it only looks when it is
 * opened — which between them meant it looked once, before anything had run,
 * and stayed hidden for the rest of the session. Measured: "panel once a run
 * has happened: false".
 */
let refreshAiActivity = null;

function aiActivityPanel() {
  const list = el('div', { className: 'ai-runs' });
  const box = advanced('Advanced — what the AI has been running', list);
  /*
   * Always here, even with nothing in it yet.
   *
   * It used to hide itself until a run had happened, on the reasoning that a
   * disclosure promising an empty list is furniture. That was wrong about what
   * the thing is for. Asked for it, the answer was: "I don't actually see a
   * way to see the inner working of the AI assistant" — and there was not one,
   * because the live chips only exist while something is running and this only
   * existed after something had. On a fresh page there was no entry point
   * anywhere, which is precisely when somebody looking for one is looking.
   *
   * A closed disclosure costs a line. Knowing the window exists before you
   * need it is the whole point of a window.
   */
  box.hidden = false;

  const seconds = (ms) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

  /*
   * The sentence that decides what to do about it.
   *
   * "Running, quiet for 174s" and "Running, last spoke 2s ago" are the same
   * state as far as any spinner is concerned and opposite as far as the person
   * waiting is concerned.
   */
  const aliveness = (run) => {
    if (run.outcome !== 'running') return run.note ?? '';
    if (run.quietMs === null) return `nothing said yet, ${seconds(run.elapsedMs)} in`;
    return run.quietMs > 20_000
      ? `nothing for ${seconds(run.quietMs)} — it may be stuck`
      : `last spoke ${seconds(run.quietMs)} ago`;
  };

  /** The tail of one run's output, fetched only when asked for. */
  /**
   * Fill a run's detail pane, keeping the reader's place if it is already open.
   *
   * Called again on every poll for a row left open, so it cannot rebuild: the
   * fold would snap shut and the output would jump to the top while somebody
   * was reading up it. The pieces are made once per row and written into after
   * that, and a pane that is not already at its end is left where it is.
   */
  async function showOutput(run, into) {
    if (!into.dataset.built) into.textContent = 'Reading…';
    try {
      const full = await api(`/ai/activity/${encodeURIComponent(run.id)}`);
      const said = (full.chunks ?? [])
        .map((c) => `${String(Math.round(c.at / 100) / 10).padStart(6)}s ${c.stream === 'err' ? '!' : ' '} ${c.text.replace(/\n$/, '')}`)
        .join('\n');
      /*
       * What went in, then what came out.
       *
       * When an answer is wrong the question is nearly always what the model
       * was given, and until now there was no way to look at it: the argv
       * shows which CLI and which flags, and the prompt — the resume as it
       * stands, the posting, the letters written before, the instructions
       * about voice — went to a file in a scratch directory that is deleted
       * the moment the run ends.
       *
       * Folded, because it runs to tens of kilobytes and is not what you open
       * this panel for; above the output, because it is what the output is an
       * answer to.
       */
      const size = full.promptBytes >= 1024 ? `${Math.round(full.promptBytes / 1024)} KB` : `${full.promptBytes} bytes`;
      if (!into.dataset.built) {
        into.replaceChildren(
          el('div', { className: 'hint' }),
          advanced('What it was given', el('pre', { className: 'ai-run-output' })),
          el('div', { className: 'lbl', textContent: 'What it said' }),
          el('pre', { className: 'ai-run-output' }),
        );
        into.dataset.built = '1';
      }

      const [cmd, given, , out] = into.children;
      cmd.textContent = `${full.command} ${full.args.join(' ')}`;
      given.querySelector('summary').textContent =
        `What it was given — ${size}${full.promptCut ? ', middle not kept' : ''}`;
      keepPlace(given.querySelector('pre'), full.prompt || '(nothing)');
      keepPlace(
        out,
        (full.dropped ? `… ${full.dropped} earlier bytes not kept\n` : '') +
          (said || 'It printed nothing at all.'),
      );
    } catch (err) {
      if (!into.dataset.built) into.textContent = err.message;
    }
  }

  async function refresh() {
    let activity;
    try {
      activity = await api('/ai/activity');
    } catch {
      // The store answering nothing is its own problem, reported elsewhere.
      return false;
    }
    const runs = activity.recent ?? [];
    /*
     * Rows are kept and written into, not rebuilt.
     *
     * This list is polled while the disclosure is open, and replacing its
     * children each time closed whatever row you had opened and threw away
     * where you were in it — so following a run meant losing your place once a
     * second. The rows are keyed by run id; only a genuinely different set of
     * runs touches the DOM's shape.
     */
    const have = new Map([...list.children].map((row) => [row.dataset.run, row]));
    const rows = runs.map((run) => {
      const already = have.get(run.id);
      if (already) {
        have.delete(run.id);
        const head = already.querySelector('.ai-run');
        head.className = `ai-run ${run.outcome}`;
        head.querySelector('.ai-run-when').textContent = seconds(run.elapsedMs);
        head.querySelector('.ai-run-said').textContent = aliveness(run);
        // An open row keeps following its run, rather than freezing at
        // whatever it said when it was opened.
        const shown = already.querySelector('.ai-run-detail');
        if (!shown.hidden) void showOutput(run, shown);
        return already;
      }
      const output = el('div', { className: 'ai-run-detail', hidden: true });
      const head = el('button', {
        className: `ai-run ${run.outcome}`,
        onclick: () => {
          output.hidden = !output.hidden;
          if (!output.hidden) void showOutput(run, output);
        },
      }, [
        el('span', { className: 'ai-run-dot' }),
        el('span', { className: 'ai-run-cmd', textContent: run.command }),
        el('span', { className: 'ai-run-when', textContent: seconds(run.elapsedMs) }),
        el('span', { className: 'ai-run-said', textContent: aliveness(run) }),
      ]);
      const row = el('div', { className: 'ai-run-row' }, [head, output]);
      row.dataset.run = run.id;
      return row;
    });

    /*
     * Only when the set or the order has actually changed. `replaceChildren`
     * detaches and reinserts even the nodes it is handed back, which loses
     * scroll position just as surely as building new ones.
     */
    const same =
      list.children.length === rows.length &&
      rows.every((row, at) => list.children[at] === row);
    if (!same) list.replaceChildren(...rows);

    return runs.some((r) => r.outcome === 'running');
  }

  /*
   * Asked for only while somebody is looking, and only while something is
   * moving. A panel nobody has opened should not be putting a request a
   * second through a server that is busy running a model.
   */
  /*
   * One look on load, so the disclosure knows whether to exist at all — and
   * then nothing until it is opened. Without it a panel hidden for having no
   * runs stays hidden through a whole session of them.
   */
  void refresh();
  refreshAiActivity = refresh;

  let timer = null;
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  box.addEventListener('toggle', () => {
    stop();
    if (!box.open) return;
    void refresh();
    timer = setInterval(() => {
      if (!box.isConnected || !box.open) return stop();
      void refresh().then((busy) => {
        // Still poll when idle, slowly enough not to matter: a run can start
        // from the extension while this is open.
        if (!busy) return;
      });
    }, 1000);
  });

  return box;
}

/**
 * The run that is happening now, while it is happening.
 *
 * Opened from beside the clock on whichever AI button started it, so it is
 * reachable exactly when there is something to see and gone the moment there
 * is not. It follows the newest run rather than an id: by the time somebody
 * presses this, the run they mean is the one that is going.
 *
 * Two halves, and the first is the one that answers most questions: what the
 * model was given. The second says whether it is alive — `lastOutputAt` is
 * the difference between a model thinking and a CLI wedged on a prompt it
 * will never read, which is the one thing a timeout message cannot tell you.
 */
async function showLiveAiRun(doing = 'the AI') {
  const body = el('div', { className: 'ai-live' }, el('div', { className: 'hint', textContent: 'Looking…' }));
  // Whether a run was expected, which decides what "nothing here" means below.
  const busy = drafting.size > 0;
  showModal(busy ? `What ${doing.toLowerCase()} is doing` : 'What the AI has been doing', body);

  /*
   * Built once and then written into, rather than rebuilt every second.
   *
   * This redrew the whole window on every poll, which is a second's worth of
   * work destroyed once a second: the output pane jumped back to the top while
   * you were reading up it, the prompt fold snapped shut the moment you opened
   * it, and any text you had selected to copy was gone before you could copy
   * it. "Constantly resets scroll progress and whatnot" is exactly right, and
   * it made the one window whose job is to be watched not worth watching.
   *
   * So the shape is made once here, each tick sets the text on the pieces that
   * changed, and everything the browser is holding on your behalf — scroll
   * position, what is open, what is selected — is simply never touched.
   */
  const liveState = el('div', { className: 'ai-live-state' });
  const liveCommand = el('div', { className: 'hint' });
  const promptPre = el('pre', { className: 'ai-run-output' });
  const given = advanced('What it was given', promptPre);
  const saidPre = el('pre', { className: 'ai-run-output ai-live-said' });
  const shell = el('div', {}, [
    liveState,
    liveCommand,
    given,
    el('div', { className: 'lbl', textContent: 'What it has said' }),
    saidPre,
  ]);

  /**
   * Set text without throwing away where the reader is.
   *
   * Assigning `textContent` at all replaces the node, so an unchanged value is
   * not a free write: it drops a selection the user is part-way through making.
   * And a pane that has grown should follow the tail only if the reader was at
   * the tail — otherwise reading back through a long run is impossible, which
   * is the state this was permanently in.
   */


  let stopped = false;
  const closer = $('#modal-ok');
  const stopWatching = () => {
    stopped = true;
  };
  closer?.addEventListener('click', stopWatching, { once: true });

  const draw = async () => {
    if (stopped || $('#modal').classList.contains('hidden')) return false;
    let list;
    try {
      list = await api('/ai/activity');
    } catch (err) {
      body.replaceChildren(el('div', { className: 'hint', textContent: err.message }));
      return false;
    }
    // The newest, running or just finished: the one that was pressed for.
    const newest = (list.recent ?? [])[0];
    if (!newest) {
      /*
       * Two ways to arrive at nothing, and they want different sentences.
       * Opened from a button that has just started something, "no run" means
       * that step does not use the AI. Opened from the header while nothing is
       * happening — which is now possible, and is the ordinary way somebody
       * looks — it means the server has not run anything yet, which is not a
       * fault and should not read like one.
       */
      body.replaceChildren(
        el('div', {
          className: 'hint',
          textContent: busy
            ? 'No AI run has started. This may not be an AI step.'
            : 'Nothing has run yet. This is where an AI run shows what it was given and what it said — ' +
              'open it again while something is drafting to watch it happen.',
        }),
      );
      return false;
    }

    let full;
    try {
      full = await api(`/ai/activity/${encodeURIComponent(newest.id)}`);
    } catch {
      return false;
    }
    const said = (full.chunks ?? [])
      .map((c) => `${String(Math.round(c.at / 100) / 10).padStart(6)}s ${c.stream === 'err' ? '!' : ' '} ${c.text.replace(/\n$/, '')}`)
      .join('');
    const size = full.promptBytes >= 1024 ? `${Math.round(full.promptBytes / 1024)} KB` : `${full.promptBytes} bytes`;
    const alive =
      newest.outcome !== 'running'
        ? (newest.note ?? 'Finished.')
        : newest.quietMs === null
          ? 'Nothing said yet.'
          : newest.quietMs > 20_000
            ? `Nothing for ${Math.round(newest.quietMs / 1000)}s — it may be stuck.`
            : `Still going; last spoke ${Math.round(newest.quietMs / 1000)}s ago.`;

    // Put the shape up the first time; after that only the words change.
    if (!shell.isConnected) body.replaceChildren(shell);

    liveState.className = `ai-live-state ${newest.outcome}`;
    liveState.textContent = alive;
    liveCommand.textContent = `${full.command} ${full.args.join(' ')}`;
    given.querySelector('summary').textContent =
      `What it was given — ${size}${full.promptCut ? ', middle not kept' : ''}`;
    keepPlace(promptPre, full.prompt || '(nothing)');
    keepPlace(
      saidPre,
      (full.dropped ? `… ${full.dropped} earlier bytes not kept\n` : '') + (said || 'Nothing yet.'),
    );
    return newest.outcome === 'running';
  };

  await draw();
  const tick = setInterval(async () => {
    const going = await draw();
    // Stops itself when the run ends or the modal closes: this is a window on
    // something happening, and when nothing is, it is only a poll.
    if (!going) clearInterval(tick);
  }, 1000);
}

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

/**
 * Nothing to preview any more.
 *
 * The class alone was not enough: it only brings the placeholder back, and
 * the page already drawn stays where it was — so an emptied cover letter
 * showed its own last version with "type a first sentence" written across it.
 */
function clearPdf(frame) {
  previews.get(frame)?.clear?.();
  frame.classList.remove('loaded');
}

/** The "is what I see current?" indicator that replaced the Preview button. */
function setLive(mode) {
  const chip = $('#live-state');
  if (!chip) return;
  chip.className = `live ${mode}`;
  chip.textContent = mode === 'working' ? 'Updating…' : mode === 'bad' ? 'Compile failed' : 'Live';
}

/**
 * What the fit line says, given a compiled result.
 *
 * Shrinking is not a warning — it is a thing that happened to your document,
 * and the only unacceptable version of it is the silent one. It used to be a
 * grey clause appended after the word "Fits", which is precisely where nobody
 * looks once they have read "Fits". It now has its own line and its own
 * colour, because "this is on one page because it was squeezed" and "this is
 * on one page" are different facts about what you are about to send.
 */
function fitSummary(fit, result, { master, fitting = false } = {}) {
  fit.className = master || result.fits ? 'fit' : 'fit bad';
  fit.replaceChildren(
    master
      ? `Master Document · ${plural(result.pages, 'page')} · All source phrasings; may exceed two pages`
      : result.fits
        ? `Fits on one page${
            result.overflowLines < 0 ? ` — room for about ${plural(Math.abs(result.overflowLines), 'more line')}` : ''
          }`
        : `${plural(result.pages, 'page')} — about ${plural(result.overflowLines, 'line')} too long. Pick a shorter phrasing or drop a bullet.`,
  );

  if (master) return;

  if (fitting) {
    // Said while the second compile runs, so the half-second of truth on
    // screen is not mistaken for the final answer.
    fit.append(el('div', { className: 'squeezed working', textContent: 'Squeezing it onto one page…' }));
    return;
  }

  if (result.adjustments?.length) {
    fit.append(
      el('div', { className: 'squeezed' }, [
        el('strong', { textContent: 'Squeezed to fit' }),
        el('span', { textContent: ` — ${result.adjustments.join(', ')}` }),
      ]),
    );
  }
}

/**
 * Compile what is on screen, in two passes when it needs them.
 *
 * Auto-fit is a search: compile, measure, shrink, compile again, until the
 * least shrinking that fits is found. On a document that fits, the first
 * attempt is the answer and it costs one compile — measured at 0.47s. On one
 * that is slightly too long it costs seven, measured at 6.8s, and the editor
 * spent all of it holding the previous page on screen with no page count, no
 * overflow figure and nothing moving. That is the "it just freezes" that gets
 * reported, and it lands exactly when somebody is trying to cut a line and
 * needs to see what they cut.
 *
 * So the first pass asks for the document as written, with no shrinking. It
 * comes back in half a second with the real page count and a PDF of every page
 * it truly spills onto. If that fits, there was never a second pass to do. If
 * it does not, the fitted compile runs after it and swaps in — and the line
 * underneath says which it is you are looking at.
 */
async function renderPreview() {
  const token = ++renderToken;
  const fit = $('#fit');
  setLive('working');
  if (fit.classList.contains('idle')) fit.textContent = 'Compiling…';

  const master = state.masterView;
  const body = (extra) => JSON.stringify(master ? { master: true, ...extra } : { spec: currentSpec(), ...extra });

  try {
    const asWritten = await api('/render', { method: 'POST', body: body({ fit: 'as-written' }) });
    // A newer edit already asked for a newer compile; this answer is stale.
    if (token !== renderToken) return;

    showPdf($('#preview-pane'), asWritten.pdfUrl);
    $('#warnings').replaceChildren(...(asWritten.warnings ?? []).map((w) => el('div', { textContent: w })));

    // It fits as authored, or nothing is allowed to shrink it. Either way this
    // is the answer, and there is no second compile to pay for.
    if (master || asWritten.fits || !autoFitOn()) {
      setLive('ok');
      fitSummary(fit, asWritten, { master });
      return;
    }

    fitSummary(fit, asWritten, { master, fitting: true });

    const fitted = await api('/render', { method: 'POST', body: body({}) });
    if (token !== renderToken) return;
    setLive('ok');
    showPdf($('#preview-pane'), fitted.pdfUrl);
    fitSummary(fit, fitted, { master });
    $('#warnings').replaceChildren(...(fitted.warnings ?? []).map((w) => el('div', { textContent: w })));
  } catch (err) {
    if (token !== renderToken) return;
    setLive('bad');
    fit.className = 'fit bad';
    fit.textContent = err.message;
  }
}

/** Whether this resume is allowed to shrink itself to fit. */
function autoFitOn() {
  const spec = resumeById(state.resumeId);
  return spec?.layout?.autoFit ?? true;
}

/**
 * Delete the variation you are looking at.
 *
 * The store and the server could always do this; the editor had no control
 * for it, so a resume made by one press of "Save as variation…", or by the
 * extension tailoring a posting, could only ever be accumulated. A store a
 * year into applying is mostly resumes for postings that closed months ago,
 * and the picker is the place that cost is paid.
 *
 * It refuses on the master, which is not a variation but the source every
 * variation is a selection over, and on the last resume standing — a store
 * with no resume in it has nothing to open, and "delete" should not be a way
 * to reach a state the rest of the app cannot handle.
 *
 * Nothing else moves. Resumes stand alone, so a resume copied from this one
 * holds its own sections and is untouched by this going — which is the whole
 * of what deleting has to do now, and used to be a rewrite of every child on
 * the way past. Said out loud in the confirmation, because "and everything
 * based on it" is the fear.
 */
async function deleteVariation() {
  if (state.masterView) {
    setStatus('The master is not a variation — it is what they are all made from', true);
    return;
  }
  const mine = resumeById(state.resumeId);
  if (!mine) return;
  if ((state.store.resumes ?? []).length < 2) {
    setStatus('This is the only resume in the save', true);
    return;
  }

  const copies = (state.store.resumes ?? []).filter((r) => r.copiedFrom === mine.id);
  const ok = await confirmModal(`Delete “${mine.label ?? mine.id}”?`, [
    'It is removed from the save. The entries and wordings it selected are the store’s and stay.',
    // Said because the list shows where each copy came from, so the name is
    // about to stop resolving there. Nothing about the copies themselves
    // changes — they hold their own sections and always did.
    copies.length > 0
      ? `${plural(copies.length, 'resume')} copied from it ${copies.length === 1 ? 'is' : 'are'} untouched.`
      : null,
    'The version history keeps it, the way it keeps a deleted entry.',
  ].filter(Boolean).join(' '));
  if (!ok) return;

  /*
   * Somewhere else first, and only then the delete.
   *
   * This used to delete and then set `state.resumeId = null`, which is not
   * anywhere: the editor sat on the resume it had just removed until the
   * reload came back, and then on nothing at all, with the dropdown blank and
   * the preview showing a document that no longer exists. You had to go and
   * pick something before the editor was an editor again — after an action
   * whose whole point was to stop dealing with this one.
   *
   * The neighbour in the list the dropdown draws, so it moves the way
   * stepping down that list would, and the one above when this was the last.
   * There is always one: the button is hidden while the save holds a single
   * resume.
   *
   * Doing it in this order also means a delete that fails leaves you on a
   * resume that exists rather than on nothing, with the one you tried to
   * remove still in the list to try again.
   */
  const order = [...(state.store.resumes ?? [])].sort(
    (a, b) => TIER_ORDER.indexOf(tierOf(a)) - TIER_ORDER.indexOf(tierOf(b)),
  );
  const at = order.findIndex((r) => r.id === mine.id);
  const landing = order[at + 1] ?? order[at - 1];

  clearEdits();
  state.masterView = false;
  state.resumeId = landing?.id ?? null;
  location.hash = '';
  setSaveState('saved');
  render();
  scheduleRender();

  try {
    await api(`/resumes/${encodeURIComponent(mine.id)}`, { method: 'DELETE' });
    setStatus(`Deleted “${mine.label ?? mine.id}”`);
  } catch (err) {
    /*
     * Caught here rather than left to reject into nothing. A delete the store
     * refuses — a folder that is not writable, a save that has changed under
     * the editor — is something the person has to be told, and this is the
     * only place that knows which resume it was about.
     */
    setStatus(`“${mine.label ?? mine.id}” was not deleted — ${err.message}`, true);
  } finally {
    // Whether it went or not: the list on screen has to agree with the store.
    await loadStore();
    render();
  }
}

async function saveAsVariation() {
  /*
   * The name first, because that is the thing anyone is actually deciding.
   *
   * The id was first and therefore focused, so the field you landed in asked
   * for a filename — and the note underneath named the resume this one
   * inherits from by *its* id too, so the sentence read `Inherits from
   * "newgrad"` about a resume called "New grad". The id still has a box,
   * because the store is files and some people care what they are called; it
   * is no longer the question you are asked first.
   */
  const parentLabel = resumeById(state.resumeId)?.label ?? state.resumeId;
  const answer = await form('Save as variation', [
    { name: 'label', label: 'Name', value: `${parentLabel} variation` },
    { name: 'id', label: 'Filename', value: `${state.resumeId}-variant` },
  ], `A copy of ${parentLabel} as it is right now. The two are separate from here on — editing either leaves the other alone.`);
  if (!answer) return;

  /*
   * A cleared filename is not a reason to do nothing silently. It used to be:
   * the guard returned, the modal closed, and the variation you had just
   * named simply did not exist.
   */
  const chosenLabel = answer.label?.trim();
  const chosenId = slug(answer.id?.trim() || chosenLabel || '');
  if (!chosenId) return;

  /*
   * A variation is the whole bundle: which entries and bullets are switched
   * on, which phrasings are used, and which list items are shown. Saving only
   * the phrasings would silently drop half of what you just did — and now
   * that nothing resolves through the resume it came from, saving only what
   * changed in this session would drop everything the original decided.
   *
   * `currentSpec()` is that whole bundle already: the open resume plus this
   * session's unsaved edits. So the copy is it, renamed.
   */
  const built = currentSpec();
  const spec = {
    ...built,
    id: chosenId,
    label: chosenLabel || chosenId,
    copiedFrom: state.resumeId,
    /* A variation somebody named and saved is theirs to keep, not a draft. */
    tier: 'extended',
  };
  // What the original *was* stays with the original. See flatten.ts.
  delete spec.base;
  delete spec.generatedFor;
  delete spec.extends;

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
    const ran = full.result?.executed;
    $('#feedback-status').textContent = full.status === 'failed'
      ? 'Feedback failed'
      : ran ? full.about : 'The AI is off, so there is no feedback';
    if (full.status === 'failed') {
      $('#feedback-content').textContent = full.error ?? 'Unknown error';
    } else if (!ran) {
      /*
       * Not the prompt, dumped into the panel where feedback goes.
       *
       * With the AI off this filled the feedback pane with several thousand
       * words of instructions nobody here wrote, under a heading that said
       * feedback — which reads as the tool having answered. Say what
       * happened, and keep the machinery behind a disclosure for the one
       * person in twenty who wants to paste it somewhere.
       */
      $('#feedback-content').replaceChildren(
        el('p', {
          textContent:
            'Nothing was read, because the AI command is switched off. Turn it on under Voice & AI, or copy the request below into a chat of your own and paste what comes back wherever you like.',
        }),
        advanced('Show what it would have been asked', promptBlock(full.result?.output ?? '')),
      );
    } else {
      $('#feedback-content').replaceChildren(renderFeedbackMarkdown(full.result?.output ?? ''));
    }
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

/**
 * What each stage is called, and what it is called in the file.
 *
 * The file keeps short keys because they are hand-edited and matched in code;
 * the dropdown showed them raw, so the tracker offered `interested` and
 * `applying` as if the reader were expected to know the schema. It is a
 * ladder and it reads like one: not applied, applying, applied, interviewing,
 * got it — and closed, for the ones that end.
 */
const STATUSES = [
  ['interested', 'Not applied'],
  ['applying', 'Applying'],
  ['applied', 'Applied'],
  ['interview', 'Interviewing'],
  ['offer', 'Got it!'],
  ['closed', 'Closed'],
];

/** The stage under the name the reader knows it by, wherever it is printed. */
const statusLabel = (s) => STATUSES.find(([key]) => key === s)?.[1] ?? s;

/* ---- The one unserious thing in here ---------------------------------- *
 *
 * Dragging a row to "Got it!" is the only event in this whole program that
 * is unambiguously good news, and it looked exactly like moving it to
 * "Closed". It is a job search: the software can be pleased for you once.
 *
 * Deliberately cheap — emoji, two keyframes, no assets and no network — and
 * it turns itself off from the banner it appears in, because the first
 * question anyone has about a thing like this is how to stop it.            */

const CELEBRATE = 'rmm.celebrate';
const celebrating = () => localStorage.getItem(CELEBRATE) !== 'off';

const CATS = ['🐱', '😸', '😻', '😹', '🐈', '🐈‍⬛', '🙀', '🎉', '✨', '🎊'];

function celebrate(company) {
  if (!celebrating()) return;

  const stage = el('div', { className: 'party' });
  for (let i = 0; i < 60; i++) {
    stage.append(
      el('span', {
        className: 'cat',
        textContent: CATS[Math.floor(Math.random() * CATS.length)],
        // Scattered across the top, each falling at its own pace, so it reads
        // as confetti rather than as a row of identical cats.
        style: `left:${Math.random() * 100}%;
                font-size:${18 + Math.random() * 34}px;
                animation-delay:${Math.random() * 1.6}s;
                animation-duration:${2.4 + Math.random() * 2.2}s;
                --spin:${Math.random() > 0.5 ? 1 : -1};`,
      }),
    );
  }

  const banner = el('div', { className: 'party-banner' }, [
    el('div', { className: 'shout', textContent: 'GOT IT!!!' }),
    el('div', { textContent: company ? `${company} said yes.` : 'They said yes.' }),
    el('button', {
      className: 'link',
      textContent: 'turn this off',
      onclick: () => {
        localStorage.setItem(CELEBRATE, 'off');
        stage.remove();
        setStatus('No more cats. Clear the site data, or set rmm.celebrate, to bring them back.');
      },
    }),
  ]);
  stage.append(banner);
  document.body.append(stage);
  setTimeout(() => stage.remove(), 6000);
}

/**
 * When this application actually went out.
 *
 * `appliedAt` is when the row was started, which for anything begun from the
 * extension is the moment the posting was opened — days before it was sent,
 * and sometimes never sent at all. The history knows better: the first time
 * the status became `applied` is the day it left.
 */
function sentOn(a) {
  const went = (a.history ?? []).find((h) => h.status === 'applied');
  if (went?.at) return went.at.slice(0, 10);
  // Rows from before the history was kept, or filed straight as applied.
  return ['applied', 'interview', 'offer', 'closed'].includes(a.status) ? (a.appliedAt?.slice(0, 10) ?? '') : '';
}

let openApplicationId = null;

/*
 * What the tracker is showing, out of everything it holds.
 *
 * The table listed every application ever filed, newest first, with no way to
 * narrow it — and the list only grows: one row per application, for as long as
 * somebody is looking for work. The questions people actually have of it are
 * "what am I waiting to hear back on", "what have I not finished", and "did I
 * apply to these people already", and all three were answered by scrolling.
 *
 * Kept out here because `loadApplications` runs again after every status
 * change, and a filter that clears itself when you move a row to Interviewing
 * is worse than no filter.
 */
let appFilter = { text: '', status: '' };

async function loadApplications() {
  const { applications, stats, current } = await api('/applications');

  // Where to point a file picker: everything still in flight, in one folder,
  // already named the way portals want it.
  const files = $('#current-files');
  if (files) {
    setChildren(
      files,
      // The same page the extension opens, from the tab that lists what is in
      // it: a path is for the upload dialog, a link is for everything else.
      el('a', { className: 'meta-label', href: '/current', target: '_blank', textContent: 'Ready to upload' }),
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
      /*
       * And what is missing from it, which the count above cannot say.
       *
       * The sync reports by name any file it could not put here — a folder of
       * yours sitting where a file should go, a file open and locked, a full
       * disk — and finishes the rest rather than failing the request. That is
       * the right behaviour and it was silent: the line above would read "3
       * files still being sent" while the fourth, the one you are about to
       * attach, was not there. This is the folder a portal's file picker is
       * pointed at, so the gap has to be visible from the folder.
       */
      ...(current?.problems ?? []).map((said) => el('span', { className: 'hint warn', textContent: said })),
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
        'Applications land here when you use “Prepare to submit” in the browser extension, or run ',
        el('code', {}, 'rmm apply'),
        '.',
      ]),
    );
    return;
  }

  /*
   * The stats above stay about the whole hunt — "total" means total, and a
   * response rate over a filtered slice would be a different number wearing
   * the same label. Only the table narrows.
   */
  const wanted = (a) => {
    if (appFilter.status && a.status !== appFilter.status) return false;
    if (!appFilter.text) return true;
    const said = appFilter.text.toLowerCase();
    return `${a.company ?? ''} ${a.role ?? ''}`.toLowerCase().includes(said);
  };
  const showing = applications.filter(wanted);

  const count = $('#app-count');
  if (count) {
    count.textContent =
      showing.length === applications.length
        ? ''
        : `${showing.length} of ${plural(applications.length, 'application')}`;
  }

  const rows = [...showing]
    .sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))
    .map((a) => {
      const sel = el('select');
      for (const [s, label] of STATUSES) {
        sel.append(el('option', { value: s, textContent: label, selected: s === a.status }));
      }
      sel.onchange = async () => {
        const moved = sel.value;
        await api(`/applications/${encodeURIComponent(a.id)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: moved }),
        });
        setStatus('Status updated');
        // Once, on the way in — not every time the list repaints with an
        // offer already on it.
        if (moved === 'offer' && a.status !== 'offer') celebrate(a.company);
        loadApplications();
      };
      const row = el('tr', { className: a.id === openApplicationId ? 'selected' : '' }, [
        // Both dates get the same treatment: "2026-09-" over "17" is not a
        // date, and wrapping the narrowest column steals two lines of height
        // from every row to save nothing.
        el('td', { className: 'when', textContent: a.appliedAt?.slice(0, 10) ?? '' }),
        el('td', { textContent: a.company }),
        el('td', { textContent: a.role }),
        el('td', {}, [sel]),
        // Blank, not a dash: an em-dash in a date column reads as a date that
        // failed to load rather than as one that has not happened.
        el('td', { className: 'when', textContent: sentOn(a) }),
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

  if (rows.length === 0) {
    // Not the same fact as an empty tracker, and not worth confusing with it.
    wrap.replaceChildren(
      el('div', { className: 'empty' }, [
        el('b', {}, 'Nothing matches'),
        `${plural(applications.length, 'application')} filed; none of them match what you are looking for.`,
      ]),
    );
    return;
  }

  wrap.replaceChildren(
    el('table', {}, [
      el('thead', {}, [
        /*
         * Two dates, because there are two. "Started" is when the row opened —
         * usually the day the posting was read — and "Sent" is the day it went
         * out. The column that said "Sent" held the letter and the answers
         * that went with it, which is neither.
         */
        el(
          'tr',
          {},
          ['Started', 'Company', 'Role', 'Status', 'Sent', 'Enclosed', ''].map((h) => el('th', { textContent: h })),
        ),
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
    const { application: a, resume, copiedFromLabel, letter, files } = await api(`/applications/${encodeURIComponent(id)}`);

    const sections = [];

    sections.push(
      el('div', { className: 'sect' }, [
        el('h4', {}, 'Resume sent'),
        /*
         * By its label. This printed "Summer intern (intern)" — the id in
         * brackets after the name, in a monospace face, which is the sort of
         * thing the rest of the editor stopped doing a while ago. The id is
         * still there on hover for anyone who wants to go looking in the
         * folder.
         */
        el('div', {
          className: 'file',
          textContent: resume ? resume.label : `${a.role} — ${a.company}`,
          title: resume ? `Stored as ${resume.id}.yaml` : '',
        }),
        /*
         * And a sentence when the resume is no longer in the save, rather
         * than its filename.
         *
         * This printed `a.resumeId` — `job-helios-platform-engineer`, a
         * filename with nothing to say — and that used to be the rare case of
         * somebody having deleted one by hand. The sweep makes it the
         * ordinary state of every application older than a week, so it is
         * worth a sentence: what went, what did not, and where to find it.
         *
         * The two things that matter are both still true. The files that were
         * actually sent are in this application's own folder and are listed
         * further down this same pane; and the resume is in the version
         * history, which is where every other deleted thing in this program
         * is.
         */
        !resume && a.resumeId
          ? el('div', {
              className: 'hint',
              textContent:
                'This resume was made for this posting and has since been removed from the save. ' +
                'The files that were sent are below, and the version history still has it.',
              title: `Was ${a.resumeId}.yaml`,
            })
          : null,
        // And the base by its name too: "Built on base." was an id with a
        // full stop after it, not a sentence.
        copiedFromLabel ? el('div', { className: 'hint', textContent: `Copied from ${copiedFromLabel}.` }) : null,
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
                el('span', { textContent: `${statusLabel(h.status)}${h.note ? ` — ${h.note}` : ''}` }),
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
  // As in `openDraft`: the row has to be marked as the selected one, and a
  // failure to repaint should say so rather than land in the console.
  loadApplications().catch((err) => setStatus(err.message, true));
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
/*
 * How many are in the list, so the pane beside it can stop telling you to
 * pick one when there are none to pick. "Nothing open — pick an application
 * on the left" over an empty left column is advice that cannot be followed,
 * printed beside two other paragraphs saying the same thing a third way.
 */
let draftsInList = 0;

async function loadDrafts() {
  const { drafts } = await api('/workspace');
  const list = $('#draft-list');
  draftsInList = drafts.length;

  if (drafts.length === 0) {
    setChildren(
      list,
      // Short: the paragraph above this box already says where these come
      // from, and the pane beside it says it once more with what to do.
      el('div', { className: 'empty' }, [el('b', {}, 'Nothing yet')]),
    );
    if (!openDraftId) renderDraft(null);
    return;
  }

  /*
   * Still being written first, already sent underneath.
   *
   * Sending it does not close the space — the follow-up question, the portal
   * that rejected the upload, and the recruiter who asks for the letter again
   * all want the thing you wrote rather than a snapshot of it. But it is no
   * longer work, so it stops competing with work: below the live ones, greyed,
   * and gone on its own two weeks after the last keystroke.
   */
  const sent = (d) => d.status === 'submitted';
  const ordered = [...drafts].sort((a, b) => Number(sent(a)) - Number(sent(b)));
  const firstSent = ordered.findIndex(sent);

  setChildren(
    list,
    ...ordered.flatMap((d, at) => {
      const answered = d.questions.filter((q) => q.answer.trim()).length;
      const letterDone = !d.coverLetter.required || Boolean(d.coverLetter.body.trim());
      const ready = letterDone && answered === d.questions.length;

      const card = el(
        'div',
        {
          className: `draft-card${d.id === openDraftId ? ' selected' : ''}${sent(d) ? ' sent' : ''}`,
          onclick: () => openDraft(d.id),
        },
        [
          el('div', { className: 'co', textContent: d.company }),
          el('div', { className: 'role', textContent: d.role }),
          el('div', { className: 'bits' }, [
            // What is missing only matters while it can still be added.
            !sent(d) && d.coverLetter.required
              ? el('span', {
                  className: `badge ${d.coverLetter.body.trim() ? 'done' : 'required'}`,
                  textContent: d.coverLetter.body.trim() ? 'letter written' : 'letter needed',
                })
              : null,
            !sent(d) && d.questions.length
              ? el('span', {
                  className: `badge ${answered === d.questions.length ? 'done' : 'required'}`,
                  textContent: `${answered}/${d.questions.length} answered`,
                })
              : null,
            !sent(d) && ready ? el('span', { className: 'badge done', textContent: 'ready' }) : null,
            sent(d) ? el('span', { className: 'badge sent', textContent: 'sent' }) : null,
          ]),
        ],
      );

      // One heading before the first of them, saying what the greying means.
      return at === firstSent
        ? [el('div', { className: 'list-head', textContent: 'Sent — still open to edit' }), card]
        : [card];
    }),
  );

  // Open something being worked on, not something already gone.
  if (!openDraftId && ordered[0]) openDraft(ordered.find((d) => !sent(d))?.id ?? ordered[0].id);
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
  /*
   * Whatever is in the draft on screen goes to disk before another one
   * replaces it. Switching drafts is one of the two ways a half-written cover
   * letter used to disappear — the other being closing the tab — because
   * nothing but blur ever wrote.
   *
   * Unconditionally, including when the id is the same one. `renderDraft`
   * repaints from the copy it is handed and resets the dirty flag, so an edit
   * not written first is not merely overwritten on screen — it is dropped
   * before it ever leaves the browser, where no amount of care on the server
   * can save it. Re-opening the same draft is what `tailorDraft` does when it
   * finishes, which is minutes of waiting spent typing.
   */
  if (draftSave.current) await flushDraftEdits();

  openDraftId = id;
  location.hash = `#workspace/${encodeURIComponent(id)}`;
  try {
    let draft = await api(`/workspace/${encodeURIComponent(id)}`);
    // Another draft was opened while this one was being fetched; that one owns
    // the panel now, and painting this over it would be a draft nobody chose.
    if (openDraftId !== id) return;

    /*
     * And the same again for the fetch itself, which is where this actually
     * bit: the panel stays live and typeable while it runs, so anything
     * written during it was thrown away by the repaint at the end. Writing it
     * and re-reading costs one request and cannot paint over it.
     */
    if (draftSave.dirty) {
      await flushDraftEdits();
      draft = await api(`/workspace/${encodeURIComponent(id)}`);
      if (openDraftId !== id) return;
    }
    renderDraft(draft);
  } catch (err) {
    setStatus(err.message, true);
  }
  // Repaint the list so the newly-open one is marked. Floating, because the
  // panel is already drawn and nothing waits on it — but not unhandled: a
  // dropped promise here is a console error nobody reads and a list quietly
  // out of step with the panel beside it.
  loadDrafts().catch((err) => setStatus(err.message, true));
}

const SOURCE_LABEL = { bank: 'from your answer bank', ai: 'drafted by AI', human: 'written by you', empty: 'not answered' };

/* The letter preview gets the same treatment as the resume's: debounce a burst
 * of typing into one compile, and ignore any answer that a newer keystroke has
 * already superseded. */
let letterTimer = null;
let letterToken = 0;

/* ------------------------------------------------------------------ *
 * The Workspace saves as you type                                     *
 * ------------------------------------------------------------------ *
 *
 * It used to save on blur and on nothing else. The cover letter, every
 * answer and the notes are textareas someone types into for a long time
 * without clicking anywhere — and the letter's preview retypesets while they
 * do, which says, convincingly, that the text is being handled. It was not:
 * reloading the page, closing the tab, or following the link to the resume
 * builder threw away everything since the last time focus happened to move.
 *
 * The builder already had this. The Workspace is where the actual writing
 * happens, and it had none of it.
 */

/** The draft being edited, and the machinery keeping it on disk. */
const draftSave = {
  /** Set by `renderDraft` so the flush paths can reach the open draft. */
  current: null,
  timer: null,
  /** The write in flight, so anything leaving the page can await it. */
  pending: null,
  dirty: false,
};

function setDraftSaveState(mode, detail) {
  const chip = $('#draft-save-state');
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

/** Write the open draft now. Safe to call when there is nothing to write. */
async function saveDraftNow(message) {
  const draft = draftSave.current;
  if (!draft) return;
  clearTimeout(draftSave.timer);
  draftSave.timer = null;
  if (!draftSave.dirty && !message) return;

  draftSave.dirty = false;
  setDraftSaveState('saving');
  const write = api(`/workspace/${encodeURIComponent(draft.id)}`, {
    method: 'PUT',
    body: JSON.stringify(draft),
    keepalive: true,
  })
    .then(() => {
      // Only clear the chip if nothing has been typed since this write began.
      if (!draftSave.dirty) setDraftSaveState('saved');
      if (message) setStatus(message);
    })
    .catch((err) => {
      draftSave.dirty = true;
      setDraftSaveState('failed', err.message);
      throw err;
    })
    .finally(() => {
      if (draftSave.pending === write) draftSave.pending = null;
    });

  draftSave.pending = write;
  await write.catch(() => {});
}

/** A keystroke happened. Same debounce the builder uses. */
function markDraftDirty() {
  draftSave.dirty = true;
  setDraftSaveState('dirty');
  clearTimeout(draftSave.timer);
  draftSave.timer = setTimeout(() => {
    draftSave.timer = null;
    saveDraftNow().catch(() => {});
  }, AUTOSAVE_DELAY_MS);
}

/** Everything typed into the Workspace, on disk, before we go anywhere. */
async function flushDraftEdits() {
  clearTimeout(draftSave.timer);
  draftSave.timer = null;
  if (draftSave.dirty) await saveDraftNow();
  await draftSave.pending?.catch(() => {});
}

function renderDraft(draft) {
  const panel = $('#draft-editor');
  if (!draft) {
    setChildren(
      panel,
      el('div', { className: 'empty' }, [
        el('b', {}, draftsInList === 0 ? 'Nothing in progress' : 'Nothing open'),
        draftsInList === 0
          ? 'One arrives here when JobHelper finds a posting that wants a cover letter or written answers. ' +
            'Or start one yourself with + Application, above.'
          : 'Pick an application on the left.',
      ]),
    );
    return;
  }

  const notes = el('div', { className: 'gen-notes' });

  /** Persist the draft as it stands, marking edited fields so generation
   *  never overwrites something a human wrote. */
  draftSave.current = draft;
  draftSave.dirty = false;
  clearTimeout(draftSave.timer);
  draftSave.timer = null;

  const save = async (message) => {
    draftSave.dirty = true;
    await saveDraftNow(message);
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
        // The whole page goes, not just the class over it.
        letterToken++;
        clearPdf(letterPane);
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

    const letterFeedbackBtn = aiButton({
      label: 'Ask for feedback',
      title: 'The AI reads what you have written and says what is weak — it does not rewrite it',
      onclick: () => askDraftFeedback(draft, {}, letterNotes),
    });
    letterFeedbackBtn.disabled = !draft.coverLetter.body.trim();

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
      // The button that reviews this is disabled while there is nothing to
      // review, and nothing else re-renders the header — so writing a letter
      // left it dead until the draft was closed and reopened.
      letterFeedbackBtn.disabled = !letter.value.trim();
      markDraftDirty();
      scheduleLetter();
    };
    // Blur still writes immediately — it is a strong signal the thought is
    // finished — but it is no longer the only thing that writes.
    letter.onblur = () => saveDraftNow().catch(() => {});

    /*
     * Where "Draft it" reports, which is beside "Draft it".
     *
     * Every AI action wrote its progress into one panel at the foot of the
     * editor — below the resume block, the notes box and the buttons that
     * finish the application. The letter's own button is at the top of the
     * page. So pressing it started a run that takes minutes and put the
     * spinner somewhere you would have to scroll to find, which is
     * indistinguishable from it having done nothing at all.
     *
     * The shared panel still exists for the actions that live down there
     * with it. This one belongs to this block.
     */
    const letterNotes = el('div', { className: 'gen-notes' });

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
          aiButton({
            label: 'Draft it',
            title: 'Write a first draft from the posting and the letters you have written before',
            onclick: () => generate(draft, 'letter', letterNotes),
          }),
          letterFeedbackBtn,
        ]),
        // What "Draft it" writes from, beside "Draft it". See `draftedFrom`.
        el('div', { className: 'hint voice-from', textContent: draftedFrom('letter') }),
        letterNotes,
        el('div', { className: 'letter-split' }, [letter, letterPane]),
        letterFit,
      ]),
    );

    // Show the letter as it stands the moment the draft opens.
    queueMicrotask(compile);
  } else {
    /*
     * A cover letter you decided against, and then wanted.
     *
     * Whether one is needed is read off the form when the application is
     * opened, and that answer was final: the box simply did not exist
     * afterwards. It is the wrong thing to be final about — the form that asks
     * is often three pages in, the detection is a guess, and "send one anyway"
     * is a perfectly ordinary decision to make late. Nothing is lost by
     * offering: an empty letter is not bundled.
     */
    blocks.push(
      el('div', { className: 'block subtle' }, [
        el('div', { className: 'block-head' }, [
          el('h4', {}, 'Cover letter'),
          el('span', { className: 'badge', textContent: 'not asked for' }),
          el('span', { className: 'grow', style: 'flex:1' }),
          el('button', {
            className: 'tiny',
            textContent: 'Add one anyway',
            title: 'This posting did not ask for a letter. Send one regardless.',
            onclick: async () => {
              draft.coverLetter = { ...draft.coverLetter, required: true };
              await save('Cover letter added');
              renderDraft(draft);
            },
          }),
        ]),
        el('div', { className: 'hint' }, 'This application did not ask for one.'),
      ]),
    );
  }

  /* Questions */
  if (draft.questions.length > 0) {
    const qs = el('div');
    for (const q of draft.questions) {
      const box = el('textarea', {
        value: q.answer,
        placeholder: 'No stored answer yet — what you write here is saved for next time.',
      });
      const answerFeedbackBtn = aiButton({
        className: 'link',
        label: 'Feedback',
        title: 'The AI reads this answer and says what is weak — it does not rewrite it',
        onclick: () => askDraftFeedback(draft, { questionId: q.id }, notes),
      });
      answerFeedbackBtn.disabled = !q.answer?.trim();

      box.oninput = () => {
        q.answer = box.value;
        q.edited = true;
        q.source = 'human';
        answerFeedbackBtn.disabled = !box.value.trim();
        markDraftDirty();
      };
      box.onblur = () => saveDraftNow().catch(() => {});

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
            /*
             * A stored answer that only loosely matched this question. The
             * matcher draws that line deliberately — above it an answer is safe
             * to send unread, below it, in its own words, "a starting point the
             * user should read first" — and a loose one used to arrive looking
             * exactly like a confident one. It is the difference between "yes,
             * I am authorized to work" and "no, I require sponsorship".
             */
            !q.edited && q.needsReview
              ? el('span', {
                  className: 'badge required',
                  style: 'margin-left:6px',
                  textContent: 'read this one first',
                  title: 'This came from a stored answer to a similar — not identical — question.',
                })
              : null,
            el('span', { style: 'flex:1' }),
            aiButton({
              className: 'link',
              label: 'Draft this one',
              title: 'Write an answer from the posting and the answers you have given before',
              onclick: () => generate(draft, 'questions', notes, { questionId: q.id }),
            }),
            answerFeedbackBtn,
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
          aiButton({
            label: 'Fill in what is empty',
            title: 'Answer every question that is still blank',
            onclick: () => generate(draft, 'questions', notes),
          }),
        ]),
        // The same for the answers as for the letter. See `draftedFrom`.
        el('div', { className: 'hint voice-from', textContent: draftedFrom('answer') }),
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
  notesBox.oninput = () => {
    draft.notes = notesBox.value;
    markDraftDirty();
  };
  notesBox.onblur = () => saveDraftNow().catch(() => {});

  const resumeSelect = el('select');
  /*
   * A placeholder when nothing is attached yet.
   *
   * Without one the select showed the first resume in the list as though it
   * had been chosen, while the draft had no resume at all — so the panel said
   * "Send: Base resume" and building the files answered "400 Bad Request".
   * An empty choice is the honest thing to show when no choice has been made.
   */
  if (!draft.resumeId) resumeSelect.append(el('option', { value: '', textContent: '— choose a resume —' }));
  for (const r of state.store.resumes) {
    resumeSelect.append(el('option', { value: r.id, textContent: r.label, selected: r.id === draft.resumeId }));
  }
  resumeSelect.onchange = async () => {
    if (!resumeSelect.value) return;
    draft.resumeId = resumeSelect.value;
    await save('Resume changed');
    // Attaching one is what unlocks building the files, and the button that
    // does it is drawn from `draft`, so the panel has to be drawn again.
    renderDraft(draft);
  };

  setChildren(
    panel,
    el('div', { className: 'draft-head' }, [
      el('h3', { textContent: `${draft.role}` }),
      el('span', { className: 'grow' }),
      // Says whether what is on screen is on disk. The builder has had one of
      // these all along; the tab where the writing actually happens did not.
      el('span', {
        id: 'draft-save-state',
        className: 'save saved',
        title: 'Your letter, answers and notes are written to the save as you type.',
        textContent: 'All changes saved',
      }),
    ]),
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
        aiButton({
          label: 'Let the AI choose',
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
      /*
       * An application with no resume on it cannot be built, and pressing the
       * button said so with a bare "400 Bad Request" in the corner. Which
       * resume to send is the one decision this tool exists to help with, so
       * it is not one to guess at — but it is one to ask for plainly, next to
       * the button that needs it, rather than after the fact.
       */
      draft.resumeId
        ? null
        : el('div', { className: 'hint warn' }, 'Choose a resume above before building the files.'),
      el('div', { className: 'toolbar' }, [
        el('button', {
          className: 'primary',
          textContent: 'Build files and record it',
          title: draft.resumeId
            ? 'Compile the resume, name the files, and log the answers in the application history'
            : 'Pick a resume for this application first — tailor one, or start one to edit yourself',
          disabled: !draft.resumeId,
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
  const doing = useAi ? 'Reading the posting' : 'Matching against the posting';
  setChildren(notes, el('div', { textContent: `${doing}…` }));
  // In the toolbar too, so leaving this panel does not lose the only sign it
  // is running. `useAi` runs for minutes; the match is instant and the chip
  // is gone before anyone reads it, which is the right amount of noise.
  const stopChip = startDrafting(doing, () => openDraft(draft.id));
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
  } finally {
    stopChip();
  }
}

/**
 * A button that will run the AI.
 *
 * Pressing one spends minutes and, depending on the command, money; pressing
 * one that does not is instant. Nothing on screen distinguished them, so the
 * only way to find out which you had pressed was to wait and see. The mark is
 * on the buttons that start AI work and on no others — labelling the rest
 * "not AI" would be noise on every button in the product to say something
 * about four of them.
 */
function aiButton({ className = 'tiny', label, title, onclick }) {
  return el('button', { className: `${className} ai-action`, title: `${title}. Runs your AI command.`, onclick }, [
    el('span', { className: 'ai-mark', ariaHidden: 'true', textContent: '✦' }),
    el('span', { textContent: label }),
  ]);
}

/**
 * What the AI is doing, while it does it.
 *
 * "Working…" was the whole of it, for something that takes minutes: no way to
 * tell a run that is thinking from one that has died, and nothing saying the
 * boxes are still yours to type in meanwhile. A count of seconds is the
 * cheapest honest thing — it moves, so the panel is visibly alive, and it says
 * how long you have actually been waiting rather than how long it feels.
 */
/**
 * Everything the AI is writing right now, so the toolbar can say so.
 *
 * Feedback has had a chip up there since it went into the background, and it
 * is the reason a feedback run is something you can start and then go back to
 * work: the sign that it is happening follows you between tabs. A draft had
 * nothing of the kind — the progress bar lives in the panel that started it,
 * so opening the resume builder while a cover letter was being written left
 * no trace anywhere that anything was.
 *
 * Which is the same question in both cases: is it still going, and where is
 * it. So it gets the same answer, in the same place.
 */
const drafting = new Map();
let draftingSeq = 0;
let draftingTimer = null;

function startDrafting(what, go) {
  const id = ++draftingSeq;
  drafting.set(id, { what, started: Date.now(), go });
  renderDraftingChip();
  // One timer for however many are running, started on the first and stopped
  // with the last.
  draftingTimer ??= setInterval(renderDraftingChip, 1000);
  return () => {
    drafting.delete(id);
    renderDraftingChip();
    if (drafting.size === 0 && draftingTimer) {
      clearInterval(draftingTimer);
      draftingTimer = null;
    }
    // A run has happened, so the panel that lists past runs now has something
    // to list. It is hidden until it does; see `refreshAiActivity`.
    void refreshAiActivity?.();
  };
}

function renderDraftingChip() {
  const chip = $('#drafting-chip');
  if (!chip) return;
  const running = [...drafting.values()];

  /*
   * The way into the run, beside the thing that says a run is happening.
   *
   * Every AI action registers here — the ones that draft into a panel and the
   * ones that only put a word in the status line — so this is the one place
   * that covers all of them. Shown and hidden with the work, because what the
   * model was given and what it has said are only worth looking at while it is
   * saying them.
   */
  /*
   * Always there, and louder while something is running.
   *
   * It used to disappear when nothing was going, which sounded tidy and meant
   * that on a page where no AI had run yet there was no way in at all — the
   * one state somebody hunting for one is actually in. Asked for it: "I don't
   * actually see a way to see the inner working of the AI assistant."
   *
   * So it is a permanent, quiet button that names itself, and takes the clock
   * and the emphasis when there is a live run to name. Idle it opens the last
   * few runs; busy it opens the one that is going.
   */
  const peek = $('#ai-peek-chip');
  if (peek) {
    const live = running.length > 0;
    peek.className = live ? 'jobs-chip peek busy' : 'jobs-chip peek';
    peek.textContent = live ? 'What it’s doing' : 'What the AI is doing';
    peek.title = live
      ? 'The prompt it was given, and what it has said so far'
      : 'The last few AI runs — what they were given, and what they said';
    peek.onclick = () =>
      showLiveAiRun(live ? running.reduce((a, b) => (a.started <= b.started ? a : b)).what : 'the AI');
  }

  if (running.length === 0) {
    chip.className = 'jobs-chip hidden';
    chip.textContent = '';
    chip.onclick = null;
    return;
  }

  // The oldest, because it is the one that has been waited on longest and the
  // one most likely to be worth looking at.
  const oldest = running.reduce((a, b) => (a.started <= b.started ? a : b));
  const s = Math.round((Date.now() - oldest.started) / 1000);
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  chip.className = 'jobs-chip working';
  chip.textContent =
    running.length > 1 ? `${oldest.what}, and ${running.length - 1} more · ${clock}` : `${oldest.what} · ${clock}`;
  chip.title = running.map((r) => r.what).join('\n');
  chip.onclick = oldest.go ?? null;
  // A chip that cannot take you anywhere should not look as though it could.
  chip.style.cursor = oldest.go ? 'pointer' : 'default';
}

function showAiProgress(notes, doing, go, hint = 'Keep writing if you like — nothing you type now will be lost.') {
  const started = Date.now();
  const stopChip = startDrafting(doing, go);
  const clock = el('span', { className: 'ai-elapsed', textContent: '0:00' });
  setChildren(
    notes,
    el('div', { className: 'ai-running' }, [
      el('span', { className: 'ai-mark spin', ariaHidden: 'true', textContent: '✦' }),
      el('span', { textContent: `${doing}… ` }),
      clock,
      /*
       * A way in, while there is something to look at.
       *
       * What the model was given and what it has said so far only mean
       * anything while it is saying them — so the way to them lives here,
       * beside the clock that says it is still going, and goes when the run
       * does. Every AI button in the editor puts its progress up through this
       * function, so every one of them gets it.
       */
      el('button', {
        className: 'link ai-peek',
        textContent: 'What it’s doing',
        title: 'The prompt it was given, and what it has printed so far',
        onclick: () => showLiveAiRun(doing),
      }),
    ]),
    // The reassurance depends on what is running. "Keep writing" is the right
    // thing to say beside a letter being drafted and a strange thing to say
    // beside a pile of files being read, where there is nothing to type into.
    el('div', { className: 'hint', textContent: hint }),
  );

  const tick = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  return () => {
    clearInterval(tick);
    stopChip();
  };
}

const DOING = {
  letter: 'Writing the cover letter',
  questions: 'Answering the questions',
  all: 'Writing the letter and the answers',
};

async function generate(draft, what, notes, extra = {}) {
  const stop = showAiProgress(
    notes,
    extra.questionId ? 'Writing the answer' : (DOING[what] ?? 'Working'),
    // Where to go back to: the chip is only worth having if it can take you
    // to the thing it is telling you about.
    () => openDraft(draft.id),
  );
  // Nothing else starts a second run on top of this one.
  const buttons = [...($('#draft-editor')?.querySelectorAll('button.ai-action') ?? [])];
  for (const b of buttons) b.disabled = true;
  try {
    // What is on screen goes first, so the AI works from it and the server's
    // merge has something to protect.
    await flushDraftEdits();
    const res = await api(`/workspace/${encodeURIComponent(draft.id)}/generate`, {
      method: 'POST',
      body: JSON.stringify({ what, ...extra }),
    });

    /*
     * Anything typed *during* the run has been saved by the autosave and
     * merged by the server, so the reply in hand is already out of date.
     * Writing what is still pending and re-reading is one extra request and
     * cannot show a version of the draft that is nobody's.
     */
    await flushDraftEdits();
    renderDraft(await api(`/workspace/${encodeURIComponent(draft.id)}`));
    const panel = $('#draft-editor .gen-notes');
    if (panel) setChildren(panel, ...res.notes.map((n) => el('div', { textContent: n })));
    setStatus('Draft updated');
  } catch (err) {
    setChildren(notes, el('div', { className: 'err', textContent: err.message }));
  } finally {
    stop();
    // `renderDraft` has replaced these, so re-read rather than reusing the list.
    for (const b of $('#draft-editor')?.querySelectorAll('button.ai-action') ?? []) b.disabled = false;
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
  /*
   * Not a `startDrafting`: this one hands off to a background job, which has
   * had its own chip since it went into the background. Two chips for one
   * run would be worse than none.
   */
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

/*
 * What the two lists on this tab are showing.
 *
 * Both grow and neither shrinks: a letter per application, and a question per
 * form that asked something new. "What did I write to Helios?" and "have I
 * answered this before?" are the questions somebody brings to this tab, and
 * without a way to narrow it they are answered by reading every card.
 *
 * Out here for the same reason the tracker's is: this tab reloads after every
 * edit, and a filter that cleared itself when you saved a letter would be one
 * you stopped using.
 */
let letterFilter = '';
let answerFilter = '';

/**
 * The one control that says whether something counts as how you write.
 *
 * Drawn the same in both places it appears — beside a letter or an answer on
 * Letters & Answers, and in the list of them on Voice & AI — because it is
 * one decision and two spellings of it would be two things to keep in step.
 *
 * It states what is true rather than what pressing it would do. A button
 * reading "Use in voice" on a letter already in the corpus is unreadable:
 * half the people take it as the state and half as the action, and the ones
 * who take it as the action are the ones who press it.
 */
function voiceChip(kind, id, inVoice, after) {
  return el('button', {
    className: `tiny chip voice-flag${inVoice ? ' on' : ''}`,
    textContent: inVoice ? 'In your voice' : 'Not in your voice',
    title: inVoice
      ? 'This is one of the examples any AI request is told to sound like. Click to leave it out.'
      : 'This is kept, and left out of the examples any AI request is told to sound like. Click to count it.',
    onclick: async () => {
      try {
        await api('/voice/include', {
          method: 'POST',
          body: JSON.stringify({ kind, id, include: !inVoice }),
        });
        setStatus(inVoice ? 'Left out of your voice' : 'Counted as your writing');
        await after?.();
      } catch (e) {
        setStatus(e.message, true);
      }
    },
  });
}

async function loadLetters() {
  const [letters, store] = await Promise.all([api('/letters'), api('/store')]);

  /*
   * The whole card is searched, body included. Somebody looking for a letter
   * usually remembers a phrase from it rather than its title — and the titles
   * these are given are all much of a muchness.
   */
  const matching = (text, said) => !said || String(text ?? '').toLowerCase().includes(said.toLowerCase());
  const shownLetters = letters.filter((l) =>
    matching(`${l.title ?? ''} ${l.company ?? ''} ${l.role ?? ''} ${l.body ?? ''}`, letterFilter),
  );
  const shownAnswers = (store.answers ?? []).filter((a) =>
    matching(`${a.question ?? ''} ${(a.variants ?? []).map((v) => v.text).join(' ')}`, answerFilter),
  );

  // How often each stored question has actually gone out, so the bank shows
  // which answers are pulling their weight.
  const usedBy = {};
  for (const app of store.applications ?? []) {
    for (const qa of app.answers ?? []) usedBy[qa.question] = (usedBy[qa.question] ?? 0) + 1;
  }

  $('#letters').replaceChildren(
    shownLetters.length === 0
      ? el('div', { className: 'empty' }, [
          el('b', {}, letters.length === 0 ? 'No letters yet' : 'Nothing matches'),
          letters.length === 0
            ? 'Drafts written by the extension are saved here, and become the voice reference for the next one.'
            : `${plural(letters.length, 'letter')} here; none of them mention that.`,
        ])
      : el(
          'div',
          { className: 'card-list' },
          shownLetters.map((l) =>
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
                voiceChip('letter', l.id, l.voice !== false, loadLetters),
                el('button', { className: 'tiny', textContent: 'Open', onclick: () => editLetter(l) }),
              ]),
              el('div', { className: 'body', textContent: l.body.slice(0, 260) }),
            ]),
          ),
        ),
  );

  $('#answers').replaceChildren(
    shownAnswers.length === 0
      ? el('div', { className: 'empty' }, [
          el('b', {}, store.answers.length === 0 ? 'No saved answers' : 'Nothing matches'),
          store.answers.length === 0
            ? 'Add the questions every form asks.'
            : `${plural(store.answers.length, 'question')} saved; none of them mention that.`,
        ])
      : el(
          'div',
          { className: 'card-list' },
          shownAnswers.map((a) => {
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
                voiceChip('answer', a.id, a.voice !== false, loadLetters),
                el('button', { className: 'tiny', textContent: 'Edit', onclick: () => editAnswer(a) }),
                el('button', {
                  className: 'tiny danger',
                  textContent: 'Delete',
                  title: 'Remove this question and every version of its answer from the save',
                  onclick: () => removeAnswer(a, usedBy[a.question] ?? 0),
                }),
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

/**
 * Take a question, and every version of its answer, out of the bank.
 *
 * The other thing here that only ever grew. Every form answered adds to this,
 * "Save for next time" adds to it, and the extension adds to it on your
 * behalf — and nothing took anything away, so a year of applying leaves a
 * bank whose oldest entries are questions from a job you did not take, worded
 * for a company you have forgotten.
 *
 * Told how many applications used it, because that is the fact that decides
 * this and it is not visible from the question itself. Deleting one that
 * nothing used is housekeeping; deleting one that eleven applications used
 * throws away the wording you have been reusing all year, and the history of
 * those applications keeps the answer it actually sent either way.
 */
async function removeAnswer(item, usedIn = 0) {
  const ok = await confirmModal(
    `Delete “${item.question}”?`,
    `${plural(item.variants.length, 'version')} of this answer ${item.variants.length === 1 ? 'is' : 'are'} removed from the save.` +
      (usedIn > 0
        ? ` ${plural(usedIn, 'application')} used it — those keep the answer they sent, but it will not be offered again.`
        : ' Nothing has used it yet.'),
  );
  if (!ok) return;

  // Through the whole list, which is the only way the bank is written: the
  // endpoint refuses anything that is not a list, so a filter is the edit.
  const answers = (await api('/store')).answers.filter((a) => a.id !== item.id);
  await api('/answers', { method: 'PUT', body: JSON.stringify(answers) });
  setStatus(`Deleted “${item.question}”`);
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

/**
 * The notes as the server last gave them, so an edit can be told from a
 * reload. See `loadVoice`.
 */
let voiceAsLoaded = null;

/** Whether the notes box holds something that has not been saved. */
const voiceIsDirty = () => voiceAsLoaded !== null && $('#voice')?.value !== voiceAsLoaded;

/** Show or hide the "not saved yet" note beside the Save button. */
function markVoiceUnsaved() {
  const flag = $('#voice-unsaved');
  if (flag) flag.hidden = !voiceIsDirty();
}


/**
 * The letters and answers the save holds, and whether each one counts.
 *
 * In, then out, with a count on the summary, because the question somebody
 * opens this for is "what is my voice made of" and the answer to it is a
 * list. The same chip as Letters & Answers, so there is one switch rather
 * than two that have to agree.
 *
 * Reloads the whole panel on a change rather than redrawing this list alone:
 * the budget bar above and the exact text below are both computed from what
 * is counted, and a list that moved while they did not would be three numbers
 * disagreeing on one screen.
 */
function drawVoiceWriting(writing) {
  const box = $('#voice-writing');
  if (!box) return;
  const letters = writing?.letters ?? [];
  const answers = writing?.answers ?? [];

  const row = (kind, id, name, chars, inVoice) =>
    el('div', { className: 'mini-card' }, [
      el('div', { className: 'row1' }, [
        el('b', { textContent: name || '(untitled)' }),
        el('span', { style: 'flex:1' }),
        el('span', { className: 'chip count', textContent: `${chars.toLocaleString()} characters` }),
        voiceChip(kind, id, inVoice, loadVoice),
      ]),
    ]);

  const all = [
    ...letters.map((l) => ({ kind: 'letter', id: l.id, name: l.title, chars: l.chars ?? 0, inVoice: l.inVoice })),
    ...answers.map((a) => ({ kind: 'answer', id: a.id, name: a.question, chars: a.chars ?? 0, inVoice: a.inVoice })),
  ];

  const counted = all.filter((x) => x.inVoice);
  const summary = $('#voice-writing-box')?.querySelector('summary');
  if (summary) {
    summary.textContent = all.length
      ? `Letters and answers counted as your writing — ${counted.length} of ${all.length}`
      : 'Letters and answers counted as your writing';
  }

  if (all.length === 0) {
    setChildren(
      box,
      el('div', { className: 'empty' }, [
        el('b', {}, 'Nothing written down yet'),
        'Letters the extension drafts and answers you save land here, and count towards your voice from the moment they do.',
      ]),
    );
    return;
  }

  const left = all.filter((x) => !x.inVoice);
  setChildren(
    box,
    el('div', { className: 'card-list' }, counted.map((x) => row(x.kind, x.id, x.name, x.chars, true))),
    left.length
      ? el('p', {
          className: 'hint',
          // Counted by what they are, not by "one" — `plural` would have made
          // this "2 ones left out", which is the sort of thing that reads as
          // the program not knowing what it is talking about.
          textContent:
            left.length === 1
              ? 'One left out — kept in the save, and not imitated.'
              : `${left.length} left out — kept in the save, and not imitated.`,
        })
      : null,
    left.length
      ? el('div', { className: 'card-list' }, left.map((x) => row(x.kind, x.id, x.name, x.chars, false)))
      : null,
  );
}

async function loadVoice() {
  const data = await api('/voice');
  const box = $('#voice');
  const fromStore = data.voice ?? '';

  /*
   * Everything else here is reloaded, but the notes are not — not while they
   * hold something unsaved.
   *
   * This runs on six occasions, and five of them are something else
   * happening in the same panel: adding a writing sample, editing one,
   * dropping a file, accepting what was read out of it. The notes box is the
   * one field in the editor with no autosave — it has a Save button instead —
   * so typing a note and then adding a sample, which is an entirely ordinary
   * order to do those two things in, replaced what had just been typed with
   * the older copy from disk. No warning, and nothing to undo it with.
   */
  if (voiceIsDirty()) markVoiceUnsaved();
  else {
    box.value = fromStore;
    voiceAsLoaded = fromStore;
    markVoiceUnsaved();
  }
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

  drawVoiceWriting(data.writing);

  /*
   * And the offer to read them.
   *
   * These files are already the material a resume is made of — an old resume,
   * the cover letters, a README. Typing the entries out of them by hand is
   * the evening this saves, and the button belongs beside the files rather
   * than three tabs away from them.
   */
  const materialNotes = $('#read-material-notes');
  const row = $('#read-material-row');
  if (row) {
    const count = (data.samples?.length ?? 0) + (data.context?.used?.length ?? 0);
    row.hidden = count === 0;
    setChildren(
      row,
      aiButton({
        className: '',
        label: 'Read these into entries',
        title:
          'Read everything here and propose the entries, bullets and alternate wordings in it. ' +
          'Nothing is saved: you accept them one at a time',
        onclick: () => readMaterial(materialNotes),
      }),
      el('span', {
        className: 'hint',
        textContent: 'Nothing is saved — you look at every line before it goes in.',
      }),
    );
  }

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
              // `excerpt` is all the server sends; see `GET /voice`.
              el('div', { className: 'body sample', textContent: sample.excerpt ?? '' }),
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

async function editSample(listed) {
  /*
   * The list carries an excerpt; the box needs the whole thing.
   *
   * `GET /voice` used to hand back every sample's full text so that this line
   * could read it out of one — a megabyte on the wire and on the thread that
   * draws the page, to fill a box the user may never open. One sample, asked
   * for when it is opened.
   */
  const sample = await api(`/voice/samples/${encodeURIComponent(listed.id)}`).catch(() => null);
  if (!sample) {
    setStatus(`“${listed.title}” is not in the save any more.`, true);
    loadVoice();
    return;
  }

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
let AI_TASKS = [];
const CUSTOM_PRESET = { label: 'Custom…', command: '', args: [], note: '' };

async function loadAiPresets() {
  if (AI_PRESETS.length > 0) return AI_PRESETS;
  const { presets, tasks } = await api('/ai/presets').catch(() => ({ presets: [], tasks: [] }));
  AI_PRESETS = [...presets, CUSTOM_PRESET];
  AI_TASKS = tasks ?? [];
  return AI_PRESETS;
}

/**
 * The page every resume in the save is set on, unless it says otherwise.
 *
 * This used to arrive by inheritance: a base stated the font size and the
 * margins, and every variation of it took them. Resumes stand alone now, so
 * without somewhere to say it once, "make my margins a little wider" is an
 * edit to every resume you own — and a resume made next week would still come
 * out with the old ones.
 *
 * It belongs to the save rather than to a resume anyway. How you like a page
 * to look is not a fact about the job you are applying for. The per-resume
 * setting stays for the one document that has to be squeezed a little harder
 * to fit on the page.
 */
function pageDefaults(config) {
  const now = config.layout ?? {};
  // The value in force, so the boxes show what the resumes are actually set
  // on rather than blanks that mean "whatever the app thinks".
  const inForce = { fontSizePt: 10.5, marginIn: 0.45, spacing: 1, paper: 'letter', ...now };

  const save = async (patch, revert) => {
    try {
      const saved = await api('/config', { method: 'PUT', body: JSON.stringify({ layout: patch }) });
      if (state.store?.config) state.store.config.layout = saved.layout;
      setStatus('Page settings saved');
      // Every resume is set on this, including the one on screen.
      scheduleRender();
    } catch (err) {
      revert();
      setStatus(err.message, true);
    }
  };

  const number = (key, label, attrs, hint) => {
    const was = String(inForce[key]);
    const box = el('input', { type: 'number', value: was, ...attrs });
    box.onchange = () => {
      const n = Number(box.value);
      if (!Number.isFinite(n)) { box.value = was; return; }
      save({ [key]: n }, () => { box.value = was; });
    };
    return el('label', { className: 'f' }, [
      el('div', { className: 'lbl', textContent: label }),
      box,
      hint ? el('div', { className: 'hint', textContent: hint }) : null,
    ]);
  };

  const paper = el('select', {}, [
    el('option', { value: 'letter', textContent: 'US Letter' }),
    el('option', { value: 'a4', textContent: 'A4' }),
  ]);
  paper.value = inForce.paper;
  paper.onchange = () => {
    const was = inForce.paper;
    save({ paper: paper.value }, () => { paper.value = was; });
  };

  return el('div', { className: 'page-defaults' }, [
    el('div', { className: 'lbl', textContent: 'The Page' }),
    el('div', {
      className: 'hint',
      style: 'margin-bottom:8px',
      textContent: 'How every resume in this save is set, unless one of them says otherwise.',
    }),
    el('div', { className: 'row' }, [
      number('fontSizePt', 'Font size (pt)', { step: '0.5', min: '8', max: '14' }),
      number('marginIn', 'Margin (in)', { step: '0.05', min: '0.3', max: '1.5' }),
      number('spacing', 'Line spacing', { step: '0.05', min: '0.8', max: '1.5' }),
      el('label', { className: 'f' }, [el('div', { className: 'lbl', textContent: 'Paper' }), paper]),
    ]),
    el('div', {
      className: 'hint',
      style: 'margin-bottom:12px',
      textContent: 'Auto-fit may still shrink a resume within its limits to keep it on one page.',
    }),
  ]);
}

/**
 * How long a resume made for one posting sticks around, and what is due.
 *
 * Shown beside the number rather than only behind a menu, because this is the
 * one setting in the program whose value deletes something. A person changing
 * it should be able to see what that means for the save in front of them
 * without having to work it out from a date.
 */
function temporaryLife(config, expiring) {
  const was = String(config.resumes?.temporaryDays ?? 7);
  const box = el('input', { type: 'number', value: was, step: '1', min: '0', max: '3650' });

  const due = expiring?.due ?? [];
  const note = el('div', {
    className: due.length > 0 ? 'result idle' : 'result ok',
    textContent:
      Number(was) <= 0
        ? 'Switched off. Nothing is swept, and temporary resumes stay until you delete them.'
        : due.length > 0
          ? `${plural(due.length, 'resume')} due to go next time this save is opened: ` +
            `${due.slice(0, 4).map((d) => d.label).join(', ')}${due.length > 4 ? '…' : ''}`
          : 'Nothing is due. A resume is only swept once its application is done with.',
  });

  box.onchange = async () => {
    const n = Number(box.value);
    if (!Number.isFinite(n)) { box.value = was; return; }
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify({ resumes: { temporaryDays: n } }) });
      setStatus(n > 0 ? `Temporary resumes go after ${plural(n, 'day')}` : 'Temporary resumes are no longer swept');
      loadProjectSettings().catch(() => {});
    } catch (err) {
      box.value = was;
      setStatus(err.message, true);
    }
  };

  return el('div', { className: 'temporary-life' }, [
    el('div', { className: 'lbl', textContent: 'Resumes Made For One Posting' }),
    el('div', {
      className: 'hint',
      style: 'margin-bottom:8px',
      textContent:
        'The extension makes one of these per posting. They are removed once the application is done with — ' +
        'not while it is still being written, and never while an interview or an offer is live. ' +
        'The version history keeps them, the way it keeps a deleted entry.',
    }),
    el('label', { className: 'f' }, [
      el('div', { className: 'lbl', textContent: 'Days to keep them (0 switches this off)' }),
      box,
    ]),
    note,
    due.length > 0
      ? el('div', { className: 'row' }, [
          el('button', {
            textContent: `Sweep ${plural(due.length, 'resume')} now`,
            onclick: async () => {
              const ok = await confirmModal(
                `Remove ${plural(due.length, 'resume')}?`,
                `${due.map((d) => `“${d.label}”`).join(', ')}. ` +
                  'The entries and wordings they selected are the store’s and stay, and the version history keeps them.',
              );
              if (!ok) return;
              try {
                const res = await api('/resumes/sweep', { method: 'POST' });
                /*
                 * Held back because the version history does not have them,
                 * which is the one case where removing a resume could not be
                 * undone. Said as an error rather than a note: something is
                 * wrong with the save history, and the sweep is the smallest
                 * part of what that costs.
                 */
                if (res.held?.length) {
                  setStatus(
                    `Kept ${plural(res.held.length, 'resume')} that ${res.held.length === 1 ? 'is' : 'are'} ` +
                      'due — the version history does not have ' +
                      `${res.held.length === 1 ? 'it' : 'them'} yet, so removing ` +
                      `${res.held.length === 1 ? 'it' : 'them'} could not be undone. ` +
                      'Save the store under Save History and they will go next time.',
                    true,
                  );
                } else {
                  setStatus(`Swept ${plural(res.swept.length, 'resume')}`);
                }
                /*
                 * The stack goes, as it does for a restore and a project
                 * switch. Its entries are "this resume before and after an
                 * edit", and the sweep has just deleted some of the resumes
                 * they describe — so one press of Ctrl+Z afterwards PUTs a
                 * deliberately swept resume straight back, reports "Undid
                 * change", and leaves nothing saying the sweep was reversed.
                 */
                forgetHistory();
                await loadStore();
                render();
                loadProjectSettings().catch(() => {});
              } catch (err) {
                setStatus(err.message, true);
              }
            },
          }),
          el('span', { className: 'hint', textContent: 'Or leave it — this happens when the save is next opened.' }),
        ])
      : null,
    el('div', { className: 'hint', style: 'margin-bottom:12px' }),
  ]);
}

/** Where the store lives, and whether it is backed up anywhere. */
async function loadProjectSettings() {
  const [info, config, expiring] = await Promise.all([
    api('/config/store'),
    api('/config'),
    // Not fatal: the panel is worth showing without it, and an older server
    // does not have this endpoint at all.
    api('/resumes/expiring').catch(() => null),
  ]);
  const box = $('#project-settings');
  const autoCommit = el('input', { type: 'checkbox', checked: config.git.autoCommit, disabled: config.overrides.autoCommit });
  autoCommit.onchange = async () => {
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify({ git: { autoCommit: autoCommit.checked } }) });
      state.store.config.git.autoCommit = autoCommit.checked;
      setStatus('Save history setting saved');
    } catch (error) { autoCommit.checked = !autoCommit.checked; setStatus(error.message, true); }
  };

  // Rebuilt by "Save History" further down this same panel, so a URL being
  // typed has to survive that. See `keptField`.
  const remote = keptField('git-remote', info.remote.url ?? '', {
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
  /*
   * The version history has stopped recording, and nothing else would say so.
   *
   * A failed auto-commit cannot be allowed to fail the edit — the file is
   * written, and losing it would be worse than losing its history — so it was
   * a line in a console nobody reads. The editor goes on saying "All changes
   * saved", truthfully, about the file. Meanwhile "restore this version" has
   * nothing to restore to, and the sweep will not take a resume the history
   * does not have. This is the only place that can say it.
   */
  const brokenHistory = config.git.autoCommit ? info.lastCommitError : null;
  /*
   * And git refusing to say what has changed, which is worse than either.
   *
   * An empty list of unsaved files is what this panel shows when everything
   * is saved, so a git that will not answer must not be allowed to render as
   * that — it is the exact confusion `rmm save` used to cause by reporting
   * "already saved" for a store it had not managed to look at. First, because
   * it is the news: nothing else here can be trusted while it is true.
   */
  const cannotLook = info.pendingError;
  const unsaved = el('div', {
    className: cannotLook || brokenHistory ? 'result bad' : pending.length > 0 ? 'result idle' : 'result ok',
    textContent: cannotLook
      ? `Git would not say what has changed here: ${cannotLook}. ` +
        'Until that is fixed nothing can be saved to the history, and this panel cannot tell you ' +
        'whether anything is waiting to be.'
      : brokenHistory
      ? 'Nothing has been recorded in the version history since ' +
        `${new Date(brokenHistory.at).toLocaleString()}: ` +
        `${brokenHistory.message}. Your files are all written — it is the history that has stopped. ` +
        'Save History below will say the same thing, and the reason is usually in it.'
      : pending.length > 0
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

    pageDefaults(config),
    temporaryLife(config, expiring),

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
  const researchNote = el('div', { className: 'hint', style: 'margin-bottom:12px' });
  /*
   * And whose setting it actually is.
   *
   * This box is drawn whichever CLI is configured, and it only decides
   * anything for the one whose deny list this tool writes. For the others it
   * was making a promise in both directions over a command line it had not
   * changed — and the direction that would be believed is the one it could
   * not keep: "off: it works only from the posting and what you have
   * written". Somebody choosing not to let a model read about their employer
   * should not be told they have when they have not.
   */
  const showResearchNote = (on) => {
    if (config.overrides.research) {
      researchNote.textContent =
        `This does not reach ${config.ai.command || 'the command you have configured'} — the switch only ` +
        'writes the tool list for Claude Code. Whether another CLI may read the web is its own setting, ' +
        'in its own configuration, and this tool neither grants it nor takes it away.';
      return;
    }
    researchNote.textContent = on
      ? 'It may read about the company before writing. What it finds can shape which of your experience is worth raising — it never becomes a claim about you. Your files stay out of reach either way.'
      : 'Off: it works only from the posting and what you have written. A letter that knows what the team actually ships reads differently from one that knows only the advertisement.';
  };
  showResearchNote(config.ai.research);

  research.onchange = async () => {
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify({ ai: { research: research.checked } }) });
      setStatus(
        research.checked
          ? 'The AI may look up the company while it writes'
          : 'The AI works only from what you gave it',
      );
      /*
       * The paragraph under the checkbox, and nothing else. Rebuilding the
       * panel from the server was the easy way to update it, and it threw away
       * the command, the arguments and the timeout as they had been typed —
       * fields that are deliberately not saved until Save is pressed, because
       * a half-typed command is not a command. Ticking a checkbox is not a
       * reason to lose them.
       */
      showResearchNote(research.checked);
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
  /*
   * The three fields that wait for the Save button, and therefore the three
   * that a reload can throw away.
   *
   * This whole panel is rebuilt from the server whenever it is shown, and it
   * is shown every time the Voice tab is opened. A command typed and not yet
   * saved — which is the normal state of a command, since it is only saved
   * when you say so — was replaced by the old one by nothing more than
   * looking at another tab and coming back.
   *
   * Half-typed is exactly the state worth keeping here. The reason these
   * three do not save themselves is that a half-typed command is not a
   * command; that is an argument for not *running* it, not for deleting it.
   */
  const command = keptField('ai-command', config.ai.command);
  const args = keptField('ai-args', (config.ai.args ?? []).join(' '));
  const timeout = keptField('ai-timeout', String(Math.round(config.ai.timeoutMs / 1000)));

  const preset = el('select');
  for (const p of AI_PRESETS) preset.append(el('option', { value: p.label, textContent: p.label }));
  const matching = AI_PRESETS.find(
    (p) => p.label !== 'Custom…' && p.command === config.ai.command && p.args.join(' ') === (config.ai.args ?? []).join(' '),
  );
  preset.value = matching?.label ?? 'Custom…';
  /*
   * A preset is copied when it is chosen, never referenced, so a config saved
   * before a preset was corrected keeps the old arguments for good — and the
   * picker, which only ever matched exactly, called that "Custom…" and said
   * nothing more. From the outside it reads as the preset having been
   * ignored: the command is right there, the run fails, and the advice that
   * comes back is "pick a preset", which you did.
   *
   * So say it, next to the thing that is wrong, with the one button that
   * fixes it.
   */
  const drifted = !matching && AI_PRESETS.find((p) => p.label !== 'Custom…' && p.command === config.ai.command);
  const presetNote = el('div', { className: 'hint' });
  const showPresetNote = () => {
    presetNote.textContent = AI_PRESETS.find((p) => p.label === preset.value)?.note ?? '';
  };
  showPresetNote();

  /*
   * Which model, and how hard it should think.
   *
   * The choices do not come from a list in this application. The server opens
   * the selected CLI, types its own model-picker command, and returns what the
   * installed version and signed-in account showed. A free-form box remains
   * behind "Another…" for a provider-specific name the picker omits.
   */
  const modelList = el('datalist', { id: 'ai-model-options' });
  const model = keptField('ai-model', config.ai.model ?? '', {
    placeholder: 'Whatever the CLI uses by default',
  });
  // `list` is read-only on an input, so assigning it throws rather than
  // linking the datalist — it has to be set as an attribute.
  model.setAttribute('list', 'ai-model-options');

  /*
   * The models the chosen CLI actually has, as buttons.
   *
   * Typing "opus" into a box is asking somebody to remember a name; four
   * buttons is reading. The box is still there behind "Another…", because
   * every one of these CLIs gains models faster than this file can be edited
   * and a closed list would start refusing names that work — but it is the
   * exception now rather than the only way in.
   */
  const modelChips = el('div', { className: 'chip-set model-chips' });
  const modelOther = el('div', { className: 'model-other', hidden: true }, [model]);
  const typedModel = () => model.value.trim();

  /* What the CLI's interactive model picker returned, held per command. */
  const fromCli = new Map();
  const liveModelsNote = el('div', { className: 'hint' });
  let refreshModelChoices = () => {};
  const askAboutModels = async (cmd) => {
    if (!cmd || fromCli.has(cmd)) return;
    fromCli.set(cmd, null); // in flight, so a keystroke does not ask twice
    const answer = await api(`/ai/models?command=${encodeURIComponent(cmd)}`).catch(() => ({
      models: [],
      from: 'unavailable',
      message: `Could not ask ${cmd} for its model choices; you can still type a model name.`,
    }));
    fromCli.set(cmd, answer);
    if (command.value.trim() === cmd) refreshModelChoices();
  };

  const showModelChips = () => {
    const chosen = AI_PRESETS.find((p) => p.label !== 'Custom…' && p.command === command.value.trim());
    const said = fromCli.get(command.value.trim());
    const names = said?.models ?? [];
    const listed = names.includes(typedModel());
    // Nothing to choose between: the box is the only control that makes sense.
    modelChips.hidden = names.length === 0;
    // And the box stays out of the way only while the buttons can say what is
    // chosen — which includes choosing nothing.
    modelOther.hidden = names.length > 0 && (typedModel() === '' || listed);

    /*
     * `aria-pressed` by setAttribute, not through el(): that builds with
     * Object.assign, and assigning a hyphenated key sets a plain JavaScript
     * property that no attribute and no screen reader ever sees. The same
     * trap as `list` on an input, one line further down the file.
     */
    const pressable = (node, on) => {
      node.setAttribute('aria-pressed', String(on));
      if (on) node.classList.add('on');
      return node;
    };
    const chip = (label, value, title) =>
      pressable(
        el('button', {
          type: 'button',
          className: 'chip-toggle',
          textContent: label,
          title: title ?? '',
          onclick: () => {
            model.value = value;
            model.oninput();
          },
        }),
        typedModel() === value,
      );

    modelChips.replaceChildren(
      chip('Default', '', `Whatever ${chosen?.command ?? 'the CLI'} uses when it is not told`),
      ...names.map((m) => chip(m, m)),
      pressable(
        el('button', {
          type: 'button',
          className: 'chip-toggle',
          textContent: 'Another…',
          onclick: () => {
            modelOther.hidden = false;
            model.focus();
          },
        }),
        !listed && Boolean(typedModel()),
      ),
    );
  };

  /*
   * And a model per kind of work, for when one is not enough.
   *
   * Behind a disclosure because almost nobody needs it: the box above is the
   * answer for most people, and four more boxes at the top of the panel would
   * make choosing a preset look like a configuration exercise. Each is empty
   * by default, which reads as "whatever Model says" and is exactly what it
   * does.
   */
  const perTask = new Map();
  for (const task of AI_TASKS) {
    const box = keptField(`ai-model-${task.key}`, config.ai.models?.[task.key] ?? '', {
      placeholder: 'A model name',
    });
    box.setAttribute('list', 'ai-model-options');
    perTask.set(task.key, box);
  }

  /*
   * Four kinds of work down the side, the models across the top.
   *
   * It was four text boxes, one per kind of work, each asking you to type a
   * model name from memory — and no way to see at a glance that three of them
   * say the same thing. As a grid the whole arrangement is one look: every row
   * has exactly one mark on it, and the column it is in is the answer.
   *
   * Radio buttons rather than styled cells, because that is what this is: one
   * choice per row, out of a named set. Arrow keys move along a row and screen
   * readers read the column heading with the cell, both for free.
   */
  const taskGrid = el('table', { className: 'model-grid' });
  const taskOther = new Map();
  let gridColumns = null;

  const paintTaskGrid = (names) => {
    const columns = JSON.stringify(names);
    if (columns === gridColumns) {
      // Same columns: only the marks can have moved, and rebuilding would take
      // the focus out of a name somebody is halfway through typing.
      for (const task of AI_TASKS) {
        const value = perTask.get(task.key).value.trim();
        const listed = names.includes(value);
        for (const radio of taskGrid.querySelectorAll(`input[name="ai-task-${task.key}"]`)) {
          radio.checked = radio.value === (listed || !value ? value : 'other');
        }
        taskOther.get(task.key).hidden = listed || !value;
      }
      return;
    }
    gridColumns = columns;

    const head = el('tr', {}, [
      el('th', { className: 'what', scope: 'col', textContent: 'For' }),
      el('th', { scope: 'col', textContent: 'Same as above' }),
      ...names.map((m) => el('th', { scope: 'col', textContent: m })),
      el('th', { scope: 'col', textContent: 'Another…' }),
    ]);

    const rows = AI_TASKS.flatMap((task) => {
      const box = perTask.get(task.key);
      const value = box.value.trim();
      const listed = names.includes(value);
      const choose = (v) => {
        if (v !== 'other') box.value = v;
        box.oninput();
        taskOther.get(task.key).hidden = v !== 'other';
        if (v === 'other') box.focus();
      };
      const cell = (value_, on) => {
        const radio = el('input', {
          type: 'radio',
          name: `ai-task-${task.key}`,
          value: value_,
          checked: on,
          onchange: () => choose(value_),
        });
        // By setAttribute: el() builds with Object.assign, and a hyphenated
        // key there sets a plain property no attribute ever sees — the same
        // trap as `list` on an input. A bare radio in a grid has no other name.
        const said = value_ === '' ? 'same as above' : value_ === 'other' ? 'another model' : value_;
        radio.setAttribute('aria-label', `${task.label}: ${said}`);
        return el('td', {}, [radio]);
      };

      const otherRow = el('tr', { className: 'other-row', hidden: listed || !value }, [
        el('td', { colSpan: String(names.length + 3) }, [box]),
      ]);
      taskOther.set(task.key, otherRow);

      return [
        el('tr', {}, [
          el('th', { className: 'what', scope: 'row', title: task.note, textContent: task.label }),
          cell('', !value),
          ...names.map((m) => cell(m, value === m)),
          cell('other', Boolean(value) && !listed),
        ]),
        otherRow,
      ];
    });

    setChildren(taskGrid, el('thead', {}, [head]), el('tbody', {}, rows));
  };

  /*
   * One answer drives every model control: the main buttons, the datalist and
   * every task row. Keeping this in one repaint is important — previously the
   * asynchronous answer updated only the main buttons, leaving each task on a
   * stale preset guess for the lifetime of the panel.
   */
  refreshModelChoices = () => {
    const cmd = command.value.trim();
    const said = fromCli.get(cmd);
    const names = said?.models ?? [];
    modelList.replaceChildren(...names.map((m) => el('option', { value: m })));
    showModelChips();
    paintTaskGrid(names);
    liveModelsNote.textContent = said === undefined || said === null
      ? `Reading ${cmd || 'the CLI'}’s model picker…`
      : said.from === 'cli'
        ? `Choices read from ${cmd}’s live model picker.`
        : said.message ?? 'The live model picker could not be read; you can still type a model name.';
  };

  /*
   * Effort as a slider, because it is one axis and four stops on it.
   *
   * A dropdown asks you to open it before you can see what the choices even
   * are, and hides the thing that matters most about them: that they are
   * ordered, and that you are somewhere on that order. A slider is the shape
   * of the setting.
   */
  const EFFORTS = [
    ['', 'As it comes'],
    ['low', 'Quick'],
    ['medium', 'Normal'],
    ['high', 'Thorough'],
  ];
  const effortAt = (i) => EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, Number(i) || 0))];
  const storedEffortAt = String(Math.max(0, EFFORTS.findIndex(([v]) => v === (config.ai.effort ?? ''))));
  const effortSlider = keepsValue(
    el('input', {
      type: 'range',
      min: '0',
      max: String(EFFORTS.length - 1),
      step: '1',
      className: 'effort-slider',
      value: storedEffortAt,
    }),
    'ai-effort',
    storedEffortAt,
  );
  const effortValue = () => effortAt(effortSlider.value)[0];
  /*
   * The scale under the track is also the readout: the stop you are on is the
   * one in darker type. A separate "As it comes" line above the slider said
   * the same words as the left-hand end of the scale below it, which is the
   * current value printed twice and no clearer for it.
   */
  const effortScale = el(
    'div',
    { className: 'effort-scale' },
    EFFORTS.map(([, label]) => el('span', { textContent: label })),
  );
  const showEffortLabel = () => {
    const at = Number(effortSlider.value) || 0;
    [...effortScale.children].forEach((span, i) => span.classList.toggle('on', i === at));
    effortSlider.setAttribute('aria-valuetext', effortAt(effortSlider.value)[1]);
  };
  let savedEffort = config.ai.effort ?? '';

  /**
   * What these two will actually do, given the command that is configured.
   *
   * Only Codex has a reasoning-effort flag. Saying "Thorough" and having it
   * silently mean nothing would be the worst version of this, so the panel
   * says which mechanism is in play: the CLI's own switch where there is one,
   * and a line in the prompt everywhere else — which reaches every model,
   * just less precisely.
   */
  /*
   * One note each, under the field it is about.
   *
   * Both sentences used to be joined into a single line below Effort, so
   * "Passed as --model" sat under the Effort dropdown, two fields away from
   * the box it describes, and read as if the effort were the thing being
   * passed. A note belongs to its field.
   */
  const modelNote = el('div', { className: 'hint' });
  const effortNote = el('div', { className: 'hint' });
  /*
   * A command that is not a preset gets neither control, and is told so.
   *
   * There is nothing to build a model menu out of — the names come from the
   * preset — and nothing to attach either setting to, so showing the pair
   * greyed out or full of a stranger's model names would be offering a choice
   * that does nothing. What stays is one line saying where the equivalent
   * lives: the flags go in Arguments, and the effort still reaches the model
   * through the prompt, which is true of every command.
   */
  const noPresetNote = el('div', { className: 'hint' });
  /*
   * The disclosure's own heading follows what is inside it: with no preset
   * there is no model and no effort in there, and a summary that promises
   * both is a promise the block does not keep.
   */
  let commandSummary = null;
  /*
   * The model and the effort, as one thing that appears and disappears.
   *
   * Built here rather than inline below because `setChildren` returns what
   * `replaceChildren` returns, which is nothing — passing its result as a
   * child put `undefined` in the tree and the whole block simply was not
   * there.
   */
  const modelAndEffort = el('div', {}, [
    el('div', { className: 'lbl', textContent: 'Model' }),
    modelChips,
    modelOther,
    modelList,
    liveModelsNote,
    modelNote,
    el('div', { className: 'lbl', textContent: 'Effort' }),
    effortSlider,
    effortScale,
    effortNote,
    advanced('A different model for a particular kind of work', taskGrid),
  ]);
  const showModelNote = () => {
    const chosen = AI_PRESETS.find((p) => p.label !== 'Custom…' && p.command === command.value.trim());
    if (chosen && fromCli.get(command.value.trim()) === undefined) void askAboutModels(command.value.trim());
    refreshModelChoices();
    showEffortLabel();

    modelAndEffort.hidden = !chosen;
    noPresetNote.hidden = Boolean(chosen);
    if (commandSummary) {
      commandSummary.textContent = chosen
        ? 'Advanced — the exact command, the model and the effort'
        : 'Advanced — the exact command';
    }
    if (!chosen) {
      noPresetNote.textContent =
        `"${command.value.trim() || 'this command'}" is not one of the presets, so there is no model or effort to ` +
        'choose here: put the flags it wants in Arguments. The effort is still asked for in the prompt, which ' +
        'reaches every model.';
      return;
    }
    modelNote.textContent = chosen.model
      ? `Passed as ${chosen.model.flag}. Leave it empty to let ${chosen.command} choose.`
      : `${chosen.command} has no model switch, so this is ignored.`;
    effortNote.textContent = chosen.effort
      ? `Passed as ${chosen.effort.flag}, and said in the prompt as well.`
      : `${chosen.command} has no effort switch, so this is asked for in the prompt instead — which every model understands, less precisely than a flag would.`;
  };

  const engine = el('select');
  for (const e of ['', 'tectonic', 'latexmk', 'pdflatex']) {
    engine.append(
      el('option', { value: e, textContent: e || 'Auto-detect', selected: (config.latex.engine ?? '') === e }),
    );
  }
  let savedEngine = config.latex.engine ?? '';
  // After the options exist, or there is nothing for a restored value to select.
  keepsValue(engine, 'latex-engine', savedEngine);

  /*
   * The exact invocation, folded away.
   *
   * Choosing a preset, a model and an effort level is the whole of what
   * almost everyone needs, and leading with a command line and an argument
   * template full of `{promptText}` placeholders made the panel look like
   * something you had to understand before you could use any of it.
   *
   * Open to begin with when what is saved is not a preset, because then it
   * is the only thing on the panel that says what is actually going to run —
   * and hiding a command somebody typed themselves is how they come to
   * believe the preset they picked took effect when it did not.
   */
  const commandBlock = advanced(
    'Advanced — the exact command, the model and the effort',
    field('Command', command, 'Must be on your PATH.'),
    field(
      'Arguments',
      args,
      '{prompt} is a file holding the prompt, {promptText} inlines it, {sandbox} is the scratch directory.',
    ),
    field('Timeout, seconds', timeout),
    /*
     * The model and the effort live here, below the command, because they are
     * facts about that command: which names are even offered depends on which
     * CLI is chosen, and neither means anything until one is. Picking a preset
     * is the whole of what most people need from this panel — and a command
     * that is not a preset gets this whole block hidden rather than a pair of
     * controls that cannot do anything.
     */
    modelAndEffort,
    noPresetNote,
  );
  commandSummary = commandBlock.querySelector('summary');
  commandBlock.open = !matching;

  const result = el('div', { className: 'result idle', textContent: 'Not tested yet.' });
  /* Where the clock and the way into the run go while the test is running. */
  const testNotes = el('div', { className: 'ai-notes' });

  /*
   * Whether what is on screen is what will actually run.
   *
   * These four fields wait for a button, and until now nothing said so. A
   * command typed here, or filled in by the preset picker, sat in the box
   * looking exactly like a saved one — so the next AI run used the old value
   * and reported a failure naming a command the user believed they had
   * replaced. The box has to be able to say "this is not saved".
   */
  const unsaved = el('span', { className: 'hint warn', hidden: true, textContent: 'Not saved yet.' });
  const aiIsDirty = () =>
    command.value !== command.dataset.stored ||
    args.value !== args.dataset.stored ||
    timeout.value !== timeout.dataset.stored ||
    model.value !== model.dataset.stored ||
    [...perTask.values()].some((box) => box.value !== box.dataset.stored) ||
    effortValue() !== savedEffort ||
    (engine.value || '') !== savedEngine;
  const markAiUnsaved = () => {
    unsaved.hidden = !aiIsDirty();
  };
  for (const input of [command, args, timeout, model, ...perTask.values()]) {
    input.oninput = () => {
      markAiUnsaved();
      // The command decides what the model box can even do, so its note
      // follows what is typed rather than what was last saved.
      showModelNote();
    };
  }
  engine.onchange = markAiUnsaved;
  effortSlider.oninput = () => {
    showEffortLabel();
    markAiUnsaved();
  };
  showModelNote();
  markAiUnsaved();

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
          model: model.value.trim(),
          models: Object.fromEntries([...perTask].map(([key, box]) => [key, box.value.trim()])),
          effort: effortValue() || undefined,
          timeoutMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 180_000,
        },
        latex: { engine: engine.value || undefined },
      }),
    });
    /*
     * These now match the store, so the next rebuild should refresh them
     * rather than treat them as unsaved edits and keep them forever — which
     * would mean a change made in another window never arrived here again.
     */
    for (const input of [command, args, timeout, model, effortSlider, engine, ...perTask.values()]) {
      input.dataset.stored = input.value;
    }
    savedEngine = engine.value || '';
    savedEffort = effortValue();
    markAiUnsaved();
    setStatus('Settings saved');
  };

  const saveAndTest = async () => {
    /*
     * "Running…" and nothing else, for as long as the command takes.
     *
     * This is the one button whose entire purpose is to find out what a
     * command does, and it was the one that said least about it: no clock, no
     * way into the run, and on a command that hangs, three minutes of a word.
     * It goes through the same progress as every other AI action now, which
     * is also what puts "What it's doing" beside it.
     */
    const stopProgress = showAiProgress(
      testNotes,
      'Trying the command',
      null,
      'This runs the command exactly as the rest of the tool will.',
    );
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
    } finally {
      stopProgress();
    }
  };

  /*
   * Picking a preset saves it, and tries it.
   *
   * It used to only fill the two boxes, which meant the most deliberate
   * action in this panel — choosing from a list of three known-good
   * configurations — was the one that did nothing until you also found the
   * Save button. Someone who picked a preset and went back to writing kept
   * running the old command, and the failure they then got named that old
   * command, which reads as the preset having been ignored.
   *
   * A preset is a complete, known setting, not a half-typed one: there is
   * nothing here to protect from being committed too early. Saving it and
   * then running the one-line test is the whole of what the next two buttons
   * would have done, and finding out now beats finding out in the middle of
   * an application.
   */
  preset.onchange = () => {
    const chosen = AI_PRESETS.find((p) => p.label === preset.value);
    showPresetNote();
    if (!chosen || chosen.label === 'Custom…') {
      markAiUnsaved();
      return;
    }
    command.value = chosen.command;
    args.value = chosen.args.join(' ');
    showModelNote();
    markAiUnsaved();
    return saveAndTest();
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
    researchNote,
    config.overrides.ai
      ? el('div', { className: 'override', textContent: 'RMM_AI=0 is set, so the AI stays off whatever this says.' })
      : null,
    field('Preset', preset),
    presetNote,
    drifted
      ? el('div', { className: 'hint warn' }, [
          el('span', {
            textContent: `These arguments are not the "${drifted.label}" preset's any more. `,
          }),
          el('button', {
            className: 'link',
            // The whole phrase, not a possessive with its noun in the next
            // node: "Use the preset’s — that saves and tests it." is not a
            // sentence, and it is the only instruction on a warning about a
            // command that will not run.
            textContent: `Put the "${drifted.label}" arguments back`,
            onclick: () => {
              preset.value = drifted.label;
              preset.onchange();
            },
          }),
          el('span', { textContent: ' — that saves them and tests the command.' }),
        ])
      : null,
    /*
     * The exact invocation, folded away.
     *
     * Choosing a preset, a model and an effort level is the whole of what
     * almost everyone needs, and leading with a command line and an argument
     * template full of `{promptText}` placeholders made the panel look like
     * something you had to understand before you could use any of it. It is
     * still one click away, and it opens by itself when what is saved is not
     * a preset — because then it is the only thing on the panel that explains
     * what is going to run.
     */
    commandBlock,
    /*
     * Below the command, because it is a record of that command being run:
     * what it did last time is the first thing worth reading when what it
     * does this time is nothing.
     */
    aiActivityPanel(),
    el('div', { className: 'sandbox-note' }, [
      el('b', {}, 'Confined to a scratch directory. '),
      'The command runs in an empty temporary folder containing only the prompt — never your save folder, ' +
        'your home directory, or this source tree. The presets add each CLI’s own read-only flags on top.',
    ]),
    field('LaTeX engine', engine, 'Auto-detect tries tectonic, then latexmk, then pdflatex.'),
    el('div', { className: 'row' }, [
      el('button', { className: 'primary', textContent: 'Save', onclick: () => save().catch((e) => setStatus(e.message, true)) }),
      el('button', { textContent: 'Save and test', onclick: saveAndTest }),
      unsaved,
    ]),
    testNotes,
    result,
  );
}

/* ------------------------------------------------------------------ *
 * History                                                             *
 * ------------------------------------------------------------------ */

let selectedCommit = null;
let historyResumeId = null;
/**
 * How far back to ask for, which the button at the bottom of the timeline
 * raises. Thirty was the server's default and the only value there was, so
 * everything past it — including, on a busy save, the resume's whole real
 * history — was simply absent with nothing saying so.
 */
const HISTORY_PAGE = 30;
let historyWanted = HISTORY_PAGE;

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
  showRestoreNote([]);
  try {
    const { versions, more } = await api(
      `/resumes/${encodeURIComponent(historyResumeId)}/history?limit=${historyWanted}`,
    );
    renderResumeTimeline(versions, Boolean(more));
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

function renderResumeTimeline(versions, more = false) {
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
          /*
           * `earliest` means the scan stopped here, not that the resume
           * started here. Without it this card fell back to the commit
           * message — which, on a busy save, is some unrelated commit's
           * message presented as the moment this resume was created.
           */
          v.earliest
            ? [el('div', { className: 'c muted', textContent: 'The oldest version shown — there are older ones further back.' })]
            : changes.length > 0
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

  /*
   * And a way to the rest of it.
   *
   * The server scans a window of the store's commits and then keeps the
   * newest `limit` of what it found, so two different cut-offs could hide a
   * version — and neither said anything. The reply reports either as `more`,
   * and the answer to both is the same: ask again for more.
   */
  if (more) {
    timeline.append(
      el('div', { className: 'actions-row' }, [
        el('button', {
          className: 'tiny',
          textContent: 'Show older versions',
          onclick: (event) => {
            event.currentTarget.disabled = true;
            historyWanted += HISTORY_PAGE;
            void loadResumeHistory();
          },
        }),
      ]),
    );
  }
}

async function restoreResumeVersion(hash) {
  /*
   * Taken once, before anything waits.
   *
   * `historyResumeId` belongs to the dropdown above the timeline, and a
   * dropdown is a thing somebody can use while this is running — the flush
   * below is a round trip, and an unsaved edit makes it a slow one. Read
   * again afterwards, the restore went to whichever resume was selected by
   * then, carrying a version from a different resume's timeline: the server
   * reads that commit's file for the id it is given and saves it, so a resume
   * nobody was looking at was overwritten out of a commit that was never
   * shown for it, under a confirmation naming something else.
   */
  const wanted = historyResumeId;
  if (!wanted) return;
  if (!confirm('Restore this version? The current version will be replaced (its own history is kept, so you can still get back to it).')) {
    return;
  }
  try {
    /*
     * Before the restore, not after: you reach for an old version precisely
     * when there are selections on screen, and discarding them silently is
     * the opposite of what the version history is for.
     */
    if (wanted === state.resumeId) await flushEdits();
    const back = await api(`/resumes/${encodeURIComponent(wanted)}/history/${encodeURIComponent(hash)}/restore`, {
      method: 'POST',
    });
    /*
     * And the undo stack goes, for the reason a stack from another save goes
     * — see `projectChanged`. Its entries are "this document before and after
     * an edit", and the document they describe is the one that has just been
     * replaced. Undo is always enabled and says nothing about what it is
     * about to undo, so one press after a restore put the pre-restore
     * document back over the restored one, reported "Undid change", and left
     * no sign that the version somebody had just gone to fetch was gone.
     */
    forgetHistory();
    /*
     * And what the server said about how much of that version actually came
     * back, which this used to throw away.
     *
     * The endpoint compares the document as it was at that commit against the
     * document as it is now and reports the difference, precisely so a
     * half-restore is not announced as a whole one: the rest of that version
     * can live in a bullet, a date or a profile this resume shares with
     * others, and those are left alone rather than changed for every resume
     * at once. The reply carried the explanation and the editor discarded it,
     * so the document came back visibly not matching the version that had
     * just been clicked, under the word "Restored."
     */
    const said = Array.isArray(back?.warnings) ? back.warnings : [];
    setStatus(said.length > 0 ? 'Restored — some of it was left alone. See the note above.' : 'Restored.', said.length > 0);
    await loadStore();
    if (wanted === state.resumeId) {
      clearEdits();
      setSaveState('saved');
      render();
      scheduleRender();
    }
    await loadResumeHistory();
    // After the reload, which clears it: the note is about the restore that
    // has just happened, not about the timeline being redrawn.
    showRestoreNote(said);
  } catch (err) {
    setStatus(err.message, true);
  }
}

/** What a restore could not put back, beside the timeline it came from. */
function showRestoreNote(lines) {
  const note = $('#restore-note');
  if (!note) return;
  note.hidden = lines.length === 0;
  note.replaceChildren(...lines.map((w) => el('div', { textContent: w })));
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

function showModal(title, content, { note = '', okLabel = 'Close', showCancel = false, cancelLabel = 'Cancel' } = {}) {
  $('#modal-title').textContent = title;
  $('#modal-content').replaceChildren(content);
  $('#modal-note').textContent = note;
  $('#modal-cancel').style.display = showCancel ? '' : 'none';
  // "Skip" and "Cancel" are different promises when there are eleven of these
  // to get through: one moves on, the other sounds like it stops.
  $('#modal-cancel').textContent = cancelLabel;
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
        const cb = el('input', { type: 'checkbox', checked: Boolean(f.value), id: `f_${f.name}`, name: f.name });
        inputs[f.name] = { get: () => cb.checked };
        content.append(
          el('label', { className: 'form-label', style: 'display:flex;gap:7px;align-items:center;cursor:pointer' }, [
            cb,
            f.label,
          ]),
        );
        continue;
      }
      content.append(el('label', { className: 'form-label', htmlFor: `f_${f.name}`, textContent: f.label }));

      if (f.type === 'select') {
        const sel = el('select', { style: 'width:100%', name: f.name, id: `f_${f.name}` });
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

      // Named, so the field is identifiable — by a test, by the browser, and by
       // anything reading the form other than a person looking at it.
      const input = f.multiline
        ? el('textarea', { value: f.value ?? '', style: f.tall ? 'min-height:220px' : '', name: f.name, id: `f_${f.name}` })
        : el('input', { type: 'text', value: f.value ?? '', name: f.name, id: `f_${f.name}` });
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

  /*
   * One group per tier. A save fills up with resumes made for one posting
   * each; the two or three you actually build from should not have to be
   * found among them, and the ones on their way out should sort last rather
   * than alphabetically through the middle.
   *
   * This used to key off a pin, and the grouping therefore only appeared once
   * something had been pinned — which is never, in a save nobody has pinned
   * anything in, meaning every save to begin with. So the list stayed flat
   * for exactly the people who had not yet found the pin. Every resume has a
   * tier now, including the ones a migration gave one to, so there is always
   * something to group by.
   *
   * An empty group is left out rather than shown empty: "Temporary" over
   * nothing reads as a section that failed to load.
   */
  const LABELS = {
    base: 'Bases — what you build from',
    extended: 'Kept',
    temporary: 'Made for a posting — swept when it is done',
  };
  const groups = TIER_ORDER.map((tier) => [LABELS[tier], state.store.resumes.filter((r) => tierOf(r) === tier)])
    .filter(([, list]) => list.length > 0);

  select.replaceChildren(
    el('option', { value: '__master__', textContent: 'Master Document — All Source Content' }),
    // One group is no grouping: a save with three resumes all of one kind
    // reads better as a plain list than as a list under a heading.
    ...(groups.length > 1
      ? groups.map(([label, list]) => el('optgroup', { label }, list.map(option)))
      : state.store.resumes.map(option)),
  );
  select.value = state.masterView ? '__master__' : state.resumeId;
  drawWayBack();
  $('#btn-base').hidden = state.masterView;
  $('#btn-save-as').hidden = state.masterView;
  // Not on the master, which is not a variation.
  $('#btn-delete-resume').hidden = state.masterView || (state.store.resumes ?? []).length < 2;
  /*
   * The label only, not the whole button.
   *
   * `textContent` on the button replaces every child, and one of them is the
   * ✦ that marks this as something that runs the AI. It is in the markup and
   * was on screen exactly until the first render, which is why it looked as
   * though it had never been there. Every other AI control in the editor
   * carries the mark; this is the one that costs the most to press.
   *
   * And the word "AI" in the label as well as the mark, because "Resume
   * Feedback" beside "Rebuild" and "Undo" reads as another local action
   * rather than minutes of a model.
   */
  $('#btn-feedback').querySelector('span:not(.ai-mark)').textContent = state.masterView
    ? 'AI Master Feedback'
    : 'AI Resume Feedback';
  $('#resume-view-note').textContent = state.masterView
    ? 'All source entries and phrasings. Edits here update every tailored resume that uses them.'
    : 'Select source content for this resume. Shared wording edits also update the master and other resumes that use it.';
  renderBaseButton();
  renderEditor();
}

/**
 * What this resume is, and the one click that changes it.
 *
 * A cycle rather than three buttons. There are three tiers and two of the
 * moves are rare — you mark a base once and leave it, and you promote a
 * temporary resume you turned out to want — so three controls in a toolbar
 * would be two pieces of permanent furniture for one occasional act. The
 * button says what the resume *is*; its title says what pressing it does.
 */
const TIER_LOOK = {
  base: {
    label: '★ Base',
    className: 'tiny pinned',
    next: 'extended',
    title: 'New resumes and tailored drafts start from this one. Click to keep it without starting from it.',
    said: 'Now a base',
    undo: 'making this a base',
  },
  extended: {
    label: '☆ Kept',
    className: 'tiny',
    next: 'base',
    title: 'Kept in this save and never swept. Click to make it one of the ones you build from.',
    said: 'Kept',
    undo: 'keeping this resume',
  },
  temporary: {
    label: '⌛ Temporary',
    className: 'tiny temporary',
    next: 'extended',
    title: 'Made for one posting, and swept a week after that posting is done. Click to keep it.',
    said: 'Now temporary',
    undo: 'making this temporary',
  },
};

function renderBaseButton() {
  const btn = $('#btn-base');
  if (!btn) return;
  const spec = state.store.resumes.find((r) => r.id === state.resumeId);
  const look = TIER_LOOK[spec?.tier ?? 'extended'];

  btn.textContent = look.label;
  btn.className = look.className;
  btn.title = look.title;
  btn.disabled = !spec;
  btn.onclick = async () => {
    try {
      /*
       * Grouped so that it is a step at all.
       *
       * `/resumes/:id/tier` is a partial write, which `docKeyFor` refuses —
       * rightly, since it cannot snapshot a document from a path that does
       * not name one. So no step was recorded, while every step already on
       * the stack still carried the *old* tier, and undo replays a whole
       * resume. Promote a temporary resume to Kept so the sweep can no longer
       * delete it, then press Ctrl+Z meaning "take back that checkbox": the
       * resume goes back to Temporary with its original start date, and the
       * sweep deletes it. Naming the document it changes makes it an ordinary
       * step, and stops a later undo silently reverting it.
       */
      await undoGroup(TIER_LOOK[look.next].undo ?? 'change', [`resume:${state.resumeId}`], async () => {
        await api(`/resumes/${encodeURIComponent(state.resumeId)}/tier`, {
          method: 'PUT',
          body: JSON.stringify({ tier: look.next }),
        });
      });
      await loadStore();
      setStatus(TIER_LOOK[look.next].said);
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
      resumes.find((r) => r.tier === 'base')?.id ??
      resumes.find((r) => r.id === 'newgrad')?.id ??
      resumes.find((r) => !r.copiedFrom && !r.generatedFor)?.id ??
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
    const trail = build[2] ? decodeURIComponent(build[2]) : null;
    showTab('resumes');
    if (state.store.resumes.some((r) => r.id === wanted)) {
      /*
       * Through the same door as the dropdown — see `leaveResume`. Writing
       * what is pending before moving is the part this route used to miss
       * entirely, so following the way back, or pressing the browser's own
       * Back button, inside the auto-save debounce dropped the edit and left
       * the save chip reading "Unsaved changes" forever with nothing unsaved
       * and nothing that would ever save it.
       *
       * Everything the move changes is set inside, so a move that is refused
       * leaves the screen exactly as it was rather than half-way between two
       * resumes.
       */
      const moved = await leaveResume(() => {
        state.masterView = false;
        state.resumeId = wanted;
        state.fromDraftId = trail;
        state.fromDraft = null;
      });
      /*
       * Refused, because the edit on screen has not saved yet. The dropdown
       * puts itself back when that happens and the address has to do the
       * same: left pointing at the other resume, the Back button — which is
       * how most people arrive here — takes the edit with it, and a reload
       * opens a resume nobody asked for.
       */
      if (!moved) {
        const here = state.fromDraftId
          ? `#resumes/${encodeURIComponent(state.resumeId)}/from/${encodeURIComponent(state.fromDraftId)}`
          : `#resumes/${encodeURIComponent(state.resumeId)}`;
        if (location.hash !== here) location.hash = here;
        return true;
      }
    } else {
      state.fromDraftId = trail;
      state.fromDraft = null;
      /*
       * Said in words rather than as a filename.
       *
       * This printed the id — `job-helios-platform-engineer` — which names
       * nothing the person has ever typed, and it used to be the rare case of
       * somebody having deleted a resume by hand. A resume made for one
       * posting is now removed a week after that posting is done with, so
       * every way back from an older application arrives here.
       */
      setStatus(
        'That resume is no longer in the save. One made for a single posting is removed once ' +
          'the application is done with — the files that were sent are still on the application, ' +
          'and the version history still has the resume.',
        true,
      );
    }
    if (state.fromDraftId) loadFromDraft().catch(() => undefined);
    render();
    scheduleRender();
    return true;
  }

  /*
   * `#applications/<id>` opens the tracker on one application.
   *
   * The card in the browser can now say "you applied to this on the twelfth of
   * March" while you are standing on the posting, and the honest next question
   * is "what did I send them?". Without a way through, the answer is: open the
   * editor, find the tracker, and scroll back through everything since March.
   */
  const tracked = /^#applications\/(.+)$/.exec(location.hash);
  if (tracked) {
    // Set before the tab is shown, because showing it loads the list and the
    // row marks itself as the selected one while it renders. Done afterwards,
    // the link opened the right record beside a table with nothing
    // highlighted in it, and nothing on screen connected the two.
    openApplicationId = decodeURIComponent(tracked[1]);
    showTab('applications');
    await openApplication(openApplicationId).catch(() => undefined);
    return true;
  }

  // A bare `#voice` or `#applications` opens that tab. The extension links
  // here when it needs to send someone to a setting, and a link that lands on
  // the wrong tab is worse than no link.
  const requestedTab = /^#([a-z]+)$/.exec(location.hash)?.[1];
  const tab = ['assets', 'project'].includes(requestedTab) ? 'save'
    : ['build', 'master'].includes(requestedTab) ? 'resumes' : requestedTab;
  if (requestedTab === 'master' || requestedTab === 'build') {
    // Through the same door as the dropdown. This set the view and rendered,
    // which left the previous resume's unsaved edits sitting over a document
    // they do not belong to. See `leaveResume`.
    await leaveResume(() => {
      state.masterView = requestedTab === 'master' || !state.resumeId;
    });
  }
  if (tab && document.querySelector(`#tabs button[data-tab="${tab}"]`)) {
    showTab(tab);
    return true;
  }
  return false;
}

/**
 * Put down the resume on screen and pick up another one.
 *
 * Its own function because there are two ways to leave a resume and only one
 * of them was doing this. The dropdown flushed, saved and cleared; arriving
 * at `#master` or `#build` — which is a link the extension hands out — set
 * the view and rendered, leaving the previous resume's unsaved overlay in
 * `state.choices`, `state.entryEdits` and the rest, sitting over a document
 * they do not belong to.
 *
 * A save that did not land is not a reason to say nothing. Refusing to move
 * is right — the alternative is throwing away an edit — but the first version
 * of that just put the dropdown back and left it there, so picking another
 * resume looked like a control that does not work. The usual cause is one
 * failed request, so it is tried once more; if it still will not save, say so
 * and leave the edit where it can still be rescued.
 *
 * Returns whether it moved.
 */
async function leaveResume(go) {
  const landed = await flushEdits();
  if (state.dirty) await autoSave().catch(() => {});
  if (state.dirty || !landed) {
    setStatus('That change has not saved yet, so the resume on screen stays until it does.', true);
    return false;
  }

  clearTimeout(renderTimer);
  renderToken++;
  go();
  clearEdits();
  setSaveState('saved');
  render();
  scheduleRender();
  return true;
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
  /*
   * Wire the toolbar's chips once, at the start.
   *
   * This only ever ran from `startDrafting`, which is to say only once some
   * AI work had begun — so on a freshly loaded page the "What the AI is
   * doing" button was drawn by the markup and had no click handler attached
   * to it at all. It looked like a way in and was not one, which is worse
   * than not being there.
   */
  renderDraftingChip();

  $('#feedback-close').onclick = () => { $('#feedback-panel').hidden = true; };
  $('#feedback-select').onchange = event => {
    const job = feedbackJobs.find(item => item.id === event.target.value);
    if (job) openJob(job);
  };
  assetUI = setupAssets({ api, el, setChildren, readAsBase64, flushEdits, isDirty: () => state.dirty,
    reloadStore: async () => { await loadStore(); render(); }, entryName, status: setStatus,
    projectChanged: dir => {
      activeProject = dir;
      // A stack of edits to another save is meaningless here and dangerous if
      // applied: the ids in it belong to somebody else's documents.
      forgetHistory();
      paintUndo();
    }, loadProjectSettings });
  setupTabs();
  const project = await assetUI.init();
  if (!project.current) { showTab('save'); return; }
  setupHistoryTab();
  await loadStore();
  render();

  $('#resume-select').onchange = async (e) => {
    const next = e.target.value;
    const moved = await leaveResume(() => {
      state.masterView = next === '__master__';
      if (!state.masterView) state.resumeId = next;
    });
    // Put the dropdown back where the screen still is, or it shows a resume
    // that is not the one in front of you.
    if (!moved) e.target.value = state.masterView ? '__master__' : state.resumeId;
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
  $('#btn-delete-resume').onclick = deleteVariation;
  $('#btn-feedback').onclick = () => askFeedback(state.masterView);
  $('#btn-rebuild').onclick = renderPreview;
  $('#btn-add-entry').onclick = async () => {
    /*
     * Both ways in, from the button people actually press.
     *
     * Drafting with the AI existed, but only from a link in the master view —
     * so the obvious button gave you a blank form and nothing said the other
     * way was there. The blank form stays the default: it is instant, and the
     * AI only ever proposes text you then edit.
     */
    const aiOn = Boolean(state.store?.config?.ai?.enabled);
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
      {
        name: 'how',
        label: 'Start from',
        type: 'select',
        value: 'blank',
        options: [
          { value: 'blank', label: 'A blank entry I fill in myself' },
          {
            value: 'ai',
            label: aiOn
              ? '✦ A draft from the AI — a repository link, or a line about it'
              : '✦ A draft from the AI (off — you will get the prompt to paste)',
          },
        ],
      },
    ]);
    if (!answer?.kind) return;
    if (answer.how === 'ai') draftEntryWithAi(answer.kind);
    else addEntry(answer.kind);
  };
  // Anything the AI was still doing when the tab was closed is picked up here.
  refreshJobs().catch(() => {});

  $('#btn-add-app').onclick = addApplication;

  /*
   * Narrowing the tracker. Both redraw from the list already in hand rather
   * than asking the server again — this is a view of what is loaded, not a
   * query, so it answers as fast as somebody types.
   */
  const narrow = () => {
    appFilter = {
      text: ($('#app-find')?.value ?? '').trim(),
      status: $('#app-status')?.value ?? '',
    };
    loadApplications().catch((e) => setStatus(e.message, true));
  };
  if ($('#app-find')) $('#app-find').oninput = narrow;
  if ($('#app-status')) $('#app-status').onchange = narrow;
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

  // Narrowing the two lists on the Letters & Answers tab. Both redraw from
  // what is already loaded, so they answer as fast as somebody types.
  const narrowWriting = () => {
    letterFilter = ($('#letter-find')?.value ?? '').trim();
    answerFilter = ($('#answer-find')?.value ?? '').trim();
    loadLetters().catch((e) => setStatus(e.message, true));
  };
  if ($('#letter-find')) $('#letter-find').oninput = narrowWriting;
  if ($('#answer-find')) $('#answer-find').oninput = narrowWriting;
  $('#btn-add-sample').onclick = () => addSample().catch((e) => setStatus(e.message, true));
  wireVoiceDrop();
  // Typing is what makes the box differ from the store, so it is what turns
  // the note on — and what stops `loadVoice` overwriting it.
  $('#voice').oninput = markVoiceUnsaved;
  $('#btn-save-voice').onclick = async () => {
    const saved = $('#voice').value;
    await api('/voice', { method: 'PUT', body: JSON.stringify({ voice: saved }) });
    // Before the reload, or the box still counts as edited and `loadVoice`
    // would politely decline to refresh the very thing it just saved.
    voiceAsLoaded = saved;
    setStatus('Notes saved');
    loadVoice();
  };

  $('#btn-undo').onclick = () => stepHistory('undo');
  $('#btn-redo').onclick = () => stepHistory('redo');
  paintUndo();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) {
      $('#modal-cancel').click();
      return;
    }

    /*
     * Cmd/Ctrl+Z, and Shift for redo.
     *
     * Not while typing: inside a text box the browser's own undo is the one
     * you want, and hijacking it to revert a whole document because you
     * pressed it mid-sentence would be startling. Once you leave the box the
     * edit has been written, and this is the undo that applies.
     */
    const meta = e.metaKey || e.ctrlKey;
    if (!meta || e.key.toLowerCase() !== 'z') return;
    const el = document.activeElement;
    const typing = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
    if (typing) return;
    if (!$('#modal').classList.contains('hidden')) return;

    /*
     * Only where the history belongs.
     *
     * This undo is the resume builder's, and it reverted a resume edit from
     * whichever tab happened to be open — so Ctrl+Z while reading the
     * Applications list, or with a cover letter on screen, silently rolled back
     * an edit made somewhere the user was not looking. Anywhere else the key
     * does nothing, which is the honest answer: there is nothing here it means.
     */
    if (!$('#tab-resumes')?.classList.contains('active')) return;

    e.preventDefault();
    stepHistory(e.shiftKey ? 'redo' : 'undo');
  });

  /*
   * Last, because it waits.
   *
   * Following a deep link opens a resume, which is a request and a compile,
   * and every line above this used to sit behind that wait — so between the
   * toolbar being drawn and this finishing, the resume dropdown was a full
   * list of resumes attached to nothing. Picking one did not change anything
   * and did not say anything: the next repaint simply put the old name back.
   * It is a thin window on a fast machine and a wide one on a loaded machine
   * or a big save, and it is exactly when someone reaches for that dropdown,
   * because the first thing you do on arriving is choose what to work on.
   *
   * Wiring is assignment; nothing here needs the deep link to have happened.
   * So the controls are live the moment they are on screen, and this — the
   * part that talks to the server — happens after.
   */
  window.addEventListener('hashchange', () => applyHash().catch(() => {}));
  // A deep link means the user came here to write, not to look at a resume;
  // skip the compile they did not ask for.
  const deepLinked = await applyHash().catch(() => false);
  if (!deepLinked) showTab('resumes');
}

boot().catch((err) => setStatus(err.message, true));
