import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSoftAudit } from "../../../src/lib/audit/soft-audit.js";

async function makeFixtureProject(
  opts: {
    hasDockerfile?: boolean;
    hasCompose?: boolean;
    hasGit?: boolean;
    hasProxyYml?: boolean;
    hasSource?: boolean;
  } = {},
): Promise<string> {
  const dir = join(tmpdir(), `kiln-soft-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(dir, ".kiln"), { recursive: true });
  if (opts.hasGit !== false) {
    await mkdir(join(dir, ".git"), { recursive: true });
  }
  if (opts.hasProxyYml !== false) {
    await writeFile(join(dir, ".kiln", "proxy.yml"), "version: 1\n");
  }
  if (opts.hasSource !== false) {
    await writeFile(join(dir, "main.py"), "print('hi')\n");
  }
  if (opts.hasDockerfile) {
    await writeFile(join(dir, "Dockerfile"), "FROM alpine\n");
  }
  if (opts.hasCompose) {
    await writeFile(join(dir, "docker-compose.yml"), "services: {}\n");
  }
  return dir;
}

describe("runSoftAudit", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop();
      if (d) await rm(d, { recursive: true, force: true });
    }
  });

  it("returns no hard failures when git + source + proxy.yml are all present", async () => {
    const dir = await makeFixtureProject({});
    tmpDirs.push(dir);
    const result = await runSoftAudit(dir, { skipRuntimeProbes: true });
    expect(result.hardFailures).toHaveLength(0);
  });

  it("returns docker_build: 'skipped (no Dockerfile)' with blocked ships criterion", async () => {
    const dir = await makeFixtureProject({});
    tmpDirs.push(dir);
    const result = await runSoftAudit(dir, { skipRuntimeProbes: true });
    expect(result.evaluationCoverage.docker_build).toBe("skipped (no Dockerfile)");
    const dockerWarning = result.warnings.find((w) => w.name === "docker-presence");
    expect(dockerWarning).toBeDefined();
    expect(dockerWarning?.criterion).toBe("ships");
    expect(dockerWarning?.status).toBe("blocked");
  });

  it("reports hard failures when git is missing", async () => {
    const dir = await makeFixtureProject({ hasGit: false });
    tmpDirs.push(dir);
    const result = await runSoftAudit(dir, { skipRuntimeProbes: true });
    expect(result.hardFailures.some((f) => f.name === "git-init")).toBe(true);
  });

  it("reports hard failures when proxy.yml is missing", async () => {
    const dir = await makeFixtureProject({ hasProxyYml: false });
    tmpDirs.push(dir);
    const result = await runSoftAudit(dir, { skipRuntimeProbes: true });
    expect(result.hardFailures.some((f) => f.name === "proxy-yml")).toBe(true);
  });

  it("reports hard failures when no source exists", async () => {
    const dir = await makeFixtureProject({ hasSource: false });
    tmpDirs.push(dir);
    const result = await runSoftAudit(dir, { skipRuntimeProbes: true });
    expect(result.hardFailures.some((f) => f.name === "source-present")).toBe(true);
  });

  it("reports docker_build: 'ok' when Dockerfile + compose present", async () => {
    const dir = await makeFixtureProject({
      hasDockerfile: true,
      hasCompose: true,
    });
    tmpDirs.push(dir);
    const result = await runSoftAudit(dir, { skipRuntimeProbes: true });
    expect(result.evaluationCoverage.docker_build).toBe("ok");
    expect(result.warnings.find((w) => w.name === "docker-presence")).toBeUndefined();
  });

  it("surfaces missing rubric.yml as a warning (not a failure)", async () => {
    const dir = await makeFixtureProject({});
    tmpDirs.push(dir);
    const result = await runSoftAudit(dir, { skipRuntimeProbes: true });
    expect(result.warnings.some((w) => w.name === "required:.kiln/rubric.yml")).toBe(true);
    expect(result.hardFailures.some((f) => f.name === "required:.kiln/rubric.yml")).toBe(false);
  });
});
