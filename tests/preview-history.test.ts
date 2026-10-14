import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { createApi, createPdfRouter } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { currentIgnore } from '../src/model/current.js';
import { hasLatex, makeTempStore, type TempStore } from './helpers.js';

const latex = await hasLatex();

/*
 * The editor's previews are compiled into `out/.previews` under a fresh name
 * each time, and the oldest are swept. In a save made through the app `out/`
 * is inside the save, and the folder was never ignored: every compile added
 * and deleted PDFs and .tex in the history, Save History showed them as the
 * change, and every push carried them. See `currentIgnore`.
 */
describe.skipIf(!latex)('the previews, in the save’s history', { timeout: 180_000 }, () => {
  let t: TempStore;
  let app: express.Express;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: t.dir, encoding: 'utf8' });

  const serve = (repo: Repo) => {
    app = express();
    app.use('/api', createApi({ store: t.store, repo }));
    app.use('/pdf', createPdfRouter(t.store));
  };
  const compile = async () => {
    const res = await request(app).post('/api/render').send({ resumeId: 'newgrad' }).expect(200);
    expect(res.body.pdfUrl).toMatch(/^\/pdf\/\.previews\//);
  };
  const edit = (label: string) =>
    request(app).put('/api/resumes/newgrad').send({ id: 'newgrad', label, extends: 'base' }).expect(200);

  beforeEach(() => {
    t = makeTempStore({ config: { git: { autoCommit: true }, ai: { enabled: false }, output: { dir: 'out', withinProject: true } } });
  });
  afterEach(() => t.cleanup());

  it('are never committed, and leave nothing to save', async () => {
    const repo = Repo.forStore(t.dir, () => currentIgnore(t.store));
    await repo.ensure();
    serve(repo);

    await compile();
    await edit('After one compile');
    await compile();
    await edit('After two');
    await request(app).post('/api/store/save').send({}).expect(200);

    expect(git('log', '--stat', '--format=%s')).not.toContain('.previews');
    expect(git('ls-files').split('\n').some((f) => f.startsWith('out/.previews/'))).toBe(false);
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('are taken out of a save that already has them, once, in a commit that says so', async () => {
    // A save from before: previews compiled and committed with everything else.
    const before = Repo.forStore(t.dir);
    await before.ensure();
    serve(before);
    await compile();
    await before.commitAll('Written before the previews were ignored');
    expect(git('ls-files').split('\n').some((f) => f.startsWith('out/.previews/'))).toBe(true);

    const repo = Repo.forStore(t.dir, () => currentIgnore(t.store));
    serve(repo);
    await compile();
    await edit('The first save after');
    await compile();
    await edit('And the next');

    expect(git('ls-files').split('\n').some((f) => f.startsWith('out/.previews/'))).toBe(false);
    const subjects = git('log', '--format=%s').split('\n');
    expect(subjects.filter((s) => s.startsWith('Stop keeping a history of rebuilt files'))).toEqual([
      'Stop keeping a history of rebuilt files (out/current/, out/.previews/)',
    ]);
    // Only that commit and the one that added them mention a preview.
    const touching = git('log', '--format=%s', '--', 'out/.previews').split('\n').filter(Boolean);
    expect(touching).toEqual([
      'Stop keeping a history of rebuilt files (out/current/, out/.previews/)',
      'Written before the previews were ignored',
    ]);
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
  });
});
