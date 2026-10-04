/**
 * lib/data-dir.ts — where SigPath keeps its files.
 *
 * Locally: ./.data (gitignored). On Vercel the app directory is read-only and
 * only the temp directory is writable, so it falls back there. That storage is
 * per instance and doesn't survive a redeploy: fine for a demo, not for real
 * orders. Set DATA_DIR to a persistent disk for that.
 */

import { tmpdir } from "os";
import { join } from "path";

export function dataDir(env: Record<string, string | undefined> = process.env): string {
  return env.DATA_DIR?.trim() || (env.VERCEL ? join(tmpdir(), "sigpath-data") : join(process.cwd(), ".data"));
}
