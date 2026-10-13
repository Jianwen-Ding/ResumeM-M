import YAML from 'yaml';
import { runAgent } from '../ai/agent.js';
import type { StoreConfig } from '../model/types.js';
import { splitFrontMatter } from '../model/store.js';
import { extractText, READABLE } from './text.js';
import { redactIdentifiers } from '../jobs/answers.js';
import { ingestPrompt, MAX_BLOCKS, readIngestPlan, segment, sortByRules, type Proposal } from './sort.js';

/**
 * Reading a file and working out what is in it, in one call — the editor and
 * the command line both want the same answer, and a model that behaves
 * differently depending on which door you came in by is a bug waiting to be
 * reported.
 */

export interface Ingested {
  text: string;
  name: string;
  via: string;
  chars: number;
  blocks: number;
  items: Proposal[];
  usedAi: boolean;
  /** Set when the AI was asked and could not answer; the rules stood in. */
  aiError?: string;
  /** How many identifiers were taken out before anything else saw the file. */
  redacted: number;
  /**
   * Why nothing was taken from the file, when it said so itself: a letter
   * or sample exported from a save with `voice: false` in its header.
   */
  skipped?: string;
}

const KINDS = ['letter', 'answer', 'resume', 'other'] as const;

/**
 * The YAML header of a Markdown file, and the prose under it.
 *
 * A letter or a sample copied out of a save — `letters/*.md`, `corpus/*.md`
 * — or out of any static-site generator starts with one, and it was read as
 * the first paragraph of the writing: "title: Engineer — Globex company:
 * Globex createdAt: 2025-01-01T00:00:00.000Z" filed as a sample, sent to the
 * AI as how they write, and the title the header gave thrown away for one
 * guessed from the text. Only for Markdown, which is where a header means
 * one; a header that is not YAML is left as the text it was.
 */
function frontMatterOf(name: string, text: string): { meta: Record<string, unknown>; body: string } | undefined {
  if (!/\.(md|markdown)$/i.test(name)) return undefined;
  const split = splitFrontMatter(text);
  if (!split) return undefined;
  try {
    const meta: unknown = YAML.parse(split.header);
    if (meta !== null && meta !== undefined && (typeof meta !== 'object' || Array.isArray(meta))) return undefined;
    return { meta: (meta ?? {}) as Record<string, unknown>, body: split.body };
  } catch {
    return undefined;
  }
}

export async function ingestFile(
  config: StoreConfig,
  name: string,
  bytes: Buffer,
  { useAi = true }: { useAi?: boolean } = {},
): Promise<Ingested> {
  if (bytes.length === 0) throw new Error(`There is nothing in ${name || 'that file'}`);

  const read = await extractText(name, bytes);
  const via = read.via;
  const header = frontMatterOf(name, read.text);
  /*
   * `voice: false` is the save's own way of saying "keep this one out of
   * how I write" (see `CoverLetter.voice`), and a file that says it is not
   * one to add to the corpus. Said as skipped, so the caller can tell it
   * from a file with nothing in it.
   */
  if (header?.meta.voice === false) {
    return {
      name,
      text: '',
      via,
      chars: 0,
      blocks: 0,
      items: [],
      usedAi: false,
      redacted: 0,
      skipped: `${name || 'That file'} says "voice: false" in its header, so it is kept out of your writing samples`,
    };
  }
  // Before anything is sorted, stored or shown to the AI: see `redactIdentifiers`.
  const { text, redacted } = redactIdentifiers(header ? header.body : read.text);
  const blocks = segment(text);
  if (blocks.length === 0) {
    throw new Error(`${name || 'That file'} has no readable text in it. Readable: ${READABLE.join(', ')}`);
  }

  const wantsAi = useAi && config.ai.enabled;
  let items = sortByRules(name, blocks);
  let aiError: string | undefined;

  if (wantsAi) {
    try {
      // Only what fits in a prompt goes to the model; `readIngestPlan` claims
      // the remainder by rule, so nothing is lost by not showing it.
      const result = await runAgent(config, ingestPrompt(name, blocks.slice(0, MAX_BLOCKS)));
      items = readIngestPlan(result.output, name, blocks);
    } catch (err) {
      // The rules already produced a usable answer. Saying what went wrong and
      // carrying on beats throwing away a file the user just handed over.
      aiError = err instanceof Error ? err.message : String(err);
    }
  }

  /*
   * What the header says the writing is, where the file is one piece of it.
   * A file the sorting split into several — four letters pasted into one —
   * is not named by one title, and each piece keeps its own. A header with
   * a company or a role is a letter's (`letters/*.md`), which has no `kind`.
   */
  if (header && items.length === 1) {
    const { title, kind, company, role } = header.meta;
    const said = KINDS.find((k) => k === kind) ?? (company || role ? 'letter' : undefined);
    const named = typeof title === 'string' && title.trim() ? title.trim() : undefined;
    items = [{ ...items[0]!, ...(said ? { kind: said } : {}), ...(named ? { title: named } : {}) }];
  }

  return { name, text, via, chars: text.length, blocks: blocks.length, items, usedAi: wantsAi && !aiError, aiError, redacted };
}

export { READABLE } from './text.js';
export type { Proposal } from './sort.js';
