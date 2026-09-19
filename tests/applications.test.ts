import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { advance, alreadySent, applicationId, buildBundle, bundleFileName, describeLost, slug, stats } from '../src/model/applications.js';
import { syncCurrent } from '../src/model/current.js';
import type { Application } from '../src/model/types.js';
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
    expect(applicationId('Acme', '!!!', new Date('2026-09-16T00:00:00Z'))).toBe('2026-09-16-acme');
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
   */
  it('mirrors what is being sent now, rather than accumulating', async () => {
    const req = { company: 'Streamly', role: 'Intern', resumeId: 'intern', status: 'applying' as const };
    const withLetter = await buildBundle(t.store, { ...req, coverLetter: 'Dear Streamly, this is the letter.' });
    expect(fs.readdirSync(withLetter.dir)).toContain('Test-Person-Cover-Letter.pdf');

    const without = await buildBundle(t.store, req);
    expect(fs.readdirSync(without.dir)).not.toContain('Test-Person-Cover-Letter.pdf');
    // And the answer describes the folder that exists, which is what the card
    // prints under "named and ready to attach".
    expect([...without.files].sort()).toEqual(fs.readdirSync(without.dir).filter((f) => f !== 'source').sort());
  });

  it('freezes the choices that were actually used', async () => {
    const result = await buildBundle(t.store, { company: 'Acme', role: 'Intern', resumeId: 'intern' });
    const snapshot = YAML.parse(fs.readFileSync(path.join(result.dir, 'source', 'resolved.yaml'), 'utf8'));
    // `intern` selects the December graduation date; the snapshot must show it
    // even if the store changes later.
    const education = snapshot.resolved.sections.find((s: { kind: string }) => s.kind === 'education');
    expect(education.entries[0].dates).toContain('Dec. 2026');
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
    // so the company is added — to both, not just the loser.
    expect(current.files).toContain('Test-Person-Resume-Streamly.pdf');
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
    expect(resumes).toContain('Test-Person-Resume-Software-Engineer.pdf');
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
    expect(resumes).toContain('Test-Person-Resume-Software-Engineer.pdf');
    expect(resumes).toContain('Test-Person-Resume-Product-Manager.pdf');
  });

  it('separates one role at two companies when the title is on', async () => {
    withTitle(true);
    for (const company of ['Acme', 'Globex']) {
      await buildBundle(t.store, { company, role: 'Software Engineer', resumeId: 'intern' });
    }
    const resumes = syncCurrent(t.store).files.filter((f) => f.endsWith('.pdf'));
    expect(resumes).toHaveLength(2);
    expect(resumes).toContain('Test-Person-Software-Engineer-Resume-Acme.pdf');
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

  it.skipIf(!latex)('says nothing when the store has everything it asked for', { timeout: 180_000 }, async () => {
    const result = await buildBundle(t.store, { company: 'Meridian', role: 'Platform Engineer', resumeId: 'intern' });
    expect(result.missing).toBeUndefined();
  });
});
