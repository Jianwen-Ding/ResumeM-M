import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../src/server/api.js';
import { localOnly } from '../src/server/guard.js';
import { commandToAsk } from '../src/ai/models.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';

/*
 * Asking for models runs a program. It was a GET taking any `command`, and
 * `presetFor` matched on the basename alone — so `<img
 * src="http://127.0.0.1:4600/api/ai/models?command=/tmp/x/codex">` on any
 * page ran `/tmp/x/codex`, with no Origin check, because GETs get none.
 */

let t: TempStore | undefined;
const dirs: string[] = [];
afterEach(() => {
  t?.cleanup();
  t = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A "codex" somewhere that is not PATH, which says so on disk when it is run. */
function plantedCodex(): { bin: string; ran: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-evil-'));
  dirs.push(dir);
  const ran = path.join(dir, 'ran');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\ntouch ${JSON.stringify(ran)}\n`, { mode: 0o755 });
  return { bin, ran };
}

function app() {
  t = makeTempStore();
  const a = express();
  a.use(localOnly());
  a.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  return a;
}

describe('which command may be asked for its models', () => {
  it('is the configured one, or a known CLI by its bare name', () => {
    expect(commandToAsk(undefined, '/opt/bin/claude')).toBe('/opt/bin/claude');
    expect(commandToAsk('', 'claude')).toBe('claude');
    expect(commandToAsk('/opt/bin/claude', '/opt/bin/claude')).toBe('/opt/bin/claude');
    expect(commandToAsk('codex', 'claude')).toBe('codex');
    expect(commandToAsk('gemini', 'claude')).toBe('gemini');
  });

  it('is never a path that is not the configured one, or an unknown name', () => {
    expect(() => commandToAsk('/tmp/x/codex', 'claude')).toThrow(/not for a path/);
    expect(() => commandToAsk('./codex', 'claude')).toThrow();
    expect(() => commandToAsk('C:\\evil\\claude.exe', 'claude')).toThrow();
    expect(() => commandToAsk('rm', 'claude')).toThrow();
  });
});

describe('asking for models over HTTP', () => {
  it('is not a GET any more, so an image tag cannot run anything', async () => {
    const { bin, ran } = plantedCodex();
    await request(app())
      .get(`/api/ai/models?command=${encodeURIComponent(bin)}`)
      .set('Host', '127.0.0.1:4600')
      .expect(404);
    expect(fs.existsSync(ran)).toBe(false);
  });

  it('refuses a POST from another site', async () => {
    const { bin, ran } = plantedCodex();
    await request(app())
      .post('/api/ai/models')
      .set('Host', '127.0.0.1:4600')
      .set('Origin', 'https://evil.example')
      .send({ command: bin })
      .expect(403);
    expect(fs.existsSync(ran)).toBe(false);
  });

  it('refuses a command at a path that is not the configured one, without running it', async () => {
    const { bin, ran } = plantedCodex();
    const res = await request(app())
      .post('/api/ai/models')
      .set('Host', '127.0.0.1:4600')
      .send({ command: bin })
      .expect(400);
    expect(res.body.error).toMatch(/not for a path/);
    expect(fs.existsSync(ran)).toBe(false);
  });
});
