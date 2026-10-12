/**
 * The store sits on loopback with no password, so every question about who is
 * allowed to touch it is answered by headers. These are the two attacks that
 * get past CORS.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { fromEditor, hostName, localOnly, scriptPolicy } from '../src/server/guard.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const appWith = (opts?: Parameters<typeof localOnly>[0]) => {
  const app = express();
  app.use(localOnly(opts));
  app.get('/api/store', (_req, res) => res.json({ secret: 'the whole resume store' }));
  app.post('/api/projects/close', (_req, res) => res.json({ closed: true }));
  return app;
};

describe('splitting a Host header', () => {
  it('drops the port', () => {
    expect(hostName('127.0.0.1:4600')).toBe('127.0.0.1');
    expect(hostName('localhost')).toBe('localhost');
  });

  it('keeps an IPv6 literal in one piece', () => {
    expect(hostName('[::1]:4600')).toBe('[::1]');
    expect(hostName('[::1]')).toBe('[::1]');
  });

  it('is case-insensitive, as host names are', () => {
    expect(hostName('LocalHost:4600')).toBe('localhost');
  });
});

/*
 * The rebinding attack: a page on a hostname the attacker controls, which on
 * its second lookup resolves to 127.0.0.1. The browser then considers the
 * request same-origin — no preflight, no CORS header to withhold, the whole
 * store readable. The one header the page cannot forge is the Host it is
 * asking for.
 */
describe('a name that is not ours', () => {
  it('is refused, however it resolves', async () => {
    const res = await request(appWith()).get('/api/store').set('Host', 'rebound.evil.example:4600').expect(403);
    expect(res.body.error).toMatch(/answers to/);
    expect(res.body.secret).toBeUndefined();
  });

  it('is refused for writes too', async () => {
    await request(appWith()).post('/api/projects/close').set('Host', 'rebound.evil.example:4600').expect(403);
  });

  it('does not let a suffix through', async () => {
    await request(appWith()).get('/api/store').set('Host', 'localhost.evil.example').expect(403);
    await request(appWith()).get('/api/store').set('Host', 'evil.example:127.0.0.1').expect(403);
  });

  it('answers to the loopback names the editor and the app actually use', async () => {
    for (const host of ['127.0.0.1:4600', 'localhost:4600', '[::1]:4600', 'LOCALHOST']) {
      await request(appWith()).get('/api/store').set('Host', host).expect(200);
    }
  });

  // The editor's own fetch there, as Chromium sends it: no Sec-Fetch-*, a Referer of its page.
  it('answers to a name it was deliberately told to bind', async () => {
    await request(appWith({ host: 'rmm.local' })).get('/api/store').set('Host', 'rmm.local:4600')
      .set('Referer', 'http://rmm.local:4600/').expect(200);
    await request(appWith({ allowHosts: ['rmm.local'] })).get('/api/store').set('Host', 'rmm.local')
      .set('Referer', 'http://rmm.local/').expect(200);
  });

  it('checks no name when it was told to answer on every interface', async () => {
    await request(appWith({ host: '0.0.0.0' })).get('/api/store').set('Host', 'whatever.example')
      .set('Referer', 'http://whatever.example/').expect(200);
  });
});

/*
 * The other one: a cross-origin write that never gets preflighted, because a
 * form POST and a `no-cors` fetch are not preflighted at all. The reply is
 * unreadable, which matters not at all when the point of the request is to
 * close the save that is open.
 */
describe('a write from another site', () => {
  it('is refused even though nothing preflighted it', async () => {
    const res = await request(appWith())
      .post('/api/projects/close')
      .set('Host', '127.0.0.1:4600')
      .set('Origin', 'https://evil.example')
      .expect(403);
    expect(res.body.error).toMatch(/editor and the browser extension/);
  });

  it('is refused when the origin is opaque', async () => {
    await request(appWith())
      .post('/api/projects/close')
      .set('Host', '127.0.0.1:4600')
      .set('Origin', 'null')
      .expect(403);
  });

  it('lets the editor through, which is served from here', async () => {
    await request(appWith())
      .post('/api/projects/close')
      .set('Host', '127.0.0.1:4600')
      .set('Origin', 'http://127.0.0.1:4600')
      .expect(200);
  });

  /*
   * Loopback is not one origin. Another port on this machine is another
   * program — a dev server, a notebook — and a form on it posting here was let
   * through for having the right host name.
   */
  it('refuses a page on another port of this machine', async () => {
    for (const origin of ['http://127.0.0.1:3000', 'http://localhost:8888', 'http://127.0.0.1']) {
      await request(appWith())
        .post('/api/projects/close')
        .set('Host', '127.0.0.1:4600')
        .set('Origin', origin)
        .expect(403);
    }
  });

  it('counts a missing port as the scheme’s own, on both sides', async () => {
    await request(appWith()).post('/api/projects/close').set('Host', 'localhost').set('Origin', 'http://localhost').expect(200);
    await request(appWith()).post('/api/projects/close').set('Host', 'localhost').set('Origin', 'http://localhost:4600').expect(403);
  });

  it('lets the extension through once it is paired, and only then', async () => {
    const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const paired = (token: string | undefined, origin: string | undefined) => token === 'the-token' && origin === ext;
    await request(appWith({ paired }))
      .post('/api/projects/close')
      .set('Host', '127.0.0.1:4600')
      .set('Origin', ext)
      .set('X-RMM-Pair', 'the-token')
      .expect(200);
    const refused = await request(appWith({ paired }))
      .post('/api/projects/close')
      .set('Host', '127.0.0.1:4600')
      .set('Origin', ext)
      .expect(403);
    expect(refused.body.kind).toBe('not-paired');
    // And with nothing configured, no extension is paired at all.
    await request(appWith()).post('/api/projects/close').set('Host', '127.0.0.1:4600').set('Origin', ext).expect(403);
  });

  it('leaves alone anything that is not a browser', async () => {
    // The CLI, the health check, a script: no Origin at all, and a browser
    // always sends one on a write.
    await request(appWith()).post('/api/projects/close').set('Host', '127.0.0.1:4600').expect(200);
  });

  /*
   * Reads are left to CORS, which already withholds the reply. Blocking them
   * here as well would break the extension's own reads, which is the thing
   * this whole server exists to serve.
   */
  it('does not block a cross-origin read, which CORS already makes unreadable', async () => {
    await request(appWith())
      .get('/api/store')
      .set('Host', '127.0.0.1:4600')
      .set('Origin', 'https://evil.example')
      .expect(200);
  });
});

/*
 * Chrome sends `Sec-Fetch-*` to trustworthy origins only: 127.0.0.1,
 * localhost, ::1. At `http://rmm.test` (RMM_ALLOWED_HOSTS) or a LAN name it
 * sends none, so an unpaired extension's GET — no Origin, no Sec-Fetch-Site —
 * looked like the CLI, and read the store, the full health, and the live
 * pairing code. What the editor sends there, measured in Chromium: a Referer
 * of its own page on every fetch, an Origin on writes, nothing on the
 * navigation to `/`.
 */
describe('a name Chrome sends no Sec-Fetch headers to', () => {
  const HOST = 'rmm.test:4600';
  const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const app = (opts: Parameters<typeof localOnly>[0] = {}) => {
    const a = express();
    a.use(localOnly({ allowHosts: ['rmm.test'], editorFile: (p) => p === '/' || p === '/app.js', ...opts }));
    a.get('/health', (_req, res) => res.json({ ok: true, extension: res.locals.extension ?? null }));
    a.get('/api/store', (_req, res) => res.json({ secret: 'the whole resume store' }));
    a.get('/api/extension/pairings', (req, res) => {
      if (!fromEditor(req)) { res.status(403).json({ kind: 'editor-only' }); return; }
      res.json({ code: 'ABCDEFGH' });
    });
    a.post('/api/extension/pairings/code', (req, res) => {
      if (!fromEditor(req)) { res.status(403).json({ kind: 'editor-only' }); return; }
      res.json({ code: 'ABCDEFGH' });
    });
    a.get('/', (_req, res) => res.type('html').send('<p>editor</p>'));
    a.get('/app.js', (_req, res) => res.type('js').send('// editor'));
    return a;
  };

  it('refuses an extension’s header-less GET, which is what it sends there', async () => {
    for (const p of ['/api/store', '/API/store', '/api/extension/pairings']) {
      const res = await request(app()).get(p).set('Host', HOST).expect(403);
      expect(res.body.kind, p).toBe('not-paired');
      expect(JSON.stringify(res.body)).not.toContain('ABCDEFGH');
      expect(res.body.secret).toBeUndefined();
    }
    // A Referer from somewhere else is no better than none.
    await request(app()).get('/api/store').set('Host', HOST).set('Referer', 'http://evil.example/').expect(403);
    await request(app()).get('/api/store').set('Host', HOST).set('Referer', 'http://rmm.test:4601/').expect(403);
  });

  it('answers /health, as to any unpaired extension, and marks it unpaired', async () => {
    const res = await request(app()).get('/health').set('Host', HOST).expect(200);
    expect(res.body.extension).toEqual({ origin: null, paired: false });
  });

  it('refuses the pairing routes to an extension, even a paired one', async () => {
    const paired = (token: string | undefined) => token === 'the-token';
    await request(app({ paired })).get('/api/extension/pairings').set('Host', HOST).set('X-RMM-Pair', 'the-token').expect(403);
    await request(app({ paired })).post('/api/extension/pairings/code').set('Host', HOST).set('Origin', EXT)
      .set('X-RMM-Pair', 'the-token').expect(403);
    // While its token is good for the rest.
    await request(app({ paired })).get('/api/store').set('Host', HOST).set('X-RMM-Pair', 'the-token').expect(200);
  });

  it('serves the editor its page, its files, and the save', async () => {
    // Typing the address: a navigation with nothing on it at all.
    await request(app()).get('/').set('Host', HOST).set('Accept', 'text/html').expect(200);
    await request(app()).get('/app.js').set('Host', HOST).set('Origin', 'http://rmm.test:4600')
      .set('Referer', 'http://rmm.test:4600/').expect(200);
    await request(app()).get('/api/store').set('Host', HOST).set('Referer', 'http://rmm.test:4600/').expect(200);
    await request(app()).get('/api/extension/pairings').set('Host', HOST).set('Referer', 'http://rmm.test:4600/?embed=1').expect(200);
    await request(app()).post('/api/extension/pairings/code').set('Host', HOST).set('Origin', 'http://rmm.test:4600')
      .set('Referer', 'http://rmm.test:4600/').expect(200);
  });

  it('still leaves the CLI alone on loopback, which is all it talks to', async () => {
    for (const host of ['127.0.0.1:4600', 'localhost:4600']) {
      await request(app()).get('/api/store').set('Host', host).expect(200);
      await request(app()).get('/api/extension/pairings').set('Host', host).expect(200);
      await request(app()).post('/api/extension/pairings/code').set('Host', host).expect(200);
    }
  });

  it('takes only a positive same-origin sign for the pairing routes on loopback too', async () => {
    const h = '127.0.0.1:4600';
    // The editor.
    await request(app()).get('/api/extension/pairings').set('Host', h).set('Sec-Fetch-Site', 'same-origin').expect(200);
    // A navigation from a page, or a tab an extension opened: not the editor.
    for (const site of ['cross-site', 'none', 'same-site']) {
      await request(app()).get('/api/extension/pairings').set('Host', h).set('Sec-Fetch-Site', site)
        .set('Sec-Fetch-Mode', 'navigate').expect(403);
    }
    // A page on another port, whose read CORS would have withheld, is not the editor either.
    await request(app()).get('/api/extension/pairings').set('Host', h).set('Origin', 'http://127.0.0.1:3000').expect(403);
  });
});

describe('the script policy', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('base64');

  it('allows the editor’s own inline import map by its hash, and nothing else inline', () => {
    const page = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page)?.[1];
    expect(importMap).toBeTruthy();
    const policy = scriptPolicy(page, sha);
    expect(policy).toContain(`script-src 'self' 'sha256-${sha(importMap!)}'`);
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(policy).toContain("base-uri 'none'");
  });

  it('hashes an inline script, not one loaded by src', () => {
    const policy = scriptPolicy('<script src="app.js"></script><script>go()</script>', sha);
    expect(policy.match(/'sha256-/g)).toHaveLength(1);
    expect(policy).toContain(`'sha256-${sha('go()')}'`);
  });
});
