import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock docker/git hooks out of the scaffold command.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (cmd: string, args: readonly string[], _opts: unknown, cb: unknown) => {
      // Allow real exec for readdir/etc via the promisified path that scaffold uses.
      // Scaffold wraps execFile via promisify; we short-circuit proxy build + git init.
      if (
        cmd === "docker" ||
        cmd === "git" ||
        (typeof cmd === "string" && cmd.endsWith("/docker")) ||
        (typeof cmd === "string" && cmd.endsWith("/git"))
      ) {
        const fn =
          typeof cb === "function"
            ? (cb as (e: Error | null, out: { stdout: string; stderr: string }) => void)
            : undefined;
        fn?.(null, { stdout: "", stderr: "" });
        return { on: () => {} } as unknown as ReturnType<typeof actual.execFile>;
      }
      return actual.execFile(
        cmd,
        args as string[],
        _opts as object,
        cb as (err: Error | null) => void,
      );
    },
  };
});

const scaffoldModulePath = resolve(__dirname, "..", "..", "src", "commands", "scaffold.ts");
const execFileP = promisify(execFile);

async function makeTempDest(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function runScaffold(argv: string[], cwd: string): Promise<void> {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    const { default: Scaffold } = await import(scaffoldModulePath);
    await Scaffold.run(argv);
  } finally {
    process.chdir(originalCwd);
  }
}

describe("kiln scaffold", () => {
  let dest: string;

  beforeEach(async () => {
    dest = await makeTempDest("kiln-scaffold-test");
  });
  afterEach(async () => {
    await rm(dest, { recursive: true, force: true });
  });

  it("greenfield creates week dir with proxy build context and develop.watch", async () => {
    await runScaffold(["--week", "1", "--no-docker", "--no-proxy", "--ci"], dest);
    const weekDir = join(dest, "week-01");
    expect(existsSync(weekDir)).toBe(true);
    const compose = await readFile(join(weekDir, "docker-compose.yml"), "utf8");
    expect(compose).toContain("build:");
    expect(compose).toContain("context: ./.kiln/proxy");
    expect(compose).not.toMatch(/^\s*image:\s/m);
    expect(compose).toContain("develop:");
    expect(compose).toContain("watch:");
    expect(existsSync(join(weekDir, ".kiln/rubric.yml"))).toBe(true);
    expect(existsSync(join(weekDir, ".kiln/proxy/main.go"))).toBe(true);
    expect(existsSync(join(weekDir, "spec.md"))).toBe(true);
  });

  it("brownfield adopt leaves existing user files alone and warns about missing Dockerfile", async () => {
    await writeFile(join(dest, "package.json"), JSON.stringify({ name: "mine" }));
    // Simulate "existing git repo" by making a .git dir, so mode detection fires.
    await mkdir(join(dest, ".git"), { recursive: true });
    const warnings: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await runScaffold(["--week", "1", "--adopt", "--no-docker", "--no-proxy", "--ci"], dest);
    } finally {
      console.log = origLog;
    }
    // Existing package.json is not touched.
    const pkg = JSON.parse(await readFile(join(dest, "package.json"), "utf8"));
    expect(pkg.name).toBe("mine");
    // .kiln/ is installed.
    expect(existsSync(join(dest, ".kiln/rubric.yml"))).toBe(true);
    // Warning about Dockerfile.
    const warningText = warnings.join("\n");
    expect(warningText).toMatch(/No Dockerfile or docker-compose\.yml/);
  });

  it("--force overrides skip-if-exists", async () => {
    await writeFile(join(dest, "package.json"), JSON.stringify({ name: "mine" }));
    await mkdir(join(dest, ".git"), { recursive: true });
    await writeFile(join(dest, "README.md"), "# mine");
    await runScaffold(
      ["--week", "1", "--adopt", "--force", "--no-docker", "--no-proxy", "--ci"],
      dest,
    );
    const readme = await readFile(join(dest, "README.md"), "utf8");
    // Template README mentions the project title.
    expect(readme.toLowerCase()).toMatch(/cohort/);
  });
});
