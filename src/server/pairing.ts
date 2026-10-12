import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Which browser extensions may read and write the save.
 *
 * The server is on loopback with no password, and it used to answer any
 * `chrome-extension://` origin at all: every extension installed in the
 * browser could read the whole store — the profile, every application, the
 * answers somebody gave about their visa — and write to it. An extension is
 * not a web page, so CORS does nothing to stop one that holds host access to
 * loopback, and the extension's id is different on every machine (an unpacked
 * extension's id comes from the folder it was loaded from), so there is no id
 * to write down in advance either.
 *
 * So an extension is paired, once, by the person at the keyboard: the editor
 * shows a short code, the extension sends it back from its own origin, and
 * gets a long token in return that it sends on every request from then on.
 *
 * Kept per machine, beside `projects.json`, not in the save: a save is
 * committed and pushed, and a pairing is a fact about this browser on this
 * computer. Only a hash of each token is written down, so the file is not
 * itself a key to the save.
 */

/** An extension's origin. Ids are 32 letters from a to p. */
export const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/** No 0/O or 1/I, which is the whole of what makes a code hard to type. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
export const CODE_LIFETIME_MS = 10 * 60 * 1000;
/** Wrong guesses a code survives. The fifth one ends it. */
export const CODE_TRIES = 5;
/** Pairings one extension keeps at once: one per browser profile it is installed in. */
export const TOKENS_PER_EXTENSION = 8;

export interface Paired {
  origin: string;
  pairedAt: string;
  /** sha256 of the token, hex. */
  tokenHash: string;
}

export type PairResult =
  | { ok: true; token: string; origin: string }
  | { ok: false; kind: 'not-extension' | 'no-code' | 'bad-code'; error: string; triesLeft?: number };

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest();

/**
 * Equal, without saying how much of it was.
 *
 * Both sides are hashed first so they are always the same length, which
 * `timingSafeEqual` needs and which would otherwise leak the length itself.
 */
export const sameSecret = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

/** What someone types: spaces, a dash in the middle, lower case. */
export const normaliseCode = (input: unknown) => String(input ?? '').toUpperCase().replace(/[\s-]/g, '');

export function pairingsFile(preferencesFile: string): string {
  return path.join(path.dirname(preferencesFile), 'extensions.json');
}

export class Pairings {
  private code: { value: string; expiresAt: number; wrong: number } | undefined;
  private cache: { stamp: string; list: Paired[] } | undefined;

  constructor(
    readonly file: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Read on every check, cheaply: another server on this machine may have paired or removed one. */
  read(): Paired[] {
    let stamp: string;
    try {
      const stat = fs.statSync(this.file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return [];
    }
    if (this.cache?.stamp === stamp) return this.cache.list;
    let list: Paired[] = [];
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const raw = (data as { extensions?: unknown })?.extensions;
      list = Array.isArray(raw)
        ? raw.filter(
            (p): p is Paired =>
              Boolean(p) &&
              typeof p.origin === 'string' &&
              EXTENSION_ORIGIN.test(p.origin) &&
              typeof p.tokenHash === 'string' &&
              /^[0-9a-f]{64}$/.test(p.tokenHash) &&
              typeof p.pairedAt === 'string',
          )
        : [];
    } catch (error) {
      // Unreadable is unpaired, not a crash: the editor can pair again.
      console.warn(`[rmm] Ignoring unreadable extension pairings at ${this.file}: ${(error as Error).message}`);
    }
    this.cache = { stamp, list };
    return list;
  }

  private write(list: Paired[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ extensions: list }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.cache = undefined;
  }

  /** A fresh code, replacing whatever was showing. */
  newCode(): { code: string; expiresAt: string } {
    let value = '';
    for (let i = 0; i < CODE_LENGTH; i++) value += ALPHABET[randomInt(ALPHABET.length)];
    const expiresAt = this.now() + CODE_LIFETIME_MS;
    this.code = { value, expiresAt, wrong: 0 };
    return { code: value, expiresAt: new Date(expiresAt).toISOString() };
  }

  currentCode(): { code: string; expiresAt: string } | null {
    if (this.code && this.code.expiresAt <= this.now()) this.code = undefined;
    return this.code ? { code: this.code.value, expiresAt: new Date(this.code.expiresAt).toISOString() } : null;
  }

  cancelCode(): void {
    this.code = undefined;
  }

  pair(origin: unknown, input: unknown): PairResult {
    if (typeof origin !== 'string' || !EXTENSION_ORIGIN.test(origin)) {
      return { ok: false, kind: 'not-extension', error: 'Only a browser extension pairs, from its own page.' };
    }
    const current = this.currentCode();
    if (!current || !this.code) {
      return {
        ok: false,
        kind: 'no-code',
        error:
          'ResumeM-M is not showing a pairing code right now. Open ResumeM-M → Save & Files → ' +
          'Pair JobHelper, press "Make a code", and enter that one.',
      };
    }
    if (!sameSecret(normaliseCode(input), this.code.value)) {
      this.code.wrong += 1;
      const triesLeft = CODE_TRIES - this.code.wrong;
      if (triesLeft <= 0) {
        this.code = undefined;
        return {
          ok: false,
          kind: 'bad-code',
          triesLeft: 0,
          error: 'That code was wrong too many times, so it no longer works. Make a new one in ResumeM-M.',
        };
      }
      return {
        ok: false,
        kind: 'bad-code',
        triesLeft,
        error: `That is not the code ResumeM-M is showing. ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left.`,
      };
    }
    // One use: a code read over somebody's shoulder pairs nothing afterwards.
    this.code = undefined;
    const token = randomBytes(32).toString('base64url');
    /*
     * Beside the extension's earlier pairings, not instead of them.
     *
     * An unpacked extension's id comes from the folder it was loaded from, so
     * the same JobHelper in two Chrome profiles on this machine is the same
     * origin with two tokens, and pairing the second must not unpair the
     * first. The newest few are kept; Remove takes all of them.
     */
    const list = this.read();
    const mine = list.filter((p) => p.origin === origin);
    if (mine.length >= TOKENS_PER_EXTENSION) list.splice(list.indexOf(mine[0]!), 1);
    list.push({ origin, pairedAt: new Date(this.now()).toISOString(), tokenHash: sha(token).toString('hex') });
    this.write(list);
    return { ok: true, token, origin };
  }

  /**
   * The pairing a token belongs to, or nothing.
   *
   * By token, and by origin when the request says one. Chrome leaves `Origin`
   * off an extension's GET to a host it holds permission for, so the token is
   * often all there is; when the origin is there it has to be the one the
   * token was given to.
   */
  check(token: unknown, origin?: string): Paired | undefined {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) return undefined;
    const wanted = sha(token);
    let found: Paired | undefined;
    // Every entry compared, so the time taken does not say which one matched.
    for (const p of this.read()) {
      const stored = Buffer.from(p.tokenHash, 'hex');
      if (stored.length === wanted.length && timingSafeEqual(stored, wanted) && (!origin || origin === p.origin)) {
        found = p;
      }
    }
    return found;
  }

  /** One row per extension, with when it was last paired. */
  list(): { origin: string; id: string; pairedAt: string }[] {
    const latest = new Map<string, string>();
    for (const p of this.read()) {
      const seen = latest.get(p.origin);
      if (!seen || p.pairedAt > seen) latest.set(p.origin, p.pairedAt);
    }
    return [...latest].map(([origin, pairedAt]) => ({ origin, id: origin.slice('chrome-extension://'.length), pairedAt }));
  }

  remove(origin: string): boolean {
    const list = this.read();
    const kept = list.filter((p) => p.origin !== origin);
    if (kept.length === list.length) return false;
    this.write(kept);
    return true;
  }
}
