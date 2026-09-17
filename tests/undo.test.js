import { describe, expect, it } from 'vitest';
import { createHistory, deepClone, deepEqual, docKeyFor, readDoc, restoreRequest } from '../web/undo.js';

/** A store shaped like the editor's `state.store`. */
function makeStore() {
  return {
    profile: { name: 'Ada Lovelace', email: 'ada@example.com', autofill: { phone: '555' } },
    entries: [
      { id: 'edu_neu', kind: 'education', org: 'Northeastern', bullets: [{ id: 'b1', phrasings: ['One'] }] },
      { id: 'job_acme', kind: 'experience', org: 'Acme' },
    ],
    skillGroups: [{ id: 'langs', label: 'Languages', items: ['TypeScript'] }],
    resumes: [{ id: 'base', label: 'Base', sections: [] }],
    answers: [{ id: 'a1', question: 'Why us?', text: 'Because.' }],
  };
}

describe('docKeyFor', () => {
  it('maps each document route to a stable key', () => {
    expect(docKeyFor('/profile', 'PUT')).toBe('profile');
    expect(docKeyFor('/skills', 'PUT')).toBe('skills');
    expect(docKeyFor('/entries/edu_neu', 'PUT')).toBe('entry:edu_neu');
    expect(docKeyFor('/entries/edu_neu', 'DELETE')).toBe('entry:edu_neu');
    expect(docKeyFor('/resumes/base', 'PUT')).toBe('resume:base');
    expect(docKeyFor('/resumes/base', 'DELETE')).toBe('resume:base');
    expect(docKeyFor('/answers/a1', 'PUT')).toBe('answer:a1');
    expect(docKeyFor('/answers/a1', 'DELETE')).toBe('answer:a1');
  });

  it('ignores query strings and is case-insensitive about the method', () => {
    expect(docKeyFor('/profile?commit=0', 'put')).toBe('profile');
    expect(docKeyFor('/resumes/base?commit=0', 'PUT')).toBe('resume:base');
    expect(docKeyFor('/entries/edu_neu?commit=false&x=1', 'Put')).toBe('entry:edu_neu');
    expect(docKeyFor('/skills/', 'PUT')).toBe('skills');
  });

  it('decodes ids that app.js encoded into the path', () => {
    expect(docKeyFor(`/entries/${encodeURIComponent('job acme/2024')}`, 'PUT')).toBe('entry:job acme/2024');
    expect(docKeyFor(`/answers/${encodeURIComponent('why us?')}`, 'DELETE')).toBe('answer:why us?');
  });

  it('returns null for reads, action routes and partial writes', () => {
    expect(docKeyFor('/store', 'GET')).toBeNull();
    expect(docKeyFor('/entries/edu_neu', 'GET')).toBeNull();
    expect(docKeyFor('/entries/edu_neu')).toBeNull(); // defaults to GET
    expect(docKeyFor('/answers/save', 'POST')).toBeNull();
    expect(docKeyFor('/answers/match', 'POST')).toBeNull();
    expect(docKeyFor('/resumes/base/base', 'PUT')).toBeNull();
    expect(docKeyFor('/applications/app1', 'DELETE')).toBeNull();
    expect(docKeyFor('/voice/samples/s1', 'PUT')).toBeNull();
    expect(docKeyFor('/profile', 'DELETE')).toBeNull(); // there is no such route
    expect(docKeyFor('/entries', 'PUT')).toBeNull();
    expect(docKeyFor('', 'PUT')).toBeNull();
    expect(docKeyFor(undefined, 'PUT')).toBeNull();
  });
});

describe('readDoc', () => {
  it('reads each kind of document out of the store', () => {
    const store = makeStore();
    expect(readDoc(store, 'profile')).toEqual(store.profile);
    expect(readDoc(store, 'skills')).toEqual(store.skillGroups);
    expect(readDoc(store, 'entry:edu_neu')).toEqual(store.entries[0]);
    expect(readDoc(store, 'resume:base')).toEqual(store.resumes[0]);
    expect(readDoc(store, 'answer:a1')).toEqual(store.answers[0]);
  });

  it('returns null for documents that do not exist yet', () => {
    const store = makeStore();
    expect(readDoc(store, 'entry:nope')).toBeNull();
    expect(readDoc(store, 'resume:nope')).toBeNull();
    expect(readDoc(store, 'answer:nope')).toBeNull();
    expect(readDoc({}, 'profile')).toBeNull();
    expect(readDoc({}, 'skills')).toBeNull();
    expect(readDoc({}, 'entry:edu_neu')).toBeNull();
    expect(readDoc(null, 'profile')).toBeNull();
    expect(readDoc(store, 'nonsense')).toBeNull();
    expect(readDoc(store, null)).toBeNull();
  });

  it('deep clones, so later edits to the store cannot corrupt the snapshot', () => {
    const store = makeStore();
    const snapshot = readDoc(store, 'entry:edu_neu');
    store.entries[0].bullets[0].phrasings.push('Two');
    store.entries[0].org = 'Somewhere else';
    expect(snapshot.bullets[0].phrasings).toEqual(['One']);
    expect(snapshot.org).toBe('Northeastern');

    const profile = readDoc(store, 'profile');
    store.profile.autofill.phone = '999';
    expect(profile.autofill.phone).toBe('555');

    const skills = readDoc(store, 'skills');
    store.skillGroups[0].items.push('Rust');
    expect(skills[0].items).toEqual(['TypeScript']);
  });
});

describe('restoreRequest', () => {
  it('writes a document back with ?commit=0, like the editor auto-saves', () => {
    const doc = { id: 'edu_neu', org: 'Northeastern' };
    expect(restoreRequest('entry:edu_neu', doc)).toEqual({
      path: '/entries/edu_neu?commit=0',
      options: { method: 'PUT', body: JSON.stringify(doc) },
    });
    expect(restoreRequest('resume:base', { id: 'base' })).toEqual({
      path: '/resumes/base?commit=0',
      options: { method: 'PUT', body: JSON.stringify({ id: 'base' }) },
    });
    expect(restoreRequest('answer:a1', { id: 'a1' })).toEqual({
      path: '/answers/a1?commit=0',
      options: { method: 'PUT', body: JSON.stringify({ id: 'a1' }) },
    });
    expect(restoreRequest('profile', { name: 'Ada' })).toEqual({
      path: '/profile?commit=0',
      options: { method: 'PUT', body: JSON.stringify({ name: 'Ada' }) },
    });
    expect(restoreRequest('skills', [{ id: 'langs' }])).toEqual({
      path: '/skills?commit=0',
      options: { method: 'PUT', body: JSON.stringify([{ id: 'langs' }]) },
    });
  });

  it('turns a null snapshot into a DELETE, which undoes a creation', () => {
    expect(restoreRequest('entry:edu_neu', null)).toEqual({ path: '/entries/edu_neu', options: { method: 'DELETE' } });
    expect(restoreRequest('resume:base', undefined)).toEqual({ path: '/resumes/base', options: { method: 'DELETE' } });
    expect(restoreRequest('answer:a1', null)).toEqual({ path: '/answers/a1', options: { method: 'DELETE' } });
  });

  it('encodes ids back into the path', () => {
    expect(restoreRequest('entry:job acme/2024', null).path).toBe(`/entries/${encodeURIComponent('job acme/2024')}`);
    expect(docKeyFor(restoreRequest('entry:job acme/2024', null).path, 'DELETE')).toBe('entry:job acme/2024');
  });

  it('refuses to "delete" the singletons and rejects keys that are not documents', () => {
    expect(() => restoreRequest('profile', null)).toThrow(/cannot be deleted/);
    expect(() => restoreRequest('skills', null)).toThrow(/cannot be deleted/);
    expect(() => restoreRequest('nonsense', { a: 1 })).toThrow(/not a document key/);
    expect(() => restoreRequest('entry:', { a: 1 })).toThrow(/not a document key/);
  });
});

describe('createHistory', () => {
  const edit = (n, over = {}) => ({ docKey: `entry:e${n}`, before: { id: `e${n}`, v: 0 }, after: { id: `e${n}`, v: n }, label: `edit ${n}`, ...over });

  it('starts empty', () => {
    const history = createHistory({});
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
    expect(history.peekUndoLabel()).toBeNull();
    expect(history.peekRedoLabel()).toBeNull();
    expect(history.size()).toEqual({ undo: 0, redo: 0 });
  });

  it('records, undoes and redoes in order', () => {
    const history = createHistory({});
    expect(history.record(edit(1))).toBe(true);
    history.record(edit(2));
    expect(history.canUndo()).toBe(true);
    expect(history.peekUndoLabel()).toBe('edit 2');

    const undone = history.undo();
    expect(undone.label).toBe('edit 2');
    expect(undone.docKey).toBe('entry:e2');
    expect(undone.before).toEqual({ id: 'e2', v: 0 });
    expect(undone.after).toEqual({ id: 'e2', v: 2 });
    expect(history.peekUndoLabel()).toBe('edit 1');
    expect(history.peekRedoLabel()).toBe('edit 2');
    expect(history.canRedo()).toBe(true);

    expect(history.undo().label).toBe('edit 1');
    expect(history.canUndo()).toBe(false);
    expect(history.undo()).toBeNull();

    expect(history.redo().label).toBe('edit 1');
    expect(history.redo().label).toBe('edit 2');
    expect(history.canRedo()).toBe(false);
    expect(history.redo()).toBeNull();
    expect(history.size()).toEqual({ undo: 2, redo: 0 });
  });

  it('ignores a save that changed nothing', () => {
    const history = createHistory({});
    const same = { id: 'e1', bullets: [{ id: 'b1', phrasings: ['One'] }] };
    expect(history.record({ docKey: 'entry:e1', before: same, after: deepClone(same), label: 'no-op' })).toBe(false);
    expect(history.canUndo()).toBe(false);

    // Key order and `undefined` properties do not make a change either.
    expect(history.record({ docKey: 'entry:e1', before: { a: 1, b: 2 }, after: { b: 2, a: 1, c: undefined }, label: 'no-op' })).toBe(false);
    // Nor does a null-to-null "edit" of a document that never existed.
    expect(history.record({ docKey: 'entry:e1', before: null, after: null, label: 'no-op' })).toBe(false);
    expect(history.size()).toEqual({ undo: 0, redo: 0 });

    // A real change is still recorded.
    expect(history.record({ docKey: 'entry:e1', before: same, after: { ...same, extra: true }, label: 'real' })).toBe(true);
    expect(history.peekUndoLabel()).toBe('real');
  });

  it('ignores requests that touch no document', () => {
    const history = createHistory({});
    expect(history.record({ docKey: docKeyFor('/store', 'GET'), before: null, after: { a: 1 } })).toBe(false);
    expect(history.record({})).toBe(false);
    expect(history.canUndo()).toBe(false);
  });

  it('drops the redo stack as soon as a fresh edit lands', () => {
    const history = createHistory({});
    history.record(edit(1));
    history.record(edit(2));
    history.undo();
    expect(history.canRedo()).toBe(true);

    history.record(edit(3));
    expect(history.canRedo()).toBe(false);
    expect(history.redo()).toBeNull();
    expect(history.peekRedoLabel()).toBeNull();
    expect(history.peekUndoLabel()).toBe('edit 3');
    expect(history.size()).toEqual({ undo: 2, redo: 0 });
  });

  it('is bounded and drops the oldest entry first', () => {
    const history = createHistory({ limit: 3 });
    for (let n = 1; n <= 5; n += 1) history.record(edit(n));
    expect(history.size().undo).toBe(3);
    expect(history.undo().label).toBe('edit 5');
    expect(history.undo().label).toBe('edit 4');
    expect(history.undo().label).toBe('edit 3');
    expect(history.undo()).toBeNull(); // edits 1 and 2 fell off the bottom
  });

  it('defaults to 50 entries', () => {
    const history = createHistory();
    for (let n = 1; n <= 60; n += 1) history.record(edit(n));
    expect(history.limit).toBe(50);
    expect(history.size().undo).toBe(50);
    expect(history.peekUndoLabel()).toBe('edit 60');
  });

  it('keeps deep clones, so the store moving on cannot corrupt an entry', () => {
    const store = makeStore();
    const history = createHistory({});
    const before = readDoc(store, 'entry:edu_neu');
    const after = deepClone(before);
    after.org = 'MIT';
    history.record({ docKey: 'entry:edu_neu', before, after, label: 'rename org' });

    // Mutate everything the caller still holds a reference to.
    before.org = 'tampered';
    before.bullets[0].phrasings.push('Two');
    after.org = 'also tampered';
    store.entries[0].bullets[0].phrasings.length = 0;

    const entry = history.undo();
    expect(entry.before.org).toBe('Northeastern');
    expect(entry.before.bullets[0].phrasings).toEqual(['One']);
    expect(entry.after.org).toBe('MIT');

    // And the entry handed out is itself a copy: scribbling on it is harmless.
    entry.before.org = 'scribbled';
    expect(history.redo().before.org).toBe('Northeastern');
  });

  it('clears both stacks when the open save changes', () => {
    const history = createHistory({});
    history.record(edit(1));
    history.record(edit(2));
    history.undo();
    history.clear();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.peekUndoLabel()).toBeNull();
    expect(history.peekRedoLabel()).toBeNull();
    expect(history.size()).toEqual({ undo: 0, redo: 0 });
  });

  it('round-trips a real deletion: undo recreates, redo deletes again', () => {
    const store = makeStore();
    const history = createHistory({});
    const docKey = docKeyFor('/skills', 'PUT');
    const before = readDoc(store, docKey);

    store.skillGroups = []; // the user deleted the only group
    history.record({ docKey, before, after: readDoc(store, docKey), label: 'delete group' });
    expect(history.peekUndoLabel()).toBe('delete group');

    const undone = history.undo();
    expect(restoreRequest(undone.docKey, undone.before)).toEqual({
      path: '/skills?commit=0',
      options: { method: 'PUT', body: JSON.stringify([{ id: 'langs', label: 'Languages', items: ['TypeScript'] }]) },
    });

    const redone = history.redo();
    expect(restoreRequest(redone.docKey, redone.after)).toEqual({
      path: '/skills?commit=0',
      options: { method: 'PUT', body: JSON.stringify([]) },
    });
  });

  it('round-trips a creation: undo deletes the new document', () => {
    const store = makeStore();
    const history = createHistory({});
    const docKey = docKeyFor('/entries/new_job?commit=0', 'PUT');
    const before = readDoc(store, docKey);
    expect(before).toBeNull();

    store.entries.push({ id: 'new_job', kind: 'experience', org: 'New' });
    history.record({ docKey, before, after: readDoc(store, docKey), label: 'add entry' });

    const undone = history.undo();
    expect(restoreRequest(undone.docKey, undone.before)).toEqual({
      path: '/entries/new_job',
      options: { method: 'DELETE' },
    });
    const redone = history.redo();
    expect(restoreRequest(redone.docKey, redone.after).options.method).toBe('PUT');
  });
});

describe('deepEqual', () => {
  it('compares JSON-shaped documents structurally', () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({ a: [1, { b: 'c' }] }, { a: [1, { b: 'c' }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 'c' }] }, { a: [1, { b: 'd' }] })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: undefined }, {})).toBe(true);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(deepEqual('x', 'x')).toBe(true);
    expect(deepEqual(0, '0')).toBe(false);
  });
});
