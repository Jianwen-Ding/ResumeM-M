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
  it('takes the --data=folder spelling too', async () => {
    const { stdout } = await rmm(['list', `--data=${save}`]);
    expect(stdout).toContain('The Folder On The Command Line');
  });

  /*
   * The bug this file exists for was a flag that was accepted and discarded.
   * A typo does the same thing for the same reason — `--dta /tmp/copy` means
   * "use the save that happens to be open", which is the one outcome nobody
   * typing it wants.
   */
  it('refuses a flag it does not take, and says what it does take', async () => {
    await expect(rmm(['list', '--dta', save])).rejects.toMatchObject({ code: 1 });
    const failed = await rmm(['serve', '--prot', '9']).catch((e: { stderr: string }) => e);
    expect((failed as { stderr: string }).stderr).toContain('"--prot" is not something `rmm serve` takes');
    expect((failed as { stderr: string }).stderr).toContain('--port');
  });

  it('does not mistake a flag value for a flag', async () => {
    // A commit message is free text, and free text can begin with a dash.
    const said = await rmm(['save', '-m', '--not-a-flag', '--data', save]).catch((e: { stderr: string }) => ({
      stdout: '',
      stderr: e.stderr,
    }));
    expect(`${said.stdout}${said.stderr ?? ''}`).not.toContain('is not something');
  });

  /*
   * A flag, its value, and the resume id all arrive in one list, and every
   * command that takes an id was reading the first thing in that list.
   *
   * So `rmm check --data ~/other-save my-resume` looked up a resume called
   * "--data" and said it did not exist, while the same words in the other
   * order worked — and the message named the resume rather than the ordering,
   * so there was nothing in it to act on. The flag is documented as belonging
   * to every command; putting it first is the ordering most tools teach.
   */
  it('finds the positional argument behind a flag', async () => {
    const { stdout } = await rmm(['feedback', '--data', save, 'the-folder-on-the-command-line']);
    expect(stdout).toContain('AI is disabled');
  });

  /*
   * The same bug wearing different clothes. `voice add` took everything that
   * did not start with a dash as a file to read, which includes the folder
   * `--data` names — so the command failed with "EISDIR: illegal operation on
   * a directory" naming a path the person had typed as a save, not as a file.
   */
  it('does not read a flag value as a file to ingest', async () => {
    const letter = path.join(save, 'letter.txt');
    fs.writeFileSync(letter, 'Dear hiring manager,\n\nI would like to work at your company.\n\nRegards,\nSomeone\n');

    const { stdout, stderr } = await rmm(['voice', 'add', '--data', save, '--no-ai', '--dry-run', letter]);
    expect(stderr).not.toContain('EISDIR');
    expect(stdout).toContain('1 piece of writing');
  });

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
