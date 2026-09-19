/*
 * Resolve the fixture store with the code as it was when resumes inherited,
 * and print the documents as JSON. Run inside a worktree of that commit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeInheritedStore, RESUME_IDS } from '/home/user/ResumeM-M/tests/fixtures/inherited-store.ts';
import { Store } from './src/model/store.js';
import { resolveResume } from './src/model/resolve.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'));
writeInheritedStore(dir);

const store = new Store(dir);
const data = store.load();

const out: Record<string, unknown> = {};
for (const id of RESUME_IDS) {
  const r = resolveResume(id, data);
  out[id] = { label: r.label, profile: r.profile, layout: r.layout, sections: r.sections };
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
fs.rmSync(dir, { recursive: true, force: true });
