import { flattenSpec } from '../model/resolve.js';
import { isVariantField, type Bullet, type ResumeSpec, type SectionSpec, type StoreData } from '../model/types.js';

/**
 * What the AI is allowed to decide about a resume.
 *
 * The rule this file enforces: **the AI never writes a resume.** It may only
 * choose among things the person already wrote — which phrasing of a bullet to
 * use, which dates, which skills, and which entries and bullets to show. Every
 * sentence that reaches a PDF came from the store, which is what makes the
 * output safe to send without reading it word by word.
 *
 * (Cover letters and application answers are a different matter: prose is the
 * whole job there, and the AI writes it directly. This is about resumes.)
 *
 * So a reply is not applied, it is *validated*: every id has to exist, every
 * variant has to belong to the field it is chosen for, and anything else the
 * model felt like returning is dropped on the floor. A hallucinated variant id
 * would otherwise become a silently broken choice.
 */

export interface AiPlan {
  /** bulletId or "entryId.field" → variantId, both known to exist. */
  choices: Record<string, string>;
  /** groupId → item ids, all known to exist in that group. */
  skills: Record<string, string[]>;
  /** Entry and bullet ids to show. */
  enable: string[];
  /** Entry and bullet ids to leave off. */
  disable: string[];
  /**
   * A new order for the bullets inside an entry, and for the entries inside a
   * section, keyed by entry id and by section kind.
   *
   * A permutation and nothing else. The set of things on the page is decided
   * by `enable` and `disable`; this only says which comes first. An id that
   * is not shown is ignored, and anything shown but left out of the list keeps
   * its place in store order behind whatever was named — so a reply that
   * reorders two bullets and forgets the other four cannot delete them.
   *
   * Worth having because it is the cheapest real tailoring there is. A
   * posting about streaming ingest wants the Kafka line first, and the model
   * could not ask for that: it could swap a phrasing or hide a bullet, and
   * that was the whole vocabulary.
   */
  order: Record<string, string[]>;
  entryOrder: Record<string, string[]>;
  /** What was thrown away, so the caller can say the reply was partly junk. */
  rejected: string[];
}

const EMPTY: AiPlan = { choices: {}, skills: {}, enable: [], disable: [], order: {}, entryOrder: {}, rejected: [] };

function bulletsOf(data: StoreData): Map<string, { bullet: Bullet; entryId: string }> {
  const out = new Map<string, { bullet: Bullet; entryId: string }>();
  for (const entry of data.entries) {
    for (const bullet of entry.bullets ?? []) out.set(bullet.id, { bullet, entryId: entry.id });
  }
  return out;
}

/**
 * Keep only what the store can actually honour. Anything unrecognised is
 * rejected rather than passed through — a resume is not the place to find out
 * a model invented an id.
 */
export function sanitizeAiPlan(parsed: unknown, data: StoreData): AiPlan {
  if (!parsed || typeof parsed !== 'object') return EMPTY;
  const raw = parsed as Record<string, unknown>;
  const plan: AiPlan = { choices: {}, skills: {}, enable: [], disable: [], order: {}, entryOrder: {}, rejected: [] };

  const bullets = bulletsOf(data);
  const entries = new Map(data.entries.map((e) => [e.id, e]));

  /* Variant selections. */
  for (const [key, value] of Object.entries((raw.choices as Record<string, unknown>) ?? {})) {
    if (typeof value !== 'string') {
      plan.rejected.push(`choice ${key}: not a variant id`);
      continue;
    }
    /*
     * A bullet id first, then a field path. Routing on "does it contain a dot"
     * sent every dotted key to the field branch, so a bullet whose id has a dot
     * in it — hand-edited YAML is a supported way to author this store — had
     * its choice rejected as "no such field", while `resolveResume` honours
     * that same key everywhere else. Only the sanitiser disagreed, and the
     * result was tailoring that quietly declined to touch those bullets.
     */
    const dot = bullets.has(key) ? -1 : key.indexOf('.');
    if (dot > 0) {
      const entry = entries.get(key.slice(0, dot));
      const field = entry?.[key.slice(dot + 1) as 'title' | 'dates' | 'subtitle' | 'location'];
      if (!field || !isVariantField(field)) {
        plan.rejected.push(`choice ${key}: no such field`);
        continue;
      }
      if (!field.variants.some((v) => v.id === value)) {
        plan.rejected.push(`choice ${key}: "${value}" is not one of its phrasings`);
        continue;
      }
    } else {
      const found = bullets.get(key);
      if (!found) {
        plan.rejected.push(`choice ${key}: no such bullet`);
        continue;
      }
      if (!found.bullet.variants.some((v) => v.id === value)) {
        plan.rejected.push(`choice ${key}: "${value}" is not one of its phrasings`);
        continue;
      }
    }
    plan.choices[key] = value;
  }

  /* Skill item selections. */
  for (const [groupId, items] of Object.entries((raw.skills as Record<string, unknown>) ?? {})) {
    const group = data.skillGroups.find((g) => g.id === groupId);
    if (!group || !Array.isArray(items)) {
      plan.rejected.push(`skills ${groupId}: no such group`);
      continue;
    }
    /*
     * Which skills, from the model; how many and in what order, from the store.
     *
     * Keeping the reply's own list let it repeat an id, and `resolveResume`
     * maps the list straight to text — so {"sk_lang": ["s_py","s_py","s_go"]}
     * printed "Python, Python, Go" on the resume. It is also the one place this
     * file's rule that ordering never comes from the reply did not hold.
     */
    const wanted = new Set(
      items.filter((i): i is string => typeof i === 'string' && group.items.some((x) => x.id === i)),
    );
    if (wanted.size !== items.length) plan.rejected.push(`skills ${groupId}: dropped unknown items`);
    const known = group.items.filter((i) => wanted.has(i.id)).map((i) => i.id);
    if (known.length > 0) plan.skills[groupId] = known;
  }

  /* Showing and hiding. Entry ids and bullet ids share one namespace here
     because the model should not have to know which is which. */
  for (const field of ['enable', 'disable'] as const) {
    for (const id of (raw[field] as unknown[]) ?? []) {
      if (typeof id !== 'string') continue;
      if (entries.has(id) || bullets.has(id)) plan[field].push(id);
      else plan.rejected.push(`${field} ${id}: no such entry or bullet`);
    }
  }

  /* Ordering. A permutation of what is already there, never a way in. */
  for (const [entryId, ids] of Object.entries((raw.order as Record<string, unknown>) ?? {})) {
    const entry = entries.get(entryId);
    if (!entry || !Array.isArray(ids)) {
      plan.rejected.push(`order ${entryId}: no such entry`);
      continue;
    }
    const mine = new Set((entry.bullets ?? []).map((b) => b.id));
    const named = dedupe(ids.filter((i): i is string => typeof i === 'string' && mine.has(i)));
    if (named.length !== ids.length) plan.rejected.push(`order ${entryId}: dropped ids that are not its bullets`);
    if (named.length > 0) plan.order[entryId] = named;
  }

  for (const [kind, ids] of Object.entries((raw.entryOrder as Record<string, unknown>) ?? {})) {
    if (!Array.isArray(ids)) continue;
    const mine = new Set(data.entries.filter((e) => e.kind === kind).map((e) => e.id));
    const named = dedupe(ids.filter((i): i is string => typeof i === 'string' && mine.has(i)));
    if (named.length !== ids.length) plan.rejected.push(`entryOrder ${kind}: dropped ids that are not ${kind} entries`);
    if (named.length > 0) plan.entryOrder[kind] = named;
  }

  return plan;
}

/** First occurrence wins: a repeated id is a mistake, not an instruction. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * The named ones first, in the order given; everything else behind them, in
 * the order it already had.
 *
 * This is what makes ordering safe to accept from a model at all. The result
 * is always a permutation of `current` — nothing can be added by naming it and
 * nothing can be dropped by leaving it out.
 */
function reorder(current: string[], wanted: string[]): string[] {
  const named = wanted.filter((id) => current.includes(id));
  if (named.length === 0) return current;
  const rest = current.filter((id) => !named.includes(id));
  return [...named, ...rest];
}

/**
 * Turn "show these, hide those" into the section overrides a resume spec
 * carries, starting from what the base already shows. Order always comes from
 * the store, never from the reply, so a resume cannot be reshuffled into
 * something the person did not arrange.
 */
export function applyInclusion(base: ResumeSpec, data: StoreData, plan: AiPlan): SectionSpec[] | undefined {
  const reordering = Object.keys(plan.order).length > 0 || Object.keys(plan.entryOrder).length > 0;
  if (plan.enable.length === 0 && plan.disable.length === 0 && !reordering) return undefined;

  const flat = flattenSpec(base, data.resumes);
  const sections = (flat.sections ?? []).map((s) => ({
    ...s,
    entries: [...(s.entries ?? [])],
    bullets: { ...(s.bullets ?? {}) },
  }));

  const entryById = new Map(data.entries.map((e) => [e.id, e]));
  const bulletOwner = new Map<string, string>();
  for (const entry of data.entries) {
    for (const bullet of entry.bullets ?? []) bulletOwner.set(bullet.id, entry.id);
  }

  /** Which bullets a section shows for an entry, defaulting to all of them. */
  const shown = (section: (typeof sections)[number], entryId: string): string[] =>
    section.bullets?.[entryId] ??
    // Archived bullets are not "all of them": materialising them into an
    // explicit list is what resurrected retired text onto a tailored resume.
    (entryById.get(entryId)?.bullets ?? []).filter((b) => !b.archived).map((b) => b.id);

  for (const id of plan.disable) {
    const entry = entryById.get(id);
    if (entry) {
      for (const s of sections) s.entries = s.entries.filter((e) => e !== id);
      continue;
    }
    const ownerId = bulletOwner.get(id);
    if (!ownerId) continue;
    for (const s of sections) {
      if (!s.entries.includes(ownerId)) continue;
      s.bullets[ownerId] = shown(s, ownerId).filter((b) => b !== id);
    }
  }

  for (const id of plan.enable) {
    const entry = entryById.get(id);
    if (entry) {
      const section = sections.find((s) => s.kind === entry.kind);
      // Store order, not reply order: append where the store puts it.
      if (section && !section.entries.includes(id)) {
        const order = data.entries.filter((e) => e.kind === entry.kind).map((e) => e.id);
        section.entries = order.filter((e) => e === id || section.entries.includes(e));
      }
      continue;
    }
    const ownerId = bulletOwner.get(id);
    if (!ownerId) continue;
    for (const s of sections) {
      if (!s.entries.includes(ownerId)) continue;
      const all = (entryById.get(ownerId)?.bullets ?? []).map((b) => b.id);
      const current = new Set([...shown(s, ownerId), id]);
      s.bullets[ownerId] = all.filter((b) => current.has(b));
    }
  }

  /*
   * And last, the order — after showing and hiding have settled what is on
   * the page, because reordering a list that is about to lose an entry is
   * work thrown away, and because `shown` has to materialise the default list
   * before there is anything to permute.
   */
  for (const s of sections) {
    const wanted = plan.entryOrder[s.kind];
    if (wanted) {
      s.entries = reorder(s.entries, wanted);
      /*
       * And the sort steps aside, or the arrangement is thrown away between
       * here and the page.
       *
       * `adoptDateOrder` turns the date sort on for very nearly every
       * section, because it turns it on wherever it provably changes
       * nothing — so a plan that rearranged entries wrote the new list into
       * a section that then sorted by date and ignored it. The tool said it
       * had moved them, the plan showed them moved, and the document did
       * not, which is the worst shape this can take in something an agent is
       * trusting.
       *
       * The editor has always done this: dragging an entry there turns the
       * section's sort off in the same breath and says so on screen. This is
       * the same decision, made in the same place, for the same reason.
       */
      s.order = 'manual';
    }

    for (const entryId of s.entries) {
      const order = plan.order[entryId];
      if (!order) continue;
      s.bullets[entryId] = reorder(shown(s, entryId), order);
      /*
       * And this resume says it arranged these lines itself, rather than
       * leaving it to be inferred. The master decides the order of the lines
       * inside an entry, and a resume only escapes that by saying so — see
       * `SectionSpec.bulletOrder`. Without this the AI's arrangement was
       * restacked into the master's order on the way to the page.
       */
      s.bulletOrder = { ...(s.bulletOrder ?? {}), [entryId]: 'manual' };
    }
  }

  return sections;
}
