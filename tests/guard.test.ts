/**
 * The store sits on loopback with no password, so every question about who is
 * allowed to touch it is answered by headers. These are the two attacks that
 * get past CORS.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { hostName, localOnly } from '../src/server/guard.js';

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

  it('answers to a name it was deliberately told to bind', async () => {
    await request(appWith({ host: 'rmm.local' })).get('/api/store').set('Host', 'rmm.local:4600').expect(200);
    await request(appWith({ allowHosts: ['rmm.local'] })).get('/api/store').set('Host', 'rmm.local').expect(200);
  });

  it('checks nothing when it was told to answer on every interface', async () => {
    await request(appWith({ host: '0.0.0.0' })).get('/api/store').set('Host', 'whatever.example').expect(200);
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

  it('lets the extension through', async () => {
    await request(appWith())
      .post('/api/projects/close')
      .set('Host', '127.0.0.1:4600')
      .set('Origin', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')
      .expect(200);
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
