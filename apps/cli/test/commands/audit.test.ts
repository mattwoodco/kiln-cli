import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the docker-build + runtime-toolchain checks so tests stay hermetic.
// Re-export everything else unchanged via vi.importActual.
vi.mock("../../src/lib/audit/checks.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/audit/checks.js")>(
    "../../src/lib/audit/checks.js",
  );
  return {
    ...actual,
    checkDockerBuild: vi.fn(async () => ({
      name: "docker-build",
      level: "pass" as const,
      message: "docker compose build succeeded in 0.1s (mocked)",
      criterion: "ships",
      duration_ms: 100,
    })),
    checkRuntimeToolchainParity: vi.fn(async (_projectDir: string) => [
      {
        name: "runtime:python",
        level: "pass" as const,
        message: "python 3.12.0 ≥ 3.11.0",
      },
    ]),
  };
});

const auditModulePath = resolve(__dirname, "..", "..", "src", "commands", "audit.ts");

async function makeValidProject(): Promise<string> {
  const dir = join(tmpdir(), `kiln-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(dir, ".kiln"), { recursive: true });
  await writeFile(join(dir, ".kiln", "proxy.yml"), "version: 1\n");
  await writeFile(join(dir, ".kiln", "rubric.yml"), "criteria: []\n");
  await writeFile(join(dir, ".kiln", "chaos-config.yml"), "steady_state: {}\n");
  await writeFile(join(dir, ".kiln", "spec.md"), "# spec\n");
  await writeFile(join(dir, ".kiln", "video.md"), "# video\n");
  await writeFile(join(dir, "Makefile"), "all:\n");
  await writeFile(join(dir, "README.md"), "# project\n");
  await writeFile(join(dir, "Dockerfile"), "FROM alpine\n");
  await writeFile(join(dir, "docker-compose.yml"), "services: {}\n");
  return dir;
}

describe("kiln audit", () => {
  let projectDir: string;
  let origCwd: string;
  let logs: string[];
  let origLog: typeof console.log;
  let exitCode: number | undefined;

  beforeEach(async () => {
    origCwd = process.cwd();
    logs = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    exitCode = undefined;
  });

  afterEach(async () => {
    console.log = origLog;
    process.chdir(origCwd);
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  async function runAudit(argv: string[]): Promise<void> {
    const { default: Audit } = await import(auditModulePath);
    try {
      await Audit.run(argv);
    } catch (err) {
      if (err && typeof err === "object" && "oclif" in err) {
        const errObj = err as { oclif?: { exit?: number }; code?: string };
        exitCode = errObj.oclif?.exit ?? 1;
        return;
      }
      throw err;
    }
  }

  it("(valid project) exits 0 with a concise summary", async () => {
    projectDir = await makeValidProject();
    process.chdir(projectDir);
    await runAudit([]);
    const out = logs.join("\n");
    expect(out).toContain("audit: 0 failures");
    expect(exitCode).toBeUndefined();
  });

  it("(missing Dockerfile) exits 1 with a fix command", async () => {
    projectDir = await makeValidProject();
    process.chdir(projectDir);
    await rm(join(projectDir, "Dockerfile"));
    await rm(join(projectDir, "docker-compose.yml"));
    await runAudit([]);
    const out = logs.join("\n");
    expect(out).toMatch(/docker-presence/);
    expect(out).toMatch(/Add a Dockerfile/);
    expect(exitCode).toBe(1);
  });

  it("(python runtime mismatch) exits 1 with a fix command", async () => {
    // Re-mock runtime check to return a failure just for this test.
    const checks = await import("../../src/lib/audit/checks.js");
    const runtime = vi.mocked(checks.checkRuntimeToolchainParity);
    runtime.mockResolvedValueOnce([
      {
        name: "runtime:python",
        level: "fail",
        message: "python 3.9.0 < 3.12.0",
        fix: "brew install python@3.12",
      },
    ]);
    projectDir = await makeValidProject();
    process.chdir(projectDir);
    await runAudit([]);
    const out = logs.join("\n");
    expect(out).toContain("runtime:python");
    expect(out).toContain("brew install python@3.12");
    expect(exitCode).toBe(1);
  });

  it("(--ci) emits AuditResultSchema-conforming JSON", async () => {
    projectDir = await makeValidProject();
    process.chdir(projectDir);
    await runAudit(["--ci"]);
    const out = logs.join("\n");
    // Find the first {...} blob
    const blob = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    const parsed = JSON.parse(blob) as {
      passed: boolean;
      checks: Array<{ name: string; status: string }>;
      warnings: string[];
      generated_at: string;
    };
    expect(parsed.passed).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
  });
});

describe("soft audit vs strict audit (same inputs, different treatment)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop();
      if (d) await rm(d, { recursive: true, force: true });
    }
  });

  it("soft audit returns warnings, not failures, for missing Dockerfile", async () => {
    const { runSoftAudit } = await import("../../src/lib/audit/soft-audit.js");
    const dir = join(tmpdir(), `kiln-soft-comp-${Date.now()}`);
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, ".kiln"), { recursive: true });
    await writeFile(join(dir, ".kiln", "proxy.yml"), "version: 1\n");
    await writeFile(join(dir, "main.py"), "print('hi')\n");
    tmpDirs.push(dir);
    const result = await runSoftAudit(dir, { skipRuntimeProbes: true });
    expect(result.hardFailures).toHaveLength(0);
    expect(result.warnings.some((w) => w.name === "docker-presence")).toBe(true);
  });
});
