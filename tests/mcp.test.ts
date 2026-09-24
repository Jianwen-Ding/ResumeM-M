import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { handle, serve, type ToolDefinition } from '../src/mcp/protocol.js';
import { TailorSession } from '../src/mcp/session.js';
import { tailorTools } from '../src/mcp/tools.js';
import { serverEntry, wireUp } from '../src/mcp/launch.js';
import { resolveResume } from '../src/model/resolve.js';
import { applyInclusion, sanitizeAiPlan } from '../src/jobs/aiPlan.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StoreData } from '../src/model/types.js';
import { makeTempStore } from './helpers.js';

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
  keywords: ['kafka', 'go'],
};

function session() {
  const data = store();
  return new TailorSession(data, resolveResume('base', data), POSTING);
}

/**
 * The whole reason this exists: a move that is wrong is answered *as it is
 * made*, in words naming what the right answers are — rather than being
 * dropped in silence at the end of a run, where nothing can be done about it.
 */
describe('a tailoring move that is checked when it is made', () => {
  it('takes a real phrasing for a real bullet', () => {
    const r = session().choose('b_pipeline', 'v_kafka');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Kafka');
  });

  it('answers an invented variant by naming the real ones', () => {
    const r = session().choose('b_pipeline', 'v_invented');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('v_base');
    expect(r.text).toContain('v_kafka');
  });

  it('answers an invented bullet by naming the real ones', () => {
    const r = session().choose('b_kafka_pipeline', 'v_kafka');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('b_pipeline');
    // And says what the two shapes of id look like, which is the mistake.
    expect(r.text).toContain('edu_neu.dates');
  });

  it('handles a field the same way a bullet is handled', () => {
    const s = session();
    expect(s.choose('edu_neu.dates', 'v_dec2026').ok).toBe(true);
    expect(s.choose('edu_neu.dates', 'v_nope').ok).toBe(false);
    expect(s.choose('edu_nowhere.dates', 'v_dec2026').text).toContain('There is no entry');
  });

  /*
   * A field that is not one of the four with wordings. `.gpa` exists on no
   * entry and was told it "has only one wording"; `.bullets` and `.period`
   * are objects with no variants and threw, failing the whole tool call.
   */
  it('names the real fields when the one asked for has no wordings to choose', () => {
    const s = session();
    for (const field of ['gpa', 'bullets', 'period', 'id']) {
      const r = s.choose(`edu_neu.${field}`, 'v_anything');
      expect(r.ok, field).toBe(false);
      expect(r.text, field).toContain('title, dates, subtitle, location');
      expect(r.text, field).not.toContain('has only one wording');
    }
  });

  it('still says a real field with one wording has nothing to choose between', () => {
    expect(session().choose('edu_neu.title', 'v_anything').text).toContain('has only one wording');
  });

  /*
   * Named back, as reordering bullets and choosing skills name theirs. A typo
   * or an entry from another section was dropped with a success and no word
   * of it.
   */
  it('says which entries it ignored when putting a section in order', () => {
    const r = session().orderEntries('experience', ['exp_acme', 'proj_thing', 'exp_typo']);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Ignored, because they are not experience entries');
    expect(r.text).toContain('proj_thing');
    expect(r.text).toContain('exp_typo');
  });

  it('says nothing about ignoring when nothing was', () => {
    expect(session().orderEntries('experience', ['exp_acme']).text).not.toContain('Ignored');
  });

  it('never lets a wrong move leave anything behind', () => {
    const s = session();
    s.choose('b_pipeline', 'v_invented');
    s.hide('b_invented');
    s.order('exp_nowhere', ['b_pipeline']);
    expect(s.state.plan).toEqual({
      choices: {},
      skills: {},
      enable: [],
      disable: [],
      order: {},
      entryOrder: {},
      rejected: [],
    });
  });
});

describe('showing, hiding and rearranging', () => {
  it('shows and hides by the same name', () => {
    const s = session();
    expect(s.hide('b_testing').text).toContain('left off');
    expect(s.show('proj_thing').text).toContain('shown');
    expect(s.state.plan.disable).toEqual(['b_testing']);
    expect(s.state.plan.enable).toEqual(['proj_thing']);
  });

  /*
   * A model that changes its mind mid-run said both things, and a plan
   * holding both is a plan that contradicts itself — `applyInclusion` would
   * then decide by the order the two loops happen to run in.
   */
  it('treats a mind changed twice as one decision', () => {
    const s = session();
    s.hide('b_testing');
    s.show('b_testing');
    expect(s.state.plan.disable).toEqual([]);
    expect(s.state.plan.enable).toEqual(['b_testing']);
  });

  it('reorders, and says what the entry will read like', () => {
    const r = session().order('exp_acme', ['b_testing']);
    expect(r.ok).toBe(true);
    // Named first, the rest behind it: nothing is lost by being left out.
    expect(r.text).toContain('b_testing, b_pipeline');
  });

  it('refuses an order made of ids that are not that entry’s', () => {
    const r = session().order('exp_acme', ['b_thing']);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('b_pipeline');
  });

  it('says which ids it ignored rather than pretending they took', () => {
    const r = session().order('exp_acme', ['b_testing', 'b_thing']);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Ignored');
    expect(r.text).toContain('b_thing');
  });

  it('names the sections when asked for one that does not exist', () => {
    const r = session().orderEntries('publications', ['exp_acme']);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('experience');
  });

  it('prints skills in the person’s order, not the order it was given them', () => {
    const s = session();
    const r = s.skills('sk_lang', ['s_go', 's_py']);
    expect(r.ok).toBe(true);
    // The store has Python before Go, and that is a decision its owner made.
    expect(s.state.plan.skills.sk_lang).toEqual(['s_py', 's_go']);
  });
});

describe('what it still cannot do', () => {
  it('cannot put text on the page, only propose it', () => {
    const s = session();
    const r = s.suggest('b_pipeline', 'Kafka', 'Ran a Kafka cluster nobody asked me to run', 'the posting names Kafka');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('not on the resume');
    expect(s.state.suggestions).toHaveLength(1);
    // And nothing about the page changed.
    expect(s.state.plan.choices).toEqual({});
  });

  it('will not take a suggestion for a bullet that does not exist', () => {
    expect(session().suggest('b_nope', 'x', 'y', 'z').ok).toBe(false);
  });

  it('stops at three, rather than rewriting the resume one suggestion at a time', () => {
    const s = session();
    for (const id of ['b_pipeline', 'b_testing', 'b_course']) {
      expect(s.suggest(id, 'L', `a new way to put ${id}`, 'why').ok).toBe(true);
    }
    const refused = s.suggest('b_thing', 'L4', 'text 4', 'why');
    expect(refused.ok).toBe(false);
    // It used to say "withdraw one before adding another", and there is no
    // tool for withdrawing one. An instruction that cannot be followed is
    // read as a dead end by the only reader this message has.
    expect(refused.text).not.toMatch(/withdraw/i);
    expect(refused.text).toContain('b_pipeline');
  });

  /*
   * A model that suggests twice for one line is rewording its own proposal.
   * Queueing both spends the limit on one idea and hands the person two
   * versions of it to choose between.
   */
  it('treats a second suggestion for the same bullet as a rewrite of the first', () => {
    const s = session();
    expect(s.suggest('b_pipeline', 'First', 'the first way of putting it', 'why').ok).toBe(true);
    const again = s.suggest('b_pipeline', 'Second', 'the second way of putting it', 'better');
    expect(again.ok).toBe(true);
    expect(again.text).toContain('Replaced');
    expect(s.state.suggestions).toHaveLength(1);
    expect(s.state.suggestions[0]?.text).toBe('the second way of putting it');
  });
});

/**
 * The tools are useless if the model cannot see what its own moves did — that
 * was the single-shot version's real problem, more than the parsing.
 */
/**
 * A resume that leaves a line and an entry off, so that turning one on is a
 * real change rather than a no-op. The shared fixture has everything on.
 */
function narrow() {
  const data = store();
  const spec = {
    id: 'narrow',
    label: 'Narrow',
    tier: 'base' as const,
    sections: [
      { kind: 'education', entries: ['edu_neu'] },
      { kind: 'experience', entries: ['exp_acme'], bullets: { exp_acme: ['b_pipeline'] } },
      { kind: 'project', entries: [] },
    ],
  };
  data.resumes = [...data.resumes, spec as never];
  return new TailorSession(data, resolveResume('narrow', data), POSTING);
}

/*
 * An entry has to have somewhere to go. `show` took any real id and said "will
 * be shown"; on a resume with no section of that entry's kind the plan carried
 * it and `applyInclusion` found nowhere to put it — the reasoning claimed an
 * entry the resume never got, and nothing anywhere said so.
 */
describe('showing an entry the resume has no section for', () => {
  const withoutProjects = () => {
    const data = store();
    data.resumes = [
      ...data.resumes,
      { id: 'noproj', label: 'No projects', tier: 'base', sections: [{ kind: 'experience', entries: ['exp_acme'] }] } as never,
    ];
    return { data, s: new TailorSession(data, resolveResume('noproj', data), POSTING) };
  };
  const aProject = (data: StoreData) => data.entries.find((e) => e.kind === 'project')!;

  it('is refused by name, saying which sections there are', () => {
    const { data, s } = withoutProjects();
    const project = aProject(data);
    const r = s.show(project.id);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('no');
    expect(r.text).toContain('experience');
    expect(s.state.plan.enable).not.toContain(project.id);
  });

  it('and so is one of its bullets', () => {
    const { data, s } = withoutProjects();
    const bullet = aProject(data).bullets![0]!;
    expect(s.show(bullet.id).ok).toBe(false);
  });

  it('but hiding one is still fine, and an empty section of its kind is somewhere to go', () => {
    const { data, s } = withoutProjects();
    expect(s.hide(aProject(data).id).ok).toBe(true);
    // `narrow` has a project section with nothing in it.
    const project = aProject(data);
    expect(narrow().show(project.id).ok).toBe(true);
  });
});

describe('reading the page back', () => {
  it('shows the resume with the ids the tools take', () => {
    const text = session().describeResume();
    expect(text).toContain('[b_pipeline]');
    expect(text).toContain('[exp_acme]');
  });

  it('shows a choice taking effect', () => {
    const s = session();
    expect(s.describeResume()).not.toContain('Kafka');
    s.choose('b_pipeline', 'v_kafka');
    expect(s.describeResume()).toContain('Kafka');
  });

  /*
   * The whole promise of reading it back is that the model can check its own
   * move. Both halves of that were broken for anything it turned *on*.
   *
   * A resume is resolved once, before any of this starts, and `show` records
   * an intention rather than rebuilding it. So a bullet the model had just
   * shown printed as "- [b_testing] " with nothing after it, and an entry it
   * had just shown did not print at all — while the document it was building
   * got both. A model checking its work saw two moves that had worked as two
   * that had failed, which is an invitation to undo them.
   */
  it('shows a bullet the model has just turned on, with its words', () => {
    const s = narrow();
    s.show('b_testing');
    const text = s.describeResume();
    expect(text).toContain('[b_testing]');
    expect(text).toMatch(/\[b_testing\]\s+\S/);
    // And the words are the line's own, not an empty string.
    expect(text).toContain('coverage');
  });

  /*
   * A line goes where its entry is. Showing one whose entry is not on the
   * page said "will be shown", and `applyInclusion` found no section listing
   * the entry and did nothing — a move reported as made that was not.
   */
  it('refuses to show a line whose entry is not on the page, and names the entry', () => {
    const data = store();
    const spec = {
      id: 'no-acme',
      label: 'No Acme',
      tier: 'base' as const,
      sections: [
        { kind: 'education', entries: ['edu_neu'] },
        { kind: 'experience', entries: [] },
      ],
    };
    data.resumes = [...data.resumes, spec as never];
    const s = new TailorSession(data, resolveResume('no-acme', data), POSTING);

    const refused = s.show('b_testing');
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('exp_acme');
    expect(s.state.plan.enable).toEqual([]);

    // Shown with its entry, it goes; and a line hidden there stays hidden
    // in the document, as the preview says.
    expect(s.show('exp_acme').ok).toBe(true);
    expect(s.show('b_testing').ok).toBe(true);
    expect(s.hide('b_pipeline').ok).toBe(true);
    const sections = applyInclusion(spec as never, data, s.state.plan);
    expect(sections?.find((x) => x.kind === 'experience')?.bullets?.exp_acme).toEqual(['b_testing']);
    expect(s.describeResume()).not.toContain('[b_pipeline]');
  });

  it('says a skills pick in the order the resume prints it', () => {
    const data = store();
    const spec = {
      id: 'go-first',
      label: 'Go first',
      tier: 'base' as const,
      sections: [{ kind: 'skills', entries: [], groups: ['sk_lang'], items: { sk_lang: ['s_go', 's_py', 's_ts'] } }],
    };
    data.resumes = [...data.resumes, spec as never];
    const s = new TailorSession(data, resolveResume('go-first', data), POSTING);
    expect(s.skills('sk_lang', ['s_py', 's_go']).text).toContain('Go, Python.');
  });

  it('shows an entry the model has just turned on', () => {
    const s = narrow();
    expect(s.describeResume()).not.toContain('[proj_thing]');
    s.show('proj_thing');
    expect(s.describeResume()).toContain('[proj_thing]');
  });

  it('shows a hidden bullet gone and a reordering applied', () => {
    const s = session();
    // The bullets of this entry, in the order they would print.
    const under = (text: string) =>
      text
        .split('### ')
        .find((block) => block.startsWith('[exp_acme]'))
        ?.split('\n')
        .filter((l) => l.startsWith('- ['))
        .map((l) => l.slice(3, l.indexOf(']'))) ?? [];

    expect(under(s.describeResume())).toEqual(['b_pipeline', 'b_testing']);
    s.order('exp_acme', ['b_testing']);
    expect(under(s.describeResume())).toEqual(['b_testing', 'b_pipeline']);

    s.hide('b_testing');
    expect(under(s.describeResume())).toEqual(['b_pipeline']);
  });

  it('offers everything in the store, marking what is not on this resume', () => {
    const data = store();
    // A resume with no projects on it, so there is something to mark.
    const base = data.resumes.find((r) => r.id === 'base')!;
    const trimmed = { ...base, id: 'trimmed', sections: base.sections?.map((x) => (x.kind === 'project' ? { ...x, entries: [] } : x)) };
    const s = new TailorSession(
      data,
      resolveResume(trimmed, { ...data, resumes: [...data.resumes, trimmed] }),
      POSTING,
    );
    const text = s.describeInventory();
    expect(text).toContain('[b_pipeline]');
    expect(text).toContain('skills group [sk_lang]');
    // The project is still offered, and marked as not currently printed.
    expect(text).toMatch(/\[proj_thing\][^\n]*\(not on this resume\)/);
  });

  /*
   * A skill taken off this resume is marked, as an entry or a bullet is, so
   * the model can see the applicant's choice before it picks a group's items.
   */
  it('marks the skills this resume leaves off', () => {
    const data = store();
    const base = data.resumes.find((r) => r.id === 'base')!;
    const group = data.skillGroups.find((g) => g.id === 'sk_lang')!;
    const [kept, dropped] = group.items;
    const trimmed = {
      ...base,
      id: 'trimmed',
      sections: base.sections?.map((x) =>
        x.kind === 'skills' ? { ...x, items: { ...(x.items ?? {}), sk_lang: group.items.filter((i) => i.id !== dropped!.id).map((i) => i.id) } } : x,
      ),
    };
    const s = new TailorSession(data, resolveResume(trimmed, { ...data, resumes: [...data.resumes, trimmed] }), POSTING);
    const text = s.describeInventory();
    expect(text).toMatch(new RegExp(`\\[${dropped!.id}\\][^\\n]*\\(not on this resume\\)`));
    expect(text).not.toMatch(new RegExp(`\\[${kept!.id}\\][^\\n]*\\(not on this resume\\)`));
  });

  it('labels the posting as source material rather than instructions', () => {
    expect(session().describePosting()).toMatch(/not\s+instructions to you/);
  });
});

describe('finishing', () => {
  it('records the reasoning and says what was decided', () => {
    const s = session();
    s.choose('b_pipeline', 'v_kafka');
    const r = s.done('The posting is about streaming ingest.');
    expect(r.ok).toBe(true);
    expect(s.state.finished).toBe(true);
    expect(s.state.reasoning).toContain('streaming ingest');
    expect(r.text).toContain('b_pipeline→v_kafka');
  });

  /*
   * The plan the session builds has to be the same shape the deterministic
   * path produces, or the two would diverge and only one of them would be
   * tested. Run it through the sanitiser and the applier to prove it.
   */
  it('produces a plan the rest of the system already knows how to apply', () => {
    const data = store();
    const s = new TailorSession(data, resolveResume('base', data), POSTING);
    s.choose('b_pipeline', 'v_kafka');
    s.order('exp_acme', ['b_testing']);
    s.hide('proj_thing');

    const plan = sanitizeAiPlan(s.state.plan, data);
    expect(plan.rejected).toEqual([]);
    expect(plan.choices).toEqual({ b_pipeline: 'v_kafka' });

    const sections = applyInclusion(
      data.resumes.find((r) => r.id === 'base')!,
      data,
      plan,
    );
    expect(sections?.find((x) => x.kind === 'experience')?.bullets?.exp_acme).toEqual(['b_testing', 'b_pipeline']);
    expect(sections?.find((x) => x.kind === 'project')?.entries).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The protocol                                                        *
 * ------------------------------------------------------------------ */

const INFO = { name: 'test', version: '1' };

const tools = (): ToolDefinition[] => tailorTools(session());

/*
 * Every tailoring tool, through the transport.
 *
 * The session underneath these is thoroughly tested and the handlers around
 * them were not — and the handler is every line an agent's call passes
 * through before reaching the session. `reorder_entries` is the reason this
 * block exists: it spent weeks reporting success and moving nothing, and no
 * test ever sent it through the path an agent uses.
 */
describe('every tailoring tool, as an agent calls it', () => {
  const call = (name: string, args: Record<string, unknown>, list = tools()) =>
    handle({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name, arguments: args } }, list, INFO) as Promise<{
      result: { content: { text: string }[]; isError?: boolean };
    }>;

  it('puts an entry’s bullets in a different order', async () => {
    const reply = await call('reorder_bullets', { entry: 'exp_acme', bullets: ['b_testing'] });
    expect(reply.result.isError).toBeFalsy();
    expect(reply.result.content[0]?.text).toContain('b_testing');
  });

  it('puts a section’s entries in a different order', async () => {
    const reply = await call('reorder_entries', { section: 'experience', entries: ['exp_acme'] });
    expect(reply.result.isError).toBeFalsy();
  });

  it('says which argument was wrong when the ids are not a list', async () => {
    const reply = await call('reorder_bullets', { entry: 'exp_acme', bullets: 7 });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('"bullets"');
  });

  it('hides something, and shows it again', async () => {
    const list = tools();
    const hidden = await call('hide', { id: 'b_testing' }, list);
    expect(hidden.result.isError).toBeFalsy();
    const shown = await call('show', { id: 'b_testing' }, list);
    expect(shown.result.isError).toBeFalsy();
  });

  it('refuses to hide something that is not there', async () => {
    const reply = await call('hide', { id: 'b_nowhere' });
    expect(reply.result.isError).toBe(true);
  });

  it('chooses which skills a group shows', async () => {
    const reply = await call('choose_skills', { group: 'sk_lang', items: ['s_go'] });
    expect(reply.result.content[0]?.text.length).toBeGreaterThan(0);
  });

  it('suggests a wording, which is a suggestion rather than a change', async () => {
    const reply = await call('suggest_wording', {
      bullet: 'b_pipeline',
      text: 'Built the Kafka ingest pipeline that cut latency to 180ms.',
      why: 'The posting names Kafka twice.',
    });
    expect(reply.result.isError).toBeFalsy();
  });

  it('refuses a suggestion with no reason behind it', async () => {
    const reply = await call('suggest_wording', { bullet: 'b_pipeline', text: 'Something.' });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('"why"');
  });

  it('reviews what it has decided, and finishes', async () => {
    const list = tools();
    const review = await call('review_changes', {}, list);
    expect(review.result.content[0]?.text.length).toBeGreaterThan(0);
    const done = await call('finish', { reasoning: 'Kafka is what this posting is about.' }, list);
    expect(done.result.isError).toBeFalsy();
  });

  it('refuses to finish without saying what drove it', async () => {
    const reply = await call('finish', {});
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('"reasoning"');
  });
});

describe('speaking MCP', () => {
  it('answers initialize with a version and its capabilities', async () => {
    const reply = (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }, tools(), INFO)) as {
      result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: unknown };
    };
    expect(reply.result.protocolVersion).toBe('2024-11-05');
    expect(reply.result.capabilities.tools).toBeDefined();
    expect(reply.result.serverInfo).toEqual(INFO);
  });

  /* A notification has no id and must get no reply; answering one leaves a
     client trying to match a response to a request it never made. */
  it('says nothing back to a notification', async () => {
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools(), INFO)).toBeNull();
  });

  it('lists the tools with their schemas', async () => {
    const reply = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools(), INFO)) as {
      result: { tools: { name: string; description: string; inputSchema: unknown }[] };
    };
    const names = reply.result.tools.map((t) => t.name);
    expect(names).toContain('read_posting');
    expect(names).toContain('choose_wording');
    expect(names).toContain('reorder_bullets');
    expect(names).toContain('finish');
    for (const t of reply.result.tools) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema).toHaveProperty('type', 'object');
    }
  });

  it('runs a tool and gives back its text', async () => {
    const reply = (await handle(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_posting', arguments: {} } },
      tools(),
      INFO,
    )) as { result: { content: { text: string }[]; isError: boolean } };
    expect(reply.result.isError).toBe(false);
    expect(reply.result.content[0]?.text).toContain('Helios Robotics');
  });

  /*
   * A failed move comes back as content with `isError`, not as a JSON-RPC
   * error — a protocol error is invisible to the model, and a model that
   * cannot see what went wrong repeats it.
   */
  it('hands a rejected move to the model rather than to the transport', async () => {
    const reply = (await handle(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'choose_wording', arguments: { target: 'b_nope', variant: 'v_kafka' } },
      },
      tools(),
      INFO,
    )) as { result: { content: { text: string }[]; isError: boolean }; error?: unknown };
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('b_pipeline');
  });

  it('answers a tool that does not exist by naming the ones that do', async () => {
    const reply = (await handle(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rewrite_everything', arguments: {} } },
      tools(),
      INFO,
    )) as { result: { content: { text: string }[]; isError: boolean } };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('choose_wording');
  });

  it('complains about a missing argument in words, not by throwing', async () => {
    const reply = (await handle(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'choose_wording', arguments: { target: 'b_pipeline' } } },
      tools(),
      INFO,
    )) as { result: { content: { text: string }[]; isError: boolean } };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('"variant"');
  });

  it('takes a single id where a list was asked for, because models do that', async () => {
    const reply = (await handle(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'reorder_bullets', arguments: { entry: 'exp_acme', bullets: 'b_testing' } },
      },
      tools(),
      INFO,
    )) as { result: { isError: boolean } };
    expect(reply.result.isError).toBe(false);
  });

  it('refuses an unknown method the way JSON-RPC says to', async () => {
    const reply = (await handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' }, tools(), INFO)) as {
      error: { code: number };
    };
    expect(reply.error.code).toBe(-32601);
  });
});

describe('framing', () => {
  /** Drive the stdio loop and collect what comes back. */
  async function exchange(lines: string[]): Promise<Record<string, unknown>[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (c: Buffer) => chunks.push(c.toString()));

    const done = serve(input, output, tools(), INFO);
    for (const line of lines) input.write(line);
    input.end();
    await done;
    return chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('reads two requests that arrived in one chunk', async () => {
    const replies = await exchange([
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`,
    ]);
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
  });

  it('reads one request that arrived in pieces', async () => {
    const whole = `${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })}\n`;
    const replies = await exchange([whole.slice(0, 12), whole.slice(12, 30), whole.slice(30)]);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.id).toBe(9);
  });

  it('answers a broken line and keeps going', async () => {
    const replies = await exchange([`not json\n${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\n`]);
    expect((replies[0]?.error as { code: number }).code).toBe(-32700);
    expect(replies[1]?.id).toBe(3);
  });

  it('writes nothing at all for a notification', async () => {
    const replies = await exchange([`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`]);
    expect(replies).toEqual([]);
  });

  /*
   * A batch (`[{...}, {...}]`) is valid JSON on its own line, and destructuring
   * an array gives `id: undefined` — the same shape as a notification, which
   * gets no reply on purpose. That made a batch and a notification
   * indistinguishable here, so a client that sent one and was waiting on a
   * reply for the request inside it got nothing at all, forever.
   */
  it('answers a batch rather than waiting on it forever', async () => {
    const replies = await exchange([`${JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }])}\n`]);
    expect(replies).toHaveLength(1);
    expect((replies[0]?.error as { code: number }).code).toBe(-32600);
  });

  it('still answers CRLF-terminated lines', async () => {
    const replies = await exchange([`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })}\r\n`]);
    expect(replies).toEqual([{ jsonrpc: '2.0', id: 4, result: {} }]);
  });
});

/* ------------------------------------------------------------------ *
 * Handing it to a CLI                                                 *
 * ------------------------------------------------------------------ */

describe('wiring a CLI up to it', () => {
  const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-mcp-'));
  const payload = () => {
    const data = store();
    return { data, resume: resolveResume('base', data), posting: POSTING };
  };

  it('writes the session and a config each CLI can read', () => {
    const dir = sandbox();
    const wiring = wireUp(dir, 'claude', payload(), '/somewhere/bin.js');
    expect(wiring).not.toBeNull();
    expect(wiring!.args).toContain('--mcp-config');

    const config = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
    expect(config.mcpServers.resume.args).toEqual(['/somewhere/bin.js']);
    expect(config.mcpServers.resume.env.RMM_TAILOR_SESSION).toContain('tailor-session.json');

    const session = JSON.parse(fs.readFileSync(path.join(dir, 'tailor-session.json'), 'utf8'));
    expect(session.posting.company).toBe('Helios Robotics');
    expect(session.out).toBe(wiring!.out);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /*
   * The session file sits in the directory the CLI runs in, and a coding CLI
   * reads files there without asking. The prompt and every tool result are
   * redacted; this file was not, so an SSN pasted into a posting or typed into
   * a draft reached the model through it anyway.
   */
  it('writes the session with identifiers already taken out', () => {
    const dir = sandbox();
    const base = payload();
    wireUp(
      dir,
      'claude',
      {
        ...base,
        posting: { ...POSTING, description: `${POSTING.description}\nSSN: 123-45-6789, card 4111 1111 1111 1111` },
        draft: { coverLetter: { required: true, body: 'My SSN is 123-45-6789.' }, questions: [] },
      },
      '/somewhere/bin.js',
    );
    const raw = fs.readFileSync(path.join(dir, 'tailor-session.json'), 'utf8');
    expect(raw).not.toContain('123-45-6789');
    expect(raw).not.toContain('4111 1111 1111 1111');
    // And nothing else is disturbed: the posting is still the posting.
    expect(JSON.parse(raw).posting.company).toBe('Helios Robotics');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('puts the config where Gemini looks, since Gemini takes no flag', () => {
    const dir = sandbox();
    const wiring = wireUp(dir, 'gemini', payload(), '/somewhere/bin.js');
    expect(wiring!.args).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.gemini', 'settings.json'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /*
   * Codex has no key naming a config file. `-c mcp_servers_file=…` was
   * invented; the reference has `mcp_servers` and four OAuth/timeout
   * neighbours, and nothing that takes a path. An override on a key Codex
   * does not have is accepted and ignored — so the run went ahead with no
   * tools while its prompt told it to call them.
   */
  it('spells the server out for Codex, which has no key naming a file', () => {
    const dir = sandbox();
    const wiring = wireUp(dir, 'codex', payload(), '/somewhere/bin.js');
    expect(wiring).not.toBeNull();

    const said = wiring!.args.join(' ');
    expect(said).not.toContain('mcp_servers_file');
    expect(said).toContain('mcp_servers.resume.command=');
    // TOML: a string carries its own quotes, and an array is bracketed.
    expect(wiring!.args).toContain('mcp_servers.resume.args=["/somewhere/bin.js"]');
    expect(said).toContain(`mcp_servers.resume.env={RMM_TAILOR_SESSION="${path.join(dir, 'tailor-session.json')}"}`);
    // Each override is its own `-c`, and the effort slider's `-c` is another.
    expect(wiring!.args.filter((a) => a === '-c')).toHaveLength(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /*
   * Codex knows about the server and still will not call it: "MCP tool call
   * requires approval, but approval policy is never". `codex exec` cannot
   * prompt anybody, so a call needing approval is denied and the run spends
   * its whole timeout looking for another way round.
   *
   * The server-level approval setting says this one server may be called. It
   * is kept out of `args` so `runAgent` can retry without it when an older
   * Codex version does not know the setting yet.
   */
  it('pre-approves tools from the one server it wired in', () => {
    const dir = sandbox();
    const wiring = wireUp(dir, 'codex', payload(), '/somewhere/bin.js');
    expect(wiring!.approval).toEqual([
      '-c',
      'mcp_servers.resume.default_tools_approval_mode="approve"',
    ]);
    // Named, not blanket: nothing here touches the sandbox or any other
    // approval, and nothing bypasses approvals wholesale.
    expect(wiring!.approval.join(' ')).not.toMatch(/approval_policy|sandbox|dangerous|bypass|full-auto/i);
    // Droppable, which is the whole point of it being its own list.
    expect(wiring!.args.join(' ')).not.toContain('default_tools_approval_mode');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds no approval setting to a CLI that has not asked for one', () => {
    const dir = sandbox();
    expect(wireUp(dir, 'claude', payload(), '/somewhere/bin.js')!.approval).toEqual([]);
    expect(wireUp(dir, 'gemini', payload(), '/somewhere/bin.js')!.approval).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds the CLI behind a path', () => {
    const dir = sandbox();
    expect(wireUp(dir, '/usr/local/bin/claude', payload(), '/x/bin.js')).not.toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /*
   * Guessing a flag is worse than not trying: one a CLI does not recognise
   * usually stops it running at all, and a tailoring pass that fails outright
   * is a worse outcome than one that goes back to asking for JSON.
   */
  it('declines to guess for a command it does not know', () => {
    const dir = sandbox();
    expect(wireUp(dir, 'my-own-cli', payload(), '/x/bin.js')).toBeNull();
    expect(fs.existsSync(path.join(dir, 'mcp.json'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('declines for agy, whose MCP flag is not something to invent', () => {
    const dir = sandbox();
    expect(wireUp(dir, 'agy', payload(), '/x/bin.js')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ *
 * The whole thing, as a real child process                            *
 * ------------------------------------------------------------------ */

/**
 * A stand-in for a coding-agent CLI: reads the MCP config it was handed,
 * spawns the server it names, speaks the protocol, makes a few moves, and
 * exits — printing nothing to stdout, which is the case that used to be read
 * as "the command produced nothing".
 *
 * Nothing here is mocked. This is `bin.js` over a real pipe, `runAgent`'s own
 * sandbox, and the decisions read back off disk the way the server reads them.
 */
const FAKE_CLI = String.raw`
const fs = require('node:fs');
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
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
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
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const listed = await call('tools/list', {});
  if (!listed.result.tools.some((t) => t.name === 'choose_wording')) throw new Error('no tools');

  await tool('read_posting', {});
  await tool('read_resume', {});

  // A wrong id first, on purpose: the reply should name the right ones.
  const wrong = await tool('choose_wording', { target: 'b_kafka', variant: 'v_kafka' });
  if (!wrong.result.isError) throw new Error('a wrong id was accepted');
  if (!wrong.result.content[0].text.includes('b_pipeline')) throw new Error('the reply did not help');

  await tool('choose_wording', { target: 'b_pipeline', variant: 'v_kafka' });
  await tool('reorder_bullets', { entry: 'exp_acme', bullets: ['b_testing'] });
  await tool('hide', { id: 'proj_thing' });
  await tool('finish', { reasoning: 'The posting is about streaming ingest.' });

  child.stdin.end();
  child.on('exit', () => process.exit(0));
})();
`;

describe('a run that does its work through the tools', () => {
  it('leaves its decisions behind, having printed nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-mcp-e2e-'));
    const cliPath = path.join(dir, 'fake-cli.cjs');
    fs.writeFileSync(cliPath, FAKE_CLI, 'utf8');

    const data = store();
    const resolved = resolveResume('base', data);

    const { runAgent } = await import('../src/ai/agent.js');
    const { DEFAULT_CONFIG } = await import('../src/model/types.js');

    const result = await runAgent(
      {
        ...DEFAULT_CONFIG,
        ai: { ...DEFAULT_CONFIG.ai, enabled: true, command: process.execPath, args: [cliPath], timeoutMs: 30_000 },
      },
      'the prompt',
      {
        wire: (sandbox, command) =>
          // `command` is node here rather than `claude`, so the real
          // `wireUp` would decline; the CLI's own spelling is not what this
          // test is about, and `wiring a CLI up to it` above covers it.
          wireUp(sandbox, 'claude', { data, resume: resolved, posting: POSTING }, serverEntryForTests()) ??
          (() => {
            throw new Error(`could not wire ${command}`);
          })(),
        read: (out) => JSON.parse(fs.readFileSync(out, 'utf8')),
      },
    );

    // Nothing on stdout, and a full set of decisions: the case that used to
    // be reported as "the AI command finished without writing anything".
    expect(result.output).toBe('');
    const state = result.tools as { plan: Record<string, unknown>; reasoning: string; finished: boolean };
    expect(state.finished).toBe(true);
    expect(state.reasoning).toContain('streaming ingest');
    expect(state.plan.choices).toEqual({ b_pipeline: 'v_kafka' });
    expect(state.plan.order).toEqual({ exp_acme: ['b_testing'] });
    expect(state.plan.disable).toEqual(['proj_thing']);

    fs.rmSync(dir, { recursive: true, force: true });
  }, 40_000);
});

/** The compiled entry point, or the source one when running from source. */
function serverEntryForTests(): string {
  const compiled = path.resolve('dist/src/mcp/bin.js');
  if (fs.existsSync(compiled)) return compiled;
  throw new Error('run `npm run build` first: this test spawns the compiled MCP server');
}

describe('finding the server to spawn', () => {
  it('prefers the compiled entry point', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-entry-'));
    fs.writeFileSync(path.join(dir, 'bin.js'), '');
    fs.writeFileSync(path.join(dir, 'bin.ts'), '');
    expect(serverEntry(dir)).toBe(path.join(dir, 'bin.js'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /*
   * And falls back to the source one, because `npm run serve` is what the
   * README says to run and it never builds. Without this the tools would
   * quietly be a feature only for people who had run `npm run build`.
   */
  it('falls back to the source entry point, and says to run it with tsx', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-entry-'));
    fs.writeFileSync(path.join(dir, 'bin.ts'), '');
    expect(serverEntry(dir)).toBe(path.join(dir, 'bin.ts'));

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-mcp-'));
    const data = store();
    wireUp(sandbox, 'claude', { data, resume: resolveResume('base', data), posting: POSTING }, path.join(dir, 'bin.ts'));
    const config = JSON.parse(fs.readFileSync(path.join(sandbox, 'mcp.json'), 'utf8'));
    expect(config.mcpServers.resume.command).toBe('npx');
    expect(config.mcpServers.resume.args[0]).toBe('tsx');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('says there is none rather than naming a file that is not there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-entry-'));
    expect(serverEntry(dir)).toBeNull();
    // And wiring declines, so the run falls back to asking for JSON.
    const data = store();
    expect(wireUp(dir, 'claude', { data, resume: resolveResume('base', data), posting: POSTING }, null)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/*
 * Tool results are the other way text reaches the model.
 *
 * `runAgent` redacts the prompt, but a tool such as `find_my_letters` hands
 * the model corpus text as a result, and none of that passes through the
 * prompt. So every result is redacted once more where the protocol answers,
 * whichever tool produced it.
 */
describe('a tool result never carries an identifier', () => {
  it('redacts an SSN and a card number out of whatever a tool returns', async () => {
    const leaky: ToolDefinition[] = [
      {
        name: 'find_my_letters',
        description: 'Return a stored letter.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({ text: 'Dear Acme — SSN 123-45-6789, card 4111 1111 1111 1111. Phone 617-555-0100.' }),
      },
    ];
    const reply = (await handle(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'find_my_letters', arguments: {} } },
      leaky,
      { name: 'test', version: '0' },
    )) as { result: { content: { text: string }[] } };
    const text = reply.result.content[0]!.text;
    expect(text).not.toContain('123-45-6789');
    expect(text).not.toContain('4111 1111 1111 1111');
    expect(text).toContain('Dear Acme');
    expect(text).toContain('617-555-0100');
  });
});
