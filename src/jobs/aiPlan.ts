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
  /** What was thrown away, so the caller can say the reply was partly junk. */
  rejected: string[];
}

const EMPTY: AiPlan = { choices: {}, skills: {}, enable: [], disable: [], rejected: [] };

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
  const plan: AiPlan = { choices: {}, skills: {}, enable: [], disable: [], rejected: [] };

  const bullets = bulletsOf(data);
  const entries = new Map(data.entries.map((e) => [e.id, e]));

  /* Variant selections. */
  for (const [key, value] of Object.entries((raw.choices as Record<string, unknown>) ?? {})) {
    if (typeof value !== 'string') {
      plan.rejected.push(`choice ${key}: not a variant id`);
      continue;
    }
    const dot = key.indexOf('.');
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
    const known = items.filter((i): i is string => typeof i === 'string' && group.items.some((x) => x.id === i));
    if (known.length !== items.length) plan.rejected.push(`skills ${groupId}: dropped unknown items`);
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

  return plan;
}

/**
 * Turn "show these, hide those" into the section overrides a resume spec
 * carries, starting from what the base already shows. Order always comes from
 * the store, never from the reply, so a resume cannot be reshuffled into
 * something the person did not arrange.
 */
export function applyInclusion(base: ResumeSpec, data: StoreData, plan: AiPlan): SectionSpec[] | undefined {
  if (plan.enable.length === 0 && plan.disable.length === 0) return undefined;

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

  return sections;
}
