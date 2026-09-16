/**
 * The whole system rests on one idea: every piece of resume text lives in
 * exactly one place, and that place can hold several interchangeable phrasings
 * of itself. A resume is not a document — it is a set of *choices* over that
 * store. Edit the canonical text once and every resume that points at it moves.
 */

/** A single interchangeable phrasing of some text. */
export interface Variant {
  id: string;
  /** Human label shown in the picker, e.g. "Kafka-emphasis" or "Dec 2026 grad". */
  label: string;
  text: string;
  /** Free-form tags used to score a variant against a job description. */
  tags?: string[];
  /** Why this phrasing exists. Shown in the GUI, never rendered. */
  note?: string;
  /** Set by the AI-suggestion flow so unreviewed text is visibly quarantined. */
  suggested?: boolean;
}

/**
 * A field whose text can differ between resumes. Graduation date is the
 * motivating case: one education entry, two endings, no duplicated file.
 */
export interface VariantField {
  /** Variant id used when a resume expresses no preference. */
  default: string;
  variants: Variant[];
}

/** A field that is either a plain string or a set of alternates. */
export type MaybeVariant = string | VariantField;

/** A single selectable item inside a list bullet, e.g. one course. */
export interface ListItem {
  id: string;
  text: string;
  tags?: string[];
}

/**
 * One bullet point.
 *
 * Most bullets are a sentence with several phrasings. A few are really a list —
 * relevant coursework, awards — where the decision is which items to show, not
 * how to word them. Those carry `items` and are picked with checkboxes, the
 * same way skills are.
 */
export interface Bullet {
  id: string;
  default: string;
  variants: Variant[];
  /** Present on list bullets. When set, `variants` is unused for rendering. */
  items?: ListItem[];
  /** Text printed before the list, e.g. "**Relevant Coursework:**". */
  prefix?: string;
  /** Separator between items. Defaults to ", ". */
  separator?: string;
  /** Bullets can be omitted from a resume but kept in the store. */
  archived?: boolean;
}

export function isListBullet(b: Bullet): boolean {
  return Array.isArray(b.items) && b.items.length > 0;
}

export type EntryKind = 'education' | 'experience' | 'project' | 'skills' | 'custom';

/** An education entry, job, or project — anything with a heading and bullets. */
export interface Entry {
  id: string;
  kind: EntryKind;
  /** Left heading: school, company, or project name. */
  title: MaybeVariant;
  /** Right heading: dates. */
  dates?: MaybeVariant;
  /** Second-line left: degree, role, or tech stack. */
  subtitle?: MaybeVariant;
  /** Second-line right: location. */
  location?: MaybeVariant;
  bullets?: Bullet[];
  tags?: string[];
  archived?: boolean;
}

/** A named group of skills, e.g. "Languages: Python, Go". */
export interface SkillGroup {
  id: string;
  name: string;
  /** Each skill is individually selectable so a resume can drop the noise. */
  items: SkillItem[];
  tags?: string[];
}

export interface SkillItem {
  id: string;
  text: string;
  tags?: string[];
}

export interface Profile {
  name: string;
  phone?: string;
  email?: string;
  linkedin?: string;
  github?: string;
  website?: string;
  location?: string;
  /** Extra key/value pairs the browser extension can use to autofill forms. */
  autofill?: Record<string, string>;
}

/** Which entries appear, in what order, in one section of a resume. */
export interface SectionSpec {
  kind: EntryKind;
  /** Heading printed on the resume. Defaults to a sensible name per kind. */
  heading?: string;
  /**
   * Entry ids in render order. An entry id may be suffixed with a bullet
   * selection, expressed in `bullets` below.
   */
  entries: string[];
  /**
   * Per-entry bullet inclusion and ordering. Absent entry => all non-archived
   * bullets in store order.
   */
  bullets?: Record<string, string[]>;
  /** For skills sections: group ids, and optionally which items within them. */
  groups?: string[];
  items?: Record<string, string[]>;
}

/**
 * A resume is a thin selection layer. `extends` lets "new grad" and "intern"
 * differ by three lines instead of being two whole files that drift apart.
 */
export interface ResumeSpec {
  id: string;
  label: string;
  /** Id of another resume to inherit sections and choices from. */
  extends?: string;
  sections?: SectionSpec[];
  /**
   * Variant selection. Keys are either a bullet id (`b_kafka`) or a field path
   * (`edu_neu.dates`). Values are variant ids. Merged over the parent's.
   */
  choices?: Record<string, string>;
  /**
   * Which items to show on a list bullet, keyed by bullet id. Absent means all
   * of them. Merged over the parent's, per bullet.
   */
  lists?: Record<string, string[]>;
  /** Rendering knobs; merged over defaults and the parent's. */
  layout?: Partial<LayoutOptions>;
  notes?: string;
  /** Set when the extension generated this for a specific posting. */
  generatedFor?: { url?: string; company?: string; role?: string; at?: string };
}

export interface LayoutOptions {
  /** Base font size in pt. Auto-fit is allowed to shrink within bounds. */
  fontSizePt: number;
  /** Page margin in inches. */
  marginIn: number;
  /** Multiplier applied to inter-block spacing. */
  spacing: number;
  paper: 'letter' | 'a4';
  /**
   * When true, the renderer may shrink font/spacing within `fitBounds` to reach
   * one page. When false, overflow is a hard error.
   */
  autoFit: boolean;
  fitBounds: { minFontSizePt: number; minSpacing: number; minMarginIn: number };
  /** Hard page ceiling. The whole point of the tool is that this is 1. */
  maxPages: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  fontSizePt: 10.5,
  marginIn: 0.45,
  spacing: 1,
  paper: 'letter',
  autoFit: true,
  fitBounds: { minFontSizePt: 9.2, minSpacing: 0.78, minMarginIn: 0.35 },
  maxPages: 1,
};

/* ------------------------------------------------------------------ *
 * Resolved shapes — what the renderer actually consumes. No variants  *
 * survive resolution; every choice has already been made.            *
 * ------------------------------------------------------------------ */

export interface ResolvedEntry {
  id: string;
  kind: EntryKind;
  title: string;
  dates?: string;
  subtitle?: string;
  location?: string;
  bullets: ResolvedBullet[];
}

export interface ResolvedBullet {
  id: string;
  variantId: string;
  text: string;
}

export interface ResolvedSkillGroup {
  id: string;
  name: string;
  items: string[];
}

export interface ResolvedSection {
  kind: EntryKind;
  heading: string;
  entries: ResolvedEntry[];
  skillGroups: ResolvedSkillGroup[];
}

export interface ResolvedResume {
  id: string;
  label: string;
  profile: Profile;
  sections: ResolvedSection[];
  layout: LayoutOptions;
  /** Non-fatal problems: dangling ids, choices that matched nothing. */
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Application tracking                                                *
 * ------------------------------------------------------------------ */

export type ApplicationStatus =
  | 'interested'
  /** Being worked on — the letter written, the answers drafted — but not sent. */
  | 'applying'
  | 'applied'
  | 'oa'
  | 'interview'
  | 'offer'
  | 'rejected'
  | 'ghosted'
  | 'withdrawn';

export interface Application {
  id: string;
  company: string;
  role: string;
  url?: string;
  /** ISO date string. */
  appliedAt?: string;
  status: ApplicationStatus;
  /** Resume spec id used, and the snapshot folder holding the exact files. */
  resumeId?: string;
  snapshotDir?: string;
  source?: string;
  notes?: string;
  /** Free-form per-application answers, useful when a company re-asks. */
  answers?: { question: string; answer: string }[];
  /** The cover letter as sent, so the record is the whole submission. */
  coverLetter?: string;
  /** Id of the letter in `letters/`, when one was filed there too. */
  letterId?: string;
  history?: { at: string; status: ApplicationStatus; note?: string }[];
}

/**
 * An application in progress.
 *
 * The extension knows what a posting asks for — a cover letter, three essay
 * questions — but a browser sidebar is the wrong place to write prose. A draft
 * carries that requirement into the editor, where there is room to work, and
 * carries the finished answers back out into the application record.
 */
export interface Draft {
  id: string;
  company: string;
  role: string;
  url?: string;
  /** Which resume the application will use; usually one the extension derived. */
  resumeId?: string;
  createdAt: string;
  updatedAt: string;
  status: 'drafting' | 'ready' | 'submitted';
  /** Where it came from, e.g. the hostname the extension saw. */
  source?: string;
  /** The posting text, kept so generation has context without re-fetching. */
  jobDescription?: string;
  coverLetter: {
    required: boolean;
    body: string;
    /** True once a human has touched it, so generation cannot overwrite silently. */
    edited?: boolean;
  };
  questions: DraftQuestion[];
  notes?: string;
}

export interface DraftQuestion {
  id: string;
  question: string;
  required?: boolean;
  answer: string;
  /** Which answer-bank item this came from, when it came from one. */
  fromAnswerId?: string;
  /** How the current text got here. */
  source?: 'bank' | 'ai' | 'human' | 'empty';
  edited?: boolean;
}

/**
 * A piece of the user's own writing, kept so the AI can match their voice by
 * reading it rather than by being told about it.
 *
 * Describing your own writing is a bad way to convey it — people are poor
 * witnesses to their own style, and "plain and direct" means something
 * different to everyone. Three paragraphs you actually wrote say it exactly.
 * Samples need not belong to any application; an old resume or a letter you
 * were pleased with is the point.
 */
export interface WritingSample {
  id: string;
  title: string;
  kind: 'resume' | 'letter' | 'answer' | 'other';
  text: string;
  createdAt: string;
  /** Roughly when it was written, if that differs from when it was added. */
  writtenAt?: string;
  tags?: string[];
  /** Excluded from the voice context without being deleted. */
  archived?: boolean;
}

export interface CoverLetter {
  id: string;
  title: string;
  company?: string;
  role?: string;
  createdAt: string;
  body: string;
  tags?: string[];
  /** The application this was written for, when it was written for one. */
  applicationId?: string;
}

/** A reusable answer to an application question, written in the user's voice. */
export interface AnswerBankItem {
  id: string;
  question: string;
  /** Alternate phrasings/lengths of the same answer. */
  variants: Variant[];
  default: string;
  tags?: string[];
}

export interface StoreData {
  profile: Profile;
  entries: Entry[];
  skillGroups: SkillGroup[];
  resumes: ResumeSpec[];
  applications: Application[];
  coverLetters: CoverLetter[];
  drafts: Draft[];
  samples: WritingSample[];
  answers: AnswerBankItem[];
  /** Contents of voice.md — the writing-voice instructions handed to any AI. */
  voice: string;
  config: StoreConfig;
}

export interface StoreConfig {
  latex: {
    /**
     * Which third-party compiler to shell out to. Leave unset to auto-detect
     * in the order tectonic → latexmk → pdflatex.
     */
    engine?: 'tectonic' | 'latexmk' | 'pdflatex';
  };
  ai: {
    /** Command to run, e.g. "claude" / "codex" / "agy". */
    command: string;
    /** Args template. `{prompt}` is replaced with the prompt file path. */
    args: string[];
    /** When false, AI endpoints return the prompt instead of executing it. */
    enabled: boolean;
    timeoutMs: number;
  };
  git: {
    /** Auto-commit every mutation to the data directory. */
    autoCommit: boolean;
  };
  output: {
    /** Where generated PDFs and application bundles land. */
    dir: string;
  };
}

export const DEFAULT_CONFIG: StoreConfig = {
  latex: {},
  ai: {
    command: 'claude',
    args: ['-p', '{prompt}'],
    enabled: false,
    timeoutMs: 180_000,
  },
  git: { autoCommit: true },
  output: { dir: 'out' },
};

export function isVariantField(v: MaybeVariant | undefined): v is VariantField {
  return typeof v === 'object' && v !== null && Array.isArray((v as VariantField).variants);
}
