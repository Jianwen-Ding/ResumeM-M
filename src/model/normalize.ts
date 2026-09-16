import type { AnswerBankItem, Bullet, Entry, MaybeVariant, Variant, VariantField } from './types.js';

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

export function normalizeEntry(entry: Entry): Entry {
  const out: Entry = { ...entry, id: String(entry.id ?? '') };
  for (const name of ['title', 'dates', 'subtitle', 'location'] as const) {
    const field = normalizeField(entry[name]);
    if (field === undefined) delete out[name];
    else out[name] = field;
  }
  // A title is the one field that must print something.
  if (out.title === undefined) out.title = out.id;
  out.bullets = Array.isArray(entry.bullets) ? entry.bullets.map(normalizeBullet) : [];
  return out;
}

export function normalizeEntries(entries: unknown): Entry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => e && typeof e === 'object').map((e) => normalizeEntry(e as Entry));
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
