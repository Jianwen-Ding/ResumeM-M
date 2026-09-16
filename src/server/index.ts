import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Repo } from '../git/repo.js';
import { resolveStoreDir, seedStore } from '../model/location.js';
import { Store } from '../model/store.js';
import { createApi, createPdfRouter } from './api.js';
import { prepareProject, readProjects, rememberProject, setDefaultFolder, projectsFile } from '../model/projects.js';
import { Assets } from '../ingest/assets.js';
import { assetsApi } from './assets.js';
import { Jobs } from './jobs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);

export interface ServerOptions {
  port?: number;
  dataDir?: string;
  preferencesFile?: string;
  /** Desktop launches offer dataDir as a suggestion until a project is selected. */
  requireProjectSelection?: boolean;
  host?: string;
}

function projectSession(store: Store) {
  const repo = Repo.forStore(store.root);
  const assets = new Assets(store, repo);
  const jobs = new Jobs();
  return { store, assets, jobs, api: createApi({ store, repo, jobs }), assetsApi: assetsApi(assets), pdf: createPdfRouter(store) };
}

export async function startServer(opts: ServerOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 4600);
  const host = opts.host ?? '127.0.0.1';
  const preferencesFile = opts.preferencesFile ?? projectsFile();
  const preferences = readProjects(preferencesFile);
  const fallback = opts.dataDir ?? resolveStoreDir(projectRoot);
  const explicit = !opts.requireProjectSelection && (opts.dataDir ?? process.env.RMM_DATA);
  const startupFolder = Object.hasOwn(preferences, 'defaultFolder') ? preferences.defaultFolder : preferences.active;
  const initial = explicit || startupFolder;
  let active: ReturnType<typeof projectSession> | undefined;
  let openedBy: 'launch' | 'restored' | 'selected' | undefined;
  let startupError: string | undefined;
  if (initial) {
    try {
      if (explicit) seedStore(path.join(projectRoot, 'data'), initial);
      // Missing or invalid remembered folders return to the chooser, never seed example data.
      if (!fs.existsSync(path.join(initial, 'profile.yaml')) || !fs.existsSync(path.join(initial, 'config.yaml'))) {
        throw new Error(`Save folder is unavailable: ${initial}. Choose another folder or create a save.`);
      }
      const store = new Store(initial);
      store.load();
      active = projectSession(store);
      openedBy = explicit ? 'launch' : 'restored';
    } catch (error) { startupError = (error as Error).message; }
  }

  const app = express();
  let requests = 0;
  let switching = false;
  const watcher = setInterval(() => {
    if (!switching && active) void active.assets.scan().catch(error => console.warn('[rmm] Inbox:', error.message));
  }, 5000);
  watcher.unref();

  // JobHelper calls from chrome-extension:// origins. Keep the server on loopback.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-RMM-Project');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  app.get('/health', (_req, res) => {
    const ai = active?.store.loadConfig().ai;
    res.json({ ok: true, service: 'resumem-m', dataDir: active?.store.root ?? null,
      projectOpen: Boolean(active), ai: { enabled: ai?.enabled ?? false, command: ai?.command ?? '', configured: Boolean(ai?.command?.trim()) } });
  });

  app.use('/api', express.json({ limit: '32mb' }));
  app.get('/api/projects', (_req, res) => {
    const stored = readProjects(preferencesFile);
    const existing = [...(stored.defaultFolder ? [stored.defaultFolder] : []), fallback, ...stored.recent].filter(dir => fs.existsSync(path.join(dir, 'profile.yaml')) && fs.existsSync(path.join(dir, 'config.yaml')));
    res.json({ recent: [...new Set(existing)], active: active?.store.root ?? null, current: active?.store.root ?? null,
      output: active?.store.outDir() ?? null, defaultFolder: Object.hasOwn(stored, 'defaultFolder') ? stored.defaultFolder : stored.active ?? null, openedBy: openedBy ?? null, startupError,
      suggested: !active && existing.includes(fallback) ? fallback : null,
      environmentOverride: Boolean(explicit) });
  });
  app.put('/api/projects/default', (req, res) => {
    try {
      const { dir } = req.body;
      if (dir !== null && typeof dir !== 'string') throw new Error('Choose a default save folder or Ask Me on Startup');
      setDefaultFolder(dir, preferencesFile);
      res.json({ defaultFolder: readProjects(preferencesFile).defaultFolder });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.use('/api', (req, res, next) => {
    if (req.headers['x-rmm-project'] && req.headers['x-rmm-project'] !== active?.store.root) {
      res.status(409).json({ error: 'The active save changed in another window. Reload before saving.' }); return;
    }
    if (switching) { res.status(409).json({ error: 'The save is changing. Try again in a moment.' }); return; }
    next();
  });
  const busy = () => requests || active?.assets.busy || active?.jobs.list().some(j => j.status === 'running');
  app.post('/api/projects/switch', async (req, res) => {
    if (busy()) { res.status(409).json({ error: 'Wait for current saves, imports, and AI work to finish before changing saves.' }); return; }
    switching = true;
    try {
      const { dir, mode } = req.body;
      if (typeof dir !== 'string' || !['open', 'create', 'move'].includes(mode)) throw new Error('Choose Open, Create, or Move and a folder');
      const next = projectSession(prepareProject(active?.store, dir, mode));
      rememberProject(next.store.root, preferencesFile, active?.store.root);
      active = next; openedBy = 'selected'; startupError = undefined;
      res.json({ dir: next.store.root, mode });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
    finally { switching = false; }
  });
  app.post('/api/projects/close', (_req, res) => {
    if (busy()) { res.status(409).json({ error: 'Wait for current saves, imports, and AI work to finish before closing the save.' }); return; }
    try {
      rememberProject(null, preferencesFile, active?.store.root);
      active = undefined; openedBy = undefined; startupError = undefined;
      res.json({ current: null });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.use('/api', (_req, res, next) => {
    if (!active) { res.status(409).json({ error: 'No Save Open. Open or create a save in Save & Files.', kind: 'no-project' }); return; }
    requests++;
    let finished = false;
    res.locals.finishProjectRequest = () => { if (!finished) { finished = true; requests--; } };
    res.once('finish', res.locals.finishProjectRequest);
    next();
  });
  app.use('/api/assets', (req, res, next) => active!.assetsApi(req, res, next));
  app.use('/api', (req, res, next) => active!.api(req, res, next));
  app.use('/pdf', (req, res, next) => {
    if (!active) { res.status(409).json({ error: 'No Save Open' }); return; }
    active.pdf(req, res, next);
  });
  app.get('/vendor/marked.js', (_req, res) => res.sendFile(require.resolve('marked')));
  app.get('/vendor/purify.mjs', (_req, res) => res.sendFile(path.join(path.dirname(require.resolve('dompurify')), 'purify.es.mjs')));
  app.use(express.static(path.join(projectRoot, 'web')));

  return new Promise<{ close: () => Promise<void>; port: number }>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      console.log(`ResumeM-M → http://${host}:${actualPort}`);
      console.log(active ? `  save: ${active.store.root}` : '  No Save Open');
      resolve({ port: actualPort, close: () => new Promise<void>(done => {
        clearInterval(watcher); server.close(() => done());
      }) });
    });
    server.once('error', error => { clearInterval(watcher); reject(error); });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await startServer();
}
