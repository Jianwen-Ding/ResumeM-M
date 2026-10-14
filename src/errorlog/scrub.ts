import { withoutContactDetails } from '../ai/privacy.js';
import { redactUrls } from '../git/repo.js';
import type { LogEvent } from './buffer.js';

/**
 * What never goes into the error log, however it got into a log line.
 *
 * The error log is a git repository meant to be pushed — to a private
 * repository, but pushed — and the lines in it are written by code that was
 * not thinking about that: a git error quoting the remote it could not reach,
 * a request log naming the address it was asked for, a console warning
 * repeating whatever the exception said. So every line is cleaned on its way
 * into an entry, whoever wrote it:
 *
 * - **Contact details**, by the same rule the AI's prompts use
 *   (`withoutContactDetails`): an email, a phone number, a street address.
 * - **Tokens in addresses**, by the same rule the remote and push code use
 *   (`redactUrls`): `https://alice:ghp_…@github.com/…` keeps the user and
 *   loses the token.
 * - **Credentials named as such**: an `Authorization` header and what follows
 *   it, the pairing header (`X-RMM-Pair`), a `Bearer …`, and a `token=`,
 *   `secret: …` or `password=` written out in a message.
 * - **Query strings that carry one**: `?token=`, `&key=`, `?code=`, `secret`,
 *   `signature` and the like — a sign-in callback, a signed link.
 * - **The shapes tokens come in**, for one pasted somewhere with no name in
 *   front of it: GitHub's, OpenAI's and Anthropic's, Slack's, AWS key ids,
 *   and JSON web tokens.
 *
 * What is not here is the bigger rule: answer text, letter bodies, resume
 * text, form field values and prompts are never put in a log line in the
 * first place. A scrub catches a secret that slipped into a message; it
 * cannot be what keeps a cover letter out.
 */
const MASK = '[redacted]';

const HEADER = /\b(authorization|proxy-authorization|x-rmm-pair|cookie|set-cookie)(["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|digest)\s+)?[^\s"',;]+/gi;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi;
const NAMED = /\b((?:access[_-]?|refresh[_-]?|id[_-]?|api[_-]?|auth[_-]?|session[_-]?)?(?:token|secret|password|passwd|api[_-]?key|apikey|client[_-]?secret))(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;&]+/gi;
const QUERY = /([?&#;][\w.-]*(?:token|key|secret|code|password|passwd|auth|sig|signature|session|pair)[\w.-]*=)[^&#\s"'<>]*/gi;
const SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** The longest a single line may be once it is in the log. */
export const MAX_LINE = 2000;

/** `text` with every secret this knows the shape of masked. Contact details are left. */
export function withoutSecrets(text: string): string {
  let out = redactUrls(String(text ?? ''));
  out = out.replace(HEADER, (_all, name: string, sep: string, scheme?: string) => `${name}${sep}${scheme ? `${scheme} ` : ''}${MASK}`);
  out = out.replace(BEARER, (_all, word: string) => `${word} ${MASK}`);
  out = out.replace(QUERY, (_all, name: string) => `${name}${MASK}`);
  out = out.replace(NAMED, (_all, name: string, sep: string) => `${name}${sep}${MASK}`);
  for (const shape of SHAPES) out = out.replace(shape, MASK);
  return out;
}

/** A line fit for the error log: no secrets, no contact details, not too long. */
export function scrubText(text: string, max = MAX_LINE): string {
  const clean = withoutContactDetails(withoutSecrets(String(text ?? '')));
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** An address fit for the error log: its query string's secrets gone, and no token in front of the host. */
export function scrubUrl(url: string): string {
  return scrubText(url, 500);
}

const LEVELS = new Set(['error', 'warn', 'info']);

/**
 * One event, from anywhere, made safe to keep: its text scrubbed, its detail
 * cut to small plain values, its time a real time. Undefined for something
 * that is not an event at all.
 */
export function scrubEvent(raw: unknown, source?: string): LogEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  const at = typeof e.at === 'string' || typeof e.at === 'number' ? new Date(e.at) : undefined;
  if (!at || !Number.isFinite(at.getTime())) return undefined;
  const message = typeof e.message === 'string' ? e.message : '';
  if (!message.trim()) return undefined;
  const detail: Record<string, string | number | boolean | null> = {};
  if (e.detail && typeof e.detail === 'object') {
    for (const [key, value] of Object.entries(e.detail as Record<string, unknown>).slice(0, 12)) {
      if (!/^[A-Za-z][\w-]{0,31}$/.test(key)) continue;
      if (typeof value === 'string') detail[key] = scrubText(value, 300);
      else if (typeof value === 'number' && Number.isFinite(value)) detail[key] = value;
      else if (typeof value === 'boolean' || value === null) detail[key] = value;
    }
  }
  const kind = typeof e.kind === 'string' && /^[\w -]{1,32}$/.test(e.kind) ? e.kind : 'event';
  const from = source ?? (typeof e.source === 'string' && /^[\w -]{1,32}$/.test(e.source) ? e.source : 'unknown');
  return {
    at: at.toISOString(),
    source: from,
    kind,
    level: LEVELS.has(e.level as string) ? (e.level as LogEvent['level']) : 'info',
    message: scrubText(message),
    ...(Object.keys(detail).length ? { detail } : {}),
  };
}

/**
 * Events from several places, each scrubbed, kept to the window that ends at
 * `until`, and put in the order they happened. Ties keep the order they came
 * in, so two events in one millisecond from one place stay as they were.
 */
export function mergeEvents(
  lists: { events: unknown[]; source?: string }[],
  { until, minutes, max = 5000 }: { until: Date; minutes: number; max?: number },
): LogEvent[] {
  const from = until.getTime() - minutes * 60 * 1000;
  const to = until.getTime() + 5_000; // A client clock a moment ahead is still this window.
  const all: { event: LogEvent; n: number }[] = [];
  let n = 0;
  for (const { events, source } of lists) {
    for (const raw of Array.isArray(events) ? events : []) {
      const event = scrubEvent(raw, source);
      if (!event) continue;
      const t = Date.parse(event.at);
      if (t < from || t > to) continue;
      all.push({ event, n: n++ });
    }
  }
  all.sort((a, b) => a.event.at.localeCompare(b.event.at) || a.n - b.n);
  return all.slice(-max).map((x) => x.event);
}
