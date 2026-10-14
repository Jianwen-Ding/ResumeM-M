import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

/*
 * The header, laid out by a real browser: jsdom has no layout, and every one
 * of these was a matter of widths.
 *
 *  - Between the phone layout and about 1230px the tabs scrolled sideways in
 *    a 56px header with no scrollbar to say so: History and Voice & AI were
 *    not there at 1024, and Applications onwards at 800 and 390.
 *  - Errors in the status line were cut at 40 characters with an ellipsis.
 *  - "Log an error" lost its words below a fixed 1500px.
 *
 * The page is the real index.html and style.css, served from web/ without a
 * server; only app.js is swapped for the header's own module, since none of
 * the rest is about the header.
 */

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => fs.existsSync(p));

const web = path.resolve('web');
const ORIGIN = 'http://rmm.test';
const page$ = () => {
  let html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  // As it is once a save is open: every tab on, and the save named.
  html = html.replace(/(<button data-tab="[a-z]+")( class="active")? disabled>/g, '$1$2>');
  html = html.replace('>No Save Open</button>', '>Save: data</button>');
  html = html.replace(
    '<script src="app.js" type="module"></script>',
    `<script type="module">
      try {
        const header = await import('./header.js');
        header.setupHeader();
        window.fitStatus = header.fitStatus;
      } catch {}
      window.headerReady = true;
    </script>`,
  );
  return html;
};

const LONG =
  'Couldn’t save the application “Senior Platform Engineer, Payments Infrastructure”: the save refused the write because another window changed it first — reload to see what is there now, then make the change again.';

let browser;
beforeAll(async () => {
  if (!executablePath) return;
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
});
afterAll(async () => {
  await browser?.close();
});

async function open(width) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: page$() });
    const file = path.join(web, url.pathname);
    if (!file.startsWith(web) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream';
    return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.headerReady);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(50);
  return { page, close: () => context.close() };
}

describe.skipIf(!executablePath)('the header', () => {
  for (const width of [1440, 1280, 1200, 1150, 1024, 800, 390]) {
    it(`shows every tab whole at ${width}px, and what sticks under it clears it`, async () => {
      const { page, close } = await open(width);
      try {
        const got = await page.evaluate(() => {
          const tabs = document.querySelector('#tabs').getBoundingClientRect();
          const hidden = [...document.querySelectorAll('#tabs button')]
            .filter((b) => {
              const r = b.getBoundingClientRect();
              return r.width === 0 || r.left < tabs.left - 1 || r.right > tabs.right + 1 || r.right > innerWidth;
            })
            .map((b) => b.textContent);
          const header = document.querySelector('header');
          const sticky = getComputedStyle(header).position === 'sticky';
          const toolbarTop = parseFloat(getComputedStyle(document.querySelector('.sticky-toolbar')).top);
          return { hidden, sticky, height: header.getBoundingClientRect().height, toolbarTop };
        });
        expect(got.hidden, 'tabs out of sight').toEqual([]);
        // Stuck under a sticky header, the toolbar starts where it ends (less
        // the 2px it has always tucked under it).
        if (got.sticky) expect(got.toolbarTop).toBeGreaterThanOrEqual(got.height - 2.5);
      } finally {
        await close();
      }
    });
  }

  for (const width of [1440, 1024]) {
    it(`shows a long error whole at ${width}px`, async () => {
      const { page, close } = await open(width);
      try {
        const got = await page.evaluate((text) => {
          const s = document.querySelector('#status');
          s.textContent = text;
          s.className = 'status err';
          // What `setStatus` does after setting an error. (Not an import
          // here: vitest rewrites those, in this function too.)
          window.fitStatus?.(s);
          const r = s.getBoundingClientRect();
          return {
            cut: s.scrollHeight > s.clientHeight + 1 || s.scrollWidth > s.clientWidth + 1,
            onScreen: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
            width: r.width,
          };
        }, LONG);
        expect(got.cut, 'error cut short').toBe(false);
        expect(got.onScreen).toBe(true);
        expect(got.width).toBeGreaterThan(200);
      } finally {
        await close();
      }
    });
  }

  for (const width of [390, 360]) {
    it(`keeps the "!" on the phone header's first row, with the mark and the AI chip, at ${width}px`, async () => {
      const { page, close } = await open(width);
      try {
        const rows = await page.evaluate(() => {
          const mid = (sel) => {
            const r = document.querySelector(sel).getBoundingClientRect();
            return Math.round(r.top + r.height / 2);
          };
          return { mark: mid('header h1'), ai: mid('#ai-peek-chip'), log: mid('#error-log-chip'), tabs: mid('#tabs') };
        });
        expect(Math.abs(rows.log - rows.mark), JSON.stringify(rows)).toBeLessThan(8);
        expect(Math.abs(rows.ai - rows.mark), JSON.stringify(rows)).toBeLessThan(8);
        expect(rows.tabs).toBeGreaterThan(rows.log + 16);
      } finally {
        await close();
      }
    });
  }

  for (const width of [1440, 1024]) {
    it(`scrolls the error log's heading clear of the sticky header at ${width}px`, async () => {
      const { page, close } = await open(width);
      try {
        const got = await page.evaluate(() => {
          // As "Open the error log" does, with the page tall enough to scroll.
          document.body.style.minHeight = '5000px';
          document.querySelector('#tab-save').classList.add('active');
          document.querySelector('#error-log').scrollIntoView({ block: 'start' });
          return {
            header: document.querySelector('header').getBoundingClientRect().bottom,
            top: document.querySelector('#error-log').getBoundingClientRect().top,
          };
        });
        expect(got.top).toBeGreaterThanOrEqual(got.header);
      } finally {
        await close();
      }
    });
  }

  for (const width of [1440, 1150, 1024]) {
    it(`gives "Log an error" its words where there is room, at ${width}px`, async () => {
      const { page, close } = await open(width);
      try {
        const label = await page.evaluate(() => document.querySelector('.error-log-chip-label').getBoundingClientRect().width);
        expect(label).toBeGreaterThan(30);
      } finally {
        await close();
      }
    });
  }
});
