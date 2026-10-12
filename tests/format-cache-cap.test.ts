/**
 * The preview's format cache stays in bounds.
 *
 * Nothing used to delete a format. One is about 7MB, and there is one per
 * distinct layout — every font size, margin and spacing the editor was ever
 * shown — so the cache only grew: thirty font sizes tried left thirty formats
 * and 205MB in the temp directory. Now the least recently used go once there are
 * more than `FORMAT_CACHE_LIMITS.kept`, or once they weigh more than
 * `FORMAT_CACHE_LIMITS.bytes`.
 *
 * Against a stand-in `pdftex` rather than the real one, so this runs on every
 * machine and in a second: dumping a real format takes about one each, and a
 * test of the cap has to build past it. The stand-in writes a `.fmt` of
 * whatever size it is told for `-ini`, and a one-line PDF otherwise; the code
 * under test only ever sees files appear where they should.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileFastBody, FORMAT_CACHE_LIMITS, hasFastPath, resetFastPathCache } from '../src/render/fastCompile.js';
import { DEFAULT_LAYOUT, type LayoutOptions } from '../src/model/types.js';

const HELLO = '\\begin{document}\nHello.\n\\end{document}\n';

const FAKE_PDFTEX = `#!/bin/bash
for a in "$@"; do
  case "$a" in
    --version) echo "pdfTeX 3.141592653 (stand-in)"; exit 0 ;;
    -ini) ini=1 ;;
    -jobname=*) job="\${a#-jobname=}" ;;
  esac
done
if [ -n "$ini" ]; then
  head -c "\${FAKE_FMT_BYTES:-4096}" /dev/zero > "$job.fmt"
  exit 0
fi
echo '%PDF-1.4 stand-in' > resume.pdf
echo '\\relax' > resume.aux
echo 'stand-in log' > resume.log
`;

let bin: string;
let cache: string;
const saved = { PATH: process.env.PATH, RMM_FMT_CACHE: process.env.RMM_FMT_CACHE, FAKE_FMT_BYTES: process.env.FAKE_FMT_BYTES };

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fmt-cap-'));
  bin = path.join(root, 'bin');
  cache = path.join(root, 'cache');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pdftex'), FAKE_PDFTEX, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'kpsewhich'), '#!/bin/bash\necho /stand-in/mylatexformat.ltx\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  process.env.RMM_FMT_CACHE = cache;
  resetFastPathCache();
  expect(await hasFastPath()).toBe(true);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetFastPathCache();
  fs.rmSync(path.dirname(bin), { recursive: true, force: true });
});

/** A layout of its own for each `i`: the key is a hash of the layout. */
const layoutNo = (i: number): LayoutOptions => ({ ...DEFAULT_LAYOUT, fontSizePt: 9 + i / 10 });
const formats = (): string[] => (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((f) => f.endsWith('.fmt'));
const formatsFor = async (i: number): Promise<string[]> => {
  const before = new Set(formats());
  await compileFastBody(HELLO, 'letter', layoutNo(i));
  return formats().filter((f) => !before.has(f));
};

describe.skipIf(process.platform === 'win32')('the format cache', () => {
  it(`keeps no more than ${FORMAT_CACHE_LIMITS.kept} formats, however many layouts are tried`, async () => {
    for (let i = 0; i < FORMAT_CACHE_LIMITS.kept + 8; i++) {
      await compileFastBody(HELLO, 'letter', layoutNo(i));
      expect(formats().length).toBeLessThanOrEqual(FORMAT_CACHE_LIMITS.kept);
    }
    expect(formats()).toHaveLength(FORMAT_CACHE_LIMITS.kept);
  });

  it('lets the least recently used go, and keeps the one still in use', async () => {
    const [first] = await formatsFor(0);
    const [second] = await formatsFor(1);
    for (let i = 2; i < FORMAT_CACHE_LIMITS.kept; i++) await formatsFor(i);
    expect(formats()).toHaveLength(FORMAT_CACHE_LIMITS.kept);

    // The first layout is the one the editor keeps coming back to.
    await new Promise((r) => setTimeout(r, 20));
    await compileFastBody(HELLO, 'letter', layoutNo(0));
    await formatsFor(FORMAT_CACHE_LIMITS.kept);

    expect(formats()).toContain(first);
    expect(formats()).not.toContain(second);
  });

  it(`keeps them under ${FORMAT_CACHE_LIMITS.bytes / 1024 / 1024}MB, but never sweeps the one just built`, async () => {
    const each = 13 * 1024 * 1024;
    process.env.FAKE_FMT_BYTES = String(each);
    const fit = Math.floor(FORMAT_CACHE_LIMITS.bytes / each);
    for (let i = 0; i < fit + 3; i++) {
      const [built] = await formatsFor(i);
      expect(formats()).toContain(built);
    }
    expect(formats()).toHaveLength(fit);

    // One heavier than the whole allowance is still kept while it is in use.
    process.env.FAKE_FMT_BYTES = String(FORMAT_CACHE_LIMITS.bytes + 1024);
    const [huge] = await formatsFor(100);
    expect(formats()).toEqual([huge]);
  });

  it('builds a format again when a sweep took it, rather than pointing pdftex at nothing', async () => {
    await compileFastBody(HELLO, 'letter', layoutNo(0));
    const [only] = formats();
    // Another process's sweep, as far as this one can tell.
    fs.rmSync(path.join(cache, only!));
    const raw = await compileFastBody(HELLO, 'letter', layoutNo(0));
    expect(raw.pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(formats()).toEqual([only]);
  });

  it('tidies away a staged copy a dead build left behind, once it is old', async () => {
    fs.mkdirSync(cache, { recursive: true });
    const stale = path.join(cache, 'rmm-letter-0123456789abcdef.fmt.4242.abc');
    fs.writeFileSync(stale, 'half a format');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    await compileFastBody(HELLO, 'letter', layoutNo(0));
    expect(fs.existsSync(stale)).toBe(false);
  });
});
