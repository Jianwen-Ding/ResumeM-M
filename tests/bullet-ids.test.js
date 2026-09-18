// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * A line's id belongs to one line.
 *
 * Which wording a resume uses is recorded as `choices[bulletId]`, with no
 * entry beside it. So two lines with the same id are one line as far as every
 * resume is concerned: choose a wording on the first and the second changes
 * too, wherever it happens to have a wording by the same name — and two lines
 * minted from the same title usually do, because the wording ids are made
 * from the labels.
 *
 * "Add entry" named the first line of a new entry after its title alone, so
 * two roles at the same company — the most ordinary shape a resume has —
 * produced `b_acme-co_1` twice. The uniqueness check it did run looked inside
 * the entry being added to, which is the one place the collision cannot come
 * from, and nothing downstream complains: the wrong sentence simply prints.
 */

let saved;

async function openEditor() {
  vi.resetModules();
  vi.useFakeTimers();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  location.hash = '';
  const fixture = makeTempStore();
  const data = fixture.store.load();
  fixture.cleanup();

  saved = [];
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    let result = {};
    if (url === '/api/store') result = data;
    else if (url === '/api/ai/jobs') result = { jobs: [] };
    else if (url === '/api/letters') result = [];
    else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
    else if (url === '/api/config') result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {} };
    else if (String(url).startsWith('/api/entries/') && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      saved.push(body);
      // The store the page reloads has to carry the new entry, or the second
      // one is added against a store that has never seen the first — which is
      // the whole thing being tested.
      const at = data.entries.findIndex((e) => e.id === body.id);
      if (at >= 0) data.entries[at] = body;
      else data.entries.push(body);
      result = body;
    }
    return { ok: true, json: async () => structuredClone(result) };
  }));

  await import('../web/app.js');
  await vi.waitFor(() => expect(document.querySelector('.bullet-disclosure')).not.toBeNull());
  return data;
}

/** Click "+ Add entry" under a section heading and fill the form it opens. */
async function addEntryNamed(sectionLabel, title, bullet) {
  const heading = [...document.querySelectorAll('.section-heading')].find(
    (h) => h.querySelector('.name')?.textContent.trim() === sectionLabel,
  );
  [...heading.querySelectorAll('button')].find((b) => b.textContent.trim() === '+ Add entry').click();

  await vi.waitFor(() => expect(document.querySelector('#f_title')).not.toBeNull());
  document.querySelector('#f_title').value = title;
  document.querySelector('#f_bullet').value = bullet;
  document.querySelector('#modal-ok').click();
}

const allBulletIds = (entries) => entries.flatMap((e) => (e.bullets ?? []).map((b) => b.id));

describe('adding two entries with the same name', () => {
  it('gives their lines different ids', async () => {
    const data = await openEditor();

    await addEntryNamed('Experience', 'Acme Co.', 'Ran the billing migration.');
    await vi.waitFor(() => expect(saved.length).toBe(1));
    await addEntryNamed('Experience', 'Acme Co.', 'Interned on the data team.');
    await vi.waitFor(() => expect(saved.length).toBe(2));

    const [first, second] = saved;
    expect(first.id).not.toBe(second.id);
    expect(first.bullets[0].id).not.toBe(second.bullets[0].id);
  });

  it('leaves no id used twice anywhere in the store', async () => {
    const data = await openEditor();

    await addEntryNamed('Experience', 'Acme Co.', 'Ran the billing migration.');
    await vi.waitFor(() => expect(saved.length).toBe(1));
    await addEntryNamed('Experience', 'Acme Co.', 'Interned on the data team.');
    await vi.waitFor(() => expect(saved.length).toBe(2));

    const ids = allBulletIds(data.entries);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  /*
   * And it still reads like something a person named. A guard that renamed
   * every line `b_7f3a` would satisfy the test above and lose the thing ids
   * are readable for, which is knowing what you are looking at in a diff.
   */
  it('keeps the name it would have had when nothing is in the way', async () => {
    await openEditor();
    await addEntryNamed('Experience', 'Globex', 'Something nobody else has said.');
    await vi.waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0].bullets[0].id).toBe('b_globex_1');
  });
});
