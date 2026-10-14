import type { AnswerBankItem, CoverLetter, Variant } from '../model/types.js';
import { employerName, localDay } from '../model/applications.js';
import { looksLikeCompanyName } from './extract.js';
import { requisitionOf } from './names.js';

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

/*
 * The same question, worded the ways forms word it.
 *
 * Measured with a row typed on one form and the same question asked by the
 * next, none of these was confident, so the person typed the answer again:
 *
 *     "Expected salary"        "Salary expectations"      inflection, order
 *     "Portfolio link"         "Portfolio URL"            a synonym
 *     "Current employer"       "Who is your current employer?"   framing
 *     "Are you 18 or older?"   "Are you at least 18?"     an age, put two ways
 *
 * So both questions are read the same way before they are compared: the
 * framing taken off the front, an age threshold written as one token, each
 * word taken back to its stem, and a handful of words that name the same
 * thing given one name. Every guard below still runs on what comes out, so
 * this can only make two wordings of one question the same question — a
 * word that differs ("current" and "expected", "earliest" and "latest",
 * "first" and "last") still differs after it.
 */

/*
 * A question's opening that asks for the thing and is not the thing: "Who is
 * your current employer?" asks for the current employer. Only at the start,
 * and only in front of "your", because that is where it is framing — "Who
 * referred you?" is a question about who, and "State" alone is a place.
 * "What is your" was already all stop words; "who", "enter" and "provide"
 * were not, and each counted as a word the stored question never asked.
 */
const FRAMING =
  /^\s*(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:enter|provide|give|list|share|state|specify|indicate|confirm|tell\s+us|let\s+us\s+know)|(?:who|what)(?:\s+(?:is|are)|['’]s))\s+your\b/i;

/*
 * A minimum age, however it is put: "18 or older", "18 years of age or
 * older", "18+", "at least 18", "over the age of 18", "older than 18". All
 * become `agemin18`, one word with the number in it, so that 18 and 21 stay
 * different questions — a bare number is otherwise forgiven as padding (see
 * `unanswered`), and "at least 21" is not what "at least 18" asked.
 *
 * Only a number put as an age: one not followed by some other unit, so "at
 * least 3 years of experience" and "10+ years" are left as they are. And only
 * the "at least" direction — "under 18" and "younger than 18" are the other
 * question, and are left alone to stay different from it. "Over 18" is
 * here, unlike "over 5 years" below, because as an age it is the everyday
 * way of saying "18 or older", and forms use the two for the same box.
 */
const AGE_UNIT = String.raw`(?:\s+years?(?:\s+of\s+age|\s+old)?)?`;
const NOT_A_UNIT = String.raw`(?!\s*(?:\+|years?|yrs?|months?|weeks?|days?|hours?|%|[a-z0-9]))`;
const AGE_MINIMUM = [
  new RegExp(
    String.raw`\b(?:the\s+age\s+of\s+)?(\d{2})${AGE_UNIT}\s*(?:or\s+(?:older|over|above)|\+)${NOT_A_UNIT}`,
    'gi',
  ),
  new RegExp(
    String.raw`\b(?:at\s+least|over|above|older\s+than)\s+(?:the\s+age\s+of\s+)?(\d{2})${AGE_UNIT}(?:\s+or\s+(?:older|over|above))?${NOT_A_UNIT}`,
    'gi',
  ),
];

/*
 * And any other minimum: "5+ years", "at least 5 years", "5 or more years".
 * Numbers of one or two digits are too short to be terms, so "Do you have 5+
 * years of Python experience?" and "...3+ years..." were the same question
 * to the matcher, scored 1.000 and came back confident — as "Are you 21 or
 * older?" and "Are you 18 or older?" did. Written as `min5`, the number is a
 * word the two questions do not share. Only these three ways of saying "at
 * least": "more than 5" and "over 5" are left as they are, because a person
 * with exactly five years answers them differently.
 */
const AT_LEAST = [/\b(\d{1,3})\s*\+/g, /\b(?:at\s+least|minimum\s+of)\s+(\d{1,3})\b/g, /\b(\d{1,3})\s+or\s+more\b/g];

/** The question as it is compared: framing off, an age or a minimum as one token. */
function normalise(s: string): string {
  // As a person reads it, so a row kept as "SchoolSchool" is found by "School". See `tidyQuestion`.
  let out = tidyQuestion(s).toLowerCase().replace(FRAMING, ' ');
  for (const re of AGE_MINIMUM) out = out.replace(re, (_m, age: string) => ` agemin${age} `);
  for (const re of AT_LEAST) out = out.replace(re, (_m, n: string) => ` min${n} `);
  return out;
}

/*
 * Words a stem must never become, because a guard reads them: "note" is not
 * "not", "none" is not "non", "willing" is not "will".
 */
const NEGATION = new Set(['no', 'not', 'non', 'nor', 'never', 'none']);

/*
 * One name for things forms call by several. Keyed by stem, so "URLs",
 * "websites" and "links" are all one word. Deliberately short: a synonym is
 * a claim that two questions are the same question, and "site" is not on it
 * because "on site" is a working arrangement, not a web address.
 */
const SAME_THING: Record<string, string> = {
  url: 'link',
  websit: 'link',
  homepag: 'link',
  compens: 'salary',
  desir: 'expect',
};

/*
 * A word taken back to its stem, lightly: a plural, then one ending. Enough
 * that "expected", "expecting" and "expectations" are one word, and
 * "relocate", "relocating" and "relocation" another, without the reach of a
 * full stemmer — every merge here is two words becoming one, and a merge
 * that should not have happened is a false match. Numbers, and words of
 * three letters or fewer, are left as written.
 */
const ENDINGS = ['ation', 'ating', 'ated', 'ment', 'ness', 'ing', 'ed', 'ate', 'e'];

function stem(w: string): string {
  if (FURNITURE.has(w) || /[0-9+#]/.test(w)) return w;
  if (w.length < 4) return SAME_THING[w] ?? w;
  let s = w;
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith('s') && !/(?:ss|us|is)$/.test(s)) s = s.slice(0, -1);
  // "positions", "jobs", "openings": still the furniture they were.
  if (FURNITURE.has(s)) return s;
  const plural = s;
  for (const ending of ENDINGS) {
    if (!s.endsWith(ending) || s.length - ending.length < 3) continue;
    s = s.slice(0, -ending.length);
    // "preferred" is "prefer", "planning" is "plan".
    if ((ending === 'ed' || ending === 'ing') && /([^aeiouylsz])\1$/.test(s)) s = s.slice(0, -1);
    break;
  }
  if (NEGATION.has(s) || STOP.has(s)) s = plural;
  return SAME_THING[s] ?? s;
}

function tokens(s: string): string[] {
  return normalise(s).split(/[^a-z0-9+#]+/).filter(Boolean);
}

/*
 * Read once per string, not once per comparison.
 *
 * Matching a form against the bank compares every question asked with every
 * question stored, and each comparison read both questions into words from
 * scratch: a hundred questions against a bank of 540 re-read the same 540
 * stored questions a hundred times over, and took over a second. The words of
 * a question do not change between one comparison and the next, so they are
 * kept, keyed by the text. Bounded, because the server runs for days and
 * every question any form ever asked would otherwise stay in memory; when it
 * fills it starts again, which costs one re-read each and changes no answer.
 *
 * The sets handed back are shared, so they are read-only: nothing that takes
 * one may add to it or take from it.
 */
const READ_LIMIT = 5000;

function remembered<T>(fn: (s: string) => T): (s: string) => T {
  const seen = new Map<string, T>();
  return (s: string) => {
    let out = seen.get(s);
    if (out === undefined) {
      if (seen.size >= READ_LIMIT) seen.clear();
      out = fn(s);
      seen.set(s, out);
    }
    return out;
  };
}

/** Every word, common ones included: the fallback when filtering leaves nothing. */
const words = remembered((s: string): ReadonlySet<string> => new Set(tokens(s)));

/*
 * Words of three letters or more — and the short ones that are a language's
 * whole name. `tokens` keeps "#" and "+" so that C, C# and C++ are three
 * words, but the length cut then threw "c#" away along with "c", and
 * "C# Skill Proficiency Levels" read as exactly "C Skill Proficiency
 * Levels": the bank's answer about C came back for a question about C#. A
 * word with a letter and a "#" or "+" in it is never noise, so it stays.
 */
const terms = remembered(
  (s: string): ReadonlySet<string> =>
    new Set(
      tokens(s)
        .filter((w) => (w.length > 2 || (/[a-z]/.test(w) && /[+#]/.test(w))) && !STOP.has(w))
        .map(stem),
    ),
);

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
  return overlap(ta, tb);
}

/** The score itself, over two questions already read into terms. */
function overlap(ta: ReadonlySet<string>, tb: ReadonlySet<string>): number {
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
  return new Set(tokens(s).filter((w) => w.length > 0 && w.length <= 2 && /[a-z]/.test(w) && !STOP.has(w)));
}

/*
 * What a form says about the box rather than the question: "(500 characters
 * max)", "250 words or fewer", "(2 pages maximum)". Its number is padding;
 * every other number is part of what is asked.
 */
const LENGTH_LIMIT =
  /\b(?:max(?:imum)?\.?\s+(?:of\s+)?|up\s+to\s+|limit(?:\s+of)?\s+)?\d[\d,]*\s*(?:characters?|chars?|words?|pages?|sentences?)\b(?:\s*(?:max(?:imum)?|limit|or\s+(?:less|fewer)))?/gi;

/** The numbers a question asks about, written one way: "3.0" is "3", "100,000" is "100000". */
function numbers(s: string): Set<string> {
  const text = tidyQuestion(s).replace(LENGTH_LIMIT, ' ');
  return new Set((text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => String(Number(n.replace(/,/g, '')))));
}

/**
 * Two questions that ask about different numbers ask different things.
 *
 * `terms` drops anything of two characters or fewer, `shortTerms` wants a
 * letter, and `unanswered` forgives a bare number, so between them a number
 * was invisible: "Do you have 3 years of experience?" was confidently
 * answered with what was said to "…5 years…", a GPA above 3.0 with what was
 * said about 3.5, three days in the office with what was said about five.
 * A veto like the others, so it can only take confidence away; the length
 * limit beside the box is left out of it, being the form's and not the
 * question's.
 */
function sameNumbers(a: string, b: string): boolean {
  const na = numbers(a);
  const nb = numbers(b);
  if (na.size !== nb.size) return false;
  for (const n of na) if (!nb.has(n)) return false;
  return true;
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
function bare(s: string): Set<string> {
  return new Set([...terms(s)].filter((t) => !FURNITURE.has(t)));
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
/*
 * Except that the employer's name is only free where the stored question had
 * something standing in for it. "Why do you want to work at Acme?" is "Why do
 * you want to work here?"; but "Are you currently employed at Acme?" is not
 * "Are you currently employed?", and the bank's "Yes" — true of the person,
 * employed somewhere — was filled in confidently as a claim to work at the
 * employer being applied to. Likewise "Have you applied to Acme before?"
 * against "Have you applied before?", and "…relocate to Acme?" against
 * "…relocate?". A stored question with no "here", "us", "our" or "this
 * company" in it was never about these people, so their name is a word it
 * did not answer.
 */
function unanswered(asked: string, stored: string, company?: string): string[] {
  const known = terms(stored);
  const theirs = company && standsInForThem(stored) ? terms(company) : new Set<string>();
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

/*
 * The words a form uses in place of the employer's name. "us" only in lower
 * case: "the US" is a country.
 */
const STAND_IN = /\b(?:here|our|ours|(?:this|your|the)\s+(?:company|organi[sz]ation|employer|firm|team))\b/i;

function standsInForThem(stored: string): boolean {
  const text = tidyQuestion(stored);
  return STAND_IN.test(text) || /\bus\b/.test(text);
}

/*
 * Which way a question points: at a floor or at a ceiling.
 *
 * "min", "max", "above" and "below" were furniture, forgiven on either side
 * as the words a length limit is written in. So "Minimum salary expectation"
 * and "Maximum salary expectation" were one question, "Is your cumulative GPA
 * above 3.5?" was "…below 3.5?", and the figure or the "Yes" given to one
 * was filled confidently into the other. They are still forgiven inside a
 * length limit — "(500 characters max)" is taken out first, as it is for
 * `numbers` — and an age or a minimum already written as one word ("18 or
 * over", "at least 3") has none left; anywhere else, two questions that
 * point opposite ways are not the same question, nor is one the page points
 * that the stored question did not. A veto, so it can only take confidence
 * away.
 */
const FLOOR = new Set(['min', 'minimum', 'below', 'under', 'lowest']);
const CEILING = new Set(['max', 'maximum', 'above', 'over', 'highest']);

const directions = remembered((s: string): { floor: boolean; ceiling: boolean } => {
  const said = normalise(String(s ?? '').replace(LENGTH_LIMIT, ' ')).split(/[^a-z0-9]+/);
  return { floor: said.some((w) => FLOOR.has(w)), ceiling: said.some((w) => CEILING.has(w)) };
});

/*
 * Opposite ways, or a way the page added. A stored question that said more —
 * "available for a minimum 12 week internship?" — still answers the plainer
 * one, as any stored qualifier the page did not repeat does.
 */
function sameDirection(asked: string, stored: string): boolean {
  const a = directions(asked);
  const s = directions(stored);
  if ((a.floor && s.ceiling && !s.floor) || (a.ceiling && s.floor && !s.ceiling)) return false;
  return (!a.floor || s.floor) && (!a.ceiling || s.ceiling);
}

/*
 * The employer, or the job at it: two different things, both furniture.
 *
 * Forgiving "company", "employer", "position" and "role" is right where they
 * stand in for the one being applied to — "How did you hear about this
 * position?" is "…about us?" — and wrong where they are the thing asked for.
 * "Most recent employer" and "Most recent role" were the same question, and a
 * company's name was typed into the box for a job title; "Current job title"
 * answered "Current employer". So a question naming the company and one
 * naming the role, each not as a stand-in ("this", "our", "that"), are two
 * questions. A veto: it can only take confidence away.
 */
const COMPANY_WORD = /^(?:compan(?:y|ies)|employers?|organi[sz]ations?|firms?)$/;
const ROLE_WORD = /^(?:positions?|roles?|titles?)$/;
const STANDING_IN = new Set(['this', 'our', 'that']);

const namesWhich = remembered((s: string): { company: boolean; role: boolean } => {
  const said = normalise(s).split(/[^a-z0-9]+/).filter(Boolean);
  const out = { company: false, role: false };
  said.forEach((w, i) => {
    if (STANDING_IN.has(said[i - 1] ?? '')) return;
    if (COMPANY_WORD.test(w)) out.company = true;
    else if (ROLE_WORD.test(w)) out.role = true;
  });
  return out;
});

function sameThingNamed(a: string, b: string): boolean {
  const na = namesWhich(a);
  const nb = namesWhich(b);
  if (na.company === nb.company && na.role === nb.role) return true;
  return !((na.company && nb.role) || (na.role && nb.company));
}

/*
 * A question that is little more than its furniture.
 *
 * "Current position" is {current} once "position" is forgiven, and so is
 * "Current company", "Current team" and "Current role": scored without the
 * furniture they were all one question, and the company's name went into the
 * box for a position. Where the furniture is most of what is asked, it has
 * to match. And a label that names a thing is not a yes-or-no question: a
 * row kept from a tick box as "Is current position?" = "No" was confidently
 * the answer to a box labelled "Current position".
 */
const NOUN_FURNITURE = new Set([
  'company', 'organisation', 'organization', 'employer', 'position', 'role', 'team',
  'job', 'opportunity', 'opening', 'vacancy', 'posting',
]);

const ASKS_YES_OR_NO =
  /^(?:are|is|was|were|do|does|did|have|has|had|will|would|can|could|may|might|shall|should)\b/i;

function asksYesOrNo(q: string): boolean {
  return ASKS_YES_OR_NO.test(tidyQuestion(q).replace(/^[^\p{L}\p{N}]+/u, ''));
}

/*
 * A label rather than a sentence: a word or two once the furniture is out,
 * and nothing that asks — no question mark, no "Are you", no "Why".
 */
const ASKS = /^(?:why|what|how|which|who|where|when|tell|describe|explain|list|share)\b/i;

function thin(q: string): boolean {
  const said = tidyQuestion(q).replace(/^[^\p{L}\p{N}]+/u, '');
  return bare(q).size <= 1 && !said.includes('?') && !asksYesOrNo(said) && !ASKS.test(said);
}

function sameFurnitureWhenThin(asked: string, stored: string): boolean {
  if (!thin(asked) && !thin(stored)) return true;
  // One name for each thing: "Current employer" is "Current Company/Employer".
  const kind = (t: string) => (COMPANY_WORD.test(t) ? 'company' : ROLE_WORD.test(t) ? 'role' : t);
  const furniture = (s: string) => [...new Set([...terms(s)].filter((t) => NOUN_FURNITURE.has(t)).map(kind))].sort().join(' ');
  return furniture(asked) === furniture(stored) && asksYesOrNo(asked) === asksYesOrNo(stored);
}

/*
 * A row whose question is one of the answers.
 *
 * A form whose question the extension could not find, and whose options it
 * could, banked the first option as the question: "Yes Required" = "No",
 * "No, I don't have an agreement Required" = "Yes, I have an agreement",
 * "Yes, and I would require relocation assistance Required" = "Yes, but I am
 * planning to relocate on my own" — and a tick box's own words as both,
 * "Yes, I live in the U.S." = "Yes, I live in the U.S.". None of them is a
 * question anybody asks; each is an option on some other form, and a form
 * asked about it would be answered with the opposite option. So such a row
 * is never offered, and never banked, and an option is never looked up as a
 * question.
 */
const OPTION_PHRASE = /^(?:yes|no|y|n|true|false)(?:\s*[,.;:!–—-](?:\s*.*)?|\s+(?:and|but|i|i'm|i am|we)\b.*)?$/i;

export function isOptionPhrase(question: string): boolean {
  const q = tidyQuestion(question).replace(/\s+(?:required|optional)$/i, '').trim();
  return OPTION_PHRASE.test(q) && !q.includes('?');
}

function askedAsItsOwnAnswer(item: AnswerBankItem): boolean {
  return isOptionPhrase(item.question) || item.variants.some((v) => sameQuestion(v.text, item.question));
}

/*
 * A dropdown's prompt, kept as though it were the answer chosen.
 *
 * "— Please Specify —" and "— Select —" are what a select shows before
 * anything is chosen. The extension's test for a prompt did not allow for
 * the dashes round them, so "Willingness to Travel" and "Candidate Source"
 * were banked with the prompt as the answer, and offered back as one. The
 * dashes, brackets and angle brackets round it are taken off first; then
 * only a prompt and nothing else, so "Please see my portfolio" is an answer.
 */
const PROMPT_ENDS = /^[\s\-–—_=*.:|[\]<>(){}]+|[\s\-–—_=*.:|[\]<>(){}]+$/g;
const PROMPT =
  /^(?:(?:please\s+)?(?:select|choose|pick|specify)(?:\s+(?:one|an?\s+(?:option|answer|value|item)|from\s+(?:the\s+)?list|below))?|)$/i;

export function isPrompt(answer: string): boolean {
  const said = String(answer ?? '').trim();
  if (!said) return false;
  return said === '…' || PROMPT.test(said.replace(PROMPT_ENDS, '').replace(/\s+/g, ' ').trim());
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
/*
 * A Medicare or Medicaid number, named either way or both ("Medicare/Medicaid
 * number"). The number, not the words: "Have
 * you worked with Medicare claims data?" is a question about work.
 */
const MEDICARE_NUMBER =
  /\bmedica(re|id)\b(\s*(\/|or|and|&)\s*medica(re|id)\b)?\s*(number|no\b\.?|#|id\b|card|beneficiary)/i;
const SENSITIVE_QUESTION = [
  /\bsocial\s*security(\s*number)?\b/i,
  /\bssn\b/i,
  /\bdate\s*of\s*birth\b/i,
  /\bdob\b/i,
  /\bpassport(\s*(number|no\.?|#))?\b/i,
  /\b(home|mailing|residential|street|postal)\s*address\b/i,
  // And the address in parts, which is the same address a box at a time —
  // "Address Line1" too, where no word break falls between the line and its
  // number, and which `(line|[12])\b` therefore never reached.
  /\baddress\s*(line\s*\d*|\d)\b/i,
  /*
   * And the address however else it is qualified: "What is your current full
   * address?", "Permanent address", "Your address". Each qualifier is one
   * that only a place to live takes — "your email address" and "current
   * email address" are left alone, because `email` stands between.
   */
  /\b(current|full|permanent|present|physical|residence|legal)\s+((current|full|permanent|home|residential|street|mailing|postal|physical)\s+)*address\b/i,
  /\byour\s+address\b/i,
  /^\s*address\s*[:*?]?\s*$/i,
  /\b(zip|postal)\s*(code)?\b|\bpostcode\b/i,
  /\b(apartment|apt)\b/i,
  /\b(birth\s*date|birthday)\b/i,
  /*
   * Where somebody was born, which `date of birth` and `birthday` did not
   * reach: "Place of birth", "Country of birth", "Birthplace", "Where were
   * you born?". The same words JobHelper's remembering.js refuses.
   */
  /\b(place|country|city|town|state|province|county|region)\s*of\s*birth\b/i,
  /\bbirth\s*(place|country|city|town)\b/i,
  /\bwhere\s+(were|was)\s+you\s+born\b/i,
  // A Medicare or Medicaid number, a government health identifier.
  MEDICARE_NUMBER,
  /\bnational\s*(id|identity|insurance)(\s*(number|no\.?|#))?\b/i,
  /\b(tax\s*(id|identification)|tin|itin)\b/i,
  // The same families `redactIdentifiers` takes out: a Canadian SIN (in
  // capitals, because "sin" is a word), a UK NI number, a driving licence.
  /\bsocial\s*insurance(\s*(number|no\.?|#))?\b/i,
  /\bSIN\b/,
  /\bNI\s*(number|no\.?|#)/i,
  // With a curly apostrophe too, the way a word processor writes "Driver’s".
  /\bdriv(er['’]?s?|ing)\s*licen[cs]e\b/i,
  /\b(bank\s*account|routing\s*number|iban|sort\s*code)\b/i,
  /\b(credit|debit)\s*card\b/i,
  /*
   * What JobHelper's remembering.js refuses and this list did not know, and
   * the national numbers `redactIdentifiers` takes out by name, which neither
   * refused: a government ID however it is shortened, a state or citizen ID,
   * India's Aadhaar, Singapore's NRIC and FIN, Brazil's CPF, Spain's DNI and
   * NIE, Poland's PESEL, the Dutch BSN, the Swedish personnummer, a visa,
   * card or account number, a taxpayer reference, and the answers to a
   * security check. The short names in capitals, as forms write them,
   * because "nie" and "dni" are words.
   */
  /\b(national|government|gov(?:ernmen|['’])?t\.?|state|citizen|personal)[\s-]*(issued[\s-]*)?(id|identity|identification)\b/i,
  /\b(aadhaa?r|pesel|personnummer)\b/i,
  /\b(NRIC|FIN|CPF|DNI|NIE|BSN)\b/,
  /\b(visa|account|card)\s*(number|no\.?|#)/i,
  /\btax\s*payer\b/i,
  /\bpassword\b/i,
  /\bsecurity\s*question\b/i,
  /\bmother['’]?s\s*maiden\b/i,
  /*
   * And the self-identification block, which is not an identifier but is
   * never anybody else's business either: the extension refuses it on the
   * page, and this refused nothing of it, so a client that let one through —
   * "Veterans Status", which the extension's \bveteran\b did not reach — had
   * it banked and offered to the next employer.
   */
  /\bveterans?\b/i,
  /\bdisab(led|ility|ilities)\b/i,
  /\b(race|racial|ethnicit(y|ies))\b/i,
  /\b(hispanic|latin[oaxe]s?)\b/i,
  /\bgender\b/i,
  /\bsexual\s*orientation\b/i,
  /\btransgender\b/i,
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
 * A card number, not any long number: a card network's prefix and a valid
 * Luhn check digit. Every network's — JCB, Diners Club, UnionPay and the
 * rest of Discover's went unrecognised when only four were known. A plain 13-to-19 digit rule refused ordinary answers —
 * a timestamp, an order number — which is a save that silently fails.
 */
function containsCardNumber(answer: string): boolean {
  for (const run of answer.match(/\b(?:\d[ -]?){12,18}\d\b/g) ?? []) {
    const digits = run.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    // Visa, Mastercard, Amex, Diners Club, JCB, Discover and UnionPay.
    if (!/^(?:4|5[1-5]|2[2-7]|3[47]|3(?:0[0-5]|[689])|35(?:2[89]|[3-8])|6(?:011|2|4[4-9]|5))/.test(digits)) continue;
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
/*
 * What a form puts between a label and its value, and a review step writes
 * out with both: the format it wants, "(MM/DD/YYYY)", "(no dashes)", and the
 * star that marks it required. With only a colon, a dash or a space allowed
 * there, "Date of Birth (MM/DD/YYYY): 04/02/1999" and "Social Security
 * Number *: 123456789" went to the AI whole.
 */
const LABEL_HINT = String.raw`(?:\s*\([^)\n]{0,40}\))?(?:\s*\*)?`;

export function redactIdentifiers(text: string): { text: string; redacted: number } {
  let redacted = 0;
  const hide = (s: string, re: RegExp, keep?: (m: string, ...g: string[]) => string) =>
    s.replace(re, (m: string, ...g: string[]) => {
      redacted++;
      return keep ? keep(m, ...g) : '[redacted]';
    });
  let out = String(text ?? '');
  // An SSN's 3-2-4, with dots, and with the en dashes a word processor or a
  // PDF's text puts where the hyphens were, as well as hyphens and spaces.
  out = hide(out, /\b\d{3}(?:\s?[-–.]\s?| )\d{2}(?:\s?[-–.]\s?| )\d{4}\b/g);
  out = hide(out, /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g);
  out = out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (run) => {
    if (!containsCardNumber(run)) return run;
    redacted++;
    return '[redacted]';
  });
  /*
   * Under "Birthday" and "Born" too, with the month cut short ("Apr. 2,
   * 1999") and the day said as "2nd" — each of which went to the AI whole.
   */
  out = hide(
    out,
    new RegExp(String.raw`\b(date of birth|birth ?date|birthday|born(?: on)?|d\.?o\.?b\.?)(${LABEL_HINT}\s*[:,\-]?\s*)(\d{1,4}[\/.\- ]\d{1,2}[\/.\- ]\d{1,4}|[A-Z][a-z]+\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2}(?:st|nd|rd|th)?(?: of)? [A-Z][a-z]+\.?,? \d{4})`, 'gi'),
    (_m, label, gap) => `${label}${gap}[redacted]`,
  );
  out = hide(
    out,
    new RegExp(String.raw`\b(passport(?:\s+(?:no\.?|number|#))?)(${LABEL_HINT}\s*[:\-#]?\s*)([A-Z]{0,2}\d[A-Z0-9]{5,8})\b`, 'gi'),
    (_m, label, gap) => `${label}${gap}[redacted]`,
  );
  /*
   * The other national numbers, where they are named. An SSN without its
   * dashes, a Canadian SIN, a driver's licence, a tax id: a bare nine digits
   * is an order number as often as anything, so only a number that follows
   * its own label, and only one with five digits or more in it — "SIN wave",
   * "a driver's license and a car" are words, and are left.
   *
   * And the national IDs by their own names — a national or government ID,
   * India's Aadhaar, Singapore's NRIC, Brazil's CPF, Spain's DNI and NIE,
   * Poland's PESEL, the Dutch BSN, the Swedish personnummer — which went to
   * the AI as written. A dot joins the parts of one as a space or a dash
   * does: "123.456.789-09" ended after three digits.
   */
  out = out.replace(
    new RegExp(String.raw`\b(ssn|social\s+security(?:\s+(?:no\.?|number|#))?|social\s+insurance(?:\s+(?:no\.?|number))?|sin|national\s+insurance(?:\s+(?:no\.?|number))?|ni\s+(?:no\.?|number)|driv(?:er'?s?|ing)\s+licen[cs]e(?:\s+(?:no\.?|number|#))?|tax\s+(?:id|identification)(?:\s+(?:no\.?|number))?|itin|national\s+id(?:entity|entification)?(?:\s+card)?(?:\s+(?:no\.?|number|#))?|gov(?:ernmen)?t\.?[\s-]+(?:issued\s+)?id(?:\s+(?:no\.?|number|#))?|aadhaa?r(?:\s+(?:no\.?|number))?|nric|cpf|dni|nie|pesel|bsn|personnummer|personal\s+(?:identity|identification|id)\s+(?:no\.?|number|code))(${LABEL_HINT}\s*(?:is\s+)?[:\-#]?\s*)([A-Z]{0,5}\d[A-Z0-9]*(?:[ .\-][A-Z]?\d[A-Z0-9]*)*)`, 'gi'),
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

/*
 * And anything `redactIdentifiers` would take out: a labelled date of birth,
 * passport or national number is kept out of the bank as it is kept out of
 * everything else. "DOB: 04/02/1999" typed under an innocent question was
 * saved, and offered back on the next form.
 */
export function isSensitiveAnswer(answer: string): boolean {
  return (
    SENSITIVE_ANSWER.some((re) => re.test(answer)) ||
    containsCardNumber(answer) ||
    redactIdentifiers(answer).redacted > 0
  );
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
 *
 * And for what a form's markup adds that nobody typed: the required marker,
 * and a label read twice. See `tidyQuestion`. Without it "Discipline*",
 * "Discipline *" and "Discipline" were three items, and the bank held five
 * rows for that one question.
 */
export function sameQuestion(a: string, b: string): boolean {
  const norm = (s: string) => tidyQuestion(s).toLowerCase();
  return norm(a) === norm(b);
}

/**
 * A question as a form hands it over, put back to the words a person reads.
 *
 * Measured in a bank of 540 rows, every one written by the extension from a
 * form's label:
 *
 *     "Discipline*"  "Discipline *"  "Discipline"          185 rows end in "*"
 *     "SchoolSchool"  "DegreeDegree"                        a label read twice:
 *     "Are you legally authorized …?Are you legally          once for the eye, once
 *      authorized …? Required"                              for a screen reader
 *
 * The marker says the box is required, which is the form's business and not
 * the question; and the same words twice over are one question. Each made
 * the same question a second row in the bank, which the next form could
 * reach only by being marked up the same way — "SchoolSchool" shares no
 * word with "School".
 *
 * Only what a form adds at the ends, and only an exact repeat. "Required"
 * goes only after punctuation or a marker, or after a label read twice, so
 * "Is sponsorship required?" and "Will a visa be required" keep the word
 * they ask about. Words run together with no space between them
 * ("Agreement.Mutual Arbitration AgreementTo be considered") cannot be told
 * apart from here; the reader on the form has to keep them apart, and the
 * extension does.
 */
export function tidyQuestion(raw: string): string {
  let q = String(raw ?? '').replace(/\s+/g, ' ').trim();
  for (let was = ''; q !== was; ) {
    was = q;
    q = q
      .replace(/\s*\*+$/, '')
      .replace(/\s*\(\s*required\s*\)$/i, '')
      .replace(/([?.*])\s*required$/i, '$1')
      // One marker in front; "**" opens bold, and its other half is further on.
      .replace(/^\*(?!\*)\s*/, '')
      .trim();
    // After a label read twice, LinkedIn's "Required" follows whatever the
    // question ends in: "… in 2028I am … in 2028 Required".
    const unmarked = q.replace(/\s+required$/i, '');
    q = once(unmarked) !== unmarked ? once(unmarked) : once(q);
  }
  return q;
}

/** "SchoolSchool" and "School School" as "School"; anything else as it is. */
function once(q: string): string {
  for (const gap of [0, 1]) {
    const half = (q.length - gap) / 2;
    if (!Number.isInteger(half) || half < 3) continue;
    // Spaced, only a question long enough not to be a name: "Walla Walla".
    if (gap === 1 && (q[half] !== ' ' || q.slice(0, half).split(' ').length < 3)) continue;
    if (q.slice(0, half) === q.slice(half + gap)) return q.slice(0, half);
  }
  return q;
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
  /*
   * And the name without its legal form: a variant labelled "Stripe, Inc."
   * that says "Stripe" names Stripe, and looking only for "Stripe, Inc."
   * found nothing, so it was confident on the form for Plaid.
   */
  return [name, employerName(name)].some((n) => {
    if (n.trim().length < 3) return false;
    const escaped = n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
  });
}

/*
 * Labels the tools give an answer themselves, which name no one: the server's
 * "Saved", the extension's "Chosen on a form" and "Typed on a form", the seed
 * bank's "Generic (edit per company)".
 */
const TOOL_LABEL = /^(saved|chosen on a form|typed on a form|generic\b.*|default|base)$/i;

/*
 * Labels that say which version of an answer it is, not who it was for:
 * "Full", "Short (two lines)", "Profile URL". Each read as a company name,
 * so a "Full-time" answer named an employer called "Full" and was never
 * confident.
 */
const VERSION_LABEL =
  /^(?:(?:full|short(?:er)?|long(?:er)?|brief|detailed|formal|informal|casual|concise|extended|expanded|alternate|alternative|generic|technical|one[- ]liner)(?:\s+(?:version|answer|form|draft))?(?:\s*\(.*\))?|(?:version|option|draft|v)\s*\d+)$|\b(?:url|link|lines?|words?|sentences?|paragraphs?|characters?)\b|^profile\b/i;

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
function employersInBank(bank: AnswerBankItem[], employers?: string[]): string[] {
  /*
   * The employers the person has actually applied to, when the caller knows
   * them: the tracker's companies and the drafts'. A label is only ever a
   * guess at one, and a guess that is wrong costs a confident answer.
   */
  const known = (employers ?? []).map((e) => String(e ?? '').trim()).filter((e) => looksLikeCompanyName(e));
  /*
   * As well as the labels, not instead of them: an answer written for a
   * company that was never tracked — a "Halewood Group" answer saved from a
   * form — still names Halewood Group, and with the tracker's list alone it
   * went confidently into Streamly's form.
   */
  const names = new Set<string>(known);
  for (const item of bank) {
    for (const v of item.variants) {
      const label = (v.label ?? '').trim();
      if (label.length < 3 || TOOL_LABEL.test(label)) continue;
      if (label.toLowerCase() === (v.text ?? '').trim().toLowerCase()) continue;
      if (VERSION_LABEL.test(label) || !looksLikeCompanyName(label)) continue;
      names.add(label);
    }
  }
  return [...names];
}

export interface MatchOptions {
  threshold?: number;
  /** The employer being applied to. */
  company?: string;
  /**
   * Every employer the person has applied to or drafted for — the tracker's
   * companies and the drafts' — to look for in an answer. Without it the
   * bank's own labels stand in, those that read as a company's name.
   */
  employers?: string[];
}

export function matchAnswer(
  question: string,
  bank: AnswerBankItem[],
  options: number | MatchOptions = {},
): AnswerMatch {
  // The threshold used to be the third argument, and callers pass it that way.
  const { threshold = 0.45, company, employers } = typeof options === 'number' ? ({ threshold: options } as MatchOptions) : options;

  // See `isSensitiveQuestion`: an SSN, a date of birth, a passport number, a
  // home address never come back from the bank, not even as a loose read-first
  // suggestion. Checked before the bank is even searched, so nothing about
  // what is stored — or whether anything is stored — leaks through the score.
  if (isSensitiveQuestion(question)) return { question, score: 0, confident: false };
  return matchInBank(question, safeToOffer(bank), threshold, company, employers);
}

/*
 * Never hand back a stored value that is itself an identifier — one banked
 * before these checks existed, or under a question worded past them.
 *
 * Its own step so `matchAnswers` can take it once for a whole form. It ran
 * once per question, through every variant of every item, and a form of a
 * hundred questions read the whole bank for identifiers a hundred times.
 */
/*
 * And never a row that is not a question and an answer at all: an option
 * banked as the question (see `isOptionPhrase`), or a dropdown's prompt
 * banked as the answer (see `isPrompt`). The bank is older than the checks
 * that keep these out on the way in, so they are taken out on the way back
 * too. A prompt is taken out of the item's phrasings, and the item goes only
 * when it had nothing else.
 */
function safeToOffer(bank: AnswerBankItem[]): AnswerBankItem[] {
  const out: AnswerBankItem[] = [];
  for (const item of bank) {
    if (item.variants.some((v) => isSensitiveAnswer(v.text))) continue;
    if (askedAsItsOwnAnswer(item)) continue;
    if (!item.variants.some((v) => isPrompt(v.text))) {
      out.push(item);
      continue;
    }
    const variants = item.variants.filter((v) => !isPrompt(v.text));
    if (variants.length === 0) continue;
    out.push({ ...item, variants, default: variants.some((v) => v.id === item.default) ? item.default : variants[0]!.id });
  }
  return out;
}

/*
 * The calendar dates an answer names, as the last local day each one covers.
 *
 * The bank keeps no date of its own — nothing records when an answer was
 * filed — so an answer whose words carry a date is the only one that can say
 * it has gone stale. "Available from November 2026", banked in October, came
 * back confident the next March and was filled in unread: a start date in the
 * past, sent to an employer as the person's own word.
 *
 * Read are the shapes that are plainly a date on a calendar: a month and a
 * year ("November 2026", "Nov. 2026", "Sept 2026"), a day with them ("1
 * December 2026", "December 1st, 2026"), and a numeric full date ("2026-12-01",
 * "12/01/2026"), and a numeric month and year ("11/2026", "2026-11"). A month
 * and a year covers the whole month, so "October 2026" has not passed until
 * October has. A season and a year covers the season, to the end of its last
 * month: Spring to May, Summer to August, Fall or Autumn to December, and
 * Winter to February of the year after, since a winter runs into the next
 * one. A bare year and "January 5th" are not read: neither is a day that can
 * pass.
 *
 * A numeric date is read month first, as US forms write it, unless the first
 * number cannot be a month. Where both numbers could be the month,
 * "05/11/2026" is the fifth of November as much as the eleventh of May: it is
 * read as the later of the two, so it has passed only once both readings
 * have. Doubting an answer that is still true is worse than leaving one that
 * may not be, because the doubt is what stops it being offered.
 */
/*
 * And the months as German, French, Spanish, Portuguese and Dutch forms write
 * them — "Juni 2025" for "Gewünschtes Startdatum" was no date at all, so a
 * start eighteen months gone was offered as good. Whole words, keyed as
 * written, because the first three letters no longer tell them apart: "juin"
 * and "juillet" both open "jui", and "mai" is May in three languages while
 * "maio" is May and "mars" is March. JobHelper's `MONTHS_ELSEWHERE` in
 * remembering.js is the same table.
 */
const MONTHS_ELSEWHERE: Record<string, number> = {
  // German
  januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
  // French
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, juin: 6, juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
  // Spanish
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  // Portuguese
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, maio: 5, junho: 6, julho: 7, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  // Dutch
  januari: 1, februari: 2, maart: 3, mei: 5, augustus: 8, december: 12,
};
const MONTH_WORD =
  String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|${Object.keys(MONTHS_ELSEWHERE).join('|')})`;
const MONTH_NUMBER: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** The month a word names: whole, as the other languages write it, or by its first three letters in English. */
const monthNumber = (word: string): number =>
  MONTHS_ELSEWHERE[word.normalize('NFC').toLowerCase()] ?? MONTH_NUMBER[word.slice(0, 3).toLowerCase()] ?? 0;
const DAY_MONTH_YEAR = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th|\.)?\s+(?:of\s+|de\s+)?${MONTH_WORD}\.?,?(?:\s+de)?\s+(\d{4})\b`, 'giu');
const MONTH_DAY_YEAR = new RegExp(String.raw`\b${MONTH_WORD}\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, 'giu');
// "junio de 2025", "junho de 2025": Spanish and Portuguese put "de" between.
const MONTH_YEAR = new RegExp(String.raw`\b${MONTH_WORD}\.?,?(?:\s+de)?\s+(\d{4})\b`, 'giu');
// And a date as Japanese writes it: 2025年6月 is June 2025, 2025年6月15日 the fifteenth.
const JP_DATE = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g;
const JP_MONTH = /(\d{4})年\s*(\d{1,2})月/g;
const ISO_DATE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
const NUMERIC_DATE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g;
const SEASON_YEAR = /\b(spring|summer|fall|autumn|winter)\s+(?:of\s+)?(\d{4})\b/gi;
const SEASON_ENDS: Record<string, number> = { spring: 5, summer: 8, fall: 12, autumn: 12, winter: 2 };
const NUMERIC_MONTH_YEAR = /\b(\d{1,2})\/(\d{4})\b/g;
const ISO_MONTH = /\b(\d{4})-(\d{1,2})\b/g;

function datesIn(text: string): string[] {
  const days: string[] = [];
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = (year: number, month: number, date: number) => {
    if (month < 1 || month > 12 || date < 1 || date > 31) return;
    days.push(`${year}-${pad(month)}-${pad(date)}`);
  };
  const monthOf = monthNumber;
  // Each shape takes its words out of the text, so "1 December 2026" is not
  // read a second time as "December 2026".
  let rest = text.replace(JP_DATE, (_m, y: string, mo: string, d: string) => {
    day(Number(y), Number(mo), Number(d));
    return ' ';
  });
  rest = rest.replace(DAY_MONTH_YEAR, (_m, d: string, mo: string, y: string) => {
    day(Number(y), monthOf(mo), Number(d));
    return ' ';
  });
  rest = rest.replace(MONTH_DAY_YEAR, (_m, mo: string, d: string, y: string) => {
    day(Number(y), monthOf(mo), Number(d));
    return ' ';
  });
  // The month's last day: day 0 of the month after it.
  const lastOf = (year: number, month: number) => day(year, month, new Date(year, month, 0).getDate());
  rest = rest.replace(MONTH_YEAR, (_m, mo: string, y: string) => {
    lastOf(Number(y), monthOf(mo));
    return ' ';
  });
  rest = rest.replace(JP_MONTH, (_m, y: string, mo: string) => {
    lastOf(Number(y), Number(mo));
    return ' ';
  });
  rest = rest.replace(SEASON_YEAR, (_m, season: string, y: string) => {
    const month = SEASON_ENDS[season.toLowerCase()] ?? 12;
    // Winter 2026 is the one that starts in December 2026.
    lastOf(month === 2 ? Number(y) + 1 : Number(y), month);
    return ' ';
  });
  rest = rest.replace(ISO_DATE, (_m, y: string, mo: string, d: string) => {
    day(Number(y), Number(mo), Number(d));
    return ' ';
  });
  rest = rest.replace(NUMERIC_DATE, (_m, a: string, b: string, y: string) => {
    const [first, second, year] = [Number(a), Number(b), Number(y)];
    if (first > 12) day(year, second, first);
    else if (second > 12) day(year, first, second);
    // Either could be the month: the later reading, as above.
    else if (first * 100 + second >= second * 100 + first) day(year, first, second);
    else day(year, second, first);
    return ' ';
  });
  // A month and a year in numbers, read once the full dates are out, so the
  // "11/2026" of "05/11/2026" is not read again on its own.
  rest = rest.replace(NUMERIC_MONTH_YEAR, (_m, mo: string, y: string) => {
    lastOf(Number(y), Number(mo));
    return ' ';
  });
  rest.replace(ISO_MONTH, (_m, y: string, mo: string) => {
    lastOf(Number(y), Number(mo));
    return ' ';
  });
  return days;
}

/**
 * Whether an answer names a calendar date that is already behind us, on the
 * person's own calendar (`localDay`, not Greenwich's). A date still to come
 * is no reason to doubt an answer, and one that has passed is a reason to
 * read it before it is sent again.
 *
 * Judged by the latest date the answer names, not by any one of them. An
 * answer names a past date for reasons of its own: "Immediately; I left my
 * last role in August 2026" is as true in October as it was in September,
 * and "Between May 2026 and February 2027" still has months to run. Doubted
 * for its first date, each was held back from the form as stale. Only when
 * every date named has passed is there nothing left in it still to come.
 *
 * A start given from today ("Immediately", "ASAP", "two weeks' notice") is a
 * date that never passes — but only when it is the only thing the answer
 * says about time. It used to excuse any answer it appeared in, so
 * "Available from 1 March 2025, after two weeks' notice" and "Immediately
 * after my contract ends on 31 March 2025" were offered as good, confidently,
 * a year and a half on: the notice is counted from a date, and the date is
 * what has passed. An answer that names a date is judged by its dates, as
 * above, whatever else it says. That costs "Immediately; I left my last role
 * in August 2026", which is read as stale once August has gone — and stale is
 * only "read this before it is sent", where the other way a start date
 * eighteen months gone was filled in unread.
 *
 * The notice is read with its possessive however it is written: "one
 * month's", "two weeks'", "two weeks’".
 */
const STARTS_FROM_TODAY =
  /\b(immediately|asap|as\s+soon\s+as\s+possible|right\s+away|straight\s+away|at\s+once|(\d+|one|two|three|four|six)\s+(days?|weeks?|months?)([’']s?)?\s+notice)\b/i;

export function namesPassedDate(text: string, now = new Date(Date.now())): boolean {
  const said = String(text ?? '');
  const days = datesIn(said);
  /*
   * A start from today on its own never passes. Said as its own rule, though
   * an answer with no date in it has nothing to pass either way: what the
   * rule no longer does is excuse the dates beside it.
   */
  if (days.length === 0 && STARTS_FROM_TODAY.test(said)) return false;
  const today = localDay(now);
  return days.length > 0 && days.every((day) => day < today);
}

/*
 * A question about when somebody can start, which is the only kind whose
 * answer a passing date makes untrue. A graduation date in the past, or the
 * day a job ended, is a fact that stays a fact; "May 2024" for "Expected
 * graduation date?" is as good next year as it was this one. "Available from
 * November 2026" for "When can you start?" is not.
 *
 * "Start date" alone is not enough, because "Start date" in an employment
 * history block asks about the past: it has to be the earliest, desired or
 * available one, or the internship's.
 *
 * "Availability" alone is not enough either. It asked about starting as
 * often as it asked about weekends, overtime or travel, and an answer to
 * those carries dates that pass without making it untrue. What is read is
 * the date somebody is available from, a question asking when, how soon or
 * what date they could start, in the languages forms come in, or the word
 * on its own as the whole label, which a form asks nothing else with.
 */
const ASKS_WHEN_YOU_START = new RegExp(
  [
    String.raw`\b(earliest|desired|preferred|expected|anticipated|proposed|possible|potential|available|availability)\s+(start(ing)?|joining|begin(ning)?)\s+date\b`,
    String.raw`\b(when|what\s+date|how\s+soon)\s+(can|could|would|will|are)\s+you\s+(be\s+)?((able|available|ready)\s+to\s+)?(start|begin|join|commence|available)\b`,
    String.raw`\bearliest\s+(that\s+)?you\s+(can|could|would|will)\s+(be\s+able\s+to\s+)?(start|begin|join|commence)\b`,
    String.raw`\bavailab(le|ility)\s+(from|to\s+(start|begin|join))\b`,
    String.raw`\b(date\s+(available|of\s+availability)|availability\s+date)\b`,
    String.raw`^\s*availability[\s:?*]*$`,
    String.raw`\b(join(ing)?\s+date|date\s+of\s+joining)\b`,
    String.raw`\bnotice\s+period\b`,
    String.raw`\b(begin|start|commence)\s+(work(ing)?|employment)\b`,
    String.raw`\b(internship|co-?op)\s+start(\s+date)?\b`,
    String.raw`\bearliest\s+(date|start)\b`,
    // German, French and Spanish, as the forms of employers there ask it.
    String.raw`\b(ab\s+wann|wann\s+k(ö|oe|o)nn(en|ten)\s+sie\s+(anfangen|beginnen|starten|eintreten))\b`,
    String.raw`\beintritts(datum|termin)\b`,
    /*
     * "Disponibilité" as English "availability" is: the word alone asked
     * about weekends ("Disponibilité le week-end") and travel ("disponibilité
     * pour les déplacements") as well. Read with a start beside it, or as the
     * whole label — and the whole label is also "Votre disponibilité",
     * "Quelle est votre disponibilité ?", "Disponibilité (date)" and
     * "Disponibilité / préavis" or "et préavis", which the narrower reading
     * missed, with "À partir de quand êtes-vous disponible ?". Not "à
     * partir" after a letter: no `\b` reads in front of an "à".
     */
    String.raw`\b(date\s+de\s+(d[ée]but|disponibilit[ée])|disponib(ilit[ée]|le)\s+[àa]\s+partir|disponibilit[ée]\s+pour\s+(commencer|d[ée]buter)|quand\s+pouvez[-\s]vous\s+(commencer|d[ée]buter))`,
    String.raw`(^|[^a-zà-ÿ])[àa]\s+partir\s+de\s+quand\b`,
    String.raw`^\s*((quelle\s+est\s+)?votre\s+)?disponibilit[ée](\s*\(\s*date\s*\)|\s*(\/|et|&)\s*pr[ée]avis)?[\s:?*]*$`,
    String.raw`\b(fecha\s+de\s+(inicio|incorporaci[óo]n|disponibilidad)|cu[áa]ndo\s+(puede|puedes|podr[íi]as?)\s+(usted\s+)?(empezar|comenzar|incorporarse|incorporarte))`,
    /*
     * And the rest of what German, Spanish, Portuguese, Dutch and Japanese
     * forms write: "Startdatum" and "Gewünschtes Startdatum", "Verfügbar
     * ab", "bei uns anfangen", "Disponibilidad para incorporarse", "Data de
     * início", "Quando (você) pode começar?", "Beschikbaar vanaf", "Per
     * wanneer", "Gewenste startdatum", 入社可能日 and 入社希望日. "Startdatum"
     * on its own is read, unlike "Start date": a German work-history block
     * asks "Von" and "Bis", not "Startdatum". No `\b` round a Japanese word,
     * which has no word characters for one to sit between.
     */
    String.raw`\bstartdatum\b`,
    String.raw`\bverf[üu]gbar\s+ab\b`,
    String.raw`\bbei\s+uns\s+(anfangen|beginnen|starten|einsteigen)\b`,
    String.raw`\bdisponibilidad\s+para\s+(incorporar(se|te|me)|empezar|comenzar)\b`,
    String.raw`\b(data\s+de\s+in[íi]cio|disponibilidade\s+para\s+(come[çc]ar|iniciar)|quando\s+(voc[êe]\s+)?(pode(ria)?|poderia)\s+(come[çc]ar|iniciar))\b`,
    String.raw`\b(beschikbaar\s+vanaf|per\s+wanneer|vanaf\s+wanneer)\b`,
    String.raw`入社(可能|希望)日|いつから(勤務|就業|入社)?(可能|できます)`,
  ].join('|'),
  'i',
);

export function asksWhenYouStart(question: string): boolean {
  return ASKS_WHEN_YOU_START.test(String(question ?? ''));
}

/** `matchAnswer` past its checks, against a bank already through `safeToOffer`. */
function matchInBank(
  question: string,
  bank: AnswerBankItem[],
  threshold: number,
  company: string | undefined,
  employers: string[] | undefined,
): AnswerMatch {
  /*
   * The stored question that is this question, if there is one, before any
   * scoring.
   *
   * The best score used to win, and the first of several equal scores. But a
   * score of 1 is not only the question itself: "desired" and "expected" are
   * one word to the matcher, so "What is your desired salary?" scored 1 against
   * a stored "What is your expected salary?" too, and whichever came first in
   * the bank answered — a different figure, written for a different form, and
   * confident, so filled in unread. Asking each stored question of a real bank
   * of 540 handed back some other item 32 times. When the bank holds the very
   * question asked, as `sameQuestion` reads it, that is the answer the person
   * wrote for it, and nothing that merely scores as well comes ahead of it.
   * Otherwise the first of equal scores still wins, which is at least the same
   * one every time.
   */
  // An option is not a question. See `isOptionPhrase`.
  if (isOptionPhrase(question)) return { question, score: 0, confident: false };
  let best: { item: AnswerBankItem; score: number } | undefined;
  const exact = bank.find((item) => sameQuestion(question, item.question));
  if (exact) {
    best = { item: exact, score: questionSimilarity(question, exact.question) };
  } else {
    for (const item of bank) {
      const score = questionSimilarity(question, item.question);
      if (!best || score > best.score) best = { item, score };
    }
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
    : employersInBank(bank, employers).find((name) => who(name) !== ours && mentions(text, name));

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
      /*
       * And never an answer the AI wrote that nobody has read since: banked
       * from a completed application word for word as it was drafted, it is
       * a suggestion, offered like a loose match rather than filled in.
       */
      !variant?.suggested &&
      /*
       * Nor a start date that has passed. "Available from November 2026"
       * was true when it was banked and is not after November; offered as a
       * suggestion it is read, and filled in unread it is a start date in
       * the past. Only for a question about starting: a past graduation date
       * is still true. See `asksWhenYouStart` and `namesPassedDate`.
       */
      !((asksWhenYouStart(question) || asksWhenYouStart(best.item.question)) && namesPassedDate(text)) &&
      // Or the same score with the furniture out of it. See `bare`.
      (best.score >= 0.7 || overlap(bare(question), bare(best.item.question)) >= 0.7) &&
      fullyAsked(question, best.item.question) &&
      unanswered(question, best.item.question, company).length === 0 &&
      sameShortTerms(question, best.item.question) &&
      sameNumbers(question, best.item.question) &&
      // Pointing the same way, naming the same thing, and — where that is
      // most of the question — the same furniture. See each.
      sameDirection(question, best.item.question) &&
      sameThingNamed(question, best.item.question) &&
      sameFurnitureWhenThin(question, best.item.question),
    ...(namesAnother ? { namesAnother } : {}),
  };
}

/**
 * One answer from a completed application, filed into the bank.
 *
 * Every answer not taken from the bank unchanged was filed as it was sent,
 * and the AI's drafts went in exactly like the person's own. The answer the
 * writing run put under "Why do you want to work here?" — text a posting's
 * own wording can steer, and nobody had to read before sending — then came
 * back confident on the next form asking the same thing, and was filled in
 * there unread. So an answer still word for word as the AI wrote it (`unread`)
 * is filed `suggested`, the mark the editor already uses for drafted but not
 * reviewed, and `matchAnswer` treats a suggested phrasing as it treats a loose
 * match: offered to read, never filled in. Anything the person typed or
 * edited is filed as it always was, and sending a stored phrasing having
 * read it clears the mark.
 */
export function fileSentAnswer(
  bank: AnswerBankItem[],
  sent: {
    question: string;
    answer: string;
    fromAnswerId?: string;
    /** The employer it was written for, which labels the phrasing. */
    label: string;
    unread: boolean;
    /** An id for a question the bank does not hold yet. */
    newId: (asked: string) => string;
  },
): void {
  const mark = sent.unread ? { suggested: true } : {};
  const existing = bank.find((a) => a.id === sent.fromAnswerId || sameQuestion(a.question, sent.question));
  if (!existing) {
    // As a person reads it. See `tidyQuestion`.
    const asked = tidyQuestion(sent.question) || sent.question;
    bank.push({
      id: sent.newId(asked),
      question: asked,
      default: 'v_1',
      variants: [{ id: 'v_1', label: sent.label, text: sent.answer, ...mark }],
    });
    return;
  }
  // The same wording saved twice — a form resubmitted, a workspace completed
  // twice — is not a second variant. See `/answers/save`.
  const already = existing.variants.find((v) => v.text.trim() === sent.answer.trim());
  /*
   * And an unread draft does not push a reviewed answer out of the default:
   * the next form for somebody else would lose the answer the person stood
   * behind and be offered one they never read.
   */
  const current = existing.variants.find((v) => v.id === existing.default);
  const mayLead = (v: Variant) => !v.suggested || !current || current.suggested;
  if (already) {
    if (!sent.unread) delete already.suggested;
    /*
     * The same rule when the draft is already there. This branch made it the
     * default whatever it was, so the same unread draft sent a second time —
     * a second form asking the same thing — took the default from the
     * reviewed answer the first send had been kept from displacing.
     */
    if (mayLead(already)) existing.default = already.id;
    return;
  }
  /*
   * Unique within the item, not merely likely to be. A completion files every
   * answer it holds in one go, so two answers filed under one item in the
   * same millisecond were both called `v_<now>`: the default then named
   * whichever of the two came first rather than the one just filed, and the
   * editor, which finds the version to change by its id, wrote an edit of one
   * over both.
   */
  const vid = newVariantId(existing.variants, `v_${Date.now().toString(36)}`);
  const added: Variant = { id: vid, label: sent.label, text: sent.answer, ...mark };
  existing.variants.push(added);
  if (mayLead(added)) existing.default = vid;
}

/**
 * `stem`, or `stem-2`, `stem-3`… — the first that no variant of the item has.
 *
 * A variant is found by its id (the item's `default`, the editor's edit), so
 * two of one id inside an item are one variant to everything that reads them.
 */
export function newVariantId(variants: readonly Pick<Variant, 'id'>[], stem: string): string {
  let id = stem;
  for (let n = 2; variants.some((v) => v.id === id); n++) id = `${stem}-${n}`;
  return id;
}

export function matchAnswers(
  questions: string[],
  bank: AnswerBankItem[],
  options?: number | MatchOptions,
): AnswerMatch[] {
  const { threshold = 0.45, company, employers } =
    typeof options === 'number' ? ({ threshold: options } as MatchOptions) : (options ?? {});
  // Read the bank for identifiers once for the form, not once per question.
  // See `safeToOffer`; the order of checks is otherwise `matchAnswer`'s own.
  const safe = safeToOffer(bank);
  return questions.map((q) =>
    isSensitiveQuestion(q) ? { question: q, score: 0, confident: false } : matchInBank(q, safe, threshold, company, employers),
  );
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
  /*
   * Letters and digits in any script. ASCII only, a company written in
   * Japanese or Cyrillic slugged to nothing, so two such letters on one day
   * were both "2026-10-11" and the second was saved over the first.
   */
  const whole = (s: string) =>
    s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const slug = (s: string) => whole(s).slice(0, 30);
  return [localDay(at), company && slug(company), role && roleSlug(role, company, whole)]
    .filter(Boolean)
    .join('-');
}

/*
 * The role's part of a letter's id, with its requisition number kept.
 *
 * The role was cut to 30 characters like the company, and on a long title the
 * cut took the number: "Senior Software Engineer, Platform (12345678)" and
 * "(87654321)" at one employer on one day were both
 * "…-senior-software-engineer-platf", and the second letter was saved over
 * the first. Two requisitions under one title are two jobs
 * (`differentRequisitions`), so they are two letters.
 *
 * The rule, exactly — JobHelper's offline `letterId` mirrors it:
 *
 * 1. `full` is the role slugged whole: NFKC, lower case, every run of
 *    characters that are not letters or digits (`[^\p{L}\p{N}]+`, Unicode)
 *    to one "-", a leading and a trailing "-" taken off.
 * 2. If `full` is 30 characters or fewer, or the role carries no requisition
 *    number (`requisitionOf(role, company)`), the part is `full.slice(0, 30)`
 *    — the id it always had, so no letter already saved changes its id.
 * 3. Otherwise `number` is that requisition slugged the same way (it is
 *    letters and digits only: "12345678", "jr0286834", "r22724"). Take the
 *    last whole "-"-separated occurrence of `number` out of `full` (in
 *    "-" + full + "-", the last "-number-" becomes "-"; then the "-" either
 *    end off again); if it is not there as a whole token, `full` is used as
 *    it is. Cut that to 30 characters, take any trailing "-" off, and add
 *    "-" + `number` — never cut, so it cannot be lost.
 */
function roleSlug(role: string, company: string | undefined, whole: (s: string) => string): string {
  const full = whole(role);
  const req = full.length > 30 ? requisitionOf(role, company) : undefined;
  if (!req) return full.slice(0, 30);
  const number = whole(req);
  const padded = `-${full}-`;
  const at = padded.lastIndexOf(`-${number}-`);
  const without =
    at < 0 ? full : `${padded.slice(0, at)}-${padded.slice(at + number.length + 2)}`.replace(/^-+|-+$/g, '');
  const kept = without.slice(0, 30).replace(/-+$/, '');
  return kept ? `${kept}-${number}` : number;
}
