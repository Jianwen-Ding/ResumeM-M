import { describe, expect, it } from 'vitest';
import { compileResume } from '../src/render/compile.js';
import { inlineTex, renderLatex, unrenderableReason, unsupportedCharacters } from '../src/render/latex.js';
import { DEFAULT_LAYOUT, type ResolvedResume } from '../src/model/types.js';

/*
 * Two ways a resume full of perfectly ordinary text failed to produce a PDF.
 *
 * Both were silent in the sense that matters: the user had written nothing
 * unusual, and what came back was either a LaTeX error about a character they
 * never typed, or no explanation of which of their words caused it.
 */

function resume(over: Partial<ResolvedResume> = {}): ResolvedResume {
  return {
    id: 'r',
    label: 'R',
    profile: { name: 'Test Person', email: 'a@b.com' },
    sections: [
      {
        kind: 'experience',
        heading: 'Experience',
        entries: [
          {
            id: 'e',
            kind: 'experience',
            title: 'Engineer',
            subtitle: 'Acme',
            dates: '2024',
            location: 'Boston',
            bullets: [{ id: 'b', text: 'Did the work.' }],
          },
        ],
        skillGroups: [],
      },
    ],
    layout: { ...DEFAULT_LAYOUT },
    ...over,
  } as ResolvedResume;
}

describe('markup that contains other markup', () => {
  /*
   * The four chained passes this replaced hid each result behind a placeholder,
   * and the final restore was a single pass that did not look inside what it
   * substituted. A code span holding a bold span therefore reached the .tex
   * with the placeholder still in it — literal NUL bytes, which TeX rejects as
   * an invalid character. One bullet mentioning a command and a number cost the
   * whole PDF.
   */
  it('never emits a control character, whatever the markup nesting', () => {
    for (const s of [
      'ran `npm test **twice**` today',
      '**bold with `code` inside**',
      'see [**the docs**](https://x.com)',
      '*italic with `code`*',
      '`**`',
      '**`**`**',
      '[`code label`](https://x.com/a_b)',
    ]) {
      // eslint-disable-next-line no-control-regex
      expect(inlineTex(s), s).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    }
  });

  it('renders the inner markup rather than printing its asterisks', () => {
    expect(inlineTex('**bold with `code`**')).toBe('\\textbf{bold with \\texttt{code}}');
    expect(inlineTex('see [**the docs**](https://x.com)')).toBe(
      'see \\href{https://x.com}{\\underline{\\textbf{the docs}}}',
    );
  });

  it('treats a code span as literal, as markdown does everywhere else', () => {
    // The asterisks are part of the command being quoted, not emphasis.
    expect(inlineTex('ran `npm test **twice**` today')).toBe('ran \\texttt{npm test **twice**} today');
  });

  it('still handles the plain cases it always did', () => {
    expect(inlineTex('cut latency by **80%**')).toBe('cut latency by \\textbf{80\\%}');
    expect(inlineTex('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});

describe('characters the engine cannot set', () => {
  it('accepts the accents and punctuation people actually write', () => {
    const fine = 'Zoë Ørsted — “quoted”, ½ of €5 … résumé naïve Łukasz Dvořák • → ™';
    expect(unsupportedCharacters(fine)).toEqual([]);
    expect(unrenderableReason(fine)).toBeUndefined();
  });

  it('names a character it cannot set, once, with where it is', () => {
    const bad = unsupportedCharacters('Hello 张 world 张 again');
    expect(bad).toHaveLength(1);
    expect(bad[0]?.codePoint).toBe('U+5F20');
    expect(bad[0]?.context).toContain('Hello');
  });

  it('reports the scripts LaTeX has no fonts for here', () => {
    for (const [text, point] of [
      ['张伟', 'U+5F20'],
      ['Дмитрий', 'U+0414'],
      ['Ωμέγα', 'U+03A9'],
      ['محمد', 'U+0645'],
      ['שלום', 'U+05E9'],
      ['ship it 🚀', 'U+1F680'],
    ] as const) {
      const reason = unrenderableReason(text);
      expect(reason, text).toBeTruthy();
      expect(reason, text).toContain(point);
    }
  });

  /*
   * The supported set was measured against this engine rather than assumed, so
   * this test measures it again: every character the checker passes is put
   * through a real compile. If a future edit widens the set past what the fonts
   * hold, the PDF stops being produced and this fails — which is the whole
   * point of having the checker at all.
   */
  it('can really typeset everything it says it can', async () => {
    const sample =
      'Zoë Ørsted Łukasz Dvořák Ægir Þór ﬀ ĳ — – “x” ‘y’ … € ™ → • † ‡ ° ± µ ¼ ½ ¾ × ÷ § ¶';
    expect(unsupportedCharacters(sample)).toEqual([]);

    const r = resume({ profile: { name: sample, email: 'a@b.com' } });
    const out = await compileResume(r, { maxAttempts: 1 });
    expect(out.pdfPath ?? out.tex).toBeTruthy();
    expect(out.pages).toBeGreaterThan(0);
  }, 60_000);

  it('refuses before the fit loop, naming the character instead of the engine', async () => {
    const r = resume({ profile: { name: '张伟', email: 'a@b.com' } });
    // Without the check this is eight identical pdflatex failures and a message
    // about "Unicode character 张 (U+5F20) not set up for use with LaTeX".
    await expect(compileResume(r, { maxAttempts: 8 })).rejects.toThrow(/U\+5F20/);
    await expect(compileResume(r, { maxAttempts: 8 })).rejects.toThrow(/Chinese/);
  }, 30_000);

  it('does not trip on the .tex the renderer writes for an ordinary resume', () => {
    expect(unrenderableReason(renderLatex(resume()))).toBeUndefined();
  });

  /*
   * And a blank line in a field that is one line, which is a real compile
   * rather than a string check because the failure is the engine's.
   *
   * `\par` inside a `tabular*` cell is fatal: "Paragraph ended before
   * \text@command was complete", which names no field and nothing to do. It
   * took the whole save with it — the Master document compiles every entry,
   * so one blank line in one title stopped every resume rendering, including
   * ones that do not list the entry.
   */
  it('typesets an employer name somebody pasted with a blank line in it', async () => {
    const r = resume({
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
              subtitle: 'Engineer\n\nII',
              location: 'Boston\n\nMA',
              dates: '2024',
              bullets: [{ id: 'b', variantId: 'v', text: 'Did the work.' }],
            },
          ],
        },
      ],
    });

    const out = await compileResume(r, { maxAttempts: 1 });
    expect(out.pages).toBeGreaterThan(0);
  }, 60_000);
});
