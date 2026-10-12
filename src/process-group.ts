import { execFile, spawn, type ChildProcess } from 'node:child_process';

/**
 * A command with a time limit that reaches everything it started.
 *
 * `execFile`'s `timeout` signals the direct child and nothing else. That is
 * enough for a binary, and not for the shape these commands usually have on
 * someone's machine: `latexmk` is a Perl script that runs `pdflatex`, and an
 * AI CLI is as often as not a wrapper script that runs the real one without
 * `exec`, so the shell stays its parent. The wrapper died at the timeout, the
 * caller was told the run had timed out — and the real CLI carried on
 * thinking, unattached and unseen, until it finished on its own. Measured
 * with a wrapper around a sixty-second CLI and a four-second timeout: the 502
 * came back at four seconds and the CLI was still running at twenty, holding
 * whatever a model run holds.
 *
 * So, outside Windows, the command starts in a process group of its own, and
 * both signals go to the group: SIGTERM at `timeout`, and SIGKILL `graceMs`
 * after that for anything that would not take the first. The same thing
 * `gitWithin` in `git/repo.ts` does for git's transport helper. Windows has no
 * process groups to signal, and keeps what it had: `execFile`'s own timeout,
 * then a SIGKILL to the child.
 *
 * The forced kill stays armed once the polite one has been sent, even if the
 * call settles first. A wrapper that exits on SIGTERM settles the call; a CLI
 * under it that traps SIGTERM and let go of the pipes would not, and is the
 * one the second signal is for. `unref` so that timer is never what keeps the
 * process up.
 *
 * A timeout is reported the way `execFile` reports its own — `killed: true`
 * and the signal on the error — because that is what the callers read to say
 * "it ran out of time" rather than "it failed". A signal sent to the group
 * does not set `child.killed`, which is where `execFile` gets it from.
 *
 * The promise carries `child`, like `promisify(execFile)`'s does, for callers
 * that write to stdin or watch the output as it comes.
 */
export interface TimedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer?: number;
  /** How long after the SIGTERM the SIGKILL follows. */
  graceMs: number;
}

export type TimedRun = Promise<{ stdout: string; stderr: string }> & { child: ChildProcess };

export function runInGroup(cmd: string, args: string[], opts: TimedOptions): TimedRun {
  if (process.platform === 'win32') return runAlone(cmd, args, opts);

  let timedOut = false;
  let settled = false;
  let polite: NodeJS.Timeout | undefined;
  let forced: NodeJS.Timeout | undefined;
  /*
   * `spawn` rather than `execFile`, because `execFile` does not pass
   * `detached` on to the spawn it makes. What `execFile` did besides — collect
   * both streams up to `maxBuffer`, settle on `close`, and reject with
   * `code`, `signal`, `stdout` and `stderr` on the error — is done here.
   */
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: 'pipe' });
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // The group is already gone, which is the outcome this wanted.
    }
  };

  const done = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const max = opts.maxBuffer ?? 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let overflow: Error | undefined;
    const collect = (which: 'stdout' | 'stderr') => (chunk: string) => {
      if (overflow) return;
      const now = (which === 'stdout' ? stdout : stderr) + chunk;
      if (now.length > max) {
        overflow = Object.assign(new RangeError(`${which} maxBuffer length exceeded`), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
        signal('SIGTERM');
      }
      if (which === 'stdout') stdout = now.slice(0, max);
      else stderr = now.slice(0, max);
    };
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', collect('stdout'));
    child.stderr!.on('data', collect('stderr'));

    const settle = (err: (Error & { code?: unknown; signal?: unknown }) | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(polite);
      if (!timedOut) clearTimeout(forced);
      if (!err) {
        resolve({ stdout, stderr });
        return;
      }
      if (timedOut) Object.assign(err, { killed: true, signal: err.signal ?? 'SIGTERM' });
      reject(Object.assign(err, { stdout, stderr }));
    };
    child.once('error', (err) => settle(err));
    child.once('close', (code, sig) => {
      if (overflow) return settle(overflow);
      if (code === 0 && !timedOut) return settle(undefined);
      const err = new Error(`Command failed: ${[cmd, ...args].join(' ')}\n${stderr}`);
      settle(Object.assign(err, { code, signal: sig }));
    });
  });

  polite = setTimeout(() => {
    timedOut = true;
    signal('SIGTERM');
  }, opts.timeout);
  forced = setTimeout(() => signal('SIGKILL'), opts.timeout + opts.graceMs);
  forced.unref?.();

  return Object.assign(done, { child });
}

/**
 * Windows, as it was: `execFile`'s own timeout for the polite signal, and a
 * SIGKILL to the child for the forced one.
 */
function runAlone(cmd: string, args: string[], opts: TimedOptions): TimedRun {
  let child!: ChildProcess;
  const done = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeout, maxBuffer: opts.maxBuffer, encoding: 'utf8' },
      (err, stdout, stderr) => {
        clearTimeout(forced);
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
  });
  const forced = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone, which is the outcome this wanted.
    }
  }, opts.timeout + opts.graceMs);
  forced.unref?.();
  return Object.assign(done, { child });
}
