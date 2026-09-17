#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './ai/agent.js';
import { feedbackPrompt } from './ai/prompts.js';
import { Repo } from './git/repo.js';
import { saveStore } from './git/save.js';
import { ingestFile } from './ingest/index.js';
import { findProjectRoot, resolveStoreDir, seedStore } from './model/location.js';
import { buildBundle, slug, stats } from './model/applications.js';
import { buildMaster, resolveResume } from './model/resolve.js';
import { Store } from './model/store.js';
import { compileResume, OverflowError } from './render/compile.js';
import type { WritingSample } from './model/types.js';
import { startServer } from './server/index.js';

const projectRoot = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = resolveStoreDir(projectRoot);
seedStore(path.join(projectRoot, 'data'), dataDir);

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
  rmm serve [--port 4600]         Start the editor GUI and extension API

Environment:
  RMM_DATA           Where the store lives. Defaults to ~/.resumem-m/store,
                     seeded from the bundled example on first run. The store is
                     its own git repository, separate from this source tree.
  RMM_AUTOCOMMIT=0   Do not commit store changes.
  RMM_AI=0           Keep the AI off whatever config.yaml says.
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `-m "message"`, because every other tool that commits accepts it. */
function shortFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
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
        const from = r.extends ? ` (extends ${r.extends})` : '';
        const n = Object.keys(r.choices ?? {}).length;
        console.log(`  ${r.id.padEnd(20)} ${r.label}${from}  — ${n} choice${n === 1 ? '' : 's'}`);
      }
      return 0;
    }

    case 'build': {
      const data = store.load();
      const all = rest.includes('--all');
      const ids = all ? data.resumes.map((r) => r.id) : [rest[0]];
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
           * stops at the first problem. One resume with a dangling `extends`
           * threw out here and killed the run: the rest were never built and
           * never mentioned, and the exit code said only that something failed.
           */
          const resolved = resolveResume(id, data);
          for (const w of resolved.warnings) console.warn(`  ! ${w}`);
          const out = path.join(store.outDir(), `${id}.pdf`);
          const result = await compileResume(resolved, {
            pdfPath: out,
            texPath: out.replace(/\.pdf$/, '.tex'),
            strict: true,
            engine: data.config.latex.engine,
          });
          console.log(`${id.padEnd(20)} ${fmtFit(result)}  → ${path.relative(process.cwd(), out)}`);
        } catch (err) {
          failed = true;
          console.error(`${id.padEnd(20)} ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return failed ? 1 : 0;
    }

    case 'check': {
      const id = rest[0];
      if (!id) {
        console.error('Which resume?');
        return 1;
      }
      const data = store.load();
      const resolved = resolveResume(id, data);
      for (const w of resolved.warnings) console.warn(`  ! ${w}`);
      const result = await compileResume(resolved, { engine: data.config.latex.engine });
      console.log(`${id}: ${fmtFit(result)}`);
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
      const id = rest[0];
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
      const id = rest[0];
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
      const [sub, ...files] = rest;
      if (sub !== 'add') {
        console.error('Usage: rmm voice add <file…> [--dry-run] [--no-ai]');
        return 1;
      }

      const paths = files.filter((f) => !f.startsWith('-'));
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
          found = await ingestFile(config, path.basename(file), fs.readFileSync(file), { useAi });
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

    case 'serve': {
      await repo.ensure();
      const port = arg(rest, 'port');
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
