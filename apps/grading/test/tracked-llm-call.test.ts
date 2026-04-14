import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMockLLM, trackedLLMCall } from "../src/lib/tracked-llm-call.js";

describe("trackedLLMCall (MOCK_LLM branch)", () => {
  const original = process.env.MOCK_LLM;
  beforeEach(() => {
    process.env.MOCK_LLM = "1";
  });
  afterEach(() => {
    process.env.MOCK_LLM = original;
  });

  it("honors MOCK_LLM=1", () => {
    expect(isMockLLM()).toBe(true);
  });

  it("returns a schema-valid LLMCallDetail without hitting the network", async () => {
    const client = new Anthropic({ apiKey: "mock" });
    const result = await trackedLLMCall(
      client,
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
      { purpose: "generate-one-sheet", mockText: "hi" },
    );
    expect(result.detail.model).toBe("claude-sonnet-4-6");
    expect(result.detail.purpose).toBe("generate-one-sheet");
    expect(result.detail.input_tokens).toBeGreaterThan(0);
    expect(result.detail.output_tokens).toBeGreaterThan(0);
    expect(result.detail.estimated_cost_usd).toBeGreaterThan(0);
    expect(result.text).toBe("hi");
    expect(result.message.content[0]).toMatchObject({ type: "text", text: "hi" });
  });

  it("exposes the mock payload as parsed for pass3 synthesis callers", async () => {
    const client = new Anthropic({ apiKey: "mock" });
    const payload = { overall_score: 85 };
    const result = await trackedLLMCall<typeof payload>(
      client,
      {
        model: "claude-opus-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: "synthesize" }],
      },
      { purpose: "generate-one-sheet", mockPayload: payload },
    );
    expect(result.parsed).toEqual(payload);
  });
});
