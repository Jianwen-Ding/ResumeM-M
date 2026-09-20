/**
 * Deleting something takes it out of every resume that was using it.
 *
 * A resume is a set of choices over the store — entry ids, line ids, wording
 * ids, skill ids — and nothing about deleting the thing those ids point at
 * used to touch the resumes pointing at it. `resolveResume` noticed, warned,
 * and carried on: "Section experience lists entry exp_acme, which does not
 * exist", one warning per resume per delete, forever. The intent was that
 * nothing be lost silently, and that part worked. What it left behind is a
 * save where removing one line from the master document adds a permanent
 * complaint to the eleven resumes that had chosen it, none of which can be
 * cleared from anywhere in the app: the id is in the YAML, the thing it names
 * is gone, and the only way back is opening the files by hand.
 *
 * So a delete now reaches the resumes as well. The pass is driven off what
 * the store *has* rather than off a list of what was removed, which means it
 * cannot miss a path — an entry deleted, a line dropped from an entry, the
 * last alternate of a wording removed, a skill taken out of a group — and it
 * cannot disagree with `resolveResume` about what is dangling, because both
 * ask the same question of the same data.
 *
 * Two things it deliberately does not do.
 *
 * It never removes a *selection* that still resolves. A resume listing lines
 * [b1] out of an entry's [b1, b2, b3] is saying "show the first and not the
 * other two"; deleting b1 leaves it saying "show none of them", which is an
 * empty list and not an absent one. Absent means "show all", and turning
 * "none" into "all" would put two lines somebody had switched off onto a
 * document they may be about to send.
 *
 * And it never touches `profile.name`. The profile is not an entry and not a
 * skill, and a name pinned on a resume is not this pass's business.
 */

import { isVariantField, type Entry, type ResumeSpec, type SectionSpec, type SkillGroup } from './types.js';

/** The fields of an entry that can carry alternates, in `choices` key order. */
const FIELDS = ['title', 'dates', 'subtitle', 'location'] as const;

/**
 * Every id the store still holds, in the shapes a resume refers to them by.
 *
 * Built once per delete and asked many times, because the alternative is a
 * linear scan of the whole store per reference per resume — and a save with a
 * year of applying in it has a few hundred resumes.
 */
export interface LiveIds {
  /** Entry ids. */
  entries: Set<string>;
  /** Line ids, per entry, for `sections[].bullets`. */
  bullets: Map<string, Set<string>>;
  /** Every line id in the store, whichever entry carries it. */
  lines: Set<string>;
  /**
   * Wording ids, keyed the way `choices` keys them: `entryId.field` for a
   * field, the bare line id for a line.
   */
  wordings: Map<string, Set<string>>;
  /** Item ids of list lines — relevant coursework, awards — for `lists`. */
  listItems: Map<string, Set<string>>;
  /** Skills group ids, and the item ids each still holds. */
  groups: Map<string, Set<string>>;
}

/**
 * Index the store.
 *
 * Takes the entries and groups rather than reading them, so the caller can
 * hand over the list it just wrote instead of hoping a cache keyed on size
 * and modification time noticed a write that happened a moment ago.
 */
export function liveIds(entries: Entry[], groups: SkillGroup[]): LiveIds {
  const live: LiveIds = {
    entries: new Set(),
    bullets: new Map(),
    lines: new Set(),
    wordings: new Map(),
    listItems: new Map(),
    groups: new Map(),
  };

  for (const entry of entries) {
    if (!entry?.id) continue;
    live.entries.add(entry.id);

    for (const field of FIELDS) {
      const value = entry[field];
      if (isVariantField(value)) {
        live.wordings.set(`${entry.id}.${field}`, new Set(value.variants.map((v) => v.id)));
      }
    }

    const ids = new Set<string>();
    for (const bullet of entry.bullets ?? []) {
      if (!bullet?.id) continue;
      ids.add(bullet.id);
      live.lines.add(bullet.id);

      /*
       * Unioned, not replaced.
       *
       * A line id is supposed to belong to one line, and everything that
       * mints one has kept them unique for a while now — but a save written
       * before that can carry the same id on two entries, and `resolveResume`
       * says so rather than pretending otherwise. A chosen wording is filed
       * under the bare id with no entry beside it, so it resolves against
       * whichever of the two the resolver reaches first. Pruning on one
       * entry's alternates alone would throw away a choice the other entry
       * can still honour.
       */
      const known = live.wordings.get(bullet.id) ?? new Set<string>();
      for (const variant of bullet.variants ?? []) known.add(variant.id);
      live.wordings.set(bullet.id, known);

      if (bullet.items) {
        const items = live.listItems.get(bullet.id) ?? new Set<string>();
        for (const item of bullet.items) items.add(item.id);
        live.listItems.set(bullet.id, items);
      }
    }
    live.bullets.set(entry.id, ids);
  }

  for (const group of groups) {
    if (!group?.id) continue;
    const items = live.groups.get(group.id) ?? new Set<string>();
    for (const item of group.items ?? []) items.add(item.id);
    live.groups.set(group.id, items);
  }

  return live;
}

/**
 * The same resume with every reference to something the store no longer holds
 * taken out.
 *
 * Pure, and returns a new object whether or not anything changed — the caller
 * compares and writes only where it did, so a save full of resumes that
 * reference nothing missing produces no commits.
 */
export function forgetMissing(spec: ResumeSpec, live: LiveIds): ResumeSpec {
  const next: ResumeSpec = { ...spec };

  if (Array.isArray(spec.sections)) next.sections = spec.sections.map((s) => pruneSection(s, live));
  if (spec.choices) next.choices = pruneChoices(spec.choices, live);
  if (spec.lists) next.lists = pruneLists(spec.lists, live);
  if (Array.isArray(spec.collapsed)) next.collapsed = spec.collapsed.filter((id) => live.entries.has(id));

  return next;
}

function pruneSection(section: SectionSpec, live: LiveIds): SectionSpec {
  const next: SectionSpec = { ...section };

  if (Array.isArray(section.entries)) next.entries = section.entries.filter((id) => live.entries.has(id));

  if (section.bullets) {
    next.bullets = {};
    for (const [entryId, ids] of Object.entries(section.bullets)) {
      const lines = live.bullets.get(entryId);
      // The entry itself is gone, so a list of which of its lines to show is
      // not a selection any more, it is litter.
      if (!lines) continue;
      next.bullets[entryId] = Array.isArray(ids) ? ids.filter((id) => lines.has(id)) : ids;
    }
  }

  /*
   * `bulletOrder` says "this resume arranged these lines itself", which is
   * only meaningful while the entry exists. Kept whole for an entry that
   * does: dropping a line from an entry does not undo the dragging somebody
   * did to the ones that are left.
   */
  if (section.bulletOrder) {
    next.bulletOrder = {};
    for (const [entryId, mode] of Object.entries(section.bulletOrder)) {
      if (live.entries.has(entryId)) next.bulletOrder[entryId] = mode;
    }
  }

  if (Array.isArray(section.groups)) next.groups = section.groups.filter((id) => live.groups.has(id));

  if (section.items) {
    next.items = {};
    for (const [groupId, ids] of Object.entries(section.items)) {
      const items = live.groups.get(groupId);
      if (!items) continue;
      next.items[groupId] = Array.isArray(ids) ? ids.filter((id) => items.has(id)) : ids;
    }
  }

  return next;
}

/**
 * A chosen wording survives exactly when it still resolves to something.
 *
 * Which is the same test `resolveResume` applies before it warns, deliberately
 * — "Choice X asked for variant Y, which does not exist" and "Choice X does
 * not match any field or bullet in the store" are the two complaints this
 * clears, and a pass that cleared a different set would leave one of them
 * standing with nothing able to remove it.
 */
function pruneChoices(choices: Record<string, string>, live: LiveIds): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, variantId] of Object.entries(choices)) {
    // Not an entry and not a skill. See the note at the top of the file.
    if (key === 'profile.name') {
      next[key] = variantId;
      continue;
    }
    if (live.wordings.get(key)?.has(variantId)) next[key] = variantId;
  }
  return next;
}

function pruneLists(lists: Record<string, string[]>, live: LiveIds): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [bulletId, ids] of Object.entries(lists)) {
    if (!live.lines.has(bulletId)) continue;
    const items = live.listItems.get(bulletId);
    /*
     * A line that is no longer a list keeps its item selection untouched.
     *
     * Nothing renders it while the line is a sentence, so it costs nothing to
     * keep — and a line that gets its items back, or was only ever saved
     * mid-edit without them, gets back the selection that went with them
     * rather than a blank one.
     */
    next[bulletId] = items && Array.isArray(ids) ? ids.filter((id) => items.has(id)) : ids;
  }
  return next;
}

/**
 * Whether the new version of an entry drops an id the old one had.
 *
 * The resume pass is cheap but not free, and an entry is saved on every
 * keystroke's worth of idle in the editor, on every ingest, and once per
 * alternate the AI drafts. Nearly all of those add or reword; this is the
 * question that separates them from the one write that needs a cascade.
 */
export function entryLosesIds(before: Entry, after: Entry): boolean {
  for (const field of FIELDS) {
    const was = before[field];
    if (!isVariantField(was)) continue;
    const now = after[field];
    const ids = new Set(isVariantField(now) ? now.variants.map((v) => v.id) : []);
    if (was.variants.some((v) => !ids.has(v.id))) return true;
  }

  const lines = new Map((after.bullets ?? []).map((b) => [b.id, b] as const));
  for (const bullet of before.bullets ?? []) {
    const now = lines.get(bullet.id);
    if (!now) return true;
    const wordings = new Set((now.variants ?? []).map((v) => v.id));
    if ((bullet.variants ?? []).some((v) => !wordings.has(v.id))) return true;
    if (bullet.items) {
      const items = new Set((now.items ?? []).map((i) => i.id));
      if (bullet.items.some((i) => !items.has(i.id))) return true;
    }
  }

  return false;
}

/** The same question for skills: does the new list drop a group or an item? */
export function skillsLoseIds(before: SkillGroup[], after: SkillGroup[]): boolean {
  const now = new Map(after.map((g) => [g.id, new Set((g.items ?? []).map((i) => i.id))] as const));
  for (const group of before) {
    const items = now.get(group.id);
    if (!items) return true;
    if ((group.items ?? []).some((i) => !items.has(i.id))) return true;
  }
  return false;
}
