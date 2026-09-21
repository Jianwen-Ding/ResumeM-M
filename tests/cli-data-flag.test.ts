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
   * The other half of that: a value that is not free text at all, but the
   * next flag, taken as the value because nothing checked.
   *
   * `rmm save -m --push` is the ordering `rmm help` itself prints. It read
   * `--push` as the commit message and committed it — a real commit titled
   * `--push` in somebody's store — then failed to push for want of a remote,
   * and printed only that failure. The commit was never mentioned.
   *
   * Refused against this command's own flags rather than against a leading
   * dash, so the free-text case above keeps working.
   */
  it('refuses a flag that swallowed the next flag instead of a value', async () => {
    const said = await rmm(['save', '-m', '--push', '--data', save]).catch((e: { stderr: string }) => e);
    const stderr = (said as { stderr: string }).stderr ?? '';
    expect(stderr).toContain('-m was given --push as its value');
    expect(stderr).toContain('--message=--push');

    // And nothing was written: no commit, titled `--push` or otherwise.
    const log = await run('git', ['-C', save, 'log', '--oneline'], { timeout: 20_000 }).catch(() => ({ stdout: '' }));
    expect(log.stdout).not.toContain('--push');
  });

  /*
   * The same mistake where it corrupts data rather than history: forgetting
   * to type the role wrote `role: --url` into `applications.yaml`, built a
   * bundle folder named after it, and reported success.
   */
  it('refuses it for a value flag spelled in full, naming the escape hatch', async () => {
    const said = await rmm([
      'apply',
      'the-folder-on-the-command-line',
      '--company',
      'Acme',
      '--role',
      '--url',
      'https://example.com/job',
      '--data',
      save,
    ]).catch((e: { stderr: string }) => e);
    const stderr = (said as { stderr: string }).stderr ?? '';
    expect(stderr).toContain('--role was given --url as its value');
    expect(stderr).toContain('--role=--url');
    expect(fs.existsSync(path.join(save, 'applications.yaml'))).toBe(false);
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

  /*
   * The errno the person sees when they name the folder their letters are in
   * rather than the letters. Every other place the store touches a file
   * translates these; this one printed them.
   */
  it('says what is wrong with a file it cannot read, in words', async () => {
    const folder = await rmm(['voice', 'add', save, '--data', save, '--no-ai', '--dry-run']).catch(
      (e: { stderr: string; stdout: string }) => e,
    );
    const said = `${(folder as { stdout?: string }).stdout ?? ''}${(folder as { stderr: string }).stderr}`;
    expect(said).not.toContain('EISDIR');
    expect(said).toContain('that is a folder, not a file');

    const missing = await rmm([
      'voice',
      'add',
      path.join(save, 'no-such-letter.txt'),
      '--data',
      save,
      '--no-ai',
      '--dry-run',
    ]).catch((e: { stderr: string; stdout: string }) => e);
    const about = `${(missing as { stdout?: string }).stdout ?? ''}${(missing as { stderr: string }).stderr}`;
    expect(about).not.toContain('ENOENT');
    expect(about).toContain('there is nothing at that path');
  });

  /*
   * `--port abc` reached Node's own listen() validation, which reports a type
   * ("number (NaN)") rather than the flag the person typed.
   */
  it('says a port that is not a number is not a number', async () => {
    const said = await rmm(['serve', '--port', 'abc', '--data', save]).catch((e: { stderr: string }) => e);
    const stderr = (said as { stderr: string }).stderr ?? '';
    expect(stderr).not.toContain('NaN');
    expect(stderr).toContain('--port takes a number, and "abc" is not one');
  });

  /*
   * Seeding an empty folder from the bundled example is how a first run gets
   * something to work in, and it happened in silence — so one wrong letter in
   * `--data` created a folder, filled it with the example's resumes, and
   * listed them as if they were the person's own.
   */
  it('says when it started a new save rather than opening one', async () => {
    const typo = path.join(path.dirname(save), `${path.basename(save)}-typo`);
    try {
      const { stdout, stderr } = await rmm(['list', '--data', typo]);
      expect(stderr).toContain(`Started a new save at ${typo}`);
      expect(stderr).toContain('there was nothing there');
      // And it is still a working save: the example is listed, not an error.
      expect(stdout.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(typo, { recursive: true, force: true });
    }
  });

  /*
   * A value flag with nothing after it at all — the same mistake without a
   * second flag to name it by.
   *
   * `arg` reads `argv[i + 1]`, so a flag at the end of the line, one followed
   * by an empty string, and `--data=` all hand back nothing, which is
   * indistinguishable from the flag never having been given. `rmm list
   * --data` listed whichever save happened to be open — and `--data "$UNSET"`
   * is how a script writes that by accident. This file's own header says the
   * point of the flag: "a flag that is accepted and discarded can only be
   * caught from outside".
   */
  it('refuses a value flag that was given no value', async () => {
    const other = aSave('The Folder In The Environment');
    try {
      for (const args of [
        ['list', '--data'],
        ['list', '--data', ''],
        ['list', '--data='],
      ]) {
        const said = await rmm(args, { RMM_DATA: other }).catch((e: { stderr: string }) => e);
        const stderr = (said as { stderr: string }).stderr ?? '';
        const stdout = (said as { stdout?: string }).stdout ?? '';
        expect(stderr, args.join(' ')).toContain('--data was given nothing to be');
        // And it did not quietly fall through to some other save.
        expect(stdout, args.join(' ')).not.toContain('The Folder In The Environment');
      }
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  /*
   * A save is a folder. Pointed at a file, `isEmptyStore` handed it to
   * `readdirSync`, which throws ENOTDIR from the top of the module — outside
   * `main`'s catch — so the answer was a raw Node stack trace naming an
   * internal function.
   */
  it('says a file is not a save folder, rather than throwing a stack trace', async () => {
    const file = path.join(path.dirname(save), `${path.basename(save)}-notes.txt`);
    fs.writeFileSync(file, 'notes\n', 'utf8');
    try {
      const said = await rmm(['list', '--data', file]).catch((e: { stderr: string }) => e);
      const stderr = (said as { stderr: string }).stderr ?? '';
      expect(stderr).toContain('is a file, not a save folder');
      expect(stderr).not.toContain('ENOTDIR');
      expect(stderr).not.toContain('at isEmptyStore');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  /*
   * Seeding runs at module load, before the command has been looked at — so
   * `rmm --help` created and filled a fifteen-file store, and so did a
   * mistyped command. A folder of somebody else's example resumes is not what
   * either asked for, and both left it behind on the way to their output.
   */
  it('does not make a save for a command that does not use one', async () => {
    const fresh = path.join(path.dirname(save), `${path.basename(save)}-helpstore`);
    try {
      const { stdout } = await rmm(['--help'], { RMM_DATA: fresh });
      expect(stdout).toContain('rmm — resume mix-and-match');
      expect(fs.existsSync(fresh), 'no save was made for --help').toBe(false);

      const said = await rmm(['nonsense-command'], { RMM_DATA: fresh }).catch((e) => e);
      void said;
      expect(fs.existsSync(fresh), 'nor for a command that does not exist').toBe(false);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  /*
   * `check` and `apply` say what `build` says about the same compile.
   *
   * Only the resolver's warnings were printed, so `check` — the command
   * documented as "report fit without writing a PDF" — reported the fit and
   * suppressed every finding. On one store, `build` said "A line runs past
   * the right-hand edge of the page — the widest by 238pt — and whatever is
   * past the edge is not in the PDF at all" and `check` on the next line said
   * "✓ 1 page, ~16 lines of room left". `apply` was worse: it files the
   * result as *sent*, and printed the folder, the filename and nothing else.
   *
   * Asserted on the entry a resume lists and the store does not have, because
   * that one is produced by the store rather than by this machine's TeX
   * install, so it says the same thing everywhere.
   */
  it('says what a build would say, on check and on apply', async () => {
    fs.writeFileSync(
      path.join(save, 'resumes', 'broken.yaml'),
      'id: broken\nlabel: Broken\nsections:\n  - kind: experience\n    entries: [exp_gone_forever]\n',
      'utf8',
    );

    const built = await rmm(['build', 'broken', '--data', save]);
    expect(built.stderr).toContain('exp_gone_forever');

    const checked = await rmm(['check', 'broken', '--data', save]);
    expect(checked.stderr, 'check says it too').toContain('exp_gone_forever');

    /*
     * And `apply` fails, rather than warning and reporting success.
     *
     * It returned 0 whatever it had just filed, while `check` fails on the
     * same resume — so a script that files an application and reads the exit
     * code to decide whether it went out cleanly was told yes about one
     * missing an entry its spec still lists, or about a resume that runs to
     * two pages.
     */
    const applied = await rmm([
      'apply', 'broken', '--company', 'Acme', '--role', 'Engineer', '--data', save,
    ]).catch((e) => e);
    expect(applied.stderr, 'and so does the one that files it as sent').toContain('exp_gone_forever');
    expect(applied.code, 'and it does not call that a clean run').toBe(1);
    // The work is not undone by saying so: the bundle is on disk either way.
    expect(applied.stderr).toContain('filed — but not cleanly');
  });

  /*
   * And each resume's warnings go under its own name, once.
   *
   * `resolved.warnings` was printed *before* the header line, and
   * `compileResume` returns it again inside `result.warnings` — so under
   * `--all` every resume's warnings appeared under the previous resume's name
   * and then a second time under its own. A reader of a twenty-resume batch
   * went and fixed the wrong one.
   */
  it('puts each resume’s warnings under its own name, once', async () => {
    fs.writeFileSync(
      path.join(save, 'resumes', 'broken.yaml'),
      'id: broken\nlabel: Broken\nsections:\n  - kind: experience\n    entries: [exp_gone_forever]\n',
      'utf8',
    );

    /*
     * Through a shell, so the two streams arrive interleaved the way a person
     * reading a terminal sees them. The header goes to stdout and the warning
     * to stderr, and this bug is entirely about which of them comes first —
     * captured separately, the order is unrecoverable and the test could not
     * see the fault at all.
     */
    const merged = await run(
      'sh',
      ['-c', `node node_modules/.bin/tsx src/cli.ts build --all --data ${JSON.stringify(save)} 2>&1`],
      { cwd: root, env: { ...process.env, RMM_AUTOCOMMIT: '0' }, timeout: 120_000 },
    );

    // One mention, not two.
    expect(merged.stdout.match(/exp_gone_forever/g) ?? []).toHaveLength(1);

    // And under the resume it belongs to, not the one before it.
    const lines = merged.stdout.split('\n');
    const at = lines.findIndex((l) => l.includes('exp_gone_forever'));
    const owner = lines.slice(0, at).reverse().find((l) => /^\S/.test(l)) ?? '';
    expect(owner).toContain('broken');
  });

  /*
   * A bare flag given a value, which the validator waved through because the
   * name in front of the `=` is one the command takes.
   *
   * `--dry-run` is read with `rest.includes('--dry-run')`, so the token
   * `--dry-run=true` is not it: the preview flag was dropped and the samples
   * were written and committed. `--no-ai=true` sent the file to the AI after
   * an explicit refusal. Both silently, both doing the opposite of what was
   * typed — and `--data=folder` is a spelling this CLI does support, which is
   * exactly why somebody writes the other one.
   */
  it('refuses a bare flag that was given a value, rather than ignoring it', async () => {
    const letter = path.join(save, 'letter.txt');
    fs.writeFileSync(letter, 'Dear Acme, I have spent four years on ingest pipelines and would like to keep going.\n');

    const refused = await rmm(['voice', 'add', letter, '--dry-run=true', '--data', save]).catch((e) => e);
    expect(refused.code, refused.stdout ?? '').toBe(1);
    expect(refused.stderr).toContain('--dry-run takes no value');
    // And nothing was written on the way to saying so.
    expect(fs.existsSync(path.join(save, 'corpus'))).toBe(false);

    // The spelling that is real still works, and still saves nothing.
    const dry = await rmm(['voice', 'add', letter, '--dry-run', '--no-ai', '--data', save]);
    expect(dry.stdout).toContain('dry run');
    expect(fs.existsSync(path.join(save, 'corpus'))).toBe(false);
  }, 120_000);

  /*
   * `--data` is read out of the raw argv before anything validates it, and the
   * seeding runs at module load. So a forgotten folder after `--data` resolved
   * the save to `./--company`, created it, filled it with the bundled example
   * and announced it — and only then did the real error about the typo appear.
   */
  it('does not start a save for a command line it is about to refuse', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-cwd-'));
    try {
      const refused = await run(
        process.execPath,
        [path.join(root, 'node_modules/.bin/tsx'), path.join(root, 'src/cli.ts'),
         'apply', 'base', '--data', '--company', 'Acme', '--role', 'SWE'],
        { cwd, env: { ...process.env, RMM_AUTOCOMMIT: '0' }, timeout: 60_000 },
      ).catch((e) => e);

      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('--data was given --company as its value');
      expect(refused.stderr).not.toContain('Started a new save');
      expect(fs.readdirSync(cwd), 'nothing was left behind').toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  /*
   * The master document gets the same warnings as everything else.
   *
   * `build`, `check` and `apply` all print `result.warnings`; `master` never
   * read them. They are about the compile rather than about any one resume —
   * a font the engine had to substitute, a line running past the right edge
   * and therefore missing from the PDF — and the master document is the most
   * likely of all of them to produce one, because it holds every entry in the
   * store at once.
   */
  it('says on the master document what it says on a resume', async () => {
    const built = await rmm(['build', '--all', '--data', save]);
    const warned = (built.stderr.match(/^\s*! /gm) ?? []).length > 0;
    // This machine's TeX install produces one; a machine with lmodern would
    // not, and there would then be nothing for this to compare.
    expect(warned, 'the compile warns about something here').toBe(true);

    const master = await rmm(['master', '--data', save]);
    expect(master.stderr).toMatch(/^\s*! /m);
  }, 120_000);

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
