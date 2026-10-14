/**
 * What happened lately, kept in memory so an error log can say it.
 *
 * Somebody who presses "Log an error" is describing the last few minutes, and
 * what they can describe is what they saw: a red line, a button that did
 * nothing. What they cannot see is the request behind the button answering
 * 500, the commit after it failing on `index.lock`, the compile that timed
 * out a minute earlier. Each part of the program keeps those here, as they
 * happen, so an entry can carry the ones from the minutes before it.
 *
 * Bounded both ways — by age and by count, whichever is smaller — because it
 * runs for as long as the server does and nobody may ever log anything.
 * A server left up for a week keeps the last fifteen minutes, not a week.
 *
 * Imports nothing, so anything in the program can write to it — the compiler,
 * the job runner, the request log — without one more import cycle. What goes
 * in is not scrubbed here: that is done once, on the way out (see
 * `scrub.ts`), so a rule added there covers everything already held.
 */

/** One thing that happened. Plain data, the same shape from every part. */
export interface LogEvent {
  /** When, as an ISO timestamp. */
  at: string;
  /** Which part saw it: server, editor, jobhelper, cli. */
  source: string;
  /** What sort of thing: console, request, commit, push, pull, compile, latex, ai, action, … */
  kind: string;
  level: 'error' | 'warn' | 'info';
  /** One sentence or a few, scrubbed on the way out. */
  message: string;
  /** Small facts about it: a route, a status, a duration. Never field values or text. */
  detail?: Record<string, string | number | boolean | null>;
}

/** The longest any part keeps an event, and the most it keeps. */
export const KEEP_MS = 15 * 60 * 1000;
export const KEEP_EVENTS = 2000;

/** The windows an entry may ask for, in minutes, and the one it gets when it asks for none. */
export const WINDOWS = [2, 10, 30] as const;
export const DEFAULT_WINDOW = 10;

/**
 * A window as asked for, made one of the allowed ones' range: a whole number
 * of minutes from 1 to 30. Anything that is not a number is the default.
 */
export function windowMinutes(asked: unknown): number {
  const n = typeof asked === 'string' && asked.trim() !== '' ? Number(asked) : asked;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_WINDOW;
  return Math.min(30, Math.max(1, Math.round(n)));
}

export class LogBuffer {
  private events: LogEvent[] = [];

  constructor(
    private readonly keepMs = KEEP_MS,
    private readonly keepEvents = KEEP_EVENTS,
    /** The clock, for tests. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Keep one more, and let go of whatever is now too old or one too many. */
  push(event: Omit<LogEvent, 'at'> & { at?: string }): void {
    this.events.push({ ...event, at: event.at ?? new Date(this.now()).toISOString() });
    this.trim();
  }

  /** Everything from the last `minutes`, oldest first. */
  since(minutes: number): LogEvent[] {
    this.trim();
    const from = this.now() - minutes * 60 * 1000;
    return this.events.filter((e) => Date.parse(e.at) >= from);
  }

  /** How many are held right now. */
  get size(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
  }

  private trim(): void {
    const oldest = this.now() - this.keepMs;
    let drop = 0;
    while (drop < this.events.length && Date.parse(this.events[drop]!.at) < oldest) drop++;
    drop = Math.max(drop, this.events.length - this.keepEvents);
    if (drop > 0) this.events.splice(0, drop);
  }
}

/**
 * The server's own buffer: one per process, since everything in a process
 * that can go wrong reports to the same place. The CLI writes nothing to it
 * — its commands keep no buffer — and reads a running server's instead.
 */
export const serverLog = new LogBuffer();

/** Note something that happened in this server. */
export function logServerEvent(
  kind: string,
  message: string,
  level: LogEvent['level'] = 'error',
  detail?: LogEvent['detail'],
): void {
  serverLog.push({ source: 'server', kind, level, message, ...(detail ? { detail } : {}) });
}
