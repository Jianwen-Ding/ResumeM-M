import { sortKey, startKey } from './period.js';
import {
  DEFAULT_LAYOUT,
  isListBullet,
  isVariantField,
  type Bullet,
  type Entry,
  type EntryKind,
  type LayoutOptions,
  type MaybeVariant,
  type ResolvedBullet,
  type ResolvedEntry,
  type Profile,
  type ResolvedProfile,
  type ResolvedResume,
  type ResolvedSection,
  type ResumeSpec,
  type SectionSpec,
  type StoreData,
} from './types.js';

const DEFAULT_HEADINGS: Record<EntryKind, string> = {
  education: 'Education',
  experience: 'Experience',
  project: 'Projects',
  skills: 'Technical Skills',
  custom: 'Additional',
};

/**
 * Flatten a resume's `extends` chain. Child choices win over parent choices;
 * child sections replace the parent's section of the same kind entirely, since
 * a half-merged section ordering is never what anyone means.
 */
export function flattenSpec(spec: ResumeSpec, all: ResumeSpec[], seen = new Set<string>()): ResumeSpec {
  if (seen.has(spec.id)) {
    throw new Error(`Resume inheritance cycle at "${spec.id}"`);
  }
  seen.add(spec.id);
  if (!spec.extends) return spec;

  const parent = all.find((r) => r.id === spec.extends);
  if (!parent) {
    throw new Error(`Resume "${spec.id}" extends "${spec.extends}", which does not exist`);
  }
  return mergeOnto(flattenSpec(parent, all, seen), spec);
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
 * Rewrite a resume that extends one being deleted, so it stands without it.
 *
 * The deleted resume's own contribution is folded in underneath the child's,
 * and the child is re-pointed at the deleted resume's parent — which is to say
 * the child resolves to exactly what it resolved to before, because this runs
 * the same merge `flattenSpec` would have run at render time. Deleting one
 * resume should not change how any other one looks.
 */
export function absorbBase(child: ResumeSpec, removed: ResumeSpec): ResumeSpec {
  const merged = mergeOnto(removed, child);

  /*
   * What the parent *contributed to the document* — sections, choices, lists,
   * layout — the child keeps. What the parent *was*, it does not.
   *
   * The spread copies every key the child lacks, and some of those keys are
   * the parent's identity rather than its content. Deleting a pinned base
   * turned every tailored variation into a pinned base, and handed each of
   * them the parent's `generatedFor` — so a resume made for one posting came
   * back claiming it had been written for another, and the base pickers filled
   * up with resumes nobody pinned. A child with no label of its own would have
   * taken the parent's, leaving two resumes with one name and no parent to
   * explain it.
   */
  for (const own of ['label', 'base', 'notes', 'generatedFor'] as const) {
    if (child[own] === undefined) delete merged[own];
  }

  merged.id = child.id;
  if (removed.extends) merged.extends = removed.extends;
  else delete merged.extends;
  return merged;
}

/**
 * Which of the parent's sections a child's section replaces.
 *
 * Matching on `kind` alone is not enough, and `heading` exists precisely
 * because it is not: a store can hold two `custom` sections, "Awards" and
 * "Leadership". A child re-stating only Awards replaced *both* of them with
 * Awards, so the document printed Awards twice and Leadership, with its
 * entries, was silently gone. Nothing warned, and the editor runs the same
 * algorithm, so the preview agreed with the wrong answer.
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
   *
   * Absent means inherited, which is how `choices`, `lists` and `layout`
   * already work one level up in `mergeOnto`.
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

/**
 * The choice key for the name on the page.
 *
 * Shaped like every other field path — owner, then field — so a resume pins it
 * with the same mechanism, the editor lists it with the same code, and nothing
 * had to learn that the profile is a special case.
 */
export const PROFILE_NAME_KEY = 'profile.name';

/** The profile with its name decided. */
export function resolveProfile(
  profile: Profile,
  choices: Record<string, string>,
  warnings: string[],
): ResolvedProfile {
  return { ...profile, name: pickField(profile.name, PROFILE_NAME_KEY, choices, warnings) ?? '' };
}

/**
 * Pick the text of a possibly-varying field.
 * `choices` is keyed by `${ownerId}.${fieldName}` — e.g. `edu_neu.dates`.
 */
function pickField(
  field: MaybeVariant | undefined,
  key: string,
  choices: Record<string, string>,
  warnings: string[],
): string | undefined {
  if (field === undefined) return undefined;
  // YAML happily turns `dates: 2026` into a number, so normalise here rather
  // than making every consumer defensive about it.
  if (!isVariantField(field)) return String(field);

  const wanted = choices[key];
  if (wanted) {
    const hit = field.variants.find((v) => v.id === wanted);
    if (hit) return String(hit.text);
    warnings.push(`Choice "${key}" asked for variant "${wanted}", which does not exist; using default.`);
  }
  const def = field.variants.find((v) => v.id === field.default) ?? field.variants[0];
  if (!def) {
    warnings.push(`Field "${key}" has no variants.`);
    return undefined;
  }
  return String(def.text);
}

function pickBullet(
  bullet: Bullet,
  choices: Record<string, string>,
  warnings: string[],
  lists: Record<string, string[]> = {},
): { variantId: string; text: string } | undefined {
  // A list bullet is not worded, it is assembled: prefix plus whichever items
  // this resume keeps, in store order.
  if (isListBullet(bullet)) {
    const wantedIds = lists[bullet.id];
    const items = wantedIds
      ? wantedIds
          .map((id) => {
            const item = bullet.items!.find((i) => i.id === id);
            if (!item) warnings.push(`Bullet "${bullet.id}" lists item "${id}", which does not exist.`);
            return item;
          })
          .filter((i): i is NonNullable<typeof i> => Boolean(i))
      : bullet.items!;

    if (items.length === 0) return undefined;
    const sep = bullet.separator ?? ', ';
    const body = items.map((i) => String(i.text)).join(sep);
    return { variantId: '__list__', text: bullet.prefix ? `${bullet.prefix} ${body}` : body };
  }

  const wanted = choices[bullet.id];
  if (wanted) {
    const hit = bullet.variants.find((v) => v.id === wanted);
    if (hit) return { variantId: hit.id, text: String(hit.text) };
    warnings.push(`Bullet "${bullet.id}" asked for variant "${wanted}", which does not exist; using default.`);
  }
  const def = bullet.variants.find((v) => v.id === bullet.default) ?? bullet.variants[0];
  if (!def) {
    warnings.push(`Bullet "${bullet.id}" has no variants and was dropped.`);
    return undefined;
  }
  return { variantId: def.id, text: String(def.text) };
}

function resolveEntry(
  entry: Entry,
  section: SectionSpec,
  choices: Record<string, string>,
  warnings: string[],
  lists: Record<string, string[]> = {},
): ResolvedEntry {
  const wantedBullets = section.bullets?.[entry.id];
  const available = (entry.bullets ?? []).filter((b) => !b.archived);

  /*
   * Archiving means "keep the text, never print it", and that has to hold
   * however the resume asks for the bullet. It held for the branch below, which
   * filters, and not for this one — and tailoring writes an explicit list every
   * time it hides anything, so tailoring a resume brought every bullet you had
   * retired in that entry back onto the copy you send.
   */
  const ordered: Bullet[] = wantedBullets
    ? wantedBullets
        .map((id) => {
          const b = (entry.bullets ?? []).find((x) => x.id === id);
          if (!b) {
            warnings.push(`Entry "${entry.id}" lists bullet "${id}", which does not exist.`);
            return undefined;
          }
          if (b.archived) {
            warnings.push(`Entry "${entry.id}" lists bullet "${id}", which is archived; leaving it out.`);
            return undefined;
          }
          return b;
        })
        .filter((b): b is Bullet => Boolean(b))
    : available;

  return {
    id: entry.id,
    kind: entry.kind,
    title: pickField(entry.title, `${entry.id}.title`, choices, warnings) ?? entry.id,
    dates: pickField(entry.dates, `${entry.id}.dates`, choices, warnings),
    subtitle: pickField(entry.subtitle, `${entry.id}.subtitle`, choices, warnings),
    location: pickField(entry.location, `${entry.id}.location`, choices, warnings),
    bullets: ordered
      .map((b) => {
        const picked = pickBullet(b, choices, warnings, lists);
        return picked ? { id: b.id, ...picked } : undefined;
      })
      .filter((b): b is NonNullable<typeof b> => Boolean(b)),
  };
}

/** Turn a resume spec plus the store into something the renderer can print. */
/**
 * The entry ids of one section, in the order they should print.
 *
 * Sorting happens here, at render time, rather than by rewriting the stored
 * list. Two reasons. The list is what a manual arrangement *is*, so a sort that
 * overwrote it would destroy the thing you go back to when you turn the sort
 * off. And a sort that runs when the resume is built cannot go stale: change a
 * date and the page is already right, with nothing to remember to re-run.
 *
 * Entries whose dates could not be read are not sorted anywhere. They keep
 * their positions relative to each other and follow the dated ones, because an
 * entry the program cannot place is one it has no business moving — "Various"
 * is not older than 2019 and it is not newer, and pretending either way puts a
 * line of somebody's resume somewhere they did not choose.
 */
/**
 * Turn a hand-ordered section into a date-ordered one, where that is provably
 * a no-op.
 *
 * Most of the time a resume should keep itself in date order, and most of the
 * time it already is: people list jobs newest-first because that is what the
 * document is for. But a section written before ordering existed says nothing
 * about what it wants, and reading "says nothing" as "sort me" would rearrange
 * documents that have been proofread and sent — for the sake of a setting the
 * author never saw.
 *
 * So the question asked is narrower and answerable: would sorting this section
 * change it? If not, it is already a date-ordered section that has been
 * maintained by hand, and saying so out loud costs the user nothing and means
 * the next entry they add lands in the right place by itself. If it would
 * change, the order is a decision — a project pulled to the top for one
 * application, a job held back — and the only right move is to leave it and
 * let the editor offer the sort as a button.
 *
 * Returns the sections it would change, rather than changing them, so the
 * caller decides whether this is a migration or a question.
 */
export function adoptDateOrder(
  sections: SectionSpec[],
  entries: Entry[],
): { adopted: SectionSpec[]; handOrdered: SectionSpec[] } {
  const adopted: SectionSpec[] = [];
  const handOrdered: SectionSpec[] = [];

  for (const section of sections) {
    if (section.order !== undefined || section.kind === 'skills') {
      adopted.push(section);
      continue;
    }
    const ids = section.entries ?? [];
    const sorted = orderedEntries({ ...section, order: 'newest' }, entries);
    // One entry cannot be out of order, and neither can none.
    if (ids.length < 2 || sorted.every((id, i) => id === ids[i])) {
      adopted.push({ ...section, order: 'newest' });
    } else {
      adopted.push(section);
      handOrdered.push(section);
    }
  }
  return { adopted, handOrdered };
}

export function orderedEntries(section: SectionSpec, entries: Entry[]): string[] {
  const ids = section.entries ?? [];
  if (section.order !== 'newest' && section.order !== 'oldest') return ids;

  const keyOf = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    return section.order === 'oldest' ? startKey(entry?.period) : sortKey(entry?.period);
  };

  const dated: { id: string; key: number }[] = [];
  const undated: string[] = [];
  for (const id of ids) {
    const key = keyOf(id);
    if (key === undefined) undated.push(id);
    else dated.push({ id, key });
  }

  dated.sort((a, b) => (section.order === 'oldest' ? a.key - b.key : b.key - a.key));
  return [...dated.map((d) => d.id), ...undated];
}

export function resolveResume(specOrId: ResumeSpec | string, data: StoreData): ResolvedResume {
  const spec =
    typeof specOrId === 'string'
      ? data.resumes.find((r) => r.id === specOrId)
      : specOrId;
  if (!spec) throw new Error(`No resume named "${String(specOrId)}"`);

  const warnings: string[] = [];
  /*
   * The same complaints, countable.
   *
   * The sentences below are for the editor and the log, and they name ids
   * because that is what you would go and fix. Somebody about to attach a
   * file needs the other half of it — that one of their jobs is missing —
   * without being shown "b_ec_pipeline", which names nothing they have ever
   * typed. So the two kinds that mean "this is not the resume you were
   * looking at" are counted as they are found.
   */
  const lost: { kind: 'entry' | 'wording'; id: string }[] = [];
  const flat = flattenSpec(spec, data.resumes);
  const choices = flat.choices ?? {};
  const lists = flat.lists ?? {};

  const sections: ResolvedSection[] = (flat.sections ?? []).map((section) => {
    const entries: ResolvedEntry[] = [];
    const skillGroups: ResolvedSection['skillGroups'] = [];

    if (section.kind === 'skills') {
      for (const gid of section.groups ?? []) {
        const group = data.skillGroups.find((g) => g.id === gid);
        if (!group) {
          warnings.push(`Skills group "${gid}" does not exist.`);
          continue;
        }
        const wanted = section.items?.[gid];
        const items = wanted
          ? wanted
              .map((iid) => group.items.find((i) => i.id === iid)?.text)
              .filter((t): t is string => Boolean(t))
          : group.items.map((i) => i.text);
        skillGroups.push({ id: group.id, name: group.name, items });
      }
    } else {
      for (const eid of orderedEntries(section, data.entries)) {
        const entry = data.entries.find((e) => e.id === eid);
        if (!entry) {
          warnings.push(`Section "${section.kind}" lists entry "${eid}", which does not exist.`);
          lost.push({ kind: 'entry', id: eid });
          continue;
        }
        /*
         * Archiving is how something is taken out of circulation without being
         * thrown away, and everything else honours it: the master document, the
         * pickers, the matcher, the AI's view of the store. This did not, so an
         * archived entry disappeared from every screen and went on being
         * printed on every resume that listed it. Same treatment as an archived
         * bullet, which was already handled a few lines up.
         */
        if (entry.archived) {
          warnings.push(`Entry "${eid}" is archived, so it was left off.`);
          continue;
        }
        entries.push(resolveEntry(entry, section, choices, warnings, lists));
      }
    }

    return {
      kind: section.kind,
      heading: section.heading ?? DEFAULT_HEADINGS[section.kind],
      entries,
      skillGroups,
    };
  });

  // Flag choices that matched nothing — usually a renamed id, and silently
  // ignoring them is how a resume quietly reverts to the wrong grad date.
  const knownKeys = new Set<string>();
  if (isVariantField(data.profile.name)) knownKeys.add(PROFILE_NAME_KEY);
  for (const e of data.entries) {
    for (const f of ['title', 'dates', 'subtitle', 'location'] as const) {
      if (isVariantField(e[f])) knownKeys.add(`${e.id}.${f}`);
    }
    for (const b of e.bullets ?? []) knownKeys.add(b.id);
  }
  for (const key of Object.keys(choices)) {
    if (!knownKeys.has(key)) {
      warnings.push(`Choice "${key}" does not match any field or bullet in the store.`);
      lost.push({ kind: 'wording', id: key });
    }
  }

  const layout: LayoutOptions = {
    ...DEFAULT_LAYOUT,
    ...(flat.layout ?? {}),
    fitBounds: { ...DEFAULT_LAYOUT.fitBounds, ...(flat.layout?.fitBounds ?? {}) },
  };

  return {
    id: flat.id,
    label: flat.label ?? flat.id,
    profile: resolveProfile(data.profile, choices, warnings),
    sections,
    layout,
    warnings,
    lost,
  };
}

/**
 * The master document: every entry, every bullet, every variant, on one long
 * page. Not a resume — a browsable inventory of what you have to say.
 */
/**
 * What the editor calls each heading field. The master document is for reading,
 * so it says "Dates", not "edu_neu.dates" — the store's keys stopped appearing
 * anywhere else in the interface and this was the last place they showed.
 */
const FIELD_NAMES: Record<'title' | 'dates' | 'subtitle' | 'location', string> = {
  title: 'Title',
  dates: 'Dates',
  subtitle: 'Role / degree',
  location: 'Location',
};

export function buildMaster(data: StoreData): ResolvedResume {
  const byKind = (kind: EntryKind) => data.entries.filter((e) => e.kind === kind && !e.archived);
  const warnings: string[] = [];

  const entrySection = (kind: EntryKind): ResolvedSection => ({
    kind,
    heading: DEFAULT_HEADINGS[kind],
    skillGroups: [],
    entries: byKind(kind).map((entry) => {
      // Heading cells stay at their default text. The two-column heading row is
      // narrow — a graduation date with both of its variants spliced in runs
      // straight off the page — so field alternates are listed as full-width
      // lines below instead.
      const def = (f: MaybeVariant | undefined): string | undefined => {
        if (f === undefined) return undefined;
        if (!isVariantField(f)) return String(f);
        const chosen = f.variants.find((v) => v.id === f.default) ?? f.variants[0];
        return chosen ? String(chosen.text) : undefined;
      };

      const fieldLines: ResolvedBullet[] = [];
      for (const name of ['title', 'dates', 'subtitle', 'location'] as const) {
        const field = entry[name];
        if (!isVariantField(field) || field.variants.length < 2) continue;
        fieldLines.push({
          id: `${entry.id}.${name}`,
          variantId: field.default,
          text:
            `*${FIELD_NAMES[name]}* — ` +
            field.variants
              .map((v) => `${v.text} (${v.label}${v.id === field.default ? ', default' : ''})`)
              .join('  ·  '),
        });
      }

      return {
        id: entry.id,
        kind: entry.kind,
        title: def(entry.title) ?? entry.id,
        dates: def(entry.dates),
        subtitle: def(entry.subtitle),
        location: def(entry.location),
        bullets: [
          ...fieldLines,
          ...(entry.bullets ?? []).flatMap((b) =>
            // A list bullet has items rather than phrasings; the inventory
            // question for it is "what could go in this list?".
            isListBullet(b)
              ? [
                  {
                    id: b.id,
                    variantId: '__list__',
                    text: `${b.prefix ?? ''} ${b.items!
                      .map((i) => i.text)
                      .join(b.separator ?? ', ')}   — (every item on this list)`.trim(),
                  },
                ]
              : b.variants.map((v) => ({
                  id: b.id,
                  variantId: v.id,
                  text: `${v.text}   — ${v.label}${v.id === b.default ? ' (default)' : ''}${
                    v.suggested ? ' (AI-suggested, unreviewed)' : ''
                  }`,
                })),
          ),
        ],
      } satisfies ResolvedEntry;
    }),
  });

  return {
    id: '__master__',
    label: 'Master document — everything in the store',
    // The master shows the pinned name; it is the store, not a selection.
    profile: resolveProfile(data.profile, {}, warnings),
    sections: [
      entrySection('education'),
      entrySection('experience'),
      entrySection('project'),
      {
        kind: 'skills' as const,
        heading: 'Technical Skills',
        entries: [],
        skillGroups: data.skillGroups.map((g) => ({
          id: g.id,
          name: g.name,
          items: g.items.map((i) => String(i.text)),
        })),
      } satisfies ResolvedSection,
      entrySection('custom'),
    ].filter((s) => s.entries.length > 0 || s.skillGroups.length > 0),
    layout: { ...DEFAULT_LAYOUT, maxPages: 99, autoFit: false },
    warnings,
  };
}
