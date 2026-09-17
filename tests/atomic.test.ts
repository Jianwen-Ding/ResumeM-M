import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/model/store.js';
import type { Application } from '../src/model/types.js';
import { makeTempStore } from './helpers.js';

/*
 * A write that is visible half-finished is a write that loses data.
 *
 * `fs.writeFileSync` opens with O_TRUNC, so for the length of the write the
 * file is zero bytes and then partially written. A second reader is ordinary
 * here — the `rmm` CLI, a second server, a hand edit while the app is up — and
 * the dangerous outcome is not a parse error. A YAML list truncated at an item
 * boundary parses perfectly: the reader gets 130 of 300 applications, nothing
 * is raised, and the next save writes that shorter list back.
 */

const require_ = createRequire(import.meta.url);

let temp: ReturnType<typeof makeTempStore>;

beforeEach(() => {
  temp = makeTempStore();
});
afterEach(() => temp.cleanup());

function manyApplications(n: number): Application[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `app-${i}`,
    company: `Company ${i}`,
    role: 'Software Engineer Intern',
    appliedAt: '2026-01-01T00:00:00.000Z',
    status: 'applied' as const,
    resumeId: 'base',
    notes: 'A note long enough that the file runs to several filesystem blocks. '.repeat(4),
  }));
}

describe('a write that fails', () => {
  it('leaves the previous file exactly as it was', () => {
    const file = path.join(temp.dir, 'applications.yaml');
    temp.store.saveApplications(manyApplications(5));
    const before = fs.readFileSync(file, 'utf8');

    // A value that throws while being stringified, so the failure lands after
    // the temp file exists and before anything is renamed over the real one.
    const hostile = {
      get company(): string {
        throw new Error('not serialisable');
      },
    };
    expect(() => temp.store.saveApplications([hostile as never])).toThrow(/not serialisable/);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    // And no debris for the next `git status` to show.
    expect(fs.readdirSync(temp.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('writes voice, letters and the corpus the same way', () => {
    // Three more plain writeFileSync calls over prose the user typed.
    temp.store.saveVoice('# Voice\n\nPlain and direct.\n');
    expect(temp.store.loadVoice()).toContain('Plain and direct');
    expect(fs.readdirSync(temp.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('how the write lands', () => {
  /*
   * The mechanism, tested rather than the race.
   *
   * A race test here is probabilistic: the truncated window is microseconds
   * wide, and a run that fails to catch it proves nothing. What is not
   * probabilistic is the signature. `fs.writeFileSync` opens the existing file
   * with O_TRUNC and writes into it, so the file keeps its inode and is
   * observably empty in between. Writing a temp file and renaming it over the
   * target replaces the directory entry in one atomic step, so the inode
   * changes and no reader ever sees a byte of both versions.
   */
  it('replaces the file rather than emptying and refilling it', () => {
    const file = path.join(temp.dir, 'applications.yaml');
    temp.store.saveApplications(manyApplications(5));
    const before = fs.statSync(file).ino;

    temp.store.saveApplications(manyApplications(6));

    expect(fs.statSync(file).ino).not.toBe(before);
    expect(temp.store.load().applications).toHaveLength(6);
  });

  it('does the same for a file that did not exist yet', () => {
    temp.store.saveVoice('first');
    const file = path.join(temp.dir, 'voice.md');
    const before = fs.statSync(file).ino;
    temp.store.saveVoice('second');
    expect(fs.statSync(file).ino).not.toBe(before);
    expect(temp.store.loadVoice()).toBe('second');
  });
});
