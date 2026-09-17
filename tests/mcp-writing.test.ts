import { describe, expect, it } from 'vitest';
import { WritingSession } from '../src/mcp/writing.js';
import { AuthoringSession, type SourceDocument } from '../src/mcp/authoring.js';
import { authoringTools, writingTools } from '../src/mcp/writing-tools.js';
import { handle } from '../src/mcp/protocol.js';
import { resolveResume } from '../src/model/resolve.js';
import { resumeAsText } from '../src/ai/prompts.js';
import { makeTempStore } from './helpers.js';
import type { StoreData } from '../src/model/types.js';

const store = (): StoreData => {
  const t = makeTempStore();
  try {
    return t.store.load();
  } finally {
    t.cleanup();
  }
};

const POSTING = {
  company: 'Helios Robotics',
  jobTitle: 'Platform Engineer',
  description: 'Streaming ingest, Kafka, and keeping latency down under load.',
};

function writing(draft?: Parameters<typeof makeWriting>[0]) {
  return makeWriting(draft);
}

function makeWriting(
  draft: { coverLetter: { required: boolean; body: string }; questions: { id: string; question: string; answer?: string; source?: string }[] } = {
    coverLetter: { required: true, body: '' },
    questions: [{ id: 'q1', question: 'Why this role?' }],
  },
) {
  const data = store();
  const resolved = resolveResume('base', data);
  return new WritingSession(data, resolved, POSTING, draft as never, resumeAsText(resolved));
}

/**
 * A letter is asked for in one go and comes back in one go, and everything
 * that makes it wrong is only discoverable by reading it. These are the four
 * things the tools can check that a single reply cannot.
 */
describe('writing a letter as moves', () => {
  it('takes the letter as an argument, so prose around it is not the letter', () => {
    const s = writing();
    const letter = 'x'.repeat(400);
    expect(s.saveLetter(letter).ok).toBe(true);
    expect(s.state.letter).toBe(letter);
  });

  it('refuses a sentence pretending to be a letter', () => {
    const r = writing().saveLetter('Here is the draft.');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('a sentence rather than a letter');
  });

  /*
   * A letter with [Company] in it is worse than one that never mentions them,
   * and it is exactly the shape a model produces when it is unsure.
   */
  it('refuses a placeholder', () => {
    for (const bad of [`Dear [Company], ${'x'.repeat(300)}`, `${'x'.repeat(300)} TODO finish this`, `${'x'.repeat(300)} <role>`]) {
      expect(writing().saveLetter(bad).ok, bad.slice(0, 30)).toBe(false);
    }
  });

  it('answers only the questions the form actually asked', () => {
    const s = writing();
    expect(s.saveAnswer('q1', 'Because the ingest work is the part I like.').ok).toBe(true);
    const wrong = s.saveAnswer('q9', 'anything');
    expect(wrong.ok).toBe(false);
    expect(wrong.text).toContain('q1');
  });

  it('will not finish having written nothing', () => {
    expect(writing().done('I thought about it.').ok).toBe(false);
  });

  it('says what is still outstanding', () => {
    const s = writing();
    s.saveLetter('x'.repeat(400));
    expect(s.describeWritten()).toContain('0 of 1 questions answered');
    expect(s.describeWritten()).toContain('q1');
  });
});

/**
 * The one question a letter most needs answered, and the one a single-shot
 * prompt cannot answer: a model doing a lookup from memory mid-sentence is a
 * model about to round a number.
 */
describe('checking a claim against the resume', () => {
  it('confirms something the resume carries, and quotes the line', () => {
    const r = writing().checkClaim('pipeline handling 2M events');
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/pipeline/i);
  });

  /*
   * The base resume prints the neutral wording of that bullet, not the Kafka
   * one — so a letter claiming Kafka is claiming something the page the
   * reader is holding does not say. Exactly the case this exists for.
   */
  it('refuses a claim that is in the store but not on this resume', () => {
    const r = writing().checkClaim('built a Kafka pipeline');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('kafka');
  });

  it('refuses something it does not, and says not to write it', () => {
    const r = writing().checkClaim('Rust compiler internals');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Do not write it');
  });

  it('is explicit about the half-true case, which is the dangerous one', () => {
    const r = writing().checkClaim('pipeline at Snowflake');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Partly');
    expect(r.text).toContain('pipeline');
    expect(r.text).toContain('snowflake');
  });

  it('asks for something to look for when given nothing', () => {
    expect(writing().checkClaim('a of').ok).toBe(false);
  });
});

describe('looking at what was written before', () => {
  it('searches the letters rather than handing over a ranked three', () => {
    const s = writing();
    const found = s.findLetters('Acme');
    expect(found).toContain('Acme');
  });

  it('says so plainly when there are none', () => {
    const data = store();
    const bare = { ...data, coverLetters: [] };
    const resolved = resolveResume('base', data);
    const s = new WritingSession(bare, resolved, POSTING, { coverLetter: { required: true, body: '' }, questions: [] } as never, '');
    expect(s.findLetters('anything')).toContain('This will be the first');
  });

  it('does not throw away what is already in the box', () => {
    const s = makeWriting({ coverLetter: { required: true, body: 'Half a paragraph I typed myself.' }, questions: [] });
    expect(s.describeWork()).toContain('do not throw it away');
    expect(s.describeWork()).toContain('Half a paragraph I typed myself.');
  });

  it('flags a question that already has an answer', () => {
    const s = makeWriting({
      coverLetter: { required: false, body: '' },
      questions: [{ id: 'q1', question: 'Why us?', answer: 'Something I wrote.' }],
    });
    expect(s.describeWork()).toContain('do not replace it blindly');
    expect(s.describeWork()).toContain('Something I wrote.');
  });
});

/* ------------------------------------------------------------------ *
 * Reading a pile of material into the store                           *
 * ------------------------------------------------------------------ */

const RESUME_DOC: SourceDocument = {
  id: 'd1',
  name: 'old-resume.pdf',
  kind: 'resume',
  text: [
    'JIANWEN DING',
    'Vega Analytics — Backend Engineer, 2023–2024',
    'Built a Kafka-backed ingest pipeline handling 2M events a day.',
    'Cut median end-to-end latency from 900ms to 180ms.',
    'Northeastern University, BS Computer Science',
  ].join('\n'),
};

function authoring(docs: SourceDocument[] = [RESUME_DOC]) {
  return new AuthoringSession(docs, {
    entryIds: ['exp_acme'],
    bulletIds: ['b_pipeline', 'b_testing'],
    skillGroups: [{ id: 'sk_lang', name: 'Languages' }],
  });
}

/**
 * The line moves here — this is the one session where the AI writes text that
 * ends up on a resume — so it moves in exactly one place: everything it
 * proposes must be *from the material*, and nothing it proposes is written to
 * the store. A model that has to point at the sentence it is paraphrasing
 * cannot invent a job, and that is the whole mechanism.
 */
describe('reading material into a proposal', () => {
  it('takes an entry that is in the material', () => {
    const s = authoring();
    const r = s.proposeEntry({
      id: 'exp_vega',
      kind: 'experience',
      title: 'Vega Analytics',
      documentId: 'd1',
    });
    expect(r.ok).toBe(true);
    expect(s.state.entries).toHaveLength(1);
  });

  it('refuses an entry that is not', () => {
    const r = authoring().proposeEntry({
      id: 'exp_google',
      kind: 'experience',
      title: 'Google',
      documentId: 'd1',
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('not in old-resume.pdf');
  });

  it('refuses a bullet whose quote is not in the document', () => {
    const s = authoring();
    s.proposeEntry({ id: 'exp_vega', kind: 'experience', title: 'Vega Analytics', documentId: 'd1' });
    const r = s.proposeBullet('exp_vega', {
      label: 'Scale',
      text: 'Handled 200M events a day at global scale',
      source: 'Built a pipeline handling 200M events a day.',
      documentId: 'd1',
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('reading what they wrote, not writing it for them');
  });

  it('takes one whose quote is there, even retyped with different punctuation', () => {
    const s = authoring();
    s.proposeEntry({ id: 'exp_vega', kind: 'experience', title: 'Vega Analytics', documentId: 'd1' });
    // Curly apostrophes, collapsed spacing, a dropped full stop — what a model
    // that re-types a quote actually produces.
    const r = s.proposeBullet('exp_vega', {
      label: 'Ingest',
      text: 'Built a Kafka-backed ingest pipeline handling 2M events a day',
      source: 'Built a Kafka—backed  ingest pipeline handling 2M events a day',
      documentId: 'd1',
    });
    expect(r.ok, r.text).toBe(true);
  });

  it('will not collide with something already in the store', () => {
    const r = authoring().proposeEntry({ id: 'exp_acme', kind: 'experience', title: 'Vega Analytics', documentId: 'd1' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('already an entry');
  });

  it('points at the bullet that exists when the material rewords it', () => {
    const s = authoring();
    const r = s.proposeAlternate(
      'b_pipeline',
      'From your old resume',
      'Cut median end-to-end latency from 900ms to 180ms',
      'Cut median end-to-end latency from 900ms to 180ms.',
      'd1',
    );
    expect(r.ok).toBe(true);
    expect(s.state.alternates).toHaveLength(1);
  });

  it('refuses an alternate for a bullet that is not in the store', () => {
    expect(authoring().proposeAlternate('b_nope', 'x', 'y', 'Cut median end-to-end latency', 'd1').ok).toBe(false);
  });

  it('refuses to finish with an entry that is only a heading', () => {
    const s = authoring();
    s.proposeEntry({ id: 'exp_vega', kind: 'experience', title: 'Vega Analytics', documentId: 'd1' });
    const r = s.done('Read the resume.');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('exp_vega');
  });

  it('says plainly that nothing has been written to the store', () => {
    const s = authoring();
    s.proposeEntry({ id: 'exp_vega', kind: 'experience', title: 'Vega Analytics', documentId: 'd1' });
    s.proposeBullet('exp_vega', {
      label: 'Ingest',
      text: 'Built a Kafka-backed ingest pipeline',
      source: 'Built a Kafka-backed ingest pipeline handling 2M events a day.',
      documentId: 'd1',
    });
    expect(s.describeProposal()).toContain('None of this is in the store');
    expect(s.done('Done.').ok).toBe(true);
  });

  it('hands long documents over in pieces rather than all at once', () => {
    const long: SourceDocument = { id: 'd2', name: 'big.txt', text: 'a'.repeat(60_000) };
    const r = authoring([long]).readDocument('d2', 0);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('call read_document again with from=');
  });

  it('names the documents when asked for one that is not there', () => {
    const r = authoring().readDocument('d9');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('d1');
  });

  it('tells it what is already in the store, and what to do about it', () => {
    const text = authoring().describeStore();
    expect(text).toContain('exp_acme');
    expect(text).toContain('b_pipeline');
    expect(text).toContain('propose an alternate wording');
  });
});

/* ------------------------------------------------------------------ *
 * Both, over the protocol                                             *
 * ------------------------------------------------------------------ */

const INFO = { name: 'test', version: '1' };

describe('both sets of tools, as tools', () => {
  it('describes every writing tool well enough to be used', async () => {
    const reply = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, writingTools(writing()), INFO)) as {
      result: { tools: { name: string; description: string }[] };
    };
    const names = reply.result.tools.map((t) => t.name);
    expect(names).toEqual([
      'read_posting',
      'read_resume',
      'read_work',
      'find_my_letters',
      'find_my_answers',
      'check_claim',
      'save_letter',
      'save_answer',
      'review_work',
      'finish',
    ]);
    for (const t of reply.result.tools) expect(t.description.length).toBeGreaterThan(40);
  });

  it('describes every authoring tool well enough to be used', async () => {
    const reply = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, authoringTools(authoring()), INFO)) as {
      result: { tools: { name: string; description: string }[] };
    };
    expect(reply.result.tools.map((t) => t.name)).toEqual([
      'list_documents',
      'read_document',
      'read_store',
      'propose_entry',
      'propose_bullet',
      'propose_alternate',
      'propose_skill',
      'review_proposal',
      'finish',
    ]);
  });

  it('hands a refusal to the model rather than to the transport', async () => {
    const reply = (await handle(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'save_letter', arguments: { body: 'too short' } },
      },
      writingTools(writing()),
      INFO,
    )) as { result: { content: { text: string }[]; isError: boolean }; error?: unknown };
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('a sentence rather than a letter');
  });

  it('complains about a missing argument in words', async () => {
    const reply = (await handle(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'propose_bullet', arguments: { entry: 'x' } } },
      authoringTools(authoring()),
      INFO,
    )) as { result: { content: { text: string }[]; isError: boolean } };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('"text"');
  });
});
