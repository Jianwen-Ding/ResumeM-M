import express, { type Request, type Response, type Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, extractJson, AgentError } from '../ai/agent.js';
import {
  answerPrompt,
  bulletFeedbackPrompt,
  coverLetterPrompt,
  feedbackPrompt,
  shortenPrompt,
  tailorPrompt,
  type TailorContext,
} from '../ai/prompts.js';
import { Repo, withCommit } from '../git/repo.js';
import { matchAnswer, matchAnswers, relevantLetters, letterId } from '../jobs/answers.js';
import { extractJob, jobPostingScore } from '../jobs/extract.js';
import { deriveSpec, matchVariants } from '../jobs/match.js';
import { advance, applicationId, buildBundle, slug, stats } from '../model/applications.js';
import { buildMaster, resolveResume } from '../model/resolve.js';
import type { Store } from '../model/store.js';
import { isVariantField } from '../model/types.js';
import type {
  Application,
  CoverLetter,
  Entry,
  Profile,
  ResumeSpec,
  SkillGroup,
  StoreData,
  Variant,
  VariantField,
} from '../model/types.js';
import { compileResume, OverflowError } from '../render/compile.js';

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

  api.get(
    '/resumes',
    handler(async (_req, res) => res.json(store.loadResumes())),
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
      await withCommit(repo, autoCommit(), `Update resume "${spec.id}"`, () => store.saveResume(spec));
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
      await withCommit(repo, autoCommit(), 'Update profile', () => store.saveProfile(profile));
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

  api.put(
    '/config',
    handler(async (req, res) => {
      const patch = req.body as Parameters<typeof store.saveConfig>[0];
      const saved = await withCommit(repo, autoCommit(), 'Update settings', () => store.saveConfig(patch));
      res.json(saved);
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

  api.get(
    '/voice',
    handler(async (_req, res) => res.json({ voice: store.loadVoice() })),
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
      });

      res.json({
        pages: result.pages,
        fits: result.fits,
        overflowPt: result.overflowPt,
        overflowLines: result.overflowLines,
        usedPt: result.usedPt,
        availablePt: result.availablePt,
        adjustments: result.adjustments,
        engine: result.engine,
        warnings: result.warnings,
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
      const { resumeId, focus, bulletId, entryId } = req.body as {
        resumeId?: string;
        focus?: string;
        bulletId?: string;
        entryId?: string;
      };
      const data = store.load();

      let prompt: string;
      if (bulletId && entryId) {
        const entry = data.entries.find((e) => e.id === entryId);
        const bullet = entry?.bullets?.find((b) => b.id === bulletId);
        if (!entry || !bullet) throw new Error(`No bullet "${bulletId}" on entry "${entryId}"`);
        prompt = bulletFeedbackPrompt(data, entry, bullet);
      } else {
        prompt = feedbackPrompt(data, resolveResume(String(resumeId), data), focus);
      }

      const result = await runAgent(data.config, prompt);
      res.json(result);
    }),
  );

  api.post(
    '/ai/tailor',
    handler(async (req, res) => {
      const { resumeId, job } = req.body as { resumeId: string; job: TailorContext };
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
        coverLetterPrompt(data, resolved, job, prior.map((l) => l.body)),
      );

      const body = result.executed ? result.output : '';
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
      const { url, title, html, baseResumeId, useAi } = req.body as {
        url?: string;
        title?: string;
        html: string;
        baseResumeId?: string;
        useAi?: boolean;
      };
      if (!html) throw new Error('No page HTML supplied');

      const data = store.load();
      const job = extractJob(html, url, title);
      const score = jobPostingScore(html, url);

      const baseId = baseResumeId ?? data.resumes.find((r) => r.id === 'newgrad')?.id ?? data.resumes[0]?.id;
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

      const merged = aiParsed as { choices?: Record<string, string>; skills?: Record<string, string[]> } | null;
      const finalMatch = merged
        ? {
            ...match,
            choices: { ...match.choices, ...(merged.choices ?? {}) },
            skills: { ...match.skills, ...(merged.skills ?? {}) },
          }
        : match;

      const specId = `job-${slug(job.company ?? 'unknown')}-${slug(job.title ?? 'role')}`.slice(0, 60);
      const spec = deriveSpec(base, specId, `${job.title ?? 'Role'} — ${job.company ?? 'Unknown'}`, finalMatch, {
        url,
        company: job.company,
        role: job.title,
      });

      res.json({
        isJobPosting: score >= 4,
        score,
        job,
        baseResumeId: baseId,
        spec,
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
      res.json({ applications: apps, stats: stats(apps) });
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
      if (autoCommit()) await repo.commitAll(`Apply: ${result.application.company} — ${result.application.role}`);
      res.json(result);
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
