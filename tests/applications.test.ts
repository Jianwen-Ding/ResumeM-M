import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { advance, applicationId, buildBundle, bundleFileName, slug, stats } from '../src/model/applications.js';
import type { Application } from '../src/model/types.js';
import { hasLatex, makeTempStore, type TempStore } from './helpers.js';

const latex = await hasLatex();

let t: TempStore;
beforeEach(() => {
  t = makeTempStore();
});
afterEach(() => t.cleanup());

describe('file naming', () => {
  it('names files the way portals expect, so nothing is renamed by hand', () => {
    expect(bundleFileName('Jianwen Ding', 'Streamly', 'Resume')).toBe('Jianwen Ding Resume Streamly.pdf');
    expect(bundleFileName('Jianwen Ding', 'Streamly', 'Cover Letter')).toBe('Jianwen Ding Cover Letter Streamly.pdf');
  });

  it('omits the company when there is not one', () => {
    expect(bundleFileName('Jianwen Ding', undefined, 'Resume')).toBe('Jianwen Ding Resume.pdf');
  });

  it('strips punctuation a filesystem would object to', () => {
    expect(bundleFileName('Jianwen Ding', 'Acme, Inc. / Beta', 'Resume')).toBe('Jianwen Ding Resume Acme Inc Beta.pdf');
  });

  it('collapses runs of whitespace in a name', () => {
    expect(bundleFileName('  Jianwen   Ding ', 'Acme', 'Resume')).toBe('Jianwen Ding Resume Acme.pdf');
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

describe('status history', () => {
  beforeEach(() => {
    t.store.saveApplications([
      { id: 'a1', company: 'Acme', role: 'SWE', status: 'applied', appliedAt: '2026-09-01T00:00:00Z' },
    ]);
  });

  it('appends rather than overwriting, so the path through is kept', () => {
    advance(t.store, 'a1', 'oa', 'online assessment sent');
    const app = advance(t.store, 'a1', 'interview');
    expect(app.status).toBe('interview');
    expect(app.history).toHaveLength(2);
    expect(app.history?.[0]?.note).toBe('online assessment sent');
  });

  it('names the application that does not exist', () => {
    expect(() => advance(t.store, 'nope', 'applied')).toThrow(/nope/);
  });
});

describe('stats', () => {
  const now = Date.now();
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

  const apps: Application[] = [
    { id: '1', company: 'A', role: 'r', status: 'applied', appliedAt: daysAgo(1) },
    { id: '2', company: 'B', role: 'r', status: 'interview', appliedAt: daysAgo(3) },
    { id: '3', company: 'C', role: 'r', status: 'rejected', appliedAt: daysAgo(20) },
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

    expect(result.files).toContain('Test Person Resume Streamly.pdf');
    expect(fs.existsSync(path.join(result.dir, 'Test Person Resume Streamly.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'source', 'resume.tex'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'source', 'resolved.yaml'))).toBe(true);

    expect(result.application.company).toBe('Streamly');
    expect(result.application.status).toBe('applied');
    expect(result.application.snapshotDir).toContain('applications/');
    expect(t.store.load().applications).toHaveLength(1);
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

    expect(result.files).toContain('Test Person Cover Letter Streamly.txt');
    expect(result.files).toContain('application-answers.md');
    const qa = fs.readFileSync(path.join(result.dir, 'application-answers.md'), 'utf8');
    expect(qa).toContain('## Why us?');
    expect(qa).toContain('Because.');
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
