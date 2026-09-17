/**
 * Turning a repository link into facts about the project behind it.
 *
 * A project bullet is usually written from memory, weeks after the work, which
 * is why it comes out as "built a web app". The repository already knows what
 * was built: what it is called, what it says it does, what it is written in,
 * when it was last touched. Pasting a link is one action, and it is the one
 * people will actually take.
 *
 * This module only reads. The facts it returns are handed to a prompt
 * elsewhere; nothing here asks a model anything, so what comes back is the
 * repository's own words and nothing invented on its behalf.
 */

export interface RepoFacts {
  /** The canonical https URL, whatever form was pasted in. */
  url: string;
  host: string;
  owner: string;
  name: string;
  description?: string;
  /** The README as plain-ish text, stripped of furniture and clipped. */
  readme?: string;
  /** Most-used first, by bytes. */
  languages?: string[];
  topics?: string[];
  stars?: number;
  pushedAt?: string;
  homepage?: string;
}

export interface ReadRepoOptions {
  /** A GitHub token: reaches private repositories and raises the rate limit. */
  token?: string;
  /** Injectable for tests; nothing here should ever reach the network in one. */
  fetchImpl?: typeof fetch;
  readmeLimit?: number;
}

/** A README past this is prompt budget spent on installation instructions. */
const README_LIMIT = 20_000;

const GITHUB_API = 'https://api.github.com';

/** Sent on every request: GitHub rejects an API call without one. */
const USER_AGENT = 'resumem-m';

/* ------------------------------------------------------------------ *
 * The link, in whatever form it was pasted                            *
 * ------------------------------------------------------------------ */

/**
 * GitHub allows letters, digits, hyphens, underscores and dots in both owner
 * and repository names. A segment of only dots is `.`/`..` — a path, not a name.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A host at all: something.something, no spaces. */
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}$/;

/**
 * Read a repository out of a link.
 *
 * People paste what their browser or their git remote gave them, which is the
 * clone URL, the SSH remote, or the address of the file they happened to be
 * looking at. All three name the same repository, so all three are accepted
 * and the extra path is dropped. Anything that is not a repository — a user
 * page, a bare host, a sentence — returns null rather than a guess, because a
 * wrong owner/name silently produces facts about somebody else's project.
 */
export function parseRepoUrl(input: string): { host: string; owner: string; name: string } | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // `git@github.com:owner/repo.git` is not a URL — it is scp syntax, and no
  // URL parser will take it — so it is matched before anything else.
  const ssh = /^(?:ssh:\/\/)?(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(raw);
  // `host:22/owner/repo` is a port, not an owner called "22".
  if (ssh) return fromParts(ssh[1]!, ssh[2]!.replace(/^\d+\//, ''));

  let url: URL;
  try {
    // A bare `github.com/owner/repo` is what a copied address bar often gives.
    url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'git:', 'ssh:', 'git+ssh:'].includes(url.protocol)) return null;

  return fromParts(url.hostname, url.pathname);
}

function fromParts(host: string, path: string): { host: string; owner: string; name: string } | null {
  // `www.github.com` and `github.com` are the same forge; the prefix would
  // otherwise make the host look unsupported.
  const cleanHost = host.toLowerCase().replace(/^www\./, '');
  if (!HOST.test(cleanHost)) return null;

  const segments = path.split('/').filter(Boolean);
  const owner = segments[0];
  // Everything after owner/repo — `/tree/main/src`, `/blob/...`, `/issues` —
  // still names the same repository, so it is dropped rather than refused.
  const name = segments[1]?.replace(/\.git$/i, '');
  if (!owner || !name) return null;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;

  return { host: cleanHost, owner, name };
}

/* ------------------------------------------------------------------ *
 * Reading the repository                                              *
 * ------------------------------------------------------------------ */

/**
 * Collect the facts about a repository.
 *
 * Only github.com is read. Every forge has a different API shape, and one
 * guessed wrong returns plausible-looking JSON that quietly becomes a wrong
 * project description on someone's resume — so an unsupported host is named as
 * unsupported instead.
 */
export async function readRepo(input: string, opts: ReadRepoOptions = {}): Promise<RepoFacts> {
  const parsed = parseRepoUrl(input);
  if (!parsed) {
    throw new Error(
      `That does not look like a repository link: ${String(input ?? '').trim() || '(empty)'}. ` +
        'Paste something like https://github.com/owner/repo.',
    );
  }

  const { host, owner, name } = parsed;
  if (host !== 'github.com') {
    throw new Error(
      `${host} is not supported — only github.com repositories can be read. ` +
        'Add the project by hand, or paste a github.com link.',
    );
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('No fetch available to read the repository with');

  const webUrl = `https://github.com/${owner}/${name}`;
  const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  // The repository itself is fetched first: if it is missing, private, or the
  // rate limit is gone, that is the error worth reporting, and firing the other
  // two requests only to discard them would spend two more of a small budget.
  const repoRes = await fetchImpl(base, { headers: headers(opts.token, 'application/vnd.github+json') });
  if (!repoRes.ok) throw repoError(repoRes, webUrl, Boolean(opts.token));
  const data = (await repoRes.json()) as GithubRepo;

  const [readme, languages] = await Promise.all([
    readReadme(fetchImpl, base, opts),
    readLanguages(fetchImpl, base, opts),
  ]);

  // GitHub answers with the canonical casing and follows renames, so its names
  // beat the ones typed into the link.
  const realOwner = str(data.owner?.login) ?? owner;
  const realName = str(data.name) ?? name;
  const topics = Array.isArray(data.topics)
    ? data.topics.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];

  return {
    url: str(data.html_url) ?? `https://github.com/${realOwner}/${realName}`,
    host,
    owner: realOwner,
    name: realName,
    ...maybe('description', str(data.description)),
    ...maybe('readme', readme),
    ...maybe('languages', languages),
    ...maybe('topics', topics.length ? topics : undefined),
    ...maybe('stars', typeof data.stargazers_count === 'number' ? data.stargazers_count : undefined),
    ...maybe('pushedAt', str(data.pushed_at)),
    ...maybe('homepage', str(data.homepage)),
  };
}

interface GithubRepo {
  name?: unknown;
  html_url?: unknown;
  description?: unknown;
  homepage?: unknown;
  topics?: unknown;
  stargazers_count?: unknown;
  pushed_at?: unknown;
  owner?: { login?: unknown };
}

function headers(token: string | undefined, accept: string): Record<string, string> {
  const out: Record<string, string> = {
    Accept: accept,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) out.Authorization = `Bearer ${token}`;
  return out;
}

/** Drop a field entirely rather than carry `undefined` into the prompt. */
function maybe<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** A string with something in it, or nothing — the API returns null freely. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Turn a failed response into something the reader can act on. "Request failed
 * with status 403" tells a person nothing they can do; "you are rate limited,
 * a token raises the limit" tells them the next move.
 */
function repoError(res: Response, webUrl: string, hadToken: boolean): Error {
  if (res.status === 404) {
    return new Error(
      `No repository at ${webUrl}, or it is private.` +
        (hadToken ? ' Check the name, and that the token can see it.' : ' A private repository needs a token.'),
    );
  }
  if (isRateLimited(res)) {
    const reset = resetAt(res);
    return new Error(
      `GitHub's rate limit is exhausted${reset ? `, and resets at ${reset}` : ''}. ` +
        (hadToken
          ? 'Even with a token there is a ceiling; wait for the reset.'
          : 'A token raises the limit considerably — add one, or wait.'),
    );
  }
  if (res.status === 401) return new Error(`GitHub rejected the token while reading ${webUrl}.`);
  if (res.status === 403) return new Error(`GitHub refused access to ${webUrl} (403).`);
  return new Error(`GitHub returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${webUrl}.`);
}

/**
 * A 403 from GitHub is usually the rate limit rather than a permission
 * problem, and it says so in a header — `x-ratelimit-remaining: 0` — or, for
 * the secondary limit, only in the body. 429 is the newer spelling of both.
 */
function isRateLimited(res: Response): boolean {
  if (res.status !== 403 && res.status !== 429) return false;
  if (res.headers?.get('x-ratelimit-remaining') === '0') return true;
  if (res.headers?.get('retry-after')) return true;
  return false;
}

function resetAt(res: Response): string | null {
  const seconds = Number(res.headers?.get('x-ratelimit-reset'));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * The README, or nothing. Plenty of good repositories have none, and a project
 * described by its name and languages alone is still worth a bullet — so this
 * never throws. The repository call above has already reported anything that
 * is genuinely wrong.
 */
async function readReadme(fetchImpl: typeof fetch, base: string, opts: ReadRepoOptions): Promise<string | undefined> {
  /*
   * The body read belongs inside the try, not after it. Reading a response
   * body can fail on its own — a transfer that terminates mid-stream, which is
   * ordinary on a large README — and that throw escaped a function documented
   * as never throwing, out through the Promise.all that gathers it, discarding
   * a repository read that had already succeeded. What the user saw was
   * "terminated", which names nothing about the link they pasted.
   */
  try {
    // `vnd.github.raw` returns the file itself; the default returns base64 in
    // JSON, which would only need decoding again here.
    const res = await fetchImpl(`${base}/readme`, {
      headers: headers(opts.token, 'application/vnd.github.raw'),
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    const cleaned = cleanReadme(text);
    return cleaned ? clip(cleaned, opts.readmeLimit ?? README_LIMIT) : undefined;
  } catch {
    return undefined;
  }
}

/** Languages, most bytes first. Also never fatal: it is a nice-to-have. */
async function readLanguages(
  fetchImpl: typeof fetch,
  base: string,
  opts: ReadRepoOptions,
): Promise<string[] | undefined> {
  // Same again: a `/languages` call answered by a proxy's HTML error page throws
  // out of `res.json()`, and that throw is not this function's to make.
  let body: Record<string, unknown>;
  try {
    const res = await fetchImpl(`${base}/languages`, {
      headers: headers(opts.token, 'application/vnd.github+json'),
    });
    if (!res.ok) return undefined;
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!body || typeof body !== 'object') return undefined;

  const names = Object.entries(body)
    .filter(([, bytes]) => typeof bytes === 'number' && Number.isFinite(bytes))
    // Bytes descending; by name where they tie, so the order is stable and a
    // test or a diff does not depend on object key order.
    .sort((a, b) => (b[1] as number) - (a[1] as number) || a[0].localeCompare(b[0]))
    .map(([lang]) => lang);

  return names.length ? names : undefined;
}

/* ------------------------------------------------------------------ *
 * README furniture                                                    *
 * ------------------------------------------------------------------ */

/** `[![build](…)](…)`, `![logo](…)`, `<img …>` — an image, however wrapped. */
const IMAGE = /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)|!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi;

/** What is left of a badge line once the images are gone: punctuation. */
const NOISE_ONLY = /^[\s|*_\-–—·•<>/\\[\]()]*$/;

/**
 * Strip the parts of a README that are for a browser, not a reader.
 *
 * What reaches the prompt has a budget, and a third of a typical README is
 * spent on things a model cannot use: a row of shields.io badges, commented-out
 * sections, an inline logo encoded as forty kilobytes of base64. Headings and
 * prose stay — they are the part that says what the project is.
 */
export function cleanReadme(raw: string): string {
  const text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // HTML comments hide whole draft sections, and a model reads them as text.
    .replace(/<!--[\s\S]*?-->/g, '')
    // An embedded image as a data URI is pure weight: keep the mention, drop
    // the payload. Short ones are left alone; they are cheap and may be links.
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]*;base64,[A-Za-z0-9+/=\s]{200,}/gi, 'data:…');

  const kept = text.split('\n').filter((line) => {
    if (!line.trim()) return true;
    // A line that is nothing but images is a badge row. A line with prose left
    // over keeps its images: they may be the only thing labelling a figure.
    return !NOISE_ONLY.test(line.replace(IMAGE, ''));
  });

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Said when a README was cut, so the model knows it is reading a fragment. */
const CLIPPED = '\n\n… (README clipped)';

function clip(text: string, limit: number): string {
  const max = Math.max(0, Math.floor(limit));
  if (text.length <= max) return text;
  if (max <= CLIPPED.length) return text.slice(0, max);

  const room = max - CLIPPED.length;
  let cut = text.slice(0, room);
  // Prefer a line boundary, but not at the cost of throwing away most of the
  // budget on a README that is one long paragraph.
  const nl = cut.lastIndexOf('\n');
  if (nl > room * 0.5) cut = cut.slice(0, nl);
  return `${cut.trimEnd()}${CLIPPED}`;
}
