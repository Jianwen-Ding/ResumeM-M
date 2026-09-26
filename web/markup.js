/*
 * The store's inline markup, read by the editor the way the PDF reads it.
 *
 * The editor had its own, older rule: `\*\*(.+?)\*\*`, backticks, and an
 * asterisk italic with a shorter list of places it could end. It never learnt
 * `_italic_` when the renderer did, so "I am _really_ keen" was in italics in
 * the PDF and printed its underscores on screen; and it still read `*.log`
 * and `(*)` the way the renderer stopped reading them. Two rules for one
 * markup is two answers to what a line says.
 *
 * The two halves cannot share a module — one is TypeScript compiled for node,
 * the other a script the browser loads directly — so `MARKUP` below is a copy
 * of the one in src/render/latex.ts, alternatives in the same order and
 * groups in the same places, and `tests/markup-agreement.test.js` fails the
 * moment the two differ, in source or in what they make of a line.
 */
export const MARKUP =
  /\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)|\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*|\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<=^|[\s([{'"])\*(?=[^\s*.,;:!?)\]}])([^*]+)(?<=[^\s*([{])\*(?=[\s).,;:!?\]}'"-]|$)|(?<=^|[\s([{'"])_(?=[^\s_.,;:!?)\]}])([^_\n]+)(?<=[^\s_([{])_(?=[\s).,;:!?\]}'"-]|$)|`(.+?)`/g;

/** As deep as the renderer goes; see `MAX_NESTING` in src/render/latex.ts. */
const MAX_NESTING = 4;

/**
 * A line as a tree: plain strings, and `{ tag, children }` for `strong`, `em`
 * and `link` (which also carries its `url`), or `{ tag: 'code', text }` —
 * code is literal, as it is in the PDF.
 */
export function parseMarkup(input, depth = MAX_NESTING) {
  const s = String(input ?? '');
  if (depth <= 0) return s ? [s] : [];

  const re = new RegExp(MARKUP.source, 'g');
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const [whole, label, url, strongem, bold, starItalic, underItalic, code] = m;
    const italic = starItalic ?? underItalic;
    if (label !== undefined) out.push({ tag: 'link', url, children: parseMarkup(label, depth - 1) });
    else if (strongem !== undefined) {
      out.push({ tag: 'strong', children: [{ tag: 'em', children: parseMarkup(strongem, depth - 1) }] });
    } else if (bold !== undefined) out.push({ tag: 'strong', children: parseMarkup(bold, depth - 1) });
    else if (italic !== undefined) out.push({ tag: 'em', children: parseMarkup(italic, depth - 1) });
    else out.push({ tag: 'code', text: code });
    last = m.index + whole.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/*
 * A link is left as it was typed, brackets and address and all, which is how
 * the editor has always shown one: the address is part of what the line says,
 * and a label that could be clicked would be a trap in a line that is
 * double-clicked to edit. Only the label's own markup is read.
 */

/** The line with its markers taken off, for places that show plain words. */
export function plainMarkup(input) {
  const flat = (parts) =>
    parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p.tag === 'code') return p.text;
        if (p.tag === 'link') return `[${flat(p.children)}](${p.url})`;
        return flat(p.children);
      })
      .join('');
  return flat(parseMarkup(input));
}

/** The line as nodes: `<strong>`, `<em>`, and a `.mono` span for code. */
export function markupFragment(input, doc = document) {
  const build = (parts, into) => {
    for (const p of parts) {
      if (typeof p === 'string') into.append(p);
      else if (p.tag === 'code') {
        const span = doc.createElement('span');
        span.className = 'mono';
        span.textContent = p.text;
        into.append(span);
      } else if (p.tag === 'link') {
        into.append('[');
        build(p.children, into);
        into.append(`](${p.url})`);
      } else {
        const node = doc.createElement(p.tag);
        build(p.children, node);
        into.append(node);
      }
    }
    return into;
  };
  return build(parseMarkup(input), doc.createDocumentFragment());
}
