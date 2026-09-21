import { parsePeriod } from './period.js';
import type {
  AnswerBankItem,
  Application,
  ApplicationStatus,
  Bullet,
  Entry,
  MaybeVariant,
  Profile,
  SkillGroup,
  Variant,
  VariantField,
} from './types.js';

/**
 * Making the store's shape true before anything reads it.
 *
 * The store is hand-editable YAML — that is the point of it — so a file can
 * say `dates: {default: v_may}` with no variants under it, or a bullet can
 * lose its `variants:` key in a merge. Every consumer then either has to guard
 * or crash, and what actually happened was crash: "field.variants is not
 * iterable", from a `for…of` in the tailoring prompt, with nothing to say which
 * field or how to fix it.
 *
 * Guarding in fifty places is not a fix; fifty places is fifty chances to miss
 * one. So the shape is made true once, on the way in. Nothing is thrown away —
 * a malformed field keeps its key and gets an empty list of phrasings, which
 * the resolver already handles and reports as a warning, and the editor still
 * shows so it can be repaired.
 */

/** A variant is only a variant if it has an id and some text. */
function cleanVariants(raw: unknown): Variant[] {
  if (!Array.isArray(raw)) return [];
  const out: Variant[] = [];
  for (const [i, v] of raw.entries()) {
    if (!v || typeof v !== 'object') continue;
    const variant = v as Partial<Variant>;
    if (variant.text === undefined || variant.text === null) continue;
    out.push({
      ...variant,
      // YAML turns `text: 2026` into a number and `id: 1` into one too.
      id: String(variant.id ?? `v_${i + 1}`),
      label: String(variant.label ?? variant.id ?? `Option ${i + 1}`),
      text: String(variant.text),
    } as Variant);
  }
  return out;
}

/** Point `default` at something that exists, when anything does. */
function settleDefault(variants: Variant[], wanted: unknown): string {
  const asked = wanted === undefined || wanted === null ? '' : String(wanted);
  if (variants.some((v) => v.id === asked)) return asked;
  return variants[0]?.id ?? asked;
}

/**
 * A heading field: either a plain string, or a set of alternates. Anything else
 * — an object with no variants, a number, a null — becomes whichever of those
 * two it is closest to.
 */
export function normalizeField(field: unknown): MaybeVariant | undefined {
  if (field === undefined || field === null) return undefined;
  if (typeof field !== 'object') return String(field);

  const variants = cleanVariants((field as Partial<VariantField>).variants);
  return { ...(field as VariantField), variants, default: settleDefault(variants, (field as VariantField).default) };
}

export function normalizeBullet(bullet: Bullet): Bullet {
  const variants = cleanVariants(bullet.variants);
  const items = Array.isArray(bullet.items)
    ? bullet.items
        .filter((i) => i && typeof i === 'object' && i.text !== undefined && i.text !== null)
        .map((i, n) => ({ ...i, id: String(i.id ?? `i_${n + 1}`), text: String(i.text) }))
    : undefined;

  return {
    ...bullet,
    id: String(bullet.id ?? ''),
    variants,
    default: settleDefault(variants, bullet.default),
    ...(items ? { items } : {}),
  };
}

/**
 * The default phrasing of a field, for the two things that need one string
 * rather than the set: reading a date out of it, and showing it in a list.
 */
function defaultText(field: MaybeVariant | undefined): string {
  if (field === undefined) return '';
  if (typeof field === 'string') return field;
  const chosen = field.variants.find((v) => v.id === field.default) ?? field.variants[0];
  return chosen?.text ?? '';
}

export function normalizeEntry(entry: Entry): Entry {
  const out: Entry = { ...entry, id: String(entry.id ?? '') };
  for (const name of ['title', 'dates', 'subtitle', 'location'] as const) {
    const field = normalizeField(entry[name]);
    if (field === undefined) delete out[name];
    else out[name] = field;
  }
  /*
   * A title that is missing stays missing, and one that is the entry's own id
   * is treated as missing too.
   *
   * This line used to read `if (out.title === undefined) out.title = out.id`,
   * under the comment "a title is the one field that must print something".
   * What it printed was the slug. `resolveEntry` is written to catch exactly
   * that — "It used to fall back to `entry.id`, so a resume went out with
   * `exp_example_co` typeset in bold" — but every entry reaches the resolver
   * through here, so by the time it looked, `title.trim()` was non-empty and
   * the warning was unreachable. Clear the Company field in the editor and
   * `\textbf{exp\_helios}` went out on the PDF, with `build`, `check`, `apply`
   * and the editor all silent.
   *
   * The second half is the migration for saves that already have it on disk:
   * the substitution was written into the YAML by `saveEntry`, so removing the
   * fallback alone would leave those entries printing the slug for ever. Only
   * a plain string is undone — the bug could not produce a set of alternates —
   * and nobody names an entry after its own identifier.
   */
  if (typeof out.title === 'string' && out.title === out.id) delete out.title;
  /*
   * Filtered, like every other list in this file.
   *
   * `normalizeBullet` reads `bullet.variants` on its first line. A stray `-`
   * left behind after deleting a bullet's text is `null` to the YAML parser,
   * and the whole save became unopenable — "Cannot read properties of null
   * (reading 'variants')" on every screen, from a `Store.load()` that threw
   * before the machinery that says which file the problem is in could run.
   */
  out.bullets = Array.isArray(entry.bullets)
    ? entry.bullets.filter((b) => b && typeof b === 'object').map(normalizeBullet)
    : [];

  /*
   * A date the program can compare, read out of the words if the file does not
   * carry one yet.
   *
   * Here rather than in a migration script, because a migration only runs on
   * the stores it is pointed at: a save cloned from a machine still on the old
   * version, a file edited by hand, a resume restored out of git history. Doing
   * it on the way in means there is no such thing as a store that has not been
   * converted — the old shape simply works, and the new field gets written down
   * the next time the entry is saved.
   *
   * Nothing is thrown away and nothing is rewritten: `dates` is untouched, so
   * what prints on a resume is the same text it was before.
   */
  if (out.period === undefined) {
    const read = parsePeriod(defaultText(out.dates));
    if (read) out.period = read;
  }
  return out;
}

export function normalizeEntries(entries: unknown): Entry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => e && typeof e === 'object').map((e) => normalizeEntry(e as Entry));
}

/**
 * Skill groups, which were the one file read straight out of YAML and handed
 * on untouched.
 *
 * A dozen places walk this list without guarding — `for (const g of
 * data.skillGroups)` in the tailoring prompt and the job matcher, `g.items.join(', ')`
 * in the renderer, `group.items.find(...)` in the resolver. A group typed by
 * hand without an `items:` key is the easiest omission in the whole store to
 * make, and it took down the renderer, the matcher, the MCP session and the
 * skills tab together with "Cannot read properties of undefined (reading
 * 'length')" — a message naming neither the group nor the file.
 *
 * The coercions are the same ones `cleanVariants` does and for the same
 * reason: YAML turns `text: 2026` into a number and `id: 1` into one too, and
 * everything downstream calls string methods on both. The quotes a person
 * never typed cannot be recovered — `text: 1.10` is genuinely the number 1.1
 * by YAML's own rules, and it comes back as "1.1" — but a value that is still
 * a string cannot crash the page that prints it. Nothing is dropped: unknown
 * keys stay, because this file is hand-editable and a key somebody added is a
 * key somebody meant.
 */
export function normalizeSkillGroups(groups: unknown): SkillGroup[] {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((g) => g && typeof g === 'object')
    .map((g, n) => {
      const group = g as Partial<SkillGroup>;
      const items = Array.isArray(group.items) ? group.items : [];
      return {
        ...group,
        id: String(group.id ?? `g_${n + 1}`),
        name: String(group.name ?? group.id ?? `Group ${n + 1}`),
        items: items
          .filter((i) => i && typeof i === 'object' && i.text !== undefined && i.text !== null)
          .map((i, k) => ({ ...i, id: String(i.id ?? `s_${k + 1}`), text: String(i.text) })),
      } as SkillGroup;
    });
}

export function normalizeAnswers(answers: unknown): AnswerBankItem[] {
  if (!Array.isArray(answers)) return [];
  return answers
    .filter((a) => a && typeof a === 'object')
    .map((a, n) => {
      const item = a as Partial<AnswerBankItem>;
      const variants = cleanVariants(item.variants);
      return {
        ...item,
        id: String(item.id ?? `a_${n + 1}`),
        question: String(item.question ?? ''),
        variants,
        default: settleDefault(variants, item.default),
      } as AnswerBankItem;
    });
}

/**
 * The four stages that were dropped, and what they became.
 *
 * `oa` was a rung of its own between applied and interview; it is an
 * interview stage by any useful reading — they came back and there is
 * something to prepare for. The three endings differed only in whose decision
 * it was, which the history already records in words.
 *
 * Read on the way in rather than migrated on disk: a file written by an older
 * version, or by hand, keeps working, and nothing is rewritten under someone
 * who has not asked for it.
 */
const RETIRED_STATUSES: Record<string, ApplicationStatus> = {
  oa: 'interview',
  rejected: 'closed',
  ghosted: 'closed',
  withdrawn: 'closed',
};

const STAGES: ApplicationStatus[] = ['interested', 'applying', 'applied', 'interview', 'offer', 'closed'];

/** What this application's stage is called now. */
export function normalizeStatus(status: unknown): ApplicationStatus {
  const said = String(status ?? '').trim();
  if ((STAGES as string[]).includes(said)) return said as ApplicationStatus;
  return RETIRED_STATUSES[said] ?? 'interested';
}

export function normalizeApplications(apps: unknown): Application[] {
  if (!Array.isArray(apps)) return [];
  return apps
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({ ...(a as Application), status: normalizeStatus((a as Application).status) }));
}

/**
 * The name can carry alternates now, which means it can also arrive malformed —
 * `name: {default: v_legal}` with no variants under it — from the same
 * hand-edited YAML that motivated everything above. Same treatment: keep what
 * is there, make the shape true, let the resolver warn.
 */
export function normalizeProfile(profile: Profile): Profile {
  return { ...profile, name: normalizeField(profile.name) ?? '' };
}
