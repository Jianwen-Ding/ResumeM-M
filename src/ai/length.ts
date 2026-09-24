import type { StoreData } from '../model/types.js';
import { countsAsTheirs } from './voice.js';

/**
 * How long a letter or an answer should run, read from what this person
 * writes rather than set once for everybody.
 *
 * The letter prompt asked for "three or four paragraphs, 200–320 words" and
 * the answer prompt for "150–250 words for anything asking you to describe
 * something", whoever was applying. Both ran longer than what this person
 * actually sends, and the report was "way too wordy" — about drafts doing
 * exactly what they had been told. The length somebody writes to is in the
 * letters they have sent and the answers they have given, so that is where
 * it is read from.
 */

/** Words, as a person counting them would: runs of anything but space. */
export function wordCount(text: string | undefined): number {
  return (String(text ?? '').trim().match(/\S+/g) ?? []).length;
}

/**
 * A word limit the question states for itself, or null.
 *
 * "(150 words or less)", "no more than 200 words", "250 words max", "a
 * 200-word limit", "maximum of 300 words". The same reading as the card's
 * word counter (`statedWordLimit` in JobHelper's card.js), so the number the
 * model is held to is the number the person sees under the box.
 */
export function statedWordLimit(question: string | undefined): number | null {
  const said = String(question ?? '');
  const hit =
    /\b(\d{2,4})\s*-?\s*words?\s*(?:or\s+(?:less|fewer)|max(?:imum)?\b|limit\b|at\s+most\b)/i.exec(said) ??
    /\b(?:no\s+more\s+than|not\s+(?:to\s+)?exceed(?:ing)?|up\s+to|max(?:imum)?(?:\s+of)?|at\s+most|within|under|limit(?:ed)?\s+(?:of|to))\s+(\d{2,4})\s*words?\b/i.exec(
      said,
    );
  return hit ? Number(hit[1]) : null;
}

/** Shorter than this is a stub or a note, not a letter to measure by. */
const LETTER_FLOOR = 60;

export interface LetterLength {
  /** The middle of the letters they have sent, in words. */
  median: number;
  longest: number;
  /** How many letters it was read from. */
  count: number;
}

/**
 * How long the letters they send run, or null when there is none to read.
 *
 * Not the ones taken out of their voice: a letter written to somebody else's
 * template is a letter they sent and not how they write, and its length is
 * part of how it was written.
 */
export function ownLetterLength(data: Pick<StoreData, 'coverLetters'>): LetterLength | null {
  const counts = (data.coverLetters ?? [])
    .filter(countsAsTheirs)
    .map((l) => wordCount(l.body))
    .filter((n) => n >= LETTER_FLOOR)
    .sort((a, b) => a - b);
  if (counts.length === 0) return null;
  const mid = Math.floor(counts.length / 2);
  const median = counts.length % 2 === 1 ? counts[mid]! : Math.round((counts[mid - 1]! + counts[mid]!) / 2);
  return { median, longest: counts[counts.length - 1]!, count: counts.length };
}

/** With nothing of theirs to go by. Shorter than the old 200–320 on purpose. */
export const DEFAULT_LETTER_WORDS = { low: 150, high: 220 } as const;

/**
 * The most a letter may run before `save_letter` hands it back to be cut: a
 * fifth over the longest they have sent, or 300 words with none to go by.
 */
export function letterWordCap(data: Pick<StoreData, 'coverLetters'>): number {
  const own = ownLetterLength(data);
  return own ? Math.max(120, Math.round(own.longest * 1.2)) : 300;
}
