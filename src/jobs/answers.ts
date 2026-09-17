import type { AnswerBankItem, CoverLetter, Variant } from '../model/types.js';

/**
 * Reusing what you already wrote, without an AI call.
 *
 * The premise of the answer bank is that application questions repeat: the
 * fifteenth "why are you interested in this role?" should start from the
 * fourteenth answer, not from an empty box. Matching is deterministic so this
 * works offline and costs nothing; the AI path only adapts what this finds.
 */

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'is', 'are', 'do', 'does',
  'you', 'your', 'yours', 'we', 'our', 'this', 'that', 'it', 'be', 'with', 'about', 'what', 'why',
  'how', 'would', 'will', 'can', 'please', 'describe', 'tell', 'us', 'if', 'any', 'have', 'has',
]);

/** Every word, common ones included: the fallback when filtering leaves nothing. */
function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter(Boolean),
  );
}

function terms(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/**
 * Jaccard-style overlap, biased toward covering the *stored* question: a short
 * stored question fully contained in a long page question is a good match, and
 * plain intersection-over-union would punish it for the length difference.
 */
export function questionSimilarity(a: string, b: string): number {
  let ta = terms(a);
  let tb = terms(b);

  /*
   * A question made entirely of ordinary words reduces to nothing, and scored
   * zero against everything — including itself. "Why us?" is the standing
   * example and a question real forms really ask: an answer stored for it could
   * never be found again, because the next "Why us?" did not match the last
   * one.
   *
   * So when *both* sides empty out, they are compared as written instead. Both,
   * not either: the first version of this fired whenever one side emptied, and
   * then a short question of ordinary words was fully "covered" by any longer
   * question containing them. Coverage carries most of the weight, so "Tell us
   * about you." matched "Tell us about a time you had to learn something
   * quickly." at 0.81 — over the confidence line, and a confident match is not
   * advisory: it is written into the application as the answer.
   *
   * Requiring both keeps what this was for. "Why us?" recognises "Why us?",
   * and against a question with any substance of its own it goes back to
   * scoring nothing, which is the honest answer.
   */
  if (ta.size === 0 && tb.size === 0) {
    ta = words(a);
    tb = words(b);
  }
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;

  /*
   * Coverage of the *stored* question, which is what the comment above always
   * said and `Math.min` did not do. Min also returns 1.0 when the asked
   * question is the shorter of the two — that is, when the stored question
   * carries qualifiers the form never asked about.
   *
   * Those qualifiers are the whole answer. "Are you legally authorized to work
   * in the United States?" against a stored "…without sponsorship?" scored
   * 0.914 and came back confident, and the stored answer was "No. I will
   * require H-1B sponsorship." A confident match is not advisory: it is written
   * into the draft, bundled, and sent — a false declaration about the
   * applicant's right to work, made on their behalf.
   */
  const coverage = shared / tb.size;
  const union = shared / (ta.size + tb.size - shared);
  return coverage * 0.7 + union * 0.3;
}

/**
 * Whether the stored question says nothing the asked question did not.
 *
 * Every meaningful word of the stored question has to appear in the one on the
 * page. A stored question with a word of its own is a question about something
 * else — "without sponsorship", "or misdemeanor", "active TS/SCI" — and the
 * answer to it is not the answer to this. The match is still offered; it is
 * just not claimed as safe to send unread.
 */
function fullyAsked(a: string, b: string): boolean {
  const ta = terms(a);
  const tb = terms(b);
  if (tb.size === 0) return ta.size === 0;
  for (const t of tb) if (!ta.has(t)) return false;
  return true;
}

export interface AnswerMatch {
  question: string;
  /** The stored item that best covers it, if any cleared the threshold. */
  item?: AnswerBankItem;
  variant?: Variant;
  answer?: string;
  score: number;
  /** True when the match is close enough to use as-is without editing. */
  confident: boolean;
}

export function matchAnswer(question: string, bank: AnswerBankItem[], threshold = 0.45): AnswerMatch {
  let best: { item: AnswerBankItem; score: number } | undefined;
  for (const item of bank) {
    const score = questionSimilarity(question, item.question);
    if (!best || score > best.score) best = { item, score };
  }

  if (!best || best.score < threshold) {
    return { question, score: best?.score ?? 0, confident: false };
  }

  const variant =
    best.item.variants.find((v) => v.id === best!.item.default) ?? best.item.variants[0];

  return {
    question,
    item: best.item,
    variant,
    answer: variant?.text,
    score: Number(best.score.toFixed(3)),
    /*
     * A near-identical question is safe to reuse verbatim; a loose one is a
     * starting point the user should read first. Near-identical means the
     * stored question asked nothing extra — a high score alone is not enough,
     * because adding a qualifier to a question only adds shared words.
     */
    confident: best.score >= 0.7 && fullyAsked(question, best.item.question),
  };
}

export function matchAnswers(questions: string[], bank: AnswerBankItem[], threshold?: number): AnswerMatch[] {
  return questions.map((q) => matchAnswer(q, bank, threshold));
}

/**
 * The previous letters most worth showing alongside a new one: same company
 * first, then most recent. Used both as AI context and, when the AI is off, as
 * the thing the user adapts by hand.
 */
export function relevantLetters(letters: CoverLetter[], job: { company?: string; role?: string }, limit = 3): CoverLetter[] {
  const score = (l: CoverLetter): number => {
    let s = 0;
    if (job.company && l.company && l.company.toLowerCase() === job.company.toLowerCase()) s += 10;
    if (job.role && l.role && overlapWords(l.role, job.role) > 0.5) s += 4;
    // Recency as a tiebreak, in days-ago descending.
    const age = l.createdAt ? (Date.now() - Date.parse(l.createdAt)) / 86_400_000 : 9999;
    return s - Math.min(age, 365) / 365;
  };
  return [...letters].sort((a, b) => score(b) - score(a)).slice(0, limit);
}

function overlapWords(a: string, b: string): number {
  const ta = terms(a);
  const tb = terms(b);
  if (ta.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / ta.size;
}

/** A stable id for a saved letter, readable in a directory listing. */
export function letterId(company: string | undefined, role: string | undefined, at = new Date()): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return [at.toISOString().slice(0, 10), company && slug(company), role && slug(role)]
    .filter(Boolean)
    .join('-');
}
