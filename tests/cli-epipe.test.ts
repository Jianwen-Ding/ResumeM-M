/**
 * A reader that quits early is not a failure of this program to report.
 *
 * `rmm build --all | head -1` is an ordinary way to preview a batch, and on a
 * store with more than one resume it used to crash: the first line reached
 * `head` and printed, `head` read it and closed its end of the pipe, and the
 * write for the *second* resume then raised EPIPE with nothing listening for
 * it — an uncaught exception, a raw Node stack trace on stderr, and exit code
 * 1 for a build that had mostly succeeded. See `ignoreBrokenPipe` in
 * `src/cli-io.ts`.
 *
 * Two tests: the mechanism in isolation, which is fast and deterministic, and
 * the CLI itself piped the way a person actually runs it, which is the only
 * thing that can catch the wiring being missing.
 */

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ignoreBrokenPipe } from '../src/cli-io.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('ignoreBrokenPipe', () => {
  it('swallows exactly EPIPE', () => {
    const stream = new EventEmitter();
    ignoreBrokenPipe(stream);
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => stream.emit('error', epipe)).not.toThrow();
  });

  it('still lets a different error through', () => {
    const stream = new EventEmitter();
    ignoreBrokenPipe(stream);
    const other = Object.assign(new Error('write EACCES'), { code: 'EACCES' });
    // EventEmitter re-throws synchronously from `emit` when a listener throws.
    expect(() => stream.emit('error', other)).toThrow('write EACCES');
  });
});

describe('a build piped to a reader that quits early', () => {
  /** Two resumes, so a second write happens after the first line is read. */
  function aTwoResumeSave(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-epipe-'));
    fs.writeFileSync(path.join(dir, 'profile.yaml'), 'name: Someone\nemail: someone@example.com\n');
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'ai:\n  enabled: false\n');
    fs.mkdirSync(path.join(dir, 'resumes'));
    for (const id of ['first', 'second']) {
      fs.writeFileSync(path.join(dir, 'resumes', `${id}.yaml`), `id: ${id}\nlabel: ${id}\nbase: true\n`);
    }
    return dir;
  }

  it('does not crash with a stack trace when the pipe closes after one line', async () => {
    const save = aTwoResumeSave();
    try {
      const cli = path.join(root, 'src/cli.ts');
      const tsx = path.join(root, 'node_modules/.bin/tsx');
      // `bash -c '... | head -1; exit ${PIPESTATUS[0]}'` reports the CLI's own
      // exit code, not `head`'s — the two differ, and `head`'s is always 0.
      const { stdout, stderr } = await run(
        'bash',
        [
          '-c',
          `${JSON.stringify(process.execPath)} ${JSON.stringify(tsx)} ${JSON.stringify(cli)} build --all --data ${JSON.stringify(save)} | head -1; exit \${PIPESTATUS[0]}`,
        ],
        { env: { ...process.env, RMM_AUTOCOMMIT: '0' }, timeout: 120_000 },
      );
      expect(stdout).toMatch(/^(first|second)\s/);
      expect(stderr).not.toContain('EPIPE');
      expect(stderr).not.toContain('Unhandled');
    } finally {
      fs.rmSync(save, { recursive: true, force: true });
    }
  }, 120_000);
});
