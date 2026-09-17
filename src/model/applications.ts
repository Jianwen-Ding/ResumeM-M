import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Store } from './store.js';
import type { Application, ApplicationStatus, ResolvedResume } from './types.js';
import { compileLetter, compileResume } from '../render/compile.js';
import { syncCurrent } from './current.js';
import { resolveResume } from './resolve.js';

/**
 * File naming is a surprising amount of the pain in applying: every portal
 * wants "Firstname Lastname Resume", and renaming a download each time is how
 * the wrong file ends up attached. Bundles are produced already named right.
 */
export function bundleFileName(name: string, company: string | undefined, kind: 'Resume' | 'Cover Letter'): string {
  const person = name.trim().replace(/\s+/g, ' ');
  /*
   * Letters and digits in any alphabet, not only `\w`, which is ASCII.
   * "Jane Doe Resume rsted.pdf" was going to Ørsted, and a company written in
   * Chinese vanished from the filename entirely — which also made two
   * applications share one name in the folder you upload from.
   *
   * The rule is otherwise the one that was already here — `\w`, plus spaces
   * and hyphens — so everything it stripped before is still stripped. Only the
   * definition of a letter has widened.
   */
  const co = company
    ?.trim()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [person, kind, co].filter(Boolean).join(' ') + '.pdf';
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * A few characters of a hash, for names a slug cannot represent.
 *
 * Ids are meant to be read in a folder listing, so the slug stays the way it
 * is. But a slug is ASCII-only: a company and role written in Chinese both
 * reduce to nothing, and every such application collapsed onto the same id —
 * one tracker row silently replacing the other, and the first one's files
 * left behind inside the second one's bundle.
 */
export function fingerprint(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 8);
}

export function applicationId(company: string, role: string, at = new Date()): string {
  const date = at.toISOString().slice(0, 10);
  const readable = `${date}-${slug(company)}-${slug(role)}`.replace(/-+$/, '');

  /*
   * The readable form is kept whenever it actually distinguishes one
   * application from another. It does not when the names have no ASCII in
   * them — the slug is empty and the id is just today's date — nor when two
   * long role names share their first sixty characters, which `slug` truncates
   * to. Both collapse two applications into one id, and an id is what the
   * tracker row, the bundle folder and the upload file are all keyed on.
   */
  const slugged = `${slug(company)}-${slug(role)}`.replace(/^-|-$/g, '');
  const faithful = slugged.length > 0 && slug(company).length < 60 && slug(role).length < 60;
  return faithful ? readable : `${readable}-${fingerprint(company, role)}`.replace(/^-+/, '');
}

export interface BundleRequest {
  company: string;
  role: string;
  url?: string;
  resumeId: string;
  /** Written alongside the resume when present. */
  coverLetter?: string;
  notes?: string;
  answers?: { question: string; answer: string }[];
  source?: string;
  status?: ApplicationStatus;
}

export interface BundleResult {
  application: Application;
  dir: string;
  files: string[];
  pages: number;
  fits: boolean;
  warnings: string[];
}

/**
 * Produce one folder holding everything an application needs, named the way
 * portals expect, plus a snapshot of the exact resume that was sent. The
 * snapshot is the point: six weeks later, when they ask about "the pipeline
 * project", the file that went out is still there, byte for byte.
 */
export async function buildBundle(store: Store, req: BundleRequest): Promise<BundleResult> {
  const data = store.load();
  const resolved: ResolvedResume = resolveResume(req.resumeId, data);

  const id = applicationId(req.company, req.role);
  const dir = path.join(store.outDir(), 'applications', id);
  fs.mkdirSync(dir, { recursive: true });

  /*
   * A rebuild replaces the bundle; it does not add to it.
   *
   * The id is company, role and date, so building the same application twice
   * in a day writes into the same folder — and every file whose name changed
   * in between was left sitting beside its replacement. Change how your name
   * is written, or rebuild without the cover letter you had before, and the
   * folder holds two resumes or an orphaned letter. Both then get copied into
   * the flat upload folder, where the whole point is that the file in front of
   * you is the one to send.
   *
   * `source/` stays: it is the archive material, and it is rewritten below.
   */
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) fs.rmSync(path.join(dir, entry.name), { force: true });
  }

  const resumeName = bundleFileName(resolved.profile.name, req.company, 'Resume');
  const pdfPath = path.join(dir, resumeName);
  const compiled = await compileResume(resolved, {
    pdfPath,
    texPath: path.join(dir, 'source', 'resume.tex'),
  });

  const files = [resumeName];

  if (req.coverLetter?.trim()) {
    const letterName = bundleFileName(resolved.profile.name, req.company, 'Cover Letter');

    // Typeset to match the resume, with the trusted engine — this is a file
    // that gets uploaded, so it never takes the preview shortcut. The plain
    // text goes alongside it, because as many portals want a letter pasted
    // into a box as want one attached.
    await compileLetter(
      {
        profile: resolved.profile,
        company: req.company,
        role: req.role,
        body: req.coverLetter,
      },
      resolved.layout,
      { pdfPath: path.join(dir, letterName), texPath: path.join(dir, 'source', 'cover-letter.tex') },
    );
    files.push(letterName);

    const textPath = path.join(dir, letterName.replace(/\.pdf$/, '.txt'));
    fs.writeFileSync(textPath, req.coverLetter, 'utf8');
    files.push(path.basename(textPath));
  }

  if (req.answers?.length) {
    const qaPath = path.join(dir, 'application-answers.md');
    fs.writeFileSync(
      qaPath,
      req.answers.map((a) => `## ${a.question}\n\n${a.answer}\n`).join('\n'),
      'utf8',
    );
    files.push(path.basename(qaPath));
  }

  // The resolved resume is stored as data too, so a past application can be
  // reopened as a starting point without re-deriving it from the store as it
  // stands today.
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'source', 'resolved.yaml'),
    YAML.stringify({ spec: store.getResume(req.resumeId), resolved }, { lineWidth: 0 }),
    'utf8',
  );

  const now = new Date().toISOString();
  const status: ApplicationStatus = req.status ?? 'applied';
  const application: Application = {
    id,
    company: req.company,
    role: req.role,
    url: req.url,
    appliedAt: now,
    status,
    resumeId: req.resumeId,
    snapshotDir: path.relative(store.outDir(), dir),
    source: req.source,
    notes: req.notes,
    answers: req.answers,
    coverLetter: req.coverLetter?.trim() || undefined,
    history: [{ at: now, status, note: 'Bundle created' }],
  };
  store.upsertApplication(application);
  // The files also land in the flat folder, ready for the upload dialog that
  // is probably already open.
  syncCurrent(store);

  return {
    application,
    dir,
    files,
    pages: compiled.pages,
    fits: compiled.fits,
    warnings: compiled.warnings,
  };
}

/** Record a status change, keeping the history rather than overwriting it. */
export function advance(store: Store, id: string, status: ApplicationStatus, note?: string): Application {
  const apps = store.load().applications;
  const app = apps.find((a) => a.id === id);
  if (!app) throw new Error(`No application "${id}"`);

  app.status = status;
  app.history = [...(app.history ?? []), { at: new Date().toISOString(), status, note }];
  store.upsertApplication(app);
  // An application that has moved past sending takes its files out of the way.
  syncCurrent(store);
  return app;
}

export interface TrackerStats {
  total: number;
  byStatus: Record<string, number>;
  /** Applications sent in the last 7 and 30 days. */
  last7: number;
  last30: number;
  /** Share of applications that reached an interview or beyond. */
  responseRate: number;
}

export function stats(apps: Application[]): TrackerStats {
  const byStatus: Record<string, number> = {};
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  const now = Date.now();
  const since = (days: number) =>
    apps.filter((a) => a.appliedAt && now - Date.parse(a.appliedAt) < days * 86_400_000).length;

  const responded = apps.filter((a) => ['oa', 'interview', 'offer'].includes(a.status)).length;
  // "Applying" has not been sent yet, so it cannot have drawn a response.
  const sent = apps.filter((a) => a.status !== 'interested' && a.status !== 'applying').length;

  return {
    total: apps.length,
    byStatus,
    last7: since(7),
    last30: since(30),
    responseRate: sent === 0 ? 0 : Math.round((responded / sent) * 100),
  };
}
