import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as agent from '../src/ai/agent.js';
import { prepareProject, readProjects, rememberProject, setDefaultFolder } from '../src/model/projects.js';
import { startServer } from '../src/server/index.js';
import { makeTempStore } from './helpers.js';
import { Repo } from '../src/git/repo.js';

const temporary: string[] = [];
const fixtures: ReturnType<typeof makeTempStore>[] = [];
function setup() {
  const t = makeTempStore(); fixtures.push(t);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-projects-'))); temporary.push(dir);
  return { t, dir, dest: path.join(dir, 'new-project') };
}
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach(t => t.cleanup()); temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });

describe('project folders', () => {
  it('creates a blank portable project, without the example person, and remembers recent folders', () => {
    const { t, dir, dest } = setup();
    const next = prepareProject(t.store, dest, 'create');
    expect(next.load().entries).toEqual([]);
    expect(next.load().resumes[0]?.base).toBe(true);
    expect(next.outDir()).toBe(path.join(dest, 'out'));
    expect(fs.existsSync(path.join(dest, 'assets', 'inbox'))).toBe(true);
    const prefs = path.join(dir, 'prefs.json');
    rememberProject(t.dir, prefs); rememberProject(dest, prefs); rememberProject(dest, prefs);
    expect(readProjects(prefs)).toEqual({ active: dest, defaultFolder: null, recent: [dest, t.dir] });
  });

  it('moves content, history and legacy generated output, keeping the source intact', async () => {
    const { t, dest } = setup();
    const repo = Repo.forStore(t.dir); await repo.ensure(); await repo.commitAll('Original store');
    const hash = (await repo.log(1))[0]?.hash;
    fs.writeFileSync(path.join(t.store.outDir(), 'resume.pdf'), 'generated PDF');
    const next = prepareProject(t.store, dest, 'move');
    expect(next.load().profile).toEqual(t.store.load().profile);
    expect((await Repo.forStore(next.root).log(1))[0]?.hash).toBe(hash);
    expect(fs.readFileSync(path.join(next.outDir(), 'resume.pdf'), 'utf8')).toBe('generated PDF');
    next.saveProfile({ name: 'Only in new folder' });
    expect(t.store.load().profile.name).toBe('Test Person');
    expect(fs.existsSync(path.join(t.store.outDir(), 'resume.pdf'))).toBe(true);
  });

  it('rejects occupied, invalid, nested, and symlink-nested destinations', () => {
    const { t, dir, dest } = setup();
    fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'keep.txt'), 'keep');
    expect(() => prepareProject(t.store, dest, 'move')).toThrow('empty');
    expect(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8')).toBe('keep');
    expect(() => prepareProject(t.store, dest, 'open')).toThrow('not a resume save');
    expect(() => prepareProject(t.store, path.join(t.dir, 'nested'), 'move')).toThrow('outside');
    fs.symlinkSync(t.dir, path.join(dir, 'alias'));
    expect(() => prepareProject(t.store, path.join(dir, 'alias', 'nested'), 'create')).toThrow('outside');
  });

  it('switches API writes and health immediately; stale windows cannot save into the new project', async () => {
    const { t, dir, dest } = setup();
    const server = await startServer({ port: 0, dataDir: t.dir, preferencesFile: path.join(dir, 'prefs.json') });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const change = await fetch(`${base}/api/projects/switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: dest, mode: 'create' }) });
      expect(change.status).toBe(200);
      expect(await fetch(`${base}/health`).then(r => r.json())).toMatchObject({ dataDir: dest });
      const stale = await fetch(`${base}/api/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-RMM-Project': t.dir }, body: JSON.stringify({ name: 'Wrong window' }) });
      expect(stale.status).toBe(409);
      const save = await fetch(`${base}/api/profile?commit=0`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-RMM-Project': dest }, body: JSON.stringify({ name: 'New project person' }) });
      expect(save.status).toBe(200);
      expect(t.store.load().profile.name).toBe('Test Person');
      expect(await fetch(`${base}/api/store`).then(r => r.json())).toMatchObject({ profile: { name: 'New project person' } });
      const open = await fetch(`${base}/api/projects/switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: t.dir, mode: 'open' }) });
      expect(open.status).toBe(200);
      expect(await fetch(`${base}/api/store`).then(r => r.json())).toMatchObject({ profile: { name: 'Test Person' } });
    } finally { await server.close(); }
  });
  it('serves retained originals and blocks project changes until an import finishes', async () => {
    const { t, dir, dest } = setup();
    t.store.saveConfig({ ai: { ...t.store.loadConfig().ai, enabled: true } });
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(agent, 'runAgent').mockImplementation(async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return { executed: true, output: '{"items":[]}' };
    });
    const server = await startServer({ port: 0, dataDir: t.dir, preferencesFile: path.join(dir, 'prefs.json') });
    const base = `http://127.0.0.1:${server.port}`;
    const text = 'Built a Python data pipeline that processes sales reports and flags duplicate transactions.';
    let upload: Promise<Response> | undefined;
    try {
      upload = fetch(`${base}/api/assets/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'notes.md', data: Buffer.from(text).toString('base64'), generate: false }) });
      await began;
      const busy = await fetch(`${base}/api/projects/switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: dest, mode: 'create' }) });
      expect(busy.status).toBe(409);
      release();
      const result = await (await upload).json();
      expect(result.status).toBe('ready');
      expect(await fetch(`${base}/api/assets/${result.id}/original`).then(r => r.text())).toBe(text);
      expect(await fetch(`${base}/api/assets`).then(r => r.json())).toMatchObject({ assets: [{ id: result.id }] });
      const change = await fetch(`${base}/api/projects/switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: dest, mode: 'create' }) });
      expect(change.status).toBe(200);
      expect(await fetch(`${base}/api/assets`).then(r => r.json())).toMatchObject({ assets: [] });
    } finally { release?.(); await upload; await server.close(); }
  });

  /*
   * The empty-handed case: nothing recorded, and nothing at the default
   * location either. A save already sitting there is opened rather than
   * offered — see "choosing a save at startup" in server.test.ts — so what is
   * left here is the machine with no save on it at all, which has to refuse
   * every route that needs one rather than half-working.
   */
  it('starts with no save when there is none to open, and closes without deleting data', async () => {
    const { t, dir } = setup();
    const prefs = path.join(dir, 'prefs.json');
    const nowhere = path.join(dir, 'no-save-here');
    fs.mkdirSync(nowhere, { recursive: true });
    let server = await startServer({ port: 0, dataDir: nowhere, requireProjectSelection: true, preferencesFile: prefs });
    let base = `http://127.0.0.1:${server.port}`;
    const send = (route: string, body: unknown = {}) => fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      expect(await fetch(`${base}/health`).then(r => r.json())).toMatchObject({ projectOpen: false, dataDir: null, ai: { enabled: false } });
      expect(await fetch(`${base}/api/projects`).then(r => r.json())).toMatchObject({ current: null, suggested: null });
      // And nothing was conjured into the empty folder to avoid saying so.
      expect(fs.readdirSync(nowhere)).toEqual([]);
      for (const route of ['/api/store', '/api/assets', '/api/applications', '/pdf/test.pdf']) {
        expect((await fetch(`${base}${route}`)).status).toBe(409);
      }
      expect((await send('/assets/import', { name: 'not-saved.txt', data: 'SGVsbG8=' })).status).toBe(409);
      expect((await send('/projects/switch', { dir: t.dir, mode: 'open' })).status).toBe(200);
      expect(await fetch(`${base}/api/store`).then(r => r.json())).toMatchObject({ profile: { name: 'Test Person' } });
      expect((await send('/projects/close')).status).toBe(200);
      expect((await fetch(`${base}/api/store`)).status).toBe(409);
      expect(t.store.load().profile.name).toBe('Test Person');
      expect(readProjects(prefs).active).toBeUndefined();
      await server.close();
      server = await startServer({ port: 0, dataDir: t.dir, requireProjectSelection: true, preferencesFile: prefs });
      base = `http://127.0.0.1:${server.port}`;
      expect(await fetch(`${base}/health`).then(r => r.json())).toMatchObject({ projectOpen: false });
    } finally { await server.close(); }
  });

  it('opens only the configured default at startup, preserves it across switching, and supports Ask Me on Startup', async () => {
    const { t, dir, dest } = setup();
    const prefs = path.join(dir, 'prefs.json');
    prepareProject(undefined, dest, 'create');
    setDefaultFolder(t.dir, prefs);
    rememberProject(dest, prefs);
    let server = await startServer({ port: 0, dataDir: dest, requireProjectSelection: true, preferencesFile: prefs });
    let base = `http://127.0.0.1:${server.port}`;
    try {
      expect(await fetch(`${base}/api/projects`).then(r => r.json())).toMatchObject({ current: fs.realpathSync(t.dir), defaultFolder: fs.realpathSync(t.dir), openedBy: 'restored' });
      const changed = await fetch(`${base}/api/projects/default`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: dest }) });
      expect(changed.status).toBe(200);
      expect(await fetch(`${base}/health`).then(r => r.json())).toMatchObject({ dataDir: fs.realpathSync(t.dir) });
      await server.close();
      server = await startServer({ port: 0, requireProjectSelection: true, preferencesFile: prefs });
      base = `http://127.0.0.1:${server.port}`;
      expect(await fetch(`${base}/health`).then(r => r.json())).toMatchObject({ dataDir: dest });
      const invalid = await fetch(`${base}/api/projects/default`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: path.join(dir, 'missing') }) });
      expect(invalid.status).toBe(400);
      expect(readProjects(prefs).defaultFolder).toBe(dest);
      const clear = await fetch(`${base}/api/projects/default`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: null }) });
      expect(clear.status).toBe(200);
      await server.close();
      server = await startServer({ port: 0, requireProjectSelection: true, preferencesFile: prefs });
      base = `http://127.0.0.1:${server.port}`;
      expect(await fetch(`${base}/health`).then(r => r.json())).toMatchObject({ projectOpen: false });
    } finally { await server.close(); }
  });

  it('returns to the chooser if the default save disappears, without seeding example data', async () => {
    const { t, dir, dest } = setup();
    const prefs = path.join(dir, 'prefs.json');
    fs.writeFileSync(prefs, JSON.stringify({ active: t.dir, defaultFolder: dest, recent: [dest] }));
    const server = await startServer({ port: 0, dataDir: t.dir, requireProjectSelection: true, preferencesFile: prefs });
    try {
      const result = await fetch(`http://127.0.0.1:${server.port}/api/projects`).then(r => r.json());
      expect(result.current).toBeNull();
      expect(result.startupError).toContain('unavailable');
      expect(fs.existsSync(dest)).toBe(false);
      expect(t.store.load().profile.name).toBe('Test Person');
    } finally { await server.close(); }
  });

});
