/**
 * Deleting something takes it out of every resume that was using it — and
 * where the thing deleted was an *alternate*, moves the resume onto the
 * nearest alternate that is left rather than taking anything away.
 *
 * A resume is a set of choices over the store, and nothing about deleting the
 * thing those choices point at used to touch the resumes pointing at it.
 * `resolveResume` noticed and warned — "Section experience lists entry
 * exp_acme, which does not exist" — and carried on. Nothing was lost silently,
 * which was the point, and what it left behind was a save where removing one
 * line from the master document adds a permanent complaint to every resume
 * that had chosen it, clearable from nowhere in the app: the id is in the
 * YAML, the thing it names is gone, and the only way back is opening the files
 * by hand.
 *
 * So a delete now reaches the resumes, and the two kinds of thing it can
 * delete get different treatment, because they are different decisions.
 *
 * Deleting an entry, a line, a skills group or a skill removes something from
 * the store, and a resume that was showing it now shows one thing fewer. That
 * is what the delete meant. There is no substitute to reach for: the other
 * lines on the entry are other lines, not other versions of this one, and
 * pulling one of them onto eleven resumes would be a change to documents
 * somebody may be about to send that nobody asked for.
 *
 * Deleting an alternate is not that. A field's alternates are several
 * phrasings of one thing — the wording of a line, the spelling of a
 * graduation date — and a resume pinned to one of them is saying "this
 * field, said this way". Dropping the pin falls back to the *default*
 * phrasing: the wording somebody chose deliberately replaced by the one they
 * chose against, which is the worst available answer. So the pin moves to the
 * closest surviving alternate of the same field instead, whatever the score,
 * because every one of them is a better answer than the one the resume has
 * already declined.
 *
 * Two things the pass will not do. A selection that has lost every line
 * becomes an empty list, never an absent one: absent means "show them all",
 * and turning "none" into "all" would put lines somebody had switched off onto
 * the page. And `profile.name` is left alone, being neither an entry nor a
 * skill.
 */

import {
  isVariantField,
  type Entry,
  type ResumeSpec,
  type SectionSpec,
  type SkillGroup,
  type Variant,
} from './types.js';

/** The fields of an entry that can carry alternates, in `choices` key order. */
const FIELDS = ['title', 'dates', 'subtitle', 'location'] as const;

/** Letters and digits only, so punctuation and spacing do not count. */
function triples(text: string): Map<string, number> {
  const flat = ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const out = new Map<string, number>();
  for (let i = 0; i + 3 <= flat.length; i += 1) {
    const g = flat.slice(i, i + 3);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/**
 * How alike two pieces of text are, from 0 to 1, as the Dice overlap of their
 * letter triples.
 *
 * Letter triples rather than words, because the differences between two
 * phrasings of one line are mostly inside words — a tense changed, a number
 * reformatted, a plural — and a word-level measure scores those as a complete
 * miss. "Sep. 2022 -- May 2026" against "Sep. 2022 -- Dec. 2026" scores .82;
 * against "Two semesters" it scores .04.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ga = triples(a);
  const gb = triples(b);
  let shared = 0;
  let total = 0;
  for (const n of ga.values()) total += n;
  for (const [g, n] of gb) {
    total += n;
    shared += Math.min(n, ga.get(g) ?? 0);
  }
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * The store, by the ids a resume refers to it with.
 *
 * Built from a list that was just written rather than read back, so a read
 * cache keyed on a file's size and modification time cannot hand back the copy
 * from before the delete.
 */
export interface StoreIndex {
  entries: Map<string, Entry>;
  /**
   * Line ids, per entry, for `sections[].bullets`.
   */
  bullets: Map<string, Set<string>>;
  /** Every line id in the store, whichever entry carries it. */
  lines: Set<string>;
  /**
   * The alternates behind each `choices` key: `entryId.field` for a field, the
   * bare line id for a line.
   */
  wordings: Map<string, Variant[]>;
  /** Items of list lines — relevant coursework, awards — for `lists`. */
  listItems: Map<string, Set<string>>;
  /** Skills group ids, and the item ids each still holds. */
  groups: Map<string, Set<string>>;
}

export function indexStore(entries: Entry[], groups: SkillGroup[]): StoreIndex {
  const store: StoreIndex = {
    entries: new Map(),
    bullets: new Map(),
    lines: new Set(),
    wordings: new Map(),
    listItems: new Map(),
    groups: new Map(),
  };

  for (const entry of entries) {
    if (!entry?.id || store.entries.has(entry.id)) continue;
    store.entries.set(entry.id, entry);

    for (const field of FIELDS) {
      const value = entry[field];
      if (isVariantField(value)) store.wordings.set(`${entry.id}.${field}`, value.variants);
    }

    const ids = new Set<string>();
    for (const bullet of entry.bullets ?? []) {
      if (!bullet?.id) continue;
      ids.add(bullet.id);
      store.lines.add(bullet.id);

      /*
       * First one wins, as `resolveResume` does.
       *
       * A line id is supposed to belong to one line, and everything that mints
       * one has kept them unique for a while now — but a save written before
       * that can carry the same id on two entries, and the resolver says so
       * rather than pretending otherwise. A chosen wording is filed under the
       * bare id with no entry beside it, so it resolves against whichever of
       * the two the resolver reaches first. Answering for the same one here
       * is what keeps this pass from disagreeing with the page.
       */
      if (!store.wordings.has(bullet.id)) store.wordings.set(bullet.id, bullet.variants ?? []);
      if (bullet.items && !store.listItems.has(bullet.id)) {
        store.listItems.set(bullet.id, new Set(bullet.items.map((i) => i.id)));
      }
    }
    store.bullets.set(entry.id, ids);
  }

  for (const group of groups) {
    if (!group?.id || store.groups.has(group.id)) continue;
    store.groups.set(group.id, new Set((group.items ?? []).map((i) => i.id)));
  }

  return store;
}

/**
 * Where each deleted alternate sends the resumes that had pinned it.
 *
 * Keyed by `choices` key, then by the id of the alternate that went. Worked
 * out once per write rather than once per resume, so every resume in the save
 * moves the same way — two resumes pinned to one wording must not end up
 * printing different ones.
 *
 * An alternate with nothing left beside it is absent from here, and the pin is
 * dropped: the field has become a single phrasing, and there is nothing to
 * choose.
 */
export type MovedWordings = Map<string, Map<string, string>>;

export function findMovedWordings(before: StoreIndex, after: StoreIndex): MovedWordings {
  const moved: MovedWordings = new Map();

  for (const [key, had] of before.wordings) {
    const has = after.wordings.get(key) ?? [];
    if (has.length === 0) continue;

    // One survivor cannot stand in for two deletions: two resumes that had
    // pinned two different wordings should not be collapsed onto one.
    const taken = new Set<string>();
    const pairs = new Map<string, string>();

    for (const wording of had) {
      if (has.some((v) => v.id === wording.id)) continue;

      let best: string | undefined;
      let score = -1;
      for (const candidate of has) {
        if (taken.has(candidate.id)) continue;
        const s = similarity(String(wording.text), String(candidate.text));
        if (s > score) {
          score = s;
          best = candidate.id;
        }
      }
      if (best !== undefined) {
        pairs.set(wording.id, best);
        taken.add(best);
      }
    }

    if (pairs.size) moved.set(key, pairs);
  }

  return moved;
}

/**
 * The same resume with every reference to something the store no longer holds
 * taken out, and every pinned alternate that went moved onto its nearest
 * survivor.
 *
 * Pure, and returns a new object whether or not anything changed — the caller
 * compares and writes only where it did, so a save full of resumes that
 * reference nothing missing produces no commits.
 */
export function forgetMissing(spec: ResumeSpec, after: StoreIndex, moved: MovedWordings): ResumeSpec {
  const next: ResumeSpec = { ...spec };

  if (Array.isArray(spec.sections)) next.sections = spec.sections.map((s) => pruneSection(s, after));
  if (spec.choices) next.choices = pruneChoices(spec.choices, after, moved);
  if (spec.lists) next.lists = pruneLists(spec.lists, after);
  if (Array.isArray(spec.collapsed)) {
    next.collapsed = spec.collapsed.filter((id) => after.entries.has(id));
  }

  return next;
}

function pruneSection(section: SectionSpec, after: StoreIndex): SectionSpec {
  const next: SectionSpec = { ...section };

  if (Array.isArray(section.entries)) next.entries = section.entries.filter((id) => after.entries.has(id));

  if (section.bullets) {
    next.bullets = {};
    for (const [entryId, ids] of Object.entries(section.bullets)) {
      const lines = after.bullets.get(entryId);
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
      if (after.entries.has(entryId)) next.bulletOrder[entryId] = mode;
    }
  }

  if (Array.isArray(section.groups)) next.groups = section.groups.filter((id) => after.groups.has(id));

  if (section.items) {
    next.items = {};
    for (const [groupId, ids] of Object.entries(section.items)) {
      const items = after.groups.get(groupId);
      if (!items) continue;
      next.items[groupId] = Array.isArray(ids) ? ids.filter((id) => items.has(id)) : ids;
    }
  }

  return next;
}

/**
 * A pinned wording moves to its nearest survivor, and is kept only if what it
 * ends up naming is really there.
 *
 * That last test is the same one `resolveResume` applies before it warns,
 * deliberately — "Choice X asked for variant Y, which does not exist" and
 * "Choice X does not match any field or bullet in the store" are the two
 * complaints this clears, and a pass that cleared a different set would leave
 * one of them standing with nothing able to remove it.
 */
function pruneChoices(
  choices: Record<string, string>,
  after: StoreIndex,
  moved: MovedWordings,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, variantId] of Object.entries(choices)) {
    // Not an entry and not a skill. See the note at the top of the file.
    if (key === 'profile.name') {
      next[key] = variantId;
      continue;
    }
    const wanted = moved.get(key)?.get(variantId) ?? variantId;
    if (after.wordings.get(key)?.some((v) => v.id === wanted)) next[key] = wanted;
  }
  return next;
}

function pruneLists(lists: Record<string, string[]>, after: StoreIndex): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [bulletId, ids] of Object.entries(lists)) {
    if (!after.lines.has(bulletId)) continue;
    const items = after.listItems.get(bulletId);
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
