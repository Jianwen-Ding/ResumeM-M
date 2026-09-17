/**
 * Pulls a job posting out of a page. The extension does a first pass in the
 * DOM where it has structure to work with; this runs server-side on whatever
 * HTML arrives, including pages the extension could not parse.
 */

export interface ExtractedJob {
  title?: string;
  company?: string;
  location?: string;
  description: string;
  /** How the fields were obtained, so low-confidence guesses are visible. */
  source: 'json-ld' | 'meta' | 'heuristic';
  /** Technology and domain keywords, used to score variants without an AI call. */
  keywords: string[];
}

/** Terms worth matching against variant tags. Kept small and concrete. */
const KEYWORD_VOCAB = [
  'python', 'typescript', 'javascript', 'java', 'golang', 'go', 'rust', 'c++', 'c#', 'ruby', 'scala', 'kotlin', 'swift',
  'react', 'vue', 'angular', 'node', 'django', 'flask', 'spring', 'rails', 'express',
  'kafka', 'spark', 'hadoop', 'airflow', 'streaming', 'etl',
  'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'dynamodb', 'sql',
  'aws', 'gcp', 'azure', 'kubernetes', 'docker', 'terraform', 'ci/cd', 'devops', 'infrastructure',
  'machine learning', 'ml', 'ai', 'nlp', 'pytorch', 'tensorflow', 'data science',
  'frontend', 'front-end', 'backend', 'back-end', 'full stack', 'fullstack', 'distributed systems',
  'microservices', 'api', 'rest', 'graphql', 'grpc', 'security', 'embedded', 'systems', 'compiler',
  'testing', 'automation', 'mobile', 'ios', 'android', 'performance', 'scalability',
];

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|li|br|h[1-6]|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Walk JSON-LD, which is the only structured source most boards agree on. */
function fromJsonLd(html: string): Partial<ExtractedJob> | undefined {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse((block[1] ?? '').trim());
    } catch {
      continue;
    }
    const queue: unknown[] = [parsed];
    while (queue.length > 0) {
      const node = queue.shift();
      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }
      if (!node || typeof node !== 'object') continue;
      const obj = node as Record<string, unknown>;
      if (obj['@graph']) queue.push(obj['@graph']);

      if (obj['@type'] === 'JobPosting' || (Array.isArray(obj['@type']) && obj['@type'].includes('JobPosting'))) {
        const org = obj.hiringOrganization as Record<string, unknown> | undefined;
        const loc = obj.jobLocation as Record<string, unknown> | undefined;
        const addr = (Array.isArray(loc) ? loc[0] : loc)?.['address'] as Record<string, unknown> | undefined;
        return {
          title: typeof obj.title === 'string' ? obj.title : undefined,
          company: typeof org?.name === 'string' ? org.name : undefined,
          location: [addr?.addressLocality, addr?.addressRegion].filter(Boolean).join(', ') || undefined,
          description: typeof obj.description === 'string' ? stripTags(obj.description) : '',
          source: 'json-ld',
        };
      }
    }
  }
  return undefined;
}

function metaContent(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`,
      'i',
    );
    const m = re.exec(html);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

/** Known boards put the company somewhere predictable in the URL. */
export function companyFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const patterns: [RegExp, number][] = [
    [/boards\.greenhouse\.io\/([^/?#]+)/i, 1],
    [/job-boards\.greenhouse\.io\/([^/?#]+)/i, 1],
    [/jobs\.lever\.co\/([^/?#]+)/i, 1],
    [/([\w-]+)\.wd\d+\.myworkdayjobs\.com/i, 1],
    [/jobs\.ashbyhq\.com\/([^/?#]+)/i, 1],
    [/apply\.workable\.com\/([^/?#]+)/i, 1],
    [/([\w-]+)\.breezy\.hr/i, 1],
  ];
  for (const [re, group] of patterns) {
    const m = re.exec(url);
    const raw = m?.[group];
    if (raw) {
      return raw
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
    }
  }
  return undefined;
}

export function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const term of KEYWORD_VOCAB) {
    // Word-boundary match so "go" does not fire on "going" or "category".
    const re = new RegExp(`(^|[^a-z0-9+#])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9+#]|$)`, 'i');
    if (re.test(lower)) found.add(term);
  }
  return [...found];
}

export function extractJob(html: string, url?: string, pageTitle?: string): ExtractedJob {
  const ld = fromJsonLd(html);
  const text = stripTags(html);

  const rawTitle =
    ld?.title ??
    metaContent(html, ['og:title', 'twitter:title']) ??
    pageTitle?.split(/[|–—]/)[0]?.trim();

  const company =
    ld?.company ??
    companyFromUrl(url) ??
    metaContent(html, ['og:site_name']) ??
    // "Software Engineer Intern at Acme" is the common page-title shape.
    /\bat\s+([A-Z][\w&.\- ]{1,40})\s*$/.exec(pageTitle ?? '')?.[1]?.trim();

  // Page titles routinely carry the company along; the company has its own
  // field, and repeating it in the role reads badly everywhere it is shown.
  const title = rawTitle?.replace(/\s+at\s+[A-Z][\w&.\- ]{1,40}\s*$/, '').trim() || rawTitle;

  // A structured description is authoritative even when it is short — it is the
  // posting itself, where the page text is the posting plus navigation, cookie
  // banners, and footers. Only fall back when it looks like a stub next to a
  // substantially richer page.
  const ldText = ld?.description ?? '';
  const ldIsUsable = ldText.length >= 200 || ldText.length * 2 >= text.length;
  const description = ldText.length > 0 && ldIsUsable ? ldText : text;

  return {
    title,
    company,
    location: ld?.location,
    description: description.slice(0, 40_000),
    source: ld ? 'json-ld' : metaContent(html, ['og:title']) ? 'meta' : 'heuristic',
    keywords: extractKeywords(description),
  };
}

/**
 * What kind of page this is, as far as applying for a job is concerned.
 *
 * "Is this a job posting" was too narrow a question. An application form often
 * carries almost no description — it is the page after the one you read — and
 * a board or a "who is hiring" thread is a job page too, in the sense that
 * matters: you are about to apply, and the tool should be there. So the
 * question became what kind of page it is, and the answer names all four.
 */
export type PageKind = 'posting' | 'application' | 'listing' | 'discussion' | 'none';

export interface PageVerdict {
  kind: PageKind;
  /** Confidence, roughly comparable across kinds. */
  score: number;
  /** What the decision was made on, so a wrong one can be understood. */
  why: string[];
}

const ATS = /\b(greenhouse|lever|workday|myworkdayjobs|ashby|ashbyhq|workable|smartrecruiters|icims|taleo|jobvite|bamboohr|rippling|breezy|recruitee|teamtailor|jazzhr|successfactors|brassring)\b/i;
const JOB_PATH = /\/(jobs?|careers?|opening|openings|position|positions|vacanc(y|ies)|apply|application|hiring|req|requisition)(\/|$|[?#])/i;
const BOARD = /\b(indeed|linkedin|glassdoor|monster|ziprecruiter|dice|wellfound|angel\.co|otta|builtin|simplyhired|seek|totaljobs|reed)\b/i;
const FORUM = /\b(news\.ycombinator|reddit|lobste\.rs|discourse|forum|stackexchange|quora|levels\.fyi|blind)\b/i;

/** Words that show up in the body of a posting, whatever the board. */
const DESCRIPTION_WORDS = [
  'apply now', 'job description', 'responsibilities', 'qualifications',
  "what you'll do", 'what you will do', 'minimum qualifications', 'preferred qualifications',
  'equal opportunity employer', 'submit application', 'years of experience',
  'about the role', 'the role', 'we are looking for', "we're looking for", 'join our team',
  'requirements', 'nice to have', 'benefits', 'compensation', 'salary range', 'base salary',
  'full-time', 'part-time', 'internship', 'intern', 'new grad', 'entry level',
  'employment type', 'job id', 'requisition', 'hybrid', 'remote', 'on-site', 'onsite',
  'who you are', 'what we offer', 'your impact', 'day to day',
];

/** Words that mean a form is in front of you, not a description. */
const FORM_WORDS = [
  'upload your resume', 'attach your resume', 'attach resume', 'upload resume', 'upload cv',
  'cover letter', 'first name', 'last name', 'phone number', 'linkedin profile',
  'work authorization', 'require sponsorship', 'voluntary self-identification',
  'submit application', 'application form', 'why do you want', 'tell us about',
];

/** Words that mean a list of postings rather than one. */
const LISTING_WORDS = [
  'open positions', 'open roles', 'all jobs', 'job openings', 'search jobs', 'filter by',
  'results found', 'jobs found', 'sort by', 'view all openings', 'browse jobs',
];

/** Pages that look busy but are not about a job at all. */
const AGAINST = [
  'add to cart', 'checkout', 'privacy policy', 'terms of service', 'cookie preferences',
  'page not found', 'sign in to continue', 'subscribe to our newsletter',
];

const countIn = (text: string, words: string[]): number => words.filter((w) => text.includes(w)).length;

/**
 * Classify a page. Cheap on purpose: string tests over the HTML and the
 * stripped text, no parsing, because this runs on pages that are not job pages
 * far more often than on ones that are.
 */
export function classifyPage(html: string, url?: string): PageVerdict {
  const why: string[] = [];
  const text = stripTags(html).toLowerCase().slice(0, 120_000);
  const link = (url ?? '').toLowerCase();

  let score = 0;
  const add = (n: number, reason: string) => {
    score += n;
    why.push(reason);
  };

  if (/"@type"\s*:\s*"?JobPosting/i.test(html)) add(6, 'structured JobPosting data');
  if (ATS.test(link)) add(4, 'applicant tracking system');
  if (BOARD.test(link)) add(3, 'job board');
  if (JOB_PATH.test(link)) add(2, 'job-shaped address');
  if (companyFromUrl(url)) add(2, 'company careers page');

  const described = countIn(text, DESCRIPTION_WORDS);
  const formish = countIn(text, FORM_WORDS);
  const listish = countIn(text, LISTING_WORDS);

  // Each family is capped: a page that repeats one word fifty times is not
  // fifty times more likely to be a posting.
  if (described > 0) add(Math.min(described, 5), `${described} words a posting uses`);
  if (formish > 0) add(Math.min(formish, 4), `${formish} words a form uses`);
  if (listish > 0) add(Math.min(listish, 3), `${listish} words a list of roles uses`);

  // A file input beside the word résumé is the clearest application-form
  // signal there is, and it costs one regex.
  const uploadsResume = /<input[^>]+type=["']?file/i.test(html) && /\b(resum|cv)\b/i.test(text);
  if (uploadsResume) add(3, 'asks for a resume file');

  const forumHiring = FORUM.test(link) && /\b(hiring|who is hiring|looking for|we are hiring)\b/i.test(text);
  if (forumHiring) add(3, 'a hiring thread');

  const against = countIn(text, AGAINST);
  if (against > 0) add(-Math.min(against * 2, 6), 'looks like an ordinary page');

  /*
   * Whether there is anything here to act on.
   *
   * Everything above this line counts vocabulary, and vocabulary alone turns
   * out to describe a great many pages that are not postings: a news article
   * about the hiring slowdown quotes "minimum qualifications", "years of
   * experience" and "equal opportunity employer" because it is *about*
   * postings; a documentation page headed "Requirements" talks about
   * responsibilities, benefits and compensation while meaning none of them;
   * a forum thread about how many applications people sent is full of the
   * words and is not one. All three scored as postings, and the card appeared
   * on all three.
   *
   * What a posting has that none of them has is somewhere to go: a way to
   * apply, a form to fill in, a declaration of what it is, or an address on a
   * system that exists only for this. That is also exactly what the tool needs
   * in order to be any use — a posting you cannot act on is not one it can
   * help with — so requiring it costs nothing that was worth having.
   */
  /*
   * Or the page plainly names one role.
   *
   * Requiring somewhere to apply is too strict on its own: plenty of careers
   * sites describe a role on one page and keep the Apply button a link away,
   * and those are exactly the pages worth reading, because the description is
   * what a tailored resume is tailored to. What they have that an article
   * about hiring does not is a title that is a job title — "Platform Engineer
   * at Cygnus" rather than "The tech hiring slowdown, explained".
   *
   * A title that opens with an interrogative or an article is a sentence about
   * something, not the name of a post. That one test separates every real
   * posting in the fixtures from every page that merely talks about postings.
   */
  const heading = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .concat(' ')
    .concat(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '');
  const named = stripTags(heading).split(/\s+[–—|]\s+|\s+\bat\b\s+|,/)[0]?.trim() ?? '';
  /*
   * And the role word has to be the *end* of it, give or take a level.
   * "Platform Engineer" is a post; "Software Engineer salaries" is a page
   * about what posts pay, and merely containing the word was enough to let it
   * through.
   */
  const namesARole =
    named.split(/\s+/).length <= 8 &&
    (ENDS_WITH_ROLE.test(named) || LEADS_WITH_ROLE.test(named)) &&
    !/^(how|why|what|when|where|the|a|an|is|are|should|we|our|i|my)\b/i.test(named);

  const hasFields = /<(input|textarea|select)\b/i.test(html);
  /*
   * Being on an applicant tracking system, or having an Apply link, is not on
   * its own enough — and both were. A board's own feed is on a board; the page
   * after you press submit is on the tracker and is the one page where a card
   * is pure noise; a careers landing page saying "nothing open, write to us
   * anyway" has an Apply link and no role to apply for.
   *
   * What every real posting has instead is that it is *about one role*: its
   * title names the post, or it declares itself with structured data, or it is
   * the form itself — asking for a resume, or asking enough of the questions a
   * form asks. That, and nothing weaker.
   */
  const actionable =
    /"@type"\s*:\s*"?JobPosting/i.test(html) ||
    uploadsResume ||
    namesARole ||
    (formish >= 3 && hasFields);
  if (namesARole) why.push('names a role');
  else if (actionable) why.push('somewhere to apply');

  // Which kind, in the order that decides what the tool should offer. A form
  // wins over a description, because the form is what you are about to fill
  // in — and a page that is both is still, at this moment, the form.
  let kind: PageKind = 'none';
  if (formish >= 3 || uploadsResume) kind = 'application';
  else if (described >= 3 || /"@type"\s*:\s*"?JobPosting/i.test(html)) kind = 'posting';
  else if (listish >= 2) kind = 'listing';
  else if (forumHiring) kind = 'discussion';
  else if (score >= JOB_SHAPED) kind = 'posting';

  /*
   * A board of many roles has nowhere to apply *on it* — applying happens one
   * link further in — and it describes enough of the work to read as a posting
   * on vocabulary alone. It is a listing, which is what the tool should have
   * been calling it, and listings are judged on their own evidence: a list of
   * roles and a forum saying it is hiring are both actionable in the sense
   * that matters, by way of the links they carry.
   */
  if (!actionable && kind === 'posting' && listish >= 2) kind = 'listing';

  // Everything else has to have somewhere to go.
  if (!actionable && kind !== 'listing' && kind !== 'discussion') kind = 'none';

  if (score < JOB_SHAPED) kind = 'none';
  return { kind, score, why };
}

/**
 * The bar for saying anything at all.
 *
 * Deliberately low. The cost of offering on a page that turns out not to be a
 * job is a card in the corner that gets dismissed; the cost of staying quiet
 * on one that is, is the whole tool not being there when it was needed. The
 * signals above are what keep that from meaning "every page".
 */
export const JOB_SHAPED = 3;

/**
 * Words that name a post rather than describe one.
 *
 * Not a taxonomy of every job there is — it does not need to be, because this
 * only ever decides whether a page that already reads like a posting is
 * allowed to be one without an Apply button on it. Anything missing here still
 * gets in through the button, the form, the structured data or the host.
 */
const ROLE_WORDS =
  /\b(engineer|developer|programmer|scientist|analyst|designer|manager|director|architect|administrator|consultant|specialist|technician|researcher|intern|internship|associate|coordinator|accountant|nurse|physician|teacher|professor|writer|editor|marketer|recruiter|counsel|attorney|paralegal|therapist|chef|driver|technologist|strategist|producer|operator|advisor|apprentice|fellow|lead|head of|officer|assistant|representative|agent)\b/i;
/**
 * The role word has to end the title, give or take a level — "Platform
 * Engineer", "Software Engineer II". "Software Engineer salaries" is a page
 * about what the post pays, and merely containing the word let it through.
 */
const ENDS_WITH_ROLE = new RegExp(`${ROLE_WORDS.source}\\s*(?:\\b(?:i{1,3}|iv|v|\\d+)\\b\\s*)?$`, 'i');

/** Or lead it: "Head of Platform" names a post as plainly as any of them. */
const LEADS_WITH_ROLE = /^(head|director|vp|vice president|chief|lead)\s+of\b/i;


/**
 * Cheap confidence that a page is a job posting at all. Kept as the number,
 * because callers compare it to a threshold.
 */
export function jobPostingScore(html: string, url?: string): number {
  return classifyPage(html, url).score;
}

/* ------------------------------------------------------------------ *
 * One application, several pages                                      *
 * ------------------------------------------------------------------ */

/** One page visited while applying, as the extension sends it. */
export interface PageSource {
  url?: string;
  title?: string;
  html: string;
}

export interface MergedJob extends ExtractedJob {
  /** What each page contributed, newest last, for the UI to show and prune. */
  pages: { url?: string; title?: string; kind: PageKind; chars: number }[];
}

/**
 * Read one application off the pages it is spread across.
 *
 * An application is rarely one page. You read the description on a careers
 * site, follow "Apply" to a form on a different host, and the form is where
 * the cover letter and the essay questions actually are — by which point the
 * description that would answer them is on the page you just left. Writing
 * from whichever page happens to be open is why the answers come out thin.
 *
 * So the pages are kept and read together. The most descriptive page decides
 * the title and company; every page contributes its text, in the order they
 * were visited, each under a heading saying where it came from. Nothing is
 * deduplicated cleverly: an application form that repeats the description is
 * repeating what the model would have wanted twice, which costs a little
 * budget and confuses nothing.
 */
export function mergeJobPages(pages: PageSource[]): MergedJob {
  const read = pages
    .filter((p) => p?.html?.trim())
    .map((p) => ({
      page: p,
      verdict: classifyPage(p.html, p.url),
      job: extractJob(p.html, p.url, p.title),
    }));

  if (read.length === 0) {
    return { description: '', source: 'heuristic', keywords: [], pages: [] };
  }

  // The page that best describes the role names it. A form page knows the
  // company and often not much else, so length decides among equals.
  const describing = [...read].sort((a, b) => {
    const rank = (k: PageKind) => (k === 'posting' ? 2 : k === 'discussion' ? 1 : 0);
    return rank(b.verdict.kind) - rank(a.verdict.kind) || b.job.description.length - a.job.description.length;
  });
  const best = describing[0]!;

  const sections: string[] = [];
  for (const { page, verdict, job } of read) {
    const text = job.description.trim();
    if (!text) continue;
    const where = page.title?.trim() || page.url || 'A page';
    sections.push(`## ${where} (${verdict.kind})\n${page.url ?? ''}\n\n${text}`);
  }

  const description = (sections.length > 1 ? sections.join('\n\n') : (read[0]?.job.description ?? '')).slice(0, 60_000);

  return {
    // Fields come from whichever page actually knew them, not from the last one.
    title: read.map((r) => r.job.title).find(Boolean),
    company: read.map((r) => r.job.company).find(Boolean),
    location: read.map((r) => r.job.location).find(Boolean),
    description,
    source: best.job.source,
    keywords: extractKeywords(description),
    pages: read.map(({ page, verdict, job }) => ({
      url: page.url,
      title: page.title,
      kind: verdict.kind,
      chars: job.description.length,
    })),
  };
}
