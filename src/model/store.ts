import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { absorbBase } from './resolve.js';
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
import { applyModelAndEffort, applyResearch, repairAiArgs } from '../ai/presets.js';
import { normalizeAnswers, normalizeApplications, normalizeEntries, normalizeEntry, normalizeProfile } from './normalize.js';
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

  /*
   * Every write lands whole, or not at all.
   *
   * `fs.writeFileSync` opens with O_TRUNC, so for the length of the write the
   * file is observably zero bytes and then partially written. A second process
   * reading it is not hypothetical here — the `rmm` CLI, a second server, a
   * hand edit while the app is up — and the failure is silent in the worst
   * way: a YAML list truncated at an item boundary parses cleanly. Reading
   * applications.yaml during a write returned 130 of 300 applications with no
   * error, and the next save wrote that list back. A crash or a power cut
   * mid-write leaves the same truncated file with nothing to recover from.
   *
   * Write to a temp file, flush it, rename over the target: rename within a
   * directory is atomic, so a reader sees either the old file or the new one.
   * The pattern is already used for projects.json and the asset store; user
   * data deserves it at least as much.
   */
  private writeAtomic(f: string, text: string): void {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const temp = `${f}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'w');
      try {
        fs.writeFileSync(fd, text, 'utf8');
        // So a power cut cannot leave the rename pointing at empty bytes.
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, f);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
  }

  private writeYaml(rel: string | string[], data: unknown): void {
    const f = this.file(...(Array.isArray(rel) ? rel : [rel]));
    // lineWidth 0 keeps long bullet text on one line so diffs stay per-bullet
    // instead of reflowing a whole paragraph every time a word changes.
    this.writeAtomic(f, YAML.stringify(data, { lineWidth: 0 }));
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
      applications: normalizeApplications(this.readYaml<Application[]>('applications.yaml', [])),
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
    // And the model and effort flags follow their own settings, for the same
    // reason: the saved arguments stay the preset's, and the choice is a
    // setting rather than a hand edit that drifts.
    config.ai.args = applyModelAndEffort(config.ai.command, config.ai.args, {
      model: config.ai.model,
      effort: config.ai.effort,
    });

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
    this.writeAtomic(this.file('voice.md'), text);
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
        /*
         * Filename is the source of truth for the id, which the comment here
         * always said and the code did not: it preferred the id written inside
         * the file, so two files could claim one id. Copying resumes/base.yaml
         * to resumes/base-old.yaml — an ordinary thing to do in a folder
         * advertised as hand-editable YAML — made the copy sort first, and from
         * then on it answered every lookup for `base`. Edits went to base.yaml
         * and appeared to be thrown away, every child of `base` resolved
         * through the copy, and the next save wrote the copy's content over the
         * real file.
         *
         * Taken from the name, a copied file is simply its own resume.
         */
        return { ...spec, id: path.basename(f).replace(/\.ya?ml$/, '') };
      })
      .filter((r): r is ResumeSpec => Boolean(r && r.id));
  }

  getResume(id: string): ResumeSpec | undefined {
    return this.loadResumes().find((r) => r.id === id);
  }

  saveResume(spec: ResumeSpec): void {
    this.writeYaml(['resumes', `${spec.id}.yaml`], spec);
  }

  /**
   * Deleting a resume must not break the ones built on it.
   *
   * Variations are thin — "new grad" is the base plus a handful of choices,
   * recorded as `extends: base`. Unlinking the base and nothing else left every
   * variation throwing "extends 'base', which does not exist" from that moment
   * on, in the editor, the preview and the tracker alike, with nothing in the
   * UI able to edit `extends` and so no way back but hand-editing YAML.
   *
   * So each child absorbs what the deleted resume contributed and re-points at
   * its parent. The children are written first: if anything fails partway, the
   * base is still there and they still resolve.
   */
  deleteResume(id: string): void {
    const all = this.loadResumes();
    const removed = all.find((r) => r.id === id);

    if (removed) {
      for (const child of all) {
        if (child.extends === id) this.saveResume(absorbBase(child, removed));
      }
    }

    for (const ext of ['yaml', 'yml']) {
      const f = this.file('resumes', `${id}.${ext}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  /** The four files entries are split across, in the order `load` reads them. */
  private static readonly ENTRY_FILES = [
    'education.yaml',
    'experience.yaml',
    'projects.yaml',
    'custom.yaml',
  ] as const;

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

  /**
   * An id lives in exactly one of the four files.
   *
   * Splitting entries by kind means changing an entry's kind moves it between
   * files, and writing the new one without removing the old left the same id in
   * two places at once. `load()` concatenates the four files with no dedupe, so
   * the store then held two entries with that id — and `resolveResume` takes
   * the first match, which for education → project is the stale copy. The
   * master document showed the entry as you had just edited it while the PDF
   * you actually sent showed the old title and the old bullets, with nothing
   * anywhere saying so. `deleteEntry` returned at the first file it found a
   * match in, so the twin could not be cleared from the app either.
   */
  saveEntry(entry: Entry): void {
    // Normalised on the way out as well as in, so a bad write from the API
    // never becomes a bad file: reads are already safe, but a file that says
    // something impossible is a trap for whoever opens it next.
    const clean = normalizeEntry(entry);
    const rel = this.fileForKind(clean.kind);

    /*
     * The write that adds it comes first, and the ones that remove the old copy
     * come after.
     *
     * Each file is written atomically, but changing an entry's kind touches
     * two of them and nothing makes the pair atomic. Removing first meant a
     * window — a full disk, an EIO, a crash — in which the entry was in neither
     * file, and `load()` simply concatenates the four: the title, the dates and
     * every phrasing of every bullet, gone, with the error naming the disk
     * rather than the entry. In this order the same failure leaves the entry in
     * both files instead, which `load()` resolves in favour of the newer one
     * and the next successful save tidies up.
     */
    const list = this.readYaml<Entry[]>(rel, []);
    const idx = list.findIndex((e) => e.id === clean.id);
    if (idx >= 0) list[idx] = clean;
    else list.push(clean);
    this.writeYaml(rel, list);

    for (const other of Store.ENTRY_FILES) {
      if (other === rel) continue;
      const stale = this.readYaml<Entry[]>(other, []);
      const next = stale.filter((e) => e.id !== clean.id);
      if (next.length !== stale.length) this.writeYaml(other, next);
    }
  }

  /** Removes the id from every file, not merely the first one holding it. */
  deleteEntry(id: string): boolean {
    let removed = false;
    for (const rel of Store.ENTRY_FILES) {
      const list = this.readYaml<Entry[]>(rel, []);
      const next = list.filter((e) => e.id !== id);
      if (next.length !== list.length) {
        this.writeYaml(rel, next);
        removed = true;
      }
    }
    return removed;
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
    const apps = normalizeApplications(this.readYaml<Application[]>('applications.yaml', []));
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
          // Rebuilt field by field, so a field missed here is a field deleted:
          // the editor loads a letter and PUTs back exactly what it was given,
          // and this one was dropped on the way in. Completing an application
          // tags its letter with the application it belongs to, and opening
          // that letter once untagged it — after which the per-application
          // lookup could never match and the application showed no letter.
          applicationId: meta.applicationId,
          body: m[2] ?? '',
        } satisfies CoverLetter;
      });
  }

  saveCoverLetter(letter: CoverLetter): void {
    const { body, id, ...meta } = letter;
    const dir = this.file('letters');
    fs.mkdirSync(dir, { recursive: true });
    const front = YAML.stringify(meta, { lineWidth: 0 }).trimEnd();
    this.writeAtomic(this.file('letters', `${id}.md`), `---\n${front}\n---\n${body}`);
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
    this.writeAtomic(this.file('corpus', `${id}.md`), `---\n${front}\n---\n${text}`);
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
        // The filename is the id, the same way it is for resumes, and for the
        // same reason: an id written inside the file meant that copying a draft
        // to `d1-backup.yaml` produced two drafts claiming to be `d1`, and that
        // renaming one left `deleteDraft` unlinking a path that is not there —
        // so discarding it failed and completing it silently left it on the
        // list forever.
        return { ...draft, id: path.basename(f, '.yaml') };
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
