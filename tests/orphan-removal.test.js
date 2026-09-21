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
 * Taking a dead reference out of one resume.
 *
 * The master document keeps being edited under the resumes built from it.
 * Delete a line, retire a skills group, rename a phrasing, and every resume
 * that pinned it is left asking for something that is not there — and the
 * editor said so and stopped: "Entry 'exp_gone' does not exist" is a dead end
 * on its own, because the thing it names is in no picker and no tick box, it
 * being gone is the whole problem. The only ways out were editing the YAML by
 * hand or building the resume again from scratch.
 *
 * So each of those gets a button. What is worth testing is not that the
 * button draws — it is that pressing it writes a resume that no longer asks,
 * everywhere it was asking, including in the edits this session has made and
 * not yet saved.
 */
describe('removing something a resume asks for and the store has lost', () => {
  let puts;
  let rendered;

  /** The lost references the fake store reports for a given spec. */
  const lostIn = (spec) => {
    const out = [];
    const has = (list, id) => Array.isArray(list) && list.includes(id);
    for (const section of spec?.sections ?? []) {
      if (has(section.entries, 'exp_gone')) {
        out.push({ kind: 'entry', id: 'exp_gone', says: 'Section "experience" lists entry "exp_gone", which does not exist.' });
      }
      for (const ids of Object.values(section.bullets ?? {})) {
        if (has(ids, 'b_cut')) {
          out.push({ kind: 'bullet', id: 'b_cut', says: 'Entry "exp_acme" lists bullet "b_cut", which does not exist.' });
        }
      }
      if (has(section.groups, 'sk_retired')) {
        out.push({ kind: 'skillGroup', id: 'sk_retired', says: 'Skills group "sk_retired" does not exist.' });
      }
      for (const ids of Object.values(section.items ?? {})) {
        if (has(ids, 's_perl')) {
          out.push({ kind: 'skill', id: 's_perl', says: 'Skills group "Languages" no longer has the skill "s_perl", so it was left off.' });
        }
      }
    }
    if (spec?.choices?.b_pipeline === 'v_renamed') {
      out.push({ kind: 'wording', id: 'b_pipeline', says: 'Bullet "b_pipeline" asked for variant "v_renamed", which does not exist; using default.' });
    }
    return out;
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    /*
     * One resume asking for five things that are not there, which is not as
     * contrived as it looks: it is what one afternoon of tidying the master
     * document does to a resume built a month ago.
     */
    const base = data.resumes.find((r) => r.id === 'base');
    base.sections[1].entries = ['exp_acme', 'exp_gone'];
    base.sections[1].bullets = { exp_acme: ['b_pipeline', 'b_cut'] };
    base.sections[3].groups = ['sk_lang', 'sk_retired'];
    base.sections[3].items = { sk_lang: ['s_py', 's_perl'] };
    base.choices = { b_pipeline: 'v_renamed' };
    data.resumes = [base];

    puts = [];
    rendered = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/config') result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {} };
      else if (url === '/api/render') {
        const spec = JSON.parse(options.body ?? '{}').spec;
        rendered.push(spec);
        const lost = lostIn(spec);
        return {
          ok: true,
          json: async () => ({
            pages: 1,
            fits: true,
            adjustments: [],
            pdfUrl: '/pdf/x.pdf',
            warnings: lost.map((l) => l.says),
            lost,
          }),
        };
      } else if (String(url).startsWith('/api/resumes/') && options.method === 'PUT') {
        const spec = JSON.parse(options.body);
        puts.push(spec);
        // The store now holds this; a later /api/store would say so.
        Object.assign(base, spec);
        result = spec;
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#btn-rebuild')).not.toBeNull());
    // The preview compiles on an edit or when asked; nothing has been edited.
    document.querySelector('#btn-rebuild').click();
    await vi.waitFor(() => expect(document.querySelectorAll('#warnings .orphan').length).toBe(5));
  });

  const rows = () => [...document.querySelectorAll('#warnings .orphan')];
  const rowFor = (text) => rows().find((r) => r.querySelector('.what').textContent.includes(text));

  /** Press a row's button and let the auto-save debounce run out. */
  const press = async (text) => {
    rowFor(text).querySelector('button.drop-orphan').click();
    await vi.advanceTimersByTimeAsync(1500);
    return puts[puts.length - 1];
  };

  it('offers one row per thing, with the sentence that reported it', () => {
    expect(rows().map((r) => r.querySelector('.what').textContent)).toEqual([
      'Section "experience" lists entry "exp_gone", which does not exist.',
      'Entry "exp_acme" lists bullet "b_cut", which does not exist.',
      'Skills group "sk_retired" does not exist.',
      'Skills group "Languages" no longer has the skill "s_perl", so it was left off.',
      'Bullet "b_pipeline" asked for variant "v_renamed", which does not exist; using default.',
    ]);
    for (const row of rows()) expect(row.querySelector('button.drop-orphan')).not.toBeNull();
  });

  /*
   * And says it once. The panel draws these rows and then the warnings that
   * are not one of them; matched on anything looser than the sentence itself,
   * every problem appears twice — once with a button and once without, which
   * reads as two problems of which only one can be fixed.
   */
  it('and says nothing twice', () => {
    expect(document.querySelectorAll('#warnings > div').length).toBe(5);
  });

  it('writes a resume that no longer lists the entry, or its lines', async () => {
    const saved = await press('exp_gone');
    expect(saved.sections[1].entries).toEqual(['exp_acme']);
    expect(saved.sections[1].bullets.exp_gone).toBeUndefined();
  });

  it('takes out a line that is gone, and leaves the ones that are not', async () => {
    const saved = await press('b_cut');
    expect(saved.sections[1].bullets.exp_acme).toEqual(['b_pipeline']);
  });

  it('takes out a skills group, and the items pinned under it', async () => {
    const saved = await press('sk_retired');
    expect(saved.sections[3].groups).toEqual(['sk_lang']);
    expect(saved.sections[3].items.sk_retired).toBeUndefined();
    expect(saved.sections[3].items.sk_lang).toEqual(['s_py', 's_perl']);
  });

  it('takes out one skill without touching the rest of its group', async () => {
    const saved = await press('s_perl');
    expect(saved.sections[3].items.sk_lang).toEqual(['s_py']);
    expect(saved.sections[3].groups).toEqual(['sk_lang', 'sk_retired']);
  });

  it('takes out a choice that names a wording nobody has any more', async () => {
    const saved = await press('v_renamed');
    expect(saved.choices.b_pipeline).toBeUndefined();
  });

  /*
   * And the reference is gone from the compile that follows, not only from
   * the file. The same panel is rebuilt off that answer, so a removal the
   * renderer does not see is one the person watching sees undone in front of
   * them a second later.
   */
  it('recompiles without it, and the row goes', async () => {
    await press('b_cut');
    expect(lostIn(rendered[rendered.length - 1]).map((l) => l.id)).not.toContain('b_cut');
    await vi.waitFor(() => expect(document.querySelectorAll('#warnings .orphan').length).toBe(4));
    expect(rows().map((r) => r.querySelector('.what').textContent).join(' ')).not.toContain('b_cut');
  });

  /*
   * The half that a fix working on the stored copy alone would fail.
   *
   * `currentSpec` merges this session's unsaved edits over what the store
   * holds, and the skills chips are built from whichever of the two is there:
   * tick one skill on and the whole pinned list, dead id included, is copied
   * into `state.skillEdits` and becomes what gets written. A removal that
   * reaches only the stored copy is then overwritten by the overlay on its
   * way out — the file is saved with the dead id still in it, and the warning
   * is back on the next compile with the button apparently having done
   * nothing.
   */
  it('reaches the edits made since the resume was loaded', async () => {
    const chip = [...document.querySelectorAll('.skill-chip')].find((c) => c.textContent.includes('Go'));
    expect(chip, 'a chip for another skill in the same group').toBeTruthy();
    chip.querySelector('input[type="checkbox"]').click();
    await vi.advanceTimersByTimeAsync(1500);
    // The overlay is what decides this group now, and it still has the dead one.
    expect(puts[puts.length - 1].sections[3].items.sk_lang).toContain('s_perl');

    const saved = await press('s_perl');
    expect(saved.sections[3].items.sk_lang).not.toContain('s_perl');
    expect(saved.sections[3].items.sk_lang).toContain('s_go');
  });
});
