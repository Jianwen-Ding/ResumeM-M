import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { byTier, doneAt, dueToGo, needsTiering, tierForMigration, tierResumes } from '../src/model/tiers.js';
import { tierOf } from '../src/model/types.js';
import { makeTempStore } from './helpers.js';
import type { Application, ResumeSpec } from '../src/model/types.js';

/*
 * How permanent a resume is.
 *
 * A save fills up: a year of applying is a few hundred postings, and every
 * one of them used to leave a resume in the list forever, named after a job
 * that closed in March. Three tiers — what you build from, what you keep, and
 * what was made for one posting and goes a week after that posting is done.
 *
 * The tests below are mostly about the sweep, because the sweep deletes
 * things. Every rule in it exists to stop it deleting one it should not, and
 * each of those is a document somebody would have had to rebuild.
 */

const spec = (id: string, extra: Partial<ResumeSpec> = {}): ResumeSpec => ({ id, label: id, ...extra });
const app = (id: string, extra: Partial<Application> = {}): Application =>
  ({ id, company: 'Acme', role: 'Dev', status: 'applied', ...extra }) as Application;

const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);

describe('what tier an older save’s resumes belong in', () => {
  it('reads a pinned base as a base', () => {
    expect(tierForMigration(spec('systems', { base: true }))).toBe('base');
  });

  it('reads anything the extension made for a posting as temporary', () => {
    expect(tierForMigration(spec('job-adobe', { generatedFor: { company: 'Adobe' } }))).toBe('temporary');
  });

  /*
   * And everything else is kept. This is the half that matters: a resume
   * written by a version that had no tiers — or by hand, in a folder
   * advertised as editable YAML — must not become deletable because a field
   * appeared under it.
   */
  it('keeps everything it cannot place', () => {
    expect(tierForMigration(spec('something'))).toBe('extended');
    expect(tierOf(spec('something'))).toBe('extended');
  });

  it('knows when there is nothing to do', () => {
    expect(needsTiering([spec('a', { tier: 'base' })])).toBe(false);
    expect(needsTiering([spec('a', { tier: 'base' }), spec('b')])).toBe(true);
  });

  it('drops the flag it replaced, so the two cannot disagree', () => {
    const { tiered } = tierResumes([spec('systems', { base: true })]);
    expect(tiered[0]?.tier).toBe('base');
    expect(tiered[0]).not.toHaveProperty('base');
  });

  /*
   * The clock on a resume an upgrade makes temporary starts when the upgrade
   * ran, not when the posting was applied to. A save upgraded today must not
   * lose three months of resumes tonight.
   */
  it('starts the clock at the migration, not at the posting', () => {
    const { tiered } = tierResumes(
      [spec('job-adobe', { generatedFor: { company: 'Adobe', at: '2026-01-01T00:00:00.000Z' } })],
      '2026-09-19T00:00:00.000Z',
    );
    expect(tiered[0]?.temporaryFrom).toBe('2026-09-19T00:00:00.000Z');
  });

  it('leaves a resume that already has a tier exactly alone', () => {
    const already = spec('job-x', { tier: 'temporary', temporaryFrom: '2026-01-01T00:00:00.000Z' });
    const { tiered, changed } = tierResumes([already], '2026-09-19T00:00:00.000Z');
    expect(changed).toEqual([]);
    // Or it would live forever by being re-migrated on every read.
    expect(tiered[0]?.temporaryFrom).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('the order a picker shows them in', () => {
  it('is bases, then what is kept, then what is going', () => {
    const list = [
      spec('job-adobe', { tier: 'temporary' }),
      spec('kept', { tier: 'extended' }),
      spec('systems', { tier: 'base' }),
    ];
    expect(byTier(list).map((r) => r.id)).toEqual(['systems', 'kept', 'job-adobe']);
  });

  it('keeps the store’s own order within a tier', () => {
    const list = [spec('b', { tier: 'base' }), spec('a', { tier: 'base' })];
    expect(byTier(list).map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('when a temporary resume is done with', () => {
  const made = { tier: 'temporary' as const, temporaryFrom: '2026-01-01T00:00:00.000Z' };

  it('counts from the day the application went out', () => {
    const apps = [app('a1', { resumeId: 'job-x', appliedAt: '2026-03-01T00:00:00.000Z' })];
    expect(doneAt(spec('job-x', made), apps)).toBe('2026-03-01T00:00:00.000Z');
  });

  /*
   * Not while it is still being written. A posting you have open and are
   * drafting a cover letter for is not one to take the resume away from,
   * however long it has been sitting there.
   */
  it('does not start counting on an application that has not gone out', () => {
    for (const status of ['interested', 'applying'] as const) {
      const apps = [app('a1', { resumeId: 'job-x', status, appliedAt: '2026-03-01T00:00:00.000Z' })];
      expect(doneAt(spec('job-x', made), apps), status).toBeUndefined();
    }
  });

  /*
   * And not while somebody is about to ask you about it. This is the rule
   * that costs the sweep most of its work and is worth every bit of it: the
   * document you are being interviewed on is the last one to delete.
   */
  it('stops counting while an interview or an offer is live', () => {
    for (const status of ['interview', 'offer'] as const) {
      const apps = [app('a1', { resumeId: 'job-x', status, appliedAt: '2026-03-01T00:00:00.000Z' })];
      expect(doneAt(spec('job-x', made), apps), status).toBeUndefined();
    }
  });

  it('counts a closed application from when it closed, not from when it was sent', () => {
    const apps = [
      app('a1', {
        resumeId: 'job-x',
        status: 'closed',
        appliedAt: '2026-03-01T00:00:00.000Z',
        history: [
          { at: '2026-03-01T00:00:00.000Z', status: 'applied' },
          { at: '2026-05-01T00:00:00.000Z', status: 'closed' },
        ],
      }),
    ];
    expect(doneAt(spec('job-x', made), apps)).toBe('2026-05-01T00:00:00.000Z');
  });

  /*
   * One resume, two postings. The one that closed is not permission to
   * delete the document the other one is still about.
   */
  it('waits for every application that used it, not just the first', () => {
    const apps = [
      app('a1', { resumeId: 'job-x', status: 'closed', appliedAt: '2026-03-01T00:00:00.000Z' }),
      app('a2', { resumeId: 'job-x', status: 'interview', appliedAt: '2026-04-01T00:00:00.000Z' }),
    ];
    expect(doneAt(spec('job-x', made), apps)).toBeUndefined();
  });

  it('falls back to its own date where no application ever used it', () => {
    // A copy made and abandoned. Without this nothing would ever clear it.
    expect(doneAt(spec('job-x', made), [])).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('which temporary resumes have run out their week', () => {
  const now = at('2026-09-19T00:00:00.000Z');
  const store = (resumes: ResumeSpec[], applications: Application[] = []) => ({ resumes, applications });

  it('takes the ones a week past their application', () => {
    const data = store(
      [spec('job-x', { tier: 'temporary' })],
      [app('a1', { resumeId: 'job-x', appliedAt: new Date(now - 8 * DAY).toISOString() })],
    );
    expect(dueToGo(data, { now }).map((d) => d.id)).toEqual(['job-x']);
  });

  it('leaves the ones whose week is not up', () => {
    const data = store(
      [spec('job-x', { tier: 'temporary' })],
      [app('a1', { resumeId: 'job-x', appliedAt: new Date(now - 6 * DAY).toISOString() })],
    );
    expect(dueToGo(data, { now })).toEqual([]);
  });

  it('never takes one that is not temporary, however old', () => {
    const ancient = new Date(now - 400 * DAY).toISOString();
    const data = store(
      [spec('kept', { tier: 'extended' }), spec('systems', { tier: 'base' }), spec('untiered')],
      [
        app('a1', { resumeId: 'kept', appliedAt: ancient }),
        app('a2', { resumeId: 'systems', appliedAt: ancient }),
        app('a3', { resumeId: 'untiered', appliedAt: ancient }),
      ],
    );
    expect(dueToGo(data, { now })).toEqual([]);
  });

  it('never takes one whose application is still in flight', () => {
    const data = store(
      [spec('job-x', { tier: 'temporary' })],
      [app('a1', { resumeId: 'job-x', status: 'interview', appliedAt: new Date(now - 90 * DAY).toISOString() })],
    );
    expect(dueToGo(data, { now })).toEqual([]);
  });

  it('says when each one goes, so the list can be shown before it happens', () => {
    const applied = new Date(now - 8 * DAY).toISOString();
    const data = store([spec('job-x', { tier: 'temporary' })], [app('a1', { resumeId: 'job-x', appliedAt: applied })]);
    const [due] = dueToGo(data, { now });
    expect(due?.since).toBe(applied);
    expect(Date.parse(due!.at)).toBe(Date.parse(applied) + 7 * DAY);
  });

  /*
   * A number typed into a settings box has to have a safe reading at every
   * value somebody might type, and "0 days" read literally would delete
   * every temporary resume the moment it was saved.
   */
  it('is switched off by a window of zero or less, not made instant', () => {
    const data = store(
      [spec('job-x', { tier: 'temporary' })],
      [app('a1', { resumeId: 'job-x', appliedAt: new Date(now - 400 * DAY).toISOString() })],
    );
    expect(dueToGo(data, { now, days: 0 })).toEqual([]);
    expect(dueToGo(data, { now, days: -5 })).toEqual([]);
  });

  it('does not delete something because its date will not parse', () => {
    const data = store([spec('job-x', { tier: 'temporary', temporaryFrom: 'sometime last spring' })]);
    expect(dueToGo(data, { now })).toEqual([]);
  });
});

describe('a save being read before it has been migrated', () => {
  let temp: ReturnType<typeof makeTempStore>;
  beforeEach(() => { temp = makeTempStore(); });
  afterEach(() => temp.cleanup());

  it('has nothing due, because the clock has not been written down yet', () => {
    temp.write('resumes/job-old.yaml', {
      id: 'job-old',
      label: 'Old posting',
      generatedFor: { company: 'Acme', role: 'Dev', at: '2020-01-01T00:00:00.000Z' },
    });

    const data = temp.store.load();
    // Read as temporary, because that is what it is —
    expect(data.resumes.find((r) => r.id === 'job-old')?.tier).toBe('temporary');
    // — but the date stamped on it is this read's, so the week has not run.
    // The sweep deletes things, and it should not begin before the save has
    // actually been migrated and the date recorded.
    expect(dueToGo(data)).toEqual([]);
  });

  it('and the migration writes that clock down, starting it', () => {
    temp.write('resumes/job-old.yaml', {
      id: 'job-old',
      label: 'Old posting',
      generatedFor: { company: 'Acme', role: 'Dev', at: '2020-01-01T00:00:00.000Z' },
    });

    const { tiered } = temp.store.migrateResumes();

    expect(tiered).toContain('job-old');
    const written = temp.read('resumes/job-old.yaml') as ResumeSpec;
    expect(written.tier).toBe('temporary');
    expect(Date.parse(written.temporaryFrom ?? '')).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
  });
});
