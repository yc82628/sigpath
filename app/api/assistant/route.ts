import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { ChatRequest, runAssistant, type AssistantEvent } from "@/lib/assistant/assistant";
import { assistantConfig, assistantSetupGaps, modelFromConfig } from "@/lib/assistant/models";
import { RateLimiter } from "@/lib/assistant/rate-limit";
import { labelledSearch } from "@/lib/marketplace/labelled-search";

// POST /api/assistant  { messages: [{ role, content }, ...] }
//
// The shopping assistant. Streams newline-delimited JSON events (see
// AssistantEvent): words as they are written, "searching", result cards,
// then "done". The conversation is sent by the browser each turn; nothing
// here stores or logs it.

export const runtime = "nodejs";
// The status below reads the environment on every request, not once at build time.
export const dynamic = "force-dynamic";

// 20 turns per 10 minutes per client.
const limiter = new RateLimiter(20, 10 * 60 * 1000);

// GET /api/assistant: whether the assistant is on here, and if not, which
// settings are missing (names only, never values).
export async function GET() {
  const config = assistantConfig();
  return NextResponse.json(config ? { available: true, provider: config.provider, model: config.model } : { available: false, missing: assistantSetupGaps() }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  const config = assistantConfig();
  if (!config) {
    return NextResponse.json({ error: "The shopping assistant isn't set up on this server.", missing: assistantSetupGaps() }, { status: 503 });
  }

  const client = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  if (!limiter.allow(client)) {
    return NextResponse.json({ error: "That's a lot of questions! Give it a few minutes and try again." }, { status: 429 });
  }

  const parsed = ChatRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Couldn't read that message. Try again." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AssistantEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await runAssistant(parsed.data, emit, {
          model: modelFromConfig(config),
          search: (q, currency) => labelledSearch(q, { limit: 20, currency }),
        });
      } catch (err) {
        // Status only: an error message could echo the conversation.
        const status = err instanceof Anthropic.APIError ? err.status : undefined;
        console.error("assistant: turn failed", config.provider, status ?? (err instanceof Error ? err.name : "unknown"));
        emit({ type: "error", message: "Sorry, something went wrong on our side. Please try again." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
