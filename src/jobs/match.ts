import type { ResumeSpec, StoreData, Variant } from '../model/types.js';
import { isVariantField } from '../model/types.js';
import { flattenSpec } from '../model/resolve.js';
import { ALL_LEVEL_TAGS, tagsForLevel, type LevelVerdict } from './level.js';

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
  /**
   * What kind of hire the posting is for, when it says clearly. Drives a
   * different and much narrower rule than keywords — see `considerLevel`.
   */
  level?: LevelVerdict | null;
}

export function matchVariants(data: StoreData, base: ResumeSpec, opts: MatchOptions): MatchResult {
  const keywords = new Map(opts.keywords.map((k) => [norm(k), k]));
  const threshold = opts.threshold ?? 3;
  const exclude = new Set((opts.excludeTags ?? ['short']).map(norm));
  const levelTags = opts.level ? tagsForLevel(opts.level.level) : null;
  const levelWhy = opts.level?.why ?? [];

  const current = base.choices ?? {};
  const choices: Record<string, string> = {};
  const rationale: MatchResult['rationale'] = [];

  const tagged = (v: Variant, set: Set<string>): boolean => (v.tags ?? []).some((t) => set.has(norm(t)));

  /**
   * Pick on the posting's level, if the applicant marked anything for it.
   *
   * Different in kind from the scoring below, and that difference is the whole
   * reason a date is allowed through here. Scoring reads the posting's
   * vocabulary and infers; this reads a tag the applicant wrote on their own
   * variant, which is an instruction left for exactly this moment — "this
   * ending is the one for internships". Nothing is inferred about the text, so
   * there is no way for a posting to talk a fact into changing. It either
   * matches an instruction or it does nothing.
   *
   * Returns whether it decided, so a field it left alone can still fall
   * through to keyword scoring.
   */
  const considerLevel = (key: string, selectable: Variant[], currentId: string, defaultId: string): boolean => {
    if (!levelTags) return false;
    const currentVariant = selectable.find((v) => v.id === currentId);

    const marked = selectable.filter((v) => tagged(v, levelTags));
    if (marked.length > 0) {
      // Already on one of them: the applicant's instruction is satisfied.
      if (marked.some((v) => v.id === currentId)) return true;
      const pick = marked
        .map((v) => ({ v, ...scoreVariant(v, keywords) }))
        .reduce((a, b) => (b.score > a.score ? b : a)).v;
      choices[key] = pick.id;
      rationale.push({ key, from: currentId, to: pick.id, because: levelWhy });
      return true;
    }

    /*
     * Nothing marked for this level, but the wording in place is marked for a
     * different one. That is the ordinary two-variant setup: a plain ending
     * and an "intern" ending, with the intern one selected from the last
     * application. Leaving it would carry an internship's graduation date onto
     * a new grad application, which is the exact failure this exists to stop.
     *
     * Only the field's own default is offered as the way off it. Any other
     * unmarked variant would be a guess about which neutral wording was meant,
     * and the default is the one the applicant already named as the answer
     * when nothing else applies.
     */
    if (!currentVariant || !tagged(currentVariant, ALL_LEVEL_TAGS)) return false;
    const fallback = selectable.find((v) => v.id === defaultId);
    if (!fallback || fallback.id === currentId || tagged(fallback, ALL_LEVEL_TAGS)) return false;
    choices[key] = fallback.id;
    rationale.push({ key, from: currentId, to: fallback.id, because: levelWhy });
    return true;
  };

  const consider = (key: string, variants: Variant[], defaultId: string, keywordsApply = true) => {
    const currentId = current[key] ?? defaultId;
    const selectable = variants.filter((v) => !(v.tags ?? []).some((t) => exclude.has(norm(t))));
    if (selectable.length < 2) return;

    if (considerLevel(key, selectable, currentId, defaultId)) return;
    if (!keywordsApply) return;

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
      if (!isVariantField(field)) continue;
      // Dates are never matched on keywords — graduation date is a fact about
      // the applicant, not something a job posting's vocabulary gets to
      // influence. A tag naming the posting's level still reaches them, because
      // that is the applicant's own instruction rather than the posting's.
      consider(`${entry.id}.${f}`, field.variants, field.default, f !== 'dates');
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
 *
 * `all` is every resume in the store, which is needed to see what the base
 * inherits — see `buildSkillSections`.
 */
export function deriveSpec(
  base: ResumeSpec,
  id: string,
  label: string,
  match: MatchResult,
  meta: { url?: string; company?: string; role?: string },
  all: ResumeSpec[] = [],
): ResumeSpec {
  const sections =
    Object.keys(match.skills).length > 0 ? buildSkillSections(base, match.skills, all) : undefined;
  return {
    id,
    label,
    extends: base.id,
    choices: match.choices,
    ...(sections ? { sections } : {}),
    generatedFor: { ...meta, at: new Date().toISOString() },
  };
}

/**
 * The skills section, narrowed to what the posting asked for.
 *
 * Looked up on the *flattened* base, not on its own sections. Almost nobody's
 * base states a skills section itself: the usual arrangement is one resume
 * holding the sections and "new grad" and "intern" extending it by a handful
 * of choices, which is the whole point of `extends`. Read off `base.sections`
 * alone, every one of those found nothing here and returned `undefined` — so
 * the match decided which skills to keep, said so in the change list, and the
 * resume that was compiled and sent had every group in full. The proposal and
 * the document disagreed, and the document was the one nobody looked at.
 *
 * What comes back is still a section for the derived resume to state as its
 * own, laid over what it inherits by `mergeSections`.
 */
function buildSkillSections(
  base: ResumeSpec,
  skills: Record<string, string[]>,
  all: ResumeSpec[],
): ResumeSpec['sections'] {
  const flat = base.extends ? flattenSpec(base, all) : base;
  const skillSection = flat.sections?.find((s) => s.kind === 'skills');
  if (!skillSection) return undefined;
  return [
    {
      ...skillSection,
      items: { ...(skillSection.items ?? {}), ...skills },
    },
  ];
}
