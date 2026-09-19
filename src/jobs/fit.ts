import type { ResolvedResume, ResumeSpec, StoreData } from '../model/types.js';
import { resolveResume } from '../model/resolve.js';

/**
 * How well each resume already suits a posting, before anything is tailored.
 *
 * The store fills up with resumes — a new grad one, a summer intern one, a
 * systems-leaning one, one built for a posting last March — and the picker
 * listed them in whatever order they were written. So the first decision of
 * every application, which resume to start from, was made from labels alone,
 * and the label is the one thing that does not say what is in the document.
 *
 * What this measures is deliberately narrow: how much of the posting's own
 * vocabulary the resume already contains, as it would print. Not a judgement
 * about the applicant, not a prediction about the employer, and nothing a
 * model decided — the same keywords the deterministic match runs on, counted
 * against the same resolved text that would be typeset. It is a reading aid
 * for a list, and it is right to treat it as one: two resumes a point apart
 * are not meaningfully different, which is why `recommend` below refuses to
 * mark anything when the field is flat.
 *
 * Counted on the *untailored* resume on purpose. Every resume in the list
 * would gain from being matched against this posting, so scoring the tailored
 * version would mostly measure how much the match could do — which is a fact
 * about the store's alternates, not about which resume to start from.
 */

/** Normalise a keyword the way `match.ts` does, so the two agree. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#]/g, '');
}

/**
 * Word boundaries kept, separators closed up.
 *
 * Lifted from `match.ts` for the same reason it exists there: `includes` over
 * an unbroken string matched "Rust" inside "trust" and "Java" across "ninja
 * validation". A fit score built on that would rank resumes by accident.
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

/** Everything the resume would print, as one lowercased run of words. */
function printedText(resume: ResolvedResume): string {
  const parts: string[] = [];
  for (const section of resume.sections) {
    parts.push(section.heading);
    for (const entry of section.entries) {
      parts.push(entry.title, entry.subtitle ?? '', entry.location ?? '');
      for (const bullet of entry.bullets) parts.push(bullet.text);
    }
    for (const group of section.skillGroups) {
      parts.push(group.name, ...group.items);
    }
  }
  return spaced(parts.join(' '));
}

export interface ResumeFit {
  id: string;
  /** How many of the posting's keywords this resume already uses. */
  hits: number;
  /** Those keywords, as the posting wrote them — so the card can say why. */
  because: string[];
  /** `hits` as a share of the keywords asked about, 0–1. */
  share: number;
}

/**
 * Score every resume in the store against one posting.
 *
 * A resume that cannot be resolved — a dangling entry id, a save half
 * migrated — scores nothing rather than throwing. The picker has to be able
 * to list a broken resume: not being able to *choose* it is how somebody
 * loses the only copy of something.
 */
export function fitResumes(
  data: StoreData,
  keywords: string[],
  resumes: ResumeSpec[] = data.resumes,
): ResumeFit[] {
  /*
   * Deduplicated, because a posting that says "Kubernetes" four times is not
   * asking for it four times — and without this a resume matching one
   * repeated word would outrank one matching three distinct ones.
   */
  const asked = new Map<string, string>();
  for (const k of keywords) {
    const key = norm(k);
    if (key.length >= 2 && !asked.has(key)) asked.set(key, k);
  }

  return resumes.map((spec) => {
    let text: string;
    try {
      text = printedText(resolveResume(spec, data));
    } catch {
      return { id: spec.id, hits: 0, because: [], share: 0 };
    }
    const because: string[] = [];
    for (const original of asked.values()) if (mentions(text, original)) because.push(original);
    return {
      id: spec.id,
      hits: because.length,
      because,
      share: asked.size ? because.length / asked.size : 0,
    };
  });
}

/**
 * Which of those are worth marking as the ones to start from.
 *
 * Three rules, and all three exist to stop the mark being noise:
 *
 * A mark on everything says nothing, so at most a third of the list can carry
 * one, and never more than three.
 *
 * A mark on the best of a bad field is worse than nothing — it reads as "this
 * one suits the posting" when what happened is that it suited it least badly.
 * So there is a floor: a resume has to use at least a fifth of what the
 * posting asks about, and at least two of its words.
 *
 * And a field that is flat is not a ranking. If the top resume is not clearly
 * ahead of the median, nothing is marked: the honest answer to "which of
 * these suits it best" is sometimes "it makes no difference", and a picker
 * that says so is more use than one that always points somewhere.
 */
export function recommend(fits: ResumeFit[]): Set<string> {
  const ranked = [...fits].sort((a, b) => b.hits - a.hits);
  const best = ranked[0];
  if (!best || best.hits < 2 || best.share < 0.2) return new Set();

  const median = ranked[Math.floor(ranked.length / 2)]?.hits ?? 0;
  if (best.hits - median < 2) return new Set();

  const room = Math.min(3, Math.max(1, Math.floor(fits.length / 3)));
  // Everything level with the best, up to the cap — a tie is not a ranking
  // either, and marking one of two equals would be inventing a difference.
  return new Set(ranked.filter((f) => f.hits === best.hits).slice(0, room).map((f) => f.id));
}
