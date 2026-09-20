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
  /**
   * Arguments that pre-approve calls to this server, kept apart from the ones
   * that say the server exists.
   *
   * Separate because the two have opposite failure modes. `args` is knowledge:
   * drop it and the run has no tools, which is the thing this module exists to
   * prevent. `approval` is a preference added by newer Codex versions, so if
   * an older CLI rejects it, the run is better off without it than not running
   * at all. `runAgent` retries once with this dropped, which is only possible
   * because it is a separate list.
   */
  approval: string[];
  /** The file the session's decisions will be written to. */
  out: string;
  /** Environment for the child, on top of whatever it already has. */
  env: Record<string, string>;
}

/** The one server, in the shape every config file here is written from. */
interface Server {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Codex has no key naming a config file, so the server is spelled out.
 *
 * `-c mcp_servers_file=…` was invented: there is no such key. Codex's
 * configuration reference has `mcp_servers` — a table of servers — and four
 * neighbours (`mcp_oauth_callback_port`, `mcp_oauth_callback_url`,
 * `mcp_oauth_credentials_store`, `mcp_optional_startup_grace_ms`), and nothing
 * that takes a path. An override on a key Codex does not have is accepted and
 * ignored, so the run went ahead with no tools at all while its prompt told it
 * to call them — the one combination the wiring exists to avoid.
 *
 * `-c` sets a dotted key to a TOML value, so the server goes in a field at a
 * time. JSON is the encoder because TOML basic strings and arrays of them are
 * written exactly as JSON writes them, escapes included — which matters for a
 * Windows path, where the alternative is hand-escaping backslashes.
 */
function codexOverrides(server: Server): string[] {
  const toml = (v: unknown) => JSON.stringify(v);
  const env = Object.entries(server.env)
    .map(([k, v]) => `${k}=${toml(v)}`)
    .join(', ');
  return [
    '-c',
    `mcp_servers.resume.command=${toml(server.command)}`,
    '-c',
    `mcp_servers.resume.args=${toml(server.args)}`,
    '-c',
    `mcp_servers.resume.env={${env}}`,
  ];
}

/**
 * Codex knows about the server and still will not call it.
 *
 * Reported from a real tailoring pass, from the run's own transcript:
 *
 *   MCP tool call requires approval, but approval policy is never
 *
 * Which is not a wiring fault — the server started, the model found the tools,
 * and every call it made was refused. `codex exec` is non-interactive, so it
 * has nobody to ask and its approval policy is `never`; a tool call needing
 * approval under that policy is simply denied. The run then spends its whole
 * timeout looking for another way round, which is what the user saw.
 *
 * The blunt fix is to turn approvals off for the run, and that is far too
 * much: it would also affect every other tool the CLI has. The narrow one is
 * Codex's server-scoped MCP approval setting: approve calls to *this* server
 * and leave the rest alone.
 *
 * `default_tools_approval_mode = "approve"` is the documented server-level
 * setting. It still goes in `Wiring.approval` rather than `Wiring.args` for
 * compatibility: a Codex version from before that setting existed gets one
 * more run without it instead of failing before it can do any work.
 */
function codexApproval(): string[] {
  return ['-c', `mcp_servers.resume.default_tools_approval_mode=${JSON.stringify('approve')}`];
}

/**
 * Which CLIs get a server-level approval setting, and what it is.
 *
 * Empty for the others on purpose. Claude's own config takes the server list
 * and asks nothing further about it, and Gemini reads the settings file it was
 * given; neither has been seen refusing its own tools, and a flag added on
 * spec to a CLI that does not want one is the failure this file's header warns
 * about.
 */
const APPROVAL: Record<string, () => string[]> = {
  codex: codexApproval,
};

/**
 * How each CLI is told. Absent means "this one has no MCP support we can rely
 * on", and the caller falls back to asking for JSON — which still works, and
 * is what every run did before this existed.
 */
const WIRING: Record<string, (configPath: string, server: Server) => string[]> = {
  // A flag naming the file, which is the least surprising of the three.
  claude: (config) => ['--mcp-config', config, '--strict-mcp-config'],
  codex: (_config, server) => codexOverrides(server),
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
  // Same file, same name, whichever kind of session it is: a CLI is told
  // about a server once, so three names would be three configs to keep in
  // step with each other for no gain.

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
  const server: Server = { ...howToRun(entry), env: { RMM_TAILOR_SESSION: sessionPath } };
  const config = { mcpServers: { resume: server } };

  const configPath = path.join(sandbox, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  // Gemini looks in a fixed place rather than at a flag, so it gets a copy
  // where it looks. Writing both costs a few hundred bytes in a directory
  // that is about to be deleted.
  const geminiDir = path.join(sandbox, '.gemini');
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(path.join(geminiDir, 'settings.json'), JSON.stringify(config, null, 2), 'utf8');

  return {
    args: build(configPath, server),
    approval: preset ? (APPROVAL[preset]?.() ?? []) : [],
    out,
    // Also on the environment, so a CLI that launches the server some other
    // way — or a person debugging one by hand — does not need the config.
    env: { RMM_TAILOR_SESSION: sessionPath },
  };
}
