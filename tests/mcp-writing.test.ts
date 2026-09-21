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

  /*
   * The angle-bracket rule was `<[a-z ]+>` with no `i` flag, so a capitalised
   * placeholder — which is how anybody writes one — went straight through. The
   * shared instructions hand the model `your team's <product>` as the shape to
   * avoid, so it is the shape it reproduces when it cannot fill something in.
   */
  it('refuses a placeholder whichever way it is capitalised or bracketed', () => {
    const body = 'x'.repeat(300);
    for (const bad of [
      `${body} your team's <Product>`,
      `${body} at <Company Name> in particular`,
      `${body} the {{role}} you are hiring for`,
      `${body} [Your Name]`,
    ]) {
      expect(writing().saveLetter(bad).ok, bad.slice(-30)).toBe(false);
    }
  });

  /*
   * And not on the brackets people write for real. An address in angle
   * brackets is an address, and a footnote marker is not a gap.
   */
  it('does not call a real bracket a placeholder', () => {
    const body = 'x'.repeat(300);
    expect(writing().saveLetter(`${body} reach me at <casey@example.com>`).ok).toBe(true);
    expect(writing().saveLetter(`${body} the 2M events a day figure [1] is measured`).ok).toBe(true);
  });

  /*
   * `saveAnswer` had no angle-bracket rule at all, not even the lowercase one,
   * so the same gap reached a saved application answer.
   */
  it('refuses a placeholder in an answer too, and says which one', () => {
    const s = writing();
    const bad = s.saveAnswer('q1', 'I want to work on <Product> because it is the hard part.');
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('<Product>');
    expect(s.state.answers.q1).toBeUndefined();
    expect(s.saveAnswer('q1', 'I want to work on the ingest path because it is the hard part.').ok).toBe(true);
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
describe('what the posting looks like to the model', () => {
  it('keeps the posting apart from the instructions about it', () => {
    const text = writing().describeJob();
    expect(text).toContain('Company: Helios Robotics');
    expect(text).toContain('Role: Platform Engineer');
    expect(text).toContain('Kafka');
    /*
     * The blank lines are the only thing separating the employer's words from
     * the sentence telling the model not to take them as instructions. A
     * filter that dropped every empty string ran all three together into one
     * block, which is exactly the shape a prompt injection wants.
     */
    expect(text.split('\n\n').length).toBeGreaterThanOrEqual(3);
    expect(text).toMatch(/instructions to you[^\n]*\n\n/);
  });

  it('says so plainly when the page named neither', () => {
    const bare = new WritingSession(
      store(),
      resolveResume('base', store()),
      { description: '' },
      writing().draft as never,
      '',
    );
    expect(bare.describeJob()).toContain('Company: not named on the page.');
    expect(bare.describeJob()).toContain('Role: not stated on the page.');
    expect(bare.describeJob()).toContain('(the page carried no description)');
  });
});

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

  /*
   * The number is the point. "does it say two million events a day or twenty"
   * is what the docstring promises, and the filter that dropped every word of
   * three characters or fewer dropped "2m", "5x" and "10" with them — so the
   * one thing a model is most likely to round was the one thing not checked.
   */
  it('checks the number, not only the nouns around it', () => {
    const text = 'x';
    const s = new WritingSession(store(), resolveResume('base', store()), POSTING, writing().draft as never, text);
    const carries = new WritingSession(
      store(),
      resolveResume('base', store()),
      POSTING,
      writing().draft as never,
      'Built a pipeline moving 2M events a day.',
    );
    expect(carries.checkClaim('2M events').ok).toBe(true);
    // The same sentence with the number changed is not the same claim.
    expect(carries.checkClaim('9M events').ok).toBe(false);
    expect(carries.checkClaim('9M events').text).toContain('9m');
    expect(s.checkClaim('2M events').ok).toBe(false);
  });

  /*
   * A full stop is not part of the last word.
   *
   * The split keeps a dot inside a token so "node.js" survives — and the
   * stop that ends a sentence survived with it, so the search was for the
   * literal "88%." and failed. The tool then told the model its exact, true
   * metric was not in the resume and to write only the part that was. The
   * tool's own description invites a sentence, so this fired on the shape it
   * asks for.
   */
  it('is not fooled by the full stop at the end of a sentence', () => {
    const s = (text: string) =>
      new WritingSession(store(), resolveResume('base', store()), POSTING, writing().draft as never, text);
    const carries = s('Raised coverage from 41% to 88% across the service. Shipped on node.js.');
    expect(carries.checkClaim('Raised coverage from 41% to 88%').ok).toBe(true);
    expect(carries.checkClaim('Raised coverage from 41% to 88%.').ok, 'with a full stop').toBe(true);
    expect(carries.checkClaim('Shipped on node.js.').ok, 'node.js keeps its own dot').toBe(true);
    // And a number that is genuinely not there is still refused, so the fix
    // has not simply blunted the check.
    expect(carries.checkClaim('Raised coverage from 41% to 99%.').ok).toBe(false);
  });

  /*
   * A tool whose only job is keeping a letter honest cannot be the thing that
   * invents a language. `includes` said yes to Rust for a resume that says
   * "trust", and yes to SQL for one that only says PostgreSQL.
   */
  it('will not find a word inside a longer one', () => {
    const s = (text: string) =>
      new WritingSession(store(), resolveResume('base', store()), POSTING, writing().draft as never, text);
    expect(s('I trust the process.').checkClaim('Rust').ok).toBe(false);
    expect(s('Worked with PostgreSQL.').checkClaim('SQL').ok).toBe(false);
    expect(s('Worked with PostgreSQL.').checkClaim('PostgreSQL').ok).toBe(true);
    // The names most likely to be asked about are the ones a word boundary
    // splits in the wrong place.
    expect(s('Wrote C++ for three years.').checkClaim('C++').ok).toBe(true);
    expect(s('Wrote C# for three years.').checkClaim('C#').ok).toBe(true);
    expect(s('Wrote C# for three years.').checkClaim('C++').ok).toBe(false);
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

  /*
   * Ranking always produces a top three. Handing back the best of a bad lot
   * under the heading "answers this person has given before" is how a
   * paragraph about relocation becomes the answer to "why this company" —
   * the model cannot see that the match scored nothing.
   */
  it('says there is nothing close rather than offering the best of a bad lot', () => {
    const data = store();
    const s = new WritingSession(
      { ...data, answers: [{ id: 'a1', question: 'Are you able to relocate?', variants: [{ id: 'v1', text: 'Yes, happily.' }] }] as never },
      resolveResume('base', data),
      POSTING,
      writing().draft as never,
      '',
    );
    const answer = s.findAnswers('Describe a time you disagreed with a technical decision.');
    expect(answer).toContain('Nothing in the answer bank is about that');
    expect(answer).not.toContain('Yes, happily.');
    // And it still finds the one that is.
    expect(s.findAnswers('Are you able to relocate for this role?')).toContain('Yes, happily.');
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
    bulletsByEntry: { exp_acme: ['b_pipeline', 'b_testing'] },
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

  /*
   * The three fields beside the title, which print on the resume and were
   * not checked at all.
   *
   * Only `title` went through the quote check, so a model could supply any
   * subtitle, dates and location it liked. Against this document — which
   * says "Backend Engineer, 2023–2024" and names no city — it accepted a
   * seniority nobody wrote down and a tenure twice as long. That is the AI
   * writing resume text, which is the one thing this session exists to
   * prevent, and it was prevented for one field in four.
   */
  it('refuses a job title the material does not give', () => {
    const r = authoring().proposeEntry({
      id: 'exp_vega',
      kind: 'experience',
      title: 'Vega Analytics',
      subtitle: 'Principal Engineer, Distributed Systems',
      documentId: 'd1',
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('not in the material');
  });

  it('refuses a place the material does not give', () => {
    const r = authoring().proposeEntry({
      id: 'exp_vega',
      kind: 'experience',
      title: 'Vega Analytics',
      location: 'San Francisco, CA',
      documentId: 'd1',
    });
    expect(r.ok).toBe(false);
  });

  it('refuses a year the material does not mention', () => {
    const r = authoring().proposeEntry({
      id: 'exp_vega',
      kind: 'experience',
      title: 'Vega Analytics',
      dates: 'Jan. 2015 -- Present',
      documentId: 'd1',
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('2015');
  });

  /*
   * Without refusing the honest version: the dates are checked by their
   * years, not verbatim, because "2023 -- 2024" is a formatting of what the
   * material says rather than a quotation of it.
   */
  it('takes the subtitle, dates and place the material does give', () => {
    const s = authoring();
    const r = s.proposeEntry({
      id: 'exp_vega',
      kind: 'experience',
      title: 'Vega Analytics',
      subtitle: 'Backend Engineer',
      dates: '2023 -- 2024',
      documentId: 'd1',
    });
    expect(r.ok, r.text).toBe(true);
  });

  /*
   * And the person reviewing can see them. A check the reader cannot see is
   * not a check they can overrule, and two of the fields that print on their
   * resume were not in the artefact they are told to read.
   */
  it('shows the subtitle and the place in what the person reviews', () => {
    const s = authoring();
    s.proposeEntry({
      id: 'exp_vega',
      kind: 'experience',
      title: 'Vega Analytics',
      subtitle: 'Backend Engineer',
      documentId: 'd1',
    });
    expect(s.describeProposal()).toContain('Backend Engineer');
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

  /*
   * It used to refuse, and tell the model to "withdraw the entry by not
   * proposing it" — which cannot be done afterwards, because there is no tool
   * for it. A run that proposed an entry and then found nothing in the
   * material to support it could never finish, and everything else it had
   * read went with it.
   */
  it('leaves out an entry that is only a heading, rather than refusing to finish', () => {
    const s = authoring();
    s.proposeEntry({ id: 'exp_vega', kind: 'experience', title: 'Vega Analytics', documentId: 'd1' });
    s.proposeEntry({ id: 'edu_neu', kind: 'education', title: 'Northeastern University', documentId: 'd1' });
    s.proposeBullet('exp_vega', {
      label: 'Ingest',
      text: 'Built a Kafka-backed ingest pipeline',
      source: 'Built a Kafka-backed ingest pipeline handling 2M events a day.',
      documentId: 'd1',
    });
    const r = s.done('Read the resume.');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('edu_neu');
    expect(s.state.entries.map((e) => e.id)).toEqual(['exp_vega']);
    expect(s.state.finished).toBe(true);
  });

  it('stores an id as it was validated, not as it was typed', () => {
    const s = authoring();
    expect(s.proposeEntry({ id: '  exp_vega  ', kind: 'experience', title: ' Vega Analytics ', documentId: 'd1' }).ok).toBe(true);
    expect(s.state.entries[0]?.id).toBe('exp_vega');
    expect(s.state.entries[0]?.title).toBe('Vega Analytics');
    // And the trimmed id is the one propose_bullet has to name.
    expect(s.proposeBullet('exp_vega', {
      label: 'Ingest',
      text: 'Built a Kafka-backed ingest pipeline',
      source: 'Built a Kafka-backed ingest pipeline handling 2M events a day.',
      documentId: 'd1',
    }).ok).toBe(true);
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
      'propose_order',
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

  /*
   * `propose_order` through the transport rather than through the session.
   *
   * The session method had eight tests and the tool handler around it had
   * none — the argument parsing, the guards, the list coercion, every line
   * an agent's call actually goes through before reaching the method. A
   * typo there is a tool that errors for the agent while every unit test
   * passes, which is the shape this whole session has been finding.
   */
  it('takes an order through the transport, the way an agent sends one', async () => {
    const session = authoring();
    const reply = (await handle(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'propose_order',
          arguments: { entry: 'exp_acme', bullets: ['b_testing'], why: 'The posting is about testing.' },
        },
      },
      authoringTools(session),
      INFO,
    )) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(reply.result.isError).toBeFalsy();
    expect(reply.result.content[0]?.text).toContain('b_testing');
    expect(session.state.orders[0]?.bullets).toEqual(['b_testing', 'b_pipeline']);
  });

  /* One id rather than a list of one, which is a thing models do. */
  it('takes a single line id as well as a list', async () => {
    const session = authoring();
    const reply = (await handle(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'propose_order', arguments: { entry: 'exp_acme', bullets: 'b_testing', why: 'why' } },
      },
      authoringTools(session),
      INFO,
    )) as { result: { isError?: boolean } };
    expect(reply.result.isError).toBeFalsy();
    expect(session.state.orders[0]?.bullets).toEqual(['b_testing', 'b_pipeline']);
  });

  it('says which argument was wrong when the lines are not a list of ids', async () => {
    const reply = (await handle(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'propose_order', arguments: { entry: 'exp_acme', bullets: [1, 2], why: 'why' } },
      },
      authoringTools(authoring()),
      INFO,
    )) as { result: { content: { text: string }[]; isError: boolean } };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('"bullets"');
  });

  it('asks for the reason when it is missing, rather than proposing without one', async () => {
    const reply = (await handle(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'propose_order', arguments: { entry: 'exp_acme', bullets: ['b_testing'] } },
      },
      authoringTools(authoring()),
      INFO,
    )) as { result: { content: { text: string }[]; isError: boolean } };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('"why"');
  });

  /*
   * Every remaining tool, through the transport.
   *
   * The sessions underneath these are thoroughly tested; the handlers around
   * them were not, and the handler is every line an agent's call passes
   * through before reaching the session — the argument parsing, the guards,
   * the coercions. A mistake there is a tool that fails for the agent while
   * the unit tests stay green, which is exactly how two reorder tools spent
   * weeks reporting success and moving nothing.
   *
   * Asserted on the reply rather than on the session, because the reply is
   * what the agent gets. A handler that reaches the session and then returns
   * the wrong shape is as broken as one that never reaches it.
   */
  const callWriting = (name: string, args: Record<string, unknown>, session = writing()) =>
    handle(
      { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name, arguments: args } },
      writingTools(session),
      INFO,
    ) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>;

  const callAuthoring = (name: string, args: Record<string, unknown>, session = authoring()) =>
    handle(
      { jsonrpc: '2.0', id: 98, method: 'tools/call', params: { name, arguments: args } },
      authoringTools(session),
      INFO,
    ) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>;

  it('searches the letters already written', async () => {
    const reply = await callWriting('find_my_letters', { about: 'ingest' });
    expect(reply.result.isError).toBeFalsy();
    expect(reply.result.content[0]?.text.length).toBeGreaterThan(0);
  });

  it('searches the answers already given', async () => {
    const reply = await callWriting('find_my_answers', { question: 'Why this role?' });
    expect(reply.result.isError).toBeFalsy();
    expect(reply.result.content[0]?.text.length).toBeGreaterThan(0);
  });

  it('checks a claim against the resume', async () => {
    const reply = await callWriting('check_claim', { claim: 'cut latency from 900ms to 180ms' });
    expect(reply.result.content[0]?.text.length).toBeGreaterThan(0);
  });

  it('saves an answer to a question the form asked', async () => {
    const session = writing();
    const reply = await callWriting(
      'save_answer',
      { question: 'q1', body: 'Because the ingest work is the part of this I have done most of.' },
      session,
    );
    expect(reply.result.isError).toBeFalsy();
  });

  /*
   * Finishing having written nothing is refused, which is the better half of
   * this to assert: an agent that calls `finish` first and stops would
   * otherwise hand back an empty draft that looks deliberate.
   */
  it('will not finish a writing session that has written nothing', async () => {
    const reply = await callWriting('finish', { reasoning: 'Adapted the Everclear letter.' });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toMatch(/nothing has been written/i);
  });

  it('finishes once something has been written, and says what it leaned on', async () => {
    const session = writing();
    await callWriting('save_answer', { question: 'q1', body: 'Because the ingest work is what I have done most of.' }, session);
    const reply = await callWriting('finish', { reasoning: 'Adapted the Everclear letter.' }, session);
    expect(reply.result.isError).toBeFalsy();
    expect(session.state.finished).toBe(true);
  });

  it('refuses to finish with nothing said', async () => {
    const reply = await callWriting('finish', {});
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('"reasoning"');
  });

  it('reads a document by id, and refuses one that is not there', async () => {
    const good = await callAuthoring('read_document', { id: 'd1' });
    expect(good.result.isError).toBeFalsy();
    const bad = await callAuthoring('read_document', { id: 'nope' });
    expect(bad.result.isError).toBe(true);
  });

  it('proposes another wording for a bullet that exists', async () => {
    const session = authoring();
    const reply = await callAuthoring(
      'propose_alternate',
      {
        bullet: 'b_pipeline',
        text: 'Cut median end-to-end latency from 900ms to 180ms.',
        source: 'Cut median end-to-end latency from 900ms to 180ms.',
        document: 'd1',
      },
      session,
    );
    expect(reply.result.isError).toBeFalsy();
    expect(session.state.alternates).toHaveLength(1);
  });

  it('refuses a wording that is not in the material', async () => {
    const reply = await callAuthoring('propose_alternate', {
      bullet: 'b_pipeline',
      text: 'Led the company to record profits.',
      source: 'Led the company to record profits.',
      document: 'd1',
    });
    expect(reply.result.isError).toBe(true);
  });

  it('proposes a skill for a group that exists', async () => {
    const session = authoring();
    const reply = await callAuthoring(
      'propose_skill',
      { group: 'sk_lang', text: 'Kafka', source: 'Built the Kafka ingest pipeline', document: 'd1' },
      session,
    );
    // Either it lands or it says why; what it must not do is throw at the
    // transport, which is what this is really asking.
    expect(reply.result.content[0]?.text.length).toBeGreaterThan(0);
  });

  it('finishes the authoring session with its notes', async () => {
    const session = authoring();
    const reply = await callAuthoring('finish', { notes: 'The dates in the review disagree with the resume.' }, session);
    expect(reply.result.isError).toBeFalsy();
    expect(session.state.finished).toBe(true);
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

/* ------------------------------------------------------------------ *
 * The endpoint, end to end, through a real child process              *
 * ------------------------------------------------------------------ */

/**
 * A stand-in for a coding-agent CLI that reads the material and proposes out
 * of it — including one bullet whose quote is not in the document, so the
 * refusal is exercised on the real path rather than only in a unit test.
 */
const READING_CLI = String.raw`
const fs = require('node:fs');
/*
 * A CLI that throws inside its own async work exits 0 by default, which would
 * make a broken stand-in look like a run that decided nothing — the failure
 * this test would then report is the endpoint's rather than its own.
 */
process.on('unhandledRejection', () => process.exit(3));
process.on('uncaughtException', () => process.exit(3));
const { spawn } = require('node:child_process');

const configPath = process.argv[process.argv.indexOf('--mcp-config') + 1];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.resume;
const child = spawn(config.command, config.args, {
  env: { ...process.env, ...config.env },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const waiting = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  }
});

let nextId = 1;
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
const tool = (name, args) => call('tools/call', { name, arguments: args });

(async () => {
  await call('initialize', { protocolVersion: '2024-11-05' });
  const docs = await tool('list_documents', {});
  const id = /\[([^\]]+)\]/.exec(docs.result.content[0].text)[1];
  const body = await tool('read_document', { id });
  if (!body.result.content[0].text.includes('Vega')) throw new Error('did not get the document');

  await tool('read_store', {});
  await tool('propose_entry', { id: 'exp_vega', kind: 'experience', title: 'Vega Analytics', document: id });

  // One that is not in the material: it must be refused here, not later.
  const invented = await tool('propose_bullet', {
    entry: 'exp_vega',
    text: 'Led a team of forty',
    source: 'Led a team of forty engineers.',
    document: id,
  });
  if (!invented.result.isError) throw new Error('an invented bullet was accepted');

  await tool('propose_bullet', {
    entry: 'exp_vega',
    text: 'Built a Kafka-backed ingest pipeline handling 2M events a day',
    source: 'Built a Kafka-backed ingest pipeline handling 2M events a day.',
    document: id,
  });
  await tool('finish', { notes: 'Read the resume.' });
  child.stdin.end();
  child.on('exit', () => process.exit(0));
})();
`;

describe('reading material, over the endpoint', () => {
  it('proposes what is in the files and refuses what is not', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { createApi } = await import('../src/server/api.js');
    const { Repo } = await import('../src/git/repo.js');
    const fsx = await import('node:fs');
    const osx = await import('node:os');
    const pathx = await import('node:path');

    const t = makeTempStore();
    try {
      // The material, where the Voice tab would have put it.
      t.store.saveSample({
        id: 'old-resume',
        title: 'old-resume.pdf',
        kind: 'resume',
        createdAt: new Date().toISOString(),
        text: RESUME_DOC.text,
      });

      const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'rmm-read-'));
      const cli = pathx.join(dir, 'cli.cjs');
      fsx.writeFileSync(cli, READING_CLI, 'utf8');

      /*
       * A shim called `claude`, on the PATH.
       *
       * The endpoint decides for itself whether a command can take tools, by
       * name, which is the behaviour under test — so the test cannot hand it a
       * different name and still be testing it. Putting a stand-in where the
       * real one would be leaves every line of the path alone.
       */
      const shim = pathx.join(dir, 'claude');
      fsx.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
      const realPath = process.env.PATH;
      process.env.PATH = `${dir}:${realPath ?? ''}`;

      t.store.saveConfig({
        ai: { enabled: true, command: 'claude', args: [], timeoutMs: 30_000, research: false },
      } as never);

      const app = express();
      app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

      /*
       * A background job, so the answer is fetched rather than waited on —
       * this is the longest-running thing in the product and a request held
       * open for it is one a proxy gives up on.
       */
      const started = await request(app).post('/api/ai/read-material').send({}).expect(200);
      expect(started.body.job.status).toBe('running');
      expect(started.body.job.about).toContain('1 file');

      let job = started.body.job;
      for (let n = 0; n < 60 && job.status === 'running'; n++) {
        await new Promise((r) => setTimeout(r, 500));
        job = (await request(app).get(`/api/ai/jobs/${job.id}`).expect(200)).body;
      }
      expect(job.status, job.error).toBe('done');
      const res = { body: job.result };
      expect(res.body.executed).toBe(true);
      // Said plainly, because the whole arrangement depends on it being true.
      expect(res.body.saved).toBe(false);

      const entries = res.body.proposal.entries as { id: string; bullets: { text: string }[] }[];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.id).toBe('exp_vega');
      // The invented one was refused; the quoted one is there.
      expect(entries[0]?.bullets).toHaveLength(1);
      expect(entries[0]?.bullets[0]?.text).toContain('Kafka-backed ingest pipeline');

      // And nothing reached the store.
      expect(t.store.load().entries.some((e) => e.id === 'exp_vega')).toBe(false);

      process.env.PATH = realPath;
      fsx.rmSync(dir, { recursive: true, force: true });
    } finally {
      t.cleanup();
    }
  }, 40_000);

  it('says what to do when there is nothing to read', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { createApi } = await import('../src/server/api.js');
    const { Repo } = await import('../src/git/repo.js');
    const t = makeTempStore();
    try {
      for (const s of t.store.loadSamples()) t.store.deleteSample(s.id);
      const app = express();
      app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
      // Refused before a job is started at all: there is nothing to run.
      const res = await request(app).post('/api/ai/read-material').send({}).expect(400);
      expect(res.body.error).toContain('Voice tab');
    } finally {
      t.cleanup();
    }
  });

  it('says plainly when the configured command cannot take tools', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { createApi } = await import('../src/server/api.js');
    const { Repo } = await import('../src/git/repo.js');
    const t = makeTempStore();
    try {
      t.store.saveSample({
        id: 'old-resume',
        title: 'old-resume.pdf',
        kind: 'resume',
        createdAt: new Date().toISOString(),
        text: RESUME_DOC.text,
      });
      t.store.saveConfig({ ai: { enabled: true, command: 'agy', args: [], timeoutMs: 1000 } } as never);
      const app = express();
      app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
      const res = await request(app).post('/api/ai/read-material').send({}).expect(400);
      expect(res.body.error).toContain('Claude Code');
      expect(res.body.error).toContain('"agy"');
    } finally {
      t.cleanup();
    }
  });
});

/*
 * Arguments a model leaves out, which it does constantly. Every one of these
 * has to come back as a sentence it can act on rather than as a confusing
 * error about something it did not say.
 */
describe('the arguments a model actually sends', () => {
  it('falls back to the entry’s document when the bullet does not name one', () => {
    const s = authoring();
    s.proposeEntry({ id: 'exp_vega', kind: 'experience', title: 'Vega Analytics', documentId: 'd1' });
    const r = s.proposeBullet('exp_vega', {
      label: 'Ingest',
      text: 'Built a Kafka-backed ingest pipeline',
      source: 'Built a Kafka-backed ingest pipeline handling 2M events a day.',
    } as never);
    expect(r.ok, r.text).toBe(true);
  });

  it('does the same over the protocol, where an omitted argument is not undefined', async () => {
    /*
     * The tool layer used to turn a missing `document` into an empty string,
     * and `'' ?? entry.documentId` is `''` — so the documented fallback became
     * `There is no document ""`, which is a baffling answer to a model that
     * simply left an optional argument out.
     */
    const session = authoring();
    const tools = authoringTools(session);
    const call = (name: string, args: Record<string, unknown>) =>
      handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools, INFO) as Promise<{
        result: { content: { text: string }[]; isError: boolean };
      }>;

    await call('propose_entry', { id: 'exp_vega', kind: 'experience', title: 'Vega Analytics', document: 'd1' });
    const reply = await call('propose_bullet', {
      entry: 'exp_vega',
      text: 'Built a Kafka-backed ingest pipeline',
      source: 'Built a Kafka-backed ingest pipeline handling 2M events a day.',
    });
    expect(reply.result.isError, reply.result.content[0]?.text).toBe(false);
  });

  it('still refuses when the named document is not one that was supplied', () => {
    const s = authoring();
    s.proposeEntry({ id: 'exp_vega', kind: 'experience', title: 'Vega Analytics', documentId: 'd1' });
    const r = s.proposeBullet('exp_vega', {
      label: 'x',
      text: 'y',
      source: 'Built a Kafka-backed ingest pipeline handling 2M events a day.',
      documentId: 'd9',
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('d1');
  });
});

/*
 * Ids are keys elsewhere: a resume addresses a field as `entryId.field` and
 * splits on the first dot, so an id with a dot, a slash or a space in it is
 * one half the store cannot address.
 */
describe('ids a model might propose', () => {
  const propose = (id: string) =>
    authoring().proposeEntry({ id, kind: 'experience', title: 'Vega Analytics', documentId: 'd1' });

  it('takes the shapes the store already uses', () => {
    for (const id of ['exp_vega', 'proj-ingest', 'edu2024', 'X']) {
      expect(propose(id).ok, id).toBe(true);
    }
  });

  it('refuses one that would break addressing, and says what to use', () => {
    for (const id of ['exp.vega', 'exp vega', '../etc/passwd', 'exp/vega', '_leading', '']) {
      const r = propose(id);
      expect(r.ok, id).toBe(false);
    }
    expect(propose('exp.vega').text).toContain('exp_vega');
  });
});

/*
 * Proposing an order for lines that are already in the store.
 *
 * The one proposal here that puts no words anywhere, and the one with the
 * widest reach: the master decides what order the lines inside an entry come
 * in, and every resume that has not arranged its own follows it. So it needs
 * no quotation — nothing is being claimed about the person's history, only
 * about which of their own lines a reader should meet first — and it is
 * still a proposal, because accepting it moves every document at once.
 */
describe('proposing a different order for lines already in the store', () => {
  it('takes an order for an entry that exists', () => {
    const s = authoring();
    const out = s.proposeOrder('exp_acme', ['b_testing'], 'The posting is about testing.');
    expect(out.ok).toBe(true);
    expect(s.state.orders).toEqual([
      { entryId: 'exp_acme', bullets: ['b_testing', 'b_pipeline'], why: 'The posting is about testing.' },
    ]);
  });

  /* Naming only what moves, the same as the tailoring tool of this shape. */
  it('keeps the lines that were not named, behind the ones that were', () => {
    const s = authoring();
    s.proposeOrder('exp_acme', ['b_testing'], 'why');
    expect(s.state.orders[0]?.bullets).toEqual(['b_testing', 'b_pipeline']);
  });

  it('refuses an entry the store does not have', () => {
    const out = authoring().proposeOrder('exp_nope', ['b_testing'], 'why');
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/no entry/i);
  });

  it('refuses lines that belong to something else, and says whose they are not', () => {
    const out = authoring().proposeOrder('exp_acme', ['b_elsewhere'], 'why');
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/none of those/i);
  });

  /*
   * The order it is already in is not a proposal. Accepting one writes the
   * entry and moves every resume that follows it, so an empty one costs a
   * write and a decision for nothing.
   */
  it('refuses the order it is already in', () => {
    const out = authoring().proposeOrder('exp_acme', ['b_pipeline', 'b_testing'], 'why');
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/already in/i);
  });

  /* The reason is the whole of what the person is judging. */
  it('refuses an order with no reason given', () => {
    const out = authoring().proposeOrder('exp_acme', ['b_testing'], '   ');
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/why/i);
  });

  it('replaces an earlier order for the same entry rather than stacking two', () => {
    const s = authoring();
    s.proposeOrder('exp_acme', ['b_testing'], 'first thought');
    s.proposeOrder('exp_acme', ['b_pipeline', 'b_testing'], 'second thought').text;
    // The second is the order it already has, so it is refused and the first stands.
    expect(s.state.orders).toHaveLength(1);
    expect(s.state.orders[0]?.why).toBe('first thought');
  });

  it('says so in the proposal the person reads', () => {
    const s = authoring();
    s.proposeOrder('exp_acme', ['b_testing'], 'why');
    expect(s.describeProposal()).toMatch(/exp_acme/);
    expect(s.describeProposal()).toMatch(/reordered/i);
  });

  /* An order on its own is a proposal worth finishing with. */
  it('is enough on its own to be worth showing', () => {
    const s = authoring();
    s.proposeOrder('exp_acme', ['b_testing'], 'why');
    const out = s.done('Nothing new to add, but the lines read better this way.');
    expect(out.ok).toBe(true);
    expect(s.state.finished).toBe(true);
    expect(s.state.orders).toHaveLength(1);
  });

  it('has nothing to say about an entry with no lines', () => {
    const s = new AuthoringSession([RESUME_DOC], {
      entryIds: ['exp_bare'],
      bulletIds: [],
      skillGroups: [],
      bulletsByEntry: { exp_bare: [] },
    });
    expect(s.proposeOrder('exp_bare', ['b_x'], 'why').ok).toBe(false);
  });
});
