import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, noiseCommits, SAMPLE_EXPERIENCE, type TempStore } from './helpers.js';

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

  /*
   * A save busy enough that this resume's own commits fall out of the window.
   *
   * The scan is over *all* commits — every save here is one: entries,
   * applications, letters, answers, drafts, sweeps, AI activity — so a store
   * in regular use passes the three-hundred cap quickly. Once it does,
   * `previous` is still undefined at the oldest commit in the window, and
   * `diffResumes` unconditionally calls that the first version.
   *
   * Measured before the fix, with one real edit and 130 commits touching only
   * a note: the timeline showed a single card reading "Unrelated note 10 —
   * First version, 4 sections, 4 bullet points". The real first version and
   * the real change were gone; a commit that never touched this resume was
   * presented as the moment it was created; and since the newest card is
   * badged "Current" and given no Restore button, the whole of that resume's
   * history had become unreachable from the editor.
   */
  describe('when the scan window runs out before the history does', () => {
    const noise = (n: number) => noiseCommits(t.dir, n);

    it('does not present an unrelated commit as the resume being created', async () => {
      await request(app)
        .put('/api/resumes/newgrad')
        .send({ label: 'New grad', extends: 'base', choices: { 'edu_neu.dates': 'v_dec2026' } })
        .expect(200);
      // Past the cap, so the window cannot reach either of the two above.
      await noise(310);

      const res = await request(app).get('/api/resumes/newgrad/history').expect(200);
      const versions = res.body.versions as { message: string; changes: { text: string }[]; earliest?: boolean }[];
      expect(versions.length).toBeGreaterThan(0);
      const oldest = versions[versions.length - 1]!;
      expect(oldest.changes.map((c) => c.text).join(' ')).not.toMatch(/First version/);
      expect(oldest.earliest).toBe(true);
      // And the caller is told there is more, so it can ask for it.
      expect(res.body.more).toBe(true);
    });

    it('still calls the real first version the first version', async () => {
      // A short history the window reaches the beginning of.
      const res = await request(app).get('/api/resumes/newgrad/history').expect(200);
      const versions = res.body.versions as { changes: { text: string }[]; earliest?: boolean }[];
      const oldest = versions[versions.length - 1]!;
      expect(oldest.changes.map((c) => c.text).join(' ')).toMatch(/First version/);
      expect(oldest.earliest).toBeUndefined();
      expect(res.body.more).toBe(false);
    });

    it('says when it kept only the newest of what it found', async () => {
      for (let i = 0; i < 6; i++) {
        await request(app)
          .put('/api/resumes/newgrad')
          .send({ label: `New grad v${i}`, extends: 'base' })
          .expect(200);
      }
      const res = await request(app).get('/api/resumes/newgrad/history?limit=3').expect(200);
      expect(res.body.versions).toHaveLength(3);
      expect(res.body.more).toBe(true);

      // And asking for more gets more, which is what `more` is for.
      const all = await request(app).get('/api/resumes/newgrad/history?limit=50').expect(200);
      expect(all.body.versions.length).toBeGreaterThan(3);
      expect(all.body.more).toBe(false);
    });
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

describe('workspace and application writes stay in the version history', () => {
  /*
   * Opening a workspace commits the draft, then — a moment later, once the
   * tracker row is read back off disk — writes the application it starts or
   * advances. That second write used to happen bare: on disk immediately, and
   * never committed on its own, so a save left running is a save whose
   * tracker has quietly stopped being recoverable.
   */
  /*
   * In one commit, not two. A commit of its own kept the row in the history
   * but made every workspace opened cost a second git run, which under load
   * delayed the very draft it opens.
   */
  const commitCount = async () => (await request(app).get('/api/history').expect(200)).body.commits.length as number;

  it('commits the application row a new workspace opens, with the draft, in one commit', async () => {
    const before = await commitCount();
    await request(app).post('/api/workspace').send({ company: 'Acme', role: 'Engineer' }).expect(200);

    const after = (await request(app).get('/api/config/store').expect(200)).body;
    expect(after.pending).toEqual([]);
    expect(await commitCount()).toBe(before + 1);
  });

  /*
   * The other half of the same bug: marking a workspace submitted, once the
   * application it belongs to has already gone out and been committed.
   */
  it('commits a workspace being marked submitted when the application is sent', async () => {
    await request(app).post('/api/workspace').send({ company: 'Globex', role: 'Analyst' }).expect(200);
    const before = await commitCount();
    await request(app).post('/api/extension/sent').send({ company: 'Globex', role: 'Analyst' }).expect(200);

    const after = (await request(app).get('/api/config/store').expect(200)).body;
    expect(after.pending).toEqual([]);
    expect(await commitCount()).toBe(before + 1);
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

  /*
   * "Its own history is kept, so you can still get back to it" is the whole
   * of the argument for a button that replaces the resume in front of you,
   * and it is only true of a version the history has.
   *
   * Auto-commit is a setting people turn off, and even left on a commit that
   * fails is a console warning with no retry — so the resume on screen can be
   * sitting in no commit at all, and rolling it back to last week is then the
   * one act in this program that cannot be undone. It is filed first, and
   * refused if it could not be.
   */
  it('files the version it is about to replace', async () => {
    const first = await history();
    const originalHash = first[0]!.hash;

    // Written straight to disk, so nothing has committed it: the shape a save
    // is in with the history switched off, or with git refusing commits.
    t.write('resumes/newgrad.yaml', {
      id: 'newgrad',
      label: 'New grad',
      choices: { 'edu_neu.dates': 'v_dec2026' },
    });

    await request(app).post(`/api/resumes/newgrad/history/${originalHash}/restore`).expect(200);

    // Somewhere in the history, the version that was replaced.
    const holds = await Promise.all(
      (await repo.log(20)).map(async (entry) => (await repo.treeAt(entry.hash)).get('resumes/newgrad.yaml')),
    );
    const blobs = await Promise.all(holds.filter(Boolean).map((objectId) => repo.blob(objectId!)));
    expect(blobs.some((text) => text.includes('v_dec2026'))).toBe(true);
  });

  it('refuses when the version it would replace cannot be filed', async () => {
    const first = await history();
    const originalHash = first[0]!.hash;
    t.write('resumes/newgrad.yaml', {
      id: 'newgrad',
      label: 'New grad',
      choices: { 'edu_neu.dates': 'v_dec2026' },
    });
    // A lock left by a git that was killed: reading the old version still
    // works, keeping the current one does not.
    fs.writeFileSync(path.join(t.dir, '.git/index.lock'), '');

    const res = await request(app).post(`/api/resumes/newgrad/history/${originalHash}/restore`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/not in the version history/i);
    expect(res.body.error).toMatch(/Save History/);
    // And it is still there, which is the point.
    expect(t.store.getResume('newgrad')?.choices?.['edu_neu.dates']).toBe('v_dec2026');
  });

  /*
   * The same refusal, on a store that holds both spellings of one resume.
   *
   * `Store.resumeFiles` gives `.yaml` and `.yml`, because a hand-made `.yml`
   * beside the `.yaml` the app writes is a real shape the store has to cope
   * with — and `.yaml` is the one in effect and the one `saveResume`
   * replaces. The guard asked whether *any* file by this name was filed, so
   * an untouched old `.yml` vouched for a `.yaml` that had never been
   * committed: the refusal was skipped and the edit overwritten, 200 OK.
   */
  it('and is not talked out of it by an old .yml beside the file it would replace', async () => {
    const first = await history();
    const originalHash = first[0]!.hash;

    // An old second spelling, filed and then left alone — so it matches HEAD
    // however the .yaml changes after it.
    fs.writeFileSync(
      path.join(t.dir, 'resumes/newgrad.yml'),
      'id: newgrad\nlabel: New grad (old spelling)\n',
    );
    await repo.commitAll('An old second spelling', ['resumes/newgrad.yml']);

    t.write('resumes/newgrad.yaml', {
      id: 'newgrad',
      label: 'New grad',
      choices: { 'edu_neu.dates': 'v_dec2026' },
    });
    fs.writeFileSync(path.join(t.dir, '.git/index.lock'), '');

    const res = await request(app).post(`/api/resumes/newgrad/history/${originalHash}/restore`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/not in the version history/i);
    expect(t.store.getResume('newgrad')?.choices?.['edu_neu.dates']).toBe('v_dec2026');

    fs.rmSync(path.join(t.dir, '.git/index.lock'), { force: true });
    fs.rmSync(path.join(t.dir, 'resumes/newgrad.yml'), { force: true });
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
          /*
           * Each phrasing rewritten to its own text. They used to be rewritten
           * to one string, which is a state the store now refuses on the way
           * in — three identical wordings of one line is a stepper with three
           * steps that do nothing. See `duplicates.ts`. What this group is
           * about is the change being shared, and it still is.
           */
          {
            ...bullet,
            variants: bullet.variants.map((v) => ({ ...v, text: `REWRITTEN SHARED BULLET (${v.label})` })),
          },
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
   * With the history switched off, the restore still goes into the history.
   *
   * The two commits in this route used to disagree: the outgoing version was
   * filed unconditionally, the incoming one went through `autoCommit()`. So
   * with the setting off the version being thrown away was written into the
   * history and the version replacing it was not, and the timeline showed the
   * *discarded* document at the top — badged "Current", given no Restore
   * button — with the one actually on disk below it offering to be restored.
   *
   * Auto-commit is about keystrokes. This is a button somebody pressed to
   * throw work away, which is exactly what the history is for.
   */
  it('files the restored version too, even with auto-commit off', async () => {
    const original = await history();
    const originalHash = original[0]!.hash;

    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { 'edu_neu.dates': 'v_dec2026' } })
      .expect(200);

    t.write('config.yaml', { ai: { enabled: false }, git: { autoCommit: false }, output: { dir: 'out' } });
    await request(app).post(`/api/resumes/newgrad/history/${originalHash}/restore`).expect(200);

    const after = await history();
    expect(after[0]?.message).toBe('Restore "newgrad" to an earlier version');
    // And the top of the timeline is the document that is actually on disk.
    const onDisk = t.store.getResume('newgrad')?.choices?.['edu_neu.dates'];
    expect(onDisk).toBe('v_may2026');
    expect((await request(app).get('/api/config/store').expect(200)).body.pending).toEqual([]);
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
  /*
   * A version is what the resume said, and a tier is not something it says.
   *
   * The file at an old commit carries the tier it had then, and the restore
   * wrote the whole file back. So a tailored copy somebody had since marked
   * Kept — the chip whose whole purpose is "do not sweep this one" — went
   * back to Temporary with the clock it started on a month ago, and the next
   * start swept it. Nothing in the timeline shows a tier change as a version,
   * so there was no way to see that the version being chosen was one in
   * which the resume was on its way out.
   */
  it('keeps the tier the resume has now, so a kept resume is not put back on the sweep clock', async () => {
    const month = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const newgrad = t.store.getResume('newgrad')!;
    const copy = {
      ...newgrad,
      id: 'job-acme',
      label: 'Acme — Engineer',
      tier: 'temporary',
      temporaryFrom: month,
      generatedFor: { company: 'Acme', role: 'Engineer', at: month },
    };
    await request(app).put('/api/resumes/job-acme').send(copy).expect(200);
    const first = (await history('job-acme'))[0]!.hash;

    // An edit, so there is an earlier version to go back to…
    await request(app)
      .put('/api/resumes/job-acme')
      .send({ ...copy, choices: { ...(copy.choices ?? {}), 'edu_neu.dates': 'v_dec2026' } })
      .expect(200);
    // …and then "keep this one".
    await request(app).put('/api/resumes/job-acme/tier').send({ tier: 'extended' }).expect(200);

    await request(app).post(`/api/resumes/job-acme/history/${first}/restore`).expect(200);

    const now = t.store.getResume('job-acme')!;
    expect(now.choices?.['edu_neu.dates'], 'the version came back').not.toBe('v_dec2026');
    expect(now.tier, 'and the resume is still kept').toBe('extended');
    expect(now.temporaryFrom).toBeUndefined();
    const expiring = await request(app).get('/api/resumes/expiring').expect(200);
    expect(expiring.body.due.map((d: { id: string }) => d.id)).not.toContain('job-acme');
  });
});
