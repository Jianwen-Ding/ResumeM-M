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
    origin?: string; token?: string; method?: string; body?: unknown;
  } = {}) =>
    fetch(`${base}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'cors',
        ...(origin ? { Origin: origin } : {}),
        ...(token ? { 'X-RMM-Pair': token } : {}),
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

  it('forgets a code after five wrong tries', async () => {
    const code = await makeCode();
    for (let i = 1; i <= 5; i++) {
      const reply = await asExtension('/api/extension/pair', { method: 'POST', body: { code: 'WRONGONE' } });
      expect(reply.status).toBe(403);
      expect(((await reply.json()) as { triesLeft: number }).triesLeft).toBe(5 - i);
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
