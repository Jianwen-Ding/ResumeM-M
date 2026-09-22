// @vitest-environment jsdom
/**
 * What the Workspace says after a tailoring run.
 *
 * The sentence it lands on — "3 changes from the resume it started from,
 * chosen by the AI" — is the only account anybody gets of what the model did.
 * It was counting the changes that survived and saying nothing about the ones
 * that did not, which is the half worth knowing: `sanitizeAiPlan` checks every
 * id the model names against the save and drops the ones that are not there,
 * and it has always sent back what it dropped. A run where twelve of fifteen
 * choices were invented read exactly like a run that chose three.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {}, clear: () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('what the Workspace says a tailoring run did', () => {
  let tailorReply;
  const draftId = 'streamly-intern';

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const draft = {
      id: draftId,
      company: 'Streamly',
      role: 'Data Platform Intern',
      resumeId: 'intern',
      coverLetter: { required: false, body: '', edited: false },
      questions: [],
      notes: '',
    };

    // One real change, and however many refusals the test asks for.
    tailorReply = {
      draft,
      spec: { id: 'job-streamly-data-platform-intern', label: 'Data Platform Intern — Streamly' },
      diff: [{ kind: 'changed', text: 'Built a Kafka pipeline', where: 'Streamly' }],
      usedAi: true,
      fetched: false,
      rejected: [],
    };

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/workspace') result = { drafts: [draft] };
      else if (url.endsWith('/tailor')) result = tailorReply;
      else if (url.startsWith('/api/workspace/')) result = draft;
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="workspace"]').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.draft-card').length).toBeGreaterThan(0));
    document.querySelector('.draft-card').click();
    await vi.waitFor(() =>
      expect([...document.querySelectorAll('#draft-editor button')].some((b) => /Tailor one/.test(b.textContent)))
        .toBe(true),
    );
  });

  /** Press it and read everything the panel then says. */
  async function tailorAndRead() {
    [...document.querySelectorAll('#draft-editor button')]
      .find((b) => /Tailor one for this posting/.test(b.textContent))
      .click();
    await vi.waitFor(() =>
      expect(document.querySelector('#draft-editor').textContent).toMatch(/from the resume it started from/),
    );
    return document.querySelector('#draft-editor').textContent;
  }

  /*
   * The whole account, still on screen once everything has settled.
   *
   * It was written into the notes panel and *then* the store was reloaded and
   * the draft reopened — and `openDraft` ends in `renderDraft`, which builds
   * a new panel. So every word of it went into a node detached milliseconds
   * later. The run worked and the screen said nothing about it, which reads
   * as a button that does nothing.
   */
  it('is still on screen after the panel has been rebuilt', async () => {
    const said = await tailorAndRead();
    expect(said).toMatch(/Made "Data Platform Intern — Streamly" from the posting text/);
    expect(said).toMatch(/1 change from the resume it started from, chosen by the AI/);
    // Including the changes themselves, which are the reason to read it.
    expect(said).toMatch(/Built a Kafka pipeline/);
  });

  it('says how much of what the AI asked for is not in the save', async () => {
    tailorReply.rejected = ['choice b_ghost: no such bullet', 'choice b_pipe: not a variant id'];
    const said = await tailorAndRead();
    expect(said).toMatch(/2 things the AI asked for are not in this save/);
  });

  it('counts one as one thing', async () => {
    tailorReply.rejected = ['choice b_ghost: no such bullet'];
    expect(await tailorAndRead()).toMatch(/1 thing the AI asked for is not in this save/);
  });

  /*
   * By the count and never by the list: each entry names a bullet or a variant
   * by its internal id, and those are exactly what this editor does not show.
   */
  it('never names the ids it refused', async () => {
    tailorReply.rejected = ['choice b_ghost: no such bullet', 'skills g_langs: no such group'];
    const said = await tailorAndRead();
    expect(said).not.toMatch(/b_ghost|g_langs|no such/);
  });

  it('says nothing about refusals when the save took the plan whole', async () => {
    tailorReply.rejected = [];
    expect(await tailorAndRead()).not.toMatch(/the AI asked for/);
  });
});
