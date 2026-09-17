/**
 * Undo/redo for the editor, expressed in *documents* rather than actions.
 *
 * Every mutating thing the editor does — renaming a skill group, deleting it,
 * adding a phrasing, reordering a resume's sections — ends as one API write of
 * one whole document. So instead of enumerating actions and their inverses
 * (which goes stale the moment a new button appears), we snapshot the document
 * before and after the write. Undo is then "PUT the old snapshot back", and a
 * document that did not exist before is snapshotted as `null`, whose restore is
 * a DELETE. That covers creation, deletion and mutation with one mechanism.
 *
 * This module is deliberately dependency-free and DOM-free: app.js drives it.
 */

/* ------------------------------------------------------------------ *
 * Clone / compare                                                     *
 * ------------------------------------------------------------------ */

/**
 * Snapshots have to survive the store being mutated underneath them, so every
 * value that crosses this module's boundary is copied, never aliased.
 */
export function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Structural equality for store documents (JSON-shaped: objects, arrays,
 * strings, numbers, booleans, null). `undefined` properties are treated as
 * absent, because a document that has been through JSON loses them and an
 * unchanged save must not look like a change.
 */
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const keysOf = (o) => Object.keys(o).filter((k) => o[k] !== undefined);
  const ka = keysOf(a);
  const kb = keysOf(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/* ------------------------------------------------------------------ *
 * Routes <-> document keys                                            *
 * ------------------------------------------------------------------ */

/**
 * The document routes, as `[pattern, docKey prefix, methods]`. Anything not
 * listed here — GETs, `/answers/save`, `/resumes/:id/base`, `/applications/*`,
 * the AI endpoints — is not a whole-document write and gets no undo entry.
 */
const SINGLETONS = {
  '/profile': 'profile',
  '/skills': 'skills',
};

const COLLECTIONS = {
  entries: 'entry',
  resumes: 'resume',
  answers: 'answer',
};

/** `'/entries/edu_neu?commit=0'` -> `'/entries/edu_neu'`. */
function bare(path) {
  const text = String(path ?? '').split('#')[0].split('?')[0].trim();
  if (!text) return '';
  const withSlash = text.startsWith('/') ? text : `/${text}`;
  // A trailing slash is the same route; `//entries` is not.
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

/**
 * Which document a mutating request touches, as a stable string:
 * `'profile'`, `'skills'`, `'entry:<id>'`, `'resume:<id>'`, `'answer:<id>'`.
 * Returns `null` for requests that do not replace a whole document — reads,
 * unknown routes, and the action-shaped POSTs.
 *
 * @param {string} path  API path *without* the `/api` prefix, query allowed.
 * @param {string} method  HTTP method; case-insensitive, defaults to GET.
 * @returns {string|null}
 */
export function docKeyFor(path, method) {
  const verb = String(method ?? 'GET').toUpperCase();
  if (verb !== 'PUT' && verb !== 'DELETE') return null; // GET reads; POST is action-shaped

  const route = bare(path);
  if (!route) return null;

  // The singletons always exist, so they are written and never deleted.
  if (SINGLETONS[route]) return verb === 'PUT' ? SINGLETONS[route] : null;

  const parts = route.slice(1).split('/');
  if (parts.length !== 2) return null; // `/resumes/:id/base` and friends are partial writes
  const kind = COLLECTIONS[parts[0]];
  if (!kind || !parts[1]) return null;

  let id = parts[1];
  try {
    id = decodeURIComponent(id); // app.js encodes ids into the path
  } catch {
    /* a malformed escape is not a valid id; keep it verbatim */
  }
  return `${kind}:${id}`;
}

/** Split `'entry:edu_neu'` into `{ kind: 'entry', id: 'edu_neu' }`. */
function parseKey(docKey) {
  const key = String(docKey ?? '');
  const at = key.indexOf(':');
  return at === -1 ? { kind: key, id: null } : { kind: key.slice(0, at), id: key.slice(at + 1) };
}

/* ------------------------------------------------------------------ *
 * Reading documents out of the client-side store                      *
 * ------------------------------------------------------------------ */

/** Where each document kind lives in `state.store`. */
const COLLECTION_FIELD = { entry: 'entries', resume: 'resumes', answer: 'answers' };

/**
 * A deep-cloned snapshot of one document out of the editor's store copy, or
 * `null` when it is absent — which is exactly the right snapshot for "this did
 * not exist yet", so that undoing a creation deletes it again.
 *
 * @param {object} store  the `state.store` shape
 * @param {string} docKey
 * @returns {any|null}
 */
export function readDoc(store, docKey) {
  if (!store || typeof store !== 'object') return null;
  const { kind, id } = parseKey(docKey);

  if (kind === 'profile') return deepClone(store.profile ?? null);
  if (kind === 'skills') return deepClone(store.skillGroups ?? null);

  const field = COLLECTION_FIELD[kind];
  if (!field || id === null) return null;
  const list = store[field];
  if (!Array.isArray(list)) return null;
  const found = list.find((doc) => doc && doc.id === id);
  return found === undefined ? null : deepClone(found);
}

/* ------------------------------------------------------------------ *
 * Turning a snapshot back into an API call                            *
 * ------------------------------------------------------------------ */

const COLLECTION_PATH = { entry: '/entries', resume: '/resumes', answer: '/answers' };

/**
 * The single API call that puts `doc` back where `docKey` says it belongs.
 * A `null` doc means the document did not exist, so the restore is a DELETE.
 * Writes carry `?commit=0` the way the editor's auto-saves do: undo is a
 * keystroke-level operation and should not bury the store's git history.
 *
 * @param {string} docKey
 * @param {any|null} doc
 * @returns {{ path: string, options: { method: string, body?: string } }}
 */
export function restoreRequest(docKey, doc) {
  const { kind, id } = parseKey(docKey);
  const missing = doc === null || doc === undefined;

  if (kind === 'profile' || kind === 'skills') {
    // There is no route that removes these, and no state in which they are
    // absent; a null snapshot here means the caller built the entry wrong.
    if (missing) throw new Error(`The ${kind} document cannot be deleted, so it cannot be restored to nothing`);
    return { path: `/${kind === 'profile' ? 'profile' : 'skills'}?commit=0`, options: { method: 'PUT', body: JSON.stringify(doc) } };
  }

  const base = COLLECTION_PATH[kind];
  if (!base || !id) throw new Error(`"${docKey}" is not a document key`);
  const path = `${base}/${encodeURIComponent(id)}`;
  if (missing) return { path, options: { method: 'DELETE' } };
  return { path: `${path}?commit=0`, options: { method: 'PUT', body: JSON.stringify(doc) } };
}

/* ------------------------------------------------------------------ *
 * The stack                                                           *
 * ------------------------------------------------------------------ */

/**
 * A bounded undo/redo stack of document snapshots.
 *
 * @param {{ limit?: number }} [options]  how many steps to keep; oldest go first
 * @returns {{
 *   record(entry: { docKey: string, before: any, after: any, label?: string }): boolean,
 *   undo(): { docKey: string, before: any, after: any, label: string }|null,
 *   redo(): { docKey: string, before: any, after: any, label: string }|null,
 *   canUndo(): boolean,
 *   canRedo(): boolean,
 *   peekUndoLabel(): string|null,
 *   peekRedoLabel(): string|null,
 *   size(): { undo: number, redo: number },
 *   clear(): void,
 *   limit: number,
 * }}
 */
export function createHistory({ limit = 50 } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  /** @type {Array<{ docKey: string, before: any, after: any, label: string }>} */
  let past = [];
  /** @type {Array<{ docKey: string, before: any, after: any, label: string }>} */
  let future = [];

  const copy = (entry) => ({
    docKey: entry.docKey,
    before: deepClone(entry.before ?? null),
    after: deepClone(entry.after ?? null),
    label: entry.label,
  });

  return {
    limit: cap,

    record({ docKey, before = null, after = null, label = 'change' } = {}) {
      if (!docKey) return false; // not a document write; nothing to undo
      // A save that changed nothing must not cost the user an undo step.
      if (deepEqual(before ?? null, after ?? null)) return false;

      past.push(copy({ docKey, before, after, label: String(label) }));
      if (past.length > cap) past = past.slice(past.length - cap); // drop the oldest
      future = []; // editing past a redo throws the redo away
      return true;
    },

    undo() {
      const entry = past.pop();
      if (!entry) return null;
      future.push(entry);
      return copy(entry);
    },

    redo() {
      const entry = future.pop();
      if (!entry) return null;
      past.push(entry);
      return copy(entry);
    },

    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,

    peekUndoLabel: () => (past.length ? past[past.length - 1].label : null),
    peekRedoLabel: () => (future.length ? future[future.length - 1].label : null),

    size: () => ({ undo: past.length, redo: future.length }),

    /** Switching saves makes every recorded edit point at another store. */
    clear() {
      past = [];
      future = [];
    },
  };
}
