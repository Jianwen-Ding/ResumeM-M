// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { setupAssets } from '../web/assets.js';

/*
 * Draft points on Save & Files, reviewed one at a time.
 *
 * The list of points is drawn again from the server whenever anything in it
 * changes, and adding one point to an entry is such a change. Every other
 * point's box came back holding the server's wording, and whatever had been
 * rewritten in them while reviewing was gone without a word.
 */

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (/^(aria|data)-/.test(key)) node.setAttribute(key, String(value));
    else node[key] = value;
  }
  for (const c of [].concat(children)) if (c != null && c !== false) node.append(c);
  return node;
};
const setChildren = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

let assets;
let accepted;
/** Imports answered so far, and a gate the second one waits on when set. */
let imports;
let holdSecondImport = null;

beforeEach(() => {
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  vi.useFakeTimers({ toFake: ['setInterval'] });
  accepted = [];
  imports = 0;
  holdSecondImport = null;
  assets = [
    {
      id: 'a1',
      name: 'notes.txt',
      size: 10,
      status: 'ready',
      items: [],
      points: [
        { id: 'p1', text: 'Point one original', evidence: 'e1' },
        { id: 'p2', text: 'Point two original', evidence: 'e2' },
      ],
    },
  ];
});
afterEach(() => {
  vi.useRealTimers();
});

const api = async (path, options = {}) => {
  if (path === '/projects') return { current: '/save', recent: [], output: '/save/out' };
  if (path === '/config') return { output: {} };
  if (path === '/store') {
    return { config: { ai: { enabled: false } }, entries: [{ id: 'exp_acme', kind: 'experience', title: 'Acme' }] };
  }
  if (path === '/assets') {
    return { inbox: '/save/inbox', settings: { watch: false, generate: false }, assets: structuredClone(assets) };
  }
  if (path === '/assets/import') {
    if (++imports === 2 && holdSecondImport) await holdSecondImport;
    const { name } = JSON.parse(options.body);
    const asset = { id: `imp_${name}`, name, size: 10, status: 'ready', items: [], points: [] };
    assets.push(asset);
    return asset;
  }
  const accept = path.match(/^\/assets\/([^/]+)\/points\/([^/]+)\/accept$/);
  if (accept) {
    const body = JSON.parse(options.body);
    accepted.push(body);
    const point = assets[0].points.find((p) => p.id === accept[2]);
    Object.assign(point, { text: body.text, entryId: body.entryId });
    return { ok: true };
  }
  return {};
};

async function open() {
  const ui = setupAssets({
    api,
    el,
    setChildren,
    readAsBase64: async () => '',
    flushEdits: async () => {},
    isDirty: () => false,
    reloadStore: async () => {},
    entryName: (e) => e.title,
    status: () => {},
    projectChanged: () => {},
    loadProjectSettings: async () => {},
  });
  await ui.init();
  await ui.load();
  return ui;
}

const boxes = () => [...document.querySelectorAll('.asset-point textarea')];

describe('reviewing draft points', () => {
  it('keeps the rewrites in the other points when one is added', async () => {
    await open();
    expect(boxes()).toHaveLength(2);

    const type = (box, text) => {
      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    };
    type(boxes()[0], 'Point one, rewritten');
    type(boxes()[1], 'Point two, also rewritten');

    const first = document.querySelectorAll('.asset-point')[0];
    first.querySelector('select').value = 'exp_acme';
    [...first.querySelectorAll('button')].find((b) => b.textContent === 'Add Reviewed Point').click();
    await vi.waitFor(() => expect(boxes()[0].disabled).toBe(true));

    expect(accepted).toEqual([{ entryId: 'exp_acme', text: 'Point one, rewritten' }]);
    expect(boxes()[1].value).toBe('Point two, also rewritten');
  });

  /*
   * Everything else chosen for a point while reviewing it, through the same
   * redraws. Only the wording was kept: the five-second poll, or adding
   * another point, put the entry back to "Choose an Entry…", forgot the name
   * and kind of a "+ New Entry", and folded the evidence being checked.
   */
  it('keeps the entry chosen, a new entry\'s name and kind, and open evidence', async () => {
    const ui = await open();
    const points = () => [...document.querySelectorAll('.asset-point')];

    const [one, two] = points();
    const target = (point) => point.querySelector('select');
    target(one).value = 'exp_acme';
    target(one).dispatchEvent(new Event('change'));
    const evidence = one.querySelector('details');
    evidence.open = true;
    evidence.dispatchEvent(new Event('toggle'));

    target(two).value = '__new';
    target(two).dispatchEvent(new Event('change'));
    const [, name, kind] = two.querySelectorAll('.toolbar input, .toolbar select');
    expect(name.hidden).toBe(false);
    name.value = 'Volunteer tutoring';
    name.dispatchEvent(new Event('input'));
    kind.value = 'experience';
    kind.dispatchEvent(new Event('change'));

    // Drawn again from the server, as the poll and every add do.
    await ui.load();
    const [oneAgain, twoAgain] = points();
    expect(oneAgain, 'the list was drawn again').not.toBe(one);

    expect(target(oneAgain).value).toBe('exp_acme');
    expect(oneAgain.querySelector('details').open).toBe(true);
    expect(target(twoAgain).value).toBe('__new');
    const [, nameAgain, kindAgain] = twoAgain.querySelectorAll('.toolbar input, .toolbar select');
    expect(nameAgain.hidden).toBe(false);
    expect(nameAgain.value).toBe('Volunteer tutoring');
    expect(kindAgain.value).toBe('experience');
    expect(twoAgain.querySelector('details').open).toBe(false);
  });

  /*
   * An import batch, while a point is being rewritten. Each file of the batch
   * redrew the list, and the box being typed in with it: the cursor went
   * mid-word and the rest of the sentence went to the page.
   */
  it('does not redraw the box being typed in until an import batch is done', async () => {
    await open();
    const box = boxes()[1];
    box.focus();
    box.value = 'Point two, half';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.setSelectionRange(5, 5);

    let release;
    holdSecondImport = new Promise((go) => (release = go));
    const input = document.querySelector('#asset-files');
    const files = ['a.txt', 'b.txt', 'c.txt'].map((name) => new File(['x'], name));
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));

    // The first file is in and the second is held: the batch is mid-way.
    await vi.waitFor(() => expect(assets).toHaveLength(2));
    await new Promise((go) => setTimeout(go, 20));
    expect(document.contains(box), 'the box being typed in is the same one, mid-batch').toBe(true);
    expect(document.activeElement).toBe(box);

    release();
    await vi.waitFor(() => expect(document.querySelectorAll('.asset-card')).toHaveLength(4));
    // Drawn again once at the end, with the cursor given back where it was.
    const again = boxes()[1];
    expect(again.value).toBe('Point two, half');
    expect(document.activeElement).toBe(again);
    expect(again.selectionStart).toBe(5);
  });
});
