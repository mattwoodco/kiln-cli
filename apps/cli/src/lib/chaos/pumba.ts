/**
 * Pumba process wrapper.
 *
 * Shells out to the `pumba` CLI (https://github.com/alexei-led/pumba)
 * via `Bun.spawn`. Containers whose `kiln.chaos.exclude=true` Docker
 * label is set are filtered out before any chaos is applied — this
 * protects the kiln-proxy and grading infrastructure from self-harm.
 *
 * Tests inject a `spawner` so the real Pumba CLI is never required.
 */

import { KilnError } from "../errors.js";

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Spawner = (cmd: string[]) => Promise<SpawnResult>;

export interface PumbaOptions {
  /** Override the spawner — used by tests. */
  spawner?: Spawner;
  /** Override the pumba binary path (default: "pumba"). */
  pumbaBin?: string;
  /** Override the docker binary path (default: "docker"). */
  dockerBin?: string;
}

export interface KillOptions {
  /** Seconds to wait before issuing the kill (`--interval`). */
  inSeconds?: number;
  /** Signal to send (default "SIGKILL"). */
  signal?: string;
}

export interface StressOptions {
  /** Number of CPU workers to occupy. */
  cpu: number;
  /** Seconds to run the stress test. */
  durationSeconds: number;
}

export interface PauseOptions {
  /** Seconds to keep the container paused. */
  durationSeconds: number;
}

/**
 * Default spawner using Bun.spawn. Only used at runtime — tests
 * always inject their own spawner.
 */
async function defaultSpawner(cmd: string[]): Promise<SpawnResult> {
  const bun = (globalThis as { Bun?: { spawn?: unknown } }).Bun;
  if (!bun || typeof bun.spawn !== "function") {
    throw new KilnError("Bun.spawn is not available on this host", {
      fix: "Run this command via the `kiln` binary (Bun-powered). If you're in Node, switch to `bun run`.",
      code: "BUN_UNAVAILABLE",
    });
  }
  // Bun.spawn signature — typed locally so we don't drag in @types/bun.
  type BunSpawnProc = {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  };
  type BunSpawn = (args: {
    cmd: string[];
    stdout: "pipe";
    stderr: "pipe";
  }) => BunSpawnProc;
  const spawn = bun.spawn as BunSpawn;
  const proc = spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: code, stdout, stderr };
}

async function ensurePumbaInstalled(spawner: Spawner, pumbaBin: string): Promise<void> {
  try {
    const r = await spawner([pumbaBin, "--version"]);
    if (r.exitCode !== 0) {
      throw new Error(`pumba --version exited ${r.exitCode}`);
    }
  } catch (cause) {
    throw new KilnError("Pumba is not installed or not on PATH", {
      fix: "brew install pumba  (or docker run gaiaadm/pumba)",
      code: "PUMBA_MISSING",
      cause,
    });
  }
}

/**
 * Query docker for `kiln.chaos.exclude=true` containers. Any target
 * passed to a chaos function that matches one of these is dropped,
 * and we throw if that leaves us with nothing to do.
 */
export async function listExcludedContainers(
  spawner: Spawner,
  dockerBin: string,
): Promise<Set<string>> {
  const excluded = new Set<string>();
  try {
    const r = await spawner([
      dockerBin,
      "ps",
      "--filter",
      "label=kiln.chaos.exclude=true",
      "--format",
      "{{.Names}}",
    ]);
    if (r.exitCode !== 0) return excluded;
    for (const line of r.stdout.split("\n")) {
      const name = line.trim();
      if (name) excluded.add(name);
    }
  } catch {
    // docker missing is not fatal here; the subsequent pumba call will fail
    // on its own with a more actionable message.
  }
  return excluded;
}

function filterTargets(requested: string[], excluded: Set<string>): string[] {
  const kept = requested.filter((name) => !excluded.has(name));
  if (kept.length === 0) {
    throw new KilnError(
      `Refusing to run chaos: all targets (${requested.join(", ")}) are excluded via kiln.chaos.exclude=true`,
      {
        fix: "Pick a different --target, or remove the kiln.chaos.exclude label from the intended victim.",
        code: "PUMBA_ALL_EXCLUDED",
      },
    );
  }
  return kept;
}

export class Pumba {
  private readonly spawner: Spawner;
  private readonly pumbaBin: string;
  private readonly dockerBin: string;

  constructor(options: PumbaOptions = {}) {
    this.spawner = options.spawner ?? defaultSpawner;
    this.pumbaBin = options.pumbaBin ?? "pumba";
    this.dockerBin = options.dockerBin ?? "docker";
  }

  async killContainer(name: string, opts: KillOptions = {}): Promise<SpawnResult> {
    await ensurePumbaInstalled(this.spawner, this.pumbaBin);
    const excluded = await listExcludedContainers(this.spawner, this.dockerBin);
    const [target] = filterTargets([name], excluded);
    const cmd: string[] = [this.pumbaBin];
    if (typeof opts.inSeconds === "number") {
      cmd.push("--interval", `${opts.inSeconds}s`);
    }
    cmd.push("kill");
    cmd.push("--signal", opts.signal ?? "SIGKILL");
    cmd.push(target as string);
    return this.runPumba(cmd);
  }

  async stressContainer(name: string, cpu: number, durationSeconds: number): Promise<SpawnResult> {
    await ensurePumbaInstalled(this.spawner, this.pumbaBin);
    const excluded = await listExcludedContainers(this.spawner, this.dockerBin);
    const [target] = filterTargets([name], excluded);
    const cmd = [
      this.pumbaBin,
      "stress",
      "--duration",
      `${durationSeconds}s`,
      "--stressors",
      `--cpu ${cpu} --timeout ${durationSeconds}s`,
      target as string,
    ];
    return this.runPumba(cmd);
  }

  async pauseContainer(name: string, durationSeconds: number): Promise<SpawnResult> {
    await ensurePumbaInstalled(this.spawner, this.pumbaBin);
    const excluded = await listExcludedContainers(this.spawner, this.dockerBin);
    const [target] = filterTargets([name], excluded);
    const cmd = [this.pumbaBin, "pause", "--duration", `${durationSeconds}s`, target as string];
    return this.runPumba(cmd);
  }

  private async runPumba(cmd: string[]): Promise<SpawnResult> {
    const result = await this.spawner(cmd);
    if (result.exitCode !== 0) {
      throw new KilnError(
        `pumba failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
        {
          fix: "Check that the target container is running (`docker ps`) and that Pumba has Docker socket access.",
          code: "PUMBA_FAILED",
        },
      );
    }
    return result;
  }
}
