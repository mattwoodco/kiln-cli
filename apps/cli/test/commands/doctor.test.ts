import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the global fetch used for reachability probes so tests are hermetic.
const origFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

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

vi.mock("../../src/lib/kiln-api.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/kiln-api.js")>(
    "../../src/lib/kiln-api.js",
  );
  return {
    ...actual,
    KilnApiClient: class {
      async pingWithTimeout() {
        return true;
      }
    },
  };
});

const doctorModulePath = resolve(__dirname, "..", "..", "src", "commands", "doctor.ts");

describe("kiln doctor", () => {
  let configDir: string;
  let projectDir: string;
  let origHome: string | undefined;
  let origCwd: string;
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(async () => {
    configDir = join(tmpdir(), `kiln-docdir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    projectDir = join(tmpdir(), `kiln-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(configDir, ".kiln"), { recursive: true });
    await mkdir(projectDir, { recursive: true });
    origHome = process.env.HOME;
    origCwd = process.cwd();
    process.env.HOME = configDir;
    process.chdir(projectDir);

    // Pre-seed a config so cohort info appears in output.
    const { ConfigStore } = await import("../../src/lib/config-store.js");
    const store = new ConfigStore();
    await store.write({
      version: "v1",
      cohortId: "cohort-42",
      cohortName: "alpha",
      currentWeek: 3,
      containerRuntime: "orbstack",
      apiUrl: "http://localhost:4000",
    });

    logs = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });

  afterEach(async () => {
    console.log = origLog;
    process.chdir(origCwd);
    if (origHome !== undefined) process.env.HOME = origHome;
    else Reflect.deleteProperty(process.env, "HOME");
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("includes cohort info and detected runtimes and warns about missing Dockerfile", async () => {
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ engines: { node: ">=20.0.0" } }),
    );
    // Force project-mode.
    const { default: Doctor } = await import(doctorModulePath);
    await Doctor.run(["--project"]);
    const out = logs.join("\n");
    expect(out).toContain("alpha");
    expect(out).toContain("cohort-42");
    expect(out).toContain("week 3");
    expect(out).toMatch(/Dockerfile: missing/);
    expect(out).toContain("Node.js");
  });
});
