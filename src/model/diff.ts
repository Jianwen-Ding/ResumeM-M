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
    }
  }

  for (const bullet of b) {
    if (!aMap.has(bullet.id)) {
      out.push({ kind: 'removed', where, from: plain(bullet.text), text: `${where}: dropped "${clip(bullet.text)}"` });
    }
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
    if (gone.length) out.push({ kind: 'removed', where: name, text: `${name}: dropped ${gone.join(', ')}` });
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

  // Order within a section is part of the document too, but only worth
  // mentioning when nothing else about the entry changed.
  const bOrder = [...bEntries.keys()].filter((id) => aEntries.has(id));
  const aOrder = [...aEntries.keys()].filter((id) => bEntries.has(id));
  if (out.length === 0 && bOrder.join() !== aOrder.join()) {
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
