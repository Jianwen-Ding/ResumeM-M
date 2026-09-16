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
   * So when either side empties out, both are compared as written instead.
   * That is enough for the same question to recognise itself without letting it
   * match a different one: "Why us?" against "What are your salary
   * expectations?" still shares nothing at all.
   */
  if (ta.size === 0 || tb.size === 0) {
    ta = words(a);
    tb = words(b);
  }
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const coverage = shared / Math.min(ta.size, tb.size);
  const union = shared / (ta.size + tb.size - shared);
  return coverage * 0.7 + union * 0.3;
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
    // A near-identical question is safe to reuse verbatim; a loose one is a
    // starting point the user should read first.
    confident: best.score >= 0.7,
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
