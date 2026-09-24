import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApi, sameResumeName } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';

/*
 * Renaming a resume, and never landing one on top of another.
 *
 * The name is what the picker shows; the file is what everything else points
 * at, so only the name moves. A name another resume already goes by is
 * refused — and so, now, is a new variation saved under a name or a filename
 * that is taken, which used to replace that resume without a word.
 */

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  app = express();
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});
afterEach(() => t.cleanup());

const labelOf = (id: string) => t.store.load().resumes.find((r) => r.id === id)?.label;
const rename = (id: string, label: string) => request(app).post(`/api/resumes/${id}/rename`).send({ label });

describe('renaming a resume', () => {
  it('changes the name it is shown by, and not the file it is kept in', async () => {
    const res = await rename('intern', 'Internships, 2027').expect(200);
    expect(res.body).toMatchObject({ id: 'intern', label: 'Internships, 2027' });
    expect(labelOf('intern')).toBe('Internships, 2027');
  });

  it('is refused when another resume already goes by that name, however it is typed', async () => {
    const theirs = labelOf('newgrad')!;
    const res = await rename('intern', `  ${theirs.toUpperCase()}  `).expect(409);
    expect(res.body.error).toMatch(/already exists/);
    expect(labelOf('intern')).not.toBe(theirs.toUpperCase());
  });

  it('keeps its own name without complaint', async () => {
    const mine = labelOf('intern')!;
    await rename('intern', mine).expect(200);
  });

  it('needs a name, and a resume that exists', async () => {
    await rename('intern', '   ').expect(400);
    await rename('nobody', 'Anything').expect(404);
  });
});

describe('saving a new variation', () => {
  const create = (spec: Record<string, unknown>) =>
    request(app).put(`/api/resumes/${spec.id}?create=1`).send(spec);

  it('is refused over a filename another resume has', async () => {
    const before = labelOf('newgrad');
    const res = await create({ id: 'newgrad', label: 'Something new', sections: [] }).expect(409);
    expect(res.body.error).toMatch(/already saved as/);
    expect(labelOf('newgrad')).toBe(before);
  });

  it('and under a name another resume goes by', async () => {
    const res = await create({ id: 'fresh-one', label: labelOf('newgrad')!, sections: [] }).expect(409);
    expect(res.body.error).toMatch(/already exists/);
    expect(labelOf('fresh-one')).toBeUndefined();
  });

  it('and is saved when both are its own', async () => {
    await create({ id: 'fresh-one', label: 'A name nobody has', sections: [] }).expect(200);
    expect(labelOf('fresh-one')).toBe('A name nobody has');
  });

  it('while an ordinary save of an existing resume still writes it', async () => {
    await request(app).put('/api/resumes/newgrad').send({ id: 'newgrad', label: 'New grad, edited', sections: [] }).expect(200);
    expect(labelOf('newgrad')).toBe('New grad, edited');
  });
});

describe('what counts as the same name', () => {
  it('is the letters and digits, whatever the case, spacing or punctuation', () => {
    expect(sameResumeName('New grad', 'new-grad')).toBe(true);
    expect(sameResumeName('New grad', 'New grad 2')).toBe(false);
    expect(sameResumeName('', '')).toBe(false);
  });
});
