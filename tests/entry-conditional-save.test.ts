import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';

/*
 * An entry written only over the version of it the writer was based on.
 *
 * The editor saves an entry whole, from its copy of the store. When the
 * entry was changed underneath it (a `git pull` in a terminal, another tab,
 * the extension) the editor's next save of its older copy wrote that change
 * away: fix the title, and a location pulled in as "Seattle, WA" went back to
 * "Boston, MA". A writer that says which version it built on (`basedOn`) is
 * now refused with 409 when the entry has moved on, and told what is there;
 * a writer that says nothing writes as before.
 */

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  app = express();
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});
afterEach(() => t.cleanup());

const stored = (id: string) => t.store.load().entries.find((e) => e.id === id)!;
const versionOf = async (id: string): Promise<string> =>
  (await request(app).get('/api/store').expect(200)).body.entryVersions[id];
const save = (id: string, entry: object, query = '') => request(app).put(`/api/entries/${id}${query}`).send({ ...entry, id });

describe('the editor’s save of an entry', () => {
  it('writes over the version it was based on, and says which version it made', async () => {
    const was = await versionOf('edu_neu');
    expect(was).toMatch(/^[0-9a-f]{20}$/);
    const res = await save('edu_neu', { ...stored('edu_neu'), title: 'Northeastern University (fixed)' }, `?basedOn=${was}`).expect(200);
    expect(stored('edu_neu').title).toBe('Northeastern University (fixed)');
    const now = await versionOf('edu_neu');
    expect(now).not.toBe(was);
    expect(res.headers.etag).toBe(`"${now}"`);
  });

  it('is refused over a change it did not see, with the entry as it is now, and writes nothing', async () => {
    const was = await versionOf('edu_neu');
    const mine = stored('edu_neu');
    // Pulled in from elsewhere.
    await save('edu_neu', { ...mine, location: 'Seattle, WA' }).expect(200);
    const theirs = await versionOf('edu_neu');

    const res = await save('edu_neu', { ...mine, title: 'Northeastern University (fixed)' }, `?basedOn=${was}`).expect(409);
    expect(res.body).toMatchObject({ kind: 'conflict', id: 'edu_neu', version: theirs });
    expect(res.body.current.location).toBe('Seattle, WA');
    expect(res.body.error).toMatch(/changed elsewhere/);
    expect(stored('edu_neu')).toMatchObject({ title: 'Northeastern University', location: 'Seattle, WA' });
    expect(await versionOf('edu_neu')).toBe(theirs);
  });

  it('is not refused over a change to another entry in the same section file', async () => {
    const was = await versionOf('exp_acme');
    await save('edu_neu', { ...stored('edu_neu'), location: 'Seattle, WA' }).expect(200);
    await save('exp_acme', { ...stored('exp_acme'), title: 'Acme Corp.' }, `?basedOn=${was}`).expect(200);
    expect(stored('exp_acme').title).toBe('Acme Corp.');
  });

  it('without one, writes whatever is there, as it always did', async () => {
    const mine = stored('edu_neu');
    await save('edu_neu', { ...mine, location: 'Seattle, WA' }).expect(200);
    await save('edu_neu', { ...mine, title: 'From the CLI' }).expect(200);
    expect(stored('edu_neu')).toMatchObject({ title: 'From the CLI', location: 'Boston, MA' });
    // And a partial, as MCP sends, is still laid over what is there.
    await save('edu_neu', { title: 'Partial' }).expect(200);
    expect(stored('edu_neu')).toMatchObject({ title: 'Partial', kind: 'education' });
  });

  it('is not refused for an entry that is not there, as a new one is created', async () => {
    const was = await versionOf('edu_neu');
    await save('edu_new', { kind: 'education', title: 'New School', bullets: [] }, `?basedOn=${was}`).expect(200);
    expect(stored('edu_new').title).toBe('New School');
  });
});
