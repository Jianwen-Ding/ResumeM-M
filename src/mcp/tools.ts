/**
 * The moves, as tools.
 *
 * Descriptions are written for the reader who will actually use them, which
 * is a model with no other context: each one says what the tool does, when it
 * is the right one to reach for, and — where it matters — when it is not.
 * "Reorders bullets" is a description of a function signature; "put the line
 * this posting is about at the top, because a reader gives the first bullet
 * more attention than the last" is a description of a move.
 */

import type { ToolDefinition, ToolResult } from './protocol.js';
import type { MoveResult, TailorSession } from './session.js';

const text = (t: string): ToolResult => ({ text: t });
const from = (r: MoveResult): ToolResult => ({ text: r.text, isError: !r.ok });

/** A required string argument, or a complaint a model can act on. */
function str(args: Record<string, unknown>, name: string): string | ToolResult {
  const value = args[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return { text: `This call needs a "${name}". It was ${value === undefined ? 'missing' : JSON.stringify(value)}.`, isError: true };
}

/** A required array-of-strings argument. A bare string counts as a list of one. */
function list(args: Record<string, unknown>, name: string): string[] | ToolResult {
  const value = args[name];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return { text: `This call needs "${name}" to be a list of ids. It was ${JSON.stringify(value)}.`, isError: true };
}

const isResult = (v: unknown): v is ToolResult => typeof v === 'object' && v !== null && 'text' in v;

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

export function tailorTools(session: TailorSession): ToolDefinition[] {
  return [
    {
      name: 'read_posting',
      description:
        'The job posting this resume is being tailored for: the company, the role, and the description as it was ' +
        'read off the page. Start here. Everything else is a decision about this text.',
      inputSchema: NO_ARGS,
      run: () => text(session.describePosting()),
    },
    {
      name: 'read_resume',
      description:
        'The resume as it stands right now, in the order it prints, with the id of every entry and bullet. Call it ' +
        'again after making changes to see what they did — the ids here are the ones the other tools take.',
      inputSchema: NO_ARGS,
      run: () => text(session.describeResume()),
    },
    {
      name: 'read_inventory',
      description:
        'Everything this person has written that could go on the page, whether it is on this resume or not: every ' +
        'entry, every bullet, and every alternative wording of each, with ids and tags. This is the whole of what ' +
        'you may choose from. Nothing outside it can end up on a resume.',
      inputSchema: NO_ARGS,
      run: () => text(session.describeInventory()),
    },
    {
      name: 'choose_wording',
      description:
        'Use a different wording that this person has already written, for one bullet or one of an entry’s fields. ' +
        'This is the main move. Only make it when the posting gives a concrete reason — it names a technology, a ' +
        'domain or a responsibility that another wording addresses more directly. Most bullets should keep the ' +
        'wording they have.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'A bullet id like b_pipeline, or a field like edu_neu.dates.' },
          variant: { type: 'string', description: 'The id of the wording to use.' },
        },
        required: ['target', 'variant'],
      },
      run: (args) => {
        const target = str(args, 'target');
        if (isResult(target)) return target;
        const variant = str(args, 'variant');
        if (isResult(variant)) return variant;
        return from(session.choose(target, variant));
      },
    },
    {
      name: 'reorder_bullets',
      description:
        'Put an entry’s bullets in a different order. The cheapest real tailoring there is: a reader gives the first ' +
        'bullet of an entry more attention than the last, so the line this posting is about belongs at the top. Name ' +
        'only what moves — anything you leave out keeps its place behind what you named, and nothing can be added or ' +
        'lost this way. Do not use it where the bullets read as a sequence, such as a project that goes design, ' +
        'build, measure. It moves the lines inside one entry only: entries themselves are never reordered. ' +
        'This order belongs to this resume alone, and is the one thing that takes an entry out of the house order: ' +
        'lines normally sit in the order the master document holds them, and rearranging the master moves them on ' +
        'every resume at once. An entry you reorder here stops following the master and keeps what you gave it. So ' +
        'reorder where this posting wants a different emphasis, not where the order is simply wrong — the second is ' +
        'a fix for the master, and belongs there.',
      inputSchema: {
        type: 'object',
        properties: {
          entry: { type: 'string', description: 'The entry id whose bullets are being reordered.' },
          bullets: { type: 'array', items: { type: 'string' }, description: 'Bullet ids, most relevant first.' },
        },
        required: ['entry', 'bullets'],
      },
      run: (args) => {
        const entry = str(args, 'entry');
        if (isResult(entry)) return entry;
        const bullets = list(args, 'bullets');
        if (isResult(bullets)) return bullets;
        return from(session.order(entry, bullets));
      },
    },
    /*
     * No `reorder_entries`. "AI should be able to rearrange bullet points but
     * not entries ever": the order of a section's entries is the person's.
     * See `TailorSession.orderEntries`, which refuses as well.
     */
    {
      name: 'hide',
      description:
        'Leave an entry or a bullet off this resume. For content that is irrelevant to this posting, and for making ' +
        'room when the page is full. It does not delete anything — the line stays in the store and on every other ' +
        'resume. Should be rare.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'An entry id or a bullet id.' } },
        required: ['id'],
      },
      run: (args) => {
        const id = str(args, 'id');
        return isResult(id) ? id : from(session.hide(id));
      },
    },
    {
      name: 'show',
      description:
        'Put an entry or a bullet that is in the store but not on this resume onto it. For work the posting ' +
        'specifically calls for. Should be rare, and usually means hiding something else to make room.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'An entry id or a bullet id.' } },
        required: ['id'],
      },
      run: (args) => {
        const id = str(args, 'id');
        return isResult(id) ? id : from(session.show(id));
      },
    },
    {
      name: 'choose_skills',
      description:
        'Choose which items of a skills group to print. Keep what the posting asks for; drop what it has no use for. ' +
        'They print in the order this person arranged them, not the order you name them in.',
      inputSchema: {
        type: 'object',
        properties: {
          group: { type: 'string', description: 'The skills group id.' },
          items: { type: 'array', items: { type: 'string' }, description: 'Item ids to keep.' },
        },
        required: ['group', 'items'],
      },
      run: (args) => {
        const group = str(args, 'group');
        if (isResult(group)) return group;
        const items = list(args, 'items');
        if (isResult(items)) return items;
        return from(session.skills(group, items));
      },
    },
    {
      name: 'suggest_wording',
      description:
        'Propose a wording that does not exist yet, for a bullet that has none covering something the posting ' +
        'clearly asks for. It does NOT go on the resume: it is shown to the person, who accepts or declines it. ' +
        'It must describe the same real work as the bullet it belongs to, with no new claim of any kind. At most ' +
        'three, and none at all is the expected answer most of the time.',
      inputSchema: {
        type: 'object',
        properties: {
          bullet: { type: 'string', description: 'The bullet this is another way of saying.' },
          label: { type: 'string', description: 'A short name for it, like "Kafka".' },
          text: { type: 'string', description: 'The proposed sentence.' },
          why: { type: 'string', description: 'What in the posting justifies it.' },
        },
        required: ['bullet', 'text', 'why'],
      },
      run: (args) => {
        const bullet = str(args, 'bullet');
        if (isResult(bullet)) return bullet;
        const body = str(args, 'text');
        if (isResult(body)) return body;
        const why = str(args, 'why');
        if (isResult(why)) return why;
        const label = typeof args.label === 'string' ? args.label : '';
        return from(session.suggest(bullet, label, body, why));
      },
    },
    {
      name: 'review_changes',
      description: 'Everything you have decided so far, in one place. Worth reading before finishing.',
      inputSchema: NO_ARGS,
      run: () => text(session.describePlan()),
    },
    {
      name: 'finish',
      description:
        'Say you are done, and why. Two to four sentences on what drove the changes — it is shown to the person ' +
        'beside the changes themselves, so write it for them rather than as a log. Call this exactly once, last.',
      inputSchema: {
        type: 'object',
        properties: { reasoning: { type: 'string', description: 'What drove the changes.' } },
        required: ['reasoning'],
      },
      run: (args) => {
        const reasoning = str(args, 'reasoning');
        return isResult(reasoning) ? reasoning : from(session.done(reasoning));
      },
    },
  ];
}
