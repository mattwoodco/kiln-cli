import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractChecks,
  parseYamlSubset,
  runSteadyState,
} from "../../../src/lib/chaos/steady-state.js";

const CONFIG_A = `# Simple chaos config with two checks
steady_state:
  checks:
    - name: health
      url: http://localhost:8080/healthz
      expected_status: 200
      timeout_ms: 2000
    - name: ready
      url: http://localhost:8080/ready
      expected_status: 200
      timeout_ms: 2000
`;

const CONFIG_TEMPLATE_SHAPE = `steady_state:
  endpoints:
    - name: health
      method: GET
      url: http://app:8080/health
      expect_status: 200
`;

describe("parseYamlSubset", () => {
  it("parses a nested list inside a mapping", () => {
    const parsed = parseYamlSubset(CONFIG_A);
    const checks = extractChecks(parsed);
    expect(checks).toHaveLength(2);
    expect(checks[0]?.name).toBe("health");
    expect(checks[0]?.url).toBe("http://localhost:8080/healthz");
    expect(checks[0]?.expectedStatus).toBe(200);
    expect(checks[0]?.timeoutMs).toBe(2000);
  });

  it("accepts the scaffold-template shape (endpoints + expect_status)", () => {
    const parsed = parseYamlSubset(CONFIG_TEMPLATE_SHAPE);
    const checks = extractChecks(parsed);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.expectedStatus).toBe(200);
  });
});

describe("runSteadyState", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(tmpdir(), `kiln-ss-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(dir, ".kiln"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeConfig = async (body: string): Promise<void> => {
    await writeFile(join(dir, ".kiln", "chaos-config.yml"), body, "utf8");
  };

  it("returns PASS when all checks pass", async () => {
    await writeConfig(CONFIG_A);
    const fetchImpl = (async () => ({ status: 200 })) as unknown as typeof fetch;
    const result = await runSteadyState({ projectDir: dir, fetchImpl });
    expect(result.verdict).toBe("PASS");
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.status === "pass")).toBe(true);
  });

  it("returns FAIL when all checks fail", async () => {
    await writeConfig(CONFIG_A);
    const fetchImpl = (async () => ({ status: 503 })) as unknown as typeof fetch;
    const result = await runSteadyState({ projectDir: dir, fetchImpl });
    expect(result.verdict).toBe("FAIL");
  });

  it("returns DEGRADED when some pass and some fail", async () => {
    await writeConfig(CONFIG_A);
    let i = 0;
    const fetchImpl = (async () => {
      i += 1;
      return { status: i === 1 ? 200 : 500 };
    }) as unknown as typeof fetch;
    const result = await runSteadyState({ projectDir: dir, fetchImpl });
    expect(result.verdict).toBe("DEGRADED");
  });

  it("throws a KilnError when the config file is missing", async () => {
    await expect(
      runSteadyState({
        projectDir: dir,
        fetchImpl: (async () => ({ status: 200 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/chaos-config\.yml not found/);
  });
});
