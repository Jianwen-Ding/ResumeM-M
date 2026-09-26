/**
 * Correcting a tracker row's company and role.
 *
 * Checked against the job sites, 28 of one person's 72 rows named the wrong
 * company or a mangled role — a season for the employer, a job board, a title
 * cut at a dash — and the tracker offered only Remove.
 */
import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
afterEach(() => t?.cleanup());

async function app() {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { createApi } = await import('../src/server/api.js');
  const { Repo } = await import('../src/git/repo.js');
  const server = express();
  server.use(express.json());
  server.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  return request(server);
}

function seed() {
  t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
  const write = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(t.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(t.dir, rel), YAML.stringify(data), 'utf8');
  };
  write('applications.yaml', [
    { id: '2026-09-25-summer-2027-cpe-sw-e2e-triage-intern', company: 'Summer 2027', role: 'CPE SW E2E Triage Intern', status: 'applying', createdAt: '2026-09-25T00:00:00.000Z' },
    { id: '2026-09-25-salesforce-summer-2027-intern', company: 'Salesforce', role: 'Summer 2027 Intern', status: 'applied', createdAt: '2026-09-25T00:00:00.000Z' },
  ]);
  write('drafts/2026-09-25-summer-2027-cpe-sw-e2e-triage-intern.yaml', {
    id: '2026-09-25-summer-2027-cpe-sw-e2e-triage-intern',
    company: 'Summer 2027',
    role: 'CPE SW E2E Triage Intern',
    status: 'drafting',
    updatedAt: '2026-09-25T00:00:00.000Z',
  });
}

describe('correcting what a tracker row says it is', () => {
  it('puts the right company on the row, and on its space in the Workspace', async () => {
    seed();
    const res = await (await app())
      .patch('/api/applications/2026-09-25-summer-2027-cpe-sw-e2e-triage-intern')
      .send({ company: 'Motorola Solutions' })
      .expect(200);
    expect(res.body).toMatchObject({ id: '2026-09-25-summer-2027-cpe-sw-e2e-triage-intern', company: 'Motorola Solutions', role: 'CPE SW E2E Triage Intern' });
    const rows = t.store.load().applications;
    expect(rows.find((a) => a.id === '2026-09-25-summer-2027-cpe-sw-e2e-triage-intern')?.company).toBe('Motorola Solutions');
    // The other row is left exactly as it was.
    expect(rows.find((a) => a.id === '2026-09-25-salesforce-summer-2027-intern')).toMatchObject({ company: 'Salesforce', role: 'Summer 2027 Intern' });
    const space = t.store.loadDrafts().find((d) => d.id === '2026-09-25-summer-2027-cpe-sw-e2e-triage-intern');
    expect(space).toMatchObject({ company: 'Motorola Solutions', role: 'CPE SW E2E Triage Intern' });
  });

  it('puts back a role that was cut off at a dash', async () => {
    seed();
    await (await app())
      .patch('/api/applications/2026-09-25-salesforce-summer-2027-intern')
      .send({ role: '  Summer 2027 Intern - Software Engineer  ' })
      .expect(200);
    expect(t.store.load().applications.find((a) => a.id === '2026-09-25-salesforce-summer-2027-intern')?.role).toBe('Summer 2027 Intern - Software Engineer');
  });

  /*
   * A space that is this row's job only by its number.
   *
   * EA's job 216245 is "Electronic Arts" on one of its pages and "Respawn
   * Entertainment", the studio, on another. A space opened on the studio's
   * page and a row filed from EA's — by a send, or by hand, on another day —
   * carry two ids and two employers, and what makes them one application is
   * the address: the same role at jobs.ea.com, job 216245 (see `sameJobAs`).
   * Every route that files, sends or moves a row finds the space that way.
   * Correcting the row's role has to rename that space too: left behind
   * under the old role, it is not the same job by its number either, and
   * nothing that moves the row ever finds its space again.
   */
  it('renames the space that is this job only by its number, and no other', async () => {
    t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
    const write = (rel: string, data: unknown) => {
      fs.mkdirSync(path.dirname(path.join(t.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(t.dir, rel), YAML.stringify(data), 'utf8');
    };
    const row = '2026-09-25-electronic-arts-gameplay-engineer';
    const space = '2026-09-24-respawn-entertainment-gameplay-engineer';
    const another = '2026-09-24-respawn-entertainment-gameplay-engineer-2';
    write('applications.yaml', [
      {
        id: row,
        company: 'Electronic Arts',
        role: 'Gameplay Engineer',
        url: 'https://jobs.ea.com/en_US/careers/ApplicationMethods?jobId=216245',
        status: 'applying',
        appliedAt: '2026-09-25T00:00:00.000Z',
      },
    ]);
    write(`drafts/${space}.yaml`, {
      id: space,
      company: 'Respawn Entertainment',
      role: 'Gameplay Engineer',
      url: 'https://jobs.ea.com/en_US/careers/JobDetail/Gameplay-Engineer/216245',
      status: 'drafting',
      updatedAt: '2026-09-24T00:00:00.000Z',
    });
    // The same title at the studio, but another of EA's jobs: not this row's.
    write(`drafts/${another}.yaml`, {
      id: another,
      company: 'Respawn Entertainment',
      role: 'Gameplay Engineer',
      url: 'https://jobs.ea.com/en_US/careers/JobDetail/Gameplay-Engineer/216299',
      status: 'drafting',
      updatedAt: '2026-09-24T00:00:00.000Z',
    });
    const client = await app();
    // It is this row's space, as the other routes find it.
    const { draftForJob } = await import('../src/model/applications.js');
    const [tracked] = t.store.load().applications;
    expect(draftForJob(t.store.loadDrafts(), [tracked!], tracked!.company, tracked!.role, tracked!.url)?.id).toBe(space);

    // The role was a title cut off at a dash: "Gameplay Engineer - Intern".
    await client.patch(`/api/applications/${row}`).send({ role: 'Gameplay Engineer Intern' }).expect(200);
    const drafts = t.store.loadDrafts();
    expect(drafts.find((d) => d.id === space)).toMatchObject({ company: 'Electronic Arts', role: 'Gameplay Engineer Intern' });
    expect(drafts.find((d) => d.id === another)).toMatchObject({ company: 'Respawn Entertainment', role: 'Gameplay Engineer' });

    // And the row and its space still move together.
    await client.post(`/api/applications/${row}/status`).send({ status: 'applied' }).expect(200);
    expect(t.store.loadDrafts().find((d) => d.id === space)?.status).toBe('submitted');
    expect(t.store.loadDrafts().find((d) => d.id === another)?.status).toBe('drafting');
  });

  it('refuses to leave either one empty, or a row that is not there', async () => {
    seed();
    const client = await app();
    const empty = await client.patch('/api/applications/2026-09-25-salesforce-summer-2027-intern').send({ company: '   ' });
    expect(empty.status).toBeGreaterThanOrEqual(400);
    const nothing = await client.patch('/api/applications/2026-09-25-salesforce-summer-2027-intern').send({});
    expect(nothing.status).toBeGreaterThanOrEqual(400);
    const missing = await client.patch('/api/applications/no-such-row').send({ company: 'Acme' });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(t.store.load().applications.find((a) => a.id === '2026-09-25-salesforce-summer-2027-intern')?.company).toBe('Salesforce');
  });
});
