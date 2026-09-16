import type { LayoutOptions, ResolvedResume, ResolvedSection } from '../model/types.js';

/**
 * Generates Jake Gutierrez's resume template, parameterised so the fit loop in
 * compile.ts can shrink type, leading, and margins between recompiles without
 * the template and the knobs living in two different places.
 */

/** Escape text for LaTeX. Order matters: backslash first, or it eats the rest. */
export function tex(input: string): string {
  return String(input ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/**
 * Store text may use a tiny subset of markdown so a bullet can bold a metric
 * without the YAML holding LaTeX. Everything else is escaped.
 */
export function inlineTex(input: string): string {
  const s = String(input ?? '');
  // Protect the markup spans, escape the rest, then restore as LaTeX commands.
  const slots: string[] = [];
  const hold = (latex: string): string => {
    slots.push(latex);
    return `\u0000${slots.length - 1}\u0000`;
  };

  const marked = s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
      hold(`\\href{${url.replace(/([%#])/g, '\\$1')}}{\\underline{${tex(label)}}}`),
    )
    .replace(/\*\*(.+?)\*\*/g, (_m, inner: string) => hold(`\\textbf{${tex(inner)}}`))
    .replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,;:]|$)/g, (_m, pre: string, inner: string) =>
      `${pre}${hold(`\\textit{${tex(inner)}}`)}`,
    )
    .replace(/`(.+?)`/g, (_m, inner: string) => hold(`\\texttt{${tex(inner)}}`));

  return tex(marked).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? '');
}

const PAPER = { letter: 'letterpaper', a4: 'a4paper' } as const;

function n(x: number, places = 3): string {
  return x.toFixed(places).replace(/\.?0+$/, '') || '0';
}

/**
 * The preamble. Three things are interpolated: base font size (via scrextend's
 * \changefontsizes, since `article` only offers 10/11/12pt), the margin, and a
 * spacing multiplier applied to every vertical adjustment in the template.
 */
function preamble(layout: LayoutOptions): string {
  const sp = layout.spacing;
  // Jake's template hard-codes 0.5in margins by fiddling \oddsidemargin etc.
  // The offsets below reproduce that arithmetic for an arbitrary margin.
  const side = layout.marginIn - 1.0; // \oddsidemargin is relative to a 1in origin
  const top = layout.marginIn - 1.0;
  const textwidth = (layout.paper === 'a4' ? 8.27 : 8.5) - layout.marginIn * 2;
  const textheight = (layout.paper === 'a4' ? 11.69 : 11) - layout.marginIn * 2;
  const v = (base: number) => n(base * sp, 2);

  return `\\documentclass[${PAPER[layout.paper]},11pt]{article}

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

% Continuous control over the base size; \`article\` only offers 10/11/12pt.
% The leading is clamped at just above the font size: KOMA rejects a
% \\baselineskip smaller than the type, and a tighter setting is unreadable
% anyway. Below that floor, \`spacing\` keeps working on the block gaps.
\\changefontsizes[${n(layout.fontSizePt * Math.max(1.02, 1.2 * sp), 2)}pt]{${n(layout.fontSizePt, 2)}pt}

\\pagestyle{fancy}
\\fancyhf{}
\\fancyfoot{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}

\\setlength{\\oddsidemargin}{${n(side)}in}
\\setlength{\\evensidemargin}{${n(side)}in}
\\setlength{\\textwidth}{${n(textwidth)}in}
\\setlength{\\topmargin}{${n(top)}in}
\\setlength{\\headheight}{0pt}
\\setlength{\\headsep}{0pt}
\\setlength{\\textheight}{${n(textheight)}in}

\\urlstyle{same}
\\raggedbottom
\\raggedright
\\setlength{\\tabcolsep}{0in}

\\titleformat{\\section}{%
  \\vspace{-${v(4)}pt}\\scshape\\raggedright\\large
}{}{0em}{}[\\color{black}\\titlerule \\vspace{-${v(5)}pt}]

% Make the generated PDF machine readable so ATS parsers get real text.
\\pdfgentounicode=1

\\newcommand{\\resumeItem}[1]{%
  \\item\\small{%
    {#1 \\vspace{-${v(2)}pt}}%
  }%
}

\\newcommand{\\resumeSubheading}[4]{%
  \\vspace{-${v(2)}pt}\\item
    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
      \\textbf{#1} & #2 \\\\
      \\textit{\\small#3} & \\textit{\\small #4} \\\\
    \\end{tabular*}\\vspace{-${v(7)}pt}%
}

\\newcommand{\\resumeProjectHeading}[2]{%
    \\item
    \\begin{tabular*}{0.97\\textwidth}{l@{\\extracolsep{\\fill}}r}
      \\small#1 & #2 \\\\
    \\end{tabular*}\\vspace{-${v(7)}pt}%
}

\\renewcommand\\labelitemii{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}

\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0.15in, label={}]}
\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-${v(5)}pt}}

% Records where the final line of content landed, so the fit checker can say
% "over by three lines" instead of only "two pages".
\\AtEndDocument{\\zsavepos{rmmend}}

% Baseline leading, written to the log so overflow can be reported in lines
% rather than in points.
\\AtBeginDocument{\\typeout{RMM-BASELINESKIP: \\the\\baselineskip}}
`;
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

/** Full .tex source for a resolved resume. */
export function renderLatex(r: ResolvedResume): string {
  const sections = r.sections.map(section).filter(Boolean).join('\n\n');
  return `${preamble(r.layout)}
\\begin{document}
\\zsavepos{rmmstart}

${header(r)}

${sections}

\\end{document}
`;
}
