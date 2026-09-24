import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Repo } from '../src/git/repo.js';
import { createApi } from '../src/server/api.js';
import { applyingDays, closeStaleApplying, tidyWorkdayNames } from '../src/server/sweep.js';
import { closedAsStale, findApplication, goneStale } from '../src/model/applications.js';
import { makeTempStore } from './helpers.js';
import type { Application } from '../src/model/types.js';

/*
 * An application left at Applying is closed after two weeks of nothing.
 *
 * `applying` is written the moment something goes into an employer's boxes
 * and only a send the page was seen to make takes it off again, so a form
 * abandoned half way read "Applying" for ever and the list of things still to
 * finish filled with things nobody was finishing.
 */

let temp: ReturnType<typeof makeTempStore>;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

beforeEach(() => {
  temp = makeTempStore();
});
afterEach(() => temp.cleanup());

const row = (id: string, status: Application['status'], at: string, extra: Partial<Application> = {}): Application => ({
  id,
  company: id,
  role: 'Software Engineer',
  status,
  appliedAt: at,
  history: [{ at, status, note: 'Started filling in the form' }],
  ...extra,
});

describe('which applications have gone stale', () => {
  it('is two weeks by default, and follows the save when told otherwise', () => {
    expect(applyingDays(temp.store)).toBe(14);
    temp.store.saveConfig({ applications: { applyingDays: 30 } });
    expect(applyingDays(temp.store)).toBe(30);
  });

  it('is an Applying row whose last sign of work is past the window, and nothing else', () => {
    const apps = [
      row('Old', 'applying', daysAgo(15)),
      row('Recent', 'applying', daysAgo(13)),
      row('Sent', 'applied', daysAgo(40)),
      row('Bookmarked', 'interested', daysAgo(40)),
    ];
    expect(goneStale(apps, []).map((s) => s.id)).toEqual(['Old']);
  });

  it('counts the last line of history, not the day it started', () => {
    const moved = row('Moved', 'applying', daysAgo(40), {
      history: [
        { at: daysAgo(40), status: 'interested' },
        { at: daysAgo(3), status: 'applying', note: 'Started filling in the form' },
      ],
    });
    expect(goneStale([moved], [])).toEqual([]);
  });

  it('leaves one whose workspace was written in lately, whatever the history says', () => {
    const app = row('Writing', 'applying', daysAgo(30));
    const drafts = [{ id: 'd', company: 'Writing', role: 'Software Engineer', status: 'drafting', updatedAt: daysAgo(2) }];
    expect(goneStale([app], drafts)).toEqual([]);
    // And the same row with the workspace left alone as long is stale.
    expect(goneStale([app], [{ ...drafts[0]!, updatedAt: daysAgo(20) }]).map((s) => s.id)).toEqual(['Writing']);
  });

  it('closes nothing on no evidence: an undated row, or a window of zero', () => {
    const undated: Application = { id: 'Undated', company: 'Undated', role: 'SWE', status: 'applying' };
    expect(goneStale([undated], [])).toEqual([]);
    expect(goneStale([row('Old', 'applying', daysAgo(90))], [], { days: 0 })).toEqual([]);
  });
});

describe('closing them when the save is opened', () => {
  it('closes each with a note saying why, in one commit of the tracker alone', async () => {
    temp.write('applications.yaml', [row('Old', 'applying', daysAgo(20)), row('Live', 'applying', daysAgo(1))]);
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    await repo.commitAll('Before');
    temp.store.saveConfig({ git: { autoCommit: true } } as never);

    const closed = await closeStaleApplying(temp.store, repo);

    expect(closed.map((a) => a.id)).toEqual(['Old']);
    const apps = temp.store.load().applications;
    const old = apps.find((a) => a.id === 'Old')!;
    expect(old.status).toBe('closed');
    expect(old.history?.at(-1)?.note).toMatch(/14 days/);
    expect(closedAsStale(old)).toBe(true);
    expect(apps.find((a) => a.id === 'Live')!.status).toBe('applying');

    const [latest] = await repo.log(1);
    expect(latest?.message).toMatch(/Close Old/);
    expect((await repo.commit(latest!.hash))?.files.map((f) => f.path)).toEqual(['applications.yaml']);

    // And a second opening has nothing left to do.
    expect(await closeStaleApplying(temp.store, repo)).toEqual([]);
  });

  it('tells a close it made from one somebody chose', () => {
    const chosen = row('Chosen', 'closed', daysAgo(5), { history: [{ at: daysAgo(5), status: 'closed', note: 'Rejected' }] });
    expect(closedAsStale(chosen)).toBe(false);
  });
});

describe('coming back to one it closed', () => {
  let app: express.Express;
  beforeEach(async () => {
    temp.write('applications.yaml', [row('Dormant', 'applying', daysAgo(20))]);
    await closeStaleApplying(temp.store, Repo.forStore(temp.dir));
    app = express();
    app.use('/api', createApi({ store: temp.store, repo: Repo.forStore(temp.dir) }));
  });

  it('is the same application carrying on, not a new one', () => {
    const apps = temp.store.load().applications;
    expect(findApplication(apps, 'Dormant', 'Software Engineer')?.id).toBe('Dormant');
  });

  it('and a send the page makes files it as sent, on the same row', async () => {
    const res = await request(app).post('/api/extension/sent').send({ company: 'Dormant', role: 'Software Engineer' }).expect(200);
    expect(res.body.changed).toBe(true);
    const apps = temp.store.load().applications;
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ id: 'Dormant', status: 'applied' });
  });

  it('while one closed by hand stays closed, and a fresh attempt is a row of its own', async () => {
    temp.write('applications.yaml', [
      row('Turned', 'closed', daysAgo(20), { company: 'Turned', history: [{ at: daysAgo(20), status: 'closed', note: 'Rejected' }] }),
    ]);
    await request(app).post('/api/extension/sent').send({ company: 'Turned', role: 'Software Engineer' }).expect(200);
    const apps = temp.store.load().applications;
    expect(apps.map((a) => a.status).sort()).toEqual(['applied', 'closed']);
  });
});

describe('employers already filed the way Workday books them', () => {
  it('are renamed, workspaces too, without the rename counting as work on them', async () => {
    const WD = 'https://intel.wd1.myworkdayjobs.com/External/job/US-OR-Hillsboro/Software-Engineering-Intern_JR1';
    temp.write('applications.yaml', [
      row('intel', 'applying', daysAgo(3), { company: '100 Intel Corporation', url: WD }),
      row('lumber', 'applying', daysAgo(3), { company: '84 Lumber', url: 'https://jobs.84lumber.com/1' }),
    ]);
    const old = daysAgo(3);
    temp.write('drafts/d-intel.yaml', {
      id: 'd-intel', company: '100 Intel Corporation', role: 'Software Engineer', url: WD,
      createdAt: old, updatedAt: old, status: 'drafting',
    });

    const renamed = await tidyWorkdayNames(temp.store, Repo.forStore(temp.dir));

    expect(renamed).toEqual(['100 Intel Corporation → Intel Corporation']);
    const apps = temp.store.load().applications;
    expect(apps.map((a) => a.company)).toEqual(['Intel Corporation', '84 Lumber']);
    const draft = temp.store.loadDrafts().find((d) => d.id === 'd-intel')!;
    expect(draft.company).toBe('Intel Corporation');
    expect(draft.updatedAt).toBe(old);
  });
});
