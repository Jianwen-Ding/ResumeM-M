/**
 * The store is on loopback with no password, and it answers any origin so the
 * browser extension can reach it. That combination means a bug here is not
 * "the tool misbehaves" — it is a page you happened to visit reaching into
 * your machine. These are the cases that turned out to matter.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { Store } from '../src/model/store.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  app = express();
  app.use(express.json({ limit: '32mb' }));
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.store.root) }));
});
afterEach(() => t.cleanup());

describe('an id is a name, never a path', () => {
  /*
   * Express decodes route parameters, so `%2F` arrives as a separator and an
   * id becomes a path. The worst of it was `../config`: the store's own
   * configuration holds `ai.command`, which this application executes.
   */
  it('cannot write the configuration through a resume id', async () => {
    const before = t.store.loadConfig().ai?.command;
    await request(app)
      .put(`/api/resumes/${encodeURIComponent('../config')}`)
      .send({ ai: { enabled: true, command: 'sh -c "touch /tmp/pwned"' } });
    expect(t.store.loadConfig().ai?.command).toBe(before);
  });

  it('cannot overwrite the profile through a resume id', async () => {
    await request(app).put(`/api/resumes/${encodeURIComponent('../profile')}`).send({ label: 'x' });
    expect(t.store.load().profile.name).toBe('Test Person');
  });

  it('cannot delete a file through a resume id', async () => {
    await request(app).delete(`/api/resumes/${encodeURIComponent('../profile')}`).expect(400);
    expect(t.store.load().profile.name).toBe('Test Person');
  });

  /*
   * The paths the sweep hands to git, which is the one place a resume's
   * filename is built as a path rather than a name at a time.
   *
   * Routing the delete above through one of these stopped it refusing, which
   * is how the trap was found: split back into segments,
   * `resumes/../profile.yaml` is three names, each of which passes the check
   * that the whole of it fails. The delete composes its own path again, and
   * these refuse an id that is a path, so neither can be the way in.
   */
  it('will not build a git path out of an id that is a path', () => {
    expect(() => Store.resumeFiles('../profile')).toThrow(/not allowed/);
    expect(() => Store.resumeFiles('../../etc/passwd')).toThrow(/not allowed/);
    expect(Store.resumeFiles('job-helios')).toEqual([
      'resumes/job-helios.yaml',
      'resumes/job-helios.yml',
    ]);
  });

  it('cannot write outside the save folder at all', async () => {
    const escaped = path.join(t.dir, 'ESCAPED.yaml');
    await request(app).put(`/api/resumes/${encodeURIComponent('../../ESCAPED')}`).send({ label: 'x' });
    expect(fs.existsSync(escaped)).toBe(false);
  });

  it('refuses the same trick through a body-supplied id', async () => {
    // `spec` on these routes is saved before anything looks at it, so the id
    // never went past a route check — there was not one.
    await request(app)
      .post('/api/workspace')
      .send({ company: 'A', role: 'B', spec: { id: '../config', label: 'x', ai: { command: 'nope' } } })
      .expect(400);
    expect(t.store.loadConfig().ai?.command).not.toBe('nope');
  });

  it('still allows the ordinary ids people actually use', async () => {
    await request(app).put('/api/resumes/acme-platform-engineer-2').send({ label: 'Fine' }).expect(200);
    expect(t.store.getResume('acme-platform-engineer-2')?.label).toBe('Fine');
  });
});

describe('a cast is not a check', () => {
  it('will not let a bad shape empty the answer bank', async () => {
    const before = t.store.load().answers.length;
    expect(before).toBeGreaterThan(0);
    await request(app).put('/api/answers').send({}).expect(400);
    expect(t.store.load().answers).toHaveLength(before);
  });

  it('will not let a bad shape break every render', async () => {
    // A non-array in skills.yaml made resolveResume throw on every call, and
    // nothing in the interface could repair it.
    await request(app).put('/api/skills').send({ nope: true }).expect(400);
    await request(app).get('/api/resumes/base/resolved').expect(200);
  });
});

describe('re-opening an application keeps what was written in it', () => {
  it('does not drop the questions when the page cannot see the form', async () => {
    /*
     * The extension posts the same application from several pages, and the
     * page with the description has no form on it. That post carried no
     * questions, and the draft was rewritten with none — taking the answers
     * already typed into them.
     */
    const made = await request(app)
      .post('/api/workspace')
      .send({ company: 'Acme', role: 'Engineer', questions: [{ question: 'Why us?' }] })
      .expect(200);
    const draft = made.body.draft;
    draft.questions[0].answer = 'Written by hand.';
    draft.questions[0].edited = true;
    await request(app).put(`/api/workspace/${draft.id}`).send(draft).expect(200);

    await request(app).post('/api/workspace').send({ company: 'Acme', role: 'Engineer' }).expect(200);

    const after = (await request(app).get(`/api/workspace/${draft.id}`).expect(200)).body;
    expect(after.questions).toHaveLength(1);
    expect(after.questions[0].answer).toBe('Written by hand.');
  });
});
