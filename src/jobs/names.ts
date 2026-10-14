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
  // MACOM's Cornerstone tenant, `macomtech.csod.com`; the company writes itself "MACOM".
  macomtech: 'MACOM',
  // Its name on its own pages is refused as a board's (see `BOARDS`), so its own careers host has to spell it.
  github: 'GitHub',
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
  /*
   * Not a board, but where the lists students apply from are kept: a
   * repository's README of a hundred internships, "GitHub - someone/Summer-
   * 2027-Internships: …", was filed as an application at GitHub. GitHub's own
   * jobs are on its careers site, not on a repository page.
   *
   * By host only. Unlike LinkedIn's, GitHub's name on someone else's page is
   * the employer — "Software Engineer | GitHub | LinkedIn" is a job there.
   */
  { name: /(?!)/, host: /(?:^|\.)github\.com$/i },
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
/*
 * The same page in the languages a careers site is served in. Qumulo's is
 * "Vagas abertas" at /pt/, and it was filed as the employer: "open
 * positions" is no more a name in Portuguese than in English.
 */
const ELSEWHERE_CAREERS = String.raw`vagas(?:\s+(?:abertas|dispon[ií]veis))?|carreiras?|trabalhe\s+conosco|empregos?|empleos?|ofertas\s+de\s+(?:empleo|trabajo)|trabaja\s+con\s+nosotros|vacantes|carreras?|emplois?|offres\s+d['’]emploi|carri[eè]res?|nous\s+rejoindre|stellenangebote|offene\s+stellen|karriere|jobangebote|posizioni\s+aperte|lavora\s+con\s+noi|carriere|vacatures|werken\s+bij|lediga\s+tjänster|karriär|ledige\s+stillinger|oferty\s+pracy|kariera`;
const CAREERS_WORD = String.raw`(?:careers?|jobs?|job\s+(?:board|search|site|portal|opportunities|openings)|career\s+(?:site|portal|center|centre|opportunities|page|hub)|talent\s+(?:community|network|portal)|recruiting|recruitment|opportunities|openings|vacancies|${ELSEWHERE_CAREERS})`;
const CAREERS_ONLY = new RegExp(
  String.raw`^(?:${CAREERS_WORD}|join\s+(?:us|our\s+team|the\s+team)|work\s+(?:with|for)\s+us|we(?:'re|’re|\s+are)\s+hiring|now\s+hiring)$`,
  'i',
);
/*
 * In front of a name only the plural, or a preposition: "Careers Markon",
 * "Jobs at Acme". A singular "Job" in front is the page describing itself —
 * "Job Details", "Job Description" — and "Details" is nobody's name.
 */
/*
 * And the invitation a careers site writes round its name: Tesla's site calls
 * itself "Build your Career at Tesla", and that was filed as the employer.
 */
const LEADING_CAREERS = new RegExp(
  String.raw`^(?:(?:careers?|jobs|opportunities|openings|vacancies|recruiting|recruitment)(?:\s+(?:at|with|for|@))?\s+|(?:${CAREERS_WORD})\s+(?:at|with|for|@)\s+|(?:life|work(?:ing)?)\s+(?:at|with)\s+|(?:build|start|grow|launch|shape|find|begin|accelerate)\s+(?:your|a|the)\s+(?:next\s+)?careers?\s+(?:at|with)\s+|join\s+(?:the\s+)?)`,
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
 * A firm named for the work it does: "Thermagia Engineering", "Wellington
 * Management", "Acme Development".
 *
 * `ROLE_NOUN` has those three words in it because "Software Engineering" and
 * "Product Management" are what a job is, and a name with one in it was
 * refused as an employer everywhere — so LinkedIn's own "Software Engineering
 * Intern | Thermagia Engineering | LinkedIn" left the employer unknown and
 * filed the role as "Software Engineering Intern | Thermagia Engineering",
 * and "Technology Undergraduate Summer Internship | Wellington Management"
 * was filed the same way, three times over.
 *
 * What a name has that a field of work does not is a word that is nobody's
 * field: a proper name, written as one, in front of the work. So the work word
 * has to come last, every word in front of it has to be capitalised, none of
 * them may be another role word, and at least one of them has to be something
 * other than a field, an audience, a season, a place or one of the words that
 * qualify the work itself ("Project Management", "Risk Management", "Business
 * Development" are kinds of work, not firms).
 */
const FIRM_WORK = /^(.+?)\s+(?:engineering|management|development)$/i;
const WORK_QUALIFIERS = new Set([
  'project', 'projects', 'program', 'programme', 'portfolio', 'risk', 'asset', 'assets', 'wealth', 'investment',
  'change', 'quality', 'account', 'accounts', 'case', 'property', 'facilities', 'facility', 'construction',
  'talent', 'leadership', 'organizational', 'organisational', 'executive', 'general', 'technical', 'commercial',
  'strategic', 'strategy', 'professional', 'personal', 'release', 'test', 'testing', 'site', 'reliability',
  'process', 'production', 'game', 'application', 'applications', 'solutions', 'solution', 'database', 'network',
  'electrical', 'mechanical', 'civil', 'chemical', 'aerospace', 'biomedical', 'industrial', 'systems', 'computer',
  'front', 'back', 'full', 'stack', 'enterprise', 'revenue', 'brand', 'community', 'content', 'vendor', 'event',
  'events', 'office', 'store', 'restaurant', 'team', 'people', 'tools', 'tooling', 'build', 'performance', 'senior',
  'junior', 'associate', 'principal', 'staff', 'lead', 'entry', 'level', 'new', 'grad', 'research', 'software',
  'hardware', 'firmware', 'embedded', 'data', 'web', 'mobile', 'cloud', 'platform', 'product', 'business',
  // Teams and disciplines a role is named for: "Senior Engineer | Gameplay Engineering".
  'gameplay', 'rendering', 'graphics', 'audio', 'silicon', 'compiler', 'validation', 'verification', 'field',
  'simulation', 'analog', 'rf', 'optical', 'avionics', 'propulsion', 'ui', 'ux', 'physics', 'animation',
  'search', 'infra', 'infrastructure', 'kernel', 'engine', 'plugin', 'quantitative', 'inventory', 'identity',
  'device', 'devices', 'security', 'reliability', 'manufacturing', 'operations', 'automation', 'controls',
  'robotics', 'ml', 'ai', 'machine', 'learning', 'graphics', 'tools', 'core', 'online', 'services',
]);

export function isFirmNamedForItsWork(s: string | undefined): boolean {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  const m = FIRM_WORK.exec(t);
  if (!m) return false;
  const before = m[1]!;
  if (ROLE_NOUN.test(before)) return false;
  const words = before.split(' ');
  if (words.length > 4 || !words.every((w) => /^[\p{Lu}\p{N}&]/u.test(w))) return false;
  return words.some((w) => {
    const l = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    return (
      l.length > 1 &&
      !FIELD_WORDS.has(l) &&
      !AUDIENCE_WORDS.has(l) &&
      !JOINING_WORDS.has(l) &&
      !WORK_QUALIFIERS.has(l) &&
      !isSeasonPhrase(l) &&
      !isRegion(l) &&
      !/^\d+$/.test(l)
    );
  });
}

/** A role word in it, other than the work a firm is named for. See `isFirmNamedForItsWork`. */
export function namesAJob(s: string | undefined): boolean {
  return ROLE_NOUN.test(String(s ?? '')) && !isFirmNamedForItsWork(s);
}

/*
 * A requisition number standing as a part of a title: "Job ID: 10452115",
 * "Req #4021", "JR0286834", "R171666". Amazon ends every title with one.
 */
const JOB_ID_SEGMENT =
  /^(?:(?:job|req(?:uisition)?|posting|position|reference|ref)\s*(?:id|#|no\.?|number|code)?\s*[:#]?\s*[a-z]{0,3}[-_]?\d[\w-]{2,}|[a-z]{1,3}[-_]?\d{4,}|#?\d{5,})$/i;

/*
 * Not "(job 4012345)": that is `unnamedRole`'s own way of telling two unnamed
 * jobs apart, and it has to survive being read back.
 */
const TRAILING_JOB_ID =
  /\s*\(\s*(?:(?:req(?:uisition)?\s*(?:id|#|no\.?)?\s*[:#]?\s*)?#?\d{5,}|[a-z]{1,3}[-_]?\d{5,}|req(?:uisition)?\s*(?:id|#|no\.?)\s*[:#]?\s*[a-z]{0,3}[-_]?\d[\w-]{2,})\s*\)$/i;
/*
 * Workday's "(R22724)" is that bracket too: letters and five digits or more,
 * the way `JOB_ID_SEGMENT` reads "R171666" after a separator. Five, not four,
 * so a bracketed year with letters before it ("(FY2026)") is not one. And
 * any number labelled as a requisition's, "(Req #4021)", "(Req #JR0286834)":
 * the shape `withRequisition` writes one the other two would not read.
 */

export function isJobIdSegment(s: string | undefined): boolean {
  return JOB_ID_SEGMENT.test(String(s ?? '').trim());
}

/** "Job ID: 10452115", "Req #123456", "(12345678)", "JR0286834" — as the one number they name, in the case it was written. */
function jobIdAsWritten(s: string): string {
  return s
    .replace(/^\s*\(|\)\s*$/g, '')
    .trim()
    .replace(/^(?:job|req(?:uisition)?|posting|position|reference|ref)\s*(?:id|#|no\.?|number|code)?\s*[:#]?\s*/i, '')
    .replace(/[^a-z0-9]/gi, '');
}

/** The same, lower case: what two ways of writing one number have in common. */
function jobIdOf(s: string): string {
  return jobIdAsWritten(s).toLowerCase();
}

/**
 * The requisition number `cleanRole` cuts off the end of a title, if it cuts
 * one: "Software Engineer Intern (12345678)" → "12345678", "Software Engineer
 * - JR0286834" → "jr0286834", "… (Req #123456)" → "123456".
 *
 * Cut so a role names the job the way the employer's other page does —
 * SuccessFactors' "Image Processing Engineer Intern (41213)" is L3Harris's
 * "Image Processing Engineer Intern" — but two titles that both carry one,
 * and not the same one, are two requisitions with one title: one employer
 * hiring the same intern role twice. `identity` cannot see that, since it
 * reads the cut title; whoever compares two roles asks this as well.
 */
export function trailingJobId(role: string | undefined, ...employers: (string | undefined)[]): string | undefined {
  return requisitionOf(role, ...employers)?.toLowerCase();
}

/**
 * `trailingJobId` in the case the title wrote it — "JR0286834", not
 * "jr0286834" — for carrying beside a role that has had it cut
 * (`ExtractedJob.requisition`) and putting back on it (`withRequisition`).
 */
export function requisitionOf(role: string | undefined, ...employers: (string | undefined)[]): string | undefined {
  if (!role) return undefined;
  const title = role.replace(/\s+/g, ' ').slice(0, MAX_TITLE);
  const segments = splitTitle(withoutTitleNoise(title));
  // As `cleanRole` peels the end, stopping at the first requisition number.
  while (segments.length > 1) {
    const last = segments[segments.length - 1]!;
    const s = last.text;
    if (isJobIdSegment(s)) return jobIdAsWritten(s) || undefined;
    if (siteSegment(s) || namesEmployer(s, employers, { exact: !last.strong })) {
      segments.pop();
      continue;
    }
    break;
  }
  const bracket = TRAILING_JOB_ID.exec(joinTitle(segments));
  return bracket ? jobIdAsWritten(bracket[0]) || undefined : undefined;
}

/**
 * A role with its requisition number put back on the end, as "(12345678)" —
 * or "(Req #4021)" where the number alone would not read as one — unless it
 * carries one already.
 *
 * Extraction cuts the number off the role (`cleanRole`) and carries it
 * beside it, and whatever files an application from a page puts it back:
 * "Software Engineer Intern (12345678)" and "(87654321)" are two
 * requisitions, two copies and two rows (`differentRequisitions`), and filed
 * as the bare title they were one. A number on one side only still matches
 * the bare title, so the same job read off a page that has none is still one.
 */
export function withRequisition(role: string | undefined, requisition: string | undefined): string | undefined {
  const id = jobIdAsWritten(String(requisition ?? ''));
  if (!role || !id || trailingJobId(role)) return role;
  const bare = `${role} (${id})`;
  if (trailingJobId(bare) === id.toLowerCase()) return bare;
  return `${role} (Req #${id})`;
}

/**
 * Two roles that both carry a requisition number (`trailingJobId`), and not
 * the same one. Never a reason to be the same: one title with a number and
 * one without are still read as one job.
 */
export function differentRequisitions(a: string | undefined, b: string | undefined, ...employers: (string | undefined)[]): boolean {
  const x = trailingJobId(a, ...employers);
  const y = trailingJobId(b, ...employers);
  return Boolean(x && y && x !== y);
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
/*
 * A hyphen belongs to the word — "Winston-Salem", "Stratford-upon-Avon" — and
 * only a space separates two. It was allowed to be both, a hyphen inside the
 * word class and a separator between words, so "A-B-C-…" could be split
 * 2^n ways and every one was tried before the match failed: 29 letters held
 * the server for seconds over one job title.
 */
const PLACE_WORD = String.raw`[A-Z][\p{L}.']*(?:-[\p{L}.']+)*`;
const PLACE = new RegExp(
  String.raw`^${PLACE_WORD}(?: ${PLACE_WORD})*(?:,\s*${PLACE_WORD}(?: ${PLACE_WORD})*)*,\s*(?:${STATE_CODES}|${STATE_NAMES}|${COUNTRIES})$`,
  'u',
);
/** Longer than any place a title names, and short enough that no pattern here can take long over it. */
const MAX_PLACE = 120;

export function looksLikeLocation(s: string | undefined): boolean {
  const t = String(s ?? '').trim();
  if (!t || t.length > MAX_PLACE) return false;
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

/*
 * The step of applying, written in front of the job's name.
 *
 * Greenhouse titles its embedded form "Job Application for {job} at {company}",
 * Cornerstone "Apply for {job}", iCIMS "Candidate Profile - {job}" and
 * SuccessFactors "Career Opportunities: Apply for {job} ({number})". Each was
 * filed as the role — "Apply for Test Software Developer Intern", "Job
 * Application for Software Engineer, AI Platform" — beside the same job filed
 * from its posting under its own name, so one job was two rows.
 *
 * Only in front of something that names a job: "Apply for this job — Novena
 * Health" and "Candidate Profile" alone are the page talking about itself, and
 * `NOT_A_ROLE` reads those whole.
 */
/*
 * And the rest of iCIMS's steps, which title themselves the same way: "Job
 * Specific Questions - {job}", "Voluntary Self Identification - {job}". Read
 * as the role, each step of one Garmin application filed a row of its own —
 * Iridium's became three rows, Epsilon's two — one of them `applied` and the
 * others left at `applying` for the fortnight's close to find.
 */
const APPLYING_PREFIX =
  /^(?:(?:career\s+opportunities|careers?|jobs?)\s*:\s*)?(?:(?:job\s+)?application\s+for|apply(?:ing)?\s+(?:now\s+)?(?:for|to)|(?:candidate\s+profile|job[\s-]+specific\s+questions|(?:application|screening|additional)\s+questions|voluntary\s+self[\s-]+identification(?:\s+forms?)?|self[\s-]+identification|eeo(?:c)?(?:\s+information)?|review\s+(?:and|&)\s+submit|personal\s+information|contact\s+information|my\s+(?:information|experience|documents))\s*[-–—:|])\s+/i;

/**
 * A leading notification count — LinkedIn's "(3) " — a heading marker left from
 * text: "#Software Engineer", or the step of applying in front of the job:
 * "Apply for Test Software Developer Intern". See `APPLYING_PREFIX`.
 */
export function withoutTitleNoise(title: string): string {
  const t = title
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/^#+\s*(?=\p{L})/u, '')
    .trim();
  const rest = t.replace(APPLYING_PREFIX, '');
  return rest !== t && ROLE_NOUN.test(splitTitle(rest)[0]?.text ?? '') ? rest : t;
}

/** A name with no role in it and nothing that says it is not a name, for the checks here that cannot ask the extractor. */
function nameish(s: string): boolean {
  const t = s.trim();
  return (
    /\p{L}/u.test(t) &&
    t.split(/\s+/).length <= 6 &&
    !namesAJob(t) &&
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
/*
 * With its dots, and in the forms companies take outside the Anglo list:
 * "Société Générale S.A.", "Telefónica, S.L.", "Acme S.r.l.", "Acme S.p.A.",
 * "Acme SARL", "Acme Ltda.", "Acme e.V.", "Acme GmbH & Co. KG", "Acme A/S",
 * "Acme ApS", "Acme Oyj". Each was a different employer from the same name
 * without it, so a posting's JSON-LD and the form it hands you to — which
 * writes the name plain — were two rows for one job. "GmbH & Co. KG" is one
 * form, taken off in one piece: "Co." on its own in front of a "KG" is not a
 * company called Co.
 *
 * The same pattern, byte for byte, as JobHelper's `LEGAL_FORM` in
 * src/shared/trail.js, so the two sides agree on what one employer is.
 */
const LEGAL_FORM =
  /[\s,]+(?:personnel[\s,]+)?(?:inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|plc|gmbh(?:\s*&\s*co\.?\s*kg(?:aa)?)?|ag|s\.?a|n\.?v|b\.?v|pty|oy|oyj|ab|lp|llp|s\.?l|s\.?r\.?l|s\.?p\.?a|s\.?a\.?s|sarl|ltda|e\.?v|kg|a\/s|aps)\.?$/i;
/*
 * And the Japanese forms, which go in front as often as behind: 株式会社リクルート
 * and リクルート株式会社 are one company, as are (株)リクルート and ㈱リクルート.
 * Also JobHelper's, byte for byte.
 */
const JP_LEGAL_FORM =
  /^(?:株式会社|有限会社|合同会社|合資会社|\(株\)|（株）|㈱|\(有\)|（有）|㈲)\s*|\s*(?:株式会社|有限会社|合同会社|合資会社|\(株\)|（株）|㈱|\(有\)|（有）|㈲)$/u;

/** "Acme, Inc." is Acme; a name that is nothing but a legal form is left as it was. */
export function withoutLegalForm(company: string | undefined): string {
  let n = String(company ?? '').trim().replace(/\s+/g, ' ');
  for (;;) {
    const next = n.replace(LEGAL_FORM, '').replace(JP_LEGAL_FORM, '').trim();
    if (next === n || !next) return n;
    n = next;
  }
}

/*
 * The gender tag a German or French posting puts after its title — "(m/w/d)",
 * "(w/m/d)", "(m/f/d)", "(d/m/w)", "(H/F)", "F/H", "(all genders)", "(gn)" —
 * which says who may apply and nothing about the job. The employer's own form
 * writes the title without it, so "Werkstudent Softwareentwicklung (m/w/d)"
 * and "Werkstudent Softwareentwicklung" were two rows for one job. Anywhere
 * in the title: "Softwareentwickler (m/w/d) - Remote" carries it before the
 * work mode. Written bare only in the few shapes a posting uses, so "A/B" and
 * "C/C++" are left alone; and only two to four single letters.
 */
const GENDER_TAG =
  /\s*(?:\(\s*(?:[mwfdhx](?:\s*\/\s*[mwfdhx]){1,3}|all\s+genders|gn)\s*\)|(?<![\p{L}\p{N}])(?:[mwf]\/[mwf](?:\/[dx])?|[hf]\/[hf]|d\/m\/w)(?![\p{L}\p{N}]))/giu;

/** The title without its gender tag, and with the spacing that leaves tidied. */
export function withoutGenderTag(role: string): string {
  return role
    .replace(GENDER_TAG, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:)\]])/g, '$1')
    .trim();
}

/*
 * Labels of a host that belong to the site rather than the employer:
 * `careers.`, `jobs.`, and the Workday and iCIMS machinery around a tenant.
 */
const SITE_LABEL = /^(careers?|jobs?|apply|recruiting|hire|hiring|work|talent|join|people|en|us|www\d*)$/i;
/** A label that runs the careers words into the employer's name: `careersatdoordash`, `lifeatspotify`. */
const RUN_IN = /^(?:careers?|jobs?|life|work|join)-?at-?(?=[a-z0-9]{3,}$)|^(?:careers?|jobs?)-(?=[a-z0-9]{3,}$)/i;
const SYSTEM_HOST =
  /\b(greenhouse|lever|ashbyhq|workable|smartrecruiters|icims|taleo|jobvite|bamboohr|rippling|breezy|recruitee|teamtailor|applytojob|successfactors|brassring|myworkdayjobs|myworkdaysite|workday|oraclecloud|csod|cornerstone|dayforcehcm|ultipro|paylocity|paycom|eightfold|phenompeople|avature|zohorecruit|personio|pinpointhq|comeet|bullhorn|myjobs\.adp|workforcenow\.adp|recruiting\.adp|ns2cloud)\b/i;

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
/** Far longer than any job's name; past it a "title" is a pasted page. */
const MAX_TITLE = 300;

export function cleanRole(role: string | undefined, ...employers: (string | undefined)[]): string | undefined {
  if (role === undefined) return undefined;
  const peeled = peelTitle(role, employers);
  if (!peeled) return role.trim() || undefined;
  return (peeled.peeled ? withoutTrailingLocation(peeled.out) : peeled.out) || role.trim() || undefined;
}

/**
 * The place `cleanRole` cut off the end of a title, if it cut one: "Software
 * Engineer Intern in Austin, TX | Coinbase" → "austin, tx".
 *
 * Cut so a role names the job the way the employer's other page does — the
 * posting writes "{title} in {place} | {employer}" and the form "{title}" —
 * but two titles that both name a place, and not the same one, are two jobs:
 * Coinbase's Austin intern and its Seattle intern were one tracker row, and
 * the send for the second was read as already made. `identity` reads the cut
 * title and cannot see that; whoever compares two roles asks this as well,
 * as it asks `differentRequisitions`. A place on one side only still matches.
 */
export function trailingPlaceOf(role: string | undefined, ...employers: (string | undefined)[]): string | undefined {
  if (role === undefined) return undefined;
  const peeled = peelTitle(role, employers);
  if (!peeled?.peeled) return undefined;
  const kept = withoutTrailingLocation(peeled.out);
  if (kept === peeled.out) return undefined;
  const place = peeled.out
    .slice(kept.length)
    .replace(/^\s+in\s+/i, '')
    .trim();
  return place ? place.toLowerCase().replace(/\s+/g, ' ') : undefined;
}

/** Two roles that both name a place `cleanRole` cuts (`trailingPlaceOf`), and not the same one. */
export function differentPlaces(a: string | undefined, b: string | undefined, ...employers: (string | undefined)[]): boolean {
  const x = trailingPlaceOf(a, ...employers);
  const y = trailingPlaceOf(b, ...employers);
  return Boolean(x && y && x !== y);
}

/**
 * The title with what `cleanRole` peels taken off its ends, before the place,
 * and whether anything was: the place only comes off after a site or employer
 * suffix has. Undefined for a title with nothing in it.
 */
function peelTitle(role: string, employers: (string | undefined)[]): { out: string; peeled: boolean } | undefined {
  /*
   * One space where there were many, and no more of it than a title could be.
   * `SEPARATOR` opens on `\s*`, so a run of spaces with no separator after it
   * was scanned again from every space in it: forty thousand of them in a
   * pasted title held the server for seconds.
   */
  const title = role.replace(/\s+/g, ' ').slice(0, MAX_TITLE);
  const segments = splitTitle(withoutTitleNoise(title));
  if (segments.length === 0) return undefined;
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
  /*
   * And a requisition number in brackets on the end: SuccessFactors' "Image
   * Processing Engineer Intern (41213)" is the job L3Harris's posting calls
   * "Image Processing Engineer Intern". See `isJobIdSegment`.
   */
  // And the gender tag, wherever in the title it sits: see `withoutGenderTag`.
  const out = withoutGenderTag(joinTitle(segments)).replace(TRAILING_JOB_ID, '').trim();
  return { out, peeled };
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

/*
 * Not counting a year written as a word of its own.
 *
 * `Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships` has eight
 * digits and nothing but letters, digits and hyphens, so a GitHub repository's
 * name was a job's number: the README was filed as "Unknown role (job
 * Automated-List-Of-…)", and — because a page whose address names one job is
 * not a list of them (`listsRoles`) — a list of a hundred internships was read
 * as a posting. The digits that make a number a job's are its own; "2027"
 * between hyphens is when, and `Software-Engineer-Summer-2027_R171666` still
 * has its six.
 */
/*
 * A year beside words only — "Summer-2027-and-Fall". A year beside another
 * number is part of the id: `job=2026-1234`, `JR-2026-0412`, `req_2026_1234`.
 */
const withoutWordYears = (s: string): string => {
  const words = String(s).split(/[-_]/);
  const loose = (i: number) => !/\d/.test(words[i] ?? '');
  return words.filter((w, i) => !(/^(?:19|20)\d\d$/.test(w) && loose(i - 1) && loose(i + 1))).join('-');
};
const isJobNumber = (s: string): boolean => JOB_NUMBER.test(s) && JOB_NUMBER.test(withoutWordYears(s));

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
    if (JOB_PARAM.test(key) && isJobNumber(value)) return value;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  // Nearest the end, as `roleFromUrl` reads: the job is further out than the system.
  return segments.reverse().find((seg) => isJobNumber(seg));
}

/*
 * The parameters an address names a requisition by — the employer's own
 * number for the job, the one a title writes as "(R-059038)" — rather than a
 * board's number for its page of it.
 */
const REQUISITION_PARAM = /^(jobreqid|career_job_req_id|requisitionid|reqid|req)$/i;

/*
 * Workday ends a job's address with its requisition after the title's words:
 * `…/job/Raleigh/Software-Engineer-Intern_R-059038`, `…_JR0286834`.
 */
/*
 * But not with what comes after it. Workday numbers each posting of one
 * requisition — `_R-059038-1`, `_JR0286834-1`, `_R0164451-9` — and that "-1"
 * was read into the number, so `R-059038-1` was "r0590381" and never the
 * "(R-059038)" in LinkedIn's title for the same job: the two were vetoed as
 * two requisitions, and the sent row was nothing to the posting. One or two
 * digits after a hyphen at the very end are the posting's count and are
 * dropped; a longer group (`JR-2026-0412`) is part of the number and kept.
 */
const WORKDAY_HOST = /(?:^|\.)myworkday(?:jobs|site)\.com$/i;
const WORKDAY_REQUISITION = /_([a-z]{0,4}[-_]?\d{4,}(?:-\d{3,})*)(?:-\d{1,2})?$/i;

/**
 * The requisition number an address names, lower case and letters and digits
 * only — the shape `trailingJobId` gives a title's — so "R-059038" in a
 * Workday address and "(R-059038)" in a LinkedIn title are one number.
 *
 * Only where the address names the requisition itself: a board's own number
 * for its page (LinkedIn's `/jobs/view/4461337126`, a Greenhouse job id) is
 * not one, and compared with a title's requisition it would make every job
 * read on two sites two jobs. Those are compared with each other, on one
 * site, by `jobNumberIn`.
 */
export function requisitionInUrl(url?: string): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const tidy = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase() || undefined;
  for (const [key, value] of parsed.searchParams) {
    if (REQUISITION_PARAM.test(key) && /\d/.test(value)) return tidy(value);
  }
  if (!WORKDAY_HOST.test(parsed.hostname)) return undefined;
  for (const seg of parsed.pathname.split('/').filter(Boolean).reverse()) {
    const req = WORKDAY_REQUISITION.exec(seg)?.[1];
    if (req) return tidy(req);
  }
  return undefined;
}

/*
 * The ATSs that number a job once for everybody, and the places that number
 * turns up.
 *
 * Greenhouse's job 6143238004 is that job on the board
 * (`job-boards.greenhouse.io/figma/jobs/6143238004`), in its embedded form
 * (`boards.greenhouse.io/embed/job_app?for=figma&token=6143238004`) and on
 * the employer's own careers page, which carries it as `gh_jid`
 * (`figma.com/careers/job/?gh_jid=6143238004`). Lever's and Ashby's are a
 * UUID in the path (Ashby's embedded board passes it as `ashby_jid`), and
 * SmartRecruiters' is the long number its posting's path starts with
 * (`/Visa/744000087654321-software-engineer-intern`); its one-click form
 * names the posting by another id, a publication UUID, which is compared only
 * with itself.
 */
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GREENHOUSE = /(?:^|\.)greenhouse\.io$/i;
const LEVER = /(?:^|\.)lever\.co$/i;
const ASHBY = /(?:^|\.)ashbyhq\.com$/i;
const SMARTRECRUITERS = /(?:^|\.)smartrecruiters\.com$/i;

/**
 * The job an address names by an id its ATS gives it across every board and
 * every site — "greenhouse:6143238004", "lever:<uuid>" — or undefined.
 *
 * `jobNumberIn` reads a number on one site and leaves it there: the same
 * number on two hosts is two jobs as far as it knows, since iCIMS, Taleo and
 * Workday count each employer's jobs from their own start. These ids are
 * not like that. The same one is the same job wherever it is linked from, so
 * the employer's careers page with `gh_jid` and the Greenhouse board are one
 * posting; and two of them from one ATS are two jobs.
 */
export function globalJobId(url?: string): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  const param = (name: string) => {
    for (const [key, value] of parsed.searchParams) if (key.toLowerCase() === name) return value.trim();
    return undefined;
  };
  const segments = parsed.pathname.split('/').filter(Boolean);
  const ghJid = param('gh_jid');
  if (ghJid && /^\d{5,}$/.test(ghJid)) return `greenhouse:${ghJid}`;
  const ashbyJid = param('ashby_jid');
  if (ashbyJid && UUID_SEGMENT.test(ashbyJid)) return `ashby:${ashbyJid.toLowerCase()}`;
  if (GREENHOUSE.test(host)) {
    const token = param('token');
    if (token && /^\d{5,}$/.test(token)) return `greenhouse:${token}`;
    const at = segments.findIndex((s) => s.toLowerCase() === 'jobs');
    const id = at >= 0 ? segments[at + 1] : undefined;
    return id && /^\d{5,}$/.test(id) ? `greenhouse:${id}` : undefined;
  }
  if (LEVER.test(host) || ASHBY.test(host)) {
    const id = segments.find((s) => UUID_SEGMENT.test(s));
    return id ? `${LEVER.test(host) ? 'lever' : 'ashby'}:${id.toLowerCase()}` : undefined;
  }
  if (SMARTRECRUITERS.test(host)) {
    const at = segments.findIndex((s) => s.toLowerCase() === 'publication');
    const publication = at >= 0 ? segments[at + 1] : undefined;
    if (publication && UUID_SEGMENT.test(publication)) return `smartrecruiters-publication:${publication.toLowerCase()}`;
    for (const s of segments) {
      const id = /^(\d{10,})(?:-|$)/.exec(s)?.[1];
      if (id) return `smartrecruiters:${id}`;
    }
  }
  return undefined;
}

/** The ATS a `globalJobId` is from: two ids from different ones say nothing about each other. */
export function globalJobKind(id: string): string {
  return id.slice(0, id.indexOf(':'));
}
