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
  const base = flattenSpec(parent, all, seen);

  const sections = mergeSections(base.sections ?? [], spec.sections ?? []);
  return {
    ...base,
    ...spec,
    sections,
    choices: { ...(base.choices ?? {}), ...(spec.choices ?? {}) },
    lists: { ...(base.lists ?? {}), ...(spec.lists ?? {}) },
    layout: { ...(base.layout ?? {}), ...(spec.layout ?? {}) },
  };
}

function mergeSections(base: SectionSpec[], override: SectionSpec[]): SectionSpec[] {
  if (override.length === 0) return base;
  const out = base.map((s) => {
    const o = override.find((x) => x.kind === s.kind);
    return o ? o : s;
  });
  // Sections the parent never had are appended in the child's order.
  for (const o of override) {
    if (!out.some((s) => s.kind === o.kind)) out.push(o);
  }
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
export function resolveResume(specOrId: ResumeSpec | string, data: StoreData): ResolvedResume {
  const spec =
    typeof specOrId === 'string'
      ? data.resumes.find((r) => r.id === specOrId)
      : specOrId;
  if (!spec) throw new Error(`No resume named "${String(specOrId)}"`);

  const warnings: string[] = [];
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
      for (const eid of section.entries ?? []) {
        const entry = data.entries.find((e) => e.id === eid);
        if (!entry) {
          warnings.push(`Section "${section.kind}" lists entry "${eid}", which does not exist.`);
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
    if (!knownKeys.has(key)) warnings.push(`Choice "${key}" does not match any field or bullet in the store.`);
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
