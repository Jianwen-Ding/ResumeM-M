/**
 * `--data` reaching the store, proved by running the program.
 *
 * Unit tests around `resolveStoreDir` cannot catch the bug this is for. The
 * function was always right; the CLI simply never called it with the flag, so
 * `rmm serve --data /tmp/copy` started, printed nothing unusual, and served
 * whichever save was open. That is how a pool of three test servers, each
 * given its own copy of a store, turned out to be three servers writing to one
 * real store — the opposite of what the arrangement is for, and invisible from
 * inside the suite.
 *
 * A flag that is accepted and discarded can only be caught from outside, by a
 * process that is told where to look and then asked what it found.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A save with one resume in it, labelled so no other save could produce it.
 *
 * The label is the whole assertion: two saves that look alike cannot tell you
 * which one was opened, and a test that cannot tell does not fail when the
 * flag is thrown away.
 */
function aSave(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-flag-'));
  fs.writeFileSync(path.join(dir, 'profile.yaml'), 'name: Someone\nemail: someone@example.com\n');
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'ai:\n  enabled: false\n');
  fs.mkdirSync(path.join(dir, 'resumes'));
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  fs.writeFileSync(path.join(dir, 'resumes', `${id}.yaml`), `id: ${id}\nlabel: ${label}\nbase: true\n`);
  return dir;
}

describe('rmm --data', () => {
  let save: string;

  beforeEach(() => {
    save = aSave('The Folder On The Command Line');
  });

  afterEach(() => fs.rmSync(save, { recursive: true, force: true }));

  const rmm = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    run(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', ...args], {
      cwd: root,
      env: { ...process.env, RMM_AUTOCOMMIT: '0', ...env },
      timeout: 60_000,
    });

  it('lists the save the flag names, not the one that is open', async () => {
    const { stdout } = await rmm(['list', '--data', save]);
    expect(stdout).toContain('The Folder On The Command Line');
  });

  /*
   * The precedence that matters for a test pool: the environment may already
   * say one thing, and the command line has to win, or every server started
   * under one exported RMM_DATA shares a store again.
   */
  it('beats RMM_DATA', async () => {
    const other = aSave('The Folder In The Environment');
    try {
      const { stdout } = await rmm(['list', '--data', save], { RMM_DATA: other });
      expect(stdout).toContain('The Folder On The Command Line');
      expect(stdout).not.toContain('The Folder In The Environment');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
