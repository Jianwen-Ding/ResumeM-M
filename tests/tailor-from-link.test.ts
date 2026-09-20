/**
 * Tailoring a resume from inside the workspace.
 *
 * The extension does this with the posting already in front of it. A space
 * opened by hand has only what you typed and, if you pasted one, a link — so
 * the server runs the identical pipeline rather than a lesser second version
 * of it. That means this endpoint is where several things have to hold at
 * once, and the interesting ones are all about the second time it runs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { DEFAULT_CONFIG } from '../src/model/types.js';
import { makeTempStore, tempDir, type TempStore } from './helpers.js';

const scripts = tempDir('rmm-tailor-stub-');

/** A stand-in for the model, launched the way the real presets are. */
function saying(reply: string): { command: string; args: string[] } {
  const file = path.join(scripts, `${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(reply)});\n`, 'utf8');
  return { command: process.execPath, args: [file, '{prompt}'] };
}

let t: TempStore;
let app: express.Express;

function serve(reply?: string) {
  const ai = reply
    ? { ...DEFAULT_CONFIG.ai, enabled: true, ...saying(reply), timeoutMs: 20_000 }
    : { ...DEFAULT_CONFIG.ai, enabled: false };
  t = makeTempStore({ config: { ai, git: { autoCommit: false }, output: { dir: 'out' } } });
  app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
}

afterEach(() => t?.cleanup());

/** A space for a posting, with the text pasted in rather than fetched. */
async function openSpace(company = 'Streamly', role = 'Data Platform Intern') {
  const res = await request(app)
    .post('/api/workspace')
    .send({
      company,
      role,
      jobDescription: 'Kafka streaming infrastructure in Go and Python. Distributed systems, Kubernetes on AWS.',
    })
    .expect(200);
  return res.body.draft ?? res.body;
}

const tailor = (id: string, body: unknown = {}) =>
  request(app).post(`/api/workspace/${encodeURIComponent(id)}/tailor`).send(body as object);

describe('tailoring from a space', () => {
  it('makes a resume for the posting and attaches it to the space', async () => {
    serve();
    const draft = await openSpace();
    const res = await tailor(draft.id).expect(200);

    expect(res.body.spec.id).toBeTruthy();
    expect(res.body.draft.resumeId).toBe(res.body.spec.id);
    // Nothing was fetched: the space carries the posting text, not a link.
    expect(res.body.fetched).toBe(false);
    expect(t.store.load().resumes.map((r) => r.id)).toContain(res.body.spec.id);
  });

  /*
   * The one this endpoint has a comment about, and the reason to test it.
   *
   * The second run finds the space already pointing at the resume the first
   * run made. Building from that is the wrong answer, and quietly: the copy's
   * skills are already narrowed to this posting and its wordings already
   * chosen for it, so matching it again narrows what was narrowed and each
   * pass keeps fewer skills than the last. Back when this was a link rather
   * than a copy it was worse — the resume named itself as its base and every
   * read of it raised "Resume inheritance cycle" — but the fix is the same
   * either way: build it again from where it came from.
   */
  it('does not build a posting’s copy from itself when run twice', async () => {
    serve();
    const draft = await openSpace();
    const first = await tailor(draft.id).expect(200);
    const second = await tailor(first.body.draft.id).expect(200);

    expect(second.body.spec.copiedFrom).not.toBe(second.body.spec.id);
    const saved = t.store.load().resumes.find((r) => r.id === second.body.spec.id);
    expect(saved?.copiedFrom).not.toBe(saved?.id);
    // And it still resolves, which is what a self-reference would have ended.
    await request(app).get(`/api/resumes/${encodeURIComponent(second.body.spec.id)}/resolved`).expect(200);
  });

  it('keeps starting from the same base on the second run', async () => {
    serve();
    const draft = await openSpace();
    const first = await tailor(draft.id).expect(200);
    const second = await tailor(first.body.draft.id).expect(200);
    expect(second.body.spec.copiedFrom).toBe(first.body.spec.copiedFrom);
  });

  it('starts from the base it is told to', async () => {
    serve();
    const draft = await openSpace();
    const res = await tailor(draft.id, { baseResumeId: 'intern' }).expect(200);
    expect(res.body.spec.copiedFrom).toBe('intern');
  });

  it('says which space it cannot find', async () => {
    serve();
    const res = await tailor('no-such-space').expect(400);
    expect(res.body.error).toMatch(/no-such-space/);
  });
});

describe('when the AI is in the loop', () => {
  const PLAN = JSON.stringify({
    choices: { b_pipeline: 'v_kafka' },
    reasoning: 'The posting is about Kafka.',
  });

  it('uses the plan it came back with', async () => {
    serve(PLAN);
    const draft = await openSpace();
    const res = await tailor(draft.id, { useAi: true }).expect(200);
    expect(res.body.usedAi).toBe(true);
    expect(res.body.spec.choices.b_pipeline).toBe('v_kafka');
  });

  it('does not use it when it was not asked for', async () => {
    serve(PLAN);
    const draft = await openSpace();
    const res = await tailor(draft.id, { useAi: false }).expect(200);
    expect(res.body.usedAi).toBe(false);
  });

  /*
   * A malformed reply must not sink the deterministic match. The keyword
   * match is the floor this tool stands on — it works with the AI switched
   * off entirely — and a model returning prose is not a reason to hand back
   * nothing.
   */
  it('still produces a resume when the reply cannot be read', async () => {
    serve('I thought about this and here are some ideas for you.');
    const draft = await openSpace();
    const res = await tailor(draft.id, { useAi: true }).expect(200);
    expect(res.body.usedAi).toBe(false);
    expect(res.body.spec.id).toBeTruthy();
    expect(t.store.load().resumes.map((r) => r.id)).toContain(res.body.spec.id);
  });

  it('still makes a resume when the model will not start', async () => {
    // The same hole as on `/analyze`, one endpoint along: the button says
    // "with AI", and a command that is not there must not turn it into an
    // error. The resume is the keyword match, and the reason comes back
    // beside it.
    t = makeTempStore({
      config: {
        ai: { ...DEFAULT_CONFIG.ai, enabled: true, command: '/nonexistent/model-cli', args: ['{prompt}'], timeoutMs: 5_000 },
        git: { autoCommit: false },
        output: { dir: 'out' },
      },
    });
    app = express();
    app.use(express.json());
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

    const draft = await openSpace();
    const res = await tailor(draft.id, { useAi: true }).expect(200);
    expect(res.body.usedAi).toBe(false);
    expect(res.body.aiFailed).toBeTruthy();
    expect(t.store.load().resumes.map((r) => r.id)).toContain(res.body.spec.id);
  });

  it('reports what it refused to do, rather than doing it quietly', async () => {
    // A plan naming a wording that is not in the store: the sanitiser drops
    // it, and the editor shows what was dropped beside what was kept.
    serve(JSON.stringify({ choices: { b_pipeline: 'v_invented', b_ghost: 'v_base' } }));
    const draft = await openSpace();
    const res = await tailor(draft.id, { useAi: true }).expect(200);
    expect(res.body.spec.choices.b_pipeline).not.toBe('v_invented');
    expect(res.body.rejected.length).toBeGreaterThan(0);
  });
});

/**
 * The same questions for the endpoint the extension actually calls.
 *
 * `/extension/analyze` is the busiest route in the product — it runs on every
 * posting the extension decides is a posting. Its AI-off path is well covered
 * elsewhere; what was not covered is what happens when the AI is on, which is
 * how most people will run it.
 */
describe('analysing a posting with the AI switched on', () => {
  const JOB_HTML = `<html><head><title>SWE Intern at Streamly</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting","title":"Data Platform Intern",
"hiringOrganization":{"@type":"Organization","name":"Streamly"},
"description":"<p>Kafka streaming infrastructure in Go and Python, Kubernetes on AWS. Distributed systems. Minimum qualifications: BS in Computer Science.</p>"}
</script></head><body>Apply now</body></html>`;

  const analyze = (body: unknown) =>
    request(app).post('/api/extension/analyze').send(body as object);

  it('takes the plan the model returned as JSON', async () => {
    serve(JSON.stringify({ choices: { b_testing: 'v_base' }, reasoning: 'Testing is named in the posting.' }));
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);
    expect(res.body.aiUsed).toBe(true);
    expect(res.body.aiReasoning).toMatch(/Testing is named/);
    expect(res.body.tailor).toBe('ai');
  });

  /*
   * And falls back to the keyword match when it cannot.
   *
   * This is the one that matters. The match is deterministic and runs with the
   * AI switched off entirely; a model returning prose is a bad minute, not a
   * reason for the extension to offer nothing on a posting the person is
   * looking at right now.
   */
  it('still proposes a resume when the model returns prose', async () => {
    serve('Sure! Here are my thoughts on how to tailor this resume for you.');
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);

    expect(res.body.isJobPosting).toBe(true);
    expect(res.body.aiUsed).toBe(false);
    // And says so rather than letting the card claim the AI tailored it.
    expect(res.body.tailor).toBe('match');
    expect(res.body.aiRaw).toMatch(/my thoughts/);
    // The deterministic match is still there underneath it.
    expect(res.body.spec.choices.b_pipeline).toBe('v_kafka');
    expect(res.body.rationale.some((r: { key: string }) => r.key === 'b_pipeline')).toBe(true);
  });

  /*
   * The arrangement the model chose has to survive the trip to the document.
   *
   * `applyInclusion` marks a section it has reordered `manual`, precisely so
   * the master's date sort does not restack it on the way to the page. The
   * endpoint then merged the derived spec over the top and named `entries`
   * and `bullets` to put them back, but not `order` — and `Store.load()`
   * gives very nearly every section a date sort, so `manual` became `newest`
   * and the model's order was undone. Silently, after the tool had already
   * told the model it had worked.
   *
   * Asserted on the section rather than on the plan, because the plan was
   * always right: it is the resume that came out wrong.
   */
  it('keeps the order the model chose, rather than restacking it by date', async () => {
    serve(JSON.stringify({
      entryOrder: { experience: ['exp_acme'] },
      order: { exp_acme: ['b_testing', 'b_pipeline'] },
    }));
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);

    const experience = res.body.spec.sections.find((s: { kind: string }) => s.kind === 'experience');
    expect(res.body.aiUsed).toBe(true);
    // The lines, in the order asked for.
    expect(experience.bullets.exp_acme).toEqual(['b_testing', 'b_pipeline']);
    // And the resume saying it arranged them itself, which is what makes the
    // line above survive rendering.
    expect(experience.order).toBe('manual');
    expect(experience.bulletOrder?.exp_acme).toBe('manual');
  });

  it('discards a choice the model invented', async () => {
    // The AI selects; it never writes. Anything that is not an id it could
    // have chosen from is dropped before it reaches a resume.
    serve(JSON.stringify({ choices: { b_pipeline: 'v_nonexistent' } }));
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);
    expect(res.body.spec.choices.b_pipeline).not.toBe('v_nonexistent');
  });

  /*
   * A CLI that is not there at all.
   *
   * The commonest way this fails in use — `claude` off this process's PATH, a
   * renamed binary, a half-finished install — and it used to throw, become a
   * 502, and leave the extension showing an error instead of a card. On every
   * posting, until the configuration was fixed, for a product that works with
   * the AI switched off entirely.
   */
  it('still proposes a resume when the model will not start', async () => {
    t = makeTempStore({
      config: {
        ai: { ...DEFAULT_CONFIG.ai, enabled: true, command: '/nonexistent/model-cli', args: ['{prompt}'], timeoutMs: 5_000 },
        git: { autoCommit: false },
        output: { dir: 'out' },
      },
    });
    app = express();
    app.use(express.json());
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);
    expect(res.body.isJobPosting).toBe(true);
    expect(res.body.tailor).toBe('match');
    expect(res.body.spec.choices.b_pipeline).toBe('v_kafka');
    // And says why, so the card can name a misconfigured AI rather than
    // leaving the person wondering why the star never lights up.
    expect(res.body.aiFailed).toBeTruthy();
  });
});
