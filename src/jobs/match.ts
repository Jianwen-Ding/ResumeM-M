import type { ResumeSpec, StoreData, Variant } from '../model/types.js';
import { isVariantField } from '../model/types.js';
import { ALL_LEVEL_TAGS, tagsForLevel, type LevelVerdict } from './level.js';
import { inListOrder } from './aiPlan.js';
import { ORDINARY_WORDS, productsOf, sameTerm, spellingsOf } from './extract.js';

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
  // And every spelling of one thing as the one: "Postgres" is "PostgreSQL". See `ALIASES`.
  return sameTerm(s.toLowerCase().replace(/[^a-z0-9+#]/g, ''));
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
  // In any of its spellings: "k8s" answers "Kubernetes". See `ALIASES`.
  for (const said of spellingsOf(keyword)) {
    const written = spaced(said).trim();
    if (written && text.includes(` ${written} `)) return true;
    const glued = said.toLowerCase().replace(/[^a-z0-9+#]/g, '');
    if (glued && text.includes(` ${glued} `)) return true;
  }
  // A suite asked for is answered by any of its products. See `SUITES`.
  return productsOf(keyword).some((product) => text.includes(` ${spaced(product).trim()} `));
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
  /**
   * Offer a skill the base left off when the posting names it. Only where the
   * match is shown as boxes to tick — the card — and never where it is applied
   * outright, which is the Workspace's keyword tailor: there, a skill somebody
   * removed from their base came back with nothing to untick.
   */
  offerAdditions?: boolean;
}

/**
 * The words somebody has put in their own store to be matched on: every skill,
 * and every tag on a skill or a phrasing.
 */
function termsYouHave(data: StoreData): string[] {
  const terms = new Set<string>();
  const add = (term?: string) => {
    const said = (term ?? '').trim();
    if (said) terms.add(said);
  };
  for (const group of data.skillGroups ?? []) {
    for (const item of group.items ?? []) {
      add(item.text);
      for (const tag of item.tags ?? []) add(tag);
    }
  }
  for (const entry of data.entries ?? []) {
    for (const bullet of entry.bullets ?? []) {
      for (const variant of bullet.variants ?? []) for (const tag of variant.tags ?? []) add(tag);
    }
  }
  return [...terms];
}

/**
 * The posting's keywords, and every term of the applicant's own that it names.
 *
 * `extractKeywords` reads the posting against a fixed vocabulary, which is the
 * right way to find what a posting is about and the wrong way to find what it
 * shares with *you*: a posting asking for x86_64 named nothing the vocabulary
 * knew, so the skill "x86_64" in the store, and the phrasing tagged with it,
 * were never matched — the posting asked for it by name and nothing switched.
 * What somebody put in their store is exactly the vocabulary worth matching
 * them on, so it is read here too, as whole words and however the separators
 * are written ("x86_64", "x86-64", "x86 64").
 *
 * Short terms and everyday words are left to the vocabulary, which reads them
 * in context: "C" is a grade and "React" a verb far more often than either is
 * a language in a posting that does not otherwise say so.
 *
 * And the tags that are instructions rather than vocabulary are left alone
 * entirely. A level tag ("intern", "senior", "industry") says which kind of
 * hire a phrasing is for, and `considerLevel` reads it against what the
 * posting is for; as a keyword, an internship posting that says "industry
 * experience is a plus" scored every phrasing tagged for experienced hires up
 * by the three points a real skill gets, and swapped it in. "short" is for
 * fitting a page, which no posting's wording should reach.
 */
const NOT_VOCABULARY = new Set([...ALL_LEVEL_TAGS, 'short']);

export function withYourTerms<J extends { keywords: string[]; description: string }>(job: J, data: StoreData): J {
  const have = new Set(job.keywords.map(norm));
  const text = spaced(job.description ?? '');
  const added: string[] = [];
  for (const term of termsYouHave(data)) {
    const glued = norm(term);
    if (glued.length < 3 || /^\d+$/.test(glued) || have.has(glued) || ORDINARY_WORDS.has(glued)) continue;
    if (NOT_VOCABULARY.has(glued)) continue;
    if (!mentions(text, term)) continue;
    have.add(glued);
    added.push(term);
  }
  return added.length > 0 ? { ...job, keywords: [...job.keywords, ...added] } : job;
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

  /*
   * Only what this resume prints.
   *
   * This walked every entry in the store, so a wording swap was proposed for
   * a job the resume does not list and for a line it has switched off — rows
   * on the card whose box, ticked, changed nothing on the page. The same rule
   * the resolver prints by: an entry a section lists, and in it the lines that
   * section names for it, or every line it holds when the section names none.
   */
  const printed = new Map<string, Set<string> | null>();
  for (const section of base.sections ?? []) {
    for (const id of section.entries ?? []) {
      const listed = section.bullets?.[id];
      const prior = printed.get(id);
      if (!listed || prior === null) printed.set(id, null);
      else printed.set(id, new Set([...(prior ?? []), ...listed]));
    }
  }

  for (const entry of data.entries) {
    if (entry.archived || !printed.has(entry.id)) continue;
    const lines = printed.get(entry.id);
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
      if (b.archived || (lines && !lines.has(b.id))) continue;
      consider(b.id, b.variants, b.default);
    }
  }

  /*
   * Skills: narrow each group to the items the posting mentions, out of the
   * ones the base already prints — never switch on one the base left off.
   *
   * This read the whole group, so a skill somebody had deliberately turned
   * off on their base came back on the moment a posting named it. The
   * Workspace's keyword tailor applies the match outright, and an AI run that
   * says nothing about a group takes the match's list for it, so neither
   * offered a box to untick: the resume simply came out with skills the
   * applicant had removed. Choosing among what is already there is narrowing;
   * reaching past it is adding, and adding is the applicant's call (or the
   * AI's, which the card shows as its own box).
   *
   * A group the base's skills section does not list is not printed, so there
   * is nothing to narrow. A base with no skills section at all is answered as
   * before — `deriveSpec` has nowhere to write it, so it changes nothing.
   * Kept in the base's own order, and never narrowed to fewer than two.
   */
  const skills: Record<string, string[]> = {};
  const skillsSection = base.sections?.find((s) => s.kind === 'skills');
  for (const g of data.skillGroups) {
    if (skillsSection && !(skillsSection.groups ?? []).includes(g.id)) continue;
    const shown = skillsSection?.items?.[g.id];
    const pool = shown
      ? shown.map((id) => g.items.find((i) => i.id === id)).filter((i): i is (typeof g.items)[number] => Boolean(i))
      : g.items;
    const named = (i: (typeof g.items)[number]) =>
      (i.tags ?? []).some((t) => keywords.has(norm(t))) || keywords.has(norm(i.text));
    const relevant = pool.filter(named);
    const narrowed = relevant.length >= 2 && relevant.length < pool.length ? relevant.map((i) => i.id) : null;
    /*
     * And, where it is offered rather than applied, one the base left off that
     * the posting asks for by name — beside its neighbour in the group, after
     * what the base prints. The card shows it as an addition with its own box,
     * off until ticked. See `offerAdditions`.
     */
    const missing =
      opts.offerAdditions && shown ? g.items.filter((i) => !shown.includes(i.id) && named(i)).map((i) => i.id) : [];
    if (narrowed || missing.length > 0) {
      const kept = narrowed ?? pool.map((i) => i.id);
      skills[g.id] = inListOrder([...kept, ...missing], shown ?? kept, g.items.map((i) => i.id));
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
 *
 * `meta.at` is when `base` was read, and the copy is dated by it. The copy is
 * the base as it was then, and `/extension/fresh` asks whether the base has
 * changed since by comparing its file's time with this one. Dated when this
 * runs instead — at the end of an AI pass, minutes after the read — an edit
 * made to the base during the pass looked older than the copy and was never
 * reported. Without it, the copy is dated now.
 */
export function deriveSpec(
  base: ResumeSpec,
  id: string,
  label: string,
  match: MatchResult,
  meta: { url?: string; company?: string; role?: string; at?: string },
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
    generatedFor: { ...meta, at: meta.at ?? new Date().toISOString() },
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
