import type { ResolvedResume, ResumeSpec, StoreData } from '../model/types.js';
import { resolveResume } from '../model/resolve.js';
import type { Store } from '../model/store.js';

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

/**
 * One store's resumes' printed text, kept from the last time it was asked
 * for.
 *
 * Keyed by the `Store` instance itself, in a `WeakMap`, rather than by the
 * store's path or by one cache shared across every open save: a server can
 * switch which save is open (`POST /api/projects/switch`), and a second save
 * can have a resume with the same id as the first. Keying on the object that
 * *is* the open save means switching hands back a cache with nothing in it
 * for the new save, rather than one that might answer with the old save's
 * text; and once a `Store` is no longer the active one, nothing keeps its
 * entry here alive either.
 */
const printedTextByStore = new WeakMap<Store, Map<string, { stamp: string; text: string }>>();

/**
 * `printedText`, kept from last time when nothing that would change it has
 * moved on disk.
 *
 * Building it is most of what `fitResumes` costs — joining every bullet in
 * the resume and running a regex over the result — and a posting is
 * analysed far more often than a resume, an entry or a skill group is
 * edited. Measured on a store of three hundred resumes across four dozen
 * entries: rebuilding every resume's text on every call cost 260ms or more of
 * `fitResumes`' roughly 280ms; with nothing on disk changed between calls,
 * the cached answer brings that under a millisecond.
 *
 * `store.resumeTextStamp` is what decides "nothing has moved" — see its own
 * comment for which files a resume's printed text can depend on. Correctness
 * rides entirely on that stamp changing when any of them do; this function
 * itself just remembers the last text against the last stamp, per resume id.
 * One known gap: a legacy file still saying `extends` is folded from its
 * parent on read, and the parent's file is not in this resume's stamp — so a
 * restored pre-flattening save can show a stale fit until the child or an
 * entry changes. Only this score is affected, never a document.
 *
 * `sharedStamp` is `entriesAndSkillsStamp`'s answer, computed once by the
 * caller for the whole batch rather than once per resume here — see that
 * method's own comment for why asking it per-resume was most of this cache's
 * remaining cost.
 */
function cachedPrintedText(spec: ResumeSpec, data: StoreData, store: Store, sharedStamp: string): string {
  let byId = printedTextByStore.get(store);
  if (!byId) {
    byId = new Map();
    printedTextByStore.set(store, byId);
  }
  const stamp = store.resumeTextStamp(spec.id, sharedStamp);
  const hit = byId.get(spec.id);
  if (hit && hit.stamp === stamp) return hit.text;

  const text = printedText(resolveResume(spec, data));
  byId.set(spec.id, { stamp, text });
  return text;
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
  /**
   * The store `data` was loaded from, so the printed text of each resume can
   * be cached across calls. Optional, and correct without it — callers that
   * only have a `StoreData` (every test here, and any future caller with no
   * `Store` to hand) simply pay the full cost every time, exactly as before.
   */
  store?: Store,
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

  /*
   * Forget resumes that are no longer in the store, rather than growing the
   * cache for as long as the process runs. A resume the sweep or a delete has
   * taken away is never asked for again, so its entry would otherwise sit
   * here doing nothing until the server restarts.
   */
  const byId = store && printedTextByStore.get(store);
  if (byId && byId.size > resumes.length) {
    const keep = new Set(resumes.map((r) => r.id));
    for (const id of byId.keys()) if (!keep.has(id)) byId.delete(id);
  }

  // Computed once for the whole batch — see `entriesAndSkillsStamp`'s own
  // comment for why asking it once per resume instead was most of the cost
  // this cache was meant to remove.
  const sharedStamp = store?.entriesAndSkillsStamp();

  return resumes.map((spec) => {
    let text: string;
    try {
      text =
        store && sharedStamp !== undefined
          ? cachedPrintedText(spec, data, store, sharedStamp)
          : printedText(resolveResume(spec, data));
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
  /*
   * Everything level with the best, or nothing — a tie is not a ranking
   * either, and marking one of two equals would be inventing a difference.
   *
   * This took the first `room` of them, which is that invention whenever more
   * are level than there is room to mark: in a store of five, two resumes tied
   * at the top and the star went to whichever happened to be written first.
   * When the mark cannot go on all of them, the honest mark is none.
   */
  const level = ranked.filter((f) => f.hits === best.hits);
  return level.length > room ? new Set() : new Set(level.map((f) => f.id));
}
