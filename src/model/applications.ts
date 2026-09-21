import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Store } from './store.js';
import type { Application, ApplicationStatus, ResolvedResume } from './types.js';
import { compileLetter, compileResume } from '../render/compile.js';
import { syncCurrent } from './current.js';
import { resolveResume, unsendableReason } from './resolve.js';

/**
 * One hyphenated part of a filename.
 *
 * Letters and digits in any alphabet, not only `\w`, which is ASCII: "Jane Doe
 * Resume rsted.pdf" was going to Ørsted, and a company written in Chinese
 * vanished from the name entirely. Everything else becomes a separator, and
 * runs of separators collapse, so nothing comes out with a double hyphen or a
 * hyphen hanging off either end.
 */
function namePart(s: string | undefined): string {
  return String(s ?? '')
    .replace(/[^\p{L}\p{N}_\s-]/gu, ' ')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** What a document in a bundle is: the last part of its name. */
export type DocumentKind = 'Resume' | 'Cover Letter' | 'Answers';

/**
 * File naming is a surprising amount of the pain in applying: every portal
 * wants the same shape, and renaming a download each time is how the wrong
 * file ends up attached. Bundles are produced already named right.
 *
 *     FirstName-LastName-<Job Title>-<Document Type>.pdf
 *
 * The role rather than the company, because the role is what distinguishes two
 * applications you are actually working on at once — and because a reviewer
 * opening the attachment already knows which company they are. It is optional:
 * without one the name is just the person and the document type.
 *
 * `disambiguator` is for the one case the shape above cannot separate on its
 * own — the same person applying for the same role at two companies at the same
 * time, whose files share a folder in `out/current`. Nothing else passes it.
 */
export function bundleFileName(
  name: string,
  role: string | undefined,
  kind: DocumentKind | undefined,
  { extension = '.pdf', disambiguator }: { extension?: string; disambiguator?: string } = {},
): string {
  const parts = [namePart(name), namePart(role), namePart(kind), namePart(disambiguator)];
  return parts.filter(Boolean).join('-') + extension;
}

/** The three shapes the setting offers, and what each one puts in a name. */
export type FileNameShape = 'type' | 'title' | 'title-type';

/**
 * Name every document of one application, in the shape asked for.
 *
 * Done together rather than one at a time because `'title'` cannot tell two
 * documents of one application apart: the resume and the cover letter going to
 * the same posting are both `FirstName-LastName-Data-Platform-Intern.pdf`, and
 * the second would quietly replace the first in the folder you are about to
 * upload from. Where that happens the type comes back — on the clashing names
 * only, so an application with just a resume still gets the short name that
 * was asked for.
 */
export function bundleFileNames(
  name: string,
  role: string | undefined,
  documents: { kind: DocumentKind; extension?: string }[],
  shape: FileNameShape = 'type',
): string[] {
  const titled = shape === 'type' ? undefined : role;
  const wanted = (withType: boolean) =>
    documents.map((d) =>
      bundleFileName(name, titled, withType || shape !== 'title' ? d.kind : undefined, {
        extension: d.extension,
      }),
    );

  const short = wanted(false);
  if (new Set(short).size === short.length) return short;

  // Two documents claimed one name. Only the clashing ones grow.
  const counts = new Map<string, number>();
  for (const n of short) counts.set(n, (counts.get(n) ?? 0) + 1);
  const full = wanted(true);
  return short.map((n, i) => ((counts.get(n) ?? 0) > 1 ? full[i]! : n));
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

  return faithful(company, role) ? readable : `${readable}-${fingerprint(company, role)}`.replace(/^-+/, '');
}

/**
 * Does the slug still say which application this is?
 *
 * It does not when a name has no ASCII in it — the slug is empty — nor when a
 * name is long enough that `slug` truncates it to sixty characters, since two
 * that share a prefix truncate to the same thing. Either way two applications
 * collapse into one id, and an id is what the tracker row, the bundle folder
 * and the upload file are all keyed on.
 *
 * Asked of each name separately, which is the whole of it. Asking it of the
 * two joined together — "is there any ASCII anywhere in this pair" — reads as
 * the same question and is not: a Chinese company hiring for "Software
 * Engineer" has plenty of ASCII in the pair and none of it in the half that
 * says who the employer is. Measured, before this was a function: two
 * different companies advertising that role on the same day both minted
 * `2026-09-16--software-engineer`, so the second tracker row replaced the
 * first and the second bundle was built into the first one's folder. That is
 * the more likely half of the case, too — one field written in another script
 * is ordinary, both of them rather less so.
 */
/**
 * Characters a slug throws away that are part of the name, not punctuation
 * between words.
 *
 * `slug` deleting a full stop is the leniency working: "Acme Corp." and "Acme
 * Corp" are one employer and should not become two tracker rows. `slug`
 * deleting a plus sign is the leniency going wrong — "C++ Engineer", "C#
 * Engineer" and "C Engineer" all reduce to `c-engineer`, all three looked
 * faithful, and all three collapsed onto one id. Applying to a company's C++
 * role and then its C# role overwrote the first row with the second's company,
 * role, url and answers, and `handOver` swept the first application's files
 * out of the folder they shared. Nothing looked wrong afterwards: the tracker
 * consistently showed one application.
 *
 * Deliberately short. Every character added here makes two names that differ
 * only by it into two applications, which is the mistake in the other
 * direction — so it holds the ones that name a different thing rather than
 * spell the same thing differently.
 */
const MEANT_IT = /[+#]/;

function faithful(company: string, role: string): boolean {
  const says = (name: string) =>
    slug(name).length > 0 && slug(name).length < 60 && !MEANT_IT.test(name);
  return says(company) && says(role);
}

/**
 * What makes two applications the same job.
 *
 * Not the id: an id carries the day it was made, and the same job looked at on
 * two days is one job. So the finders below match on the names instead, and
 * they match on the *slug* of the names deliberately — a posting board writing
 * "Acme Corp." and a careers page writing "Acme Corp" are the same employer,
 * and a person should not get two tracker rows for the difference.
 *
 * Which leaves the names a slug cannot represent, and there the leniency turns
 * into the opposite mistake: every company written in Chinese slugs to the
 * empty string, so `findApplication` handed back some entirely different
 * employer's row, a build for one job landed in another's folder, and
 * `alreadySent` told somebody they had already applied to a company they had
 * never heard of. `applicationId` had already been taught to fingerprint those
 * names; the three functions that decide what an id *means* had not, so the
 * ids stayed distinct while everything that looked them up did not.
 *
 * The fingerprint is taken over a tidied name rather than the raw one, so the
 * leniency survives where it can: trailing whitespace and letter case still do
 * not make a second application.
 */
export function identity(company: string, role: string): string {
  const key = `${slug(company)}\u0000${slug(role)}`;
  if (faithful(company, role)) return key;
  const tidy = (s: string) => s.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${key}\u0000${fingerprint(tidy(company), tidy(role))}`;
}

/**
 * What each kind of lost reference is called in a sentence a person reads,
 * singular and plural, in the order they are listed.
 *
 * Ordered deliberately: an entry gone is the biggest hole in the document and
 * a list item the smallest, and somebody skimming this line before attaching
 * a file should meet the worst of it first.
 */
const LOST_WORDS: Record<string, [string, string]> = {
  entry: ['entry', 'entries'],
  bullet: ['line', 'lines'],
  skillGroup: ['skills group', 'skills groups'],
  skill: ['skill', 'skills'],
  wording: ['wording', 'wordings'],
  listItem: ['list item', 'list items'],
};

/**
 * "One entry and two wordings", from the resolver's count of what it could
 * not find. Undefined when it found everything, so the caller can ask
 * whether there is anything to say by asking whether this is there.
 *
 * Also undefined when everything in the list is of a kind this does not name,
 * rather than "  this resume chose is no longer in your store." — the kinds
 * grew and the counting did not, once.
 */
export function describeLost(lost: { kind: string }[]): string | undefined {
  const parts: string[] = [];
  let total = 0;
  for (const [kind, [one, many]] of Object.entries(LOST_WORDS)) {
    const n = lost.filter((l) => l.kind === kind).length;
    if (n === 0) continue;
    total += n;
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  if (total === 0) return undefined;
  /*
   * "a, b and c", not "a, b, c". The old form switched wholesale to commas
   * the moment there were three parts, which read as a truncated list rather
   * than a finished sentence — and the list can now run to six.
   */
  const what =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${what} this resume chose ${total === 1 ? 'is' : 'are'} no longer in your store.`;
}

/**
 * The application this company and role already has, whatever day it began.
 *
 * An id carries the date it was made, which is right for a folder name and
 * wrong for identity: an application opened before midnight and sent after it
 * asks for an id that does not exist, and a second row appears for the same
 * job. That is not a hypothetical — it is what the suite found on the stroke
 * of midnight, three systems in a row reporting a submission against a
 * tracker row that was still "applying" because the send had quietly created
 * its own.
 *
 * Identity is the company and the role. The most recent one still being
 * worked on is the one meant; failing that, the most recent that is still
 * live, because a bundle built for a job already sent is the ordinary "I
 * spotted a typo, do that again" and belongs in the same folder.
 *
 * Never one that is over, and that is the whole of the difference between
 * this and what it used to do. "The same job applied for twice a year apart
 * is two applications" was written here from the start and then not done:
 * every row matched, so a job that had been applied for and rejected in March
 * was the row a fresh attempt in September was filed as. Measured, on a
 * rejection and a repost of the same role: the September build landed in
 * March's folder and deleted the take-home brief kept in it, the tracker
 * showed one row reading `closed` and dated March with a "Files rebuilt"
 * note, and the new application — the one actually being sent that day — had
 * no record of its own anywhere. It also dropped out of the flat upload
 * folder, which carries only what is in flight, so the files it had just
 * built were nowhere a file picker would find them.
 */
export function findApplication(apps: Application[], company: string, role: string): Application | undefined {
  const key = identity(company, role);
  const same = apps.filter((a) => identity(a.company, a.role) === key);
  if (same.length === 0) return undefined;

  const byNewest = (a: Application, b: Application) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? '');
  const unsent = same.filter((a) => a.status === 'interested' || a.status === 'applying');
  if (unsent.length > 0) return unsent.sort(byNewest)[0];
  // Undefined when every one of them is finished: this is a new attempt, and
  // it needs a row and a folder of its own. See `freshApplicationId`.
  return same.filter((a) => a.status !== 'closed').sort(byNewest)[0];
}

/**
 * An id for an application that does not have one yet, and does not take
 * another's.
 *
 * `applicationId` is today's date and the name, which is what anybody would
 * want to see in a folder listing and is not unique: apply in the morning,
 * be turned down in the afternoon, and apply again to the repost the same
 * day, and the second attempt asks for the first one's id — which is the
 * first one's tracker row and the first one's folder of sent files.
 *
 * Counted rather than stamped with a time, because the id is a folder name
 * somebody reads.
 */
export function freshApplicationId(apps: Application[], company: string, role: string): string {
  const wanted = applicationId(company, role);
  const taken = new Set(apps.map((a) => a.id));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    if (!taken.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
  }
}

/**
 * Have I sent this one before?
 *
 * The other half of `findApplication`, and a different question. That one
 * answers "which row does this belong to", and prefers one still being worked
 * on, because the point is not to file a second row for a job already open.
 * This one asks whether there is a row that has already gone out — which is
 * something a person standing in front of the posting wants to know before
 * they spend twenty minutes on it again.
 *
 * `applying` and `interested` do not count: those are this application, or an
 * intention to make it, and saying "you already applied" about a draft you
 * are in the middle of would be a lie told confidently. Everything past
 * sending counts, `closed` included — a job you were turned down for is the
 * one you would most like to be reminded about before writing another letter.
 */
export function alreadySent(apps: Application[], company: string, role: string): Application | undefined {
  const key = identity(company, role);
  return apps
    .filter((a) => identity(a.company, a.role) === key)
    .filter((a) => a.status !== 'interested' && a.status !== 'applying')
    .sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))[0];
}

/** The same question about a workspace, whose id is made the same way. */
export function findDraft<T extends { id: string; company: string; role: string; status: string; updatedAt?: string }>(
  drafts: T[],
  company: string,
  role: string,
): T | undefined {
  const key = identity(company, role);
  const same = drafts.filter((d) => identity(d.company, d.role) === key);
  if (same.length === 0) return undefined;
  const open = same.filter((d) => d.status !== 'submitted');
  return (open.length > 0 ? open : same).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
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
  /**
   * What the resume asked for and the store no longer has, in a sentence.
   *
   * Separate from `warnings`, which also carries typography notes about the
   * TeX install — true, worth saying once, and not worth putting in front of
   * somebody about to attach a file. This is the other kind: an entry the
   * spec lists and the store has lost, a choice pointing at a wording that
   * has been renamed. The resume still compiles; it is simply not the one
   * that was on screen, and nothing said so.
   *
   * A sentence and not the warnings themselves, because those name ids —
   * right for the editor, where you would go and fix them, and meaningless
   * in a card that is about to attach a file: nobody has ever typed
   * "b_ec_pipeline".
   */
  missing?: string;
}

/**
 * One build at a time per application.
 *
 * Two builds of the same application write the same folder and the same
 * tracker row, and neither is safe against the other. The folder hand-over
 * sweeps out anything the build that is landing did not produce, so a build
 * without a cover letter finishing after one with a letter takes the letter
 * out from under it; the tracker row is read, changed and written back, so
 * the later write drops whatever the earlier one recorded.
 *
 * It used to take two deliberate presses of the filing button seconds apart
 * to arrange that. Building stages the files now, so every build runs one of
 * these, and pressing Recompile while the last one is still compiling is an
 * ordinary thing to do.
 *
 * Serialised rather than refused: the second build is not a mistake, it is
 * the newer resume, and it should land — after the one in front of it, not
 * across it. Keyed by the folder the build writes, which is what two builds
 * have to share before they can collide.
 */
const building = new Map<string, Promise<unknown>>();

async function inBuildLane<T>(id: string, run: () => Promise<T>): Promise<T> {
  const queue = building.get(id) ?? Promise.resolve();
  // `run` on either settlement, so one failed build does not wedge the ones
  // queued behind it — each is still worth attempting on its own.
  const mine = queue.then(run, run);
  const settled = mine.then(() => {}, () => {});
  building.set(id, settled);
  try {
    return await mine;
  } finally {
    // Only when nothing else has queued behind this one, or the map keeps a
    // resolved promise per application for the life of the process.
    if (building.get(id) === settled) building.delete(id);
  }
}

/**
 * Produce one folder holding everything an application needs, named the way
 * portals expect, plus a snapshot of the exact resume that was sent. The
 * snapshot is the point: six weeks later, when they ask about "the pipeline
 * project", the file that went out is still there, byte for byte.
 */
export async function buildBundle(store: Store, req: BundleRequest): Promise<BundleResult> {
  const data0 = store.load();
  const existing = findApplication(data0.applications, req.company, req.role);
  return inBuildLane(
    existing?.id ?? freshApplicationId(data0.applications, req.company, req.role),
    () => buildBundleNow(store, req),
  );
}

async function buildBundleNow(store: Store, req: BundleRequest): Promise<BundleResult> {
  const data = store.load();
  const resolved: ResolvedResume = resolveResume(req.resumeId, data);

  /*
   * Before anything is compiled, named or filed — see `unsendableReason`.
   *
   * This is the last point at which a document is still nobody's but yours.
   * Past here it is a PDF with a name on it, an application marked as sent,
   * and a file in the folder a portal's picker is pointed at, and every one
   * of those steps used to report success over a page headed "Your Name".
   */
  const unsendable = unsendableReason(resolved.profile);
  if (unsendable) throw new Error(unsendable);
  /*
   * Taken here, beside the resolve, and not read again when the snapshot is
   * written further down.
   *
   * The two are a pair: the spec is what was selected and `resolved` is what
   * that came out as, and a snapshot holding one from before a compile and
   * the other from after is a record of something that never existed. The
   * window is not small — compiling is the slow part of this function, and
   * the sweep that removes a resume made for one posting runs on its own.
   * Read late, the spec could be `undefined` for a resume that was there
   * when the document was built.
   */
  const spec = data.resumes.find((r) => r.id === req.resumeId);

  /*
   * All three names decided together, because the shape that leaves the
   * document type out cannot tell a resume from a cover letter on its own.
   * Every document this bundle might hold is listed here whether or not it is
   * written, so a name does not change depending on what else was included.
   */
  const [resumeName, letterName, answersName] = bundleFileNames(
    resolved.profile.name,
    req.role,
    [{ kind: 'Resume' }, { kind: 'Cover Letter' }, { kind: 'Answers', extension: '.md' }],
    data.config.output.fileNames ?? 'type',
  ) as [string, string, string];

  /*
   * The row this job already has, if it has one — see `findApplication`. The
   * folder is named after it, so a bundle built the day after the
   * application was opened lands in that application's folder rather than in
   * a second one beside it.
   */
  const id =
    findApplication(data.applications, req.company, req.role)?.id ??
    freshApplicationId(data.applications, req.company, req.role);
  /*
   * Through the store, so an id that is a path cannot choose the folder. The
   * id here is often not one this code made — `findApplication` takes it from
   * applications.yaml — and the loop below used to delete every file in
   * whatever folder it named. See `Store.outFile`.
   */
  let dir: string;
  try {
    dir = store.outFile('applications', id);
  } catch (err) {
    /*
     * Refused by the store, and said here in terms of the thing the person can
     * actually go and change. `Store.outFile` knows a name is not a name; it
     * does not know that this one came off a tracker row, and "That name is
     * not allowed" in front of somebody trying to send an application names
     * nothing they can see or edit.
     */
    const said = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The tracked application for ${req.company} — ${req.role} has an id that cannot be a folder name ` +
        `("${id.slice(0, 60)}"): ${said} Fix or remove that row in the tracker and build again.`,
      { cause: err },
    );
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  /*
   * Built beside the folder, and moved into it once it is all there.
   *
   * A rebuild replaces the bundle rather than adding to it — the id is
   * company, role and date, so building the same application twice in a day
   * writes into the same folder, and every file whose name changed in between
   * would otherwise sit beside its replacement. Change how your name is
   * written, or rebuild without the cover letter you had before, and the
   * folder holds two resumes or an orphaned letter, both of which then get
   * copied into the flat upload folder where the whole point is that the file
   * in front of you is the one to send.
   *
   * That clearing used to happen first, before anything was compiled, and the
   * bundle folder is the archive: "six weeks later, when they ask about the
   * pipeline project, the file that went out is still there". It was not.
   * Anything between the clearing and the last write — an emoji in a title
   * that no engine can set, an entry the spec names and the store has since
   * lost, a full disk, closing the laptop — left the folder holding `source/`
   * and nothing else. The resume that was actually sent, the cover letter, the
   * plain-text copy of it and the answers: deleted, by a rebuild that then
   * reported an error about typography.
   *
   * Staging costs one rename per file and makes the two states the only two
   * there are. Either the folder is the bundle that was sent, or it is the new
   * one; a crash in the middle leaves the old one intact and a `.rmm-building-`
   * folder to sweep up, and nothing half-written is ever inside the folder the
   * tracker points at or the upload folder copies from.
   */
  const stage = fs.mkdtempSync(path.join(path.dirname(dir), '.rmm-building-'));

  /*
   * What this application's letter and answers actually are, read before
   * anything is compiled — because the files below are built from them and
   * the tracker row at the end is written from them, and the two disagreeing
   * is how the archive got destroyed.
   *
   * The row keeps what the caller did not mention; the *files* were built
   * from `req` alone. So `rmm apply`, which passes company, role, url and the
   * resume id and nothing else, rebuilt the folder with the resume only —
   * and `handOver` deletes every file in the destination the build did not
   * write. Measured: a bundle filed from the editor with a letter and
   * answers, rebuilt from the CLI, came back holding one PDF, while its
   * tracker row still read `coverLetter: Dear Initech, …`. The folder is the
   * archive — "six weeks later, when they ask about the pipeline project, the
   * file that went out is still there" — and it was not.
   */
  const before = store.load().applications.find((a) => a.id === id);
  const letter = req.coverLetter === undefined ? before?.coverLetter : req.coverLetter?.trim() || undefined;
  const answers = req.answers ?? before?.answers;

  try {
    const pdfPath = path.join(stage, resumeName);
    const compiled = await compileResume(resolved, {
      pdfPath,
      texPath: path.join(stage, 'source', 'resume.tex'),
    });

    const files = [resumeName];

    if (letter) {

      // Typeset to match the resume, with the trusted engine — this is a file
      // that gets uploaded, so it never takes the preview shortcut. The plain
      // text goes alongside it, because as many portals want a letter pasted
      // into a box as want one attached.
      await compileLetter(
        {
          profile: resolved.profile,
          company: req.company,
          role: req.role,
          body: letter,
        },
        resolved.layout,
        { pdfPath: path.join(stage, letterName), texPath: path.join(stage, 'source', 'cover-letter.tex') },
      );
      files.push(letterName);

      const textPath = path.join(stage, letterName.replace(/\.pdf$/, '.txt'));
      fs.writeFileSync(textPath, letter, 'utf8');
      files.push(path.basename(textPath));
    }

    if (answers?.length) {
      /*
       * Named like the other two rather than `application-answers.md`. A
       * constant was fine inside a per-application folder and collided for any
       * two applications at once in the flat one — and the flat folder is the
       * one you upload from.
       */
      const qaPath = path.join(
        stage,
        answersName,
      );
      /*
       * Titled, because this one is read rather than uploaded.
       *
       * The resume and the letter are attachments: a portal takes them and
       * nobody opens them again. This file is the one you sit with, copying
       * answers into boxes — often with a second application's open beside it,
       * since the flat folder holds everything in flight at once. It began
       * straight in at "## Why this team?", with nothing on the page saying
       * whose question that was.
       */
      const title = [req.company, req.role].filter(Boolean).join(' — ');
      fs.writeFileSync(
        qaPath,
        `# ${title}\n\n${answers.map((a) => `## ${a.question}\n\n${a.answer}\n`).join('\n')}`,
        'utf8',
      );
      files.push(path.basename(qaPath));
    }

    // The resolved resume is stored as data too, so a past application can be
    // reopened as a starting point without re-deriving it from the store as it
    // stands today.
    fs.mkdirSync(path.join(stage, 'source'), { recursive: true });
    fs.writeFileSync(
      path.join(stage, 'source', 'resolved.yaml'),
      YAML.stringify({ spec, resolved }, { lineWidth: 0 }),
      'utf8',
    );

    // Everything is written. Now it becomes the bundle.
    fs.mkdirSync(dir, { recursive: true });
    handOver(stage, dir);

    const now = new Date().toISOString();
    /*
     * What this build knows, on top of what the tracker already knew.
     *
     * This used to write the row from scratch every time, which was survivable
     * while the only thing that called it was a person pressing the filing
     * button once. Building stages the files now, so it runs on every build,
     * and three things that were theoretical became ordinary.
     *
     * The status could go backwards. Staging asks for `applying`; if you had
     * already submitted the form on the page — or the run staging while you
     * did landed afterwards — the row went from `applied` back to `applying`
     * and the tracker said you had not sent something you had. An application
     * missing from the list is the one you apply for twice, so never
     * backwards: a status already past the one being asked for stands.
     *
     * The history was replaced rather than appended to, so every rebuild threw
     * away the record of what had happened to this application — which is the
     * whole point of keeping one.
     *
     * And `appliedAt` was stamped afresh, so the day you applied drifted to
     * the day you last rebuilt.
     */
    /*
     * And the row as it is *now*, not as it was before the build.
     *
     * "Never backwards" above was written against `before`, which is read at
     * the top of this function — before the LaTeX runs. A build takes a
     * second or two, and pressing Submit on the page takes less than that, so
     * the sequence that actually happens is: staging starts, the form is
     * submitted, `/extension/sent` writes the row as `applied`, the build
     * finishes and writes it back from a snapshot in which it was still
     * `applying`. The guard compared the right two things and one of them was
     * out of date, so the status went backwards anyway — and because the
     * history is rebuilt from `before` too, the `applied` line went with it,
     * leaving a row reading `applying` whose history says only "Bundle
     * created". No error, nothing in the log, and an application that has
     * gone out sitting in the tracker as one still being worked on. Which is
     * the one you apply for twice.
     *
     * Measured on the ATS walk: five of thirty-six systems per run, a
     * different five each time, depending only on whether the submit landed
     * inside the compile.
     *
     * `POST /workspace` learnt this and re-reads; this did not. Nothing
     * between here and `upsertApplication` below yields, so the read and the
     * write are one step as far as anything else on this server is concerned.
     */
    const settled = store.load().applications.find((a) => a.id === id) ?? before;

    const ORDER: ApplicationStatus[] = ['interested', 'applying', 'applied', 'interview', 'offer', 'closed'];
    const asked: ApplicationStatus = req.status ?? 'applied';
    const status =
      settled && ORDER.indexOf(settled.status) > ORDER.indexOf(asked) ? settled.status : asked;

    const application: Application = {
      ...settled,
      id,
      company: req.company,
      role: req.role,
      /*
       * And what the build was not told stays as the tracker had it.
       *
       * The spread above is there to keep what the row already knew, and these
       * five went straight back over the top of it with `undefined` — because
       * a caller that does not mention a field is not asking for it to be
       * cleared. `rmm apply` passes `{resumeId, company, role, url}` and
       * nothing else, so every rebuild from the CLI threw away the source, the
       * notes, the answers actually given and the letter actually sent, from
       * the row and from the bundle both, and wrote "Files rebuilt" over it.
       *
       * `status`, `appliedAt` and `history` were already spared by hand for
       * exactly this reason; these are the rest of it. The sibling route
       * `POST /api/applications` has always done this (`body.answers ??
       * existing?.answers`), which is what says the omission here was one.
       *
       * The letter keeps its own shape: an empty string still clears it, so
       * "I decided not to send one" remains sayable, and only an absent field
       * means "leave it alone".
       *
       * `?.trim()`, and the optional chaining is load-bearing. The card sends
       * `coverLetter: state.letter`, and `state.letter` is `null` on every
       * application that does not want one — so dropping it turned every
       * letterless "Submit" into "Cannot read properties of null (reading
       * 'trim')". Caught by the ATS walk, where the first posting wanted a
       * letter and the next fifteen did not.
       */
      url: req.url ?? settled?.url,
      appliedAt: settled?.appliedAt ?? now,
      status,
      resumeId: req.resumeId,
      snapshotDir: path.relative(store.outDir(), dir),
      source: req.source ?? settled?.source,
      notes: req.notes ?? settled?.notes,
      answers,
      coverLetter: letter,
      history: [
        ...(settled?.history ?? []),
        { at: now, status, note: settled ? 'Files rebuilt' : 'Bundle created' },
      ],
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
      missing: describeLost(resolved.lost ?? []),
    };
  } finally {
    // Whatever happened: no half-built folder is left for the next listing of
    // out/applications to show, and none survives to be confused with a
    // bundle. On the way out of a successful build it is already empty.
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Move a finished bundle into the folder the tracker points at.
 *
 * File by file, by rename, which within one filesystem is atomic — so every
 * name in the folder is either the old file or the new one, never a
 * half-written prefix of the new one. The new files go in before the stale
 * ones come out, deliberately: interrupted that way round the folder holds one
 * document too many, which the next successful build tidies up, rather than
 * one too few, which is gone.
 *
 * Only files are removed, and only files this build did not write. A folder
 * the user made in there is theirs and is left alone; `source/` is recursed
 * into because the build rewrites it, so an old `cover-letter.tex` does not
 * outlive the letter it came from.
 */
function handOver(from: string, to: string): void {
  const staged = fs.readdirSync(from, { withFileTypes: true });

  for (const entry of staged) {
    const there = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(there, { recursive: true });
      handOver(path.join(from, entry.name), there);
    } else {
      fs.renameSync(path.join(from, entry.name), there);
    }
  }

  const written = new Set(staged.map((e) => e.name));
  for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
    if (entry.isFile() && !written.has(entry.name)) fs.rmSync(path.join(to, entry.name), { force: true });
  }
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

  /*
   * A response is somebody coming back to you. `closed` is not counted: it
   * covers a rejection, which is a reply, and being ghosted, which is the
   * absence of one, and the tracker cannot tell them apart — counting it
   * either way would state something the data does not know.
   */
  const responded = apps.filter((a) => ['interview', 'offer'].includes(a.status)).length;
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
