import type { LayoutOptions, ResolvedResume, ResolvedSection } from '../model/types.js';

/**
 * Generates Jake Gutierrez's resume template, parameterised so the fit loop in
 * compile.ts can shrink type, leading, and margins between recompiles without
 * the template and the knobs living in two different places.
 */

const ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/**
 * Escape text for LaTeX in a single pass. Chained `.replace()` calls cannot do
 * this correctly: the braces in `\textbackslash{}` would be escaped again by
 * the rule that handles literal braces.
 */
export function tex(input: string): string {
  return String(input ?? '').replace(/[\\&%$#_{}~^]/g, (ch) => ESCAPES[ch] ?? ch);
}

/*
 * What the engine can actually put on the page.
 *
 * pdflatex and tectonic set type from 8-bit font encodings. Under T1 that is
 * the Latin scripts and nothing else: a name written in Chinese, Cyrillic,
 * Greek, Arabic or Hebrew is not merely mis-set, it is a fatal error and no PDF
 * is produced at all. That is a real thing to hit — `profile.name` is the first
 * field anyone fills in, and someone whose name is 张伟 has done nothing wrong.
 *
 * Left alone, the failure surfaced as "pdflatex failed: LaTeX Error: Unicode
 * character 张 (U+5F20) not set up for use with LaTeX", after eight identical
 * attempts of the fit loop, with nothing saying which field the character came
 * from or that the resume was fine apart from it. Checking first turns that
 * into one sentence naming the characters and where they are.
 *
 * The supported set was measured rather than assumed: a probe document of every
 * candidate code point, compiled, and the ones LaTeX refused taken out. Hence
 * the gaps inside Latin Extended-A — Ħ, ŉ, ŧ and a few others really are
 * missing from T1, while everything around them is present.
 */

/** Code points LaTeX refuses even though their neighbours are fine. */
const T1_GAPS = new Set([
  0x0126, 0x0127, 0x0138, 0x013f, 0x0140, 0x0149, 0x0166, 0x0167, 0x017f,
]);

/** Punctuation above Latin Extended-A that the utf8 input layer does define. */
const PUNCTUATION = new Set([
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, // hyphens and dashes
  0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, // curly quotes
  0x2020, 0x2021, 0x2022, 0x2026, 0x2030, // dagger, bullet, ellipsis, permille
  0x2039, 0x203a, 0x2044, 0x20ac, 0x2122, 0x2192, // guillemets, euro, arrow
  // Ligatures as single code points. Nobody types these, but copying your own
  // last resume out of its PDF pastes "ﬁrst" rather than "first".
  0xfb00, 0xfb01, 0xfb02, 0xfb03, 0xfb04,
]);

function renderable(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
  if (code < 0x20) return false; // control characters, NUL included
  if (code <= 0x7e) return true; // ASCII
  if (code < 0xa0) return false; // C1 controls
  if (code <= 0x017f) return !T1_GAPS.has(code); // Latin-1 and Latin Extended-A
  return PUNCTUATION.has(code);
}

export interface UnsupportedCharacter {
  char: string;
  /** Written as U+XXXX, the form the LaTeX log and every font table use. */
  codePoint: string;
  /** A little of the surrounding text, so the field it came from is findable. */
  context: string;
}

/**
 * Every character in a document the engine cannot set, each reported once.
 * Empty means the text will compile as far as its characters are concerned.
 */
export function unsupportedCharacters(text: string): UnsupportedCharacter[] {
  const found = new Map<string, UnsupportedCharacter>();
  const chars = [...String(text ?? '')];
  chars.forEach((ch, i) => {
    const code = ch.codePointAt(0) ?? 0;
    if (renderable(code)) return;
    if (found.has(ch)) return;
    found.set(ch, {
      char: ch,
      codePoint: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
      context: chars
        .slice(Math.max(0, i - 20), i + 20)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    });
  });
  return [...found.values()];
}

/** The message shown when a document cannot be set, or undefined when it can. */
export function unrenderableReason(text: string): string | undefined {
  const bad = unsupportedCharacters(text);
  if (bad.length === 0) return undefined;

  const shown = bad.slice(0, 6).map((b) => `${b.char} (${b.codePoint})`).join(', ');
  const more = bad.length > 6 ? `, and ${bad.length - 6} more` : '';
  return (
    `This resume contains ${bad.length} character${bad.length === 1 ? '' : 's'} the LaTeX ` +
    `engine cannot typeset: ${shown}${more}. It sets Latin scripts only, so text in ` +
    `Chinese, Japanese, Korean, Cyrillic, Greek, Arabic or Hebrew — and emoji — cannot go ` +
    `in the PDF. First occurrence near: "${bad[0]!.context}".`
  );
}

/*
 * Store text may use a tiny subset of markdown so a bullet can bold a metric
 * without the YAML holding LaTeX. Everything else is escaped.
 *
 * One scanner, not four chained `.replace()` passes. Those passes each hid
 * their output behind a placeholder so a later pass could not escape it again,
 * which worked only while no span contained another. It did not take a strange
 * bullet to break it: "ran `npm test **twice**` today" matches the bold rule
 * first, so the backtick rule wrapped a placeholder, and the final restore — a
 * single pass, which does not look inside what it substitutes — put the bold
 * span's placeholder back into the document unresolved. The .tex then carried
 * literal NUL bytes, which TeX rejects outright: no PDF at all, from one bullet
 * that mentioned a command and a number.
 *
 * Scanning left to right takes whichever span opens first and recurses into its
 * contents, so nesting is decided by where the markers are rather than by the
 * order the rules happen to run in.
 */

/** Link, bold, italic, code — the order here breaks a tie at the same index. */
const MARKUP =
  /\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|(?<=^|[\s(])\*([^*]+)\*(?=[\s).,;:]|$)|`(.+?)`/g;

/** Enough for bold inside a link inside italics; a guard, not a limit anyone meets. */
const MAX_NESTING = 4;

/*
 * Depth is deliberately not a parameter of the exported function. It was, for
 * about ten minutes, and `paragraphs.map(inlineTex)` in letter.ts quietly
 * passed the array index as the depth — so the first paragraph of every cover
 * letter rendered with depth 0 and lost all its markup. A one-argument function
 * cannot be broken that way by a callback.
 */
export function inlineTex(input: string): string {
  return markup(String(input ?? ''), MAX_NESTING);
}

function markup(s: string, depth: number): string {
  if (depth <= 0) return tex(s);

  const re = new RegExp(MARKUP.source, 'g');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(s)) !== null) {
    out += tex(s.slice(last, m.index));
    const [whole, label, url, bold, italic, code] = m;

    if (label !== undefined) {
      out += `\\href{${url!.replace(/([%#])/g, '\\$1')}}{\\underline{${markup(label, depth - 1)}}}`;
    } else if (bold !== undefined) {
      out += `\\textbf{${markup(bold, depth - 1)}}`;
    } else if (italic !== undefined) {
      out += `\\textit{${markup(italic, depth - 1)}}`;
    } else {
      // Code is literal, as it is everywhere else markdown is written: the
      // asterisks in `git commit -m "**"` are part of the command, not markup.
      out += `\\texttt{${tex(code!)}}`;
    }

    last = m.index + whole.length;
  }

  return out + tex(s.slice(last));
}

const PAPER = { letter: 'letterpaper', a4: 'a4paper' } as const;

function n(x: number, places = 3): string {
  return x.toFixed(places).replace(/\.?0+$/, '') || '0';
}

/*
 * The preamble is split in two.
 *
 * `stablePreamble` never changes: document class, packages, and the command
 * definitions. Because it is byte-identical across every compile, it can be
 * dumped to a precompiled format once and reloaded in milliseconds, which is
 * what makes the live preview feel live.
 *
 * `runtimeSetup` carries the numbers — font size, margins, spacing — and runs
 * inside each document. Every vertical adjustment is written as a multiple of
 * `\rmmunit`, a length set at run time, so the spacing knob works without the
 * command definitions having to change.
 */

/** Byte-identical across every compile, so it can be precompiled. */
export function stablePreamble(paper: LayoutOptions['paper'] = 'letter'): string {
  return `\\documentclass[${PAPER[paper]},11pt]{article}

% T1, and not merely for accents.
%
% In the default OT1 encoding, three characters people put in resumes without
% a second thought come out as different characters entirely: \`<\` prints as
% an inverted exclamation mark, \`>\` as an inverted question mark, and \`|\` as
% an em dash. Nothing errors — "Cut p99 latency to <100ms" simply goes to an
% employer reading "¡100ms".
%
% It also decides whether the PDF can be read by machine, which is the whole
% point of \`glyphtounicode\` below. Under OT1 an underscore and a tilde are
% drawn rather than set, so they carry no Unicode at all and an applicant
% tracking system extracts \`jane doe@x.com\` from \`jane_doe@x.com\` — a contact
% address that is wrong in the one copy nobody ever looks at.
\\usepackage[T1]{fontenc}

% A scalable font to go with that encoding.
%
% T1 on its own is a promise the fonts have to keep. Without a Type 1 T1 face
% installed, LaTeX falls back to METAFONT bitmaps — the log says
% \`ecrm1095.600pk\` — and \`pdffonts\` on the result shows six Type 3 fonts with
% no ToUnicode map. \`\\pdfgentounicode\` cannot build one for a Type 3 font, so
% the whole point of \`glyphtounicode\` above was lost exactly where it mattered
% most: every f-ligature came out unreadable. An applicant tracking system
% extracted control characters where "Firefly Office Staff Engineer" should
% have been: fit, office, flaky, efficiently, classified and workflows all
% came out unsearchable, on the one copy of the resume nobody ever looks at.
%
% (This comment is inside a template literal, so it cannot show those bytes
% the obvious way — an escape here becomes a real control character in the
% .tex, which the character check then refuses. Which is the check working.)
%
% Bitmaps also come in fixed sizes, so a request for 10.5pt was quietly served
% at 10.95pt and several steps of the fit loop changed nothing but the leading.
%
% \`lmodern\` is Computer Modern as a scalable Type 1 face: the same design the
% template already uses, so nothing about the page changes, and the ligatures
% carry their Unicode. It ships with every full TeX distribution.
%
% Where it is missing, the ligatures are switched off instead, so \`office\` is
% set as six glyphs that each map to a letter rather than one that maps to
% nothing — and \`--\` prints as two hyphens rather than an en dash, which is the
% same problem in the place it bites hardest: every date range on every resume
% came out of the PDF as \`Jul. 2024 <control character> Dec. 2024\`.
%
% That is a small typographic loss and a large legibility gain in the copy that
% gets parsed rather than read. (\`ae\` was the obvious third option and is worse
% than either: it restores the ligatures by building virtual fonts out of OT1,
% which takes the underscore and the accents back out — the two things T1 was
% added for in the first place.)
\\IfFileExists{lmodern.sty}{%
  \\usepackage{lmodern}%
}{%
  \\IfFileExists{microtype.sty}{%
    \\usepackage[activate=false]{microtype}%
    \\DisableLigatures{encoding = *}%
    \\typeout{RMM-FONT-FALLBACK}%
  }{%
    \\typeout{RMM-FONT-BITMAP}%
  }%
}
\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage[usenames,dvipsnames]{color}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{fancyhdr}
\\usepackage[english]{babel}
\\usepackage{tabularx}
\\usepackage{scrextend}
\\usepackage{zref-savepos}
\\usepackage{zref-abspage}
\\input{glyphtounicode}

% Record the page number alongside each saved position, so the fit checker can
% tell "bottom of page 1" from "bottom of page 2".
\\makeatletter
\\zref@addprop{savepos}{abspage}
\\makeatother

% Every vertical adjustment below is a multiple of this, set per document.
\\newlength{\\rmmunit}
\\setlength{\\rmmunit}{1pt}

\\pagestyle{fancy}
\\fancyhf{}
\\fancyfoot{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}

\\setlength{\\headheight}{0pt}
\\setlength{\\headsep}{0pt}

\\urlstyle{same}
\\raggedbottom
\\raggedright
\\setlength{\\tabcolsep}{0in}

\\titleformat{\\section}{%
  \\vspace{-4\\rmmunit}\\scshape\\raggedright\\large
}{}{0em}{}[\\color{black}\\titlerule \\vspace{-5\\rmmunit}]

% Make the generated PDF machine readable so ATS parsers get real text.
\\pdfgentounicode=1

\\newcommand{\\resumeItem}[1]{%
  \\item\\small{%
    {#1 \\vspace{-2\\rmmunit}}%
  }%
}

\\newcommand{\\resumeSubheading}[4]{%
  \\vspace{-2\\rmmunit}\\item
    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
      \\textbf{#1} & #2 \\\\
      \\textit{\\small#3} & \\textit{\\small #4} \\\\
    \\end{tabular*}\\vspace{-7\\rmmunit}%
}

\\newcommand{\\resumeProjectHeading}[2]{%
    \\item
    \\begin{tabular*}{0.97\\textwidth}{l@{\\extracolsep{\\fill}}r}
      \\small#1 & #2 \\\\
    \\end{tabular*}\\vspace{-7\\rmmunit}%
}

\\renewcommand\\labelitemii{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}

\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0.15in, label={}]}
\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-5\\rmmunit}}

% Records where the first and last lines of content landed, so the fit checker
% can say "over by three lines" rather than only "two pages".
\\AtEndDocument{\\zsavepos{rmmend}}
\\AtBeginDocument{\\typeout{RMM-BASELINESKIP: \\the\\baselineskip}}
`;
}

/** The numbers for one particular layout, run inside the document. */
export function runtimeSetup(layout: LayoutOptions): string {
  const sp = layout.spacing;
  // Jake's template hard-codes 0.5in margins by fiddling \oddsidemargin etc.
  // The offsets below reproduce that arithmetic for an arbitrary margin.
  const side = layout.marginIn - 1.0;
  const top = layout.marginIn - 1.0;
  const paper = layout.paper === 'a4' ? { w: 8.27, h: 11.69 } : { w: 8.5, h: 11 };

  return `\\setlength{\\rmmunit}{${n(sp, 4)}pt}
\\setlength{\\oddsidemargin}{${n(side)}in}
\\setlength{\\evensidemargin}{${n(side)}in}
\\setlength{\\textwidth}{${n(paper.w - layout.marginIn * 2)}in}
\\setlength{\\topmargin}{${n(top)}in}
\\setlength{\\textheight}{${n(paper.h - layout.marginIn * 2)}in}

% Continuous control over the base size; \`article\` only offers 10/11/12pt.
% The leading is clamped at just above the font size: KOMA rejects a
% \\baselineskip smaller than the type, and a tighter setting is unreadable
% anyway. Below that floor, \`spacing\` keeps working on the block gaps.
\\changefontsizes[${n(layout.fontSizePt * Math.max(1.02, 1.2 * sp), 2)}pt]{${n(layout.fontSizePt, 2)}pt}

% Reported again here, after the size is set. The copy in the preamble fires
% from \`\\AtBeginDocument\`, which on the precompiled path runs before these
% lines do — so the log's first answer is the format's default, not this
% document's, and the overflow-in-lines figure was computed from it.
\\typeout{RMM-BASELINESKIP: \\the\\baselineskip}
`;
}

function preamble(layout: LayoutOptions): string {
  return `${stablePreamble(layout.paper)}\n${runtimeSetup(layout)}`;
}

function header(r: ResolvedResume): string {
  const p = r.profile;
  const bits: string[] = [];
  if (p.phone) bits.push(tex(p.phone));
  if (p.email) bits.push(`\\href{mailto:${p.email}}{\\underline{${tex(p.email)}}}`);
  for (const url of [p.linkedin, p.github, p.website]) {
    if (!url) continue;
    const full = /^https?:\/\//.test(url) ? url : `https://${url}`;
    const shown = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    bits.push(`\\href{${full.replace(/([%#])/g, '\\$1')}}{\\underline{${tex(shown)}}}`);
  }
  if (p.location) bits.push(tex(p.location));

  return `\\begin{center}
    {\\Huge \\scshape ${tex(p.name)}} \\\\ \\vspace{${n(3 * r.layout.spacing, 2)}pt}\\small
    ${bits.join(' $|$ ')}
\\end{center}`;
}

function section(s: ResolvedSection): string {
  if (s.kind === 'skills') {
    const groups = s.skillGroups.filter((g) => g.items.length > 0);
    if (groups.length === 0) return '';
    const lines = groups
      .map((g) => `     \\textbf{${tex(g.name)}}{: ${tex(g.items.join(', '))}}`)
      .join(' \\\\\n');
    return `\\section{${tex(s.heading)}}
 \\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{
${lines}
    }}
 \\end{itemize}`;
  }

  if (s.entries.length === 0) return '';

  const body = s.entries
    .map((e) => {
      const bullets =
        e.bullets.length > 0
          ? `\n      \\resumeItemListStart\n${e.bullets
              .map((b) => `        \\resumeItem{${inlineTex(b.text)}}`)
              .join('\n')}\n      \\resumeItemListEnd`
          : '';

      // Projects use the one-line heading form, like the original template.
      if (e.kind === 'project') {
        const left = e.subtitle
          ? `\\textbf{${inlineTex(e.title)}} $|$ \\emph{${inlineTex(e.subtitle)}}`
          : `\\textbf{${inlineTex(e.title)}}`;
        return `    \\resumeProjectHeading
      {${left}}{${e.dates ? inlineTex(e.dates) : ''}}${bullets}`;
      }

      return `    \\resumeSubheading
      {${inlineTex(e.title)}}{${e.dates ? inlineTex(e.dates) : ''}}
      {${e.subtitle ? inlineTex(e.subtitle) : ''}}{${e.location ? inlineTex(e.location) : ''}}${bullets}`;
    })
    .join('\n');

  return `\\section{${tex(s.heading)}}
  \\resumeSubHeadingListStart
${body}
  \\resumeSubHeadingListEnd`;
}

/**
 * Everything after the preamble: the part that differs between resumes and
 * therefore can never be baked into a precompiled format. Shared by the full
 * document and the fast path, which supplies its own preamble via a
 * precompiled `.fmt` instead of `stablePreamble`.
 */
function documentBody(r: ResolvedResume, setup = ''): string {
  const sections = r.sections.map(section).filter(Boolean).join('\n\n');
  return `\\begin{document}
${setup}\\zsavepos{rmmstart}

${header(r)}

${sections}

\\end{document}
`;
}

/** Full .tex source for a resolved resume: preamble plus body. */
export function renderLatex(r: ResolvedResume): string {
  return `${preamble(r.layout)}\n${documentBody(r)}`;
}

/**
 * Just the numbers and the body — no document class, no packages, no command
 * definitions. Valid input only when preloaded against a format dumped from
 * `stablePreamble` for the same paper size; see fastCompile.ts.
 */
export function renderLatexFastBody(r: ResolvedResume): string {
  // No `runtimeSetup` here: the format this runs against was dumped with the
  // layout already in it. See getFormat in fastCompile.ts for why it cannot
  // live in the document.
  return documentBody(r);
}
