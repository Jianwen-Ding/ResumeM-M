import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, main, readState, type SessionFile } from '../src/mcp/main.js';
import { resolveResume } from '../src/model/resolve.js';
import { makeTempStore } from './helpers.js';
import type { StoreData } from '../src/model/types.js';

/*
 * The two ways the MCP server can fail before it serves anything, and the way
 * its decisions are read back.
 *
 * The rest of `main` — the framing, saving after every call, the empty state
 * written up front — is exercised for real: `tests/mcp.test.ts` spawns
 * `bin.js` over a pipe and speaks the protocol to it. That is a child
 * process, so in-process coverage cannot see it, which is why this file looks
 * like the only thing testing `main` and is not.
 *
 * What that end-to-end run does not reach is the pair of exits before the
 * server starts, and those are the ones a person meets. A coding-agent CLI
 * that spawns the server with the environment unset, or against a session
 * file that was moved, gets no protocol at all — so the only thing it can
 * report is whatever went to stderr, and the only thing the agent runner can
 * read is the exit code.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-mcp-main-'));
  made.push(dir);
  return dir;
}

/** What went to stderr while something ran, which is the whole of the report. */
async function said(run: () => Promise<void>): Promise<string> {
  let out = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  await run();
  return out;
}

describe('starting the MCP server without a session to serve', () => {
  it('says which setting is missing, rather than failing at the protocol', async () => {
    const before = process.env.RMM_TAILOR_SESSION;
    delete process.env.RMM_TAILOR_SESSION;
    try {
      const out = await said(() => main([]));
      expect(out).toMatch(/RMM_TAILOR_SESSION/);
      expect(process.exitCode).toBe(2);
    } finally {
      if (before !== undefined) process.env.RMM_TAILOR_SESSION = before;
    }
  });

  /*
   * Named, because the session file is written by this program into a temp
   * folder the agent runner owns, and "could not read it" without the path
   * is unactionable — the whole question is which one it went looking for.
   */
  it('names the file it could not read', async () => {
    const missing = path.join(tempDir(), 'gone.json');
    const out = await said(() => main([missing]));
    expect(out).toContain(missing);
    expect(process.exitCode).toBe(2);
  });

  it('says so for a session file that is not JSON, rather than throwing', async () => {
    const dir = tempDir();
    const bad = path.join(dir, 'session.json');
    fs.writeFileSync(bad, 'this is not json');
    const out = await said(() => main([bad]));
    expect(out).toContain(bad);
    expect(process.exitCode).toBe(2);
  });

  /* The argument is a fallback for the variable, so both have to work. */
  it('takes the session from the environment as well as from argv', async () => {
    const missing = path.join(tempDir(), 'also-gone.json');
    process.env.RMM_TAILOR_SESSION = missing;
    try {
      const out = await said(() => main([]));
      expect(out).toContain(missing);
      expect(process.exitCode).toBe(2);
    } finally {
      delete process.env.RMM_TAILOR_SESSION;
    }
  });
});

/*
 * Reading the decisions back off disk.
 *
 * Null is a real answer rather than a failure: a CLI that ignored the tools
 * entirely leaves nothing behind, and the caller reads the reply as prose
 * instead. So an unreadable file and an absent one have to be the same quiet
 * answer, not an exception thrown into a request handler.
 */
describe('reading back what a session decided', () => {
  it('reads a state that was written', () => {
    const out = path.join(tempDir(), 'out.json');
    fs.writeFileSync(out, JSON.stringify({ reasoning: 'because', plan: {} }));
    expect(readState(out)).toMatchObject({ reasoning: 'because' });
  });

  it('says nothing was decided when the file is not there', () => {
    expect(readState(path.join(tempDir(), 'never-written.json'))).toBeNull();
  });

  it('says nothing was decided when the file is half-written', () => {
    const out = path.join(tempDir(), 'half.json');
    fs.writeFileSync(out, '{"plan": {');
    expect(readState(out)).toBeNull();
  });
});

/*
 * Which tools a session file gets.
 *
 * Three jobs share one program, and this is the only place they differ. Get
 * it wrong and an agent is handed a different job's tools — which it will
 * use, because they are perfectly good tools — and the session file it writes
 * back looks entirely well-formed. Nothing downstream would notice: a
 * tailoring run that was quietly given the authoring tools simply decides
 * nothing and reports that it decided nothing.
 */
describe('the tools a session file is given', () => {
  const data = (): StoreData => {
    const t = makeTempStore();
    try {
      return t.store.load();
    } finally {
      t.cleanup();
    }
  };

  const fileOf = (over: Partial<SessionFile> = {}): SessionFile => {
    const d = data();
    return {
      data: d,
      resume: resolveResume('base', d),
      posting: { description: 'A posting.' },
      out: path.join(tempDir(), 'out.json'),
      ...over,
    } as SessionFile;
  };

  const namesFor = (over: Partial<SessionFile> = {}) => build(fileOf(over)).tools.map((t) => t.name);

  it('gives a tailoring session the tools that choose and rearrange', () => {
    const names = namesFor({ kind: 'tailor' });
    expect(names).toContain('choose_wording');
    expect(names).toContain('reorder_bullets');
    expect(names).not.toContain('save_letter');
    expect(names).not.toContain('propose_entry');
  });

  it('gives a writing session the tools that write and check', () => {
    const names = namesFor({ kind: 'write' });
    expect(names).toContain('save_letter');
    expect(names).toContain('check_claim');
    expect(names).not.toContain('choose_wording');
    expect(names).not.toContain('propose_entry');
  });

  it('gives an authoring session the tools that read material and propose', () => {
    const names = namesFor({ kind: 'author', documents: [], existing: { entryIds: [], bulletIds: [], skillGroups: [] } });
    expect(names).toContain('propose_entry');
    expect(names).toContain('propose_order');
    expect(names).not.toContain('choose_wording');
    expect(names).not.toContain('save_letter');
  });

  /*
   * A file written before there were three kinds says nothing about which it
   * is, and it means the one that existed then.
   */
  it('reads a file that names no kind as a tailoring session', () => {
    expect(namesFor({})).toEqual(namesFor({ kind: 'tailor' }));
  });

  /* An authoring file with nothing in it still builds, rather than throwing. */
  it('builds an authoring session that was handed no material at all', () => {
    expect(() => build(fileOf({ kind: 'author' }))).not.toThrow();
  });

  it('starts every session with a state that can be written out', () => {
    for (const kind of ['tailor', 'write', 'author'] as const) {
      expect(() => JSON.stringify(build(fileOf({ kind })).session.state)).not.toThrow();
    }
  });
});
