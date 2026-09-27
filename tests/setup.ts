/**
 * What every test file does whether or not it says so.
 *
 * Loaded once per worker by `vitest.config.ts`. Four jobs.
 *
 * Sweeping the throwaway directories `helpers.tempDir` handed out: a test that
 * forgets its own `cleanup()` costs nothing visible, so they were forgotten a
 * lot, and a long session left thousands of them in the system temp folder.
 *
 * `afterAll` rather than `afterEach`, because a store made in `beforeAll` and
 * used by every test in a file is an ordinary shape and deleting it after the
 * first one would be worse than leaking it.
 *
 * And turning on the compiled-document cache. A run compiles a hundred and
 * forty documents and only forty-three of them are different, because nearly
 * every file builds the same sample store and then checks something that is
 * not the PDF — the file it was written to, the row in the tracker, the
 * warning beside it. The cache is keyed on the .tex itself, so a test that
 * changes the document still compiles it; see `cacheKey` in
 * `src/render/compile.ts`. Point `RMM_COMPILE_CACHE` somewhere else, or at
 * nothing, to run without it.
 */
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, vi } from 'vitest';
import { sweepTempDirs } from './helpers.js';

process.env.RMM_COMPILE_CACHE ??= path.join(os.tmpdir(), 'rmm-compiled');
/*
 * And never the real list of saves. A server started without a
 * `preferencesFile` reads and writes the one in the home directory — the list
 * of saves the person running the tests has open — so every run gets a
 * throwaway one unless a test names its own.
 */
process.env.RMM_PROJECTS_FILE ??= path.join(os.tmpdir(), `rmm-vitest-projects-${process.pid}.json`);

afterAll(() => {
  sweepTempDirs();
});

/*
 * And, in the files that boot the editor, unloading the page between tests.
 *
 * Those files boot a fresh copy of web/app.js per test into one jsdom window:
 * `vi.resetModules()` makes the next import a new copy and replacing
 * `documentElement.innerHTML` gives it a new page, but nothing unloads the
 * copy before. It is still subscribed to `hashchange`, `keydown` and
 * `visibilitychange` on the same window and document, its debounces are
 * still pending, and it looks its elements up by id whenever it runs — in
 * whichever page is there by then, sending through whichever `fetch` that
 * test stubbed.
 *
 * Measured by tagging every request and timer with the copy that made it, a
 * plain run of the 33 files had old copies acting inside later tests in 11 of
 * them: an auto-save PUT from a test several back landing in reorder's "puts
 * the fold on the spec that gets saved", a Ctrl+Z pressed in undo-ui undone
 * by the previous test's editor too and saved over this one's resume, and
 * three stale editors fetching and drawing the application the hash named in
 * tracker-link. On a quiet machine most of them land on nothing a test looks
 * at; under load they land wherever the next assertion is.
 *
 * A browser does two things to a page it leaves: its listeners go with its
 * window, and its timers never fire. So every listener added to the window
 * or document during a test comes off after it, and every timer still
 * pending is cleared — real ones here, and fake ones by `useRealTimers`,
 * which throws the fake clock away with what is on it.
 */
if (typeof window !== 'undefined') {
  const unload: Array<() => void> = [];
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener;
    target.addEventListener = function (this: EventTarget, type, listener, options) {
      unload.push(() => target.removeEventListener(type, listener, options));
      return add.call(this, type, listener, options);
    };
  }

  const pending = new Set<ReturnType<typeof setTimeout>>();
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearTimeout = globalThis.clearTimeout;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setTimeout = Object.assign(
    (run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = realSetTimeout((...given: unknown[]) => {
        pending.delete(id);
        run(...given);
      }, ms, ...args);
      pending.add(id);
      return id;
    },
    realSetTimeout,
  ) as typeof setTimeout;
  globalThis.setInterval = Object.assign(
    (run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = realSetInterval(run, ms, ...args);
      pending.add(id);
      return id;
    },
    realSetInterval,
  ) as typeof setInterval;
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) pending.delete(id);
    realClearTimeout(id);
  }) as typeof clearTimeout;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (id !== undefined) pending.delete(id);
    realClearInterval(id);
  }) as typeof clearInterval;

  afterEach(() => {
    vi.useRealTimers();
    for (const off of unload.splice(0)) off();
    // clearTimeout and clearInterval are the same thing on one set of ids.
    for (const id of pending) realClearTimeout(id);
    pending.clear();
  });
}
