/**
 * The MCP server as a program: read a session off disk, serve it on stdio,
 * write back what was decided.
 *
 * Spawned by whichever coding-agent CLI is running the tailoring pass, not by
 * this application — MCP over stdio means the *client* owns the process. So
 * everything it needs has to be somewhere it can find without arguments,
 * which is what `RMM_TAILOR_SESSION` is: a path to a JSON file in the same
 * scratch directory the CLI itself is confined to.
 *
 * That the whole exchange happens inside one temporary directory is the point.
 * There is no port, no token and no listening socket: two processes and a
 * file, all of it deleted when the run ends.
 *
 * The decisions are written back after every call rather than at the end,
 * because a CLI that is killed — a timeout, a user's ctrl-C, a model that
 * stops mid-sentence — should still leave behind the choices it had already
 * made. Half a tailoring pass is worth considerably more than none.
 */

import fs from 'node:fs';
import { serve, type ToolDefinition } from './protocol.js';
import { TailorSession, type SessionState, type TailorPosting } from './session.js';
import { tailorTools } from './tools.js';
import { WritingSession, type WritingState } from './writing.js';
import { AuthoringSession, type AuthoringState, type SourceDocument } from './authoring.js';
import { authoringTools, writingTools } from './writing-tools.js';
import type { Draft, ResolvedResume, StoreData } from '../model/types.js';

/**
 * Three kinds of session, one server.
 *
 * `kind` decides which set of tools the CLI is handed. One program rather
 * than three because the protocol, the framing, the save-after-every-call and
 * the confinement are identical for all of them — and because a CLI is told
 * about a server once, so three would mean three configs to keep in step.
 *
 * `tailor` is the default so that a session file written before this existed
 * still means what it meant.
 */
export interface SessionFile {
  kind?: 'tailor' | 'write' | 'author';
  data: StoreData;
  resume: ResolvedResume;
  posting: TailorPosting;
  /** For `write`: what the form is asking for. */
  draft?: Pick<Draft, 'coverLetter' | 'questions'>;
  /** For `write`: the resume as text, rendered by the caller. */
  resumeText?: string;
  /** For `author`: the material handed over, and what is already in the store. */
  documents?: SourceDocument[];
  existing?: { entryIds: string[]; bulletIds: string[]; skillGroups: { id: string; name: string }[] };
  /** Where to write what was decided. */
  out: string;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const path = process.env.RMM_TAILOR_SESSION ?? argv[0];
  if (!path) {
    process.stderr.write('RMM_TAILOR_SESSION is not set: there is no tailoring session to serve.\n');
    process.exitCode = 2;
    return;
  }

  let file: SessionFile;
  try {
    file = JSON.parse(fs.readFileSync(path, 'utf8')) as SessionFile;
  } catch (err) {
    process.stderr.write(`Could not read the tailoring session at ${path}: ${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  const { session, tools: toolsFor } = build(file);

  const save = () => {
    try {
      fs.writeFileSync(file.out, JSON.stringify(session.state, null, 2), 'utf8');
    } catch {
      // Nowhere to report it — stdout is the protocol and stderr is the CLI's
      // to interpret. The next call tries again.
    }
  };

  const tools = toolsFor.map((tool) => ({
    ...tool,
    run: async (args: Record<string, unknown>) => {
      const result = await tool.run(args);
      save();
      return result;
    },
  }));

  // An empty state written up front, so a run that is killed before it calls
  // anything is still distinguishable from one that never started.
  save();

  await serve(process.stdin, process.stdout, tools, { name: `resumem-m-${file.kind ?? 'tailor'}`, version: '1' });
  save();
}

/**
 * Which session this file describes, and the tools for it.
 *
 * The one place the three differ. Everything around it — saving after every
 * call, the framing, the empty state written up front — is the same for all
 * three, which is why they share a program.
 */
function build(file: SessionFile): { session: { state: unknown }; tools: ToolDefinition[] } {
  if (file.kind === 'write') {
    const session = new WritingSession(
      file.data,
      file.resume,
      file.posting,
      file.draft ?? { coverLetter: { required: true, body: '' }, questions: [] },
      file.resumeText ?? '',
    );
    return { session, tools: writingTools(session) };
  }
  if (file.kind === 'author') {
    const session = new AuthoringSession(
      file.documents ?? [],
      file.existing ?? { entryIds: [], bulletIds: [], skillGroups: [] },
    );
    return { session, tools: authoringTools(session) };
  }
  const session = new TailorSession(file.data, file.resume, file.posting);
  return { session, tools: tailorTools(session) };
}

/** Nothing decided at all: what the caller sees when the CLI ignored the tools. */
export function readState(out: string): SessionState | WritingState | AuthoringState | null {
  try {
    return JSON.parse(fs.readFileSync(out, 'utf8')) as SessionState;
  } catch {
    return null;
  }
}
