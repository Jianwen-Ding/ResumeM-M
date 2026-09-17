/**
 * The editor, in a real browser, doing the things people come here to do.
 *
 * Everything under `tests/*.test.js` drives `web/app.js` in jsdom, which is
 * fast and catches a great deal — but jsdom has no layout, no real paint, no
 * pdf.js, and no opinion about whether a button is reachable. The extension
 * has been driven end to end in Chromium for a long time; this side has not,
 * and it is the side where the writing happens.
 *
 * Every step is timed. The budgets are loose on purpose: the point is to catch
 * a step going from one second to thirty, not to police a hundred
 * milliseconds on a shared machine.
 *
 *   node tests/editor.mjs                    # against a scratch store it makes
 *   RMM_SERVER=http://127.0.0.1:4788 node tests/editor.mjs   # against a server
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const timings = [];
async function timed(what, budgetMs, run) {
  const began = Date.now();
  const value = await run();
  const took = Date.now() - began;
  timings.push({ what, took, budgetMs });
  check(`${what} — ${(took / 1000).toFixed(1)}s`, took <= budgetMs, took > budgetMs ? `over ${budgetMs / 1000}s` : '');
  return value;
}

/** Chromium, wherever this machine keeps it. */
function findChromium() {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (fs.existsSync(browsers)) {
    for (const entry of fs.readdirSync(browsers)) {
      const guess = path.join(browsers, entry, 'chrome-linux', 'chrome');
      if (fs.existsSync(guess)) return guess;
    }
  }
  throw new Error('No Chromium found. Set CHROMIUM_PATH.');
}

/**
 * A server of our own, on a scratch store, unless one was named.
 *
 * Deliberately never the developer's own: this writes resumes, opens
 * applications and builds bundles, and doing that to somebody's real store
 * because they ran the tests would be unforgivable.
 */
async function serve() {
  if (process.env.RMM_SERVER) return { url: process.env.RMM_SERVER, close: async () => {} };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-editor-store-'));

  /*
   * A port nobody else has, asked of the operating system rather than
   * guessed.
   *
   * This picked at random from 4700-4899, and `stdio: 'ignore'` swallows the
   * EADDRINUSE when something is already there. The wait below then found a
   * perfectly healthy server on that port — somebody else's — and the run
   * carried on and wrote resumes, applications and bundles into their store.
   * On a machine with a scratch server in that range it happened about once
   * in forty runs, silently, and the comment above this function promises
   * exactly the opposite.
   */
  const port = await new Promise((done, fail) => {
    const probe = net.createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close(() => done(chosen));
    });
  });

  const child = spawn('npx', ['tsx', 'src/server/index.ts'], {
    cwd: root,
    env: { ...process.env, RMM_DATA: dir, PORT: String(port), RMM_AUTOCOMMIT: '0', RMM_AI: '0' },
    stdio: 'ignore',
  });

  /*
   * And it has to be *ours*. Between the probe closing and the server
   * binding there is a gap somebody could take the port in, so healthy is not
   * the question — whose is. `/health` names the folder it is serving.
   */
  const url = `http://127.0.0.1:${port}`;
  let mine = false;
  for (let attempt = 0; attempt < 60 && !mine; attempt++) {
    try {
      const res = await fetch(`${url}/health`);
      const health = res.ok ? await res.json() : {};
      if (health.projectOpen && health.dataDir === dir) mine = true;
      else if (health.projectOpen) {
        throw new Error(
          `Something else is already on port ${port}, serving ${health.dataDir}. ` +
            'Refusing to run against a store this test did not create.',
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Something else')) throw err;
      // Not up yet.
    }
    if (!mine) await new Promise((go) => setTimeout(go, 500));
  }
  if (!mine) throw new Error(`The test server never came up on ${url}.`);
  return {
    url,
    close: async () => {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function main() {
  const server = await serve();
  const health = await (await fetch(`${server.url}/health`)).json().catch(() => ({}));
  if (!health.projectOpen) {
    console.error(`${server.url} has no save open; nothing here can run.`);
    process.exit(2);
  }

  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  // The status alone says nothing about which call failed.
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });

  try {
    /* -------------------------------------------------------------- *
     * Opening it                                                      *
     * -------------------------------------------------------------- */

    console.log('\nOpening the editor');
    await timed('the page loads and lists the resumes', 30_000, async () => {
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      // `attached`: an <option> is never "visible" to a browser automation
      // tool, because a closed select does not render its children.
      await page.locator('#resume-select option').first().waitFor({ state: 'attached', timeout: 30_000 });
    });

    await page.locator('#tabs button[data-tab="resumes"]').click();
    await timed('the resume is laid out', 30_000, () =>
      page.locator('#editor .entry, #editor .bullet-row').first().waitFor({ timeout: 30_000 }),
    );

    /*
     * The preview is the thing that makes this a resume editor rather than a
     * YAML form, and it is a real LaTeX run followed by pdf.js. If it never
     * arrives the tool has no answer to "what will they see".
     */
    await timed('the resume compiles and is drawn', 90_000, () =>
      // The chip starts "idle" and loses that class when a real answer lands.
      page.waitForFunction(
        () => {
          const chip = document.querySelector('#fit');
          return chip && !chip.classList.contains('idle') && /page/i.test(chip.textContent ?? '');
        },
        null,
        { timeout: 90_000, polling: 100 },
      ),
    );
    const fit = (await page.locator('#fit').innerText()).trim();
    check('and says whether it fits the page', /page/i.test(fit), fit);
    /*
     * And drawn, which is a separate wait: the fit chip answers as soon as the
     * PDF exists, and pdf.js then has to paint it. "Compiled" and "on screen"
     * are seconds apart, and the second one is the one the user is waiting
     * for — so it is the one worth a number.
     */
    await timed('the page is painted on screen', 60_000, () =>
      page.locator('.pdf-pages canvas').first().waitFor({ state: 'attached', timeout: 60_000 }),
    );
    check('the preview is a drawn page, not a placeholder', (await page.locator('.pdf-pages canvas').count()) > 0);

    /* -------------------------------------------------------------- *
     * Changing what it says                                           *
     * -------------------------------------------------------------- */

    console.log('\nChanging what it says');
    const selector = page.locator('#resume-select');
    await selector.selectOption({ index: 1 });
    await page.locator('#editor .bullet-row, #editor .bullet').first().waitFor({ timeout: 30_000 });

    const boxes = page.locator('#editor input[type=checkbox]:not([disabled])');
    const boxCount = await boxes.count();
    check('there are selections to make', boxCount > 0, `${boxCount} toggles`);

    if (boxCount > 0) {
      await boxes.first().click();
      await timed('a selection is written to the save', 30_000, () =>
        page.locator('#save-state.saved').waitFor({ timeout: 30_000 }),
      );
      check('and the chip says so in words', (await page.locator('#save-state').innerText()).includes('saved'));

      /*
       * Undo is the thing the user reported as finicky, so it is checked where
       * they see it — the button in the toolbar, not the internal history.
       */
      const undo = page.locator('#btn-undo');
      await undo.waitFor({ timeout: 10_000 });
      check('undo offers itself once there is something to undo', !(await undo.isDisabled()));
      if (!(await undo.isDisabled())) {
        const wasChecked = await boxes.first().isChecked();
        await undo.click();
        await page.waitForTimeout(2500);
        const nowChecked = await page.locator('#editor input[type=checkbox]:not([disabled])').first().isChecked();
        check('and pressing it puts the selection back', nowChecked !== wasChecked, `${wasChecked} → ${nowChecked}`);
      }
    }

    /* -------------------------------------------------------------- *
     * Keeping it as its own resume                                     *
     * -------------------------------------------------------------- */

    console.log('\nSaving it as a variation');
    {
      /*
       * The modal asked for an id first, in the focused field, and told you
       * what it inherits from by that resume's id rather than its name — so
       * it read `Inherits from "newgrad"` about a resume called "New grad".
       */
      await page.locator('#btn-save-as').click();
      await page.locator('#modal:not(.hidden)').waitFor({ timeout: 10_000 });

      const note = (await page.locator('#modal-note').innerText()).trim();
      check('the note names the parent as you call it', !/"[a-z0-9-]+"/.test(note), note);

      const firstLabel = (await page.locator('#modal-content .lbl, #modal-content label').first().innerText()).trim();
      check('the first thing it asks for is a name', /name/i.test(firstLabel), firstLabel);

      const focused = await page.evaluate(() => document.activeElement?.name ?? null);
      check('and that is the field you land in', focused === 'label', String(focused));

      // Clearing the filename used to close the modal and save nothing at all.
      await page.locator('#f_label').fill('Kafka-heavy variation');
      await page.locator('#f_id').fill('');
      await page.locator('#modal-ok').click();
      await page.waitForTimeout(2500);

      const resumes = await (await fetch(`${server.url}/api/resumes`)).json();
      const made = resumes.find((r) => r.label === 'Kafka-heavy variation');
      check('an emptied filename still saves, named from what you typed', Boolean(made), made?.id ?? 'not saved');
    }

    /* -------------------------------------------------------------- *
     * Writing an application                                          *
     * -------------------------------------------------------------- */

    console.log('\nWriting an application');
    await page.locator('#tabs button[data-tab="workspace"]').click();
    await page.locator('#btn-new-draft').waitFor({ timeout: 15_000 });

    page.once('dialog', (d) => d.accept());
    const created = await page.evaluate(async (base) => {
      const res = await fetch(`${base}/api/workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: 'Halcyon',
          role: 'Platform Engineer',
          source: 'by hand',
          coverLetterRequired: true,
          questions: [{ question: 'Why this team?', required: true }],
        }),
      });
      return (await res.json()).draft;
    }, server.url);
    check('an application can be opened', Boolean(created?.id), created?.id);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#tabs button[data-tab="workspace"]').click();
    await timed('it appears in the workspace', 30_000, () =>
      page.locator('.draft-card', { hasText: 'Halcyon' }).first().waitFor({ timeout: 30_000 }),
    );

    await page.locator('.draft-card', { hasText: 'Halcyon' }).first().click();
    await page.locator('#draft-editor .letter').waitFor({ timeout: 20_000 });

    // The chip has to exist before it can be watched, and the panel finishes
    // rendering a moment after the textarea appears in it.
    await page.locator('#draft-save-state').waitFor({ timeout: 20_000 });

    const LETTER = 'Dear Halcyon, I spent last year running the ingest path end to end.';
    // Typed rather than filled: `fill` sets the value and fires one event,
    // which is not what writing a letter looks like, and the difference
    // matters for anything that debounces.
    await page.locator('#draft-editor .letter').click();
    await page.locator('#draft-editor .letter').pressSequentially(LETTER, { delay: 8 });

    /*
     * The letter is saved as it is typed, with no blur and no button. This is
     * the one that used to lose twenty minutes of writing to a page reload, so
     * it is checked by reloading the page.
     */
    /*
     * Polled on an interval rather than on animation frames, which headless
     * Chromium throttles hard: the dirty state lasts under a second, and
     * `waitForFunction`'s default polling missed it every time.
     *
     * Through "Unsaved changes" and out the other side. The chip reads "All
     * changes saved" before anything is typed — truthfully — so waiting only
     * for that wording is waiting for a state that was already there.
     */
    await timed('what is typed is written without being asked', 20_000, async () => {
      await page.waitForFunction(
        () => /Unsaved/i.test(document.querySelector('#draft-save-state')?.textContent ?? ''),
        null,
        { timeout: 20_000, polling: 100 },
      );
      await page.waitForFunction(
        () => /All changes saved/i.test(document.querySelector('#draft-save-state')?.textContent ?? ''),
        null,
        { timeout: 20_000, polling: 100 },
      );
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#tabs button[data-tab="workspace"]').click();
    await page.locator('.draft-card', { hasText: 'Halcyon' }).first().click();
    await page.locator('#draft-editor .letter').waitFor({ timeout: 20_000 });
    check(
      'and is still there after a reload',
      (await page.locator('#draft-editor .letter').inputValue()) === LETTER,
      (await page.locator('#draft-editor .letter').inputValue()).slice(0, 40),
    );

    const answer = page.locator('#draft-editor textarea').nth(1);
    if ((await answer.count()) > 0) {
      await answer.click();
      await answer.pressSequentially('Because the ingest work is the part I like.', { delay: 8 });
      await page.waitForFunction(
        () => /All changes saved/i.test(document.querySelector('#draft-save-state')?.textContent ?? ''),
        null,
        { timeout: 20_000, polling: 100 },
      );
      check('so is an answer', true);
    }

    /* -------------------------------------------------------------- *
     * Sending it                                                      *
     * -------------------------------------------------------------- */

    console.log('\nSending it');

    /*
     * An application with no resume on it cannot be built, and pressing the
     * button used to answer with a bare "400 Bad Request" in the corner.
     * Which resume to send is the decision this whole tool exists to help
     * with, so it is asked for rather than guessed at.
     */
    const build = page.locator('#draft-editor button', { hasText: 'Build files and record it' });
    check('a draft with no resume cannot be built', await build.isDisabled());
    check(
      'and says what is missing, rather than failing when pressed',
      /choose a resume/i.test(await page.locator('#draft-editor').innerText()),
    );

    /*
     * Attached the way the panel offers it: the "Send" picker. The other two
     * routes are tailoring, which needs posting text this application does
     * not have, and starting a variation, which leaves for the builder.
     */
    const sendPicker = page.locator('#draft-editor select').first();
    check('the picker admits that nothing is chosen yet', (await sendPicker.inputValue()) === '');
    await sendPicker.selectOption({ index: 1 });

    await timed('choosing one unlocks building the files', 30_000, () =>
      page.waitForFunction(
        () => {
          const button = [...document.querySelectorAll('#draft-editor button')].find(
            (b) => b.textContent.includes('Build files and record it'),
          );
          return button && !button.disabled;
        },
        null,
        { timeout: 30_000, polling: 100 },
      ),
    );

    const complete = page.locator('#draft-editor button', { hasText: /Build files and record it|Complete/ });
    if ((await complete.count()) > 0) {
      await complete.first().click();
      /*
       * Waited for by asking the tracker, not by reading the panel. What the
       * panel says when it finishes is a wording decision that will change;
       * whether the application was recorded is the thing being tested.
       */
      /*
       * Waited for by asking what is in the upload folder, which is the thing
       * the user is about to point a file picker at. Not by the application
       * appearing in the tracker: opening a workspace records it as "applying"
       * straight away, so it is there before the button is even pressed.
       */
      const files = await timed('the files are built and put where they go', 120_000, async () => {
        const until = Date.now() + 120_000;
        while (Date.now() < until) {
          // The flat upload folder is reported alongside the tracker, which is
          // where the Applications tab reads it from too.
          const tracked = await (await fetch(`${server.url}/api/applications`)).json().catch(() => ({}));
          if ((tracked.current?.files ?? []).length) return tracked.current.files;
          await page.waitForTimeout(500);
        }
        return [];
      });
      check('the resume is there, named for the person', files.some((f) => /-Resume\.pdf$/.test(f)), files.join(', ') || '(none)');
      check('so is the cover letter that was written', files.some((f) => /-Cover-Letter\.pdf$/.test(f)), files.join(', '));

      const tracked = await (await fetch(`${server.url}/api/applications`)).json();
      const halcyon = (tracked.applications ?? []).find((a) => a.company === 'Halcyon');
      check('and the application carries the answer that was given', 
        (halcyon?.answers ?? []).some((a) => /ingest work/i.test(a.answer ?? '')),
        JSON.stringify(halcyon?.answers ?? []).slice(0, 80));
    } else {
      check('there is a way to finish the application', false, 'no button');
    }

    check('nothing threw along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }

  console.log('\nTimings');
  for (const t of timings) {
    console.log(`  ${String((t.took / 1000).toFixed(1)).padStart(6)}s  (budget ${t.budgetMs / 1000}s)  ${t.what}`);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
