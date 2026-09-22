import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as resolveMod from '../src/model/resolve.js';
import { Store } from '../src/model/store.js';
import { fitResumes } from '../src/jobs/fit.js';
import type { Entry } from '../src/model/types.js';

/*
 * `fitResumes` scores every resume in the store against a posting by
 * building each one's printed text — every bullet it would show, joined and
 * run through a regex — which is most of what that function costs. See
 * `resumeTextStamp` in store.ts and the cache in fit.ts for the reasoning;
 * these tests are the falsifiable half of it: they prove a call with nothing
 * changed does not rebuild a resume's text, and that every way the text
 * *could* change — the resume's own file, an entry, a skill group, or a
 * different save being open — is still noticed.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function aStore(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fit-cache-'));
  dirs.push(dir);
  const store = new Store(dir);
  store.saveProfile({ name: 'Someone', email: 's@e.com' });
  store.saveConfig({});
  const entry: Entry = {
    id: 'e_kafka',
    kind: 'experience',
    title: 'Streaming Co.',
    bullets: [
      {
        id: 'b1',
        default: 'v1',
        variants: [{ id: 'v1', label: 'Default', text: 'Ran Kafka pipelines across three regions.' }],
      },
    ],
  };
  store.saveEntry(entry);
  store.saveSkillGroups([{ id: 'sk1', name: 'Languages', items: [{ id: 'i1', text: 'Go' }] }]);
  store.saveResume({
    id: 'platform',
    label: 'Platform',
    sections: [{ kind: 'experience', entries: ['e_kafka'] }, { kind: 'skills', entries: [], groups: ['sk1'] }],
  });
  return { store, dir };
}

/** Rewrite a file the way something outside this process would — see store-cache.test.ts. */
function editBehindItsBack(dir: string, rel: string, contents: string) {
  const f = path.join(dir, rel);
  fs.writeFileSync(f, contents);
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(f, later, later);
}

const KAFKA = ['Kafka'];

describe('fitResumes caches a resume’s printed text', () => {
  it('does not rebuild a resume’s text on a second call with nothing changed', () => {
    const { store, dir } = aStore();
    void dir;
    fitResumes(store.load(), KAFKA, undefined, store); // warm

    const spy = vi.spyOn(resolveMod, 'resolveResume');
    fitResumes(store.load(), KAFKA, undefined, store);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rebuilds it, and sees the change, when the resume’s own file is edited by hand', () => {
    const { store, dir } = aStore();
    const before = fitResumes(store.load(), ['Rust'], undefined, store);
    expect(before.find((f) => f.id === 'platform')?.hits).toBe(0);

    editBehindItsBack(
      dir,
      'resumes/platform.yaml',
      'id: platform\nlabel: Platform\nsections:\n  - kind: experience\n    entries: [e_kafka]\n    bullets:\n      e_kafka: [b1]\n    heading: Rust work\n',
    );

    const spy = vi.spyOn(resolveMod, 'resolveResume');
    const after = fitResumes(store.load(), ['Rust'], undefined, store);
    expect(spy).toHaveBeenCalled();
    expect(after.find((f) => f.id === 'platform')?.hits).toBe(1);
  });

  it('rebuilds it, and sees the change, when an entry’s bullet is edited by hand', () => {
    const { store, dir } = aStore();
    const before = fitResumes(store.load(), ['Rust'], undefined, store);
    expect(before.find((f) => f.id === 'platform')?.hits).toBe(0);

    editBehindItsBack(
      dir,
      'experience.yaml',
      '- id: e_kafka\n  kind: experience\n  title: Streaming Co.\n  bullets:\n    - id: b1\n      default: v1\n      variants:\n        - id: v1\n          label: Default\n          text: Rewrote the pipeline in Rust.\n',
    );

    const after = fitResumes(store.load(), ['Rust'], undefined, store);
    expect(after.find((f) => f.id === 'platform')?.hits).toBe(1);
  });

  it('rebuilds it, and sees the change, when skills.yaml is edited by hand', () => {
    const { store, dir } = aStore();
    const before = fitResumes(store.load(), ['Rust'], undefined, store);
    expect(before.find((f) => f.id === 'platform')?.hits).toBe(0);

    editBehindItsBack(dir, 'skills.yaml', '- id: sk1\n  name: Languages\n  items:\n    - id: i1\n      text: Rust\n');

    const after = fitResumes(store.load(), ['Rust'], undefined, store);
    expect(after.find((f) => f.id === 'platform')?.hits).toBe(1);
  });

  it('does not confuse two open saves that happen to share a resume id', () => {
    const one = aStore();
    const two = aStore();
    editBehindItsBack(
      two.dir,
      'resumes/platform.yaml',
      'id: platform\nlabel: Platform\nsections:\n  - kind: experience\n    entries: [e_kafka]\n    bullets:\n      e_kafka: [b1]\n    heading: Rust work\n',
    );

    const oneFit = fitResumes(one.store.load(), ['Rust'], undefined, one.store);
    const twoFit = fitResumes(two.store.load(), ['Rust'], undefined, two.store);
    expect(oneFit.find((f) => f.id === 'platform')?.hits).toBe(0);
    expect(twoFit.find((f) => f.id === 'platform')?.hits).toBe(1);

    // And the reverse order, from the cache the other way round, in case
    // whichever ran first is what made it pass.
    const oneAgain = fitResumes(one.store.load(), ['Rust'], undefined, one.store);
    expect(oneAgain.find((f) => f.id === 'platform')?.hits).toBe(0);
  });
});
