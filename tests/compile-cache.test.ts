/**
 * The compiled-document cache, which the whole suite now runs on.
 *
 * `tests/setup.ts` points `RMM_COMPILE_CACHE` at a directory and the suite
 * stops compiling the same document over and over — a hundred and forty
 * compiles a run, forty-three of them distinct. That is a large speed-up
 * resting on one claim: that the .tex is the whole input, so the same text
 * cannot come back as a different document.
 *
 * The claim is worth testing directly, because getting it wrong is silent.
 * A cache that answers too eagerly does not fail a test — it passes one,
 * against a PDF built from a resume nobody is looking at any more.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileResume, detectEngine } from '../src/render/compile.js';
import { DEFAULT_LAYOUT, type ResolvedResume } from '../src/model/types.js';

const usable = await detectEngine()
  .then(() => true)
  .catch(() => false);

function resume(title: string): ResolvedResume {
  return {
    id: 'cache-test',
    label: 'Cache test',
    profile: { name: 'Test Person', email: 'a@b.com' },
    sections: [
      {
        kind: 'experience',
        heading: 'Experience',
        skillGroups: [],
        entries: [
          {
            id: 'e0',
            kind: 'experience' as const,
            title,
            dates: 'Jul. 2024 -- Dec. 2024',
            subtitle: 'Software Engineer',
            location: 'Boston, MA',
            bullets: [{ id: 'b0', variantId: 'v', text: 'Cut latency from 900ms to 180ms.' }],
          },
        ],
      },
    ],
    layout: { ...DEFAULT_LAYOUT },
    warnings: [],
  };
}

describe.skipIf(!usable)('the compiled-document cache', { timeout: 120_000 }, () => {
  let dir: string;
  let out: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.RMM_COMPILE_CACHE;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-cache-test-'));
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-cache-out-'));
    process.env.RMM_COMPILE_CACHE = dir;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.RMM_COMPILE_CACHE;
    else process.env.RMM_COMPILE_CACHE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  /** Compile to a file of our own and hand back the bytes. */
  const build = async (title: string, name: string): Promise<Buffer> => {
    const at = path.join(out, `${name}.pdf`);
    const got = await compileResume(resume(title), { pdfPath: at });
    expect(got.pdfPath).toBe(at);
    return fs.readFileSync(at);
  };

  const filed = () => fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();

  it('gives the second caller exactly what the engine gave the first', async () => {
    const first = await build('Helios', 'one');
    const entries = filed();
    expect(entries.length).toBeGreaterThan(0);

    const second = await build('Helios', 'two');
    expect(second.equals(first)).toBe(true);
    // Nothing new was compiled, so nothing new was filed.
    expect(filed()).toEqual(entries);
  });

  it('does not answer for a document that is not the one asked for', async () => {
    const helios = await build('Helios', 'helios');
    const vega = await build('Vega Robotics', 'vega');
    expect(filed()).toHaveLength(2);

    // Two entries exist; this asks for the first one again and has to get
    // that one back rather than whichever was filed last.
    const again = await build('Helios', 'helios-again');
    expect(again.equals(helios)).toBe(true);
    expect(again.equals(vega)).toBe(false);
    expect(filed()).toHaveLength(2);
  });

  it('compiles every time when it is switched off, and files nothing', async () => {
    delete process.env.RMM_COMPILE_CACHE;
    const once = await build('Helios', 'uncached-one');
    const twice = await build('Helios', 'uncached-two');

    expect(once.subarray(0, 4).toString()).toBe('%PDF');
    expect(fs.readdirSync(dir)).toEqual([]);
    /*
     * The engine stamps each run, so two compiles of one document are never
     * byte-identical — which is what makes "the cache was not consulted"
     * something this can see rather than assume. Equal bytes here would mean
     * the second was answered from somewhere, whatever the directory shows.
     */
    expect(twice.equals(once)).toBe(false);
  });

  it('compiles again rather than handing back an entry with no PDF in it', async () => {
    const first = await build('Helios', 'first');
    const [pdf] = filed();
    // The shape a half-written or truncated entry takes on disk. The engine
    // itself produces this for a document with nothing in it, and waving one
    // through hands the caller a file it will attach to an application.
    fs.writeFileSync(path.join(dir, pdf!), Buffer.alloc(0));

    const again = await build('Helios', 'again');
    expect(again.subarray(0, 4).toString()).toBe('%PDF');
    expect(again.length).toBeGreaterThan(first.length / 2);
    // A real compile happened, so the emptied entry was replaced rather than
    // left to be handed to the next caller.
    expect(fs.statSync(path.join(dir, pdf!)).size).toBeGreaterThan(0);
  });
});
