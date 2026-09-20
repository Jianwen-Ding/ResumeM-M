/**
 * What the AI is doing right now, and what it did last time.
 *
 * Every AI run here is a coding-agent CLI in a scratch directory, spoken to
 * over a pipe. `execFile` collects its output and hands it back when it
 * exits — so until it exits there is nothing to see, and if it never exits
 * there is nothing to see at all. What that looks like in use:
 *
 *   The AI could not be started, so nothing was tailored. It said: AI command
 *   "codex" ran for longer than 180s and was stopped. Raise ai.timeoutMs in
 *   config.yaml if it needs longer.
 *
 * Three minutes of silence and then a sentence that cannot tell you the one
 * thing you need to decide what to do: was it working, or was it wedged? A
 * model part-way through a long reasoning pass and a CLI sitting on a prompt
 * it will never answer produce exactly the same message, and the advice —
 * raise the timeout — is right for one and useless for the other.
 *
 * So each run is registered here as it starts, its output is copied through as
 * it arrives, and the record outlives it. `lastOutputAt` is the field that
 * settles the question: a run that printed something four seconds ago is
 * working, and one that has said nothing since it started is not.
 *
 * In memory and bounded, deliberately. This is a window onto a process, not a
 * log: it holds the last few runs and the tail of what each one said, and it
 * is gone when the server stops. Prompts here carry the whole of somebody's
 * resume and a job posting; keeping transcripts of that on disk is a promise
 * this tool has no reason to make.
 */

/** One piece of what a run said, and when it said it. */
export interface AiChunk {
  /** Milliseconds since the run started — the useful clock, not wall time. */
  at: number;
  stream: 'out' | 'err';
  text: string;
}

export interface AiRun {
  id: string;
  command: string;
  /** The argv as given, each argument shortened for display. See `shorten`. */
  args: string[];
  /** How big the prompt was, which the list can show without carrying it. */
  promptBytes: number;
  /**
   * What the model was actually given.
   *
   * The argv says which CLI and which flags; this is the reasoning material —
   * the resume as it stands, the posting, the letters written before, the
   * instructions about voice. When an answer comes back wrong the question is
   * almost always what went in, and there was no way to look.
   *
   * Held only on the detail, never in the list: prompts here run to tens of
   * kilobytes and a list of twenty of them is not a list.
   */
  prompt: string;
  /** Bytes cut out of the middle of `prompt`, if it was longer than the cap. */
  promptCut: number;
  startedAt: number;
  endedAt?: number;
  /** When anything last arrived on either stream; absent until something does. */
  lastOutputAt?: number;
  outcome?: 'ok' | 'failed' | 'timeout';
  /** What the run was stopped or refused with, in this tool's words. */
  note?: string;
  /** Bytes seen, which is not the same as bytes kept. */
  bytes: { out: number; err: number };
  /** Bytes dropped from the front of `chunks` to stay inside the cap. */
  dropped: number;
  chunks: AiChunk[];
}

/** Enough to see what a model is doing, far short of a transcript. */
const KEEP_BYTES = 64 * 1024;
/** Enough to compare this run with the last few, and no more. */
const KEEP_RUNS = 20;

/**
 * An argument long enough to be the prompt is the prompt.
 *
 * Three of the four presets pass it inline — `{promptText}` expands to tens of
 * kilobytes of somebody's resume and the posting they are applying to. Showing
 * that in a list of arguments buries the flags that actually decide what the
 * run does, which is the thing worth looking at.
 */
const shorten = (arg: string): string =>
  arg.length > 200 ? `${arg.slice(0, 200)}… (${arg.length} chars)` : arg;

/**
 * A prompt long enough to need cutting is cut in the middle.
 *
 * The two ends are the parts worth reading: a prompt here opens with what the
 * model is being asked to do and closes with the posting it is being asked to
 * do it against, and the bulk in between is the store — every bullet, every
 * past letter. Truncating the tail would throw away the job; truncating the
 * head would throw away the instructions.
 */
const KEEP_PROMPT = 128 * 1024;

function foldPrompt(prompt: string): { prompt: string; promptCut: number } {
  const size = Buffer.byteLength(prompt);
  if (size <= KEEP_PROMPT) return { prompt, promptCut: 0 };
  const half = Math.floor(KEEP_PROMPT / 2);
  return {
    prompt: `${prompt.slice(0, half)}\n\n… ${size - KEEP_PROMPT} bytes not kept …\n\n${prompt.slice(-half)}`,
    promptCut: size - KEEP_PROMPT,
  };
}

const runs: AiRun[] = [];
let counter = 0;

type Listener = (run: AiRun) => void;
const listeners = new Set<Listener>();

/** Watch every change to any run. Returns a function that stops watching. */
export function watchRuns(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(run: AiRun): void {
  for (const listener of listeners) {
    try {
      listener(run);
    } catch {
      // A watcher that throws is a watcher's problem. The run carries on.
    }
  }
}

/** The handle a caller uses to report on the run it just started. */
export interface RunHandle {
  readonly id: string;
  /** Copy through a piece of what the child said. */
  saw(stream: 'out' | 'err', text: string): void;
  /** The run is over, one way or another. */
  ended(outcome: AiRun['outcome'], note?: string): void;
}

export function startRun(about: {
  command: string;
  args: string[];
  prompt: string;
}): RunHandle {
  counter += 1;
  const folded = foldPrompt(about.prompt);
  const run: AiRun = {
    id: `run-${Date.now().toString(36)}-${counter}`,
    command: about.command,
    args: about.args.map(shorten),
    promptBytes: Buffer.byteLength(about.prompt),
    prompt: folded.prompt,
    promptCut: folded.promptCut,
    startedAt: Date.now(),
    bytes: { out: 0, err: 0 },
    dropped: 0,
    chunks: [],
  };

  runs.push(run);
  while (runs.length > KEEP_RUNS) runs.shift();
  announce(run);

  return {
    id: run.id,
    saw(stream, text) {
      if (!text) return;
      run.bytes[stream] += Buffer.byteLength(text);
      run.lastOutputAt = Date.now();
      run.chunks.push({ at: run.lastOutputAt - run.startedAt, stream, text });

      /*
       * Kept from the end, because the end is where a run explains itself: the
       * error it stopped on, the last thing it managed to say. A cap counted
       * in bytes rather than chunks, since a CLI that prints a spinner emits
       * thousands of tiny writes and one that prints a diff emits three big
       * ones.
       */
      let held = run.chunks.reduce((n, c) => n + Buffer.byteLength(c.text), 0);
      while (held > KEEP_BYTES && run.chunks.length > 1) {
        const gone = run.chunks.shift()!;
        const size = Buffer.byteLength(gone.text);
        held -= size;
        run.dropped += size;
      }
      announce(run);
    },
    /*
     * First call wins. `runAgent` reports the outcome it knows about — a
     * timeout, a CLI that was not there, a clean answer — and its `finally`
     * closes anything that got out of the try another way. Letting the
     * backstop overwrite the diagnosis would lose the only useful half.
     */
    ended(outcome, note) {
      if (run.outcome) return;
      run.endedAt = Date.now();
      run.outcome = outcome;
      run.note = note;
      announce(run);
    },
  };
}

/** Everything still going, newest last. */
export const running = (): AiRun[] => runs.filter((r) => r.endedAt === undefined);

/** Every run held, newest first, which is the order a list wants them in. */
export const recentRuns = (): AiRun[] => [...runs].reverse();

export const findRun = (id: string): AiRun | undefined => runs.find((r) => r.id === id);

/** For tests, and for a save being closed: nothing here belongs to the next one. */
export function forgetRuns(): void {
  runs.length = 0;
}
