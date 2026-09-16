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
    env: { ...process.env, PATH: config.path, RMM_DATA: store, PORT: '0' },
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
  assert.equal(health.dataDir, store);
  for (const asset of ['/', '/app.js', '/style.css', '/vendor/pdf.min.mjs', '/api/store']) {
    const response = await fetch(`${url}${asset}`);
    assert.equal(response.status, 200, `Missing packaged asset: ${asset}`);
    await response.arrayBuffer();
  }
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, 'Server did not exit cleanly after its native parent closed');
  console.log('Packaged server: startup, store, editor assets, API, and parent-exit cleanup passed.');
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await fs.rm(temporary, { recursive: true, force: true });
}
