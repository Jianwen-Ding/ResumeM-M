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
import { serve } from './protocol.js';
import { TailorSession, type SessionState, type TailorPosting } from './session.js';
import { tailorTools } from './tools.js';
import type { ResolvedResume, StoreData } from '../model/types.js';

export interface SessionFile {
  data: StoreData;
  resume: ResolvedResume;
  posting: TailorPosting;
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

  const session = new TailorSession(file.data, file.resume, file.posting);

  const save = () => {
    try {
      fs.writeFileSync(file.out, JSON.stringify(session.state, null, 2), 'utf8');
    } catch {
      // Nowhere to report it — stdout is the protocol and stderr is the CLI's
      // to interpret. The next call tries again.
    }
  };

  const tools = tailorTools(session).map((tool) => ({
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

  await serve(process.stdin, process.stdout, tools, { name: 'resumem-m-tailor', version: '1' });
  save();
}

/** Nothing decided at all: what the caller sees when the CLI ignored the tools. */
export function readState(out: string): SessionState | null {
  try {
    return JSON.parse(fs.readFileSync(out, 'utf8')) as SessionState;
  } catch {
    return null;
  }
}
