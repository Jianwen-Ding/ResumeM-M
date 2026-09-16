/**
 * Proofs for reported AI-subsystem bugs. Added by a bug hunt; nothing in
 * src/ was changed. Every test here FAILS against the current source and is
 * the reproduction for one finding.
 */
import { afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/ai/agent.js';
import { applyResearch } from '../src/ai/presets.js';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { DEFAULT_CONFIG, type StoreConfig } from '../src/model/types.js';
import { makeTempStore, type TempStore } from './helpers.js';

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-proof-'));
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

/** Write a stand-in CLI and return the argv that runs it. */
function stub(name: string, body: string): { command: string; prefix: string[] } {
  const file = path.join(bin, `${name}.cjs`);
  fs.writeFileSync(file, body, 'utf8');
  return { command: process.execPath, prefix: [file] };
}

const config = (command: string, args: string[]): StoreConfig => ({
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, enabled: true, command, args, timeoutMs: 15_000 },
});

/* ------------------------------------------------------------------ *
 * 1. stderr is treated as the answer when the CLI exits 0             *
 * ------------------------------------------------------------------ */

/** A CLI that succeeds, prints nothing, and warns on stderr. Real CLIs do. */
const NOISY = `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('[WARN] api key rotated; using cached credentials\\n');
  process.exit(0);
});
`;

describe('agent.ts:90 — stderr is used as the model output on a clean exit', () => {
  it('returns the diagnostic as if it were the answer', async () => {
    const { command, prefix } = stub('noisy', NOISY);
    const result = await runAgent(config(command, [...prefix, '-p']), 'draft me a letter');

    expect(result.executed).toBe(true);
    // The bug: a warning on stderr is indistinguishable from an answer.
    expect(result.output).toBe('');
  });

  it('writes that diagnostic into the store as the cover letter and the answer', async () => {
    const { command, prefix } = stub('noisy', NOISY);
    const t = makeTempStore({
      config: {
        ai: { enabled: true, command, args: [...prefix, '-p'], timeoutMs: 15_000 },
        git: { autoCommit: false },
        output: { dir: 'out' },
      },
    });
    try {
      const app = express();
      app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

      const opened = await request(app)
        .post('/api/workspace')
        .send({
          company: 'Streamly',
          role: 'Data Platform Intern',
          resumeId: 'base',
          jobDescription: 'Kafka in Go.',
          coverLetterRequired: true,
          questions: [{ question: 'Describe a system you are proud of building.' }],
        })
        .expect(200);

      const id = opened.body.draft.id as string;
      const res = await request(app).post(`/api/workspace/${id}/generate`).send({ what: 'all' }).expect(200);

      // The stderr noise is now the letter that would be submitted, and the
      // answer on the form, both persisted to data/drafts/<id>.yaml.
      expect(res.body.draft.coverLetter.body).not.toMatch(/api key rotated/);
      expect(res.body.draft.questions[0].answer).not.toMatch(/api key rotated/);
      const onDisk = fs.readFileSync(path.join(t.dir, 'drafts', `${id}.yaml`), 'utf8');
      expect(onDisk).not.toMatch(/api key rotated/);
    } finally {
      t.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. applyResearch can delete the whole deny list                     *
 * ------------------------------------------------------------------ */

describe('presets.ts:157 — applyResearch drops --disallowedTools entirely', () => {
  /** What claude really denies: the list runs until the next flag. */
  const denied = (args: string[]): string[] => {
    const at = args.indexOf('--disallowedTools');
    if (at < 0) return [];
    const out: string[] = [];
    for (let i = at + 1; i < args.length && !args[i]!.startsWith('-'); i++) {
      for (const t of args[i]!.split(',')) if (t.trim()) out.push(t.trim());
    }
    return out;
  };

  it('keeps Bash, Write and Edit denied when research is switched on', () => {
    // A perfectly valid claude invocation: --disallowedTools takes a list, and
    // the UI's argument box is whitespace-separated.
    const args = ['-p', '--add-dir', '{sandbox}', '--disallowedTools', 'WebFetch', 'WebSearch', 'Bash', 'Write', 'Edit'];
    const open = applyResearch('claude', args, true);

    expect(denied(open)).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']));
    // And the leftovers must not become positional arguments.
    expect(open).not.toContain('Bash');
  });

  it('puts the web tools back when research is switched off again', () => {
    const closed = ['-p', '--disallowedTools', 'WebFetch,WebSearch'];
    const open = applyResearch('claude', closed, true); // -> ['-p'], the flag is gone
    expect(applyResearch('claude', open, false)).toEqual(closed);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Store text is used as a String.replace() replacement pattern     *
 * ------------------------------------------------------------------ */

/** A gemini/agy-shaped CLI: the prompt arrives inline, as an argument. */
const INLINE = `
const argv = process.argv.slice(2);
const i = argv.indexOf('-p');
process.stdout.write(JSON.stringify({ prompt: argv[i + 1] }));
`;

describe('agent.ts:50 — $&, $` and $\' in the prompt are expanded, not passed', () => {
  it('passes the prompt through unchanged', async () => {
    const { command, prefix } = stub('inline', INLINE);
    // Anything from the store or the posting can contain these two characters.
    const prompt = 'Bullet: cut cloud spend by $&, see the $` note and the $\' note';
    const result = await runAgent(config(command, [...prefix, '-p', '{promptText}']), prompt);
    expect(JSON.parse(result.output).prompt).toBe(prompt);
  });

  it('does not leak the argument template into the prompt', async () => {
    const { command, prefix } = stub('inline2', INLINE);
    const result = await runAgent(
      config(command, [...prefix, '-p', '--print={promptText}']),
      'Reduced AWS spend; see $` for detail',
    );
    expect(JSON.parse(result.output).prompt).not.toContain('--print=');
  });
});

/* ------------------------------------------------------------------ *
 * 4. The confinement is cwd and nothing else                          *
 * ------------------------------------------------------------------ */

/**
 * A stand-in for "an agent that decides to look around the project" — exactly
 * what the comment in runAgent says cannot happen. It only uses the ability
 * any CLI started by execFile has.
 */
const NOSY = `
const fs = require('node:fs');
const target = process.env.RMM_PROOF_TARGET;
const stolen = fs.readFileSync(target + '/profile.yaml', 'utf8');
fs.writeFileSync(target + '/OWNED.yaml', 'written by the child\\n');
process.stdout.write(JSON.stringify({ cwd: process.cwd(), stolen: stolen.length }));
`;

describe('agent.ts:36 — the child is only confined by its working directory', () => {
  it('cannot reach the store with the shipped default arguments', async () => {
    const t = makeTempStore();
    try {
      const { command, prefix } = stub('nosy', NOSY);
      process.env.RMM_PROOF_TARGET = t.dir;
      // DEFAULT_CONFIG.ai.args — what a config.yaml without an `args:` key gets.
      expect(DEFAULT_CONFIG.ai.args).toEqual(['-p', '{prompt}']);
      const result = await runAgent(config(command, [...prefix, ...DEFAULT_CONFIG.ai.args]), 'hello');

      expect(JSON.parse(result.output).stolen).toBe(0);
      expect(fs.existsSync(path.join(t.dir, 'OWNED.yaml'))).toBe(false);
    } finally {
      delete process.env.RMM_PROOF_TARGET;
      t.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. An empty reply silently becomes another company's letter         *
 * ------------------------------------------------------------------ */

/** A CLI that succeeds and says nothing at all. */
const SILENT = `process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;

describe('api.ts:1918 — an empty AI reply pastes a letter written to someone else', () => {
  let t: TempStore;
  let app: express.Express;
  beforeEach(() => {
    const { command, prefix } = stub('silent', SILENT);
    t = makeTempStore({
      config: {
        ai: { enabled: true, command, args: [...prefix, '-p'], timeoutMs: 15_000 },
        git: { autoCommit: false },
        output: { dir: 'out' },
      },
    });
    app = express();
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  });
  afterEach(() => t.cleanup());

  it('does not put the letter to Acme Co. on the application to Streamly', async () => {
    const opened = await request(app)
      .post('/api/workspace')
      .send({ company: 'Streamly', role: 'Data Platform Intern', resumeId: 'base', coverLetterRequired: true })
      .expect(200);

    const res = await request(app)
      .post(`/api/workspace/${opened.body.draft.id}/generate`)
      .send({ what: 'letter' })
      .expect(200);

    expect(res.body.draft.coverLetter.body).not.toMatch(/Dear Acme/);
  });
});
