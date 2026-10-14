import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Repo, type PullResult, type RemoteStatus } from '../git/repo.js';
import { findProjectRoot } from '../model/location.js';
import { holdSaveForCommit } from '../model/save-lock.js';
import { DEFAULT_WINDOW, windowMinutes, type LogEvent } from './buffer.js';
import { decodeScreenshot, type Screenshot } from './screenshots.js';
import { mergeEvents, scrubUrl, withoutSecrets } from './scrub.js';

const run = promisify(execFile);

/**
 * The error log: a git repository of its own, apart from every save and from
 * the program's own checkout.
 *
 * An error is as likely to happen with no save open as with one — opening a
 * save is one of the things that goes wrong — and what it records (which
 * request failed, what the server said) is about the program, not about
 * anybody's resumes. So it is not kept in the save, and the save's history
 * never carries it. It works the way the save's history does, though,
 * because that is already understood: a local repository made on first use,
 * one commit per entry, and a remote that can be added and pushed to — the
 * same `Repo`, with the same commit queue, the same push timeout and token
 * masking, the same pull.
 *
 * Where it lives:
 *
 *   1. `RMM_ERROR_LOG_DIR`, when it is set;
 *   2. `dir` in `~/.resumem-m/error-log.json`, when that names one;
 *   3. `~/.resumem-m/error-log`.
 *
 * Its remote is the repository's own `origin`, in its own `.git/config`, so
 * nothing about it is in a save either; when it was last pushed is beside it
 * there (`rmm.lastPush`).
 *
 * The CLI and the server can both write entries at once, so every entry is
 * written and committed under the same cross-process lock a save uses (see
 * `SaveLock`), taken on this folder.
 */

/** Where the error log's own settings are, beside `extensions.json` and `projects.json`. */
export function errorLogSettingsFile(): string {
  return process.env.RMM_ERROR_LOG_SETTINGS || path.join(os.homedir(), '.resumem-m', 'error-log.json');
}

const expandHome = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

/** The folder the error log is in, by the order above. */
export function errorLogDir(): string {
  const fromEnv = process.env.RMM_ERROR_LOG_DIR?.trim();
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  try {
    const settings = JSON.parse(fs.readFileSync(errorLogSettingsFile(), 'utf8')) as { dir?: unknown };
    if (typeof settings.dir === 'string' && settings.dir.trim()) return path.resolve(expandHome(settings.dir.trim()));
  } catch {
    // No settings, or unreadable ones: the default, which is what having none means.
  }
  return path.join(os.homedir(), '.resumem-m', 'error-log');
}

/** Who logged an entry. Shown in the entry, and in the lists that show them. */
export type EntrySource = 'editor' | 'JobHelper' | 'CLI' | 'automatic' | 'bug report';
export const SOURCES: readonly EntrySource[] = ['editor', 'JobHelper', 'CLI', 'automatic', 'bug report'];

/** What an entry is made from. Everything but the description may be left out. */
export interface NewEntry {
  description: string;
  source: EntrySource;
  /** How many minutes of logs before it to include. See `windowMinutes`. */
  minutes?: number;
  /** When it was logged; now when left out. */
  at?: Date;
  /** Lists of events, each from one part; merged, scrubbed and cut to the window here. */
  logs?: { events: unknown[]; source?: string }[];
  /** Data URLs, checked here; see `decodeScreenshot`. */
  screenshots?: unknown[];
  /** The page it was logged from, when that was a page in the browser. */
  page?: { url?: unknown; title?: unknown };
  versions?: { serverBuild?: unknown; appVersion?: unknown; extensionBuild?: unknown; extensionVersion?: unknown };
  /** The save that was open — its folder, never its contents. */
  save?: string | null;
  resumeId?: unknown;
  applicationId?: unknown;
  /**
   * The id the sender gave this entry, when it gives one: JobHelper names
   * each entry it queues (a UUID) and sends that name with every try. An
   * entry already written under it is that entry, not another one; see
   * `add`. The editor and the CLI send none, and each of theirs is new.
   */
  clientId?: unknown;
}

/** A sender's id for an entry, as it may be kept: a short run of letters, digits, `-` and `_`. */
export function clientIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value) ? value : undefined;
}

/** One entry as the lists show it. */
export interface EntrySummary {
  /** Its folder, relative to the error log: `entries/2026-10-14/170512-431-the-thing`. */
  id: string;
  at: string;
  description: string;
  source: string;
  screenshots: number;
  events: number;
  /** In a commit the remote has, as of the last push or pull. */
  pushed: boolean;
}

export interface ErrorLogStatus {
  dir: string;
  isRepo: boolean;
  entries: number;
  remote: RemoteStatus | null;
  lastPush: string | null;
  lastCommitError: { message: string; at: string } | null;
}

/** A request the error log cannot take as it is, said as what to change. */
export class ErrorLogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErrorLogInputError';
  }
}

/** The most an entry's description may be, its screenshots may be, and how many there may be. */
export const MAX_DESCRIPTION = 4000;
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_SCREENSHOTS = 10;

const README = `# ResumeM-M error log

This repository is ResumeM-M's error log. It is kept apart from your saves and
from the program's own code: nothing in it is part of any resume, and nothing
in a save is in it.

Each entry was logged by hand — from the editor (Ctrl+Shift+E), from the
JobHelper popup (Alt+Shift+E), or with \`rmm log "what happened"\` — and is a
folder under \`entries/<date>/<time>-<milliseconds>-<what>/\`:

- \`entry.md\` — the description, when and where it was logged, the versions
  running, the page it was logged from, and which save was open (its folder
  only).
- \`logs.jsonl\` — what the program noticed in the minutes before: failed
  requests, console warnings and errors, failed commits, pushes and pulls,
  compile failures, AI runs that failed or timed out, and which JobHelper
  actions ran. One JSON object per line, oldest first.
- \`screenshot-N.png\` (or \`.jpg\`, \`.webp\`) — pasted or captured by hand.

Every log line has email addresses, phone numbers, street addresses, tokens
and passwords taken out before it is written. Resume text, letters, answers,
form field values and AI prompts are never logged at all.

Each entry is one commit, "Log: <description>". Push it somewhere private
(\`rmm log remote <url>\`, then \`rmm log push\`) to share it.
`;

const ATTRIBUTES = `# Screenshots are images, never text to merge or diff.
*.png binary
*.jpg binary
*.jpeg binary
*.webp binary
`;

/** The version of this program, from its package.json. */
export function appVersion(): string {
  try {
    const root = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
    return String((JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown }).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
/** The local calendar day, `2026-10-14`. Entries are filed by the day the person was having. */
const localDay = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
/*
 * `170512-431`: the local time to the millisecond. To the second only, two
 * entries in one second listed by their words rather than by when they were
 * logged; see `entryFolders`, which also orders the folders made before this.
 */
const localClock = (at: Date) => `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}`;
/** `UTC-04:00`, the offset the local time in an entry was read at. */
function utcOffset(at: Date): string {
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  return `UTC${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/** A few plain words of the description, for a folder name. "entry" when there are none. */
export function slugOf(description: string): string {
  const words = description
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return words || 'entry';
}

/** The description's first line, as a commit message and a heading carry it. */
export function firstLine(description: string, max = 72): string {
  const line = description.trim().split(/\r?\n/)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A short value to put in an entry: a string, cut, with nothing that could break a line. */
const short = (value: unknown, max = 200): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).replace(/[\r\n]+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export class ErrorLog {
  readonly root: string;
  readonly repo: Repo;

  constructor(root = errorLogDir()) {
    this.root = path.resolve(root);
    this.repo = new Repo(this.root);
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await run('git', args, { cwd: this.root, maxBuffer: Repo.MAX_BUFFER });
    return stdout;
  }

  async isRepo(): Promise<boolean> {
    return this.repo.isRepo();
  }

  /**
   * Make the repository, the first time it is needed: the folder, `git
   * init`, and a first commit holding the README that says what this is and
   * the `.gitattributes` that keeps screenshots binary. Nothing is made just
   * by looking — `status` and `list` read what is there.
   */
  async ensure(): Promise<void> {
    if (await this.repo.isRepo()) return;
    /*
     * A folder that cannot be made — a home that is not a folder
     * (`HOME=/dev/null`), one that is read-only, a file where the folder
     * should be — said as that, with what to do about it. It came out as
     * Node's own "ENOTDIR: not a directory, mkdir …".
     */
    try {
      fs.mkdirSync(this.root, { recursive: true });
      fs.accessSync(this.root, fs.constants.W_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const why =
        code === 'ENOTDIR' || code === 'EEXIST'
          ? 'something on the way to it is a file, not a folder'
          : code === 'EACCES' || code === 'EPERM'
            ? 'it is not yours to write to'
            : code === 'EROFS'
              ? 'it is on a read-only disk'
              : (err as Error).message;
      throw new ErrorLogInputError(
        `The error log cannot be kept in ${this.root}: ${why}. Set RMM_ERROR_LOG_DIR to a folder you can write to, ` +
          `or "dir" in ${errorLogSettingsFile()}.`,
      );
    }
    /*
     * `git init` before the lock, not under it. The lock lives in `.git`
     * once there is one and in the folder until then (see `SaveLock.where`),
     * so a lock taken before the init is let go of from the wrong place and
     * left behind. `init` is safe to run twice, and two processes making the
     * first entry at once both run it; the first commit, under the lock, is
     * made by whichever gets there first and found made by the other.
     */
    await this.git(['init', '-q']);
    await holdSaveForCommit(this.root, async () => {
      const born = await this.git(['rev-parse', '-q', '--verify', 'HEAD']).then(
        () => true,
        () => false,
      );
      if (born) return;
      for (const [name, text] of [['README.md', README], ['.gitattributes', ATTRIBUTES]] as const) {
        const at = path.join(this.root, name);
        if (!fs.existsSync(at)) fs.writeFileSync(at, text, 'utf8');
      }
      // `.gitignore` is the one `Repo` writes before every commit, for its scratch files.
      await this.repo.commitAll('Start the error log', ['README.md', '.gitattributes', '.gitignore']);
    });
  }

  /**
   * Write an entry and commit it: one folder, one commit, "Log: <what>".
   *
   * Under the cross-process lock from the first file to the commit, so an
   * entry from `rmm log` and one from the server at the same moment are two
   * folders and two commits, neither inside the other. Two in the same
   * millisecond with the same words are `…-2`, not one over the other.
   *
   * A commit that fails does not lose the entry: its files are written, and
   * the next entry's commit — or `git add` by hand — takes them. Said in the
   * answer, as `committed: false`, with git's reason.
   */
  async add(
    input: NewEntry,
  ): Promise<{ entry: EntrySummary; committed: boolean; commit?: string; commitError?: string; duplicate?: boolean }> {
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description) throw new ErrorLogInputError('Say in a few words what went wrong.');
    if (description.length > MAX_DESCRIPTION) {
      throw new ErrorLogInputError(`Keep the description under ${MAX_DESCRIPTION.toLocaleString('en-US')} characters; put the rest in a screenshot.`);
    }
    if (!SOURCES.includes(input.source)) throw new ErrorLogInputError(`Unknown source "${String(input.source)}".`);
    const images: Screenshot[] = [];
    const screenshots = input.screenshots ?? [];
    if (!Array.isArray(screenshots) || screenshots.length > MAX_SCREENSHOTS) {
      throw new ErrorLogInputError(`Add at most ${MAX_SCREENSHOTS} screenshots.`);
    }
    let total = 0;
    for (const raw of screenshots) {
      const image = decodeScreenshot(raw);
      if (!image) throw new ErrorLogInputError('Screenshots must be PNG, JPEG or WebP images, and be the image their type says.');
      total += image.bytes.length;
      images.push(image);
    }
    if (total > MAX_SCREENSHOT_BYTES) {
      throw new ErrorLogInputError(`The screenshots come to ${(total / 1024 / 1024).toFixed(1)} MB; keep them to 8 MB together.`);
    }

    const at = input.at && Number.isFinite(input.at.getTime()) ? input.at : new Date();
    const minutes = windowMinutes(input.minutes ?? DEFAULT_WINDOW);
    const events = mergeEvents(input.logs ?? [], { until: at, minutes });
    const said = withoutSecrets(description);

    const clientId = clientIdOf(input.clientId);

    await this.ensure();
    return holdSaveForCommit(this.root, async () => {
      /*
       * The same entry sent again is the one already written.
       *
       * JobHelper queues an entry while the store is down and sends it once
       * it answers — and Chrome stops its worker when it likes, so a send can
       * reach here, be written and committed, and its answer go to a worker
       * that no longer exists. The entry stays queued and goes again, and the
       * log held the same report twice. Looked for inside the hold, so two
       * tries in flight at once are one entry too.
       */
      if (clientId) {
        const already = this.findByClientId(clientId);
        if (already) {
          const [summary] = await this.list(1, this.entryFolders().indexOf(already));
          const loose = await this.git(['status', '--porcelain', '--', already]).catch(() => '');
          if (summary?.id === already) return { entry: summary, committed: !loose.trim(), duplicate: true };
        }
      }
      const day = localDay(at);
      const dayDir = path.join(this.root, 'entries', day);
      fs.mkdirSync(dayDir, { recursive: true });
      const base = `${localClock(at)}-${slugOf(firstLine(said))}`;
      let name = base;
      for (let n = 2; ; n++) {
        try {
          fs.mkdirSync(path.join(dayDir, name));
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 999) throw err;
          name = `${base}-${n}`;
        }
      }
      const folder = path.join(dayDir, name);
      const id = path.posix.join('entries', day, name);

      const shots = images.map((image, i) => {
        const file = `screenshot-${i + 1}.${image.extension}`;
        fs.writeFileSync(path.join(folder, file), image.bytes);
        return file;
      });
      fs.writeFileSync(path.join(folder, 'logs.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf8');
      fs.writeFileSync(path.join(folder, 'entry.md'), this.markdown({ input, said, at, minutes, shots, events }), 'utf8');

      const entry: EntrySummary = {
        id,
        at: at.toISOString(),
        description: firstLine(said, 200),
        source: input.source,
        screenshots: shots.length,
        events: events.length,
        pushed: false,
      };
      try {
        const commit = await this.repo.commitAll(`Log: ${firstLine(said)}`, [id], { auto: true });
        this.repo.lastCommitError = undefined;
        return { entry, committed: Boolean(commit), ...(commit ? { commit } : {}) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.repo.lastCommitError = { message, at: new Date().toISOString() };
        return { entry, committed: false, commitError: message };
      }
    });
  }

  /** The entry's own page: what was said, then everything known about when and where. */
  private markdown({
    input,
    said,
    at,
    minutes,
    shots,
    events,
  }: {
    input: NewEntry;
    said: string;
    at: Date;
    minutes: number;
    shots: string[];
    events: LogEvent[];
  }): string {
    const local = `${localDay(at)} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} (${utcOffset(at)})`;
    const v = input.versions ?? {};
    const versions = [
      short(v.serverBuild) && `server build ${short(v.serverBuild)}`,
      short(v.appVersion) && `ResumeM-M ${short(v.appVersion)}`,
      short(v.extensionVersion) && `JobHelper ${short(v.extensionVersion)}`,
      short(v.extensionBuild) && `extension build ${short(v.extensionBuild)}`,
    ].filter(Boolean);
    const url = short(input.page?.url, 2000);
    const title = short(input.page?.title);
    const errors = events.filter((e) => e.level === 'error').length;
    /*
     * The heading is the first line, cut to fit; what is under it is the rest.
     * A first line longer than the heading is all of it in the body, or the
     * part past the cut was nowhere in the entry — a long one-line description
     * kept its first 199 characters and lost the others.
     */
    const heading = firstLine(said, 200);
    const [first = '', ...after] = said.trim().split(/\r?\n/);
    const rest = first.trim().length > 200 ? said.trim() : after.join('\n').trim();
    const lines = [
      '---',
      `time: ${at.toISOString()}`,
      ...(clientIdOf(input.clientId) ? [`client_id: ${clientIdOf(input.clientId)}`] : []),
      `source: ${input.source}`,
      `window_minutes: ${minutes}`,
      `screenshots: ${shots.length}`,
      `events: ${events.length}`,
      '---',
      '',
      `# ${heading}`,
      '',
      ...(rest ? [rest, ''] : []),
      `- **Logged:** ${local} · ${at.toISOString()} (UTC)`,
      `- **From:** ${input.source}`,
      `- **Versions:** ${versions.length ? versions.join(' · ') : 'not known'}`,
      ...(url ? [`- **Page:** ${title ? `${withoutSecrets(title)} — ` : ''}${scrubUrl(url)}`] : title ? [`- **Page:** ${withoutSecrets(title)}`] : []),
      `- **Save open:** ${input.save ? input.save : 'none'}`,
      ...(short(input.resumeId) ? [`- **Resume:** ${short(input.resumeId)}`] : []),
      ...(short(input.applicationId) ? [`- **Application:** ${short(input.applicationId)}`] : []),
      `- **Automatic logs:** ${events.length} event${events.length === 1 ? '' : 's'} from the ${minutes} minute${minutes === 1 ? '' : 's'} before` +
        (errors ? `, ${errors} of them errors` : '') +
        ' — `logs.jsonl`',
      `- **Screenshots:** ${shots.length ? shots.map((s) => `[${s}](${s})`).join(', ') : 'none'}`,
      '',
    ];
    return lines.join('\n');
  }

  /**
   * Every entry's folder, newest first, relative to the error log.
   *
   * Newest by the `time:` the entry was written with, not by its folder's
   * name: a folder made before the name carried milliseconds is to the
   * second, and two in one second sorted by their words ("zzz" over "aaa"
   * logged after it), and `-9` over `-11`. Ties — the same millisecond — go
   * by the number after the name, the later one first: `x-11` was made after
   * `x-9`, and both after `x`. An entry whose time cannot be read goes by
   * its folder's name, read as the local time it was made at.
   */
  private entryFolders(): string[] {
    const found = this.entryNames();
    const keyed = found.map(({ day, name, siblings }) => {
      const id = `entries/${day}/${name}`;
      let time = Number.NaN;
      try {
        const fd = fs.openSync(path.join(this.root, id, 'entry.md'), 'r');
        try {
          const head = Buffer.alloc(256);
          const n = fs.readSync(fd, head, 0, head.length, 0);
          const field = /^time: (.*)$/m.exec(head.subarray(0, n).toString('utf8'))?.[1]?.trim();
          if (field) time = Date.parse(field);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // Unreadable: by its name, below.
      }
      if (!Number.isFinite(time)) {
        const clock = /^(\d{2})(\d{2})(\d{2})(?:-(\d{3}))?/.exec(name);
        const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
        time = clock ? new Date(y, mo - 1, d, +clock[1]!, +clock[2]!, +clock[3]!, +(clock[4] ?? 0)).getTime() : new Date(y, mo - 1, d).getTime();
      }
      // `x-N` is the Nth made under the name `x` when `x` is there too; otherwise the number is part of the words.
      const suffix = /^(.*)-(\d+)$/.exec(name);
      const copy = suffix && siblings.has(suffix[1]!) ? Number(suffix[2]) : 1;
      return { id, time, copy };
    });
    keyed.sort((a, b) => b.time - a.time || b.copy - a.copy || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return keyed.map((k) => k.id);
  }

  /** The folder of the entry written under a sender's id, if one was. */
  private findByClientId(clientId: string): string | undefined {
    for (const { day, name } of this.entryNames()) {
      const id = `entries/${day}/${name}`;
      try {
        const fd = fs.openSync(path.join(this.root, id, 'entry.md'), 'r');
        try {
          const head = Buffer.alloc(512);
          const n = fs.readSync(fd, head, 0, head.length, 0);
          if (/^client_id: (.*)$/m.exec(head.subarray(0, n).toString('utf8'))?.[1]?.trim() === clientId) return id;
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // Unreadable: not this one.
      }
    }
    return undefined;
  }

  /** Every entry's folder, by day, in no order. */
  private entryNames(): { day: string; name: string; siblings: Set<string> }[] {
    const root = path.join(this.root, 'entries');
    let days: string[];
    try {
      days = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    } catch {
      return [];
    }
    const out: { day: string; name: string; siblings: Set<string> }[] = [];
    for (const day of days) {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(root, day)).filter((n) => fs.existsSync(path.join(root, day, n, 'entry.md')));
      } catch {
        continue;
      }
      const siblings = new Set(names);
      for (const name of names) out.push({ day, name, siblings });
    }
    return out;
  }

  /**
   * The entries that are in no commit the remote has, as of the last push or
   * pull — or every one, when there is no remote or it was never pushed to.
   */
  private async unpushed(): Promise<Set<string> | 'all'> {
    const branch = await this.repo.currentBranch();
    if (!branch || !(await this.repo.getRemote())) return 'all';
    const tracking = `refs/remotes/origin/${branch}`;
    const there = await this.git(['rev-parse', '-q', '--verify', tracking]).then(
      () => true,
      () => false,
    );
    if (!there) return 'all';
    const names = await this.git(['-c', 'core.quotePath=false', 'log', '--format=', '--name-only', `${tracking}..HEAD`, '--', 'entries']).catch(() => '');
    const out = new Set<string>();
    for (const file of names.split('\n').filter(Boolean)) out.add(file.split('/').slice(0, 3).join('/'));
    // And whatever is not committed at all, which no remote has either.
    const loose = await this.git(['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all', '--', 'entries']).catch(() => '');
    for (const line of loose.split('\n').filter(Boolean)) out.add(line.slice(3).split('/').slice(0, 3).join('/'));
    return out;
  }

  /** The newest entries, as the editor's list and `rmm log status` show them. */
  async list(limit = 50, offset = 0): Promise<EntrySummary[]> {
    const folders = this.entryFolders().slice(offset, offset + limit);
    if (folders.length === 0) return [];
    const unpushed = (await this.repo.isRepo()) ? await this.unpushed() : 'all';
    return folders.map((id) => {
      const text = fs.readFileSync(path.join(this.root, id, 'entry.md'), 'utf8');
      const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(text)?.[1]?.trim();
      const heading = /^# (.*)$/m.exec(text)?.[1]?.trim() ?? id;
      return {
        id,
        at: field('time') ?? '',
        description: heading,
        source: field('source') ?? 'unknown',
        screenshots: Number(field('screenshots')) || 0,
        events: Number(field('events')) || 0,
        pushed: unpushed !== 'all' && !unpushed.has(id),
      };
    });
  }

  /** How many entries there are, pushed or not. */
  count(): number {
    return this.entryNames().length;
  }

  /** Where it is, whether it is a repository yet, its remote and when it was last pushed. Changes nothing. */
  async status(): Promise<ErrorLogStatus> {
    const isRepo = await this.repo.isRepo();
    const remote = isRepo ? await this.repo.remoteStatus() : null;
    const lastPush = isRepo ? (await this.git(['config', '--get', 'rmm.lastPush']).catch(() => '')).trim() || null : null;
    return {
      dir: this.root,
      isRepo,
      entries: this.entryNames().length,
      remote: remote && remote.url ? remote : null,
      lastPush,
      lastCommitError: this.repo.lastCommitError ?? null,
    };
  }

  /** Point the error log at a remote, or (with an empty address) take its remote away. Makes the repository first. */
  async setRemote(url: string): Promise<ErrorLogStatus> {
    await this.ensure();
    await this.repo.setRemote(String(url ?? '').trim());
    return this.status();
  }

  /** What the save's sync code says, in this repository's words. */
  private reword(text: string): string {
    return text
      .replace(/\brmm pull\b/g, 'rmm log pull')
      .replace(/\(the Pull button beside Push, or rmm log pull\)/g, '(Pull beside Push under Error Log, or rmm log pull)')
      .replace(/\bthis save\b/g, 'this error log')
      .replace(/\bThe save\b/g, 'The error log')
      .replace(/\bthe save\b/g, 'the error log')
      .replace(/\bthe store\b/g, 'the error log');
  }

  private noRemote(): string {
    return 'The error log has no remote yet, so there is nowhere to send it. Add one — an empty private repository — under Error Log in Save & Files, or with `rmm log remote <url>`.';
  }

  /** Send the entries to the remote. Git's own words when it refuses, with any token masked. */
  async push(): Promise<{ ok: boolean; output: string; status: ErrorLogStatus }> {
    if (!(await this.repo.isRepo()) || !(await this.repo.getRemote())) {
      return { ok: false, output: this.noRemote(), status: await this.status() };
    }
    let result: { ok: boolean; output: string };
    try {
      result = await this.repo.push();
    } catch (err) {
      result = { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) await this.git(['config', 'rmm.lastPush', new Date().toISOString()]).catch(() => undefined);
    return { ok: result.ok, output: this.reword(result.output), status: await this.status() };
  }

  /** Bring in entries pushed from another machine. */
  async pull(): Promise<PullResult & { status: ErrorLogStatus }> {
    if (!(await this.repo.isRepo()) || !(await this.repo.getRemote())) {
      return { ok: false, pulled: 0, files: [], message: this.noRemote().replace('send it', 'pull from'), status: await this.status() };
    }
    const result = await this.repo.pull();
    return { ...result, message: this.reword(result.message), status: await this.status() };
  }
}
