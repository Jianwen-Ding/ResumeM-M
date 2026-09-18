/**
 * What kind of hire a posting is for — an internship, a new grad role, or a
 * job wanting years behind you.
 *
 * This exists because one fact on a resume is genuinely different between
 * them, and it is the one the variant model was built around: the graduation
 * date. "Expected May 2027" is right on an internship application and wrong on
 * one for a role starting after that date. Nobody wants to keep two education
 * entries in step by hand, and nobody remembers to switch the ending before
 * hitting submit.
 *
 * It is deliberately separate from keyword matching, and it is held to a
 * higher standard. A keyword swapping one phrasing of a bullet for another is
 * cheap to get wrong; a wrong graduation date is a lie on a document somebody
 * sends to an employer. So the rules below are narrow on purpose: the title
 * decides where it can, the description only speaks in phrases that cannot
 * mean anything else, and a posting that says two things at once says nothing.
 */

export type JobLevel = 'intern' | 'newgrad' | 'experienced';

export interface LevelVerdict {
  level: JobLevel;
  /**
   * The words the posting used, kept so a swap can be shown as "changed
   * because this posting says internship" rather than appearing by itself.
   */
  why: string[];
  /** Whether the title decided it, or a phrase in the body had to. */
  from: 'title' | 'description';
}

/*
 * Titles, in the order they are tried.
 *
 * Intern first: "Software Engineering Intern" is an internship even though a
 * description will also call it entry level, and a title is never both. New
 * grad next for the same reason against `experienced` — "Graduate Software
 * Engineer" is a new grad role, and `\bgraduate\b` alone would also match
 * "Graduate of an accredited program", which is why only the compound forms
 * are here.
 *
 * `\bintern\b` does not match "internal" or "international": the boundary
 * after "intern" fails against a following letter. That was checked, because
 * "Internal Tools Engineer" is a real title and reading it as an internship
 * would put an expected-graduation date on a resume sent to a company hiring
 * someone who has already left school.
 */
const TITLE_RULES: { level: JobLevel; re: RegExp }[] = [
  { level: 'intern', re: /\b(interns?|internships?|co-?ops?|summer analyst|summer associate)\b/i },
  {
    level: 'newgrad',
    re: /\b(new[ -]?grads?|new[ -]?graduates?|recent[ -]?grads?|recent[ -]?graduates?|university[ -]?grads?|university[ -]?graduates?|college[ -]?grads?|early[ -]?career|entry[ -]?level|campus hire|graduate (?:program|programme|scheme)|junior)\b/i,
  },
  {
    level: 'experienced',
    re: /\b(senior|sr\.?|staff|principal|distinguished|lead|manager|director|head of|architect|vp)\b/i,
  },
];

/*
 * Bodies, which only get a say when the title was silent.
 *
 * Every phrase here has to be one that cannot appear in a posting for a
 * different level. That rules out most of the title vocabulary: descriptions
 * say "you will lead the team" in postings for people with no reports, and
 * "junior" turns up in "mentoring junior engineers" on staff-level roles. What
 * survives is language a posting only uses about the hire itself.
 *
 * The years rule starts at three. Under that the number is usually a floor on
 * a new grad posting — "0-2 years of experience" is written for people leaving
 * school — so counting it as experience would invert the answer.
 */
const BODY_RULES: { level: JobLevel; re: RegExp }[] = [
  { level: 'intern', re: /\b(internships?|intern program|intern cohort|summer internship)\b/i },
  {
    level: 'newgrad',
    re: /\b(new[ -]?grads?|new[ -]?graduates?|recent[ -]?graduates?|entry[ -]?level|graduating (?:student|senior|in)|university[ -]?graduates?)\b/i,
  },
  {
    level: 'experienced',
    re: /\b(?:[3-9]|[1-9]\d)\+? years? of (?:relevant |professional |industry |software |engineering )*experience\b/i,
  },
];

function firstMatch(text: string, rules: { level: JobLevel; re: RegExp }[]): { level: JobLevel; word: string } | null {
  for (const rule of rules) {
    const hit = rule.re.exec(text);
    if (hit) return { level: rule.level, word: hit[0].toLowerCase() };
  }
  return null;
}

/**
 * Read the posting's level, or return `null` when it does not say clearly.
 *
 * `null` is the common answer and the safe one: nothing is swapped, and the
 * resume goes out exactly as the keyword match and the applicant left it.
 */
export function detectLevel(job: { title?: string; description?: string }): LevelVerdict | null {
  const title = (job.title ?? '').trim();
  if (title) {
    const hit = firstMatch(title, TITLE_RULES);
    if (hit) return { level: hit.level, why: [hit.word], from: 'title' };
  }

  const description = job.description ?? '';
  if (!description) return null;

  /*
   * All of them, not the first.
   *
   * A description that calls the role an internship and also talks about new
   * grads is either a page carrying two postings or a company describing its
   * whole early-careers pipeline. Either way it is not evidence about this
   * role, and guessing from the one that happened to be listed first would be
   * guessing. Silence is the honest reading.
   */
  const found = new Map<JobLevel, string>();
  for (const rule of BODY_RULES) {
    const hit = rule.re.exec(description);
    if (hit && !found.has(rule.level)) found.set(rule.level, hit[0].toLowerCase());
  }
  const only = [...found][0];
  if (found.size !== 1 || !only) return null;
  return { level: only[0], why: [only[1]], from: 'description' };
}

/*
 * Tags that mark a variant as belonging to a level.
 *
 * Matched after `norm` in the matcher, which deletes separators, so "new grad",
 * "new-grad" and "newgrad" are one tag here and there is no need to list the
 * spellings. Kept short deliberately: a tag in this list stops being free-form
 * and starts steering a swap, so a word somebody might have used to mean
 * something else — a bare "grad" for "graduation", "full time" for a work
 * authorisation note — is left out.
 */
const LEVEL_TAGS: Record<JobLevel, string[]> = {
  intern: ['intern', 'interns', 'internship', 'internships', 'coop', 'co-op'],
  newgrad: ['newgrad', 'new grad', 'newgraduate', 'new graduate', 'entrylevel', 'entry level', 'recentgrad', 'recent grad'],
  experienced: ['experienced', 'senior', 'fulltime', 'full time', 'industry'],
};

const normTag = (s: string): string => s.toLowerCase().replace(/[^a-z0-9+#]/g, '');

/** Normalised tag set for one level. */
export function tagsForLevel(level: JobLevel): Set<string> {
  return new Set(LEVEL_TAGS[level].map(normTag));
}

/** Every tag that marks any level, used to spot a variant meant for a different one. */
export const ALL_LEVEL_TAGS: Set<string> = new Set(
  Object.values(LEVEL_TAGS).flat().map(normTag),
);
