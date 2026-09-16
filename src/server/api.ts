import express, { type Request, type Response, type Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { runAgent, extractJson, trimToLetter, AgentError } from '../ai/agent.js';
import {
  answerPrompt,
  bulletFeedbackPrompt,
  coverLetterPrompt,
  feedbackPrompt,
  shortenPrompt,
  tailorPrompt,
  type TailorContext,
} from '../ai/prompts.js';
import { AI_PRESETS } from '../ai/presets.js';
import { buildVoiceContext, renderVoiceContext } from '../ai/voice.js';
import { ingestFile } from '../ingest/index.js';
import { Repo, withCommit } from '../git/repo.js';
import { saveStore } from '../git/save.js';
import { matchAnswer, matchAnswers, relevantLetters, letterId } from '../jobs/answers.js';
import { classifyPage, extractJob, JOB_SHAPED, mergeJobPages, type PageSource } from '../jobs/extract.js';
import { applyInclusion, sanitizeAiPlan } from '../jobs/aiPlan.js';
import { deriveSpec, matchVariants } from '../jobs/match.js';
import { advance, applicationId, buildBundle, slug, stats } from '../model/applications.js';
import { byBaseFirst, defaultBaseId } from '../model/bases.js';
import { syncCurrent } from '../model/current.js';
import { diffResumes, sameDocument } from '../model/diff.js';
import { isSnapshotFile, parseSnapshot, type StoreSnapshot } from '../model/snapshot.js';
import { buildMaster, resolveResume } from '../model/resolve.js';
import type { Store } from '../model/store.js';
import { DEFAULT_LAYOUT, isVariantField } from '../model/types.js';
import type {
  Application,
  CoverLetter,
  Draft,
  DraftQuestion,
  Entry,
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
    });
  };
}

export interface ApiDeps {
  store: Store;
  repo: Repo;
}

export function createApi({ store, repo }: ApiDeps): Router {
  const api = express.Router();
  api.use(express.json({ limit: '32mb' }));

  const autoCommit = () => store.loadConfig().git.autoCommit;
  // Work the user started and walked away from.
  const jobs = new Jobs();

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
   * copy of a fact about three external programs — a preset fixed in one place
   * and not the other is how a config ends up broken.
   */
  api.get('/ai/presets', handler(async (_req, res) => res.json({ presets: AI_PRESETS })));

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
      const body = req.body as { resumeId?: string; spec?: ResumeSpec; master?: boolean; strict?: boolean };
      const data = store.load();

      const resolved = body.master
        ? buildMaster(data)
        : body.spec
          ? resolveResume({ ...body.spec, id: body.spec.id ?? '__preview__' }, { ...data, resumes: [...data.resumes, { ...body.spec, id: body.spec.id ?? '__preview__' }] })
          : resolveResume(String(body.resumeId), data);

      const name = body.master ? 'master' : (body.resumeId ?? body.spec?.id ?? 'preview');
      const pdfPath = path.join(store.outDir(), `${slug(name) || 'preview'}.pdf`);

      const result = await compileResume(resolved, {
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
      // pair looks like one document rather than two.
      const layout = body.resumeId
        ? resolveResume(String(body.resumeId), data).layout
        : DEFAULT_LAYOUT;

      const result = await compileLetter(
        {
          profile: data.profile,
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
      const { resumeId, focus, bulletId, entryId, background } = req.body as {
        resumeId?: string;
        focus?: string;
        bulletId?: string;
        entryId?: string;
        /** Return a job to collect later instead of holding the request open. */
        background?: boolean;
      };
      const data = store.load();

      let prompt: string;
      let about: string;
      if (bulletId && entryId) {
        const entry = data.entries.find((e) => e.id === entryId);
        const bullet = entry?.bullets?.find((b) => b.id === bulletId);
        if (!entry || !bullet) throw new Error(`No bullet "${bulletId}" on entry "${entryId}"`);
        prompt = bulletFeedbackPrompt(data, entry, bullet);
        about = typeof entry.title === 'string' ? entry.title : 'a bullet point';
      } else {
        const resolved = resolveResume(String(resumeId), data);
        about = resolved.label;

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
            pdfPath: path.join(store.outDir(), `${slug(resolved.id) || 'resume'}.pdf`),
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
        const job = jobs.start('feedback', about, () => runAgent(data.config, prompt));
        res.json({ job });
        return;
      }

      const result = await runAgent(data.config, prompt);
      res.json(result);
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
      const result = await runAgent(data.config, tailorPrompt(data, resolved, job));
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
      const result = await runAgent(data.config, shortenPrompt(data, bullets, linesToCut ?? 2));
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
        data.config,
        coverLetterPrompt(data, resolved, job, prior),
      );

      // Models sometimes introduce the letter before writing it. The letter
      // starts at its salutation, so that is where it is taken from.
      const body = result.executed ? trimToLetter(result.output) : '';
      let saved: CoverLetter | undefined;
      if (save && body.trim()) {
        saved = {
          id: letterId(job.company, job.jobTitle),
          title: `${job.jobTitle ?? 'Role'} — ${job.company ?? 'Unknown'}`,
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
      const { questions, threshold } = req.body as { questions: string[]; threshold?: number };
      if (!Array.isArray(questions)) throw new Error('questions must be an array');
      const data = store.load();
      res.json({
        matches: matchAnswers(questions, data.answers, threshold),
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

      const result = await runAgent(data.config, answerPrompt(data, question, job));
      res.json({ ...result, source: result.executed ? 'ai' : 'prompt', match });
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
          id: `ans_${slug(question).slice(0, 40) || Date.now()}`,
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
      const { url, title, html, pages, baseResumeId, useAi } = req.body as {
        url?: string;
        title?: string;
        html?: string;
        /** Every page of this application, oldest first. */
        pages?: PageSource[];
        baseResumeId?: string;
        useAi?: boolean;
      };

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
      const score = Math.max(verdict.score, ...trail.map((p) => classifyPage(p.html, p.url).score));

      const baseId = baseResumeId ?? defaultBaseId(data.resumes);
      if (!baseId) throw new Error('The store has no resumes to start from');
      const base = data.resumes.find((r) => r.id === baseId);
      if (!base) throw new Error(`No resume "${baseId}"`);

      const match = matchVariants(data, base, { keywords: job.keywords });

      let aiParsed: unknown = null;
      let aiRaw: string | undefined;
      if (useAi && data.config.ai.enabled) {
        const resolved = resolveResume(baseId, data);
        const agent = await runAgent(
          data.config,
          tailorPrompt(data, resolved, {
            jobTitle: job.title,
            company: job.company,
            jobDescription: job.description,
            url,
          }),
        );
        aiRaw = agent.output;
        try {
          aiParsed = extractJson(agent.output);
        } catch {
          // A malformed AI reply must not sink the deterministic proposal.
          aiParsed = null;
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

      const specId = `job-${slug(job.company ?? 'unknown')}-${slug(job.title ?? 'role')}`.slice(0, 60);
      const spec = deriveSpec(base, specId, `${job.title ?? 'Role'} — ${job.company ?? 'Unknown'}`, finalMatch, {
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
        isJobPosting: verdict.kind !== 'none' || score >= JOB_SHAPED,
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
        aiRaw: aiParsed ? undefined : aiRaw,
      });
    }),
  );

  /** Everything the extension needs to fill a form without asking again. */
  api.get(
    '/autofill',
    handler(async (_req, res) => {
      const data = store.load();
      const p = data.profile;
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

      const dir = app.snapshotDir ? path.join(store.outDir(), app.snapshotDir) : undefined;
      const files =
        dir && fs.existsSync(dir)
          ? fs
              .readdirSync(dir, { withFileTypes: true })
              .filter((e) => e.isFile())
              .map((e) => e.name)
          : [];

      res.json({
        application: app,
        resume: app.resumeId ? (store.getResume(app.resumeId) ?? null) : null,
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
      // The same files also go to the flat folder, which is the one a portal's
      // file picker should be pointed at — the archive is for later.
      const current = syncCurrent(store);
      if (autoCommit()) await repo.commitAll(`Apply: ${result.application.company} — ${result.application.role}`);
      res.json({ ...result, currentDir: current.dir });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Workspace — applications in progress                              *
   * ---------------------------------------------------------------- */

  api.get(
    '/workspace',
    handler(async (_req, res) => res.json({ drafts: store.loadDrafts() })),
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
        questions?: { question: string; required?: boolean }[];
      };
      if (!body.company || !body.role) throw new Error('company and role are required');

      const data = store.load();
      const id = applicationId(body.company, body.role);
      const existing = store.getDraft(id);

      // A posting-specific resume comes over with the draft; save it so the
      // draft refers to something that still exists later.
      if (body.spec) {
        const spec = body.spec;
        await withCommit(repo, autoCommit(), `Add tailored resume "${spec.id}"`, () => store.saveResume(spec));
      }

      const incoming = body.questions ?? [];
      const questions: DraftQuestion[] = incoming.map((q, i) => {
        // Never clobber something a human has already written here.
        const prior = existing?.questions.find((x) => x.question === q.question);
        if (prior?.edited) return { ...prior, required: q.required ?? prior.required };

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
          data.config,
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
      // letter and the answers to draw on.
      draft.resumeId = spec.id;
      draft.jobDescription = job.description || html.slice(0, 20_000);
      draft.updatedAt = new Date().toISOString();
      store.saveDraft(draft);

      const after = store.load();
      res.json({
        draft,
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

      const { what = 'all', force = false } = req.body as { what?: 'letter' | 'questions' | 'all'; force?: boolean };
      const data = store.load();
      const job: TailorContext = {
        company: draft.company,
        jobTitle: draft.role,
        jobDescription: draft.jobDescription ?? '',
        url: draft.url,
      };

      const notes: string[] = [];

      if ((what === 'letter' || what === 'all') && draft.coverLetter.required) {
        if (draft.coverLetter.edited && !force) {
          notes.push('Cover letter left alone — you have edited it.');
        } else {
          const resumeId = draft.resumeId ?? data.resumes[0]?.id;
          const prior = relevantLetters(data.coverLetters, { company: draft.company, role: draft.role });
          if (resumeId) {
            const agent = await runAgent(
              data.config,
              coverLetterPrompt(data, resolveResume(resumeId, data), job, prior),
            );
            if (agent.executed && agent.output.trim()) {
              draft.coverLetter.body = trimToLetter(agent.output);
              notes.push('Cover letter drafted in your voice.');
            } else if (prior[0]) {
              draft.coverLetter.body = prior[0].body;
              notes.push(`AI is off — started from your letter to ${prior[0].company ?? 'a previous company'}.`);
            } else {
              notes.push('AI is off and there are no previous letters to start from.');
            }
          }
        }
      }

      if (what === 'questions' || what === 'all') {
        for (const q of draft.questions) {
          if (q.edited && !force) continue;
          if (q.answer.trim() && q.source === 'bank' && !force) continue;

          const match = matchAnswer(q.question, data.answers);
          if (match.confident && !force) {
            q.answer = match.answer ?? '';
            q.fromAnswerId = match.item?.id;
            q.source = 'bank';
            continue;
          }
          const agent = await runAgent(data.config, answerPrompt(data, q.question, job));
          if (agent.executed && agent.output.trim()) {
            q.answer = agent.output.trim();
            q.source = 'ai';
          } else if (match.item) {
            q.answer = match.answer ?? '';
            q.fromAnswerId = match.item.id;
            q.source = 'bank';
          }
        }
        const written = draft.questions.filter((q) => q.answer.trim()).length;
        notes.push(`${written} of ${draft.questions.length} questions have an answer.`);
      }

      const saved = await withCommit(repo, autoCommit(), `Draft answers for ${draft.company}`, () =>
        store.saveDraft(draft),
      );
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

      const { saveAnswersToBank = true, keepDraft = false } = req.body as {
        saveAnswersToBank?: boolean;
        keepDraft?: boolean;
      };

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
              id: `ans_${slug(q.question).slice(0, 40) || Date.now()}`,
              question: q.question,
              default: 'v_1',
              variants: [{ id: 'v_1', label: draft.company, text: q.answer }],
            });
          }
        }
        store.saveAnswers(answers);
      }

      if (keepDraft) {
        store.saveDraft({ ...draft, status: 'submitted' });
      } else {
        store.deleteDraft(id);
      }

      if (autoCommit()) await repo.commitAll(`Apply: ${draft.company} — ${draft.role}`);
      res.json({
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
      const relPath = path.posix.join('resumes', `${id}.yaml`);

      let spec: ResumeSpec;
      try {
        spec = YAML.parse(await repo.show(hash, relPath)) as ResumeSpec;
      } catch {
        throw new Error(`Could not read "${id}" as it was at ${hash.slice(0, 8)}`);
      }
      spec.id = id; // the filename remains the source of truth for the id

      // saveResume() returns nothing, so the response is built from `spec`
      // itself — the caller wants to know what it was just rolled back to.
      await withCommit(repo, autoCommit(), `Restore "${id}" to an earlier version`, () => store.saveResume(spec));
      res.json(spec);
    }),
  );

  return api;
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
