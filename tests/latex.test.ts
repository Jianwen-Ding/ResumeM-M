import { describe, expect, it } from 'vitest';
import { inlineTex, renderLatex, tex } from '../src/render/latex.js';
import { DEFAULT_LAYOUT, type ResolvedResume } from '../src/model/types.js';

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

  it('escapes inside markup rather than trusting it', () => {
    expect(inlineTex('**100% done**')).toBe('\\textbf{100\\% done}');
  });

  it('leaves a lone asterisk alone', () => {
    expect(inlineTex('2 * 3 = 6')).toBe('2 * 3 = 6');
  });

  it('renders a markdown link as \\href', () => {
    expect(inlineTex('[my site](https://example.com)')).toContain('\\href{https://example.com}');
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

  it('omits a section that resolved to nothing rather than printing an empty heading', () => {
    const out = renderLatex(
      resume({ sections: [{ kind: 'experience', heading: 'Experience', skillGroups: [], entries: [] }] }),
    );
    expect(out).not.toContain('\\section{Experience}');
  });
});
