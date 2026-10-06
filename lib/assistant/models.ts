/**
 * lib/assistant/models.ts — the language models the shopping assistant can use.
 *
 * The conversation loop (assistant.ts) speaks one neutral format; an adapter
 * per API turns it into that API's messages and back:
 *
 *   anthropic  Claude, through the Anthropic SDK.
 *   openai     Any OpenAI-compatible chat API: Ollama on this machine (free,
 *              offline), Google Gemini, OpenAI, OpenRouter, a remote GPU box.
 *
 * Which one runs is configuration (assistantConfig), never code.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments; null when the model sent something unparseable. */
  input: unknown;
}

export type ChatMsg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface TurnParams {
  system: string;
  messages: ChatMsg[];
  tools: ToolDef[];
  /** False on the last round: the reply must be words, not another search. */
  allowTools: boolean;
  onText: (text: string) => void;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  /** The model declined (a safety refusal or content filter). */
  refused: boolean;
}

export interface ChatModel {
  readonly label: string;
  turn(params: TurnParams): Promise<ModelTurn>;
}

// --- Anthropic -----------------------------------------------------------------

/** The slice of the Anthropic client this needs, so tests can stand in for it. */
export interface StreamingClient {
  messages: {
    stream(params: Anthropic.MessageStreamParams): {
      on(event: "text", listener: (text: string) => void): unknown;
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

function toAnthropic(messages: ChatMsg[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} });
      out.push({ role: "assistant", content: content.length ? content : m.content });
    } else {
      // Consecutive tool results travel together in one user turn.
      const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        (last.content as Anthropic.ToolResultBlockParam[]).push(block);
      } else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

export function anthropicModel(client: StreamingClient, model = DEFAULT_ANTHROPIC_MODEL): ChatModel {
  return {
    label: `anthropic:${model}`,
    async turn({ system, messages, tools, allowTools, onText }) {
      const stream = client.messages.stream({
        model,
        max_tokens: 1024,
        system,
        tools,
        tool_choice: allowTools ? { type: "auto" } : { type: "none" },
        output_config: { effort: "low" },
        messages: toAnthropic(messages),
      });
      stream.on("text", onText);
      const reply = await stream.finalMessage();
      return {
        text: reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
        toolCalls: reply.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [])),
        refused: reply.stop_reason === "refusal",
      };
    },
  };
}

// --- OpenAI-compatible (Ollama, Gemini, OpenAI, OpenRouter) -----------------------

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAI(system: string, messages: ChatMsg[]): OpenAIMessage[] {
  return [
    { role: "system", content: system },
    ...messages.map((m): OpenAIMessage => {
      if (m.role === "user") return { role: "user", content: m.content };
      if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.isError ? `Error: ${m.content}` : m.content };
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {}),
      };
    }),
  ];
}

function parseArgs(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

export interface OpenAICompatOptions {
  /** e.g. http://localhost:11434/v1 for Ollama. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  label?: string;
  fetchImpl?: typeof fetch;
}

/**
 * A model API refusing a request. Carries the HTTP status and the provider's
 * short error code (e.g. NOT_FOUND, API_KEY_INVALID), never the error message,
 * which can quote the request.
 */
export class ModelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`model API answered ${status}${code ? ` ${code}` : ""}`);
    this.name = "ModelApiError";
  }
}

/** The short code from an error body: Gemini nests it in a list, OpenAI does not. */
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as unknown;
    const err = ((Array.isArray(body) ? body[0] : body) as { error?: { status?: unknown; code?: unknown; type?: unknown; details?: { reason?: unknown }[] } })?.error;
    const reason = err?.details?.find((d) => typeof d?.reason === "string")?.reason;
    const code = [reason, err?.status, err?.type, err?.code].find((c) => typeof c === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(c));
    return code as string | undefined;
  } catch {
    return undefined;
  }
}

export function openAICompatModel(opts: OpenAICompatOptions): ChatModel {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    label: opts.label ?? `openai:${opts.model}`,
    async turn({ system, messages, tools, allowTools, onText }) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify({
          model: opts.model,
          stream: true,
          max_tokens: 1024,
          messages: toOpenAI(system, messages),
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
          tool_choice: allowTools ? "auto" : "none",
        }),
      });
      if (!res.ok || !res.body) throw new ModelApiError(res.status, res.ok ? undefined : await errorCode(res));

      // Server-sent events: text arrives in pieces; tool calls arrive in
      // pieces too, keyed by index, and are assembled before use.
      let text = "";
      let refused = false;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const data = line.trim().replace(/^data:\s*/, "");
          if (!data || data === "[DONE]" || !line.trim().startsWith("data:")) continue;
          const chunk = JSON.parse(data) as {
            choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          };
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.delta?.content) {
            text += choice.delta.content;
            onText(choice.delta.content);
          }
          for (const tc of choice.delta?.tool_calls ?? []) {
            const i = tc.index ?? calls.size;
            const cur = calls.get(i) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(i, cur);
          }
          if (choice.finish_reason === "content_filter") refused = true;
        }
      }
      const toolCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, input: parseArgs(c.args) }));
      return { text, toolCalls, refused };
    },
  };
}

// --- configuration --------------------------------------------------------------

export interface AssistantConfig {
  provider: "anthropic" | "ollama" | "openai";
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Which model the assistant uses, from the environment. Null when none is
 * configured, and then the chat button is not shown.
 *
 *   ASSISTANT_PROVIDER=ollama     ASSISTANT_MODEL (default qwen2.5:7b), OLLAMA_HOST
 *   ASSISTANT_PROVIDER=openai     ASSISTANT_BASE_URL, ASSISTANT_API_KEY, ASSISTANT_MODEL
 *   ASSISTANT_PROVIDER=anthropic  ANTHROPIC_API_KEY, ASSISTANT_MODEL (default claude-opus-5-5)
 *   unset                         anthropic if ANTHROPIC_API_KEY is set
 */
export function assistantConfig(raw: Record<string, string | undefined> = process.env): AssistantConfig | null {
  const env = cleanEnv(raw);
  const provider = (env.ASSISTANT_PROVIDER || (env.ANTHROPIC_API_KEY ? "anthropic" : "")).toLowerCase();
  if (provider === "ollama") {
    const host = (env.OLLAMA_HOST || "http://localhost:11434").replace(/\/+$/, "");
    return { provider: "ollama", model: env.ASSISTANT_MODEL || "qwen2.5:7b", baseUrl: `${host}/v1` };
  }
  if (provider === "openai") {
    if (!env.ASSISTANT_BASE_URL || !env.ASSISTANT_MODEL) return null;
    return { provider: "openai", model: env.ASSISTANT_MODEL, baseUrl: env.ASSISTANT_BASE_URL, apiKey: env.ASSISTANT_API_KEY };
  }
  if (provider === "anthropic" && env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", model: env.ASSISTANT_MODEL || DEFAULT_ANTHROPIC_MODEL };
  }
  return null;
}

const SETTINGS = ["ASSISTANT_PROVIDER", "ASSISTANT_BASE_URL", "ASSISTANT_MODEL", "ASSISTANT_API_KEY", "OLLAMA_HOST", "ANTHROPIC_API_KEY"] as const;

/**
 * Values pasted into a hosting dashboard often carry a stray space, newline or
 * pair of quotes; any of those would otherwise switch the assistant off.
 */
function cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of SETTINGS) {
    const v = env[name]?.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    out[name] = v || undefined;
  }
  return out;
}

/**
 * Why the assistant is off, for whoever deploys it: the names of the settings
 * still missing. Names only, never values, so it is safe to show publicly.
 */
export function assistantSetupGaps(raw: Record<string, string | undefined> = process.env): string[] {
  if (assistantConfig(raw)) return [];
  const env = cleanEnv(raw);
  const provider = (env.ASSISTANT_PROVIDER ?? "").toLowerCase();
  if (!provider) return ["ASSISTANT_PROVIDER"];
  if (provider === "openai") return (["ASSISTANT_BASE_URL", "ASSISTANT_MODEL"] as const).filter((n) => !env[n]);
  if (provider === "anthropic") return ["ANTHROPIC_API_KEY"];
  return [`ASSISTANT_PROVIDER (unknown value; use ollama, openai or anthropic)`];
}

export function modelFromConfig(c: AssistantConfig): ChatModel {
  if (c.provider === "anthropic") return anthropicModel(new Anthropic(), c.model);
  return openAICompatModel({ baseUrl: c.baseUrl!, model: c.model, apiKey: c.apiKey, label: `${c.provider}:${c.model}` });
}

/** Who answers, in words a shopper understands (shown under the chat). */
export function providerName(c: AssistantConfig): string {
  if (c.provider === "anthropic") return "Claude";
  if (c.provider === "ollama") return "an AI model running on SigPath's own server";
  return "an AI model";
}
