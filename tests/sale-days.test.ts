import { test } from "node:test";
import assert from "node:assert";
import { berlinDate, blackFriday, saleDayOn, saleDayPreview } from "../lib/sale-days";

test("Black Friday is the day after the fourth Thursday of November", () => {
  assert.equal(blackFriday(2024), 29);
  assert.equal(blackFriday(2025), 28);
  assert.equal(blackFriday(2026), 27);
  assert.equal(blackFriday(2027), 26);
});

test("the banner shows on 11.11 and through Black Week, and on no other day", () => {
  const on = (m: number, d: number, y = 2026) => saleDayOn(y, m, d)?.id ?? null;
  assert.equal(on(11, 11), "singles-day");
  assert.equal(on(11, 22), null, "the Sunday before Black Week");
  assert.equal(on(11, 23), "black-week", "Monday");
  assert.equal(on(11, 26), "black-week", "Thursday");
  assert.equal(on(11, 27), "black-friday");
  assert.equal(on(11, 29), "black-week", "Sunday");
  assert.equal(on(11, 30), "cyber-monday");
  assert.equal(on(12, 1), null);
  assert.equal(on(10, 10), null, "10.10 is an Asian sale day, not a German one");
  // Cyber Monday can fall in December.
  assert.equal(on(12, 2, 2024), "cyber-monday");
  assert.equal(on(11, 29, 2024), "black-friday");
});

test("every message ends with what to do", () => {
  for (const [m, d] of [[11, 11], [11, 23], [11, 27], [11, 30]]) {
    assert.match(saleDayOn(2026, m, d)!.message, /Check every deal before you pay\.$/);
  }
});

test("the day is German time, and a preview needs a known sale day", () => {
  // 23:30 UTC on 26 November is already 27 November (Black Friday) in Berlin.
  assert.deepEqual(berlinDate(new Date("2026-11-26T23:30:00Z")), { year: 2026, month: 11, day: 27 });
  assert.equal(saleDayPreview("black-friday")?.id, "black-friday");
  assert.equal(saleDayPreview("toString"), null);
  assert.equal(saleDayPreview(null), null);
});
