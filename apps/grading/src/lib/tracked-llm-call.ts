import type Anthropic from "@anthropic-ai/sdk";
import { type LLMCallDetail, LLMCallDetailSchema, type LLMCallPurpose } from "@kiln/shared";
import { estimateCost } from "./pricing.js";

/**
 * All LLM calls in the grading/checkpoint pipelines go through this helper.
 *
 * Responsibilities:
 *  - Execute the Anthropic Messages call.
 *  - Capture tokens, latency, and cost into an `LLMCallDetail` record.
 *  - Honour `MOCK_LLM=1` for deterministic, offline, schema-valid responses
 *    so the whole pipeline is testable without an API key.
 *
 * The rest of the pipeline must never import `@anthropic-ai/sdk` directly —
 * this is the single funnel for LLM usage.
 */

export interface TrackedLLMResult<T = unknown> {
  message: Anthropic.Message;
  detail: LLMCallDetail;
  /** Parsed text content from the first text block, or the mock payload. */
  text: string;
  /** Optional parsed structured payload for pass3 synthesis / mocks. */
  parsed?: T;
}

export interface TrackedLLMOptions {
  purpose: LLMCallPurpose;
  /** Optional deterministic mock response used when MOCK_LLM=1. */
  mockPayload?: unknown;
  /** Optional deterministic mock text used when MOCK_LLM=1. */
  mockText?: string;
}

export function isMockLLM(): boolean {
  return process.env.MOCK_LLM === "1";
}

export async function trackedLLMCall<T = unknown>(
  client: Anthropic,
  params: Anthropic.MessageCreateParams,
  options: TrackedLLMOptions,
): Promise<TrackedLLMResult<T>> {
  const startedAt = new Date().toISOString();
  const start = performance.now();

  if (isMockLLM()) {
    const latency = 10;
    const inputTokens = 100;
    const outputTokens = 50;
    const detail = LLMCallDetailSchema.parse({
      call_id: crypto.randomUUID(),
      model: params.model,
      purpose: options.purpose,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      latency_ms: latency,
      estimated_cost_usd: estimateCost(String(params.model), inputTokens, outputTokens),
      started_at: startedAt,
    });
    const text = options.mockText ?? JSON.stringify(options.mockPayload ?? {});
    // Synthesize a minimal Anthropic.Message shape for downstream consumers.
    const message = {
      id: `mock-${detail.call_id}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    } as unknown as Anthropic.Message;
    return {
      message,
      detail,
      text,
      parsed: (options.mockPayload as T | undefined) ?? undefined,
    };
  }

  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      ...params,
      stream: false,
    } as Anthropic.MessageCreateParamsNonStreaming);
  } catch (err) {
    const latency = performance.now() - start;
    const detail = LLMCallDetailSchema.parse({
      call_id: crypto.randomUUID(),
      model: params.model,
      purpose: options.purpose,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      latency_ms: Math.round(latency),
      estimated_cost_usd: 0,
      started_at: startedAt,
      error: (err as Error).message,
    });
    throw Object.assign(err as Error, { detail });
  }
  const latency = performance.now() - start;

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const cacheRead = message.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;

  const detail = LLMCallDetailSchema.parse({
    call_id: crypto.randomUUID(),
    model: params.model,
    purpose: options.purpose,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    latency_ms: Math.round(latency),
    estimated_cost_usd: estimateCost(
      String(params.model),
      inputTokens,
      outputTokens,
      cacheRead,
      cacheWrite,
    ),
    started_at: startedAt,
  });

  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }

  return { message, detail, text };
}
