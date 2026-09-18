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

    /** The ids the editor is showing, in the order it is showing them. */
    const shown = (selector) => page.$$eval(selector, (rows) => rows.map((r) => r.dataset.dragId));

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
       */
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
