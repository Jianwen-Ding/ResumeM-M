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
let inflight;

async function openEditor() {
  vi.resetModules();
  vi.useFakeTimers();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  location.hash = '';
  const fixture = makeTempStore();
  const data = fixture.store.load();
  fixture.cleanup();

  saved = [];
  inflight = 0;
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    inflight++;
    try {
      return await answer(url, options);
    } finally {
      inflight--;
    }
  }));

  async function answer(url, options) {
    let result = {};
    if (url === '/api/store') result = data;
    else if (url === '/api/ai/jobs') result = { jobs: [] };
    else if (url === '/api/letters') result = [];
    else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
    else if (url === '/api/config') result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {} };
    else if (url === '/api/skills' && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      saved.push(body);
      data.skillGroups = body;
      result = body;
    } else if (String(url).startsWith('/api/resumes/') && options.method === 'PUT') {
      // Adding a group also writes the resume's section list, and the page
      // reloads the store straight after. Without keeping this, the reload
      // undoes it and the new group never appears on the page.
      const body = JSON.parse(options.body);
      const at = data.resumes.findIndex((r) => r.id === body.id);
      if (at >= 0) data.resumes[at] = body;
      else data.resumes.push(body);
      result = body;
    } else if (String(url).startsWith('/api/entries/') && options.method === 'PUT') {
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
  }

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

/*
 * Wait for the page to stop working before the test ends.
 *
 * Saving a group does more than the one PUT the assertion looks at — it writes
 * the resume's own section list and reloads the store afterwards. A test that
 * returned as soon as its PUT landed took the stubbed fetch away mid-chain,
 * and the tail of the save reached the real one.
 */
async function settle() {
  await vi.waitFor(() => expect(inflight).toBe(0));
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

const skillChips = () => [...document.querySelectorAll('.skill-chip')].map((c) => c.textContent.replace('×', '').trim());

/**
 * Click "+ Add skill group", fill the form, and wait for the page to be
 * showing the group before returning.
 *
 * Waiting on the request is not enough: the reload lands in `state` a turn
 * after its response does, and the next button has to be the one the page is
 * showing now rather than one left over from before. The lost update that used
 * to be underneath this — a second write built from a store that had never
 * seen the first — is the skills lane's job now, and has its own test below.
 */
async function addGroupNamed(name, items) {
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '+ Add skill group').click();
  await vi.waitFor(() => expect(document.querySelector('#f_name')).not.toBeNull());
  document.querySelector('#f_name').value = name;
  document.querySelector('#f_items').value = items;
  document.querySelector('#modal-ok').click();

  const first = items.split(',')[0].trim();
  await vi.waitFor(() => expect(skillChips()).toContain(first));
  await settle();
}

/*
 * A skills group has it worse than a line. A section lists groups by id and
 * the lookup takes the first match, so two groups with one id print the first
 * one twice and the second one never — the group you just made is not on the
 * page, and nothing says why.
 */
describe('adding two skill groups with the same name', () => {
  it('gives them different ids', async () => {
    await openEditor();
    await addGroupNamed('Languages', 'Python, Go');
    await vi.waitFor(() => expect(saved.length).toBe(1));
    await addGroupNamed('Languages', 'Rust');
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(1));

    const groups = saved.at(-1);
    const ids = groups.map((g) => g.id);
    expect(ids).toHaveLength(new Set(ids).size);
    // Both are there — the second is a real group, not a silent no-op, and
    // not the one the fixture already calls Languages either.
    expect(groups.find((g) => g.items.some((i) => i.text === 'Go' && g.id !== 'sk_lang'))).toBeTruthy();
    expect(groups.find((g) => g.items.some((i) => i.text === 'Rust'))).toBeTruthy();
    // And the symptom that made this worth fixing: with one id between them,
    // the second group is simply not on the page. The first prints twice
    // instead, because a section names its groups by id and the lookup takes
    // the first match.
    expect(skillChips()).toContain('Rust');
    await settle();
  });

  it('keeps the readable name when nothing is in the way', async () => {
    await openEditor();
    await addGroupNamed('Tooling', 'Git');
    await vi.waitFor(() => expect(saved.length).toBe(1));
    expect(saved.at(-1).some((g) => g.id === 'sk_tooling')).toBe(true);
    await settle();
  });

  it('does not let a repeated skill in one group collapse into one id', async () => {
    // "Python, Go, Python" is a typo rather than two skills, and letting both
    // be `s_python` left the second unselectable and removed both at once.
    await openEditor();
    await addGroupNamed('Languages', 'Rust, Zig, Rust');
    await vi.waitFor(() => expect(saved.length).toBe(1));

    // By id, not by name: the fixture already has a group called Languages,
    // and the one this test made is `sk_languages`.
    const group = saved.at(-1).find((g) => g.id === 'sk_languages');
    const ids = group.items.map((i) => i.id);
    expect(ids).toHaveLength(3);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(group.items.map((i) => i.text)).toEqual(['Rust', 'Zig', 'Rust']);
    await settle();
  });
});

/*
 * Two × clicks in a row.
 *
 * Every skills write is a read-modify-write of the whole group list: read
 * `state.store.skillGroups`, change one thing, PUT all of it. The store is
 * reloaded afterwards, and until that lands `state.store` still shows what was
 * there before — so a second write started inside that window builds its list
 * from the old one and puts back what the first had just removed.
 *
 * Forms make that window hard to hit; the × on a skill chip does not. Deleting
 * three skills is three clicks with nothing in between, and the way it failed
 * was for one of them to come back.
 */
describe('deleting two skills quickly', () => {
  const chipFor = (text) =>
    [...document.querySelectorAll('.skill-chip')].find((c) => c.textContent.replace('×', '').trim() === text);

  it('removes both, rather than the second putting the first back', async () => {
    const data = await openEditor();
    expect(chipFor('Python')).toBeTruthy();
    expect(chipFor('Go')).toBeTruthy();

    // No await between them: this is the point.
    chipFor('Python').querySelector('button.x').click();
    chipFor('Go').querySelector('button.x').click();

    await settle();
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(1));

    const group = data.skillGroups.find((g) => g.id === 'sk_lang');
    expect(group.items.map((i) => i.text)).not.toContain('Python');
    expect(group.items.map((i) => i.text)).not.toContain('Go');
  });
});
