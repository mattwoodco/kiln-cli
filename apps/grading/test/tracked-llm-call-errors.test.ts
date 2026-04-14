/**
 * Phase 8 hardening — trackedLLMCall must still record *something* when the
 * SDK throws, so a usage-event can be persisted even for failed calls.
 *
 * The mock SDK below mimics the Anthropic client surface closely enough to
 * exercise the catch block without any network traffic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trackedLLMCall } from "../src/lib/tracked-llm-call.js";

describe("trackedLLMCall — SDK error path", () => {
  const original = process.env.MOCK_LLM;
  beforeEach(() => {
    delete process.env.MOCK_LLM;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MOCK_LLM;
    else process.env.MOCK_LLM = original;
  });

  it("attaches a zero-token LLMCallDetail to the thrown error", async () => {
    const fakeError = new Error("upstream connection reset");
    const fakeClient = {
      messages: {
        create: async () => {
          throw fakeError;
        },
      },
    };

    let caught: unknown;
    try {
      await trackedLLMCall(
        fakeClient as unknown as import("@anthropic-ai/sdk").default,
        {
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        },
        { purpose: "analyze-code" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const err = caught as { detail: { model: string; purpose: string; input_tokens: number; output_tokens: number; error?: string } };
    expect(err.detail).toBeDefined();
    expect(err.detail.model).toBe("claude-sonnet-4-6");
    expect(err.detail.purpose).toBe("analyze-code");
    expect(err.detail.input_tokens).toBe(0);
    expect(err.detail.output_tokens).toBe(0);
    expect(err.detail.error).toMatch(/upstream connection reset/);
  });
});
