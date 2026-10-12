import express, { type Request, type Response, type Router } from 'express';
import contentDisposition from 'content-disposition';
import { extractText } from '../ingest/text.js';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { runAgent, extractJson, trimToLetter, AgentError, type AgentFailure } from '../ai/agent.js';
import { findRun, recentRuns, running, type AiRun } from '../ai/activity.js';
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
  type FeedbackContext,
  type TailorContext,
} from '../ai/prompts.js';
import { commandToAsk, listModels } from '../ai/models.js';
import { AI_PRESETS, AI_TASKS, configForTask, researchIsOurs } from '../ai/presets.js';
import { canWire, serverEntry, wireUp } from '../mcp/launch.js';
import { sessionResume, tailorData, writingData } from '../mcp/session-data.js';
import { readState } from '../mcp/main.js';
import type { SessionState } from '../mcp/session.js';
import type { AuthoringState } from '../mcp/authoring.js';
import { buildVoiceContext, renderVoiceContext } from '../ai/voice.js';
import { ingestFile } from '../ingest/index.js';
import { GitBusyError, Repo, commitQuietly, removeWhatIsFiled, withCommit } from '../git/repo.js';
import { saveStore } from '../git/save.js';
import { matchAnswer, matchAnswers, relevantLetters, letterId, isSensitiveQuestion, isSensitiveAnswer, sameQuestion, tidyQuestion, fileSentAnswer, newVariantId } from '../jobs/answers.js';
import { UNKNOWN_COMPANY, classifyPage, employerOrUnknown, extractJob, looksLikeAnApplication, mergeJobPages, unnamedRole, type PageSource } from '../jobs/extract.js';
import { jobNumberIn, withRequisition } from '../jobs/names.js';
import {
  applyInclusion,
  sanitizeAiPlan,
  sanitizeSuggestions,
  skillsInBaseOrder,
  skillsOnThePage,
  skillsSectionOf,
} from '../jobs/aiPlan.js';
import { fitResumes, forgetPrintedText, recommend } from '../jobs/fit.js';
import { detectLevel } from '../jobs/level.js';
import { deriveSpec, matchVariants, withYourTerms } from '../jobs/match.js';
import { AlreadySent, advance, localDay, alreadySent, buildBundle, refusedAsSent, closedAsStale, sameAddress, draftForJob, findApplication, findDraft, fingerprint, freshApplicationId, identity, liveOneSent, sameIdentity, slug, stats, tailoredResumeId } from '../model/applications.js';
import { derivedAutofill, educationHistory, preferredName, workHistory } from '../model/autofill.js';
import { baseForCopy, byBaseFirst, copyIdFor, defaultBaseId, standingBase } from '../model/bases.js';
import { flattenOne } from '../model/flatten.js';
import { sweepTemporary, temporaryDays, wouldSweep } from './sweep.js';
import { FRAME_ANCESTORS } from './guard.js';
import { syncCurrent, currentDir, CURRENT_DIR, STANDING } from '../model/current.js';
import { diffResumes, sameDocument } from '../model/diff.js';
import { formatPeriod, inferStyle, parsePeriod, type Period } from '../model/period.js';
import { readSnapshot, type ParsedYaml, type StoreSnapshot } from '../model/snapshot.js';
import { buildMaster, PROFILE_NAME_KEY, resolveProfile, resolveResume } from '../model/resolve.js';
import { readRepo } from '../ingest/repo.js';
import { Store, aiSwitchedOff, withoutBom } from '../model/store.js';
import { isVariantField, layoutFor, RESUME_TIERS, tierOf, type ResumeTier } from '../model/types.js';
import { wentOut } from '../model/tiers.js';
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
  SectionSpec,
  SkillGroup,
  StoreData,
  Variant,
  VariantField,
  WritingSample,
} from '../model/types.js';
import { compileLetter, compileResume, OverflowError } from '../render/compile.js';
import { namePlaceholders, placeholdersIn } from '../model/placeholders.js';
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

    /*
     * Read up to the cap and no further. `res.text()` read the whole body
     * before it was cut, so a link that streamed without end held the request
     * until the abort, and a large one was held in memory entire.
     */
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (reader && total < POSTING_CAP) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    await reader?.cancel().catch(() => undefined);
    const bytes = Buffer.concat(chunks).subarray(0, POSTING_CAP);

    /*
     * A posting is often a PDF or a Word file, and decoding one as text sent
     * its bytes into extraction and on to the AI as noise. Read as the file it
     * is — the same reader that takes files dropped into the corpus — and
     * handed on as paragraphs, which is what extraction reads.
     */
    const type = res.headers.get('content-type') ?? '';
    const document = /pdf|officedocument|msword/i.test(type) || /^(%PDF|PK)/.test(bytes.subarray(0, 4).toString('latin1'));
    if (document) {
      const name = decodeURIComponent(target.pathname.split('/').pop() || 'posting') || 'posting';
      const { text } = await extractText(/\.(pdf|docx)$/i.test(name) ? name : `${name}${/pdf/i.test(type) ? '.pdf' : ''}`, bytes);
      const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<html><body>${text.split(/\n{2,}/).map((para) => `<p>${escape(para.trim())}</p>`).join('')}</body></html>`;
    }
    return bytes.toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/** The most of a fetched posting read before the rest is left unread. */
const POSTING_CAP = 2_000_000;

/** Wrap an async handler so a rejection becomes a 4xx/5xx instead of a hang. */
function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    // The writes it checks in for are let go when it is done; see `createApi`.
    res.locals.writesHandled = true;
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
    }).finally(() => {
      res.locals.finishProjectRequest?.();
      res.locals.releaseWrites?.();
    });
  };
}

export interface ApiDeps {
  store: Store;
  repo: Repo;
  jobs?: Jobs;
  /**
   * What the server does to a save when it opens one (`openSave`), run again
   * after a pull has brought new files in. Passed in rather than imported,
   * because it lives in the module that imports this one.
   */
  afterPull?: () => Promise<void>;
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
        // Trimmed after the cut, not before it: a 24-character slice lands
        // mid-word as often as not, and a label ending in a space prints as
        // "Built the pipeline that : …" wherever it is shown beside its text.
        label: text(item.label) ?? body.slice(0, 24).trim(),
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
/**
 * Keep an entry's date text and its date in step, without rewriting either
 * unless the caller actually moved one.
 *
 * The editor now edits the date rather than the words, so something has to
 * turn "start June 2023, no end, still going" back into the string that
 * prints. Doing it here rather than in the browser keeps one implementation of
 * the formatting, and it means a hand-edited YAML file converges on the same
 * answer the next time it is saved.
 *
 * The condition is the careful part. Regenerating whenever a period is present
 * would respell every date in the store the first time each entry was touched
 * — "Jul. 2024" quietly becoming "July 2024" across documents that have been
 * proofread and sent. So the text is rewritten only when the period disagrees
 * with what the text already says: that happens exactly when the user moved
 * the date, and never when they edited something else on the same entry.
 *
 * The style comes from the rest of the store, so the form the program writes
 * is the form already in use here. Fields with alternates are left alone
 * entirely — the period is taken from the default phrasing for sorting, and
 * rewriting one of several phrasings from it would be picking a winner nobody
 * asked for.
 */

/** A form's `maxlength` as sent, or nothing: a positive whole number of characters. */
function validLimit(limit: unknown): number | undefined {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit < 1_000_000 ? limit : undefined;
}

/** The questions a writing run is handed, each with its box's limit when the form gave one. */
export function questionsToWrite(
  questions: { id: string; question: string; answer?: string; limit?: number }[] | undefined,
): Draft['questions'] {
  return (questions ?? []).map((q) => {
    const limit = validLimit(q.limit);
    return { id: q.id, question: q.question, answer: q.answer ?? '', ...(limit ? { limit } : {}) };
  });
}

export function withDatesFrom(entry: Entry, store: Store): Entry {
  if (!entry.period?.start) return entry;
  if (entry.dates !== undefined && typeof entry.dates !== 'string') return entry;

  const current = typeof entry.dates === 'string' ? entry.dates : '';
  const already = parsePeriod(current);
  if (already && samePeriod(already, entry.period)) return entry;

  const data = store.load();
  const style = inferStyle(
    data.entries
      .filter((e) => e.id !== entry.id)
      .map((e) => plainText(e.dates))
      .filter(Boolean),
  );
  const text = formatPeriod(entry.period, style);
  return text ? { ...entry, dates: text } : entry;
}

/**
 * Refuse a date no resume can print.
 *
 * The editor's year box accepted 2023.5 — `Number` reads it, and it sits
 * between 1900 and 2100 — and the server formatted it into "Jul. 2023.5",
 * on the page that goes to an employer. A year is a whole number in a
 * plausible range and a month is one of twelve, and anything else is a
 * mistake to say now rather than a date to print. Only what a caller sends
 * is checked: a hand-edited file is not refused for an unrelated edit.
 */
export function checkPeriod(period: unknown): void {
  if (period === undefined || period === null) return;
  if (typeof period !== 'object' || Array.isArray(period)) throw new Error('A date must be a start and an end');
  for (const which of ['start', 'end'] as const) {
    const point = (period as Record<string, unknown>)[which];
    if (point === undefined || point === null) continue;
    if (typeof point !== 'object' || Array.isArray(point)) throw new Error(`The ${which} of a date must be a year and a month`);
    const { year, month } = point as { year?: unknown; month?: unknown };
    if (typeof year !== 'number' || !Number.isInteger(year) || year < 1900 || year > 2100) {
      throw new Error(`The ${which} year must be a whole year between 1900 and 2100, not ${JSON.stringify(year)}`);
    }
    if (month !== undefined && (typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > 12)) {
      throw new Error(`The ${which} month must be 1 to 12, not ${JSON.stringify(month)}`);
    }
  }
}

/**
 * And the date written as words, on each of its alternates.
 *
 * An alternate of `dates` is written by the editor from a period of its own,
 * so the server never sees that period — only the text made from it. A year
 * with a fraction in it ("Jul. 2023.5") is the one thing that text can carry
 * which no date means, so it is refused here as `checkPeriod` refuses it.
 */
function checkDateText(dates: unknown, stored: unknown): void {
  const texts = (field: unknown): unknown[] =>
    field && typeof field === 'object' && Array.isArray((field as { variants?: unknown }).variants)
      ? (field as { variants: { text?: unknown }[] }).variants.map((v) => v?.text)
      : [];
  /*
   * Only alternates. A plain `dates` string is rewritten from the period,
   * which `checkPeriod` has already held to whole years — and refusing the
   * string would refuse the very save that corrects one written before this.
   * And only text that is new: an alternate already in the file is not the
   * caller's to answer for, and the editor sends every one on each save.
   */
  const already = new Set(texts(stored));
  for (const text of texts(dates)) {
    if (typeof text === 'string' && !already.has(text) && /\b\d{4}\.\d/.test(text)) {
      throw new Error(`"${text}" has a year with a fraction in it. A year must be a whole number.`);
    }
  }
}

/**
 * The numbers a settings patch may carry, and what each may be.
 *
 * The Page settings sent `Number('')` — 0 — for a box somebody emptied,
 * and this wrote it: a 0pt font on every resume in the save, or a sweep
 * switched off by clearing a box. The editor now reverts an empty box and
 * holds the same limits, and this is the second lock for any other caller.
 * `null` is always allowed: it means "back to the default".
 */
const LAYOUT_LIMITS: Record<string, [number, number]> = {
  fontSizePt: [8, 14],
  marginIn: [0.3, 1.5],
  spacing: [0.8, 1.5],
};
const BOUND_LIMITS: Record<string, [number, number]> = {
  minFontSizePt: [8, 14],
  maxFontSizePt: [8, 14],
  minMarginIn: [0.3, 1.5],
  maxMarginIn: [0.3, 1.5],
  minSpacing: [0.8, 1.5],
  maxSpacing: [0.8, 1.5],
};

function checkNumber(what: string, value: unknown, [min, max]: [number, number], whole = false): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
    throw new Error(`${what} must be ${whole ? 'a whole number ' : ''}between ${min} and ${max}, not ${JSON.stringify(value)}`);
  }
}

export function checkConfigPatch(patch: unknown): void {
  if (!patch || typeof patch !== 'object') return;
  const { layout, resumes, applications } = patch as Record<string, unknown>;
  if (layout && typeof layout === 'object') {
    const l = layout as Record<string, unknown>;
    for (const [key, range] of Object.entries(LAYOUT_LIMITS)) checkNumber(`The ${key} setting`, l[key], range);
    checkNumber('The maxPages setting', l.maxPages, [1, 10], true);
    if (l.paper !== undefined && l.paper !== null && l.paper !== 'letter' && l.paper !== 'a4') {
      throw new Error(`Paper must be "letter" or "a4", not ${JSON.stringify(l.paper)}`);
    }
    if (l.autoFit !== undefined && l.autoFit !== null && typeof l.autoFit !== 'boolean') {
      throw new Error('autoFit must be true or false');
    }
    for (const bounds of ['fitBounds', 'growBounds']) {
      const b = l[bounds];
      if (!b || typeof b !== 'object') continue;
      for (const [key, range] of Object.entries(BOUND_LIMITS)) {
        checkNumber(`The ${bounds}.${key} setting`, (b as Record<string, unknown>)[key], range);
      }
    }
  }
  if (resumes && typeof resumes === 'object') {
    checkNumber('Days to keep a temporary resume', (resumes as Record<string, unknown>).temporaryDays, [0, 3650], true);
  }
  if (applications && typeof applications === 'object') {
    checkNumber('Days an application may sit at Applying', (applications as Record<string, unknown>).applyingDays, [0, 3650], true);
  }
}

/** Two periods meaning the same thing, ignoring how they were spelt. */
function samePeriod(a: Period, b: Period): boolean {
  // The season is part of a point now — either end can name one — so it is
  // compared per end rather than once for the whole range. See `DatePoint`.
  const point = (p?: { year: number; month?: number; season?: string }) =>
    p ? `${p.year}-${p.month ?? ''}-${p.season ?? ''}` : '';
  return (
    point(a.start) === point(b.start) &&
    point(a.end) === point(b.end) &&
    Boolean(a.ongoing) === Boolean(b.ongoing) &&
    Boolean(a.expected) === Boolean(b.expected)
  );
}

function sentBefore(
  applications: Application[],
  company: string | undefined,
  role: string | undefined,
  url?: string,
): { id: string; at: string; status: ApplicationStatus } | undefined {
  if (!company?.trim() || !role?.trim()) return undefined;
  const past = alreadySent(applications, company, role, url);
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
/**
 * The AI's sections, keeping the narrowed skills the keyword match chose.
 *
 * Two things want to write `spec.sections` and they overlap in exactly one
 * place. `deriveSpec` copies the base's sections and narrows the skills lists
 * to what the posting asked for; `applyInclusion` copies the *same* base's
 * sections and applies what the AI decided — what is shown, what is hidden,
 * and what order the lines inside an entry go in. So the AI's version already
 * carries everything the base had, and the only thing it is missing is the
 * narrowed `items`.
 *
 * It used to be written the other way round — the AI's sections first and
 * `deriveSpec`'s spread over the top, with `entries` and `bullets` named
 * afterwards to put them back. `order` and `bulletOrder` were not named, and
 * `bulletOrder` is precisely what `applyInclusion` sets to `manual` to say
 * the AI arranged an entry's lines itself. Whatever the base carried under
 * those names the spread put back over the AI's — `order` above all, since
 * `Store.load()` runs `adoptDateOrder` and gives very nearly every section a
 * date sort — so an arrangement the tool had reported as made was restacked
 * on the way to the page.
 *
 * (The AI no longer reorders entries at all — "AI should be able to
 * rearrange bullet points but not entries ever" — so a section's `order` is
 * now always the base's, and comes through here untouched.)
 *
 * Naming the one field that actually differs, rather than spreading a whole
 * object and patching up whatever it broke, is what stops the next field
 * being lost the same way.
 */
function withNarrowedSkills(
  decided: SectionSpec[],
  derived: ResumeSpec['sections'],
): SectionSpec[] {
  /*
   * Paired by place among the sections of one kind, not by kind alone. Both
   * lists are copies of the same base's sections, in its order; keyed by kind,
   * a resume with two skills sections handed the first one the second's
   * `items`, and every list the first had trimmed for itself went — printing
   * every skill of a group the base had cut down.
   */
  const nth = (list: readonly SectionSpec[], s: SectionSpec) =>
    list.filter((x) => x.kind === s.kind).indexOf(s);
  const from = derived ?? [];
  return decided.map((s) => {
    const twin = from.filter((x) => x.kind === s.kind)[nth(decided, s)];
    const narrowed = twin?.items;
    return narrowed ? { ...s, items: narrowed } : s;
  });
}

function decidedAnything(state: SessionState): boolean {
  const { plan, suggestions, reasoning } = state;
  return (
    Object.keys(plan.choices).length > 0 ||
    Object.keys(plan.skills).length > 0 ||
    Object.keys(plan.order).length > 0 ||
    // Not `entryOrder`: the AI cannot reorder entries, so a plan holding only
    // one decided nothing.
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
          // What the writing tools read and nothing else — see `session-data.ts`.
          data: writingData(data),
          resume: sessionResume(resolved),
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

/**
 * What to say beside an AI draft that still has template slots in it, naming
 * them — so it is not presented as finished. See `placeholdersIn`.
 */
function placeholderNote(what: string, found: string[]): string {
  return (
    `${what} still has ${found.length === 1 ? 'a placeholder' : `${found.length} placeholders`} in it — ` +
    `${namePlaceholders(found)}. It is not finished: fill ${found.length === 1 ? 'it' : 'them'} in, or take the sentence out.`
  );
}

/**
 * A letter id for a job that is not another application's letter.
 *
 * `letterId` is the day, the company and the role, and that name is the
 * file. Completing an application files its letter under it, tagged with the
 * application (`applicationId`), and the extension's "Save to store" and the
 * cover-letter route's `save` asked for the same name and wrote over it: a
 * second application to the same title on the same day, or a draft saved
 * after the first was sent, replaced the letter the tracker's row points at.
 * So a name already held by a letter linked to a different application is
 * numbered past, "-2", "-3", the way completing an application numbers past
 * one. `owner` is the application the letter is for, when the caller knows
 * it: its own letter under the name is its own to write over. A letter linked
 * to nothing is anybody's draft, and is not numbered past.
 */
function unclaimedLetterId(letters: CoverLetter[], named: string, owner?: string): string {
  const linked = new Map(letters.map((l) => [l.id, l.applicationId]));
  const claimed = (id: string) => {
    const by = linked.get(id);
    return Boolean(by) && by !== owner;
  };
  let candidate = named;
  for (let n = 2; claimed(candidate); n++) candidate = `${named}-${n}`;
  return candidate;
}

/** Text a caller sent, trimmed — or nothing, for anything else or blank. */
function sentText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * The resume a letter or an answer is written against: the one the caller is
 * holding, where it sent it, and the stored one it names otherwise.
 *
 * The extension holds a proposal the store has not been given — it is saved
 * when the folder is built, not before — and used to name the resume under it
 * with `spec.extends`. Resumes stopped inheriting, a proposal carries
 * `copiedFrom` instead, and the proposal's own id went in its place: every
 * letter, every one-run write and every "AI feedback" asked from the card
 * came back `No resume named "job-acme-…"`, and the card showed no previous
 * letter to start from. Sending the proposal itself is also the better answer
 * than the base ever was, because it is what the letter goes out beside.
 */
function resumeToWriteFrom(body: { resumeId?: unknown; spec?: unknown }, data: StoreData): ResolvedResume {
  const spec = body.spec as ResumeSpec | undefined;
  if (spec && typeof spec === 'object' && typeof spec.id === 'string' && spec.id && (spec.sections === undefined || Array.isArray(spec.sections))) {
    return resolveResume(spec, { ...data, resumes: [...data.resumes.filter((r) => r.id !== spec.id), spec] });
  }
  if (typeof body.resumeId !== 'string' || !body.resumeId) throw new Error('resumeId is required');
  return resolveResume(body.resumeId, data);
}

/** Two resume names that read as one in the picker: case, spacing and punctuation aside. */
export function sameResumeName(a: string, b: string): boolean {
  const flat = (x: string) => x.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const x = flat(a);
  return Boolean(x) && x === flat(b);
}

/**
 * What a resolved resume prints, as one short string: the same resume
 * against the same store gives the same answer, and any change to what it
 * would put on the page gives another. `lost` is left out, being a report
 * about the resume rather than a part of it.
 */
export function printedFingerprint(resolved: ResolvedResume): string {
  const { lost: _lost, ...printed } = resolved as ResolvedResume & { lost?: unknown };
  return createHash('sha1').update(JSON.stringify(printed)).digest('hex');
}

/**
 * The alternate of the profile's name that is the legal one: the alternate
 * whose label says "legal", or none, which resolves to the default.
 */
function legalNameChoice(profile: StoreData['profile']): Record<string, string> {
  if (!isVariantField(profile.name)) return {};
  const legal = profile.name.variants.find((v) => /\blegal\b/i.test(v.label ?? ''));
  return legal ? { [PROFILE_NAME_KEY]: legal.id } : {};
}

/**
 * The name a resume prints, as a form's preferred-name boxes ask for it —
 * and nothing when it is the legal name, so a "Preferred name" box on a form
 * is left for the person rather than given the same name twice.
 */
function preferredNameFields(printed: string, legal: string): Record<string, string> {
  // Split as the legal name is: "Martin Luther King Jr." is first "Martin",
  // last "Luther King Jr.", and "Dr. Jane Smith" has no first name "Dr.".
  return preferredName(printed, legal);
}

/**
 * Every employer the person has applied to or drafted for, for the answer
 * bank to look for in an answer it is about to offer elsewhere. Without it
 * the bank guessed from its own labels, and "Full" — the long version of an
 * answer — counted as an employer.
 */
const employersRead = new WeakMap<object, string[]>();
function employersOf(store: Store, data: { applications: { company: string }[] }): string[] {
  // Once per loaded store, since a draft's questions are matched one by one.
  const known = employersRead.get(data);
  if (known) return known;
  const names = [...data.applications.map((a) => a.company), ...store.loadDrafts().map((d) => d.company)];
  const employers = [...new Set(names.filter((n) => n && n !== UNKNOWN_COMPANY))];
  employersRead.set(data, employers);
  return employers;
}

/**
 * Where a posting's tailored copy is written: the copy already made for this
 * job, if there is one, and otherwise a fresh id.
 *
 * The id is made from the employer as it was spelt, and one job is spelt
 * more than one way — Intel's LinkedIn posting says "Intel", its Workday
 * form "Intel Corporation". Tailoring on each page minted a copy under each
 * spelling, eight tailorings in seven minutes between two files, and the
 * workspace pointed at one while the application filed the other. Asked the
 * way the tracker asks whether two rows are one job (`identity`), so a
 * legal form or a spelling the tracker already forgives does not make a
 * second resume either.
 */
function copyIdForPosting(resumes: ResumeSpec[], company: string, role: string): string {
  const job = identity(company, role);
  /*
   * Only a copy under the id this code would have minted for what it was made
   * for: one somebody named themselves is theirs, and is a base to start
   * from rather than a file to write over.
   */
  const made = resumes.find((r) => {
    const { company: was, role: as } = r.generatedFor ?? {};
    if (r.tier !== 'temporary' || !was) return false;
    if (!sameIdentity(was, as ?? 'Unknown role', company, role)) return false;
    const minted = tailoredResumeId(was, as ?? 'Unknown role');
    return r.id === minted || r.id.startsWith(`${minted}-`) || mintedForJob(r.id, job);
  });
  return made?.id ?? copyIdFor(resumes, tailoredResumeId(company, role));
}

/**
 * Whether `id` reads as `tailoredResumeId` of some spelling of the job whose
 * `identity` is `job` — `job-<employer>-<role>`, perhaps numbered `-2`.
 *
 * A copy's `generatedFor` is rewritten with the spelling of the page that
 * last tailored it, and its id is not: minted on LinkedIn as "Intel"
 * (`job-intel-…`), staged from Workday's "Intel Corporation", it records
 * "Intel Corporation" — and `tailoredResumeId` of that is
 * `job-intel-corporation-…`, which is not its id. So asking only "does the
 * record rebuild the id" found it once and never again: the next Workday
 * visit minted a second copy beside it. Read the other way instead: split the
 * id's words into an employer and a role every way they go, and ask whether
 * any is this job. The id never changes, so this answers the same on every
 * visit, under whatever spelling the page uses.
 *
 * Only readable ids: one carrying a fingerprint (a name with no ASCII, or
 * cut at sixty characters) cannot be read back, and keeps the old rule.
 */
function mintedForJob(id: string, job: string): boolean {
  if (!id.startsWith('job-')) return false;
  const rest = id.slice('job-'.length);
  for (const words of new Set([rest, rest.replace(/-\d+$/, '')])) {
    const parts = words.split('-').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      if (identity(parts.slice(0, i).join(' '), parts.slice(i).join(' ')) === job) return true;
    }
  }
  return false;
}

export function createApi({ store, repo, jobs = new Jobs(), afterPull }: ApiDeps): Router {
  const api = express.Router();
  api.use(express.json({ limit: '32mb' }));
  /*
   * Every write a request checks in for (`assertNoOutsideGit`) is counted
   * until the request is answered, so a Pull pressed meanwhile waits for it
   * rather than merging under it. See `Repo.holdForRequest`. A read checks
   * in for nothing and costs nothing here.
   */
  api.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      next();
      return;
    }
    /*
     * Let go when the handler is done, not when the reply has gone: a
     * browser that gives up on a request closes it while the handler is
     * still writing, and a pull let through then would merge under that
     * write. A route not wrapped in `handler` is let go when its reply is
     * finished or its connection closes, so that no hold outlives it.
     */
    const finished = Repo.writesOfRequest(() => {
      res.locals.releaseWrites = () => finished();
      next();
    });
    const unlessHandled = () => {
      if (!res.locals.writesHandled) finished();
    };
    res.once('finish', unlessHandled);
    res.once('close', unlessHandled);
  });

  const autoCommit = () => store.loadConfig().git.autoCommit;

  /**
   * A short string that changes whenever `value` does: what `entryVersion`
   * and the whole-object writes' versions are made of. Keys sorted, so a
   * hand edit that only reorders them is not a change.
   */
  const contentVersion = (value: unknown): string => {
    const sorted = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sorted)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
          : v;
    return createHash('sha1').update(JSON.stringify(sorted(value) ?? null)).digest('hex').slice(0, 20);
  };

  /**
   * `?basedOn=<version>` for the writes that replace a whole object — the
   * profile, the skills list, the answer bank — as an entry's PUT has it.
   *
   * Each is sent whole, built from a copy the writer read a moment or an hour
   * ago, and each was written over whatever the file held by then: a pull
   * that brought in the other machine's new phone number, a skill added in
   * another tab, an answer the extension kept. Sent from a copy read before
   * the pull, the next save of any one field put every pulled change back
   * the way it was, with nothing on screen to say so. Now the writer says
   * which version it built on (`profileVersion`, `skillsVersion` and
   * `answersVersion` in `GET /store`, and the `ETag` of each write), and a
   * write over a different one is answered 409 with what is there now and
   * its version, for the writer to make its change to that and send again.
   * A write that sends no `basedOn` — the CLI, MCP, undo, an older page —
   * is not a condition, and writes as it always did. Checked with nothing
   * awaited before the write, as the entry's is.
   */
  const wholeMovedOn = (res: Response, what: string, basedOn: unknown, current: unknown): boolean => {
    if (typeof basedOn !== 'string' || !basedOn) return false;
    const version = contentVersion(current);
    if (basedOn === version) return false;
    res.status(409).json({
      kind: 'conflict',
      error: `${what} changed elsewhere since this change was made to it, so it was not written.`,
      current,
      version,
    });
    return true;
  };

  /**
   * The newest editor save written of each resume, as `?order=<page>:<n>`.
   * See the resume PUT. In memory, since the race it settles lasts one round
   * trip; one entry per resume.
   */
  const lastSaveOrder = new Map<string, { page: string; n: number }>();
  /** The same for each Workspace draft, and each entry. See their PUTs. */
  const lastDraftOrder = new Map<string, { page: string; n: number }>();
  const lastEntryOrder = new Map<string, { page: string; n: number }>();
  const savedOrderOf = (raw: unknown): { page: string; n: number } | null => {
    const match = typeof raw === 'string' ? /^([\w-]{1,64}):(\d{1,15})$/.exec(raw) : null;
    return match ? { page: match[1]!, n: Number(match[2]) } : null;
  };

  /*
   * Which of a page's ordered writes have been answered, for a commit that
   * has to follow them.
   *
   * On the way out of the page the editor cannot wait for a reply before its
   * next request, since nothing on a gone page runs. So it sends the commit
   * straight after the writes it has to cover (see `flushEditsLeaving` in
   * web/app.js), and the commit can arrive first and record the store without
   * them. Every write left for a later commit carries `?order=<page>:<n>`,
   * and the commit names the ones still out as `?page=<page>&after=<n>,...`.
   * `/store/save` holds such a commit until each of those has been answered,
   * whether it was written, turned away as older than one already written, or
   * refused; or until `COMMIT_AFTER_MS` has gone by, since a write that never
   * arrives (the request lost, or sent to a server since restarted) must not
   * hold the commit forever, and the commit then records what is there. In
   * memory, a bounded number of pages and orders, since what it settles lasts
   * one round trip.
   */
  const COMMIT_AFTER_MS = 5000;
  const answered = new Map<string, { done: Set<number>; waiting: Set<() => void> }>();
  const answersOf = (page: string) => {
    let seen = answered.get(page);
    if (!seen) {
      seen = { done: new Set(), waiting: new Set() };
      answered.set(page, seen);
      // The oldest page first: a Map keeps the order its keys went in.
      if (answered.size > 64) answered.delete(answered.keys().next().value!);
    }
    return seen;
  };
  api.use((req, res, next) => {
    const order = req.method === 'GET' ? null : savedOrderOf(req.query.order);
    if (order) {
      let noted = false;
      const note = () => {
        if (noted) return;
        noted = true;
        const seen = answersOf(order.page);
        seen.done.add(order.n);
        if (seen.done.size > 512) seen.done.delete(seen.done.values().next().value!);
        for (const wake of [...seen.waiting]) wake();
      };
      // `finish` once the reply is sent; `close` if the connection went first.
      res.on('finish', note);
      res.on('close', note);
    }
    next();
  });
  const allAnswered = (page: string, orders: number[]): Promise<void> =>
    new Promise((settle) => {
      const seen = answersOf(page);
      const check = () => {
        if (!orders.every((n) => seen.done.has(n))) return;
        clearTimeout(timer);
        seen.waiting.delete(check);
        settle();
      };
      const timer = setTimeout(() => {
        seen.waiting.delete(check);
        settle();
      }, COMMIT_AFTER_MS);
      seen.waiting.add(check);
      check();
    });

  /**
   * A tailored copy the extension posts, kept off any resume somebody kept.
   * The copy's id is derived from the posting, so a copy promoted and edited
   * earlier holds it; a temporary copy takes the next free id instead of
   * writing over it. See `copyIdFor`.
   */
  const keptSafe = (spec: ResumeSpec): ResumeSpec =>
    spec.tier === 'temporary' ? { ...spec, id: copyIdFor(store.load().resumes, spec.id) } : spec;

  /**
   * Which write of a resume the save holds: a short string that changes every
   * time its file is written, and at no other time. Null when there is none.
   *
   * Resume writes were last-writer-wins, and two writers hold the same copy:
   * the editor, saving a line switched in it, and JobHelper's card, filing
   * the copy whole with every stage. Each looked before writing, and an edit
   * landing between the look and the write was written away. A writer can
   * now say which write it built on (`basedOn`), and the write is refused
   * when the save has moved on since (see `movedOn`).
   *
   * Of the file, not of its content: an edit that puts the resume back
   * exactly as one earlier write had it is still a write the writer has not
   * seen. The file is replaced whole on every save (`writeAtomic`), so its
   * inode, time and size say which write it is; the same three the save's
   * `/revision` is built from.
   */
  const resumeVersion = (id: string): string | null => {
    const seen: string[] = [];
    let files: string[];
    try {
      files = Store.resumeFiles(id);
    } catch {
      return null; // not a name a file could have
    }
    for (const rel of files) {
      try {
        const st = fs.statSync(path.join(store.root, rel));
        seen.push(`${rel}\u0000${st.ino}\u0000${st.mtimeMs}\u0000${st.size}`);
      } catch {
        // Not kept under this spelling.
      }
    }
    return seen.length ? createHash('sha1').update(seen.join('\n')).digest('hex').slice(0, 20) : null;
  };

  /**
   * A conditional write of a resume that is not based on the write the save
   * holds now: answered 409 with the resume as it is and its version, and
   * true, so the caller writes nothing.
   *
   * `basedOn` is the version the writer last had, or null for "there is no
   * resume here yet". Anything else — the CLI, MCP, an older page or
   * extension sending nothing — is not a condition, and writes as before. A
   * resume deleted since the writer looked is not refused either: there is
   * nothing there to write over, and `?existing=1` is how a writer says it
   * must not come back.
   *
   * Checked with nothing awaited between here and the caller's write.
   */
  const movedOn = (res: Response, id: string, basedOn: unknown): boolean => {
    if (basedOn !== null && typeof basedOn !== 'string') return false;
    const version = resumeVersion(id);
    if (version === basedOn || (version === null && basedOn !== null)) return false;
    const current = store.load().resumes.find((r) => r.id === id) ?? null;
    res.status(409).json({
      kind: 'conflict',
      error: `“${current?.label ?? id}” was changed elsewhere since this change was made to it, so it was not written.`,
      id,
      current,
      version,
    });
    return true;
  };

  /**
   * The last conditional editor save written of each resume: the page and
   * order it came with (`?order=<page>:<n>`), the write it was based on, and
   * the write it made. In memory, since what it settles lasts one round trip.
   */
  const lastConditionalSave = new Map<string, { page: string; n: number; basedOn: string; made: string }>();

  /**
   * Whether the resume as it is now is this page's own save, made over the
   * write this later save from the same page says it is based on.
   *
   * On the way out of the page the editor sends its latest edit at once, while
   * its save ahead of it is still out (see `flushEditsLeaving` in
   * web/app.js), so the latest cannot know the write the one ahead will make,
   * and is based on the one both were made over. The one ahead landing first
   * would get the latest refused, and its edit, on a page that has gone, kept
   * only as a rescue for the next time the resume is opened. It carries
   * everything the one ahead carried, and nothing else has written the file
   * since (`made` is still the resume's version), so it is written. From any
   * other page, or over any other write, it is refused as before.
   */
  const ownWriteSince = (id: string, order: { page: string; n: number }, basedOn: string): boolean => {
    const own = lastConditionalSave.get(id);
    return Boolean(own && own.page === order.page && own.n < order.n && own.basedOn === basedOn && own.made === resumeVersion(id));
  };

  /**
   * Which write of the resume this answer is about, said as its `ETag`, for
   * the writer's next write to be based on (see `resumeVersion`). Every route
   * that writes a whole resume, or one field of it, says it.
   */
  const tagVersion = (res: Response, id: string): void => {
    const version = resumeVersion(id);
    if (version) res.setHeader('ETag', `"${version}"`);
  };
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

  /**
   * Whether anything in the save has changed, as one short string.
   *
   * The extension builds from the store and then holds what it built — the
   * resume list, the copy, what it printed, the answers it matched — and
   * until now learnt of a change only when its tab came back into view, and
   * then only for the copy. A variation saved in the editor did not appear in
   * the card's picker at all until the card was put up again. This is cheap
   * enough to ask every few seconds: a fingerprint of every file's time and
   * size, which moves on any write — the editor's, a restore from the
   * version history, a hand edit — and on nothing else. The build output and
   * the history's own folder are left out; they change when nothing the card
   * holds has.
   */
  api.get(
    '/revision',
    handler(async (_req, res) => {
      const out = path.resolve(store.outDir());
      const hash = createHash('sha1');
      const walk = (dir: string) => {
        let names: string[];
        try {
          names = fs.readdirSync(dir).sort();
        } catch {
          return;
        }
        for (const name of names) {
          if (name.startsWith('.')) continue;
          const full = path.join(dir, name);
          if (path.resolve(full) === out || name === 'snapshots') continue;
          let st: fs.Stats;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) walk(full);
          else hash.update(`${path.relative(store.root, full)}\u0000${st.mtimeMs}\u0000${st.size}\n`);
        }
      };
      walk(store.root);
      res.json({ revision: hash.digest('hex') });
    }),
  );

  api.get(
    '/store',
    handler(async (_req, res) => {
      const data = store.load();
      res.json({
        ...data,
        /*
         * The writing samples by name, never by content.
         *
         * This is the reply the editor loads at startup and again after
         * almost every edit — eighteen call sites — and the one thing in the
         * store with no ceiling on its size is the corpus: the panel that
         * owns it says "paste in an old resume, a cover letter you were
         * pleased with, a README", and people do. Twenty dropped files made
         * this reply 1,038,073 bytes, of which 1,002,733 were sample text,
         * and the only thing the editor ever asks of that list is how long it
         * is — see `draftedFrom`. Everything in that megabyte was parsed,
         * structured-cloned and thrown away, on the thread that draws the
         * page, every time anything was saved.
         *
         * `GET /voice` lists them with an excerpt each and
         * `GET /voice/samples/:id` has one in full, which is what the two
         * places that show a sample actually want.
         */
        samples: data.samples.map(({ text, ...rest }) => ({ ...rest, chars: text.length })),
        // config carries no secrets, but the AI command is machine-specific and
        // the GUI has no use for it.
        config: { git: data.config.git, ai: { enabled: data.config.ai.enabled } },
        // Which write of each resume this read saw, for a save to be based on.
        // Beside the resumes rather than in them, so a resume sent back whole
        // does not carry it into its file. See `resumeVersion`.
        versions: Object.fromEntries(data.resumes.map((r) => [r.id, resumeVersion(r.id)])),
        // And of each entry, for an entry's save. See `entryVersion`.
        entryVersions: Object.fromEntries(data.entries.map((e) => [e.id, entryVersion(e)])),
        // And of the three things written whole. See `wholeMovedOn`.
        profileVersion: contentVersion(data.profile),
        skillsVersion: contentVersion(data.skillGroups),
        answersVersion: contentVersion(data.answers),
      });
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
   * Move a resume between tiers.
   *
   * Its own endpoint rather than part of the whole-spec save, for the reason
   * the pin toggle it replaces had: this is a decision about how the save is
   * organised, and it should not ride along with an unrelated edit to the
   * document.
   *
   *   `base` — what you build from, and what the extension offers first.
   *   `extended` — permanent, and never swept.
   *   `temporary` — made for one posting, and gone a week after that posting
   *   is done with. Promoting out of it is the whole reason this takes a
   *   tier rather than a boolean.
   */
  api.put(
    '/resumes/:id/tier',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const wanted = (req.body as { tier?: string }).tier;
      if (!RESUME_TIERS.includes(wanted as ResumeTier)) {
        throw new Error(`"${String(wanted)}" is not a tier — it is one of ${RESUME_TIERS.join(', ')}.`);
      }
      const tier = wanted as ResumeTier;

      const spec = store.loadResumes().find((r) => r.id === id);
      if (!spec) throw new Error(`No resume "${id}"`);
      /*
       * Only over the write the button was pressed on, when the editor says
       * which (`basedOn`, as the resume PUT's `?basedOn=`). The tier alone is
       * written, so nothing else of a write made elsewhere is lost here; but
       * the editor's undo step for the press is the resume as the editor had
       * it, and a write made elsewhere in between was taken away by undoing
       * the press. Refused, the editor reapplies the tier on what is there
       * and sends it again once (see `writeResumeField` in web/app.js).
       */
      if (movedOn(res, id, (req.body as { basedOn?: unknown }).basedOn)) return;

      spec.tier = tier;
      // The flag the tier replaced. Leaving it would let the two disagree.
      delete spec.base;
      /*
       * The clock starts now, and only for a resume that was not already on
       * it. Re-marking something temporary must not give it another week, or
       * a stray click would keep it forever; and promoting it out has to
       * forget the date, or demoting it later would sweep it immediately.
       */
      if (tier === 'temporary') spec.temporaryFrom ??= new Date().toISOString();
      else delete spec.temporaryFrom;

      const said = { base: 'a base', extended: 'kept', temporary: 'temporary' }[tier];
      // Tagged as written, before the commit's awaits let another write in.
      await withCommit(repo, autoCommit(), `Mark "${spec.label}" ${said}`, () => {
        store.saveResume(spec);
        tagVersion(res, id);
      });
      res.json(spec);
    }),
  );

  /**
   * The pin toggle this replaced, kept working.
   *
   * The CLI, the MCP tools and any older client still send it, and a client
   * is not wrong for saying something that used to be true. `base: false` is
   * `extended` rather than `temporary`, because unpinning a resume has never
   * meant "and delete it next week".
   */
  api.put(
    '/resumes/:id/base',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const tier: ResumeTier = (req.body as { base?: boolean }).base !== false ? 'base' : 'extended';

      const spec = store.loadResumes().find((r) => r.id === id);
      if (!spec) throw new Error(`No resume "${id}"`);

      spec.tier = tier;
      delete spec.base;
      delete spec.temporaryFrom;

      await withCommit(repo, autoCommit(), `${tier === 'base' ? 'Mark' : 'Unmark'} "${spec.label}" as a base`, () =>
        store.saveResume(spec),
      );
      res.json(spec);
    }),
  );

  /* ------------------------------------------------------------------ *
   * Standing documents                                                  *
   * ------------------------------------------------------------------ */

  /**
   * Files that are attached rather than written: a transcript, a portfolio.
   *
   * They live in `documents/` in the save and are copied into the flat upload
   * folder by `syncCurrent`, so the one folder a portal's dialog is pointed at
   * holds everything that dialog is going to ask for.
   */
  api.get(
    '/documents',
    handler(async (_req, res) => {
      res.json({ documents: store.listDocuments(), dir: currentDir(store) });
    }),
  );

  api.post(
    '/documents',
    handler(async (req, res) => {
      const body = req.body as { name?: string; data?: string };
      const name = String(body.name ?? '').trim();
      if (!name) throw new Error('Give the document a name.');
      if (typeof body.data !== 'string') throw new Error('No file was sent.');
      /*
       * Named by what it will be uploaded as, extension and all.
       *
       * A reviewer opening the attachment sees this string, so it is not an
       * id with a display name beside it — it is the thing itself. Refusing a
       * name with no extension would be officious; refusing one with a path
       * in it happens in `Store.file`, where every other name is checked.
       */
      /*
       * The write happens inside `withCommit`, not before it.
       *
       * It used to be written first and committed after with an empty `fn`,
       * and `withCommit` checks for a pull in progress before it runs `fn`
       * — so with a merge stopped on a conflict the file was already in
       * `documents/` when the check refused, and the answer was a 400
       * saying "Not saved" about a document that was saved. Inside, the
       * check comes first and a refusal really has written nothing.
       */
      const { saved, trouble } = await withCommit(repo, autoCommit(), `Add document "${name.normalize('NFC')}"`, () => {
        const saved = store.saveDocument(name, Buffer.from(body.data as string, 'base64'));
        /*
         * Into the upload folder straight away, so it is attachable without
         * waiting for the next application to be built — and the answer is
         * read, not dropped.
         *
         * `syncCurrent` reports rather than throws: a file of the user's
         * already holding that name in the folder means the copy did not
         * happen, and the document is then in the save and not where anything
         * can attach it. That came back as a plain 200 and the panel said
         * "ready to attach", which was the one thing it was not.
         */
        const folder = syncCurrent(store);
        return { saved, trouble: (folder.problems ?? []).filter((said) => said.includes(`"${saved.name}"`)) };
      });
      res.json({ ...saved, ...(trouble.length ? { problems: trouble } : {}) });
    }),
  );

  api.delete(
    '/documents/:name',
    handler(async (req, res) => {
      const name = String(req.params.name);
      /*
       * Asked before the file goes, for the reason the upload above writes
       * inside `withCommit`: checked only at the commit, a delete refused
       * for a pull in progress had already taken the file off the disk and
       * said "Not saved" about it — and the panel went on listing a
       * document that was gone. The commit is still made only when there
       * was something to remove.
       */
      repo.assertNoOutsideGit();
      const gone = store.deleteDocument(name);
      let problems: string[] = [];
      if (gone) {
        /*
         * The file is already off the disk by here, so a sync that throws
         * must not turn a delete that happened into a 400 that says it did
         * not. `syncCurrent` parses the whole store to work out what the
         * folder should hold, and everything that can be wrong with a store
         * can be wrong at this moment — a malformed `applications.yaml`, an
         * output folder that cannot be made. The panel would then keep
         * listing a document that is gone.
         */
        try {
          problems = (syncCurrent(store).problems ?? []).filter((said) => said.includes(`"${name}"`));
        } catch (err) {
          problems = [err instanceof Error ? err.message : String(err)];
        }
        await withCommit(repo, autoCommit(), `Remove document "${name}"`, () => undefined);
      }
      res.json({ ok: gone, ...(problems.length ? { problems } : {}) });
    }),
  );

  /**
   * The bytes, for the browser extension to put into a form's upload box.
   *
   * Served from here rather than only out of the flat folder because the
   * extension may want a document on a page where nothing has been built yet,
   * and because the name in `documents/` is the one the user chose — the flat
   * folder's copy can have been renamed around a collision.
   */
  api.get(
    '/documents/:name/file',
    handler(async (req, res) => {
      const name = String(req.params.name);
      const bytes = store.readDocument(name);
      if (!bytes) {
        res.status(404).json({ error: 'That document is not in this save.' });
        return;
      }
      res.type(name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
      /*
       * Through `content-disposition`, which is what Express's own
       * `res.attachment` uses. Written by hand as `filename="…"`, a name with
       * any character past U+00FF — "Transcript – Fall 2025.pdf", with its
       * en dash, or one in Chinese — is not a legal header value, Node threw
       * on setting it, and the document came back as a 400 to the extension
       * that asked for it. The package gives a Latin-1 `filename=` for old
       * clients and the real name as RFC 5987 `filename*=UTF-8''…`.
       */
      res.setHeader('Content-Disposition', contentDisposition(name, { type: 'inline' }));
      res.send(bytes);
    }),
  );

  /**
   * Everything this application could attach, in one list.
   *
   * The flat folder holds every application in flight at once, which is right
   * for a person looking at it and exactly wrong for a form: attaching
   * another job's resume is the worst thing the extension could do with a
   * file picker. So the folder says whose each file is, and this filters to
   * the one being applied for plus the standing documents, which belong to
   * all of them.
   */
  api.get(
    '/attachments',
    handler(async (req, res) => {
      const wanted = String(req.query.application ?? '').trim();
      /*
       * Named as the one being worked on — given the plain filenames in the
       * shared folder — only when somebody asked for that: copied the folder
       * path, opened it, pressed Attach. See `uniqueNames`. A card warming
       * its chips in a background tab is not that, and taking the names on
       * every warm let one tab rename the file another had just copied the
       * path to. Either way the files are offered under the names they were
       * built with (`builtAs`), so the card shows and hands over
       * `First-Last-Resume.pdf` whatever the folder calls its copy.
       */
      const claim = req.query.claim === '1' || req.query.claim === 'true';
      const folder = syncCurrent(store, undefined, claim && wanted ? wanted : undefined);
      const attachments = folder.files
        .filter((name) => {
          const whose = folder.belongsTo[name] ?? '';
          if (whose === STANDING) return true;
          // No application named: the standing documents only. A card that
          // has not built anything yet has nothing of its own here, and the
          // files that *are* here belong to somebody else's form.
          return Boolean(wanted) && whose === wanted;
        })
        .map((name) => ({
          name: folder.builtAs?.[name] ?? name,
          inFolder: name,
          standing: folder.belongsTo[name] === STANDING,
          url: `/current/${encodeURIComponent(name)}`,
        }));
      res.json({ attachments, dir: folder.dir });
    }),
  );

  /**
   * What the sweep would take, and taking it.
   *
   * Two endpoints rather than one on purpose. This is the only thing in the
   * program that deletes something nobody asked it to, and a deletion that
   * cannot be looked at first is one nobody can trust — so the list is
   * available on its own, and both come from the same function, which is how
   * a preview usually stops matching what happens.
   */
  api.get(
    '/resumes/expiring',
    handler(async (_req, res) => {
      res.json({ due: wouldSweep(store), days: temporaryDays(store) });
    }),
  );

  api.post(
    '/resumes/sweep',
    handler(async (_req, res) => {
      res.json(await sweepTemporary(store, repo));
    }),
  );

  api.get(
    '/resumes/:id/resolved',
    handler(async (req, res) => {
      const data = store.load();
      res.json(resolveResume(String(req.params.id), data));
    }),
  );

  /**
   * Rename a resume: the name it is shown by, never the file it is kept in.
   *
   * The file's name is what the tracker's rows, the workspaces, the
   * extension's setting and every copy's `copiedFrom` point at, so moving it
   * would be a rewrite of all of them for a change nobody sees. The name is
   * the thing the picker shows and the thing a person means by "rename".
   *
   * Refused when another resume already goes by it — case, spacing and
   * punctuation aside — because two entries in the picker reading the same
   * are two resumes nobody can tell apart.
   */
  api.post(
    '/resumes/:id/rename',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const label = String((req.body as { label?: unknown })?.label ?? '').replace(/\s+/g, ' ').trim();
      const resumes = store.loadResumes();
      const mine = resumes.find((r) => r.id === id);
      if (!mine) {
        res.status(404).json({ error: `There is no resume "${id}" in this save.` });
        return;
      }
      if (!label) {
        res.status(400).json({ error: 'A resume needs a name.' });
        return;
      }
      /*
       * Only over the write the name was chosen on, when the editor says which
       * (`basedOn`): see the tier route. Before the name is checked, so a
       * refusal says the resume moved on rather than something about names.
       */
      if (movedOn(res, id, (req.body as { basedOn?: unknown })?.basedOn)) return;
      const taken = resumes.find((r) => r.id !== id && sameResumeName(r.label ?? r.id, label));
      if (taken) {
        res.status(409).json({ error: `A resume called “${taken.label ?? taken.id}” already exists. Choose another name.` });
        return;
      }
      if (mine.label === label) {
        tagVersion(res, id);
        res.json(mine);
        return;
      }
      const renamed = { ...mine, label };
      await withCommit(repo, autoCommit(), `Rename resume "${id}" to "${label}"`, () => {
        store.saveResume(renamed);
        tagVersion(res, id);
      });
      res.json(renamed);
    }),
  );

  api.put(
    '/resumes/:id',
    handler(async (req, res) => {
      const spec = { ...(req.body as ResumeSpec), id: String(req.params.id) };

      /*
       * `?create=1` is a new resume, and a new resume does not land on top
       * of an old one.
       *
       * This route writes the file whatever is there, which is right for a
       * save of the resume you are editing and wrong for "Save as
       * variation": a filename or a name that another resume already had
       * replaced that resume, silently, with the copy.
       */
      if (req.query.create === '1') {
        const resumes = store.loadResumes();
        const sameFile = resumes.find((r) => r.id === spec.id);
        const sameName = spec.label ? resumes.find((r) => sameResumeName(r.label ?? r.id, spec.label!)) : undefined;
        const clash = sameFile ?? sameName;
        if (clash) {
          res.status(409).json({
            error: sameFile
              ? `A resume is already saved as “${spec.id}”. Choose another filename.`
              : `A resume called “${clash.label ?? clash.id}” already exists. Choose another name.`,
          });
          return;
        }
      }

      /*
       * `?existing=1` writes over a resume that is there, and nothing else.
       *
       * The editor's auto-save sends it. A resume deleted elsewhere while an
       * edit to it was waiting on its save — another tab, the CLI, the
       * extension's card throwing away its copy — was put straight back by
       * that save. Refused, the editor says the edit was not kept and moves
       * on (see `resumeGone` in web/app.js). Checked with nothing awaited
       * between here and the write.
       */
      if (req.query.existing === '1' && !store.loadResumes().some((r) => r.id === spec.id)) {
        res.status(404).json({ error: `There is no resume “${spec.id}” in the save any more.` });
        return;
      }

      /*
       * A write that still says `extends` is folded before it lands.
       *
       * Resumes stand alone, but this endpoint is what the CLI, the MCP tools
       * and any older client write through, and one of those may still be
       * sending the shape a previous version used. Refusing it would break a
       * client for saying something that used to be true; storing it would
       * put a field back on disk that nothing downstream reads, so the resume
       * would silently lose whatever the base was contributing. Folding it in
       * writes down exactly what that client meant.
       */
      const flat = spec.extends ? flattenOne(spec, store.loadResumes()) : spec;

      /*
       * `?basedOn=<version>`: written only over the write it was made on.
       *
       * The editor's auto-save sends the version its copy of the resume came
       * with (`versions` in `GET /store`, then this route's `ETag`). JobHelper's
       * card files the same copy whole with every stage, and a stage landing
       * while an edit here waited on its save was written away by that save —
       * or the other way round. Refused with 409, the resume as it is and its
       * version, and the editor rebases its edit onto it. Before `order`, so a
       * save refused here is not counted as one written. A save sent on the
       * way out of the page, while the page's save ahead of it was still out,
       * is based on the write that one was based on: see `ownWriteSince`.
       */
      const basedOn = typeof req.query.basedOn === 'string' && req.query.basedOn ? req.query.basedOn : undefined;
      const order = savedOrderOf(req.query.order);
      if (!(basedOn && order && ownWriteSince(flat.id, order, basedOn)) && movedOn(res, flat.id, basedOn)) return;
      /** What this route answers with besides the resume: which write it is. */
      const tag = () => {
        const version = resumeVersion(flat.id);
        if (version) res.setHeader('ETag', `"${version}"`);
      };

      /*
       * `?order=<page>:<n>`: a save older than one already written from the
       * same page is not written.
       *
       * The editor sends its saves of a resume one at a time, except on the
       * way out of the page, where the latest edit is sent while the save
       * ahead of it is still out (see `autoSave` in web/app.js). The two can
       * arrive either way round, and the older one arriving second would
       * write the resume back to before the edit. It is answered with what
       * is stored, as every reply here is what was actually saved. Only saves
       * from one page are compared: another tab, or the page after a reload,
       * has its own count, and a save without `order` — the CLI, MCP, the
       * extension, an older page — is written as it always was. Checked and
       * recorded with nothing awaited between here and the write, which
       * `withCommit` makes before its first await.
       */
      if (order) {
        const last = lastSaveOrder.get(flat.id);
        if (last && last.page === order.page && order.n <= last.n) {
          tag();
          res.json(store.loadResumes().find((r) => r.id === flat.id) ?? flat);
          return;
        }
        lastSaveOrder.set(flat.id, order);
      }

      // `?commit=0` writes without committing. The editor auto-saves as you
      // work, and a commit per keystroke would bury the history it feeds; it
      // commits once the editing stops, through /store/save.
      const wantCommit = req.query.commit !== '0' && req.query.commit !== 'false';
      // Tagged as written, before the commit's awaits let another write in.
      await withCommit(repo, autoCommit() && wantCommit, `Update resume "${flat.id}"`, () => {
        store.saveResume(flat);
        tag();
        // What the next save from this page may be based on: see `ownWriteSince`.
        const made = resumeVersion(flat.id);
        if (order && basedOn && made) lastConditionalSave.set(flat.id, { ...order, basedOn, made });
        else lastConditionalSave.delete(flat.id);
      });
      res.json(flat);
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
      /*
       * A cast is not a check, as on `PUT /answers`: `[]` or `{}` was written
       * over profile.yaml and read back as a placeholder name and nothing
       * else. The editor always sends the whole profile, name included.
       */
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new Error('The profile has to be an object');
      }
      if (profile.name === undefined || profile.name === null) throw new Error('The profile needs a name');
      // `?commit=0` for the editor's inline edits, which commit on idle like
      // every other auto-save rather than once per keystroke.
      const wantCommit = req.query.commit !== '0' && req.query.commit !== 'false';
      /*
       * The profile alone, not `store.load()`: the version is of this one
       * file, and loading the whole store to look at it — twice per write —
       * made every profile save cost as much as reading every resume.
       * `loadProfile` normalises exactly as `load` does, so the versions are
       * the ones `GET /store` reports.
       */
      if (wholeMovedOn(res, 'Your profile', req.query.basedOn, store.loadProfile())) return;
      await withCommit(repo, autoCommit() && wantCommit, 'Update profile', () => store.saveProfile(profile));
      // Which version this write made, for the next one to be based on: the
      // profile just written, as a read of it hands it back.
      res.setHeader('ETag', `"${contentVersion(store.loadProfile())}"`);
      res.json(profile);
    }),
  );

  /**
   * Which version of an entry the store holds: a short string that changes
   * whenever the entry does. Null when there is no such entry.
   *
   * Of the entry's content, not of its file, as `resumeVersion` is: entries
   * share a file per section, and a save of one entry in it is no reason to
   * refuse an edit of its neighbour. Keys sorted, so a hand edit that only
   * reorders them is not a change either. Read by the entry PUT and, for
   * every entry, by `GET /store`.
   */
  const entryVersion = (entry: Entry | undefined | null): string | null => (entry ? contentVersion(entry) : null);

  api.put(
    '/entries/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const body = req.body as Partial<Entry>;

      /*
       * What the caller did not mention stays as the store had it.
       *
       * `normalizeEntry` reads an absent `bullets` as an empty list, which is
       * the right reading of a *file* — an entry written by hand with no
       * bullets has none — and the wrong reading of a request. Every field
       * here except this one survives being left out, because leaving one out
       * is what a caller does when it has nothing to say about it, and the
       * two sibling writes in this file already say so in as many words:
       * "a caller that does not mention a field is not asking for it to be
       * cleared" (`POST /applications`, and `buildBundle` for the same five
       * fields it once cleared).
       *
       * The editor always sends the whole entry, so this was not costing
       * anybody anything yet — and the moment it did it would have cost them
       * quietly, and now more than quietly: a delete cascades into the
       * resumes, so an entry PUT without its lines would take every
       * resume's selection of those lines with it, on every resume in the
       * save, in one commit. A rule the rest of the file follows is worth
       * following here before that happens rather than after.
       *
       * `[]` still clears them. Absent means "I have nothing to say about
       * the lines"; an empty list means "there are none", and an entry whose
       * lines have all been deleted has to remain sayable.
       */
      checkPeriod(body.period);
      const stored = store.load().entries.find((e) => e.id === id);
      checkDateText(body.dates, stored?.dates);
      /*
       * And the same for every other field, when the body is not a whole
       * entry.
       *
       * Only `bullets` was carried over, so `{ title }` alone dropped the
       * kind, the dates and the rest — and an entry with no kind is filed in
       * custom.yaml, out of the section it was in. A body without `kind` is
       * read as a partial and laid over what is stored. A body with one is
       * the whole entry, which is how the editor sends it, and there a field
       * left out is one cleared: `editEntry` empties a location or a subtitle
       * by deleting the key.
       */
      const base = body.kind === undefined && stored ? stored : {};
      const entry = withDatesFrom(
        {
          ...base,
          ...body,
          id,
          bullets: body.bullets ?? stored?.bullets,
        } as Entry,
        store,
      );

      /*
       * `?order=<page>:<n>`, as on the resume PUT: a save older than one
       * already written from the same page is not written.
       *
       * The editor saves an entry one write at a time, except on the way out
       * of the page, where an inline edit still queued behind a save of the
       * same entry is sent beside it (see `sendEntryEditsLeaving` in
       * web/app.js). It carries that save's edit too, so the older arriving
       * second would only take the newer edit away. It is answered with what
       * is stored. Only saves from one page are compared, and a write without
       * `order` is written as it always was. Checked and recorded with
       * nothing awaited before the write.
       */
      /*
       * `?basedOn=<version>`: written only over the entry it was made on, as
       * on the resume PUT (see `movedOn`).
       *
       * The editor sends the entry whole, and a whole entry made from an old
       * copy wrote away whatever had changed in it since: a `git pull` in a
       * terminal, another tab, a phrasing added by the extension. Fix the
       * title of an entry whose location had just been pulled in as
       * "Seattle, WA", and it went back to "Boston, MA" along with the fix.
       * Now the editor says which version of the entry its edit was made on
       * (`entryVersions` in `GET /store`, then this route's `ETag`), and an
       * entry that has moved on since is answered 409 with the entry as it
       * is and its version, for the editor to rebase its edit onto and send
       * again. Anything that sends no `basedOn` (the CLI, MCP, an older page,
       * a new entry) is not a condition, and writes as it always did. An
       * entry deleted since is not refused either, as a resume is not.
       * Before `order`, so a save refused here is not counted as one written.
       */
      const basedOn = typeof req.query.basedOn === 'string' && req.query.basedOn ? req.query.basedOn : undefined;
      const version = entryVersion(stored);
      if (basedOn && version && basedOn !== version) {
        res.status(409).json({
          kind: 'conflict',
          error: `“${stored?.title ?? id}” was changed elsewhere since this change was made to it, so it was not written.`,
          id,
          current: stored,
          version,
        });
        return;
      }

      const order = savedOrderOf(req.query.order);
      if (order) {
        const last = lastEntryOrder.get(id);
        if (last && last.page === order.page && order.n <= last.n) {
          if (version) res.setHeader('ETag', `"${version}"`);
          res.json(stored ?? entry);
          return;
        }
        lastEntryOrder.set(id, order);
      }

      await withCommit(repo, autoCommit(), `Update entry "${entry.id}"`, () => store.saveEntry(entry));
      // Which version this write made, for the editor's next save to be based on.
      const made = entryVersion(store.load().entries.find((e) => e.id === id));
      if (made) res.setHeader('ETag', `"${made}"`);
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
      // The skill groups alone, as on `PUT /profile`; see `Store.loadSkillGroups`.
      if (wholeMovedOn(res, 'The skills list', req.query.basedOn, store.loadSkillGroups())) return;
      await withCommit(repo, autoCommit(), 'Update skills', () => store.saveSkillGroups(groups));
      res.setHeader('ETag', `"${contentVersion(store.loadSkillGroups())}"`);
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
          // Why a pull or a clone switched the AI off on this machine, if one did. See `aiCommandChange`.
          aiSwitchedOff: aiSwitchedOff(store.root) ?? null,
          engine: Boolean(process.env.RMM_LATEX_ENGINE),
          /*
           * And the one setting whose effect depends on which CLI is
           * configured. "Let it look up the company online" is drawn for all
           * of them and only decides anything for the one whose deny list is
           * ours to write — see `researchIsOurs`. The box promised in both
           * directions, and the direction that would be believed is the one
           * it could not keep: "off: it works only from the posting and what
           * you have written".
           */
          research: !researchIsOurs(c.ai.command),
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

  /**
   * What this installed CLI and this account can actually choose.
   *
   * Usually the command is opened in a pseudo-terminal and its preset-specific
   * model command (for example `/model`) is typed into it. A native,
   * account-aware listing subcommand is used when the CLI provides one. This
   * intentionally does not use `--help`: help describes a flag, while these
   * sources contain the choices the signed-in account can actually use.
   */
  /**
   * What the AI is doing, and what it did last time.
   *
   * The question this answers is the one a timeout cannot: was it working, or
   * was it wedged? `lastOutputAt` settles it — a run that printed something
   * four seconds ago is thinking, and one that has said nothing at all since
   * it started is not, and only the second is a reason to look at the command
   * rather than at the clock. See `activity.ts`.
   */
  api.get(
    '/ai/activity',
    handler(async (_req, res) => {
      const now = Date.now();
      const summarise = (r: AiRun) => ({
        id: r.id,
        command: r.command,
        args: r.args,
        promptBytes: r.promptBytes,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        /** Milliseconds so far, or in total — the caller should not do this sum. */
        elapsedMs: (r.endedAt ?? now) - r.startedAt,
        /** How long since it last said anything; null when it never has. */
        quietMs: r.lastOutputAt ? now - r.lastOutputAt : null,
        outcome: r.outcome ?? 'running',
        note: r.note,
        bytes: r.bytes,
      });
      res.json({ running: running().map(summarise), recent: recentRuns().map(summarise) });
    }),
  );

  /** One run, with the tail of what it actually said. */
  api.get(
    '/ai/activity/:id',
    handler(async (req, res) => {
      const found = findRun(String(req.params.id));
      if (!found) throw new Error(`No AI run "${req.params.id}" is still held`);
      res.json({
        ...found,
        elapsedMs: (found.endedAt ?? Date.now()) - found.startedAt,
        outcome: found.outcome ?? 'running',
      });
    }),
  );

  /*
   * A POST, though it changes nothing: it runs a program. As a GET it was
   * outside the Origin guard, so an `<img src>` on any page could have it run
   * any binary named codex, claude, gemini or agy from any path. Now the
   * guard applies, and the command is the configured one or a known CLI by
   * its bare name — see `commandToAsk`.
   */
  api.post(
    '/ai/models',
    handler(async (req, res) => {
      const command = commandToAsk((req.body as { command?: unknown } | undefined)?.command, store.loadConfig().ai.command);
      res.json(await listModels(command, store.root));
    }),
  );

  api.put(
    '/config',
    handler(async (req, res) => {
      const patch = req.body as Parameters<typeof store.saveConfig>[0];
      checkConfigPatch(patch);
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

      /*
       * Asked, and answered even when git will not answer.
       *
       * `pending()` refuses to report an empty list when it could not look —
       * an empty list is what `rmm save` used to call "already saved". This
       * panel is where somebody goes to find out what is wrong with their
       * save, so it is the one place that has to keep rendering: the list
       * empty, with the reason beside it, rather than an error where the
       * diagnostics should be.
       */
      let pending: Awaited<ReturnType<typeof repo.pending>> = [];
      let pendingError: string | undefined;
      try {
        pending = await repo.pending();
      } catch (err) {
        pendingError = err instanceof Error ? err.message : String(err);
      }

      res.json({
        dir: store.root,
        isRepo: await repo.isRepo(),
        commits: (await repo.log(1)).length,
        remote,
        pending,
        // Empty above because git refused, not because there is nothing.
        pendingError,
        // Why the history stopped recording, when it has. See
        // `Repo.lastCommitError`.
        lastCommitError: repo.lastCommitError,
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
      // After the writes it names, when it names any. See `allAnswered`.
      const page = typeof req.query.page === 'string' && /^[\w-]{1,64}$/.test(req.query.page) ? req.query.page : null;
      const after = String(req.query.after ?? '')
        .split(',')
        .filter((n) => /^\d{1,15}$/.test(n))
        .map(Number);
      if (page && after.length > 0) await allAnswered(page, after);
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

  /**
   * Bring the save up to date from its remote — what a second machine used
   * to do with `git pull` in a terminal while this server ran, and lost
   * tracker rows doing. See `Repo.pull`.
   *
   * Answered 200 whatever happened, as Push is: a conflict or an unreachable
   * remote is news for the person to read, in `message`, not a broken request.
   */
  api.post(
    '/config/store/pull',
    handler(async (_req, res) => {
      const result = await repo.pull();
      /*
       * Everything this process remembers about the files, forgotten, even
       * when nothing came in — a merge that was undone has rewritten the
       * files it touched, with what they held before, and that is cheap to
       * read again. The parses (`Store.forgetReads`), the printed text the
       * fit scores are built from, and the version history's resolved
       * documents, which are resolved against the live save as well as
       * the commit.
       */
      store.forgetReads();
      forgetPrintedText(store);
      documentCache.clear();
      /*
       * And what opening the save does, when something did come in: the
       * pulled files may be from a machine running an older version, and
       * the server brings a save up to date as it opens it. Awaited, so the
       * editor's reload after this sees the result; not allowed to turn a
       * pull that worked into a failed one.
       */
      /*
       * And the save read once, whole, after anything came in: a pull that
       * leaves a save the app cannot open is not one to answer `ok` for.
       * `Repo.pull` reads the files it brings in before merging them (see
       * `vetIncoming`), but the opening pass and the loaders ask more of a
       * save than that it parses — and a pull that answered "Pulled 1
       * commit" over a save every page then refused to read, with the reason
       * only in the server's console, was the bug. The pull itself is done
       * by now and is not undone; this is the person hearing why the editor
       * is about to fail, and what to fix.
       */
      if (result.ok && result.pulled > 0) {
        try {
          if (afterPull) await afterPull();
          store.forgetReads();
          store.load();
        } catch (err) {
          const said = err instanceof Error ? err.message : String(err);
          console.warn(`ResumeM-M: after the pull: ${said}`);
          res.json({
            ...result,
            ok: false,
            message:
              `${result.message} But the save will not open as it now is: ${said} ` +
              `Fix that in ${store.root} (git log shows what the pull brought in), and reload.`,
            remote: await repo.remoteStatus(),
          });
          return;
        }
      }
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
        /*
         * Whether it answered the question, which is not the same as having
         * answered at all.
         *
         * `ok` is "the command ran, exited cleanly and printed something" —
         * and a CLI that exits 0 while printing "I can't do that: this
         * action needs approval" satisfies every part of that. The panel
         * painted it green and told somebody their AI was configured, over
         * the refusal that says it is not.
         *
         * The prompt asks for one word, so the check is whether that word
         * came back. Reported separately rather than folded into `ok`: a
         * model that says "Ready!" or pads it with a sentence is working,
         * and calling a working setup broken is its own kind of wrong. What
         * this buys is that the colour stops claiming more than the reply
         * supports — see the panel, which says what it saw either way.
         */
        res.json({
          ok: true,
          saidReady: /\bready\b/i.test(result.output),
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
   *
   * The samples come back as a list with an excerpt each, never their whole
   * text. The panel shows three hundred characters of a sample and the
   * `preview` below is already capped at the context budget, so the full text
   * was sent for nobody: twenty dropped files came back as a 990KB reply, and
   * the corpus is meant to grow — "paste in an old resume, a cover letter, a
   * README" has no ceiling. A reply that large is parsed and held on the
   * thread that draws the page, which is how opening this tab became a wait
   * with nothing on screen. `GET /voice/samples/:id` has the whole of one,
   * for the editor that needs it.
   */
  api.get(
    '/voice',
    handler(async (_req, res) => {
      const data = store.load();
      const context = buildVoiceContext(data);
      res.json({
        voice: data.voice,
        samples: data.samples.map(({ text, ...rest }) => ({
          ...rest,
          chars: text.length,
          // As much as the card in the panel shows, and not a character more.
          excerpt: text.slice(0, 300),
        })),
        context: {
          chars: context.chars,
          available: context.available,
          used: context.samples.map((x) => ({ kind: x.kind, title: x.title, chars: x.text.length })),
        },
        preview: renderVoiceContext(context),
        /*
         * And the letters and answers, with whether each one counts.
         *
         * The tab used to say "letters you send and answers you save are
         * included automatically" and show none of them, so the corpus it
         * reports the size of was mostly made of things that were not on the
         * screen — and there was nowhere to say "not that one". They are the
         * bulk of most people's corpus; a panel about your voice that does
         * not list them is not about your voice.
         *
         * Names and lengths only. The bodies are already in `preview` up to
         * the budget, and sending every letter whole is the reply size that
         * made this tab a wait with nothing on it. See the note above.
         */
        writing: {
          letters: data.coverLetters.map((l) => ({
            id: l.id,
            title: l.title,
            company: l.company,
            chars: (l.body ?? '').length,
            inVoice: l.voice !== false,
          })),
          answers: data.answers.map((a) => ({
            id: a.id,
            question: a.question,
            chars: Math.max(0, ...a.variants.map((v) => String(v.text ?? '').length)),
            inVoice: a.voice !== false,
          })),
        },
      });
    }),
  );

  /**
   * Count a letter or an answer as an example of how you write, or stop.
   *
   * Its own route rather than a field on the letter and answer writes,
   * because it is its own decision and the two writes it would otherwise ride
   * on are whole-document saves: the answer bank is written as one list, so
   * "keep this answer out of my voice" would have to send every answer back
   * to say it, and a letter save would have to carry the body. One id and one
   * boolean says exactly what happened, which is also what the history reads
   * as afterwards.
   */
  api.post(
    '/voice/include',
    handler(async (req, res) => {
      const { kind, id, include } = req.body as {
        kind?: 'letter' | 'answer';
        id?: string;
        include?: boolean;
      };
      if (!id) throw new Error('An id is required');
      // Absent means yes, so the flag is only ever written when it is `false`
      // — a save keeps reading the way it always did until somebody opts one
      // thing out, and opting it back in takes the key away again.
      const wanted = include !== false;
      const keep = wanted ? undefined : false;

      if (kind === 'letter') {
        const letter = store.loadCoverLetters().find((l) => l.id === id);
        if (!letter) throw new Error(`No cover letter "${id}"`);
        const next = { ...letter, voice: keep };
        if (wanted) delete next.voice;
        await withCommit(
          repo,
          autoCommit(),
          `${wanted ? 'Count' : 'Stop counting'} "${letter.title}" as your writing`,
          // Deciding, not writing: `next` means it by leaving `voice` out.
          () => store.saveCoverLetter(next, { decidesVoice: true }),
        );
        res.json({ kind, id, inVoice: wanted });
        return;
      }

      if (kind === 'answer') {
        const answers = store.load().answers;
        const item = answers.find((a) => a.id === id);
        if (!item) throw new Error(`No answer "${id}"`);
        const next = answers.map((a) => {
          if (a.id !== id) return a;
          const copy = { ...a, voice: keep };
          if (wanted) delete copy.voice;
          return copy;
        });
        await withCommit(
          repo,
          autoCommit(),
          `${wanted ? 'Count' : 'Stop counting'} an answer as your writing`,
          () => store.saveAnswers(next),
        );
        res.json({ kind, id, inVoice: wanted });
        return;
      }

      throw new Error('kind must be "letter" or "answer"');
    }),
  );

  /** One sample, whole, for the box that edits it. */
  api.get(
    '/voice/samples/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const sample = store.load().samples.find((s) => s.id === id);
      if (!sample) {
        res.status(404).json({ error: `No writing sample "${id}"` });
        return;
      }
      res.json(sample);
    }),
  );

  /** Add or replace a writing sample. */
  api.put(
    '/voice/samples/:id',
    handler(async (req, res) => {
      const body = req.body as Partial<WritingSample>;
      if (!body.text?.trim()) throw new Error('A sample needs some text');

      const id = String(req.params.id);
      /*
       * Laid over the sample already stored, not rebuilt from a list of
       * fields. `loadSamples` keeps every key in a sample's front matter —
       * a sample is a file somebody wrote, and a key this version does not
       * know is not one to delete for them — and this route then wrote back
       * only the seven it named, so editing the text dropped the rest. A
       * field the caller sends replaces the stored one, and `null` clears it.
       */
      const stored = store.loadSamples().find((s) => s.id === id);
      const merged: Record<string, unknown> = { ...(stored ?? {}) };
      for (const key of ['writtenAt', 'tags', 'archived'] as const) {
        if (!(key in body)) continue;
        if (body[key] === null) delete merged[key];
        else merged[key] = body[key];
      }
      const sample = {
        ...merged,
        id,
        title: body.title?.trim() || stored?.title || 'Untitled',
        kind: body.kind ?? stored?.kind ?? 'other',
        text: body.text,
        createdAt: body.createdAt ?? (stored?.createdAt || new Date().toISOString()),
      } as WritingSample;
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
      const pdfPath = previewPath(store, `${slug(name) || 'preview'}${suffix}`);

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
        /*
         * Which way those went. A resume with room to spare is set larger now,
         * and its adjustments read exactly like shrinking ones — "font 10.5pt
         * → 12pt" — so the editor heads them "Enlarged to fill the page" or
         * "Squeezed to fit" off this. It was left out of the response, and
         * every resume auto-fit had enlarged was shown as squeezed.
         */
        grew: result.grew ?? false,
        engine: result.fastPath ? `${result.engine} (fast preview)` : result.engine,
        fastPath: result.fastPath,
        warnings: result.warnings,
        /*
         * The same problems again, as things the editor can offer to remove.
         *
         * `warnings` are sentences, and a sentence about an id that names
         * nothing is a dead end: the thing it points at is not in any picker,
         * because it does not exist, so there is nowhere to go and untick it.
         * This is what the warnings panel hangs its "Remove from this resume"
         * button off. See `LostReference`.
         */
        lost: resolved.lost ?? [],
        pdfUrl: `/pdf/${PREVIEW_DIR}/${path.basename(pdfPath)}`,
        // What this compile printed, so a card holding it can tell later
        // whether the store would print something else. See `/extension/fresh`.
        printed: printedFingerprint(resolved),
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
        spec?: ResumeSpec;
      };
      const data = store.load();

      const name = slug(body.draftId ?? body.letterId ?? body.company ?? 'letter') || 'letter';
      // A preview, and shared by id the same way the resume's was: two
      // letters being drafted at once, or one redrafted while the last
      // compile is still running, raced for `out/letter-<id>.pdf`.
      const pdfPath = previewPath(store, `letter-${name}`);

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
        sentWith = body.spec || body.resumeId ? resumeToWriteFrom(body, data) : undefined;
      } catch {
        sentWith = undefined;
      }
      /*
       * The letter is set on the same page as the resume it goes with, and
       * failing that on the save's own default — not on this version's, which
       * is how a letter came out at 10.5pt beside a resume the user had set
       * to 11.
       */
      const layout = sentWith?.layout ?? layoutFor(undefined, data.config?.layout);

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
        /*
         * What the engine said about the page, which the resume's preview has
         * always carried and this one did not. The one that matters is a line
         * set past the right-hand edge — see `tooWideWarnings`: whatever is
         * past the edge is not in the PDF, and a letter is where somebody
         * pastes a link.
         */
        warnings: result.warnings,
        engine: result.fastPath ? `${result.engine} (fast preview)` : result.engine,
        fastPath: result.fastPath,
        pdfUrl: `/pdf/${PREVIEW_DIR}/${path.basename(pdfPath)}`,
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
          const title = titleField === undefined ? undefined
            : typeof titleField === 'string' ? titleField
            : titleField.variants.find(v => v.id === titleField.default)?.text ?? titleField.variants[0]?.text;
          // Named by its id when it has no title, which is what this line is
          // for: a nameless entry is the one you most need pointing at.
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
        let fit: FeedbackContext['fit'];
        try {
          const compiled = await compileResume(resolved, {
            // A preview too — the critic wants a typeset page to look at, not
            // a file anybody sends — so it does not overwrite `rmm build`'s.
            pdfPath: previewPath(store, master ? 'master' : slug(resolved.id) || 'resume'),
            engine: data.config.latex.engine,
          });
          tex = compiled.tex;
          fit = {
            pages: compiled.pages,
            fits: compiled.fits,
            overflowLines: compiled.overflowLines,
            adjustments: compiled.adjustments,
            grew: compiled.grew,
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
        // Per entry as well as flat, because proposing an order means naming
        // lines of one entry and nothing else.
        bulletsByEntry: Object.fromEntries(
          data.entries.map((e) => [e.id, (e.bullets ?? []).filter((b) => !b.archived).map((b) => b.id)]),
        ),
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
                // No store data: the authoring tools read only the material
                // and the ids in `existing`. See `session-data.ts`.
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
        // Trimmed after the cut; see the note in `draftedEntry`.
        .map((v) => ({ label: String(v.label ?? '').trim() || v.text!.trim().slice(0, 24).trim(), text: v.text!.trim() }));
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
      const { job } = req.body as { resumeId?: string; spec?: ResumeSpec; job: TailorContext };
      // Without this, a missing `job` surfaced as "Cannot read properties of
      // undefined (reading 'company')", which names nothing a caller can fix.
      if (!job?.jobDescription?.trim()) throw new Error('A job description is needed to tailor against');

      const data = store.load();
      const resolved = resumeToWriteFrom(req.body, data);
      const result = await runAgent(configForTask(data.config, 'tailor'), tailorPrompt(data, resolved, job));
      if (!result.executed) return res.json({ ...result, parsed: null });

      const raw = extractJson<{ reasoning?: unknown }>(result.output);
      if (!raw) return res.json({ ...result, parsed: null });
      /*
       * Only what the store can honour, as every other way a tailoring reply
       * reaches a resume. The extension merges `choices` straight into the
       * resume it sends, and this handed the model's JSON back as it came —
       * an invented wording id, a skill named twice.
       */
      const plan = sanitizeAiPlan(raw, data);
      const parsed = {
        choices: plan.choices,
        skills: plan.skills,
        suggestions: sanitizeSuggestions(raw, data),
        reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : undefined,
        rejected: plan.rejected,
      };
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
      const { job, save, draft, feedback } = req.body as {
        resumeId?: string;
        spec?: ResumeSpec;
        job: TailorContext;
        save?: boolean;
        /** The letter in the box, and what they want changed about it. */
        draft?: string;
        feedback?: string;
      };
      const data = store.load();
      const resolved = resumeToWriteFrom(req.body, data);
      const prior = relevantLetters(data.coverLetters, { company: job.company, role: job.jobTitle });
      const revision = { draft: sentText(draft), feedback: sentText(feedback) };

      const result = await runAgent(
        configForTask(data.config, 'write'),
        coverLetterPrompt(data, resolved, job, prior, {
          tools: canWire(data.config.ai.command) && serverEntry(mcpDir) !== null,
          ...revision,
        }),
        // The draft is what is in the box, so the tools say so too: `read_work`
        // shows it as theirs, to build on rather than replace.
        writingTools(data, resolved, job, { coverLetter: { required: true, body: revision.draft ?? '' }, questions: [] }),
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
      /*
       * A draft with "[Company Name]" in it is not a finished letter. The
       * writing tools refuse one; a run without them handed it back as the
       * draft, and `save` filed it among the letters the next one is written
       * from. Flagged, and not saved.
       */
      const placeholders = placeholdersIn(body);
      const unfinished = placeholders.length > 0 ? placeholderNote('This letter', placeholders) : undefined;
      let saved: CoverLetter | undefined;
      if (save && body.trim() && !unfinished) {
        /*
         * Never over a letter an application filed. This wrote a new object
         * under `letterId` for the job and the day, which is the name
         * completing the application gives its letter, so asking for a
         * redraft after sending replaced the sent letter and took its
         * `applicationId` and its date with it. A linked letter under the
         * name is numbered past (`unclaimedLetterId`); a draft this route
         * saved before, linked to nothing, is its own to write over, and
         * keeps the date it was first written and any key somebody added to
         * its header.
         */
        const letters = store.loadCoverLetters();
        const id = unclaimedLetterId(letters, letterId(job.company, job.jobTitle));
        const before = letters.find((l) => l.id === id);
        saved = {
          ...(before ?? {}),
          id,
          // Named for the employer the address belongs to when the page never
          // said who is hiring, and never for the address — see `employerOrUnknown`.
          title: `${job.jobTitle ?? 'Role'} — ${job.company ?? employerOrUnknown(job.url)}`,
          company: job.company,
          role: job.jobTitle,
          createdAt: before?.createdAt || new Date().toISOString(),
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
        placeholders,
        ...(unfinished ? { unfinished } : {}),
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
        matches: matchAnswers(questions, data.answers, { threshold, company, employers: employersOf(store, data) }),
        bankSize: data.answers.length,
      });
    }),
  );

  /**
   * The whole written half of one application, in one run.
   *
   * The extension asked for the letter and then for each answer separately —
   * so a form with three questions was four runs of a model, each one reading
   * the same posting, the same resume and the same corpus from scratch. That
   * is four times the tokens for the same context, four times the wait, and
   * four drafts that cannot see each other: an application that says two
   * different things about why you want the job, because the letter and the
   * answer were written by two runs that never met.
   *
   * The Workspace has done it in one run since the writing tools existed; this
   * is the same thing, reachable from the card. Where the tools cannot be
   * wired — no MCP entry point, or a CLI that does not take them — the reply
   * says so and the caller falls back to the one-at-a-time routes, which still
   * exist for redrafting a single answer on its own.
   */
  api.post(
    '/extension/write',
    handler(async (req, res) => {
      const { job, letter, questions } = req.body as {
        resumeId?: string;
        spec?: ResumeSpec;
        job: TailorContext;
        letter?: { required?: boolean; body?: string };
        questions?: { id: string; question: string; answer?: string; limit?: number }[];
      };
      if (!job?.jobDescription?.trim()) throw new Error('A job description is needed to write against');

      const data = store.load();
      const resolved = resumeToWriteFrom(req.body, data);
      const prior = relevantLetters(data.coverLetters, { company: job.company, role: job.jobTitle });
      const wantsLetter = Boolean(letter?.required);
      const pending = questionsToWrite(questions);

      if (!wantsLetter && pending.length === 0) {
        res.json({ letter: null, answers: {}, priorLetters: prior, aiUsed: false });
        return;
      }

      const wired = canWire(data.config.ai.command) && serverEntry(mcpDir) !== null;
      if (!wired || !data.config.ai.enabled) {
        /*
         * Reported rather than attempted. One run is only one run when the
         * tools are there to collect the pieces; without them a single prompt
         * would have to be parsed back apart, which is the guessing this
         * replaced. The caller has the per-item routes and knows to use them.
         */
        res.json({
          letter: null,
          answers: {},
          priorLetters: prior,
          aiUsed: false,
          oneRun: false,
          why: !data.config.ai.enabled ? 'AI is switched off in ResumeM-M.' : 'This AI command cannot take the writing tools.',
        });
        return;
      }

      let aiFailed: string | undefined;
      let aiFailedKind: AgentFailure | undefined;
      let state: { letter?: string; answers?: Record<string, string> } | undefined;
      try {
        const agent = await runAgent(
          configForTask(data.config, 'write'),
          applicationWritingPrompt(data, resolved, job, { letter: wantsLetter, questions: pending }),
          writingTools(data, resolved, job, {
            coverLetter: { required: wantsLetter, body: letter?.body ?? '' },
            questions: pending,
          }),
        );
        state = agent.tools as typeof state;
      } catch (err) {
        // The same reasoning as `/extension/analyze`: a run that never started
        // is a misconfigured command, and saying so beats a 502 in front of
        // somebody halfway through an application.
        aiFailed = err instanceof Error ? err.message : String(err);
          // Which way it failed, so the card is not left guessing from the
          // English. See `AgentFailure`.
          aiFailedKind = err instanceof AgentError ? err.kind : 'failed';
      }

      const written = state?.letter?.trim();
      const answers = state?.answers ?? {};
      res.json({
        letter: wantsLetter && written ? written : null,
        answers,
        priorLetters: prior,
        aiUsed: Boolean(written) || Object.keys(answers).length > 0,
        oneRun: true,
        aiFailed,
        aiFailedKind,
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
      const { question, job, force, limit, draft, feedback } = req.body as {
        question: string;
        job?: TailorContext;
        force?: boolean;
        limit?: number;
        /** The resume going with the application — see `resumeToWriteFrom`. */
        resumeId?: string;
        spec?: ResumeSpec;
        /** The answer in the box, and what they want changed about it. */
        draft?: string;
        feedback?: string;
      };
      const data = store.load();
      const revision = { draft: sentText(draft), feedback: sentText(feedback) };
      /*
       * Who is asking, so the bank knows which answers are theirs.
       *
       * Without it every caller looks like nobody, and an answer written for
       * this very employer is read as naming "another" one — the check that
       * exists to stop Acme's letter reaching Globex, turned on Acme. It was
       * harmless only while nothing labelled its answers with a real company;
       * the card does now, so this had to follow. See `namesAnother`.
       */
      const match = matchAnswer(question, data.answers, { company: job?.company, employers: employersOf(store, data) });

      // Something to change about a draft is a redraft asked for, and the
      // bank's answer is not one.
      if (match.confident && !force && !revision.feedback && !revision.draft) {
        res.json({
          output: match.answer,
          executed: false,
          source: 'answer-bank',
          match,
        });
        return;
      }

      /*
       * The resume this answer goes beside, where the caller said which. The
       * card sends the one it is building, so the prompt can show it as what
       * the reader already has rather than leave the model to retell it from
       * memory. One that cannot be resolved is left out rather than failing an
       * answer that never needed it.
       */
      let resume: ResolvedResume | undefined;
      if (req.body.spec || req.body.resumeId) {
        try {
          resume = resumeToWriteFrom(req.body, data);
        } catch {
          resume = undefined;
        }
      }
      const result = await runAgent(
        configForTask(data.config, 'write'),
        answerPrompt(data, question, job, limit, { resume, ...revision }),
      );

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
      // The same flag the letter carries: an answer with "[Company]" in it
      // is not one to paste into a form.
      const placeholders = placeholdersIn(result.output);
      res.json({
        ...result,
        source: 'ai',
        match,
        placeholders,
        ...(placeholders.length ? { unfinished: placeholderNote('This answer', placeholders) } : {}),
      });
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
      /*
       * An SSN, a date of birth, a passport number, a home address: never
       * remembered, so never reused. See `isSensitiveQuestion`. Refused here
       * rather than silently dropped, because a silent drop reads to the
       * caller as saved — the box the person just typed into still holds it
       * for *this* application, which is untouched; only the reusable bank
       * declines it.
       */
      if (isSensitiveQuestion(question) || isSensitiveAnswer(answer)) {
        throw new Error(
          'This looks like a request for personal identifying information (an SSN, a date of ' +
            'birth, a passport number, a home address). The answer bank does not keep those, so ' +
            'it was not saved.',
        );
      }

      const answers = store.load().answers;
      /*
       * Kept as a person reads it: without the required marker a form puts
       * on it, and once, not twice. See `tidyQuestion`.
       */
      const asked = tidyQuestion(question) || question.trim();
      /*
       * Found by id when the caller has one, and otherwise by the question
       * itself — not only by id. Without this, saving a question the bank
       * already holds, from a caller that never learned its id, added a
       * second item with the same question rather than a variant of the
       * first: two competing answers to "Why do you want to work here?",
       * with `matchAnswer` seeing only whichever came first and the second
       * unreachable by anything but a fresh save. `sameQuestion` allows for
       * the whitespace and case a retyped question differs by; a real
       * change in wording is a new question and gets a new item, same as
       * always.
       */
      const existing = itemId
        ? answers.find((a) => a.id === itemId)
        : answers.find((a) => sameQuestion(a.question, question));

      if (existing) {
        /*
         * The same wording saved twice is not a second variant — it is the
         * same click landing twice, from a retry or a double submit — so it
         * is not piled on as one. It is made the default, since saving it
         * again is the caller saying this is the one to use now.
         */
        const already = existing.variants.find((v) => v.text.trim() === answer.trim());
        if (already) {
          existing.default = already.id;
          // Saved by hand: no longer an AI draft nobody has read.
          delete already.suggested;
        } else {
          // A new phrasing of a question already in the bank, not a new question.
          /*
           * Named after its label, as a person reads it. A label with nothing
           * a slug keeps ("—", "！", an emoji) made the id a bare "v_": the
           * fallback was put after the "v_" was added, where it could never
           * be reached. And a clash is settled by counting up rather than by
           * the clock, which can give the same number twice.
           */
          const stem = slug(label ?? localDay());
          const unique = newVariantId(existing.variants, stem ? `v_${stem}` : `v_${Date.now().toString(36)}`);
          existing.variants.push({ id: unique, label: label ?? 'Saved', text: answer.trim() });
          existing.default = unique;
        }
      } else {
        answers.push({
          id: answerId(asked, answers),
          question: asked,
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
      const { url, title, html, pages, baseResumeId, baseIsDefault, useAi, tailor } = req.body as {
        url?: string;
        title?: string;
        html?: string;
        /** Every page of this application, oldest first. */
        pages?: PageSource[];
        baseResumeId?: string;
        /**
         * The extension's standing default rather than a resume chosen for
         * this application. See `standingBase`.
         */
        baseIsDefault?: boolean;
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

      // When the base is read, which is what the copy is dated by. See `deriveSpec`.
      const readAt = new Date().toISOString();
      const data = store.load();
      const current = trail[trail.length - 1]!;
      // With the applicant's own terms the posting names: see `withYourTerms`.
      const job = withYourTerms(mergeJobPages(trail), data);
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

      /*
       * What this posting's copy will be called, worked out before the base
       * is chosen rather than after — because the two can be the same
       * resume, and then the copy is asked to extend itself. See
       * `baseForCopy`. It was computed further down, which is why this path
       * never had the guard the Workspace's tailor already had.
       */
      /*
       * And never a hostname. `employerFallback` hands one back where the host
       * is a system's or a board's, and it was filed as the employer:
       * "redhat.wd5.myworkdayjobs.com", "careers.activision.com". The first
       * page of the application whose address reads as a name answers — this
       * page's first, as before — and otherwise it is said to be unknown.
       */
      const employer = job.company ?? employerOrUnknown(url, ...trail.map((p) => p.url));
      /*
       * One pair of names, used for all three things that depend on them.
       *
       * The id was built from these fallbacks and `generatedFor` was written
       * from the raw `job.company` and `job.title` a few lines later, so a
       * posting whose page never names the employer — an ATS board serving a
       * form under the company's own hostname, which is the ordinary case —
       * got an id reading `job-acmecorp-…`, taken from that hostname, over a
       * record saying nothing at all.
       *
       * `generatedFor` is the only thing that can say later which posting a
       * copy belongs to. It is what `migrateTailoredIds` reads to decide
       * whether an id is one this code minted and may safely rename, and what
       * would answer the same question for anything else that has to. A
       * record that does not reproduce its own id answers nothing, and those
       * copies would have been left behind by the very rename they most need.
       */
      // Said the way the extension says it, so the tracker has one wording
      // for a page that names no job — and it says so, where "Role" read as
      // if it were one. With the job's number where the address gives one,
      // or two such forms at one employer are one application: see
      // `unnamedRole`.
      const addresses = trail.map((p) => p.url ?? (p === current ? url : undefined));
      /*
       * With the requisition number the extraction cut off it put back: two
       * requisitions under one title — "Software Engineer Intern (12345678)"
       * and "(87654321)" — are two copies and two applications, and filed as
       * the bare title the second was handed the first's copy and found as
       * its row. A number on one side only still matches the bare title, so
       * the same job read off a page without one stays one. See
       * `differentRequisitions`.
       */
      const role = withRequisition(job.title, job.requisition) ?? unnamedRole(addresses);
      /*
       * Which address says which job this is, for finding the application by
       * its number when its employer was written another way — the oldest that
       * names one, as `unnamedRole` reads them. See `sameJobAs`.
       */
      const jobAddress = addresses.find((u) => jobNumberIn(u)) ?? url;
      const specId = copyIdForPosting(data.resumes, employer, role);

      /*
       * A default never starts this posting from another posting's copy.
       * "Made for this" is asked by name, the way the copy's id is made.
       */
      const thisPosting = tailoredResumeId(employer, role);
      const asked = baseIsDefault
        ? standingBase(
            data.resumes,
            baseResumeId,
            (r) =>
              r.id === specId ||
              (Boolean(r.generatedFor?.company) &&
                (tailoredResumeId(r.generatedFor!.company!, r.generatedFor!.role ?? 'Unknown role') === thisPosting ||
                  sameIdentity(r.generatedFor!.company!, r.generatedFor!.role ?? 'Unknown role', employer, role))),
          )
        : baseResumeId;
      const baseId = baseForCopy(data.resumes, asked, specId);
      if (!baseId) throw new Error('The store has no resumes to start from');
      const base = data.resumes.find((r) => r.id === baseId);
      if (!base) {
        /*
         * Said, and named as a kind the extension can act on. The resume the
         * extension builds from is a setting, and it outlives the resume:
         * deleted, or a tailored copy the sweep took, and every card failed
         * with `No resume "job-…"` — an id nobody typed, on every posting.
         */
        res.status(400).json({
          kind: 'no-base',
          error:
            'The resume JobHelper builds from is no longer in this save. Choose another in JobHelper’s ' +
            'settings, or pin one as your base in ResumeM-M.',
        });
        return;
      }

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
          : matchVariants(data, base, {
              keywords: job.keywords,
              level: detectLevel(job),
              // The card shows each change as a box to tick, so a skill the base
              // left off can be offered here. Not in the Workspace, which applies.
              offerAdditions: true,
            });

      /*
       * And how well each of the others would have suited it.
       *
       * Computed on every analysis rather than behind its own endpoint,
       * because the card needs it at the moment the picker is drawn and that
       * is the same moment this reply arrives. It resolves each resume once,
       * which is the same work the editor's own list does.
       */
      const fit = fitResumes(data, job.keywords, undefined, store);

      let aiParsed: unknown = null;
      let aiRaw: string | undefined;
      let aiVia: 'tools' | 'json' | undefined;
      /**
       * Why the AI did not tailor this one, when it was asked to and did not.
       *
       * Reported rather than thrown. A reply that will not parse already falls
       * back to the match below — a model having a bad minute is not a reason
       * to leave somebody looking at a posting with nothing — and a run that
       * never started is the same thing from further away. It is also the more
       * likely of the two: the command is a path to a CLI on the person's own
       * machine, and `claude` not being on this process's PATH, a renamed
       * binary or a half-finished install all arrive here.
       *
       * Before this, that threw, `handler` turned it into a 502, and the
       * extension showed an error instead of a card — on every posting, until
       * the configuration was fixed, for a product that works with the AI
       * switched off entirely. The card is told `tailor: 'match'` either way,
       * so it can say the AI did not run; this says why.
       */
      let aiFailed: string | undefined;
      let aiFailedKind: AgentFailure | undefined;
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
        try {
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
                  data: tailorData(data),
                  resume: sessionResume(resolved),
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

        /*
         * Wired for tools, and neither the tools nor a reply came back.
         *
         * Then the tools were not there. Whether the flag was wrong, the CLI
         * changed its configuration key, or the server would not start, the
         * model was left in the worst of the three states this code knows
         * about: told to use tools it does not have, told not to answer in
         * prose or JSON, and — because the inventory is left out precisely
         * when the tools are supposed to carry it — with nothing to answer
         * from either. The run produced nothing and said nothing, and the
         * tailoring somebody asked for quietly did not happen.
         *
         * So it is asked again the old way, which needs no wiring and has
         * always worked. Only in this case: a run that answered costs no
         * second run, and a run that failed to start throws before here.
         */
        if (aiParsed === null && withTools) {
          const again = await runAgent(
            configForTask(data.config, 'tailor'),
            tailorPrompt(data, resolved, posting, { tools: false }),
          );
          aiRaw = again.output;
          try {
            aiParsed = extractJson(again.output);
            aiVia = 'json';
          } catch {
            aiParsed = null;
          }
        }
        } catch (err) {
          // See `aiFailed`: a run that never started is a reply that will not
          // parse, from further away. Same answer.
          aiFailed = err instanceof Error ? err.message : String(err);
          // Which way it failed, so the card is not left guessing from the
          // English. See `AgentFailure`.
          aiFailedKind = err instanceof AgentError ? err.kind : 'failed';
          aiParsed = null;
        }
      }

      // The AI selects; it never writes a resume. Everything it returns is
      // checked against the store, and anything that is not a real id it could
      // have chosen from is discarded. See jobs/aiPlan.ts.
      const plan = aiParsed ? skillsOnThePage(sanitizeAiPlan(aiParsed, data), base) : null;
      const finalMatch = plan
        ? {
            ...match,
            choices: { ...match.choices, ...plan.choices },
            skills: { ...match.skills, ...skillsInBaseOrder(plan.skills, base, data) },
          }
        : match;

      /*
       * "Apply — Unknown" was the label in the resume picker for every bare
       * application form, and there is more than one of those. Named for the
       * employer the address belongs to instead — see `employerOrUnknown`.
       */
      /* What the base asks for on skills, which is what undoing a swap restores. */
      // Each group's own section's list: a resume can hold two skills sections.
      const baseSkillItems = (groupId: string) => skillsSectionOf(base.sections, groupId)?.items?.[groupId];

      const spec = deriveSpec(base, specId, `${role} — ${employer}`, finalMatch, {
        url,
        company: employer,
        role,
        at: readAt,
      }, data.resumes);

      // Showing and hiding entries or bullets, the other half of what the AI
      // is allowed to do. Merged over whatever deriveSpec built for skills.
      const inclusion = plan ? applyInclusion(base, data, plan) : undefined;
      if (inclusion) spec.sections = withNarrowedSkills(inclusion, spec.sections);

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
         * And where the files to attach live, from the first paint.
         *
         * The flat folder is a fixed place in the save and its whole purpose
         * is to be pasted into a portal's upload dialog. The card only ever
         * learned the path from the reply to a *staging* call, so it had one
         * on the page where the resume was built and none on the form page —
         * the only page where anybody needs it — and none at all until
         * something had been built. `currentDir` is a `path.join` and a
         * `mkdir`; `syncCurrent`, which also answers this, rebuilds the whole
         * folder from the tracker and has no business running on a read.
         */
        currentDir: currentDir(store),
        /*
         * What the AI would be writing from, so the card can say it.
         *
         * A model writing a cover letter is the part of this people are
         * rightly wariest of, and the answer to that wariness — that it works
         * from their own letters, their own samples and their own notes on
         * how they write — is exactly why the banks exist. The card asks for
         * a letter and never said where one would come from.
         *
         * Counted rather than claimed, because a count is something somebody
         * can go and check, and because zero is the honest answer on the
         * first application and the one most worth showing: a letter written
         * with nothing of yours to learn from is a different offer.
         */
        voice: {
          letters: data.coverLetters.length,
          answers: data.answers.length,
          /*
           * Live samples only. An archived one is skipped everywhere the
           * writing happens — the voice context that leads every prompt drops
           * it, and so does the corpus listing — so counting it made the card
           * overstate its case in the one place the count exists to be
           * checkable.
           */
          samples: data.samples.filter((s) => !s.archived).length,
          notes: String(data.voice ?? '').trim().length > 0,
        },
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
        applied: sentBefore(data.applications, job.company, job.title && role, jobAddress),
        /*
         * And which application this page belongs to, from the first paint.
         *
         * The same reasoning as `currentDir` above, and the same bug: the
         * card only ever learned its application's name from the reply to a
         * *staging* call, so it had one on the page where the resume was
         * built and none anywhere else. Following Apply tears the card down
         * and rebuilds it, and the rebuilt one asked the store for "the files
         * of no application in particular" — which correctly answers with the
         * standing documents alone. Pressing Attach on the form, after a
         * resume had just been built and filed, said "Nothing is built yet,
         * so there is nothing to attach."
         *
         * The same three-step fallback the workspace endpoint uses, so the
         * name here is the one the stager filed the files under rather than a
         * second opinion about what this application should be called.
         *
         * And under the names the stager used, which are `employer` and `role`
         * above — what `generatedFor` carries and the extension files every
         * build, stage and send under. This asked the page's own reading
         * instead, and answered `null` whenever the page did not name both:
         * the ordinary bare form on a company's own careers host, whose
         * employer is read off the address. Measured on
         * `careers.helios-labs.com/apply/platform-engineer`: a row and a
         * workspace filed as "Helios Labs — Platform Engineer", and every
         * later analysis of that page said it belonged to no application —
         * so a card opened on it in a second tab, or from the email link,
         * had nothing to attach.
         */
        application: {
          id:
            // Not a space left over from an application that is over: see
            // `draftForJob`.
            draftForJob(store.loadDrafts(), data.applications, employer, role, jobAddress)?.id ??
            findApplication(data.applications, employer, role, jobAddress)?.id ??
            freshApplicationId(data.applications, employer, role, store.outDir()),
          /*
           * And the resume made for it, so the card can put that one first in
           * its picker: "temporary resumes created for a job application
           * should always be on the very top … when looking at that very job
           * application". Absent until one has been built.
           */
          resumeId: findApplication(data.applications, employer, role, jobAddress)?.resumeId,
        },
        score,
        kind: verdict.kind,
        why: verdict.why,
        job,
        // What each page contributed, so the card can show the trail and the
        // user can drop a page that does not belong.
        pages: job.pages,
        baseResumeId: baseId,
        baseLabel: base.label,
        /*
         * Which resume to start from, answered rather than left to the label.
         *
         * The store fills up — a new grad one, a summer intern one, one built
         * for a posting last March — and the picker listed them in the order
         * they happened to be written. So the first decision of every
         * application was made from labels alone, and the label is the one
         * thing that does not say what is in the document.
         *
         * Measured on the untouched resumes, not on what the match could do
         * with them: every one of them would gain from being matched against
         * this posting, so scoring the tailored versions would mostly measure
         * the store's stock of alternates rather than where to begin.
         *
         * `recommended` is deliberately allowed to be empty. A field where
         * nothing stands out is a real answer, and a picker that always
         * points somewhere is one nobody can trust when it does.
         */
        resumeFit: fit,
        recommended: [...recommend(fit)],
        spec,
        diff,
        // Ids are how the store refers to things; they are not how a person
        // reads a diff. Resolve each change to the words it actually swaps.
        rationale: finalMatch.rationale.map((r) => describeChange(r, data)),
        /*
         * The same thing for skills, which the rationale cannot carry.
         *
         * `rationale` is a list of `{key, from, to}` where the key names a
         * choice and the values name wordings — the shape of "this bullet said
         * that and now says this". Narrowing a skills group is not that shape:
         * it is a set of items, recorded under `sections[skills].items`, and
         * nothing about it fits a key and two strings. So skills swaps never
         * appeared in the rationale at all, the extension matched its undo
         * button to rows that had one, and every skills row came up without a
         * way back — you could undo a bullet and not the four groups swapped
         * beside it.
         *
         * Named by group as well as by id, because the row the extension is
         * matching this to is the one the *diff* wrote, and that is keyed on
         * the group's name — the diff describes the document, where a group is
         * "Languages" and not `sk_lang`.
         *
         * `from` is what the base asked for, and `null` where it asked for
         * nothing, which is a real answer and not a missing one: a group with
         * no entry under `items` prints all of its items. Undoing has to be
         * able to say that, and saying it by leaving the key out is how the
         * resolver already reads it.
         */
        skillChanges: Object.entries(finalMatch.skills).map(([groupId, to]) => ({
          groupId,
          groupName: data.skillGroups.find((g) => g.id === groupId)?.name ?? groupId,
          from: baseSkillItems(groupId) ?? null,
          to,
        })),
        entryByBullet: Object.fromEntries(
          data.entries.flatMap((e) => (e.bullets ?? []).map((b) => [b.id, e.id])),
        ),
        suggestions: sanitizeSuggestions(aiParsed, data),
        /*
         * What the sanitiser threw out of the model's plan.
         *
         * `sanitizeAiPlan` checks every id a model names against the save and
         * drops the ones that are not there — that is the whole of the rule
         * that the AI chooses between wordings and never writes one. It
         * already collected what it dropped, and the workspace route has said
         * so since it was written; this one computed exactly the same list and
         * did not send it. So a run where the model invented most of its plan
         * came back indistinguishable from a run where it chose three things,
         * and the card said "chosen by the AI" over both.
         *
         * The same fault `tailor: mode === 'ai' && !aiParsed ? 'match' : mode`
         * exists to prevent, one level down. A card cannot say what happened
         * if it is not told what happened.
         */
        rejected: plan?.rejected ?? [],
        aiReasoning: (aiParsed as { reasoning?: string } | null)?.reasoning,
        aiUsed: Boolean(aiParsed),
        // Which of the two ways the AI answered, so a run that went through
        // the tools can be told apart from one that got lucky with JSON.
        aiVia,
        aiRaw: aiParsed ? undefined : aiRaw,
        // Why it did not run, when it was asked to and did not start at all —
        // almost always the configured command not being there. The proposal
        // below is the keyword match, which is a good resume; this is so the
        // card can say the AI is misconfigured rather than leave the person
        // wondering why the star never lights up.
        aiFailed,
        aiFailedKind,
        // What was actually done, not what was asked for: an AI run that came
        // back unusable falls through to the keyword match, and the card has
        // to be able to say so.
        tailor: mode === 'ai' && !aiParsed ? 'match' : mode,
      });
    }),
  );

  /** Everything the extension needs to fill a form without asking again. */
  /**
   * Which wordings the resume being sent uses, read off `?choices=`.
   *
   * JSON, because a resume's `choices` is a map and a query string is not.
   * Anything that is not a plain map of strings to strings is ignored rather
   * than refused: the fields answer perfectly well from the defaults, and a
   * form half-filled from defaults beats one not filled at all because the
   * extension sent something odd.
   */
  const choicesFrom = (raw: unknown): Record<string, string> => {
    if (typeof raw !== 'string' || !raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (kv): kv is [string, string] => typeof kv[1] === 'string',
        ),
      );
    } catch {
      return {};
    }
  };

  /**
   * What a form can be filled from, as one resume says it.
   *
   * Shared by the two ways of asking: a GET naming the wordings in `choices`,
   * which is how the extension asked before it sent the resume itself, and a
   * POST carrying the resume — which is also what the work history needs.
   */
  const autofillFor = (data: StoreData, choices: Record<string, string>, resume?: ResolvedResume) => {
    /*
     * Two names, and the form decides which box gets which.
     *
     * The legal name is the profile's own — its default, or the alternate
     * whose label says "legal" — and the preferred one is the name the resume
     * being sent prints. A form asking for a legal name gets the first; a
     * plain "Name" gets the second unless the form has a box of its own for
     * a preferred name, in which case the plain one is the legal box. That
     * choice is made in the extension, which can see the form; this only says
     * what both names are. See `preferredNameFields`.
     */
    const p = resolveProfile(data.profile, legalNameChoice(data.profile), []);
    const printed = resolveProfile(data.profile, choices, []).name;
    return {
      fields: {
        full_name: p.name,
        email: p.email,
        phone: p.phone,
        linkedin: p.linkedin,
        github: p.github,
        website: p.website,
        location: p.location,
        /*
         * And the parts of those two that forms actually ask for.
         *
         * No ATS asks for a full name or a location: they ask for First
         * name and Last name, and for City, State and Country, and they
         * mark them required. The extension has always recognised those
         * labels — `FIELD_PATTERNS` in its autofill.js has had all five
         * keys from the start — and the store had nothing to offer them,
         * so the commonest boxes on an application form came out empty on
         * a profile that plainly knew the answers. Every test store had
         * them typed in as extras, which is what hid it.
         *
         * Before the hand-entered extras, never after: a value somebody
         * typed is a decision and this is only a reading. See
         * `derivedAutofill`, which yields nothing at all where the reading
         * is not plain.
         */
        ...derivedAutofill({ name: p.name, location: p.location }, data.entries, choices),
        ...preferredNameFields(printed, p.name),
        ...(p.autofill ?? {}),
      },
      answers: data.answers.map((a) => ({
        id: a.id,
        question: a.question,
        answer: (a.variants.find((v) => v.id === a.default) ?? a.variants[0])?.text ?? '',
      })),
      /*
       * The jobs this resume lists, for a form's work-history blocks. See
       * `workHistory`: this resume's jobs and the lines it prints, never a
       * description anybody wrote for the form.
       */
      history: resume ? workHistory(resume) : [],
      /*
       * And its schools, for an Education section that takes one per block
       * and has an "Add another" for the next. See `educationHistory`: this
       * resume's educations in its order, read as the fields above read the
       * newest one. Resolved from the resume being sent, as the history is,
       * and empty where none is — asked the old way, the form gets the one
       * education in `fields` and nothing more, exactly as before.
       */
      education: resume ? educationHistory(resume, data.entries) : [],
    };
  };

  api.get(
    '/autofill',
    handler(async (req, res) => {
      const data = store.load();
      res.json(autofillFor(data, choicesFrom(req.query.choices)));
    }),
  );

  /**
   * The same, for the resume being sent.
   *
   * POST because the card's resume is a proposal the store has not been given
   * — the reason the writing routes take a `spec` — and a whole resume does
   * not belong in a query string. The wordings come from it, and so do the
   * jobs a work-history section asks for. A resume that cannot be resolved
   * costs the form its history and its schools, and nothing else.
   */
  api.post(
    '/autofill',
    handler(async (req, res) => {
      const data = store.load();
      const asked = (req.body ?? {}) as { resumeId?: unknown; spec?: unknown; choices?: unknown };
      /*
       * And, naming none, the resume this save starts from.
       *
       * Autofill pressed on a form the card never built a resume for, with no
       * resume picked in the popup, asked with nothing named — and was given
       * the profile and no resume at all, so no schools and no jobs: a
       * Greenhouse form got its School from the profile and every date, and
       * every second school, left empty, with nothing said. A resume named
       * that is no longer here goes the same way. The save's own base is what
       * "my resume" means when nobody said which.
       */
      const named =
        (asked.spec && typeof asked.spec === 'object') ||
        (typeof asked.resumeId === 'string' && data.resumes.some((r) => r.id === asked.resumeId));
      const body = named ? asked : { ...asked, spec: undefined, resumeId: defaultBaseId(data.resumes) };
      let resume: ResolvedResume | undefined;
      if (body.spec || body.resumeId) {
        try {
          resume = resumeToWriteFrom(body, data);
        } catch {
          resume = undefined;
        }
      }
      const spec =
        body.spec && typeof body.spec === 'object'
          ? (body.spec as ResumeSpec)
          : data.resumes.find((r) => r.id === body.resumeId);
      const choices =
        typeof body.choices === 'string' ? choicesFrom(body.choices) : { ...(spec?.choices ?? {}) };
      res.json(autofillFor(data, choices, resume));
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
       * Where it was copied from, by the name its owner gave it.
       *
       * `copiedFrom` is an id, and the detail pane printed it raw — "Built on
       * base." is not a sentence, it is a filename with a full stop after it.
       * Resolved here because the pane has only this one response to work
       * from and no reason to hold the whole store.
       */
      const sent = app.resumeId ? (store.getResume(app.resumeId) ?? null) : null;
      const copiedFromLabel = sent?.copiedFrom
        ? (store.getResume(sent.copiedFrom)?.label ?? sent.copiedFrom)
        : undefined;

      res.json({
        application: app,
        resume: sent,
        copiedFromLabel,
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

      /*
       * "Record an application" is the manual way in, and the one place where
       * what somebody types can land on a job the tracker already knows
       * about. It used to build a whole record from the body and hand it to
       * `upsertApplication`, which replaces: type a company and role already
       * tracked from earlier the same day and the existing row was gone —
       * status back from `interview` to `applied`, the folder of sent files
       * unreachable because `snapshotDir` went with it, and the cover letter,
       * the answers and the history all replaced by one line reading
       * "Recorded".
       *
       * So the record it is about is found first — by id when one was given,
       * and otherwise the same way everything else finds it — and what was
       * typed is laid over it. Nothing is taken away by not being mentioned:
       * this form asks for four things and an application holds a dozen.
       */
      const apps = store.load().applications;
      const existing = body.id
        ? apps.find((a) => a.id === body.id)
        : findApplication(apps, body.company, body.role, body.url);

      const now = new Date().toISOString();
      const status = body.status ?? existing?.status ?? 'applied';
      // Typed, not merely present: the form sends every box it has, so an
      // empty one means "I had nothing to add here" and not "delete that".
      const typed = (was: string | undefined, before: string | undefined) =>
        was?.trim() ? was : before;
      const resumeId = body.id ? (body.resumeId ?? existing?.resumeId) : (existing?.resumeId ?? body.resumeId);
      /*
       * And a sent row moved on to another resume remembers the one it went
       * out with.
       *
       * Named by id, this route takes the resume it is given — that is what
       * the paragraph on `resumeId` below is for — and it did so on a row at
       * `interview` as readily as on one being worked on. The sweep reads
       * `resumeId` and `sentResumeIds` (see `doneAt` in tiers.ts), so the
       * resume that had actually been sent was then referenced by nothing,
       * counted as abandoned, and deleted a week later if it was a temporary
       * copy. `buildBundle` has the same rule for a sent row filed again with
       * another resume, and this is that rule: keep the old id, and say in
       * the history that it changed. Whether the row went out is asked as the
       * sweep asks it (`wentOut`), because the sweep is what this guards
       * against.
       */
      const swapped =
        existing !== undefined &&
        wentOut(existing) &&
        existing.resumeId !== undefined &&
        resumeId !== existing.resumeId;
      const sentResumeIds = swapped
        ? [...new Set([...(existing!.sentResumeIds ?? []), existing!.resumeId!])]
        : existing?.sentResumeIds;
      const label = (rid: string | undefined) =>
        (rid && store.loadResumes().find((r) => r.id === rid)?.label) || rid || 'none';
      const app: Application = {
        ...existing,
        id: existing?.id ?? body.id ?? freshApplicationId(apps, body.company, body.role, store.outDir()),
        company: body.company,
        role: body.role,
        url: typed(body.url, existing?.url),
        appliedAt: body.appliedAt ?? existing?.appliedAt ?? now,
        status,
        /*
         * The row's own, unless the request named the row by id. The editor's
         * "Record an application" sends whichever resume is open, which is a
         * fair guess for a new row and a wrong one for a row that already
         * says what it was sent with: an interview's tailored copy was
         * re-pointed at `base`, became a temporary nobody's application held,
         * and the sweep took it.
         */
        resumeId,
        source: body.source ?? existing?.source,
        notes: typed(body.notes, existing?.notes),
        answers: body.answers ?? existing?.answers,
        ...(sentResumeIds ? { sentResumeIds } : {}),
        history: [
          ...(body.history ?? [
            ...(existing?.history ?? []),
            { at: now, status, note: existing ? 'Recorded again by hand' : 'Recorded' },
          ]),
          // Even under a history the request supplied: it cannot know the
          // resume it names is not the one that went out.
          ...(swapped
            ? [{ at: now, status, note: `Resume changed after sending: ${label(existing!.resumeId)} → ${label(resumeId)}; the one that went out is kept` }]
            : []),
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
      /*
       * The one row, not every row by that name. A filter by id took both
       * copies of a row a hand-merged tracker held twice; loading now gives
       * repeats their own id (see `normalizeApplications`), and this removes
       * one row however the list came to hold it.
       */
      const at = apps.findIndex((a) => a.id === id);
      if (at < 0) throw new Error(`No application "${id}"`);
      const next = [...apps.slice(0, at), ...apps.slice(at + 1)];
      /*
       * The snapshot folder under out/ is left alone: a record of what was sent
       * is worth keeping even when the tracker row was a mistake.
       *
       * And so is the resume it was sent with. The confirm says "the files on
       * disk stay", but a temporary resume is kept only for as long as a sent
       * row names it (see `wentOut` in tiers.ts): with the row gone it read as
       * abandoned from the day it was made, and the next sweep deleted the
       * one record of what went out that the save's history holds — `out/` is
       * not tracked. So a sent row's temporary resumes are marked kept on the
       * way out, as marking one kept in the editor does. Only temporary ones:
       * a base or a kept resume is never swept, and is left exactly as it is.
       */
      const gone = apps[at]!;
      const sentWith = wentOut(gone) ? [...new Set([gone.resumeId, ...(gone.sentResumeIds ?? [])])] : [];
      const toKeep = store
        .loadResumes()
        .filter((r) => sentWith.includes(r.id) && tierOf(r) === 'temporary');
      /*
       * Its letter stays, unlinked. The letter is a letter you wrote and is
       * kept as one, but it still said `applicationId:` the row that is
       * gone: the letters view offered "application" beside it and opened
       * nothing, and anything that looks a letter up by its application —
       * completing one, `GET /letters/id` — would take it for the letter of
       * a row that only shares the id. Cleared in the same commit as the
       * row, so the history has no state with one and not the other.
       */
      const linkedLetters = store.loadCoverLetters().filter((l) => l.applicationId === id);
      await withCommit(repo, autoCommit(), `Remove application "${id}"`, () => {
        store.saveApplications(next);
        for (const letter of linkedLetters) {
          const { applicationId: _gone, ...unlinked } = letter;
          store.saveCoverLetter(unlinked);
        }
        for (const spec of toKeep) {
          spec.tier = 'extended';
          delete spec.temporaryFrom;
          store.saveResume(spec);
        }
      });
      res.json({ ok: true });
    }),
  );

  /**
   * Correct what a tracker row says it is: the company and the role.
   *
   * The names come from the page, and a page does not always say them well —
   * a season taken for the employer ("Summer 2027"), a job board ("LinkedIn"),
   * a careers site's name, a title cut off at a dash. Checked against the job
   * sites, 28 of one person's 72 rows needed one or the other, and the only
   * thing the tracker offered was Remove. The row keeps its id, so the files,
   * the snapshot and anything that points at it still find it; the space it
   * opened in the Workspace is renamed with it.
   */
  api.patch(
    '/applications/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const body = (req.body ?? {}) as { company?: unknown; role?: unknown; answers?: unknown };
      const company = typeof body.company === 'string' ? body.company.trim() : undefined;
      const role = typeof body.role === 'string' ? body.role.trim() : undefined;
      /*
       * The answers recorded on the row, as given — the one place they are
       * replaced rather than merged. A build merges what it is sent into what
       * the row holds (see `answersToKeep`), because the card sends one step
       * of a form at a time; so `[]` here is how they are cleared on purpose.
       */
      let answers: Application['answers'] | undefined;
      if (body.answers !== undefined) {
        const ok =
          Array.isArray(body.answers) &&
          body.answers.every(
            (a) => a && typeof a === 'object' && typeof (a as { question?: unknown }).question === 'string' && typeof (a as { answer?: unknown }).answer === 'string',
          );
        if (!ok) throw new Error('Answers are a list of { question, answer }');
        answers = (body.answers as { question: string; answer: string }[]).map((a) => ({ question: a.question, answer: a.answer }));
      }
      if (company === undefined && role === undefined && answers === undefined) {
        throw new Error('Say what the company or the role should be');
      }
      if (company === '' || role === '') throw new Error('A company and a role cannot be left empty');
      const apps = store.load().applications;
      const app = apps.find((a) => a.id === id);
      if (!app) throw new Error(`No application "${id}"`);
      const next: Application = {
        ...app,
        ...(company !== undefined ? { company } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(answers !== undefined ? { answers } : {}),
      };
      /*
       * And the names it had, kept as another name for it.
       *
       * The page the row came from still says them: the card still open on
       * it, and the next visit. A send under the old names found no row — on
       * an address with no job number nothing else ties the two together — and
       * filed a second one at `applied` beside this one. See `sameJobAs`.
       */
      if (!sameIdentity(app.company, app.role, next.company, next.role)) {
        const was = { company: app.company, role: app.role };
        const known = (app.aliases ?? []).some((a) => sameIdentity(a.company, a.role, was.company, was.role));
        if (!known) next.aliases = [...(app.aliases ?? []), was];
      }
      const what =
        company === undefined && role === undefined
          ? `Set the answers on application "${id}"`
          : `Rename application "${id}" to ${next.role} at ${next.company}`;
      await withCommit(repo, autoCommit(), what, () => {
        const drafts = store.loadDrafts();
        /*
         * With the row's address, as every route that files, sends or moves a
         * row looks for its space. A space opened under another spelling of
         * the employer — EA's job 216245 as "Respawn Entertainment" beside a
         * row reading "Electronic Arts" — is this job only by its number, and
         * went unrenamed. Under the old role it then stopped being this job
         * by its number too (see `sameJobAs`), so moving the row never found
         * its space again.
         */
        const space = drafts.find((d) => d.id === id) ?? draftForJob(drafts, apps, app.company, app.role, app.url);
        store.saveApplications(apps.map((a) => (a.id === id ? next : a)));
        if (space) store.saveDraft({ ...space, company: next.company, role: next.role });
      });
      res.json(next);
    }),
  );

  api.post(
    '/applications/:id/status',
    handler(async (req, res) => {
      const { status, note } = (req.body ?? {}) as { status: Application['status']; note?: string };
      // Written as given, so a missing one was filed as a stage called
      // "undefined" and a typo as a stage of its own.
      const stages: string[] = ['interested', 'applying', 'applied', 'interview', 'offer', 'closed'];
      if (typeof status !== 'string' || !stages.includes(status)) {
        throw new Error(`"${String(status)}" is not a stage — one of ${stages.join(', ')}`);
      }
      const id = String(req.params.id);
      const app = await withCommit(repo, autoCommit(), `${id}: ${status}`, () => {
        const moved = advance(store, id, status, note);
        /*
         * And back to not sent, its space goes back among the live ones.
         *
         * Every send marks the space `submitted`, and nothing ever unmarked
         * it. The card's "Not sent after all" moves the row back to
         * `applying` and says it is "back among the ones being worked on";
         * measured through the routes, the tracker read `applying` while the
         * Workspace went on listing the space under the sent ones — and
         * `retireStaleDrafts`, which lets go of sent spaces a fortnight after
         * the last keystroke, would then close the space of an application
         * still in flight. Opening it again on the page did not help either:
         * `POST /workspace` keeps a space that is already `submitted`.
         *
         * The other way too: marked as sent here, by hand, the space is
         * marked as the extension's send marks it, or it stays `drafting`
         * beside a row that went out and is never retired.
         *
         * By id first, which is how a space and the row it opened share a
         * name, and by the job's names when the row was made another way —
         * never a space of an earlier application that is over.
         */
        const unsent = status === 'interested' || status === 'applying';
        const sent = status === 'applied' || status === 'interview' || status === 'offer';
        if (unsent || sent) {
          const drafts = store.loadDrafts();
          const space =
            drafts.find((d) => d.id === moved.id) ??
            draftForJob(drafts, store.load().applications, moved.company, moved.role, moved.url);
          if (space && unsent && space.status === 'submitted') store.saveDraft({ ...space, status: 'drafting' });
          if (space && sent && space.status !== 'submitted') store.saveDraft({ ...space, status: 'submitted' });
        }
        return moved;
      });
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
  /**
   * Is what the card is holding still what the store would give it?
   *
   * The card builds a resume and keeps it — the copy, and the PDF compiled
   * from it — for as long as the posting is open. Everything it printed is
   * the store's: the entries, their bullets, the profile, the skills. Change
   * any of those in ResumeM-M, or edit the copy itself there, and the card
   * went on showing, attaching and filing the version from before, with
   * nothing to say it was out of date. Only a trip through the card's own
   * "Edit in ResumeM-M" button was ever noticed.
   *
   * So the card asks, when its tab comes back into view, and gets three
   * answers: what its copy would print now, what the store holds under the
   * copy's id, and whether the resume the copy was made from has changed
   * since it was made — which a copy, being its own resume, does not follow.
   */
  api.post(
    '/extension/fresh',
    handler(async (req, res) => {
      const { spec } = req.body as { spec?: ResumeSpec };
      if (!spec?.id) throw new Error('a resume spec is required');
      const data = store.load();
      const withIt = { ...data, resumes: [...data.resumes.filter((r) => r.id !== spec.id), spec] };
      const printed = printedFingerprint(resolveResume(spec.id, withIt));

      const stored = data.resumes.find((r) => r.id === spec.id) ?? null;
      const storedPrint = stored ? createHash('sha1').update(JSON.stringify(stored)).digest('hex') : null;
      // Which write `stored` is, for the card's next stage to be based on.
      const version = resumeVersion(spec.id);

      /*
       * The base, by when its file last changed against when the copy was
       * made. A clock rather than a fingerprint because the copy records no
       * fingerprint of its base, and a copy made before this existed has to
       * be answerable too; the file is written only when the resume is.
       */
      let base: { id: string; label: string; changed: boolean } | null = null;
      const from = spec.copiedFrom ? data.resumes.find((r) => r.id === spec.copiedFrom) : undefined;
      const made = Date.parse(spec.generatedFor?.at ?? spec.temporaryFrom ?? '');
      if (from && Number.isFinite(made)) {
        const touched = Math.max(
          0,
          ...Store.resumeFiles(from.id).map((f) => {
            try {
              return fs.statSync(path.join(store.root, f)).mtimeMs;
            } catch {
              return 0;
            }
          }),
        );
        base = { id: from.id, label: from.label ?? from.id, changed: touched > made + 1000 };
      }
      res.json({ printed, stored, storedPrint, version, base });
    }),
  );

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
      const tracked = findApplication(data.applications, body.company, body.role, body.url);
      // Not `applicationId`: a job applied for and closed earlier the same day
      // already holds the id today would make. See `freshApplicationId`.
      const id = tracked?.id ?? freshApplicationId(data.applications, body.company, body.role, store.outDir());
      const note = body.note ?? 'The form was submitted on the page';
      const now = new Date().toISOString();

      // Past `applied` already: the tracker knows more than the page does.
      const BEFORE_SENT: Application['status'][] = ['interested', 'applying'];
      if (tracked && !BEFORE_SENT.includes(tracked.status) && !closedAsStale(tracked)) {
        res.json({ application: tracked, changed: false });
        return;
      }

      const application = await withCommit(repo, autoCommit(), `${id}: applied`, () => {
        const recorded = ((): Application => {
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
        })();
        /*
         * And the draft, if there is one, stops looking like something to
         * finish — found the same way, for the same reason, and in this same
         * commit. Written after it, the move to "submitted" reached disk but
         * not the version history; given a commit of its own, every send cost
         * a second git run.
         */
        const draft = findDraft(store.loadDrafts(), body.company!, body.role!, body.url);
        if (draft && draft.status !== 'submitted') store.saveDraft({ ...draft, status: 'submitted', updatedAt: now });
        return recorded;
      });


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
      const body = req.body as Parameters<typeof buildBundle>[1] & { spec?: ResumeSpec; basedOn?: unknown };
      const { basedOn } = body;
      delete body.basedOn;

      /*
       * A stage never lands on an application already sent — checked here,
       * before anything is written, and again as the files are handed over,
       * since the send can land while this compiles. See `AlreadySent`.
       */
      const refuseAsSent = (application: Application) =>
        res.status(409).json({ kind: 'already-sent', error: new AlreadySent(application).message, application });
      const sentBefore = refusedAsSent(store, body);
      if (sentBefore) {
        refuseAsSent(sentBefore);
        return;
      }
      /*
       * And not while a pull is half done, asked before anything is written.
       *
       * Without a posting-specific spec nothing below goes through
       * `withCommit` until the end, so a bundle, a tracker row and a filed
       * workspace were all written during a merge stopped on a conflict —
       * exactly the writes the pull is about to overwrite. Refused here, a
       * refusal still means nothing was written.
       */
      repo.assertNoOutsideGit();

      // A posting-specific spec from the extension is saved first so the
      // snapshot refers to something that still exists later.
      let resumeVersionNow: string | null | undefined;
      if (body.spec) {
        // Never over a kept resume: see `copyIdFor`.
        const spec = keptSafe(body.spec as ResumeSpec);
        /*
         * And only over the write the card built on, when it says which.
         * The card looks at the store before staging and files its copy
         * whole; an edit made in ResumeM-M between the look and this write
         * was written away. Refused, nothing of the application is written,
         * and the card takes the edit (see `movedOn`).
         */
        if (movedOn(res, spec.id, basedOn)) return;
        await withCommit(repo, autoCommit(), `Add tailored resume "${spec.id}"`, () => {
          store.saveResume(spec);
          resumeVersionNow = resumeVersion(spec.id);
        });
        body.spec = spec;
        body.resumeId = spec.id;
      }

      let result: Awaited<ReturnType<typeof buildBundle>>;
      try {
        result = await buildBundle(store, body);
      } catch (err) {
        if (!(err instanceof AlreadySent)) throw err;
        refuseAsSent(err.application);
        return;
      }

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
      const opened = findDraft(store.loadDrafts(), result.application.company, result.application.role, result.application.url);
      if (opened && result.application.status === 'applied' && opened.status !== 'submitted') {
        store.saveDraft({ ...opened, status: 'submitted', updatedAt: new Date().toISOString() });
      }

      // The same files also go to the flat folder, which is the one a portal's
      // file picker should be pointed at — the archive is for later. Without
      // taking the plain names there: that is for what somebody does — copying
      // the path, opening the folder, Attach — not for a build, which a tab
      // in the background makes as its letter saves. See `uniqueNames`.
      const current = syncCurrent(store);
      if (autoCommit()) {
        await commitQuietly(repo, `Apply: ${result.application.company} — ${result.application.role}`);
      }
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
      res.json({
        ...result,
        currentDir: current.dir,
        currentProblems: current.problems,
        /*
         * And what this application's files are called there. `files` are
         * the archive's names, which are always the plain ones; in the flat
         * folder the plain name can belong to another application still being
         * worked on (see `uniqueNames`), and a card naming it would be
         * pointing the upload dialog at that application's resume.
         */
        currentFiles: current.files
          .filter((name) => current.belongsTo[name] === result.application.id)
          // Under the names they were built with, which is what the card
          // shows and hands over: "always <Firstname>-<Lastname>-<Form type>".
          .map((name) => current.builtAs[name] ?? name),
        // Which write of the copy this filed, for the card's next to be based on.
        ...(resumeVersionNow !== undefined ? { resumeVersion: resumeVersionNow } : {}),
      });
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
   * follow-up, short enough that the list is still a list of live work.
   *
   * Mostly what is lost is the editing surface and not the content: the
   * application record keeps the letter, the answers and the files exactly as
   * they went out. Mostly, because the fortnight is there for the week-later
   * follow-up — a letter rewritten because they asked for it again is in the
   * space and not in the record, and it is precisely the thing somebody would
   * come back for. So this goes through `removeWhatIsFiled`, like the resume
   * sweep: filed first, and never taken unless the version history can be
   * seen to have it.
   */
  const KEEP_SENT_FOR_DAYS = 14;

  /** Let go of the spaces that have been sent and untouched since. */
  const retireStaleDrafts = async (): Promise<void> => {
    const cutoff = Date.now() - KEEP_SENT_FOR_DAYS * 24 * 60 * 60 * 1000;
    const going = store.loadDrafts().filter((draft) => {
      if (draft.status !== 'submitted') return false;
      const touched = Date.parse(draft.updatedAt ?? '');
      // An unparseable date is not a reason to delete somebody's work.
      return Number.isFinite(touched) && touched < cutoff;
    });
    if (going.length === 0) return;

    const name = (d: Draft) => `${d.company} — ${d.role}`;
    /*
     * Asked again at the moment of deleting, from the file.
     *
     * `going` was read before the filing commit and the status check, and
     * both wait on git. The Workspace is live in that wait: a space reopened
     * or rewritten in it was answered 200 by its PUT, and then deleted from
     * the answer read before it — the edit with it. The callback below runs
     * with nothing awaited between the read and the unlink, so a space that
     * is not exactly what was found stale is left where it is.
     */
    const asFound = new Map(going.map((d) => [d.id, JSON.stringify(d)]));
    await removeWhatIsFiled(
      repo,
      store.root,
      going.map((draft) => ({ paths: [`drafts/${draft.id}.yaml`], what: draft })),
      {
        filing: `File ${going.map(name).join(', ')} before closing the space`,
        removing: (closed) =>
          `Close the workspace for ${closed.map(name).join(', ')} — sent, and quiet since`,
      },
      (draft) => {
        // Still sent, still the same `updatedAt`, and still the same space
        // in every other field — a save made with `touch: false` included.
        const now = store.getDraft(draft.id);
        if (now && JSON.stringify(now) === asFound.get(draft.id)) store.deleteDraft(draft.id);
      },
    );
  };

  /*
   * When the retiring happens: once when the save is opened, with the rest of
   * the housekeeping a save gets on the way in (`openSave`), and whenever the
   * route below is asked to.
   *
   * It used to happen on `GET /workspace`, which made reading the list a
   * write and a commit — the one GET that changed the save, and one outside
   * the Origin guard, so any page could have it delete and commit. Not fatal
   * to anything: retiring is housekeeping, and a save whose git is not
   * answering should still open. Nothing is awaited before the drafts are
   * read, so a save with nothing stale never touches git at all.
   */
  void retireStaleDrafts().catch(() => undefined);

  api.post(
    '/workspace/retire',
    handler(async (_req, res) => {
      await retireStaleDrafts().catch(() => undefined);
      res.json({ drafts: store.loadDrafts() });
    }),
  );

  api.get(
    '/workspace',
    handler(async (_req, res) => {
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
        questions?: { question: string; required?: boolean; answer?: string; limit?: number }[];
        /**
         * Nobody pressed anything: this is the extension noticing that work
         * has been done and holding a place for it. See `holdASpace`.
         */
        auto?: boolean;
        /**
         * Whether anything has been put into the employer's own form yet.
         *
         * Only meaningful beside `auto`. See the status below: an automatic
         * row is a place to write, and a place to write is not a claim that
         * somebody is applying.
         */
        actedOnForm?: boolean;
      };
      if (!body.company || !body.role) throw new Error('company and role are required');
      /*
       * A row filed without being asked has to be a row worth having.
       *
       * The company was checked and the role was taken on trust, so a tracker
       * filled up with lines nobody made: `Indeed — Now Hiring: 300 Software
       * Intern Jobs`, and a role that is two hundred characters of
       * `preview.redd.it` image url. Both are the extractor falling back to
       * whatever the page had where a title should be, and both sat in the
       * one list that is supposed to be the record of what somebody has
       * applied for.
       *
       * Only on the automatic route. Somebody typing a company and a role
       * into "Record an application" means it, however odd it looks, and
       * refusing them would be this guard deciding what counts as a job.
       */
      if (body.auto && !looksLikeAnApplication(body.company, body.role)) {
        /*
         * Answered rather than thrown, so the refusal can be named. The
         * caller holds a key against this pair to stop itself asking twice,
         * and drops it when a write fails — because a store that is not
         * running is not this application's fault and the next attempt should
         * go. A refusal is the opposite: the answer will not change, and
         * dropping the key would put this write on every keeper tick for as
         * long as the tab is open. `kind` is how the extension tells them
         * apart, the same way `no-project` and `other-save` are told apart.
         */
        res.status(400).json({
          kind: 'not-a-job',
          error:
            `"${body.company} — ${body.role}" does not read like a job, so no space was opened for it. ` +
            'Record it yourself if it is one.',
        });
        return;
      }

      const data = store.load();
      /*
       * Which space this job already has, whatever day it was opened — but
       * only its id. The draft itself is read after the slow work below, and
       * reading it here instead is precisely the bug the test named "does not
       * reopen a workspace onto what it said before" exists to catch.
       *
       * Then the tracker, the same way everything else finds a row:
       * `findApplication` is what sees past the date baked into an id, and
       * this handler was the one path that did not ask it. It minted
       * `applicationId` — today — and compared that against the tracker by id
       * below, so a job applied for yesterday and revisited today did not
       * match its own row and merely opening the workspace filed a second
       * one, `applying`, under the one that had already gone out. Yesterday's
       * row is left without a draft by ordinary things: the extension's quick
       * submit opens no workspace at all, and deleting a workspace is a
       * button.
       *
       * `freshApplicationId` rather than `applicationId` for the same reason
       * every other path uses it — apply, be turned down, and apply again to
       * the repost the same day, and today's id is already taken.
       */
      /*
       * And never a space that belongs to an application already over — see
       * `draftForJob`. Its id is that application's, and the row written
       * under it below replaced the rejection with the repost.
       */
      const id =
        draftForJob(store.loadDrafts(), data.applications, body.company, body.role, body.url)?.id ??
        findApplication(data.applications, body.company, body.role, body.url)?.id ??
        freshApplicationId(data.applications, body.company, body.role, store.outDir());

      // A posting-specific resume comes over with the draft; save it so the
      // draft refers to something that still exists later.
      let resumeVersionNow: string | null | undefined;
      if (body.spec) {
        const spec = keptSafe(body.spec);
        // Only over the write it was built on, when that is said: the card's
        // button and its keeper both file the copy here. See `movedOn`.
        if (movedOn(res, spec.id, (req.body as { basedOn?: unknown }).basedOn)) return;
        body.spec = spec;
        await withCommit(repo, autoCommit(), `Add tailored resume "${spec.id}"`, () => {
          store.saveResume(spec);
          resumeVersionNow = resumeVersion(spec.id);
        });
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
      const fresh: DraftQuestion[] = incoming.map((q, i) => {
        // Never clobber something a human has already written here.
        // `sameQuestion`, as the bank matches: "Discipline*" is "Discipline".
        const prior = existing?.questions.find((x) => sameQuestion(x.question, q.question));
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

        // See the note at the single-question endpoint: an answer written for
        // this employer must not be read as naming another one.
        const match = matchAnswer(q.question, data.answers, { company: body.company, employers: employersOf(store, data) });
        return {
          id: prior?.id ?? `q${i + 1}`,
          question: q.question,
          required: q.required,
          answer: match.confident ? (match.answer ?? '') : (prior?.answer ?? ''),
          fromAnswerId: match.confident ? match.item?.id : undefined,
          source: match.confident ? 'bank' : 'empty',
        };
      });
      // The box's limit travels with its question, whichever branch made it.
      fresh.forEach((d, i) => {
        const limit = validLimit((incoming[i] as { limit?: number }).limit) ?? d.limit;
        if (limit) d.limit = limit;
        else delete d.limit;
      });

      /*
       * What the request sends is the questions on the page in front of the
       * extension — one step of the form — not the whole form. Replacing the
       * stored list with it deleted everything written for the steps before:
       * answer step 1 in the workspace, move to step 2, and step 1's answers
       * were gone. So a stored question the request does not name is kept,
       * ahead of the ones it does (it came from an earlier step), when there
       * is anything in it worth keeping: an answer, or a hand's edit. An
       * empty one nobody touched is left to go, as before.
       *
       * Removing a question on purpose is the editor's PUT /workspace/:id,
       * which still takes the list it is given; the editor posts here only
       * to open a space.
       */
      const kept = (existing?.questions ?? []).filter(
        (x) =>
          (x.edited || x.answer?.trim()) && !incoming.some((q) => sameQuestion(q.question, x.question)),
      );
      // Ids are per draft; a new step's "q1" must not be an earlier step's.
      const taken = new Set(kept.map((x) => x.id));
      let next = 1;
      const questions: DraftQuestion[] = [
        ...kept,
        ...fresh.map((d) => {
          if (!taken.has(d.id)) {
            taken.add(d.id);
            return d;
          }
          while (taken.has(`q${next}`)) next++;
          const id = `q${next}`;
          taken.add(id);
          return { ...d, id };
        }),
      ];

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
        /*
         * A space for a job that has already gone out opens as sent.
         *
         * Filing an application marks its space submitted, which is right and
         * was the only place it happened — so it depended on the space
         * existing by then. In the extension it often does not: the card opens
         * one from a keeper that runs every two seconds, and pressing Submit
         * is faster than that. Measured on the ATS walk, eight of fourteen
         * systems came out with the tracker saying `applied` and the Workspace
         * still offering the same job as something to finish, and nothing
         * would ever have changed it — the one moment that marks a space had
         * already passed.
         *
         * Read off the tracker rather than remembered, so the two lists cannot
         * disagree about the same job whichever of them was written first.
         * `liveOneSent` covers everything past `applying`, because an
         * application at `interviewing` went out too — but only of the
         * application still live. `alreadySent` counted a rejection from
         * March, so the space for the repost opened as sent.
         */
        status:
          existing?.status === 'submitted'
            ? 'submitted'
            : liveOneSent(data.applications, body.company, body.role, body.url)
              ? 'submitted'
              : (existing?.status ?? 'drafting'),
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

      /** The tracker's side of opening a workspace. Runs inside the draft's commit. */
      const track = (): void => {

        /*
         * An application being written is already an application. Track it as
         * "applying" so the tracker shows what is in flight, not only what has
         * been sent — completing the draft moves it to "applied".
         *
         * Read here, not from `data` at the top of the handler. `data` was
         * loaded before this handler's first await, and every await here —
         * the commit above all — is a process, tens to hundreds of
         * milliseconds under load. Anything that
         * writes this row in that window is invisible to a snapshot taken
         * before it, and what followed was not a stale read but a destroyed
         * one: the row was found missing, so a *new* one was written over the
         * top, with `applying` for a status and a one-line history.
         *
         * Measured, on a store being driven by the extension: an application
         * that had been staged and then submitted came back out of this handler
         * reading `applying`, with the "Bundle created" and "applied" entries
         * gone. The tracker said an application that had gone out had not, which
         * is the failure that gets a job applied for twice.
         *
         * Nothing awaits between this read and the write below, so the two are
         * one step as far as anything else on this server is concerned.
         */
        /*
         * By identity, not by id. A draft can legitimately carry an id the
         * tracker row does not — the row may have been made by hand, or by a
         * send on a different day — and matching on the id alone meant writing
         * a second row for a job that already had one.
         */
        /*
         * What stage a row opened this way starts at.
         *
         * "Applying" is a claim about what somebody is doing, and merely having
         * a workspace is not that claim. The extension opens one as soon as a
         * resume is built, which it does on anything job-shaped you open — so
         * the tracker filled with rows nobody had started: `Indeed — Now Hiring:
         * 300 Software Intern Jobs`, a `preview.redd.it` image url, one row for
         * `NVIDIA Corporation` and another for `2100 NVIDIA USA`, every one of
         * them reading `applying` for ever. The list that is supposed to say
         * what is in flight said everything was.
         *
         * The place to write still opens at the first sign of work, because the
         * letter is drafted before the form is ever seen and putting the writing
         * surface behind the form would be backwards. It is the *stage* that
         * waits: `interested` — "Not applied" — until the extension reports
         * something actually put into the employer's boxes.
         *
         * Only on the automatic route. Pressing "Write these in ResumeM-M"
         * carries no `auto`, and somebody pressing it is applying.
         */
        const started: Application['status'] = body.auto && !body.actedOnForm ? 'interested' : 'applying';
        const note = started === 'applying' ? 'Workspace opened' : 'Workspace opened, nothing sent yet';

        const tracked = findApplication(store.load().applications, draft.company, draft.role, draft.url);
        /*
         * In the draft's commit, not after it.
         *
         * Written after that commit, a bare write here reached disk and never
         * the version history — present in every read, absent from `git log`,
         * and gone the moment the store was restored from history. Given a
         * commit of its own, every workspace opened cost two git runs, which
         * under load delayed the draft it exists to open. Called from inside
         * the draft's `withCommit`, the read above and this write happen in
         * the same synchronous step as the draft save, and one commit holds all
         * three.
         */
        if (!tracked) {
          store.upsertApplication({
              id,
              company: draft.company,
              role: draft.role,
              url: draft.url,
              status: started,
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
              history: [{ at: now, status: started, note }],
            });
        } else if (body.actedOnForm && (tracked.status === 'interested' || closedAsStale(tracked))) {
          /*
           * And the moment it stops being a bookmark, it is moved on.
           *
           * Only out of `interested`, and only ever forwards: a row that has
           * been sent, answered, or closed is past this and must not be dragged
           * back by a keeper tick on a tab somebody left open.
           */
          advance(store, tracked.id, 'applying', 'Started filling in the form');
        }
      };

      const saved = await withCommit(repo, autoCommit(), `Open workspace for ${draft.company}`, () => {
        /*
         * Sent already? Asked again here, from a fresh read, in the same
         * synchronous step as the save.
         *
         * `data` was loaded at the top of the handler, before its awaits, so a
         * send landing in between was invisible to it: the draft opened as
         * `drafting`, and the send — which had already looked for a draft and
         * found none — never came back to mark it. Measured on the parallel
         * send walk: a fast Submit left the workspace reading `drafting` under
         * an application already `applied`. The send marks its draft inside
         * its own commit callback, synchronously too, so one of the two always
         * sees the other.
         */
        if (draft.status !== 'submitted' && liveOneSent(store.load().applications, draft.company, draft.role, draft.url)) {
          draft.status = 'submitted';
        }
        const written = store.saveDraft(draft);
        track();
        return written;
      });

      res.json({
        draft: saved,
        url: `/#workspace/${encodeURIComponent(saved.id)}`,
        ...(resumeVersionNow !== undefined ? { resumeVersion: resumeVersionNow } : {}),
      });
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

      /*
       * `?order=<page>:<n>`, as on the resume PUT: a save older than one
       * already written from the same page is not written.
       *
       * The editor sends a draft's saves one at a time, except on the way out
       * of the page, where the latest is sent beside the one still out (see
       * `saveDraftNow` in web/app.js). Either can arrive first, and each
       * carries the whole draft, so the older arriving second would put the
       * letter back to what it said before. It is answered with what is
       * stored. Only saves from one page are compared, and a write without
       * `order` (the extension, a generation, an older page) is written as it
       * always was. Checked and recorded with nothing awaited before the
       * write.
       */
      const order = savedOrderOf(req.query.order);
      if (order) {
        const last = lastDraftOrder.get(id);
        if (last && last.page === order.page && order.n <= last.n) {
          res.json(existing);
          return;
        }
        lastDraftOrder.set(id, order);
      }

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
   * your own that belongs to this posting, starting as a copy of the base with
   * every selection it makes — nothing resolves through the base any more.
   *
   * It adds no opinions of its own on purpose. The point is to go and make the
   * decisions in the builder, which is why this hands back where to go.
   */
  api.post(
    '/workspace/:id/variation',
    handler(async (req, res) => {
      const draft = store.getDraft(String(req.params.id));
      if (!draft) throw new Error(`No draft "${String(req.params.id)}"`);

      const { baseResumeId, label } = req.body as { baseResumeId?: string; label?: string };
      const data = store.load();

      // What it is copied from. Never the draft's own tailored copy: that one
      // has already been narrowed for this posting, so starting from it would
      // narrow what was narrowed rather than give the variation a fair start.
      let baseId = baseResumeId ?? draft.resumeId ?? defaultBaseId(data.resumes);
      const seen = new Set<string>();
      while (baseId && data.resumes.find((r) => r.id === baseId)?.generatedFor && !seen.has(baseId)) {
        seen.add(baseId);
        baseId = data.resumes.find((r) => r.id === baseId)?.copiedFrom ?? defaultBaseId(data.resumes);
      }
      /*
       * And somewhere that is still there. A copy made from a temporary
       * resume the sweep has since taken walks back to an id with nothing
       * behind it, and "The store has no resume to start from" is not true of
       * a store full of them; the default is the answer `baseForCopy` gives.
       */
      if (!data.resumes.some((r) => r.id === baseId)) baseId = defaultBaseId(data.resumes);
      const base = data.resumes.find((r) => r.id === baseId);
      if (!base) throw new Error('The store has no resume to start from');

      // A name you would recognise in a list a month from now, and an id that
      // does not quietly overwrite the last variation made for this posting.
      const wanted = `${slug(draft.company)}-${slug(draft.role)}`.slice(0, 55) || 'variation';
      let id = wanted;
      for (let n = 2; data.resumes.some((r) => r.id === id); n++) id = `${wanted}-${n}`.slice(0, 60);

      /*
       * A copy of the base, not a link to it. What the base selects comes
       * across whole — an empty variation used to mean "everything the base
       * shows", and it has to go on meaning that now that nothing resolves
       * through the base at render time.
       */
      const spec: ResumeSpec = {
        ...base,
        id,
        label: label?.trim() || `${draft.role} — ${draft.company}`,
        copiedFrom: base.id,
        tier: 'temporary',
        generatedFor: { url: draft.url, company: draft.company, role: draft.role, at: new Date().toISOString() },
      };
      // The base's identity, as opposed to its contents, stays with the base.
      delete spec.base;
      delete spec.notes;
      delete spec.collapsed;
      delete spec.extends;

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
      // When the base is read, which is what the copy is dated by. See `deriveSpec`.
      const readAt = new Date().toISOString();
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

      /*
       * A page with nothing readable in it is not the posting. A careers site
       * rendered by JavaScript sends an empty shell to anything that does not
       * run it, and its extraction is empty; the text the draft already
       * carries — what the applicant pasted — is the posting then.
       */
      let job = extractJob(html, draft.url, `${draft.role} at ${draft.company}`);
      if (fetched && !job.description.trim() && draft.jobDescription?.trim()) {
        job = extractJob(draft.jobDescription, draft.url, `${draft.role} at ${draft.company}`);
      }
      job = withYourTerms(job, data);
      const specId = copyIdForPosting(data.resumes, draft.company, draft.role);

      /*
       * Tailoring twice must not make a resume that inherits from itself. The
       * second run finds the draft already pointing at the tailored copy, so
       * start from what that copy was built on rather than from the copy.
       */
      // The same rule as the extension's path, from one place: a copy named
      // after the posting cannot be built from itself. See `baseForCopy`.
      const baseId = baseForCopy(data.resumes, baseResumeId ?? draft.resumeId, specId);
      const base = data.resumes.find((r) => r.id === baseId);
      if (!base) throw new Error('The store has no resume to start from');

      const match = matchVariants(data, base, { keywords: job.keywords, level: detectLevel(job) });

      let plan: ReturnType<typeof sanitizeAiPlan> | null = null;
      // Why the AI did not tailor this one; see the same field on `/analyze`.
      let aiFailed: string | undefined;
      let aiFailedKind: AgentFailure | undefined;
      if (useAi && data.config.ai.enabled) {
        try {
          const agent = await runAgent(
            configForTask(data.config, 'tailor'),
            tailorPrompt(data, resolveResume(baseId!, data), {
              jobTitle: draft.role,
              company: draft.company,
              jobDescription: job.description,
              url: draft.url,
            }),
          );
          try {
            plan = skillsOnThePage(sanitizeAiPlan(extractJson(agent.output), data), base);
          } catch {
            plan = null; // a malformed reply must not sink the deterministic match
          }
        } catch (err) {
          // Nor must a run that never started. The button says "with AI", so
          // the reason comes back with the resume rather than instead of it.
          aiFailed = err instanceof Error ? err.message : String(err);
          // Which way it failed, so the card is not left guessing from the
          // English. See `AgentFailure`.
          aiFailedKind = err instanceof AgentError ? err.kind : 'failed';
          plan = null;
        }
      }

      const finalMatch = plan
        ? { ...match, choices: { ...match.choices, ...plan.choices }, skills: { ...match.skills, ...skillsInBaseOrder(plan.skills, base, data) } }
        : match;

      const spec = deriveSpec(base, specId, `${draft.role} — ${draft.company}`, finalMatch, {
        url: draft.url,
        company: draft.company,
        role: draft.role,
        at: readAt,
      }, data.resumes);
      const inclusion = plan ? applyInclusion(base, data, plan) : undefined;
      if (inclusion) spec.sections = withNarrowedSkills(inclusion, spec.sections);

      await withCommit(repo, autoCommit(), `Tailor a resume for ${draft.company}`, () => store.saveResume(spec));

      // The draft now sends this one, and keeps the posting text for the
      // letter and the answers to draw on. Those two fields, and nothing else:
      // fetching the posting and running the AI take long enough that the
      // letter and the answers on disk have moved on.
      // Never the raw markup: scripts and styles are not a posting, and every
      // letter and answer written from this draft reads what is saved here.
      const description = job.description || draft.jobDescription || '';
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
        aiFailed,
        aiFailedKind,
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
            applicationWritingPrompt(data, resolved, job, { letter: wantsLetter, questions: pending }),
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
              // Not "drafted" when it still has slots in it: say which.
              const gaps = placeholdersIn(draft.coverLetter.body);
              letterNotes.push(gaps.length ? placeholderNote('The cover letter draft', gaps) : 'Cover letter drafted in your voice.');
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

        /*
         * The resume this application goes out with, so an answer can leave
         * its lines to it — resolved once, and only if a question gets as far
         * as the AI. A resume id the store no longer has costs the answer
         * nothing but that.
         */
        let resolvedForAnswers: ResolvedResume | null | undefined;
        const draftResume = (): ResolvedResume | undefined => {
          if (resolvedForAnswers === undefined) {
            const resumeId = draft.resumeId ?? data.resumes[0]?.id;
            try {
              resolvedForAnswers = resumeId ? resolveResume(resumeId, data) : null;
            } catch {
              resolvedForAnswers = null;
            }
          }
          return resolvedForAnswers ?? undefined;
        };

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

          // Same again: this draft's own company, so its own answers count as
          // its own.
          const match = matchAnswer(q.question, data.answers, { company: draft.company, employers: employersOf(store, data) });
          if (match.confident && !overwrite) {
            q.answer = match.answer ?? '';
            q.fromAnswerId = match.item?.id;
            q.source = 'bank';
            q.needsReview = undefined;
            continue;
          }
          const agent = await runAgent(
            configForTask(data.config, 'write'),
            answerPrompt(data, q.question, job, q.limit, { resume: draftResume() }),
          );
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
          // An answer the AI left a slot in, named where it landed — see
          // `placeholdersIn`. Only one that was kept: one typed over is gone.
          const gaps = produced.source === 'ai' ? placeholdersIn(produced.answer) : [];
          if (gaps.length) notes.push(placeholderNote(`The answer to "${produced.question.length > 80 ? `${produced.question.slice(0, 79)}…` : produced.question}"`, gaps));
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
      /*
       * Before the bundle is built, not only at `reviseDraft` at the end.
       *
       * That was the first `withCommit` this route reached, after the bundle,
       * the filed letter, the tracker row and the answer bank had all been
       * written — so a merge stopped on a conflict turned an application
       * that had been filed into a 400 saying "Not saved", and it was
       * completed again into a second one.
       */
      repo.assertNoOutsideGit();

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
      let filedLetterId: string | undefined;
      if (draft.coverLetter.required && draft.coverLetter.body.trim()) {
        /*
         * Named for the role as well as the company, and numbered past a
         * letter that belongs to another application. By the day and the
         * company alone, two roles at one employer sent on one day wrote the
         * same file, and the second letter replaced the first. The same
         * application completed again writes over its own, as it always did.
         *
         * Its own is the letter already filed for this application, found by
         * its `applicationId` before any name is made up. The name has the
         * day in it, so completing again after midnight named a letter that
         * did not exist yet, and the application had two — the one its row
         * had pointed at and a second copy that took the row's link away.
         * Where an earlier run already left two, the one the row names wins.
         */
        const letters = store.loadCoverLetters();
        const mine = letters.filter((l) => l.applicationId === result.application.id);
        const own = mine.find((l) => l.id === result.application.letterId) ?? mine[0];
        let candidate = own?.id;
        if (!candidate) {
          const named = letterId(draft.company, draft.role);
          const taken = new Map(letters.map((l) => [l.id, l.applicationId]));
          candidate = named;
          for (let n = 2; taken.has(candidate) && taken.get(candidate) !== result.application.id; n++) {
            candidate = `${named}-${n}`;
          }
        }
        filedLetterId = candidate;
        const letter: CoverLetter = {
          id: filedLetterId,
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
        letterId: filedLetterId,
      };
      /*
       * Only when there is something to say. Every Complete added this line,
       * so a space with no questions — most of them — wrote "0 question(s)
       * answered" under the build's own line each time it was completed,
       * which reads as though questions were asked and skipped.
       */
      const said = [
        ...(answered.length ? [`${answered.length} question(s) answered`] : []),
        ...(draft.coverLetter.required ? ['cover letter included'] : []),
      ].join(', ');
      if (said) {
        app.history = [
          ...(app.history ?? []),
          { at: new Date().toISOString(), status: app.status, note: said.charAt(0).toUpperCase() + said.slice(1) },
        ];
      }
      store.upsertApplication(app);

      // Anything written by hand is worth having next time.
      if (saveAnswersToBank) {
        const answers = store.load().answers;
        for (const q of answered) {
          if (q.source === 'bank' && !q.edited) continue;
          // An SSN, a date of birth, a passport number, a home address: never
          // remembered, so never reused. See `isSensitiveQuestion`. The
          // application record above still keeps what was actually sent —
          // that is the history of this one application — but it does not
          // go into the bank other applications draw from.
          if (isSensitiveQuestion(q.question) || isSensitiveAnswer(q.answer)) continue;
          /*
           * An answer still word for word as the AI wrote it goes in marked
           * unread, so the next form is offered it rather than filled with
           * it. See `fileSentAnswer`. `edited` and `source: 'human'` are what
           * the Workspace sets when the person changes the text.
           */
          fileSentAnswer(answers, {
            question: q.question,
            answer: q.answer,
            fromAnswerId: q.fromAnswerId,
            label: draft.company,
            unread: q.source === 'ai' && !q.edited,
            newId: (asked) => answerId(asked, answers),
          });
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
      // Starting with the build's own, when it replaced the files of an
      // application already sent (see `replaced` in `buildBundle`).
      const warnings: string[] = result.replaced ? [result.replaced] : [];
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
      /*
       * A pull that began while the bundle compiled is still caught here, and
       * by now the application has been filed: a refusal is a warning on a
       * 200 rather than a 400 that says it was not saved.
       */
      try {
        await reviseDraft(id, `Mark ${draft.company} as submitted`, (fresh) => {
          fresh.status = 'submitted';
        });
      } catch (err) {
        if (!(err instanceof GitBusyError)) throw err;
        warnings.push(
          `The application was filed, but its space could not be marked as submitted: ${err.message}`,
        );
      }
      if (typedSince.length) {
        warnings.push(
          `The ${typedSince.join(' and ')} changed while this was compiling, so what was sent does ` +
            'not include it. The application is kept open with your latest text — read it, then ' +
            'complete it again to send that version.',
        );
      }

      if (autoCommit()) await commitQuietly(repo, `Apply: ${draft.company} — ${draft.role}`);
      res.json({
        warnings,
        application: app,
        dir: result.dir,
        currentDir: syncCurrent(store, undefined, app.id).dir,
        files: result.files,
        fits: result.fits,
        pages: result.pages,
      });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Cover letters and answers                                         *
   * ---------------------------------------------------------------- */

  /*
   * Each with its `version`, for a save to be based on — the same
   * `contentVersion` the whole-object writes use. See `PUT /letters/:id`.
   * Beside the letter's own fields, and taken off again by the PUT, so a
   * letter sent back whole does not carry it into its file.
   */
  api.get(
    '/letters',
    handler(async (_req, res) =>
      res.json(store.loadCoverLetters().map((l) => ({ ...l, version: contentVersion(l) }))),
    ),
  );

  /**
   * The id the server gives a letter for a job today: `letterId` — the day
   * on this machine's clock (`localDay`, YYYY-MM-DD, not UTC), then the
   * company and the role, each lower-cased, runs of anything but a-z and 0-9
   * made one "-", a "-" trimmed off either end, and only then cut to 30
   * characters (so a cut on a gap keeps its trailing "-"); a missing or
   * empty part is left out, and the parts are joined with "-". Asked here so a client saving a letter for a
   * job writes it under the same name completing that job's application
   * files it under, rather than computing its own and drifting.
   *
   * And not over another application's letter. That name was handed back
   * bare, and the extension's "Save to store" wrote under it — so a letter
   * saved for a second job with the same title on the same day, or for the
   * same title reposted, landed on the letter the first application had
   * filed. The caller says which application it is writing for when it
   * knows (`applicationId`), or the posting's address (`url`), which finds
   * the tracker row for it. The letter already linked to that application
   * is the answer when there is one, whatever day it was filed; otherwise
   * the name is numbered past any letter linked to a different application
   * (`unclaimedLetterId`), as completing an application numbers past one.
   * The application found is said too, for the save to carry, so the
   * letter is linked and a save that lands on another's is refused.
   */
  api.get(
    '/letters/id',
    handler(async (req, res) => {
      const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const asked = text(req.query.applicationId);
      const url = text(req.query.url);
      const apps = store.load().applications;
      /*
       * By the address alone, not by the names: a second job with the same
       * title is the case this is here for, and by name it is the first
       * job's row. Never a row that is over — the same address reposted a
       * season later is a new application, and its letter is a new letter.
       * An `applicationId` that names no row (the extension knows the id an
       * application will be filed under before it is) is no answer, and the
       * address is asked instead.
       */
      const app =
        (asked ? apps.find((a) => a.id === asked) : undefined) ??
        (url
          ? apps
              .filter((a) => sameAddress(url, a.url) && (a.status !== 'closed' || closedAsStale(a)))
              .sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))[0]
          : undefined);
      const letters = store.loadCoverLetters();
      /*
       * Only while the application has not gone out (`wentOut`: `applied`,
       * `interview`, `offer`, or closed after one of those).
       *
       * The application's own letter was the answer whatever its status, so
       * coming back to the posting after sending — to draft a follow-up, or
       * to look again — and pressing "Save to store" wrote the new text over
       * the letter that was sent, which is the one record of what the
       * employer has. Once it is sent the answer is a name of its own,
       * numbered past every linked letter, the sent one included, and the
       * application is not said: a save linked to it would read as a second
       * letter sent with it, and the next save would be refused as a change
       * to a sent letter (`PUT /letters/:id`).
       */
      const open = app && !wentOut(app) ? app : undefined;
      const linked = open ? { applicationId: open.id } : {};
      if (open) {
        const mine = letters.filter((l) => l.applicationId === open.id);
        const own = mine.find((l) => l.id === open.letterId) ?? mine[0];
        if (own) {
          res.json({ id: own.id, ...linked });
          return;
        }
      }
      const named = letterId(text(req.query.company), text(req.query.role));
      res.json({ id: unclaimedLetterId(letters, named, open?.id), ...linked });
    }),
  );

  api.put(
    '/letters/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const stored = store.loadCoverLetters().find((l) => l.id === id);
      const given = { ...((req.body ?? {}) as Partial<CoverLetter> & { applicationId?: string | null; version?: unknown }) };
      // The version `GET /letters` reads out is not part of the letter.
      delete given.version;
      /*
       * Without one, the file was written with the word "undefined" in it.
       * A letter already stored keeps the body it has when none is sent: the
       * editor sends only the fields that were changed (see `editLetter` in
       * web/app.js), and a retitle is not a request to empty the letter.
       */
      if (given.body !== undefined && typeof given.body !== 'string') throw new Error('A letter needs a body');
      if (given.body === undefined && !stored) throw new Error('A letter needs a body');

      /*
       * `?basedOn=<version>`: written only over the letter it was made on,
       * as the profile and the answer bank are (`wholeMovedOn`).
       *
       * The editor opened a letter, and whatever was saved to it while the
       * box was open — the extension's "Save to store", completing the
       * application, another tab — was written away by the box's copy when
       * it was saved, with nothing said. Now a letter that moved on is
       * answered 409 with the letter as it is and its version, for the editor
       * to make its change to and send again. No `basedOn` (the extension,
       * MCP, undo, an older page) is no condition. A letter deleted since is
       * not refused, as an entry is not.
       */
      const basedOn = typeof req.query.basedOn === 'string' && req.query.basedOn ? req.query.basedOn : undefined;
      if (basedOn && stored && contentVersion(stored) !== basedOn) {
        res.status(409).json({
          kind: 'conflict',
          error: `“${stored.title || id}” was changed elsewhere since this change was made to it, so it was not written.`,
          id,
          current: stored,
          version: contentVersion(stored),
        });
        return;
      }

      /*
       * Never another application's letter. A save that says which
       * application it is for (`applicationId`), landing on a letter linked
       * to a different one, is the extension writing one job's letter over
       * another's — see `GET /letters/id`, which no longer hands out such a
       * name, and this is for a caller that worked one out itself or a name
       * taken in between. Refused, with the letter that is there.
       */
      if (typeof given.applicationId === 'string' && given.applicationId && stored?.applicationId && stored.applicationId !== given.applicationId) {
        res.status(409).json({
          kind: 'conflict',
          error:
            `“${stored.title || id}” is the letter filed for another application, so this was not written over it. ` +
            'Save it again to file it under a name of its own.',
          id,
          current: stored,
          version: contentVersion(stored),
        });
        return;
      }

      /*
       * Never a new text for a letter that was sent. A letter linked to an
       * application that went out (`wentOut`) is what the employer was sent,
       * and a save that changes its body — an older extension's "Save to
       * store", which works the name out itself when `GET /letters/id` does
       * not answer, or any caller holding the name from before the
       * application went out — is refused with the letter that is there.
       * The editor's letters tab, where somebody opens that letter and
       * corrects it on purpose, says so with `?editSent=1`, and so does its
       * undo of such an edit. Everything else about the letter — the title,
       * the tags, the link — can still be changed.
       */
      const editSent = req.query.editSent === '1' || req.query.editSent === 'true';
      const sentWith = stored?.applicationId
        ? store.load().applications.find((a) => a.id === stored.applicationId)
        : undefined;
      if (!editSent && stored && sentWith && wentOut(sentWith) && typeof given.body === 'string' && given.body !== stored.body) {
        res.status(409).json({
          kind: 'conflict',
          error:
            `“${stored.title || id}” is the letter sent with the application to ${sentWith.company || 'this employer'}, ` +
            'so it was not written over. Save it again to file it under a name of its own.',
          id,
          current: stored,
          version: contentVersion(stored),
        });
        return;
      }

      /*
       * Over the letter already stored under this id, not in place of it.
       *
       * The extension's "save to store" sends the letter it is holding —
       * title, company, role, body — and nothing about an application, and
       * its id is the server's `letterId` for the job and the day, which is
       * the very id completing that application files its letter under. So
       * saving the letter after sending it replaced the filed one with a copy
       * that had lost its `applicationId`, and the tracker's row no longer
       * found its letter by that link. What the request names is written —
       * the newest text is the letter, and refusing it would throw away an
       * edit — and what it does not name is kept: the link, `voice`, the
       * tags. The date it was first written stays the date it was written.
       * Unlinking on purpose is saying `applicationId: null`.
       *
       * A date that is there, not merely a key: a letter whose header has
       * none reads back as `createdAt: ""`, and `??` kept the empty string
       * over every date a save offered, so the letter stayed undated for
       * good.
       */
      const letter: CoverLetter = {
        ...(stored ?? {}),
        ...(given as Partial<CoverLetter>),
        id,
        title: given.title ?? stored?.title ?? '',
        body: (given.body ?? stored?.body) as string,
        createdAt: stored?.createdAt || given.createdAt || new Date().toISOString(),
      };
      /*
       * And the optional fields as the link is: null clears one. Undo puts a
       * letter back by sending it whole (`restoreBody` in web/undo.js), and
       * a field the letter did not have before the step is sent as null, or
       * the merge above would keep what the step added.
       */
      const cleared = letter as unknown as Record<string, unknown>;
      for (const key of ['applicationId', 'company', 'role', 'tags'] as const) {
        if ((given as Record<string, unknown>)[key] === null) delete cleared[key];
      }
      await withCommit(repo, autoCommit(), `Update cover letter "${letter.id}"`, () =>
        store.saveCoverLetter(letter),
      );
      // Which version this write made, for the editor's next save to be based on.
      const made = store.loadCoverLetters().find((l) => l.id === id);
      if (made) res.setHeader('ETag', `"${contentVersion(made)}"`);
      res.json(letter);
    }),
  );

  /*
   * Take a letter out. Undo needs it: undoing a letter added by hand puts
   * back the state before it, in which there was no such letter, and every
   * other document the editor's undo restores has a DELETE for that (see
   * `restoreRequest` in web/undo.js).
   */
  api.delete(
    '/letters/:id',
    handler(async (req, res) => {
      const id = String(req.params.id);
      const removed = await withCommit(repo, autoCommit(), `Remove cover letter "${id}"`, () =>
        store.deleteCoverLetter(id),
      );
      res.json({ ok: removed });
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
      // The answer bank alone, as on `PUT /profile`; see `Store.loadAnswers`.
      if (wholeMovedOn(res, 'The answer bank', req.query.basedOn, store.loadAnswers())) return;
      await withCommit(repo, autoCommit(), 'Update answer bank', () => store.saveAnswers(answers));
      res.setHeader('ETag', `"${contentVersion(store.loadAnswers())}"`);
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
      const scan = Math.min(Math.max(want * 4, 60), 300);
      const commits = await repo.log(scan);
      /*
       * Did the window reach the beginning of the save, or merely run out?
       *
       * The window is over *all* commits, and every save in this application
       * is a commit — entries, applications, letters, answers, drafts, sweeps,
       * AI activity — so a store in regular use passes three hundred quickly.
       * Once this resume's own commits fall outside it, `previous` is still
       * undefined at the oldest commit the window holds, and `diffResumes`
       * unconditionally calls that the first version. Measured: one real edit
       * and a hundred and thirty commits touching nothing else, and the
       * timeline showed a single card reading "Unrelated note 10 — First
       * version, 4 sections, 4 bullet points". The real first version and the
       * real change were gone, the resume was said to have been created by a
       * commit that never touched it, and because the newest card is badged
       * "Current" and given no Restore button, the whole of that resume's
       * history had become unreachable.
       *
       * `log` returns fewer than asked for only when there are no more, so
       * this is the honest test.
       */
      const reachedStart = commits.length < scan;
      if (commits.length === 0) {
        res.json({ versions: [], more: false });
        return;
      }

      // A commit's contents cannot change, so the document it produced cannot
      // either: resolving one is worth doing exactly once per process. The
      // first visit to a long history pays; every visit after it is free.
      const live = store.load();

      /*
       * Blobs are content-addressed, so the same unchanged file across fifty
       * commits is read and parsed exactly once.
       *
       * Parsed, not only read. This kept the text by blob id and then parsed
       * every resume in the save again at every commit — on a save of 260
       * resumes, eighteen seconds before the timeline first opened, and
       * forty-five on a real one with a longer history, nearly all of it YAML
       * that had no bearing on the resume being asked about. `readSnapshot`
       * reads only what this resume resolves against, through one git process
       * per commit, and keeps each parse by blob id here. See snapshot.ts.
       */
      const parsed = new Map<string, ParsedYaml>();
      const snapshotAt = async (hash: string): Promise<StoreSnapshot | undefined> =>
        readSnapshot(await repo.treeAt(hash), (ids) => repo.blobs(ids), id, parsed);

      // Oldest first, so each version is diffed against the one before it.
      const chronological = [...commits].reverse();
      const versions: unknown[] = [];
      let previous: ResolvedResume | undefined;

      for (const c of chronological) {
        const key = `${id}@${c.hash}`;
        let resolved = documentCache.get(key);

        if (resolved === undefined) {
          const snapshot = await snapshotAt(c.hash);
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

        /*
         * "First version" is a claim about the save, not about the window.
         * When the window merely ran out, the oldest thing in it is the
         * oldest thing *shown* — and saying which is the difference between
         * a timeline and a timeline that has quietly lost its beginning.
         */
        const opening = previous === undefined;
        const cutOff = opening && !reachedStart;
        versions.push({
          hash: c.hash,
          date: c.date,
          message: c.message,
          label: resolved.label,
          // Nothing rather than "First version": there is no earlier document
          // here to diff against, only an earlier document we did not read.
          changes: cutOff ? [] : diffResumes(previous, resolved),
          ...(cutOff ? { earliest: true } : {}),
        });
        previous = resolved;
      }

      /*
       * Newest first for display, and say when there is more.
       *
       * Two ways for a version to be missing from this reply and the caller
       * cannot tell them apart from the list alone: the slice below, and the
       * scan window above. Both are answered by asking again with a larger
       * `limit`, so both are reported the same way.
       */
      res.json({
        versions: versions.slice(-want).reverse(),
        more: versions.length > want || !reachedStart,
      });
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
       * What is restored is this resume's own file, and nothing else. The
       * text it points at belongs to every other resume too, and silently
       * rewriting that is worse than not restoring: back when resumes
       * inherited, this walked the whole chain and wrote every ancestor back
       * at the old commit's content, so rolling one tailored variation back to
       * last week's version also rolled `base` back — and with it every other
       * variation built on `base`. A week of work on the shared resume, gone,
       * under a confirmation that said only "the current version will be
       * replaced" and a reply carrying no warnings, because the check below
       * re-resolves the restored resume, which of course now matches.
       *
       * So the result is checked against the version that was asked for, and
       * whatever still differs is named rather than forced.
       */
      /*
       * File what is about to be replaced, before replacing it.
       *
       * The confirmation says "the current version will be replaced (its own
       * history is kept, so you can still get back to it)", and that is only
       * true of a version the history actually has. Auto-commit is a setting
       * people turn off, and even left on a commit that fails is a console
       * warning with no retry — so the resume on screen can be sitting in no
       * commit at all, and rolling it back to last week would be the one act
       * in this program that cannot be undone. Refused rather than done
       * quietly: it is a button somebody pressed, and there is something they
       * can do about it.
       *
       * Only when there is something to lose. Restoring a resume that has
       * been deleted is the case this exists to serve, and there is no
       * current version of it to keep.
       */
      /*
       * Only over the resume the person chose to replace, when the editor
       * says which write that was (`basedOn`). A restore is a deliberate
       * overwrite, but of the resume as it was when the person asked for it:
       * a stage JobHelper's card filed while the dialog was open is something
       * nobody has seen, and replacing it unasked is not what was confirmed.
       * Refused, the editor says so and offers to restore anyway, based on
       * the write it was just told about. Checked here, so a refusal files
       * nothing, and again just before the write, as the filing awaits.
       */
      const { basedOn } = (req.body ?? {}) as { basedOn?: unknown };
      if (movedOn(res, id, basedOn)) return;

      const here = Store.resumeFiles(id).filter((rel) => fs.existsSync(path.join(store.root, rel)));
      if (here.length > 0) {
        await repo
          .commitAll(`File "${id}" before restoring an earlier version`, here)
          .catch(() => undefined);
        /*
         * The file as it stands, not merely a file by that name. The history
         * having *a* version of this resume is not the question — it is about
         * to be rolled back to one of those — the question is whether the one
         * being replaced is among them.
         */
        const [head] = await repo.log(1).catch(() => []);
        const tree = head ? await repo.treeAt(head.hash).catch(() => new Map()) : new Map();
        const kept = await Promise.all(
          here.map(async (rel) => {
            const objectId = tree.get(rel);
            if (!objectId) return false;
            const filed = await repo.blob(objectId).catch(() => undefined);
            return filed === fs.readFileSync(path.join(store.root, rel), 'utf8');
          }),
        );
        /*
         * The one being replaced, not any one of them.
         *
         * This was `kept.some(Boolean)` — "at least one file by this name is
         * filed" — and `resumeFiles` gives *both* spellings. A store holding
         * an untouched old `resumes/x.yml` beside a freshly edited
         * `resumes/x.yaml` satisfies `some` on the strength of the file
         * nobody is about to replace. So when the filing commit above fails
         * for one of the reasons it is allowed to (a concurrent commit, an
         * `index.lock`, a full disk — see `repo.ts`), the guard passed and
         * the edit in the `.yaml` was overwritten with no error and a 200,
         * under a button whose whole promise is that it refuses rather than
         * doing this quietly.
         *
         * `here` is in `RESUME_SPELLINGS` order and `loadResumesAsWritten`
         * takes the first that exists in that same order, so `here[0]` is
         * both the file the resolved document came from and the file
         * `saveResume` is about to write. The paragraph above already said
         * the question is whether the one being replaced is among them;
         * `some` asked a different question.
         */
        if (!kept[0]) {
          throw new Error(
            `"${id}" as it stands is not in the version history, so replacing it could not be undone. ` +
              'Save the store — Save History, under the save panel — and then restore.',
          );
        }
      }

      const tree = await repo.treeAt(hash);
      const readAt = async (file: string): Promise<string | undefined> => {
        const objectId = tree.get(file);
        return objectId === undefined ? undefined : repo.blob(objectId);
      };

      const text = await readAt(path.posix.join('resumes', `${id}.yaml`));
      const asWritten = text === undefined ? undefined : (YAML.parse(withoutBom(text)) as ResumeSpec | null);
      if (!asWritten) {
        throw new Error(`Could not read "${id}" as it was at ${hash.slice(0, 8)}`);
      }
      asWritten.id = id; // the filename remains the source of truth for the id

      /*
       * A version from before resumes were flattened, folded against the
       * resumes of *its* commit.
       *
       * That file is `extends: base` and a handful of choices, and what it
       * printed came from the base as it was then. Written back as it was, it
       * inherited again: `loadResumes` folds on read, against the base as it
       * is now — so the version came back without whatever the base had
       * since dropped, and from then on followed every later edit of the
       * base, the one thing a flattened store promises cannot happen. Folded
       * here, it is the whole document that version printed, standing alone,
       * with the base named in `copiedFrom` as every folded resume has it.
       */
      let restored = asWritten;
      if (asWritten.extends) {
        const then: ResumeSpec[] = [];
        for (const [file, objectId] of tree) {
          const named = /^resumes\/([^/]+)\.ya?ml$/.exec(file);
          if (!named) continue;
          try {
            const spec = YAML.parse(withoutBom(await repo.blob(objectId))) as ResumeSpec | null;
            if (spec && typeof spec === 'object') then.push({ ...spec, id: named[1]! });
          } catch {
            // A resume at that commit that cannot be read is one fewer to fold against.
          }
        }
        restored = flattenOne(asWritten, then);
      }

      /*
       * The tier stays the one the resume has now.
       *
       * A version is what the resume *said*, and the tier is not something it
       * says: it is how the save is organised, which is why it has its own
       * route and never rides along with an edit. The old file carries the
       * tier it had then, and writing that back put a tailored copy somebody
       * had since marked Kept back on Temporary with the clock it started on
       * a month earlier — measured, it was in `/resumes/expiring` straight
       * after the restore, and the next start swept it. The timeline shows no
       * tier change as a version, so nothing said the version being chosen
       * was one in which the resume was on its way out.
       *
       * As written, not as `loadResumes` tiers it in memory: that stamps a
       * date on read that must never reach disk. A resume that is gone keeps
       * the old version's tier, since there is nothing now to keep.
       */
      // Nothing is awaited from here to the write. The filing commit above is
      // this route's own, and does not move the version.
      if (movedOn(res, id, basedOn)) return;
      const standing = store.loadResumesAsWritten().find((r) => r.id === id);
      if (standing) {
        delete restored.tier;
        delete restored.temporaryFrom;
        delete restored.base;
        if (standing.tier !== undefined) restored.tier = standing.tier;
        if (standing.temporaryFrom !== undefined) restored.temporaryFrom = standing.temporaryFrom;
        if (standing.base !== undefined) restored.base = standing.base;
      }

      /*
       * Committed whether or not auto-commit is on, for the same reason the
       * outgoing version was filed above.
       *
       * The two used to disagree — the filing commit was unconditional and
       * this one went through `autoCommit()` — so with the setting off the
       * version being replaced was written into the history and the version
       * replacing it was not. The timeline then showed the *discarded*
       * document at the top, badged "Current" and given no Restore button,
       * with the one actually on disk sitting below it offering to be
       * restored. The restore was invisible in the history it claims to be
       * preserved by.
       *
       * Auto-commit is about keystrokes: it exists so that a sitting is one
       * version rather than one per edit. This is a button somebody pressed
       * to throw work away, which is exactly the kind of moment the history
       * is for.
       */
      await withCommit(repo, true, `Restore "${id}" to an earlier version`, () => {
        store.saveResume(restored);
        tagVersion(res, id);
      });

      /*
       * Did it land? Compare what the resume resolves to now against what it
       * resolved to then. When the two differ, the remainder of that version
       * lives in text this resume shares with others, and saying so beats
       * reporting a rollback that only half happened.
       */
      const warnings: string[] = [];
      try {
        // Only what this resume resolves against, as the timeline reads it:
        // the same document, without parsing every resume in the commit.
        const snapshot = await readSnapshot(tree, (ids) => repo.blobs(ids), id, new Map());
        // An empty snapshot resolved to nothing and was caught below, so the
        // commit with nothing to read is the same courtesy declined.
        if (!snapshot) throw new Error('Nothing to compare');
        const live = store.load();
        const then = resolveResume(id, { ...live, ...snapshot });
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
  if (!taken.some((a) => a.id === base)) return base;
  /*
   * And never one already taken. The fingerprint is of the question, so the
   * same question saved again got the same id: before a save looked an item
   * up by its question, "Discipline*" saved three times was three items all
   * called `ans_discipline-d30f07e6`.
   */
  const marked = `${base}-${fingerprint(question)}`;
  let id = marked;
  for (let n = 2; taken.some((a) => a.id === id); n++) id = `${marked}-${n}`;
  return id;
}


/** The "Copy the path" button on the flat folder's page, allowed by its hash. */
const COPY_PATH_SCRIPT = `
  document.getElementById('copy').onclick = async (ev) => {
    await navigator.clipboard.writeText(document.getElementById('path').textContent);
    ev.target.textContent = 'Copied';
  };
`;
const COPY_PATH_POLICY = `script-src 'sha256-${createHash('sha256').update(COPY_PATH_SCRIPT).digest('base64')}'; base-uri 'none'; ${FRAME_ANCESTORS}`;

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

    // Its own policy: the server's allows only the editor's inline script, and
    // this page's one button is an inline script of its own.
    res.setHeader('Content-Security-Policy', COPY_PATH_POLICY);
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
<script>${COPY_PATH_SCRIPT}</script>
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
    /*
     * Gone between the look above and the read, which the sync makes ordinary
     * — it replaces these files whenever the tracker changes. Left to Express,
     * that was its own error page naming the file's full path on this machine,
     * and an unhandled ENOENT in the log.
     */
    res.sendFile(file, (err) => {
      if (!err || res.headersSent) return;
      res.status(404).type('html').send('<p>That file is not in the folder any more.</p>');
    });
  });

  return router;
}

/**
 * Where a preview PDF goes, and why it is not `out/<id>.pdf`.
 *
 * Two different faults shared one cause: the output path was a pure function
 * of the resume id, so every writer of that resume raced for one file.
 *
 * The editor debounces its live preview at 350ms and a compile takes 0.4 to 7
 * seconds, so overlapping renders are the ordinary case rather than a corner.
 * Both wrote `out/base.pdf`; the shorter one finished last, and the request
 * that asked for the *long* document was handed a `pdfUrl` serving the short
 * one. Measured: a render answering `fits: true, pages: 1` whose own url
 * served a three-page PDF. `renderToken` in the editor guards the stale
 * *reply*; it cannot guard a file the discarded compile already overwrote.
 *
 * And `out/<id>.pdf` is what `rmm build` writes — a user-facing artifact the
 * README names, compiled with the trusted engine. A preview is compiled with
 * the fast path, which `fastCompile.ts` says in as many words must never
 * produce a file meant to leave the machine. Opening the editor replaced it.
 *
 * So previews live in their own folder, under their own names, and are swept.
 * `out/` is a folder the user opens; this one is dotted and disposable.
 */
const PREVIEW_DIR = '.previews';
const PREVIEWS_KEPT = 40;

function previewPath(store: Store, name: string): string {
  const dir = path.join(store.outDir(), PREVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });

  /*
   * Swept by count rather than by age: a compile that is still running holds
   * no lock on its file, and deleting the newest would be deleting the one
   * about to be served. Oldest first, and a generous floor — forty is a few
   * minutes of editing, and each is tens of kilobytes.
   */
  try {
    const held = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.pdf') || f.endsWith('.tex'))
      .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { f } of held.slice(PREVIEWS_KEPT * 2)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    // A folder that cannot be listed is not a reason to fail a preview.
  }

  return path.join(dir, `${name}-${randomUUID().slice(0, 8)}.pdf`);
}

/** Serve generated PDFs, constrained to the output directory. */
export function createPdfRouter(store: Store): Router {
  const router = express.Router();
  // Previews live one folder down, so they cannot collide with `out/<id>.pdf`
  // and can be swept without touching anything the user put there.
  router.get(`/${PREVIEW_DIR}/:name`, (req, res) => {
    const dir = path.join(store.outDir(), PREVIEW_DIR);
    const file = path.join(dir, path.basename(String(req.params.name)));
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.type('application/pdf').sendFile(file);
  });
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
