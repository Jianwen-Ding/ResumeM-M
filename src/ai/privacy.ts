/**
 * What of the answer bank an AI may read.
 *
 * The bank refuses to save a self-identification answer or an identifier
 * (`isSensitiveQuestion` / `isSensitiveAnswer`), but a bank written before
 * those rules — or by a client that did not apply them — can still hold
 * "What is your Veterans Status?" or "Are you Hispanic/Latino?". Matching an
 * answer for a form already skips them (`matchAnswer`); every place that
 * hands the bank to a model did not, so they were pasted into prompts,
 * listed in the index, returned by `find_my_answers`, quoted by
 * `check_claim` and written into the AI's working directory.
 *
 * One filter, used by every AI-facing read of the bank, so a new reader has
 * one thing to call rather than two rules to remember.
 */

import { isSensitiveAnswer, isSensitiveQuestion } from '../jobs/answers.js';
import type { AnswerBankItem } from '../model/types.js';

/*
 * And contact details, which the bank's rules let through because a form
 * filling them in is what the bank is for — but no model needs them to write
 * a letter. Measured on a real save: "What is your current full address?",
 * "Address Line1" (no word break before the 1, so `address\s*(line|[12])\b`
 * misses it) and a street address typed under "Location (required)" all
 * reached the writing session, as did phone numbers and email addresses.
 */
const CONTACT_QUESTION = [
  /\baddress/i,
  /\b(phone|mobile|cell)\b/i,
  /\be-?mail\b/i,
  /\b(zip|postal)\s*code|\bpostcode\b/i,
];
const CONTACT_ANSWER = [
  // An email address.
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/,
  // A phone number: ten or more digits however they are punctuated.
  /(?:\+?\d[\s().-]*){10,}/,
  // A street address: a house number, a name, and a street word.
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,4}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|place|pl|terrace|circle|cir|parkway|pkwy|highway|hwy)\b\.?/i,
];

export function answersForAi<T extends AnswerBankItem>(answers: readonly T[] | undefined | null): T[] {
  const out: T[] = [];
  for (const item of answers ?? []) {
    const question = item?.question ?? '';
    if (!item || isSensitiveQuestion(question) || CONTACT_QUESTION.some((re) => re.test(question))) continue;
    const variants = (item.variants ?? []).filter(
      (v) => !isSensitiveAnswer(v.text ?? '') && !CONTACT_ANSWER.some((re) => re.test(v.text ?? '')),
    );
    if (variants.length === 0) continue;
    if (variants.length === item.variants.length) {
      out.push(item);
      continue;
    }
    // Some phrasings carried an identifier: the rest stay, the default with them.
    const keepsDefault = variants.some((v) => v.id === item.default);
    out.push({ ...item, variants, default: keepsDefault ? item.default : variants[0]!.id });
  }
  return out;
}
