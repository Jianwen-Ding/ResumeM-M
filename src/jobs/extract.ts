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
    /*
     * `<noscript>` is not stripped here, deliberately — see `withoutChrome`
     * and `keepAmbiguousElement`. A page rendered entirely by JavaScript
     * sometimes carries the whole posting in its `<noscript>` fallback and
     * nothing readable anywhere else; deleting it unconditionally at this
     * layer would have made that decision before the rest of the page could
     * even be looked at. What survives past `withoutChrome` is what is left
     * to read as plain text either way.
     */
    /*
     * A line break in the *source* is not a paragraph break — real HTML is
     * pretty-printed across lines for people editing it, and a browser reads
     * every one of those as ordinary whitespace. Left alone, a sentence that
     * happened to wrap where the posting was written came out split, which
     * is invisible to a person reading the result but breaks anything doing
     * an exact match against it — a keyword that is two words, or a test
     * checking the real content survived. The structure worth keeping is
     * rebuilt right after this, from the tags themselves.
     */
    .replace(/\r?\n+/g, ' ')
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

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', middot: '·', bull: '•', trade: '™', reg: '®', copy: '©',
  rsaquo: '›', lsaquo: '‹', raquo: '»', laquo: '«', ensp: ' ', emsp: ' ', thinsp: ' ',
};

/**
 * A title or a name as a person reads it: every entity decoded, however many
 * times over it was escaped, and every kind of space made one plain space.
 *
 * Measured on SmartRecruiters, whose JSON-LD says "Staff&amp;nbsp;Software
 * Engineer": JSON-LD is script text and nothing decodes it, a `<meta>`
 * attribute is read raw here, and a page title comes from the browser decoded
 * once — which turns "&amp;nbsp;" into "&nbsp;" and stops. Decoded until
 * nothing changes, so "&amp;amp;" is "&" and "&amp;nbsp;" is a space. Only for
 * short fields; a description keeps the single decode `stripTags` gives it.
 */
export function readableName(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let out = text;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return Object.hasOwn(NAMED_ENTITIES, name.toLowerCase()) ? NAMED_ENTITIES[name.toLowerCase()]! : whole;
    });
    if (next === out) break;
    out = next;
  }
  return out.replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, ' ').trim();
}

/*
 * The parts of a page that are the site rather than the posting.
 *
 * When a posting has no usable JSON-LD, its description is the page's text, and
 * the page's text is the posting plus everything around it: the site's
 * navigation, its footer, a sidebar of other jobs, a cookie banner, and every
 * option of every dropdown — a "Location" filter lists hundreds of cities, and
 * an application form's country list lists every country. All of it went to
 * the AI as though it were the job, up to forty thousand characters a page.
 *
 * Removed by element, with the element's real closing tag found by counting
 * nesting, because the chrome is made of the same `<div>`s as everything else
 * and a pattern cannot tell where one ends. What is removed is only what says
 * it is not content: the landmark tags and roles, option lists, drawings, and
 * containers named for cookies and consent. Not `aria-hidden` and not dialogs,
 * because plenty of boards show the posting itself in a modal and hide the page
 * behind it.
 */
const CHROME_TAGS = /<(nav|footer|aside|select|svg|template|iframe|noscript)\b[^>]*>/gi;
/** `<select>` alone, for measuring the safety net's baseline. See `withoutChrome`. */
const SELECT_TAG = /<select\b[^>]*>/gi;
const CHROME_ROLES = /<([a-z][a-z0-9]*)\b[^>]*\brole\s*=\s*["'](?:navigation|banner|contentinfo|complementary|search)["'][^>]*>/gi;
const CHROME_NAMES =
  /<([a-z][a-z0-9]*)\b[^>]*\b(?:id|class)\s*=\s*["'][^"']*\b(?:cookie|cookies|consent|gdpr|onetrust)\b[^"']*["'][^>]*>/gi;
/*
 * Messaging and support chat, by the names the widgets give themselves: a
 * job board's messaging overlay (the applicant's own conversations, other
 * people's words) and the chat bubble on a careers site. Real sentences, so
 * the shape rule kept them — and nothing in either is ever about the posting.
 * Removed outright, before anything else, so no fallback puts them back.
 */
const CHAT_NAMES =
  /<([a-z][a-z0-9]*)\b[^>]*\b(?:id|class)\s*=\s*["'][^"']*\b(?:msg-overlay\w*|msg-conversation\w*|intercom-(?:container|messenger|lightweight-app|launcher)|drift-(?:widget|frame)\w*|crisp-client|tawk-(?:min-container|bubble-container|chat-widget)|livechat-(?:widget|compact-container|eye-catcher)|chat-widget-(?:container|minimized)|hubspot-messages-iframe-container|zEWidget-launcher)\b[^"']*["'][^>]*>/gi;

/*
 * Widgets that are not a landmark and not named for cookies, but are just as
 * clearly not the posting: the rail of other roles beside this one, and the
 * row of share-this-job icons. Named narrowly on purpose — "similar jobs" and
 * "social share" are what boards actually call these, and a class name that
 * merely contains "job" (`job-requirements`, `job-description`) is nowhere
 * near this list.
 */
const CHROME_WIDGETS =
  /<([a-z][a-z0-9]*)\b[^>]*\b(?:id|class)\s*=\s*["'][^"']*\b(?:similar-?jobs|related-?jobs|recommended-?jobs|other-?jobs|more-?jobs|jobs?-you-might|you-may-also-like|social-?share|share-?buttons|share-?this|sharethis|addthis)\b[^"']*["'][^>]*>/gi;

/*
 * A heading that names the rail rather than the job: what a "similar jobs" or
 * "share this" box is actually called, on the boards that were checked. This
 * is not a fact-vocabulary check — it names the *box*, not the posting, and
 * is only ever used to help remove something, never to keep it.
 */
const WIDGET_HEADING =
  /\b(?:similar|related|recommended|other|more)\s+(?:jobs?|roles?|positions?|postings?|openings?)\b|\byou may also like\b|\bpeople also viewed\b|\bshare this\s*(?:job)?\b/i;

/**
 * A heading that names a facts box rather than a rail — "Job Details",
 * "Overview", "About the role". A board that lays these facts out as bare
 * linked labels ("Boston", "Engineering") gives the shape-based check nothing
 * to go on — no sentence, no digit, no colon — so this is checked first and
 * overrides it: a box introduced this way is read as facts regardless of
 * what its links look like.
 */
const FACTS_BOX_HEADING = /\b(?:job\s*details?|role\s*details?|details|overview|about\s+the\s+role)\b/i;

/** Every `href` an element's markup carries, in the order they appear. */
function hrefsIn(outerHtml: string): string[] {
  return [...outerHtml.matchAll(/\bhref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1] ?? '');
}

/**
 * Does this address name *another* posting — a job id or a long role-naming
 * slug — rather than a value of this one?
 *
 * Judged on the last path segment alone, because that is where every board
 * checked puts the part that varies: `/jobs/482913`, `/req/2024-118`,
 * `/acme/senior-platform-engineer-8f21`. A facet link varies there too —
 * `/locations/boston`, `/employment-type/full-time` — but its last segment
 * is a plain word, not an id: no digit in it anywhere, and not enough
 * hyphenated words to be a role's own slug. That is the entire test; nothing
 * here reads the word before the id (`jobs`, `careers`, `req`, `positions`
 * all look the same to it), because a facet path uses exactly those words
 * too and a rule keyed on them cannot tell the two apart.
 */
/** A path segment that says the address is about jobs. */
const POSTING_SEGMENT = /^(?:jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|roles?|postings?|opportunit(?:y|ies)|req(?:uisitions?)?)$/i;
/** Hosts that only serve job postings. */
const JOB_BOARD_HOST = /(?:^|\.)(?:jobs\.|careers\.)|lever\.co$|greenhouse\.io$|ashbyhq\.com$|myworkdayjobs\.com$|smartrecruiters\.com$|workable\.com$|bamboohr\.com$|icims\.com$/i;

function looksLikeOtherPostingHref(href: string): boolean {
  if (/[?&](?:gh_jid|job[_-]?id|req(?:uisition)?[_-]?id)=/i.test(href)) return true;
  const path = href.split(/[?#]/)[0] ?? href;
  const segments = path.split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  if (!last) return false;
  /*
   * An id or a long slug only means "another posting" where the address says
   * it is about jobs. Without this, `/b/1`, `/t/42` and
   * `/benefits/health-dental-vision` — a benefits list, filter tags — read as
   * a rail of other jobs, and the facts in them were cut as clutter.
   */
  const host = /^[a-z]+:\/\/([^/]+)/i.exec(href)?.[1] ?? '';
  const aboutJobs =
    segments.some((segment) => POSTING_SEGMENT.test(segment)) || JOB_BOARD_HOST.test(host);
  if (!aboutJobs) return false;
  // A bare or lightly-prefixed id: "482913", "2024-118", "R-2024-118".
  if (/\d/.test(last) && /^[a-z]{0,3}-?\d[\d-]*$/i.test(last)) return true;
  // A long, several-word slug — the ordinary shape of a posting's own
  // address on the boards that name the role right in the URL.
  const words = last.split('-').filter(Boolean);
  if (words.length >= 3 && last.replace(/-/g, '').length >= 12) return true;
  return false;
}

/**
 * Do this element's links point at other job postings specifically, rather
 * than merely elsewhere? Requires at least two links and every one of them
 * shaped like a posting's own address — a single stray "Apply" or "Learn
 * more" link is not what tells a rail of other roles apart from a box of
 * facts about this one, and a box that mixes facet links with one
 * requisition link is not a rail either: `.every` fails on the first facet
 * link and the whole box reads as facts.
 */
function linksToOtherPostings(outerHtml: string): boolean {
  const links = hrefsIn(outerHtml);
  if (links.length < 2) return false;
  return links.every(looksLikeOtherPostingHref);
}

/**
 * Tags gone, nothing added back — unlike `stripTags`, which inserts a "- "
 * for every `<li>` regardless of what, if anything, is left inside it. That
 * is right for reading the page as prose but wrong here: a link list whose
 * items were just emptied out would otherwise report several characters of
 * "prose" per bullet it never had.
 */
function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ordinary words a site's own navigation and footer are built from — not a
 * fact vocabulary, and never used to keep anything. Used the other way
 * round, only inside `isSiteNavigationBlock`: a handful of links whose
 * labels mostly read like this are a menu, whatever tag carries them.
 */
const GENERIC_SITE_WORDS =
  /\b(home|about(?:\s+us)?|careers?|jobs?|blog|contact(?:\s+us)?|press|investors?|log[ -]?in|sign[ -]?(?:in|up)|privacy(?:\s+policy)?|terms(?:\s+of\s+(?:use|service))?|help|support|faq|pricing|team|company|events?|news|resources?|docs?|documentation|status|security|sitemap|accessibility|legal|cookie(?:s|\s*(?:policy|settings))?)\b/i;

/** What a breadcrumb calls itself: `aria-label="Breadcrumb"`, `class="breadcrumb"`, schema.org's `BreadcrumbList`. */
const BREADCRUMB = /\b(?:class|id|aria-label|itemtype)\s*=\s*["'][^"']*\bbreadcrumb/i;
/**
 * And what one looks like when it does not say: its links joined by an arrow,
 * "Home › Careers › Engineering". Arrows only — a footer joins its links with
 * "|" and "·", and those are menus.
 */
const BREADCRUMB_STEP = /<\/a>\s*(?:›|»|→|>|&gt;|&rsaquo;|&raquo;|&rarr;|&#8250;|&#187;)\s*<a\b/gi;

/**
 * Is this candidate a block of ordinary site navigation — furniture every
 * page on the site carries, rather than anything about this posting?
 *
 * Judged on size first: six or fewer links is a handful of chips, a
 * breadcrumb, a row of benefit links, an actions toolbar — exactly the
 * things a real "Job details" box or a filter-tag list looks like, and
 * losing one of those is the failure that matters. Six or more, sitting in
 * a `<nav>`, a `<footer>`, or a `role="navigation"`/`"banner"`/`"contentinfo"`
 * region, is a menu or a sitemap almost every time regardless of what the
 * labels say; that many anywhere else still has to actually read like site
 * furniture — mostly words like "About", "Careers", "Privacy Policy" — to
 * count as one.
 */
function isSiteNavigationBlock(outerHtml: string, tag: string): boolean {
  const labels = [...outerHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => plainText(m[1] ?? ''));
  if (labels.length < 6) return false;
  /*
   * A breadcrumb is not a menu, however many steps it takes. Its links are
   * where this posting sits on the site — the department, the team, the
   * office, the kind of role — and a seven-step one in a <nav> was read as a
   * site header and cut, every one of those with it.
   */
  if (BREADCRUMB.test(outerHtml)) return false;
  if ((outerHtml.match(BREADCRUMB_STEP)?.length ?? 0) >= labels.length - 2) return false;
  const isChromeRegion =
    tag === 'nav' || tag === 'footer' || /\brole\s*=\s*["'](?:navigation|banner|contentinfo)["']/i.test(outerHtml);
  if (isChromeRegion) return true;
  const generic = labels.filter((label) => GENERIC_SITE_WORDS.test(label)).length;
  return generic / labels.length >= 0.5;
}

/**
 * Whether this element's own links stand for something other than this
 * element's own words — because it proves itself a rail of other postings,
 * or because it is ordinary site navigation — and, if so, the markup with
 * those links' text set aside. Everything else about the element, notably a
 * `<button>`'s own label, is never discounted this way: "Apply by Friday,
 * Oct 3" is what the button says, not an address it points at, and a
 * dropdown's own options are handled entirely separately, in
 * `isLongOptionList`.
 *
 * A "Job details" heading forecloses both readings before either is even
 * asked: a board that introduces a box this way means its links as facts,
 * whatever they otherwise look like — bare labels naming a location and a
 * department read exactly like a two-link "rail" by shape alone, and the
 * heading is what tells them apart.
 */
function discountedView(outerHtml: string, tag: string): { discount: boolean; html: string; ahead: string } {
  if (FACTS_BOX_HEADING.test(plainText(outerHtml))) return { discount: false, html: outerHtml, ahead: '' };
  const proven = linksToOtherPostings(outerHtml) || isSiteNavigationBlock(outerHtml, tag);
  if (!proven && !WIDGET_HEADING.test(plainText(outerHtml))) return { discount: false, html: outerHtml, ahead: '' };
  /*
   * Where it is a rail only by what it calls itself, the links from that name
   * on. A sidebar that says what this job is — its city, its team, its terms,
   * each a link to the board's page for it — above the board's "Similar jobs"
   * was named a rail by that heading, and every link in it was set aside as
   * the rail's, the facts ahead of the heading with them. What comes before a
   * rail's name is not the rail; it is `ahead`, and a small group of links is
   * content — see `keepAmbiguousElement`. Proven any other way — every link a
   * posting, or a site menu — every link goes, as before, and so does a name
   * the markup splits with a tag, which cannot be placed.
   *
   * Only links that go somewhere count as ahead: a share row drawn icons first
   * ("LinkedIn", "Twitter", then "Share this job") is buttons pointing at `#`
   * or at a share intent, not facts about the job.
   */
  const at = proven ? 0 : Math.max(0, outerHtml.search(WIDGET_HEADING));
  const links = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  const kept: string[] = [];
  const before = outerHtml.slice(0, at).replace(links, (link) => {
    if (GOES_NOWHERE.test(hrefsIn(link)[0] ?? '')) return ' ';
    kept.push(link);
    return link;
  });
  return { discount: true, html: before + outerHtml.slice(at).replace(links, ' '), ahead: plainText(kept.join(' ')) };
}

/** A link that is a button: no address, a script, a mail-to, or a share intent. */
const GOES_NOWHERE =
  /^(?:$|#|javascript:|mailto:)|\/\/(?:www\.)?(?:twitter|x|facebook|linkedin|reddit|pinterest)\.com\/(?:intent|share|sharer|sharing|shareArticle|submit|pin\/create)/i;

/*
 * Shape, not vocabulary: what makes a stretch of non-link text read as a
 * real sentence rather than a fragment of layout, regardless of which
 * language it is written in or which words this file happens to know.
 *
 *   - a run of several words long enough to be a sentence, not a label;
 *   - any digit, currency symbol or percent sign — a salary, a headcount, a
 *     percentage bonus, a date, all look like this before they look like
 *     any particular word;
 *   - a short label followed by a colon and something after it — "Pay:",
 *     "Gehalt:", "Location:" — the shape a form or a spec sheet states a
 *     fact in, whatever the label says.
 *
 * Deliberately not a list of currencies or salary words: a footer closing
 * the posting with "CHF 120,000" or "65.000 € brutto" is caught by the
 * digit sitting right there, not by recognising Swiss francs or German
 * grammar. The one shape this file still keys on a fixed list for is a
 * bare location — see `LOCATION_SHAPE` — because "a capital letter, a
 * comma, and two more letters" is not a shape, it is a coincidence waiting
 * to happen, and "cookies, ok?" proved it.
 */
const SEVERAL_WORDS = /(?:[\p{L}][\p{L}'-]*\s+){4,}[\p{L}][\p{L}'-]*/u;
const DIGIT_CURRENCY_OR_PERCENT = /\d|%|\p{Sc}/u;
const COLON_LABEL = /\b[\p{L}][\p{L} ]{1,25}:\s*\S/u;
const US_CA_CODES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|AB|BC|MB|NB|NL|NS|ON|PE|QC|SK|YT|NT|NU';
const COMMON_COUNTRIES =
  'United States|United Kingdom|Canada|Germany|France|Spain|Ireland|Australia|India|Netherlands|Switzerland|Singapore|Japan|Mexico|Brazil|Poland|Sweden|Italy';
const LOCATION_SHAPE = new RegExp(
  String.raw`\b[A-Z][\p{L}]+(?:[ -][A-Z][\p{L}]+)*,\s*(?:${US_CA_CODES})\b|\b(?:${COMMON_COUNTRIES})\b`,
  'u',
);

/**
 * Is this element's own non-link text a real sentence worth keeping it for?
 *
 * `lenient` is only ever true inside the safety net's second pass, where the
 * bar drops to "any non-trivial amount of its own text at all" — restoring
 * whatever the strict shapes above missed, without touching the parts of
 * this file that do not depend on them (a long `<select>` is still cut, a
 * cookie banner is still judged on its own rule).
 */
function hasRealProse(nonLinkProse: string, lenient = false): boolean {
  const text = nonLinkProse.trim();
  if (text.length === 0) return false;
  if (lenient) return text.length >= 15;
  if (text.length >= 35 && SEVERAL_WORDS.test(text)) return true;
  if (DIGIT_CURRENCY_OR_PERCENT.test(text)) return true;
  if (COLON_LABEL.test(text)) return true;
  if (LOCATION_SHAPE.test(text)) return true;
  if (SHORT_SENTENCE_RUN.test(text)) return true;
  return false;
}

/**
 * A short, complete-looking line, even nowhere near the 35-character
 * sentence bar above — "US only.", "No visa sponsorship.", "Remote (EU)." —
 * a real fact for exactly as long as a footer line ever is, and gone the
 * moment a "sentence" is required to be one. Two or more words ending the
 * way a sentence ends is enough on its own.
 */
const SHORT_SENTENCE_RUN = /[\p{L}][\p{L}'-]*(?:\s+[\p{L}()][\p{L}()'-]*)+[.!?]/u;

/**
 * A `<p>`, `<li>`, `<dd>` or `<dt>` whose own text is short enough to be one
 * fact stated on its own line, the way a spec sheet or a bullet list states
 * one, whether or not it ends in any punctuation at all: "Contract role",
 * "Remote OK", "Visa sponsored". Checked on markup rather than on flattened
 * text, because "a whole element on its own" is a structural fact — nothing
 * about length or punctuation tells a stray fragment of layout apart from a
 * genuine one-line fact otherwise.
 */
function hasShortStandaloneLine(html: string): boolean {
  for (const m of html.matchAll(/<(p|li|dd|dt)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const words = plainText(m[2] ?? '').split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 3) return true;
  }
  return false;
}

/**
 * The short, narrow vocabulary a cookie banner is allowed to override itself
 * with — see the `isCookieNamed` branch of `keepAmbiguousElement`. Kept
 * separate from `hasRealProse` deliberately: an element named for cookies is
 * removed by default even when it reads as an ordinary sentence ("We use
 * cookies to improve your experience" is four words and thirty-some
 * characters, which `hasRealProse` alone would keep), and is spared only if
 * it also says one of these, or has a figure in it.
 *
 * Who may apply, as well as what the job pays: "Candidates must be eligible to
 * work in the EU" in a GDPR notice and "US citizenship is required" in a
 * consent section were cut with the privacy text around them. Not "must" or
 * "required" on their own — every cookie banner says those.
 */
const COOKIE_UNSAFE_WORDS =
  /\bsalary\b|\bcompensation\b|\bvisa\b|\bsponsor\w*\b|\bremote\b|\bhybrid\b|\bbenefit\w*\b|\brequirements?\b|\bqualifications?\b|\bdeadline\b|\bclos(?:e|es|ing) (?:date|on)\b|\bcitizen\w*|\beligib\w*|\bauthori[sz]ed to work\b|\bwork (?:permit|authori[sz]ation)\b|\bright to work\b|\bclearance\b|\brelocat\w*|\bbackground checks?\b/i;

/**
 * Is this `<select>` a real dropdown question, or a list that stands for
 * every value of something (every country, every US state)?
 *
 * A visa or an EEO question is a handful of options — Yes/No, four or five
 * categories — and the question along with its options has to survive
 * exactly as `<label>`-and-`<select>` normally does. A country picker is
 * two hundred of them, dwarfing the posting it sits beside, and none of the
 * two hundred are information about this application. Counted on the
 * element itself rather than by name, because boards do not agree on what
 * to call either kind.
 *
 * Judged before anything shape-based gets a say: an "Office" dropdown
 * listing forty branch names is forty short lines of real-looking text, and
 * a shape check would keep the whole thing. The question survives
 * regardless, in its own `<label>`, which this never touches.
 */
function isLongOptionList(outerHtml: string): boolean {
  const options = outerHtml.match(/<option\b/gi)?.length ?? 0;
  if (options > 15) return true;
  return stripTags(outerHtml).length > 600;
}

/**
 * Whether a matched chrome-shaped element should be spared, given its own
 * markup and, for `<noscript>` alone, the page it came from.
 *
 * `<select>` is judged solely on its option count, before anything else gets
 * a say. A cookie/consent-named element is judged on its own narrower rule —
 * see `COOKIE_UNSAFE_WORDS` — because "reads as a sentence" is true of every
 * cookie banner ever written and would keep all of them, and `<noscript>` is
 * judged on the page around it rather than its own shape — see the comment
 * on that branch below.
 *
 * Everything else is spared the moment its own words — a real sentence, a
 * short standalone line, a figure, a colon-labelled line — say so, where
 * "its own words" excludes a proven rail's or a big site-navigation block's
 * *link* text and nothing else: a `<button>`'s label always counts, and a
 * small group of links or buttons that is neither of those two things is
 * kept outright, whatever it does or does not say — see `discountedView`
 * and `isSiteNavigationBlock`. Only past all of that is anything chrome by
 * definition: a proven rail or a large block of site navigation with
 * nothing real left once its own links are set aside.
 */
function keepAmbiguousElement(
  outerHtml: string,
  fullHtml: string,
  opts: { isCookieNamed?: boolean; lenient?: boolean } = {},
): boolean {
  const tag = (/^<([a-z][a-z0-9]*)\b/i.exec(outerHtml)?.[1] ?? '').toLowerCase();
  if (tag === 'select') return !isLongOptionList(outerHtml);

  if (opts.isCookieNamed) {
    const withoutLinksOrButtons = plainText(
      outerHtml.replace(/<(a|button)\b[^>]*>[\s\S]*?<\/\1>/gi, ' '),
    );
    const safe = !DIGIT_CURRENCY_OR_PERCENT.test(withoutLinksOrButtons) && !COOKIE_UNSAFE_WORDS.test(withoutLinksOrButtons);
    return !safe;
  }

  /*
   * `<noscript>` is judged on the page around it, not on its own shape. A
   * real hidden fact and a plain "enable JavaScript to continue" notice read
   * as the same shape — both are a real, grammatical sentence — so shape
   * cannot tell them apart, and only context can: kept when the rest of the
   * page has too little to say without it, removed when it plainly does not
   * need it.
   */
  if (tag === 'noscript') {
    const rest = stripTags(fullHtml.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' '));
    return rest.length < TOO_LITTLE_TO_BE_A_POSTING;
  }

  const { discount, html, ahead } = discountedView(outerHtml, tag);
  if (hasRealProse(plainText(html), opts.lenient)) return true;
  if (hasShortStandaloneLine(html)) return true;
  // Links ahead of a rail's own name, which are not the rail's. See `discountedView`.
  if (ahead) return true;

  // A small group of links or buttons that proved itself neither a rail nor
  // ordinary site navigation is content, whatever it says: a filter-chip
  // list, a breadcrumb, an actions toolbar. `discount` is false for exactly
  // this case, by construction — see `discountedView`.
  return !discount;
}

/**
 * Cut every element whose opening tag matches, through its own closing tag —
 * unless `keep` says this particular one is not chrome after all, in which
 * case it is left exactly as it was and the search resumes after it.
 * `onRemove`, when given, hears the outer markup of everything actually cut —
 * see `withoutChrome`'s safety net, which measures the prose lost this way
 * rather than trusting any one word list to notice.
 */
function removeElements(
  html: string,
  opening: RegExp,
  keep?: (outerHtml: string) => boolean,
  onRemove?: (outerHtml: string) => void,
): string {
  let out = html;
  let from = 0;
  for (;;) {
    opening.lastIndex = from;
    const open = opening.exec(out);
    if (!open) return out;
    const tag = (open[1] ?? '').toLowerCase();
    const scan = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi');
    scan.lastIndex = open.index + open[0].length;
    let depth = open[0].endsWith('/>') ? 0 : 1;
    let end = depth === 0 ? scan.lastIndex : -1;
    for (let m = depth ? scan.exec(out) : null; m; m = scan.exec(out)) {
      if (m[2]) continue; // self-closing
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        end = scan.lastIndex;
        break;
      }
    }
    // Never closed: leave it, rather than cut to the end of the page.
    if (end === -1) {
      from = open.index + open[0].length;
      continue;
    }
    const outerHtml = out.slice(open.index, end);
    if (keep?.(outerHtml)) {
      from = end;
      continue;
    }
    onRemove?.(outerHtml);
    out = `${out.slice(0, open.index)} ${out.slice(end)}`;
    from = open.index;
  }
}

/**
 * Where an element opened at `open` closes, counting nested elements of the
 * same tag — the same walk `removeElements` makes — or -1 if it never does.
 */
function elementEnd(html: string, open: RegExpExecArray): number {
  const tag = (open[1] ?? '').toLowerCase();
  if (open[0].endsWith('/>')) return open.index + open[0].length;
  const scan = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi');
  scan.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = scan.exec(html); m; m = scan.exec(html)) {
    if (m[2]) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return scan.lastIndex;
  }
  return -1;
}

/*
 * A block that opens by saying it lists other openings: "Similar jobs",
 * "More roles at Acme". Read off the start of the block's own text only, so a
 * posting that mentions "other roles" in passing is never taken for one.
 */
const OTHER_POSTINGS_HEADING =
  /^\W*(?:(?:similar|related|recommended|other|more)\s+(?:jobs?|roles?|positions?|postings?|openings?|opportunities)\b|you may also like\b|people also viewed\b)/i;
const SIDE_REGION = /^<(?:aside\b|[a-z][a-z0-9]*\b[^>]*\brole\s*=\s*["']complementary["'])/i;
const OTHER_POSTINGS_MARKER = '<p>[Other openings listed on this site — not this job:]</p>';

/**
 * Say which parts of the page are about other jobs, rather than cut them.
 *
 * A "Similar jobs" rail that carries its own salaries and cities is kept by
 * `keepAmbiguousElement` — digits and places are what facts look like, and
 * losing one is the failure that matters — and a card list under "More roles
 * at Acme" in a plain `<section>` is not a chrome candidate at all. Either way
 * the AI was handed "$90,000–$110,000, Boston" beside this job's own range,
 * with nothing saying it belonged to a different posting. Cutting it risks
 * the real fact that a wrong call would take with it; labelling it costs
 * nothing, so every such block keeps its text and gains a line saying what it
 * is.
 *
 * Never more than half the page, so a wrapper around the whole posting that
 * happens to start with a rail is not mistaken for one.
 */
const OTHER_POSTINGS_ANYWHERE =
  /\b(?:similar|related|recommended|other|more)\s+(?:jobs?|roles?|positions?|postings?|openings?|opportunities)\b|\byou may also like\b|\bpeople also viewed\b/gi;
/** How far into an element its heading can sit, markup included. */
const HEADING_WINDOW = 1500;

function labelOtherPostings(html: string): string {
  /*
   * Only the elements that could be one are measured. Flattening every
   * wrapper on the page to text made this quadratic in its nesting — 1.3s on
   * a 1.9MB page against 110ms without it — so the headings are found once,
   * and an element is looked at only when one starts within reach of its
   * opening tag, or when it is a side region. Most pages have neither and
   * are returned untouched.
   */
  const headingsIn = (text: string) => [...text.matchAll(OTHER_POSTINGS_ANYWHERE)].map((m) => m.index ?? 0);
  let headings = headingsIn(html);
  if (headings.length === 0 && !/<aside\b|\brole\s*=\s*["']complementary["']/i.test(html)) return html;

  let pageText = -1;
  const opening = /<(aside|section|div|ul|ol)\b[^>]*>/gi;
  let out = html;
  let from = 0;
  for (;;) {
    opening.lastIndex = from;
    const open = opening.exec(out);
    if (!open) return out;
    const inside = open.index + open[0].length;
    const nearHeading = headings.some((at) => at >= inside && at < inside + HEADING_WINDOW);
    if (!nearHeading && !SIDE_REGION.test(open[0])) {
      from = inside;
      continue;
    }
    if (pageText < 0) pageText = plainText(html).length;
    const end = elementEnd(out, open);
    if (end === -1) {
      from = open.index + open[0].length;
      continue;
    }
    const outer = out.slice(open.index, end);
    const text = plainText(outer);
    const listsOthers =
      text.length < pageText * 0.5 &&
      !FACTS_BOX_HEADING.test(text.slice(0, 60)) &&
      ((OTHER_POSTINGS_HEADING.test(text.slice(0, 120)) && hrefsIn(outer).length >= 2) ||
        (SIDE_REGION.test(open[0]) && linksToOtherPostings(outer)));
    if (listsOthers) {
      const at = open.index + open[0].length;
      out = `${out.slice(0, at)}${OTHER_POSTINGS_MARKER}${out.slice(at)}`;
      from = end + OTHER_POSTINGS_MARKER.length;
      headings = headingsIn(out);
      continue;
    }
    from = open.index + open[0].length;
  }
}

/**
 * Below this, restoring the whole page is cheaper than trusting the trim: a
 * page this short was never going to be dominated by chrome in the first
 * place, so there is nothing to gain by cutting it further and something
 * real to lose if the cut was wrong.
 */
const TOO_LITTLE_TO_BE_A_POSTING = 200;

/**
 * How much non-link prose the safety net tolerates losing before it stops
 * trusting the per-element check and falls back to a more lenient pass. Not
 * measured in fact-words found or lost — a vocabulary list can always be
 * missing one — but in plain characters of an element's own text that were
 * actually cut, which needs no list to be right about.
 */
const PROSE_SAFETY_NET_CHARS = 120;

/**
 * The page with its chrome taken out.
 *
 * Every element this removes is spared, first, by what its own text looks
 * like rather than what it says — see `keepAmbiguousElement` and
 * `hasRealProse` — which is what lets a fact survive in a language, a
 * currency, or a phrasing this file has never seen a single word of: a
 * salary sits in the same shape ("digits near a currency mark") in "$90,000"
 * and in "65.000 €", and neither needs to be read to be kept.
 *
 * That per-element check is still checked one element at a time, and a page
 * whose real content is spread thin across several small elements — or
 * phrased in a way even the shapes above miss — could still come out
 * hollowed regardless. So the whole page is checked once more afterwards,
 * independently of any regex: if trimming actually cut more than a little of
 * an element's own non-link text (`PROSE_SAFETY_NET_CHARS`), or left
 * suspiciously little of a page that had a good deal more, the pass runs
 * again with the bar for "real text" dropped to almost nothing — restoring
 * whatever was cut, rather than reverting to the untouched page and bringing
 * a two-hundred-option dropdown back with it. Losing the posting is the only
 * failure that matters here; a page that came out longer than it needed to
 * is not one.
 */
export function withoutChrome(html: string): string {
  return labelOtherPostings(trimChrome(html));
}

function trimChrome(page: string): string {
  const html = removeElements(page, CHAT_NAMES);
  let removedProseChars = 0;
  const track = (outerHtml: string) => {
    // A long `<select>` option list is never counted: it is always correct
    // to cut, whatever `discountedView` would make of the digit-free branch
    // names or country names sitting inside its options.
    const tag = (/^<([a-z][a-z0-9]*)\b/i.exec(outerHtml)?.[1] ?? '').toLowerCase();
    if (tag === 'select') return;
    // The same discount `keepAmbiguousElement` itself applies — a proven
    // rail's or a big site-navigation block's own link text is not counted
    // as lost prose, because it never was any; everything else that gets
    // removed, including a small filter-chip or breadcrumb's link text
    // (which this file no longer removes at all — see `keepAmbiguousElement`
    // — but would need to count in full if some future change did), counts
    // in full.
    removedProseChars += plainText(discountedView(outerHtml, tag).html).length;
  };
  const keep = (outerHtml: string) => keepAmbiguousElement(outerHtml, html);
  const keepNames = (outerHtml: string) => keepAmbiguousElement(outerHtml, html, { isCookieNamed: true });

  const afterTags = removeElements(html, CHROME_TAGS, keep, track);
  const afterRoles = removeElements(afterTags, CHROME_ROLES, keep, track);
  // Cookie/consent-named removals are not tracked: they are governed by
  // their own rule, not by how much of their own text they carried.
  const afterNames = removeElements(afterRoles, CHROME_NAMES, keepNames);
  const trimmed = removeElements(afterNames, CHROME_WIDGETS, keep, track);

  /*
   * What "how much the page really had" means for the length half of the
   * safety net — already without its own long dropdown option lists.
   * Cutting a two-hundred-option country list is always correct, however
   * little of the form is left once it is gone; measuring against the fully
   * untouched page would read that correct cut as a loss and undo it,
   * options and all. This is also the floor the whole function can never
   * fall below: whatever else goes wrong further down, a page that had at
   * least this much never goes out with less than the guarantee below.
   */
  const reference = removeElements(html, SELECT_TAG, (outerHtml) => !isLongOptionList(outerHtml));
  const referenceText = stripTags(reference);
  const trimmedText = stripTags(trimmed);
  const leftTooLittle =
    trimmedText.length < TOO_LITTLE_TO_BE_A_POSTING && referenceText.length >= TOO_LITTLE_TO_BE_A_POSTING;

  if (removedProseChars > PROSE_SAFETY_NET_CHARS || leftTooLittle) {
    const lenientKeep = (outerHtml: string) => keepAmbiguousElement(outerHtml, html, { lenient: true });
    const lenient = removeElements(
      removeElements(
        removeElements(removeElements(html, CHROME_TAGS, lenientKeep), CHROME_ROLES, lenientKeep),
        CHROME_NAMES,
        keepNames,
      ),
      CHROME_WIDGETS,
      lenientKeep,
    );
    /*
     * The one guarantee this function makes, regardless of anything above:
     * a page is never handed back shorter than `reference` would have been,
     * once it had at least `TOO_LITTLE_TO_BE_A_POSTING` characters to give.
     * The lenient pass restores prose the strict one missed, but it can
     * still come up short — its own facts may be spread across elements
     * this pass still had reason to cut — and reverting one step further,
     * to `reference` itself, is cheaper than losing the posting to a page
     * whose facts turned out to live somewhere neither pass thought to look.
     */
    const lenientText = stripTags(lenient);
    if (lenientText.length < TOO_LITTLE_TO_BE_A_POSTING && referenceText.length >= TOO_LITTLE_TO_BE_A_POSTING) {
      return reference;
    }
    return lenient;
  }
  return trimmed;
}

/**
 * The facts a JobPosting states in its own fields rather than in its prose.
 *
 * The description used to be the only field read past the title, company and
 * city, so a board that states its salary, deadline, employment type or
 * remote policy the structured way — `baseSalary`, `validThrough`,
 * `employmentType`, `jobLocationType` — handed the AI a posting with none of
 * them. On a page rendered by JavaScript those fields are often the only place
 * the facts appear at all. Each becomes one plain line.
 */
function jsonLdFacts(obj: Record<string, unknown>): string[] {
  const facts: string[] = [];
  const text = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return stripTags(String(v)).trim();
    if (Array.isArray(v)) return v.map(text).filter(Boolean).join('; ');
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return text(o.name ?? o.description ?? o.value ?? o.credentialCategory ?? '');
    }
    return '';
  };
  const add = (label: string, value: string) => {
    if (value) facts.push(`${label}: ${value}`);
  };

  const places = (Array.isArray(obj.jobLocation) ? obj.jobLocation : obj.jobLocation ? [obj.jobLocation] : [])
    .map((place) => {
      const a = ((place as Record<string, unknown>)?.address ?? {}) as Record<string, unknown>;
      return [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
        .map(text)
        .filter(Boolean)
        .join(', ');
    })
    .filter(Boolean);
  add('Location', [...new Set(places)].join(' | '));
  if (/telecommute/i.test(text(obj.jobLocationType))) add('Remote', 'yes (telecommute)');
  add('Applicants must be located in', text(obj.applicantLocationRequirements));

  const salary = obj.baseSalary as Record<string, unknown> | undefined;
  if (salary && typeof salary === 'object') {
    const v = (salary.value ?? {}) as Record<string, unknown>;
    const amount =
      v.minValue != null || v.maxValue != null
        ? [v.minValue, v.maxValue].filter((x) => x != null).join('–')
        : text(typeof salary.value === 'object' ? v.value : salary.value);
    const unit = text(v.unitText ?? salary.unitText);
    add('Salary', [text(salary.currency), amount, unit ? `per ${unit.toLowerCase()}` : ''].filter(Boolean).join(' '));
  } else {
    add('Salary', text(salary));
  }
  add('Employment type', text(obj.employmentType));
  add('Apply by', text(obj.validThrough));
  add('Posted', text(obj.datePosted));
  add('Hours', text(obj.workHours));
  add('Education', text(obj.educationRequirements));
  add('Experience', text(obj.experienceRequirements));
  add('Qualifications', text(obj.qualifications));
  add('Responsibilities', text(obj.responsibilities));
  add('Skills', text(obj.skills));
  add('Benefits', text(obj.jobBenefits));
  add('Other compensation', text(obj.incentiveCompensation));
  return facts;
}

/**
 * Letters and digits only, for asking "is this already said" across two
 * renderings of the same text that break their lines differently.
 */
const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Walk JSON-LD, which is the only structured source most boards agree on. */
function fromJsonLd(html: string): (Partial<ExtractedJob> & { facts: string[] }) | undefined {
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
          title: typeof obj.title === 'string' ? readableName(obj.title) : undefined,
          company: typeof org?.name === 'string' ? readableName(org.name) : undefined,
          location: [addr?.addressLocality, addr?.addressRegion].filter(Boolean).join(', ') || undefined,
          description: typeof obj.description === 'string' ? stripTags(obj.description) : '',
          facts: jsonLdFacts(obj),
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
    if (m?.[1]) return readableName(m[1]);
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

/*
 * Technologies whose names are ordinary words.
 *
 * "Go above and beyond", "react quickly", "the spring semester", "express
 * interest", "rest assured": a posting with no technology in it came out
 * asking for Go, React, Spring, Express and REST, and the keyword match
 * steered the resume toward them. Each of these counts only where the posting
 * is plainly talking about the technology — a qualified form ("Node.js",
 * "Spring Boot"), or the word written as the name it is, next to another
 * technology or after "experience with" and its kind.
 */
export const ORDINARY_WORDS = new Set(['go', 'swift', 'react', 'node', 'spring', 'express', 'rest', 'rails', 'spark', 'rust', 'ruby']);
const QUALIFIED = /^(?:\.?js|js|\s+boot|\s+framework|\s+native|ui|\s+on\s+rails|lang|ful\b|\s+apis?)\b/i;
const NAMED_AFTER = /(?:experience (?:with|in|using)|proficien\w* (?:with|in)|knowledge of|expertise (?:with|in)|written in|familiar\w* with|programming in|develop\w* in|coding in)\s+$/i;

function meansTheTechnology(text: string, term: string, at: number): boolean {
  const said = text.slice(at, at + term.length);
  const after = text.slice(at + term.length, at + term.length + 16);
  if (QUALIFIED.test(after)) return true;
  // Written as a name: "Go", "React", "REST" — not "go" or "react".
  if (!/^[A-Z]/.test(said)) return false;
  const before = text.slice(Math.max(0, at - 40), at);
  if (NAMED_AFTER.test(before)) return true;
  const around = `${before} ${text.slice(at + term.length, at + term.length + 40)}`.toLowerCase();
  return KEYWORD_VOCAB.some(
    (other) => !ORDINARY_WORDS.has(other) && other !== term && new RegExp(`(^|[^a-z0-9+#])${escapeTerm(other)}([^a-z0-9+#]|$)`).test(around),
  );
}

const escapeTerm = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const term of KEYWORD_VOCAB) {
    // Word-boundary match so "go" does not fire on "going" or "category".
    const re = new RegExp(`(^|[^a-z0-9+#])${escapeTerm(term)}([^a-z0-9+#]|$)`, 'gi');
    if (!ORDINARY_WORDS.has(term)) {
      if (re.test(lower)) found.add(term);
      continue;
    }
    for (const hit of lower.matchAll(re)) {
      const at = (hit.index ?? 0) + (hit[1]?.length ?? 0);
      if (meansTheTechnology(text, term, at)) {
        found.add(term);
        break;
      }
    }
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
    const text = readableName(match[1]?.replace(/<[^>]+>/g, ' ') ?? '')!;
    if (text.length > 2 && text.length <= 80 && ROLE_NOUN.test(text) && !NOT_A_ROLE.test(text)) return text;
  }
  return undefined;
}

/**
 * The employer as a Workday tenant writes it into its own JSON-LD: the legal
 * entity the requisition is booked to, with its company code in front and its
 * country behind. Measured on NVIDIA's board, `hiringOrganization.name` is
 * "2100 NVIDIA USA"; Intel's reads "100 Intel Corporation". Filed as they
 * came, the tracker showed those as the employer, and "2100 NVIDIA USA" and
 * "NVIDIA Corporation" — the same job, reached from the careers site — were
 * two rows.
 *
 * Only on Workday. A number in front is a company code there and part of the
 * name everywhere else: "84 Lumber", "99 Ranch Market".
 */
const WORKDAY = /\.myworkday(jobs|site)\.com\b/i;
const ENTITY_CODE = /^\d{2,6}\s+(?=\S)/;
const ENTITY_COUNTRY = /[\s,-]+(USA|U\.S\.A?\.?|US|United States( of America)?)$/i;

export function workdayEmployer(name: string | undefined, url: string | undefined): string | undefined {
  if (!name || !WORKDAY.test(url ?? '')) return name;
  const tidied = name.trim().replace(ENTITY_CODE, '').replace(ENTITY_COUNTRY, '').trim();
  return tidied && looksLikeCompanyName(tidied) ? tidied : name;
}

/**
 * The name a site gives itself, when it is one you could write to.
 *
 * Taken raw, it was whatever the CMS was configured with: Amazon's board says
 * "Amazon.jobs", measured on its posting pages, and the tracker filed the
 * application under that — beside a second row for the same job under the
 * employer the apply flow named. A name shaped like an address is read the
 * way `employerFallback` reads an address ("Amazon.jobs" is Amazon); anything
 * else has to pass `looksLikeCompanyName`, as every other source here does.
 */
function siteName(html: string): string | undefined {
  const said = metaContent(html, ['og:site_name'])?.trim();
  if (!said) return undefined;
  if (looksLikeCompanyName(said)) return said;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(said)) {
    const read = employerFallback(`https://${said}`);
    return read !== said && looksLikeCompanyName(read) ? read : undefined;
  }
  return undefined;
}

export function extractJob(html: string, url?: string, said?: string): ExtractedJob {
  // Decoded before it is split or tested. See `readableName`.
  const pageTitle = readableName(said);
  const found = fromJsonLd(html);
  const ld = found && { ...found, company: workdayEmployer(found.company, url) };
  // The page's own text, without the site around it. See `withoutChrome`.
  const text = stripTags(withoutChrome(html));
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
    siteName(html) ??
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

  /*
   * And never at the cost of what the rest of the page says.
   *
   * Taking the structured description *instead of* the page dropped every
   * fact that only the page carried — a salary box beside the posting, a
   * deadline, a visa line — whenever the structured text was long enough to
   * win. So the structured fields come first, then its description, then
   * each line of the page (already without its chrome) that neither of those
   * already says. Compared on letters and digits only, so the same paragraph
   * broken differently in the two places is not said twice.
   */
  let description = text;
  if (ld && (ldText.length > 0 || ld.facts.length > 0)) {
    const said = bare(ldText);
    const facts = ld.facts.filter((fact) => !said.includes(bare(fact.slice(fact.indexOf(':') + 1))));
    const known = said + bare(facts.join(' '));
    const rest = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => bare(line) && !known.includes(bare(line)));
    description =
      ldText.length > 0 && ldIsUsable
        ? [facts.join('\n'), ldText, rest.join('\n')].filter(Boolean).join('\n\n')
        : [facts.join('\n'), text].filter(Boolean).join('\n\n');
  }

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
/** The most of a trail the AI is handed at once. */
const MERGED_CAP = 60_000;
const TRIMMED = '\n[… the rest of this page was trimmed to fit]';

/**
 * Every page of the trail within `MERGED_CAP`, each keeping as much of itself
 * as a fair share allows.
 *
 * Cut from the end, the cap fell on whatever came last — and the last page is
 * nearly always the application form, the one whose questions the answers are
 * written for, while a careers listing earlier in the trail can be tens of
 * thousands of characters on its own. So the space is shared out instead: a
 * page shorter than its share keeps all of itself and hands the rest on, and
 * only the pages longer than what is left are cut, all to the same length.
 */
function fitTrail(parts: { head: string; text: string }[]): string[] {
  const joined = parts.map((p) => p.head + p.text);
  const total = joined.reduce((n, s) => n + s.length + 2, 0);
  if (total <= MERGED_CAP) return joined;

  let budget = MERGED_CAP - parts.reduce((n, p) => n + p.head.length + 2, 0);
  const lengths = parts.map((p) => p.text.length).sort((a, b) => a - b);
  let cap = Infinity;
  for (let i = 0; i < lengths.length; i++) {
    const share = budget / (lengths.length - i);
    if (lengths[i]! <= share) {
      budget -= lengths[i]!;
      continue;
    }
    cap = Math.max(0, Math.floor(share));
    break;
  }
  return parts.map(({ head, text }) =>
    head + (text.length > cap ? `${text.slice(0, Math.max(0, cap - TRIMMED.length))}${TRIMMED}` : text),
  );
}

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

  const parts: { head: string; text: string }[] = [];
  for (const { page, verdict, job } of read) {
    const text = job.description.trim();
    if (!text) continue;
    const where = page.title?.trim() || page.url || 'A page';
    parts.push({ head: `## ${where} (${verdict.kind})\n${page.url ?? ''}\n\n`, text });
  }

  /*
   * A page another page already says in full is read once, as the fuller
   * copy. The same posting captured under a tracking parameter, or again once
   * "Read more" had opened it, went to the AI twice and took a share of the
   * cap the form's questions needed. Compared on letters and digits, so the
   * two captures need not break their lines alike.
   */
  const bares = parts.map((p) => bare(p.text));
  const kept = parts.filter((_, i) => {
    const mine = bares[i]!;
    return !bares.some((other, j) => j !== i && other.includes(mine) && (other.length > mine.length || j < i));
  });
  parts.splice(0, parts.length, ...kept);

  /*
   * One page with anything to say is read as that page — not as the first
   * page of the trail, which may be the one with nothing on it, and was.
   */
  const description =
    parts.length === 1 ? parts[0]!.text.slice(0, MERGED_CAP) : fitTrail(parts).join('\n\n');

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
