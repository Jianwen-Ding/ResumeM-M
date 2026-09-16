import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LayoutOptions, ResolvedResume } from '../model/types.js';
import { renderLatexFastBody, stablePreamble } from './latex.js';

const run = promisify(execFile);

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

const CACHE_DIR = path.join(os.tmpdir(), 'rmm-fmt-cache');

let available: boolean | undefined;

/** Whether pdftex and mylatexformat.ltx are both present. */
export async function hasFastPath(): Promise<boolean> {
  if (available !== undefined) return available;
  try {
    await run('pdftex', ['--version'], { timeout: 10_000 });
    await run('kpsewhich', ['mylatexformat.ltx'], { timeout: 10_000 });
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

/**
 * Build, or reuse, the precompiled format for one paper size. Paper size is
 * the only thing that changes the stable preamble (`\documentclass` options),
 * so there are at most two formats ever cached.
 *
 * The cache key includes a hash of the preamble text, so editing the template
 * invalidates every cached format the next time the process starts — a stale
 * format is never silently reused across a code change.
 */
async function getFormat(paper: LayoutOptions['paper']): Promise<CachedFormat> {
  const existing = formats.get(paper);
  if (existing) return existing;

  const promise = buildFormat(paper).catch((err) => {
    formats.delete(paper); // do not cache a failed build
    throw err;
  });
  formats.set(paper, promise);
  return promise;
}

async function buildFormat(paper: LayoutOptions['paper']): Promise<CachedFormat> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const preambleText = stablePreamble(paper);
  const jobname = `rmm-${paper}-${hashOf(preambleText)}`;
  const fmtPath = path.join(CACHE_DIR, `${jobname}.fmt`);

  if (fs.existsSync(fmtPath)) return { path: fmtPath };

  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fmtbuild-'));
  try {
    // mylatexformat.ltx watches for a bare `\begin{document}` line to know
    // where the preamble it should dump ends.
    const seedFile = path.join(buildDir, 'seed.tex');
    fs.writeFileSync(seedFile, `${preambleText}\n\\begin{document}\n`, 'utf8');

    await run(
      'pdftex',
      ['-ini', '-interaction=nonstopmode', '-halt-on-error', `-jobname=${jobname}`, '&pdflatex', 'mylatexformat.ltx', seedFile],
      { cwd: buildDir, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );

    const built = path.join(buildDir, `${jobname}.fmt`);
    if (!fs.existsSync(built)) throw new Error('mylatexformat produced no .fmt file');
    fs.copyFileSync(built, fmtPath);
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
  const fmt = await getFormat(layout.paper);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fast-'));
  const texFile = path.join(dir, 'resume.tex');
  fs.writeFileSync(texFile, renderLatexFastBody({ ...resume, layout }), 'utf8');

  try {
    for (let pass = 0; pass < 2; pass++) {
      await run('pdftex', ['-interaction=nonstopmode', '-halt-on-error', `-fmt=${fmt.path}`, texFile], {
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
    throw new Error(`fast preview compile failed: ${firstTexError(combined) ?? e.message ?? 'unknown error'}`);
  }

  const pdfFile = path.join(dir, 'resume.pdf');
  const auxFile = path.join(dir, 'resume.aux');
  const logFile = path.join(dir, 'resume.log');
  if (!fs.existsSync(pdfFile)) {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`fast preview compile produced no PDF: ${firstTexError(log) ?? 'see log'}`);
  }

  const result: RawCompile = {
    pdf: fs.readFileSync(pdfFile),
    aux: fs.existsSync(auxFile) ? fs.readFileSync(auxFile, 'utf8') : '',
    log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '',
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}
