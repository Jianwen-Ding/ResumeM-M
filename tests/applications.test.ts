import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { advance, alreadySent, applicationId, buildBundle, bundleFileName, bundleFileNames, describeLost, findApplication, findDraft, freshApplicationId, slug, stats } from '../src/model/applications.js';
import { syncCurrent } from '../src/model/current.js';
import type { Application } from '../src/model/types.js';
import { forgetCompiled } from '../src/render/compile.js';
import { hasLatex, makeTempStore, type TempStore } from './helpers.js';

const latex = await hasLatex();

let t: TempStore;
beforeEach(() => {
  t = makeTempStore();
});
afterEach(() => t.cleanup());

describe('file naming', () => {
  /*
   * FirstName-LastName-<Job Title>-<Document Type>.
   *
   * The role rather than the company: the role is what distinguishes two
   * applications someone actually has open at once, and a reviewer opening the
   * attachment already knows which company they are.
   */
  it('names files the way portals expect, so nothing is renamed by hand', () => {
    expect(bundleFileName('Jianwen Ding', 'Software Engineer', 'Resume')).toBe(
      'Jianwen-Ding-Software-Engineer-Resume.pdf',
    );
    expect(bundleFileName('Jianwen Ding', 'Software Engineer', 'Cover Letter')).toBe(
      'Jianwen-Ding-Software-Engineer-Cover-Letter.pdf',
    );
    expect(bundleFileName('Jianwen Ding', 'Software Engineer', 'Answers', { extension: '.md' })).toBe(
      'Jianwen-Ding-Software-Engineer-Answers.md',
    );
  });

  it('omits the job title when there is not one', () => {
    expect(bundleFileName('Jianwen Ding', undefined, 'Resume')).toBe('Jianwen-Ding-Resume.pdf');
    expect(bundleFileName('Jianwen Ding', '   ', 'Resume')).toBe('Jianwen-Ding-Resume.pdf');
  });

  it('strips punctuation a filesystem would object to', () => {
    expect(bundleFileName('Jianwen Ding', 'Engineer, II / Platform', 'Resume')).toBe(
      'Jianwen-Ding-Engineer-II-Platform-Resume.pdf',
    );
  });

  it('never produces a double hyphen or one hanging off an end', () => {
    expect(bundleFileName('  Jianwen   Ding ', ' -- Senior  Engineer -- ', 'Resume')).toBe(
      'Jianwen-Ding-Senior-Engineer-Resume.pdf',
    );
  });

  it('adds the company only where two names would otherwise clash', () => {
    // Not part of the shape: it appears when `out/current` would hold two
    // files with one name, and nowhere else.
    expect(bundleFileName('Jianwen Ding', 'Software Engineer', 'Resume', { disambiguator: 'Acme Co.' })).toBe(
      'Jianwen-Ding-Software-Engineer-Resume-Acme-Co.pdf',
    );
  });
});

/*
 * Naming one application's documents, without renaming everybody else's.
 *
 * The store has a default shape and it is a setting: change it and every
 * application from then on is called something different. What was missing is
 * the other thing — this posting wants the job title in the name, or this
 * portal will only take `resume.pdf`, and neither is a reason to change what
 * the next fifty applications are called.
 *
 * So the override lives on the application, is set per document, and three
 * things can be asked for: the title added, a name typed by hand, or back to
 * the default.
 */
describe('naming one application\'s documents', () => {
  const three = [{ kind: 'Resume' as const }, { kind: 'Cover Letter' as const }, { kind: 'Answers' as const, extension: '.md' }];

  it('adds the job title when that is what was asked for', () => {
    expect(bundleFileNames('Jianwen Ding', 'Software Engineer', three, 'title-type')).toEqual([
      'Jianwen-Ding-Software-Engineer-Resume.pdf',
      'Jianwen-Ding-Software-Engineer-Cover-Letter.pdf',
      'Jianwen-Ding-Software-Engineer-Answers.md',
    ]);
  });

  it('and leaves it out again', () => {
    expect(bundleFileNames('Jianwen Ding', 'Software Engineer', three, 'type')).toEqual([
      'Jianwen-Ding-Resume.pdf',
      'Jianwen-Ding-Cover-Letter.pdf',
      'Jianwen-Ding-Answers.md',
    ]);
  });

  it('takes a name typed by hand, for one document and not the rest', () => {
    expect(
      bundleFileNames('Jianwen Ding', 'Software Engineer', three, 'type', { Resume: 'resume' }),
    ).toEqual(['resume.pdf', 'Jianwen-Ding-Cover-Letter.pdf', 'Jianwen-Ding-Answers.md']);
  });

  /*
   * The extension is not the typist's to choose. A portal checks it, the
   * answers file is markdown and the rest are PDFs, and a resume called
   * `resume.docx` that is a PDF inside is a file that gets rejected at the
   * far end for a reason nobody can see.
   */
  it('keeps the extension the document actually has', () => {
    expect(bundleFileNames('Jianwen Ding', 'SWE', three, 'type', { Resume: 'resume.docx' })[0]).toBe('resume-docx.pdf');
    expect(bundleFileNames('Jianwen Ding', 'SWE', three, 'type', { Answers: 'notes' })[2]).toBe('notes.md');
  });

  /*
   * And a typed name is a name, not a path. This one arrives from a text box
   * on somebody else's page and ends up as a filename on disk, so it goes
   * through the same rules every other part of a name does.
   */
  it('cannot be talked into leaving the folder', () => {
    const out = bundleFileNames('Jianwen Ding', 'SWE', three, 'type', { Resume: '../../.ssh/authorized_keys' })[0]!;
    expect(out).not.toMatch(/[/\\]/);
    expect(out).not.toMatch(/\.\./);
    expect(out.endsWith('.pdf')).toBe(true);
  });

  it('falls back to the shape when what was typed sanitises away to nothing', () => {
    expect(bundleFileNames('Jianwen Ding', 'SWE', three, 'type', { Resume: '///' })[0]).toBe('Jianwen-Ding-Resume.pdf');
  });

  /*
   * Two documents, one name, and one of them typed: refused rather than
   * quietly mangled. A folder holds one file per name, so the alternative is
   * a document silently replacing another — which is the wrong-file-attached
   * failure the rest of this refuses to make. Named, so the message says
   * which other document is in the way.
   */
  it('refuses a typed name that another document in the same application already has', () => {
    expect(() =>
      bundleFileNames('Jianwen Ding', 'SWE', three, 'type', { 'Cover Letter': 'Jianwen-Ding-Resume' }),
    ).toThrow(/Jianwen-Ding-Resume\.pdf/);
  });

  /*
   * But the default shape goes on sorting itself out. `'title'` cannot tell a
   * resume from a cover letter, and adding the type back to the two that
   * clash is the store's own business — nobody typed those, so there is
   * nothing to refuse.
   */
  it('and still disambiguates the shapes, which nobody typed', () => {
    const [resume, letter] = bundleFileNames('Jianwen Ding', 'Software Engineer', three, 'title');
    expect(resume).not.toBe(letter);
    expect(resume).toBe('Jianwen-Ding-Software-Engineer-Resume.pdf');
  });
});

describe('slug and id', () => {
  it('makes a url-safe slug', () => {
    expect(slug('Acme Co. / Data Platform!')).toBe('acme-co-data-platform');
  });

  it('trims leading and trailing separators', () => {
    expect(slug('  --Hello--  ')).toBe('hello');
  });

  it('caps the length', () => {
    expect(slug('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it('builds a dated, readable application id', () => {
    expect(applicationId('Streamly', 'SWE Intern', new Date('2026-09-16T00:00:00Z'))).toBe(
      '2026-09-16-streamly-swe-intern',
    );
  });

  it('does not leave a trailing dash when the role is unprintable', () => {
    // A role the slug cannot represent gets a fingerprint instead, because
    // `!!!` and `???` are two different roles and the slug says so about
    // neither. What it must not do is trail off after the company.
    const id = applicationId('Acme', '!!!', new Date('2026-09-16T00:00:00Z'));
    expect(id).toMatch(/^2026-09-16-acme-[0-9a-f]{8}$/);
    expect(id).not.toBe(applicationId('Acme', '???', new Date('2026-09-16T00:00:00Z')));
  });
});

/*
 * Nine stages became five and an ending, and a store written by the version
 * with nine has to keep working — nobody's tracker should empty itself
 * because the vocabulary changed underneath it.
 */
describe('the stages that were retired', () => {
  it('reads an older file into the stages that are left', () => {
    t.store.saveApplications([
      { id: 'a', company: 'A', role: 'r', status: 'oa' as never },
      { id: 'b', company: 'B', role: 'r', status: 'rejected' as never },
      { id: 'c', company: 'C', role: 'r', status: 'ghosted' as never },
      { id: 'd', company: 'D', role: 'r', status: 'withdrawn' as never },
      { id: 'e', company: 'E', role: 'r', status: 'interview' },
      // Not a stage at all — a typo, or a file from somewhere else.
      { id: 'f', company: 'F', role: 'r', status: 'maybe?' as never },
    ]);

    const byId = new Map(t.store.load().applications.map((a) => [a.id, a.status]));
    // An assessment is an interview stage: they came back, and there is
    // something to prepare for.
    expect(byId.get('a')).toBe('interview');
    // Three ways of being over, which differed only in whose decision it was.
    expect(byId.get('b')).toBe('closed');
    expect(byId.get('c')).toBe('closed');
    expect(byId.get('d')).toBe('closed');
    expect(byId.get('e')).toBe('interview');
    expect(byId.get('f')).toBe('interested');
  });

  it('leaves the file alone until something else writes it', () => {
    t.store.saveApplications([{ id: 'a', company: 'A', role: 'r', status: 'ghosted' as never }]);
    t.store.load();
    expect(fs.readFileSync(path.join(t.dir, 'applications.yaml'), 'utf8')).toContain('ghosted');
  });
});

describe('status history', () => {
  beforeEach(() => {
    t.store.saveApplications([
      { id: 'a1', company: 'Acme', role: 'SWE', status: 'applied', appliedAt: '2026-09-01T00:00:00Z' },
    ]);
  });

  it('appends rather than overwriting, so the path through is kept', () => {
    advance(t.store, 'a1', 'interview', 'online assessment sent');
    const app = advance(t.store, 'a1', 'offer');
    expect(app.status).toBe('offer');
    expect(app.history).toHaveLength(2);
    expect(app.history?.[0]?.note).toBe('online assessment sent');
  });

  it('names the application that does not exist', () => {
    expect(() => advance(t.store, 'nope', 'applied')).toThrow(/nope/);
  });
});

/*
 * Which row a company and a role belong to.
 *
 * Tested on its own as well as through the build, because the two halves of
 * the fix — not taking a finished row, and not taking a finished row's id —
 * produce the same symptom through a build and are different rules.
 */
describe('which application this job is', () => {
  const rows: Application[] = [
    { id: 'march', company: 'Acme', role: 'Backend Engineer', status: 'closed', appliedAt: '2026-03-12T09:00:00Z' },
    { id: 'may', company: 'Lyra', role: 'Data Scientist', status: 'applied', appliedAt: '2026-05-01T09:00:00Z' },
    { id: 'open', company: 'Vega', role: 'Platform Engineer', status: 'applying' },
    { id: 'sent', company: 'Vega', role: 'Platform Engineer', status: 'applied', appliedAt: '2026-06-01T09:00:00Z' },
  ];

  it('is the one still being worked on, when there is one', () => {
    expect(findApplication(rows, 'Vega', 'Platform Engineer')?.id).toBe('open');
  });

  it('is the one already sent, when that is all there is', () => {
    // A build over a job already sent is "I spotted a typo, do that again",
    // and belongs in the folder the files are already in.
    expect(findApplication(rows, 'Lyra', 'Data Scientist')?.id).toBe('may');
  });

  it('is none of them when the only one is over', () => {
    // The whole of the change: a fresh attempt at a job that was turned down
    // is a new application, not an edit to the rejection.
    expect(findApplication(rows, 'Acme', 'Backend Engineer')).toBeUndefined();
  });

  it('is nothing at all for a job that has never been seen', () => {
    expect(findApplication(rows, 'Rigel', 'Backend Engineer')).toBeUndefined();
  });
});

describe('an id for an application that has none', () => {
  const today = applicationId('Acme', 'Backend Engineer');

  it('is the readable one when nothing has taken it', () => {
    expect(freshApplicationId([], 'Acme', 'Backend Engineer')).toBe(today);
  });

  /*
   * Turned down in the morning, reposted in the afternoon. The id is today's
   * date and the name, so the second attempt asks for the first one's — which
   * is the first one's tracker row and the first one's folder of sent files.
   */
  it('steps aside when the job was already applied for today', () => {
    const taken = [{ id: today, company: 'Acme', role: 'Backend Engineer', status: 'closed' } as Application];
    expect(freshApplicationId(taken, 'Acme', 'Backend Engineer')).toBe(`${today}-2`);
  });

  it('keeps counting rather than stopping at two', () => {
    const taken = [today, `${today}-2`, `${today}-3`].map(
      (id) => ({ id, company: 'Acme', role: 'Backend Engineer', status: 'closed' } as Application),
    );
    expect(freshApplicationId(taken, 'Acme', 'Backend Engineer')).toBe(`${today}-4`);
  });
});

describe('have I sent this one before', () => {
  const apps: Application[] = [
    { id: 'old', company: 'Helios', role: 'Platform Engineer', status: 'closed', appliedAt: '2026-03-12T09:00:00Z' },
    { id: 'new', company: 'Helios', role: 'Platform Engineer', status: 'applying', appliedAt: '2026-09-18T09:00:00Z' },
    { id: 'else', company: 'Lyra', role: 'Platform Engineer', status: 'applied', appliedAt: '2026-05-01T09:00:00Z' },
    { id: 'want', company: 'Vega', role: 'Data Scientist', status: 'interested', appliedAt: '2026-06-01T09:00:00Z' },
  ];

  it('answers with the one that went, not the one being written now', () => {
    // `findApplication` prefers the open row; this asks the opposite question
    // and must not be satisfied by the draft the person is in the middle of.
    expect(alreadySent(apps, 'Helios', 'Platform Engineer')?.id).toBe('old');
  });

  it('does not count an application that has only been thought about', () => {
    expect(alreadySent(apps, 'Vega', 'Data Scientist')).toBeUndefined();
  });

  it('is about this job, not this role anywhere', () => {
    expect(alreadySent(apps, 'Helios', 'Data Scientist')).toBeUndefined();
    expect(alreadySent(apps, 'Rigel', 'Platform Engineer')).toBeUndefined();
  });

  it('reads the company and the role the way ids are made, not letter by letter', () => {
    expect(alreadySent(apps, 'helios', 'platform  engineer')?.id).toBe('old');
  });

  it('takes the most recent when a job has been applied for more than once', () => {
    const twice: Application[] = [
      ...apps,
      { id: 'later', company: 'Helios', role: 'Platform Engineer', status: 'applied', appliedAt: '2026-08-01T09:00:00Z' },
    ];
    expect(alreadySent(twice, 'Helios', 'Platform Engineer')?.id).toBe('later');
  });

  it('has nothing to say about a store with nothing in it', () => {
    expect(alreadySent([], 'Helios', 'Platform Engineer')).toBeUndefined();
  });
});

describe('stats', () => {
  const now = Date.now();
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

  const apps: Application[] = [
    { id: '1', company: 'A', role: 'r', status: 'applied', appliedAt: daysAgo(1) },
    { id: '2', company: 'B', role: 'r', status: 'interview', appliedAt: daysAgo(3) },
    { id: '3', company: 'C', role: 'r', status: 'closed', appliedAt: daysAgo(20) },
    { id: '4', company: 'D', role: 'r', status: 'offer', appliedAt: daysAgo(40) },
    { id: '5', company: 'E', role: 'r', status: 'interested' },
  ];

  it('counts by status', () => {
    const s = stats(apps);
    expect(s.total).toBe(5);
    expect(s.byStatus.applied).toBe(1);
    expect(s.byStatus.interview).toBe(1);
  });

  it('counts recent windows', () => {
    const s = stats(apps);
    expect(s.last7).toBe(2);
    expect(s.last30).toBe(3);
  });

  it('excludes untouched leads from the response rate', () => {
    // 4 sent, 2 reached OA or beyond.
    expect(stats(apps).responseRate).toBe(50);
  });

  it('reports zero rather than dividing by zero', () => {
    expect(stats([]).responseRate).toBe(0);
    expect(stats([{ id: '1', company: 'A', role: 'r', status: 'interested' }]).responseRate).toBe(0);
  });
});

describe.skipIf(!latex)('bundles', { timeout: 180_000 }, () => {
  it('writes named files, a snapshot, and a tracker row', async () => {
    const result = await buildBundle(t.store, {
      company: 'Streamly',
      role: 'Software Engineer Intern',
      resumeId: 'intern',
      url: 'https://example.com/job',
      source: 'greenhouse',
    });

    expect(result.files).toContain('Test-Person-Resume.pdf');
    expect(fs.existsSync(path.join(result.dir, 'Test-Person-Resume.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'source', 'resume.tex'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'source', 'resolved.yaml'))).toBe(true);

    expect(result.application.company).toBe('Streamly');
    expect(result.application.status).toBe('applied');
    expect(result.application.snapshotDir).toContain('applications/');
    expect(t.store.load().applications).toHaveLength(1);
  });

  /*
   * Building the files again must not undo what the tracker knows.
   *
   * Survivable while the only caller was a person pressing the filing button
   * once. Building stages the files now — so that the folder you attach from
   * has something in it before the dialog opens — which means this runs on
   * every build, and three theoretical problems became ordinary ones.
   */
  describe('building again, over an application that already exists', () => {
    const staged = { company: 'Streamly', role: 'Intern', resumeId: 'intern', status: 'applying' as const };

    it('never moves the status backwards', async () => {
      await buildBundle(t.store, { ...staged, status: 'applied' });
      // The form was submitted on the page; a build lands afterwards.
      const again = await buildBundle(t.store, staged);
      expect(again.application.status).toBe('applied');
      expect(t.store.load().applications).toHaveLength(1);
    });

    /*
     * And not only when the submit lands before the build starts.
     *
     * "Never backwards" was checked against the row as it stood when the
     * build *began*, and a build is a LaTeX run — a second or two, which is
     * longer than it takes to press Submit. So the sequence that actually
     * happens on a real application is: staging starts, the form goes out,
     * the tracker records `applied`, and then the build lands and writes the
     * row back from a snapshot in which it was still `applying` — taking the
     * `applied` line out of the history with it, because that is rebuilt from
     * the same snapshot. Measured on the ATS walk at five of thirty-six
     * systems per run, a different five each time.
     *
     * Driven by waiting for the staging folder rather than by a timer. It is
     * made a few synchronous lines before the tracker row is read and nothing
     * between them yields, so a staging folder another task can see means the
     * build has read the row and is now compiling — which is exactly the
     * window this is about, on a fast machine and a slow one alike. The
     * `settled` check below is what makes the test honest: if the build
     * finished before the submit could land, this proved nothing.
     */
    it('nor when the form is submitted while the build is still compiling', async () => {
      /*
       * With the compile cache switched off for the length of this test.
       *
       * The window being tested is the length of a real LaTeX run, and a
       * cached build does not have one: a first run filled the cache and
       * every run after it finished in forty milliseconds, before the submit
       * could be recorded — so the test would have gone green for the one
       * reason that proves nothing. The cache is an opt-in read from the
       * environment on every compile, so taking it away here is enough.
       */
      const cache = process.env.RMM_COMPILE_CACHE;
      delete process.env.RMM_COMPILE_CACHE;
      /*
       * And out of this process's hands, which is the other cache and the one
       * that is not opt-in. It holds what it compiled for as long as the
       * process lives, so an earlier test in this file is enough to make the
       * build here instant — the same green-for-nothing this paragraph is
       * about, one layer down.
       */
      forgetCompiled();

      const req = { company: 'Streamly', role: 'Race', resumeId: 'intern', status: 'applying' as const };
      const id = applicationId(req.company, req.role);
      // The row as the extension leaves it when a workspace opens.
      t.store.upsertApplication({
        id,
        company: req.company,
        role: req.role,
        status: 'applying',
        history: [{ at: new Date().toISOString(), status: 'applying', note: 'Workspace opened' }],
      });

      let settled = false;
      const building = buildBundle(t.store, req);
      void building.then(() => {
        settled = true;
      });

      const staging = path.join(t.store.outDir(), 'applications');
      for (let i = 0; i < 2000 && !settled; i++) {
        const names = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
        if (names.some((n) => n.startsWith('.rmm-building-'))) break;
        await new Promise((done) => setTimeout(done, 5));
      }
      expect(settled, 'the build finished before the submit could land').toBe(false);

      advance(t.store, id, 'applied', 'The form was submitted on the page');
      const after = await building;

      if (cache !== undefined) process.env.RMM_COMPILE_CACHE = cache;

      expect(after.application.status).toBe('applied');
      expect((after.application.history ?? []).some((h) => h.note?.includes('submitted on the page'))).toBe(true);
      expect(t.store.load().applications.find((a) => a.id === id)?.status).toBe('applied');
    });

    it('but still moves it forwards when that is what was asked', async () => {
      await buildBundle(t.store, staged);
      const sent = await buildBundle(t.store, { ...staged, status: 'applied' });
      expect(sent.application.status).toBe('applied');
    });

    it('keeps the history rather than starting it again', async () => {
      await buildBundle(t.store, staged);
      const again = await buildBundle(t.store, { ...staged, status: 'applied' });
      expect(again.application.history?.length).toBeGreaterThan(1);
      expect(again.application.history?.[0]?.status).toBe('applying');
    });

    it('keeps the day it was applied for, rather than the day it was last built', async () => {
      const first = await buildBundle(t.store, { ...staged, status: 'applied' });
      const when = first.application.appliedAt;
      await new Promise((r) => setTimeout(r, 10));
      const again = await buildBundle(t.store, staged);
      expect(again.application.appliedAt).toBe(when);
    });

    /*
     * And keeps the rest of what the row knew.
     *
     * `status`, `history` and `appliedAt` were spared by hand; five fields
     * beside them were written back over with `undefined` whenever a caller
     * did not mention them. `rmm apply` passes company, role, url and the
     * resume id and nothing else, so every rebuild from the CLI erased the
     * source, the notes, the answers actually given and the letter actually
     * sent — from the tracker row and from the bundle — and logged it as
     * "Files rebuilt".
     */
    it('keeps the url, source, notes, answers and letter it was not asked about', async () => {
      await buildBundle(t.store, {
        ...staged,
        url: 'https://streamly.example/jobs/intern',
        source: 'JobHelper',
        notes: 'Referred by Sam.',
        answers: [{ question: 'Why us?', answer: 'The streaming work.' }],
        coverLetter: 'Dear Streamly,\n\nI would like to join.\n',
      });

      // The way `rmm apply` rebuilds: the names and the resume, nothing else.
      const again = await buildBundle(t.store, staged);
      expect(again.application.url).toBe('https://streamly.example/jobs/intern');
      expect(again.application.source).toBe('JobHelper');
      expect(again.application.notes).toBe('Referred by Sam.');
      expect(again.application.answers?.[0]?.answer).toBe('The streaming work.');
      expect(again.application.coverLetter).toContain('I would like to join');

      // On disk too, which is the copy that survives the process.
      const stored = t.store.load().applications.find((a) => a.id === again.application.id);
      expect(stored?.answers?.[0]?.question).toBe('Why us?');
      expect(stored?.url).toBe('https://streamly.example/jobs/intern');
    });

    /*
     * And the folder keeps them too, not only the row.
     *
     * The row learned to keep what the caller did not mention; the *files*
     * were still built from the request alone, and `handOver` deletes every
     * file in the destination the build did not write. So `rmm apply` — which
     * passes company, role, url and the resume id and nothing else — rebuilt
     * the bundle with the resume only, while the tracker row went on saying
     * `coverLetter: Dear Streamly, …`. The folder is the archive this tool
     * promises will still hold what was sent six weeks later, and the row and
     * the archive disagreeing is worse than either being wrong alone.
     */
    it('and the bundle folder keeps the letter and answers through a rebuild', async () => {
      const first = await buildBundle(t.store, {
        ...staged,
        coverLetter: 'Dear Streamly,\n\nI would like to join.\n',
        answers: [{ question: 'Why us?', answer: 'The streaming work.' }],
      });
      expect(first.files.join(' ')).toContain('Cover-Letter.pdf');

      // The way `rmm apply` rebuilds: the names and the resume, nothing else.
      const again = await buildBundle(t.store, staged);
      expect(again.files.join(' '), 'the letter is still in the bundle').toContain('Cover-Letter.pdf');
      expect(again.files.join(' '), 'and so are the answers').toContain('Answers.md');

      // On disk, which is the copy that is still there in six weeks.
      const held = fs.readdirSync(again.dir);
      expect(held.join(' ')).toContain('Cover-Letter.pdf');
      expect(held.join(' ')).toContain('Answers.md');
      const text = held.find((f) => f.endsWith('Cover-Letter.txt'))!;
      expect(fs.readFileSync(path.join(again.dir, text), 'utf8')).toContain('I would like to join');
    });

    it('but still lets a letter be taken back', async () => {
      // Absent means "leave it alone"; empty means "there is no letter". The
      // second has to stay sayable, or a letter could never be withdrawn.
      await buildBundle(t.store, { ...staged, coverLetter: 'Dear Streamly,\n\nHello.\n' });
      const cleared = await buildBundle(t.store, { ...staged, coverLetter: '' });
      expect(cleared.application.coverLetter).toBeUndefined();
    });
  });

  /*
   * A save with nobody's name in it.
   *
   * `profile.yaml` reads as `{ name: 'Your Name' }` when it is empty or not
   * there — which is what a crashed editor, a sync client, or a checkout of a
   * branch without it leaves behind, and also what a store looks like on the
   * day it is made. Every other unreadable file in the save is refused by
   * name with "nothing has been changed"; this one was accepted, and the
   * placeholder went the whole way.
   *
   * Measured on a real server before this was written: a PDF headed "Your
   * Name" with no email, no telephone and no links, named
   * `Your-Name-Resume.pdf`, filed as an application marked `applied`, and
   * copied into the flat folder a portal's file picker is pointed at. Every
   * step reported success. It is the one output of this program that is worse
   * than no output — not a blank where a name should be, but a template
   * somebody plainly did not finish.
   */
  describe('a save that still has the placeholder name in it', () => {
    const job = { company: 'Acme', role: 'Backend Engineer', resumeId: 'newgrad' };

    it('will not build anything at all', async () => {
      t.store.saveProfile({ name: 'Your Name' });
      await expect(buildBundle(t.store, job)).rejects.toThrow(/Your Name/);
    });

    it('says what to do about it, rather than naming a file', async () => {
      t.store.saveProfile({ name: 'Your Name' });
      const said = await buildBundle(t.store, job).catch((err: Error) => err.message);
      expect(said).toMatch(/put your name in/i);
      expect(said).not.toMatch(/profile\.yaml is not|undefined|\bnull\b/);
    });

    it('and the same when the file is empty or gone', async () => {
      // Which is how it reads: `load()` falls back to the placeholder rather
      // than refusing, so this is the shape of the real failure.
      fs.writeFileSync(path.join(t.dir, 'profile.yaml'), '');
      await expect(buildBundle(t.store, job)).rejects.toThrow(/Your Name/);
    });

    it('leaves nothing behind — no folder, no row, no upload', async () => {
      t.store.saveProfile({ name: 'Your Name' });
      await buildBundle(t.store, job).catch(() => undefined);

      expect(t.store.load().applications).toHaveLength(0);
      const out = t.store.outDir();
      expect(fs.existsSync(path.join(out, 'applications'))).toBe(false);
      expect(fs.existsSync(path.join(out, 'current'))).toBe(false);
    });

    /*
     * And a name that is somebody's still builds, which is the whole of the
     * rest of the program. Without this the safe reading of the above is to
     * stop building.
     */
    it('but a save with a name in it builds as it always did', async () => {
      const built = await buildBundle(t.store, job);
      expect(built.files.some((f) => f.endsWith('.pdf'))).toBe(true);
      expect(t.store.load().applications).toHaveLength(1);
    });

    /*
     * A blank name is the other half. It does not read as a template, it
     * reads as a fault in the PDF: a document with nothing on the top line.
     */
    it('will not build one with an empty name either', async () => {
      t.store.saveProfile({ name: '   ' });
      const said = await buildBundle(t.store, job).catch((err: Error) => err.message);
      expect(said).toMatch(/no name in it/i);
    });
  });

  /*
   * Applying again to a job that is over.
   *
   * The rule was written into `findApplication` from the start — "the same
   * job applied for twice a year apart is two applications" — and not done:
   * every row for that company and role matched, so the row a fresh attempt
   * was filed as was the one that had already been rejected.
   *
   * What that cost, measured: the new build landed in March's folder and the
   * hand-over sweep deleted the take-home brief kept in it; the tracker
   * showed one row, reading `closed` and dated March, with the new attempt's
   * files listed under it; and the row, being closed, dropped out of the flat
   * upload folder, so the documents just built were nowhere a file picker
   * would find them. Three separate ways of losing the same afternoon's work.
   */
  describe('applying again to a job that was already closed', () => {
    const job = { company: 'Acme', role: 'Backend Engineer' };

    /** March: applied, and turned down. */
    async function turnedDown() {
      const first = await buildBundle(t.store, { ...job, resumeId: 'newgrad' });
      // Something of theirs in the bundle folder — the brief they were sent,
      // kept beside what was sent back.
      fs.writeFileSync(path.join(first.dir, 'what-they-asked.md'), 'their take-home brief');
      const row = t.store.load().applications.find((a) => a.id === first.application.id)!;
      t.store.upsertApplication({
        ...row,
        status: 'closed',
        appliedAt: '2026-03-12T09:00:00Z',
        history: [...(row.history ?? []), { at: '2026-04-01T09:00:00Z', status: 'closed', note: 'Rejected' }],
      });
      return first;
    }

    it('files it as its own application, not as the one that failed', async () => {
      const first = await turnedDown();

      const second = await buildBundle(t.store, { ...job, resumeId: 'intern' });

      expect(second.application.id).not.toBe(first.application.id);
      expect(second.application.status).toBe('applied');
      // Not March's date on an application being sent today.
      expect(second.application.appliedAt).not.toBe('2026-03-12T09:00:00Z');
      expect(t.store.load().applications).toHaveLength(2);
    });

    it('leaves the first one, and its folder, exactly as it was', async () => {
      const first = await turnedDown();
      const before = fs.readdirSync(first.dir).sort();

      const second = await buildBundle(t.store, { ...job, resumeId: 'intern' });

      expect(second.dir).not.toBe(first.dir);
      expect(fs.readdirSync(first.dir).sort()).toEqual(before);
      // The one that is not ours to touch, and the one the sweep took.
      expect(fs.existsSync(path.join(first.dir, 'what-they-asked.md'))).toBe(true);
      const closed = t.store.load().applications.find((a) => a.id === first.application.id);
      expect(closed?.status).toBe('closed');
      expect(closed?.history).toHaveLength(2);
    });

    /*
     * And the id, which is today's date and the name. Turned down in the
     * morning, reposted in the afternoon: the second attempt asks for an id
     * the first one is already using, which is its tracker row and its folder.
     */
    it('takes an id of its own when the first one was today', async () => {
      const first = await buildBundle(t.store, { ...job, resumeId: 'newgrad' });
      const row = t.store.load().applications.find((a) => a.id === first.application.id)!;
      t.store.upsertApplication({ ...row, status: 'closed' });

      const second = await buildBundle(t.store, { ...job, resumeId: 'intern' });

      expect(second.application.id).toBe(`${first.application.id}-2`);
      expect(t.store.load().applications.map((a) => a.id).sort()).toEqual(
        [first.application.id, `${first.application.id}-2`].sort(),
      );
    });

    /*
     * The other half, which is why this is not simply "never reuse a row": a
     * build for a job already sent is the ordinary "I have spotted a typo, do
     * that again", and it belongs in the folder the files are already in.
     */
    it('but a rebuild of one that is still live is still the same application', async () => {
      const sent = await buildBundle(t.store, { ...job, resumeId: 'newgrad', status: 'applied' });

      const again = await buildBundle(t.store, { ...job, resumeId: 'intern' });

      expect(again.application.id).toBe(sent.application.id);
      expect(t.store.load().applications).toHaveLength(1);
    });
  });

  /*
   * What the hand-over sweep is for, and what it costs.
   *
   * The bundle folder mirrors what you are sending *now*: the build that
   * lands removes anything it did not produce, so a letter you deleted stops
   * being in the folder you attach from. That is right, and it is also why
   * two builds of one application must not overlap — a build without a letter
   * landing after one with a letter would take the letter with it. They are
   * serialised for that reason; see `inBuildLane`.
   *
   * Said with an empty letter rather than an absent one, and the difference
   * is the whole of a bug. This used to read absence as deletion, which is
   * fine for the card — it sends `coverLetter: state.letter` on every build,
   * so it says "no letter" as `null` and never by omission — and wrong for
   * every other caller. `rmm apply` passes company, role, url and the resume
   * id and nothing else, so it meant "rebuild the files" and was heard as
   * "and throw the letter away": the folder came back holding one PDF while
   * the tracker row still read `coverLetter: Dear Streamly, …`. The folder is
   * the archive, and the row and the archive disagreeing is worse than either
   * being wrong alone.
   *
   * So: mentioned and empty clears it, mentioned and set replaces it, absent
   * leaves it alone.
   */
  it('mirrors what is being sent now, rather than accumulating', async () => {
    const req = { company: 'Streamly', role: 'Intern', resumeId: 'intern', status: 'applying' as const };
    const withLetter = await buildBundle(t.store, { ...req, coverLetter: 'Dear Streamly, this is the letter.' });
    expect(fs.readdirSync(withLetter.dir)).toContain('Test-Person-Cover-Letter.pdf');

    // The card's own way of saying the letter is gone.
    const without = await buildBundle(t.store, { ...req, coverLetter: '' });
    expect(fs.readdirSync(without.dir)).not.toContain('Test-Person-Cover-Letter.pdf');
    // And the answer describes the folder that exists, which is what the card
    // prints under "named and ready to attach".
    expect([...without.files].sort()).toEqual(fs.readdirSync(without.dir).filter((f) => f !== 'source').sort());
  });

  /*
   * `null` says it too, because that is literally what arrives: the card
   * sends `coverLetter: state.letter`, and `state.letter` is null on every
   * posting that does not ask for one.
   */
  it('takes null as "there is no letter", the way the card sends it', async () => {
    const req = { company: 'Streamly', role: 'Intern', resumeId: 'intern', status: 'applying' as const };
    await buildBundle(t.store, { ...req, coverLetter: 'Dear Streamly, this is the letter.' });

    const cleared = await buildBundle(t.store, { ...req, coverLetter: null as unknown as string });
    expect(fs.readdirSync(cleared.dir)).not.toContain('Test-Person-Cover-Letter.pdf');
    expect(cleared.application.coverLetter).toBeUndefined();
  });

  it('freezes the choices that were actually used', async () => {
    const result = await buildBundle(t.store, { company: 'Acme', role: 'Intern', resumeId: 'intern' });
    const snapshot = YAML.parse(fs.readFileSync(path.join(result.dir, 'source', 'resolved.yaml'), 'utf8'));
    // `intern` selects the December graduation date; the snapshot must show it
    // even if the store changes later.
    const education = snapshot.resolved.sections.find((s: { kind: string }) => s.kind === 'education');
    expect(education.entries[0].dates).toContain('Dec. 2026');
  });

  /*
   * And the spec beside it, from the same moment.
   *
   * The two are a pair: the spec is what was selected and `resolved` is what
   * that came out as. This read the spec back off disk after compiling, so a
   * resume removed while the document was being built — which the sweep does
   * on its own, to a resume made for one posting — left the snapshot holding
   * `spec: undefined` beside a perfectly good resolved document. A record of
   * something that never existed, in the one file that exists so a past
   * application can be reopened.
   */
  it('freezes the selection beside the document, even if the resume goes', async () => {
    /*
     * Deleted *while* the bundle is being built, not after it — which is the
     * only arrangement that tells the two readings apart. Compiling is the
     * slow part and runs in a subprocess, so the delete lands in the middle
     * of it, exactly as the sweep would.
     */
    const building = buildBundle(t.store, { company: 'Acme', role: 'Intern', resumeId: 'intern' });
    await new Promise((r) => setTimeout(r, 50));
    t.store.deleteResume('intern');
    const result = await building;

    const snapshot = YAML.parse(fs.readFileSync(path.join(result.dir, 'source', 'resolved.yaml'), 'utf8'));
    expect(snapshot.spec).toBeTruthy();
    expect(snapshot.spec.id).toBe('intern');
    // And it is the selection the resolved document was actually built from.
    expect(snapshot.spec.choices?.['edu_neu.dates']).toBe('v_dec2026');
  });

  it('writes a cover letter and answers when supplied', async () => {
    const result = await buildBundle(t.store, {
      company: 'Streamly',
      role: 'Intern',
      resumeId: 'intern',
      coverLetter: 'Dear Streamly,\n\nHere is why.',
      answers: [{ question: 'Why us?', answer: 'Because.' }],
    });

    // A typeset PDF for the portals that take an upload, and the plain text
    // for the ones with a paste-it-in box.
    expect(result.files).toContain('Test-Person-Cover-Letter.pdf');
    expect(result.files).toContain('Test-Person-Cover-Letter.txt');
    const letterPdf = fs.readFileSync(path.join(result.dir, 'Test-Person-Cover-Letter.pdf'));
    expect(letterPdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(fs.existsSync(path.join(result.dir, 'source', 'cover-letter.tex'))).toBe(true);

    expect(result.files).toContain('Test-Person-Answers.md');
    const qa = fs.readFileSync(path.join(result.dir, 'Test-Person-Answers.md'), 'utf8');
    expect(qa).toContain('## Why us?');
    expect(qa).toContain('Because.');
    /*
     * And says whose questions these are. The resume and the letter are
     * attachments nobody opens again; this is the file you sit with, copying
     * answers into boxes, often beside another application's — and it began
     * straight in at "## Why us?" with nothing saying who was asking.
     */
    expect(qa.split('\n')[0]).toBe('# Streamly — Intern');
  });

  it('skips an empty cover letter rather than writing a blank file', async () => {
    const result = await buildBundle(t.store, {
      company: 'Acme',
      role: 'Intern',
      resumeId: 'intern',
      coverLetter: '   ',
    });
    expect(result.files.some((f) => f.includes('Cover Letter'))).toBe(false);
  });

  it('honours an explicit status', async () => {
    const result = await buildBundle(t.store, {
      company: 'Acme',
      role: 'Intern',
      resumeId: 'intern',
      status: 'interested',
    });
    expect(result.application.status).toBe('interested');
  });
});

/** What a person sees in the folder: the uploads, not the bookkeeping. */
const visible = (dir: string) => fs.readdirSync(dir).filter((f) => !f.startsWith('.'));

/*
 * One application handing its filename to another, which is the ordinary
 * shape of applying to two jobs.
 *
 * Every application produces the same `First-Last-Resume.pdf` under the
 * default naming, so when one is in flight at a time they take turns holding
 * that name. Freshness was decided by timestamp alone, and a timestamp cannot
 * tell two applications apart: prepare Beta, prepare Acme, send Acme, then
 * send Beta, and Beta's bundle is *older* than the copy of Acme's already
 * sitting in the folder. Nothing was copied and nothing was reported — the
 * Applications tab said one application was in flight with its resume ready,
 * and the folder a portal's file dialog is pointed at held the other job's
 * tailored resume.
 *
 * Bundles are written by hand here rather than compiled. Going through
 * `buildBundle` syncs the folder as a side effect, which changes the state
 * this is about — the first version of this test did that and passed with the
 * fix removed.
 */
describe('one application taking over another’s filename', () => {
  const NAME = 'Test-Person-Resume.pdf';

  /** A bundle folder on disk, with a mtime we choose. */
  const bundle = (dir: string, body: string, at: Date) => {
    const full = path.join(t.store.outDir(), 'applications', dir);
    fs.mkdirSync(full, { recursive: true });
    const file = path.join(full, NAME);
    fs.writeFileSync(file, body);
    fs.utimesSync(file, at, at);
    return `applications/${dir}`;
  };

  const app = (id: string, company: string, status: string, snapshotDir: string) =>
    ({ id, company, role: 'Intern', status, snapshotDir }) as unknown as Application;

  const held = () => fs.readFileSync(path.join(t.store.outDir(), 'current', NAME), 'utf8');

  it('replaces it even when the arriving bundle is the older one', () => {
    const beta = bundle('beta', 'BETA', new Date('2026-01-01T00:00:00Z'));
    const acme = bundle('acme', 'ACME', new Date('2026-06-01T00:00:00Z'));

    syncCurrent(t.store, [app('acme', 'Acme', 'applying', acme), app('beta', 'Beta', 'interested', beta)]);
    expect(held()).toBe('ACME');

    const after = syncCurrent(t.store, [
      app('acme', 'Acme', 'interview', acme),
      app('beta', 'Beta', 'applying', beta),
    ]);
    expect(held()).toBe('BETA');
    expect(after.problems ?? []).toEqual([]);
  });

  /*
   * And a folder synced before the manifest recorded where files came from.
   * The old manifest has `files` and no `from`, so every name reads as
   * "copied from somewhere else" and is written once more on the next sync:
   * one redundant copy, then right from then on.
   */
  it('recovers a folder whose manifest predates knowing where files came from', () => {
    const beta = bundle('beta', 'BETA', new Date('2026-01-01T00:00:00Z'));
    const acme = bundle('acme', 'ACME', new Date('2026-06-01T00:00:00Z'));

    const first = syncCurrent(t.store, [
      app('acme', 'Acme', 'applying', acme),
      app('beta', 'Beta', 'interested', beta),
    ]);
    const manifest = path.join(first.dir, '.rmm-current.json');
    fs.writeFileSync(manifest, JSON.stringify({ files: first.files }, null, 2), 'utf8');

    syncCurrent(t.store, [app('acme', 'Acme', 'interview', acme), app('beta', 'Beta', 'applying', beta)]);
    expect(held()).toBe('BETA');
    // And the manifest is the new shape now, so the next sync is exact.
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).from[NAME]).toContain('beta');
  });
});

describe.skipIf(!latex)('the flat folder of what is in flight', { timeout: 180_000 }, () => {
  const bundleFor = (company: string, status?: string) =>
    buildBundle(t.store, {
      company,
      role: 'Intern',
      resumeId: 'intern',
      coverLetter: 'Dear reader,',
      ...(status ? { status: status as never } : {}),
    });

  it('collects the files of every application still being sent', async () => {
    await bundleFor('Streamly');
    await bundleFor('Northwind');

    const current = syncCurrent(t.store);
    expect(current.applications).toBe(2);
    // Same role at two companies is the one clash the shape cannot separate,
    // so the company is added — to the one built second. The first is still
    // being worked on and keeps the name it was given; see `uniqueNames`.
    expect(current.files).toContain('Test-Person-Resume.pdf');
    expect(current.belongsTo['Test-Person-Resume.pdf']).toMatch(/streamly/);
    expect(current.files).toContain('Test-Person-Resume-Northwind.pdf');
    // All in one place, not one folder per application. (The dotfile is the
    // manifest of what this folder put here; it is not one of your uploads.)
    expect(visible(current.dir).length).toBe(current.files.length);
  });

  it('leaves the archived folders exactly as they were', async () => {
    const result = await bundleFor('Streamly');
    syncCurrent(t.store);
    expect(fs.existsSync(path.join(result.dir, 'Test-Person-Resume.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'source', 'resume.tex'))).toBe(true);
  });

  it('does not copy the archive material nobody uploads', async () => {
    await bundleFor('Streamly');
    const current = syncCurrent(t.store);
    expect(current.files).not.toContain('source');
    expect(fs.existsSync(path.join(current.dir, 'source'))).toBe(false);
  });

  it('takes an application out once it has moved past sending', async () => {
    const result = await bundleFor('Streamly');
    expect(syncCurrent(t.store).files.length).toBeGreaterThan(0);

    advance(t.store, result.application.id, 'closed');
    const after = syncCurrent(t.store);
    expect(after.files).toEqual([]);
    expect(visible(after.dir)).toEqual([]);
  });

  it('separates "nothing in flight" from "in flight but never built"', async () => {
    // An empty folder means two different things, and only the count of
    // in-flight applications tells them apart.
    expect(syncCurrent(t.store)).toMatchObject({ files: [], applications: 0, inFlight: 0 });

    t.store.upsertApplication({ id: 'a1', company: 'Acme', role: 'Intern', status: 'applying' });
    const current = syncCurrent(t.store);
    expect(current.files).toEqual([]);
    expect(current.applications).toBe(0); // nothing built yet
    expect(current.inFlight).toBe(1);
  });

  it('keeps an application that is still being written', async () => {
    const result = await bundleFor('Streamly');
    advance(t.store, result.application.id, 'applying');
    expect(syncCurrent(t.store).files.length).toBeGreaterThan(0);
  });

  /*
   * Rebuilding an application replaces its bundle rather than adding to it.
   * The id is company, role and date, so a second build the same day writes to
   * the same folder — and every file whose name changed in between used to sit
   * beside its replacement, then get copied into the upload folder alongside
   * it. Two resumes for one job, in the folder whose whole point is that the
   * file in front of you is the one to send.
   */
  it('is rebuilt from the tracker, so a file it placed and no longer wants goes', async () => {
    await bundleFor('Streamly');
    const current = syncCurrent(t.store);
    expect(current.files).toContain('Test-Person-Resume.pdf');

    t.write('profile.yaml', { name: 'Test Personne', email: 'test@example.com' });
    await bundleFor('Streamly');

    const after = syncCurrent(t.store);
    expect(after.files).toContain('Test-Personne-Resume.pdf');
    expect(after.files).not.toContain('Test-Person-Resume.pdf');
    expect(fs.existsSync(path.join(current.dir, 'Test-Person-Resume.pdf'))).toBe(false);
  });

  /*
   * The folder you point the file picker at is a folder people keep things in.
   * Rebuilding it used to mean deleting every name not currently wanted, which
   * is every file the user ever put there — and a plain GET of the Applications
   * tab was enough to do it. The comment in current.ts already claimed this was
   * the rule; nothing implemented it until there was a manifest.
   */
  it('never removes a file it did not put there', async () => {
    await bundleFor('Streamly');
    const current = syncCurrent(t.store);

    const mine = path.join(current.dir, 'Transcript.pdf');
    fs.writeFileSync(mine, 'my transcript');
    fs.mkdirSync(path.join(current.dir, 'transcripts'), { recursive: true });
    fs.writeFileSync(path.join(current.dir, 'transcripts', 'a.pdf'), 'x');

    // A subdirectory also used to throw EISDIR out of rmSync and take the whole
    // Applications tab down with it, after the bundle had already been written.
    const after = syncCurrent(t.store);
    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.existsSync(path.join(current.dir, 'transcripts', 'a.pdf'))).toBe(true);
    expect(after.files).toContain('Test-Person-Resume.pdf');
    expect(after.files).not.toContain('Transcript.pdf');
  });

  /*
   * A manifest entry that is not a file in this folder.
   *
   * Every entry is handed to a recursive delete, so the filter exists to keep
   * a hand edit or a bad merge from turning the sync into `rm -r` on
   * something nobody meant. It refused `..` and let `.` through — and `.` is
   * the worse of the two: `path.basename('.')` is `'.'`, so it looked like a
   * plain name, and `path.join(dir, '.')` is the folder itself. One line in a
   * JSON file and the sync deleted the whole upload folder, including the
   * transcript its own documentation invites the user to keep there.
   */
  it('will not delete the upload folder on a manifest entry of "." or ".."', async () => {
    await bundleFor('Streamly');
    const current = syncCurrent(t.store);
    const mine = path.join(current.dir, 'Transcript.pdf');
    fs.writeFileSync(mine, 'my transcript');

    const manifest = path.join(current.dir, '.rmm-current.json');
    const held = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    fs.writeFileSync(manifest, JSON.stringify({ ...held, files: ['.', '..', ...held.files] }), 'utf8');

    const after = syncCurrent(t.store);
    expect(fs.existsSync(current.dir)).toBe(true);
    expect(fs.existsSync(mine)).toBe(true);
    expect(after.files).toContain('Test-Person-Resume.pdf');
  });

  /*
   * And the same again through the other half of the manifest.
   *
   * `files` has been filtered since the day it was written, and its comment
   * says why: every entry is handed to a recursive delete. `from` was exempt
   * on the stated grounds that it is "only ever compared, never opened and
   * never deleted" — which stopped being true when `owned` grew to
   * `[...ours, ...Object.keys(cameFrom)]`. Its keys reach the same
   * `fs.rmSync(..., { recursive: true, force: true })`, unfiltered, and
   * `out/current`'s parent is `out/` — every archived bundle, which is the
   * six-weeks-later "what did I actually send" record.
   *
   * One hand edit or one bad merge, in a file that sits in a folder the user
   * is invited to open.
   */
  /*
   * A file of your own, left alone — and then taken on the sync after.
   *
   * The refusal above it says so in as many words, and names the exact way it
   * used to go wrong: "the name then went into the manifest, so the *next*
   * sync would have deleted it as ours." The refusal itself put it there.
   * Every failure was recorded under one `FAILED` sentinel, which is right
   * for an EBUSY or a full disk — those are ours to retry — and exactly wrong
   * for "this belongs to the user", which is never ours to retry. On the next
   * sync the name is in `from`, so it is in `claimed`, so the guard is
   * skipped.
   *
   * Two ways it ends, both silent: the bundle still wants the name and
   * overwrites it, or the application has moved on and the delete loop takes
   * it as a stale file of ours.
   */
  it('leaves a file of your own alone on every sync, not just the first', async () => {
    // A folder with a manifest that claims nothing — an application filed and
    // since moved on, which is the ordinary way to arrive here.
    const current = syncCurrent(t.store);
    expect(fs.existsSync(path.join(current.dir, '.rmm-current.json'))).toBe(true);

    const mine = path.join(current.dir, 'Test-Person-Resume.pdf');
    fs.writeFileSync(mine, 'the one I polished by hand');

    await bundleFor('Streamly');
    const first = syncCurrent(t.store);
    expect(first.problems?.join(' ')).toMatch(/a file of your own/);
    expect(fs.readFileSync(mine, 'utf8')).toBe('the one I polished by hand');

    // Nothing has changed since. Saying it again is the only honest answer.
    const second = syncCurrent(t.store);
    expect(fs.readFileSync(mine, 'utf8')).toBe('the one I polished by hand');
    expect(second.problems?.join(' ')).toMatch(/a file of your own/);
  });

  /*
   * And the other ending: the application moves on, so nothing wants the name
   * any more, and the delete loop finds it listed as ours.
   */
  it('does not sweep away a file of your own once the application moves on', async () => {
    const current = syncCurrent(t.store);
    const mine = path.join(current.dir, 'Test-Person-Resume.pdf');
    fs.writeFileSync(mine, 'the one I polished by hand');

    await bundleFor('Streamly');
    expect(syncCurrent(t.store).problems?.join(' ')).toMatch(/a file of your own/);

    // Filed and gone to interview: the flat folder should hold nothing of its.
    await bundleFor('Streamly', 'interview');
    syncCurrent(t.store);
    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.readFileSync(mine, 'utf8')).toBe('the one I polished by hand');
  });

  it('will not delete the output folder on a source entry of "." or ".."', async () => {
    await bundleFor('Streamly');
    const current = syncCurrent(t.store);
    const out = path.dirname(current.dir);
    const mine = path.join(current.dir, 'Transcript.pdf');
    fs.writeFileSync(mine, 'my transcript');
    // An archived bundle, which is what lives beside `current` under `out/`.
    const archive = path.join(out, 'applications');
    expect(fs.existsSync(archive)).toBe(true);

    const manifest = path.join(current.dir, '.rmm-current.json');
    const held = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    fs.writeFileSync(
      manifest,
      JSON.stringify({ ...held, from: { ...held.from, '.': 'x', '..': 'x' } }),
      'utf8',
    );

    const after = syncCurrent(t.store);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.existsSync(current.dir)).toBe(true);
    expect(fs.existsSync(mine)).toBe(true);
    expect(after.files).toContain('Test-Person-Resume.pdf');
  });

  /*
   * Two roles at one company, both in flight. bundleFileName puts the person
   * and the company in the name but not the role, and the answers file is
   * called `application-answers.md` flat — fine inside a per-application
   * folder, fatal in a shared one. The last writer won, the tracker still
   * reported two applications in flight, and the portal open in front of you
   * got the other job's resume and the other job's answers.
   */
  it('gives two roles at one company a file each', async () => {
    await buildBundle(t.store, {
      company: 'Acme',
      role: 'Software Engineer',
      resumeId: 'intern',
      answers: [{ question: 'Why?', answer: 'I love engineering at Acme.' }],
    });
    await buildBundle(t.store, {
      company: 'Acme',
      role: 'Product Manager',
      resumeId: 'intern',
      answers: [{ question: 'Why?', answer: 'I love product at Acme.' }],
    });

    const current = syncCurrent(t.store);
    expect(current.applications).toBe(2);

    // Every name distinct, and every one of them actually on disk.
    expect(new Set(current.files).size).toBe(current.files.length);
    for (const f of current.files) expect(fs.existsSync(path.join(current.dir, f))).toBe(true);

    /*
     * With the job title off — the default — both of these want the same name,
     * so the suffix has to be the thing that actually tells them apart. The
     * company does not; the role does.
     */
    const resumes = current.files.filter((f) => /Resume/.test(f));
    expect(resumes).toHaveLength(2);
    // The first keeps the plain name it was given while it is still being
    // worked on; see `uniqueNames`.
    expect(resumes).toContain('Test-Person-Resume.pdf');
    expect(resumes).toContain('Test-Person-Resume-Product-Manager.pdf');

    // And the answers are two files, holding different answers.
    const answers = current.files.filter((f) => f.endsWith('.md'));
    expect(answers).toHaveLength(2);
    const text = answers.map((f) => fs.readFileSync(path.join(current.dir, f), 'utf8'));
    expect(text.some((x) => /engineering/.test(x))).toBe(true);
    expect(text.some((x) => /product/.test(x))).toBe(true);
  });
});

/*
 * The job title in a filename is a setting, because most of the time it is
 * noise: the reviewer opening the attachment already knows which role they
 * advertised. It earns its place when several applications are open at once.
 */
describe.skipIf(!latex)('putting the job title in file names', { timeout: 180_000 }, () => {
  const shaped = (fileNames: 'type' | 'title' | 'title-type') =>
    t.write('config.yaml', {
      ai: { enabled: false },
      git: { autoCommit: false },
      output: { dir: 'out', fileNames },
    });
  const withTitle = (on: boolean) => shaped(on ? 'title-type' : 'type');

  it('leaves it out by default', async () => {
    const result = await buildBundle(t.store, {
      company: 'Streamly',
      role: 'Data Platform Intern',
      resumeId: 'intern',
      coverLetter: 'Dear Streamly,',
      answers: [{ question: 'Why?', answer: 'Because.' }],
    });
    expect(result.files).toContain('Test-Person-Resume.pdf');
    expect(result.files).toContain('Test-Person-Cover-Letter.pdf');
    expect(result.files).toContain('Test-Person-Answers.md');
  });

  it('puts it in when the setting asks for it', async () => {
    withTitle(true);
    const result = await buildBundle(t.store, {
      company: 'Streamly',
      role: 'Data Platform Intern',
      resumeId: 'intern',
      coverLetter: 'Dear Streamly,',
      answers: [{ question: 'Why?', answer: 'Because.' }],
    });
    expect(result.files).toContain('Test-Person-Data-Platform-Intern-Resume.pdf');
    expect(result.files).toContain('Test-Person-Data-Platform-Intern-Cover-Letter.pdf');
    expect(result.files).toContain('Test-Person-Data-Platform-Intern-Answers.md');
  });

  /*
   * The third shape leaves the document type out, which is the shortest name
   * and the one that cannot tell two documents of one application apart. The
   * resume and the cover letter would both be
   * `Test-Person-Data-Platform-Intern.pdf`, and the second would quietly
   * replace the first in the folder you upload from.
   */
  it('brings the type back only where a name would otherwise be claimed twice', async () => {
    shaped('title');
    const result = await buildBundle(t.store, {
      company: 'Streamly',
      role: 'Data Platform Intern',
      resumeId: 'intern',
      coverLetter: 'Dear Streamly,',
      answers: [{ question: 'Why?', answer: 'Because.' }],
    });

    // The two PDFs would have collided, so both say which they are.
    expect(result.files).toContain('Test-Person-Data-Platform-Intern-Resume.pdf');
    expect(result.files).toContain('Test-Person-Data-Platform-Intern-Cover-Letter.pdf');
    // The answers file never clashed — a different extension — so it stays short.
    expect(result.files).toContain('Test-Person-Data-Platform-Intern.md');
  });

  /*
   * And the same name whether or not the letter was written this time. Deciding
   * from what the bundle happens to contain would mean a resume built alone is
   * `…-Intern.pdf` and the same resume rebuilt with a letter is
   * `…-Intern-Resume.pdf` — the file renaming itself for a reason that has
   * nothing to do with it, in the folder you upload from.
   */
  it('names the resume the same whether or not a letter came with it', async () => {
    shaped('title');
    const alone = await buildBundle(t.store, {
      company: 'Streamly',
      role: 'Data Platform Intern',
      resumeId: 'intern',
    });
    expect(alone.files).toEqual(['Test-Person-Data-Platform-Intern-Resume.pdf']);

    const together = await buildBundle(t.store, {
      company: 'Streamly',
      role: 'Data Platform Intern',
      resumeId: 'intern',
      coverLetter: 'Dear Streamly,',
    });
    expect(together.files[0]).toBe('Test-Person-Data-Platform-Intern-Resume.pdf');
  });

  /*
   * Neither shape is unique on its own — without the title two roles at one
   * company clash, with it the same role at two companies does — so the flat
   * folder adds whichever of the two actually tells them apart.
   */
  it('separates two roles at one company when the title is off', async () => {
    for (const role of ['Software Engineer', 'Product Manager']) {
      await buildBundle(t.store, { company: 'Acme', role, resumeId: 'intern' });
    }
    const resumes = syncCurrent(t.store).files.filter((f) => f.endsWith('.pdf'));
    expect(resumes).toHaveLength(2);
    expect(resumes).toContain('Test-Person-Resume.pdf');
    expect(resumes).toContain('Test-Person-Resume-Product-Manager.pdf');
  });

  it('separates one role at two companies when the title is on', async () => {
    withTitle(true);
    for (const company of ['Acme', 'Globex']) {
      await buildBundle(t.store, { company, role: 'Software Engineer', resumeId: 'intern' });
    }
    const resumes = syncCurrent(t.store).files.filter((f) => f.endsWith('.pdf'));
    expect(resumes).toHaveLength(2);
    expect(resumes).toContain('Test-Person-Software-Engineer-Resume.pdf');
    expect(resumes).toContain('Test-Person-Software-Engineer-Resume-Globex.pdf');
  });
});


/*
 * A resume built from a proposal the store has moved on from.
 *
 * The browser extension makes its proposal minutes — or pages, or a trip to
 * the editor and back — before the folder is written, and the store can
 * change in between. That is not an error: the resume still compiles, it is
 * simply no longer the one that was on screen. Nothing said so, and the card
 * announced "these files are named and ready to attach" over a resume with
 * somebody's main job missing from it.
 */
describe('saying what the store no longer has', () => {
  it('counts rather than naming ids', () => {
    expect(describeLost([])).toBeUndefined();
    expect(describeLost([{ kind: 'entry' }])).toBe('1 entry this resume chose is no longer in your store.');
    expect(describeLost([{ kind: 'wording' }, { kind: 'wording' }])).toBe(
      '2 wordings this resume chose are no longer in your store.',
    );
    expect(describeLost([{ kind: 'entry' }, { kind: 'wording' }])).toBe(
      '1 entry and 1 wording this resume chose are no longer in your store.',
    );
  });

  it.skipIf(!latex)('reports it on the bundle, without stopping it', { timeout: 180_000 }, async () => {
    t.store.saveResume({
      id: 'stale',
      label: 'Built before the change',
      sections: [{ kind: 'experience', entries: ['exp_acme', 'exp_gone'] }],
      choices: { b_renamed_since: 'v_1' },
    });

    const result = await buildBundle(t.store, { company: 'Meridian', role: 'Platform Engineer', resumeId: 'stale' });

    // Written, because a resume missing one entry is still a resume, and
    // refusing to write it would leave somebody with nothing to attach.
    expect(result.files.some((f) => f.endsWith('.pdf'))).toBe(true);
    expect(result.missing).toBe('1 entry and 1 wording this resume chose are no longer in your store.');

    // And the sentence is about the store, not about this machine's LaTeX —
    // which is what the warnings beside it are for.
    expect(result.missing).not.toMatch(/ligature|font/i);
  });

  /*
   * What was done to the resume to get it onto a page, in the bundle that
   * gets attached and sent.
   *
   * Auto-fit shrinks the font, the spacing and the margins until the least
   * shrinking that fits is found, and the editor says so under the preview:
   * "Squeezed to fit — font 10.5pt → 9.8pt". The files that actually go out
   * said nothing, so a resume set smaller than the author would have accepted
   * — the floor is low — went into the upload folder looking, from the
   * response, exactly like one that fitted as written.
   *
   * Provoked with margins rather than with content, because the fit loop is
   * what is under test and a page of invented bullets would only be a slower
   * way of reaching it.
   */
  /*
   * And the name survives a rebuild.
   *
   * A build that is not told what to call things keeps what the application
   * was already using. Without that, pressing Recompile after renaming a file
   * puts the old name back — on the file in the folder somebody has been
   * dragging into a form, which is the one place a name changing underneath
   * you costs an attachment.
   */
  it.skipIf(!latex)('keeps a name it was given on the next build', { timeout: 180_000 }, async () => {
    const named = await buildBundle(t.store, {
      company: 'Meridian',
      role: 'Platform Engineer',
      resumeId: 'intern',
      naming: { custom: { Resume: 'resume' } },
    });
    expect(named.files).toContain('resume.pdf');

    // Built again, saying nothing about names — as Recompile does.
    const again = await buildBundle(t.store, {
      company: 'Meridian',
      role: 'Platform Engineer',
      resumeId: 'intern',
    });
    expect(again.files).toContain('resume.pdf');
    expect(again.application.naming?.custom?.Resume).toBe('resume');
  });

  it.skipIf(!latex)('says when the resume had to be squeezed to fit', { timeout: 180_000 }, async () => {
    const tight = makeTempStore({
      config: {
        ai: { enabled: false },
        git: { autoCommit: false },
        output: { dir: 'out' },
        layout: { marginIn: 3.6 },
      },
    });
    try {
      const result = await buildBundle(tight.store, {
        company: 'Meridian',
        role: 'Platform Engineer',
        resumeId: 'intern',
      });
      expect(result.fits, 'the squeezing worked, or this is the other case').toBe(true);
      const said = result.warnings.join(' | ');
      expect(said, said).toMatch(/squeezed to fit/i);
      // And names what moved, rather than saying only that something did.
      expect(said).toMatch(/font|spacing|margins/i);
    } finally {
      tight.cleanup();
    }
  });

  it.skipIf(!latex)('says nothing when the store has everything it asked for', { timeout: 180_000 }, async () => {
    const result = await buildBundle(t.store, { company: 'Meridian', role: 'Platform Engineer', resumeId: 'intern' });
    expect(result.missing).toBeUndefined();
  });
});

/*
 * One employer, written two ways.
 *
 * A posting names the company in full — "Acme, Inc." — and its form names it
 * short. Matched on the name as written, the two were two tracker rows and two
 * workspaces for one job, and the letter written in one was nowhere in the
 * other. A trailing legal form now names nobody in particular.
 */
describe('an employer is the same employer with or without "Inc."', () => {
  const row = (id: string, company: string) => ({
    id,
    company,
    role: 'Platform Engineer',
    status: 'applying' as const,
    appliedAt: '2026-09-01',
  });

  it('finds the tracker row and the workspace across a legal form', () => {
    const rows = [row('acme', 'Acme, Inc.')] as Parameters<typeof findApplication>[0];
    expect(findApplication(rows, 'Acme', 'Platform Engineer')?.id).toBe('acme');
    expect(findApplication(rows, 'ACME LLC', 'Platform Engineer')?.id).toBe('acme');
    const drafts = [{ id: 'd1', company: 'Acme', role: 'Platform Engineer', status: 'drafting' }];
    expect(findDraft(drafts, 'Acme, Inc.', 'Platform Engineer')?.id).toBe('d1');
    expect(findDraft(drafts, 'Acme Corp.', 'Platform Engineer')?.id).toBe('d1');
  });

  it('still tells different employers apart', () => {
    const rows = [row('acme', 'Acme, Inc.')] as Parameters<typeof findApplication>[0];
    expect(findApplication(rows, 'Acme Labs', 'Platform Engineer')).toBeUndefined();
    expect(findApplication(rows, 'Northwind, Inc.', 'Platform Engineer')).toBeUndefined();
    // A name that is only a legal form keeps its word, rather than matching everything.
    expect(findApplication([row('co', 'Co')] as Parameters<typeof findApplication>[0], 'Acme', 'Platform Engineer')).toBeUndefined();
  });
});
