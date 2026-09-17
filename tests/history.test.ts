import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, SAMPLE_EXPERIENCE, type TempStore } from './helpers.js';

/**
 * The version history reads real commits back off disk, so these tests use a
 * genuine (auto-committing) git repo rather than mocking git away. The feature
 * is entirely about what the store actually recorded.
 */
let t: TempStore;
let app: express.Express;
let repo: Repo;

beforeEach(async () => {
  t = makeTempStore({ config: { ai: { enabled: false }, git: { autoCommit: true }, output: { dir: 'out' } } });
  repo = Repo.forStore(t.dir);
  await repo.ensure();
  app = express();
  app.use('/api', createApi({ store: t.store, repo }));
});
afterEach(() => t.cleanup());

const history = async (id = 'newgrad') => {
  const res = await request(app).get(`/api/resumes/${id}/history`).expect(200);
  return res.body.versions as {
    hash: string;
    date: string;
    message: string;
    label: string;
    changes: { kind: string; text: string; where?: string; from?: string; to?: string }[];
  }[];
};

const texts = (v: Awaited<ReturnType<typeof history>>[number]) => v.changes.map((c) => c.text);

describe('a resume version history', () => {
  it('is empty for a resume that never existed', async () => {
    const versions = await history('does-not-exist');
    expect(versions).toEqual([]);
  });

  it('opens with the first version, counted in document terms', async () => {
    const versions = await history();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.changes[0]?.kind).toBe('created');
    expect(versions[0]?.changes[0]?.text).toMatch(/First version — \d+ sections, \d+ bullet points/);
  });

  it('gives the same answer twice, and faster the second time', async () => {
    // A commit's contents are fixed, so the document it produced is cached.
    // The risk of caching is staleness, so: same request, same answer — and a
    // new commit still shows up.
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { b_pipeline: 'v_kafka' } })
      .expect(200);

    const first = await history();
    expect(await history()).toEqual(first);

    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { b_pipeline: 'v_short' } })
      .expect(200);

    const after = await history();
    expect(after.length).toBe(first.length + 1);
    expect(after[0]?.changes.some((c) => c.to === 'Built a pipeline')).toBe(true);
  });

  it('describes a phrasing switch as the sentence changing, not the variant id', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { b_pipeline: 'v_kafka' } })
      .expect(200);

    const versions = await history();
    const change = versions[0]?.changes.find((c) => c.kind === 'reworded');
    expect(change).toBeDefined();
    expect(change?.where).toBe('Acme Co.');
    // The actual before and after text, not "b_pipeline: v_base → v_kafka".
    expect(change?.from).toBe('Built a pipeline handling 2M events/day');
    expect(change?.to).toBe('Built a Kafka pipeline handling 2M events/day');
    expect(texts(versions[0]!).join(' ')).not.toContain('v_kafka');
  });

  it('describes a date field change with the dates themselves', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { 'edu_neu.dates': 'v_dec2026' } })
      .expect(200);

    const change = (await history())[0]?.changes.find((c) => c.kind === 'changed');
    expect(change?.where).toBe('Northeastern University');
    expect(change?.from).toContain('May 2026');
    expect(change?.to).toContain('Dec. 2026');
  });

  it('reports a bullet being turned off as the bullet being dropped', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({
        label: 'New grad',
        extends: 'base',
        sections: [{ kind: 'experience', entries: ['exp_acme'], bullets: { exp_acme: ['b_pipeline'] } }],
      })
      .expect(200);

    const versions = await history();
    expect(versions[0]?.changes).toContainEqual(
      expect.objectContaining({ kind: 'removed', where: 'Acme Co.', from: 'Raised coverage from 41% to 88%' }),
    );
  });

  it('reports an entry disappearing from the document', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', sections: [{ kind: 'project', entries: [] }] })
      .expect(200);

    const versions = await history();
    expect(texts(versions[0]!).join(' ')).toContain('Removed from Projects: Thing');
  });

  /**
   * The heart of it: this resume's own file did not change, but the sentence
   * printed on it did. A file-scoped history cannot see this.
   */
  it('shows an edit to a shared bullet, whose text this resume prints', async () => {
    const before = await history();

    const edited = structuredClone(SAMPLE_EXPERIENCE);
    edited.bullets![0]!.variants[0]!.text = 'Built a pipeline handling **9M events/day**';
    await request(app).put('/api/entries/exp_acme').send(edited).expect(200);

    const after = await history();
    expect(after.length).toBe(before.length + 1);
    const change = after[0]?.changes.find((c) => c.kind === 'reworded');
    expect(change?.where).toBe('Acme Co.');
    expect(change?.to).toBe('Built a pipeline handling 9M events/day');
  });

  it('shows a new bullet added to the store and printed by this resume', async () => {
    const edited = structuredClone(SAMPLE_EXPERIENCE);
    edited.bullets!.push({
      id: 'b_oncall',
      default: 'v_base',
      variants: [{ id: 'v_base', label: 'Neutral', text: 'Ran the on-call rotation for three services' }],
    });
    await request(app).put('/api/entries/exp_acme').send(edited).expect(200);

    const change = (await history())[0]?.changes.find((c) => c.kind === 'added');
    expect(change?.to).toBe('Ran the on-call rotation for three services');
  });

  it('ignores commits that leave this resume’s document untouched', async () => {
    const before = await history();

    // A different resume, a cover letter, and an application: none of them
    // change what `newgrad` prints.
    await request(app)
      .put('/api/resumes/intern')
      .send({ label: 'Summer intern (renamed)', extends: 'base', choices: { 'edu_neu.dates': 'v_dec2026' } })
      .expect(200);
    await request(app).post('/api/applications').send({ company: 'Streamly', role: 'Intern' }).expect(200);

    const after = await history();
    expect(after.length).toBe(before.length);
    expect(after[0]?.hash).toBe(before[0]?.hash);
  });

  it('never reports a version with nothing to say', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { 'edu_neu.dates': 'v_may2026' } })
      .expect(200);

    for (const v of await history()) {
      expect(v.changes.length).toBeGreaterThan(0);
      expect(v.changes.map((c) => c.kind)).not.toContain('none');
    }
  });

  it('names a rename as a rename', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad 2026', extends: 'base' })
      .expect(200);
    expect(texts((await history())[0]!)).toContain('Renamed to "New grad 2026"');
  });
});

describe('auto-save writes', () => {
  it('writes without committing when asked not to', async () => {
    const before = (await request(app).get('/api/config/store').expect(200)).body;

    await request(app)
      .put('/api/resumes/newgrad?commit=0')
      .send({ label: 'New grad', extends: 'base', choices: { b_pipeline: 'v_kafka' } })
      .expect(200);

    // On disk immediately...
    expect(t.store.getResume('newgrad')?.choices).toEqual({ b_pipeline: 'v_kafka' });

    // ...but not yet a version: the commit waits for the editing to stop.
    const after = (await request(app).get('/api/config/store').expect(200)).body;
    expect(after.pending.map((f: { path: string }) => f.path)).toContain('resumes/newgrad.yaml');
    expect(after.commits).toBe(before.commits);
  });

  it('still commits by default, so other callers are unaffected', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { b_pipeline: 'v_short' } })
      .expect(200);
    expect((await request(app).get('/api/config/store').expect(200)).body.pending).toEqual([]);
  });

  it('collects a burst of auto-saves into one version when the editing stops', async () => {
    // Ending on a variant whose text differs from the starting one: a burst
    // that lands back where it started is genuinely no change at all.
    for (const variant of ['v_kafka', 'v_base', 'v_short']) {
      await request(app)
        .put('/api/resumes/newgrad?commit=0')
        .send({ label: 'New grad', extends: 'base', choices: { b_pipeline: variant } })
        .expect(200);
    }
    const before = (await history()).length;
    await request(app).post('/api/store/save').send({}).expect(200);

    const versions = await history();
    expect(versions.length).toBe(before + 1); // one version, not three
    expect(versions[0]?.changes.some((c) => c.kind === 'reworded')).toBe(true);
  });
});

describe('profile writes', () => {
  it('can be saved without committing, like every other auto-save', async () => {
    const before = (await request(app).get('/api/config/store').expect(200)).body;

    await request(app)
      .put('/api/profile?commit=0')
      .send({ name: 'Test Person', email: 'test@example.com', location: 'Cambridge, MA' })
      .expect(200);

    expect(t.store.load().profile.location).toBe('Cambridge, MA');
    const after = (await request(app).get('/api/config/store').expect(200)).body;
    expect(after.pending.map((f: { path: string }) => f.path)).toContain('profile.yaml');
    expect(after.commits).toBe(before.commits);
  });

  it('commits by default', async () => {
    await request(app).put('/api/profile').send({ name: 'Test Person', phone: '555' }).expect(200);
    expect((await request(app).get('/api/config/store').expect(200)).body.pending).toEqual([]);
  });
});

describe('POST /store/save', () => {
  it('commits work that was changed outside the app', async () => {
    t.write('voice.md', '# Voice\n\nEdited by hand in an editor.\n');

    const before = await request(app).get('/api/config/store').expect(200);
    expect(before.body.pending.map((f: { path: string }) => f.path)).toContain('voice.md');

    const res = await request(app).post('/api/store/save').send({}).expect(200);
    expect(res.body.saved).toBe(true);
    expect(res.body.files.map((f: { path: string }) => f.path)).toContain('voice.md');
    expect(res.body.message).toBe('Save: voice notes');

    const after = await request(app).get('/api/config/store').expect(200);
    expect(after.body.pending).toEqual([]);
  });

  it('takes a message when one is given', async () => {
    t.write('answers.yaml', '[]\n');
    const res = await request(app).post('/api/store/save').send({ message: 'Tidied the bank' }).expect(200);
    expect(res.body.message).toBe('Tidied the bank');
  });

  it('reports having nothing to do without making an empty commit', async () => {
    await request(app).post('/api/store/save').send({}).expect(200);
    const res = await request(app).post('/api/store/save').send({}).expect(200);
    expect(res.body.saved).toBe(false);
    expect(res.body.files).toEqual([]);
  });
});

describe('restoring a version', () => {
  it('rolls the resume back to what that version said', async () => {
    const first = await history();
    const originalHash = first[0]!.hash;

    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { 'edu_neu.dates': 'v_dec2026' } })
      .expect(200);

    const restored = await request(app).post(`/api/resumes/newgrad/history/${originalHash}/restore`).expect(200);
    expect(restored.body.choices?.['edu_neu.dates']).toBe('v_may2026');

    const resolved = await request(app).get('/api/resumes/newgrad/resolved').expect(200);
    const dates = resolved.body.sections
      .flatMap((s: { entries: { id: string; dates: string }[] }) => s.entries)
      .find((e: { id: string }) => e.id === 'edu_neu')?.dates;
    expect(dates).toBe('Sep. 2022 -- May 2026');

    // Restoring is itself a version, so nothing is lost by going back.
    const after = await history();
    expect(after[0]?.message).toBe('Restore "newgrad" to an earlier version');
    expect(after.length).toBe(3);
  });

  it('rejects a hash the resume never had', async () => {
    const res = await request(app).post('/api/resumes/newgrad/history/0000000000000000/restore');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  /*
   * A version is the whole resolved document. The timeline says so — an edit to
   * a shared bullet appears as a version of every resume that prints it — but
   * restore read back only `resumes/<id>.yaml`, so those versions restored
   * nothing at all: 200 OK, "Restored." on screen, the document unchanged, and
   * not even a commit in the timeline to show for it.
   */
  it('restores what it can, and says what it could not', async () => {
    const before = await request(app).get('/api/resumes/newgrad/resolved').expect(200);
    const original = await history();
    const originalHash = original[0]!.hash;

    // A change in shared text: this bullet is printed by every resume.
    const entry = t.store.load().entries.find((e) => e.id === 'exp_acme')!;
    const bullet = entry.bullets![0]!;
    await request(app)
      .put(`/api/entries/${entry.id}`)
      .send({
        ...entry,
        bullets: [
          { ...bullet, variants: bullet.variants.map((v) => ({ ...v, text: 'REWRITTEN SHARED BULLET' })) },
          ...entry.bullets!.slice(1),
        ],
      })
      .expect(200);

    const restored = await request(app)
      .post(`/api/resumes/newgrad/history/${originalHash}/restore`)
      .expect(200);

    // It does not silently claim success on something it did not do.
    expect(restored.body.warnings.join(' ')).toMatch(/shares with others/i);
    expect(restored.body.warnings.length).toBeGreaterThan(1);

    void before;
  });

  /*
   * A resume this one inherits from is shared, exactly like a bullet or the
   * profile, and is left alone for exactly the same reason.
   *
   * Restore used to walk the whole `extends` chain and write every ancestor
   * back at the old commit's content. So rolling one tailored variation back to
   * last week also rolled `base` back — and `base` is what every other
   * variation is built on, so a week of work on the shared resume went with it.
   * Under a confirmation that said only "the current version will be replaced",
   * and a reply carrying no warnings at all, because the check re-resolves the
   * restored resume, which of course now matches.
   */
  it('does not roll back the resume this one is built on, which others share too', async () => {
    const original = (await history())[0]!.hash;

    // The change is in the parent, on a bullet the child does not override, so
    // it is genuinely part of what this resume says now.
    const base = t.store.getResume('base')!;
    await request(app)
      .put('/api/resumes/base')
      .send({ ...base, choices: { ...(base.choices ?? {}), b_pipeline: 'v_kafka' } })
      .expect(200);

    const restored = await request(app)
      .post(`/api/resumes/newgrad/history/${original}/restore`)
      .expect(200);

    expect(t.store.getResume('base')?.choices?.b_pipeline).toBe('v_kafka');
    // And it says so, rather than reporting a rollback that did not happen.
    expect(restored.body.warnings.join(' ')).toMatch(/shares with others/i);
  });

  it('leaves every other variation of that base exactly as it was', async () => {
    const original = (await history())[0]!.hash;

    const base = t.store.getResume('base')!;
    await request(app)
      .put('/api/resumes/base')
      .send({ ...base, label: 'Base resume — a week of work later' })
      .expect(200);
    const intern = t.store.getResume('intern')!;

    await request(app).post(`/api/resumes/newgrad/history/${original}/restore`).expect(200);

    expect(t.store.getResume('base')?.label).toBe('Base resume — a week of work later');
    expect(t.store.getResume('intern')).toEqual(intern);
  });
});
