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
 * Cheap confidence that a page is a job posting at all, so the extension can
 * stay quiet on the other 99% of the web.
 */
export function jobPostingScore(html: string, url?: string): number {
  let score = 0;
  if (/"@type"\s*:\s*"?JobPosting/i.test(html)) score += 6;
  if (companyFromUrl(url)) score += 3;
  if (/\b(greenhouse|lever|workday|ashby|workable|smartrecruiters|icims|taleo)\b/i.test(url ?? '')) score += 2;

  const text = stripTags(html).toLowerCase();
  const signals = [
    'apply now', 'job description', 'responsibilities', 'qualifications',
    'what you\'ll do', 'minimum qualifications', 'preferred qualifications',
    'equal opportunity employer', 'submit application', 'years of experience',
  ];
  for (const s of signals) if (text.includes(s)) score += 1;

  return score;
}
