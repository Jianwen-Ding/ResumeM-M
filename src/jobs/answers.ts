import type { AnswerBankItem, CoverLetter, Variant } from '../model/types.js';
import { employerName } from '../model/applications.js';

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
 * The meaningful words `terms` is too coarse to see.
 *
 * `terms` drops anything of two characters or fewer, which is right for the
 * scoring — "an", "it", "so" are noise — and catastrophic for the handful of
 * short words that are the entire question: US, UK, EU, Go, R, C#. Dropping
 * them made "authorized to work in the US" and "…in the UK" identical to the
 * matcher, scoring 1.000 and coming back confident.
 *
 * Only tokens with a letter in them. A bare number is how forms pad
 * themselves — "(2 pages max)" — and demoting a match over one would cost a
 * read for nothing.
 */
function shortTerms(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length > 0 && w.length <= 2 && /[a-z]/.test(w) && !STOP.has(w)),
  );
}

/**
 * Two questions that disagree about a short word are about different things.
 *
 * A veto, like `namesAnother` and for the same reason: it can only ever take
 * confidence away, never grant it, so the worst it can do is ask somebody to
 * read an answer they would have sent anyway. The other direction sends a
 * false declaration about their right to work.
 */
function sameShortTerms(a: string, b: string): boolean {
  const ta = shortTerms(a);
  const tb = shortTerms(b);
  if (ta.size !== tb.size) return false;
  for (const t of tb) if (!ta.has(t)) return false;
  return true;
}

/**
 * Whether the stored question says nothing the asked question did not.
 *
 * Every meaningful word of the stored question has to appear in the one on the
 * page. A stored question with a word of its own is a question about something
 * else — "without sponsorship", "or misdemeanor", "active TS/SCI" — and the
 * answer to it is not the answer to this. The match is still offered; it is
 * just not claimed as safe to send unread.
 *
 * Except the furniture, which `unanswered` has always forgiven on the asked
 * side and this did not forgive on the stored side. So the bank matched one
 * way round and not the other: an answer kept from a form asking "How did you
 * hear about this position?" was confident on the next form asking "How did
 * you hear about us?" only if the two forms came in the other order. Measured
 * with a row saved from each wording and the other asked: "Are you willing to
 * relocate for this role?" then "Are you willing to relocate?" scored 0.67
 * and was left for the person, while the same pair reversed scored 0.90 and
 * was filled. "Position" and "role" are no more a qualifier on the first form
 * than on the second.
 */
function fullyAsked(a: string, b: string): boolean {
  const ta = terms(a);
  const tb = terms(b);
  if (tb.size === 0) return ta.size === 0;
  for (const t of tb) if (!ta.has(t) && !FURNITURE.has(t)) return false;
  return true;
}

/**
 * A question's meaningful words, with the furniture taken out.
 *
 * For the confidence line, which is a score and was reached through the
 * furniture: "How did you hear about this position?" against "How did you
 * hear about us?" shares two words of three and scores 0.67, under the 0.7
 * line, even though "position" is a word this file already says is not part
 * of the question. Scored again without it, the two are the same question.
 */
function bare(s: string): string {
  return [...terms(s)].filter((t) => !FURNITURE.has(t)).join(' ');
}

/**
 * Boilerplate a form adds that is not part of the question.
 *
 * These are the words that make an asked question longer without making it a
 * different question: the length limit beside the box, the word "optional",
 * the generic stand-in for the employer's name. Treating them as meaningful
 * would demote perfectly good matches for nothing.
 */
const FURNITURE = new Set([
  'optional', 'required', 'max', 'maximum', 'min', 'minimum', 'limit', 'words', 'word',
  'characters', 'chars', 'briefly', 'brief', 'below', 'above', 'field', 'question',
  'company', 'organisation', 'organization', 'employer', 'position', 'role', 'team',
  /*
   * And the other names a form gives the thing being applied for. "How did
   * you hear about this job?" and "…about this opportunity?" are how Lever
   * and Workday put the question Greenhouse puts as "…about us?", and with
   * `position` and `role` forgiven and these not, the answer given to one was
   * left for the person on the other.
   */
  'job', 'opportunity', 'opening', 'vacancy', 'posting',
]);

/**
 * What the page is asking that the stored question did not.
 *
 * `fullyAsked` checks one direction — that the stored question said nothing
 * extra — and the other direction was free. It is not free. A question can be
 * made to mean the opposite, or something else entirely, purely by adding
 * words, and every one of those additions scores as shared vocabulary:
 *
 *     stored "Why should we hire you?"
 *     asked  "Why should we not hire you?"                     0.90, confident
 *
 *     stored "Are you legally authorized to work in the US?"
 *     asked  "Are you NOT legally authorized to work in the US?"  0.95, confident
 *
 *     stored "Do you have a driver's license?"
 *     asked  "...suspended or revoked in the last five years?"  0.78, confident
 *            handing back "Yes, a full clean licence since 2019."
 *
 * `sameShortTerms` catches "no" because it is two characters; "not", "never"
 * and "cannot" are three or more and fell through to `terms`, where an extra
 * word on the asked side costs nothing. And `confident` is not advisory — it
 * writes the answer into the box, badges it "answered before", and it lands
 * verbatim in the file the employer reads.
 *
 * So: nothing the page added may be meaningful. The employer's own name is
 * allowed, since "Why do you want to work at Acme?" is the same question as
 * "Why do you want to work here?", and so is the furniture above. Everything
 * else — a negation, a technology, a narrowing clause — takes the confidence
 * away and leaves the match offered, which is what that distinction is for.
 * This can only ever remove confidence, never grant it.
 */
function unanswered(asked: string, stored: string, company?: string): string[] {
  const known = terms(stored);
  const theirs = company ? terms(company) : new Set<string>();
  return [...terms(asked)].filter(
    (t) =>
      !known.has(t) &&
      !theirs.has(t) &&
      !FURNITURE.has(t) &&
      // A bare number is how a form pads itself — "(500 characters max)",
      // "(2 pages max)" — and demoting a match over one would cost a read for
      // nothing. `shortTerms` skips them for the same reason. A number that
      // is part of the question is written out: "in the last five years".
      !/^\d+$/.test(t),
  );
}

/**
 * A question asking for something the bank must never hold at all: a Social
 * Security Number, a date of birth, a passport number, a home address.
 *
 * Every other guard in this file takes confidence away from a match that is
 * still offered for a person to read — a company mismatch, a negation, a
 * narrower question. There is no reading of an SSN or a date of birth that
 * makes handing it back safe: it is not this employer's business whether the
 * bank has ever seen one, and a stored answer that happens to look right is
 * still somebody's identifier, sitting in a file that gets copied, committed
 * and read by whatever this store is shared with next. So this is checked
 * before anything else runs, and it does not merely withhold `confident` —
 * it withholds the match entirely, the one guard here that can.
 */
const SENSITIVE_QUESTION = [
  /\bsocial\s*security(\s*number)?\b/i,
  /\bssn\b/i,
  /\bdate\s*of\s*birth\b/i,
  /\bdob\b/i,
  /\bpassport(\s*(number|no\.?|#))?\b/i,
  /\b(home|mailing|residential|street)\s*address\b/i,
  /\b(birth\s*date|birthday)\b/i,
  /\bnational\s*(id|identity|insurance)(\s*(number|no\.?|#))?\b/i,
  /\b(tax\s*(id|identification)|tin|itin)\b/i,
  // The same families `redactIdentifiers` takes out: a Canadian SIN (in
  // capitals, because "sin" is a word), a UK NI number, a driving licence.
  /\bsocial\s*insurance(\s*(number|no\.?|#))?\b/i,
  /\bSIN\b/,
  /\bNI\s*(number|no\.?|#)/i,
  /\bdriv(er'?s?|ing)\s*licen[cs]e\b/i,
  /\b(bank\s*account|routing\s*number|iban|sort\s*code)\b/i,
  /\b(credit|debit)\s*card\b/i,
];

/**
 * An answer that is itself an identifier, whatever the question called it.
 *
 * The question list above cannot know every way a form words it ("Tax
 * reference", "Govt. ID #"), so the value is looked at too: an SSN's
 * 3-2-4 shape, a run of 13 to 19 digits (a card), an IBAN.
 */
const SENSITIVE_ANSWER = [
  /\b\d{3}[- ]\d{2}[- ]\d{4}\b/,
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/,
  // A UK National Insurance number, by the shape `redactIdentifiers` uses.
  /\b[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/,
];

/**
 * A card number, not any long number: a card issuer's prefix and a valid
 * Luhn check digit. A plain 13-to-19 digit rule refused ordinary answers —
 * a timestamp, an order number — which is a save that silently fails.
 */
function containsCardNumber(answer: string): boolean {
  for (const run of answer.match(/\b(?:\d[ -]?){12,18}\d\b/g) ?? []) {
    const digits = run.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!/^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5))/.test(digits)) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/**
 * The same identifiers, taken out of a longer text rather than refused.
 *
 * A file dropped into the corpus is somebody's old paperwork as often as their
 * writing — an offer letter with a social security number, an application
 * with a date of birth, a form with a card number — and the whole of it went
 * to the AI to be sorted and into the corpus every later prompt reads. A
 * letter with an identifier in it is still a letter worth keeping, so the
 * identifier is replaced, not the file refused. Dates of birth and passport
 * numbers only where they are labelled: a bare date is a date, and "passport
 * holder" is a phrase. Returns how many were taken out, so it can be said.
 */
export function redactIdentifiers(text: string): { text: string; redacted: number } {
  let redacted = 0;
  const hide = (s: string, re: RegExp, keep?: (m: string, ...g: string[]) => string) =>
    s.replace(re, (m: string, ...g: string[]) => {
      redacted++;
      return keep ? keep(m, ...g) : '[redacted]';
    });
  let out = String(text ?? '');
  out = hide(out, /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g);
  out = hide(out, /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g);
  out = out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (run) => {
    if (!containsCardNumber(run)) return run;
    redacted++;
    return '[redacted]';
  });
  out = hide(
    out,
    /\b(date of birth|birth ?date|d\.?o\.?b\.?)(\s*[:\-]?\s*)(\d{1,4}[\/.\- ]\d{1,2}[\/.\- ]\d{1,4}|[A-Z][a-z]+ \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]+ \d{4})/gi,
    (_m, label, gap) => `${label}${gap}[redacted]`,
  );
  out = hide(
    out,
    /\b(passport(?:\s+(?:no\.?|number|#))?)(\s*[:\-#]?\s*)([A-Z]{0,2}\d[A-Z0-9]{5,8})\b/gi,
    (_m, label, gap) => `${label}${gap}[redacted]`,
  );
  /*
   * The other national numbers, where they are named. An SSN without its
   * dashes, a Canadian SIN, a driver's licence, a tax id: a bare nine digits
   * is an order number as often as anything, so only a number that follows
   * its own label, and only one with five digits or more in it — "SIN wave",
   * "a driver's license and a car" are words, and are left.
   */
  out = out.replace(
    /\b(ssn|social\s+security(?:\s+(?:no\.?|number|#))?|social\s+insurance(?:\s+(?:no\.?|number))?|sin|national\s+insurance(?:\s+(?:no\.?|number))?|ni\s+(?:no\.?|number)|driv(?:er'?s?|ing)\s+licen[cs]e(?:\s+(?:no\.?|number|#))?|tax\s+(?:id|identification)(?:\s+(?:no\.?|number))?|itin)(\s*(?:is\s+)?[:\-#]?\s*)([A-Z]{0,5}\d[A-Z0-9]*(?:[ \-][A-Z]?\d[A-Z0-9]*)*)/gi,
    (m, label: string, gap: string, value: string) => {
      if ((value.match(/\d/g) ?? []).length < 5) return m;
      redacted++;
      return `${label}${gap}[redacted]`;
    },
  );
  // A UK National Insurance number has a shape nothing else shares.
  out = hide(out, /\b[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g);
  return { text: out, redacted };
}

/**
 * `redactIdentifiers` over every string in a value, keys left alone.
 *
 * For what is handed to the model as a file rather than as text: the MCP
 * session sits in the directory the CLI runs in, and a coding CLI reads it
 * with its own file tools, past the redaction the prompt and the tool results
 * get. Ids, numbers and the shape of the data are untouched.
 */
export function redactDeep<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactIdentifiers(v).text;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

export function isSensitiveAnswer(answer: string): boolean {
  return SENSITIVE_ANSWER.some((re) => re.test(answer)) || containsCardNumber(answer);
}

export function isSensitiveQuestion(question: string): boolean {
  return SENSITIVE_QUESTION.some((re) => re.test(question));
}

/**
 * Whether two stored questions are the same question, allowing for the kind
 * of difference a person retyping it introduces rather than a difference in
 * what is being asked: leading and trailing space, doubled interior spaces,
 * and case. Anything past that — a real wording change — is a new question,
 * because that is what `questionSimilarity` is for; this exists only to stop
 * "Why do you want to work here?" and "why do you want to work here? " from
 * living in the bank as two separate items with nobody ever finding the
 * second one.
 */
export function sameQuestion(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
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
  /**
   * The employer this answer talks about, when that is not the one being
   * applied to. "Why do you want to work here?" is answered by naming the
   * company, so the answer you wrote for Acme says Acme — and a bank that
   * hands it over for the next application hands over a sentence addressed to
   * the wrong people.
   */
  namesAnother?: string;
}

/**
 * Whether this answer talks about a particular employer, as a whole word.
 *
 * Only names the bank has actually seen: each variant is labelled with the
 * company it was written for, so the set of names to look for is the set of
 * companies answers have been written for. Nothing is guessed at, and a name
 * that has never been an employer here is never mistaken for one.
 */
function mentions(text: string, name: string): boolean {
  if (name.trim().length < 3) return false;
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
}

/*
 * Labels the tools give an answer themselves, which name no one: the server's
 * "Saved", the extension's "Chosen on a form", the seed bank's "Generic (edit
 * per company)".
 */
const TOOL_LABEL = /^(saved|chosen on a form|generic\b.*|default|base)$/i;

/**
 * Every employer the bank has written an answer for.
 *
 * A label is taken for one only when it could be one. Every label used to be,
 * so the seed bank's "May 2026" — the label of the answer "May 2026" — named
 * an employer called "May 2026", and the graduation date, the sponsorship
 * "Yes" and anything saved from a form came back never confident, the card
 * warning that each named somebody else. A label that only repeats its own
 * answer names the answer; the tools' own labels name nobody.
 */
function employersInBank(bank: AnswerBankItem[]): string[] {
  const names = new Set<string>();
  for (const item of bank) {
    for (const v of item.variants) {
      const label = (v.label ?? '').trim();
      if (label.length < 3 || TOOL_LABEL.test(label)) continue;
      if (label.toLowerCase() === (v.text ?? '').trim().toLowerCase()) continue;
      names.add(label);
    }
  }
  return [...names];
}

export function matchAnswer(
  question: string,
  bank: AnswerBankItem[],
  options: number | { threshold?: number; company?: string } = {},
): AnswerMatch {
  // The threshold used to be the third argument, and callers pass it that way.
  const { threshold = 0.45, company } = typeof options === 'number' ? { threshold: options } : options;

  // See `isSensitiveQuestion`: an SSN, a date of birth, a passport number, a
  // home address never come back from the bank, not even as a loose read-first
  // suggestion. Checked before the bank is even searched, so nothing about
  // what is stored — or whether anything is stored — leaks through the score.
  if (isSensitiveQuestion(question)) return { question, score: 0, confident: false };
  // And never hand back a stored value that is itself an identifier — one
  // banked before these checks existed, or under a question worded past them.
  bank = bank.filter((item) => !item.variants.some((v) => isSensitiveAnswer(v.text)));

  let best: { item: AnswerBankItem; score: number } | undefined;
  for (const item of bank) {
    const score = questionSimilarity(question, item.question);
    if (!best || score > best.score) best = { item, score };
  }

  if (!best || best.score < threshold) {
    return { question, score: best?.score ?? 0, confident: false };
  }

  /*
   * The one written for these people, when there is one.
   *
   * Every variant carries the company it was written for, because that is
   * what the Workspace labels it with on the way in. Applying to somewhere
   * you have applied before should hand back what you said to *them*, not
   * the default, which is whatever was written last.
   */
  /*
   * One employer, however it is written: "Acme, Inc." on the posting and
   * "Acme" on the form are the same people, and the answer written for one
   * was being called somebody else's on the other — vetoed, and the variant
   * written for them passed over. See `employerName`.
   */
  const who = (name: string) => employerName(name).toLowerCase();
  const forThisCompany = company
    ? best.item.variants.find((v) => who(v.label ?? '') === who(company))
    : undefined;
  const variant = forThisCompany ?? best.item.variants.find((v) => v.id === best!.item.default) ?? best.item.variants[0];

  const text = variant?.text ?? '';
  const ours = who(company ?? '');
  const namesAnother = forThisCompany
    ? undefined
    : employersInBank(bank).find((name) => who(name) !== ours && mentions(text, name));

  return {
    question,
    item: best.item,
    variant,
    answer: text || undefined,
    score: Number(best.score.toFixed(3)),
    /*
     * A near-identical question is safe to reuse verbatim; a loose one is a
     * starting point the user should read first. Near-identical means neither
     * question asked anything the other did not — a high score alone is not
     * enough, because adding a qualifier to a question only adds shared words,
     * and adding "not" to one adds a word that reverses it. See `unanswered`.
     *
     * And an answer that names somebody else is never safe to reuse verbatim,
     * however exactly the question matches: that is the one failure this
     * whole tool exists to prevent.
     */
    confident:
      !namesAnother &&
      // Or the same score with the furniture out of it. See `bare`.
      (best.score >= 0.7 || questionSimilarity(bare(question), bare(best.item.question)) >= 0.7) &&
      fullyAsked(question, best.item.question) &&
      unanswered(question, best.item.question, company).length === 0 &&
      sameShortTerms(question, best.item.question),
    ...(namesAnother ? { namesAnother } : {}),
  };
}

export function matchAnswers(
  questions: string[],
  bank: AnswerBankItem[],
  options?: number | { threshold?: number; company?: string },
): AnswerMatch[] {
  return questions.map((q) => matchAnswer(q, bank, options ?? {}));
}

/**
 * The previous letters most worth showing alongside a new one: same company
 * first, then most recent. Used both as AI context and, when the AI is off, as
 * the thing the user adapts by hand.
 */
export function relevantLetters(letters: CoverLetter[], job: { company?: string; role?: string }, limit = 3): CoverLetter[] {
  const score = (l: CoverLetter): number => {
    let s = 0;
    // One employer however it is written — see `employerName`.
    if (job.company && l.company && employerName(l.company).toLowerCase() === employerName(job.company).toLowerCase()) s += 10;
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
