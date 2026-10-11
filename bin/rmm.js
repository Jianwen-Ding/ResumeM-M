#!/usr/bin/env node
// Thin launcher so `rmm` works without a build step: run the compiled CLI when
// `npm run build` has been run, and fall back to tsx during development.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiled = path.join(root, 'dist', 'src', 'cli.js');
const args = process.argv.slice(2);

/*
 * The checkout's own tsx, not `npx tsx`. npx looked tsx up from wherever the
 * command was typed — another project's, or a download it went and fetched —
 * and put a process of its own between this one and the CLI, so a signal
 * sent here never reached the server doing the work.
 */
const windows = process.platform === 'win32';
const tsx = path.join(root, 'node_modules', '.bin', windows ? 'tsx.cmd' : 'tsx');
if (!existsSync(compiled) && !existsSync(tsx)) {
  console.error(`rmm: no build in ${path.join(root, 'dist')} and no tsx in ${path.dirname(tsx)}. Run \`npm install\` in ${root}.`);
  process.exit(1);
}

const child = existsSync(compiled)
  ? spawn(process.execPath, [compiled, ...args], { stdio: 'inherit' })
  : windows
    ? spawn(tsx, [path.join(root, 'src', 'cli.ts'), ...args], { stdio: 'inherit', shell: true })
    : spawn(process.execPath, [tsx, path.join(root, 'src', 'cli.ts'), ...args], { stdio: 'inherit' });

/*
 * Passed on, so stopping `rmm serve` stops the server. `kill <pid>` from a
 * service manager or a script reaches this process alone, and it used to die
 * and leave the server running on its port with nobody to stop it.
 */
const FORWARDED = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const forward = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
for (const signal of FORWARDED) process.on(signal, forward);

child.on('error', (err) => {
  console.error(`rmm: could not start the CLI: ${err.message}`);
  process.exit(1);
});

/*
 * And a child killed by a signal is a failure, said the way the shell expects
 * it: by dying of the same signal. `code` is null then, and `code ?? 0` turned
 * a server killed out from under it into a clean exit 0.
 */
child.on('exit', (code, signal) => {
  if (signal) {
    for (const s of FORWARDED) process.off(s, forward);
    try {
      process.kill(process.pid, signal);
    } catch {
      // A signal this platform cannot raise on itself.
    }
    // Still here (the signal is ignored or cannot be raised): the shell's number for it.
    const number = constants.signals[signal];
    setTimeout(() => process.exit(number ? 128 + number : 1), 100);
    return;
  }
  process.exit(code ?? 1);
});
