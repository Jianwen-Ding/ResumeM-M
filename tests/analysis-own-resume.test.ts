/**
 * Which resume the application in front of the card was built with.
 *
 * Reported: "temporary resumes created for a job application should always be
 * on the very top when looking for resume variation options when looking at
 * that very job application". The card can only put it there if the analysis
 * says which one it is; it said which application, and not which resume.
 */
import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
afterEach(() => t?.cleanup());

const posting = (title: string, company: string) => `<html><head><title>${title} at ${company}</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting","title":"${title}",
"hiringOrganization":{"@type":"Organization","name":"${company}"},
"description":"<p>Kafka streaming infrastructure in Go and Python, Kubernetes on AWS. Distributed systems. Minimum qualifications: BS in Computer Science.</p>"}
</script></head><body>Apply now</body></html>`;

async function analyse(title: string, company: string) {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { createApi } = await import('../src/server/api.js');
  const { Repo } = await import('../src/git/repo.js');
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  const res = await request(app)
    .post('/api/extension/analyze')
    .send({ html: posting(title, company), url: 'https://boards.acmecorp.com/careers/12345', baseResumeId: 'base', tailor: 'none' })
    .expect(200);
  return res.body;
}

describe('the resume an application was built with', () => {
  it('is named with the application, so the card can put it first', async () => {
    t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
    fs.writeFileSync(
      path.join(t.dir, 'applications.yaml'),
      YAML.stringify([
        {
          id: '2026-09-20-acmecorp-data-platform-intern',
          company: 'Acmecorp',
          role: 'Data Platform Intern',
          status: 'applying',
          resumeId: 'job-acmecorp-data-platform-intern',
          createdAt: '2026-09-20T00:00:00.000Z',
        },
      ]),
      'utf8',
    );
    const body = await analyse('Data Platform Intern', 'Acmecorp');
    expect(body.application?.id).toBe('2026-09-20-acmecorp-data-platform-intern');
    expect(body.application?.resumeId).toBe('job-acmecorp-data-platform-intern');
  });

  it('and is absent for a posting nothing has been built for yet', async () => {
    t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
    const body = await analyse('Data Platform Intern', 'Acmecorp');
    expect(body.application?.id).toBeTruthy();
    expect(body.application?.resumeId).toBeUndefined();
  });
});
