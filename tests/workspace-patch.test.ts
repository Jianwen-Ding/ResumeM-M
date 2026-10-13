import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  app = express();
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});
afterEach(() => t.cleanup());

/*
 * The editor saves a draft as what it changed since it last read or saved it
 * (`saveDraftNow` in web/app.js), so the draft PUT has to leave every field
 * it is not sent as it is. These are the three writes the editor used to
 * undo by sending its copy of everything: another tab's letter, an answer
 * JobHelper filed from the posting, and a letter the AI wrote.
 */
describe('PUT /workspace/:id, sent only what changed', () => {
  async function open() {
    const res = await request(app)
      .post('/api/workspace')
      .send({
        company: 'Acme Robotics',
        role: 'Software Engineer',
        url: 'https://acme.example/jobs/1',
        coverLetterRequired: true,
        questions: [{ question: 'Why do you want to work here?', answer: '' }],
      })
      .expect(200);
    return res.body.draft as { id: string };
  }

  it('leaves the letter written elsewhere when only a note is sent', async () => {
    const { id } = await open();
    await request(app)
      .put(`/api/workspace/${id}`)
      .send({ coverLetter: { body: 'Dear Acme, typed in tab A.', edited: true } })
      .expect(200);
    await request(app).put(`/api/workspace/${id}`).send({ notes: 'note from tab B' }).expect(200);

    const draft = (await request(app).get(`/api/workspace/${id}`).expect(200)).body;
    expect(draft.coverLetter.body).toBe('Dear Acme, typed in tab A.');
    expect(draft.coverLetter.required).toBe(true);
    expect(draft.notes).toBe('note from tab B');
  });

  it('leaves the answers JobHelper filed when only the letter is sent', async () => {
    const { id } = await open();
    await request(app)
      .post('/api/workspace')
      .send({
        company: 'Acme Robotics',
        role: 'Software Engineer',
        url: 'https://acme.example/jobs/1',
        coverLetterRequired: true,
        questions: [{ question: 'Why do you want to work here?', answer: 'Answer typed on the posting page via JobHelper' }],
      })
      .expect(200);
    await request(app)
      .put(`/api/workspace/${id}`)
      .send({ coverLetter: { body: 'Dear Acme,', edited: true } })
      .expect(200);

    const draft = (await request(app).get(`/api/workspace/${id}`).expect(200)).body;
    expect(draft.questions[0].answer).toBe('Answer typed on the posting page via JobHelper');
    expect(draft.coverLetter.body).toBe('Dear Acme,');
  });

  it('keeps a letter and the flag on it when only another part of the letter is sent', async () => {
    const { id } = await open();
    await request(app)
      .put(`/api/workspace/${id}`)
      .send({ coverLetter: { body: 'Dear Acme, drafted by the AI.' } })
      .expect(200);
    await request(app).put(`/api/workspace/${id}`).send({ coverLetter: { required: false } }).expect(200);

    const draft = (await request(app).get(`/api/workspace/${id}`).expect(200)).body;
    expect(draft.coverLetter).toMatchObject({ required: false, body: 'Dear Acme, drafted by the AI.' });
  });
});
