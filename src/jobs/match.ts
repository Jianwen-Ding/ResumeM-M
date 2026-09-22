import type { ResumeSpec, StoreData, Variant } from '../model/types.js';
import { isVariantField } from '../model/types.js';
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
  /**
   * Per-change explanation, so nothing is swapped invisibly.
   *
   * `instruction` marks a row that came from a tag the applicant wrote on
   * their own variant rather than from anything read out of the posting — see
   * `considerLevel`. Both kinds are listed and both can be switched off; the
   * difference is which one arrives switched on, and the card reads this to
   * decide. Everything the keyword match infers starts off, because it is a
   * guess about words; an instruction starts on, because it is an answer the
   * applicant already gave to this exact question.
   */
  rationale: { key: string; from: string; to: string; because: string[]; instruction?: true }[];
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
      rationale.push({ key, from: currentId, to: pick.id, because: levelWhy, instruction: true });
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
    rationale.push({ key, from: currentId, to: fallback.id, because: levelWhy, instruction: true });
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
 * Build a posting-specific resume spec by copying a base one.
 *
 * A copy, not a link. This used to record `extends: base.id` and a handful of
 * overrides, so what the resume actually contained was worked out at render
 * time by laying one spec over another — which meant the file did not say
 * what the document was, and a copy made from a copy grew a chain nobody had
 * chosen. Resumes stand alone now: the base's selections come across whole,
 * the posting's changes are laid over them here, once, and from then on
 * editing either one leaves the other exactly as it was.
 *
 * `all` is no longer needed to know what the base holds, and is kept only so
 * the callers that pass it do not all have to change at once.
 */
export function deriveSpec(
  base: ResumeSpec,
  id: string,
  label: string,
  match: MatchResult,
  meta: { url?: string; company?: string; role?: string },
  _all: ResumeSpec[] = [],
): ResumeSpec {
  const spec: ResumeSpec = {
    ...base,
    id,
    label,
    /*
     * The base's choices underneath, the posting's over them. Only the second
     * half used to be written down, because the first half arrived through
     * inheritance; dropping it now would quietly revert every wording the
     * base had pinned back to the store's default.
     */
    choices: { ...(base.choices ?? {}), ...match.choices },
    sections: narrowSkills(base.sections, match.skills),
    generatedFor: { ...meta, at: new Date().toISOString() },
    /* Where it came from, as a record. Nothing merges behind it. */
    copiedFrom: base.id,
    /* Made for one posting, and swept a week after that posting is done. */
    tier: 'temporary',
  };

  /*
   * What the base *was*, as opposed to what it contained, does not come
   * across. A copy is not itself pinned as a base; it did not inherit the
   * explanation somebody wrote about a different document; and it has its own
   * `generatedFor`, set above — taking the base's would have it claiming it
   * was written for a posting it was not.
   */
  delete spec.base;
  delete spec.notes;
  delete spec.collapsed;
  delete spec.extends;
  if (!spec.sections) delete spec.sections;
  return spec;
}

/**
 * The base's sections, with the skills groups narrowed to what the posting
 * asked for.
 *
 * Narrowed in place rather than stated as an override. The override shape —
 * a bare `{ kind: 'skills', items }` leaning on the merge to supply `groups`
 * — was the right answer when a resume inherited, and is a section with no
 * groups at all now that it does not. What a person would have seen is the
 * skills heading and nothing under it.
 *
 * A base with no skills section is left alone: there is nothing to narrow,
 * and inventing one would print a heading the base never had.
 */
function narrowSkills(
  sections: ResumeSpec['sections'],
  skills: Record<string, string[]>,
): ResumeSpec['sections'] {
  if (!sections?.length || Object.keys(skills).length === 0) return sections;
  return sections.map((s) =>
    s.kind === 'skills' ? { ...s, items: { ...(s.items ?? {}), ...skills } } : s,
  );
}
