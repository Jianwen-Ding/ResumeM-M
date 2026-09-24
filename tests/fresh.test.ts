import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, SAMPLE_EXPERIENCE, type TempStore } from './helpers.js';
import type { ResumeSpec } from '../src/model/types.js';

/*
 * Whether what the card holds is still what the store would give it.
 *
 * The card builds a resume and keeps it for as long as the posting is open.
 * Change an entry, a bullet, or the copy itself in ResumeM-M, and the card
 * went on showing and attaching the version from before, with nothing to say
 * it was out of date.
 */

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  app = express();
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});
afterEach(() => t.cleanup());

const DAY = 24 * 60 * 60 * 1000;

/** A copy made from the base a day ago, as the extension makes one. */
function copy(extra: Partial<ResumeSpec> = {}): ResumeSpec {
  const base = t.store.load().resumes.find((r) => r.id === 'base')!;
  return {
    ...base,
    id: 'job-acme-platform-engineer',
    label: 'Platform Engineer — Acme',
    tier: 'temporary',
    copiedFrom: 'base',
    generatedFor: { company: 'Acme', role: 'Platform Engineer', at: new Date(Date.now() - DAY).toISOString() },
    ...extra,
  };
}

const fresh = (spec: ResumeSpec) => request(app).post('/api/extension/fresh').send({ spec }).expect(200);

/** Put the base resume's file a day into the past, as if it had not been touched since. */
function ageBase() {
  const f = path.join(t.dir, 'resumes', 'base.yaml');
  const then = new Date(Date.now() - 2 * DAY);
  fs.utimesSync(f, then, then);
}

describe('what the card holds, against the store', () => {
  it('prints the same while nothing changes', async () => {
    ageBase();
    const spec = copy();
    const a = await fresh(spec);
    const b = await fresh(spec);
    expect(a.body.printed).toMatch(/^[0-9a-f]{40}$/);
    expect(b.body.printed).toBe(a.body.printed);
    expect(a.body.base).toMatchObject({ id: 'base', changed: false });
  });

  it('prints something else once a bullet it uses is reworded in the store', async () => {
    ageBase();
    const spec = copy();
    const before = (await fresh(spec)).body.printed;
    const bullets = (SAMPLE_EXPERIENCE.bullets ?? []).map((b) =>
      b.id === 'b_pipeline'
        ? { ...b, variants: b.variants.map((v) => (v.id === 'v_base' ? { ...v, text: 'Built a pipeline handling **3M events/day**' } : v)) }
        : b,
    );
    t.write('experience.yaml', [{ ...SAMPLE_EXPERIENCE, bullets }]);
    const after = (await fresh(spec)).body.printed;
    expect(after).not.toBe(before);
  });

  it('hands back the copy as the store holds it, and says when that changes', async () => {
    ageBase();
    const spec = copy();
    t.store.saveResume(spec);
    const first = (await fresh(spec)).body;
    expect(first.stored?.id).toBe(spec.id);

    t.store.saveResume({ ...spec, label: 'Platform Engineer — Acme (edited)' });
    const second = (await fresh(spec)).body;
    expect(second.storedPrint).not.toBe(first.storedPrint);
    expect(second.stored.label).toBe('Platform Engineer — Acme (edited)');
  });

  it('says so when the resume it was made from has changed since', async () => {
    const spec = copy();
    // Written just now, a day after the copy was made.
    const base = t.store.load().resumes.find((r) => r.id === 'base')!;
    t.store.saveResume({ ...base, label: `${base.label} (edited)` });
    expect((await fresh(spec)).body.base).toMatchObject({ id: 'base', changed: true });
  });

  it('and the compile the card gets carries the same print', async () => {
    ageBase();
    const spec = copy();
    const { body } = await fresh(spec);
    const render = await request(app).post('/api/render').send({ spec, fit: 'as-written' });
    // A machine without LaTeX answers the render with an error; the print is
    // only asserted where there is a compile to carry it.
    if (render.status === 200) expect(render.body.printed).toBe(body.printed);
  });
});
