import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { format } from 'node:util';
import { KEEP_EVENTS, logServerEvent, serverLog, windowMinutes } from '../errorlog/buffer.js';
import { ErrorLog, ErrorLogInputError, MAX_SCREENSHOT_BYTES, MAX_SCREENSHOTS, appVersion, type EntrySource } from '../errorlog/log.js';
import { mergeEvents } from '../errorlog/scrub.js';

/**
 * The error log, as the server keeps it and serves it.
 *
 * Two halves. The first is the server noticing what goes wrong, as it
 * happens, into its buffer (`serverLog`): what it says on its console, and
 * every request that failed or was slow. The rest — a failed push, a compile
 * that would not finish, an AI run that failed — is noted where it happens,
 * with `logServerEvent`.
 *
 * The second is `/api/error-log`, where an entry is written: from the
 * editor's dialog, from JobHelper's popup, and read by `rmm log` for the
 * server's buffer. Mounted before the "no save open" gate and the "other
 * save" check, because an error is worth logging whichever save is open, and
 * most of all when none will open. Not before pairing: an extension has to be
 * paired to log, as it does for everything else but the bug-report inbox.
 */

let consoleCaptured = false;

/**
 * The server's console, kept as well as printed.
 *
 * Every warning the server has ever printed was printed for somebody to read,
 * and nobody reads the console of a server started by the Mac app or left
 * running in a terminal tab. Once, however many servers a process starts:
 * the tests start dozens.
 */
export function captureConsole(): void {
  if (consoleCaptured) return;
  consoleCaptured = true;
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        logServerEvent('console', format(...args), level);
      } catch {
        // Never a reason for a warning not to be printed.
      }
    };
  }
}

/** How long a request may take before it is worth a line of its own. */
export const SLOW_MS = 3_000;

/**
 * Every request that failed or took a long time: method, path (never the
 * query, which is where a sign-in code or a token would be), status, what
 * the reply's `error` said, and how long it took. What was sent in the body
 * is not looked at at all.
 */
export function requestLog(): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    const json = res.json.bind(res);
    res.json = (body?: unknown) => {
      if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        res.locals.errorSaid = (body as { error: string }).error;
      }
      return json(body);
    };
    res.once('finish', () => {
      const ms = Math.round(performance.now() - started);
      const status = res.statusCode;
      if (status < 400 && ms <= SLOW_MS) return;
      const route = (req.originalUrl || req.url).split(/[?#]/)[0]!;
      const said = typeof res.locals.errorSaid === 'string' ? `: ${res.locals.errorSaid.slice(0, 500)}` : '';
      logServerEvent(
        'request',
        `${req.method} ${route} → ${status}${said} (${ms} ms)`,
        status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        { method: req.method, route, status, ms, ...(status < 400 ? { slow: true } : {}) },
      );
    });
    next();
  };
}

export interface ErrorLogApiOptions {
  /** The error log, asked for each request so a test can point it elsewhere. */
  log: () => ErrorLog;
  /** The server's build stamp, as `/health` gives it. */
  build: string;
  /** The save open now, by its folder; null when none is. */
  save: () => string | null;
}

/** An entry's `at`, when a queued entry says when it was logged: a real time, not in the future, not over a week old. */
function loggedAt(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const at = new Date(value);
  const now = Date.now();
  if (!Number.isFinite(at.getTime()) || at.getTime() > now + 60_000 || at.getTime() < now - 7 * 24 * 60 * 60 * 1000) return undefined;
  return at;
}

/*
 * The most an entry may be as sent, ahead of the server's 32 MB limit: as
 * many screenshots as an entry may have, base64 and all (8 MB is 10.7 as
 * text), and the most logs a part keeps — two thousand events of up to two
 * thousand characters, with their time, kind and detail, 3 KB each at most —
 * and room for the rest. 16.6 MB. It was 12 MB, which refused an entry with
 * 8 MB of screenshots and a busy fifteen minutes (14.7 MB) and said to keep
 * the screenshots to 8 MB, which they were.
 */
export const ENTRY_LIMIT = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + MAX_SCREENSHOTS * 64 + KEEP_EVENTS * 3 * 1024 + 64 * 1024;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function errorLogApi({ log, build, save }: ErrorLogApiOptions): express.Router {
  const api = express.Router();
  api.use(express.json({ limit: ENTRY_LIMIT }));

  const handle =
    (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
      fn(req, res).catch(next);
    };

  /** The server's buffer for the last `minutes`, scrubbed — what `rmm log` asks for. */
  api.get('/recent', (req, res) => {
    const minutes = windowMinutes(req.query.minutes);
    const until = new Date();
    res.json({ dir: log().root, minutes, events: mergeEvents([{ events: serverLog.since(minutes) }], { until, minutes }) });
  });

  api.get(
    '/',
    handle(async (req, res) => {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      // From `offset` on, newest first; `total` is every entry, so a list can say "10 of 37".
      const offset = Math.max(0, Math.floor(Number(req.query.offset)) || 0);
      res.json({ dir: log().root, entries: await log().list(limit, offset), offset, total: log().count() });
    }),
  );

  api.get(
    '/status',
    handle(async (_req, res) => {
      res.json(await log().status());
    }),
  );

  api.post(
    '/',
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const extension = res.locals.extension as { paired: boolean } | undefined;
      /*
       * Who logged it is who sent it, as far as that can be told: an
       * extension says so in its origin, which a page cannot write. The
       * editor and the CLI both come from this machine, and say which.
       */
      const source: EntrySource = extension ? 'JobHelper' : body.source === 'CLI' ? 'CLI' : body.source === 'automatic' ? 'automatic' : 'editor';
      const minutes = windowMinutes(body.minutes);
      const at = loggedAt(body.at) ?? new Date();
      const theirs = Array.isArray(body.events) ? body.events.slice(-5000) : [];
      const page = extension && body.page && typeof body.page === 'object' ? (body.page as { url?: unknown; title?: unknown }) : undefined;
      const result = await log().add({
        description: typeof body.description === 'string' ? body.description : '',
        source,
        minutes,
        at,
        logs: [
          { events: serverLog.since(30) },
          { events: theirs, source: source === 'JobHelper' ? 'jobhelper' : source === 'CLI' ? 'cli' : 'editor' },
        ],
        screenshots: Array.isArray(body.screenshots) ? body.screenshots : [],
        page,
        versions: {
          serverBuild: build,
          appVersion: appVersion(),
          extensionBuild: extension ? body.extensionBuild : undefined,
          extensionVersion: extension ? body.extensionVersion : undefined,
        },
        save: save(),
        resumeId: body.resumeId,
        applicationId: body.applicationId,
      });
      if (!result.committed) logServerEvent('commit', `An error-log entry was written but not committed: ${result.commitError ?? 'nothing to commit'}`);
      res.status(201).json({
        ...result,
        dir: log().root,
        message: result.committed
          ? 'Logged to the error log (not pushed yet).'
          : `Written to the error log, but not committed: ${result.commitError ?? 'git had nothing to commit'}.`,
      });
    }),
  );

  api.put(
    '/remote',
    handle(async (req, res) => {
      const url = typeof req.body?.url === 'string' ? req.body.url : '';
      res.json(await log().setRemote(url));
    }),
  );

  /* Answered 200 whatever happened, as the save's Push and Pull are: a refusal is news to read. */
  api.post(
    '/push',
    handle(async (_req, res) => {
      const result = await log().push();
      if (!result.ok) logServerEvent('push', `Pushing the error log failed: ${result.output}`);
      res.json(result);
    }),
  );

  api.post(
    '/pull',
    handle(async (_req, res) => {
      const result = await log().pull();
      if (!result.ok) logServerEvent('pull', `Pulling the error log failed: ${result.message}`);
      res.json(result);
    }),
  );

  // Said as JSON, so the dialog and the popup can show it: too large, unreadable, refused.
  api.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const e = err as { type?: string; name?: string; message?: string };
    if (e?.type === 'entity.too.large') {
      /*
       * Said as what is too large, as far as the body says: its size and the
       * limit. The screenshots are checked once it is read (8 MB together,
       * said by `ErrorLog.add`), so past this limit it is the two together —
       * or the logs sent with them, which a client can send again without.
       */
      const size = typeof (e as { length?: unknown }).length === 'number' ? (e as { length: number }).length : undefined;
      res.status(413).json({
        error:
          `That entry is too large to log${size ? ` (${mb(size)})` : ''}: an entry may be ${mb(ENTRY_LIMIT)} as sent, ` +
          `screenshots (8 MB together) and automatic logs included. Log it with fewer minutes of logs, or fewer screenshots.`,
      });
    } else if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'The entry was not readable JSON.' });
    } else if (err instanceof ErrorLogInputError || e?.name === 'RemoteUrlError') {
      res.status(400).json({ error: (err as Error).message });
    } else if (e?.name === 'SaveBusyError') {
      res.status(409).json({ error: e.message });
    } else {
      res.status(500).json({ error: e?.message ?? String(err) });
    }
  });
  return api;
}
