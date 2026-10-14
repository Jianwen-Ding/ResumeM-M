#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './ai/agent.js';
import { feedbackPrompt } from './ai/prompts.js';
import { ignoreBrokenPipe } from './cli-io.js';
import { Repo, cloneRepo, commitQuietly } from './git/repo.js';
import { saveStore } from './git/save.js';
import { ingestFile } from './ingest/index.js';
import { findProjectRoot, isEmptyStore, resolveStore, seedStore } from './model/location.js';
import { buildBundle, localDay, slug, stats } from './model/applications.js';
import { buildMaster, resolveResume } from './model/resolve.js';
import { Store, aiSwitchedOff } from './model/store.js';
import { currentIgnore } from './model/current.js';
import { cloneProject, rememberProject } from './model/projects.js';
import { compileResume, OverflowError } from './render/compile.js';
import type { StoreConfig, WritingSample } from './model/types.js';
import { portFree, portInUseMessage, startServer } from './server/index.js';
import { ErrorLog, appVersion } from './errorlog/log.js';
import { windowMinutes, type LogEvent } from './errorlog/buffer.js';

// Every command here prints as it goes rather than buffering everything up
// front, so every command can meet a reader that stops early. See cli-io.ts.
ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

const projectRoot = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
/*
 * `--data` belongs to every command, not to one, which is why it is read here
 * rather than inside the switch: `rmm list --data other-save` should list that
 * save, and `rmm serve --data other-save` should serve it.
 *
 * It used to be read nowhere at all. `rmm serve --data /tmp/copy` started, said
 * nothing, and served whichever save was open — so a pool of servers each given
 * its own copy of a store was in fact three servers writing to one real store,
 * which is the exact thing that arrangement exists to prevent. A flag that is
 * accepted and discarded is worse than one that is rejected.
 */
const { dir: dataDir, from: dataFrom } = resolveStore(projectRoot, arg(process.argv.slice(2), 'data'));
/*
 * Say so when a save is made rather than opened.
 *
 * Seeding an empty folder from the bundled example is how a first run gets a
 * store to work in, and it said nothing — so `rmm list --data ~/saves/wrok`,
 * one letter wrong, created a folder, filled it with the example's four
 * resumes, and listed them as though they were the person's own. A typo
 * produced a working-looking save instead of a message naming the path that
 * does not exist. One line is the difference, and refusing instead would
 * break the first run this exists for.
 */
/**
 * The commands that actually work in a store, so nothing else makes one.
 *
 * Seeding runs at module load, before the command has been looked at — so
 * `rmm --help` created and filled a fifteen-file store, and so did a
 * mistyped command, and so did `rmm --data /some/path list`, which this file
 * claims to support and which reaches the switch as the command `--data`.
 * A folder full of somebody else's example resumes is not what any of those
 * three asked for, and all three left it behind on the way to an error.
 */
const WORKS_IN_A_STORE = new Set([
  'list',
  'build',
  'check',
  'master',
  'feedback',
  'apply',
  'track',
  'save',
  'pull',
  'voice',
  'serve',
  'config',
]);

/*
 * A save is a folder. Said here, because everything below assumes it: the
 * store reads and writes files inside this path, and pointed at a file it
 * quietly found nothing and reported "No resumes yet. Add one under
 * data/resumes/" about a text file the user had named on purpose.
 */
const at = fs.statSync(dataDir, { throwIfNoEntry: false });
if (at && !at.isDirectory()) {
  console.error(`${dataDir} is a file, not a save folder. Point --data at a folder, or at a new one to start.`);
  process.exit(1);
}

const USAGE = `rmm — resume mix-and-match

  rmm list                        List resumes in the store
  rmm build <id>                  Compile one resume to out/<id>.pdf
  rmm build --all                 Compile every resume
  rmm check <id>                  Report fit without writing a PDF
  rmm master                      Compile the master document (everything)
  rmm feedback <id> [--focus "…"] Ask the configured AI for feedback
  rmm apply <id> --company C --role R [--url U]
                                  Build a named application bundle and track it
  rmm track                       Show the application tracker
  rmm voice add <file…> [--dry-run] [--no-ai]
                                  Read files into your writing corpus, sorted
                                  into letters, answers, resumes, and the rest
  rmm save [-m "why"] [--pull] [--push]
                                  Commit everything in the store to git, then
                                  bring in the remote's changes and send yours
  rmm pull                        Bring in what was pushed from another machine
  rmm config set ai.enabled <true|false>
                                  Turn the AI on or off; on also answers a
                                  pull or clone that switched it off here
  rmm clone <repo> <folder>       Bring a save down from where it is pushed,
                                  and open it
  rmm serve [--port 4600]         Start the editor GUI and extension API
  rmm log "what went wrong" [--minutes 10] [--screenshot <file>]…
                                  Write an entry in the error log, with the
                                  running server's logs from the minutes before
  rmm log status                  Where the error log is, its remote, its
                                  newest entries
  rmm log remote <url>            Set (or with --remove, take away) its remote
  rmm log push | rmm log pull     Send its entries there, or bring them in

Any command also takes:
  --data <folder>    Work on the save in this folder instead of the one that is
                     open. Beats RMM_DATA and the remembered save.

Environment:
  RMM_DATA           Where the store lives. Defaults to ~/.resumem-m/store,
                     seeded from the bundled example on first run. The store is
                     its own git repository, separate from this source tree.
  RMM_AUTOCOMMIT=0   Do not commit store changes.
  RMM_AI=0           Keep the AI off whatever config.yaml says.
  RMM_ERROR_LOG_DIR  Where the error log lives. Defaults to
                     ~/.resumem-m/error-log, a git repository of its own.
`;

function arg(argv: string[], name: string): string | undefined {
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  // `--data=/some/save` is how half of every other tool is written, and it
  // used to resolve to nothing at all — the same silent miss as a flag that
  // is never read.
  if (joined) return joined.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Every flag each command takes, so one it does not take can be said out loud.
 *
 * `rmm serve --data /tmp/copy` accepted the flag and ignored it for as long as
 * the flag existed, and a typo like `--dta` still would: it quietly means
 * "serve the save that happens to be open", which is the one outcome nobody
 * asking for `--data` wants. An unknown flag is a mistake every time, and
 * saying so costs one line.
 */
const TAKES: Record<string, { value?: string[]; bare?: string[] }> = {
  build: { bare: ['all'] },
  feedback: { value: ['focus'] },
  apply: { value: ['company', 'role', 'url'] },
  save: { value: ['message', 'm'], bare: ['push', 'pull'] },
  voice: { bare: ['dry-run', 'no-ai'] },
  serve: { value: ['port'] },
  log: { value: ['minutes', 'screenshot', 'server'], bare: ['remove'] },
};

/** The flags whose value is free text, and so may legitimately begin with a dash. */
const FREE_TEXT = new Set(['m', 'message', 'focus']);

/** Every command there is, for telling an unknown one from a known one given a stray flag. */
const COMMANDS = new Set([...WORKS_IN_A_STORE, 'clone', 'log', 'help', '--help', '-h']);

/**
 * `--data` before the command, moved after it.
 *
 * `--data` belongs to every command, and every tool with a flag like that —
 * git's `-C`, docker's `--context` — takes it before the command as readily as
 * after. `rmm --data ~/saves/work list` was read as the command `--data` and
 * refused as unknown, though the folder had been read correctly all along.
 */
export function commandFirst(argv: string[]): string[] {
  const [first, second, ...rest] = argv;
  if (first === '--data' && second !== undefined) return [...rest.slice(0, 1), '--data', second, ...rest.slice(1)];
  if (first?.startsWith('--data=') && second !== undefined) return [second, first, ...rest];
  return argv;
}

/** The first flag this command does not take, with what it does take. */
function unknownFlag(command: string, rest: string[]): string | null {
  const spec = TAKES[command] ?? {};
  // `--data` is every command's, which is the whole point of reading it once.
  const value = new Set(['data', ...(spec.value ?? [])]);
  const bare = new Set(spec.bare ?? []);

  /**
   * A flag that swallowed the next flag instead of a value.
   *
   * `rmm save -m --push` is the ordering the usage banner itself prints, and
   * it read `--push` as the commit message: the store got a real commit
   * titled `--push`, the push then failed for want of a remote, and the only
   * thing said out loud was that failure — so a bad commit landed in somebody's
   * history with nothing on screen to suggest it. `rmm apply x --company Acme
   * --role --url https://…` did the same to an application record, writing
   * `role: --url` into `applications.yaml` and reporting a clean success.
   *
   * Judged against this command's own flags rather than against a leading
   * dash, because a commit message is free text and free text may begin with
   * one. `--push` after `-m` is a mistake; `--not-a-flag` is a message.
   */
  const stolenFlag = (flag: string, next: string | undefined): boolean => {
    if (!next?.startsWith('--') || next === '--') return false;
    const n = next.slice(2).split('=')[0] ?? '';
    if (value.has(n) || bare.has(n)) return true;
    /*
     * And any `--` at all after a flag whose value can never begin with one.
     *
     * The rule above is right for free text and only for free text: a commit
     * message or a feedback focus may start with a dash. A folder, a port, a
     * url, a company or a role does not. Judged only against this command's
     * own flags, `rmm list --data --foo` — a mistyped flag straight after
     * `--data` — took `--foo` as the folder, created it, filled it with the
     * bundled example, and listed those resumes as though they were yours.
     */
    return !FREE_TEXT.has(flag.replace(/^--?/, '').split('=')[0] ?? '');
  };
  const noValue = (flag: string, next: string): string => {
    const spelled = flag === '-m' ? '--message' : flag;
    const n = next.slice(2).split('=')[0] ?? '';
    const what = value.has(n) || bare.has(n) ? `another flag \`rmm ${command}\` takes` : 'a flag, not a value';
    return (
      `${flag} was given ${next} as its value, but ${next} is ${what} — ` +
      `so ${flag} has no value. Put the value after ${flag}, or write ${spelled}=${next} if that really is the value.`
    );
  };
  /*
   * And a flag with nothing after it at all, which is the same mistake
   * without a second flag to name.
   *
   * `arg` reads `argv[i + 1]`, so a flag at the end of the line, one followed
   * by an empty string, and `--data=` all hand back nothing — and nothing is
   * indistinguishable from "the flag was never given". `rmm list --data`
   * listed whichever save happened to be open; `rmm apply … --url` wrote a
   * tracker row with no url and exited 0; `rmm feedback base --focus` dropped
   * the focus and produced a generic prompt. `--data "$UNSET"` is how a
   * script writes the first of those by accident, and this file's own note
   * says the point of `--data` is that "a flag that is accepted and discarded
   * is worse than one that is rejected".
   */
  const nothingAfter = (flag: string): string =>
    `${flag} was given nothing to be. Put its value after it, or leave ${flag} off — ` +
    `as it stands ${flag} does nothing, which is not what it looks like.`;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    if (token === '--') break; // everything after it is a value, by convention
    if (token === '-m' && value.has('m')) {
      if (rest[i + 1] === undefined || rest[i + 1] === '') return nothingAfter('-m');
      if (stolenFlag('-m', rest[i + 1])) return noValue('-m', rest[i + 1]!);
      i++;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const name = token.slice(2).split('=')[0] ?? '';
    if (value.has(name)) {
      if (token.includes('=')) {
        if (token.slice(token.indexOf('=') + 1) === '') return nothingAfter(`--${name}`);
        continue;
      }
      if (rest[i + 1] === undefined || rest[i + 1] === '') return nothingAfter(token);
      if (stolenFlag(token, rest[i + 1])) return noValue(token, rest[i + 1]!);
      i++; // its value is not a flag
      continue;
    }
    if (bare.has(name)) {
      /*
       * And a bare flag given one, which is the same mistake the other way up.
       *
       * `--dry-run` is read with `rest.includes('--dry-run')`, so the token
       * `--dry-run=true` is not it — and this line waved it through, because
       * the name in front of the `=` is a flag the command takes. `rmm voice
       * add letters.txt --dry-run=true` therefore saved every sample it found
       * and committed them, having been told to preview; `--no-ai=true` sent
       * the files to the AI after an explicit refusal.
       *
       * `--data=` is a real spelling this file supports, which is exactly why
       * somebody writes `--dry-run=true`. This note's own rule settles it: a
       * flag that is accepted and discarded is worse than one that is
       * rejected.
       */
      if (token.includes('=')) {
        return (
          `--${name} takes no value, so ${token} is not it — and \`rmm ${command}\` would have ignored ` +
          `the whole thing and carried on. Write --${name} on its own, or leave it off.`
        );
      }
      continue;
    }

    const known = [...value, ...bare].sort().map((f) => `--${f}`);
    return `"${token}" is not something ${command ? `\`rmm ${command}\`` : 'rmm'} takes. It takes: ${known.join(', ')}.`;
  }
  return null;
}

/**
 * What is left of a command's arguments once its flags are taken out.
 *
 * A flag, the folder it names, and the resume id all arrive in the same list,
 * and every command that takes an id was reading the first thing in that list.
 * So `rmm check --data ~/other-save my-resume` looked up a resume called
 * "--data" and reported that it does not exist, while the same words in the
 * other order worked — and the message named the resume rather than the
 * ordering, so there was nothing in it to act on. `--data` is documented as
 * belonging to every command, and putting a flag before the thing it applies
 * to is the ordering most tools teach.
 *
 * `voice add` had the same bug wearing different clothes: it took every token
 * that did not begin with a dash as a file to read, which includes the folder
 * `--data` names, and failed with "EISDIR: illegal operation on a directory"
 * naming a path the person had typed as a save.
 *
 * Driven by the same table `unknownFlag` reads, so a flag cannot be known to
 * one and unknown to the other.
 */
function positionals(command: string, rest: string[]): string[] {
  const spec = TAKES[command] ?? {};
  const value = new Set(['data', ...(spec.value ?? [])]);
  const out: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    // Everything after `--` is a value, by convention — which is how you name
    // a file that begins with a dash.
    if (token === '--') {
      out.push(...rest.slice(i + 1));
      break;
    }
    if (token === '-m' && value.has('m')) {
      i++;
      continue;
    }
    if (token.startsWith('--')) {
      const name = token.slice(2).split('=')[0] ?? '';
      if (value.has(name) && !token.includes('=')) i++; // its value is not a positional
      continue;
    }
    // A lone `-x`: not a positional either. `unknownFlag` only judges `--`
    // flags, so this is where a single-dash typo stops being a filename.
    if (token.startsWith('-') && token.length > 1) continue;
    out.push(token);
  }
  return out;
}

/** `-m "message"`, because every other tool that commits accepts it. */
function shortFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Commit what a command has just written, and let a failed commit be a
 * warning rather than a failed command.
 *
 * `apply` and `voice add` called `repo.commitAll` bare, so a commit that
 * failed — git's `index.lock` held by a server on the same save, most often —
 * failed the command after its work was done: `rmm apply` filed the
 * application, wrote the bundle, and exited 1, and a script reading that
 * would file it again. The same handling as the server's (`commitQuietly`):
 * the write stands, and what is owed is a line saying the history did not
 * get it, and how to put it there. A commit with nothing in it — the
 * server's own commit took these files a moment before — is not a failure.
 *
 * `ensure` first, because `commitAll` returns nothing when the save is not a
 * repository yet, so a CLI-only user with auto-commit on got no history at
 * all and nothing said so.
 */
async function commitFromTerminal(repo: Repo, message: string, paths?: string[]): Promise<void> {
  try {
    await repo.ensure();
  } catch (err) {
    repo.lastCommitError = { message: err instanceof Error ? err.message : String(err), at: new Date().toISOString() };
  }
  if (!repo.lastCommitError) await commitQuietly(repo, message, paths);
  if (repo.lastCommitError) {
    console.warn(
      `  ! Written, but not in the version history yet: ${repo.lastCommitError.message}. ` +
        `\`rmm save --data ${repo.root}\` adds it.`,
    );
  }
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/**
 * A file to read into the corpus, or a sentence saying why it is not one.
 *
 * `rmm voice add ~/letters` — naming the folder the letters are in, which is
 * the first thing anyone tries — failed with "EISDIR: illegal operation on a
 * directory, read", and a mistyped filename failed with an ENOENT that printed
 * the same path a second time inside quotes. Neither says what to do about it.
 *
 * The store already translates these codes where it deletes and writes files
 * (`removeFile` in model/store.ts); this is the one place that read a file the
 * person named and passed the system's words straight through.
 */
function readForVoice(file: string): Buffer {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new Error('there is nothing at that path');
    if (code === 'EACCES' || code === 'EPERM') throw new Error('it is not readable by this account');
    throw new Error(clean(err));
  }
  if (stat.isDirectory()) {
    throw new Error('that is a folder, not a file — name the files inside it, or `<folder>/*.txt` to add them all');
  }
  try {
    return fs.readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EACCES' || code === 'EPERM') throw new Error('it is not readable by this account');
    throw new Error(clean(err));
  }
}

/**
 * A rare errno kept in the system's own words, minus the path it repeats.
 *
 * The path is already at the front of the line the caller prints, and it is
 * the half of the raw message that made it unreadable.
 */
function clean(err: unknown): string {
  const said = err instanceof Error ? err.message : String(err);
  return said.replace(/,\s*\w+\s+'[^']*'\s*$/, '');
}

/**
 * The verdict, with the page count the PDF really has.
 *
 * This said "✓ 1 page" of anything that fitted — a resume allowed two pages
 * and set across both of them included, which is the one case where the
 * count is news. The count is the compile's, and how many pages were allowed
 * is said beside it whenever that is more than the one this tool is named
 * for, so "2 pages" reads as permitted rather than as a mistake.
 */
function fmtFit(r: {
  pages: number;
  fits: boolean;
  overflowPt: number;
  overflowLines: number;
  adjustments: string[];
  layout: { maxPages: number };
}): string {
  if (!r.fits) {
    return `✗ ${r.pages} pages — over by ${r.overflowPt.toFixed(0)}pt (~${r.overflowLines} lines)`;
  }
  const slack = Math.abs(r.overflowLines);
  const room = r.overflowPt < 0 ? `, ~${plural(slack, 'line')} of room left` : '';
  const adj = r.adjustments.length > 0 ? ` [auto-fit: ${r.adjustments.join('; ')}]` : '';
  const allowed = r.layout.maxPages > 1 ? ` (allowed ${r.layout.maxPages})` : '';
  return `✓ ${plural(r.pages, 'page')}${allowed}${room}${adj}`;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  /*
   * Only for a command that exists. An unknown one given a stray flag was told
   * `rmm bogus` takes only `--data` — which is to say it was told `rmm bogus`
   * is a command — when the one useful thing to say is that it is not. The
   * switch below says that, with the usage.
   */
  const wrong =
    command && COMMANDS.has(command) && !['help', '--help', '-h'].includes(command) ? unknownFlag(command, rest) : null;
  if (wrong) {
    console.error(wrong);
    return 1;
  }

  const store = new Store(dataDir);
  const repo = Repo.forStore(dataDir, () => currentIgnore(store));
  // What it says to do next is said for a terminal. See `Repo.inTerminal`.
  repo.inTerminal = true;

  switch (command) {
    case 'list': {
      const resumes = store.loadResumes();
      if (resumes.length === 0) {
        console.log('No resumes yet. Add one under data/resumes/.');
        return 0;
      }
      for (const r of resumes) {
        const from = r.copiedFrom ? ` (copied from ${r.copiedFrom})` : '';
        const n = Object.keys(r.choices ?? {}).length;
        console.log(`  ${r.id.padEnd(20)} ${r.label}${from}  — ${n} choice${n === 1 ? '' : 's'}`);
      }
      return 0;
    }

    case 'build': {
      const data = store.load();
      const all = rest.includes('--all');
      const ids = all ? data.resumes.map((r) => r.id) : [positionals('build', rest)[0]];
      if (!ids[0]) {
        // "Which resume?" is the wrong question when the answer was "all of
        // them" and there are none.
        console.error(all ? 'There are no resumes in this save yet.' : 'Which resume? Try `rmm list`.');
        return 1;
      }
      let failed = false;
      for (const id of ids) {
        if (!id) continue;
        try {
          /*
           * Inside the try, so `--all` is a batch rather than a queue that
           * stops at the first problem. One unresolvable resume threw out here
           * and killed the run: the rest were never built and never mentioned,
           * and the exit code said only that something failed.
           */
          const resolved = resolveResume(id, data);
          const out = path.join(store.outDir(), `${id}.pdf`);
          const result = await compileResume(resolved, {
            pdfPath: out,
            texPath: out.replace(/\.pdf$/, '.tex'),
            strict: true,
            engine: data.config.latex.engine,
          });
          console.log(`${id.padEnd(20)} ${fmtFit(result)}  → ${path.relative(process.cwd(), out)}`);
          /*
           * And what the compile itself had to say, which nothing printed.
           *
           * Only the resolver's warnings were shown, so everything
           * `compileResume` works out from the LaTeX log — the font fallback
           * that makes a PDF an ATS cannot read, and a line that ran off the
           * edge of the page taking its text with it — was gathered, returned,
           * and dropped on the floor by the one command whose whole job is to
           * report on a build.
           *
           * After the header line, and only from here, which is a second
           * thing this used to get wrong. `resolved.warnings` was printed
           * *before* the header and `compileResume` returns it again inside
           * `result.warnings`, so under `--all` every resume's warnings
           * appeared under the previous resume's name and then a second time
           * under its own. A reader of a twenty-resume batch went and fixed
           * the wrong one.
           */
          for (const w of result.warnings) console.warn(`  ! ${w}`);
        } catch (err) {
          failed = true;
          console.error(`${id.padEnd(20)} ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return failed ? 1 : 0;
    }

    case 'check': {
      const id = positionals('check', rest)[0];
      if (!id) {
        console.error('Which resume?');
        return 1;
      }
      const data = store.load();
      const resolved = resolveResume(id, data);
      const result = await compileResume(resolved, { engine: data.config.latex.engine });
      console.log(`${id}: ${fmtFit(result)}`);
      /*
       * Everything `build` says, because this is the command for asking
       * without writing a PDF — and it reported the fit and suppressed the
       * findings. On the same resume, `build` said "A line runs past the
       * right-hand edge of the page — the widest by 238pt — and whatever is
       * past the edge is not in the PDF at all", and `check` said
       * "✓ 1 page, ~16 lines of room left".
       */
      for (const w of result.warnings) console.warn(`  ! ${w}`);
      console.log(`  used ${result.usedPt}pt of ${result.availablePt}pt available`);
      return result.fits ? 0 : 1;
    }

    case 'master': {
      const data = store.load();
      const out = path.join(store.outDir(), 'master.pdf');
      const result = await compileResume(buildMaster(data), {
        pdfPath: out,
        texPath: out.replace(/\.pdf$/, '.tex'),
        engine: data.config.latex.engine,
      });
      console.log(`master: ${result.pages} page(s) → ${path.relative(process.cwd(), out)}`);
      console.log('Every entry, bullet, and phrasing in the store, labelled with its id.');
      /*
       * The same warnings `build`, `check` and `apply` print, which this one
       * threw away. They are about the compile rather than about any resume —
       * a font the engine had to substitute, a line that runs past the right
       * edge and is therefore not in the PDF at all — and the master document
       * is the one most likely to produce them, because it holds every entry
       * in the store at once.
       */
      for (const w of result.warnings) console.warn(`  ! ${w}`);
      return 0;
    }

    case 'feedback': {
      const id = positionals('feedback', rest)[0];
      if (!id) {
        console.error('Which resume?');
        return 1;
      }
      const data = store.load();
      const prompt = feedbackPrompt(data, resolveResume(id, data), arg(rest, 'focus'));
      const result = await runAgent(data.config, prompt);
      if (!result.executed) {
        /*
         * Why, in the words that fit. "ai.enabled: false in config.yaml" was
         * said whatever the reason, so somebody whose AI a pull had switched
         * off went to config.yaml, found `enabled: true` there, and had
         * nothing to go on. The switch-off says what changed, and how to
         * answer it from here.
         */
        const switchedOff = aiSwitchedOff(store.root);
        if (switchedOff) {
          console.log(`AI is switched off on this machine. ${switchedOff}`);
          console.log(
            `Look at the command in ${path.join(dataDir, 'config.yaml')}, then turn it back on with ` +
              '`rmm config set ai.enabled true` (or in Settings in `rmm serve`).',
          );
        } else if (process.env.RMM_AI === '0') {
          console.log('AI is disabled (RMM_AI=0 is set in the environment).');
        } else {
          console.log(`AI is disabled (ai.enabled is not true in ${path.join(dataDir, 'config.yaml')}).`);
        }
        console.log('Here is the prompt it would have run — paste it wherever you like:\n');
      }
      console.log(result.output);
      return 0;
    }

    case 'apply': {
      const id = positionals('apply', rest)[0];
      const company = arg(rest, 'company');
      const role = arg(rest, 'role');
      if (!id || !company || !role) {
        console.error('Usage: rmm apply <resumeId> --company "Acme" --role "SWE Intern" [--url U]');
        return 1;
      }
      const result = await buildBundle(store, { resumeId: id, company, role, url: arg(rest, 'url') });
      if (store.loadConfig().git.autoCommit) {
        /*
         * Only what this command wrote: the tracker, the resumes it may have
         * marked as kept (see `Store.saveApplications`), and the bundle when
         * it is inside the save. A server running on the same save has edits
         * of its own on disk, and `.` put them into this commit under
         * "Apply: …", to be missing from the commit that was theirs.
         */
        const bundle = path.relative(store.root, result.dir);
        const inside = bundle && !bundle.startsWith('..') && !path.isAbsolute(bundle);
        await commitFromTerminal(repo, `Apply: ${company} — ${role}`, [
          'applications.yaml',
          'resumes',
          ...(inside ? [bundle.split(path.sep).join('/')] : []),
        ]);
      }
      console.log(`Bundle → ${path.relative(process.cwd(), result.dir)}`);
      for (const f of result.files) console.log(`  ${f}`);
      if (!result.fits) console.warn(`  ! resume is ${result.pages} pages`);
      /*
       * And everything `build` says about the same compile, which this threw
       * away — on the one command that files the result as *sent*.
       *
       * Measured on one store: `rmm build` reported "A line runs past the
       * right-hand edge of the page — the widest by 238pt — and whatever is
       * past the edge is not in the PDF at all", and `rmm apply` on the very
       * next line printed the folder, the filename, and nothing else. The URL
       * was absent from the PDF that had just been filed as sent.
       *
       * `missing` is separate from `warnings` and exists solely to be shown:
       * an entry the spec lists and the store has since lost means the resume
       * that went out is not the one that was on screen.
       */
      for (const w of result.warnings) console.warn(`  ! ${w}`);
      if (result.missing) console.warn(`  ! ${result.missing}`);
      /*
       * And the exit code says what the warnings say.
       *
       * This returned 0 whatever it had just filed. `check` fails on a resume
       * that does not fit, and this is the command that writes the bundle and
       * records the application as sent — so a script that files an
       * application and reads the exit code to decide whether it went out
       * cleanly was told yes about a two-page resume, or about one missing an
       * entry its spec still lists.
       *
       * The files are written and the row is filed either way: this reports
       * the state of what happened, it does not undo it. Hence the line
       * saying so, rather than leaving the number to speak for itself.
       */
      // The letter too: it is attached beside the resume, and a two-page one
      // is as much "not cleanly" as a two-page resume.
      if (!result.fits || result.letterFits === false || result.missing) {
        console.warn('The bundle is written and the application is filed — but not cleanly. See above.');
        return 1;
      }
      return 0;
    }

    case 'track': {
      const apps = store.load().applications;
      const s = stats(apps);
      console.log(`${s.total} applications — ${s.last7} in the last 7 days, ${s.last30} in the last 30`);
      console.log(`Response rate (OA or beyond): ${s.responseRate}%\n`);
      for (const a of [...apps].sort((x, y) => (y.appliedAt ?? '').localeCompare(x.appliedAt ?? ''))) {
        /*
         * The day on this machine's clock, as the ids, the GUI and every
         * other date this program shows. `appliedAt` is UTC, and its first
         * ten characters are the day in Greenwich: an application filed on
         * the evening of the 11th in California printed as the 12th here,
         * beside an id and a tracker row both reading the 11th. A bare date
         * typed by hand has no time to move, and is printed as it is.
         */
        const at = a.appliedAt ? new Date(a.appliedAt) : undefined;
        const when = !a.appliedAt
          ? '          '
          : /^\d{4}-\d{2}-\d{2}$/.test(a.appliedAt) || Number.isNaN(at!.getTime())
            ? a.appliedAt.slice(0, 10)
            : localDay(at);
        console.log(`  ${when}  ${a.status.padEnd(10)} ${a.company} — ${a.role}`);
      }
      return 0;
    }

    /**
     * "Put everything into git", as one command. Auto-commit covers edits made
     * through the app; this covers everything else — hand-edited YAML, a store
     * that is not a repository yet, auto-commit switched off — and pushes if
     * asked.
     */
    case 'save': {
      const result = await saveStore(repo, {
        message: arg(rest, 'message') ?? arg(rest, 'm') ?? shortFlag(rest, '-m'),
        push: rest.includes('--push'),
        pull: rest.includes('--pull'),
      });

      if (result.initialised) console.log(`Initialised a git repository at ${dataDir}`);

      if (result.saved) {
        console.log(`Saved ${plural(result.files.length, 'file')} — ${result.message}  [${result.hash?.slice(0, 8)}]`);
        const MARK = { added: '+', modified: 'M', deleted: '−', renamed: '→' };
        for (const f of result.files.slice(0, 20)) console.log(`  ${MARK[f.state]} ${f.path}`);
        if (result.files.length > 20) console.log(`  … and ${result.files.length - 20} more`);
      } else {
        console.log('Everything is already saved — nothing had changed.');
      }

      if (result.pulled) {
        if (!result.pulled.ok) {
          console.error(`Pull failed: ${result.pulled.message}`);
          if (rest.includes('--push')) console.error('Nothing was pushed, since the pull did not go through.');
          return 1;
        }
        console.log(result.pulled.message);
      }
      if (result.pushed) {
        console.log(result.pushed.ok ? result.pushed.output : `Push failed: ${result.pushed.output}`);
        if (!result.pushed.ok) return 1;
      } else if (!result.remote.url) {
        console.log(`Stored locally in ${dataDir} (no remote configured).`);
      } else if (!result.remote.tracked) {
        console.log(`${result.remote.url} has never been pushed to — \`rmm save --push\` sends everything.`);
      } else if (result.remote.ahead > 0) {
        console.log(`${plural(result.remote.ahead, 'commit')} not yet pushed to ${result.remote.url} — \`rmm save --push\` sends them.`);
      }
      return 0;
    }

    /**
     * Change a setting in config.yaml without opening the editor. One setting
     * for now, `ai.enabled`, because it is the one a terminal-only machine
     * cannot otherwise answer: a pull or a clone that changes the AI command
     * switches the AI off here until somebody turns it on (see
     * `aiCommandChange`), and Settings was the only way back.
     *
     * Through `Store.saveConfig` and committed as "Update settings", exactly
     * as the editor's `PUT /config` does it — so turning it on clears the
     * switch-off the same way, and turning it off while switched off leaves
     * config.yaml's own value alone, as there.
     */
    case 'config': {
      const [sub, key, value] = positionals('config', rest);
      const usage = 'Usage: rmm config set ai.enabled <true|false>';
      if (sub !== 'set' || key === undefined || value === undefined) {
        console.error(usage);
        return 1;
      }
      if (key !== 'ai.enabled') {
        console.error(`${key} cannot be set from here; ai.enabled is the one setting this command changes. Settings in \`rmm serve\` has the rest.\n${usage}`);
        return 1;
      }
      if (value !== 'true' && value !== 'false') {
        console.error(`ai.enabled is true or false, not ${JSON.stringify(value)}.\n${usage}`);
        return 1;
      }
      const enabled = value === 'true';
      const wasSwitchedOff = aiSwitchedOff(store.root);
      /*
       * Off while a pull or a clone has it switched off is already the case,
       * and config.yaml is left as it says it (see `Store.saveConfig`). Said
       * here before anything is saved: saved anyway, the file was written
       * back without its comments and committed, under a message saying it
       * was unchanged.
       */
      if (!enabled && wasSwitchedOff) {
        console.log('AI is already off on this machine, switched off by a pull or a clone; config.yaml is unchanged.');
        return 0;
      }
      /*
       * Written, then committed as `apply` and `voice add` commit: through
       * `commitFromTerminal`, whose failure is a line saying the history did
       * not get it and how to put it there. Through `withCommit` it was the
       * server's line — "[rmm] auto-commit failed: …" and `lastCommitError`,
       * which nothing in a terminal reads — and a commit the server's own had
       * emptied a moment before (see `SaveLock`) read as a failure.
       */
      const saved = store.saveConfig({ ai: { enabled } as StoreConfig['ai'] });
      // Only the one file this wrote, as `apply` does.
      if (store.loadConfig().git.autoCommit) await commitFromTerminal(repo, 'Update settings', ['config.yaml']);
      if (enabled) {
        console.log(`AI on — it will run ${saved.ai.command} ${saved.ai.args.join(' ')}`.trimEnd());
        if (wasSwitchedOff) console.log('The switch-off from the last pull or clone is cleared.');
        if (!saved.ai.enabled && process.env.RMM_AI === '0') console.log('RMM_AI=0 in the environment still keeps it off.');
      } else {
        console.log('AI off — every action hands you the prompt.');
      }
      return 0;
    }

    /**
     * Bring in what another machine pushed: `Repo.pull`, the same as the
     * editor's Pull button. Exits non-zero for anything but a pull that went
     * through, a conflict included, so a script syncing two machines stops
     * there rather than pushing a save that is about to be merged by hand.
     *
     * With a server running on this same save, the two take turns: the
     * pull's merge holds the save's lock (see `SaveLock`), so the server's
     * writes wait for it rather than landing in the middle, and the server
     * reads what came in on its next request.
     */
    case 'pull': {
      const result = await repo.pull();
      if (!result.ok) {
        console.error(result.message);
        if (result.conflict?.length) {
          for (const file of result.conflict) console.error(`  conflict: ${file}`);
        }
        return 1;
      }
      console.log(result.message);
      for (const file of result.files.slice(0, 20)) console.log(`  ${file}`);
      if (result.files.length > 20) console.log(`  … and ${result.files.length - 20} more`);
      return 0;
    }

    /**
     * Put files into the corpus the AI learns your voice from. The sorting is
     * the feature: a file with four old cover letters in it becomes four
     * samples, not one lump nobody will ever read back.
     */
    case 'voice': {
      const [sub, ...files] = positionals('voice', rest);
      if (sub !== 'add') {
        console.error('Usage: rmm voice add <file…> [--dry-run] [--no-ai]');
        return 1;
      }

      const paths = files;
      if (paths.length === 0) {
        console.error('Name at least one file to add.');
        return 1;
      }

      const dryRun = rest.includes('--dry-run');
      const useAi = !rest.includes('--no-ai');
      const config = store.loadConfig();
      const stamp = Date.now().toString(36);
      const samples: WritingSample[] = [];
      let failed = 0;
      let skipped = 0;

      for (const file of paths) {
        let found;
        try {
          found = await ingestFile(config, path.basename(file), readForVoice(file), { useAi });
        } catch (err) {
          console.error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
          failed++;
          continue;
        }
        // A file that keeps itself out (`voice: false` in its header) is said
        // as skipped, not as a file with no writing in it.
        if (found.skipped) {
          console.log(`${file} — skipped: ${found.skipped}.`);
          skipped++;
          continue;
        }

        console.log(`${file} — ${plural(found.items.length, 'piece')} of writing${found.usedAi ? ', sorted by AI' : ''}`);
        if (found.aiError) console.log(`  (the AI could not be reached: ${found.aiError} — sorted by rules instead)`);

        for (const item of found.items) {
          console.log(`  ${item.kind.padEnd(6)} ${item.title}`);
          samples.push({
            id: `${slug(item.title) || 'sample'}-${stamp}-${samples.length}`,
            title: item.title,
            kind: item.kind,
            text: item.text,
            createdAt: new Date().toISOString(),
            tags: [`from:${path.basename(file)}`],
          });
        }
      }

      if (samples.length === 0) {
        console.log(skipped > 0 ? `Nothing was added; ${plural(skipped, 'file')} skipped.` : 'Nothing was added.');
        return failed > 0 ? 1 : 0;
      }
      if (dryRun) {
        console.log(`\nNothing saved — this was a dry run. Drop --dry-run to keep ${plural(samples.length, 'sample')}.`);
        return failed > 0 ? 1 : 0;
      }

      for (const sample of samples) store.saveSample(sample);
      if (store.loadConfig().git.autoCommit) {
        // Only the corpus, which is all this wrote. See `apply`.
        await commitFromTerminal(repo, `Add ${plural(samples.length, 'writing sample')} from ${plural(paths.length, 'file')}`, ['corpus']);
      }
      console.log(
        `\nAdded ${plural(samples.length, 'sample')}${skipped > 0 ? `; ${plural(skipped, 'file')} skipped` : ''}. ` +
          'Fix anything filed wrongly in Voice & AI, or with `rmm serve`.',
      );
      return failed > 0 ? 1 : 0;
    }

    /**
     * Bring a save down from wherever it is pushed.
     *
     * The same thing the chooser's Clone does, for a machine where opening a
     * browser first is the wrong order: this is the command you want on a new
     * laptop, before there is anything to open.
     */
    case 'clone': {
      /*
       * `--data` is every other command's way of naming a save, and this one
       * accepted it and ignored it: `rmm clone <repo> here --data there`
       * cloned into `here`, said so in one line, and `there` — the folder the
       * person had asked for — was never made. The folder is the second
       * argument; asked for twice, in two places, there is no saying which
       * one was meant, so neither is guessed at.
       */
      if (rest.some((a) => a === '--data' || a.startsWith('--data='))) {
        console.error(
          '`rmm clone` does not take --data: the folder to clone into is its second argument. ' +
            'Try `rmm clone <repository> <folder>`.',
        );
        return 1;
      }
      const [url, into] = positionals('clone', rest);
      if (!url || !into) {
        console.error('Usage: rmm clone <repository> <folder>');
        return 1;
      }
      const store = await cloneProject(url, into, cloneRepo);
      rememberProject(store.root);
      console.log(`Cloned into ${store.root}, and opened it. Run \`rmm serve\` to work on it.`);
      const switched = aiSwitchedOff(store.root);
      if (switched) {
        console.log(
          `${switched} AI is switched off until you turn it on again: look at the command in ` +
            `${path.join(store.root, 'config.yaml')}, then \`rmm config set ai.enabled true --data ${store.root}\`.`,
        );
      }
      return 0;
    }

    case 'log':
      return logCommand(rest);

    case 'serve': {
      const port = arg(rest, 'port');
      /*
       * `rmm serve --port abc` reached Node's own listen() validation and
       * printed "options.port should be >= 0 and < 65536. Received type number
       * (NaN)" — a sentence about a type, naming neither the flag the person
       * typed nor the value they typed into it.
       */
      if (port !== undefined && !/^\d+$/.test(port.trim())) {
        console.error(`--port takes a number, and "${port}" is not one. Try \`rmm serve --port 4600\`.`);
        return 1;
      }
      if (port !== undefined && Number(port) > 65535) {
        console.error(`--port ${port} is above the highest port there is (65535).`);
        return 1;
      }
      /*
       * The port before anything is written: on a port another server held,
       * the save was opened, upgraded and committed, and then the listen
       * failed with Node's raw EADDRINUSE. See `portFree`.
       */
      const wanted = port ? Number(port) : Number(process.env.PORT ?? 4600);
      if (wanted !== 0 && !(await portFree(wanted))) {
        console.error(portInUseMessage(wanted));
        return 1;
      }
      await repo.ensure();
      try {
        await startServer({ port: port ? Number(port) : undefined, dataDir });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
        console.error(portInUseMessage(wanted));
        return 1;
      }
      return new Promise<number>(() => {
        /* run until interrupted */
      });
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;

    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(USAGE);
      return 1;
  }
}

/** Every value a flag that may be given more than once was given: `--screenshot a.png --screenshot b.png`. */
function allArgs(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') break;
    if (token.startsWith(`--${name}=`)) out.push(token.slice(name.length + 3));
    else if (token === `--${name}` && argv[i + 1] !== undefined) out.push(argv[++i]!);
  }
  return out;
}

/** A screenshot file as the data URL an entry takes, by what its bytes are, not its name. */
function screenshotFile(file: string): string {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `--screenshot ${file}: ${code === 'ENOENT' ? 'there is nothing at that path' : code === 'EISDIR' ? 'that is a folder, not an image' : clean(err)}.`,
    );
  }
  const kind = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        ? 'webp'
        : null;
  if (!kind) throw new Error(`--screenshot ${file}: not a PNG, JPEG or WebP image.`);
  return `data:image/${kind};base64,${bytes.toString('base64')}`;
}

/**
 * The running server's buffer, when a server is running for this same error
 * log; nothing otherwise.
 *
 * The CLI keeps no buffer of its own — each command is over in a moment, and
 * what went wrong in it was printed in front of the person typing. What it
 * cannot see is the server's last few minutes, which is usually what the
 * entry is about. Asked at `--server`, or `RMM_SERVER`, or the port the
 * server starts on (`PORT`, else 4600), for two seconds; a server that
 * writes to another error log is not this one's to quote.
 */
async function serverBuffer(
  rest: string[],
  dir: string,
  minutes: number,
): Promise<{ url: string; events: LogEvent[]; build?: string } | { url: string; why: string }> {
  const url = (arg(rest, 'server') ?? process.env.RMM_SERVER ?? `http://127.0.0.1:${process.env.PORT || 4600}`).replace(/\/+$/, '');
  const same = (a: string, b: string) => {
    const real = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    return real(a) === real(b);
  };
  try {
    const res = await fetch(`${url}/api/error-log/recent?minutes=${minutes}`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return { url, why: `the server at ${url} did not give its logs (${res.status})` };
    const body = (await res.json()) as { dir?: string; events?: LogEvent[] };
    if (typeof body.dir !== 'string' || !same(body.dir, dir)) {
      return { url, why: `the server at ${url} keeps its error log in ${body.dir ?? 'another folder'}, not this one` };
    }
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })
      .then((r) => r.json() as Promise<{ build?: string }>)
      .catch(() => ({}) as { build?: string });
    return { url, events: Array.isArray(body.events) ? body.events : [], ...(health.build ? { build: health.build } : {}) };
  } catch {
    return { url, why: `no server is running at ${url}` };
  }
}

/**
 * `rmm log`: write an error-log entry, or look after the error log's
 * repository — its status, its remote, push and pull — the way `rmm save`
 * and `rmm pull` look after a save's. Works with no save at all.
 */
async function logCommand(rest: string[]): Promise<number> {
  const log = new ErrorLog();
  // What a pull says to do next is said for a terminal. See `Repo.inTerminal`.
  log.repo.inTerminal = true;
  const words = positionals('log', rest);
  const [first, ...more] = words;
  /*
   * "remote" and one word is the remote only when the word is an address:
   * `rmm log remote unreachable`, somebody logging that the remote could not
   * be reached, set the remote to "unreachable" and said nothing else — the
   * real remote gone, and the entry never written. Anything else is the
   * description, and is logged as one.
   */
  /*
   * `host:path`, scp's way of writing one. A host with no dot that is not
   * localhost is a word as often as a host — "unreachable:503", "HTTP:502",
   * "timeout:30s" were all set as the remote — so its path has to look like
   * one: a "/" in it, or ending ".git".
   */
  const scpStyle = (host: string, where: string) =>
    host.includes('.') || host.toLowerCase() === 'localhost' || where.includes('/') || /\.git$/i.test(where);
  const remoteAddress = (word: string) =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(word) || // https://…, ssh://…, file://…
    // git@github.com:me/log.git, me@myserver:/srv/log.git
    ((m) => Boolean(m && scpStyle(m[1]!, m[2]!)))(/^[^\s@/:]+@([^\s@/:]+):(\S+)$/.exec(word)) ||
    // github.com:me/log.git, and a host with no dot: myserver:repos/log.git,
    // localhost:/srv/log.git. Not C:log — one letter is a Windows drive.
    ((m) => Boolean(m && scpStyle(m[1]!, m[2]!)))(/^(?![A-Za-z]:)([\w.-]+):(\S+)$/.exec(word)) ||
    /^(?:[/.~]|[A-Za-z]:[\\/])/.test(word) || // a folder: /srv/log.git, ./log, ~/log, C:\log
    fs.existsSync(word);
  const sub =
    first === 'remote'
      ? more.length === 0 || (more.length === 1 && remoteAddress(more[0]!))
      : first !== undefined && ['push', 'pull', 'status'].includes(first) && more.length === 0;
  const remoteWords = first === 'remote' && !sub;

  if (sub && first === 'status') {
    const status = await log.status();
    console.log(`Error log: ${status.dir}${status.isRepo ? '' : ' (not made yet — it is, the first time something is logged)'}`);
    console.log(`  ${status.entries} ${status.entries === 1 ? 'entry' : 'entries'}`);
    if (status.remote) {
      const r = status.remote;
      console.log(
        `  remote: ${r.url}` +
          (r.tracked ? ` — ${r.ahead} commit${r.ahead === 1 ? '' : 's'} not pushed, ${r.behind} to pull as of the last push or pull` : ' — never pushed'),
      );
    } else console.log('  remote: none — `rmm log remote <url>` adds one');
    if (status.lastPush) console.log(`  last pushed: ${new Date(status.lastPush).toLocaleString()}`);
    for (const entry of await log.list(5)) {
      console.log(
        `  ${new Date(entry.at).toLocaleString()}  ${entry.source.padEnd(10)} ${entry.description}` +
          `${entry.screenshots ? ` [${plural(entry.screenshots, 'screenshot')}]` : ''}${entry.pushed ? '' : ' (not pushed)'}`,
      );
    }
    return 0;
  }
  if (sub && first === 'remote') {
    const remove = rest.includes('--remove');
    const url = more[0];
    if (url === undefined && !remove) {
      const status = await log.status();
      console.log(status.remote?.url ?? 'The error log has no remote. `rmm log remote <url>` adds one.');
      return 0;
    }
    const status = await log.setRemote(remove ? '' : url ?? '');
    console.log(status.remote?.url ? `The error log pushes to ${status.remote.url}.` : 'Remote removed. The error log is local only.');
    return 0;
  }
  if (sub && first === 'push') {
    const result = await log.push();
    (result.ok ? console.log : console.error)(result.output);
    return result.ok ? 0 : 1;
  }
  if (sub && first === 'pull') {
    const result = await log.pull();
    (result.ok ? console.log : console.error)(result.message);
    for (const file of result.conflict ?? []) console.error(`  conflict: ${file}`);
    return result.ok ? 0 : 1;
  }

  const description = words.join(' ').trim();
  if (remoteWords && more.length === 1) {
    console.error(`("${more[0]}" is not an address, so this is logged as a description. To set the remote, give its address: rmm log remote <url>.)`);
  }
  if (!description) {
    console.error('Usage: rmm log "what went wrong" [--minutes 10] [--screenshot <file>]…  (or: rmm log status | remote <url> | push | pull)');
    return 1;
  }
  const asked = arg(rest, 'minutes');
  if (asked !== undefined && !/^\d+$/.test(asked.trim())) {
    console.error(`--minutes takes a number of minutes, and "${asked}" is not one. Try --minutes 10.`);
    return 1;
  }
  const minutes = windowMinutes(asked);
  const screenshots = allArgs(rest, 'screenshot').map(screenshotFile);
  const server = await serverBuffer(rest, log.root, minutes);
  const result = await log.add({
    description,
    source: 'CLI',
    minutes,
    logs: 'events' in server ? [{ events: server.events }] : [],
    screenshots,
    versions: { appVersion: appVersion(), ...('build' in server ? { serverBuild: server.build } : {}) },
    save: isSaveFolder(dataDir) ? dataDir : null,
  });
  const where = path.join(log.root, result.entry.id);
  if (!result.committed) {
    console.warn(`Written to ${where}, but not committed: ${result.commitError ?? 'git had nothing to commit'}.`);
  } else {
    console.log(`Logged to ${where} (not pushed yet — \`rmm log push\` sends it).`);
  }
  console.log(
    'events' in server
      ? `  ${plural(result.entry.events, 'event')} from the last ${minutes} minute${minutes === 1 ? '' : 's'}, from the server at ${server.url}.`
      : `  No automatic logs: ${server.why}.`,
  );
  if (screenshots.length) console.log(`  ${plural(screenshots.length, 'screenshot')}.`);
  return result.committed ? 0 : 1;
}

/*
 * Seeded last: after the command has been looked at, and after its flags have.
 *
 * The command half of this was already here — see `WORKS_IN_A_STORE` — and the
 * flags were not. `--data` is read out of the raw argv before anything
 * validates it, so `rmm apply mine --data --company Acme --role SWE`, a
 * forgotten folder after `--data`, resolved the save to `./--company`, created
 * it, filled it with the bundled example and said "Started a new save at
 * ./--company". Only then did `main` reach the check that names the real
 * mistake and exit 1 — leaving a folder of somebody else's resumes in the
 * working directory of a person who had made a typo.
 *
 * `unknownFlag` is the same call `main` makes, on the same arguments. Running
 * it twice costs nothing; running it too late cost a folder.
 */
/*
 * Where a new save may be started: a folder somebody named, or the home
 * default on a first run. Not the save remembered from the app — see
 * `resolveStore` — which, gone missing, is a thing to say rather than refill.
 */
const SEEDS = new Set(['flag', 'env', 'home']);

/** The commands that make the folder a repository and commit all of it. */
const COMMITS_EVERYTHING = new Set(['serve', 'save', 'master']);

const isSaveFolder = (dir: string) =>
  fs.existsSync(path.join(dir, 'profile.yaml')) && fs.existsSync(path.join(dir, 'config.yaml'));

/**
 * Why this folder cannot be worked in, or null when it can.
 *
 * `rmm serve --data ~/Documents` — one folder too high — ran `git init` in
 * Documents and committed every file in it, tax returns and all, as
 * "Initialise resume store". A folder with things in it and no save among
 * them is somebody's folder, not a save; an empty one is still a save to
 * start.
 */
function notASave(command: string): string | null {
  if (isSaveFolder(dataDir)) return null;
  if (dataFrom === 'remembered') {
    return fs.existsSync(dataDir)
      ? `The save last opened, ${dataDir}, is not a save any more (it has no profile.yaml and config.yaml). ` +
          'Open another in the app, or name one with --data.'
      : `The save last opened, ${dataDir}, is not there any more. It may have been moved, deleted, or be on a ` +
          'drive that is not connected. Open another in the app, or name one with --data.';
  }
  if (COMMITS_EVERYTHING.has(command) && !isEmptyStore(dataDir)) {
    return `${dataDir} has files in it but is not a save (it has no profile.yaml and config.yaml), so it was left ` +
      'alone. Point --data at a save, or at an empty or new folder to start one.';
  }
  return null;
}

const ARGV = commandFirst(process.argv.slice(2));
{
  const command = ARGV[0] ?? '';
  const refused =
    ['help', '--help', '-h'].includes(command) || !COMMANDS.has(command) ? null : unknownFlag(command, ARGV.slice(1));
  const problem = refused || !WORKS_IN_A_STORE.has(command) ? null : notASave(command);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  if (!refused && WORKS_IN_A_STORE.has(command) && SEEDS.has(dataFrom) && seedStore(path.join(projectRoot, 'data'), dataDir)) {
    console.error(`Started a new save at ${dataDir}, from the bundled example — there was nothing there.`);
  }
}

main(ARGV)
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof OverflowError) {
      console.error(err.message);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  });
