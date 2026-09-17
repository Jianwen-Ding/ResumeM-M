/**
 * The answer bank, the matcher and the ingest path, tested at the places they
 * were getting things quietly wrong.
 *
 * These began as reproductions — every one of them failed — and each is the
 * smallest case that shows the behaviour. They are kept because the failures
 * they describe are all silent: a wrong answer submitted, a keyword match that
 * was not there, most of a file never ingested. Nothing here throws on its own,
 * so nothing but a test would notice.
 *
 * No network and no model call: the one AI-shaped path used here is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';
import { matchAnswer, questionSimilarity } from '../src/jobs/answers.js';
import { matchVariants } from '../src/jobs/match.js';
import { sanitizeAiPlan } from '../src/jobs/aiPlan.js';
import { resolveResume } from '../src/model/resolve.js';
import { segment, sortByRules } from '../src/ingest/sort.js';
import { extractText } from '../src/ingest/text.js';
import type { AnswerBankItem, StoreData } from '../src/model/types.js';

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  app = express();
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});
afterEach(() => t.cleanup());

/* ================================================================== *
 * 1. answers.ts:73 — a qualifier that REVERSES the answer scores as   *
 *    a confident match, because coverage divides by min(|a|,|b|).     *
 * ================================================================== */

const AUTHORIZED = 'Are you legally authorized to work in the United States?';
const WITHOUT_SPONSORSHIP =
  'Are you legally authorized to work in the United States without sponsorship?';

const SPONSORSHIP_BANK: AnswerBankItem[] = [
  {
    id: 'ans_without',
    question: WITHOUT_SPONSORSHIP,
    default: 'v_1',
    variants: [{ id: 'v_1', label: 'Saved', text: 'No. I will require H-1B sponsorship.' }],
  },
];

describe('a question and a narrower version of it', () => {
  it('does not call a question and its negation a confident match', () => {
    /*
     * The score is a ranking signal and stays one: this stored answer really is
     * the closest thing in the bank, and it is still offered as a starting
     * point. What must not happen is the *confidence* — "safe to reuse
     * verbatim", which means written into the draft and sent unread. Adding a
     * qualifier to a question only adds shared words, so the score alone can
     * never tell the two apart; the qualifier itself has to.
     */
    expect(questionSimilarity(AUTHORIZED, WITHOUT_SPONSORSHIP)).toBeGreaterThan(0.45);
    expect(matchAnswer(AUTHORIZED, SPONSORSHIP_BANK).confident).toBe(false);
  });

  it('never offers "No, I need sponsorship" as the answer to "are you authorized"', () => {
    const m = matchAnswer(AUTHORIZED, SPONSORSHIP_BANK);
    expect(m.confident).toBe(false);
  });

  it('does not write that false declaration into a draft application', async () => {
    t.write('answers.yaml', SPONSORSHIP_BANK);

    const res = await request(app)
      .post('/api/workspace')
      .send({
        company: 'Streamly',
        role: 'Intern',
        resumeId: 'intern',
        questions: [{ question: AUTHORIZED, required: true }],
      })
      .expect(200);

    const q = res.body.draft.questions[0];
    // Pre-filled, marked `source: 'bank'`, and carried verbatim into
    // application-answers.md by POST /api/workspace/:id/complete.
    expect(q.answer).not.toContain('sponsorship');
    expect(q.source).not.toBe('bank');
  });
});

/* ================================================================== *
 * 1b. api.ts:2004-2008 — with the AI off, /generate falls back to a   *
 *     match the code itself calls "a starting point", writes it in,   *
 *     and marks it `source: 'bank'` with no edit flag.                *
 * ================================================================== */

describe('an answer that only loosely matched', () => {
  it('marks a 0.59-scoring stored answer as one to read first', async () => {
    t.write('answers.yaml', [
      {
        id: 'ans_spons',
        question: 'Do you require sponsorship for employment?',
        default: 'v_1',
        variants: [{ id: 'v_1', label: 'Saved', text: 'Yes — I will need H-1B sponsorship.' }],
      },
    ]);

    const asked = 'Do you require a work permit for employment in the UK?';
    expect(questionSimilarity(asked, 'Do you require sponsorship for employment?')).toBeGreaterThan(0.45);

    const created = await request(app)
      .post('/api/workspace')
      .send({ company: 'Streamly', role: 'Intern', resumeId: 'intern', questions: [{ question: asked }] })
      .expect(200);

    // config.yaml has ai.enabled: false, so no model is called here.
    const res = await request(app)
      .post(`/api/workspace/${created.body.draft.id}/generate`)
      .send({ what: 'questions' })
      .expect(200);

    /*
     * It is offered, because it really is the closest thing in the bank and an
     * empty box helps nobody. What it must not do is arrive looking settled:
     * `matchAnswer` calls anything under 0.7 "a starting point the user should
     * read first", and this used to be filled in, unmarked, indistinguishable
     * from a confident match, and carried into the bundle by "Complete this
     * application" without anyone having read it.
     *
     * The Workspace renders `needsReview` as a "read this one first" badge
     * beside the answer.
     */
    const q = res.body.draft.questions[0];
    expect(q.answer).toBeTruthy();
    expect(q.source).toBe('bank');
    expect(q.needsReview).toBe(true);
  });

  it('does not mark a confident match, which is settled', async () => {
    t.write('answers.yaml', [
      {
        id: 'ans_why',
        question: 'Why are you interested in this role?',
        default: 'v_1',
        variants: [{ id: 'v_1', label: 'Saved', text: 'Because the work is interesting.' }],
      },
    ]);

    const created = await request(app)
      .post('/api/workspace')
      .send({
        company: 'Streamly',
        role: 'Intern',
        resumeId: 'intern',
        questions: [{ question: 'Why are you interested in this role?' }],
      })
      .expect(200);

    const res = await request(app)
      .post(`/api/workspace/${created.body.draft.id}/generate`)
      .send({ what: 'questions' })
      .expect(200);

    const q = res.body.draft.questions[0];
    expect(q.answer).toBe('Because the work is interesting.');
    expect(q.needsReview).toBeFalsy();
  });
});

/* ================================================================== *
 * 2. api.ts:1279 / api.ts:2100 — two different questions get one id.  *
 * ================================================================== */

describe('two questions that slug alike', () => {
  it('gives two different stored questions two different ids', async () => {
    t.write('answers.yaml', []);

    await request(app)
      .post('/api/answers/save')
      .send({ question: AUTHORIZED, answer: 'Yes.' })
      .expect(200);
    const res = await request(app)
      .post('/api/answers/save')
      .send({ question: WITHOUT_SPONSORSHIP, answer: 'No. I will require H-1B sponsorship.' })
      .expect(200);

    const ids = (res.body.answers as AnswerBankItem[]).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('edits only the item that was asked for', async () => {
    t.write('answers.yaml', []);
    await request(app).post('/api/answers/save').send({ question: AUTHORIZED, answer: 'Yes.' });
    await request(app)
      .post('/api/answers/save')
      .send({ question: WITHOUT_SPONSORSHIP, answer: 'No. I will require H-1B sponsorship.' });

    const bank = t.store.load().answers;
    const target = bank.find((a) => a.question === WITHOUT_SPONSORSHIP)!;

    // The UI's "keep the old wording as another version" path, and the same
    // `find(a => a.id === …)` that /workspace/:id/complete uses.
    await request(app)
      .post('/api/answers/save')
      .send({ itemId: target.id, question: target.question, answer: 'No — I need sponsorship.', label: 'v2' })
      .expect(200);

    const after = t.store.load().answers;
    const authorized = after.find((a) => a.question === AUTHORIZED)!;
    const pinned = authorized.variants.find((v) => v.id === authorized.default)!;
    expect(pinned.text).toBe('Yes.');
  });
});

/* ================================================================== *
 * 3. match.ts:44 — norm() deletes spaces, so includes() matches       *
 *    across word boundaries and inside longer words.                  *
 * ================================================================== */

describe('keyword scoring, on whole words', () => {
  it('does not credit "Rust" to "trust", "iOS" to "ratios", or "Java" to "ninja validation"', () => {
    const data = {
      entries: [
        {
          id: 'e1',
          kind: 'experience',
          title: 'X',
          bullets: [
            {
              id: 'b1',
              default: 'v_a',
              variants: [
                { id: 'v_a', label: 'A', text: 'Led the payments team' },
                {
                  id: 'v_b',
                  label: 'B',
                  text: 'Cut trust-and-safety incident ratios and built a ninja validation harness',
                },
              ],
            },
          ],
        },
      ],
      skillGroups: [],
      resumes: [],
    } as unknown as StoreData;

    const result = matchVariants(data, { id: 'base', label: 'b', sections: [] }, {
      keywords: ['Rust', 'iOS', 'Java'],
    });

    // Currently: swaps to v_b, "because": ["Rust", "iOS", "Java"].
    expect(result.rationale).toEqual([]);
    expect(result.choices).toEqual({});
  });
});

/* ================================================================== *
 * 4. aiPlan.ts:97 — a repeated skill id survives sanitising and is    *
 *    printed once per repetition.                                     *
 * ================================================================== */

describe('which skills the model may choose, and in what order', () => {
  it('keeps each skill item once, in store order', () => {
    const data = t.store.load();
    const plan = sanitizeAiPlan({ skills: { sk_lang: ['s_py', 's_py', 's_go', 's_py'] } }, data);
    expect(plan.skills.sk_lang).toEqual(['s_py', 's_go']);

    const spec = {
      id: 'dup',
      label: 'dup',
      extends: 'base',
      sections: [{ kind: 'skills' as const, entries: [], groups: ['sk_lang'], items: plan.skills }],
    };
    const resolved = resolveResume(spec, { ...data, resumes: [...data.resumes, spec] });
    const printed = resolved.sections.find((s) => s.kind === 'skills')!.skillGroups[0]!.items;
    // Currently prints: Python, Python, Go, Python
    expect(printed).toEqual([...new Set(printed)]);
  });
});

/* ================================================================== *
 * 5. sort.ts:82 — segment() silently truncates at 120 blocks.         *
 * ================================================================== */

describe('a file longer than one prompt', () => {
  const LONG = Array.from(
    { length: 300 },
    (_, i) =>
      `Paragraph number ${i}. This one is long enough to count as a real block of someone's prose, ` +
      'which is the whole point of dropping the file in.',
  ).join('\n\n');

  it('keeps every block, or says that it did not', () => {
    const blocks = segment(LONG);
    expect(blocks).toHaveLength(300);
  });

  it('proposes the whole file, not the first 40% of it', async () => {
    const res = await request(app)
      .post('/api/voice/ingest')
      .send({ name: 'old-letters.txt', text: LONG, useAi: false })
      .expect(200);

    const covered = (res.body.items as { text: string }[]).reduce((n, i) => n + i.text.length, 0);
    // Currently ~13k of ~33k characters; the last 180 paragraphs are gone and
    // nothing in the response says so.
    expect(covered).toBeGreaterThan(LONG.length * 0.9);
  });

  // CONTROL (passes): sortByRules loses nothing, so the loss is segment()'s.
  it('a rules pass over the blocks it was given covers all of them', () => {
    const blocks = segment(LONG).slice(0, 10);
    const props = sortByRules('x.txt', blocks);
    const claimed = new Set(props.flatMap((p) => p.blocks));
    expect(claimed.size).toBe(blocks.length);
  });
});

/* ================================================================== *
 * 6. text.ts:158 — </td>/</th> are not break tags, so a table-based   *
 *    HTML resume comes out with its words fused.                      *
 * ================================================================== */

describe('an HTML resume built out of a table', () => {
  const HTML = `<!doctype html><html><head><title>Resume - Google Docs</title></head><body>
<table>
 <tr><td><b>Acme Co.</b></td><td>Boston, MA</td></tr>
 <tr><td><i>Software Engineer Co-op</i></td><td>Jul 2024 &ndash; Dec 2024</td></tr>
</table>
<p>Skills: Python, Go</p>
</body></html>`;

  it('keeps table cells apart', async () => {
    const out = await extractText('resume.html', Buffer.from(HTML));
    // Currently: "Acme Co.Boston, MA" / "Software Engineer Co-opJul 2024 – Dec 2024"
    expect(out.text).not.toMatch(/Acme Co\.Boston/);
    expect(out.text).not.toMatch(/Co-opJul/);
  });

  it('does not put the browser tab title into the corpus', async () => {
    const out = await extractText('resume.html', Buffer.from(HTML));
    expect(out.text).not.toContain('Google Docs');
  });
});

/* ================================================================== *
 * 7. text.ts:204 (reflow) — a real resume PDF's bullets are glued     *
 *    into one paragraph and the next heading is swallowed.            *
 * ================================================================== */

const TEX = String.raw`\documentclass[10pt]{article}
\usepackage[margin=0.5in]{geometry}
\pagestyle{empty}
\begin{document}
\begin{center}{\Large Jianwen Ding}\end{center}
\section*{Experience}
\textbf{Acme Co.} \hfill Jul. 2024 -- Dec. 2024
\begin{itemize}
\item Built a Kafka pipeline handling two million events per day across three regions
\item Raised test coverage from 41\% to 88\% and cut the flaky-test rate by half
\item Led the migration of the billing service off a single Postgres primary
\end{itemize}
\section*{Projects}
\textbf{Thing}
\begin{itemize}
\item Built a thing that does a job, with a cache layer that survives restarts
\end{itemize}
\end{document}
`;

function compilePdf(dir: string): boolean {
  for (const [cmd, args] of [
    ['tectonic', ['s.tex']],
    ['latexmk', ['-pdf', '-interaction=nonstopmode', 's.tex']],
    ['pdflatex', ['-interaction=nonstopmode', 's.tex']],
  ] as const) {
    try {
      execFileSync(cmd, [...args], { cwd: dir, stdio: 'ignore' });
      if (fs.existsSync(path.join(dir, 's.pdf'))) return true;
    } catch {
      /* next engine */
    }
  }
  return false;
}

describe('a real resume PDF, read back', () => {
  it('keeps each bullet its own block, and the heading out of it', { timeout: 120_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-bughunt-'));
    try {
      fs.writeFileSync(path.join(dir, 's.tex'), TEX);
      if (!compilePdf(dir)) return; // no LaTeX here; nothing to prove
      const out = await extractText('resume.pdf', fs.readFileSync(path.join(dir, 's.pdf')));

      // Currently all three bullets land in one paragraph, with "Projects"
      // welded onto the end of the third.
      expect(out.text).not.toMatch(/Postgres primary Projects/);
      expect(out.text).not.toMatch(/three regions\s+Raised test coverage/);

      // And so the rules cannot tell it is a resume at all.
      const items = sortByRules('resume.pdf', segment(out.text));
      expect(items.some((i) => i.kind === 'resume')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================== *
 * 8. aiPlan.ts:64 — a bullet id containing a dot is read as           *
 *    "entryId.field" and a perfectly valid choice is rejected.        *
 * ================================================================== */

describe('a bullet id with a dot in it', () => {
  it('accepts a choice for a bullet whose id has a dot in it', () => {
    const data = {
      entries: [
        {
          id: 'e1',
          kind: 'experience',
          title: 'X',
          bullets: [
            {
              id: 'b.kafka',
              default: 'v1',
              variants: [
                { id: 'v1', label: 'a', text: 'one' },
                { id: 'v2', label: 'b', text: 'two' },
              ],
            },
          ],
        },
      ],
      skillGroups: [],
      resumes: [],
    } as unknown as StoreData;

    // resolve.ts looks this key up as `choices[bullet.id]`, so the store
    // honours it — only the sanitiser refuses it.
    const plan = sanitizeAiPlan({ choices: { 'b.kafka': 'v2' } }, data);
    expect(plan.rejected).toEqual([]);
    expect(plan.choices['b.kafka']).toBe('v2');
  });
});

/* ================================================================== *
 * 9. repo.ts:271 / repo.ts:289 — readReadme and readLanguages are     *
 *    documented as "never fatal", but only the *request* is guarded.  *
 *    A body that fails or is not JSON sinks the whole repo read.      *
 * ================================================================== */

describe('a repository read whose extras fail', () => {
  const ok = (body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  const REPO = { name: 'r', owner: { login: 'o' }, html_url: 'https://github.com/o/r' };

  it('survives a readme body that fails mid-transfer', async () => {
    const { readRepo } = await import('../src/ingest/repo.js');
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/readme')) {
        return { ok: true, status: 200, headers: new Headers(), text: () => Promise.reject(new Error('terminated')) };
      }
      if (url.endsWith('/languages')) return ok({ Go: 100 });
      return ok(REPO);
    }) as unknown as typeof fetch;

    const facts = await readRepo('https://github.com/o/r', { fetchImpl });
    expect(facts.name).toBe('r');
    expect(facts.readme).toBeUndefined();
  });

  it('survives a languages call that answers with an error page', async () => {
    const { readRepo } = await import('../src/ingest/repo.js');
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/readme')) return ok('# R\n\nA project.');
      if (url.endsWith('/languages')) return ok('<html>502 Bad Gateway</html>');
      return ok(REPO);
    }) as unknown as typeof fetch;

    const facts = await readRepo('https://github.com/o/r', { fetchImpl });
    expect(facts.name).toBe('r');
    expect(facts.languages).toBeUndefined();
  });
});
