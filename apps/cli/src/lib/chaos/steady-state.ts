/**
 * Steady-state verification for chaos experiments.
 *
 * Reads `.kiln/chaos-config.yml` (the scaffold template). The config
 * supports two shapes — both are accepted by design so the scaffold
 * template (which uses `endpoints`) and the execution-plan wording
 * (which uses `checks`) coexist without a migration:
 *
 *   steady_state:
 *     checks:
 *       - name: health
 *         url: http://localhost:8080/healthz
 *         expected_status: 200
 *         timeout_ms: 2000
 *
 * OR (template-compatible):
 *
 *   steady_state:
 *     endpoints:
 *       - name: health
 *         url: http://app:8080/health
 *         method: GET
 *         expect_status: 200
 *
 * A run probes every configured URL, then returns:
 *   PASS      — every check passed
 *   DEGRADED  — some checks passed and some failed
 *   FAIL      — every check failed
 *
 * The injected `fetchImpl` is used by tests so the verifier is hermetic.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KilnError } from "../errors.js";

export interface SteadyStateCheckConfig {
  name: string;
  url: string;
  expectedStatus: number;
  timeoutMs: number;
}

export interface SteadyStateCheckResult {
  name: string;
  status: "pass" | "fail";
  httpStatus?: number;
  latency_ms: number;
  error?: string;
}

export type SteadyStateVerdict = "PASS" | "FAIL" | "DEGRADED";

export interface SteadyStateRunResult {
  verdict: SteadyStateVerdict;
  results: SteadyStateCheckResult[];
  checkedAt: string;
}

export interface SteadyStateOptions {
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Project dir; defaults to process.cwd(). */
  projectDir?: string;
  /** Override config path (absolute). */
  configPath?: string;
}

/**
 * Minimal YAML subset parser tailored to the chaos-config shape.
 * Supports:
 *   - 2-space indentation
 *   - mappings (`key: value`)
 *   - list items (`- key: value`) with inline first key
 *   - continuation mapping entries inside a list item
 *   - integer, quoted-string, and bare-word scalars
 *   - `#` line comments
 *
 * This intentionally does not attempt to be a full YAML parser.
 * If the config uses unsupported features we throw with a fix that
 * points the user at the scaffold template.
 */
type YamlScalar = string | number | boolean | null;
type YamlValue = YamlScalar | YamlValue[] | { [k: string]: YamlValue };

function parseScalar(raw: string): YamlScalar {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

interface Line {
  indent: number;
  content: string;
  raw: string;
  lineNo: number;
}

function tokenize(source: string): Line[] {
  const out: Line[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    // Strip trailing comments — but preserve `#` inside quoted strings.
    let stripped = "";
    let inSingle = false;
    let inDouble = false;
    for (let j = 0; j < raw.length; j++) {
      const ch = raw[j];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === "#" && !inSingle && !inDouble) break;
      stripped += ch;
    }
    const trimmed = stripped.replace(/\s+$/, "");
    if (trimmed.trim() === "") continue;
    const indent = trimmed.match(/^ */)?.[0].length ?? 0;
    out.push({
      indent,
      content: trimmed.slice(indent),
      raw: trimmed,
      lineNo: i + 1,
    });
  }
  return out;
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  // Determine if we're parsing a list or map by the first qualifying line.
  if (start >= lines.length) return [null, start];
  const firstLine = lines[start];
  if (!firstLine || firstLine.indent < indent) return [null, start];

  if (firstLine.content.startsWith("- ") || firstLine.content === "-") {
    // List block.
    const items: YamlValue[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (!line) break;
      if (line.indent < indent) break;
      if (line.indent > indent) break;
      if (!(line.content.startsWith("- ") || line.content === "-")) break;

      const afterDash = line.content === "-" ? "" : line.content.slice(2);
      i += 1;

      if (afterDash === "") {
        // Nested block value below the dash.
        const [value, next] = parseBlock(lines, i, indent + 2);
        items.push(value);
        i = next;
        continue;
      }

      // Inline first entry; may be `key: value` or a scalar.
      const kvMatch = afterDash.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
      if (kvMatch) {
        const firstKey = kvMatch[1] ?? "";
        const firstRawValue = kvMatch[2] ?? "";
        const obj: { [k: string]: YamlValue } = {};
        if (firstRawValue.trim() === "") {
          const [nested, next] = parseBlock(lines, i, indent + 4);
          obj[firstKey] = nested;
          i = next;
        } else {
          obj[firstKey] = parseScalar(firstRawValue);
        }
        // Continuation lines at indent+2 are more keys for the same item.
        while (i < lines.length) {
          const cont = lines[i];
          if (!cont) break;
          if (cont.indent !== indent + 2) break;
          if (cont.content.startsWith("- ")) break;
          const contMatch = cont.content.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
          if (!contMatch) break;
          const key = contMatch[1] ?? "";
          const rest = contMatch[2] ?? "";
          i += 1;
          if (rest.trim() === "") {
            const [nested2, next2] = parseBlock(lines, i, indent + 4);
            obj[key] = nested2;
            i = next2;
          } else {
            obj[key] = parseScalar(rest);
          }
        }
        items.push(obj);
      } else {
        items.push(parseScalar(afterDash));
      }
    }
    return [items, i];
  }

  // Map block.
  const map: { [k: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    if (line.indent < indent) break;
    if (line.indent > indent) break;
    if (line.content.startsWith("- ")) break;
    const kvMatch = line.content.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!kvMatch) {
      throw new KilnError(`chaos-config.yml: malformed line ${line.lineNo}: ${line.raw}`, {
        fix: "Match the scaffold template format exactly — see `kiln scaffold --week N` output.",
        code: "CHAOS_CONFIG_PARSE",
      });
    }
    const key = kvMatch[1] ?? "";
    const rest = kvMatch[2] ?? "";
    i += 1;
    if (rest.trim() === "") {
      const [nested, next] = parseBlock(lines, i, indent + 2);
      map[key] = nested;
      i = next;
    } else if (rest.trim() === "[]") {
      map[key] = [];
    } else {
      map[key] = parseScalar(rest);
    }
  }
  return [map, i];
}

export function parseYamlSubset(source: string): YamlValue {
  const lines = tokenize(source);
  if (lines.length === 0) return {};
  const [value] = parseBlock(lines, 0, 0);
  return value;
}

function isRecord(v: unknown): v is Record<string, YamlValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Convert the parsed YAML into a normalized array of checks. */
export function extractChecks(parsed: YamlValue): SteadyStateCheckConfig[] {
  if (!isRecord(parsed)) return [];
  const steady = parsed.steady_state;
  if (!isRecord(steady)) return [];

  const rawChecks = (steady.checks ?? steady.endpoints) as YamlValue;
  if (!Array.isArray(rawChecks)) return [];

  const out: SteadyStateCheckConfig[] = [];
  for (const entry of rawChecks) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name : undefined;
    const url = typeof entry.url === "string" ? entry.url : undefined;
    if (!name || !url) continue;
    const expectedStatusRaw = entry.expected_status ?? entry.expect_status ?? 200;
    const expectedStatus = typeof expectedStatusRaw === "number" ? expectedStatusRaw : 200;
    const timeoutRaw = entry.timeout_ms ?? 3000;
    const timeoutMs = typeof timeoutRaw === "number" ? timeoutRaw : 3000;
    out.push({ name, url, expectedStatus, timeoutMs });
  }
  return out;
}

export async function loadChaosConfig(
  projectDir: string = process.cwd(),
  configPath?: string,
): Promise<SteadyStateCheckConfig[]> {
  const path = configPath ?? join(projectDir, ".kiln", "chaos-config.yml");
  if (!existsSync(path)) {
    throw new KilnError(`chaos-config.yml not found at ${path}`, {
      fix: "Run `kiln scaffold --week <N>` (or `--adopt` for brownfield) to create it.",
      code: "CHAOS_CONFIG_MISSING",
    });
  }
  const text = await readFile(path, "utf8");
  const parsed = parseYamlSubset(text);
  return extractChecks(parsed);
}

async function runOneCheck(
  check: SteadyStateCheckConfig,
  fetchImpl: typeof fetch,
): Promise<SteadyStateCheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeoutMs);
  try {
    const res = await fetchImpl(check.url, { signal: controller.signal });
    const latency = Date.now() - start;
    if (res.status === check.expectedStatus) {
      return {
        name: check.name,
        status: "pass",
        httpStatus: res.status,
        latency_ms: latency,
      };
    }
    return {
      name: check.name,
      status: "fail",
      httpStatus: res.status,
      latency_ms: latency,
      error: `expected ${check.expectedStatus}, got ${res.status}`,
    };
  } catch (err) {
    return {
      name: check.name,
      status: "fail",
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runSteadyState(
  options: SteadyStateOptions = {},
): Promise<SteadyStateRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const checks = await loadChaosConfig(options.projectDir, options.configPath);
  const results: SteadyStateCheckResult[] = [];
  for (const c of checks) {
    results.push(await runOneCheck(c, fetchImpl));
  }
  const passes = results.filter((r) => r.status === "pass").length;
  const fails = results.length - passes;
  let verdict: SteadyStateVerdict;
  if (results.length === 0) {
    // No configured checks — treat as PASS (nothing to verify).
    verdict = "PASS";
  } else if (fails === 0) {
    verdict = "PASS";
  } else if (passes === 0) {
    verdict = "FAIL";
  } else {
    verdict = "DEGRADED";
  }
  return {
    verdict,
    results,
    checkedAt: new Date().toISOString(),
  };
}
