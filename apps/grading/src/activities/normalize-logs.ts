import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { NormalizeLogsInput, NormalizedLogs } from "./types.js";

/**
 * Parse JSONL harness logs from `.kiln/logs/` (or the workspace root),
 * classify interactions, chain tool calls, and flag gaps.
 *
 * Absence of logs is NOT an error — the grader LLM handles the "no logs
 * submitted" case as evidence for the AI Usage axis.
 */
export async function normalizeLogs(input: NormalizeLogsInput): Promise<NormalizedLogs> {
  const candidateDirs = [
    path.join(input.workspacePath, ".kiln", "logs"),
    path.join(input.workspacePath, "logs"),
  ];
  const entries: unknown[] = [];

  for (const dir of candidateDirs) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const text = await readFile(path.join(dir, f), "utf8");
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            entries.push(JSON.parse(trimmed));
          } catch {
            // Malformed line — skip; downstream can flag it.
          }
        }
      }
    } catch {
      // Directory missing — continue.
    }
  }

  const byKind: Record<string, number> = {};
  let toolUses = 0;
  const gaps: string[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const kind =
      typeof e.kind === "string" ? e.kind : typeof e.type === "string" ? e.type : "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (kind === "tool_use" || (typeof e.tool === "string" && e.tool.length > 0)) {
      toolUses += 1;
    }
  }

  if (entries.length === 0) {
    gaps.push("no_harness_logs_present");
  }

  return {
    entryCount: entries.length,
    byKind,
    toolUses,
    gaps,
  };
}
