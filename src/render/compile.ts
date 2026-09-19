import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LayoutOptions, ResolvedResume } from '../model/types.js';
import { compileFast, compileFastBody, hasFastPath } from './fastCompile.js';
import { renderLatex, unrenderableReason } from './latex.js';
import { renderLetterFastBody, renderLetterLatex, type LetterContent } from './letter.js';

const run = promisify(execFile);

const SP_PER_PT = 65536;
const PT_PER_IN = 72;

export type Engine = 'tectonic' | 'latexmk' | 'pdflatex';

/** Engines in preference order: self-contained first, system TeX after. */
const ENGINE_ORDER: Engine[] = ['tectonic', 'latexmk', 'pdflatex'];

export interface FitReport {
  fits: boolean;
  pages: number;
  /** Vertical space the content actually consumed, in points. */
  usedPt: number;
  /** Space available across `maxPages` pages, in points. */
  availablePt: number;
  /** Positive when over, negative when there is room to spare. */
  overflowPt: number;
  /** Overflow expressed in lines of body text — the number you can act on. */
  overflowLines: number;
  /** Layout actually used, after any auto-fit shrinking. */
  layout: LayoutOptions;
  /** What auto-fit had to do. Empty when the resume fit as authored. */
  adjustments: string[];
}

export interface CompileResult extends FitReport {
  pdfPath?: string;
  texPath?: string;
  tex: string;
  engine: Engine;
  warnings: string[];
  /** Tail of the LaTeX log, kept for when a compile fails. */
  log?: string;
  /** True when the precompiled-format preview path produced this PDF. */
  fastPath: boolean;
}

let resolvedEngine: Engine | undefined;

/** Find an installed LaTeX engine once per process. */
export async function detectEngine(preferred?: Engine): Promise<Engine> {
  if (preferred) {
    if (await hasBinary(preferred)) return preferred;
    /*
     * Both ways out, nearest first. This named config.yaml and nothing else,
     * which sends someone to a text file to change a setting that has a
     * dropdown in Voice & AI — and which they most likely set from that
     * dropdown in the first place.
     */
    throw new Error(
      `LaTeX engine "${preferred}" is configured but not installed. ` +
        `Change it under Voice & AI → LaTeX engine (Auto-detect works if any of ` +
        `${ENGINE_ORDER.join(', ')} is installed), or install "${preferred}".`,
    );
  }
  if (resolvedEngine) return resolvedEngine;
  for (const e of ENGINE_ORDER) {
    if (await hasBinary(e)) {
      resolvedEngine = e;
      return e;
    }
  }
  /*
   * Nothing installed at all, so there is no setting that helps: this one is
   * genuinely a thing to go and install, and says which is least trouble.
   */
  throw new Error(
    'No LaTeX engine found, so nothing can be typeset. Install tectonic — one binary, ' +
      'fetches what it needs — or a TeX distribution providing latexmk or pdflatex.',
  );
}

async function hasBinary(name: string): Promise<boolean> {
  try {
    await run(name, ['--version'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function argsFor(engine: Engine, texFile: string, outDir: string): string[] {
  switch (engine) {
    case 'tectonic':
      // Tectonic resolves packages itself and reruns until labels settle.
      return ['--keep-intermediates', '--synctex=0', '--outdir', outDir, texFile];
    case 'latexmk':
      return ['-pdf', '-interaction=nonstopmode', '-halt-on-error', `-outdir=${outDir}`, texFile];
    case 'pdflatex':
      return ['-interaction=nonstopmode', '-halt-on-error', `-output-directory=${outDir}`, texFile];
  }
}

export class LatexError extends Error {
  readonly log: string;
  constructor(message: string, log: string) {
    super(message);
    this.name = 'LatexError';
    this.log = log;
  }
}

interface RawCompile {
  pdf: Buffer;
  aux: string;
  log: string;
}

/** Compile one .tex to a PDF in a scratch directory, returning the artifacts. */
async function compileOnce(tex: string, engine: Engine): Promise<RawCompile> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-'));
  const texFile = path.join(dir, 'resume.tex');
  fs.writeFileSync(texFile, tex, 'utf8');

  // pdflatex needs a second pass for zref labels to reach the .aux; latexmk and
  // tectonic already rerun on their own.
  const passes = engine === 'pdflatex' ? 2 : 1;
  let log = '';
  try {
    for (let i = 0; i < passes; i++) {
      const { stdout, stderr } = await run(engine, argsFor(engine, texFile, dir), {
        cwd: dir,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      log = `${stdout}\n${stderr}`;
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const logFile = path.join(dir, 'resume.log');
    const fileLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const combined = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${fileLog}`;
    fs.rmSync(dir, { recursive: true, force: true });
    throw new LatexError(`${engine} failed: ${firstTexError(combined) ?? e.message ?? 'unknown error'}`, tail(combined));
  }

  const pdfFile = path.join(dir, 'resume.pdf');
  // Zero bytes counts as no PDF. A document with nothing in it makes the
  // engine report "No pages of output" and exit cleanly, leaving an empty
  // file; waving that through hands the caller a buffer it will write out and
  // attach to an application. See the same guard in fastCompile.ts.
  if (!fs.existsSync(pdfFile) || fs.statSync(pdfFile).size === 0) {
    const logFile = path.join(dir, 'resume.log');
    const fileLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : log;
    fs.rmSync(dir, { recursive: true, force: true });
    throw new LatexError(`${engine} produced no PDF: ${firstTexError(fileLog) ?? 'no pages of output'}`, tail(fileLog));
  }

  const auxFile = path.join(dir, 'resume.aux');
  const result: RawCompile = {
    pdf: fs.readFileSync(pdfFile),
    aux: fs.existsSync(auxFile) ? fs.readFileSync(auxFile, 'utf8') : '',
    log: fs.existsSync(path.join(dir, 'resume.log'))
      ? fs.readFileSync(path.join(dir, 'resume.log'), 'utf8')
      : log,
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

/**
 * Refuse a document whose characters the engine cannot set, with a message that
 * names them. Thrown as a LatexError because that is what every caller already
 * knows how to show — the log body carries the same text, so a UI that renders
 * the log instead of the message still says something useful.
 */
function assertRenderable(tex: string): void {
  const reason = unrenderableReason(tex);
  if (reason) throw new LatexError(reason, reason);
}

function firstTexError(log: string): string | undefined {
  const m = /^!\s*(.+)$/m.exec(log);
  return m?.[1]?.trim();
}

function tail(s: string, lines = 60): string {
  return s.split('\n').slice(-lines).join('\n');
}

interface Measurement {
  pages: number;
  usedPt: number;
}

/**
 * Turn the .aux artifacts into a height. `zref` records positions in scaled
 * points measured up from the page bottom, and `zref-abspage` tags each with
 * its page, so the content height is the span on page one plus a full text
 * block for every page after it.
 */
function measure(aux: string, layout: LayoutOptions, pagesFallback: number): Measurement {
  const pages = readPageCount(aux) ?? pagesFallback;
  const start = readPos(aux, 'rmmstart');
  const end = readPos(aux, 'rmmend');
  const textHeightPt = textHeightIn(layout) * PT_PER_IN;

  if (!start || !end) {
    // No positions (an engine that skipped the label pass): fall back to
    // whole pages, which still enforces the limit, just less precisely.
    return { pages, usedPt: pages * textHeightPt };
  }

  // Both positions are page-local, measured up from their own page's bottom
  // edge, and the text area starts at the same height on every page. So the
  // drop from the first line to the last is (start.y - end.y) within a page,
  // plus a full text block for each page boundary crossed.
  const extraPages = Math.max(0, end.page - start.page);
  const dropPt = (start.y - end.y) / SP_PER_PT;
  return { pages, usedPt: extraPages * textHeightPt + dropPt };
}

function readPageCount(aux: string): number | undefined {
  const m = /\\@abspage@last\s*\{(\d+)\}/.exec(aux);
  return m ? Number(m[1]) : undefined;
}

/**
 * Read one saved position out of the .aux. The label body is a run of
 * `\prop{value}` groups on a single line, e.g.
 * `\zref@newlabel{rmmend}{\posx{4736286}\posy{43545241}\abspage{2}}`.
 */
function readPos(aux: string, name: string): { x: number; y: number; page: number } | undefined {
  const idx = aux.indexOf(`\\zref@newlabel{${name}}`);
  if (idx < 0) return undefined;
  const nl = aux.indexOf('\n', idx);
  const body = nl === -1 ? aux.slice(idx) : aux.slice(idx, nl);

  const x = /\\posx\{(-?\d+)\}/.exec(body);
  const y = /\\posy\{(-?\d+)\}/.exec(body);
  const p = /\\abspage\{(\d+)\}/.exec(body);
  if (!x || !y) return undefined;
  return { x: Number(x[1]), y: Number(y[1]), page: p ? Number(p[1]) : 1 };
}

function textHeightIn(layout: LayoutOptions): number {
  return (layout.paper === 'a4' ? 11.69 : 11) - layout.marginIn * 2;
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function describe(base: LayoutOptions, used: LayoutOptions): string[] {
  const out: string[] = [];
  if (used.fontSizePt !== base.fontSizePt) out.push(`font ${base.fontSizePt}pt → ${used.fontSizePt}pt`);
  if (used.spacing !== base.spacing) out.push(`spacing ×${base.spacing} → ×${used.spacing}`);
  if (used.marginIn !== base.marginIn) out.push(`margins ${base.marginIn}in → ${used.marginIn}in`);
  return out;
}

/**
 * Layouts form a one-dimensional family: `t` runs from 0 (exactly what the
 * author asked for) to 1 (every knob at its floor). Typeset height decreases
 * monotonically in `t`, which is what makes a binary search valid — and what
 * lets a hopeless resume be rejected in two compiles instead of fourteen.
 */
function layoutAt(base: LayoutOptions, t: number): LayoutOptions {
  const { minFontSizePt, minSpacing, minMarginIn } = base.fitBounds;
  const lerp = (from: number, to: number) => from + (to - from) * t;
  return {
    ...base,
    fontSizePt: round(lerp(base.fontSizePt, Math.min(minFontSizePt, base.fontSizePt)), 2),
    spacing: round(lerp(base.spacing, Math.min(minSpacing, base.spacing)), 3),
    marginIn: round(lerp(base.marginIn, Math.min(minMarginIn, base.marginIn)), 3),
  };
}

export interface CompileOptions {
  pdfPath?: string;
  texPath?: string;
  /** Throw when the resume still exceeds `layout.maxPages` after auto-fit. */
  strict?: boolean;
  engine?: Engine;
  /** Cap on recompiles while auto-fitting. Each is roughly half a second. */
  maxAttempts?: number;
  /**
   * 'final' (the default) always compiles with the detected, unmodified
   * engine — tectonic, then latexmk, then pdflatex — the trusted path for
   * anything that leaves the machine: `rmm build`, an application bundle.
   *
   * 'preview' uses a precompiled-format fast path when one is available
   * (see fastCompile.ts), for the editor's live preview and the extension's
   * "build resume" step, and falls back to the trusted engine automatically
   * if the fast path is missing or fails on a particular document.
   */
  mode?: 'preview' | 'final';
}

export class OverflowError extends Error {
  readonly report: FitReport;
  constructor(resume: ResolvedResume, report: FitReport) {
    const lines = report.overflowLines;
    const plural = lines === 1 ? '' : 's';
    const where = resume.layout.autoFit
      ? 'even at the tightest allowed layout'
      : 'at the layout as written (auto-fit is off)';
    super(
      `"${resume.label}" does not fit in ${resume.layout.maxPages} page(s): ` +
        `compiled to ${report.pages} page(s), over by ${report.overflowPt.toFixed(0)}pt ` +
        `(~${lines} line${plural}) ${where} ` +
        `(font ${report.layout.fontSizePt}pt, spacing ×${report.layout.spacing}, margins ${report.layout.marginIn}in). ` +
        `Cut about ${lines} line${plural} of content, or pick a shorter bullet variant.`,
    );
    this.name = 'OverflowError';
    this.report = report;
  }
}

/**
 * Compile a resolved resume, shrinking within the configured bounds until it
 * fits on the allowed number of pages.
 */
export async function compileResume(resume: ResolvedResume, opts: CompileOptions = {}): Promise<CompileResult> {
  const engine = await detectEngine(opts.engine);
  const base = resume.layout;
  const maxAttempts = opts.maxAttempts ?? 8;

  /*
   * A document with no name at the top is not a document this can typeset.
   *
   * The heading ends with a `\\`, and with nothing in front of it TeX says
   * "There's no line here to end." — which reached the user exactly like
   * that, from `rmm build`, `rmm check`, `rmm master` and the editor's live
   * preview, naming neither the field nor anything to do about it. A
   * `profile.yaml` that is simply missing its `name:` key is enough; the
   * placeholder default only covers a missing or empty *file*.
   *
   * The sentence already existed — `unsendableReason` — and was wired only
   * into the bundle builder, which is the last of the five places somebody
   * meets this and the only one that had it.
   *
   * Only the empty case. `unsendableReason` also refuses the placeholder name
   * a new save carries, and that is a rule about sending rather than about
   * typesetting: a new save must still be able to draw its own preview.
   */
  if (!String(resume.profile?.name ?? '').trim()) {
    const reason =
      'This save has no name in it, so the document would have nothing at the top of it. ' +
      'Put your name in under Master — profile.yaml may be missing its `name:`.';
    throw new LatexError(reason, reason);
  }

  // Before the fit loop, not inside it: a character the engine cannot set fails
  // identically on all eight attempts, and the answer is never to shrink.
  assertRenderable(renderLatex(resume));

  // The fast path is only ever a preview convenience. If it is unavailable, or
  // errors on this particular document, every attempt silently falls back to
  // the trusted engine — a resume must always compile correctly, with or
  // without the shortcut.
  const wantFast = opts.mode === 'preview' && (await hasFastPath());
  let usedFast = false;

  type Attempt = { layout: LayoutOptions; raw: RawCompile; m: Measurement; tex: string };
  let attemptsLeft = maxAttempts;

  const attempt = async (t: number): Promise<Attempt> => {
    attemptsLeft--;
    const layout = t === 0 ? base : layoutAt(base, t);
    const tex = renderLatex({ ...resume, layout });

    /*
     * Only the layout as authored. The format the shortcut loads carries the
     * layout baked in, so every shrinking attempt of the fit loop would dump
     * and cache a format of its own — fourteen megabytes each. The first
     * attempt is the one that matters for a live preview and is almost always
     * the answer; the shrinking steps go to the trusted engine.
     */
    if (wantFast && t === 0) {
      try {
        const raw = await compileFast(resume, layout);
        const m = measure(raw.aux, layout, 1);

        // Self-consistency guard: the reported page count and the measured
        // content height come from the same run and must roughly agree. On
        // rare pathological layouts (a margin so large the text block is
        // shorter than a single line) a raw `pdftex -fmt=` invocation has
        // been observed to under-report the page break count while the
        // height measurement itself stays correct — i.e. the two halves of
        // its own answer contradict each other. That is reason enough to
        // distrust the shortcut for this one attempt rather than ship a
        // number nothing else confirms.
        const perPagePt = textHeightIn(layout) * PT_PER_IN;
        const minPlausiblePages = Math.max(1, Math.ceil(m.usedPt / perPagePt - 1e-6));
        if (m.pages + 1 >= minPlausiblePages) {
          usedFast = true;
          return { layout, raw, m, tex };
        }
        // Falls through to the trusted engine below.
      } catch {
        // Fall through to the trusted engine for this attempt.
      }
    }
    const raw = await compileOnce(tex, engine);
    return { layout, raw, m: measure(raw.aux, layout, 1), tex };
  };
  const fitsAt = (a: Attempt) => a.m.pages <= base.maxPages;

  // 1. As authored. Almost always the answer, and always the preferred one.
  let best = await attempt(0);
  if (!fitsAt(best) && base.autoFit) {
    // 2. Everything at its floor. If even this overflows, no amount of
    //    searching helps — report the honest tightest number and stop.
    const tightest = await attempt(1);
    if (!fitsAt(tightest)) {
      best = tightest;
    } else {
      // 3. Somewhere in between fits. Find the least shrinking that does.
      let lo = 0; // known not to fit
      let hi = 1; // known to fit
      best = tightest;
      while (attemptsLeft > 0 && hi - lo > 0.06) {
        const mid = (lo + hi) / 2;
        const a = await attempt(mid);
        if (fitsAt(a)) {
          hi = mid;
          best = a;
        } else {
          lo = mid;
        }
      }
    }
  }

  const availablePt = textHeightIn(best.layout) * PT_PER_IN * base.maxPages;
  const baselinePt = readBaseline(best.raw.log) ?? best.layout.fontSizePt * 1.2;
  const fits = best.m.pages <= base.maxPages;

  // The compiled page count is ground truth; the height measurement is a
  // diagnostic derived from it. They can disagree by a few points at the
  // boundary (\raggedbottom, the depth of the final line), so keep the
  // diagnostic consistent with the verdict rather than reporting "fits, but
  // over by 4pt".
  const rawOverflowPt = best.m.usedPt - availablePt;
  const overflowPt = fits ? Math.min(rawOverflowPt, 0) : Math.max(rawOverflowPt, 0);

  const report: FitReport = {
    fits,
    pages: best.m.pages,
    usedPt: round(best.m.usedPt, 1),
    availablePt: round(availablePt, 1),
    overflowPt: round(overflowPt, 1),
    overflowLines: Math.ceil(Math.abs(overflowPt) / baselinePt) * Math.sign(overflowPt),
    layout: best.layout,
    adjustments: describe(base, best.layout),
  };

  if (opts.strict && !report.fits) throw new OverflowError(resume, report);

  if (opts.pdfPath) {
    fs.mkdirSync(path.dirname(opts.pdfPath), { recursive: true });
    fs.writeFileSync(opts.pdfPath, best.raw.pdf);
  }
  if (opts.texPath) {
    fs.mkdirSync(path.dirname(opts.texPath), { recursive: true });
    fs.writeFileSync(opts.texPath, best.tex, 'utf8');
  }

  return {
    ...report,
    pdfPath: opts.pdfPath,
    texPath: opts.texPath,
    tex: best.tex,
    engine,
    warnings: [...(resume.warnings ?? []), ...fontWarnings(best.raw.log), ...tooWideWarnings(best.raw.log)],
    log: tail(best.raw.log, 30),
    fastPath: usedFast,
  };
}

/**
 * What the log says about the fonts the engine could actually find.
 *
 * T1 is a promise the fonts have to keep, and a TeX install without a scalable
 * T1 face keeps it with METAFONT bitmaps — Type 3, with no ToUnicode map,
 * which is why the template falls back to setting everything without
 * ligatures. Worth saying out loud: it is a real difference in the PDF, and
 * one package fixes it.
 */
function fontWarnings(log: string): string[] {
  if (log.includes('RMM-FONT-FALLBACK')) {
    return [
      'Ligatures are switched off because this TeX install has no scalable T1 font. ' +
        'The PDF stays machine-readable, but dates print as "--" rather than an en dash. ' +
        'Installing the `lmodern` package restores both.',
    ];
  }
  if (log.includes('RMM-FONT-BITMAP')) {
    return [
      'This TeX install has neither `lmodern` nor `microtype`, so the PDF is set in bitmap ' +
        'fonts. It looks right, but an applicant tracking system cannot read words containing ' +
        'fi, fl or ff, or the dash in a date range. Installing `lmodern` fixes it.',
    ];
  }
  return [];
}

/**
 * Text that ran off the right-hand edge of the paper, and is therefore gone.
 *
 * The whole fit system here is vertical: `measure` asks how tall the content
 * came out and how many pages that took. Nothing asked how *wide* anything
 * was, and TeX does not wrap a word it cannot break — a long share link, a
 * Windows path, a token — so it sets it past the margin and off the page. The
 * glyphs are not in the PDF; `pdftotext` does not find them, and neither does
 * an applicant tracking system.
 *
 * What that looked like: a bullet holding an ordinary Google Docs link
 * compiled to "✓ 1 page, ~13 lines of room left", `strict` passed, `warnings`
 * was empty — and the link in the PDF ended `ouid=1234` where the one in the
 * save ended `ouid=1234567890`. A resume went out with a link nobody can
 * open, and nothing anywhere said so.
 *
 * A warning rather than a refusal: the document is otherwise fine, the person
 * is the one who can shorten the line, and failing the build would take away
 * a resume they could still send. But it has to be said, because losing text
 * silently is the one thing a document tool must not do.
 *
 * Above `\hfuzz` and then some. TeX reports an overfull box at 0.1pt, which is
 * a hairline nobody can see and nothing is lost to; a couple of points in is
 * where a glyph starts going missing.
 */
const TOO_WIDE = /^Overfull \\hbox \(([\d.]+)pt too wide\)/gm;
const NOTICEABLE_PT = 2;

function tooWideWarnings(log: string): string[] {
  const worst = [...log.matchAll(TOO_WIDE)]
    .map((m) => Number(m[1]))
    .filter((pt) => pt >= NOTICEABLE_PT)
    .sort((a, b) => b - a);
  if (worst.length === 0) return [];

  const many = worst.length > 1 ? `${worst.length} lines run` : 'A line runs';
  return [
    `${many} past the right-hand edge of the page — the widest by ${Math.round(worst[0]!)}pt — and ` +
      'whatever is past the edge is not in the PDF at all. This is usually one long unbroken ' +
      'thing: a link, a file path, a token. Shorten it, or put it behind a few words of link text.',
  ];
}

function readBaseline(log: string): number | undefined {
  // The last one. `runtimeSetup` reports the leading again after setting it,
  // and on the precompiled path the earlier report is the format's default.
  const all = [...log.matchAll(/RMM-BASELINESKIP:\s*([\d.]+)pt/g)];
  const m = all[all.length - 1];
  return m ? Number(m[1]) : undefined;
}

export interface LetterCompileResult {
  pdfPath?: string;
  texPath?: string;
  tex: string;
  engine: Engine;
  pages: number;
  /** A cover letter that runs past one page is a mistake worth naming. */
  fits: boolean;
  overflowLines: number;
  fastPath: boolean;
  log?: string;
}

/**
 * Compile a cover letter.
 *
 * Deliberately not run through the resume's auto-fit loop: shrinking a
 * letter's type to claw back two lines is the wrong fix — the fix is cutting a
 * sentence — so this compiles the layout as asked and reports honestly whether
 * it fit.
 */
export async function compileLetter(
  letter: LetterContent,
  layout: LayoutOptions,
  opts: Omit<CompileOptions, 'strict' | 'maxAttempts'> = {},
): Promise<LetterCompileResult> {
  const engine = await detectEngine(opts.engine);
  const tex = renderLetterLatex(letter, layout);
  assertRenderable(tex);

  let raw: RawCompile | undefined;
  let usedFast = false;

  if (opts.mode === 'preview' && (await hasFastPath())) {
    try {
      raw = await compileFastBody(renderLetterFastBody(letter, layout), layout.paper, layout);
      usedFast = true;
    } catch {
      raw = undefined; // fall back to the trusted engine
    }
  }
  if (!raw) raw = await compileOnce(tex, engine);

  const m = measure(raw.aux, layout, 1);
  const availablePt = textHeightIn(layout) * PT_PER_IN * Math.max(1, layout.maxPages);
  const baselinePt = readBaseline(raw.log) ?? layout.fontSizePt * 1.2;
  const fits = m.pages <= Math.max(1, layout.maxPages);
  const overflowPt = fits ? Math.min(m.usedPt - availablePt, 0) : Math.max(m.usedPt - availablePt, 0);

  if (opts.pdfPath) {
    fs.mkdirSync(path.dirname(opts.pdfPath), { recursive: true });
    fs.writeFileSync(opts.pdfPath, raw.pdf);
  }
  if (opts.texPath) {
    fs.mkdirSync(path.dirname(opts.texPath), { recursive: true });
    fs.writeFileSync(opts.texPath, tex, 'utf8');
  }

  return {
    pdfPath: opts.pdfPath,
    texPath: opts.texPath,
    tex,
    engine,
    pages: m.pages,
    fits,
    overflowLines: Math.ceil(Math.abs(overflowPt) / baselinePt) * Math.sign(overflowPt),
    fastPath: usedFast,
    log: tail(raw.log, 30),
  };
}
