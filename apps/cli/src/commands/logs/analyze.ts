import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import * as prompts from "@clack/prompts";
import { type HarnessLogEntry, HarnessLogEntrySchema } from "@kiln/shared";
import { Command, Flags } from "@oclif/core";
import { KilnError, formatKilnError, isKilnError } from "../../lib/errors.js";

/**
 * `kiln logs analyze` — parse `.kiln/harness.jsonl`, build a summary across
 * interactions, and (optionally) ask Claude Haiku 4.5 to rate the agent's
 * sophistication, context curation, tool selection, and modification rate.
 *
 * Flags:
 *   --ci         JSON output for tests/CI
 *   --no-llm     Skip the Haiku call (pure-stat output)
 *   --log-file   Override default .kiln/harness.jsonl
 */
export default class LogsAnalyze extends Command {
  static override description = "Analyze captured harness logs with an LLM rubric";

  static override flags = {
    ci: Flags.boolean({ description: "Machine-readable JSON output" }),
    verbose: Flags.boolean({ description: "Verbose logging" }),
    "no-llm": Flags.boolean({ description: "Skip Haiku call; print stats only" }),
    "log-file": Flags.string({
      description: "Path to harness JSONL file",
      default: ".kiln/harness.jsonl",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(LogsAnalyze);
    try {
      const logPath = path.resolve(process.cwd(), flags["log-file"]);
      const summary = await buildSummary(logPath);

      if (summary.total === 0) {
        throw new KilnError("no harness interactions captured", {
          code: "NO_CAPTURES",
          fix: "kiln proxy start && run your agent against localhost:9100",
        });
      }

      let analysis: Analysis;
      if (flags["no-llm"]) {
        analysis = statBasedAnalysis(summary);
      } else {
        // DEFERRED: needs ANTHROPIC_API_KEY for live validation
        analysis = await haikuAnalysis(summary, flags.verbose);
      }

      if (flags.ci) {
        this.log(JSON.stringify({ ok: true, summary, analysis }, null, 2));
        return;
      }

      prompts.intro("kiln logs analyze");
      prompts.note(
        [
          `  total interactions: ${summary.total}`,
          `  models: ${formatCounts(summary.byModel)}`,
          `  source tools: ${formatCounts(summary.bySource)}`,
          `  avg latency: ${summary.avgLatencyMs.toFixed(0)}ms`,
        ].join("\n"),
        "summary",
      );
      prompts.note(
        [
          `  sophistication:      ${analysis.sophistication}`,
          `  context curation:    ${analysis.contextCuration}`,
          `  tool selection:      ${analysis.toolSelection}`,
          `  modification rate:   ${analysis.modificationRate}`,
        ].join("\n"),
        "analysis",
      );
      prompts.outro("done");
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

type Summary = {
  total: number;
  byModel: Record<string, number>;
  bySource: Record<string, number>;
  avgLatencyMs: number;
  samples: HarnessLogEntry[];
};

type Analysis = {
  sophistication: string;
  contextCuration: string;
  toolSelection: string;
  modificationRate: string;
};

async function buildSummary(logPath: string): Promise<Summary> {
  if (!fs.existsSync(logPath)) {
    return { total: 0, byModel: {}, bySource: {}, avgLatencyMs: 0, samples: [] };
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(logPath),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const byModel: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const samples: HarnessLogEntry[] = [];
  let total = 0;
  let latencySum = 0;
  let latencyCount = 0;
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
    const model = entry.model ?? "unknown";
    byModel[model] = (byModel[model] ?? 0) + 1;
    bySource[entry.source_tool] = (bySource[entry.source_tool] ?? 0) + 1;
    if (typeof entry.latency_ms === "number") {
      latencySum += entry.latency_ms;
      latencyCount += 1;
    }
    if (samples.length < 20) samples.push(entry);
  }
  return {
    total,
    byModel,
    bySource,
    avgLatencyMs: latencyCount > 0 ? latencySum / latencyCount : 0,
    samples,
  };
}

function formatCounts(map: Record<string, number>): string {
  const entries = Object.entries(map);
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function statBasedAnalysis(s: Summary): Analysis {
  const distinctModels = Object.keys(s.byModel).length;
  const distinctTools = Object.keys(s.bySource).length;
  return {
    sophistication: `${s.total} interactions across ${distinctModels} model(s)`,
    contextCuration: `avg latency ${s.avgLatencyMs.toFixed(0)}ms (proxy observation only)`,
    toolSelection: `${distinctTools} distinct source_tool(s) detected`,
    modificationRate: "n/a (requires diff signal not captured at proxy layer)",
  };
}

// DEFERRED: needs ANTHROPIC_API_KEY for live validation
async function haikuAnalysis(s: Summary, verbose: boolean): Promise<Analysis> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (verbose) {
      prompts.log.warn("ANTHROPIC_API_KEY unset — falling back to stat-based analysis");
    }
    return statBasedAnalysis(s);
  }
  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt(s);
  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  const text = resp.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  return parseAnalysis(text) ?? statBasedAnalysis(s);
}

function buildPrompt(s: Summary): string {
  return [
    "Analyze the following proxy-captured agent interactions.",
    "Return four one-line ratings in this exact format:",
    "sophistication: <rating>",
    "context_curation: <rating>",
    "tool_selection: <rating>",
    "modification_rate: <rating>",
    "",
    `total=${s.total}`,
    `models=${JSON.stringify(s.byModel)}`,
    `source_tools=${JSON.stringify(s.bySource)}`,
    `avg_latency_ms=${s.avgLatencyMs.toFixed(0)}`,
    `sample_count=${s.samples.length}`,
  ].join("\n");
}

function parseAnalysis(text: string): Analysis | null {
  const lines = text.split("\n").map((l) => l.trim());
  const pick = (key: string): string | null => {
    const l = lines.find((x) => x.toLowerCase().startsWith(`${key}:`));
    if (!l) return null;
    return l.slice(l.indexOf(":") + 1).trim();
  };
  const sophistication = pick("sophistication");
  const contextCuration = pick("context_curation");
  const toolSelection = pick("tool_selection");
  const modificationRate = pick("modification_rate");
  if (!sophistication || !contextCuration || !toolSelection || !modificationRate) return null;
  return { sophistication, contextCuration, toolSelection, modificationRate };
}
