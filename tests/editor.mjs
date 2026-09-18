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

    /** The ids the editor is showing, in the order it is showing them. */
    const shown = (selector) => page.$$eval(selector, (rows) => rows.map((r) => r.dataset.dragId));

    /*
     * The one invariant underneath all of these: the list on the screen is
     * the document that will print.
     *
     * Every bug in this area has been a version of the two disagreeing. A
     * drag that moved the PDF and not the editor. A saved bullet reorder
     * that emptied a section out of the editor while the PDF went on
     * printing it. Each was found by hand, reported as something else, and
     * each was invisible to a test that only looked at one side.
     *
     * So this asks both and compares. `#editor > [data-drag-id]` is exactly
     * the entries this resume includes, in the order it shows them — the
     * ones it leaves out are drawn without a drag id, because an entry with
     * no position cannot be moved. `/resolved` is what the renderer will be
     * handed. They have to be the same sequence, entry for entry and line
     * for line, or one of the two is lying.
     */
    const sameAsDocument = async (when) => {
      const id = await page.locator('#resume-select').inputValue();
      const onScreen = await page.evaluate(() =>
        [...document.querySelectorAll('#editor > [data-drag-id]')].map((e) => ({
          id: e.dataset.dragId,
          lines: [...e.querySelectorAll('.bullet:not(.off)')].map((x) => x.dataset.dragId ?? '?'),
        })),
      );
      const resolved = await (await fetch(`${server.url}/api/resumes/${encodeURIComponent(id)}/resolved`)).json();
      const inDocument = (resolved.sections ?? []).flatMap((s) =>
        (s.entries ?? []).map((e) => ({ id: e.id, lines: (e.bullets ?? []).map((b) => b.id) })),
      );

      const say = (list) => list.map((e) => `${e.id}[${e.lines.join(' ')}]`).join(' ');
      const agree = JSON.stringify(onScreen) === JSON.stringify(inDocument);
      check(`the editor and the document agree — ${when}`, agree,
        agree ? '' : `screen: ${say(onScreen)} | document: ${say(inDocument)}`);
    };

    /* -------------------------------------------------------------- *
     * Arranging it                                                     *
     * -------------------------------------------------------------- *
     * Dates, dragging and folding were all added without ever being run
     * in a browser, and the user found two of them broken by hand: the
     * date control was still a text box on one screen, and dragging a
     * bullet moved the PDF without moving the list. Both were invisible
     * to jsdom — the first because jsdom renders whatever it is given and
     * has no opinion about whether it is a control, the second because
     * the editor drew from the saved order and the test read the saved
     * order too, so the two agreed with each other and not with the
     * screen.
     *
     * So these read the screen. Every check below asks what the editor is
     * showing after the gesture, and only then what got written down.
     * -------------------------------------------------------------- */

    console.log('\nArranging it');
    await page.locator('#tabs button[data-tab="resumes"]').click();
    await page.locator('#editor .entry').first().waitFor({ timeout: 30_000 });
    await sameAsDocument('before anything is moved');

    /*
     * A date is a control, not a string.
     *
     * Reported twice — "The dates still use text", then "Graduation dates
     * still are not ui elements" — because the entry editor was converted
     * and the two other places a date is shown were not. This asks the
     * question the user was really asking: is there anywhere left in the
     * editor that takes a date as free text?
     */
    {
      const dated = page.locator('#editor .entry .dates').first();
      const anyDates = await page.locator('#editor .entry .dates').count();
      check('an entry offers its date as a control', anyDates > 0, `${anyDates} date controls`);

      if (anyDates > 0) {
        check('with a month to pick', (await dated.locator('select.date-month').count()) > 0);
        check('and a year to type', (await dated.locator('input.date-year').count()) > 0);

        /*
         * The one that keeps regressing: a text input whose value looks like
         * a date. `.date-year` is a number field and is not one of these.
         */
        const freeText = await page.evaluate(() =>
          [...document.querySelectorAll('#editor input[type=text], #editor textarea')]
            .filter((i) => /date|20\d\d\s*[-–—]|present/i.test(`${i.value} ${i.placeholder} ${i.title}`))
            .map((i) => i.title || i.placeholder || i.value)
            .slice(0, 3),
        );
        check('and no date left as a box you type a date into', freeText.length === 0, freeText.join(' | '));
      }
    }

    /*
     * Moving the date moves the words. The server decides the spelling —
     * see `withDatesFrom` — so this is the round trip that proves the
     * control, the save and the formatter are one path and not three.
     */
    {
      const before = await (await fetch(`${server.url}/api/store`)).json();
      const target = (before.entries ?? []).find((e) => e.period?.start?.year && typeof e.dates === 'string');

      if (!target) {
        check('there is a dated entry to move', false, 'none in the starter save');
      } else {
        const said = target.dates;
        const wasYear = target.period.start.year;
        const moved = String(wasYear === 2001 ? 2002 : 2001);

        const year = page.locator(`#editor .entry[data-drag-id="${target.id}"] .dates input.date-year`).first();
        await year.waitFor({ timeout: 10_000 });
        await year.fill(moved);
        await year.blur();
        await page.waitForTimeout(3000);

        const after = await (await fetch(`${server.url}/api/store`)).json();
        const now = (after.entries ?? []).find((e) => e.id === target.id);
        check('typing a year moves the date itself', String(now?.period?.start?.year) === moved,
          `${wasYear} → ${now?.period?.start?.year}`);
        check('and the words that print say the new year', String(now?.dates ?? '').includes(moved),
          `${said} → ${now?.dates}`);

        /*
         * And a range that runs backwards. The control cannot refuse it —
         * moving both ends means passing through a state where only one has
         * moved — so the whole of the defence is that somebody is told, in
         * the two places they are looking: beside the control while they are
         * still on the dates, and in the resume's warnings afterwards.
         */
        if (now?.period?.end?.year) {
          const backwards = String(now.period.end.year + 2);
          await year.fill(backwards);
          await year.blur();
          await page.waitForTimeout(3000);

          const note = page.locator(`#editor .entry[data-drag-id="${target.id}"] .dates .date-wrong`);
          check('a range that ends before it starts says so beside the dates',
            (await note.count()) === 1, await note.innerText().catch(() => '(absent)'));

          /*
           * Waited for rather than slept on: this one arrives with the next
           * compile, and a fixed pause either flakes on a slow machine or
           * wastes the time on a fast one.
           */
          const warned = await page
            .waitForFunction(
              () => (/ends before it starts/i.test(document.querySelector('#warnings')?.textContent ?? '') ? true : null),
              null,
              { timeout: 60_000, polling: 250 },
            )
            .then(() => true)
            .catch(() => false);
          check('and the resume says it too, where the page is checked', warned,
            warned ? '' : (await page.locator('#warnings').innerText().catch(() => '')) || '(no warnings)');

          // Nothing was refused and nothing rewritten — the date it was
          // given is the date it kept.
          const bad = await (await fetch(`${server.url}/api/store`)).json();
          check('and the date it was given is the date it kept',
            String(bad.entries.find((e) => e.id === target.id)?.period?.start?.year) === backwards);

          // Put it back, so the rest of the run is not working on a resume
          // with a known-bad date in it.
          await year.fill(String(wasYear));
          await year.blur();
          await page.waitForTimeout(2500);
          check('and fixing it clears the note',
            (await page.locator(`#editor .entry[data-drag-id="${target.id}"] .dates .date-wrong`).count()) === 0);
        }
      }
    }

    /*
     * Dragging, done as the browser does it.
     *
     * Playwright's `dragTo` sends mouse events, and this is HTML5 drag and
     * drop — a different set of events entirely, which `dragTo` never
     * fires. Driving it with mouse events would report a pass on a handle
     * that does nothing, which is precisely the bug being tested for. So
     * the real events are dispatched, with one DataTransfer shared across
     * them as a browser shares it.
     *
     * This proves the handlers, not the operating system's drag. What it
     * cannot tell you is whether Chromium will start a drag on that
     * element at all; what it can tell you — and what was wrong — is
     * whether landing a drop rearranges what you are looking at.
     */
    const dragOnto = (fromId, ontoId, kind, side) =>
      page.evaluate(
        ({ fromId, ontoId, kind, side }) => {
          const grip = document.querySelector(`[data-drag-id="${fromId}"] .grip[data-drag-kind="${kind}"]`);
          const onto = document.querySelector(`[data-drag-id="${ontoId}"]`);
          if (!grip || !onto) return false;
          const dt = new DataTransfer();
          const ev = (type, on, y) =>
            on.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
          const box = onto.getBoundingClientRect();
          const y = side === 'after' ? box.bottom - 2 : box.top + 2;
          ev('dragstart', grip);
          ev('dragover', onto, y);
          ev('drop', onto, y);
          ev('dragend', grip);
          return true;
        },
        { fromId, ontoId, kind, side },
      );


    {
      /*
       * Two entries of one section. Flat in `#editor` with headings
       * between them, so "same section" is "nothing but entries in
       * between" rather than a parent element.
       */
      const pair = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#editor > *')];
        for (let i = 0; i < rows.length - 1; i++) {
          const a = rows[i];
          const b = rows[i + 1];
          if (!a.dataset?.dragId || !b.dataset?.dragId) continue;
          if (!a.querySelector('.grip[data-drag-kind="entry"]')) continue;
          if (!b.querySelector('.grip[data-drag-kind="entry"]')) continue;
          return [a.dataset.dragId, b.dataset.dragId];
        }
        return null;
      });

      if (!pair) {
        check('there are two entries to rearrange', false, 'no section has two');
      } else {
        const [first, second] = pair;
        const was = await shown('#editor > [data-drag-id]');
        const dropped = await dragOnto(first, second, 'entry', 'after');
        check('an entry can be picked up', dropped);
        await page.waitForTimeout(1200);

        const now = await shown('#editor > [data-drag-id]');
        check('and dropping it moves it on the screen, not only in the file',
          now.indexOf(first) > now.indexOf(second),
          `${was.slice(0, 3).join(', ')} → ${now.slice(0, 3).join(', ')}`);

        /*
         * Dragging is an instruction, and the sort would undo it — so the
         * sort turns itself off and says so. A handle that visibly does
         * nothing is worse than no handle.
         */
        /*
         * That section's control, not the first one on the page. Sections
         * are flat children of `#editor` with a heading in front of each,
         * so the one that governs an entry is the nearest heading above
         * it — reading `.first()` asked education about a drag in
         * projects, and got a truthful answer to the wrong question.
         */
        const order = await page.evaluate((id) => {
          let node = document.querySelector(`#editor > [data-drag-id="${id}"]`);
          while (node && !node.classList?.contains('section-heading')) node = node.previousElementSibling;
          return node?.querySelector('select.order-by')?.value ?? '(no control)';
        }, first);
        check('and the date sort steps aside for a hand arrangement', order === 'manual', order);

        await page.locator('#save-state.saved').waitFor({ timeout: 30_000 });
        const openId = await page.locator('#resume-select').inputValue();
        const saved = await (await fetch(`${server.url}/api/resumes`)).json();
        const spec = saved.find((r) => r.id === openId);
        const list = (spec?.sections ?? []).map((s) => s.entries ?? []).find((e) => e.includes(first) && e.includes(second));
        check('and the save agrees with the screen', !list || list.indexOf(first) > list.indexOf(second),
          (list ?? []).slice(0, 4).join(', '));
      }
    }

    {
      /*
       * The one the user called completely useless. Same gesture, one
       * level down — and the level where it was broken, because bullets
       * were drawn in the store's order while entries were drawn in the
       * resume's.
       *
       * On a fresh page, deliberately. Everything above this has already
       * made edits, and an edit to which entries a section shows makes the
       * next save write the entry list down — which is exactly the thing
       * whose absence caused the damage. Run straight after those, a
       * bullet drag saves a section that happens to carry entries anyway
       * and looks perfectly safe; run as somebody actually does it, on a
       * page they just opened, it saves bullets alone. Falsifying this
       * against the old merge is what showed the difference: the check
       * below passed on the broken build until the reload was added.
       */
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#tabs button[data-tab="resumes"]').click();
      await page.locator('#editor .entry').first().waitFor({ timeout: 30_000 });

      const pair = await page.evaluate(() => {
        for (const entry of document.querySelectorAll('#editor .entry')) {
          const rows = [...entry.querySelectorAll('[data-drag-id]')].filter((r) =>
            r.querySelector('.grip[data-drag-kind="bullet"]'),
          );
          if (rows.length >= 2) return [rows[0].dataset.dragId, rows[1].dataset.dragId, entry.dataset.dragId];
        }
        return null;
      });

      if (!pair) {
        check('there are two lines to rearrange', false, 'no entry has two');
      } else {
        const [first, second, inEntry] = pair;
        const rows = `#editor .entry[data-drag-id="${inEntry}"] [data-drag-id]`;
        const was = await shown(rows);
        await dragOnto(first, second, 'bullet', 'after');
        await page.waitForTimeout(1200);

        const now = await shown(rows);
        check('dragging a line moves it where you dropped it',
          now.indexOf(first) > now.indexOf(second),
          `${was.slice(0, 3).join(', ')} → ${now.slice(0, 3).join(', ')}`);

        /*
         * And it is still that way after a reload, which is the half this
         * check did not have and the half that was broken.
         *
         * The entry version of this drag asserted against the saved spec;
         * the bullet version asserted only against the screen, so it passed
         * for weeks while saving a bullet reorder deleted every entry in the
         * section from the editor on the next load. The editor merged an
         * inherited section by replacing it with the child's rather than
         * laying the child over it, and a saved bullet reorder is precisely
         * a child that mentions bullets and no entries. The PDF, built by
         * the server, went on printing them — so the screen and the document
         * disagreed and the screen was the wrong one.
         */
        await page.locator('#save-state.saved').waitFor({ timeout: 30_000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#tabs button[data-tab="resumes"]').click();
        await page.locator('#editor .entry').first().waitFor({ timeout: 30_000 });

        const kept = await shown(rows);
        check('the entry it belongs to is still in the resume after a reload',
          kept.length >= now.length, `${now.length} lines → ${kept.length}`);
        check('and the line is still where it was dropped',
          kept.indexOf(first) > kept.indexOf(second) && kept.includes(first),
          kept.join(', ') || '(the entry is gone)');
        await sameAsDocument('after a line was dragged and the page reloaded');

        /*
         * The same shape, reached the commoner way.
         *
         * Hiding a line writes the same thing a reorder does — this
         * resume's bullet list for that entry, and no entry list — so it
         * met the same broken merge and emptied the section out of the
         * editor in exactly the same way. Dragging is the rarer action of
         * the two; this is the one somebody does every time they trim a
         * resume to fit, which makes it the one worth holding down.
         */
        const box = page.locator(`#editor .entry[data-drag-id="${inEntry}"] .bullet:not(.off) input[type=checkbox]`).first();
        if (await box.count()) {
          await box.click();
          await page.locator('#save-state.saved').waitFor({ timeout: 30_000 });
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.locator('#tabs button[data-tab="resumes"]').click();
          await page.locator('#editor .entry').first().waitFor({ timeout: 30_000 });

          const there = await page.locator(`#editor .entry[data-drag-id="${inEntry}"]`).count();
          check('hiding a line leaves the entry it belongs to in the resume', there === 1, `${there} found`);
          const lines = await shown(`#editor .entry[data-drag-id="${inEntry}"] [data-drag-id]`);
          check('and the lines that were not hidden are still on it', lines.length > 0, lines.join(', ') || '(none)');
          await sameAsDocument('after a line was hidden and the page reloaded');
        }
      }
    }

    {
      /*
       * The keyboard half of the same handle. It exists because a drag is
       * not reachable without a mouse, and it is the path least likely to
       * be exercised by hand — so it is the one most worth a check.
       */
      const grips = page.locator('#editor .grip[data-drag-kind="entry"]');
      if ((await grips.count()) >= 2) {
        const before = await shown('#editor > [data-drag-id]');
        const last = before[before.length - 1];
        await page.locator(`#editor [data-drag-id="${last}"] .grip`).first().focus();
        await page.keyboard.press('Alt+ArrowUp');
        await page.waitForTimeout(1200);
        const after = await shown('#editor > [data-drag-id]');
        check('Alt with an arrow moves an entry without a mouse',
          after.indexOf(last) < before.indexOf(last),
          `${before.indexOf(last)} → ${after.indexOf(last)}`);
      }
    }

    {
      /*
       * Folding. The point of it is an entry that is switched *on* — the
       * ones switched off already collapse — so the check is that the
       * lines go away and the entry keeps printing.
       */
      const fold = page.locator('#editor .entry:not(.off) .fold').first();
      if ((await fold.count()) > 0) {
        const id = await page.evaluate(() => {
          const f = document.querySelector('#editor .entry:not(.off) .fold');
          return f?.closest('[data-drag-id]')?.dataset.dragId ?? null;
        });
        const linesBefore = await page.locator(`#editor .entry[data-drag-id="${id}"] .bullet-row, #editor .entry[data-drag-id="${id}"] .bullet`).count();
        await fold.click();
        await page.waitForTimeout(600);

        check('folding an entry hides its lines',
          (await page.locator(`#editor .entry[data-drag-id="${id}"].folded`).count()) === 1);
        const linesAfter = await page.locator(`#editor .entry[data-drag-id="${id}"] .bullet-row, #editor .entry[data-drag-id="${id}"] .bullet`).count();
        check('and there is less on the screen than there was', linesAfter < linesBefore, `${linesBefore} → ${linesAfter}`);
        check('and says how many it folded away',
          /line/i.test(await page.locator(`#editor .entry[data-drag-id="${id}"] .chip.count`).innerText().catch(() => '')));

        /*
         * Per resume and in the save, not in this browser: which entries
         * you are done with is a fact about the document, and it should
         * still be true on another machine.
         */
        await page.locator('#save-state.saved').waitFor({ timeout: 30_000 });
        const openId = await page.locator('#resume-select').inputValue();
        const saved = await (await fetch(`${server.url}/api/resumes`)).json();
        check('and folding is remembered with the resume, not the browser',
          (saved.find((r) => r.id === openId)?.collapsed ?? []).includes(id),
          JSON.stringify(saved.find((r) => r.id === openId)?.collapsed ?? []));

        await page.locator(`#editor .entry[data-drag-id="${id}"] .fold`).click();
        await page.waitForTimeout(600);
        check('and unfolding brings them back',
          (await page.locator(`#editor .entry[data-drag-id="${id}"].folded`).count()) === 0);
      } else {
        check('an entry can be folded away', false, 'no fold control');
      }
    }

    /* -------------------------------------------------------------- *
     * Going over one page                                              *
     * -------------------------------------------------------------- *
     * "When it goes over the resume line limit it seemingly just
     * freezes" — reported by the user, and the diagnosis was that
     * auto-fit is a search. Compile, measure, shrink, compile again,
     * until the least shrinking that fits is found; on a document that
     * cannot be made to fit, that search runs to exhaustion before
     * anything reaches the screen. Measured at the time: 471ms for a
     * resume that fits, 6777ms for one that does not.
     *
     * The fix was to ask for the document as written first — one
     * compile, the true page count, the real spill — and only then run
     * the search. Both halves of that have been tested in jsdom and on
     * the server, and neither had ever been watched happen in a browser
     * with pdf.js drawing the pages. The freeze was a thing somebody
     * sat through, so the thing worth asserting is how long it takes.
     * -------------------------------------------------------------- */

    console.log('\nGoing over one page');
    {
      /*
       * Absurd margins rather than invented entries: it reaches the state
       * without writing anything into the store that the rest of the run
       * would then have to read around. `autoFit: false` for the first
       * one, so it is a plain overflow with nothing rescuing it.
       */
      const tooLong = 'editor-overflow';
      const make = (id, layout) =>
        fetch(`${server.url}/api/resumes/${id}?commit=0`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: `Overflow ${id}`, extends: 'newgrad', layout }),
        });

      await make(tooLong, { marginIn: 2.6, autoFit: false, maxPages: 1 });
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#tabs button[data-tab="resumes"]').click();
        await page.locator('#resume-select option').first().waitFor({ state: 'attached', timeout: 30_000 });

        /*
         * The number that is the whole point. Not "does it eventually
         * say the right thing" but "how long is somebody looking at a
         * screen that has not admitted anything is wrong yet".
         */
        const began = Date.now();
        await page.locator('#resume-select').selectOption(tooLong);
        await page.waitForFunction(
          () => {
            const chip = document.querySelector('#fit');
            return chip && !chip.classList.contains('idle') && /too long|fits/i.test(chip.textContent ?? '');
          },
          null,
          { timeout: 120_000, polling: 100 },
        );
        const took = Date.now() - began;
        timings.push({ what: 'a resume that is too long says so', took, budgetMs: 30_000 });
        check(`the overflow is admitted in ${(took / 1000).toFixed(1)}s, rather than hanging`, took < 30_000,
          took >= 30_000 ? 'over 30s' : '');

        const said = (await page.locator('#fit').innerText()).trim().replace(/\n/g, ' ');
        check('and says how much too long it is', /too long/i.test(said), said);
        check('and what to do about it', /shorter phrasing or drop a bullet/i.test(said), said);
        check('and marks it as the bad case, not a passing remark',
          (await page.locator('#fit.bad').count()) === 1);

        /*
         * "It should render multiple pages but only allow save of one
         * page" — so the spill has to be visible, not merely counted.
         * Waited for: pdf.js draws the second canvas after the first.
         */
        const drew = await page
          .waitForFunction(() => document.querySelectorAll('.pdf-pages canvas').length >= 2, null, {
            timeout: 60_000,
            polling: 200,
          })
          .then(() => true)
          .catch(() => false);
        const pages = await page.locator('.pdf-pages canvas').count();
        check('and draws every page it spills onto, not just the first', drew, `${pages} drawn`);
      } finally {
        await fetch(`${server.url}/api/resumes/${tooLong}?commit=0`, { method: 'DELETE' }).catch(() => undefined);
      }

      /*
       * And the other half of the same request: "Auto shrink margins is
       * fine but make a warning that it is shrinking"; then, on being
       * shown a warning, "Not a warning but a way of knowing it is being
       * shrunk". So it is a statement of fact in its own line and its own
       * colour, not an alarm — and the thing that must never happen is
       * that it says "Fits on one page" and stops, which is what it used
       * to do with the squeezing tucked into a grey clause after the word
       * nobody reads past.
       */
      /*
       * 2.1in because it was measured, not guessed. This was 1.35in on the
       * reasoning that a wide margin would need squeezing, and 1.35in turned
       * out to fit with five lines to spare — so the check reported that
       * there was nothing to see and passed, which is the shape of a test
       * that never runs. Asked directly, the render says 1.7in still fits
       * untouched, 1.9in is the first that squeezes, and 2.5in and up cannot
       * be rescued at all. 2.1in sits in the middle of the band that both
       * needs squeezing and survives it.
       */
      const squeezed = 'editor-squeezed';
      await make(squeezed, { marginIn: 2.1, autoFit: true, maxPages: 1 });
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#tabs button[data-tab="resumes"]').click();
        await page.locator('#resume-select option').first().waitFor({ state: 'attached', timeout: 30_000 });
        await page.locator('#resume-select').selectOption(squeezed);

        await page.waitForFunction(
          () => {
            const chip = document.querySelector('#fit');
            if (!chip || chip.classList.contains('idle')) return false;
            // Settled: the interim "Squeezing it onto one page…" is not an answer.
            return /too long|fits/i.test(chip.textContent ?? '') && !chip.querySelector('.squeezed.working');
          },
          null,
          { timeout: 120_000, polling: 150 },
        );

        const note = await page.locator('#fit .squeezed').innerText().catch(() => '');
        const chip = (await page.locator('#fit').innerText()).trim().replace(/\n/g, ' ');
        check('being squeezed to fit is said out loud', /squeezed to fit/i.test(note), note || chip);
        check('and names what it did, rather than only that it did something',
          /\d/.test(note.replace(/squeezed to fit/i, '')), note || chip);
        /*
         * The failure this replaced: it said "Fits on one page" and stopped,
         * with the squeezing in a grey clause after the word nobody reads
         * past. Fitting and having been shrunk to fit are different facts
         * about what you are about to send, so both have to be on screen.
         */
        check('while still saying it fits, which is the other half of the fact',
          /fits on one page/i.test(chip), chip);
      } finally {
        await fetch(`${server.url}/api/resumes/${squeezed}?commit=0`, { method: 'DELETE' }).catch(() => undefined);
      }

      // Back to a resume the rest of the run can work with.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#tabs button[data-tab="resumes"]').click();
      await page.locator('#editor .entry').first().waitFor({ timeout: 30_000 });
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
     * Arranging every resume at once                                   *
     * -------------------------------------------------------------- *
     * The master document is the inventory, and the one place an order
     * can be stated once and mean something everywhere — so it owns the
     * order of the lines inside an entry, and every resume that has not
     * arranged its own follows it. Entries stay ordered by date: the
     * order of a career is not a matter of taste.
     *
     * Worth driving rather than unit-testing alone, because the whole
     * claim is about two screens agreeing: a line is moved on one, and
     * the other has to have moved with it.
     * -------------------------------------------------------------- */

    console.log('\nArranging every resume at once');
    {
      const linesOf = (entryId) =>
        page.$$eval(`#editor .entry[data-drag-id="${entryId}"] .bullet:not(.off)`, (rows) =>
          rows.map((r) => r.dataset.dragId),
        );
      const backToResume = async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#tabs button[data-tab="resumes"]').click();
        await page.locator('#editor .entry').first().waitFor({ timeout: 30_000 });
      };

      await backToResume();
      /*
       * An entry this resume has *not* arranged for itself, which by now is
       * not every entry: the drag above deliberately made one of them
       * hand-arranged, and a hand-arranged entry is exactly the one that
       * must not follow. `.by-hand` is the note the editor puts on those, so
       * it is also the way to tell them apart from outside.
       */
      const target = await page.evaluate(() => {
        for (const e of document.querySelectorAll('#editor > [data-drag-id]')) {
          if (e.querySelector('.by-hand')) continue;
          if (e.querySelectorAll('.bullet:not(.off)').length >= 2) return e.dataset.dragId;
        }
        return null;
      });
      const arranged = await page.evaluate(() => {
        const e = [...document.querySelectorAll('#editor > [data-drag-id]')].find((x) => x.querySelector('.by-hand'));
        return e ? { id: e.dataset.dragId, lines: [...e.querySelectorAll('.bullet:not(.off)')].map((b) => b.dataset.dragId) } : null;
      });
      check('an entry that arranged its own lines says so', Boolean(arranged), arranged?.id ?? 'none marked');

      if (!target) {
        check('there is an entry still following the master', false, 'none');
      } else {
        const before = await linesOf(target);

        await page.locator('#resume-select').selectOption('__master__');
        await page.locator('#editor .master-source-entry').first().waitFor({ timeout: 30_000 });
        const grips = await page.locator('#editor .master-source-bullet .grip').count();
        check('the master offers a handle on each of its lines', grips > 0, `${grips} handles`);

        const dropped = await page.evaluate(({ a, b }) => {
          const rows = [...document.querySelectorAll('.master-source-bullet[data-drag-id]')];
          const from = rows.find((r) => r.dataset.dragId === a);
          const onto = rows.find((r) => r.dataset.dragId === b);
          if (!from || !onto) return false;
          const dt = new DataTransfer();
          const box = onto.getBoundingClientRect();
          const y = box.bottom - 2;
          const grip = from.querySelector('.grip');
          grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
          onto.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
          onto.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
          grip.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
          return true;
        }, { a: before[0], b: before[1] });
        check('a line in the master can be picked up', dropped);
        await page.waitForTimeout(3500);

        // The master writes the entry itself, because the order is the
        // store's rather than any one resume's.
        const store = await (await fetch(`${server.url}/api/store`)).json();
        const held = (store.entries.find((e) => e.id === target)?.bullets ?? []).map((b) => b.id);
        check('and moving it there moves it in the save itself',
          held.indexOf(before[0]) > held.indexOf(before[1]), held.join(', '));

        await backToResume();
        const after = await linesOf(target);
        check('and the entry that never arranged its own lines follows',
          after.indexOf(before[0]) > after.indexOf(before[1]),
          `${before.join(', ')} → ${after.join(', ')}`);

        /*
         * And the other half of the same rule, which is the half that makes
         * the first half safe: an entry arranged on this resume stays where
         * it was put. Without this the check above passes just as well for a
         * version that restacks everything, arrangements included.
         */
        if (arranged) {
          const still = await linesOf(arranged.id);
          check('while the one arranged here is left exactly as it was',
            still.join(',') === arranged.lines.join(','),
            `${arranged.lines.join(', ')} → ${still.join(', ')}`);

          /*
           * And the way back, which is what stops an arrangement being a
           * one-way door. Detaching from the master happens by dragging,
           * which is easy to do without meaning to; if there were no way to
           * undo it, an entry could silently stop following the house order
           * forever on the strength of one slip.
           */
          const back = page.locator(`#editor .entry[data-drag-id="${arranged.id}"] .by-hand button`);
          check('an arranged entry offers a way back to the master’s order', (await back.count()) === 1);
          if (await back.count()) {
            await back.click();
            await page.locator('#save-state.saved').waitFor({ timeout: 30_000 });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.locator('#tabs button[data-tab="resumes"]').click();
            await page.locator('#editor .entry').first().waitFor({ timeout: 30_000 });

            const now = await linesOf(arranged.id);
            const store = await (await fetch(`${server.url}/api/store`)).json();
            const master = (store.entries.find((e) => e.id === arranged.id)?.bullets ?? [])
              .map((b) => b.id)
              .filter((id) => now.includes(id));
            check('and taking it puts the lines back in that order',
              now.join(',') === master.join(','), `${now.join(', ')} | master: ${master.join(', ')}`);
            check('and the note that it was arranged here goes away',
              (await page.locator(`#editor .entry[data-drag-id="${arranged.id}"] .by-hand`).count()) === 0);
          }
        }
        await sameAsDocument('after the master was rearranged');
      }
    }

    /* -------------------------------------------------------------- *
     * Going back to an earlier version                                 *
     * -------------------------------------------------------------- *
     * Restore is the most destructive button in the editor: it writes
     * over the resume you have open. The server side of it is well
     * covered, and the screen it is pressed from was not tested
     * anywhere — not here, not in jsdom. A restore that silently picks
     * the wrong version, or that loses the version you restored *from*,
     * is the exact failure the save is meant to make impossible.
     *
     * The harness runs with autocommit off so the rest of the run
     * leaves no commits behind, so the versions are made deliberately
     * here, through the endpoint that commits regardless.
     * -------------------------------------------------------------- */

    console.log('\nGoing back to an earlier version');
    {
      const commit = (message) =>
        fetch(`${server.url}/api/store/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });

      const specOf = async (id) => (await (await fetch(`${server.url}/api/resumes`)).json()).find((r) => r.id === id);

      // Two versions of one resume, differing in a way that is visible
      // both on the page and in the stored spec.
      const id = 'editor-history';
      const put = (label) =>
        fetch(`${server.url}/api/resumes/${id}?commit=0`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, label, extends: 'newgrad' }),
        });

      await put('The first name it had');
      await commit('First version');
      await put('The second name it had');
      await commit('Second version');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#tabs button[data-tab="history"]').click();
      await page.locator('#history-resume').waitFor({ timeout: 20_000 });
      await page.locator('#history-resume').selectOption(id);

      const appeared = await page
        .waitForFunction(() => document.querySelectorAll('#resume-timeline .version-card').length >= 2, null, {
          timeout: 30_000,
          polling: 200,
        })
        .then(() => true)
        .catch(() => false);
      const cards = await page.locator('#resume-timeline .version-card').count();
      check('a resume edited twice has a history to look at', appeared, `${cards} versions`);

      if (appeared) {
        /*
         * "Version-history UI like Google Docs, not raw git log" was the
         * whole of the request, so the timeline must not be reading as
         * hashes — the raw log is still there, behind its own button, for
         * anyone who wants it.
         */
        const top = (await page.locator('#resume-timeline .version-card').first().innerText()).trim();
        check('the newest is marked as the one in use', /current/i.test(top), top.split('\n')[0]);
        check('and it reads as a change, not as a commit hash',
          !/\b[0-9a-f]{7,40}\b/.test(top), top.replace(/\n/g, ' ').slice(0, 90));

        /*
         * The restore itself. Confirmed first, because it says it is
         * about to replace what is on screen and that promise is part of
         * the feature.
         */
        let asked = '';
        page.once('dialog', (d) => {
          asked = d.message();
          d.accept();
        });
        await page.locator('#resume-timeline .version-card:not(.current) button', { hasText: 'Restore' }).first().click();
        await page.waitForTimeout(3500);

        check('it asks before replacing what you have', /restore this version/i.test(asked), asked.slice(0, 80));
        check('and promises the current one is not lost', /history is kept|get back/i.test(asked), asked.slice(0, 120));

        const after = await specOf(id);
        check('the older version is the one now in the save', after?.label === 'The first name it had', after?.label);

        /*
         * And the promise the dialog made. Restoring must not be a way to
         * lose the version you restored from — that is the whole standing
         * rule about not destroying work, at the one button most able to
         * break it.
         *
         * The property is that the old version is still listed and still
         * offers a way back, not that the history grew: the restore commits
         * only when autocommit is on, and this harness deliberately runs with
         * it off so the rest of the run leaves no commits behind. Counting
         * cards here asserted a commit the environment suppresses, which is a
         * fact about the test rig rather than about the product.
         */
        await page.waitForTimeout(1000);
        const names = await page.locator('#resume-timeline').innerText();
        check('the version restored from is still in the history',
          names.includes('The second name it had'), names.replace(/\n/g, ' ').slice(0, 120));
        check('and still offers a way back to it',
          (await page.locator('#resume-timeline .version-card:not(.current) button', { hasText: 'Restore' }).count()) > 0);
      }

      /*
       * The raw git log is still reachable for anyone who wants it — the
       * point of the timeline was to stop it being the only thing on
       * offer, not to hide it.
       */
      await page.locator('#btn-raw-history').click();
      await page.waitForTimeout(1500);
      check('the raw log is still one click away',
        (await page.locator('#raw-history').isVisible()) === true);

      await fetch(`${server.url}/api/resumes/${id}?commit=0`, { method: 'DELETE' }).catch(() => undefined);
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
