import { describe, expect, it } from 'vitest';
import { currentIgnore } from '../src/model/current.js';
import { makeTempStore } from './helpers.js';

/*
 * The flat folder is rebuilt from the tracker whenever anything changes, so
 * it is nothing to keep a history of — and walking it mid-rebuild failed the
 * whole commit. See `currentIgnore`.
 */
describe('the flat folder, as a line for the save’s .gitignore', () => {
  const store = (output: Record<string, unknown>) =>
    makeTempStore({ config: { ai: { enabled: false }, git: { autoCommit: false }, output } });

  it('is named where the output folder is inside the save', () => {
    const t = store({ dir: 'out', withinProject: true });
    try {
      expect(currentIgnore(t.store)).toEqual(['/out/current/']);
    } finally {
      t.cleanup();
    }
  });

  it('and nothing where it is beside the save, which is the default', () => {
    const t = store({ dir: 'out' });
    try {
      expect(currentIgnore(t.store)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
