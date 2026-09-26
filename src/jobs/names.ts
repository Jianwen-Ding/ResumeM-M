/**
 * Who a posting is with and what it is called, as far as the words of a name
 * can say.
 *
 * Two places need this and neither may import the other: the extractor
 * (`jobs/extract.ts`), which reads a company and a role off a page, and the
 * tracker's identity (`model/applications.ts`), which decides that two rows
 * are one application. When they disagreed about what one employer or one
 * role is, the same job became two rows — "Red Hat" beside "Redhat",
 * "Gameplay Engineer Intern - Careers" beside "Gameplay Engineer Intern" — so
 * the rules live here, once, with nothing of either side's in them.
 */

/**
 * Letters and digits only, lower case: what every way of writing one name has
 * in common. "Red Hat", "Redhat" and "RED-HAT" are all `redhat`.
 *
 * `+` and `#` are kept, because they name a different thing rather than space
 * one out: C++ and C# are not C. See `MEANT_IT` in `model/applications.ts`.
 */
export function glueName(s: string | undefined): string {
  return String(s ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, '');
}

/** A slug or a tenant as a person writes it: `acme-corp` is "Acme Corp". */
export function titleCased(word: string): string {
  return word
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/*
 * Employers whose name cannot be read back out of the way an address writes it.
 *
 * A Workday tenant is the employer's own word for itself with the spaces taken
 * out — `motorolasolutions`, `redhat` — and title-casing it gives
 * "Motorolasolutions" and "Redhat", which then sat in the tracker beside the
 * "Red Hat" the posting's own page said. The same for a careers host:
 * `careersatdoordash.com` is DoorDash and `jobs.ea.com` is Electronic Arts.
 *
 * Deliberately short: each name here was checked against the employer's own
 * careers site, and a name that is not here is title-cased, which is right for
 * every one-word employer there is. A wrong entry would rename somebody's
 * employer in every row it touched, so nothing goes in on a guess — `epic` is
 * not here at all, because epic.com is Epic Systems and epicgames.com is Epic
 * Games, and only the second can be told from its address alone.
 */
const KNOWN_EMPLOYERS: Record<string, string> = {
  motorolasolutions: 'Motorola Solutions',
  intel: 'Intel',
  redhat: 'Red Hat',
  nvidia: 'NVIDIA',
  doordash: 'DoorDash',
  bytedance: 'ByteDance',
  epicgames: 'Epic Games',
  ea: 'Electronic Arts',
};

/** The employer's own spelling of a tenant or host word it is known by, if it is one of `KNOWN_EMPLOYERS`. */
export function knownEmployer(word: string | undefined): string | undefined {
  return KNOWN_EMPLOYERS[glueName(word)];
}

/*
 * Job boards and aggregators: sites that list other employers' jobs.
 *
 * On one of these the site's own name is everywhere — `og:site_name`, the end of
 * the title, the host — and none of it is the employer. "LinkedIn | Neural
 * Graphics Engineer" and "TalentAlly | Software Engineer" were rows in a
 * tracker for jobs at Arm and at whoever TalentAlly had reposted. The employer
 * on a board comes from what the board says about the job — its structured
 * data, "X hiring Y", the company part of its title — or it is not known.
 *
 * A name here is not refused as an employer everywhere: LinkedIn and Indeed
 * hire engineers, and a posting on Indeed's own Greenhouse board is a job at
 * Indeed. It is refused where it can only be the site talking about itself.
 */
const BOARDS: { name: RegExp; host: RegExp }[] = [
  { name: /^linked\s?in(?:\.com)?$/i, host: /(?:^|\.)linkedin\.com$/i },
  { name: /^indeed(?:\.com)?$/i, host: /(?:^|\.)indeed\.(?:com|co\.[a-z]{2}|[a-z]{2})$/i },
  { name: /^glassdoor(?:\.com)?$/i, host: /(?:^|\.)glassdoor\.(?:com|co\.[a-z]{2}|[a-z]{2})$/i },
  { name: /^zip\s?recruiter(?:\.com)?$/i, host: /(?:^|\.)ziprecruiter\.com$/i },
  { name: /^handshake$/i, host: /(?:^|\.)joinhandshake\.com$/i },
  { name: /^talent\s?ally$/i, host: /(?:^|\.)talentally\.com$/i },
  { name: /^built\s?in(?:\s+[a-z]{2,12})?$/i, host: /(?:^|\.)builtin[a-z]{0,12}\.com$/i },
  { name: /^(?:wellfound|angel\s?list(?:\s+talent)?)$/i, host: /(?:^|\.)(?:wellfound\.com|angel\.co)$/i },
  { name: /^simply\s?hired(?:\.com)?$/i, host: /(?:^|\.)simplyhired\.(?:com|[a-z]{2})$/i },
  { name: /^monster(?:\.com)?$/i, host: /(?:^|\.)monster\.(?:com|co\.[a-z]{2}|[a-z]{2})$/i },
  { name: /^dice(?:\.com)?$/i, host: /(?:^|\.)dice\.com$/i },
  { name: /^otta$/i, host: /(?:^|\.)otta\.com$/i },
  { name: /^career\s?builder$/i, host: /(?:^|\.)careerbuilder\.com$/i },
];

/** A job board or aggregator's name: "LinkedIn", "Indeed.com", "Built In NYC". */
export function isJobBoardName(name: string | undefined): boolean {
  const n = String(name ?? '').trim();
  return Boolean(n) && BOARDS.some((b) => b.name.test(n));
}

/** A host that belongs to a job board or aggregator rather than to anyone hiring. */
export function isJobBoardHost(host: string | undefined): boolean {
  const h = String(host ?? '').trim().toLowerCase();
  return Boolean(h) && BOARDS.some((b) => b.host.test(h));
}

/** The host of an address, without a leading `www.`; empty for anything that is not one. */
export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/*
 * A season, a year, or both, and nothing else: "Summer 2027", "2027 Summer",
 * "Fall 2026-Summer 2027". Somebody's intake, never somebody's employer — and
 * the title cutter took them for one, because they sat after a " - " where the
 * company usually goes: "CPE SW E2E Triage Intern - Summer 2027" was filed
 * under "Summer 2027".
 */
const SEASON = String.raw`(?:summer|fall|autumn|winter|spring)`;
const YEAR = String.raw`(?:19|20)\d\d`;
const SEASON_OR_YEAR = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:${SEASON}|${YEAR})(?![\p{L}\p{N}])`, 'iu');
const ONLY_WHEN = new RegExp(
  String.raw`^(?:(?:${SEASON}|${YEAR}|early|late|mid|intake|cohort|season|term|semester|and|of)|[-–—,/&+()]|\s)+$`,
  'i',
);

export function isSeasonPhrase(s: string | undefined): boolean {
  const t = String(s ?? '').trim();
  return Boolean(t) && SEASON_OR_YEAR.test(t) && ONLY_WHEN.test(t);
}

/*
 * A country, a region, or a way of working: where a job is, never who it is
 * with. "Software Engineer I, Entry-Level (…) - US" was filed under "US", and
 * Atlassian's iCIMS portal `careers-americas` under "Careers Americas".
 */
const REGION_WORD = String.raw`(?:us|usa|u\.\s?s\.(?:\s?a\.)?|united\s+states(?:\s+of\s+america)?|america|americas|north\s+america|south\s+america|latin\s+america|latam|noram|amer|nam|emea|apac|apj|apjc|japac|anz|asia(?:[\s-]pacific)?|pacific|europe|eu|uk|u\.k\.|united\s+kingdom|great\s+britain|england|canada|mexico|brazil|india|china|japan|korea|south\s+korea|singapore|taiwan|malaysia|germany|france|ireland|israel|australia|global|worldwide|international|remote|hybrid|on-?site|in-?office)`;
const ONLY_WHERE = new RegExp(String.raw`^${REGION_WORD}(?:\s*(?:[,/&|+-]|and)\s*${REGION_WORD})*$`, 'i');

export function isRegion(s: string | undefined): boolean {
  let t = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return false;
  // "Careers Americas", "US Careers": the careers words say nothing either way.
  const rest = withoutCareersWords(t);
  if (rest) t = rest;
  return ONLY_WHERE.test(t.replace(/[()]/g, '').trim());
}

/*
 * Words that name a field of work, a team, or who a programme is for — never
 * an employer on their own. "Robotics" became the company of an Amazon posting
 * titled "Robotics - Software Development Engineer - Job ID: 10452115 |
 * Amazon.jobs", because it was the segment of the title left over.
 *
 * Only ever the whole name: "Acme Robotics" and "Epic Games" are employers.
 */
const FIELD_WORDS = new Set([
  'robotics', 'engineering', 'research', 'operations', 'marketing', 'sales', 'finance', 'legal', 'design',
  'product', 'products', 'data', 'security', 'hardware', 'software', 'it', 'hr', 'human', 'resources',
  'manufacturing', 'supply', 'chain', 'ai', 'artificial', 'intelligence', 'machine', 'learning', 'ml',
  'infrastructure', 'platform', 'platforms', 'graphics', 'gaming', 'games', 'technology', 'technologies', 'tech',
  'science', 'sciences', 'analytics', 'cloud', 'devops', 'embedded', 'firmware', 'networking', 'mobile', 'web',
  'payments', 'growth', 'ads', 'business', 'corporate', 'retail', 'support', 'customer', 'service', 'services',
  'success', 'systems',
]);
const AUDIENCE_WORDS = new Set([
  'intern', 'interns', 'internship', 'internships', 'graduate', 'graduates', 'grad', 'grads', 'new', 'student',
  'students', 'university', 'universities', 'college', 'campus', 'early', 'career', 'careers', 'program',
  'programs', 'programme', 'programmes', 'apprentice', 'apprenticeships', 'apprenticeship', 'entry', 'level',
]);
const JOINING_WORDS = new Set(['and', '&', 'the', 'of', 'for', '+']);

const wordsOf = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[\s,/&+()-]+|\band\b/)
    .map((w) => w.trim())
    .filter(Boolean);

/** Nothing but field-of-work and audience words: "Robotics", "Software Engineering", "Intern and Graduate". */
export function isFieldOfWork(s: string | undefined): boolean {
  const words = wordsOf(String(s ?? '')).filter((w) => !JOINING_WORDS.has(w));
  return words.length > 0 && words.every((w) => FIELD_WORDS.has(w) || AUDIENCE_WORDS.has(w));
}

/**
 * Who a programme is for, and nothing about the work: "Intern and Graduate",
 * "Internships", "Early Careers". Adobe's page for them was filed as a role.
 *
 * One singular word is left alone — a posting titled "Intern" is rare but real,
 * and it names a job — so it takes two words, or a plural, to be only a
 * programme.
 */
export function isAudienceOnly(s: string | undefined): boolean {
  const words = wordsOf(String(s ?? '')).filter((w) => !JOINING_WORDS.has(w));
  if (words.length === 0 || !words.every((w) => AUDIENCE_WORDS.has(w))) return false;
  return words.length > 1 || /s$/.test(words[0]!);
}

/*
 * The words a careers site uses about itself.
 *
 * "Intel Careers" is the name of Intel's Workday site, "Careers at Vireo" and
 * "Orion Careers" end page titles, and iCIMS names its tenants
 * `careers-markon`. Round a name, they say whose site it is; alone, they say
 * nothing at all.
 */
const CAREERS_WORD = String.raw`(?:careers?|jobs?|job\s+(?:board|search|site|portal|opportunities|openings)|career\s+(?:site|portal|center|centre|opportunities|page|hub)|talent\s+(?:community|network|portal)|recruiting|recruitment|opportunities|openings|vacancies)`;
const CAREERS_ONLY = new RegExp(
  String.raw`^(?:${CAREERS_WORD}|join\s+(?:us|our\s+team|the\s+team)|work\s+(?:with|for)\s+us|we(?:'re|’re|\s+are)\s+hiring|now\s+hiring)$`,
  'i',
);
/*
 * In front of a name only the plural, or a preposition: "Careers Markon",
 * "Jobs at Acme". A singular "Job" in front is the page describing itself —
 * "Job Details", "Job Description" — and "Details" is nobody's name.
 */
const LEADING_CAREERS = new RegExp(
  String.raw`^(?:(?:careers?|jobs|opportunities|openings|vacancies|recruiting|recruitment)(?:\s+(?:at|with|for|@))?\s+|(?:${CAREERS_WORD})\s+(?:at|with|for|@)\s+|(?:life|work(?:ing)?)\s+(?:at|with)\s+|join\s+(?:the\s+)?)`,
  'i',
);
const TRAILING_CAREERS = new RegExp(String.raw`[\s,:·|–—-]+(?:${CAREERS_WORD})(?:\s+(?:site|page|home|portal))?$`, 'i');
/** "Early Careers", "University Careers": who a programme is for, which is part of a title, not a site's name. */
const AUDIENCE_BEFORE = /\b(?:early|university|campus|graduate|student|emerging|future)$/i;

/**
 * A name without the careers words round it — "Intel Careers" is Intel,
 * "Careers at Vireo" is Vireo, "Careers Markon" is Markon — or `''` when the
 * careers words are all there is, and `undefined` when there were none.
 */
export function withoutCareersWords(name: string | undefined): string | undefined {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n) return undefined;
  if (CAREERS_ONLY.test(n)) return '';
  let out = n.replace(LEADING_CAREERS, '').trim();
  const trimmed = out.replace(TRAILING_CAREERS, '').trim();
  if (trimmed !== out && !AUDIENCE_BEFORE.test(trimmed)) out = trimmed;
  return out === n ? undefined : out;
}

/**
 * Words that name a job rather than a place that has jobs.
 *
 * Every source of an employer name can hand back a department or the role over
 * again: JSON-LD's `hiringOrganization` is filled in by whoever wrote the
 * posting, `og:site_name` is whatever the CMS was configured with, and the
 * heading fallbacks read the page. A posting whose company came back as
 * "Software Engineering" produced a letter ending "I want to bring that focus
 * to Software Engineering" — which tells the reader, in one line, that nobody
 * looked at it before it was sent.
 */
export const ROLE_NOUN =
  /\b(engineer|engineering|developer|development|programmer|manager|management|designer|analyst|scientist|intern|internship|director|architect|consultant|specialist|associate|coordinator|administrator|technician|researcher|recruiter|apprentice|trainee|senior|junior|principal|staff|lead|full[- ]?stack|front[- ]?end|back[- ]?end)\b/i;

/*
 * A requisition number standing as a part of a title: "Job ID: 10452115",
 * "Req #4021", "JR0286834", "R171666". Amazon ends every title with one.
 */
const JOB_ID_SEGMENT =
  /^(?:(?:job|req(?:uisition)?|posting|position|reference|ref)\s*(?:id|#|no\.?|number|code)?\s*[:#]?\s*[a-z]{0,3}[-_]?\d[\w-]{2,}|[a-z]{1,3}[-_]?\d{4,}|#?\d{5,})$/i;

export function isJobIdSegment(s: string | undefined): boolean {
  return JOB_ID_SEGMENT.test(String(s ?? '').trim());
}

/*
 * Where a job is, written the ways titles write it: "Multiple Locations",
 * "Santa Rosa, California", "Colorado Springs, CO", "Cambridge, England,
 * United Kingdom", "Austin, Texas Metropolitan Area", "Remote".
 *
 * Only ever used to take " in {place}" off the end of a role whose company or
 * site suffix has just been taken off — Keysight writes "{title} in {location}
 * | Keysight Technologies, Inc." and LinkedIn "X hiring {title} in {location}"
 * — so "Research Scientist in Machine Learning" keeps its field: that is not a
 * place, and nothing here reads it as one.
 */
const STATE_CODES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|AB|BC|MB|NB|NL|NS|ON|PE|QC|SK|YT|NT|NU';
const STATE_NAMES =
  'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|Ontario|Quebec|British Columbia|Alberta|England|Scotland|Wales';
const COUNTRIES =
  'United States of America|United States|USA|US|U\\.S\\.|United Kingdom|UK|Canada|Mexico|Brazil|Germany|France|Spain|Italy|Ireland|Netherlands|Switzerland|Sweden|Poland|Israel|India|China|Japan|Korea|South Korea|Singapore|Taiwan|Malaysia|Philippines|Vietnam|Australia|New Zealand';
const PLACE_WORD = String.raw`[A-Z][\p{L}.'-]*`;
const PLACE = new RegExp(
  String.raw`^${PLACE_WORD}(?:[ -]${PLACE_WORD})*(?:,\s*${PLACE_WORD}(?:[ -]${PLACE_WORD})*)*,\s*(?:${STATE_CODES}|${STATE_NAMES}|${COUNTRIES})$`,
  'u',
);

export function looksLikeLocation(s: string | undefined): boolean {
  const t = String(s ?? '').trim();
  if (!t) return false;
  if (/^(?:multiple|various|several|many|all)\s+(?:locations|cities|sites|offices)$/i.test(t)) return true;
  /*
   * "Remote", "Remote, US", "Hybrid - Boston, MA", "Remote (US)" — the word
   * alone, or with where after it. Not the word starting a field: "Research
   * Scientist in Remote Sensing" and "… in Hybrid Quantum Systems" were cut
   * to "Research Scientist" and "Postdoctoral Researcher" for it.
   */
  if (/^(?:remote|hybrid|on-?site|anywhere)(?:$|\s*[-–—,(/|:])/i.test(t)) return true;
  if (new RegExp(String.raw`^(?:remote|hybrid|on-?site)\s+(?:in\s+)?(?:${COUNTRIES})$`, 'i').test(t)) return true;
  if (/^[A-Z][\p{L}\s,.'-]*\b(?:metropolitan\s+area|metro\s+area|bay\s+area|area)$/u.test(t)) return true;
  if (new RegExp(`^(?:${COUNTRIES}|${STATE_NAMES})$`, 'i').test(t)) return true;
  return PLACE.test(t);
}

/** "Engineering Software Developer, Intern in Multiple Locations" without " in Multiple Locations". */
export function withoutTrailingLocation(role: string): string {
  const at = [...role.matchAll(/\s+in\s+/gi)];
  for (let i = at.length - 1; i >= 0; i--) {
    const cut = at[i]!.index!;
    const place = role.slice(cut + at[i]![0].length);
    const before = role.slice(0, cut).trim();
    if (before && looksLikeLocation(place)) return before;
  }
  return role;
}

/* ------------------------------------------------------------------ *
 * A title, in parts                                                   *
 * ------------------------------------------------------------------ */

/** One part of a page title, and the separator written before it. */
export interface TitleSegment {
  text: string;
  /** The separator as written, so what is kept can be joined back exactly. */
  sep: string;
  /**
   * Whether that separator is one a site or a company is put after far more
   * often than a part of the job: `|`, `·`, `»`, an em dash, a spaced en dash.
   * A spaced hyphen is not — "Summer 2027 Intern - Software Engineer" and
   * "Software Engineering - Intern, Bachelor's" are single titles.
   */
  strong: boolean;
}

const SEPARATOR = /(\s*[|·»]\s*|\s*—\s*|\s+–\s+|\s+-\s+)/;

export function splitTitle(title: string): TitleSegment[] {
  const bits = title.split(SEPARATOR);
  const out: TitleSegment[] = [];
  let sep = '';
  for (let i = 0; i < bits.length; i++) {
    if (i % 2 === 1) {
      // Two separators in a row keep the stronger of the two.
      sep = sep && out.length && !bits[i - 1]?.trim() ? (/-/.test(sep) ? bits[i]! : sep) : bits[i]!;
      continue;
    }
    const text = bits[i]!.trim();
    if (!text) continue;
    out.push({ text, sep: out.length ? sep : '', strong: out.length > 0 && !/^\s+-\s+$/.test(sep) });
    sep = '';
  }
  return out;
}

export function joinTitle(segments: TitleSegment[]): string {
  return segments.map((s, i) => (i ? s.sep : '') + s.text).join('').trim();
}

/** A leading notification count — LinkedIn's "(3) " — or a heading marker left from text: "#Software Engineer". */
export function withoutTitleNoise(title: string): string {
  return title
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/^#+\s*(?=\p{L})/u, '')
    .trim();
}

/** A name with no role in it and nothing that says it is not a name, for the checks here that cannot ask the extractor. */
function nameish(s: string): boolean {
  const t = s.trim();
  return (
    /\p{L}/u.test(t) &&
    t.split(/\s+/).length <= 6 &&
    !ROLE_NOUN.test(t) &&
    !isFieldOfWork(t) &&
    !isSeasonPhrase(t) &&
    !isRegion(t)
  );
}

/**
 * A part of a title that is the site talking about itself: a board's name, an
 * address ("Amazon.jobs"), or a careers phrase round a name ("Orion Careers",
 * "Careers at Vireo"). The name inside the careers phrase is handed back.
 *
 * A careers word round something that is part of the job is not the site's:
 * "Early Careers" and "Software Intern Jobs" stay where they are.
 */
export function siteSegment(s: string): { board?: boolean; careersOf?: string } | undefined {
  const t = s.trim();
  if (!t) return undefined;
  if (isJobBoardName(t)) return { board: true };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)) return { board: isJobBoardHost(t) };
  const rest = withoutCareersWords(t);
  if (rest === undefined) return undefined;
  if (rest === '') return {};
  if (ROLE_NOUN.test(rest) || isAudienceOnly(rest) || AUDIENCE_WORDS.has(rest.toLowerCase())) return undefined;
  return nameish(rest) ? { careersOf: rest } : {};
}

/* ------------------------------------------------------------------ *
 * One employer, however it is written                                 *
 * ------------------------------------------------------------------ */

/*
 * A trailing legal form, which names how a company is incorporated rather
 * than which company it is — "Personnel, LLC" included, the entity some
 * employers book their hiring to. The same list the extension compares
 * employers by, so the two sides agree on what one employer is.
 */
const LEGAL_FORM =
  /[\s,]+(?:personnel[\s,]+)?(?:inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|plc|gmbh|ag|sa|nv|bv|pty|oy|ab|lp|llp)\.?$/i;

/** "Acme, Inc." is Acme; a name that is nothing but a legal form is left as it was. */
export function withoutLegalForm(company: string | undefined): string {
  let n = String(company ?? '').trim().replace(/\s+/g, ' ');
  for (;;) {
    const next = n.replace(LEGAL_FORM, '').trim();
    if (next === n || !next) return n;
    n = next;
  }
}

/*
 * Labels of a host that belong to the site rather than the employer:
 * `careers.`, `jobs.`, and the Workday and iCIMS machinery around a tenant.
 */
const SITE_LABEL = /^(careers?|jobs?|apply|recruiting|hire|hiring|work|talent|join|people|en|us|www\d*)$/i;
/** A label that runs the careers words into the employer's name: `careersatdoordash`, `lifeatspotify`. */
const RUN_IN = /^(?:careers?|jobs?|life|work|join)-?at-?(?=[a-z0-9]{3,}$)|^(?:careers?|jobs?)-(?=[a-z0-9]{3,}$)/i;
const SYSTEM_HOST =
  /\b(greenhouse|lever|ashbyhq|workable|smartrecruiters|icims|taleo|jobvite|bamboohr|rippling|breezy|recruitee|teamtailor|applytojob|successfactors|brassring|myworkdayjobs|myworkdaysite|workday|oraclecloud|csod|cornerstone|dayforcehcm|ultipro|paylocity|paycom|eightfold|phenompeople|avature|zohorecruit|personio|pinpointhq|comeet|bullhorn)\b/i;

/**
 * The employer's word in a host, as the host writes it: `careers.acme-corp.com`
 * is `acme-corp`, `careersatdoordash.com` is `doordash`, a Workday tenant is
 * its tenant. Undefined for a system's own host, a board, an address, or
 * anything with no word left in it.
 */
export function employerLabel(host: string | undefined): string | undefined {
  const h = String(host ?? '').trim().toLowerCase().replace(/^www\./, '');
  if (!h || /^[\d.]+$/.test(h) || /^\[/.test(h) || !h.includes('.')) return undefined;
  const tenant = /^([\w-]+)\.wd\d+\.myworkday(?:jobs|site)\.com$/.exec(h)?.[1];
  if (tenant) return tenant;
  if (SYSTEM_HOST.test(h) || isJobBoardHost(h)) return undefined;
  const labels = h.split('.');
  // The public suffix: one label, or two for the `co.uk` family.
  const suffix = labels.length > 2 && /^(co|com|org|net|ac|gov)$/i.test(labels.at(-2) ?? '') ? 2 : 1;
  const named = labels.slice(0, -suffix).filter((label) => !SITE_LABEL.test(label));
  const label = (named.at(-1) ?? '').replace(RUN_IN, '');
  return label || undefined;
}

/** A host read as the employer it belongs to, spelled as that employer spells itself where that is known. */
export function employerOfHost(host: string | undefined): string | undefined {
  const label = employerLabel(host);
  return label ? (knownEmployer(label) ?? titleCased(label)) : undefined;
}

/*
 * Two names for one employer that no rule about spelling can see: the
 * business line a posting is booked to, beside the name the site goes by.
 * Amazon's board filed one Annapurna Labs posting as "Amazon.jobs" and as
 * "Amazon Web Services (AWS)". Only applied where the role matches as well —
 * this is a key for one application, not a claim about corporate structure.
 */
const ALSO_KNOWN_AS: Record<string, string> = {
  amazonwebservices: 'amazon',
  aws: 'amazon',
};

/**
 * One employer, however it is written: case, spacing and punctuation
 * ("Red Hat", "Redhat"), a legal form ("NVIDIA Corporation", "Keysight
 * Technologies, Inc.", "… Personnel, LLC"), an acronym in brackets
 * ("Amazon Web Services (AWS)"), careers words ("Intel Careers"), and a host
 * that was filed where a name should be ("redhat.wd5.myworkdayjobs.com",
 * "careers.activision.com").
 */
export function employerKey(company: string | undefined): string {
  let n = String(company ?? '').trim().replace(/\s+/g, ' ');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(n)) n = employerOfHost(n) ?? n;
  n = withoutLegalForm(n);
  n = n.replace(/\s*\([\p{Lu}\p{N}&.\s]{2,12}\)$/u, '').trim();
  n = withoutLegalForm(n);
  const tidy = withoutCareersWords(n);
  if (tidy) n = tidy;
  const glued = glueName(n);
  const spelled = glueName(knownEmployer(glued)) || glued;
  return ALSO_KNOWN_AS[spelled] ?? spelled;
}

/** Two ways of writing one employer. */
export function sameEmployer(a: string | undefined, b: string | undefined): boolean {
  const ka = employerKey(a);
  return Boolean(ka) && ka === employerKey(b);
}

/**
 * Does this part of a title name one of these employers — the same one, or,
 * unless `exact`, the same one with words of a name added: "Novena Health"
 * beside a site that reads as Novena, "Keysight Technologies" beside Keysight?
 *
 * Never a part with a role in it — "Apple Retail Specialist" is a job at
 * Apple, not Apple — and never one whose added words are a year, a season or
 * who a programme is for: "Activision 2027 Summer Internships" is the start of
 * Activision's title for a posting, and it keeps it.
 */
export function namesEmployer(segment: string, employers: (string | undefined)[], { exact = false } = {}): boolean {
  if (!nameish(segment)) return false;
  const words = (s: string) =>
    withoutLegalForm(s)
      .toLowerCase()
      .split(/[^\p{L}\p{N}+#]+/u)
      .filter(Boolean);
  const mine = words(segment);
  if (mine.length === 0) return false;
  for (const employer of employers) {
    if (!employer?.trim()) continue;
    if (sameEmployer(segment, employer)) return true;
    if (exact) continue;
    const theirs = words(employer);
    if (theirs.length === 0) continue;
    const [short, long] = mine.length <= theirs.length ? [mine, theirs] : [theirs, mine];
    const added = long.slice(short.length);
    if (
      short.join('').length >= 3 &&
      short.every((w, i) => long[i] === w) &&
      added.every((w) => !/\d/.test(w) && !isSeasonPhrase(w) && !AUDIENCE_WORDS.has(w))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A role with a page title's leftovers taken off, and nothing else.
 *
 * "Gameplay Engineer Intern - Careers", "Engineering Software Developer,
 * Intern in Multiple Locations | Keysight Technologies, Inc.", "#Software
 * Engineer" and "Robotics - Software Development Engineer - Job ID: 10452115 |
 * Amazon.jobs" were all roles in a tracker. What comes off is only what is
 * known not to be the job: a leading heading marker or notification count, and
 * at either end a board or site name, a careers phrase, a requisition number,
 * or the employer's own name — and, once a site or employer suffix is gone, a
 * trailing " in {place}".
 *
 * Nothing is cut at a " - " for being there. "Summer 2027 Intern - Software
 * Engineer", "Software Engineer Intern (AI Infra Compute) - 2027 Summer" and
 * "Activision 2027 Summer Internships - Graphics Engineering" are the titles
 * their employers wrote, and are kept whole.
 */
export function cleanRole(role: string | undefined, ...employers: (string | undefined)[]): string | undefined {
  if (role === undefined) return undefined;
  const segments = splitTitle(withoutTitleNoise(role));
  if (segments.length === 0) return role.trim() || undefined;
  let peeled = false;
  while (segments.length > 1) {
    const last = segments[segments.length - 1]!;
    const s = last.text;
    /*
     * The employer with words added — "Keysight Technologies" beside Keysight
     * — only after a separator a company goes after. After a spaced hyphen it
     * is as often the team the job is on: "iOS Engineer - Apple Music" and
     * "iOS Engineer - Apple Pay" were both cut to "iOS Engineer", so two jobs
     * at Apple were one tracker row and one workspace, and the posting's own
     * title lost its team. There, only the employer exactly.
     */
    if (isJobIdSegment(s) || siteSegment(s) || namesEmployer(s, employers, { exact: !last.strong })) {
      segments.pop();
      peeled = true;
      continue;
    }
    break;
  }
  // At the front only the employer exactly, or its site: a title opens with
  // its own words far more often than a trailing site name is copied there.
  while (segments.length > 1) {
    const s = segments[0]!.text;
    if (siteSegment(s) || namesEmployer(s, employers, { exact: true })) {
      segments.shift();
      continue;
    }
    break;
  }
  const out = joinTitle(segments);
  return (peeled ? withoutTrailingLocation(out) : out) || role.trim() || undefined;
}

/* ------------------------------------------------------------------ *
 * Which job an address names                                          *
 * ------------------------------------------------------------------ */

/**
 * Query parameters that say which posting this is — JobHelper's `JOB_PARAM`
 * in `src/shared/trail.js`, less the ones that could name anything (`id`,
 * `oid`, `pid`, `token`), exactly as its `jobNumbers` leaves them out.
 */
const JOB_PARAM =
  /^(jk|vjk|jl|jid|job|jobid|job_id|jobreqid|career_job_req_id|opportunityid|gh_jid|jvi|requisitionid|reqid|req|postingid|posting_id|jobpostingid|applytojob|vacancyid|currentjobid)$/i;

/** A job's number: five digits or more, and nothing but an id. The extension's `PATH_JOB_ID`. */
const JOB_NUMBER = /^(?=(?:\D*\d){5})[a-z0-9_-]+$/i;

/** The job number one address names: in a job parameter first, then as a whole segment of its path. */
export function jobNumberIn(url?: string): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  for (const [key, value] of parsed.searchParams) {
    if (JOB_PARAM.test(key) && JOB_NUMBER.test(value)) return value;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  // Nearest the end, as `roleFromUrl` reads: the job is further out than the system.
  return segments.reverse().find((seg) => JOB_NUMBER.test(seg));
}
