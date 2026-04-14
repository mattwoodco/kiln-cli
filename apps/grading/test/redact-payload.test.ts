import { describe, expect, it } from "vitest";
import {
  redactPayload,
  redactString,
} from "../src/activities/dispatch/redact-payload.js";

describe("redact-payload", () => {
  it("redacts sk-ant API keys", () => {
    const input = "leaked: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA";
    expect(redactString(input)).toBe("leaked: [REDACTED]");
  });

  it("redacts sk-ant API keys followed by whitespace", () => {
    const input = "leaked: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA next";
    expect(redactString(input)).toBe("leaked: [REDACTED] next");
  });

  it("redacts generic sk- API keys", () => {
    const input = "key=sk-test1234567890abcdefghijk";
    expect(redactString(input)).toBe("key=[REDACTED]");
  });

  it("redacts gitlab personal access tokens", () => {
    const input = "PRIVATE-TOKEN: glpat-abcdefghijklmnopqrst";
    expect(redactString(input)).toBe("PRIVATE-TOKEN: [REDACTED]");
  });

  it("redacts github personal access tokens", () => {
    const input = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactString(input)).toBe("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGc.payload.signature";
    expect(redactString(input)).toBe("Authorization: [REDACTED]");
  });

  it("walks nested objects and arrays", () => {
    const input = {
      headers: {
        authorization: "Bearer eyJhbGc.payload.sig",
      },
      logs: [
        "ok",
        "leaked sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA",
        { nested: "glpat-abcdefghijklmnopqrst" },
      ],
      counts: 42,
      flag: true,
    };
    const out = redactPayload(input);
    expect(out.headers.authorization).toBe("[REDACTED]");
    expect(out.logs[0]).toBe("ok");
    expect(out.logs[1]).toContain("[REDACTED]");
    expect((out.logs[2] as { nested: string }).nested).toBe("[REDACTED]");
    expect(out.counts).toBe(42);
    expect(out.flag).toBe(true);
  });

  it("handles null and undefined", () => {
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeUndefined();
  });
});
