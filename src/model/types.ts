/**
 * The whole system rests on one idea: every piece of resume text lives in
 * exactly one place, and that place can hold several interchangeable phrasings
 * of itself. A resume is not a document — it is a set of *choices* over that
 * store. Edit the canonical text once and every resume that points at it moves.
 */

import type { Period } from './period.js';
export type { DatePoint, DateStyle, Period, Season } from './period.js';

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
  /**
   * Left heading: school, company, or project name.
   *
   * Optional in the type because it is optional on disk. It used to be
   * required, and `normalizeEntry` kept that true by substituting the entry's
   * id — which is how `exp_helios` came to be typeset in bold where an
   * employer's name belongs. `resolveEntry` prints nothing and warns instead;
   * see the note there.
   */
  title?: MaybeVariant;
  /**
   * Right heading: dates, as the words that get printed.
   *
   * Still the text, and still what renders. `period` below is the same
   * information as dates, and where the two disagree this one wins — see the
   * note there for why that is the safe way round.
   */
  dates?: MaybeVariant;
  /**
   * When this happened, as dates the program can compare.
   *
   * Derived from `dates` on load for every store written before this existed,
   * so nothing has to be converted before it works, and written down the next
   * time the entry is saved. Absent means the text said something that is not
   * a date — "Various", "Two semesters" — and that entry stays wherever it was
   * put by hand rather than being sorted somewhere arbitrary.
   *
   * `dates` remains what prints. A date can be read in more ways than it can
   * be written, so a migration that re-rendered everything would respell dates
   * in resumes that have already been sent and proofread: "Jul. 2024" quietly
   * becoming "July 2024" across a store is a change nobody asked for in
   * documents nobody is going to re-read. Writing the text only when the user
   * edits the date themselves keeps that from happening.
   *
   * One period per entry, taken from the default phrasing where `dates` has
   * alternates. Alternates of a date are nearly always two spellings of one
   * period, or two projections of a graduation, and neither should move the
   * entry to a different place on the page depending on which resume is open.
   */
  period?: Period;
  /** Second-line left: degree, role, or tech stack. */
  subtitle?: MaybeVariant;
  /** Second-line right: location. */
  location?: MaybeVariant;
  bullets?: Bullet[];
  tags?: string[];
  archived?: boolean;
}

/**
 * A file kept in the save to be attached, not to be written from.
 *
 * A transcript, a portfolio, a reference letter: it arrives finished and the
 * only thing wanted of it is to go into an upload box. Named by the name it
 * will be uploaded under, because that is the part a reviewer sees.
 */
export interface StandingDocument {
  name: string;
  bytes: number;
  /** When the file was last written, so a stale transcript is visible as one. */
  at: string;
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
  /**
   * What goes at the top of the page.
   *
   * Alternates, like every other field, because a name is not one fixed thing:
   * the name on your degree, the name people call you, and the initialled form
   * that buys a line back on a full page are all yours, and which one belongs
   * on a given application is a decision worth being able to pin.
   */
  name: MaybeVariant;
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
   * Whether this list is the order, or only the membership.
   *
   * `'newest'` is what a resume wants nearly always — most recent first is not
   * a preference so much as the convention every reader of the document
   * already has — so it is what a new section gets, and it is maintained from
   * `Entry.period` rather than by hand.
   *
   * `'manual'` says the list above is the order. It is what you get by
   * dragging something, because dragging is an instruction and a sort that
   * immediately undid it would make the handle a lie.
   *
   * Absent is the shape of every section written before any of this existed,
   * and it means manual — see `adoptDateOrder`, which upgrades the ones where
   * doing so provably changes nothing and leaves the rest alone. A store does
   * not silently rearrange a document that has already been sent.
   *
   * Sorting happens at render time and leaves the stored list alone, so
   * turning it off gives back the order that was there rather than whatever
   * the sort last produced. Entries whose dates could not be read keep their
   * relative positions at the end: an entry the program cannot place is one it
   * should not move.
   */
  order?: 'manual' | 'newest' | 'oldest';
  /**
   * Which lines each entry shows. Absent entry => all non-archived bullets.
   *
   * The order of this list is only honoured where `bulletOrder` says the
   * lines were arranged here; otherwise the master decides, and this is read
   * as a set. See `orderedBullets`.
   */
  bullets?: Record<string, string[]>;
  /**
   * Entries whose lines were put in order on this resume rather than in the
   * master document.
   *
   * Absent means the master decides, which is the default and the point: an
   * order stated once in the inventory is the order every document takes, so
   * rearranging the master restacks all of them. Dragging a line inside one
   * resume is that resume saying it wants its own order, and is the only
   * thing that writes this.
   *
   * It has to be recorded rather than inferred. The obvious inference —
   * "this list disagrees with the master, so somebody must have dragged it"
   * — is true right up until the master moves, at which point every resume
   * that was faithfully following it suddenly disagrees with it too, and
   * they all detach at once. Which is the exact opposite of what the setting
   * is for.
   */
  bulletOrder?: Record<string, 'manual'>;
  /** For skills sections: group ids, and optionally which items within them. */
  groups?: string[];
  items?: Record<string, string[]>;
}

/**
 * A resume is a thin selection layer over the store: which entries are shown,
 * which bullets of each, which wording of each bullet, which items of each
 * skills group. The text itself lives once, in `entries/` and `skills.yaml`,
 * so a resume is small — and self-contained. What the file says is what the
 * resume is.
 */
export interface ResumeSpec {
  id: string;
  label: string;
  /**
   * Resumes used to inherit, through `extends`, and no longer do. A store
   * written by an older version is folded flat on the way in — see
   * `flatten.ts` — so nothing downstream ever sees this; it is declared only
   * so the migration has a name for what it is reading.
   *
   * @deprecated Read by the migration, written by nothing.
   */
  extends?: string;
  /**
   * Which resume this one was copied from, as a plain record.
   *
   * The link is gone; the fact is worth keeping. "Built on Summer intern" is
   * the right thing to show in an application's detail, and as provenance it
   * says that without anything merging behind it.
   */
  copiedFrom?: string;
  /**
   * How permanent this resume is, and how eagerly it is offered.
   *
   * `base` — what you actually build from, and what the extension offers
   * first. `extended` — a permanent resume in the save that is not offered
   * first: kept, findable, never swept. `temporary` — made for one posting,
   * worked on, sent, and then gone a week later, recoverable from the version
   * history like anything else deleted.
   *
   * Absent means `extended`, which is the reading that cannot lose anybody's
   * work: a resume written by a version that had no tiers, or by hand, is
   * permanent until somebody says otherwise.
   */
  tier?: ResumeTier;
  /**
   * When this resume became temporary, for the sweep to count from.
   *
   * Only ever a fallback: the week is normally measured from the application
   * being sent, because a posting you are still writing for is not one to
   * take the resume away from. This covers the copy that was made and then
   * abandoned — no application, nothing to measure — and, more importantly,
   * the resumes an upgrade makes temporary. A save upgraded today must not
   * lose three months of work tonight because a field appeared under it, so
   * their clock starts when the migration ran.
   */
  temporaryFrom?: string;
  /**
   * Pinned as a starting point.
   *
   * @deprecated Superseded by `tier: 'base'`. Read by the migration only.
   */
  base?: boolean;
  sections?: SectionSpec[];
  /**
   * Variant selection. Keys are either a bullet id (`b_kafka`) or a field path
   * (`edu_neu.dates`). Values are variant ids. A key absent means the wording
   * pinned as the default in the store, so re-pinning still reaches every
   * resume that has not decided for itself.
   */
  choices?: Record<string, string>;
  /**
   * Which items to show on a list bullet, keyed by bullet id. Absent means all
   * of them.
   */
  lists?: Record<string, string[]>;
  /** Rendering knobs, over the save's own defaults. */
  layout?: LayoutDefaults;
  /**
   * Entry ids folded away in the editor for this resume.
   *
   * A view preference, and it prints nothing — but it belongs to the resume
   * rather than to the browser, because which entries you are done with is a
   * fact about the document you are building and it should still be true on
   * another machine, or after the save is cloned.
   */
  collapsed?: string[];
  notes?: string;
  /** Set when the extension generated this for a specific posting. */
  generatedFor?: { url?: string; company?: string; role?: string; at?: string };
}

/** See `ResumeSpec.tier`. */
export type ResumeTier = 'base' | 'extended' | 'temporary';

/** Tiers in the order every picker and list shows them. */
export const RESUME_TIERS: ResumeTier[] = ['base', 'extended', 'temporary'];

/**
 * A resume with no tier written down is permanent.
 *
 * Absent has to mean `extended` rather than `temporary`, and it is worth
 * saying why in code rather than in a comment somewhere else: the sweep
 * deletes temporary resumes, and a file written by an older version — or by
 * hand, in a folder advertised as editable YAML — must never be swept because
 * of a field its author had no way to know about.
 */
export function tierOf(spec: Pick<ResumeSpec, 'tier'>): ResumeTier {
  return spec.tier ?? 'extended';
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
  /*
   * How small auto-fit is allowed to go before it gives up and lets the
   * document be two pages.
   *
   * This was 9.2pt at ×0.78 spacing inside 0.35in margins, which does fit more
   * on a page and is not a resume anybody wants to receive: it is a wall of
   * text set smaller than a footnote, with margins tight enough that some
   * printers clip it. The point of a floor is that below it the honest answer
   * is "this is too long", not "here it is, unreadable".
   *
   * 10pt is the smallest body size in common advice for a resume, ×0.92 keeps
   * lines from touching, and 0.4in stays inside what printers and the parsers
   * that read these documents handle. All three are `fitBounds` on the layout,
   * so a resume that wants to push further still can — it is a setting, not a
   * rule — but it has to say so rather than have it happen quietly.
   */
  fitBounds: { minFontSizePt: 10, minSpacing: 0.92, minMarginIn: 0.4 },
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

/** A profile with its choices made: the name is one name by the time it prints. */
export type ResolvedProfile = Omit<Profile, 'name'> & { name: string };

export interface ResolvedResume {
  id: string;
  label: string;
  profile: ResolvedProfile;
  sections: ResolvedSection[];
  layout: LayoutOptions;
  /** Non-fatal problems: dangling ids, choices that matched nothing. */
  warnings: string[];
  /**
   * The same problems, as things rather than as sentences: every id this
   * resume asks for that the store no longer has.
   *
   * Two jobs. One is counting — "2 entries this resume chose are no longer in
   * your store", which is what somebody about to attach a file needs, and
   * which cannot be said by printing `b_ec_pipeline` at them. The other is
   * offering to do something about it: a reference that names nothing is not
   * a thing to go and fix in the master document, it is a thing to take out
   * of this resume, and the editor can only offer that button if it is told
   * which reference and of what kind. See `describeLost` and the warnings
   * panel.
   */
  lost?: LostReference[];
}

/**
 * One id a resume asks for and the store does not have.
 *
 * `says` is the warning printed beside it, carried here verbatim so that the
 * two never drift and so the editor can show each problem once: it draws a
 * row per entry here and then the warnings that are not one of these. They
 * are the same string because they are pushed from the same place — see
 * `resolveResume`.
 */
export interface LostReference {
  /**
   * What the resume was asking for. `wording` is a choice key: either one
   * that matches no field or bullet at all, or one naming a variant that has
   * since been renamed or deleted. Both are undone the same way — the choice
   * comes out and the default is used — so both are one kind.
   */
  kind: 'entry' | 'bullet' | 'wording' | 'skill' | 'skillGroup' | 'listItem';
  /** The id itself, which is what a removal takes out of the spec. */
  id: string;
  /** The warning beside it, word for word. */
  says: string;
}

/* ------------------------------------------------------------------ *
 * Application tracking                                                *
 * ------------------------------------------------------------------ */

/**
 * Where an application has got to — five rungs and an ending.
 *
 * There were nine, and the extra four were distinctions nobody acts on: an
 * online assessment and an interview are both "they came back and there is
 * something to prepare for"; rejected, ghosted and withdrawn are all "this
 * one is over" and differ only in whose fault it was. A dropdown of nine
 * makes you classify instead of record, and the tracker is worth having only
 * if updating it is free.
 *
 * The ladder is what remains — it goes one way, and each rung means something
 * different has to happen next.
 */
export type ApplicationStatus =
  /** Found, not started. */
  | 'interested'
  /** Being worked on — the letter written, the answers drafted — but not sent. */
  | 'applying'
  /** Out of your hands. */
  | 'applied'
  /** They came back: a call, an assessment, a panel. Something to prepare for. */
  | 'interview'
  /** They said yes. */
  | 'offer'
  /** Over, however it ended. The history says which. */
  | 'closed';

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
  /**
   * What this application calls its documents, where the store's default is
   * not what this portal or this posting wants.
   *
   * On the application rather than in the settings, because the settings are
   * about every application there will ever be. "This one will only take
   * `resume.pdf`" and "put the title in this one's name" are both about one
   * posting, and neither is a reason to rename the next fifty.
   */
  naming?: {
    shape?: 'type' | 'title' | 'title-type';
    custom?: Partial<Record<'Resume' | 'Cover Letter' | 'Answers', string>>;
  };
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
  /**
   * The most characters the form's box takes, when it says (its `maxlength`).
   * A script assigning a value is not held to it, so an answer over it went
   * into the box whole and was refused when the form was sent.
   */
  limit?: number;
  answer: string;
  /** Which answer-bank item this came from, when it came from one. */
  fromAnswerId?: string;
  /** How the current text got here. */
  source?: 'bank' | 'ai' | 'human' | 'empty';
  /**
   * Set when the text came from a stored answer that only loosely matched.
   * `matchAnswer` draws the line between "safe to send unread" and "a starting
   * point the user should read first", and the loose ones used to arrive
   * looking exactly like the confident ones.
   */
  needsReview?: boolean;
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
  /**
   * Whether this counts as an example of how you write.
   *
   * Absent means yes, which is what every letter and answer in every save
   * written before this meant and still means — so nothing has to be
   * converted and nobody's voice changes under them. `false` is the one thing
   * this field says: keep this one out.
   *
   * It is worth being able to say. The corpus is what any AI request is told
   * to sound like, and a letter written to a template, an answer that is a
   * date, or a draft somebody was not pleased with are all things you would
   * keep and would not want imitated. Archiving is the same idea for pasted
   * samples; a letter cannot be archived, because it is also a document you
   * sent and that record stays.
   */
  voice?: boolean;
}

/** A reusable answer to an application question, written in the user's voice. */
export interface AnswerBankItem {
  id: string;
  question: string;
  /** Alternate phrasings/lengths of the same answer. */
  variants: Variant[];
  default: string;
  tags?: string[];
  /** See `CoverLetter.voice`: absent means yes, `false` keeps it out. */
  voice?: boolean;
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
    /**
     * Let the AI look things up online while it works — what the company
     * builds, what the team does, what was announced last month.
     *
     * Off by default, and its own switch rather than part of `enabled`,
     * because it is a different decision: everything else here runs against
     * text you supplied, and this is the one setting that lets the model go
     * and read something you did not choose.
     */
    research?: boolean;
    /**
     * Which model, and how hard it should think.
     *
     * Kept apart from `args` on purpose. A preset is copied when it is chosen
     * rather than referenced, so hand-editing the arguments to change a model
     * turns the configuration into a custom one that then drifts out of date
     * with the preset it came from — the exact failure that made "I picked a
     * preset and it still ran the old command" possible. These two are
     * applied to the arguments on load, the way `research` is, so the saved
     * arguments stay preset-shaped.
     *
     * Empty means "whatever the CLI would do anyway", which is the right
     * default: every one of these tools picks a sensible model on its own.
     */
    model?: string;
    /**
     * And a model per kind of work, where one is not enough.
     *
     * Overrides `model` for that kind only. Absent or empty means "whatever
     * `model` says", which is what almost everyone wants and is why this is
     * a second setting rather than four required ones.
     */
    models?: Partial<Record<'tailor' | 'write' | 'review' | 'author', string>>;
    effort?: 'low' | 'medium' | 'high';
    timeoutMs: number;
  };
  git: {
    /** Auto-commit every mutation to the data directory. */
    autoCommit: boolean;
  };
  output: {
    /** Resolve output inside the project; older stores resolve beside it. */
    withinProject?: boolean;
    /** Where generated PDFs and application bundles land. */
    dir: string;
    /**
     * What goes after the person's name in a bundle's filenames.
     *
     *   'type'        FirstName-LastName-Resume.pdf
     *   'title'       FirstName-LastName-Data-Platform-Intern.pdf
     *   'title-type'  FirstName-LastName-Data-Platform-Intern-Resume.pdf
     *
     * `'type'` by default, because most of the time the title is noise — the
     * reviewer opening the attachment already knows which role they
     * advertised. The other two earn their place when several applications are
     * open at once and you want to tell them apart in a file picker without
     * opening them.
     *
     * `'title'` cannot name two documents of one application apart on its own,
     * so where it would collide — a resume and a cover letter going to the
     * same posting — the type is added back to the ones that clash. A name
     * that is short is worth having; two files with one name is not.
     */
    fileNames?: 'type' | 'title' | 'title-type';
  };
  /**
   * The page, for every resume in the save that has not said otherwise.
   *
   * Layout used to arrive by inheritance: a base stated the font size and the
   * margins, and every variation of it took them. That was the one thing
   * inheritance carried which nothing else covers, and resumes stand alone
   * now — so without this, "make my margins a little wider" is an edit to
   * every resume you own, one at a time, and a resume made next week would
   * still arrive with the old ones.
   *
   * It belongs here rather than on a resume anyway. Font size and margins are
   * a fact about how you like a page to look, not about which job you are
   * applying for, and the per-resume `layout` stays for the one that has to
   * be squeezed a little harder to fit.
   */
  layout?: LayoutDefaults;
  resumes?: {
    /**
     * How many days a temporary resume lives after its posting is done with.
     *
     * Zero or less switches the sweep off rather than making it instant. That
     * is the only reading of "0" that cannot lose work by being typed into a
     * settings box by mistake, and this is the one setting in the program
     * whose wrong value deletes something.
     */
    temporaryDays?: number;
  };
  applications?: {
    /**
     * How many days an application may sit at Applying with nothing done to
     * it before it is closed. Zero or less leaves them alone, for the same
     * reason `temporaryDays` gives.
     */
    applyingDays?: number;
  };
}

export const DEFAULT_CONFIG: StoreConfig = {
  latex: {},
  ai: {
    command: 'claude',
    /*
     * The confined Claude invocation, byte for byte the same as the Claude Code
     * preset in ai/presets.ts. (Stated literally rather than imported, because
     * presets.ts reads its types from this file; a test asserts the two agree.)
     *
     * This used to be `['-p', '{prompt}']` — no scratch directory, no deny
     * list. It reads like a harmless placeholder, and for the shipped store it
     * was, because that store's config.yaml carries the full block. But a save
     * the user creates from the app is written with only `output:` in it, and
     * loadConfig fills the rest in from here. Switch the AI on in Settings and
     * the command line was `claude -p /tmp/rmm-ai-xxx/prompt.md` with Bash,
     * Write, Edit, WebFetch and WebSearch all live, against the user's own
     * machine — while the Settings panel said the AI could never reach your
     * save folder, your home directory, or this source tree.
     */
    args: ['-p', '--add-dir', '{sandbox}', '--disallowedTools', 'Bash,BashOutput,KillShell,Write,Edit,NotebookEdit,Read,Glob,Grep,Task,TodoWrite,SlashCommand,WebFetch,WebSearch'],
    enabled: false,
    timeoutMs: 180_000,
  },
  git: { autoCommit: true },
  output: { dir: 'out', fileNames: 'type' },
  // Empty, not a copy of DEFAULT_LAYOUT: absent here means "whatever this
  // version thinks a resume should look like", so a save that never had an
  // opinion follows the app rather than being frozen at the moment it was
  // created.
  layout: {},
};

/**
 * Layout as somebody states it: any subset, including a subset of the floors.
 *
 * `Partial<LayoutOptions>` is not that — it makes `fitBounds` optional and
 * leaves all three floors inside it required, so raising one meant restating
 * the other two. Which is the same silent-pinning shape that made resume
 * inheritance worth removing: a value written down because the type demanded
 * it, and frozen at whatever it happened to be that day.
 */
export type LayoutDefaults = Partial<Omit<LayoutOptions, 'fitBounds'>> & {
  fitBounds?: Partial<LayoutOptions['fitBounds']>;
};

/**
 * The page a resume is set on: this version's defaults, then the save's, then
 * the resume's own.
 *
 * Three levels, in the order of how specific each is. `fitBounds` is merged
 * at its own level for the same reason — a save that widens the margin floor
 * should not have to restate the font floor beside it.
 */
export function layoutFor(
  own: LayoutDefaults | undefined,
  saveWide: LayoutDefaults | undefined,
): LayoutOptions {
  return {
    ...DEFAULT_LAYOUT,
    ...(saveWide ?? {}),
    ...(own ?? {}),
    fitBounds: {
      ...DEFAULT_LAYOUT.fitBounds,
      ...(saveWide?.fitBounds ?? {}),
      ...(own?.fitBounds ?? {}),
    },
  };
}

export function isVariantField(v: MaybeVariant | undefined): v is VariantField {
  return typeof v === 'object' && v !== null && Array.isArray((v as VariantField).variants);
}
