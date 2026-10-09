/**
 * lib/kv/upstash.ts — the shared Redis database (Upstash), over its REST API.
 *
 * WHY
 * On Vercel each request may run in a different short-lived instance, and its
 * disk is temporary: a delivery address written to a file at checkout would be
 * gone, or on another machine, by the time the operator looks for it. One
 * shared database fixes that. Upstash speaks Redis over plain HTTPS, so this is
 * a few lines of fetch rather than a driver with a connection pool.
 *
 * Configured by KV_REST_API_URL + KV_REST_API_TOKEN (the names Vercel's Upstash
 * integration sets) or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 *
 * Errors name the command and status only, never the arguments: those are
 * encrypted records, but an error message is still the wrong place for them.
 */

type Arg = string | number;

export interface Kv {
  command<T = unknown>(args: Arg[]): Promise<T>;
  pipeline(commands: Arg[][]): Promise<unknown[]>;
}

export class UpstashKv implements Kv {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Null when no database is configured: callers fall back to local files. */
  static fromEnv(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): UpstashKv | null {
    // Copied values often keep their quotes ("https://..."); dotenv strips them, other loaders may not.
    const clean = (v?: string) => v?.trim().replace(/^(["'])(.*)\1$/, "$2").trim() || undefined;
    const url = clean(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL)?.replace(/\/+$/, "");
    const token = clean(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN);
    if (!url || !token) return null;
    try {
      if (new URL(url).protocol !== "https:") return null;
    } catch {
      return null;
    }
    return new UpstashKv(url, token, fetchImpl);
  }

  /**
   * Read your own writes. Upstash may answer a read from a copy that hasn't
   * caught up with a write made a moment ago (seen once: a record written and
   * immediately read back came back empty). Each reply carries a sync token;
   * sending the latest one back makes the next request wait until it has caught up.
   */
  private syncToken: string | null = null;

  private async post(path: string, body: unknown, what: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(this.syncToken ? { "upstash-sync-token": this.syncToken } : {}),
      },
      body: JSON.stringify(body),
      // Never a stored copy: this is the record itself.
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Database ${what} failed (${res.status}).`);
    this.syncToken = res.headers.get("upstash-sync-token") ?? this.syncToken;
    return res.json();
  }

  async command<T = unknown>(args: Arg[]): Promise<T> {
    const body = (await this.post("", args, String(args[0]))) as { result?: T; error?: string };
    if (body.error !== undefined) throw new Error(`Database ${args[0]} failed.`);
    return body.result as T;
  }

  async pipeline(commands: Arg[][]): Promise<unknown[]> {
    if (!commands.length) return [];
    const body = (await this.post("/pipeline", commands, "pipeline")) as { result?: unknown; error?: string }[];
    return body.map((r, i) => {
      if (r.error !== undefined) throw new Error(`Database ${commands[i][0]} failed.`);
      return r.result;
    });
  }
}
