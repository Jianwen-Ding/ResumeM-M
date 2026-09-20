#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './ai/agent.js';
import { feedbackPrompt } from './ai/prompts.js';
import { Repo, cloneRepo } from './git/repo.js';
import { saveStore } from './git/save.js';
import { ingestFile } from './ingest/index.js';
import { findProjectRoot, resolveStoreDir, seedStore } from './model/location.js';
import { buildBundle, slug, stats } from './model/applications.js';
import { buildMaster, resolveResume } from './model/resolve.js';
import { Store } from './model/store.js';
import { cloneProject, rememberProject } from './model/projects.js';
import { compileResume, OverflowError } from './render/compile.js';
import type { WritingSample } from './model/types.js';
import { startServer } from './server/index.js';

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
const dataDir = resolveStoreDir(projectRoot, arg(process.argv.slice(2), 'data'));
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
  'voice',
  'serve',
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

if (WORKS_IN_A_STORE.has(process.argv[2] ?? '') && seedStore(path.join(projectRoot, 'data'), dataDir)) {
  console.error(`Started a new save at ${dataDir}, from the bundled example — there was nothing there.`);
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
  rmm save [-m "why"] [--push]    Commit everything in the store to git
  rmm clone <repo> <folder>       Bring a save down from where it is pushed,
                                  and open it
  rmm serve [--port 4600]         Start the editor GUI and extension API

Any command also takes:
  --data <folder>    Work on the save in this folder instead of the one that is
                     open. Beats RMM_DATA and the remembered save.

Environment:
  RMM_DATA           Where the store lives. Defaults to ~/.resumem-m/store,
                     seeded from the bundled example on first run. The store is
                     its own git repository, separate from this source tree.
  RMM_AUTOCOMMIT=0   Do not commit store changes.
  RMM_AI=0           Keep the AI off whatever config.yaml says.
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
  save: { value: ['message', 'm'], bare: ['push'] },
  voice: { bare: ['dry-run', 'no-ai'] },
  serve: { value: ['port'] },
};

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
  const stolenFlag = (next: string | undefined): boolean => {
    if (!next?.startsWith('--') || next === '--') return false;
    const n = next.slice(2).split('=')[0] ?? '';
    return value.has(n) || bare.has(n);
  };
  const noValue = (flag: string, next: string): string => {
    const spelled = flag === '-m' ? '--message' : flag;
    return (
      `${flag} was given ${next} as its value, but ${next} is another flag \`rmm ${command}\` takes — ` +
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
      if (stolenFlag(rest[i + 1])) return noValue('-m', rest[i + 1]!);
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
      if (stolenFlag(rest[i + 1])) return noValue(token, rest[i + 1]!);
      i++; // its value is not a flag
      continue;
    }
    if (bare.has(name)) continue;

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

function fmtFit(r: { pages: number; fits: boolean; overflowPt: number; overflowLines: number; adjustments: string[] }): string {
  if (!r.fits) {
    return `✗ ${r.pages} pages — over by ${r.overflowPt.toFixed(0)}pt (~${r.overflowLines} lines)`;
  }
  const slack = Math.abs(r.overflowLines);
  const room = r.overflowPt < 0 ? `, ~${slack} line${slack === 1 ? '' : 's'} of room left` : '';
  const adj = r.adjustments.length > 0 ? ` [auto-fit: ${r.adjustments.join('; ')}]` : '';
  return `✓ 1 page${room}${adj}`;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  const wrong = command && !['help', '--help', '-h'].includes(command) ? unknownFlag(command, rest) : null;
  if (wrong) {
    console.error(wrong);
    return 1;
  }

  const store = new Store(dataDir);
  const repo = Repo.forStore(dataDir);

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
        console.log('AI is disabled (ai.enabled: false in data/config.yaml).');
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
        // `commitAll` returns undefined when the store is not a repo yet, so a
        // CLI-only user with auto-commit on got no history at all and nothing
        // said so. `voice add` and `serve` already do this.
        await repo.ensure();
        await repo.commitAll(`Apply: ${company} — ${role}`);
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
      return 0;
    }

    case 'track': {
      const apps = store.load().applications;
      const s = stats(apps);
      console.log(`${s.total} applications — ${s.last7} in the last 7 days, ${s.last30} in the last 30`);
      console.log(`Response rate (OA or beyond): ${s.responseRate}%\n`);
      for (const a of [...apps].sort((x, y) => (y.appliedAt ?? '').localeCompare(x.appliedAt ?? ''))) {
        const when = a.appliedAt?.slice(0, 10) ?? '          ';
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

      for (const file of paths) {
        let found;
        try {
          found = await ingestFile(config, path.basename(file), readForVoice(file), { useAi });
        } catch (err) {
          console.error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
          failed++;
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
        console.log('Nothing was added.');
        return failed > 0 ? 1 : 0;
      }
      if (dryRun) {
        console.log(`\nNothing saved — this was a dry run. Drop --dry-run to keep ${plural(samples.length, 'sample')}.`);
        return failed > 0 ? 1 : 0;
      }

      for (const sample of samples) store.saveSample(sample);
      if (store.loadConfig().git.autoCommit) {
        await repo.ensure();
        await repo.commitAll(`Add ${plural(samples.length, 'writing sample')} from ${plural(paths.length, 'file')}`);
      }
      console.log(`\nAdded ${plural(samples.length, 'sample')}. Fix anything filed wrongly in Voice & AI, or with \`rmm serve\`.`);
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
      const [url, into] = positionals('clone', rest);
      if (!url || !into) {
        console.error('Usage: rmm clone <repository> <folder>');
        return 1;
      }
      const store = await cloneProject(url, into, cloneRepo);
      rememberProject(store.root);
      console.log(`Cloned into ${store.root}, and opened it. Run \`rmm serve\` to work on it.`);
      return 0;
    }

    case 'serve': {
      await repo.ensure();
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
      await startServer({ port: port ? Number(port) : undefined, dataDir });
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

main(process.argv.slice(2))
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
