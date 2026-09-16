/**
 * Work that takes long enough that you should not have to sit and watch it.
 *
 * An AI critique of a resume can take a minute or three. Holding a dialog open
 * for that is the wrong shape: you asked a question, you should be able to go
 * and do something else, and find the answer waiting when you come back.
 *
 * Deliberately in memory and deliberately small. A job is a request in flight,
 * not a record — anything worth keeping (a letter, an answer) is written to
 * the store by the handler that produced it. A restart losing a pending
 * critique costs one click.
 */

export type JobStatus = 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  /** What kind of work this is, for the UI to group and label. */
  kind: string;
  /** What it is about, in words: "New grad", "the Kafka bullet". */
  about: string;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
  /** Cleared once the user has seen it. */
  unread: boolean;
}

const MAX_JOBS = 40;

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private seq = 0;

  /**
   * Start `work` and return immediately with the job. The promise is
   * deliberately not returned: a caller that wanted to wait would not be using
   * this.
   */
  start(kind: string, about: string, work: () => Promise<unknown>): Job {
    const job: Job = {
      id: `job-${Date.now().toString(36)}-${++this.seq}`,
      kind,
      about,
      status: 'running',
      startedAt: new Date().toISOString(),
      unread: false,
    };
    this.jobs.set(job.id, job);
    this.prune();

    void work().then(
      (result) => this.finish(job.id, { status: 'done', result }),
      (err: unknown) => this.finish(job.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) }),
    );

    return job;
  }

  private finish(id: string, patch: { status: JobStatus; result?: unknown; error?: string }): void {
    const job = this.jobs.get(id);
    if (!job) return; // pruned while running; nobody is waiting for it
    Object.assign(job, patch, { finishedAt: new Date().toISOString(), unread: true });
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Newest first, which is the order anything reading them wants. */
  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Mark as seen, so the badge stops asking for attention. */
  read(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job) job.unread = false;
    return job;
  }

  dismiss(id: string): boolean {
    return this.jobs.delete(id);
  }

  /** Keep the newest few; a finished critique nobody opened is not precious. */
  private prune(): void {
    if (this.jobs.size <= MAX_JOBS) return;
    const oldestFirst = [...this.jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const job of oldestFirst) {
      if (this.jobs.size <= MAX_JOBS) break;
      if (job.status !== 'running') this.jobs.delete(job.id);
    }
  }
}
