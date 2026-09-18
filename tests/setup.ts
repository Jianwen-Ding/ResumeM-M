/**
 * What every test file does whether or not it says so.
 *
 * Loaded once per worker by `vitest.config.ts`. The only job so far is
 * sweeping the throwaway directories `helpers.tempDir` handed out: a test that
 * forgets its own `cleanup()` costs nothing visible, so they were forgotten a
 * lot, and a long session left thousands of them in the system temp folder.
 *
 * `afterAll` rather than `afterEach`, because a store made in `beforeAll` and
 * used by every test in a file is an ordinary shape and deleting it after the
 * first one would be worse than leaking it.
 */
import { afterAll } from 'vitest';
import { sweepTempDirs } from './helpers.js';

afterAll(() => {
  sweepTempDirs();
});
