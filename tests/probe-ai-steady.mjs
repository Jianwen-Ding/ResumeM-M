/**
 * Does watching an AI run keep still while you watch it?
 *
 * The live view and the run list are both polled once a second. They used to
 * redraw wholesale, which is a second's worth of reading destroyed once a
 * second: the output pane jumped back to the top, the prompt fold snapped
 * shut, and a selection you were part-way through making was gone.
 *
 * Checked by node identity rather than by scroll position. Scroll only moves
 * if the pane happens to overflow, whereas "is this the same element the
 * browser was holding your place in" is the actual question — and it is the
 * same question for the fold and the selection.
 *
 *   node tests/probe-ai-steady.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const findChromium = () =>
  ['/opt/pw-browsers/chromium', '/usr/bin/chromium'].find((p) => fs.existsSync(p)) ?? 'chromium';

const freePort = () =>
  new Promise((done, fail) => {
    const probe = net.createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close(() => done(chosen));
    });
  });

let bad = 0;
const check = (what, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-steady-'));
// Says one thing, then keeps going, so the run is still live while we look.
const cli = path.join(dir, 'slow.cjs');
fs.writeFileSync(cli, `process.stdout.write('reading the posting\\n'); setTimeout(() => {}, 60000);`, 'utf8');

const port = await freePort();
const child = spawn('npx', ['tsx', 'src/server/index.ts'], {
  cwd: root,
  env: { ...process.env, RMM_DATA: dir, PORT: String(port), RMM_AUTOCOMMIT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const url = `http://127.0.0.1:${port}`;
let said = '';
child.stdout?.on('data', (d) => { said += d; });
child.stderr?.on('data', (d) => { said += d; });

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${url}/health`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server never came up\n${said.slice(0, 800)}`);
  await fetch(`${url}/api/projects/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: path.join(dir, 'store'), mode: 'create' }),
  });
  for (let i = 0; i < 60; i++) {
    const h = await fetch(`${url}/health`).then((r) => r.json()).catch(() => ({}));
    if (h.projectOpen) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await fetch(`${url}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai: { enabled: true, command: process.execPath, args: [cli], timeoutMs: 120_000 } }),
  });

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message ?? e).slice(0, 160)));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // A run that stays running, so both views have something live to poll.
    void fetch(`${url}/api/ai/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Why do you want to work here?' }),
    }).catch(() => undefined);

    await page.click('[data-tab="voice"]');
    const panel = page.locator('details.advanced', { hasText: 'what the AI has been running' });
    await panel.locator('summary').click();
    const row = page.locator('.ai-run').first();
    await row.waitFor({ timeout: 30_000 });
    await row.click();
    await page.locator('.ai-run-detail pre').first().waitFor({ state: 'attached', timeout: 30_000 });

    // Mark every pane and the fold, then leave it polling for several ticks.
    await page.evaluate(() => {
      document.querySelectorAll('.ai-run-detail pre').forEach((n, i) => { n.__mark = `pane${i}`; });
      const fold = document.querySelector('.ai-run-detail details.advanced');
      if (fold) { fold.open = true; fold.__mark = 'fold'; }
      const list = document.querySelector('.ai-runs');
      if (list?.firstElementChild) list.firstElementChild.__mark = 'row';
    });
    await page.waitForTimeout(4000); // four polls

    const after = await page.evaluate(() => ({
      panes: [...document.querySelectorAll('.ai-run-detail pre')].map((n) => n.__mark ?? null),
      fold: document.querySelector('.ai-run-detail details.advanced')?.__mark ?? null,
      open: document.querySelector('.ai-run-detail details.advanced')?.open ?? null,
      row: document.querySelector('.ai-runs')?.firstElementChild?.__mark ?? null,
      detailShown: !document.querySelector('.ai-run-detail')?.hidden,
    }));

    console.log('\nAfter four polls of the run list:');
    check('the row you opened is the same element', after.row === 'row', String(after.row));
    check('and is still open', after.detailShown === true, String(after.detailShown));
    // `length > 0` is load-bearing: with the panes gone the array is empty and
    // `every` is vacuously true, which is how this passed against the very
    // build it was written to catch.
    check(
      'the output panes are the same elements',
      after.panes.length > 0 && after.panes.every((m) => m !== null),
      JSON.stringify(after.panes),
    );
    check('the prompt fold is the same element', after.fold === 'fold', String(after.fold));
    check('and is still open', after.open === true, String(after.open));
    check('nothing was thrown', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
} finally {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(bad === 0 ? '\nsteady' : `\n${bad} wrong`);
process.exit(bad === 0 ? 0 : 1);
