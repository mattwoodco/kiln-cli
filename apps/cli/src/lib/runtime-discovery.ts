import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type RuntimeName = "node" | "python" | "go" | "rust" | "ruby" | "java-maven" | "java-gradle";

export interface DetectedRuntime {
  runtime: RuntimeName;
  manifestPath: string;
  declaredVersion?: string;
  minVersion: string;
  installed: boolean;
  installedVersion?: string;
  satisfies: boolean;
  fix?: string;
}

interface RuntimeDef {
  runtime: RuntimeName;
  manifests: string[];
  minVersion: string;
  probeCmd: string;
  probeArgs: string[];
  fix: string;
  parseInstalled: (output: string) => string | undefined;
  parseDeclared: (manifestPath: string, contents: string) => string | undefined;
}

// Comparable semver-ish: extract first x.y.z from a string and compare.
function parseVersionTriple(s: string): [number, number, number] | undefined {
  const match = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  return [
    Number.parseInt(match[1] ?? "0", 10),
    Number.parseInt(match[2] ?? "0", 10),
    Number.parseInt(match[3] ?? "0", 10),
  ];
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersionTriple(a);
  const pb = parseVersionTriple(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function parseNodeEngines(contents: string): string | undefined {
  try {
    const pkg = JSON.parse(contents) as {
      engines?: { node?: string };
      volta?: { node?: string };
    };
    const engines = pkg.engines?.node;
    if (engines) {
      const t = parseVersionTriple(engines);
      if (t) return `${t[0]}.${t[1]}.${t[2]}`;
    }
    const volta = pkg.volta?.node;
    if (volta) {
      const t = parseVersionTriple(volta);
      if (t) return `${t[0]}.${t[1]}.${t[2]}`;
    }
  } catch {
    // ignore malformed package.json
  }
  return undefined;
}

function parsePyprojectPython(contents: string): string | undefined {
  // Naive parse for `requires-python = ">=3.11"` or `python = "^3.11"`
  const m = contents.match(/requires-python\s*=\s*["'][^\d]*(\d+\.\d+(?:\.\d+)?)/);
  if (m?.[1]) return m[1];
  const m2 = contents.match(/python\s*=\s*["'][^\d]*(\d+\.\d+(?:\.\d+)?)/);
  if (m2?.[1]) return m2[1];
  return undefined;
}

function parseGoMod(contents: string): string | undefined {
  const m = contents.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m);
  return m?.[1];
}

function parseCargoRustEdition(contents: string): string | undefined {
  // rust-version = "1.75"
  const m = contents.match(/rust-version\s*=\s*["'](\d+\.\d+(?:\.\d+)?)/);
  return m?.[1];
}

function parseGemfileRuby(contents: string): string | undefined {
  const m = contents.match(/ruby\s+["'](\d+\.\d+(?:\.\d+)?)/);
  return m?.[1];
}

const RUNTIMES: RuntimeDef[] = [
  {
    runtime: "node",
    manifests: ["package.json"],
    minVersion: "20.0.0",
    probeCmd: "node",
    probeArgs: ["--version"],
    fix: "Install Node via mise (`mise install node@20`) or brew (`brew install node`).",
    parseInstalled: (out) => parseVersionTriple(out)?.join("."),
    parseDeclared: (_p, c) => parseNodeEngines(c),
  },
  {
    runtime: "python",
    manifests: ["pyproject.toml", "requirements.txt"],
    minVersion: "3.11.0",
    probeCmd: "python3",
    probeArgs: ["--version"],
    fix: "Install Python 3.11+ via `brew install python@3.12` or `mise install python@3.12`.",
    parseInstalled: (out) => parseVersionTriple(out)?.join("."),
    parseDeclared: (p, c) => (p.endsWith("pyproject.toml") ? parsePyprojectPython(c) : undefined),
  },
  {
    runtime: "go",
    manifests: ["go.mod"],
    minVersion: "1.22.0",
    probeCmd: "go",
    probeArgs: ["version"],
    fix: "Install Go 1.22+ via `brew install go` or `mise install go@1.22`.",
    parseInstalled: (out) => parseVersionTriple(out)?.join("."),
    parseDeclared: (_p, c) => parseGoMod(c),
  },
  {
    runtime: "rust",
    manifests: ["Cargo.toml"],
    minVersion: "1.75.0",
    probeCmd: "rustc",
    probeArgs: ["--version"],
    fix: "Install Rust via `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.",
    parseInstalled: (out) => parseVersionTriple(out)?.join("."),
    parseDeclared: (_p, c) => parseCargoRustEdition(c),
  },
  {
    runtime: "ruby",
    manifests: ["Gemfile"],
    minVersion: "3.2.0",
    probeCmd: "ruby",
    probeArgs: ["--version"],
    fix: "Install Ruby 3.2+ via `brew install ruby` or `mise install ruby@3.2`.",
    parseInstalled: (out) => parseVersionTriple(out)?.join("."),
    parseDeclared: (_p, c) => parseGemfileRuby(c),
  },
  {
    runtime: "java-maven",
    manifests: ["pom.xml"],
    minVersion: "17.0.0",
    probeCmd: "java",
    probeArgs: ["-version"],
    fix: "Install Java 17+ via `brew install openjdk@17` or `mise install java@17`.",
    parseInstalled: (out) => parseVersionTriple(out)?.join("."),
    parseDeclared: () => undefined,
  },
  {
    runtime: "java-gradle",
    manifests: ["build.gradle", "build.gradle.kts"],
    minVersion: "17.0.0",
    probeCmd: "java",
    probeArgs: ["-version"],
    fix: "Install Java 17+ via `brew install openjdk@17` or `mise install java@17`.",
    parseInstalled: (out) => parseVersionTriple(out)?.join("."),
    parseDeclared: () => undefined,
  },
];

export interface DiscoverOptions {
  /** If true, skip running the host probe commands (for unit tests). */
  skipProbes?: boolean;
  /** Injectable probe runner for tests. */
  probeRunner?: (cmd: string, args: string[]) => Promise<string>;
}

async function defaultProbeRunner(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout: 5_000 });
    // `java -version` writes to stderr.
    return `${stdout}\n${stderr}`;
  } catch {
    return "";
  }
}

export async function discoverRuntimes(
  projectDir: string,
  options: DiscoverOptions = {},
): Promise<DetectedRuntime[]> {
  const found: DetectedRuntime[] = [];
  const runner = options.probeRunner ?? defaultProbeRunner;

  for (const def of RUNTIMES) {
    for (const manifest of def.manifests) {
      const manifestPath = join(projectDir, manifest);
      if (!existsSync(manifestPath)) continue;

      let contents = "";
      try {
        contents = await readFile(manifestPath, "utf8");
      } catch {
        contents = "";
      }

      const declaredVersion = def.parseDeclared(manifestPath, contents);

      let installed = false;
      let installedVersion: string | undefined;
      if (!options.skipProbes) {
        const out = await runner(def.probeCmd, def.probeArgs);
        installedVersion = def.parseInstalled(out);
        installed = installedVersion !== undefined;
      }

      const requiredVersion = declaredVersion ?? def.minVersion;
      const satisfies =
        installed && installedVersion !== undefined
          ? compareVersions(installedVersion, requiredVersion) >= 0
          : false;

      const detected: DetectedRuntime = {
        runtime: def.runtime,
        manifestPath,
        declaredVersion,
        minVersion: def.minVersion,
        installed,
        installedVersion,
        satisfies,
        fix: satisfies ? undefined : def.fix,
      };
      found.push(detected);
      break; // one manifest per runtime
    }
  }

  return found;
}

export function runtimeLabel(r: RuntimeName): string {
  switch (r) {
    case "node":
      return "Node.js";
    case "python":
      return "Python";
    case "go":
      return "Go";
    case "rust":
      return "Rust";
    case "ruby":
      return "Ruby";
    case "java-maven":
      return "Java (Maven)";
    case "java-gradle":
      return "Java (Gradle)";
  }
}
