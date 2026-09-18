/**
 * What a model is allowed to put in the store.
 *
 * `POST /ai/draft-entry` is the one place a model's own words become
 * something shaped like an entry. It is a proposal — the editor shows it and
 * the person decides — but the shaping happens here, and everything
 * downstream treats the result as an entry like any other. So this is the
 * boundary worth being strict at: ids assigned by us, kind forced to one the
 * store understands, fields we do not know dropped, and every wording marked
 * unreviewed so the editor can say which words nobody has read yet.
 *
 * Driven through the real endpoint with a stand-in for the model, because the
 * interesting cases are the replies a model actually produces — a field
 * invented, a label repeated, a bullet with nothing in it — and none of those
 * are reachable by calling the shaping function with a tidy object.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { DEFAULT_CONFIG } from '../src/model/types.js';
import { makeTempStore, tempDir, type TempStore } from './helpers.js';

const scripts = tempDir('rmm-draft-stub-');

/**
 * A stand-in for the model: a CLI that prints what this test wants it to say
 * and exits. Same shape the real presets are driven in — argv ending in the
 * prompt file — so nothing about how the agent is launched is stubbed out.
 */
function saying(reply: string): { command: string; args: string[] } {
  const file = path.join(scripts, `${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(
    file,
    `const fs = require('node:fs');
// The prompt arrives as a path; read it so a change that stops passing one
// fails here rather than passing quietly.
const promptFile = process.argv[process.argv.length - 1];
if (!fs.existsSync(promptFile)) throw new Error('no prompt file in argv');
process.stdout.write(${JSON.stringify(reply)});
`,
    'utf8',
  );
  return { command: process.execPath, args: [file, '{prompt}'] };
}

let t: TempStore;
let app: express.Express;

function serve(reply: string) {
  const { command, args } = saying(reply);
  t = makeTempStore({
    config: {
      ai: { ...DEFAULT_CONFIG.ai, enabled: true, command, args, timeoutMs: 20_000 },
      git: { autoCommit: false },
      output: { dir: 'out' },
    },
  });
  app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
}

const draft = (body: unknown) => request(app).post('/api/ai/draft-entry').send(body as object);

afterEach(() => t?.cleanup());

describe('an entry drafted by a model', () => {
  const ORDINARY = JSON.stringify({
    kind: 'project',
    title: 'Tidepool',
    subtitle: 'Go, Postgres',
    dates: '2025',
    bullets: [
      { variants: [{ label: 'Neutral', text: 'Built a queue that survives a restart.' }] },
      { variants: [{ label: 'Scale', text: 'Held two million jobs without falling over.' }] },
    ],
  });

  it('comes back shaped like an entry, without being saved', async () => {
    serve(ORDINARY);
    const res = await draft({ notes: 'A queue I wrote.' }).expect(200);

    expect(res.body.executed).toBe(true);
    expect(res.body.entry.title).toBe('Tidepool');
    expect(res.body.entry.kind).toBe('project');
    expect(res.body.entry.bullets).toHaveLength(2);
    // Proposed, not stored: the save still holds what it held.
    expect(t.store.load().entries.map((e) => e.id)).not.toContain(res.body.entry.id);
  });

  it('marks every wording unreviewed, and pins one', async () => {
    serve(ORDINARY);
    const res = await draft({ notes: 'A queue I wrote.' }).expect(200);
    for (const b of res.body.entry.bullets) {
      expect(b.variants.every((v: { suggested?: boolean }) => v.suggested)).toBe(true);
      expect(b.variants.some((v: { id: string }) => v.id === b.default)).toBe(true);
    }
  });

  it('keeps nothing the store does not have a place for', async () => {
    // A model that decides to add a field is ordinary rather than exceptional,
    // and an entry carrying one would be written to YAML by the first save.
    serve(
      JSON.stringify({
        kind: 'project',
        title: 'Tidepool',
        archived: true,
        tags: ['made-up'],
        verified: 'yes',
        bullets: [{ variants: [{ label: 'One', text: 'Did the thing.', citation: 'trust me' }] }],
      }),
    );
    const res = await draft({ notes: 'x' }).expect(200);

    expect(Object.keys(res.body.entry).sort()).toEqual(['bullets', 'id', 'kind', 'title']);
    expect(Object.keys(res.body.entry.bullets[0].variants[0]).sort()).toEqual(['id', 'label', 'suggested', 'text']);
  });

  it('calls a kind it does not know a project, rather than storing it', async () => {
    serve(JSON.stringify({ kind: 'publication', title: 'A Paper', bullets: [] }));
    const res = await draft({ notes: 'x' }).expect(200);
    expect(res.body.entry.kind).toBe('project');
  });

  it('gives an untitled draft a title, because an entry is found by its title', async () => {
    serve(JSON.stringify({ kind: 'project', bullets: [] }));
    const res = await draft({ notes: 'x' }).expect(200);
    expect(res.body.entry.title).toBe('Untitled');
    expect(res.body.entry.id).toBeTruthy();
  });

  it('drops a line that has nothing to say', async () => {
    // A bullet whose wordings are all blank would print as an empty dot.
    serve(
      JSON.stringify({
        kind: 'project',
        title: 'Tidepool',
        bullets: [
          { variants: [{ label: 'Empty', text: '   ' }] },
          { variants: [{ label: 'Real', text: 'Built the thing.' }] },
        ],
      }),
    );
    const res = await draft({ notes: 'x' }).expect(200);
    expect(res.body.entry.bullets).toHaveLength(1);
    expect(res.body.entry.bullets[0].variants[0].text).toBe('Built the thing.');
  });

  it('tells two wordings apart when the model labels them the same', async () => {
    // Wording ids are made from labels, and a model repeating a label is
    // ordinary. Two with one id is one wording as far as every resume is
    // concerned — the same collision that used to happen between entries.
    serve(
      JSON.stringify({
        kind: 'project',
        title: 'Tidepool',
        bullets: [
          {
            variants: [
              { label: 'Scale', text: 'Held two million jobs.' },
              { label: 'Scale', text: 'Held two million jobs a day.' },
              { label: 'Scale', text: 'Held a lot of jobs.' },
            ],
          },
        ],
      }),
    );
    const res = await draft({ notes: 'x' }).expect(200);
    const ids = res.body.entry.bullets[0].variants.map((v: { id: string }) => v.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('gives lines within one entry ids of their own', async () => {
    serve(ORDINARY);
    const res = await draft({ notes: 'x' }).expect(200);
    const ids = res.body.entry.bullets.map((b: { id: string }) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('when the draft cannot be used', () => {
  it('says so, rather than failing somewhere later', async () => {
    serve('I had a think about this and here are some ideas for you.');
    const res = await draft({ notes: 'x' }).expect(400);
    expect(res.body.error).toMatch(/did not return an entry/i);
  });

  it('refuses a request with neither a link nor a word of description', async () => {
    serve('{}');
    const res = await draft({}).expect(400);
    expect(res.body.error).toMatch(/repository link or say a little/i);
  });

  it('hands back the prompt instead of a draft when the AI is switched off', async () => {
    t = makeTempStore(); // the fixture's own config, which has AI off
    app = express();
    app.use(express.json());
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

    const res = await draft({ notes: 'A queue I wrote.' }).expect(200);
    expect(res.body.executed).toBe(false);
    expect(res.body.entry).toBeNull();
    // Worth copying into a chat of your own, which is what the editor offers.
    expect(res.body.prompt).toMatch(/queue I wrote/);
  });
});
