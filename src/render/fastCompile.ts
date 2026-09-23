import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LayoutOptions, ResolvedResume } from '../model/types.js';
import { renderLatexFastBody, runtimeSetup, stablePreamble } from './latex.js';

const run = promisify(execFile);

/**
 * How much longer a process gets after its own `timeout` before it is killed
 * outright, rather than waited on for ever.
 *
 * `execFile`'s `timeout` option sends `killSignal` — SIGTERM by default —
 * once, when the timer fires, and then waits for the child's `exit` like any
 * other call. It never escalates. `ai/agent.ts` found this against a
 * coding-agent CLI that trapped SIGTERM: measured, twelve seconds past a
 * two-second timeout, promise still unsettled, process still alive — and this
 * is the path a live preview takes on every keystroke, so a `pdftex` gone
 * stubborn in this way would jam the preview rather than merely slow it down.
 *
 * So: the polite signal at `timeout`, and the one it cannot refuse
 * `STUBBORN_GRACE_MS` after that. `unref` so the timer itself is never the
 * thing keeping the process alive.
 */
const STUBBORN_GRACE_MS = 5_000;

/** Test-only: how long `runTimedForTest` waits past its own `timeout` before forcing the kill. */
export const RUN_TIMED_TEST_GRACE_MS = STUBBORN_GRACE_MS;

async function runTimed(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const pending = run(cmd, args, opts);
  const forceKill = setTimeout(() => {
    try {
      pending.child.kill('SIGKILL');
    } catch {
      // Already gone, which is the outcome this wanted.
    }
  }, opts.timeout + STUBBORN_GRACE_MS);
  forceKill.unref?.();
  try {
    return await pending;
  } finally {
    clearTimeout(forceKill);
  }
}

/**
 * Test-only: exercise `runTimed` directly, with whatever `timeout` the test
 * wants, rather than through a real preview compile — which is where the
 * escalation actually runs, at timeouts too long for a test to wait out.
 */
export function runTimedForTest(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return runTimed(cmd, args, opts);
}

/**
 * The live-preview path: a precompiled LaTeX format.
 *
 * `pdftex` can dump everything a preamble loaded — the document class,
 * titlesec, enumitem, fancyhdr, tabularx, hyperref, scrextend, zref — into a
 * single `.fmt` file and reload it in one step, skipping the package-loading
 * work that dominates a cold compile. `mylatexformat` (CTAN, LPPL-licensed,
 * bundled with every TeX Live install) is the third-party tool that does the
 * dumping; this module just drives it.
 *
 * Measured on this machine: a from-scratch `pdflatex` run of the resume
 * template takes ~340ms; the same document through a preloaded format takes
 * ~135ms — about 2.5x, and the gap widens with `enumitem`/`hyperref`-heavy
 * templates. That is what makes the editor's live preview feel live.
 *
 * This path is explicitly for preview only. `compile.ts` only reaches for it
 * when a caller opts in with `mode: 'preview'`; anything that produces a file
 * meant to leave the machine — `rmm build`, an application bundle — compiles
 * with the full, unmodified engine every time. A cached format is one more
 * thing that could theoretically drift from a from-scratch compile, and none
 * of that risk belongs anywhere near the PDF that gets attached to an
 * application.
 */

/**
 * Where the dumped formats live. One is about 7MB, and there is one per
 * distinct layout, so this is worth being able to move: `RMM_FMT_CACHE` puts
 * it somewhere with room, or somewhere that survives a reboot, or — for a test
 * that wants to watch a cold build without racing every other process on the
 * machine for the same files — somewhere of its own.
 *
 * Read on each call rather than captured at import, so setting the variable
 * after this module is loaded still works.
 */
function cacheDir(): string {
  return process.env.RMM_FMT_CACHE || path.join(os.tmpdir(), 'rmm-fmt-cache');
}

let available: boolean | undefined;

/** Whether pdftex and mylatexformat.ltx are both present. */
export async function hasFastPath(): Promise<boolean> {
  if (available !== undefined) return available;
  try {
    await runTimed('pdftex', ['--version'], { timeout: 10_000 });
    await runTimed('kpsewhich', ['mylatexformat.ltx'], { timeout: 10_000 });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/** Test-only: forget the cached availability check. */
export function resetFastPathCache(): void {
  available = undefined;
  formats.clear();
}

interface CachedFormat {
  path: string;
}

const formats = new Map<string, Promise<CachedFormat>>();

function hashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/*
 * The dumped preamble carries the layout.
 *
 * A document run against a format built by `mylatexformat` does not execute
 * its own preamble: the format exists precisely so that work is already done,
 * and everything in the file before `\begin{document}` is skipped. So the
 * layout — font size, `\rmmunit`, margins, text width, text height — was being
 * written out and then thrown away, and the preview was typeset at the article
 * class defaults: 650pt of text height where 730pt had been asked for, 13.6pt
 * of leading where 12.6pt had.
 *
 * That is not a cosmetic gap. The preview measured a different page from the
 * one the user was about to send, in both directions — a two-page resume came
 * back "fits on one page", and a comfortable one came back "about 7 lines too
 * long" listing shrinking steps that had never been applied to anything.
 *
 * Nor can it be fixed from inside the document: `\textheight` and `\topmargin`
 * only take effect from the next page, and the page has already begun. So the
 * layout goes into the format, and the key grows a hash of it. Preview only
 * ever asks for the as-authored layout (compile.ts declines the shortcut for
 * the fit loop's shrinking attempts), so this stays one format per paper size
 * in practice rather than one per attempt.
 */
async function getFormat(paper: LayoutOptions['paper'], layout: LayoutOptions): Promise<CachedFormat> {
  const preambleText = `${stablePreamble(paper)}\n${runtimeSetup(layout)}`;
  const key = hashOf(preambleText);
  const existing = formats.get(key);
  if (existing) return existing;

  const promise = buildFormat(paper, preambleText, key).catch((err) => {
    formats.delete(key); // do not cache a failed build
    throw err;
  });
  formats.set(key, promise);
  return promise;
}

async function buildFormat(
  paper: LayoutOptions['paper'],
  preambleText: string,
  key: string,
): Promise<CachedFormat> {
  const into = cacheDir();
  fs.mkdirSync(into, { recursive: true });

  const jobname = `rmm-${paper}-${key}`;
  const fmtPath = path.join(into, `${jobname}.fmt`);

  if (fs.existsSync(fmtPath)) return { path: fmtPath };

  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fmtbuild-'));
  try {
    // mylatexformat.ltx watches for a bare `\begin{document}` line to know
    // where the preamble it should dump ends.
    const seedFile = path.join(buildDir, 'seed.tex');
    fs.writeFileSync(seedFile, `${preambleText}\n\\begin{document}\n`, 'utf8');

    await runTimed(
      'pdftex',
      ['-ini', '-interaction=nonstopmode', '-halt-on-error', `-jobname=${jobname}`, '&pdflatex', 'mylatexformat.ltx', seedFile],
      { cwd: buildDir, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );

    const built = path.join(buildDir, `${jobname}.fmt`);
    if (!fs.existsSync(built)) throw new Error('mylatexformat produced no .fmt file');

    /*
     * Published by rename, never by writing onto the path others read.
     *
     * This copied seven megabytes straight to `fmtPath`, and that path is
     * shared by every process on the machine — the server, the CLI, the MCP
     * binary, each test worker. A reader arriving part-way through the copy
     * gets a truncated format and pdftex refuses it. Measured, eight processes
     * doing a cold first compile together: seven failed, all on the same
     * half-written file.
     *
     * A rename within one directory is atomic, so a reader sees either no file
     * or the whole of one. Two builders racing is then harmless: each writes
     * its own temporary and the second rename replaces the first, and both are
     * complete. The temporary has to live in the same directory as the target
     * or the rename becomes a copy across filesystems and stops being atomic.
     */
    const staged = `${fmtPath}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      fs.copyFileSync(built, staged);
      fs.renameSync(staged, fmtPath);
    } catch (err) {
      fs.rmSync(staged, { force: true });
      throw err;
    }
    return { path: fmtPath };
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

export interface RawCompile {
  pdf: Buffer;
  aux: string;
  log: string;
}

function firstTexError(log: string): string | undefined {
  return /^!\s*(.+)$/m.exec(log)?.[1]?.trim();
}

/**
 * Compile through the precompiled format. Two passes, same as a cold
 * `pdflatex` run: the zref labels this system reads for its fit check are
 * only available to the .aux on the run after the one that recorded them.
 */
export async function compileFast(resume: ResolvedResume, layout: LayoutOptions): Promise<RawCompile> {
  return compileFastBody(renderLatexFastBody({ ...resume, layout }), layout.paper, layout);
}

/**
 * The same path for any document body written against the stable preamble —
 * a resume or a cover letter. Both are set from the same template, so both
 * load the same precompiled format.
 */
export async function compileFastBody(
  body: string,
  paper: LayoutOptions['paper'],
  layout: LayoutOptions,
): Promise<RawCompile> {
  const fmt = await getFormat(paper, layout);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fast-'));
  const texFile = path.join(dir, 'resume.tex');

  /*
   * `\endofdump` first, so a body's own preamble is executed rather than eaten.
   *
   * A document run against a `mylatexformat` format does not simply begin: the
   * format scans the file line by line and throws away everything before
   * `\begin{document}` or `\endofdump`, because that is how it skips the
   * preamble it has already compiled. `\endofdump` tells it to stop skipping
   * and start executing here.
   *
   * Today both fast bodies open on `\begin{document}` and the layout travels
   * in the format, so there is nothing above that line for the format to throw
   * away. This is the guard for the day that stops being true. When it was not
   * true — when the bodies still carried `runtimeSetup` — the cost was not
   * cosmetic: every setting was dropped, the preview was typeset at the
   * article class defaults, and the fit badge reported on a page nobody was
   * looking at. A resume that really ran to two pages came back `fits: true,
   * "room for about 1 more line"`, and one that fitted with 240pt to spare
   * came back "about 7 lines too long" with a list of shrinking steps that had
   * never been applied to anything. Fitting on one page is the whole promise
   * of the tool, so a setting that vanishes without a word is the worst shape
   * a bug here can take.
   *
   * The backslash is doubled because it is not one in a template literal:
   * JavaScript drops the backslash from an escape it does not recognise, and
   * `\e` is not one, so the single-backslash version of this line wrote the
   * bare word `endofdump` and the guard was never armed.
   */
  fs.writeFileSync(texFile, `\\endofdump
${body}`, 'utf8');

  try {
    for (let pass = 0; pass < 2; pass++) {
      await runTimed('pdftex', ['-interaction=nonstopmode', '-halt-on-error', `-fmt=${fmt.path}`, texFile], {
        cwd: dir,
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const logFile = path.join(dir, 'resume.log');
    const fileLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const combined = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${fileLog}`;
    fs.rmSync(dir, { recursive: true, force: true });

    /*
     * A format that will not load is thrown away rather than kept for ever.
     *
     * The cache is only ever checked for existing, so a bad file there is
     * permanent: every later run short-circuits to it, fails, and falls back
     * to the trusted engine — silently, because the caller catches this. The
     * preview would simply stop being fast on that machine, with nothing said
     * and nothing to do about it short of knowing which temp directory to
     * empty.
     *
     * Only for a failure about loading the format itself. A document that will
     * not compile is the ordinary case, says nothing about the preamble, and
     * throwing the format away over a stray brace in a bullet would turn one
     * bad document into a rebuild on every keystroke.
     *
     * The three phrases are the ones pdftex actually produces, and it does not
     * use one message for this. A file of the wrong shape entirely gives
     * "(Fatal format file error; I'm stymied)"; one that is merely cut short —
     * which is what the copy race left behind, and the likelier case by far —
     * gives "pdftex: fatal: Could not undump 36532 4-byte item(s) from …".
     * Matching on the first wording alone left the second unhandled, which is
     * to say left the real one unhandled.
     *
     * Deliberately not "does the message mention the format's filename": the
     * banner names it on every run, successful ones included.
     */
    if (/undump|format file|stymied/i.test(combined)) {
      fs.rmSync(fmt.path, { force: true });
    }

    throw new Error(`fast preview compile failed: ${firstTexError(combined) ?? e.message ?? 'unknown error'}`);
  }

  const pdfFile = path.join(dir, 'resume.pdf');
  const auxFile = path.join(dir, 'resume.aux');
  const logFile = path.join(dir, 'resume.log');
  // Existing is not the same as usable. A document with nothing in it —
  // `\begin{document}` straight to `\end{document}` — makes pdftex report "No
  // pages of output" and *succeed*, leaving a zero-byte resume.pdf behind. An
  // existsSync on its own waves that through, and a caller that trusts it
  // hands the preview an empty buffer: a blank viewer with no error to
  // explain it. Neither renderer can currently produce a body that empty, so
  // this is a guard rather than a fix, and it belongs here because the
  // failure it prevents is silent.
  if (!fs.existsSync(pdfFile) || fs.statSync(pdfFile).size === 0) {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`fast preview compile produced no PDF: ${firstTexError(log) ?? 'no pages of output'}`);
  }

  const result: RawCompile = {
    pdf: fs.readFileSync(pdfFile),
    aux: fs.existsSync(auxFile) ? fs.readFileSync(auxFile, 'utf8') : '',
    log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '',
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}
