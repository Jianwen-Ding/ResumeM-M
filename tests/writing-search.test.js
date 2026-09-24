// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({
    init: async () => {
      for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
      return { current: '/test-save' };
    },
    load: async () => {},
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * Both lists on this tab grow and neither shrinks: a letter per application,
 * and a question per form that asked something new. The questions somebody
 * brings here are "what did I write to Helios?" and "have I answered this
 * before?", and without a way to narrow them both are answered by reading
 * every card on the page.
 */
describe('finding something in what you have already written', () => {
  const letters = [
    { id: 'l1', title: 'Helios — Platform Engineer', company: 'Helios', role: 'Platform Engineer', createdAt: '2026-03-12', body: 'I have spent four years on build pipelines.' },
    { id: 'l2', title: 'Lyra — Data Scientist', company: 'Lyra', role: 'Data Scientist', createdAt: '2026-05-01', body: 'Your work on forecasting is why I am writing.' },
  ];
  const answers = [
    { id: 'a1', question: 'Why do you want to work here?', default: 'v1', variants: [{ id: 'v1', text: 'The tooling you publish.' }] },
    { id: 'a2', question: 'Do you require sponsorship?', default: 'v1', variants: [{ id: 'v1', text: 'No.' }] },
  ];

  const cards = (which) => [...document.querySelectorAll(`#${which} .mini-card`)];
  const type = async (id, value) => {
    const box = document.querySelector(id);
    box.value = value;
    box.dispatchEvent(new window.Event('input'));
    await vi.waitFor(() => expect(document.querySelector('#letters')).not.toBeNull());
  };

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#letters';

    const fixture = makeTempStore();
    const data = { ...fixture.store.load(), answers };
    fixture.cleanup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/letters') result = letters;
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(cards('letters')).toHaveLength(2));
  });

  it('finds a letter by who it was written to', async () => {
    await type('#letter-find', 'helios');
    await vi.waitFor(() => expect(cards('letters')).toHaveLength(1));
    expect(document.querySelector('#letters').textContent).toContain('Platform Engineer');
  });

  it('and by a phrase from inside it, which is how anyone remembers a letter', async () => {
    // The titles these are given are all much of a muchness; the sentence is
    // what somebody actually remembers.
    await type('#letter-find', 'forecasting');
    await vi.waitFor(() => expect(cards('letters')).toHaveLength(1));
    expect(document.querySelector('#letters').textContent).toContain('Lyra');
  });

  it('leaves the answer bank alone while the letters are narrowed', async () => {
    await type('#letter-find', 'helios');
    await vi.waitFor(() => expect(cards('letters')).toHaveLength(1));
    expect(cards('answers')).toHaveLength(2);
  });

  it('narrows the answers on their own terms', async () => {
    await type('#answer-find', 'sponsor');
    await vi.waitFor(() => expect(cards('answers')).toHaveLength(1));
    expect(cards('letters')).toHaveLength(2);
  });

  it('tells nothing-matches from nothing-yet, in both lists', async () => {
    await type('#letter-find', 'no letter says this');
    await vi.waitFor(() => {
      const empty = document.querySelector('#letters .empty');
      expect(empty?.textContent).toContain('Nothing matches');
      // The distinction: two letters exist, neither mentions it.
      expect(empty?.textContent).toContain('2 letters here');
    });

    await type('#answer-find', 'no question says this');
    await vi.waitFor(() => {
      const empty = document.querySelector('#answers .empty');
      expect(empty?.textContent).toContain('Nothing matches');
      expect(empty?.textContent).toContain('2 questions saved');
    });
  });

  it('gives everything back when the box is cleared', async () => {
    await type('#letter-find', 'helios');
    await vi.waitFor(() => expect(cards('letters')).toHaveLength(1));
    await type('#letter-find', '');
    await vi.waitFor(() => expect(cards('letters')).toHaveLength(2));
  });
});

/*
 * A letter added by hand is named after the day and the company, and that
 * name is its file. Two for one company on one day — two roles there, or two
 * old letters pasted in with the company left blank — were given one name,
 * and the second was written over the first.
 */
describe('adding a cover letter by hand', () => {
  let letters;

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#letters';

    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    letters = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        const path = String(url);
        let result = {};
        if (path === '/api/store') result = { ...data, coverLetters: letters };
        else if (path === '/api/ai/jobs') result = { jobs: [] };
        else if (path === '/api/letters') result = letters;
        else if (path.startsWith('/api/letters/') && options.method === 'PUT') {
          const id = decodeURIComponent(path.split('?')[0].split('/').pop());
          const letter = { ...JSON.parse(options.body), id };
          letters = [...letters.filter((l) => l.id !== id), letter];
          result = letter;
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#btn-add-letter')).not.toBeNull());
  });

  const add = async (company, role, body) => {
    document.querySelector('#btn-add-letter').click();
    await vi.waitFor(() => expect(document.querySelector('#modal-content [name="body"]')).not.toBeNull());
    document.querySelector('#modal-content [name="company"]').value = company;
    document.querySelector('#modal-content [name="role"]').value = role;
    document.querySelector('#modal-content [name="body"]').value = body;
    const had = letters.length;
    document.querySelector('#modal-ok').click();
    await vi.waitFor(() => expect(document.querySelector('#status').textContent).toMatch(/saved|not saved/i));
    await new Promise((go) => setTimeout(go, 20));
    return had;
  };

  it('keeps both of two letters written to one company on one day', async () => {
    await add('Helios', 'Platform Engineer', 'The first letter.');
    document.querySelector('#status').textContent = '';
    await add('Helios', 'Site Reliability Engineer', 'The second letter.');

    expect(letters.map((l) => l.body).sort()).toEqual(['The first letter.', 'The second letter.']);
    expect(new Set(letters.map((l) => l.id)).size).toBe(2);
  });
});
