import { runAgent } from '../ai/agent.js';
import type { StoreConfig } from '../model/types.js';
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
  // Before anything is sorted, stored or shown to the AI: see `redactIdentifiers`.
  const { text, redacted } = redactIdentifiers(read.text);
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

  return { name, text, via, chars: text.length, blocks: blocks.length, items, usedAi: wantsAi && !aiError, aiError, redacted };
}

export { READABLE } from './text.js';
export type { Proposal } from './sort.js';
