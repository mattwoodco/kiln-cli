import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as prompts from "@clack/prompts";
import { type HarnessLogEntry, HarnessLogEntrySchema } from "@kiln/shared";
import { Command, Flags } from "@oclif/core";
import { KilnError, formatKilnError, isKilnError } from "../../lib/errors.js";

/**
 * `kiln proxy status` — queries each upstream's /healthz and summarizes
 * the local `.kiln/harness.jsonl` capture. `--verbose` prints per-entry
 * details; default is a compact summary table.
 */
export default class ProxyStatus extends Command {
  static override description = "Show proxy health and capture summary";

  static override flags = {
    ci: Flags.boolean({ description: "Machine-readable JSON output" }),
    verbose: Flags.boolean({ description: "Per-entry detail" }),
    "log-file": Flags.string({
      description: "Path to the harness JSONL file",
      default: ".kiln/harness.jsonl",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ProxyStatus);
    try {
      const health = await collectHealth();
      const logPath = path.resolve(process.cwd(), flags["log-file"]);
      const stats = await summarizeLog(logPath);

      if (flags.ci) {
        this.log(
          JSON.stringify({
            ok: true,
            health,
            log: { path: logPath, ...stats },
          }),
        );
        return;
      }

      prompts.intro("kiln proxy status");
      prompts.note(
        health.map((r) => `  :${r.port} ${r.upstream} → ${r.status}`).join("\n"),
        "health",
      );
      prompts.note(
        [
          `  path: ${logPath}`,
          `  total entries: ${stats.total}`,
          stats.total > 0
            ? `  timespan: ${stats.firstTs ?? "?"} → ${stats.lastTs ?? "?"}`
            : "  (empty)",
          "  by source_tool:",
          ...Object.entries(stats.bySource).map(([k, v]) => `    ${k}: ${v}`),
        ].join("\n"),
        "capture",
      );
      if (flags.verbose && stats.samples.length > 0) {
        prompts.note(
          stats.samples
            .map(
              (s, i) =>
                `  ${i + 1}. ${s.timestamp} ${s.source_tool} ${s.model ?? "?"} ${s.upstream}`,
            )
            .join("\n"),
          "recent",
        );
      }
      prompts.outro(stats.total === 0 ? "no captures yet" : "ok");
    } catch (err) {
      if (isKilnError(err)) {
        if (flags.ci) {
          this.log(JSON.stringify({ ok: false, error: err.message, fix: err.fix, code: err.code }));
        } else {
          prompts.log.error(formatKilnError(err));
        }
        this.exit(1);
      }
      throw err;
    }
  }
}

type HealthRow = { port: number; upstream: string; status: string; interactions: number };

async function collectHealth(): Promise<HealthRow[]> {
  const ports: Array<{ port: number; upstream: string }> = [
    { port: 9100, upstream: "anthropic" },
    { port: 9101, upstream: "openai" },
    { port: 9102, upstream: "google" },
  ];
  return Promise.all(
    ports.map(async ({ port, upstream }): Promise<HealthRow> => {
      try {
        const res = await fetch(`http://localhost:${port}/healthz`);
        if (!res.ok) return { port, upstream, status: `http ${res.status}`, interactions: 0 };
        const body = (await res.json()) as { status?: string; interactions?: number };
        return {
          port,
          upstream,
          status: body.status ?? "unknown",
          interactions: body.interactions ?? 0,
        };
      } catch {
        return { port, upstream, status: "unreachable", interactions: 0 };
      }
    }),
  );
}

type LogSummary = {
  total: number;
  bySource: Record<string, number>;
  firstTs: string | null;
  lastTs: string | null;
  samples: HarnessLogEntry[];
};

async function summarizeLog(logPath: string): Promise<LogSummary> {
  if (!fs.existsSync(logPath)) {
    return { total: 0, bySource: {}, firstTs: null, lastTs: null, samples: [] };
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(logPath),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const bySource: Record<string, number> = {};
  const samples: HarnessLogEntry[] = [];
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let total = 0;
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = HarnessLogEntrySchema.safeParse(raw);
    if (!parsed.success) continue;
    const entry = parsed.data;
    total += 1;
    bySource[entry.source_tool] = (bySource[entry.source_tool] ?? 0) + 1;
    if (firstTs === null) firstTs = entry.timestamp;
    lastTs = entry.timestamp;
    if (samples.length < 5) samples.push(entry);
  }
  return { total, bySource, firstTs, lastTs, samples };
}
