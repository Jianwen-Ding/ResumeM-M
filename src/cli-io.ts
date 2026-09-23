/**
 * Writing to a reader that has already left.
 *
 * `rmm build --all | head -1`, `rmm track | less` and then `q` — every one of
 * these is a reader closing its end of the pipe before this program is done
 * writing to it, and every one of them is normal. Node disagrees: a write
 * after the reader has hung up raises EPIPE, and a stream with nothing
 * listening for its `error` event turns that into an uncaught exception. On a
 * real store, `rmm build --all` piped to `head -1` printed the first resume
 * correctly and then crashed with a raw Node stack trace and exit code 1 — a
 * build that had mostly worked, reported as though it had not run at all.
 *
 * Attached once, to stdout and stderr both, because either can be the one
 * that is piped. Anything other than EPIPE is a real error and still needs to
 * be seen, so this is narrow: swallow exactly that code, nothing else.
 */
export function ignoreBrokenPipe(stream: { on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): void }): void {
  stream.on('error', (err) => {
    if (err.code !== 'EPIPE') throw err;
  });
}
