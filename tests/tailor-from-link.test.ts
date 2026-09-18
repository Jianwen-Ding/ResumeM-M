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
   * run made. Starting from that would make a resume whose `extends` names
   * itself. Nothing is silently corrupted if it does — `flattenSpec` catches
   * the loop and the request comes back "Resume inheritance cycle at
   * job-streamly-intern", which is how this reads with the guard removed. But
   * an error is what the person gets instead of a resume, on the ordinary act
   * of tailoring the same posting twice, and the wrong thing is already on
   * disk by then.
   */
  it('does not make a resume that inherits from itself when run twice', async () => {
    serve();
    const draft = await openSpace();
    const first = await tailor(draft.id).expect(200);
    const second = await tailor(first.body.draft.id).expect(200);

    expect(second.body.spec.extends).not.toBe(second.body.spec.id);
    const saved = t.store.load().resumes.find((r) => r.id === second.body.spec.id);
    expect(saved?.extends).not.toBe(saved?.id);
    // And it still resolves, which is what a self-reference would end.
    await request(app).get(`/api/resumes/${encodeURIComponent(second.body.spec.id)}/resolved`).expect(200);
  });

  it('keeps starting from the same base on the second run', async () => {
    serve();
    const draft = await openSpace();
    const first = await tailor(draft.id).expect(200);
    const second = await tailor(first.body.draft.id).expect(200);
    expect(second.body.spec.extends).toBe(first.body.spec.extends);
  });

  it('starts from the base it is told to', async () => {
    serve();
    const draft = await openSpace();
    const res = await tailor(draft.id, { baseResumeId: 'intern' }).expect(200);
    expect(res.body.spec.extends).toBe('intern');
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
