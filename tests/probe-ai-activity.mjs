/**
 * See the AI activity panel work, against a real server and a real run.
 *
 * A scratch store, AI switched on, and a "CLI" of our own that prints, waits,
 * and is stopped for taking too long — which is the case the panel exists for.
 * Everything below reads the panel the way a person would: open Voice & AI,
 * open the Advanced disclosure, look.
 *
 *   node tests/probe-ai-activity.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const guess of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(guess)) return guess;
  }
  throw new Error('No Chromium found. Set CHROMIUM_PATH.');
}

const freePort = () =>
  new Promise((done, fail) => {
    const probe = net.createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close(() => done(chosen));
    });
  });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-activity-probe-'));
// A "coding agent" that says one thing and then sits there, which is exactly
// the shape of the run that produced the timeout this panel is about.
const cli = path.join(dir, 'slow-cli.cjs');
fs.writeFileSync(cli, `process.stdout.write('reading the posting\\n'); setTimeout(() => {}, 60000);`, 'utf8');

const port = await freePort();
// Note: no RMM_AI=0 — this probe is about an AI run really happening.
const child = spawn('npx', ['tsx', 'src/server/index.ts'], {
  cwd: root,
  env: { ...process.env, RMM_DATA: dir, PORT: String(port), RMM_AUTOCOMMIT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const url = `http://127.0.0.1:${port}`;
let serverSaid = '';
child.stdout?.on('data', (d) => { serverSaid += d; });
child.stderr?.on('data', (d) => { serverSaid += d; });

try {
  // Up at all first: a fresh RMM_DATA has no save in it, so `projectOpen` is
  // false until one is made.
  let answering = false;
  for (let i = 0; i < 60 && !answering; i++) {
    answering = await fetch(`${url}/health`).then((r) => r.ok).catch(() => false);
    if (!answering) await new Promise((r) => setTimeout(r, 500));
  }
  if (answering) {
    const store = path.join(dir, 'store');
    await fetch(`${url}/api/projects/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: store, mode: 'create' }),
    }).catch(() => undefined);
  }

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    const health = await fetch(`${url}/health`).then((r) => r.json()).catch(() => ({}));
    up = Boolean(health.projectOpen);
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`The probe server never came up on ${url}.\n${serverSaid.slice(0, 1200)}`);

  await fetch(`${url}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai: { enabled: true, command: process.execPath, args: [cli], timeoutMs: 4000 } }),
  });

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message ?? e).slice(0, 140)));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="voice"]');
    const panel = page.locator('details.advanced', { hasText: 'what the AI has been running' });
    await page.waitForTimeout(2500);
    // Hidden away until there is something to show, which on a fresh server
    // is nothing.
    console.log('panel on a fresh server is showing:', await panel.isVisible());

    // Two ways in, both appearing only while something is running: one beside
    // the clock on the button that started it, one in the header for every
    // action that does not draft into a panel at all.
    console.log('header peek before anything runs:', await page.locator('#ai-peek-chip').isVisible());
    await page.click('button:has-text("Save and test")');
    const peek = page.locator('.ai-peek');
    await peek.waitFor({ timeout: 20_000 });
    console.log('while a run is going, beside the clock:', JSON.stringify(await peek.innerText()));
    console.log('  and in the header:', await page.locator('#ai-peek-chip').isVisible());
    await peek.click();
    await page.locator('.ai-live-state').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    console.log('  it says     :', JSON.stringify((await page.locator('.ai-live-state').innerText()).trim()));
    const fold = page.locator('.ai-live details.advanced');
    console.log('  given (fold):', JSON.stringify((await fold.locator('summary').innerText()).trim()));
    await fold.locator('summary').click();
    console.log('  its prompt  :', JSON.stringify((await fold.locator('pre').innerText()).slice(0, 80)));
    await page.click('#modal-ok');
    await page.waitForTimeout(6000);
    console.log('panel once a run has happened:', await panel.isVisible());
    if (!(await panel.isVisible())) {
      console.log('  (so there is no way back to a finished run — that is the bug)');
    } else {
      await panel.locator('summary').click();
    }

    // Start a run that will be stopped, and watch the panel while it goes.
    void fetch(`${url}/api/ai/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Why do you want to work here?' }),
    }).catch(() => undefined);

    const row = page.locator('.ai-run').first();
    await row.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    console.log('while running :', JSON.stringify((await row.innerText()).replace(/\s+/g, ' ')));
    console.log('  classes     :', await row.getAttribute('class'));

    await row.click();
    // The prompt lives inside its own fold; open it before reading.
    const given = page.locator('.ai-run-detail details.advanced');
    console.log('  given (fold):', JSON.stringify((await given.locator('summary').innerText()).trim()));
    await given.locator('summary').click();
    console.log('  its prompt  :', JSON.stringify((await given.locator('pre').innerText()).slice(0, 90)));
    console.log('  its output  :', JSON.stringify((await page.locator('.ai-run-output').last().innerText()).slice(0, 90)));

    // And once it has been stopped for taking too long.
    await page.waitForTimeout(6000);
    console.log('after timeout :', JSON.stringify((await row.innerText()).replace(/\s+/g, ' ')));
    console.log('  classes     :', await row.getAttribute('class'));
    console.log('nothing thrown:', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
} finally {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
