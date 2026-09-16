import express from 'express';
import path from 'node:path';
import type { Assets } from '../ingest/assets.js';
import { withCommit } from '../git/repo.js';

export function assetsApi(assets: Assets): express.Router {
  const api = express.Router();
  const route = (fn: (req: express.Request, res: express.Response) => unknown) =>
    (req: express.Request, res: express.Response) => Promise.resolve().then(() => fn(req, res)).catch(error => res.status(400).json({ error: error.message })).finally(() => res.locals.finishProjectRequest?.());
  api.get('/', route((_req, res) => res.json({ assets: assets.list().map(({ text, prompt, ...a }) => ({ ...a, hasPrompt: Boolean(prompt) })), inbox: assets.inbox, settings: assets.settings() })));
  api.put('/settings', route((req, res) => { assets.configure(req.body.watch === true, req.body.generate !== false); res.json(assets.settings()); }));
  api.post('/import', route(async (req, res) => {
    if (typeof req.body.name !== 'string' || typeof req.body.data !== 'string') throw new Error('A filename and file data are required');
    res.json(await assets.import(req.body.name, Buffer.from(req.body.data, 'base64'), req.body.generate !== false));
  }));
  api.get('/:id', route((req, res) => res.json(assets.get(String(req.params.id)))));
  api.get('/:id/original', route((req, res) => {
    const asset = assets.get(String(req.params.id));
    res.download(path.join(assets.root, asset.original), asset.name);
  }));
  api.post('/:id/generate', route(async (req, res) => res.json(await assets.retry(String(req.params.id)))));
  api.post('/:id/points/:pointId/accept', route(async (req, res) => {
    const result = await withCommit(assets.repo, assets.store.loadConfig().git.autoCommit, 'Add reviewed point from asset', () =>
      assets.accept(String(req.params.id), String(req.params.pointId), req.body.entryId, req.body.text));
    res.json(result);
  }));
  return api;
}
