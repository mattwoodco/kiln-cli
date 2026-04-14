import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @anthropic-ai/sdk — no real network calls.
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      public messages = {
        create: async () => ({
          id: "msg_mock",
          content: [{ type: "text", text: "ok" }],
          model: "claude-haiku-4-5-20251001",
          role: "assistant",
          stop_reason: "end_turn",
          type: "message",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    },
  };
});

// Mock doctor checks so we don't depend on host tooling in unit tests.
vi.mock("../../src/lib/doctor-checks.js", () => {
  return {
    checkDocker: async () => ({ name: "docker", status: "ok", detail: "docker 27.0.0" }),
    checkDockerCompose: async () => ({
      name: "docker-compose",
      status: "ok",
      detail: "compose 2.30.0",
    }),
    checkGit: async () => ({ name: "git", status: "ok", detail: "git 2.45.0" }),
    checkBun: async () => ({ name: "bun", status: "ok", detail: "bun 1.3.1" }),
    detectContainerRuntime: async () => "orbstack",
  };
});

// Force the API ping to fail so we hit the mock cohort fallback.
vi.mock("../../src/lib/kiln-api.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/kiln-api.js")>(
    "../../src/lib/kiln-api.js",
  );
  return {
    ...actual,
    KilnApiClient: class {
      async pingWithTimeout() {
        return false;
      }
      async me() {
        throw new Error("unreachable in test");
      }
      async weekConfig() {
        throw new Error("unreachable in test");
      }
    },
  };
});

const initModulePath = resolve(__dirname, "..", "..", "src", "commands", "init.ts");

describe("kiln init", () => {
  let configDir: string;
  let configPath: string;
  let projectDir: string;
  let origHome: string | undefined;
  let origAnthropic: string | undefined;
  let origCwd: string;

  beforeEach(async () => {
    configDir = join(tmpdir(), `kiln-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    projectDir = join(tmpdir(), `kiln-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(configDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    configPath = join(configDir, ".kiln", "config.json");
    origHome = process.env.HOME;
    origAnthropic = process.env.ANTHROPIC_API_KEY;
    origCwd = process.cwd();
    process.env.HOME = configDir;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";
    process.chdir(projectDir);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    if (origHome !== undefined) process.env.HOME = origHome;
    else Reflect.deleteProperty(process.env, "HOME");
    if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic;
    else Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes config with cohort fallback and detects runtimes in cwd", async () => {
    // Write a polyglot project so runtime discovery has something to say.
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ engines: { node: ">=20.0.0" } }),
    );
    await writeFile(join(projectDir, "requirements.txt"), "flask==3.0.0\n");

    const { default: Init } = await import(initModulePath);
    await Init.run(["--ci", "--verbose"]);

    const raw = await readFile(configPath, "utf8");
    const blob = JSON.parse(raw);
    expect(blob.meta.cohortId).toBe("cohort-dev");
    expect(blob.meta.cohortName).toBe("dev-local");
    expect(blob.meta.currentWeek).toBe(1);
    expect(blob.ciphertext).toBeDefined();
    expect(blob.salt).toBeDefined();
  });

  it("fails --ci without ANTHROPIC_API_KEY", async () => {
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { default: Init } = await import(initModulePath);
    await expect(Init.run(["--ci"])).rejects.toThrow();
    exitSpy.mockRestore();
  });
});
