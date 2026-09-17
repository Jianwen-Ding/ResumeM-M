import { describe, expect, it } from 'vitest';
import { cleanReadme, parseRepoUrl, readRepo } from '../src/ingest/repo.js';

/**
 * Every test here injects its own fetch. Nothing in this file may reach the
 * network: a test that talks to github.com fails on a plane, fails in CI
 * without a token, and fails the day someone renames the repository it asked
 * about.
 */

interface Call {
  url: string;
  headers: Record<string, string>;
}

interface Reply {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

const REPO: Record<string, unknown> = {
  name: 'streamly',
  html_url: 'https://github.com/jianwen/streamly',
  description: 'A pipeline that keeps events in order.',
  homepage: 'https://streamly.example',
  topics: ['streaming', 'typescript'],
  stargazers_count: 42,
  pushed_at: '2026-05-01T12:00:00Z',
  owner: { login: 'jianwen' },
};

function reply({ status = 200, body, text, headers }: Reply): Response {
  const payload = text !== undefined ? text : body === undefined ? '' : JSON.stringify(body);
  return new Response(status === 204 ? null : payload, { status, headers });
}

/** A fake github.com that answers the three endpoints and records the calls. */
function github(parts: { repo?: Reply; readme?: Reply; languages?: Reply } = {}) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Headers normalises the casing, so lookups below are all lower case.
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url, headers });
    if (url.endsWith('/readme')) return reply(parts.readme ?? { status: 404, body: { message: 'Not Found' } });
    if (url.endsWith('/languages')) return reply(parts.languages ?? { body: {} });
    return reply(parts.repo ?? { body: REPO });
  }) as typeof fetch;
  return { impl, calls };
}

const call = (calls: Call[], suffix: string) => calls.find((c) => c.url.endsWith(suffix));

describe('reading the link people actually paste', () => {
  const owner = 'jianwen';
  const name = 'streamly';

  it.each([
    'https://github.com/jianwen/streamly',
    'https://github.com/jianwen/streamly/',
    'https://github.com/jianwen/streamly.git',
    'https://github.com/jianwen/streamly.git/',
    'http://github.com/jianwen/streamly',
    'https://www.github.com/jianwen/streamly',
    'https://github.com/jianwen/streamly/tree/main/src/ingest',
    'https://github.com/jianwen/streamly/blob/main/README.md',
    'https://github.com/jianwen/streamly/issues/12',
    'https://github.com/jianwen/streamly?tab=readme-ov-file',
    'https://github.com/jianwen/streamly#install',
    'github.com/jianwen/streamly',
    'git@github.com:jianwen/streamly.git',
    'git@github.com:jianwen/streamly',
    'ssh://git@github.com/jianwen/streamly.git',
    '  https://github.com/jianwen/streamly  ',
  ])('reads %s', (input) => {
    expect(parseRepoUrl(input)).toEqual({ host: 'github.com', owner, name });
  });

  it('keeps a host that is not github', () => {
    expect(parseRepoUrl('https://gitlab.com/jianwen/streamly')).toEqual({
      host: 'gitlab.com',
      owner,
      name: 'streamly',
    });
    expect(parseRepoUrl('git@bitbucket.org:team/tool.git')).toEqual({
      host: 'bitbucket.org',
      owner: 'team',
      name: 'tool',
    });
  });

  it('keeps a dot in the repository name and only strips a trailing .git', () => {
    expect(parseRepoUrl('https://github.com/jianwen/resume.js.git')?.name).toBe('resume.js');
  });

  it.each([
    ['nothing at all', ''],
    ['whitespace', '   '],
    ['a bare host', 'https://github.com'],
    ['a user page', 'https://github.com/jianwen'],
    ['a user page with a slash', 'https://github.com/jianwen/'],
    ['a sentence', 'the streaming project I built last year'],
    ['a word', 'streamly'],
    ['an email', 'mailto:jianwen@example.com'],
    ['another protocol', 'ftp://github.com/jianwen/streamly'],
    ['a missing owner', 'https://github.com//streamly'],
  ])('refuses %s', (_why, input) => {
    expect(parseRepoUrl(input)).toBeNull();
  });
});

describe('collecting the facts', () => {
  it('reads a repository, its readme and its languages', async () => {
    const { impl, calls } = github({
      readme: { text: '# Streamly\n\nAn ordered event pipeline.' },
      languages: { body: { CSS: 10, TypeScript: 12_345, Shell: 900 } },
    });

    const facts = await readRepo('https://github.com/jianwen/streamly/tree/main/src', { fetchImpl: impl });

    expect(facts).toEqual({
      url: 'https://github.com/jianwen/streamly',
      host: 'github.com',
      owner: 'jianwen',
      name: 'streamly',
      description: 'A pipeline that keeps events in order.',
      homepage: 'https://streamly.example',
      readme: '# Streamly\n\nAn ordered event pipeline.',
      languages: ['TypeScript', 'Shell', 'CSS'],
      topics: ['streaming', 'typescript'],
      stars: 42,
      pushedAt: '2026-05-01T12:00:00Z',
    });

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/jianwen/streamly',
      'https://api.github.com/repos/jianwen/streamly/readme',
      'https://api.github.com/repos/jianwen/streamly/languages',
    ]);
  });

  it('asks for the readme as raw text rather than base64 json', async () => {
    const { impl, calls } = github({ readme: { text: '# Streamly' } });
    await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    expect(call(calls, '/readme')?.headers.accept).toBe('application/vnd.github.raw');
  });

  it('identifies itself on every call', async () => {
    const { impl, calls } = github();
    await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    for (const made of calls) {
      expect(made.headers['user-agent']).toBeTruthy();
      expect(made.headers.accept).toBeTruthy();
    }
  });

  it('leaves out the fields the api returned as null', async () => {
    const { impl } = github({
      repo: { body: { ...REPO, description: null, homepage: '', topics: [], pushed_at: null } },
    });
    const facts = await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    expect(facts).not.toHaveProperty('description');
    expect(facts).not.toHaveProperty('homepage');
    expect(facts).not.toHaveProperty('topics');
    expect(facts).not.toHaveProperty('pushedAt');
  });

  it('prefers the name github gives back, so a rename does not mislabel it', async () => {
    const { impl } = github({
      repo: { body: { ...REPO, name: 'Streamly', owner: { login: 'JianWen' }, html_url: 'https://github.com/JianWen/Streamly' } },
    });
    const facts = await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    expect(facts.owner).toBe('JianWen');
    expect(facts.name).toBe('Streamly');
    expect(facts.url).toBe('https://github.com/JianWen/Streamly');
  });
});

describe('a repository with no readme', () => {
  it('is not an error', async () => {
    const { impl } = github({
      readme: { status: 404, body: { message: 'Not Found' } },
      languages: { body: { Go: 5 } },
    });
    const facts = await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    expect(facts.readme).toBeUndefined();
    expect(facts.name).toBe('streamly');
    expect(facts.languages).toEqual(['Go']);
  });

  it('is also not an error when the readme is empty or only badges', async () => {
    const { impl } = github({ readme: { text: '\n[![ci](https://img.shields.io/x.svg)](https://ci)\n\n' } });
    const facts = await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    expect(facts.readme).toBeUndefined();
  });

  it('leaves languages out when the repository has none', async () => {
    const { impl } = github({ languages: { body: {} } });
    const facts = await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    expect(facts).not.toHaveProperty('languages');
  });
});

describe('when it cannot be read', () => {
  it('says so plainly when there is no such repository', async () => {
    const { impl, calls } = github({ repo: { status: 404, body: { message: 'Not Found' } } });
    await expect(readRepo('https://github.com/jianwen/ghost', { fetchImpl: impl })).rejects.toThrow(
      /No repository at https:\/\/github\.com\/jianwen\/ghost, or it is private/,
    );
    // The readme and languages are never asked for once the repo is missing.
    expect(calls).toHaveLength(1);
  });

  it('names the rate limit, and the token that raises it', async () => {
    const { impl } = github({
      repo: {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
      },
    });
    const error = await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/rate limit/i);
    expect((error as Error).message).toMatch(/token raises the limit/i);
  });

  it('does not call a 403 a rate limit when it is not one', async () => {
    const { impl } = github({ repo: { status: 403, body: { message: 'Forbidden' } } });
    await expect(readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl })).rejects.toThrow(/403/);
  });

  it('reports any other status with the number in it', async () => {
    const { impl } = github({ repo: { status: 500, body: { message: 'boom' } } });
    await expect(readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl })).rejects.toThrow(/500/);
  });

  it('refuses a host it does not know rather than guessing its api', async () => {
    const { impl, calls } = github();
    await expect(readRepo('https://gitlab.com/jianwen/streamly', { fetchImpl: impl })).rejects.toThrow(
      /gitlab\.com is not supported/,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses something that is not a link at all', async () => {
    const { impl } = github();
    await expect(readRepo('my side project', { fetchImpl: impl })).rejects.toThrow(/does not look like a repository/);
  });
});

describe('the token', () => {
  it('is sent on every request when one is given', async () => {
    const { impl, calls } = github({ readme: { text: '# Streamly' }, languages: { body: { Go: 1 } } });
    await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl, token: 'ghp_secret' });
    expect(calls).toHaveLength(3);
    for (const made of calls) expect(made.headers.authorization).toBe('Bearer ghp_secret');
  });

  it('is absent when none is given', async () => {
    const { impl, calls } = github({ readme: { text: '# Streamly' }, languages: { body: { Go: 1 } } });
    await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    for (const made of calls) expect(made.headers.authorization).toBeUndefined();
  });
});

describe('the readme, trimmed for a prompt', () => {
  it('drops a row of badges but keeps the heading and the prose', async () => {
    const text = [
      '# Streamly',
      '',
      '[![build](https://img.shields.io/github/actions/workflow/status/j/s/ci.yml)](https://github.com/j/s/actions)',
      '[![npm](https://img.shields.io/npm/v/streamly.svg)](https://npm.im/streamly) [![licence](https://img.shields.io/badge/mit-green.svg)](./LICENSE)',
      '',
      'Streamly keeps events in order across a restart.',
    ].join('\n');

    const { impl } = github({ readme: { text } });
    const readme = (await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl })).readme!;

    expect(readme).toContain('# Streamly');
    expect(readme).toContain('Streamly keeps events in order across a restart.');
    expect(readme).not.toContain('img.shields.io');
  });

  it('drops html comments, including the multi-line ones', () => {
    const cleaned = cleanReadme('# Title\n\n<!-- TODO: rewrite\nthis whole section -->\n\nReal prose.');
    expect(cleaned).toBe('# Title\n\nReal prose.');
  });

  it('drops a long base64 data uri but keeps the line it was on', () => {
    const blob = 'A'.repeat(4000);
    const cleaned = cleanReadme(`Our logo <img src="data:image/png;base64,${blob}"> is above the fold.`);
    expect(cleaned).not.toContain(blob);
    expect(cleaned).toContain('is above the fold');
    expect(cleaned.length).toBeLessThan(200);
  });

  it('keeps an image that sits inside a sentence', () => {
    const cleaned = cleanReadme('The ![status](https://x/s.svg) badge means the build passed.');
    expect(cleaned).toContain('badge means the build passed');
  });

  it('clips to the limit and says that it did', async () => {
    const long = Array.from({ length: 600 }, (_, i) => `Line ${i} of a very long readme file.`).join('\n');
    const { impl } = github({ readme: { text: long } });

    const readme = (await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl, readmeLimit: 500 }))
      .readme!;

    expect(readme.length).toBeLessThanOrEqual(500);
    expect(readme.startsWith('Line 0 of a very long readme file.')).toBe(true);
    expect(readme).toContain('clipped');
    expect(readme).not.toContain('Line 599');
  });

  it('leaves a readme under the limit exactly as it is', async () => {
    const { impl } = github({ readme: { text: '# Streamly\n\nShort and done.' } });
    const facts = await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl, readmeLimit: 500 });
    expect(facts.readme).toBe('# Streamly\n\nShort and done.');
  });

  it('defaults the limit to something a prompt can carry', async () => {
    const { impl } = github({ readme: { text: 'x\n'.repeat(40_000) } });
    const facts = await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    expect(facts.readme!.length).toBeLessThanOrEqual(20_000);
  });
});

describe('languages', () => {
  it('come back most-used first', async () => {
    const { impl } = github({ languages: { body: { CSS: 10, TypeScript: 12_345, HTML: 500, Shell: 500 } } });
    const facts = await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    // HTML before Shell: equal bytes tie-break by name, so the order is stable.
    expect(facts.languages).toEqual(['TypeScript', 'HTML', 'Shell', 'CSS']);
  });

  it('survive a languages call that fails', async () => {
    const { impl } = github({ languages: { status: 500, body: { message: 'boom' } } });
    const facts = await readRepo('https://github.com/jianwen/streamly', { fetchImpl: impl });
    expect(facts.languages).toBeUndefined();
    expect(facts.name).toBe('streamly');
  });
});
