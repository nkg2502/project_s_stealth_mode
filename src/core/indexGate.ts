// A tiny concurrency barrier that lets navigation queries (Go to Definition,
// fuzzy search, the Code Insight view) briefly wait out an in-flight reindex so
// they read fresh results instead of pre-update ones. Pure (no vscode), so it is
// headless-testable.
//
// The contract is intentionally minimal: indexing paths bracket their work with
// begin()/end() (or track()), and readers `await whenIdle(timeoutMs)` before
// querying. When nothing is indexing, whenIdle resolves immediately — so there is
// zero added latency in the common case; deferral only kicks in during an active
// reindex, and a timeout guarantees the UI never hangs on a slow one.

export class IndexGate {
  private active = 0;
  private waiters: Array<() => void> = [];

  /** Called on the 0→1 (busy) and 1→0 (idle) transitions only. */
  onChange?: (busy: boolean) => void;

  /** Whether any indexing op is currently in flight. */
  get busy(): boolean {
    return this.active > 0;
  }

  begin(): void {
    this.active++;
    if (this.active === 1) {
      this.onChange?.(true);
    }
  }

  end(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) {
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) {
        resolve();
      }
      this.onChange?.(false);
    }
  }

  /**
   * Resolve once indexing is idle, or after `timeoutMs` — whichever comes first.
   * Resolves immediately when already idle, or when `timeoutMs <= 0` (deferral
   * disabled) regardless of busy state.
   */
  whenIdle(timeoutMs: number): Promise<void> {
    if (!this.busy || timeoutMs <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      this.waiters.push(finish);
      setTimeout(finish, timeoutMs);
    });
  }

  /** Bracket an indexing op with begin()/end(). */
  async track<T>(p: Promise<T>): Promise<T> {
    this.begin();
    try {
      return await p;
    } finally {
      this.end();
    }
  }
}
