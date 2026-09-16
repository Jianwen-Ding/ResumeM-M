import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, createPdfRouter } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
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
    // The AI is off in the fixture, so the prompt comes back instead.
    expect(res.body.source).toBe('prompt');
    expect(res.body.output).toContain('answer an application question');
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

  it('returns a bullet-specific prompt when given one', async () => {
    const res = await request(app)
      .post('/api/ai/feedback')
      .send({ entryId: 'exp_acme', bulletId: 'b_pipeline' })
      .expect(200);
    expect(res.body.output).toContain('critique one bullet');
  });

  it('reports a bullet that does not exist', async () => {
    const res = await request(app)
      .post('/api/ai/feedback')
      .send({ entryId: 'exp_acme', bulletId: 'ghost' })
      .expect(400);
    expect(res.body.error).toMatch(/ghost/);
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

    expect(res.body.files[0]).toContain('Test Person Resume Streamly.pdf');
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

    expect(done.body.files).toContain('Test Person Resume Streamly.pdf');
    expect(done.body.files.some((f: string) => f.includes('Cover Letter'))).toBe(true);

    // The application record carries what was actually said.
    const app1 = t.store.load().applications.find((a) => a.company === 'Streamly');
    expect(app1?.answers?.[0]?.answer).toBe('I built a pipeline.');
    expect(app1?.history?.some((h) => /question\(s\) answered/.test(h.note ?? ''))).toBe(true);

    // And the hand-written answer is in the bank for next time.
    const bank = t.store.load().answers.find((a) => a.question.startsWith('Describe'));
    expect(bank?.variants.at(-1)?.text).toBe('I built a pipeline.');

    // The draft is cleared once filed.
    expect(t.store.getDraft(draft.id)).toBeUndefined();
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
