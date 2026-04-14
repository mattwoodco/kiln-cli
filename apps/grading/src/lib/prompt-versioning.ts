import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stable prompt + rubric versioning.
 *
 * Prompt version = SHA-256 of the prompt file contents.
 * Rubric version = SHA-256 of the rubric YAML.
 *
 * Hashes are cached in memory so we only hit disk once per prompt per run.
 */

const promptCache = new Map<string, string>();

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashRubricYaml(yaml: string): string {
  return hashText(yaml);
}

export function hashPromptText(text: string): string {
  return hashText(text);
}

const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export async function loadPrompt(name: string): Promise<string> {
  const fp = path.join(PROMPTS_DIR, name);
  const cached = promptCache.get(fp);
  if (cached) return cached;
  const text = await readFile(fp, "utf8");
  promptCache.set(fp, text);
  return text;
}

export async function promptVersion(name: string): Promise<string> {
  const text = await loadPrompt(name);
  return hashText(text);
}

/**
 * Convenience: compute a composite prompt version covering multiple files.
 * Used by store-results when a pipeline uses more than one prompt template.
 */
export async function compositePromptVersion(names: string[]): Promise<string> {
  const parts: string[] = [];
  for (const n of names) {
    parts.push(`${n}:${await promptVersion(n)}`);
  }
  return hashText(parts.join("\n"));
}

export function resetPromptCache(): void {
  promptCache.clear();
}
