import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  DEFAULT_CONFIG,
  type AnswerBankItem,
  type Application,
  type CoverLetter,
  type Draft,
  type Entry,
  type Profile,
  type ResumeSpec,
  type SkillGroup,
  type WritingSample,
  type StoreConfig,
  type StoreData,
} from './types.js';

// It lives with the presets, which are what it repairs a config back towards,
// and is re-exported here because this is where config is read.
import { applyResearch, repairAiArgs } from '../ai/presets.js';
import { normalizeAnswers, normalizeEntries, normalizeEntry, normalizeProfile } from './normalize.js';
export { repairAiArgs };

/**
 * The store is a directory of YAML files under git. It is deliberately dumb:
 * read everything, hand out plain objects, write back whole files. A resume
 * store is a few hundred kilobytes; there is no reason for an index or a
 * database, and plain files mean `git diff` stays readable.
 */
export class Store {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * A path inside the store, and never outside it.
   *
   * Ids reach here from URLs and from request bodies, and they end up as
   * filenames — so a resume called `../config` wrote over the store's own
   * configuration, whose `ai.command` this application executes. With the
   * server answering any origin, that was a page you visited being able to run
   * a command on your machine.
   *
   * Checked here rather than at each route because there are a dozen routes and
   * one of them will always be the one that was forgotten. Everything that
   * becomes a file goes through this function.
   */
  private file(...p: string[]): string {
    /*
     * Each segment is one name, never a path. Checking only that the result
     * lands inside the store is not enough: `../config` from the resumes
     * folder stays inside it and overwrites the store's own configuration,
     * whose `ai.command` this application executes.
     */
    for (const segment of p) {
      if (segment.includes('/') || segment.includes('\\') || segment.split('.').includes('..')) {
        throw new Error('That name is not allowed — a name cannot contain a path.');
      }
    }
    const full = path.resolve(this.root, ...p);
    // And the belt to that pair of braces, in case a segment ever gets through.
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error('That name is not allowed — it points outside the save folder.');
    }
    return full;
  }

  private readYaml<T>(rel: string | string[], fallback: T): T {
    const f = this.file(...(Array.isArray(rel) ? rel : [rel]));
    if (!fs.existsSync(f)) return fallback;
    const raw = fs.readFileSync(f, 'utf8');
    if (!raw.trim()) return fallback;
    const parsed = YAML.parse(raw);
    return (parsed ?? fallback) as T;
  }

  private writeYaml(rel: string | string[], data: unknown): void {
    const f = this.file(...(Array.isArray(rel) ? rel : [rel]));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // lineWidth 0 keeps long bullet text on one line so diffs stay per-bullet
    // instead of reflowing a whole paragraph every time a word changes.
    fs.writeFileSync(f, YAML.stringify(data, { lineWidth: 0 }), 'utf8');
  }

  /** Read every file in the store into one object. */
  load(): StoreData {
    const config = this.loadConfig();
    return {
      profile: normalizeProfile(this.readYaml<Profile>('profile.yaml', { name: 'Your Name' })),
      // Normalised on the way in, so nothing downstream has to guard against a
      // hand-edited file that left a field without its alternates. See
      // normalize.ts — this is the only place it needs doing.
      entries: normalizeEntries([
        ...this.readYaml<Entry[]>('education.yaml', []),
        ...this.readYaml<Entry[]>('experience.yaml', []),
        ...this.readYaml<Entry[]>('projects.yaml', []),
        ...this.readYaml<Entry[]>('custom.yaml', []),
      ]),
      skillGroups: this.readYaml<SkillGroup[]>('skills.yaml', []),
      resumes: this.loadResumes(),
      applications: this.readYaml<Application[]>('applications.yaml', []),
      coverLetters: this.loadCoverLetters(),
      drafts: this.loadDrafts(),
      samples: this.loadSamples(),
      answers: normalizeAnswers(this.readYaml<AnswerBankItem[]>('answers.yaml', [])),
      voice: this.loadVoice(),
      config,
    };
  }

  loadConfig(): StoreConfig {
    const raw = this.readYaml<Partial<StoreConfig>>('config.yaml', {});
    const config: StoreConfig = {
      latex: { ...DEFAULT_CONFIG.latex, ...(raw.latex ?? {}) },
      ai: { ...DEFAULT_CONFIG.ai, ...(raw.ai ?? {}) },
      git: { ...DEFAULT_CONFIG.git, ...(raw.git ?? {}) },
      output: { ...DEFAULT_CONFIG.output, ...(raw.output ?? {}) },
    };

    config.ai.args = repairAiArgs(config.ai.command, config.ai.args);
    // The deny list follows the research setting, so the two cannot disagree.
    config.ai.args = applyResearch(config.ai.command, config.ai.args, Boolean(config.ai.research));

    // Escape hatches for automated runs. A test suite driving a real server
    // should be able to leave no commits behind without editing config.yaml.
    if (process.env.RMM_AUTOCOMMIT === '0') config.git.autoCommit = false;
    if (process.env.RMM_AI === '0') config.ai.enabled = false;
    if (process.env.RMM_LATEX_ENGINE) {
      config.latex.engine = process.env.RMM_LATEX_ENGINE as StoreConfig['latex']['engine'];
    }
    return config;
  }

  /**
   * Write config.yaml. Only the fields the caller supplies are changed, so a
   * GUI that knows about the AI settings cannot clobber the LaTeX ones.
   */
  saveConfig(patch: Partial<StoreConfig>): StoreConfig {
    const current = this.readYaml<Partial<StoreConfig>>('config.yaml', {});
    const merged: Partial<StoreConfig> = {
      ...current,
      ...(patch.latex ? { latex: { ...current.latex, ...patch.latex } } : {}),
      ...(patch.ai ? { ai: { ...current.ai, ...patch.ai } } : {}),
      ...(patch.git ? { git: { ...current.git, ...patch.git } } : {}),
      ...(patch.output ? { output: { ...current.output, ...patch.output } } : {}),
    };
    this.writeYaml('config.yaml', merged);
    return this.loadConfig();
  }

  loadVoice(): string {
    const f = this.file('voice.md');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }

  saveVoice(text: string): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.file('voice.md'), text, 'utf8');
  }

  /** Resumes live one-per-file so a new variation is a new small file. */
  loadResumes(): ResumeSpec[] {
    const dir = this.file('resumes');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => {
        const spec = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ResumeSpec;
        // Filename is the source of truth for the id so the two cannot diverge.
        return { ...spec, id: spec?.id ?? path.basename(f).replace(/\.ya?ml$/, '') };
      })
      .filter((r): r is ResumeSpec => Boolean(r && r.id));
  }

  getResume(id: string): ResumeSpec | undefined {
    return this.loadResumes().find((r) => r.id === id);
  }

  saveResume(spec: ResumeSpec): void {
    this.writeYaml(['resumes', `${spec.id}.yaml`], spec);
  }

  deleteResume(id: string): void {
    for (const ext of ['yaml', 'yml']) {
      const f = this.file('resumes', `${id}.${ext}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  /**
   * Entries are split across files by kind for readability, so writing one back
   * means knowing which file it came from.
   */
  private fileForKind(kind: Entry['kind']): string {
    switch (kind) {
      case 'education':
        return 'education.yaml';
      case 'experience':
        return 'experience.yaml';
      case 'project':
        return 'projects.yaml';
      default:
        return 'custom.yaml';
    }
  }

  saveEntry(entry: Entry): void {
    // Normalised on the way out as well as in, so a bad write from the API
    // never becomes a bad file: reads are already safe, but a file that says
    // something impossible is a trap for whoever opens it next.
    const clean = normalizeEntry(entry);
    const rel = this.fileForKind(clean.kind);
    const list = this.readYaml<Entry[]>(rel, []);
    const idx = list.findIndex((e) => e.id === clean.id);
    if (idx >= 0) list[idx] = clean;
    else list.push(clean);
    this.writeYaml(rel, list);
  }

  deleteEntry(id: string): boolean {
    for (const rel of ['education.yaml', 'experience.yaml', 'projects.yaml', 'custom.yaml']) {
      const list = this.readYaml<Entry[]>(rel, []);
      const next = list.filter((e) => e.id !== id);
      if (next.length !== list.length) {
        this.writeYaml(rel, next);
        return true;
      }
    }
    return false;
  }

  saveSkillGroups(groups: SkillGroup[]): void {
    this.writeYaml('skills.yaml', groups);
  }

  saveProfile(profile: Profile): void {
    this.writeYaml('profile.yaml', normalizeProfile(profile));
  }

  saveApplications(apps: Application[]): void {
    this.writeYaml('applications.yaml', apps);
  }

  upsertApplication(app: Application): Application[] {
    const apps = this.readYaml<Application[]>('applications.yaml', []);
    const idx = apps.findIndex((a) => a.id === app.id);
    if (idx >= 0) apps[idx] = app;
    else apps.push(app);
    this.saveApplications(apps);
    return apps;
  }

  saveAnswers(answers: AnswerBankItem[]): void {
    this.writeYaml('answers.yaml', answers);
  }

  /** Cover letters are markdown files with a YAML front-matter header. */
  loadCoverLetters(): CoverLetter[] {
    const dir = this.file('letters');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
        const id = path.basename(f, '.md');
        if (!m) {
          return { id, title: id, createdAt: '', body: raw } satisfies CoverLetter;
        }
        const meta = (YAML.parse(m[1] ?? '') ?? {}) as Partial<CoverLetter>;
        return {
          id,
          title: meta.title ?? id,
          company: meta.company,
          role: meta.role,
          createdAt: meta.createdAt ?? '',
          tags: meta.tags,
          body: m[2] ?? '',
        } satisfies CoverLetter;
      });
  }

  saveCoverLetter(letter: CoverLetter): void {
    const { body, id, ...meta } = letter;
    const dir = this.file('letters');
    fs.mkdirSync(dir, { recursive: true });
    const front = YAML.stringify(meta, { lineWidth: 0 }).trimEnd();
    fs.writeFileSync(this.file('letters', `${id}.md`), `---\n${front}\n---\n${body}`, 'utf8');
  }

  /**
   * The writing corpus: markdown files with a front-matter header, the same
   * shape as cover letters, because they are the same kind of thing — your
   * words, kept so they can be read back.
   */
  loadSamples(): WritingSample[] {
    const dir = this.file('corpus');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
        const id = path.basename(f, '.md');
        if (!m) return { id, title: id, kind: 'other' as const, text: raw, createdAt: '' };
        const meta = (YAML.parse(m[1] ?? '') ?? {}) as Partial<WritingSample>;
        return {
          id,
          title: meta.title ?? id,
          kind: meta.kind ?? 'other',
          createdAt: meta.createdAt ?? '',
          writtenAt: meta.writtenAt,
          tags: meta.tags,
          archived: meta.archived,
          text: m[2] ?? '',
        } satisfies WritingSample;
      });
  }

  saveSample(sample: WritingSample): void {
    const { text, id, ...meta } = sample;
    const dir = this.file('corpus');
    fs.mkdirSync(dir, { recursive: true });
    const front = YAML.stringify(meta, { lineWidth: 0 }).trimEnd();
    fs.writeFileSync(this.file('corpus', `${id}.md`), `---\n${front}\n---\n${text}`, 'utf8');
  }

  deleteSample(id: string): boolean {
    const f = this.file('corpus', `${id}.md`);
    if (!fs.existsSync(f)) return false;
    fs.unlinkSync(f);
    return true;
  }

  /**
   * Applications in progress. One file each, like resumes, so a draft is
   * readable in a diff and easy to delete by hand.
   */
  loadDrafts(): Draft[] {
    const dir = this.file('drafts');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => {
        const draft = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Draft;
        return { ...draft, id: draft?.id ?? path.basename(f, '.yaml') };
      })
      .filter((d): d is Draft => Boolean(d && d.id))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  getDraft(id: string): Draft | undefined {
    return this.loadDrafts().find((d) => d.id === id);
  }

  saveDraft(draft: Draft): Draft {
    const next = { ...draft, updatedAt: new Date().toISOString() };
    this.writeYaml(['drafts', `${draft.id}.yaml`], next);
    return next;
  }

  deleteDraft(id: string): boolean {
    const f = this.file('drafts', `${id}.yaml`);
    if (!fs.existsSync(f)) return false;
    fs.unlinkSync(f);
    return true;
  }

  /** Absolute path to the configured output directory, created on demand. */
  outDir(): string {
    const output = this.loadConfig().output;
    const dir = path.resolve(this.root, output.withinProject ? '.' : '..', output.dir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
