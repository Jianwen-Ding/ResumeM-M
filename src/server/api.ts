import express, { type Request, type Response, type Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { runAgent, extractJson, trimToLetter, AgentError } from '../ai/agent.js';
import {
  answerPrompt,
  bulletFeedbackPrompt,
  applicationWritingPrompt,
  coverLetterPrompt,
  readMaterialPrompt,
  resumeAsText,
  entryFeedbackPrompt,
  feedbackPrompt,
  letterFeedbackPrompt,
  answerFeedbackPrompt,
  entryDraftPrompt,
  phrasingDraftPrompt,
  phraseFeedbackPrompt,
  shortenPrompt,
  tailorPrompt,
  type TailorContext,
} from '../ai/prompts.js';
import { AI_PRESETS, AI_TASKS, configForTask } from '../ai/presets.js';
import { canWire, serverEntry, wireUp } from '../mcp/launch.js';
import { readState } from '../mcp/main.js';
import type { SessionState } from '../mcp/session.js';
import type { AuthoringState } from '../mcp/authoring.js';
import { buildVoiceContext, renderVoiceContext } from '../ai/voice.js';
import { ingestFile } from '../ingest/index.js';
import { Repo, withCommit } from '../git/repo.js';
import { saveStore } from '../git/save.js';
import { matchAnswer, matchAnswers, relevantLetters, letterId } from '../jobs/answers.js';
import { classifyPage, employerFallback, extractJob, mergeJobPages, type PageSource } from '../jobs/extract.js';
import { applyInclusion, sanitizeAiPlan } from '../jobs/aiPlan.js';
import { deriveSpec, matchVariants } from '../jobs/match.js';
import { advance, alreadySent, applicationId, buildBundle, findApplication, findDraft, fingerprint, slug, stats } from '../model/applications.js';
import { byBaseFirst, defaultBaseId } from '../model/bases.js';
import { syncCurrent, CURRENT_DIR } from '../model/current.js';
import { diffResumes, sameDocument } from '../model/diff.js';
import { isSnapshotFile, parseSnapshot, type StoreSnapshot } from '../model/snapshot.js';
import { buildMaster, PROFILE_NAME_KEY, resolveProfile, resolveResume } from '../model/resolve.js';
import { readRepo } from '../ingest/repo.js';
import type { Store } from '../model/store.js';
import { DEFAULT_LAYOUT, isVariantField } from '../model/types.js';
import type {
  AnswerBankItem,
  Application,
  ApplicationStatus,
  Bullet,
  CoverLetter,
  Draft,
  DraftQuestion,
  Entry,
  EntryKind,
  MaybeVariant,
  Profile,
  ResolvedResume,
  ResumeSpec,
  SkillGroup,
  StoreData,
  Variant,
  VariantField,
  WritingSample,
} from '../model/types.js';
import { compileLetter, compileResume, OverflowError } from '../render/compile.js';
import { Jobs } from './jobs.js';

interface DescribedChange {
  key: string;
  from: string;
  to: string;
  because: string[];
  /** Which entry the change belongs to, in words. */
  where?: string;
  /** What kind of thing changed: a bullet, or a heading field. */
  what?: string;
  fromLabel?: string;
  toLabel?: string;
  fromText?: string;
  toText?: string;
}

const FIELD_WORDS: Record<string, string> = {
  title: 'title',
  dates: 'dates',
  subtitle: 'role',
  location: 'location',
};

/**
 * Resolve a raw `{key, from, to}` change into the human words it swaps, so the
 * extension can say "Coursework: Broad → Systems-leaning" instead of
 * "b_edu_coursework → v_systems".
 */
function describeChange(
  change: { key: string; from: string; to: string; because: string[] },
  data: StoreData,
): DescribedChange {
  const plainTitle = (e: Entry): string => {
    if (!isVariantField(e.title)) return String(e.title ?? e.id);
    const chosen = e.title.variants.find((v) => v.id === (e.title as VariantField).default) ?? e.title.variants[0];
    return String(chosen?.text ?? e.id);
  };

  const dot = change.key.indexOf('.');
  if (dot > 0) {
    const entryId = change.key.slice(0, dot);
    const fieldName = change.key.slice(dot + 1);
    const entry = data.entries.find((e) => e.id === entryId);
    const field = entry?.[fieldName as 'title' | 'dates' | 'subtitle' | 'location'];
    if (entry && field && typeof field !== 'string') {
      const from = field.variants.find((v) => v.id === change.from);
      const to = field.variants.find((v) => v.id === change.to);
      return {
        ...change,
        where: plainTitle(entry),
        what: FIELD_WORDS[fieldName] ?? fieldName,
        fromLabel: from?.label,
        toLabel: to?.label,
        fromText: from?.text,
        toText: to?.text,
      };
    }
    return { ...change };
  }

  for (const entry of data.entries) {
    const bullet = (entry.bullets ?? []).find((b) => b.id === change.key);
    if (!bullet) continue;
    const from = bullet.variants.find((v) => v.id === change.from);
    const to = bullet.variants.find((v) => v.id === change.to);
    return {
      ...change,
      where: plainTitle(entry),
      what: 'bullet',
      fromLabel: from?.label,
      toLabel: to?.label,
      fromText: from?.text,
      toText: to?.text,
    };
  }
  return { ...change };
}

/**
 * Fetch a job posting so a workspace opened by hand can be tailored the same
 * way the extension tailors one it is already looking at.
 *
 * Narrow on purpose. This server has no authentication and sits on loopback,
 * so anything it can be asked to fetch is worth constraining: http(s) only, a
 * hard timeout, and a cap on what is read. It also cannot see anything behind
 * a login — which is why failing to fetch is not treated as an error by the
 * caller, just as less to work with.
 */
async function fetchPosting(url: string): Promise<string> {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Only http and https links can be read');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Job boards serve very different markup to something that looks like
        // a script; asking as a browser gets the posting rather than a shell.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) throw new Error(`the site replied ${res.status}`);

    const text = await res.text();
    return text.slice(0, 2_000_000);
  } finally {
    clearTimeout(timer);
  }
}

/** Wrap an async handler so a rejection becomes a 4xx/5xx instead of a hang. */
function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (res.headersSent) return;
      if (err instanceof OverflowError) {
        res.status(422).json({ error: err.message, kind: 'overflow', report: err.report });
      } else if (err instanceof AgentError) {
        res.status(502).json({ error: err.message, kind: 'agent', partial: err.partial });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    }).finally(() => res.locals.finishProjectRequest?.());
  };
}

export interface ApiDeps {
  store: Store;
  repo: Repo;
  jobs?: Jobs;
}

/**
 * A drafted entry, made safe to show.
 *
 * Whatever the model returned is shaped into the store's own types here — ids
 * assigned, unknown fields dropped, kind forced to one this understands — so
 * that nothing downstream has to treat a proposal differently from an entry,
 * and so a malformed reply cannot smuggle a field in. It is still only a
 * proposal: the caller saves it or throws it away.
 */
function draftedEntry(raw: unknown): Entry {
  const draft = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const kinds = ['education', 'experience', 'project', 'skills', 'custom'] as const;
  const kind = kinds.includes(draft.kind as (typeof kinds)[number]) ? (draft.kind as EntryKind) : 'project';
  const title = text(draft.title) ?? 'Untitled';

  const bullets: Bullet[] = [];
  for (const [i, b] of (Array.isArray(draft.bullets) ? draft.bullets : []).entries()) {
    const list = Array.isArray((b as Record<string, unknown>)?.variants) ? ((b as Record<string, unknown>).variants as unknown[]) : [];
    const variants: Variant[] = [];
    for (const [j, v] of list.entries()) {
      const item = (v ?? {}) as Record<string, unknown>;
      const body = text(item.text);
      if (!body) continue;
      variants.push({
        id: `v_${slug(String(item.label ?? body).slice(0, 24)) || `alt${j + 1}`}`,
        label: text(item.label) ?? body.slice(0, 24),
        text: body,
        // Drafted, not reviewed — the editor already has a way of showing that.
        suggested: true,
      });
    }
    if (variants.length === 0) continue;
    // Ids have to be unique within the bullet, and a model repeating a label
    // is ordinary rather than exceptional.
    const seen = new Set<string>();
    for (const v of variants) {
      let id = v.id;
      for (let n = 2; seen.has(id); n++) id = `${v.id}_${n}`;
      v.id = id;
      seen.add(id);
    }
    bullets.push({ id: `b_${slug(title).slice(0, 20)}_${i + 1}`, default: variants[0]!.id, variants });
  }

  return {
    id: `e_${slug(title).slice(0, 40) || Date.now()}`,
    kind,
    title,
    ...(text(draft.subtitle) ? { subtitle: text(draft.subtitle)! } : {}),
    ...(text(draft.dates) ? { dates: text(draft.dates)! } : {}),
    ...(text(draft.location) ? { location: text(draft.location)! } : {}),
    bullets,
  };
}

/** The pinned wording of a field that may carry alternates. */
function plainText(field: MaybeVariant | undefined): string {
  if (field === undefined) return '';
  if (typeof field === 'string') return field;
  return String((field.variants.find((v) => v.id === field.default) ?? field.variants[0])?.text ?? '');
}

/**
 * What to tell the card about an application to this job that already went.
 *
 * Both names have to be real. `company` is undefined on every bare
 * application form, and matching on the role alone would tell somebody
 * looking at a Platform Engineer posting that they had applied to it because
 * they once applied to a Platform Engineer somewhere else entirely.
 *
 * The date is the one it actually went out on, which is not always the row's
 * `appliedAt` — that is stamped when the row is made, and a row made while
 * the application was still being written carries the day it was started.
 * The history knows better.
 */
function sentBefore(
  applications: Application[],
  company: string | undefined,
  role: string | undefined,
): { id: string; at: string; status: ApplicationStatus } | undefined {
  if (!company?.trim() || !role?.trim()) return undefined;
  const past = alreadySent(applications, company, role);
  if (!past) return undefined;
  const went = (past.history ?? []).find((h) => h.status === 'applied');
  const at = went?.at ?? past.appliedAt;
  return at ? { id: past.id, at, status: past.status } : undefined;
}

/**
 * Did the run actually decide anything through its tools?
 *
 * A session file exists the moment the server starts, because a run killed
 * before its first call should still be distinguishable from one that never
 * started. So "there is a file" is not the question — "is there a move in it"
 * is, and when there is not, the reply is read as JSON instead.
 */
function decidedAnything(state: SessionState): boolean {
  const { plan, suggestions, reasoning } = state;
  return (
    Object.keys(plan.choices).length > 0 ||
    Object.keys(plan.skills).length > 0 ||
    Object.keys(plan.order).length > 0 ||
    Object.keys(plan.entryOrder).length > 0 ||
    plan.enable.length > 0 ||
    plan.disable.length > 0 ||
    suggestions.length > 0 ||
    Boolean(reasoning)
  );
}

/**
 * The writing tools, for a run that is drafting a letter or an answer.
 *
 * Shaped as a helper because four endpoints want the same thing and the
 * difference between them is only which draft they are working on.
 */
function writingTools(
  data: StoreData,
  resolved: ReturnType<typeof resolveResume>,
  job: { company?: string; jobTitle?: string; jobDescription: string; url?: string },
  draft: { coverLetter: { required: boolean; body: string }; questions: Draft['questions'] },
): Parameters<typeof runAgent>[2] {
  return {
    wire: (sandbox, command) =>
      wireUp(
        sandbox,
        command,
        {
          kind: 'write',
          data,
          resume: resolved,
          posting: {
            company: job.company,
            jobTitle: job.jobTitle,
            url: job.url,
            description: job.jobDescription,
          },
          draft,
          resumeText: resumeAsText(resolved),
        },
        serverEntry(mcpDir),
      ),
    read: (out) => readState(out),
  };
}

/** Where the compiled MCP entry point sits relative to this file. */
const mcpDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp');

export function createApi({ store, repo, jobs = new Jobs() }: ApiDeps): Router {
  const api = express.Router();
  api.use(express.json({ limit: '32mb' }));

  const autoCommit = () => store.loadConfig().git.autoCommit;
  // Work the user started and walked away from.

  /**
   * What a resume resolved to at a given commit.
   *
   * Version history is the one page that has to look at the whole store dozens
   * of times over — once per commit — and a commit's contents are fixed
   * forever, so the document it produced is too. Remembering them turns the
   * second visit to a long history into no work at all. Bounded, because a
   * history of a thousand commits is not worth a thousand resolved documents
   * in memory; the oldest go first, and recomputing one costs a blob read.
   */
  const documentCache = new Map<string, ResolvedResume | null>();
  const MAX_REMEMBERED = 400;
  const rememberDocument = (key: string, doc: ResolvedResume | null): void => {
    documentCache.set(key, doc);
    while (documentCache.size > MAX_REMEMBERED) {
      const oldest = documentCache.keys().next().value;
      if (oldest === undefined) break;
      documentCache.delete(oldest);
    }
  };

  /* ---------------------------------------------------------------- *
   * Store reads                                                       *
   * ---------------------------------------------------------------- */

  api.get(
    '/store',
    handler(async (_req, res) => {
      const data = store.load();
      // config carries no secrets, but the AI command is machine-specific and
      // the GUI has no use for it.
      res.json({ ...data, config: { git: data.config.git, ai: { enabled: data.config.ai.enabled } } });
    }),
  );

  /**
   * Bases first. Everything that offers "start from…" wants the two or three
   * resumes you actually build from at the top, not whatever sorted first.
   */
  api.get(
    '/resumes',
    handler(async (_req, res) => res.json(byBaseFirst(store.loadResumes()))),
  );

  /**
   * Pin a resume as a base, or unpin it. Its own toggle rather than part of
   * the whole-spec save: this is a decision about how the store is organised,
   * and it should not ride along with an unrelated edit.
   */
  api.put(
    '/resumes/:id/base',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const base = (req.body as { base?: boolean }).base !== false;
      const spec = store.loadResumes().find((r) => r.id === id);
      if (!spec) throw new Error(`No resume "${id}"`);

      // Absent rather than false: an unpinned resume should look untouched in
      // YAML, not carry a field explaining that it is ordinary.
      if (base) spec.base = true;
      else delete spec.base;

      await withCommit(repo, autoCommit(), `${base ? 'Pin' : 'Unpin'} "${spec.label}" as a base`, () =>
        store.saveResume(spec),
      );
      res.json(spec);
    }),
  );

  api.get(
    '/resumes/:id/resolved',
    handler(async (req, res) => {
      const data = store.load();
      res.json(resolveResume(String(req.params.id), data));
    }),
  );

  api.put(
    '/resumes/:id',
    handler(async (req, res) => {
      const spec = { ...(req.body as ResumeSpec), id: String(req.params.id) };

      // `?commit=0` writes without committing. The editor auto-saves as you
      // work, and a commit per keystroke would bury the history it feeds; it
      // commits once the editing stops, through /store/save.
      const wantCommit = req.query.commit !== '0' && req.query.commit !== 'false';
      await withCommit(repo, autoCommit() && wantCommit, `Update resume "${spec.id}"`, () =>
        store.saveResume(spec),
      );
      res.json(spec);
    }),
  );

  api.delete(
    '/resumes/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      await withCommit(repo, autoCommit(), `Delete resume "${id}"`, () => store.deleteResume(id));
      res.json({ ok: true });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Store writes                                                      *
   * ---------------------------------------------------------------- */

  api.put(
    '/profile',
    handler(async (req, res) => {
      const profile = req.body as Profile;
      // `?commit=0` for the editor's inline edits, which commit on idle like
      // every other auto-save rather than once per keystroke.
      const wantCommit = req.query.commit !== '0' && req.query.commit !== 'false';
      await withCommit(repo, autoCommit() && wantCommit, 'Update profile', () => store.saveProfile(profile));
      res.json(profile);
    }),
  );

  api.put(
    '/entries/:id',
    handler(async (req, res) => {
      const entry = { ...(req.body as Entry), id: String(req.params.id) };
      await withCommit(repo, autoCommit(), `Update entry "${entry.id}"`, () => store.saveEntry(entry));
      res.json(entry);
    }),
  );

  api.delete(
    '/entries/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const removed = await withCommit(repo, autoCommit(), `Delete entry "${id}"`, () => store.deleteEntry(id));
      res.json({ ok: removed });
    }),
  );

  /**
   * Add a phrasing to an existing bullet. This is the write the whole system
   * is organised around — issue #3 in reverse: one place to add, everywhere to
   * use.
   */
  api.post(
    '/entries/:entryId/bullets/:bulletId/variants',
    handler(async (req, res) => {
      const { entryId, bulletId } = req.params as { entryId: string; bulletId: string };
      const data = store.load();
      const entry = data.entries.find((e) => e.id === entryId);
      if (!entry) throw new Error(`No entry "${entryId}"`);
      const bullet = (entry.bullets ?? []).find((b) => b.id === bulletId);
      if (!bullet) throw new Error(`No bullet "${bulletId}" on entry "${entryId}"`);

      const body = req.body as Partial<Variant> & { makeDefault?: boolean };
      if (!body.text?.trim()) throw new Error('A variant needs text');

      const id = body.id?.trim() || `v_${slug(body.label ?? body.text.slice(0, 20)) || Date.now()}`;
      if (bullet.variants.some((v) => v.id === id)) throw new Error(`Variant "${id}" already exists`);

      const variant: Variant = {
        id,
        label: body.label ?? 'New phrasing',
        text: body.text.trim(),
        tags: body.tags,
        note: body.note,
        suggested: body.suggested,
      };
      bullet.variants.push(variant);
      if (body.makeDefault) bullet.default = id;

      await withCommit(repo, autoCommit(), `Add variant "${id}" to bullet "${bulletId}"`, () =>
        store.saveEntry(entry),
      );
      res.json(variant);
    }),
  );

  /**
   * Pin an alternate as the one used when a resume expresses no preference.
   *
   * Choosing a wording on one resume is a decision about that resume; deciding
   * a wording is simply the better one is a decision about the store, and
   * until now there was no way to say the second without editing YAML. The key
   * is the same key `choices` uses — a bullet id, or `entryId.field` — so
   * "pinned here" and "chosen there" are the same idea at two scopes.
   */
  api.put(
    '/defaults/:key',
    handler(async (req, res) => {
      const key = String(req.params.key);
      const { variantId } = req.body as { variantId?: string };
      if (!variantId) throw new Error('Name the alternate to pin');

      const data = store.load();

      // The name on the page lives on the profile rather than on an entry, and
      // pins the same way everything else does.
      if (key === PROFILE_NAME_KEY) {
        const field = data.profile.name;
        if (typeof field === 'string') throw new Error('Your name has no alternates to pin');
        if (!field.variants.some((v) => v.id === variantId)) throw new Error('No such alternate');
        const label = field.variants.find((v) => v.id === variantId)?.label ?? variantId;
        await withCommit(repo, autoCommit(), `Pin "${label}" as the default`, () =>
          store.saveProfile({ ...data.profile, name: { ...field, default: variantId } }),
        );
        res.json({ key, variantId });
        return;
      }

      const dot = key.indexOf('.');
      const entry = dot > 0
        ? data.entries.find((e) => e.id === key.slice(0, dot))
        : data.entries.find((e) => (e.bullets ?? []).some((b) => b.id === key));
      if (!entry) throw new Error('That line is not in the store any more');

      const target = dot > 0
        ? entry[key.slice(dot + 1) as 'title' | 'dates' | 'subtitle' | 'location']
        : (entry.bullets ?? []).find((b) => b.id === key);
      if (!target || typeof target === 'string') throw new Error('That line has no alternates to pin');
      if (!target.variants.some((v) => v.id === variantId)) throw new Error('No such alternate');

      target.default = variantId;
      const label = target.variants.find((v) => v.id === variantId)?.label ?? variantId;
      await withCommit(repo, autoCommit(), `Pin "${label}" as the default`, () => store.saveEntry(entry));
      res.json({ key, variantId });
    }),
  );

  api.put(
    '/skills',
    handler(async (req, res) => {
      const groups = req.body as SkillGroup[];
      if (!Array.isArray(groups)) throw new Error('Skills have to be a list of groups');
      await withCommit(repo, autoCommit(), 'Update skills', () => store.saveSkillGroups(groups));
      res.json(groups);
    }),
  );

  /**
   * The AI and engine settings, editable from the GUI so config.yaml is not
   * the only way in. `args` is a template, so it is exposed verbatim.
   */
  api.get(
    '/config',
    handler(async (_req, res) => {
      const c = store.loadConfig();
      res.json({
        ai: c.ai,
        latex: c.latex,
        git: c.git,
        output: c.output,
        // Environment overrides win over the file, so say when one is active
        // rather than letting the GUI show a setting that is not in effect.
        overrides: {
          autoCommit: process.env.RMM_AUTOCOMMIT === '0',
          ai: process.env.RMM_AI === '0',
          engine: Boolean(process.env.RMM_LATEX_ENGINE),
        },
      });
    }),
  );

  /**
   * The CLIs this knows how to drive, so the editor does not carry its own
   * copy of a fact about external programs — a preset fixed in one place
   * and not the other is how a config ends up broken.
   */
  api.get('/ai/presets', handler(async (_req, res) => res.json({ presets: AI_PRESETS, tasks: AI_TASKS })));

  api.put(
    '/config',
    handler(async (req, res) => {
      const patch = req.body as Parameters<typeof store.saveConfig>[0];
      const saved = await withCommit(repo, autoCommit(), 'Update settings', () => store.saveConfig(patch));
      res.json(saved);
    }),
  );

  /**
   * Where the store lives and whether it is backed up anywhere.
   *
   * The store is a local git repository by default and stays that way. Pushing
   * it to GitHub is a deliberate step, not something that happens quietly, and
   * a resume store is exactly the kind of thing that belongs in a *private*
   * repository — which is why the reply says so rather than assuming.
   */
  api.get(
    '/config/store',
    handler(async (_req, res) => {
      const remote = await repo.remoteStatus();
      res.json({
        dir: store.root,
        isRepo: await repo.isRepo(),
        commits: (await repo.log(1)).length,
        remote,
        pending: await repo.pending(),
      });
    }),
  );

  /**
   * Save everything to git, in one deliberate act — the same operation
   * `rmm save` runs. Auto-commit covers edits made here; this covers the rest,
   * including a store that is not a repository yet.
   */
  api.post(
    '/store/save',
    handler(async (req, res) => {
      const { message, push } = req.body as { message?: string; push?: boolean };
      res.json(await saveStore(repo, { message, push: Boolean(push) }));
    }),
  );

  api.put(
    '/config/store/remote',
    handler(async (req, res) => {
      const { url } = req.body as { url: string };
      await repo.ensure();
      await repo.setRemote(String(url ?? '').trim());
      res.json(await repo.remoteStatus());
    }),
  );

  api.post(
    '/config/store/push',
    handler(async (_req, res) => {
      const result = await repo.push();
      res.json({ ...result, remote: await repo.remoteStatus() });
    }),
  );

  /** Run the configured AI command on a trivial prompt, to prove it works. */
  api.post(
    '/config/test-ai',
    handler(async (_req, res) => {
      const config = store.loadConfig();
      if (!config.ai.enabled) {
        res.json({ ok: false, reason: 'disabled', message: 'The AI is switched off.' });
        return;
      }
      const started = Date.now();
      try {
        const result = await runAgent(
          { ...config, ai: { ...config.ai, timeoutMs: Math.min(config.ai.timeoutMs, 60_000) } },
          'Reply with exactly the word: ready',
        );
        res.json({
          ok: true,
          ms: Date.now() - started,
          output: result.output.slice(0, 500),
          command: config.ai.command,
        });
      } catch (err) {
        res.json({ ok: false, reason: 'failed', message: (err as Error).message });
      }
    }),
  );

  /**
   * The voice as it will actually be used: the samples that will be sent, not
   * a description of them. Showing this is the point — you can see exactly
   * what the model will read.
   */
  api.get(
    '/voice',
    handler(async (_req, res) => {
      const data = store.load();
      const context = buildVoiceContext(data);
      res.json({
        voice: data.voice,
        samples: data.samples,
        context: {
          chars: context.chars,
          available: context.available,
          used: context.samples.map((x) => ({ kind: x.kind, title: x.title, chars: x.text.length })),
        },
        preview: renderVoiceContext(context),
      });
    }),
  );

  /** Add or replace a writing sample. */
  api.put(
    '/voice/samples/:id',
    handler(async (req, res) => {
      const body = req.body as Partial<WritingSample>;
      if (!body.text?.trim()) throw new Error('A sample needs some text');

      const sample: WritingSample = {
        id: String(req.params.id),
        title: body.title?.trim() || 'Untitled',
        kind: body.kind ?? 'other',
        text: body.text,
        createdAt: body.createdAt ?? new Date().toISOString(),
        writtenAt: body.writtenAt,
        tags: body.tags,
        archived: body.archived,
      };
      await withCommit(repo, autoCommit(), `Add writing sample "${sample.id}"`, () => store.saveSample(sample));
      res.json(sample);
    }),
  );

  api.delete(
    '/voice/samples/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const removed = await withCommit(repo, autoCommit(), `Remove writing sample "${id}"`, () =>
        store.deleteSample(id),
      );
      if (!removed) throw new Error(`No sample "${id}"`);
      res.json({ ok: true });
    }),
  );

  /**
   * Read a file and propose what is in it, without saving anything.
   *
   * Two steps rather than one: a model sorting someone's old letters into the
   * wrong drawers silently would be worse than not offering the feature, so
   * the proposal is shown before it becomes part of the corpus.
   */
  api.post(
    '/voice/ingest',
    handler(async (req, res) => {
      const body = req.body as { name?: string; data?: string; text?: string; useAi?: boolean };
      const name = String(body.name ?? '').trim();

      const bytes = body.data
        ? Buffer.from(body.data, 'base64')
        : Buffer.from(String(body.text ?? ''), 'utf8');

      res.json(await ingestFile(store.loadConfig(), name, bytes, { useAi: body.useAi !== false }));
    }),
  );

  /** Take the proposals the user kept and put them in the corpus, in one commit. */
  api.post(
    '/voice/ingest/accept',
    handler(async (req, res) => {
      const body = req.body as { items?: { kind?: string; title?: string; text?: string }[]; source?: string };
      const wanted = (body.items ?? []).filter((i) => i.text?.trim());
      if (wanted.length === 0) throw new Error('Nothing was selected');

      const stamp = Date.now().toString(36);
      const saved: WritingSample[] = wanted.map((item, n) => ({
        id: `${slug(item.title ?? '') || 'sample'}-${stamp}-${n}`,
        title: item.title?.trim() || 'Untitled',
        kind: (['letter', 'answer', 'resume', 'other'].includes(String(item.kind)) ? item.kind : 'other') as WritingSample['kind'],
        text: item.text!.trim(),
        createdAt: new Date().toISOString(),
        tags: body.source ? [`from:${body.source}`] : undefined,
      }));

      await withCommit(
        repo,
        autoCommit(),
        `Add ${saved.length} writing sample${saved.length === 1 ? '' : 's'}${body.source ? ` from ${body.source}` : ''}`,
        () => {
          for (const sample of saved) store.saveSample(sample);
        },
      );
      res.json({ added: saved.length, samples: saved });
    }),
  );

  api.put(
    '/voice',
    handler(async (req, res) => {
      const { voice } = req.body as { voice: string };
      await withCommit(repo, autoCommit(), 'Update voice notes', () => store.saveVoice(voice));
      res.json({ voice });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Rendering                                                         *
   * ---------------------------------------------------------------- */

  /**
   * Compile a stored resume, or an ad-hoc spec that was never saved — the GUI
   * previews unsaved mixes through the same path the PDF goes through, so what
   * you see is what compiles.
   */
  api.post(
    '/render',
    handler(async (req, res) => {
      const body = req.body as {
        resumeId?: string;
        spec?: ResumeSpec;
        master?: boolean;
        strict?: boolean;
        fit?: 'auto' | 'as-written';
      };
      const data = store.load();

      const resolved = body.master
        ? buildMaster(data)
        : body.spec
          ? resolveResume({ ...body.spec, id: body.spec.id ?? '__preview__' }, { ...data, resumes: [...data.resumes, { ...body.spec, id: body.spec.id ?? '__preview__' }] })
          : resolveResume(String(body.resumeId), data);

      /*
       * "As written" is the document before auto-fit touches it, and it is
       * what makes a live preview usable on a resume that is too long.
       *
       * Fitting is a search: compile, measure, shrink, compile again, until
       * the least shrinking that works is found. On a document that fits, the
       * first attempt is the answer and the whole thing costs one compile. On
       * one that is slightly too long it costs seven, which measured at 6.8
       * seconds against 0.47 — and all six extra compiles buy is 9.93pt of
       * font instead of 9.2pt. Paying that on every keystroke is what made the
       * editor look frozen exactly when somebody was trying to cut a line.
       *
       * So the preview asks for this first and gets the truth in half a
       * second: the real page count, the real overflow, and a PDF showing
       * every page it actually spills onto. The fitted version is a second
       * request, and only when the first one did not fit. Nothing about the
       * PDF that finally gets sent changes — that is still built by the full
       * search, through buildBundle.
       */
      const asWritten = body.fit === 'as-written';

      const name = body.master ? 'master' : (body.resumeId ?? body.spec?.id ?? 'preview');
      const suffix = asWritten ? '-as-written' : '';
      const pdfPath = path.join(store.outDir(), `${slug(name) || 'preview'}${suffix}.pdf`);

      const result = await compileResume(asWritten ? { ...resolved, layout: { ...resolved.layout, autoFit: false } } : resolved, {
        pdfPath,
        texPath: pdfPath.replace(/\.pdf$/, '.tex'),
        strict: body.strict ?? false,
        engine: store.loadConfig().latex.engine,
        // This endpoint only ever backs the editor's live preview, the
        // master-document view, and the extension's "build resume" step —
        // never a file that gets attached to an application, so the fast
        // preview path is safe to use here. It falls back to the trusted
        // engine on its own if unavailable.
        mode: 'preview',
      });

      res.json({
        pages: result.pages,
        fits: result.fits,
        overflowPt: result.overflowPt,
        overflowLines: result.overflowLines,
        usedPt: result.usedPt,
        availablePt: result.availablePt,
        adjustments: result.adjustments,
        engine: result.fastPath ? `${result.engine} (fast preview)` : result.engine,
        fastPath: result.fastPath,
        warnings: result.warnings,
        pdfUrl: `/pdf/${path.basename(pdfPath)}?t=${Date.now()}`,
      });
    }),
  );

  /**
   * Typeset a cover letter, so the letter is a real document set like the
   * resume rather than a .txt afterthought. Preview-mode by default: the file
   * that actually gets attached to an application is compiled by the trusted
   * engine in buildBundle().
   */
  api.post(
    '/render/letter',
    handler(async (req, res) => {
      const body = req.body as {
        body?: string;
        company?: string;
        role?: string;
        letterId?: string;
        draftId?: string;
        resumeId?: string;
      };
      const data = store.load();

      const name = slug(body.draftId ?? body.letterId ?? body.company ?? 'letter') || 'letter';
      const pdfPath = path.join(store.outDir(), `letter-${name}.pdf`);

      // The letter is set to match the resume it will be sent with, so the
      // pair looks like one document rather than two — which now includes the
      // name at the top, since that is a choice the resume makes.
      /*
       * A resume it cannot find is not a reason to refuse the letter.
       *
       * The resume is only here for the layout and the name at the top, and
       * the browser extension asks for this preview while holding a proposal
       * the store has not been given yet — an id that resolves to nothing
       * until the folder is prepared. Throwing there would mean the letter
       * cannot be looked at on precisely the screen where it is being
       * written, to save a difference in margins.
       */
      let sentWith;
      try {
        sentWith = body.resumeId ? resolveResume(String(body.resumeId), data) : undefined;
      } catch {
        sentWith = undefined;
      }
      const layout = sentWith?.layout ?? DEFAULT_LAYOUT;

      const result = await compileLetter(
        {
          profile: sentWith?.profile ?? resolveProfile(data.profile, {}, []),
          company: body.company,
          role: body.role,
          body: body.body ?? '',
        },
        layout,
        {
          pdfPath,
          texPath: pdfPath.replace(/\.pdf$/, '.tex'),
          engine: store.loadConfig().latex.engine,
          mode: 'preview',
        },
      );

      res.json({
        pages: result.pages,
        fits: result.fits,
        overflowLines: result.overflowLines,
        engine: result.fastPath ? `${result.engine} (fast preview)` : result.engine,
        fastPath: result.fastPath,
        pdfUrl: `/pdf/${path.basename(pdfPath)}?t=${Date.now()}`,
      });
    }),
  );

  /* ---------------------------------------------------------------- *
   * AI                                                                *
   * ---------------------------------------------------------------- */

  api.post(
    '/ai/feedback',
    handler(async (req, res) => {
      const { resumeId, focus, bulletId, entryId, variantId, fieldName, background, master, draftId, questionId } =
        req.body as {
          master?: boolean;
          resumeId?: string;
          focus?: string;
          bulletId?: string;
          entryId?: string;
          variantId?: string;
          fieldName?: 'title' | 'subtitle' | 'dates' | 'location';
          /** An application's cover letter, or one of its questions. */
          draftId?: string;
          questionId?: string;
          /** Return a job to collect later instead of holding the request open. */
          background?: boolean;
        };
      const data = store.load();

      const resumeTarget = resumeId || bulletId || entryId || variantId || fieldName;
      if (master && resumeTarget) throw new Error('Choose master feedback or a specific resume/bullet, not both');
      if (draftId && (master || resumeTarget)) throw new Error('Choose the application or the resume, not both');
      if (questionId && !draftId) throw new Error('An application is required for feedback on one of its questions');
      if ((resumeId && (entryId || bulletId || variantId || fieldName)) || (bulletId && fieldName)) throw new Error('Choose one feedback target');
      if ((bulletId || fieldName || variantId) && !entryId) throw new Error('An entry is required for phrase or bullet feedback');
      if (variantId && !bulletId && !fieldName) throw new Error('Choose a bullet or heading field for this phrasing');
      let prompt: string;
      let about: string;

      /*
       * The letter and the answers were the one part of an application the AI
       * could write but never read back. Reviewing your own prose is the thing
       * it is best at and the thing you least want to do at midnight, so they
       * critique through the same route, the same background jobs, and the
       * same panel as a resume does.
       */
      if (draftId) {
        const draft = store.getDraft(draftId);
        if (!draft) throw new Error(`No draft "${draftId}"`);
        if (questionId) {
          const question = draft.questions.find((q) => q.id === questionId);
          if (!question) throw new Error('That question is not on this application any more');
          prompt = answerFeedbackPrompt(data, draft, question);
          about = `Answer: ${question.question.slice(0, 60)}`;
        } else {
          prompt = letterFeedbackPrompt(data, draft, relevantLetters(data.coverLetters, { company: draft.company, role: draft.role }));
          about = `Cover letter — ${draft.company}`;
        }
      } else if (entryId) {
        const entry = data.entries.find((e) => e.id === entryId);
        if (!entry) throw new Error(`No entry "${entryId}"`);
        if (fieldName) {
          if (!['title', 'subtitle', 'dates', 'location'].includes(fieldName)) throw new Error('Unknown heading field');
          const field = entry[fieldName];
          const text = typeof field === 'string' && !variantId ? field
            : field && isVariantField(field) ? field.variants.find(v => v.id === variantId)?.text : undefined;
          if (!text) throw new Error('No matching heading phrasing');
          prompt = phraseFeedbackPrompt(data, entry, { id: `${entryId}.${fieldName}${variantId ? `:${variantId}` : ''}`, text });
          about = `${fieldName}: ${text.slice(0, 70)}`;
        } else if (bulletId) {
          const bullet = entry.bullets?.find((b) => b.id === bulletId);
          if (!bullet) throw new Error(`No bullet "${bulletId}" on entry "${entryId}"`);
          if (variantId) {
            const variant = !bullet.items && bullet.variants.find(v => v.id === variantId);
            if (!variant) throw new Error(`No phrasing "${variantId}" on bullet "${bulletId}"`);
            prompt = phraseFeedbackPrompt(data, entry, { id: `${entryId}/${bulletId}/${variantId}`, text: variant.text });
            about = `${variant.label}: ${variant.text.slice(0, 70)}`;
          } else {
            prompt = bulletFeedbackPrompt(data, entry, bullet);
            about = typeof entry.title === 'string' ? entry.title : 'a bullet point';
          }
        } else {
          prompt = entryFeedbackPrompt(data, entry);
          const titleField = entry.title;
          const title = typeof titleField === 'string' ? titleField
            : titleField.variants.find(v => v.id === titleField.default)?.text ?? titleField.variants[0]?.text;
          about = `Entry: ${title || entry.id}`;
        }
      } else {
        const resolved = master ? buildMaster(data) : resolveResume(String(resumeId), data);
        about = master ? 'Master Document' : resolved.label;

        /*
         * Compile it first, and hand the critique the real thing: the exact
         * LaTeX and what the compiler said about the page. Anything about
         * length, spacing, or "this runs over" is guesswork from plain text —
         * the reader sees a typeset page, so the critic should too. Compiling
         * also means the PDF beside it is current rather than whatever was
         * last built.
         */
        let tex: string | undefined;
        let fit: { pages: number; fits: boolean; overflowLines: number; adjustments: string[] } | undefined;
        try {
          const compiled = await compileResume(resolved, {
            pdfPath: path.join(store.outDir(), `${master ? 'master' : slug(resolved.id) || 'resume'}.pdf`),
            engine: data.config.latex.engine,
          });
          tex = compiled.tex;
          fit = {
            pages: compiled.pages,
            fits: compiled.fits,
            overflowLines: compiled.overflowLines,
            adjustments: compiled.adjustments,
          };
        } catch {
          // No LaTeX installed, or a resume that will not compile: the
          // critique is still worth having, just without the page evidence.
        }

        prompt = feedbackPrompt(data, resolved, { focus, tex, fit });
      }

      if (background) {
        const job = jobs.start('feedback', about, () => runAgent(configForTask(data.config, 'review'), prompt));
        res.json({ job });
        return;
      }

      const result = await runAgent(configForTask(data.config, 'review'), prompt);
      res.json(result);
    }),
  );

  /**
   * Read everything you have handed over into a proposal.
   *
   * The evening this saves is the first one. Getting started means having an
   * old resume, three cover letters, a project README and a performance
   * review, and typing the entries out of them by hand — while the files
   * themselves are already sitting in the corpus, read to text, because
   * `rmm voice add` and the Voice tab put them there.
   *
   * Nothing is written. The run builds a proposal and this hands it back; the
   * editor asks, entry by entry. That is the same rule as every other place
   * the AI touches resume text, applied to a larger unit — and it is why this
   * can be allowed to write at all.
   */
  api.post(
    '/ai/read-material',
    handler(async (req, res) => {
      const { sampleIds } = req.body as { sampleIds?: string[] };
      const data = store.load();

      const samples = store
        .loadSamples()
        .filter((sample) => !sample.archived)
        .filter((sample) => !sampleIds?.length || sampleIds.includes(sample.id))
        .filter((sample) => sample.text.trim().length > 40);

      if (samples.length === 0) {
        throw new Error(
          'There is nothing to read. Drop your old resume, your cover letters, or anything else you have ' +
            'written onto the Voice tab first — this reads what is there.',
        );
      }

      if (!canWire(data.config.ai.command) || serverEntry(mcpDir) === null) {
        throw new Error(
          `Reading material needs an AI command that can take tools. The presets that can are ` +
            `${AI_PRESETS.filter((p) => ['claude', 'codex', 'gemini'].includes(p.command)).map((p) => p.label).join(', ')}. ` +
            `Yours is "${data.config.ai.command}".`,
        );
      }

      const documents = samples.map((sample) => ({
        id: sample.id,
        name: sample.title,
        kind: sample.kind,
        text: sample.text,
      }));

      const existing = {
        entryIds: data.entries.map((e) => e.id),
        bulletIds: data.entries.flatMap((e) => (e.bullets ?? []).map((b) => b.id)),
        skillGroups: data.skillGroups.map((g) => ({ id: g.id, name: g.name })),
      };

      /*
       * In the background, like feedback.
       *
       * This is the longest-running thing in the product — four files read
       * end to end and an entry proposed out of each — and holding an HTTP
       * request open for it is the wrong shape twice over: you should be able
       * to go and do something else, and a request that takes four minutes is
       * one a proxy or a browser will give up on while the work carries on
       * invisibly.
       */
      const run = () => runAgent(
        configForTask(data.config, 'author'),
        readMaterialPrompt(data, documents.map((d) => ({ name: d.name, kind: d.kind }))),
        {
          wire: (sandbox, command) =>
            wireUp(
              sandbox,
              command,
              {
                kind: 'author',
                data,
                resume: resolveResume(defaultBaseId(data.resumes) ?? data.resumes[0]?.id ?? '', data),
                posting: { description: '' },
                documents,
                existing,
              },
              serverEntry(mcpDir),
            ),
          read: (out) => readState(out),
        },
      ).then((agent) => ({
        executed: agent.executed,
        prompt: agent.executed ? undefined : agent.output,
        read: samples.map((sample) => ({ id: sample.id, title: sample.title })),
        proposal: agent.executed ? ((agent.tools as AuthoringState | undefined) ?? null) : null,
        // Said plainly, because the whole arrangement depends on it being true.
        saved: false,
      }));

      const n = samples.length;
      res.json({ job: jobs.start('material', `${n} ${n === 1 ? 'file' : 'files'} of your writing`, run) });
    }),
  );

  /**
   * Draft a new entry, from a repository link or a few lines of notes.
   *
   * Proposed, never saved. The store is the thing this tool protects, and a
   * model writing straight into it is how you end up with a resume that says
   * something you did not do — so this hands back a draft and the editor asks.
   */
  api.post(
    '/ai/draft-entry',
    handler(async (req, res) => {
      const { repoUrl, notes, kind } = req.body as { repoUrl?: string; notes?: string; kind?: string };
      if (!repoUrl?.trim() && !notes?.trim()) throw new Error('Give a repository link or say a little about it');

      const data = store.load();
      // Read the repository first: a failure there is about the link, and
      // saying so beats a vague failure after a minute of the AI thinking.
      const repo = repoUrl?.trim() ? await readRepo(repoUrl.trim()) : undefined;

      const prompt = entryDraftPrompt(data, { repo, notes, kind });
      const agent = await runAgent(configForTask(data.config, 'author'), prompt);
      if (!agent.executed) {
        res.json({ executed: false, prompt: agent.output, repo, entry: null });
        return;
      }

      let entry: unknown;
      try {
        entry = extractJson(agent.output);
      } catch {
        throw new Error('The AI did not return an entry this could read. Try again, or write it by hand.');
      }
      res.json({ executed: true, repo, entry: draftedEntry(entry), raw: agent.output });
    }),
  );

  /** Another way to say a line that already exists. Proposed, never saved. */
  api.post(
    '/ai/draft-phrasing',
    handler(async (req, res) => {
      const { entryId, bulletId, fieldName, angle, count } = req.body as {
        entryId?: string;
        bulletId?: string;
        fieldName?: 'title' | 'subtitle' | 'dates' | 'location';
        angle?: string;
        count?: number;
      };
      if (!entryId) throw new Error('Say which line to rephrase');
      if (Boolean(bulletId) === Boolean(fieldName)) throw new Error('Choose a bullet or a heading field, not both');

      const data = store.load();
      const entry = data.entries.find((e) => e.id === entryId);
      if (!entry) throw new Error(`No entry "${entryId}"`);

      const field = fieldName ? entry[fieldName] : entry.bullets?.find((b) => b.id === bulletId);
      if (!field) throw new Error('That line is not in the store any more');
      const texts = typeof field === 'string'
        ? [field]
        : (field.variants ?? []).map((v) => String(v.text));
      if (texts.length === 0) throw new Error('That line has no wording to work from');

      const pinned = typeof field === 'string' ? field
        : texts[Math.max(0, (field.variants ?? []).findIndex((v: Variant) => v.id === field.default))] ?? texts[0]!;

      const prompt = phrasingDraftPrompt(data, {
        entryTitle: plainText(entry.title) || entry.id,
        current: pinned,
        siblings: texts.filter((t) => t !== pinned),
        angle,
        count,
      });
      const agent = await runAgent(configForTask(data.config, 'author'), prompt);
      if (!agent.executed) {
        res.json({ executed: false, prompt: agent.output, variants: [] });
        return;
      }

      let parsed: { variants?: { label?: string; text?: string }[] };
      try {
        parsed = extractJson(agent.output);
      } catch {
        throw new Error('The AI did not return wordings this could read. Try again, or write one by hand.');
      }
      const variants = (parsed.variants ?? [])
        .filter((v) => typeof v?.text === 'string' && v.text.trim())
        .slice(0, 5)
        .map((v) => ({ label: String(v.label ?? '').trim() || v.text!.trim().slice(0, 24), text: v.text!.trim() }));
      if (variants.length === 0) throw new Error('The AI came back with nothing usable.');
      res.json({ executed: true, variants, raw: agent.output });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Background work                                                   *
   * ---------------------------------------------------------------- */

  api.get('/ai/jobs', handler(async (_req, res) => res.json({ jobs: jobs.list() })));

  api.get(
    '/ai/jobs/:id',
    handler(async (req, res) => {
      // Fetching a finished job is how you read it, so that clears the badge.
      const job = jobs.get(String(req.params.id));
      if (!job) throw new Error('That result has expired');
      if (job.status !== 'running') jobs.read(job.id);
      res.json(job);
    }),
  );

  api.delete(
    '/ai/jobs/:id',
    handler(async (req, res) => res.json({ ok: jobs.dismiss(String(req.params.id)) })),
  );

  api.post(
    '/ai/tailor',
    handler(async (req, res) => {
      const { resumeId, job } = req.body as { resumeId: string; job: TailorContext };
      // Without this, a missing `job` surfaced as "Cannot read properties of
      // undefined (reading 'company')", which names nothing a caller can fix.
      if (!job?.jobDescription?.trim()) throw new Error('A job description is needed to tailor against');

      const data = store.load();
      const resolved = resolveResume(resumeId, data);
      const result = await runAgent(configForTask(data.config, 'tailor'), tailorPrompt(data, resolved, job));
      if (!result.executed) return res.json({ ...result, parsed: null });

      const parsed = extractJson<{
        choices?: Record<string, string>;
        skills?: Record<string, string[]>;
        suggestions?: { bulletId: string; label: string; text: string; why: string }[];
        reasoning?: string;
      }>(result.output);
      res.json({ ...result, parsed });
    }),
  );

  api.post(
    '/ai/shorten',
    handler(async (req, res) => {
      const { resumeId, linesToCut } = req.body as { resumeId: string; linesToCut?: number };
      const data = store.load();
      const resolved = resolveResume(resumeId, data);
      const bullets = resolved.sections.flatMap((s) => s.entries.flatMap((e) => e.bullets));
      const result = await runAgent(configForTask(data.config, 'tailor'), shortenPrompt(data, bullets, linesToCut ?? 2));
      res.json(result);
    }),
  );

  /**
   * Draft a cover letter for a posting, grounded in previous letters.
   *
   * Works with the AI off: it still returns the most relevant previous letters,
   * which is the thing you would actually start from. "Generated from previous
   * responses" should not require a model to be installed.
   */
  api.post(
    '/ai/cover-letter',
    handler(async (req, res) => {
      const { resumeId, job, save } = req.body as {
        resumeId: string;
        job: TailorContext;
        save?: boolean;
      };
      const data = store.load();
      const resolved = resolveResume(resumeId, data);
      const prior = relevantLetters(data.coverLetters, { company: job.company, role: job.jobTitle });

      const result = await runAgent(
        configForTask(data.config, 'write'),
        coverLetterPrompt(data, resolved, job, prior, { tools: canWire(data.config.ai.command) && serverEntry(mcpDir) !== null }),
        writingTools(data, resolved, job, { coverLetter: { required: true, body: '' }, questions: [] }),
      );

      /*
       * The letter the tools were handed, where there was one.
       *
       * A letter passed as the argument to `save_letter` cannot have prose
       * accidentally prepended to it, which is the failure `trimToLetter`
       * exists to clean up after. That path is still here for every run that
       * answered the old way.
       */
      const written = (result.tools as { letter?: string } | undefined)?.letter?.trim();
      const body = written || (result.executed ? trimToLetter(result.output) : '');
      let saved: CoverLetter | undefined;
      if (save && body.trim()) {
        saved = {
          id: letterId(job.company, job.jobTitle),
          // Named for where it came from when the page never said who is
          // hiring — see `employerFallback`.
          title: `${job.jobTitle ?? 'Role'} — ${job.company ?? employerFallback(job.url)}`,
          company: job.company,
          role: job.jobTitle,
          createdAt: new Date().toISOString(),
          body,
        };
        const letter = saved;
        await withCommit(repo, autoCommit(), `Add cover letter "${letter.id}"`, () =>
          store.saveCoverLetter(letter),
        );
      }

      res.json({
        ...result,
        body,
        saved,
        // Always useful, and the whole answer when the AI is off.
        priorLetters: prior.map((l) => ({
          id: l.id,
          title: l.title,
          company: l.company,
          role: l.role,
          createdAt: l.createdAt,
          body: l.body,
        })),
      });
    }),
  );

  /**
   * Match page questions against the answer bank with no AI call at all. This
   * is the offline path: a question you have answered before comes back
   * answered.
   */
  api.post(
    '/answers/match',
    handler(async (req, res) => {
      const { questions, threshold, company } = req.body as {
        questions: string[];
        threshold?: number;
        // Who is being applied to, so an answer written for somebody else can
        // be recognised as one — and so an answer written for *these* people
        // is preferred over whatever was written last.
        company?: string;
      };
      if (!Array.isArray(questions)) throw new Error('questions must be an array');
      const data = store.load();
      res.json({
        matches: matchAnswers(questions, data.answers, { threshold, company }),
        bankSize: data.answers.length,
      });
    }),
  );

  /**
   * Answer a question. Reuses a stored answer outright when one plainly covers
   * it, and only reaches for the AI when nothing does — or when asked to adapt
   * the stored answer to this specific posting.
   */
  api.post(
    '/ai/answer',
    handler(async (req, res) => {
      const { question, job, force } = req.body as {
        question: string;
        job?: TailorContext;
        force?: boolean;
      };
      const data = store.load();
      const match = matchAnswer(question, data.answers);

      if (match.confident && !force) {
        res.json({
          output: match.answer,
          executed: false,
          source: 'answer-bank',
          match,
        });
        return;
      }

      const result = await runAgent(configForTask(data.config, 'write'), answerPrompt(data, question, job));

      /*
       * `output` means "text you may use". When the AI did not run, `runAgent`
       * hands back the prompt it would have sent — which is worth showing
       * someone, and is not an answer.
       *
       * Spread whole, it was: the card put `r.output` straight into the answer
       * box, so one click on "Draft an answer" with the AI off filled the
       * employer's form with nine kilobytes beginning "You are helping with a
       * resume and job-search assistant", and carrying, further down, every
       * cover letter the user had ever saved and their whole writing corpus.
       * "Prepare to submit" then wrote that into application-answers.md
       * and copied it to the upload folder.
       *
       * The separate `prompt` field is what /ai/draft-entry and
       * /ai/draft-phrasing already use, and what the editor already reads.
       */
      if (!result.executed) {
        res.json({ output: '', executed: false, source: 'prompt', prompt: result.output, match });
        return;
      }
      res.json({ ...result, source: 'ai', match });
    }),
  );

  /** Save an answer back to the bank, so the next form starts from it. */
  api.post(
    '/answers/save',
    handler(async (req, res) => {
      const { question, answer, label, itemId } = req.body as {
        question: string;
        answer: string;
        label?: string;
        itemId?: string;
      };
      if (!question?.trim() || !answer?.trim()) throw new Error('question and answer are required');

      const answers = store.load().answers;
      const existing = itemId ? answers.find((a) => a.id === itemId) : undefined;

      if (existing) {
        // A new phrasing of a question already in the bank, not a new question.
        const id = `v_${slug(label ?? new Date().toISOString().slice(0, 10))}` || `v_${Date.now()}`;
        const unique = existing.variants.some((v) => v.id === id) ? `${id}-${Date.now() % 10000}` : id;
        existing.variants.push({ id: unique, label: label ?? 'Saved', text: answer.trim() });
        existing.default = unique;
      } else {
        answers.push({
          id: answerId(question, answers),
          question: question.trim(),
          default: 'v_1',
          variants: [{ id: 'v_1', label: label ?? 'Saved', text: answer.trim() }],
        });
      }

      await withCommit(repo, autoCommit(), 'Update answer bank', () => store.saveAnswers(answers));
      res.json({ ok: true, answers });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Job pages and tailoring — what the extension calls                *
   * ---------------------------------------------------------------- */

  /**
   * Analyse a page and propose a tailored resume. The deterministic tag match
   * always runs; the AI pass refines it only when enabled. Nothing is written
   * to the store here — this is a proposal the user still has to accept.
   */
  api.post(
    '/extension/analyze',
    handler(async (req, res) => {
      const { url, title, html, pages, baseResumeId, useAi, tailor } = req.body as {
        url?: string;
        title?: string;
        html?: string;
        /** Every page of this application, oldest first. */
        pages?: PageSource[];
        baseResumeId?: string;
        useAi?: boolean;
        /**
         * How much to change, if anything.
         *
         * `useAi` could only ever say which of two kinds of tailoring to do,
         * and left no way to ask for none: every proposal arrived already
         * altered, and the only account of what had happened was a list of
         * changes with nothing to undo them. "Send the resume I already have"
         * is the most ordinary thing anyone wants from this and it was the one
         * thing it could not be told.
         */
        tailor?: 'none' | 'match' | 'ai';
      };
      const mode = tailor ?? (useAi ? 'ai' : 'match');
      /*
       * A mode this does not know silently behaved as `match` and was echoed
       * back to the card as if it had happened — so an extension asking for
       * something misspelled got a resume it did not ask for, labelled with
       * the thing it asked for. Three modes, named in the refusal.
       */
      if (!['none', 'match', 'ai'].includes(mode)) {
        throw new Error(`"${mode}" is not a way of tailoring. It is one of: none, match, ai.`);
      }

      /*
       * One application, however many pages it is spread across. The single
       * page is the trail of length one: the description you read and the form
       * you are filling in are usually two different pages on two different
       * hosts, and writing a cover letter from whichever one happens to be
       * open is why the letters came out thin.
       */
      const trail: PageSource[] = pages?.length ? pages : html ? [{ url, title, html }] : [];
      if (trail.length === 0) throw new Error('No page HTML supplied');

      const data = store.load();
      const current = trail[trail.length - 1]!;
      const job = mergeJobPages(trail);
      // The verdict is about the page you are on; the description is about all
      // of them. A form page is worth offering on even though it describes
      // nothing, which is exactly the case a single score could not express.
      const verdict = classifyPage(current.html, current.url);
      /*
       * And the same question asked of every page of this application.
       *
       * The verdict above is about the page you are on, deliberately: a form
       * page is an `application` even though it describes nothing. But whether
       * to offer *at all* is a question about the application, not the page —
       * a careers page that is a heading and an embedded board says nothing
       * itself, and the posting is in the frame, which arrives here as one of
       * these. Judging the outer page alone meant the card appeared, read the
       * frame, and then removed itself.
       */
      const others = trail.filter((p) => p !== current).map((p) => classifyPage(p.html, p.url));
      const score = Math.max(verdict.score, ...others.map((v) => v.score));
      const anyPageIsAJob = verdict.kind !== 'none' || others.some((v) => v.kind !== 'none');

      const baseId = baseResumeId ?? defaultBaseId(data.resumes);
      if (!baseId) throw new Error('The store has no resumes to start from');
      const base = data.resumes.find((r) => r.id === baseId);
      if (!base) throw new Error(`No resume "${baseId}"`);

      /*
       * `none` still produces a spec, and deliberately: the application wants
       * its own copy of the resume so that the folder, the filename and the
       * version history all name the posting. It simply selects nothing, so
       * the copy resolves to exactly the base — the diff below comes back
       * empty and the card says so.
       */
      const match =
        mode === 'none'
          ? { choices: {}, skills: {}, rationale: [] }
          : matchVariants(data, base, { keywords: job.keywords });

      let aiParsed: unknown = null;
      let aiRaw: string | undefined;
      let aiVia: 'tools' | 'json' | undefined;
      if (mode === 'ai' && data.config.ai.enabled) {
        const resolved = resolveResume(baseId, data);
        const posting = {
          jobTitle: job.title,
          company: job.company,
          jobDescription: job.description,
          url,
        };
        /*
         * The prompt has to agree with what the run will actually have. A
         * model told to call tools it was never given answers with nothing,
         * and one handed tools but asked for JSON mostly writes the JSON and
         * leaves them alone.
         */
        const withTools = canWire(data.config.ai.command) && serverEntry(mcpDir) !== null;
        const agent = await runAgent(
          configForTask(data.config, 'tailor'),
          tailorPrompt(data, resolved, posting, { tools: withTools }),
          /*
           * Tools where the CLI can take them, JSON where it cannot.
           *
           * The two paths produce the same shape of plan on purpose — the
           * session builds exactly what `sanitizeAiPlan` already accepts —
           * so nothing downstream has to know which one ran. What changes is
           * where the mistakes are caught: through the tools a wrong id is
           * answered while the model can still fix it, and a reply that
           * would not have parsed costs nothing because there is no reply to
           * parse.
           */
          {
            wire: (sandbox, command) =>
              wireUp(
                sandbox,
                command,
                {
                  data,
                  resume: resolved,
                  posting: {
                    company: job.company,
                    jobTitle: job.title,
                    url,
                    description: job.description,
                    keywords: job.keywords,
                  },
                },
                serverEntry(mcpDir),
              ),
            read: (out) => readState(out),
          },
        );
        aiRaw = agent.output;

        const decided = agent.tools as SessionState | null | undefined;
        if (decided && decidedAnything(decided)) {
          aiParsed = { ...decided.plan, suggestions: decided.suggestions, reasoning: decided.reasoning };
          aiVia = 'tools';
        } else {
          try {
            aiParsed = extractJson(agent.output);
            aiVia = 'json';
          } catch {
            // A malformed AI reply must not sink the deterministic proposal.
            aiParsed = null;
          }
        }
      }

      // The AI selects; it never writes a resume. Everything it returns is
      // checked against the store, and anything that is not a real id it could
      // have chosen from is discarded. See jobs/aiPlan.ts.
      const plan = aiParsed ? sanitizeAiPlan(aiParsed, data) : null;
      const finalMatch = plan
        ? {
            ...match,
            choices: { ...match.choices, ...plan.choices },
            skills: { ...match.skills, ...plan.skills },
          }
        : match;

      /*
       * "Apply — Unknown" was the label in the resume picker for every bare
       * application form, and there is more than one of those. Named for
       * where it came from instead — see `employerFallback`.
       */
      const employer = job.company ?? employerFallback(url);
      const specId = `job-${slug(employer)}-${slug(job.title ?? 'role')}`.slice(0, 60);
      const spec = deriveSpec(base, specId, `${job.title ?? 'Role'} — ${employer}`, finalMatch, {
        url,
        company: job.company,
        role: job.title,
      });

      // Showing and hiding entries or bullets, the other half of what the AI
      // is allowed to do. Merged over whatever deriveSpec built for skills.
      const inclusion = plan ? applyInclusion(base, data, plan) : undefined;
      if (inclusion) {
        const bySkills = new Map((spec.sections ?? []).map((s) => [s.kind, s]));
        spec.sections = inclusion.map((s) => ({ ...s, ...(bySkills.get(s.kind) ?? {}), entries: s.entries, bullets: s.bullets }));
      }

      // What the tailoring actually did to the document, in the same words the
      // version history uses: the sentence it replaced and the one it chose.
      // The extension shows this as the before/after; a list of variant ids
      // is not something anyone can check at a glance.
      let diff: ReturnType<typeof diffResumes> = [];
      try {
        diff = diffResumes(
          resolveResume(baseId, data),
          resolveResume(spec, { ...data, resumes: [...data.resumes, spec] }),
          { ignoreLabel: true },
        );
      } catch {
        // A proposal that will not resolve is still worth returning; the card
        // falls back to listing the changes it knows about.
      }

      res.json({
        /*
         * The verdict, and only the verdict.
         *
         * `|| score >= JOB_SHAPED` was a second opinion that overrode the
         * first, and the classifier's whole job is to weigh that score against
         * what else it can see. So a page that scored well on vocabulary and
         * had nothing to act on — a news article about the hiring slowdown, a
         * documentation page headed "Requirements", a forum thread about how
         * many applications people sent — came back `kind: 'none'` and
         * `isJobPosting: true`, and the card appeared on all three.
         */
        isJobPosting: anyPageIsAJob,
        /*
         * Which save this proposal was built from.
         *
         * Everything below — the base resume, the wordings, the profile the
         * PDF is typeset with — belongs to one save, and a person can open
         * another one in the editor while an application is open in the
         * browser. The extension sends this back when it files the
         * application, and the server refuses it if the answer has changed.
         * See the `x-rmm-project` check where saves are switched.
         */
        save: store.root,
        /*
         * "You have applied to this one before."
         *
         * Not a warning and not a refusal — the same job comes round again,
         * and reapplying a year later is a perfectly good idea. But finding
         * out afterwards, from the tracker, that you have just spent twenty
         * minutes writing a second letter for a role you were turned down for
         * in March is a waste this tool is in a position to prevent, and it
         * knows before the first word is written.
         *
         * Only when the posting names both the company and the role. The
         * employer fallback reads a company off the host, which is a good
         * enough label for a resume and nowhere near good enough to tell
         * somebody they have done this already.
         */
        applied: sentBefore(data.applications, job.company, job.title),
        score,
        kind: verdict.kind,
        why: verdict.why,
        job,
        // What each page contributed, so the card can show the trail and the
        // user can drop a page that does not belong.
        pages: job.pages,
        baseResumeId: baseId,
        baseLabel: base.label,
        spec,
        diff,
        // Ids are how the store refers to things; they are not how a person
        // reads a diff. Resolve each change to the words it actually swaps.
        rationale: finalMatch.rationale.map((r) => describeChange(r, data)),
        entryByBullet: Object.fromEntries(
          data.entries.flatMap((e) => (e.bullets ?? []).map((b) => [b.id, e.id])),
        ),
        suggestions: (aiParsed as { suggestions?: unknown[] } | null)?.suggestions ?? [],
        aiReasoning: (aiParsed as { reasoning?: string } | null)?.reasoning,
        aiUsed: Boolean(aiParsed),
        // Which of the two ways the AI answered, so a run that went through
        // the tools can be told apart from one that got lucky with JSON.
        aiVia,
        aiRaw: aiParsed ? undefined : aiRaw,
        // What was actually done, not what was asked for: an AI run that came
        // back unusable falls through to the keyword match, and the card has
        // to be able to say so.
        tailor: mode === 'ai' && !aiParsed ? 'match' : mode,
      });
    }),
  );

  /** Everything the extension needs to fill a form without asking again. */
  api.get(
    '/autofill',
    handler(async (_req, res) => {
      const data = store.load();
      // Resolved: a form field takes a name, not a set of them.
      const p = resolveProfile(data.profile, {}, []);
      res.json({
        fields: {
          full_name: p.name,
          email: p.email,
          phone: p.phone,
          linkedin: p.linkedin,
          github: p.github,
          website: p.website,
          location: p.location,
          ...(p.autofill ?? {}),
        },
        answers: data.answers.map((a) => ({
          id: a.id,
          question: a.question,
          answer: (a.variants.find((v) => v.id === a.default) ?? a.variants[0])?.text ?? '',
        })),
      });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Applications                                                      *
   * ---------------------------------------------------------------- */

  api.get(
    '/applications',
    handler(async (_req, res) => {
      const apps = store.load().applications;
      res.json({ applications: apps, stats: stats(apps), current: syncCurrent(store, apps) });
    }),
  );

  /**
   * One application, whole: the resume, the letter, the answers, the files, and
   * how it has moved. Looking back at an application means seeing what was
   * actually submitted, not three separate lists that have to be cross-read.
   */
  api.get(
    '/applications/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const data = store.load();
      const app = data.applications.find((a) => a.id === id);
      if (!app) throw new Error(`No application "${id}"`);

      const letter =
        data.coverLetters.find((l) => l.id === app.letterId) ??
        data.coverLetters.find((l) => l.applicationId === app.id);

      // Through the store, which refuses a snapshot path that leads out of the
      // output folder — this route lists what is in it, and the listing is
      // shown to the browser. See `Store.outPath`.
      const dir = app.snapshotDir ? store.outPath(app.snapshotDir) : undefined;
      const files =
        dir && fs.existsSync(dir)
          ? fs
              .readdirSync(dir, { withFileTypes: true })
              .filter((e) => e.isFile())
              .map((e) => e.name)
          : [];

      /*
       * The base by the name its owner gave it.
       *
       * `extends` is an id, and the detail pane printed it raw — "Built on
       * base." is not a sentence, it is a filename with a full stop after it.
       * Resolved here because the pane has only this one response to work
       * from and no reason to hold the whole store.
       */
      const sent = app.resumeId ? (store.getResume(app.resumeId) ?? null) : null;
      const extendsLabel = sent?.extends
        ? (store.getResume(sent.extends)?.label ?? sent.extends)
        : undefined;

      res.json({
        application: app,
        resume: sent,
        extendsLabel,
        letter: letter ?? (app.coverLetter ? { id: null, body: app.coverLetter, title: 'As sent' } : null),
        files,
        dir: dir ?? null,
      });
    }),
  );

  api.post(
    '/applications',
    handler(async (req, res) => {
      const body = req.body as Partial<Application>;
      if (!body.company || !body.role) throw new Error('company and role are required');
      const app: Application = {
        id: body.id ?? applicationId(body.company, body.role),
        company: body.company,
        role: body.role,
        url: body.url,
        appliedAt: body.appliedAt ?? new Date().toISOString(),
        status: body.status ?? 'applied',
        resumeId: body.resumeId,
        source: body.source,
        notes: body.notes,
        answers: body.answers,
        history: body.history ?? [
          { at: new Date().toISOString(), status: body.status ?? 'applied', note: 'Recorded' },
        ],
      };
      await withCommit(repo, autoCommit(), `Track application to ${app.company}`, () =>
        store.upsertApplication(app),
      );
      res.json(app);
    }),
  );

  api.delete(
    '/applications/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const apps = store.load().applications;
      const next = apps.filter((a) => a.id !== id);
      if (next.length === apps.length) throw new Error(`No application "${id}"`);
      // The snapshot folder under out/ is left alone: a record of what was sent
      // is worth keeping even when the tracker row was a mistake.
      await withCommit(repo, autoCommit(), `Remove application "${id}"`, () =>
        store.saveApplications(next),
      );
      res.json({ ok: true });
    }),
  );

  api.post(
    '/applications/:id/status',
    handler(async (req, res) => {
      const { status, note } = req.body as { status: Application['status']; note?: string };
      const id = String(req.params.id);
      const app = await withCommit(repo, autoCommit(), `${id}: ${status}`, () => advance(store, id, status, note));
      res.json(app);
    }),
  );

  /**
   * The application looks like it was sent.
   *
   * A rough check, and deliberately so: the extension sees the form it filled
   * being submitted, and that is the best evidence anyone is going to get from
   * outside the portal. What it is worth is the difference between a tracker
   * that reflects what you did and one that reflects what you remembered to
   * record — and nobody records the last step, because by then the tab has
   * already gone to a confirmation page.
   *
   * Keyed on company and role rather than an id, because the caller is a
   * browser extension that knows a posting, not a filing system. Everything
   * about how an application is named stays on this side.
   *
   * It only ever moves forwards. An application already at `interview` is not
   * dragged back to `applied` because a form was resubmitted, and one already
   * `applied` is left alone rather than given a second identical history line.
   */
  api.post(
    '/extension/sent',
    handler(async (req, res) => {
      const body = req.body as { company?: string; role?: string; url?: string; note?: string };
      if (!body.company || !body.role) throw new Error('company and role are required');

      const data = store.load();
      /*
       * By company and role, not by the id today would make. An application
       * opened yesterday and sent today asks for an id that does not exist,
       * and what happened next was a second row: the send filed its own
       * application as `applied` while the one being worked on sat at
       * `applying` for ever. See `findApplication`.
       */
      const tracked = findApplication(data.applications, body.company, body.role);
      const id = tracked?.id ?? applicationId(body.company, body.role);
      const note = body.note ?? 'The form was submitted on the page';
      const now = new Date().toISOString();

      // Past `applied` already: the tracker knows more than the page does.
      const BEFORE_SENT: Application['status'][] = ['interested', 'applying'];
      if (tracked && !BEFORE_SENT.includes(tracked.status)) {
        res.json({ application: tracked, changed: false });
        return;
      }

      const application = await withCommit(repo, autoCommit(), `${id}: applied`, () => {
        if (tracked) return advance(store, id, 'applied', note);
        /*
         * Submitted without ever opening a workspace — a form filled straight
         * from the card, which is the quick path and the one most likely to
         * leave no trace. Recording it is the whole point.
         */
        const made: Application = {
          id,
          company: body.company!,
          role: body.role!,
          url: body.url,
          status: 'applied',
          appliedAt: now,
          history: [{ at: now, status: 'applied', note }],
        };
        store.upsertApplication(made);
        return made;
      });

      // And the draft, if there is one, stops looking like something to finish
      // — found the same way, for the same reason.
      const draft = findDraft(store.loadDrafts(), body.company, body.role);
      if (draft && draft.status !== 'submitted') {
        store.saveDraft({ ...draft, status: 'submitted', updatedAt: now });
      }

      res.json({ application, changed: true });
    }),
  );

  /**
   * Compile, name, and file everything for one application in a single folder,
   * then snapshot it. Replaces the rename/download/re-upload loop.
   */
  api.post(
    '/applications/bundle',
    handler(async (req, res) => {
      const body = req.body as Parameters<typeof buildBundle>[1] & { spec?: ResumeSpec };

      // A posting-specific spec from the extension is saved first so the
      // snapshot refers to something that still exists later.
      if (body.spec) {
        await withCommit(repo, autoCommit(), `Add tailored resume "${body.spec.id}"`, () =>
          store.saveResume(body.spec as ResumeSpec),
        );
        body.resumeId = body.spec.id;
      }

      const result = await buildBundle(store, body);

      /*
       * And the space it was being written in stops looking like unfinished
       * work — marked, never deleted.
       *
       * "Prepare to submit" files the application as sent, so a space left at
       * `drafting` would sit in the Workspace next to a tracker row that says
       * it went out, and the two lists would disagree about the same job.
       * Marking is not closing: a sent space is still listed and still
       * editable, under the live ones, until `retireStaleDrafts` lets it go a
       * fortnight after the last keystroke. A portal that rejects the upload,
       * or a question that comes back a week later, both want the text rather
       * than the snapshot of it.
       */
      const opened = findDraft(store.loadDrafts(), result.application.company, result.application.role);
      if (opened && result.application.status === 'applied' && opened.status !== 'submitted') {
        store.saveDraft({ ...opened, status: 'submitted', updatedAt: new Date().toISOString() });
      }

      // The same files also go to the flat folder, which is the one a portal's
      // file picker should be pointed at — the archive is for later.
      const current = syncCurrent(store);
      if (autoCommit()) await repo.commitAll(`Apply: ${result.application.company} — ${result.application.role}`);
      /*
       * And anything that did not land there, by name.
       *
       * `syncCurrent` has always been able to say which files it could not put
       * in the upload folder — a folder of the user's sitting where a file
       * should go, a file they have open and locked, a full disk — and this
       * route threw the answer away. The folder is the one a portal's file
       * picker is pointed at, so a file missing from it silently is the exact
       * failure the folder exists to prevent: an upload that attaches last
       * week's resume, or nothing at all, with the card saying it is ready.
       */
      res.json({ ...result, currentDir: current.dir, currentProblems: current.problems });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Workspace — applications in progress                              *
   * ---------------------------------------------------------------- */

  /**
   * Change a draft on the copy that is on disk now, not the one this request
   * read a minute ago.
   *
   * Every route below reads the draft, does something slow — fetches a posting,
   * runs the AI, compiles a bundle, commits to git — and then writes the whole
   * object back. Meanwhile the person who started it is doing the obvious thing
   * with the waiting time: writing the notes, or the answer to the question the
   * AI is not being asked for. The Workspace saves that as they type, and the
   * reply to the slow request landed on top of it, restoring the draft to what
   * it held when the button was pressed. Nothing reported it; the text simply
   * was not there any more.
   *
   * So the slow work happens on the copy it read, and only the fields the route
   * actually produced are applied, to a draft read again at the end.
   */
  /**
   * Which of a draft's written parts differ between two reads of it, named the
   * way the person who typed them would name them.
   */
  const changedText = (now: Draft | undefined, before: Draft): string[] => {
    if (!now) return [];
    const changed: string[] = [];
    if (now.coverLetter.body !== before.coverLetter.body) changed.push('cover letter');
    const was = new Map(before.questions.map((q) => [q.id, q.answer]));
    if (now.questions.some((q) => was.has(q.id) && was.get(q.id) !== q.answer)) changed.push('answers');
    if ((now.notes ?? '') !== (before.notes ?? '')) changed.push('notes');
    return changed;
  };

  const reviseDraft = async (id: string, message: string, change: (fresh: Draft) => void): Promise<Draft> =>
    withCommit(repo, autoCommit(), message, () => {
      const fresh = store.getDraft(id);
      if (!fresh) throw new Error(`No draft "${id}"`);
      change(fresh);
      return store.saveDraft(fresh);
    });

  /**
   * How long a sent application stays in the Workspace before it lets itself
   * out.
   *
   * Sending is not the end of writing: the portal rejects the upload, the
   * recruiter asks for the letter again, a question comes back a week later
   * worded differently. So a space that has been sent stays open and editable
   * — just out of the way, under the ones still being written.
   *
   * It cannot stay forever, or the list becomes an archive of everything ever
   * applied for, which the tracker already is and does better. Two weeks
   * without a keystroke is the line: long enough to cover the week-later
   * follow-up, short enough that the list is still a list of live work. What
   * is lost is the editing surface, not the content — the application record
   * keeps the letter, the answers and the files exactly as they went out.
   */
  const KEEP_SENT_FOR_DAYS = 14;

  /** Let go of the spaces that have been sent and untouched since. */
  const retireStaleDrafts = (): void => {
    const cutoff = Date.now() - KEEP_SENT_FOR_DAYS * 24 * 60 * 60 * 1000;
    for (const draft of store.loadDrafts()) {
      if (draft.status !== 'submitted') continue;
      const touched = Date.parse(draft.updatedAt ?? '');
      // An unparseable date is not a reason to delete somebody's work.
      if (Number.isFinite(touched) && touched < cutoff) store.deleteDraft(draft.id);
    }
  };

  api.get(
    '/workspace',
    handler(async (_req, res) => {
      retireStaleDrafts();
      res.json({ drafts: store.loadDrafts() });
    }),
  );

  api.get(
    '/workspace/:id',
    handler(async (req, res) => {
      const draft = store.getDraft(String(req.params.id));
      if (!draft) throw new Error(`No draft "${String(req.params.id)}"`);
      res.json(draft);
    }),
  );

  /**
   * Open a workspace for a posting.
   *
   * The extension knows what a form asks for; a browser sidebar is the wrong
   * place to write three paragraphs of prose. This carries the requirement into
   * the editor, pre-filling anything the answer bank already covers so the
   * human starts from text rather than from empty boxes.
   */
  api.post(
    '/workspace',
    handler(async (req, res) => {
      const body = req.body as {
        company?: string;
        role?: string;
        url?: string;
        source?: string;
        jobDescription?: string;
        resumeId?: string;
        spec?: ResumeSpec;
        coverLetterRequired?: boolean;
        /** What the extension has already been written into, if anything. */
        coverLetter?: string;
        questions?: { question: string; required?: boolean; answer?: string }[];
      };
      if (!body.company || !body.role) throw new Error('company and role are required');

      const data = store.load();
      /*
       * Which space this job already has, whatever day it was opened — but
       * only its id. The draft itself is read after the slow work below, and
       * reading it here instead is precisely the bug the test named "does not
       * reopen a workspace onto what it said before" exists to catch.
       */
      const id = findDraft(store.loadDrafts(), body.company, body.role)?.id ?? applicationId(body.company, body.role);

      // A posting-specific resume comes over with the draft; save it so the
      // draft refers to something that still exists later.
      if (body.spec) {
        const spec = body.spec;
        await withCommit(repo, autoCommit(), `Add tailored resume "${spec.id}"`, () => store.saveResume(spec));
      }

      /*
       * Read after that, not before it.
       *
       * The extension re-posts the page as you move through an application,
       * and saving the tailored resume above shells out to git — a real yield,
       * of the length a person fits several sentences into. A draft read on the
       * way in and written back on the way out therefore restored the notes and
       * the answers to what they said when the page loaded. Everything from
       * here to the write is synchronous, which is what makes the fallbacks
       * below mean "as it is now" rather than "as it was when this started".
       */
      const existing = store.getDraft(id);

      /*
       * Every other field on a re-opened draft falls back to what is stored;
       * this one did not, so a second post from a page with no form visible —
       * which is an ordinary thing for the extension to do — rewrote the draft
       * with `questions: []` and took every hand-written answer with it.
       */
      const incoming = body.questions ?? existing?.questions ?? [];
      const questions: DraftQuestion[] = incoming.map((q, i) => {
        // Never clobber something a human has already written here.
        const prior = existing?.questions.find((x) => x.question === q.question);
        if (prior?.edited) return { ...prior, required: q.required ?? prior.required };

        /*
         * An answer that came with the request was written by hand somewhere
         * else — in the extension's card, on the page before this one — and
         * beats both the bank and anything stored. The button that sends it
         * says it is handing the questions over; handing them over without the
         * answers meant writing them twice.
         */
        if (q.answer?.trim()) {
          return {
            id: prior?.id ?? `q${i + 1}`,
            question: q.question,
            required: q.required,
            answer: q.answer,
            source: 'human',
            edited: true,
          };
        }

        const match = matchAnswer(q.question, data.answers);
        return {
          id: prior?.id ?? `q${i + 1}`,
          question: q.question,
          required: q.required,
          answer: match.confident ? (match.answer ?? '') : (prior?.answer ?? ''),
          fromAnswerId: match.confident ? match.item?.id : undefined,
          source: match.confident ? 'bank' : 'empty',
        };
      });

      const now = new Date().toISOString();
      const draft: Draft = {
        id,
        company: body.company,
        role: body.role,
        url: body.url ?? existing?.url,
        source: body.source ?? existing?.source,
        jobDescription: body.jobDescription ?? existing?.jobDescription,
        resumeId: body.spec?.id ?? body.resumeId ?? existing?.resumeId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        status: existing?.status ?? 'drafting',
        coverLetter: existing?.coverLetter ?? {
          required: Boolean(body.coverLetterRequired),
          body: '',
        },

        questions,
        notes: existing?.notes,
      };
      if (body.coverLetterRequired !== undefined && !draft.coverLetter.edited) {
        draft.coverLetter.required = body.coverLetterRequired;
      }
      /*
       * A letter written in the card comes with it, and is treated as written
       * by hand — because it was. Only over an empty box: a draft already
       * holding a letter is the one being worked on.
       */
      if (body.coverLetter?.trim() && !draft.coverLetter.body.trim()) {
        draft.coverLetter = { required: true, body: body.coverLetter, edited: true };
      }

      const saved = await withCommit(repo, autoCommit(), `Open workspace for ${draft.company}`, () =>
        store.saveDraft(draft),
      );

      // An application being written is already an application. Track it as
      // "applying" so the tracker shows what is in flight, not only what has
      // been sent — completing the draft moves it to "applied".
      const tracked = data.applications.find((a) => a.id === id);
      if (!tracked) {
        store.upsertApplication({
          id,
          company: draft.company,
          role: draft.role,
          url: draft.url,
          status: 'applying',
          resumeId: draft.resumeId,
          source: draft.source,
          /*
           * Dated, like one made by hand. The tracker sorts on `appliedAt` and
           * prints it as the date column, so an application started from the
           * extension — the one you are working on right now — had a blank date
           * and sat at the bottom of the list, under everything already sent.
           * It is the date it started; `trackStatus` records when it was sent.
           */
          appliedAt: now,
          history: [{ at: now, status: 'applying', note: 'Workspace opened' }],
        });
      }

      res.json({ draft: saved, url: `/#workspace/${encodeURIComponent(saved.id)}` });
    }),
  );

  api.put(
    '/workspace/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      // Addressed by id here, deliberately: this route is editing one known
      // draft, not asking which draft a job has.
      const existing = store.getDraft(id);
      if (!existing) throw new Error(`No draft "${id}"`);

      const patch = req.body as Partial<Draft>;
      const merged: Draft = {
        ...existing,
        ...patch,
        id,
        coverLetter: { ...existing.coverLetter, ...(patch.coverLetter ?? {}) },
        questions: patch.questions ?? existing.questions,
      };
      const saved = await withCommit(repo, autoCommit(), `Update workspace for ${merged.company}`, () =>
        store.saveDraft(merged),
      );
      res.json(saved);
    }),
  );

  api.delete(
    '/workspace/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const removed = await withCommit(repo, autoCommit(), `Discard workspace "${id}"`, () =>
        store.deleteDraft(id),
      );
      if (!removed) throw new Error(`No draft "${id}"`);
      res.json({ ok: true });
    }),
  );

  /**
   * Start a variation for this application, to edit by hand.
   *
   * Tailoring, above, decides for you — by tag match, or by asking the AI. This
   * is the other thing you want while working on an application: a resume of
   * your own that belongs to this posting, inheriting everything from the base
   * so it stays a thin selection rather than a copy that drifts.
   *
   * It is created empty of opinions on purpose. The point is to go and make the
   * decisions in the builder, which is why this hands back where to go.
   */
  api.post(
    '/workspace/:id/variation',
    handler(async (req, res) => {
      const draft = store.getDraft(String(req.params.id));
      if (!draft) throw new Error(`No draft "${String(req.params.id)}"`);

      const { baseResumeId, label } = req.body as { baseResumeId?: string; label?: string };
      const data = store.load();

      // What it inherits from. Never the draft's own tailored copy, or the
      // variation would inherit from a thing it is meant to sit beside.
      let baseId = baseResumeId ?? draft.resumeId ?? defaultBaseId(data.resumes);
      const seen = new Set<string>();
      while (baseId && data.resumes.find((r) => r.id === baseId)?.generatedFor && !seen.has(baseId)) {
        seen.add(baseId);
        baseId = data.resumes.find((r) => r.id === baseId)?.extends ?? defaultBaseId(data.resumes);
      }
      const base = data.resumes.find((r) => r.id === baseId);
      if (!base) throw new Error('The store has no resume to start from');

      // A name you would recognise in a list a month from now, and an id that
      // does not quietly overwrite the last variation made for this posting.
      const wanted = `${slug(draft.company)}-${slug(draft.role)}`.slice(0, 55) || 'variation';
      let id = wanted;
      for (let n = 2; data.resumes.some((r) => r.id === id); n++) id = `${wanted}-${n}`.slice(0, 60);

      const spec: ResumeSpec = {
        id,
        label: label?.trim() || `${draft.role} — ${draft.company}`,
        extends: base.id,
        generatedFor: { url: draft.url, company: draft.company, role: draft.role, at: new Date().toISOString() },
      };

      await withCommit(repo, autoCommit(), `Start a resume variation for ${draft.company}`, () =>
        store.saveResume(spec),
      );

      const saved = await reviseDraft(draft.id, `Attach a variation to ${draft.company}`, (fresh) => {
        fresh.resumeId = spec.id;
      });

      res.json({ draft: saved, spec, url: `/#resumes/${encodeURIComponent(spec.id)}/from/${encodeURIComponent(draft.id)}` });
    }),
  );

  /**
   * Make a resume for this posting, from inside the workspace.
   *
   * The extension does this with the page already in front of it; a draft
   * opened by hand has only a link. So the server fetches the posting itself
   * and runs the identical pipeline — the same extraction, the same matching,
   * the same AI plan if it is enabled — rather than a second, lesser version
   * of it that would drift.
   */
  api.post(
    '/workspace/:id/tailor',
    handler(async (req, res) => {
      const draft = store.getDraft(String(req.params.id));
      if (!draft) throw new Error(`No draft "${String(req.params.id)}"`);

      const { useAi, baseResumeId } = req.body as { useAi?: boolean; baseResumeId?: string };
      const data = store.load();

      // The posting text: fetched from the link when there is one, falling
      // back to whatever the draft already carries.
      let html = draft.jobDescription ?? '';
      let fetched = false;
      if (draft.url) {
        try {
          html = await fetchPosting(draft.url);
          fetched = true;
        } catch (err) {
          // A posting behind a login is common and is not a failure: carry on
          // with whatever text the draft has.
          if (!html) throw new Error(`Could not read ${draft.url}: ${(err as Error).message}`);
        }
      }
      if (!html.trim()) throw new Error('This draft has no link and no posting text to work from');

      const job = extractJob(html, draft.url, `${draft.role} at ${draft.company}`);
      const specId = `job-${slug(draft.company)}-${slug(draft.role)}`.slice(0, 60);

      /*
       * Tailoring twice must not make a resume that inherits from itself. The
       * second run finds the draft already pointing at the tailored copy, so
       * start from what that copy was built on rather than from the copy.
       */
      let baseId = baseResumeId ?? draft.resumeId ?? defaultBaseId(data.resumes);
      if (baseId === specId) {
        baseId = data.resumes.find((r) => r.id === specId)?.extends ?? defaultBaseId(data.resumes);
      }
      const base = data.resumes.find((r) => r.id === baseId);
      if (!base) throw new Error('The store has no resume to start from');

      const match = matchVariants(data, base, { keywords: job.keywords });

      let plan: ReturnType<typeof sanitizeAiPlan> | null = null;
      if (useAi && data.config.ai.enabled) {
        const agent = await runAgent(
          configForTask(data.config, 'tailor'),
          tailorPrompt(data, resolveResume(baseId!, data), {
            jobTitle: draft.role,
            company: draft.company,
            jobDescription: job.description ?? html,
            url: draft.url,
          }),
        );
        try {
          plan = sanitizeAiPlan(extractJson(agent.output), data);
        } catch {
          plan = null; // a malformed reply must not sink the deterministic match
        }
      }

      const finalMatch = plan
        ? { ...match, choices: { ...match.choices, ...plan.choices }, skills: { ...match.skills, ...plan.skills } }
        : match;

      const spec = deriveSpec(base, specId, `${draft.role} — ${draft.company}`, finalMatch, {
        url: draft.url,
        company: draft.company,
        role: draft.role,
      });
      const inclusion = plan ? applyInclusion(base, data, plan) : undefined;
      if (inclusion) {
        const bySkills = new Map((spec.sections ?? []).map((sec) => [sec.kind, sec]));
        spec.sections = inclusion.map((sec) => ({ ...sec, ...(bySkills.get(sec.kind) ?? {}), entries: sec.entries, bullets: sec.bullets }));
      }

      await withCommit(repo, autoCommit(), `Tailor a resume for ${draft.company}`, () => store.saveResume(spec));

      // The draft now sends this one, and keeps the posting text for the
      // letter and the answers to draw on. Those two fields, and nothing else:
      // fetching the posting and running the AI take long enough that the
      // letter and the answers on disk have moved on.
      const description = job.description || html.slice(0, 20_000);
      const saved = await reviseDraft(draft.id, `Attach a tailored resume to ${draft.company}`, (fresh) => {
        fresh.resumeId = spec.id;
        fresh.jobDescription = description;
      });

      const after = store.load();
      res.json({
        draft: saved,
        spec,
        fetched,
        usedAi: Boolean(plan),
        rejected: plan?.rejected ?? [],
        diff: diffResumes(resolveResume(baseId!, data), resolveResume(spec, after), { ignoreLabel: true }),
      });
    }),
  );

  /**
   * Fill in whatever is still empty: the cover letter, the answers, or both.
   * Anything a human has edited is left alone — that is the point of `edited`.
   */
  api.post(
    '/workspace/:id/generate',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const draft = store.getDraft(id);
      if (!draft) throw new Error(`No draft "${id}"`);

      /*
       * What the draft held when the button was pressed. Generation runs the AI
       * once per empty answer and once for the letter, which is minutes, and
       * the person waiting is usually typing in the boxes it is not filling.
       * Comparing against this is what tells "the AI wrote this" apart from
       * "they wrote this while it ran" at the end.
       */
      const before = structuredClone(draft);

      const { what = 'all', force = false, questionId } = req.body as {
        what?: 'letter' | 'questions' | 'all';
        force?: boolean;
        /** Just this one question, rather than every empty answer. */
        questionId?: string;
      };
      const data = store.load();
      const job: TailorContext = {
        company: draft.company,
        jobTitle: draft.role,
        jobDescription: draft.jobDescription ?? '',
        url: draft.url,
      };

      const notes: string[] = [];
      let countAnswers = false;

      /*
       * One run for the whole application, where the CLI can take the tools.
       *
       * This used to be one AI run for the letter and one more for every
       * question — four runs for a form with three, each of them minutes long,
       * and none able to see what the others wrote. Which is how an
       * application ends up saying two different things about why you want the
       * job. The loops below still exist: they are what happens when there are
       * no tools, and they are what fills in anything this run left.
       */
      const canUseTools = canWire(data.config.ai.command) && serverEntry(mcpDir) !== null;
      let written: { letter?: string; answers?: Record<string, string> } | undefined;

      if (canUseTools && data.config.ai.enabled && (what === 'letter' || what === 'questions' || what === 'all')) {
        const resumeId = draft.resumeId ?? data.resumes[0]?.id;
        const wantsLetter = (what === 'letter' || what === 'all') && draft.coverLetter.required
          && (!draft.coverLetter.edited || force);
        const pending = what === 'letter'
          ? []
          : (questionId ? draft.questions.filter((q) => q.id === questionId) : draft.questions)
              .filter((q) => force || Boolean(questionId) || (!q.edited && !q.answer.trim()));

        if (resumeId && (wantsLetter || pending.length > 0)) {
          const resolved = resolveResume(resumeId, data);
          const agent = await runAgent(
            configForTask(data.config, 'write'),
            applicationWritingPrompt(data, resolved, job),
            writingTools(data, resolved, job, {
              coverLetter: { required: wantsLetter, body: draft.coverLetter.body },
              questions: pending,
            }),
          );
          const state = agent.tools as { letter?: string; answers?: Record<string, string> } | undefined;
          if (state?.letter?.trim() || Object.keys(state?.answers ?? {}).length > 0) written = state;
        }
      }

      /*
       * What the letter step says it did, held back until the merge below has
       * decided whether it actually happened. Pushed as it went, the reply read
       * "Cover letter drafted in your voice." immediately above "You edited the
       * cover letter while this was running, so what you wrote was kept" — two
       * sentences in one panel, one of them about a letter that was thrown
       * away.
       */
      const letterNotes: string[] = [];

      if ((what === 'letter' || what === 'all') && draft.coverLetter.required) {
        if (draft.coverLetter.edited && !force) {
          letterNotes.push('Cover letter left alone — you have edited it.');
        } else {
          const resumeId = draft.resumeId ?? data.resumes[0]?.id;
          const prior = relevantLetters(data.coverLetters, { company: draft.company, role: draft.role });
          if (written?.letter?.trim()) {
            draft.coverLetter.body = written.letter.trim();
            letterNotes.push('Cover letter drafted in your voice.');
          } else if (resumeId) {
            const agent = await runAgent(
              configForTask(data.config, 'write'),
              coverLetterPrompt(data, resolveResume(resumeId, data), job, prior),
            );
            if (agent.executed && agent.output.trim()) {
              draft.coverLetter.body = trimToLetter(agent.output);
              letterNotes.push('Cover letter drafted in your voice.');
            } else if (!agent.executed && prior[0]) {
              /*
               * Only when the AI did not run. This branch used to catch an AI
               * that ran and returned nothing as well, so an empty reply
               * silently pasted the letter written to another company into
               * this application — under a note claiming the AI was off, which
               * it was not. `relevantLetters` returns its best three whatever
               * they score, so that company can be entirely unrelated, and
               * "Complete this application" will bundle the result.
               */
              draft.coverLetter.body = prior[0].body;
              letterNotes.push(
                `AI is off — started from your letter to ${prior[0].company ?? 'a previous company'}. ` +
                  'It is addressed to them, so read it before sending.',
              );
            } else if (!agent.executed) {
              letterNotes.push('AI is off and there are no previous letters to start from.');
            } else {
              letterNotes.push('The AI returned nothing, so the letter was left as it was.');
            }
          }
        }
      }

      if (what === 'questions' || what === 'all') {
        /*
         * One question, when asked for one. "Fill in what is empty" is the
         * right bulk action and the wrong one when you are looking at a single
         * answer you want redone — and redoing that one has to be allowed to
         * overwrite it, since you asked.
         */
        const wanted = questionId ? draft.questions.filter((q) => q.id === questionId) : draft.questions;
        if (questionId && wanted.length === 0) throw new Error('That question is not on this application any more');
        const overwrite = force || Boolean(questionId);

        for (const q of wanted) {
          if (q.edited && !overwrite) continue;
          if (q.answer.trim() && q.source === 'bank' && !overwrite) continue;

          const fromTools = written?.answers?.[q.id]?.trim();
          if (fromTools) {
            q.answer = fromTools;
            q.source = 'ai';
            q.needsReview = undefined;
            continue;
          }

          const match = matchAnswer(q.question, data.answers);
          if (match.confident && !overwrite) {
            q.answer = match.answer ?? '';
            q.fromAnswerId = match.item?.id;
            q.source = 'bank';
            q.needsReview = undefined;
            continue;
          }
          const agent = await runAgent(configForTask(data.config, 'write'), answerPrompt(data, q.question, job));
          if (agent.executed && agent.output.trim()) {
            q.answer = agent.output.trim();
            q.source = 'ai';
          } else if (match.item) {
            /*
             * A match that did not clear the confidence line. `matchAnswer`
             * draws that line deliberately — above it the answer is safe to
             * send unread, below it, in its own words, "a starting point the
             * user should read first". It arrived looking exactly like a
             * confident one: filled in, unmarked, and carried into the bundle
             * by "Complete this application" without anyone having read it.
             */
            q.answer = match.answer ?? '';
            q.fromAnswerId = match.item.id;
            q.source = 'bank';
            q.needsReview = true;
          }
        }
        countAnswers = true;
      }

      const saved = await reviseDraft(id, `Draft answers for ${draft.company}`, (fresh) => {
        /*
         * The letter is ours to write only if the box has not moved since we
         * read it. Someone who spent the wait writing their own first paragraph
         * meant it, and an AI draft landing on top of it is the loss this whole
         * merge exists to prevent.
         */
        if (draft.coverLetter.body !== before.coverLetter.body) {
          if (fresh.coverLetter.body !== before.coverLetter.body) {
            notes.push('You edited the cover letter while this was running, so what you wrote was kept.');
          } else {
            fresh.coverLetter.body = draft.coverLetter.body;
            notes.push(...letterNotes);
          }
        } else {
          // Nothing was written, so whatever the step has to say about the
          // letter — left alone, AI off, nothing returned — still stands.
          notes.push(...letterNotes);
        }

        let kept = 0;
        for (const produced of draft.questions) {
          const was = before.questions.find((q) => q.id === produced.id);
          if (!was) continue;
          /*
           * Not "the text changed": the loop above sets `needsReview`,
           * `source` and `fromAnswerId` on their own, and skipping when the
           * text stayed the same dropped exactly those. The case that matters
           * is an answer already holding "Yes." that a loose bank match wants
           * to flag — "are you authorized to work?" answered from "…without
           * sponsorship?" — where the text is identical and the badge saying
           * to read it first is the whole point. Losing it also left `source`
           * at 'ai', so completing filed it into the answer bank as something
           * the user had written.
           */
          const producedSomething =
            produced.answer !== was.answer ||
            produced.source !== was.source ||
            produced.fromAnswerId !== was.fromAnswerId ||
            produced.needsReview !== was.needsReview;
          if (!producedSomething) continue;

          // Questions the application no longer asks are simply gone.
          const target = fresh.questions.find((q) => q.id === produced.id);
          if (!target) continue;
          if (target.answer !== was.answer) {
            kept++;
            continue;
          }
          target.answer = produced.answer;
          target.source = produced.source;
          target.fromAnswerId = produced.fromAnswerId;
          target.needsReview = produced.needsReview;
        }
        if (kept) {
          notes.push(
            kept === 1
              ? 'One answer you typed while this was running was kept as you wrote it.'
              : `${kept} answers you typed while this was running were kept as you wrote them.`,
          );
        }

        if (countAnswers) {
          const written = fresh.questions.filter((q) => q.answer.trim()).length;
          notes.push(
            questionId
              ? `Answer drafted. ${written} of ${fresh.questions.length} questions have one.`
              : `${written} of ${fresh.questions.length} questions have an answer.`,
          );
        }
      });
      res.json({ draft: saved, notes, aiEnabled: data.config.ai.enabled });
    }),
  );

  /**
   * Finish: compile the bundle, file the answers into the application record,
   * and keep anything worth reusing in the answer bank.
   */
  api.post(
    '/workspace/:id/complete',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const draft = store.getDraft(id);
      if (!draft) throw new Error(`No draft "${id}"`);
      if (!draft.resumeId) throw new Error('This draft has no resume attached');

      // `keepDraft` used to be here, asking whether to keep the space open
      // after sending. Every space is kept now, so a caller still sending it
      // is agreeing with what happens anyway.
      const { saveAnswersToBank = true } = req.body as { saveAnswersToBank?: boolean };

      const answered = draft.questions.filter((q) => q.answer.trim());
      const result = await buildBundle(store, {
        company: draft.company,
        role: draft.role,
        url: draft.url,
        resumeId: draft.resumeId,
        source: draft.source,
        coverLetter: draft.coverLetter.required ? draft.coverLetter.body : undefined,
        answers: answered.map((q) => ({ question: q.question, answer: q.answer })),
        notes: draft.notes,
      });

      // The application record carries the answers, so the history shows what
      // was actually said, not merely that something was sent.
      // File the letter in `letters/` too, tagged with the application, so the
      // letters view can be read either as a library or per application.
      let letterId: string | undefined;
      if (draft.coverLetter.required && draft.coverLetter.body.trim()) {
        letterId = `${new Date().toISOString().slice(0, 10)}-${slug(draft.company)}`;
        const letter: CoverLetter = {
          id: letterId,
          title: `${draft.role} — ${draft.company}`,
          company: draft.company,
          role: draft.role,
          createdAt: new Date().toISOString(),
          body: draft.coverLetter.body,
          applicationId: result.application.id,
        };
        store.saveCoverLetter(letter);
      }

      const app = {
        ...result.application,
        answers: answered.map((q) => ({ question: q.question, answer: q.answer })),
        letterId,
      };
      app.history = [
        ...(app.history ?? []),
        {
          at: new Date().toISOString(),
          status: app.status,
          note: `${answered.length} question(s) answered${draft.coverLetter.required ? ', cover letter included' : ''}`,
        },
      ];
      store.upsertApplication(app);

      // Anything written by hand is worth having next time.
      if (saveAnswersToBank) {
        const answers = store.load().answers;
        for (const q of answered) {
          if (q.source === 'bank' && !q.edited) continue;
          const existing = answers.find((a) => a.id === q.fromAnswerId || a.question === q.question);
          if (existing) {
            const vid = `v_${Date.now().toString(36)}`;
            existing.variants.push({ id: vid, label: draft.company, text: q.answer });
            existing.default = vid;
          } else {
            answers.push({
              id: answerId(q.question, answers),
              question: q.question,
              default: 'v_1',
              variants: [{ id: 'v_1', label: draft.company, text: q.answer }],
            });
          }
        }
        store.saveAnswers(answers);
      }

      /*
       * Only the status, never the whole draft: compiling the bundle takes
       * long enough that writing it back would restore whatever the letter
       * said before the LaTeX run, over anything typed since.
       *
       * And the same reasoning forbids the delete. The Workspace stays live
       * while the bundle compiles and saves what is typed into it, so a draft
       * read before the compile and unlinked after it takes those edits with
       * it — into no file, no bundle and no application record, since all of
       * those were built from the copy that was read first. When that has
       * happened, the draft stays, marked submitted, and the reply says why.
       */
      const warnings: string[] = [];
      const typedSince = changedText(store.getDraft(id), draft);
      /*
       * Marked, never deleted — `keepDraft` is now what it always was for the
       * caller that asked, and the default as well.
       *
       * Sending it used to close the space, which is the harsher reading of
       * "finished": the letter and the answers went behind a tracker row, and
       * going back to them for the follow-up meant reading a snapshot rather
       * than opening the thing you wrote. It stays, below the live ones, and
       * `retireStaleDrafts` lets it go two weeks later if nobody comes back.
       */
      await reviseDraft(id, `Mark ${draft.company} as submitted`, (fresh) => {
        fresh.status = 'submitted';
      });
      if (typedSince.length) {
        warnings.push(
          `The ${typedSince.join(' and ')} changed while this was compiling, so what was sent does ` +
            'not include it. The application is kept open with your latest text — read it, then ' +
            'complete it again to send that version.',
        );
      }

      if (autoCommit()) await repo.commitAll(`Apply: ${draft.company} — ${draft.role}`);
      res.json({
        warnings,
        application: app,
        dir: result.dir,
        currentDir: syncCurrent(store).dir,
        files: result.files,
        fits: result.fits,
        pages: result.pages,
      });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Cover letters and answers                                         *
   * ---------------------------------------------------------------- */

  api.get(
    '/letters',
    handler(async (_req, res) => res.json(store.loadCoverLetters())),
  );

  api.put(
    '/letters/:id',
    handler(async (req, res) => {
      const letter = {
        ...(req.body as { title: string; body: string }),
        id: String(req.params.id),
        createdAt: (req.body as { createdAt?: string }).createdAt ?? new Date().toISOString(),
      };
      await withCommit(repo, autoCommit(), `Update cover letter "${letter.id}"`, () =>
        store.saveCoverLetter(letter),
      );
      res.json(letter);
    }),
  );

  api.put(
    '/answers',
    handler(async (req, res) => {
      const answers = req.body as Parameters<typeof store.saveAnswers>[0];
      // A cast is not a check. Sending `{}` here wrote an object into
      // answers.yaml, which reads back as an empty list — the whole answer
      // bank gone, with a 200 and nothing said.
      if (!Array.isArray(answers)) throw new Error('The answer bank has to be a list of answers');
      await withCommit(repo, autoCommit(), 'Update answer bank', () => store.saveAnswers(answers));
      res.json(answers);
    }),
  );

  /* ---------------------------------------------------------------- *
   * History                                                           *
   * ---------------------------------------------------------------- */

  api.get(
    '/history',
    handler(async (req, res) => {
      const limit = Number(req.query.limit ?? 60);
      res.json({ commits: await repo.log(Number.isFinite(limit) ? limit : 60) });
    }),
  );

  /** One commit in full: what it touched and the patch, for the history view. */
  api.get(
    '/history/:hash',
    handler(async (req, res) => {
      const hash = String(req.params.hash);
      if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) throw new Error(`"${hash}" is not a commit hash`);
      const detail = await repo.commit(hash);
      if (!detail) throw new Error(`No commit "${hash}" in the store's history`);
      res.json(detail);
    }),
  );

  /**
   * A resume's own timeline: every version of the *document*, and what changed
   * between them, the way a Google Docs history reads.
   *
   * Two things make this a document history rather than a file history.
   *
   * First, each version is resolved against the whole store as it was at that
   * commit — the bullets, the dates, the resume it inherits from — so a
   * version is what the PDF said, not what `resumes/<id>.yaml` said. Editing a
   * bullet's wording in `experience.yaml` changes this resume even though its
   * own file never moved, and that has to show up here.
   *
   * Second, a commit that leaves this resume's document identical (a change to
   * a different resume, a cover letter, an application) produces no version at
   * all. A history full of "no change" entries is a file log wearing a
   * document's clothes.
   */
  api.get(
    '/resumes/:id/history',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const want = Number(req.query.limit) || 30;

      // Every commit is a candidate: any of the store's content files can
      // change this resume. Scan a generous window and keep the ones that
      // actually moved the document.
      const commits = await repo.log(Math.min(Math.max(want * 4, 60), 300));
      if (commits.length === 0) {
        res.json({ versions: [] });
        return;
      }

      // A commit's contents cannot change, so the document it produced cannot
      // either: resolving one is worth doing exactly once per process. The
      // first visit to a long history pays; every visit after it is free.
      const live = store.load();

      // Blobs are content-addressed, so the same unchanged file across fifty
      // commits is read exactly once.
      const blobs = new Map<string, string>();
      const readSnapshot = async (hash: string): Promise<StoreSnapshot | undefined> => {
        const tree = await repo.treeAt(hash);
        const files = new Map<string, string>();
        for (const [file, objectId] of tree) {
          if (!isSnapshotFile(file)) continue;
          let text = blobs.get(objectId);
          if (text === undefined) {
            text = await repo.blob(objectId);
            blobs.set(objectId, text);
          }
          files.set(file, text);
        }
        return files.size === 0 ? undefined : parseSnapshot(files);
      };

      // Oldest first, so each version is diffed against the one before it.
      const chronological = [...commits].reverse();
      const versions: unknown[] = [];
      let previous: ResolvedResume | undefined;

      for (const c of chronological) {
        const key = `${id}@${c.hash}`;
        let resolved = documentCache.get(key);

        if (resolved === undefined) {
          const snapshot = await readSnapshot(c.hash);
          try {
            // `null` is a real answer — the resume did not exist yet, or was
            // broken at this commit — and worth remembering as one.
            resolved = snapshot ? resolveResume(id, { ...live, ...snapshot }) : null;
          } catch {
            resolved = null;
          }
          rememberDocument(key, resolved);
        }
        if (!resolved) continue;

        // Unchanged document: not a version of this resume.
        if (previous && sameDocument(previous, resolved)) continue;

        versions.push({
          hash: c.hash,
          date: c.date,
          message: c.message,
          label: resolved.label,
          changes: diffResumes(previous, resolved),
        });
        previous = resolved;
      }

      // Newest first for display.
      res.json({ versions: versions.slice(-want).reverse() });
    }),
  );

  /** Roll a resume back to exactly what it was at one of its past versions. */
  api.post(
    '/resumes/:id/history/:hash/restore',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const hash = String(req.params.hash);

      /*
       * A version is the whole resolved document, not one file.
       *
       * The timeline defines a version as what this resume *said* at a commit,
       * which is the resume file, everything it inherits, and the shared text
       * it points at — profile.yaml, the entry files, skills.yaml. Restore read
       * back only `resumes/<id>.yaml`, so every version whose change lived in a
       * shared bullet restored nothing at all: 200 OK, "Restored." on screen,
       * the document unchanged, and not even a commit in the timeline to show
       * for it.
       *
       * What is restored is this resume's own file, and nothing else. Anything
       * it inherits belongs to every other resume too, and silently rewriting
       * those is worse than not restoring: this used to walk the whole
       * `extends` chain and write every ancestor back at the old commit's
       * content, so rolling one tailored variation back to last week's version
       * also rolled `base` back — and with it every other variation that
       * inherits from `base`. A week of work on the shared resume, gone, under
       * a confirmation that said only "the current version will be replaced"
       * and a reply carrying no warnings, because the check below re-resolves
       * the restored resume, which of course now matches.
       *
       * So the result is checked against the version that was asked for, and
       * whatever still differs is named rather than forced.
       */
      const tree = await repo.treeAt(hash);
      const readAt = async (file: string): Promise<string | undefined> => {
        const objectId = tree.get(file);
        return objectId === undefined ? undefined : repo.blob(objectId);
      };

      const text = await readAt(path.posix.join('resumes', `${id}.yaml`));
      const restored = text === undefined ? undefined : (YAML.parse(text) as ResumeSpec | null);
      if (!restored) {
        throw new Error(`Could not read "${id}" as it was at ${hash.slice(0, 8)}`);
      }
      restored.id = id; // the filename remains the source of truth for the id

      await withCommit(repo, autoCommit(), `Restore "${id}" to an earlier version`, () =>
        store.saveResume(restored),
      );

      /*
       * Did it land? Compare what the resume resolves to now against what it
       * resolved to then. When the two differ, the remainder of that version
       * lives in text this resume shares with others, and saying so beats
       * reporting a rollback that only half happened.
       */
      const warnings: string[] = [];
      try {
        const files = new Map<string, string>();
        for (const [file, objectId] of tree) {
          if (isSnapshotFile(file)) files.set(file, await repo.blob(objectId));
        }
        const live = store.load();
        const then = resolveResume(id, { ...live, ...parseSnapshot(files) });
        const now = resolveResume(id, store.load());
        if (!sameDocument(then, now)) {
          warnings.push(
            'Some of that version is in things this resume shares with others — a bullet, a date, ' +
              'your profile, or the resume this one is built on — so they were left alone rather ' +
              'than changed for every resume at once.',
          );
          for (const change of diffResumes(now, then).slice(0, 8)) warnings.push(change.text);
        }
      } catch {
        // The comparison is a courtesy; failing it must not fail the restore.
      }

      // saveResume() returns nothing, so the response is built from the spec
      // itself — the caller wants to know what it was just rolled back to.
      res.json({ ...restored, warnings });
    }),
  );

  return api;
}


/*
 * An id for a question, unique within the bank.
 *
 * `ans_${slug(question).slice(0, 40)}` gave two different questions the same id
 * whenever their first forty characters slugged alike — which is exactly what
 * happens to a question and the same question with a qualifier on the end:
 * "Are you legally authorized to work in the United States?" and "…without
 * sponsorship?" both became `ans_are-you-legally-authorized-to-work-in-th`.
 * Every lookup uses `find`, so the second was unreachable, and editing it
 * rewrote the first — after which /autofill handed the browser extension
 * "No — I need sponsorship" as the answer to "are you authorized to work".
 */
function answerId(question: string, taken: AnswerBankItem[]): string {
  const base = `ans_${slug(question).slice(0, 40)}`;
  if (base === 'ans_') return `ans_${fingerprint(question)}`;
  return taken.some((a) => a.id === base) ? `${base}-${fingerprint(question)}` : base;
}

/**
 * The flat folder, as a page you can open.
 *
 * The path to it has always been printed — in the editor, and in the browser
 * extension's card next to a button that copies it. Printing a path is the
 * right answer for the file dialog, which takes one typed or pasted, and no
 * answer at all for the rest of the time: from a job board, in a browser, the
 * folder is a string you cannot click. `file://` is not the way out either;
 * an extension cannot navigate a tab to one without a permission nobody
 * should grant to read their own resume.
 *
 * So the folder is served. One page, listing what is in it, each file opening
 * in the browser that is already in front of you, and the real path at the
 * top for the dialog. It is deliberately not the editor: this is the thing
 * you look at with a portal's upload box open.
 */
export function createCurrentRouter(store: Store): Router {
  const router = express.Router();

  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const size = (bytes: number): string =>
    bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;

  router.get('/', (_req, res) => {
    const folder = syncCurrent(store);
    const rows = folder.files
      .map((name) => {
        let bytes = 0;
        try {
          bytes = fs.statSync(path.join(folder.dir, name)).size;
        } catch {
          // Removed between the listing and the stat: show it without a size
          // rather than failing the page over one file.
        }
        return `<li><a href="/current/${encodeURIComponent(name)}" target="_blank" rel="noopener">${escape(name)}</a>
          <span class="size">${bytes ? size(bytes) : ''}</span></li>`;
      })
      .join('\n');

    const empty =
      folder.inFlight > 0
        ? 'Nothing built yet. Build an application and its files land here.'
        : 'Nothing is mid-application, so there is nothing to upload.';

    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ready to upload</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 32px; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.where { color: #6b6b76; margin: 0 0 14px; }
  .strip { display: flex; gap: 12px; align-items: center; background: #f6f6f8; border-radius: 8px; padding: 8px 12px; margin-bottom: 20px; }
  code { flex: 1; font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; color: #4a4a55; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; gap: 12px; align-items: baseline; padding: 10px 12px; border: 1px solid #e3e3e8; border-radius: 8px; margin-bottom: 8px; }
  li a { flex: 1; text-decoration: none; color: #1a56db; }
  li a:hover { text-decoration: underline; }
  .size { color: #8a8a94; font-size: 13px; }
  .empty { color: #6b6b76; border: 1px dashed #d8d8de; border-radius: 8px; padding: 20px; text-align: center; }
  button { font: inherit; padding: 4px 10px; border: 1px solid #d8d8de; border-radius: 6px; background: #fff; cursor: pointer; }
</style></head>
<body><main>
  <h1>Ready to upload</h1>
  <p class="where">Everything for the ${folder.applications === 1 ? 'application' : `${folder.applications} applications`}
    still being sent, in one folder, already named.</p>
  <div class="strip"><code id="path">${escape(folder.dir)}</code><button id="copy">Copy the path</button></div>
  ${rows ? `<ul>${rows}</ul>` : `<div class="empty">${empty}</div>`}
</main>
<script>
  document.getElementById('copy').onclick = async (ev) => {
    await navigator.clipboard.writeText(document.getElementById('path').textContent);
    ev.target.textContent = 'Copied';
  };
</script>
</body></html>`);
  });

  router.get('/:name', (req, res) => {
    const folder = path.join(store.outDir(), CURRENT_DIR);
    const name = path.basename(String(req.params.name));
    const file = path.join(folder, name);
    if (!file.startsWith(folder) || !fs.existsSync(file)) {
      res.status(404).type('html').send('<p>That file is not in the folder any more.</p>');
      return;
    }
    // Inline, because the point is to look at it: a PDF opens in the viewer
    // and a .txt cover letter opens as text, both in the tab.
    if (name.toLowerCase().endsWith('.pdf')) res.type('application/pdf');
    else if (name.toLowerCase().endsWith('.txt')) res.type('text/plain; charset=utf-8');
    res.sendFile(file);
  });

  return router;
}

/** Serve generated PDFs, constrained to the output directory. */
export function createPdfRouter(store: Store): Router {
  const router = express.Router();
  router.get('/:name', (req, res) => {
    const name = path.basename(String(req.params.name));
    const file = path.join(store.outDir(), name);
    if (!file.startsWith(store.outDir()) || !fs.existsSync(file)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.type('application/pdf').sendFile(file);
  });
  return router;
}
