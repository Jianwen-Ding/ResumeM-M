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
 * "Morgan Testwell" and "Boston, MA", unless the person went and typed the parts
 * out again as extras.
 *
 * Derived, never asserted: anything set by hand in `autofill` wins, so this
 * can only fill a box that was going to be empty. And nothing is guessed — a
 * name or a location this cannot read confidently yields no key at all, which
 * leaves the field blank exactly as before. An empty required field is
 * annoying and visible; a wrong name on a submitted application is neither.
 */
import { plainText } from '../render/latex.js';
import { parsePeriod, sortKey } from './period.js';
import { isVariantField } from './types.js';
import type { Entry, MaybeVariant, Period, Profile, ResolvedResume } from './types.js';

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

/*
 * Letters after a comma that are a credential, not a given name: "Jane Smith,
 * CFA", "Jane Smith, MS/PMP", "Testwell, Morgan, Ph.D.". Capitals, or one of
 * the mixed-case degrees, alone or several joined by a slash or a space.
 */
const CAPITALS = /^[A-Z]{2,6}\.?$/;
const MIXED_DEGREE = /^(?:ph\.?\s?d|m\.?sc|b\.?sc|m\.?eng|b\.?eng|m\.?phil|d\.?phil|esq)\.?$/i;
const isCredential = (part: string) => {
  const words = tidy(part).split(/\s*\/\s*|\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => SUFFIX.test(w) || CAPITALS.test(w) || MIXED_DEGREE.test(w));
};

/** A title in front of the name, which no form's First name box wants. */
const HONORIFIC = /^(?:dr|mr|mrs|ms|mx|miss|prof|professor)\.?\s+/i;

/**
 * A full name split into the two boxes a form actually has.
 *
 * Returns nothing rather than a guess wherever the split is not plain:
 *
 *   "Morgan Testwell"         -> Morgan / Testwell
 *   "Testwell, Morgan"        -> Morgan / Testwell   (the filed order)
 *   "Ludwig van Beethoven"    -> Ludwig / van Beethoven
 *   "Martin Luther King Jr."  -> Martin / King
 *   "Cher"                    -> nothing; one word is not two boxes
 *   "J. R. R. Tolkien"        -> J. / Tolkien
 */
export function splitName(full: string): { first: string; last: string } | undefined {
  const said = tidy(full).replace(HONORIFIC, '');
  if (!said) return undefined;

  /*
   * A credential after a comma is a suffix, as "Jr." is: "Jane Smith, CFA"
   * was read as the filed order and sent "CFA" as the first name. Only
   * letters that read as one — an all-capitals name filed as "SMITH, JANE"
   * is still a name.
   */
  const parts = said.split(',');
  while (parts.length > 1 && isCredential(parts[parts.length - 1]!) && !/^[^a-z]*$/.test(parts[0]!)) parts.pop();

  // "Surname, Given" is how a name is filed, and people store it that way.
  // One comma only: two commas is a list or a name with a suffix after it,
  // and neither is this.
  if (parts.length === 2) {
    const last = tidy(parts[0]);
    const first = tidy(parts[1]).replace(HONORIFIC, '').split(/\s+/)[0] ?? '';
    return last && first && !SUFFIX.test(first) ? { first, last } : undefined;
  }
  if (parts.length > 2) return undefined;

  const words = tidy(parts[0]).split(/\s+/).filter((w) => !SUFFIX.test(w));
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
 * The name a resume prints, as a form's preferred-name boxes ask for it, and
 * nothing when it is the legal name. Split as the legal name is, by
 * `splitName`: "Martin Luther King Jr." prefers to be called Martin King, not
 * Martin "Luther King Jr.". A name `splitName` cannot read still fills the
 * whole-name box and leaves the two parts for the person.
 */
export function preferredName(printed: string, legal: string): Record<string, string> {
  const name = tidy(printed);
  if (!name || name === tidy(legal)) return {};
  const split = splitName(name);
  return {
    preferred_name: name,
    ...(split ? { preferred_first_name: split.first, preferred_last_name: split.last } : {}),
  };
}

/**
 * Two US states share their postal code with an ordinary word, and nothing
 * else here is ambiguous: the check below is on shape, not on a list of
 * places, so it holds for Ontario and Bavaria as well as Massachusetts.
 *
 * Case-insensitive, because a profile is hand-written YAML and nobody types
 * their own address into a validated field. This was `^[A-Z]{2}$`, so
 * "boston, ma" fell past the state branch into the country one and put **ma**
 * in the Country box of a job application — which the rule right below says
 * it should not, and which is worse than filling nothing. Everything else
 * here that cannot be read offers nothing, and nothing is a blank the person
 * completes; "ma" is a wrong answer they have to spot first.
 */
const POSTAL_CODE = /^[A-Za-z]{2}$/i;

/**
 * A two-letter code is an abbreviation, and its written form is capitals.
 *
 * Applied only where the shape says code — a province written out is a name,
 * and a name is not shouted back at the person who wrote it.
 */
const asCode = (s: string) => (POSTAL_CODE.test(s) ? s.toUpperCase() : s);

/*
 * The two-letter codes that are a state or a province: the fifty, DC and the
 * territories, and Canada's thirteen. Only these go in the State box. "UK",
 * "US" and "DE" are two letters too, and the shape alone put **UK** in the
 * State box of a form for somebody in London.
 */
const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico', GU: 'Guam',
  VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};
const PROVINCES: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut',
  ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};
const STATE_CODES = new Set([...Object.keys(US_STATES), ...Object.keys(PROVINCES)]);
const STATE_NAMES = new Set(
  [...Object.values(US_STATES), ...Object.values(PROVINCES), 'Washington DC', 'Washington D.C.', 'Québec', 'Newfoundland'].map((n) =>
    n.toLowerCase(),
  ),
);

/*
 * Countries by name and by ISO code, from the runtime's own region names so
 * the list is every country's and not the handful somebody thought of; and
 * the ways people write their own that are not the ISO name.
 */
const COUNTRY_CODES = new Set<string>(['UK', 'USA']);
/*
 * And a country as its own people write it. The runtime's region names are
 * English, so "München, Deutschland", "Madrid, España", "Amsterdam,
 * Nederland" and "Москва, Россия" — which is how somebody whose resume is
 * in their own language writes where they live — split into no boxes at all
 * while "Munich, Germany" did. The endonyms of the countries whose forms
 * this meets, with the spellings their neighbours use for the shared ones.
 */
const ENDONYMS = [
  'Deutschland', 'Österreich', 'Schweiz', 'Suisse', 'Svizzera', 'España', 'Brasil', 'Nederland', 'Italia', 'Polska',
  'Россия', 'Российская Федерация', '日本', '中国', '中华人民共和国', '한국', '대한민국', 'France', 'Belgique', 'België',
  'Sverige', 'Norge', 'Danmark', 'Suomi', 'Portugal', 'México', 'Argentina', 'Chile', 'Colombia', 'Perú',
  'Türkiye', 'Ελλάδα', 'Česko', 'Česká republika', 'Magyarország', 'România', 'Україна', 'Éire', 'Ísland',
  'Hrvatska', 'Slovensko', 'Slovenija', 'Lietuva', 'Latvija', 'Eesti', 'Luxembourg', 'Lëtzebuerg', 'ישראל',
  'مصر', 'المغرب', 'भारत', 'ประเทศไทย', 'Việt Nam', 'Indonesia', 'Pilipinas', 'Malaysia', 'Singapura',
  'Estados Unidos', 'Vereinigte Staaten', 'États-Unis', 'Reino Unido', 'Royaume-Uni', 'Großbritannien', 'Canadá', 'Kanada',
  'Australien', 'Австралия', 'Niederlande', 'Países Bajos', 'Pays-Bas', 'Frankreich', 'Francia', 'Alemania', 'Allemagne',
  'Alemanha', 'Germania', 'Italien', 'Italie', 'Spanien', 'Espagne', 'Espanha', 'Schweden', 'Suède', 'Suecia', 'Noruega',
  'Norwegen', 'Norvège', 'Dänemark', 'Danemark', 'Dinamarca', 'Finnland', 'Finlande', 'Finlandia', 'Polen', 'Pologne', 'Polonia',
  'Griechenland', 'Grèce', 'Grecia', 'Russland', 'Russie', 'Rusia', 'Rússia', 'Japan', 'Japon', 'Japón', 'Japão', 'China', 'Chine',
  'Türkei', 'Turquie', 'Turquía', 'Belgien', 'Bélgica', 'Portugal', 'Mexiko', 'Mexique', 'Argentinien', 'Argentine', 'Chili',
  'Kolumbien', 'Colombie', 'Brasilien', 'Brésil', 'Südkorea', 'Corée du Sud', 'Corea del Sur', 'Coreia do Sul', 'Irland',
  'Irlande', 'Irlanda', 'Schottland', 'Écosse', 'Escocia', 'Inglaterra', 'Angleterre', 'Tschechien', 'Tchéquie', 'Chequia',
];
const COUNTRY_NAMES = new Set<string>(
  [
    'USA', 'U.S.A.', 'U.S.', 'UK', 'U.K.', 'United States of America', 'America', 'England', 'Scotland',
    'Wales', 'Northern Ireland', 'Great Britain', 'Britain', 'Czech Republic', 'Republic of Korea',
    'Korea', 'Holland', 'The Netherlands', 'UAE', 'Russia', 'Vietnam', 'Türkiye', 'Turkey',
    ...ENDONYMS,
  ].map((n) => n.normalize('NFC').toLowerCase()),
);
try {
  const regions = new Intl.DisplayNames(['en'], { type: 'region' });
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = regions.of(code);
      if (!name || name === code || /unknown/i.test(name)) continue;
      COUNTRY_CODES.add(code);
      COUNTRY_NAMES.add(name.toLowerCase());
    }
  }
} catch {
  // A runtime without region names knows the aliases above and nothing more.
}

const plain = (s: string) => s.replace(/\./g, '').trim();
const isStateCode = (s: string) => POSTAL_CODE.test(plain(s)) && STATE_CODES.has(plain(s).toUpperCase());
const isStateName = (s: string) => STATE_NAMES.has(s.toLowerCase());
const isCountry = (s: string) =>
  COUNTRY_NAMES.has(s.normalize('NFC').toLowerCase()) || COUNTRY_CODES.has(plain(s).toUpperCase()) && /^[A-Za-z.]{2,6}$/.test(s);

/*
 * A Japanese address is written largest first and with no commas: 東京都渋谷区
 * is the prefecture 東京都 and then the ward 渋谷区. The prefecture ends in
 * one of four characters, and what follows it is the city or ward a form's
 * City box takes.
 */
const JP_PREFECTURE = /^(.{1,4}[都道府県])(.+)$/u;

/** Where somebody works that is not a place: never a city. */
const NOT_A_CITY = /^(?:remote|hybrid|anywhere|on-?site|in[- ]office|wfh|work from home|various|multiple locations?)$/i;

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
  if (!said) return undefined;
  if (!said.includes(',')) {
    const jp = JP_PREFECTURE.exec(said);
    return jp && /\p{Script=Han}/u.test(jp[2]!) ? { city: jp[2]!, state: jp[1]! } : undefined;
  }

  // The full-width comma a Japanese or Chinese location is written with.
  const parts = said.split(/[,、，]/).map(tidy).filter(Boolean);
  const town = (city: string) => (NOT_A_CITY.test(city) ? {} : { city });
  /*
   * A state's code before a country's, because the two overlap — "CA",
   * "DE", "IN" — and a location written "City, XX" in a store that is
   * mostly American is a state. Anything not known to be either goes in no
   * box at all: a blank is filled in by the person, a wrong box has to be
   * noticed first.
   */
  if (parts.length === 2) {
    const [city, second] = parts as [string, string];
    if (isStateCode(second)) return { ...town(city), state: plain(second).toUpperCase() };
    if (isCountry(second)) return { ...town(city), country: second };
    if (isStateName(second)) return { ...town(city), state: second };
    return undefined;
  }
  if (parts.length === 3) {
    const [city, state, country] = parts as [string, string, string];
    return isCountry(country) ? { ...town(city), state: asCode(state), country } : undefined;
  }
  return undefined;
}

/**
 * The wording a field is set to: the one this resume chose, if it chose one
 * that exists, and the field's own default otherwise.
 */
function asWritten(field: MaybeVariant | undefined, wanted?: string): string {
  if (field === undefined) return '';
  if (!isVariantField(field)) return tidy(field);
  const chosen =
    (wanted ? field.variants.find((v) => v.id === wanted) : undefined) ??
    field.variants.find((v) => v.id === field.default) ??
    field.variants[0];
  return tidy(chosen?.text);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The month a date point actually names, if it names one.
 *
 * `parsePeriod` gives a season a month — Spring is March, Fall September —
 * because a season has to sort somewhere among the months beside it. That
 * month is a sorting aid and nothing more: "Expected Spring 2026" went into a
 * form's graduation boxes as "March 2026", and "Summer 2025" into Workday's
 * "From" as June, a month the resume never says. A season reports its year
 * alone, the same as a date written with no month.
 */
function writtenMonth(point: { month?: number; season?: string } | undefined): number | undefined {
  if (!point || point.season) return undefined;
  return point.month;
}

/**
 * When the degree ends, as the three boxes forms ask for it in.
 *
 * Read off the printed dates rather than `period`, because the printed dates
 * are what varies per resume and `period` is derived from the default wording
 * alone. An entry in progress has no end to report, and an end with no month
 * reports only its year: a guessed month on a graduation date is a claim
 * about when somebody is available to start work.
 */
export function graduation(dates: string): Record<string, string> {
  const period = parsePeriod(dates);
  const out: Record<string, string> = {};

  /*
   * A lone date is the end. "May 2026" on a degree is when it finishes — the
   * starter save writes it that way and so do most people — and read as a
   * start, the form's graduation boxes got nothing while its "Start date"
   * boxes got the graduation.
   */
  const single = Boolean(period?.start && !period.end && !period.ongoing);
  if (single) {
    const end = period!.start!;
    const year = String(end.year);
    const endMonth = writtenMonth(end);
    if (!endMonth) return { graduation_year: year, graduation_date: year };
    const month = MONTHS[endMonth - 1]!;
    return { graduation_year: year, graduation_month: month, graduation_date: `${month} ${year}` };
  }

  /*
   * And when it began, for the forms whose Education block asks for both ends
   * — Greenhouse's has "Start date month" and "Start date year" beside the end.
   * Same rule: the month only where it is written, and a season writes none.
   */
  const start = period?.start;
  if (start?.year) {
    out.education_start_year = String(start.year);
    const startMonth = writtenMonth(start);
    if (startMonth) {
      out.education_start_month = MONTHS[startMonth - 1]!;
      out.education_start_date = `${out.education_start_month} ${start.year}`;
    } else {
      out.education_start_date = String(start.year);
    }
  }

  const end = period?.ongoing ? undefined : period?.end;
  if (!end?.year) return out;
  const year = String(end.year);
  const endMonth = writtenMonth(end);
  if (!endMonth) return { ...out, graduation_year: year, graduation_date: year };
  const month = MONTHS[endMonth - 1]!;
  return { ...out, graduation_year: year, graduation_month: month, graduation_date: `${month} ${year}` };
}

/**
 * A degree line split into the two boxes a form has.
 *
 * Every ATS asks for these apart — Greenhouse has "Degree" and "Discipline",
 * Workday "Degree" and "Field of Study" — and a resume writes them as one
 * line, because that is how a resume reads. The join is almost always " in ":
 *
 *   "Bachelor of Science in Computer Science"  -> BS line / Computer Science
 *   "BS in Computer Science"                   -> BS in  / Computer Science
 *   "Master of Engineering, Robotics"          -> nothing; see below
 *   "Computer Science"                         -> nothing; no degree in it
 *
 * Returns nothing rather than a guess wherever the split is not plain. A comma
 * is not read as the join: "Bachelor of Science, Computer Science" and
 * "Bachelor of Science, Summa Cum Laude" are the same shape and only one of
 * them has a discipline after the comma.
 */
export function splitDegree(line: string): { degree: string; major: string } | undefined {
  // Whatever a GPA clause contributes, it is not part of either box.
  let said = tidy(String(line ?? '').replace(GPA_CLAUSE, '').replace(HONOURS_ANYWHERE, ''))
    .replace(/[,;]\s*$/, '')
    .trim();
  /*
   * Nor a minor, a concentration or an honours clause after it, which have
   * an " in " of their own: "B.S. in Computer Science, Minor in Mathematics"
   * split on the last one and sent "Mathematics" as the major.
   */
  for (let was = ''; said !== was; ) {
    was = said;
    said = tidy(said.replace(TRAILING_CLAUSE, '').replace(/[,;]\s*$/, ''));
  }
  if (!said) return undefined;

  /*
   * The last " in ", not the first. "Bachelor of Science in Engineering in
   * Computer Science" is a real degree name and the discipline is the tail.
   */
  const at = said.toLowerCase().lastIndexOf(' in ');
  if (at <= 0) return undefined;

  const degree = tidy(said.slice(0, at));
  const major = tidy(said.slice(at + 4));
  if (!degree || !major) return undefined;
  // "in" as a word inside the discipline rather than as the join: whatever is
  // on the left has to read like a degree.
  if (!DEGREE_WORD.test(degree)) return undefined;
  return { degree, major };
}

/*
 * What a degree line says after the discipline that is not the discipline:
 * a minor, a concentration, a specialization, a track or an emphasis, and
 * the honours it was taken with. Only after a separator — a comma, "with",
 * "and", a dash or a bracket — so "Honors Mathematics" is left alone.
 */
const TRAILING_CLAUSE =
  /\s*(?:[,;(–—]|\s-\s|\bwith\b|\band\b)\s*(?:(?:an?|the)\s+)?(?:(?:double|dual|second|secondary)\s+)?(?:minors?|concentrations?|speciali[sz]ations?|tracks?|emphas[ie]s|(?:(?:summa|magna)\s+)?cum\s+laude|(?:first|second|third|upper|lower|1st|2nd|2:[12])[- ]class(?:\s+hono(?:u)?rs)?|(?:high(?:est)?\s+)?(?:hono(?:u)?rs|distinction)|hono(?:u)?rs)\b.*$/i;

/** "(Honours)" or "(Hons)" wherever it is, which is not part of either box. */
const HONOURS_ANYWHERE = /\s*\((?:with\s+)?(?:first[- ]class\s+)?hon(?:ou?r)?s\.?\)/gi;

/** The words that make a phrase a qualification rather than a subject. */
const DEGREE_WORD =
  /\b(bachelor'?s?|master'?s?|doctor(ate)?|associate'?s?|b\.?s\.?c?|b\.?a\.?|b\.?eng|m\.?s\.?c?|m\.?a\.?|m\.?eng|m\.?b\.?a|ph\.?d|j\.?d|m\.?d|diploma|certificate)\b/i;

/**
 * A grade point average, as a form wants it: the number alone.
 *
 * The resume writes "GPA 3.8/4.0" because the scale is worth printing beside
 * it; the box asks for one number and validates it. Only a plausible one — a
 * "GPA" followed by something that is not a grade is a sentence, not a score.
 */
const GPA_CLAUSE = /[,;]?\s*\bGPA[:\s]+\d(?:\.\d+)?(?:\s*\/\s*\d(?:\.\d+)?)?/i;

export function readGpa(line: string): string | undefined {
  /*
   * Said either way round. "GPA 3.8/4.0" is one habit and "3.97 GPA" the
   * other, and the second is how a school line carries it — "University of
   * Virginia, 3.97 GPA" — which was read as no grade at all.
   */
  const said = String(line ?? '');
  const hit =
    /\bGPA[:\s]+(\d(?:\.\d+)?)(?:\s*\/\s*(\d(?:\.\d+)?))?/i.exec(said) ??
    /\b(\d\.\d{1,2})(?:\s*\/\s*(\d(?:\.\d+)?))?\s+(?:cumulative\s+|overall\s+)?GPA\b/i.exec(said);
  if (!hit) return undefined;
  const score = Number(hit[1]);
  const scale = hit[2] === undefined ? undefined : Number(hit[2]);
  // A score above its own scale is a misreading, not a grade.
  if (!Number.isFinite(score) || score <= 0) return undefined;
  if (scale !== undefined && (!Number.isFinite(scale) || score > scale)) return undefined;
  return hit[1];
}

/**
 * A school as a form's school box wants it: the name, and nothing the resume
 * wrote after it.
 *
 * A resume puts the grade on the school line as often as on the degree line —
 * "University of Virginia, 3.97 GPA" — and the whole line went to the form.
 * Greenhouse's School is a search over its own list of schools, and a search
 * for "Northeastern University, 4.0 GPA" finds nothing: measured on Twitch's
 * live board, both School boxes were left on "Select..." while everything
 * else in both education blocks filled. The grade is read separately (see
 * `readGpa`); here it only comes off.
 */
const SCHOOL_TAIL = /\s*[,;|–—-]\s*(?:(?:\d(?:\.\d+)?\s*(?:\/\s*\d(?:\.\d+)?\s*)?(?:cumulative\s+|overall\s+)?GPA)|(?:GPA[:\s]*\d(?:\.\d+)?(?:\s*\/\s*\d(?:\.\d+)?)?))\s*$/i;

export function schoolName(title: string): string {
  const said = tidy(String(title ?? ''));
  return tidy(said.replace(SCHOOL_TAIL, '')) || said;
}

/**
 * A degree as a form's degree box wants it: the qualification, without what
 * the resume said about the applicant's standing in it.
 *
 * "Candidate for Bachelor of Science" and "Former Candidate for Bachelor of
 * Science" are true on a resume and nothing on a form's list of degrees,
 * which says "Bachelor's Degree". The qualification is what the list matches.
 */
const DEGREE_STANDING = /^(?:(?:former|current)\s+)?(?:candidate\s+for(?:\s+(?:a|an|the))?|expected|pursuing(?:\s+(?:a|an))?|in\s+progress:?)\s+/i;

export function degreeName(degree: string): string {
  const said = tidy(String(degree ?? ''));
  return tidy(said.replace(DEGREE_STANDING, '')) || said;
}

/**
 * Which education entry a form is asking about.
 *
 * One box each for school, degree and discipline means the most recent one —
 * a form with room for a whole history has several sets of boxes, and filling
 * the first set with the oldest degree is the wrong answer to both questions.
 *
 * `period.end` rather than the printed dates: the text is "Sep. 2022 -- May
 * 2026" and the structured field is the same information already parsed. An
 * entry with no readable end date cannot be compared, so where the newest is
 * not plain this yields nothing at all rather than picking arbitrarily.
 */
function newestEducation(entries: Entry[]): Entry | undefined {
  const schools = entries.filter((e) => e.kind === 'education' && !e.archived);
  if (schools.length === 0) return undefined;
  if (schools.length === 1) return schools[0];

  /*
   * By `sortKey`, which puts a degree in progress above one finished and
   * reads a lone date as the end, as `graduation` does. Ranked on the end
   * year alone, "Sep. 2024 -- Present" and "Expected May 2026" had no end
   * and were skipped, and the form was given the bachelor's finished years
   * ago instead of the master's being taken now.
   */
  const key = (p: Period | undefined) => {
    if (p?.start) return sortKey(p);
    return p?.end?.year ? p.end.year * 100 + (p.end.month ?? 12) : undefined;
  };
  const ranked = schools
    .map((e) => {
      const period = e.period ?? parsePeriod(asWritten(e.dates));
      return { e, period, ends: key(period) };
    })
    .filter((r) => r.ends !== undefined)
    .sort((a, b) => b.ends! - a.ends!);

  // Two that finished in the same year cannot be told apart this way unless
  // both name the month, and a wrong school on a submitted application is
  // worse than an empty box.
  const [first, second] = ranked;
  if (!first) return undefined;
  if (second) {
    if (first.ends === second.ends) return undefined;
    const point = (p?: Period) => p?.end ?? p?.start;
    const [a, b] = [point(first.period), point(second.period)];
    if (!first.period?.ongoing && a?.year === b?.year && (!a?.month || !b?.month)) return undefined;
  }
  return first.e;
}

/**
 * The job somebody holds now, if they hold exactly one.
 *
 * Only an entry whose dates run to the present. "Current company" answered
 * with the last place somebody worked is a statement that they work there
 * now, made on their behalf to a prospective employer — and for a student
 * between internships, which is who this is mostly for, it is false. The box
 * is better left for them to fill with nothing, or with their school.
 *
 * Several ongoing roles — a teaching assistantship beside an internship — are
 * ranked by when they started, and two that started together are not ranked
 * at all.
 */
function currentJob(entries: Entry[], choices: Record<string, string>): Entry | undefined {
  const ongoing = entries.filter((e) => {
    if (e.kind !== 'experience' || e.archived) return false;
    return parsePeriod(asWritten(e.dates, choices[`${e.id}.dates`]))?.ongoing === true;
  });
  if (ongoing.length <= 1) return ongoing[0];
  const started = (e: Entry) => {
    const start = parsePeriod(asWritten(e.dates, choices[`${e.id}.dates`]))?.start;
    return start ? start.year * 12 + (start.month ?? 1) : undefined;
  };
  const ranked = ongoing
    .map((e) => ({ e, from: started(e) }))
    .filter((r) => r.from !== undefined)
    .sort((a, b) => b.from! - a.from!);
  if (ranked.length === 0 || ranked[0]!.from === ranked[1]?.from) return undefined;
  return ranked[0]!.e;
}

/**
 * Everything the profile implies, for a form to be filled from.
 *
 * Keyed the way the extension's own patterns are keyed, so the two sides name
 * the same things. Hand-entered extras are laid over the top by the caller,
 * which is what makes every one of these a default rather than a decision.
 */
export function derivedAutofill(
  profile: Pick<Profile, 'location'> & { name?: string },
  /*
   * And the education entries, which are the other half of the same problem
   * this file opens with.
   *
   * `FIELD_PATTERNS` in the extension has recognised `school`, `degree`,
   * `major` and `gpa` from the start, exactly as it recognised the name and
   * address parts, and the store answered none of them — so the Education
   * section of a Greenhouse form came out empty on a store that plainly holds
   * a university, a degree and a grade. The same bug as the names, found the
   * same way, and hidden the same way: every test store had them typed in as
   * extras.
   */
  entries: Entry[] = [],
  /*
   * Which wordings the resume being sent uses, keyed as a resume's own
   * `choices` are: `edu_neu.dates` and so on.
   *
   * The graduation date is the reason this exists. A store for somebody who
   * applies to both internships and new-grad roles holds two — "May 2026" and
   * a later one that keeps them eligible for a summer internship — and picks
   * between them per posting. Read from the default, every internship form was
   * told May 2026 while the resume attached to it said December: the exact
   * mismatch that switching the date was built to prevent, reintroduced one
   * box lower down the same form.
   */
  choices: Record<string, string> = {},
): Record<string, string> {
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

  /*
   * The employer and the job title, which Lever asks for on every form as
   * "Current company" and SmartRecruiters and Workday as the job you hold now.
   * An experience entry's left heading is the company and its second line the
   * role, the same way an education entry's are the school and the degree.
   */
  const job = currentJob(entries, choices);
  if (job) {
    const company = asWritten(job.title, choices[`${job.id}.title`]);
    const title = asWritten(job.subtitle, choices[`${job.id}.subtitle`]);
    if (company) out.current_company = company;
    if (title) out.current_title = title;
  }

  const school = newestEducation(entries);
  if (school) {
    /*
     * The wording the resume being sent chose, where one is being sent, and
     * the default where not. A resume picks between the variants per posting —
     * the GPA line for a GPA-screened one, the later graduation date for an
     * internship — and the form has to agree with the document attached to it.
     */
    const pick = (field: string) => choices[`${school.id}.${field}`];
    const named = asWritten(school.title, pick('title'));
    if (named) out.school = schoolName(named);

    Object.assign(out, graduation(asWritten(school.dates, pick('dates'))));

    const line = asWritten(school.subtitle, pick('subtitle'));
    const split = splitDegree(line);
    if (split) {
      out.degree = degreeName(split.degree);
      out.major = split.major;
    }

    /*
     * Read from every wording, not only the default. Whether the GPA is on the
     * resume is a decision about the resume; whether a form is told it is a
     * different decision, and a box marked "GPA" is asking. The school line
     * first, where "University of Virginia, 3.97 GPA" carries it.
     */
    const anywhere = [
      named,
      ...(isVariantField(school.subtitle) ? school.subtitle.variants.map((v) => String(v.text)) : [line]),
    ];
    for (const said of anywhere) {
      const gpa = readGpa(said);
      if (gpa) {
        out.gpa = gpa;
        break;
      }
    }
  }

  return out;
}

/** One job, the way a work-history section of a form asks for it. */
export interface PastJob {
  company: string;
  title?: string;
  location?: string;
  /** Month 1-12 where the resume gives one; the year alone where it does not. */
  start?: { year: number; month?: number };
  end?: { year: number; month?: number };
  /** "Present": the form's "I currently work here". */
  current: boolean;
  /** The lines this resume prints for it, as plain text, one to a line. */
  description: string;
}

/**
 * Store markup is for the renderer; a form box takes plain words.
 *
 * Taken off by the renderer's own rule. This had a copy of the asterisk rules
 * and nothing for `_italic_`, so a line the PDF sets as "a *really* fast" and
 * "a _really_ fast" alike went into the form as "a really fast" and
 * "a _really_ fast". One rule, and the underscores in `snake_case` and an
 * address stay where they are, as they do on the page.
 */
function plainLine(text: string | undefined): string {
  return plainText(String(text ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// A season's month is a sorting aid (see `writtenMonth`), so "Summer 2025"
// fills a form's From with 2025 and leaves its month for the person.
const monthYear = (p?: { year: number; month?: number; season?: string }) => {
  if (!p?.year) return undefined;
  const month = writtenMonth(p);
  return { year: p.year, ...(month ? { month } : {}) };
};

/**
 * Every job on the resume being sent, for the work-history blocks a form asks
 * for one at a time.
 *
 * Workday's "My Experience" wants each job as Job Title, Company, Location,
 * "I currently work here", From, To and Role Description, and nothing filled
 * any of it: the profile knows one current job, and the Role Description —
 * the box that most plainly *is* the resume — was left for the person to type
 * out again, job by job, from the document they were attaching.
 *
 * From the resolved resume, so it is this resume's jobs, in this resume's
 * order, with the lines this resume prints: a job it leaves off is not
 * offered, and a line it has switched off is not in the box. The words are
 * the store's own — nothing here writes a description; it copies the one
 * already on the page. An experience entry's heading is the employer and its
 * second line the role, as `derivedAutofill` reads the current job.
 */
export function workHistory(resume: ResolvedResume): PastJob[] {
  const jobs: PastJob[] = [];
  for (const section of resume.sections) {
    for (const entry of section.entries) {
      if (entry.kind !== 'experience') continue;
      const company = plainLine(entry.title);
      if (!company) continue;
      const period = parsePeriod(entry.dates ?? '');
      // A lone date on a job is when it was, start and end alike.
      const start = monthYear(period?.start);
      const end = period?.ongoing ? undefined : monthYear(period?.end ?? (period?.start && !period.ongoing ? period.start : undefined));
      const title = plainLine(entry.subtitle);
      const location = plainLine(entry.location);
      jobs.push({
        company,
        ...(title ? { title } : {}),
        ...(location ? { location } : {}),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        current: Boolean(period?.ongoing),
        description: entry.bullets
          .map((b) => plainLine(b.text))
          .filter(Boolean)
          .map((line) => `• ${line}`)
          .join('\n'),
      });
    }
  }
  return jobs;
}

/** One education, the way a form's Education block asks for it. */
export interface PastEducation {
  school: string;
  /** "Bachelor of Science", where the degree line splits plainly. See `splitDegree`. */
  degree?: string;
  /** "Computer Science": Greenhouse's Discipline, Workday's Field of Study. */
  major?: string;
  location?: string;
  /** Month 1-12 where the resume gives one; the year alone where it does not. */
  start?: { year: number; month?: number };
  /** When it finishes or finished. Absent for one still in progress with no end written. */
  end?: { year: number; month?: number };
  gpa?: string;
}

/**
 * Every education on the resume being sent, for a form that asks for them one
 * block at a time.
 *
 * Greenhouse's Education section is a School, a Degree, a Discipline and the
 * dates, with an "Add another" under it for the next one — and the profile's
 * fields describe one education only, the newest (see `newestEducation`). So
 * somebody with a bachelor's and a master's had the master's put in the first
 * block and the bachelor's left for them to add and type out again, from the
 * resume they were attaching.
 *
 * From the resolved resume, exactly as `workHistory` is: this resume's
 * schools, in this resume's order, with the wordings it chose — the later
 * graduation date for an internship, the degree line it prints. An education
 * it leaves off is not offered.
 *
 * Read the way `derivedAutofill` reads the newest one, so the first block and
 * the rest agree about what a degree line and a date mean: the degree and the
 * discipline only where the line splits plainly, a lone date as the end — the
 * graduation, which is what "May 2026" on a degree means — and nothing for a
 * degree still in progress with no end written. The GPA from the printed line,
 * and failing that from any wording the store holds for the same entry,
 * because whether a box marked GPA is told is a different decision from
 * whether the resume prints it (see the note in `derivedAutofill`).
 */
export function educationHistory(resume: ResolvedResume, entries: Entry[] = []): PastEducation[] {
  const out: PastEducation[] = [];
  for (const section of resume.sections) {
    for (const entry of section.entries) {
      if (entry.kind !== 'education') continue;
      const titled = plainLine(entry.title);
      const school = schoolName(titled);
      if (!school) continue;

      const period = parsePeriod(entry.dates ?? '');
      const lone = Boolean(period?.start && !period.end && !period.ongoing);
      const start = lone ? undefined : monthYear(period?.start);
      const end = period?.ongoing ? undefined : monthYear(lone ? period?.start : period?.end);

      const line = plainLine(entry.subtitle);
      const split = splitDegree(line);
      const stored = entries.find((e) => e.id === entry.id);
      const wordings =
        stored && isVariantField(stored.subtitle)
          ? stored.subtitle.variants.map((v) => String(v.text))
          : stored?.subtitle !== undefined
            ? [String(stored.subtitle)]
            : [];
      const gpa = [titled, line, ...wordings].map(readGpa).find(Boolean);
      const location = plainLine(entry.location);

      out.push({
        school,
        ...(split ? { degree: degreeName(split.degree), major: split.major } : {}),
        ...(location ? { location } : {}),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(gpa ? { gpa } : {}),
      });
    }
  }
  return out;
}
