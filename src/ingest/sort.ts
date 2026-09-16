import path from 'node:path';
import type { WritingSample } from '../model/types.js';

/**
 * Working out what is in a file someone dropped in.
 *
 * A file is rarely one thing. An "old applications" document is four cover
 * letters; a notes file is a dozen answers with their questions above them.
 * Filing that by hand is the tedium that stops people doing it at all, so it is
 * done for them: the file is cut into blocks, and each run of blocks is labelled
 * a letter, an answer, a resume, or something else.
 *
 * The AI labels; it never writes. Its reply names block numbers, and the text
 * of every proposal is reassembled from those blocks — so the worst a confused
 * model can do is file something under the wrong heading, which is one click to
 * correct. Nothing it says becomes text the user is credited with writing.
 */

export type SampleKind = WritingSample['kind'];

export interface Block {
  index: number;
  text: string;
}

export interface Proposal {
  kind: SampleKind;
  title: string;
  text: string;
  /** Which blocks it came from, so the decision can be checked. */
  blocks: number[];
  /** Who decided: the model, or the rules that run without one. */
  by: 'ai' | 'rules';
}

/** Below this a "sample" is a heading or a page number, not writing. */
const MIN_SAMPLE = 40;

/** More blocks than this and the model is being asked to read a book. */
const MAX_BLOCKS = 120;

const KINDS: SampleKind[] = ['letter', 'answer', 'resume', 'other'];

const SALUTATION = /^(dear|hello|hi|greetings|to whom it may concern)\b[^\n]{0,80}[,:]\s*$/im;
const SIGN_OFF = /^(sincerely|regards|best regards|kind regards|best|yours (sincerely|truly|faithfully)|thank you|thanks)\b[^\n]{0,40}[,.]?\s*$/im;
const RESUME_HEADING = /^(education|experience|work experience|employment|skills|technical skills|projects|publications|awards|certifications)\s*$/im;

/* ------------------------------------------------------------------ *
 * Cutting a file into blocks                                          *
 * ------------------------------------------------------------------ */

/**
 * Blank lines are where a document already tells you its own structure, so
 * they are the cut. Very short neighbours are joined onto what follows — a
 * heading belongs with its paragraph, not alone.
 */
export function segment(text: string): Block[] {
  const raw = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+$/gm, '').trim())
    .filter(Boolean);

  const merged: string[] = [];
  let carry = '';
  for (const piece of raw) {
    // A lone line that is not a sentence is a label for what comes next.
    const isLabel = piece.length < 60 && !piece.includes('\n') && !/[.!?]$/.test(piece);
    if (carry) {
      merged.push(`${carry}\n${piece}`);
      carry = '';
      continue;
    }
    if (isLabel && !SALUTATION.test(piece) && !piece.endsWith('?')) {
      carry = piece;
      continue;
    }
    merged.push(piece);
  }
  if (carry) merged.push(carry);

  return merged.slice(0, MAX_BLOCKS).map((t, index) => ({ index, text: t }));
}

/* ------------------------------------------------------------------ *
 * The rules, which run with or without a model                        *
 * ------------------------------------------------------------------ */

function isQuestion(text: string): boolean {
  const first = text.split('\n')[0] ?? '';
  if (text.length > 400) return false;
  return /\?\s*$/.test(first.trim()) || /^(q|question)\s*[:.]/i.test(first.trim());
}

function looksLikeResume(text: string): boolean {
  if (RESUME_HEADING.test(text)) return true;
  const lines = text.split('\n').filter(Boolean);
  const bullets = lines.filter((l) => /^\s*[-•*·]/.test(l)).length;
  return lines.length >= 3 && bullets / lines.length > 0.6;
}

function titleFrom(text: string, fallback: string): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').trim();
  const short = first.length > 70 ? `${first.slice(0, 70).trimEnd()}…` : first;
  return short || fallback;
}

/** Addressed to nobody in particular, so the name is no use as a label. */
const GENERIC = /^(hiring manager|sir|madam|sir or madam|team|recruiter|recruiting team|whom it may concern|all)$/i;

/**
 * A label that says what the thing is, not how it opens. "Dear Streamly," is
 * the first line of a letter; "Letter to Streamly" is what you look for when
 * you are scanning a list of thirty of them.
 */
function labelFor(kind: SampleKind, text: string, fallback: string): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').trim();

  if (kind === 'letter') {
    const to = /^(?:dear|hello|hi|greetings)\s+(.+?)\s*[,:]\s*$/i.exec(first)?.[1]?.trim();
    if (to && !GENERIC.test(to) && to.length <= 50) return `Letter to ${to}`;
    return fallback;
  }
  if (kind === 'answer') {
    const question = first.replace(/^(q|question)\s*[:.]\s*/i, '').trim();
    return titleFrom(question, fallback);
  }
  return titleFrom(text, fallback);
}

function build(kind: SampleKind, blocks: Block[], title: string, by: Proposal['by']): Proposal | null {
  const text = blocks.map((b) => b.text).join('\n\n').trim();
  if (text.length < MIN_SAMPLE) return null;
  return { kind, title, text, blocks: blocks.map((b) => b.index), by };
}

/**
 * What the file looks like to a set of rules: good enough on its own, and the
 * floor under the model — a wrong answer from an AI should never be worse than
 * no AI at all.
 */
export function sortByRules(fileName: string, blocks: Block[]): Proposal[] {
  const base = path.basename(fileName || 'Pasted text').replace(/\.[^.]+$/, '') || 'Pasted text';
  const out: Proposal[] = [];
  let loose: Block[] = [];

  const flush = () => {
    if (loose.length === 0) return;
    const kind: SampleKind = loose.some((b) => looksLikeResume(b.text)) ? 'resume' : 'other';
    const made = build(kind, loose, labelFor(kind, loose[0]!.text, base), 'rules');
    if (made) out.push(made);
    loose = [];
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;

    // A letter runs from its salutation to its sign-off, and takes the name
    // under the sign-off with it.
    if (SALUTATION.test(block.text)) {
      const run = [block];
      let j = i + 1;
      for (; j < blocks.length; j++) {
        run.push(blocks[j]!);
        if (SIGN_OFF.test(blocks[j]!.text)) {
          // The name under "Sincerely," is part of the letter — but the next
          // letter's salutation is short too, and is not.
          const next = blocks[j + 1];
          if (next && next.text.length < 60 && !SALUTATION.test(next.text) && !isQuestion(next.text)) {
            run.push(next);
            j++;
          }
          break;
        }
        if (SALUTATION.test(blocks[j]!.text)) break; // the next letter starts here
      }
      flush();
      const made = build('letter', run, labelFor('letter', block.text, `${base} — letter`), 'rules');
      if (made) out.push(made);
      i = j;
      continue;
    }

    // A question owns the prose beneath it, up to the next question.
    if (isQuestion(block.text)) {
      const run = [block];
      let j = i + 1;
      for (; j < blocks.length && !isQuestion(blocks[j]!.text) && !SALUTATION.test(blocks[j]!.text); j++) {
        run.push(blocks[j]!);
      }
      flush();
      const made = build('answer', run, labelFor('answer', block.text, `${base} — answer`), 'rules');
      if (made) out.push(made);
      i = j - 1;
      continue;
    }

    loose.push(block);
  }
  flush();

  return out;
}

/* ------------------------------------------------------------------ *
 * The same job, asked of a model                                      *
 * ------------------------------------------------------------------ */

const PREVIEW = 300;

/** What the model is shown: every block, numbered, trimmed to its opening. */
export function ingestPrompt(fileName: string, blocks: Block[]): string {
  const parts = [
    `A file called "${fileName || 'pasted text'}" is being added to someone's corpus of`,
    'their own writing. It has been cut into numbered blocks below.',
    '',
    'Group the blocks into documents and label each group. A group is one cover',
    'letter, one answer to one application question, one resume, or one other',
    'piece of writing. Consecutive blocks usually belong together; a salutation',
    'starts a letter, a question line starts an answer.',
    '',
    'Reply with JSON only, in this shape:',
    '{"items":[{"blocks":[0,1,2],"kind":"letter","title":"Cover letter to Acme"}]}',
    '',
    'Rules:',
    `- "kind" is one of: ${KINDS.join(', ')}.`,
    '- "title" is a short label, at most 70 characters. For an answer, use the question.',
    '- Use each block at most once. Leave out blocks that are page numbers, headers,',
    '  or footers.',
    '- Do not write, rewrite, summarise, or correct any of the text. You are sorting',
    '  blocks that already exist; the text is taken from the file, not from you.',
    '',
    '## Blocks',
    '',
  ];

  for (const b of blocks) {
    const text = b.text.length > PREVIEW ? `${b.text.slice(0, PREVIEW).trimEnd()}…` : b.text;
    parts.push(`### Block ${b.index} (${b.text.length} chars)`, text, '');
  }

  return parts.join('\n');
}

interface RawItem {
  blocks?: unknown;
  kind?: unknown;
  title?: unknown;
}

/** Pull the JSON object out of whatever a CLI wrapped it in. */
function extractJson(output: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(output);
  const candidates = [fenced?.[1], output];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* try the next one */
    }
  }
  throw new Error('The AI did not reply with JSON');
}

/**
 * Turn a model's reply into proposals, taking only the block numbers from it.
 * Anything it invented, mangled, or claimed twice is discarded, and whatever it
 * left behind is picked up by the rules — a file never loses text because a
 * model skipped it.
 */
export function readIngestPlan(output: string, fileName: string, blocks: Block[]): Proposal[] {
  const parsed = extractJson(output) as { items?: unknown };
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  const byIndex = new Map(blocks.map((b) => [b.index, b]));
  const claimed = new Set<number>();
  const out: Proposal[] = [];
  const base = path.basename(fileName || 'Pasted text').replace(/\.[^.]+$/, '') || 'Pasted text';

  for (const item of items as RawItem[]) {
    if (!item || typeof item !== 'object') continue;
    const kind = KINDS.includes(item.kind as SampleKind) ? (item.kind as SampleKind) : 'other';

    const wanted = Array.isArray(item.blocks) ? item.blocks : [];
    const picked: Block[] = [];
    for (const n of wanted) {
      const index = typeof n === 'number' ? n : Number.parseInt(String(n), 10);
      const block = byIndex.get(index);
      // Unknown or already-spoken-for blocks are simply not there.
      if (!block || claimed.has(index)) continue;
      claimed.add(index);
      picked.push(block);
    }
    if (picked.length === 0) continue;
    picked.sort((a, b) => a.index - b.index);

    const rawTitle = typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : '';
    const title = (rawTitle.length > 70 ? `${rawTitle.slice(0, 70).trimEnd()}…` : rawTitle)
      || labelFor(kind, picked[0]!.text, base);

    const made = build(kind, picked, title, 'ai');
    if (made) out.push(made);
  }

  // Whatever the model passed over still belongs to the user. The rules take
  // the leftovers, so nothing is lost to a model's silence.
  const leftOver = blocks.filter((b) => !claimed.has(b.index));
  if (leftOver.length > 0) {
    const renumbered = leftOver.map((b, i) => ({ index: i, text: b.text }));
    for (const proposal of sortByRules(fileName, renumbered)) {
      out.push({ ...proposal, blocks: proposal.blocks.map((i) => leftOver[i]!.index) });
    }
  }

  return out.sort((a, b) => (a.blocks[0] ?? 0) - (b.blocks[0] ?? 0));
}
