import { test } from "node:test";
import assert from "node:assert";
import type Anthropic from "@anthropic-ai/sdk";
import { ChatRequest, runAssistant, type AssistantEvent } from "../lib/assistant/assistant";
import { anthropicModel, assistantConfig, openAICompatModel, type StreamingClient } from "../lib/assistant/models";
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
  await runAssistant(ask("used ThinkPad X1 under 200"), (e) => events.push(e), { model: anthropicModel(client), search: demoSearch });

  assert.deepStrictEqual(events.map((e) => e.type), ["searching", "results", "text", "text", "done"]);
  // The stand-in reply never mentions the flagged bait, so the server adds the warning itself.
  const warned = events.at(-2);
  assert.ok(warned && warned.type === "text" && warned.text.includes("Heads up") && warned.text.includes("Look closer"));
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
  await runAssistant(ask("hi"), (e) => events.push(e), { model: anthropicModel(client), search: async (q) => (searched++, demoSearch(q)) });
  assert.strictEqual(searched, 0);
  const block = (calls[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0];
  assert.strictEqual(block.is_error, true);
  assert.ok(!events.some((e) => e.type === "results"));
});

test("assistant: never searches forever; the last round must answer in words", async () => {
  const { client, calls } = fakeClient([toolUse({ query: "mug" })]);
  await runAssistant(ask("mug"), () => {}, { model: anthropicModel(client), search: demoSearch });
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(calls[3].tool_choice, { type: "none" });
  assert.deepStrictEqual(calls[0].tool_choice, { type: "auto" });
});

test("assistant: a refusal gets a polite redirect", async () => {
  const { client } = fakeClient([{ stop_reason: "refusal", content: [] }]);
  const events: AssistantEvent[] = [];
  await runAssistant(ask("something off-topic"), (e) => events.push(e), { model: anthropicModel(client), search: demoSearch });
  assert.ok(events.some((e) => e.type === "text" && e.text.includes("find a product")));
  assert.strictEqual(events.at(-1)!.type, "done");
});

test("assistant: uses the configured model, else the default", async () => {
  const { client, calls } = fakeClient([say("ok")]);
  await runAssistant(ask("x"), () => {}, { model: anthropicModel(client, "claude-sonnet-5-5"), search: demoSearch });
  await runAssistant(ask("x"), () => {}, { model: anthropicModel(client), search: demoSearch });
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

// --- the OpenAI-compatible adapter (Ollama, Gemini, OpenAI) --------------------------

/** A fake chat-completions server: answers each call with the next SSE script. */
function fakeOpenAI(scripts: object[][]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const chunks = scripts[Math.min(bodies.length - 1, scripts.length - 1)];
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}
const delta = (d: object, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });

test("openai adapter: assembles a streamed tool call, runs the search, then streams the answer", async () => {
  const { fetchImpl, bodies } = fakeOpenAI([
    [
      delta({ tool_calls: [{ index: 0, id: "call_a", function: { name: "search_deals", arguments: '{"query":"ThinkPad X1",' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"condition":"used","max_price":200}' } }] }, "tool_calls"),
    ],
    [delta({ content: "Top pick: " }), delta({ content: "the used one." }, "stop")],
  ]);
  const model = openAICompatModel({ baseUrl: "http://localhost:11434/v1/", model: "qwen2.5:7b", fetchImpl });
  const events: AssistantEvent[] = [];
  await runAssistant(ask("used ThinkPad X1 under 200"), (e) => events.push(e), { model, search: demoSearch });

  assert.deepStrictEqual(events.map((e) => e.type), ["searching", "results", "text", "text", "text", "done"]);
  const results = events.find((e) => e.type === "results");
  assert.ok(results && results.type === "results");
  for (const c of results.results.shown) assert.ok(c.condition === "used" && total(c.total) <= 200);
  assert.ok((events.at(-2) as { text: string }).text.startsWith("\n\nHeads up"));

  // Request shape: system first, tools as functions; the second call carries the tool result.
  assert.strictEqual(bodies[0].model, "qwen2.5:7b");
  assert.strictEqual(bodies[0].messages[0].role, "system");
  assert.strictEqual(bodies[0].tools[0].function.name, "search_deals");
  assert.strictEqual(bodies[0].tool_choice, "auto");
  const sent = bodies[1].messages;
  assert.strictEqual(sent.at(-2).tool_calls[0].id, "call_a");
  assert.strictEqual(sent.at(-1).role, "tool");
  assert.strictEqual(sent.at(-1).tool_call_id, "call_a");
  assert.ok(sent.at(-1).content.includes('"query":"ThinkPad X1"'));
});

test("openai adapter: unparseable tool arguments become an error result, not a search", async () => {
  const { fetchImpl, bodies } = fakeOpenAI([
    [delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "search_deals", arguments: "{not json" } }] }, "tool_calls")],
    [delta({ content: "What product are you after?" }, "stop")],
  ]);
  const events: AssistantEvent[] = [];
  await runAssistant(ask("hi"), (e) => events.push(e), { model: openAICompatModel({ baseUrl: "http://x/v1", model: "m", fetchImpl }), search: demoSearch });
  assert.ok(!events.some((e) => e.type === "results"));
  assert.match(bodies[1].messages.at(-1).content, /^Error:/);
});

test("openai adapter: a model that keeps calling tools is stopped, and still answers", async () => {
  const { fetchImpl, bodies } = fakeOpenAI([[delta({ tool_calls: [{ index: 0, id: "c", function: { name: "search_deals", arguments: '{"query":"mug"}' } }] }, "tool_calls")]]);
  const events: AssistantEvent[] = [];
  await runAssistant(ask("mug"), (e) => events.push(e), { model: openAICompatModel({ baseUrl: "http://x/v1", model: "m", fetchImpl }), search: demoSearch });
  assert.strictEqual(bodies.length, 4);
  assert.strictEqual(bodies[3].tool_choice, "none");
  assert.strictEqual(events.filter((e) => e.type === "searching").length, 3, "the last round's call is not run");
  assert.ok(events.some((e) => e.type === "text" && e.text === "Here's what I found."));
});

test("openai adapter: sends the API key only when configured, and fails loudly on HTTP errors", async () => {
  let auth: string | null = "unset";
  const ok = (async (_u: string, init: RequestInit) => {
    auth = new Headers(init.headers).get("authorization");
    return new Response("data: [DONE]\n\n", { status: 200 });
  }) as unknown as typeof fetch;
  const turn = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], allowTools: true, onText: () => {} };
  await openAICompatModel({ baseUrl: "http://x/v1", model: "m", fetchImpl: ok }).turn(turn);
  assert.strictEqual(auth, null);
  await openAICompatModel({ baseUrl: "http://x/v1", model: "m", apiKey: "k", fetchImpl: ok }).turn(turn);
  assert.strictEqual(auth, "Bearer k");
  const down = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(openAICompatModel({ baseUrl: "http://x/v1", model: "m", fetchImpl: down }).turn(turn), /502/);
});

test("config: picks the provider from the environment", () => {
  assert.strictEqual(assistantConfig({}), null);
  assert.deepStrictEqual(assistantConfig({ ANTHROPIC_API_KEY: "k" }), { provider: "anthropic", model: "claude-opus-5-5" });
  assert.deepStrictEqual(assistantConfig({ ASSISTANT_PROVIDER: "ollama", ANTHROPIC_API_KEY: "k" }), { provider: "ollama", model: "qwen2.5:7b", baseUrl: "http://localhost:11434/v1" });
  assert.deepStrictEqual(assistantConfig({ ASSISTANT_PROVIDER: "ollama", OLLAMA_HOST: "http://gpu:11434/", ASSISTANT_MODEL: "qwen3:8b" }), { provider: "ollama", model: "qwen3:8b", baseUrl: "http://gpu:11434/v1" });
  assert.strictEqual(assistantConfig({ ASSISTANT_PROVIDER: "openai", ASSISTANT_MODEL: "gemini-2.5-flash" }), null, "openai needs a base URL");
  assert.deepStrictEqual(assistantConfig({ ASSISTANT_PROVIDER: "openai", ASSISTANT_BASE_URL: "https://g/v1", ASSISTANT_MODEL: "m", ASSISTANT_API_KEY: "k" }), { provider: "openai", model: "m", baseUrl: "https://g/v1", apiKey: "k" });
  assert.strictEqual(assistantConfig({ ASSISTANT_PROVIDER: "anthropic" }), null, "anthropic needs its key");
});

test("search tool: when nothing matches, the closest real options come back, never a flagged one", async () => {
  const all = await demoSearch("AirPods Pro");
  const r = filterResults(SearchInput.parse({ query: "AirPods Pro", max_price: 5 }), all);
  assert.strictEqual(r.matched, 0);
  assert.ok(r.closest.length > 0 && r.closest.length <= 2);
  for (const c of r.closest) assert.notStrictEqual(c.verdict, "caution");
  assert.strictEqual(r.closest[0].verdict, "checked");
  // Closest still honours every preference except the price.
  const used = filterResults(SearchInput.parse({ query: "AirPods Pro", max_price: 5, condition: "used" }), all);
  for (const c of used.closest) assert.strictEqual(c.condition, "used");
  // Offered when only flagged listings matched, and empty whenever there is a safe pick.
  const onlyFlagged = filterResults(SearchInput.parse({ query: "ThinkPad", condition: "new", max_price: 130 }), await demoSearch("ThinkPad"));
  if (onlyFlagged.shown.every((c) => c.verdict === "caution")) assert.ok(onlyFlagged.closest.length > 0);
  assert.deepStrictEqual(filterResults(SearchInput.parse({ query: "AirPods Pro" }), all).closest, []);
});

test("assistant: no extra warning when the reply already names the flagged listing", async () => {
  const bait = filterResults(SearchInput.parse({ query: "ThinkPad X1", condition: "used" }), await demoSearch("ThinkPad X1")).shown.find((c) => c.verdict === "caution");
  assert.ok(bait, "the demo feed has a flagged used listing");
  const { client } = fakeClient([toolUse({ query: "ThinkPad X1", condition: "used" }), say(`Avoid the one at ${bait.total}: it is flagged.`)]);
  const events: AssistantEvent[] = [];
  await runAssistant(ask("cheapest used ThinkPad X1"), (e) => events.push(e), { model: anthropicModel(client), search: demoSearch });
  assert.ok(!events.some((e) => e.type === "text" && e.text.includes("Heads up")));
});

test("search tool: accessories and for-parts units are never picks", async () => {
  const r = filterResults(SearchInput.parse({ query: "ThinkPad X1", condition: "used" }), await demoSearch("ThinkPad X1"));
  assert.ok(!r.shown.some((c) => /for parts|Charger for/.test(c.title)), JSON.stringify(r.shown.map((c) => c.title)));
  assert.ok(r.shown.some((c) => c.verdict === "checked"));
});
