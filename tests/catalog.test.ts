import { test } from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, MENU_SECTIONS } from "../app/components/catalog";
import { MESSAGES } from "../lib/i18n/messages";

/**
 * The menu at the top left lists only what SigPath has: every link must be a
 * page in app/, and every label must exist in both languages.
 */

test("every menu link is a page that exists", () => {
  for (const s of MENU_SECTIONS) {
    for (const l of s.links) {
      const page = join("app", ...l.href.split("/").filter(Boolean), "page.tsx");
      assert.ok(existsSync(page), `${l.href} has no ${page}`);
    }
  }
});

test("every menu label and category has English and German", () => {
  for (const m of Object.values(MESSAGES)) {
    for (const s of MENU_SECTIONS) {
      assert.ok(s.title(m));
      for (const l of s.links) assert.ok(l.label(m), l.href);
    }
    for (const c of CATEGORIES) assert.ok(m.home.categories[c.label], c.label);
  }
});
