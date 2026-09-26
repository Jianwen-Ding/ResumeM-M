/**
 * Template slots left in a letter or an answer — "[Your Name]", "[Company
 * Name]", "{company}", "XX years" — which printed as typed into the PDF and
 * were offered as a finished draft. Detected, and said, without changing a
 * word of what was written.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { placeholdersIn } from '../src/model/placeholders.js';
import { compileLetter, placeholderWarnings } from '../src/render/compile.js';
import { renderLetterLatex } from '../src/render/letter.js';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { WritingSession } from '../src/mcp/writing.js';
import { resolveResume } from '../src/model/resolve.js';
import { resumeAsText } from '../src/ai/prompts.js';
import { DEFAULT_CONFIG, DEFAULT_LAYOUT, type ResolvedProfile } from '../src/model/types.js';
import { hasLatex, makeTempStore, tempDir, type TempStore } from './helpers.js';

const latex = await hasLatex();

const PROFILE: ResolvedProfile = {
  name: 'Morgan Testwell',
  email: 'morgan.testwell@example.com',
  phone: '(555) 010-0199',
};

const TEMPLATE =
  'Dear [Hiring Manager],\n\n' +
  'I am excited to apply for the [Position] role at [Company Name]. With XX years of experience in ' +
  'streaming systems, I would bring a lot to {company} and to <Team>.\n\n' +
  'Sincerely,\n[Your Name]';

describe('finding the slots a template left', () => {
  it('names each one, once, in the order they appear', () => {
    expect(placeholdersIn(TEMPLATE)).toEqual([
      '[Hiring Manager]',
      '[Position]',
      '[Company Name]',
      'XX years',
      '{company}',
      '<Team>',
      '[Your Name]',
    ]);
    expect(placeholdersIn('[Company Name] and [Company Name] again')).toEqual(['[Company Name]']);
  });

  it('catches the other spellings a model reaches for', () => {
    for (const [text, slot] of [
      ['at [company] in particular', '[company]'],
      ['I improved it by [insert metric].', '[insert metric]'],
      ['the {{role}} you are hiring for', '{{role}}'],
      ['with X+ years of Kafka', 'X+ years'],
      ['cut latency by XX%', 'XX%'],
      ['TODO say why', 'TODO'],
    ]) {
      expect(placeholdersIn(text!), text).toEqual([slot]);
    }
  });

  it('leaves real brackets alone', () => {
    for (const real of [
      'The 2M events a day figure [1] is measured.',
      'As the report put it, "the fix was trivial [sic]".',
      'I wrote a lot of C++ [STL] code.',
      'My portfolio is at [my site](https://example.com/morgan).',
      'Reach me at <morgan.testwell@example.com>.',
      'I rewrote the loop so buffer[i] was read once, and cached items[key].',
      'It returns Promise<void>, and a Map<String, Integer> counted them.',
      'I used \\newcommand{} and ${value} in a template.',
      'I led a team of 12 for 3 years, on snake_case_names and https://example.com/a_b.',
      'Super Bowl XX was a long time ago.',
      'Line one<br>line two.',
    ]) {
      expect(placeholdersIn(real), real).toEqual([]);
    }
  });
});

describe('the letter build', () => {
  it('warns about each placeholder in the letter, by name', () => {
    const [warning, ...rest] = placeholderWarnings({ profile: PROFILE, company: 'Acme', body: TEMPLATE });
    expect(rest).toEqual([]);
    expect(warning).toMatch(/^The letter still has 7 placeholders in it/);
    for (const slot of ['[Hiring Manager]', '[Position]', '[Company Name]', 'XX years', '{company}', '[Your Name]']) {
      expect(warning).toContain(`"${slot}"`);
    }
  });

  it('looks at the addressee lines too, and says nothing about a finished letter', () => {
    expect(placeholderWarnings({ profile: PROFILE, company: '[Company Name]', body: 'I would like to work on ingest.' })[0])
      .toContain('"[Company Name]"');
    expect(placeholderWarnings({ profile: PROFILE, company: 'Acme', role: 'Platform Engineer', body: 'I would like to work on ingest [1].' }))
      .toEqual([]);
  });

  it('does not change what was typed', () => {
    const tex = renderLetterLatex({ profile: PROFILE, company: 'Acme', body: TEMPLATE, date: 'May 1, 2026' }, DEFAULT_LAYOUT);
    expect(tex).toContain('[Position] role at [Company Name]');
  });

  it.skipIf(!latex)('carries the warning with the compiled letter', async () => {
    const result = await compileLetter({ profile: PROFILE, company: 'Acme', body: TEMPLATE, date: 'May 1, 2026' }, DEFAULT_LAYOUT);
    expect(result.warnings.some((w) => w.includes('"[Hiring Manager]"') && w.includes('"[Your Name]"'))).toBe(true);
  }, 180_000);
});

describe('the writing tools', () => {
  const session = () => {
    const t = makeTempStore();
    try {
      const data = t.store.load();
      const resolved = resolveResume('base', data);
      return new WritingSession(
        data,
        resolved,
        { company: 'Helios Robotics', jobTitle: 'Platform Engineer', description: 'Streaming ingest.' },
        { coverLetter: { required: true, body: '' }, questions: [{ id: 'q1', question: 'Why this role?' }] } as never,
        resumeAsText(resolved),
      );
    } finally {
      t.cleanup();
    }
  };

  it('refuse a letter or an answer with a single-brace slot or an unfilled number', () => {
    const body = 'x'.repeat(300);
    for (const [bad, slot] of [
      [`${body} I would bring that to {company} from day one.`, '{company}'],
      [`${body} With XX years of experience I would bring it.`, 'XX years'],
    ]) {
      const letter = session().saveLetter(bad!);
      expect(letter.ok, slot).toBe(false);
      expect(letter.text).toContain(slot);
      expect(session().saveAnswer('q1', bad!.slice(301)).ok, slot).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The routes that take a model's draft without the tools              *
 * ------------------------------------------------------------------ */

const scripts = tempDir('rmm-placeholder-stub-');

/** A stand-in for the model that says `reply` whatever it is asked. */
function saying(reply: string): { command: string; args: string[] } {
  const file = path.join(scripts, `${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(reply)});\n`, 'utf8');
  return { command: process.execPath, args: [file, '{prompt}'] };
}

let t: TempStore | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function serve(reply: string): express.Express {
  const { command, args } = saying(reply);
  t = makeTempStore({
    config: {
      ai: { ...DEFAULT_CONFIG.ai, enabled: true, command, args, timeoutMs: 20_000 },
      git: { autoCommit: false },
      output: { dir: 'out' },
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  return app;
}

const JOB = { company: 'Acme Co.', jobTitle: 'Intern', jobDescription: 'Streaming ingest work.' };

describe('an AI draft with slots left in it', () => {
  it('is flagged, and not saved, by the cover-letter route', async () => {
    const app = serve(TEMPLATE);
    const before = t!.store.loadCoverLetters().length;
    const res = await request(app).post('/api/ai/cover-letter').send({ resumeId: 'newgrad', job: JOB, save: true }).expect(200);
    expect(res.body.body).toBe(TEMPLATE);
    expect(res.body.placeholders).toContain('[Company Name]');
    expect(res.body.unfinished).toMatch(/not finished/);
    expect(res.body.saved).toBeUndefined();
    expect(t!.store.loadCoverLetters()).toHaveLength(before);
  });

  it('is saved as before when it has none', async () => {
    const app = serve('Dear Acme team,\n\nI would like to work on ingest at scale.\n\nBest,\nMorgan Testwell');
    const res = await request(app).post('/api/ai/cover-letter').send({ resumeId: 'newgrad', job: JOB, save: true }).expect(200);
    expect(res.body.placeholders).toEqual([]);
    expect(res.body.unfinished).toBeUndefined();
    expect(res.body.saved?.id).toBeTruthy();
  });

  it('is flagged by the answer route', async () => {
    const app = serve('I want to join [Company Name] because of its mission.');
    const res = await request(app).post('/api/ai/answer').send({ question: 'Why us?', job: JOB, force: true }).expect(200);
    expect(res.body.output).toBe('I want to join [Company Name] because of its mission.');
    expect(res.body.placeholders).toEqual(['[Company Name]']);
    expect(res.body.unfinished).toContain('"[Company Name]"');
  });

  it('is not called drafted in the Workspace', async () => {
    const app = serve(TEMPLATE);
    const created = await request(app)
      .post('/api/workspace')
      .send({ company: 'Acme Co.', role: 'Intern', resumeId: 'newgrad', coverLetterRequired: true, questions: [{ question: 'Why us?' }] })
      .expect(200);
    const res = await request(app).post(`/api/workspace/${created.body.draft.id}/generate`).send({ what: 'all' }).expect(200);
    const notes: string[] = res.body.notes;
    expect(notes).not.toContain('Cover letter drafted in your voice.');
    expect(notes.some((n) => n.startsWith('The cover letter draft still has') && n.includes('"[Your Name]"'))).toBe(true);
    expect(notes.some((n) => n.startsWith('The answer to "Why us?" still has'))).toBe(true);
  });
});
