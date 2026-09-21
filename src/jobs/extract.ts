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

  /*
   * Graphics, games and the systems work next to them.
   *
   * The list above is web, backend and data, and a posting outside those
   * came back with one keyword or none — which takes the keyword match and
   * the resume ranking with it, because both can only see words that are in
   * here. A game engine posting naming C++, OpenGL, Vulkan, Unity, SDL and
   * Tracy yielded exactly one: `c++`.
   *
   * Every term is matched on word boundaries, so the risk is a product name
   * that is also an ordinary word — and a false hit here is not cosmetic. It
   * reaches `matchVariants`, which will swap a bullet toward the wording it
   * thinks the posting asked for, so the resume that gets sent is wrong for
   * a reason that was never in the posting.
   *
   * Swept against real posting prose, and four were dropped for firing on
   * it: `unity` ("a small team with real unity"), `metal` ("sheet metal
   * handling experience a plus" — a posting this tool is on, which is what
   * an earlier note here denied), `make` ("we make time for each other"),
   * and `excel` ("you will excel in a fast-paced environment", which is
   * close to the commonest sentence in the corpus). `blender` is left out
   * for the same reason without needing the sweep.
   *
   * Unity and Metal being missed is a real loss to a game or Apple posting.
   * It is the smaller loss: a picker that ranks nothing is worse than one
   * that ranks by accident only for as long as nobody acts on it, and people
   * act on a resume.
   */
  'opengl', 'vulkan', 'directx', 'webgpu', 'webgl', 'shader', 'shaders', 'rendering', 'renderer',
  'unity3d', 'unreal', 'godot', 'sdl', 'glsl', 'hlsl', 'raytracing', 'ray tracing', 'rasterization',
  'physics', 'animation', 'gameplay', 'game engine', 'graphics',
  'simd', 'gpu', 'cuda', 'opencl', 'profiling', 'valgrind', 'gdb', 'tracy',
  'memory management', 'multithreading', 'concurrency', 'lock-free', 'real-time', 'low-latency',
  'linux', 'windows', 'macos', 'cmake', 'llvm', 'clang',

  /*
   * And the trades that are not software at all. The extension offers on any
   * posting; a resume ranked against a nursing or accounting one by a
   * vocabulary that knows only Kubernetes is ranked by nothing.
   */
  'accounting', 'audit', 'payroll', 'bookkeeping', 'gaap',
  'nursing', 'clinical', 'patient care', 'phlebotomy', 'ehr', 'hipaa',
  'teaching', 'curriculum', 'classroom',
  'marketing', 'seo', 'copywriting', 'social media', 'salesforce', 'crm',
  'logistics', 'supply chain', 'inventory', 'procurement',
  'cad', 'solidworks', 'autocad', 'matlab', 'simulink', 'labview',
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
  /*
   * Where each system puts the employer's name in its own addresses.
   *
   * Two shapes, and every one of these is one or the other: the company as a
   * path segment under the system's host, or as a subdomain of it. Worth
   * keeping up because this is the only source that is *certain* — a name in
   * the address was put there by the system, where og:site_name is whatever
   * the CMS was configured with and a heading is whatever the page says.
   */
  const patterns: [RegExp, number][] = [
    [/boards\.greenhouse\.io\/([^/?#]+)/i, 1],
    [/job-boards\.greenhouse\.io\/([^/?#]+)/i, 1],
    [/jobs\.(?:eu\.)?lever\.co\/([^/?#]+)/i, 1],
    [/([\w-]+)\.wd\d+\.myworkdayjobs\.com/i, 1],
    [/jobs\.ashbyhq\.com\/([^/?#]+)/i, 1],
    [/apply\.workable\.com\/([^/?#]+)/i, 1],
    [/([\w-]+)\.workable\.com/i, 1],
    [/([\w-]+)\.breezy\.hr/i, 1],
    [/(?:careers|jobs)\.smartrecruiters\.com\/([^/?#]+)/i, 1],
    [/([\w-]+)\.recruitee\.com/i, 1],
    [/([\w-]+)\.teamtailor\.com/i, 1],
    [/([\w-]+)\.applytojob\.com/i, 1],
    [/([\w-]+)\.bamboohr\.com/i, 1],
    [/ats\.rippling\.com\/([^/?#]+)/i, 1],
    [/([\w-]+)\.jobs\.personio\.(?:de|com)/i, 1],
    [/([\w-]+)\.pinpointhq\.com/i, 1],
    [/comeet\.com\/jobs\/([^/?#]+)/i, 1],
    [/([\w-]+)\.zohorecruit\.com/i, 1],
    [/([\w-]+)\.icims\.com/i, 1],
    [/jobs\.jobvite\.com\/([^/?#]+)/i, 1],
    [/([\w-]+)\.avature\.net/i, 1],
    [/([\w-]+)\.eightfold\.ai/i, 1],
    [/([\w-]+)\.dayforcehcm\.com/i, 1],
    [/([\w-]+)\.freshteam\.com/i, 1],
    [/([\w-]+)\.homerun\.co/i, 1],
    [/([\w-]+)\.jobylon\.com/i, 1],
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

/**
 * What to call an employer a page never names.
 *
 * "Unknown" is not an answer. It went into resume labels, cover letter titles
 * and the Workspace list as the name of the application, so a bare
 * application form — which is most of them, and the ones that say least about
 * who is hiring — produced "Apply — Unknown" in the resume picker, and two
 * such applications were indistinguishable.
 *
 * The host is the one thing always known and always recognisable: you were
 * just there. A placeholder either way, but a true one.
 */
/**
 * Hosts that belong to the system rather than to the employer.
 *
 * A posting on `boards.greenhouse.io` is not a job at Greenhouse, and one on
 * `indeed.com` is not a job at Indeed. When one of these is all there is, the
 * address is kept as it stands: it says where the application came from,
 * which is honest, where a tidied "Greenhouse" would be a lie.
 */
const NOT_THE_EMPLOYER =
  /\b(greenhouse|lever|ashbyhq|workable|smartrecruiters|icims|taleo|jobvite|bamboohr|rippling|breezy|recruitee|teamtailor|applytojob|successfactors|brassring|myworkdayjobs|workday|oraclecloud|csod|cornerstone|dayforcehcm|ultipro|paylocity|paycom|eightfold|phenompeople|avature|zohorecruit|personio|pinpointhq|comeet|bullhorn|indeed|linkedin|glassdoor|monster|ziprecruiter|dice|wellfound|otta|builtin|simplyhired|seek|totaljobs|reed)\b/i;

/**
 * The employer's name when nothing on the page gave one.
 *
 * It used to be the bare hostname, so applications were filed under
 * "careers.acme-corp.com" — which is where it came from rather than who it is
 * with, and reads as a mistake in a tracker, a folder name and a letter.
 *
 * A company's own careers site is almost always its domain with a word in
 * front, so that word comes off and the rest is tidied: `careers.acme-corp.com`
 * is Acme Corp. An address that belongs to the system, an IP, or anything that
 * does not survive `looksLikeCompanyName` is left exactly as it was — better
 * plainly the address than a confident wrong name.
 */
export function employerFallback(url?: string): string {
  if (!url) return 'Unknown';
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Unknown';
  }
  if (!host) return 'Unknown';
  if (NOT_THE_EMPLOYER.test(host)) return host;
  // An address, not a name: nothing to tidy into an employer.
  if (/^[\d.]+$/.test(host) || /^\[/.test(host) || !host.includes('.')) return host;

  const labels = host.split('.');
  // Drop the public suffix — one label, or two for the `co.uk` family.
  const suffix = labels.length > 2 && /^(co|com|org|net|ac|gov)$/i.test(labels.at(-2) ?? '') ? 2 : 1;
  const named = labels.slice(0, -suffix).filter((label) => !/^(careers?|jobs?|apply|recruiting|hire|hiring|work|talent|join|people)$/i.test(label));
  const pretty = (named.at(-1) ?? '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  return pretty && looksLikeCompanyName(pretty) ? pretty : host;
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
const ROLE_NOUN =
  /\b(engineer|engineering|developer|development|programmer|manager|management|designer|analyst|scientist|intern|internship|director|architect|consultant|specialist|associate|coordinator|administrator|technician|researcher|recruiter|apprentice|trainee|senior|junior|principal|staff|lead|full[- ]?stack|front[- ]?end|back[- ]?end)\b/i;

/**
 * A suffix that settles it: whatever else the name contains, a thing ending in
 * "Inc" or "Labs" is an organisation. "Designer Brands Inc.", "Lead Bank
 * Corp", "Acme Software" are companies; "Software Engineering" is not.
 */
const ORG_SUFFIX =
  /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|company|co|holdings|group|partners|labs?|technologies|technology|systems|software|solutions|industries|ventures|capital|bank|university|college|institute|hospital|foundation|gmbh|plc|ag|nv|bv|sa|sas|srl|pty|oy|ab)\b\.?$/i;

/** Names that are a page's furniture rather than anyone's employer. */
const NOT_A_NAME =
  /^(unknown|n\.?\/?a|none|null|undefined|careers?|jobs?|job (description|posting|details?|opening)|apply|apply now|application|hiring|we ?('?re| are) hiring|now hiring|open (positions?|roles?)|home|homepage|company|employer|untitled|test|example|welcome|search|results?|opportunit(y|ies)|vacanc(y|ies)|the team|team)$/i;

/**
 * Does this read like the name of an organisation you could address a letter to?
 *
 * Deliberately strict, because the two mistakes cost differently. Refusing a
 * real company means the letter says "your team" — slightly flatter, entirely
 * sane. Accepting a non-company means the letter names it, repeatedly, as the
 * place the applicant wants to work.
 */
export function looksLikeCompanyName(name?: string): boolean {
  const n = (name ?? '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 60) return false;
  // Without the trailing punctuation: "We are hiring!" is the same non-answer
  // as "We are hiring", and a page that shouts it is if anything more certain.
  if (NOT_A_NAME.test(n.replace(/[!?.]+$/, ''))) return false;
  // A sentence, a URL fragment, or a list is not a name.
  if (/[.!?]\s|[|<>{}]|\S@\S|^https?:/i.test(n)) return false;
  if (n.split(' ').length > 6) return false;
  // Nothing but punctuation or digits.
  if (!/[a-z]/i.test(n)) return false;
  /*
   * A bare hostname. `employerFallback` hands one back on purpose — it is a
   * true and recognisable label for a folder or a resume picker — but it is
   * not a name you write to, and "boards.greenhouse.io" in the body of a
   * letter is worse than not naming anyone at all.
   */
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(n)) return false;
  if (ROLE_NOUN.test(n) && !ORG_SUFFIX.test(n)) return false;
  return true;
}

/**
 * Words a page title uses about itself, which are never the job.
 *
 * The first segment of a title is the role on a posting and something else
 * entirely on the page where you actually apply: the enterprise systems —
 * Oracle Recruiting, Cornerstone, UKG, Dayforce — title that step "Apply",
 * "Application" or "Job Details" and put the employer after the dash. Reading
 * the first segment regardless produced applications filed under the role
 * "Apply", which is not a job and cannot be searched for later.
 */
const NOT_A_ROLE =
  /*
   * "Apply for this job" is the same segment with more words in it, and the
   * rule matched the whole string or nothing — so a title reading "Apply for
   * this job — Novena Health" got the phrase treated as a name. Anything
   * that starts with applying, and says nothing after it but where or how,
   * is the page talking about itself.
   */
  /^(apply|apply now|apply here|apply (for|to)\b[\w\s]{0,30}|application( form)?|job application|submit (your )?application|start (your )?application|careers?|jobs?|job (details?|description|posting|board)|candidate (portal|home|login)|requisition|vacanc(y|ies)|openings?|current openings|join us|work (with|for) us|home|welcome)$/i;

/**
 * The role, read out of the address, when the page itself never says it.
 *
 * This is for the link in the email that says "finish your application". It
 * lands on the form rather than the description, with no posting read and no
 * trail behind it — and a bare application form does not name the job. This
 * one titles itself "Apply — Helios" and heads itself "Submit application",
 * which is every such form there is.
 *
 * What that cost was not a label. Identity is the company and the role, so an
 * application filed as "Unknown role" is a different job from the same job
 * filed from its posting: opening the posting afterwards filed a second
 * tracker row, and the card said nothing about having applied, on the one page
 * where that was worth saying. One job, two rows, and the address had the
 * answer in it the whole time — `/helios/apply/platform-engineer`.
 *
 * Held to the same two gates a page title goes through, deliberately rather
 * than by a new rule: a segment has to read like a job (`ROLE_NOUN`) and must
 * not be the page talking about itself (`NOT_A_ROLE`). That is what keeps it
 * quiet where it should be — `/gh/acme/jobs/9910` and `/lever/vega/8f21` name
 * no role and now say so, rather than inventing one out of a number, and
 * `CandidateExperience`, `submit-candidate`, `JobBoard` and `role-4c2` are all
 * refused by vocabulary that already existed and was already tested.
 *
 * The last matching segment wins, because these addresses read outwards: in
 * `/icims/orion/jobs/4021/platform-engineer/form` the job is nearer the end
 * than the system is.
 */
export function roleFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  let segments: string[];
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }

  for (const segment of segments.reverse()) {
    /*
     * A slug is words joined by punctuation, and the punctuation is the only
     * thing separating them. Requisition numbers ride along in several of
     * these systems — `2209118-platform-engineer`, `Staff-Engineer_R-12345` —
     * and a word that is all digits, or a short run of hex, is an
     * identifier rather than part of anyone's job title.
     */
    const tokens = segment.split(/[-_+.]+/).filter(Boolean);
    const isId = (w?: string) => Boolean(w) && (/^\d+$/.test(w!) || /^[0-9a-f]{4,}$/i.test(w!));
    const words = tokens.filter(
      (w, i) =>
        !isId(w) &&
        /*
         * And the letter these systems put in front of a requisition number —
         * `Staff-Engineer_R-12345` — which is part of the number rather than
         * part of the job, and came out as the role "Staff Engineer R". Only
         * when a number follows it, so a job that really is about one letter
         * keeps it.
         */
        !(w.length === 1 && isId(tokens[i + 1])),
    );
    if (words.length === 0) continue;

    const said = words.join(' ').replace(/\s+/g, ' ').trim();
    if (said.length < 3 || said.length > 80) continue;
    if (NOT_A_ROLE.test(said) || !ROLE_NOUN.test(said)) continue;

    // Title case, as `employerFallback` does for the same reason: a slug is
    // lower case and the role is shown to a person in half a dozen places.
    return said.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return undefined;
}

/**
 * A board's results page, which lists jobs and is not one.
 *
 * `Indeed — Now Hiring: 300 Software Intern Jobs` was a row in somebody's
 * tracker: the extractor fell back to the site for the employer and to the
 * page title for the role, and the title of a search is a count of jobs.
 * Every marker here is a page advertising or counting jobs rather than
 * naming one — a posting says what the work is, in the singular.
 *
 * Tested on the role rather than on the company, deliberately. The first
 * version of this refused any application whose employer was Indeed,
 * LinkedIn, Google or Reddit, on the grounds that those are where you look
 * for jobs rather than who has them. They are also four of the largest
 * employers anybody here is applying to, and the rule would have meant no
 * automatic row for any of them.
 */
const A_LIST_OF_JOBS =
  /\bnow hiring\b|\bhiring now\b|\b\d[\d,]*\+?\s+(?:[\w-]+\s+){0,3}jobs?\b|\bjobs?,\s*employment\b|\b(?:search|browse|all|view all|more)\s+jobs?\b|\bjob (?:search|results|alerts)\b/i;

/**
 * Does this read like the name of a job, rather than whatever a page had
 * lying around where a title should be?
 *
 * The other half of `looksLikeCompanyName`, and it was missing. The company
 * was checked and the role was taken on trust, so a tracker filled up with
 * rows whose role is an image url pasted out of a Reddit thread —
 * `https://preview.redd.it/...jpeg?width=1280&format=pjpg&...`, two hundred
 * characters of it, in the Role column of a list of jobs somebody is
 * applying for.
 *
 * Strict in the same direction and for the same reason: refusing a real role
 * means an application is not filed automatically and the person files it
 * themselves, which is a moment's work. Accepting a non-role puts a line in
 * the one list that is supposed to be the record of what they have done.
 */
export function looksLikeRoleTitle(role?: string): boolean {
  const r = (role ?? '').trim().replace(/\s+/g, ' ');
  if (r.length < 2 || r.length > 120) return false;
  // A url, whole or in part. Nobody's job title has a scheme or a query in it.
  if (/^https?:|^www\.|\?[a-z0-9_]+=|&[a-z0-9_]+=/i.test(r)) return false;
  // A bare hostname, for the same reason `looksLikeCompanyName` refuses one.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(r)) return false;
  if (NOT_A_ROLE.test(r.replace(/[!?.]+$/, ''))) return false;
  if (A_LIST_OF_JOBS.test(r)) return false;
  /*
   * A word, somewhere in it. `R-129384` and `4021_A` are requisition numbers
   * with a letter stuck to them, which is all the "has letters in it" test
   * asks for; no job is named in fewer than two letters running.
   */
  if (!/[a-z]{2}/i.test(r)) return false;
  /*
   * A season and a year, and nothing else. "2027 Summer" is a filter somebody
   * set on a board, or the tab group they were reading in, and it filed
   * itself as a job. A real intake says what the work is as well as when —
   * "Summer 2027 Software Engineering Intern" keeps every word here and adds
   * the ones that make it a job, so the rule is only about what is left when
   * those are gone.
   */
  if (/^((summer|fall|autumn|winter|spring|20\d\d|q[1-4]|h[12]|early|late|[-–—,/&]|and)\s*)+$/i.test(r)) return false;
  return true;
}

/** Whether this pair is worth filing a row for without being asked. */
export function looksLikeAnApplication(company?: string, role?: string): boolean {
  return looksLikeCompanyName((company ?? '').trim()) && looksLikeRoleTitle(role);
}


/** A page title's parts, in the order they were written. */
function titleParts(pageTitle?: string): string[] {
  return (pageTitle ?? '')
    .split(/[|–—·»]|\s-\s/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * A heading that names a role, for a page whose title does not.
 *
 * Required to contain a role noun rather than simply being the first heading:
 * on these systems the first heading is usually the employer, and taking it
 * would swap the two fields rather than fill them.
 */
function headingRole(html: string): string | undefined {
  for (const match of html.matchAll(/<h[12][^>]*>([\s\S]{0,120}?)<\/h[12]>/gi)) {
    const text = stripTags(match[1] ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 2 && text.length <= 80 && ROLE_NOUN.test(text) && !NOT_A_ROLE.test(text)) return text;
  }
  return undefined;
}

export function extractJob(html: string, url?: string, pageTitle?: string): ExtractedJob {
  const ld = fromJsonLd(html);
  const text = stripTags(html);
  const parts = titleParts(pageTitle);

  /*
   * A part that names a job, before a part that merely is not a page word.
   *
   * "Apply — Novena Health" has two segments and neither is the first one:
   * taking the first that was not a word about the page filed the employer as
   * the role, which is the same mistake in the opposite direction. So: a
   * segment that reads like a job, then a heading that does, and only then
   * the old answer — which is still right for every title shaped "Role | Site".
   */
  const declared = ld?.title ?? metaContent(html, ['og:title', 'twitter:title']);
  const roleish = parts.find((part) => !NOT_A_ROLE.test(part) && ROLE_NOUN.test(part)) ?? headingRole(html);
  const leftover = parts.find((part) => !NOT_A_ROLE.test(part));

  /** Every way of knowing the employer that does not go through the title. */
  const namedCompany =
    ld?.company ??
    companyFromUrl(url) ??
    metaContent(html, ['og:site_name']) ??
    // "Software Engineer Intern at Acme" is the common page-title shape.
    /\bat\s+([A-Z][\w&.\- ]{1,40})\s*$/.exec(pageTitle ?? '')?.[1]?.trim();

  /*
   * "Apply — Acme" names the employer, not the job.
   *
   * A bare application form usually titles itself with the word about the
   * page and the company: "Apply", "Application", "Careers", and then who
   * for. Dropping the page word leaves one segment, and taking it as the role
   * filed Acme as the job and the address the form was served from as the
   * employer — inverted, and the employer was the only thing the page
   * actually said. It is only this reading when nothing names a role
   * anywhere and nothing else names the company; a title that carries a job
   * word, or a site that declares its own name, is answered as before.
   */
  const onlyTheEmployer =
    !declared && !roleish && !namedCompany && Boolean(leftover) && !ROLE_NOUN.test(leftover!) && looksLikeCompanyName(leftover);

  /*
   * And a hostname is not the job either.
   *
   * `looksLikeCompanyName` already refuses one as the employer — "Apply —
   * jobs.acme.com" names nobody — but refusing it there only moved it: with
   * no other candidate it was filed as the role instead. It is the address,
   * wherever it is put.
   */
  const addressShaped = (part?: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test((part ?? '').trim());

  /*
   * And the address, last of all — after everything the page itself says.
   * A form that names its job in the title is answered from the title; this
   * is only for the one that names it nowhere, which is most of them.
   */
  const rawTitle =
    declared ?? roleish ?? (onlyTheEmployer || addressShaped(leftover) ? roleFromUrl(url) : leftover ?? roleFromUrl(url));

  const company =
    namedCompany ??
    (onlyTheEmployer
      ? leftover
      : /*
         * Or the other half of the title, which is where these systems put it:
         * "Apply — Novena Health", "Platform Engineer | Halewood Group". Held
         * to `looksLikeCompanyName`, so a second role, a sentence or a
         * hostname in that position is refused rather than filed as the
         * employer.
         */
        parts.find((part) => part !== rawTitle && !NOT_A_ROLE.test(part) && looksLikeCompanyName(part)));

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

/**
 * A comment thread, by the shape of its address.
 *
 * Reported from life: the card came up on Reddit. Two of the gates that are
 * meant to separate a posting from a page about postings are read wrongly by
 * a thread, and both because a thread is written by the people it is about.
 *
 * `namesARole` lets a page through when its title is the name of a post —
 * "Platform Engineer at Cygnus" rather than "The hiring slowdown, explained".
 * That is a good rule on a careers site, where the title is written by the
 * employer and names the thing being advertised. On a forum the title is a
 * person talking: a thread called "Software Engineer" is somebody asking what
 * to do about an offer, and there is nothing there to apply to.
 *
 * `uploadsResume` is worse, because it decides the page *is the form*. A
 * comment composer has a file input for images; a thread on r/resumes says
 * "resume" in every paragraph; and the site shell carries a login form, so
 * the page does ask for an email address. All three conditions hold, and a
 * resume-review thread was classified as an application to fill in.
 *
 * So this is a structural fact about the address rather than a list of hosts
 * to block — `/r/<sub>/comments/`, an HN item, a Discourse topic, a Stack
 * Exchange question all say "what follows is a conversation". A hiring thread
 * on one of them is still offered on, through `forumHiring` below, which is
 * the one thing a forum genuinely does have.
 */
function isDiscussionPage(link: string): boolean {
  return (
    /\breddit\.com\/(?:r|user|u)\/[^/]+\/comments\//i.test(link) ||
    /\bnews\.ycombinator\.com\/item\?/i.test(link) ||
    /\blobste\.rs\/s\//i.test(link) ||
    /\bquora\.com\/[^/]+-\d*$/i.test(link) ||
    /*
     * Discourse topics (`/t/<slug>/<id>`) and Stack Exchange questions
     * (`/questions/<id>/<slug>`), but only on a host that is one of those:
     * both shapes are ordinary paths anywhere else, and a careers site is
     * free to put a role at `/t/platform-engineer/2`.
     */
    (FORUM.test(link) &&
      (/\/(?:t|topic|thread|discussion)\/[^/]+\/\d+/i.test(link) || /\/questions\/\d+/i.test(link)))
  );
}

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

  /*
   * Does the page ask who you are?
   *
   * The difference between a page that *is* an application and a page that
   * *talks about* applications, which turns out to be the whole of the
   * false-positive problem and not what I expected it to be. A pull request on
   * a repository about job tooling, and a chat window discussing a cover
   * letter, both carry the vocabulary in quantity — because that is genuinely
   * the subject — and both have the furniture: one long textarea to type into
   * and a file picker for attachments. No amount of word counting separates
   * them from a form, because the words really are there.
   *
   * What separates them is that neither has the slightest interest in your
   * name. Every application form ever written asks for it, nearly always
   * beside an email address; a comment box and a chat composer never do,
   * because the site already knows who you are.
   *
   * Structural rather than a list of hosts, deliberately: blocking github.com
   * and the chat sites would fix the two pages that were reported and nothing
   * else, and would be wrong the first time somebody posts a job in a
   * repository.
   */
  const asksWhoYouAre =
    /<input\b[^>]*\btype\s*=\s*["']?email/i.test(html) ||
    /<(?:input|textarea)\b[^>]*\b(?:name|id|placeholder|aria-label|autocomplete)\s*=\s*["'][^"']*(?:first[\s_-]*name|last[\s_-]*name|full[\s_-]*name|your[\s_-]*name|e-?mail)[^"']*["']/i.test(html) ||
    /<label\b[^>]*>\s*(?:your |full |first |last )?(?:name|e-?mail)\b/i.test(html);

  /*
   * A file input beside the word résumé is the clearest application-form
   * signal there is — once it is on a form that is collecting *you*. Without
   * that condition it fires on any page with an attachment button that happens
   * to mention a resume, which is exactly the chat window and the pull request.
   */
  /*
   * `\b(resum|cv)\b` matched neither "resume" nor "resumes" nor "résumé": the
   * boundary after "resum" wants a non-word character and finds the "e". So
   * this — the largest single award in the scorer, and on its own comment the
   * clearest application-form signal there is — fired on "cv" alone, and every
   * real form saying "Upload your resume" scored three points under. The
   * extension's own copy of this had the same fault and was fixed first; this
   * one was missed, and a unit test on the form fixture is what found it.
   */
  const thread = isDiscussionPage(link);
  const uploadsResume =
    !thread &&
    /<input[^>]+type=["']?file/i.test(html) &&
    /\bcv\b|résum|resum/i.test(text) &&
    asksWhoYouAre;
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
    !thread &&
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
  /*
   * "Asking enough of the questions a form asks" has to mean the page is
   * asking *you*, not that the words appear in it. `formish >= 3 && hasFields`
   * was satisfied by any page with a textarea that discussed applications
   * three times, which is a chat window, a pull request, and a support thread.
   */
  const actionable =
    /"@type"\s*:\s*"?JobPosting/i.test(html) ||
    uploadsResume ||
    namesARole ||
    (formish >= 3 && hasFields && asksWhoYouAre);
  if (namesARole) why.push('names a role');
  else if (actionable) why.push('somewhere to apply');
  else if (thread) why.push('a comment thread, whatever it is about');

  // Which kind, in the order that decides what the tool should offer. A form
  // wins over a description, because the form is what you are about to fill
  // in — and a page that is both is still, at this moment, the form.
  let kind: PageKind = 'none';
  if ((formish >= 3 && hasFields && asksWhoYouAre) || uploadsResume) kind = 'application';
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

  /*
   * And the same for a hiring thread, for the same reason.
   *
   * A thread that says it is hiring is written in the vocabulary of a posting
   * — because it is one — so it reaches here as a `posting` with nowhere to
   * apply, and the gate below would throw it away. The two gates that would
   * otherwise have made it actionable are exactly the two a comment thread
   * reads wrongly: its title is a person talking, and its file input is for
   * images. What it has instead is the thing `forumHiring` found, which is
   * somebody saying they are hiring and leaving an address to write to.
   */
  if (!actionable && kind === 'posting' && forumHiring) kind = 'discussion';

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
