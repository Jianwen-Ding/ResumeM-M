import { describe, expect, it } from 'vitest';
import { startServer } from '../src/server/index.js';
import { FRAME_ANCESTORS } from '../src/server/guard.js';
import { makeTempStore } from './helpers.js';

/*
 * Who may frame the editor.
 *
 * The server is on loopback with no password, so a frame of it opens already
 * signed in to the whole save. With no `frame-ancestors` any page on the web
 * could load it invisibly over a button of its own and have the click land on
 * "Delete variation". The browser extension shows the editor in a side panel,
 * which is an extension page, so that — and the editor framing itself — is
 * what stays allowed.
 *
 * Checked on the replies a browser actually frames: the editor's page, its
 * files, the API, and the upload-folder page, which sets a policy of its own
 * and so would silently drop a rule set only on the shared one.
 */
describe('framing', () => {
  const allowed = (policy: string | null) => {
    const rule = (policy ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('frame-ancestors'));
    return rule?.split(/\s+/).slice(1) ?? null;
  };

  it('lets only the editor itself and extension pages put it in a frame', async () => {
    const store = makeTempStore();
    const server = await startServer({ port: 0, dataDir: store.dir });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      for (const path of ['/', '/style.css', '/app.js', '/health', '/api/store', '/current']) {
        const reply = await fetch(`${base}${path}`);
        const sources = allowed(reply.headers.get('content-security-policy'));
        expect(sources, path).toEqual(["'self'", 'chrome-extension:']);
      }
    } finally {
      await server.close();
      store.cleanup();
    }
  });

  it('names no web origin, wildcard or scheme that an ordinary page could match', () => {
    const sources = allowed(FRAME_ANCESTORS) ?? [];
    for (const source of sources) {
      expect(source).not.toMatch(/^\*|^https?:|^\*\.|^data:|^blob:/);
    }
  });
});
