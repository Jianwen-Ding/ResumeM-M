import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repo } from '../git/repo.js';
import { resolveStoreDir, seedStore } from '../model/location.js';
import { Store } from '../model/store.js';
import { createApi, createPdfRouter } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

export interface ServerOptions {
  port?: number;
  dataDir?: string;
  /** Bind address. Local-only by default; this server has no auth. */
  host?: string;
}

export async function startServer(opts: ServerOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 4600);
  const host = opts.host ?? '127.0.0.1';
  const dataDir = opts.dataDir ?? resolveStoreDir(projectRoot);
  // A fresh store starts as a copy of the bundled example, so the app is
  // usable on first run without anyone hand-writing YAML.
  if (seedStore(path.join(projectRoot, 'data'), dataDir)) {
    console.log(`Created a new store at ${dataDir} from the bundled example.`);
  }

  const store = new Store(dataDir);
  // The store may be its own repo or sit inside a larger one; either works,
  // and auto-commits are scoped to the store either way.
  const repo = Repo.forStore(dataDir);

  const app = express();

  /**
   * The extension runs on arbitrary job sites and calls in from a
   * `chrome-extension://` origin, so CORS has to be open. That is safe only
   * because the server binds to loopback — do not change the host without
   * adding authentication.
   */
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    // The AI state belongs here: the extension has its own "use the AI" switch,
    // and without knowing this one it cannot tell the user whether anything
    // will actually happen when they flip it. Read per request, so toggling it
    // in the GUI is reflected without a restart.
    const ai = store.loadConfig().ai;
    res.json({
      ok: true,
      service: 'resumem-m',
      dataDir,
      ai: { enabled: ai.enabled, command: ai.command },
    });
  });

  app.use('/api', createApi({ store, repo }));
  app.use('/pdf', createPdfRouter(store));
  app.use(express.static(path.join(projectRoot, 'web')));

  return new Promise<{ close: () => Promise<void>; port: number }>((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`ResumeM-M → http://${host}:${port}`);
      console.log(`  store: ${dataDir}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

// Started directly rather than imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = resolveStoreDir(projectRoot);
  seedStore(path.join(projectRoot, 'data'), dir);
  // The store is its own repository, so its history is separate from the
  // application's and can be pushed somewhere private on its own.
  await Repo.forStore(dir).ensure();
  await startServer();
}
