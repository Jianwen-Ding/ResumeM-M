// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { AI_PRESETS, AI_TASKS } from '../src/ai/presets.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {}, clear: () => {} }) }));
/*
 * The save panel is drawn by the asset panel's `load`, so that one wire is
 * real here; the rest of the asset panel is not.
 */
vi.mock('../web/assets.js', () => ({
  setupAssets: ({ loadProjectSettings }) => ({
    init: async () => {
      for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
      return { current: '/test-save' };
    },
    load: async () => loadProjectSettings(),
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

let data;
let config;
let requests;
/** Per-test answers, by `METHOD url`, ahead of the defaults below. */
let routes;

async function boot() {
  vi.resetModules();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  window.location.hash = '';
  const fixture = makeTempStore();
  data = fixture.store.load();
  fixture.cleanup();
  config = {
    ai: { enabled: false, research: false, command: 'claude', args: ['-p', '{promptText}'], timeoutMs: 180_000 },
    latex: {},
    git: { autoCommit: false },
    output: { dir: 'out', fileNames: 'type' },
    layout: {},
    resumes: { temporaryDays: 7 },
    overrides: {},
  };
  requests = [];
  routes = routes ?? {};

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url: String(url), method, body });
      const route = routes[`${method} ${url}`];
      if (route) {
        const out = await route(body);
        if (out && out.refuse) return { ok: false, status: 400, json: async () => ({ error: out.refuse }) };
        return { ok: true, json: async () => structuredClone(out) };
      }
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/voice') result = { voice: '' };
      else if (url === '/api/ai/presets') result = { presets: AI_PRESETS, tasks: AI_TASKS };
      else if (url === '/api/config' && method === 'PUT') {
        config = {
          ...config,
          ...body,
          ai: { ...config.ai, ...(body.ai ?? {}) },
          latex: { ...config.latex, ...(body.latex ?? {}) },
          layout: { ...config.layout, ...(body.layout ?? {}) },
        };
        result = config;
      } else if (url === '/api/config') result = config;
      else if (url === '/api/config/store') {
        result = { dir: '/test-save', isRepo: true, commits: 3, remote: {}, pending: [] };
      } else if (url === '/api/resumes/expiring') result = { due: [], days: 7 };
      else if (url === '/api/letters') result = [];
      return { ok: true, json: async () => structuredClone(result) };
    }),
  );

  await import('../web/app.js');
  await vi.waitFor(() => expect(document.querySelector('#resume-select option')).not.toBeNull());
  for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
}

const tab = (name) => document.querySelector(`#tabs button[data-tab="${name}"]`).click();
const configPuts = () => requests.filter((r) => r.url === '/api/config' && r.method === 'PUT');
const change = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('change'));
};

beforeEach(() => {
  routes = {};
});

/*
 * "As it comes" and "Auto-detect" are the absence of a setting. They were
 * sent as `undefined`, which JSON leaves out, and the server merges — so the
 * old effort and engine stayed, under "Settings saved".
 */
describe('putting the AI settings back to their defaults', () => {
  it('sends null for "As it comes" and for "Auto-detect"', async () => {
    await boot();
    config.ai.effort = 'high';
    config.latex.engine = 'pdflatex';
    tab('voice');
    await vi.waitFor(() => expect(document.querySelector('.effort-slider')?.value).toBe('3'));

    const slider = document.querySelector('.effort-slider');
    slider.value = '0';
    slider.dispatchEvent(new Event('input'));
    const engine = [...document.querySelectorAll('#settings select')].find((s) => s.querySelector('option[value=pdflatex]'));
    change(engine, '');

    document.querySelector('#settings button.primary').click();
    await vi.waitFor(() => expect(configPuts().some((r) => r.body.ai && 'effort' in r.body.ai)).toBe(true));
    const sent = configPuts().find((r) => r.body.ai && 'effort' in r.body.ai).body;
    expect(sent.ai.effort).toBeNull();
    expect(sent.latex.engine).toBeNull();
  });
});

/*
 * An emptied number box was `Number('')` — 0 — and saved: a 0pt font on
 * every resume, or the sweep switched off. And a box whose save failed went
 * back to the value the panel was drawn with, not the one saved since.
 */
describe('the number boxes on the save panel', () => {
  const fontBox = () =>
    [...document.querySelectorAll('.page-defaults label.f')]
      .find((l) => l.textContent.includes('Font size'))
      .querySelector('input');
  const daysBox = () => document.querySelector('.temporary-life input');

  const openPanel = async () => {
    tab('save');
    await vi.waitFor(() => expect(document.querySelector('.page-defaults')).not.toBeNull());
  };

  it('puts back an emptied font size rather than saving 0', async () => {
    await boot();
    await openPanel();
    change(fontBox(), '');
    await vi.waitFor(() => expect(fontBox().value).toBe('10.5'));
    expect(configPuts()).toHaveLength(0);
  });

  it('holds the box to its own min and max', async () => {
    await boot();
    await openPanel();
    change(fontBox(), '40');
    await vi.waitFor(() => expect(fontBox().value).toBe('10.5'));
    expect(configPuts()).toHaveLength(0);
  });

  it('after a failed save, puts back what was saved last, not what was drawn', async () => {
    await boot();
    await openPanel();
    change(fontBox(), '11');
    await vi.waitFor(() => expect(configPuts()).toHaveLength(1));
    await vi.waitFor(() => expect(document.querySelector('#status')?.textContent ?? '').toMatch(/saved/i));

    routes['PUT /api/config'] = () => ({ refuse: 'read-only save' });
    change(fontBox(), '12');
    await vi.waitFor(() => expect(configPuts()).toHaveLength(2));
    await vi.waitFor(() => expect(fontBox().value).toBe('11'));
  });

  it('puts back an emptied number of days rather than switching the sweep off', async () => {
    await boot();
    await openPanel();
    change(daysBox(), '');
    await vi.waitFor(() => expect(daysBox().value).toBe('7'));
    expect(configPuts()).toHaveLength(0);
  });
});

describe('the days box remembers what it saved', () => {
  it('puts back the days saved last when a later save fails', async () => {
    let draws = 0;
    routes['GET /api/config/store'] = () => {
      draws++;
      // Only the first draw answers: the redraw after a save is held, so the
      // box under test is the one that saved.
      return draws === 1 ? { dir: '/test-save', isRepo: true, commits: 3, remote: {}, pending: [] } : new Promise(() => {});
    };
    await boot();
    tab('save');
    await vi.waitFor(() => expect(document.querySelector('.temporary-life input')).not.toBeNull());
    const box = document.querySelector('.temporary-life input');

    change(box, '14');
    await vi.waitFor(() => expect(configPuts()).toHaveLength(1));
    await vi.waitFor(() => expect(draws).toBe(2));

    routes['PUT /api/config'] = () => ({ refuse: 'read-only save' });
    change(box, '30');
    await vi.waitFor(() => expect(configPuts()).toHaveLength(2));
    await vi.waitFor(() => expect(box.value).toBe('14'));
  });
});

/* "Push Backup" was drawn from the remote the panel opened with. */
describe('the push button', () => {
  it('follows a remote saved, and one removed', async () => {
    let remote = {};
    routes['PUT /api/config/store/remote'] = (body) => {
      remote = body.url ? { url: body.url, tracked: false } : {};
      return remote;
    };
    await boot();
    tab('save');
    const push = () => [...document.querySelectorAll('#project-settings button')].find((b) => b.textContent === 'Push Backup');
    const save = () => [...document.querySelectorAll('#project-settings button')].find((b) => b.textContent === 'Save Remote');
    await vi.waitFor(() => expect(push()).toBeDefined());
    expect(push().disabled).toBe(true);

    const url = document.querySelector('#project-settings input[placeholder^="git@"]');
    url.value = 'git@github.com:me/save.git';
    save().click();
    await vi.waitFor(() => expect(push().disabled).toBe(false));

    url.value = '';
    save().click();
    await vi.waitFor(() => expect(push().disabled).toBe(true));
  });
});

/*
 * The results chip opened every job in the feedback panel. A "read my
 * material" job opened there was marked read, showed nothing, and its
 * proposal was lost.
 */
describe('the results chip and a material job', () => {
  it('takes a material job to its review, not to the feedback panel', async () => {
    const job = { id: 'm1', kind: 'material', about: '2 files of your writing', status: 'done', unread: true };
    routes['GET /api/ai/jobs'] = () => ({ jobs: [job] });
    routes['GET /api/ai/jobs/m1'] = () => ({
      ...job,
      result: {
        executed: true,
        read: ['a.md', 'b.md'],
        proposal: { entries: [{ id: 'found_co', kind: 'experience', title: 'Found Co', bullets: [{ text: 'Did a thing', source: 'did a thing' }] }] },
      },
    });
    await boot();
    const chip = document.querySelector('#jobs-chip');
    await vi.waitFor(() => expect(chip.textContent).toMatch(/1 result ready/));
    chip.click();

    await vi.waitFor(() => expect(document.querySelector('#modal-title').textContent).toContain('Found Co'));
    expect(document.querySelector('#feedback-panel').hidden).toBe(true);
    expect(document.querySelector('#tab-voice').classList.contains('active')).toBe(true);
  });
});

/* An emptied label box kept the old label: only a non-empty one was sent. */
describe('the label on a version of an answer', () => {
  it('can be cleared', async () => {
    let put;
    routes['PUT /api/answers'] = (body) => {
      put = body;
      return body;
    };
    await boot();
    data.answers = [
      {
        id: 'ans_why',
        question: 'Why are you interested?',
        default: 'v1',
        variants: [{ id: 'v1', label: 'Acme', text: 'Because.' }],
      },
    ];
    tab('letters');
    const edit = () =>
      [...document.querySelectorAll('#answers .mini-card button')].find((b) => b.textContent === 'Edit');
    await vi.waitFor(() => expect(edit()).toBeDefined());
    edit().click();
    await vi.waitFor(() => expect(document.querySelector('#f_label')).not.toBeNull());
    document.querySelector('#f_label').value = '';
    document.querySelector('#modal-ok').click();

    await vi.waitFor(() => expect(put).toBeDefined());
    const variant = put.find((a) => a.id === 'ans_why').variants[0];
    expect(variant.text).toBe('Because.');
    expect('label' in variant).toBe(false);
  });
});

/*
 * Stale sent workspaces are retired when a save is opened, or when asked —
 * and the editor never asked, so a page left open kept them all.
 */
describe('opening the Workspace', () => {
  const draft = (id, status) => ({
    id,
    company: `Co ${id}`,
    role: 'Engineer',
    status,
    questions: [],
    coverLetter: { required: false, body: '' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('asks for stale workspaces to be retired once, and redraws if any went', async () => {
    let drafts = [draft('d1', 'drafting'), draft('d2', 'submitted')];
    routes['GET /api/workspace'] = () => ({ drafts });
    routes['POST /api/workspace/retire'] = () => {
      drafts = [draft('d1', 'drafting')];
      return { drafts };
    };
    await boot();
    tab('workspace');

    await vi.waitFor(() => expect(requests.filter((r) => r.url === '/api/workspace/retire')).toHaveLength(1));
    await vi.waitFor(() => expect(document.querySelectorAll('#draft-list .draft-card')).toHaveLength(1));
    expect(requests.filter((r) => r.url === '/api/workspace/retire')[0].method).toBe('POST');

    tab('resumes');
    tab('workspace');
    await vi.waitFor(() => expect(requests.filter((r) => r.url === '/api/workspace' && r.method === 'GET').length).toBeGreaterThanOrEqual(3));
    expect(requests.filter((r) => r.url === '/api/workspace/retire')).toHaveLength(1);
  });
});
