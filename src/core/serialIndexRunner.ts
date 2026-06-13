// Serializes indexing runs with "latest wins" semantics, so changing
// include/exclude (or hitting Rescan) while an index is in flight stops the old
// run and starts fresh instead of running both concurrently.
//
// Each request() (a) signals the in-flight run to cancel (the `cancel` hook),
// (b) waits for the prior run to settle so two runs never write concurrently,
// then (c) runs its task — unless a newer request arrived while it waited, in
// which case it is skipped (only the latest pending task runs). Pure / vscode-free
// so it is headless-testable; the cancel hook does the actual worker-level stop.

export class SerialIndexRunner {
  private gen = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly cancel: () => void) {}

  /**
   * Request a run. Cancels the in-flight run, then runs `task` once the previous
   * one settles. If a newer request arrives first, this one is skipped.
   */
  request(task: () => Promise<void>): Promise<void> {
    const myGen = ++this.gen;
    this.cancel(); // signal whatever is running now to stop
    this.tail = this.tail
      .catch(() => { /* a prior run's failure must not break the chain */ })
      .then(() => {
        if (myGen !== this.gen) {
          return; // a newer request superseded this one while it waited
        }
        return task();
      });
    return this.tail;
  }
}
