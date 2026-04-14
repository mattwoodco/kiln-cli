import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KilnError } from "./errors.js";

export type ScaffoldMode = "greenfield" | "brownfield";

export type FilePolicy = "always-write" | "merge" | "skip-if-exists" | "overwrite";

export interface ScaffoldVars {
  week: number;
  cohortId: string;
  cohortName: string;
  projectKey: string;
  projectTitle: string;
  studentName?: string;
  rubricYaml?: string;
  [key: string]: string | number | undefined;
}

export interface ScaffoldResult {
  written: string[];
  skipped: { path: string; reason: string }[];
  merged: string[];
  overwritten: string[];
}

export interface ScaffolderOptions {
  templatesDir: string;
  destDir: string;
  mode: ScaffoldMode;
  week: number;
  vars: ScaffoldVars;
  force?: boolean;
}

const DEFAULT_POLICIES: { match: (rel: string) => boolean; policy: FilePolicy }[] = [
  // .kiln/** is always written — these are managed by Kiln.
  { match: (r) => r.startsWith(".kiln/") || r.startsWith(".kiln\\"), policy: "always-write" },
  // Env + Makefile are merged with existing contents when present.
  { match: (r) => r === ".env" || r.endsWith("/.env"), policy: "merge" },
  { match: (r) => r === "Makefile" || r.endsWith("/Makefile"), policy: "merge" },
  // These user-facing files are preserved when they exist.
  { match: (r) => r === "Dockerfile", policy: "skip-if-exists" },
  { match: (r) => r === "docker-compose.yml", policy: "skip-if-exists" },
  { match: (r) => r === "compose.yaml", policy: "skip-if-exists" },
  { match: (r) => r === "spec.md", policy: "skip-if-exists" },
  { match: (r) => r === "video.md", policy: "skip-if-exists" },
  { match: (r) => r === "rubric.yml", policy: "skip-if-exists" },
  { match: (r) => r === "README.md", policy: "skip-if-exists" },
];

/**
 * Resolve policy for a given repo-relative path. Anything unmatched defaults
 * to always-write in greenfield and skip-if-exists in brownfield.
 */
export function resolvePolicy(relPath: string, mode: ScaffoldMode): FilePolicy {
  const normalized = relPath.replace(/\\/g, "/");
  for (const rule of DEFAULT_POLICIES) {
    if (rule.match(normalized)) return rule.policy;
  }
  return mode === "greenfield" ? "always-write" : "skip-if-exists";
}

/**
 * Substitute {{var}} placeholders in a template string.
 * Also expands a handful of convenience values like {{week_padded}}.
 */
export function renderTemplate(source: string, vars: ScaffoldVars): string {
  const weekPadded = String(vars.week).padStart(2, "0");
  const expanded: Record<string, string> = {
    week: String(vars.week),
    week_padded: weekPadded,
    cohort_id: vars.cohortId,
    cohort_name: vars.cohortName,
    project_key: vars.projectKey,
    project_title: vars.projectTitle,
    student_name: vars.studentName ?? "",
    rubric_yaml: vars.rubricYaml ?? "",
  };
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined && !(k in expanded)) expanded[k] = String(v);
  }
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    return expanded[key] ?? `{{${key}}}`;
  });
}

/**
 * Walk a templates directory and return repo-relative template paths.
 * Uses Bun.Glob when available; falls back to a recursive fs walk for Node/test env.
 */
async function walkTemplates(root: string): Promise<string[]> {
  // Try Bun.Glob first.
  const bunGlobal = (
    globalThis as unknown as {
      Bun?: {
        Glob: new (
          p: string,
        ) => { scan(opts: { cwd: string; dot: boolean }): AsyncIterable<string> };
      };
    }
  ).Bun;
  if (bunGlobal?.Glob) {
    const glob = new bunGlobal.Glob("**/*");
    const out: string[] = [];
    for await (const p of glob.scan({ cwd: root, dot: true })) {
      out.push(p);
    }
    return out;
  }

  // Fallback: recursive fs walk.
  const { readdir, stat } = await import("node:fs/promises");
  const out: string[] = [];
  async function recurse(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const st = await stat(full);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (st.isDirectory()) {
        await recurse(full, rel);
      } else {
        out.push(rel);
      }
    }
  }
  if (existsSync(root)) {
    await recurse(root, "");
  }
  return out;
}

interface TemplateFile {
  srcAbs: string;
  /** Destination path relative to destDir after `.tmpl` stripping. */
  destRel: string;
}

async function collectTemplates(
  templatesDir: string,
  week: number,
): Promise<Map<string, TemplateFile>> {
  const map = new Map<string, TemplateFile>();
  const baseDir = join(templatesDir, "base");
  const weekDir = join(templatesDir, `week-${String(week).padStart(2, "0")}`);

  for (const layer of [baseDir, weekDir]) {
    if (!existsSync(layer)) continue;
    const files = await walkTemplates(layer);
    for (const rel of files) {
      const destRel = rel.endsWith(".tmpl") ? rel.slice(0, -5) : rel;
      map.set(destRel, {
        srcAbs: join(layer, rel),
        destRel,
      });
    }
  }
  return map;
}

function mergeEnv(existing: string, next: string): string {
  const existingKeys = new Set<string>();
  for (const line of existing.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/i);
    if (m?.[1]) existingKeys.add(m[1]);
  }
  const additions: string[] = [];
  for (const line of next.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/i);
    if (m?.[1] && !existingKeys.has(m[1])) {
      additions.push(line);
    }
  }
  if (additions.length === 0) return existing;
  const trailing = existing.endsWith("\n") ? "" : "\n";
  return `${existing}${trailing}\n# --- added by kiln scaffold ---\n${additions.join("\n")}\n`;
}

function mergeMakefile(existing: string, next: string): string {
  const existingTargets = new Set<string>();
  for (const line of existing.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:/);
    if (m?.[1]) existingTargets.add(m[1]);
  }
  const additions: string[] = [];
  let buffering = false;
  let currentTarget: string | undefined;
  const blockLines: string[] = [];
  const flush = () => {
    if (buffering && currentTarget && !existingTargets.has(currentTarget)) {
      additions.push(blockLines.join("\n"));
    }
    buffering = false;
    currentTarget = undefined;
    blockLines.length = 0;
  };
  for (const line of next.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:/);
    if (m?.[1]) {
      flush();
      currentTarget = m[1];
      buffering = true;
      blockLines.push(line);
    } else if (buffering) {
      blockLines.push(line);
    }
  }
  flush();
  if (additions.length === 0) return existing;
  const trailing = existing.endsWith("\n") ? "" : "\n";
  return `${existing}${trailing}\n# --- added by kiln scaffold ---\n${additions.join("\n\n")}\n`;
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function ensureDir(path: string): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export async function generate(options: ScaffolderOptions): Promise<ScaffoldResult> {
  const { templatesDir, destDir, mode, week, vars, force = false } = options;
  if (!existsSync(templatesDir)) {
    throw new KilnError(`Templates directory not found: ${templatesDir}`, {
      fix: "Reinstall the kiln CLI or check your --template-repo flag.",
      code: "TEMPLATE_DIR_MISSING",
    });
  }
  const files = await collectTemplates(templatesDir, week);
  if (files.size === 0) {
    throw new KilnError(`No templates found for week ${week}`, {
      fix: "Check that apps/cli/templates/base exists and is populated.",
      code: "NO_TEMPLATES",
    });
  }

  const result: ScaffoldResult = {
    written: [],
    skipped: [],
    merged: [],
    overwritten: [],
  };

  for (const [destRel, file] of files) {
    const destAbs = resolve(destDir, destRel);
    let policy = resolvePolicy(destRel, mode);
    if (force && policy === "skip-if-exists") {
      policy = "overwrite";
    }

    // Greenfield under a non-existing dir: everything is fresh.
    if (mode === "greenfield" && !existsSync(destAbs)) {
      policy = "always-write";
    }

    const srcText = await readFile(file.srcAbs, "utf8");
    const rendered = renderTemplate(srcText, vars);
    const destExists = existsSync(destAbs);

    if (!destExists) {
      await ensureDir(destAbs);
      await writeFile(destAbs, rendered);
      result.written.push(destRel);
      continue;
    }

    // File exists — apply policy.
    switch (policy) {
      case "always-write": {
        await ensureDir(destAbs);
        await writeFile(destAbs, rendered);
        result.written.push(destRel);
        break;
      }
      case "overwrite": {
        await ensureDir(destAbs);
        await writeFile(destAbs, rendered);
        result.overwritten.push(destRel);
        break;
      }
      case "merge": {
        const existing = await readFileOrEmpty(destAbs);
        let merged: string;
        if (destRel === ".env" || destRel.endsWith("/.env")) {
          merged = mergeEnv(existing, rendered);
        } else {
          merged = mergeMakefile(existing, rendered);
        }
        await writeFile(destAbs, merged);
        result.merged.push(destRel);
        break;
      }
      case "skip-if-exists": {
        result.skipped.push({ path: destRel, reason: "exists" });
        break;
      }
    }
  }

  return result;
}

/**
 * Resolve the CLI's bundled templates directory.
 * Works whether the CLI is run from source (tsx) or from dist/.
 */
export function defaultTemplatesDir(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // From apps/cli/src/lib or apps/cli/dist/lib back up to apps/cli.
  return resolve(here, "..", "..", "templates");
}

/**
 * Simple path-relative helper for result printing.
 */
export function toDisplayPath(root: string, abs: string): string {
  return relative(root, abs) || ".";
}
