/**
 * One job, one row, however its employer and its role were written down.
 *
 * Pairs of rows from one person's tracker, each pair a single application:
 *
 *   Redhat / Red Hat / redhat.wd5.myworkdayjobs.com      Software Engineer Intern
 *   NVIDIA / NVIDIA Corporation
 *   Amazon.jobs / Amazon Web Services (AWS)              Software Dev Engineer I, Graviton Software, Annapurna Labs
 *   Electronic Arts                                      Gameplay Engineer Intern - Careers / Gameplay Engineer Intern
 *   Respawn Entertainment / Electronic Arts              Gameplay Engineer Intern — EA's job 216245
 *
 * Identity is the employer and the role, and each pair differed only in how
 * one of them was spelled. Different roles, and different employers, stay
 * apart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { findApplication, identity } from '../src/model/applications.js';
import type { Application } from '../src/model/types.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const same = (a: [string, string], b: [string, string]) => expect(identity(...a), `${a.join(' | ')} vs ${b.join(' | ')}`).toBe(identity(...b));
const apart = (a: [string, string], b: [string, string]) =>
  expect(identity(...a), `${a.join(' | ')} vs ${b.join(' | ')}`).not.toBe(identity(...b));

describe('one employer, however it is spelled', () => {
  it('folds case, spacing, punctuation, legal forms and an address filed as the name', () => {
    const role = 'Software Engineer Intern';
    same(['Red Hat', role], ['Redhat', role]);
    same(['Red Hat', role], ['redhat.wd5.myworkdayjobs.com', role]);
    same(['Red Hat', role], ['Red Hat, Inc.', role]);
    same(['NVIDIA', role], ['NVIDIA Corporation', role]);
    same(['Keysight Technologies, Inc.', role], ['Keysight Technologies Personnel, LLC', role]);
    same(['ACME, Inc.', role], ['acme', role]);
    same(['Activision', role], ['careers.activision.com', role]);
    // And it is still the role that decides: two jobs at Red Hat are two rows.
    apart(['Red Hat', role], ['Redhat', 'Software Engineer']);
  });

  it('folds Amazon’s board and the business line it books the job to, for the same role', () => {
    const role = 'Software Dev Engineer I, Graviton Software, Annapurna Labs';
    same(['Amazon.jobs', role], ['Amazon Web Services (AWS)', role]);
    same(['Amazon Web Services (AWS)', role], ['Amazon', role]);
    apart(['Amazon.jobs', role], ['Amazon Web Services (AWS)', 'Software Dev Engineer II, Graviton Software, Annapurna Labs']);
  });

  it('keeps two employers that share a word apart, telling Epic Systems from Epic Games by the address', () => {
    const role = 'Software Developer';
    same(['epic.com', role], ['Epic', role]);
    same(['epicgames.com', role], ['Epic Games', role]);
    apart(['Epic', role], ['Epic Games', role]);
    apart(['epic.com', role], ['epicgames.com', role]);
    apart(['Red Hat', role], ['Red Bull', role]);
  });
});

describe('one role, with a page title’s leftovers on it or not', () => {
  it('folds what a title carried along into the role it is', () => {
    same(['Electronic Arts', 'Gameplay Engineer Intern - Careers'], ['Electronic Arts', 'Gameplay Engineer Intern']);
    same(['Qualcomm', '#Software Engineer'], ['Qualcomm', 'Software Engineer']);
    same(
      ['Keysight Technologies, Inc.', 'Engineering Software Developer, Intern in Multiple Locations | Keysight Technologies, Inc.'],
      ['Keysight Technologies, Inc.', 'Engineering Software Developer, Intern'],
    );
    same(
      ['Amazon.jobs', 'Software Dev Engineer I, Graviton Software, Annapurna Labs - Job ID: 2912345 | Amazon.jobs'],
      ['Amazon Web Services (AWS)', 'Software Dev Engineer I, Graviton Software, Annapurna Labs'],
    );
  });

  it('and cuts nothing that is part of the title', () => {
    // Activision's own title opens with its name; it is not a leftover.
    apart(['Activision', 'Activision 2027 Summer Internships - Graphics Engineering'], ['Activision', 'Graphics Engineering']);
    apart(['Salesforce', 'Summer 2027 Intern - Software Engineer'], ['Salesforce', 'Summer 2027 Intern']);
    apart(['Acme', 'C++ Engineer'], ['Acme', 'C# Engineer']);
    // A team after a spaced hyphen, even one named for the employer: two jobs at Apple.
    apart(['Apple', 'iOS Engineer - Apple Music'], ['Apple', 'iOS Engineer - Apple Pay']);
    apart(['Google', 'Research Scientist - Google DeepMind'], ['Google', 'Research Scientist - Google Research']);
    // While the employer's spelling still folds under them.
    same(['Activision', 'Activision 2027 Summer Internships - Graphics Engineering'], ['careers.activision.com', 'Activision 2027 Summer Internships - Graphics Engineering']);
  });
});

describe('one job, by its number, under two names for who it is with', () => {
  const row = (over: Partial<Application>): Application => ({
    id: '2026-09-20-electronic-arts-gameplay-engineer-intern',
    company: 'Electronic Arts',
    role: 'Gameplay Engineer Intern',
    url: 'https://jobs.ea.com/en_US/careers/JobDetail/Gameplay-Engineer-Intern/216245',
    status: 'applied',
    appliedAt: '2026-09-20T10:00:00.000Z',
    ...over,
  });

  it('finds EA’s row for the studio’s name when the address names the same job — and not for another job', () => {
    const apps = [row({})];
    // The page says "EA Studios - Respawn", and was read as Respawn Entertainment.
    expect(findApplication(apps, 'Respawn Entertainment', 'Gameplay Engineer Intern', 'https://jobs.ea.com/en_US/careers/ApplicationMethods?jobId=216245')?.id).toBe(
      apps[0]!.id,
    );
    // Not for another job's number, another role, or a role it does not know.
    expect(findApplication(apps, 'Respawn Entertainment', 'Gameplay Engineer Intern', 'https://jobs.ea.com/en_US/careers/JobDetail/x/216299')).toBeUndefined();
    expect(findApplication(apps, 'Respawn Entertainment', 'Level Designer', 'https://jobs.ea.com/en_US/careers/ApplicationMethods?jobId=216245')).toBeUndefined();
    expect(
      findApplication([row({ role: 'Unknown role (job 216245)' })], 'Respawn Entertainment', 'Unknown role (job 216245)', 'https://jobs.ea.com/x?jobId=216245'),
    ).toBeUndefined();
  });
});

describe('the routes that file an application, under either spelling', () => {
  async function server() {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { createApi } = await import('../src/server/api.js');
    const { Repo } = await import('../src/git/repo.js');
    t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
    const rows = async () => (await request(app).get('/api/applications').expect(200)).body.applications as Application[];
    return { app, request, rows };
  }

  it('records a send against the row already open under another spelling, rather than filing a second', async () => {
    const { app, request, rows } = await server();
    const url = 'https://redhat.wd5.myworkdayjobs.com/jobs/job/Raleigh/Software-Engineer-Intern_R045123';
    await request(app)
      .post('/api/workspace')
      .send({ company: 'Red Hat', role: 'Software Engineer Intern', url, auto: true, actedOnForm: true })
      .expect(200);
    await request(app).post('/api/extension/sent').send({ company: 'Redhat', role: 'Software Engineer Intern', url: `${url}/apply` }).expect(200);
    await request(app)
      .post('/api/extension/sent')
      .send({ company: 'redhat.wd5.myworkdayjobs.com', role: 'Software Engineer Intern', url: `${url}/apply` })
      .expect(200);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ company: 'Red Hat', status: 'applied' });
  });

  it('opens the workspace of a role filed with a page title’s leftovers, rather than a second one', async () => {
    const { app, request, rows } = await server();
    const first = await request(app)
      .post('/api/workspace')
      .send({ company: 'Electronic Arts', role: 'Gameplay Engineer Intern - Careers', url: 'https://jobs.ea.com/en_US/careers/JobDetail/Gameplay-Engineer-Intern/216245' })
      .expect(200);
    const again = await request(app)
      .post('/api/workspace')
      .send({ company: 'Electronic Arts', role: 'Gameplay Engineer Intern', url: 'https://jobs.ea.com/en_US/careers/JobDetail/Gameplay-Engineer-Intern/216245' })
      .expect(200);
    expect(again.body.draft.id).toBe(first.body.draft.id);
    expect(await rows()).toHaveLength(1);
  });

  it('tells a page read under the studio’s name that EA’s application for that job was sent', async () => {
    const { app, request } = await server();
    const posting = 'https://jobs.ea.com/en_US/careers/JobDetail/Gameplay-Engineer-Intern/216245';
    const sent = await request(app)
      .post('/api/extension/sent')
      .send({ company: 'Electronic Arts', role: 'Gameplay Engineer Intern', url: posting })
      .expect(200);
    const html = `<html><head><title>Gameplay Engineer Intern</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Gameplay Engineer Intern",
"hiringOrganization":{"@type":"Organization","name":"Respawn Entertainment"},"description":"<p>Build gameplay systems in C++ with a small team.</p>"}</script>
</head><body><p>EA Studios - Respawn</p></body></html>`;
    const read = (
      await request(app)
        .post('/api/extension/analyze')
        .send({ url: posting, title: 'Gameplay Engineer Intern', html, baseResumeId: 'base', tailor: 'none' })
        .expect(200)
    ).body;
    expect(read.spec.generatedFor.company).toBe('Respawn Entertainment');
    expect(read.application.id).toBe(sent.body.application.id);
    expect(read.applied?.id).toBe(sent.body.application.id);
  });
});
