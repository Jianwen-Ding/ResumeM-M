import { resolveProfile } from './resolve.js';
import type { ResolvedEntry, ResolvedResume, ResolvedSection } from './types.js';

/**
 * What changed between two versions of a resume, described as changes to the
 * document rather than to the files behind it.
 *
 * The distinction matters. "b_testing: hidden" and "edu_neu.dates: v_may2026 →
 * v_dec2026" describe edits to a YAML file; nobody reads their resume that
 * way. What a person wants from a version history is what the page said then
 * and what it says now — a bullet gone, a date moved, a sentence reworded —
 * which is a diff of the *resolved* resume, after every choice has been made
 * and every reference followed.
 */

export interface DocChange {
  /** Coarse grouping, used for colour in the UI. */
  kind: 'created' | 'added' | 'removed' | 'reworded' | 'changed' | 'moved' | 'none';
  /** One line, already in plain words. */
  text: string;
  /** Where it happened — an entry title, or a section heading. */
  where?: string;
  /** Full before/after for the two-column view. Long text is not truncated. */
  from?: string;
  to?: string;
}

const CLIP = 78;

/** Store markup is for the renderer; a history entry should read as prose. */
function plain(text: string): string {
  return String(text ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s*--\s*/g, ' – ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string, max = CLIP): string {
  const s = plain(text);
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

function entriesOf(r: ResolvedResume): Map<string, { entry: ResolvedEntry; section: ResolvedSection }> {
  const out = new Map<string, { entry: ResolvedEntry; section: ResolvedSection }>();
  for (const section of r.sections) {
    for (const entry of section.entries) out.set(entry.id, { entry, section });
  }
  return out;
}

function bulletCount(r: ResolvedResume): number {
  return r.sections.reduce((n, s) => n + s.entries.reduce((m, e) => m + e.bullets.length, 0), 0);
}

/** A sentence naming what a field is, for "dates changed" style lines. */
const FIELD_WORDS: Record<string, string> = {
  title: 'name',
  dates: 'dates',
  subtitle: 'role',
  location: 'location',
};

function diffEntryFields(before: ResolvedEntry, after: ResolvedEntry, out: DocChange[]): void {
  for (const field of ['title', 'dates', 'subtitle', 'location'] as const) {
    const b = plain(before[field] ?? '');
    const a = plain(after[field] ?? '');
    if (b === a) continue;
    const where = plain(after.title || before.title);
    out.push({
      kind: 'changed',
      where,
      from: b,
      to: a,
      text: !b
        ? `${where}: ${FIELD_WORDS[field]} set to "${clip(a, 44)}"`
        : !a
          ? `${where}: ${FIELD_WORDS[field]} removed`
          : `${where}: ${FIELD_WORDS[field]} ${clip(b, 34)} → ${clip(a, 34)}`,
    });
  }
}

function diffBullets(before: ResolvedEntry, after: ResolvedEntry, out: DocChange[]): void {
  const where = plain(after.title || before.title);
  const b = before.bullets;
  const a = after.bullets;

  const byId = (list: typeof a) => new Map(list.map((x) => [x.id, x]));
  const bMap = byId(b);
  const aMap = byId(a);

  for (const bullet of a) {
    const was = bMap.get(bullet.id);
    if (!was) {
      out.push({ kind: 'added', where, to: plain(bullet.text), text: `${where}: added "${clip(bullet.text)}"` });
      continue;
    }
    if (plain(was.text) !== plain(bullet.text)) {
      out.push({
        kind: 'reworded',
        where,
        from: plain(was.text),
        to: plain(bullet.text),
        text: `${where}: reworded — "${clip(was.text, 40)}" → "${clip(bullet.text, 40)}"`,
      });
    } else if (was.text !== bullet.text) {
      /*
       * Same words, different markup — and it used to be reported as nothing
       * at all.
       *
       * `plain` strips `**`, backticks, `*` and link syntax before comparing,
       * which is right for a history entry that should read as prose. But
       * `sameDocument` compares the raw text, so taking the bold off "handling
       * **2M events/day**" *did* create a version — one whose change list was
       * empty, so the card fell back to the raw commit message and read
       * `Update entry "exp_acme"`. A change that reaches the PDF has to have a
       * line of its own, even when the line is only about how it is set.
       */
      out.push({
        kind: 'changed',
        where,
        from: was.text,
        to: bullet.text,
        text: `${where}: same words, different formatting — "${clip(bullet.text, 40)}"`,
      });
    }
  }

  for (const bullet of b) {
    if (!aMap.has(bullet.id)) {
      out.push({ kind: 'removed', where, from: plain(bullet.text), text: `${where}: dropped "${clip(bullet.text)}"` });
    }
  }

  /*
   * And the order they print in, which was never compared at all.
   *
   * `diffBullets` keys on `bullet.id`, so swapping two bullets on an entry
   * matched every id and reported nothing — while `sameDocument` compares the
   * list in order and therefore made a version. An empty change list on a
   * version that exists is the shape this file's own doc warns about, and
   * reordering is one of the three things the AI is allowed to do.
   *
   * Only the ones both versions have: an added or dropped bullet moves
   * everything after it, and saying "reordered" about that is noise on top of
   * a line that already said what happened.
   */
  const bOrder = b.filter((x) => aMap.has(x.id)).map((x) => x.id);
  const aOrder = a.filter((x) => bMap.has(x.id)).map((x) => x.id);
  if (bOrder.join('\u0000') !== aOrder.join('\u0000')) {
    out.push({ kind: 'moved', where, text: `${where}: bullets reordered` });
  }
}

function skillsOf(r: ResolvedResume): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const section of r.sections) {
    for (const group of section.skillGroups) out.set(group.name, group.items);
  }
  return out;
}

function diffSkills(before: ResolvedResume, after: ResolvedResume, out: DocChange[]): void {
  const b = skillsOf(before);
  const a = skillsOf(after);
  for (const [name, items] of a) {
    const was = b.get(name);
    if (!was) {
      out.push({ kind: 'added', where: name, text: `Skills: added "${name}"` });
      continue;
    }
    const added = items.filter((i) => !was.includes(i));
    const gone = was.filter((i) => !items.includes(i));
    if (added.length) out.push({ kind: 'added', where: name, text: `${name}: added ${added.join(', ')}` });
    if (gone.length) {
      /*
       * What is left, not only what went.
       *
       * "Frameworks: dropped React, Node.js, PostgreSQL" is the half of the
       * change that cannot be judged: the line that will actually print is
       * the one that is kept, and naming only the cuts makes a proposal read
       * as destruction. It is also the question somebody looking at this is
       * asking — which version am I choosing — and the answer was not on
       * screen anywhere.
       */
      const keeping = items.length
        ? ` — keeping ${items.join(', ')}`
        : ', which is all of them, so the line will not print';
      out.push({ kind: 'removed', where: name, text: `${name}: dropped ${gone.join(', ')}${keeping}` });
    }
  }
  for (const [name] of b) {
    if (!a.has(name)) out.push({ kind: 'removed', where: name, text: `Skills: dropped "${name}"` });
  }
}

/**
 * The differences between two versions of the same resume, as a reader of the
 * PDF would describe them. `before` absent means this is the first version.
 */
export interface DiffOptions {
  /**
   * Skip the "renamed to" line. A tailored copy is always named after the
   * posting, so when diffing a base against a proposal that rename is an
   * artefact of the naming, not a change anyone made.
   */
  ignoreLabel?: boolean;
}

export function diffResumes(
  before: ResolvedResume | undefined,
  after: ResolvedResume,
  opts: DiffOptions = {},
): DocChange[] {
  if (!before) {
    return [
      {
        kind: 'created',
        text: `First version — ${after.sections.filter((s) => s.entries.length || s.skillGroups.length).length} sections, ${bulletCount(after)} bullet points`,
      },
    ];
  }

  const out: DocChange[] = [];

  if (before.label !== after.label && !opts.ignoreLabel) {
    out.push({ kind: 'changed', from: before.label, to: after.label, text: `Renamed to "${after.label}"` });
  }

  const bEntries = entriesOf(before);
  const aEntries = entriesOf(after);

  for (const [id, { entry, section }] of aEntries) {
    const was = bEntries.get(id);
    if (!was) {
      out.push({
        kind: 'added',
        where: plain(entry.title),
        to: plain(entry.title),
        text: `Added to ${section.heading}: ${plain(entry.title)}${entry.bullets.length ? ` (${entry.bullets.length} bullet${entry.bullets.length === 1 ? '' : 's'})` : ''}`,
      });
      continue;
    }
    diffEntryFields(was.entry, entry, out);
    diffBullets(was.entry, entry, out);
  }

  for (const [id, { entry, section }] of bEntries) {
    if (!aEntries.has(id)) {
      out.push({
        kind: 'removed',
        where: plain(entry.title),
        from: plain(entry.title),
        text: `Removed from ${section.heading}: ${plain(entry.title)}`,
      });
    }
  }

  diffSkills(before, after, out);

  /*
   * Order within a section is part of the document too.
   *
   * This was `out.length === 0 &&` — "only worth mentioning when nothing else
   * changed" — which was defensible while reordering was something a person
   * did on its own. The AI reorders now, in the same pass in which it turns
   * entries on and off, so the one combination the suppression hides is the
   * commonest one there is: every tailoring pass that moved an entry *and*
   * changed one reported only the change.
   */
  const bOrder = [...bEntries.keys()].filter((id) => aEntries.has(id));
  const aOrder = [...aEntries.keys()].filter((id) => bEntries.has(id));
  if (bOrder.join() !== aOrder.join()) {
    out.push({ kind: 'moved', text: 'Reordered' });
  }

  // As pinned, since that is the name the document shows. Switching which
  // alternate a resume uses is a choice, and shows up as one.
  const wasNamed = resolveProfile(before.profile, {}, []).name;
  const nowNamed = resolveProfile(after.profile, {}, []).name;
  if (wasNamed !== nowNamed) {
    out.push({ kind: 'changed', from: wasNamed, to: nowNamed, text: `Name changed to ${nowNamed}` });
  }

  return out;
}

/** True when two versions produce the same document, so one can be skipped. */
export function sameDocument(a: ResolvedResume, b: ResolvedResume): boolean {
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** Everything that reaches the page — deliberately excluding layout knobs. */
function strip(r: ResolvedResume) {
  return {
    label: r.label,
    profile: r.profile,
    sections: r.sections.map((s) => ({
      kind: s.kind,
      heading: s.heading,
      skillGroups: s.skillGroups,
      entries: s.entries.map((e) => ({
        id: e.id,
        title: e.title,
        dates: e.dates,
        subtitle: e.subtitle,
        location: e.location,
        bullets: e.bullets.map((b) => ({ id: b.id, text: b.text })),
      })),
    })),
  };
}
