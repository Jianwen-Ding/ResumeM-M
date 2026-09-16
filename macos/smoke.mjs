// Exercise the actual packaged server against a disposable store, including
// the parent-pipe lifecycle used by the native window. Never opens user data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const bundle = path.resolve(process.argv[2] ?? 'dist/macos/ResumeM-M.app');
const resources = path.join(bundle, 'Contents', 'Resources');
const config = JSON.parse(await fs.readFile(path.join(resources, 'configuration.json'), 'utf8'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rmm-desktop-smoke-'));
let child;
try {
  const store = path.join(temporary, 'store');
  child = spawn(config.node, [path.join(resources, 'server', 'bootstrap.mjs')], {
    cwd: path.join(resources, 'server'),
    env: { ...process.env, PATH: config.path, RMM_DATA: store, RMM_PROJECTS_FILE: path.join(temporary, 'preferences.json'), PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const exited = once(child, 'exit');
  const deadline = Date.now() + 15000;
  while (!output.includes('ResumeM-M → http:')) {
    assert(child.exitCode === null && Date.now() < deadline, `Server failed to start:\n${output}`);
    await delay(100);
  }
  const url = output.match(/ResumeM-M → (http:\/\/[^\s]+)/)[1];
  const health = await fetch(`${url}/health`).then((response) => response.json());
  assert.equal(health.service, 'resumem-m');
  assert.equal(health.dataDir, null);
  assert.equal(health.projectOpen, false);
  assert.equal((await fetch(`${url}/api/store`)).status, 409);
  const created = await fetch(`${url}/api/projects/switch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: store, mode: 'create' }),
  });
  assert.equal(created.status, 200);
  const data = await fetch(`${url}/api/store`).then(r => r.json());
  assert.equal(data.profile.name, 'Your Name');
  assert.equal(data.entries.length, 0);
  const { presets } = await fetch(`${url}/api/ai/presets`).then(r => r.json());
  const agy = presets.find(preset => preset.command === 'agy');
  assert(agy?.args.includes('--print={promptText}'), 'Missing Antigravity print preset');
  for (const asset of ['/', '/app.js', '/assets.js', '/feedback.js', '/vendor/marked.js', '/vendor/purify.mjs', '/api/projects', '/api/assets', '/style.css', '/vendor/pdf.min.mjs', '/api/store']) {
    const response = await fetch(`${url}${asset}`);
    assert.equal(response.status, 200, `Missing packaged asset: ${asset}`);
    await response.arrayBuffer();
  }
  assert.equal((await fetch(`${url}/api/projects/close`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${url}/api/store`)).status, 409);
  const editor = await fetch(url).then(response => response.text());
  assert(editor.includes('data-tab="resumes"'), 'Missing unified Resumes workspace');
  assert(!editor.includes('data-tab="master"'), 'Unexpected separate Master tab');
  assert(!editor.includes('data-tab="build"'), 'Unexpected separate Build tab');
  assert(editor.includes('id="feedback-panel"'), 'Missing feedback panel below the preview');
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, 'Server did not exit cleanly after its native parent closed');
  console.log('Packaged server: empty startup, save creation/closing, editor assets, API, and parent-exit cleanup passed.');
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await fs.rm(temporary, { recursive: true, force: true });
}
