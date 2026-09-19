// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * Taking something out of the save.
 *
 * Everything else in the store could already be deleted — entries, lines,
 * resumes, skills, letters, applications, voice samples. Two things could
 * only ever grow, and both of them grow fastest when the AI is being used:
 * the wordings of a line, which are added a few at a time by "draft another"
 * and never taken back, and the answer bank, which every form answered adds
 * to.
 *
 * A line with nine wordings, six from a model and two of them nearly the same
 * sentence, is a picker nobody can use. A year of applying leaves a bank whose
 * oldest entries are questions from a job you did not take.
 *
 * Deleted rather than archived, and committed: the version history has it,
 * the same way it has a deleted entry. That is the answer to "what if I
 * wanted it back", and it is the reason this can be a delete at all.
 */

let saved;
let putAnswers;
/** How many resumes other than the open one chose the wording under test. */
let chooserCount = 0;

async function open({ answers, chooser } = {}) {
  vi.resetModules();
  vi.useFakeTimers();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  location.hash = '';
  const fixture = makeTempStore();
  const data = fixture.store.load();
  fixture.cleanup();
  if (answers) data.answers = answers;
  /*
   * A second resume that has chosen the wording about to be deleted. Built
   * from the store rather than written out, because the ids are the
   * fixture's and a hand-written choice that matches nothing would make the
   * test pass by describing no resume at all.
   */
  if (chooser) {
    const entry = data.entries.find((e) => (e.bullets ?? []).some((b) => (b.variants ?? []).length > 1));
    const bullet = entry?.bullets.find((b) => (b.variants ?? []).length > 1);
    if (!bullet) throw new Error('the fixture has no line with alternates to choose between');
    /*
     * Every resume chooses it, the one about to be open included. That is
     * what makes the count discriminating: leave the open one in and the
     * sentence names one resume too many, which is a stranger being blamed
     * for what you are doing yourself.
     */
    data.resumes = [
      ...data.resumes.map((r) => ({ ...r, choices: { ...(r.choices ?? {}), [bullet.id]: bullet.default } })),
      { id: 'someone-else', label: "Someone else's resume", choices: { [bullet.id]: bullet.default } },
    ];
    chooserCount = data.resumes.length - 1;
  }

  saved = [];
  putAnswers = null;

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
      // The store the page reloads has to carry the edit, or the next render
      // puts back what was just removed.
      data.entries = data.entries.map((e) => (e.id === body.id ? body : e));
      result = body;
    } else if (url === '/api/answers' && options.method === 'PUT') {
      putAnswers = JSON.parse(options.body);
      data.answers = putAnswers;
      result = putAnswers;
    }
    return { ok: true, json: async () => structuredClone(result) };
  }));

  await import('../web/app.js');
  await vi.waitFor(() => expect(document.querySelector('.bullet-disclosure')).not.toBeNull());
  return data;
}

/** The confirmation is a modal, so something has to press its button. */
async function confirmIt() {
  await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
  document.querySelector('#modal-ok').click();
}

const bulletWithAlternates = () =>
  [...document.querySelectorAll('.bullet-disclosure')].find((b) => b.querySelector('.bullet-quick-actions .stepper'));

const buttonIn = (block, label) =>
  [...block.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

describe('deleting one wording of a line', () => {
  beforeEach(() => open());

  it('offers it where there is more than one wording', () => {
    expect(buttonIn(bulletWithAlternates(), 'Delete phrasing')).toBeTruthy();
  });

  /*
   * And not where there is one. With a single wording, deleting it and
   * deleting the line are the same act, and two buttons saying different
   * words for one outcome is worse than one button.
   */
  it('does not offer it on a line that has only one', () => {
    const only = [...document.querySelectorAll('.bullet-disclosure')].find(
      (b) => !b.querySelector('.bullet-quick-actions .stepper') && buttonIn(b, 'Remove'),
    );
    if (!only) return; // nothing to assert against in this fixture
    expect(buttonIn(only, 'Delete phrasing')).toBeFalsy();
  });

  it('takes that wording out and leaves the others', async () => {
    const block = bulletWithAlternates();
    const before = Number(block.querySelector('.chip.count').textContent.match(/\d+/)[0]);
    buttonIn(block, 'Delete phrasing').click();
    await confirmIt();

    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
    const written = saved.at(-1);
    const bullet = written.bullets.find((b) => b.variants.length === before - 1);
    expect(bullet, 'one line lost exactly one wording').toBeTruthy();
  });

  /*
   * Something has to be the pinned wording. Removing the pinned one without
   * moving the pin leaves `default` naming a variant that is gone, which
   * resolves to a warning on every build for a reason nobody would connect
   * to this.
   */
  it('moves the pin when the pinned wording is the one deleted', async () => {
    const block = bulletWithAlternates();
    buttonIn(block, 'Delete phrasing').click();
    await confirmIt();
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));

    for (const bullet of saved.at(-1).bullets ?? []) {
      expect(bullet.variants.some((v) => v.id === bullet.default), `${bullet.id} still pins a wording it has`).toBe(true);
    }
  });

  it('says how many wordings the line will be left with', async () => {
    buttonIn(bulletWithAlternates(), 'Delete phrasing').click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    expect(document.querySelector('#modal').textContent).toMatch(/keeps its other/i);
  });
});

describe('deleting an answer from the bank', () => {
  const bank = [
    {
      id: 'a_why',
      question: 'Why this team?',
      default: 'v1',
      variants: [
        { id: 'v1', label: 'First', text: 'Because of the ingest work.' },
        { id: 'v2', label: 'Second', text: 'Because the team owns its pipeline.' },
      ],
    },
  ];

  beforeEach(() => open({ answers: bank }));

  const answerCard = async () => {
    /*
     * The tabs are unlocked by `web/assets.js` once a save is open, and this
     * file mocks that module out — so the mock is what leaves them disabled,
     * not the product. Unlocking them here is the stand-in for the thing the
     * real module does on boot.
     */
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('#tabs button[data-tab="letters"]').click();
    await vi.waitFor(() => expect(document.querySelector('#answers .mini-card')).not.toBeNull());
    return document.querySelector('#answers .mini-card');
  };

  it('offers a way to remove one', async () => {
    expect(buttonIn(await answerCard(), 'Delete')).toBeTruthy();
  });

  it('writes the bank back without it', async () => {
    buttonIn(await answerCard(), 'Delete').click();
    await confirmIt();
    await vi.waitFor(() => expect(putAnswers).not.toBeNull());
    expect(putAnswers).toEqual([]);
  });

  /*
   * How many versions go, and whether anything used it. The second is the
   * fact that decides this and it is not visible from the question itself.
   */
  it('says how much is going before it goes', async () => {
    buttonIn(await answerCard(), 'Delete').click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    const said = document.querySelector('#modal').textContent;
    expect(said).toMatch(/2 versions/i);
    expect(said).toMatch(/nothing has used it yet/i);
  });

  it('leaves the bank alone when the confirmation is declined', async () => {
    buttonIn(await answerCard(), 'Delete').click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    document.querySelector('#modal-cancel').click();
    await vi.advanceTimersByTimeAsync(500);
    expect(putAnswers).toBeNull();
  });
});

/*
 * And the other half of the model.
 *
 * A line had "Delete phrasing" from the day the alternates could be added.
 * The heading fields — a role, a degree, a location, a graduation date — and
 * your own name did not, so they collected alternates and never lost one: a
 * degree line a model drafted, a company name tried two ways, a location from
 * before you moved. The only way back was to open the YAML, which is the one
 * thing this editor exists so you never have to do.
 */
describe('deleting an alternate of a heading field', () => {
  beforeEach(() => open());

  /** The education entry's dates carry two alternates in the fixture. */
  const fieldWithAlternates = () =>
    [...document.querySelectorAll('.variant-row')].find((r) =>
      [...r.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Delete alternate'),
    );

  it('offers it where the field has more than one', () => {
    expect(fieldWithAlternates()).toBeTruthy();
  });

  it('takes that alternate out and leaves the other', async () => {
    buttonIn(fieldWithAlternates(), 'Delete alternate').click();
    await confirmIt();

    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
    const written = saved.at(-1);
    const field = ['title', 'dates', 'subtitle', 'location']
      .map((n) => written[n])
      .find((f) => f && typeof f === 'object' && Array.isArray(f.variants));
    expect(field.variants).toHaveLength(1);
  });

  /*
   * Something has to be the pinned wording, the same as on a line: `default`
   * naming an alternate that is gone resolves to a warning on every build,
   * for a reason nobody would connect to this.
   */
  it('moves the pin when the pinned alternate is the one deleted', async () => {
    buttonIn(fieldWithAlternates(), 'Delete alternate').click();
    await confirmIt();
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));

    const written = saved.at(-1);
    for (const name of ['title', 'dates', 'subtitle', 'location']) {
      const f = written[name];
      if (!f || typeof f !== 'object' || !Array.isArray(f.variants)) continue;
      expect(f.variants.some((v) => v.id === f.default), `${name} still pins one it has`).toBe(true);
    }
  });

  it('says which field keeps what, before anything goes', async () => {
    buttonIn(fieldWithAlternates(), 'Delete alternate').click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    expect(document.querySelector('#modal').textContent).toMatch(/keeps its other/i);
  });

  it('leaves the save alone when the confirmation is declined', async () => {
    buttonIn(fieldWithAlternates(), 'Delete alternate').click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    document.querySelector('#modal-cancel').click();
    await vi.waitFor(() => expect(document.querySelector('#modal').classList.contains('hidden')).toBe(true));
    expect(saved).toEqual([]);
  });
});

/*
 * What a delete costs somebody who is not looking at it.
 *
 * Two things make removing one wording more than local, and neither was said
 * before pressing the button. The *pinned* one is the answer every resume
 * that has not chosen another gets, so deleting it moves all of them at once.
 * And a wording another resume has chosen leaves that resume naming something
 * that is not there — the resolver falls back to the default and warns, which
 * is right, but the warning turns up later on a build nobody connects to this
 * ("Choice edu_neu.subtitle asked for variant v_systems, which does not
 * exist").
 */
describe('saying what a delete costs before it happens', () => {
  const modalNote = () => document.querySelector('#modal p')?.textContent ?? '';

  it('says when the wording being deleted is the pinned one', async () => {
    await open();
    const block = bulletWithAlternates();
    // Whichever is on screen is the chosen one; on an untouched resume that
    // is the pinned one, which is the case being described.
    buttonIn(block, 'Delete phrasing').click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    expect(modalNote()).toMatch(/pinned wording/i);
    expect(modalNote()).toMatch(/becomes the pinned one instead/i);
    document.querySelector('#modal-cancel').click();
  });

  it('names the other resumes that chose it, and says what happens to them', async () => {
    await open({ chooser: true });
    const block = bulletWithAlternates();
    buttonIn(block, 'Delete phrasing').click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    expect(modalNote()).toMatch(/Someone else's resume/);
    expect(modalNote()).toMatch(/fall(s)? back/i);
    // The count, which is the part that must leave the open resume out.
    expect(modalNote()).toContain(`${chooserCount} other resume`);
    document.querySelector('#modal-cancel').click();
  });

  /*
   * And it does not invent one. The open resume's own choice is cleared as
   * part of the delete, so counting it would tell somebody their own action
   * is about to affect a stranger.
   */
  it('does not count the resume you have open', async () => {
    await open();
    const block = bulletWithAlternates();
    buttonIn(block, 'Delete phrasing').click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    expect(modalNote()).not.toMatch(/other resume/i);
    document.querySelector('#modal-cancel').click();
  });
});
