import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { withoutBom } from './bom.js';
import { gitDirOf, holdSaveSync } from './save-lock.js';
import { andList, newlyRepeated, type Option } from './duplicates.js';
import { flattenResumes, needsFlattening } from './flatten.js';
import { entryLosesIds, findMovedWordings, forgetMissing, indexStore, skillsLoseIds } from './forget.js';
import { legacyTailoredResumeId, tailoredResumeId } from './applications.js';
import { liftLayout } from './lift-layout.js';
import { asLoaded, keptOnDisk, needsTiering, newlySent, sentResumes, tierResumes } from './tiers.js';
import { adoptBulletOrder, adoptDateOrder, PLACEHOLDER_NAME } from './resolve.js';
import {
  DEFAULT_CONFIG,
  type AnswerBankItem,
  type Application,
  type CoverLetter,
  type Draft,
  isVariantField,
  type Entry,
  type Profile,
  type ResumeSpec,
  type SkillGroup,
  type StandingDocument,
  type WritingSample,
  type StoreConfig,
  type StoreData,
} from './types.js';

// It lives with the presets, which are what it repairs a config back towards,
// and is re-exported here because this is where config is read.
import { AI_TASKS, aiIsOn, applyModelAndEffort, applyResearch, configForTask, repairAiArgs, type AiTask } from '../ai/presets.js';
import { extractJob } from '../jobs/extract.js';
import {
  normalizeAnswers,
  normalizeApplications,
  normalizeEntry,
  normalizeProfile,
  normalizeSections,
  normalizeSkillGroups,
} from './normalize.js';
export { aiIsOn, repairAiArgs };

/** What a value turned out to be, in words, for a message about a file. */
function describeValue(v: unknown): string {
  if (Array.isArray(v)) return 'a list';
  if (v === null) return 'empty';
  switch (typeof v) {
    case 'string':
      return 'a single piece of text';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'true or false';
    default:
      return 'a set of keys and values';
  }
}

/**
 * Take a file out of the save, and say something useful when it will not go.
 *
 * `fs.unlinkSync` throws `EACCES: permission denied, unlink '/home/…/resumes/
 * summer-intern.yaml'`, which reaches the user through the API's error
 * handler exactly as written. It names a path they did not ask about and a
 * code they have no reason to know, and it does not say which of their
 * documents it was talking about — on a delete, that is the only question.
 *
 * The common causes get a sentence. Anything else keeps the system's own
 * words, because a rare errno said plainly is more use than a guess.
 */
export function removeFile(full: string, what: string): void {
  if (!fs.existsSync(full)) return;
  try {
    fs.unlinkSync(full);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const said = err instanceof Error ? err.message : String(err);
    const because =
      code === 'EACCES' || code === 'EPERM'
        ? 'the save folder is not writable'
        : code === 'EBUSY'
          ? 'something else on this machine has the file open'
          : code === 'EROFS'
            ? 'the save is on a read-only disk'
            : code === 'EISDIR'
              ? 'there is a folder where that file should be'
              /*
               * Anything else keeps the system's own words, which are more
               * use than a guess — but not the path it puts after them. It
               * names the store's full location, which the person already
               * knows and did not ask about, and it is the half of the
               * message that made the raw version unreadable.
               */
              : said.replace(/,\s*unlink\s+'[^']*'\s*$/, '');
    throw new Error(`${what} could not be removed from the save — ${because}. Nothing else was changed.`);
  }
}

/**
 * Read one file of the store, and say which file it was when it will not read.
 *
 * Two failures, both of which happen on the day somebody first imports files
 * they wrote or generated elsewhere, and both of which used to end somewhere
 * unhelpful.
 *
 * The first is YAML that does not parse. `YAML.parse` throws "Flow sequence in
 * block collection must be sufficiently indented and end with a ] at line 2,
 * column 1" — accurate, and useless, because a store is ten YAML files at its
 * root plus a folder of resumes, a folder of drafts, a folder of letters and a
 * corpus, and that message names none of them. The parser's own complaint is
 * kept, because the line and column are the useful half; the file's name is put
 * in front of it, because "which file?" is the only question anybody has here.
 *
 * The second is a file that parses into the wrong shape, and it was the worse
 * of the two because it was silent. `applications.yaml` written as a mapping of
 * id to application — an entirely reasonable thing for a person or a script to
 * produce — parsed fine, failed `Array.isArray` inside `normalizeApplications`,
 * and came back as `[]`. The tracker was empty, nothing was raised, and the
 * next save wrote that empty list over the file: a year of applications gone,
 * silently, in two steps. `profile.yaml` holding a bare line of text failed the
 * other way — `{...'A Name'}` spreads a string into `{0:'A', 1:' ', 2:'N'…}`,
 * so the profile became a numbered map of single characters.
 *
 * So a file that is there, has content, and is not the shape this store keeps
 * in it is refused by name. Refusing costs a minute of somebody's afternoon;
 * the alternative cost them the afternoon's data and did not say so.
 *
 * Which shape is allowed comes from the empty value the caller would accept
 * instead: every file here is either a list of things (`experience.yaml`,
 * `applications.yaml`) or one object (`profile.yaml`, `config.yaml`), and the
 * fallback already says which — so there is no second argument to keep in step
 * with the first.
 *
 * An empty file, and a file holding only `---`, are not malformed. They are a
 * file somebody made and has not filled in yet, and they stay the empty thing
 * they are.
 */
export { withoutBom } from './bom.js';

/** `profile.autofill`'s scalars as their source text. See `Store.readProfile`. */
function autofillAsWritten(profile: Profile, raw: string): Profile {
  const block = profile?.autofill as Record<string, unknown> | undefined;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return profile;
  let node: unknown;
  try {
    node = YAML.parseDocument(withoutBom(raw)).get('autofill', true);
  } catch {
    return profile;
  }
  if (!YAML.isMap(node)) return profile;
  const autofill: Record<string, unknown> = { ...block };
  for (const pair of node.items) {
    const key = YAML.isScalar(pair.key) ? String(pair.key.value) : undefined;
    const value = pair.value;
    if (key === undefined || !(key in autofill) || !YAML.isScalar(value)) continue;
    if (typeof value.value === 'string' || value.value === null) continue;
    // A plain scalar's own characters; a quoted one was a string already.
    if (typeof value.source === 'string') autofill[key] = value.source;
  }
  return { ...profile, autofill: autofill as Record<string, string> };
}

/**
 * `data` as parsing its YAML back would give it — a fresh copy — or
 * `undefined` where that is not certain.
 *
 * For `Store.rememberWritten`, which keeps this in place of parsing a file it
 * has just written. Certain for plain data: strings, finite numbers, true and
 * false, null, arrays and plain objects, where YAML's round trip is JSON's —
 * a key set to `undefined` is left out and an `undefined` in a list comes
 * back as null. Not attempted for anything else: a Date, a class, a -0, a
 * NaN, a key named `__proto__`, or an object reached twice, which YAML writes
 * as an anchor and reads back as one shared object. Those are left for the
 * read to parse, which is always right and only slower.
 *
 * The top level is a list or a mapping, as every file this is used for is;
 * anything else is left alone, since a read turns an empty one into the
 * reader's own fallback.
 */
export function asReadBack(data: unknown): unknown {
  const unsure = Symbol('unsure');
  const seen = new Set<object>();
  const copy = (value: unknown, inList: boolean): unknown => {
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return value;
      case 'number':
        if (!Number.isFinite(value) || Object.is(value, -0)) throw unsure;
        return value;
      case 'undefined':
        if (inList) return null;
        throw unsure; // Only reached at the top level; a key is dropped below.
      case 'object': {
        if (value === null) return null;
        if (seen.has(value)) throw unsure;
        seen.add(value);
        if (Array.isArray(value)) {
          if (Object.getPrototypeOf(value) !== Array.prototype) throw unsure;
          const out: unknown[] = [];
          for (let i = 0; i < value.length; i++) {
            if (!(i in value)) throw unsure;
            out.push(copy(value[i], true));
          }
          return out;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) throw unsure;
        if (Object.getOwnPropertySymbols(value).length > 0) throw unsure;
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          if (key === '__proto__') throw unsure;
          if (item === undefined) continue;
          out[key] = copy(item, false);
        }
        return out;
      }
      default:
        throw unsure;
    }
  };
  if (data === null || typeof data !== 'object') return undefined;
  /*
   * Nor a mapping whose first key begins with a byte-order mark. YAML writes
   * that key unquoted as the file's first characters, and the read takes
   * them for the file's own mark and strips it (`withoutBom`), so the key
   * comes back without it — and the cache would have held the one the file
   * does not.
   */
  if (!Array.isArray(data) && Object.keys(data)[0]?.startsWith('\uFEFF')) return undefined;
  try {
    return copy(data, false);
  } catch (err) {
    if (err === unsure) return undefined;
    throw err;
  }
}

export function parseStoreYaml<T>(label: string, raw: string, fallback: T): T {
  /*
   * A byte-order mark is how Notepad and a good many Windows tools start a
   * UTF-8 file, and it made a hand-edited `skills.yaml` "not valid YAML" —
   * one edit on Windows and the save would not open. It says nothing about
   * the content, so it goes.
   */
  raw = withoutBom(raw);
  if (!raw.trim()) return fallback;

  /*
   * A `git pull` that ended in a conflict leaves both sides in the file
   * between `<<<<<<<` and `>>>>>>>` lines, and the save then would not open:
   * "applications.yaml is not valid YAML — Implicit keys need to be on a
   * single line at line 1, column 1", which is true and says nothing about a
   * pull. The app has no Pull of its own, so whoever ran it is in a terminal
   * and needs to hear that it is not finished. Checked before parsing,
   * because a conflict can also happen to parse — into a value holding both
   * sides and the markers as text, which is worse than not opening.
   */
  if (/^<{7} /m.test(raw) && /^>{7} /m.test(raw)) {
    throw new Error(
      `Unresolved git merge conflict in ${label}: it still has the <<<<<<< and >>>>>>> lines a git pull ` +
        'leaves between the two sides. Edit the file to keep what you want and remove those lines, then ' +
        'git add it and git commit (or run git merge --abort to undo the pull), and reload.',
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    // The first line only: the rest is a code frame repeating the file back at
    // you, which is noise in a dialog box. The colon it ends with introduced
    // that frame and now introduces nothing.
    const said = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.trim().replace(/:$/, '');
    throw new Error(`${label} is not valid YAML — ${said}`);
  }

  if (parsed === null || parsed === undefined) return fallback;

  const wantList = Array.isArray(fallback);
  if (typeof parsed !== 'object' || Array.isArray(parsed) !== wantList) {
    throw new Error(
      `${label} should be ${wantList ? 'a list' : 'a set of keys and values'}, and it is ${describeValue(parsed)}. ` +
        'Nothing has been changed — fix the file, or move it aside, and try again.',
    );
  }
  return parsed as T;
}

/**
 * The files of a save that are read as a list, by their path in the save. Every
 * other YAML file the save reads is a set of keys and values. See
 * `storeFileProblem`.
 */
const LIST_FILES = new Set([
  'skills.yaml',
  'applications.yaml',
  'answers.yaml',
  'education.yaml',
  'experience.yaml',
  'projects.yaml',
  'custom.yaml',
]);

/**
 * Why this file, as it would be in the save, would stop the save opening —
 * or undefined when it would read, or is not a file the save parses.
 *
 * For a pull to ask before it changes anything (see `Repo.pull`). A merge
 * git calls clean is a merge of lines, not of YAML: two machines that each
 * added `phone:` to the profile, one near the top and one near the bottom,
 * merge without a conflict into a profile.yaml with the key twice, which
 * does not parse — and the pull said "Pulled 1 commit", after which every
 * page of the app answered "profile.yaml is not valid YAML". So the files a
 * pull would bring in are read here first, by the same parser and with the
 * same expectations (`parseStoreYaml`) the save is opened with, and a pull
 * that would leave one unreadable is refused instead, the way a conflict is.
 *
 * `rel` is the path in the save, with forward slashes, as git names it.
 */
export function storeFileProblem(rel: string, raw: string): string | undefined {
  const parts = rel.split('/');
  const name = parts[parts.length - 1] ?? '';
  const folder = parts.length === 2 ? parts[0] : parts.length === 1 ? '' : undefined;
  try {
    if (folder === '' && (LIST_FILES.has(name) || name === 'profile.yaml' || name === 'config.yaml')) {
      parseStoreYaml(rel, raw, LIST_FILES.has(name) ? [] : {});
    } else if ((folder === 'resumes' && /\.ya?ml$/.test(name)) || (folder === 'drafts' && name.endsWith('.yaml'))) {
      parseStoreYaml(rel, raw, {});
    } else if ((folder === 'letters' || folder === 'corpus') && name.endsWith('.md')) {
      // The header only, as the loaders read it; the body is prose.
      const split = splitFrontMatter(withoutBom(raw));
      if (split) parseStoreYaml(rel, split.header, {});
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The file in this machine's `.git` folder that says the AI has been
 * switched off here, and why. See `aiCommandChange`.
 *
 * In `.git` because it is about this machine: it says why, it holds the AI
 * off here whatever config.yaml comes to say, and only turning the AI on
 * here clears it. The switch-off itself is also written into config.yaml
 * and committed, for the versions that do not read this file (see
 * `writeAiOff`); nothing else that merely saves settings while switched off
 * writes `false` there (see `saveConfig`). Undefined when the save is not a
 * repository of its own, which nothing can pull into.
 */
export function aiSwitchOffFile(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return path.join(dotGit, 'rmm-ai-switched-off');
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    return pointer ? path.join(path.resolve(root, pointer), 'rmm-ai-switched-off') : undefined;
  } catch {
    return undefined;
  }
}

/** Why the AI was switched off on this machine by a pull or a clone, if it was. */
export function aiSwitchedOff(root: string): string | undefined {
  const file = aiSwitchOffFile(root);
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, 'utf8').trim() || 'The AI command came from another machine.';
  } catch {
    return undefined;
  }
}

/** Switch the AI off on this machine (see `aiSwitchOffFile`). False when there is nowhere to say so. */
export function switchAiOff(root: string, why: string): boolean {
  const file = aiSwitchOffFile(root);
  if (!file) return false;
  fs.writeFileSync(file, `${why}\n`, 'utf8');
  return true;
}

/**
 * Write `ai.enabled: false` into config.yaml itself, for a pull or a clone
 * that switches the AI off. True when the file changed.
 *
 * The marker in `.git` is this version's, and a version that predates it
 * does not read it: the previous build opened on the same clone after a pull
 * had switched the AI off found `enabled: true` in config.yaml, and ran the
 * command that had just arrived. So the switch-off is also written where
 * every version reads it, and committed on its own (see `Repo.commitAiOff`).
 * That commit travels with the next push, and switches the AI off on the
 * other machine too — deliberately: "off" is the answer that cannot run a
 * command nobody has looked at, and turning it on again there is one click
 * in Settings, which writes `true` as it always has.
 *
 * Edited in place rather than through `writeYaml`, so the comments and the
 * order of the file survive and the commit is the one line. Nothing is
 * written to a file that already says off, or that will not parse — the
 * marker still holds the AI off on this machine either way.
 */
export function writeAiOff(root: string): boolean {
  // Read, changed and written back under the save's lock, as the store's own writes are. See `SaveLock`.
  return holdSaveSync(root, () => writeAiOffHeld(root));
}

function writeAiOffHeld(root: string): boolean {
  const file = path.join(root, 'config.yaml');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const text = withoutBom(raw);
    const doc = YAML.parseDocument(text);
    if (doc.errors.length > 0) return false;
    if (saysAiOff(text)) return false;
    /*
     * The value's own characters replaced where there is one, so nothing
     * else in the file is so much as re-spaced. Set through the document
     * only where there is no such line to change.
     */
    const ai = doc.get('ai', true);
    const node = doc.getIn(['ai', 'enabled'], true);
    let next: string;
    if (plainAiMap(ai) && YAML.isScalar(node) && !node.anchor && node.range) {
      next = `${text.slice(0, node.range[0])}false${text.slice(node.range[1])}`;
    } else if (plainAiMap(ai) && node === undefined) {
      doc.setIn(['ai', 'enabled'], false);
      next = doc.toString({ lineWidth: 0 });
    } else {
      /*
       * Anything else — `ai: *shared`, `ai: &shared` that something else
       * names, `enabled: *on`, `enabled: &on true`, a `<<` merge key, `ai:`
       * with nothing under it — is the `ai` block written out again, from
       * what it reads as, with `enabled: false`.
       *
       * Edited where it was, an alias is a node somewhere else: `setIn`
       * through `ai: *a` refused, the switch-off wrote nothing, and a version
       * that does not read the marker found the AI on and ran the command
       * that had just arrived. And writing through an anchor switches off
       * whatever else shares it, or changes nothing (a merge key's value is
       * overridden by the map it is merged into). So the block is replaced
       * outright, and every alias elsewhere to an anchor inside it is first
       * written out as the value it stood for, so that nothing else in the
       * file reads any differently.
       */
      const resolved = (doc.toJS() as Record<string, unknown> | null)?.ai;
      const was = resolved && typeof resolved === 'object' && !Array.isArray(resolved) ? resolved : {};
      const anchored = new Map<string, YAML.Node>();
      if (YAML.isNode(ai)) {
        YAML.visit(ai, (_key, n) => {
          if (YAML.isNode(n) && n.anchor) anchored.set(n.anchor, n);
        });
      }
      if (anchored.size > 0) {
        YAML.visit(doc, (_key, n) => {
          if (n === ai) return YAML.visit.SKIP;
          if (YAML.isAlias(n) && anchored.has(n.source)) {
            const copy = anchored.get(n.source)!.clone() as YAML.Node;
            copy.anchor = undefined;
            return copy;
          }
          return undefined;
        });
      }
      doc.set('ai', doc.createNode({ ...was, enabled: false }, { aliasDuplicateObjects: false }));
      next = doc.toString({ lineWidth: 0 });
    }
    // Only a file that reads as off, and reads the rest as it did, is written.
    if (!saysAiOff(next) || !sameApartFromAi(text, next)) return false;
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, next, 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * An `ai:` that is a map of its own, written out in the file: not an alias,
 * not anchored for something else to name, and with no merge key in it. The
 * one shape a single value can be changed in place in.
 */
function plainAiMap(ai: unknown): boolean {
  if (!YAML.isMap(ai) || ai.anchor) return false;
  return !ai.items.some((pair) => (YAML.isScalar(pair.key) ? pair.key.value : pair.key) === '<<' || YAML.isAlias(pair.value));
}

/**
 * Whether config.yaml's text says `ai.enabled: false` in so many words. Not
 * "is not on as this version reads it": `enabled: "true"` is off here and on
 * to a version that read it by truthiness, and that version is who the line
 * in the file is for.
 */
function saysAiOff(text: string): boolean {
  try {
    const parsed = parseStoreYaml<Partial<StoreConfig>>('config.yaml', text, {});
    return Boolean(parsed.ai && typeof parsed.ai === 'object' && parsed.ai.enabled === false);
  } catch {
    return false;
  }
}

/** Whether two config.yaml texts read the same everywhere but under `ai`. */
function sameApartFromAi(a: string, b: string): boolean {
  const rest = (text: string) => {
    const { ai: _ai, ...others } = (YAML.parse(text) ?? {}) as Record<string, unknown>;
    return JSON.stringify(others);
  };
  return rest(a) === rest(b);
}

/**
 * Whether config.yaml at `root` says `ai.enabled: false`, for a pull or a
 * clone to check that `writeAiOff` left it saying so.
 */
export function aiOffInFile(root: string): boolean {
  try {
    return saysAiOff(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * What a pull or a clone that switched the AI off says when `writeAiOff`
 * could not make config.yaml say so too. The marker still holds the AI off
 * here; this is for the version that does not read it.
 */
export const AI_OFF_NOT_WRITTEN =
  'config.yaml could not be changed to say `enabled: false`, so the AI is off on this machine only: a version of the app ' +
  'from before this switch-off, opened on this save, would still find it on. Set `enabled: false` under `ai:` in config.yaml by hand.';

/**
 * After a switch-off has tried to write config.yaml: when the file still does
 * not say off, the marker says so as well, and the sentence comes back for
 * the caller's message. Undefined when the file says off.
 */
export function reportAiOffNotWritten(root: string): string | undefined {
  if (aiOffInFile(root)) return undefined;
  const why = aiSwitchedOff(root);
  if (why && !why.includes(AI_OFF_NOT_WRITTEN)) switchAiOff(root, `${why} ${AI_OFF_NOT_WRITTEN}`);
  return AI_OFF_NOT_WRITTEN;
}

/** What turning the AI on in Settings does to a switch-off. */
export function clearAiSwitchOff(root: string): void {
  const file = aiSwitchOffFile(root);
  if (file) fs.rmSync(file, { force: true });
}

/**
 * The command and arguments an `ai` block from config.yaml would actually
 * run, after the same repairs and settings `loadConfig` applies: the known
 * argument fixes, the research setting's deny list, and the model and effort
 * flags. A value of the wrong type falls back to the default rather than
 * throwing, because this also reads config.yaml files that arrived in a pull.
 */
export function effectiveAiCommand(ai: Partial<StoreConfig['ai']>): { command: string; args: string[] } {
  const command = typeof ai.command === 'string' ? ai.command : DEFAULT_CONFIG.ai.command;
  const given = Array.isArray(ai.args) ? ai.args.map(String) : DEFAULT_CONFIG.ai.args;
  let args = repairAiArgs(command, given);
  args = applyResearch(command, args, Boolean(ai.research));
  args = applyModelAndEffort(command, args, {
    model: typeof ai.model === 'string' ? ai.model : undefined,
    effort: ai.effort,
  });
  return { command, args };
}

/**
 * The arguments each kind of AI work actually runs with, from the same `ai`
 * block: `effectiveAiCommand`'s, with `ai.models` putting its own model in
 * for the work it names (see `configForTask`). A model that is not a string
 * is left out, as `effectiveAiCommand` leaves out `ai.model`.
 */
function effectiveAiArgsByTask(ai: Partial<StoreConfig['ai']>): Record<AiTask, string[]> {
  const { command, args } = effectiveAiCommand(ai);
  const given = ai.models && typeof ai.models === 'object' ? (ai.models as Record<string, unknown>) : {};
  const models = Object.fromEntries(
    AI_TASKS.flatMap(({ key }) => (typeof given[key] === 'string' ? [[key, given[key]]] : [])),
  ) as Partial<Record<AiTask, string>>;
  const model = typeof ai.model === 'string' ? ai.model : undefined;
  const effort = ai.effort;
  return Object.fromEntries(
    AI_TASKS.map(({ key }) => [key, configForTask({ ai: { command, args, model, models, effort } }, key).ai.args]),
  ) as Record<AiTask, string[]>;
}

/**
 * What a change to config.yaml would do to the command this machine runs
 * for AI actions, in words; undefined when it does not change it.
 *
 * config.yaml is tracked, so it travels with a pull, and `ai.command` and
 * `ai.args` are a program and its arguments that this app starts. Whoever
 * can push to the remote — or a remote that is not who it was — could
 * change them, and the next AI action on this machine ran whatever they
 * said, with nothing on screen about it. So a pull that changes them, or
 * that switches the AI on, switches it off here instead, until the person
 * has looked at the command in Settings and turned it on themselves (see
 * `aiSwitchOffFile`). A change that leaves the AI off needs nothing: the
 * person sees the command when they turn it on.
 *
 * `before` undefined is a save that had no config.yaml here — a clone — so
 * any AI that arrives switched on is new to this machine.
 */
export function aiCommandChange(
  before: string | undefined,
  after: string | undefined,
  { offBySwitchOff = false }: { offBySwitchOff?: boolean } = {},
): string | undefined {
  const ai = (raw: string | undefined): Partial<StoreConfig['ai']> => {
    if (raw === undefined) return {};
    try {
      const parsed = parseStoreYaml<Partial<StoreConfig>>('config.yaml', raw, {});
      return parsed.ai && typeof parsed.ai === 'object' ? parsed.ai : {};
    } catch {
      return {};
    }
  };
  const was = ai(before);
  const now = ai(after);
  const on = (c: Partial<StoreConfig['ai']>) => aiIsOn(c.enabled ?? DEFAULT_CONFIG.ai.enabled);
  if (!on(now)) return undefined;
  /*
   * The command line as it would actually run, not as config.yaml spells it:
   * `research`, `model` and `effort` rewrite the arguments on the way (see
   * `effectiveAiCommand`), so `research: true` alone takes WebFetch and
   * WebSearch off the deny list without `args` changing by a character.
   */
  const command = (c: Partial<StoreConfig['ai']>) => effectiveAiCommand(c).command;
  const args = (c: Partial<StoreConfig['ai']>) => JSON.stringify(effectiveAiCommand(c).args);
  /*
   * And per kind of work. `ai.models` gives tailoring, writing, reviewing
   * and drafting each a model of its own, and `configForTask` puts it into
   * the arguments those actions run with. Compared only as the one command
   * line, a pull that set `models.tailor` changed what every tailoring ran
   * and switched nothing off. A kind of work is named only where it runs
   * with arguments of its own, before or after: one that follows the shared
   * arguments has already been said with them.
   */
  const ownArgs = (c: Partial<StoreConfig['ai']>) =>
    Object.entries(effectiveAiArgsByTask(c))
      .filter(([, taskArgs]) => JSON.stringify(taskArgs) !== args(c))
      .map(([task, taskArgs]) => `${task} runs ${JSON.stringify(taskArgs)}`)
      .join(', ');
  const running = (c: Partial<StoreConfig['ai']>) =>
    `${JSON.stringify(command(c))} ${args(c)}${ownArgs(c) ? ` (${ownArgs(c)})` : ''}`;
  const said: string[] = [];
  if (before === undefined) {
    said.push(`the AI is switched on, running ${running(now)}`);
  } else {
    if (command(was) !== command(now)) said.push(`the command went from ${JSON.stringify(command(was))} to ${JSON.stringify(command(now))}`);
    if (args(was) !== args(now)) said.push(`its arguments went from ${args(was)} to ${args(now)}`);
    const [wasByTask, nowByTask] = [effectiveAiArgsByTask(was), effectiveAiArgsByTask(now)];
    for (const { key } of AI_TASKS) {
      const [from, to] = [JSON.stringify(wasByTask[key]), JSON.stringify(nowByTask[key])];
      if (from === to || (from === args(was) && to === args(now))) continue;
      said.push(`its arguments for ${key} went from ${from} to ${to}`);
    }
    /*
     * Switched on with nothing else different is not a new program arriving
     * — when the `false` it replaces is a switch-off's. Since a switch-off
     * also writes `false` into config.yaml (see `writeAiOff`), counting that
     * as a change made the two machines take turns: the other one turned it
     * on again, this one pulled that, switched off and committed `false`, and
     * so on for as long as both kept answering. Alongside a change to what
     * runs, it is said with it.
     *
     * Only then (`offBySwitchOff`: the last commit to config.yaml before the
     * merge is a switch-off's, made here or on the other machine). Exempted
     * whatever the `false` was, a pull that changed nothing but `enabled`
     * switched the AI on here — from the shipped `enabled: false` that
     * nobody on this machine had ever turned on, running a command nobody
     * here had looked at. That is the one thing the switch-off is for.
     */
    if (!on(was) && (said.length > 0 || !offBySwitchOff)) said.push(`it was switched on, running ${running(now)}`);
  }
  return said.length ? said.join('; ') : undefined;
}

/**
 * A file already in this folder whose name differs from `full` only in case.
 *
 * Deliberately only the same folder, and only on an exact case-insensitive
 * match: this is asking the narrow question "would these two be one file on a
 * Mac", not the broad one "are these names similar".
 */
function siblingDifferingOnlyInCase(full: string): string | undefined {
  const name = path.basename(full);
  let siblings: string[];
  try {
    siblings = fs.readdirSync(path.dirname(full));
  } catch {
    // No folder yet, so nothing to clash with. Anything else that stops the
    // listing will stop the write a line later, where it is reported properly.
    return undefined;
  }
  return siblings.find((other) => other !== name && other.toLowerCase() === name.toLowerCase());
}

/**
 * Make the rename itself durable, not only the bytes it points at.
 *
 * The write above fsyncs the temp file, so a power cut can never leave the
 * name pointing at half a resume. But the rename is a change to the
 * *directory*, and that is a separate thing to get onto the disk: on ext4 with
 * the usual mount options the entry can still be in flight for a few seconds
 * after `renameSync` returns. Lose power in that window and the save comes
 * back as it was before the edit — the data perfectly intact somewhere the
 * directory no longer mentions.
 *
 * The narrow catch is the point, and it is worth being explicit about why it
 * is not the usual silent one. Opening a directory for reading is a POSIX
 * thing; Windows refuses it outright, and some filesystems refuse to fsync one
 * even where it opens. Those are answers about the platform, not about this
 * save, and there is nothing a person could do about them — whereas anything
 * else here is a real failure and is left to the caller, who reports it
 * against the file being written.
 *
 * It costs one fsync per save. Everything this writes is a document somebody
 * has just typed, so the trade — a few milliseconds against losing the edit —
 * only goes one way.
 */
function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // The platform does not do this. Every other errno is the caller's news.
    if (!['EPERM', 'EINVAL', 'EISDIR', 'EACCES', 'ENOTSUP', 'EBADF'].includes(code ?? '')) throw err;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Closing a descriptor that fsync already rejected; nothing is owed.
      }
    }
  }
}

/**
 * Split a markdown file into its YAML header and the prose under it.
 *
 * The line endings are the whole reason this is a named function rather than a
 * regex sitting in two places. It required `---\n` exactly, so a letter with
 * CRLF endings — which is what anything saved out of Word, out of a Windows
 * editor, or downloaded through a browser gives you — matched nothing at all.
 * The entire file including both `---` fences became the body, the title fell
 * back to the filename, and the date and the company were simply gone. Saving
 * that letter then wrote a *second* header above the first, so the body opened
 * with a horizontal rule and a stanza of stale metadata, and every later read
 * saw the new header and the old one as prose.
 *
 * Trailing spaces after a fence are allowed for the same reason: they are
 * invisible, and a file that has one is not a file without a header.
 */
/*
 * And a byte-order mark in front of the first fence, which Notepad and Word
 * write at the start of a UTF-8 file. With one there the file did not start
 * with "---", so the header was read as prose: the letter lost its title, its
 * company and its `applicationId`, and the first save wrote a second header
 * above the first. A header with nothing in it ("---" straight after "---")
 * is a header too, and was the same prose.
 */
export function splitFrontMatter(raw: string): { header: string; body: string } | undefined {
  const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(withoutBom(raw));
  return m ? { header: m[1] ?? '', body: m[2] ?? '' } : undefined;
}

/**
 * One segment of a path, checked as the filename it is about to become.
 *
 * Every id in this app is also a filename, and ids arrive from a URL, from a
 * request body the browser extension supplies, and from YAML somebody edited
 * by hand. All three checks live here rather than at the callers, because
 * there are a dozen callers and one of them is always the one that was
 * forgotten.
 *
 * A name that contains a path is not a name. `../config` from the resumes
 * folder overwrites the store's own configuration, whose `ai.command` this
 * application executes — see `Store.file` below, which is where that one was
 * first caught, and `Store.outFile`, which is where it was still open.
 *
 * A name with a null byte in it is refused here so the message is about the
 * name. Node throws on its own further down — "The argument 'path' must be a
 * string, Uint8Array, or URL without null bytes. Received '/…/resumes/a\x00b
 * .yaml.19280d27-….tmp'" — which is accurate, names a temp file the person
 * never typed, and leaves them to work out that their id was the problem.
 *
 * And 255 bytes is the filename limit on ext4, APFS, NTFS and every other
 * filesystem this is likely to meet, so a longer one cannot be written
 * anywhere and should say so in those words rather than as ENAMETOOLONG
 * pointing at a path with a UUID in it.
 */
function assertName(segment: string): void {
  /*
   * `segment === '..'`, and it used to be `segment.split('.').includes('..')`,
   * which can never be true: splitting on `.` cannot leave a `.` in any piece,
   * so the one name this clause was written to refuse was the one name it let
   * through. `outFile('applications', '..')` therefore resolved to the output
   * folder itself — which `outFile`'s own boundary check allows, since the
   * output folder is inside the output folder — and `buildBundle` deletes
   * every loose file in the folder it is about to write into. The id comes off
   * a tracker row, and applications.yaml is hand-editable by design.
   */
  if (segment.includes('/') || segment.includes('\\') || segment === '..') {
    throw new Error('That name is not allowed — a name cannot contain a path.');
  }
  if (segment.includes('\u0000')) {
    throw new Error('That name is not allowed — a name cannot contain a null character.');
  }
  if (Buffer.byteLength(segment, 'utf8') > 255) {
    throw new Error(
      `That name is too long — "${segment.slice(0, 40)}…" comes to ${Buffer.byteLength(segment, 'utf8')} bytes ` +
        'as a filename, and 255 is the most a filesystem will take. Shorten the id.',
    );
  }
}

/** `CON.yaml` and `com1.md` included: the extension does not save them. */
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Why a filename would survive here and nowhere else, or undefined when it
 * travels.
 *
 * The store is a git repository, and the reason it is one is that it gets
 * cloned: onto the laptop, which is a Mac, and onto the desktop, which is
 * Windows. Linux will hold a file called `Acme: Engineer.yaml`, `why?.yaml`,
 * `CON.yaml` or `ends with a dot..yaml` quite happily. Windows will not create
 * any of them, so `git clone` of that store fails partway through the
 * checkout, with an error naming git and a file, and leaves a save missing
 * exactly the resumes whose names were interesting.
 *
 * A leading dot is in here for a different reason: a store entry written as a
 * hidden file is invisible in Finder, in Explorer and in a plain `ls`, and
 * this folder's own bookkeeping — the temp files below, `.rmm-current.json` —
 * already lives behind that prefix. An empty name is the same failure at its
 * limit: an id of `''` wrote `resumes/.yaml`, which `loadResumes` read, took
 * an empty id from, and dropped — a file that could not be opened, edited or
 * deleted from the app and sat in every commit.
 */
function unportableReason(name: string): string | undefined {
  const stem = name.replace(/\.[^.]*$/, '');
  if (!stem) return 'it has no name in front of the file extension';
  if (stem === '.' || stem === '..') return 'a name of dots is not a name';
  if (name.startsWith('.')) return 'a name beginning with a dot is hidden in every file browser';
  // Control characters included: they are legal on ext4, unprintable in every
  // listing, and rejected outright by Windows.
  const bad = name.match(/[\u0000-\u001f<>:"|?*]/g);
  if (bad) return `Windows will not take ${[...new Set(bad)].map((c) => `"${c}"`).join(', ')} in a filename`;
  if (/[. ]$/.test(stem)) return 'Windows drops a dot or a space from the end of a name';
  if (WINDOWS_DEVICE_NAMES.test(name)) return `"${stem}" is a reserved device name on Windows`;
  return undefined;
}

/**
 * Read one file of a store folder, saying which one when it will not read.
 *
 * `parseStoreYaml` already names the file when the *content* is wrong, and the
 * step before it did not: `readFileSync` on `resumes/acme.yaml` that turns out
 * to be a directory, or that the process cannot open, throws "EISDIR: illegal
 * operation on a directory, read" — which names neither the file nor the
 * resume, arrives from inside `store.load()`, and so presents as the whole
 * application being broken rather than one file in it.
 */
function readStoreFile(full: string, label: string): string {
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} could not be read (${full}) — ${said}`);
  }
}

/**
 * The name this file has on disk, when that is not quite the name it was asked
 * for.
 *
 * macOS keeps filenames decomposed. A store written on Linux with `géraldine
 * .yaml` — one code point for the é — comes back from `readdir` on a Mac as
 * `e` followed by a combining acute, and no two of those strings compare
 * equal. `loadResumes` takes the id from the filename, so the store then held
 * a resume with an id nothing could look up: the editor answered "No resume",
 * every variation extending it lost its base, and saving from the editor wrote
 * a *second* file whose name lists identically beside the first. On the Mac,
 * where those two names are one file, that second write silently replaced a
 * resume the app had just said did not exist.
 *
 * So a name that is not there is looked for again under Unicode
 * normalisation, and the spelling that is actually on disk wins. Reads find
 * it, writes go back into it rather than beside it, and deletes remove the
 * file that exists rather than reporting success over one that does not.
 *
 * Deliberately not case-folding. `Acme` and `acme` are one file on macOS and
 * Windows and two on Linux, and folding them here would make a save under one
 * name overwrite the other resume on the filesystem where they are genuinely
 * separate — turning a portability problem into data loss on the platform that
 * does not have it.
 */
function onDiskSpelling(full: string): string {
  if (fs.existsSync(full)) return full;
  const dir = path.dirname(full);
  const wanted = path.basename(full).normalize('NFC');
  let siblings: string[];
  try {
    siblings = fs.readdirSync(dir);
  } catch {
    // No folder yet, or not a folder at all. Either way there is nothing on
    // disk to match, and the name asked for is the name to create; whatever is
    // wrong with the folder is reported by the read or write that follows,
    // which knows what it was trying to do.
    return full;
  }
  const found = siblings.find((name) => name.normalize('NFC') === wanted);
  return found === undefined ? full : path.join(dir, found);
}

/** The refusal for a symbolic link inside the save. See `Store.assertNoLink`. */
function linkInSave(rel: string, full: string): Error {
  let to = '';
  try {
    to = ` (to ${fs.readlinkSync(full)})`;
  } catch {
    // Gone since, or unreadable: the name is what matters.
  }
  return new Error(
    `"${rel.split(path.sep).join('/')}" in the save is a symbolic link${to}, and the app does not follow links in a save: ` +
      'one can lead anywhere on this computer. Nothing was read or written through it. Replace the link with the ' +
      'file or folder itself (or remove it), and try again.',
  );
}

/**
 * Remove from `target` every key the patch set to `null`, following the patch
 * into nested objects. The merge has already copied those nulls across; this
 * turns each one into "no value", which is what a default is.
 */
function dropNulls(target: Record<string, unknown>, patch: unknown): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete target[key];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = target[key];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) dropNulls(inner as Record<string, unknown>, value);
    }
  }
}

/**
 * "Has this file moved since I last looked", as one string, from its stat.
 *
 * Size and modification time were the whole of it, and on a file system
 * whose clock ticks in whole seconds — HFS+, FAT and exFAT, many SMB shares,
 * two seconds on FAT — a second process writing the same number of bytes
 * within the same tick left both alone: the CLI changing "Acme1" to "Bcme1"
 * on a row, measured, and the server went on handing back, and then writing
 * back, the parse from before. The inode and the change time are added
 * because neither can stay put through the writes that matter: every write
 * this program makes renames a fresh file into place (`writeAtomic`), which
 * is a new inode whatever the clock says, and an in-place write moves the
 * change time on any file system that has one.
 */
export function statStamp(stat: fs.Stats): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ino}:${stat.ctimeMs}`;
}

/**
 * A whole-list write made onto a list that another process has changed since
 * the writer read it: `base` is what the writer read, `mine` what it is
 * writing, `theirs` what the file holds now. Undefined when the rows cannot
 * be told apart by id — a row without one, or two with the same — and the
 * caller writes `mine` as it always did.
 *
 * Row by row: a row `mine` changed, added or removed from `base` is taken
 * from `mine`; any other row is taken from `theirs`, which keeps the other
 * process's additions, edits and removals. The two touching the same row is
 * the one case a side has to win, and the write being made now wins it, as
 * it did before there was any merging. In `mine`'s order when the other
 * process left the order alone, so a reorder made here survives; otherwise
 * in `theirs`', with this write's new rows after.
 */
export function mergeById<T>(base: T[], mine: T[], theirs: T[], idOf: (row: T) => unknown): T[] | undefined {
  const index = (rows: T[]): Map<string, T> | undefined => {
    const byId = new Map<string, T>();
    for (const row of rows) {
      const id = row && typeof row === 'object' ? idOf(row) : undefined;
      if (typeof id !== 'string' || byId.has(id)) return undefined;
      byId.set(id, row);
    }
    return byId;
  };
  const b = index(base);
  const m = index(mine);
  const t = index(theirs);
  if (!b || !m || !t) return undefined;
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const theirOrderMoved = !same([...b.keys()], [...t.keys()]);
  const order = theirOrderMoved ? [...t.keys(), ...m.keys()] : [...m.keys(), ...t.keys()];
  const out: T[] = [];
  const done = new Set<string>();
  for (const id of order) {
    if (done.has(id)) continue;
    done.add(id);
    const ours = m.get(id);
    const row = same(ours, b.get(id)) ? t.get(id) : ours;
    if (row !== undefined) out.push(row);
  }
  return out;
}

/** `mergeById` for one object, key by key: the profile. */
export function mergeFields<T extends object>(base: T, mine: T, theirs: T): T {
  const b = base as Record<string, unknown>;
  const m = mine as Record<string, unknown>;
  const t = theirs as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(t), ...Object.keys(m)])) {
    const value = JSON.stringify(m[key]) === JSON.stringify(b[key]) ? t[key] : m[key];
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

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
    for (const segment of p) assertName(segment);
    const full = path.resolve(this.root, ...p);
    // And the belt to that pair of braces, in case a segment ever gets through.
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error('That name is not allowed — it points outside the save folder.');
    }
    const found = onDiskSpelling(full);
    this.assertNoLink(found);
    return found;
  }

  /**
   * And no link on the way there.
   *
   * The checks above are of the name, and a name can be perfectly good and
   * still lead out of the save: a save is a git repository, git carries
   * symbolic links, and a remote that put `voice.md -> ../../.ssh/id_ed25519`
   * or `letters -> /somewhere/else` into it had this app reading and writing
   * outside the save after a pull, every check here passed. A pull now
   * refuses a tree with a link in it (see `Repo.pull`); this is for a link
   * that got in some other way — an older version's pull, a hand-made one.
   *
   * Every part of the path below the save's own folder, with `lstat`, so the
   * link itself is what is looked at and not what it points to. The save's
   * folder may be reached through a link of its own (`/tmp` on a Mac is
   * one), which is the person's choice of where the save is and not a thing
   * inside it. A part that is not there yet ends the walk: nothing below a
   * missing folder can be a link.
   */
  private assertNoLink(full: string): void {
    const rel = path.relative(this.root, full);
    if (!rel) return;
    let at = this.root;
    for (const part of rel.split(path.sep)) {
      at = path.join(at, part);
      const stat = fs.lstatSync(at, { throwIfNoEntry: false });
      if (!stat) return;
      if (stat.isSymbolicLink()) throw linkInSave(path.relative(this.root, at), at);
    }
  }

  /**
   * Parsed files, keyed by what they were when they were parsed.
   *
   * `load()` re-reads and re-parses the whole save on every call, and every
   * API route calls it. Measured on a store the size a year of applying
   * produces: 52ms at ten applications, 102ms at a hundred, 186ms at three
   * hundred, growing about half a millisecond per application. Asking the
   * filesystem what has changed instead costs 2.2ms for nine hundred files —
   * eighty-five times less — so the parse is worth not repeating.
   *
   * Keyed on size and modification time together rather than either alone. A
   * hand edit, a git checkout, a second process writing: all of them move at
   * least one of the two, and `writeAtomic` renames a fresh file into place,
   * which moves both. Nothing here is keyed on this program having been the
   * one to write the file, because most of the interesting edits are not.
   */
  private parsed = new Map<string, { key: string; value: unknown }>();

  /**
   * Read and parse one file, or hand back what it parsed to last time.
   *
   * Everything that reads a file in this class goes through here, which is the
   * only way the saving is worth having: the four whole-file reads are a small
   * part of a real store, and the per-file loaders — a resume, a letter, a
   * writing sample, a draft, each its own file — are most of it and all of the
   * growth.
   *
   * What is kept is the parsed value, not the text: parsing is the cost, and
   * caching the bytes would save the read and pay for the parse again.
   *
   * And a copy of it goes out, never the cached object. Callers treat what
   * they are given as theirs — the loaders spread it into a new shape, and
   * that is a shallow copy, so anything nested stays shared. One route sorting
   * a section in place would then rewrite what the next route reads, with
   * nothing about it looking wrong from either end. Cloning costs a fraction
   * of parsing and removes the question rather than arguing it per caller.
   */
  /**
   * Size, modification time, inode and change time together, as one string —
   * "has this file moved since I last looked", answered without reading it.
   * See `statStamp`.
   *
   * Together rather than any one alone, for the reason `cached` below has
   * always kept them together: a hand edit, a git checkout, a restored
   * snapshot, a second process writing all move at least one, and
   * `writeAtomic` renames a fresh file into place, which moves them all.
   * `'missing'` for a file that is not there is its own stable answer — it
   * only ever collides with another file that is also not there, which is
   * not a collision that could hide a change.
   */
  private statKey(full: string): string {
    try {
      return statStamp(fs.statSync(full));
    } catch {
      return 'missing';
    }
  }

  /**
   * Forget every parse this store is holding, so the next read of each file
   * reads it again.
   *
   * For a pull (`Repo.pull`), which rewrites files underneath this process.
   * The cache asks each file for its size and time on every read, and that
   * is right for an edit — but it is all it asks, and `rememberWritten` keeps
   * a parse keyed on the stat taken straight after this process wrote. A
   * pulled file the same size as the one written here, landing within the
   * same tick of the file system's clock — a second on some file systems, two
   * on FAT, and a pull is over in well under one — was handed back as the
   * parse of the old file: the row the other machine changed came back as
   * it had been here, and the next whole-file write put it back that way on
   * disk. A pull is rare and a re-parse is cheap; nothing is worth that.
   */
  forgetReads(): void {
    this.parsed.clear();
  }

  /** `.git/HEAD` and `.git/ORIG_HEAD` as `forgetReadsIfGitMoved` last saw them. */
  private gitMarks: string | undefined;

  /**
   * `forgetReads`, when a git outside this process has moved the save since
   * the last time this was asked. True when it did.
   *
   * A pull in a terminal — `rmm pull` beside a running server, or `git pull`
   * — rewrites files under this process the way the app's own pull does,
   * and the app's own pull is the only one that told the cache. Most such
   * rewrites move a file's inode and are caught by the stat key anyway
   * (`statStamp`); this is for the ones that might not, and costs two stats.
   * A pull, a merge and a reset write `ORIG_HEAD`; a checkout of another
   * branch writes `HEAD`. This process's own commits write neither, so the
   * cache survives them — forgetting on every commit would be forgetting on
   * every save.
   *
   * Asked once per request by the server (see `createApi`).
   */
  forgetReadsIfGitMoved(): boolean {
    const dir = gitDirOf(this.root);
    if (!dir) return false;
    const marks = ['HEAD', 'ORIG_HEAD'].map((name) => this.statKey(path.join(dir, name))).join('|');
    if (marks === this.gitMarks) return false;
    const first = this.gitMarks === undefined;
    this.gitMarks = marks;
    if (first) return false;
    this.forgetReads();
    return true;
  }

  /**
   * What this process last read of a file, when somebody else has written
   * the file since: the base a whole-file write is merged from. Undefined
   * when the file is as it was read, or when nothing of it is remembered.
   *
   * Asked before anything reads the file again, because a read replaces what
   * is remembered with what is there now.
   */
  private movedSinceRead(full: string): unknown {
    const hit = this.parsed.get(full);
    if (!hit || hit.key === this.statKey(full)) return undefined;
    return structuredClone(hit.value);
  }

  private cached<T>(full: string, parse: (raw: string) => T, missing: T): T {
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return missing; // Not there, which is a perfectly ordinary answer.
    }

    /*
     * Size, modification time, inode and change time together, rather than
     * any one alone (see `statStamp`). A hand edit, a git checkout, a
     * restored snapshot, a second process writing: all of them move at least
     * one, and `writeAtomic` renames a fresh file into place, which moves
     * them all. Nothing is keyed on this program having been the one to write
     * the file, because most of the interesting edits are not.
     */
    const key = statStamp(stat);
    const hit = this.parsed.get(full);
    if (hit?.key === key) return structuredClone(hit.value) as T;

    const value = parse(readStoreFile(full, path.relative(this.root, full)));
    this.parsed.set(full, { key, value });
    return structuredClone(value) as T;
  }

  /**
   * The part of `resumeTextStamp` that every resume shares: the four files
   * entries live in, and skills.yaml.
   *
   * Split out so a caller stamping many resumes in one pass — `fitResumes`
   * scoring a posting against the whole store — can compute this once and
   * hand it to `resumeTextStamp` for every resume, instead of asking the
   * same five files about themselves once per resume.
   */
  entriesAndSkillsStamp(): string {
    return [...Store.ENTRY_FILES, 'skills.yaml'].map((rel) => this.statKey(this.file(rel))).join('|');
  }

  /**
   * A cheap fingerprint for the handful of files that decide what one resume
   * would print as plain text: its own file, the four files entries live in,
   * and skills.yaml.
   *
   * For `fitResumes` (see `jobs/fit.ts`), which is the one caller: scoring a
   * posting against every resume in the store means building each resume's
   * printed text, and that build — joining every bullet and running a regex
   * over the result — is most of that function's cost. Between two calls
   * where nothing on disk has moved, no resume's printed text can have
   * changed, so rebuilding it is paying the same regex again for the same
   * answer. "Has anything moved" is exactly the question `statKey` above
   * already answers per file without reading it; this asks it of the files
   * one resume's text actually depends on, so a caller can tell whether its
   * own cache of that text is still good.
   *
   * `shared` defaults to computing `entriesAndSkillsStamp` itself, so a
   * caller asking about one resume needs nothing extra — but a caller asking
   * about many, in a row, should pass the one answer it already has rather
   * than pay for it again on every resume. See `entriesAndSkillsStamp`.
   *
   * The resume's own file is stat'd directly under its ordinary name first,
   * deliberately *not* through `file` — `file` resolves a name through
   * `onDiskSpelling`, and `onDiskSpelling` answers a name that is not there
   * under its exact spelling by listing the whole folder and normalising
   * every sibling's name to compare it, which is the ordinary answer for the
   * ".yml" spelling nothing writes any more. Asked once per resume, for every
   * resume, that is a listing of the *entire* resumes folder repeated once
   * per resume in it — three hundred resumes cost 67ms here alone on a store
   * that size, almost all of it that scan, and it would grow with the square
   * of the folder rather than with it. A resume `saveResume` wrote — which is
   * all of them, barring a hand-edit — stats directly under its exact name in
   * one syscall, no folder listing involved. Only where that plain stat finds
   * nothing does this fall back to `file`'s full resolution, which is what
   * makes the case worth paying for: a hand-written ".yml", or a filename
   * another OS has Unicode-decomposed — see `onDiskSpelling` — costs the scan
   * again, but only for the resumes that actually need it.
   */
  resumeTextStamp(id: string, shared: string = this.entriesAndSkillsStamp()): string {
    // Checked here rather than left to `path.join`, because the line below
    // does not go through `file` and so does not get its boundary check for
    // free. Every id in this app is also a filename — see `assertName`.
    assertName(`${id}.yaml`);
    const plain = path.join(this.root, 'resumes', `${id}.yaml`);
    let own: string;
    try {
      own = statStamp(fs.statSync(plain));
    } catch {
      own = Store.RESUME_SPELLINGS.map((ext) => this.statKey(this.file('resumes', `${id}.${ext}`))).join('|');
    }
    return [shared, own].join('|');
  }

  /** A markdown file with a YAML header, read once and kept apart. */
  private cachedFrontMatter(full: string, label: string): { raw: string; split: ReturnType<typeof splitFrontMatter> } {
    return this.cached(
      full,
      (raw) => ({ raw, split: splitFrontMatter(raw) }),
      { raw: '', split: undefined },
    );
  }

  /*
   * The profile, with its autofill values as they were typed.
   *
   * Every one of them goes into a text box on a form, and YAML reads a bare
   * `address_zip: 02115` as the number 2115, `phone_ext: 0042` as 42 and
   * `gpa_scale: 4.0` as 4 — a ZIP code a form rejects, or worse, accepts.
   * So the block's plain scalars are taken from the file's own text. Only the
   * autofill block: everywhere else in the profile the parsed value is the
   * one meant.
   */
  private readProfile(): Profile {
    const fallback: Profile = { name: PLACEHOLDER_NAME };
    return this.cached(
      this.file('profile.yaml'),
      (raw) => autofillAsWritten(parseStoreYaml('profile.yaml', raw, fallback), raw),
      fallback,
    );
  }

  private readYaml<T>(rel: string | string[], fallback: T): T {
    const parts = Array.isArray(rel) ? rel : [rel];
    const f = this.file(...parts);
    return this.cached(f, (raw) => parseStoreYaml(parts.join('/'), raw, fallback), fallback);
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
  /**
   * @param text The contents. Bytes as well as text: a standing document is a
   *   PDF from a registrar, and it wants every guarantee this gives a resume
   *   — a name the save can be cloned with, no second name differing only in
   *   case, and a rename into place rather than a truncating write in the one
   *   folder a portal's upload dialog is pointed at.
   */
  private writeAtomic(f: string, text: string | Buffer): void {
    /*
     * Under the save's lock, so no other process's write lands in the middle
     * of a read-modify-write this one is part of. Re-entrant: the methods
     * below that read, change and write hold it already. See `SaveLock`.
     */
    holdSaveSync(this.root, () => this.writeAtomicHeld(f, text));
  }

  private writeAtomicHeld(f: string, text: string | Buffer): void {
    /*
     * A name is judged when it is created, and never afterwards.
     *
     * `unportableReason` above says why a store must not *acquire* a file
     * called `CON.yaml` or `Acme: Engineer.yaml`. It says nothing about one
     * that is already there — from a store written before this check, from a
     * hand edit, from an import — and refusing to write those would mean the
     * app can see a file of the user's, list it, and then decline to save
     * their edit to it. That is the loss this whole layer is trying to avoid,
     * so an existing file is always writable and only a new one is refused.
     */
    if (!fs.existsSync(f)) {
      const reason = unportableReason(path.basename(f));
      if (reason) {
        throw new Error(
          `"${path.basename(f)}" is not a name this save can hold: ${reason}. ` +
            'The save is a git repository meant to be cloned onto other machines, and a name ' +
            'like that stops the clone partway. Choose another id.',
        );
      }
      /*
       * And not a second name that only differs from an existing one in case.
       *
       * Linux keeps `Acme.yaml` and `acme.yaml` apart; macOS and Windows do
       * not. So a store that holds both is a store that cannot be cloned
       * faithfully — on those machines the second checkout overwrites the
       * first, and the resume that loses is simply gone.
       *
       * Refused here, when the second name is created, rather than folded on
       * read. Folding would mean a save under one spelling silently
       * overwriting a genuinely different file on the platform that keeps them
       * apart — turning a portability problem into data loss on the machine
       * that does not have the problem. Refusing costs one rename by somebody
       * who has two ids a letter apart, which is a thing worth being told
       * about anyway.
       *
       * Existing pairs are left alone: both are writable, because this only
       * runs when a name is new.
       */
      const clash = siblingDifferingOnlyInCase(f);
      if (clash) {
        throw new Error(
          `This save already holds "${clash}", and "${path.basename(f)}" differs from it only in ` +
            'capitalisation. macOS and Windows treat those as one file, so a save holding both ' +
            'cannot be cloned onto them without losing one. Choose an id that differs by more than case.',
        );
      }
    }

    fs.mkdirSync(path.dirname(f), { recursive: true });
    /*
     * A fixed-length temp name, in the same directory so the rename is atomic.
     *
     * It used to be the target's own name with `.<uuid>.tmp` after it, which
     * spends 41 of the 255 bytes a filename gets — so a resume whose filename
     * was long and entirely legal, and which loaded and rendered perfectly,
     * could not be saved: ENAMETOOLONG, naming a temp path with a UUID in it,
     * and the edit lost. The temp file exists for the length of one write and
     * nothing reads it by name.
     */
    const temp = path.join(path.dirname(f), `.rmm-${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temp, 'w');
      try {
        // No encoding named: a string is utf8 by default and a Buffer is
        // written as it stands.
        fs.writeFileSync(fd, text);
        // So a power cut cannot leave the rename pointing at empty bytes.
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, f);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      /*
       * Named for the file that was being saved, not for the scratch file it
       * was being saved through.
       *
       * Everything that goes wrong here goes wrong on the temp file — a folder
       * that cannot be written to, a full disk, a read-only mount — so the
       * errno arrived as "EACCES: permission denied, open
       * '/…/resumes/.rmm-9f3c….tmp'", a path with a UUID in it that exists for
       * a millisecond and that nobody can act on. The person needs to know
       * which of their files did not save and where it lives; the original
       * complaint is kept after it, because the errno is the diagnosis.
       */
      const said = err instanceof Error ? err.message : String(err);
      throw new Error(`${path.basename(f)} could not be saved to ${path.dirname(f)} — ${said}`, { cause: err });
    }

    /*
     * After the rename, and outside everything above, because by here the
     * save has happened.
     *
     * This used to sit inside the try. `fsyncDirectory` re-throws any errno
     * outside its short allow-list — `EIO` among them — so a directory flush
     * failing on a file that was already on disk under its real name came
     * back as "resume.yaml could not be saved to /…/resumes — EIO". The
     * caller is `withCommit`, which has no catch, so the commit was skipped
     * too: the edit was on disk, absent from the history, and reported to the
     * person as not saved. They redo work that is already done.
     *
     * What the flush actually buys is the rename surviving a power cut, and
     * losing that quietly is the smaller harm by a long way — the alternative
     * is a false negative that costs somebody their afternoon and drops their
     * change out of the history.
     */
    try {
      fsyncDirectory(path.dirname(f));
    } catch {
      // A durability caveat on a write that has already landed.
    }
  }

  private writeYaml(rel: string | string[], data: unknown): void {
    const f = this.file(...(Array.isArray(rel) ? rel : [rel]));
    // lineWidth 0 keeps long bullet text on one line so diffs stay per-bullet
    // instead of reflowing a whole paragraph every time a word changes.
    const text = YAML.stringify(data, { lineWidth: 0 });
    this.writeAtomic(f, text);
    this.rememberWritten(f, text, rel === 'profile.yaml' ? undefined : data);
  }

  /*
   * And the parse of what was just written, kept as if it had been read.
   *
   * The write moves the file's size and time, so the cache above rightly
   * stops trusting what it held — and the next read, which is usually the
   * next line, parsed the file back from scratch to learn what this method
   * had in its hand a moment ago. On a tracker of a thousand applications
   * that is most of a second, on every write: `syncCurrent` after a status
   * change, the tracker list after a save.
   *
   * Only where what was written is exactly what a read would hand back:
   *
   * - Plain data, which YAML gives back as JSON would — see `asReadBack`.
   *   Anything else is left for the read to parse, as before.
   * - Not profile.yaml, whose reader takes the autofill block from the
   *   file's own text rather than from the parse; see `readProfile`.
   * - Keyed by the stat taken after the write, and only when that stat is
   *   the size of what was written, so a second process that wrote the file
   *   in between is read, not papered over.
   *
   * What is kept is a copy, like everything the cache hands out: the caller
   * still has `data`, and changing it afterwards must not change what the
   * next read finds.
   */
  private rememberWritten(full: string, text: string, data: unknown): void {
    this.parsed.delete(full);
    const value = asReadBack(data);
    if (value === undefined) return;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return;
    }
    if (stat.size !== Buffer.byteLength(text)) return;
    this.parsed.set(full, { key: statStamp(stat), value });
  }

  /*
   * The profile, the skill groups and the answer bank on their own, each
   * normalised exactly as `load` normalises it — `load` is built from these.
   *
   * For the writes that guard and version one of them (`PUT /profile`,
   * `/skills`, `/answers`): the version they compare and hand back has to be
   * the one `GET /store` reports, and getting it from `load` read every
   * resume, letter and draft in the store twice per keystroke-save to look at
   * one file.
   */
  loadProfile(): Profile {
    return normalizeProfile(this.readProfile());
  }

  loadSkillGroups(): SkillGroup[] {
    return normalizeSkillGroups(this.readYaml<SkillGroup[]>('skills.yaml', []));
  }

  loadAnswers(): AnswerBankItem[] {
    return normalizeAnswers(this.readYaml<AnswerBankItem[]>('answers.yaml', []));
  }

  /** Read every file in the store into one object. */
  load(): StoreData {
    const config = this.loadConfig();
    const entries = this.loadEntries();
    return {
      profile: this.loadProfile(),
      // Normalised on the way in, so nothing downstream has to guard against a
      // hand-edited file that left a field without its alternates. See
      // normalize.ts — this is the only place it needs doing.
      entries,
      skillGroups: this.loadSkillGroups(),
      /*
       * A section that has never said how it wants to be ordered is asked the
       * one question that can be answered safely — would sorting it change
       * anything? — and takes over its own date order where the answer is no.
       * See `adoptDateOrder`. Nothing is written to disk here: the section is
       * only recorded as date-ordered when the resume is next saved, and a
       * section where sorting *would* move something is left exactly alone for
       * the editor to offer rather than decide.
       */
      /*
       * And the same question about the lines inside an entry — see
       * `adoptBulletOrder`. A resume arranged before the master had a say
       * carries no record of having been arranged, and reading it as
       * deliberate is the only reading that cannot silently restack a
       * document somebody already sent.
       */
      resumes: this.loadResumes().map((resume) =>
        resume.sections
          ? {
              ...resume,
              sections: adoptBulletOrder(adoptDateOrder(resume.sections, entries).adopted, entries),
            }
          : resume,
      ),
      applications: normalizeApplications(this.readYaml<Application[]>('applications.yaml', [])),
      coverLetters: this.loadCoverLetters(),
      drafts: this.loadDrafts(),
      samples: this.loadSamples(),
      answers: this.loadAnswers(),
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
      layout: { ...DEFAULT_CONFIG.layout, ...(raw.layout ?? {}) },
      resumes: { ...DEFAULT_CONFIG.resumes, ...(raw.resumes ?? {}) },
      applications: { ...(raw.applications ?? {}) },
    };

    /*
     * Repaired arguments; the deny list following the research setting, so
     * the two cannot disagree; and the model and effort flags following their
     * own settings, for the same reason: the saved arguments stay the
     * preset's, and the choice is a setting rather than a hand edit that
     * drifts. In one place (`effectiveAiCommand`) so that the switch-off
     * compares exactly the command line this runs.
     */
    config.ai.args = effectiveAiCommand(config.ai).args;
    /*
     * Only a real `true` turns the AI on (see `aiIsOn`). Normalised here so
     * that every reader of `config.ai.enabled` downstream, truthiness checks
     * included, sees the same boolean the switch-off reasoned about.
     */
    config.ai.enabled = aiIsOn(config.ai.enabled);

    // Escape hatches for automated runs. A test suite driving a real server
    // should be able to leave no commits behind without editing config.yaml.
    if (process.env.RMM_AUTOCOMMIT === '0') config.git.autoCommit = false;
    if (process.env.RMM_AI === '0') config.ai.enabled = false;
    // And this machine's own switch-off, from a pull that changed the command. See `aiCommandChange`.
    if (config.ai.enabled && aiSwitchedOff(this.root) !== undefined) config.ai.enabled = false;
    if (process.env.RMM_LATEX_ENGINE) {
      config.latex.engine = process.env.RMM_LATEX_ENGINE as StoreConfig['latex']['engine'];
    }
    return config;
  }

  /**
   * Write config.yaml. Only the fields the caller supplies are changed, so a
   * GUI that knows about the AI settings cannot clobber the LaTeX ones.
   *
   * A field sent as `null` is removed, at whatever depth it sits. Without
   * that there was no way back to a default: "As it comes" effort and the
   * auto-detected engine are the *absence* of a value, JSON drops an
   * `undefined`, and a merge keeps whatever the file already said — so the
   * page reported "Settings saved" over a setting that had not changed.
   */
  saveConfig(patch: Partial<StoreConfig>): StoreConfig {
    /*
     * The read, the change and the write as one step, with no other
     * process's write in between: under the save's lock (see `SaveLock`).
     * Every method here with a `…Held` half is held the same way.
     */
    return holdSaveSync(this.root, () => this.saveConfigHeld(patch));
  }

  private saveConfigHeld(patch: Partial<StoreConfig>): StoreConfig {
    /*
     * While a pull or a clone has the AI switched off here, "off" is this
     * machine's answer and lives in `.git` (see `aiSwitchOffFile`), and
     * `loadConfig` reports `enabled: false` whatever config.yaml says. A
     * client that sends back what it was shown — the Settings page's Save
     * did, with every change to the timeout — would write that false into
     * the tracked file and commit it as "Update settings", a decision about
     * the AI nobody made. The switch-off writes its own `false`, once and
     * under its own name (see `writeAiOff`); and once somebody has turned
     * the AI on again elsewhere and that has been pulled, a timeout changed
     * here must not switch it off for everybody. So while switched off,
     * anything short of turning the AI on leaves the file's own value alone. Turning it on (`true`) still
     * goes through, and clears the switch-off below.
     */
    if (patch.ai && 'enabled' in patch.ai && patch.ai.enabled !== true && aiSwitchedOff(this.root) !== undefined) {
      const { enabled: _keptAsTheFileSaysIt, ...rest } = patch.ai;
      patch = { ...patch, ai: rest as StoreConfig['ai'] };
      /*
       * And nothing written at all when that was the whole of the patch.
       * Written anyway, config.yaml came back out of `writeYaml` without its
       * comments and in its own key order, a change of nobody's making that
       * the caller then committed as "Update settings" — over a request that
       * was told it changed nothing.
       */
      if (Object.keys(rest).length === 0) {
        const { ai: _nothingLeft, ...others } = patch;
        if (Object.values(others).every((v) => v === undefined)) return this.loadConfig();
      }
    }
    const current = this.readYaml<Partial<StoreConfig>>('config.yaml', {});
    const merged: Partial<StoreConfig> = {
      ...current,
      ...(patch.latex ? { latex: { ...current.latex, ...patch.latex } } : {}),
      ...(patch.ai ? { ai: { ...current.ai, ...patch.ai } } : {}),
      ...(patch.git ? { git: { ...current.git, ...patch.git } } : {}),
      ...(patch.output ? { output: { ...current.output, ...patch.output } } : {}),
      /*
       * `fitBounds` merged at its own level, like every block above. Sending
       * one floor would otherwise drop the other two back to this version's
       * defaults, which is a change nobody asked for and would not notice
       * until a resume came out set smaller than they had allowed.
       */
      ...(patch.resumes ? { resumes: { ...current.resumes, ...patch.resumes } } : {}),
      ...(patch.applications ? { applications: { ...current.applications, ...patch.applications } } : {}),
      ...(patch.layout
        ? {
            layout: {
              ...current.layout,
              ...patch.layout,
              ...(patch.layout.fitBounds || current.layout?.fitBounds
                ? { fitBounds: { ...current.layout?.fitBounds, ...patch.layout.fitBounds } }
                : {}),
              ...(patch.layout.growBounds || current.layout?.growBounds
                ? { growBounds: { ...current.layout?.growBounds, ...patch.layout.growBounds } }
                : {}),
            },
          }
        : {}),
    };
    dropNulls(merged as Record<string, unknown>, patch);
    this.writeYaml('config.yaml', merged);
    // Turning the AI on is the person answering a pull's switch-off: they have
    // seen the command in Settings. See `aiCommandChange`.
    if (patch.ai?.enabled === true) clearAiSwitchOff(this.root);
    return this.loadConfig();
  }

  loadVoice(): string {
    const f = this.file('voice.md');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }

  saveVoice(text: string): void {
    this.writeAtomic(this.file('voice.md'), text);
  }

  /**
   * What is in one of the store's folders, and a sentence about the folder
   * when there is no answer.
   *
   * A folder that is not there yet is not a problem: a store with no letters
   * in it has no `letters/`, and the empty list is the truth. Two other things
   * happen to real people on import day and used to arrive as a raw errno from
   * the middle of `store.load()`, which every page of the app calls:
   *
   * `corpus` as a *file* — an export that wrote one, a note somebody saved
   * next to their store — threw "ENOTDIR: not a directory, scandir '/…/corpus'"
   * and took down the whole application, including the parts that had nothing
   * to do with the corpus. The path was in the message; what it was for, and
   * what to do about it, were not.
   *
   * A folder that cannot be read — wrong owner after a restore from a backup,
   * a mode of 0500 on a copied tree — threw EACCES the same way. Both are
   * still refusals, because the alternative is reporting an empty corpus to
   * somebody who has one and letting the next save write that emptiness back.
   * They just say which folder, and what was expected of it.
   */
  private listing(rel: string, keep: (name: string) => boolean): string[] {
    const dir = this.file(rel);
    let stat: fs.Stats | undefined;
    try {
      // Missing comes back as undefined; a parent that cannot be searched, or
      // a mount that has gone away, still throws — and must, for the reason
      // above.
      stat = fs.statSync(dir, { throwIfNoEntry: false });
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      throw new Error(`The save's "${rel}" folder could not be looked at (${dir}) — ${said}`);
    }
    if (!stat) return [];
    if (!stat.isDirectory()) {
      throw new Error(
        `The save has a file called "${rel}" where it expects a folder (${dir}). ` +
          'Move that file aside and try again — nothing has been changed.',
      );
    }
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => keep(d.name));
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      throw new Error(`The save's "${rel}" folder could not be read (${dir}) — ${said}`);
    }
    /*
     * And none of what is listed a link, for the reason `assertNoLink` gives:
     * the loaders read each name they are given straight from this folder,
     * so a `letters/x.md` linking to a file outside the save was read and
     * shown, and written back over, as a letter.
     */
    const link = names.find((d) => d.isSymbolicLink());
    if (link) throw linkInSave(`${rel}/${link.name}`, path.join(dir, link.name));
    return names.map((d) => d.name);
  }

  /** Resumes live one-per-file so a new variation is a new small file. */
  loadResumes(): ResumeSpec[] {
    /*
     * A save written by a version that had inheritance is folded flat here,
     * on the way in, so nothing past this line has to know that `extends`
     * ever existed.
     *
     * In memory rather than on disk, and on every read rather than once:
     * `migrateResumes` writes the flattened files back and commits them, but
     * it is not the thing that makes this safe. A store can be cloned from a
     * git link, restored from history, or hand-edited between two reads, and
     * any of those can put an `extends` back under a running server. Folding
     * on read means the worst case is a file that still says something the
     * app no longer means, never a resume that resolves to the wrong
     * document.
     */
    /*
     * And a tier, for a save written before there were any. The date stamped
     * on a resume this makes temporary is *this read's* date, which never
     * reaches disk — so a save that has not been written back yet has a clock
     * that restarts on every read and therefore never runs out. That is the
     * right way round: the sweep deletes things, and it should not begin
     * until the save has actually been migrated and the date recorded.
     */
    /*
     * And a sent temporary resume, which is written as `extended` so that a
     * version that would sweep it does not, read back as the temporary copy
     * it is here. See `keptOnDisk`.
     */
    return tierResumes(flattenResumes(this.loadResumesAsWritten())).tiered.map(asLoaded);
  }

  /**
   * Write the keep on every temporary resume the tracker says was sent.
   *
   * `saveResume` and `saveApplications` write it from now on; this is for
   * the resumes already on disk — written before either did, by the version
   * before this one, or by hand. Run on opening the save, before the sweep.
   * Returns the ids it wrote, and none on any start after the first.
   */
  keepSentResumes(): string[] {
    const sent = sentResumes(normalizeApplications(this.readYaml<Application[]>('applications.yaml', [])));
    const kept: string[] = [];
    for (const spec of this.loadResumesAsWritten()) {
      // As written: an untiered resume is the tiering migration's to settle,
      // and that writes through `saveResume` too.
      if (spec.tier !== 'temporary' || !sent.has(spec.id)) continue;
      this.writeYaml(['resumes', `${spec.id}.yaml`], keptOnDisk(spec, sent));
      kept.push(spec.id);
    }
    return kept;
  }

  /**
   * Fold an older save's inheritance into the files themselves, once.
   *
   * Returns what it changed and what it found wrong, for the caller to log —
   * and nothing at all when the save is already flat, which is the case every
   * time after the first. See `flatten.ts` for why the fold cannot change any
   * document.
   */
  migrateResumes(): { flattened: string[]; tiered: string[]; lifted: string[]; problems: string[] } {
    const all = this.loadResumesAsWritten();
    if (!needsFlattening(all) && !needsTiering(all)) {
      return { flattened: [], tiered: [], lifted: [], problems: [] };
    }

    const problems: string[] = [];
    const flattened: string[] = [];
    const flat = flattenResumes(all, problems);
    const { tiered: withTiers, changed: tiered } = tierResumes(flat);

    /*
     * And a page setting every one of them agrees on goes up to the save.
     *
     * Only on a save actually being migrated, which is why it is inside the
     * guard above rather than run on every start. Folding copied each base's
     * layout down into every resume that had been inheriting it — correct,
     * and it leaves the save-wide setting saying nothing, because every
     * resume overrules it. See `liftLayout`: no document changes, and from
     * then on the number in Settings moves all of them.
     */
    const config = this.loadConfig();
    const { layout, resumes: lightened, keys: lifted } = liftLayout(withTiers, config.layout);
    if (lifted.length > 0) this.saveConfig({ layout });

    for (const spec of lightened) {
      const before = all.find((r) => r.id === spec.id);
      if (before?.extends) flattened.push(spec.id);
      /*
       * One write per resume however many migrations touched it, and none at
       * all for a resume none of them changed.
       *
       * Compared rather than inferred from which pass ran: the layout lift
       * takes a key off some resumes and not others, so "something was
       * lifted" is not the same question as "was this one of them". Writing
       * on the coarser answer put every file in the save into one commit,
       * most of them identical to themselves, which buries the ones that did
       * change in the history somebody would be reading to find them.
       */
      if (JSON.stringify(before) !== JSON.stringify(spec)) this.saveResume(spec);
    }
    return { flattened, tiered, lifted, problems };
  }

  /**
   * Give tailored copies ids that tell two postings apart.
   *
   * `tailoredResumeId` explains what went wrong and why the new shape is what
   * it is. This is the other half: a save written before it holds copies
   * under the old ids, and leaving them there is not harmless even though
   * nothing further would overwrite them.
   *
   * What it costs to skip: re-tailoring one of those spaces computes the new
   * id, and `baseForCopy` only defends against building a copy from itself —
   * it compares the id asked for against the id being written. The space
   * still points at the *old* id, which is now a different string, so the
   * copy would be built from the previous copy. Its skills are already
   * narrowed to this posting and its wordings already chosen for it, so the
   * second pass narrows what was narrowed and hands back less than was asked
   * for. See `baseForCopy` for the longer version of that.
   *
   * Only ids the old scheme would itself have produced are touched. A resume
   * somebody named by hand is theirs, whatever it happens to be called, and
   * a rename it never asked for is the sort of thing that makes a save feel
   * unsafe to keep anything in.
   *
   * Nothing is recovered for two postings that *already* collided — the
   * second tailoring overwrote the first and there is no first left to name.
   * Only the version history has it.
   */
  migrateTailoredIds(): { renamed: Array<{ from: string; to: string }> } {
    const resumes = this.loadResumesAsWritten();
    const taken = new Set(resumes.map((r) => r.id));
    const renames = new Map<string, string>();
    for (const spec of resumes) {
      const { company, role } = spec.generatedFor ?? {};
      if (!company || !role) continue;
      if (spec.id !== legacyTailoredResumeId(company, role)) continue;
      const want = tailoredResumeId(company, role);
      // `taken` rather than the original list, so two renames cannot be
      // pointed at one file either.
      if (want === spec.id || taken.has(want)) continue;
      renames.set(spec.id, want);
      taken.add(want);
    }
    if (renames.size === 0) return { renamed: [] };

    const moved = (id: string | undefined) => (id && renames.get(id)) || id;

    /*
     * Written under the new name before the old one is unlinked, so a process
     * that dies in the middle leaves the save with two copies of a resume
     * rather than none. A duplicate is a thing somebody can delete; a resume
     * every space points at and nothing holds is not.
     */
    for (const spec of resumes) {
      const to = renames.get(spec.id);
      const copiedFrom = moved(spec.copiedFrom);
      /*
       * And an `extends`, which a save not yet folded can still carry. Left on
       * the old id, the base it names is gone and the fold drops everything
       * the resume inherited from it.
       */
      const inherits = moved(spec.extends);
      if (!to && copiedFrom === spec.copiedFrom && inherits === spec.extends) continue;
      this.saveResume({
        ...spec,
        id: to ?? spec.id,
        ...(copiedFrom ? { copiedFrom } : {}),
        ...(inherits ? { extends: inherits } : {}),
      });
    }
    for (const from of renames.keys()) {
      for (const ext of Store.RESUME_SPELLINGS) {
        const f = this.file('resumes', `${from}.${ext}`);
        if (fs.existsSync(f)) fs.rmSync(f);
      }
    }

    // And everything that names a resume follows it, or the space that was
    // sending one is now sending nothing.
    const apps = normalizeApplications(this.readYaml<Application[]>('applications.yaml', []));
    if (apps.some((a) => a.resumeId !== moved(a.resumeId))) {
      this.saveApplications(apps.map((a) => ({ ...a, resumeId: moved(a.resumeId) })));
    }
    for (const draft of this.loadDrafts()) {
      if (draft.resumeId !== moved(draft.resumeId)) {
        // Not touched: a rename nobody asked for is not an edit, and the
        // date is what the drafts list sorts on and the sweep ages by.
        this.saveDraft({ ...draft, resumeId: moved(draft.resumeId) }, { touch: false });
      }
    }

    return { renamed: [...renames].map(([from, to]) => ({ from, to })) };
  }

  /**
   * The resume files as written, before any migration.
   *
   * Public because the migration needs it and because a test that claims the
   * fold changes no document has to be able to read what was there before.
   * Nothing else should: `loadResumes` is the one that answers "what does
   * this save hold", and this one can hand back a shape the app no longer
   * understands.
   */
  loadResumesAsWritten(): ResumeSpec[] {
    const dir = this.file('resumes');
    return (
      this.listing('resumes', (f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        /*
         * `.yaml` before `.yml`, so a folder holding both spellings of one id
         * is not decided by whatever order the filesystem returned. `saveResume`
         * writes `.yaml`, so `.yaml` is the copy that has been edited; the
         * dedupe below keeps the first of the two it sees.
         */
        .sort((a, b) => a.localeCompare(b))
    )
      .map((f) => {
        const spec = this.cached<Partial<ResumeSpec>>(
          path.join(dir, f),
          (raw) => parseStoreYaml<Partial<ResumeSpec>>(`resumes/${f}`, raw, {}),
          {},
        );
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
         * Taken from the name, a copied file is simply its own resume — and
         * normalised, so the id is the same string whichever filesystem last
         * wrote the name. See `onDiskSpelling`: a Mac hands back the é of an
         * accented filename as two code points, and an id nothing can match is
         * a resume nothing can open.
         */
        const id = path.basename(f).replace(/\.ya?ml$/, '').normalize('NFC');
        /*
         * And a name for it, from the same place, when the file does not give
         * one. A resume file that exists and is still empty — created by hand,
         * or copied and not yet filled in — arrived with `label: undefined`,
         * which is the label every picker in the app then showed for it.
         */
        /*
         * And sections in a shape that can be walked — see `normalizeSections`.
         * One resume's hand edit is that resume's problem, not every screen's.
         */
        const sections = normalizeSections(spec.sections);
        return {
          ...spec,
          id,
          label: String(spec.label ?? id),
          ...(sections ? { sections } : {}),
        } satisfies ResumeSpec;
      })
      .filter((r, i, all) => Boolean(r.id) && all.findIndex((o) => o.id === r.id) === i);
  }

  getResume(id: string): ResumeSpec | undefined {
    return this.loadResumes().find((r) => r.id === id);
  }

  saveResume(spec: ResumeSpec): void {
    holdSaveSync(this.root, () => this.saveResumeHeld(spec));
  }

  private saveResumeHeld(spec: ResumeSpec): void {
    /*
     * A temporary resume that went out is written as kept, whoever is
     * writing it — the card filing its copy again, the editor saving it, a
     * migration. See `keptOnDisk`: on disk as `temporary`, the previous
     * version on the same clone sweeps it.
     */
    const sent = sentResumes(normalizeApplications(this.readYaml<Application[]>('applications.yaml', [])));
    this.writeYaml(['resumes', `${spec.id}.yaml`], keptOnDisk(spec, sent));
  }

  /**
   * Deleting a resume takes nothing else with it.
   *
   * This used to be the most dangerous write in the store. Variations were
   * thin — "new grad" was the base plus a handful of choices, recorded as
   * `extends: base` — so unlinking the base left every variation throwing
   * "extends 'base', which does not exist" from that moment on, in the
   * editor, the preview and the tracker alike, with nothing in the UI able to
   * edit `extends` and so no way back but hand-editing YAML. The fix was a
   * rewrite of every child on the way past, which then had to be careful
   * about which of the parent's fields were content and which were identity,
   * and got that wrong too.
   *
   * Resumes stand alone now, so none of that has anything to rewrite — as
   * long as they actually do, which is what the fold below makes sure of.
   *
   * A save can still be sitting on disk in the old shape: folding happens on
   * read, and the write-back is a separate pass that a given process may not
   * have run. Delete the base of an unfolded save and the children lose
   * everything it was contributing, silently — the next read finds nothing to
   * fold and they resolve to their own handful of overrides. So the files are
   * brought up to date first, and only then is one of them removed. It costs
   * one pass over a folder of small files, once, on the first delete after an
   * upgrade.
   *
   * Except that finding out there is nothing to fold is itself a read of every
   * resume, and so is looking up the label — nothing for one deletion, and
   * most of the sweep's time when it deleted ninety in a row. So a caller
   * deleting many may fold once itself and say so with `migrated`, and hand
   * over the `label` it already has. The label is only the name a failed
   * unlink is reported under.
   */
  deleteResume(id: string, { migrated = false, label }: { migrated?: boolean; label?: string } = {}): void {
    if (!migrated) this.migrateResumes();

    const named = label ?? this.loadResumes().find((r) => r.id === id)?.label ?? id;
    for (const ext of Store.RESUME_SPELLINGS) {
      removeFile(this.file('resumes', `${id}.${ext}`), `"${named}"`);
    }
  }

  /**
   * Both spellings of a resume's filename. A hand-made `.yml` beside the
   * `.yaml` the app writes would bring a deleted resume back on the next read.
   */
  static readonly RESUME_SPELLINGS = ['yaml', 'yml'] as const;

  /**
   * Where a resume is kept, relative to the store, whether or not it is there.
   *
   * For asking git — the sweep checks that the history has a resume before it
   * deletes one, and git speaks in paths from the root of the repository.
   * Never for opening a file: paths are composed by `file`, one name at a
   * time, and splitting one of these back into segments would hand it
   * `['resumes', '..', 'profile.yaml']`, three names each of which passes the
   * check that `../profile.yaml` fails. The id is checked here anyway, so a
   * path cannot be smuggled into a pathspec either.
   */
  static resumeFiles(id: string): string[] {
    assertName(`${id}.yaml`);
    return Store.RESUME_SPELLINGS.map((ext) => `resumes/${id}.${ext}`);
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
   * The four entry files, read into one list holding each id once.
   *
   * This was a plain concatenation of the four, which meant `load()` could hand
   * back two entries with one id — and then the app disagreed with itself about
   * which of them was the entry. `resolveResume` does `entries.find(...)` and
   * got the first; the editor, the inventory and the tailoring prompt iterate
   * the list and got both, so a copied entry was listed twice, counted twice,
   * and rendered from whichever copy happened to sort first.
   *
   * One id, one entry. Where two copies exist, the first in file order wins —
   * the same one `find` was already picking, so nothing that worked before
   * resolves differently — except for the one case where the files themselves
   * say which copy is misfiled. An entry copied into projects.yaml while still
   * saying `kind: experience` belongs to experience.yaml by its own account,
   * and the copy sitting in the file its kind names is the one to believe.
   *
   * What this cannot do is tell a stale copy from a fresh one when both sit in
   * the file their kind names — which is exactly the wreckage `saveEntry` can
   * leave if the second of its two writes fails. Nothing in the content
   * distinguishes them, so that case still falls to file order and the error
   * `saveEntry` threw at the time remains the only notice of it. See the
   * comment there.
   *
   * Entries with no id at all are left alone: they are not duplicates of each
   * other, and folding two of them into one would be exactly the silent loss
   * this is here to prevent.
   */
  private loadEntries(): Entry[] {
    const out: Entry[] = [];
    const at = new Map<string, { index: number; misfiled: boolean }>();

    for (const rel of Store.ENTRY_FILES) {
      for (const raw of this.readYaml<Entry[]>(rel, [])) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = normalizeEntry(raw);
        const misfiled = this.fileForKind(entry.kind) !== rel;

        const seen = entry.id ? at.get(entry.id) : undefined;
        if (!seen) {
          at.set(entry.id, { index: out.push(entry) - 1, misfiled });
        } else if (seen.misfiled && !misfiled) {
          // Replaced where the first copy stood, so the order the four files
          // are read in still decides the order of the list.
          out[seen.index] = entry;
          seen.misfiled = false;
        }
      }
    }

    return out;
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
    holdSaveSync(this.root, () => this.saveEntryHeld(entry));
  }

  private saveEntryHeld(entry: Entry): void {
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
     * both files instead, and the next successful save tidies up.
     *
     * Be clear about what that costs, because the comment here used to claim
     * more than the code did: `loadEntries` hands out one entry per id, but
     * both copies sit in the file their own `kind` names — the fresh one
     * because it was just written there, the stale one because its `kind` was
     * never changed — so nothing in the content says which is which, and file
     * order decides. For a project becoming education the fresh copy wins; for
     * education becoming a project the stale one does. The error thrown from
     * here is the only notice of that, which is why it must not be swallowed
     * by a caller.
     */
    // Read before anything is written, so it is the entry as it stood rather
    // than the one this call is about to put in its place.
    const was = this.loadEntries();
    const before = was.find((e) => e.id === clean.id);
    refuseRepeatsInEntry(before, clean);

    const list = this.readYaml<Entry[]>(rel, []);
    const idx = list.findIndex((e) => holdsId(e, clean.id));
    if (idx >= 0) list[idx] = clean;
    else list.push(clean);
    this.writeYaml(rel, list);

    for (const other of Store.ENTRY_FILES) {
      if (other === rel) continue;
      const stale = this.readYaml<Entry[]>(other, []);
      const next = stale.filter((e) => !holdsId(e, clean.id));
      if (next.length !== stale.length) this.writeYaml(other, next);
    }

    /*
     * A line, a wording or a list item removed here is removed everywhere.
     *
     * Most saves of an entry add or reword, and those change nothing any
     * resume points at — so the question is asked first and the pass over the
     * resumes only runs for the one kind of write that needs it. See
     * `forget.ts`.
     */
    if (before && entryLosesIds(before, clean)) {
      this.forgetInResumes(was, was.map((e) => (e.id === clean.id ? clean : e)));
    }
  }

  /** Removes the id from every file, not merely the first one holding it. */
  deleteEntry(id: string): boolean {
    return holdSaveSync(this.root, () => this.deleteEntryHeld(id));
  }

  private deleteEntryHeld(id: string): boolean {
    const was = this.loadEntries();
    let removed = false;
    for (const rel of Store.ENTRY_FILES) {
      const list = this.readYaml<Entry[]>(rel, []);
      const next = list.filter((e) => !holdsId(e, id));
      if (next.length !== list.length) {
        this.writeYaml(rel, next);
        removed = true;
      }
    }
    // And out of every resume that was showing it. A section listing an entry
    // the store no longer has is not a resume that prints it — it is a resume
    // that complains about it, on every resolve, with no way to say so back.
    if (removed) this.forgetInResumes(was, was.filter((e) => e.id !== id));
    return removed;
  }

  saveSkillGroups(groups: SkillGroup[]): void {
    holdSaveSync(this.root, () => this.saveSkillGroupsHeld(groups));
  }

  private saveSkillGroupsHeld(groups: SkillGroup[]): void {
    const was = this.movedSinceRead(this.file('skills.yaml'));
    const before = normalizeSkillGroups(this.readYaml<SkillGroup[]>('skills.yaml', []));
    // Onto the file as it is now, when another process has written it since. See `saveApplications`.
    if (was !== undefined) groups = mergeById(normalizeSkillGroups(was), groups, before, (g) => g.id) ?? groups;
    refuseRepeats(before, groups);
    this.writeYaml('skills.yaml', groups);
    // Dropping a skill from a group, or a whole group, reaches the resumes
    // that had pinned it — same reasoning as entries above.
    if (skillsLoseIds(before, groups)) this.forgetInResumes(undefined, undefined, before, groups);
  }

  /**
   * Take every reference to something the store no longer holds out of the
   * resumes, and say which ones that changed.
   *
   * The new entries and groups are passed in rather than read back, because
   * they were written a moment ago and the read cache is keyed on a file's
   * size and modification time: two writes inside one millisecond that happen
   * to land on the same length would be served the copy from before the
   * delete, and the pass would then prune against a store that no longer
   * exists — which is the one way this could remove something somebody still
   * had.
   *
   * Written through `saveResume` one file at a time, inside whatever commit
   * the delete itself is being made in, so undoing the delete in the version
   * history brings the resumes back with it.
   */
  private forgetInResumes(
    wasEntries?: Entry[],
    nowEntries?: Entry[],
    wasGroups?: SkillGroup[],
    nowGroups?: SkillGroup[],
  ): string[] {
    const entries = this.loadEntries();
    const groups = normalizeSkillGroups(this.readYaml<SkillGroup[]>('skills.yaml', []));
    const before = indexStore(wasEntries ?? entries, wasGroups ?? groups);
    const after = indexStore(nowEntries ?? entries, nowGroups ?? groups);
    // Where a deleted alternate sends the resumes that had pinned it. See
    // `forget.ts`: only alternates move, because only alternates have a
    // nearest surviving version of themselves.
    const moved = findMovedWordings(before, after);

    const changed: string[] = [];
    /*
     * As written, not as resolved.
     *
     * `loadResumes` folds inheritance and stamps a date on anything it has to
     * make temporary, and that date is deliberately never written to disk —
     * see the note on `tierResumes`. Saving what it hands back would write it,
     * and start a one-week clock on resumes nobody has touched.
     */
    for (const spec of this.loadResumesAsWritten()) {
      const next = forgetMissing(spec, after, moved);
      if (JSON.stringify(next) !== JSON.stringify(spec)) {
        this.saveResume(next);
        changed.push(spec.id);
      }
    }
    return changed;
  }

  saveProfile(profile: Profile): void {
    holdSaveSync(this.root, () => this.saveProfileHeld(profile));
  }

  private saveProfileHeld(profile: Profile): void {
    // Onto the file as it is now, field by field, when another process has
    // written it since. See `saveApplications`.
    const was = this.movedSinceRead(this.file('profile.yaml'));
    const mine = normalizeProfile(profile);
    this.writeYaml(
      'profile.yaml',
      was === undefined ? mine : mergeFields(normalizeProfile(was as Profile), mine, this.loadProfile()),
    );
  }

  saveApplications(apps: Application[]): void {
    holdSaveSync(this.root, () => this.saveApplicationsHeld(apps));
  }

  private saveApplicationsHeld(apps: Application[]): void {
    /*
     * Onto the tracker as it is now, not as it was when the caller read it.
     *
     * Every caller reads the list, changes a row and hands the whole list
     * back, and inside this server that is safe: nothing is awaited between
     * the read and this write. But the `rmm` CLI is another process, and a
     * row it filed between the server's read and this write was written
     * over by the list from before it — `rmm apply` exited 0 and its row
     * was gone. So when the file has moved since this process read it, the
     * caller's change is worked out against what it read (the remembered
     * parse) and made to what is there now, row by row: a row the caller
     * changed, added or removed is the caller's; every other row is the
     * file's. Under the lock, so nothing moves while that is done.
     */
    const was = this.movedSinceRead(this.file('applications.yaml'));
    const before = normalizeApplications(this.readYaml<Application[]>('applications.yaml', []));
    if (was !== undefined) {
      apps = mergeById(normalizeApplications(was), normalizeApplications(apps), before, (a) => a.id) ?? apps;
    }
    this.writeYaml('applications.yaml', apps);
    /*
     * And a temporary resume this write says went out is written as kept,
     * in the same write and so the same commit: a row moved to `applied`,
     * filed at `applied` to begin with, or remembering in `sentResumeIds`
     * the resume it was sent with before it moved on. See `keptOnDisk` for
     * why the file has to say it rather than the tracker alone.
     *
     * Only on the change, so a write that sends nothing new out does not
     * also rewrite resumes: the ones already on disk are `keepSentResumes`'s,
     * on opening the save.
     */
    const fresh = newlySent(before, normalizeApplications(apps));
    if (fresh.length === 0) return;
    const sent = new Set(fresh);
    for (const spec of this.loadResumesAsWritten()) {
      if (spec.tier !== 'temporary' || !sent.has(spec.id)) continue;
      this.writeYaml(['resumes', `${spec.id}.yaml`], keptOnDisk(spec, sent));
    }
  }

  upsertApplication(app: Application): Application[] {
    return holdSaveSync(this.root, () => this.upsertApplicationHeld(app));
  }

  private upsertApplicationHeld(app: Application): Application[] {
    const apps = normalizeApplications(this.readYaml<Application[]>('applications.yaml', []));
    const idx = apps.findIndex((a) => a.id === app.id);
    if (idx >= 0) apps[idx] = app;
    else apps.push(app);
    this.saveApplications(apps);
    return apps;
  }

  saveAnswers(answers: AnswerBankItem[]): void {
    holdSaveSync(this.root, () => this.saveAnswersHeld(answers));
  }

  private saveAnswersHeld(answers: AnswerBankItem[]): void {
    // Onto the file as it is now, when another process has written it since. See `saveApplications`.
    const was = this.movedSinceRead(this.file('answers.yaml'));
    if (was !== undefined) {
      const now = normalizeAnswers(this.readYaml<AnswerBankItem[]>('answers.yaml', []));
      answers = mergeById(normalizeAnswers(was), normalizeAnswers(answers), now, (a) => a.id) ?? answers;
    }
    this.writeYaml('answers.yaml', answers);
  }

  /** Cover letters are markdown files with a YAML front-matter header. */
  loadCoverLetters(): CoverLetter[] {
    const dir = this.file('letters');
    return this.listing('letters', (f) => f.endsWith('.md'))
      .map((f) => {
        const { raw, split } = this.cachedFrontMatter(path.join(dir, f), `letters/${f}`);
        const id = path.basename(f, '.md').normalize('NFC');
        if (!split) {
          return { id, title: id, createdAt: '', body: raw } satisfies CoverLetter;
        }
        const meta = parseStoreYaml<Partial<CoverLetter>>(`letters/${f}`, split.header, {});
        /*
         * The header as it was written, with the fields we know about settled
         * over the top of it.
         *
         * This was rebuilt field by field, and a field missed there was a field
         * deleted: the editor loads a letter and PUTs back exactly what it was
         * given, so anything dropped on the way in is dropped from the file on
         * the way out. It happened to `applicationId` — completing an
         * application tags its letter with the application it belongs to, and
         * opening that letter once untagged it, after which the per-application
         * lookup could never match and the application showed no letter.
         *
         * Listing the fields again would only move the next omission somewhere
         * else, and it would still throw away a key this version has never
         * heard of. A store is hand-editable YAML under git; somebody who adds
         * `sentOn:` or `portal:` to their own letter means it, and a later
         * version of this app may well mean it too. So the header is kept whole
         * and only the four fields that must have a value are settled.
         */
        return {
          ...meta,
          id,
          title: String(meta.title ?? id),
          createdAt: String(meta.createdAt ?? ''),
          body: split.body,
        } satisfies CoverLetter;
      });
  }

  /**
   * Write a cover letter.
   *
   * `voice` is taken from the copy on disk when the letter being written does
   * not state one, because it is a decision *about* the letter rather than a
   * part of it — and every writer here bar one is replacing the letter's
   * text. The Workspace files the letter when the application goes out; the
   * AI files the one it drafted; both mint the id from the company and the
   * day, so re-running either for the same job lands on the same letter.
   * Written literally, saying "this one is not how I write" and then sending
   * that application would quietly say the opposite, with nothing on screen
   * about it and the corpus silently a letter larger.
   *
   * `decidesVoice` is for the one caller that is deciding rather than
   * writing. `POST /voice/include` says "counted again" by taking the key
   * away, so it has to be able to write an absence and mean it.
   */
  saveCoverLetter(letter: CoverLetter, opts: { decidesVoice?: boolean } = {}): void {
    holdSaveSync(this.root, () => this.saveCoverLetterHeld(letter, opts));
  }

  private saveCoverLetterHeld(letter: CoverLetter, { decidesVoice = false }: { decidesVoice?: boolean }): void {
    const { body, id, ...meta } = letter;
    if (!decidesVoice && meta.voice === undefined) {
      const stored = this.loadCoverLetters().find((l) => l.id === id)?.voice;
      if (stored !== undefined) meta.voice = stored;
    }
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
    return this.listing('corpus', (f) => f.endsWith('.md'))
      .map((f) => {
        const { raw, split } = this.cachedFrontMatter(path.join(dir, f), `corpus/${f}`);
        const id = path.basename(f, '.md').normalize('NFC');
        if (!split) return { id, title: id, kind: 'other' as const, text: raw, createdAt: '' };
        const meta = parseStoreYaml<Partial<WritingSample>>(`corpus/${f}`, split.header, {});
        // Kept whole, for the reason given over the letters above: a sample is
        // a file somebody wrote, and a key this version does not recognise is
        // not a key to delete on their behalf.
        return {
          ...meta,
          id,
          title: String(meta.title ?? id),
          kind: meta.kind ?? 'other',
          createdAt: String(meta.createdAt ?? ''),
          text: split.body,
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

  /** Take a cover letter out; false when there was none by that id. */
  deleteCoverLetter(id: string): boolean {
    const f = this.file('letters', `${id}.md`);
    if (!fs.existsSync(f)) return false;
    removeFile(f, 'That cover letter');
    return true;
  }

  deleteSample(id: string): boolean {
    const f = this.file('corpus', `${id}.md`);
    if (!fs.existsSync(f)) return false;
    removeFile(f, 'That writing sample');
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Standing documents                                                  *
   * ------------------------------------------------------------------ */

  /**
   * Files you attach again and again and never generate: a transcript, a
   * portfolio, a writing sample a form asks for as a PDF.
   *
   * Everything else in a save is either text this program composes or text it
   * learns from. These are neither — they arrive finished, from a registrar
   * or a designer, and the only thing wanted of them is to be attached. So
   * they are stored as the bytes they came as, under the names they will be
   * uploaded under, and copied into the flat folder beside the built resume
   * so that one place holds everything a form is going to ask for.
   *
   * Not `assets/`, which is the voice corpus's inbox: material the AI reads.
   * A transcript is not something to write from.
   */
  listDocuments(): StandingDocument[] {
    const dir = this.file('documents');
    return this.listing('documents', (f) => !f.startsWith('.'))
      .map((name) => {
        let bytes = 0;
        let at = '';
        try {
          const stat = fs.statSync(path.join(dir, name));
          bytes = stat.size;
          at = stat.mtime.toISOString();
        } catch {
          // Removed between the listing and the stat. Report it without a
          // size rather than failing the whole list over one file.
        }
        return { name: name.normalize('NFC'), bytes, at };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Where one is on disk, or undefined when the name is not allowed. */
  documentPath(name: string): string | undefined {
    try {
      const f = this.file('documents', name);
      return fs.existsSync(f) ? f : undefined;
    } catch {
      // `file` refuses a name with a path in it. Not there, as far as anything
      // that wants to read it is concerned.
      return undefined;
    }
  }

  /** The bytes of one, or undefined when it is not there. */
  readDocument(name: string): Buffer | undefined {
    const f = this.file('documents', name);
    try {
      return fs.readFileSync(f);
    } catch {
      return undefined;
    }
  }

  /**
   * Keep one, under the name it will be uploaded as.
   *
   * The name is the whole of the interface: a form's reviewer sees it, so
   * "Transcript.pdf" is right and "scan_001 (3).pdf" is not, and renaming is
   * saving it again under the better name. `file` refuses anything with a
   * path in it, as everywhere else.
   */
  saveDocument(name: string, bytes: Buffer): StandingDocument {
    const clean = name.trim().normalize('NFC');
    if (!clean) throw new Error('Give the document a name.');
    /*
     * Not a dotted name, which would be written and then invisible.
     *
     * `listDocuments` skips anything beginning with a dot — the manifest and
     * the scratch files this folder keeps look like that — so a document
     * saved as `.transcript.pdf` went to disk, went into the commit, and then
     * could not be listed or removed from the panel by anybody.
     */
    /*
     * The path check first, because `..` begins with a dot too and "that is a
     * path" is the more useful thing to be told about `../config.yaml`.
     */
    const f = this.file('documents', clean);
    if (clean.startsWith('.')) {
      throw new Error(`"${clean}" begins with a dot, which this save keeps for files of its own. Choose another name.`);
    }
    fs.mkdirSync(this.file('documents'), { recursive: true });
    /*
     * Through the same write every other file in the save gets.
     *
     * This was a bare `writeFileSync`, the only one in the class, and it
     * skipped all three of that method's guarantees: a name the save can be
     * cloned with (`Transcript: Fall 2024.pdf` stops a checkout on Windows
     * partway), no second name differing from an existing one only in case,
     * and a rename into place instead of a truncating write — in the one
     * folder whose whole purpose is that an upload dialog is open over it.
     */
    this.writeAtomic(f, bytes);
    return { name: clean, bytes: bytes.length, at: new Date().toISOString() };
  }

  deleteDocument(name: string): boolean {
    const f = this.file('documents', name);
    if (!fs.existsSync(f)) return false;
    removeFile(f, `"${name}"`);
    return true;
  }

  /**
   * Applications in progress. One file each, like resumes, so a draft is
   * readable in a diff and easy to delete by hand.
   *
   * Read through `this.cached`, like every other per-file loader in this
   * class — this one had been calling `readStoreFile` and `parseStoreYaml`
   * directly instead, so a save with a normal season's worth of drafts in
   * flight (a few dozen to a few hundred) paid a fresh read and a fresh YAML
   * parse of every one of them on every single call to `load()`, which is
   * nearly every request the server answers. Measured on 150 drafts: 67ms of
   * a 112ms `load()`, every time, whether or not a draft had changed since
   * the last call. Cached, the same 150 drafts cost under a millisecond once
   * warm, because `cached` already keys on a file's size and modification
   * time and only re-reads what actually moved.
   */
  loadDrafts(): Draft[] {
    const dir = this.file('drafts');
    return this.listing('drafts', (f) => f.endsWith('.yaml'))
      .map((f) => {
        const draft = this.cached<Partial<Draft>>(
          path.join(dir, f),
          (raw) => parseStoreYaml<Partial<Draft>>(`drafts/${f}`, raw, {}),
          {},
        );
        // The filename is the id, the same way it is for resumes, and for the
        // same reason: an id written inside the file meant that copying a draft
        // to `d1-backup.yaml` produced two drafts claiming to be `d1`, and that
        // renaming one left `deleteDraft` unlinking a path that is not there —
        // so discarding it failed and completing it silently left it on the
        // list forever.
        /*
         * Posting text that is a whole page of markup, read as the page's
         * text. The Workspace's tailor used to save `html.slice(0, 20_000)`
         * when a link answered with a JavaScript shell, and every letter and
         * answer written from that draft read the scripts and styles. Repaired
         * here, on the way in, so a draft saved by that version is read as
         * text without anyone having to find it.
         */
        const posting = draft.jobDescription;
        const repaired =
          typeof posting === 'string' && /^\s*<(?:!doctype|html)\b/i.test(posting)
            ? { jobDescription: extractJob(posting).description }
            : {};
        return { ...draft, ...repaired, id: path.basename(f, '.yaml').normalize('NFC') };
      })
      .filter((d): d is Draft => Boolean(d && d.id))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  getDraft(id: string): Draft | undefined {
    return this.loadDrafts().find((d) => d.id === id);
  }

  /**
   * `touch: false` keeps `updatedAt` as it was, for a write the app makes on
   * its own — a rename is not somebody working on the application, and the
   * stale close and the workspace retirement both read that clock.
   */
  saveDraft(draft: Draft, { touch = true }: { touch?: boolean } = {}): Draft {
    const next = touch ? { ...draft, updatedAt: new Date().toISOString() } : draft;
    this.writeYaml(['drafts', `${draft.id}.yaml`], next);
    return next;
  }

  deleteDraft(id: string): boolean {
    const f = this.file('drafts', `${id}.yaml`);
    if (!fs.existsSync(f)) return false;
    removeFile(f, 'That draft');
    return true;
  }

  /**
   * Absolute path to the configured output directory, created on demand.
   *
   * `output.dir` is a setting in a hand-editable file, and blank is what a
   * half-finished edit leaves behind. Blank resolved to the *parent of the
   * save* — so `current/` and `applications/` were scattered beside the save
   * folder, and `/pdf/:name`, which serves whatever is in the output
   * directory, was pointed at a directory full of the user's unrelated files.
   * `dir: '.'` with `withinProject` did the same to the save folder itself,
   * which would have put generated PDFs under version control.
   *
   * Neither is a thing anybody means, and neither is worth refusing to start
   * over: the output folder holds only files this app can rebuild, so falling
   * back to `out` inside the save costs a rebuild and loses nothing.
   */
  outDir(): string {
    const output = this.loadConfig().output;
    const asked = String(output.dir ?? '').trim();
    let dir = path.resolve(this.root, output.withinProject ? '.' : '..', asked || 'out');
    if (dir === this.root || this.root.startsWith(dir + path.sep)) dir = path.join(this.root, 'out');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      throw new Error(
        `The output folder could not be created (${dir}) — ${said}. ` +
          'Change where built files go under Settings → output folder.',
      );
    }
    return dir;
  }

  /**
   * A path inside the output folder, and never outside it.
   *
   * The twin of `file` above, for the same reason and against a worse case.
   * A bundle folder is named after an application id, and that id is not
   * always one this code made: `buildBundle` prefers the id of the tracker row
   * the job already has, which comes out of applications.yaml — hand-editable
   * by design, and written by `POST /api/applications` from a body the browser
   * extension supplies, `id` and all.
   *
   * An id of `../../..` plus a real path therefore chose the bundle folder,
   * and `buildBundle` deletes every file in that folder before it writes. One
   * request from any page in the browser, and a folder of the owner's is
   * emptied. Checked here, where the path is built, because the alternative is
   * remembering to check at each of the callers.
   */
  outFile(...p: string[]): string {
    const out = this.outDir();
    for (const segment of p) assertName(segment);
    const full = path.resolve(out, ...p);
    if (full !== out && !full.startsWith(out + path.sep)) {
      throw new Error('That name is not allowed — it points outside the output folder.');
    }
    return full;
  }

  /**
   * A path the tracker recorded, resolved — or nothing, when it leads out of
   * the output folder.
   *
   * `snapshotDir` is stored relative to the output folder, and everything that
   * reads it walks the folder and copies what it finds: `syncCurrent` copies
   * it into `out/current`, which this app serves over HTTP to any origin that
   * asks. A `snapshotDir` of `../../.ssh` is then a tidy little file server for
   * somebody's keys, and the only thing standing between that and a visited
   * web page was that nothing had written such a value yet — which the id
   * above could do.
   *
   * Undefined rather than a throw: a row pointing somewhere else is one row,
   * and failing the whole sync over it would take down the tab that lists
   * every other application. Nothing of the user's is lost by declining to
   * copy a folder that was never a bundle.
   */
  outPath(rel: string): string | undefined {
    const out = this.outDir();
    // A hand-written `snapshotDir: 5` is not a folder either, and calling
    // `.includes` on it threw out of the whole sync.
    if (!rel || typeof rel !== 'string' || rel.includes('\u0000')) return undefined;
    const full = path.resolve(out, rel);
    return full.startsWith(out + path.sep) ? full : undefined;
  }
}

/**
 * Whether an item read straight out of an entry file is the entry with this id.
 *
 * The file is compared raw, before `normalizeEntry` has run, so it has to
 * read the id the way normalizing does. YAML makes `id: 2024` a number, and
 * `e.id === '2024'` never matched it: a save appended a second copy that
 * `loadEntries` then hid behind the first, so the edit was lost, and a delete
 * removed whichever copy it found. A stray `-` is `null`, and reading `.id`
 * off it threw — after the save had already written its own file.
 */
function holdsId(raw: unknown, id: string): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return String((raw as Partial<Entry>).id ?? '') === id;
}

/**
 * Refuse a skills write that would list the same skill, or the same group,
 * twice.
 *
 * Named, and only for what this write adds — see `duplicates.ts`. A refusal
 * here is the last line rather than the first: the editor checks before it
 * sends so the message arrives without a round trip, and this is what catches
 * the API, the CLI and the authoring tools, none of which go through it.
 */
function refuseRepeats(before: SkillGroup[], after: SkillGroup[]): void {
  const repeatedNames = newlyRepeated(
    before.map((g) => ({ id: g.id, text: g.name })),
    after.map((g) => ({ id: g.id, text: g.name })),
  );
  if (repeatedNames.length > 0) {
    throw new Error(
      `There is already a skills group called ${andList(repeatedNames)}. Add to that one, or give this a different name.`,
    );
  }
  for (const group of after) {
    const was = before.find((g) => g.id === group.id);
    const again = newlyRepeated((was?.items ?? []) as Option[], (group.items ?? []) as Option[]);
    if (again.length > 0) {
      throw new Error(`${andList(again)} is already in "${group.name}". A group lists each skill once.`);
    }
  }
}

/**
 * The same rule inside an entry: a list line's items, and the alternate
 * phrasings of a line or a field.
 *
 * A list bullet is the other place the word "option" means something — "Built
 * with Unity, Unreal, Godot" is a list of them — and the alternates are a
 * third: two identical wordings of one line are a stepper with a step that
 * does nothing, which reads as the control being broken.
 */
function refuseRepeatsInEntry(before: Entry | undefined, after: Entry): void {
  const say = (again: string[], where: string) => {
    if (again.length > 0) throw new Error(`${andList(again)} is already ${where}.`);
  };

  for (const bullet of after.bullets ?? []) {
    const was = (before?.bullets ?? []).find((b) => b.id === bullet.id);
    if (Array.isArray(bullet.items)) {
      say(newlyRepeated((was?.items ?? []) as Option[], bullet.items as Option[]), 'in this list');
    }
    say(
      newlyRepeated((was?.variants ?? []) as Option[], (bullet.variants ?? []) as Option[]),
      'a wording of this line',
    );
  }

  for (const name of ['title', 'dates', 'subtitle', 'location'] as const) {
    const now = after[name];
    const was = before?.[name];
    if (!isVariantField(now)) continue;
    const had = isVariantField(was) ? (was.variants as unknown as Option[]) : [];
    say(
      newlyRepeated(had, now.variants as unknown as Option[]),
      `a way of writing this entry's ${name === 'title' ? 'name' : name}`,
    );
  }
}
