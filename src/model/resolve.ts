import { flattenOne } from './flatten.js';
import { endsBeforeItStarts, sortKey, startKey } from './period.js';
import {
  DEFAULT_LAYOUT,
  layoutFor,
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
 * The choice key for the name on the page.
 *
 * Shaped like every other field path — owner, then field — so a resume pins it
 * with the same mechanism, the editor lists it with the same code, and nothing
 * had to learn that the profile is a special case.
 */
export const PROFILE_NAME_KEY = 'profile.name';

/**
 * What a brand-new store puts in `profile.yaml`, and what an empty or missing
 * one reads as.
 *
 * In one place because it has to be recognisable later: it is the difference
 * between a resume and a template, and the only way to tell them apart.
 */
export const PLACEHOLDER_NAME = 'Your Name';

/**
 * Why this document cannot be sent to anybody, or undefined when it can.
 *
 * `profile.yaml` reads as `{ name: 'Your Name' }` when it is empty or not
 * there — which is what a crashed editor, a sync client, or a checkout of a
 * branch without it leaves behind, and also what a store looks like on the
 * day it is made. Every other unreadable file in the save is refused with a
 * sentence and nothing is changed; this one is accepted, and the placeholder
 * goes all the way through.
 *
 * Measured, on a real server, by emptying the file and pressing the button the
 * extension presses: a PDF headed "Your Name" with no email, no telephone and
 * no links, named `Your-Name-Resume.pdf`, filed as an application marked
 * `applied`, and copied into the flat folder a portal's file picker is
 * pointed at. Every step reported success. It is the one output of this
 * program that is worse than no output at all — not a blank where a name
 * should be, but a template somebody plainly did not finish.
 */
export function unsendableReason(profile: ResolvedProfile): string | undefined {
  const name = String(profile.name ?? '').trim();
  if (!name) {
    return (
      'This save has no name in it, so the document would go out with nothing at the top of it. ' +
      'Put your name in under Master — profile.yaml may be empty or missing.'
    );
  }
  if (name === PLACEHOLDER_NAME) {
    return (
      `This save still says "${PLACEHOLDER_NAME}", which is what a new one says until you change it — ` +
      'and an empty or missing profile.yaml reads the same way. Put your name in under Master ' +
      'before sending anything.'
    );
  }
  return undefined;
}

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

/**
 * What a bullet says, given whatever has been chosen for it.
 *
 * Exported because the MCP session has to answer the same question when it
 * reads a resume back to the model, and a second implementation of "prefix
 * plus the items this resume keeps" is a second implementation to get wrong.
 */
export function pickBullet(
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
  /*
   * In the master's order, unless this resume arranged them itself. See
   * `orderedBullets` — the resume says which lines, the master says what
   * order, and a resume that disagrees with the master is one that was
   * dragged and is left exactly as it is.
   */
  const asked = wantedBullets
    ? bulletsAreHandOrdered(section, entry.id)
      ? wantedBullets
      : orderedBullets(wantedBullets, entry)
    : undefined;

  const ordered: Bullet[] = asked
    ? asked
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

  /*
   * An entry with no title prints nothing where its title goes, and says so.
   *
   * It used to fall back to `entry.id`, so a resume went out with
   * `exp_example_co` typeset in bold where the employer's name belongs —
   * an internal identifier, on a document somebody sends to a stranger, with
   * nothing anywhere saying it had happened. Two ways in: a title missing
   * from the YAML, and a title that is a set of alternates with none in it.
   *
   * A gap on the page is visible; a slug reads like a name. And the warning
   * is what actually fixes it: `build`, `check`, `apply` and the editor all
   * print these, so the entry gets named rather than guessed at.
   */
  const named = pickField(entry.title, `${entry.id}.title`, choices, warnings);
  const title = named ?? '';
  if (!title.trim()) {
    warnings.push(`Entry "${entry.id}" has no title, so nothing is printed where its name goes.`);
  }
  const dates = pickField(entry.dates, `${entry.id}.dates`, choices, warnings);

  /*
   * A date that runs backwards, said once, where the person can still do
   * something about it. See `endsBeforeItStarts`: the control accepts any
   * year at either end because it has to, so this is the only place the
   * mistake is ever noticed — and a resume reading "Jul. 2026 -- Dec. 2024"
   * is exactly the document this program exists to stop somebody sending.
   *
   * Named by its title rather than its id, because this one is read by the
   * person editing and `exp_example_co` is not what they call it.
   */
  if (endsBeforeItStarts(entry.period)) {
    warnings.push(`"${title}" ends before it starts${dates ? ` — it reads "${dates}"` : ''}. Check the dates.`);
  }

  return {
    id: entry.id,
    kind: entry.kind,
    title,
    dates,
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

/**
 * The lines of one entry, in the order the master document puts them.
 *
 * The master is the inventory: every entry, every phrasing, in one place. It
 * is also the only place an order can be stated once and mean something
 * everywhere, which is what makes it the right place to keep the house order
 * for the lines inside an entry. Entries themselves are ordered by date,
 * because a career has an order already and it is not a matter of taste; the
 * lines inside a job are a matter of taste, and repeating that taste on every
 * variation by hand is the work this removes.
 *
 * So a resume's bullet list says *which* lines it shows, and the master says
 * what order they come in — with one exception, which is the resume that was
 * arranged by hand. That exception needs no field of its own to record it.
 * Hiding a line rewrites the resume's list straight out of the master's order
 * (see `setBulletIncluded`), so a list that disagrees with the master can only
 * have got that way by somebody dragging it. Disagreement *is* the record.
 *
 * Which means rearranging the master restacks every resume that has not been
 * arranged by hand, and leaves alone every one that has — including the ones
 * arranged before any of this existed, whose arrangement would otherwise be
 * thrown away by the upgrade that introduced the feature.
 */
export function orderedBullets(selected: string[], entry: Entry): string[] {
  const master = (entry.bullets ?? []).map((b) => b.id);
  const at = (id: string) => master.indexOf(id);
  // A line the master has never heard of keeps its place at the end rather
  // than sorting to the front on an index of -1.
  const known = selected.filter((id) => at(id) >= 0).sort((a, b) => at(a) - at(b));
  return [...known, ...selected.filter((id) => at(id) < 0)];
}

/**
 * Whether this resume arranged an entry's lines itself.
 *
 * Read from the section rather than guessed at. See `SectionSpec.bulletOrder`
 * for why guessing cannot work: a list that disagrees with the master looks
 * hand-arranged, and every resume that was following the master disagrees
 * with it the moment the master moves.
 */
export function bulletsAreHandOrdered(section: SectionSpec, entryId: string): boolean {
  return section.bulletOrder?.[entryId] === 'manual';
}

/**
 * Mark the entries whose lines were arranged before the master had a say.
 *
 * The same one-time question `adoptDateOrder` asks of a section, asked of an
 * entry's lines: this resume disagrees with the master, and nothing here has
 * ever been able to record whether that was deliberate — so read it as
 * deliberate, once, and write it down. Being wrong that way leaves a resume
 * arranged as it already was; being wrong the other way silently restacks a
 * document somebody has proofread and sent.
 *
 * Nothing is written to disk here. The mark rides along on the next save of
 * that resume, exactly as `adoptDateOrder`'s does.
 */
export function adoptBulletOrder(sections: SectionSpec[], entries: Entry[]): SectionSpec[] {
  return sections.map((section) => {
    const listed = Object.entries(section.bullets ?? {});
    if (listed.length === 0) return section;

    const found: Record<string, 'manual'> = { ...(section.bulletOrder ?? {}) };
    let added = false;
    for (const [entryId, selected] of listed) {
      if (found[entryId]) continue;
      const entry = entries.find((e) => e.id === entryId);
      if (!entry) continue;
      const byMaster = orderedBullets(selected, entry);
      if (selected.some((id, i) => id !== byMaster[i])) {
        found[entryId] = 'manual';
        added = true;
      }
    }
    return added ? { ...section, bulletOrder: found } : section;
  });
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
  const lost: { kind: 'entry' | 'wording' | 'skill'; id: string }[] = [];
  /*
   * Resumes stand alone, so this is the resume — with one exception it costs
   * four lines to be right about.
   *
   * Specs reach here from places the store never saw: a preview of something
   * the extension proposed, an older client, a fixture. Any of those can
   * still carry the `extends` of a version that inherited, and dropping it
   * silently would render a different document from the one whoever wrote it
   * meant. So it is folded in, exactly as it used to be, and said out loud.
   * Everything loaded through the store arrives flat already and never takes
   * this branch. See flatten.ts.
   */
  const flat = spec.extends ? flattenOne(spec, data.resumes, warnings) : spec;
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
        /*
         * A pinned skill the store no longer has, said out loud.
         *
         * The two exactly parallel cases — a bullet whose wording was renamed,
         * an entry the section lists and the store has lost — both warn *and*
         * record into `lost`, which is what puts "1 entry this resume chose is
         * no longer in your store" in front of somebody about to attach the
         * file. This one dropped the item silently, so renaming or deleting a
         * skill made every resume pinning it print a shorter skills line with
         * nothing anywhere saying so.
         */
        const items: string[] = [];
        for (const iid of wanted ?? group.items.map((i) => i.id)) {
          const item = group.items.find((i) => i.id === iid);
          if (!item || !item.text) {
            warnings.push(`Skills group "${group.name}" no longer has the skill "${iid}", so it was left off.`);
            lost.push({ kind: 'skill', id: iid });
            continue;
          }
          items.push(item.text);
        }
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
  /*
   * A bullet id belongs to one line, everywhere.
   *
   * A chosen wording is recorded as `choices[bulletId]` with no entry beside
   * it, so two entries carrying a line with the same id share one choice. If
   * the second line has no wording by that name the resume falls back to its
   * default and says so a few lines below — but if it happens to have one, and
   * two entries minted from the same title usually do, the second line quietly
   * changes wording because of a decision made about the first. Nothing warns,
   * nothing looks wrong, and the difference is on the page that gets sent.
   *
   * The three places that mint bullet ids all keep them unique now, so this
   * cannot arise from anything made since. It is checked here for the saves
   * that predate that, because the alternative to a warning is silence.
   */
  const bulletOwner = new Map<string, string>();
  for (const e of data.entries) {
    for (const f of ['title', 'dates', 'subtitle', 'location'] as const) {
      if (isVariantField(e[f])) knownKeys.add(`${e.id}.${f}`);
    }
    for (const b of e.bullets ?? []) {
      knownKeys.add(b.id);
      const owner = bulletOwner.get(b.id);
      if (owner && owner !== e.id) {
        warnings.push(
          `Two entries carry a line with the id "${b.id}" — "${owner}" and "${e.id}". ` +
            'They share one chosen wording, so picking a wording on either can change the other.',
        );
      } else if (!owner) {
        bulletOwner.set(b.id, e.id);
      }
    }
  }
  /*
   * And a skills group id belongs to one group.
   *
   * Worse than the bullet case, because a section lists groups by id and the
   * lookup takes the first match: two groups named "Languages" print the
   * first one twice and the second one never, and choosing which of its items
   * to show edits the wrong group's list. The group you just made simply does
   * not appear, with nothing anywhere saying why.
   */
  const groupsSeen = new Set<string>();
  for (const g of data.skillGroups) {
    if (groupsSeen.has(g.id)) {
      warnings.push(
        `Two skills groups have the id "${g.id}". Only the first is ever printed, and choosing items edits that one.`,
      );
    }
    groupsSeen.add(g.id);
    const itemsSeen = new Set<string>();
    for (const i of g.items) {
      if (itemsSeen.has(i.id)) {
        warnings.push(`Skills group "${g.id}" lists two items with the id "${i.id}"; only the first can be chosen.`);
      }
      itemsSeen.add(i.id);
    }
  }
  for (const key of Object.keys(choices)) {
    if (!knownKeys.has(key)) {
      warnings.push(`Choice "${key}" does not match any field or bullet in the store.`);
      lost.push({ kind: 'wording', id: key });
    }
  }

  const layout = layoutFor(flat.layout, data.config?.layout);

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
