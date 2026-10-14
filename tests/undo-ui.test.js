// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { entryLosesIds, findMovedWordings, forgetMissing, indexStore, skillsLoseIds } from '../src/model/forget.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }),
}));

afterEach(() => {
  refuseAutoSaves = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * Undo, as the person pressing Ctrl+Z understands it.
 *
 * The mechanism was sound — snapshot the document either side of the write —
 * and the three things wrong with it were all about what counts as one step and
 * where the key applies.
 */
/** Set by a block that needs the save arranged before the editor opens it. */
let arrange = () => {};
/** A promise the next resume write waits on before it lands, when set. */
let holdNextResumeWrite = null;
/** While set, the resume's auto-saves are refused, as a full disk refuses them. */
let refuseAutoSaves = false;

describe('undo in the builder', () => {
  let data;
  let requests;

  /*
   * What the store does to every resume when something they point at is
   * deleted — `forgetInResumes`, with the store's own functions — so a step
   * that leaves those resumes out is seen to.
   */
  const cascade = (wasEntries, wasGroups) => {
    const after = indexStore(data.entries, data.skillGroups ?? []);
    const moved = findMovedWordings(indexStore(wasEntries, wasGroups ?? []), after);
    data.resumes = data.resumes.map((r) => forgetMissing(r, after, moved));
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();
    arrange(data);
    requests = [];

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      const method = options.method ?? 'GET';
      requests.push({ url, method, body });
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url.endsWith('/tier') && method === 'PUT') {
        const id = decodeURIComponent(url.split('?')[0].split('/').slice(-2)[0]);
        data.resumes = data.resumes.map((r) =>
          r.id === id ? { ...r, tier: body.tier, ...(body.tier === 'temporary' ? {} : { temporaryFrom: undefined }) } : r,
        );
        result = { ok: true };
      } else if (url.endsWith('/rename') && method === 'POST') {
        const id = decodeURIComponent(url.split('?')[0].split('/').slice(-2)[0]);
        data.resumes = data.resumes.map((r) => (r.id === id ? { ...r, label: body.label } : r));
        result = data.resumes.find((r) => r.id === id);
      } else if (url.startsWith('/api/resumes/') && method === 'PUT' && refuseAutoSaves && /[?&]existing=1/.test(url)) {
        return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({ error: 'disk full' }) };
      } else if (url.startsWith('/api/resumes/') && method === 'PUT') {
        if (holdNextResumeWrite) {
          const gate = holdNextResumeWrite;
          holdNextResumeWrite = null;
          await gate;
        }
        const id = decodeURIComponent(url.split('?')[0].split('/').pop());
        data.resumes = data.resumes.some((r) => r.id === id)
          ? data.resumes.map((r) => (r.id === id ? { ...body, id } : r))
          : [...data.resumes, { ...body, id }];
        result = data.resumes.find((r) => r.id === id);
      } else if (url.startsWith('/api/resumes/') && method === 'DELETE') {
        const id = decodeURIComponent(url.split('?')[0].split('/').pop());
        data.resumes = data.resumes.filter((r) => r.id !== id);
        result = { ok: true };
      } else if (url.startsWith('/api/entries/') && method === 'PUT') {
        const was = data.entries;
        const old = was.find((e) => e.id === body.id);
        data.entries = old ? was.map((e) => (e.id === body.id ? body : e)) : [...was, body];
        // A line or a wording gone reaches the resumes. See `saveEntry`.
        if (old && entryLosesIds(old, body)) cascade(was, data.skillGroups);
        result = body;
      } else if (url.split('?')[0] === '/api/skills' && method === 'PUT') {
        const was = data.skillGroups ?? [];
        data.skillGroups = body;
        // And a group or a skill. See `saveSkillGroups`.
        if (skillsLoseIds(was, body)) cascade(data.entries, was);
        result = body;
      } else if (url.startsWith('/api/entries/') && method === 'DELETE') {
        const id = decodeURIComponent(url.split('?')[0].split('/').pop());
        const was = data.entries;
        data.entries = was.filter((e) => e.id !== id);
        // And an entry, out of every resume that listed it. See `deleteEntry`.
        cascade(was, data.skillGroups);
        result = { ok: true };
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    const selector = document.querySelector('#resume-select');
    selector.value = 'newgrad';
    selector.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('#editor .toggle')).not.toBeNull());
  });

  const undoBtn = () => document.querySelector('#btn-undo');
  const spec = (id) => data.resumes.find((r) => r.id === id);
  const written = (id) =>
    requests.filter((r) => r.method === 'PUT' && r.url.includes(`/resumes/${id}`)).map((r) => r.body);

  /*
   * The one that made undo look broken.
   *
   * A resume is a thin overlay and the editor holds the unsaved part of it in
   * `state.choices` and friends. Undoing put the old spec back on disk and left
   * that overlay alone — so the next render re-applied exactly what had been
   * undone and the next auto-save wrote it out again. Ctrl+Z did nothing, over
   * and over.
   */
  it('takes back a selection instead of writing it out again', async () => {
    const boxes = [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);
    const box = boxes[0];
    expect(box, 'a selection to change').toBeTruthy();
    box.click();

    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(written('newgrad').length).toBeGreaterThan(0));
    const afterEdit = structuredClone(spec('newgrad'));

    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));
    undoBtn().click();

    // The store goes back…
    await vi.waitFor(() => expect(spec('newgrad')).not.toEqual(afterEdit));
    const restored = structuredClone(spec('newgrad'));

    // …and stays back. The overlay that used to re-apply the change is gone,
    // so nothing writes it out again a moment later.
    await vi.advanceTimersByTimeAsync(5000);
    expect(spec('newgrad')).toEqual(restored);
  });

  /*
   * Two presses of Undo, the second while the first was still writing.
   *
   * Each press started a step straight away. The second took its entry off
   * the stack while the first's write was out, and the first, finishing,
   * marked undoing as over — so the second's write was recorded as a fresh
   * edit, which empties the redo stack. Two undos, and nothing to redo.
   */
  it('takes back two steps for two quick presses, and can redo both', async () => {
    const boxes = () => [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);
    const original = structuredClone(spec('newgrad'));

    boxes()[0].click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));
    boxes()[1].click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(written('newgrad').length).toBeGreaterThan(1));
    const edited = structuredClone(spec('newgrad'));

    let release;
    holdNextResumeWrite = new Promise((go) => (release = go));
    undoBtn().click();
    await vi.advanceTimersByTimeAsync(50);
    undoBtn().click();
    await vi.advanceTimersByTimeAsync(500);
    release();
    await vi.advanceTimersByTimeAsync(3000);

    expect(spec('newgrad'), 'both steps taken back').toEqual(original);
    const redoBtn = document.querySelector('#btn-redo');
    expect(redoBtn.disabled, 'the redo stack survived').toBe(false);
    redoBtn.click();
    await vi.advanceTimersByTimeAsync(3000);
    redoBtn.click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(spec('newgrad'), 'both steps put back').toEqual(edited);
  });

  /*
   * Ctrl+Z inside the nine hundred milliseconds before a change has saved.
   *
   * `undoGroup` flushes the pending auto-save before it does anything, and
   * says why: the debounce makes a write arrive at an arbitrary moment and
   * nothing should happen across one. `stepHistory` did not. So the undo
   * replayed an *older* step and then called `clearEdits`, which drops every
   * overlay and sets `state.dirty` false — taking the change made a moment
   * ago with it, unsaved and unrecorded. The timer then fired into
   * `autoSave`'s `if (!state.dirty) return`, so no request went out, no error
   * was shown, and the save chip was left reading "Unsaved changes" for ever
   * about something that no longer existed.
   *
   * The guard against undoing mid-typing does not help: it looks at
   * `document.activeElement`, and a tick box calls `render()`, which rebuilds
   * the whole editor and moves focus to the body. So the key goes straight
   * through, from the very actions most likely to be followed by one.
   */
  it('saves what was just changed before undoing something older', async () => {
    // The key only means anything on this tab, and this harness does not
    // start on it. See "does nothing on a tab that has no history of its own".
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="resumes"]').click();
    await vi.advanceTimersByTimeAsync(100);

    const boxes = () => [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);

    // One change, saved and on the stack.
    boxes()[0].click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));
    const first = structuredClone(spec('newgrad'));

    // A second change, and the undo lands inside its debounce.
    boxes()[1].click();
    await vi.advanceTimersByTimeAsync(100);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(5000);

    /*
     * The second change is what one press of Ctrl+Z takes back, because it is
     * the last thing that happened. What must not happen is it being dropped
     * on the floor while an older step is replayed underneath it.
     */
    expect(spec('newgrad'), 'the undo took back the change that was still saving')
      .toEqual(first);
    expect(document.querySelector('#save-state')?.textContent ?? '')
      .not.toMatch(/unsaved/i);
  });

  /*
   * The same press, when the change it flushes is refused.
   *
   * `flushAutoSave` does not throw, so a save the server turned away left the
   * edit held here, still dirty — and the undo carried on: it replayed the
   * older step, and `clearEdits` threw the unsaved change away under "Undid
   * change". Neither on disk nor on screen any more, and the step that was
   * taken back was not the one the person meant.
   */
  it('undoes nothing while the change it flushed has not saved', async () => {
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="resumes"]').click();
    await vi.advanceTimersByTimeAsync(100);

    const boxes = () => [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);

    boxes()[0].click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));
    const first = structuredClone(spec('newgrad'));

    // A second change, whose save the server refuses, and Ctrl+Z inside its debounce.
    refuseAutoSaves = true;
    const second = boxes()[1];
    const wasChecked = second.checked;
    second.click();
    const label = second.closest('label')?.textContent ?? '';
    await vi.advanceTimersByTimeAsync(100);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(spec('newgrad'), 'the older step was not replayed').toEqual(first);
    expect(document.querySelector('#status')?.textContent ?? '').toMatch(/not saved yet/i);
    const still = boxes().find((b) => (b.closest('label')?.textContent ?? '') === label) ?? boxes()[1];
    expect(still.checked, 'the unsaved change is still on screen').toBe(!wasChecked);

    // Once the server takes it, the next press saves it first, as its own
    // step, and then takes that back: the change was kept, not lost.
    refuseAutoSaves = false;
    const sent = written('newgrad').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(3000);
    const after = written('newgrad').slice(sent).map((w) => JSON.stringify(w));
    expect(after.some((w) => w !== JSON.stringify(first)), 'the change reached the server').toBe(true);
    expect(spec('newgrad'), 'and was what the press took back').toEqual(first);
  });

  /*
   * Ctrl+Z belongs to the resume builder. It used to fire from any tab, so
   * pressing it while reading the Applications list silently rolled back an
   * edit made somewhere the user was not looking.
   */
  it('does nothing on a tab that has no history of its own', async () => {
    const boxes = [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);
    boxes[0].click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));
    const afterEdit = structuredClone(spec('newgrad'));

    // Somewhere else entirely.
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="applications"]').click();
    await vi.advanceTimersByTimeAsync(100);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(500);
    expect(spec('newgrad'), 'the resume was not rolled back from another tab').toEqual(afterEdit);

    // Back where it means something, it works.
    document.querySelector('button[data-tab="resumes"]').click();
    await vi.advanceTimersByTimeAsync(100);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => expect(spec('newgrad')).not.toEqual(afterEdit));
  });

  /*
   * The chip that decides whether the sweep may delete this resume.
   *
   * `PUT /resumes/:id/tier` is a partial write, so `docKeyFor` recorded no
   * step for it — while every step already on the stack still carried the old
   * tier, and undo replays a whole resume. So: promote a temporary resume to
   * Kept so the sweep can no longer take it, then press Ctrl+Z meaning "take
   * back that checkbox", and the resume is back on the sweep clock with its
   * original start date. Nothing says so, and the button three places to the
   * left of Undo is the one that moved.
   */
  it('does not put a resume back on the sweep clock when you undo something else', async () => {
    const before = spec('newgrad');
    before.tier = 'temporary';
    before.temporaryFrom = '2026-01-01T00:00:00.000Z';

    // An ordinary edit, saved, so there is a step on the stack to undo.
    const boxes = [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);
    boxes[0].click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));

    // Then the chip: "keep this one, do not sweep it".
    const chip = document.querySelector('#btn-base');
    expect(chip, 'the tier chip').toBeTruthy();
    chip.click();
    await vi.waitFor(() => expect(spec('newgrad').tier).toBe('extended'));

    // And now the undo the user actually means: the checkbox, not the chip.
    undoBtn().click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(spec('newgrad').tier, 'the resume is still kept').toBe('extended');
    expect(spec('newgrad').temporaryFrom, 'and has no sweep clock').toBeUndefined();
  });

  /*
   * Rename is the tier chip's problem again, one button along.
   *
   * `POST /resumes/:id/rename` is action-shaped, so `docKeyFor` records no
   * step for it — while every step already on the stack holds the resume
   * under its old name, and undo puts a whole resume back. Tick a box, rename
   * the resume, press Ctrl+Z meaning the box: the name went back too, with
   * the status line saying only "Undid change".
   */
  it('keeps a new name when you undo something done before the rename', async () => {
    const boxes = [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);
    boxes[0].click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));
    const ticked = structuredClone(spec('newgrad'));

    document.querySelector('#btn-rename-resume').click();
    await vi.advanceTimersByTimeAsync(50);
    document.querySelector('#modal-content [name="label"]').value = 'Renamed resume';
    document.querySelector('#modal-ok').click();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(spec('newgrad').label).toBe('Renamed resume'));

    // The step the user means is the rename, the last thing they did.
    undoBtn().click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(spec('newgrad').label, 'one press takes back the rename').toBe(ticked.label);
    expect(spec('newgrad').sections, 'and only the rename').toEqual(ticked.sections);

    // And a second press takes back the box, under the name it now has.
    undoBtn().click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(spec('newgrad').sections).not.toEqual(ticked.sections);
  });

  /*
   * Adding an entry writes the entry and the section that lists it. Recorded
   * per request that is two presses, and the state in between is one no
   * action ever produced — the entry is in the save with nothing pointing at
   * it, which looks on screen exactly like the undo having worked.
   */
  it('takes an added entry back in one press, reference and all', async () => {
    const add = [...document.querySelectorAll('#editor button, #editor .link')].find((b) =>
      /add entry/i.test(b.textContent ?? ''),
    );
    expect(add, 'the "+ Add Entry" control').toBeTruthy();
    add.click();
    await vi.advanceTimersByTimeAsync(50);

    const title = document.querySelector('#modal-content [name="title"]');
    expect(title, 'the new-entry form').toBeTruthy();
    title.value = 'Globex';
    document.querySelector('#modal-ok').click();
    await vi.advanceTimersByTimeAsync(3000);

    const added = data.entries.find((e) => e.title === 'Globex');
    expect(added, 'the entry was added').toBeTruthy();
    expect(spec('newgrad').sections.some((s) => (s.entries ?? []).includes(added.id))).toBe(true);

    undoBtn().click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(data.entries.some((e) => e.id === added.id), 'the entry is gone').toBe(false);
    expect(
      spec('newgrad').sections.some((s) => (s.entries ?? []).includes(added.id)),
      'and nothing still points at it',
    ).toBe(false);
  });

  /*
   * Redo stays armed through the auto-save debounce, and undoing drops the
   * unsaved overlay — so pressing it destroys the edit you have just made.
   *
   * `history.record` clears the redo stack, and that runs when the *write*
   * comes back: 900ms of debounce plus a round trip after the keystroke. In
   * that window Redo is enabled and there is no step recorded for the thing
   * it would overwrite, so the new edit goes with no message and no way back.
   */
  it('disarms redo the moment a new edit is made, not when it saves', async () => {
    const boxes = [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);
    boxes[0].click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));

    undoBtn().click();
    await vi.advanceTimersByTimeAsync(2000);
    const redoBtn = () => document.querySelector('#btn-redo');
    expect(redoBtn().disabled, 'redo is armed after an undo').toBe(false);

    /*
     * A fresh edit, and deliberately one that goes through the debounced
     * resume auto-save rather than a write of its own: the window this is
     * about is the 900ms plus a round trip between the keystroke and the
     * save, and an edit that writes immediately closes it by accident.
     * Re-queried because the undo re-rendered the editor.
     */
    const wrote = () => requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/api/resumes/')).length;
    const before = wrote();
    const fresh = [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);
    fresh[0].click();
    await vi.advanceTimersByTimeAsync(50);
    expect(wrote(), 'the edit has not been saved yet — this is the window').toBe(before);
    expect(redoBtn().disabled, 'and disarmed the moment the next edit is made').toBe(true);

    // And the press does nothing rather than taking the edit with it.
    await vi.advanceTimersByTimeAsync(3000);
    const settled = structuredClone(spec('newgrad'));
    redoBtn().click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(spec('newgrad').sections).toEqual(settled.sections);
  });

  /*
   * Ctrl+Z was already refused on the other tabs, because "it silently rolled
   * back an edit made somewhere the user was not looking" is the whole
   * problem. Two resumes inside the Build tab is the same problem: the stack
   * is per-save and `stepHistory` never checked which resume a step belonged
   * to, so editing one, switching to another and pressing Ctrl+Z rolled back
   * the first behind your back, with the screen unchanged and the status line
   * saying only "Undid change".
   */
  it('goes to the resume it rolled back, rather than moving it out of sight', async () => {
    const boxes = [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);
    boxes[0].click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));
    const afterEdit = structuredClone(spec('newgrad'));

    // Somewhere else in the same tab.
    const selector = document.querySelector('#resume-select');
    selector.value = 'intern';
    selector.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(2000);

    undoBtn().click();
    await vi.advanceTimersByTimeAsync(3000);

    // The roll-back happened, and it is on screen rather than behind you.
    expect(spec('newgrad')).not.toEqual(afterEdit);
    expect(selector.value, 'the editor followed the change').toBe('newgrad');
    expect(document.querySelector('#status').textContent).toMatch(/new grad/i);
  });

  /*
   * Undoing a "Save as variation" takes away the resume on screen, and the
   * editor went wherever a save with no resume open goes — its first base —
   * rather than back to the one the copy was made from, which is where the
   * person was when they made it. The next edit then landed on a resume they
   * had not been looking at.
   */
  it('goes back to the resume a copy was made from when the copy is undone', async () => {
    // Not the one a save with nothing open falls back to, or this proves nothing.
    const selector = document.querySelector('#resume-select');
    selector.value = 'intern';
    selector.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(2000);

    document.querySelector('#btn-save-as').click();
    await vi.advanceTimersByTimeAsync(50);
    document.querySelector('#modal-content [name="label"]').value = 'A copy to take back';
    document.querySelector('#modal-ok').click();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(selector.value).toBe('intern-variant'));

    undoBtn().click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(spec('intern-variant'), 'the copy is gone').toBeUndefined();
    expect(selector.value, 'and the editor is back on the one it was copied from').toBe('intern');
  });

  /*
   * And it is taken away only as the step left it. The DELETE went out
   * whatever had happened to the copy since — edited in another tab, sent
   * with an application — and all of that went with it.
   */
  const copyThenUndo = async (meanwhile) => {
    const selector = document.querySelector('#resume-select');
    selector.value = 'intern';
    selector.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(2000);
    document.querySelector('#btn-save-as').click();
    await vi.advanceTimersByTimeAsync(50);
    document.querySelector('#modal-content [name="label"]').value = 'A copy that moved on';
    document.querySelector('#modal-ok').click();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(selector.value).toBe('intern-variant'));
    meanwhile();
    undoBtn().click();
    await vi.advanceTimersByTimeAsync(3000);
  };
  const deletesOf = (id) => requests.filter((r) => r.method === 'DELETE' && r.url.includes(`/resumes/${id}`));

  it('does not take away a copy changed elsewhere since it was made', async () => {
    await copyThenUndo(() => {
      data.resumes = data.resumes.map((r) => (r.id === 'intern-variant' ? { ...r, notes: 'Written in another tab.' } : r));
    });
    expect(deletesOf('intern-variant')).toEqual([]);
    expect(spec('intern-variant')?.notes).toBe('Written in another tab.');
    expect(document.querySelector('#status').textContent).toMatch(/Nothing was undone.*changed since it was made/);
    expect(undoBtn().disabled, 'the step is still there').toBe(false);
  });

  it('does not take away a copy an application went out with since', async () => {
    await copyThenUndo(() => {
      data.applications = [
        ...(data.applications ?? []),
        { id: 'acme-1', company: 'Acme', role: 'Engineer', status: 'applied', resumeId: 'intern-variant', history: [] },
      ];
    });
    expect(deletesOf('intern-variant')).toEqual([]);
    expect(spec('intern-variant')).toBeDefined();
    expect(document.querySelector('#status').textContent).toMatch(/filed with an application/);
    // And it is off the stack: it can never be taken back now, and on top it hid every step under it.
    expect(document.querySelector('#status').textContent).toMatch(/off the undo list/);
    expect(undoBtn().title).not.toMatch(/as a variation/);
  });

  it('names the step by the copy’s name, and offers a name and file nobody has', async () => {
    const selector = document.querySelector('#resume-select');
    const saveAsOffered = async () => {
      selector.value = 'intern';
      selector.dispatchEvent(new Event('change'));
      await vi.advanceTimersByTimeAsync(2000);
      document.querySelector('#btn-save-as').click();
      await vi.advanceTimersByTimeAsync(50);
    };
    // The first copy takes what is offered…
    await saveAsOffered();
    document.querySelector('#modal-ok').click();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(spec('intern-variant')).toBeDefined());
    // …and the second is offered the next free one, not the same refused again.
    await saveAsOffered();
    await vi.advanceTimersByTimeAsync(50);
    const offered = {
      label: document.querySelector('#modal-content [name="label"]').value,
      id: document.querySelector('#modal-content [name="id"]').value,
    };
    expect(offered.id).toBe('intern-variant-2');
    expect(offered.label).toMatch(/variation 2$/);
    document.querySelector('#modal-ok').click();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(spec('intern-variant-2')).toBeDefined());
    expect(undoBtn().title).toMatch(new RegExp(`${offered.label}.*as a variation`));
    expect(undoBtn().title).not.toMatch(/intern-variant-2/);
  });

  // As the server counts them (`wentOut`): a row at Interested has sent nothing, and the server lets the copy go.
  it('takes away a copy only an application not yet sent names', async () => {
    await copyThenUndo(() => {
      data.applications = [
        ...(data.applications ?? []),
        { id: 'acme-2', company: 'Acme', role: 'Engineer', status: 'interested', resumeId: 'intern-variant', history: [] },
      ];
    });
    expect(deletesOf('intern-variant')).toHaveLength(1);
    expect(spec('intern-variant')).toBeUndefined();
  });

  /*
   * Redoing a delete is a delete already confirmed. It was refused for the
   * application the resume went out with, and when it was not, it went
   * without the `force` the server asks for that.
   */
  it('redoes the delete of a resume an application went out with, with force', async () => {
    const selector = document.querySelector('#resume-select');
    selector.value = 'intern';
    selector.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(2000);
    data.applications = [
      ...(data.applications ?? []),
      { id: 'acme-3', company: 'Acme', role: 'Engineer', status: 'applied', resumeId: 'intern', history: [] },
    ];
    document.querySelector('#btn-delete-resume').click();
    await vi.advanceTimersByTimeAsync(50);
    document.querySelector('#modal-ok').click();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(spec('intern')).toBeUndefined());

    undoBtn().click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(spec('intern')).toBeDefined());

    document.querySelector('#btn-redo').click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(spec('intern'), document.querySelector('#status').textContent).toBeUndefined();
    expect(deletesOf('intern').at(-1)?.url).toMatch(/[?&]force=1\b/);
  });

  /*
   * Deleting a skill group is the same two writes, and the half-way state is
   * worse than an orphan: one press put the *reference* back without the
   * group, so `resolveResume` warned "Skills group … does not exist" on every
   * compile from then on.
   */
  it('takes a deleted skill group back in one press, without leaving a dangling reference', async () => {
    const group = data.skillGroups[0];
    expect(group, 'a skill group to delete').toBeTruthy();
    // Make sure this resume lists it, so there is a reference to dangle.
    const listed = spec('newgrad').sections.find((s) => s.kind === 'skills');
    expect(listed?.groups, 'the resume lists it').toContain(group.id);

    const del = [...document.querySelectorAll('#editor button, #editor .link')].find((b) =>
      /delete group/i.test(b.textContent ?? ''),
    );
    expect(del, 'the "Delete group" control').toBeTruthy();
    del.click();
    await vi.advanceTimersByTimeAsync(50);
    document.querySelector('#modal-ok').click();
    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(() => expect(data.skillGroups.some((g) => g.id === group.id)).toBe(false));

    undoBtn().click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(data.skillGroups.some((g) => g.id === group.id), 'the group is back').toBe(true);
    expect(
      spec('newgrad').sections.find((s) => s.kind === 'skills')?.groups,
      'and the resume lists it again',
    ).toContain(group.id);
  });

  /*
   * A delete reaches every resume, and so does its undo.
   *
   * The store takes a deleted entry or skills group out of every resume that
   * listed it (`forgetInResumes`), in the same write. The step recorded only
   * the document deleted and the resume open, so Ctrl+Z put those two back
   * and left every other resume without the entry — changed by the delete,
   * silently, and not by its undo.
   */
  it('puts a deleted entry back in the other resumes that listed it, too', async () => {
    const entry = data.entries.find((e) => e.id === 'exp_acme');
    const listing = (id) => spec(id).sections.some((s) => (s.entries ?? []).includes(entry.id));
    expect(listing('newgrad') && listing('intern') && listing('base'), 'three resumes list it').toBe(true);
    const others = { intern: structuredClone(spec('intern')), base: structuredClone(spec('base')) };

    const row = [...document.querySelectorAll('#editor .entry')].find((e) => e.textContent.includes(entry.title));
    const del = [...(row ?? document).querySelectorAll('button')].find((b) => b.textContent === 'Delete');
    expect(del, 'the entry\'s Delete').toBeTruthy();
    del.click();
    await vi.advanceTimersByTimeAsync(50);
    document.querySelector('#modal-ok').click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(data.entries.some((e) => e.id === entry.id)).toBe(false));
    expect(listing('intern') || listing('base'), 'the delete reached the other resumes').toBe(false);

    undoBtn().click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(data.entries.some((e) => e.id === entry.id), 'the entry is back').toBe(true);
    expect(listing('newgrad'), 'in the open resume').toBe(true);
    expect(spec('intern'), 'and the other resumes are as they were').toEqual(others.intern);
    expect(spec('base')).toEqual(others.base);

    // And redo takes it out of all of them again.
    document.querySelector('#btn-redo').click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(data.entries.some((e) => e.id === entry.id)).toBe(false);
    expect(listing('newgrad') || listing('intern') || listing('base')).toBe(false);
  });

  it('puts a deleted skills group back in the other resumes that listed it, too', async () => {
    const group = data.skillGroups[0];
    const listing = (id) => (spec(id).sections.find((s) => s.kind === 'skills')?.groups ?? []).includes(group.id);
    expect(listing('newgrad') && listing('intern') && listing('base'), 'three resumes list it').toBe(true);
    const others = { intern: structuredClone(spec('intern')), base: structuredClone(spec('base')) };

    const del = [...document.querySelectorAll('#editor button, #editor .link')].find((b) =>
      /delete group/i.test(b.textContent ?? ''),
    );
    del.click();
    await vi.advanceTimersByTimeAsync(50);
    document.querySelector('#modal-ok').click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(data.skillGroups.some((g) => g.id === group.id)).toBe(false));
    expect(listing('intern') || listing('base'), 'the delete reached the other resumes').toBe(false);

    undoBtn().click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(data.skillGroups.some((g) => g.id === group.id), 'the group is back').toBe(true);
    expect(listing('newgrad'), 'in the open resume').toBe(true);
    expect(spec('intern'), 'and the other resumes are as they were').toEqual(others.intern);
    expect(spec('base')).toEqual(others.base);
  });

  /*
   * And the smaller deletes, which reach the resumes the same way: a line a
   * resume chose, a wording a resume pinned — which the store moves to the
   * nearest wording left — and a skill a resume chose. Each was one write
   * recorded as one document, so Ctrl+Z put the line, the wording or the
   * skill back and left every resume that had it without it, or on another
   * wording.
   */
  describe('the smaller deletes the store carries into other resumes', () => {
    beforeAll(() => {
      arrange = (d) => {
        d.skillGroups = d.skillGroups.map((g) => (g.id === 'sk_lang' ? { ...g, items: [...g.items, { id: 's_zig', text: 'Zig' }] } : g));
        // Every resume on the short wording, so the one open can delete it.
        for (const r of d.resumes) r.choices = { ...r.choices, b_pipeline: 'v_short' };
        const intern = d.resumes.find((r) => r.id === 'intern');
        intern.sections = intern.sections.map((sec) =>
          sec.kind === 'experience'
            ? { ...sec, bullets: { exp_acme: ['b_pipeline', 'b_testing'] } }
            : sec.kind === 'skills'
              ? { ...sec, items: { sk_lang: d.skillGroups[0].items.map((i) => i.id) } }
              : sec,
        );
      };
    });
    afterAll(() => {
      arrange = () => {};
    });

    const confirmAndSettle = async () => {
      await vi.advanceTimersByTimeAsync(50);
      document.querySelector('#modal-ok')?.click();
      await vi.advanceTimersByTimeAsync(3000);
    };
    const undoAndSettle = async () => {
      await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));
      undoBtn().click();
      await vi.advanceTimersByTimeAsync(3000);
    };
    const control = (pattern, scope = document.querySelector('#editor')) =>
      [...scope.querySelectorAll('button, .link, [title]')].find((b) => pattern.test(`${b.textContent} ${b.title ?? ''}`));

    it('a line', async () => {
      const intern = structuredClone(spec('intern'));
      const row = [...document.querySelectorAll('#editor .bullet-row, #editor .bullet')].find((r) => /coverage/i.test(r.textContent));
      const remove = row && [...row.querySelectorAll('button')].find((b) => /^(remove|delete)/i.test(b.textContent.trim()));
      expect(remove, 'the line\'s Remove').toBeTruthy();
      remove.click();
      await confirmAndSettle();
      await vi.waitFor(() => expect(spec('intern').sections.find((x) => x.kind === 'experience').bullets.exp_acme).toEqual(['b_pipeline']));

      await undoAndSettle();
      expect(data.entries.find((e) => e.id === 'exp_acme').bullets.some((b) => b.id === 'b_testing'), 'the line is back').toBe(true);
      expect(spec('intern'), 'and the resume that chose it has it again').toEqual(intern);
    });

    it('a wording', async () => {
      const others = { intern: structuredClone(spec('intern')), base: structuredClone(spec('base')) };
      const row = [...document.querySelectorAll('#editor .bullet-row, #editor .bullet')].find((r) => /Built a pipeline/.test(r.textContent));
      const del = row && control(/^Delete phrasing/, row);
      expect(del, 'the wording\'s Delete phrasing').toBeTruthy();
      del.click();
      await confirmAndSettle();
      const hasShort = () => data.entries.find((e) => e.id === 'exp_acme').bullets[0].variants.some((v) => v.id === 'v_short');
      await vi.waitFor(() => expect(hasShort()).toBe(false));
      expect(spec('intern').choices.b_pipeline, 'the store moved the other resumes to another wording').not.toBe('v_short');

      // The open resume's own pin comes off in a save of its own; undo that, then the delete.
      for (let i = 0; i < 3 && !hasShort(); i++) await undoAndSettle();
      expect(hasShort(), 'the wording is back').toBe(true);
      expect(spec('intern'), 'and the resumes that had pinned it are on it again').toEqual(others.intern);
      expect(spec('base')).toEqual(others.base);
    });

    it('a skill', async () => {
      const intern = structuredClone(spec('intern'));
      const remove = [...document.querySelectorAll('#editor button')].find((b) => b.getAttribute('aria-label') === 'Delete "Zig" from the save' || b.ariaLabel === 'Delete "Zig" from the save');
      expect(remove, 'Zig\'s remove').toBeTruthy();
      remove.click();
      await confirmAndSettle();
      await vi.waitFor(() => expect(data.skillGroups[0].items.some((i) => i.id === 's_zig')).toBe(false));
      expect(spec('intern').sections.find((x) => x.kind === 'skills').items.sk_lang, 'the delete reached the resume').not.toContain('s_zig');

      await undoAndSettle();
      expect(data.skillGroups[0].items.some((i) => i.id === 's_zig'), 'the skill is back').toBe(true);
      expect(spec('intern'), 'and the resume that chose it has it again').toEqual(intern);
    });
  });
});
