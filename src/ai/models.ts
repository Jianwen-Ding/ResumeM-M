import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AI_PRESETS } from './presets.js';

const run = promisify(execFile);

/**
 * What models this CLI says it takes, asked rather than remembered.
 *
 * The list in `presets.ts` is written by hand, and a hand-written list of
 * models is stale the week after it is written. It already was: the Claude CLI
 * on this machine documents `fable`, `opus` and `sonnet`, and the list here
 * said `opus`, `sonnet`, `haiku`. Somebody picking from it was picking from
 * last quarter.
 *
 * There is no listing command to call. That is worth saying plainly rather
 * than pretending otherwise: `claude` has no `models` subcommand, and
 * `/models` is a thing its interactive client understands, not the executable
 * — run through `-p` it is simply a prompt, and the model answers it in
 * conversation. So the question is put to the one interface every one of these
 * CLIs does have and does keep current, which is its own `--help`.
 *
 * The parse is deliberately credulous about *where* it finds names and strict
 * about *what* counts as one. Anything quoted in the paragraph that describes
 * the model flag is a candidate; a candidate has to look like a model
 * identifier to survive. Getting it wrong in the generous direction costs a
 * suggestion nobody picks, in a text field that has never refused a value
 * anyway — the flag takes whatever you type, and always has.
 */
export interface ModelList {
  models: string[];
  /** `cli` when the command answered, `suggestions` when it did not. */
  from: 'cli' | 'suggestions';
}

/** Long enough that opening Settings twice does not run the CLI twice. */
const REMEMBER_MS = 10 * 60 * 1000;
const asked = new Map<string, { at: number; list: ModelList }>();

/** A name that could be a model: letters, digits, dots and dashes, no prose. */
const LOOKS_LIKE_A_MODEL = /^[a-z][a-z0-9]*(?:[.\-][a-z0-9]+)*$/i;
/*
 * Words that turn up quoted in help text beside the model flag and are not
 * models: the placeholder itself, and the stock advice about what to pass.
 */
const NOT_A_MODEL = /^(model|models|name|alias|aliases|default|auto|latest|full|none|string|value)$/i;

/**
 * Pull model names out of a CLI's help.
 *
 * Exported for its own sake: the parsing is the part that can be wrong, and it
 * is far easier to be sure of against real help text than through a subprocess.
 */
export function modelsInHelp(help: string): string[] {
  const text = String(help ?? '');
  // The paragraph describing the model flag, up to the next flag at the same
  // indentation. Help output wraps, so this cannot be done line by line.
  const at = /^[ \t]*(?:-[a-z], )?--model\b/im.exec(text);
  if (!at) return [];
  const rest = text.slice(at.index);
  const ends = /\n[ \t]*-(?:-[a-z]|[a-z],)/i.exec(rest.slice(1));
  const paragraph = ends ? rest.slice(0, ends.index + 1) : rest;

  const found = new Set<string>();
  for (const [, quoted] of paragraph.matchAll(/['"`]([^'"`\n]{2,60})['"`]/g)) {
    const name = (quoted ?? '').trim();
    if (!LOOKS_LIKE_A_MODEL.test(name) || NOT_A_MODEL.test(name)) continue;
    found.add(name);
  }
  return [...found];
}

/**
 * Ask a command what it takes, or say where the answer came from instead.
 *
 * Never throws and never waits long. A CLI that is not installed, that hangs,
 * that prints nothing useful, or that is not one of the four presets all reach
 * the same place: the hand-written suggestions, which is exactly what was
 * offered before any of this existed. The picker is a text field either way,
 * so the worst case is a shorter list of hints beside a box that accepts
 * anything.
 */
export async function listModels(
  command: string,
  exec: (cmd: string, args: string[]) => Promise<string> = async (cmd, args) =>
    (await run(cmd, args, { timeout: 5000, maxBuffer: 4 << 20 })).stdout,
): Promise<ModelList> {
  const name = (command ?? '').trim();
  const preset = AI_PRESETS.find((p) => p.command === name || name.endsWith(`/${p.command}`));
  const fallback: ModelList = { models: preset?.model?.suggestions ?? [], from: 'suggestions' };
  if (!name) return fallback;

  const remembered = asked.get(name);
  if (remembered && Date.now() - remembered.at < REMEMBER_MS) return remembered.list;

  let list = fallback;
  try {
    const found = modelsInHelp(await exec(name, ['--help']));
    if (found.length > 0) list = { models: found, from: 'cli' };
  } catch {
    // Not installed, not on the path, too slow, or it writes its help to
    // somewhere other than stdout. None of those is worth a message: the
    // suggestions are still there and the field still takes anything.
  }

  asked.set(name, { at: Date.now(), list });
  return list;
}

/** Ask again next time — for a CLI that has just been updated. */
export function forgetModels(): void {
  asked.clear();
}
