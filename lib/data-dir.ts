/**
 * lib/data-dir.ts — where SigPath keeps its files.
 *
 * Only when no shared database is configured: with one (lib/kv/upstash.ts),
 * every record and log lives there instead (lib/kv/table.ts,
 * lib/checkout/encrypted-store.ts). Locally: ./.data (gitignored). On Vercel
 * the app directory is read-only and only the temp directory is writable, so
 * it falls back there. That storage is per instance and doesn't survive a
 * redeploy: fine for a demo, not for real records.
 */

import { tmpdir } from "os";
import { join } from "path";

export function dataDir(env: Record<string, string | undefined> = process.env): string {
  return env.DATA_DIR?.trim() || (env.VERCEL ? join(tmpdir(), "sigpath-data") : join(process.cwd(), ".data"));
}
