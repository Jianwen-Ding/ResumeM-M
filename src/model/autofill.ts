/**
 * What a form asks for that the profile already knows, worked out rather than
 * typed twice.
 *
 * The profile holds seven things — a name, an email, a phone number, three
 * links and a location — and `profile.autofill` holds anything else, as
 * key/value pairs somebody enters by hand in Save & Files.
 *
 * Which was the whole of it, and the shape of every ATS form disagrees. They
 * do not ask for a full name: Greenhouse, Lever, Workday, iCIMS, Taleo and
 * SuccessFactors all ask for "First name" and "Last name" in two boxes. Nor do
 * they ask for a location: they ask for City, State/Province and Country,
 * usually as three required fields. The extension recognises every one of
 * those labels — `FIELD_PATTERNS` in its autofill.js has had `first_name`,
 * `last_name`, `address_city`, `address_state` and `address_country` all
 * along — and the store had nothing to put in them. So the commonest four
 * boxes on the commonest form in the world came out empty, on a store holding
 * "Jianwen Ding" and "Boston, MA", unless the person went and typed the parts
 * out again as extras.
 *
 * Derived, never asserted: anything set by hand in `autofill` wins, so this
 * can only fill a box that was going to be empty. And nothing is guessed — a
 * name or a location this cannot read confidently yields no key at all, which
 * leaves the field blank exactly as before. An empty required field is
 * annoying and visible; a wrong name on a submitted application is neither.
 */
import type { Profile } from './types.js';

/**
 * Words that belong to the surname rather than being one.
 *
 * "Ludwig van Beethoven" has the surname "van Beethoven", and taking the last
 * word alone gives a name no form should be sent. Matched without regard to
 * case, because whether somebody writes their own as "van Dyke" or "Van Dyke"
 * is a matter of family habit and both are the whole surname either way —
 * reading the capital as a signal gave "Dyke".
 *
 * A bare "al" is left out on purpose: it is a given name in its own right in
 * English, and the Arabic article it would be standing in for is nearly
 * always written joined to the name it belongs to, where it needs no help.
 */
const PARTICLES = new Set([
  'van', 'von', 'de', 'del', 'della', 'der', 'den', 'di', 'da', 'das', 'dos',
  'du', 'la', 'le', 'lo', 'bin', 'ibn', 'ter', 'ten', 'op', "'t", 'st',
]);

/** Letters after the name that are not part of it. */
const SUFFIX = /^(jr|sr|ii|iii|iv|v|phd|ph\.?d|md|m\.?d|mba|esq|cpa|rn|dds|jd)\.?$/i;

const tidy = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * A full name split into the two boxes a form actually has.
 *
 * Returns nothing rather than a guess wherever the split is not plain:
 *
 *   "Jianwen Ding"            -> Jianwen / Ding
 *   "Ding, Jianwen"           -> Jianwen / Ding      (the filed order)
 *   "Ludwig van Beethoven"    -> Ludwig / van Beethoven
 *   "Martin Luther King Jr."  -> Martin / King
 *   "Cher"                    -> nothing; one word is not two boxes
 *   "J. R. R. Tolkien"        -> J. / Tolkien
 */
export function splitName(full: string): { first: string; last: string } | undefined {
  const said = tidy(full);
  if (!said) return undefined;

  // "Surname, Given" is how a name is filed, and people store it that way.
  // One comma only: two commas is a list or a name with a suffix after it,
  // and neither is this.
  const parts = said.split(',');
  if (parts.length === 2) {
    const last = tidy(parts[0]);
    const first = tidy(parts[1]).split(/\s+/)[0] ?? '';
    return last && first && !SUFFIX.test(first) ? { first, last } : undefined;
  }
  if (parts.length > 2) return undefined;

  const words = said.split(/\s+/).filter((w) => !SUFFIX.test(w));
  if (words.length < 2) return undefined;

  let at = words.length - 1;
  // Walk back over particles, but never all the way: a surname is at least
  // one real word and the given name has to keep one too.
  while (at > 1 && PARTICLES.has(words[at - 1]!.toLowerCase())) at -= 1;

  const first = words[0]!;
  const last = words.slice(at).join(' ');
  return first && last ? { first, last } : undefined;
}

/**
 * Two US states share their postal code with an ordinary word, and nothing
 * else here is ambiguous: the check below is on shape, not on a list of
 * places, so it holds for Ontario and Bavaria as well as Massachusetts.
 */
const POSTAL_CODE = /^[A-Z]{2}$/;

/** A country, rather than a state, when a location names three things. */
const COUNTRYISH = /^[A-Za-z][A-Za-z .'-]*$/;

/**
 * A stored location split into the boxes a form has.
 *
 *   "Boston, MA"                  -> Boston / MA
 *   "Boston, MA, United States"   -> Boston / MA / United States
 *   "London, United Kingdom"      -> London / — / United Kingdom
 *   "Remote"                      -> nothing
 *   "Greater Boston Area"         -> nothing
 *
 * The middle case is the one worth spelling out: with two parts, a two-letter
 * second part is a state or province and anything longer is a country. That is
 * how people write it, and guessing the other way puts "United Kingdom" into a
 * State box that will not accept it.
 */
export function splitLocation(
  location: string,
): { city?: string; state?: string; country?: string } | undefined {
  const said = tidy(location);
  if (!said || !said.includes(',')) return undefined;

  const parts = said.split(',').map(tidy).filter(Boolean);
  if (parts.length === 2) {
    const [city, second] = parts as [string, string];
    if (POSTAL_CODE.test(second)) return { city, state: second };
    if (COUNTRYISH.test(second)) return { city, country: second };
    return undefined;
  }
  if (parts.length === 3) {
    const [city, state, country] = parts as [string, string, string];
    return COUNTRYISH.test(country) ? { city, state, country } : undefined;
  }
  return undefined;
}

/**
 * Everything the profile implies, for a form to be filled from.
 *
 * Keyed the way the extension's own patterns are keyed, so the two sides name
 * the same things. Hand-entered extras are laid over the top by the caller,
 * which is what makes every one of these a default rather than a decision.
 */
export function derivedAutofill(profile: Pick<Profile, 'location'> & { name?: string }): Record<string, string> {
  const out: Record<string, string> = {};

  const name = splitName(profile.name ?? '');
  if (name) {
    out.first_name = name.first;
    out.last_name = name.last;
  }

  const where = splitLocation(profile.location ?? '');
  if (where?.city) out.address_city = where.city;
  if (where?.state) out.address_state = where.state;
  if (where?.country) out.address_country = where.country;

  return out;
}
