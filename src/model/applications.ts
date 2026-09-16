import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Store } from './store.js';
import type { Application, ApplicationStatus, ResolvedResume } from './types.js';
import { compileResume } from '../render/compile.js';
import { resolveResume } from './resolve.js';

/**
 * File naming is a surprising amount of the pain in applying: every portal
 * wants "Firstname Lastname Resume", and renaming a download each time is how
 * the wrong file ends up attached. Bundles are produced already named right.
 */
export function bundleFileName(name: string, company: string | undefined, kind: 'Resume' | 'Cover Letter'): string {
  const person = name.trim().replace(/\s+/g, ' ');
  const co = company?.trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ');
  return [person, kind, co].filter(Boolean).join(' ') + '.pdf';
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export function applicationId(company: string, role: string, at = new Date()): string {
  const date = at.toISOString().slice(0, 10);
  return `${date}-${slug(company)}-${slug(role)}`.replace(/-+$/, '');
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

  const resumeName = bundleFileName(data.profile.name, req.company, 'Resume');
  const pdfPath = path.join(dir, resumeName);
  const compiled = await compileResume(resolved, {
    pdfPath,
    texPath: path.join(dir, 'source', 'resume.tex'),
  });

  const files = [resumeName];

  if (req.coverLetter?.trim()) {
    const letterPath = path.join(dir, bundleFileName(data.profile.name, req.company, 'Cover Letter').replace(/\.pdf$/, '.txt'));
    fs.writeFileSync(letterPath, req.coverLetter, 'utf8');
    files.push(path.basename(letterPath));
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
  const sent = apps.filter((a) => a.status !== 'interested').length;

  return {
    total: apps.length,
    byStatus,
    last7: since(7),
    last30: since(30),
    responseRate: sent === 0 ? 0 : Math.round((responded / sent) * 100),
  };
}
