import { describe, expect, it } from 'vitest';
import { startServer } from '../src/server/index.js';
import { makeTempStore } from './helpers.js';

describe('local desktop server', () => {
  it('reports its identity and store, serves the editor, and rejects a port collision', async () => {
    const store = makeTempStore();
    const server = await startServer({ port: 0, dataDir: store.dir });
    try {
      expect(server.port).toBeGreaterThan(0);
      const base = `http://127.0.0.1:${server.port}`;
      const health = await fetch(`${base}/health`).then((response) => response.json());
      expect(health).toMatchObject({ ok: true, service: 'resumem-m', dataDir: store.dir });
      const page = await fetch(base).then((response) => response.text());
      expect(page).toContain('<title>ResumeM-M</title>');
      await expect(startServer({ port: server.port, dataDir: store.dir })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await server.close();
      store.cleanup();
    }
  });
});
