import { describe, expect, it } from "vitest";
import { Pumba, type SpawnResult, listExcludedContainers } from "../../../src/lib/chaos/pumba.js";

/**
 * Test spawner records every invocation and returns scripted responses.
 */
function makeSpawner(
  responses: Record<string, SpawnResult>,
  fallback: SpawnResult = { exitCode: 0, stdout: "", stderr: "" },
): {
  spawner: (cmd: string[]) => Promise<SpawnResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawner = async (cmd: string[]): Promise<SpawnResult> => {
    calls.push([...cmd]);
    const first = cmd[0] ?? "";
    const second = cmd[1] ?? "";
    const key = `${first} ${second}`.trim();
    if (responses[key]) return responses[key];
    if (responses[first]) return responses[first];
    return fallback;
  };
  return { spawner, calls };
}

describe("listExcludedContainers", () => {
  it("parses docker ps output into a set of names", async () => {
    const { spawner } = makeSpawner({
      docker: {
        exitCode: 0,
        stdout: "kiln-proxy\nkiln-grader\n\n",
        stderr: "",
      },
    });
    const excluded = await listExcludedContainers(spawner, "docker");
    expect(excluded.has("kiln-proxy")).toBe(true);
    expect(excluded.has("kiln-grader")).toBe(true);
    expect(excluded.size).toBe(2);
  });

  it("returns an empty set if docker fails", async () => {
    const { spawner } = makeSpawner(
      {},
      { exitCode: 1, stdout: "", stderr: "Cannot connect to Docker daemon" },
    );
    const excluded = await listExcludedContainers(spawner, "docker");
    expect(excluded.size).toBe(0);
  });
});

describe("Pumba.killContainer", () => {
  it("constructs the expected pumba command", async () => {
    const { spawner, calls } = makeSpawner({
      "pumba --version": { exitCode: 0, stdout: "0.10.2", stderr: "" },
      docker: { exitCode: 0, stdout: "", stderr: "" },
      pumba: { exitCode: 0, stdout: "killed", stderr: "" },
    });
    const pumba = new Pumba({ spawner });
    await pumba.killContainer("app", { inSeconds: 5 });

    const cmd = calls.find((c) => c[0] === "pumba" && c.includes("kill") && c.includes("app"));
    expect(cmd).toBeDefined();
    expect(cmd).toContain("--interval");
    expect(cmd).toContain("5s");
    expect(cmd).toContain("--signal");
    expect(cmd).toContain("SIGKILL");
  });

  it("throws KilnError when all targets are excluded", async () => {
    const { spawner } = makeSpawner({
      "pumba --version": { exitCode: 0, stdout: "0.10.2", stderr: "" },
      docker: { exitCode: 0, stdout: "kiln-proxy\n", stderr: "" },
      pumba: { exitCode: 0, stdout: "", stderr: "" },
    });
    const pumba = new Pumba({ spawner });
    await expect(pumba.killContainer("kiln-proxy")).rejects.toThrow(
      /excluded via kiln\.chaos\.exclude/,
    );
  });

  it("throws KilnError with fix hint when pumba is missing", async () => {
    const { spawner } = makeSpawner({
      pumba: {
        exitCode: 127,
        stdout: "",
        stderr: "command not found",
      },
    });
    const pumba = new Pumba({ spawner });
    await expect(pumba.killContainer("app")).rejects.toThrow(/Pumba is not installed/);
  });

  it("propagates pumba failure as KilnError", async () => {
    const { spawner } = makeSpawner({
      "pumba --version": { exitCode: 0, stdout: "0.10.2", stderr: "" },
      docker: { exitCode: 0, stdout: "", stderr: "" },
      pumba: { exitCode: 2, stdout: "", stderr: "container not found" },
    });
    const pumba = new Pumba({ spawner });
    await expect(pumba.killContainer("ghost")).rejects.toThrow(/pumba failed/);
  });
});

describe("Pumba.stressContainer", () => {
  it("includes the cpu count and duration", async () => {
    const { spawner, calls } = makeSpawner({
      "pumba --version": { exitCode: 0, stdout: "0.10.2", stderr: "" },
      docker: { exitCode: 0, stdout: "", stderr: "" },
      pumba: { exitCode: 0, stdout: "ok", stderr: "" },
    });
    const pumba = new Pumba({ spawner });
    await pumba.stressContainer("worker", 4, 10);
    const stressCall = calls.find((c) => c[0] === "pumba" && c.includes("stress"));
    expect(stressCall).toBeDefined();
    expect(stressCall?.join(" ")).toContain("--cpu 4");
    expect(stressCall?.join(" ")).toContain("10s");
    expect(stressCall).toContain("worker");
  });
});
