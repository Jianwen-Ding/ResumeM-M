import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, createPdfRouter, createCurrentRouter } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import type { Entry } from '../src/model/types.js';
import { hasLatex, makeTempStore, type TempStore } from './helpers.js';

const latex = await hasLatex();

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  // Auto-commit is off in the fixture config, so no git repo is needed.
  const repo = Repo.forStore(t.dir);
  app = express();
  app.use('/api', createApi({ store: t.store, repo }));
  app.use('/pdf', createPdfRouter(t.store));
  app.use('/current', createCurrentRouter(t.store));
});
afterEach(() => t.cleanup());

const JOB_HTML = `<html><head><title>SWE Intern at Streamly</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting","title":"Data Platform Intern",
"hiringOrganization":{"@type":"Organization","name":"Streamly"},
"description":"<p>Kafka streaming infrastructure in Go and Python, Kubernetes on AWS. Responsibilities include distributed systems. Minimum qualifications: BS in Computer Science. Apply now. Equal opportunity employer.</p>"}
</script></head><body>Apply now</body></html>`;

/* ------------------------------------------------------------------ */

describe('reads', () => {
  it('returns the whole store, with the AI command withheld', async () => {
    const res = await request(app).get('/api/store').expect(200);
    expect(res.body.profile.name).toBe('Test Person');
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.config.ai).toEqual({ enabled: false });
    expect(res.body.config.ai.command).toBeUndefined();
  });

  it('lists resumes', async () => {
    const res = await request(app).get('/api/resumes').expect(200);
    expect(res.body.map((r: { id: string }) => r.id).sort()).toEqual(['base', 'intern', 'newgrad']);
  });

  it('resolves a resume', async () => {
    const res = await request(app).get('/api/resumes/intern/resolved').expect(200);
    const education = res.body.sections.find((s: { kind: string }) => s.kind === 'education');
    expect(education.entries[0].dates).toContain('Dec. 2026');
  });

  it('reports a resume that does not exist as a client error', async () => {
    const res = await request(app).get('/api/resumes/ghost/resolved').expect(400);
    expect(res.body.error).toMatch(/ghost/);
  });

  it('returns voice notes', async () => {
    const res = await request(app).get('/api/voice').expect(200);
    expect(res.body.voice).toContain('Plain and direct');
  });

  it('returns cover letters', async () => {
    const res = await request(app).get('/api/letters').expect(200);
    expect(res.body[0].company).toBe('Acme Co.');
  });

  it('returns the git history, empty when the store is not a repo', async () => {
    const res = await request(app).get('/api/history').expect(200);
    expect(Array.isArray(res.body.commits)).toBe(true);
  });
});

describe('writes', () => {
  it('saves a resume under the id in the path', async () => {
    await request(app)
      .put('/api/resumes/custom')
      .send({ id: 'ignored', label: 'Custom', extends: 'base' })
      .expect(200);
    expect(t.store.getResume('custom')?.label).toBe('Custom');
    expect(t.store.getResume('ignored')).toBeUndefined();
  });

  it('deletes a resume', async () => {
    await request(app).delete('/api/resumes/intern').expect(200);
    expect(t.store.getResume('intern')).toBeUndefined();
  });

  it('saves the profile', async () => {
    await request(app).put('/api/profile').send({ name: 'Renamed' }).expect(200);
    expect(t.store.load().profile.name).toBe('Renamed');
  });

  it('saves and deletes entries', async () => {
    await request(app).put('/api/entries/exp_new').send({ kind: 'experience', title: 'New Co.' }).expect(200);
    expect(t.store.load().entries.map((e) => e.id)).toContain('exp_new');

    const res = await request(app).delete('/api/entries/exp_new').expect(200);
    expect(res.body.ok).toBe(true);
    expect((await request(app).delete('/api/entries/exp_new')).body.ok).toBe(false);
  });

  it('saves skills and voice notes', async () => {
    await request(app).put('/api/skills').send([{ id: 'sk_new', name: 'New', items: [] }]).expect(200);
    expect(t.store.load().skillGroups).toHaveLength(1);

    await request(app).put('/api/voice').send({ voice: 'Terse.' }).expect(200);
    expect(t.store.loadVoice()).toBe('Terse.');
  });

  it('saves a cover letter, defaulting the timestamp', async () => {
    await request(app).put('/api/letters/new-one').send({ title: 'New', body: 'Body' }).expect(200);
    const saved = t.store.loadCoverLetters().find((l) => l.id === 'new-one');
    expect(saved?.body).toContain('Body');
    expect(saved?.createdAt).toMatch(/^\d{4}-/);
  });
});

describe('adding a phrasing', () => {
  it('appends to the bullet and can select it immediately', async () => {
    const res = await request(app)
      .post('/api/entries/exp_acme/bullets/b_pipeline/variants')
      .send({ label: 'Terse', text: 'Built a pipeline.', tags: ['short'], makeDefault: true })
      .expect(200);

    expect(res.body.id).toBe('v_terse');
    const entry = t.store.load().entries.find((e) => e.id === 'exp_acme');
    const bullet = entry?.bullets?.find((b) => b.id === 'b_pipeline');
    expect(bullet?.variants).toHaveLength(4);
    expect(bullet?.default).toBe('v_terse');
  });

  it('rejects an empty phrasing', async () => {
    const res = await request(app)
      .post('/api/entries/exp_acme/bullets/b_pipeline/variants')
      .send({ label: 'Blank', text: '   ' })
      .expect(400);
    expect(res.body.error).toMatch(/needs text/);
  });

  it('rejects a duplicate id', async () => {
    const body = { id: 'v_dup', label: 'Dup', text: 'text' };
    await request(app).post('/api/entries/exp_acme/bullets/b_pipeline/variants').send(body).expect(200);
    const res = await request(app).post('/api/entries/exp_acme/bullets/b_pipeline/variants').send(body).expect(400);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('names a missing entry or bullet', async () => {
    expect(
      (await request(app).post('/api/entries/ghost/bullets/b/variants').send({ text: 'x' }).expect(400)).body.error,
    ).toMatch(/ghost/);
    expect(
      (await request(app).post('/api/entries/exp_acme/bullets/ghost/variants').send({ text: 'x' }).expect(400)).body
        .error,
    ).toMatch(/ghost/);
  });
});

describe('job analysis', () => {
  it('extracts the posting and proposes a tailored spec', async () => {
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ html: JOB_HTML, url: 'https://boards.greenhouse.io/streamly/jobs/1', baseResumeId: 'intern' })
      .expect(200);

    expect(res.body.isJobPosting).toBe(true);
    expect(res.body.job.company).toBe('Streamly');
    expect(res.body.job.keywords).toContain('kafka');
    expect(res.body.spec.extends).toBe('intern');
    expect(res.body.spec.choices.b_pipeline).toBe('v_kafka');
  });

  it('describes each change in words rather than ids', async () => {
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ html: JOB_HTML, baseResumeId: 'intern' })
      .expect(200);

    const change = res.body.rationale.find((r: { key: string }) => r.key === 'b_pipeline');
    expect(change.where).toBe('Acme Co.');
    expect(change.fromLabel).toBe('Neutral');
    expect(change.toLabel).toBe('Kafka');
    expect(change.toText).toContain('Kafka');
    expect(change.because).toContain('kafka');
  });

  it('maps bullets back to their entries for the suggestion flow', async () => {
    const res = await request(app).post('/api/extension/analyze').send({ html: JOB_HTML }).expect(200);
    expect(res.body.entryByBullet.b_pipeline).toBe('exp_acme');
  });

  it('refuses a request with no page', async () => {
    const res = await request(app).post('/api/extension/analyze').send({}).expect(400);
    expect(res.body.error).toMatch(/No page HTML/);
  });

  it('reports an unknown base resume', async () => {
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ html: JOB_HTML, baseResumeId: 'ghost' })
      .expect(400);
    expect(res.body.error).toMatch(/ghost/);
  });

  it('marks an ordinary page as not a posting', async () => {
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ html: '<html><body><h1>Bread</h1><p>Sourdough notes.</p></body></html>' })
      .expect(200);
    expect(res.body.isJobPosting).toBe(false);
  });

  /*
   * Tailoring is the feature and was never supposed to be compulsory. Both
   * modes altered the resume, so every proposal arrived with a list of
   * changes on it and no way to say "none of these, send what I have".
   */
  it('changes nothing at all when asked for nothing', async () => {
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ html: JOB_HTML, url: 'https://boards.greenhouse.io/streamly/jobs/1', baseResumeId: 'intern', tailor: 'none' })
      .expect(200);

    expect(res.body.tailor).toBe('none');
    // Still a spec of its own, so the folder and the history name the posting.
    expect(res.body.spec.extends).toBe('intern');
    expect(res.body.spec.generatedFor.company).toBe('Streamly');
    // And it selects nothing, so it resolves to exactly the base.
    expect(res.body.spec.choices).toEqual({});
    expect(res.body.diff).toEqual([]);
    expect(res.body.rationale).toEqual([]);
  });

  it('still matches by keyword when asked to', async () => {
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ html: JOB_HTML, baseResumeId: 'intern', tailor: 'match' })
      .expect(200);
    expect(res.body.tailor).toBe('match');
    expect(res.body.spec.choices.b_pipeline).toBe('v_kafka');
  });

  /*
   * The tracker reflected what you remembered to record, and nobody records
   * the last step: by the time the form is submitted the tab has already gone
   * to a confirmation page. The extension watching its own form being
   * submitted is the best evidence there is from outside the portal.
   */
  describe('noticing that an application went out', () => {
    const sent = (body: Record<string, unknown>) =>
      request(app).post('/api/extension/sent').send(body);

    it('records one that was never opened as a workspace', async () => {
      const res = await sent({ company: 'Quasar', role: 'Platform Engineer', url: 'https://quasar.example/apply' }).expect(200);
      expect(res.body.changed).toBe(true);
      expect(res.body.application).toMatchObject({ company: 'Quasar', role: 'Platform Engineer', status: 'applied' });
      expect(res.body.application.appliedAt).toBeTruthy();
      expect(res.body.application.history.at(-1).note).toMatch(/submitted/i);
    });

    it('moves one that was being worked on, and its draft with it', async () => {
      await request(app)
        .post('/api/workspace')
        .send({ company: 'Pulsar', role: 'Data Engineer', coverLetterRequired: true })
        .expect(200);
      const before = await request(app).get('/api/applications').expect(200);
      expect(before.body.applications.find((a: { company: string }) => a.company === 'Pulsar').status).toBe('applying');

      const res = await sent({ company: 'Pulsar', role: 'Data Engineer' }).expect(200);
      expect(res.body.application.status).toBe('applied');

      const drafts = await request(app).get('/api/workspace').expect(200);
      expect(drafts.body.drafts.find((d: { company: string }) => d.company === 'Pulsar').status).toBe('submitted');
    });

    /*
     * Only forwards. A form resubmitted after a reply came back must not drag
     * an application at `interview` back to `applied`, and one already sent
     * must not collect a second identical line of history.
     */
    it('never moves an application backwards, and does not repeat itself', async () => {
      await sent({ company: 'Vela', role: 'Backend Engineer' }).expect(200);
      const again = await sent({ company: 'Vela', role: 'Backend Engineer' }).expect(200);
      expect(again.body.changed).toBe(false);
      expect(again.body.application.history).toHaveLength(1);

      const id = again.body.application.id;
      await request(app).post(`/api/applications/${encodeURIComponent(id)}/status`).send({ status: 'interview' }).expect(200);
      const later = await sent({ company: 'Vela', role: 'Backend Engineer' }).expect(200);
      expect(later.body.changed).toBe(false);
      expect(later.body.application.status).toBe('interview');
    });

    /*
     * Midnight, which the suite found by running through it.
     *
     * An id carries the date it was made. An application opened before
     * midnight asks, on being sent, for an id with today's date on it — which
     * does not exist — so the send filed a second application of its own and
     * left the one being worked on at "applying" for ever. Three systems in a
     * row reported it before anyone noticed what the clock had done.
     */
    it('finds the application it opened yesterday', async () => {
      await request(app)
        .post('/api/workspace')
        .send({ company: 'Halcyon', role: 'Platform Engineer', coverLetterRequired: true })
        .expect(200);

      // Age both, exactly as a night does.
      const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
      const apps = t.store.load().applications.map((a) =>
        a.company === 'Halcyon' ? { ...a, id: a.id.replace(/^\d{4}-\d{2}-\d{2}/, yesterday.slice(0, 10)), appliedAt: yesterday } : a,
      );
      t.store.saveApplications(apps);
      const draft = t.store.loadDrafts().find((d) => d.company === 'Halcyon')!;
      t.store.deleteDraft(draft.id);
      t.store.saveDraft({ ...draft, id: draft.id.replace(/^\d{4}-\d{2}-\d{2}/, yesterday.slice(0, 10)) });

      const res = await sent({ company: 'Halcyon', role: 'Platform Engineer' }).expect(200);
      expect(res.body.changed).toBe(true);
      expect(res.body.application.status).toBe('applied');

      // One row, not two: the one that was already there.
      const after = t.store.load().applications.filter((a) => a.company === 'Halcyon');
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toContain(yesterday.slice(0, 10));
      expect(t.store.loadDrafts().filter((d) => d.company === 'Halcyon')).toHaveLength(1);
      expect(t.store.loadDrafts().find((d) => d.company === 'Halcyon')?.status).toBe('submitted');
    });

    it('needs to know which application it is', async () => {
      await sent({ company: 'Nobody' }).expect(400);
    });
  });

  /*
   * A mode it does not know used to behave as `match` and come back labelled
   * as whatever was asked for — a resume nobody asked for, wearing the name
   * of the one they did.
   */
  it('refuses a way of tailoring it does not have', async () => {
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ html: JOB_HTML, baseResumeId: 'intern', tailor: 'AI' })
      .expect(400);
    expect(res.body.error).toContain('none, match, ai');
  });

  it('reads the older useAi flag as the two modes it could express', async () => {
    const off = await request(app)
      .post('/api/extension/analyze')
      .send({ html: JOB_HTML, baseResumeId: 'intern', useAi: false })
      .expect(200);
    expect(off.body.tailor).toBe('match');
    expect(off.body.spec.choices.b_pipeline).toBe('v_kafka');
  });
});

describe('autofill', () => {
  it('returns profile fields and the answer bank', async () => {
    const res = await request(app).get('/api/autofill').expect(200);
    expect(res.body.fields.full_name).toBe('Test Person');
    expect(res.body.fields.email).toBe('test@example.com');
    expect(res.body.fields.school).toBe('Northeastern University');
    expect(res.body.answers).toHaveLength(2);
    expect(res.body.answers[0].answer).toBe('Because the work is interesting.');
  });
});

describe('answers', () => {
  it('matches page questions against the bank with no AI call', async () => {
    const res = await request(app)
      .post('/api/answers/match')
      .send({ questions: ['Why are you interested in this role?', 'What is your shoe size?'] })
      .expect(200);

    expect(res.body.matches[0].confident).toBe(true);
    expect(res.body.matches[0].answer).toBe('Because the work is interesting.');
    expect(res.body.matches[1].item).toBeUndefined();
    expect(res.body.bankSize).toBe(2);
  });

  it('rejects a request that is not a list', async () => {
    const res = await request(app).post('/api/answers/match').send({ questions: 'nope' }).expect(400);
    expect(res.body.error).toMatch(/must be an array/);
  });

  it('reuses a stored answer outright when one plainly covers the question', async () => {
    const res = await request(app)
      .post('/api/ai/answer')
      .send({ question: 'Why are you interested in this role?' })
      .expect(200);
    expect(res.body.source).toBe('answer-bank');
    expect(res.body.output).toBe('Because the work is interesting.');
  });

  it('falls through to the AI path when asked to redraft', async () => {
    const res = await request(app)
      .post('/api/ai/answer')
      .send({ question: 'Why are you interested in this role?', force: true })
      .expect(200);
    /*
     * The AI is off in the fixture, so the prompt comes back instead — under
     * `prompt`, not under `output`. `output` means "text you may use", and the
     * extension read it as exactly that: one click on "Draft an answer" put
     * nine kilobytes of prompt into the employer's form, carrying every cover
     * letter the user had saved and their whole writing corpus with it.
     */
    expect(res.body.source).toBe('prompt');
    expect(res.body.output).toBe('');
    expect(res.body.prompt).toContain('answer an application question');
  });

  it('saves a new question and a new phrasing of an existing one', async () => {
    await request(app).post('/api/answers/save').send({ question: 'New question?', answer: 'New answer' }).expect(200);
    let answers = t.store.load().answers;
    expect(answers).toHaveLength(3);

    await request(app)
      .post('/api/answers/save')
      .send({ itemId: 'ans_why', question: 'Why are you interested in this role?', answer: 'A sharper answer', label: 'Sharper' })
      .expect(200);
    answers = t.store.load().answers;
    const why = answers.find((a) => a.id === 'ans_why');
    expect(why?.variants).toHaveLength(2);
    expect(why?.variants.at(-1)?.text).toBe('A sharper answer');
    expect(why?.default).toBe(why?.variants.at(-1)?.id);
  });

  it('rejects an incomplete save', async () => {
    await request(app).post('/api/answers/save').send({ question: 'Q' }).expect(400);
    await request(app).post('/api/answers/save').send({ answer: 'A' }).expect(400);
  });
});

describe('cover letters', () => {
  it('returns the relevant previous letters even with the AI off', async () => {
    const res = await request(app)
      .post('/api/ai/cover-letter')
      .send({ resumeId: 'newgrad', job: { company: 'Acme Co.', jobTitle: 'Intern', jobDescription: 'work' } })
      .expect(200);

    expect(res.body.executed).toBe(false);
    expect(res.body.body).toBe('');
    expect(res.body.priorLetters).toHaveLength(1);
    expect(res.body.priorLetters[0].company).toBe('Acme Co.');
  });

  it('does not save an empty draft', async () => {
    await request(app)
      .post('/api/ai/cover-letter')
      .send({ resumeId: 'newgrad', job: { jobDescription: 'x' }, save: true })
      .expect(200);
    expect(t.store.loadCoverLetters()).toHaveLength(1);
  });
});

describe('feedback', () => {
  it('returns the resume prompt when the AI is off', async () => {
    const res = await request(app).post('/api/ai/feedback').send({ resumeId: 'newgrad' }).expect(200);
    expect(res.body.executed).toBe(false);
    expect(res.body.output).toContain('critique, do not rewrite');
  });

  it('reviews the full master without a resume selection, even when no saved resumes exist', async () => {
    for (const resume of t.store.loadResumes()) t.store.deleteResume(resume.id);
    const res = await request(app).post('/api/ai/feedback').send({ master: true, focus: 'outcomes' }).expect(200);
    expect(res.body.executed).toBe(false);
    expect(res.body.output).toContain('MASTER DOCUMENT');
    expect(res.body.output).toContain('variant:v_kafka');
    expect(res.body.output).toContain('variant:v_short');
    expect(res.body.output).toContain('automatically compiles smaller, tailored resumes');
    expect(res.body.output).toContain('no one-page limit');
    expect(res.body.output).toContain('outcomes');
  });

  it('returns master feedback through the existing background results flow', async () => {
    const result = await request(app).post('/api/ai/feedback').send({ master: true, background: true }).expect(200);
    expect(result.body.job.about).toBe('Master Document');
    let job = result.body.job;
    for (let i = 0; i < 40 && job.status === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      job = (await request(app).get(`/api/ai/jobs/${job.id}`).expect(200)).body;
    }
    expect(job.status).toBe('done');
    expect(job.result.output).toContain('MASTER DOCUMENT');
  });

  it('rejects conflicting feedback targets instead of critiquing the wrong document', async () => {
    await request(app).post('/api/ai/feedback').send({ master: true, resumeId: 'newgrad' }).expect(400);
  });

  it('returns a bullet-specific prompt when given one', async () => {
    const res = await request(app)
      .post('/api/ai/feedback')
      .send({ entryId: 'exp_acme', bulletId: 'b_pipeline' })
      .expect(200);
    expect(res.body.output).toContain('critique one bullet');
  });

  it('reviews a whole entry through background feedback without requiring a bullet', async () => {
    const result = await request(app).post('/api/ai/feedback')
      .send({ entryId: 'exp_acme', background: true }).expect(200);
    expect(result.body.job.about).toBe('Entry: Acme Co.');
    let job = result.body.job;
    for (let i = 0; i < 30 && job.status === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      job = (await request(app).get(`/api/ai/jobs/${job.id}`).expect(200)).body;
    }
    expect(job.status).toBe('done');
    expect(job.result.output).toContain('critique one complete entry, do not rewrite');
    const source = job.result.output.split('## Complete source entry [exp_acme]\n')[1];
    const entry = JSON.parse(source) as Entry;
    expect(entry.subtitle).toBe('Software Engineer Co-op');
    expect(entry.bullets!.map(b => b.id)).toEqual(['b_pipeline', 'b_testing']);
    expect(entry.bullets![0]!.variants.map(v => v.id)).toEqual(['v_base', 'v_kafka', 'v_short']);
    await request(app).post('/api/ai/feedback').send({ entryId: 'missing-entry' }).expect(400);
  });

  it('reports a bullet that does not exist', async () => {
    const res = await request(app)
      .post('/api/ai/feedback')
      .send({ entryId: 'exp_acme', bulletId: 'ghost' })
      .expect(400);
    expect(res.body.error).toMatch(/ghost/);
  });

  it('critiques the exact selected phrasing with its shared-source context', async () => {
    const res = await request(app).post('/api/ai/feedback')
      .send({ entryId: 'exp_acme', bulletId: 'b_pipeline', variantId: 'v_short' }).expect(200);
    expect(res.body.output).toContain('critique one phrasing');
    expect(res.body.output).toContain('## Selected phrase [exp_acme/b_pipeline/v_short]\nBuilt a pipeline\n');
    expect(res.body.output).toContain('automatically compiles smaller, tailored resumes');
  });

  it('reviews heading wording and rejects absent or ambiguous phrase targets', async () => {
    const res = await request(app).post('/api/ai/feedback')
      .send({ entryId: 'exp_acme', fieldName: 'subtitle' }).expect(200);
    expect(res.body.output).toContain('## Selected phrase [exp_acme.subtitle]\nSoftware Engineer Co-op');
    for (const target of [
      { entryId: 'exp_acme', bulletId: 'b_pipeline', variantId: 'ghost' },
      { entryId: 'exp_acme', fieldName: 'subtitle', variantId: 'ghost' },
      { entryId: 'exp_acme', fieldName: 'unknown' },
      { entryId: 'exp_acme', bulletId: 'b_pipeline', fieldName: 'subtitle' },
      { entryId: 'exp_acme', bulletId: 'b_pipeline', resumeId: 'newgrad' },
      { variantId: 'v_short' },
    ]) await request(app).post('/api/ai/feedback').send(target).expect(400);
  });

  it('returns phrase feedback in a background job', async () => {
    const result = await request(app).post('/api/ai/feedback')
      .send({ entryId: 'exp_acme', bulletId: 'b_pipeline', variantId: 'v_short', background: true }).expect(200);
    let job = result.body.job;
    for (let i = 0; i < 30 && job.status === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      job = (await request(app).get(`/api/ai/jobs/${job.id}`).expect(200)).body;
    }
    expect(job.status).toBe('done');
    expect(job.about).toContain('Short');
    expect(job.result.output).toContain('critique one phrasing');
  });

  it('returns the tailor prompt unparsed when the AI is off', async () => {
    const res = await request(app)
      .post('/api/ai/tailor')
      .send({ resumeId: 'newgrad', job: { jobDescription: 'Kafka' } })
      .expect(200);
    expect(res.body.parsed).toBeNull();
  });

  it('returns a shortening prompt naming the bullets', async () => {
    const res = await request(app).post('/api/ai/shorten').send({ resumeId: 'newgrad', linesToCut: 2 }).expect(200);
    expect(res.body.output).toContain('2 line(s) too long');
    expect(res.body.output).toContain('b_pipeline');
  });
});

describe('tracking', () => {
  it('records, lists, advances, and removes an application', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ company: 'Streamly', role: 'Intern', url: 'https://x' })
      .expect(200);
    expect(created.body.status).toBe('applied');
    expect(created.body.history).toHaveLength(1);

    const list = await request(app).get('/api/applications').expect(200);
    expect(list.body.applications).toHaveLength(1);
    expect(list.body.stats.total).toBe(1);

    const advanced = await request(app)
      .post(`/api/applications/${created.body.id}/status`)
      .send({ status: 'interview', note: 'call booked' })
      .expect(200);
    expect(advanced.body.status).toBe('interview');

    await request(app).delete(`/api/applications/${created.body.id}`).expect(200);
    expect(t.store.load().applications).toHaveLength(0);
  });

  it('requires a company and a role', async () => {
    const res = await request(app).post('/api/applications').send({ company: 'Only' }).expect(400);
    expect(res.body.error).toMatch(/required/);
  });

  it('reports removing an application that is not there', async () => {
    const res = await request(app).delete('/api/applications/ghost').expect(400);
    expect(res.body.error).toMatch(/ghost/);
  });
});

describe.skipIf(!latex)('letter rendering', { timeout: 180_000 }, () => {
  it('typesets a cover letter and serves the PDF', async () => {
    const res = await request(app)
      .post('/api/render/letter')
      .send({ body: 'I would like to work on ingest.', company: 'Streamly', role: 'Intern', resumeId: 'newgrad' })
      .expect(200);

    expect(res.body.pages).toBe(1);
    expect(res.body.fits).toBe(true);
    expect(res.body.pdfUrl).toMatch(/^\/pdf\/letter-streamly\.pdf/);

    const name = res.body.pdfUrl.split('/').pop().split('?')[0];
    const pdf = await request(app).get(`/pdf/${name}`).expect(200);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('renders an empty letter rather than failing on one', async () => {
    const res = await request(app).post('/api/render/letter').send({ company: 'Streamly' }).expect(200);
    expect(res.body.pages).toBe(1);
  });
});

describe('application detail', () => {
  it('combines the application, its resume, and its cover letter in one view', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ company: 'Streamly', role: 'Intern', url: 'https://x', resumeId: 'newgrad' })
      .expect(200);

    const detail = await request(app).get(`/api/applications/${created.body.id}`).expect(200);
    expect(detail.body.application.id).toBe(created.body.id);
    expect(detail.body.resume?.id).toBe('newgrad');
    expect(detail.body.letter).toBeNull();
    expect(detail.body.files).toEqual([]);
  });

  it('falls back to an inline cover letter when no saved letter record exists', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ company: 'Streamly', role: 'Intern', url: 'https://x' })
      .expect(200);
    t.store.saveApplications(
      t.store.load().applications.map((a) => (a.id === created.body.id ? { ...a, coverLetter: 'Dear team,' } : a)),
    );

    const detail = await request(app).get(`/api/applications/${created.body.id}`).expect(200);
    expect(detail.body.letter).toEqual({ id: null, body: 'Dear team,', title: 'As sent' });
  });

  it('404s in spirit — 400s — for an application that does not exist', async () => {
    const res = await request(app).get('/api/applications/ghost').expect(400);
    expect(res.body.error).toMatch(/ghost/);
  });
});

describe.skipIf(!latex)('rendering', { timeout: 180_000 }, () => {
  it('compiles a stored resume and reports the fit', async () => {
    const res = await request(app).post('/api/render').send({ resumeId: 'newgrad' }).expect(200);
    expect(res.body.pages).toBe(1);
    expect(res.body.fits).toBe(true);
    expect(res.body.pdfUrl).toMatch(/^\/pdf\/newgrad\.pdf/);
  });

  it('compiles an unsaved spec, so a preview goes through the same path', async () => {
    const res = await request(app)
      .post('/api/render')
      .send({ spec: { id: 'preview', label: 'Preview', extends: 'base', choices: { b_pipeline: 'v_kafka' } } })
      .expect(200);
    expect(res.body.fits).toBe(true);
  });

  it('compiles the master document', async () => {
    const res = await request(app).post('/api/render').send({ master: true }).expect(200);
    expect(res.body.pdfUrl).toContain('master.pdf');
  });

  it('allows a master beyond two pages without shrinking or rejecting it', async () => {
    const entry = t.store.load().entries.find(e => e.id === 'exp_acme')!;
    entry.bullets = Array.from({ length: 85 }, (_, i) => ({
      id: `long_${i}`, default: 'v_base', variants: [{ id: 'v_base', label: 'Default',
        text: `Implemented source capability ${i}, validating incoming records and documenting reproducible measurements for future tailored resumes.` }],
    }));
    t.store.saveEntry(entry);
    const res = await request(app).post('/api/render').send({ master: true, strict: true }).expect(200);
    expect(res.body.pages).toBeGreaterThan(2);
    expect(res.body.fits).toBe(true);
    expect(res.body.adjustments).toEqual([]);
  });

  it('returns 422 with a report when strict mode cannot fit the page', async () => {
    const res = await request(app)
      .post('/api/render')
      .send({
        strict: true,
        spec: { id: 'tiny', label: 'Tiny', extends: 'base', layout: { marginIn: 4.6, autoFit: false } },
      })
      .expect(422);
    expect(res.body.kind).toBe('overflow');
    expect(res.body.report.overflowLines).toBeGreaterThan(0);
  });

  it('serves the compiled PDF and 404s for anything else', async () => {
    await request(app).post('/api/render').send({ resumeId: 'newgrad' }).expect(200);
    const pdf = await request(app).get('/pdf/newgrad.pdf').expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    await request(app).get('/pdf/nothing-here.pdf').expect(404);
  });

  it('refuses to serve a path outside the output directory', async () => {
    await request(app).get('/pdf/..%2F..%2Fetc%2Fpasswd').expect(404);
  });

  it('builds a bundle, saving a posting-specific spec first', async () => {
    const res = await request(app)
      .post('/api/applications/bundle')
      .send({
        company: 'Streamly',
        role: 'Data Platform Intern',
        spec: { id: 'job-streamly', label: 'Streamly', extends: 'intern', choices: { b_pipeline: 'v_kafka' } },
      })
      .expect(200);

    expect(res.body.files[0]).toBe('Test-Person-Resume.pdf');
    expect(t.store.getResume('job-streamly')).toBeDefined();
    expect(fs.existsSync(path.join(res.body.dir, 'source', 'resolved.yaml'))).toBe(true);
  });
});

describe('settings', () => {
  it('returns the AI, engine, and git settings', async () => {
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.ai.command).toBe('claude');
    expect(res.body.ai.enabled).toBe(false);
    expect(res.body.git.autoCommit).toBe(false);
    expect(res.body.overrides).toBeDefined();
  });

  it('saves a patch without clobbering the sections it does not mention', async () => {
    await request(app)
      .put('/api/config')
      .send({ ai: { enabled: true, command: 'codex' } })
      .expect(200);

    const after = t.store.loadConfig();
    expect(after.ai.command).toBe('codex');
    expect(after.ai.enabled).toBe(true);
    // Untouched sections survive.
    expect(after.output.dir).toBe('out');
  });

  it('reports the AI as off rather than pretending to test it', async () => {
    const res = await request(app).post('/api/config/test-ai').expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe('disabled');
  });

  it('runs the configured command when the AI is on', async () => {
    await request(app)
      .put('/api/config')
      .send({
        ai: {
          enabled: true,
          command: process.execPath,
          args: ['-e', 'process.stdout.write("ready")', '{prompt}'],
        },
      })
      .expect(200);

    const res = await request(app).post('/api/config/test-ai').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.output).toBe('ready');
  });

  it('reports a command that fails, rather than throwing', async () => {
    await request(app)
      .put('/api/config')
      .send({ ai: { enabled: true, command: 'not-a-real-command-zzz', args: ['{prompt}'] } })
      .expect(200);

    const res = await request(app).post('/api/config/test-ai').expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/not found/);
  });
});

describe('history detail', () => {
  it('rejects anything that is not a commit hash', async () => {
    const res = await request(app).get('/api/history/not-a-hash!!').expect(400);
    expect(res.body.error).toMatch(/not a commit hash/);
  });

  it('reports a hash that is not in the history', async () => {
    const res = await request(app).get('/api/history/abcdef1').expect(400);
    expect(res.body.error).toMatch(/No commit/);
  });
});

describe('list bullets', () => {
  beforeEach(async () => {
    await request(app)
      .put('/api/entries/edu_neu')
      .send({
        ...t.store.load().entries.find((e) => e.id === 'edu_neu'),
        bullets: [
          {
            id: 'b_course',
            default: 'v_list',
            prefix: '**Coursework:**',
            variants: [],
            items: [
              { id: 'c_algo', text: 'Algorithms' },
              { id: 'c_os', text: 'Operating Systems' },
              { id: 'c_db', text: 'Databases' },
            ],
          },
        ],
      })
      .expect(200);
  });

  it('shows every item when the resume selects none', async () => {
    const res = await request(app).get('/api/resumes/newgrad/resolved').expect(200);
    const bullet = res.body.sections[0].entries[0].bullets[0];
    expect(bullet.text).toBe('**Coursework:** Algorithms, Operating Systems, Databases');
  });

  it('shows only the selected items, in the order the resume gives', async () => {
    // Order is explicit, the same way section entries and bullets are: the
    // list in the spec is the order that prints.
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', lists: { b_course: ['c_db', 'c_algo'] } })
      .expect(200);

    const res = await request(app).get('/api/resumes/newgrad/resolved').expect(200);
    const bullet = res.body.sections[0].entries[0].bullets[0];
    expect(bullet.text).toBe('**Coursework:** Databases, Algorithms');
  });

  it('drops the bullet entirely when nothing is selected', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', lists: { b_course: [] } })
      .expect(200);

    const res = await request(app).get('/api/resumes/newgrad/resolved').expect(200);
    expect(res.body.sections[0].entries[0].bullets).toHaveLength(0);
  });

  it('warns about an item that no longer exists', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', lists: { b_course: ['c_algo', 'c_ghost'] } })
      .expect(200);

    const res = await request(app).get('/api/resumes/newgrad/resolved').expect(200);
    expect(res.body.warnings.join(' ')).toMatch(/c_ghost/);
  });
});

describe('workspace', () => {
  const open = (patch: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/workspace')
      .send({
        company: 'Streamly',
        role: 'Data Platform Intern',
        url: 'https://boards.greenhouse.io/streamly/jobs/1',
        jobDescription: 'Kafka streaming in Go.',
        resumeId: 'intern',
        coverLetterRequired: true,
        questions: [
          { question: 'Why are you interested in this role?', required: true },
          { question: 'Describe a technical project you are proud of.', required: true },
        ],
        ...patch,
      });

  it('tracks the application as "applying" the moment a workspace opens', async () => {
    await open().expect(200);

    const { body } = await request(app).get('/api/applications').expect(200);
    const tracked = body.applications.find((a: { company: string }) => a.company === 'Streamly');
    expect(tracked.status).toBe('applying');
    expect(tracked.history[0].note).toBe('Workspace opened');

    // Not sent, so it cannot drag the response rate down.
    expect(body.stats.responseRate).toBe(0);
    expect(body.stats.byStatus.applying).toBe(1);
  });

  it('does not overwrite an application that is already being tracked', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ company: 'Streamly', role: 'Data Platform Intern', status: 'interview' })
      .expect(200);

    await open().expect(200);
    const { body } = await request(app).get('/api/applications').expect(200);
    const tracked = body.applications.find((a: { id: string }) => a.id === created.body.id);
    expect(tracked.status).toBe('interview'); // left alone
  });

  it('pre-fills what the answer bank already covers', async () => {
    const res = await open().expect(200);
    const draft = res.body.draft;

    expect(draft.company).toBe('Streamly');
    expect(draft.coverLetter.required).toBe(true);
    expect(draft.questions).toHaveLength(2);

    const known = draft.questions.find((q: { question: string }) => q.question.startsWith('Why'));
    expect(known.source).toBe('bank');
    expect(known.answer).toBe('Because the work is interesting.');

    const unknown = draft.questions.find((q: { question: string }) => q.question.startsWith('Describe'));
    expect(unknown.source).toBe('empty');
    expect(unknown.answer).toBe('');
  });

  it('returns a link straight to the draft', async () => {
    const res = await open().expect(200);
    expect(res.body.url).toBe(`/#workspace/${res.body.draft.id}`);
  });

  it('requires a company and a role', async () => {
    await request(app).post('/api/workspace').send({ company: 'Only' }).expect(400);
  });

  it('saves a posting-specific resume that arrives with the draft', async () => {
    const res = await open({
      spec: { id: 'job-streamly', label: 'Streamly', extends: 'intern', choices: { b_pipeline: 'v_kafka' } },
    }).expect(200);
    expect(t.store.getResume('job-streamly')).toBeDefined();
    expect(res.body.draft.resumeId).toBe('job-streamly');
  });

  it('never overwrites an answer a human has written', async () => {
    const first = await open().expect(200);
    const draft = first.body.draft;
    draft.questions[1].answer = 'My own words.';
    draft.questions[1].edited = true;
    await request(app).put(`/api/workspace/${draft.id}`).send(draft).expect(200);

    // The extension sends the same posting again — a page reload, say.
    const second = await open().expect(200);
    const q = second.body.draft.questions.find((x: { question: string }) => x.question.startsWith('Describe'));
    expect(q.answer).toBe('My own words.');
  });

  it('lists and fetches drafts, and reports one that is gone', async () => {
    const { body } = await open().expect(200);
    const list = await request(app).get('/api/workspace').expect(200);
    expect(list.body.drafts).toHaveLength(1);

    await request(app).get(`/api/workspace/${body.draft.id}`).expect(200);
    await request(app).delete(`/api/workspace/${body.draft.id}`).expect(200);
    await request(app).get(`/api/workspace/${body.draft.id}`).expect(400);
    await request(app).delete(`/api/workspace/${body.draft.id}`).expect(400);
  });

  /*
   * A sent space is not a closed one, and not a permanent one either.
   *
   * It stays listed so the follow-up question, or the portal that rejected the
   * upload, opens the thing that was written rather than a snapshot of it —
   * and it lets itself out a fortnight later so the Workspace stays a list of
   * live work instead of becoming a second, worse tracker.
   */
  it('keeps a sent workspace, and lets it go once it is a fortnight stale', async () => {
    const { body } = await open().expect(200);
    const id = body.draft.id;
    const age = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    /*
     * Aged on disk, because `saveDraft` stamps `updatedAt` with now — which is
     * the whole point of the field: the clock this counts is the last time
     * anything was written, not a date anyone can set.
     */
    const sent = t.store.getDraft(id)!;
    const leave = (status: string, days: number) => {
      const file = path.join(t.dir, 'drafts', `${id}.yaml`);
      t.store.saveDraft({ ...sent, status: status as typeof sent.status });
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/updatedAt:.*/, `updatedAt: "${age(days)}"`), 'utf8');
    };

    leave('submitted', 3);
    let list = await request(app).get('/api/workspace').expect(200);
    expect(list.body.drafts.map((d: { id: string }) => d.id)).toContain(id);

    // Still being written, and old: that is somebody's unfinished application,
    // not litter.
    leave('drafting', 400);
    list = await request(app).get('/api/workspace').expect(200);
    expect(list.body.drafts.map((d: { id: string }) => d.id)).toContain(id);

    leave('submitted', 15);
    list = await request(app).get('/api/workspace').expect(200);
    expect(list.body.drafts).toHaveLength(0);
  });

  it('falls back to the closest previous letter when the AI is off', async () => {
    const { body } = await open().expect(200);
    const res = await request(app)
      .post(`/api/workspace/${body.draft.id}/generate`)
      .send({ what: 'letter' })
      .expect(200);

    expect(res.body.draft.coverLetter.body).toContain('letter I wrote before');
    expect(res.body.notes.join(' ')).toMatch(/AI is off/);
  });

  it('leaves an edited letter alone when generating', async () => {
    const { body } = await open().expect(200);
    const draft = body.draft;
    draft.coverLetter.body = 'Mine.';
    draft.coverLetter.edited = true;
    await request(app).put(`/api/workspace/${draft.id}`).send(draft).expect(200);

    const res = await request(app).post(`/api/workspace/${draft.id}/generate`).send({ what: 'letter' }).expect(200);
    expect(res.body.draft.coverLetter.body).toBe('Mine.');
    expect(res.body.notes.join(' ')).toMatch(/left alone/);
  });

  it('reports how many questions still need an answer', async () => {
    const { body } = await open().expect(200);
    const res = await request(app)
      .post(`/api/workspace/${body.draft.id}/generate`)
      .send({ what: 'questions' })
      .expect(200);
    expect(res.body.notes.join(' ')).toMatch(/1 of 2 questions/);
  });

  it('reports a draft that does not exist', async () => {
    await request(app).post('/api/workspace/ghost/generate').send({}).expect(400);
    await request(app).post('/api/workspace/ghost/complete').send({}).expect(400);
    await request(app).put('/api/workspace/ghost').send({}).expect(400);
  });

  /*
   * Generating is the longest wait in the product: one AI run for the letter
   * and one for every empty answer, minutes end to end. Nobody sits still for
   * it — they write the notes, or the answer the AI is not being asked for, and
   * the Workspace saves that as they type.
   *
   * The handler read the draft before the wait and wrote the whole object back
   * after it, so the reply restored the draft to what it held when the button
   * was pressed. Everything typed during the wait went, silently, at the exact
   * moment the screen filled up with the thing that had been asked for.
   *
   * The AI here is a real child process that stops until the test releases it,
   * so the write during the wait is a genuinely concurrent one.
   */
  it('keeps what was typed while the AI was running', async () => {
    const started = path.join(t.dir, 'agent-started');
    const release = path.join(t.dir, 'agent-release');
    await request(app)
      .put('/api/config')
      .send({
        ai: {
          enabled: true,
          command: process.execPath,
          args: [
            '-e',
            `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'1');` +
              `const w=new Int32Array(new SharedArrayBuffer(4));` +
              `while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(w,0,0,10);` +
              `process.stdout.write('Dear Streamly, the AI wrote this.')`,
            '{prompt}',
          ],
          timeoutMs: 20_000,
        },
      })
      .expect(200);

    const { body } = await open().expect(200);
    const id = body.draft.id;

    // `.then()` is what dispatches a supertest request; holding the builder
    // alone would leave it unsent until the await below.
    const generating = request(app).post(`/api/workspace/${id}/generate`).send({ what: 'all' }).then((r) => r);

    // Wait for the AI to be genuinely mid-run before typing anything.
    await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true), { timeout: 10_000 });

    const mine = { ...t.store.getDraft(id)!, notes: 'Referred by Dana on the platform team.' };
    mine.questions[1] = { ...mine.questions[1]!, answer: 'The ingest rewrite.', source: 'human', edited: true };
    await request(app).put(`/api/workspace/${id}`).send(mine).expect(200);

    fs.writeFileSync(release, '1');
    const res = await generating;
    expect(res.status).toBe(200);

    // Everything typed during the wait is still there…
    expect(res.body.draft.notes).toBe('Referred by Dana on the platform team.');
    expect(res.body.draft.questions[1].answer).toBe('The ingest rewrite.');
    expect(t.store.getDraft(id)!.notes).toBe('Referred by Dana on the platform team.');

    // …and so is the work that was waited for.
    expect(res.body.draft.coverLetter.body).toContain('the AI wrote this');
    expect(res.body.draft.questions[0].answer).toBeTruthy();
  }, 30_000);

  /*
   * The card's button says it hands over "the posting, the resume, and the
   * questions", and it did exactly that — the answers and the letter typed
   * into it stayed behind. Following the invitation to go and write in the
   * editor therefore meant abandoning what was already written.
   */
  it('takes the answers and the letter that come with the posting', async () => {
    const { body } = await open({
      coverLetter: 'Dear Streamly, I started this in the extension.',
      questions: [
        { question: 'Why are you interested in this role?', required: true, answer: 'The ingest rewrite.' },
        { question: 'Describe a technical project you are proud of.', required: true },
      ],
    }).expect(200);

    const draft = body.draft;
    expect(draft.coverLetter.body).toBe('Dear Streamly, I started this in the extension.');
    expect(draft.coverLetter.required).toBe(true);
    // Marked as written by hand, because it was — so generating leaves it be.
    expect(draft.coverLetter.edited).toBe(true);

    expect(draft.questions[0].answer).toBe('The ingest rewrite.');
    expect(draft.questions[0].source).toBe('human');
    expect(draft.questions[0].edited).toBe(true);
    // And one that came with nothing is still answered from the bank as before.
    expect(draft.questions[1].answer).not.toBe('The ingest rewrite.');
  });

  it('does not put a carried letter over one already being written', async () => {
    const { body } = await open().expect(200);
    const id = body.draft.id;
    const mine = { ...t.store.getDraft(id)!, coverLetter: { required: true, body: 'Mine, written here.', edited: true } };
    await request(app).put(`/api/workspace/${id}`).send(mine).expect(200);

    const again = await open({ coverLetter: 'From the card.' }).expect(200);
    expect(again.body.draft.coverLetter.body).toBe('Mine, written here.');
  });

  /*
   * Re-opening a workspace is something the extension does on its own as you
   * move through an application, and it saves the tailored resume first — which
   * shells out to git, a yield of the length a person fits several sentences
   * into. A draft read on the way in and written back on the way out therefore
   * restored the notes and the answers to what they said when the page loaded.
   */
  it('does not reopen a workspace onto what it said before', async () => {
    // Auto-commit on, and a real repo, because the yield this races against is
    // the git commit that saving the tailored resume does.
    const committing = makeTempStore({ config: { git: { autoCommit: true }, ai: { enabled: false }, output: { dir: 'out' } } });
    const repo = Repo.forStore(committing.dir);
    await repo.ensure();
    const live = express();
    live.use('/api', createApi({ store: committing.store, repo }));

    const posting = {
      company: 'Streamly',
      role: 'Data Platform Intern',
      source: 'greenhouse.io',
      questions: [{ question: 'Why are you interested in this role?', required: true }],
    };
    const { body } = await request(live).post('/api/workspace').send(posting).expect(200);
    const id = body.draft.id;

    // The extension re-posts the page — and the person waiting types.
    const reopening = request(live)
      .post('/api/workspace')
      .send({ ...posting, spec: { id: 'job-streamly', label: 'Streamly', extends: 'base' } })
      .then((r) => r);

    const typed = { ...committing.store.getDraft(id)!, notes: 'Three paragraphs the user typed.' };
    typed.questions[0] = { ...typed.questions[0]!, answer: 'The ingest rewrite.', edited: true };
    await request(live).put(`/api/workspace/${id}`).send(typed).expect(200);

    await reopening;
    const after = committing.store.getDraft(id)!;
    expect(after.notes).toBe('Three paragraphs the user typed.');
    expect(after.questions[0]!.answer).toBe('The ingest rewrite.');
    committing.cleanup();
  }, 30_000);

  /*
   * The other side of the same merge: when the letter itself is the box being
   * typed in, what the person wrote wins over what the AI came back with, and
   * they are told so rather than left to notice.
   */
  it('says so when the letter it drafted is dropped for one you typed', async () => {
    const started = path.join(t.dir, 'letter-started');
    const release = path.join(t.dir, 'letter-release');
    await request(app)
      .put('/api/config')
      .send({
        ai: {
          enabled: true,
          command: process.execPath,
          args: [
            '-e',
            `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'1');` +
              `const w=new Int32Array(new SharedArrayBuffer(4));` +
              `while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(w,0,0,10);` +
              `process.stdout.write('Dear Streamly, the AI wrote this.')`,
            '{prompt}',
          ],
          timeoutMs: 20_000,
        },
      })
      .expect(200);

    const { body } = await open().expect(200);
    const id = body.draft.id;
    const generating = request(app).post(`/api/workspace/${id}/generate`).send({ what: 'letter' }).then((r) => r);
    await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true), { timeout: 10_000 });

    const mine = t.store.getDraft(id)!;
    mine.coverLetter = { ...mine.coverLetter, body: 'Dear Streamly, I started this myself.', edited: true };
    await request(app).put(`/api/workspace/${id}`).send(mine).expect(200);

    fs.writeFileSync(release, '1');
    const res = await generating;
    expect(res.status).toBe(200);

    expect(res.body.draft.coverLetter.body).toBe('Dear Streamly, I started this myself.');
    expect(res.body.notes.join(' ')).toMatch(/while this was running/);
  }, 30_000);
});

describe.skipIf(!latex)('workspace completion', { timeout: 180_000 }, () => {
  it('files the answers into the application history and the bank', async () => {
    const created = await request(app)
      .post('/api/workspace')
      .send({
        company: 'Streamly',
        role: 'Intern',
        resumeId: 'intern',
        coverLetterRequired: true,
        questions: [{ question: 'Describe a technical project you are proud of.', required: true }],
      })
      .expect(200);

    const draft = created.body.draft;
    draft.coverLetter.body = 'Dear Streamly, here is why.';
    draft.coverLetter.edited = true;
    draft.questions[0].answer = 'I built a pipeline.';
    draft.questions[0].edited = true;
    await request(app).put(`/api/workspace/${draft.id}`).send(draft).expect(200);

    const done = await request(app)
      .post(`/api/workspace/${draft.id}/complete`)
      .send({ saveAnswersToBank: true })
      .expect(200);

    expect(done.body.files).toContain('Test-Person-Resume.pdf');
    expect(done.body.files.some((f: string) => f.includes('Cover-Letter'))).toBe(true);

    // The application record carries what was actually said.
    const app1 = t.store.load().applications.find((a) => a.company === 'Streamly');
    expect(app1?.answers?.[0]?.answer).toBe('I built a pipeline.');
    expect(app1?.history?.some((h) => /question\(s\) answered/.test(h.note ?? ''))).toBe(true);

    // And the hand-written answer is in the bank for next time.
    const bank = t.store.load().answers.find((a) => a.question.startsWith('Describe'));
    expect(bank?.variants.at(-1)?.text).toBe('I built a pipeline.');

    /*
     * And the space stays, marked as sent.
     *
     * Filing it used to delete the draft, which is the harsher reading of
     * "finished": the letter and the answers went behind a tracker row and
     * could only be read as a snapshot afterwards. A portal that rejects the
     * upload and a question that comes back a week later both want the thing
     * you wrote, so it stays open — quietly, below the live ones, until
     * `retireStaleDrafts` lets it go a fortnight after the last keystroke.
     */
    expect(t.store.getDraft(draft.id)?.status).toBe('submitted');
  });

  /*
   * Completing compiles a bundle, which is seconds of real LaTeX, and the
   * Workspace stays live and saving throughout it. A draft read before the
   * compile and unlinked after it therefore took everything typed during it
   * into no file, no bundle and no application record — since all of those were
   * built from the copy read first.
   */
  it('does not discard what was typed while the bundle compiled', async () => {
    const created = await request(app)
      .post('/api/workspace')
      .send({
        company: 'Helios',
        role: 'Intern',
        resumeId: 'intern',
        coverLetterRequired: true,
        questions: [{ question: 'Why this team?', required: true }],
      })
      .expect(200);
    const id = created.body.draft.id;

    const completing = request(app)
      .post(`/api/workspace/${id}/complete`)
      .send({ saveAnswersToBank: false })
      .then((r) => r);

    // Written while the compile is running, exactly as the autosave would.
    await new Promise((go) => setTimeout(go, 250));
    const typed = { ...t.store.getDraft(id)!, notes: 'Referred by Dana on the platform team.' };
    typed.coverLetter = { ...typed.coverLetter, body: 'A letter written entirely during the compile.' };
    await request(app).put(`/api/workspace/${id}`).send(typed).expect(200);

    const done = await completing;
    expect(done.status).toBe(200);

    // It is still there, holding what was typed, and the reply says why.
    const kept = t.store.getDraft(id);
    expect(kept?.coverLetter.body).toBe('A letter written entirely during the compile.');
    expect(kept?.notes).toBe('Referred by Dana on the platform team.');
    expect(kept?.status).toBe('submitted');
    expect(done.body.warnings.join(' ')).toMatch(/cover letter and notes changed while this was compiling/i);
  });

  it('can keep the draft, marked submitted', async () => {
    const created = await request(app)
      .post('/api/workspace')
      .send({ company: 'Acme', role: 'Intern', resumeId: 'intern', questions: [] })
      .expect(200);

    await request(app)
      .post(`/api/workspace/${created.body.draft.id}/complete`)
      .send({ keepDraft: true, saveAnswersToBank: false })
      .expect(200);

    expect(t.store.getDraft(created.body.draft.id)?.status).toBe('submitted');
  });

  it('refuses to file a draft with no resume attached', async () => {
    const created = await request(app)
      .post('/api/workspace')
      .send({ company: 'Acme', role: 'Intern', questions: [] })
      .expect(200);
    // No resumeId was supplied and none was derived.
    const draft = { ...created.body.draft, resumeId: undefined };
    await request(app).put(`/api/workspace/${draft.id}`).send(draft).expect(200);

    const res = await request(app).post(`/api/workspace/${draft.id}/complete`).send({}).expect(400);
    expect(res.body.error).toMatch(/no resume/i);
  });
});

describe('work you walked away from', () => {
  it('hands back a job instead of holding the request open', async () => {
    const res = await request(app)
      .post('/api/ai/feedback')
      .send({ resumeId: 'newgrad', background: true })
      .expect(200);

    expect(res.body.job.status).toBe('running');
    expect(res.body.job.about).toBe('New grad');
    expect(res.body.job.kind).toBe('feedback');
  });

  it('lists it, and clears the badge once it has been read', async () => {
    const { body } = await request(app)
      .post('/api/ai/feedback')
      .send({ resumeId: 'newgrad', background: true })
      .expect(200);
    const id = body.job.id;

    // The AI is off in the fixture, so it finishes almost immediately.
    let job = body.job;
    for (let i = 0; i < 40 && job.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await request(app).get(`/api/ai/jobs/${id}`).expect(200)).body;
    }

    expect(job.status).toBe('done');
    expect((job.result as { executed: boolean }).executed).toBe(false); // AI off: the prompt comes back
    expect(job.unread).toBe(false); // reading it is what clears the badge

    const list = (await request(app).get('/api/ai/jobs').expect(200)).body.jobs;
    expect(list.some((j: { id: string }) => j.id === id)).toBe(true);
  });

  it('can be dismissed, and says so when asked for again', async () => {
    const { body } = await request(app)
      .post('/api/ai/feedback')
      .send({ resumeId: 'newgrad', background: true })
      .expect(200);

    await request(app).delete(`/api/ai/jobs/${body.job.id}`).expect(200);
    const gone = await request(app).get(`/api/ai/jobs/${body.job.id}`);
    expect(gone.status).toBe(400);
    expect(gone.body.error).toMatch(/expired/);
  });

  it('still answers synchronously for callers that want to wait', async () => {
    const res = await request(app).post('/api/ai/feedback').send({ resumeId: 'newgrad' }).expect(200);
    expect(res.body.executed).toBe(false);
    expect(res.body.output).toContain('Task: critique');
  });
});

describe('adding files to the corpus', () => {
  const LETTERS = [
    'Dear Streamly,',
    '',
    'I am writing about the data platform internship. I have spent two years on pipelines that mostly stayed up, and I would like to keep doing that.',
    '',
    'Sincerely,',
    'Test Person',
    '',
    'Why do you want to work here?',
    '',
    'Because I have read the code you publish, and it is written the way I like to write.',
  ].join('\n');

  const send = (body: Record<string, unknown>) => request(app).post('/api/voice/ingest').send(body);

  it('reads a file and says what is in it, without saving anything yet', async () => {
    const res = await send({ name: 'old-applications.txt', text: LETTERS }).expect(200);

    expect(res.body.items.map((i: { kind: string }) => i.kind)).toEqual(['letter', 'answer']);
    expect(res.body.items[0].text).toContain('Sincerely,');
    expect(res.body.usedAi).toBe(false); // AI is off in the fixture
    // Nothing is in the corpus until the proposals are accepted.
    expect((await request(app).get('/api/voice').expect(200)).body.samples).toHaveLength(0);
  });

  it('takes a file as base64, which is how the browser sends one', async () => {
    const res = await send({
      name: 'letter.txt',
      data: Buffer.from(LETTERS, 'utf8').toString('base64'),
    }).expect(200);
    expect(res.body.items[0].kind).toBe('letter');
    expect(res.body.via).toBe('text');
  });

  it('refuses a file it cannot read, naming what it can', async () => {
    const res = await send({
      name: 'shot.png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]).toString('base64'),
    }).expect(400);
    expect(res.body.error).toMatch(/not text/);
    expect(res.body.error).toMatch(/\.pdf/);
  });

  it('refuses an empty file rather than proposing nothing', async () => {
    expect((await send({ name: 'empty.txt', text: '' }).expect(400)).body.error).toMatch(/nothing in/i);
  });

  it('says so when a file has no readable text', async () => {
    expect((await send({ name: 'blank.txt', text: '   \n\n  \t ' }).expect(400)).body.error).toMatch(
      /no readable text/,
    );
  });

  it('keeps what was accepted, with the kinds as confirmed', async () => {
    const { body } = await send({ name: 'old-applications.txt', text: LETTERS }).expect(200);

    const accepted = await request(app)
      .post('/api/voice/ingest/accept')
      .send({
        items: body.items.map((i: { kind: string; title: string; text: string }) => ({ ...i })),
        source: 'old-applications.txt',
      })
      .expect(200);
    expect(accepted.body.added).toBe(2);

    const voice = (await request(app).get('/api/voice').expect(200)).body;
    expect(voice.samples).toHaveLength(2);
    expect(voice.samples.map((s: { kind: string }) => s.kind).sort()).toEqual(['answer', 'letter']);
    // Where it came from is recorded, so a bad import can be found again.
    expect(voice.samples[0].tags).toContain('from:old-applications.txt');
    expect(voice.preview).toContain('I have read the code you publish');
  });

  it('honours a kind the user corrected, over the one that was proposed', async () => {
    const { body } = await send({ name: 'notes.txt', text: LETTERS }).expect(200);
    await request(app)
      .post('/api/voice/ingest/accept')
      .send({ items: [{ ...body.items[0], kind: 'other' }] })
      .expect(200);

    const voice = (await request(app).get('/api/voice').expect(200)).body;
    expect(voice.samples[0].kind).toBe('other');
  });

  it('files an unknown kind as other rather than writing it into the store', async () => {
    await request(app)
      .post('/api/voice/ingest/accept')
      .send({ items: [{ kind: 'manifesto', title: 'x', text: 'y'.repeat(60) }] })
      .expect(200);
    expect((await request(app).get('/api/voice').expect(200)).body.samples[0].kind).toBe('other');
  });

  it('declines an empty acceptance instead of writing blank samples', async () => {
    const res = await request(app)
      .post('/api/voice/ingest/accept')
      .send({ items: [{ kind: 'other', title: 'x', text: '   ' }] })
      .expect(400);
    expect(res.body.error).toMatch(/Nothing was selected/);
  });

  it('hands back the prompt instead of guessing when the AI is off but asked for', async () => {
    // AI is disabled in the fixture, so `useAi` cannot make one appear: the
    // rules answer, and the response says no AI was used.
    const res = await send({ name: 'notes.txt', text: LETTERS, useAi: true }).expect(200);
    expect(res.body.usedAi).toBe(false);
    expect(res.body.items.every((i: { by: string }) => i.by === 'rules')).toBe(true);
  });
});

/*
 * The two refusals the path layer makes when a name is created. Both are
 * reached through the route the editor auto-saves with, so what matters as
 * much as the refusal is that the reason survives the trip: the editor puts
 * `err.message` straight into its save chip — "Not saved — …" — so a message
 * that arrives as "500" tells somebody their work is lost and nothing else.
 */
describe('a resume id the save cannot hold', () => {
  it('refuses a reserved Windows name, and says which and why', async () => {
    const res = await request(app)
      .put('/api/resumes/CON')
      .send({ label: 'Reserved', sections: [] })
      .expect(400);

    expect(res.body.error).toContain('CON');
    expect(res.body.error).toMatch(/reserved device name on Windows/i);
    // The reason somebody should care, in the same breath as the refusal.
    expect(res.body.error).toMatch(/cloned|clone/i);
  });

  it('refuses an id that differs from one already there only in case', async () => {
    const res = await request(app)
      .put('/api/resumes/BASE')
      .send({ label: 'Shouty', sections: [] })
      .expect(400);

    expect(res.body.error).toMatch(/only in capitalisation/i);
    expect(res.body.error).toMatch(/macOS and Windows/);
    // And the one that was already there is untouched by the attempt.
    const still = await request(app).get('/api/resumes').expect(200);
    expect(still.body.some((r: { id: string }) => r.id === 'base')).toBe(true);
    expect(still.body.some((r: { id: string }) => r.id === 'BASE')).toBe(false);
  });

  it('still lets you save the resume that is already there', async () => {
    // The refusal is on creating a new name, never on writing a file that
    // exists — otherwise the app could list somebody's resume and then decline
    // to save their edit to it.
    await request(app).put('/api/resumes/base').send({ label: 'Base resume', sections: [] }).expect(200);
  });
});

describe.skipIf(!latex)('where to point a file picker', { timeout: 180_000 }, () => {
  it('hands back the flat folder alongside the archive it just wrote', async () => {
    const res = await request(app)
      .post('/api/applications/bundle')
      .send({ company: 'Streamly', role: 'Intern', resumeId: 'intern' })
      .expect(200);

    // The archive is one folder per application; the flat one is where a
    // portal's file picker should be pointed.
    expect(res.body.dir).toContain('applications/');
    expect(res.body.currentDir).toMatch(/current$/);
    expect(res.body.currentDir).not.toContain('applications/');
    expect(fs.existsSync(path.join(res.body.currentDir, 'Test-Person-Resume.pdf'))).toBe(true);
    // Nothing in the way, so nothing to report.
    expect(res.body.currentProblems).toBeUndefined();
  });

  /*
   * And when a file cannot be put there, the answer travels.
   *
   * `syncCurrent` has always named the files it could not write — something of
   * the user's already sitting under that name, a file open and locked, a full
   * disk — and finished the rest rather than failing the request, which is
   * right. This route threw that answer away, so the card said "named and
   * ready to attach" over a folder with the resume missing from it. That is
   * the upload the folder exists to prevent.
   */
  it('says which file did not reach the folder you upload from', async () => {
    const first = await request(app)
      .post('/api/applications/bundle')
      .send({ company: 'Streamly', role: 'Intern', resumeId: 'intern' })
      .expect(200);

    // The user's own folder, with their name on it, where the resume goes.
    const taken = path.join(first.body.currentDir, 'Test-Person-Resume.pdf');
    fs.rmSync(taken, { force: true });
    fs.mkdirSync(taken, { recursive: true });
    fs.writeFileSync(path.join(taken, 'mine.txt'), 'mine', 'utf8');
    // Released from the manifest, so the sync treats it as the user's.
    fs.writeFileSync(path.join(first.body.currentDir, '.rmm-current.json'), JSON.stringify({ files: [] }), 'utf8');

    const res = await request(app)
      .post('/api/applications/bundle')
      .send({ company: 'Streamly', role: 'Intern', resumeId: 'intern' })
      .expect(200);

    expect(res.body.currentProblems?.join(' ')).toContain('Test-Person-Resume.pdf');
    // The archive still has everything, which is what the card offers instead.
    expect(res.body.files).toContain('Test-Person-Resume.pdf');
    expect(fs.existsSync(path.join(res.body.dir, 'Test-Person-Resume.pdf'))).toBe(true);
    // And what was in the way is still there.
    expect(fs.existsSync(path.join(taken, 'mine.txt'))).toBe(true);
  });

  /*
   * And the same folder as something you can click.
   *
   * A path answers the upload dialog and nothing else: from a job board, in a
   * browser, it is a string. This is the page the extension's "Open the
   * folder" opens, so what it lists has to be what is in the folder.
   */
  it('serves the flat folder as a page, and the files in it', async () => {
    await request(app)
      .post('/api/applications/bundle')
      .send({ company: 'Streamly', role: 'Intern', resumeId: 'intern' })
      .expect(200);

    const page = await request(app).get('/current').expect(200);
    expect(page.headers['content-type']).toContain('html');
    expect(page.text).toContain('Test-Person-Resume.pdf');
    expect(page.text).toContain('Ready to upload');

    const file = await request(app).get('/current/Test-Person-Resume.pdf').expect(200);
    expect(file.headers['content-type']).toContain('application/pdf');

    await request(app).get('/current/not-a-file.pdf').expect(404);
    await request(app).get('/current/..%2F..%2Fetc%2Fpasswd').expect(404);
  });

  /*
   * Preparing the files is what files the application now — so the space it
   * was written in stops asking to be finished, without being taken away.
   */
  it('marks the workspace as sent when its files are prepared', async () => {
    const opened = await request(app)
      .post('/api/workspace')
      .send({ company: 'Streamly', role: 'Intern', resumeId: 'intern' })
      .expect(200);

    await request(app)
      .post('/api/applications/bundle')
      .send({ company: 'Streamly', role: 'Intern', resumeId: 'intern', status: 'applied' })
      .expect(200);

    const drafts = await request(app).get('/api/workspace').expect(200);
    const still = drafts.body.drafts.find((d: { id: string }) => d.id === opened.body.draft.id);
    expect(still?.status).toBe('submitted');
  });
});

describe('asking for something impossible', () => {
  it('says what is missing rather than reporting an undefined property', async () => {
    const res = await request(app).post('/api/ai/tailor').send({ resumeId: 'newgrad' }).expect(400);
    expect(res.body.error).toMatch(/job description/i);
    expect(res.body.error).not.toMatch(/undefined/);
  });
});

describe('pinning', () => {
  it('pins an alternate on a bullet as the one everything falls back to', async () => {
    const res = await request(app)
      .put('/api/defaults/b_pipeline')
      .send({ variantId: 'v_kafka' })
      .expect(200);
    expect(res.body).toEqual({ key: 'b_pipeline', variantId: 'v_kafka' });

    const entry = t.store.load().entries.find((e) => e.id === 'exp_acme');
    expect(entry?.bullets?.find((b) => b.id === 'b_pipeline')?.default).toBe('v_kafka');
  });

  it('changes what a resume renders when that resume chose nothing', async () => {
    const before = (await request(app).get('/api/resumes/base/resolved').expect(200)).body;
    expect(JSON.stringify(before)).not.toContain('`Kafka` pipeline');

    await request(app).put('/api/defaults/b_pipeline').send({ variantId: 'v_kafka' }).expect(200);

    const after = (await request(app).get('/api/resumes/base/resolved').expect(200)).body;
    expect(JSON.stringify(after)).toContain('`Kafka` pipeline');
  });

  it('pins an alternate on a heading field, which uses the dotted key', async () => {
    await request(app).put('/api/defaults/edu_neu.dates').send({ variantId: 'v_dec2026' }).expect(200);
    const entry = t.store.load().entries.find((e) => e.id === 'edu_neu');
    expect(typeof entry?.dates === 'object' && entry.dates.default).toBe('v_dec2026');
  });

  it('critiques an application\'s cover letter and one of its answers', async () => {
    const made = await request(app)
      .post('/api/workspace')
      .send({
        company: 'Altair Labs',
        role: 'Platform Engineer',
        source: 'by hand',
        coverLetterRequired: true,
        questions: [{ question: 'Why do you want to work here?', required: true }],
      })
      .expect(200);
    const draft = made.body.draft;

    // Something to review. Feedback on an empty box is not feedback.
    draft.coverLetter.body = 'Dear Altair Labs, I have run Kafka in production for two years.';
    draft.questions[0].answer = 'Because you publish your infrastructure work.';
    await request(app).put(`/api/workspace/${draft.id}`).send(draft).expect(200);

    // With the AI off the prompt comes back, which is what lets these assert
    // what the model would have been shown.
    const letter = await request(app).post('/api/ai/feedback').send({ draftId: draft.id }).expect(200);
    expect(letter.body.executed).toBe(false);
    expect(letter.body.output).toContain('I have run Kafka in production');
    expect(letter.body.output).toContain('Altair Labs');
    expect(letter.body.output).toMatch(/do not rewrite/i);

    const answer = await request(app)
      .post('/api/ai/feedback')
      .send({ draftId: draft.id, questionId: draft.questions[0].id })
      .expect(200);
    expect(answer.body.executed).toBe(false);
    expect(answer.body.output).toContain('Because you publish your infrastructure work.');
    expect(answer.body.output).toMatch(/do not rewrite/i);
  });

  it('will not take the application and the resume as one target', async () => {
    const res = await request(app)
      .post('/api/ai/feedback')
      .send({ draftId: 'whatever', resumeId: 'base' })
      .expect(400);
    expect(res.body.error).toMatch(/not both/);
  });

  it('drafts one answer on request rather than every empty one', async () => {
    const made = await request(app)
      .post('/api/workspace')
      .send({
        company: 'Vireo',
        role: 'Data Scientist',
        source: 'by hand',
        questions: [{ question: 'Why this team?' }, { question: 'Describe a hard bug.' }],
      })
      .expect(200);
    const draft = made.body.draft;
    const [first, second] = draft.questions;

    const res = await request(app)
      .post(`/api/workspace/${draft.id}/generate`)
      .send({ what: 'questions', questionId: second.id })
      .expect(200);

    // The one asked for was considered; the other was not touched.
    expect(res.body.draft.questions[0].answer).toBe(first.answer);
    expect(res.body.notes.join(' ')).toMatch(/Answer drafted/);
  });

  it('says so when the question asked about has gone', async () => {
    const made = await request(app)
      .post('/api/workspace')
      .send({ company: 'Vireo', role: 'Analyst', source: 'by hand', questions: [{ question: 'Why?' }] })
      .expect(200);
    const res = await request(app)
      .post(`/api/workspace/${made.body.draft.id}/generate`)
      .send({ what: 'questions', questionId: 'q-gone' })
      .expect(400);
    expect(res.body.error).toMatch(/not on this application/);
  });

  it('starts a plain variation for an application, and says where to go to edit it', async () => {
    const made = await request(app)
      .post('/api/workspace')
      .send({ company: 'Altair Labs', role: 'Platform Engineer', source: 'by hand' })
      .expect(200);
    const draftId = made.body.draft.id;

    const res = await request(app).post(`/api/workspace/${draftId}/variation`).send({}).expect(200);

    // A thin selection over the base, not a copy of it: nothing decided yet,
    // because deciding is what you are about to go and do.
    expect(res.body.spec.extends).toBeTruthy();
    expect(res.body.spec.choices).toBeUndefined();
    expect(res.body.spec.label).toBe('Platform Engineer — Altair Labs');
    expect(res.body.draft.resumeId).toBe(res.body.spec.id);
    // The way there and the way back, in one link, so the two ends cannot
    // disagree about its shape.
    expect(res.body.url).toBe(
      `/#resumes/${encodeURIComponent(res.body.spec.id)}/from/${encodeURIComponent(draftId)}`,
    );

    // Asked twice, it makes a second one rather than overwriting the first.
    const again = await request(app).post(`/api/workspace/${draftId}/variation`).send({}).expect(200);
    expect(again.body.spec.id).not.toBe(res.body.spec.id);
    // And the second inherits from the base, never from the first — a
    // variation of a variation of a variation is how a store becomes a maze.
    expect(again.body.spec.extends).toBe(res.body.spec.extends);
  });

  it('refuses to start a variation for a draft that is not there', async () => {
    const res = await request(app).post('/api/workspace/no-such-draft/variation').send({}).expect(400);
    expect(res.body.error).toMatch(/No draft/);
  });

  it('pins a form of your name, which lives on the profile rather than an entry', async () => {
    // The name is a field like any other, so it pins through the same route —
    // which knew only about entries and told you your name was "not in the
    // store any more".
    await request(app)
      .put('/api/profile')
      .send({
        name: {
          default: 'v_legal',
          variants: [
            { id: 'v_legal', label: 'Legal', text: 'Jianwen Ding' },
            { id: 'v_known', label: 'Known as', text: 'Jason Ding' },
          ],
        },
        email: 'test@example.com',
      })
      .expect(200);

    await request(app).put('/api/defaults/profile.name').send({ variantId: 'v_known' }).expect(200);
    const profile = t.store.load().profile;
    expect(typeof profile.name === 'object' && profile.name.default).toBe('v_known');

    // And the resume prints it, with no choice of its own.
    const resolved = (await request(app).get('/api/resumes/base/resolved').expect(200)).body;
    expect(resolved.profile.name).toBe('Jason Ding');

    // The form-filling data the extension reads is a name, not a set of them.
    const autofill = (await request(app).get('/api/autofill').expect(200)).body;
    expect(autofill.fields.full_name).toBe('Jason Ding');
  });

  it('says a name with no alternates has none to pin', async () => {
    const res = await request(app).put('/api/defaults/profile.name').send({ variantId: 'v_any' }).expect(400);
    expect(res.body.error).toMatch(/no alternates/i);
  });

  it('refuses an alternate that does not exist', async () => {
    const res = await request(app).put('/api/defaults/b_pipeline').send({ variantId: 'v_ghost' }).expect(400);
    expect(res.body.error).toMatch(/No such alternate/);
  });

  it('says so when the line has no alternates, or is gone', async () => {
    expect((await request(app).put('/api/defaults/b_ghost').send({ variantId: 'v' }).expect(400)).body.error)
      .toMatch(/not in the store/);
    expect((await request(app).put('/api/defaults/edu_neu.title').send({ variantId: 'v' }).expect(400)).body.error)
      .toMatch(/no alternates/);
  });

  it('needs to be told which alternate', async () => {
    expect((await request(app).put('/api/defaults/b_pipeline').send({}).expect(400)).body.error)
      .toMatch(/Name the alternate/);
  });

  it('pins a resume as a base, and unpins it without leaving a field behind', async () => {
    await request(app).put('/api/resumes/intern/base').send({ base: true }).expect(200);
    expect(t.store.loadResumes().find((r) => r.id === 'intern')?.base).toBe(true);

    await request(app).put('/api/resumes/intern/base').send({ base: false }).expect(200);
    expect(t.store.loadResumes().find((r) => r.id === 'intern')).not.toHaveProperty('base');
  });

  it('lists the bases first, so a picker opens on what you build from', async () => {
    await request(app).put('/api/resumes/intern/base').send({ base: true }).expect(200);
    const ids = (await request(app).get('/api/resumes').expect(200)).body.map((r: { id: string }) => r.id);
    expect(ids[0]).toBe('intern');
    expect(ids).toHaveLength(t.store.loadResumes().length);
  });

  it('names a resume that is not there', async () => {
    expect((await request(app).put('/api/resumes/ghost/base').send({ base: true }).expect(400)).body.error)
      .toMatch(/No resume "ghost"/);
  });

  it('starts a tailored draft from the pinned base rather than a guessed name', async () => {
    await request(app).put('/api/resumes/intern/base').send({ base: true }).expect(200);
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ html: JOB_HTML, url: 'https://example.com/job' })
      .expect(200);
    expect(res.body.spec.extends).toBe('intern');
  });
});
