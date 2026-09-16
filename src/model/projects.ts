import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
      staged.saveProfile({ name: 'Your Name' });
      staged.saveResume({ id: 'base', label: 'My resume', base: true, sections: [
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
