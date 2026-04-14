import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareVersions, discoverRuntimes } from "../../src/lib/runtime-discovery.js";

function mockProbe(map: Record<string, string>) {
  return async (cmd: string, _args: string[]): Promise<string> => {
    return map[cmd] ?? "";
  };
}

describe("runtime-discovery", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `kiln-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("compareVersions handles x.y and x.y.z", () => {
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("v2.40.1", "2.40.0")).toBeGreaterThan(0);
  });

  it("detects Node from package.json with engines", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ engines: { node: ">=20.5.0" } }));
    const runtimes = await discoverRuntimes(dir, {
      probeRunner: mockProbe({ node: "v20.5.0" }),
    });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.runtime).toBe("node");
    expect(runtimes[0]?.declaredVersion).toBe("20.5.0");
    expect(runtimes[0]?.satisfies).toBe(true);
  });

  it("flags unsatisfied Node version", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ engines: { node: ">=22.0.0" } }));
    const runtimes = await discoverRuntimes(dir, {
      probeRunner: mockProbe({ node: "v20.5.0" }),
    });
    expect(runtimes[0]?.satisfies).toBe(false);
    expect(runtimes[0]?.fix).toBeDefined();
  });

  it("detects Python from pyproject.toml", async () => {
    await writeFile(
      join(dir, "pyproject.toml"),
      '[project]\nname = "x"\nrequires-python = ">=3.12"\n',
    );
    const runtimes = await discoverRuntimes(dir, {
      probeRunner: mockProbe({ python3: "Python 3.12.1" }),
    });
    expect(runtimes[0]?.runtime).toBe("python");
    expect(runtimes[0]?.declaredVersion).toBe("3.12");
    expect(runtimes[0]?.satisfies).toBe(true);
  });

  it("detects Go from go.mod", async () => {
    await writeFile(join(dir, "go.mod"), "module example.com/x\n\ngo 1.22\n");
    const runtimes = await discoverRuntimes(dir, {
      probeRunner: mockProbe({ go: "go version go1.22.3 darwin/arm64" }),
    });
    expect(runtimes[0]?.runtime).toBe("go");
    expect(runtimes[0]?.declaredVersion).toBe("1.22");
    expect(runtimes[0]?.satisfies).toBe(true);
  });

  it("detects Rust from Cargo.toml", async () => {
    await writeFile(
      join(dir, "Cargo.toml"),
      '[package]\nname = "x"\nversion = "0.1.0"\nrust-version = "1.75"\n',
    );
    const runtimes = await discoverRuntimes(dir, {
      probeRunner: mockProbe({ rustc: "rustc 1.75.0 (stable)" }),
    });
    expect(runtimes[0]?.runtime).toBe("rust");
    expect(runtimes[0]?.declaredVersion).toBe("1.75");
    expect(runtimes[0]?.satisfies).toBe(true);
  });

  it("detects Ruby from Gemfile", async () => {
    await writeFile(join(dir, "Gemfile"), 'source "https://rubygems.org"\nruby "3.2.0"\n');
    const runtimes = await discoverRuntimes(dir, {
      probeRunner: mockProbe({ ruby: "ruby 3.2.0 (2023-03-30 revision 5cb2d1)" }),
    });
    expect(runtimes[0]?.runtime).toBe("ruby");
    expect(runtimes[0]?.declaredVersion).toBe("3.2.0");
    expect(runtimes[0]?.satisfies).toBe(true);
  });

  it("returns multiple runtimes for polyglot repo", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({}));
    await writeFile(join(dir, "requirements.txt"), "requests==2.31.0\n");
    const runtimes = await discoverRuntimes(dir, {
      probeRunner: mockProbe({
        node: "v20.5.0",
        python3: "Python 3.12.1",
      }),
    });
    const names = runtimes.map((r) => r.runtime).sort();
    expect(names).toContain("node");
    expect(names).toContain("python");
  });
});
