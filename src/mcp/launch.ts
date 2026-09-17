/**
 * Handing a running CLI a tool server it did not know it was going to get.
 *
 * Every one of these tools has a way to be told about an MCP server and every
 * one of them spells it differently: a flag pointing at a JSON file, a config
 * file it looks for in the working directory, a `-c` override. All three read
 * the same shape of config, so the work here is writing that shape into the
 * sandbox and returning the extra arguments — if any — that make the CLI look
 * at it.
 *
 * The sandbox is why this is simple. The child already runs in a fresh empty
 * temporary directory holding nothing but its prompt (`runAgent`), which is
 * exactly where a config file it should find and nothing else belongs. No
 * port, no token, no listening socket: the CLI spawns the server itself, over
 * a pipe, and the whole conversation is two processes and a file that is
 * deleted when the run ends.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AI_PRESETS } from '../ai/presets.js';
import type { SessionFile } from './main.js';

/**
 * The MCP entry point, in whichever form this install has.
 *
 * Two, because this application runs two ways. Built, it is `dist/src/mcp/bin.js`
 * and node runs it directly. From a checkout it is `src/mcp/bin.ts` and node
 * cannot — which would have made the tools a feature that quietly existed only
 * for people who had run `npm run build`, and `npm run serve` is how the
 * README says to start it.
 *
 * Returns null when neither is there, and the caller falls back to JSON.
 */
export function serverEntry(here: string): string | null {
  const compiled = path.join(here, 'bin.js');
  if (fs.existsSync(compiled)) return compiled;
  const source = path.join(here, 'bin.ts');
  if (fs.existsSync(source)) return source;
  return null;
}

/**
 * How to run it. A `.ts` entry needs tsx in front of it; a `.js` one is node's
 * own business.
 */
function howToRun(entry: string): { command: string; args: string[] } {
  if (entry.endsWith('.ts')) return { command: 'npx', args: ['tsx', entry] };
  return { command: process.execPath, args: [entry] };
}

export interface Wiring {
  /** Arguments to add to the CLI's own command line. */
  args: string[];
  /** The file the session's decisions will be written to. */
  out: string;
  /** Environment for the child, on top of whatever it already has. */
  env: Record<string, string>;
}

/**
 * How each CLI is told. Absent means "this one has no MCP support we can rely
 * on", and the caller falls back to asking for JSON — which still works, and
 * is what every run did before this existed.
 */
const WIRING: Record<string, (configPath: string) => string[]> = {
  // A flag naming the file, which is the least surprising of the three.
  claude: (config) => ['--mcp-config', config, '--strict-mcp-config'],
  // Codex takes arbitrary config overrides; this is the documented key.
  codex: (config) => ['-c', `mcp_servers_file=${config}`],
  // Gemini reads .gemini/settings.json from the working directory, so the
  // file is written where it looks and no flag is needed.
  gemini: () => [],
};

/**
 * Can this command be told about a tool server at all?
 *
 * Asked before the prompt is written, because the two have to agree: a prompt
 * telling a model to call tools it was never given is worse than one that
 * asks for JSON, and a model given tools but told to answer in JSON will
 * mostly answer in JSON.
 */
export function canWire(command: string): boolean {
  const preset = presetFor(command);
  return Boolean(preset && WIRING[preset]);
}

/** Which preset's command this is, if any. */
function presetFor(command: string): string | undefined {
  return AI_PRESETS.find((p) => new RegExp(`(^|[\\\\/])${p.command}(\\.exe)?$`, 'i').test(command.trim()))?.command;
}

/**
 * Write the session and the config into the sandbox, and say what to add.
 *
 * Returns `null` when the configured command is not one we know how to wire
 * up. Guessing would be worse than not trying: a flag a CLI does not
 * recognise usually stops it running at all, and a tailoring pass that fails
 * outright is a worse outcome than one that goes back to asking for JSON.
 */
export function wireUp(
  sandbox: string,
  command: string,
  session: Omit<SessionFile, 'out'>,
  entry: string | null,
): Wiring | null {
  const preset = presetFor(command);
  const build = preset ? WIRING[preset] : undefined;
  if (!build || !entry) return null;

  const sessionPath = path.join(sandbox, 'tailor-session.json');
  const out = path.join(sandbox, 'tailor-decisions.json');
  fs.writeFileSync(sessionPath, JSON.stringify({ ...session, out }), 'utf8');

  /*
   * One server, named for what it is rather than for this application: the
   * model sees the name beside every tool, and "resume" is the word that
   * tells it what these tools are about.
   */
  const config = {
    mcpServers: {
      resume: {
        ...howToRun(entry),
        env: { RMM_TAILOR_SESSION: sessionPath },
      },
    },
  };

  const configPath = path.join(sandbox, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  // Gemini looks in a fixed place rather than at a flag, so it gets a copy
  // where it looks. Writing both costs a few hundred bytes in a directory
  // that is about to be deleted.
  const geminiDir = path.join(sandbox, '.gemini');
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(path.join(geminiDir, 'settings.json'), JSON.stringify(config, null, 2), 'utf8');

  return {
    args: build(configPath),
    out,
    // Also on the environment, so a CLI that launches the server some other
    // way — or a person debugging one by hand — does not need the config.
    env: { RMM_TAILOR_SESSION: sessionPath },
  };
}
