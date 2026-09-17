import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  /*
   * A server serves whatever it loaded at start, and there is nothing about it
   * from the outside that says so — which is how a test suite came to fail for
   * sixty seconds against a build from that morning. `?fresh` re-reads the
   * files and answers the only question that matters: am I still the code?
   */
  it('says whether it is still running the code that is on disk', async () => {
    const store = makeTempStore();
    const server = await startServer({ port: 0, dataDir: store.dir });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const quiet = await fetch(`${base}/health`).then((r) => r.json());
      // Not on every poll: walking three trees to answer a question only a
      // test runner asks would be paid for by the extension, which polls this.
      expect(quiet.stale).toBeUndefined();

      const asked = await fetch(`${base}/health?fresh`).then((r) => r.json());
      expect(asked.stale).toBe(false);
      expect(asked.onDisk).toBe(asked.build);

      /*
       * A new file under a watched tree, rather than touching a real one: the
       * stamp is the newest file mtime, so removing the probe puts it back
       * exactly, and nothing a parallel run is reading changes underneath it.
       */
      const probe = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'web', '.build-probe');
      fs.writeFileSync(probe, '');
      fs.utimesSync(probe, new Date(), new Date(Date.now() + 60_000));
      try {
        const after = await fetch(`${base}/health?fresh`).then((r) => r.json());
        expect(after.stale).toBe(true);
        expect(after.build).toBe(asked.build);
        expect(Number(after.onDisk)).toBeGreaterThan(Number(after.build));
      } finally {
        fs.rmSync(probe, { force: true });
      }
      // And back again, once the probe is gone.
      expect((await fetch(`${base}/health?fresh`).then((r) => r.json())).stale).toBe(false);
    } finally {
      await server.close();
      store.cleanup();
    }
  });
});

/*
 * Which save is open when nobody has said.
 *
 * Saves became something you pick, and the resolution order has to answer four
 * different people at once: somebody who chose a default, somebody who asked to
 * be prompted, somebody upgrading from before any of this existed, and somebody
 * whose machine has nothing on it at all. Getting the third wrong leaves a
 * server running with an empty editor and an extension that cannot answer,
 * beside a save sitting exactly where the app has always kept it.
 */
describe('choosing a save at startup', () => {
  const withPreferences = (contents?: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-prefs-'));
    const file = path.join(dir, 'projects.json');
    if (contents !== undefined) fs.writeFileSync(file, JSON.stringify(contents), 'utf8');
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };

  /** Started the way the resolution order runs, with no environment override. */
  const start = async (preferencesFile: string, dataDir: string) => {
    const previous = process.env.RMM_DATA;
    delete process.env.RMM_DATA;
    try {
      return await startServer({ port: 0, preferencesFile, dataDir, requireProjectSelection: true });
    } finally {
      if (previous !== undefined) process.env.RMM_DATA = previous;
    }
  };

  const openSave = async (server: { port: number }) =>
    (await fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.json())).dataDir;

  it('opens the save already at the default location when nothing has been recorded', async () => {
    const store = makeTempStore();
    const prefs = withPreferences();
    const server = await start(prefs.file, store.dir);
    try {
      expect(await openSave(server)).toBe(store.dir);
    } finally {
      await server.close();
      prefs.cleanup();
      store.cleanup();
    }
  });

  it('honours a default chosen in the app over that', async () => {
    const chosen = makeTempStore();
    const other = makeTempStore();
    const prefs = withPreferences({ defaultFolder: chosen.dir, recent: [] });
    const server = await start(prefs.file, other.dir);
    try {
      expect(await openSave(server)).toBe(chosen.dir);
    } finally {
      await server.close();
      prefs.cleanup();
      chosen.cleanup();
      other.cleanup();
    }
  });

  it('still shows the chooser when the app was told to ask every time', async () => {
    // `null` is the recorded answer to "Ask Me on Startup", and it has to keep
    // meaning that even though a perfectly good save is sitting right there.
    const store = makeTempStore();
    const prefs = withPreferences({ defaultFolder: null, recent: [] });
    const server = await start(prefs.file, store.dir);
    try {
      expect(await openSave(server)).toBeNull();
    } finally {
      await server.close();
      prefs.cleanup();
      store.cleanup();
    }
  });

  it('falls back to the save last open, for an install from before defaults existed', async () => {
    const last = makeTempStore();
    const other = makeTempStore();
    const prefs = withPreferences({ active: last.dir, recent: [last.dir] });
    const server = await start(prefs.file, other.dir);
    try {
      expect(await openSave(server)).toBe(last.dir);
    } finally {
      await server.close();
      prefs.cleanup();
      last.cleanup();
      other.cleanup();
    }
  });

  it('opens nothing, and creates nothing, when there is no save to open', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-nothing-'));
    const prefs = withPreferences();
    const server = await start(prefs.file, empty);
    try {
      expect(await openSave(server)).toBeNull();
      // The chooser, not a store conjured out of the bundled example.
      expect(fs.readdirSync(empty)).toEqual([]);
    } finally {
      await server.close();
      prefs.cleanup();
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
