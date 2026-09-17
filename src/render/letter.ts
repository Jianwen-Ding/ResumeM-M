import type { LayoutOptions, ResolvedProfile } from '../model/types.js';
import { inlineTex, runtimeSetup, stablePreamble, tex, texHref } from './latex.js';

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

function hasSignOff(body: string, name: string): boolean {
  const lines = body.trimEnd().split('\n').slice(-4).map((l) => l.trim());
  if (lines.some((line) => SIGN_OFF_LINE.test(line))) return true;

  const wanted = name.trim();
  if (!wanted) return false;
  return lines.some((line) => line.toLowerCase() === wanted.toLowerCase());
}

/** The sender block: identical to the resume header, so the pair matches. */
function header(p: ResolvedProfile, spacing: number): string {
  const bits: string[] = [];
  if (p.phone) bits.push(tex(p.phone));
  if (p.email) bits.push(`\\href{mailto:${texHref(p.email)}}{\\underline{${tex(p.email)}}}`);
  for (const url of [p.linkedin, p.github, p.website]) {
    if (!url) continue;
    const full = /^https?:\/\//.test(url) ? url : `https://${url}`;
    const shown = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    bits.push(`\\href{${texHref(full)}}{\\underline{${tex(shown)}}}`);
  }
  if (p.location) bits.push(tex(p.location));

  return `\\begin{center}
    {\\Huge \\scshape ${tex(p.name)}} \\\\ \\vspace{${(3 * spacing).toFixed(2)}pt}\\small
    ${bits.join(' $|$ ')}
\\end{center}`;
}

/**
 * Turn typed prose into paragraphs. Blank lines separate them; a single
 * newline inside a paragraph is a wrap, not a break, which is how every text
 * editor and every word processor treats it.
 */
function paragraphs(body: string): string[] {
  return body
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim().replace(/\n/g, ' '))
    .filter(Boolean);
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
function letterBody(letter: LetterContent, layout: LayoutOptions, setup = ''): string {
  const p = letter.profile;
  const gap = (mult: number) => `\\vspace{${(mult * layout.spacing).toFixed(1)}pt}`;

  const blocks: string[] = [
    // A letter is block-set: no first-line indents, a visible gap between
    // paragraphs instead.
    `\\setlength{\\parindent}{0pt}\n\\setlength{\\parskip}{${(6 * layout.spacing).toFixed(1)}pt}`,
    header(p, layout.spacing),
    gap(14),
    tex(letter.date ?? today()),
  ];

  if (letter.company) {
    blocks.push(
      letter.role
        ? `${tex(letter.company)} \\\\\n\\textit{Re: ${tex(letter.role)}}`
        : tex(letter.company),
    );
  }

  const bodyText = letter.body ?? '';
  if (!hasGreeting(bodyText)) {
    const greeting = letter.greeting ?? (letter.company ? `Dear ${letter.company} Hiring Team,` : 'Dear Hiring Team,');
    blocks.push(tex(greeting));
  }

  const written = paragraphs(bodyText);
  blocks.push(written.length === 0 ? '\\textit{(nothing written yet)}' : written.map(inlineTex).join('\n\n'));

  if (!hasSignOff(bodyText, p.name)) {
    blocks.push(gap(10), `${tex(letter.signOff ?? 'Sincerely,')} \\\\[${(10 * layout.spacing).toFixed(1)}pt]\n${tex(p.name)}`);
  }

  return `\\begin{document}
${setup}\\zsavepos{rmmstart}

${blocks.join('\n\n')}

\\end{document}
`;
}

/** Full .tex source for a cover letter: preamble plus body. */
export function renderLetterLatex(letter: LetterContent, layout: LayoutOptions): string {
  return `${stablePreamble(layout.paper)}\n${runtimeSetup(layout)}\n${letterBody(letter, layout)}`;
}

/**
 * Just the numbers and the body, for the precompiled-format preview path —
 * the same arrangement `renderLatexFastBody` uses for a resume.
 */
export function renderLetterFastBody(letter: LetterContent, layout: LayoutOptions): string {
  // No `runtimeSetup`: the format carries the layout. See fastCompile.ts.
  return letterBody(letter, layout);
}
