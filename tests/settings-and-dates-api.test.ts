import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});
afterEach(() => t.cleanup());

const configFile = () => fs.readFileSync(path.join(t.dir, 'config.yaml'), 'utf8');

/*
 * "As it comes" effort and the auto-detected engine are the absence of a
 * value. JSON drops an `undefined` and the save merges, so the old value
 * stayed while the page said "Settings saved". `null` is how a caller says
 * "back to the default", at whatever depth the setting sits.
 */
describe('putting a setting back to its default', () => {
  it('removes a key sent as null', async () => {
    await request(app).put('/api/config').send({ ai: { effort: 'high' }, latex: { engine: 'pdflatex' } }).expect(200);
    expect(t.store.loadConfig().ai.effort).toBe('high');
    expect(t.store.loadConfig().latex.engine).toBe('pdflatex');

    const res = await request(app).put('/api/config').send({ ai: { effort: null }, latex: { engine: null } }).expect(200);
    expect(res.body.ai.effort).toBeUndefined();
    expect(res.body.latex.engine).toBeUndefined();
    expect(configFile()).not.toMatch(/effort/);
    expect(configFile()).not.toMatch(/pdflatex/);
  });

  it('removes one nested a level further down, and leaves its neighbours', () => {
    t.store.saveConfig({ layout: { fontSizePt: 11, fitBounds: { minFontSizePt: 10.2, minMarginIn: 0.5 } } });
    t.store.saveConfig({ layout: { fitBounds: { minMarginIn: null } } } as never);
    expect(t.store.loadConfig().layout).toEqual({ fontSizePt: 11, fitBounds: { minFontSizePt: 10.2 } });
  });

  it('leaves the rest of the block alone', () => {
    t.store.saveConfig({ ai: { ...t.store.loadConfig().ai, model: 'opus', effort: 'low' } });
    t.store.saveConfig({ ai: { effort: null } } as never);
    expect(t.store.loadConfig().ai.model).toBe('opus');
    expect(t.store.loadConfig().ai.effort).toBeUndefined();
  });
});

/*
 * An emptied number box was sent as `Number('')` — 0 — and written: a 0pt
 * font on every resume in the save, or the sweep switched off.
 */
describe('the numbers a settings patch may carry', () => {
  it('refuses a layout number outside what a page can be set at', async () => {
    for (const layout of [{ fontSizePt: 0 }, { marginIn: 0 }, { spacing: 9 }, { fontSizePt: 'big' }, { maxPages: 1.5 }, { paper: 'legal' }, { fitBounds: { minFontSizePt: 0 } }]) {
      const res = await request(app).put('/api/config').send({ layout }).expect(400);
      expect(res.body.error, JSON.stringify(layout)).toBeTruthy();
    }
    expect(t.store.loadConfig().layout).toEqual({});
    // And still takes one inside it.
    await request(app).put('/api/config').send({ layout: { fontSizePt: 11.5, marginIn: 0.5, spacing: 1.1 } }).expect(200);
    expect(t.store.loadConfig().layout).toMatchObject({ fontSizePt: 11.5, marginIn: 0.5, spacing: 1.1 });
  });

  it('refuses a temporaryDays that is not a whole number of days', async () => {
    for (const temporaryDays of [-1, 2.5, 'seven', 99999]) {
      await request(app).put('/api/config').send({ resumes: { temporaryDays } }).expect(400);
    }
    await request(app).put('/api/config').send({ resumes: { temporaryDays: 0 } }).expect(200);
    expect(t.store.loadConfig().resumes?.temporaryDays).toBe(0);
  });
});

/*
 * The year box accepted 2023.5, and the server printed it: "Jul. 2023.5".
 */
describe('the years on an entry', () => {
  const entry = () => t.store.load().entries[0]!;

  it('refuses a fractional year in a period', async () => {
    const e = entry();
    const res = await request(app)
      .put(`/api/entries/${e.id}`)
      .send({ ...e, period: { start: { year: 2023.5, month: 7 } } })
      .expect(400);
    expect(res.body.error).toMatch(/whole year/);
    expect(JSON.stringify(entry().dates)).not.toContain('2023.5');
    // A whole one still goes in.
    await request(app).put(`/api/entries/${e.id}`).send({ ...e, dates: 'x', period: { start: { year: 2023, month: 7 } } }).expect(200);
    expect(entry().period?.start).toEqual({ year: 2023, month: 7 });
  });

  it('refuses a year outside 1900–2100, and a month outside 1–12', async () => {
    const e = entry();
    await request(app).put(`/api/entries/${e.id}`).send({ ...e, period: { start: { year: 1850 } } }).expect(400);
    await request(app).put(`/api/entries/${e.id}`).send({ ...e, period: { start: { year: 2020 }, end: { year: 2200 } } }).expect(400);
    await request(app).put(`/api/entries/${e.id}`).send({ ...e, period: { start: { year: 2020, month: 13 } } }).expect(400);
  });

  it('refuses a new alternate of the date with a fractional year in it', async () => {
    const e = entry();
    const dates = { default: 'a', variants: [{ id: 'a', label: 'A', text: 'Jul. 2023 -- Present' }, { id: 'b', label: 'B', text: 'Jul. 2023.5 -- Present' }] };
    await request(app).put(`/api/entries/${e.id}`).send({ ...e, dates }).expect(400);
  });
});

/*
 * `loadSamples` keeps every key in a sample's front matter; the PUT rebuilt
 * the sample from seven named fields, so editing the text dropped the rest.
 */
describe('editing a writing sample', () => {
  it('keeps the front matter it does not name', async () => {
    const dir = path.join(t.dir, 'corpus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'kept.md'),
      '---\ntitle: Kept\nkind: letter\ncreatedAt: 2024-01-01T00:00:00.000Z\nwrittenAt: 2023-05-01\nsource: my-old-laptop\ntags:\n  - formal\n---\nOld text\n',
    );
    await request(app).put('/api/voice/samples/kept').send({ text: 'New text' }).expect(200);

    const sample = t.store.loadSamples().find((s) => s.id === 'kept') as unknown as Record<string, unknown>;
    expect(sample.text).toBe('New text');
    expect(sample.source).toBe('my-old-laptop');
    expect(sample.writtenAt).toBe('2023-05-01');
    expect(sample.tags).toEqual(['formal']);
    expect(sample.title).toBe('Kept');
    expect(sample.kind).toBe('letter');
    expect(sample.createdAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('still replaces what it is sent, and clears what is sent as null', async () => {
    await request(app).put('/api/voice/samples/s1').send({ title: 'One', kind: 'letter', text: 'Text', tags: ['a'] }).expect(200);
    await request(app).put('/api/voice/samples/s1').send({ title: 'Two', text: 'Text 2', tags: null }).expect(200);
    const sample = t.store.loadSamples().find((s) => s.id === 's1');
    expect(sample).toMatchObject({ title: 'Two', kind: 'letter', text: 'Text 2' });
    expect(sample?.tags).toBeUndefined();
  });
});
