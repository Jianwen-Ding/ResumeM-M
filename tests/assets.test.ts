import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Assets } from '../src/ingest/assets.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore } from './helpers.js';
import * as agent from '../src/ai/agent.js';

const text = 'Built a Python data pipeline that processes daily sales reports and flags duplicate transactions.';
const fixtures: ReturnType<typeof makeTempStore>[] = [];
function setup(ai = false) {
  const t = makeTempStore({ config: { ai: { enabled: ai }, git: { autoCommit: false } } });
  fixtures.push(t);
  return { t, assets: new Assets(t.store, Repo.forStore(t.dir)) };
}
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach(t => t.cleanup()); });

describe('project assets', () => {
  it('preserves originals, sorts locally, stores a prompt when AI is off, and deduplicates bytes across filenames', async () => {
    const { t, assets } = setup();
    const first = await assets.import('../../notes.md', Buffer.from(text));
    expect(first.status).toBe('ready');
    expect(first.name).toBe('notes.md');
    expect(first.items[0]?.text).toBe(text);
    expect(first.prompt).toContain(text);
    expect(first.points).toEqual([]);
    expect(fs.readFileSync(path.join(t.dir, 'assets', first.original), 'utf8')).toBe(text);
    const second = await assets.import('duplicate.txt', Buffer.from(text));
    expect(second.id).toBe(first.id);
    expect(assets.list()).toHaveLength(1);
    expect(new Assets(t.store, Repo.forStore(t.dir)).get(first.id).prompt).toContain(text);
  });

  it('keeps a failed original and continues with other files', async () => {
    const { assets } = setup();
    const failed = await assets.import('broken.pdf', Buffer.from('this is not a pdf'));
    expect(failed.status).toBe('error');
    expect(fs.existsSync(path.join(assets.root, failed.original))).toBe(true);
    expect((await assets.import('notes.txt', Buffer.from(text))).status).toBe('ready');
    expect(assets.list()).toHaveLength(2);
  });

  it('only keeps points with exact evidence, then adds an edited reviewed point once', async () => {
    const { t, assets } = setup(true);
    vi.spyOn(agent, 'runAgent').mockImplementation(async (_config, prompt) => ({ executed: true,
      output: prompt.includes('Draft up to 8') ? JSON.stringify({ points: [
        { text: 'Built a Python pipeline for sales reports.', evidence: text },
        { text: 'Saved a million dollars.', evidence: 'Invented unsupported source quote' },
      ] }) : '{"items":[]}' }));
    const asset = await assets.import('project.md', Buffer.from(text));
    expect(asset.status).toBe('ready');
    expect(asset.points).toHaveLength(1);
    const point = asset.points[0]!;
    expect(t.store.load().entries.find(e => e.id === 'proj_thing')?.bullets).toHaveLength(1);
    const accepted = assets.accept(asset.id, point.id, 'proj_thing', 'Built a Python pipeline to flag duplicate sales transactions.');
    assets.accept(asset.id, point.id, 'proj_thing', 'Duplicate request');
    expect(accepted.points[0]?.entryId).toBe('proj_thing');
    const bullets = t.store.load().entries.find(e => e.id === 'proj_thing')?.bullets;
    expect(bullets).toHaveLength(2);
    expect(bullets?.[1]?.variants[0]?.note).toContain(text);
    expect(bullets?.[1]?.variants[0]?.text).toContain('duplicate sales');
  });

  it('preserves sorted material when generation fails and can retry', async () => {
    const { assets } = setup(true);
    const mock = vi.spyOn(agent, 'runAgent').mockResolvedValue({ executed: true, output: '{"items":[]}' });
    const asset = await assets.import('notes.txt', Buffer.from(text));
    expect(asset.status).toBe('error');
    expect(asset.text).toBe(text);
    mock.mockResolvedValue({ executed: true, output: JSON.stringify({ points: [{ text: 'Built a sales pipeline.', evidence: text }] }) });
    const retry = await assets.retry(asset.id);
    expect(retry.status).toBe('ready');
    expect(retry.error).toBeUndefined();
    expect(retry.points).toHaveLength(1);
  });

  it('scans opted-in inbox subfolders, ignores symlinks and partial writes, and imports each file once', async () => {
    const { assets } = setup();
    assets.configure(true, false);
    fs.mkdirSync(path.join(assets.inbox, 'projects'));
    const file = path.join(assets.inbox, 'projects', 'notes.md');
    fs.writeFileSync(file, text);
    await assets.scan();
    expect(assets.list()).toHaveLength(0);
    fs.utimesSync(file, new Date(0), new Date(0));
    fs.symlinkSync(file, path.join(assets.inbox, 'link.md'));
    await assets.scan(); await assets.scan();
    expect(assets.list()).toHaveLength(1);
    expect(assets.list()[0]?.prompt).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true);
  });
});
