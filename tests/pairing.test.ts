/**
 * Pairing the browser extension.
 *
 * The server answered every `chrome-extension://` origin, so every extension
 * installed in the browser could read the whole save and write to it. Now an
 * extension reaches the save only once it has been paired with a code shown in
 * the editor, and only on a request carrying the token that pairing gave it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/index.js';
import { CODE_LIFETIME_MS, Pairings, normaliseCode } from '../src/server/pairing.js';
import request from 'supertest';
import { makeTempStore } from './helpers.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';

describe('a server with pairing', () => {
  let store: ReturnType<typeof makeTempStore>;
  let dir: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  let base: string;

  beforeEach(async () => {
    store = makeTempStore();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-pairing-'));
    server = await startServer({ port: 0, dataDir: store.dir, preferencesFile: path.join(dir, 'projects.json') });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterEach(async () => {
    await server.close();
    store.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** As the extension's service worker asks: its origin on a write, and none on a read. */
  const asExtension = (urlPath: string, { origin = EXT, token, method = 'GET', body }: {
    origin?: string; token?: string | null; method?: string; body?: unknown;
  } = {}) =>
    fetch(`${base}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'cors',
        ...(origin ? { Origin: origin } : {}),
        // Every JobHelper that knows about pairing sends the header, empty
        // until it is paired; `null` is one from before pairing, which sends none.
        ...(token !== null ? { 'X-RMM-Pair': token ?? '' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** The code the editor would show. A local process may ask, as the editor does. */
  const makeCode = async () => ((await (await fetch(`${base}/api/extension/pairings/code`, { method: 'POST' })).json()) as { code: string }).code;

  const pair = async (origin = EXT) => {
    const code = await makeCode();
    const reply = await asExtension('/api/extension/pair', { origin, method: 'POST', body: { code } });
    expect(reply.status).toBe(200);
    return ((await reply.json()) as { token: string }).token;
  };

  it('refuses an unpaired extension its reads and its writes, and says why', async () => {
    for (const [urlPath, method, body] of [
      ['/api/store', 'GET', undefined],
      ['/api/autofill', 'POST', {}],
      ['/api/applications', 'GET', undefined],
      ['/api/config', 'PUT', { ai: { enabled: true } }],
    ] as const) {
      for (const origin of [EXT, undefined]) {
        const reply = await asExtension(urlPath, { origin, method, body });
        expect(reply.status, `${method} ${urlPath} from ${origin ?? 'no origin'}`).toBe(403);
        const said = (await reply.json()) as { kind: string; error: string };
        expect(said.kind).toBe('not-paired');
        expect(said.error).toMatch(/Pair JobHelper/);
        // Readable by the extension, so it can say what to do, and nothing else in it.
        if (origin) expect(reply.headers.get('access-control-allow-origin')).toBe(origin);
        expect(JSON.stringify(said)).not.toContain(store.dir);
      }
    }
    // And the write did not happen.
    const config = (await (await fetch(`${base}/api/config`)).json()) as { ai: { enabled: boolean } };
    expect(config.ai.enabled).toBe(false);
  });

  /*
   * A JobHelper from before pairing sends no pairing header at all, and has
   * nowhere to enter a code: "make a code, and enter it in the extension"
   * was a dead end, and its sends went untracked without a word.
   */
  /*
   * By what its popup shows: one with a pairing box was told to "update",
   * and was not out of date.
   */
  it('tells a JobHelper that sent no pairing code both what to do with a pairing box and without one', async () => {
    for (const [urlPath, method, body] of [
      ['/api/store', 'GET', undefined],
      ['/api/extension/sent', 'POST', {}],
    ] as const) {
      for (const origin of [EXT, undefined]) {
        const reply = await asExtension(urlPath, { origin, method, body, token: null });
        expect(reply.status, `${method} ${urlPath} from ${origin ?? 'no origin'}`).toBe(403);
        const said = (await reply.json()) as { kind: string; error: string };
        expect(said.kind).toBe('not-paired');
        expect(said.error).toBe(
          'This JobHelper did not send a pairing code. If its popup has a pairing box, make a code in ResumeM-M ' +
            '(Save & Files → Pair JobHelper) and enter it there; if it has none, it is older than ResumeM-M: update it ' +
            '(reload the unpacked extension from the new version).',
        );
      }
    }
    // Everything else about pairing is as it was: what is open stays open, and a token still pairs.
    expect((await asExtension('/health', { token: null })).status).toBe(200);
    const token = await pair();
    expect((await asExtension('/api/store', { token })).status).toBe(200);
  });

  it('refuses the PDFs, the flat folder, and the API however it is spelled', async () => {
    for (const urlPath of ['/pdf/anything.pdf', '/current', '/API/store', '/Api/Store/', '/api/store/', '/health/../api/store']) {
      const reply = await asExtension(urlPath);
      expect(reply.status, urlPath).toBe(403);
    }
  });

  it('answers a paired extension that sends its token, with or without its origin', async () => {
    const token = await pair();
    const read = await asExtension('/api/store', { token });
    expect(read.status).toBe(200);
    expect(read.headers.get('access-control-allow-origin')).toBe(EXT);
    expect(((await read.json()) as { profile: unknown }).profile).toBeTruthy();
    expect((await asExtension('/api/store', { token, origin: undefined })).status).toBe(200);
    const write = await asExtension('/api/config', { token, method: 'PUT', body: { ai: { enabled: true } } });
    expect(write.status).toBe(200);
  });

  it('refuses a paired origin with a wrong token, and a token sent from another extension', async () => {
    const token = await pair();
    const wrong = await asExtension('/api/store', { token: `${token.slice(0, -2)}xx` });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { kind: string }).kind).toBe('not-paired');
    expect((await asExtension('/api/store', { origin: OTHER, token })).status).toBe(403);
    expect((await asExtension('/api/store', { origin: undefined, token: 'not-a-token-at-all-but-long' })).status).toBe(403);
  });

  it('keeps an earlier pairing of the same extension, as a second browser profile has', async () => {
    const first = await pair();
    const second = await pair();
    expect((await asExtension('/api/store', { token: first })).status).toBe(200);
    expect((await asExtension('/api/store', { token: second })).status).toBe(200);
    const listed = (await (await fetch(`${base}/api/extension/pairings`)).json()) as { paired: unknown[] };
    expect(listed.paired).toHaveLength(1);
  });

  it('takes a code once', async () => {
    const code = await makeCode();
    expect((await asExtension('/api/extension/pair', { method: 'POST', body: { code } })).status).toBe(200);
    const again = await asExtension('/api/extension/pair', { origin: OTHER, method: 'POST', body: { code } });
    expect(again.status).toBe(403);
    expect(((await again.json()) as { kind: string }).kind).toBe('no-code');
  });

  /*
   * Five wrong tries ended the code for everyone, so any extension in the
   * browser could post five wrong codes and keep the real one from pairing.
   */
  it('shuts out an extension after five wrong tries, and only that extension', async () => {
    const code = await makeCode();
    for (let i = 1; i <= 5; i++) {
      const reply = await asExtension('/api/extension/pair', { origin: OTHER, method: 'POST', body: { code: 'WRONGONE' } });
      expect(reply.status).toBe(403);
      expect(((await reply.json()) as { triesLeft: number }).triesLeft).toBe(5 - i);
    }
    // The one that guessed cannot use it now, not even with the right code.
    const late = await asExtension('/api/extension/pair', { origin: OTHER, method: 'POST', body: { code } });
    expect(late.status).toBe(403);
    expect(await late.json()).toMatchObject({ kind: 'bad-code', triesLeft: 0 });
    // Everyone else still can.
    expect((await asExtension('/api/extension/pair', { method: 'POST', body: { code } })).status).toBe(200);
  });

  it('still ends a code after fifty wrong tries in all', async () => {
    const code = await makeCode();
    const origin = (i: number) => `chrome-extension://${'abcdefghijklmnop'[Math.floor(i / 16)]!.repeat(16)}${'abcdefghijklmnop'[i % 16]!.repeat(16)}`;
    for (let i = 0; i < 10; i++) {
      for (let t = 0; t < 5; t++) {
        expect((await asExtension('/api/extension/pair', { origin: origin(i), method: 'POST', body: { code: 'WRONGONE' } })).status).toBe(403);
      }
    }
    const late = await asExtension('/api/extension/pair', { method: 'POST', body: { code } });
    expect(late.status).toBe(403);
    expect(((await late.json()) as { kind: string }).kind).toBe('no-code');
  });

  it('accepts the code as people type it', async () => {
    const code = await makeCode();
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `;
    expect((await asExtension('/api/extension/pair', { method: 'POST', body: { code: typed } })).status).toBe(200);
  });

  it('revokes a pairing that is removed in the editor', async () => {
    const token = await pair();
    const second = await pair();
    expect((await asExtension('/api/store', { token })).status).toBe(200);
    const listed = (await (await fetch(`${base}/api/extension/pairings`)).json()) as { paired: { origin: string; id: string }[] };
    expect(listed.paired.map((p) => p.origin)).toEqual([EXT]);
    const removed = await fetch(`${base}/api/extension/pairings/${listed.paired[0]!.id}`, { method: 'DELETE' });
    expect(((await removed.json()) as { removed: boolean }).removed).toBe(true);
    const after = await asExtension('/api/store', { token });
    expect(after.status).toBe(403);
    expect((await asExtension('/api/store', { token: second })).status).toBe(403);
    expect(((await after.json()) as { error: string }).error).toMatch(/removed/);
  });

  it('keeps the pairing on this machine, beside the preferences, and only a hash of the token', async () => {
    const token = await pair();
    const file = path.join(dir, 'extensions.json');
    const kept = fs.readFileSync(file, 'utf8');
    expect(kept).toContain(EXT);
    expect(kept).not.toContain(token);
    expect(fs.readdirSync(store.dir)).not.toContain('extensions.json');
  });

  it('shows the code and the list to the editor only, never to an extension, paired or not', async () => {
    const token = await pair();
    for (const [urlPath, method] of [
      ['/api/extension/pairings', 'GET'],
      ['/api/extension/pairings/code', 'POST'],
      [`/api/extension/pairings/${OTHER.slice(-32)}`, 'DELETE'],
    ] as const) {
      expect((await asExtension(urlPath, { method })).status, `${method} ${urlPath} unpaired`).toBe(403);
      expect((await asExtension(urlPath, { method, token })).status, `${method} ${urlPath} paired`).toBe(403);
    }
    // The editor's own request: same origin.
    const editor = await fetch(`${base}/api/extension/pairings`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(editor.status).toBe(200);
    // A tab opened on it, by a link or by an extension, is not the editor.
    for (const site of ['none', 'cross-site']) {
      await request(base).get('/api/extension/pairings').set('Sec-Fetch-Site', site).set('Sec-Fetch-Mode', 'navigate').expect(403);
    }
  });

  /*
   * JobHelper's "Get a code" links to `#save/pair?make=1`, and the editor
   * presses "Make a code" itself on arriving there. The fragment never
   * reaches the server, so the link is only a way into the editor page: the
   * code is still made by the editor's own request, and anything else that
   * asks — a page elsewhere, a tab opened on the route, another program's port
   * on loopback, an extension — is refused as before.
   */
  it('makes a code for the editor alone, whatever opens the link that asks for one', async () => {
    // Opening the link is a navigation to the editor page, and makes nothing.
    await request(base).get('/').set('Sec-Fetch-Site', 'cross-site').set('Sec-Fetch-Mode', 'navigate').expect(200);
    const seen = async () => ((await (await fetch(`${base}/api/extension/pairings`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).json()) as { code: unknown }).code;
    expect(await seen()).toBeNull();
    // A page elsewhere posting to the route, by fetch or by a form.
    for (const [site, mode] of [['cross-site', 'cors'], ['cross-site', 'navigate'], ['same-site', 'no-cors'], ['none', 'navigate']] as const) {
      await request(base).post('/api/extension/pairings/code').set('Sec-Fetch-Site', site).set('Sec-Fetch-Mode', mode).expect(403);
    }
    // Another program's port on loopback is not this editor.
    await request(base).post('/api/extension/pairings/code').set('Origin', 'http://127.0.0.1:1').set('Sec-Fetch-Site', 'same-site').expect(403);
    // Nor is an extension, paired or not.
    expect((await asExtension('/api/extension/pairings/code', { method: 'POST' })).status).toBe(403);
    expect(await seen()).toBeNull();
    // The editor's own request, which is what the link sets off, still does.
    const made = await fetch(`${base}/api/extension/pairings/code`, { method: 'POST', headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
    expect(made.status).toBe(200);
    expect(await seen()).toMatchObject({ code: expect.stringMatching(/^[A-Z2-9]{8}$/) });
  });

  it('pairs only from an extension origin', async () => {
    const code = await makeCode();
    const reply = await fetch(`${base}/api/extension/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ code }),
    });
    expect(reply.status).toBe(400);
  });

  it('tells an unpaired extension it is up and unpaired, and nothing personal', async () => {
    const reply = await asExtension('/health');
    expect(reply.status).toBe(200);
    const health = (await reply.json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, service: 'resumem-m', projectOpen: true, paired: false });
    expect(health).not.toHaveProperty('dataDir');
    expect(health).not.toHaveProperty('outDir');
    expect(health).not.toHaveProperty('ai');
    const token = await pair();
    const full = (await (await asExtension('/health', { token })).json()) as Record<string, unknown>;
    expect(full).toMatchObject({ paired: true, dataDir: store.dir });
    // The CLI and scripts are not extensions, and hear what they always did.
    const local = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(local.dataDir).toBe(store.dir);
    expect(local).not.toHaveProperty('paired');
  });

  it('still takes a bug report from an extension that is not paired, but does not list them to it', async () => {
    const reports = path.join(dir, 'reports');
    await server.close();
    server = await startServer({ port: 0, dataDir: store.dir, preferencesFile: path.join(dir, 'projects.json'), bugReportsDir: reports });
    base = `http://127.0.0.1:${server.port}`;
    const report = { id: '12345678-1234-1234-1234-123456789abc', text: 'Pairing does not work', createdAt: new Date().toISOString(), version: '1', extensionBuild: 'x', screenshots: [] };
    expect((await asExtension('/api/bug-reports', { method: 'POST', body: report })).ok).toBe(true);
    expect((await asExtension('/api/bug-reports')).status).toBe(403);
  });

  it('leaves the editor alone', async () => {
    const reply = await fetch(`${base}/api/store`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' } });
    expect(reply.status).toBe(200);
    const write = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ ai: { enabled: false } }),
    });
    expect(write.status).toBe(200);
    // A person following a link from a job page to a PDF is a navigation, not a fetch.
    // (supertest, because Node's own fetch writes its own Sec-Fetch-Mode over this one.)
    const opened = await request(base).get('/current').set('Sec-Fetch-Site', 'cross-site').set('Sec-Fetch-Mode', 'navigate');
    expect(opened.status).toBe(200);
  });
});

/*
 * On a name that is not loopback (`RMM_ALLOWED_HOSTS=rmm.test`, or a LAN
 * name) Chrome sends no Sec-Fetch headers, from the editor or from an
 * extension. An unpaired extension's GET there carried nothing at all, looked
 * like the CLI, and got the store, the full health, and the live code — which
 * it then paired itself with. The headers below are what Chromium sends there.
 */
describe('a server reached by a name that is not loopback', () => {
  let store: ReturnType<typeof makeTempStore>;
  let dir: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  let host: string;
  const before = process.env.RMM_ALLOWED_HOSTS;

  beforeEach(async () => {
    store = makeTempStore();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-pairing-'));
    process.env.RMM_ALLOWED_HOSTS = 'rmm.test';
    server = await startServer({ port: 0, dataDir: store.dir, preferencesFile: path.join(dir, 'projects.json') });
    host = `rmm.test:${server.port}`;
  });
  afterEach(async () => {
    if (before === undefined) delete process.env.RMM_ALLOWED_HOSTS;
    else process.env.RMM_ALLOWED_HOSTS = before;
    await server.close();
    store.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const at = () => request(`http://127.0.0.1:${server.port}`);
  /** The editor's own fetch on that name: a Referer of its page, nothing else. */
  const editor = { Referer: '' };
  beforeEach(() => { editor.Referer = `http://${host}/`; });

  it('refuses an unpaired extension the store, the health details and the code', async () => {
    const code = (await at().post('/api/extension/pairings/code').set('Host', `127.0.0.1:${server.port}`).expect(200)).body.code as string;
    for (const p of ['/api/store', '/API/store', '/api/extension/pairings', '/pdf/x.pdf', '/current']) {
      const reply = await at().get(p).set('Host', host);
      expect(reply.status, p).toBe(403);
      expect(reply.text, p).not.toContain(code);
      expect(reply.text, p).not.toContain(store.dir);
    }
    for (const [method, p] of [['post', '/api/extension/pairings/code'], ['delete', '/api/extension/pairings/code']] as const) {
      expect((await at()[method](p).set('Host', host)).status, `${method} ${p}`).toBe(403);
      expect((await at()[method](p).set('Host', host).set('Origin', EXT)).status, `${method} ${p} with Origin`).toBe(403);
    }
    const health = await at().get('/health').set('Host', host).expect(200);
    expect(health.body).toMatchObject({ ok: true, paired: false });
    expect(health.body).not.toHaveProperty('dataDir');
    expect(health.body).not.toHaveProperty('ai');
    // The code is still the one showing: nothing above touched it.
    expect((await at().get('/api/extension/pairings').set('Host', host).set(editor).expect(200)).body.code.code).toBe(code);
  });

  it('serves the editor there: its page, its files, the save and the code', async () => {
    expect((await at().get('/').set('Host', host).set('Accept', 'text/html').expect(200)).text).toMatch(/<html/i);
    await at().get('/app.js').set('Host', host).set('Origin', `http://${host}`).set(editor).expect(200);
    await at().get('/vendor/marked.js').set('Host', host).set('Origin', `http://${host}`).set(editor).expect(200);
    expect((await at().get('/api/store').set('Host', host).set(editor).expect(200)).body).toHaveProperty('profile');
    expect((await at().get('/health').set('Host', host).set(editor).expect(200)).body.dataDir).toBe(store.dir);
    const made = await at().post('/api/extension/pairings/code').set('Host', host).set('Origin', `http://${host}`).set(editor).expect(200);
    const shown = await at().get('/api/extension/pairings').set('Host', host).set(editor).expect(200);
    expect(shown.body.code.code).toBe(made.body.code);
    await at().put('/api/config').set('Host', host).set('Origin', `http://${host}`).set(editor).send({ ai: { enabled: false } }).expect(200);
  });

  it('answers a paired extension there by its token', async () => {
    const code = (await at().post('/api/extension/pairings/code').set('Host', host).set('Origin', `http://${host}`).set(editor).expect(200)).body.code as string;
    const { token } = (await at().post('/api/extension/pair').set('Host', host).set('Origin', EXT).send({ code }).expect(200)).body as { token: string };
    await at().get('/api/store').set('Host', host).set('X-RMM-Pair', token).expect(200);
    // And still not the pairing routes.
    await at().get('/api/extension/pairings').set('Host', host).set('X-RMM-Pair', token).expect(403);
  });

  it('leaves the CLI alone on loopback', async () => {
    const local = `127.0.0.1:${server.port}`;
    await at().get('/api/store').set('Host', local).expect(200);
    expect((await at().get('/health').set('Host', local).expect(200)).body.dataDir).toBe(store.dir);
    await at().get('/api/extension/pairings').set('Host', local).expect(200);
  });
});

describe('a pairing code', () => {
  it('runs out', () => {
    let now = 1_000_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-pairing-'));
    try {
      const pairings = new Pairings(path.join(dir, 'extensions.json'), () => now);
      const { code } = pairings.newCode();
      now += CODE_LIFETIME_MS + 1;
      const late = pairings.pair(EXT, code);
      expect(late).toMatchObject({ ok: false, kind: 'no-code' });
      expect(pairings.currentCode()).toBeNull();
      // A new one works.
      const fresh = pairings.newCode();
      expect(pairings.pair(EXT, fresh.code)).toMatchObject({ ok: true, origin: EXT });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is eight characters nobody misreads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-pairing-'));
    try {
      const pairings = new Pairings(path.join(dir, 'extensions.json'));
      for (let i = 0; i < 50; i++) expect(pairings.newCode().code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(normaliseCode(' ab12-cd34 ')).toBe('AB12CD34');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
