import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

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

/*
 * The groups still running, for this process to take with it when it goes.
 *
 * A group of its own is also a group the terminal does not reach. Ctrl-C on
 * `rmm serve` sends SIGINT to the foreground job's group, which is the
 * server's, and the AI CLI or `latexmk` it had started was in another one: the
 * server died at once and the run carried on with nobody to read it, until it
 * finished on its own. Measured with a `sleep 300` under `sh`: the server gone,
 * the sleep reparented to init and still there.
 *
 * So each group is noted while it runs, and SIGINT, SIGTERM and SIGHUP send
 * SIGTERM to every one still noted, wait up to `SIGNAL_GRACE_MS` for them to
 * go, and SIGKILL what is left. SIGTERM alone was sent and the process went
 * on to die at once, and a CLI that traps SIGTERM — as one that wants to tidy
 * up before it stops will — carried on, reparented to init, with nothing left
 * to send the second signal: the forced kill a timeout arms is a timer in
 * this process. The wait is a timer that is not `unref`'d, polling until the
 * groups are gone, because an `unref`'d one is exactly what does not keep the
 * process up long enough to fire. The process exiting any other way — where
 * nothing can wait — sends SIGKILL straight away.
 *
 * After that a signal is let do what it did before: the handler takes itself
 * off and the signal is sent again, so the process dies of it with the same
 * exit status a shell reads as "interrupted" — unless something else in the
 * process listens for it too, in which case that listener decides, as it did.
 * A second Ctrl-C during the wait does not wait any longer.
 *
 * Installed the first time a group is started, not on import: a handler for
 * SIGINT changes what Ctrl-C does to any process that loads this module, and
 * one that never runs a command should not be touched.
 *
 * `noteGroup` is for a detached group started anywhere else — the model
 * picker's `script` terminal in ai/models.ts is one — so that it goes too.
 */
const liveGroups = new Set<number>();
let handlersInstalled = false;
let ending = false;

/** How long a signal waits for the groups it sent SIGTERM to, before SIGKILL. */
export const SIGNAL_GRACE_MS = 1_500;

function signalGroups(sig: NodeJS.Signals): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, sig);
    } catch {
      // Already gone, which is the outcome this wanted.
      liveGroups.delete(pid);
    }
  }
}

/* Whether anything of the group is left that is not a zombie: one is gone, only waiting to be reaped. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
  } catch {
    return false;
  }
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      } catch {
        continue;
      }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // state, ppid, pgrp
      if (Number(fields[2]) === pid && fields[0] !== 'Z') return true;
    }
    return false;
  } catch {
    // No /proc to read (macOS): the signal's answer is the one there is.
    return true;
  }
}

function killLiveGroups(): void {
  signalGroups('SIGKILL');
  liveGroups.clear();
}

function installGroupCleanup(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', killLiveGroups);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    let waiting: NodeJS.Timeout | undefined;
    const finish = () => {
      if (waiting) clearInterval(waiting);
      waiting = undefined;
      killLiveGroups();
      ending = false;
      process.removeListener(sig, onSignal);
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    const onSignal = () => {
      if (ending) {
        // Asked again while waiting: no more waiting.
        if (waiting) finish();
        return;
      }
      ending = true;
      signalGroups('SIGTERM');
      if (![...liveGroups].some(groupAlive)) return finish();
      const until = Date.now() + SIGNAL_GRACE_MS;
      waiting = setInterval(() => {
        if (Date.now() >= until || ![...liveGroups].some(groupAlive)) finish();
      }, 25);
    };
    process.on(sig, onSignal);
  }
}

/** Note a detached group started elsewhere, for the signals above to reach. */
export function noteGroup(pid: number | undefined): void {
  if (!pid || process.platform === 'win32') return;
  installGroupCleanup();
  liveGroups.add(pid);
}

/** And forget it once it is over. */
export function forgetGroup(pid: number | undefined): void {
  if (pid) liveGroups.delete(pid);
}

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
  const group = child.pid;
  if (group) {
    installGroupCleanup();
    liveGroups.add(group);
  }
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
      /*
       * Forgotten once it is over — but a group that was sent SIGTERM for
       * running out of time stays noted until the forced kill, which is for
       * what under it would not stop.
       */
      if (!timedOut) {
        clearTimeout(forced);
        if (group) liveGroups.delete(group);
      }
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
  forced = setTimeout(() => {
    signal('SIGKILL');
    if (group) liveGroups.delete(group);
  }, opts.timeout + opts.graceMs);
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
