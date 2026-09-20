/**
 * What every test file does whether or not it says so.
 *
 * Loaded once per worker by `vitest.config.ts`. Two jobs.
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
import { afterAll } from 'vitest';
import { sweepTempDirs } from './helpers.js';

process.env.RMM_COMPILE_CACHE ??= path.join(os.tmpdir(), 'rmm-compiled');

afterAll(() => {
  sweepTempDirs();
});
