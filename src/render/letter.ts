import type { LayoutOptions, ResolvedProfile } from '../model/types.js';
import { inlineTex, lineTex, runtimeSetup, stablePreamble, tex, texHref } from './latex.js';

/**
 * A cover letter, typeset to match the resume.
 *
 * A letter that arrives as a .txt next to a LaTeX-set resume looks like an
 * afterthought, and half the portals that take a letter take it as a file. So
 * the letter is a real document: same preamble, same type, same margins, same
 * name block at the top — the pair reads as one application.
 *
 * Reusing the resume's `stablePreamble` is also what makes the letter preview
 * live: the precompiled format built for the resume is byte-identical here, so
 * a letter recompiles through the same ~100ms path.
 */

export interface LetterContent {
  /** Already resolved: by the time a letter is typeset the name is one name. */
  profile: ResolvedProfile;
  /** Who it is addressed to, when known. */
  company?: string;
  role?: string;
  /** The letter itself, as the person typed it. Blank lines separate paragraphs. */
  body: string;
  /** Printed under the header. Defaults to today. */
  date?: string;
  /** Overrides the greeting. Ignored when the body already opens with one. */
  greeting?: string;
  /** Overrides the sign-off. Ignored when the body already closes with one. */
  signOff?: string;
}

/**
 * The page a letter is set on, from the page its resume is set on.
 *
 * It was the resume's page exactly: 10.5pt type inside 0.45in margins, which
 * is a resume's compromise between legible and complete. On a letter, which
 * is a few paragraphs of prose, it made lines of 120 characters across the
 * whole sheet and left the bottom half of the page empty. A letter is read,
 * not scanned, so it gets a letter's page: at least 11pt, an inch of margin,
 * lines a little apart. It keeps the resume's type if that is larger, and its
 * paper, so the pair still matches.
 *
 * Then it is fitted like a resume: grown to fill the page it has — up to
 * 12pt and an inch and a quarter — or, for a long letter, brought in only so
 * far, never to a resume's margins. A letter still too long at that is too
 * long, and says so.
 */
export function letterLayout(page: LayoutOptions): LayoutOptions {
  return {
    ...page,
    fontSizePt: Math.max(page.fontSizePt, 11),
    marginIn: Math.max(page.marginIn, 1),
    spacing: Math.max(page.spacing, 1.05),
    autoFit: true,
    maxPages: 1,
    growBounds: { maxFontSizePt: 12, maxSpacing: 1.2, maxMarginIn: 1.25 },
    fitBounds: { minFontSizePt: Math.min(page.fontSizePt, 10.5), minSpacing: Math.min(page.spacing, 1), minMarginIn: 0.75 },
  };
}

function today(): string {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Does the body already start with its own salutation? People write "Dear
 * hiring team," themselves, and a template that adds a second one is worse
 * than a template that adds none.
 */
function hasGreeting(body: string): boolean {
  const first = (body.trimStart().split('\n')[0] ?? '').trim();
  // "Dear …" and "To whom it may concern" are only ever salutations. "Hello"
  // and "Hi" also open sentences, so those count only as a salutation *line*:
  // short, and closed with a comma or a colon.
  if (/^(dear\b|to whom it may concern)/i.test(first)) return true;
  return /^(hello|hi|greetings|good (morning|afternoon))\b[^.!?]{0,60}[,:]$/i.test(first);
}

/**
 * Same question for the sign-off, which people also write themselves.
 *
 * A sign-off is a short line of its own, not a word at the end of a sentence.
 * Matching `\b(sincerely|regards|best|…)\b[,\s]*$` against the last few lines
 * caught any line *ending* in one of those words — and "I do my best.", "I
 * would bring my best", "Thank you", "With regards to the on-call rotation, I
 * am doing my best" are all things people write in the body of a letter. Each
 * one convinced this that the letter was already signed, so the closing and
 * the sender's name were left off and the letter went out unsigned.
 *
 * The name check had a worse version of the same fault: with an empty name the
 * pattern collapsed to `^\s*\s*$`, which matches the blank line between any
 * two paragraphs, so *every* multi-paragraph letter lost its sign-off.
 */
const SIGN_OFF_LINE =
  /^(sincerely|best|best regards|kind regards|warm regards|warmly|regards|yours|yours truly|yours sincerely|yours faithfully|thank you|many thanks|thanks)[,.]?$/i;

/**
 * Where the closing the writer typed starts, as an index into `lines`, or -1.
 *
 * The last sign-off line of the last four, else a line that is the name: so
 * "Thank you.\n\nBest,\nMorgan" closes at "Best,", not at "Thank you.".
 */
function closingAt(lines: string[], name: string): number {
  const from = Math.max(0, lines.length - 4);
  const tail = lines.slice(from).map((l) => l.trim());
  for (let i = tail.length - 1; i >= 0; i--) if (SIGN_OFF_LINE.test(tail[i]!)) return from + i;

  const wanted = name.trim().toLowerCase();
  if (!wanted) return -1;
  const at = tail.findIndex((line) => line.toLowerCase() === wanted);
  return at < 0 ? -1 : from + at;
}

/**
 * The greeting and closing the writer typed, taken off the body and kept as
 * lines.
 *
 * They were left in the body, where a single newline is a wrap — so
 * "Best,\nMorgan Testwell" printed as "Best, Morgan Testwell" on one line,
 * and "Dear Hiring Manager,\nI am writing…" ran the greeting into the first
 * sentence. A greeting is its own line and a closing is a block of lines, as
 * they are when the letter adds them itself.
 */
function ownParts(body: string, name: string): { greeting?: string; body: string; closing?: string[] } {
  let lines = body.replace(/\r\n?/g, '\n').trim().split('\n');
  let greeting: string | undefined;
  if (hasGreeting(body)) {
    greeting = lines[0]!.trim();
    lines = lines.slice(1);
  }
  const at = closingAt(lines, name);
  if (at < 0) return { greeting, body: lines.join('\n') };
  const closing = lines.slice(at).map((l) => l.trim()).filter(Boolean);
  return { greeting, body: lines.slice(0, at).join('\n'), closing };
}

/**
 * The contact details, and the two ways of setting them on two rows.
 *
 * Joined into one line and left to TeX, a line too long for the page broke
 * wherever it ran out — after the LinkedIn address, say — leaving a long row
 * over a stub. So the rows are chosen, not fallen into: one row when it fits;
 * otherwise the ways to reach you (phone, email, where you are) above the
 * places to look you up (the links), which is a break a reader understands;
 * and if either of those is itself too wide, the split that leaves the two
 * rows most nearly equal in length. Which of these fits is measured by TeX
 * at the size the letter is set — see `header` — so this only offers them.
 */
export function contactRows<T extends { text: string; link: boolean }>(items: T[]): { reach: T[]; look: T[]; even: [T[], T[]] } {
  const width = (row: T[]) => row.reduce((n, item, i) => n + item.text.length + (i ? 3 : 0), 0);
  let cut = 1;
  for (let at = 1; at < items.length; at++) {
    if (Math.max(width(items.slice(0, at)), width(items.slice(at))) < Math.max(width(items.slice(0, cut)), width(items.slice(cut)))) cut = at;
  }
  return {
    reach: items.filter((i) => !i.link),
    look: items.filter((i) => i.link),
    even: [items.slice(0, cut), items.slice(cut)],
  };
}

/** The sender block: identical to the resume header, so the pair matches. */
function header(p: ResolvedProfile, layout: LayoutOptions): string {
  const { spacing } = layout;
  const items: { tex: string; text: string; link: boolean }[] = [];
  if (p.phone) items.push({ tex: tex(p.phone), text: p.phone, link: false });
  if (p.email) items.push({ tex: `\\href{mailto:${texHref(p.email)}}{\\underline{${tex(p.email)}}}`, text: p.email, link: false });
  if (p.location) items.push({ tex: tex(p.location), text: p.location, link: false });
  for (const url of [p.linkedin, p.github, p.website]) {
    if (!url) continue;
    const full = /^https?:\/\//.test(url) ? url : `https://${url}`;
    const shown = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    items.push({ tex: `\\href{${texHref(full)}}{\\underline{${tex(shown)}}}`, text: shown, link: true });
  }
  const between = '\\kern0.45em\\textbar\\kern0.45em ';
  const row = (of: typeof items) => of.map((i) => i.tex).join(between);
  // A paragraph break, not `\\`: that looks ahead for a `[` and trips over
  // the `\fi` the rows sit in front of.
  // And without the gap between paragraphs, which is a letter's, not a row's.
  const rowGap = `\\par\\vspace{-\\parskip}\\vspace{${(1.5 * spacing).toFixed(1)}pt}\\leavevmode`;
  const { reach, look, even } = contactRows(items);

  /*
   * Measured, not guessed: each way of setting the details is put in a box
   * and the first whose rows are no wider than the line is the one used.
   * The even split is left free to break, for the details no two rows hold.
   */
  const twoEven = `${row(even[0])}${rowGap}\n    ${row(even[1])}`;
  const contact =
    items.length === 0
      ? ''
      : `\\setbox0=\\hbox{${row(items)}}%
    \\ifdim\\wd0>\\linewidth
      ${
        reach.length && look.length
          ? `\\setbox2=\\hbox{${row(reach)}}\\setbox4=\\hbox{${row(look)}}%
      \\ifdim\\wd2>\\linewidth ${twoEven}\\else\\ifdim\\wd4>\\linewidth ${twoEven}\\else\\leavevmode\\box2${rowGap}\\box4\\fi\\fi`
          : twoEven
      }
    \\else\\leavevmode\\box0\\fi`;

  /*
   * The name on one line. Left to wrap, a long one — "Morgan Alexandra
   * Testwell-Fitzgerald" is enough — broke over two lines set at the leading
   * of the small type under it, the capitals of one line all but touching
   * the line above. So it steps down a size or three until it fits, and only a
   * name too long even for that wraps, at its own leading.
   */
  const name = tex(p.name);
  const nameLine = `\\setbox0=\\hbox{\\Huge \\scshape ${name}}%
    \\ifdim\\wd0>\\linewidth \\setbox0=\\hbox{\\huge \\scshape ${name}}\\fi
    \\ifdim\\wd0>\\linewidth \\setbox0=\\hbox{\\LARGE \\scshape ${name}}\\fi
    \\ifdim\\wd0>\\linewidth \\setbox0=\\hbox{\\Large \\scshape ${name}}\\fi
    \\ifdim\\wd0>\\linewidth \\parbox[b]{\\linewidth}{\\centering\\Large \\scshape ${name}}\\else\\leavevmode\\box0\\fi`;

  // A rule under it, as the resume has under each heading: the letterhead
  // reads as a letterhead, and the letter starts below it.
  return `\\begin{center}
    ${nameLine} \\\\ \\vspace{${(3 * spacing).toFixed(2)}pt}\\small
    ${contact}
\\end{center}
\\vspace{-\\parskip}\\vspace{-${(6 * spacing).toFixed(1)}pt}
\\noindent\\rule{\\textwidth}{0.4pt}`;
}

/**
 * Turn typed prose into paragraphs. Blank lines separate them; a single
 * newline inside a paragraph is a wrap, not a break, which is how every text
 * editor and every word processor treats it — except in a list, see
 * `LIST_ITEM`. Returned as TeX.
 */
function paragraphs(body: string): string[] {
  const out: string[] = [];
  for (const block of body.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    let prose: string[] = [];
    let items: { label: string; text: string }[] = [];
    const endProse = () => {
      if (prose.length) out.push(proseTex(prose.join(' ')));
      prose = [];
    };
    const endList = () => {
      if (items.length) out.push(listTex(items));
      items = [];
    };
    for (const line of block.split('\n')) {
      if (!line.trim()) continue;
      const item = LIST_ITEM.exec(line);
      if (item) {
        endProse();
        items.push({ label: item[2] ? `${item[2]}${item[3]}` : '\\textbullet', text: item[4]! });
      } else if (items.length) {
        // A line under an item without a marker of its own carries it on.
        items[items.length - 1]!.text += ` ${line.trim()}`;
      } else {
        prose.push(line.trim());
      }
    }
    endProse();
    endList();
  }
  return out;
}

/**
 * A list the writer typed as one: "- ", "* ", "• " or "1. " at the start of
 * a line.
 *
 * Read as prose, a line break inside a paragraph is a wrap, so a list came
 * out as one run-on paragraph — "- Rebuilt the input pipeline - Shipped two
 * games - Wrote a profiler", with the dashes left in the middle of it. It is
 * the first thing a model writing a letter reaches for, and people paste
 * them from their own notes. Each item is its own line, the marker hung in
 * the margin and the wrapped lines under the text, and the items are not
 * pulled apart by the gap that separates paragraphs.
 */
const LIST_ITEM = /^\s*(?:([-*+•–])|(\d{1,3})([.)]))\s+(\S.*)$/;

function listTex(items: { label: string; text: string }[]): string {
  return items
    .map((i) => `\\hangindent=2em\\hangafter=0\\leavevmode\\llap{${i.label}\\hspace{0.5em}}${proseTex(i.text.trim())}`)
    .join('\\par\\vspace{-\\parskip}\n');
}

/**
 * A line of the letter, with somewhere to break a pasted address.
 *
 * A URL is one word to TeX, and one longer than the line ran past the right
 * margin — "https://…/benchmarks/latencyresults2026/summary.html" set half
 * off the text block, over "My work is at" left alone on the line above.
 * A bare address — with its scheme or without, "docs.google.com/d/…" — may
 * now break after a `/`, `.`, `?`, `&`, `=`, `_` or `#`, as a browser's
 * address bar does, at a small cost so a space is still the break TeX would
 * rather take. Only a bare one: a markdown link's target goes into `\href`
 * as it is.
 */
const BARE_URL = /\]\((?:[^()]|\([^()]*\))*\)|(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*/gi;
const BREAK = '\uE000';

function proseTex(text: string): string {
  const marked = text.replace(BARE_URL, (url) =>
    url.startsWith('](') ? url : url.replace(/((?<!:\/)\/(?!\/)|[.?&=_#])(?=\S)/g, `$1${BREAK}`),
  );
  return inlineTex(marked).replaceAll(BREAK, '\\penalty100{}');
}

/**
 * Everything inside `\begin{document}`, shared by both compile paths.
 *
 * Blocks are separated by blank lines, which is what actually ends a paragraph
 * in LaTeX — a `\vspace` on its own does not, and joining these with single
 * newlines runs the date, the greeting, and the first sentence together on one
 * line. `\parskip` carries the gap between paragraphs so the spacing knob
 * still controls it.
 */
function letterBody(letter: LetterContent, layout: LayoutOptions, setup = '', lead = 0): string {
  const p = letter.profile;
  const gap = (mult: number) => `\\vspace{${(mult * layout.spacing).toFixed(1)}pt}`;

  const blocks: string[] = [
    // A letter is block-set: no first-line indents, a visible gap between
    // paragraphs instead — most of a line, so the paragraphs read as
    // paragraphs at whatever size the letter was set.
    `\\setlength{\\parindent}{0pt}\n\\setlength{\\parskip}{${(0.75 * layout.fontSizePt * layout.spacing).toFixed(1)}pt}`,
    header(p, layout),
    /*
     * The letter starts a little way under the letterhead, and further for a
     * short one: `lead` is the room a letter of a few lines leaves at the
     * foot of the page, some of it spent here so the letter sits on the page
     * rather than hanging off the top of it. See `compileLetter`.
     */
    `\\vspace{${(10 * layout.spacing + lead).toFixed(1)}pt}`,
    tex(letter.date ?? today()),
  ];

  if (letter.company) {
    blocks.push(
      letter.role
        ? `${lineTex(letter.company)} \\\\\n\\textit{Re: ${lineTex(letter.role)}}`
        : lineTex(letter.company),
    );
  }

  const own = ownParts(letter.body ?? '', p.name);
  if (own.greeting) {
    blocks.push(inlineTex(own.greeting));
  } else {
    const greeting = letter.greeting ?? (letter.company ? `Dear ${letter.company} Hiring Team,` : 'Dear Hiring Team,');
    blocks.push(tex(greeting));
  }

  const written = paragraphs(own.body);
  if (written.length) blocks.push(written.join('\n\n'));
  else if (!own.greeting && !own.closing) blocks.push('\\textit{(nothing written yet)}');

  // Room under the sign-off where a signature would go.
  const signature = `\\\\[${(2.2 * layout.fontSizePt * layout.spacing).toFixed(1)}pt]\n`;
  if (!own.closing) {
    blocks.push(`${tex(letter.signOff ?? 'Sincerely,')} ${signature}${tex(p.name)}`);
  } else {
    // The writer's own closing, a line to a line, with the same room under
    // their sign-off as under the one the letter would have added.
    // A sign-off with nothing under it ("Thank you,") still gets the name:
    // taken as the whole closing, it sent the letter out unsigned.
    const [first, ...rest] = own.closing.map(inlineTex);
    if (SIGN_OFF_LINE.test(own.closing[0]!)) {
      blocks.push(`${first} ${signature}${rest.length ? rest.join(' \\\\\n') : tex(p.name)}`);
    } else {
      blocks.push([first, ...rest].join(' \\\\\n'));
    }
  }

  return `\\begin{document}
${setup}\\zsavepos{rmmstart}

${blocks.join('\n\n')}

\\end{document}
`;
}

/** Full .tex source for a cover letter: preamble plus body. */
export function renderLetterLatex(letter: LetterContent, layout: LayoutOptions, lead = 0): string {
  return `${stablePreamble(layout.paper)}\n${runtimeSetup(layout)}\n${letterBody(letter, layout, '', lead)}`;
}

/**
 * Just the numbers and the body, for the precompiled-format preview path —
 * the same arrangement `renderLatexFastBody` uses for a resume.
 */
export function renderLetterFastBody(letter: LetterContent, layout: LayoutOptions, lead = 0): string {
  // No `runtimeSetup`: the format carries the layout. See fastCompile.ts.
  return letterBody(letter, layout, '', lead);
}
