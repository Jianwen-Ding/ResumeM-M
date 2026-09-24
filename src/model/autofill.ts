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
import { parsePeriod } from './period.js';
import { isVariantField } from './types.js';
import type { Entry, MaybeVariant, Profile } from './types.js';

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
    if (POSTAL_CODE.test(second)) return { city, state: asCode(second) };
    if (COUNTRYISH.test(second)) return { city, country: second };
    return undefined;
  }
  if (parts.length === 3) {
    const [city, state, country] = parts as [string, string, string];
    return COUNTRYISH.test(country) ? { city, state: asCode(state), country } : undefined;
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
    if (!end.month) return { graduation_year: year, graduation_date: year };
    const month = MONTHS[end.month - 1]!;
    return { graduation_year: year, graduation_month: month, graduation_date: `${month} ${year}` };
  }

  /*
   * And when it began, for the forms whose Education block asks for both ends
   * — Greenhouse's has "Start date month" and "Start date year" beside the end.
   * Same rule: the month only where it is written.
   */
  const start = period?.start;
  if (start?.year) {
    out.education_start_year = String(start.year);
    if (start.month) {
      out.education_start_month = MONTHS[start.month - 1]!;
      out.education_start_date = `${out.education_start_month} ${start.year}`;
    } else {
      out.education_start_date = String(start.year);
    }
  }

  const end = period?.ongoing ? undefined : period?.end;
  if (!end?.year) return out;
  const year = String(end.year);
  if (!end.month) return { ...out, graduation_year: year, graduation_date: year };
  const month = MONTHS[end.month - 1]!;
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
  const said = tidy(String(line ?? '').replace(GPA_CLAUSE, ''))
    .replace(/[,;]\s*$/, '')
    .trim();
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
  const hit = /\bGPA[:\s]+(\d(?:\.\d+)?)(?:\s*\/\s*(\d(?:\.\d+)?))?/i.exec(String(line ?? ''));
  if (!hit) return undefined;
  const score = Number(hit[1]);
  const scale = hit[2] === undefined ? undefined : Number(hit[2]);
  // A score above its own scale is a misreading, not a grade.
  if (!Number.isFinite(score) || score <= 0) return undefined;
  if (scale !== undefined && (!Number.isFinite(scale) || score > scale)) return undefined;
  return hit[1];
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

  const ranked = schools
    .map((e) => ({ e, ends: e.period?.end?.year ?? undefined }))
    .filter((r) => r.ends !== undefined)
    .sort((a, b) => b.ends! - a.ends!);

  // Two that finished in the same year cannot be told apart this way, and a
  // wrong school on a submitted application is worse than an empty box.
  if (ranked.length === 0 || ranked[0]!.ends === ranked[1]?.ends) return undefined;
  return ranked[0]!.e;
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
    if (named) out.school = named;

    Object.assign(out, graduation(asWritten(school.dates, pick('dates'))));

    const line = asWritten(school.subtitle, pick('subtitle'));
    const split = splitDegree(line);
    if (split) {
      out.degree = split.degree;
      out.major = split.major;
    }

    /*
     * Read from every wording, not only the default. Whether the GPA is on the
     * resume is a decision about the resume; whether a form is told it is a
     * different decision, and a box marked "GPA" is asking.
     */
    const anywhere = isVariantField(school.subtitle)
      ? school.subtitle.variants.map((v) => String(v.text))
      : [line];
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
