/**
 * A small per-client limit on assistant turns.
 *
 * Every turn costs a model call, and the assistant needs no account, so
 * without a limit one script could run up the bill. In memory, per instance:
 * enough for a single server; a multi-instance deployment wants a shared store.
 */

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit and says whether it is allowed. */
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(now);
    return true;
  }

  private sweep(now: number) {
    for (const [k, ts] of this.hits) if (ts.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
  }
}
