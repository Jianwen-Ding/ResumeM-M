import type { ResumeSpec, StoreData, Variant } from '../model/types.js';
import { isVariantField } from '../model/types.js';

/**
 * Deterministic variant matching on tags and keyword overlap. This runs with
 * no AI call at all, which matters for two reasons: it works offline and free,
 * and it gives the AI path a sensible starting point to disagree with rather
 * than a blank slate.
 */

export interface MatchResult {
  choices: Record<string, string>;
  skills: Record<string, string[]>;
  /** Per-change explanation, so nothing is swapped invisibly. */
  rationale: { key: string; from: string; to: string; because: string[] }[];
}

/** Normalise a tag or keyword so "front-end" and "frontend" compare equal. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#]/g, '');
}

/**
 * `keywords` maps the normalised form back to the wording the posting used, so
 * a match can be explained as "distributed systems" rather than the
 * "distributedsystems" the comparison runs on.
 */
function scoreVariant(v: Variant, keywords: Map<string, string>): { score: number; hits: string[] } {
  const hits: string[] = [];
  let score = 0;

  for (const tag of v.tags ?? []) {
    if (keywords.has(norm(tag))) {
      score += 3;
      hits.push(tag);
    }
  }

  // A variant that names a technology the posting names is relevant even when
  // nobody remembered to tag it.
  const text = spaced(v.text);
  for (const [key, original] of keywords) {
    if (key.length >= 3 && mentions(text, original)) {
      score += 1;
      if (!hits.includes(original)) hits.push(original);
    }
  }
  return { score, hits };
}

/*
 * Whole words, not substrings.
 *
 * `norm` deletes separators so "front-end" and "frontend" compare equal, and
 * the keyword test then ran `includes` against one unbroken string. Rust
 * matched "trust", iOS matched "ratios", and Java matched "ninja validation"
 * once the space between them was gone. The score moved, the variant was
 * swapped, and the user was shown "because: Rust, iOS, Java" — an explanation
 * of a match that was not there, about a resume line they were about to send.
 *
 * So the text keeps its word boundaries, and each keyword is looked for both as
 * it is written and with its separators closed up — which is what made
 * "front-end" against "frontend" work in the first place.
 */
function spaced(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim()} `;
}

function mentions(text: string, keyword: string): boolean {
  const written = spaced(keyword).trim();
  if (written && text.includes(` ${written} `)) return true;
  const glued = norm(keyword);
  return Boolean(glued) && text.includes(` ${glued} `);
}

export interface MatchOptions {
  keywords: string[];
  /**
   * Minimum score advantage over the current choice before a swap happens.
   * Higher is more conservative; the default only swaps on a clear signal.
   */
  threshold?: number;
  /** Tags that should never be auto-selected (e.g. `short`, used for fitting). */
  excludeTags?: string[];
}

export function matchVariants(data: StoreData, base: ResumeSpec, opts: MatchOptions): MatchResult {
  const keywords = new Map(opts.keywords.map((k) => [norm(k), k]));
  const threshold = opts.threshold ?? 3;
  const exclude = new Set((opts.excludeTags ?? ['short']).map(norm));

  const current = base.choices ?? {};
  const choices: Record<string, string> = {};
  const rationale: MatchResult['rationale'] = [];

  const consider = (key: string, variants: Variant[], defaultId: string) => {
    const currentId = current[key] ?? defaultId;
    const selectable = variants.filter((v) => !(v.tags ?? []).some((t) => exclude.has(norm(t))));
    if (selectable.length < 2) return;

    const scored = selectable.map((v) => ({ v, ...scoreVariant(v, keywords) }));
    const currentScore = scored.find((s) => s.v.id === currentId)?.score ?? 0;
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));

    if (best.v.id !== currentId && best.score - currentScore >= threshold) {
      choices[key] = best.v.id;
      rationale.push({ key, from: currentId, to: best.v.id, because: best.hits });
    }
  };

  for (const entry of data.entries) {
    if (entry.archived) continue;
    for (const f of ['title', 'dates', 'subtitle', 'location'] as const) {
      const field = entry[f];
      // Dates are never matched on keywords — graduation date is a fact about
      // the applicant, not something a job posting gets to influence.
      if (f === 'dates') continue;
      if (isVariantField(field)) consider(`${entry.id}.${f}`, field.variants, field.default);
    }
    for (const b of entry.bullets ?? []) {
      if (b.archived) continue;
      consider(b.id, b.variants, b.default);
    }
  }

  // Skills: keep any item the posting mentions, plus the ones already chosen,
  // and never drop a group to nothing.
  const skills: Record<string, string[]> = {};
  for (const g of data.skillGroups) {
    const relevant = g.items.filter(
      (i) => (i.tags ?? []).some((t) => keywords.has(norm(t))) || keywords.has(norm(i.text)),
    );
    if (relevant.length >= 2 && relevant.length < g.items.length) {
      skills[g.id] = relevant.map((i) => i.id);
    }
  }

  return { choices, skills, rationale };
}

/**
 * Build a posting-specific resume spec from a base one. It inherits rather
 * than copies, so later edits to the base still reach it.
 */
export function deriveSpec(
  base: ResumeSpec,
  id: string,
  label: string,
  match: MatchResult,
  meta: { url?: string; company?: string; role?: string },
): ResumeSpec {
  const sections = Object.keys(match.skills).length > 0 ? buildSkillSections(base, match.skills) : undefined;
  return {
    id,
    label,
    extends: base.id,
    choices: match.choices,
    ...(sections ? { sections } : {}),
    generatedFor: { ...meta, at: new Date().toISOString() },
  };
}

function buildSkillSections(base: ResumeSpec, skills: Record<string, string[]>): ResumeSpec['sections'] {
  const skillSection = base.sections?.find((s) => s.kind === 'skills');
  if (!skillSection) return undefined;
  return [
    {
      ...skillSection,
      items: { ...(skillSection.items ?? {}), ...skills },
    },
  ];
}
