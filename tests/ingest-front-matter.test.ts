import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ingestFile } from '../src/ingest/index.js';
import { DEFAULT_CONFIG } from '../src/model/types.js';
import { tempDir } from './helpers.js';

/*
 * A Markdown file with a YAML header, dropped into the corpus.
 *
 * A letter or a sample copied out of a save (`letters/*.md`, `corpus/*.md`)
 * starts with one, and it was kept as the opening paragraph of the writing:
 * "title: … company: … createdAt: …" filed as a sample and sent to the AI as
 * how the person writes, with the title the header gave thrown away. And a
 * file whose header says `voice: false` — kept out of the voice in the save it
 * came from — went straight back in.
 */

const off = { ...DEFAULT_CONFIG, ai: { ...DEFAULT_CONFIG.ai, enabled: false } };

const LETTER = `---
title: Engineer — Globex
company: Globex
role: Engineer
createdAt: 2025-01-01T00:00:00.000Z
---
I have spent three years building streaming pipelines, and the latency work your ingestion team describes is the part I would most like to do next.
`;

describe('ingesting a Markdown file with a header', () => {
  it('reads the prose under the header, under the title and kind the header gives', async () => {
    const found = await ingestFile(off, 'globex.md', Buffer.from(LETTER), { useAi: false });
    expect(found.text).not.toContain('createdAt');
    expect(found.items).toHaveLength(1);
    expect(found.items[0]!.text).not.toMatch(/title:|company:|createdAt:/);
    expect(found.items[0]!.text).toContain('building streaming pipelines');
    expect(found.items[0]).toMatchObject({ title: 'Engineer — Globex', kind: 'letter' });
  });

  it('takes `kind` from a sample header', async () => {
    const sample = `﻿---\ntitle: A note on reviews\nkind: other\n---\nCode review is where a team learns what it values, and I try to leave one comment that teaches something each time.\n`;
    const found = await ingestFile(off, 'note.md', Buffer.from(sample), { useAi: false });
    expect(found.items[0]).toMatchObject({ title: 'A note on reviews', kind: 'other' });
    expect(found.items[0]!.text.startsWith('Code review')).toBe(true);
  });

  it('skips a file whose header keeps it out of the voice, and says so', async () => {
    const kept = LETTER.replace('role: Engineer\n', 'role: Engineer\nvoice: false\n');
    const found = await ingestFile(off, 'globex.md', Buffer.from(kept), { useAi: false });
    expect(found.items).toEqual([]);
    expect(found.skipped).toMatch(/voice: false/);
  });

  it('leaves a header-shaped start alone in a file that is not Markdown', async () => {
    const found = await ingestFile(off, 'globex.txt', Buffer.from(LETTER), { useAi: false });
    expect(found.text).toContain('company: Globex');
  });
});

describe('rmm voice add', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('reports a file it skipped for `voice: false`', async () => {
    const save = tempDir('rmm-voice-skip-');
    dirs.push(save);
    fs.writeFileSync(path.join(save, 'profile.yaml'), 'name: Someone\nemail: someone@example.com\n');
    fs.writeFileSync(path.join(save, 'config.yaml'), 'ai:\n  enabled: false\ngit:\n  autoCommit: false\n');
    const file = path.join(save, 'kept-out.md');
    fs.writeFileSync(file, LETTER.replace('role: Engineer\n', 'role: Engineer\nvoice: false\n'));

    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['node_modules/.bin/tsx', 'src/cli.ts', 'voice', 'add', file, '--no-ai', '--data', save],
      { cwd: root, env: { ...process.env, RMM_AUTOCOMMIT: '0' }, timeout: 60_000 },
    );
    expect(stdout).toMatch(/kept-out\.md — skipped: .*voice: false/);
    expect(stdout).toMatch(/1 file skipped/);
    expect(fs.existsSync(path.join(save, 'corpus'))).toBe(false);
  }, 60_000);
});
