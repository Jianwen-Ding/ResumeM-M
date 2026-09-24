import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Repo, cloneRepo } from '../git/repo.js';
import { findProjectRoot, resolveStoreDir, seedStore } from '../model/location.js';
import { Store } from '../model/store.js';
import { currentIgnore } from '../model/current.js';
import { createApi, createPdfRouter, createCurrentRouter } from './api.js';
import { closeStaleApplying, sweepTemporary } from './sweep.js';
import { cloneProject, prepareProject, readProjects, rememberProject, setDefaultFolder, projectsFile } from '../model/projects.js';
import { Assets } from '../ingest/assets.js';
import { assetsApi } from './assets.js';
import { Jobs } from './jobs.js';
import { localOnly, scriptPolicy } from './guard.js';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = findProjectRoot(here);
const require = createRequire(import.meta.url);

export interface ServerOptions {
  port?: number;
  dataDir?: string;
  preferencesFile?: string;
  /** Desktop launches offer dataDir as a suggestion until a project is selected. */
  requireProjectSelection?: boolean;
  host?: string;
}

/** The folder back, but only if a save is actually sitting in it. */
const isSave = (dir: string) =>
  fs.existsSync(path.join(dir, 'profile.yaml')) && fs.existsSync(path.join(dir, 'config.yaml'));

const existingStore = (dir: string): string | undefined => (isSave(dir) ? dir : undefined);

function projectSession(store: Store) {
  const repo = Repo.forStore(store.root, () => currentIgnore(store));
  const assets = new Assets(store, repo);
  const jobs = new Jobs();

  /*
   * Bring the save up to date, and take away what is done with, on the way
   * in. Both once per opened save rather than on a timer: a server left
   * running for a week should not delete something under the person using it
   * at the moment the clock happens to tick over.
   *
   * Not awaited, and not allowed to stop the save opening. A migration or a
   * sweep that cannot write — a read-only folder, a git lock left behind by
   * something else — is a thing to say out loud and carry on from, because
   * the alternative is a save that will not open for a reason that has
   * nothing to do with what is in it.
   */
  void openSave(store, repo).catch((err) => {
    console.warn(`ResumeM-M: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { store, assets, jobs, api: createApi({ store, repo, jobs }), assetsApi: assetsApi(assets), pdf: createPdfRouter(store), current: createCurrentRouter(store) };
}

/**
 * The two housekeeping passes a save gets when it is opened.
 *
 * In this order, and the order matters: the sweep reads tiers, and a save
 * written before tiers existed has none until the migration has given it
 * them — so sweeping first would find nothing and sweeping second finds
 * nothing either, because the migration starts every clock from now. Which
 * is the point. A save upgraded today loses nothing tonight.
 */
async function openSave(store: Store, repo: Repo): Promise<void> {
  const { flattened, tiered, lifted, problems } = store.migrateResumes();
  for (const problem of problems) console.warn(`ResumeM-M: ${problem}`);
  if (flattened.length > 0) {
    console.log(`ResumeM-M: folded ${flattened.length} resume(s) that recorded a base into themselves.`);
  }
  if (tiered.length > 0) {
    console.log(`ResumeM-M: sorted ${tiered.length} resume(s) into base, kept and temporary.`);
  }
  if (lifted.length > 0) {
    console.log(
      `ResumeM-M: moved ${lifted.join(', ')} up to the save, since every resume agreed on ` +
        'them. Changing them in Settings now changes all of them.',
    );
  }

  /*
   * Before the sweep, and before anything is served: a space still pointing
   * at the old name would tailor from its own last copy. See
   * `migrateTailoredIds`.
   */
  const { renamed } = store.migrateTailoredIds();
  if (renamed.length > 0) {
    console.log(
      `ResumeM-M: renamed ${renamed.length} tailored resume(s) so two postings cannot share one — ` +
        `${renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}.`,
    );
  }

  /*
   * Before the sweep: a close starts the resume's week, and the sweep counts
   * that week from the close — so this cannot take a resume tonight, only
   * start its clock.
   */
  const closed = await closeStaleApplying(store, repo);
  if (closed.length > 0) {
    console.log(
      `ResumeM-M: closed ${closed.length} application(s) left at Applying with nothing done — ` +
        `${closed.map((a) => `${a.company} (${a.role})`).join(', ')}. Set one back in the tracker if it is still live.`,
    );
  }

  const { swept, held } = await sweepTemporary(store, repo);
  if (swept.length > 0) {
    console.log(
      `ResumeM-M: swept ${swept.length} temporary resume(s) — ${swept.map((d) => d.label).join(', ')}. ` +
        'They are in the version history.',
    );
  }
  if (held.length > 0) {
    // Said as a warning because it is one: the save history is not working,
    // and the sweep is the least of what that costs.
    console.warn(
      `ResumeM-M: kept ${held.length} temporary resume(s) that were due — ${held
        .map((d) => d.label)
        .join(', ')}. The version history does not have them, so removing them ` +
        'could not have been undone. Save the store and they will go next time.',
    );
  }
}

export async function startServer(opts: ServerOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 4600);
  const host = opts.host ?? '127.0.0.1';
  const preferencesFile = opts.preferencesFile ?? projectsFile();
  const preferences = readProjects(preferencesFile);
  const fallback = opts.dataDir ?? resolveStoreDir(projectRoot);
  const explicit = !opts.requireProjectSelection && (opts.dataDir ?? process.env.RMM_DATA);
  /*
   * Which save to open without being asked.
   *
   * A default chosen in the app wins, and choosing "Ask Me on Startup" stores
   * that as null — which means the chooser, and must stay meaning the chooser.
   * An older install has no such key and is answered by the save it last had
   * open.
   *
   * Failing all of those, the save at the app's own default location, when
   * there is already one there. That case is not hypothetical: it is every
   * install that predates saves being something you pick, where the store sits
   * exactly where the app has always put it and nothing has ever been written
   * down about it. Starting those with no save open — a server running, an
   * editor with nothing in it, and an extension that cannot answer — is worse
   * than opening the only save on the machine.
   *
   * It is `existingStore`, not `fallback`, deliberately: a folder that is not
   * already a save is left to the chooser rather than created here. Seeding is
   * for an explicit choice, and quietly conjuring an example store is how
   * somebody ends up applying with a resume they did not write.
   */
  const startupFolder = Object.hasOwn(preferences, 'defaultFolder')
    ? preferences.defaultFolder
    : (preferences.active ?? existingStore(fallback));
  const initial = explicit || startupFolder;
  let active: ReturnType<typeof projectSession> | undefined;
  let openedBy: 'launch' | 'restored' | 'selected' | undefined;
  let startupError: string | undefined;
  if (initial) {
    try {
      if (explicit) seedStore(path.join(projectRoot, 'data'), initial);
      // Missing or invalid remembered folders return to the chooser, never seed example data.
      if (!isSave(initial)) {
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

  /*
   * Who is allowed to call this.
   *
   * It answered `*`, which on a server with no password means every page you
   * visit can read your whole resume store and write to it. That was how a
   * traversal in an id turned into a page being able to set `ai.command` — the
   * command this application runs.
   *
   * The extension is why the header exists at all, and it asks for
   * `host_permissions` on loopback, so Chrome exempts it from CORS regardless.
   * Echoing its origin is belt and braces for an install that has not been
   * granted them; every other origin gets no header, which is what stops an
   * ordinary web page from reaching in. The editor is served from here, so it
   * is same-origin and needs nothing.
   */
  const mayCall = (origin: string | undefined) => /^chrome-extension:\/\/[a-p]+$/.test(origin ?? '');

  // Before anything else: the `Host` check that makes DNS rebinding fail, and
  // the `Origin` check that catches writes CORS never got to preflight.
  app.use(
    localOnly({
      host,
      allowHosts: (process.env.RMM_ALLOWED_HOSTS ?? '').split(',').filter(Boolean),
    }),
  );

  /*
   * Read once: the page is a file in the build, and a policy that disagreed
   * with it would stop the editor loading at all. See `scriptPolicy`.
   */
  const editorPage = path.join(projectRoot, 'web', 'index.html');
  const policy = scriptPolicy(
    fs.existsSync(editorPage) ? fs.readFileSync(editorPage, 'utf8') : '',
    (text) => createHash('sha256').update(text).digest('base64'),
  );
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (mayCall(origin)) res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-RMM-Project');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  /*
   * `build` is a fingerprint of the code that is running, not a version
   * number anyone sets.
   *
   * A server keeps serving whatever it loaded at start: `tsx` compiles once,
   * and `dist/` is a snapshot. So a process left running from this morning
   * answers requests the way this morning's code did, and there is nothing
   * about it from the outside that says so. That cost an hour: a test suite
   * failed on a feature that worked, because one server in its pool predated
   * the feature.
   *
   * The mtime of the newest source file the server could be running is enough
   * to tell two builds apart, and costs one stat per request on a handful of
   * files. Anything cleverer would need a build step to maintain.
   */
  const stampNow = () => {
    const roots = [path.join(projectRoot, 'dist', 'src'), path.join(projectRoot, 'src'), path.join(projectRoot, 'web')];
    let newest = 0;
    const walk = (dir: string, depth = 0) => {
      if (depth > 4 || !fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full, depth + 1);
        else newest = Math.max(newest, stat.mtimeMs);
      }
    };
    for (const root of roots) walk(root);
    return String(Math.round(newest));
  };
  const buildStamp = stampNow();

  /*
   * Comparing servers to each other catches one stale process among several.
   * It cannot catch all of them being stale together, which is what happens
   * the moment the code is edited while they are running — and that is the
   * ordinary case during development, not the exotic one.
   *
   * So `?fresh` re-reads the files and says whether anything has been written
   * since this process started. It is behind a flag because `/health` is
   * polled, and walking three trees on every poll to answer a question only a
   * test runner asks is a poor trade.
   */
  app.get('/health', (req, res) => {
    const ai = active?.store.loadConfig().ai;
    const fresh = req.query.fresh !== undefined ? stampNow() : undefined;
    /*
     * The output folder as well as the save.
     *
     * Two saves side by side — `~/resumes/personal` and `~/resumes/work` —
     * resolve `out` to the same place, because it is a sibling of the save
     * rather than part of it. They then share `out/current`, whose manifest
     * says which files it put there, and each one tidies away the other's.
     * Nothing in a single server can see that; a caller running several can,
     * and the test pool does exactly this.
     */
    res.json({ ok: true, service: 'resumem-m', build: buildStamp, dataDir: active?.store.root ?? null,
      outDir: active?.store.outDir() ?? null,
      ...(fresh === undefined ? {} : { onDisk: fresh, stale: fresh !== buildStamp }),
      projectOpen: Boolean(active), ai: { enabled: ai?.enabled ?? false, command: ai?.command ?? '', configured: Boolean(ai?.command?.trim()) } });
  });

  app.use('/api', express.json({ limit: '32mb' }));
  app.get('/api/projects', (_req, res) => {
    const stored = readProjects(preferencesFile);
    const existing = [...(stored.defaultFolder ? [stored.defaultFolder] : []), fallback, ...stored.recent].filter(isSave);
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
  /*
   * A write meant for a save that is no longer open.
   *
   * This has always guarded the editor, whose two windows can disagree about
   * which save is open. The browser extension never sent the header, and it
   * is the caller that most needs it: an application takes pages and minutes
   * to write, and the editor can be pointed at another save meanwhile. Filing
   * it then wrote the application into whichever save happened to be open,
   * saved its tailored resume there, and typeset the PDFs from that save's
   * profile and wordings — a 200, files that were not the ones on screen, and
   * a row in somebody else's tracker. `/extension/analyze` hands the save
   * back now, and the extension says which one it means.
   *
   * So the refusal names both, because by this point the two readers of it
   * are a window that should reload and an application that should be filed
   * somewhere else.
   */
  app.use('/api', (req, res, next) => {
    const meant = req.headers['x-rmm-project'];
    if (typeof meant === 'string' && meant && meant !== active?.store.root) {
      res.status(409).json({
        kind: 'other-save',
        save: active?.store.root ?? null,
        error: active
          ? `ResumeM-M has "${path.basename(active.store.root)}" open now, and this was written against ` +
            `"${path.basename(meant)}". Reload the editor, or open that save again, before saving.`
          : `No save is open in ResumeM-M. This was written against "${path.basename(meant)}" — open it again before saving.`,
      });
      return;
    }
    if (switching) { res.status(409).json({ error: 'The save is changing. Try again in a moment.' }); return; }
    next();
  });
  const busy = () => requests || active?.assets.busy || active?.jobs.list().some(j => j.status === 'running');
  app.post('/api/projects/switch', async (req, res) => {
    if (busy()) { res.status(409).json({ error: 'Wait for current saves, imports, and AI work to finish before changing saves.' }); return; }
    switching = true;
    try {
      const { dir, mode, url } = req.body;
      if (typeof dir !== 'string' || !['open', 'create', 'move', 'clone'].includes(mode)) {
        throw new Error('Choose Open, Create, Move or Clone, and a folder');
      }
      /*
       * Cloning is its own path because it is the only one that reaches the
       * network, takes an unbounded amount of time, and can fail for reasons
       * that are nothing to do with the folder. It ends in the same place:
       * a validated store that becomes the open save.
       */
      const next = projectSession(
        mode === 'clone'
          ? await cloneProject(String(url ?? ''), dir, cloneRepo)
          : prepareProject(active?.store, dir, mode),
      );
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
  /*
   * The flat folder as a page, so "where are the files" has an answer you can
   * click from a job board rather than only a path you can paste.
   */
  app.use('/current', (req, res, next) => {
    if (!active) { res.status(409).type('html').send('<p>No save is open in ResumeM-M.</p>'); return; }
    active.current(req, res, next);
  });
  app.get('/vendor/marked.js', (_req, res) => res.sendFile(require.resolve('marked')));
  app.get('/vendor/purify.mjs', (_req, res) => res.sendFile(path.join(path.dirname(require.resolve('dompurify')), 'purify.es.mjs')));
  /*
   * And say so if they are not there.
   *
   * A missing `web/` is not a missing file, it is a missing product: the API
   * answers everything, the editor is a 404, and nothing in between says
   * which of the two you have. That state shipped once already — see
   * `findProjectRoot` — and the only reason it was ever noticed is that
   * somebody pointed a browser at a built server. One line at startup is
   * cheaper than that.
   */
  const webRoot = path.join(projectRoot, 'web');
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
    console.warn(
      `ResumeM-M: no editor found at ${webRoot}. The API will answer and every page will 404. ` +
        `This usually means the server is running from a build that did not carry web/ with it.`,
    );
  }
  app.use(express.static(webRoot));

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
