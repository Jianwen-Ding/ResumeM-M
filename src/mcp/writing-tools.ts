/**
 * The writing tools, and the authoring tools.
 *
 * Same shape as `tools.ts`: descriptions written for a model with no other
 * context, saying what a tool is for and when it is the wrong one. The
 * argument checking is deliberately forgiving in one direction — a single
 * string where a list was asked for is taken as a list of one — and unforgiving
 * in the other: a bullet with no quote from the material is refused, every
 * time, because that check is the only thing standing between "read what they
 * wrote" and "write a resume for them".
 */

import type { ToolDefinition, ToolResult } from './protocol.js';
import type { MoveResult } from './session.js';
import type { WritingSession } from './writing.js';
import type { AuthoringSession } from './authoring.js';

const text = (t: string): ToolResult => ({ text: t });
const from = (r: MoveResult): ToolResult => ({ text: r.text, isError: !r.ok });

function str(args: Record<string, unknown>, name: string): string | ToolResult {
  const value = args[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return {
    text: `This call needs a "${name}". It was ${value === undefined ? 'missing' : JSON.stringify(value)}.`,
    isError: true,
  };
}

/** A list of ids, or the complaint that says what arrived instead. */
function list(args: Record<string, unknown>, name: string): string[] | ToolResult {
  const value = args[name];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return { text: `This call needs "${name}" to be a list of ids. It was ${JSON.stringify(value)}.`, isError: true };
}

const isResult = (v: unknown): v is ToolResult => typeof v === 'object' && v !== null && 'text' in v;
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

/* ------------------------------------------------------------------ *
 * Writing a letter and the answers                                    *
 * ------------------------------------------------------------------ */

export function writingTools(session: WritingSession): ToolDefinition[] {
  return [
    {
      name: 'read_posting',
      description: 'The posting this is being written for. Start here.',
      inputSchema: NO_ARGS,
      run: () => text(session.describeJob()),
    },
    {
      name: 'read_resume',
      description:
        'The resume that will be sent with this letter. The letter is read beside it, so do not retell its lines — ' +
        'the reader already has them. What the letter says about this person has to be supported by it or by ' +
        'something they have written before; check_claim looks in both.',
      inputSchema: NO_ARGS,
      run: () => text(session.describeResume()),
    },
    {
      name: 'read_work',
      description:
        'What the form is asking for, what is already in the boxes, and what you have written so far. Anything ' +
        'already there was written by this person: build on it rather than replacing it.',
      inputSchema: NO_ARGS,
      run: () => text(session.describeWork()),
    },
    {
      name: 'find_my_letters',
      description:
        'Search the letters this person has already sent. Use it before writing: where one of them already says ' +
        'the thing well, adapt it — staying recognisably the same person across a season of applications matters ' +
        'more than novelty. Search for what this posting is about, not for the company name.',
      inputSchema: {
        type: 'object',
        properties: {
          about: { type: 'string', description: 'What to look for: a technology, a kind of work, a reason.' },
          limit: { type: 'number', description: 'How many to bring back. 3 by default, 5 at most.' },
        },
        required: ['about'],
      },
      run: (args) => {
        const about = str(args, 'about');
        if (isResult(about)) return about;
        return text(session.findLetters(about, Number(args.limit) || 3));
      },
    },
    {
      name: 'find_my_answers',
      description:
        'Search the answers this person has given to application questions before, ranked against a question you ' +
        'are about to answer. The same reasoning as find_my_letters: consistency beats novelty. It returns only ' +
        'answers that are about the question — if it says there is nothing close, there is nothing close, and ' +
        'the story for this one is in their letters before it is in the resume.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question you are answering.' },
          limit: { type: 'number' },
        },
        required: ['question'],
      },
      run: (args) => {
        const question = str(args, 'question');
        if (isResult(question)) return question;
        return text(session.findAnswers(question, Number(args.limit) || 3));
      },
    },
    {
      name: 'check_claim',
      description:
        'Before writing a sentence that says this person did something, check it against the resume and what they ' +
        'have written before. Give the claim — "cut latency from 900ms to 180ms with Kafka" — and this says ' +
        'whether the resume carries it or one of their earlier letters or answers tells it, and quotes where. Use ' +
        'it for every number. A rounded metric in a cover letter is the kind of mistake that is only found in an ' +
        'interview.',
      inputSchema: {
        type: 'object',
        properties: { claim: { type: 'string', description: 'What you are about to say they did.' } },
        required: ['claim'],
      },
      run: (args) => {
        const claim = str(args, 'claim');
        return isResult(claim) ? claim : from(session.checkClaim(claim));
      },
    },
    {
      name: 'save_letter',
      description:
        'The finished letter, as the argument. As long as the letters they send and no longer, in short ' +
        'paragraphs. No markdown, no salutation unless their own letters use one, no placeholder of any kind. ' +
        'Anything you want to say *about* the letter goes in finish, not here — this argument is the letter, word ' +
        'for word, and nothing else.',
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'string', description: 'The letter itself.' } },
        required: ['body'],
      },
      run: (args) => {
        const body = str(args, 'body');
        return isResult(body) ? body : from(session.saveLetter(body));
      },
    },
    {
      name: 'save_answer',
      description:
        'The answer to one question the form asked, by its id from read_work. Keep inside any word limit the ' +
        'question states, and otherwise match the length the question implies rather than filling the box.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question id from read_work.' },
          body: { type: 'string', description: 'The answer itself.' },
        },
        required: ['question', 'body'],
      },
      run: (args) => {
        const question = str(args, 'question');
        if (isResult(question)) return question;
        const body = str(args, 'body');
        if (isResult(body)) return body;
        return from(session.saveAnswer(question, body));
      },
    },
    {
      name: 'review_work',
      description: 'What you have written and what is still outstanding. Worth reading before finishing.',
      inputSchema: NO_ARGS,
      run: () => text(session.describeWritten()),
    },
    {
      name: 'finish',
      description:
        'Say you are done, and what you leaned on — which previous letter, which part of the resume. Shown to the ' +
        'person beside the draft, so write it for them. Call it once, last.',
      inputSchema: {
        type: 'object',
        properties: { reasoning: { type: 'string' } },
        required: ['reasoning'],
      },
      run: (args) => {
        const reasoning = str(args, 'reasoning');
        return isResult(reasoning) ? reasoning : from(session.done(reasoning));
      },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Reading a pile of material into the store                           *
 * ------------------------------------------------------------------ */

export function authoringTools(session: AuthoringSession): ToolDefinition[] {
  return [
    {
      name: 'list_documents',
      description: 'The files that were handed over. Start here, then read them.',
      inputSchema: NO_ARGS,
      run: () => text(session.listDocuments()),
    },
    {
      name: 'read_document',
      description:
        'The text of one file. Long ones come back in pieces: call it again with `from` set to where the last ' +
        'piece ended. Read a file all the way through before proposing anything out of it — the dates are usually ' +
        'in a different place from the achievements.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          from: { type: 'number', description: 'Character to start at. 0 by default.' },
        },
        required: ['id'],
      },
      run: (args) => {
        const id = str(args, 'id');
        return isResult(id) ? id : from(session.readDocument(id, Number(args.from) || 0));
      },
    },
    {
      name: 'read_store',
      description:
        'What is already in this person’s store. Read it before proposing: an entry that duplicates one already ' +
        'here is worse than nothing, and where the material says the same thing better the right move is an ' +
        'alternate wording on the bullet that exists.',
      inputSchema: NO_ARGS,
      run: () => text(session.describeStore()),
    },
    {
      name: 'propose_entry',
      description:
        'A job, a degree or a project you found in the material. Nothing is written to the store: this is a ' +
        'proposal the person reviews and accepts or declines, one at a time. Propose the entry first, then its ' +
        'bullets — an entry that still has none at the end is a heading, and is left out of the proposal.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A short id like exp_acme or proj_ingest.' },
          kind: { type: 'string', description: 'education, experience, project or custom.' },
          title: { type: 'string', description: 'The employer, the school, or the project name.' },
          subtitle: { type: 'string', description: 'The role, the degree, or the stack.' },
          dates: { type: 'string' },
          location: { type: 'string' },
          document: { type: 'string', description: 'The document id this was read out of.' },
        },
        required: ['id', 'kind', 'title', 'document'],
      },
      run: (args) => {
        for (const name of ['id', 'kind', 'title', 'document']) {
          const v = str(args, name);
          if (isResult(v)) return v;
        }
        return from(
          session.proposeEntry({
            id: String(args.id).trim(),
            kind: String(args.kind).trim() as never,
            title: String(args.title).trim(),
            subtitle: typeof args.subtitle === 'string' ? args.subtitle.trim() : undefined,
            dates: typeof args.dates === 'string' ? args.dates.trim() : undefined,
            location: typeof args.location === 'string' ? args.location.trim() : undefined,
            documentId: String(args.document).trim(),
          }),
        );
      },
    },
    {
      name: 'propose_bullet',
      description:
        'One line of an entry you proposed. `source` is the sentence in the material this is a rewording of, ' +
        'quoted as it appears there — it is checked, and a bullet whose quote is not in the document is refused. ' +
        'That check is the whole difference between reading what this person wrote and writing it for them, so ' +
        'do not paraphrase the quote: copy it.',
      inputSchema: {
        type: 'object',
        properties: {
          entry: { type: 'string', description: 'The id of the entry you proposed.' },
          text: { type: 'string', description: 'The bullet, as it would print.' },
          source: { type: 'string', description: 'The sentence in the material it came from, copied exactly.' },
          document: { type: 'string', description: 'Which document that sentence is in.' },
          label: { type: 'string', description: 'A short name for this wording.' },
        },
        required: ['entry', 'text', 'source'],
      },
      run: (args) => {
        const entry = str(args, 'entry');
        if (isResult(entry)) return entry;
        const body = str(args, 'text');
        if (isResult(body)) return body;
        const source = str(args, 'source');
        if (isResult(source)) return source;
        return from(
          session.proposeBullet(entry, {
            text: body,
            source,
            /*
             * Undefined rather than empty, because the session falls back to
             * the entry's own document with `??` — and `'' ?? x` is `''`, so
             * an empty string turned the documented fallback into "there is
             * no document \"\"", which is a confusing answer to a model that
             * simply left an optional argument out.
             */
            documentId: typeof args.document === 'string' && args.document.trim() ? args.document.trim() : undefined,
            label: typeof args.label === 'string' ? args.label : '',
          }),
        );
      },
    },
    {
      name: 'propose_alternate',
      description:
        'Another way of saying a line the store already has, found in the material. This is the right move when ' +
        'the material covers something already in the store — an old resume that puts a bullet better than the ' +
        'current wording does. Same rule: quote what it came from.',
      inputSchema: {
        type: 'object',
        properties: {
          bullet: { type: 'string', description: 'The id of the bullet in the store.' },
          text: { type: 'string' },
          source: { type: 'string' },
          document: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['bullet', 'text', 'source', 'document'],
      },
      run: (args) => {
        for (const name of ['bullet', 'text', 'source', 'document']) {
          const v = str(args, name);
          if (isResult(v)) return v;
        }
        return from(
          session.proposeAlternate(
            String(args.bullet).trim(),
            typeof args.label === 'string' ? args.label : '',
            String(args.text).trim(),
            String(args.source).trim(),
            String(args.document).trim(),
          ),
        );
      },
    },
    {
      name: 'propose_order',
      description:
        'A better order for the lines of an entry that is already in the store. The master document decides what ' +
        'order the lines inside an entry come in, and every resume that has not arranged its own follows it — so ' +
        'this is the one proposal that moves every document at once, and nothing is written until the person ' +
        'accepts it. Name only what moves: anything you leave out keeps its place behind what you named, so a line ' +
        'cannot be lost by being forgotten. Use it where the material makes plain that something matters more than ' +
        'its position suggests — the achievement buried fourth that the performance review opens with. Do not use ' +
        'it where the lines read as a sequence, such as a project that goes design, build, measure, and do not use ' +
        'it to restate the order they are already in.',
      inputSchema: {
        type: 'object',
        properties: {
          entry: { type: 'string', description: 'The entry id whose lines are being reordered.' },
          bullets: { type: 'array', items: { type: 'string' }, description: 'Line ids, the one to be read first at the front.' },
          why: { type: 'string', description: 'Why this order reads better. This is what the person is judging.' },
        },
        required: ['entry', 'bullets', 'why'],
      },
      run: (args) => {
        const entry = str(args, 'entry');
        if (isResult(entry)) return entry;
        const bullets = list(args, 'bullets');
        if (isResult(bullets)) return bullets;
        const why = str(args, 'why');
        if (isResult(why)) return why;
        return from(session.proposeOrder(entry, bullets, why));
      },
    },
    {
      name: 'propose_skill',
      description: 'A skill named in the material, for a group that already exists. Same rule: quote it.',
      inputSchema: {
        type: 'object',
        properties: {
          group: { type: 'string' },
          text: { type: 'string' },
          source: { type: 'string' },
          document: { type: 'string' },
        },
        required: ['group', 'text', 'source', 'document'],
      },
      run: (args) => {
        for (const name of ['group', 'text', 'source', 'document']) {
          const v = str(args, name);
          if (isResult(v)) return v;
        }
        return from(
          session.proposeSkill(
            String(args.group).trim(),
            String(args.text).trim(),
            String(args.source).trim(),
            String(args.document).trim(),
          ),
        );
      },
    },
    {
      name: 'review_proposal',
      description: 'Everything you have proposed, as the person will see it. Read it before finishing.',
      inputSchema: NO_ARGS,
      run: () => text(session.describeProposal()),
    },
    {
      name: 'finish',
      description:
        'Say you are done, and anything you noticed that you could not act on — a gap in the dates, two documents ' +
        'that disagree, something that looked important but had no evidence behind it. Call it once, last.',
      inputSchema: {
        type: 'object',
        properties: { notes: { type: 'string' } },
        required: ['notes'],
      },
      run: (args) => {
        const notes = str(args, 'notes');
        return isResult(notes) ? notes : from(session.done(notes));
      },
    },
  ];
}
