import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { StoreConfig } from '../model/types.js';

const run = promisify(execFile);

export interface AgentResult {
  /** Raw stdout from the CLI, or the prompt itself when the agent is disabled. */
  output: string;
  /** False when `ai.enabled` is off — `output` is then the unexecuted prompt. */
  executed: boolean;
  command?: string;
}

/**
 * Shells out to whichever coding-agent CLI is configured. The prompt goes to a
 * file rather than the command line: prompts here run to tens of kilobytes,
 * past what an argv can hold, and a file keeps quoting out of the picture.
 *
 * ## Confinement
 *
 * These CLIs are agents: left alone they can read and write whatever their
 * working directory gives them. None of these tasks needs a filesystem at all —
 * every prompt already carries the text it is reasoning about — so the child
 * runs in a fresh empty temp directory holding nothing but the prompt. That
 * alone is the guarantee, independent of whatever sandbox flags a particular
 * CLI happens to offer; `{sandbox}` in the argument template expands to that
 * directory for CLIs that want it named explicitly.
 *
 * What this stops: an agent that decides to "look around the project" ending up
 * in your source tree, your store, or your home directory.
 */
export async function runAgent(config: StoreConfig, prompt: string): Promise<AgentResult> {
  if (!config.ai.enabled) {
    return { output: prompt, executed: false };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-ai-'));
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, prompt, 'utf8');

  // `{prompt}` is the prompt file path; `{promptText}` inlines it for CLIs that
  // insist on an argument; `{sandbox}` is the directory the child is confined
  // to, for CLIs that take an explicit allow-list.
  const args = config.ai.args.map((a) =>
    a.replace('{prompt}', promptFile).replace('{promptText}', prompt).replace('{sandbox}', dir),
  );
  const usesFile = config.ai.args.some((a) => a.includes('{prompt}') && !a.includes('{promptText}'));

  try {
    const { stdout, stderr } = await run(config.ai.command, args, {
      timeout: config.ai.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      // The confinement: an empty directory with only the prompt in it, never
      // the server's own working directory.
      cwd: dir,
      env: {
        ...process.env,
        // Some CLIs treat these as "the project"; point them at the sandbox so
        // a stray relative path cannot escape it.
        PWD: dir,
        TMPDIR: dir,
      },
      // CLIs that take the prompt on stdin get it there; harmless otherwise.
      ...(usesFile ? {} : { input: prompt } as object),
    });
    const output = stdout.trim() || stderr.trim();
    return { output, executed: true, command: `${config.ai.command} ${args.join(' ')}` };
  } catch (err) {
    const e = err as { code?: string; message?: string; stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') {
      throw new AgentError(
        `AI command "${config.ai.command}" not found. Install it, or change ai.command in data/config.yaml, ` +
          `or set ai.enabled: false to get prompts back instead of answers.`,
      );
    }
    throw new AgentError(
      `AI command failed: ${e.stderr?.trim() || e.message || 'unknown error'}`,
      e.stdout,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export class AgentError extends Error {
  readonly partial?: string;
  constructor(message: string, partial?: string) {
    super(message);
    this.name = 'AgentError';
    this.partial = partial;
  }
}

/**
 * Pull a JSON object out of an agent's reply. Models wrap JSON in prose or
 * fences often enough that demanding clean output is not worth the failures.
 */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => Boolean(c));

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim()) as T;
    } catch {
      // Fall through to brace matching.
    }
    const start = c.indexOf('{');
    if (start < 0) continue;
    // Walk braces so a nested object doesn't get truncated at the first '}'.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new AgentError(`Could not find JSON in the agent's reply. Raw output:\n${text.slice(0, 2000)}`);
}
