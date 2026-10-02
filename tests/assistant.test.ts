import { test } from "node:test";
import assert from "node:assert";
import type Anthropic from "@anthropic-ai/sdk";
import { ChatRequest, runAssistant, type AssistantEvent, type StreamingClient } from "../lib/assistant/assistant";
import { SearchInput, filterResults } from "../lib/assistant/search-tool";
import { RateLimiter } from "../lib/assistant/rate-limit";
import { withLabels } from "../lib/marketplace/label";
import { searchAll } from "../lib/marketplace/search";
import { StubSource } from "../lib/marketplace/sources/stub";

/** The real search and verdicts over the demo feed (which always contains bait). */
const demoSearch = async (q: string) => withLabels(await searchAll(q, [new StubSource()], { limit: 20 }));
const total = (s: string) => Number(s.split(" ")[0]);

// --- the search tool -------------------------------------------------------

test("search tool: picks are never flagged, and the cheapest flagged one comes last as a warning", async () => {
  const r = filterResults(SearchInput.parse({ query: "ThinkPad X1" }), await demoSearch("ThinkPad X1"));
  const picks = r.shown.filter((c) => c.verdict !== "caution");
  assert.ok(picks.length > 0 && picks.length <= 5);
  assert.strictEqual(picks[0].verdict, "checked", "a checked listing leads");
  const flagged = r.shown.filter((c) => c.verdict === "caution");
  assert.strictEqual(flagged.length, 1);
  assert.strictEqual(r.shown[r.shown.length - 1].verdict, "caution");
  for (let i = 1; i < picks.length; i++) {
    if (picks[i].verdict === picks[i - 1].verdict) assert.ok(total(picks[i].total) >= total(picks[i - 1].total), "cheapest first");
  }
});

test("search tool: budget, condition and checked-only all apply", async () => {
  const all = await demoSearch("ThinkPad X1");
  const r = filterResults(SearchInput.parse({ query: "ThinkPad X1", condition: "used", max_price: 200, checked_only: true }), all);
  assert.ok(r.matched < r.found);
  for (const c of r.shown) {
    assert.strictEqual(c.condition, "used");
    assert.ok(total(c.total) <= 200);
    assert.strictEqual(c.verdict, "checked");
  }
  assert.strictEqual(r.seeAll, "/search?q=ThinkPad%20X1");
});

test("search tool: an impossible budget matches nothing, and says how many were found", async () => {
  const r = filterResults(SearchInput.parse({ query: "ThinkPad X1", max_price: 1 }), await demoSearch("ThinkPad X1"));
  assert.strictEqual(r.matched, 0);
  assert.deepStrictEqual(r.shown, []);
  assert.ok(r.found > 0);
});

test("search tool: bad parameters are rejected before any search", () => {
  assert.strictEqual(SearchInput.safeParse({ query: "" }).success, false);
  assert.strictEqual(SearchInput.safeParse({ query: "x", condition: "broken" }).success, false);
  assert.strictEqual(SearchInput.safeParse({ query: "x", marketplaces: ["aliexpress"] }).success, false);
  assert.strictEqual(SearchInput.parse({ query: "x", currency: "eur" }).currency, "EUR");
});

// --- the conversation loop, with a stand-in for Claude ----------------------

function fakeClient(replies: Partial<Anthropic.Message>[]) {
  const calls: Anthropic.MessageStreamParams[] = [];
  const client: StreamingClient = {
    messages: {
      stream(params) {
        calls.push(structuredClone(params));
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
        const text = (reply.content ?? []).filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");
        return {
          on(_event: "text", listener: (t: string) => void) {
            if (text) listener(text);
          },
          finalMessage: async () => reply as Anthropic.Message,
        };
      },
    },
  };
  return { client, calls };
}

const toolUse = (input: unknown, id = "tu_1"): Partial<Anthropic.Message> => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id, name: "search_deals", input } as Anthropic.ToolUseBlock],
});
const say = (text: string): Partial<Anthropic.Message> => ({ stop_reason: "end_turn", content: [{ type: "text", text } as Anthropic.TextBlock] });
const ask = (content: string) => ChatRequest.parse({ messages: [{ role: "user", content }] });

test("assistant: searches with the shopper's preferences, shows cards, then answers", async () => {
  const { client, calls } = fakeClient([toolUse({ query: "ThinkPad X1", condition: "used", max_price: 200 }), say("Top pick: the used one.")]);
  const events: AssistantEvent[] = [];
  await runAssistant(ask("used ThinkPad X1 under 200"), (e) => events.push(e), { client, search: demoSearch });

  assert.deepStrictEqual(events.map((e) => e.type), ["searching", "results", "text", "done"]);
  const results = events.find((e) => e.type === "results");
  assert.ok(results && results.type === "results");
  for (const c of results.results.shown) assert.ok(c.condition === "used" && total(c.total) <= 200);

  // The second call carries the search result back to the model.
  assert.strictEqual(calls.length, 2);
  const last = calls[1].messages[calls[1].messages.length - 1];
  assert.strictEqual(last.role, "user");
  const block = (last.content as Anthropic.ToolResultBlockParam[])[0];
  assert.strictEqual(block.type, "tool_result");
  assert.strictEqual(block.tool_use_id, "tu_1");
  assert.ok(String(block.content).includes('"query":"ThinkPad X1"'));
});

test("assistant: invalid tool input becomes an error result, not a search", async () => {
  const { client, calls } = fakeClient([toolUse({ query: "" }), say("Could you tell me the product?")]);
  let searched = 0;
  const events: AssistantEvent[] = [];
  await runAssistant(ask("hi"), (e) => events.push(e), { client, search: async (q) => (searched++, demoSearch(q)) });
  assert.strictEqual(searched, 0);
  const block = (calls[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0];
  assert.strictEqual(block.is_error, true);
  assert.ok(!events.some((e) => e.type === "results"));
});

test("assistant: never searches forever; the last round must answer in words", async () => {
  const { client, calls } = fakeClient([toolUse({ query: "mug" })]);
  await runAssistant(ask("mug"), () => {}, { client, search: demoSearch });
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(calls[3].tool_choice, { type: "none" });
  assert.deepStrictEqual(calls[0].tool_choice, { type: "auto" });
});

test("assistant: a refusal gets a polite redirect", async () => {
  const { client } = fakeClient([{ stop_reason: "refusal", content: [] }]);
  const events: AssistantEvent[] = [];
  await runAssistant(ask("something off-topic"), (e) => events.push(e), { client, search: demoSearch });
  assert.ok(events.some((e) => e.type === "text" && e.text.includes("find a product")));
  assert.strictEqual(events.at(-1)!.type, "done");
});

test("assistant: uses the configured model, else the default", async () => {
  const { client, calls } = fakeClient([say("ok")]);
  await runAssistant(ask("x"), () => {}, { client, search: demoSearch, model: "claude-sonnet-5-5" });
  await runAssistant(ask("x"), () => {}, { client, search: demoSearch });
  assert.strictEqual(calls[0].model, "claude-sonnet-5-5");
  assert.strictEqual(calls[1].model, "claude-opus-5-5");
});

// --- the request and the limiter ----------------------------------------------

test("chat request: turns alternate from the shopper, end with the shopper, and are bounded", () => {
  const u = (content: string) => ({ role: "user", content });
  const a = (content: string) => ({ role: "assistant", content });
  assert.ok(ChatRequest.safeParse({ messages: [u("hi"), a("hello"), u("mug")] }).success);
  assert.strictEqual(ChatRequest.safeParse({ messages: [a("hello")] }).success, false);
  assert.strictEqual(ChatRequest.safeParse({ messages: [u("a"), u("b")] }).success, false);
  assert.strictEqual(ChatRequest.safeParse({ messages: [u("hi"), a("hello")] }).success, false);
  assert.strictEqual(ChatRequest.safeParse({ messages: [u("x".repeat(2001))] }).success, false);
  assert.strictEqual(ChatRequest.safeParse({ messages: [] }).success, false);
});

test("rate limiter: allows up to the limit per window, per client", () => {
  const rl = new RateLimiter(2, 1000);
  assert.ok(rl.allow("a", 0));
  assert.ok(rl.allow("a", 10));
  assert.strictEqual(rl.allow("a", 20), false);
  assert.ok(rl.allow("b", 20), "another client is unaffected");
  assert.ok(rl.allow("a", 1011), "the window slides");
});
