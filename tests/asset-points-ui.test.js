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

beforeEach(() => {
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  vi.useFakeTimers({ toFake: ['setInterval'] });
  accepted = [];
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
});
