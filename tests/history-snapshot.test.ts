import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { isSnapshotFile, parseSnapshot, readSnapshot, type ParsedYaml } from '../src/model/snapshot.js';
import { resolveResume } from '../src/model/resolve.js';
import { makeTempStore, noiseCommits, SAMPLE_BASE, SAMPLE_EXPERIENCE, SAMPLE_NEWGRAD, type TempStore } from './helpers.js';

/*
 * Version history reads only what the asked-for resume resolves against.
 *
 * It used to rebuild every resume in the save at every commit in its window,
 * which on a save of 260 resumes was eighteen seconds before the timeline
 * opened, and forty-five on a real one. It now reads the resume, the bases its
 * `extends` names, and the shared files, through one git process a commit,
 * and keeps each parse by blob id. None of that is allowed to change a word
 * of the answer, so these build a history with the awkward cases in it and
 * hold the route to what it said before, reply for reply.
 *
 * "Before" is the old reading, kept here: every snapshot file in the tree,
 * one `git cat-file blob` each, all of it parsed. It is switched in for the
 * route's own `readSnapshot` so the rest of the route is the same code both
 * times.
 */
const mode = vi.hoisted(() => ({ old: false, repo: undefined as Repo | undefined }));

vi.mock('../src/model/snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/model/snapshot.js')>();
  return {
    ...actual,
    readSnapshot: async (...args: Parameters<typeof actual.readSnapshot>) => {
      if (!mode.old) return actual.readSnapshot(...args);
      const [tree] = args;
      const files = new Map<string, string>();
      for (const [file, objectId] of tree) {
        if (actual.isSnapshotFile(file)) files.set(file, await mode.repo!.blob(objectId));
      }
      return files.size === 0 ? undefined : actual.parseSnapshot(files);
    },
  };
});

let t: TempStore;
let repo: Repo;

beforeEach(async () => {
  t = makeTempStore({ config: { ai: { enabled: false }, git: { autoCommit: false }, output: { dir: 'out' } } });
  repo = Repo.forStore(t.dir);
  mode.repo = repo;
  mode.old = false;
  await repo.ensure();
  await history(t, repo);
});
afterEach(() => t.cleanup());

/**
 * A history with the things a reader can get wrong in it, committed straight
 * to git so the old shapes survive: inheritance chains, a second spelling of
 * one resume, YAML that will not parse, a file of the wrong shape, a loop of
 * bases, a resume deleted and brought back, two files holding one blob.
 */
async function history(t: TempStore, repo: Repo): Promise<void> {
  const commit = (message: string) => repo.commitAll(message);
  const reworded = (text: string) => ({
    ...SAMPLE_EXPERIENCE,
    bullets: [{ ...SAMPLE_EXPERIENCE.bullets![0]!, variants: [{ id: 'v_base', label: 'Neutral', text }] }, SAMPLE_EXPERIENCE.bullets![1]!],
  });

  t.write('experience.yaml', [reworded('Built a pipeline for **3M events/day**')]);
  await commit('Reword a shared bullet');
  t.write('resumes/base.yaml', { ...SAMPLE_BASE, sections: [...SAMPLE_BASE.sections!].reverse() });
  await commit('Reorder the base');
  t.write('resumes/intern.yaml', { id: 'intern', label: 'Intern, renamed', extends: 'base' });
  await commit('Rename the intern resume');
  await noiseCommits(t.dir, 3);
  t.write('resumes/newgrad.yml', { id: 'newgrad', label: 'The other spelling', extends: 'intern' });
  await commit('A second spelling of newgrad');
  t.write('experience.yaml', '- id: exp_acme\n  title: [unclosed\n');
  await commit('Half-saved experience');
  t.write('experience.yaml', { entries: [reworded('Wrapped in a mapping')] });
  await commit('Experience as a mapping');
  t.write('experience.yaml', [reworded('Back to a list')]);
  await commit('Experience put right');
  t.write('resumes/chain-c.yaml', { id: 'chain-c', label: 'C', extends: 'chain-b' });
  t.write('resumes/chain-b.yaml', { id: 'chain-b', label: 'B', extends: 'newgrad', choices: { b_pipeline: 'v_base' } });
  await commit('A chain three deep');
  t.write('resumes/base.yaml', { ...SAMPLE_BASE, extends: 'chain-c' });
  await commit('A loop of bases');
  t.write('resumes/newgrad-copy.yaml', SAMPLE_NEWGRAD);
  t.write('resumes/newgrad.yaml', SAMPLE_NEWGRAD);
  await commit('Two files, one blob');
  t.write('skills.yaml', [{ id: 'sk_lang', name: 'Languages', items: [{ id: 's_go', text: 'Go' }] }]);
  t.write('profile.yaml', { name: { default: 'v_legal', variants: [{ id: 'v_legal', text: 'Test Q. Person' }] } });
  await commit('Skills and the profile');
  t.write('resumes/base.yaml', 'just a string\n');
  await commit('A resume that is not a mapping');
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.rmSync(path.join(t.dir, 'resumes', 'base.yaml'));
  fs.rmSync(path.join(t.dir, 'resumes', 'newgrad.yml'));
  await commit('Delete the base');
  t.write('resumes/base.yaml', { id: 'base', label: 'Base, standing alone', sections: SAMPLE_BASE.sections });
  t.write('resumes/newgrad.yaml', { id: 'newgrad', label: 'New grad, flat', sections: SAMPLE_BASE.sections, choices: { 'edu_neu.dates': 'v_dec2026' } });
  await commit('Bring it back, flat');
  await noiseCommits(t.dir, 2);
}

const IDS = ['base', 'newgrad', 'intern', 'chain-b', 'chain-c', 'newgrad-copy', 'does-not-exist'];

async function timeline(id: string, query = ''): Promise<unknown> {
  // A fresh API each time, so neither reading is answered from the other's
  // document cache.
  const app = express();
  app.use('/api', createApi({ store: t.store, repo }));
  return (await request(app).get(`/api/resumes/${encodeURIComponent(id)}/history${query}`).expect(200)).body;
}

describe('a resume timeline, read only as far as the resume needs', () => {
  it('says exactly what reading every file said, for every resume', async () => {
    for (const id of IDS) {
      for (const query of ['?limit=3', '?limit=100']) {
        mode.old = true;
        const before = await timeline(id, query);
        mode.old = false;
        const after = await timeline(id, query);
        expect(after, `${id}${query}`).toEqual(before);
      }
    }
  });

  it('has something to say, so the comparison above is not of two empty lists', async () => {
    const body = (await timeline('newgrad', '?limit=100')) as { versions: { changes: unknown[] }[] };
    expect(body.versions.length).toBeGreaterThan(5);
  });
});

describe('readSnapshot', () => {
  it('resolves every resume, at every commit, to what the whole snapshot resolves it to', async () => {
    const live = t.store.load();
    const parsed = new Map<string, ParsedYaml>();
    let compared = 0;
    for (const { hash } of await repo.log(100)) {
      const tree = await repo.treeAt(hash);
      const files = new Map<string, string>();
      for (const [file, objectId] of tree) if (isSnapshotFile(file)) files.set(file, await repo.blob(objectId));
      const whole = parseSnapshot(files);

      for (const id of IDS) {
        const resolve = (snapshot: typeof whole | undefined) => {
          try {
            return snapshot ? resolveResume(id, { ...live, ...snapshot }) : null;
          } catch (err) {
            return `threw: ${(err as Error).message}`;
          }
        };
        // `parsed` is shared across every commit and every resume, the way
        // the route shares it across a window, so a parse one of them changed
        // in place would show up as a difference in another.
        const narrow = await readSnapshot(tree, (ids) => repo.blobs(ids), id, parsed);
        expect(resolve(narrow), `${id} at ${hash.slice(0, 7)}`).toEqual(resolve(whole));
        expect(resolve(parseSnapshot(files, id))).toEqual(resolve(whole));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(IDS.length * 15);
  });

  it('reads none of the resumes it was not asked about, and every base it was', async () => {
    const [head] = await repo.log(1);
    const tree = await repo.treeAt(head!.hash);
    const read = async (id: string) => {
      const asked: string[] = [];
      const reading = async (ids: string[]) => {
        asked.push(...ids);
        return repo.blobs(ids);
      };
      await readSnapshot(tree, reading, id, new Map());
      return [...tree].filter(([, objectId]) => asked.includes(objectId)).map(([file]) => file);
    };

    // Flat at the head of the history: itself and the shared files.
    const flat = await read('newgrad');
    expect(flat.filter((f) => f.startsWith('resumes/'))).toEqual(['resumes/newgrad.yaml']);
    expect(flat).toEqual(expect.arrayContaining(['experience.yaml', 'education.yaml', 'skills.yaml']));
    // Still inheriting there, so the base it names comes too.
    expect((await read('intern')).filter((f) => f.startsWith('resumes/'))).toEqual(['resumes/base.yaml', 'resumes/intern.yaml']);
  });
});

describe('Repo.blobs', () => {
  it('answers as `blob` does, one object at a time', async () => {
    const [head] = await repo.log(1);
    const tree = await repo.treeAt(head!.hash);
    const ids = [...tree.values()];
    const many = await repo.blobs([...ids, ids[0]!]);
    for (const id of ids) expect(many.get(id) ?? '').toBe(await repo.blob(id));
  });

  it('leaves out what is not a blob, or not there, as `blob` gives back nothing for it', async () => {
    const [head] = await repo.log(1);
    const missing = '0'.repeat(40);
    const got = await repo.blobs([head!.hash, missing, 'not a hash\nHEAD']);
    expect(got.size).toBe(0);
    expect(await repo.blob(head!.hash)).toBe('');
    expect(await repo.blob(missing)).toBe('');
  });
});
