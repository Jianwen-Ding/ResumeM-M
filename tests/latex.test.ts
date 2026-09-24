import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inlineTex, renderLatex, tex, texHref } from '../src/render/latex.js';
import { compileResume } from '../src/render/compile.js';
import { DEFAULT_LAYOUT, type ResolvedResume } from '../src/model/types.js';
import { hasLatex } from './helpers.js';

describe('escaping', () => {
  it('escapes the characters that would otherwise be LaTeX syntax', () => {
    expect(tex('50% of R&D costs $5 #1 a_b {c}')).toBe(
      '50\\% of R\\&D costs \\$5 \\#1 a\\_b \\{c\\}',
    );
  });

  it('escapes a backslash without eating the rest of the line', () => {
    expect(tex('a\\b & c')).toBe('a\\textbackslash{}b \\& c');
  });

  it('handles tilde and caret', () => {
    expect(tex('~10^3')).toBe('\\textasciitilde{}10\\textasciicircum{}3');
  });

  it('coerces non-strings, since YAML turns bare dates into numbers', () => {
    expect(tex(2026 as unknown as string)).toBe('2026');
    expect(inlineTex(undefined as unknown as string)).toBe('');
  });
});

describe('inline markup', () => {
  it('turns **bold** into \\textbf', () => {
    expect(inlineTex('cut latency by **80%**')).toBe('cut latency by \\textbf{80\\%}');
  });

  it('turns `code` into \\texttt', () => {
    expect(inlineTex('wired a `pytest` suite')).toBe('wired a \\texttt{pytest} suite');
  });

  it('turns *italic* into \\textit', () => {
    expect(inlineTex('an *emphasis* here')).toBe('an \\textit{emphasis} here');
  });

  /*
   * The one markdown spelling nobody checks after typing, because in every
   * editor that renders it, it looks right. Alternation is left to right, so
   * with `**` ahead of it this matched the bold rule — two asterisks off the
   * front, the third left inside the span and the last one outside it:
   * `\textbf{*both}*`, which prints `*critical` in bold followed by a stray
   * asterisk, on a resume.
   */
  it('turns ***both*** into bold italics, not bold with asterisks in it', () => {
    expect(inlineTex('***critical***')).toBe('\\textbf{\\textit{critical}}');
    expect(inlineTex('***a*** and **b** and *c*')).toBe(
      '\\textbf{\\textit{a}} and \\textbf{b} and \\textit{c}',
    );
  });

  it('escapes inside markup rather than trusting it', () => {
    expect(inlineTex('**100% done**')).toBe('\\textbf{100\\% done}');
  });

  it('leaves a lone asterisk alone', () => {
    expect(inlineTex('2 * 3 = 6')).toBe('2 * 3 = 6');
  });

  /*
   * And leaves *two* alone, which is the case that actually reached a PDF.
   * One asterisk could not match a rule that needs a pair; two of them on a
   * line with a space before the first and after the second became one span,
   * and `[^*]+` took the whole clause between them. Both markers vanish from
   * the document and half the bullet comes out in italics — and `SELECT *`
   * printed as `SELECT` is a different claim about the work than the one
   * that was typed.
   */
  it('leaves two asterisks alone when neither is against a word', () => {
    expect(inlineTex('Rewrote SELECT * queries and DELETE * statements')).toBe(
      'Rewrote SELECT * queries and DELETE * statements',
    );
    expect(inlineTex('Cleaned up *.log and *.tmp files')).toBe('Cleaned up *.log and *.tmp files');
    // A markdown list pasted into a single line.
    expect(inlineTex('* Led the team * Shipped the thing')).toBe('* Led the team * Shipped the thing');
  });

  /*
   * The same globs, in brackets. The non-space rule above saw nothing wrong
   * with these: `(` is not a space, so it was a legal place for a span to
   * close, and `.` was a legal place for one to open. Measured before the
   * fix — `Wrote cleanup jobs for (\textit{.log) and (}.tmp) archives` — which
   * prints as "(.log) and (.tmp)", with the clause between them in italics and
   * the patterns no longer saying what the work was.
   */
  it('leaves two asterisks alone when they are bracketed globs', () => {
    expect(inlineTex('Wrote cleanup jobs for (*.log) and (*.tmp) archives')).toBe(
      'Wrote cleanup jobs for (*.log) and (*.tmp) archives',
    );
    expect(inlineTex('Supports globs (*) and wildcards (*)')).toBe('Supports globs (*) and wildcards (*)');
    expect(inlineTex('Matched [*.yml] and [*.yaml]')).toBe('Matched [*.yml] and [*.yaml]');
  });

  /*
   * And still emphasises inside brackets, which is the thing that rule must
   * not cost: it opens on a letter and closes on a letter either way.
   */
  it('still emphasises a word inside brackets or quotes', () => {
    expect(inlineTex('A (*really*) good idea')).toBe('A (\\textit{really}) good idea');
    expect(inlineTex('He said "*never*" to that')).toBe('He said "\\textit{never}" to that');
  });

  /*
   * Italics used to have to end on whitespace or one of `).,;:` — so
   * `*pre*-launch` printed its asterisks while `**pre**-launch` did not, and
   * the README promises `*italic*` in any text field with no such footnote.
   */
  it('closes italics on the punctuation people actually write', () => {
    expect(inlineTex('Ranked top 5 *nationally*!')).toBe('Ranked top 5 \\textit{nationally}!');
    expect(inlineTex('*pre*-launch QA')).toBe('\\textit{pre}-launch QA');
    expect(inlineTex('Why *this*?')).toBe('Why \\textit{this}?');
    // As bold already did, which is what made the difference visible.
    expect(inlineTex('**pre**-launch QA')).toBe('\\textbf{pre}-launch QA');
  });

  it('does the same for a pair of double asterisks', () => {
    expect(inlineTex('Globbed ** across the tree and ** again later')).toBe(
      'Globbed ** across the tree and ** again later',
    );
  });

  /*
   * A URL that stopped at its first `)` produced an \href to a truncated
   * address — a 404 in the file an employer opens — and printed the leftover
   * `)` after the link text. Wikipedia, Jira and Confluence all mint these.
   */
  it('keeps a link target that has parentheses in it', () => {
    expect(inlineTex('See [the wiki](https://en.wikipedia.org/wiki/Foo_(bar)) for detail')).toBe(
      'See \\href{https://en.wikipedia.org/wiki/Foo_(bar)}{\\underline{the wiki}} for detail',
    );
  });

  it('renders a markdown link as \\href', () => {
    expect(inlineTex('[my site](https://example.com)')).toContain('\\href{https://example.com}');
  });
});

/*
 * A link target is read by TeX before hyperref sees it, so the characters that
 * matter there are not the ones `tex()` handles. One brace or backslash in the
 * email or the GitHub field — a paste that picked up a stray character — took
 * out every resume and every cover letter at once, with a LaTeX error that
 * named nothing the person who pasted it could act on.
 */
describe('a link target', () => {
  it('leaves an ordinary URL exactly as it is', () => {
    expect(texHref('https://github.com/someone/a_project')).toBe('https://github.com/someone/a_project');
  });

  /*
   * `&` escaped as well. hyperref takes `\&` as a plain ampersand in the
   * target, and a bare one is an alignment tab wherever the link has already
   * been read as a macro argument — which an entry title always has, inside
   * `\resumeSubheading`'s table. One query string in a linked title and no
   * PDF was produced at all: "Argument of \href@split has an extra }".
   */
  it('keeps a fragment and a query working', () => {
    expect(texHref('https://x.example/p?a=1&b=2#top')).toBe('https://x.example/p?a=1\\&b=2\\#top');
  });

  it('percent-encodes the three characters TeX reads first', () => {
    expect(texHref('https://x.example/a{b}c\\d')).toBe('https://x.example/a\\%7Bb\\%7Dc\\%5Cd');
  });

  it('does not double-encode a URL that already carries an escape', () => {
    // `\%20` is how hyperref is told to put one literal `%` in the target.
    expect(texHref('https://x.example/a%20b')).toBe('https://x.example/a\\%20b');
  });

  it('handles an address someone mistyped, rather than refusing to build', () => {
    expect(texHref('a{b@c.example')).toBe('a\\%7Bb@c.example');
  });
});

function resume(overrides: Partial<ResolvedResume> = {}): ResolvedResume {
  return {
    id: 'r',
    label: 'R',
    profile: { name: 'Test Person', email: 'a@b.com', github: 'github.com/x' },
    sections: [
      {
        kind: 'experience',
        heading: 'Experience',
        skillGroups: [],
        entries: [
          {
            id: 'e',
            kind: 'experience',
            title: 'Acme & Co.',
            dates: 'Jul. 2024 -- Dec. 2024',
            subtitle: 'Engineer',
            location: 'Boston, MA',
            bullets: [{ id: 'b', variantId: 'v', text: 'Shipped **2M** events/day' }],
          },
        ],
      },
    ],
    layout: DEFAULT_LAYOUT,
    warnings: [],
    ...overrides,
  };
}

describe('document generation', () => {
  it('produces a complete document', () => {
    const out = renderLatex(resume());
    expect(out).toContain('\\begin{document}');
    expect(out).toContain('\\end{document}');
  });

  it('escapes entry titles', () => {
    expect(renderLatex(resume())).toContain('Acme \\& Co.');
  });

  /*
   * A blank line in a field that is one line is `\par`, and `\par` inside a
   * `tabular*` cell or a `\textbf{…}` argument is fatal: "Paragraph ended
   * before \text@command was complete", a message that names no field and
   * nothing to do. It takes the whole save with it, too — the Master document
   * compiles every entry, so one blank line pasted into one title stopped
   * every resume from rendering, including ones that do not list the entry.
   *
   * Reachable by pasting multi-line text into the inline editor, by
   * hand-editing the YAML, and through `PUT /api/entries/:id`, which
   * validates nothing.
   */
  it('keeps a field that is one line on one line, however it was typed', () => {
    const out = renderLatex(
      resume({
        sections: [
          {
            kind: 'experience',
            heading: 'Experience',
            skillGroups: [],
            entries: [
              {
                id: 'e',
                kind: 'experience',
                title: 'Acme\n\nCorp',
                dates: '2024\n2025',
                subtitle: 'Engineer\n\nII',
                location: 'Boston\n\nMA',
                bullets: [],
              },
            ],
          },
          {
            kind: 'skills',
            heading: 'Skills',
            entries: [],
            skillGroups: [{ id: 'g', name: 'Languages\n\nand tools', items: ['Go', 'Rust'] }],
          },
        ],
      }),
    );

    // Nothing that reaches the engine as a paragraph break.
    const inArguments = out.slice(out.indexOf('\\begin{document}'));
    expect(inArguments).not.toMatch(/\{[^{}]*\n\s*\n[^{}]*\}/);
    expect(out).toContain('Acme Corp');
    expect(out).toContain('Engineer II');
    expect(out).toContain('Boston MA');
    expect(out).toContain('Languages and tools');
  });

  it('records positions so the fit checker can measure typeset height', () => {
    const out = renderLatex(resume());
    expect(out).toContain('\\zsavepos{rmmstart}');
    expect(out).toContain('\\zsavepos{rmmend}');
  });

  it('keeps the leading at or above the font size, which KOMA requires', () => {
    // A baselineskip below the type size makes \changefontsizes fail outright.
    const tight = resume({ layout: { ...DEFAULT_LAYOUT, fontSizePt: 9.2, spacing: 0.78 } });
    const m = /\\changefontsizes\[([\d.]+)pt\]\{([\d.]+)pt\}/.exec(renderLatex(tight));
    expect(m).toBeTruthy();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(Number(m?.[2]));
  });

  it('uses the project heading form for projects', () => {
    const out = renderLatex(
      resume({
        sections: [
          {
            kind: 'project',
            heading: 'Projects',
            skillGroups: [],
            entries: [
              { id: 'p', kind: 'project', title: 'Thing', subtitle: 'Go, Redis', dates: '2026', bullets: [] },
            ],
          },
        ],
      }),
    );
    expect(out).toContain('\\resumeProjectHeading');
  });

  /*
   * The form offers a project a Location, the entry list shows it, and it is
   * written to `projects.yaml` — and the project branch of `section()` had no
   * cell for it, so it was resolved, carried into `ResolvedEntry`, and then
   * dropped with no warning. Every other kind prints it.
   */
  it('prints a project’s location, which used to be dropped', () => {
    const withLocation = (dates?: string) =>
      renderLatex(
        resume({
          sections: [
            {
              kind: 'project',
              heading: 'Projects',
              skillGroups: [],
              entries: [
                { id: 'p', kind: 'project', title: 'Thing', subtitle: 'Go, Redis', dates, location: 'Boston, MA', bullets: [] },
              ],
            },
          ],
        }),
      );

    expect(withLocation('2026')).toContain('{2026 $|$ Boston, MA}');
    // And with no dates it is the whole of the right-hand cell, rather than
    // sitting behind a stray separator.
    expect(withLocation()).toContain('{Boston, MA}');
  });

  it('omits a section that resolved to nothing rather than printing an empty heading', () => {
    const out = renderLatex(
      resume({ sections: [{ kind: 'experience', heading: 'Experience', skillGroups: [], entries: [] }] }),
    );
    expect(out).not.toContain('\\section{Experience}');
  });
});

describe.runIf(await hasLatex())('a link with a query string, compiled', () => {
  it('builds with one in an entry title and one in a bullet', async () => {
    const r = resume();
    const entry = r.sections[0]!.entries[0]!;
    entry.title = '[Acme](https://acme.example/jobs?team=infra&level=2)';
    entry.bullets[0]!.text = 'Wrote [the post](https://blog.example/?a=1&b=2) about it';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-href-'));
    try {
      const pdfPath = path.join(dir, 'out.pdf');
      await compileResume(r, { pdfPath });
      expect(fs.existsSync(pdfPath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
