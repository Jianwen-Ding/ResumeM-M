import type { ResumeSpec, SectionSpec } from './types.js';

/**
 * Folding an old store's `extends` chains into self-contained resumes.
 *
 * Resumes used to inherit. A variation recorded `extends: base` and a handful
 * of overrides, and what it actually contained was worked out at render time
 * by laying one spec over another. That bought less than it looked like —
 * bullet text, titles and dates live once in `entries/`, so fixing a typo
 * already reaches every resume that references that bullet, and re-pinning a
 * wording already reaches everything that has not overridden it. What
 * inheritance added on top was narrow: a newly added entry arriving switched
 * on, list ordering, and the layout numbers.
 *
 * What it cost was not narrow. A resume's file did not say what the resume
 * contained, so neither `git diff` nor the version history meant what they
 * said. The depth was accidental — "save as variation" recorded whichever
 * resume happened to be open — so the shape of the tree was a side effect of
 * clicking rather than a decision. And the rule that kept it working, "a
 * field the child does not mention stays inherited", failed silently twice:
 * two `custom` sections collapsing into one, and children pinned to the entry
 * list their base had at the moment they were saved.
 *
 * So the merge lives here now, and only here: it runs over a store written by
 * an older version, once, and what it writes back is a set of resumes that
 * each stand alone. Nothing in the live path calls it. It is kept rather than
 * deleted because a store on disk may be any age, and the one thing a
 * migration must never do is change what a resume prints — this is the same
 * algorithm the renderer used to run, so the documents it produces are
 * identical by construction rather than by inspection.
 */

/**
 * Which of the parent's sections a child's section replaces.
 *
 * Matching on `kind` alone is not enough, and `heading` exists precisely
 * because it is not: a store can hold two `custom` sections, "Awards" and
 * "Leadership". A child re-stating only Awards replaced *both* of them with
 * Awards, so the document printed Awards twice and Leadership, with its
 * entries, was silently gone.
 *
 * It cannot simply become an exact match on the heading either, because the
 * ordinary child does not repeat the heading at all — it just lists different
 * entries under Experience, and must go on replacing the parent's Experience
 * rather than adding a second one.
 *
 * So: a heading that matches wins first; then a child that named no heading
 * takes the parent's section of that kind; then a renamed heading is allowed to
 * take it, but only where the parent has one section of that kind and there is
 * therefore nothing to be ambiguous about. Whatever is left is a section the
 * parent never had.
 */
export function mergeSections(base: SectionSpec[], override: SectionSpec[]): SectionSpec[] {
  if (override.length === 0) return base;

  const out = [...base];
  const claimed = new Set<number>();

  /*
   * What the child states, over what the parent had — not instead of it.
   *
   * A child section used to replace its parent's outright, so expressing "hide
   * one bullet of one entry" meant restating the entry list as well. The editor
   * duly wrote that list down, and from then on the variation was pinned to the
   * entries the base had at that moment: anything added to the base afterwards
   * arrived switched off, because the child was now saying "these entries,
   * exactly" when all it had ever meant was "this bullet, hidden".
   */
  const over = (parent: SectionSpec, child: SectionSpec): SectionSpec => ({
    ...parent,
    ...child,
    entries: child.entries ?? parent.entries,
    groups: child.groups ?? parent.groups,
    bullets:
      child.bullets || parent.bullets
        ? { ...(parent.bullets ?? {}), ...(child.bullets ?? {}) }
        : undefined,
    items:
      child.items || parent.items ? { ...(parent.items ?? {}), ...(child.items ?? {}) } : undefined,
  });

  const claim = (o: SectionSpec, where: (s: SectionSpec, i: number) => boolean): boolean => {
    const at = out.findIndex((s, i) => !claimed.has(i) && s.kind === o.kind && where(s, i));
    if (at < 0) return false;
    out[at] = over(out[at]!, o);
    claimed.add(at);
    return true;
  };

  const heading = (s: SectionSpec) => s.heading ?? '';
  const onlyOneOfItsKind = (o: SectionSpec) => base.filter((s) => s.kind === o.kind).length === 1;

  let pending = override.filter((o) => !claim(o, (s) => heading(s) === heading(o)));
  pending = pending.filter((o) => !(heading(o) === '' && claim(o, () => true)));
  pending = pending.filter((o) => !(onlyOneOfItsKind(o) && claim(o, () => true)));

  // Sections the parent never had are appended in the child's order.
  for (const o of pending) out.push(o);
  return out;
}

/** One inheritance step: `spec` laid over `base`. */
function mergeOnto(base: ResumeSpec, spec: ResumeSpec): ResumeSpec {
  return {
    ...base,
    ...spec,
    sections: mergeSections(base.sections ?? [], spec.sections ?? []),
    choices: { ...(base.choices ?? {}), ...(spec.choices ?? {}) },
    lists: { ...(base.lists ?? {}), ...(spec.lists ?? {}) },
    layout: { ...(base.layout ?? {}), ...(spec.layout ?? {}) },
  };
}

/**
 * The old resolver's chain walk, character for character.
 *
 * Kept recursive and kept in this shape deliberately. A tidier iterative
 * version produces a different answer on a store that holds a loop — the
 * recursion lays the repeated resume down twice, and the merge is not
 * idempotent over section *ordering* — and "the same document as before" is
 * the only promise this migration makes. So it is the same walk, and the
 * documents match because the code matches, not because someone compared
 * them and did not find a difference.
 */
function walk(
  spec: ResumeSpec,
  all: ResumeSpec[],
  seen: Set<string>,
  problems: string[],
  about: string,
): ResumeSpec {
  if (seen.has(spec.id)) {
    problems.push(
      `"${about}" recorded a base that led back to itself. The loop is ignored; ` +
        `what the resume printed is unchanged.`,
    );
    return spec;
  }
  seen.add(spec.id);
  if (!spec.extends) return spec;

  const parent = all.find((r) => r.id === spec.extends);
  if (!parent) {
    /*
     * The resolver threw here, and a migration must not: a save on disk can
     * hold a dangling link — deleting a base by hand is all it takes — and
     * refusing to migrate would leave that store permanently on the old
     * format, which is the one outcome worse than the link itself.
     */
    problems.push(
      `"${about}" recorded a base, "${spec.extends}", that the save does not have. ` +
        `The link is dropped; what the resume printed is unchanged.`,
    );
    return spec;
  }
  return mergeOnto(walk(parent, all, seen, problems, about), spec);
}

/**
 * Everything a resume's `extends` chain contributed, written into the resume.
 *
 * A missing base and a loop are both survivable and neither is a reason to
 * refuse: a store on disk can hold either, and this is the code that exists to
 * clean them up. A chain that cannot be walked is walked as far as it goes,
 * which is exactly what the resolver did with it, so the document is the same
 * either way. Whatever went wrong comes back in `problems` for the caller to
 * report, not as a throw that would leave the store half migrated.
 */
export function flattenOne(
  spec: ResumeSpec,
  all: ResumeSpec[],
  problems: string[] = [],
): ResumeSpec {
  const flat = walk(spec, all, new Set(), problems, spec.id);

  /*
   * The merge copies down every key the child lacked, and some of those keys
   * are the parent's identity rather than its content. A variation with no
   * label of its own would take the base's, leaving two resumes with one name;
   * one with no notes would inherit an explanation of a different document;
   * and `generatedFor` would have a resume claiming it was written for a
   * posting it was not. Deleting a base already got this wrong once, in
   * exactly this way.
   */
  const out: ResumeSpec = { ...flat, id: spec.id, label: spec.label };
  for (const own of ['base', 'notes', 'generatedFor', 'collapsed'] as const) {
    if (spec[own] === undefined) delete out[own];
    else Object.assign(out, { [own]: spec[own] });
  }

  /*
   * The link goes, but not the fact. "Built on Summer intern" is worth
   * keeping in the application detail — it is where this resume came from —
   * and as a plain record it says that without anything merging behind it.
   */
  if (spec.extends) {
    out.copiedFrom = spec.extends;
    delete out.extends;
  }
  return out;
}

/** True when a store still holds resumes written by a version that inherited. */
export function needsFlattening(all: ResumeSpec[]): boolean {
  return all.some((r) => r.extends);
}

/**
 * Every resume in a store, each standing alone.
 *
 * Flattened against the *unflattened* list on purpose: each chain is walked
 * from the originals, so the result does not depend on what order the resumes
 * come in or on a parent having been rewritten first.
 */
export function flattenResumes(all: ResumeSpec[], problems: string[] = []): ResumeSpec[] {
  if (!needsFlattening(all)) return all;
  return all.map((spec) => (spec.extends ? flattenOne(spec, all, problems) : spec));
}
