import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ScaffoldVars,
  defaultTemplatesDir,
  generate,
  renderTemplate,
  resolvePolicy,
} from "../../src/lib/scaffolder.js";

const makeVars = (overrides: Partial<ScaffoldVars> = {}): ScaffoldVars => ({
  week: 1,
  cohortId: "cohort-dev",
  cohortName: "dev-local",
  projectKey: "p1",
  projectTitle: "Project One",
  rubricYaml: "criteria: []",
  ...overrides,
});

async function makeTempTemplates(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = join(tmpdir(), `kiln-tmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(dir, "base", ".kiln"), { recursive: true });
  await mkdir(join(dir, "week-02"), { recursive: true });
  await writeFile(join(dir, "base", "spec.md.tmpl"), "BASE spec week {{week}}");
  await writeFile(join(dir, "base", ".env.tmpl"), "FOO=1\nBAR={{cohort_name}}\n");
  await writeFile(join(dir, "base", "Makefile.tmpl"), "build:\n\techo build\n");
  await writeFile(join(dir, "base", "README.md.tmpl"), "# Base README for {{project_title}}");
  await writeFile(
    join(dir, "base", "docker-compose.yml.tmpl"),
    "services:\n  kiln-proxy:\n    build:\n      context: ./.kiln/proxy\n    develop:\n      watch:\n        - action: rebuild\n          path: ./.kiln/proxy\n",
  );
  await writeFile(join(dir, "base", ".kiln", "rubric.yml.tmpl"), "# rubric\n{{rubric_yaml}}");
  await writeFile(join(dir, "week-02", "spec.md.tmpl"), "WEEK2 spec week {{week}}");
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("scaffolder", () => {
  describe("renderTemplate", () => {
    it("substitutes {{week}} and {{week_padded}}", () => {
      expect(renderTemplate("w={{week}} p={{week_padded}}", makeVars({ week: 3 }))).toBe(
        "w=3 p=03",
      );
    });

    it("substitutes cohort and project vars", () => {
      const out = renderTemplate(
        "c={{cohort_name}} id={{cohort_id}} title={{project_title}}",
        makeVars(),
      );
      expect(out).toBe("c=dev-local id=cohort-dev title=Project One");
    });

    it("leaves unknown vars untouched", () => {
      expect(renderTemplate("x={{unknown_var}}", makeVars())).toBe("x={{unknown_var}}");
    });
  });

  describe("resolvePolicy", () => {
    it(".kiln/** is always-write", () => {
      expect(resolvePolicy(".kiln/rubric.yml", "brownfield")).toBe("always-write");
      expect(resolvePolicy(".kiln/proxy/main.go", "brownfield")).toBe("always-write");
    });

    it("Dockerfile is skip-if-exists", () => {
      expect(resolvePolicy("Dockerfile", "brownfield")).toBe("skip-if-exists");
    });

    it(".env is merge", () => {
      expect(resolvePolicy(".env", "brownfield")).toBe("merge");
    });

    it("Makefile is merge", () => {
      expect(resolvePolicy("Makefile", "brownfield")).toBe("merge");
    });

    it("unknown files default to always-write in greenfield", () => {
      expect(resolvePolicy("src/index.ts", "greenfield")).toBe("always-write");
    });

    it("unknown files default to skip-if-exists in brownfield", () => {
      expect(resolvePolicy("src/index.ts", "brownfield")).toBe("skip-if-exists");
    });
  });

  describe("generate (greenfield)", () => {
    let templates: { dir: string; cleanup: () => Promise<void> };
    let dest: string;

    beforeEach(async () => {
      templates = await makeTempTemplates();
      dest = join(tmpdir(), `kiln-dest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(dest, { recursive: true });
    });
    afterEach(async () => {
      await templates.cleanup();
      await rm(dest, { recursive: true, force: true });
    });

    it("creates files into empty dir", async () => {
      const result = await generate({
        templatesDir: templates.dir,
        destDir: dest,
        mode: "greenfield",
        week: 1,
        vars: makeVars(),
      });
      expect(result.written.length).toBeGreaterThan(0);
      expect(existsSync(join(dest, "spec.md"))).toBe(true);
      expect(existsSync(join(dest, "docker-compose.yml"))).toBe(true);
      const compose = await readFile(join(dest, "docker-compose.yml"), "utf8");
      expect(compose).toContain("build:");
      expect(compose).toContain("context: ./.kiln/proxy");
      expect(compose).toContain("develop:");
      expect(compose).toContain("watch:");
    });

    it("week-02 overrides base spec.md", async () => {
      await generate({
        templatesDir: templates.dir,
        destDir: dest,
        mode: "greenfield",
        week: 2,
        vars: makeVars({ week: 2 }),
      });
      const spec = await readFile(join(dest, "spec.md"), "utf8");
      expect(spec).toBe("WEEK2 spec week 2");
    });

    it("applies cohort-specific rubric yaml", async () => {
      await generate({
        templatesDir: templates.dir,
        destDir: dest,
        mode: "greenfield",
        week: 1,
        vars: makeVars({ rubricYaml: "criteria:\n  - cohort-override\n" }),
      });
      const rubric = await readFile(join(dest, ".kiln/rubric.yml"), "utf8");
      expect(rubric).toContain("cohort-override");
    });
  });

  describe("generate (brownfield)", () => {
    let templates: { dir: string; cleanup: () => Promise<void> };
    let dest: string;

    beforeEach(async () => {
      templates = await makeTempTemplates();
      dest = join(tmpdir(), `kiln-bf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(dest, { recursive: true });
      // Pre-existing user files
      await writeFile(join(dest, "package.json"), JSON.stringify({ name: "existing" }));
      await writeFile(join(dest, "README.md"), "# user readme");
      await writeFile(join(dest, ".env"), "EXISTING=1\n");
    });
    afterEach(async () => {
      await templates.cleanup();
      await rm(dest, { recursive: true, force: true });
    });

    it("always writes .kiln/* and skips README.md", async () => {
      const result = await generate({
        templatesDir: templates.dir,
        destDir: dest,
        mode: "brownfield",
        week: 1,
        vars: makeVars(),
      });
      expect(existsSync(join(dest, ".kiln/rubric.yml"))).toBe(true);
      const readme = await readFile(join(dest, "README.md"), "utf8");
      expect(readme).toBe("# user readme"); // untouched
      expect(result.skipped.map((s) => s.path)).toContain("README.md");
    });

    it("merges .env without clobbering existing keys", async () => {
      const result = await generate({
        templatesDir: templates.dir,
        destDir: dest,
        mode: "brownfield",
        week: 1,
        vars: makeVars(),
      });
      const env = await readFile(join(dest, ".env"), "utf8");
      expect(env).toContain("EXISTING=1");
      expect(env).toContain("FOO=1");
      expect(env).toContain("BAR=dev-local");
      expect(result.merged).toContain(".env");
    });

    it("--force flips skip-if-exists to overwrite", async () => {
      const result = await generate({
        templatesDir: templates.dir,
        destDir: dest,
        mode: "brownfield",
        week: 1,
        vars: makeVars(),
        force: true,
      });
      const readme = await readFile(join(dest, "README.md"), "utf8");
      expect(readme).toContain("Project One"); // from template
      expect(result.overwritten).toContain("README.md");
    });
  });

  describe("defaultTemplatesDir", () => {
    it("resolves to apps/cli/templates", () => {
      const d = defaultTemplatesDir();
      expect(d).toMatch(/templates$/);
    });
  });
});
