import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PLACEHOLDER_NAME } from './resolve.js';
import { Store } from './store.js';

export const projectsFile = () => process.env.RMM_PROJECTS_FILE || path.join(os.homedir(), '.resumem-m', 'projects.json');
export interface ProjectPreferences { active?: string; recent: string[]; defaultFolder?: string | null }
export function readProjects(file = projectsFile()): ProjectPreferences {
  if (!fs.existsSync(file)) return { recent: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { active: typeof data.active === 'string' ? data.active : undefined,
    ...(Object.hasOwn(data, 'defaultFolder') ? { defaultFolder: typeof data.defaultFolder === 'string' ? data.defaultFolder : null } : {}),
    recent: Array.isArray(data.recent) ? data.recent.filter((p: unknown) => typeof p === 'string') : [] };
}
export function rememberProject(dir: string | null, file = projectsFile(), previousDir?: string): void {
  const previous = readProjects(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...previous, defaultFolder: Object.hasOwn(previous, 'defaultFolder') ? previous.defaultFolder : previous.active ?? null, active: dir, recent: [...new Set([...(dir ? [dir] : []), ...(previousDir ? [previousDir] : []), ...previous.recent])].slice(0, 12) }, null, 2));
  fs.renameSync(temp, file);
}

/** null means show the chooser at startup; unset preserves older remembered saves. */
export function setDefaultFolder(dir: string | null, file = projectsFile()): void {
  const previous = readProjects(file);
  const selected = dir ? prepareProject(undefined, dir, 'open').root : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...previous, defaultFolder: selected,
    recent: [...new Set([...(selected ? [selected] : []), ...previous.recent])].slice(0, 12) }, null, 2));
  fs.renameSync(temp, file);
}

// Resolve through symlinked parents even for a destination that does not exist.
function canonical(dir: string): string {
  if (fs.existsSync(dir)) return fs.realpathSync(dir);
  const parent = path.dirname(dir);
  return parent === dir ? dir : path.join(canonical(parent), path.basename(dir));
}
function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function prepareProject(current: Store | undefined, input: string, mode: 'open' | 'create' | 'move'): Store {
  if (!input?.trim()) throw new Error('Choose a save folder');
  const expanded = input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input;
  if (!path.isAbsolute(expanded)) throw new Error('Use an absolute folder path (or ~/...)');
  const target = canonical(path.resolve(expanded));
  const source = current ? canonical(current.root) : undefined;
  if (current && target === source) return current;
  if (source && (inside(source, target) || inside(target, source))) throw new Error('Choose a folder outside the current save');
  const next = new Store(target);
  if (mode === 'open') {
    if (!fs.existsSync(path.join(target, 'profile.yaml')) || !fs.existsSync(path.join(target, 'config.yaml'))) {
      throw new Error('That folder is not a resume save. Choose Create Save for a new folder.');
    }
    next.load(); // Validate before changing the active project.
    return next;
  }
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) {
    throw new Error('Choose an empty or new folder; existing files will not be overwritten');
  }
  if (mode === 'move' && !current) throw new Error('Open a save before moving it');
  // Stage beside the destination. Failed copies never leave a half-built project there.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.rmm-project-'));
  try {
    const staged = new Store(stage);
    if (mode === 'move' && current && source) {
      if (fs.existsSync(path.join(source, '.git')) && !fs.statSync(path.join(source, '.git')).isDirectory()) {
        throw new Error('This save uses a linked git worktree. Open another folder or create a new save instead.');
      }
      fs.cpSync(source, stage, { recursive: true, dereference: true, filter: file => {
        if (fs.lstatSync(file).isSymbolicLink() && !inside(source, fs.realpathSync(file))) {
          throw new Error('This save links to files outside its folder. Copy those files into the save folder before moving.');
        }
        return true;
      } });
      const oldOutput = path.resolve(source, current.loadConfig().output.withinProject ? '.' : '..', current.loadConfig().output.dir);
      if (inside(oldOutput, source)) throw new Error('The output folder must not contain the save itself');
      if (!inside(source, oldOutput) && fs.existsSync(oldOutput)) {
        if (fs.existsSync(path.join(stage, 'out'))) throw new Error('The save already has an out folder; resolve the output folder conflict before moving');
        fs.cpSync(oldOutput, path.join(stage, 'out'), { recursive: true, dereference: true });
      } else if (inside(source, oldOutput) && oldOutput !== path.join(source, 'out') && fs.existsSync(oldOutput)) {
        fs.cpSync(oldOutput, path.join(stage, 'out'), { recursive: true, dereference: true });
      }
    } else {
      staged.saveProfile({ name: PLACEHOLDER_NAME });
      staged.saveResume({ id: 'base', label: 'My resume', tier: 'base', sections: [
        { kind: 'education', entries: [] }, { kind: 'experience', entries: [] },
        { kind: 'project', entries: [] }, { kind: 'skills', entries: [], groups: [] },
      ] });
    }
    staged.saveConfig({ output: { dir: 'out', withinProject: true } });
    fs.mkdirSync(path.join(stage, 'assets', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'out'), { recursive: true });
    staged.load();
    if (fs.existsSync(target)) fs.rmdirSync(target); // Only the verified empty directory.
    fs.renameSync(stage, target);
    return next;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A save is its own git repository, which is exactly why this should exist.
 *
 * Keeping the store apart from the source is the whole design — it has its own
 * lifetime, its own history, and it is the thing you might push somewhere
 * private. The half that was missing is the other machine: opening it there
 * meant cloning by hand in a terminal, remembering where you put it, and then
 * finding that folder in the chooser. Three steps, none of which this tool
 * helped with, for the thing it was built around.
 *
 * Validated as a save, not merely as a clone that worked. A repository that
 * turns out to hold something else is a mistake worth catching before it is
 * the open save, and the empty directory it was cloned into goes with it.
 */
export async function cloneProject(
  url: string,
  into: string,
  clone: (url: string, dir: string) => Promise<void>,
): Promise<Store> {
  const link = url.trim();
  if (!link) throw new Error('Paste the address of the repository holding the save');
  /*
   * Refused rather than passed to git.
   *
   * `--upload-pack=…` and friends are options, not addresses, and git reads
   * them as options wherever they appear. This runs git with a URL the user
   * pasted, and a pasted string beginning with a dash is either a mistake or
   * an attempt to turn a clone into "run this program".
   */
  if (link.startsWith('-')) throw new Error('That does not look like a repository address');
  if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/i.test(link) && !path.isAbsolute(link)) {
    throw new Error('Use an https:// or git@ address, or an absolute path to a repository');
  }

  const expanded = into.startsWith('~/') ? path.join(os.homedir(), into.slice(2)) : into;
  if (!path.isAbsolute(expanded)) throw new Error('Use an absolute folder path (or ~/...)');
  const target = canonical(path.resolve(expanded));
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) {
    throw new Error('Choose an empty or new folder; existing files will not be overwritten');
  }

  // Staged beside the destination, the way creating and moving are: a clone
  // that fails halfway must not leave something that looks like a save.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.rmm-clone-'));
  try {
    await clone(link, stage);
    if (!fs.existsSync(path.join(stage, 'profile.yaml')) || !fs.existsSync(path.join(stage, 'config.yaml'))) {
      throw new Error('That repository is not a resume save: it has no profile.yaml and config.yaml at its root.');
    }
    const store = new Store(stage);
    store.load(); // Validate before it becomes the open save.

    // The folders a save needs that git does not carry, because they are empty.
    fs.mkdirSync(path.join(stage, 'assets', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'out'), { recursive: true });

    if (fs.existsSync(target)) fs.rmdirSync(target);
    fs.renameSync(stage, target);
    return new Store(target);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
