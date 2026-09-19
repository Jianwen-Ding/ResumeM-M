import { spawn } from 'node:child_process';
import path from 'node:path';
import { AI_PRESETS, type AiModelPicker } from './presets.js';

/** What the installed CLI's own model picker offered. */
export interface ModelList {
  models: string[];
  from: 'cli' | 'unavailable';
  /** A short explanation for the settings panel; never raw terminal output. */
  message?: string;
}

/** Long enough that reopening Settings does not start four terminal sessions. */
const REMEMBER_MS = 10 * 60 * 1000;

/**
 * And much shorter when the answer was that they could not be read.
 *
 * A failure was remembered for the same ten minutes as a list, and the failure
 * says: "Codex did not show any model choices. Sign in to the CLI, then reopen
 * Settings." Doing exactly that is answered from the memory of the failure, so
 * the panel repeats the same sentence to somebody who has just done what it
 * asked — for ten minutes, with nothing to press and no way to tell that the
 * signing in worked. `forgetModels` exists for this and nothing calls it
 * outside the tests.
 *
 * Not removed altogether, because the reason the memory is there is real: a
 * probe opens a terminal session and waits several seconds for it, and a panel
 * that asks four times as it renders would open four. Twenty seconds covers
 * one panel opening; it does not cover walking to a terminal, signing in, and
 * coming back.
 */
const RETRY_FAILED_MS = 20 * 1000;

const asked = new Map<string, { at: number; list: ModelList }>();

/**
 * The process that receives the pseudo-terminal is fixed and reads the actual
 * command and argv from JSON environment variables. On Linux, script -c
 * invokes a shell; keeping every user-controlled byte out of that string is
 * what makes a configured path a path rather than shell syntax.
 */
const PTY_RUNNER = String.raw`
const { spawn } = require('node:child_process');
const child = spawn(process.env.RMM_MODEL_COMMAND, JSON.parse(process.env.RMM_MODEL_ARGS || '[]'), {
  stdio: 'inherit',
  env: process.env,
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 127; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code == null ? 1 : code;
});
`;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * macOS's BSD script insists that its own stdin already be a terminal, which
 * is not true for a GUI-launched server. Expect creates the PTY itself and is
 * part of macOS, so it is the reliable bridge there. Every configured value is
 * read from the environment and passed as a Tcl list item, never evaluated as
 * script text.
 */
const EXPECT_RUNNER = String.raw`
set stty_init "rows 40 columns 160"
set model_args {}
for {set i 0} {$i < $env(RMM_MODEL_ARG_COUNT)} {incr i} {
  lappend model_args [set env(RMM_MODEL_ARG_$i)]
}
spawn -noecho $env(RMM_MODEL_COMMAND) {*}$model_args
proc observe {seconds} {
  set ::timeout $seconds
  expect {
    eof { exit 0 }
    timeout {}
  }
}
observe 2
# TUI clients can treat text and Return delivered in one write as input that
# arrived before their command palette was ready. Type, then press Return as
# two human-like events so the slash command is actually submitted.
send -- "$env(RMM_MODEL_QUERY)"
after 150
send -- "\r"
if {[info exists env(RMM_MODEL_REVEAL)] && $env(RMM_MODEL_REVEAL) ne ""} {
  observe 2
  send -- $env(RMM_MODEL_REVEAL)
}
if {[info exists env(RMM_MODEL_OPENED)] && $env(RMM_MODEL_OPENED) ne ""} {
  # A cold GUI-launched CLI sometimes accepts the text before its input loop
  # is ready but loses the Return key. Wait for proof that the picker opened;
  # if it did not, press Return once more on the text still in the input box.
  set ::timeout 5
  expect {
    -exact $env(RMM_MODEL_OPENED) { observe 3 }
    eof { exit 0 }
    timeout {
      # The first text can be lost as well as Return. Clear any partial input,
      # then repeat the complete command once the TUI is unquestionably ready.
      send -- "\025"
      after 100
      send -- "$env(RMM_MODEL_QUERY)"
      after 150
      send -- "\r"
      observe 5
    }
  }
} else {
  observe 5
}
send -- "\033"
after 100
send -- "\003\003"
observe 1
catch {close}
catch {wait}
`;

/** A probe is injectable because terminal capture and terminal parsing fail differently. */
export type ModelProbe = (
  command: string,
  picker: AiModelPicker,
  cwd: string,
) => Promise<string>;

/**
 * Capture a CLI's live choices. Interactive pickers run in a real
 * pseudo-terminal and are dismissed without confirming a choice; a CLI with
 * an account-aware listing subcommand is read directly.
 *
 * A pipe is not enough: all four clients switch their interactive UI off when
 * stdout is not a TTY. `script` is the Linux bridge and macOS's built-in
 * Expect provides the PTY there. The child is placed in its own process group
 * so the CLI cannot survive after the bridge is stopped.
 */
export const captureModelPicker: ModelProbe = (command, picker, cwd) =>
  new Promise((resolve, reject) => {
    const interactive = picker.mode !== 'command';
    if (process.platform === 'win32' && interactive) {
      reject(new Error('Interactive model discovery is not available on Windows yet'));
      return;
    }

    const onMac = process.platform === 'darwin';
    const bridge = !interactive ? command : onMac ? '/usr/bin/expect' : 'script';
    const bridgeArgs = !interactive
      ? picker.args
      : onMac
        ? ['-c', EXPECT_RUNNER]
        : ['-q', '-c', `${shellQuote(process.execPath)} -e ${shellQuote(PTY_RUNNER)}`, '/dev/null'];
    const pickerArgs = picker.args ?? [];
    const pickerEnv = Object.fromEntries(pickerArgs.map((arg, i) => [`RMM_MODEL_ARG_${i}`, arg]));

    const child = spawn(bridge, bridgeArgs, {
      cwd,
      detached: true,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        NO_COLOR: '1',
        RMM_MODEL_COMMAND: command,
        RMM_MODEL_ARGS: JSON.stringify(pickerArgs),
        RMM_MODEL_ARG_COUNT: String(pickerArgs.length),
        RMM_MODEL_QUERY: interactive ? picker.query : '',
        RMM_MODEL_REVEAL: interactive ? picker.reveal ?? '' : '',
        RMM_MODEL_OPENED: interactive ? picker.opened ?? '' : '',
        ...pickerEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const remember = (chunk: Buffer | string) => {
      if (output.length >= 4 * 1024 * 1024) return;
      output += String(chunk).slice(0, 4 * 1024 * 1024 - output.length);
    };
    child.stdout.on('data', remember);
    child.stderr.on('data', remember);

    const stop = (error?: Error) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      child.stdin?.end();
      try {
        // The bridge, its optional Node shim, and the CLI are one detached group.
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      if (error) reject(error);
      else resolve(output);
    };

    child.on('error', (error) => stop(error));
    child.on('close', () => stop());

    // On Linux script forwards stdin to its PTY. Expect sends the same input
    // itself on macOS because the GUI server has no terminal to forward.
    if (interactive && !onMac) {
      timers.push(setTimeout(() => {
        child.stdin?.write(`${picker.query}\r`);
        if (picker.reveal) {
          timers.push(setTimeout(() => child.stdin?.write(picker.reveal), 1_500));
        }
      }, 700));
    }
    // Long enough for a remotely supplied list, short enough for Settings.
    const timeout = !interactive ? 35_000 : onMac ? 15_000 : picker.reveal ? 6_000 : 4_500;
    timers.push(setTimeout(() => stop(), timeout));
  });

/** Remove terminal control traffic while preserving the text it positioned. */
export function plainTerminal(output: string): string {
  return String(output ?? '')
    // OSC: titles, hyperlinks and progress notifications.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // CSI and the remaining short ESC sequences.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-2A-Z]/g, '')
    .replace(/\x1b./g, '')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

const unique = (values: Iterable<string>): string[] => {
  const byKey = new Map<string, string>();
  for (const raw of values) {
    const value = raw.trim().replace(/[),.;:]+$/, '');
    if (value && !byKey.has(value.toLowerCase())) byKey.set(value.toLowerCase(), value);
  }
  return [...byKey.values()];
};

/** Identifiers printed by Codex, Gemini and Antigravity pickers. */
const MODEL_ID = /\b(?:gpt|codex|gemini|claude|o[1-9])[-.][a-z0-9][a-z0-9._-]*\b/gi;

/**
 * Turn one CLI's rendered picker into values accepted by that CLI's model
 * flag. This consumes only what the picker printed; it contains no release
 * list and therefore cannot become stale when a model is added or removed.
 */
export function modelsInPicker(output: string, parser: AiModelPicker['parser']): string[] {
  const text = plainTerminal(output);

  if (parser === 'claude') {
    const found: string[] = [];
    for (const line of text.split('\n')) {
      if (!/^\s*(?:❯\s*)?\d+[.)]\s+/.test(line) || /\bdisabled\b/i.test(line)) continue;
      const label = line
        .replace(/^\s*(?:❯\s*)?\d+[.)]\s+/, '')
        .replace(/^\(selected\)\s*/i, '')
        .split(/\s+[—–-]\s+/)[0]!
        .trim();
      if (!label || /^default\b/i.test(label)) continue;
      // Claude's picker offers aliases as human labels ("Opus (1M
      // context)"); the --model value is the leading alias it just showed.
      const alias = /^[a-z][a-z0-9._-]*/i.exec(label)?.[0];
      if (alias) found.push(alias.toLowerCase());
    }
    return unique(found);
  }

  if (parser === 'agy') {
    // `agy models` is tabular: the first field is the exact --model value and
    // the second is a friendly label. Parsing only field one avoids treating
    // a display label such as "GPT-OSS 120B" as another model identifier.
    return unique(text.split('\n').flatMap((line) => {
      const id = /^\s*((?:gemini|claude|gpt|o[1-9])[-.][a-z0-9][a-z0-9._-]*)\t/i.exec(line)?.[1];
      return id ? [id] : [];
    }));
  }

  /*
   * Codex prints the currently configured model in its startup banner before
   * the command is typed. Once its picker heading is present, ignore that
   * banner so the answer is exactly the menu, in the order the menu showed.
   */
  const codexPickerAt = parser === 'codex' ? text.lastIndexOf('Select Model and Effort') : -1;
  // A startup banner also contains the current model. It is not an answer to
  // /model, so never turn that partial capture into a one-choice model list.
  if (parser === 'codex' && codexPickerAt < 0) return [];
  const pickerText = codexPickerAt >= 0 ? text.slice(codexPickerAt) : text;
  if (parser === 'codex') {
    const numbered = /\b\d+[.)]\s+((?:gpt|codex|o[1-9])[-.][a-z0-9][a-z0-9._-]*)\b/gi;
    return unique([...pickerText.matchAll(numbered)].map((match) => match[1]!));
  }
  const ids = [...pickerText.matchAll(MODEL_ID)].map((match) => match[0]!);
  if (parser === 'gemini') return unique(ids.filter((id) => /^gemini-/i.test(id)));
  return unique(ids);
}

const presetFor = (command: string) => {
  const base = path.basename(command.trim()).replace(/\.exe$/i, '');
  return AI_PRESETS.find((preset) => preset.command.toLowerCase() === base.toLowerCase());
};

/**
 * Ask the configured command's live model source. Failure deliberately does
 * not turn into a remembered list: the free-form field remains available and
 * the UI can say why live choices could not be read.
 */
export async function listModels(
  command: string,
  cwd = process.cwd(),
  probe: ModelProbe = captureModelPicker,
): Promise<ModelList> {
  const name = (command ?? '').trim();
  const preset = presetFor(name);
  if (!name || !preset?.model) {
    return {
      models: [],
      from: 'unavailable',
      message: name ? 'Live model discovery is only available for a known AI CLI preset.' : 'Choose an AI CLI first.',
    };
  }

  const key = `${name}\u0000${JSON.stringify(preset.model.picker)}`;
  const remembered = asked.get(key);
  const keepFor = remembered?.list.from === 'cli' ? REMEMBER_MS : RETRY_FAILED_MS;
  if (remembered && Date.now() - remembered.at < keepFor) return remembered.list;

  let list: ModelList;
  try {
    const models = modelsInPicker(await probe(name, preset.model.picker, cwd), preset.model.picker.parser);
    list = models.length > 0
      ? { models, from: 'cli' }
      : {
          models: [],
          from: 'unavailable',
          message: `${preset.label} did not show any model choices. Sign in to the CLI, then reopen Settings.`,
        };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    list = {
      models: [],
      from: 'unavailable',
      message: code === 'ENOENT'
        ? `${preset.label} is not installed or is not on PATH.`
        : `${preset.label}'s model choices could not be read. Sign in to the CLI, then reopen Settings.`,
    };
  }

  asked.set(key, { at: Date.now(), list });
  return list;
}

/** Ask again next time — useful after updating or signing in to a CLI. */
export function forgetModels(): void {
  asked.clear();
}
