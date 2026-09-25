/**
 * Tailoring a resume from inside the workspace.
 *
 * The extension does this with the posting already in front of it. A space
 * opened by hand has only what you typed and, if you pasted one, a link — so
 * the server runs the identical pipeline rather than a lesser second version
 * of it. That means this endpoint is where several things have to hold at
 * once, and the interesting ones are all about the second time it runs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { DEFAULT_CONFIG } from '../src/model/types.js';
import { hasLatex, makeTempStore, tempDir, type TempStore } from './helpers.js';

const scripts = tempDir('rmm-tailor-stub-');

/** A stand-in for the model, launched the way the real presets are. */
function saying(reply: string): { command: string; args: string[] } {
  const file = path.join(scripts, `${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(reply)});\n`, 'utf8');
  return { command: process.execPath, args: [file, '{prompt}'] };
}

let t: TempStore;
let app: express.Express;

function serve(reply?: string) {
  const ai = reply
    ? { ...DEFAULT_CONFIG.ai, enabled: true, ...saying(reply), timeoutMs: 20_000 }
    : { ...DEFAULT_CONFIG.ai, enabled: false };
  t = makeTempStore({ config: { ai, git: { autoCommit: false }, output: { dir: 'out' } } });
  app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
}

afterEach(() => t?.cleanup());

/** A space for a posting, with the text pasted in rather than fetched. */
async function openSpace(company = 'Streamly', role = 'Data Platform Intern') {
  const res = await request(app)
    .post('/api/workspace')
    .send({
      company,
      role,
      jobDescription: 'Kafka streaming infrastructure in Go and Python. Distributed systems, Kubernetes on AWS.',
    })
    .expect(200);
  return res.body.draft ?? res.body;
}

const tailor = (id: string, body: unknown = {}) =>
  request(app).post(`/api/workspace/${encodeURIComponent(id)}/tailor`).send(body as object);

describe('tailoring from a space', () => {
  it('makes a resume for the posting and attaches it to the space', async () => {
    serve();
    const draft = await openSpace();
    const res = await tailor(draft.id).expect(200);

    expect(res.body.spec.id).toBeTruthy();
    expect(res.body.draft.resumeId).toBe(res.body.spec.id);
    // Nothing was fetched: the space carries the posting text, not a link.
    expect(res.body.fetched).toBe(false);
    expect(t.store.load().resumes.map((r) => r.id)).toContain(res.body.spec.id);
  });

  /*
   * The one this endpoint has a comment about, and the reason to test it.
   *
   * The second run finds the space already pointing at the resume the first
   * run made. Building from that is the wrong answer, and quietly: the copy's
   * skills are already narrowed to this posting and its wordings already
   * chosen for it, so matching it again narrows what was narrowed and each
   * pass keeps fewer skills than the last. Back when this was a link rather
   * than a copy it was worse — the resume named itself as its base and every
   * read of it raised "Resume inheritance cycle" — but the fix is the same
   * either way: build it again from where it came from.
   */
  it('does not build a posting’s copy from itself when run twice', async () => {
    serve();
    const draft = await openSpace();
    const first = await tailor(draft.id).expect(200);
    const second = await tailor(first.body.draft.id).expect(200);

    expect(second.body.spec.copiedFrom).not.toBe(second.body.spec.id);
    const saved = t.store.load().resumes.find((r) => r.id === second.body.spec.id);
    expect(saved?.copiedFrom).not.toBe(saved?.id);
    // And it still resolves, which is what a self-reference would have ended.
    await request(app).get(`/api/resumes/${encodeURIComponent(second.body.spec.id)}/resolved`).expect(200);
  });

  it('keeps starting from the same base on the second run', async () => {
    serve();
    const draft = await openSpace();
    const first = await tailor(draft.id).expect(200);
    const second = await tailor(first.body.draft.id).expect(200);
    expect(second.body.spec.copiedFrom).toBe(first.body.spec.copiedFrom);
  });

  it('starts from the base it is told to', async () => {
    serve();
    const draft = await openSpace();
    const res = await tailor(draft.id, { baseResumeId: 'intern' }).expect(200);
    expect(res.body.spec.copiedFrom).toBe('intern');
  });

  it('says which space it cannot find', async () => {
    serve();
    const res = await tailor('no-such-space').expect(400);
    expect(res.body.error).toMatch(/no-such-space/);
  });

  /*
   * Two postings whose names a slug cannot tell apart.
   *
   * `applicationId` was taught this lesson already — a slug is ASCII-only and
   * truncates at sixty, so a company written in Chinese reduces to nothing and
   * two long titles sharing a prefix reduce to the same thing. `fingerprint`
   * and `faithful` exist for exactly that, and the tracker row, the bundle
   * folder and the upload file have all been keyed through them since.
   *
   * The tailored resume's own id was not: it was `job-<slug>-<slug>` and
   * nothing else, and `store.saveResume` writes `resumes/<id>.yaml` over
   * whatever is there. So two spaces that slug alike shared one file. The
   * second tailoring overwrote the first, in silence, and the first space —
   * still showing its own posting, its own letter, its own diff — would have
   * sent the other job's resume.
   *
   * "C++ Engineer" and "C# Engineer" is the everyday shape of it: punctuation
   * is all that separates them and a slug keeps none of it.
   */
  it('gives two postings a slug cannot tell apart two resumes', async () => {
    serve();
    const plus = await openSpace('Acme', 'C++ Engineer');
    const sharp = await openSpace('Acme', 'C# Engineer');

    const first = await tailor(plus.id).expect(200);
    const second = await tailor(sharp.id).expect(200);

    expect(second.body.spec.id).not.toBe(first.body.spec.id);

    // And the first one is still on disk, still saying which job it is for.
    const resumes = t.store.load().resumes;
    const kept = resumes.find((r) => r.id === first.body.spec.id);
    expect(kept?.label).toBe('C++ Engineer — Acme');
    expect(resumes.find((r) => r.id === second.body.spec.id)?.label).toBe('C# Engineer — Acme');
  });

  /*
   * The same collision with no ASCII at all, which is where `slug` gives up
   * entirely rather than merely blurring: both halves reduce to the empty
   * string, so every such posting minted `job--` and they all shared one file.
   */
  it('gives two postings with no ASCII in them two resumes', async () => {
    serve();
    const one = await openSpace('字节跳动', '软件工程师');
    const two = await openSpace('阿里巴巴', '后端工程师');

    const first = await tailor(one.id).expect(200);
    const second = await tailor(two.id).expect(200);

    expect(first.body.spec.id).not.toBe(second.body.spec.id);
    expect(t.store.load().resumes.find((r) => r.id === first.body.spec.id)?.label).toBe('软件工程师 — 字节跳动');
  });

  /*
   * And the ordinary case is untouched: a name a slug represents faithfully
   * still gets the readable id, because an id is meant to be recognisable in
   * a folder listing. A fix that hashed everything would have cost that.
   */
  it('leaves a readable name readable', async () => {
    serve();
    const draft = await openSpace('Streamly', 'Data Platform Intern');
    const res = await tailor(draft.id).expect(200);
    expect(res.body.spec.id).toBe('job-streamly-data-platform-intern');
  });
});

describe('when the AI is in the loop', () => {
  const PLAN = JSON.stringify({
    choices: { b_pipeline: 'v_kafka' },
    reasoning: 'The posting is about Kafka.',
  });

  it('uses the plan it came back with', async () => {
    serve(PLAN);
    const draft = await openSpace();
    const res = await tailor(draft.id, { useAi: true }).expect(200);
    expect(res.body.usedAi).toBe(true);
    expect(res.body.spec.choices.b_pipeline).toBe('v_kafka');
  });

  it('does not use it when it was not asked for', async () => {
    serve(PLAN);
    const draft = await openSpace();
    const res = await tailor(draft.id, { useAi: false }).expect(200);
    expect(res.body.usedAi).toBe(false);
  });

  /*
   * A malformed reply must not sink the deterministic match. The keyword
   * match is the floor this tool stands on — it works with the AI switched
   * off entirely — and a model returning prose is not a reason to hand back
   * nothing.
   */
  it('still produces a resume when the reply cannot be read', async () => {
    serve('I thought about this and here are some ideas for you.');
    const draft = await openSpace();
    const res = await tailor(draft.id, { useAi: true }).expect(200);
    expect(res.body.usedAi).toBe(false);
    expect(res.body.spec.id).toBeTruthy();
    expect(t.store.load().resumes.map((r) => r.id)).toContain(res.body.spec.id);
  });

  it('still makes a resume when the model will not start', async () => {
    // The same hole as on `/analyze`, one endpoint along: the button says
    // "with AI", and a command that is not there must not turn it into an
    // error. The resume is the keyword match, and the reason comes back
    // beside it.
    t = makeTempStore({
      config: {
        ai: { ...DEFAULT_CONFIG.ai, enabled: true, command: '/nonexistent/model-cli', args: ['{prompt}'], timeoutMs: 5_000 },
        git: { autoCommit: false },
        output: { dir: 'out' },
      },
    });
    app = express();
    app.use(express.json());
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

    const draft = await openSpace();
    const res = await tailor(draft.id, { useAi: true }).expect(200);
    expect(res.body.usedAi).toBe(false);
    expect(res.body.aiFailed).toBeTruthy();
    expect(t.store.load().resumes.map((r) => r.id)).toContain(res.body.spec.id);
  });

  it('reports what it refused to do, rather than doing it quietly', async () => {
    // A plan naming a wording that is not in the store: the sanitiser drops
    // it, and the editor shows what was dropped beside what was kept.
    serve(JSON.stringify({ choices: { b_pipeline: 'v_invented', b_ghost: 'v_base' } }));
    const draft = await openSpace();
    const res = await tailor(draft.id, { useAi: true }).expect(200);
    expect(res.body.spec.choices.b_pipeline).not.toBe('v_invented');
    expect(res.body.rejected.length).toBeGreaterThan(0);
  });
});

/**
 * The same questions for the endpoint the extension actually calls.
 *
 * `/extension/analyze` is the busiest route in the product — it runs on every
 * posting the extension decides is a posting. Its AI-off path is well covered
 * elsewhere; what was not covered is what happens when the AI is on, which is
 * how most people will run it.
 */
describe('analysing a posting with the AI switched on', () => {
  const JOB_HTML = `<html><head><title>SWE Intern at Streamly</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting","title":"Data Platform Intern",
"hiringOrganization":{"@type":"Organization","name":"Streamly"},
"description":"<p>Kafka streaming infrastructure in Go and Python, Kubernetes on AWS. Distributed systems. Minimum qualifications: BS in Computer Science.</p>"}
</script></head><body>Apply now</body></html>`;

  const analyze = (body: unknown) =>
    request(app).post('/api/extension/analyze').send(body as object);

  it('takes the plan the model returned as JSON', async () => {
    serve(JSON.stringify({ choices: { b_testing: 'v_base' }, reasoning: 'Testing is named in the posting.' }));
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);
    expect(res.body.aiUsed).toBe(true);
    expect(res.body.aiReasoning).toMatch(/Testing is named/);
    expect(res.body.tailor).toBe('ai');
  });

  /*
   * What the sanitiser threw out, on the route the extension actually calls.
   *
   * `sanitizeAiPlan` checks every id a model names against the save and drops
   * the ones that are not there — which is the whole of the rule that the AI
   * chooses between wordings and never writes one. The workspace route has
   * said what it dropped since it was written; this one computed exactly the
   * same list and did not send it, so a run where the model invented most of
   * its plan came back looking like a run where it chose three things. Same
   * shape as the fault `tailor: mode === 'ai' && !aiParsed ? 'match' : mode`
   * exists to prevent, one level down: the card cannot say what happened if it
   * is not told.
   */
  it('says what it threw out of the model’s plan', async () => {
    serve(JSON.stringify({ choices: { b_testing: 'v_base', b_pipeline: 'v_invented', b_ghost: 'v_base' } }));
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);

    expect(res.body.aiUsed).toBe(true);
    // The one real choice was kept, and the invented ones are named.
    expect(res.body.spec.choices.b_pipeline).not.toBe('v_invented');
    expect(res.body.rejected).toEqual(
      expect.arrayContaining([expect.stringContaining('b_pipeline'), expect.stringContaining('b_ghost')]),
    );
  });

  it('sends an empty list when there was nothing to throw out', async () => {
    serve(JSON.stringify({ choices: { b_testing: 'v_base' } }));
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);
    expect(res.body.rejected).toEqual([]);
  });

  /*
   * And falls back to the keyword match when it cannot.
   *
   * This is the one that matters. The match is deterministic and runs with the
   * AI switched off entirely; a model returning prose is a bad minute, not a
   * reason for the extension to offer nothing on a posting the person is
   * looking at right now.
   */
  it('still proposes a resume when the model returns prose', async () => {
    serve('Sure! Here are my thoughts on how to tailor this resume for you.');
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);

    expect(res.body.isJobPosting).toBe(true);
    expect(res.body.aiUsed).toBe(false);
    // And says so rather than letting the card claim the AI tailored it.
    expect(res.body.tailor).toBe('match');
    expect(res.body.aiRaw).toMatch(/my thoughts/);
    // The deterministic match is still there underneath it.
    expect(res.body.spec.choices.b_pipeline).toBe('v_kafka');
    expect(res.body.rationale.some((r: { key: string }) => r.key === 'b_pipeline')).toBe(true);
  });

  /*
   * The arrangement the model chose has to survive the trip to the document.
   *
   * `applyInclusion` marks a section it has reordered `manual`, precisely so
   * the master's date sort does not restack it on the way to the page. The
   * endpoint then merged the derived spec over the top and named `entries`
   * and `bullets` to put them back, but not `order` — and `Store.load()`
   * gives very nearly every section a date sort, so `manual` became `newest`
   * and the model's order was undone. Silently, after the tool had already
   * told the model it had worked.
   *
   * Asserted on the section rather than on the plan, because the plan was
   * always right: it is the resume that came out wrong.
   */
  /*
   * Entries, though, keep the resume's own order whatever the model asks.
   * "AI should be able to rearrange bullet points but not entries ever." A
   * reply that still names an `entryOrder` is told so in `rejected`, and the
   * section keeps the sort the base gave it rather than becoming `manual` —
   * which is how the old feature made an entry order stick.
   */
  /*
   * Two skills sections, and an AI run that hid a line.
   *
   * The narrowed `items` were copied onto the AI's sections by kind, so the
   * first skills section was handed the second one's — and every list the
   * first had cut down for itself went with it, printing every skill of a
   * group the base had trimmed.
   */
  it('keeps each skills section’s own lists when the AI shows or hides something', async () => {
    serve(JSON.stringify({ disable: ['b_testing'] }));
    t.write('skills.yaml', [
      ...(t.read('skills.yaml') as unknown[]),
      { id: 'sk_soft', name: 'Soft', items: [{ id: 's_talk', text: 'Talking' }, { id: 's_write', text: 'Writing' }] },
      { id: 'sk_tools', name: 'Tools', items: [{ id: 's_k8s', text: 'Kubernetes', tags: ['kubernetes'] }, { id: 's_tf', text: 'Terraform', tags: ['terraform'] }] },
    ]);
    t.write('resumes/two-skills.yaml', {
      id: 'two-skills',
      label: 'Two skills sections',
      sections: [
        { kind: 'experience', entries: ['exp_acme'] },
        { kind: 'skills', entries: [], groups: ['sk_lang', 'sk_soft'], items: { sk_soft: ['s_talk'] } },
        { kind: 'skills', heading: 'Tools', entries: [], groups: ['sk_tools'] },
      ],
    });

    const res = await analyze({ html: JOB_HTML, baseResumeId: 'two-skills', tailor: 'ai' }).expect(200);
    expect(res.body.aiUsed).toBe(true);
    const skills = (res.body.spec.sections as { kind: string; items?: Record<string, string[]> }[]).filter(
      (s) => s.kind === 'skills',
    );
    expect(skills).toHaveLength(2);
    // The line the AI hid is hidden, so the AI's sections are the ones used.
    expect(res.body.spec.sections[0].bullets.exp_acme).not.toContain('b_testing');
    // And the base's trimmed Soft list is still the first section's.
    expect(skills[0]!.items?.sk_soft).toEqual(['s_talk']);
  });

  it('keeps the line order the model chose, and the resume’s own entry order', async () => {
    serve(JSON.stringify({
      entryOrder: { experience: ['exp_acme'] },
      order: { exp_acme: ['b_testing', 'b_pipeline'] },
    }));
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);

    const experience = res.body.spec.sections.find((s: { kind: string }) => s.kind === 'experience');
    expect(res.body.aiUsed).toBe(true);
    // The lines, in the order asked for.
    expect(experience.bullets.exp_acme).toEqual(['b_testing', 'b_pipeline']);
    // And the resume saying it arranged them itself, which is what makes the
    // line above survive rendering.
    expect(experience.bulletOrder?.exp_acme).toBe('manual');

    // The entry order refused, and said so; the section's own sort kept.
    expect(res.body.rejected).toEqual(expect.arrayContaining([expect.stringMatching(/^entryOrder: /)]));
    const base = t.store.load().resumes.find((r) => r.id === 'base')!;
    const own = base.sections?.find((s) => s.kind === 'experience');
    expect(experience.order).not.toBe('manual');
    expect(experience.order).toBe(own?.order);
    expect(experience.entries).toEqual(own?.entries);
  });

  /*
   * A wording the model wrote is offered, never applied.
   *
   * This is the rule the whole tailoring design rests on: the AI chooses
   * between phrasings that are already yours and switches entries and lines
   * on or off, and it does not write the resume. `suggest_wording` is the one
   * tool that produces prose, and its whole contract is that the sentence
   * goes to the person to accept or decline — so it must reach the response
   * and must not reach the store or the resume on the way.
   *
   * Worth a test of its own rather than trusting the shape of the code: a
   * future change that merges suggestions into the spec "so they take effect"
   * would look like a convenience and would be the AI writing someone's
   * resume.
   */
  it('offers a wording the model wrote, and does not apply it', async () => {
    const invented = 'Ran a Kafka cluster nobody asked me to run';
    serve(
      JSON.stringify({
        choices: {},
        suggestions: [{ bulletId: 'b_pipeline', label: 'Kafka', text: invented, why: 'the posting names Kafka' }],
      }),
    );
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);

    // Offered, by name, so the person can take it or leave it.
    expect(res.body.suggestions?.some((s: { text: string }) => s.text === invented)).toBe(true);

    // And nowhere near the document. Not chosen —
    expect(JSON.stringify(res.body.spec)).not.toContain(invented);
    // — and not written into the store as a phrasing either, which is the
    // way it would survive past this one application.
    const stored = t.store.load().entries.flatMap((e) => e.bullets ?? []).flatMap((b) => b.variants ?? []);
    expect(stored.some((v) => v.text === invented)).toBe(false);
  });

  it('discards a choice the model invented', async () => {
    // The AI selects; it never writes. Anything that is not an id it could
    // have chosen from is dropped before it reaches a resume.
    serve(JSON.stringify({ choices: { b_pipeline: 'v_nonexistent' } }));
    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);
    expect(res.body.spec.choices.b_pipeline).not.toBe('v_nonexistent');
  });

  /*
   * A CLI that is not there at all.
   *
   * The commonest way this fails in use — `claude` off this process's PATH, a
   * renamed binary, a half-finished install — and it used to throw, become a
   * 502, and leave the extension showing an error instead of a card. On every
   * posting, until the configuration was fixed, for a product that works with
   * the AI switched off entirely.
   */
  it('still proposes a resume when the model will not start', async () => {
    t = makeTempStore({
      config: {
        ai: { ...DEFAULT_CONFIG.ai, enabled: true, command: '/nonexistent/model-cli', args: ['{prompt}'], timeoutMs: 5_000 },
        git: { autoCommit: false },
        output: { dir: 'out' },
      },
    });
    app = express();
    app.use(express.json());
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

    const res = await analyze({ html: JOB_HTML, baseResumeId: 'base', tailor: 'ai' }).expect(200);
    expect(res.body.isJobPosting).toBe(true);
    expect(res.body.tailor).toBe('match');
    expect(res.body.spec.choices.b_pipeline).toBe('v_kafka');
    // And says why, so the card can name a misconfigured AI rather than
    // leaving the person wondering why the star never lights up.
    expect(res.body.aiFailed).toBeTruthy();
  });
});

/*
 * The keyword tailor saves its result outright — there is no box to untick —
 * so the skills it writes have to be ones the base already prints. It used
 * to narrow each group from the whole group, and a language somebody had
 * turned off on their base came back the moment a posting named it.
 */
describe('tailoring by keyword never switches on a skill the base turned off', () => {
  it('keeps the base\'s own skills when the posting names one the base hides', async () => {
    serve();
    // Go is in the group and the posting names it; this base leaves it off.
    t.store.saveResume({
      id: 'no-go',
      label: 'No Go',
      sections: [{ kind: 'skills', entries: [], groups: ['sk_lang'], items: { sk_lang: ['s_py', 's_ts', 's_php'] } }],
    });
    const draft = await openSpace();
    const res = await tailor(draft.id, { baseResumeId: 'no-go' }).expect(200);
    const saved = t.store.load().resumes.find((r) => r.id === res.body.spec.id);
    const items = saved?.sections?.find((s) => s.kind === 'skills')?.items?.sk_lang;
    expect(items).not.toContain('s_go');
    expect(items).toEqual(['s_py', 's_ts', 's_php']);
  });
});

/*
 * A link that answers with a page and no posting in it.
 *
 * A careers site rendered by JavaScript sends an empty shell to anything that
 * does not run it. The extraction of that shell is empty, and the draft's
 * posting text was replaced with `html.slice(0, 20_000)` — the raw markup,
 * scripts and all — which every letter and answer after it then read, while
 * the posting text the applicant had pasted was gone.
 */
describe('a link that answers with an empty shell', () => {
  it('keeps the pasted posting text rather than saving the raw markup over it', async () => {
    const http = await import('node:http');
    const shell = `<!doctype html><html><head><script>window.__APP__={"flags":"x".repeat(1)}</script><style>.a{color:red}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(shell);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      serve();
      const port = (server.address() as { port: number }).port;
      const opened = await request(app)
        .post('/api/workspace')
        .send({
          company: 'Streamly',
          role: 'Data Platform Intern',
          url: `http://127.0.0.1:${port}/careers/42`,
          jobDescription: 'Kafka streaming infrastructure in Go and Python. Distributed systems, Kubernetes on AWS.',
        })
        .expect(200);
      const draft = opened.body.draft ?? opened.body;
      const res = await tailor(draft.id).expect(200);
      const saved = t.store.getDraft(res.body.draft.id);
      expect(saved?.jobDescription).not.toMatch(/<script|<style|<div id="root">/);
      expect(saved?.jobDescription).toContain('Kafka streaming infrastructure in Go and Python.');
    } finally {
      server.close();
    }
  });

  it('reads posting text an older version saved as raw markup as text', async () => {
    serve();
    const draft = await openSpace();
    const saved = t.store.getDraft(draft.id)!;
    t.store.saveDraft({
      ...saved,
      jobDescription: '<!doctype html><html><head><script>var a=1</script><style>.a{}</style></head><body><p>Kafka streaming in Go.</p></body></html>',
    });
    const read = t.store.getDraft(draft.id);
    expect(read?.jobDescription).not.toMatch(/<script|<style|<p>|var a=1/);
    expect(read?.jobDescription).toContain('Kafka streaming in Go.');
  });
});

/*
 * A tailored copy somebody has kept is theirs.
 *
 * The copy's id is derived from the company and the role, so the same posting
 * — a repost, a second go — derives the same id. Once the first copy had been
 * promoted to a kept resume and edited, tailoring again wrote a fresh
 * temporary copy over it: the edits gone, and the resume marked for the
 * sweep a week later. A kept resume is never overwritten by a copy; the new
 * one takes the next free id.
 */
describe('tailoring again never overwrites a copy that was kept', () => {
  it('leaves a promoted copy as it was and files the new one beside it', async () => {
    serve();
    const draft = await openSpace();
    const first = await tailor(draft.id).expect(200);
    const id = first.body.spec.id as string;

    const kept = t.store.load().resumes.find((r) => r.id === id)!;
    t.store.saveResume({ ...kept, tier: 'extended', label: 'My Streamly resume, hand-tuned' });

    const second = await tailor(first.body.draft.id).expect(200);
    expect(second.body.spec.id).not.toBe(id);
    const after = t.store.load().resumes.find((r) => r.id === id);
    expect(after?.tier).toBe('extended');
    expect(after?.label).toBe('My Streamly resume, hand-tuned');
  });

  it('still replaces its own temporary copy on a second run', async () => {
    serve();
    const draft = await openSpace();
    const first = await tailor(draft.id).expect(200);
    const second = await tailor(first.body.draft.id).expect(200);
    expect(second.body.spec.id).toBe(first.body.spec.id);
  });

  it('never lets a posted temporary copy overwrite a kept resume when filing', async () => {
    serve();
    t.store.saveResume({ id: 'job-streamly', label: 'Kept Streamly resume', tier: 'base' });
    const res = await request(app)
      .post('/api/applications/bundle')
      .send({
        company: 'Streamly',
        role: 'Data Platform Intern',
        spec: { id: 'job-streamly', label: 'Streamly', tier: 'temporary', copiedFrom: 'intern' },
      })
      .expect(200);
    expect(t.store.getResume('job-streamly')?.label).toBe('Kept Streamly resume');
    expect(t.store.getResume('job-streamly')?.tier).toBe('base');
    expect(res.body.application.resumeId).not.toBe('job-streamly');
  });
});

/*
 * A link that is not a web page, or never stops being one.
 *
 * Postings are often PDFs. The fetch decoded whatever came back as text, so a
 * PDF's bytes went into extraction and on to the AI as binary noise. And the
 * whole body was read before being cut to size, so a link that streamed
 * without end held the request until the fifteen-second abort.
 */
describe('a posting link that is a PDF, or that never ends', () => {
  const serveOnce = async (reply: (res: import('node:http').ServerResponse) => void) => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => reply(res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/posting` };
  };
  const spaceFor = async (url: string) => {
    const opened = await request(app)
      .post('/api/workspace')
      .send({ company: 'Streamly', role: 'Data Platform Intern', url, jobDescription: 'Pasted text.' })
      .expect(200);
    return opened.body.draft ?? opened.body;
  };

  it.skipIf(!hasLatex())('reads a PDF posting as its text', async () => {
    const fsMod = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'rmm-pdf-posting-'));
    fsMod.writeFileSync(pathMod.join(dir, 's.tex'), '\\documentclass{article}\\begin{document}Platform Engineer. You will own our Kafka streaming pipeline.\\end{document}');
    let pdf: Buffer | undefined;
    for (const [cmd, args] of [['tectonic', ['s.tex']], ['pdflatex', ['-interaction=nonstopmode', 's.tex']]] as const) {
      try {
        execFileSync(cmd, [...args], { cwd: dir, stdio: 'ignore' });
        if (fsMod.existsSync(pathMod.join(dir, 's.pdf'))) { pdf = fsMod.readFileSync(pathMod.join(dir, 's.pdf')); break; }
      } catch { /* next engine */ }
    }
    expect(pdf, 'a PDF to serve').toBeTruthy();
    const { server, url } = await serveOnce((res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    });
    try {
      serve();
      const draft = await spaceFor(url);
      const res = await tailor(draft.id).expect(200);
      const saved = t.store.getDraft(res.body.draft.id);
      expect(saved?.jobDescription).toContain('Kafka streaming pipeline');
      expect(saved?.jobDescription).not.toMatch(/%PDF|endobj|endstream/);
    } finally {
      server.close();
    }
  });

  it('stops reading a page that never ends, rather than waiting it out', async () => {
    const { server, url } = await serveOnce((res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><body><h1>Platform Engineer</h1><p>You will own our Kafka pipeline.</p>');
      const filler = `<p>${'more text about the team '.repeat(200)}</p>`;
      const pump = setInterval(() => {
        if (!res.write(filler)) return;
      }, 1);
      res.on('close', () => clearInterval(pump));
    });
    try {
      serve();
      const draft = await spaceFor(url);
      const began = Date.now();
      const res = await tailor(draft.id).expect(200);
      expect(Date.now() - began).toBeLessThan(10_000);
      expect(res.body.fetched).toBe(true);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  }, 30_000);
});
