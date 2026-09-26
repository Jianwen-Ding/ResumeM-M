/**
 * The id a tailored copy is saved under, and the rename of the ones that
 * already exist.
 *
 * `tailoredResumeId` says what went wrong: the id was `job-<slug>-<slug>` and
 * `saveResume` writes `resumes/<id>.yaml` over whatever is there, so two
 * postings a slug cannot tell apart shared one file and the second tailoring
 * overwrote the first in silence. `applicationId` learned this lesson first
 * and has `fingerprint`/`faithful` to show for it; this is the same discipline
 * applied to the second thing keyed on a pair of names.
 */
import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { legacyTailoredResumeId, tailoredResumeId } from '../src/model/applications.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
afterEach(() => t?.cleanup());

describe('the id a tailored copy gets', () => {
  it('leaves a name a slug represents faithfully alone', () => {
    expect(tailoredResumeId('Streamly', 'Data Platform Intern')).toBe('job-streamly-data-platform-intern');
  });

  it('tells apart two titles whose only difference is punctuation', () => {
    // Both are `c-engineer` to a slug. This is the everyday shape of it.
    expect(legacyTailoredResumeId('Acme', 'C++ Engineer')).toBe(legacyTailoredResumeId('Acme', 'C# Engineer'));
    expect(tailoredResumeId('Acme', 'C++ Engineer')).not.toBe(tailoredResumeId('Acme', 'C# Engineer'));
  });

  it('tells apart two postings with no ASCII in them at all', () => {
    // Where `slug` gives up entirely: both halves reduce to nothing, so every
    // such posting used to mint `job--`.
    expect(legacyTailoredResumeId('字节跳动', '软件工程师')).toBe('job--');
    expect(tailoredResumeId('字节跳动', '软件工程师')).not.toBe(tailoredResumeId('阿里巴巴', '后端工程师'));
    // And the empty halves do not leave a row of dashes behind.
    expect(tailoredResumeId('字节跳动', '软件工程师')).toMatch(/^job-[0-9a-f]{8}$/);
  });

  /*
   * The third way, and the one `faithful` alone does not catch: it measures
   * each name separately and the cut happens after they are joined. Two roles
   * under sixty characters each can still cut to the same id.
   */
  it('tells apart two long titles that cut to the same length', () => {
    const a = 'Senior Staff Software Engineer, Distributed Systems Platform Group';
    const b = 'Senior Staff Software Engineer, Distributed Systems Storage Group';
    expect(legacyTailoredResumeId('Acme', a)).toBe(legacyTailoredResumeId('Acme', b));
    expect(tailoredResumeId('Acme', a)).not.toBe(tailoredResumeId('Acme', b));
  });

  it('is the same id every time it is asked', () => {
    expect(tailoredResumeId('字节跳动', '软件工程师')).toBe(tailoredResumeId('字节跳动', '软件工程师'));
  });
});

/** A save written before the ids could tell two postings apart. */
function saveWithOldIds(): TempStore {
  const store = makeTempStore();
  const dir = store.dir;
  const write = (rel: string, data: unknown) =>
    fs.writeFileSync(path.join(dir, rel), YAML.stringify(data, { lineWidth: 0 }), 'utf8');

  write('resumes/job-acme-c-engineer.yaml', {
    id: 'job-acme-c-engineer',
    label: 'C++ Engineer — Acme',
    copiedFrom: 'base',
    tier: 'temporary',
    generatedFor: { company: 'Acme', role: 'C++ Engineer', at: '2026-09-01T00:00:00.000Z' },
  });
  // A copy of that copy, so the provenance link has somewhere to go wrong.
  write('resumes/job-acme-c-engineer-v2.yaml', {
    id: 'job-acme-c-engineer-v2',
    label: 'A second go',
    copiedFrom: 'job-acme-c-engineer',
    tier: 'temporary',
  });
  write('applications.yaml', [
    {
      id: '2026-09-01-acme-c-engineer',
      company: 'Acme',
      role: 'C++ Engineer',
      status: 'applying',
      resumeId: 'job-acme-c-engineer',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  ]);
  fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true });
  write('drafts/d1.yaml', {
    id: 'd1',
    company: 'Acme',
    role: 'C++ Engineer',
    resumeId: 'job-acme-c-engineer',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  return store;
}

describe('renaming the tailored copies a save already holds', () => {
  it('moves the file to the id that can tell two postings apart', () => {
    t = saveWithOldIds();
    const want = tailoredResumeId('Acme', 'C++ Engineer');

    const { renamed } = t.store.migrateTailoredIds();
    expect(renamed).toEqual([{ from: 'job-acme-c-engineer', to: want }]);

    const dir = path.join(t.dir, 'resumes');
    expect(fs.existsSync(path.join(dir, `${want}.yaml`))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'job-acme-c-engineer.yaml'))).toBe(false);
    // And it is the same document, under the new name.
    expect(t.store.getResume(want)?.label).toBe('C++ Engineer — Acme');
  });

  it('takes everything that names it along', () => {
    t = saveWithOldIds();
    const want = tailoredResumeId('Acme', 'C++ Engineer');
    t.store.migrateTailoredIds();

    expect(t.store.load().applications[0]?.resumeId).toBe(want);
    expect(t.store.getDraft('d1')?.resumeId).toBe(want);
    // Including the copy that recorded it as where it came from.
    expect(t.store.getResume('job-acme-c-engineer-v2')?.copiedFrom).toBe(want);
  });

  /*
   * A save old enough to still hold `extends` can hold one naming a copy this
   * renames. Left pointing at the old id, the resume's base is gone: the fold
   * says it "recorded a base … that the save does not have" and the resume
   * loses everything it inherited.
   */
  it('takes an `extends` naming it along too, in a save not yet folded', () => {
    t = saveWithOldIds();
    fs.writeFileSync(
      path.join(t.dir, 'resumes', 'job-acme-c-engineer-v3.yaml'),
      YAML.stringify({ id: 'job-acme-c-engineer-v3', label: 'Inherits', extends: 'job-acme-c-engineer' }),
      'utf8',
    );
    const want = tailoredResumeId('Acme', 'C++ Engineer');
    t.store.migrateTailoredIds();

    const written = t.store.loadResumesAsWritten().find((r) => r.id === 'job-acme-c-engineer-v3');
    expect(written?.extends).toBe(want);
  });

  /*
   * A resume somebody named themselves is theirs. The predicate is "is this
   * the id the old scheme would have produced for the names it records" — not
   * "does it start with job-" — so a hand-named copy keeps its name.
   */
  it('leaves a resume nobody generated under that name alone', () => {
    t = saveWithOldIds();
    /*
     * Named `job-…` and carrying a `generatedFor` nothing else in the save
     * claims, so neither the prefix nor the presence of the two names is
     * enough to tell it apart. The only thing that does is that the old
     * scheme would have called this `job--`, and it is not called that.
     */
    fs.writeFileSync(
      path.join(t.dir, 'resumes', 'job-my-favourite.yaml'),
      YAML.stringify({
        id: 'job-my-favourite',
        label: 'The one I like',
        generatedFor: { company: '字节跳动', role: '软件工程师', at: '2026-09-01T00:00:00.000Z' },
      }),
      'utf8',
    );

    const { renamed } = t.store.migrateTailoredIds();
    expect(renamed.map((r) => r.from)).not.toContain('job-my-favourite');
    expect(t.store.getResume('job-my-favourite')?.label).toBe('The one I like');
  });

  it('does nothing at all the second time, and nothing on a save that never needed it', () => {
    t = saveWithOldIds();
    t.store.migrateTailoredIds();
    expect(t.store.migrateTailoredIds().renamed).toEqual([]);

    const fresh = makeTempStore();
    try {
      expect(fresh.store.migrateTailoredIds().renamed).toEqual([]);
    } finally {
      fresh.cleanup();
    }
  });
});

/**
 * The id and the record of what it was made from have to agree.
 *
 * `generatedFor` is the only thing that can say, later, which posting a
 * tailored copy belongs to — it is what `migrateTailoredIds` reads to work
 * out whether an id is one the old scheme produced, and the only reason a
 * rename can be done safely at all. So a copy whose id was built from one
 * pair of names and whose record holds another is a copy nothing downstream
 * can reason about.
 *
 * The extension's route did exactly that. The id came from
 * `job.company ?? employerFallback(url)` and `job.title ?? 'Role'`; the record
 * came from the raw `job.company` and `job.title`. A posting whose page never
 * names the employer — an ATS board serving a form under the company's own
 * hostname is the ordinary case — got an id saying `job-acmecorp-…`, taken
 * from that hostname, over a record saying nothing at all. Which is not an
 * id `migrateTailoredIds` can recognise as its own, so those copies would
 * have been left behind by the very rename they most need.
 */
describe('what a tailored copy records about the posting it was made for', () => {
  it('records the names its own id was built from', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { createApi } = await import('../src/server/api.js');
    const { Repo } = await import('../src/git/repo.js');

    t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
    const app = express();
    app.use(express.json());
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

    // A posting page that names neither the employer nor the title: both come
    // from the fallbacks, which is the case the two paths disagreed on.
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({
        html: `<html><head><title>Data Platform Intern</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting","title":"Data Platform Intern",
"description":"<p>Kafka streaming infrastructure in Go and Python, Kubernetes on AWS. Distributed systems. Minimum qualifications: BS in Computer Science.</p>"}
</script></head><body>Apply now</body></html>`,
        url: 'https://boards.acmecorp.com/careers/12345',
        baseResumeId: 'base',
        tailor: 'match',
      })
      .expect(200);
    /*
     * Asserted on the spec rather than on disk: `/extension/analyze` hands the
     * copy to the card and the card carries it back to be saved, so this is
     * the spec that ends up in `resumes/`, id and record together.
     */
    const spec = res.body.spec;
    expect(spec?.id).toBe('job-acmecorp-data-platform-intern');
    const { company, role } = spec.generatedFor ?? {};
    expect(company).toBeTruthy();
    expect(role).toBeTruthy();
    // The whole invariant in one line: the record reproduces the id.
    expect(tailoredResumeId(company!, role!)).toBe(spec.id);
  });
});

describe('a posting that names no job', () => {
  it('is filed as an unknown role, in the words the extension uses', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { createApi } = await import('../src/server/api.js');
    const { Repo } = await import('../src/git/repo.js');

    t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
    const app = express();
    app.use(express.json());
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

    // Phenom's apply step as Activision serves it: titled "Apply", naming no one.
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({
        html: `<html><head><title>Apply</title></head><body><form>
<label for="fn">First Name</label><input id="fn"><label for="ln">Last Name</label><input id="ln">
<label for="em">Email</label><input id="em" type="email"><label for="rs">Resume</label><input id="rs" type="file">
</form></body></html>`,
        url: 'https://careers.activision.com/apply?jobSeqNo=ACPUUSR027559EXTERNAL&step=1&stepname=personalInformation',
        baseResumeId: 'base',
        tailor: 'none',
      })
      .expect(200);
    expect(res.body.spec?.generatedFor).toMatchObject({ company: 'Activision', role: 'Unknown role' });
  });
});

/*
 * Two bare application forms at one employer, neither naming its role.
 *
 * Identity is the company and the role, and both became "Acme" and "Unknown
 * role" — so the second form was the first one's application: one tracker
 * row, one workspace, one folder, and one tailored copy, the second build
 * written over the first. The address still says which job each one is, by
 * its number, and the pages of one job agree on it.
 */
describe('two postings that name no job, at one employer', () => {
  const FORM = `<html><head><title>Apply</title></head><body><form>
<label for="fn">First Name</label><input id="fn"><label for="ln">Last Name</label><input id="ln">
<label for="em">Email</label><input id="em" type="email"><label for="rs">Resume</label><input id="rs" type="file">
</form></body></html>`;

  async function server() {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { createApi } = await import('../src/server/api.js');
    const { Repo } = await import('../src/git/repo.js');
    t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
    const app = express();
    app.use(express.json());
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
    const analyze = async (pages: string[]) =>
      (
        await request(app)
          .post('/api/extension/analyze')
          // As the extension sends it: the page in front of you, and every page of the application.
          .send({ url: pages.at(-1), title: 'Apply', html: FORM, pages: pages.map((url) => ({ url, title: 'Apply', html: FORM })), baseResumeId: 'base', tailor: 'none' })
          .expect(200)
      ).body as { spec: { id: string; generatedFor: { company: string; role: string } }; application: { id: string } };
    // What the extension does with a send: files it under the names the store settled.
    const send = async (at: Awaited<ReturnType<typeof analyze>>, url: string) =>
      (
        await request(app)
          .post('/api/extension/sent')
          .send({ company: at.spec.generatedFor.company, role: at.spec.generatedFor.role, url })
          .expect(200)
      ).body as { application: { id: string } };
    return { analyze, send };
  }

  it('are two applications when their addresses name two job numbers', async () => {
    const { identity } = await import('../src/model/applications.js');
    const { analyze, send } = await server();
    const one = await analyze(['https://careers.acme.com/apply?gh_jid=4012345']);
    const two = await analyze(['https://careers.acme.com/apply?gh_jid=4019876']);
    expect(one.spec.generatedFor.company).toBe(two.spec.generatedFor.company);
    // Still said to be unknown, in the words the extension uses — and which one.
    expect(one.spec.generatedFor.role).toMatch(/^Unknown role\b.*4012345/);
    expect(two.spec.generatedFor.role).toMatch(/^Unknown role\b.*4019876/);
    expect(identity(one.spec.generatedFor.company, one.spec.generatedFor.role)).not.toBe(
      identity(two.spec.generatedFor.company, two.spec.generatedFor.role),
    );
    // Not one tailored copy, and not one application.
    expect(one.spec.id).not.toBe(two.spec.id);
    const sent = await send(one, 'https://careers.acme.com/apply?gh_jid=4012345');
    const after = await analyze(['https://careers.acme.com/apply?gh_jid=4019876']);
    expect(after.application.id).not.toBe(sent.application.id);
    // A number in the path is a number too.
    const pathed = await analyze(['https://careers.acme.com/jobs/4033333/apply']);
    expect(pathed.spec.id).not.toBe(one.spec.id);
    expect(pathed.spec.id).not.toBe(two.spec.id);
  });

  it('are one application when the pages are one job’s', async () => {
    const { analyze, send } = await server();
    // The posting names its number in the path, the form in a parameter.
    const posting = await analyze(['https://careers.acme.com/jobs/4012345']);
    const form = await analyze(['https://careers.acme.com/apply?gh_jid=4012345&step=2']);
    expect(form.spec.generatedFor).toMatchObject({ company: posting.spec.generatedFor.company, role: posting.spec.generatedFor.role });
    expect(form.spec.id).toBe(posting.spec.id);
    const sent = await send(posting, 'https://careers.acme.com/jobs/4012345');
    expect((await analyze(['https://careers.acme.com/apply?gh_jid=4012345&step=2'])).application.id).toBe(sent.application.id);
    // Taleo's posting and form are sibling files agreeing on `job=`; a trail of both is the same job again.
    const detail = await analyze(['https://acme.taleo.net/careersection/2/jobdetail.ftl?job=12345']);
    const trail = await analyze([
      'https://acme.taleo.net/careersection/2/jobdetail.ftl?job=12345',
      'https://acme.taleo.net/careersection/2/application.ftl?job=12345&lang=en',
    ]);
    expect(trail.spec.id).toBe(detail.spec.id);
    expect(trail.spec.id).not.toBe(posting.spec.id);
  });

  it('and one that names no number stays plainly unknown', async () => {
    const { analyze } = await server();
    // `id` and `token` could name anything; a short number is a page, not a job.
    const bare = await analyze(['https://careers.acme.com/apply?id=4012345&page=12']);
    expect(bare.spec.generatedFor.role).toBe('Unknown role');
  });
});
