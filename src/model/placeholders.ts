/**
 * The template slots a draft was meant to have filled in: "[Your Name]",
 * "[Company Name]", "<Company>", "{company}", "{{role}}", "XX years", "TODO".
 *
 * One detector for everywhere a letter or an answer is looked at — the
 * writing tools that refuse a draft carrying one, the routes that hand a
 * model's draft back without the tools, and the letter build that warns about
 * one in the PDF. A letter printed with "[Hiring Manager]" in it is a template
 * somebody plainly did not finish, and nothing said so: it compiled, it was
 * offered as the draft, and it was attached.
 *
 * Deliberately not every bracket. `<name@example.com>` is a real way to write
 * an address, `[1]` is a footnote, `[sic]` is an editor's mark, `[STL]` is an
 * acronym and `[the docs](https://…)` is a link — so a match needs a letter,
 * has to stay on one line, and has to be short: this is looking for a word or
 * two in a slot, not for punctuation. A square-bracketed one must also read
 * as a slot: in Title Case, as "[Company Name]" is, or naming the kind of
 * thing that goes there, as "[company]" and "[insert metric]" do.
 *
 * And deliberately not code. A slot sits where a *word* would sit, so
 * something else always comes first: a space, a newline, the start of the
 * text, an opening quote. An index or a type parameter is glued to the name
 * it belongs to — the `[` of `buffer[i]` follows `r`, and the `<` of
 * `List<String>` follows `t` — and answers about engineering are made of
 * those.
 */

const NOT_GLUED = String.raw`(?<![\w)\]])`;

/** What a slot is for, as a template names it. */
const SLOT_WORD =
  /\b(name|company|employer|organi[sz]ation|position|role|title|job|manager|hiring|recruiter|contact|date|address|city|phone|email|insert|your|product|industry|field|skill|school|university|degree|number|amount|metric|years?|X+)\b/i;

/** Title Case: every word capitalised, and not an all-capitals acronym. */
function titleCase(inside: string): boolean {
  const words = inside.trim().split(/\s+/);
  return words.every((w) => /^[A-Z]/.test(w)) && /[a-z]/.test(inside);
}

/** Tags a person might leave in text they pasted, which are not slots. */
const HTML_TAG = /^<\/?(a|b|i|u|p|em|strong|br|hr|div|span|li|ul|ol|sup|sub)>$/i;

const RULES: { re: RegExp; keep?: (found: RegExpExecArray) => boolean }[] = [
  {
    // Not followed by `(`: that is a markdown link's text, not a slot.
    re: new RegExp(String.raw`${NOT_GLUED}\[([^\]\n]{1,80})\](?!\()`, 'g'),
    keep: (m) => {
      const inside = m[1]!;
      if (!/[A-Za-z]/.test(inside)) return false;
      return SLOT_WORD.test(inside) || titleCase(inside);
    },
  },
  {
    re: new RegExp(String.raw`${NOT_GLUED}<[A-Za-z][A-Za-z ._'-]{0,40}>`, 'g'),
    keep: (m) => !HTML_TAG.test(m[0]),
  },
  { re: /\{\{[^}\n]{0,60}\}\}/g },
  // `{company}`, with nothing glued in front: not `\textbf{…}`, not `${x}`.
  { re: new RegExp(String.raw`(?<![\w)\]{}$\\])\{[A-Za-z][A-Za-z ._'-]{0,40}\}(?!\})`, 'g') },
  // "XX years", "X+ years", "XX%": a number the writer meant to look up.
  { re: /(?<![\w$])(?:X{1,3}|x{2,3})\+?\s*(?:%|(?:percent|years?|yrs|months?)\b)/g },
  { re: /\bTODO\b/g },
];

/**
 * Every placeholder in some text, each once, in the order they appear.
 * Empty means nothing in it looks like a slot left to fill.
 */
export function placeholdersIn(text: string): string[] {
  const s = String(text ?? '');
  const found: { at: number; what: string }[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (!rule.keep || rule.keep(m)) found.push({ at: m.index, what: m[0].trim() });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.what))];
}

/** The first placeholder in some text, or '' when there is none. */
export function placeholderIn(text: string): string {
  return placeholdersIn(text)[0] ?? '';
}

/** The placeholders named for a person, as `"[Your Name]", "[Company Name]"`. */
export function namePlaceholders(found: string[], most = 12): string {
  const shown = found.slice(0, most).map((p) => `"${p}"`).join(', ');
  return found.length > most ? `${shown} and ${found.length - most} more` : shown;
}
